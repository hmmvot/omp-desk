import assert from "node:assert/strict";
import { test } from "node:test";
import { codeWrapKey, isCodeWrapped, setCodeWrapped, showsWrapToggle } from "./code-wrap.ts";

test("the toggle shows for a block wider than its box, and while the block wraps", () => {
	assert.equal(showsWrapToggle(false, 300, 200), true);
	assert.equal(showsWrapToggle(false, 200, 200), false);
	assert.equal(showsWrapToggle(false, 201, 200), false, "a pixel of rounding is not an overflow");
	assert.equal(showsWrapToggle(false, 202, 200), true);
	assert.equal(showsWrapToggle(true, 200, 200), true, "a wrapped block has nothing to scroll and still offers the way back");
});

test("a block is named by its scope and place; with no scope it has no name", () => {
	assert.equal(codeWrapKey("chat:a/0", "b3"), "chat:a/0#b3");
	assert.equal(codeWrapKey(null, "b3"), null);
	assert.notEqual(codeWrapKey("chat:a/0", "b3"), codeWrapKey("chat:a/1", "b3"));
});

test("the choice is remembered per name, off by default, and an unnamed block remembers nothing", () => {
	const key = codeWrapKey("unit:one", "b0");
	assert.equal(isCodeWrapped(key), false);
	setCodeWrapped(key, true);
	assert.equal(isCodeWrapped(key), true);
	assert.equal(isCodeWrapped(codeWrapKey("unit:one", "b1")), false);
	setCodeWrapped(key, false);
	assert.equal(isCodeWrapped(key), false);
	setCodeWrapped(null, true);
	assert.equal(isCodeWrapped(null), false);
});

test("the oldest choice is forgotten past the limit", () => {
	const first = codeWrapKey("unit:limit", 0);
	setCodeWrapped(first, true);
	for (let index = 1; index <= 500; index++) setCodeWrapped(codeWrapKey("unit:limit", index), true);
	assert.equal(isCodeWrapped(first), false);
	assert.equal(isCodeWrapped(codeWrapKey("unit:limit", 500)), true);
});
