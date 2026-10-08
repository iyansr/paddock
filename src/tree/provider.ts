import * as os from 'node:os';
import * as vscode from 'vscode';
import { branchName, type Checkout } from '../checkouts';
import type { SessionState } from '../herdr/status';
import type { Sessions } from '../sessions';
import { projectsOf, sortedGroups, Store, UNGROUPED_ID } from '../store';

export type Node =
	| { kind: 'group'; id: string }
	| { kind: 'project'; id: string }
	/** `id` is the checkout path; the main checkout is listed too. */
	| { kind: 'worktree'; id: string; projectId: string }
	/** `id` is the herdr pane id; `worktree` is the parent worktree row's id, if the project lists worktrees. */
	| { kind: 'session'; id: string; projectId: string; worktree?: string }
	| { kind: 'add'; id: 'add' | 'addGroup' };

const ADD_NODE: Node = { kind: 'add', id: 'add' };
const ADD_GROUP_NODE: Node = { kind: 'add', id: 'addGroup' };

function stateIcon(state: SessionState | undefined): vscode.ThemeIcon {
	switch (state) {
		case 'waiting':
			return new vscode.ThemeIcon('bell-dot', new vscode.ThemeColor('notificationsWarningIcon.foreground'));
		case 'done':
			return new vscode.ThemeIcon('check', new vscode.ThemeColor('testing.iconPassed'));
		default:
			return new vscode.ThemeIcon('sync~spin');
	}
}

export const TREE_VIEW_ID = 'paddock.projects';

export class ProjectsProvider implements vscode.TreeDataProvider<Node> {
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this.changed.event;

	constructor(private readonly store: Store, private readonly sessions: Sessions) {
		store.onDidChange(() => this.changed.fire());
		sessions.onDidChange(() => this.changed.fire());
	}

	getChildren(node?: Node): Node[] {
		const data = this.store.snapshot;
		if (!node) {
			// Ungrouped projects sit at the top level, after the named groups.
			const groups = sortedGroups(data).filter(g => g.id !== UNGROUPED_ID);
			return [
				...groups.map((g): Node => ({ kind: 'group', id: g.id })),
				...projectsOf(data, UNGROUPED_ID).map((p): Node => ({ kind: 'project', id: p.id })),
				ADD_NODE,
				ADD_GROUP_NODE,
			];
		}
		if (node.kind === 'group') {
			return projectsOf(data, node.id).map((p): Node => ({ kind: 'project', id: p.id }));
		}
		if (node.kind === 'worktree') {
			const checkout = this.checkoutOfRow(node);
			return checkout ? this.sessionNodes(checkout, node.id) : [];
		}
		const project = node.kind === 'project' ? data.projects.find(p => p.id === node.id) : undefined;
		if (!project) {
			return [];
		}
		// A git repository lists its checkouts, each with its sessions; any other folder lists sessions directly.
		const worktrees = this.sessions.worktreesOf(project);
		return worktrees.length
			? worktrees.map((w): Node => ({ kind: 'worktree', id: w.path, projectId: project.id }))
			: this.sessionNodes({ project });
	}

	private sessionNodes(checkout: Checkout, worktree?: string): Node[] {
		return this.sessions
			.sessionsIn(checkout)
			.map((s): Node => ({ kind: 'session', id: s.paneId, projectId: checkout.project.id, worktree }));
	}

	/** The checkout a worktree row stands for; the main checkout's row is the project itself. */
	private checkoutOfRow(node: { id: string; projectId: string }): Checkout | undefined {
		return this.sessions.checkout(node.projectId, node.id);
	}

	getParent(node: Node): Node | undefined {
		if (node.kind === 'session') {
			return node.worktree
				? { kind: 'worktree', id: node.worktree, projectId: node.projectId }
				: { kind: 'project', id: node.projectId };
		}
		if (node.kind === 'worktree') {
			return { kind: 'project', id: node.projectId };
		}
		if (node.kind !== 'project') {
			return undefined;
		}
		const project = this.store.snapshot.projects.find(p => p.id === node.id);
		return project && project.groupId !== UNGROUPED_ID ? { kind: 'group', id: project.groupId } : undefined;
	}

	getTreeItem(node: Node): vscode.TreeItem {
		const data = this.store.snapshot;
		if (node.kind === 'add' && node.id === 'addGroup') {
			const item = new vscode.TreeItem('Add group', vscode.TreeItemCollapsibleState.None);
			item.id = 'addGroup';
			item.iconPath = new vscode.ThemeIcon('new-folder');
			item.command = { command: 'paddock.newGroup', title: 'New Group' };
			return item;
		}
		if (node.kind === 'add') {
			const item = new vscode.TreeItem('Add project', vscode.TreeItemCollapsibleState.None);
			item.id = 'add';
			item.iconPath = new vscode.ThemeIcon('add');
			item.command = { command: 'paddock.addProject', title: 'Add Project' };
			return item;
		}
		if (node.kind === 'group') {
			const group = data.groups.find(g => g.id === node.id);
			const item = new vscode.TreeItem(
				group?.name ?? node.id,
				group?.collapsed ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded,
			);
			item.id = `group:${node.id}`;
			item.contextValue = 'group';
			const waiting = this.sessions.waitingByProject();
			const count = projectsOf(data, node.id).reduce((n, p) => n + (waiting.get(p.id) ?? 0), 0);
			item.description = count > 0 ? `${count} waiting` : undefined;
			return item;
		}
		if (node.kind === 'worktree') {
			return this.worktreeItem(node);
		}
		if (node.kind === 'session') {
			const session = this.sessions.findSession(node.id);
			const item = new vscode.TreeItem(session?.name ?? node.id, vscode.TreeItemCollapsibleState.None);
			item.id = `session:${node.projectId}:${node.id}`;
			item.contextValue = 'session';
			// A plain shell has no agent state to show.
			item.iconPath = session?.kind ? stateIcon(session.status) : new vscode.ThemeIcon('terminal');
			item.description = session?.kind ? session.status : undefined;
			item.command = { command: 'paddock.openSession', title: 'Open Session', arguments: [node] };
			return item;
		}
		const project = data.projects.find(p => p.id === node.id);
		const hasChildren = project ? this.getChildren(node).length > 0 : false;
		const item = new vscode.TreeItem(
			project?.name ?? node.id,
			hasChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
		);
		item.id = `project:${node.id}`;
		item.contextValue = 'project';
		const isOpen = this.sessions.currentProject()?.id === node.id;
		item.iconPath = new vscode.ThemeIcon(isOpen ? 'folder-opened' : 'folder');
		if (!isOpen) {
			item.command = { command: 'paddock.openProject', title: 'Open Project', arguments: [node] };
		}
		const waiting = this.sessions.waitingByProject().get(node.id) ?? 0;
		if (project) {
			const home = os.homedir();
			const shown = project.path.startsWith(home) ? `~${project.path.slice(home.length)}` : project.path;
			item.description = waiting > 0 ? `${waiting} waiting · ${shown}` : shown;
			item.tooltip = project.path;
			item.resourceUri = vscode.Uri.file(project.path);
		}
		return item;
	}

	private worktreeItem(node: { id: string; projectId: string }): vscode.TreeItem {
		const project = this.store.snapshot.projects.find(p => p.id === node.projectId);
		const worktree = project && this.sessions.worktreesOf(project).find(w => w.path === node.id);
		const checkout = this.checkoutOfRow(node);
		const sessions = checkout ? this.sessions.sessionsIn(checkout) : [];
		const item = new vscode.TreeItem(
			worktree ? branchName(worktree) : node.id,
			sessions.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None,
		);
		item.id = `worktree:${node.projectId}:${node.id}`;
		// Only a linked worktree can be removed; the main checkout is the project itself.
		item.contextValue = worktree?.linked ? 'worktree' : 'mainWorktree';
		const isOpen = !!checkout && this.sessions.isCurrent(checkout);
		item.iconPath = new vscode.ThemeIcon('git-branch', isOpen ? new vscode.ThemeColor('list.highlightForeground') : undefined);
		const waiting = sessions.filter(s => s.status === 'waiting').length;
		item.description = [waiting > 0 ? `${waiting} waiting` : undefined, isOpen ? 'open' : undefined].filter(Boolean).join(' · ') || undefined;
		item.tooltip = node.id;
		if (!isOpen && checkout) {
			item.command = { command: 'paddock.openWorktree', title: 'Open Worktree', arguments: [node] };
		}
		return item;
	}
}
