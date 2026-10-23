import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { composeFileBlocks, fileMarker } from "../../../shared/file-blocks.ts";
import {
	activeDocuments,
	documentChars,
	draftFromSentText,
	isKnownDocument,
	pruneInactiveDocuments,
	type DraftDocument,
} from "./draft-documents.ts";

function held(number: number, name: string, content: string, label: string | null = null): DraftDocument {
	return { number, name, source: { kind: "held", content, label, bytes: content.length } };
}

function linked(number: number, name: string, chars = 10): DraftDocument {
	return { number, name, source: { kind: "linked", ref: "AbCdEf012345", bytes: chars, chars } };
}

describe("activeDocuments", () => {
	it("returns the documents whose marker the text still holds, in number order, and none for a stray marker", () => {
		const documents = [held(2, "b.md", "b"), held(1, "a.md", "a"), held(3, "c.md", "c")];
		const text = `${fileMarker(2, "b.md")} then ${fileMarker(1, "a.md")} and [File #3: other.md]`;
		assert.deepEqual(activeDocuments(text, documents).map(document => document.number), [1, 2]);
		assert.deepEqual(activeDocuments("no markers", documents), []);
		assert.deepEqual(activeDocuments(text, []), []);
	});

	it("knows a marker only when its whole label is the document's own", () => {
		const documents = [held(1, "a.md", "")];
		assert.equal(isKnownDocument(documents, 1, "a.md"), true);
		assert.equal(isKnownDocument(documents, 1, "a.md extra"), false);
		assert.equal(isKnownDocument(documents, 2, "a.md"), false);
	});
});

describe("documentChars", () => {
	it("counts the held text and trusts the host's count for a linked file", () => {
		assert.equal(documentChars(held(1, "a", "héllo")), 5);
		assert.equal(documentChars(linked(1, "a", 42)), 42);
	});
});

describe("pruneInactiveDocuments", () => {
	const active = (...numbers: number[]) => (number: number) => numbers.includes(number);

	it("keeps everything while the text a deleted marker keeps fits the budget", () => {
		const documents = [held(1, "a", "x".repeat(10)), held(2, "b", "y".repeat(10))];
		assert.deepEqual(pruneInactiveDocuments(documents, active(), new Set(), 20), documents);
	});

	it("releases the oldest deleted held documents until the rest fit, never an active, protected or linked one", () => {
		const documents = [held(1, "a", "x".repeat(10)), held(2, "b", "y".repeat(10)), held(3, "c", "z".repeat(10)), held(4, "d", "w".repeat(10)), linked(5, "e", 500)];
		const kept = pruneInactiveDocuments(documents, active(1), new Set([2]), 20);
		assert.deepEqual(kept.map(document => document.number), [1, 2, 4, 5], "3 is the oldest inactive unprotected one; 4 fits afterwards");
		const tight = pruneInactiveDocuments(documents, active(1), new Set([2]), 10);
		assert.deepEqual(tight.map(document => document.number), [1, 2, 5]);
	});
});

describe("draftFromSentText", () => {
	it("reads a sent message back as prose and held documents carrying the text that was sent and the path text", () => {
		const sources = [
			{ number: 1, name: "a.md", label: "docs/a.md", content: "see @x.ts\n" },
			{ number: 2, name: "b é.txt", label: null, content: "" },
		];
		const text = composeFileBlocks(`Look ${fileMarker(1, "a.md")} ${fileMarker(2, "b é.txt")}`, sources);
		const draft = draftFromSentText(text);
		assert.equal(draft.text, `Look ${fileMarker(1, "a.md")} ${fileMarker(2, "b é.txt")}`);
		assert.deepEqual(draft.documents, [
			{ number: 1, name: "a.md", source: { kind: "held", content: "see @x.ts\n", label: "docs/a.md", bytes: 10 } },
			{ number: 2, name: "b é.txt", source: { kind: "held", content: "", label: null, bytes: 0 } },
		]);
	});

	it("measures bytes in UTF-8, and returns a plain or unparsable text whole with no documents", () => {
		const text = composeFileBlocks(`x ${fileMarker(1, "a")}`, [{ number: 1, name: "a", label: null, content: "é€😀" }]);
		const source = draftFromSentText(text).documents[0]!.source;
		assert.equal(source.bytes, 2 + 3 + 4);
		assert.deepEqual(draftFromSentText("just words"), { text: "just words", documents: [] });
	});
});
