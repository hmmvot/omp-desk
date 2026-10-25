/**
 * The transcript with a reply still streaming into it, without projecting the whole transcript again for every frame.
 *
 * Every frame of a streaming reply is a new message object, and the page's transcript is projected from the entries, the
 * pending rows and the live message together: `positionTranscript` places every row, `projectTranscript` folds the whole
 * list into cards. Both walk every loaded entry, so a frame costs as much as the history is long, thirty times a second.
 * The reply is almost always the last thing in the transcript and touches nothing before it, so the rows before it are
 * projected once ({@link projectStable}) and each frame only projects the reply itself ({@link appendLive}).
 *
 * {@link appendLive} answers `null` whenever the reply could change a card before it (it is not the last row, something is
 * anchored to it, a tool runs, it calls `wait` or `todo`, or it calls a tool that already has a card), and the caller
 * projects everything ({@link projectWhole}). Where it answers, the cards are exactly those of the whole projection;
 * `live-tail.test.ts` compares the two.
 */
import type { AssistantMessage, ChatEntry } from "./messages.ts";
import type { ActiveTool, PendingRow } from "./pending.ts";
import { positionTranscript, type EphemeralItem, type TranscriptPosition } from "./projection.ts";
import { splitClearedHistory, type ClearedHistorySplit } from "./cleared-history.ts";
import { projectTranscript, type TranscriptCard, type TranscriptProjectionOptions } from "./transcript.ts";
import { entryMessage } from "./messages.ts";

/** What the transcript is projected from, apart from the reply that is streaming. */
export interface TranscriptSources {
	entries: readonly ChatEntry[];
	durableCount: number;
	pending: ReadonlyMap<string, PendingRow>;
	ephemeral: readonly EphemeralItem[];
	durablePositions?: ReadonlyMap<string, TranscriptPosition>;
	olderCount: number;
	activeTools: ReadonlyMap<string, ActiveTool>;
	working: boolean;
	retrySuppressedIds?: readonly string[];
	sealedSeq?: number;
	cwd?: string;
}

/** The reply that is streaming: its message, the id of its request and the place it was anchored at when it began. */
export interface LiveMessage { message: AssistantMessage; messageId: string; position: TranscriptPosition }

/** A projected transcript, from the whole projection or from a stable one with the live reply appended. */
export interface ProjectedTranscript {
	/** The display rows after the last context reset (all of them when there was none): what the cards were folded from. */
	cleared: ClearedHistorySplit | null;
	canonical: TranscriptCard[];
	/** The entries the turn totals and served-model checks are read from. Under {@link appendLive} the stable ones: a reply still running has no footer, so its own usage is not needed. */
	totals: readonly ChatEntry[];
}

/** A transcript projected without the live reply, and what {@link appendLive} needs to know of it. */
export interface StableTranscript extends ProjectedTranscript {
	/** The display order of the entries, the live reply not in it. */
	positioned: readonly ChatEntry[];
	/** Ids of the entries, and of the tool calls and results they carry. */
	entryIds: ReadonlySet<string>;
	toolIds: ReadonlySet<string>;
	/** Ids that something is anchored to: a pending row, a notice or a positioned durable row. */
	anchored: ReadonlySet<string>;
}

function optionsOf(sources: TranscriptSources, stream: AssistantMessage | null, streamId: string | null): TranscriptProjectionOptions {
	return { pending: sources.pending, activeTools: sources.activeTools, working: sources.working, stream, streamId, retrySuppressedIds: sources.retrySuppressedIds, sealedSeq: sources.sealedSeq, cwd: sources.cwd };
}

/** Everything projected together: the live reply (when there is one with a place) is a row among the others. */
export function projectWhole(sources: TranscriptSources, live: LiveMessage | null, stream: AssistantMessage | null, streamId: string | null): ProjectedTranscript {
	const positioned = positionTranscript(sources.entries, sources.durableCount, sources.pending, sources.ephemeral, live, sources.durablePositions);
	const cleared = splitClearedHistory(positioned, sources.olderCount);
	const shown = cleared?.after ?? positioned;
	return { cleared, canonical: projectTranscript(shown, optionsOf(sources, live === null ? stream : null, streamId)), totals: shown };
}

/** The transcript without any live reply. */
export function projectStable(sources: TranscriptSources): StableTranscript {
	const positioned = positionTranscript(sources.entries, sources.durableCount, sources.pending, sources.ephemeral, null, sources.durablePositions);
	const cleared = splitClearedHistory(positioned, sources.olderCount);
	const shown = cleared?.after ?? positioned;
	const entryIds = new Set<string>();
	const toolIds = new Set<string>();
	for (const entry of sources.entries) {
		entryIds.add(entry.id);
		const message = entryMessage(entry);
		if (message?.role === "toolResult") toolIds.add(message.toolCallId);
		else if (message?.role === "assistant") for (const block of message.content) if (block.type === "toolCall") toolIds.add(block.id);
	}
	for (const item of sources.ephemeral) entryIds.add(item.id);
	const anchored = new Set<string>();
	for (const row of sources.pending.values()) if (row.anchorId !== null) anchored.add(row.anchorId);
	for (const item of sources.ephemeral) if (item.anchorId !== null) anchored.add(item.anchorId);
	if (sources.durablePositions !== undefined) for (const position of sources.durablePositions.values()) if (position.anchorId !== null) anchored.add(position.anchorId);
	return { cleared, canonical: projectTranscript(shown, optionsOf(sources, null, null)), totals: shown, positioned, entryIds, toolIds, anchored };
}

/**
 * `stable` with the live reply after it, or `null` when the reply is not simply the last thing of the transcript and the
 * whole of it must be projected. `sources` are those `stable` was projected from.
 */
export function appendLive(stable: StableTranscript, sources: TranscriptSources, live: LiveMessage, streamId: string | null): ProjectedTranscript | null {
	// A running tool puts its own card after the reply's.
	if (sources.activeTools.size > 0) return null;
	const id = `live:${live.messageId}`;
	if (stable.entryIds.has(id) || stable.anchored.has(id)) return null;
	// The reply is attached to the row it began under; it is last only when that row is the last one.
	if (live.position.anchorId !== (stable.positioned.at(-1)?.id ?? null)) return null;
	for (const block of live.message.content) {
		if (block.type !== "toolCall") continue;
		// `wait` displaces an earlier poll's card and `todo` replaces an earlier list's, and a call that has a card already is not drawn twice.
		if (block.name === "wait" || block.name === "todo" || stable.toolIds.has(block.id)) return null;
	}
	const entry: ChatEntry = { type: "message", id, parentId: live.position.anchorId, timestamp: new Date(live.message.timestamp).toISOString(), message: live.message };
	const cards = projectTranscript([entry], optionsOf(sources, null, streamId));
	const cleared = stable.cleared === null ? null : { ...stable.cleared, after: [...stable.cleared.after, entry] };
	return { cleared, canonical: [...stable.canonical, ...cards], totals: stable.totals };
}
