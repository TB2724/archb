import * as vscode from 'vscode';
import { StateManager, GitSettings } from '../stateManager';
import { LogManager } from '../logManager';
import { VersionManager, SnapshotStatus } from '../versionManager';

interface UpdatePayload {
  isActive: boolean;
  version: string;
  snapshotStatus: SnapshotStatus;
  multiRoot: boolean;
  gitSettings: GitSettings;
  entries: Array<{
    id: string;
    time: string;
    file: string;
    changeType: string;
    hasAnswer: boolean;
    hasQuestion: boolean;
  }>;
}

export class SidebarProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private stateManager: StateManager;
  private logManager: LogManager;
  private versionManager: VersionManager;
  private context: vscode.ExtensionContext;

  public onReplayEntry?: (entryId: string) => void;
  public onTriggerSave?: () => void;
  public onTriggerPush?: () => void;

  constructor(
    context: vscode.ExtensionContext,
    stateManager: StateManager,
    logManager: LogManager,
    versionManager: VersionManager
  ) {
    this.context = context;
    this.stateManager = stateManager;
    this.logManager = logManager;
    this.versionManager = versionManager;
  }

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.buildHtml();

    webviewView.webview.onDidReceiveMessage(async msg => {
      switch (msg.type) {
        case 'toggle':
          await vscode.commands.executeCommand('archb.toggleActive');
          this.pushData();
          break;
        case 'saveSession':
          if (this.onTriggerSave) { this.onTriggerSave(); }
          break;
        case 'pushGitHub':
          if (this.onTriggerPush) { this.onTriggerPush(); }
          break;
        case 'clearLogs':
          await this.logManager.clearEntries();
          this.pushData();
          break;
        case 'requestData':
          this.pushData();
          break;
        case 'replayEntry':
          if (this.onReplayEntry && msg.entryId) { this.onReplayEntry(msg.entryId); }
          break;
        case 'saveGitSettings':
          if (msg.settings) {
            // Let the command handler do the actual saving + git config apply
            await vscode.commands.executeCommand('archb.openGitSettings', msg.settings);
            this.pushData();
          }
          break;
      }
    });

    webviewView.onDidDispose(() => {
      // No interval to clean up — updates come via events now.
    });

    // Initial push
    setTimeout(() => this.pushData(), 50);
  }

  /**
   * Push fresh data to the webview without rebuilding HTML — preserves focus,
   * scroll position, and typed-but-unsent text.
   */
  pushData() {
    if (!this.view) { return; }
    const payload = this.collectPayload();
    this.view.webview.postMessage({ type: 'update', payload });
  }

  /** Reports snapshot status changes coming from VersionManager. */
  onSnapshotStatus(status: SnapshotStatus) {
    if (!this.view) { return; }
    this.view.webview.postMessage({ type: 'snapshotStatus', status });
  }

  private collectPayload(): UpdatePayload {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const multiRoot = folders.length > 1;
    const entries = this.logManager.getEntries().slice(-30).reverse().map(e => {
      const file = e.file.split(/[\\/]/).pop() ?? e.file;
      const time = new Date(e.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
      return {
        id: e.id,
        time,
        file,
        changeType: e.changeType,
        hasAnswer: e.hasAnswer,
        hasQuestion: !!e.question
      };
    });
    return {
      isActive: this.stateManager.isActive(),
      version: this.versionManager.getCurrentVersion(),
      snapshotStatus: this.versionManager.getSnapshotStatus(),
      multiRoot,
      gitSettings: this.stateManager.getGitSettings(),
      entries
    };
  }

  /** Legacy method name used by extension.ts on activate/deactivate. */
  refresh() {
    this.pushData();
  }

  private buildHtml(): string {
    const nonce = this.makeNonce();

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Segoe UI', Arial, sans-serif; font-size: 12px; }
  body { background: #fff; color: #000; padding: 12px; border: 1px solid #000; }
  h2 { font-size: 15px; font-weight: 700; margin-bottom: 12px; border-bottom: 2px solid #000; padding-bottom: 6px; }
  h3 { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; margin: 14px 0 6px; color: #333; }
  .status-row { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
  .status-dot { width: 8px; height: 8px; border-radius: 50%; border: 1px solid #000; }
  .status-dot.active { background: #000; }
  .status-dot.inactive { background: #ccc; }
  .status-text { font-size: 11px; font-weight: 600; }
  .status-text.active { color: #000; }
  .status-text.inactive { color: #888; }
  .version-badge { margin-left: auto; font-size: 10px; background: #f0f0f0; padding: 2px 6px; border: 1px solid #ccc; }
  .snapshot-badge { font-size: 10px; padding: 2px 6px; border: 1px solid #ccc; background: #f9f9f9; }
  .snapshot-badge.creating { background: #fff4d6; }
  .snapshot-badge.ready { background: #e6f4ea; }
  .snapshot-badge.failed { background: #fde2e1; }
  .warn { font-size: 10px; background: #fff4d6; border: 1px solid #e0c060; padding: 4px 6px; margin-bottom: 8px; }
  .btn { display: block; width: 100%; padding: 7px; border: 1px solid #000; cursor: pointer; font-size: 12px; font-weight: 500; margin-bottom: 6px; text-align: center; background: #fff; color: #000; }
  .btn.active-btn { background: #444; color: #fff; }
  .btn.active-btn:hover { background: #222; }
  .btn:hover { background: #f0f0f0; }
  .btn-row { display: flex; gap: 6px; }
  .btn-row .btn { margin-bottom: 0; }
  .entry { display: flex; gap: 6px; padding: 5px 4px; border-bottom: 1px solid #eee; align-items: center; border-radius: 2px; }
  .entry.clickable { cursor: pointer; }
  .entry.clickable:hover { background: #f5f5f5; }
  .entry-time { color: #888; width: 40px; flex-shrink: 0; }
  .entry-file { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .entry-type { color: #555; font-size: 10px; width: 75px; flex-shrink: 0; }
  .entry-ans { width: 14px; text-align: center; }
  .empty { color: #aaa; font-style: italic; padding: 8px 0; }
  .settings { display: none; margin: 10px 0; padding: 8px; border: 1px solid #ccc; background: #f9f9f9; }
  .settings.open { display: block; }
  .settings label { display: block; font-size: 10px; font-weight: 700; margin: 6px 0 2px; color: #333; }
  .settings input { width: 100%; padding: 4px 6px; border: 1px solid #999; font-size: 12px; font-family: inherit; }
  .settings .hint { font-size: 10px; color: #666; margin-top: 6px; line-height: 1.4; }
  .toggle-settings { font-size: 10px; color: #555; cursor: pointer; text-decoration: underline; display: inline-block; margin-bottom: 4px; }
</style>
</head>
<body>
<h2>Archb</h2>

<div id="multiRootWarn" class="warn" style="display:none">⚠ Multi-root workspace detected. Archb uses the first folder only.</div>

<div class="status-row">
  <div class="status-dot inactive" id="dot"></div>
  <span class="status-text inactive" id="statusText">INACTIVE</span>
  <span class="version-badge" id="vBadge">v1.0</span>
</div>
<div class="status-row">
  <span class="snapshot-badge" id="snapBadge">snapshot: idle</span>
</div>

<button class="btn" id="toggleBtn">▶ Activate</button>

<h3>Session</h3>
<div class="btn-row">
  <button class="btn" id="saveBtn" title="Review pending changes (no commit)">Save Session &amp; Ask</button>
  <button class="btn" id="pushBtn" title="Review + commit + push">↑ GitHub Push</button>
</div>

<h3>Git Settings</h3>
<span class="toggle-settings" id="toggleSettings">show / hide</span>
<div class="settings" id="settingsPanel">
  <label for="gitUserName">user.name</label>
  <input type="text" id="gitUserName" />
  <label for="gitUserEmail">user.email</label>
  <input type="text" id="gitUserEmail" />
  <label for="gitRemote">remote url (origin)</label>
  <input type="text" id="gitRemote" placeholder="https://github.com/you/repo.git" />
  <label for="gitBranch">default branch</label>
  <input type="text" id="gitBranch" placeholder="main" />
  <button class="btn" id="saveSettingsBtn" style="margin-top:8px">Save Git Settings</button>
  <div class="hint">Use GitHub CLI for authentication</div>
</div>

<h3>AI Settings</h3>
<span class="toggle-settings" id="toggleAiSettings">show / hide</span>
<div class="settings" id="aiSettingsPanel">
  <label for="chatgptToken">ChatGPT</label>
  <input type="password" id="chatgptToken" placeholder="sk-..." />
  <label for="claudeToken">Claude</label>
  <input type="password" id="claudeToken" placeholder="sk-ant-..." />
  <button class="btn" id="saveAiSettingsBtn" style="margin-top:8px">Save AI Settings</button>
  <div class="hint">If set, Archb uses this API and Claude takes priority over ChatGPT.</div>
</div>

<h3>Log</h3>
<div id="logContainer"><div class="empty">No entries yet.</div></div>

<h3>Actions</h3>
<button class="btn" id="clearBtn">Clear Logs</button>

<script nonce="${nonce}">
  (function() {
    const vscode = acquireVsCodeApi();

    function send(type, extra) {
      vscode.postMessage(Object.assign({ type }, extra || {}));
    }

    document.getElementById('toggleBtn').addEventListener('click', function() { send('toggle'); });
    document.getElementById('saveBtn').addEventListener('click', function() { send('saveSession'); });
    document.getElementById('pushBtn').addEventListener('click', function() { send('pushGitHub'); });
    document.getElementById('clearBtn').addEventListener('click', function() { send('clearLogs'); });

    const settingsPanel = document.getElementById('settingsPanel');
    document.getElementById('toggleSettings').addEventListener('click', function() {
      settingsPanel.classList.toggle('open');
    });
    document.getElementById('saveSettingsBtn').addEventListener('click', function() {
      const current = JSON.parse(JSON.stringify({
        chatgptToken: document.getElementById('chatgptToken').value,
        claudeToken: document.getElementById('claudeToken').value
      }));
      const settings = {
        userName: document.getElementById('gitUserName').value,
        userEmail: document.getElementById('gitUserEmail').value,
        remoteUrl: document.getElementById('gitRemote').value,
        branch: document.getElementById('gitBranch').value || 'main',
        chatgptToken: current.chatgptToken,
        claudeToken: current.claudeToken
      };
      send('saveGitSettings', { settings: settings });
    });

    const aiSettingsPanel = document.getElementById('aiSettingsPanel');
    document.getElementById('toggleAiSettings').addEventListener('click', function() {
      aiSettingsPanel.classList.toggle('open');
    });
    document.getElementById('saveAiSettingsBtn').addEventListener('click', function() {
      const settings = {
        userName: document.getElementById('gitUserName').value,
        userEmail: document.getElementById('gitUserEmail').value,
        remoteUrl: document.getElementById('gitRemote').value,
        branch: document.getElementById('gitBranch').value || 'main',
        chatgptToken: document.getElementById('chatgptToken').value,
        claudeToken: document.getElementById('claudeToken').value
      };
      send('saveGitSettings', { settings: settings });
    });

    vscode.postMessage({ type: 'requestData' });

    function applyUpdate(p) {
      document.getElementById('dot').className = 'status-dot ' + (p.isActive ? 'active' : 'inactive');
      const st = document.getElementById('statusText');
      st.className = 'status-text ' + (p.isActive ? 'active' : 'inactive');
      st.textContent = p.isActive ? 'ACTIVE' : 'INACTIVE';
      document.getElementById('vBadge').textContent = p.version;
      const btn = document.getElementById('toggleBtn');
      btn.className = 'btn' + (p.isActive ? ' active-btn' : '');
      btn.textContent = p.isActive ? '⏹ Deactivate' : '▶ Activate';

      const snap = document.getElementById('snapBadge');
      snap.className = 'snapshot-badge ' + p.snapshotStatus;
      snap.textContent = 'snapshot: ' + p.snapshotStatus;

      document.getElementById('multiRootWarn').style.display = p.multiRoot ? 'block' : 'none';

      // Only overwrite settings inputs when the fields aren't focused (avoid clobbering typing)
      const active = document.activeElement;
      if (!active || active.tagName !== 'INPUT') {
        document.getElementById('gitUserName').value = p.gitSettings.userName || '';
        document.getElementById('gitUserEmail').value = p.gitSettings.userEmail || '';
        document.getElementById('gitRemote').value = p.gitSettings.remoteUrl || '';
        document.getElementById('gitBranch').value = p.gitSettings.branch || 'main';
        document.getElementById('chatgptToken').value = p.gitSettings.chatgptToken || '';
        document.getElementById('claudeToken').value = p.gitSettings.claudeToken || '';
      }

      const logEl = document.getElementById('logContainer');
      if (!p.entries.length) {
        logEl.innerHTML = '<div class="empty">No entries yet.</div>';
      } else {
        const frag = document.createDocumentFragment();
        p.entries.forEach(function(e) {
          const row = document.createElement('div');
          row.className = 'entry' + (e.hasQuestion ? ' clickable' : '');
          if (e.hasQuestion) {
            row.title = 'Click to revise your answer';
            row.addEventListener('click', function() {
              vscode.postMessage({ type: 'replayEntry', entryId: e.id });
            });
          }
          row.innerHTML =
            '<span class="entry-time"></span>' +
            '<span class="entry-file"></span>' +
            '<span class="entry-type"></span>' +
            '<span class="entry-ans"></span>';
          row.children[0].textContent = e.time;
          row.children[1].textContent = e.file;
          row.children[2].textContent = e.changeType;
          row.children[3].textContent = e.hasAnswer ? '✓' : (e.hasQuestion ? '?' : '○');
          frag.appendChild(row);
        });
        logEl.innerHTML = '';
        logEl.appendChild(frag);
      }
    }

    window.addEventListener('message', function(e) {
      const msg = e.data;
      if (msg.type === 'update') {
        applyUpdate(msg.payload);
      } else if (msg.type === 'snapshotStatus') {
        const snap = document.getElementById('snapBadge');
        snap.className = 'snapshot-badge ' + msg.status;
        snap.textContent = 'snapshot: ' + msg.status;
      }
    });
  })();
</script>
</body>
</html>`;
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
