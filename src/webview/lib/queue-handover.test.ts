import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RestoredQueued } from "./draft/draft.ts";
import { offerQueuedForEditing, subscribeQueuedForEditing } from "./queue-handover.ts";

describe("the hand-over registry", () => {
	it("delivers to the mounted composer at once and to a later composer in order", () => {
		const first: RestoredQueued[][] = [];
		const release = subscribeQueuedForEditing(entries => first.push([...entries]));
		offerQueuedForEditing([{ text: "now", images: [] }]);
		assert.deepEqual(first, [[{ text: "now", images: [] }]]);
		release();
		offerQueuedForEditing([{ text: "held one", images: [] }]);
		offerQueuedForEditing([{ text: "held two", images: [] }]);
		const later: string[] = [];
		const releaseLater = subscribeQueuedForEditing(entries => later.push(...entries.map(entry => entry.text)));
		assert.deepEqual(later, ["held one", "held two"]);
		offerQueuedForEditing([]);
		assert.deepEqual(later, ["held one", "held two"], "an empty hand-over is not delivered");
		releaseLater();
	});
});
