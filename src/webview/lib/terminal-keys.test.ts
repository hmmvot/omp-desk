import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isTerminalRedrawChord, terminalCopyChord, withoutInterrupt } from "./terminal-keys.ts";
import type { TerminalKeyEventLike } from "./terminal-keys.ts";

// Non-Latin letters below are written as escapes: U+0441 and U+0421 are Cyrillic es (the key a Russian layout reports
// for the physical C key), U+043C is Cyrillic em (physical V) and U+043A is Cyrillic ka (physical R).

function key(key: string, modifiers: Partial<TerminalKeyEventLike> = {}): TerminalKeyEventLike {
	const code = key.length === 1 ? `Key${key.toUpperCase()}` : key;
	return { type: "keydown", key, code, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...modifiers };
}

describe("terminal copy chords in a shell (Ctrl+C interrupts)", () => {
	it("copies on Ctrl+C and Ctrl+Insert only while text is selected", () => {
		assert.equal(terminalCopyChord(key("c", { ctrlKey: true }), true, true), "selection");
		assert.equal(terminalCopyChord(key("Insert", { ctrlKey: true }), true, true), "selection");
		// No selection: Ctrl+C is the interrupt and reaches the program.
		assert.equal(terminalCopyChord(key("c", { ctrlKey: true }), false, true), null);
		assert.equal(terminalCopyChord(key("Insert", { ctrlKey: true }), false, true), null);
	});

	it("always claims Ctrl+Shift+C, with or without a selection", () => {
		assert.equal(terminalCopyChord(key("C", { ctrlKey: true, shiftKey: true }), true, true), "always");
		assert.equal(terminalCopyChord(key("C", { ctrlKey: true, shiftKey: true }), false, true), "always");
	});

	it("follows the physical C key on a non-Latin layout", () => {
		assert.equal(terminalCopyChord({ ...key("\u0441", { ctrlKey: true }), code: "KeyC" }, true, true), "selection");
		assert.equal(terminalCopyChord({ ...key("\u0441", { ctrlKey: true }), code: "KeyC" }, false, true), null);
		assert.equal(terminalCopyChord({ ...key("\u0441", { ctrlKey: true, shiftKey: true }), code: "KeyC" }, false, true), "always");
		assert.equal(terminalCopyChord({ ...key("\u043c", { ctrlKey: true }), code: "KeyV" }, true, true), null);
	});

	it("leaves paste, other controls and unrelated modifiers to the terminal", () => {
		assert.equal(terminalCopyChord(key("v", { ctrlKey: true }), true, true), null);
		assert.equal(terminalCopyChord(key("V", { ctrlKey: true, shiftKey: true }), true, true), null);
		assert.equal(terminalCopyChord(key("Insert", { shiftKey: true }), true, true), null);
		assert.equal(terminalCopyChord(key("d", { ctrlKey: true }), true, true), null);
		assert.equal(terminalCopyChord(key("c"), true, true), null);
		assert.equal(terminalCopyChord(key("c", { ctrlKey: true, altKey: true }), true, true), null);
		assert.equal(terminalCopyChord(key("c", { ctrlKey: true, metaKey: true }), true, true), null);
		assert.equal(terminalCopyChord(key("Insert", { ctrlKey: true, shiftKey: true }), true, true), null);
	});
});

describe("isTerminalRedrawChord", () => {
	it("claims Ctrl+Alt+Shift+R on any layout and nothing the program or copy uses", () => {
		assert.equal(isTerminalRedrawChord(key("R", { ctrlKey: true, altKey: true, shiftKey: true })), true);
		assert.equal(isTerminalRedrawChord({ ...key("\u043a", { ctrlKey: true, altKey: true, shiftKey: true }), code: "KeyR" }), true);
		assert.equal(isTerminalRedrawChord(key("R", { metaKey: true, altKey: true, shiftKey: true })), true);
		assert.equal(isTerminalRedrawChord(key("r", { ctrlKey: true })), false);
		assert.equal(isTerminalRedrawChord(key("R", { ctrlKey: true, shiftKey: true })), false);
		assert.equal(isTerminalRedrawChord(key("R", { ctrlKey: true, altKey: true })), false);
		assert.equal(isTerminalRedrawChord(key("L", { ctrlKey: true, altKey: true, shiftKey: true })), false);
		assert.equal(isTerminalRedrawChord(key("l", { ctrlKey: true })), false, "Ctrl+L is OMP's live-mode key");
	});
});

describe("terminal copy chords in a native OMP session (Ctrl+C never interrupts)", () => {
	const russianC = (modifiers: Partial<TerminalKeyEventLike> = {}): TerminalKeyEventLike => ({ ...key("\u0441", { ctrlKey: true, ...modifiers }), code: "KeyC" });

	it("copies a selection and consumes the key when nothing is selected", () => {
		assert.equal(terminalCopyChord(key("c", { ctrlKey: true }), true, false), "selection");
		assert.equal(terminalCopyChord(key("c", { ctrlKey: true }), false, false), "always");
		assert.equal(terminalCopyChord(key("C", { ctrlKey: true }), false, false), "always");
	});

	it("treats the Russian layout's Ctrl+C (key U+0441, code KeyC) exactly like Latin Ctrl+C", () => {
		assert.equal(terminalCopyChord(russianC(), true, false), "selection");
		assert.equal(terminalCopyChord(russianC(), false, false), "always");
		assert.equal(terminalCopyChord(russianC({ key: "\u0421" }), false, false), "always");
		assert.equal(terminalCopyChord(russianC({ shiftKey: true }), false, false), "always");
	});

	it("follows the letter on a layout whose physical C key is another letter", () => {
		// Dvorak: the key labelled C is physically KeyI, and the physical KeyC types J.
		assert.equal(terminalCopyChord({ ...key("c", { ctrlKey: true }), code: "KeyI" }, false, false), "always");
		assert.equal(terminalCopyChord({ ...key("j", { ctrlKey: true }), code: "KeyC" }, false, false), null);
	});

	it("still leaves other chords to the terminal", () => {
		assert.equal(terminalCopyChord(key("d", { ctrlKey: true }), false, false), null);
		assert.equal(terminalCopyChord(key("v", { ctrlKey: true }), false, false), null);
		assert.equal(terminalCopyChord(key("c"), false, false), null);
		assert.equal(terminalCopyChord(key("Insert", { ctrlKey: true }), false, false), null);
	});
});

describe("withoutInterrupt", () => {
	it("drops the interrupt byte and its escape-prefixed encoding whole", () => {
		assert.equal(withoutInterrupt("\u0003"), "");
		assert.equal(withoutInterrupt("\u001b\u0003"), "");
	});

	it("removes a pasted ^C but keeps the rest of the paste", () => {
		assert.equal(withoutInterrupt("a\u0003b"), "ab");
		assert.equal(withoutInterrupt("plain text\r"), "plain text\r");
		assert.equal(withoutInterrupt("\u001b"), "\u001b");
	});
});
