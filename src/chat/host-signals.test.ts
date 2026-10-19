/** The goal, fast/slow mode, usage-limit, prompt-error and ask-detail parsing shared by host and page, and what the model does with them. Runner: `node --test src/chat/host-signals.test.ts`. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DROPPED_FRAME_NOTICE_SOURCE, EXTENSION_ERROR_NOTICE_SOURCE } from "./events.ts";
import { footerGoal, parseChatGoal, parseFastMode, parsePromptError, parseSlowMode, parseUsageLimit, usageLimitLabel } from "./host-signals.ts";
import { applyChatLiteState, createChatModel, finalizeDroppedStream, normalizeUiRequest, reduceChatFrame, snapshotOf, type ChatLiteState } from "./model.ts";
import { ChatSnapshotAssembler, parseChatEventFrame, parseChatHostMessage, parseChatUiRequest, splitChatSnapshot } from "../protocol/chat-messages.ts";
import type { AssistantMessage } from "./messages.ts";

const EPOCH = { nonce: "n", counter: 1 };
const GOAL = { id: "g1", objective: "Ship the release", status: "active", tokensUsed: 12_345, tokenBudget: 50_000, timeUsedSeconds: 61, createdAt: 1, updatedAt: 2 };
const BASE: ChatLiteState = { model: null, thinkingLevel: null, isStreaming: false, isCompacting: false, queuedMessageCount: 0 };

describe("goal", () => {
	it("keeps the fields the chip shows and bounds the objective", () => {
		assert.deepEqual(parseChatGoal(GOAL), { objective: "Ship the release", status: "active", tokensUsed: 12_345, tokenBudget: 50_000, timeUsedSeconds: 61 });
		assert.equal(parseChatGoal({ ...GOAL, objective: "x".repeat(5_000) })?.objective.length, 2_000);
		assert.equal(parseChatGoal({ ...GOAL, objective: "\u001b[31mred\u001b[0m" })?.objective, "red");
		assert.equal(parseChatGoal({ ...GOAL, status: "mystery" }), null);
		assert.equal(parseChatGoal({ ...GOAL, tokensUsed: "many" }), null);
		assert.equal(parseChatGoal({ ...GOAL, tokenBudget: -1 })?.tokenBudget, undefined);
	});

	it("is shown while goal mode is on or the goal is paused, as the terminal UI's goal segment does", () => {
		assert.equal(footerGoal(GOAL, { enabled: true, mode: "active", goal: GOAL })?.status, "active");
		assert.equal(footerGoal(GOAL, { enabled: false, mode: "active", goal: GOAL }), null, "goal mode off");
		assert.equal(footerGoal(GOAL, undefined), null, "no mode state");
		assert.equal(footerGoal({ ...GOAL, status: "paused" }, { enabled: false })?.status, "paused", "paused stays visible");
		assert.equal(footerGoal({ ...GOAL, status: "dropped" }, { enabled: true }), null, "a dropped goal leaves goal mode");
		assert.equal(footerGoal({ ...GOAL, status: "complete" }, { enabled: true, mode: "exiting" })?.status, "complete");
		assert.equal(footerGoal(null, null), null);
	});

	it("is seeded by a get_state readback and kept current by goal_updated", () => {
		let model = applyChatLiteState(createChatModel(), { ...BASE, goal: parseChatGoal(GOAL)! }, []);
		assert.equal(model.state?.goal?.objective, "Ship the release");
		model = reduceChatFrame(model, { type: "goal_updated", goal: { ...GOAL, status: "budget-limited", tokensUsed: 50_000 }, state: { enabled: true, mode: "active" } });
		assert.equal(model.state?.goal?.status, "budget-limited");
		assert.equal(model.state?.goal?.tokensUsed, 50_000);
		assert.equal(model.ephemeral.at(-1)?.kind, "goal_updated", "the notice row still records the change");
		model = reduceChatFrame(model, { type: "goal_updated", goal: null });
		assert.equal(model.state?.goal, undefined, "a cleared goal removes the chip");
		assert.equal(model.state?.queuedMessageCount, 0, "the rest of the footer state is untouched");
	});

	it("before the first readback only the notice row is kept; the readback then brings the goal", () => {
		let model = reduceChatFrame(createChatModel(), { type: "goal_updated", goal: GOAL, state: { enabled: true } });
		assert.equal(model.state, null);
		assert.equal(model.ephemeral.length, 1);
		model = applyChatLiteState(model, { ...BASE, goal: parseChatGoal(GOAL)! }, []);
		assert.equal(model.state?.goal?.tokensUsed, 12_345);
	});
});

describe("fast mode, slow mode and the usage limit", () => {
	it("reads the get_state fields and ignores an absent one", () => {
		assert.deepEqual(parseFastMode({ fastModeEnabled: true, fastModeActive: false }), { enabled: true, active: false });
		assert.equal(parseFastMode({}), null);
		assert.deepEqual(parseSlowMode({ slowModeSupported: true, slowModeEnabled: true, slowModeScope: "global" }), { supported: true, enabled: true, scope: "global" });
		assert.deepEqual(parseSlowMode({ slowModeSupported: false, slowModeEnabled: true, slowModeScope: "session" }), { supported: false, enabled: false, scope: "session" }, "never on when unsupported");
		assert.equal(parseSlowMode({ slowModeEnabled: true }), null);
		assert.deepEqual(parseUsageLimit({ stage: "low_priority", resetsAtSec: 1_900_000_000, allowanceLeftPercent: 41.6 }), { stage: "low_priority", resetsAtSec: 1_900_000_000, allowanceLeftPercent: 42 });
		assert.deepEqual(parseUsageLimit({ stage: "wrap_up", extraUsage: true }), { stage: "wrap_up", extraUsage: true });
		assert.equal(parseUsageLimit({ stage: "low_priority" }), null, "the reset time is required there");
		assert.equal(parseUsageLimit({ stage: "elsewhere" }), null);
		assert.equal(parseUsageLimit(undefined), null);
	});

	it("words each stage as the terminal UI's status line does", () => {
		const now = Date.parse("2026-10-19T08:00:00Z");
		assert.equal(usageLimitLabel({ stage: "wrap_up", extraUsage: true }, now), "limit reached · wrap-up, then extra usage");
		assert.equal(usageLimitLabel({ stage: "wrap_up", extraUsage: false }, now), "limit reached · wrapping up");
		assert.match(usageLimitLabel({ stage: "wrap_up", extraUsage: false, resetsAtSec: now / 1000 + 3_600 }, now), /^limit reached · wrapping up · resets \S+/);
		assert.match(usageLimitLabel({ stage: "low_priority", resetsAtSec: now / 1000 + 3_600, allowanceLeftPercent: 40 }, now), /^low priority until \S+(?: [AP]M)? · 40% left$/);
		assert.doesNotMatch(usageLimitLabel({ stage: "low_priority", resetsAtSec: now / 1000 + 3_600 }, now), /left/);
	});

	it("crosses the host/page boundary in a snapshot and is refused when malformed", () => {
		const state: ChatLiteState = {
			...BASE,
			goal: parseChatGoal(GOAL)!,
			fastMode: { enabled: true, active: true },
			slowMode: { supported: true, enabled: true, scope: "session" },
			usageLimit: { stage: "low_priority", resetsAtSec: 1_900_000_000, allowanceLeftPercent: 40 },
		};
		const model = applyChatLiteState(createChatModel(), state, []);
		const parts = splitChatSnapshot(snapshotOf(model, EPOCH), "snap");
		const head = parseChatHostMessage(JSON.parse(JSON.stringify(parts.snapshot)));
		assert.equal(head?.type, "omp:chat-snapshot");
		const payload = head?.type === "omp:chat-snapshot" ? new ChatSnapshotAssembler().begin(head) : null;
		assert.deepEqual(payload?.state, state);
		for (const broken of [{ goal: { objective: 1 } }, { fastMode: { enabled: "yes", active: true } }, { slowMode: { supported: true } }, { usageLimit: { stage: "nope" } }]) {
			const bad: unknown = JSON.parse(JSON.stringify({ ...parts.snapshot, head: { ...parts.snapshot.head, state: { ...state, ...broken } } }));
			assert.equal(parseChatHostMessage(bad), null, JSON.stringify(broken));
		}
	});
});

describe("prompt_result.error", () => {
	it("keeps the provider, model, status and retryability, bounded", () => {
		assert.deepEqual(parsePromptError({ message: "overloaded", provider: "anthropic", model: "claude", httpStatus: 529, retryable: true }), { message: "overloaded", provider: "anthropic", model: "claude", httpStatus: 529, retryable: true });
		assert.deepEqual(parsePromptError({ message: "boom" }), { message: "boom", retryable: false });
		assert.equal(parsePromptError({ message: "x".repeat(9_000) })?.message.length, 2_000);
		assert.equal(parsePromptError({ message: "ok", httpStatus: 12 })?.httpStatus, undefined);
		assert.equal(parsePromptError({ provider: "p" }), null);
		assert.equal(parsePromptError("text"), null);
	});

	it("is part of the model's last prompt result and survives the page parser", () => {
		const error = { message: "overloaded", provider: "anthropic", model: "claude", httpStatus: 529, retryable: true };
		const frame = parseChatEventFrame({ type: "prompt_result", id: "vsc:1", status: "error", agentInvoked: true, sessionSettled: true, error });
		assert.deepEqual(frame, { type: "prompt_result", id: "vsc:1", status: "error", agentInvoked: true, sessionSettled: true, error });
		assert.equal(parseChatEventFrame({ type: "prompt_result", status: "error", agentInvoked: true, sessionSettled: true, error: { retryable: true } }), null);
		const model = reduceChatFrame(createChatModel(), frame!);
		assert.deepEqual(model.lastPromptResult?.error, error);
		assert.equal(reduceChatFrame(model, { type: "prompt_result", status: "completed", agentInvoked: true, sessionSettled: true }).lastPromptResult?.error, undefined);
	});
});

describe("ask options", () => {
	const frame = {
		id: "ask-1", method: "ask", timeout: 30_000,
		questions: [{ id: "q1", question: "Which?", multi: false, recommended: 1, options: [{ label: "A", preview: "```ts\nconst a = 1;\n```" }, { label: "B", description: " second ", preview: "   " }, { label: "C" }] }],
	};

	it("carries an option's preview and the dialog's timeout", () => {
		const request = normalizeUiRequest(frame);
		assert.ok(request?.method === "ask");
		assert.deepEqual(request.questions[0]!.options, [{ label: "A", preview: "```ts\nconst a = 1;\n```" }, { label: "B", description: "second" }, { label: "C" }]);
		assert.equal(request.timeoutMs, 30_000);
	});

	it("bounds a preview and drops a timeout that is not a positive duration", () => {
		const big = normalizeUiRequest({ ...frame, questions: [{ ...frame.questions[0]!, options: [{ label: "A", preview: "p".repeat(30_000) }] }] });
		assert.ok(big?.method === "ask");
		assert.equal(big.questions[0]!.options[0]!.preview?.length, 20_000);
		const timeoutOf = (timeout: unknown): number | undefined | "not an ask" => {
			const request = normalizeUiRequest({ ...frame, timeout });
			return request?.method === "ask" ? request.timeoutMs : "not an ask";
		};
		for (const timeout of [0, -5, 1.5, "30", 2 * 24 * 60 * 60 * 1000, undefined]) assert.equal(timeoutOf(timeout), undefined, String(timeout));
	});

	it("crosses to the page with its preview, timeout and expiry, and only valid ones", () => {
		const request = normalizeUiRequest(frame);
		assert.ok(request?.method === "ask");
		const stamped = { ...request, expiresAt: 1_800_000_030_000 };
		assert.deepEqual(parseChatUiRequest(JSON.parse(JSON.stringify(stamped))), stamped);
		assert.equal(parseChatUiRequest({ ...stamped, expiresAt: 5, timeoutMs: undefined }), null, "an expiry without a timeout");
		assert.equal(parseChatUiRequest({ ...stamped, timeoutMs: 0 }), null);
		assert.equal(parseChatUiRequest({ ...stamped, questions: [{ ...stamped.questions[0], options: [{ label: "A", preview: 4 }] }] }), null);
	});
});

describe("notices of extension errors and dropped frames", () => {
	it("say a repeat once in a row, and a different text again", () => {
		const notice = (message: string, source = EXTENSION_ERROR_NOTICE_SOURCE) => ({ type: "notice" as const, level: "error" as const, message, source });
		let model = reduceChatFrame(createChatModel(), notice('Extension "x" error: boom'));
		model = reduceChatFrame(model, notice('Extension "x" error: boom'));
		assert.equal(model.ephemeral.length, 1);
		model = reduceChatFrame(model, notice('Extension "x" error: bang'));
		model = reduceChatFrame(model, notice('Extension "x" error: bang', DROPPED_FRAME_NOTICE_SOURCE));
		assert.equal(model.ephemeral.length, 3);
	});
});

describe("a dropped message_end", () => {
	const streamed: AssistantMessage = { role: "assistant", timestamp: 10, model: "m", provider: "p", stopReason: "stop", content: [{ type: "text", text: "almost the whole reply" }] };

	it("turns the streamed reply into the pending row the lost frame would have made", () => {
		let model = reduceChatFrame(createChatModel(), { type: "message_start", messageId: "m1", message: streamed });
		assert.equal(model.stream, streamed);
		model = finalizeDroppedStream(model, { now: 20 });
		assert.equal(model.stream, null);
		assert.equal(model.streamId, null);
		assert.equal(model.pending.size, 1, "a pending row stands in until the file read replaces it");
	});

	it("does nothing without a streamed reply", () => {
		const model = createChatModel();
		assert.equal(finalizeDroppedStream(model), model);
	});
});
