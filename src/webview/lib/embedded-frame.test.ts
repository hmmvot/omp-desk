import assert from "node:assert/strict";
import { test } from "node:test";
import { isFromEmbeddedFrame } from "./embedded-frame.ts";

/** A window of a frame tree: `parent` is itself at the top, as `window.parent` is. */
function windowOf(parent?: Window): Window {
	const self = { } as { parent: Window };
	self.parent = parent ?? (self as unknown as Window);
	return self as unknown as Window;
}

test("a message the page sent itself, or with no window, is not a frame's", () => {
	const self = windowOf(windowOf());
	assert.equal(isFromEmbeddedFrame(null, self), false);
	assert.equal(isFromEmbeddedFrame(undefined, self), false);
	assert.equal(isFromEmbeddedFrame(self, self), false);
});

test("the host page, an ancestor of this window, is not a frame", () => {
	const workbench = windowOf();
	const host = windowOf(workbench);
	const self = windowOf(host);
	assert.equal(isFromEmbeddedFrame(host, self), false);
	assert.equal(isFromEmbeddedFrame(workbench, self), false);
});

test("a frame of this page, and a frame inside that frame, are frames", () => {
	const self = windowOf(windowOf(windowOf()));
	const frame = windowOf(self);
	const nested = windowOf(windowOf(frame));
	assert.equal(isFromEmbeddedFrame(frame, self), true);
	assert.equal(isFromEmbeddedFrame(nested, self), true);
});

test("an unrelated window is not this page's frame", () => {
	assert.equal(isFromEmbeddedFrame(windowOf(windowOf()), windowOf(windowOf())), false);
});

test("a message port or a worker is not a window", () => {
	assert.equal(isFromEmbeddedFrame({ postMessage() {} } as unknown as MessagePort, windowOf()), false);
});

test("a window whose ancestry cannot be read is refused", () => {
	const self = windowOf();
	const hostile = { get parent(): never { throw new Error("blocked"); } } as unknown as Window;
	assert.equal(isFromEmbeddedFrame(hostile, self), true);
});
