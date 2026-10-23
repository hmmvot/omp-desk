/**
 * The small registry that hands messages taken back out of OMP's queue (the queue row's Edit, a Stop, the history search) to the
 * mounted composer, which merges them into its draft (`restoreQueued`, `lib/draft/`).
 */
import type { RestoredQueued } from "./draft/draft.ts";

/** How many hand-overs may wait for a composer; older ones are dropped first. */
const MAX_PENDING = 8;

type RestoreListener = (entries: readonly RestoredQueued[]) => void;

const listeners: RestoreListener[] = [];
const pending: (readonly RestoredQueued[])[] = [];

/** Deliver dequeued messages to the newest mounted composer, or hold them for the next one. */
export function offerQueuedForEditing(entries: readonly RestoredQueued[]): void {
	if (entries.length === 0) return;
	const listener = listeners[listeners.length - 1];
	if (listener !== undefined) {
		listener(entries);
		return;
	}
	pending.push(entries);
	while (pending.length > MAX_PENDING) pending.shift();
}

/**
 * Register a composer's handler. Anything held while no composer existed is delivered to it first, in order;
 * the returned function releases the handler.
 */
export function subscribeQueuedForEditing(listener: RestoreListener): () => void {
	listeners.push(listener);
	for (const entries of pending.splice(0)) listener(entries);
	return () => {
		const position = listeners.indexOf(listener);
		if (position >= 0) listeners.splice(position, 1);
	};
}
