import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { relativeAge } from "../../views/relative-age.ts";
import { liveSignature, NO_SESSION_MESSAGE, NOT_RUNNING_MESSAGE, projectContext, READING_MESSAGE, TERMINAL_MESSAGE } from "./context-model.ts";
import { parseContextReport } from "./context-parse.ts";
import type { ContextInputs, ContextLive, ContextViewModel } from "./context-model.ts";
import type { ContextRead, ContextReportRead } from "./context-parse.ts";

const NOW = Date.parse("2026-10-12T12:00:00.000Z");
const subject = { title: "Work", mode: "chat", running: true } as const;
const usage = (percent: number | null, tokens: number | null = 76_800, window: number | null = 200_000) => ({ tokens, contextWindow: window, percent });
const live = (overrides: Partial<ContextLive> = {}): ContextLive => ({ model: { provider: "anthropic", id: "sonnet", name: "Sonnet", contextWindow: 200_000 }, usage: usage(38.4), busy: false, rewriting: false, maintenance: null, ...overrides });
const REPORT = parseContextReport("Context window: 200000 tokens (38% used)\n  System prompt    [█░] 2%  3000 tokens\n  System tools     [█░] 4%  8000 tokens\n  Messages         [█░] 30%  60000 tokens\n  Auto-compact buf [█░] 5%  10000 tokens\n  Free             [█░] 40%  80000 tokens")!;
const reportRead = (overrides: Partial<ContextReportRead> = {}): ContextReportRead => ({ at: NOW - 60_000, usageTokensAtRead: 76_800, report: REPORT, ...overrides });
const read = (overrides: Partial<ContextRead> = {}): ContextRead => ({
	at: NOW - 60_000, autoCompaction: true,
	stats: { userMessages: 4, assistantMessages: 4, toolCalls: 9, toolResults: 9, totalMessages: 26, premiumRequests: 0, tokens: { input: 150_000, output: 12_000, reasoning: 0, cacheRead: 90_000, cacheWrite: 0 } },
	files: { files: [{ path: "C:\\proj\\AGENTS.md", chars: 1234 }], onDemand: ["C:\\proj\\src\\AGENTS.md"] },
	journal: { cost: 1.234, compactionCount: 2, lastCompaction: { timestamp: "2026-10-12T10:00:00.000Z", method: "soft", tokensBefore: 384_000, tokensAfter: 120_000, warning: null }, clearCount: 1, lastClear: "2026-10-11T12:00:00.000Z" },
	...overrides,
});
function project(overrides: Partial<ContextInputs> = {}): ContextViewModel {
	return projectContext({ subject, live: live(), read: read(), report: null, now: NOW, ...overrides });
}
const group = (model: ContextViewModel, id: string) => model.groups.find(candidate => candidate.id === id);
const item = (model: ContextViewModel, key: string) => model.groups.flatMap(candidate => candidate.items).find(candidate => candidate.key === key);

describe("empty and unknown states", () => {
	it("says why there is nothing, per cause, and offers no maintenance", () => {
		assert.deepEqual(project({ subject: null, live: null, read: null }), { description: null, message: NO_SESSION_MESSAGE, groups: [], canMaintain: false });
		assert.deepEqual(project({ subject: { ...subject, mode: "terminal" }, live: null, read: null }), { description: "Work", message: TERMINAL_MESSAGE, groups: [], canMaintain: false });
		assert.deepEqual(project({ subject: { ...subject, running: false }, live: live(), read: read() }), { description: "Work", message: NOT_RUNNING_MESSAGE, groups: [], canMaintain: false });
		assert.equal(project({ live: null, read: null }).message, NOT_RUNNING_MESSAGE);
		assert.equal(project({ live: live({ usage: null, model: null }), read: null }).message, READING_MESSAGE);
	});
	it("shows the live header, the breakdown request and the maintenance state before the first deep read", () => {
		const model = project({ read: null });
		assert.deepEqual(model.groups.map(candidate => candidate.id), ["window", "breakdown", "maintenance"]);
		assert.equal(model.canMaintain, true);
		assert.equal(model.description, "Work");
	});
	it("lists every group once the read is in", () => {
		assert.deepEqual(project().groups.map(candidate => candidate.id), ["window", "breakdown", "stats", "maintenance", "history", "files"]);
	});
});

describe("context window header", () => {
	it("prints what the Chat popover prints: rounded percent, compact tokens, the model's window", () => {
		const model = project();
		assert.equal(item(model, "window.used")?.label, "38% used");
		assert.equal(item(model, "window.used")?.description, "76.8k / 200k tokens");
		assert.equal(item(model, "window.model")?.label, "Sonnet");
		assert.equal(item(model, "window.model")?.description, "anthropic · 200k window");
	});
	it("uses the popover's thresholds and clamps a finite percentage as it does", () => {
		const tone = (percent: number) => item(project({ live: live({ usage: usage(percent) }) }), "window.used")?.tone;
		assert.deepEqual([0, 69.9, 70, 90, 90.1, 100, 140, -5].map(tone), ["normal", "normal", "warning", "warning", "critical", "critical", "critical", "normal"]);
		assert.equal(item(project({ live: live({ usage: usage(140) }) }), "window.used")?.label, "100% used");
	});
	it("never computes an unknown percentage from the token counts", () => {
		const unknown = item(project({ live: live({ usage: usage(null, 40_700) }) }), "window.used")!;
		assert.equal(unknown.label, "Usage unavailable");
		assert.equal(unknown.tone, "muted");
		assert.equal(unknown.description, "40.7k / 200k tokens");
		assert.equal(item(project({ live: live({ usage: null }) }), "window.used")?.description, "? / 200k tokens", "the window falls back to the model's, tokens stay unknown");
	});
});

describe("breakdown", () => {
	it("offers the request until a report was read, and says what it runs", () => {
		const before = group(project(), "breakdown")!;
		assert.deepEqual(before.items.map(row => [row.label, row.action]), [["Read breakdown", "readBreakdown"]]);
		assert.match(before.items[0]!.tooltip, /as if you typed it/);
		assert.equal(before.description, null);
	});
	it("lists OMP's rows with their share of the window, marks reserved space as not in use and offers to read again", () => {
		const breakdown = group(project({ report: reportRead() }), "breakdown")!;
		assert.deepEqual(breakdown.items.map(row => [row.label, row.description, row.tone]), [
			["System prompt", "3,000 tokens · 1.5% of window", "normal"],
			["System tools", "8,000 tokens · 4.0% of window", "normal"],
			["Messages", "60,000 tokens · 30% of window", "normal"],
			["Auto-compact buffer", "10,000 tokens · 5.0% of window", "muted"],
			["Free", "80,000 tokens · 40% of window", "muted"],
			["Read again", "runs /context", "normal"],
		]);
		assert.equal(breakdown.items.at(-1)?.action, "readBreakdown");
	});
	it("labels the report with its time and says only that usage changed, never why, and never rewrites it", () => {
		assert.match(group(project({ report: reportRead() }), "breakdown")!.description!, /^as of /);
		assert.doesNotMatch(group(project({ report: reportRead() }), "breakdown")!.description!, /changed/);
		const moved = project({ report: reportRead(), live: live({ usage: usage(40, 80_000) }) });
		assert.match(group(moved, "breakdown")!.description!, /; usage has changed since$/);
		assert.equal(item(moved, "breakdown.0")?.description, "3,000 tokens · 1.5% of window");
		assert.doesNotMatch(group(project({ report: reportRead({ usageTokensAtRead: null }), live: live({ usage: usage(40, 80_000) }) }), "breakdown")!.description!, /changed/, "unknown usage at read time claims nothing");
	});
	it("states OMP's own reason when it reported no usage", () => {
		const none = parseContextReport("Context usage is unavailable: no model is selected for this session.")!;
		const breakdown = group(project({ report: reportRead({ report: none }) }), "breakdown")!;
		assert.equal(breakdown.items[0]!.label, "Breakdown unavailable");
		assert.equal(breakdown.items[0]!.tooltip, "Context usage is unavailable: no model is selected for this session.");
	});
	it("keeps a line it does not know as a muted verbatim note", () => {
		const withNote = parseContextReport("Context window: 100 tokens (1% used)\n  Skills [█] 1%  1 tokens\nSnapcompact: inactive (model has no image input)")!;
		const notes = group(project({ report: reportRead({ report: withNote }) }), "breakdown")!.items.filter(row => row.key.startsWith("breakdown.note"));
		assert.deepEqual(notes.map(row => [row.label, row.tone]), [["Snapcompact: inactive (model has no image input)", "muted"]]);
	});
});

describe("this context window", () => {
	it("shows the retained messages and billed tokens (zero extras hidden)", () => {
		assert.equal(item(project(), "stats.messages")?.description, "26 · 4 user · 4 assistant · 9 tool results");
		assert.equal(item(project(), "stats.tools")?.description, "9");
		assert.equal(item(project(), "stats.tokens")?.description, "input 150k · output 12k · cache read 90k");
		assert.equal(item(project(), "stats.premium"), undefined);
	});
	it("keeps OMP's fractional premium multiplier and reports a missing source rather than zeros", () => {
		const premium = read({ stats: { ...read().stats!, premiumRequests: 0.33 + 0.25 } });
		assert.equal(item(project({ read: premium }), "stats.premium")?.description, "0.58");
		assert.equal(item(project({ read: read({ stats: null }) }), "stats.none")?.label, "Statistics unavailable");
	});
});

describe("maintenance", () => {
	it("shows the auto-compaction flag only when OMP reported it", () => {
		assert.equal(item(project(), "maintenance.auto")?.description, "on");
		assert.equal(item(project({ read: read({ autoCompaction: false }) }), "maintenance.auto")?.description, "off");
		assert.equal(item(project({ read: read({ autoCompaction: null }) }), "maintenance.auto"), undefined);
	});
	it("shows a pass this window saw, a running one with its action, and a failed one as a warning", () => {
		assert.equal(item(project({ live: live({ maintenance: { action: "shake", reason: "manual", status: "working" } }) }), "maintenance.pass")?.label, "shake in progress");
		const failed = item(project({ live: live({ maintenance: { action: "compact", status: "failed", errorMessage: "model refused" } }) }), "maintenance.pass")!;
		assert.equal(failed.tone, "warning");
		assert.match(failed.tooltip, /model refused/);
		assert.equal(item(project({ read: null }), "maintenance.none")?.label, "No pass seen");
	});
});

describe("session file", () => {
	it("lists spend, the recorded compactions with relative age and sizes, and the newest clear boundary", () => {
		const model = project();
		assert.equal(item(model, "history.cost")?.description, "$1.23");
		assert.equal(item(model, "history.count")?.description, "2 recorded");
		assert.match(item(model, "history.last")!.description!, /· soft · 384k → 120k tokens$/);
		assert.equal(item(model, "history.clear")?.label, "Last clear boundary");
		assert.equal(item(model, "history.clear")?.description, relativeAge("2026-10-11T12:00:00.000Z", NOW));
		assert.match(group(model, "history")!.tooltip!, /does not prove the clear finished/);
		assert.match(group(model, "history")!.tooltip!, /abandoned branches/);
	});
	it("hides a zero cost as the popover does and states a fresh or unreadable file without guessing", () => {
		const fresh = project({ read: read({ journal: { cost: 0, compactionCount: 0, lastCompaction: null, clearCount: 0, lastClear: null } }) });
		assert.equal(item(fresh, "history.cost"), undefined);
		assert.equal(item(fresh, "history.last"), undefined);
		assert.equal(item(fresh, "history.clear")?.description, "none recorded");
		assert.equal(item(project({ read: read({ journal: null }) }), "history.none")?.label, "Session file not read");
	});
	it("flags a compaction that carried a warning", () => {
		const warned = read({ journal: { ...read().journal!, lastCompaction: { ...read().journal!.lastCompaction!, warning: "freed too little" } } });
		assert.equal(item(project({ read: warned }), "history.last")?.tone, "warning");
	});
});

describe("context files", () => {
	it("opens each path OMP put in the prompt, marks directory rules as read on demand and says they are references", () => {
		const files = group(project(), "files")!;
		assert.deepEqual(files.items.map(row => [row.label, row.openPath, row.tone]), [["AGENTS.md", "C:\\proj\\AGENTS.md", "normal"], ["AGENTS.md", "C:\\proj\\src\\AGENTS.md", "muted"]]);
		assert.match(files.items[0]!.tooltip, /1,234 characters in the prompt/);
		assert.match(files.items[1]!.description!, /^read on demand/);
		assert.match(files.tooltip!, /not verified|references/);
	});
	it("omits the group when the prompt listed none or was not read", () => {
		assert.equal(group(project({ read: read({ files: { files: [], onDemand: [] } }) }), "files"), undefined);
		assert.equal(group(project({ read: read({ files: null }) }), "files"), undefined);
	});
});

describe("live signature", () => {
	it("changes with what the tree shows and ignores everything else", () => {
		const base = liveSignature(live());
		assert.equal(liveSignature(live()), base);
		assert.notEqual(liveSignature(live({ usage: usage(38.5) })), base);
		assert.notEqual(liveSignature(live({ busy: true })), base);
		assert.notEqual(liveSignature(live({ busy: true, rewriting: true })), liveSignature(live({ busy: true })));
		assert.notEqual(liveSignature(live({ maintenance: { action: "compact", status: "working" } })), base);
		assert.notEqual(liveSignature(live({ model: { provider: "x", id: "y", contextWindow: 1 } })), base);
	});
});
