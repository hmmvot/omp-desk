/**
 * The sessions an empty chat offers to go back to: the newest of the same folder, chosen from what the
 * Sessions view already shows.
 *
 * Nothing is read here. A row's headline and its conversation's last activity are kept current by the
 * Sessions tree's own bounded enrichment, so a row that has not been read yet has no activity and is
 * skipped; the empty state then shows fewer rows, or only its hints, instead of a second reader of
 * session files.
 */

import { normalizeSessionIdentityKey } from "../host/session-files.ts";
import { MAX_RECENT_TITLE_LENGTH } from "../protocol/messages.ts";

/** What of a Sessions row this selection reads (a `SessionTreeItem` satisfies it). */
export interface RecentCandidate {
	readonly tabId: string;
	readonly headline: string;
	readonly entry: { readonly kind: string; readonly cwd: string };
	readonly conversation: { readonly lastAt: string | null } | null;
}

/** One chosen session: its tab for the host's own use, and the two facts a page may see. */
export interface RecentSession<Row extends RecentCandidate = RecentCandidate> {
	readonly row: Row;
	readonly title: string;
	/** Conversation's last activity, epoch milliseconds. */
	readonly updatedAt: number;
}

/** A headline as one bounded line: whitespace and control characters collapse, long text is cut with an ellipsis. */
export function recentTitle(headline: string): string {
	const line = headline.replace(/[\u0000-\u001f\u007f\s]+/g, " ").trim();
	return line.length <= MAX_RECENT_TITLE_LENGTH ? line : `${line.slice(0, MAX_RECENT_TITLE_LENGTH - 1).trimEnd()}…`;
}

/**
 * The newest `limit` sessions of `cwd`, newest first, other than the editor's own conversation.
 * Both folders are compared by their identity key; a draft, a row of another folder and a row without a
 * read activity or title are not recents.
 */
export function recentSessionsOf<Row extends RecentCandidate>(
	rows: readonly Row[],
	cwd: string,
	selfTabId: string | null,
	limit: number,
): RecentSession<Row>[] {
	const folder = normalizeSessionIdentityKey(cwd);
	const recents: RecentSession<Row>[] = [];
	for (const row of rows) {
		if (row.tabId === selfTabId || row.entry.kind !== "session") continue;
		if (normalizeSessionIdentityKey(row.entry.cwd) !== folder) continue;
		const lastAt = row.conversation?.lastAt;
		if (lastAt == null) continue;
		const updatedAt = Date.parse(lastAt);
		if (!Number.isFinite(updatedAt)) continue;
		const title = recentTitle(row.headline);
		if (title.length === 0) continue;
		recents.push({ row, title, updatedAt });
	}
	return recents.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
}
