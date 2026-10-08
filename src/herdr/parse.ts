// Parsing and validation of herdr's JSON. Nothing here imports VS Code or runs a process.

export const MIN_HERDR_VERSION = '0.9.3';

export class HerdrError extends Error {
	constructor(readonly code: string, message: string) {
		super(message);
		this.name = 'HerdrError';
	}
}

export interface PaneInfo {
	paneId: string;
	tabId: string;
	workspaceId: string;
	terminalId: string;
	cwd: string;
	agentStatus: string;
	title?: string;
}

export interface AgentInfo {
	name: string;
	/** herdr's agent kind, e.g. `claude`. */
	kind: string;
	paneId: string;
	workspaceId: string;
	status: string;
}

export interface WorkspaceInfo {
	workspaceId: string;
	label: string;
}

type Obj = Record<string, unknown>;

function obj(value: unknown, what: string): Obj {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new HerdrError('bad_response', `expected ${what} to be an object`);
	}
	return value as Obj;
}

function str(o: Obj, key: string, what: string): string {
	const v = o[key];
	if (typeof v !== 'string') {
		throw new HerdrError('bad_response', `expected ${what}.${key} to be a string`);
	}
	return v;
}

function optStr(o: Obj, key: string): string | undefined {
	const v = o[key];
	return typeof v === 'string' ? v : undefined;
}

function list(o: Obj, key: string, what: string): unknown[] {
	const v = o[key];
	if (!Array.isArray(v)) {
		throw new HerdrError('bad_response', `expected ${what}.${key} to be an array`);
	}
	return v;
}

/** Unwraps `{ id, result }`, or throws the `{ id, error }` herdr returned. */
export function parseEnvelope(stdout: string): Obj {
	let json: unknown;
	try {
		json = JSON.parse(stdout);
	} catch {
		throw new HerdrError('bad_response', `herdr did not return JSON: ${stdout.slice(0, 200)}`);
	}
	const envelope = obj(json, 'response');
	if (envelope.error !== undefined) {
		const e = obj(envelope.error, 'error');
		throw new HerdrError(optStr(e, 'code') ?? 'error', optStr(e, 'message') ?? 'herdr returned an error');
	}
	return obj(envelope.result, 'result');
}

export function parsePane(value: unknown): PaneInfo {
	const p = obj(value, 'pane');
	return {
		paneId: str(p, 'pane_id', 'pane'),
		tabId: str(p, 'tab_id', 'pane'),
		workspaceId: str(p, 'workspace_id', 'pane'),
		terminalId: str(p, 'terminal_id', 'pane'),
		cwd: optStr(p, 'cwd') ?? '',
		agentStatus: optStr(p, 'agent_status') ?? 'unknown',
		title: optStr(p, 'terminal_title_stripped') ?? optStr(p, 'terminal_title'),
	};
}

export function parsePaneList(result: Obj): PaneInfo[] {
	return list(result, 'panes', 'result').map(parsePane);
}

export function parseAgentList(result: Obj): AgentInfo[] {
	return list(result, 'agents', 'result').map(value => {
		const a = obj(value, 'agent');
		return {
			name: str(a, 'name', 'agent'),
			kind: optStr(a, 'agent') ?? 'unknown',
			paneId: str(a, 'pane_id', 'agent'),
			workspaceId: str(a, 'workspace_id', 'agent'),
			status: optStr(a, 'agent_status') ?? 'unknown',
		};
	});
}

export function parseWorkspaceList(result: Obj): WorkspaceInfo[] {
	return list(result, 'workspaces', 'result').map(value => {
		const w = obj(value, 'workspace');
		return { workspaceId: str(w, 'workspace_id', 'workspace'), label: optStr(w, 'label') ?? '' };
	});
}

/** `workspace create` and `tab create` both return the new tab's root pane. */
export function parseCreated(result: Obj): { workspaceId: string; tabId: string; rootPane: PaneInfo } {
	const rootPane = parsePane(result.root_pane);
	return { workspaceId: rootPane.workspaceId, tabId: rootPane.tabId, rootPane };
}

export function parseVersion(text: string): [number, number, number] | undefined {
	const m = /(\d+)\.(\d+)\.(\d+)/.exec(text);
	return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

export function isSupportedVersion(text: string, min = MIN_HERDR_VERSION): boolean {
	const have = parseVersion(text);
	const need = parseVersion(min);
	if (!have || !need) {
		return false;
	}
	for (let i = 0; i < 3; i++) {
		if (have[i] !== need[i]) {
			return have[i] > need[i];
		}
	}
	return true;
}

/** Reads `herdr status server` output. */
export function parseServerRunning(text: string): boolean {
	return /^status:\s*running\b/m.test(text);
}
