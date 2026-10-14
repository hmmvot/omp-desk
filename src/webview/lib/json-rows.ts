/**
 * Which rows of a JSON document or of newline-delimited JSON are on screen, given how it is folded; pure, so the
 * component only draws. A row is a number: the row index of a document, or, for records, `record * RECORD + row + 1`
 * (row `0` is the record's own line, `1…` the rows of its tree once it is open).
 */
import type { JsonTree, NdjsonRecord } from "./json-tokens.ts";
import { foldLabel, jsonTree, MAX_ROW_CHARS } from "./json-tokens.ts";
import type { FoldState } from "./tool-view-state.ts";

export type JsonSource =
	| { readonly kind: "json"; readonly tree: JsonTree }
	| { readonly kind: "ndjson"; readonly records: readonly NdjsonRecord[] };

/** A document opens to this depth (its first two levels); a record's tree to its first; records start closed. */
const DEFAULT_DEPTH = { json: 2, record: 1, records: 0 } as const;
const RECORD = 1 << 20;

const NO_FOLD: FoldState = { depth: null, toggled: new Set() };

/** Whether the container a row opens is folded (`level` rows at this depth and deeper start folded, `toggled` rows are the other way round). */
function folded(level: number, row: number, fold: FoldState | undefined, fallback: number): boolean {
	const state = fold ?? NO_FOLD;
	return (level >= (state.depth ?? fallback)) !== state.toggled.has(row);
}

/** The rows of `tree` that show while it is folded as `fold` says: a folded row hides everything up to and including its closing row. */
function visibleTreeRows(tree: JsonTree, fold: FoldState | undefined, fallback: number): number[] {
	const rows: number[] = [];
	for (let row = 0; row < tree.rows.length;) {
		rows.push(row);
		row = tree.end[row]! >= 0 && folded(tree.level[row]!, row, fold, fallback) ? tree.end[row]! + 1 : row + 1;
	}
	return rows;
}

const recordTrees = new WeakMap<NdjsonRecord, JsonTree>();
function treeOfRecord(record: NdjsonRecord): JsonTree {
	let tree = recordTrees.get(record);
	if (tree === undefined) { tree = jsonTree(record.line); recordTrees.set(record, tree); }
	return tree;
}

/** The depth records' trees open to: everything when every record was expanded, else the first level. */
function subDepth(fold: FoldState | undefined): number {
	return fold?.depth === Infinity ? Infinity : DEFAULT_DEPTH.record;
}

/** How a source is folded at first: a document to depth 2, records closed. */
export function defaultDepth(source: JsonSource): number {
	return source.kind === "ndjson" ? DEFAULT_DEPTH.records : DEFAULT_DEPTH.json;
}

/**
 * The rows of a document that contain `filter` (lower case) and the rows that open the containers they are in, for the whole
 * tree and not only the rows a fold leaves visible: a match opens its ancestors for as long as the filter stands.
 */
function filteredTreeRows(tree: JsonTree, filter: string): number[] {
	const keep = new Uint8Array(tree.rows.length);
	tree.rows.forEach((row, index) => {
		if (!row.toLowerCase().includes(filter)) return;
		keep[index] = 1;
		for (let at = tree.enclosing[index]!; at >= 0 && keep[at] === 0; at = tree.enclosing[at]!) keep[at] = 1;
	});
	const rows: number[] = [];
	keep.forEach((flag, index) => { if (flag === 1) rows.push(index); });
	return rows;
}

/** The rows on screen, in order; with a `filter` (lower case) only the lines that contain it, in a document with the containers around them. */
export function visibleRows(source: JsonSource, folds: ReadonlyMap<string, FoldState>, scope: string, fallback: number, filter = ""): number[] {
	if (source.kind === "json") return filter === "" ? visibleTreeRows(source.tree, folds.get(scope), fallback) : filteredTreeRows(source.tree, filter);
	const own = folds.get(scope);
	const rows: number[] = [];
	source.records.forEach((record, index) => {
		const base = index * RECORD;
		if (filter !== "" && !record.line.toLowerCase().includes(filter)) return;
		if (!record.json || folded(0, index, own, DEFAULT_DEPTH.records)) { rows.push(base); return; }
		const tree = treeOfRecord(record);
		for (const row of visibleTreeRows(tree, folds.get(`${scope}#${index}`), subDepth(own))) rows.push(base + row + 1);
	});
	return rows;
}

/** One row as the component draws it. */
export interface JsonDisplayRow {
	readonly key: number;
	/** The row up to and including a fold's opening bracket, or the whole row. */
	readonly text: string;
	/** Characters of the row that are not shown (a row is cut at {@link MAX_ROW_CHARS}). */
	readonly omitted: number;
	/** The record's number, on the row that starts it. */
	readonly gutter?: number;
	/** A row of newline-delimited output that is not JSON. */
	readonly plain: boolean;
	/** A row that opens a container (or, in records, a record): where its fold lives and what a folded one says. */
	readonly fold?: { readonly scope: string; readonly row: number; readonly folded: boolean; readonly label: string; readonly tail: string; readonly noun: string };
}

const cut = (text: string): { text: string; omitted: number } => text.length > MAX_ROW_CHARS ? { text: text.slice(0, MAX_ROW_CHARS), omitted: text.length - MAX_ROW_CHARS } : { text, omitted: 0 };

function treeRow(tree: JsonTree, row: number, scope: string, fold: FoldState | undefined, fallback: number, key: number): JsonDisplayRow {
	const text = tree.rows[row]!;
	if (tree.end[row]! < 0) return { key, ...cut(text), plain: false };
	const isFolded = folded(tree.level[row]!, row, fold, fallback);
	if (!isFolded) return { key, ...cut(text), plain: false, fold: { scope, row, folded: false, label: "", tail: "", noun: foldLabel(tree, row).slice(2) } };
	const closing = tree.rows[tree.end[row]!]!.trim();
	return { key, ...cut(text), plain: false, fold: { scope, row, folded: true, label: foldLabel(tree, row), tail: closing, noun: foldLabel(tree, row).slice(2) } };
}

/** The row `id` of `visibleRows`, ready to draw. */
export function displayRow(source: JsonSource, id: number, folds: ReadonlyMap<string, FoldState>, scope: string, fallback: number, filter = ""): JsonDisplayRow {
	// A filtered document is a list of lines: nothing in it folds.
	if (source.kind === "json" && filter !== "") return { key: id, ...cut(source.tree.rows[id]!), plain: false };
	if (source.kind === "json") return treeRow(source.tree, id, scope, folds.get(scope), fallback, id);
	const index = Math.floor(id / RECORD), row = id % RECORD;
	const record = source.records[index]!;
	const own = folds.get(scope);
	if (!record.json) return { key: id, ...cut(record.line), gutter: index + 1, plain: true };
	if (row === 0) return { key: id, ...cut(record.line.trim()), gutter: index + 1, plain: false, fold: { scope, row: index, folded: true, label: "", tail: "", noun: "record" } };
	const tree = treeOfRecord(record);
	const shown = treeRow(tree, row - 1, `${scope}#${index}`, folds.get(`${scope}#${index}`), subDepth(own), id);
	return row === 1
		// The record's first row is its own fold: it opens and closes the record, the tree's folds start below it.
		? { ...shown, gutter: index + 1, fold: { scope, row: index, folded: false, label: "", tail: "", noun: "record" } }
		: shown;
}

/** The folds after the reader opened or closed one container (or record) `row` of tree `scope`. */
export function toggleFold(folds: ReadonlyMap<string, FoldState>, scope: string, row: number): ReadonlyMap<string, FoldState> {
	const next = new Map(folds);
	const current = folds.get(scope);
	const toggled = new Set(current?.toggled);
	if (!toggled.delete(row)) toggled.add(row);
	next.set(scope, { depth: current?.depth ?? null, toggled });
	return next;
}

/** Every container (record) open, or every one closed down to the first level (records: all closed). */
export function foldAll(folds: ReadonlyMap<string, FoldState>, scope: string, source: JsonSource, expand: boolean): ReadonlyMap<string, FoldState> {
	const next = new Map([...folds].filter(([key]) => key !== scope && !key.startsWith(`${scope}#`)));
	next.set(scope, { depth: expand ? Infinity : source.kind === "ndjson" ? 0 : 1, toggled: new Set() });
	return next;
}

/** Whether the source has anything to fold. */
export function foldable(source: JsonSource): boolean {
	return source.kind === "ndjson" ? source.records.some(record => record.json) : source.tree.foldable;
}
