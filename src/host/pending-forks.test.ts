/**
 * Behavioral tests for the registry of fork sources (`docs/designs/2026-10-18-fork-branch-clear-session-actions.md`):
 * a source is read by tab id without being spent, and is forgotten when the fork ends.
 * Runner: `node --test src/host/pending-forks.test.ts`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PendingForks } from "./pending-forks.ts";

const SOURCE = "D:\\scratch\\2026-10-18T10-00-00_S-ONE.jsonl";

describe("PendingForks", () => {
	it("knows no source for an ordinary draft", () => {
		const forks = new PendingForks();
		assert.equal(forks.peek("tab-1"), null);
		assert.equal(forks.size, 0);
	});

	it("returns the registered source per tab without consuming it on peek", () => {
		const forks = new PendingForks();
		forks.register("tab-1", SOURCE);
		forks.register("tab-2", `${SOURCE}.other`);
		assert.equal(forks.peek("tab-1"), SOURCE);
		assert.equal(forks.peek("tab-1"), SOURCE, "peeking does not spend the source");
		assert.equal(forks.peek("tab-2"), `${SOURCE}.other`);
		assert.equal(forks.peek("tab-3"), null);
		assert.equal(forks.size, 2);
	});

	it("registering the same tab again replaces its source", () => {
		const forks = new PendingForks();
		forks.register("tab-1", SOURCE);
		forks.register("tab-1", `${SOURCE}.newer`);
		assert.equal(forks.peek("tab-1"), `${SOURCE}.newer`);
		assert.equal(forks.size, 1);
	});

	it("forgets one tab's source and leaves the others, and forgetting twice is harmless", () => {
		const forks = new PendingForks();
		forks.register("tab-1", SOURCE);
		forks.register("tab-2", SOURCE);
		forks.forget("tab-1");
		assert.equal(forks.peek("tab-1"), null);
		assert.equal(forks.peek("tab-2"), SOURCE, "another tab's source is untouched");
		forks.forget("tab-1");
		assert.equal(forks.size, 1);
	});
});
