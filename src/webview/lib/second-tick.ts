/**
 * The page's one-second tick, shared by every live clock (elapsed times, the Thinking… seconds, the Ask countdown).
 *
 * One interval serves all subscribers and exists only while one is subscribed *and* the page is shown: a page the browser reports
 * hidden (a minimised window) draws nothing, so its clocks have nothing to redraw, and the timer would still wake the page once a
 * second for it. Showing the page again ticks at once, so a clock never waits a second to catch up.
 *
 * Whether VS Code reports a retained editor tab that is behind another tab as hidden is not known (the browser keeps such a frame's
 * `visibilityState` visible and only stops its animation frames); that case costs one cheap redraw a second and is left running.
 */
// Explicit `.ts` specifiers: this module is imported by the node:test runner.

/** What the ticker needs from the page. */
export interface SecondTickEnv {
	setInterval(callback: () => void, ms: number): unknown;
	clearInterval(handle: unknown): void;
	/** Whether the page is shown; `false` while the browser reports it hidden. */
	shown(): boolean;
	/** Calls `listener` whenever the page is shown or hidden; returns the stop function. */
	onShownChange(listener: () => void): () => void;
}

export const SECOND_TICK_MS = 1000;

export class SecondTicker {
	readonly #env: SecondTickEnv;
	readonly #listeners = new Set<() => void>();
	#timer: unknown;
	#running = false;
	#stopWatching: (() => void) | undefined;

	constructor(env: SecondTickEnv) { this.#env = env; }

	/** Subscribes `listener`; the returned function unsubscribes it. */
	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		this.#stopWatching ??= this.#env.onShownChange(() => this.#shownChanged());
		this.#sync();
		return () => {
			this.#listeners.delete(listener);
			if (this.#listeners.size === 0) { this.#stopWatching?.(); this.#stopWatching = undefined; }
			this.#sync();
		};
	}

	/** Whether the interval is running, for tests. */
	get ticking(): boolean { return this.#running; }

	#tick(): void { for (const current of [...this.#listeners]) current(); }

	#sync(): void {
		const want = this.#listeners.size > 0 && this.#env.shown();
		if (want && !this.#running) { this.#running = true; this.#timer = this.#env.setInterval(() => this.#tick(), SECOND_TICK_MS); }
		else if (!want && this.#running) { this.#running = false; this.#env.clearInterval(this.#timer); this.#timer = undefined; }
	}

	#shownChanged(): void {
		const was = this.#running;
		this.#sync();
		if (!was && this.#running) this.#tick();
	}
}
