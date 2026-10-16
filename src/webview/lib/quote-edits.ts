/**
 * Keys on a quote line of the composer draft (docs/designs/2026-10-15-quote-chat-selection.md, Section 4, Keys).
 *
 * A quote is prose with a visible `> ` prefix, so `Enter` sends as on every prose line; these rules only keep the
 * prefix whole while the user edits: `Shift+Enter` continues the quote, and `Backspace` and `Delete` take the prefix
 * with them. Every rule reads the line itself (nothing is stored), reads plain keys only, and returns `null` when the
 * browser's own behaviour is the right one. Pure text arithmetic: the composer applies an {@link TextEdit} as one undo step.
 */
import type { TextEdit } from "./code-fence.ts";
import { quotePrefixLength, type QuoteLayout, lineIndexAt } from "./quote-lines.ts";

/** The modifiers of a key press that matter here. */
export interface QuoteKey {
	readonly key: string;
	readonly shiftKey: boolean;
	readonly ctrlKey: boolean;
	readonly altKey: boolean;
	readonly metaKey: boolean;
}

function lineBounds(text: string, offset: number): { start: number; end: number } {
	const newline = text.indexOf("\n", offset);
	return { start: offset === 0 ? 0 : text.lastIndexOf("\n", offset - 1) + 1, end: newline < 0 ? text.length : newline };
}

/** The prefix with its last nesting level taken off: `> > ` keeps `> `; `>> ` keeps `> `. */
function outerPrefix(prefix: string): string {
	const kept = prefix.slice(0, prefix.lastIndexOf(">"));
	return kept.length > 0 && !/[ \t]$/.test(kept) ? `${kept} ` : kept;
}

/**
 * The edit a key makes on a quote line, or `null` when the key is not ours or the browser's behaviour is right.
 * `layout` is the quote layout of `text`; a line in a top-level fenced block is never a quote line, so the code keys keep it.
 */
export function quoteKeyEdit(text: string, layout: QuoteLayout, key: QuoteKey, start: number, end: number): TextEdit | null {
	if (key.ctrlKey || key.altKey || key.metaKey) return null;
	const line = lineBounds(text, start);
	if (layout.lines[lineIndexAt(text, start)]?.quote !== true) return null;
	const prefixLength = quotePrefixLength(text.slice(line.start, line.end));
	if (prefixLength === null) return null;
	const prefixEnd = line.start + prefixLength;
	if (key.key === "Enter") {
		if (!key.shiftKey || start < prefixEnd) return null;
		// An empty quote line with the caret at its end leaves the quote: the line becomes an empty line, the caret the next one.
		if (start === end && start === line.end && text.slice(prefixEnd, line.end).trim() === "") {
			return { from: line.start, to: start, insert: "\n", selectionStart: line.start + 1, selectionEnd: line.start + 1 };
		}
		const insert = `\n${text.slice(line.start, prefixEnd)}`;
		return { from: start, to: end, insert, selectionStart: start + insert.length, selectionEnd: start + insert.length };
	}
	if (key.shiftKey || start !== end) return null;
	if (key.key === "Backspace" && start === prefixEnd) {
		const prefix = text.slice(line.start, prefixEnd);
		const outer = prefix.indexOf(">") === prefix.lastIndexOf(">") ? "" : outerPrefix(prefix);
		return { from: line.start, to: prefixEnd, insert: outer, selectionStart: line.start + outer.length, selectionEnd: line.start + outer.length };
	}
	if (key.key === "Delete" && start === line.end && line.end < text.length) {
		const next = lineBounds(text, line.end + 1);
		if (layout.lines[lineIndexAt(text, line.end + 1)]?.quote !== true) return null;
		const nextPrefix = quotePrefixLength(text.slice(next.start, next.end));
		if (nextPrefix === null) return null;
		return { from: line.end, to: next.start + nextPrefix, insert: "", selectionStart: line.end, selectionEnd: line.end };
	}
	return null;
}
