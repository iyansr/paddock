// Which sessions are open in a window, and where. Stored in workspaceState per folder.

export type TerminalLocation = 'panel' | 'editor';

export interface OpenSession {
  paneId: string;
  /** Used to confirm the pane still holds the same terminal after a herdr restart. */
  terminalId: string;
  location: TerminalLocation;
  /** Editor group (view column) the terminal was in, so splits come back in place. */
  column?: number;
}

/** Open sessions per project id. A multi-root window shares one workspaceState, so this is keyed by project. */
export type Layouts = Record<string, OpenSession[]>;

export const LAYOUTS_KEY = 'paddock.layouts';

/** The editor grid (`vscode.getEditorLayout`) per project, to rebuild split groups VS Code did not keep. */
export type Grids = Record<string, unknown>;

export const GRIDS_KEY = 'paddock.grids';

export function upsert(layout: OpenSession[], session: OpenSession): OpenSession[] {
  return [...layout.filter(s => s.paneId !== session.paneId), session];
}

export function remove(layout: OpenSession[], paneId: string): OpenSession[] {
  return layout.filter(s => s.paneId !== paneId);
}

/** Saved sessions whose pane still exists with the same terminal, in saved order. */
export function restorable(layout: OpenSession[], panes: { paneId: string; terminalId: string }[]): OpenSession[] {
  return layout.filter(s => panes.some(p => p.paneId === s.paneId && p.terminalId === s.terminalId));
}

/** Records the editor group of each pane found in `columns`; undefined when nothing moved. */
export function withColumns(layout: OpenSession[], columns: ReadonlyMap<string, number>): OpenSession[] | undefined {
  let moved = false;
  const next = layout.map(s => {
    const column = columns.get(s.paneId);
    if (column === undefined || column === s.column) {
      return s;
    }
    moved = true;
    return { ...s, column };
  });
  return moved ? next : undefined;
}
