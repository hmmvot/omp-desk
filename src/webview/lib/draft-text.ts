/**
 * Text arithmetic for the composer's editing surface (docs/designs/2026-10-15-composer-contenteditable-surface.md).
 *
 * The surface normally deletes the range the browser itself computed (`beforeinput`'s `getTargetRanges()`); these
 * functions compute the same range from the model when the event offers none, and normalise pasted text.
 * Everything here is pure over a `\n`-separated string.
 */

/** The kinds of deletion a `beforeinput` `delete*` event names. */
export type DeleteKind = "char-back" | "char-fwd" | "word-back" | "word-fwd" | "line-back" | "line-fwd";

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const WORDS = new Intl.Segmenter(undefined, { granularity: "word" });

/** Line endings of pasted or dropped text, as the draft keeps them. */
export function normalizeLineEndings(text: string): string {
	return text.replace(/\r\n?/g, "\n");
}

export function lineStartOf(text: string, offset: number): number {
	return text.lastIndexOf("\n", offset - 1) + 1;
}

export function lineEndOf(text: string, offset: number): number {
	const newline = text.indexOf("\n", offset);
	return newline < 0 ? text.length : newline;
}

/** Start of the grapheme cluster that ends at `offset` (one character back, a whole emoji or accented letter at once). */
function graphemeBefore(text: string, offset: number): number {
	if (offset <= 0) return 0;
	const start = lineStartOf(text, offset);
	if (offset === start) return offset - 1;
	let previous = start;
	for (const segment of GRAPHEMES.segment(text.slice(start, offset))) previous = start + segment.index;
	return previous;
}

/** End of the grapheme cluster that starts at `offset`. */
function graphemeAfter(text: string, offset: number): number {
	if (offset >= text.length) return text.length;
	if (text[offset] === "\n") return offset + 1;
	const end = lineEndOf(text, offset);
	const first = GRAPHEMES.segment(text.slice(offset, end))[Symbol.iterator]().next();
	return first.done === true ? offset + 1 : offset + first.value.segment.length;
}

/** Start of the word before `offset` on its line: blanks are skipped first, then one word or one run of punctuation goes. */
function wordBefore(text: string, offset: number): number {
	const start = lineStartOf(text, offset);
	if (offset === start) return Math.max(0, offset - 1);
	const segments = [...WORDS.segment(text.slice(start, offset))];
	let index = segments.length - 1;
	while (index > 0 && /^\s+$/.test(segments[index]!.segment)) index--;
	return start + segments[index]!.index;
}

/** End of the word after `offset` on its line: blanks are skipped first, then one word or one run of punctuation goes. */
function wordAfter(text: string, offset: number): number {
	if (offset >= text.length) return text.length;
	if (text[offset] === "\n") return offset + 1;
	const end = lineEndOf(text, offset);
	const segments = [...WORDS.segment(text.slice(offset, end))];
	let index = 0;
	while (index < segments.length - 1 && /^\s+$/.test(segments[index]!.segment)) index++;
	const last = segments[index]!;
	return offset + last.index + last.segment.length;
}

/**
 * The range `[from, to)` a deletion of `kind` removes when the selection is `[start, end]`: a non-empty selection is
 * removed as it is; a caret removes one grapheme, one word or up to the line edge in the direction named, and at a
 * line edge the newline itself. `null` when nothing would be removed.
 */
export function deletionTarget(text: string, start: number, end: number, kind: DeleteKind): { from: number; to: number } | null {
	if (start !== end) return { from: start, to: end };
	let from = start;
	let to = end;
	switch (kind) {
		case "char-back": from = graphemeBefore(text, start); break;
		case "char-fwd": to = graphemeAfter(text, end); break;
		case "word-back": from = wordBefore(text, start); break;
		case "word-fwd": to = wordAfter(text, end); break;
		case "line-back": from = lineStartOf(text, start); if (from === start) from = Math.max(0, start - 1); break;
		case "line-fwd": to = lineEndOf(text, end); if (to === end) to = Math.min(text.length, end + 1); break;
	}
	return from === to ? null : { from, to };
}
