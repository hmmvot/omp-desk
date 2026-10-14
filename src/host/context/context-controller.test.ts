import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createChatModel } from "../../chat/model.ts";
import { breakdownFailure, ContextController, DEEP_READ_DEBOUNCE_MS } from "./context-controller.ts";
import { parseContextReport } from "./context-parse.ts";
import type { ChatModel } from "../../chat/model.ts";
import type { CommandResult, RpcSessionOutput } from "../rpc/session.ts";
import type { ContextControllerDeps, ContextSession, ContextTarget } from "./context-controller.ts";
import type { ContextViewModel } from "./context-model.ts";
import type { ContextRead, ContextReportRead } from "./context-parse.ts";

const REPORT = parseContextReport("Context window: 1000 tokens (10% used)\n  Skills [█] 1%  10 tokens")!;
const emptyRead = (at: number): ContextRead => ({ at, autoCompaction: true, stats: null, files: null, journal: null });

/** A session whose model the test edits and whose reads the test settles by hand. */
class FakeSession implements ContextSession {
	model: ChatModel;
	readonly listeners = new Set<(output: RpcSessionOutput) => void>();
	readonly reads: Array<{ resolve: (read: ContextRead | null) => void }> = [];
	readonly requests: Array<{ resolve: (result: CommandResult<ContextReportRead>) => void }> = [];
	constructor() {
		this.model = { ...createChatModel(), phase: "live", state: { model: { provider: "p", id: "m", name: "M", contextWindow: 1000 }, thinkingLevel: null, isStreaming: false, isCompacting: false, queuedMessageCount: 0, contextUsage: { tokens: 100, contextWindow: 1000, percent: 10 } } };
	}
	subscribe(listener: (output: RpcSessionOutput) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	readContext(): Promise<ContextRead | null> { return new Promise(resolve => this.reads.push({ resolve })); }
	requestContextReport(): Promise<CommandResult<ContextReportRead>> { return new Promise(resolve => this.requests.push({ resolve })); }
	/** Change the model as the session does and tell the subscribers. */
	change(patch: Partial<ChatModel>): void {
		this.model = { ...this.model, ...patch };
		for (const listener of [...this.listeners]) listener({ type: "model", model: this.model });
	}
	emit(output: RpcSessionOutput): void { for (const listener of [...this.listeners]) listener(output); }
}

function harness(initial: ContextTarget | null) {
	const state = { target: initial, published: [] as ContextViewModel[], notices: [] as string[], logs: [] as string[], timers: [] as Array<{ handler: () => void; ms: number; live: boolean }>, now: Date.parse("2026-10-12T12:00:00.000Z") };
	const deps: ContextControllerDeps = {
		// A new object per call, as the extension builds it: nothing may be fenced by the wrapper's identity.
		target: () => (state.target === null ? null : { ...state.target }),
		publish: model => { state.published.push(model); },
		notify: message => { state.notices.push(message); },
		schedule: (handler, ms) => { const timer = { handler, ms, live: true }; state.timers.push(timer); return timer; },
		cancel: handle => { (handle as { live: boolean }).live = false; },
		now: () => state.now,
		log: message => { state.logs.push(message); },
	};
	const controller = new ContextController(deps);
	/** Fire the pending timer, as the debounce elapsing. */
	const fire = (): void => { const timer = state.timers.filter(candidate => candidate.live).at(-1); if (timer !== undefined) { timer.live = false; timer.handler(); } };
	return { state, controller, fire, last: () => state.published.at(-1)! };
}

function target(session: FakeSession | null, overrides: Partial<ContextTarget> = {}): ContextTarget {
	return { key: session ?? {}, generation: "g1", mode: "chat", running: true, title: "Work", tabId: "tab-1", session, ...overrides };
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

describe("visibility", () => {
	it("reads nothing and subscribes to nothing until the view is visible, and stops when it hides", async () => {
		const session = new FakeSession();
		const { controller, fire, state, last } = harness(target(session));
		controller.sync();
		controller.refresh();
		assert.equal(session.listeners.size, 0);
		assert.equal(state.published.length, 0);
		controller.setVisible(true);
		assert.equal(session.listeners.size, 1);
		assert.equal(last().groups[0]?.id, "window");
		fire();
		await flush();
		assert.equal(session.reads.length, 1);
		controller.setVisible(false);
		assert.equal(session.listeners.size, 0);
		session.reads[0]!.resolve(emptyRead(1));
		await flush();
		const published = state.published.length;
		session.change({ working: false });
		assert.equal(state.published.length, published, "a hidden view publishes nothing");
	});
});

describe("selection", () => {
	it("shows an empty state for no editor and for a Terminal, and follows a switch between chats", async () => {
		const first = new FakeSession();
		const second = new FakeSession();
		second.model = { ...second.model, state: { ...second.model.state!, contextUsage: { tokens: 900, contextWindow: 1000, percent: 90 } } };
		const h = harness(null);
		h.controller.setVisible(true);
		assert.match(h.last().message ?? "", /Open an OMP Desk Chat/);
		h.state.target = target(null, { mode: "terminal", key: {} });
		h.controller.sync();
		assert.match(h.last().message ?? "", /Terminal/);
		h.state.target = target(first);
		h.controller.sync();
		h.fire();
		await flush();
		first.reads[0]!.resolve(emptyRead(1));
		await flush();
		assert.equal(first.listeners.size, 1);
		const used = (model: ContextViewModel) => model.groups[0]!.items.find(row => row.key === "window.used")!.label;
		assert.equal(used(h.last()), "10% used");
		h.state.target = target(second, { title: "Other", tabId: "tab-2" });
		h.controller.sync();
		assert.equal(first.listeners.size, 0, "the old session is released");
		assert.equal(second.listeners.size, 1);
		assert.equal(used(h.last()), "90% used");
		assert.equal(h.last().description, "Other");
		assert.equal(h.last().groups.some(group => group.id === "stats"), false, "nothing read for the first session leaks into the second");
	});
	it("drops a deep read that finishes after the selection moved on", async () => {
		const first = new FakeSession();
		const second = new FakeSession();
		const h = harness(target(first));
		h.controller.setVisible(true);
		h.fire();
		await flush();
		h.state.target = target(second);
		h.controller.sync();
		first.reads[0]!.resolve({ ...emptyRead(1), stats: { userMessages: 1, assistantMessages: 1, toolCalls: 0, toolResults: 0, totalMessages: 2, premiumRequests: 0, tokens: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 } } });
		await flush();
		assert.equal(h.last().groups.some(group => group.id === "stats"), false);
	});
	it("re-evaluates the selection on a snapshot and drops what it knew on an identity change", async () => {
		const session = new FakeSession();
		const h = harness(target(session));
		h.controller.setVisible(true);
		h.fire();
		await flush();
		session.reads[0]!.resolve(emptyRead(1));
		await flush();
		assert.equal(h.last().groups.some(group => group.id === "history"), true);
		session.emit({ type: "identity", sessionFile: "C:\\s\\b.jsonl", sessionId: "b", previousSessionId: "a" });
		assert.equal(h.last().groups.some(group => group.id === "history"), false, "a cleared conversation is not described by the old read");
		h.fire();
		await flush();
		assert.equal(session.reads.length, 2, "and a new read is asked for");
		session.reads[1]!.resolve(emptyRead(2));
		await flush();
		const published = h.state.published.length;
		h.state.target = target(session, { generation: "g2" });
		session.emit({ type: "snapshot", payload: {} as never, baseline: false });
		assert.ok(h.state.published.length > published, "the new generation replaced the selection");
		assert.equal(h.last().groups.some(group => group.id === "history"), false);
	});
});

describe("refresh policy", () => {
	it("reads once per settle, never while a turn runs, and discards a read a turn overtook", async () => {
		const session = new FakeSession();
		const h = harness(target(session));
		h.controller.setVisible(true);
		h.fire();
		await flush();
		session.reads[0]!.resolve(emptyRead(1));
		await flush();
		// A turn starts: the header follows, no read is scheduled.
		const timers = h.state.timers.length;
		session.change({ working: true });
		assert.equal(h.state.timers.length, timers);
		// Streaming deltas that change nothing the tree shows publish nothing.
		const published = h.state.published.length;
		session.change({ working: true });
		session.change({ working: true });
		assert.equal(h.state.published.length, published);
		// The turn ends with a new figure: one debounced read.
		session.change({ working: false, state: { ...session.model.state!, contextUsage: { tokens: 400, contextWindow: 1000, percent: 40 } } });
		const scheduled = h.state.timers.filter(timer => timer.live);
		assert.equal(scheduled.length, 1);
		assert.equal(scheduled[0]!.ms, DEEP_READ_DEBOUNCE_MS);
		h.fire();
		await flush();
		assert.equal(session.reads.length, 2);
		// Another turn begins while that read is in flight: its result describes a conversation that has moved on.
		session.change({ working: true });
		session.reads[1]!.resolve({ ...emptyRead(2), autoCompaction: false });
		await flush();
		assert.equal(h.last().groups.find(group => group.id === "maintenance")!.items.find(row => row.key === "maintenance.auto")?.description, "on", "the earlier read stays");
		// Its end asks again.
		session.change({ working: false });
		h.fire();
		await flush();
		assert.equal(session.reads.length, 3);
	});
	it("runs one read at a time and queues one more for a change that came meanwhile", async () => {
		const session = new FakeSession();
		const h = harness(target(session));
		h.controller.setVisible(true);
		h.fire();
		await flush();
		h.controller.refresh();
		h.fire();
		await flush();
		assert.equal(session.reads.length, 1, "a second request waits for the first");
		session.reads[0]!.resolve(emptyRead(1));
		await flush();
		h.fire();
		await flush();
		assert.equal(session.reads.length, 2);
	});
	it("keeps the last read when one fails and logs it", async () => {
		const session = new FakeSession();
		session.readContext = () => Promise.reject(new Error("boom"));
		const h = harness(target(session));
		h.controller.setVisible(true);
		h.fire();
		await flush();
		assert.deepEqual(h.state.logs, ["context: read failed: boom"]);
		assert.ok(h.last().groups.length > 0);
	});
	it("does nothing for a session that is not running or a Terminal", () => {
		const session = new FakeSession();
		const h = harness(target(session, { running: false }));
		h.controller.setVisible(true);
		assert.equal(session.listeners.size, 0);
		assert.match(h.last().message ?? "", /not running/);
		h.fire();
		assert.equal(session.reads.length, 0);
		h.state.target = target(session, { running: true });
		h.controller.sync();
		assert.equal(session.listeners.size, 1, "starting the session attaches the view");
	});
});

describe("a session that cannot answer yet, or is mid-turn", () => {
	const hasStats = (model: ContextViewModel): boolean => model.groups.some(group => group.id === "stats");
	const tokens = (value: number) => ({ tokens: value, contextWindow: 1000, percent: value / 10 });
	it("reads a conversation that is already mid-turn when the view attaches, and keeps the read through the turn", async () => {
		const session = new FakeSession();
		session.model = { ...session.model, working: true };
		const h = harness(target(session));
		h.controller.setVisible(true);
		h.fire();
		await flush();
		assert.equal(session.reads.length, 1, "a long turn must not leave the view without its deep groups");
		session.reads[0]!.resolve(emptyRead(1));
		await flush();
		assert.equal(hasStats(h.last()), true);
		// With a read in hand the turn's own usage changes ask for nothing: refreshes wait for idle.
		const timers = h.state.timers.length;
		session.change({ state: { ...session.model.state!, contextUsage: tokens(300) } });
		assert.equal(h.state.timers.length, timers);
		// The user's Refresh is explicit and runs even mid-turn.
		h.controller.refresh();
		h.fire();
		await flush();
		assert.equal(session.reads.length, 2);
	});
	it("reads again mid-turn when the selection's generation changed and wiped the read", async () => {
		const session = new FakeSession();
		const h = harness(target(session));
		h.controller.setVisible(true);
		h.fire();
		await flush();
		session.reads[0]!.resolve(emptyRead(1));
		await flush();
		session.change({ working: true });
		h.state.target = target(session, { generation: "g2" });
		session.emit({ type: "snapshot", payload: {} as never, baseline: false });
		assert.equal(hasStats(h.last()), false, "the new epoch is not described by the old read");
		h.fire();
		await flush();
		assert.equal(session.reads.length, 2);
		session.reads[1]!.resolve(emptyRead(2));
		await flush();
		assert.equal(hasStats(h.last()), true);
	});
	it("does not read during a compaction or a pass, and asks again when it ends even though the turn goes on", async () => {
		const session = new FakeSession();
		session.model = { ...session.model, working: true, maintenance: { action: "context-full", status: "working", reason: "threshold" } };
		const h = harness(target(session));
		h.controller.setVisible(true);
		h.fire();
		await flush();
		assert.equal(session.reads.length, 0);
		session.change({ maintenance: { action: "context-full", status: "complete", reason: "threshold" } });
		const scheduled = h.state.timers.filter(timer => timer.live);
		assert.equal(scheduled.length, 1, "the pass ending asks, with the turn still running and nothing read");
		h.fire();
		await flush();
		assert.equal(session.reads.length, 1);
		session.reads[0]!.resolve(emptyRead(1));
		await flush();
		assert.equal(hasStats(h.last()), true);
	});
	it("discards a read that a pass began under, but not one that merely runs under a turn", async () => {
		const session = new FakeSession();
		session.model = { ...session.model, working: true };
		const h = harness(target(session));
		h.controller.setVisible(true);
		h.fire();
		await flush();
		session.change({ working: false });
		session.reads[0]!.resolve(emptyRead(1));
		await flush();
		assert.equal(hasStats(h.last()), true, "the turn ending under the read does not describe a moved-on conversation");
		h.controller.refresh();
		h.fire();
		await flush();
		session.change({ state: { ...session.model.state!, isCompacting: true } });
		session.reads[1]!.resolve({ ...emptyRead(2), autoCompaction: false });
		await flush();
		assert.equal(h.last().groups.find(group => group.id === "maintenance")!.items.find(row => row.key === "maintenance.auto")?.description, "on", "the earlier read stays");
	});
	it("does not ask a session that is not live, and reads when its next phase change makes it live", async () => {
		const session = new FakeSession();
		session.model = { ...session.model, phase: "resyncing" };
		const h = harness(target(session));
		h.controller.setVisible(true);
		h.fire();
		await flush();
		assert.equal(session.reads.length, 0);
		session.emit({ type: "state", payload: {} as never });
		assert.equal(h.state.timers.filter(timer => timer.live).length, 0, "a phase change that is still not live asks nothing");
		session.model = { ...session.model, phase: "live" };
		session.emit({ type: "state", payload: {} as never });
		assert.equal(h.state.timers.filter(timer => timer.live).length, 1, "the transition into live asks, debounced");
		h.fire();
		await flush();
		assert.equal(session.reads.length, 1);
		session.reads[0]!.resolve(emptyRead(1));
		await flush();
		assert.equal(hasStats(h.last()), true);
		const timers = h.state.timers.length;
		session.emit({ type: "state", payload: {} as never });
		assert.equal(h.state.timers.length, timers, "once read, a phase change asks for nothing");
	});
	it("retries a read that came back empty on the next state change or snapshot, not on a timer, and says so in the log", async () => {
		const session = new FakeSession();
		const h = harness(target(session));
		h.controller.setVisible(true);
		h.fire();
		await flush();
		session.reads[0]!.resolve(null);
		await flush();
		assert.equal(hasStats(h.last()), false);
		assert.equal(h.state.logs.length, 1);
		assert.equal(h.state.timers.filter(timer => timer.live).length, 0, "nothing is scheduled by itself");
		session.emit({ type: "state", payload: {} as never });
		h.fire();
		await flush();
		assert.equal(session.reads.length, 2);
		session.reads[1]!.resolve(null);
		await flush();
		session.emit({ type: "snapshot", payload: {} as never, baseline: false });
		h.fire();
		await flush();
		assert.equal(session.reads.length, 3, "a snapshot that kept the generation asks too");
		session.reads[2]!.resolve(emptyRead(3));
		await flush();
		assert.equal(hasStats(h.last()), true);
	});
});

describe("lifetime", () => {
	it("keeps following the session across syncs and title changes that build an equivalent target", async () => {
		const session = new FakeSession();
		const h = harness(target(session));
		h.controller.setVisible(true);
		h.fire();
		await flush();
		h.controller.sync();
		h.controller.refresh();
		h.state.target = target(session, { title: "Renamed" });
		h.controller.sync();
		assert.equal(h.last().description, "Renamed");
		assert.equal(session.listeners.size, 1);
		session.reads[0]!.resolve(emptyRead(1));
		await flush();
		assert.equal(h.last().groups.some(group => group.id === "history"), true, "a read pending across those syncs still lands");
		session.change({ working: true });
		session.change({ working: false, state: { ...session.model.state!, contextUsage: { tokens: 500, contextWindow: 1000, percent: 50 } } });
		assert.equal(h.last().groups[0]!.items.find(row => row.key === "window.used")!.label, "50% used", "live events still reach the tree");
		h.fire();
		await flush();
		assert.equal(session.reads.length, 2, "and the next read is not stuck behind the old one");
	});
	it("attaches again when the same session becomes visible again", async () => {
		const session = new FakeSession();
		const h = harness(target(session));
		h.controller.setVisible(true);
		h.fire();
		await flush();
		h.controller.setVisible(false);
		assert.equal(session.listeners.size, 0);
		session.reads[0]!.resolve(emptyRead(1));
		await flush();
		session.model = { ...session.model, state: { ...session.model.state!, contextUsage: { tokens: 800, contextWindow: 1000, percent: 80 } } };
		h.controller.setVisible(true);
		assert.equal(session.listeners.size, 1);
		assert.equal(h.last().groups[0]!.items.find(row => row.key === "window.used")!.label, "80% used");
		assert.equal(h.last().groups.some(group => group.id === "history"), false, "what was read before hiding is not shown as current");
		h.fire();
		await flush();
		assert.equal(session.reads.length, 2);
		assert.equal(session.reads[1] !== undefined, true);
	});
	it("discards a read that a whole turn overtook, even though it resolves idle, and reads again", async () => {
		const session = new FakeSession();
		const h = harness(target(session));
		h.controller.setVisible(true);
		h.fire();
		await flush();
		session.change({ working: true });
		session.change({ working: false });
		session.reads[0]!.resolve({ ...emptyRead(1), autoCompaction: false });
		await flush();
		assert.equal(h.last().groups.some(group => group.id === "history"), false, "the mixed-moment read is not shown");
		h.fire();
		await flush();
		assert.equal(session.reads.length, 2, "it is asked for again");
	});
	it("drops a breakdown that arrives after the identity changed", async () => {
		const session = new FakeSession();
		const h = harness(target(session));
		h.controller.setVisible(true);
		const done = h.controller.readBreakdown();
		session.emit({ type: "identity", sessionFile: "C:\\s\\b.jsonl", sessionId: "b", previousSessionId: "a" });
		session.requests[0]!.resolve({ status: "ok", value: { at: h.state.now, usageTokensAtRead: 100, report: REPORT } });
		await done;
		assert.deepEqual(h.last().groups.find(group => group.id === "breakdown")!.items.map(row => row.label), ["Read breakdown"]);
	});
});

describe("explicit breakdown", () => {
	it("shows the report it read and says nothing was refreshed by itself", async () => {
		const session = new FakeSession();
		const h = harness(target(session));
		h.controller.setVisible(true);
		const done = h.controller.readBreakdown();
		session.requests[0]!.resolve({ status: "ok", value: { at: h.state.now, usageTokensAtRead: 100, report: REPORT } });
		await done;
		assert.deepEqual(h.last().groups.find(group => group.id === "breakdown")!.items.map(row => row.label), ["Skills", "Read again"]);
		session.change({ working: false, state: { ...session.model.state!, contextUsage: { tokens: 700, contextWindow: 1000, percent: 70 } } });
		assert.match(h.last().groups.find(group => group.id === "breakdown")!.description ?? "", /usage has changed since/);
	});
	it("says in a sentence why it did not run, and shows nothing it did not read", async () => {
		const session = new FakeSession();
		const h = harness(target(session));
		h.controller.setVisible(true);
		const done = h.controller.readBreakdown();
		session.requests[0]!.resolve({ status: "refused", reason: "busy" });
		await done;
		assert.deepEqual(h.state.notices, ["OMP is busy with another request; read the breakdown again when it is idle."]);
		assert.deepEqual(h.last().groups.find(group => group.id === "breakdown")!.items.map(row => row.label), ["Read breakdown"]);
	});
	it("drops a report that arrives after the selection moved on", async () => {
		const first = new FakeSession();
		const second = new FakeSession();
		const h = harness(target(first));
		h.controller.setVisible(true);
		const done = h.controller.readBreakdown();
		h.state.target = target(second);
		h.controller.sync();
		first.requests[0]!.resolve({ status: "ok", value: { at: h.state.now, usageTokensAtRead: 100, report: REPORT } });
		await done;
		assert.deepEqual(h.last().groups.find(group => group.id === "breakdown")!.items.map(row => row.label), ["Read breakdown"]);
		assert.deepEqual(h.state.notices, []);
	});
	it("ignores the request for a Terminal, a stopped session and a hidden view", async () => {
		const session = new FakeSession();
		const h = harness(target(session, { running: false }));
		await h.controller.readBreakdown();
		h.controller.setVisible(true);
		await h.controller.readBreakdown();
		assert.equal(session.requests.length, 0);
	});
	it("words every refusal", () => {
		assert.match(breakdownFailure({ status: "unconfirmed" }), /did not report/);
		assert.match(breakdownFailure({ status: "refused", reason: "busy" }), /busy/);
		assert.match(breakdownFailure({ status: "refused", reason: "not-live" }), /not accepting commands/);
		assert.match(breakdownFailure({ status: "refused", reason: "not-owner" }), /not accepting commands/);
		assert.match(breakdownFailure({ status: "refused", reason: "rejected" }), /did not run \/context as a command/);
	});
});
