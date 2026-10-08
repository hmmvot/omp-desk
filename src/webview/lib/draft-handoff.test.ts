import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { captureDraft, offerRestoredDraft, provideDraftHandoff, releaseDraftCapture, subscribeRestoredDraft, takeRestoredDraft } from "./draft-handoff.ts";
import type { DraftCapture } from "./draft-handoff.ts";

const first: DraftCapture = { text: "first draft", attachments: 0, recoverable: [] };
const second: DraftCapture = { text: "edited draft", attachments: 2, recoverable: [{ text: "original message", attachments: 1, unconfirmed: true }] };

describe("draft handoff", () => {
	it("does not invent a capture without a mounted composer", () => {
		assert.equal(captureDraft(1), null);
	});

	it("captures the newest provider and releases only its matching transaction", () => {
		const released: number[] = [];
		const removeFirst = provideDraftHandoff({ read: () => first, release: id => released.push(id) });
		assert.deepEqual(captureDraft(2), first);
		const removeSecond = provideDraftHandoff({ read: () => second, release: id => released.push(id) });
		assert.deepEqual(captureDraft(3), second);
		releaseDraftCapture(999);
		assert.deepEqual(released, []);
		releaseDraftCapture(3);
		assert.deepEqual(released, [3]);
		removeSecond();
		assert.deepEqual(released, [3], "unmount cannot release a settled transaction again");
		removeFirst();
		assert.deepEqual(released, [3, 2]);
		assert.equal(captureDraft(4), null);
	});

	it("refuses an incomplete capture rather than supplying an empty draft", () => {
		const release = provideDraftHandoff({ read: () => null, release: () => assert.fail("nothing was captured") });
		assert.equal(captureDraft(5), null);
		release();
	});

	it("retains all original records before mount and consumes the transfer exactly once", () => {
		assert.equal(takeRestoredDraft(), null);
		offerRestoredDraft(10, second);
		offerRestoredDraft(10, second);
		assert.deepEqual(takeRestoredDraft(), second);
		assert.equal(takeRestoredDraft(), null);
		offerRestoredDraft(10, second);
		assert.equal(takeRestoredDraft(), null, "an acknowledgement lost after consumption cannot replay input");
	});

	it("delivers once to a mounted consumer and retains later transfers after unsubscribe", () => {
		const seen: DraftCapture[] = [];
		const stop = subscribeRestoredDraft(content => seen.push(content));
		offerRestoredDraft(11, first);
		offerRestoredDraft(11, first);
		stop();
		offerRestoredDraft(12, second);
		assert.deepEqual(seen, [first]);
		assert.deepEqual(takeRestoredDraft(), second);
	});
});
