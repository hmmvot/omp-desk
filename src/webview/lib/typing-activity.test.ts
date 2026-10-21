/**
 * Tests for the typing tracker: the user counts as typing from an edit until the pause, subscribers hear each change
 * once, and the end of the pause is measured from the last edit, not the first.
 *
 * Runner: `node --test src/webview/lib/typing-activity.test.ts`.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { isTyping, noteEdit, subscribeTyping, TYPING_QUIET_MS, trackTyping } from "./typing-activity.ts";

describe("typing activity", () => {
	let changes = 0;
	let stop: () => void;
	let release: () => void;
	beforeEach(() => {
		mock.timers.enable({ apis: ["setTimeout", "Date"] });
		changes = 0;
		release = subscribeTyping(() => { changes += 1; });
		stop = trackTyping({ addEventListener() {}, removeEventListener() {} } as unknown as Document);
	});
	afterEach(() => {
		stop();
		release();
		mock.timers.reset();
	});

	it("is typing from an edit until a pause, and tells subscribers once for each change", () => {
		assert.equal(isTyping(), false);
		noteEdit();
		assert.equal(isTyping(), true);
		assert.equal(changes, 1);
		mock.timers.tick(TYPING_QUIET_MS - 1);
		assert.equal(isTyping(), true);
		mock.timers.tick(1);
		assert.equal(isTyping(), false);
		assert.equal(changes, 2);
	});

	it("measures the pause from the last edit", () => {
		noteEdit();
		mock.timers.tick(TYPING_QUIET_MS - 100);
		noteEdit();
		mock.timers.tick(TYPING_QUIET_MS - 100);
		assert.equal(isTyping(), true, "the second edit moved the end of the pause");
		assert.equal(changes, 1, "a continued run is not a new change");
		mock.timers.tick(100);
		assert.equal(isTyping(), false);
		assert.equal(changes, 2);
	});

	it("stops and forgets the activity when tracking ends", () => {
		noteEdit();
		stop();
		assert.equal(isTyping(), false);
		assert.equal(changes, 2);
		stop = trackTyping({ addEventListener() {}, removeEventListener() {} } as unknown as Document);
	});
});
