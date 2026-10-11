import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FRAME_BLUR_PAIR_MS, FRAME_REFOCUS_MS, FrameFocusRestorer } from "./frame-focus.ts";

function fixture() {
	const clock = { now: 1_000 };
	const restorer = new FrameFocusRestorer(() => clock.now);
	const composer = { name: "composer" };
	return { clock, restorer, composer };
}

describe("restoring the focus VS Code takes by refocusing the webview", () => {
	it("gives the composer back when its frame lost the focus in the same task and regained it at once", () => {
		const f = fixture();
		f.restorer.focusOut(f.composer, false);
		f.restorer.windowBlur(true);
		f.clock.now += 60;
		assert.equal(f.restorer.windowFocus(true), f.composer);
		assert.equal(f.restorer.windowFocus(true), null, "one loss restores once");
	});

	it("leaves the page alone when the operating system deactivated the window", () => {
		const f = fixture();
		// The element keeps `document.activeElement` while the window is deactivated, and Chromium restores it itself.
		f.restorer.windowBlur(false);
		f.clock.now += 60;
		assert.equal(f.restorer.windowFocus(true), null);
		const g = fixture();
		g.restorer.focusOut(g.composer, false);
		g.restorer.windowBlur(false);
		assert.equal(g.restorer.windowFocus(true), null);
	});

	it("does not take focus back from an element the user moved it to", () => {
		const f = fixture();
		f.restorer.focusOut(f.composer, true);
		f.restorer.windowBlur(true);
		assert.equal(f.restorer.windowFocus(true), null, "focus moved to another element");
		const g = fixture();
		g.restorer.focusOut(g.composer, false);
		g.restorer.windowBlur(true);
		assert.equal(g.restorer.windowFocus(false), null, "something holds focus when the window returns");
	});

	it("does not treat a long absence as a refocus", () => {
		const f = fixture();
		f.restorer.focusOut(f.composer, false);
		f.restorer.windowBlur(true);
		f.clock.now += FRAME_REFOCUS_MS + 1;
		assert.equal(f.restorer.windowFocus(true), null, "the user left and came back later");
		const g = fixture();
		g.restorer.focusOut(g.composer, false);
		g.clock.now += FRAME_BLUR_PAIR_MS + 1;
		g.restorer.windowBlur(true);
		g.clock.now += 10;
		assert.equal(g.restorer.windowFocus(true), null, "an element blurred long before the window did");
	});

	it("forgets a blur that no element lost focus for", () => {
		const f = fixture();
		f.restorer.focusOut(null, false);
		f.restorer.windowBlur(true);
		assert.equal(f.restorer.windowFocus(true), null);
	});
});
