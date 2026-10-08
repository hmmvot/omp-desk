/**
 * Dequeued messages going back into the composer draft: appended after an existing draft, images re-attached under
 * fresh reference numbers, nothing the draft already held changed. Runner: `node --test src/webview/lib/queue-restore.test.ts`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compactForSend } from "./image-references.ts";
import { mergeRestoredQueued, offerQueuedForEditing, subscribeQueuedForEditing, type DraftState, type NumberedImage, type RestoredQueued } from "./queue-restore.ts";

const PNG = "iVBORw0KGgo=";
const image = (number: number): NumberedImage => ({ id: number, name: `draft-${number}`, mimeType: "image/png", bytes: 8, data: `draft-bytes-${number}`, number });
const empty: DraftState = { text: "", images: [], nextNumber: 1, nextId: 1 };

describe("mergeRestoredQueued", () => {
	it("puts a message's text in an empty draft", () => {
		const merged = mergeRestoredQueued(empty, [{ text: "fix the build", images: [] }]);
		assert.equal(merged.text, "fix the build");
		assert.deepEqual(merged.images, []);
	});

	it("appends to a draft instead of overwriting it, separated by a blank line", () => {
		const merged = mergeRestoredQueued({ ...empty, text: "half-typed idea" }, [{ text: "queued one", images: [] }, { text: "queued two", images: [] }]);
		assert.equal(merged.text, "half-typed idea\n\nqueued one\n\nqueued two");
	});

	it("treats a whitespace-only draft as empty", () => {
		assert.equal(mergeRestoredQueued({ ...empty, text: " \n " }, [{ text: "queued", images: [] }]).text, "queued");
	});

	it("keeps the draft when the dequeued message has no text", () => {
		const merged = mergeRestoredQueued({ ...empty, text: "draft" }, [{ text: "", images: [] }]);
		assert.equal(merged.text, "draft");
	});

	it("re-attaches a message's images under fresh numbers beside the draft's own and renumbers its markers", () => {
		const draft: DraftState = { text: "look [Image #1, 2x2] here", images: [image(1)], nextNumber: 2, nextId: 5 };
		const entries: RestoredQueued[] = [{ text: "compare [Image #1, 800x600] with [Image #2]", images: [{ mimeType: "image/png", data: PNG }, { mimeType: "image/jpeg", data: PNG }] }];
		const merged = mergeRestoredQueued(draft, entries);
		assert.equal(merged.text, "look [Image #1, 2x2] here\n\ncompare [Image #2, 800x600] with [Image #3]");
		assert.deepEqual(merged.images.map(item => item.number), [1, 2, 3]);
		assert.equal(merged.images[0], draft.images[0], "the draft's own image is untouched");
		assert.deepEqual(merged.images.slice(1).map(item => [item.mimeType, item.width, item.height, item.id]), [["image/png", 800, 600, 5], ["image/jpeg", undefined, undefined, 6]]);
		assert.equal(merged.nextNumber, 4);
		assert.equal(merged.nextId, 7);
		// Sending compacts to the wire's positional pairing: the draft's image first, then the dequeued ones in order.
		const wire = compactForSend(merged.text, merged.images);
		assert.equal(wire.text, "look [Image #1, 2x2] here\n\ncompare [Image #2, 800x600] with [Image #3]");
		assert.deepEqual(wire.images.map(item => item.data), ["draft-bytes-1", PNG, PNG]);
	});

	it("numbers several messages' images in order without collisions", () => {
		const merged = mergeRestoredQueued(empty, [
			{ text: "a [Image #1]", images: [{ mimeType: "image/png", data: PNG }] },
			{ text: "b [Image #1]", images: [{ mimeType: "image/webp", data: PNG }] },
		]);
		assert.equal(merged.text, "a [Image #1]\n\nb [Image #2]");
		assert.deepEqual(merged.images.map(item => [item.number, item.mimeType]), [[1, "image/png"], [2, "image/webp"]]);
	});

	it("gives an image its text never mentioned a marker at the end, so it is still sent", () => {
		const merged = mergeRestoredQueued(empty, [{ text: "no marker here", images: [{ mimeType: "image/png", data: PNG }] }]);
		assert.equal(merged.text, "no marker here [Image #1]");
		assert.equal(compactForSend(merged.text, merged.images).images.length, 1);
	});

	it("restores an image-only message as its marker", () => {
		const merged = mergeRestoredQueued(empty, [{ text: "", images: [{ mimeType: "image/png", data: PNG }] }]);
		assert.equal(merged.text, "[Image #1]");
	});

	it("leaves a marker with no image behind it as plain text and never reuses its number for a real image", () => {
		const merged = mergeRestoredQueued(empty, [{ text: "see [Image #1] and [Image #2]", images: [{ mimeType: "image/png", data: PNG }] }]);
		assert.equal(merged.text, "see [Image #1] and [Image #2]");
		assert.deepEqual(merged.images.map(item => item.number), [1]);
		const next = mergeRestoredQueued({ ...empty, text: merged.text, images: merged.images, nextNumber: merged.nextNumber, nextId: merged.nextId }, [{ text: "more [Image #1]", images: [{ mimeType: "image/png", data: PNG }] }]);
		assert.ok(!next.images.some(item => item.number === 2), "number 2 stays the text's, not an image's");
	});

	it("reports an image in a format the composer cannot carry and keeps its text", () => {
		const merged = mergeRestoredQueued(empty, [{ text: "x [Image #1]", images: [{ mimeType: "image/bmp", data: PNG }] }]);
		assert.equal(merged.imagesLost, 1);
		assert.deepEqual(merged.images, []);
		assert.equal(merged.text, "x [Image #1]");
	});

	it("computes an attachment's size from its base64", () => {
		const merged = mergeRestoredQueued(empty, [{ text: "[Image #1]", images: [{ mimeType: "image/png", data: "QUJDRA==" }] }]);
		assert.equal(merged.images[0]?.bytes, 4);
	});
});

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
