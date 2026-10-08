import { randomUUID } from 'node:crypto';

export const UNGROUPED_ID = 'ungrouped';
const STATE_KEY = 'paddock.data';

export interface Group {
	id: string;
	name: string;
	order: number;
	collapsed: boolean;
}

export interface Project {
	id: string;
	name: string;
	path: string;
	groupId: string;
	order: number;
	/** herdr workspace of the main checkout; set in M1. */
	workspaceId?: string;
}

export interface PaddockData {
	groups: Group[];
	projects: Project[];
}

/** The slice of `vscode.Memento` the store needs. */
export interface Memento {
	get<T>(key: string): T | undefined;
	update(key: string, value: unknown): PromiseLike<void>;
}

// --- pure operations -------------------------------------------------------
// Each returns a new PaddockData and never mutates its input.

export function emptyData(): PaddockData {
	return { groups: [{ id: UNGROUPED_ID, name: 'Ungrouped', order: 0, collapsed: false }], projects: [] };
}

/** Repairs stored data: guarantees the Ungrouped group and re-homes orphaned projects. */
export function normalize(raw: PaddockData | undefined): PaddockData {
	const groups = [...(raw?.groups ?? [])];
	if (!groups.some(g => g.id === UNGROUPED_ID)) {
		groups.push({ id: UNGROUPED_ID, name: 'Ungrouped', order: groups.length, collapsed: false });
	}
	const ids = new Set(groups.map(g => g.id));
	const projects = (raw?.projects ?? []).map(p => (ids.has(p.groupId) ? p : { ...p, groupId: UNGROUPED_ID }));
	return renumber({ groups, projects });
}

export function sortedGroups(data: PaddockData): Group[] {
	return [...data.groups].sort((a, b) => a.order - b.order);
}

export function projectsOf(data: PaddockData, groupId: string): Project[] {
	return data.projects.filter(p => p.groupId === groupId).sort((a, b) => a.order - b.order);
}

/** Rewrites `order` as 0..n-1 within the groups and within each group's projects. */
function renumber(data: PaddockData): PaddockData {
	const groups = sortedGroups(data).map((g, order) => ({ ...g, order }));
	const projects = groups.flatMap(g => projectsOf(data, g.id).map((p, order) => ({ ...p, order })));
	return { groups, projects };
}

export function addProject(data: PaddockData, project: { name: string; path: string; groupId?: string }, id = randomUUID()): PaddockData {
	if (data.projects.some(p => p.path === project.path)) {
		return data;
	}
	const groupId = data.groups.some(g => g.id === project.groupId) ? project.groupId! : UNGROUPED_ID;
	const order = projectsOf(data, groupId).length;
	return { ...data, projects: [...data.projects, { id, name: project.name, path: project.path, groupId, order }] };
}

export function removeProject(data: PaddockData, projectId: string): PaddockData {
	return renumber({ ...data, projects: data.projects.filter(p => p.id !== projectId) });
}

export function addGroup(data: PaddockData, name: string, id = randomUUID()): PaddockData {
	return { ...data, groups: [...data.groups, { id, name, order: data.groups.length, collapsed: false }] };
}

export function renameGroup(data: PaddockData, groupId: string, name: string): PaddockData {
	if (groupId === UNGROUPED_ID) {
		return data;
	}
	return { ...data, groups: data.groups.map(g => (g.id === groupId ? { ...g, name } : g)) };
}

/** Deleting a group moves its projects to the end of Ungrouped. */
export function deleteGroup(data: PaddockData, groupId: string): PaddockData {
	if (groupId === UNGROUPED_ID) {
		return data;
	}
	const moved = projectsOf(data, groupId).map(p => p.id);
	const remaining = { ...data, groups: data.groups.filter(g => g.id !== groupId) };
	return moveProjects(remaining, moved, UNGROUPED_ID);
}

export function setWorkspaceId(data: PaddockData, projectId: string, workspaceId: string): PaddockData {
	return { ...data, projects: data.projects.map(p => (p.id === projectId ? { ...p, workspaceId } : p)) };
}

export function setCollapsed(data: PaddockData, groupId: string, collapsed: boolean): PaddockData {
	return { ...data, groups: data.groups.map(g => (g.id === groupId ? { ...g, collapsed } : g)) };
}

/**
 * Moves projects into `groupId`. With `beforeProjectId` they land just before that
 * project; otherwise at the end of the group. Moved projects keep their relative order.
 */
export function moveProjects(data: PaddockData, projectIds: string[], groupId: string, beforeProjectId?: string): PaddockData {
	const moving = new Set(projectIds);
	if (!data.groups.some(g => g.id === groupId) || (beforeProjectId && moving.has(beforeProjectId))) {
		return data;
	}
	const moved = data.projects
		.filter(p => moving.has(p.id))
		.sort(byGroupThenOrder(data))
		.map(p => ({ ...p, groupId }));
	const staying = data.projects.filter(p => !moving.has(p.id));
	const target = staying.filter(p => p.groupId === groupId).sort((a, b) => a.order - b.order);
	const at = beforeProjectId ? target.findIndex(p => p.id === beforeProjectId) : -1;
	const inserted = at === -1 ? [...target, ...moved] : [...target.slice(0, at), ...moved, ...target.slice(at)];
	const rest = staying.filter(p => p.groupId !== groupId);
	return renumber({ ...data, projects: [...rest, ...inserted.map((p, order) => ({ ...p, order }))] });
}

/** Moves groups before `beforeGroupId`, or to the end when it is omitted. */
export function moveGroups(data: PaddockData, groupIds: string[], beforeGroupId?: string): PaddockData {
	const moving = new Set(groupIds);
	if (beforeGroupId && moving.has(beforeGroupId)) {
		return data;
	}
	const ordered = sortedGroups(data);
	const moved = ordered.filter(g => moving.has(g.id));
	const staying = ordered.filter(g => !moving.has(g.id));
	const at = beforeGroupId ? staying.findIndex(g => g.id === beforeGroupId) : -1;
	const groups = at === -1 ? [...staying, ...moved] : [...staying.slice(0, at), ...moved, ...staying.slice(at)];
	return renumber({ ...data, groups: groups.map((g, order) => ({ ...g, order })) });
}

function byGroupThenOrder(data: PaddockData) {
	const groupOrder = new Map(data.groups.map(g => [g.id, g.order]));
	return (a: Project, b: Project) => (groupOrder.get(a.groupId) ?? 0) - (groupOrder.get(b.groupId) ?? 0) || a.order - b.order;
}

// --- persistence -----------------------------------------------------------

/** Groups and projects in `globalState`, so every window sees the same list. */
export class Store {
	private data: PaddockData;
	private readonly listeners = new Set<() => void>();

	constructor(private readonly memento: Memento) {
		this.data = normalize(memento.get<PaddockData>(STATE_KEY));
	}

	get snapshot(): PaddockData {
		return this.data;
	}

	onDidChange(listener: () => void): { dispose(): void } {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	}

	/** Re-reads globalState, for changes made by another window. */
	reload(): void {
		this.data = normalize(this.memento.get<PaddockData>(STATE_KEY));
		this.emit();
	}

	async update(op: (data: PaddockData) => PaddockData): Promise<void> {
		const next = op(this.data);
		if (next === this.data) {
			return;
		}
		this.data = next;
		this.emit();
		await this.memento.update(STATE_KEY, next);
	}

	private emit(): void {
		this.listeners.forEach(l => l());
	}
}
