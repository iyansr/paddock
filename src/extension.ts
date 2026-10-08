import * as vscode from 'vscode';
import { registerCommands } from './commands';
import { setCollapsed, Store } from './store';
import { ProjectsDnd } from './tree/dnd';
import { ProjectsProvider, TREE_VIEW_ID } from './tree/provider';

export function activate(context: vscode.ExtensionContext) {
	const store = new Store(context.globalState);
	const provider = new ProjectsProvider(store);

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
		vscode.window.onDidChangeWindowState(s => s.focused && store.reload()),
		...registerCommands(store),
	);
}

export function deactivate() {}
