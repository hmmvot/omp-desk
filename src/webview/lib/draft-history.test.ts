import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DraftHistory, type DraftSnapshot } from "./draft-history.ts";

const at = (text: string, caret = text.length): DraftSnapshot => ({ text, anchor: caret, focus: caret });

describe("DraftHistory", () => {
	it("merges typing at the caret it left, within the window, into one step", () => {
		const history = new DraftHistory();
		history.record(at(""), "type", 1, 0);
		history.record(at("a"), "type", 2, 200);
		history.record(at("ab"), "type", 3, 900);
		assert.deepEqual(history.undo(at("abc")), at(""));
		assert.equal(history.canUndo, false);
	});

	it("starts a new step after the window, after a jump of the caret, after a selection and for another kind", () => {
		const history = new DraftHistory();
		history.record(at(""), "type", 1, 0);
		history.record(at("a"), "type", 2, 1500); // too late
		history.record(at("ab", 0), "type", 1, 1600); // the caret moved away
		history.record({ text: "xab", anchor: 0, focus: 2 }, "type", 1, 1700); // replaced a selection
		history.record(at("y"), "delete", 0, 1800); // another kind
		let steps = 0;
		for (let current = at("z"); history.undo(current) !== null; steps++) current = at("z");
		assert.equal(steps, 5);
	});

	it("merges consecutive deletions but never a newline, paste, cut, block edit, replacement or composition", () => {
		const history = new DraftHistory();
		history.record(at("abc"), "delete", 2, 0);
		history.record(at("ab"), "delete", 1, 100);
		history.record(at("a", 1), "newline", 2, 200);
		history.record(at("a\n"), "newline", 3, 250);
		history.record(at("a\n\n"), "paste", 6, 300);
		history.record(at("a\n\npqr"), "composition", 7, 350);
		let steps = 0;
		while (history.undo(at("")) !== null) steps++;
		assert.equal(steps, 5);
	});

	it("undo and redo walk the same states and carry the selection", () => {
		const history = new DraftHistory();
		history.record({ text: "one", anchor: 1, focus: 3 }, "replace", 4, 0);
		history.record(at("one!"), "replace", 5, 10);
		const first = history.undo({ text: "one!!", anchor: 5, focus: 5 });
		assert.deepEqual(first, at("one!"));
		const second = history.undo(first!);
		assert.deepEqual(second, { text: "one", anchor: 1, focus: 3 });
		assert.deepEqual(history.redo(second!), first);
		assert.deepEqual(history.redo(first!), { text: "one!!", anchor: 5, focus: 5 });
		assert.equal(history.redo(at("")), null);
	});

	it("a new edit clears the redo stack", () => {
		const history = new DraftHistory();
		history.record(at(""), "paste", 3, 0);
		history.undo(at("abc"));
		assert.equal(history.canRedo, true);
		history.record(at(""), "paste", 1, 10);
		assert.equal(history.canRedo, false);
	});

	it("an undo or redo ends a typing run", () => {
		const history = new DraftHistory();
		history.record(at(""), "type", 1, 0);
		history.undo(at("a"));
		history.redo(at(""));
		history.record(at("a"), "type", 2, 20);
		assert.deepEqual(history.undo(at("ab")), at("a"));
	});

	it("caps the steps and the characters, keeping the newest step even alone over the cap", () => {
		const bySteps = new DraftHistory({ steps: 3, characters: 1000, mergeWindowMs: 0 });
		for (let index = 0; index < 5; index++) bySteps.record(at(String(index)), "paste", 1, index);
		const kept: string[] = [];
		for (let step = bySteps.undo(at("x")); step !== null; step = bySteps.undo(at("x"))) kept.push(step.text);
		assert.deepEqual(kept, ["4", "3", "2"]);

		const byCharacters = new DraftHistory({ steps: 100, characters: 10, mergeWindowMs: 0 });
		byCharacters.record(at("aaaaaa"), "paste", 1, 0);
		byCharacters.record(at("bbbbbb"), "paste", 1, 1);
		assert.deepEqual(byCharacters.undo(at("")), at("bbbbbb"));
		assert.equal(byCharacters.undo(at("")), null);
		const huge = new DraftHistory({ steps: 100, characters: 10, mergeWindowMs: 0 });
		huge.record(at("x".repeat(50)), "paste", 1, 0);
		assert.equal(huge.canUndo, true);
	});

	it("reset forgets both stacks and the typing run", () => {
		const history = new DraftHistory();
		history.record(at(""), "type", 1, 0);
		history.undo(at("a"));
		history.reset();
		assert.equal(history.canUndo, false);
		assert.equal(history.canRedo, false);
		history.record(at(""), "type", 1, 10);
		history.record(at("a"), "type", 2, 20);
		assert.deepEqual(history.undo(at("ab")), at(""));
	});
});
