import * as vscode from 'vscode';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import archiver from 'archiver';
import { LogManager } from './logManager';
import { OllamaClient } from './ollamaClient';
import { StateManager } from './stateManager';

interface VersionMeta {
  version: string;
  timestamp: string;
}

export type SnapshotStatus = 'idle' | 'creating' | 'ready' | 'failed';

export class VersionManager {
  private context: vscode.ExtensionContext;
  private logManager: LogManager | undefined;
  private ollama: OllamaClient;
  private currentLogsDir: string | undefined;
  private readonly VERSION_KEY = 'archb.currentVersion';

  private snapshotStatus: SnapshotStatus = 'idle';
  private onStatusChange?: (s: SnapshotStatus) => void;

  constructor(context: vscode.ExtensionContext, stateManager: StateManager) {
    this.context = context;
    this.ollama = new OllamaClient(stateManager);
  }

  setLogManager(logManager: LogManager) { this.logManager = logManager; }
  setOnStatusChange(cb: (s: SnapshotStatus) => void) { this.onStatusChange = cb; }
  getSnapshotStatus(): SnapshotStatus { return this.snapshotStatus; }

  private setStatus(s: SnapshotStatus) {
    this.snapshotStatus = s;
    if (this.onStatusChange) { this.onStatusChange(s); }
  }

  getVersions(): VersionMeta[] {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) { return []; }
    const versionsDir = path.join(folders[0].uri.fsPath, 'versions');
    if (!fs.existsSync(versionsDir)) { return []; }

    try {
      return fs.readdirSync(versionsDir, { withFileTypes: true })
        .filter(e => e.isDirectory() && /^v\d+\.\d+$/.test(e.name))
        .map(e => {
          const metaPath = path.join(versionsDir, e.name, 'meta.json');
          if (fs.existsSync(metaPath)) {
            try { return JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as VersionMeta; } catch { /* noop */ }
          }
          const stat = fs.statSync(path.join(versionsDir, e.name));
          return { version: e.name, timestamp: stat.mtime.toISOString() };
        })
        .sort((a, b) => {
          const pa = this.parseVersion(a.version);
          const pb = this.parseVersion(b.version);
          if (pa.major !== pb.major) { return pa.major - pb.major; }
          return pa.minor - pb.minor;
        });
    } catch { return []; }
  }

  getCurrentVersion(): string {
    return this.context.globalState.get<string>(this.VERSION_KEY, 'v1.0');
  }

  /**
   * On Activate: create a new version folder, write metadata, and kick off
   * a full project snapshot in the background. Returns once metadata is
   * persisted so the UI can update immediately. Snapshot completion is
   * reported via the status callback.
   */
  async createNewSession(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) { return; }

    const rootPath = folders[0].uri.fsPath;
    const version = this.nextVersion();

    const versionDir = path.join(rootPath, 'versions', version);
    const snapshotDir = path.join(versionDir, 'snapshot');
    const logsDir = path.join(versionDir, 'logs');

    await fsp.mkdir(snapshotDir, { recursive: true });
    await fsp.mkdir(logsDir, { recursive: true });

    await fsp.writeFile(
      path.join(versionDir, 'meta.json'),
      JSON.stringify({ version, timestamp: new Date().toISOString() }, null, 2)
    );

    await this.context.globalState.update(this.VERSION_KEY, version);
    await this.context.globalState.update('archb.currentLogsDir', logsDir);
    this.currentLogsDir = logsDir;

    if (this.logManager) { this.logManager.setLogsDir(logsDir, version); }

    // Fire-and-forget snapshot — don't block Activate
    this.setStatus('creating');
    const zipPath = path.join(snapshotDir, `snapshot.zip`);
    this.createZipSnapshot(rootPath, zipPath)
      .then(() => this.setStatus('ready'))
      .catch(err => {
        console.error('Archb snapshot failed:', err);
        this.setStatus('failed');
      });

    console.log(`Archb: Session ${version} started`);
  }

  async finalizeSession(): Promise<void> {
    const logsDir = this.currentLogsDir
      ?? this.context.globalState.get<string>('archb.currentLogsDir');
    if (!logsDir || !this.logManager) { return; }

    const version = this.getCurrentVersion();
    const entries = this.logManager.getEntriesForLogbook();
    if (entries.length === 0) { return; }

    console.log(`[Archb] finalizeSession: generating logs for ${version} (${entries.length} entries)`);
    try {
      const technical = await this.ollama.generateLogbook(entries, 'technical', version);
      await fsp.writeFile(path.join(logsDir, `${version}_technical.md`), technical, 'utf-8');
      console.log(`[Archb] wrote ${version}_technical.md`);
      const customer = await this.ollama.generateLogbook(entries, 'customer', version);
      await fsp.writeFile(path.join(logsDir, `${version}_customer.md`), customer, 'utf-8');
      console.log(`[Archb] wrote ${version}_customer.md`);
    } catch (err) {
      console.error('[Archb] log generation failed:', err);
    }
  }

  private parseVersion(v: string): { major: number; minor: number } {
    const m = v.match(/^v(\d+)\.(\d+)$/);
    if (!m) { return { major: 0, minor: 0 }; }
    return { major: parseInt(m[1]), minor: parseInt(m[2]) };
  }

  private nextVersion(): string {
    const versions = this.getVersions();

    // If no version folders exist on disk, always start fresh from v1.1
    // regardless of what globalState says.
    if (versions.length === 0) {
      console.log('[Archb] No version folders found on disk - resetting to v1.1');
      this.context.globalState.update(this.VERSION_KEY, 'v1.0');
      return 'v1.1';
    }

    let maxMinor = 0;
    let major = 1;
    for (const v of versions) {
      const p = this.parseVersion(v.version);
      if (p.major > major) { major = p.major; maxMinor = 0; }
      if (p.major === major && p.minor > maxMinor) { maxMinor = p.minor; }
    }
    return `v${major}.${maxMinor + 1}`;
  }

  /**
   * Zip the whole project (minus heavy/generated folders) using archiver.
   * Works on Windows, macOS and Linux without a system `zip` binary.
   */
  private createZipSnapshot(sourceDir: string, outputPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const output = fs.createWriteStream(outputPath);
      const archive = archiver('zip', { zlib: { level: 9 } });

      output.on('close', () => resolve());
      output.on('error', err => reject(err));
      archive.on('error', err => reject(err));
      archive.on('warning', err => {
        // Non-fatal warnings
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') { reject(err); }
      });

      archive.pipe(output);

      // Add the whole directory but skip generated / huge / version-internal stuff
      archive.glob('**/*', {
        cwd: sourceDir,
        dot: true,
        ignore: [
          // Version control
          '.git/**',
          // Dependency folders
          'node_modules/**',
          '.npm/**',
          // Python virtual environments (can be 100-500 MB)
          '.venv/**',
          'venv/**',
          'env/**',
          '.env/**',
          '__pycache__/**',
          '*.pyc',
          // Build output
          'dist/**',
          'out/**',
          'build/**',
          'target/**',          // Rust/Java
          '*.class',            // Java
          // Archb own folders
          'versions/**',
          // IDE
          '.vscode/**',
          '.idea/**',
          // Large binary / cache
          '*.zip',
          '*.tar.gz',
          '*.gguf',
          '.cache/**',
          'tmp/**',
          'temp/**',
        ]
      });
      archive.finalize();
    });
  }
}
