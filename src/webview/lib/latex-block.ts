/**
 * Display layout of LaTeX math as lines of monospace text, for `$$…$$` and `\[…\]` blocks:
 *
 * ```
 *         −b ± √(b² − 4ac)        ⎡ 1  2 ⎤      ⎧ x   x > 0
 *     x = ─────────────────        ⎣ 3  4 ⎦      ⎩ 0   x ≤ 0
 *                2a
 * ```
 *
 * A small box model: a box is lines padded to one width plus a baseline row, and boxes concatenate horizontally on
 * their baselines. Only what needs two dimensions is laid out here: fractions and binomials, `\left…\right` pairs
 * over tall content, radicals over tall content, matrices, `cases`, and `align`-family rows. Everything else (symbols,
 * scripts, fonts, roots of one-line content) is one line and comes from {@link latexToUnicode}, so a fragment with
 * nothing to stack is exactly that one-line result. No colour: the output is plain text.
 *
 * Input is untrusted: past 8000 characters, 24 levels of nesting or a bounded amount of scanning the fragment is
 * shown as {@link latexToUnicode} shows it, and nothing throws.
 */
import { latexToUnicode } from "./latex-unicode.ts";

const MAX_INPUT = 8000;
const MAX_DEPTH = 24;
const MAX_WORK = 400_000;

/** A row of the box: lines of one width, with the row that lines up with neighbouring text. */
interface Box {
	readonly lines: readonly string[];
	readonly baseline: number;
	/** Width in monospace columns of every line. */
	readonly width: number;
}

type Align = "l" | "c" | "r";

class Bail extends Error {}

// ---------------------------------------------------------------------------
// Width
// ---------------------------------------------------------------------------

/** Columns a code point takes in a monospace grid: combining marks and format characters 0, East Asian wide 2. */
function codePointWidth(code: number): number {
	if (code < 0x20 || (code >= 0x7f && code < 0xa0)) return 0;
	if (
		(code >= 0x300 && code <= 0x36f) ||
		(code >= 0x483 && code <= 0x489) ||
		(code >= 0x591 && code <= 0x5bd) ||
		(code >= 0x1ab0 && code <= 0x1aff) ||
		(code >= 0x1dc0 && code <= 0x1dff) ||
		(code >= 0x200b && code <= 0x200f) ||
		(code >= 0x2060 && code <= 0x2064) ||
		(code >= 0x20d0 && code <= 0x20ff) ||
		(code >= 0xfe00 && code <= 0xfe0f) ||
		(code >= 0xfe20 && code <= 0xfe2f)
	) {
		return 0;
	}
	if (
		(code >= 0x1100 && code <= 0x115f) ||
		(code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
		(code >= 0xac00 && code <= 0xd7a3) ||
		(code >= 0xf900 && code <= 0xfaff) ||
		(code >= 0xfe30 && code <= 0xfe6f) ||
		(code >= 0xff00 && code <= 0xff60) ||
		(code >= 0xffe0 && code <= 0xffe6) ||
		(code >= 0x1f300 && code <= 0x1f64f) ||
		(code >= 0x1f900 && code <= 0x1f9ff) ||
		(code >= 0x20000 && code <= 0x3fffd)
	) {
		return 2;
	}
	return 1;
}

/** Monospace width of `text`: code points counted, combining marks 0, fullwidth CJK 2. */
export function displayWidth(text: string): number {
	let width = 0;
	for (const ch of text) width += codePointWidth(ch.codePointAt(0) ?? 0);
	return width;
}

// ---------------------------------------------------------------------------
// Boxes
// ---------------------------------------------------------------------------

const BAR = "─";

function spaces(count: number): string {
	return count > 0 ? " ".repeat(count) : "";
}

/** `line` padded to `width` columns according to `align` (centre rounds left). */
function pad(line: string, width: number, align: Align): string {
	const extra = width - displayWidth(line);
	if (extra <= 0) return line;
	if (align === "l") return line + spaces(extra);
	if (align === "r") return spaces(extra) + line;
	const left = extra >> 1;
	return spaces(left) + line + spaces(extra - left);
}

function textBox(text: string): Box {
	return { lines: [text], baseline: 0, width: displayWidth(text) };
}

function padBox(box: Box, width: number, align: Align): Box {
	if (box.width >= width) return box;
	return { lines: box.lines.map(line => pad(line, width, align)), baseline: box.baseline, width };
}

/** Boxes side by side, their baselines on one row. */
function hconcat(boxes: readonly Box[]): Box {
	const only = boxes[0];
	if (only === undefined) return textBox("");
	if (boxes.length === 1) return only;
	let above = 0;
	let below = 0;
	let width = 0;
	for (const box of boxes) {
		above = Math.max(above, box.baseline);
		below = Math.max(below, box.lines.length - 1 - box.baseline);
		width += box.width;
	}
	const lines: string[] = [];
	for (let row = 0; row < above + below + 1; row++) {
		let line = "";
		for (const box of boxes) {
			const local = row - (above - box.baseline);
			line += local >= 0 && local < box.lines.length ? (box.lines[local] ?? "") : spaces(box.width);
		}
		lines.push(line);
	}
	return { lines, baseline: above, width };
}

/** Boxes stacked, every line aligned per `align`. */
function vconcat(boxes: readonly Box[], align: Align): Box {
	let width = 0;
	for (const box of boxes) width = Math.max(width, box.width);
	const lines: string[] = [];
	for (const box of boxes) for (const line of box.lines) lines.push(pad(line, width, align));
	return { lines, baseline: (lines.length - 1) >> 1, width };
}

/** `numerator` over `denominator` with a rule; the rule row is the baseline. */
function fractionBox(numerator: Box, denominator: Box): Box {
	const width = Math.max(numerator.width, denominator.width) + 2;
	const lines = [
		...numerator.lines.map(line => pad(line, width, "c")),
		BAR.repeat(width),
		...denominator.lines.map(line => pad(line, width, "c")),
	];
	return { lines, baseline: numerator.lines.length, width };
}

/** The pieces of a tall delimiter, top to bottom; `axis` replaces the middle piece where the brace points. */
interface Pieces {
	readonly only: string;
	readonly top: string;
	readonly mid: string;
	readonly bottom: string;
	readonly axis?: string;
}

const PIECES: Readonly<Record<string, Pieces>> = {
	"(": { only: "(", top: "⎛", mid: "⎜", bottom: "⎝" },
	")": { only: ")", top: "⎞", mid: "⎟", bottom: "⎠" },
	"[": { only: "[", top: "⎡", mid: "⎢", bottom: "⎣" },
	"]": { only: "]", top: "⎤", mid: "⎥", bottom: "⎦" },
	"{": { only: "{", top: "⎧", mid: "⎪", bottom: "⎩", axis: "⎨" },
	"}": { only: "}", top: "⎫", mid: "⎪", bottom: "⎭", axis: "⎬" },
	"|": { only: "|", top: "│", mid: "│", bottom: "│" },
	"‖": { only: "‖", top: "║", mid: "║", bottom: "║" },
	"⌈": { only: "⌈", top: "⎡", mid: "⎢", bottom: "⎢" },
	"⌉": { only: "⌉", top: "⎤", mid: "⎥", bottom: "⎥" },
	"⌊": { only: "⌊", top: "⎢", mid: "⎢", bottom: "⎣" },
	"⌋": { only: "⌋", top: "⎥", mid: "⎥", bottom: "⎦" },
};

/** One delimiter `glyph` stretched to `height` rows; `null` for an empty delimiter. */
function delimiterColumn(glyph: string, height: number): Box | null {
	if (glyph === "") return null;
	const pieces = Object.hasOwn(PIECES, glyph) ? PIECES[glyph] : undefined;
	const only = pieces?.only ?? glyph;
	const width = displayWidth(only);
	if (height <= 1) return { lines: [only], baseline: 0, width };
	if (pieces === undefined) {
		// No stretchable form (⟨ ⟩): drawn once, in the middle row.
		const middle = (height - 1) >> 1;
		return { lines: Array.from({ length: height }, (_, row) => (row === middle ? only : spaces(width))), baseline: middle, width };
	}
	const axisRow = Math.min(Math.max((height - 1) >> 1, 1), height - 2);
	const lines = Array.from({ length: height }, (_, row) => {
		if (row === 0) return pieces.top;
		if (row === height - 1) return pieces.bottom;
		return row === axisRow && pieces.axis !== undefined && height >= 3 ? pieces.axis : pieces.mid;
	});
	return { lines, baseline: (height - 1) >> 1, width };
}

/** `inner` between delimiters stretched to its height, with a space inside each when it is tall. */
function delimitedBox(inner: Box, left: string, right: string): Box {
	const height = inner.lines.length;
	const open = delimiterColumn(left, height);
	const close = delimiterColumn(right, height);
	if (open === null && close === null) return inner;
	const parts: Box[] = [];
	const gap = height > 1 ? textBox(" ") : null;
	if (open !== null) parts.push(open);
	if (gap !== null && open !== null) parts.push(gap);
	parts.push(inner);
	if (gap !== null && close !== null) parts.push(gap);
	if (close !== null) parts.push(close);
	return hconcat(parts);
}

/** `n` over `k` without a rule, in tall parentheses. */
function binomialBox(top: Box, bottom: Box): Box {
	const width = Math.max(top.width, bottom.width);
	const lines = [...top.lines.map(line => pad(line, width, "c")), spaces(width), ...bottom.lines.map(line => pad(line, width, "c"))];
	return delimitedBox({ lines, baseline: top.lines.length, width }, "(", ")");
}

/** A radical over tall content: a bar above, a stroke at the left, the hook at the bottom; `degree` sits at its upper left. */
function radicalBox(inner: Box, degree: string): Box {
	const lines = [` ┌${BAR.repeat(inner.width + 1)}`];
	for (let row = 0; row < inner.lines.length; row++) lines.push((row === inner.lines.length - 1 ? "╲│ " : " │ ") + (inner.lines[row] ?? ""));
	const radical: Box = { lines, baseline: inner.baseline + 1, width: inner.width + 3 };
	if (degree === "") return radical;
	const mark = latexToUnicode(`^{${degree}}`);
	return hconcat([{ lines: [mark, spaces(displayWidth(mark))], baseline: 1, width: displayWidth(mark) }, radical]);
}

/**
 * Rows of cells as a grid: columns as wide as their widest cell, aligned per column, `gap(column)` spaces after a
 * column, and a blank line between rows when any cell is more than one line tall.
 */
function gridBox(rows: readonly (readonly Box[])[], align: (column: number) => Align, gap: (column: number) => number): Box {
	let columns = 0;
	for (const row of rows) columns = Math.max(columns, row.length);
	if (columns === 0) return textBox("");
	const widths = Array.from({ length: columns }, (_, column) => rows.reduce((width, row) => Math.max(width, row[column]?.width ?? 0), 0));
	const rowBoxes = rows.map(row => {
		const parts: Box[] = [];
		for (let column = 0; column < columns; column++) {
			parts.push(padBox(row[column] ?? textBox(""), widths[column] ?? 0, align(column)));
			if (column < columns - 1) parts.push(textBox(spaces(gap(column))));
		}
		return hconcat(parts);
	});
	const tall = rowBoxes.some(box => box.lines.length > 1);
	const lines: string[] = [];
	const width = rowBoxes.reduce((most, box) => Math.max(most, box.width), 0);
	rowBoxes.forEach((box, index) => {
		if (tall && index > 0) lines.push(spaces(width));
		for (const line of box.lines) lines.push(pad(line, width, "l"));
	});
	return { lines, baseline: (lines.length - 1) >> 1, width };
}

// ---------------------------------------------------------------------------
// Source scanning
// ---------------------------------------------------------------------------

const LETTER = /[A-Za-z]/;
const SPACING_ARGUMENT = /^\[\s*-?[\d.]*\s*(?:pt|em|ex|mm|cm|in|bp|pc|sp|mu|dd|cc)\s*\]/;
const FRACTIONS: Readonly<Record<string, true>> = { frac: true, dfrac: true, tfrac: true, cfrac: true };
const BINOMIALS: Readonly<Record<string, true>> = { binom: true, dbinom: true, tbinom: true };

/** The environments laid out as a grid of cells: `[open, close]` delimiters. */
const GRIDS: Readonly<Record<string, readonly [string, string]>> = {
	matrix: ["", ""],
	smallmatrix: ["", ""],
	array: ["", ""],
	pmatrix: ["(", ")"],
	bmatrix: ["[", "]"],
	Bmatrix: ["{", "}"],
	vmatrix: ["|", "|"],
	Vmatrix: ["‖", "‖"],
	cases: ["{", ""],
	dcases: ["{", ""],
	rcases: ["", "}"],
	drcases: ["", "}"],
};

/** Environments whose body is rows of expressions, `&` marking alignment points. */
const ROW_ENVIRONMENTS: Readonly<Record<string, true>> = {
	equation: true,
	eqnarray: true,
	align: true,
	aligned: true,
	alignat: true,
	alignedat: true,
	flalign: true,
	split: true,
	gather: true,
	gathered: true,
	gatheredat: true,
	multline: true,
	displaymath: true,
	math: true,
};

/** `\left` / `\right` / `\middle` delimiter tokens to the glyph drawn; an unlisted token is drawn as converted. */
const DELIMITERS: Readonly<Record<string, string>> = {
	"(": "(",
	")": ")",
	"[": "[",
	"]": "]",
	"\\{": "{",
	"\\}": "}",
	"\\lbrace": "{",
	"\\rbrace": "}",
	"|": "|",
	"\\vert": "|",
	"\\lvert": "|",
	"\\rvert": "|",
	"\\|": "‖",
	"\\Vert": "‖",
	"\\lVert": "‖",
	"\\rVert": "‖",
	"\\langle": "⟨",
	"\\rangle": "⟩",
	"<": "⟨",
	">": "⟩",
	"\\lceil": "⌈",
	"\\rceil": "⌉",
	"\\lfloor": "⌊",
	"\\rfloor": "⌋",
	"\\lbrack": "[",
	"\\rbrack": "]",
	".": "",
};

/** One argument of a command in `src` from `at`: a balanced `{…}`, a control sequence or one character; `end` is past it. */
interface Argument {
	readonly text: string;
	readonly end: number;
}

/** What the layout has read so far, to stop a hostile input after a bounded amount of work. */
class Budget {
	#work = 0;

	charge(amount: number): void {
		this.#work += amount;
		if (this.#work > MAX_WORK) throw new Bail();
	}
}

/** Offset just past the control word or symbol that starts at the backslash at `at`. */
function controlEnd(src: string, at: number): number {
	let end = at + 1;
	if (!LETTER.test(src.charAt(end))) return Math.min(end + 1, src.length);
	while (LETTER.test(src.charAt(end))) end++;
	return end;
}

/** Offset just past the `}` that closes the `{` at `at` (the source's end when it never closes). */
function groupEnd(src: string, at: number): number {
	let depth = 0;
	for (let scan = at; scan < src.length; scan++) {
		const ch = src.charAt(scan);
		if (ch === "\\") scan++;
		else if (ch === "{") depth++;
		else if (ch === "}" && --depth === 0) return scan + 1;
	}
	return src.length;
}

function readArgument(src: string, from: number): Argument | undefined {
	let at = from;
	while (at < src.length && /\s/.test(src.charAt(at))) at++;
	if (at >= src.length) return undefined;
	const ch = src.charAt(at);
	if (ch === "{") {
		const end = groupEnd(src, at);
		const closed = src.charAt(end - 1) === "}" && end - 1 > at;
		return { text: src.slice(at + 1, closed ? end - 1 : end), end };
	}
	if (ch === "\\") {
		const end = controlEnd(src, at);
		return { text: src.slice(at, end), end };
	}
	const point = String.fromCodePoint(src.codePointAt(at) ?? 0);
	return { text: point, end: at + point.length };
}

/**
 * `src` cut at its top-level separators: `\\` (with a spacing argument after it), `&` when `ampersand`, and a line
 * break when `newlines`. Braces and nested environments are not looked into.
 */
function splitTop(src: string, budget: Budget, newlines: boolean, ampersand: boolean): string[] {
	budget.charge(src.length);
	const pieces: string[] = [];
	let braces = 0;
	let environments = 0;
	let start = 0;
	for (let at = 0; at < src.length; at++) {
		const ch = src.charAt(at);
		if (ch === "{") braces++;
		else if (ch === "}") braces = Math.max(0, braces - 1);
		else if (ch === "\n" && newlines && braces === 0 && environments === 0) {
			pieces.push(src.slice(start, at));
			start = at + 1;
		} else if (ch === "&" && ampersand && braces === 0 && environments === 0) {
			pieces.push(src.slice(start, at));
			start = at + 1;
		} else if (ch === "\\") {
			const next = src.charAt(at + 1);
			if (next === "\\") {
				if (braces === 0 && environments === 0) {
					pieces.push(src.slice(start, at));
					const spacing = SPACING_ARGUMENT.exec(src.slice(at + 2, at + 26));
					start = at + 2 + (spacing?.[0].length ?? 0);
					at = start - 1;
				} else {
					at++;
				}
			} else if (LETTER.test(next)) {
				const end = controlEnd(src, at);
				const name = src.slice(at + 1, end);
				if (name === "begin") environments++;
				else if (name === "end") environments = Math.max(0, environments - 1);
				at = end - 1;
			} else {
				at++;
			}
		}
	}
	pieces.push(src.slice(start));
	return pieces;
}

const ENVIRONMENT_TOKEN = /\\(begin|end)\s*\{([A-Za-z]+\*?)\}/g;

/** Where the `\end{name}` matching an environment opened before `from` starts and ends, nesting counted; undefined when it never closes. */
function environmentEnd(src: string, from: number, name: string, budget: Budget): { start: number; end: number } | undefined {
	budget.charge(src.length - from);
	let depth = 1;
	ENVIRONMENT_TOKEN.lastIndex = from;
	for (let token = ENVIRONMENT_TOKEN.exec(src); token !== null; token = ENVIRONMENT_TOKEN.exec(src)) {
		if (token[2] !== name) continue;
		if (token[1] === "begin") depth++;
		else if (--depth === 0) return { start: token.index, end: token.index + token[0].length };
	}
	return undefined;
}

const LEFT_RIGHT_TOKEN = /\\(left|right)(?![A-Za-z])/g;

/** Where the `\right` matching a `\left` that ended at `from` starts and ends, nesting counted. */
function rightEnd(src: string, from: number, budget: Budget): { start: number; end: number } | undefined {
	budget.charge(src.length - from);
	let depth = 1;
	LEFT_RIGHT_TOKEN.lastIndex = from;
	for (let token = LEFT_RIGHT_TOKEN.exec(src); token !== null; token = LEFT_RIGHT_TOKEN.exec(src)) {
		if (token[1] === "left") depth++;
		else if (--depth === 0) return { start: token.index, end: token.index + token[0].length };
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** A flat run as a one-line box, its edge spaces kept (they separate it from the neighbouring boxes); `null` for nothing. */
function runBox(run: string): Box | null {
	const text = latexToUnicode(run.trim());
	const lead = /^\s/.test(run) ? " " : "";
	const trail = /\s$/.test(run) ? " " : "";
	if (text === "") return lead !== "" || trail !== "" ? textBox(" ") : null;
	return textBox(lead + text + trail);
}

/**
 * The rows of `src`: separated by `\\` (and line breaks when `newlines`), in one column, or as an `&`-aligned grid
 * when a row has `&`: columns alternate right- and left-aligned as `align` does.
 */
function layoutRows(src: string, newlines: boolean, depth: number, budget: Budget): Box {
	if (depth > MAX_DEPTH) throw new Bail();
	const rows = splitTop(src, budget, newlines, false)
		.map(row => row.trim())
		.filter(row => row !== "");
	if (rows.length === 0) return textBox("");
	const cellRows = rows.map(row => splitTop(row, budget, false, true));
	if (rows.length === 1 && cellRows[0]?.length === 1) return layoutRow(rows[0] ?? "", depth, budget);
	if (cellRows.some(cells => cells.length > 1)) {
		return gridBox(
			cellRows.map(cells => cells.map(cell => layoutRow(cell.trim(), depth + 1, budget))),
			column => (column % 2 === 0 ? "r" : "l"),
			column => (column % 2 === 0 ? 1 : 3),
		);
	}
	return vconcat(
		rows.map(row => layoutRow(row, depth + 1, budget)),
		"l",
	);
}

/**
 * One row: the two-dimensional constructs of `src` become boxes, the text between them is converted flat.
 * A row with no such construct is exactly `latexToUnicode` of it.
 */
function layoutRow(src: string, depth: number, budget: Budget): Box {
	if (depth > MAX_DEPTH) throw new Bail();
	budget.charge(src.length);
	const boxes: Box[] = [];
	let runStart = 0;
	let at = 0;
	const flush = (end: number): void => {
		const box = end > runStart ? runBox(src.slice(runStart, end)) : null;
		if (box !== null) boxes.push(box);
	};
	/** Puts `box` in place of the source from `start` to `end`: the flat run before it ends there and the next starts after it. */
	const place = (box: Box, start: number, end: number): void => {
		flush(start);
		boxes.push(box);
		runStart = end;
		at = end;
	};
	while (at < src.length) {
		const ch = src.charAt(at);
		if (ch === "{") {
			at = groupEnd(src, at);
			continue;
		}
		if (ch !== "\\") {
			at++;
			continue;
		}
		const end = controlEnd(src, at);
		const name = src.slice(at + 1, end);
		if (Object.hasOwn(FRACTIONS, name) || Object.hasOwn(BINOMIALS, name)) {
			const first = readArgument(src, end);
			const second = first === undefined ? undefined : readArgument(src, first.end);
			if (first !== undefined && second !== undefined) {
				const top = layoutRows(first.text, false, depth + 1, budget);
				const bottom = layoutRows(second.text, false, depth + 1, budget);
				place(Object.hasOwn(FRACTIONS, name) ? fractionBox(top, bottom) : binomialBox(top, bottom), at, second.end);
				continue;
			}
		} else if (name === "sqrt") {
			const radical = layoutRadical(src, end, depth, budget);
			if (radical !== undefined) {
				if (radical.box !== null) place(radical.box, at, radical.end);
				else at = radical.end;
				continue;
			}
		} else if (name === "left") {
			const pair = layoutDelimited(src, end, depth, budget);
			if (pair !== undefined) {
				if (pair.box !== null) place(pair.box, at, pair.end);
				else at = pair.end;
				continue;
			}
		} else if (name === "begin") {
			const environment = layoutEnvironment(src, at, end, depth, budget);
			if (environment !== undefined) {
				place(environment.box, at, environment.end);
				continue;
			}
		}
		at = end;
	}
	if (boxes.length === 0) return textBox(latexToUnicode(src.trim()));
	flush(src.length);
	// A command that shows nothing (`\color{…}`) leaves a run of spaces at an edge that would only indent the row.
	const blank = (box: Box | undefined): boolean => box !== undefined && box.lines.length === 1 && (box.lines[0] ?? "").trim() === "";
	while (blank(boxes[0])) boxes.shift();
	while (blank(boxes[boxes.length - 1])) boxes.pop();
	return hconcat(boxes);
}

/** `\sqrt[degree]{radicand}`: a drawn radical when the radicand is tall, else `box` is null and the source stays in its flat run. */
function layoutRadical(src: string, from: number, depth: number, budget: Budget): { box: Box | null; end: number } | undefined {
	let at = from;
	while (at < src.length && /\s/.test(src.charAt(at))) at++;
	let degree = "";
	if (src.charAt(at) === "[") {
		const close = src.indexOf("]", at);
		if (close === -1) return undefined;
		degree = src.slice(at + 1, close).trim();
		at = close + 1;
	}
	const radicand = readArgument(src, at);
	if (radicand === undefined) return undefined;
	const inner = layoutRows(radicand.text, false, depth + 1, budget);
	if (inner.lines.length === 1) return { box: null, end: radicand.end };
	return { box: radicalBox(inner, degree), end: radicand.end };
}

/** `\left⟨delim⟩ … \right⟨delim⟩`: stretched delimiters around tall content; `box` is null for one-line content (flat). */
function layoutDelimited(src: string, from: number, depth: number, budget: Budget): { box: Box | null; end: number } | undefined {
	const left = readDelimiter(src, from);
	if (left === undefined) return undefined;
	const right = rightEnd(src, left.end, budget);
	if (right === undefined) return undefined;
	const closing = readDelimiter(src, right.end);
	const end = closing?.end ?? right.end;
	const inner = layoutRows(src.slice(left.end, right.start), false, depth + 1, budget);
	if (inner.lines.length === 1) return { box: null, end };
	const glyph = (token: string | undefined): string => (token === undefined ? "" : Object.hasOwn(DELIMITERS, token) ? (DELIMITERS[token] ?? "") : latexToUnicode(token));
	return { box: delimitedBox(inner, glyph(left.token), glyph(closing?.token)), end };
}

function readDelimiter(src: string, from: number): { token: string; end: number } | undefined {
	let at = from;
	while (at < src.length && /\s/.test(src.charAt(at))) at++;
	if (at >= src.length) return undefined;
	if (src.charAt(at) === "\\") {
		const end = controlEnd(src, at);
		return { token: src.slice(at, end), end };
	}
	const point = String.fromCodePoint(src.codePointAt(at) ?? 0);
	return { token: point, end: at + point.length };
}

const COLUMN_SPEC = /^\s*(?:\[[^\]]*\])?\s*\{([^{}]*)\}/;

/** `\begin{env} … \end{env}` starting at the backslash at `at`; undefined when it is no environment of ours or never closes. */
function layoutEnvironment(src: string, at: number, afterBegin: number, depth: number, budget: Budget): { box: Box; end: number } | undefined {
	const named = /^\s*\{([A-Za-z]+\*?)\}/.exec(src.slice(afterBegin, afterBegin + 40));
	const name = named?.[1];
	if (named === null || name === undefined) return undefined;
	const base = name.endsWith("*") ? name.slice(0, -1) : name;
	const isGrid = Object.hasOwn(GRIDS, base);
	if (!isGrid && !Object.hasOwn(ROW_ENVIRONMENTS, base)) return undefined;
	const bodyStart = afterBegin + named[0].length;
	const closing = environmentEnd(src, bodyStart, name, budget);
	if (closing === undefined) return undefined;
	let body = src.slice(bodyStart, closing.start);
	let columns = "";
	const spec = base === "array" || base === "alignat" || base === "alignedat" || base === "gatheredat" ? COLUMN_SPEC.exec(body) : null;
	if (spec !== null) {
		columns = (spec[1] ?? "").replace(/@\{[^}]*\}/g, "");
		body = body.slice(spec[0].length);
	}
	const rows = splitTop(body.replaceAll("\\hline", ""), budget, false, false)
		.map(row => row.trim())
		.filter(row => row !== "");
	const source = src.slice(at, closing.end);
	if (rows.length === 0) return { box: textBox(""), end: closing.end };
	let box: Box;
	if (isGrid) {
		const cells = rows.map(row => splitTop(row, budget, false, true).map(cell => layoutRow(cell.trim(), depth + 1, budget)));
		const [open, close] = GRIDS[base] ?? ["", ""];
		const cases = base.endsWith("cases");
		const specColumns = columns.replace(/[^lcr]/g, "");
		const align = (column: number): Align => (cases ? "l" : ((specColumns.charAt(column) || "c") as Align));
		box = delimitedBox(
			gridBox(cells, align, () => 2),
			open,
			close,
		);
	} else {
		box = layoutRows(rows.join("\\\\"), false, depth + 1, budget);
	}
	// Nothing stacked: the environment is one flat line, converted as a whole.
	if (box.lines.length === 1) box = textBox(latexToUnicode(source));
	return { box, end: closing.end };
}

/** Lines trimmed on the right, the empty ones at both ends dropped. */
function tidy(lines: readonly string[]): string[] {
	const out = lines.map(line => line.trimEnd());
	while (out.length > 0 && out[0] === "") out.shift();
	while (out.length > 0 && out[out.length - 1] === "") out.pop();
	return out;
}

/**
 * Display layout of a bare math fragment as lines of monospace text: fractions stacked with a rule of `─`, matrices
 * and `cases` with tall bracket pieces, `align`-family rows aligned at `&`, rows broken at `\\` and at line breaks.
 * A fragment with nothing to stack is the one-line {@link latexToUnicode} result. Lines have no trailing spaces and
 * there are no empty lines at either end; a blank fragment is no lines.
 */
export function latexToBlock(body: string): string[] {
	if (typeof body !== "string") return [];
	try {
		if (body.length > MAX_INPUT) throw new Bail();
		const budget = new Budget();
		const box = layoutRows(body, true, 0, budget);
		if (box.lines.length === 1) return tidy([latexToUnicode(body.trim())]);
		return tidy(box.lines);
	} catch {
		return tidy(latexToUnicode(body).split("\n"));
	}
}
