/**
 * Tests for the page's transient notices: a key never stacks, a timer dismisses, and a dismissal is idempotent.
 *
 * Runner: `node --test src/webview/lib/chat-notices.test.ts`.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { ChatNoticeStore } from "./chat-notices.ts";

describe("ChatNoticeStore", () => {
	beforeEach(() => {
		mock.timers.enable({ apis: ["setTimeout"] });
		Reflect.set(globalThis, "window", globalThis);
	});
	afterEach(() => {
		mock.timers.reset();
		Reflect.deleteProperty(globalThis, "window");
	});

	it("replaces a notice with the same key in place and keeps the order of the others", () => {
		const store = new ChatNoticeStore();
		store.post({ key: "a", text: "first", level: "info" });
		store.post({ key: "b", text: "second", level: "warn" });
		store.post({ key: "a", text: "again", level: "error" });
		assert.deepEqual(store.getState(), [{ key: "a", text: "again", level: "error" }, { key: "b", text: "second", level: "warn" }]);
	});

	it("dismisses by itself after its time, and a re-post restarts the clock", () => {
		const store = new ChatNoticeStore();
		store.post({ key: "a", text: "x", level: "info", ttlMs: 1000 });
		mock.timers.tick(800);
		store.post({ key: "a", text: "y", level: "info", ttlMs: 1000 });
		mock.timers.tick(800);
		assert.equal(store.getState().length, 1);
		mock.timers.tick(200);
		assert.deepEqual(store.getState(), []);
	});

	it("keeps a notice without a time until it is dismissed, and dismissing a missing key changes nothing", () => {
		const store = new ChatNoticeStore();
		let changes = 0;
		store.subscribe(() => { changes += 1; });
		store.post({ key: "a", text: "x", level: "info" });
		mock.timers.tick(60_000);
		assert.equal(store.getState().length, 1);
		store.dismiss("missing");
		assert.equal(changes, 1);
		const before = store.getState();
		store.dismiss("a");
		assert.deepEqual(store.getState(), []);
		assert.notEqual(store.getState(), before);
	});
});
