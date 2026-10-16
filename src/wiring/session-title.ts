/**
 * Taking a session's name from OMP into the Sessions row and the editor tab.
 *
 * OMP announces a new name with `session_info_update` (`/rename`, Desk's own rename, a generated title) and keeps
 * it in `get_state.sessionName`. The row's cached title (`SessionIndexEntry.title`) is what a draft with no file,
 * and a stopped row whose file is not readable, show; with a file the row shows the file's own title, which the
 * tree re-reads when the cached title changes. Nothing here writes to OMP.
 */

import type { SessionIndexEntry } from "../host/session-model.ts";
import type { Logger } from "../shared/logger.ts";

export interface SessionTitleDeps {
	readonly index: {
		get(tabId: string): SessionIndexEntry | null;
		recordConversationState(tabId: string, update: { readonly title: string }): Promise<unknown>;
	};
	/** Repaint the Sessions view. */
	readonly refreshLauncher: () => void;
	/** Rename the editors showing the conversation. */
	readonly applyAppearance: (tabId: string) => Promise<void>;
	readonly log: Pick<Logger, "warn">;
}

/**
 * Record the name OMP reports for the conversation of `tabId`, then repaint the row and the tab title. A name
 * of another session than the one the row is bound to is ignored (the row is identity-checked like every other
 * fact taken from a process); a row that has not recorded its provider id yet takes the name, since the tab's own
 * conversation reported it. An unchanged name changes nothing, so Desk's own rename and OMP's echo of it do not
 * fight.
 */
export async function adoptSessionTitle(deps: SessionTitleDeps, tabId: string, sessionId: string | null, title: string): Promise<void> {
	const name = title.trim();
	const entry = deps.index.get(tabId);
	if (entry === null || sessionId === null || name.length === 0 || entry.title === name) return;
	const recorded = entry.host?.sessionId ?? entry.sessionId;
	if (recorded !== null && recorded !== sessionId) return;
	try {
		await deps.index.recordConversationState(tabId, { title: name });
		deps.refreshLauncher();
		await deps.applyAppearance(tabId);
	} catch (error) {
		deps.log.warn(`Session title could not be refreshed: ${error instanceof Error ? error.message : String(error)}`);
	}
}
