/**
 * OMP Desk — the background processes inside the Sessions view: what a process row says and
 * which rows a layout lists. Pure functions, no editor API: the provider hands rows in and
 * renders what comes out (`process-rows.ts` for the items, `session-tree.ts` for the tree).
 *
 * A row is a `BrokerProcessRow` of `src/host/broker-processes.ts`: the model decides what a
 * process is, whether it is orphaned or idle and whether it can be stopped here. This module
 * only chooses words and decides, per layout, which rows are listed where.
 */
import path from "node:path";
import type { BrokerProcessRow } from "../host/broker-processes.ts";
import { fmtDuration } from "../shared/format.ts";
import type { SessionsGrouping } from "./session-order.ts";

export type ProcessState = "orphaned" | "idle" | "inuse" | "unknown" | "unmanaged";

/** Orphaned beats idle beats unchecked, the order the model sorts by; a live, referenced process is in use. */
export function processState(row: BrokerProcessRow): ProcessState {
	if (row.status === "unmanaged") return "unmanaged";
	if (row.status === "orphaned") return "orphaned";
	if (row.child === "exited") return "idle";
	return row.status === "in-use" ? "inuse" : "unknown";
}

const STATE_WORD: Record<ProcessState, string> = {
	orphaned: "Orphaned",
	idle: "Idle",
	inuse: "Running",
	unknown: "Unchecked",
	unmanaged: "Unmanaged",
};

export const PROCESS_STATE_EXPLANATION: Record<ProcessState, string> = {
	orphaned: "No session or terminal uses this background process.",
	idle: "Its session or terminal has ended.",
	inuse: "Its session or terminal is still running.",
	unknown: "Refresh to check whether a session or terminal uses it.",
	unmanaged: "Desk has no record for this process, so it cannot reconnect to it. Kill ends it and the OMP session it runs.",
};

/** The status word of a process row: where it is open when that is known, else its state. */
export function processStateWord(row: BrokerProcessRow, state: ProcessState): string {
	if (state === "inuse" && row.window !== "none") {
		return row.window === "this-window" ? "Open in this window" : "Open in another window";
	}
	return state === "inuse" && row.child === "unknown" ? "Unchecked" : STATE_WORD[state];
}

/** What kind of process it is, as the user says it. */
export function processKindWord(row: BrokerProcessRow): string {
	return row.kind === "stats" ? "Stats dashboard" : row.kind;
}

export function processUptime(row: BrokerProcessRow): string {
	return row.uptimeMs === null ? "unknown" : fmtDuration(row.uptimeMs);
}

export function processDescription(row: BrokerProcessRow, state: ProcessState): string {
	const parts = [processStateWord(row, state), processKindWord(row), `up ${processUptime(row)}`];
	if (row.olderBuild) parts.push("older build");
	if (row.source === "predecessor") parts.push("previous build");
	return parts.join(" · ");
}

/** What the process hosts, without its folder: the session's title, `Terminal`, or the broker's own title for an orphan. */
export function processTitle(row: BrokerProcessRow): string {
	const { host } = row;
	if (row.kind === "stats") return "Stats dashboard";
	if (host?.kind === "session") return host.title;
	if (host?.kind === "terminal") return "Terminal";
	if (row.title !== null && row.title !== "") return row.title;
	if (row.unmanaged?.sessionFile != null) return path.win32.basename(row.unmanaged.sessionFile);
	return row.kind === "session" ? "Session process" : "Terminal process";
}

/** The working folder of a process that has one: a session's, or its terminal's. */
export function processFolder(row: BrokerProcessRow): string | null {
	const { host } = row;
	if (host?.kind === "session") return host.folder;
	if (host?.kind === "terminal") return host.folder;
	return row.unmanaged?.cwd ?? null;
}

/** `folder · what` as the flat session list labels its rows; a row with no folder has the plain title. */
export function processLabel(row: BrokerProcessRow, folderLabel: string | null): string {
	const title = processTitle(row);
	return folderLabel === null ? title : `${folderLabel} · ${title}`;
}

/**
 * A session row stands for its process: a `current` process the catalog references, whose
 * conversation the view shows as a row, and whose child still runs (or has not been read).
 */
function representedBySessionRow(row: BrokerProcessRow, shownTabIds: ReadonlySet<string>): boolean {
	return (
		row.source === "current" &&
		row.kind === "session" &&
		row.status === "in-use" &&
		row.child !== "exited" &&
		row.host?.kind === "session" &&
		row.host.tabId !== null &&
		shownTabIds.has(row.host.tabId)
	);
}

/**
 * The process rows a layout serves as processes. `terminals` lists every one; the other layouts
 * list only the *loose* rows (a terminal, an orphan, an idle session process, the Stats
 * dashboard, a previous-build process, a session whose folder is not shown): a session row
 * already stands for the process it runs.
 */
export function listedProcessRows(
	rows: readonly BrokerProcessRow[],
	layout: SessionsGrouping,
	shownTabIds: ReadonlySet<string>,
): readonly BrokerProcessRow[] {
	return layout === "terminals" ? rows : rows.filter(row => !representedBySessionRow(row, shownTabIds));
}

/**
 * The process of each session, by conversation id, for the tooltip. A running process wins over
 * an idle one a stopped row left behind.
 */
export function processesBySession(rows: readonly BrokerProcessRow[]): ReadonlyMap<string, BrokerProcessRow> {
	const byTab = new Map<string, BrokerProcessRow>();
	for (const row of rows) {
		if (row.source !== "current" || row.kind !== "session" || row.host?.kind !== "session" || row.host.tabId === null) continue;
		const known = byTab.get(row.host.tabId);
		if (known === undefined || (known.child === "exited" && row.child !== "exited")) byTab.set(row.host.tabId, row);
	}
	return byTab;
}

/**
 * Session statuses that mean this extension's process exists for the row: the writer runs (in this
 * window or, as `otherWindow`, another's), is being re-adopted or is stopping. `stopped`, `draft`,
 * `blocked`, `checking` and `starting` claim none, and `externalOmp` is a plain `omp` outside this
 * extension, not one of its processes.
 */
const LIVE_PROCESS_STATES: ReadonlySet<string> = new Set([
	"running", "working", "background", "question", "unread", "waiting", "restoring", "stopping", "otherWindow",
]);

/**
 * The tooltip sentence that marks a session's process, or `null` when it has none to mark. The row's
 * own status decides whether a process exists (`evidence`: this window runs the writer, or an
 * authenticated broker witnessed it); the snapshot's row only adds the uptime, or says the process
 * is idle when its session ended. A row whose writer another window holds without a snapshot row is
 * "held by another window", never "running" on this window's say-so.
 */
export function sessionProcessMark(state: string, evidence: boolean, process: BrokerProcessRow | null): string | null {
	if (!evidence && process?.child === "exited") return `Process: idle (its session ended), up ${processUptime(process)}`;
	const up = process === null || process.child === "exited" ? "" : `, up ${processUptime(process)}`;
	if (state === "otherWindow") return `Process: held by another window${up}`;
	if (evidence && LIVE_PROCESS_STATES.has(state)) return `Process: running${up}`;
	return null;
}

/** What a click on a process row opens: the session's tab, a terminal's editor, the dashboard, or nothing. */
export type ProcessOpenTarget = "session" | "terminal" | "stats";

export function processOpenTarget(row: BrokerProcessRow, shownTabIds: ReadonlySet<string>): ProcessOpenTarget | null {
	if (row.source !== "current") return null;
	if (row.kind === "stats") return "stats";
	if (row.host?.kind === "terminal") return "terminal";
	if (row.host?.kind === "session" && row.host.tabId !== null && shownTabIds.has(row.host.tabId)) return "session";
	return null;
}
