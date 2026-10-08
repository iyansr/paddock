import { describe, expect, it } from 'vitest';

import { encodeCommand, LineSplitter, parseStreamLine } from '../../src/herdr/frames';
import { AGENT_NAME, displayName, nextAgentName } from '../../src/herdr/names';
import {
	HerdrError,
	isSupportedVersion,
	parseAgentList,
	parseCreated,
	parseEnvelope,
	parsePaneList,
	parseServerRunning,
	parseWorkspaceList,
	parseWorktreeList,
	parseWorktreeOpened,
} from '../../src/herdr/parse';
import { mapStatus, newlyWaiting, parseIntegrationStatus, waitingByWorkspace, type StatusEntry } from '../../src/herdr/status';
import { remove, restorable, upsert, type OpenSession } from '../../src/layout';

// Captured from herdr 0.9.3.
const PANE = {
	agent_status: 'unknown',
	cwd: '/private/tmp',
	focused: true,
	foreground_cwd: '/private/tmp',
	pane_id: 'w1:p1',
	revision: 5,
	tab_id: 'w1:t1',
	terminal_id: 'term_65d52baced8bc1',
	terminal_title: 'iyansr@host:/tmp',
	terminal_title_stripped: 'iyansr@host:/tmp',
	workspace_id: 'w1',
};

describe('parseEnvelope', () => {
	it('unwraps result', () => {
		expect(parseEnvelope('{"id":"x","result":{"type":"pane_list","panes":[]}}')).toEqual({ type: 'pane_list', panes: [] });
	});
	it('throws herdr errors with their code', () => {
		const run = () => parseEnvelope('{"error":{"code":"agent_not_ready","message":"blocked"},"id":"x"}');
		expect(run).toThrow(HerdrError);
		expect(run).toThrow(expect.objectContaining({ code: 'agent_not_ready' }));
	});
	it('rejects non-JSON', () => {
		expect(() => parseEnvelope('status: running')).toThrow(/did not return JSON/);
	});
});

describe('parsers', () => {
	it('parses panes', () => {
		const [pane] = parsePaneList({ panes: [PANE] });
		expect(pane).toMatchObject({
			paneId: 'w1:p1',
			tabId: 'w1:t1',
			workspaceId: 'w1',
			terminalId: 'term_65d52baced8bc1',
			title: 'iyansr@host:/tmp',
		});
	});
	it('rejects a pane without an id', () => {
		expect(() => parsePaneList({ panes: [{ ...PANE, pane_id: undefined }] })).toThrow(/pane_id/);
	});
	it('parses agents', () => {
		const agents = parseAgentList({
			agents: [{ agent: 'claude', agent_status: 'blocked', name: 'dummy-1', pane_id: 'w1:p2', workspace_id: 'w1' }],
		});
		expect(agents).toEqual([{ name: 'dummy-1', kind: 'claude', paneId: 'w1:p2', workspaceId: 'w1', status: 'blocked' }]);
	});
	it('parses an agent started by hand, which has no name', () => {
		const [agent] = parseAgentList({ agents: [{ agent: 'claude', agent_status: 'working', pane_id: 'w1:p1', workspace_id: 'w1' }] });
		expect(agent.name).toBeUndefined();
		expect(agent.kind).toBe('claude');
	});
	it('parses workspaces', () => {
		expect(parseWorkspaceList({ workspaces: [{ workspace_id: 'w1', label: 'scratch' }] })).toEqual([
			{ workspaceId: 'w1', label: 'scratch' },
		]);
	});
	it('parses a created tab or workspace', () => {
		expect(parseCreated({ root_pane: PANE }).rootPane.paneId).toBe('w1:p1');
	});
});

// Captured from herdr 0.9.3 (`worktree list`, `worktree create`).
const MAIN_WORKTREE = {
	branch: 'main',
	is_bare: false,
	is_detached: false,
	is_linked_worktree: false,
	is_prunable: false,
	label: 'repo',
	open_workspace_id: 'w1',
	path: '/tmp/repo',
};
const LINKED_WORKTREE = {
	branch: 'feat-a',
	is_bare: false,
	is_detached: false,
	is_linked_worktree: true,
	is_prunable: false,
	label: 'repo',
	path: '/Users/me/.herdr/worktrees/repo/feat-a',
};

describe('worktrees', () => {
	it('parses worktree list, with no workspace when herdr has none open', () => {
		expect(parseWorktreeList({ type: 'worktree_list', worktrees: [MAIN_WORKTREE, LINKED_WORKTREE] })).toEqual([
			{ path: '/tmp/repo', branch: 'main', linked: false, openWorkspaceId: 'w1' },
			{ path: '/Users/me/.herdr/worktrees/repo/feat-a', branch: 'feat-a', linked: true, openWorkspaceId: undefined },
		]);
	});
	it('treats a null branch (detached) as unset', () => {
		const [w] = parseWorktreeList({ worktrees: [{ ...LINKED_WORKTREE, branch: null, is_detached: true }] });
		expect(w.branch).toBeUndefined();
	});
	it('parses worktree create with its root pane', () => {
		const result = {
			type: 'worktree_created',
			root_pane: { ...PANE, pane_id: 'w2:p1', tab_id: 'w2:t1', workspace_id: 'w2' },
			workspace: { workspace_id: 'w2', label: 'feat-a', worktree: { checkout_path: LINKED_WORKTREE.path, is_linked_worktree: true } },
			worktree: { ...LINKED_WORKTREE, open_workspace_id: 'w2' },
		};
		const opened = parseWorktreeOpened(result);
		expect(opened.workspaceId).toBe('w2');
		expect(opened.rootPane?.paneId).toBe('w2:p1');
		expect(opened.worktree).toMatchObject({ branch: 'feat-a', linked: true, openWorkspaceId: 'w2' });
	});
	it('parses worktree open on an already open workspace, which has no root pane', () => {
		const opened = parseWorktreeOpened({ already_open: true, workspace: { workspace_id: 'w2' }, worktree: LINKED_WORKTREE });
		expect(opened).toMatchObject({ workspaceId: 'w2', rootPane: undefined });
	});
	it('reads the checkout path of a workspace', () => {
		const list = parseWorkspaceList({
			workspaces: [
				{ workspace_id: 'w1', label: 'plain' },
				{ workspace_id: 'w2', label: 'feat-a', worktree: { checkout_path: LINKED_WORKTREE.path } },
				{ workspace_id: 'w3', label: 'x', worktree: null },
			],
		});
		expect(list.map(w => w.checkoutPath)).toEqual([undefined, LINKED_WORKTREE.path, undefined]);
	});
});

describe('versions and status', () => {
	it.each([
		['herdr 0.9.3', true],
		['herdr 0.10.0', true],
		['herdr 1.0.0', true],
		['herdr 0.9.2', false],
		['nonsense', false],
	])('%s -> %s', (text, ok) => expect(isSupportedVersion(text)).toBe(ok));
	it('reads server status', () => {
		expect(parseServerRunning('status: running\nversion: 0.9.3\n')).toBe(true);
		expect(parseServerRunning('status: not running\n')).toBe(false);
	});
});

describe('agent names', () => {
	it('uses the smallest free number', () => {
		expect(nextAgentName('Nodus Studio', ['nodus-studio-1', 'nodus-studio-3'])).toBe('nodus-studio-2');
	});
	it('always matches the herdr pattern', () => {
		for (const project of ['9lives', 'Ünïcode', '---', 'a'.repeat(80), 'My App!!']) {
			expect(nextAgentName(project, [])).toMatch(AGENT_NAME);
		}
	});
	it('stays within 32 characters for a long name', () => {
		expect(nextAgentName('x'.repeat(80), ['x'.repeat(30) + '-1']).length).toBeLessThanOrEqual(32);
	});
});

describe('displayName', () => {
	it('prefers the agent name, then the kind, then shell', () => {
		expect(displayName('nodus-1', 'claude', 'w1:p2')).toBe('nodus-1');
		expect(displayName(undefined, 'claude', 'w1:p2')).toBe('claude p2');
		expect(displayName(undefined, undefined, 'w1:p3')).toBe('shell p3');
	});
});

describe('stream protocol', () => {
	it('splits chunked lines', () => {
		const s = new LineSplitter();
		expect(s.push('{"a":1}\n{"b"')).toEqual(['{"a":1}']);
		expect(s.push(':2}\n\n')).toEqual(['{"b":2}']);
	});
	it('decodes a frame', () => {
		const line = JSON.stringify({
			type: 'terminal.frame',
			bytes: Buffer.from('\x1b[2Jhi').toString('base64'),
			full: true,
			seq: 1,
			width: 80,
			height: 24,
			encoding: 'ansi',
		});
		const rec = parseStreamLine(line);
		expect(rec).toMatchObject({ type: 'frame', full: true, seq: 1, width: 80, height: 24 });
		expect(rec?.type === 'frame' && rec.bytes.toString()).toBe('\x1b[2Jhi');
	});
	it('decodes closed', () => {
		expect(parseStreamLine('{"reason":"detached","type":"terminal.closed"}')).toEqual({ type: 'closed', reason: 'detached' });
	});
	it('ignores noise', () => {
		expect(parseStreamLine('not json')).toBeUndefined();
		expect(parseStreamLine('{"type":"other"}')).toBeUndefined();
	});
	it('encodes commands as one line', () => {
		expect(encodeCommand({ type: 'terminal.input', text: 'ls\r' })).toBe('{"type":"terminal.input","text":"ls\\r"}\n');
		expect(encodeCommand({ type: 'terminal.release' })).toBe('{"type":"terminal.release"}\n');
	});
});

describe('layout', () => {
	const a: OpenSession = { paneId: 'w1:p1', terminalId: 't1', location: 'panel' };
	const b: OpenSession = { paneId: 'w1:p2', terminalId: 't2', location: 'editor' };
	it('upserts and removes', () => {
		expect(upsert([a, b], { ...a, location: 'editor' })).toEqual([b, { ...a, location: 'editor' }]);
		expect(remove([a, b], 'w1:p1')).toEqual([b]);
	});
	it('restores only panes that still hold the same terminal', () => {
		expect(
			restorable(
				[a, b],
				[
					{ paneId: 'w1:p1', terminalId: 't1' },
					{ paneId: 'w1:p2', terminalId: 'other' },
				],
			),
		).toEqual([a]);
	});
});

describe('status', () => {
	it('maps herdr states', () => {
		expect(mapStatus('working', true)).toBe('running');
		expect(mapStatus('unknown', true)).toBe('running');
		expect(mapStatus('blocked', true)).toBe('waiting');
		expect(mapStatus('done', true)).toBe('done');
		expect(mapStatus('idle', true)).toBe('done');
		expect(mapStatus('blocked', false)).toBe('running');
	});
	const e = (paneId: string, workspaceId: string, state: StatusEntry['state']): StatusEntry => ({ paneId, workspaceId, state });
	it('counts waiting per workspace', () => {
		const counts = waitingByWorkspace([e('w1:p1', 'w1', 'waiting'), e('w1:p2', 'w1', 'waiting'), e('w2:p1', 'w2', 'done')]);
		expect(counts).toEqual(new Map([['w1', 2]]));
	});
	it('reports only sessions that just started waiting', () => {
		const previous = new Map<string, 'running' | 'waiting' | 'done'>([
			['w1:p1', 'waiting'],
			['w1:p2', 'running'],
		]);
		const now = [e('w1:p1', 'w1', 'waiting'), e('w1:p2', 'w1', 'waiting'), e('w1:p3', 'w1', 'waiting'), e('w1:p4', 'w1', 'running')];
		expect(newlyWaiting(previous, now).map(x => x.paneId)).toEqual(['w1:p2', 'w1:p3']);
	});
	it('parses integration status', () => {
		const text = [
			'claude: outdated (v7 < v10) (/Users/x/.claude/hooks/herdr-agent-state.sh)',
			'codex: not installed (/x/herdr-agent-state.sh)',
			'cursor: current (v1) (/x/.cursor/herdr-agent-state.sh)',
			'letta (experimental): not installed (/x/y.sh)',
		].join('\n');
		expect(parseIntegrationStatus(text)).toEqual([
			{ kind: 'claude', state: 'outdated' },
			{ kind: 'codex', state: 'not installed' },
			{ kind: 'cursor', state: 'current' },
			{ kind: 'letta', state: 'not installed' },
		]);
	});
});
