/**
 * The cell (`cell.ts`): the value, the revision, the writes it makes through a `FieldPort`, and when it makes them. The field is a
 * recording stub that simulates the surface's rules: a composition window refuses edits and queues a text, a frozen field refuses
 * both, and an applied edit is echoed back to `edited`.
 *
 * The timing matrix is the table of *Current State* in docs/designs/2026-10-23-composer-draft-module.md: each writer says what happens
 * while a composition window is open (wait, skip, now) and while the hand-off holds the draft (wait, drop).
 *
 * Runner: `node --test src/webview/lib/draft/cell.test.ts`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDraftCell, type DraftCell } from "./cell.ts";
import { stubPort, type StubPort } from "./draft-test-stub.ts";
import type { Op, Outcome, Timing, Write } from "./field.ts";
import { withState, type Draft } from "./value.ts";

/** A cell over a stub field that already holds `text` (the field and the value agree, as after a first write). */
function open(text = ""): { cell: DraftCell; port: StubPort } {
	const port = stubPort();
	const cell = createDraftCell(port);
	port.bind(cell);
	if (text !== "") {
		assert.equal(cell.commit({ draft: withState(cell.read(), { text }), writes: [{ kind: "text", text, history: "reset", focus: false }] }), true);
		port.calls.length = 0;
	}
	return { cell, port };
}

const setText = (text: string, draft: Draft): { draft: Draft; writes: Write[] } => ({ draft: withState(draft, { text }), writes: [{ kind: "text", text, history: "record", focus: false }] });
/** An operation that appends `word` to the text with one `edit` write at the end of the text. */
const append = (word: string): Op<string> => (draft, at) => ({
	change: { draft: withState(draft, { text: draft.text + word }), writes: [{ kind: "edit", edit: { from: draft.text.length, to: draft.text.length, insert: word }, as: "replace", focus: false }] },
	result: `ran at ${at.selection.focus}`,
});

describe("the revision rule", () => {
	it("starts at 0 with an empty draft and a caret at 0", () => {
		const { cell } = open();
		assert.equal(cell.read().revision, 0);
		assert.deepEqual(cell.getState(), { draft: cell.read(), caret: 0, held: false });
	});

	it("goes up once for a change that writes a text, an edit or a removal", () => {
		const { cell } = open();
		cell.commit(setText("abc", cell.read()));
		assert.equal(cell.read().revision, 1);
		cell.commit({ draft: withState(cell.read(), { text: "abcd" }), writes: [{ kind: "edit", edit: { from: 3, to: 3, insert: "d" }, as: "replace", focus: false }] });
		assert.equal(cell.read().revision, 2);
		cell.commit({ draft: withState(cell.read(), { text: "bcd" }), writes: [{ kind: "remove", ranges: [{ from: 0, to: 1 }], focus: false }] });
		assert.equal(cell.read().revision, 3);
	});

	it("goes up once for a change that differs in its image list or its document list, with no write at all", () => {
		const { cell } = open();
		const image = { id: 1, name: "a.png", mimeType: "image/png" as const, bytes: 3, data: "AAA", number: 1 };
		cell.commit({ draft: withState(cell.read(), { images: [image] }), writes: [] });
		assert.equal(cell.read().revision, 1);
		cell.commit({ draft: withState(cell.read(), { documents: [{ number: 1, name: "a.md", source: { kind: "held", content: "x", label: null, bytes: 1 } }] }), writes: [] });
		assert.equal(cell.read().revision, 2);
	});

	it("does not move for reads in flight, reservations, the message in flight, cards, the walk, lost images, the counters or a caret write", () => {
		const { cell } = open("hello");
		const before = cell.read().revision;
		const draft = cell.read();
		cell.commit({ draft: withState(draft, { reading: 2 }), writes: [] });
		cell.commit({ draft: withState(cell.read(), { reserved: { bytes: 5, chars: 7 } }), writes: [] });
		cell.commit({ draft: withState(cell.read(), { inFlight: { text: "sent", images: [] } }), writes: [] });
		cell.commit({ draft: withState(cell.read(), { recoverable: [{ id: 1, text: "t", images: [], reason: "r", unconfirmed: false }] }), writes: [] });
		cell.commit({ draft: withState(cell.read(), { walk: { index: 1, recalled: "hello", draft: "" } }), writes: [] });
		cell.commit({ draft: withState(cell.read(), { lostImages: 2 }), writes: [] });
		cell.commit({ draft: withState(cell.read(), { next: { ...cell.read().next, image: 9, document: 4, key: 5, card: 3 } }), writes: [] });
		cell.commit({ draft: cell.read(), writes: [{ kind: "caret", at: 2, focus: true }] });
		assert.equal(cell.read().revision, before);
		assert.equal(cell.getState().caret, 2, "a caret write still moves the caret");
	});

	it("goes up for a user edit and for the opening of a composition window, never for the echo of the cell's own write", () => {
		const { cell, port } = open("ab");
		const before = cell.read().revision;
		port.text = "abc";
		cell.edited("abc");
		assert.equal(cell.read().revision, before + 1);
		assert.equal(cell.read().text, "abc");
		port.openWindow();
		assert.equal(cell.read().revision, before + 2, "a composition is an edit");
		assert.equal(cell.read().text, "abc", "the window opening changes no text");
		port.closeWindow();
		cell.perform(append("d"), { composing: "now", held: "drop" });
		assert.equal(cell.read().revision, before + 3, "the write counted once; its echo did not count again");
		assert.equal(cell.read().text, "abcd");
	});

	it("stores the revision a refill produced in `unedited`, so that a later check against it is exact", () => {
		const { cell } = open("x");
		cell.commit({ draft: withState(cell.read(), { text: "refill", unedited: 0 }), writes: [{ kind: "text", text: "refill", history: "reset", focus: true }] });
		assert.equal(cell.read().unedited, cell.read().revision);
		const stored = cell.read().unedited;
		cell.commit({ draft: withState(cell.read(), { reading: 1 }), writes: [] });
		assert.equal(cell.read().unedited, stored, "a change that does not touch the latch keeps it");
		cell.commit({ draft: withState(cell.read(), { unedited: null }), writes: [] });
		assert.equal(cell.read().unedited, null, "clearing the latch stays cleared");
	});
});

describe("the typing mirror", () => {
	it("takes the text of a user edit and the caret the field has after it", () => {
		const { cell, port } = open("hello");
		port.text = "hello!";
		port.selected = { anchor: 6, focus: 6 };
		cell.edited("hello!");
		assert.equal(cell.read().text, "hello!");
		assert.equal(cell.getState().caret, 6);
	});

	it("follows the selection of the field on `moved` and on a settled composition", () => {
		const { cell, port } = open("hello");
		port.selected = { anchor: 1, focus: 3 };
		cell.moved();
		assert.equal(cell.getState().caret, 1, "the caret is the selection's start in the field's own terms: its anchor");
		port.selected = { anchor: 5, focus: 5 };
		cell.settled();
		assert.equal(cell.getState().caret, 5);
	});

	it("draws the field again when a composition settles, before the work that waited runs", () => {
		const { cell, port } = open("a");
		port.openWindow();
		cell.perform(append("b"), { composing: "wait", held: "drop" });
		port.calls.length = 0;
		port.closeWindow();
		assert.deepEqual(port.calls, ["redraw", 'write edit 1..1 "b" as replace']);
	});

	it("tells its subscribers once per change and not at all for a state it already announced", () => {
		const { cell } = open();
		let seen = 0;
		const stop = cell.subscribe(() => seen++);
		cell.commit(setText("a", cell.read()));
		assert.equal(seen, 1);
		const first = cell.getState();
		assert.equal(cell.getState(), first, "an unchanged state is the same object");
		cell.moved();
		assert.equal(seen, 1, "a caret that did not move announces nothing");
		stop();
		cell.commit(setText("ab", cell.read()));
		assert.equal(seen, 1, "a subscriber that unsubscribed hears nothing more");
	});
});

describe("commit", () => {
	it("performs the writes in order and moves the caret after a text write to where it says, or to the end of a changed text", () => {
		const { cell, port } = open();
		cell.commit({ draft: withState(cell.read(), { text: "abc" }), writes: [{ kind: "text", text: "abc", history: "record", focus: false }] });
		assert.equal(cell.getState().caret, 3);
		cell.commit({ draft: withState(cell.read(), { text: "abc" }), writes: [{ kind: "text", text: "abc", history: "record", focus: false }] });
		assert.equal(cell.getState().caret, 3, "the same text leaves the caret alone");
		cell.commit({ draft: cell.read(), writes: [{ kind: "text", text: "abc", caret: 1, history: "record", focus: true }, { kind: "caret", at: 2, focus: false }] });
		assert.equal(cell.getState().caret, 2);
		assert.deepEqual(port.calls.slice(-2), ['write text "abc" caret 1 record focus', "write caret 2"]);
	});

	it("restores the value and the caret when the field refuses the write, and says so", () => {
		const { cell, port } = open("keep");
		const before = cell.getState();
		port.refuseNext();
		assert.equal(cell.commit(setText("lost", cell.read())), false);
		assert.equal(cell.read().text, "keep");
		assert.equal(cell.read().revision, before.draft.revision);
		assert.equal(cell.getState().caret, before.caret);
		assert.equal(cell.getState().draft, before.draft, "the very value it had");
	});

	it("refuses a text while the field is frozen, so the value never claims a text the field did not take", () => {
		const { cell, port } = open("keep");
		port.freeze();
		assert.equal(cell.commit(setText("lost", cell.read())), false);
		assert.equal(cell.read().text, "keep");
	});

	it("refuses an edit while a composition window is open, and restores the value", () => {
		const { cell, port } = open("ab");
		port.openWindow();
		const revision = cell.read().revision;
		assert.equal(cell.commit({ draft: withState(cell.read(), { text: "abc" }), writes: [{ kind: "edit", edit: { from: 2, to: 2, insert: "c" }, as: "replace", focus: false }] }), false);
		assert.equal(cell.read().text, "ab");
		assert.equal(cell.read().revision, revision);
	});

	it("queues a text written while a composition window is open, and the field applies it when the window closes", () => {
		const { cell, port } = open("ab");
		port.openWindow();
		assert.equal(cell.commit(setText("restored", cell.read())), true);
		assert.equal(port.text, "ab", "the field is still the browser's");
		assert.equal(port.queued, "restored");
		port.closeWindow();
		assert.equal(port.text, "restored");
		assert.equal(cell.read().text, "restored");
	});

	it("refuses every change while the hand-off holds the draft, a value-only one included", () => {
		const { cell, port } = open("kept");
		assert.notEqual(cell.capture(1), null);
		port.calls.length = 0;
		assert.equal(cell.commit({ draft: withState(cell.read(), { reading: 1 }), writes: [] }), false);
		assert.equal(cell.commit(setText("other", cell.read())), false);
		assert.equal(cell.read().text, "kept");
		assert.equal(cell.read().reading, 0);
		assert.deepEqual(port.calls, []);
	});

	it("takes the text of the surface after an edit it widened over a marker, not the text it asked for", () => {
		const { cell, port } = open("a [Image #1] b");
		port.widen = edit => ({ ...edit, from: Math.min(edit.from, 2) });
		cell.commit({ draft: withState(cell.read(), { text: "a [Imaxb" }), writes: [{ kind: "edit", edit: { from: 5, to: 12, insert: "x" }, as: "replace", focus: false }] });
		assert.equal(port.text, "a x b");
		assert.equal(cell.read().text, "a x b", "the echo reconciles the value with the field's own string");
	});

	it("moves only the value while no field is mounted: an edit puts the caret after what it inserted, a text at the end", () => {
		const { cell, port } = open("abc");
		port.unmount();
		port.calls.length = 0;
		cell.commit({ draft: withState(cell.read(), { text: "abXc" }), writes: [{ kind: "edit", edit: { from: 2, to: 2, insert: "X" }, as: "replace", focus: true }] });
		assert.equal(cell.read().text, "abXc");
		assert.equal(cell.getState().caret, 3);
		cell.commit(setText("new text", cell.read()));
		assert.equal(cell.getState().caret, 8);
		cell.commit({ draft: cell.read(), writes: [{ kind: "caret", at: 1, focus: true }] });
		assert.equal(cell.getState().caret, 8, "a caret write has no field to move");
		assert.deepEqual(port.calls, []);
	});
});

describe("perform: the timing of a writer", () => {
	const timings: readonly Timing[] = [
		{ composing: "wait", held: "wait" },
		{ composing: "wait", held: "drop" },
		{ composing: "skip", held: "wait" },
		{ composing: "skip", held: "drop" },
		{ composing: "now", held: "wait" },
		{ composing: "now", held: "drop" },
	];
	const name = (when: Timing): string => `composing ${when.composing}, held ${when.held}`;

	for (const when of timings) {
		it(`runs at once with no window and no hand-off (${name(when)}) and tells what it did`, () => {
			const { cell, port } = open("a");
			let outcome: Outcome<string> | null = null;
			cell.perform(append("b"), when, result => (outcome = result));
			assert.equal(cell.read().text, "ab");
			assert.equal(port.text, "ab");
			assert.deepEqual(outcome, { kind: "applied", result: "ran at 1" });
		});
	}

	it("waits for the window to close when it asks to wait, and runs then, once, whatever settled does next", () => {
		const { cell, port } = open("a");
		port.openWindow();
		let outcome: Outcome<string> | null = null;
		cell.perform(append("b"), { composing: "wait", held: "drop" }, result => (outcome = result));
		assert.equal(outcome, null, "nothing yet");
		assert.equal(cell.read().text, "a");
		port.closeWindow();
		assert.equal(cell.read().text, "ab");
		assert.deepEqual(outcome, { kind: "applied", result: "ran at 1" });
		port.closeWindow();
		assert.equal(cell.read().text, "ab", "a second settle runs nothing again");
	});

	it("is dropped at once, never run, when it skips and a window is open", () => {
		const { cell, port } = open("a");
		port.openWindow();
		let ran = false;
		let outcome: Outcome<string> | null = null;
		cell.perform<string>((draft, at) => {
			ran = true;
			return append("b")(draft, at);
		}, { composing: "skip", held: "wait" }, result => (outcome = result));
		assert.deepEqual(outcome, { kind: "dropped" });
		port.closeWindow();
		assert.equal(ran, false);
		assert.equal(cell.read().text, "a");
	});

	it("runs inside the window when it says now: a text is queued by the field, an edit is refused and the value restored", () => {
		const { cell, port } = open("a");
		port.openWindow();
		let queued: Outcome<undefined> | null = null;
		cell.perform<undefined>(draft => ({ change: setText("whole", draft), result: undefined }), { composing: "now", held: "drop" }, result => (queued = result));
		assert.deepEqual(queued, { kind: "applied", result: undefined });
		assert.equal(port.queued, "whole");
		let refused: Outcome<string> | null = null;
		cell.perform(append("b"), { composing: "now", held: "drop" }, result => (refused = result));
		assert.deepEqual(refused, { kind: "refused", result: "ran at 1" });
		assert.equal(cell.read().text, "whole", "the queued text is the value; the refused edit left no trace");
	});

	it("is dropped at once, never run, when it drops and the hand-off holds the draft", () => {
		const { cell } = open("a");
		assert.notEqual(cell.capture(7), null);
		let ran = false;
		let outcome: Outcome<string> | null = null;
		cell.perform<string>((draft, at) => {
			ran = true;
			return append("b")(draft, at);
		}, { composing: "wait", held: "drop" }, result => (outcome = result));
		assert.deepEqual(outcome, { kind: "dropped" });
		cell.release(7);
		assert.equal(ran, false);
		assert.equal(cell.read().text, "a");
	});

	it("waits for the release when it asks to wait while the draft is held, and runs then with the draft as it is then", () => {
		const { cell } = open("a");
		assert.notEqual(cell.capture(7), null);
		const order: string[] = [];
		cell.perform(append("b"), { composing: "wait", held: "wait" }, () => order.push("first"));
		cell.perform(append("c"), { composing: "wait", held: "wait" }, () => order.push("second"));
		assert.equal(cell.read().text, "a");
		assert.equal(cell.release(7), true);
		assert.equal(cell.read().text, "abc", "in arrival order, each on the result of the one before");
		assert.deepEqual(order, ["first", "second"]);
	});

	it("waits for both: a window that closes while the draft is still held does not run it, the release does", () => {
		const { cell, port } = open("a");
		assert.notEqual(cell.capture(3), null);
		port.openWindow();
		cell.perform(append("b"), { composing: "wait", held: "wait" });
		port.closeWindow();
		assert.equal(cell.read().text, "a", "the window is closed but the draft is still held");
		cell.release(3);
		assert.equal(cell.read().text, "ab");
	});

	it("tells an operation the field's selection, and the end of the text with `mounted: false` when there is no field", () => {
		const { cell, port } = open("hello");
		port.selected = { anchor: 1, focus: 3 };
		const seen: string[] = [];
		cell.perform<null>((draft, at) => { seen.push(`${at.selection.anchor}..${at.selection.focus} ${at.mounted}`); return null; }, { composing: "now", held: "drop" });
		port.unmount();
		cell.perform<null>((draft, at) => { seen.push(`${at.selection.anchor}..${at.selection.focus} ${at.mounted}`); return null; }, { composing: "now", held: "drop" });
		assert.deepEqual(seen, ["1..3 true", "5..5 false"]);
	});

	it("drops an operation that has nothing to do, and applies one whose change is null without a commit", () => {
		const { cell } = open("a");
		const revision = cell.read().revision;
		let none: Outcome<string> | null = null;
		cell.perform<string>(() => null, { composing: "now", held: "drop" }, result => (none = result));
		assert.deepEqual(none, { kind: "dropped" });
		let done: Outcome<string> | null = null;
		cell.perform<string>(() => ({ change: null, result: "side effect only" }), { composing: "now", held: "drop" }, result => (done = result));
		assert.deepEqual(done, { kind: "applied", result: "side effect only" });
		assert.equal(cell.read().revision, revision);
	});

	it("tells a refusal of the field, with the value as it was", () => {
		const { cell, port } = open("a");
		port.refuseNext();
		let outcome: Outcome<string> | null = null;
		cell.perform(append("b"), { composing: "now", held: "drop" }, result => (outcome = result));
		assert.deepEqual(outcome, { kind: "refused", result: "ran at 1" });
		assert.equal(cell.read().text, "a");
	});
});

describe("the hand-off capture", () => {
	it("carries the draft and holds it: the field is frozen and `held` says so until the release", async () => {
		const { cell, port } = open("keep");
		assert.equal(cell.held(), null);
		const content = cell.capture(5);
		assert.deepEqual(content, { text: "keep", attachments: 0, recoverable: [], documents: [] });
		assert.equal(port.frozen, true);
		assert.equal(cell.getState().held, true);
		const held = cell.held();
		assert.notEqual(held, null);
		let released = false;
		void held!.then(() => { released = true; });
		assert.equal(cell.release(5), true);
		await held;
		assert.equal(released, true);
		assert.equal(port.frozen, false);
		assert.equal(cell.getState().held, false);
		assert.equal(cell.held(), null);
	});

	it("refuses to capture while files are read, a composition is open, or another capture is held", () => {
		const reading = open("a");
		reading.cell.commit({ draft: withState(reading.cell.read(), { reading: 1 }), writes: [] });
		assert.equal(reading.cell.capture(1), null, "a read in flight would change the draft the capture carries");
		reading.cell.commit({ draft: withState(reading.cell.read(), { reading: 0 }), writes: [] });
		assert.notEqual(reading.cell.capture(2), null);
		assert.equal(reading.cell.capture(3), null, "one capture at a time");

		const composing = open("a");
		composing.port.openWindow();
		assert.equal(composing.cell.capture(1), null);
		composing.cell.perform(append("b"), { composing: "wait", held: "drop" });
		composing.port.closeWindow();
		assert.notEqual(composing.cell.capture(2), null, "the window closed and the work that waited ran");

	});

	it("is not released by a request that is not the held one", () => {
		const { cell, port } = open("a");
		cell.capture(5);
		assert.equal(cell.release(6), false);
		assert.equal(cell.getState().held, true);
		assert.equal(port.frozen, true);
	});

	it("carries every card and the message awaiting admission as unconfirmed, the number of images and the documents", () => {
		const { cell } = open("see [File #1: notes.md] and [Image #1, 1x1]");
		const image = { id: 1, name: "a.png", mimeType: "image/png" as const, bytes: 3, data: "AAA", number: 1 };
		const held = { number: 1, name: "notes.md", source: { kind: "held" as const, content: "# Notes", label: null, bytes: 7 } };
		cell.commit({
			draft: withState(cell.read(), {
				images: [image],
				documents: [held],
				lostImages: 2,
				recoverable: [{ id: 1, text: "card", images: [{ type: "image", mimeType: "image/png", data: "AAA" }], reason: "r", unconfirmed: false, lostAttachments: 1 }],
				inFlight: { text: "being sent", images: [] },
			}),
			writes: [],
		});
		const content = cell.capture(1);
		assert.deepEqual(content, {
			text: "see [File #1: notes.md] and [Image #1, 1x1]",
			attachments: 3,
			recoverable: [
				{ text: "card", attachments: 2, unconfirmed: false },
				{ text: "being sent", attachments: 0, unconfirmed: true },
			],
			documents: [{ number: 1, name: "notes.md", ref: null, label: null, content: "# Notes", bytes: 7, chars: 7 }],
		});
	});
});

describe("the end of the cell", () => {
	it("forgets the work that waited and runs nothing again once it is disposed", () => {
		const { cell, port } = open("a");
		port.openWindow();
		cell.perform(append("b"), { composing: "wait", held: "drop" });
		cell.dispose();
		assert.equal(cell.alive(), false);
		port.closeWindow();
		cell.perform(append("c"), { composing: "now", held: "drop" });
		assert.equal(cell.read().text, "a");
		assert.equal(cell.commit(setText("x", cell.read())), false);
	});

	it("still thaws the field and resolves `held` at a release after it is disposed", async () => {
		const { cell, port } = open("a");
		cell.capture(4);
		const held = cell.held();
		cell.dispose();
		assert.equal(cell.release(4), true);
		await held;
		assert.equal(port.frozen, false);
	});

	it("announces nothing after it is disposed", () => {
		const { cell } = open();
		let seen = 0;
		cell.subscribe(() => seen++);
		cell.dispose();
		cell.moved();
		cell.edited("late");
		assert.equal(seen, 0);
	});
});
