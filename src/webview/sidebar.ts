/// <reference lib="dom" />
// Draws the Projects sidebar inside its webview. Runs in the browser; talks to the host only through messages.

import type {
  CheckoutRow,
  GroupRow,
  Node,
  ProjectRow,
  RowState,
  SessionRow,
  ToHost,
  ToView,
  ViewModel,
} from '../tree/model';

interface VsCodeApi {
  postMessage(message: ToHost): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

interface ViewState {
  /** Row keys the user expanded or collapsed; rows not listed use their default. */
  expanded: Record<string, boolean>;
  focus?: string;
}

/** Mirrors `UNGROUPED_ID` in store.ts, which cannot be bundled into the webview. */
const UNGROUPED_ID = 'ungrouped';

const vscode = acquireVsCodeApi();
const root = document.getElementById('root') as HTMLElement;
const saved = vscode.getState() as Partial<ViewState> | undefined;
const state: ViewState = { expanded: saved?.expanded ?? {}, focus: saved?.focus };
let model: ViewModel | undefined;
let lastModel = '';

const send = (m: ToHost) => vscode.postMessage(m);
const save = () => vscode.setState(state);

// --- icons -----------------------------------------------------------------

const svg = (body: string, cls = 'ico') =>
  `<svg class="${cls}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

const ICON = {
  chevron: svg('<path d="M6 4l4 4-4 4"/>', 'ico chev'),
  group: svg(
    '<rect x="2" y="2.5" width="5" height="4" rx="1"/><path d="M4.5 6.5v6.5h4M4.5 9.5h4"/><rect x="9" y="7.5" width="5" height="3.5" rx="1"/><rect x="9" y="11.5" width="5" height="3" rx="1"/>',
  ),
  folder: svg(
    '<path d="M1.8 4.2c0-.7.5-1.2 1.2-1.2h3l1.5 1.7H13c.7 0 1.2.5 1.2 1.2v6.4c0 .7-.5 1.2-1.2 1.2H3c-.7 0-1.2-.5-1.2-1.2z"/>',
  ),
  folderOpen: svg(
    '<path d="M1.8 12V4.2c0-.7.5-1.2 1.2-1.2h3l1.5 1.7H12c.7 0 1.2.5 1.2 1.2V7"/><path d="M1.8 12.3l1.9-4.6c.2-.4.6-.7 1-.7h9.6c.5 0 .8.5.6 1l-1.8 4.2c-.2.4-.6.6-1 .6H2.3"/>',
  ),
  plus: svg('<path d="M8 3v10M3 8h10"/>'),
  newGroup: svg(
    '<path d="M1.8 12V4.2c0-.7.5-1.2 1.2-1.2h3l1.5 1.7H13c.7 0 1.2.5 1.2 1.2v2"/><path d="M1.8 12c0 .7.5 1.2 1.2 1.2h5M12 9.5v5M9.5 12h5"/>',
  ),
  branch: svg(
    '<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="5.5" r="1.5"/><path d="M4.5 5v6M11.5 7c0 3-4.5 2.5-7 4"/>',
  ),
  trash: svg('<path d="M2.5 4.5h11M6 4.5V3h4v1.5M4 4.5l.7 9h6.6l.7-9"/>'),
  more: svg(
    '<circle cx="3.5" cy="8" r=".6" fill="currentColor"/><circle cx="8" cy="8" r=".6" fill="currentColor"/><circle cx="12.5" cy="8" r=".6" fill="currentColor"/>',
  ),
  terminal: svg('<rect x="1.8" y="2.5" width="12.4" height="11" rx="1.5"/><path d="M4.5 6l2 2-2 2M8 10.5h3.5"/>'),
  check: svg('<circle cx="8" cy="8" r="6"/><path d="M5.5 8.2l1.7 1.7 3.3-3.6"/>', 'ico st done'),
  waiting: svg('<path d="M4.5 11V7.5a3.5 3.5 0 0 1 7 0V11l1 1.2h-9z"/><path d="M6.8 14h2.4"/>', 'ico st waiting'),
  running: svg(
    '<circle cx="8" cy="8" r="5.5" opacity=".3"/><path d="M8 2.5a5.5 5.5 0 0 1 5.5 5.5"/>',
    'ico st running spin',
  ),
  claude: svg(
    '<path d="M8 1.8v12.4M1.8 8h12.4M3.6 3.6l8.8 8.8M12.4 3.6l-8.8 8.8" stroke-width="1.8"/>',
    'ico agent claude',
  ),
  codex: svg(
    '<path d="M8 1.8l5.4 3.1v6.2L8 14.2l-5.4-3.1V4.9z"/><path d="M5.8 6.8L7.6 8 5.8 9.2M8.6 10h1.8"/>',
    'ico agent codex',
  ),
};

const stateIcon: Record<RowState, string> = {
  done: ICON.check,
  waiting: ICON.waiting,
  running: ICON.running,
  idle: '',
};
const shellDot = '<span class="dot shell" aria-hidden="true"></span>';
const STATE_WORD: Record<RowState, string> = {
  done: 'done',
  waiting: 'waiting',
  running: 'running',
  idle: 'no sessions',
};

function agentGlyph(kind: string | undefined): string {
  if (!kind) {
    return ICON.terminal.replace('class="ico"', 'class="ico agent shell"');
  }
  if (kind === 'claude' || kind === 'codex') {
    return ICON[kind];
  }
  return `<span class="ico agent letter" aria-hidden="true">${esc(kind.charAt(0).toUpperCase())}</span>`;
}

// --- rendering -------------------------------------------------------------

function esc(s: string): string {
  return s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
}

const json = (v: unknown) => esc(JSON.stringify(v));

/** Context keys for the native right-click menu; commands receive this object as their node. */
function menuContext(node: Node, section: string): string {
  return json({ ...node, webviewSection: section, preventDefaultContextMenuItems: true });
}

function nodeKey(n: Node): string {
  return n.kind === 'group' || n.kind === 'project' ? `${n.kind}:${n.id}` : `${n.kind}:${n.projectId}:${n.id}`;
}

function isExpanded(key: string, fallback: boolean): boolean {
  return state.expanded[key] ?? fallback;
}

function action(command: string, title: string, icon: string): string {
  return `<button class="act" data-cmd="${command}" title="${title}" aria-label="${title}" tabindex="-1">${icon}</button>`;
}

const menuButton = `<button class="act" data-menu title="More actions" aria-label="More actions" tabindex="-1">${ICON.more}</button>`;

interface RowOpts {
  key: string;
  node?: Node;
  section?: string;
  level: number;
  cls: string;
  expanded?: boolean;
  parent?: string;
  title?: string;
  label: string;
  extra?: string;
}

function rowAttrs(o: RowOpts): string {
  const attrs = [
    `class="row ${o.cls}"`,
    `data-key="${esc(o.key)}"`,
    `role="treeitem"`,
    `aria-level="${o.level}"`,
    `aria-label="${esc(o.label)}"`,
    `tabindex="-1"`,
    `data-level="${o.level}"`,
  ];
  if (o.node) {
    attrs.push(`data-node="${json(o.node)}"`);
  }
  if (o.node && o.section) {
    attrs.push(`data-vscode-context="${menuContext(o.node, o.section)}"`);
  }
  if (o.expanded !== undefined) {
    attrs.push(`aria-expanded="${o.expanded}"`);
  }
  if (o.parent) {
    attrs.push(`data-parent="${esc(o.parent)}"`);
  }
  if (o.title) {
    attrs.push(`title="${esc(o.title)}"`);
  }
  if (o.extra) {
    attrs.push(o.extra);
  }
  return attrs.join(' ');
}

function pill(cls: string, text: string): string {
  return `<span class="pill ${cls}">${esc(text)}</span>`;
}

function renderGroup(g: GroupRow, nextId: string | undefined): string {
  const key = nodeKey(g.node);
  const open = !g.collapsed;
  const badge =
    !open && g.waiting ? pill('waiting', `${g.waiting} waiting`) : `<span class="count">${g.projects.length}</span>`;
  let h = `<div ${rowAttrs({ key, node: g.node, section: 'group', level: 1, cls: 'group', expanded: open, label: g.name, extra: `draggable="true" data-drag="group" data-next="${esc(nextId ?? '')}"` })}>
		<span class="twist">${ICON.chevron}</span>${ICON.group}<span class="name">${esc(g.name)}</span>${badge}
		<span class="actions">${action('paddock.addProject', 'Add project to group', ICON.plus)}</span></div>`;
  if (open) {
    h += '<div class="children" role="group">';
    if (!g.projects.length) {
      h += `<div class="hint" data-level="2" data-drop-group="${esc(g.node.id)}">Drag projects here</div>`;
    }
    g.projects.forEach((p, i) => (h += renderProject(p, 2, key, g.projects[i + 1]?.node.id)));
    h += '</div>';
  }
  return h;
}

function renderProject(p: ProjectRow, level: number, parent: string | undefined, nextId: string | undefined): string {
  const key = nodeKey(p.node);
  const hasChildren = p.checkouts.length > 0 || p.sessions.length > 0;
  const open = hasChildren && isExpanded(key, p.current);
  const badge = p.waiting ? pill('waiting', `${p.waiting} waiting`) : p.done ? pill('done', `${p.done} done`) : '';
  let h = `<div ${rowAttrs({
    key,
    node: p.node,
    section: 'project',
    level,
    parent,
    cls: `project${p.current ? ' current' : ''}`,
    expanded: hasChildren ? open : undefined,
    title: p.path,
    label: p.name,
    extra: `draggable="true" data-drag="project" data-group="${esc(p.groupId)}" data-next="${esc(nextId ?? '')}"`,
  })}>
		<span class="twist">${hasChildren ? ICON.chevron : ''}</span>${p.current ? ICON.folderOpen : ICON.folder}<span class="name">${esc(p.name)}</span>${badge}
		<span class="actions">${action('paddock.newSession', 'New session', ICON.plus)}${action('paddock.newWorktree', 'New worktree', ICON.branch)}${menuButton}</span></div>`;
  if (!open) {
    return h;
  }
  for (const c of p.checkouts) {
    h += renderCheckout(c, level + 1, key);
  }
  if (p.sessions.length) {
    h += `<div class="card${p.current ? ' current' : ''}" data-level="${level + 1}">${renderSessions(p.sessions, `sessions:${p.node.id}`, level + 1, key, p.current)}</div>`;
  }
  return h;
}

function renderCheckout(c: CheckoutRow, level: number, parent: string): string {
  const key = nodeKey(c.node);
  const section = c.primary ? 'mainWorktree' : 'worktree';
  const actions =
    action('paddock.newSession', 'New session', ICON.plus) +
    (c.primary ? '' : action('paddock.removeWorktree', 'Remove worktree', ICON.trash));
  let h = `<div class="card${c.current ? ' current' : ''}" data-level="${level}">`;
  h += `<div ${rowAttrs({ key, node: c.node, section, level, parent, cls: `checkout${c.current ? ' current' : ''}`, title: c.shownPath, label: `${c.label}${c.primary ? ', primary' : ''}, ${c.branch}, ${STATE_WORD[c.state]}` })}>
		<span class="dot ${c.state}" title="${STATE_WORD[c.state]}"></span>
		<span class="lines"><span class="l1"><span class="name">${esc(c.label)}</span>${c.primary ? '<span class="chip">primary</span>' : ''}</span><span class="l2">${esc(c.branch)}</span></span>
		<span class="actions">${actions}</span></div>`;
  if (c.sessions.length) {
    h += renderSessions(c.sessions, `sessions:${c.node.id}`, level + 1, key, c.current);
  }
  return h + '</div>';
}

/**
 * One session shows as a single row. Several show as a strip (state, first agent, +N) that
 * expands into an "N agents" header with one row per session.
 */
function renderSessions(sessions: SessionRow[], key: string, level: number, parent: string, current: boolean): string {
  if (sessions.length === 1) {
    return renderSession(sessions[0], level, parent);
  }
  const open = isExpanded(key, current);
  const order: RowState[] = ['waiting', 'running', 'done'];
  const counts = order
    .map(s => [s, sessions.filter(x => x.state === s).length] as const)
    .filter(([, n]) => n)
    .map(([s, n]) => `${n} ${s}`);
  const shells = sessions.filter(s => !s.kind).length;
  const summary = [...counts, ...(shells ? [`${shells} shell${shells > 1 ? 's' : ''}`] : [])].join(', ');
  const noun = `${sessions.length} ${sessions.every(s => !s.kind) ? 'shells' : 'agents'}`;
  let body: string;
  if (open) {
    body = `<span class="heading">${noun}</span>`;
  } else {
    const lead = order.find(s => sessions.some(x => x.state === s)) ?? 'idle';
    const first = sessions.find(s => s.kind) ?? sessions[0];
    body = `<span class="agents">${stateIcon[lead]}<span class="glyph">${agentGlyph(first.kind)}</span><span class="more">+${sessions.length - 1}</span></span>`;
  }
  let h = `<div ${rowAttrs({ key, level, parent, cls: `strip${open ? ' open' : ''}`, expanded: open, label: `${noun}: ${summary}`, title: summary })}>
		${body}<span class="spacer"></span><span class="twist">${ICON.chevron}</span></div>`;
  if (open) {
    for (const s of sessions) {
      h += renderSession(s, level, key);
    }
  }
  return h;
}

const TITLE: Record<RowState, string> = { done: 'Done', waiting: 'Waiting', running: 'Running', idle: 'Shell' };

function renderSession(s: SessionRow, level: number, parent: string): string {
  const label = `${TITLE[s.state]} - ${s.name}`;
  const title = `${s.name}, ${s.kind ?? 'shell'}${s.kind ? `, ${s.state}` : ''}${s.open ? ', open' : ''}`;
  return `<div ${rowAttrs({ key: nodeKey(s.node), node: s.node, section: 'session', level, parent, cls: `session ${s.state}${s.open ? ' open' : ''}`, label: title, title })}>
		<span class="lead">${s.kind ? stateIcon[s.state] : shellDot}</span><span class="glyph">${agentGlyph(s.kind)}</span><span class="name">${esc(label)}</span>
		<span class="actions">${menuButton}</span></div>`;
}

function render(): void {
  if (!model) {
    return;
  }
  if (!model.groups.length && !model.projects.length) {
    root.innerHTML = `<div class="empty"><p>No projects yet.</p>
			<button class="primary" data-cmd="paddock.addProject">Add project</button>
			<button class="secondary" data-cmd="paddock.newGroup">New group</button></div>`;
    return;
  }
  // Always visible: VS Code shows the view's title-bar actions only on hover.
  let h = `<div class="toolbar">
		<button class="tool" data-cmd="paddock.addProject" title="Add project">${ICON.plus}<span>Add project</span></button>
		<button class="tool" data-cmd="paddock.newGroup" title="New group">${ICON.newGroup}<span>New group</span></button></div>`;
  model.groups.forEach((g, i) => (h += renderGroup(g, model?.groups[i + 1]?.node.id)));
  model.projects.forEach((p, i) => (h += renderProject(p, 1, undefined, model?.projects[i + 1]?.node.id)));
  const hadFocus = root.contains(document.activeElement);
  root.innerHTML = h + '<div class="tail" data-tail></div>';
  const rows = visibleRows();
  const focus = rows.find(r => r.dataset.key === state.focus) ?? rows[0];
  focus?.setAttribute('tabindex', '0');
  if (hadFocus) {
    focus?.focus();
  }
}

// --- interaction -----------------------------------------------------------

function visibleRows(): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('.row')];
}

function nodeOf(row: HTMLElement): Node | undefined {
  return row.dataset.node ? (JSON.parse(row.dataset.node) as Node) : undefined;
}

function run(command: string, node?: Node): void {
  send({ type: 'command', command, node });
}

function setExpanded(row: HTMLElement, open: boolean): void {
  const key = row.dataset.key;
  if (!key || row.getAttribute('aria-expanded') === null || row.getAttribute('aria-expanded') === String(open)) {
    return;
  }
  const node = nodeOf(row);
  if (node?.kind === 'group') {
    send({ type: 'collapse', groupId: node.id, collapsed: !open });
    row.setAttribute('aria-expanded', String(open));
    return;
  }
  state.expanded[key] = open;
  save();
  render();
}

function toggle(row: HTMLElement): void {
  setExpanded(row, row.getAttribute('aria-expanded') !== 'true');
}

/** What clicking a row (or pressing Enter on it) does. */
function activate(row: HTMLElement): void {
  const node = nodeOf(row);
  switch (node?.kind) {
    case 'project':
      if (row.classList.contains('current')) {
        toggle(row);
      } else {
        run('paddock.openProject', node);
      }
      return;
    case 'worktree':
      if (!row.classList.contains('current')) {
        run('paddock.openWorktree', node);
      }
      return;
    case 'session':
      run('paddock.openSession', node);
      return;
    default:
      toggle(row);
  }
}

function focusRow(row: HTMLElement | undefined): void {
  if (!row) {
    return;
  }
  for (const r of root.querySelectorAll<HTMLElement>('.row[tabindex="0"]')) {
    r.setAttribute('tabindex', '-1');
  }
  row.setAttribute('tabindex', '0');
  row.focus();
  state.focus = row.dataset.key;
  save();
}

/** Opens VS Code's native context menu for the row, as a right-click would. */
function openMenu(row: HTMLElement, at?: HTMLElement): void {
  const r = (at ?? row).getBoundingClientRect();
  row.dispatchEvent(
    new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: r.left + r.width / 2,
      clientY: r.bottom,
    }),
  );
}

root.addEventListener('click', e => {
  const target = e.target as HTMLElement;
  const button = target.closest<HTMLElement>('button');
  const row = target.closest<HTMLElement>('.row');
  if (button?.dataset.cmd) {
    e.stopPropagation();
    run(button.dataset.cmd, row ? nodeOf(row) : undefined);
    return;
  }
  if (button && 'menu' in button.dataset && row) {
    e.stopPropagation();
    openMenu(row, button);
    return;
  }
  if (!row) {
    return;
  }
  focusRow(row);
  if (target.closest('.twist') && row.hasAttribute('aria-expanded')) {
    toggle(row);
  } else {
    activate(row);
  }
});

root.addEventListener('focusin', e => {
  const row = (e.target as HTMLElement).closest<HTMLElement>('.row');
  if (row && row.dataset.key !== state.focus) {
    focusRow(row);
  }
});

root.addEventListener('keydown', e => {
  const row = (e.target as HTMLElement).closest<HTMLElement>('.row');
  if (!row) {
    return;
  }
  const rows = visibleRows();
  const i = rows.indexOf(row);
  const expanded = row.getAttribute('aria-expanded');
  let handled = true;
  switch (e.key) {
    case 'ArrowDown':
      focusRow(rows[i + 1]);
      break;
    case 'ArrowUp':
      focusRow(rows[i - 1]);
      break;
    case 'Home':
      focusRow(rows[0]);
      break;
    case 'End':
      focusRow(rows[rows.length - 1]);
      break;
    case 'ArrowRight':
      if (expanded === 'false') {
        setExpanded(row, true);
      } else if (expanded === 'true') {
        focusRow(rows[i + 1]);
      }
      break;
    case 'ArrowLeft':
      if (expanded === 'true') {
        setExpanded(row, false);
      } else {
        focusRow(rows.find(r => r.dataset.key === row.dataset.parent));
      }
      break;
    case 'Enter':
    case ' ':
      activate(row);
      break;
    case 'ContextMenu':
      openMenu(row);
      break;
    case 'F10':
      if (e.shiftKey) {
        openMenu(row);
      } else {
        handled = false;
      }
      break;
    default:
      handled = false;
  }
  if (handled) {
    e.preventDefault();
    e.stopPropagation();
  }
});

// Empty-state buttons sit outside any row.
document.addEventListener('click', e => {
  const button = (e.target as HTMLElement).closest<HTMLElement>('.empty button');
  if (button?.dataset.cmd) {
    run(button.dataset.cmd);
  }
});

// --- drag and drop ---------------------------------------------------------
// A project dropped on the top half of a project goes before it, on the bottom half after it,
// on a group into the end of that group, below the list to the end of the top level.
// A group dropped on a group goes before or after it, below the list to the end.

interface Dragging {
  kind: 'project' | 'group';
  id: string;
}

let dragging: Dragging | undefined;
let marked: HTMLElement | undefined;

function mark(el: HTMLElement | undefined, cls?: string): void {
  marked?.classList.remove('drop-before', 'drop-after', 'drop-into');
  marked = el;
  if (el && cls) {
    el.classList.add(cls);
  }
}

type Drop = { el: HTMLElement; cls: string; message: ToHost };

function dropAt(e: DragEvent): Drop | undefined {
  if (!dragging) {
    return undefined;
  }
  const target = e.target as HTMLElement;
  if (target.closest('[data-tail]')) {
    const el = target.closest<HTMLElement>('[data-tail]') as HTMLElement;
    return dragging.kind === 'project'
      ? { el, cls: 'drop-into', message: { type: 'moveProjects', ids: [dragging.id], groupId: UNGROUPED_ID } }
      : { el, cls: 'drop-into', message: { type: 'moveGroups', ids: [dragging.id] } };
  }
  const hint = target.closest<HTMLElement>('[data-drop-group]');
  if (hint && dragging.kind === 'project') {
    return {
      el: hint,
      cls: 'drop-into',
      message: { type: 'moveProjects', ids: [dragging.id], groupId: hint.dataset.dropGroup ?? '' },
    };
  }
  const row = target.closest<HTMLElement>('.row[data-drag]');
  const node = row && nodeOf(row);
  if (!row || !node || node.id === dragging.id) {
    return undefined;
  }
  const r = row.getBoundingClientRect();
  const after = e.clientY > r.top + r.height / 2;
  const before = after ? row.dataset.next || undefined : node.id;
  const cls = after ? 'drop-after' : 'drop-before';
  if (dragging.kind === 'group') {
    return node.kind === 'group' && before !== dragging.id
      ? { el: row, cls, message: { type: 'moveGroups', ids: [dragging.id], before } }
      : undefined;
  }
  if (node.kind === 'group') {
    return { el: row, cls: 'drop-into', message: { type: 'moveProjects', ids: [dragging.id], groupId: node.id } };
  }
  return before === dragging.id
    ? undefined
    : { el: row, cls, message: { type: 'moveProjects', ids: [dragging.id], groupId: row.dataset.group ?? '', before } };
}

root.addEventListener('dragstart', e => {
  const row = (e.target as HTMLElement).closest<HTMLElement>('.row[data-drag]');
  const node = row && nodeOf(row);
  if (!row || !node || (node.kind !== 'project' && node.kind !== 'group')) {
    return;
  }
  dragging = { kind: node.kind, id: node.id };
  e.dataTransfer?.setData('application/x-paddock', node.id);
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move';
  }
  row.classList.add('dragging');
});

root.addEventListener('dragover', e => {
  const drop = dropAt(e);
  mark(drop?.el, drop?.cls);
  if (drop) {
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'move';
    }
  }
});

root.addEventListener('drop', e => {
  const drop = dropAt(e);
  mark(undefined);
  if (drop) {
    e.preventDefault();
    send(drop.message);
  }
});

root.addEventListener('dragend', () => {
  dragging = undefined;
  mark(undefined);
  render();
});

// --- host messages ---------------------------------------------------------

window.addEventListener('message', (e: MessageEvent<ToView>) => {
  if (e.data?.type === 'model') {
    const next = JSON.stringify(e.data.model);
    if (next === lastModel) {
      return;
    }
    lastModel = next;
    model = e.data.model;
    // Replacing rows mid-drag would drop the dragged element; draw once the drag ends.
    if (!dragging) {
      render();
    }
  }
});

send({ type: 'ready' });
