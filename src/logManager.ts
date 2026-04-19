import * as vscode from 'vscode';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { ChangeType } from './diffAnalyzer';
import { LogEntry } from './ollamaClient';

export interface ActivityEntry {
  id: string;
  timestamp: string;
  file: string;
  changeType: string;
  diff: string;
  question?: string;
  answer?: string;
  hasAnswer: boolean;
  /** Backup of pre-change content so questions can be generated later. */
  oldContent?: string;
  /** Backup of post-change content. */
  newContent?: string;
  /** Marks that this raw change still needs a question to be generated. */
  needsQuestion?: boolean;
}

interface DedupRecord { hash: string; ts: number; }

export class LogManager {
  private context: vscode.ExtensionContext;
  private entries: ActivityEntry[] = [];
  private dedup: DedupRecord[] = [];
  private readonly DEDUP_TTL_MS = 5 * 60 * 1000;
  private logsDir: string | undefined;
  private currentVersion: string = 'v1.0';
  private onChangeCallback?: () => void;

  /** Debounced write so we don't hammer disk on every keystroke. */
  private writeTimer: NodeJS.Timeout | undefined;
  private readonly WRITE_DEBOUNCE_MS = 300;

  setOnChange(cb: () => void) { this.onChangeCallback = cb; }

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.loadFromStorage();
  }

  setLogsDir(logsDir: string, version: string) {
    this.logsDir = logsDir;
    this.currentVersion = version;
    this.entries = [];
    this.dedup = [];
    this.context.globalState.update('archb.currentLogsDir', logsDir);
    this.context.globalState.update('archb.currentVersion', version);
    this.context.globalState.update('archb.entries', []);
    this.scheduleWrite();
  }

  private getActivityPath(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) { return undefined; }
    return path.join(folders[0].uri.fsPath, 'activity.json');
  }

  private loadFromStorage() {
    const stored = this.context.globalState.get<ActivityEntry[]>('archb.entries', []);
    this.entries = stored;
    this.logsDir = this.context.globalState.get<string>('archb.currentLogsDir');
    this.currentVersion = this.context.globalState.get<string>('archb.currentVersion', 'v1.0');
  }

  private persist() {
    if (this.onChangeCallback) { this.onChangeCallback(); }
    this.context.globalState.update('archb.entries', this.entries);
    this.scheduleWrite();
  }

  private scheduleWrite() {
    if (this.writeTimer) { clearTimeout(this.writeTimer); }
    this.writeTimer = setTimeout(() => { this.writeAll().catch(() => { /* noop */ }); }, this.WRITE_DEBOUNCE_MS);
  }

  private async writeAll(): Promise<void> {
    const actPath = this.getActivityPath();
    if (actPath) {
      try {
        await fsp.writeFile(actPath, JSON.stringify({ entries: this.entries }, null, 2), 'utf-8');
      } catch { /* noop */ }
    }
    await this.writeLiveLogs();
  }

  private async writeLiveLogs(): Promise<void> {
    if (!this.logsDir) { return; }
    try {
      await fsp.mkdir(this.logsDir, { recursive: true });

      const qnaLines = this.entries
        .filter(e => e.question)
        .map(e => {
          const file = e.file.split(/[/\\]/).pop() ?? e.file;
          const time = new Date(e.timestamp).toLocaleString('en-US');
          return `## ${file} — ${e.changeType} (${time})\n**Q:** ${e.question}\n**A:** ${e.answer ?? '(no answer)'}`;
        })
        .join('\n\n---\n\n');

      await fsp.writeFile(
        path.join(this.logsDir, `${this.currentVersion}_qna_live.md`),
        `# Q&A Log — ${this.currentVersion}\n_Saved after every answer_\n\n${qnaLines || '_No entries yet._'}`,
        'utf-8'
      );

      const rawLines = this.entries.map(e => {
        const file = e.file.split(/[/\\]/).pop() ?? e.file;
        const time = new Date(e.timestamp).toLocaleString('en-US');
        return `### [${time}] ${file} (${e.changeType})\n\`\`\`\n${e.diff || '(no diff)'}\n\`\`\``;
      }).join('\n\n');

      await fsp.writeFile(
        path.join(this.logsDir, `${this.currentVersion}_raw_live.md`),
        `# Raw Change Log — ${this.currentVersion}\n_Saved after every change_\n\n${rawLines || '_No entries yet._'}`,
        'utf-8'
      );
    } catch { /* noop */ }
  }

  /** Forces a synchronous flush; called on deactivate. */
  flushSync(): void {
    if (this.writeTimer) { clearTimeout(this.writeTimer); this.writeTimer = undefined; }
    const actPath = this.getActivityPath();
    if (actPath) {
      try { fs.writeFileSync(actPath, JSON.stringify({ entries: this.entries }, null, 2), 'utf-8'); } catch { /* noop */ }
    }
    if (this.logsDir) {
      try {
        if (!fs.existsSync(this.logsDir)) { fs.mkdirSync(this.logsDir, { recursive: true }); }
        const qnaLines = this.entries.filter(e => e.question).map(e => {
          const file = e.file.split(/[/\\]/).pop() ?? e.file;
          const time = new Date(e.timestamp).toLocaleString('en-US');
          return `## ${file} — ${e.changeType} (${time})\n**Q:** ${e.question}\n**A:** ${e.answer ?? '(no answer)'}`;
        }).join('\n\n---\n\n');
        fs.writeFileSync(path.join(this.logsDir, `${this.currentVersion}_qna_live.md`),
          `# Q&A Log — ${this.currentVersion}\n\n${qnaLines || '_No entries yet._'}`, 'utf-8');
      } catch { /* noop */ }
    }
  }

  /** Called after a Q&A session completes so new changes are tracked fresh. */
  clearDedup(): void {
    this.dedup = [];
    console.log('[Archb] Dedup cache cleared after session');
  }

  /**
   * Duplicate detection with a time-to-live: the same diff in the same file
   * is only considered a duplicate if it occurred recently.
   */
  isDuplicate(filePath: string, addedLines: string[], removedLines: string[]): boolean {
    const now = Date.now();
    // prune
    this.dedup = this.dedup.filter(r => now - r.ts < this.DEDUP_TTL_MS);
    const hash = this.hashDiff(filePath, [...addedLines, ...removedLines].join('\n'));
    if (this.dedup.some(r => r.hash === hash)) { return true; }
    this.dedup.push({ hash, ts: now });
    return false;
  }

  /** Add a raw change record (no question yet). Returns the entry id. */
  addRawChange(
    filePath: string,
    changeType: ChangeType,
    diffSummary: { addedLines: string[]; removedLines: string[] },
    oldContent: string,
    newContent: string,
    capturedAt: Date
  ): string {
    const diff = [
      ...diffSummary.addedLines.map(l => `+ ${l}`),
      ...diffSummary.removedLines.map(l => `- ${l}`)
    ].join('\n');

    const entry: ActivityEntry = {
      id: this.generateId(),
      timestamp: capturedAt.toISOString(),
      file: filePath,
      changeType,
      diff,
      hasAnswer: false,
      oldContent,
      newContent,
      needsQuestion: true
    };
    this.entries.push(entry);
    this.persist();
    return entry.id;
  }

  /** Attach the generated question to an existing raw entry (by id). */
  setQuestionForEntry(entryId: string, question: string): void {
    const entry = this.entries.find(e => e.id === entryId);
    if (!entry) { return; }
    entry.question = question;
    entry.needsQuestion = false;
    this.persist();
  }

  /** Attach the generated question to a group of entries (they share it). */
  setQuestionForCluster(entryIds: string[], question: string): void {
    for (const id of entryIds) {
      const entry = this.entries.find(e => e.id === id);
      if (!entry) { continue; }
      entry.question = question;
      entry.needsQuestion = false;
    }
    this.persist();
  }

  /** Set/overwrite answer for a specific entry (by id). */
  setAnswer(entryId: string, answer: string): void {
    const entry = this.entries.find(e => e.id === entryId);
    if (!entry) { return; }
    entry.answer = answer;
    entry.hasAnswer = answer.trim().length > 0;
    this.persist();
  }

  /** Set answer for a whole cluster (same answer applies to all entries). */
  setAnswerForCluster(entryIds: string[], answer: string): void {
    for (const id of entryIds) {
      const entry = this.entries.find(e => e.id === id);
      if (!entry) { continue; }
      entry.answer = answer;
      entry.hasAnswer = answer.trim().length > 0;
    }
    this.persist();
  }

  getEntryById(id: string): ActivityEntry | undefined {
    return this.entries.find(e => e.id === id);
  }

  getEntries(): ActivityEntry[] {
    return [...this.entries];
  }

  /** All entries that still need a question generated (no answer yet). */
  getPendingChanges(): ActivityEntry[] {
    return this.entries.filter(e => e.needsQuestion === true);
  }

  /** All entries with question but no answer. */
  getUnansweredWithQuestion(): ActivityEntry[] {
    return this.entries.filter(e => e.question && !e.hasAnswer);
  }

  getEntriesForLogbook(): LogEntry[] {
    return this.entries.map(e => ({
      timestamp: e.timestamp,
      file: e.file,
      changeType: e.changeType,
      diff: e.diff,
      question: e.question,
      answer: e.answer
    }));
  }

  async clearEntries(): Promise<void> {
    this.entries = [];
    this.dedup = [];
    this.persist();
    // Wipe live markdown files on disk too
    if (this.logsDir) {
      try {
        const qna = path.join(this.logsDir, `${this.currentVersion}_qna_live.md`);
        const raw = path.join(this.logsDir, `${this.currentVersion}_raw_live.md`);
        await fsp.writeFile(qna, `# Q&A Log — ${this.currentVersion}\n\n_No entries yet._`, 'utf-8').catch(() => { /* noop */ });
        await fsp.writeFile(raw, `# Raw Change Log — ${this.currentVersion}\n\n_No entries yet._`, 'utf-8').catch(() => { /* noop */ });
      } catch { /* noop */ }
    }
  }

  private hashDiff(filePath: string, diff: string): string {
    const normalized = diff.replace(/\s+/g, ' ').trim();
    const key = filePath + '||' + normalized;
    return crypto.createHash('sha1').update(key).digest('hex');
  }

  private generateId(): string {
    return crypto.randomUUID();
  }
}
