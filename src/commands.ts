import * as path from 'node:path';
import * as vscode from 'vscode';
import { addGroup, addProject, deleteGroup, moveProjects, removeProject, renameGroup, sortedGroups, Store, UNGROUPED_ID } from './store';
import type { Node } from './tree/provider';

/** Tree context-menu commands get (clicked node, all selected nodes). */
function targets(node: Node | undefined, selected: readonly Node[] | undefined, kind: Node['kind']): Node[] {
	const nodes = selected?.length ? selected : node ? [node] : [];
	return nodes.filter(n => n.kind === kind);
}

export function registerCommands(store: Store): vscode.Disposable[] {
	const groupName = (id: string) => store.snapshot.groups.find(g => g.id === id)?.name ?? '';

	const askGroupName = (value?: string) =>
		vscode.window.showInputBox({
			prompt: 'Group name',
			value,
			validateInput: v => (v.trim() ? undefined : 'Name required'),
		});

	return [
		vscode.commands.registerCommand('paddock.addProject', async (node?: Node) => {
			const groupId = node?.kind === 'group' ? node.id : undefined;
			const picked = await vscode.window.showOpenDialog({
				canSelectFiles: false,
				canSelectFolders: true,
				canSelectMany: true,
				openLabel: 'Add project',
			});
			for (const uri of picked ?? []) {
				await store.update(d => addProject(d, { name: path.basename(uri.fsPath), path: uri.fsPath, groupId }));
			}
		}),

		vscode.commands.registerCommand('paddock.removeProject', async (node?: Node, selected?: Node[]) => {
			const ids = targets(node, selected, 'project').map(n => n.id);
			if (!ids.length) {
				return;
			}
			const names = store.snapshot.projects.filter(p => ids.includes(p.id)).map(p => p.name);
			const answer = await vscode.window.showWarningMessage(
				ids.length === 1 ? `Remove project "${names[0]}"?` : `Remove ${ids.length} projects?`,
				{ modal: true, detail: 'This only removes it from Paddock. Files on disk and running agents are not touched.' },
				'Remove',
			);
			if (answer === 'Remove') {
				await store.update(d => ids.reduce(removeProject, d));
			}
		}),

		vscode.commands.registerCommand('paddock.newGroup', async () => {
			const name = (await askGroupName())?.trim();
			if (name) {
				await store.update(d => addGroup(d, name));
			}
		}),

		vscode.commands.registerCommand('paddock.renameGroup', async (node?: Node) => {
			if (node?.kind !== 'group') {
				return;
			}
			const name = (await askGroupName(groupName(node.id)))?.trim();
			if (name) {
				await store.update(d => renameGroup(d, node.id, name));
			}
		}),

		vscode.commands.registerCommand('paddock.deleteGroup', async (node?: Node) => {
			if (node?.kind !== 'group') {
				return;
			}
			await store.update(d => deleteGroup(d, node.id));
		}),

		vscode.commands.registerCommand('paddock.moveToGroup', async (node?: Node, selected?: Node[]) => {
			const ids = targets(node, selected, 'project').map(n => n.id);
			if (!ids.length) {
				return;
			}
			const current = new Set(store.snapshot.projects.filter(p => ids.includes(p.id)).map(p => p.groupId));
			const choice = await vscode.window.showQuickPick(
				sortedGroups(store.snapshot).map(g => ({
					label: g.id === UNGROUPED_ID ? 'No group' : g.name,
					description: current.size === 1 && current.has(g.id) ? 'current' : undefined,
					id: g.id,
				})),
				{ placeHolder: 'Move to group' },
			);
			if (choice) {
				await store.update(d => moveProjects(d, ids, choice.id));
			}
		}),
	];
}

