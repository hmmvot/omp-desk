import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { AGENT_LIVENESS_STATUS_KEY, decodeAgentLiveness, type AgentLivenessPublication } from "../chat/agent-liveness.ts";
import {
	AgentLivenessPublisher,
	LIVENESS_ACTIVITY_DELAY_MS,
	LIVENESS_EDGE_DELAY_MS,
	LIVENESS_IDLE_RECHECK_MS,
	LIVENESS_REPEAT_MS,
	isLiveSubagentRef,
	registerAgentLiveness,
	stopAgentLiveness,
	subagentLiveState,
	type AgentLivenessTimers,
	type LivenessContext,
	type ObservedRun,
	type OmpAgentRef,
} from "./agent-liveness.ts";
import { hasLiveSubagents, type OmpExtensionAPI } from "./host-control.ts";

class FakeTimers implements AgentLivenessTimers {
	time = 0;
	#next = 1;
	readonly pending = new Map<number, { at: number; callback: () => void }>();
	now(): number { return this.time; }
	setTimeout(callback: () => void, ms: number): unknown {
		const id = this.#next++;
		this.pending.set(id, { at: this.time + ms, callback });
		return id;
	}
	clearTimeout(handle: unknown): void { this.pending.delete(handle as number); }
	advance(ms: number): void {
		const end = this.time + ms;
		for (;;) {
			const due = [...this.pending].filter(([, timer]) => timer.at <= end).sort((left, right) => left[1].at - right[1].at)[0];
			if (due === undefined) break;
			this.pending.delete(due[0]);
			this.time = due[1].at;
			due[1].callback();
		}
		this.time = end;
	}
}

class FakeRegistry {
	refs: OmpAgentRef[] = [];
	readonly listeners = new Set<(event: unknown) => void>();
	list(): readonly OmpAgentRef[] { return this.refs; }
	onChange(listener: (event: unknown) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	change(refs: OmpAgentRef[]): void {
		this.refs = refs;
		for (const ref of refs) for (const listener of this.listeners) listener({ type: "status_changed", ref });
		if (refs.length === 0) for (const listener of this.listeners) listener({ type: "removed" });
	}
}

const sub = (id: string, status: string, session: OmpAgentRef["session"], extra: Partial<OmpAgentRef> = {}): OmpAgentRef =>
	({ id, kind: "sub", status, displayName: id, sessionFile: `C:\\s\\${id}.jsonl`, history: { agent: "task" }, session, ...extra });

const STORE_KEY = Symbol.for("omp-vscode.agent-liveness");
function resetStore(): void {
	const holder = globalThis as { [STORE_KEY]?: { publisher: AgentLivenessPublisher | null } };
	holder[STORE_KEY]?.publisher?.stop();
	delete holder[STORE_KEY];
}

describe("subagent liveness derivation", () => {
	afterEach(resetStore);

	it("counts running, resumed-while-idle and idle-with-queued subagents only", () => {
		const ended = { lifecycle: { terminalAt: 100 } };
		const resumed = new Map<string, ObservedRun>([["a", { workAt: 150 }]]);
		const unwinding = new Map<string, ObservedRun>([["a", { workAt: 90 }]]);
		const cases: [OmpAgentRef, ReadonlyMap<string, ObservedRun>, string | null, string][] = [
			[sub("a", "running", { isStreaming: true }), new Map(), "running", "running"],
			[sub("a", "running", { isStreaming: false }), new Map(), "running", "running between turns"],
			[sub("a", "running", { isStreaming: false }, { lifecycle: { acceptedAt: 1 } }), new Map(), null, "stale accepted run"],
			[sub("a", "running", { isStreaming: true }, { lifecycle: { acceptedAt: 1 } }), new Map(), "running", "accepted but still streaming"],
			[sub("a", "idle", { isStreaming: true, queuedMessageCount: 0 }), resumed, null, "no terminalAt to compare against (fail closed)"],
			[sub("a", "idle", { isStreaming: true, queuedMessageCount: 0 }, ended), resumed, "idle", "idle ref whose binding started work after it ended (a steered resume)"],
			[sub("a", "idle", { isStreaming: true, queuedMessageCount: 0 }, ended), unwinding, null, "a finished run still unwinding"],
			[sub("a", "idle", { isStreaming: true, queuedMessageCount: 0 }, ended), new Map(), null, "streaming without a binding's observation"],
			[sub("a", "idle", { isStreaming: false, queuedMessageCount: 2 }), new Map(), "idle", "idle with queued messages"],
			[sub("a", "idle", { isStreaming: false, queuedMessageCount: 0 }, ended), resumed, null, "idle, stopped"],
			[sub("a", "parked", null), resumed, null, "parked"],
			[sub("a", "aborted", null), resumed, null, "aborted"],
			[{ ...sub("a", "running", { isStreaming: true }), kind: "main" }, new Map(), null, "main agent"],
			[{ ...sub("a", "running", { isStreaming: true }), kind: "advisor" }, new Map(), null, "advisor"],
		];
		for (const [ref, observed, state, label] of cases) assert.equal(subagentLiveState(ref, observed), state, label);
		assert.equal(isLiveSubagentRef(null), false);
	});

	it("host-control's subagentWork answer uses the same derivation and the bindings' observations", () => {
		const registry = new FakeRegistry();
		const timers = new FakeTimers();
		timers.time = 500;
		const pi = { pi: { AgentRegistry: { global: () => registry } } } as unknown as OmpExtensionAPI;
		const handlers: ((event: unknown, ctx: LivenessContext) => unknown)[] = [];
		registerAgentLiveness({ on: (event, handler) => { if (event === "turn_start") handlers.push(handler); } }, timers);
		registry.refs = [sub("a", "idle", { isStreaming: true }, { lifecycle: { terminalAt: 100 } })];
		assert.equal(hasLiveSubagents(pi), false, "streaming alone after the run ended is not work");
		for (const handler of handlers) handler({}, { agent: { kind: "sub", id: "a" } });
		assert.equal(hasLiveSubagents(pi), true, "a steered idle ref that started a turn is work");
		registry.refs = [sub("a", "idle", { isStreaming: false }, { lifecycle: { terminalAt: 100 } })];
		assert.equal(hasLiveSubagents(pi), false);
	});
});

describe("liveness publisher", () => {
	function rig() {
		const registry = new FakeRegistry();
		const timers = new FakeTimers();
		const observed = new Map<string, ObservedRun>();
		const published: AgentLivenessPublication[] = [];
		const publisher = new AgentLivenessPublisher({
			registry: () => registry, sessionId: () => "S1", observed, timers, instance: "a".repeat(32),
			publish: text => { const decoded = decodeAgentLiveness(text); assert.ok(decoded); published.push(decoded); },
		});
		return { registry, timers, observed, published, publisher };
	}

	it("publishes on registry events, coalesced, and only when the set changes", () => {
		const { registry, timers, published, publisher } = rig();
		publisher.start();
		timers.advance(200);
		assert.deepEqual(published.map(entry => entry.agents.length), [0], "the initial empty set");
		assert.equal(timers.pending.size, 0, "no timer while nothing is live");
		registry.change([sub("w", "running", { isStreaming: true })]);
		registry.change([sub("w", "running", { isStreaming: true })]);
		timers.advance(200);
		assert.equal(published.length, 2, "two registry events, one publication");
		assert.deepEqual(published[1]?.agents, [{ id: "w", agent: "task", state: "running", sessionFile: "C:\\s\\w.jsonl" }]);
		assert.equal(published[1]?.sessionId, "S1");
		registry.change([sub("w", "running", { isStreaming: true })]);
		timers.advance(200);
		assert.equal(published.length, 2, "an unchanged set is not republished at once");
		timers.advance(LIVENESS_REPEAT_MS);
		assert.equal(published.length, 3, "a non-empty set is repeated for a host that resynchronised");
		assert.ok(published[2]!.seq > published[1]!.seq);
		registry.change([sub("w", "idle", { isStreaming: false })]);
		timers.advance(200);
		assert.deepEqual(published.at(-1)?.agents, []);
		assert.equal(timers.pending.size, 0);
		publisher.stop();
	});

	it("re-checks an idle agent that is live only by its resumed run, since its end emits no registry event", () => {
		const { registry, timers, published, observed, publisher } = rig();
		timers.time = 1_000;
		publisher.start();
		const session = { isStreaming: true, queuedMessageCount: 0 };
		registry.change([sub("w", "idle", session, { lifecycle: { terminalAt: 500 } })]);
		observed.set("w", { workAt: 900, tool: "bash", intent: "Sleeping 45 s" });
		timers.advance(200);
		assert.deepEqual(published.at(-1)?.agents, [{ id: "w", agent: "task", state: "idle", sessionFile: "C:\\s\\w.jsonl", tool: "bash", intent: "Sleeping 45 s" }]);
		session.isStreaming = false;
		timers.advance(LIVENESS_IDLE_RECHECK_MS);
		assert.deepEqual(published.at(-1)?.agents, [], "removed when it stops, without any event");
		publisher.stop();
		assert.equal(timers.pending.size, 0);
	});

	it("republishes on a running → idle edge and clears the finished run's activity", () => {
		const { registry, timers, published, observed, publisher } = rig();
		timers.time = 1_000;
		publisher.start();
		registry.change([sub("w", "running", { isStreaming: true })]);
		observed.set("w", { workAt: 1_000, tool: "read", intent: "Reading" });
		timers.advance(200);
		assert.equal(published.at(-1)?.agents[0]?.tool, "read");
		const count = published.length;
		observed.set("w", { workAt: 2_000, tool: "read", intent: "Reading" });
		registry.change([sub("w", "idle", { isStreaming: true }, { lifecycle: { terminalAt: 1_500 } })]);
		timers.advance(200);
		assert.equal(published.length, count + 1, "the state change alone republishes");
		assert.deepEqual(published.at(-1)?.agents, [{ id: "w", agent: "task", state: "idle", sessionFile: "C:\\s\\w.jsonl" }]);
		publisher.stop();
	});

	it("retries a failed publication", () => {
		const registry = new FakeRegistry();
		const timers = new FakeTimers();
		let fail = true;
		const published: string[] = [];
		const publisher = new AgentLivenessPublisher({
			registry: () => registry, sessionId: () => "S1", observed: new Map(), timers, instance: "a".repeat(32),
			publish: text => { if (fail) throw new Error("ui gone"); published.push(text); },
		});
		publisher.start();
		timers.advance(200);
		assert.equal(published.length, 0);
		fail = false;
		timers.advance(LIVENESS_IDLE_RECHECK_MS);
		assert.equal(published.length, 1);
		assert.equal(decodeAgentLiveness(published[0])?.seq, 1, "a failed attempt does not consume a sequence number");
		publisher.stop();
	});

	it("falls back to the registry's own activity gist", () => {
		const { registry, timers, published, publisher } = rig();
		publisher.start();
		registry.change([sub("w", "running", { isStreaming: true }, { activity: "reading files" })]);
		timers.advance(200);
		assert.equal(published.at(-1)?.agents[0]?.intent, "reading files");
		publisher.stop();
	});
});

describe("liveness wiring", () => {
	afterEach(resetStore);

	function binding(registry: FakeRegistry, timers: FakeTimers) {
		const handlers = new Map<string, ((event: unknown, ctx: LivenessContext) => unknown)[]>();
		const pi = {
			on(event: string, handler: (event: unknown, ctx: LivenessContext) => unknown) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
			pi: { AgentRegistry: { global: () => registry } },
		};
		registerAgentLiveness(pi, timers);
		return (event: string, payload: unknown, ctx: LivenessContext) => { for (const handler of handlers.get(event) ?? []) handler(payload, ctx); };
	}

	it("publishes only from the RPC main binding, with activity a subagent binding observed", () => {
		const registry = new FakeRegistry();
		const timers = new FakeTimers();
		const statuses: [string, string | undefined][] = [];
		const ui = { setStatus: (key: string, text: string | undefined) => { statuses.push([key, text]); } };
		const main = binding(registry, timers);
		const child = binding(registry, timers);
		const sessionManager = { getSessionId: () => "S1" };
		main("session_start", {}, { mode: "tui", agent: { kind: "main", id: "Main" }, sessionManager, ui });
		child("session_start", {}, { mode: "rpc", agent: { kind: "sub", id: "w" }, sessionManager, ui });
		timers.advance(LIVENESS_REPEAT_MS);
		assert.equal(statuses.length, 0, "the native TUI and a subagent binding never publish");
		main("session_start", {}, { mode: "rpc", agent: { kind: "main", id: "Main" }, sessionManager, ui });
		timers.time = 1_000;
		registry.change([sub("w", "idle", { isStreaming: true }, { lifecycle: { terminalAt: 500 } })]);
		child("tool_execution_start", { toolName: "bash", intent: "Sleeping" }, { mode: "rpc", agent: { kind: "sub", id: "w" } });
		timers.advance(LIVENESS_ACTIVITY_DELAY_MS);
		const last = statuses.at(-1);
		assert.equal(last?.[0], AGENT_LIVENESS_STATUS_KEY);
		assert.deepEqual(decodeAgentLiveness(last?.[1])?.agents, [{ id: "w", agent: "task", state: "idle", sessionFile: "C:\\s\\w.jsonl", tool: "bash", intent: "Sleeping" }]);
		child("agent_end", { willContinue: false }, { mode: "rpc", agent: { kind: "sub", id: "w" } });
		registry.change([sub("w", "idle", { isStreaming: false }, { lifecycle: { terminalAt: 500 } })]);
		timers.advance(LIVENESS_EDGE_DELAY_MS);
		assert.deepEqual(decodeAgentLiveness(statuses.at(-1)?.[1])?.agents, []);
		stopAgentLiveness();
		assert.equal(registry.listeners.size, 0, "stopping unsubscribes from the registry");
		assert.equal(timers.pending.size, 0);
	});
});
