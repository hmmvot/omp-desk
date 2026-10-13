/**
 * OMP Desk — the flat Sessions list: ordering and labels.
 *
 * Pure functions, no editor API: the provider hands rows in and renders what comes out.
 *
 * Order: every session that is not stopped comes first and every stopped (closed) session
 * comes last; each group is alphabetical by folder label, then by session title (natural,
 * case-insensitive). "Stopped" is the session's process, not its tab: a running session
 * whose editor was closed is not stopped.
 */
import * as path from "node:path";

/** How the Sessions view arranges its rows: one flat list, grouped under folders, or the background processes. */
export type SessionsGrouping = "flat" | "folders" | "terminals";

/** The setting's value for anything unrecognized: the flat list is the default. */
export function normalizeSessionsGrouping(value: unknown): SessionsGrouping {
	return value === "folders" || value === "terminals" ? value : "flat";
}

/** The layouts the Sessions title-bar picker offers, in order, with the words it shows. */
export const SESSIONS_LAYOUT_CHOICES: ReadonlyArray<{ readonly id: SessionsGrouping; readonly label: string; readonly description: string }> = [
	{ id: "flat", label: "Flat List", description: "Every session in one list, labelled with its folder" },
	{ id: "folders", label: "By Folder", description: "Sessions grouped under their folders" },
	{ id: "terminals", label: "Terminals", description: "Background processes: sessions and terminals that are running" },
];

/** Pure: the picker's items, the current layout marked with a filled radio and the others with an empty one. */
export function sessionsLayoutPickItems(current: SessionsGrouping): Array<{ readonly id: SessionsGrouping; readonly label: string; readonly description: string; readonly detail: string }> {
	return SESSIONS_LAYOUT_CHOICES.map(choice => ({
		id: choice.id,
		label: `${choice.id === current ? "$(circle-large-filled)" : "$(circle-large-outline)"} ${choice.label}`,
		description: choice.id === current ? "current" : "",
		detail: choice.description,
	}));
}

/** Where a notification's session is revealed in the Sessions view. */
export type NotificationRevealPlan =
	/** The current layout serves session rows: reveal the indexed session's row. */
	| { readonly kind: "session-row" }
	/** The Terminals layout, and the session's process is still listed: reveal that process row. */
	| { readonly kind: "process-row" }
	/** The Terminals layout has no row for the session (its process ended): show a layout that serves session rows, then reveal the session's row. Nothing is launched. */
	| { readonly kind: "switch-layout"; readonly to: "flat" | "folders" };

/** Pure: the reveal a desktop notification asks for. `previousSessionLayout` is the session-serving layout the user used last, if known (flat otherwise). */
export function planNotificationReveal(input: {
	readonly sessionRowsShown: boolean;
	readonly hasProcessRow: boolean;
	readonly previousSessionLayout: SessionsGrouping | null;
}): NotificationRevealPlan {
	if (input.sessionRowsShown) return { kind: "session-row" };
	if (input.hasProcessRow) return { kind: "process-row" };
	return { kind: "switch-layout", to: input.previousSessionLayout === "folders" ? "folders" : "flat" };
}

/** What the order depends on, for one row. */
export interface FlatOrderFacts {
	readonly tabId: string;
	/** The session's process is not running (see the module comment). */
	readonly stopped: boolean;
	/** The folder label shown in front of the title; empty when none. */
	readonly folder: string;
	/** The session title the row shows. */
	readonly title: string;
	/** The index's creation order, the tie-break between equal titles: older sessions first. */
	readonly ordinal: number;
}

const titleOrder = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** `left` before `right` when negative. A total order: equal facts only for the same row. */
export function compareFlatRows(left: FlatOrderFacts, right: FlatOrderFacts): number {
	return Number(left.stopped) - Number(right.stopped)
		|| titleOrder.compare(left.folder, right.folder)
		|| titleOrder.compare(left.title, right.title)
		|| left.ordinal - right.ordinal
		|| (left.tabId < right.tabId ? -1 : left.tabId > right.tabId ? 1 : 0);
}

/** Sort rows by {@link compareFlatRows}; the input is left alone. */
export function orderFlatRows<T extends FlatOrderFacts>(rows: readonly T[]): T[] {
	return [...rows].sort(compareFlatRows);
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
