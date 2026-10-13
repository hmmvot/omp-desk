/**
 * The recent sessions an empty chat offers: the answer to a page's request and the open of one of its rows.
 *
 * A page has no authority over what opens. The answer carries a title and an age per row and nothing that
 * names a session; the host keeps which tabs it answered with, per editor document, and a pick names a row
 * only by the answer's request id and its ordinal. A pick the last answer for that exact document does not
 * hold (another request, another document, an ordinal out of range, a session the tree no longer lists) is
 * refused with the message a stale process row gives.
 *
 * Selection is `recentSessionsOf` over the rows the Sessions view lists, and the open is the click on that
 * row (`SessionActions.click`), so window switching, ownership refusal and the view mode follow the
 * existing rules and there is no second open path. The module keeps only the table of last answers;
 * everything else arrives through {@link RecentSessionsDeps}.
 */

import type { SessionIndex } from "../host/session-index.ts";
import type { GuestOpenRecentMessage, GuestRecentSessionsMessage } from "../protocol/messages.ts";
import { RECENT_SESSIONS_LIMIT } from "../protocol/messages.ts";
import { recentSessionsOf } from "../views/recent-sessions.ts";
import type { RecentCandidate } from "../views/recent-sessions.ts";

/** What recents read of the Sessions view and call into. */
export interface RecentSessionsDeps<Row extends RecentCandidate = RecentCandidate> {
	/** Every session row the Sessions view lists, or none while the view does not exist. */
	listed(): readonly Row[];
	/** The row of one tab, the same lookup a process row's click uses. */
	itemFor(tabId: string): Promise<Row | undefined>;
	/** A click on the row: open it as Sessions does. */
	click(index: SessionIndex, row: Row): Promise<void>;
	info(message: string): void;
}

/** The editor document an answer was given to: the dispatcher's own key for a page (slot, panel, document). */
export interface RecentDocument {
	readonly slot: string;
	readonly panel: object;
	readonly document: object | null;
}

export interface RecentSessions {
	/** The answer to one page's request, remembered as the last answer for its document. */
	answer(document: RecentDocument, cwd: string, ownTabId: string | null, requestId: number): GuestRecentSessionsMessage;
	/** Open one row of the last answer given to this document, or say it is not listed any more. */
	open(index: SessionIndex, document: RecentDocument, pick: GuestOpenRecentMessage): Promise<void>;
}

const NOT_LISTED = "That session is not listed in Sessions any more. Refresh and try again.";

export function registerRecentSessions<Row extends RecentCandidate>(deps: RecentSessionsDeps<Row>): RecentSessions {
	/** The last answer per editor slot, valid only for the panel and document it was given to. */
	const answers = new Map<string, { panel: object; document: object | null; requestId: number; tabIds: readonly string[] }>();

	return {
		answer(document, cwd, ownTabId, requestId) {
			const chosen = recentSessionsOf(deps.listed(), cwd, ownTabId, RECENT_SESSIONS_LIMIT);
			answers.set(document.slot, {
				panel: document.panel,
				document: document.document,
				requestId,
				tabIds: chosen.map(({ row }) => row.tabId),
			});
			return { type: "omp:recent-sessions", requestId, items: chosen.map(({ title, updatedAt }) => ({ title, updatedAt })) };
		},
		async open(index, document, pick) {
			const answered = answers.get(document.slot);
			if (answered !== undefined && (answered.panel !== document.panel || answered.document !== document.document)) {
				// The editor was rebound or its document replaced: its answers are not this document's.
				answers.delete(document.slot);
			}
			const current = answers.get(document.slot);
			const tabId = current?.requestId === pick.requestId ? current.tabIds[pick.index] : undefined;
			const row = tabId === undefined ? undefined : await deps.itemFor(tabId);
			if (row === undefined) {
				deps.info(NOT_LISTED);
				return;
			}
			await deps.click(index, row);
		},
	};
}
