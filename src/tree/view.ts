import { randomBytes } from 'node:crypto';
import * as os from 'node:os';

import * as vscode from 'vscode';

import type { Sessions } from '../sessions';
import { moveGroups, moveProjects, setCollapsed, type Store } from '../store';
import { buildModel, parseMessage, VIEW_ID, type ToView, type ViewModel } from './model';

/** The Projects sidebar: a webview that draws the model and sends row actions back as commands. */
export class ProjectsView implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private pending = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly store: Store,
    private readonly sessions: Sessions,
  ) {}

  register(): vscode.Disposable {
    return vscode.Disposable.from(
      vscode.window.registerWebviewViewProvider(VIEW_ID, this),
      this.store.onDidChange(() => this.schedule()),
      this.sessions.onDidChange(() => this.schedule()),
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const { webview } = view;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'dist'),
        vscode.Uri.joinPath(this.extensionUri, 'media'),
      ],
    };
    webview.html = this.html(webview);
    webview.onDidReceiveMessage(raw => void this.receive(raw));
    view.onDidChangeVisibility(() => view.visible && this.post());
    view.onDidDispose(() => (this.view = undefined));
  }

  model(): ViewModel {
    return buildModel({
      data: this.store.snapshot,
      worktreesOf: p => this.sessions.worktreesOf(p),
      sessionsIn: c => this.sessions.sessionsIn(c),
      current: this.sessions.currentCheckout(),
      home: os.homedir(),
    });
  }

  /** Coalesces bursts of store and status changes into one post. */
  private schedule(): void {
    if (!this.pending) {
      this.pending = true;
      queueMicrotask(() => {
        this.pending = false;
        this.post();
      });
    }
  }

  private post(): void {
    const message: ToView = { type: 'model', model: this.model() };
    void this.view?.webview.postMessage(message);
  }

  private async receive(raw: unknown): Promise<void> {
    const m = parseMessage(raw);
    switch (m?.type) {
      case 'ready':
        this.post();
        return;
      case 'command':
        await vscode.commands.executeCommand(m.command, m.node);
        return;
      case 'collapse':
        await this.store.update(d => setCollapsed(d, m.groupId, m.collapsed));
        return;
      case 'moveProjects':
        await this.store.update(d => moveProjects(d, m.ids, m.groupId, m.before));
        return;
      case 'moveGroups':
        await this.store.update(d => moveGroups(d, m.ids, m.before));
        return;
    }
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('base64');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'sidebar.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'sidebar.css'));
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; img-src ${webview.cspSource} data:; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${style}">
</head>
<body data-vscode-context='{"preventDefaultContextMenuItems":true}'>
<div id="root" role="tree" aria-label="Projects"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}
