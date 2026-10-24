/**
 * The page's moving glyphs, drawn by one low-rate timer instead of CSS animations.
 *
 * A running CSS animation makes the browser produce a frame on every display refresh for as long as it lives, whatever it changes:
 * the working row's text sweep (a clipped gradient, repainted by the main thread), the spinners of running tools and jobs and the
 * turn's progress bar kept one working Chat page at about 190 ms of CPU per second (89 ms renderer, 100 ms GPU, measured in Chromium
 * on a page with nothing else going on), 0 when they were still. Here a glyph's position is a CSS custom property that this module
 * writes (the spinner turns in its glyph's own 8 steps a second, the sweep and the bar in 12); the stylesheet turns the property
 * into a `transform` or a `background-position`. The same page then costs about 2 ms per second.
 *
 * It runs only while something moves. A glyph announces itself: its stylesheet rule carries a one-millisecond `omp-motion-present`
 * animation whose `animationstart` reaches {@link MotionHost.onPresent}, so an idle page has no timer, and a glyph that appears (a
 * tool starts) is painted at once and starts the timer. The timer stops itself on the first step that finds nothing to move, and
 * while the browser reports the page hidden (a minimised window) or the reader asked for reduced motion.
 *
 * The timer writes the glyphs itself; it does not wait for an animation frame. A first version wrote in the frame that followed each
 * timer, so a step took a timer plus a frame (about 100 ms where the spinner's step is 125 and the sweep's 83: steps came 100 and
 * 200 ms apart, a spinner that looked irregular even on an idle page), and on a Chat page with a long transcript, where every streamed
 * update re-laid out thousands of rows and the main thread was busy a quarter of the time, frames came 50 to 180 ms apart and the
 * spinner turned at 5 steps a second. A style write costs the same in a timer as in a frame (the browser draws it in its next frame
 * either way), and the timer is due at the moment a step begins: the next boundary of the 125 ms grid of the spinner or the 83 ms
 * grid of the sweep, whichever glyphs are on screen. A step is the one the clock reads, so a timer that runs late skips a step
 * instead of drifting.
 *
 * What a frame is still good for is telling a page that is drawn from one that is not. A Chat tab behind another tab keeps
 * `visibilityState` "visible" and its timers at full rate (measured in VS Code) but gets no frame at all, while a page the reader
 * sees gets one at least every 180 ms even when it is saturated. So each step asks for one frame, and a page whose frame has not come
 * in {@link FRAME_STALE_MS} while its timer ran is taken as not drawn: the loop then wakes about once a second ({@link DORMANT_TICK_MS},
 * which asks for the frame again in case the request was lost and still writes the step, so a page wrongly taken as hidden crawls
 * instead of freezing) and is back at its own rate with the first frame, or at once on a wake-up (the page shown or focused, shown from
 * the back/forward cache, the reader's motion setting changing, {@link MotionHost.onWake}). A write that throws on one glyph still
 * schedules the next step.
 */
// Explicit `.ts` specifiers: this module is imported by the node:test runner.

/** A frame that was asked for and has not run after this long, although the timer did, means the page is not drawn. */
export const FRAME_STALE_MS = 1000;
/** How often a page that is not drawn looks again: not the spinner's own period (1000 ms) or a multiple of it, or each look would find the glyph at the position it already shows. */
export const DORMANT_TICK_MS = 1100;
/** A spinner turns once in this long, in {@link SPIN_STEPS} steps. */
export const SPIN_PERIOD_MS = 1000;
export const SPIN_STEPS = 8;
/** The text sweep and the progress bar cross once in this long, in {@link SWEEP_STEPS} steps. */
export const SWEEP_PERIOD_MS = 2000;
export const SWEEP_STEPS = 24;
/** The length of one step of each. */
export const SPIN_STEP_MS = SPIN_PERIOD_MS / SPIN_STEPS;
export const SWEEP_STEP_MS = SWEEP_PERIOD_MS / SWEEP_STEPS;

/** The part of an element's inline style the module writes. */
export interface MotionTarget {
	setProperty(name: string, value: string): void;
}

/** What the module needs from the page. */
export interface MotionHost {
	now(): number;
	/** Runs `callback` after about `ms` (a timer); returns the handle that {@link cancelLater} takes. */
	later(callback: () => void, ms: number): unknown;
	/** Withdraws a timer set by {@link later} that has not run. */
	cancelLater(handle: unknown): void;
	/** Runs `callback` before the next drawn frame; never, while the page is not drawn. Returns the handle that {@link cancelFrame} takes. */
	frame(callback: () => void): unknown;
	/** Withdraws a frame requested by {@link frame} that has not run. */
	cancelFrame(handle: unknown): void;
	/** Whether the reader asked for less motion; nothing is written then. */
	reduced(): boolean;
	/** Whether the browser reports the page hidden (a minimised window, a background tab): nothing is drawn, so nothing is written. */
	hidden(): boolean;
	/** The icons that spin (`.codicon-modifier-spin`). */
	spinners(): Iterable<MotionTarget>;
	/** The working row's text, only while it has text (`.omp-working-status-text` that is not empty): the sweep and its own spinner glyph. */
	sweeps(): Iterable<MotionTarget>;
	/** The turn's progress bars (`.omp-turn-progress`). */
	bars(): Iterable<MotionTarget>;
	/** Calls `listener` when a glyph that moves appears; returns the stop function. */
	onPresent(listener: () => void): () => void;
	/** Calls `listener` when the page is shown, focused or restored, or the reader's motion setting changes; returns the stop function. */
	onWake(listener: () => void): () => void;
}

/** The custom properties of the stylesheet (`styles.ts`). */
export const SPIN_PROPERTY = "--omp-spin";
export const SWEEP_PROPERTY = "--omp-sweep";
export const PROGRESS_PROPERTY = "--omp-progress";

export class PageMotion {
	readonly #host: MotionHost;
	#timer: unknown;
	/** The frame asked for to learn whether the page is drawn, and when it was asked. */
	#frame: unknown;
	#frameAsked = 0;
	/** The page got no frame in {@link FRAME_STALE_MS} although its timer ran: it is not drawn, and looks again once a second. */
	#dormant = false;
	/** The steps last written, so a step is written once; `-1` before the first write and after a stop. */
	#spin = -1;
	#sweep = -1;
	/** Which grids the glyphs found by the last write follow: the 125 ms one of the spinner (the working row's glyph included), the 83 ms one of the sweep and the bar. */
	#onSpinGrid = false;
	#onSweepGrid = false;
	#stop: (() => void) | undefined;
	#stopWake: (() => void) | undefined;

	constructor(host: MotionHost) { this.#host = host; }

	/** Starts listening for glyphs and wake-ups; the returned function stops the module. */
	start(): () => void {
		this.#stop ??= this.#host.onPresent(() => this.#proven());
		this.#stopWake ??= this.#host.onWake(() => this.#proven());
		return () => {
			this.#stop?.(); this.#stop = undefined;
			this.#stopWake?.(); this.#stopWake = undefined;
			this.#halt();
		};
	}

	/** Whether the timer is waiting, for tests. */
	get running(): boolean { return this.#timer !== undefined; }

	/** Whether the page is taken as not drawn, for tests. */
	get dormant(): boolean { return this.#dormant; }

	#halt(): void {
		if (this.#timer !== undefined) this.#host.cancelLater(this.#timer);
		this.#timer = undefined;
		this.#cancelFrame();
		this.#dormant = false;
		this.#spin = -1;
		this.#sweep = -1;
	}

	#cancelFrame(): void {
		if (this.#frame !== undefined) this.#host.cancelFrame(this.#frame);
		this.#frame = undefined;
	}

	/** The frame came: the page is drawn. A page that was dormant is back at its own rate. */
	#framed(): void {
		this.#frame = undefined;
		if (!this.#dormant) return;
		this.#dormant = false;
		this.#step(true);
	}

	/**
	 * A glyph announced itself (the browser starts an animation only in a frame it draws) or the page was shown, focused or restored:
	 * the page is taken as drawn again, at its own rate, and looks for its frames afresh, so a page that is still not drawn is
	 * taken as such again after {@link FRAME_STALE_MS}.
	 */
	#proven(): void {
		this.#dormant = false;
		this.#cancelFrame();
		this.#step(true);
	}

	/**
	 * Writes the current step to every glyph that moves (`force`: also when the step has not changed, because a glyph just appeared or the
	 * page was woken) and sets the timer for the next step. Nothing is set when no glyph was found, the page is hidden or the reader asked
	 * for reduced motion; whatever else happens (a glyph that throws when written), the next step is still set.
	 */
	#step(force: boolean): void {
		if (this.#host.reduced() || this.#host.hidden()) { this.#halt(); return; }
		let moving = true;
		try {
			moving = this.#paint(force);
		} finally {
			if (moving) this.#schedule();
			else this.#halt();
		}
	}

	/** Returns whether anything moves. */
	#paint(force: boolean): boolean {
		const now = this.#host.now();
		const spin = Math.floor(now / SPIN_STEP_MS) % SPIN_STEPS;
		const sweep = Math.floor(now / SWEEP_STEP_MS) % SWEEP_STEPS;
		const spinChanged = force || spin !== this.#spin;
		const sweepChanged = force || sweep !== this.#sweep;
		this.#spin = spin;
		this.#sweep = sweep;
		const angle = `${spin * (360 / SPIN_STEPS)}deg`;
		let found = 0;
		// Each glyph sets its grid before it is written, so one that throws still leaves the grids of the glyphs before it.
		this.#onSpinGrid = this.#onSweepGrid = false;
		for (const target of this.#host.spinners()) {
			found++;
			this.#onSpinGrid = true;
			if (spinChanged) target.setProperty(SPIN_PROPERTY, angle);
		}
		for (const target of this.#host.sweeps()) {
			found++;
			this.#onSpinGrid = this.#onSweepGrid = true;
			if (spinChanged) target.setProperty(SPIN_PROPERTY, angle);
			// The text's background moves from 100% to 0% of its overflow.
			if (sweepChanged) target.setProperty(SWEEP_PROPERTY, `${100 - (sweep * 100) / SWEEP_STEPS}%`);
		}
		for (const target of this.#host.bars()) {
			found++;
			this.#onSweepGrid = true;
			if (sweepChanged) target.setProperty(PROGRESS_PROPERTY, String(sweep / SWEEP_STEPS));
		}
		return found > 0;
	}

	/** Asks for the frame that tells whether the page is drawn, and sets the one timer: due just after the next step of the glyphs on screen begins, or in a second for a page that is not drawn. */
	#schedule(): void {
		if (this.#timer !== undefined) this.#host.cancelLater(this.#timer);
		const now = this.#host.now();
		if (this.#frame !== undefined && now - this.#frameAsked >= FRAME_STALE_MS) {
			this.#dormant = true;
			this.#cancelFrame();
		}
		if (this.#frame === undefined) { this.#frameAsked = now; this.#frame = this.#host.frame(() => this.#framed()); }
		if (this.#dormant) { this.#timer = this.#host.later(() => { this.#timer = undefined; this.#step(false); }, DORMANT_TICK_MS); return; }
		let due = Number.POSITIVE_INFINITY;
		if (this.#onSpinGrid) due = Math.min(due, SPIN_STEP_MS - (now % SPIN_STEP_MS));
		if (this.#onSweepGrid) due = Math.min(due, SWEEP_STEP_MS - (now % SWEEP_STEP_MS));
		// Without a grid (a write that threw before it set one) the shortest step is as good as any; the extra millisecond lands the timer after the boundary, not on it.
		if (due === Number.POSITIVE_INFINITY) due = SWEEP_STEP_MS;
		this.#timer = this.#host.later(() => { this.#timer = undefined; this.#step(false); }, Math.ceil(due) + 1);
	}
}

/** The module over the real page. */
export function installPageMotion(win: Window): () => void {
	const doc = win.document;
	const reducedQuery = win.matchMedia("(prefers-reduced-motion: reduce)");
	const targets = (collection: HTMLCollectionOf<Element>): Iterable<MotionTarget> => Array.from(collection, element => (element as HTMLElement).style);
	const motion = new PageMotion({
		now: () => win.performance.now(),
		later: (callback, ms) => win.setTimeout(callback, ms),
		cancelLater: handle => { win.clearTimeout(handle as number); },
		frame: callback => win.requestAnimationFrame(callback),
		cancelFrame: handle => { win.cancelAnimationFrame(handle as number); },
		reduced: () => reducedQuery.matches,
		hidden: () => doc.visibilityState === "hidden",
		spinners: () => targets(doc.getElementsByClassName("codicon-modifier-spin")),
		sweeps: () => Array.from(doc.getElementsByClassName("omp-working-status-text")).filter(element => element.firstChild !== null).map(element => (element as HTMLElement).style),
		bars: () => targets(doc.getElementsByClassName("omp-turn-progress")),
		onPresent: listener => {
			const onStart = (event: Event): void => { if ((event as AnimationEvent).animationName === "omp-motion-present") listener(); };
			doc.addEventListener("animationstart", onStart, true);
			return () => doc.removeEventListener("animationstart", onStart, true);
		},
		onWake: listener => {
			const onVisibility = (): void => { if (doc.visibilityState !== "hidden") listener(); };
			doc.addEventListener("visibilitychange", onVisibility);
			win.addEventListener("focus", listener);
			win.addEventListener("pageshow", listener);
			reducedQuery.addEventListener("change", listener);
			return () => {
				doc.removeEventListener("visibilitychange", onVisibility);
				win.removeEventListener("focus", listener);
				win.removeEventListener("pageshow", listener);
				reducedQuery.removeEventListener("change", listener);
			};
		},
	});
	return motion.start();
}
