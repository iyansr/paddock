// What the sidebar shows, as plain data for the webview. Pure: no VS Code.

import * as path from 'node:path';
import { branchName, checkoutKey, type Checkout } from '../checkouts';
import type { WorktreeInfo } from '../herdr/parse';
import type { SessionState } from '../herdr/status';
import { projectsOf, sortedGroups, UNGROUPED_ID, type PaddockData, type Project } from '../store';

/** What a sidebar row stands for; passed as the argument of every row command. */
export type Node =
	| { kind: 'group'; id: string }
	| { kind: 'project'; id: string }
	/** `id` is the checkout path; the main checkout is listed too. */
	| { kind: 'worktree'; id: string; projectId: string }
	/** `id` is the herdr pane id; `worktree` is the parent worktree row's id, if the project lists worktrees. */
	| { kind: 'session'; id: string; projectId: string; worktree?: string };

export const VIEW_ID = 'paddock.projects';

/** A checkout's state is that of its most urgent session; `idle` when it has none. */
export type RowState = SessionState | 'idle';

export interface SessionRow {
	node: Node;
	name: string;
	/** herdr agent kind; undefined for a plain shell. */
	kind?: string;
	/** `idle` for a plain shell, which has no agent state to show. */
	state: RowState;
	/** Open as a terminal in this window. */
	open: boolean;
}

export interface CheckoutRow {
	node: Node;
	/** The project's name for the main checkout, the folder name for a linked worktree. */
	label: string;
	/** Branch name, or the folder name of a detached checkout. */
	branch: string;
	/** The repository's main checkout. */
	primary: boolean;
	shownPath: string;
	current: boolean;
	state: RowState;
	sessions: SessionRow[];
}

export interface ProjectRow {
	node: Node;
	groupId: string;
	name: string;
	path: string;
	shownPath: string;
	/** The open checkout belongs to this project. */
	current: boolean;
	waiting: number;
	done: number;
	/** Checkouts of a git repository, main first; empty for any other folder. */
	checkouts: CheckoutRow[];
	/** Sessions of a folder that is not a git repository. */
	sessions: SessionRow[];
}

export interface GroupRow {
	node: Node;
	name: string;
	collapsed: boolean;
	waiting: number;
	projects: ProjectRow[];
}

export interface ViewModel {
	groups: GroupRow[];
	/** Projects outside any group, listed after the groups. */
	projects: ProjectRow[];
}

/** The session fields the sidebar needs. */
export interface SessionSource {
	paneId: string;
	name: string;
	kind?: string;
	status: SessionState;
	open: boolean;
}

export interface ModelSource {
	data: PaddockData;
	worktreesOf(project: Project): WorktreeInfo[];
	sessionsIn(checkout: Checkout): SessionSource[];
	current?: Checkout;
	home: string;
}

const URGENCY: Record<RowState, number> = { waiting: 3, running: 2, done: 1, idle: 0 };

export function rollup(states: readonly RowState[]): RowState {
	return states.reduce<RowState>((a, s) => (URGENCY[s] > URGENCY[a] ? s : a), 'idle');
}

export function tildePath(p: string, home: string): string {
	return home && (p === home || p.startsWith(`${home}/`)) ? `~${p.slice(home.length)}` : p;
}

export function buildModel(src: ModelSource): ViewModel {
	const currentKey = src.current && checkoutKey(src.current);
	const sessionRows = (checkout: Checkout, projectId: string, worktree?: string): SessionRow[] =>
		src.sessionsIn(checkout).map(s => ({
			node: { kind: 'session', id: s.paneId, projectId, worktree },
			name: s.name,
			kind: s.kind,
			// herdr reports a shell as running whatever it does, so it never drives a badge.
			state: s.kind ? s.status : 'idle',
			open: s.open,
		}));

	const projectRow = (project: Project): ProjectRow => {
		const checkouts = src.worktreesOf(project).map((w): CheckoutRow => {
			const checkout: Checkout = { project, worktree: w.linked ? w : undefined };
			const sessions = sessionRows(checkout, project.id, w.path);
			return {
				node: { kind: 'worktree', id: w.path, projectId: project.id },
				label: w.linked ? path.basename(w.path) : project.name,
				branch: branchName(w),
				primary: !w.linked,
				shownPath: tildePath(w.path, src.home),
				current: checkoutKey(checkout) === currentKey,
				state: rollup(sessions.map(s => s.state)),
				sessions,
			};
		});
		const sessions = checkouts.length ? [] : sessionRows({ project }, project.id);
		const all = [...sessions, ...checkouts.flatMap(c => c.sessions)];
		return {
			node: { kind: 'project', id: project.id },
			groupId: project.groupId,
			name: project.name,
			path: project.path,
			shownPath: tildePath(project.path, src.home),
			current: src.current?.project.id === project.id,
			waiting: all.filter(s => s.state === 'waiting').length,
			done: all.filter(s => s.state === 'done').length,
			checkouts,
			sessions,
		};
	};

	const groups = sortedGroups(src.data)
		.filter(g => g.id !== UNGROUPED_ID)
		.map((g): GroupRow => {
			const projects = projectsOf(src.data, g.id).map(projectRow);
			return {
				node: { kind: 'group', id: g.id },
				name: g.name,
				collapsed: g.collapsed,
				waiting: projects.reduce((n, p) => n + p.waiting, 0),
				projects,
			};
		});
	return { groups, projects: projectsOf(src.data, UNGROUPED_ID).map(projectRow) };
}

// --- webview messages ------------------------------------------------------

export type ToView = { type: 'model'; model: ViewModel };

export type ToHost =
	| { type: 'ready' }
	/** Runs a `paddock.` command with the row's node. */
	| { type: 'command'; command: string; node?: Node }
	| { type: 'collapse'; groupId: string; collapsed: boolean }
	/** Moves projects into a group, before `before` or to its end. */
	| { type: 'moveProjects'; ids: string[]; groupId: string; before?: string }
	/** Moves groups before `before`, or to the end. */
	| { type: 'moveGroups'; ids: string[]; before?: string };

const isString = (v: unknown): v is string => typeof v === 'string';
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every(isString);
const optString = (v: unknown): v is string | undefined => v === undefined || isString(v);

function parseNode(v: unknown): Node | undefined {
	if (typeof v !== 'object' || v === null) {
		return undefined;
	}
	const n = v as Record<string, unknown>;
	if (!isString(n.id)) {
		return undefined;
	}
	switch (n.kind) {
		case 'group':
		case 'project':
			return { kind: n.kind, id: n.id };
		case 'worktree':
			return isString(n.projectId) ? { kind: 'worktree', id: n.id, projectId: n.projectId } : undefined;
		case 'session':
			return isString(n.projectId) && optString(n.worktree)
				? { kind: 'session', id: n.id, projectId: n.projectId, worktree: n.worktree }
				: undefined;
		default:
			return undefined;
	}
}

/** Validates a message from the webview; anything malformed is dropped. */
export function parseMessage(raw: unknown): ToHost | undefined {
	if (typeof raw !== 'object' || raw === null) {
		return undefined;
	}
	const m = raw as Record<string, unknown>;
	switch (m.type) {
		case 'ready':
			return { type: 'ready' };
		case 'command': {
			if (!isString(m.command) || !m.command.startsWith('paddock.')) {
				return undefined;
			}
			const node = m.node === undefined ? undefined : parseNode(m.node);
			return m.node !== undefined && !node ? undefined : { type: 'command', command: m.command, node };
		}
		case 'collapse':
			return isString(m.groupId) && typeof m.collapsed === 'boolean'
				? { type: 'collapse', groupId: m.groupId, collapsed: m.collapsed }
				: undefined;
		case 'moveProjects':
			return isStrings(m.ids) && isString(m.groupId) && optString(m.before)
				? { type: 'moveProjects', ids: m.ids, groupId: m.groupId, before: m.before }
				: undefined;
		case 'moveGroups':
			return isStrings(m.ids) && optString(m.before) ? { type: 'moveGroups', ids: m.ids, before: m.before } : undefined;
		default:
			return undefined;
	}
}
