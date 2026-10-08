export interface Preset {
	id: string;
	label: string;
	/** herdr agent kind; undefined starts a plain shell. */
	kind?: string;
}

export const PRESETS: readonly Preset[] = [
	{ id: 'claude', label: 'Claude Code', kind: 'claude' },
	{ id: 'codex', label: 'Codex', kind: 'codex' },
	{ id: 'shell', label: 'Shell' },
];
