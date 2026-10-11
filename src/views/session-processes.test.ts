/**
 * Tests for what the Sessions view says about background processes: the words and labels of a
 * process row, which rows each layout lists, and the process mark on a session row.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BrokerProcessRow } from "../host/broker-processes.ts";
import {
	listedProcessRows,
	processDescription,
	processFolder,
	processLabel,
	processState,
	processStateWord,
	processTitle,
	processOpenTarget,
	processesBySession,
	sessionProcessMark,
} from "./session-processes.ts";

let serial = 0;

function row(overrides: Partial<BrokerProcessRow> = {}): BrokerProcessRow {
	serial += 1;
	return {
		id: `current|tab:${serial}|pty-${serial}`,
		source: "current",
		kind: "session",
		ptyKind: "managed-rpc",
		slot: `tab:${serial}`,
		brokerId: `pty-${serial}`,
		generation: `gen-${serial}`,
		brokerPid: 5000 + serial,
		brokerCreationTime: "134349421014308869",
		startedAt: new Date(0).toISOString(),
		uptimeMs: 3_720_000,
		title: null,
		status: "in-use",
		host: { kind: "session", tabId: `tab-${serial}`, title: "Fix the build", folder: "C:/work/app", window: "none", drivenHere: false, recorded: true },
		window: "none",
		drivenHere: false,
		child: "running",
		olderBuild: false,
		stop: { available: true },
		...overrides,
	};
}

const terminal = (overrides: Partial<BrokerProcessRow> = {}): BrokerProcessRow =>
	row({
		kind: "terminal",
		ptyKind: "folder-shell",
		host: { kind: "terminal", folder: "C:/work/app", label: "app", window: "none" },
		...overrides,
	});

const orphan = (overrides: Partial<BrokerProcessRow> = {}): BrokerProcessRow =>
	row({ status: "orphaned", host: null, title: "left over", ...overrides });

describe("process state and words", () => {
	it("ranks orphaned over idle over in use, and leaves a process nothing references unchecked", () => {
		assert.equal(processState(orphan({ child: "exited" })), "orphaned");
		assert.equal(processState(row({ child: "exited" })), "idle");
		assert.equal(processState(row()), "inuse");
		assert.equal(processState(row({ status: "unknown", host: null })), "unknown");
	});

	it("says where an in-use process is open when that is known, and Unchecked when its child was never read", () => {
		assert.equal(processStateWord(row({ window: "this-window" }), "inuse"), "Open in this window");
		assert.equal(processStateWord(row({ window: "other-window" }), "inuse"), "Open in another window");
		assert.equal(processStateWord(row(), "inuse"), "Running");
		assert.equal(processStateWord(row({ child: "unknown" }), "inuse"), "Unchecked");
		assert.equal(processStateWord(orphan(), "orphaned"), "Orphaned");
	});

	it("describes kind and uptime and flags an older or previous build", () => {
		assert.equal(processDescription(row(), "inuse"), "Running · session · up 1h 02m");
		assert.equal(processDescription(terminal({ olderBuild: true }), "inuse"), "Running · terminal · up 1h 02m · older build");
		const old = row({ source: "predecessor", status: "unknown", host: null, uptimeMs: null });
		assert.equal(processDescription(old, "unknown"), "Unchecked · session · up unknown · previous build");
		assert.equal(processDescription(row({ kind: "stats", ptyKind: "stats-dashboard" }), "inuse"), "Running · Stats dashboard · up 1h 02m");
	});
});

describe("process labels", () => {
	it("puts the folder before what the process hosts, as the flat list does", () => {
		assert.equal(processLabel(row(), "app"), "app · Fix the build");
		assert.equal(processLabel(terminal(), "app"), "app · Terminal");
		assert.equal(processLabel(orphan(), null), "left over");
	});

	it("falls back to a kind word for an orphan the broker never titled, and names the Stats dashboard alone", () => {
		assert.equal(processTitle(orphan({ title: null })), "Session process");
		assert.equal(processTitle(orphan({ title: "", kind: "terminal", ptyKind: "folder-shell" })), "Terminal process");
		assert.equal(processTitle(row({ kind: "stats", ptyKind: "stats-dashboard", host: { kind: "stats", window: "none" } })), "Stats dashboard");
	});

	it("takes the folder from the session or the terminal and none from an orphan or the dashboard", () => {
		assert.equal(processFolder(row()), "C:/work/app");
		assert.equal(processFolder(terminal()), "C:/work/app");
		assert.equal(processFolder(orphan()), null);
		assert.equal(processFolder(row({ kind: "stats", host: { kind: "stats", window: "none" } })), null);
	});
});

const shown = (...tabIds: string[]): ReadonlySet<string> => new Set(tabIds);
const sessionWith = (tabId: string, overrides: Partial<BrokerProcessRow> = {}): BrokerProcessRow =>
	row({ host: { kind: "session", tabId, title: tabId, folder: "C:/work/app", window: "none", drivenHere: false, recorded: true }, ...overrides });

describe("which rows a layout lists", () => {
	it("lists every process in the terminals layout, session processes included", () => {
		const rows = [sessionWith("a"), terminal(), orphan()];
		assert.deepEqual(listedProcessRows(rows, "terminals", shown("a")), rows);
	});

	it("leaves out, in the other layouts, a running session process whose row the view shows", () => {
		const represented = sessionWith("a");
		const unreadChild = sessionWith("b", { child: "unknown" });
		for (const layout of ["flat", "folders"] as const) {
			assert.deepEqual(listedProcessRows([represented, unreadChild], layout, shown("a", "b")), []);
		}
	});

	it("keeps loose rows: a terminal, an orphan, an unknown row, the dashboard and a previous-build process", () => {
		const loose = [
			terminal(),
			orphan(),
			row({ status: "unknown", host: null }),
			row({ kind: "stats", ptyKind: "stats-dashboard", host: { kind: "stats", window: "none" } }),
			row({ source: "predecessor", status: "unknown", host: null }),
		];
		assert.deepEqual(listedProcessRows(loose, "flat", shown("a")), loose);
	});

	it("keeps a session process whose row is not shown, or whose child exited, or that only an editor slot names", () => {
		const hidden = sessionWith("not-shown");
		const idle = sessionWith("a", { child: "exited" });
		const editorOnly = row({ host: { kind: "session", tabId: null, title: "An editor of a session", folder: null, window: "none", drivenHere: false, recorded: false } });
		assert.deepEqual(listedProcessRows([hidden, idle, editorOnly], "folders", shown("a")), [hidden, idle, editorOnly]);
	});
});

describe("the process of a session", () => {
	it("indexes session processes by conversation and prefers a running one over an idle one", () => {
		const idle = row({ child: "exited", host: { kind: "session", tabId: "a", title: "a", folder: null, window: "none", drivenHere: false, recorded: true } });
		const running = row({ host: { kind: "session", tabId: "a", title: "a", folder: null, window: "none", drivenHere: false, recorded: true } });
		const byTab = processesBySession([idle, running, terminal(), orphan(), row({ source: "predecessor", host: { kind: "session", tabId: "old", title: "old", folder: null, window: "none", drivenHere: false, recorded: true } })]);
		assert.deepEqual([...byTab.keys()], ["a"]);
		assert.equal(byTab.get("a"), running);
		assert.equal(processesBySession([running, idle]).get("a"), running);
	});

	it("marks a process only on evidence that one exists, and none for a state that has none", () => {
		for (const state of ["running", "working", "background", "question", "unread", "waiting", "restoring", "stopping"]) {
			assert.equal(sessionProcessMark(state, true, null), "Process: running", state);
			assert.equal(sessionProcessMark(state, false, null), null, `${state} without evidence`);
		}
		for (const state of ["stopped", "draft", "blocked", "checking", "starting", "externalOmp"]) {
			assert.equal(sessionProcessMark(state, true, null), null, state);
		}
	});

	it("says a session another window holds is held there, never running on this window's say-so", () => {
		assert.equal(sessionProcessMark("otherWindow", false, null), "Process: held by another window");
		assert.equal(sessionProcessMark("otherWindow", true, row()), "Process: held by another window, up 1h 02m");
	});

	it("takes the uptime from the snapshot's row, and says an idle process of a stopped session is idle", () => {
		assert.equal(sessionProcessMark("working", true, row()), "Process: running, up 1h 02m");
		assert.equal(sessionProcessMark("stopped", false, row({ child: "exited" })), "Process: idle (its session ended), up 1h 02m");
		assert.equal(sessionProcessMark("stopped", false, row()), null, "a snapshot row alone does not make a stopped row's process");
	});
});

describe("what a click on a process row opens", () => {
	it("opens the session's tab only when its row is shown, the terminal's editor, or the dashboard", () => {
		assert.equal(processOpenTarget(sessionWith("a"), shown("a")), "session");
		assert.equal(processOpenTarget(sessionWith("a"), shown("b")), null);
		assert.equal(processOpenTarget(terminal(), shown()), "terminal");
		assert.equal(processOpenTarget(row({ kind: "stats", ptyKind: "stats-dashboard", host: { kind: "stats", window: "none" } }), shown()), "stats");
	});

	it("opens nothing for a predecessor's or an orphaned process", () => {
		assert.equal(processOpenTarget({ ...sessionWith("a"), source: "predecessor" }, shown("a")), null);
		assert.equal(processOpenTarget(orphan(), shown()), null);
	});
});
