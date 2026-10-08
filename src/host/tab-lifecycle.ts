/**
 * One tab's lifecycle operations, serialized (ADR-0015).
 *
 * A tab's lifecycle facts are whether it is bound to a session file, which claim
 * guards that identity, and which host this window says it runs for the tab.
 * They are changed by operations that await: draft promotion (a header read, a
 * draft-claim adoption, a canonical claim migration), runtime replacement
 * (reconciliation, a launch or attach, publishing the live record), a terminal
 * close (proving the stop, releasing the claim, dropping control material) and a
 * row removal. Each assumes nothing else changes those facts while it awaits. This
 * gate enforces that: one operation per tab at a time, in the order requested.
 *
 * The gate is deliberately not an ownership mechanism. What keeps two windows of one
 * workspace off a session is the durable claim in `session-claim.ts`; the gate orders
 * the operations of one extension host, so a promotion cannot resume after a close or
 * a relaunch has already replaced what it captured.
 *
 * Different tabs never wait for each other, and an operation that rejects does not
 * wedge the ones behind it.
 *
 * ## Holding the gate across a nested mutation
 *
 * An operation must never call {@link TabLifecycle.run} for its own tab: it would queue
 * behind itself and never settle. A caller that already holds the gate passes its
 * {@link TabLifecycleLease} down instead, and the operation it calls verifies the lease
 * with {@link TabLifecycle.holds}. A lease for another tab, or one this gate is not
 * currently running, is rejected as a caller error rather than silently bypassing the
 * exclusion.
 *
 * This module has no dependencies, so the index, the promotion module and the
 * extension host can share one gate without a module cycle.
 */

/**
 * The exclusive right to run one tab's lifecycle operation.
 *
 * Only {@link TabLifecycle} creates a lease, and only for the operation it is running,
 * so holding one proves this tab's lifecycle is held: code that was handed a lease runs
 * inside the gate instead of queueing behind it.
 */
export interface TabLifecycleLease {
	/** The tab this lease is for; an operation for another tab is refused. */
	readonly tabId: string;
}

/** The lifecycle gate of one index, shared with the extension host that owns it. */
export class TabLifecycle {
	/** The last queued operation per tab; the promise every later one waits for. */
	readonly #tails = new Map<string, Promise<void>>();
	/** The lease of the operation running right now, per tab. */
	readonly #running = new Map<string, TabLifecycleLease>();

	/**
	 * Run `operation` with this tab's lifecycle held.
	 *
	 * Operations for one tab run one at a time, in the order `run` was called, and the
	 * returned promise settles with the operation's own outcome. An operation that
	 * rejects releases the tab for the next one.
	 */
	run<T>(tabId: string, operation: (lease: TabLifecycleLease) => Promise<T>): Promise<T> {
		const lease: TabLifecycleLease = Object.freeze({ tabId });
		const previous = this.#tails.get(tabId) ?? Promise.resolve();
		const result = previous.then(async () => {
			this.#running.set(tabId, lease);
			try {
				return await operation(lease);
			} finally {
				this.#running.delete(tabId);
			}
		});
		const tail = result.then(
			() => undefined,
			() => undefined,
		);
		this.#tails.set(tabId, tail);
		// Only the last tail is kept: a tab whose operations have all settled must not
		// accumulate one queue entry per operation it ever ran.
		void tail.then(() => {
			if (this.#tails.get(tabId) === tail) this.#tails.delete(tabId);
		});
		return result;
	}

	/**
	 * Run `operation` holding the gates of both tabs (for a handover between two tabs).
	 * The gates are always taken in tab-id order so two opposite pairs cannot deadlock;
	 * the same id twice takes its gate once.
	 */
	runPair<T>(
		left: string,
		right: string,
		operation: (leftLease: TabLifecycleLease, rightLease: TabLifecycleLease) => Promise<T>,
	): Promise<T> {
		if (left === right) return this.run(left, lease => operation(lease, lease));
		if (left < right) return this.run(left, leftLease => this.run(right, rightLease => operation(leftLease, rightLease)));
		return this.run(right, rightLease => this.run(left, leftLease => operation(leftLease, rightLease)));
	}

	/**
	 * Whether an operation is running or queued for `tabId` right now.
	 *
	 * A window that adopts another window's committed rows uses this to leave alone a tab
	 * whose own lifecycle operation is in flight: that operation was written against the
	 * row as it was, and replacing the row underneath it would publish its intermediate
	 * state.
	 */
	busy(tabId: string): boolean {
		return this.#running.has(tabId) || this.#tails.has(tabId);
	}

	/**
	 * Whether `lease` is the operation this gate is running for its tab right now.
	 *
	 * A lease is the gate's own token, so this is how an operation handed one proves the
	 * tab's lifecycle is really held rather than skipped.
	 */
	holds(lease: TabLifecycleLease): boolean {
		return this.#running.get(lease.tabId) === lease;
	}
}
