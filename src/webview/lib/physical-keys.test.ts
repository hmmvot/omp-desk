import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isPhysicalKey, physicalCode } from "./physical-keys.ts";

describe("the physical key of a shortcut", () => {
	it("is the code of the key, whatever character the layout types", () => {
		assert.equal(isPhysicalKey({ key: "c", code: "KeyC" }, "KeyC"), true);
		assert.equal(isPhysicalKey({ key: "C", code: "KeyC" }, "KeyC"), true, "Shift or Caps Lock reports the capital");
		assert.equal(isPhysicalKey({ key: "\u0441", code: "KeyC" }, "KeyC"), true, "a Russian layout: the physical C key types U+0441");
		assert.equal(isPhysicalKey({ key: "\u03c8", code: "KeyC" }, "KeyC"), true, "a Greek layout");
		assert.equal(isPhysicalKey({ key: ".", code: "Slash" }, "Slash"), true, "punctuation is a place too");
		assert.equal(isPhysicalKey({ key: "1", code: "Digit1" }, "Digit1"), true);
		assert.equal(isPhysicalKey({ key: "!", code: "Digit1" }, "Digit1"), true);
	});

	it("does not follow the character on a Latin layout that moves the letters", () => {
		// Dvorak: the key labelled C is physically KeyI, and the physical KeyC types J.
		assert.equal(isPhysicalKey({ key: "c", code: "KeyI" }, "KeyC"), false);
		assert.equal(isPhysicalKey({ key: "j", code: "KeyC" }, "KeyC"), true);
	});

	it("tells another physical key apart", () => {
		assert.equal(isPhysicalKey({ key: "\u0430", code: "KeyA" }, "KeyF"), false);
		assert.equal(isPhysicalKey({ key: "F3", code: "F3" }, "KeyF"), false);
	});

	it("reads a script-built event without a code by its Latin letter or digit", () => {
		assert.equal(physicalCode({ key: "v", code: "" }), "KeyV");
		assert.equal(physicalCode({ key: "V" }), "KeyV");
		assert.equal(physicalCode({ key: "7", code: "" }), "Digit7");
		assert.equal(physicalCode({ key: "\u043c", code: "" }), "");
		assert.equal(physicalCode({ key: "Enter", code: "" }), "");
	});
});
