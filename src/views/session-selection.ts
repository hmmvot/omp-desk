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
