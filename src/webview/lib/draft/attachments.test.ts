/**
 * Tests for the pure parts of the composer's attachment reads that bound a drop and a draft.
 *
 * The regression defended is the silent one: a drop over the structural guard used to be cut at the limit and the rest
 * lost without a word. It is refused whole, with a sentence, and a drop at the guard is read in full.
 *
 * Runner: `node --test src/webview/lib/attachments.test.ts`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_ATTACH_ITEMS } from "../../../shared/attach-limits.ts";
import { attachGuardRefusal, droppedFileUris } from "./attachments.ts";

/** The two methods `droppedFileUris` calls on a drag; the rest of `DataTransfer` is not read. */
function drop(codeUriList: string, uriList = ""): DataTransfer {
	const data = { getData: (type: string) => (type === "application/vnd.code.uri-list" ? codeUriList : type === "text/uri-list" ? uriList : "") };
	return data as unknown as DataTransfer;
}

const lines = (count: number) => Array.from({ length: count }, (_, index) => `file:///c%3A/repo/shot-${index}.png`);

describe("droppedFileUris", () => {
	it("reads every file URI of a drop in drag order and skips comments and other schemes", () => {
		const text = ["# a comment", "file:///c%3A/a.md", "https://example.com/x", "FILE:///c%3A/b.md", ""].join("\r\n");
		assert.deepEqual(droppedFileUris(drop(text), MAX_ATTACH_ITEMS), { uris: ["file:///c%3A/a.md", "FILE:///c%3A/b.md"], refusal: null });
		assert.deepEqual(droppedFileUris(drop("", "file:///c%3A/c.md"), MAX_ATTACH_ITEMS).uris, ["file:///c%3A/c.md"], "the plain uri-list is the fallback");
		assert.deepEqual(droppedFileUris(null, MAX_ATTACH_ITEMS), { uris: [], refusal: null });
	});

	it("reads a drop of exactly the guard in full and refuses one URI more as a whole", () => {
		const full = lines(MAX_ATTACH_ITEMS);
		assert.deepEqual(droppedFileUris(drop(full.join("\n")), MAX_ATTACH_ITEMS), { uris: full, refusal: null });
		const over = droppedFileUris(drop(lines(MAX_ATTACH_ITEMS + 1).join("\n")), MAX_ATTACH_ITEMS);
		assert.deepEqual(over.uris, [], "nothing of a refused drop is attached: not the first thousand either");
		assert.equal(over.refusal, "At most 1000 files can be attached at once.");
	});
});

describe("attachGuardRefusal", () => {
	it("lets a draft grow to the guard across drops, picks and pastes and refuses the attach that would pass it", () => {
		assert.equal(attachGuardRefusal(0, MAX_ATTACH_ITEMS), null);
		assert.equal(attachGuardRefusal(MAX_ATTACH_ITEMS - 1, 1), null);
		assert.equal(attachGuardRefusal(MAX_ATTACH_ITEMS, 0), null);
		assert.equal(attachGuardRefusal(MAX_ATTACH_ITEMS, 1), "At most 1000 files can be attached at once.");
		assert.equal(attachGuardRefusal(600, 401), "At most 1000 files can be attached at once.");
	});
});
