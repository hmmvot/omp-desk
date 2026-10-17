/**
 * The source Markdown of a selection of Chat text (docs/designs/2026-10-15-quote-chat-selection.md, Section 3). The pure half:
 * it takes the leaf records the renderer kept (`markdown-leaves.ts`) and, for each leaf the selection touches, the part of the
 * leaf's shown text the selection covers, and answers with the Markdown of exactly that part. The DOM half (`quote-selection.ts`)
 * measures the Range.
 *
 * Rules: a token (emphasis, code span, link, autolink) is source only when the selection covers its whole shown text, and its
 * shown text alone when the selection cuts it; a list marker, a heading mark and the indentation come back only when the
 * selection starts at the leaf's shown start; quote prefixes always come back, so a quoted line is quoted again; a code block is
 * re-fenced with a fence longer than any backtick run in it; a table is narrowed to what the selection touches (below). A leaf
 * whose records disagree with what is drawn is not guessed at: it degrades to the text the selection shows, and the caller says so.
 *
 * Tables (design amendment 2026-10-17). A selection inside one cell quotes that cell's selected text alone, as a paragraph does. A
 * selection across cells keeps a valid table: the header, the separator and the touched rows, cut to the columns between the
 * start cell and the end cell, the two edge cells cut to the selected text. A selection that starts or ends outside the table
 * (text before it, or after it) takes the touched rows whole, with every column: the part of it outside names no cell to cut at.
 */
import { fenceFor } from "./code-fence.ts";
import { inlinePieces, type InlinePiece } from "./markdown-inline.ts";
import type { Leaf, LeafLine, LeafTable } from "./markdown-leaves.ts";
import { escapeTableCell, splitTableCells, type TableCell } from "./markdown-table.ts";

/** One leaf the selection touches, with the part of its shown text it covers. */
export interface LeafPick {
	readonly leaf: Leaf;
	/** The leaf's shown text: a text leaf's `textContent`, a code leaf's `code` text, empty for a rule or a row. */
	readonly text: string;
	/** The covered part of `text`: `[from, to)`. A rule or a row is taken whole. */
	readonly from: number;
	readonly to: number;
	/** A row: the cells the selection has text in, left to right. A pick without it is taken whole. */
	readonly cells?: readonly CellCover[];
	/** A row: the selection starts or ends outside the table, so the rows are taken whole. A pick without it is taken whole. */
	readonly whole?: boolean;
}

/** The text of one table cell a selection covers. */
export interface CellCover {
	/** The cell's column, counted from the left of the table. */
	readonly column: number;
	/** The cell's shown text and the covered part `[from, to)` of it. */
	readonly text: string;
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

/** The source of the covered part of one cell's text and the text it shows, or `null` when its tokens do not render back to what is covered. */
function cutCell(cell: TableCell, cover: CellCover, emphasis: boolean): Mapped | null {
	if (shownText(cell.text, emphasis) !== cover.text) return null;
	const mapped = mapLine(cell.text, inlinePieces(cell.text, emphasis), cover.from, cover.to);
	return shownText(mapped.source, emphasis) === mapped.shown ? mapped : null;
}

/**
 * A table the selection has text in, cut to what it touches: the covered text of the one cell it lies in, or a table of the rows
 * and columns between its start cell and its end cell. `undefined` when the rows are to be taken whole (the selection reaches
 * outside the table, or the records disagree with what is drawn).
 */
function tableSlice(source: readonly string[], group: readonly LeafPick[]): Piece | null | undefined {
	const table = group[0]?.leaf.table;
	if (table === undefined || group.some(pick => pick.whole !== false || pick.cells === undefined)) return undefined;
	const withText = group.filter(pick => (pick.cells as readonly CellCover[]).length > 0);
	const firstPick = withText[0];
	const lastPick = withText[withText.length - 1];
	if (firstPick === undefined || lastPick === undefined) return undefined;
	const rows = group.slice(group.indexOf(firstPick), group.indexOf(lastPick) + 1);
	const lineOf = (pick: LeafPick): LeafLine | undefined => pick.leaf.lines[0];
	if (!rows.every(pick => { const line = lineOf(pick); return line !== undefined && lineHolds(source, line); }) || !lineHolds(source, table.header) || !lineHolds(source, table.separator)) return undefined;
	const touched = withText.flatMap(pick => (pick.cells as readonly CellCover[]).map(cover => ({ pick, cover })));
	const start = touched[0];
	const end = touched[touched.length - 1];
	if (start === undefined || end === undefined) return undefined;
	const emphasis = firstPick.leaf.emphasis;
	const prefix = quotePrefix(table.header.quote);
	const cellAt = (pick: LeafPick, column: number): TableCell | undefined => splitTableCells((lineOf(pick) as LeafLine).text)[column];

	if (touched.length === 1) {
		const cell = cellAt(start.pick, start.cover.column);
		const covered = start.cover.text.slice(start.cover.from, start.cover.to);
		const cut = cell === undefined ? null : cutCell(cell, start.cover, emphasis);
		if (cut === null) return plainPiece(start.pick.leaf, covered);
		return cut.source.trim().length === 0 ? null : { lines: [`${prefix}${cut.source}`], first: start.pick.leaf.first, last: start.pick.leaf.last, firstQuote: table.header.quote, lastQuote: table.header.quote, plain: false };
	}

	const low = Math.min(start.cover.column, end.cover.column);
	const high = Math.max(start.cover.column, end.cover.column);
	/** A row of the table cut to the columns `low..high`: whole cells as written, the two edge cells cut to the text covered. */
	const rowText = (line: LeafLine): string | undefined => {
		const cells = splitTableCells(line.text);
		const out: string[] = [];
		for (let column = low; column <= high; column++) {
			const cell = cells[column];
			const edge = [start, end].find(entry => lineOf(entry.pick) === line && entry.cover.column === column);
			if (edge === undefined) {
				out.push(cell?.source ?? "");
				continue;
			}
			const cut = cell === undefined ? null : cutCell(cell, edge.cover, emphasis);
			if (cut === null || cell === undefined) return undefined;
			out.push(edge.cover.from === 0 && edge.cover.to === edge.cover.text.length ? cell.source : escapeTableCell(cut.source));
		}
		return `${prefix}| ${out.join(" | ")} |`;
	};
	const separatorCells = splitTableCells(table.separator.text);
	const separator = `${prefix}| ${Array.from({ length: high - low + 1 }, (_, index) => separatorCells[low + index]?.source || "---").join(" | ")} |`;
	const lines = [rowText(table.header), separator, ...rows.filter(pick => pick.leaf.header !== true).map(pick => rowText(lineOf(pick) as LeafLine))];
	if (lines.some(line => line === undefined)) return undefined;
	// A header the selection touches is the header leaf itself, whose line is `table.header`.
	const lastRow = rows[rows.length - 1] as LeafPick;
	return { lines: lines as string[], first: table.header.line, last: lastRow.leaf.header === true ? table.separator.line : lastRow.leaf.last, firstQuote: table.header.quote, lastQuote: table.header.quote, plain: false };
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
	const add = (piece: Piece | null): void => {
		if (piece === null) return;
		if (piece.plain) plain = true;
		if (previous !== null && piece.first - previous.last > 1) out.push(gapLine(Math.min(previous.lastQuote, piece.firstQuote)));
		out.push(...piece.lines);
		previous = piece;
	};
	for (let at = 0; at < picks.length; ) {
		const pick = picks[at] as LeafPick;
		const table = pick.leaf.kind === "row" ? pick.leaf.table : undefined;
		if (table !== undefined) {
			// The rows of one table are neighbours in the picks: they are cut together.
			let upTo = at + 1;
			while (upTo < picks.length && (picks[upTo] as LeafPick).leaf.table === table) upTo++;
			const group = picks.slice(at, upTo);
			at = upTo;
			const slice = tableSlice(source, group);
			if (slice !== undefined) add(slice);
			else for (const row of group) add(rowPiece(row.leaf, emitted));
			continue;
		}
		at++;
		let piece: Piece | null;
		try {
			piece = pick.leaf.kind === "text" ? textPiece(source, pick) : pick.leaf.kind === "code" ? codePiece(source, pick) : pick.leaf.kind === "rule" ? rulePiece(pick.leaf) : rowPiece(pick.leaf, emitted);
		} catch (error) {
			if (!(error instanceof MismatchError)) throw error;
			piece = plainPiece(pick.leaf, pick.text.slice(pick.from, pick.to));
		}
		add(piece);
	}
	return { markdown: out.join("\n"), plain };
}

/** Joins the quoted Markdown of several messages with one empty line. */
export function joinSurfaces(surfaces: readonly QuotedMarkdown[]): QuotedMarkdown {
	const parts = surfaces.filter(surface => surface.markdown.trim().length > 0);
	return { markdown: parts.map(part => part.markdown).join("\n\n"), plain: parts.some(part => part.plain) };
}
