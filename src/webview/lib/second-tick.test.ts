import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SECOND_TICK_MS, SecondTicker, type SecondTickEnv } from "./second-tick.ts";

/** A page with a manual interval and a visibility switch. */
function page(): { env: SecondTickEnv; fire(): void; show(shown: boolean): void; intervals: () => number; watchers: () => number } {
	let shown = true;
	let next = 0;
	const timers = new Map<number, () => void>();
	const watchers = new Set<() => void>();
	return {
		env: {
			setInterval(callback, ms) { assert.equal(ms, SECOND_TICK_MS); timers.set(++next, callback); return next; },
			clearInterval(handle) { timers.delete(handle as number); },
			shown: () => shown,
			onShownChange(listener) { watchers.add(listener); return () => { watchers.delete(listener); }; },
		},
		fire() { for (const callback of [...timers.values()]) callback(); },
		show(value) { shown = value; for (const listener of [...watchers]) listener(); },
		intervals: () => timers.size,
		watchers: () => watchers.size,
	};
}

describe("the page's shared second tick", () => {
	it("runs one interval for any number of subscribers, only while one is subscribed", () => {
		const fake = page();
		const ticker = new SecondTicker(fake.env);
		assert.equal(fake.intervals(), 0);
		let a = 0; let b = 0;
		const stopA = ticker.subscribe(() => { a++; });
		const stopB = ticker.subscribe(() => { b++; });
		assert.equal(fake.intervals(), 1);
		fake.fire();
		assert.deepEqual([a, b], [1, 1]);
		stopA();
		assert.equal(fake.intervals(), 1);
		stopB();
		assert.equal(fake.intervals(), 0);
		assert.equal(fake.watchers(), 0, "the visibility listener goes with the last subscriber");
	});

	it("stops the interval while the page is hidden and ticks once at once when it is shown again", () => {
		const fake = page();
		const ticker = new SecondTicker(fake.env);
		let ticks = 0;
		ticker.subscribe(() => { ticks++; });
		fake.show(false);
		assert.equal(fake.intervals(), 0, "a hidden page keeps no timer for its clocks");
		fake.fire();
		assert.equal(ticks, 0);
		fake.show(true);
		assert.equal(ticks, 1, "shown again, the clocks catch up without waiting a second");
		assert.equal(fake.intervals(), 1);
		fake.fire();
		assert.equal(ticks, 2);
	});

	it("starts no interval for a subscriber that arrives while the page is hidden, and starts it when the page is shown", () => {
		const fake = page();
		fake.show(false);
		const ticker = new SecondTicker(fake.env);
		let ticks = 0;
		const stop = ticker.subscribe(() => { ticks++; });
		assert.equal(fake.intervals(), 0);
		fake.show(true);
		assert.equal(ticks, 1);
		assert.equal(fake.intervals(), 1);
		stop();
		assert.equal(fake.intervals(), 0);
	});

	it("lets a subscriber leave from inside a tick", () => {
		const fake = page();
		const ticker = new SecondTicker(fake.env);
		let other = 0;
		const stopFirst = ticker.subscribe(() => { stopFirst(); });
		ticker.subscribe(() => { other++; });
		fake.fire();
		fake.fire();
		assert.equal(other, 2);
	});
});
