/**
 * The helper processes of a four-window reload, before and after the helper scheduler (ADR-0084), as a model on a virtual clock:
 * real scheduler instances, an in-memory stand-in for the cross-window slot files (the real ones are covered by
 * `helper-slots.test.ts`), and no process. A helper "runs" for a fixed virtual time and the model records when it started. The
 * numbers are the model's, not a measurement of the extension; what they show is the shape of the load: how many helpers ran at
 * once, and how long after the end of the restore the first deferred one started.
 *
 * "Before" is the logic this change replaced, transcribed: every restored tab asks for its provider usage and for the default
 * catalogue the moment it goes live, and a catalogue request that arrives while a read runs asks for one more read afterwards.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { silentLogger } from "../shared/logger.ts";
import { HelperScheduler, type HelperClass, type HelperSlots } from "./helper-scheduler.ts";

const WINDOWS = 4;
const TABS_PER_WINDOW = 6;
/** Virtual milliseconds: one helper run, and the gap between two tabs of a window reaching their live state. */
const RUN_MS = 400;
const LIVE_GAP_MS = 120;
const SETTLE_MS = 150;
const CROSS_WINDOW_SLOTS = 2;

const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

/** A virtual clock: `sleep` ends when `advance` moves time past it, so the model takes no real time and cannot flake. */
class Clock {
	now = 0;
	readonly #timers: { at: number; order: number; resolve(): void }[] = [];
	#order = 0;
	sleep(ms: number, signal?: AbortSignal): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		if (signal?.aborted) { resolve(); return promise; }
		this.#timers.push({ at: this.now + ms, order: this.#order++, resolve });
		signal?.addEventListener("abort", () => resolve(), { once: true });
		return promise;
	}
	/** Moves to the earliest timer and fires it; `false` when none is pending. */
	advance(): boolean {
		this.#timers.sort((a, b) => a.at - b.at || a.order - b.order);
		const next = this.#timers.shift();
		if (next === undefined) return false;
		this.now = Math.max(this.now, next.at);
		next.resolve();
		return true;
	}
}

/** Runs the virtual clock until `scenario` settles. */
async function drive(clock: Clock, scenario: Promise<unknown>): Promise<void> {
	let finished = false;
	void scenario.then(() => { finished = true; }, () => { finished = true; });
	for (let idle = 0; !finished;) {
		await flush();
		if (finished) break;
		if (clock.advance()) idle = 0;
		else if (++idle > 3) throw new Error("the model stalled: nothing is pending and the scenario has not finished");
	}
	await scenario;
}

/** What every window's helpers did, on one clock. */
class Ledger {
	running = 0;
	peak = 0;
	runs = 0;
	readonly starts: { readonly at: number; readonly window: number; readonly label: string; readonly cls: HelperClass | "unscheduled" }[] = [];
	readonly clock: Clock;
	constructor(clock: Clock) { this.clock = clock; }
	async run(window: number, label: string, cls: HelperClass | "unscheduled"): Promise<void> {
		this.running += 1;
		this.runs += 1;
		this.peak = Math.max(this.peak, this.running);
		this.starts.push({ at: this.clock.now, window, label, cls });
		await this.clock.sleep(RUN_MS);
		this.running -= 1;
	}
}

/** The old code: usage per tab at once; the catalogue read repeats once for every request that arrived during a read. */
async function reloadBefore(ledger: Ledger, window: number): Promise<void> {
	let reading: Promise<void> | null = null;
	let dirty = false;
	const readCatalogue = (): Promise<void> => {
		dirty = true;
		if (reading !== null) return reading;
		reading = (async () => { do { dirty = false; await ledger.run(window, "models", "unscheduled"); } while (dirty); })().finally(() => { reading = null; });
		return reading;
	};
	void readCatalogue();
	const tabs: Promise<void>[] = [];
	for (let tab = 0; tab < TABS_PER_WINDOW; tab += 1) {
		await ledger.clock.sleep(LIVE_GAP_MS);
		tabs.push(ledger.run(window, `usage ${tab}`, "unscheduled"), readCatalogue());
	}
	await Promise.all(tabs);
}

/** The cross-window slot files, as one in-memory semaphore the windows share. */
function sharedSlots(count: number): HelperSlots {
	let free = count;
	const waiting: (() => void)[] = [];
	const give = (): void => { const next = waiting.shift(); if (next === undefined) free += 1; else next(); };
	return {
		async acquire() {
			if (free > 0) free -= 1;
			else await new Promise<void>(resolve => waiting.push(resolve));
			return { release: async () => give() };
		},
	};
}

/** The new code: the same requests through the window's scheduler, gated like the extension's by the end of the window's restore. */
async function reloadAfter(ledger: Ledger, window: number, slots: HelperSlots): Promise<number> {
	const restoreOver = Promise.withResolvers<void>();
	const scheduler = new HelperScheduler({
		log: silentLogger, backgroundGate: restoreOver.promise, backgroundSettleMs: SETTLE_MS, slots,
		now: () => ledger.clock.now, sleep: (ms, signal) => ledger.clock.sleep(ms, signal),
	});
	let reading: Promise<void> | null = null;
	let available: boolean | null = null;
	const readCatalogue = (): Promise<void> => {
		if (reading !== null) return reading;
		reading = scheduler.run({ label: "models", class: "background", key: "models:default", run: () => ledger.run(window, "models", "background").then(() => { available = true; }) })
			.finally(() => { reading = null; });
		return reading;
	};
	void readCatalogue();
	const tabs: Promise<unknown>[] = [];
	for (let tab = 0; tab < TABS_PER_WINDOW; tab += 1) {
		await ledger.clock.sleep(LIVE_GAP_MS);
		const cls: HelperClass = tab === 0 ? "visible" : "background";
		tabs.push(scheduler.run({ label: `usage ${tab}`, class: cls, key: `usage:${tab}`, run: () => ledger.run(window, `usage ${tab}`, cls) }));
		// A session's first look asks for the catalogue only while it was never read, and then joins the queued read.
		if (available === null) tabs.push(readCatalogue());
	}
	const restoreEndedAt = ledger.clock.now;
	restoreOver.resolve();
	await Promise.all(tabs);
	scheduler.dispose();
	return restoreEndedAt;
}

async function modelBefore(): Promise<Ledger> {
	const clock = new Clock();
	const ledger = new Ledger(clock);
	await drive(clock, Promise.all(Array.from({ length: WINDOWS }, (_, window) => reloadBefore(ledger, window))));
	return ledger;
}

async function modelAfter(): Promise<{ readonly ledger: Ledger; readonly firstRestoreEnd: number }> {
	const clock = new Clock();
	const ledger = new Ledger(clock);
	const slots = sharedSlots(CROSS_WINDOW_SLOTS);
	const ends = await (async () => {
		const all = Promise.all(Array.from({ length: WINDOWS }, (_, window) => reloadAfter(ledger, window, slots)));
		await drive(clock, all);
		return all;
	})();
	return { ledger, firstRestoreEnd: Math.min(...ends) };
}

describe(`a reload of ${WINDOWS} windows with ${TABS_PER_WINDOW} restored tabs each`, () => {
	it("before: every helper starts the moment its tab is live, so the windows' helpers pile up", async () => {
		const ledger = await modelBefore();
		assert.ok(ledger.runs >= WINDOWS * (TABS_PER_WINDOW + 1), `a catalogue read and a usage read for each tab, got ${ledger.runs}`);
		assert.ok(ledger.peak >= WINDOWS * 4, `a batch of helpers at once, got a peak of ${ledger.peak}`);
	});

	it("after: bounded at once, and background work starts only after each window's restore", async () => {
		const { ledger, firstRestoreEnd } = await modelAfter();
		// One catalogue read and one usage read for each tab and no more: the first looks joined the queued read.
		assert.equal(ledger.runs, WINDOWS * (TABS_PER_WINDOW + 1));
		// Visible work: one run per window (the active tab's usage); background work: the cross-window slots.
		assert.ok(ledger.peak <= WINDOWS + CROSS_WINDOW_SLOTS, `at most ${WINDOWS + CROSS_WINDOW_SLOTS} helpers at once across all windows, got ${ledger.peak}`);
		const background = ledger.starts.filter(start => start.cls === "background");
		assert.equal(background.length, WINDOWS * TABS_PER_WINDOW, "every other tab's usage and the catalogue read ran as background work");
		for (const start of background) {
			assert.ok(start.at >= firstRestoreEnd + SETTLE_MS, `a background helper started at +${start.at} ms, before the first restore ended at +${firstRestoreEnd} ms and settled`);
		}
		// What the first view needs is not held back: the active tab's usage starts the moment the tab is live.
		const visible = ledger.starts.filter(start => start.cls === "visible");
		assert.equal(visible.length, WINDOWS);
		assert.deepEqual(new Set(visible.map(start => start.at)), new Set([LIVE_GAP_MS]));
	});

	it("after: the model has a far smaller peak than before, with no more helpers", async t => {
		const before = await modelBefore();
		const { ledger: after, firstRestoreEnd } = await modelAfter();
		const lastStart = (ledger: Ledger): number => Math.max(...ledger.starts.map(start => start.at));
		t.diagnostic(`model, virtual ms: before ${before.runs} helpers, peak ${before.peak} at once, last start +${lastStart(before)}; after ${after.runs} helpers, peak ${after.peak} at once, first restore ended +${firstRestoreEnd}, last start +${lastStart(after)}`);
		assert.ok(after.peak <= before.peak / 3, `peak ${after.peak} after against ${before.peak} before`);
		assert.ok(after.runs <= before.runs, `${after.runs} helpers after against ${before.runs} before`);
	});
});
