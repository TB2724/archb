import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { LogManager } from './logManager';
import { DiffAnalyzer, ChangeType } from './diffAnalyzer';

interface PendingChange {
  filePath: string;
  oldContent: string;
  newContent: string;
  changeType: ChangeType;
  capturedAt: Date;
  timer?: NodeJS.Timeout;
}

export class FileWatcher {
  private watcher: vscode.FileSystemWatcher | undefined;
  private fileContents: Map<string, string> = new Map();
  private pendingChanges: Map<string, PendingChange> = new Map();
  private disposables: vscode.Disposable[] = [];
  private readonly rootPath: string;
  private readonly log: LogManager;

  /**
   * Exact directory/file names to ignore. Uses path-segment matching,
   * not substring matching, so files named e.g. "outline.ts" are NOT ignored
   * just because "out" is in IGNORED.
   */
  private readonly IGNORED_DIRS = new Set([
    'node_modules', '.git', 'dist', 'out', 'build', '.vscode', 'versions'
  ]);
  private readonly IGNORED_FILES = new Set([
    'activity.json', 'archb.db'
  ]);

  /** Delay between last edit and collection (short — user probably stopped typing). */
  private readonly DEBOUNCE_MS = 1500;

  constructor(rootPath: string, log: LogManager) {
    this.rootPath = rootPath;
    this.log = log;
  }

  start() {
    this.preloadFiles(this.rootPath);

    // Pattern excludes node_modules etc. from the watcher itself
    this.watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.rootPath, '**/*'),
      false, false, false
    );
    this.disposables.push(this.watcher);
    this.disposables.push(this.watcher.onDidChange(uri => this.onFileChanged(uri)));
    this.disposables.push(this.watcher.onDidCreate(uri => this.onFileChanged(uri)));

    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument(e => {
        if (e.document.uri.scheme === 'file') {
          this.onDocumentChanged(e.document);
        }
      })
    );

    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument(doc => {
        this.onFileSaved(doc.uri);
      })
    );

    console.log('Archb FileWatcher started on:', this.rootPath);
  }

  stop() {
    this.disposables.forEach(d => d.dispose());
    this.disposables = [];
    this.watcher = undefined;

    this.pendingChanges.forEach(pc => { if (pc.timer) { clearTimeout(pc.timer); } });
    this.pendingChanges.clear();
  }

  private preloadFiles(dir: string) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && this.IGNORED_DIRS.has(entry.name)) { continue; }
        if (!entry.isDirectory() && this.IGNORED_FILES.has(entry.name)) { continue; }
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          this.preloadFiles(fullPath);
        } else if (this.isCodeFile(entry.name)) {
          try {
            const content = fs.readFileSync(fullPath, 'utf-8');
            this.fileContents.set(fullPath, content);
          } catch { /* noop */ }
        }
      }
    } catch { /* noop */ }
  }

  private onDocumentChanged(doc: vscode.TextDocument) {
    const filePath = doc.uri.fsPath;
    if (!this.isTracked(filePath)) { return; }

    const newContent = doc.getText();
    const existing = this.pendingChanges.get(filePath);

    if (existing) {
      // If user reverted to old content, drop the pending change
      if (existing.oldContent === newContent) {
        clearTimeout(existing.timer);
        this.pendingChanges.delete(filePath);
        return;
      }
      // Whitespace-only noise: ignore
      if (existing.oldContent.replace(/\s/g, '') === newContent.replace(/\s/g, '')) { return; }

      clearTimeout(existing.timer);
      const changeType = DiffAnalyzer.classify(existing.oldContent, newContent);
      existing.newContent = newContent;
      existing.changeType = changeType;
      existing.timer = setTimeout(() => this.collectPending(filePath), this.DEBOUNCE_MS);
    } else {
      const oldContent = this.fileContents.get(filePath) ?? '';
      if (oldContent === newContent) { return; }
      if (oldContent.replace(/\s/g, '') === newContent.replace(/\s/g, '')) { return; }

      const changeType = DiffAnalyzer.classify(oldContent, newContent);
      const timer = setTimeout(() => this.collectPending(filePath), this.DEBOUNCE_MS);

      this.pendingChanges.set(filePath, {
        filePath, oldContent, newContent, changeType, capturedAt: new Date(), timer
      });
    }
  }

  private onFileChanged(uri: vscode.Uri) {
    const filePath = uri.fsPath;
    if (!this.isTracked(filePath)) { return; }
    if (!this.fileContents.has(filePath)) {
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        this.fileContents.set(filePath, content);
      } catch { /* noop */ }
    }
  }

  private onFileSaved(uri: vscode.Uri) {
    const filePath = uri.fsPath;
    if (!this.isTracked(filePath)) { return; }
    const pending = this.pendingChanges.get(filePath);
    if (pending) {
      if (pending.timer) { clearTimeout(pending.timer); }
      this.collectPending(filePath);
    }
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      this.fileContents.set(filePath, content);
    } catch { /* noop */ }
  }

  /**
   * Collect the pending change into the log. No popup is shown here anymore —
   * questions are asked at the end of the session (Save / Push buttons).
   */
  private collectPending(filePath: string) {
    const pending = this.pendingChanges.get(filePath);
    if (!pending) { return; }
    this.pendingChanges.delete(filePath);

    const diffSummary = DiffAnalyzer.summarize(pending.oldContent, pending.newContent);

    if (this.log.isDuplicate(filePath, diffSummary.addedLines, diffSummary.removedLines)) {
      this.fileContents.set(filePath, pending.newContent);
      return;
    }

    this.log.addRawChange(
      pending.filePath,
      pending.changeType,
      diffSummary,
      pending.oldContent,
      pending.newContent,
      pending.capturedAt
    );

    this.fileContents.set(filePath, pending.newContent);
  }

  private isTracked(filePath: string): boolean {
    if (!filePath.startsWith(this.rootPath)) { return false; }
    if (!this.isCodeFile(filePath)) { return false; }
    // Check each path segment against ignore set
    const rel = path.relative(this.rootPath, filePath);
    const segments = rel.split(/[\\/]/);
    for (const seg of segments) {
      if (this.IGNORED_DIRS.has(seg)) { return false; }
    }
    const fileName = segments[segments.length - 1];
    if (this.IGNORED_FILES.has(fileName)) { return false; }
    return true;
  }

  private isCodeFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return ['.ts', '.js', '.tsx', '.jsx', '.py', '.java', '.cs', '.cpp',
            '.c', '.h', '.go', '.rs', '.php', '.rb', '.swift', '.kt',
            '.vue', '.html', '.css', '.scss', '.json', '.yaml', '.yml',
            '.xml', '.md', '.sql'].includes(ext);
  }
}
