import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	DORMANT_TICK_MS, FRAME_STALE_MS, PageMotion, PROGRESS_PROPERTY, SPIN_PERIOD_MS, SPIN_PROPERTY, SPIN_STEP_MS, SPIN_STEPS, SWEEP_PROPERTY, SWEEP_STEP_MS, SWEEP_STEPS,
	type MotionHost, type MotionTarget,
} from "./page-motion.ts";

class Glyph implements MotionTarget {
	readonly values = new Map<string, string>();
	writes = 0;
	/** Throws from the next `setProperty` calls, as a glyph the page took apart would. */
	failures = 0;
	/** Called with the property after every successful write. */
	onWrite: ((name: string, value: string) => void) | undefined;
	setProperty(name: string, value: string): void {
		if (this.failures > 0) { this.failures--; throw new Error("the element is gone"); }
		this.values.set(name, value); this.writes++;
		this.onWrite?.(name, value);
	}
}

/**
 * A page with a manual clock; timers that can run late (a busy page); animation frames that come `frameDelay` after they are asked for while
 * the page is drawn and never while it is not (a Chat tab behind another one, which keeps its timers and reports itself visible); glyphs;
 * and the browser's reports of the page being hidden or the reader asking for reduced motion.
 */
class FakePage {
	readonly state = { now: 0, hidden: false, reduced: false, drawn: true, lateness: (_due: number) => 0, frameDelay: (_asked: number) => 16 };
	readonly glyphs = { spinners: [] as Glyph[], sweeps: [] as Glyph[], bars: [] as Glyph[] };
	readonly #timers = new Map<number, { due: number; callback: () => void }>();
	readonly #frames = new Map<number, { asked: number; callback: () => void }>();
	readonly #present = new Set<() => void>();
	readonly #wake = new Set<() => void>();
	#next = 0;
	#drawnSince = 0;
	/** Timer callbacks run so far. */
	wakes = 0;
	/** Frames asked for so far. */
	framesAsked = 0;
	readonly host: MotionHost = {
		now: () => this.state.now,
		later: (callback, ms) => { const id = ++this.#next; this.#timers.set(id, { due: this.state.now + ms, callback }); return id; },
		cancelLater: handle => { this.#timers.delete(handle as number); },
		frame: callback => { const id = ++this.#next; this.framesAsked++; this.#frames.set(id, { asked: this.state.now, callback }); return id; },
		cancelFrame: handle => { this.#frames.delete(handle as number); },
		reduced: () => this.state.reduced,
		hidden: () => this.state.hidden,
		spinners: () => this.glyphs.spinners,
		sweeps: () => this.glyphs.sweeps,
		bars: () => this.glyphs.bars,
		onPresent: listener => { this.#present.add(listener); return () => { this.#present.delete(listener); }; },
		onWake: listener => { this.#wake.add(listener); return () => { this.#wake.delete(listener); }; },
	};

	/** A glyph appears: its animationstart reaches the module. */
	announce(): void { for (const listener of [...this.#present]) listener(); }
	/** The page is shown, focused or restored. */
	wake(): void { for (const listener of [...this.#wake]) listener(); }
	/** The page is drawn again (or not any more): frames asked for from now on come (or never). */
	draw(drawn: boolean): void { this.state.drawn = drawn; if (drawn) this.#drawnSince = this.state.now; }
	timers(): number { return this.#timers.size; }
	frames(): number { return this.#frames.size; }
	listeners(): number { return this.#present.size + this.#wake.size; }

	/** Runs the clock forward `ms`, firing timers when they are due (plus the lateness of a busy page) and frames when they come. */
	run(ms: number): void {
		const end = this.state.now + ms;
		for (;;) {
			let next: { kind: "timer" | "frame"; id: number; at: number } | undefined;
			for (const [id, timer] of this.#timers) {
				const at = timer.due + this.state.lateness(timer.due);
				if (next === undefined || at < next.at) next = { kind: "timer", id, at };
			}
			if (this.state.drawn) {
				for (const [id, frame] of this.#frames) {
					const at = Math.max(frame.asked + this.state.frameDelay(frame.asked), this.#drawnSince);
					if (next === undefined || at < next.at) next = { kind: "frame", id, at };
				}
			}
			if (next === undefined || next.at > end) break;
			this.state.now = Math.max(this.state.now, next.at);
			if (next.kind === "timer") {
				const timer = this.#timers.get(next.id)!;
				this.#timers.delete(next.id);
				this.wakes++;
				timer.callback();
			} else {
				const frame = this.#frames.get(next.id)!;
				this.#frames.delete(next.id);
				frame.callback();
			}
		}
		this.state.now = end;
	}
}

/** Records the time of every change of a glyph's spin angle. */
function recordSteps(page: FakePage, glyph: Glyph): number[] {
	const times: number[] = [];
	let last = "";
	glyph.onWrite = (name, value) => {
		if (name === SPIN_PROPERTY && value !== last) { last = value; times.push(page.state.now); }
	};
	return times;
}

const angleAt = (now: number): string => `${Math.floor(now / SPIN_STEP_MS) % SPIN_STEPS * (360 / SPIN_STEPS)}deg`;

describe("the page's moving glyphs", () => {
	it("has no timer and no frame on a page where nothing moves, and none after the last glyph is gone", () => {
		const page = new FakePage();
		const motion = new PageMotion(page.host);
		motion.start();
		assert.equal(page.timers(), 0);
		page.run(10_000);
		assert.equal(page.wakes, 0);
		assert.equal(page.framesAsked, 0);
		const glyph = new Glyph();
		page.glyphs.spinners.push(glyph);
		page.announce();
		assert.equal(motion.running, true);
		page.run(500);
		page.glyphs.spinners.length = 0;
		page.run(200);
		assert.equal(motion.running, false, "the first step that finds nothing to move stops the timer");
		assert.equal(page.timers(), 0);
		assert.equal(page.frames(), 0);
		const wakes = page.wakes;
		page.run(10_000);
		assert.equal(page.wakes, wakes);
	});

	it("paints a glyph that appears at once, with the position of the moment, and starts the timer", () => {
		const page = new FakePage();
		new PageMotion(page.host).start();
		page.state.now = 3 * SPIN_STEP_MS + 10;
		const glyph = new Glyph();
		page.glyphs.spinners.push(glyph);
		page.announce();
		assert.equal(glyph.values.get(SPIN_PROPERTY), "135deg");
		assert.equal(page.timers(), 1);
	});

	it("turns a spinner in eight steps a second, each step the same length", () => {
		const page = new FakePage();
		new PageMotion(page.host).start();
		const glyph = new Glyph();
		page.glyphs.spinners.push(glyph);
		const times = recordSteps(page, glyph);
		page.announce();
		page.run(5_010);
		assert.equal(times.length, 1 + 40, "the paint at once, then 8 steps a second (the one due at 5 s included)");
		const gaps = times.slice(1).map((time, index) => time - times[index]!);
		for (const gap of gaps.slice(1)) assert.ok(Math.abs(gap - SPIN_STEP_MS) <= 2, `a step came ${gap} ms after the one before it, not ${SPIN_STEP_MS}`);
		assert.equal(new Set(gaps.slice(1).map(gap => Math.round(gap))).size, 1, "the steps are evenly spaced: the old loop's came 100 and 200 ms apart");
		assert.equal(glyph.values.get(SPIN_PROPERTY), angleAt(page.state.now));
	});

	it("moves the working row's glyph on the spinner's grid and its sweep and the bar on theirs, nothing written twice", () => {
		const page = new FakePage();
		new PageMotion(page.host).start();
		const status = new Glyph();
		const bar = new Glyph();
		page.glyphs.sweeps.push(status);
		page.glyphs.bars.push(bar);
		const spinTimes: number[] = [];
		const sweepTimes: number[] = [];
		let lastSpin = "";
		let lastSweep = "";
		status.onWrite = (name, value) => {
			if (name === SPIN_PROPERTY && value !== lastSpin) { lastSpin = value; spinTimes.push(page.state.now); }
			if (name === SWEEP_PROPERTY && value !== lastSweep) { lastSweep = value; sweepTimes.push(page.state.now); }
		};
		page.announce();
		page.run(4_000);
		for (const gap of spinTimes.slice(2).map((time, index) => time - spinTimes[index + 1]!)) assert.ok(Math.abs(gap - SPIN_STEP_MS) <= 2, `the working row's glyph stepped after ${gap} ms`);
		for (const gap of sweepTimes.slice(2).map((time, index) => time - sweepTimes[index + 1]!)) assert.ok(Math.abs(gap - SWEEP_STEP_MS) <= 2, `the sweep stepped after ${gap} ms`);
		assert.equal(spinTimes.length, 1 + 31);
		assert.equal(sweepTimes.length, 1 + 47);
		assert.equal(bar.writes, 1 + 47, "the bar is written once per step of its own");
		assert.equal(bar.values.get(PROGRESS_PROPERTY), String(Math.floor((page.state.now - 1) / SWEEP_STEP_MS) % SWEEP_STEPS / SWEEP_STEPS));
		assert.ok(page.wakes <= 4 * 20 + 2, `${page.wakes} timer wake-ups in four seconds: the two grids share their boundaries`);
	});

	it("turns at its nominal rate on a busy page: timers 25 ms late on average and up to 200 ms late, frames 50 ms apart or more", () => {
		// The Chat page with a long transcript, measured in VS Code while a turn streamed: the main thread was busy a quarter of the time,
		// the working row's glyph stepped 5.6 times a second, its timers ran 25 ms late at the median, 84 at the 95th percentile and 114 at most,
		// and animation frames came 50 ms apart at the median (up to 184). The loop of the first version (a timer, then a frame, then the
		// next timer) needed both and turned at that rate; this one only reads the clock in its timer.
		const page = new FakePage();
		new PageMotion(page.host).start();
		const glyph = new Glyph();
		page.glyphs.spinners.push(glyph);
		const times = recordSteps(page, glyph);
		let seed = 12345;
		const random = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
		page.state.lateness = () => (random() < 0.05 ? 100 + random() * 100 : random() * 50);
		page.state.frameDelay = () => 30 + random() * 154;
		page.announce();
		page.run(30_000);
		const nominal = 30_000 / SPIN_STEP_MS;
		assert.ok(times.length >= nominal * 0.95, `${times.length} steps in 30 s, nominal ${nominal}`);
		const gaps = times.slice(1).map((time, index) => time - times[index]!);
		assert.ok(Math.max(...gaps) <= SPIN_STEP_MS + 200 + 5, `the longest wait between two steps was ${Math.max(...gaps)} ms: a step is at most as late as its timer`);
	});

	it("takes the step the clock reads: a timer that runs late skips the steps it missed instead of drifting behind", () => {
		const page = new FakePage();
		new PageMotion(page.host).start();
		const glyph = new Glyph();
		page.glyphs.spinners.push(glyph);
		const times = recordSteps(page, glyph);
		page.announce();
		page.run(1_000);
		page.state.lateness = due => (due > 1_000 && due < 1_200 ? 400 : 0);
		page.run(1_000);
		page.state.lateness = () => 0;
		page.run(2_010);
		assert.equal(glyph.values.get(SPIN_PROPERTY), angleAt(page.state.now));
		assert.ok(times.filter(time => time > 1_000 && time < 1_800).length <= 5, "the missed steps are not written one after the other");
		const after = times.filter(time => time > 1_800);
		for (const gap of after.slice(1).map((time, index) => time - after[index]!).slice(1)) assert.ok(Math.abs(gap - SPIN_STEP_MS) <= 2, "back on the grid after the late step");
	});

	it("waits for free while the browser reports the page hidden, and goes on at once, at the position of the moment, when it is shown", () => {
		const page = new FakePage();
		const motion = new PageMotion(page.host);
		motion.start();
		const glyph = new Glyph();
		page.glyphs.spinners.push(glyph);
		page.announce();
		page.run(1_000);
		page.state.hidden = true;
		page.run(125);
		assert.equal(motion.running, false, "the first step of a hidden page stops the timer");
		assert.equal(page.frames(), 0);
		const writes = glyph.writes;
		const wakes = page.wakes;
		page.run(30_000);
		assert.equal(glyph.writes, writes);
		assert.equal(page.wakes, wakes, "a hidden page has no timer at all");
		page.state.hidden = false;
		page.wake();
		assert.equal(motion.running, true);
		assert.equal(glyph.values.get(SPIN_PROPERTY), angleAt(page.state.now));
		const again = glyph.writes;
		page.run(1_000);
		assert.ok(glyph.writes >= again + 7, "it turns again");
	});

	it("takes a page that gets no frame as not drawn: it looks once a second, and is back at its own rate with the first frame", () => {
		// A Chat tab behind another one keeps `visibilityState` "visible" and its timers at full rate (measured in VS Code) but is never drawn.
		const page = new FakePage();
		const motion = new PageMotion(page.host);
		motion.start();
		const glyph = new Glyph();
		page.glyphs.spinners.push(glyph);
		const times = recordSteps(page, glyph);
		page.announce();
		page.run(500);
		page.draw(false);
		page.run(FRAME_STALE_MS + SPIN_STEP_MS);
		assert.equal(motion.dormant, true);
		const wakes = page.wakes;
		const dormantWrites = glyph.writes;
		page.run(30_000);
		const looks = Math.ceil(30_000 / DORMANT_TICK_MS) + 1;
		assert.ok(page.wakes - wakes <= looks, `${page.wakes - wakes} timer wake-ups in 30 s of a page that is not drawn: one every ${DORMANT_TICK_MS} ms`);
		assert.ok(page.framesAsked <= looks + 40, "the frame is asked for again once a second, not piled up");
		assert.ok(page.frames() <= 1, "one frame is waiting at a time");
		assert.ok(glyph.writes - dormantWrites >= Math.floor(30_000 / DORMANT_TICK_MS / 2), `${glyph.writes - dormantWrites} writes in 30 s of a page taken as not drawn: it crawls, it does not freeze`);
		const writes = glyph.writes;
		page.draw(true);
		page.run(20);
		assert.equal(motion.dormant, false, "the first frame ends the wait");
		page.run(2_000);
		assert.ok(glyph.writes - writes >= 16, `${glyph.writes - writes} writes in 2 s after the page is drawn again`);
		const lastGaps = times.slice(-8).slice(1).map((time, index) => time - times.slice(-8)[index]!);
		for (const gap of lastGaps) assert.ok(Math.abs(gap - SPIN_STEP_MS) <= 2, "back on the grid");
	});

	it("does not take a page for not drawn that waits for its frames a while: they come late on a busy page", () => {
		const page = new FakePage();
		const motion = new PageMotion(page.host);
		motion.start();
		const glyph = new Glyph();
		page.glyphs.spinners.push(glyph);
		page.state.frameDelay = () => FRAME_STALE_MS - 150;
		page.announce();
		page.run(10_000);
		assert.equal(motion.dormant, false);
		assert.ok(glyph.writes >= 79, `${glyph.writes} writes in 10 s`);
	});

	it("goes on at once when the page is shown or focused while it was taken as not drawn", () => {
		const page = new FakePage();
		const motion = new PageMotion(page.host);
		motion.start();
		const glyph = new Glyph();
		page.glyphs.spinners.push(glyph);
		page.announce();
		page.draw(false);
		page.run(FRAME_STALE_MS + 500);
		assert.equal(motion.dormant, true);
		const writes = glyph.writes;
		page.wake();
		assert.equal(glyph.writes, writes + 1, "written at once, not at the next look");
		assert.equal(glyph.values.get(SPIN_PROPERTY), angleAt(page.state.now));
		assert.equal(motion.dormant, false, "the wake-up ends the wait without waiting for a frame");
		page.run(500);
		assert.ok(glyph.writes - writes >= 4, `${glyph.writes - writes} writes in half a second after the wake-up: its own rate, not one a second`);
		page.run(FRAME_STALE_MS);
		assert.equal(motion.dormant, true, "a page that is still not drawn is taken as such again");
		page.draw(true);
		page.run(100);
		assert.equal(motion.dormant, false);
	});

	it("moves nothing for a reader who asked for reduced motion, and starts again when they do not", () => {
		const page = new FakePage();
		const motion = new PageMotion(page.host);
		motion.start();
		const glyph = new Glyph();
		page.glyphs.spinners.push(glyph);
		page.state.reduced = true;
		page.announce();
		page.run(2_000);
		assert.equal(glyph.writes, 0);
		assert.equal(page.timers(), 0);
		assert.equal(page.frames(), 0);
		assert.equal(motion.running, false);
		page.state.reduced = false;
		page.wake();
		assert.equal(motion.running, true);
		page.run(1_000);
		assert.ok(glyph.writes >= 8);
	});

	it("goes on when a glyph throws while it is written", () => {
		const page = new FakePage();
		const motion = new PageMotion(page.host);
		motion.start();
		const broken = new Glyph();
		const good = new Glyph();
		page.glyphs.spinners.push(broken, good);
		broken.failures = 3;
		assert.throws(() => page.announce(), /element is gone/);
		assert.equal(page.timers(), 1, "the next step is set although the write threw");
		assert.throws(() => page.run(SPIN_STEP_MS + 2), /element is gone/);
		assert.throws(() => page.run(SPIN_STEP_MS + 2), /element is gone/);
		page.run(1_000);
		assert.equal(motion.running, true);
		assert.ok(broken.writes >= 7 && good.writes >= 7, "both glyphs turn again");
	});

	it("takes a long run, with glyphs coming and going, a page hidden, undrawn and shown, and a busy page, as one loop that never stops while a glyph is there", () => {
		const page = new FakePage();
		const motion = new PageMotion(page.host);
		motion.start();
		let seed = 99;
		const random = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
		page.state.lateness = () => (random() < 0.1 ? random() * 150 : 0);
		page.state.frameDelay = () => random() * 120;
		for (let round = 0; round < 3_000; round++) {
			const roll = random();
			if (roll < 0.15) { const glyph = new Glyph(); (roll < 0.05 ? page.glyphs.sweeps : roll < 0.1 ? page.glyphs.spinners : page.glyphs.bars).push(glyph); page.announce(); }
			else if (roll < 0.25) { page.glyphs.spinners.pop(); page.glyphs.sweeps.pop(); page.glyphs.bars.pop(); }
			else if (roll < 0.28) { page.state.hidden = true; }
			else if (roll < 0.33) { page.state.hidden = false; page.wake(); }
			else if (roll < 0.36) { page.draw(false); }
			else if (roll < 0.42) { page.draw(true); }
			page.run(random() * 600);
			if (page.state.hidden) continue;
			const anything = page.glyphs.spinners.length + page.glyphs.sweeps.length + page.glyphs.bars.length > 0;
			page.run(anything ? 300 : DORMANT_TICK_MS + 100);
			if (!anything) {
				assert.equal(page.timers(), 0, `round ${round}: nothing moves and a timer is still set`);
				assert.equal(page.frames(), 0, `round ${round}: nothing moves and a frame is still asked for`);
			} else {
				assert.equal(page.timers(), 1, `round ${round}: a glyph is on screen and no timer is set`);
				assert.ok(page.frames() <= 1, `round ${round}: frames pile up`);
			}
		}
	});

	it("stops listening and cancels its timer and frame when the module is stopped", () => {
		const page = new FakePage();
		const motion = new PageMotion(page.host);
		const stop = motion.start();
		assert.equal(page.listeners(), 2);
		const glyph = new Glyph();
		page.glyphs.spinners.push(glyph);
		page.announce();
		assert.equal(page.timers(), 1);
		assert.equal(page.frames(), 1);
		stop();
		assert.equal(page.listeners(), 0);
		assert.equal(page.timers(), 0);
		assert.equal(page.frames(), 0);
		page.run(5_000);
		assert.equal(glyph.writes, 1);
	});

	it("keeps the spinner's period at a second whatever the step length is", () => {
		assert.equal(SPIN_STEP_MS * SPIN_STEPS, SPIN_PERIOD_MS);
	});
});
