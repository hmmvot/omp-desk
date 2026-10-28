import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { recordingLogger, type LoggedLine } from "../shared/logger.ts";
import { HelperCancelledError, HelperScheduler, isHelperCancelled, type HelperClass, type HelperSchedulerOptions, type HelperSlotLease, type HelperSlots } from "./helper-scheduler.ts";

/** Lets every pending microtask and the immediate queue run. */
const settle = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

interface Job {
	readonly name: string;
	started: boolean;
	aborted: boolean;
	finish(value?: string): void;
	fail(error: Error): void;
	readonly spec: { label: string; class: HelperClass; key?: string; run(signal: AbortSignal): Promise<string> };
}

/** A job that starts when the scheduler runs it and ends when the test says so. */
function job(name: string, cls: HelperClass, key?: string): Job {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	const state: Job = {
		name, started: false, aborted: false, finish: value => resolve(value ?? name), fail: error => reject(error),
		spec: {
			label: name, class: cls, ...(key === undefined ? {} : { key }),
			run(signal) {
				state.started = true;
				signal.addEventListener("abort", () => { state.aborted = true; reject(new Error(`${name} aborted`)); }, { once: true });
				return promise;
			},
		},
	};
	return state;
}

function rig(options: Partial<HelperSchedulerOptions> & { open?: boolean } = {}) {
	const gate = Promise.withResolvers<void>();
	const settleHold = { release: null as null | (() => void) };
	const lines: LoggedLine[] = [];
	const scheduler = new HelperScheduler({
		log: recordingLogger(lines),
		backgroundGate: gate.promise,
		backgroundSettleMs: 5,
		// The settle delay is controllable: it ends when `settleHold.release` is called, or at once when the scheduler is disposed.
		sleep: (_ms, signal) => {
			const { promise, resolve } = Promise.withResolvers<void>();
			settleHold.release = resolve;
			signal.addEventListener("abort", () => resolve(), { once: true });
			return promise;
		},
		...options,
	});
	const openGate = async (): Promise<void> => { gate.resolve(); await settle(); settleHold.release?.(); await settle(); };
	return { scheduler, lines, openGate, gate };
}

describe("HelperScheduler concurrency", () => {
	it("runs at most maxConcurrent helpers of this window at once and starts the next as one ends", async () => {
		const { scheduler } = rig({ maxConcurrent: 2 });
		const jobs = [job("a", "visible"), job("b", "visible"), job("c", "visible"), job("d", "visible")];
		const results = jobs.map(entry => scheduler.run(entry.spec));
		await settle();
		assert.deepEqual(jobs.map(entry => entry.started), [true, true, false, false]);
		jobs[0]!.finish();
		await settle();
		assert.deepEqual(jobs.map(entry => entry.started), [true, true, true, false]);
		jobs[1]!.finish(); jobs[2]!.finish(); jobs[3]!.finish();
		assert.deepEqual(await Promise.all(results), ["a", "b", "c", "d"]);
		assert.equal(scheduler.stats().peakRunning, 2);
		assert.deepEqual(scheduler.stats().started, { visible: 4, background: 0 });
	});

	it("keeps headroom for visible work: at most maxBackground background helpers run, whatever the bound", async () => {
		const { scheduler, openGate } = rig({ maxConcurrent: 2, maxBackground: 1 });
		await openGate();
		const background = [job("bg1", "background"), job("bg2", "background"), job("bg3", "background")];
		const visible = job("shown", "visible");
		const all = [...background.map(entry => scheduler.run(entry.spec)), scheduler.run(visible.spec)];
		await settle();
		assert.deepEqual(background.map(entry => entry.started), [true, false, false], "one background helper at a time");
		assert.equal(visible.started, true, "visible work starts beside it");
		background[0]!.finish();
		await settle();
		assert.deepEqual(background.map(entry => entry.started), [true, true, false]);
		visible.finish(); background[1]!.finish();
		await settle();
		background[2]!.finish();
		await Promise.all(all);
		assert.equal(scheduler.stats().peakRunning, 2);
	});

	it("starts queued visible work before queued background work when a slot frees", async () => {
		const { scheduler, openGate } = rig({ maxConcurrent: 1, maxBackground: 1 });
		await openGate();
		const first = job("first", "visible");
		const background = job("background", "background");
		const later = job("later", "visible");
		const results = [first, background, later].map(entry => scheduler.run(entry.spec));
		await settle();
		assert.deepEqual([first.started, background.started, later.started], [true, false, false]);
		first.finish();
		await settle();
		assert.deepEqual([background.started, later.started], [false, true], "the visible job jumped the queue");
		later.finish();
		await settle();
		assert.equal(background.started, true);
		background.finish();
		await Promise.all(results);
	});

	it("a failing job rejects its caller, is counted and does not stop the queue", async () => {
		const { scheduler } = rig({ maxConcurrent: 1 });
		const bad = job("bad", "visible");
		const good = job("good", "visible");
		const failed = scheduler.run(bad.spec);
		const fine = scheduler.run(good.spec);
		await settle();
		bad.fail(new Error("boom"));
		await assert.rejects(failed, /boom/);
		await settle();
		assert.equal(good.started, true);
		good.finish();
		assert.equal(await fine, "good");
		assert.equal(scheduler.stats().failed, 1);
	});
});

describe("HelperScheduler deferral", () => {
	it("holds background work back until the startup restore is over and a settle delay has passed; visible work is never held", async () => {
		const { scheduler, openGate, gate } = rig({ maxConcurrent: 2 });
		const background = job("background", "background");
		const visible = job("visible", "visible");
		const ran = [scheduler.run(background.spec), scheduler.run(visible.spec)];
		await settle();
		assert.equal(visible.started, true, "visible work does not wait for the restore");
		assert.equal(background.started, false, "the restore is not over");
		gate.resolve();
		await settle();
		assert.equal(background.started, false, "the settle delay has not passed");
		await openGate();
		assert.equal(background.started, true);
		visible.finish(); background.finish();
		await Promise.all(ran);
	});

	it("treats a gate that rejects as open, so background work is never lost", async () => {
		const settleHold = { release: null as null | (() => void) };
		const scheduler = new HelperScheduler({
			log: recordingLogger([]), backgroundGate: Promise.reject(new Error("gate failed")), backgroundSettleMs: 1,
			sleep: () => { const { promise, resolve } = Promise.withResolvers<void>(); settleHold.release = resolve; return promise; },
		});
		const background = job("background", "background");
		const ran = scheduler.run(background.spec);
		await settle();
		settleHold.release?.();
		await settle();
		assert.equal(background.started, true);
		background.finish();
		await ran;
	});

	it("logs one summary line when the work has drained after the gate opened, and a line for every helper at debug level", async () => {
		const { scheduler, openGate, lines } = rig({ maxConcurrent: 2 });
		const a = job("a", "visible");
		const b = job("b", "background");
		const ran = [scheduler.run(a.spec), scheduler.run(b.spec)];
		await openGate();
		a.finish(); b.finish();
		await Promise.all(ran);
		await settle();
		const summary = lines.filter(line => line.level === "info");
		assert.equal(summary.length, 1);
		assert.match(summary[0]!.message, /2 started since activation \(1 visible, 1 background\), at most 2 at once/);
		assert.equal(lines.filter(line => line.level === "debug" && /^helper run: /.test(line.message)).length, 2);
		const again = job("again", "visible");
		const second = scheduler.run(again.spec);
		await settle();
		again.finish();
		await second;
		assert.equal(lines.filter(line => line.level === "info").length, 1, "the summary is written once");
	});
});

describe("HelperScheduler sharing", () => {
	it("gives callers of the same key one run and one result", async () => {
		const { scheduler } = rig();
		let runs = 0;
		const { promise, resolve } = Promise.withResolvers<string>();
		const spec = { label: "usage", class: "visible" as const, key: "usage:x", run: () => { runs += 1; return promise; } };
		const first = scheduler.run(spec);
		const second = scheduler.run(spec);
		resolve("answer");
		assert.deepEqual(await Promise.all([first, second]), ["answer", "answer"]);
		assert.equal(runs, 1);
		const third = scheduler.run({ ...spec, run: async () => { runs += 1; return "next"; } });
		assert.equal(await third, "next", "once a run has ended its key is free again");
		assert.equal(runs, 2);
	});

	it("a visible caller of a queued background run promotes it ahead of the restore", async () => {
		const { scheduler } = rig({ maxConcurrent: 2 });
		const waiting = job("usage", "background", "usage:x");
		const first = scheduler.run(waiting.spec);
		await settle();
		assert.equal(waiting.started, false);
		const second = scheduler.run({ ...waiting.spec, class: "visible" });
		await settle();
		assert.equal(waiting.started, true, "promoted: it no longer waits for the restore");
		waiting.finish("done");
		assert.deepEqual(await Promise.all([first, second]), ["done", "done"]);
		assert.deepEqual(scheduler.stats().started, { visible: 1, background: 0 });
	});

	it("promote(key) moves a queued background run to visible for a caller that only holds the shared promise; a started run is not moved", async () => {
		const { scheduler, openGate } = rig({ maxConcurrent: 2 });
		const waiting = job("usage", "background", "usage:x");
		const ran = scheduler.run(waiting.spec);
		await settle();
		assert.equal(scheduler.promote("usage:unknown"), false);
		assert.equal(scheduler.promote("usage:x"), true);
		await settle();
		assert.equal(waiting.started, true, "promoted before the restore ended");
		assert.equal(scheduler.promote("usage:x"), false, "a run that has started is not moved");
		waiting.finish("done");
		assert.equal(await ran, "done");
		await openGate();
	});

	it("logs a helper that failed with its timing and the kind of error, not its message", async () => {
		const { scheduler, lines } = rig();
		const bad = job("bad", "visible");
		const ran = scheduler.run(bad.spec);
		await settle();
		bad.fail(new TypeError("secret detail"));
		await assert.rejects(ran, /secret detail/);
		const line = lines.find(entry => /^helper run: bad /.test(entry.message));
		assert.ok(line, "the failed run is logged");
		assert.match(line.message, /ended with TypeError/);
		assert.doesNotMatch(line.message, /secret detail/);
	});
});

describe("HelperScheduler cross-window slots", () => {
	function slotRig(acquire: HelperSlots["acquire"]) {
		const events: string[] = [];
		const slots: HelperSlots = { acquire: (signal, maxWaitMs) => { events.push(`acquire ${maxWaitMs}`); return acquire(signal, maxWaitMs); } };
		return { events, slots };
	}
	const lease = (events: string[]): HelperSlotLease => ({ release: async () => { events.push("release"); } });

	it("background work holds a slot while it runs and gives it back on success and on failure; visible work takes none", async () => {
		const { slots, events } = slotRig(async () => lease(events));
		const { scheduler, openGate } = rig({ slots, slotWaitMs: 1234 });
		await openGate();
		const shown = job("shown", "visible");
		const fine = job("fine", "background");
		const broken = job("broken", "background");
		const ran = [scheduler.run(shown.spec), scheduler.run(fine.spec), scheduler.run(broken.spec).catch(error => (error as Error).message)];
		await settle();
		assert.deepEqual(events, ["acquire 1234"], "only the background run asked for a slot");
		fine.finish();
		await settle();
		assert.deepEqual(events, ["acquire 1234", "release", "acquire 1234"]);
		broken.fail(new Error("exit 1"));
		shown.finish();
		assert.deepEqual((await Promise.all(ran)).slice(2), ["exit 1"]);
		await settle();
		assert.deepEqual(events, ["acquire 1234", "release", "acquire 1234", "release"]);
	});

	it("runs the job without a slot when none is free or the slots fail, and counts the wait", async () => {
		const none = slotRig(async () => null);
		const throwing = slotRig(async () => { throw new Error("slot files unusable"); });
		for (const { slots } of [none, throwing]) {
			const { scheduler, openGate } = rig({ slots });
			await openGate();
			const background = job("background", "background");
			const ran = scheduler.run(background.spec);
			await settle();
			assert.equal(background.started, true, "a throttle never refuses the work");
			background.finish();
			await ran;
		}
	});

	it("a run that waits for a slot counts as running, so a window never holds more than its bound while it waits", async () => {
		const { promise: slotFree, resolve: freeSlot } = Promise.withResolvers<HelperSlotLease | null>();
		const { slots, events } = slotRig(() => slotFree);
		const { scheduler, openGate } = rig({ slots, maxConcurrent: 2, maxBackground: 1 });
		await openGate();
		const first = job("first", "background");
		const second = job("second", "background");
		const ran = [scheduler.run(first.spec), scheduler.run(second.spec)];
		await settle();
		assert.deepEqual([first.started, second.started], [false, false]);
		assert.equal(events.length, 1, "the second run waits in this window's queue, not in the slot files");
		freeSlot(lease(events));
		await settle();
		assert.equal(first.started, true);
		first.finish();
		await settle();
		second.finish();
		await Promise.all(ran);
	});
});

describe("HelperScheduler dispose", () => {
	it("rejects queued work, aborts and frees running work, and starts nothing afterwards", async () => {
		const { scheduler, openGate } = rig({ maxConcurrent: 1 });
		const running = job("running", "visible");
		const queued = job("queued", "visible");
		const background = job("background", "background");
		const ran = scheduler.run(running.spec);
		const wasQueued = scheduler.run(queued.spec);
		const wasBackground = scheduler.run(background.spec);
		await settle();
		assert.equal(running.started, true);
		scheduler.dispose();
		assert.equal(running.aborted, true, "the running job was told to end its process");
		for (const outcome of [ran, wasQueued, wasBackground]) {
			await assert.rejects(outcome, (error: unknown) => isHelperCancelled(error) && error instanceof HelperCancelledError);
		}
		assert.equal(queued.started, false);
		await openGate();
		assert.equal(background.started, false, "the gate opening after dispose starts nothing");
		await assert.rejects(scheduler.run(job("late", "visible").spec), HelperCancelledError);
		assert.equal(scheduler.stats().failed, 0, "a cancellation is not a failure of the helper");
	});

	it("frees a caller at once even when the job ignores the signal, and ignores the job's late result", async () => {
		const { scheduler } = rig();
		const { promise, resolve } = Promise.withResolvers<string>();
		const stubborn = scheduler.run({ label: "stubborn", class: "visible", run: () => promise });
		await settle();
		scheduler.dispose();
		await assert.rejects(stubborn, HelperCancelledError);
		resolve("late");
		await settle();
	});

	it("ends a background run that is waiting for a cross-window slot without running it", async () => {
		let seen: AbortSignal | null = null;
		const slots: HelperSlots = { acquire: signal => new Promise(resolve => { seen = signal; signal.addEventListener("abort", () => resolve(null), { once: true }); }) };
		const { scheduler, openGate } = rig({ slots });
		await openGate();
		const background = job("background", "background");
		const ran = scheduler.run(background.spec);
		await settle();
		assert.ok(seen, "the run is waiting for a slot");
		scheduler.dispose();
		await assert.rejects(ran, HelperCancelledError);
		await settle();
		assert.equal(background.started, false);
	});

	it("dispose is idempotent", () => {
		const { scheduler } = rig();
		scheduler.dispose();
		scheduler.dispose();
	});
});
