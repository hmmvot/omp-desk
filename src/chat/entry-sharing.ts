/**
 * Row identity across a snapshot.
 *
 * A snapshot arrives as freshly parsed objects, so a row the page already holds comes back as a new object with the
 * same id and the same content. The page keys its caches, its measured row heights and its memoized presentation on
 * the identity of those objects (a transcript row's measured height is valid while its entry is the same object): with
 * new objects every cache misses and every row is laid out and rendered again, although nothing the reader sees changed.
 * Handing the held object back for an equal row keeps all of that, at the price of one comparison of the row's content.
 */
import type { ChatEntry } from "./messages.ts";

/** Structural equality of parsed JSON values (the only kind of value a row holds). */
export function sameJson(left: unknown, right: unknown): boolean {
	if (left === right) return true;
	if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) return false;
	if (Array.isArray(left)) {
		if (!Array.isArray(right) || left.length !== right.length) return false;
		for (let index = 0; index < left.length; index += 1) if (!sameJson(left[index], right[index])) return false;
		return true;
	}
	if (Array.isArray(right)) return false;
	const own = left as Record<string, unknown>;
	const other = right as Record<string, unknown>;
	let count = 0;
	for (const key in own) {
		if (!Object.hasOwn(own, key)) continue;
		count += 1;
		if (!Object.hasOwn(other, key) || !sameJson(own[key], other[key])) return false;
	}
	for (const key in other) if (Object.hasOwn(other, key)) count -= 1;
	return count === 0;
}

/** The held object for a row that is equal to the held row of its id, the row itself otherwise. */
export type EntrySharer = (entry: ChatEntry) => ChatEntry;

/** A sharer over the rows the page holds now; one index of them serves every row of the snapshot. */
export function entrySharer(held: readonly ChatEntry[]): EntrySharer {
	if (held.length === 0) return entry => entry;
	const byId = new Map<string, ChatEntry>();
	for (const entry of held) byId.set(entry.id, entry);
	return entry => {
		const previous = byId.get(entry.id);
		return previous !== undefined && sameJson(previous, entry) ? previous : entry;
	};
}

/** `next` with every row that is equal to the held row of its id replaced by that held object. The array is always a new one. */
export function shareEntries(held: readonly ChatEntry[], next: readonly ChatEntry[]): ChatEntry[] {
	return next.map(entrySharer(held));
}
