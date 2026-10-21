import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isChatSendWith, isSendChord, SEND_KEY_LABELS } from "./send-with.ts";

const key = (extra: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; key?: string } = {}) => ({ key: "Enter", shiftKey: false, ...extra });

describe("isSendChord", () => {
	it("enter mode: a plain Enter sends and Shift+Enter is a newline", () => {
		assert.equal(isSendChord(key(), "enter"), true);
		assert.equal(isSendChord(key({ shiftKey: true }), "enter"), false);
		assert.equal(isSendChord(key({ ctrlKey: true }), "enter"), true);
	});

	it("shiftEnter mode: Shift+Enter sends and a plain Enter is a newline; Ctrl+Enter and Meta+Enter still send", () => {
		assert.equal(isSendChord(key({ shiftKey: true }), "shiftEnter"), true);
		assert.equal(isSendChord(key(), "shiftEnter"), false);
		assert.equal(isSendChord(key({ ctrlKey: true }), "shiftEnter"), true);
		assert.equal(isSendChord(key({ metaKey: true }), "shiftEnter"), true);
	});

	it("is never a send for another key", () => {
		assert.equal(isSendChord(key({ key: "a" }), "enter"), false);
		assert.equal(isSendChord(key({ key: "Tab", shiftKey: true }), "shiftEnter"), false);
	});
});

describe("send mode values", () => {
	it("accepts exactly the two modes", () => {
		assert.equal(isChatSendWith("enter"), true);
		assert.equal(isChatSendWith("shiftEnter"), true);
		assert.equal(isChatSendWith("Enter"), false);
		assert.equal(isChatSendWith(undefined), false);
	});

	it("labels the key in use", () => {
		assert.deepEqual(SEND_KEY_LABELS.enter, { send: "Enter", newline: "Shift+Enter", queue: "Alt+Enter" });
		assert.deepEqual(SEND_KEY_LABELS.shiftEnter, { send: "Shift+Enter", newline: "Enter", queue: "Alt+Shift+Enter" });
	});
});
