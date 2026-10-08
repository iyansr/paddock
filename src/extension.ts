import * as vscode from 'vscode';
import { registerCommands } from './commands';
import { Herdr, type HerdrConfig } from './herdr/cli';
import { isSupportedVersion, MIN_HERDR_VERSION } from './herdr/parse';
import { Sessions } from './sessions';
import { setCollapsed, Store } from './store';
import { ProjectsDnd } from './tree/dnd';
import { ProjectsProvider, TREE_VIEW_ID } from './tree/provider';

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
	const provider = new ProjectsProvider(store, sessions);

	const view = vscode.window.createTreeView(TREE_VIEW_ID, {
		treeDataProvider: provider,
		dragAndDropController: new ProjectsDnd(store),
		canSelectMany: true,
	});

	context.subscriptions.push(
		view,
		view.onDidCollapseElement(e => e.element.kind === 'group' && store.update(d => setCollapsed(d, e.element.id, true))),
		view.onDidExpandElement(e => e.element.kind === 'group' && store.update(d => setCollapsed(d, e.element.id, false))),
		// globalState is shared between windows but not pushed to them; re-read on focus.
		vscode.window.onDidChangeWindowState(s => {
			if (s.focused) {
				store.reload();
				void sessions.refresh();
			}
		}),
		sessions.startPolling(2000),
		...registerCommands(store, sessions),
	);

	// Never await herdr here: activation must not block startup.
	void startHerdr(herdr, sessions);
}

async function startHerdr(herdr: Herdr, sessions: Sessions): Promise<void> {
	try {
		const version = await herdr.version();
		if (!isSupportedVersion(version)) {
			void offerInstall(`Paddock needs herdr ${MIN_HERDR_VERSION} or later (found "${version}").`, 'Update herdr');
			return;
		}
	} catch {
		void offerInstall('Paddock needs herdr, and could not find it. Set paddock.herdrPath if it is installed.', 'Install herdr');
		return;
	}
	try {
		// Only bring the server up when this window's project has sessions to reattach.
		if (sessions.currentProject()?.workspaceId) {
			await herdr.ensureServer();
		}
		await sessions.restore();
		await sessions.refresh();
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
