/**
 * Fenced code blocks in the composer draft (docs/designs/2026-10-15-composer-code-blocks.md).
 *
 * A block opens at a line of three or more backticks (up to three blanks of indentation, an optional
 * info string without backticks) and closes at the first later line made of at least as many backticks
 * and trailing blanks only, or runs to the end of the draft while unclosed: CommonMark's reading, so the
 * message is understood the same way by the model and by the transcript. Everything here is pure text
 * arithmetic over the textarea's `\n`-normalised value; the composer applies an {@link TextEdit}
 * through the editing command stack so Undo covers it.
 */

/** One indentation step: four spaces, never a tab character (docs: "Indentation"). */
export const CODE_INDENT = "    ";
const TAB_STOP = CODE_INDENT.length;

export interface FencedBlock {
	/** First character of the opening fence line. */
	readonly start: number;
	/** End (exclusive, before the newline) of the opening fence line. */
	readonly openEnd: number;
	/** Length of the opening backtick run; a closing fence needs at least as many. */
	readonly fenceLength: number;
	/** First character of the closing fence line, or `null` while the block is unclosed. */
	readonly closeStart: number | null;
	/** End (exclusive) of the closing fence line, or the end of the draft when unclosed. */
	readonly end: number;
}

const OPENING = /^ {0,3}(`{3,})[^`]*$/;
const CLOSING = /^ {0,3}(`{3,})[ \t]*$/;

/** Every fenced block of `text`, in order. */
export function findFencedBlocks(text: string): FencedBlock[] {
	const blocks: FencedBlock[] = [];
	let open: { start: number; openEnd: number; fenceLength: number } | null = null;
	let lineStart = 0;
	while (lineStart <= text.length) {
		const newline = text.indexOf("\n", lineStart);
		const lineEnd = newline < 0 ? text.length : newline;
		const line = text.slice(lineStart, lineEnd);
		if (open === null) {
			const match = OPENING.exec(line);
			if (match !== null) open = { start: lineStart, openEnd: lineEnd, fenceLength: match[1]!.length };
		} else {
			const match = CLOSING.exec(line);
			if (match !== null && match[1]!.length >= open.fenceLength) {
				blocks.push({ ...open, closeStart: lineStart, end: lineEnd });
				open = null;
			}
		}
		if (newline < 0) break;
		lineStart = newline + 1;
	}
	if (open !== null) blocks.push({ ...open, closeStart: null, end: text.length });
	return blocks;
}

/** The block that holds the whole selection `[start, end]` (fence lines included), or `null`. */
export function blockContaining(blocks: readonly FencedBlock[], start: number, end = start): FencedBlock | null {
	for (const block of blocks) {
		if (start >= block.start && end <= block.end) return block;
		if (block.start > end) break;
	}
	return null;
}

/** One replacement of `[from, to)` by `insert`, and the selection to restore afterwards. */
export interface TextEdit {
	readonly from: number;
	readonly to: number;
	readonly insert: string;
	readonly selectionStart: number;
	readonly selectionEnd: number;
}

function lineStartOf(text: string, offset: number): number {
	return text.lastIndexOf("\n", offset - 1) + 1;
}

function lineEndOf(text: string, offset: number): number {
	const newline = text.indexOf("\n", offset);
	return newline < 0 ? text.length : newline;
}

function isFenceLine(block: FencedBlock, lineStart: number): boolean {
	return lineStart === block.start || lineStart === block.closeStart;
}

/**
 * `Enter` inside `block`: a newline that keeps the leading blanks of the caret's line (up to the caret).
 * At the end of an unclosed opening fence line it also supplies the closing fence, in the same edit, with
 * the caret left on the empty line between the two.
 */
export function newlineEdit(text: string, block: FencedBlock, start: number, end: number): TextEdit {
	const lineStart = lineStartOf(text, start);
	if (lineStart === block.start && start === end && start === block.openEnd && block.closeStart === null) {
		const insert = `\n\n${"`".repeat(block.fenceLength)}`;
		return { from: start, to: end, insert, selectionStart: start + 1, selectionEnd: start + 1 };
	}
	const indent = isFenceLine(block, lineStart) ? "" : /^[ \t]*/.exec(text.slice(lineStart, start))![0];
	const caret = start + 1 + indent.length;
	return { from: start, to: end, insert: `\n${indent}`, selectionStart: caret, selectionEnd: caret };
}

/** The lines `[from, to)` an indent or outdent over `[start, end]` covers: the touched lines, minus a last line the selection only reaches the start of. */
function touchedLines(text: string, start: number, end: number): { from: number; to: number } {
	const from = lineStartOf(text, start);
	const lastStart = lineStartOf(text, end);
	const to = end > start && end === lastStart ? end - 1 : lineEndOf(text, end);
	return { from, to: Math.max(from, to) };
}

/**
 * `Tab` inside `block`, or `null` when it should change nothing (a collapsed or single-line selection on a
 * fence line, where four more columns would end the block). A selection that spans lines indents each
 * non-blank, non-fence line it touches by {@link CODE_INDENT}; anything else inserts spaces up to the next
 * tab stop in place of the selection.
 */
export function indentEdit(text: string, block: FencedBlock, start: number, end: number): TextEdit | null {
	const spansLines = text.slice(start, end).includes("\n");
	if (!spansLines) {
		const lineStart = lineStartOf(text, start);
		if (isFenceLine(block, lineStart)) return null;
		const insert = " ".repeat(TAB_STOP - ((start - lineStart) % TAB_STOP));
		const caret = start + insert.length;
		return { from: start, to: end, insert, selectionStart: caret, selectionEnd: caret };
	}
	const range = touchedLines(text, start, end);
	const lines = text.slice(range.from, range.to).split("\n");
	const inserts: number[] = [];
	let offset = range.from;
	const next = lines.map(line => {
		const changes = line.length > 0 && !isFenceLine(block, offset);
		if (changes) inserts.push(offset);
		offset += line.length + 1;
		return changes ? CODE_INDENT + line : line;
	});
	if (inserts.length === 0) return null;
	const moved = (position: number): number => position + CODE_INDENT.length * inserts.filter(at => at < position).length;
	return { from: range.from, to: range.to, insert: next.join("\n"), selectionStart: moved(start), selectionEnd: moved(end) };
}

/**
 * `Shift+Tab` inside `block`, or `null` when nothing would change: a tab, or the leading spaces back to the
 * previous tab stop (a whole step when already on one), come off the caret's line or off every touched
 * non-fence line of a selection.
 */
export function outdentEdit(text: string, block: FencedBlock, start: number, end: number): TextEdit | null {
	const range = touchedLines(text, start, end);
	const lines = text.slice(range.from, range.to).split("\n");
	const removals: { at: number; length: number }[] = [];
	let offset = range.from;
	const next = lines.map(line => {
		let length = 0;
		if (!isFenceLine(block, offset)) {
			if (line.startsWith("\t")) length = 1;
			else {
				let spaces = 0;
				while (line[spaces] === " ") spaces++;
				length = Math.min(spaces, spaces % TAB_STOP || TAB_STOP);
			}
		}
		if (length > 0) removals.push({ at: offset, length });
		offset += line.length + 1;
		return line.slice(length);
	});
	if (removals.length === 0) return null;
	const moved = (position: number): number => position - removals.reduce((sum, removal) => sum + Math.min(Math.max(position - removal.at, 0), removal.length), 0);
	return { from: range.from, to: range.to, insert: next.join("\n"), selectionStart: moved(start), selectionEnd: moved(end) };
}

/** A piece of the draft for the highlight layer: ordinary text or a fenced block, without the newline that separates it from the next piece. */
export interface DraftPiece {
	readonly block: boolean;
	readonly start: number;
	readonly end: number;
}

/**
 * Splits the draft at its fenced blocks. The newline before and after a block belongs to neither piece:
 * the layer renders each piece as a block-level box, and the box boundary is that line break, so exactly
 * one newline separates two boxes. A piece may be empty (an empty line next to a block); two adjacent
 * blocks have no piece between them.
 */
export function draftPieces(text: string, blocks: readonly FencedBlock[]): DraftPiece[] {
	const pieces: DraftPiece[] = [];
	let cursor = 0;
	for (const block of blocks) {
		if (block.start > cursor) pieces.push({ block: false, start: cursor, end: block.start - 1 });
		pieces.push({ block: true, start: block.start, end: block.end });
		cursor = block.end + 1;
	}
	if (cursor <= text.length) pieces.push({ block: false, start: cursor, end: text.length });
	return pieces;
}
