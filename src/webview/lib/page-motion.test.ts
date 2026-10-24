import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	FRAME_STALE_MS, MOTION_FRAME_MS, PageMotion, PROGRESS_PROPERTY, SPIN_PROPERTY, SWEEP_PROPERTY,
	type MotionHost, type MotionTarget,
} from "./page-motion.ts";

class Glyph implements MotionTarget {
	readonly values = new Map<string, string>();
	writes = 0;
	/** Throws from the next `setProperty` calls, as a glyph the page took apart would. */
	failures = 0;
	setProperty(name: string, value: string): void {
		if (this.failures > 0) { this.failures--; throw new Error("the element is gone"); }
		this.values.set(name, value); this.writes++;
	}
}

/** A page with a manual clock, a timer list, animation frames that fire only while the page is drawn (and are lost while it drops them), and glyphs. */
function page() {
	const state = { now: 0, drawn: true, dropFrames: false, reduced: false };
	const timers: { at: number; callback: () => void }[] = [];
	const frames = new Map<number, () => void>();
	let nextFrame = 0;
	const present = new Set<() => void>();
	const wake = new Set<() => void>();
	const glyphs = { spinners: [] as Glyph[], sweeps: [] as Glyph[], bars: [] as Glyph[] };
	const host: MotionHost = {
		now: () => state.now,
		later(callback, ms) { timers.push({ at: state.now + ms, callback }); },
		frame(callback) { const id = ++nextFrame; if (!state.dropFrames) frames.set(id, callback); return id; },
		cancelFrame(handle) { frames.delete(handle as number); },
		reduced: () => state.reduced,
		spinners: () => glyphs.spinners,
		sweeps: () => glyphs.sweeps,
		bars: () => glyphs.bars,
		onPresent(listener) { present.add(listener); return () => { present.delete(listener); }; },
		onWake(listener) { wake.add(listener); return () => { wake.delete(listener); }; },
	};
	return {
		state, glyphs, host,
		/** A glyph appears: its animationstart reaches the module. */
		announce() { for (const listener of [...present]) listener(); },
		/** The page is shown, focused or restored. */
		wake() { for (const listener of [...wake]) listener(); },
		/** Advances the clock by `ms` (one frame interval by default); due timers run, and the animation frames asked for when the page is drawn. */
		step(ms = MOTION_FRAME_MS): void {
			state.now += ms;
			for (const timer of timers.splice(0).filter(candidate => { if (candidate.at <= state.now) return true; timers.push(candidate); return false; })) timer.callback();
			if (state.drawn) for (const [id, frame] of [...frames]) { frames.delete(id); frame(); }
		},
		timers: () => timers.length,
		frames: () => frames.size,
		listeners: () => present.size + wake.size,
	};
}

describe("the page's moving glyphs", () => {
	it("has no timer on a page where nothing moves, and none after the last glyph is gone", () => {
		const fake = page();
		const motion = new PageMotion(fake.host);
		motion.start();
		assert.equal(fake.timers(), 0);
		fake.announce();
		assert.equal(fake.timers(), 0, "an announcement with no glyph to move starts nothing");
		const spinner = new Glyph();
		fake.glyphs.spinners.push(spinner);
		fake.announce();
		assert.equal(motion.waiting, true);
		fake.step();
		assert.equal(motion.waiting, true, "the loop goes on while the glyph is there");
		fake.glyphs.spinners.length = 0;
		fake.step();
		assert.equal(motion.waiting, false, "the first frame that finds nothing to move ends the loop");
		assert.equal(fake.frames(), 0);
		fake.step(FRAME_STALE_MS);
		assert.equal(fake.timers(), 0, "the watchdog goes with the loop");
	});

	it("paints a glyph that appears at once, with the position of the moment, and starts the loop", () => {
		const fake = page();
		const motion = new PageMotion(fake.host);
		motion.start();
		fake.state.now = 3 * 125 + 10;
		const spinner = new Glyph();
		fake.glyphs.spinners.push(spinner);
		fake.announce();
		assert.equal(spinner.values.get(SPIN_PROPERTY), "135deg", "the glyph's own eight steps a second: step 3 of 8");
		assert.equal(motion.waiting, true);
	});

	it("turns a spinner in eight steps a second, sweeps text and a bar in 24 steps in two seconds, and writes only when a step changes", () => {
		const fake = page();
		new PageMotion(fake.host).start();
		const spinner = new Glyph(); const text = new Glyph(); const bar = new Glyph();
		fake.glyphs.spinners.push(spinner); fake.glyphs.sweeps.push(text); fake.glyphs.bars.push(bar);
		fake.announce();
		const writes = spinner.writes;
		const seen = new Set<string>();
		const sweeps = new Set<string>();
		const bars = new Set<string>();
		for (let frame = 0; frame < 48; frame++) {
			fake.step();
			seen.add(spinner.values.get(SPIN_PROPERTY)!);
			sweeps.add(text.values.get(SWEEP_PROPERTY)!);
			bars.add(bar.values.get(PROGRESS_PROPERTY)!);
		}
		assert.equal(seen.size, 8, "eight spinner positions");
		assert.equal(sweeps.size, 24, "24 sweep positions");
		assert.equal(bars.size, 24, "24 bar positions");
		assert.equal(text.values.get(SPIN_PROPERTY), spinner.values.get(SPIN_PROPERTY), "the row's own glyph turns with the others");
		assert.ok(spinner.writes - writes <= 48 * (8 / 12) + 2, `a spinner is written when its step changes (8 a second), not at every frame: ${spinner.writes - writes} writes in 48 frames`);
		assert.match(text.values.get(SWEEP_PROPERTY)!, /^\d+(\.\d+)?%$/);
	});

	it("waits for free while the page is not drawn and goes on when it is drawn again", () => {
		const fake = page();
		const motion = new PageMotion(fake.host);
		motion.start();
		const spinner = new Glyph();
		fake.glyphs.spinners.push(spinner);
		fake.announce();
		fake.step();
		fake.state.drawn = false;
		for (let index = 0; index < 100; index++) fake.step();
		assert.ok(fake.timers() <= 2, `an undrawn page keeps at most the frame timer and the watchdog: ${fake.timers()}`);
		assert.equal(fake.frames(), 1, "one animation frame is waiting, and costs nothing: the watchdog withdraws the one it replaces");
		const written = spinner.writes;
		fake.announce();
		assert.equal(fake.frames(), 1, "a glyph that appears meanwhile does not start a second loop");
		fake.state.drawn = true;
		fake.step();
		assert.ok(spinner.writes > written, "drawn again, the loop resumes");
		assert.equal(motion.waiting, true);
	});

	it("takes a frame the browser dropped as lost, schedules it again and carries on", () => {
		const fake = page();
		const motion = new PageMotion(fake.host);
		motion.start();
		const spinner = new Glyph();
		fake.glyphs.spinners.push(spinner);
		fake.announce();
		fake.step();
		fake.state.dropFrames = true;
		fake.step();
		fake.step();
		fake.state.dropFrames = false;
		const stuck = spinner.writes;
		// The browser draws again, but the frame it was asked for never comes: only the watchdog can restart the loop.
		fake.step(FRAME_STALE_MS / 2);
		assert.equal(spinner.writes, stuck, "before the frame is taken as lost nothing is written");
		for (let index = 0; index < 30; index++) fake.step();
		assert.ok(spinner.writes > stuck + 5, `the spinner moves again: ${spinner.writes - stuck} writes in 30 frames`);
		assert.equal(motion.waiting, true);
		assert.ok(fake.frames() <= 1, "a lost request is withdrawn, not left behind");
	});

	it("restarts at once when the page is shown or focused again, with the position of the moment", () => {
		const fake = page();
		const motion = new PageMotion(fake.host);
		motion.start();
		const spinner = new Glyph();
		fake.glyphs.spinners.push(spinner);
		fake.announce();
		fake.state.dropFrames = true;
		fake.step();
		fake.step();
		fake.state.dropFrames = false;
		fake.state.now += 3 * 125;
		const stuck = spinner.writes;
		fake.wake();
		assert.equal(spinner.writes, stuck + 1, "painted at the wake-up, not at the next frame");
		assert.equal(spinner.values.get(SPIN_PROPERTY), `${Math.floor(fake.state.now / 125) % 8 * 45}deg`);
		fake.step();
		fake.step();
		assert.equal(motion.waiting, true);
		assert.ok(spinner.writes > stuck + 1);
		assert.equal(fake.frames() <= 1, true);
	});

	it("goes on when a glyph throws while it is written", () => {
		const fake = page();
		const motion = new PageMotion(fake.host);
		motion.start();
		const spinner = new Glyph();
		fake.glyphs.spinners.push(spinner);
		fake.announce();
		spinner.failures = 1;
		assert.throws(() => { for (let index = 0; index < 4; index++) fake.step(); }, /the element is gone/);
		assert.equal(motion.waiting, true, "the next frame is asked for although this one failed");
		const written = spinner.writes;
		for (let index = 0; index < 12; index++) fake.step();
		assert.ok(spinner.writes > written);
	});

	it("takes a long run, with glyphs coming and going and frames lost now and then, as one loop that never stops while a glyph is there", () => {
		const fake = page();
		const motion = new PageMotion(fake.host);
		motion.start();
		const spinner = new Glyph();
		fake.glyphs.spinners.push(spinner);
		fake.announce();
		let seed = 7;
		const random = (): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
		let written = spinner.writes;
		let idle = 0;
		for (let index = 0; index < 20_000; index++) {
			const roll = random();
			fake.state.dropFrames = roll < 0.01;
			fake.state.drawn = roll > 0.02;
			if (roll > 0.99) { fake.glyphs.spinners.push(new Glyph()); fake.announce(); }
			const delta = roll > 0.5 ? MOTION_FRAME_MS : 17;
			fake.step(delta);
			if (spinner.writes === written) idle += delta; else { written = spinner.writes; idle = 0; }
			assert.ok(idle < 3 * FRAME_STALE_MS, `the spinner stands still for ${idle} ms at step ${index}`);
		}
		assert.equal(motion.waiting, true);
	});

	it("moves nothing for a reader who asked for reduced motion, and starts again when they do not", () => {
		const fake = page();
		const motion = new PageMotion(fake.host);
		motion.start();
		const spinner = new Glyph();
		fake.glyphs.spinners.push(spinner);
		fake.state.reduced = true;
		fake.announce();
		assert.equal(spinner.writes, 0);
		assert.equal(fake.timers(), 0);
		fake.state.reduced = false;
		fake.announce();
		assert.ok(spinner.writes > 0);
		assert.equal(motion.waiting, true);
		fake.state.reduced = true;
		for (let index = 0; index < 4; index++) fake.step();
		assert.equal(motion.waiting, false, "a reader who asks for less motion stops the loop");
		fake.state.reduced = false;
		const stopped = spinner.writes;
		fake.wake();
		assert.ok(spinner.writes > stopped, "and the setting changing back starts it without a new glyph");
		assert.equal(motion.waiting, true);
	});

	it("stops listening when the module is stopped", () => {
		const fake = page();
		const stop = new PageMotion(fake.host).start();
		assert.equal(fake.listeners(), 2);
		stop();
		assert.equal(fake.listeners(), 0);
	});
});
