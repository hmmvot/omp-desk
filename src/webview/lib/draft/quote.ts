/**
 * Quoting into the draft (docs/designs/2026-10-15-quote-chat-selection.md, Section 2; docs/designs/2026-10-23-composer-draft-module.md,
 * section 4, rows `quote` and `removeQuote`): the refusals, the edit and the notice sentences in one place. A quote is `> `-prefixed
 * text at the end of the draft; nothing about it is stored beside the string.
 */
import { quoteSizeRefusal } from "../../../shared/quote-limit.ts";
import { findFencedBlocks } from "../code-fence.ts";
import type { Op } from "./field.ts";
import { placeQuote, quoteBlock, quoteLineCount, removalRange } from "./quote-draft.ts";
import { findQuoteRuns } from "./quote-lines.ts";

/**
 * What to quote: the Markdown of a selection (`plain`: some part of it could only be quoted as the text it shows); the quotes of an
 * editor (`sources`: one Markdown per selection, each its own quote, and `size` the characters of the selected text, which the
 * size limit counts); or nothing, with the words that say why.
 */
export type QuoteRequest =
	| { readonly kind: "selection"; readonly source: string; readonly plain: boolean }
	| { readonly kind: "editor"; readonly sources: readonly string[]; readonly size: number }
	| { readonly kind: "nothing"; readonly message: string };

/** What only the page knows when a quote is judged. */
export interface QuoteContext {
	/** The session can take a message. */
	readonly writable: boolean;
	/** The session has not settled yet (starting, attaching, resyncing): a host-sent quote waits for it instead of being refused. */
	readonly settling: boolean;
}

/** What a quote came to: a sentence for the page's notices, a request to hold until the session settles, or nothing to say. */
export type QuoteResult =
	| { readonly kind: "notice"; readonly text: string; readonly level: "info" | "warn" }
	| { readonly kind: "hold" }
	| { readonly kind: "none" };

/** Said when the hand-off holds the draft, or the field refused the edit. */
export const QUOTE_HELD_NOTICE = "Your draft is being moved to a new editor; quote again in a moment";

function warn(text: string): { change: null; result: QuoteResult } {
	return { change: null, result: { kind: "notice", text, level: "warn" } };
}

/**
 * Places `request` at the end of the draft as one undoable step, the caret on the line under it, or says why not, in this order: nothing
 * to quote; an empty selection; a host-sent quote while the session is settling (hold it); no field or a session that cannot take a
 * message; a quote over the size limit; a draft that would pass the length the host accepts. A blank line goes before it, which is
 * also what keeps two quotes two runs.
 */
export function quote(request: QuoteRequest, context: QuoteContext): Op<QuoteResult> {
	return (draft, at) => {
		if (request.kind === "nothing") return warn(request.message);
		const sources = request.kind === "selection" ? [request.source] : request.sources;
		if (sources.every(source => source.trim().length === 0)) return warn(request.kind === "selection" ? "Select text in the conversation first" : "Select some text first");
		if (request.kind === "editor" && context.settling) return { change: null, result: { kind: "hold" } };
		if (!at.mounted || !context.writable) return warn("This session cannot take a message");
		const tooLong = quoteSizeRefusal(request.kind === "selection" ? request.source.length : request.size);
		if (tooLong !== null) return warn(tooLong);
		const block = sources.map(quoteBlock).join("\n\n");
		const placed = placeQuote(draft.text, block);
		if (placed === null) return warn("That would make the draft longer than OMP Desk can send");
		const lines = quoteLineCount(block);
		const plain = request.kind === "selection" && request.plain;
		return {
			change: {
				draft: { ...draft, text: draft.text.slice(0, placed.from) + placed.insert + draft.text.slice(placed.to) },
				writes: [{ kind: "edit", edit: { from: placed.from, to: placed.to, insert: placed.insert, selection: { anchor: placed.caret, focus: placed.caret } }, as: "replace", focus: true }],
			},
			result: { kind: "notice", text: plain ? `Quoted ${lines} line${lines === 1 ? "" : "s"} as plain text` : `Quoted ${lines} line${lines === 1 ? "" : "s"} into the draft`, level: "info" },
		};
	};
}

/**
 * Remove quote: the run that starts at `start` and its line break, one undo step. The field takes the focus, the caret where the quote
 * was: the button that was pressed is gone (and a press on it never moved the focus into the field), so without this the focus would sit
 * on the page body and Ctrl+Z would reach nobody.
 */
export function removeQuote(start: number): Op<void> {
	return (draft, at) => {
		if (!at.mounted) return null;
		const run = findQuoteRuns(draft.text, findFencedBlocks(draft.text)).runs.find(candidate => candidate.start === start);
		if (run === undefined) return null;
		const range = removalRange(draft.text, run);
		return {
			change: {
				draft: { ...draft, text: draft.text.slice(0, range.from) + draft.text.slice(range.to) },
				writes: [{ kind: "edit", edit: { from: range.from, to: range.to, insert: "", selection: { anchor: range.from, focus: range.from } }, as: "replace", focus: true }],
			},
			result: undefined,
		};
	};
}
