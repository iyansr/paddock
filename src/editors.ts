import { createHash } from 'node:crypto';
import * as path from 'node:path';

import * as vscode from 'vscode';

// Open files per project. In a multi-root window VS Code keeps one editor state for the
// whole window, so Paddock saves a project's files when switching away and reopens them
// when switching back. Plain files, custom editors (image viewers and the like), notebooks
// and Markdown previews are handled; terminals, diffs, settings pages and other webviews
// are left alone.

/** Unsaved edits kept with the project. Nothing is written to the file on disk. */
export interface Unsaved {
  text: string;
  /** Hash of the file on disk when the edits were stashed; if it differs on return, the edits are not applied over it. */
  baseHash: string;
}

/** Larger buffers are not stashed; the user gets VS Code's own save prompt instead. */
const MAX_UNSAVED_CHARS = 1_000_000;

export interface TabSnapshot {
  uri: string;
  /** How the tab shows `uri`; absent for a plain text editor (and in snapshots saved before this field). */
  kind?: 'custom' | 'notebook' | 'markdownPreview';
  /** Editor id for `custom` and `notebook` tabs. */
  viewType?: string;
  /** A Markdown preview locked to its file. */
  locked?: boolean;
  unsaved?: Unsaved;
  selection?: { anchor: [number, number]; active: [number, number] };
}

export interface GroupSnapshot {
  viewColumn: number;
  tabs: TabSnapshot[];
  /** tabKey() of the tab that was showing in this group. */
  active?: string;
}

export interface EditorSnapshot {
  groups: GroupSnapshot[];
  activeColumn?: number;
}

export type EditorSnapshots = Record<string, EditorSnapshot>;

export const EDITORS_KEY = 'paddock.editors';

function isFileTab(tab: vscode.Tab): tab is vscode.Tab & { input: vscode.TabInputText } {
  return tab.input instanceof vscode.TabInputText && tab.input.uri.scheme === 'file';
}

/** Tells a Markdown preview apart from its source file, which has the same uri. */
export function tabKey(tab: TabSnapshot): string {
  return tab.kind ? `${tab.kind}:${tab.uri}` : tab.uri;
}

async function diskHash(uri: vscode.Uri): Promise<string> {
  const bytes = await vscode.workspace.fs.readFile(uri);
  return createHash('sha1').update(bytes).digest('hex');
}

// The Markdown extension titles its previews "Preview README.md" or "[Preview] README.md" when locked.
const PREVIEW_LABEL = /^(\[Preview\] |Preview )(.+)$/;

/**
 * The file a Markdown preview shows. The tab only carries its title, so the file is looked
 * up by name: an open file tab first, then the workspace. Undefined when it is not unique.
 */
async function previewSource(name: string, fileTabs: vscode.Uri[]): Promise<vscode.Uri | undefined> {
  const open = fileTabs.filter(u => path.basename(u.fsPath) === name);
  if (open.length) {
    return open.every(u => u.toString() === open[0].toString()) ? open[0] : undefined;
  }
  if (/[*?{}[\]]/.test(name)) {
    return undefined;
  }
  const found = await vscode.workspace.findFiles(`**/${name}`, '**/node_modules/**', 2);
  return found.length === 1 ? found[0] : undefined;
}

/** The snapshot of a tab Paddock moves with the project, or undefined for one it leaves alone. */
async function snapshotTab(tab: vscode.Tab, column: number, fileTabs: vscode.Uri[]): Promise<TabSnapshot | undefined> {
  const input = tab.input;
  if (isFileTab(tab)) {
    const uri = tab.input.uri;
    const doc = tab.isDirty ? vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString()) : undefined;
    let unsaved: Unsaved | undefined;
    if (doc && doc.getText().length <= MAX_UNSAVED_CHARS) {
      try {
        unsaved = { text: doc.getText(), baseHash: await diskHash(uri) };
      } catch {
        // A file that cannot be read from disk (a new, never-saved path) is not stashed.
      }
    }
    const editor = vscode.window.visibleTextEditors.find(
      e => e.viewColumn === column && e.document.uri.toString() === uri.toString(),
    );
    const sel = editor?.selection;
    return {
      uri: uri.toString(),
      unsaved,
      selection: sel && {
        anchor: [sel.anchor.line, sel.anchor.character],
        active: [sel.active.line, sel.active.character],
      },
    };
  }
  if (input instanceof vscode.TabInputCustom && input.uri.scheme === 'file') {
    return { uri: input.uri.toString(), kind: 'custom', viewType: input.viewType };
  }
  if (input instanceof vscode.TabInputNotebook && input.uri.scheme === 'file') {
    return { uri: input.uri.toString(), kind: 'notebook', viewType: input.notebookType };
  }
  if (input instanceof vscode.TabInputWebview && input.viewType.endsWith('markdown.preview')) {
    const label = PREVIEW_LABEL.exec(tab.label);
    const source = label && (await previewSource(label[2], fileTabs));
    // A preview whose file cannot be found is still closed, so it does not follow into the next project.
    return { uri: source ? source.toString() : '', kind: 'markdownPreview', locked: label?.[1] === '[Preview] ' };
  }
  return undefined;
}

/** The project tabs now open, in order, plus the live tab objects so they can be closed. */
export async function captureEditors(): Promise<{ snapshot: EditorSnapshot; tabs: vscode.Tab[] }> {
  const tabs: vscode.Tab[] = [];
  const groups: GroupSnapshot[] = [];
  let activeColumn: number | undefined;
  const fileTabs = vscode.window.tabGroups.all.flatMap(g => g.tabs.filter(isFileTab).map(t => t.input.uri));

  for (const group of vscode.window.tabGroups.all) {
    const column = group.viewColumn;
    const kept: TabSnapshot[] = [];
    let active: string | undefined;
    for (const tab of group.tabs) {
      const snap = await snapshotTab(tab, column, fileTabs);
      if (!snap) {
        continue;
      }
      tabs.push(tab);
      if (!snap.uri) {
        continue;
      }
      kept.push(snap);
      if (tab.isActive) {
        active = tabKey(snap);
      }
    }
    if (!kept.length) {
      continue;
    }
    if (group.isActive) {
      activeColumn = column;
    }
    groups.push({ viewColumn: column, active, tabs: kept });
  }
  return { snapshot: { groups, activeColumn }, tabs };
}

/**
 * Reverts tabs whose edits were stashed so they can close without a save prompt.
 * Safe because the edits now live in the snapshot, not only in the editor.
 */
export async function revertStashed(snapshot: EditorSnapshot): Promise<void> {
  for (const group of snapshot.groups) {
    for (const tab of group.tabs.filter(t => t.unsaved && !t.kind)) {
      try {
        await vscode.window.showTextDocument(vscode.Uri.parse(tab.uri), {
          viewColumn: group.viewColumn,
          preview: false,
        });
        await vscode.commands.executeCommand('workbench.action.files.revert');
      } catch {
        // If this fails the tab stays dirty and closing it asks the user, which is the safe outcome.
      }
    }
  }
}

/** Closes tabs; false when the user cancelled a save prompt and some stayed open. */
export async function closeEditors(tabs: vscode.Tab[]): Promise<boolean> {
  return tabs.length ? vscode.window.tabGroups.close(tabs) : true;
}

// Editor groups 1 to 8 have a focus command each; the Markdown preview opens in the focused group.
const FOCUS_GROUP = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth'].map(
  n => `workbench.action.focus${n}EditorGroup`,
);

async function show(
  uri: string,
  viewColumn: number,
  tab: TabSnapshot | undefined,
  focus: boolean,
): Promise<vscode.TextEditor | undefined> {
  try {
    if (tab?.kind === 'markdownPreview') {
      const focusGroup = FOCUS_GROUP[viewColumn - 1];
      if (focusGroup) {
        await vscode.commands.executeCommand(focusGroup);
      }
      await vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.parse(uri), undefined, {
        locked: tab.locked,
      });
      return undefined;
    }
    if (tab?.kind) {
      await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.parse(uri), tab.viewType, {
        viewColumn,
        preview: false,
        preserveFocus: !focus,
      });
      return undefined;
    }
    const selection = tab?.selection
      ? new vscode.Selection(new vscode.Position(...tab.selection.anchor), new vscode.Position(...tab.selection.active))
      : undefined;
    return await vscode.window.showTextDocument(vscode.Uri.parse(uri), {
      viewColumn,
      preview: false,
      preserveFocus: !focus,
      selection,
    });
  } catch {
    // The file was deleted or moved since it was saved, or its editor is gone; skip it.
    return undefined;
  }
}

/** Puts stashed edits back as unsaved changes. Returns the file name if it could not. */
async function reapply(editor: vscode.TextEditor, unsaved: Unsaved): Promise<string | undefined> {
  const name = vscode.workspace.asRelativePath(editor.document.uri);
  let current: string | undefined;
  try {
    current = await diskHash(editor.document.uri);
  } catch {
    // treated as changed below
  }
  if (current !== unsaved.baseHash) {
    // The file changed on disk while we were away. Keep the edits somewhere visible instead of overwriting.
    const copy = await vscode.workspace.openTextDocument({
      content: unsaved.text,
      language: editor.document.languageId,
    });
    await vscode.window.showTextDocument(copy, { viewColumn: editor.viewColumn, preview: false, preserveFocus: true });
    return name;
  }
  const whole = new vscode.Range(
    editor.document.positionAt(0),
    editor.document.positionAt(editor.document.getText().length),
  );
  await editor.edit(b => b.replace(whole, unsaved.text), { undoStopBefore: true, undoStopAfter: true });
  return undefined;
}

export async function restoreEditors(snapshot: EditorSnapshot | undefined): Promise<void> {
  if (!snapshot) {
    return;
  }
  const groups = [...snapshot.groups].sort((a, b) => a.viewColumn - b.viewColumn);
  const conflicts: string[] = [];
  for (const group of groups) {
    for (const tab of group.tabs) {
      const editor = await show(tab.uri, group.viewColumn, tab, false);
      if (editor && tab.unsaved && !tab.kind) {
        const conflict = await reapply(editor, tab.unsaved);
        if (conflict) {
          conflicts.push(conflict);
        }
      }
    }
    // Opening in order fixes tab order; now bring the previously active tab back to the front.
    const active = group.tabs.find(t => tabKey(t) === group.active);
    if (active) {
      await show(active.uri, group.viewColumn, active, false);
    }
  }
  const focused = groups.find(g => g.viewColumn === snapshot.activeColumn);
  const focusedTab = focused?.tabs.find(t => tabKey(t) === focused.active);
  if (focused && focusedTab) {
    await show(focusedTab.uri, focused.viewColumn, focusedTab, true);
  }
  if (conflicts.length) {
    void vscode.window.showWarningMessage(
      `Changed on disk while you were away: ${conflicts.join(', ')}. Your unsaved edits were opened in new untitled editors instead of overwriting them.`,
    );
  }
}
