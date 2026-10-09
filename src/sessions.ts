import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import * as vscode from 'vscode';

import {
  checkoutAt,
  checkoutKey,
  checkoutOf,
  checkoutName,
  checkoutPath,
  samePath,
  WORKTREES_KEY,
  type Checkout,
  type Worktrees,
} from './checkouts';
import {
  captureEditors,
  closeEditors,
  EDITORS_KEY,
  restoreEditors,
  revertStashed,
  type EditorSnapshot,
  type EditorSnapshots,
} from './editors';
import { Herdr } from './herdr/cli';
import { displayName, nextAgentName } from './herdr/names';
import { HerdrError, type AgentInfo, type PaneInfo, type WorktreeInfo } from './herdr/parse';
import { mapStatus, newlyWaiting, waitingByWorkspace, type SessionState, type StatusEntry } from './herdr/status';
import { HerdrPty } from './herdr/terminal';
import {
  LAYOUTS_KEY,
  remove,
  restorable,
  upsert,
  type Layouts,
  type OpenSession,
  type TerminalLocation,
} from './layout';
import type { Preset } from './presets';
import { setWorkspaceId, type Project, type Store } from './store';

export interface SessionInfo {
  paneId: string;
  terminalId: string;
  workspaceId: string;
  name: string;
  /** herdr agent kind, or undefined for a plain shell pane. */
  kind?: string;
  status: SessionState;
  open: boolean;
}

const PENDING_KEY = 'paddock.pendingOpen';
/** A worktree whose removal waits for the window to finish switching away from it. */
const PENDING_REMOVE_KEY = 'paddock.pendingRemove';
const INTEGRATION_ASKED_KEY = 'paddock.integrationAsked';
/** Agent kinds herdr can read exact state from once its integration is installed. */
const INTEGRATION_KINDS = new Set(['claude', 'codex']);

interface PendingRemove {
  projectId: string;
  worktreePath: string;
  /** Date.now() when asked; a stale request (the switch was cancelled) is dropped. */
  at: number;
}

const PENDING_REMOVE_TTL_MS = 60_000;

interface PendingOpen {
  /** checkoutKey() of the checkout to open it in. */
  key: string;
  paneId: string;
}

interface OpenTerminal {
  /** The title currently shown on the tab. */
  name: string;
  terminal: vscode.Terminal;
  pty: HerdrPty;
  session: OpenSession;
  /** checkoutKey() of the checkout the session belongs to. */
  key: string;
}

export type SwitchMode = 'reload' | 'swap';

/** Sessions of every project, the terminals open in this window, and switching between projects. */
export class Sessions {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  private bySession = new Map<string, SessionInfo[]>();
  /** Label of each live herdr workspace. herdr ids are positional (`w1`) and get reused, so the label tells whose it is. */
  private labels = new Map<string, string>();
  /** Git checkout of each live herdr workspace, which tells whose a worktree's workspace is. */
  private checkoutPaths = new Map<string, string>();
  /** Last `herdr worktree list` per project, kept across reloads so a window opened on a worktree knows its project at once. */
  private worktrees: Worktrees;
  /** Checkout paths that already triggered a worktree re-list, so an unknown repository does not re-list on every poll. */
  private unknownCheckouts = new Set<string>();
  private lastSignature = '';
  /** Last seen state per pane; undefined until the first successful poll, which only sets the baseline. */
  private seen: Map<string, SessionState> | undefined;
  private readonly terminals = new Map<string, OpenTerminal>();
  private layouts: Layouts;
  private editors: EditorSnapshots;
  /** Pane of the Paddock terminal focused last; a browser pick is sent there. */
  private lastFocused: string | undefined;
  /** Set while the window is going away, so closing terminals does not erase the saved layout. */
  private leaving = false;

  constructor(
    private readonly herdr: Herdr,
    private readonly store: Store,
    private readonly context: vscode.ExtensionContext,
  ) {
    this.layouts = context.workspaceState.get<Layouts>(LAYOUTS_KEY) ?? {};
    this.editors = context.workspaceState.get<EditorSnapshots>(EDITORS_KEY) ?? {};
    this.worktrees = context.globalState.get<Worktrees>(WORKTREES_KEY) ?? {};
    // Whatever closed a terminal (tab, `exit`, pane killed elsewhere), forget it.
    context.subscriptions.push(
      // The open project changes when a folder is swapped in place.
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.changed.fire()),
      vscode.window.onDidChangeActiveTerminal(t => {
        for (const [paneId, open] of this.terminals) {
          if (open.terminal === t) {
            this.lastFocused = paneId;
            this.changed.fire();
          }
        }
      }),
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

  /** True when the project's stored workspace id still names the workspace herdr made for it. */
  private owns(project: Project, workspaceId: string): boolean {
    return project.workspaceId === workspaceId && this.labels.get(workspaceId) === project.name;
  }

  /** herdr workspace currently open on the checkout, if any. */
  private workspaceOf(c: Checkout): string | undefined {
    if (!c.worktree) {
      const { workspaceId } = c.project;
      return workspaceId && this.owns(c.project, workspaceId) ? workspaceId : undefined;
    }
    const worktreePath = c.worktree.path;
    for (const [workspaceId, checkout] of this.checkoutPaths) {
      if (samePath(checkout, worktreePath)) {
        return workspaceId;
      }
    }
    return undefined;
  }

  sessionsIn(c: Checkout): SessionInfo[] {
    const workspaceId = this.workspaceOf(c);
    return (workspaceId && this.bySession.get(workspaceId)) || [];
  }

  /** Every checkout of the project, main first; empty when it is not a git repository (or not listed yet). */
  worktreesOf(project: Project): WorktreeInfo[] {
    return this.worktrees[project.id] ?? [];
  }

  /** The checkout a tree node names. */
  checkout(projectId: string, worktreePath?: string): Checkout | undefined {
    return checkoutOf(this.store.snapshot.projects, this.worktrees, projectId, worktreePath);
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

  /** The project folder or worktree open in this window. */
  currentCheckout(): Checkout | undefined {
    const folders = vscode.workspace.workspaceFolders;
    const folder = (this.isSwapWindow() ? folders?.[1] : folders?.[0])?.uri.fsPath;
    return folder ? checkoutAt(this.store.snapshot.projects, this.worktrees, folder) : undefined;
  }

  currentProject(): Project | undefined {
    return this.currentCheckout()?.project;
  }

  isCurrent(c: Checkout): boolean {
    const current = this.currentCheckout();
    return !!current && checkoutKey(current) === checkoutKey(c);
  }

  /** The checkout a herdr workspace was opened on: a project's own workspace, or one on a linked worktree. */
  checkoutOfWorkspace(workspaceId: string): Checkout | undefined {
    const { projects } = this.store.snapshot;
    const project = projects.find(p => this.owns(p, workspaceId));
    if (project) {
      return { project };
    }
    const checkout = this.checkoutPaths.get(workspaceId);
    const found = checkout ? checkoutAt(projects, this.worktrees, checkout) : undefined;
    return found?.worktree ? found : undefined;
  }

  projectOfWorkspace(workspaceId: string): Project | undefined {
    return this.checkoutOfWorkspace(workspaceId)?.project;
  }

  /** Re-reads panes and agents from herdr. A quiet no-op when the server is not up. */
  async refresh(): Promise<void> {
    try {
      if (!(await this.herdr.serverRunning())) {
        this.bySession = new Map();
        this.labels = new Map();
        this.checkoutPaths = new Map();
      } else {
        const [panes, agents, workspaces] = await Promise.all([
          this.herdr.paneList(),
          this.herdr.agentList(),
          this.herdr.workspaceList(),
        ]);
        this.labels = new Map(workspaces.map(w => [w.workspaceId, w.label]));
        this.checkoutPaths = new Map(
          workspaces.flatMap(w => (w.checkoutPath ? [[w.workspaceId, w.checkoutPath] as const] : [])),
        );
        this.noticeNewWorktrees();
        this.bySession = this.group(panes, agents);
        this.notifyWaiting();
        void this.offerIntegrations(agents);
      }
    } catch {
      // A failed poll keeps `seen`, so a blip does not re-notify everything that is waiting.
      this.bySession = new Map();
      this.labels = new Map();
      this.checkoutPaths = new Map();
    }
    this.syncTabNames();
    const signature = JSON.stringify([[...this.bySession], [...this.labels], [...this.checkoutPaths]]);
    if (signature !== this.lastSignature) {
      this.lastSignature = signature;
      this.changed.fire();
    }
  }

  /** Re-lists worktrees when herdr has a workspace on a checkout Paddock does not know, e.g. one made in herdr itself. */
  private noticeNewWorktrees(): void {
    const known = this.store.snapshot.projects.flatMap(p => [p.path, ...this.worktreesOf(p).map(w => w.path)]);
    const fresh = [...this.checkoutPaths.values()].filter(
      c => !known.some(k => samePath(k, c)) && !this.unknownCheckouts.has(c),
    );
    if (fresh.length) {
      fresh.forEach(c => this.unknownCheckouts.add(c));
      void this.refreshWorktrees();
    }
  }

  /**
   * Re-lists worktrees when a checkout changes branch (`git checkout` in a terminal) or a worktree is
   * added or removed outside Paddock (`git worktree add`), by watching each project's HEAD and its
   * linked worktrees' HEADs. Follows the project list.
   */
  watchBranches(): vscode.Disposable {
    let watchers: vscode.Disposable[] = [];
    let timer: NodeJS.Timeout | undefined;
    const changed = () => {
      // git rewrites HEAD through a lock file, so one checkout fires several events.
      clearTimeout(timer);
      timer = setTimeout(() => void this.refreshWorktrees(), 300);
    };
    const watch = () => {
      watchers.forEach(w => w.dispose());
      watchers = this.store.snapshot.projects.map(p => {
        const pattern = new vscode.RelativePattern(
          vscode.Uri.file(path.join(p.path, '.git')),
          '{HEAD,worktrees/*/HEAD}',
        );
        const watcher = vscode.workspace.createFileSystemWatcher(pattern);
        watcher.onDidChange(changed);
        watcher.onDidCreate(changed);
        watcher.onDidDelete(changed);
        return watcher;
      });
    };
    let paths = '';
    const sub = this.store.onDidChange(() => {
      const next = this.store.snapshot.projects.map(p => p.path).join('\n');
      if (next !== paths) {
        paths = next;
        watch();
      }
    });
    paths = this.store.snapshot.projects.map(p => p.path).join('\n');
    watch();
    return {
      dispose: () => {
        clearTimeout(timer);
        sub.dispose();
        watchers.forEach(w => w.dispose());
      },
    };
  }

  /** Re-reads every project's worktrees from herdr. A quiet no-op when the server is not up. */
  async refreshWorktrees(): Promise<void> {
    try {
      if (!(await this.herdr.serverRunning())) {
        return;
      }
    } catch {
      return;
    }
    const { projects } = this.store.snapshot;
    const lists = await Promise.all(
      projects.map(async p => {
        try {
          return [p.id, await this.herdr.worktreeList(p.path)] as const;
        } catch (e) {
          // Not a git repository: no worktrees. Anything else keeps the last known list.
          return [p.id, e instanceof HerdrError && e.code === 'not_git_worktree' ? [] : this.worktreesOf(p)] as const;
        }
      }),
    );
    const next: Worktrees = Object.fromEntries(lists);
    if (JSON.stringify(next) !== JSON.stringify(this.worktrees)) {
      this.worktrees = next;
      await this.context.globalState.update(WORKTREES_KEY, next);
      this.changed.fire();
    }
  }

  private entries(): StatusEntry[] {
    return [...this.bySession.values()]
      .flat()
      .map(s => ({ paneId: s.paneId, workspaceId: s.workspaceId, state: s.status }));
  }

  /** Sessions waiting on me, per project id; includes projects that are not open. */
  waitingByProject(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const [workspaceId, n] of waitingByWorkspace(this.entries())) {
      const project = this.projectOfWorkspace(workspaceId);
      if (project) {
        counts.set(project.id, n);
      }
    }
    return counts;
  }

  /** Shows a notification for each session that just started waiting. */
  private notifyWaiting(): void {
    const entries = this.entries();
    const previous = this.seen;
    this.seen = new Map(entries.map(e => [e.paneId, e.state]));
    if (!previous) {
      return;
    }
    for (const entry of newlyWaiting(previous, entries)) {
      const session = this.findSession(entry.paneId);
      if (!session || this.isWatching(session.paneId)) {
        continue;
      }
      const checkout = this.checkoutOfWorkspace(session.workspaceId);
      const where = checkout ? ` in ${checkoutName(checkout)}` : '';
      void vscode.window
        .showInformationMessage(`${session.name}${where} is waiting for input`, 'Go to session')
        .then(async choice => {
          if (choice !== 'Go to session') {
            return;
          }
          try {
            if (session.kind) {
              // Marks the completion as seen in herdr.
              await this.herdr.agentFocus(session.paneId);
            }
            await this.openSession(session);
          } catch (e) {
            void vscode.window.showErrorMessage(`Paddock: ${e instanceof Error ? e.message : String(e)}`);
          }
        });
    }
  }

  private offering = false;

  /**
   * Without its hook, herdr guesses an agent's state from the screen. Offers, once per kind,
   * to install herdr's hook for the agents in use. Installing edits the agent's own config,
   * so it only happens after the click.
   */
  private async offerIntegrations(agents: AgentInfo[]): Promise<void> {
    const asked = this.context.globalState.get<string[]>(INTEGRATION_ASKED_KEY) ?? [];
    const wanted = [...new Set(agents.map(a => a.kind))].filter(k => INTEGRATION_KINDS.has(k) && !asked.includes(k));
    if (this.offering || wanted.length === 0) {
      return;
    }
    this.offering = true;
    try {
      const status = await this.herdr.integrationStatus();
      for (const kind of wanted) {
        if (status.find(s => s.kind === kind)?.state === 'current') {
          continue;
        }
        await this.context.globalState.update(INTEGRATION_ASKED_KEY, [
          ...(this.context.globalState.get<string[]>(INTEGRATION_ASKED_KEY) ?? []),
          kind,
        ]);
        const choice = await vscode.window.showInformationMessage(
          `Install herdr's ${kind} integration? It adds a hook to your ${kind} config so Paddock shows exact session status instead of guessing from the screen.`,
          'Install',
          'Not now',
        );
        if (choice === 'Install') {
          await this.herdr.integrationInstall(kind);
          void vscode.window.showInformationMessage(
            `herdr ${kind} integration installed. Restart running ${kind} sessions to pick it up.`,
          );
        }
      }
    } catch (e) {
      void vscode.window.showErrorMessage(`Paddock: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.offering = false;
    }
  }

  /**
   * Where a browser pick goes: the last focused Paddock terminal, else an agent
   * in this window's checkout, preferring one whose terminal is open.
   */
  pickTarget(): SessionInfo | undefined {
    const last = this.lastFocused && this.findSession(this.lastFocused);
    if (last) {
      return last;
    }
    const current = this.currentCheckout();
    const list = current ? this.sessionsIn(current) : [];
    return list.find(s => s.kind && this.terminals.has(s.paneId)) ?? list.find(s => s.kind) ?? list[0];
  }

  /** True when I am already looking at this session's terminal. */
  private isWatching(paneId: string): boolean {
    const open = this.terminals.get(paneId);
    return !!open && vscode.window.state.focused && vscode.window.activeTerminal === open.terminal;
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
      // Polls while unfocused too: a waiting agent must notify within seconds.
      if (busy) {
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
        status: mapStatus(agent?.status ?? pane.agentStatus, !!agent),
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
      // Same id with another label means herdr reused it for a different project's workspace.
      if (known.some(w => w.workspaceId === project.workspaceId && w.label === project.name)) {
        return { workspaceId: project.workspaceId };
      }
    }
    const created = await this.herdr.workspaceCreate(project.path, project.name);
    await this.store.update(d => setWorkspaceId(d, project.id, created.workspaceId));
    return { workspaceId: created.workspaceId, rootPane: created.rootPane };
  }

  /** The worktree's herdr workspace, opened again if herdr closed it with its last pane. */
  private async ensureWorktreeWorkspace(
    project: Project,
    worktree: WorktreeInfo,
  ): Promise<{ workspaceId: string; rootPane?: PaneInfo }> {
    const open = (await this.herdr.workspaceList()).find(
      w => w.checkoutPath && samePath(w.checkoutPath, worktree.path),
    );
    if (open) {
      return { workspaceId: open.workspaceId };
    }
    return this.herdr.worktreeOpen(project.path, worktree.path);
  }

  /**
   * Starts a session in its own herdr tab and opens it. The first session of a new
   * workspace reuses the root pane herdr creates with it instead of leaving a stray shell;
   * so does a session started in `pane`, the root pane of a worktree just created.
   */
  async start(
    c: Checkout,
    preset: Preset,
    options: { name?: string; open?: boolean; pane?: PaneInfo } = {},
  ): Promise<SessionInfo | undefined> {
    await this.herdr.ensureServer();
    let pane = options.pane;
    if (!pane) {
      const { workspaceId, rootPane } = c.worktree
        ? await this.ensureWorktreeWorkspace(c.project, c.worktree)
        : await this.ensureWorkspace(c.project);
      pane = rootPane ?? (await this.herdr.tabCreate(workspaceId, checkoutPath(c)));
    }
    if (preset.kind) {
      const taken = (await this.herdr.agentList()).flatMap(a => (a.name ? [a.name] : []));
      const base = c.worktree?.branch ?? c.project.name;
      await this.herdr.agentStart(options.name ?? nextAgentName(base, taken), preset.kind, pane.paneId);
    }
    await this.refresh();
    const session = this.findSession(pane.paneId);
    if (session && (options.open ?? true)) {
      this.show(session);
    }
    return session;
  }

  // --- terminals -----------------------------------------------------------

  private location(): TerminalLocation {
    return vscode.workspace.getConfiguration('paddock').get<TerminalLocation>('terminalLocation') === 'panel'
      ? 'panel'
      : 'editor';
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
    const checkout = this.checkoutOfWorkspace(session.workspaceId) ?? this.currentCheckout();
    const key = checkout ? checkoutKey(checkout) : '';
    this.terminals.set(session.paneId, { terminal, pty, session: open, name: session.name, key });
    void this.saveLayout(key, upsert(this.layouts[key] ?? [], open));
    terminal.show(options.preserveFocus);
    this.changed.fire();
  }

  private closed(paneId: string): void {
    const open = this.terminals.get(paneId);
    this.terminals.delete(paneId);
    if (open && !this.leaving) {
      void this.saveLayout(open.key, remove(this.layouts[open.key] ?? [], paneId));
      // The pane may be gone (the shell exited); drop it from the sidebar.
      void this.refresh();
    }
    this.changed.fire();
  }

  private saveLayout(key: string, layout: OpenSession[]): Thenable<void> {
    this.layouts = { ...this.layouts, [key]: layout };
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
    const current = this.currentCheckout();
    if (!current || (!current.worktree && !current.project.workspaceId)) {
      return;
    }
    const key = checkoutKey(current);
    await this.refresh();
    const panes = this.sessionsIn(current);
    for (const saved of restorable(this.layouts[key] ?? [], panes)) {
      const session = panes.find(p => p.paneId === saved.paneId);
      if (session) {
        // Reopen where the setting says, not where the terminal was last time.
        this.show(session, { preserveFocus: true });
      }
    }
    const pending = this.context.globalState.get<PendingOpen>(PENDING_KEY);
    if (pending?.key === key) {
      await this.context.globalState.update(PENDING_KEY, undefined);
      const session = panes.find(p => p.paneId === pending.paneId);
      if (session) {
        this.show(session);
      }
    }
  }

  /** Reopens the project or worktree folder in this same window; its sessions reattach after the reload. */
  async switchTo(c: Checkout, open?: SessionInfo): Promise<void> {
    if (open) {
      await this.context.globalState.update(PENDING_KEY, {
        key: checkoutKey(c),
        paneId: open.paneId,
      } satisfies PendingOpen);
    }
    if (this.switchMode() === 'swap') {
      await this.swapTo(c);
      return;
    }
    this.markLeaving();
    try {
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(checkoutPath(c)), {
        forceNewWindow: false,
      });
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
  private async swapTo(c: Checkout): Promise<void> {
    const target = { uri: vscode.Uri.file(checkoutPath(c)), name: checkoutName(c) };
    await mkdir(this.placeholder, { recursive: true });

    if (!this.isSwapWindow()) {
      // One-time conversion into a saved workspace file (an untitled one makes VS Code ask
      // to save it on every close). Opening it reloads the window once; the pending-open
      // request stored by switchTo() finishes the job afterwards.
      const file = vscode.Uri.file(path.join(this.context.globalStorageUri.fsPath, 'Paddock.code-workspace'));
      const content = {
        folders: [
          { name: 'Paddock', path: this.placeholder },
          { name: target.name, path: target.uri.fsPath },
        ],
      };
      await writeFile(file.fsPath, JSON.stringify(content, null, '\t') + '\n');
      this.markLeaving();
      try {
        await vscode.commands.executeCommand('vscode.openFolder', file, { forceNewWindow: false });
      } finally {
        this.leaving = false;
      }
      return;
    }
    if (this.isCurrent(c)) {
      return;
    }

    // Save the old project's open files and close them, so they do not follow us into the next project.
    // Closing can prompt about unsaved changes; cancelling stops the switch.
    const previous = this.currentCheckout();
    if (previous) {
      const { snapshot, tabs } = await captureEditors();
      // Unsaved edits travel in the snapshot; revert the tabs so closing them does not ask.
      await revertStashed(snapshot);
      if (!(await closeEditors(tabs))) {
        await restoreEditors(snapshot);
        throw new Error('Switch cancelled: save or discard your unsaved changes first');
      }
      await this.saveEditors(checkoutKey(previous), snapshot);
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
    // VS Code answers false while an earlier folder update is still unconfirmed (and for
    // invalid ranges or duplicate folders), so retry briefly before giving up.
    let started = false;
    for (let attempt = 0; attempt < 20 && !started; attempt++) {
      const now = vscode.workspace.workspaceFolders ?? [];
      started = vscode.workspace.updateWorkspaceFolders(1, Math.max(now.length - 1, 0), target);
      if (!started) {
        await new Promise(r => setTimeout(r, 100));
      }
    }
    if (!started) {
      const now = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath).join(', ');
      throw new Error(
        `VS Code refused to swap the project folder (target ${target.uri.fsPath}; window folders: ${now})`,
      );
    }
    await changed;
    await restoreEditors(this.editors[checkoutKey(c)]);
    await this.restore();
    await this.refresh();
  }

  private saveEditors(key: string, snapshot: EditorSnapshot): Thenable<void> {
    this.editors = { ...this.editors, [key]: snapshot };
    return this.context.workspaceState.update(EDITORS_KEY, this.editors);
  }

  /** Opens a session, switching project first when it belongs to another one. */
  async openSession(session: SessionInfo): Promise<void> {
    const checkout = this.checkoutOfWorkspace(session.workspaceId);
    if (checkout && !this.isCurrent(checkout)) {
      await this.switchTo(checkout, session);
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
    const checkout = this.checkoutOfWorkspace(session.workspaceId);
    if (checkout) {
      const key = checkoutKey(checkout);
      await this.saveLayout(key, remove(this.layouts[key] ?? [], session.paneId));
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
  async restart(session: SessionInfo, c: Checkout): Promise<void> {
    await this.kill(session);
    const preset: Preset = { label: session.name, kind: session.kind };
    await this.start(c, preset, { name: session.kind ? session.name : undefined });
  }

  // --- worktrees -----------------------------------------------------------

  /**
   * Creates a worktree on `branch` (a new branch when none exists) through herdr, which
   * puts the checkout under its worktrees directory and opens a workspace on it.
   */
  async createWorktree(project: Project, branch: string): Promise<{ checkout: Checkout; rootPane?: PaneInfo }> {
    await this.herdr.ensureServer();
    const { worktree, rootPane } = await this.herdr.worktreeCreate(project.path, branch);
    await this.refreshWorktrees();
    await this.refresh();
    return { checkout: { project, worktree }, rootPane };
  }

  /**
   * Removes a linked worktree's checkout and closes its workspace, stopping its sessions.
   * The branch stays. With uncommitted changes it asks before forcing.
   *
   * When this window has the worktree open, it first switches to the project's own folder.
   * A reload ends this extension host mid-switch, so the removal is stored and finished by
   * finishPendingRemove() after the reload; a swap in place carries on here.
   */
  async removeWorktree(c: Checkout): Promise<void> {
    if (!c.worktree) {
      throw new Error('Only a linked worktree can be removed');
    }
    if (this.isCurrent(c)) {
      const pending: PendingRemove = { projectId: c.project.id, worktreePath: c.worktree.path, at: Date.now() };
      await this.context.globalState.update(PENDING_REMOVE_KEY, pending);
      await this.switchTo({ project: c.project });
      if (this.isCurrent(c)) {
        // The window is reloading (or the switch was cancelled); finishPendingRemove() decides.
        return;
      }
      await this.context.globalState.update(PENDING_REMOVE_KEY, undefined);
    }
    await this.removeNow(c.project, c.worktree);
  }

  /** Finishes a removal that switched this window away from the worktree first. */
  async finishPendingRemove(): Promise<void> {
    const pending = this.context.globalState.get<PendingRemove>(PENDING_REMOVE_KEY);
    if (!pending) {
      return;
    }
    await this.context.globalState.update(PENDING_REMOVE_KEY, undefined);
    const current = this.currentCheckout();
    const target = this.checkout(pending.projectId, pending.worktreePath);
    // Only when the switch landed on the project's own folder; anything else means it did not go through.
    const fresh = Date.now() - pending.at < PENDING_REMOVE_TTL_MS;
    if (!fresh || !target?.worktree || current?.project.id !== pending.projectId || current.worktree) {
      return;
    }
    await this.removeNow(target.project, target.worktree);
  }

  private async removeNow(project: Project, worktree: WorktreeInfo): Promise<void> {
    const c: Checkout = { project, worktree };
    await this.herdr.ensureServer();
    // herdr removes through the worktree's workspace, so open one if herdr closed it.
    const { workspaceId, rootPane } = await this.ensureWorktreeWorkspace(project, worktree);
    try {
      await this.herdr.worktreeRemove(workspaceId, false);
    } catch (e) {
      if (!(e instanceof HerdrError && e.code === 'dirty_worktree_requires_force')) {
        throw e;
      }
      const force = await vscode.window.showWarningMessage(
        `${checkoutName(c)} has uncommitted or untracked changes.`,
        { modal: true, detail: 'Removing it anyway deletes those changes. The branch and its commits are kept.' },
        'Remove Anyway',
      );
      if (force !== 'Remove Anyway') {
        if (rootPane) {
          // Opened only to remove it; do not leave a stray shell behind.
          await this.herdr.paneClose(rootPane.paneId);
        }
        await this.refresh();
        return;
      }
      await this.herdr.worktreeRemove(workspaceId, true);
    }
    // herdr closed the workspace and its panes; drop their tabs too.
    for (const s of this.bySession.get(workspaceId) ?? []) {
      this.dispose(s.paneId);
    }
    const key = checkoutKey(c);
    this.layouts = Object.fromEntries(Object.entries(this.layouts).filter(([k]) => k !== key));
    this.editors = Object.fromEntries(Object.entries(this.editors).filter(([k]) => k !== key));
    await this.context.workspaceState.update(LAYOUTS_KEY, this.layouts);
    await this.context.workspaceState.update(EDITORS_KEY, this.editors);
    await this.refreshWorktrees();
    await this.refresh();
    void vscode.window.showInformationMessage(`Removed worktree ${checkoutName(c)}. The branch is kept.`);
  }
}
