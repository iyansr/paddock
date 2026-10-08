import * as os from 'node:os';
import * as vscode from 'vscode';
import type { Sessions } from '../sessions';
import { projectsOf, sortedGroups, Store, UNGROUPED_ID } from '../store';

export type Node =
	| { kind: 'group'; id: string }
	| { kind: 'project'; id: string }
	/** `id` is the herdr pane id. */
	| { kind: 'session'; id: string; projectId: string }
	| { kind: 'add'; id: 'add' };

const ADD_NODE: Node = { kind: 'add', id: 'add' };

export const TREE_VIEW_ID = 'paddock.projects';

export class ProjectsProvider implements vscode.TreeDataProvider<Node> {
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this.changed.event;
	/** Sessions waiting on me per project id; filled by status polling in M2. */
	private waiting = new Map<string, number>();

	constructor(private readonly store: Store, private readonly sessions: Sessions) {
		store.onDidChange(() => this.changed.fire());
		sessions.onDidChange(() => this.changed.fire());
	}

	setWaiting(counts: Map<string, number>): void {
		this.waiting = counts;
		this.changed.fire();
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
			];
		}
		if (node.kind === 'group') {
			return projectsOf(data, node.id).map((p): Node => ({ kind: 'project', id: p.id }));
		}
		const project = node.kind === 'project' ? data.projects.find(p => p.id === node.id) : undefined;
		return project
			? this.sessions.sessionsOf(project).map((s): Node => ({ kind: 'session', id: s.paneId, projectId: project.id }))
			: [];
	}

	getParent(node: Node): Node | undefined {
		if (node.kind === 'session') {
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
			const count = projectsOf(data, node.id).reduce((n, p) => n + (this.waiting.get(p.id) ?? 0), 0);
			item.description = count > 0 ? `${count} waiting` : undefined;
			return item;
		}
		if (node.kind === 'session') {
			const session = this.sessions.findSession(node.id);
			const item = new vscode.TreeItem(session?.name ?? node.id, vscode.TreeItemCollapsibleState.None);
			item.id = `session:${node.id}`;
			item.contextValue = 'session';
			item.iconPath = new vscode.ThemeIcon(session?.open ? 'terminal-view-icon' : 'terminal');
			item.description = session?.status;
			item.command = { command: 'paddock.openSession', title: 'Open Session', arguments: [node] };
			return item;
		}
		const project = data.projects.find(p => p.id === node.id);
		const hasSessions = project ? this.sessions.sessionsOf(project).length > 0 : false;
		const item = new vscode.TreeItem(
			project?.name ?? node.id,
			hasSessions ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
		);
		item.id = `project:${node.id}`;
		item.contextValue = 'project';
		const isOpen = this.sessions.currentProject()?.id === node.id;
		item.iconPath = new vscode.ThemeIcon(isOpen ? 'folder-opened' : 'folder');
		if (!isOpen) {
			item.command = { command: 'paddock.openProject', title: 'Open Project', arguments: [node] };
		}
		if (project) {
			const home = os.homedir();
			item.description = project.path.startsWith(home) ? `~${project.path.slice(home.length)}` : project.path;
			item.tooltip = project.path;
			item.resourceUri = vscode.Uri.file(project.path);
		}
		return item;
	}
}
