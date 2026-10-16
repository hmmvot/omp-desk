/**
 * Keys on a quote line of the composer draft (docs/designs/2026-10-15-quote-chat-selection.md, Section 4, Keys).
 *
 * A quote is prose with a visible `> ` prefix, so `Enter` sends as on every prose line; these rules only keep the
 * prefix whole while the user edits: `Shift+Enter` continues the quote, and `Backspace` and `Delete` take the prefix
 * with them. Every rule reads the line itself (nothing is stored), reads plain keys only, and returns `null` when the
 * browser's own behaviour is the right one. Pure text arithmetic: the composer applies an {@link TextEdit} as one undo step.
 */
import type { TextEdit } from "./code-fence.ts";
import { normalizeLineEndings } from "./draft-text.ts";
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

/**
 * The edit of pasting (or dropping, or inserting) `pasted` over `[start, end)`, or `null` when the plain insert is right.
 *
 * Pasted text with a line break, landing on a quote line at or after the end of its prefix, stays in the quote: every
 * line after the first gets the prefix of the line where the selection starts, the whole of it (`> > `, `  > `), so the
 * result is one undo step (the caller applies the edit as one). The rules:
 *
 * - Line endings are normalised first (CRLF and a lone CR are line breaks).
 * - A pasted line that already is a quote line (it starts with the prefix grammar) is left as it is: prefixing it again
 *   would nest a quote the user pasted as a quote. When the first pasted line is one too and nothing sits between the
 *   prefix and the selection start, the pasted block replaces the line's own prefix, so `> a\n> b` pasted after `> `
 *   gives `> a` and `> b`, not `> > a`.
 * - An empty pasted line becomes the bare `>` of the capture (the prefix without its trailing blank); the last pasted
 *   line, where the caret lands, keeps the full prefix so the caret is on an ordinary empty quote line.
 * - The prefix is the one of the line the selection starts on, even when the selection reaches into lines that are not
 *   quote lines (they are replaced, and the text after the selection joins the last pasted line, as it does when typing).
 * - A selection start before the end of the prefix (column 0, inside it), a line outside a quote, and a top-level fenced
 *   block are a normal paste; so is a paste without a line break. A nested fence inside a quote is a quote line and keeps the prefix.
 */
export function quotePasteEdit(text: string, layout: QuoteLayout, pasted: string, start: number, end: number): TextEdit | null {
	const normalized = normalizeLineEndings(pasted);
	if (!normalized.includes("\n")) return null;
	if (layout.lines[lineIndexAt(text, start)]?.quote !== true) return null;
	const line = lineBounds(text, start);
	const prefixLength = quotePrefixLength(text.slice(line.start, line.end));
	if (prefixLength === null) return null;
	const prefixEnd = line.start + prefixLength;
	if (start < prefixEnd) return null;
	const prefix = text.slice(line.start, prefixEnd);
	const bar = prefix.trimEnd();
	const lines = normalized.split("\n");
	const from = start === prefixEnd && quotePrefixLength(lines[0]!) !== null ? line.start : start;
	const last = lines.length - 1;
	const insert = lines
		.map((row, index) => {
			if (index === 0) return row;
			if (row === "") return index === last ? prefix : bar;
			return quotePrefixLength(row) !== null ? row : `${prefix}${row}`;
		})
		.join("\n");
	const caret = from + insert.length;
	return { from, to: end, insert, selectionStart: caret, selectionEnd: caret };
}
