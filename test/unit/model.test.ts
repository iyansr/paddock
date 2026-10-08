import { describe, expect, it } from 'vitest';

import { checkoutKey, type Checkout } from '../../src/checkouts';
import type { WorktreeInfo } from '../../src/herdr/parse';
import type { SessionState } from '../../src/herdr/status';
import type { PaddockData } from '../../src/store';
import { buildModel, parseMessage, rollup, tildePath, type SessionSource } from '../../src/tree/model';

const data: PaddockData = {
  groups: [
    { id: 'ungrouped', name: 'Ungrouped', order: 1, collapsed: false },
    { id: 'g1', name: 'Personal', order: 0, collapsed: true },
  ],
  projects: [
    { id: 'app', name: 'app', path: '/home/me/code/app', groupId: 'g1', order: 0 },
    { id: 'notes', name: 'notes', path: '/home/me/notes', groupId: 'ungrouped', order: 0 },
  ],
};
const main: WorktreeInfo = { path: '/home/me/code/app', branch: 'main', linked: false };
const feat: WorktreeInfo = { path: '/wt/app/feat', branch: 'feat/x', linked: true };
const session = (paneId: string, status: SessionState, kind = 'claude'): SessionSource => ({
  paneId,
  name: paneId,
  kind,
  status,
  open: false,
});

const sessions: Record<string, SessionSource[]> = {
  app: [session('p1', 'done')],
  [`app:${feat.path}`]: [session('p2', 'waiting'), session('p3', 'running')],
  notes: [{ ...session('p4', 'running'), kind: undefined }],
};

const model = (current?: Checkout) =>
  buildModel({
    data,
    worktreesOf: p => (p.id === 'app' ? [main, feat] : []),
    sessionsIn: c => sessions[checkoutKey(c)] ?? [],
    current,
    home: '/home/me',
  });

describe('sidebar model', () => {
  it('lists named groups, then ungrouped projects', () => {
    const m = model();
    expect(m.groups.map(g => g.name)).toEqual(['Personal']);
    expect(m.groups[0].collapsed).toBe(true);
    expect(m.projects.map(p => p.name)).toEqual(['notes']);
  });

  it('lists checkouts of a git project, main first, with their sessions and state', () => {
    const app = model().groups[0].projects[0];
    expect(app.checkouts.map(c => [c.label, c.branch, c.primary, c.state, c.sessions.length])).toEqual([
      ['app', 'main', true, 'done', 1],
      ['feat', 'feat/x', false, 'waiting', 2],
    ]);
    expect(app.checkouts[1].sessions[0].node).toEqual({
      kind: 'session',
      id: 'p2',
      projectId: 'app',
      worktree: feat.path,
    });
    expect(app.sessions).toEqual([]);
    expect(app.shownPath).toBe('~/code/app');
  });

  it('counts waiting sessions on projects and groups', () => {
    const m = model();
    expect(m.groups[0].projects[0]).toMatchObject({ waiting: 1, done: 1 });
    expect(m.groups[0].waiting).toBe(1);
  });

  it('lists sessions of a folder that is not a repository straight under it', () => {
    const notes = model().projects[0];
    expect(notes.checkouts).toEqual([]);
    expect(notes.sessions.map(s => [s.node.id, s.kind])).toEqual([['p4', undefined]]);
  });

  it('shows a shell as idle, so it never spins or counts', () => {
    const notes = model().projects[0];
    expect(notes.sessions[0].state).toBe('idle');
    expect(notes).toMatchObject({ waiting: 0, done: 0 });
  });

  it('marks the open checkout and its project', () => {
    const app = data.projects[0];
    const m = model({ project: app, worktree: feat });
    expect(m.groups[0].projects[0].current).toBe(true);
    expect(m.groups[0].projects[0].checkouts.map(c => c.current)).toEqual([false, true]);
    expect(m.projects[0].current).toBe(false);
  });
});

describe('rollup and paths', () => {
  it('picks the most urgent state', () => {
    expect(rollup([])).toBe('idle');
    expect(rollup(['done', 'running'])).toBe('running');
    expect(rollup(['running', 'waiting', 'done'])).toBe('waiting');
  });
  it('shortens paths under home only', () => {
    expect(tildePath('/home/me/x', '/home/me')).toBe('~/x');
    expect(tildePath('/home/meow/x', '/home/me')).toBe('/home/meow/x');
  });
});

describe('webview messages', () => {
  it('accepts well-formed messages', () => {
    expect(parseMessage({ type: 'ready' })).toEqual({ type: 'ready' });
    expect(
      parseMessage({
        type: 'command',
        command: 'paddock.openSession',
        node: { kind: 'session', id: 'p1', projectId: 'app', extra: 1 },
      }),
    ).toEqual({
      type: 'command',
      command: 'paddock.openSession',
      node: { kind: 'session', id: 'p1', projectId: 'app', worktree: undefined },
    });
    expect(parseMessage({ type: 'moveProjects', ids: ['a'], groupId: 'g1' })).toEqual({
      type: 'moveProjects',
      ids: ['a'],
      groupId: 'g1',
      before: undefined,
    });
    expect(parseMessage({ type: 'collapse', groupId: 'g1', collapsed: true })).toEqual({
      type: 'collapse',
      groupId: 'g1',
      collapsed: true,
    });
  });
  it('drops anything else', () => {
    expect(parseMessage(null)).toBeUndefined();
    expect(parseMessage({ type: 'command', command: 'workbench.action.quit' })).toBeUndefined();
    expect(
      parseMessage({ type: 'command', command: 'paddock.openSession', node: { kind: 'session', id: 'p1' } }),
    ).toBeUndefined();
    expect(parseMessage({ type: 'moveGroups', ids: [1] })).toBeUndefined();
    expect(parseMessage({ type: 'collapse', groupId: 'g1' })).toBeUndefined();
  });
});
