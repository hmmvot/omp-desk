/** The last context reset owns all earlier display history, but counts only its own cleared segment. */
import type { ChatEntry, ResetEntry } from "./messages.ts";
import { clearMarker } from "./clear.ts";

/** Only a post-reload, post-fresh marker confirms a Desk boundary; unknown/native boundaries remain visible. */
export function confirmedClearBoundaryIndex(entries: readonly ChatEntry[]): number {
	const confirmed = new Set<string>();
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index]!;
		const marker = clearMarker(entry);
		if (marker !== null) confirmed.add(marker.boundaryId);
		if (entry.type === "reset_boundary" && confirmed.has(entry.id)) return index;
	}
	return -1;
}

export interface ClearedHistorySplit {
	boundary: ResetEntry;
	before: readonly ChatEntry[];
	after: readonly ChatEntry[];
	messages: number;
	atLeast: boolean;
	summary: string;
}

export function splitClearedHistory(entries: readonly ChatEntry[], olderCount: number): ClearedHistorySplit | null {
	const boundaryIndex = confirmedClearBoundaryIndex(entries);
	if (boundaryIndex < 0) return null;
	const boundary = entries[boundaryIndex] as ResetEntry;
	let messages = 0;
	let index = boundaryIndex - 1;
	for (; index >= 0 && entries[index]!.type !== "reset_boundary"; index -= 1) {
		const entry = entries[index]!;
		if (entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant")) messages += 1;
	}
	const atLeast = index < 0 && olderCount > 0;
	return {
		boundary, before: entries.slice(0, boundaryIndex), after: entries.slice(boundaryIndex), messages, atLeast,
		summary: `Context cleared · ${atLeast ? "at least " : ""}${messages} messages dropped`,
	};
}
