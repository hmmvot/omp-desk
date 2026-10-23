import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	MOTION_FRAME_MS, PageMotion, PROGRESS_PROPERTY, SPIN_PROPERTY, SWEEP_PROPERTY,
	type MotionHost, type MotionTarget,
} from "./page-motion.ts";

class Glyph implements MotionTarget {
	readonly values = new Map<string, string>();
	writes = 0;
	setProperty(name: string, value: string): void { this.values.set(name, value); this.writes++; }
}

/** A page with a manual clock, a timer list, animation frames that fire only while the page is drawn, and glyphs. */
function page() {
	const state = { now: 0, drawn: true, reduced: false };
	const timers: { at: number; callback: () => void }[] = [];
	const frames: (() => void)[] = [];
	const present = new Set<() => void>();
	const glyphs = { spinners: [] as Glyph[], sweeps: [] as Glyph[], bars: [] as Glyph[] };
	const host: MotionHost = {
		now: () => state.now,
		later(callback, ms) { timers.push({ at: state.now + ms, callback }); },
		frame(callback) { frames.push(callback); },
		reduced: () => state.reduced,
		spinners: () => glyphs.spinners,
		sweeps: () => glyphs.sweeps,
		bars: () => glyphs.bars,
		onPresent(listener) { present.add(listener); return () => { present.delete(listener); }; },
	};
	return {
		state, glyphs, host,
		/** A glyph appears: its animationstart reaches the module. */
		announce() { for (const listener of [...present]) listener(); },
		/** Advances the clock by one frame interval; due timers run, and their animation frames when the page is drawn. */
		step(): void {
			state.now += MOTION_FRAME_MS;
			for (const timer of timers.splice(0).filter(candidate => { if (candidate.at <= state.now) return true; timers.push(candidate); return false; })) timer.callback();
			if (state.drawn) for (const frame of frames.splice(0)) frame();
		},
		timers: () => timers.length,
		frames: () => frames.length,
		listeners: () => present.size,
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
		assert.equal(fake.timers(), 1);
		fake.step();
		assert.equal(fake.timers(), 1, "the loop goes on while the glyph is there");
		fake.glyphs.spinners.length = 0;
		fake.step();
		assert.equal(fake.timers(), 0, "the first frame that finds nothing to move ends the loop");
		assert.equal(fake.frames(), 0);
		assert.equal(motion.waiting, false);
	});

	it("paints a glyph that appears at once, with the position of the moment, and starts the loop", () => {
		const fake = page();
		new PageMotion(fake.host).start();
		fake.state.now = 3 * 125 + 10;
		const spinner = new Glyph();
		fake.glyphs.spinners.push(spinner);
		fake.announce();
		assert.equal(spinner.values.get(SPIN_PROPERTY), "135deg", "the glyph's own eight steps a second: step 3 of 8");
		assert.equal(fake.timers(), 1);
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
		new PageMotion(fake.host).start();
		const spinner = new Glyph();
		fake.glyphs.spinners.push(spinner);
		fake.announce();
		fake.step();
		fake.state.drawn = false;
		for (let index = 0; index < 100; index++) fake.step();
		assert.equal(fake.timers(), 0, "no timer runs while the browser draws nothing");
		assert.equal(fake.frames(), 1, "one animation frame is waiting, and costs nothing");
		const written = spinner.writes;
		fake.announce();
		assert.equal(fake.frames(), 1, "a glyph that appears meanwhile does not start a second loop");
		assert.equal(fake.timers(), 0);
		fake.state.drawn = true;
		fake.step();
		assert.equal(fake.timers(), 1, "drawn again, the loop resumes");
		assert.ok(spinner.writes > written);
	});

	it("moves nothing for a reader who asked for reduced motion, and starts again when they do not", () => {
		const fake = page();
		new PageMotion(fake.host).start();
		const spinner = new Glyph();
		fake.glyphs.spinners.push(spinner);
		fake.state.reduced = true;
		fake.announce();
		assert.equal(spinner.writes, 0);
		assert.equal(fake.timers(), 0);
		fake.state.reduced = false;
		fake.announce();
		assert.ok(spinner.writes > 0);
		assert.equal(fake.timers(), 1);
	});

	it("stops listening when the module is stopped", () => {
		const fake = page();
		const stop = new PageMotion(fake.host).start();
		assert.equal(fake.listeners(), 1);
		stop();
		assert.equal(fake.listeners(), 0);
	});
});
