import * as path from 'node:path';
import * as vscode from 'vscode';
import { Herdr } from './herdr/cli';
import { nextAgentName } from './herdr/names';
import type { AgentInfo, PaneInfo } from './herdr/parse';
import { HerdrPty } from './herdr/terminal';
import { LAYOUT_KEY, remove, restorable, upsert, type OpenSession, type TerminalLocation } from './layout';
import type { Preset } from './presets';
import { setWorkspaceId, type Project, type Store } from './store';

export interface SessionInfo {
	paneId: string;
	terminalId: string;
	workspaceId: string;
	name: string;
	/** herdr agent kind, or undefined for a plain shell pane. */
	kind?: string;
	status: string;
	open: boolean;
}

const PENDING_KEY = 'paddock.pendingOpen';

interface PendingOpen {
	projectId: string;
	paneId: string;
}

interface OpenTerminal {
	terminal: vscode.Terminal;
	session: OpenSession;
}

/** Sessions of every project, the terminals open in this window, and switching between projects. */
export class Sessions {
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChange = this.changed.event;

	private bySession = new Map<string, SessionInfo[]>();
	private readonly terminals = new Map<string, OpenTerminal>();
	private layout: OpenSession[];
	/** Set while the window is going away, so closing terminals does not erase the saved layout. */
	private leaving = false;

	constructor(
		private readonly herdr: Herdr,
		private readonly store: Store,
		private readonly context: vscode.ExtensionContext,
	) {
		this.layout = context.workspaceState.get<OpenSession[]>(LAYOUT_KEY) ?? [];
	}

	// --- reading -------------------------------------------------------------

	sessionsOf(project: Project): SessionInfo[] {
		return (project.workspaceId && this.bySession.get(project.workspaceId)) || [];
	}

	currentProject(): Project | undefined {
		const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		return folder ? this.store.snapshot.projects.find(p => path.resolve(p.path) === path.resolve(folder)) : undefined;
	}

	projectOfWorkspace(workspaceId: string): Project | undefined {
		return this.store.snapshot.projects.find(p => p.workspaceId === workspaceId);
	}

	/** Re-reads panes and agents from herdr. A quiet no-op when the server is not up. */
	async refresh(): Promise<void> {
		try {
			if (!(await this.herdr.serverRunning())) {
				this.bySession = new Map();
			} else {
				const [panes, agents] = await Promise.all([this.herdr.paneList(), this.herdr.agentList()]);
				this.bySession = this.group(panes, agents);
			}
		} catch {
			this.bySession = new Map();
		}
		this.changed.fire();
	}

	private group(panes: PaneInfo[], agents: AgentInfo[]): Map<string, SessionInfo[]> {
		const agentOf = new Map(agents.map(a => [a.paneId, a]));
		const grouped = new Map<string, SessionInfo[]>();
		for (const pane of panes) {
			const agent = agentOf.get(pane.paneId);
			const info: SessionInfo = {
				paneId: pane.paneId,
				terminalId: pane.terminalId,
				workspaceId: pane.workspaceId,
				name: agent?.name ?? pane.title ?? pane.paneId,
				kind: agent?.kind,
				status: agent?.status ?? pane.agentStatus,
				open: this.terminals.has(pane.paneId),
			};
			grouped.set(pane.workspaceId, [...(grouped.get(pane.workspaceId) ?? []), info]);
		}
		return grouped;
	}

	findSession(paneId: string): SessionInfo | undefined {
		for (const list of this.bySession.values()) {
			const hit = list.find(s => s.paneId === paneId);
			if (hit) {
				return hit;
			}
		}
		return undefined;
	}

	// --- starting ------------------------------------------------------------

	/** The project's herdr workspace, created on first use. */
	private async ensureWorkspace(project: Project): Promise<{ workspaceId: string; rootPane?: PaneInfo }> {
		if (project.workspaceId) {
			const known = await this.herdr.workspaceList();
			if (known.some(w => w.workspaceId === project.workspaceId)) {
				return { workspaceId: project.workspaceId };
			}
		}
		const created = await this.herdr.workspaceCreate(project.path, project.name);
		await this.store.update(d => setWorkspaceId(d, project.id, created.workspaceId));
		return { workspaceId: created.workspaceId, rootPane: created.rootPane };
	}

	/**
	 * Starts a session in its own herdr tab and opens it. The first session of a new
	 * workspace reuses the root pane herdr creates with it instead of leaving a stray shell.
	 */
	async start(project: Project, preset: Preset, name?: string, open = true): Promise<SessionInfo | undefined> {
		await this.herdr.ensureServer();
		const { workspaceId, rootPane } = await this.ensureWorkspace(project);
		const pane = rootPane ?? (await this.herdr.tabCreate(workspaceId, project.path));
		if (preset.kind) {
			const taken = (await this.herdr.agentList()).map(a => a.name);
			await this.herdr.agentStart(name ?? nextAgentName(project.name, taken), preset.kind, pane.paneId);
		}
		await this.refresh();
		const session = this.findSession(pane.paneId);
		if (session && open) {
			this.show(session);
		}
		return session;
	}

	// --- terminals -----------------------------------------------------------

	private location(): TerminalLocation {
		return vscode.workspace.getConfiguration('paddock').get<TerminalLocation>('terminalLocation') === 'editor' ? 'editor' : 'panel';
	}

	/** Focuses the session's terminal, opening it first if needed. */
	show(session: SessionInfo, options: { location?: TerminalLocation; preserveFocus?: boolean } = {}): void {
		const existing = this.terminals.get(session.paneId);
		if (existing) {
			existing.terminal.show(options.preserveFocus);
			return;
		}
		const location = options.location ?? this.location();
		const pty = new HerdrPty(this.herdr, session.paneId, {
			onClosed: () => this.closed(session.paneId),
		});
		const terminal = vscode.window.createTerminal({
			name: session.name,
			pty,
			location: location === 'editor' ? { viewColumn: vscode.ViewColumn.Active } : undefined,
			isTransient: true,
		});
		const open: OpenSession = { paneId: session.paneId, terminalId: session.terminalId, location };
		this.terminals.set(session.paneId, { terminal, session: open });
		void this.saveLayout(upsert(this.layout, open));
		terminal.show(options.preserveFocus);
		this.changed.fire();
	}

	private closed(paneId: string): void {
		this.terminals.delete(paneId);
		if (!this.leaving) {
			void this.saveLayout(remove(this.layout, paneId));
		}
		this.changed.fire();
	}

	private saveLayout(layout: OpenSession[]): Thenable<void> {
		this.layout = layout;
		return this.context.workspaceState.update(LAYOUT_KEY, layout);
	}

	/** Closes the VS Code terminal for a pane (releasing it) without touching the agent. */
	private dispose(paneId: string): void {
		this.terminals.get(paneId)?.terminal.dispose();
	}

	/** Called when the extension host is about to go away. */
	markLeaving(): void {
		this.leaving = true;
	}

	// --- restoring and switching --------------------------------------------

	/** Reopens this window's saved terminals, then honours a pending "open this session" request. */
	async restore(): Promise<void> {
		const project = this.currentProject();
		if (!project?.workspaceId) {
			return;
		}
		await this.refresh();
		const panes = this.sessionsOf(project);
		for (const saved of restorable(this.layout, panes)) {
			const session = panes.find(p => p.paneId === saved.paneId);
			if (session) {
				this.show(session, { location: saved.location, preserveFocus: true });
			}
		}
		const pending = this.context.globalState.get<PendingOpen>(PENDING_KEY);
		if (pending?.projectId === project.id) {
			await this.context.globalState.update(PENDING_KEY, undefined);
			const session = panes.find(p => p.paneId === pending.paneId);
			if (session) {
				this.show(session);
			}
		}
	}

	/** Reopens the folder in this same window; its sessions reattach after the reload. */
	async switchTo(project: Project, open?: SessionInfo): Promise<void> {
		this.markLeaving();
		if (open) {
			await this.context.globalState.update(PENDING_KEY, { projectId: project.id, paneId: open.paneId } satisfies PendingOpen);
		}
		try {
			await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(project.path), { forceNewWindow: false });
		} finally {
			// If the window did not go away (cancelled, folder missing), closing terminals matters again.
			this.leaving = false;
		}
	}

	/** Opens a session, switching project first when it belongs to another one. */
	async openSession(session: SessionInfo): Promise<void> {
		const project = this.projectOfWorkspace(session.workspaceId);
		if (project && this.currentProject()?.id !== project.id) {
			await this.switchTo(project, session);
			return;
		}
		this.show(session);
	}

	// --- managing ------------------------------------------------------------

	async kill(session: SessionInfo): Promise<void> {
		this.dispose(session.paneId);
		await this.herdr.paneClose(session.paneId);
		await this.saveLayout(remove(this.layout, session.paneId));
		await this.refresh();
	}

	async rename(session: SessionInfo, name: string): Promise<void> {
		if (session.kind) {
			await this.herdr.agentRename(session.paneId, name);
		} else {
			await this.herdr.paneRename(session.paneId, name);
		}
		// VS Code cannot retitle a terminal, so reopen it under the new name.
		const was = this.terminals.get(session.paneId)?.session.location;
		if (was) {
			this.dispose(session.paneId);
		}
		await this.refresh();
		const renamed = this.findSession(session.paneId);
		if (renamed && was) {
			this.show(renamed, { location: was });
		}
	}

	/** Kills the session and starts a fresh one of the same kind and name. */
	async restart(session: SessionInfo, project: Project): Promise<void> {
		const location = this.terminals.get(session.paneId)?.session.location;
		await this.kill(session);
		const preset: Preset = { id: session.kind ?? 'shell', label: session.name, kind: session.kind };
		const started = await this.start(project, preset, session.kind ? session.name : undefined);
		if (started && location && location !== this.location()) {
			this.dispose(started.paneId);
			this.show(started, { location });
		}
	}
}
