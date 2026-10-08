import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { captureEditors, closeEditors, EDITORS_KEY, restoreEditors, revertStashed, type EditorSnapshot, type EditorSnapshots } from './editors';
import { Herdr } from './herdr/cli';
import { displayName, nextAgentName } from './herdr/names';
import type { AgentInfo, PaneInfo } from './herdr/parse';
import { HerdrPty } from './herdr/terminal';
import { LAYOUTS_KEY, remove, restorable, upsert, type Layouts, type OpenSession, type TerminalLocation } from './layout';
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
	/** The title currently shown on the tab. */
	name: string;
	terminal: vscode.Terminal;
	pty: HerdrPty;
	session: OpenSession;
	projectId: string;
}

export type SwitchMode = 'reload' | 'swap';

/** Sessions of every project, the terminals open in this window, and switching between projects. */
export class Sessions {
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChange = this.changed.event;

	private bySession = new Map<string, SessionInfo[]>();
	private lastSignature = '';
	private readonly terminals = new Map<string, OpenTerminal>();
	private layouts: Layouts;
	private editors: EditorSnapshots;
	/** Set while the window is going away, so closing terminals does not erase the saved layout. */
	private leaving = false;

	constructor(
		private readonly herdr: Herdr,
		private readonly store: Store,
		private readonly context: vscode.ExtensionContext,
	) {
		this.layouts = context.workspaceState.get<Layouts>(LAYOUTS_KEY) ?? {};
		this.editors = context.workspaceState.get<EditorSnapshots>(EDITORS_KEY) ?? {};
		// Whatever closed a terminal (tab, `exit`, pane killed elsewhere), forget it.
		context.subscriptions.push(
			// The open project changes when a folder is swapped in place.
			vscode.workspace.onDidChangeWorkspaceFolders(() => this.changed.fire()),
			vscode.window.onDidCloseTerminal(t => {
				for (const [paneId, open] of this.terminals) {
					if (open.terminal === t) {
						this.closed(paneId);
					}
				}
			}),
		);
	}

	// --- reading -------------------------------------------------------------

	sessionsOf(project: Project): SessionInfo[] {
		return (project.workspaceId && this.bySession.get(project.workspaceId)) || [];
	}

	/** Folder Paddock keeps first in the window so the project folder after it can be swapped without a reload. */
	private get placeholder(): string {
		return path.join(this.context.globalStorageUri.fsPath, 'Paddock');
	}

	private isSwapWindow(): boolean {
		const first = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		return first !== undefined && path.resolve(first) === path.resolve(this.placeholder);
	}

	private switchMode(): SwitchMode {
		return vscode.workspace.getConfiguration('paddock').get<SwitchMode>('switchMode') === 'swap' ? 'swap' : 'reload';
	}

	currentProject(): Project | undefined {
		const folders = vscode.workspace.workspaceFolders;
		const folder = (this.isSwapWindow() ? folders?.[1] : folders?.[0])?.uri.fsPath;
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
		this.syncTabNames();
		const signature = JSON.stringify([...this.bySession]);
		if (signature !== this.lastSignature) {
			this.lastSignature = signature;
			this.changed.fire();
		}
	}

	/** Keeps open terminal tabs titled like their session as it changes (a shell becomes claude, a rename). */
	private syncTabNames(): void {
		for (const [paneId, open] of this.terminals) {
			const name = this.findSession(paneId)?.name;
			if (name && name !== open.name) {
				open.name = name;
				open.pty.setName(name);
			}
		}
	}

	/** Polls herdr so the sidebar and tab titles follow what the agents are doing. */
	startPolling(intervalMs: number): vscode.Disposable {
		let busy = false;
		const timer = setInterval(() => {
			if (busy || !vscode.window.state.focused) {
				return;
			}
			busy = true;
			void this.refresh().finally(() => {
				busy = false;
			});
		}, intervalMs);
		return { dispose: () => clearInterval(timer) };
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
				name: displayName(agent?.name, agent?.kind, pane.paneId),
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
			const taken = (await this.herdr.agentList()).flatMap(a => (a.name ? [a.name] : []));
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
		if (existing && existing.terminal.exitStatus === undefined) {
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
		const projectId = this.projectOfWorkspace(session.workspaceId)?.id ?? this.currentProject()?.id ?? '';
		this.terminals.set(session.paneId, { terminal, pty, session: open, name: session.name, projectId });
		void this.saveLayout(projectId, upsert(this.layouts[projectId] ?? [], open));
		terminal.show(options.preserveFocus);
		this.changed.fire();
	}

	private closed(paneId: string): void {
		const open = this.terminals.get(paneId);
		this.terminals.delete(paneId);
		if (open && !this.leaving) {
			void this.saveLayout(open.projectId, remove(this.layouts[open.projectId] ?? [], paneId));
			// The pane may be gone (the shell exited); drop it from the sidebar.
			void this.refresh();
		}
		this.changed.fire();
	}

	private saveLayout(projectId: string, layout: OpenSession[]): Thenable<void> {
		this.layouts = { ...this.layouts, [projectId]: layout };
		return this.context.workspaceState.update(LAYOUTS_KEY, this.layouts);
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
		for (const saved of restorable(this.layouts[project.id] ?? [], panes)) {
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
		if (open) {
			await this.context.globalState.update(PENDING_KEY, { projectId: project.id, paneId: open.paneId } satisfies PendingOpen);
		}
		if (this.switchMode() === 'swap') {
			await this.swapTo(project);
			return;
		}
		this.markLeaving();
		try {
			await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(project.path), { forceNewWindow: false });
		} finally {
			// If the window did not go away (cancelled, folder missing), closing terminals matters again.
			this.leaving = false;
		}
	}

	/**
	 * Experimental alternative to reopening the folder. The window becomes a multi-root
	 * workspace with a fixed placeholder folder first; after that, switching replaces only
	 * the folder after it, which VS Code does without restarting extensions.
	 */
	private async swapTo(project: Project): Promise<void> {
		const target = { uri: vscode.Uri.file(project.path), name: project.name };
		const folders = vscode.workspace.workspaceFolders ?? [];
		await mkdir(this.placeholder, { recursive: true });

		if (!this.isSwapWindow()) {
			// One-time conversion into a saved workspace file (an untitled one makes VS Code ask
			// to save it on every close). Opening it reloads the window once; the pending-open
			// request stored by switchTo() finishes the job afterwards.
			const file = vscode.Uri.file(path.join(this.context.globalStorageUri.fsPath, 'Paddock.code-workspace'));
			const content = { folders: [{ name: 'Paddock', path: this.placeholder }, { name: project.name, path: project.path }] };
			await writeFile(file.fsPath, JSON.stringify(content, null, '\t') + '\n');
			this.markLeaving();
			try {
				await vscode.commands.executeCommand('vscode.openFolder', file, { forceNewWindow: false });
			} finally {
				this.leaving = false;
			}
			return;
		}
		if (this.currentProject()?.id === project.id) {
			return;
		}

		// Save the old project's open files and close them, so they do not follow us into the next project.
		// Closing can prompt about unsaved changes; cancelling stops the switch.
		const previous = this.currentProject();
		if (previous) {
			const { snapshot, tabs } = await captureEditors();
			// Unsaved edits travel in the snapshot; revert the tabs so closing them does not ask.
			await revertStashed(snapshot);
			if (!(await closeEditors(tabs))) {
				await restoreEditors(snapshot);
				throw new Error('Switch cancelled: save or discard your unsaved changes first');
			}
			await this.saveEditors(previous.id, snapshot);
		}

		// Leave the old project's terminals in herdr and in the saved layout, but close their tabs.
		const open = [...this.terminals.values()];
		this.terminals.clear();
		for (const t of open) {
			t.terminal.dispose();
		}
		const changed = new Promise<void>(resolve => {
			const sub = vscode.workspace.onDidChangeWorkspaceFolders(() => {
				sub.dispose();
				resolve();
			});
		});
		const started = vscode.workspace.updateWorkspaceFolders(1, folders.length > 1 ? folders.length - 1 : 0, target);
		if (!started) {
			throw new Error('VS Code refused to swap the project folder');
		}
		await changed;
		await restoreEditors(this.editors[project.id]);
		await this.restore();
		await this.refresh();
	}

	private saveEditors(projectId: string, snapshot: EditorSnapshot): Thenable<void> {
		this.editors = { ...this.editors, [projectId]: snapshot };
		return this.context.workspaceState.update(EDITORS_KEY, this.editors);
	}

	/** Opens a session, switching project first when it belongs to another one. */
	async openSession(session: SessionInfo): Promise<void> {
		const project = this.projectOfWorkspace(session.workspaceId);
		if (project && this.currentProject()?.id !== project.id) {
			await this.switchTo(project, session);
			return;
		}
		if (!this.terminals.has(session.paneId)) {
			// The sidebar can be stale: the shell may have exited since the last refresh.
			await this.refresh();
			if (!this.findSession(session.paneId)) {
				void vscode.window.showInformationMessage(`Session "${session.name}" has ended.`);
				return;
			}
		}
		this.show(session);
	}

	// --- managing ------------------------------------------------------------

	async kill(session: SessionInfo): Promise<void> {
		this.dispose(session.paneId);
		await this.herdr.paneClose(session.paneId);
		const projectId = this.projectOfWorkspace(session.workspaceId)?.id;
		if (projectId) {
			await this.saveLayout(projectId, remove(this.layouts[projectId] ?? [], session.paneId));
		}
		await this.refresh();
	}

	async rename(session: SessionInfo, name: string): Promise<void> {
		if (session.kind) {
			await this.herdr.agentRename(session.paneId, name);
		} else {
			await this.herdr.paneRename(session.paneId, name);
		}
		// refresh() retitles the open terminal tab.
		await this.refresh();
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
