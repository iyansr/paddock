import * as path from 'node:path';

import * as vscode from 'vscode';

import { checkoutPath } from '../checkouts';
import type { Herdr } from '../herdr/cli';
import type { Sessions } from '../sessions';
import { browserApiAvailable, BrowserPickers } from './browser';
import { writePick } from './files';
import type { Pick } from './format';
import type { PickerHost } from './page-picker';

/** Extension id as VS Code knows it; `--enable-proposed-api` and argv.json name it. */
const EXTENSION_ID = 'undefined_publisher.paddock';

/**
 * Opens VS Code's integrated browser and keeps Paddock's element picker in its
 * pages, turning picks into files, clipboard text or agent input.
 */
export class Picker implements vscode.Disposable {
  private pickers: BrowserPickers | undefined;
  private readonly subscription: vscode.Disposable;

  constructor(
    private readonly herdr: Herdr,
    private readonly sessions: Sessions,
  ) {
    this.subscription = sessions.onDidChange(() => this.pickers?.refreshTarget());
  }

  /** Attaches to browser tabs when VS Code lets Paddock; never blocks activation. */
  start(): void {
    if (browserApiAvailable()) {
      this.pickers = new BrowserPickers(this.host());
      this.pickers.start();
    }
  }

  /** Opens an empty integrated browser tab in the active editor group; the picker comes with it. */
  async open(): Promise<void> {
    if (!this.pickers) {
      await this.explainUnavailable();
      return;
    }
    await vscode.window.openBrowserTab('', { viewColumn: vscode.ViewColumn.Active });
  }

  /** Starts or cancels a pick in the active browser tab. */
  async togglePick(): Promise<void> {
    if (!this.pickers) {
      await this.explainUnavailable();
      return;
    }
    if (!(await this.pickers.toggleActive())) {
      void vscode.window.showInformationMessage('Open a page in the browser first (Paddock: Open Browser).');
    }
  }

  private async explainUnavailable(): Promise<void> {
    const action = 'Open argv.json';
    const answer = await vscode.window.showWarningMessage(
      "Paddock's browser needs VS Code's integrated browser API, which is still a proposal. " +
        `Add "enable-proposed-api": ["${EXTENSION_ID}"] to argv.json and restart VS Code.`,
      action,
    );
    if (answer === action) {
      await vscode.commands.executeCommand('workbench.action.configureRuntimeArguments');
    }
  }

  private checkoutDir(): string {
    const checkout = this.sessions.currentCheckout();
    if (!checkout) {
      throw new Error('This window has no Paddock project open.');
    }
    return checkoutPath(checkout);
  }

  private host(): PickerHost {
    return {
      target: () => this.sessions.pickTarget()?.name,
      copy: async (pick: Pick, screenshot: Buffer | undefined, instruction: string) => {
        const written = await writePick(this.checkoutDir(), pick, screenshot, instruction);
        await vscode.env.clipboard.writeText(written.text);
        return `Copied ${pick.tag} to the clipboard`;
      },
      send: async (pick: Pick, screenshot: Buffer | undefined, instruction: string) => {
        const target = this.sessions.pickTarget();
        if (!target) {
          throw new Error('No session to send to. Start one in Paddock, or use Copy.');
        }
        const dir = this.checkoutDir();
        const written = await writePick(dir, pick, screenshot, instruction);
        // The agent resolves @paths from its own folder, which may be another checkout.
        const agentCheckout = this.sessions.checkoutOfWorkspace(target.workspaceId);
        const from = agentCheckout ? checkoutPath(agentCheckout) : dir;
        const rel = path.relative(from, written.file).split(path.sep).join('/');
        const ref = rel.startsWith('../') || path.isAbsolute(rel) ? written.file : rel;
        // Types without Enter so I can finish the prompt myself.
        await this.herdr.paneSendText(target.paneId, ` @${ref} `);
        this.sessions.show(target);
        return `Sent to ${target.name}`;
      },
    };
  }

  dispose(): void {
    this.subscription.dispose();
    this.pickers?.dispose();
  }
}
