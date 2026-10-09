import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CHAT_EXIT_STDERR_BYTES, parseChatExitReason } from "./exit-reason.ts";
import { createChatModel, applyChatState, applyChatSnapshot, snapshotOf } from "./model.ts";
import { parseChatHostMessage, splitChatSnapshot } from "../webview/chat-messages.ts";

describe("managed Chat exit reason boundary", () => {
	it("validates byte bounds, codes and plain-text controls", () => {
		assert.deepEqual(parseChatExitReason({ exitCode: 1, stderr: "No default model selected." }), { exitCode: 1, stderr: "No default model selected." });
		assert.ok(parseChatExitReason({ exitCode: null, stderr: "x".repeat(CHAT_EXIT_STDERR_BYTES) }));
		for (const value of [null, { exitCode: 1.5, stderr: "oops" }, { exitCode: 1, stderr: "😀".repeat(CHAT_EXIT_STDERR_BYTES / 4 + 1) }, { exitCode: 1, stderr: "\x1b[31merror" }, { exitCode: 1, stderr: "\0error" }]) assert.equal(parseChatExitReason(value), null);
	});

	it("carries the reason through state, snapshot and page reducers, then clears it on Resume", () => {
		const epoch = { nonce: "owned-host", counter: 1 };
		const exitReason = { exitCode: 1, stderr: "Could not restore model fixture/missing" };
		const state = { type: "omp:chat-state" as const, epoch, phase: "stopped" as const, code: "child-exited", sessionId: null, cwd: null, title: null, readOnlyReason: "stopped", exitReason };
		const parsed = parseChatHostMessage(state);
		assert.ok(parsed?.type === "omp:chat-state");
		const model = applyChatState(createChatModel(), parsed);
		assert.deepEqual(model.exitReason, exitReason);
		const snapshot = snapshotOf(model, epoch);
		const head = parseChatHostMessage(splitChatSnapshot(snapshot, "owned-snapshot").snapshot);
		assert.ok(head?.type === "omp:chat-snapshot");
		assert.deepEqual(head.head.exitReason, exitReason);
		assert.deepEqual(applyChatSnapshot(createChatModel(), snapshot).exitReason, exitReason);
		assert.equal(applyChatState(model, { ...state, phase: "starting", code: null, exitReason: undefined }).exitReason, undefined);
		assert.equal(parseChatHostMessage({ ...state, exitReason: { ...exitReason, stderr: "x".repeat(CHAT_EXIT_STDERR_BYTES + 1) } }), null);
	});
});
