import * as vscode from 'vscode';
import { moveGroups, moveProjects, Store, UNGROUPED_ID } from '../store';
import type { Node } from './provider';

const MIME = 'application/vnd.code.tree.paddock.projects';

/**
 * VS Code trees drop onto an item, not into a gap:
 *  - project on project: before it, in that project's group
 *  - project on group: end of that group
 *  - project on empty space: end of Ungrouped
 *  - group on group: before it
 *  - group on empty space: end of the list
 */
export class ProjectsDnd implements vscode.TreeDragAndDropController<Node> {
	readonly dragMimeTypes = [MIME];
	readonly dropMimeTypes = [MIME];

	constructor(private readonly store: Store) {}

	handleDrag(source: readonly Node[], data: vscode.DataTransfer): void {
		const movable = source.filter(n => n.kind === 'project' || n.kind === 'group');
		if (movable.length) {
			data.set(MIME, new vscode.DataTransferItem(movable));
		}
	}

	async handleDrop(dropTarget: Node | undefined, data: vscode.DataTransfer): Promise<void> {
		// The Add project row counts as empty space.
		const target = dropTarget?.kind === 'add' ? undefined : dropTarget;
		const dragged = data.get(MIME)?.value as Node[] | undefined;
		if (!dragged?.length) {
			return;
		}
		const projectIds = dragged.filter(n => n.kind === 'project').map(n => n.id);
		const groupIds = dragged.filter(n => n.kind === 'group').map(n => n.id);
		if (target?.kind === 'session') {
			return;
		}

		if (projectIds.length) {
			const { projects } = this.store.snapshot;
			if (target?.kind === 'project') {
				const groupId = projects.find(p => p.id === target.id)?.groupId;
				if (groupId) {
					await this.store.update(d => moveProjects(d, projectIds, groupId, target.id));
				}
			} else {
				await this.store.update(d => moveProjects(d, projectIds, target?.id ?? UNGROUPED_ID));
			}
		} else if (target?.kind === 'project') {
			return;
		} else {
			await this.store.update(d => moveGroups(d, groupIds, target?.id));
		}
	}
}
