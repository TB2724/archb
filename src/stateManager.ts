import * as vscode from 'vscode';

export interface GitSettings {
  userName: string;
  userEmail: string;
  remoteUrl: string;
  branch: string;
  chatgptToken: string;
  claudeToken: string;
}

export class StateManager {
  private readonly ACTIVE_KEY = 'archb.isActive';
  private readonly GIT_KEY = 'archb.gitSettings';
  private context: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  isActive(): boolean {
    return this.context.globalState.get<boolean>(this.ACTIVE_KEY, false);
  }

  async setActive(value: boolean): Promise<void> {
    await this.context.globalState.update(this.ACTIVE_KEY, value);
  }

  async toggleActive(): Promise<boolean> {
    const next = !this.isActive();
    await this.setActive(next);
    return next;
  }

  getGitSettings(): GitSettings {
    return this.context.globalState.get<GitSettings>(this.GIT_KEY, {
      userName: '',
      userEmail: '',
      remoteUrl: '',
      branch: 'main',
      chatgptToken: '',
      claudeToken: ''
    });
  }

  async setGitSettings(settings: GitSettings): Promise<void> {
    await this.context.globalState.update(this.GIT_KEY, settings);
  }
}
