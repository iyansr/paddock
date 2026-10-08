// Which sessions are open in a window, and where. Stored in workspaceState per folder.

export type TerminalLocation = 'panel' | 'editor';

export interface OpenSession {
	paneId: string;
	/** Used to confirm the pane still holds the same terminal after a herdr restart. */
	terminalId: string;
	location: TerminalLocation;
}

/** Open sessions per project id. A multi-root window shares one workspaceState, so this is keyed by project. */
export type Layouts = Record<string, OpenSession[]>;

export const LAYOUTS_KEY = 'paddock.layouts';

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
