/** Chronological display over a durable prefix and position-anchored live additions. */
import type { AssistantMessage, ChatEntry } from "./messages.ts";
import { parseChatMessage } from "./messages.ts";
const NO_DURABLE_POSITIONS: ReadonlyMap<string, TranscriptPosition> = new Map();

export interface TranscriptPosition { anchorId: string | null; seq: number }
export interface EphemeralItem extends TranscriptPosition {
	id: string;
	timestamp: number;
	kind: string;
	payload: unknown;
}

/** This is a presentation entry, never appended to the durable JSONL partition. */
export function ephemeralEntry(item: EphemeralItem): ChatEntry {
	if (item.kind === "custom") {
		const message = parseChatMessage(item.payload);
		if (message !== null) return { type: "message", id: item.id, parentId: item.anchorId, timestamp: new Date(item.timestamp).toISOString(), message };
	}
	return { type: "custom_message", id: item.id, parentId: item.anchorId, timestamp: new Date(item.timestamp).toISOString(), customType: `native:${item.kind}`, display: true, content: [], details: item.payload };
}

export function positionTranscript(
	entries: readonly ChatEntry[], durableCount: number, pending: ReadonlyMap<string, TranscriptPosition>, ephemeral: readonly EphemeralItem[],
	stream?: { message: AssistantMessage; messageId: string; position: TranscriptPosition } | null,
	durablePositions: ReadonlyMap<string, TranscriptPosition> = NO_DURABLE_POSITIONS,
): ChatEntry[] {
	const additions: { entry: ChatEntry; position: TranscriptPosition }[] = [];
	for (const entry of entries) {
		const position = pending.get(entry.id) ?? durablePositions.get(entry.id);
		if (position !== undefined) additions.push({ entry, position });
	}
	for (const item of ephemeral) additions.push({ entry: ephemeralEntry(item), position: item });
	if (stream) additions.push({ entry: { type: "message", id: `live:${stream.messageId}`, parentId: stream.position.anchorId, timestamp: new Date(stream.message.timestamp).toISOString(), message: stream.message }, position: stream.position });
	additions.sort((left, right) => left.position.seq - right.position.seq);
	const ids = new Set(entries.map(entry => entry.id));
	for (const item of ephemeral) ids.add(item.id);
	if (stream) ids.add(`live:${stream.messageId}`);
	const attached = new Map<string | null, ChatEntry[]>();
	for (const { entry, position } of additions) {
		const anchor = position.anchorId !== null && ids.has(position.anchorId) ? position.anchorId : null;
		const siblings = attached.get(anchor);
		if (siblings === undefined) attached.set(anchor, [entry]);
		else siblings.push(entry);
	}
	// A durable entry nobody positioned (a reset boundary, a custom marker) belongs where its parent is, not above every
	// positioned row: replayed events anchor a later prompt to the leaf they saw, which can precede it. When the parent is
	// not an earlier row (OMP writes entries the file reader never returns, such as model usage or a credential pin, between
	// a turn and what follows it), the row before it in the branch is where it belongs. A parentless entry starts a tree.
	const placed = new Set<string>(durablePositions.keys());
	const plain = new Map<string, ChatEntry[]>();
	const roots: ChatEntry[] = [];
	let previous: ChatEntry | null = null;
	for (const entry of entries.slice(0, durableCount)) {
		const before = previous;
		previous = entry;
		if (durablePositions.has(entry.id)) continue;
		const parent = entry.parentId === null ? null : placed.has(entry.parentId) ? entry.parentId : before?.id ?? null;
		placed.add(entry.id);
		if (parent === null) {
			roots.push(entry);
			continue;
		}
		const siblings = plain.get(parent);
		if (siblings === undefined) plain.set(parent, [entry]);
		else siblings.push(entry);
	}
	for (const [parent, children] of plain) attached.set(parent, [...children, ...(attached.get(parent) ?? [])]);
	roots.push(...(attached.get(null) ?? []));
	const stack = roots.reverse();
	const seen = new Set<string>();
	const result: ChatEntry[] = [];
	while (stack.length > 0) {
		const entry = stack.pop()!;
		if (seen.has(entry.id)) continue;
		seen.add(entry.id);
		result.push(entry);
		const children = attached.get(entry.id);
		if (children !== undefined) for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]!);
	}
	// Invalid cyclic anchors from a page snapshot cannot hide an otherwise valid row.
	for (const { entry } of additions) if (!seen.has(entry.id)) result.push(entry);
	return result;
}
