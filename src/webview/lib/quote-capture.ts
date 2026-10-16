/**
 * The source Markdown of a selection of Chat text (docs/designs/2026-10-15-quote-chat-selection.md, Section 3). The pure half:
 * it takes the leaf records the renderer kept (`markdown-leaves.ts`) and, for each leaf the selection touches, the part of the
 * leaf's shown text the selection covers, and answers with the Markdown of exactly that part. The DOM half (`quote-selection.ts`)
 * measures the Range.
 *
 * Rules: a token (emphasis, code span, link, autolink) is source only when the selection covers its whole shown text, and its
 * shown text alone when the selection cuts it; a list marker, a heading mark and the indentation come back only when the
 * selection starts at the leaf's shown start; quote prefixes always come back, so a quoted line is quoted again; a code block is
 * re-fenced with a fence longer than any backtick run in it; a table keeps its header and separator. A leaf whose records
 * disagree with what is drawn is not guessed at: it degrades to the text the selection shows, and the caller says so.
 */
import { fenceFor } from "./code-fence.ts";
import { inlinePieces, type InlinePiece } from "./markdown-inline.ts";
import type { Leaf, LeafLine, LeafTable } from "./markdown-leaves.ts";

/** One leaf the selection touches, with the part of its shown text it covers. */
export interface LeafPick {
	readonly leaf: Leaf;
	/** The leaf's shown text: a text leaf's `textContent`, a code leaf's `code` text, empty for a rule or a row. */
	readonly text: string;
	/** The covered part of `text`: `[from, to)`. A rule or a row is taken whole. */
	readonly from: number;
	readonly to: number;
}

export interface QuotedMarkdown {
	readonly markdown: string;
	/** Some leaf degraded to the shown text. */
	readonly plain: boolean;
}

/** `> ` per quote level: what a source line keeps of its own quoting. */
function quotePrefix(levels: number): string {
	return "> ".repeat(levels);
}

/** The text of `source` as the renderer shows it (with or without emphasis), for checking a slice. */
function shownText(source: string, emphasis: boolean): string {
	return inlinePieces(source, emphasis).map(piece => piece.visible).join("");
}

interface Mapped {
	readonly source: string;
	readonly shown: string;
}

/** The source of the shown range `[a, b)` of one line's pieces, and the text that range shows. */
function mapLine(text: string, pieces: readonly InlinePiece[], a: number, b: number): Mapped {
	let source = "";
	let shown = "";
	let at = 0;
	for (const piece of pieces) {
		const end = at + piece.visible.length;
		const lo = Math.max(a, at);
		const hi = Math.min(b, end);
		if (hi > lo) {
			if (!piece.token) {
				source += text.slice(piece.start + (lo - at), piece.start + (hi - at));
				shown += text.slice(piece.start + (lo - at), piece.start + (hi - at));
			} else if (lo === at && hi === end) {
				source += text.slice(piece.start, piece.end);
				shown += piece.visible;
			} else {
				source += piece.visible.slice(lo - at, hi - at);
				shown += piece.visible.slice(lo - at, hi - at);
			}
		}
		at = end;
	}
	return { source, shown };
}

/** Whether a leaf line's text is where the record says it is in the source. */
function lineHolds(lines: readonly string[], line: LeafLine): boolean {
	return lines[line.line]?.startsWith(line.text, line.start) === true;
}

interface Piece {
	readonly lines: string[];
	/** The first and last source line the piece covers, and the quote depth at each end, for joining. */
	readonly first: number;
	readonly last: number;
	readonly firstQuote: number;
	readonly lastQuote: number;
	readonly plain: boolean;
}

function plainPiece(leaf: Leaf, text: string): Piece | null {
	const quote = leaf.lines[0]?.quote ?? 0;
	const lines = text.split("\n").filter(line => line.trim().length > 0).map(line => `${quotePrefix(quote)}${line}`);
	return lines.length === 0 ? null : { lines, first: leaf.first, last: leaf.last, firstQuote: quote, lastQuote: quote, plain: true };
}

function textPiece(source: readonly string[], pick: LeafPick): Piece | null {
	const { leaf } = pick;
	const parsed = leaf.lines.map(line => ({ line, pieces: inlinePieces(line.text, leaf.emphasis) }));
	const shown = parsed.map(entry => entry.pieces.map(piece => piece.visible).join(""));
	if (shown.join("") !== pick.text || !leaf.lines.every(line => lineHolds(source, line))) return plainPiece(leaf, pick.text.slice(pick.from, pick.to));
	const verbatim = pick.from === 0;
	const lines: string[] = [];
	let offset = 0;
	let firstQuote = leaf.lines[0]?.quote ?? 0;
	let first = leaf.first;
	let last = leaf.last;
	parsed.forEach((entry, index) => {
		const length = (shown[index] as string).length;
		const a = Math.max(pick.from, offset) - offset;
		const b = Math.min(pick.to, offset + length) - offset;
		offset += length;
		if (b <= a) return;
		const mapped = mapLine(entry.line.text, entry.pieces, a, b);
		const prefix = verbatim ? (source[entry.line.line] as string).slice(0, entry.line.start) : quotePrefix(entry.line.quote);
		if (lines.length === 0) { firstQuote = entry.line.quote; first = entry.line.line; }
		last = entry.line.line;
		if (shownText(mapped.source, leaf.emphasis) !== mapped.shown) throw new MismatchError();
		lines.push(`${prefix}${mapped.source}`);
	});
	return lines.length === 0 ? null : { lines, first, last, firstQuote, lastQuote: leaf.lines[leaf.lines.length - 1]?.quote ?? firstQuote, plain: false };
}

/** A slice whose tokens do not render back to the text the selection covers: the leaf degrades. */
class MismatchError extends Error {}

function codePiece(source: readonly string[], pick: LeafPick): Piece | null {
	const { leaf } = pick;
	const open = leaf.open;
	const body = leaf.lines.map(line => line.text).join("\n");
	if (open === undefined || body !== pick.text || !leaf.lines.every(line => lineHolds(source, line))) return plainPiece(leaf, pick.text.slice(pick.from, pick.to));
	const selected = pick.text.slice(pick.from, pick.to);
	if (selected.trim().length === 0) return null;
	const rows = selected.split("\n");
	const prefix = quotePrefix(open.quote);
	const bar = prefix.trimEnd();
	const fence = fenceFor(rows);
	const lines = [`${prefix}${fence}${leaf.language ?? ""}`, ...rows.map(row => (row.length === 0 ? bar : `${prefix}${row}`)), `${prefix}${fence}`];
	return { lines, first: leaf.first, last: leaf.last, firstQuote: open.quote, lastQuote: open.quote, plain: false };
}

function rulePiece(leaf: Leaf): Piece | null {
	const line = leaf.lines[0];
	return line === undefined ? null : { lines: [`${quotePrefix(line.quote)}${line.text.trim()}`], first: leaf.first, last: leaf.last, firstQuote: line.quote, lastQuote: line.quote, plain: false };
}

/** A table's lines: the header and separator the first time a row of it is taken, then the row. */
function rowPiece(leaf: Leaf, emitted: Set<LeafTable>): Piece | null {
	const line = leaf.lines[0];
	const table = leaf.table;
	if (line === undefined || table === undefined) return null;
	const lines: string[] = [];
	let first = leaf.first;
	const prefix = quotePrefix(table.header.quote);
	if (!emitted.has(table)) {
		emitted.add(table);
		first = table.header.line;
		lines.push(`${prefix}${table.header.text.trim()}`, `${prefix}${table.separator.text.trim()}`);
	}
	if (leaf.header !== true) lines.push(`${prefix}${line.text.trim()}`);
	return lines.length === 0 ? null : { lines, first, last: leaf.header === true ? table.separator.line : leaf.last, firstQuote: table.header.quote, lastQuote: table.header.quote, plain: false };
}

/** The blank line between two pieces of one surface that are not on neighbouring source lines: a bare line at the shallower quote depth. */
function gapLine(depth: number): string {
	return Array.from({ length: depth }, () => ">").join(" ");
}

/**
 * The Markdown of the covered parts of the leaves of one rendered message, in source order. `source` is the text the message was
 * rendered from, as lines. Pieces on neighbouring source lines join with a line break, others with one blank line.
 */
export function quoteSurface(source: readonly string[], picks: readonly LeafPick[]): QuotedMarkdown {
	const out: string[] = [];
	const emitted = new Set<LeafTable>();
	let plain = false;
	let previous: Piece | null = null;
	for (const pick of picks) {
		let piece: Piece | null;
		try {
			piece = pick.leaf.kind === "text" ? textPiece(source, pick) : pick.leaf.kind === "code" ? codePiece(source, pick) : pick.leaf.kind === "rule" ? rulePiece(pick.leaf) : rowPiece(pick.leaf, emitted);
		} catch (error) {
			if (!(error instanceof MismatchError)) throw error;
			piece = plainPiece(pick.leaf, pick.text.slice(pick.from, pick.to));
		}
		if (piece === null) continue;
		if (piece.plain) plain = true;
		if (previous !== null && piece.first - previous.last > 1) out.push(gapLine(Math.min(previous.lastQuote, piece.firstQuote)));
		out.push(...piece.lines);
		previous = piece;
	}
	return { markdown: out.join("\n"), plain };
}

/** Joins the quoted Markdown of several messages with one empty line. */
export function joinSurfaces(surfaces: readonly QuotedMarkdown[]): QuotedMarkdown {
	const parts = surfaces.filter(surface => surface.markdown.trim().length > 0);
	return { markdown: parts.map(part => part.markdown).join("\n\n"), plain: parts.some(part => part.plain) };
}
