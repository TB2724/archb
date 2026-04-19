import { ChangeType } from './diffAnalyzer';
import { StateManager } from './stateManager';

export interface LogEntry {
  timestamp: string;
  file: string;
  changeType: string;
  diff: string;
  answer?: string;
  question?: string;
}

interface ChatMessage { role: string; content: string; }

type ApiMode = 'chatgpt' | 'claude' | 'ollama';

export class OllamaClient {
  private readonly baseUrl = 'http://localhost:11434';
  private readonly ollamaModel = 'qwen2.5-coder:7b';
  private readonly QUESTION_TIMEOUT = 30000;
  private readonly LOGBOOK_TIMEOUT = 60000;
  private readonly CLUSTER_TIMEOUT = 20000;
  private readonly COMMIT_MSG_TIMEOUT = 20000;
  private stateManager: StateManager;

  constructor(stateManager: StateManager) {
    this.stateManager = stateManager;
  }

  /** Determine which API to use based on configured tokens */
  private getMode(): ApiMode {
    const settings = this.stateManager.getGitSettings();
    if (settings.claudeToken && settings.claudeToken.trim().startsWith('sk-ant-')) {
      return 'claude';
    }
    if (settings.chatgptToken && settings.chatgptToken.trim().startsWith('sk-')) {
      return 'chatgpt';
    }
    return 'ollama';
  }

  private getActiveModel(): string {
    const mode = this.getMode();
    if (mode === 'chatgpt') { return 'gpt-4o-mini'; }
    if (mode === 'claude') { return 'claude-haiku-4-5-20251001'; }
    return this.ollamaModel;
  }

  /** Generate a single question about one change (or cluster of changes). */
  async generateQuestion(codeContext: string, changeType: ChangeType): Promise<string> {
    const userPrompt = this.buildUserPrompt(codeContext, changeType);
    try {
      const raw = await this.chat(
        [
          {
            role: 'system',
            content: 'You are a code documentation assistant. Your only job is to ask the developer ONE short question about why they made a code change. Output only the question, nothing else. No preamble, no explanation, no numbering.'
          },
          { role: 'user', content: userPrompt }
        ],
        { temperature: 0.3, num_predict: 120, stop: ['\n\n', 'Answer:', 'A:'] },
        this.QUESTION_TIMEOUT
      );
      const question = this.extractQuestion(raw);
      return question || this.fallbackQuestion(changeType, codeContext);
    } catch {
      return this.fallbackQuestion(changeType, codeContext);
    }
  }

  /**
   * Given a list of change descriptions, ask Ollama to group semantically
   * related ones. Returns an array of groups (each group = indices into input).
   * On failure returns null (caller falls back to deterministic clustering).
   */
  async clusterChanges(descriptions: string[]): Promise<number[][] | null> {
    if (descriptions.length <= 1) {
      return descriptions.map((_, i) => [i]);
    }

    const numbered = descriptions.map((d, i) => `[${i}] ${d}`).join('\n---\n');
    const prompt =
      `Given these code changes, group them by whether they belong to the same logical modification ` +
      `(same feature, same refactor, same bugfix). Output ONLY a JSON array of arrays of indices, ` +
      `nothing else. Example: [[0,2],[1],[3,4]]\n\nChanges:\n${numbered}`;

    try {
      const raw = await this.chat(
        [
          { role: 'system', content: 'You group related code changes. Output only JSON.' },
          { role: 'user', content: prompt }
        ],
        { temperature: 0.1, num_predict: 200 },
        this.CLUSTER_TIMEOUT
      );
      return this.parseClusterJson(raw, descriptions.length);
    } catch {
      return null;
    }
  }

  /** Generate a commit message from the Q&A entries. */
  async generateCommitMessage(entries: LogEntry[]): Promise<string> {
    const answered = entries.filter(e => e.question && e.answer);
    if (answered.length === 0) {
      return 'Archb: auto-commit';
    }
    const summary = answered
      .map(e => `${e.file.split(/[/\\]/).pop()}: ${e.answer}`)
      .join('\n');

    try {
      const raw = await this.chat(
        [
          {
            role: 'system',
            content: 'You write concise git commit messages. Output a single line under 72 characters, imperative mood, no quotes, no prefixes. Only the message.'
          },
          {
            role: 'user',
            content: `Developer notes for this commit:\n${summary}\n\nWrite the commit message.`
          }
        ],
        { temperature: 0.2, num_predict: 60 },
        this.COMMIT_MSG_TIMEOUT
      );
      const line = raw.split('\n').map(l => l.trim()).find(l => l.length > 0) ?? '';
      const cleaned = line.replace(/^["']|["']$/g, '').trim();
      if (cleaned.length === 0 || cleaned.length > 120) {
        return 'Archb: ' + answered.map(e => e.file.split(/[/\\]/).pop()).join(', ').slice(0, 80);
      }
      return cleaned;
    } catch {
      return 'Archb: ' + answered.map(e => e.file.split(/[/\\]/).pop()).join(', ').slice(0, 80);
    }
  }

  async generateLogbook(entries: LogEntry[], type: 'technical' | 'customer' | 'qna', version?: string): Promise<string> {
    const headerLine = version
      ? `# ${this.headerFor(type)} — ${version}`
      : `# ${this.headerFor(type)}`;

    if (entries.length === 0) {
      return `${headerLine}\n\n_No entries yet._\n`;
    }

    // For Q&A logs: simple deterministic formatting, no Ollama needed
    if (type === 'qna') {
      const sections = entries
        .filter(e => e.question)
        .map(e => {
          const file = e.file.split(/[/\\]/).pop() ?? e.file;
          const time = new Date(e.timestamp).toLocaleString('en-US');
          return `## ${file} — ${e.changeType} (${time})\n**Q:** ${e.question}\n**A:** ${e.answer ?? '(no answer)'}`;
        });
      return `${headerLine}\n\n${sections.join('\n\n---\n\n') || '_No questions answered yet._'}\n`;
    }

    // For technical and customer logs: ask Ollama PER ENTRY (matches the
    // changelog-assistant fine-tune pattern: diff + note → one changelog line).
    type FileSection = { changeType: string; line: string; time: string };
    const sectionsByFile = new Map<string, FileSection[]>();

    for (const e of entries) {
      if (!e.answer || e.answer.trim().length === 0) { continue; }

      const fileName = e.file.split(/[/\\]/).pop() ?? e.file;
      const userMsg = (
        `File: ${fileName}\n` +
        `Diff:\n${e.diff || '(no diff)'}\n\n` +
        `Developer note: ${e.answer}`
      );

      const systemMsg = type === 'technical'
        ? 'You are a changelog assistant. Given a code diff and a developer comment, generate a clear professional changelog entry in 1-2 sentences in past tense. Explain WHAT changed and WHY.'
        : 'You are a release-notes writer. Given a code diff and a developer comment, write ONE customer-friendly sentence in past tense describing what changed from the user perspective. Avoid technical jargon, file names, or function names. Output only the sentence.';

      let line: string;
      try {
        const raw = await this.chat(
          [
            { role: 'system', content: systemMsg },
            { role: 'user',   content: userMsg }
          ],
          { temperature: 0.3, num_predict: 200 },
          this.LOGBOOK_TIMEOUT
        );
        line = (raw || '').replace(/^[\s\-*•]+/, '').trim();
        if (!line) {
          line = type === 'technical'
            ? `Updated \`${fileName}\` (${e.changeType}). ${e.answer}`
            : `${e.answer}`;
        }
      } catch {
        line = type === 'technical'
          ? `Updated \`${fileName}\` (${e.changeType}). ${e.answer}`
          : `${e.answer}`;
      }

      const arr = sectionsByFile.get(fileName) ?? [];
      arr.push({
        changeType: e.changeType,
        line,
        time: new Date(e.timestamp).toLocaleString('en-US')
      });
      sectionsByFile.set(fileName, arr);
    }

    if (sectionsByFile.size === 0) {
      return `${headerLine}\n\n_No answered changes to summarize._\n`;
    }

    // Count entries for header
    let totalEntries = 0;
    for (const arr of sectionsByFile.values()) { totalEntries += arr.length; }

    const dateStr = new Date().toLocaleString('en-US');
    const parts: string[] = [
      headerLine,
      ``,
      `_Generated ${dateStr} — ${totalEntries} change${totalEntries === 1 ? '' : 's'} across ${sectionsByFile.size} file${sectionsByFile.size === 1 ? '' : 's'}_`,
      ''
    ];

    if (type === 'technical') {
      // Group by file, show changeType + time per entry
      for (const [file, items] of sectionsByFile.entries()) {
        parts.push(`## ${file}`);
        for (const item of items) {
          parts.push(`- **[${item.changeType}]** ${item.line}  _(${item.time})_`);
        }
        parts.push('');
      }
    } else {
      // Customer notes: flat list, no file names, no timestamps, no change types
      parts.push('## What changed in this release');
      parts.push('');
      for (const items of sectionsByFile.values()) {
        for (const item of items) {
          parts.push(`- ${item.line}`);
        }
      }
    }

    return parts.join('\n').trim() + '\n';
  }

  private headerFor(type: 'technical' | 'customer' | 'qna'): string {
    switch (type) {
      case 'technical': return 'Technical Changelog';
      case 'customer':  return 'Release Notes';
      case 'qna':       return 'Q&A Log';
    }
  }

  // ---------------- internal helpers ----------------

  private connectivityChecked = false;

  private async ensureReady(): Promise<void> {
    if (this.connectivityChecked) { return; }
    this.connectivityChecked = true;

    console.log(`[Archb/Ollama] probing ${this.baseUrl}/api/tags ...`);
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3000);
      const res = await fetch(`${this.baseUrl}/api/tags`, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) {
        console.error(`[Archb/Ollama] tags endpoint returned ${res.status}`);
        return;
      }
      const data = await res.json() as { models?: Array<{ name: string }> };
      const names = (data.models ?? []).map(m => m.name);
      console.log(`[Archb/Ollama] server reachable. installed models: ${names.join(', ') || '(none)'}`);
      const hit = names.find(n => n === this.ollamaModel || n.startsWith(this.ollamaModel + ':'));
      if (!hit) {
        console.error(`[Archb/Ollama] WARNING: model "${this.ollamaModel}" NOT found. Fallback questions will be used.`);
      } else {
        console.log(`[Archb/Ollama] model "${this.ollamaModel}" found as "${hit}"`);
      }
    } catch (err) {
      console.error(`[Archb/Ollama] cannot reach ${this.baseUrl} — is "ollama serve" running?`, err);
    }
  }

  private async chat(
    messages: ChatMessage[],
    options: { temperature: number; num_predict: number; stop?: string[] },
    timeoutMs: number
  ): Promise<string> {
    const mode = this.getMode();
    const model = this.getActiveModel();
    console.log(`[Archb/AI] mode=${mode}, model=${model}`);

    if (mode === 'chatgpt') {
      return this.chatOpenAI(messages, options, timeoutMs, model);
    } else if (mode === 'claude') {
      return this.chatClaude(messages, options, timeoutMs, model);
    } else {
      return this.chatOllama(messages, options, timeoutMs);
    }
  }

  private async chatOpenAI(
    messages: ChatMessage[],
    options: { temperature: number; num_predict: number },
    timeoutMs: number,
    model: string
  ): Promise<string> {
    const settings = this.stateManager.getGitSettings();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const started = Date.now();
    console.log(`[Archb/ChatGPT] POST /v1/chat/completions (model=${model})`);
    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${settings.chatgptToken.trim()}`
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: options.temperature,
          max_tokens: options.num_predict
        }),
        signal: ctrl.signal
      });
      const elapsed = Date.now() - started;
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        console.error(`[Archb/ChatGPT] error ${response.status} after ${elapsed}ms: ${text.slice(0, 200)}`);
        throw new Error('chatgpt-error');
      }
      const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      const content = (data.choices?.[0]?.message?.content ?? '').trim();
      console.log(`[Archb/ChatGPT] got response in ${Date.now() - started}ms, length=${content.length}`);
      return content;
    } finally {
      clearTimeout(timer);
    }
  }

  private async chatClaude(
    messages: ChatMessage[],
    options: { temperature: number; num_predict: number },
    timeoutMs: number,
    model: string
  ): Promise<string> {
    const settings = this.stateManager.getGitSettings();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const started = Date.now();
    console.log(`[Archb/Claude] POST /v1/messages (model=${model})`);

    // Claude separates system messages from user/assistant messages
    const systemMsg = messages.find(m => m.role === 'system');
    const otherMessages = messages.filter(m => m.role !== 'system');

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': settings.claudeToken.trim(),
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model,
          max_tokens: options.num_predict,
          system: systemMsg?.content ?? '',
          messages: otherMessages.map(m => ({ role: m.role, content: m.content })),
          temperature: options.temperature
        }),
        signal: ctrl.signal
      });
      const elapsed = Date.now() - started;
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        console.error(`[Archb/Claude] error ${response.status} after ${elapsed}ms: ${text.slice(0, 200)}`);
        throw new Error('claude-error');
      }
      const data = await response.json() as { content?: Array<{ text?: string }> };
      const content = (data.content?.[0]?.text ?? '').trim();
      console.log(`[Archb/Claude] got response in ${Date.now() - started}ms, length=${content.length}`);
      return content;
    } finally {
      clearTimeout(timer);
    }
  }

  private async chatOllama(
    messages: ChatMessage[],
    options: { temperature: number; num_predict: number; stop?: string[] },
    timeoutMs: number
  ): Promise<string> {
    await this.ensureReady();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const started = Date.now();
    console.log(`[Archb/Ollama] POST /api/chat (model=${this.ollamaModel}, timeout=${timeoutMs}ms)`);
    try {
      const response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.ollamaModel, stream: false, options, messages }),
        signal: ctrl.signal
      });
      const elapsed = Date.now() - started;
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        console.error(`[Archb/Ollama] non-ok response ${response.status} after ${elapsed}ms — body: ${text.slice(0, 300)}`);
        throw new Error('non-ok');
      }
      const data = await response.json() as { message?: { content?: string }; response?: string };
      const content = (data.message?.content ?? data.response ?? '').trim();
      console.log(`[Archb/Ollama] got response in ${Date.now() - started}ms, length=${content.length}: "${content.slice(0, 150)}${content.length > 150 ? '...' : ''}"`);
      return content;
    } catch (err) {
      const elapsedMs = Date.now() - started;
      const isAbort = (err as Error).name === 'AbortError';
      if (isAbort) {
        console.error(`[Archb/Ollama] request aborted after ${elapsedMs}ms (timeout ${timeoutMs}ms).`);
      } else {
        console.error(`[Archb/Ollama] request failed after ${elapsedMs}ms:`, err);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private buildUserPrompt(codeContext: string, changeType: ChangeType): string {
    const typeHint = this.changeTypeHint(changeType);
    return `${typeHint}\n\nChanged code:\n${codeContext}\n\nAsk one short question about why this change was made.`;
  }

  private changeTypeHint(changeType: ChangeType): string {
    switch (changeType) {
      case ChangeType.NewFunction: return 'The developer added a new function or method.';
      case ChangeType.ValueChange: return 'The developer changed a value, variable, or parameter.';
      case ChangeType.Logic:       return 'The developer changed program logic (if/else/loop/condition).';
      case ChangeType.Layout:      return 'The developer made formatting or structural changes.';
      case ChangeType.Comment:     return 'The developer added or modified a code comment.';
      default:                     return 'The developer made a code change.';
    }
  }

  private extractQuestion(raw: string): string {
    if (!raw || raw.length < 6) { return ''; }
    // Take the first non-empty line only, collapse inner whitespace
    const firstLine = raw.split('\n').map(l => l.trim()).find(l => l.length > 0) ?? '';
    const cleaned = firstLine.replace(/\s+/g, ' ').trim();
    const wordCount = cleaned.match(/\b[a-zA-Z]{2,}\b/g)?.length ?? 0;
    if (wordCount < 3) { return ''; }
    // Ensure single trailing question mark
    return cleaned.replace(/[?!.]+$/, '') + '?';
  }

  private parseClusterJson(raw: string, n: number): number[][] | null {
    // Try to locate the first [...] in the raw output
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) { return null; }
    try {
      const parsed = JSON.parse(match[0]);
      if (!Array.isArray(parsed)) { return null; }
      const groups: number[][] = [];
      const seen = new Set<number>();
      for (const g of parsed) {
        if (!Array.isArray(g)) { return null; }
        const group: number[] = [];
        for (const idx of g) {
          if (typeof idx !== 'number' || idx < 0 || idx >= n || seen.has(idx)) { continue; }
          seen.add(idx);
          group.push(idx);
        }
        if (group.length > 0) { groups.push(group); }
      }
      // Include any indices the model missed as singletons
      for (let i = 0; i < n; i++) {
        if (!seen.has(i)) { groups.push([i]); }
      }
      return groups.length > 0 ? groups : null;
    } catch {
      return null;
    }
  }

  private fallbackQuestion(changeType: ChangeType, context: string): string {
    const file = context.split('\n')[0]?.replace('File: ', '') ?? 'this file';
    switch (changeType) {
      case ChangeType.NewFunction:
        return `Why did you add this new function in ${file} and what problem does it solve?`;
      case ChangeType.ValueChange:
        return `Why did you change this value in ${file} and what is the effect of the new value?`;
      case ChangeType.Logic:
        return `Why did you modify this logic in ${file} and what behavior changed?`;
      case ChangeType.Layout:
        return `Why did you make these structural changes in ${file}?`;
      case ChangeType.Comment:
        return `What does this new comment in ${file} document or clarify?`;
      default:
        return `Why did you make this change in ${file} and what does it achieve?`;
    }
  }
}
