/**
 * The page's moving glyphs, drawn by one low-rate timer instead of CSS animations.
 *
 * A running CSS animation makes the browser produce a frame on every display refresh for as long as it lives, whatever it changes:
 * the working row's text sweep (a clipped gradient, repainted by the main thread), the spinners of running tools and jobs and the
 * turn's progress bar kept one working Chat page at about 190 ms of CPU per second (89 ms renderer, 100 ms GPU, measured in Chromium
 * on a page with nothing else going on), 0 when they were still. Here a glyph's position is a CSS custom property that this module
 * writes at {@link MOTION_FRAME_MS} intervals (12 a second; the spinner turns in its glyph's own 8 steps a second); the stylesheet
 * turns the property into a `transform` or a `background-position`. The same page then costs about 2 ms per second.
 *
 * It runs only while something moves. A glyph announces itself: its stylesheet rule carries a one-millisecond `omp-motion-present`
 * animation whose `animationstart` reaches {@link MotionHost.onPresent}, so an idle page has no timer, and a glyph that appears (a
 * tool starts) is painted at once and starts the timer. The timer stops itself on the first frame that finds nothing to move. Each
 * frame is a timer followed by an animation frame: a page the browser does not draw (a minimised window, a tab behind another one)
 * gets no animation frames, so the loop waits there for free and goes on when the page is drawn again.
 *
 * The loop must never depend on one callback coming back: a glyph that appears while a frame is awaited cannot restart the loop (the
 * frame is "pending"), so a frame the browser dropped would leave every spinner of the page at one angle until the page was reloaded,
 * while the rest of the page went on. Three things keep it alive: a watchdog (one timer a second while the loop lives) replaces a
 * frame that has not come back in {@link FRAME_STALE_MS} and cancels the lost request so waiting frames do not pile up; the page
 * being shown, focused or shown from the back/forward cache, or the reader's motion setting changing, restarts the loop at once
 * ({@link MotionHost.onWake}); and a frame that throws still schedules the next one.
 */
// Explicit `.ts` specifiers: this module is imported by the node:test runner.

/** The interval between two drawn frames. */
export const MOTION_FRAME_MS = 83;
/** A requested frame that has not run after this long is taken as lost and requested again. */
export const FRAME_STALE_MS = 1000;
/** A spinner turns once in this long, in {@link SPIN_STEPS} steps. */
export const SPIN_PERIOD_MS = 1000;
export const SPIN_STEPS = 8;
/** The text sweep and the progress bar cross once in this long, in {@link SWEEP_STEPS} steps. */
export const SWEEP_PERIOD_MS = 2000;
export const SWEEP_STEPS = 24;

/** The part of an element's inline style the module writes. */
export interface MotionTarget {
	setProperty(name: string, value: string): void;
}

/** What the module needs from the page. */
export interface MotionHost {
	now(): number;
	/** Runs `callback` after about `ms` (a timer). */
	later(callback: () => void, ms: number): void;
	/** Runs `callback` before the next drawn frame; never, while the page is not drawn. Returns the handle that {@link cancelFrame} takes. */
	frame(callback: () => void): unknown;
	/** Withdraws a frame requested by {@link frame} that has not run. */
	cancelFrame(handle: unknown): void;
	/** Whether the reader asked for less motion; nothing is written then. */
	reduced(): boolean;
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
	#pending = false;
	/** The time the awaited frame was scheduled; a frame still awaited {@link FRAME_STALE_MS} later is taken as lost. */
	#scheduledAt = 0;
	/** Changes whenever a frame is scheduled again, so the callbacks of an earlier schedule know they are void. */
	#generation = 0;
	#frame: unknown;
	#watching = false;
	#spin = -1;
	#sweep = -1;
	#stop: (() => void) | undefined;
	#stopWake: (() => void) | undefined;

	constructor(host: MotionHost) { this.#host = host; }

	/** Starts listening for glyphs and wake-ups; the returned function stops the module. */
	start(): () => void {
		this.#stop ??= this.#host.onPresent(() => this.#paint(true));
		this.#stopWake ??= this.#host.onWake(() => this.#wake());
		return () => { this.#stop?.(); this.#stop = undefined; this.#stopWake?.(); this.#stopWake = undefined; };
	}

	/** Whether a frame is waiting, for tests. */
	get waiting(): boolean { return this.#pending; }

	/** Asks for the next frame, unless one is awaited and not yet taken as lost. */
	#arm(): void {
		if (this.#pending && this.#host.now() - this.#scheduledAt < FRAME_STALE_MS) return;
		this.#schedule();
	}

	/** Schedules a frame, withdrawing the one awaited (if any), and starts the watchdog. */
	#schedule(): void {
		this.#cancel();
		this.#pending = true;
		this.#scheduledAt = this.#host.now();
		const generation = ++this.#generation;
		this.#host.later(() => {
			if (generation !== this.#generation) return;
			this.#frame = this.#host.frame(() => {
				if (generation !== this.#generation) return;
				this.#frame = undefined;
				this.#pending = false;
				this.#paint(false);
			});
		}, MOTION_FRAME_MS);
		this.#watch();
	}

	#cancel(): void {
		if (this.#frame === undefined) return;
		this.#host.cancelFrame(this.#frame);
		this.#frame = undefined;
	}

	/** One timer a second for as long as the loop lives: a frame that never came back is scheduled again. */
	#watch(): void {
		if (this.#watching) return;
		this.#watching = true;
		this.#host.later(() => {
			this.#watching = false;
			if (!this.#pending) return;
			if (this.#host.now() - this.#scheduledAt >= FRAME_STALE_MS) this.#schedule();
			else this.#watch();
		}, FRAME_STALE_MS);
	}

	/** The page is shown or focused again, or the motion setting changed: start over with what is on screen. */
	#wake(): void {
		this.#cancel();
		this.#generation++;
		this.#pending = false;
		this.#paint(true);
	}

	/** Writes the current step to every glyph that moves; `force` also when the step has not changed (a glyph just appeared). */
	#paint(force: boolean): void {
		if (this.#host.reduced()) return;
		// Whatever happens below, the next frame is asked for unless this one found nothing to move.
		let moving = 1;
		try {
			const now = this.#host.now();
			const spin = Math.floor(now / (SPIN_PERIOD_MS / SPIN_STEPS)) % SPIN_STEPS;
			const sweep = Math.floor(now / (SWEEP_PERIOD_MS / SWEEP_STEPS)) % SWEEP_STEPS;
			const spinChanged = force || spin !== this.#spin;
			const sweepChanged = force || sweep !== this.#sweep;
			this.#spin = spin;
			this.#sweep = sweep;
			const angle = `${spin * (360 / SPIN_STEPS)}deg`;
			let found = 0;
			for (const target of this.#host.spinners()) {
				found++;
				if (spinChanged) target.setProperty(SPIN_PROPERTY, angle);
			}
			for (const target of this.#host.sweeps()) {
				found++;
				if (spinChanged) target.setProperty(SPIN_PROPERTY, angle);
				// The text's background moves from 100% to 0% of its overflow.
				if (sweepChanged) target.setProperty(SWEEP_PROPERTY, `${100 - (sweep * 100) / SWEEP_STEPS}%`);
			}
			for (const target of this.#host.bars()) {
				found++;
				if (sweepChanged) target.setProperty(PROGRESS_PROPERTY, String(sweep / SWEEP_STEPS));
			}
			moving = found;
		} finally {
			if (moving > 0) this.#arm();
		}
	}
}

/** The module over the real page. */
export function installPageMotion(win: Window): () => void {
	const doc = win.document;
	const reducedQuery = win.matchMedia("(prefers-reduced-motion: reduce)");
	const targets = (collection: HTMLCollectionOf<Element>): Iterable<MotionTarget> => Array.from(collection, element => (element as HTMLElement).style);
	const motion = new PageMotion({
		now: () => win.performance.now(),
		later: (callback, ms) => { win.setTimeout(callback, ms); },
		frame: callback => win.requestAnimationFrame(callback),
		cancelFrame: handle => { win.cancelAnimationFrame(handle as number); },
		reduced: () => reducedQuery.matches,
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
