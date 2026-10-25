/**
 * A snapshot hands back the rows the page already holds as new objects. `shareEntries` gives the page its own object
 * for every row whose content did not change, so what the page keyed on that object (measured heights, memoized
 * presentation) stays valid, and gives the new object for every row that did change.
 *
 * Runner: `node --test src/chat/entry-sharing.test.ts`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChatEntry } from "./messages.ts";
import { sameJson, shareEntries } from "./entry-sharing.ts";

const user = (id: string, content: string): ChatEntry => ({ type: "message", id, parentId: null, timestamp: "2026-09-25T00:00:00.000Z", message: { role: "user", content, timestamp: 1 } });
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe("sameJson", () => {
	it("compares parsed values by content, not by reference", () => {
		assert.equal(sameJson({ a: [1, { b: "x" }], c: null }, { c: null, a: [1, { b: "x" }] }), true, "key order does not matter");
		assert.equal(sameJson([1, 2], [1, 2, 3]), false);
		assert.equal(sameJson({ a: 1 }, { a: 1, b: undefined }), false, "a key one side lacks differs");
		assert.equal(sameJson({ a: 1, b: 2 }, { a: 1, c: 2 }), false, "a different key differs");
		assert.equal(sameJson([], {}), false, "an array is not an object");
		assert.equal(sameJson(null, {}), false);
		assert.equal(sameJson("1", 1), false);
	});
});

describe("shareEntries", () => {
	it("returns the held object for a row that is equal and the new one for a row that changed or is new", () => {
		const held = [user("a", "one"), user("b", "two"), user("c", "three")];
		const next = clone([user("a", "one"), user("b", "two, edited"), user("d", "four")]);
		const shared = shareEntries(held, next);
		assert.equal(shared[0], held[0], "an unchanged row keeps its object");
		assert.equal(shared[1], next[1], "a changed row is the new object");
		assert.equal(shared[2], next[2], "a row the page did not hold is the new object");
		assert.deepEqual(shared.map(entry => entry.id), ["a", "b", "d"], "the order and the set are the snapshot's");
	});

	it("shares nothing when the page holds nothing, and never returns the snapshot's own array", () => {
		const next = [user("a", "one")];
		const shared = shareEntries([], next);
		assert.notEqual(shared, next);
		assert.equal(shared[0], next[0]);
	});
});
