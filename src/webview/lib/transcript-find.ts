/**
 * Find in the conversation: what is searched and how matches are counted.
 *
 * The transcript is windowed (rows off screen are not mounted), so the browser's own find sees only a few rows. This module searches
 * the *model*: every loaded card, as the text the card shows once rendered. A match is the n-th occurrence of the query in one unit
 * (a user message, an assistant text or thinking block, or a tool call); the page then brings that unit's row into the window,
 * opens what hides the text and paints the occurrences that are mounted (`find-dom.ts`).
 *
 * Searched: your messages, assistant replies with their thinking, and each tool call's head (title, target, intent) and output text.
 * Not searched: notices, summaries, attachments' file text, the history before a context reset, rows still on disk, and the reply
 * still being written (it is read once it is complete, not again for every delta).
 */
import { entryMessage, userSkill, type ChatContent } from "../../chat/messages.ts";
import { stripAnsi } from "../../chat/ansi.ts";
import { toolPresentation } from "../../chat/tool-presentation.ts";
import type { ProjectedTool, TranscriptCard } from "../../chat/transcript.ts";
import { messageText } from "../../shared/format.ts";
import { splitUserText } from "./file-block-rows.ts";

/** Which part of a unit a piece of searched text is: it decides what must be opened to see it. */
export type FindPart = "text" | "thinking" | "head" | "output";

export interface FindSegment {
	readonly part: FindPart;
	readonly text: string;
}

/** The searchable text of one row, in the order the row draws it. */
export interface FindUnit {
	/** The row's `data-find-id`: the card id, or `call:<id>` for a tool call. */
	readonly id: string;
	/** The canonical card that holds the unit (for pinning it into the window or its page). */
	readonly cardId: string;
	/** Source identities for the scroll anchor, most specific first. */
	readonly sources: readonly string[];
	/** Set for a tool call. */
	readonly callId?: string;
	readonly segments: readonly FindSegment[];
	/** The count of the last pattern asked of this unit, per segment: units are cached across renders, so a streaming tail is the only one counted again. */
	memo?: { readonly key: string; readonly counts: readonly number[]; readonly total: number };
}

/** Shows the text of Markdown as the renderer draws it (`markdownShownText`); injected so this module has no component imports. */
export type ShownText = (text: string, emphasis: boolean) => string;

/** Characters (source plus shown text) the shown-text cache keeps, per emphasis mode: a few settled long replies, never the prefixes of one being written. */
const SHOWN_CHARS = 2_000_000;
/** The shown text of the newest sources, per emphasis mode (user text, then replies), and the characters each holds. */
const shownCache: { map: Map<string, string>; chars: number }[] = [{ map: new Map(), chars: 0 }, { map: new Map(), chars: 0 }];

/** Forget every cached shown text (the bar closed: nothing needs them until the next search). */
export function clearFindCache(): void {
	for (const cache of shownCache) { cache.map.clear(); cache.chars = 0; }
}

function shown(text: string, emphasis: boolean, markdown: ShownText): string {
	const cache = shownCache[emphasis ? 1 : 0];
	const known = cache.map.get(text);
	if (known !== undefined) return known;
	const value = markdown(text, emphasis);
	const cost = text.length + value.length;
	// A text bigger than the whole budget is not worth evicting everything for.
	if (cost > SHOWN_CHARS / 4) return value;
	cache.map.set(text, value);
	cache.chars += cost;
	for (const [key, held] of cache.map) {
		if (cache.chars <= SHOWN_CHARS) break;
		cache.map.delete(key);
		cache.chars -= key.length + held.length;
	}
	return value;
}

/** The `data-find-id` of the row that draws `card`: a tool call is `call:<id>` whichever card carries it, any other card its own id. */
export function findIdOf(card: TranscriptCard): string {
	return card.kind === "tool" ? `call:${card.tool.call.id}` : card.id;
}

const unitCache = new WeakMap<object, { readonly stamp: readonly unknown[]; readonly unit: FindUnit }>();

/** `unit` when `stamp` still describes it, else `build()` remembered under `key`. */
function cached(key: object, stamp: readonly unknown[], build: () => FindUnit): FindUnit {
	const known = unitCache.get(key);
	if (known !== undefined && known.stamp.length === stamp.length && known.stamp.every((value, index) => value === stamp[index])) return known.unit;
	const unit = build();
	unitCache.set(key, { stamp, unit });
	return unit;
}

function segmentsOf(content: readonly ChatContent[], markdown: ShownText): FindSegment[] {
	const segments: FindSegment[] = [];
	for (const block of content) {
		if (block.type === "text") segments.push({ part: "text", text: shown(block.text, true, markdown) });
		else if (block.type === "thinking" && block.thinking.trim().length > 0) segments.push({ part: "thinking", text: shown(block.thinking, true, markdown) });
	}
	return segments;
}

function toolUnit(tool: ProjectedTool, cardId: string, sources: readonly string[], cwd: string | undefined): FindUnit {
	const args = tool.active?.args ?? tool.call.arguments;
	return cached(tool.call, [tool.result, args, tool.status, cwd], () => {
		const presentation = toolPresentation(tool, cwd);
		const intent = (tool.call.intent ?? tool.active?.intent ?? "").replace(/\s+/g, " ").trim();
		const head = [presentation.title, presentation.target, intent].map(piece => stripAnsi(piece)).filter(piece => piece.length > 0).join("\n");
		const output = tool.result === undefined ? "" : stripAnsi(messageText(tool.result));
		const segments: FindSegment[] = [{ part: "head", text: head }];
		if (output.length > 0) segments.push({ part: "output", text: output });
		return { id: `call:${tool.call.id}`, cardId, sources: [`call:${tool.call.id}`, ...sources], callId: tool.call.id, segments };
	});
}

/** The units of `cards`, oldest first. `markdown` shows Markdown as rendered; `cwd` is the session's folder (tool targets are shown relative to it). */
export function findUnitsOf(cards: readonly TranscriptCard[], cwd: string | undefined, markdown: ShownText): FindUnit[] {
	const units: FindUnit[] = [];
	const calls = new Set<string>();
	for (const card of cards) if (card.kind === "tool") calls.add(card.tool.call.id);
	for (const card of cards) {
		switch (card.kind) {
			case "entry": {
				const message = entryMessage(card.entry);
				if (message?.role === "custom") {
					const invocation = userSkill(message);
					if (invocation === null) break;
					units.push(cached(card.entry, [card.entry], () => ({
						id: card.id, cardId: card.id, sources: [card.id, ...card.sourceIds],
						segments: [{ part: "text", text: shown(splitUserText(invocation.prompt).prose, false, markdown) }],
					})));
					break;
				}
				if (message?.role !== "user" || message.synthetic === true) break;
				const content = message.content;
				units.push(cached(card.entry, [card.entry], () => ({
					id: card.id, cardId: card.id, sources: [card.id, ...card.sourceIds],
					segments: (typeof content === "string" ? [content] : content.flatMap(block => block.type === "text" ? [block.text] : []))
						.map((text): FindSegment => ({ part: "text", text: shown(splitUserText(text).prose, false, markdown) })),
				})));
				break;
			}
			case "assistant": {
				// The reply being written changes with every delta; it is searched once it is complete rather than re-read per delta.
				const first = card.streaming ? undefined : card.content[0];
				if (first === undefined) break;
				units.push(cached(first, [card.id, card.content.length, ...card.content], () => ({
					id: card.id, cardId: card.id, sources: [card.id, ...card.sourceIds], segments: segmentsOf(card.content, markdown),
				})));
				break;
			}
			case "tool": units.push(toolUnit(card.tool, card.id, card.sourceIds, cwd)); break;
			case "results":
				// A result whose call card is loaded is shown by the call card; one whose call is older shows alone.
				for (const tool of card.tools) if (!calls.has(tool.call.id)) units.push(toolUnit(tool, card.id, card.sourceIds, cwd));
				break;
			case "recovery": break;
		}
	}
	return units.filter(unit => unit.segments.some(segment => segment.text.length > 0));
}

/** The pattern a query searches for; `null` for an empty query. Matching is literal (no regular expressions). */
export function findPattern(query: string, caseSensitive: boolean): RegExp | null {
	if (query.length === 0) return null;
	return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), caseSensitive ? "gu" : "giu");
}

function countIn(text: string, pattern: RegExp): number {
	pattern.lastIndex = 0;
	let count = 0;
	while (pattern.exec(text) !== null) count++;
	return count;
}

/** The result of one search over a list of units. */
export interface FindSearch {
	readonly pattern: RegExp | null;
	readonly units: readonly FindUnit[];
	/** Matches in each unit, and the number of matches before it. */
	readonly counts: readonly number[];
	readonly before: readonly number[];
	readonly total: number;
}

export function searchUnits(units: readonly FindUnit[], pattern: RegExp | null): FindSearch {
	const counts: number[] = [], before: number[] = [];
	let total = 0;
	const key = pattern === null ? "" : `${pattern.flags}:${pattern.source}`;
	for (const unit of units) {
		let count = 0;
		if (pattern !== null) {
			if (unit.memo?.key !== key) {
				const perSegment = unit.segments.map(segment => countIn(segment.text, pattern));
				unit.memo = { key, counts: perSegment, total: perSegment.reduce((sum, value) => sum + value, 0) };
			}
			count = unit.memo.total;
		}
		before.push(total);
		counts.push(count);
		total += count;
	}
	return { pattern, units, counts, before, total };
}

/** One match: the n-th occurrence (from 0) in unit `id`. */
export interface FindMatch {
	readonly id: string;
	readonly occurrence: number;
}

/** The match at position `index` (0 to total - 1) in the whole conversation. */
export function matchAt(search: FindSearch, index: number): FindMatch | null {
	if (index < 0 || index >= search.total) return null;
	let low = 0, high = search.units.length - 1;
	while (low < high) {
		const middle = (low + high + 1) >> 1;
		if (search.before[middle]! <= index) low = middle; else high = middle - 1;
	}
	// The last unit that starts at or before `index` always has matches: the next one starts past it.
	return { id: search.units[low]!.id, occurrence: index - search.before[low]! };
}

/** The position of `match` among all matches, or -1 when its unit no longer matches that often. */
export function positionOf(search: FindSearch, match: FindMatch): number {
	const unit = search.units.findIndex(candidate => candidate.id === match.id);
	return unit < 0 || match.occurrence >= search.counts[unit]! ? -1 : search.before[unit]! + match.occurrence;
}

/** The segment (and so the part) of a unit that holds its n-th match. */
export function segmentOf(unit: FindUnit, occurrence: number): FindSegment | null {
	let rest = occurrence;
	const counts = unit.memo?.counts ?? [];
	for (let index = 0; index < unit.segments.length; index++) {
		const count = counts[index] ?? 0;
		if (rest < count) return unit.segments[index]!;
		rest -= count;
	}
	return null;
}
