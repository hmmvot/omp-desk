/** A pinned tail window over the same semantic cards that the DOM renders. */
import type { ChatEntry } from "../../chat/messages.ts";
import { projectTranscript, type TranscriptCard, type TranscriptProjectionOptions } from "../../chat/transcript.ts";

export const TRANSCRIPT_WINDOW_ROWS = 100;
export interface TranscriptWindow {
	readonly rows: readonly TranscriptCard[];
	readonly topId: string | null;
	readonly olderRows: number;
	readonly earlierTopId: string | null;
}
interface WindowWalk { start: number; owned: ReadonlySet<string> }

function cardCost(card: TranscriptCard, owned: ReadonlySet<string>, orphans: ReadonlySet<string>): number {
	return card.kind === "results" ? card.tools.filter(tool => !owned.has(tool.call.id) && !orphans.has(tool.call.id)).length :
		card.kind === "tool" && orphans.has(card.tool.call.id) ? 0 : 1;
}
function claimCard(card: TranscriptCard, owned: Set<string>, orphans: Set<string>): void {
	if (card.kind === "results") for (const tool of card.tools) if (!owned.has(tool.call.id)) orphans.add(tool.call.id);
	if (card.kind === "tool") { owned.add(card.tool.call.id); orphans.delete(card.tool.call.id); }
}

/** Walk backwards, reclaiming each result's individual cost when its calling card arrives. */
function windowStart(cards: readonly TranscriptCard[], bound: number, pin: number): WindowWalk {
	const owned = new Set<string>();
	const orphans = new Set<string>();
	let count = 0;
	let start = cards.length;
	for (let index = cards.length - 1; index >= (pin < 0 ? 0 : pin); index -= 1) {
		const card = cards[index]!;
		const cost = cardCost(card, owned, orphans);
		if (pin < 0 && count + cost > bound) break;
		count += cost;
		claimCard(card, owned, orphans);
		start = index;
	}
	return { start, owned };
}

export function windowTranscriptCards(cards: readonly TranscriptCard[], rows: number, pinnedTopId: string | null): TranscriptWindow {
	const bound = Math.max(0, Math.trunc(rows));
	const pin = pinnedTopId === null ? -1 : cards.findIndex(card => card.id === pinnedTopId || card.sourceIds.includes(pinnedTopId));
	const { start, owned } = windowStart(cards, bound, pin);
	const visible: TranscriptCard[] = [];
	for (let index = start; index < cards.length; index += 1) {
		const card = cards[index]!;
		if (card.kind !== "results") { visible.push(card); continue; }
		const tools = card.tools.filter(tool => !owned.has(tool.call.id));
		if (tools.length === 0) continue;
		for (const tool of tools) visible.push({ kind: "tool", id: tools.length === 1 ? card.id : `${card.id}:${tool.call.id}`, sourceIds: card.sourceIds, tool, ownership: "orphan" });
	}
	let olderRows = 0;
	let earlierTopId: string | null = null;
	for (let index = start - 1; index >= 0; index -= 1) {
		const card = cards[index]!;
		if (card.kind === "results") continue;
		olderRows += 1;
		if (olderRows <= bound) earlierTopId = card.id;
	}
	return { rows: visible, topId: visible[0]?.id ?? null, olderRows, earlierTopId };
}

export function transcriptWindow(entries: readonly ChatEntry[], rows: number, pinnedTopId: string | null, options: TranscriptProjectionOptions = {}): TranscriptWindow {
	return windowTranscriptCards(projectTranscript(entries, options), rows, pinnedTopId);
}

export interface TranscriptPage extends TranscriptWindow {
	readonly endId: string | null;
	readonly previousEndId: string | null;
	readonly nextEndId: string | null;
	readonly newCount: number;
}

/** End bookmarks survive prepends/appends: an earlier reading page never auto-advances. */
export function pageTranscriptCards(cards: readonly TranscriptCard[], bound: number, endId: string | null): TranscriptPage {
	const requested = endId === null ? -1 : cards.findIndex(card => card.id === endId);
	const end = requested < 0 ? cards.length - 1 : requested;
	const view = windowTranscriptCards(cards.slice(0, end + 1), bound, null);
	const first = view.rows[0];
	const start = first ? cards.findIndex(card => card.id === first.id || card.sourceIds.some(id => first.sourceIds.includes(id))) : 0;
	let next = end, count = 0;
	const owned = new Set<string>(), orphans = new Set<string>();
	for (let position = end + 1; position < cards.length; position++) {
		const card = cards[position]!, cost = cardCost(card, owned, orphans);
		if (count + cost > bound) break;
		count += cost; claimCard(card, owned, orphans); next = position;
	}
	return { ...view, endId: cards[end]?.id ?? null, previousEndId: cards[start - 1]?.id ?? null,
		nextEndId: next > end ? cards[next]!.id : null,
		newCount: end < cards.length - 1 ? windowTranscriptCards(cards.slice(end + 1), Number.MAX_SAFE_INTEGER, null).rows.length : 0 };
}
