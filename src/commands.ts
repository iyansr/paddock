import * as path from 'node:path';
import * as vscode from 'vscode';
import { checkoutName, type Checkout } from './checkouts';
import { AGENT_NAME } from './herdr/names';
import type { PaneInfo } from './herdr/parse';
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

	/** The checkout a worktree row, project row or session stands for. */
	const checkoutOfNode = (node?: Node): Checkout | undefined => {
		switch (node?.kind) {
			case 'worktree':
				return sessions.checkout(node.projectId, node.id);
			case 'project':
				return sessions.checkout(node.id);
			case 'session': {
				const session = sessions.findSession(node.id);
				return (session && sessions.checkoutOfWorkspace(session.workspaceId)) ?? sessions.checkout(node.projectId, node.worktree);
			}
			default:
				return undefined;
		}
	};

	/** The project a command applies to: the clicked one, else the open one, else ask. */
	const pickProject = async (node?: Node, placeHolder = 'Project') => {
		const direct = checkoutOfNode(node)?.project ?? sessions.currentProject();
		if (direct) {
			return direct;
		}
		const choice = await vscode.window.showQuickPick(
			store.snapshot.projects.map(p => ({ label: p.name, description: p.path, id: p.id })),
			{ placeHolder },
		);
		return choice && store.snapshot.projects.find(p => p.id === choice.id);
	};

	/** The checkout a new session goes in: the clicked one, else the open one, else a project's own folder. */
	const pickCheckout = async (node?: Node): Promise<Checkout | undefined> => {
		const direct = checkoutOfNode(node) ?? sessions.currentCheckout();
		if (direct) {
			return direct;
		}
		const project = await pickProject(undefined, 'Project for the new session');
		return project && { project };
	};

	/** Asks for a preset and starts it in the checkout, switching there when it is not open. */
	const startSession = async (checkout: Checkout, pane?: PaneInfo) => {
		const preset = await vscode.window.showQuickPick(
			PRESETS.map(p => ({ label: p.label, preset: p })),
			{ placeHolder: `New session in ${checkoutName(checkout)}` },
		);
		if (!preset) {
			return;
		}
		const here = sessions.isCurrent(checkout);
		const started = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: `Starting ${preset.label}…` },
			() => sessions.start(checkout, preset.preset, { open: here, pane }),
		);
		if (started && !here) {
			await sessions.switchTo(checkout, started);
		}
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
			if (added) {
				void sessions.refreshWorktrees();
			}
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
				await sessions.switchTo({ project });
			}
		})),

		vscode.commands.registerCommand('paddock.openWorktree', guarded(async (node?: Node) => {
			const checkout = node?.kind === 'worktree' ? checkoutOfNode(node) : undefined;
			if (checkout && !sessions.isCurrent(checkout)) {
				await sessions.switchTo(checkout);
			}
		})),

		vscode.commands.registerCommand('paddock.newSession', guarded(async (node?: Node) => {
			const checkout = await pickCheckout(node);
			if (checkout) {
				await startSession(checkout);
			}
		})),

		vscode.commands.registerCommand('paddock.newWorktree', guarded(async (node?: Node) => {
			const project = await pickProject(node, 'Project for the new worktree');
			if (!project) {
				return;
			}
			const branch = (await vscode.window.showInputBox({
				title: `New worktree of ${project.name}`,
				prompt: 'Branch name. An existing branch is checked out; any other name creates a new branch.',
				placeHolder: 'feat/pricing-page',
				validateInput: v => (v.trim() && !/\s/.test(v.trim()) ? undefined : 'Enter a branch name without spaces'),
			}))?.trim();
			if (!branch) {
				return;
			}
			const { checkout, rootPane } = await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: `Creating worktree ${branch}…` },
				() => sessions.createWorktree(project, branch),
			);
			// herdr opens the worktree with a shell; the first session takes over that pane.
			await startSession(checkout, rootPane);
		})),

		vscode.commands.registerCommand('paddock.removeWorktree', guarded(async (node?: Node) => {
			const checkout = node?.kind === 'worktree' ? checkoutOfNode(node) : undefined;
			if (!checkout?.worktree) {
				return;
			}
			const name = checkoutName(checkout);
			const running = sessions.sessionsIn(checkout).length;
			const answer = await vscode.window.showWarningMessage(
				`Remove worktree ${name}?`,
				{
					modal: true,
					detail: `Deletes the checkout at ${checkout.worktree.path}${running ? ` and stops its ${running} session${running > 1 ? 's' : ''}` : ''}. The branch is kept.`,
				},
				'Remove',
			);
			if (answer !== 'Remove') {
				return;
			}
			const confirmForce = async () =>
				(await vscode.window.showWarningMessage(
					`${name} has uncommitted or untracked changes.`,
					{ modal: true, detail: 'Removing it anyway deletes those changes. The branch and its commits are kept.' },
					'Remove Anyway',
				)) === 'Remove Anyway';
			await sessions.removeWorktree(checkout, confirmForce);
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
			const checkout = checkoutOfNode(node);
			if (!session || !checkout) {
				return;
			}
			const answer = await vscode.window.showWarningMessage(
				`Restart "${session.name}"?`,
				{ modal: true, detail: 'The agent process is stopped and a fresh one starts in the same project. Its conversation is not carried over.' },
				'Restart',
			);
			if (answer === 'Restart') {
				await sessions.restart(session, checkout);
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

