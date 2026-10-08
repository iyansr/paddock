// A checkout is a project's main folder or one of its linked git worktrees. Pure; no VS Code.

import * as path from 'node:path';

import type { WorktreeInfo } from './herdr/parse';
import type { Project } from './store';

export interface Checkout {
	project: Project;
	/** A linked worktree; unset for the project's own folder. */
	worktree?: WorktreeInfo;
}

/** Checkouts of each project from `herdr worktree list`, keyed by project id. Empty for a folder that is not a git repository. */
export type Worktrees = Record<string, WorktreeInfo[]>;

export const WORKTREES_KEY = 'paddock.worktrees';

export function samePath(a: string, b: string): boolean {
	return path.resolve(a) === path.resolve(b);
}

/** Key for per-checkout state (layouts, open files). The main checkout keeps the bare project id. */
export function checkoutKey(c: Checkout): string {
	return c.worktree ? `${c.project.id}:${c.worktree.path}` : c.project.id;
}

export function checkoutPath(c: Checkout): string {
	return c.worktree?.path ?? c.project.path;
}

export function checkoutName(c: Checkout): string {
	return c.worktree ? `${c.project.name} (${branchName(c.worktree)})` : c.project.name;
}

export function branchName(w: WorktreeInfo): string {
	return w.branch ?? `${path.basename(w.path)} (detached)`;
}

/** Linked worktrees of a project, in herdr's order. */
export function linkedOf(worktrees: Worktrees, projectId: string): WorktreeInfo[] {
	return (worktrees[projectId] ?? []).filter(w => w.linked);
}

/** The checkout whose folder is `folder`: a project's own folder first, then a linked worktree. */
export function checkoutAt(projects: Project[], worktrees: Worktrees, folder: string): Checkout | undefined {
	const project = projects.find(p => samePath(p.path, folder));
	if (project) {
		return { project };
	}
	for (const p of projects) {
		const worktree = linkedOf(worktrees, p.id).find(w => samePath(w.path, folder));
		if (worktree) {
			return { project: p, worktree };
		}
	}
	return undefined;
}

/** The checkout for a tree node: a linked worktree when `worktreePath` names one, else the project's own folder. */
export function checkoutOf(projects: Project[], worktrees: Worktrees, projectId: string, worktreePath?: string): Checkout | undefined {
	const project = projects.find(p => p.id === projectId);
	if (!project) {
		return undefined;
	}
	const worktree = worktreePath ? linkedOf(worktrees, projectId).find(w => samePath(w.path, worktreePath)) : undefined;
	return { project, worktree };
}
