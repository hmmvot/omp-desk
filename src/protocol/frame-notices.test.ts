/** `extension_error` and `rpc_frame_error` as transcript notices, and `get_state`'s goal, fast/slow mode and usage limit. Runner: `node --test src/protocol/frame-notices.test.ts`. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CLEAR_ERROR_PATH } from "../chat/clear.ts";
import { DROPPED_FRAME_NOTICE_SOURCE, EXTENSION_ERROR_NOTICE_SOURCE } from "../chat/events.ts";
import { NAVIGATE_ERROR_PATH } from "../chat/rewind.ts";
import { droppedFrameAffectsState, droppedFrameNotice, droppedFrameType, extensionErrorNotice } from "./frame-notices.ts";
import { parseStateData, toChatEventFrame } from "./rpc.ts";

describe("extension_error", () => {
	it("becomes an error notice that reads like the terminal UI's line", () => {
		assert.deepEqual(toChatEventFrame({ type: "extension_error", extensionPath: "/home/me/ext/guard.ts", event: "tool_call", error: "boom" }), {
			type: "notice", level: "error", source: EXTENSION_ERROR_NOTICE_SOURCE,
			message: 'Extension "/home/me/ext/guard.ts" error (tool_call): boom',
		});
		assert.equal(extensionErrorNotice({ extensionPath: "command:deploy", error: "no token" })?.message, 'Extension "command:deploy" error: no token');
	});

	it("keeps markup as text, strips control sequences and bounds every field", () => {
		const notice = extensionErrorNotice({ extensionPath: `p${"a".repeat(500)}`, event: "e".repeat(200), error: `\u001b[31m<script>alert(1)</script>\u001b[0m${"x".repeat(3_000)}` });
		assert.ok(notice !== null);
		assert.match(notice.message, /<script>alert\(1\)<\/script>/, "shown as the text it is; the page never renders it as markup");
		assert.doesNotMatch(notice.message, /\u001b/);
		assert.ok(notice.message.length < 1_400, String(notice.message.length));
		assert.ok(notice.message.endsWith("…"));
	});

	it("says so when OMP gave no details, and shows nothing for an empty frame", () => {
		assert.equal(extensionErrorNotice({ extensionPath: "ext.ts" })?.message, 'Extension "ext.ts" error: no details reported');
		assert.equal(extensionErrorNotice({ error: 7 }), null);
		assert.equal(extensionErrorNotice({}), null);
	});

	it("stays out of the transcript for Desk's own rewind and clear commands", () => {
		for (const extensionPath of [NAVIGATE_ERROR_PATH, CLEAR_ERROR_PATH]) {
			assert.equal(toChatEventFrame({ type: "extension_error", extensionPath, event: "command", error: "omp-desk-navigate:busy <b>child text</b>" }), null, extensionPath);
		}
	});
});

describe("rpc_frame_error", () => {
	it("names the dropped frame type in a warning", () => {
		const frame = toChatEventFrame({ type: "rpc_frame_error", originalType: "tool_execution_end", error: "RPC frame exceeded the transport limit" });
		assert.ok(frame?.type === "notice");
		assert.equal(frame.level, "warning");
		assert.equal(frame.source, DROPPED_FRAME_NOTICE_SOURCE);
		assert.match(frame.message, /"tool_execution_end"/);
		assert.match(frame.message, /exceeded the transport limit/);
		assert.match(frame.message, /reads the session file again/);
	});

	it("does not promise a recovery for a frame that needs none, or name one OMP did not name", () => {
		assert.doesNotMatch(droppedFrameNotice({ originalType: "message_update", error: "too big" }).message, /again/);
		assert.match(droppedFrameNotice({ error: "too big" }).message, /^OMP dropped an event/);
		assert.equal(droppedFrameType({ originalType: 12 }), null);
		assert.equal(droppedFrameType({ originalType: "<b>x</b>\u001b[1m" }), "<b>x</b>");
	});

	it("marks the frame types whose loss leaves the transcript behind", () => {
		for (const type of ["agent_end", "message_end", "tool_execution_end", "turn_end"]) assert.equal(droppedFrameAffectsState(type), true, type);
		for (const type of ["message_update", "tool_execution_update", "notice", "constructor", null]) assert.equal(droppedFrameAffectsState(type), false, String(type));
	});
});

describe("get_state signals", () => {
	const base = { isStreaming: false, sessionId: "s1" };
	const goal = { id: "g", objective: "Ship", status: "active", tokensUsed: 1_000, tokenBudget: 4_000, timeUsedSeconds: 5, createdAt: 1, updatedAt: 2 };

	it("reads the goal of an enabled goal mode, fast and slow mode and the usage limit", () => {
		const state = parseStateData({
			...base,
			goal: { enabled: true, mode: "active", goal },
			fastModeEnabled: true, fastModeActive: true,
			slowModeSupported: true, slowModeEnabled: true, slowModeScope: "session",
			usageLimit: { stage: "low_priority", resetsAtSec: 1_900_000_000, allowanceLeftPercent: 30 },
			tokensPerSecond: 41.2,
		});
		assert.deepEqual(state?.lite.goal, { objective: "Ship", status: "active", tokensUsed: 1_000, tokenBudget: 4_000, timeUsedSeconds: 5 });
		assert.deepEqual(state?.lite.fastMode, { enabled: true, active: true });
		assert.deepEqual(state?.lite.slowMode, { supported: true, enabled: true, scope: "session" });
		assert.deepEqual(state?.lite.usageLimit, { stage: "low_priority", resetsAtSec: 1_900_000_000, allowanceLeftPercent: 30 });
		assert.equal("tokensPerSecond" in (state?.lite ?? {}), false, "a single sample is not a live rate; the footer does not show one");
	});

	it("leaves each out when OMP reports none, an older OMP omits it or the goal mode is off", () => {
		const lite = parseStateData({ ...base, goal: null })?.lite;
		assert.deepEqual(Object.keys(lite ?? {}).filter(key => ["goal", "fastMode", "slowMode", "usageLimit"].includes(key)), []);
		assert.equal(parseStateData({ ...base, goal: { enabled: false, mode: "active", goal } })?.lite.goal, undefined);
		assert.equal(parseStateData({ ...base, goal: { enabled: true, goal: { ...goal, status: "dropped" } } })?.lite.goal, undefined);
		assert.equal(parseStateData({ ...base, goal: { enabled: false, goal: { ...goal, status: "paused" } } })?.lite.goal?.status, "paused");
		assert.equal(parseStateData({ ...base, usageLimit: { stage: "unknown" } })?.lite.usageLimit, undefined);
	});
});

describe("prompt_result", () => {
	it("keeps the error details of a failed prompt and nothing of a successful one", () => {
		const error = { message: "Provider overloaded", provider: "anthropic", model: "claude", httpStatus: 529, retryable: true };
		assert.deepEqual(toChatEventFrame({ type: "prompt_result", id: "vsc:9", status: "error", agentInvoked: true, sessionSettled: true, error }), {
			type: "prompt_result", id: "vsc:9", status: "error", agentInvoked: true, sessionSettled: true, error,
		});
		const completed = toChatEventFrame({ type: "prompt_result", status: "completed", agentInvoked: true, sessionSettled: true, error });
		assert.equal(completed !== null && "error" in completed, false);
	});
});
