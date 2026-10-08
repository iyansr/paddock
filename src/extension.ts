import * as vscode from 'vscode';

import { registerCommands } from './commands';
import { Herdr, type HerdrConfig } from './herdr/cli';
import { isSupportedVersion, MIN_HERDR_VERSION } from './herdr/parse';
import { Picker } from './picker/controller';
import { Sessions } from './sessions';
import { Store } from './store';
import { ProjectsView } from './tree/view';

function readConfig(): HerdrConfig {
  const c = vscode.workspace.getConfiguration('paddock');
  return { path: c.get<string>('herdrPath') ?? '', session: c.get<string>('herdrSession') || 'paddock' };
}

let active: Sessions | undefined;

export function activate(context: vscode.ExtensionContext) {
  const store = new Store(context.globalState);
  const herdr = new Herdr(readConfig);
  const sessions = new Sessions(herdr, store, context);
  active = sessions;
  const picker = new Picker(herdr, sessions);

  context.subscriptions.push(
    new ProjectsView(context.extensionUri, store, sessions).register(),
    // globalState is shared between windows but not pushed to them; re-read on focus.
    vscode.window.onDidChangeWindowState(s => {
      if (s.focused) {
        store.reload();
        void sessions.refresh();
        void sessions.refreshWorktrees();
      }
    }),
    sessions.startPolling(2000),
    sessions.watchBranches(),
    picker,
    ...registerCommands(store, sessions, picker),
  );

  // Never await herdr here: activation must not block startup.
  void startHerdr(herdr, sessions);
  // Attaching to browser tabs is asynchronous too.
  picker.start();
}

async function startHerdr(herdr: Herdr, sessions: Sessions): Promise<void> {
  try {
    const version = await herdr.version();
    if (!isSupportedVersion(version)) {
      void offerInstall(`Paddock needs herdr ${MIN_HERDR_VERSION} or later (found "${version}").`, 'Update herdr');
      return;
    }
  } catch {
    void offerInstall(
      'Paddock needs herdr, and could not find it. Set paddock.herdrPath if it is installed.',
      'Install herdr',
    );
    return;
  }
  try {
    // Only bring the server up when this window's checkout may have sessions to reattach.
    const current = sessions.currentCheckout();
    if (current?.worktree || current?.project.workspaceId) {
      await herdr.ensureServer();
    }
    // Before restore: a window opened on a worktree made outside Paddock needs the list to know its project.
    await sessions.refreshWorktrees();
    await sessions.restore();
    await sessions.refresh();
    await sessions.finishPendingRemove();
  } catch (e) {
    void vscode.window.showErrorMessage(`Paddock: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function offerInstall(message: string, action: string): Promise<void> {
  const answer = await vscode.window.showWarningMessage(message, action);
  if (answer === action) {
    // Runs herdr's own installer in a visible terminal, only after the click above.
    const terminal = vscode.window.createTerminal('Install herdr');
    terminal.show();
    terminal.sendText(Herdr.installCommand);
  }
}

export function deactivate() {
  // Terminals close as the window goes away; that must not erase the saved layout.
  active?.markLeaving();
}
