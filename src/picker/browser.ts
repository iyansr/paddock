import * as vscode from 'vscode';

import { CdpClient, type CdpTransport } from './cdp';
import { PagePicker, type PickerHost } from './page-picker';

/**
 * True when VS Code exposes its integrated browser to Paddock (the `browser` API
 * proposal). The getters throw when the proposal is not enabled.
 */
export function browserApiAvailable(): boolean {
  try {
    return typeof vscode.window.openBrowserTab === 'function' && Array.isArray(vscode.window.browserTabs);
  } catch {
    return false;
  }
}

function transportOf(session: vscode.BrowserCDPSession): CdpTransport {
  return {
    send: message => void session.sendMessage(message),
    onMessage: handler => session.onDidReceiveMessage(handler),
    onClose: handler => session.onDidClose(handler),
    close: () => void session.close(),
  };
}

interface Attached {
  client: CdpClient;
  /** One picker per page target in the tab (normally exactly one). */
  pages: Map<string, PagePicker>;
}

/**
 * Keeps Paddock's picker in every integrated browser tab: a CDP session per tab
 * (no debugger involved), and a picker for its page.
 */
export class BrowserPickers implements vscode.Disposable {
  private readonly tabs = new Map<vscode.BrowserTab, Promise<Attached | undefined>>();
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(private readonly host: PickerHost) {}

  /** Attaches to the open tabs and to every tab opened later. Only call when `browserApiAvailable()`. */
  start(): void {
    const w = vscode.window;
    for (const tab of w.browserTabs) {
      this.attach(tab);
    }
    this.subscriptions.push(
      w.onDidOpenBrowserTab(tab => this.attach(tab)),
      w.onDidCloseBrowserTab(tab => this.forget(tab)),
    );
  }

  /** Starts or cancels a pick in the active browser tab; false when no browser tab is active. */
  async toggleActive(): Promise<boolean> {
    const tab = vscode.window.activeBrowserTab ?? vscode.window.browserTabs.at(-1);
    const attached = tab && (await this.attach(tab));
    if (!attached) {
      return false;
    }
    await Promise.all([...attached.pages.values()].map(p => p.toggle()));
    return attached.pages.size > 0;
  }

  /** Tells every picker who Send types into. */
  refreshTarget(): void {
    for (const pending of this.tabs.values()) {
      void pending.then(a => a?.pages.forEach(p => p.refreshTarget()));
    }
  }

  private attach(tab: vscode.BrowserTab): Promise<Attached | undefined> {
    let pending = this.tabs.get(tab);
    if (!pending) {
      pending = this.connect(tab).catch(e => {
        console.error('Paddock: could not attach to a browser tab:', e);
        this.tabs.delete(tab);
        return undefined;
      });
      this.tabs.set(tab, pending);
    }
    return pending;
  }

  private async connect(tab: vscode.BrowserTab): Promise<Attached> {
    const client = new CdpClient(transportOf(await tab.startCDPSession()));
    const attached: Attached = { client, pages: new Map() };
    client.on('Target.attachedToTarget', params => {
      const info = params.targetInfo as { type?: string } | undefined;
      const sessionId = params.sessionId;
      if (info?.type !== 'page' || typeof sessionId !== 'string') {
        return;
      }
      PagePicker.attach(client.session(sessionId), this.host).then(
        picker => attached.pages.set(sessionId, picker),
        e => console.error('Paddock: could not add the picker to a page:', e),
      );
    });
    client.on('Target.detachedFromTarget', params => {
      if (typeof params.sessionId === 'string') {
        attached.pages.delete(params.sessionId);
      }
    });
    client.onClose(() => this.tabs.delete(tab));
    // The tab's session talks to the browser; the page itself is a flattened target session.
    await client.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    // Wait briefly for the page session so a pick right after opening works.
    for (let i = 0; i < 20 && attached.pages.size === 0; i++) {
      await new Promise(r => setTimeout(r, 50));
    }
    return attached;
  }

  private forget(tab: vscode.BrowserTab): void {
    const pending = this.tabs.get(tab);
    this.tabs.delete(tab);
    void pending?.then(a => a?.client.close());
  }

  dispose(): void {
    this.subscriptions.forEach(s => s.dispose());
    for (const [tab, pending] of this.tabs) {
      this.tabs.delete(tab);
      void pending.then(async a => {
        if (a) {
          await Promise.all([...a.pages.values()].map(p => p.dispose()));
          a.client.close();
        }
      });
    }
  }
}
