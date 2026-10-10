/**
 * The model/thinking choices the host holds for OMP: the reducer frame, the snapshot round trip through the page
 * parser, and what a page refuses. Runner: `node --test src/chat/pending-control.test.ts`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toChatEventFrame } from "../host/rpc/protocol.ts";
import { ChatSnapshotAssembler, parseChatHostMessage, splitChatSnapshot } from "../webview/chat-messages.ts";
import { createChatModel, reduceChatFrame, snapshotOf, type ChatPendingControl } from "./model.ts";

const EPOCH = { nonce: "n", counter: 1 };
const HELD: ChatPendingControl = { model: { provider: "p", id: "m", name: "M" }, thinking: "high", thinkingCycles: 2 };

describe("held model and thinking choices in the model", () => {
	it("control_pending sets and clears them, and an unchanged value changes nothing", () => {
		const held = reduceChatFrame(createChatModel(), { type: "control_pending", pending: HELD });
		assert.deepEqual(held.pendingControl, HELD);
		assert.equal(reduceChatFrame(held, { type: "control_pending", pending: { ...HELD } }), held);
		assert.equal(reduceChatFrame(held, { type: "control_pending", pending: null }).pendingControl, null);
	});

	it("a child can never produce the frame", () => {
		assert.equal(toChatEventFrame({ type: "control_pending", pending: HELD }), null);
	});

	it("round-trips through a snapshot and the page parser, and is absent when nothing is held", () => {
		const model = reduceChatFrame(createChatModel(), { type: "control_pending", pending: HELD });
		const parts = splitChatSnapshot(snapshotOf(model, EPOCH), "snap");
		const head = parseChatHostMessage(JSON.parse(JSON.stringify(parts.snapshot)));
		assert.equal(head?.type, "omp:chat-snapshot");
		const payload = head?.type === "omp:chat-snapshot" ? new ChatSnapshotAssembler().begin(head) : null;
		assert.deepEqual(payload?.pendingControl, HELD);

		const none = splitChatSnapshot(snapshotOf(createChatModel(), EPOCH), "snap");
		const bare = parseChatHostMessage(JSON.parse(JSON.stringify(none.snapshot)));
		assert.equal(bare?.type === "omp:chat-snapshot" ? new ChatSnapshotAssembler().begin(bare)?.pendingControl : "x", undefined);
	});

	it("the page parser takes the live frame and refuses a malformed one", () => {
		assert.deepEqual(parseChatHostMessage({ type: "omp:chat-event", epoch: EPOCH, frame: { type: "control_pending", pending: HELD } }),
			{ type: "omp:chat-event", epoch: EPOCH, frame: { type: "control_pending", pending: HELD } });
		assert.deepEqual(parseChatHostMessage({ type: "omp:chat-event", epoch: EPOCH, frame: { type: "control_pending", pending: null } }),
			{ type: "omp:chat-event", epoch: EPOCH, frame: { type: "control_pending", pending: null } });
		for (const pending of ["x", { model: { provider: "", id: "m" } }, { thinking: "" }, { modelCycles: -1 }, { thinkingCycles: 999 }, { model: "p/m" }]) {
			assert.equal(parseChatHostMessage({ type: "omp:chat-event", epoch: EPOCH, frame: { type: "control_pending", pending } }), null, JSON.stringify(pending));
		}
	});
});
