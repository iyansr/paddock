import { describe, expect, it } from 'vitest';

import { checkoutAt, checkoutKey, checkoutName, checkoutOf, checkoutPath, type Worktrees } from '../../src/checkouts';
import type { Project } from '../../src/store';

const project = (id: string, path: string): Project => ({ id, name: id, path, groupId: 'ungrouped', order: 0 });
const projects = [project('app', '/code/app'), project('docs', '/code/docs')];
const feat = { path: '/home/.herdr/worktrees/app/feat', branch: 'feat/x', linked: true };
const worktrees: Worktrees = {
  app: [{ path: '/code/app', branch: 'main', linked: false, openWorkspaceId: 'w1' }, feat],
  docs: [],
};

describe('checkouts', () => {
  it('finds a project folder', () => {
    expect(checkoutAt(projects, worktrees, '/code/docs/')).toEqual({ project: projects[1] });
  });
  it('finds a linked worktree and its project', () => {
    expect(checkoutAt(projects, worktrees, feat.path)).toEqual({ project: projects[0], worktree: feat });
  });
  it('does not treat the main checkout entry as a worktree', () => {
    expect(checkoutAt(projects, worktrees, '/code/app')?.worktree).toBeUndefined();
  });
  it('knows nothing of other folders', () => {
    expect(checkoutAt(projects, worktrees, '/elsewhere')).toBeUndefined();
  });
  it('keys the main checkout by project id, so layouts saved before worktrees still apply', () => {
    expect(checkoutKey({ project: projects[0] })).toBe('app');
    expect(checkoutKey({ project: projects[0], worktree: feat })).toBe(`app:${feat.path}`);
  });
  it('names and locates checkouts', () => {
    expect(checkoutName({ project: projects[0], worktree: feat })).toBe('app (feat/x)');
    expect(checkoutPath({ project: projects[0], worktree: feat })).toBe(feat.path);
    expect(checkoutPath({ project: projects[0] })).toBe('/code/app');
  });
  it('resolves tree rows, with the main row as the project', () => {
    expect(checkoutOf(projects, worktrees, 'app', '/code/app')).toEqual({ project: projects[0], worktree: undefined });
    expect(checkoutOf(projects, worktrees, 'app', feat.path)?.worktree).toBe(feat);
    expect(checkoutOf(projects, worktrees, 'gone')).toBeUndefined();
  });
});
