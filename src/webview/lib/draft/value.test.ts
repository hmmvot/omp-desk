/**
 * The Draft value (`value.ts`): the draft of a composer that has just opened, the transitional `withState`, and the one question every
 * rule asks about a marker, `knowsReference`.
 *
 * Runner: `node --test src/webview/lib/draft/value.test.ts`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { emptyDraft, knowsReference, withState, type DraftImage } from "./value.ts";

const image: DraftImage = { id: 1, name: "a.png", mimeType: "image/png", bytes: 10, data: "AAA", number: 2 };
const document = (number: number, name: string) => ({ number, name, source: { kind: "linked" as const, ref: "AbCdEf012345", bytes: 1, chars: 1 } });

describe("emptyDraft", () => {
	it("holds nothing, numbers from 1, and starts at revision 0 with no latch, walk, card or message in flight", () => {
		assert.deepEqual(emptyDraft(), {
			text: "",
			images: [],
			documents: [],
			next: { image: 1, document: 1, key: 1, card: 1 },
			reserved: { bytes: 0, chars: 0 },
			reading: 0,
			lostImages: 0,
			revision: 0,
			unedited: null,
			walk: null,
			recoverable: [],
			inFlight: null,
		});
	});

	it("gives every composer a value of its own: nothing is shared between two", () => {
		const a = emptyDraft();
		const b = emptyDraft();
		assert.notEqual(a.next, b.next);
		assert.notEqual(a.images, b.images);
		assert.notEqual(a.reserved, b.reserved);
	});
});

describe("withState", () => {
	it("replaces the fields of the patch and keeps everything else, the revision included", () => {
		const base = { ...emptyDraft(), revision: 7, text: "kept" };
		const next = withState(base, { reading: 2, lostImages: 1 });
		assert.equal(next.reading, 2);
		assert.equal(next.lostImages, 1);
		assert.equal(next.text, "kept");
		assert.equal(next.revision, 7);
		assert.notEqual(next, base);
		assert.equal(base.reading, 0, "the value it was given is not touched");
	});
});

describe("knowsReference", () => {
	const draft = withState(emptyDraft(), { images: [image], documents: [document(1, "notes.md"), document(2, "a[1].md")] });

	it("knows an image by its number alone", () => {
		assert.equal(knowsReference(draft, "image", 2, ""), true);
		assert.equal(knowsReference(draft, "image", 1, ""), false);
	});

	it("knows a file only by its number and its whole label, which is the name as a marker shows it", () => {
		assert.equal(knowsReference(draft, "file", 1, "notes.md"), true);
		assert.equal(knowsReference(draft, "file", 1, "other.md"), false, "a pasted marker of another name is prose");
		assert.equal(knowsReference(draft, "file", 3, "notes.md"), false);
		assert.equal(knowsReference(draft, "file", 2, "a(1).md"), true, "brackets of a name are shown as parentheses");
		assert.equal(knowsReference(draft, "file", 2, "a[1].md"), false);
	});

	it("does not mix the two numberings: image #1 and file #1 are different attachments", () => {
		const onlyImages = withState(emptyDraft(), { images: [{ ...image, number: 1 }] });
		assert.equal(knowsReference(onlyImages, "file", 1, "a.png"), false);
	});
});
