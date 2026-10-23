/**
 * `fieldRules` (`field-rules.ts`): the pure part of what the editing surface does with markers and chips. The surface keeps the DOM, the
 * selection and the undo history; it asks these rules which stretches are atomic, where a caret rests, what a deletion removes and how a
 * damaged marker is put right. The two lookups are live, as the real ones read the cell and the catalogue now.
 *
 * Runner: `node --test src/webview/lib/draft/field-rules.test.ts`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CommandKind } from "./command-chips.ts";
import { fieldRules } from "./field-rules.ts";

const FIRST = "A [Image #1, 10x6] B [Image #2, 20x8] C [Image #3, 30x9] D";
const IMAGES = new Set([1, 2, 3]);
const rules = fieldRules(
	(kind, number, name) => (kind === "image" ? IMAGES.has(number) : number === 1 && name === "notes.md"),
	name => (name === "compact" ? "command" : name === "skill:review" ? "skill" : null),
);
/** `[start, end)` of the `n`th marker of `FIRST`. */
const marker = (n: number): { start: number; end: number } => {
	const start = FIRST.indexOf(`[Image #${n}`);
	return { start, end: FIRST.indexOf("]", start) + 1 };
};

describe("chips", () => {
	it("finds an attachment's marker in text order, with its kind and number", () => {
		assert.deepEqual(
			rules.chips(FIRST).map(span => ({ ...span })),
			[1, 2, 3].map(n => ({ ...marker(n), kind: "image", number: n })),
		);
	});

	it("draws a marker with no attachment behind it as prose, and a file marker only when its whole label is the document's own", () => {
		assert.deepEqual(rules.chips("a [Image #9, 1x1] b"), []);
		assert.equal(rules.chips("[File #1: notes.md]").length, 1);
		assert.deepEqual(rules.chips("[File #1: other.md]"), [], "a pasted marker of another name is prose");
		assert.deepEqual(rules.chips("[File #1: notes.md.bak]"), []);
		assert.deepEqual(rules.chips("[File #2: notes.md]"), []);
	});

	it("asks for the attachments as they are now: a marker is a chip exactly while its attachment is attached", () => {
		const live = new Set<number>();
		const now = fieldRules((_, number) => live.has(number), () => null);
		assert.deepEqual(now.chips("[Image #1, 1x1]"), []);
		live.add(1);
		assert.equal(now.chips("[Image #1, 1x1]").length, 1);
		live.delete(1);
		assert.deepEqual(now.chips("[Image #1, 1x1]"), []);
	});

	it("draws the command or skill the catalogue lists, and only that: a catalogue that loses it takes the chip away", () => {
		assert.deepEqual(rules.chips("/compact keep files").map(span => ({ ...span })), [{ start: 0, end: 9, kind: "command", number: 0, bare: false }]);
		assert.deepEqual(rules.chips("please /skill:review the file").map(span => ({ ...span })), [{ start: 7, end: 21, kind: "skill", number: 0, bare: false }]);
		assert.deepEqual(rules.chips("/unknown x"), []);
		const catalogue = new Map<string, CommandKind>([["compact", "command"]]);
		const live = fieldRules(() => false, name => catalogue.get(name) ?? null);
		assert.equal(live.chips("/compact x").length, 1);
		catalogue.clear();
		assert.deepEqual(live.chips("/compact x"), []);
	});

	it("finds a marker next to a command chip as two chips in text order", () => {
		const text = "/compact [Image #1, 1x1]";
		assert.deepEqual(rules.chips(text).map(span => span.start), [0, 9]);
	});
});

describe("atomic and bareAt", () => {
	it("is every chip except a bare command chip, which is still being typed and is edited like text", () => {
		assert.equal(rules.atomic("/compact").length, 0, "a command that ends the draft is bare");
		assert.equal(rules.chips("/compact").length, 1, "but it is drawn as a chip at once");
		assert.equal(rules.atomic("/compact x").length, 1);
		assert.equal(rules.atomic("[Image #1, 1x1]").length, 1);
	});

	it("says whether a range is exactly a bare command chip", () => {
		assert.equal(rules.bareAt("/compact", 0, 8), true);
		assert.equal(rules.bareAt("/compact", 0, 7), false);
		assert.equal(rules.bareAt("/compact x", 0, 9), false);
		assert.equal(rules.bareAt("[Image #1, 1x1]", 0, 15), false);
	});
});

describe("snap: where a caret or a selection edge rests", () => {
	it("moves a caret that is inside a marker to the nearest edge after a click, or the edge it was travelling toward", () => {
		const second = marker(2);
		const inside = second.start + 4;
		assert.deepEqual(rules.snap(FIRST, inside, inside, null), { start: second.start, end: second.start });
		assert.deepEqual(rules.snap(FIRST, inside, inside, true), { start: second.end, end: second.end });
		assert.deepEqual(rules.snap(FIRST, inside, inside, false), { start: second.start, end: second.start });
		const nearEnd = Math.round(second.start + (second.end - second.start) * 0.85);
		assert.deepEqual(rules.snap(FIRST, nearEnd, nearEnd, null), { start: second.end, end: second.end }, "a click at 85% of the chip");
	});

	it("lets an arrow cross the whole marker: ArrowLeft from its end lands at its start, ArrowRight from its start at its end", () => {
		const second = marker(2);
		assert.deepEqual(rules.snap(FIRST, second.end - 1, second.end - 1, false), { start: second.start, end: second.start });
		assert.deepEqual(rules.snap(FIRST, second.start + 1, second.start + 1, true), { start: second.end, end: second.end });
	});

	it("leaves a caret on a marker's edge, or outside every chip, where it is", () => {
		const second = marker(2);
		assert.deepEqual(rules.snap(FIRST, second.start, second.start, true), { start: second.start, end: second.start });
		assert.deepEqual(rules.snap(FIRST, second.end, second.end, false), { start: second.end, end: second.end });
		assert.deepEqual(rules.snap(FIRST, 1, 1, null), { start: 1, end: 1 });
	});

	it("grows a selection to cover every marker its edges cut into: Shift+Arrow selects the whole marker, a drag from inside it too", () => {
		const second = marker(2);
		assert.deepEqual(rules.snap(FIRST, second.start, second.end - 1, null), { start: second.start, end: second.end });
		assert.deepEqual(rules.snap(FIRST, second.start + 3, second.end + 2, null), { start: second.start, end: second.end + 2 });
		const first = marker(1);
		assert.deepEqual(rules.snap(FIRST, first.start + 5, second.start + 5, null), { start: first.start, end: second.end });
	});

	it("hops a command chip the same way: ArrowRight from 0 lands at 9, a point inside snaps to 0 or 9", () => {
		const text = "/compact now";
		assert.deepEqual(rules.snap(text, 1, 1, true), { start: 9, end: 9 });
		assert.deepEqual(rules.snap(text, 1, 1, null), { start: 0, end: 0 });
		assert.deepEqual(rules.snap(text, 8, 8, null), { start: 9, end: 9 });
		assert.deepEqual(rules.snap(text, 0, 8, null), { start: 0, end: 9 }, "Shift+Arrow selects the chip whole");
	});

	it("snaps to a bare command chip too: it is drawn as a block at once, though it is edited like text", () => {
		assert.deepEqual(rules.snap("/compact", 3, 3, true), { start: 8, end: 8 });
	});
});

describe("deletion: what removing [from, to) must remove", () => {
	it("makes one Backspace after a marker and one Delete before it remove the marker whole", () => {
		const second = marker(2);
		assert.deepEqual(rules.deletion(FIRST, second.end - 1, second.end), { start: second.start, end: second.end }, "Backspace at the marker's end");
		const first = marker(1);
		assert.deepEqual(rules.deletion(FIRST, first.start, first.start + 1), { start: first.start, end: first.end }, "Delete in front of the first marker");
	});

	it("makes a word-wise delete that ends inside a marker take it whole, never a fragment", () => {
		const third = marker(3);
		assert.deepEqual(rules.deletion(FIRST, third.start - 1, third.end - 4), { start: third.start - 1, end: third.end });
	});

	it("makes a selection that cuts into a marker swallow it", () => {
		const first = marker(1);
		const second = marker(2);
		assert.deepEqual(rules.deletion(FIRST, first.end + 1, second.start + 5), { start: first.end + 1, end: second.end });
	});

	it("leaves a deletion that already removes whole stretches, or touches no chip, to the browser", () => {
		const second = marker(2);
		assert.equal(rules.deletion(FIRST, second.start, second.end), null);
		assert.equal(rules.deletion(FIRST, 0, 1), null);
		assert.equal(rules.deletion("plain text", 2, 6), null);
	});

	it("removes a command chip whole after Backspace right behind it and Delete right before it", () => {
		const text = "/compact now";
		assert.deepEqual(rules.deletion(text, 8, 9), { start: 0, end: 9 });
		assert.deepEqual(rules.deletion(text, 0, 1), { start: 0, end: 9 });
		assert.equal(rules.deletion(text, 0, 11), null, "a selection over the whole chip and a letter leaves nothing cut");
	});

	it("never widens a deletion over a bare command chip", () => {
		assert.equal(rules.deletion("/compact", 7, 8), null);
		assert.equal(rules.deletion("/compact", 0, 1), null);
	});
});

describe("repair: a marker that a native edit damaged", () => {
	const previous = "A [Image #1, 10x6] B";

	it("removes a marker whole when an edit cut into it, and says where the caret is after the edit", () => {
		assert.deepEqual(rules.repair(previous, "A [Image #1, 10x] B"), { text: "A  B", caret: 2 });
	});

	it("keeps what an edit inserted inside a marker, outside it", () => {
		assert.deepEqual(rules.repair(previous, "A [Image #1,X 10x6] B"), { text: "A X B", caret: 3 });
	});

	it("takes a marker removed exactly for a deliberate removal, and an edit that touched none for nothing to repair", () => {
		assert.equal(rules.repair(previous, "A  B"), null);
		assert.equal(rules.repair(previous, "AX [Image #1, 10x6] B"), null);
		assert.equal(rules.repair(previous, previous), null);
		assert.equal(rules.repair("no markers here", "no markers there"), null);
	});

	it("judges an edit against a marker with no attachment as plain text: nothing to repair", () => {
		assert.equal(rules.repair("A [Image #9, 1x1] B", "A [Image #9, 1x] B"), null);
	});

	it("does not repair a bare command chip: a character typed after or deleted from it turns it back into text", () => {
		assert.equal(rules.repair("/compact", "/compac"), null);
		assert.equal(rules.repair("/compact", "/compactx"), null);
	});
});
