import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createChatModel, reduceChatFrame, applyChatUiRequest, type ChatEventFrame, type ChatModel } from "../chat/model.ts";
import { turnActivity } from "../webview/lib/activity.ts";
import { desktopNotificationSuppression, reportsTrailingQuestion, TurnActivityLedger, TurnNotifier, type TurnActivity, type NotificationSuppression } from "./notifications.ts";
import { toChatEventFrame } from "./rpc/protocol.ts";
import { assistantMessage } from "./rpc/test-support.ts";

const IDLE: TurnActivity = { streaming: false, backgroundWork: false, settled: true, promptStatus: null, completionOutcome: null, pendingRequest: null, outcome: null, trailingQuestion: false };
const WORKING: TurnActivity = { ...IDLE, streaming: true, settled: false };
const FINISHED: TurnActivity = { ...IDLE, promptStatus: "completed", outcome: "stop" };
const asking = (id: string): TurnActivity => ({ ...WORKING, pendingRequest: { id, kind: "select", question: "Continue?" } });
const completed = [{ kind: "turn-complete", outcome: "stop" }];
const requested = (id: string) => [{ kind: "request-pending", requestId: id, requestKind: "select", question: "Continue?" }];

function conversation() {
	const ledger = new TurnActivityLedger();
	let model: ChatModel = { ...createChatModel(), phase: "live" };
	ledger.baseline("s", turnActivity(model)!);
	return {
		frame(frame: ChatEventFrame, suppression: NotificationSuppression | null = null) {
			model = reduceChatFrame(model, frame);
			return ledger.observe("s", turnActivity(model)!, suppression);
		},
	};
}

const result = (status: "completed" | "aborted" | "error"): Extract<ChatEventFrame, { type: "prompt_result" }> => ({ type: "prompt_result", id: "prompt", status, agentInvoked: true, sessionSettled: true });

describe("causal Chat completion", () => {
	it("holds a fresh async result until public readback proves idle, then notifies once without a wake", () => {
		const c = conversation();
		assert.deepEqual(c.frame({ type: "agent_start" }), []);
		assert.deepEqual(c.frame({ type: "agent_end", isTerminal: false, awaitingAsyncWork: true, outcome: "stop" }), []);
		assert.deepEqual(c.frame(result("completed")), []);
		assert.deepEqual(c.frame({ type: "session_settled" }), []);
		assert.deepEqual(c.frame({ type: "state_update", state: { model: null, thinkingLevel: null, isStreaming: false, isCompacting: false, queuedMessageCount: 0, hasPendingAsyncWork: true, isSettled: false }, todoSeed: null }), []);
		assert.deepEqual(c.frame({ type: "state_update", state: { model: null, thinkingLevel: null, isStreaming: false, isCompacting: false, queuedMessageCount: 0, hasPendingAsyncWork: false, isSettled: true }, todoSeed: null }), completed);
		assert.deepEqual(c.frame({ type: "session_settled" }), []);
	});

	it("notifies final autonomous settle without demanding another prompt_result or agent_end messages", () => {
		const c = conversation();
		c.frame({ type: "agent_start" });
		c.frame({ type: "message_end", messageId: "first", message: assistantMessage("First yield", 1) });
		c.frame(toChatEventFrame({ type: "agent_end", isTerminal: false, messages: [] })!);
		assert.deepEqual(c.frame({ ...result("completed"), sessionSettled: false }), []);
		c.frame({ type: "agent_start" });
		c.frame({ type: "message_end", messageId: "continuation", message: assistantMessage("Final reply", 2) });
		assert.deepEqual(c.frame(toChatEventFrame({ type: "agent_end", isTerminal: true, messages: [] })!), []);
		assert.deepEqual(c.frame({ type: "session_settled" }), completed);
		assert.deepEqual(c.frame({ type: "session_settled" }), []);
	});

	it("vetoes an unstreamed continuation abort even after a late completed prompt ticket", () => {
		const c = conversation();
		c.frame({ type: "agent_start" });
		c.frame({ type: "message_end", messageId: "first", message: assistantMessage("Yield", 1) });
		c.frame({ type: "agent_end", isTerminal: false });
		c.frame({ type: "agent_start" });
		c.frame({ ...result("completed"), sessionSettled: false });
		c.frame(toChatEventFrame({ type: "agent_end", isTerminal: true, messages: [{ role: "assistant", stopReason: "aborted", errorMessage: "private failure payload" }] })!);
		assert.deepEqual(c.frame({ type: "session_settled" }), []);
	});

	it("defers a session_settled until its fresh result and excludes a user abort", () => {
		const c = conversation();
		c.frame({ type: "agent_start" });
		assert.deepEqual(c.frame(result("completed")), [{ kind: "turn-complete", outcome: null }]);
		c.frame({ type: "agent_start" });
		assert.deepEqual(c.frame({ type: "agent_end", isTerminal: true }), []);
		assert.deepEqual(c.frame({ type: "session_settled" }), []);
		assert.deepEqual(c.frame(result("aborted")), []);
		assert.deepEqual(c.frame({ type: "session_settled" }), []);
	});

	it("notifies a turn-stopping error without forwarding its details", () => {
		const c = conversation();
		c.frame({ type: "agent_start" });
		assert.deepEqual(c.frame(result("error")), [{ kind: "turn-complete", outcome: null }]);
	});

	it("never earns a completion from initial idle state or snapshot replay", () => {
		const ledger = new TurnActivityLedger();
		assert.deepEqual(ledger.observe("s", FINISHED, null), []);
		ledger.baseline("s", FINISHED);
		assert.deepEqual(ledger.observe("s", FINISHED, null), []);
		ledger.baseline("s", asking("old"));
		assert.deepEqual(ledger.observe("s", asking("old"), null), []);
	});

	it("consumes watched/disabled settle even if its result arrives after suppression ends", () => {
		for (const deferred of [false, true]) {
			const ledger = new TurnActivityLedger();
			ledger.observe("s", WORKING, null);
			assert.deepEqual(ledger.observe("s", deferred ? { ...FINISHED, promptStatus: null } : FINISHED, "active-visible-focused"), []);
			assert.deepEqual(ledger.observe("s", FINISHED, null), []);
		}
	});

	it("reports the original suppression for a deferred completion once, without private event text", () => {
		const decisions: unknown[][] = [];
		const ledger = new TurnActivityLedger((...decision) => decisions.push(decision));
		ledger.observe("s", WORKING, null);
		ledger.observe("s", { ...FINISHED, promptStatus: null }, "setting-disabled");
		assert.deepEqual(decisions, []);
		ledger.observe("s", FINISHED, "active-visible-focused");
		ledger.observe("s", FINISHED, null);
		ledger.observe("s", asking("question"), "active-visible-focused");
		ledger.observe("s", asking("question"), null);
		assert.deepEqual(decisions, [
			["s", "turn-complete", "setting-disabled"],
			["s", "request-pending", "active-visible-focused"],
		]);
	});

	it("does not call a pending dialog completion, and consumes aborted assistant outcomes", () => {
		const ledger = new TurnActivityLedger();
		ledger.observe("s", WORKING, null);
		const wait = { ...FINISHED, pendingRequest: asking("question").pendingRequest };
		assert.deepEqual(ledger.observe("s", wait, null), requested("question"));
		assert.deepEqual(ledger.observe("s", { ...FINISHED, outcome: "aborted" }, null), []);
	});

	it("keeps concurrent sessions' completion decisions independent", () => {
		const ledger = new TurnActivityLedger();
		ledger.observe("a", WORKING, null);
		ledger.observe("b", WORKING, null);
		assert.deepEqual(ledger.observe("a", FINISHED, null), completed);
		assert.deepEqual(ledger.observe("b", FINISHED, null), completed);
		assert.deepEqual(ledger.observe("a", FINISHED, null), []);
	});

	it("a user abort cancels a held finish before a no-wake drain", () => {
		const c = conversation();
		c.frame({ type: "agent_start" });
		c.frame({ type: "agent_end", isTerminal: false, awaitingAsyncWork: true, outcome: "stop" });
		assert.deepEqual(c.frame({ type: "abort_requested" }), []);
		assert.deepEqual(c.frame({ type: "state_update", state: { model: null, thinkingLevel: null, isStreaming: false, isCompacting: false, queuedMessageCount: 0, hasPendingAsyncWork: false, isSettled: true }, todoSeed: null }), []);
		assert.deepEqual(c.frame(result("completed")), []);
	});

	it("background work vetoes even a reported settle, while structured asks remain immediate", () => {
		const ledger = new TurnActivityLedger();
		ledger.baseline("s", IDLE);
		ledger.observe("s", WORKING, null);
		const waiting = { ...FINISHED, backgroundWork: true, completionOutcome: "stop" as const };
		assert.deepEqual(ledger.observe("s", waiting, null), []);
		assert.deepEqual(ledger.observe("s", { ...waiting, pendingRequest: asking("q").pendingRequest }, null), requested("q"));
		assert.deepEqual(ledger.observe("s", waiting, null), []);
		assert.deepEqual(ledger.observe("s", FINISHED, null), completed);
		assert.deepEqual(ledger.observe("s", FINISHED, null), []);
	});

	it("samples completion suppression at true idle rather than at the earlier async pause", () => {
		for (const pauseSuppression of [null, "active-visible-focused"] as const) {
			const ledger = new TurnActivityLedger();
			ledger.observe("s", WORKING, null);
			ledger.observe("s", { ...FINISHED, settled: false, backgroundWork: true, completionOutcome: "stop" }, pauseSuppression);
			assert.deepEqual(ledger.observe("s", FINISHED, pauseSuppression === null ? "setting-disabled" : null), pauseSuppression === null ? [] : completed);
			assert.deepEqual(ledger.observe("s", FINISHED, null), []);
		}
	});
});

describe("structured user waits", () => {
	it("consumes each request id once even if a previously observed head reappears", () => {
		const ledger = new TurnActivityLedger();
		assert.deepEqual(ledger.observe("s", asking("a"), null), requested("a"));
		assert.deepEqual(ledger.observe("s", asking("a"), null), []);
		assert.deepEqual(ledger.observe("s", asking("b"), null), requested("b"));
		assert.deepEqual(ledger.observe("s", asking("a"), null), []);
	});

	it("does not resurrect a suppressed request when the user looks away", () => {
		const ledger = new TurnActivityLedger();
		assert.deepEqual(ledger.observe("s", asking("a"), "setting-disabled"), []);
		assert.deepEqual(ledger.observe("s", asking("a"), null), []);
	});

	it("projects only display question first-lines, never dialog options, message or prefill", () => {
		for (const request of [
			{ id: "select", method: "select", title: "Choose?\nHidden", options: [{ label: "credential", value: "secret" }] },
			{ id: "confirm", method: "confirm", title: "Confirm?\nHidden", message: "private details" },
			{ id: "input", method: "input", title: "Input?\nHidden", placeholder: "token" },
			{ id: "editor", method: "editor", title: "Edit?\nHidden", prefill: "private file" },
		] as const) {
			const model = applyChatUiRequest({ ...createChatModel(), phase: "live" }, request);
			const notices = new TurnActivityLedger().observe("s", turnActivity(model)!, null);
			assert.deepEqual(notices, [{ kind: "request-pending", requestId: request.id, requestKind: request.method, question: request.title.split("\n")[0] }]);
		}
	});
});

describe("exact active-editor suppression", () => {
	it("suppresses only a focused window's active visible session or a disabled setting", () => {
		for (const focused of [false, true]) for (const visible of [false, true]) for (const active of [false, true]) {
			assert.equal(desktopNotificationSuppression(true, focused, visible, active), focused && visible && active ? "active-visible-focused" : null);
			assert.equal(desktopNotificationSuppression(false, focused, visible, active), "setting-disabled");
		}
	});
});

describe("Sessions trailing-question projection", () => {
	it("refuses the question heuristic for failure/abort, but preserves completed answers", () => {
		const base = { ...FINISHED, trailingQuestion: true };
		assert.equal(reportsTrailingQuestion(base), true);
		assert.equal(reportsTrailingQuestion({ ...base, outcome: "error" }), false);
		assert.equal(reportsTrailingQuestion({ ...base, outcome: "aborted" }), false);
		assert.equal(reportsTrailingQuestion({ ...base, trailingQuestion: false }), false);
	});
});

describe("earned events for the Sessions unread marker", () => {
	function notifier() {
		const earned: string[] = [];
		const sent: string[] = [];
		const subject = new TurnNotifier({
			send: async (_tabId, notice) => { sent.push(notice.kind); },
			onError: () => undefined,
			onSuppressed: () => undefined,
			onEarned: (_tabId, kind) => { earned.push(kind); },
		});
		return { subject, earned, sent };
	}

	it("reports a finished turn and a question whether the desktop notice is sent or suppressed", () => {
		const { subject, earned, sent } = notifier();
		subject.baseline("s", WORKING);
		subject.observe("s", { ...FINISHED }, null);
		subject.baseline("s", WORKING);
		subject.observe("s", { ...FINISHED }, "setting-disabled");
		subject.baseline("s", WORKING);
		subject.observe("s", { ...FINISHED }, "active-visible-focused");
		assert.deepEqual(earned, ["turn-complete", "turn-complete", "turn-complete"]);
		assert.deepEqual(sent, ["turn-complete"]);
		subject.baseline("s", WORKING);
		subject.observe("s", asking("q1"), "setting-disabled");
		assert.deepEqual(earned.slice(3), ["request-pending"]);
	});

	it("does not report an aborted turn", () => {
		const { subject, earned } = notifier();
		subject.baseline("s", WORKING);
		subject.observe("s", { ...FINISHED, promptStatus: "aborted", completionOutcome: "aborted" }, null);
		assert.deepEqual(earned, []);
	});
});
