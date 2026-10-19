/** Live job frames in the chat model and across host to page. Runner: `node --test src/chat/job-frames.test.ts`. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ChatSnapshotAssembler, parseChatHostMessage, splitChatSnapshot } from "../protocol/chat-messages.ts";
import { applyChatSnapshot, createChatModel, reduceChatFrame, snapshotOf, type ChatModel } from "./model.ts";

const EPOCH = { nonce: "job-frames", counter: 1 };
const asyncOf = (state: string, jobId = "bg_1", type = "bash") => ({ details: { async: { state, jobId, type } } });

const update = (model: ChatModel, toolCallId: string, partialResult: unknown, now: number): ChatModel =>
	reduceChatFrame(model, { type: "tool_execution_update", toolCallId, toolName: "bash", args: { command: "x" }, partialResult }, { now });
const end = (model: ChatModel, toolCallId: string, result: unknown, now: number): ChatModel =>
	reduceChatFrame(model, { type: "tool_execution_end", toolCallId, toolName: "bash", result }, { now });

describe("job frames in the model", () => {
	it("records a tool_execution_update that carries details.async", () => {
		const model = update(createChatModel(), "c1", asyncOf("running"), 100);
		assert.deepEqual([...model.jobFrames], [["bg_1", { state: "running", type: "bash", callId: "c1", at: 100 }]]);
	});

	it("records the result that starts a job, so the page knows this process owns it", () => {
		const model = end(createChatModel(), "c1", asyncOf("running", "bg_2", "task"), 200);
		assert.deepEqual(model.jobFrames.get("bg_2"), { state: "running", type: "task", callId: "c1", at: 200 });
	});

	it("ignores ordinary tool progress and results", () => {
		let model = update(createChatModel(), "c1", { content: [{ type: "text", text: "out" }] }, 1);
		model = end(model, "c1", { details: {} }, 2);
		assert.equal(model.jobFrames.size, 0);
	});

	it("keeps the same Map while a running job reports again, and a new one when its state changes", () => {
		const first = update(createChatModel(), "c1", asyncOf("running"), 1);
		const again = update(first, "c1", asyncOf("running"), 50);
		assert.equal(again.jobFrames, first.jobFrames);
		const done = update(again, "c1", asyncOf("completed"), 60);
		assert.notEqual(done.jobFrames, first.jobFrames);
		assert.equal(done.jobFrames.get("bg_1")?.state, "completed");
		assert.equal(update(done, "c1", asyncOf("running"), 70).jobFrames.get("bg_1")?.state, "completed", "its own call never reopens it");
	});

	it("round-trips through a snapshot", () => {
		let model = update(createChatModel(), "c1", asyncOf("running"), 10);
		model = end(model, "c2", asyncOf("failed", "bg_2", "eval"), 20);
		const payload = snapshotOf(model, EPOCH);
		assert.deepEqual(payload.jobFrames, [{ id: "bg_1", state: "running", type: "bash", callId: "c1", at: 10 }, { id: "bg_2", state: "failed", type: "eval", callId: "c2", at: 20 }]);
		assert.deepEqual([...applyChatSnapshot(createChatModel(), payload).jobFrames], [...model.jobFrames]);
		assert.equal(applyChatSnapshot(createChatModel(), snapshotOf(createChatModel(), EPOCH)).jobFrames.size, 0);
	});
});

describe("job frames across the host link", () => {
	const parts = splitChatSnapshot(snapshotOf(update(createChatModel(), "c1", asyncOf("running"), 10), EPOCH), "s1");
	const withFrames = (jobFrames: unknown) => ({ ...parts.snapshot, head: { ...parts.snapshot.head, jobFrames } });

	it("accepts a valid snapshot and keeps its frames", () => {
		const head = parseChatHostMessage(parts.snapshot);
		assert.ok(head !== null && head.type === "omp:chat-snapshot");
		const assembled = new ChatSnapshotAssembler().begin(head.type === "omp:chat-snapshot" ? head : parts.snapshot);
		assert.deepEqual(assembled?.jobFrames, [{ id: "bg_1", state: "running", type: "bash", callId: "c1", at: 10 }]);
	});

	it("accepts a snapshot that carries no frames", () => {
		const { jobFrames: _omitted, ...rest } = parts.snapshot.head;
		assert.notEqual(parseChatHostMessage({ ...parts.snapshot, head: rest }), null);
	});

	it("refuses the snapshot when a frame is malformed", () => {
		const row = { id: "bg_1", state: "running", type: "bash", callId: "c1", at: 10 };
		for (const bad of ["x", {}, [{ ...row, state: "paused" }], [{ ...row, id: "" }], [{ ...row, at: -1 }], [{ ...row, callId: 5 }], [row, null]]) {
			assert.equal(parseChatHostMessage(withFrames(bad)), null, JSON.stringify(bad));
		}
	});
});
