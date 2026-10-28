/**
 * The window's scheduler of helper processes: short-lived `omp` (or Bun-hosted OMP) runs that a window starts for facts it
 * shows next to a conversation (provider usage, the model catalogue of the default profile, settings reads, the inventory,
 * the served-model check, a version of another install). None of them is the session itself.
 *
 * Why it exists. A reload restarts every window at once, and each restored tab asked for its own reads the moment it went live,
 * so a four-window reload put a batch of two dozen processes next to the restore the user is waiting for, each of them loading
 * the whole OMP package on a machine that was already busy (2026-10-23 start analysis; ADR-0084). The scheduler is the one place
 * those runs go through:
 *
 * - `visible` work serves something on screen now (the active tab's quota, an open inventory view, a page's settings question):
 *   it is queued only by the window's concurrency bound and goes before background work.
 * - `background` work is not needed for the first view: it waits until the startup restore is over (`backgroundGate`) plus a
 *   short settle delay, runs at most `maxBackground` at a time, and takes one of a few cross-window slots (`slots`) so the windows
 *   of one reload do not all start theirs together.
 * - Work with a `key` that is already queued or running is shared: the second caller gets the first run's result. A queued
 *   background job that a caller needs on screen is promoted to `visible`.
 * - `dispose` rejects queued work with {@link HelperCancelledError}, aborts what runs (the job ends its process) and frees the
 *   callers at once; nothing starts afterwards.
 *
 * A cross-window slot is a throttle, never a correctness lock: when none is free within `slotWaitMs`, or the slot files cannot be
 * used, the job runs anyway.
 *
 * Nothing here imports `vscode`.
 */
import type { Logger } from "../shared/logger.ts";

export type HelperClass = "visible" | "background";

export interface HelperJob<T> {
	/** What the run is, for the log. Never carries a path, account or credential. */
	readonly label: string;
	readonly class: HelperClass;
	/** Identical work with the same key that is queued or running is shared, not repeated. */
	readonly key?: string;
	/** Starts the process. `signal` aborts when the scheduler is disposed; the job ends its process and rejects. */
	run(signal: AbortSignal): Promise<T>;
}

/** The rejection of work the scheduler cancelled because the window is going away. */
export class HelperCancelledError extends Error {
	constructor(label: string) {
		super(`The helper run "${label}" was cancelled because the window is closing.`);
		this.name = "HelperCancelledError";
	}
}

export function isHelperCancelled(error: unknown): error is HelperCancelledError {
	return error instanceof HelperCancelledError;
}

/** One held cross-window slot. */
export interface HelperSlotLease {
	release(): Promise<void>;
}

/** The few cross-window slots background work takes (see `helper-slots.ts`). */
export interface HelperSlots {
	/** A held slot, or `null` when none was free within `maxWaitMs`, the wait was aborted or the slots cannot be used. Never rejects. */
	acquire(signal: AbortSignal, maxWaitMs: number): Promise<HelperSlotLease | null>;
}

export interface HelperSchedulerOptions {
	readonly log: Logger;
	/** How many helpers of this window run at once, of either class. */
	readonly maxConcurrent?: number;
	/** How many of those may be background work, so visible work always has headroom. */
	readonly maxBackground?: number;
	/** Background work starts only after this settles (the startup restore is over). Never rejects; a rejection counts as open. */
	readonly backgroundGate: Promise<void>;
	/** How long after the gate opens background work stays back, so the work the restore itself queued goes first. */
	readonly backgroundSettleMs?: number;
	readonly slots?: HelperSlots | null;
	readonly slotWaitMs?: number;
	readonly now?: () => number;
	/** Resolves after `ms`, or at once when `signal` aborts. */
	readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export const DEFAULT_HELPER_CONCURRENCY = 2;
export const DEFAULT_HELPER_BACKGROUND_CONCURRENCY = 1;
export const DEFAULT_HELPER_SETTLE_MS = 2_000;
export const DEFAULT_HELPER_SLOT_WAIT_MS = 30_000;

interface Entry {
	readonly id: number;
	readonly job: HelperJob<unknown>;
	class: HelperClass;
	readonly controller: AbortController;
	readonly queuedAt: number;
	started: boolean;
	startedAt: number;
	slotWaitedMs: number;
	settled: boolean;
	readonly promise: Promise<unknown>;
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: unknown) => void;
}

/** What the window's helpers did, for the summary line and the tests. */
export interface HelperSchedulerStats {
	readonly started: { readonly visible: number; readonly background: number };
	readonly failed: number;
	readonly peakRunning: number;
	/** Milliseconds from the scheduler's creation to the first and the last start; `null` before any. */
	readonly firstStartMs: number | null;
	readonly lastStartMs: number | null;
	/** The longest wait of a job between being asked for and starting. */
	readonly longestWaitMs: number;
	readonly slotWaitedMs: number;
}

/** Resolves after `ms`, or at once when `signal` aborts; its timer never keeps the process alive. */
export function helperSleep(ms: number, signal: AbortSignal): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	if (signal.aborted) { resolve(); return promise; }
	const done = (): void => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
	const timer = setTimeout(done, ms);
	timer.unref();
	signal.addEventListener("abort", done, { once: true });
	return promise;
}

export class HelperScheduler {
	readonly #log: Logger;
	readonly #maxConcurrent: number;
	readonly #maxBackground: number;
	readonly #slots: HelperSlots | null;
	readonly #slotWaitMs: number;
	readonly #now: () => number;
	readonly #sleep: (ms: number, signal: AbortSignal) => Promise<void>;
	readonly #createdAt: number;
	readonly #lifetime = new AbortController();
	readonly #visibleQueue: Entry[] = [];
	readonly #backgroundQueue: Entry[] = [];
	readonly #running = new Set<Entry>();
	readonly #byKey = new Map<string, Entry>();
	#runningBackground = 0;
	/** Jobs whose `run` is in progress: the helper processes really alive, which a run waiting for its slot is not. */
	#active = 0;
	#gateOpen = false;
	#disposed = false;
	#summarised = false;
	#nextId = 1;
	#startedVisible = 0;
	#startedBackground = 0;
	#failed = 0;
	#peak = 0;
	#firstStartAt: number | null = null;
	#lastStartAt: number | null = null;
	#longestWait = 0;
	#slotWaited = 0;

	constructor(options: HelperSchedulerOptions) {
		this.#log = options.log;
		this.#maxConcurrent = Math.max(1, options.maxConcurrent ?? DEFAULT_HELPER_CONCURRENCY);
		this.#maxBackground = Math.max(1, Math.min(this.#maxConcurrent, options.maxBackground ?? DEFAULT_HELPER_BACKGROUND_CONCURRENCY));
		this.#slots = options.slots ?? null;
		this.#slotWaitMs = options.slotWaitMs ?? DEFAULT_HELPER_SLOT_WAIT_MS;
		this.#now = options.now ?? Date.now;
		this.#sleep = options.sleep ?? helperSleep;
		this.#createdAt = this.#now();
		const settle = options.backgroundSettleMs ?? DEFAULT_HELPER_SETTLE_MS;
		void Promise.resolve(options.backgroundGate).catch(() => undefined)
			.then(() => this.#sleep(settle, this.#lifetime.signal))
			.then(() => {
				if (this.#disposed) return;
				this.#gateOpen = true;
				this.#log.debug(`helper runs: the startup restore is over, ${this.#backgroundQueue.length} background run(s) waiting`);
				this.#pump();
				this.#summariseWhenDrained();
			});
	}

	/** Runs `job` under the window's bounds. Rejects with {@link HelperCancelledError} when the window closes first. */
	run<T>(job: HelperJob<T>): Promise<T> {
		if (this.#disposed) return Promise.reject(new HelperCancelledError(job.label));
		if (job.key !== undefined) {
			const shared = this.#byKey.get(job.key);
			if (shared !== undefined) {
				if (job.class === "visible" && shared.class === "background" && !shared.started) this.#promote(shared);
				return shared.promise as Promise<T>;
			}
		}
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		const entry: Entry = {
			id: this.#nextId++, job: job as HelperJob<unknown>, class: job.class, controller: new AbortController(), queuedAt: this.#now(),
			started: false, startedAt: 0, slotWaitedMs: 0, settled: false, promise, resolve, reject,
		};
		if (job.key !== undefined) this.#byKey.set(job.key, entry);
		(entry.class === "visible" ? this.#visibleQueue : this.#backgroundQueue).push(entry);
		this.#pump();
		return promise as Promise<T>;
	}

	/**
	 * Moves the queued background job with this key to `visible` (a caller that shared its work now needs it on screen). A job that already
	 * started, or is waiting for its cross-window slot, is not moved. Answers whether anything moved.
	 */
	promote(key: string): boolean {
		const entry = this.#byKey.get(key);
		if (entry === undefined || entry.class !== "background" || entry.started) return false;
		this.#promote(entry);
		return true;
	}

	/** Counts so far, for tests and the summary line. */
	stats(): HelperSchedulerStats {
		return {
			started: { visible: this.#startedVisible, background: this.#startedBackground }, failed: this.#failed, peakRunning: this.#peak,
			firstStartMs: this.#firstStartAt === null ? null : this.#firstStartAt - this.#createdAt,
			lastStartMs: this.#lastStartAt === null ? null : this.#lastStartAt - this.#createdAt,
			longestWaitMs: this.#longestWait, slotWaitedMs: this.#slotWaited,
		};
	}

	/** Cancels queued work, aborts running work, frees every caller, and starts nothing afterwards. */
	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#lifetime.abort();
		const entries = [...this.#visibleQueue, ...this.#backgroundQueue, ...this.#running];
		this.#visibleQueue.length = 0;
		this.#backgroundQueue.length = 0;
		for (const entry of entries) {
			entry.controller.abort();
			this.#settle(entry, () => entry.reject(new HelperCancelledError(entry.job.label)));
		}
	}

	#runLine(entry: Entry, waited: number, startedAt: number): string {
		return `helper run: ${entry.job.label} (${entry.class}) waited ${waited} ms${entry.slotWaitedMs > 0 ? `, ${entry.slotWaitedMs} ms of it for a cross-window slot` : ""}, ran ${this.#now() - startedAt} ms`;
	}

	#promote(entry: Entry): void {
		const at = this.#backgroundQueue.indexOf(entry);
		if (at >= 0) this.#backgroundQueue.splice(at, 1);
		entry.class = "visible";
		this.#visibleQueue.push(entry);
		this.#pump();
	}

	#settle(entry: Entry, action: () => void): void {
		if (entry.settled) return;
		entry.settled = true;
		if (entry.job.key !== undefined && this.#byKey.get(entry.job.key) === entry) this.#byKey.delete(entry.job.key);
		action();
	}

	#pump(): void {
		if (this.#disposed) return;
		while (this.#running.size < this.#maxConcurrent) {
			let next = this.#visibleQueue.shift();
			if (next === undefined && this.#gateOpen && this.#runningBackground < this.#maxBackground) next = this.#backgroundQueue.shift();
			if (next === undefined) return;
			void this.#execute(next);
		}
	}

	async #execute(entry: Entry): Promise<void> {
		this.#running.add(entry);
		entry.started = true;
		const background = entry.class === "background";
		if (background) this.#runningBackground += 1;
		let lease: HelperSlotLease | null = null;
		try {
			if (background && this.#slots !== null) {
				const waitStarted = this.#now();
				lease = await this.#slots.acquire(entry.controller.signal, this.#slotWaitMs).catch(() => null);
				entry.slotWaitedMs = this.#now() - waitStarted;
				this.#slotWaited += entry.slotWaitedMs;
			}
			if (entry.controller.signal.aborted) throw new HelperCancelledError(entry.job.label);
			const startedAt = this.#now();
			entry.startedAt = startedAt;
			this.#firstStartAt ??= startedAt;
			this.#lastStartAt = startedAt;
			if (entry.class === "visible") this.#startedVisible += 1; else this.#startedBackground += 1;
			const waited = startedAt - entry.queuedAt;
			this.#longestWait = Math.max(this.#longestWait, waited);
			this.#active += 1;
			this.#peak = Math.max(this.#peak, this.#active);
			let value: unknown;
			try {
				value = await entry.job.run(entry.controller.signal);
			} catch (error) {
				this.#log.debug(`${this.#runLine(entry, waited, startedAt)}, ended with ${error instanceof Error ? error.name : "a non-Error"}`);
				throw error;
			} finally {
				this.#active -= 1;
			}
			this.#log.debug(this.#runLine(entry, waited, startedAt));
			this.#settle(entry, () => entry.resolve(value));
		} catch (error) {
			if (!isHelperCancelled(error) && !entry.controller.signal.aborted) this.#failed += 1;
			this.#settle(entry, () => entry.reject(error));
		} finally {
			if (lease !== null) await lease.release().catch(() => undefined);
			this.#running.delete(entry);
			if (background) this.#runningBackground -= 1;
			this.#pump();
			this.#summariseWhenDrained();
		}
	}

	#summariseWhenDrained(): void {
		if (this.#summarised || this.#disposed || !this.#gateOpen) return;
		if (this.#running.size > 0 || this.#visibleQueue.length > 0 || this.#backgroundQueue.length > 0) return;
		const started = this.#startedVisible + this.#startedBackground;
		if (started === 0) return;
		this.#summarised = true;
		const stats = this.stats();
		this.#log.info(
			`helper runs: ${started} started since activation (${stats.started.visible} visible, ${stats.started.background} background), at most ${stats.peakRunning} at once, ` +
			`first at +${stats.firstStartMs} ms, last at +${stats.lastStartMs} ms, longest wait ${stats.longestWaitMs} ms (${stats.slotWaitedMs} ms of background waits were for a cross-window slot)${stats.failed > 0 ? `, ${stats.failed} failed` : ""}`,
		);
	}
}
