import * as vscode from 'vscode';
import * as path from 'path';
import { DiffAnalyzer, ChangeType } from './diffAnalyzer';
import { LogManager, ActivityEntry } from './logManager';
import { OllamaClient } from './ollamaClient';
import { Clusterer, Cluster } from './clusterer';
import { StateManager } from './stateManager';

interface SessionItem {
  cluster: Cluster;
  question: string;
  codeSnippet: string;
  fileName: string;
  prefilledAnswer: string;
}

type SessionMode = 'save' | 'push' | 'revise';

export class OverlayManager {
  private panel: vscode.WebviewPanel | undefined;
  private context: vscode.ExtensionContext;
  private log: LogManager;
  private ollama: OllamaClient;
  private clusterer: Clusterer;

  private items: SessionItem[] = [];
  private cursor: number = 0;
  private mode: SessionMode = 'save';
  private onComplete?: (completed: boolean) => void;

  constructor(context: vscode.ExtensionContext, log: LogManager, stateManager: StateManager) {
    this.context = context;
    this.log = log;
    this.ollama = new OllamaClient(stateManager);
    this.clusterer = new Clusterer(this.ollama);
  }

  async startSession(mode: SessionMode, onComplete?: (completed: boolean) => void): Promise<void> {
    this.mode = mode;
    this.onComplete = onComplete;

    const pending = this.log.getPendingChanges();
    const unanswered = this.log.getUnansweredWithQuestion();
    const toProcess: ActivityEntry[] = [...pending, ...unanswered];

    console.log(`[Archb] startSession(${mode}): ${toProcess.length} entries to process`);

    if (toProcess.length === 0) {
      vscode.window.showInformationMessage('Archb: No changes to review.');
      if (this.onComplete) { this.onComplete(true); }
      return;
    }

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Archb: preparing questions…', cancellable: false },
      async () => {
        const clusters = await this.clusterer.clusterEntries(toProcess);
        console.log(`[Archb] clustered into ${clusters.length} groups`);

        const items: SessionItem[] = [];
        for (const cluster of clusters) {
          const rep = cluster.representative;
          const summary = DiffAnalyzer.summarize(rep.oldContent ?? '', rep.newContent ?? '');
          const ctx = DiffAnalyzer.buildContext(rep.file, summary);
          console.log(`[Archb] asking Ollama for ${path.basename(rep.file)} (${rep.changeType})`);
          const question = await this.ollama.generateQuestion(ctx, rep.changeType as ChangeType);
          console.log(`[Archb] got question: "${question}"`);

          const finalQuestion = question && question.trim().length > 0
            ? question
            : this.defaultQuestion(rep.changeType, rep.file);

          this.log.setQuestionForCluster(cluster.entryIds, finalQuestion);

          const snippet = this.buildSnippet(rep.diff);
          items.push({
            cluster,
            question: finalQuestion,
            codeSnippet: snippet,
            fileName: path.basename(rep.file),
            prefilledAnswer: ''
          });
        }

        this.items = items;
        this.cursor = 0;
      }
    );

    this.showCurrent();
  }

  revisitEntry(entryId: string): void {
    const entry = this.log.getEntryById(entryId);
    if (!entry || !entry.question) {
      vscode.window.showInformationMessage('Archb: No question recorded yet for this entry.');
      return;
    }

    const snippet = entry.diff || '(no diff)';

    this.mode = 'revise';
    this.onComplete = undefined;
    this.items = [{
      cluster: {
        entryIds: [entry.id],
        representative: entry,
        changeType: entry.changeType,
        filePaths: [entry.file]
      },
      question: entry.question,
      codeSnippet: snippet,
      fileName: path.basename(entry.file),
      prefilledAnswer: entry.answer ?? ''
    }];
    this.cursor = 0;
    this.showCurrent();
  }

  private showCurrent(): void {
    if (this.cursor >= this.items.length) {
      const cb = this.onComplete;
      this.onComplete = undefined;
      this.disposePanel();
      this.items = [];
      if (cb) { cb(true); }
      return;
    }

    const item = this.items[this.cursor];
    const remaining = this.items.length - this.cursor;

    console.log(`[Archb] showCurrent: "${item.question}" for ${item.fileName}`);

    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        'archbOverlay',
        'Archb',
        { viewColumn: vscode.ViewColumn.Two, preserveFocus: false },
        { enableScripts: true, retainContextWhenHidden: false }
      );

      this.panel.onDidDispose(() => {
        const wasMidSession = this.items.length > 0 && this.cursor < this.items.length;
        this.panel = undefined;
        if (wasMidSession && this.onComplete) {
          const cb = this.onComplete;
          this.onComplete = undefined;
          cb(false);
        }
      });

      this.panel.webview.onDidReceiveMessage(msg => this.handleMessage(msg));
    }

    this.panel.webview.html = this.buildHtml(
      item.question,
      item.codeSnippet,
      item.fileName,
      this.changeTypeLabel(item.cluster.changeType as ChangeType),
      remaining,
      item.prefilledAnswer,
      this.cursor > 0,
      item.cluster.filePaths.length
    );
    this.panel.reveal(vscode.ViewColumn.Two, false);
  }

  private async handleMessage(msg: { type: string; answer?: string }) {
    if (this.cursor >= this.items.length) { return; }
    const item = this.items[this.cursor];

    if (msg.type === 'submit' || msg.type === 'skip') {
      const answer = msg.type === 'skip' ? '' : (msg.answer ?? '');
      this.log.setAnswerForCluster(item.cluster.entryIds, answer);
      this.cursor++;
      this.showCurrent();
      return;
    }

    if (msg.type === 'back') {
      if (this.cursor > 0) {
        this.cursor--;
        const prev = this.items[this.cursor];
        const prevEntry = this.log.getEntryById(prev.cluster.entryIds[0]);
        prev.prefilledAnswer = prevEntry?.answer ?? '';
        this.showCurrent();
      }
      return;
    }

    if (msg.type === 'cancel') {
      const cb = this.onComplete;
      this.onComplete = undefined;
      this.disposePanel();
      this.items = [];
      if (cb) { cb(false); }
      return;
    }
  }

  private buildSnippet(diff: string): string {
    if (!diff) { return '(no diff)'; }
    const lines = diff.split('\n').slice(0, 10);
    return lines.join('\n') || '(no diff)';
  }

  private defaultQuestion(changeType: string, file: string): string {
    const fileName = path.basename(file);
    switch (changeType) {
      case ChangeType.NewFunction: return `Why did you add this new function in ${fileName}?`;
      case ChangeType.ValueChange: return `Why did you change this value in ${fileName}?`;
      case ChangeType.Logic:       return `Why did you modify this logic in ${fileName}?`;
      case ChangeType.Layout:      return `Why did you make these structural changes in ${fileName}?`;
      case ChangeType.Comment:     return `What does this new comment in ${fileName} document?`;
      default:                     return `Why did you make this change in ${fileName}?`;
    }
  }

  private buildHtml(
    question: string,
    codeSnippet: string,
    fileName: string,
    changeType: string,
    remaining: number,
    prefilledAnswer: string,
    canGoBack: boolean,
    fileCount: number
  ): string {
    const safeQuestion = question && question.trim().length > 0
      ? question
      : 'Why did you make this change?';
    const escapedSnippet = this.colorizeSnippet(codeSnippet);
    const escapedQuestion = this.escapeHtml(safeQuestion);
    const escapedFile = this.escapeHtml(fileName);
    const escapedType = this.escapeHtml(changeType);
    const escapedAnswer = this.escapeHtml(prefilledAnswer);
    const fileSuffix = fileCount > 1 ? ` (+${fileCount - 1} more)` : '';

    const nonce = this.makeNonce();

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Segoe UI', Arial, sans-serif; }
  html, body { width: 100%; min-width: 320px; }
  body {
    background: #fff;
    color: #000;
    padding: 16px;
    border: 2px solid #000;
    min-height: 100vh;
    word-wrap: break-word;
    overflow-wrap: break-word;
  }
  .header {
    font-size: 11px;
    color: #555;
    margin-bottom: 12px;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .tag {
    background: #e0e0e0;
    padding: 2px 8px;
    border-radius: 2px;
    font-size: 10px;
    font-weight: bold;
  }
  .question {
    font-size: 14px;
    font-weight: 600;
    line-height: 1.5;
    margin-bottom: 12px;
    border-left: 3px solid #000;
    padding-left: 10px;
    color: #000;
    word-break: break-word;
    min-height: 22px;
  }
  .code-box {
    border: 1px solid #000;
    background: #fff;
    padding: 8px 10px;
    margin-bottom: 12px;
    font-family: 'Consolas', 'Courier New', monospace;
    font-size: 12px;
    white-space: pre;
    overflow-x: auto;
    line-height: 1.5;
    color: #000;
  }
  .code-box .added   { color: #006600; }
  .code-box .removed { color: #990000; }
  textarea {
    width: 100%;
    height: 80px;
    border: 1px solid #000;
    padding: 8px;
    font-size: 13px;
    resize: vertical;
    outline: none;
    background: #fff;
    color: #000;
  }
  textarea:focus { border-color: #333; }
  .buttons { display: flex; gap: 8px; margin-top: 10px; }
  button {
    padding: 6px 16px;
    border: 1px solid #000;
    cursor: pointer;
    font-size: 12px;
    font-weight: 500;
  }
  .btn-primary { background: #444; color: #fff; }
  .btn-primary:hover { background: #222; }
  .btn-secondary { background: #fff; color: #000; }
  .btn-secondary:hover { background: #f0f0f0; }
  .remaining { font-size: 10px; color: #888; margin-top: 8px; }
  .hint { font-size: 10px; color: #888; margin-top: 6px; }
</style>
</head>
<body>
<div class="header">
  <span><strong>Archb</strong> — ${escapedFile}${fileSuffix}</span>
  <span class="tag">${escapedType}</span>
</div>

<div class="question">${escapedQuestion}</div>

<div class="code-box">${escapedSnippet}</div>

<textarea id="ans" placeholder="Type your answer… (Enter to submit, Shift+Enter for newline)">${escapedAnswer}</textarea>
<div class="buttons">
  <button class="btn-primary" id="btnSubmit">Submit →</button>
  <button class="btn-secondary" id="btnSkip">Skip</button>
  ${canGoBack ? '<button class="btn-secondary" id="btnBack">← Back</button>' : ''}
</div>
<div class="hint">Enter = submit &amp; next · Shift+Enter = newline${canGoBack ? ' · Shift+Tab = back' : ''}</div>
${remaining > 1 ? `<div class="remaining">${remaining - 1} more question(s) pending</div>` : ''}

<script nonce="${nonce}">
  (function() {
    const vscode = acquireVsCodeApi();
    const ta = document.getElementById('ans');

    function submit() { vscode.postMessage({ type: 'submit', answer: ta.value }); }
    function skip()   { vscode.postMessage({ type: 'skip' }); }
    function back()   { vscode.postMessage({ type: 'back' }); }

    ta.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submit();
      } else if (e.key === 'Tab' && e.shiftKey) {
        e.preventDefault();
        back();
      }
    });

    document.getElementById('btnSubmit').addEventListener('click', submit);
    document.getElementById('btnSkip').addEventListener('click', skip);
    var backBtn = document.getElementById('btnBack');
    if (backBtn) { backBtn.addEventListener('click', back); }

    setTimeout(function() {
      ta.focus();
      var len = ta.value.length;
      ta.setSelectionRange(len, len);
    }, 50);
  })();
</script>
</body>
</html>`;
  }

  private colorizeSnippet(snippet: string): string {
    return snippet
      .split('\n')
      .map(line => {
        const escaped = this.escapeHtml(line);
        if (line.startsWith('+')) { return `<span class="added">${escaped}</span>`; }
        if (line.startsWith('-')) { return `<span class="removed">${escaped}</span>`; }
        return escaped;
      })
      .join('\n');
  }

  private escapeHtml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  private changeTypeLabel(t: ChangeType): string {
    switch (t) {
      case ChangeType.NewFunction: return 'New Function';
      case ChangeType.ValueChange: return 'Value Change';
      case ChangeType.Layout:      return 'Layout';
      case ChangeType.Logic:       return 'Logic';
      case ChangeType.Comment:     return 'Comment';
      default:                     return 'Change';
    }
  }

  private disposePanel() {
    if (this.panel) {
      this.panel.dispose();
      this.panel = undefined;
    }
  }

  private makeNonce(): string {
    let txt = '';
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
      txt += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return txt;
  }
}
