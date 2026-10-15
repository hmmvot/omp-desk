/**
 * The background retry of a durable write that lost to contention (another window held the profile catalog lock).
 *
 * A change that could not be saved is not lost while the window's in-memory state still holds it: the next write saves the
 * whole snapshot. This only makes sure that write happens when no user action follows. One timer at a time (calls while it
 * waits are folded into it), a doubling delay from {@link PersistRetryOptions.firstMs} up to
 * {@link PersistRetryOptions.maxMs}, then that interval for as long as the failures last; a success {@link reset}s it. The timer never
 * keeps the process alive. Nothing here imports `vscode`.
 */

export interface PersistRetryOptions {
	/** The first wait after a failure. */
	readonly firstMs?: number;
	/** The longest wait between two tries. */
	readonly maxMs?: number;
}

export const PERSIST_RETRY_FIRST_MS = 1_000;
export const PERSIST_RETRY_MAX_MS = 30_000;

export class PersistRetry {
	readonly #run: () => Promise<unknown>;
	readonly #firstMs: number;
	readonly #maxMs: number;
	#timer: NodeJS.Timeout | undefined;
	#attempts = 0;

	constructor(run: () => Promise<unknown>, options: PersistRetryOptions = {}) {
		this.#run = run;
		this.#firstMs = options.firstMs ?? PERSIST_RETRY_FIRST_MS;
		this.#maxMs = options.maxMs ?? PERSIST_RETRY_MAX_MS;
	}

	/** How many tries were scheduled since the last success. */
	get attempts(): number {
		return this.#attempts;
	}

	/**
	 * Run the write again after the backoff. Nothing happens while a try is already waiting, or once `limit` tries were
	 * scheduled since the last success (a failure that is not contention is retried a few times only).
	 */
	schedule(limit = Number.POSITIVE_INFINITY): void {
		if (this.#timer !== undefined || this.#attempts >= limit) return;
		const delayMs = Math.min(this.#firstMs * 2 ** this.#attempts, this.#maxMs);
		this.#attempts++;
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			void this.#run().catch(() => undefined);
		}, delayMs);
		this.#timer.unref();
	}

	/** A write landed: whatever was pending is saved, so nothing is retried. */
	reset(): void {
		clearTimeout(this.#timer);
		this.#timer = undefined;
		this.#attempts = 0;
	}
}
