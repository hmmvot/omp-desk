import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { typingIntent, type TypingKey } from "./type-to-focus.ts";

const key = (name: string, extra: Partial<TypingKey> = {}): TypingKey => ({
	key: name, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false, altGraph: false, ...extra,
});

describe("typingIntent", () => {
	it("treats one character as text, including shifted, non-Latin and astral ones", () => {
		for (const name of ["a", "A", "7", "/", "@", "я", "é", "😀"]) assert.equal(typingIntent(key(name, { shiftKey: name === "A" })), "text", name);
	});

	it("leaves Space, Enter, Tab, Escape and navigation keys native", () => {
		for (const name of [" ", "Enter", "Tab", "Escape", "ArrowUp", "PageDown", "Home", "End", "Backspace", "Delete", "F5", "Shift", "Control"]) {
			assert.equal(typingIntent(key(name)), null, name);
		}
	});

	it("does not take chords, but takes AltGr text", () => {
		assert.equal(typingIntent(key("c", { ctrlKey: true })), null);
		assert.equal(typingIntent(key("f", { metaKey: true })), null);
		assert.equal(typingIntent(key("ArrowUp", { altKey: true })), null);
		assert.equal(typingIntent(key("r", { altKey: true })), null);
		assert.equal(typingIntent(key("@", { ctrlKey: true, altKey: true, altGraph: true })), "text");
	});

	it("does not take IME composition or dead keys", () => {
		assert.equal(typingIntent(key("a", { isComposing: true })), null);
		assert.equal(typingIntent(key("a", { keyCode: 229 })), null);
		assert.equal(typingIntent(key("Process")), null);
		assert.equal(typingIntent(key("Dead")), null);
	});

	it("recognises paste chords on any layout, and no other V chord", () => {
		assert.equal(typingIntent(key("v", { ctrlKey: true })), "paste");
		assert.equal(typingIntent(key("V", { ctrlKey: true, shiftKey: true })), "paste");
		assert.equal(typingIntent(key("м", { ctrlKey: true, code: "KeyV" })), "paste");
		assert.equal(typingIntent(key("v", { metaKey: true })), "paste");
		assert.equal(typingIntent(key("Insert", { shiftKey: true })), "paste");
		assert.equal(typingIntent(key("Insert")), null);
		assert.equal(typingIntent(key("v", { ctrlKey: true, altKey: true })), null);
	});
});
