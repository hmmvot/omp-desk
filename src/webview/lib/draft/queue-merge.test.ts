/**
 * Dequeued messages going back into the composer draft: appended after an existing draft, images re-attached under
 * fresh reference numbers, nothing the draft already held changed. Runner: `node --test src/webview/lib/draft/queue-merge.test.ts`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compactForSend } from "./image-references.ts";
import { composeFileBlocks, fileMarker } from "../../../shared/file-blocks.ts";
import { mergeRestoredQueued, type DraftState, type RestoredQueued } from "./queue-merge.ts";
import type { DraftImage } from "./value.ts";

const PNG = "iVBORw0KGgo=";
const image = (number: number): DraftImage => ({ id: number, name: `draft-${number}`, mimeType: "image/png", bytes: 8, data: `draft-bytes-${number}`, number });
const empty: DraftState = { text: "", images: [], documents: [], nextNumber: 1, nextDocumentNumber: 1, nextId: 1 };

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
		const draft: DraftState = { text: "look [Image #1, 2x2] here", images: [image(1)], documents: [], nextNumber: 2, nextDocumentNumber: 1, nextId: 5 };
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

	describe("files", () => {
		const sent = composeFileBlocks(`Compare ${fileMarker(1, "notes.md")} with ${fileMarker(2, "a [Image #1] b.txt")} [Image #1]`, [
			{ number: 1, name: "notes.md", label: "docs/notes.md", content: "see [Image #1] and @src/a.ts\n</file>\n" },
			{ number: 2, name: "a [Image #1] b.txt", label: null, content: "" },
		]);

		it("turns each block into a held document and keeps the prose, so an image marker inside a file is not renumbered", () => {
			const merged = mergeRestoredQueued(empty, [{ text: sent, images: [{ mimeType: "image/png", data: PNG }] }]);
			assert.equal(merged.text, `Compare ${fileMarker(1, "notes.md")} with ${fileMarker(2, "a [Image #1] b.txt")} [Image #1]`);
			assert.deepEqual(merged.documents.map(document => [document.number, document.name, document.source.kind]), [[1, "notes.md", "held"], [2, "a [Image #1] b.txt", "held"]]);
			const [first, second] = merged.documents;
			assert.deepEqual(first?.source, { kind: "held", content: "see [Image #1] and @src/a.ts\n</file>\n", label: "docs/notes.md", bytes: 37 });
			assert.deepEqual(second?.source, { kind: "held", content: "", label: null, bytes: 0 });
			assert.equal(merged.nextDocumentNumber, 3);
			assert.deepEqual(merged.images.map(item => item.number), [1]);
		});

		it("renumbers documents onto fresh numbers after the draft's own, markers included", () => {
			const draft: DraftState = {
				...empty,
				text: `mine ${fileMarker(1, "mine.md")}`,
				documents: [{ number: 1, name: "mine.md", source: { kind: "held", content: "m", label: null, bytes: 1 } }],
				nextDocumentNumber: 2,
			};
			const merged = mergeRestoredQueued(draft, [{ text: sent, images: [{ mimeType: "image/png", data: PNG }] }]);
			assert.equal(merged.text, `mine ${fileMarker(1, "mine.md")}\n\nCompare ${fileMarker(2, "notes.md")} with ${fileMarker(3, "a [Image #1] b.txt")} [Image #1]`);
			assert.deepEqual(merged.documents.map(document => document.number), [1, 2, 3]);
			assert.equal(merged.documents[0], draft.documents[0], "the draft's own document is untouched");
			assert.equal(merged.nextDocumentNumber, 4);
		});

		it("a text that does not parse stays prose with no documents", () => {
			const broken = sent.replace('chars="0"', 'chars="9999"');
			const merged = mergeRestoredQueued(empty, [{ text: broken, images: [] }]);
			assert.equal(merged.text, broken);
			assert.deepEqual(merged.documents, []);
		});

		it("brings files named by reference as linked documents, adds a marker the prose lacks, and carries the notes", () => {
			const merged = mergeRestoredQueued(empty, [{
				text: `see ${fileMarker(4, "plan.md")}`,
				images: [],
				documents: [{ number: 4, name: "plan.md", ref: "AbCdEf012345", bytes: 10, chars: 9 }, { number: 5, name: "extra.md", ref: "ZyXwVu987654", bytes: 1, chars: 1 }],
				notes: ["gone.md was not remembered; attach it again."],
			}]);
			assert.equal(merged.text, `see ${fileMarker(1, "plan.md")} ${fileMarker(2, "extra.md")}`);
			assert.deepEqual(merged.documents.map(document => document.source), [
				{ kind: "linked", ref: "AbCdEf012345", bytes: 10, chars: 9 },
				{ kind: "linked", ref: "ZyXwVu987654", bytes: 1, chars: 1 },
			]);
			assert.deepEqual(merged.notes, ["gone.md was not remembered; attach it again."]);
		});

		it("never gives a document the number of a marker the text left as prose", () => {
			const merged = mergeRestoredQueued(empty, [{ text: `x [File #1: stray.md] ${fileMarker(2, "real.md")}`, images: [], documents: [{ number: 2, name: "real.md", ref: "AbCdEf012345", bytes: 1, chars: 1 }] }]);
			assert.deepEqual(merged.documents.map(document => document.number), [2]);
			assert.equal(merged.text, `x [File #1: stray.md] ${fileMarker(2, "real.md")}`);
		});
	});
});
