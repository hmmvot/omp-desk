import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createChatModel, type ChatModel } from "../../chat/model.ts";
import { NAVIGATE_REFUSAL_SENTENCES, type RewindTarget } from "../../chat/rewind.ts";
import { REWIND_IDLE, reduceRewind, rewindBlockedReason, type RewindMode } from "./rewind-mode.ts";

const target = (id: string): RewindTarget => ({ id, parentId: null, preview: id, images: 0, timestamp: "" });
const targets = ["u1", "u2", "u3"].map(target);

describe("rewind picking state", () => {
	it("starts on the newest prompt or the one asked for, and ignores a start with nothing to target", () => {
		assert.deepEqual(reduceRewind(REWIND_IDLE, { type: "start", targets, leafId: "a3" }), { kind: "picking", targetId: "u3", leafId: "a3" });
		assert.deepEqual(reduceRewind(REWIND_IDLE, { type: "start", targets, leafId: "a3", targetId: "u1" }), { kind: "picking", targetId: "u1", leafId: "a3" });
		assert.deepEqual(reduceRewind(REWIND_IDLE, { type: "start", targets, leafId: "a3", targetId: "gone" }), { kind: "picking", targetId: "u3", leafId: "a3" });
		assert.equal(reduceRewind(REWIND_IDLE, { type: "start", targets: [], leafId: "a3" }), REWIND_IDLE);
	});

	const picked = (mode: RewindMode): string | null => mode.kind === "picking" ? mode.targetId : null;

	it("moves with the keys, clamped at both ends, and selects by click", () => {
		let mode: RewindMode = { kind: "picking", targetId: "u3", leafId: "a3" };
		mode = reduceRewind(mode, { type: "move", targets, to: "previous" });
		assert.equal(picked(mode), "u2");
		mode = reduceRewind(mode, { type: "move", targets, to: "first" });
		assert.equal(reduceRewind(mode, { type: "move", targets, to: "previous" }), mode, "already first");
		mode = reduceRewind(mode, { type: "move", targets, to: "last" });
		assert.equal(picked(mode), "u3");
		assert.equal(reduceRewind(mode, { type: "move", targets, to: "next" }), mode, "already last");
		assert.equal(picked(reduceRewind(mode, { type: "select", targets, targetId: "u1" })), "u1");
		assert.equal(reduceRewind(mode, { type: "select", targets, targetId: "unknown" }), mode);
	});

	it("is pinned to the leaf it started from: a moved leaf or a vanished prompt ends picking", () => {
		const mode: RewindMode = { kind: "picking", targetId: "u2", leafId: "a3" };
		assert.equal(reduceRewind(mode, { type: "snapshot", targets, leafId: "a3" }), mode);
		assert.equal(reduceRewind(mode, { type: "snapshot", targets, leafId: "a4" }), REWIND_IDLE);
		assert.equal(reduceRewind(mode, { type: "snapshot", targets: [target("u1")], leafId: "a3" }), REWIND_IDLE);
	});

	it("allows one navigation at a time: pending ignores starts, cancels and submits until it settles", () => {
		const pending = reduceRewind({ kind: "picking", targetId: "u2", leafId: "a3" }, { type: "submit", action: "rewind", targetId: "u2", leafId: "a3", summarize: true });
		assert.deepEqual(pending, { kind: "pending", action: "rewind", targetId: "u2", leafId: "a3", summarize: true });
		for (const action of [{ type: "start", targets, leafId: "a3" }, { type: "cancel" }, { type: "submit", action: "undo", targetId: "x", leafId: "a3", summarize: false }, { type: "snapshot", targets, leafId: "other" }] as const) {
			assert.equal(reduceRewind(pending, action), pending);
		}
		assert.equal(reduceRewind(pending, { type: "settled" }), REWIND_IDLE);
		assert.deepEqual(reduceRewind(REWIND_IDLE, { type: "submit", action: "undo", targetId: "tip", leafId: "m", summarize: false }).kind, "pending", "Undo and switches start from idle");
	});
});

describe("rewind availability on the page", () => {
	const live = (patch: Partial<ChatModel> = {}): ChatModel => ({
		...createChatModel(),
		phase: "live",
		readOnlyReason: null,
		commands: [{ name: "omp-desk-navigate", source: "extension" }],
		...patch,
	});

	it("explains each reason the host would refuse, in the host's sentences", () => {
		assert.equal(rewindBlockedReason(live()), null);
		assert.equal(rewindBlockedReason(live({ phase: "view-only" })), NAVIGATE_REFUSAL_SENTENCES["not-live"]);
		assert.equal(rewindBlockedReason(live({ readOnlyReason: "Another window controls this session." })), "Another window controls this session.");
		assert.equal(rewindBlockedReason(live({ working: true })), NAVIGATE_REFUSAL_SENTENCES.busy);
		assert.equal(rewindBlockedReason(live({ settled: false })), NAVIGATE_REFUSAL_SENTENCES.busy);
		assert.equal(rewindBlockedReason(live({ asyncPaused: true })), NAVIGATE_REFUSAL_SENTENCES.busy);
		assert.equal(rewindBlockedReason(live({ maintenance: { action: "compact", status: "working" } })), NAVIGATE_REFUSAL_SENTENCES.compacting);
		assert.equal(rewindBlockedReason(live({ commands: [] })), NAVIGATE_REFUSAL_SENTENCES.unsupported);
		assert.equal(rewindBlockedReason(live({ commands: [{ name: "omp-desk-navigate", source: "prompt" }] })), NAVIGATE_REFUSAL_SENTENCES.unsupported, "a same-named template is not the command");
	});
});
