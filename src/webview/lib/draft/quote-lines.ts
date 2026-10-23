/**
 * Quote bands in the composer draft (docs/designs/2026-10-15-quote-chat-selection.md, Section 4).
 *
 * A quote is plain text: lines that start with `>`. This module only *reads* the draft: which lines are quote lines,
 * which runs they form, and which of their lines hold a fenced block nested in the quote. The surface draws a band
 * from these flags exactly as it draws one from the fenced blocks; nothing here is stored, so the string stays the
 * single source of truth.
 */
import { fenceCloses, fenceOpening, type FencedBlock } from "../code-fence.ts";

/** The prefix of a quote line: up to three blanks, one `>` per nesting level, each optionally followed by one blank. */
const QUOTE_PREFIX = /^ {0,3}>(?:[ \t]?>)*[ \t]?/;

/** The length of the prefix of `line`, or `null` when it is not a quote line. */
export function quotePrefixLength(line: string): number | null {
	const match = QUOTE_PREFIX.exec(line);
	return match === null ? null : match[0].length;
}

/** What the surface needs to know about one line. */
export interface QuoteLineFlags {
	/** The line is a quote line outside every top-level fenced block. */
	readonly quote: boolean;
	/** The line is part of a fenced block nested in a quote (its fences included): it takes the code font and no band of its own. */
	readonly code: boolean;
}

const PLAIN: QuoteLineFlags = { quote: false, code: false };
const QUOTED: QuoteLineFlags = { quote: true, code: false };
const QUOTED_CODE: QuoteLineFlags = { quote: true, code: true };

/** Consecutive quote lines. Offsets are in the draft; `end` is exclusive and sits before the run's last line break. */
export interface QuoteRun {
	readonly firstLine: number;
	readonly lastLine: number;
	readonly start: number;
	readonly end: number;
}

export interface QuoteLayout {
	readonly runs: readonly QuoteRun[];
	/** One entry per line of the draft, in order. */
	readonly lines: readonly QuoteLineFlags[];
}

/**
 * The quote runs of `text` and the per-line flags. A line inside a top-level fenced block is code, never a quote; a blank
 * line or any line without the prefix ends a run, which is where the transcript renderer ends a quote too. Inside a run
 * the content after each prefix is scanned with the composer's own fence grammar; an unclosed nested fence runs to the
 * end of its run.
 */
export function findQuoteRuns(text: string, fenced: readonly FencedBlock[]): QuoteLayout {
	const runs: QuoteRun[] = [];
	const lines: QuoteLineFlags[] = [];
	let lineStart = 0;
	let lineIndex = 0;
	let block = 0;
	let run: { firstLine: number; start: number; end: number } | null = null;
	let nestedFence: number | null = null;
	const endRun = (): void => {
		if (run !== null) runs.push({ firstLine: run.firstLine, lastLine: lineIndex - 1, start: run.start, end: run.end });
		run = null;
		nestedFence = null;
	};
	for (;;) {
		const newline = text.indexOf("\n", lineStart);
		const lineEnd = newline < 0 ? text.length : newline;
		while (block < fenced.length && fenced[block]!.end < lineStart) block++;
		const current = block < fenced.length ? fenced[block]! : null;
		const inBlock = current !== null && lineStart >= current.start && lineStart <= current.end;
		const line = text.slice(lineStart, lineEnd);
		const prefix = inBlock ? null : quotePrefixLength(line);
		if (prefix === null) {
			endRun();
			lines.push(PLAIN);
		} else {
			if (run === null) run = { firstLine: lineIndex, start: lineStart, end: lineEnd };
			run.end = lineEnd;
			const content = line.slice(prefix);
			let code = nestedFence !== null;
			if (nestedFence === null) {
				const opening = fenceOpening(content);
				if (opening !== null) {
					nestedFence = opening;
					code = true;
				}
			} else if (fenceCloses(content, nestedFence)) {
				nestedFence = null;
			}
			lines.push(code ? QUOTED_CODE : QUOTED);
		}
		if (newline < 0) break;
		lineStart = newline + 1;
		lineIndex++;
	}
	lineIndex++;
	endRun();
	return { runs, lines };
}

/** The index of the line that holds `offset` (an offset at a line break belongs to the line before it). */
export function lineIndexAt(text: string, offset: number): number {
	let index = 0;
	for (let at = text.indexOf("\n"); at >= 0 && at < offset; at = text.indexOf("\n", at + 1)) index++;
	return index;
}

/** Whether the line that holds `offset` is a quote line. */
export function isQuoteLineAt(layout: QuoteLayout, text: string, offset: number): boolean {
	return layout.lines[lineIndexAt(text, offset)]?.quote === true;
}
