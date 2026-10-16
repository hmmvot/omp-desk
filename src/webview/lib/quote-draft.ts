/**
 * Putting a quote into the composer draft and taking one out (docs/designs/2026-10-15-quote-chat-selection.md,
 * Sections 2 and 4). Pure text arithmetic: the composer applies the edit as one undo step.
 *
 * A quote is the string `Q + "\n"`, where `Q` is the quoted Markdown's lines each prefixed `> `. It always lands at the
 * end of the draft and the caret is left on the line right under it, so the comment is written straight under the quote.
 * A blank line goes before it, which is also what keeps two quotes two runs.
 */
import { MAX_CHAT_TEXT_LENGTH } from "../../protocol/chat-messages.ts";
import { findFencedBlocks } from "./code-fence.ts";
import type { QuoteRun } from "./quote-lines.ts";

/**
 * `[Image #N…]` becomes `[image #N…]`. The marker grammar and the transcript's inline grammar are case sensitive, so a quoted
 * marker neither pairs with an image attached to the new draft nor renders in the sent message as a button for the wrong image.
 */
export function neutraliseImageMarkers(markdown: string): string {
	return markdown.replace(/\[Image #(?=[1-9])/g, "[image #");
}

/** The quote's lines: `> ` before each non-empty line and a bare `>` for an empty one (no trailing blank). */
export function quoteBlock(markdown: string): string {
	return neutraliseImageMarkers(markdown.replace(/\r\n?/g, "\n").replace(/\n+$/, ""))
		.split("\n")
		.map(line => (line.length === 0 ? ">" : `> ${line}`))
		.join("\n");
}

/** How many lines a quote block has. */
export function quoteLineCount(block: string): number {
	return block.split("\n").length;
}

export interface PlacedQuote {
	/** Where the draft ends; the edit replaces nothing. */
	readonly from: number;
	readonly to: number;
	readonly insert: string;
	/** The caret after the edit: the new end of the draft, on the line under the quote. */
	readonly caret: number;
}

/**
 * The edit that appends `block` (from {@link quoteBlock}) to `text`, or `null` when the draft would pass the length the host
 * accepts. `prefix` depends on the line breaks at the very end of the draft: none gets a blank line, one gets one more, two or
 * more nothing; an empty draft nothing. A draft that ends inside an unclosed fenced block is closed first, so a quote never
 * lands inside code.
 */
export function placeQuote(text: string, block: string): PlacedQuote | null {
	let trailing = 0;
	while (trailing < text.length && text[text.length - 1 - trailing] === "\n") trailing++;
	let prefix = text.length === 0 ? "" : "\n".repeat(Math.max(0, 2 - trailing));
	const open = findFencedBlocks(text).find(candidate => candidate.closeStart === null);
	if (open !== undefined) prefix = `${trailing === 0 ? "\n" : ""}${"`".repeat(open.fenceLength)}\n\n`;
	const insert = `${prefix}${block}\n`;
	if (text.length + insert.length > MAX_CHAT_TEXT_LENGTH) return null;
	return { from: text.length, to: text.length, insert, caret: text.length + insert.length };
}

/** The range a Remove quote click deletes: the run and the one line break after it, when there is one. */
export function removalRange(text: string, run: QuoteRun): { from: number; to: number } {
	return { from: run.start, to: run.end + (text[run.end] === "\n" ? 1 : 0) };
}

/** The words of the Remove quote button's name: the first words of the quote, without the prefixes. */
export function quoteTitle(text: string, run: QuoteRun): string {
	for (const line of text.slice(run.start, run.end).split("\n")) {
		const words = line.replace(/^[ >\t]+/, "").trim().replace(/\s+/g, " ");
		if (words.length === 0) continue;
		return words.length > 40 ? `${words.slice(0, 40).trimEnd()}…` : words;
	}
	return "empty quote";
}
