import { createHash } from 'node:crypto';

import * as vscode from 'vscode';

// Open files per project. In a multi-root window VS Code keeps one editor state for the
// whole window, so Paddock saves a project's files when switching away and reopens them
// when switching back. Only plain files are handled; terminals, diffs, settings pages and
// other custom editors are left alone.

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
  unsaved?: Unsaved;
  selection?: { anchor: [number, number]; active: [number, number] };
}

export interface GroupSnapshot {
  viewColumn: number;
  tabs: TabSnapshot[];
  /** uri of the tab that was showing in this group. */
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

async function diskHash(uri: vscode.Uri): Promise<string> {
  const bytes = await vscode.workspace.fs.readFile(uri);
  return createHash('sha1').update(bytes).digest('hex');
}

/** The file tabs now open, in order, plus the live tab objects so they can be closed. */
export async function captureEditors(): Promise<{ snapshot: EditorSnapshot; tabs: vscode.Tab[] }> {
  const tabs: vscode.Tab[] = [];
  const groups: GroupSnapshot[] = [];
  let activeColumn: number | undefined;

  for (const group of vscode.window.tabGroups.all) {
    const files = group.tabs.filter(isFileTab);
    if (!files.length) {
      continue;
    }
    tabs.push(...files);
    const column = group.viewColumn;
    if (group.isActive) {
      activeColumn = column;
    }
    groups.push({
      viewColumn: column,
      active: files.find(t => t.isActive)?.input.uri.toString(),
      tabs: await Promise.all(
        files.map(async t => {
          const uri = t.input.uri;
          const doc = t.isDirty
            ? vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString())
            : undefined;
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
        }),
      ),
    });
  }
  return { snapshot: { groups, activeColumn }, tabs };
}

/**
 * Reverts tabs whose edits were stashed so they can close without a save prompt.
 * Safe because the edits now live in the snapshot, not only in the editor.
 */
export async function revertStashed(snapshot: EditorSnapshot): Promise<void> {
  for (const group of snapshot.groups) {
    for (const tab of group.tabs.filter(t => t.unsaved)) {
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

async function show(
  uri: string,
  viewColumn: number,
  tab: TabSnapshot | undefined,
  focus: boolean,
): Promise<vscode.TextEditor | undefined> {
  const selection = tab?.selection
    ? new vscode.Selection(new vscode.Position(...tab.selection.anchor), new vscode.Position(...tab.selection.active))
    : undefined;
  try {
    return await vscode.window.showTextDocument(vscode.Uri.parse(uri), {
      viewColumn,
      preview: false,
      preserveFocus: !focus,
      selection,
    });
  } catch {
    // The file was deleted or moved since it was saved; skip it.
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
      if (editor && tab.unsaved) {
        const conflict = await reapply(editor, tab.unsaved);
        if (conflict) {
          conflicts.push(conflict);
        }
      }
    }
    // Opening in order fixes tab order; now bring the previously active tab back to the front.
    if (group.active) {
      await show(
        group.active,
        group.viewColumn,
        group.tabs.find(t => t.uri === group.active),
        false,
      );
    }
  }
  const focused = groups.find(g => g.viewColumn === snapshot.activeColumn);
  if (focused?.active) {
    await show(
      focused.active,
      focused.viewColumn,
      focused.tabs.find(t => t.uri === focused.active),
      true,
    );
  }
  if (conflicts.length) {
    void vscode.window.showWarningMessage(
      `Changed on disk while you were away: ${conflicts.join(', ')}. Your unsaved edits were opened in new untitled editors instead of overwriting them.`,
    );
  }
}
