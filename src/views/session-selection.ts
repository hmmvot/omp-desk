/**
 * OMP Desk — which Sessions row stays selected.
 *
 * While at least one session has an open editor in this window, the Sessions view keeps
 * the row of the session the user viewed most recently selected: a selection that holds
 * no session row (cleared, or only a folder or the New Session row) is put back. Picking
 * another session row is left alone, and the selection follows once that session's
 * editor becomes the viewed one. Pure decisions; `src/extension.ts` reveals the row.
 */

/** One editor of this window, as the focus recency order lists it. */
export interface EditorFacts {
	/** The conversation the editor serves, or `null` while it is unbound. */
	readonly tabId: string | null;
	/** A folder shell or another editor that is not a session conversation. */
	readonly shell: boolean;
}

/**
 * The session viewed most recently among the open editors, most recently focused first,
 * or `null` when no open editor serves a session the view shows.
 */
export function pinnedSessionTabId(recency: readonly EditorFacts[], rowShown: (tabId: string) => boolean): string | null {
	for (const editor of recency) {
		if (!editor.shell && editor.tabId !== null && rowShown(editor.tabId)) return editor.tabId;
	}
	return null;
}

/**
 * The row to put back after the selection changed, or `null` to leave it.
 * `selected` holds one entry per selected row: its conversation, or `null` for any
 * row that is not a session.
 */
export function selectionRestore(pinned: string | null, selected: readonly (string | null)[]): string | null {
	return pinned !== null && !selected.some(tabId => tabId !== null) ? pinned : null;
}

/**
 * The row to put back when the selection rests on a session this window does not run: the row
 * of a session another window holds, which a click on it selects while it switches to that window,
 * and which stays selected after the user comes back. Each window selects only the session of its
 * own editors, so a selection made up of such rows alone gives way to `target` (the pinned row, or
 * the session this window recovers as active). A selection that holds any other session row is the
 * user's own choice and is left, as is every selection while `target` is `null`.
 */
export function selectionLeaveOtherWindow(
	target: string | null,
	selected: readonly (string | null)[],
	heldElsewhere: (tabId: string) => boolean,
): string | null {
	if (target === null || selected.length === 0) return null;
	const sessions = selected.filter((tabId): tabId is string => tabId !== null);
	if (sessions.length === 0 || sessions.length !== selected.length) return null;
	return sessions.every(heldElsewhere) ? target : null;
}
