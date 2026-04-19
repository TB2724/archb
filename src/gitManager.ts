import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { StateManager, GitSettings } from './stateManager';
import { LogManager } from './logManager';
import { OllamaClient } from './ollamaClient';

const pexec = promisify(exec);

export class GitManager {
  private stateManager: StateManager;
  private logManager: LogManager;
  private ollama: OllamaClient;

  constructor(stateManager: StateManager, logManager: LogManager) {
    this.stateManager = stateManager;
    this.logManager = logManager;
    this.ollama = new OllamaClient(stateManager);
  }

  getSettings(): GitSettings {
    return this.stateManager.getGitSettings();
  }

  /**
   * Persist settings into extension state AND apply them to the workspace repo.
   * Never stores tokens or passwords — HTTPS auth relies on the system credential manager.
   */
  async saveSettings(settings: GitSettings): Promise<{ ok: boolean; message: string }> {
    await this.stateManager.setGitSettings(settings);

    const cwd = this.getWorkspacePath();
    if (!cwd) { return { ok: false, message: 'No workspace open.' }; }

    try {
      if (!this.hasGitDir(cwd)) {
        await pexec('git init', { cwd });
      }
      if (settings.userName.trim()) {
        await pexec(`git config user.name ${this.shellQuote(settings.userName.trim())}`, { cwd });
      }
      if (settings.userEmail.trim()) {
        await pexec(`git config user.email ${this.shellQuote(settings.userEmail.trim())}`, { cwd });
      }
      if (settings.remoteUrl.trim()) {
        // Add or update origin
        try {
          await pexec(`git remote set-url origin ${this.shellQuote(settings.remoteUrl.trim())}`, { cwd });
        } catch {
          await pexec(`git remote add origin ${this.shellQuote(settings.remoteUrl.trim())}`, { cwd });
        }
      }
      return { ok: true, message: 'Git settings saved.' };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, message: 'Git config failed: ' + msg };
    }
  }

  /**
   * Run add + commit + push. Commit message is generated from the answered
   * Q&A entries via Ollama (fallback: a simple file list).
   */
  async commitAndPush(): Promise<{ ok: boolean; message: string }> {
    const cwd = this.getWorkspacePath();
    if (!cwd) { return { ok: false, message: 'No workspace open.' }; }
    if (!this.hasGitDir(cwd)) {
      return { ok: false, message: 'Not a git repository. Initialize via Archb settings.' };
    }

    const settings = this.getSettings();
    if (!settings.userName.trim() || !settings.userEmail.trim()) {
      return { ok: false, message: 'Git user.name and user.email missing. Open Archb settings first.' };
    }

    const entries = this.logManager.getEntriesForLogbook();
    const message = await this.ollama.generateCommitMessage(entries);
    const branch = settings.branch.trim() || 'main';

    const terminal = vscode.window.createTerminal('Archb – GitHub Push');
    terminal.show(true);

    // Escape the message for the shell
    const safeMsg = this.shellQuote(message);
    const safeBranch = this.shellQuote(branch);

    // Stage + commit local changes first
    terminal.sendText(`git add .`);
    terminal.sendText(`git commit -m ${safeMsg}`);
    // Rebase on top of remote so we don't get "rejected (fetch first)"
    // if someone pushed to origin in the meantime. If there are no new
    // remote commits, this is a no-op.
    terminal.sendText(`git pull --rebase origin ${safeBranch}`);
    // Now push
    terminal.sendText(`git push origin ${safeBranch}`);

    return { ok: true, message: `Pushing to origin/${branch} with message: ${message}` };
  }

  private getWorkspacePath(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) { return undefined; }
    return folders[0].uri.fsPath;
  }

  private hasGitDir(cwd: string): boolean {
    return fs.existsSync(path.join(cwd, '.git'));
  }

  /**
   * Quote a string for use inside a shell command. Uses double quotes on
   * Windows (cmd) and single quotes elsewhere. Not bullet-proof but
   * sufficient for user-name/email/URL/commit-message content.
   */
  private shellQuote(s: string): string {
    if (process.platform === 'win32') {
      return '"' + s.replace(/"/g, '\\"') + '"';
    }
    return "'" + s.replace(/'/g, "'\\''") + "'";
  }
}
