/**
 * OMP Desk — the flat Sessions list: ordering and labels.
 *
 * Pure functions, no editor API: the provider hands rows in and renders what comes out.
 *
 * Order: every session that is not stopped comes first — unread rows before read ones,
 * each group by last activity, most recent first — and every stopped (closed) session
 * comes last, again by last activity. "Stopped" is the session's process, not its tab:
 * a running session whose editor was closed is not stopped.
 */
import * as path from "node:path";

/** How the Sessions view arranges its rows: one flat list, or grouped under folders. */
export type SessionsGrouping = "flat" | "folders";

/** The setting's value for anything unrecognized: the flat list is the default. */
export function normalizeSessionsGrouping(value: unknown): SessionsGrouping {
	return value === "folders" ? "folders" : "flat";
}

/** What the order depends on, for one row. */
export interface FlatOrderFacts {
	readonly tabId: string;
	/** The session's process is not running (see the module comment). */
	readonly stopped: boolean;
	/** The agent finished or asked, and the user has not looked since. */
	readonly unread: boolean;
	/** Epoch milliseconds of the session's last activity; `0` when unknown. */
	readonly lastActivityAt: number;
	/** The index's creation order, the last tie-break: newer sessions first. */
	readonly ordinal: number;
}

/**
 * `left` before `right` when negative. A total order: equal facts only for the same row.
 * A stopped row's read marker never reorders it, so unread counts for live rows only.
 */
export function compareFlatRows(left: FlatOrderFacts, right: FlatOrderFacts): number {
	return Number(left.stopped) - Number(right.stopped)
		|| (left.stopped ? 0 : Number(right.unread) - Number(left.unread))
		|| right.lastActivityAt - left.lastActivityAt
		|| right.ordinal - left.ordinal
		|| (left.tabId < right.tabId ? -1 : left.tabId > right.tabId ? 1 : 0);
}

/** Sort rows by {@link compareFlatRows}; the input is left alone. */
export function orderFlatRows<T extends FlatOrderFacts>(rows: readonly T[]): T[] {
	return [...rows].sort(compareFlatRows);
}

/** The first parseable timestamp among these as epoch milliseconds, `0` when there is none. */
export function activityMillis(...candidates: readonly (string | null | undefined)[]): number {
	for (const candidate of candidates) {
		if (candidate === null || candidate === undefined) continue;
		const at = Date.parse(candidate);
		if (!Number.isNaN(at)) return at;
	}
	return 0;
}

/**
 * The name each folder carries in front of its sessions' titles.
 *
 * The last path component, unless two folders share it: those grow by one parent
 * component at a time until they differ (`app` and `app` become `work/app` and
 * `play/app`), and a pair that is still equal at the root keeps its full path.
 * Comparison ignores case, as the Windows file system does.
 */
export function flatFolderLabels(folders: readonly { readonly id: string; readonly path: string }[]): Map<string, string> {
	const parts = new Map<string, string[]>();
	for (const folder of folders) {
		const components = folder.path.split(/[\\/]+/).filter(component => component.length > 0);
		parts.set(folder.id, components.length === 0 ? [folder.path] : components);
	}
	const depth = new Map<string, number>(folders.map(folder => [folder.id, 1]));
	const labelAt = (id: string): string => {
		const components = parts.get(id)!;
		return components.slice(Math.max(0, components.length - depth.get(id)!)).join("/");
	};
	for (;;) {
		const groups = new Map<string, string[]>();
		for (const folder of folders) {
			const key = labelAt(folder.id).toLowerCase();
			groups.set(key, [...groups.get(key) ?? [], folder.id]);
		}
		let widened = false;
		for (const ids of groups.values()) {
			if (ids.length < 2) continue;
			for (const id of ids) {
				if (depth.get(id)! < parts.get(id)!.length) {
					depth.set(id, depth.get(id)! + 1);
					widened = true;
				}
			}
		}
		if (!widened) break;
	}
	const labels = new Map<string, string>();
	for (const folder of folders) {
		const label = labelAt(folder.id);
		labels.set(folder.id, label.length > 0 ? label : path.basename(folder.path) || folder.path);
	}
	return labels;
}

/** The row label of the flat list: the folder in front of the session's own name. */
export function flatRowLabel(folderLabel: string, headline: string): string {
	return `${folderLabel} · ${headline}`;
}
