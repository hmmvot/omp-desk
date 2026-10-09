import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { appearedGroup, FileWindowTracker } from "./file-window.ts";

/** A group like VS Code's: one object per group, whose column VS Code updates in place. */
const group = (viewColumn: number) => ({ viewColumn });

describe("the file window tracker", () => {
	it("has no window until a group is adopted", () => {
		const main = group(1);
		const tracker = new FileWindowTracker<{ viewColumn: number }>();
		assert.equal(tracker.current([main]), null);
		assert.equal(tracker.column([main]), null);
	});

	it("follows its group when the column moves", () => {
		const main = group(1);
		const window = group(2);
		const tracker = new FileWindowTracker<{ viewColumn: number }>();
		tracker.adopt(window);
		assert.equal(tracker.column([main, window]), 2);
		const added = group(2);
		window.viewColumn = 3;
		assert.equal(tracker.column([main, added, window]), 3);
	});

	it("forgets the window once its group is gone, and does not come back with a group at the same column", () => {
		const main = group(1);
		const window = group(2);
		const tracker = new FileWindowTracker<{ viewColumn: number }>();
		tracker.adopt(window);
		assert.equal(tracker.column([main]), null);
		assert.equal(tracker.column([main, group(2)]), null);
		assert.equal(tracker.column([main, window]), null, "a closed window stays closed");
	});

	it("is replaced by the next adopted group, or cleared", () => {
		const first = group(2);
		const second = group(3);
		const tracker = new FileWindowTracker<{ viewColumn: number }>();
		tracker.adopt(first);
		tracker.adopt(second);
		assert.equal(tracker.current([group(1), first, second]), second);
		tracker.adopt(null);
		assert.equal(tracker.current([first, second]), null);
	});
});

describe("the group a new window brought", () => {
	it("is the last group that was not listed before", () => {
		const a = group(1);
		const b = group(2);
		const fresh = group(3);
		assert.equal(appearedGroup([a, b], [a, b, fresh]), fresh);
		assert.equal(appearedGroup([a], [a, fresh, b]), b, "the last of several new groups");
	});

	it("is absent when no group appeared", () => {
		const a = group(1);
		assert.equal(appearedGroup([a], [a]), null);
		assert.equal(appearedGroup([a], []), null);
	});
});
