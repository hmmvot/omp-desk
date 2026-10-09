import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { focusWhenPossible } from "./focus-retry.ts";

/** A fake document: one textarea that takes focus only once `ready`, and a manual timer queue. */
function fixture() {
	const state = { ready: false, focused: null as unknown, mounted: true, tries: 0 };
	const textarea = { focus() { state.tries++; if (state.ready) state.focused = textarea; } };
	const timers: Array<() => void> = [];
	const options = {
		element: () => (state.mounted ? textarea : null),
		active: () => state.focused,
		idle: (active: unknown) => active === null,
		schedule: (callback: () => void) => { timers.push(callback); },
	};
	const flush = () => { while (timers.length > 0) timers.shift()!(); };
	return { state, textarea, options, timers, flush };
}

describe("focusing the composer when a host command asks", () => {
	it("focuses at once and schedules nothing when the textarea can take focus", () => {
		const f = fixture();
		f.state.ready = true;
		assert.equal(focusWhenPossible(f.options), true);
		assert.equal(f.state.focused, f.textarea);
		assert.equal(f.timers.length, 0);
	});

	it("keeps trying while the textarea is hidden or disabled, then lands once it can", () => {
		const f = fixture();
		assert.equal(focusWhenPossible(f.options), false);
		assert.equal(f.timers.length, 1);
		f.timers.shift()!();
		f.state.ready = true;
		f.flush();
		assert.equal(f.state.focused, f.textarea);
		assert.equal(f.state.tries, 3);
	});

	it("gives up after the attempts, and leaves an element the user focused meanwhile alone", () => {
		const f = fixture();
		focusWhenPossible({ ...f.options, attempts: 3 });
		f.flush();
		assert.equal(f.state.tries, 3);

		const g = fixture();
		focusWhenPossible(g.options);
		g.state.focused = { other: true };
		g.flush();
		assert.equal(g.state.tries, 1, "the user's own choice is not taken back");
	});

	it("does nothing when the composer is not mounted", () => {
		const f = fixture();
		f.state.mounted = false;
		assert.equal(focusWhenPossible(f.options), true);
		assert.equal(f.timers.length, 0);
	});
});
