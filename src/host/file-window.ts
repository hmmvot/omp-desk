/**
 * The file window of Ctrl+Shift+M (`omp.moveFileToNewWindow`): one auxiliary VS Code window that files from the chat
 * column are collected in.
 *
 * VS Code reports an auxiliary window's editor groups in `window.tabGroups` with ordinary view columns that follow
 * the groups of the main window, so a column is not an identity: it moves when the main window gains or loses a group.
 * The `TabGroup` object is the identity (VS Code keeps one object per group and updates its `viewColumn`), and the
 * window is gone when its group no longer appears in `tabGroups.all`.
 */

/** The size of the file window, in pixels of its editor area. VS Code's own default is 1024x768 and it clamps a larger request to the screen. */
export const FILE_WINDOW_SIZE = { width: 1600, height: 1000 } as const;

/** The slice of an editor group the tracker reads. */
export interface TrackedGroup {
	readonly viewColumn: number;
}

/** Remembers the editor group of the file window. */
export class FileWindowTracker<G extends TrackedGroup> {
	private group: G | null = null;

	/** Remember `group` as the file window, or forget the window with `null`. */
	adopt(group: G | null): void {
		this.group = group;
	}

	/** The group of the file window, or `null` once VS Code no longer lists it (the window was closed). */
	current(all: readonly G[]): G | null {
		if (this.group !== null && !all.includes(this.group)) this.group = null;
		return this.group;
	}

	/** The view column of the file window's group right now, or `null` without a file window. */
	column(all: readonly G[]): number | null {
		return this.current(all)?.viewColumn ?? null;
	}
}

/** The last group in `after` that was not in `before`: the group a new window brought, or `null` when none appeared. */
export function appearedGroup<G>(before: readonly G[], after: readonly G[]): G | null {
	for (let index = after.length - 1; index >= 0; index--) {
		const group = after[index] as G;
		if (!before.includes(group)) return group;
	}
	return null;
}
