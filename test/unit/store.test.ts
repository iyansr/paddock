import { describe, expect, it } from 'vitest';

import {
  addGroup,
  addProject,
  deleteGroup,
  emptyData,
  moveGroups,
  moveProjects,
  normalize,
  projectsOf,
  removeProject,
  renameGroup,
  sortedGroups,
  Store,
  UNGROUPED_ID,
  type Memento,
  type PaddockData,
} from '../../src/store';

function build(): PaddockData {
  let d = emptyData();
  d = addGroup(d, 'Personal', 'p');
  d = addGroup(d, 'Work', 'w');
  d = addProject(d, { name: 'a', path: '/a' }, 'a');
  d = addProject(d, { name: 'b', path: '/b' }, 'b');
  d = addProject(d, { name: 'c', path: '/c' }, 'c');
  return moveProjects(d, ['a', 'b'], 'p');
}
const ids = (d: PaddockData, g: string) => projectsOf(d, g).map(p => p.id);
const groupIds = (d: PaddockData) => sortedGroups(d).map(g => g.id);

describe('projects', () => {
  it('new projects land in Ungrouped', () => {
    expect(ids(build(), UNGROUPED_ID)).toEqual(['c']);
  });
  it('adds straight into a group, falling back to Ungrouped if it is unknown', () => {
    let d = addProject(build(), { name: 'd', path: '/d', groupId: 'w' }, 'd');
    d = addProject(d, { name: 'e', path: '/e', groupId: 'nope' }, 'e');
    expect(ids(d, 'w')).toEqual(['d']);
    expect(ids(d, UNGROUPED_ID)).toEqual(['c', 'e']);
  });
  it('ignores a duplicate path', () => {
    const d = build();
    expect(addProject(d, { name: 'again', path: '/a' })).toBe(d);
  });
  it('removes and renumbers', () => {
    const d = removeProject(build(), 'a');
    expect(projectsOf(d, 'p').map(p => [p.id, p.order])).toEqual([['b', 0]]);
  });
});

describe('moveProjects', () => {
  it('drops before a project in its group', () => {
    const d = moveProjects(build(), ['c'], 'p', 'b');
    expect(ids(d, 'p')).toEqual(['a', 'c', 'b']);
    expect(ids(d, UNGROUPED_ID)).toEqual([]);
  });
  it('drops on a group at the end', () => {
    expect(ids(moveProjects(build(), ['c'], 'p'), 'p')).toEqual(['a', 'b', 'c']);
  });
  it('reorders within a group', () => {
    expect(ids(moveProjects(build(), ['b'], 'p', 'a'), 'p')).toEqual(['b', 'a']);
  });
  it('keeps relative order of several moved projects', () => {
    expect(ids(moveProjects(build(), ['b', 'a'], 'w'), 'w')).toEqual(['a', 'b']);
  });
  it('ignores a drop onto itself', () => {
    const d = build();
    expect(moveProjects(d, ['a'], 'p', 'a')).toBe(d);
  });
  it('ignores an unknown group', () => {
    const d = build();
    expect(moveProjects(d, ['a'], 'nope')).toBe(d);
  });
});

describe('groups', () => {
  it('moves a group before another', () => {
    expect(groupIds(moveGroups(build(), ['w'], 'p'))).toEqual([UNGROUPED_ID, 'w', 'p']);
  });
  it('moves a group to the end', () => {
    expect(groupIds(moveGroups(build(), [UNGROUPED_ID]))).toEqual(['p', 'w', UNGROUPED_ID]);
  });
  it('renames, but not Ungrouped', () => {
    const d = renameGroup(build(), 'p', 'Home');
    expect(d.groups.find(g => g.id === 'p')?.name).toBe('Home');
    expect(renameGroup(d, UNGROUPED_ID, 'x')).toBe(d);
  });
  it('deleting a group moves its projects to Ungrouped', () => {
    const d = deleteGroup(build(), 'p');
    expect(groupIds(d)).toEqual([UNGROUPED_ID, 'w']);
    expect(ids(d, UNGROUPED_ID)).toEqual(['c', 'a', 'b']);
  });
  it('never deletes Ungrouped', () => {
    const d = build();
    expect(deleteGroup(d, UNGROUPED_ID)).toBe(d);
  });
});

describe('normalize', () => {
  it('restores Ungrouped and re-homes orphans', () => {
    const d = normalize({ groups: [], projects: [{ id: 'x', name: 'x', path: '/x', groupId: 'gone', order: 0 }] });
    expect(groupIds(d)).toEqual([UNGROUPED_ID]);
    expect(ids(d, UNGROUPED_ID)).toEqual(['x']);
  });
});

describe('Store', () => {
  const memory = (): Memento & { saved?: unknown } => ({
    get: () => undefined,
    update(_k, v) {
      this.saved = v;
      return Promise.resolve();
    },
  });
  it('persists, notifies, and skips no-ops', async () => {
    const m = memory();
    const store = new Store(m);
    let fired = 0;
    store.onDidChange(() => fired++);
    await store.update(d => addGroup(d, 'G', 'g'));
    await store.update(d => d);
    expect(fired).toBe(1);
    expect(groupIds(m.saved as PaddockData)).toContain('g');
  });
});
