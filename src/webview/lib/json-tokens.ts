/**
 * JSON in a tool card: a linear lexer over the original text, and the fold tree built from it.
 *
 * ADR-0067 (amendment 2026-10-14): this is not highlight.js and is not subject to the 10,000-character and
 * 400-line caps. One index walks the text once; a string is scanned to its closing quote, a number or a word
 * by character class, punctuation one character at a time. There is no regular expression with a nested
 * quantifier, so there is no backtracking and the cost is linear. The work around it is bounded by
 * {@link MAX_JSON_BYTES} (detection), not by what is on screen.
 *
 * The formatted view is built from the ORIGINAL text, never from `JSON.stringify(JSON.parse(text))`, which
 * loses integers above 2^53, turns `1e400` into `null` and `-0` into `0`. A compact document is re-indented
 * by tokens only (the spelling of every string and number is untouched); an indented one keeps its own rows.
 */
import type { CodeSpan } from "./code-tokens.ts";

/** Detection runs on at most this much text: `JSON.parse` of 4 MiB was measured at 85 to 130 ms, past what one task may take. */
export const MAX_JSON_BYTES = 1_048_576;
/** A row is shown up to this many characters; the rest is one Copy or the Text view away. */
export const MAX_ROW_CHARS = 400;

const SOURCE = "source.json";
const SCOPES = {
	plain: [SOURCE],
	key: [SOURCE, "support.type.property-name.json"],
	string: [SOURCE, "string.quoted.double.json"],
	number: [SOURCE, "constant.numeric.json"],
	constant: [SOURCE, "constant.language.json", "keyword.other.json"],
} as const satisfies Record<string, readonly string[]>;

type TokenKind = "ws" | "string" | "number" | "word" | "punct";
const CODE_QUOTE = 34, CODE_BACKSLASH = 92, CODE_SPACE = 32, CODE_TAB = 9, CODE_LF = 10, CODE_CR = 13;

/** Set by {@link scanToken}: what the token it last scanned is. A module variable, so a token costs no allocation. */
let scannedKind: TokenKind = "punct";

function isDigit(code: number): boolean { return code >= 48 && code <= 57; }
function isLetter(code: number): boolean { return code >= 97 && code <= 122 || code >= 65 && code <= 90; }

/**
 * The end of the token that starts at `from` in `text`; its kind is `scannedKind`. A string that reaches the
 * end of its line without a closing quote (OMP cuts long lines and ends them with `…`) closes there.
 */
function scanToken(text: string, from: number): number {
	const code = text.charCodeAt(from);
	if (code === CODE_SPACE || code === CODE_TAB || code === CODE_LF || code === CODE_CR) {
		let end = from + 1;
		for (; end < text.length; end++) {
			const next = text.charCodeAt(end);
			if (next !== CODE_SPACE && next !== CODE_TAB && next !== CODE_LF && next !== CODE_CR) break;
		}
		scannedKind = "ws";
		return end;
	}
	if (code === CODE_QUOTE) {
		let end = from + 1;
		for (; end < text.length; end++) {
			const next = text.charCodeAt(end);
			if (next === CODE_BACKSLASH) { end++; continue; }
			if (next === CODE_QUOTE) { end++; break; }
			if (next === CODE_LF) break;
		}
		scannedKind = "string";
		return Math.min(end, text.length);
	}
	if (code === 45 || isDigit(code)) {
		let end = from + 1;
		for (; end < text.length; end++) {
			const next = text.charCodeAt(end);
			if (!isDigit(next) && next !== 46 && next !== 101 && next !== 69 && next !== 43 && next !== 45) break;
		}
		scannedKind = "number";
		return end;
	}
	if (isLetter(code)) {
		let end = from + 1;
		while (end < text.length && isLetter(text.charCodeAt(end))) end++;
		scannedKind = "word";
		return end;
	}
	scannedKind = "punct";
	return from + 1;
}

/** The scoped spans of one row of JSON; together they spell exactly `line`. Whatever is not JSON stays plain. */
export function lexJsonLine(line: string): CodeSpan[] {
	const spans: CodeSpan[] = [];
	const push = (text: string, scopes: readonly string[]): void => {
		const last = spans.at(-1);
		if (last !== undefined && last.scopes === scopes) spans[spans.length - 1] = { text: last.text + text, scopes };
		else spans.push({ text, scopes });
	};
	for (let at = 0; at < line.length;) {
		const end = scanToken(line, at);
		const kind = scannedKind;
		const text = line.slice(at, end);
		if (kind === "string") {
			let next = end;
			while (next < line.length && (line.charCodeAt(next) === CODE_SPACE || line.charCodeAt(next) === CODE_TAB)) next++;
			push(text, line.charAt(next) === ":" ? SCOPES.key : SCOPES.string);
		} else if (kind === "number") push(text, SCOPES.number);
		else if (kind === "word") push(text, text === "true" || text === "false" || text === "null" ? SCOPES.constant : SCOPES.plain);
		else push(text, SCOPES.plain);
		at = end;
	}
	return spans;
}

/** A document as rows, and which rows open a container that a later row closes. */
export interface JsonTree {
	/** Display rows, indentation included. */
	readonly rows: readonly string[];
	/** For a row that opens a container closed by a later row (and may fold): that row's index; else -1. */
	readonly end: Int32Array;
	/** For such a row: how many keys or items the container holds. */
	readonly size: Int32Array;
	/** For such a row: how deeply the container is nested (the root is 0). */
	readonly level: Uint16Array;
	/** The document has at least one container that folds. */
	readonly foldable: boolean;
}

/** Re-indents a compact document by tokens: two spaces per level, one value or bracket per row, spelling untouched. */
function layoutCompact(text: string): string[] {
	const rows: string[] = [];
	let current = "";
	let depth = 0;
	let rowDepth = 0;
	const flush = (): void => { if (current !== "") { rows.push("  ".repeat(rowDepth) + current); current = ""; } };
	const append = (piece: string): void => { if (current === "") rowDepth = depth; current += piece; };
	for (let at = 0; at < text.length;) {
		const end = scanToken(text, at);
		const kind = scannedKind;
		if (kind === "ws") { at = end; continue; }
		const piece = text.slice(at, end);
		at = end;
		if (kind !== "punct") { append(piece); continue; }
		if (piece === "{" || piece === "[") {
			let next = at;
			while (next < text.length) { const code = text.charCodeAt(next); if (code === CODE_SPACE || code === CODE_TAB || code === CODE_LF || code === CODE_CR) next++; else break; }
			const close = piece === "{" ? "}" : "]";
			if (text.charAt(next) === close) { append(piece + close); at = next + 1; continue; }
			append(piece); flush(); depth++;
		} else if (piece === "}" || piece === "]") {
			flush(); depth = Math.max(0, depth - 1); append(piece);
		} else if (piece === ",") { current += ","; flush(); }
		else if (piece === ":") current += ": ";
		else append(piece);
	}
	flush();
	return rows;
}

/** Folds of a document that is already rows: matching brackets by one pass over every row (a row never continues a string of the one before). */
function treeOfRows(rows: readonly string[]): JsonTree {
	const end = new Int32Array(rows.length).fill(-1);
	const size = new Int32Array(rows.length);
	const level = new Uint16Array(rows.length);
	interface Open { row: number; column: number; level: number; commas: number; any: boolean }
	const stack: Open[] = [];
	let foldable = false;
	for (let row = 0; row < rows.length; row++) {
		const line = rows[row]!;
		let inString = false;
		for (let column = 0; column < line.length; column++) {
			const code = line.charCodeAt(column);
			if (inString) {
				if (code === CODE_BACKSLASH) column++;
				else if (code === CODE_QUOTE) inString = false;
				continue;
			}
			if (code === CODE_QUOTE) { inString = true; const top = stack.at(-1); if (top) top.any = true; continue; }
			if (code === 123 || code === 91) {
				const top = stack.at(-1); if (top) top.any = true;
				stack.push({ row, column, level: stack.length, commas: 0, any: false });
			} else if (code === 125 || code === 93) {
				const open = stack.pop();
				if (open === undefined || open.row === row) continue;
				const opener = rows[open.row]!;
				if (opener.trimEnd().length !== open.column + 1 || !/^\s*[}\]],?\s*$/.test(line)) continue;
				end[open.row] = row; size[open.row] = open.any ? open.commas + 1 : 0; level[open.row] = open.level; foldable = true;
			} else if (code === 44) { const top = stack.at(-1); if (top) top.commas++; }
			else if (code !== CODE_SPACE && code !== CODE_TAB && code !== CODE_CR && code !== 58) { const top = stack.at(-1); if (top) top.any = true; }
		}
	}
	return { rows, end, size, level, foldable };
}

/** The rows of `text`, a JSON document: its own rows when it has several lines, else re-indented by tokens. */
export function jsonTree(text: string): JsonTree {
	const trimmed = text.trim();
	const rows = trimmed.includes("\n") ? trimmed.split("\n").map(row => row.replace(/\r$/, "")) : layoutCompact(trimmed);
	return treeOfRows(rows);
}

/** A tree of the already-parsed value, for what arrives as data (arguments, display output). `omit` leaves out null values and the keys it names at the root. */
export function jsonTreeOfValue(value: unknown, omit?: { absent: boolean; rootKeys: readonly string[] }): JsonTree {
	const text = JSON.stringify(value, function replacer(this: unknown, key: string, item: unknown) {
		if (omit === undefined || key === "") return item;
		if (omit.absent && item == null) return undefined;
		return this === value && omit.rootKeys.includes(key) ? undefined : item;
	}, 2) ?? "null";
	return treeOfRows(text.split("\n"));
}

/** One record of newline-delimited JSON, or a line that is not JSON and stays a raw row. */
export interface NdjsonRecord {
	/** The line, as it was. */
	readonly line: string;
	/** The line parsed as an object or array (it can open as a tree). */
	readonly json: boolean;
}

export type OutputFormat =
	| { readonly kind: "json"; readonly tree: JsonTree; /** OMP cut long lines: the document is not valid JSON. */ readonly cut: boolean; readonly badge: string; readonly copy: string }
	| { readonly kind: "ndjson"; readonly records: readonly NdjsonRecord[]; readonly badge: string; readonly copy: string };

/** A fence (```json … ```) around a document is not part of it. */
function unfenced(text: string): string {
	const trimmed = text.trim();
	if (!trimmed.startsWith("```")) return trimmed;
	const open = trimmed.indexOf("\n");
	if (open < 0 || !trimmed.endsWith("```")) return trimmed;
	return trimmed.slice(open + 1, trimmed.length - 3).trim();
}

const wrapped = (text: string): boolean => {
	const first = text.charAt(0), last = text.charAt(text.length - 1);
	return first === "{" && last === "}" || first === "[" && last === "]";
};

function validJson(text: string): unknown | undefined {
	try { return JSON.parse(text) as unknown; } catch { return undefined; }
}

const cache = new Map<string, OutputFormat | null>();
const CACHE_ENTRIES = 8;

/** JSON or newline-delimited JSON, when `text` is one; `null` for anything else, and for text over {@link MAX_JSON_BYTES}. Cached by text. */
export function detectOutputFormat(text: string): OutputFormat | null {
	if (text.length < 2 || text.length > MAX_JSON_BYTES) return null;
	if (cache.has(text)) return cache.get(text) ?? null;
	const found = detect(text);
	cache.set(text, found);
	while (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
	return found;
}

function detect(source: string): OutputFormat | null {
	const text = unfenced(source);
	if (text.length < 2) return null;
	const first = text.charAt(0);
	if (wrapped(text)) {
		const parsed = validJson(text);
		if (parsed !== undefined && parsed !== null && typeof parsed === "object") {
			const tree = jsonTree(text);
			return { kind: "json", tree, cut: false, badge: `JSON · ${grouped(tree.rows.length)} ${tree.rows.length === 1 ? "line" : "lines"}`, copy: tree.rows.join("\n") };
		}
		// A document whose long lines OMP cut (a row ends in `…`) is not valid JSON; the lexer shows it all the same.
		if (parsed === undefined && text.includes("\n") && /…[ \t]*(?:\r?\n|$)/.test(text)) {
			const tree = jsonTree(text);
			if (tree.foldable && balanced(tree)) return { kind: "json", tree, cut: true, badge: "JSON · lines cut", copy: tree.rows.join("\n") };
		}
	}
	if (first !== "{" && first !== "[" || !text.includes("\n")) return null;
	const lines = text.split("\n").map(line => line.replace(/\r$/, ""));
	const records: NdjsonRecord[] = [];
	let nonBlank = 0, valid = 0;
	for (const line of lines) {
		const body = line.trim();
		if (body === "") continue;
		nonBlank++;
		let json = false;
		if (wrapped(body)) { const parsed = validJson(body); json = parsed !== undefined && parsed !== null && typeof parsed === "object"; }
		if (json) valid++;
		records.push({ line, json });
	}
	if (nonBlank < 2 || valid / nonBlank < 0.8) return null;
	return { kind: "ndjson", records, badge: `NDJSON · ${grouped(records.length)} records`, copy: source };
}

/** Whether every bracket of the rows is matched (rows of a cut document may lose a closing row, never a bracket). */
function balanced(tree: JsonTree): boolean {
	let depth = 0;
	for (const row of tree.rows) {
		let inString = false;
		for (let column = 0; column < row.length; column++) {
			const code = row.charCodeAt(column);
			if (inString) { if (code === CODE_BACKSLASH) column++; else if (code === CODE_QUOTE) inString = false; continue; }
			if (code === CODE_QUOTE) inString = true;
			else if (code === 123 || code === 91) depth++;
			else if (code === 125 || code === 93) { depth--; if (depth < 0) return false; }
		}
	}
	return depth === 0;
}

const grouped = (count: number): string => count.toLocaleString("en-US");

/** `{ … 5 keys }` / `[ … 12 items ]` for the container a folded row opens. */
export function foldLabel(tree: JsonTree, row: number): string {
	const size = tree.size[row]!;
	const array = tree.rows[row]!.trimEnd().endsWith("[");
	return size === 0 ? "…" : `… ${grouped(size)} ${array ? (size === 1 ? "item" : "items") : (size === 1 ? "key" : "keys")}`;
}
