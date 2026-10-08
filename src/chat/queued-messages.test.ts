/**
 * The queue readback and the queue-removal messages: bounds that never alter a message's text, the reducer's
 * replacement of the whole list, and the page↔host message grammar. Runner: `node --test src/chat/queued-messages.test.ts`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toChatEventFrame } from "../host/rpc/protocol.ts";
import { ChatSnapshotAssembler, parseChatHostMessage, parseChatWebviewMessage, splitChatSnapshot } from "../webview/chat-messages.ts";
import { MAX_QUEUED_ITEMS, MAX_QUEUED_TEXT_LENGTH, MAX_QUEUED_TOTAL_BYTES, createChatModel, normalizeQueuedMessages, reduceChatFrame, snapshotOf, type ChatLiteState } from "./model.ts";

const EPOCH = { nonce: "n", counter: 1 };
const REQUEST_ID = "0123456789abcdef0123456789abcdef";
const PNG = "iVBORw0KGgo=";
const state: ChatLiteState = { model: null, thinkingLevel: null, isStreaming: false, isCompacting: false, queuedMessageCount: 0 };
const withState = () => reduceChatFrame(createChatModel(), { type: "state_update", state, todoSeed: [] });

describe("normalizeQueuedMessages", () => {
	it("keeps each message's text exactly — whitespace, control characters and all — because OMP matches it verbatim", () => {
		const odd = "a\r\n\t\u0007b  c ";
		assert.deepEqual(normalizeQueuedMessages({ steering: [odd], followUp: [""] }), { steering: [odd], followUp: [""] });
	});

	it("rejects a value that is not a two-queue readback", () => {
		for (const value of [null, [], "x", {}, { steering: [] }, { steering: "a", followUp: [] }]) assert.equal(normalizeQueuedMessages(value), null);
	});

	it("leaves out what cannot be listed in a form that could be acted on, and never clips a message", () => {
		const huge = "x".repeat(MAX_QUEUED_TEXT_LENGTH + 1);
		const many = Array.from({ length: MAX_QUEUED_ITEMS + 5 }, (_, index) => `m${index}`);
		const normalized = normalizeQueuedMessages({ steering: [huge, "ok", 7, null], followUp: many });
		assert.deepEqual(normalized?.steering, ["ok"]);
		assert.equal(normalized?.followUp.length, MAX_QUEUED_ITEMS);
		assert.equal(normalized?.followUp[0], "m0");
	});
});

describe("the queue in the model", () => {
	it("queue_update replaces the list and the count, and an unchanged readback changes nothing", () => {
		const model = reduceChatFrame(withState(), { type: "queue_update", queuedMessageCount: 2, queuedMessages: { steering: ["a"], followUp: ["b"] } });
		assert.deepEqual(model.state?.queuedMessages, { steering: ["a"], followUp: ["b"] });
		assert.equal(model.state?.queuedMessageCount, 2);
		assert.equal(reduceChatFrame(model, { type: "queue_update", queuedMessageCount: 2, queuedMessages: { steering: ["a"], followUp: ["b"] } }), model);
		const reordered = reduceChatFrame(model, { type: "queue_update", queuedMessageCount: 2, queuedMessages: { steering: ["a", "b"], followUp: [] } });
		assert.deepEqual(reordered.state?.queuedMessages, { steering: ["a", "b"], followUp: [] });
	});

	it("the host frame counts what OMP listed, and says how many messages it left out (too large to list)", () => {
		const frame = toChatEventFrame({ type: "queue_update", steering: ["x".repeat(MAX_QUEUED_TEXT_LENGTH + 1)], followUp: ["b"] });
		assert.deepEqual(frame, { type: "queue_update", queuedMessageCount: 2, queuedMessages: { steering: [], followUp: ["b"], unlisted: 1 } });
		assert.equal(toChatEventFrame({ type: "queue_update", steering: "no", followUp: [] }), null);
	});

	it("keeps the whole list inside the byte budget and counts the rest as unlisted", () => {
		const chunk = "y".repeat(MAX_QUEUED_TOTAL_BYTES / 4);
		const normalized = normalizeQueuedMessages({ steering: [chunk, chunk], followUp: [chunk, chunk, chunk] });
		assert.equal((normalized?.steering.length ?? 0) + (normalized?.followUp.length ?? 0), 3);
		assert.equal(normalized?.unlisted, 2);
	});

	it("round-trips through a snapshot and the page parser", () => {
		const model = reduceChatFrame(withState(), { type: "queue_update", queuedMessageCount: 2, queuedMessages: { steering: ["a\nb"], followUp: ["c"] } });
		const parts = splitChatSnapshot(snapshotOf(model, EPOCH), "snap");
		const assembler = new ChatSnapshotAssembler();
		const head = parseChatHostMessage(JSON.parse(JSON.stringify(parts.snapshot)));
		assert.equal(head?.type, "omp:chat-snapshot");
		const payload = head?.type === "omp:chat-snapshot" ? assembler.begin(head) : null;
		assert.deepEqual(payload?.state?.queuedMessages, { steering: ["a\nb"], followUp: ["c"] });
		assert.equal(parseChatHostMessage({ type: "omp:chat-event", epoch: EPOCH, frame: { type: "queue_update", queuedMessageCount: 1, queuedMessages: "nope" } }), null);
	});
});

describe("the queue-removal messages", () => {
	const base = { type: "omp:chat-queue-remove", requestId: REQUEST_ID, epoch: EPOCH, purpose: "edit", items: [{ queue: "steering", text: "a" }, { queue: "followUp", text: "b\n" }] };

	it("accepts a removal naming each message by queue and exact text", () => {
		assert.deepEqual(parseChatWebviewMessage({ ...base, extra: 1 }), base);
		assert.deepEqual(parseChatWebviewMessage({ ...base, purpose: "cancel" })?.type, "omp:chat-queue-remove");
	});

	it("refuses a removal that names nothing, no queue, a wrong purpose, no epoch or too much", () => {
		for (const bad of [
			{ ...base, items: [] },
			{ ...base, items: [{ queue: "other", text: "a" }] },
			{ ...base, items: [{ queue: "steering" }] },
			{ ...base, purpose: "delete" },
			{ ...base, epoch: undefined },
			{ ...base, requestId: "short" },
			{ ...base, items: Array.from({ length: 2 * MAX_QUEUED_ITEMS + 1 }, () => ({ queue: "steering", text: "a" })) },
		]) {
			assert.equal(parseChatWebviewMessage(bad), null, JSON.stringify(bad).slice(0, 80));
		}
	});

	const result = { type: "omp:chat-queue-result", epoch: EPOCH, requestId: REQUEST_ID, purpose: "edit" };

	it("parses a host answer per item, keeping an image the page can carry", () => {
		const image = { type: "image", mimeType: "image/png", data: PNG };
		const parsed = parseChatHostMessage({ ...result, results: [{ status: "removed", images: [image] }, { status: "gone" }] });
		assert.deepEqual(parsed, { ...result, results: [{ status: "removed", images: [image] }, { status: "gone" }] });
	});

	it("never fails a whole answer over an image: the text arrives and the loss is flagged", () => {
		const parsed = parseChatHostMessage({ ...result, results: [{ status: "removed", images: [{ type: "image", mimeType: "image/bmp", data: PNG }] }] });
		assert.deepEqual(parsed?.type === "omp:chat-queue-result" ? parsed.results : null, [{ status: "removed", imagesDropped: true }]);
	});

	it("refuses an answer with an unknown status or no results", () => {
		assert.equal(parseChatHostMessage({ ...result, results: [{ status: "deleted" }] }), null);
		assert.equal(parseChatHostMessage({ ...result, results: [] }), null);
	});

	it("refuses a removal whose texts together exceed what one bridge frame can carry back", () => {
		const text = "x".repeat(MAX_QUEUED_TOTAL_BYTES / 2 + 1);
		assert.equal(parseChatWebviewMessage({ ...base, items: [{ queue: "steering", text }, { queue: "followUp", text }] }), null);
	});
});
