import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createOmpHostControlAdapter, type OmpExtensionContext } from "../omp/host-control.ts";
import { CONTROL_NATIVE_ACTIVITY_CAPACITY, type ControlNativeActivityOutcome } from "./control-protocol.ts";
import { NativeActivityLedger, type NativeActivityHook } from "./native-activity.ts";
import type { NotificationSuppression } from "./notifications.ts";

function native(includeWork = true) {
	const state = { id: "session-a", idle: true, queued: false, jobs: 0, agents: [] as Record<string, unknown>[], registryThrows: false,
		deliveryQueued: 0, delivering: false, pendingJobIds: [] as string[] };
	const context: OmpExtensionContext = {
		mode: "tui", agent: { kind: "main" },
		sessionManager: { getSessionId: () => state.id, getSessionFile: () => null, getCwd: () => "folder" },
		isIdle: () => state.idle,
		hasPendingMessages: () => state.queued,
		getAsyncJobSnapshot: () => ({ running: Array(state.jobs).fill({}), delivery: {
			queued: state.deliveryQueued, delivering: state.delivering, pendingJobIds: state.pendingJobIds,
		} }),
	};
	const adapter = createOmpHostControlAdapter({ on() {}, getActiveTools: () => [], getAllTools: () => [], pi: { AgentRegistry: { global: () => ({ list: () => {
		if (state.registryThrows) throw new Error("registry unavailable");
		return state.agents;
	} }) } } });
	adapter.observeContext(context);
	const ledger = new NativeActivityLedger();
	let epoch = "a".repeat(32);
	const snapshot = () => adapter.nativeActivity!(epoch, includeWork);
	const read = (suppression: NotificationSuppression | null = null, expectedSessionId = state.id) => ledger.observe(snapshot(), expectedSessionId, suppression);
	read();
	return {
		state, context, adapter, ledger, read, snapshot,
		event(kind: NativeActivityHook, event: unknown = {}, ctx = context) { adapter.observeActivity(kind, event, ctx); },
		finish(outcome: ControlNativeActivityOutcome, willContinue = false) {
			adapter.observeActivity("message_end", { message: { role: "assistant", stopReason: outcome } }, context);
			adapter.observeActivity("agent_end", { messages: [{ role: "assistant", stopReason: outcome }], willContinue }, context);
		},
		newEpoch() { epoch = "b".repeat(32); },
	};
}
const ask = (toolCallId: string) => ({ toolCallId, toolName: "ask", args: { questions: [{ question: "Proceed?\nsecret second line", options: [{ label: "secret option" }] }], private: "secret payload" } });

describe("native terminal settle", () => {
	it("waits for actual SDK idle, including queued messages and asynchronous work", () => {
		const n = native();
		n.state.idle = false;
		n.event("agent_start");
		n.finish("stop");
		assert.deepEqual(n.read(), []);
		n.state.idle = true;
		n.state.queued = true;
		assert.deepEqual(n.read(), []);
		n.state.queued = false;
		n.state.jobs = 1;
		assert.deepEqual(n.read(), []);
		n.state.jobs = 0;
		assert.deepEqual(n.read(), [{ kind: "turn-complete", outcome: "stop" }]);
		assert.deepEqual(n.read(), []);
	});

	it("notifies terminal errors/tool-call stops, but never user-aborted outcomes", () => {
		for (const outcome of ["stop", "length", "toolUse", "error", "aborted"] as const) {
			const n = native();
			n.event("agent_start");
			n.finish(outcome);
			assert.deepEqual(n.read(), outcome === "aborted" ? [] : [{ kind: "turn-complete", outcome }]);
		}
	});

	it("vetoes exception-path aborts that did not emit a fresh message_end", () => {
		const n = native();
		n.event("agent_start");
		n.event("message_end", { message: { role: "assistant", stopReason: "toolUse" } });
		n.event("agent_end", { messages: [{ role: "assistant", stopReason: "aborted" }] });
		assert.deepEqual(n.read(), []);
	});

	it("does not reuse a previous run's assistant for an empty/aborted continuation", () => {
		const n = native();
		n.event("agent_start"); n.finish("stop"); n.read();
		n.event("agent_start");
		n.event("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
		assert.deepEqual(n.read(), []);
	});

	it("cancels a provisional continuation on a new agent_start", () => {
		const n = native();
		n.state.idle = false;
		n.event("agent_start");
		n.finish("error", true);
		assert.deepEqual(n.read(), []);
		n.event("agent_start");
		n.state.idle = true;
		assert.deepEqual(n.read(), []);
		n.state.idle = false;
		n.finish("stop");
		n.event("agent_start");
		n.state.idle = true;
		assert.deepEqual(n.read(), []);
	});

	it("cannot turn unknown SDK settled state into idle", () => {
		const n = native();
		const unknown = { ...n.context };
		delete unknown.isIdle;
		n.adapter.observeContext(unknown);
		n.event("agent_start", {}, unknown);
		n.event("message_end", { message: { role: "assistant", stopReason: "stop" } }, unknown);
		n.event("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] }, unknown);
		assert.deepEqual(n.read(), []);
	});

	it("retains a fresh willContinue candidate until background jobs and result delivery drain without a wake", () => {
		const n = native();
		n.state.idle = false;
		n.event("agent_start");
		n.state.jobs = 1;
		n.finish("stop", true);
		assert.deepEqual(n.read(), []);
		assert.deepEqual(n.snapshot().work, { working: true, backgroundWork: true });
		n.state.idle = true;
		assert.deepEqual(n.snapshot().work, { working: false, backgroundWork: true });
		assert.deepEqual(n.read(), []);
		n.state.jobs = 0;
		n.state.deliveryQueued = 1;
		assert.deepEqual(n.read(), []);
		n.state.deliveryQueued = 0; n.state.delivering = true;
		assert.deepEqual(n.read(), []);
		n.state.delivering = false; n.state.pendingJobIds = ["result"];
		assert.deepEqual(n.read(), []);
		n.state.pendingJobIds = [];
		assert.deepEqual(n.snapshot().work, { working: false, backgroundWork: false });
		assert.deepEqual(n.read(), [{ kind: "turn-complete", outcome: "stop" }]);
		assert.deepEqual(n.read(), []);
	});

	describe("registry subagents that are not async jobs", () => {
		const sub = (patch: Record<string, unknown> = {}) => ({ kind: "sub", status: "running", session: { isStreaming: true, queuedMessageCount: 0 }, ...patch });

		it("an idle main with one running registry subagent is background work, and the row returns to idle when it stops", () => {
			const n = native();
			n.state.idle = false;
			n.event("agent_start");
			n.finish("stop");
			n.state.idle = true;
			n.state.agents.push(sub());
			assert.deepEqual(n.snapshot().work, { working: false, backgroundWork: true });
			assert.deepEqual(n.read(), [], "no turn-complete while a revived subagent still runs");
			n.state.agents[0] = sub({ status: "idle", session: { isStreaming: false, queuedMessageCount: 0 } });
			assert.deepEqual(n.snapshot().work, { working: false, backgroundWork: false });
			assert.deepEqual(n.read(), [{ kind: "turn-complete", outcome: "stop" }]);
			assert.deepEqual(n.read(), []);
		});

		it("parked, aborted, completed, advisor, main and stale-accepted refs are not background work", () => {
			const n = native();
			n.state.agents.push(
				sub({ status: "parked", session: null }), sub({ status: "aborted", session: null }), sub({ status: "idle" }),
				sub({ kind: "advisor" }), sub({ kind: "main" }),
				sub({ lifecycle: { acceptedAt: 1 }, session: { isStreaming: false, queuedMessageCount: 0 } }),
			);
			assert.deepEqual(n.snapshot().work, { working: false, backgroundWork: false });
		});

		it("an idle subagent with messages queued for it counts; a parked one with none does not", () => {
			const n = native();
			n.state.agents.push(sub({ status: "idle", session: { isStreaming: false, queuedMessageCount: 2 } }));
			assert.deepEqual(n.snapshot().work, { working: false, backgroundWork: true });
			n.state.agents[0] = sub({ status: "parked", session: null });
			assert.deepEqual(n.snapshot().work, { working: false, backgroundWork: false });
		});

		it("async jobs still count as before, and a missing or throwing registry changes nothing", () => {
			const n = native();
			n.state.jobs = 1;
			assert.deepEqual(n.snapshot().work, { working: false, backgroundWork: true });
			n.state.jobs = 0;
			n.state.registryThrows = true;
			assert.deepEqual(n.snapshot().work, { working: false, backgroundWork: false });
			const bare = createOmpHostControlAdapter({ on() {}, getActiveTools: () => [], getAllTools: () => [] });
			bare.observeContext(n.context);
			assert.deepEqual(bare.nativeActivity!("a".repeat(32), true).work, { working: false, backgroundWork: false });
		});
	});

	it("cancels a provisional background completion when abort arrives before SDK idle", () => {
		const n = native();
		n.event("agent_start");
		n.state.jobs = 1;
		n.finish("stop", true);
		assert.deepEqual(n.read(), []);
		n.event("agent_end", { messages: [{ role: "assistant", stopReason: "aborted" }] });
		n.state.jobs = 0;
		assert.deepEqual(n.read(), []);
		assert.deepEqual(n.read(), []);
	});

	it("cannot earn a finish candidate from SDK background-to-idle state alone", () => {
		const n = native();
		n.state.jobs = 1;
		assert.deepEqual(n.read(), []);
		n.state.jobs = 0;
		assert.deepEqual(n.read(), []);
		n.event("agent_start");
		n.event("agent_end", { willContinue: true, messages: [{ role: "assistant", stopReason: "stop" }] });
		assert.deepEqual(n.read(), [], "historical assistant messages cannot establish freshness");
	});

	it("leaves legacy work absent and cannot expose work outside a native TUI context", () => {
		const n = native(false);
		assert.equal("work" in n.snapshot(), false);
		n.adapter.observeContext({ ...n.context, mode: "rpc-ui" });
		const unavailable = n.adapter.nativeActivity!("a".repeat(32), true);
		assert.equal(unavailable.state.available, false);
		assert.equal(unavailable.work, null);
		const unknown = { ...n.context };
		delete unknown.getAsyncJobSnapshot;
		n.adapter.observeContext(unknown);
		assert.equal(n.adapter.nativeActivity!("a".repeat(32), true).work, null);
		assert.equal(n.adapter.nativeState!(false).settled, null);
	});
});

describe("native main-session user waits", () => {
	it("notifies only an ask still pending after the entire poll batch", () => {
		const n = native();
		n.state.idle = false;
		n.event("agent_start");
		n.event("tool_execution_start", ask("rejected"));
		n.event("tool_execution_end", { toolCallId: "rejected", toolName: "ask" });
		assert.deepEqual(n.read(), []);
		n.event("tool_execution_start", ask("waiting"));
		assert.deepEqual(n.read(), [{ kind: "request-pending", requestId: "ask_start:waiting", requestKind: "select", question: "Proceed?" }]);
		assert.deepEqual(n.read(), []);
		assert.deepEqual(n.ledger.pendingRequest, { id: "ask_start:waiting", kind: "select", question: "Proceed?" },
			"notification consumption never answers the pending ask");
		n.event("tool_execution_end", { toolCallId: "waiting", toolName: "ask" });
		n.read();
		assert.equal(n.ledger.pendingRequest, null);
		const captured = JSON.stringify(n.adapter.nativeActivity!("a".repeat(32)));
		for (const secret of ["secret second line", "secret option", "secret payload"]) assert.equal(captured.includes(secret), false);
	});

	it("correlates approval and ask independently even when they share a tool-call id", () => {
		const n = native();
		n.state.idle = false;
		n.event("agent_start");
		n.event("tool_approval_requested", { toolCallId: "same", reason: "credential", args: "secret" });
		n.event("tool_approval_resolved", { toolCallId: "same" });
		n.event("tool_execution_start", ask("same"));
		assert.deepEqual(n.read(), [{ kind: "request-pending", requestId: "ask_start:same", requestKind: "select", question: "Proceed?" }]);
		n.event("tool_approval_requested", { toolCallId: "other", reason: "credential", args: "secret" });
		assert.deepEqual(n.read(), [{ kind: "request-pending", requestId: "approval_start:other", requestKind: "approval", question: "Approve tool execution" }]);
		assert.deepEqual(n.ledger.pendingRequest, { id: "ask_start:same", kind: "select", question: "Proceed?" });
		n.event("tool_execution_end", { toolCallId: "same", toolName: "ask" }); n.read();
		assert.deepEqual(n.ledger.pendingRequest, { id: "approval_start:other", kind: "confirm", question: "Approve tool execution" });
	});

	it("consumes suppressed waits/completions without replay when suppression ends", () => {
		const n = native();
		n.state.idle = false;
		n.event("agent_start");
		n.event("tool_execution_start", ask("wait"));
		assert.deepEqual(n.read("active-visible-focused"), []);
		assert.deepEqual(n.read(), []);
		n.event("tool_execution_end", { toolCallId: "wait", toolName: "ask" });
		n.event("agent_start"); n.finish("stop");
		n.state.idle = true;
		assert.deepEqual(n.read("setting-disabled"), []);
		assert.deepEqual(n.read(), []);
	});

	it("rejects subagents and non-TUI contexts without contaminating the main recorder", () => {
		const n = native();
		for (const ctx of [{ ...n.context, agent: { kind: "task" } }, { ...n.context, mode: "rpc-ui" }]) {
			n.event("agent_start", {}, ctx);
			n.event("message_end", { message: { role: "assistant", stopReason: "stop" } }, ctx);
			n.event("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
			n.event("tool_execution_start", ask("child"), ctx);
		}
		assert.deepEqual(n.read(), []);
		n.event("agent_start"); n.finish("stop");
		assert.deepEqual(n.read(), [{ kind: "turn-complete", outcome: "stop" }]);
	});
});

describe("native wait cancellation", () => {
	it("discards an aborted ask before its first poll and does not block the next completion", () => {
		const n = native();
		n.event("agent_start");
		n.event("tool_execution_start", ask("cancelled"));
		n.finish("aborted");
		assert.deepEqual(n.read(), []);
		n.event("agent_start"); n.finish("error");
		assert.deepEqual(n.read(), [{ kind: "turn-complete", outcome: "error" }]);
	});

	it("ignores dialogs outside a main run and clears a previous run's pending wait", () => {
		const n = native();
		n.event("tool_execution_start", ask("outside"));
		assert.deepEqual(n.read(), []);
		n.event("agent_start");
		n.event("tool_execution_start", ask("pending"));
		assert.equal(n.read()[0]?.kind, "request-pending");
		n.event("agent_start"); n.finish("stop");
		assert.deepEqual(n.read(), [{ kind: "turn-complete", outcome: "stop" }]);
		n.event("tool_approval_requested", { toolCallId: "after-settle" });
		assert.deepEqual(n.read(), []);
	});
});

describe("native replay and attribution", () => {
	it("silently baselines a new epoch/session and never attributes foreign entries to the current row", () => {
		const n = native();
		n.event("agent_start"); n.finish("stop");
		n.newEpoch();
		assert.deepEqual(n.read(), []);
		n.state.id = "session-b";
		n.event("agent_start"); n.finish("error");
		assert.deepEqual(n.read(), []);
		n.state.id = "session-a";
		assert.deepEqual(n.read(), []);
		n.event("agent_start"); n.finish("stop");
		assert.deepEqual(n.read(null, "other-row"), []);
		assert.deepEqual(n.read(), []);
	});

	it("drops a replay gap instead of inventing a completion, then accepts new live work", () => {
		const n = native();
		n.event("agent_start");
		for (let index = 0; index <= CONTROL_NATIVE_ACTIVITY_CAPACITY; index++) n.event("tool_execution_end", { toolName: "ask", toolCallId: `old-${index}` });
		n.event("agent_start"); n.finish("stop");
		assert.deepEqual(n.read(), []);
		n.event("agent_start"); n.finish("error");
		assert.deepEqual(n.read(), [{ kind: "turn-complete", outcome: "error" }]);
	});
});

describe("native pending wait recovery at baseline", () => {
	// A watcher that attaches late (window reload, control reconnect) has a ledger that never saw the ring.
	it("recovers an ask opened before the first observation, notifies once, and clears on the answer", () => {
		const n = native();
		n.state.idle = false;
		n.event("agent_start");
		n.event("tool_execution_start", ask("late"));
		const fresh = new NativeActivityLedger();
		assert.deepEqual(fresh.observe(n.snapshot(), n.state.id, null), [{ kind: "request-pending", requestId: "ask_start:late", requestKind: "select", question: "Proceed?" }]);
		assert.deepEqual(fresh.pendingRequest, { id: "ask_start:late", kind: "select", question: "Proceed?" });
		assert.deepEqual(fresh.observe(n.snapshot(), n.state.id, null), []);
		n.event("tool_execution_end", { toolCallId: "late", toolName: "ask" });
		assert.deepEqual(fresh.observe(n.snapshot(), n.state.id, null), []);
		assert.equal(fresh.pendingRequest, null, "the answered ask returns the row to Working");
		n.state.idle = true; n.finish("stop");
		assert.deepEqual(fresh.observe(n.snapshot(), n.state.id, null), [{ kind: "turn-complete", outcome: "stop" }]);
	});

	it("recovers across a new epoch and consumes a suppressed recovered ask without replay", () => {
		const n = native();
		n.state.idle = false;
		n.event("agent_start");
		n.event("tool_execution_start", ask("kept"));
		n.newEpoch();
		assert.deepEqual(n.read("active-visible-focused"), []);
		assert.deepEqual(n.ledger.pendingRequest, { id: "ask_start:kept", kind: "select", question: "Proceed?" });
		assert.deepEqual(n.read(), []);
	});

	it("recovers a pending tool approval as a confirm request", () => {
		const n = native();
		n.state.idle = false;
		n.event("agent_start");
		n.event("tool_approval_requested", { toolCallId: "tool" });
		const fresh = new NativeActivityLedger();
		assert.deepEqual(fresh.observe(n.snapshot(), n.state.id, null), [{ kind: "request-pending", requestId: "approval_start:tool", requestKind: "approval", question: "Approve tool execution" }]);
		assert.equal(fresh.pendingRequest?.kind, "confirm");
	});

	it("recovers nothing for answered, cancelled, superseded, settled or foreign dialogs", () => {
		const n = native();
		n.state.idle = false;
		n.event("agent_start");
		n.event("tool_execution_start", ask("answered"));
		n.event("tool_execution_end", { toolCallId: "answered", toolName: "ask" });
		assert.deepEqual(new NativeActivityLedger().observe(n.snapshot(), n.state.id, null), []);
		n.event("tool_execution_start", ask("cancelled"));
		n.finish("aborted");
		const afterAbort = new NativeActivityLedger();
		assert.deepEqual(afterAbort.observe(n.snapshot(), n.state.id, null), []);
		assert.equal(afterAbort.pendingRequest, null);
		n.event("agent_start");
		n.event("tool_execution_start", ask("previous-run"));
		n.event("agent_start");
		assert.equal(new NativeActivityLedger().observe(n.snapshot(), n.state.id, null).length, 0, "a new run supersedes a wait that never closed");
		n.event("tool_execution_start", ask("live"));
		const settled = new NativeActivityLedger();
		n.state.idle = true;
		assert.deepEqual(settled.observe(n.snapshot(), n.state.id, null), [], "a settled SDK cannot be waiting on a dialog");
		n.state.idle = false;
		assert.deepEqual(new NativeActivityLedger().observe(n.snapshot(), "other-row", null), []);
		assert.equal(new NativeActivityLedger().observe(n.snapshot(), n.state.id, null)[0]?.kind, "request-pending");
	});

	it("recovers from an older host's journal that publishes no work detail", () => {
		const n = native(false);
		n.state.idle = false;
		n.event("agent_start");
		n.event("tool_execution_start", ask("old-host"));
		const journal = n.snapshot();
		assert.equal("work" in journal, false);
		const fresh = new NativeActivityLedger();
		assert.equal(fresh.observe(journal, n.state.id, null)[0]?.kind, "request-pending");
		assert.equal(fresh.pendingRequest?.id, "ask_start:old-host");
	});
});
