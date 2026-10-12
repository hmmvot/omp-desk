/**
 * The `/clear` the host holds until OMP is ready, as the page sees it: the reducer frame, the snapshot round trip
 * through the page parser (a reloaded page still shows the wait), and what a page refuses.
 * Runner: `node --test src/chat/clear-pending.test.ts`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toChatEventFrame } from "../protocol/rpc.ts";
import { ChatSnapshotAssembler, parseChatHostMessage, splitChatSnapshot } from "../protocol/chat-messages.ts";
import { createChatModel, reduceChatFrame, snapshotOf } from "./model.ts";

const EPOCH = { nonce: "n", counter: 1 };

describe("a waiting /clear in the model", () => {
	it("clear_pending sets, changes and clears the reason, and an unchanged value changes nothing", () => {
		const waiting = reduceChatFrame(createChatModel(), { type: "clear_pending", pending: "unsettled" });
		assert.equal(waiting.clearPending, "unsettled");
		assert.equal(reduceChatFrame(waiting, { type: "clear_pending", pending: "unsettled" }), waiting);
		assert.equal(reduceChatFrame(waiting, { type: "clear_pending", pending: "queued" }).clearPending, "queued");
		assert.equal(reduceChatFrame(waiting, { type: "clear_pending", pending: null }).clearPending, null);
	});

	it("a child can never produce the frame", () => {
		assert.equal(toChatEventFrame({ type: "clear_pending", pending: "queued" }), null);
	});

	it("round-trips through a snapshot and the page parser, and is absent when nothing waits", () => {
		const model = reduceChatFrame(createChatModel(), { type: "clear_pending", pending: "unconfirmed-send" });
		const head = parseChatHostMessage(JSON.parse(JSON.stringify(splitChatSnapshot(snapshotOf(model, EPOCH), "snap").snapshot)));
		assert.equal(head?.type, "omp:chat-snapshot");
		assert.equal(head?.type === "omp:chat-snapshot" ? new ChatSnapshotAssembler().begin(head)?.clearPending : "x", "unconfirmed-send");

		const none = parseChatHostMessage(JSON.parse(JSON.stringify(splitChatSnapshot(snapshotOf(createChatModel(), EPOCH), "snap").snapshot)));
		assert.equal(none?.type === "omp:chat-snapshot" ? new ChatSnapshotAssembler().begin(none)?.clearPending : "x", undefined);
	});

	it("the page parser takes the live frame and refuses an unknown reason", () => {
		for (const pending of ["unsettled", "queued", "unconfirmed-send", null]) {
			const message = { type: "omp:chat-event", epoch: EPOCH, frame: { type: "clear_pending", pending } };
			assert.deepEqual(parseChatHostMessage(message), message);
		}
		for (const pending of ["busy", "dialog", true, 1, {}]) {
			assert.equal(parseChatHostMessage({ type: "omp:chat-event", epoch: EPOCH, frame: { type: "clear_pending", pending } }), null, JSON.stringify(pending));
		}
		const head = JSON.parse(JSON.stringify(splitChatSnapshot(snapshotOf(createChatModel(), EPOCH), "snap").snapshot));
		assert.equal(parseChatHostMessage({ ...head, head: { ...head.head, clearPending: "busy" } }), null, "a snapshot with an unknown reason is refused");
		assert.equal(parseChatHostMessage({ ...head, head: { ...head.head, clearPending: "queued" } })?.type, "omp:chat-snapshot", "the same message with a known reason is taken");
	});
});
