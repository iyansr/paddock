import * as path from 'node:path';
import * as vscode from 'vscode';
import { AGENT_NAME } from './herdr/names';
import { PRESETS } from './presets';
import type { Sessions } from './sessions';
import { addGroup, addProject, deleteGroup, moveProjects, removeProject, renameGroup, sortedGroups, Store, UNGROUPED_ID } from './store';
import { TREE_VIEW_ID, type Node } from './tree/provider';

/** Tree context-menu commands get (clicked node, all selected nodes). */
function targets(node: Node | undefined, selected: readonly Node[] | undefined, kind: Node['kind']): Node[] {
	const nodes = selected?.length ? selected : node ? [node] : [];
	return nodes.filter(n => n.kind === kind);
}

/** Shows herdr and VS Code failures to the user instead of leaving a command silently dead. */
function guarded<A extends unknown[]>(fn: (...args: A) => Promise<void>): (...args: A) => Promise<void> {
	return async (...args) => {
		try {
			await fn(...args);
		} catch (e) {
			void vscode.window.showErrorMessage(`Paddock: ${e instanceof Error ? e.message : String(e)}`);
		}
	};
}

export function registerCommands(store: Store, sessions: Sessions): vscode.Disposable[] {
	const projectOf = (node?: Node) =>
		node?.kind === 'project' ? store.snapshot.projects.find(p => p.id === node.id) : undefined;
	const sessionOf = (node?: Node) => (node?.kind === 'session' ? sessions.findSession(node.id) : undefined);

	/** The project a command applies to: the clicked one, else the open one, else ask. */
	const pickProject = async (node?: Node) => {
		const direct = projectOf(node) ?? (node?.kind === 'session' ? store.snapshot.projects.find(p => p.id === node.projectId) : undefined);
		if (direct) {
			return direct;
		}
		const current = sessions.currentProject();
		if (current) {
			return current;
		}
		const choice = await vscode.window.showQuickPick(
			store.snapshot.projects.map(p => ({ label: p.name, description: p.path, id: p.id })),
			{ placeHolder: 'Project for the new session' },
		);
		return choice && store.snapshot.projects.find(p => p.id === choice.id);
	};

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
			const before = store.snapshot.projects.length;
			for (const uri of picked ?? []) {
				await store.update(d => addProject(d, { name: path.basename(uri.fsPath), path: uri.fsPath, groupId }));
			}
			const added = store.snapshot.projects.length - before;
			if (picked?.length) {
				// The sidebar may be hidden (an empty window has none), so show where the project went.
				await vscode.commands.executeCommand(`${TREE_VIEW_ID}.focus`);
				void vscode.window.showInformationMessage(
					added ? `Added ${added} project${added > 1 ? 's' : ''} to Paddock.` : 'Already in Paddock.',
				);
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

		vscode.commands.registerCommand('paddock.openProject', guarded(async (node?: Node) => {
			const project = projectOf(node);
			if (project && sessions.currentProject()?.id !== project.id) {
				await sessions.switchTo(project);
			}
		})),

		vscode.commands.registerCommand('paddock.newSession', guarded(async (node?: Node) => {
			const project = await pickProject(node);
			if (!project) {
				return;
			}
			const preset = await vscode.window.showQuickPick(
				PRESETS.map(p => ({ label: p.label, preset: p })),
				{ placeHolder: `New session in ${project.name}` },
			);
			if (!preset) {
				return;
			}
			const here = sessions.currentProject()?.id === project.id;
			const started = await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: `Starting ${preset.label}…` },
				() => sessions.start(project, preset.preset, undefined, here),
			);
			if (started && !here) {
				await sessions.switchTo(project, started);
			}
		})),

		vscode.commands.registerCommand('paddock.openSession', guarded(async (node?: Node) => {
			const session = sessionOf(node);
			if (session) {
				await sessions.openSession(session);
			}
		})),

		vscode.commands.registerCommand('paddock.renameSession', guarded(async (node?: Node) => {
			const session = sessionOf(node);
			if (!session) {
				return;
			}
			const name = await vscode.window.showInputBox({
				prompt: 'Session name',
				value: session.name,
				validateInput: v => (session.kind && !AGENT_NAME.test(v) ? 'Use a-z, 0-9, - and _, starting with a letter (max 32)' : v.trim() ? undefined : 'Name required'),
			});
			if (name && name !== session.name) {
				await sessions.rename(session, name.trim());
			}
		})),

		vscode.commands.registerCommand('paddock.restartSession', guarded(async (node?: Node) => {
			const session = sessionOf(node);
			const project = node?.kind === 'session' ? store.snapshot.projects.find(p => p.id === node.projectId) : undefined;
			if (!session || !project) {
				return;
			}
			const answer = await vscode.window.showWarningMessage(
				`Restart "${session.name}"?`,
				{ modal: true, detail: 'The agent process is stopped and a fresh one starts in the same project. Its conversation is not carried over.' },
				'Restart',
			);
			if (answer === 'Restart') {
				await sessions.restart(session, project);
			}
		})),

		vscode.commands.registerCommand('paddock.killSession', guarded(async (node?: Node) => {
			const session = sessionOf(node);
			if (!session) {
				return;
			}
			const answer = await vscode.window.showWarningMessage(
				`Kill "${session.name}"?`,
				{ modal: true, detail: 'This stops the agent and closes its herdr pane. Closing just the terminal tab does not.' },
				'Kill',
			);
			if (answer === 'Kill') {
				await sessions.kill(session);
			}
		})),

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

