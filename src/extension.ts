import * as vscode from 'vscode';
import { FileWatcher } from './fileWatcher';
import { StateManager, GitSettings } from './stateManager';
import { OverlayManager } from './overlayManager';
import { LogManager } from './logManager';
import { VersionManager } from './versionManager';
import { GitManager } from './gitManager';
import { SidebarProvider } from './panels/sidebarProvider';

let fileWatcher: FileWatcher | undefined;
let overlayManager: OverlayManager | undefined;
let logManager: LogManager | undefined;
let versionManager: VersionManager | undefined;
let sidebarProvider: SidebarProvider | undefined;
let gitManager: GitManager | undefined;
let stateManager: StateManager | undefined;

export async function activate(context: vscode.ExtensionContext) {
  console.log('Archb activating...');

  stateManager = new StateManager(context);
  logManager = new LogManager(context);
  versionManager = new VersionManager(context, stateManager);
  versionManager.setLogManager(logManager);
  overlayManager = new OverlayManager(context, logManager, stateManager);
  gitManager = new GitManager(stateManager, logManager);

  sidebarProvider = new SidebarProvider(context, stateManager, logManager, versionManager);

  // Wire callbacks
  sidebarProvider.onReplayEntry = (entryId: string) => {
    overlayManager!.revisitEntry(entryId);
  };
  sidebarProvider.onTriggerSave = async () => {
    await overlayManager!.startSession('save', () => {
      logManager!.clearDedup();
      sidebarProvider!.pushData();
    });
  };
  sidebarProvider.onTriggerPush = async () => {
    const settings = stateManager!.getGitSettings();
    if (!settings.userName.trim() || !settings.userEmail.trim()) {
      vscode.window.showWarningMessage('Archb: Please set Git user.name and user.email in the sidebar settings first.');
      return;
    }
    await overlayManager!.startSession('push', async completed => {
      logManager!.clearDedup();
      sidebarProvider!.pushData();
      if (!completed) { return; }
      const result = await gitManager!.commitAndPush();
      if (result.ok) {
        vscode.window.showInformationMessage('Archb: ' + result.message);
      } else {
        vscode.window.showErrorMessage('Archb: ' + result.message);
      }
    });
  };

  // Log → Sidebar live sync
  logManager.setOnChange(() => { sidebarProvider!.pushData(); });

  // Snapshot status → Sidebar
  versionManager.setOnStatusChange(status => { sidebarProvider!.onSnapshotStatus(status); });

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('archb.sidebarView', sidebarProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('archb.toggleActive', async () => {
      const isActive = await stateManager!.toggleActive();
      if (isActive) {
        await startWatching();
        vscode.window.showInformationMessage('Archb is now ACTIVE');
      } else {
        await stopWatching();
        vscode.window.showInformationMessage('Archb is now INACTIVE');
      }
      sidebarProvider!.pushData();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('archb.openPanel', () => {
      vscode.commands.executeCommand('workbench.view.extension.archb-sidebar');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('archb.pushToGithub', async () => {
      if (sidebarProvider?.onTriggerPush) { await sidebarProvider.onTriggerPush(); }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('archb.saveSession', async () => {
      if (sidebarProvider?.onTriggerSave) { await sidebarProvider.onTriggerSave(); }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('archb.openGitSettings', async (settings?: GitSettings) => {
      if (settings && gitManager) {
        // Validate API tokens before saving
        const tokenError = validateApiTokens(settings);
        if (tokenError) {
          vscode.window.showErrorMessage('Archb: ' + tokenError);
          return;
        }

        const result = await gitManager.saveSettings(settings);
        if (result.ok) {
          // Show which AI mode is active
          const mode = getActiveAiMode(settings);
          const modeMsg = mode === 'claude'
            ? 'Claude API active.'
            : mode === 'chatgpt'
            ? 'ChatGPT API active.'
            : 'No API key set — using Ollama.';
          vscode.window.showInformationMessage(`Archb: ${result.message} ${modeMsg}`);
        } else {
          vscode.window.showErrorMessage('Archb: ' + result.message);
        }
        sidebarProvider!.pushData();
      }
    })
  );

  // IMPORTANT: Check for pending changes from a previous session BEFORE
  // startWatching() runs. Otherwise createNewSession() wipes the entries
  // we'd want to ask about.
  await promptForPendingChanges();

  // Auto-start file watching if Archb was active before VS Code restarted
  if (stateManager.isActive()) {
    await startWatching();
  }

  console.log('Archb activated.');
}

/**
 * If the previous session left unanswered changes in storage, prompt the user
 * to document them now. The dialog is "modal" (sticky until the user picks)
 * so it does not auto-dismiss.
 *
 * IMPORTANT: This runs BEFORE startWatching() so the pending entries are
 * still in the log. If the user picks "Yes", we run the save session, which
 * persists the answers to the OLD logs dir. Only after that completes do we
 * proceed to startWatching() (which creates the new session and wipes entries).
 */
async function promptForPendingChanges() {
  if (!logManager || !overlayManager) { return; }

  const pending = logManager.getPendingChanges();
  const unanswered = logManager.getUnansweredWithQuestion();
  const total = pending.length + unanswered.length;

  console.log(`[Archb] promptForPendingChanges: pending=${pending.length}, unanswered=${unanswered.length}, total=${total}`);

  if (total === 0) { return; }

  const choice = await vscode.window.showInformationMessage(
    `Archb: You have ${total} unanswered change${total === 1 ? '' : 's'} from a previous session. Document them now?`,
    { modal: true },
    'Yes, ask me now',
    'Later'
  );

  if (choice === 'Yes, ask me now') {
    console.log('[Archb] User chose to answer pending questions now');
    // Run the session directly via overlayManager (no need to go through sidebar)
    await overlayManager.startSession('save', () => {
      if (sidebarProvider) { sidebarProvider.pushData(); }
    });
    // Wait a moment to ensure persistence finishes before startWatching wipes entries
    await new Promise(resolve => setTimeout(resolve, 500));
  } else {
    console.log('[Archb] User chose to answer pending questions later');
  }
}

async function startWatching() {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    vscode.window.showWarningMessage('Archb: No workspace folder open.');
    await stateManager!.setActive(false);
    return;
  }

  await versionManager!.createNewSession();

  fileWatcher = new FileWatcher(workspaceFolders[0].uri.fsPath, logManager!);
  fileWatcher.start();
}

async function stopWatching() {
  if (fileWatcher) {
    fileWatcher.stop();
    fileWatcher = undefined;
  }
  if (versionManager) {
    await versionManager.finalizeSession();
  }
}

export async function deactivate() {
  if (fileWatcher) {
    fileWatcher.stop();
  }
  if (logManager) {
    logManager.flushSync();
  }
  if (versionManager) {
    try { await versionManager.finalizeSession(); } catch { /* noop */ }
  }
}

/**
 * Validates API tokens. Returns an error string if invalid, undefined if ok.
 */
function validateApiTokens(settings: GitSettings): string | undefined {
  const chatgpt = settings.chatgptToken?.trim() ?? '';
  const claude = settings.claudeToken?.trim() ?? '';

  if (chatgpt.length > 0) {
    if (!chatgpt.startsWith('sk-')) {
      return 'Invalid ChatGPT token — must start with "sk-". Please check your OpenAI API key.';
    }
    if (chatgpt.length < 20) {
      return 'ChatGPT token looks too short. Please check your OpenAI API key.';
    }
  }

  if (claude.length > 0) {
    if (!claude.startsWith('sk-ant-')) {
      return 'Invalid Claude token — must start with "sk-ant-". Please check your Anthropic API key.';
    }
    if (claude.length < 20) {
      return 'Claude token looks too short. Please check your Anthropic API key.';
    }
  }

  return undefined;
}

/**
 * Returns which AI mode would be active given the provided settings.
 */
function getActiveAiMode(settings: GitSettings): 'claude' | 'chatgpt' | 'ollama' {
  const claude = settings.claudeToken?.trim() ?? '';
  const chatgpt = settings.chatgptToken?.trim() ?? '';
  if (claude.startsWith('sk-ant-')) { return 'claude'; }
  if (chatgpt.startsWith('sk-')) { return 'chatgpt'; }
  return 'ollama';
}
