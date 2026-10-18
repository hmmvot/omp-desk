/**
 * Where LaTeX math starts and ends in Markdown text: the delimiter grammar OMP's terminal UI uses for agent-written
 * answers, so a Chat transcript and the TUI agree on what is math and what is a price. This module only locates
 * math; it converts nothing (see `latex-unicode.ts`) and knows nothing about code spans: the caller skips code
 * before asking.
 *
 * Two entry points, one per level of Markdown: {@link nextMathSpan} for the inline spans of one line of prose and
 * {@link mathBlockAt} for own-line display blocks of a block parser.
 */

/** Opening delimiter. Each closer (`$`, `$$`, `\)`, `\]`) is as wide as its opener. */
export type MathOpener = "$" | "$$" | "\\(" | "\\[";

/** One closed math span of a line. */
export interface MathSpan {
	readonly opener: MathOpener;
	/** True for the display forms `$$…$$` and `\[…\]`. */
	readonly display: boolean;
	/** Offset of the opener. */
	readonly start: number;
	/** Offset one past the closing delimiter. */
	readonly end: number;
	/** Source between the delimiters, verbatim. */
	readonly body: string;
}

/** An own-line display block: opener and closer lines, or a bare math environment. */
export interface MathBlock {
	readonly opener: "$$" | "\\[" | "env";
	/**
	 * For `$$` and `\[` the lines strictly between the delimiter lines. For `env` every line of the block, the
	 * `\begin{…}` line and the `\end{…}` line included, since the environment is part of the math source.
	 */
	readonly bodyLines: readonly string[];
	/** Index in `lines` of the closing line (the `$$` / `\]` line, or the line holding `\end{env}`). */
	readonly last: number;
}

const DOLLAR = 0x24;
const BACKSLASH = 0x5c;
const LPAREN = 0x28;
const LBRACKET = 0x5b;

/**
 * What earlier closer scans of one line found, so that asking at many openers of a long run reads the run once. A
 * scan that failed to find a closer fails for every later opener of its kind (the closer's escape check never looks
 * before the body, and a body is always preceded by a non-backslash), and a `$` scan that ruled a closer out at
 * some offset rules it out the same way for every `$` it read past. Valid for one line only; callers walk a line
 * with growing `from`, so the last line asked about is kept.
 */
interface ScanMemo {
	line: string;
	/** Smallest body start from which no `$$` / `\)` / `\]` closer exists, by opener; Infinity for none known. */
	noCloserFrom: { "$$": number; "\\(": number; "\\[": number };
	/** The last `$` whose closer scan failed, and where that scan stopped. */
	dollarOpen: number;
	dollarStop: number;
}

let memo: ScanMemo = freshMemo("");

function freshMemo(line: string): ScanMemo {
	return { line, noCloserFrom: { "$$": Infinity, "\\(": Infinity, "\\[": Infinity }, dollarOpen: -1, dollarStop: -1 };
}

/**
 * The first math span of ONE line of text (no newline in `line`) that starts at or after `from`, or `undefined`.
 *
 * - An escaped opener is literal: `\$`, and `\(` behind an escaped backslash (`\\(`).
 * - Anti-currency (pandoc's rules): the `$` opener must not be followed by whitespace, the closer must not follow
 *   whitespace nor precede a digit, so `$5 and $10`, `costs $5` and `$5-$10` are prose while `$a$`, `$x^2$` are math.
 * - `$$` takes a body that is not blank; `\(\)` and `\[\]` are kept as empty math.
 * - A span never crosses the line, and an opener without a closer is prose.
 */
export function nextMathSpan(line: string, from = 0): MathSpan | undefined {
	if (memo.line !== line) memo = freshMemo(line);
	const length = line.length;
	for (let at = from < 0 ? 0 : from; at < length; at++) {
		const code = line.charCodeAt(at);
		if (code === BACKSLASH) {
			const next = line.charCodeAt(at + 1);
			if (next === BACKSLASH || next === DOLLAR) {
				at++; // an escaped backslash or dollar: the pair is text, whatever follows it
				continue;
			}
			if (next === LPAREN || next === LBRACKET) {
				const span = bracketSpan(line, at, next === LPAREN ? "\\(" : "\\[");
				if (span !== undefined) return span;
			}
			continue;
		}
		if (code !== DOLLAR) continue;
		if (line.charCodeAt(at + 1) === DOLLAR) {
			const span = doubleDollarSpan(line, at);
			if (span !== undefined) return span;
			at++; // a failed `$$` is two literal dollars, not an opener at its second `$`
			continue;
		}
		const span = dollarSpan(line, at);
		if (span !== undefined) return span;
	}
	return undefined;
}

/** `\(…\)` or `\[…\]` opened at `at`. */
function bracketSpan(line: string, at: number, opener: "\\(" | "\\["): MathSpan | undefined {
	const bodyStart = at + 2;
	const closer = opener === "\\(" ? "\\)" : "\\]";
	const close = closerIndex(line, opener, closer, bodyStart);
	if (close === -1) return undefined;
	return { opener, display: opener === "\\[", start: at, end: close + 2, body: line.slice(bodyStart, close) };
}

/** `$$…$$` opened at `at`; a blank body is no math. */
function doubleDollarSpan(line: string, at: number): MathSpan | undefined {
	const bodyStart = at + 2;
	const close = closerIndex(line, "$$", "$$", bodyStart);
	if (close === -1) return undefined;
	const body = line.slice(bodyStart, close);
	if (body.trim() === "") return undefined;
	return { opener: "$$", display: true, start: at, end: close + 2, body };
}

/** Offset of the first unescaped `closer` at or after `from`, or -1. */
function closerIndex(line: string, opener: "$$" | "\\(" | "\\[", closer: string, from: number): number {
	if (from >= memo.noCloserFrom[opener]) return -1;
	for (let at = line.indexOf(closer, from); at !== -1; at = line.indexOf(closer, at + 1)) {
		if (!escapedAt(line, at, from)) return at;
	}
	memo.noCloserFrom[opener] = from;
	return -1;
}

/** An odd run of backslashes back to `from` escapes the delimiter at `index`. */
function escapedAt(line: string, index: number, from: number): boolean {
	let backslashes = 0;
	for (let at = index - 1; at >= from && line.charCodeAt(at) === BACKSLASH; at--) backslashes++;
	return backslashes % 2 === 1;
}

/** `$…$` opened at `at`, by the anti-currency rules. */
function dollarSpan(line: string, at: number): MathSpan | undefined {
	if (at > memo.dollarOpen && at < memo.dollarStop) return undefined;
	const after = line.charCodeAt(at + 1);
	// Followed by nothing, a space, a tab or a line break: not an opener. (`$$` was taken by the caller.)
	if (Number.isNaN(after) || after === 0x20 || after === 0x09 || after === 0x0a) return undefined;
	const length = line.length;
	for (let scan = at + 1; scan < length; scan++) {
		const code = line.charCodeAt(scan);
		if (code === BACKSLASH) {
			scan++;
			continue;
		}
		if (code === 0x0a) return failDollar(at, scan);
		if (code !== DOLLAR) continue;
		const before = line.charCodeAt(scan - 1);
		if (before === 0x20 || before === 0x09) return failDollar(at, scan);
		const next = line.charCodeAt(scan + 1);
		if (next >= 0x30 && next <= 0x39) continue; // currency: keep scanning
		const body = line.slice(at + 1, scan);
		if (body.trim() === "") return failDollar(at, scan);
		return { opener: "$", display: false, start: at, end: scan + 1, body };
	}
	return failDollar(at, length);
}

function failDollar(open: number, stop: number): undefined {
	memo.dollarOpen = open;
	memo.dollarStop = stop;
	return undefined;
}

// ---------------------------------------------------------------------------
// Display blocks
// ---------------------------------------------------------------------------

/**
 * Math environments that render as display math without `$$` or `\[`. Text-mode environments (`tabular`,
 * `itemize`, `verbatim`, …) are deliberately absent so LaTeX quoted in prose stays text; the trailing `*` of a
 * starred form is ignored. The list is the TUI's `isBareMathEnvironment`, plus `flalign`.
 */
const BARE_MATH_ENVIRONMENTS: Readonly<Record<string, true>> = {
	matrix: true,
	smallmatrix: true,
	pmatrix: true,
	bmatrix: true,
	Bmatrix: true,
	vmatrix: true,
	Vmatrix: true,
	cases: true,
	dcases: true,
	rcases: true,
	drcases: true,
	aligned: true,
	alignedat: true,
	align: true,
	alignat: true,
	flalign: true,
	split: true,
	gathered: true,
	gatheredat: true,
	gather: true,
	multline: true,
	equation: true,
	eqnarray: true,
	array: true,
	subarray: true,
};

const OPENER_LINE = /^ {0,3}(\$\$|\\\[)[ \t]*$/;
const DOLLAR_CLOSER_LINE = /^ {0,3}\$\$[ \t]*$/;
const BRACKET_CLOSER_LINE = /^ {0,3}\\\][ \t]*$/;
const ENV_BEGIN_LINE = /^( {0,3})\\begin\{([A-Za-z]+)(\*?)\}/;
const ENV_TOKEN = /\\(begin|end)\{([A-Za-z]+\*?)\}/g;
const BLANK_LINE = /^[ \t]*$/;

/** Where an environment opened by a `\begin{…}` at a column of a line ends. */
interface EnvEnd {
	readonly line: number;
	/** Offset in that line just after the `\end{…}`. */
	readonly after: number;
}

/**
 * What is known of one `lines` array, kept while the caller asks again about the same array at later indices (a
 * block parser asks at every line; unclosed openers must not rescan the rest each time). Dropped when the array's
 * length changes, which is how a stream's growing text reaches us.
 */
interface BlockCache {
	readonly length: number;
	/** First line at or after `from` that closes a display block of the key's kind, or -1. */
	readonly closers: Map<string, { from: number; at: number }>;
	/** `"line:column"` of a `\begin{…}` → where its matching `\end{…}` is; built on first use. */
	envEnds: Map<string, EnvEnd> | undefined;
}

const blockCaches = new WeakMap<readonly string[], BlockCache>();

function cacheFor(lines: readonly string[]): BlockCache {
	let cache = blockCaches.get(lines);
	if (cache === undefined || cache.length !== lines.length) {
		cache = { length: lines.length, closers: new Map(), envEnds: undefined };
		blockCaches.set(lines, cache);
	}
	return cache;
}

/**
 * A display block starting at `lines[index]`: an own-line `$$` or `\[` opener (up to three leading spaces, trailing
 * blanks allowed) up to its own-line closer, or a bare math environment `\begin{align}…\end{align}`. `undefined`
 * when `lines[index]` starts no block, the closer has not arrived (an unclosed block stays prose while streaming),
 * or the body is blank. An environment may not contain a blank line, as in the TUI. Linear time over a run of
 * openers however often the caller asks.
 */
export function mathBlockAt(lines: readonly string[], index: number): MathBlock | undefined {
	const line = lines[index];
	if (line === undefined) return undefined;
	const opener = OPENER_LINE.exec(line);
	if (opener !== null) return delimitedBlock(lines, index, opener[1] === "$$" ? "$$" : "\\[");
	return environmentBlock(lines, index, line);
}

function delimitedBlock(lines: readonly string[], index: number, opener: "$$" | "\\["): MathBlock | undefined {
	const pattern = opener === "$$" ? DOLLAR_CLOSER_LINE : BRACKET_CLOSER_LINE;
	const last = firstLineFrom(lines, opener, pattern, index + 1);
	if (last === -1) return undefined;
	const bodyLines = lines.slice(index + 1, last);
	if (bodyLines.every(body => BLANK_LINE.test(body))) return undefined;
	return { opener, bodyLines, last };
}

function firstLineFrom(lines: readonly string[], key: string, pattern: RegExp, from: number): number {
	const cache = cacheFor(lines);
	const known = cache.closers.get(key);
	if (known !== undefined && known.from <= from && (known.at === -1 || from <= known.at)) {
		if (known.at === -1) return -1;
		const closer = lines[known.at];
		if (closer !== undefined && pattern.test(closer)) return known.at;
	}
	let at = -1;
	for (let scan = from; scan < lines.length; scan++) {
		if (pattern.test(lines[scan] ?? "")) {
			at = scan;
			break;
		}
	}
	cache.closers.set(key, { from, at });
	return at;
}

function environmentBlock(lines: readonly string[], index: number, line: string): MathBlock | undefined {
	const begin = ENV_BEGIN_LINE.exec(line);
	if (begin === null) return undefined;
	const name = `${begin[2]}${begin[3]}`;
	if (!Object.hasOwn(BARE_MATH_ENVIRONMENTS, name.endsWith("*") ? name.slice(0, -1) : name)) return undefined;
	const cache = cacheFor(lines);
	cache.envEnds ??= matchEnvironments(lines);
	const end = cache.envEnds.get(`${index}:${(begin[1] ?? "").length}`);
	if (end === undefined) return undefined;
	const closing = lines[end.line] ?? "";
	// Text after the `\end{…}` would be prose glued to a block; leave such a block to the prose.
	if (closing.slice(end.after).trim() !== "") return undefined;
	return { opener: "env", bodyLines: lines.slice(index, end.line + 1), last: end.line };
}

/**
 * Pair every `\begin{x}` of `lines` with its `\end{x}` in one pass, nesting per environment name. A blank line
 * forgets the open environments: a block never spans a paragraph break, so an unclosed `\begin` costs nothing at the
 * lines after it.
 */
function matchEnvironments(lines: readonly string[]): Map<string, EnvEnd> {
	const ends = new Map<string, EnvEnd>();
	const open = new Map<string, string[]>();
	for (let row = 0; row < lines.length; row++) {
		const line = lines[row] ?? "";
		if (BLANK_LINE.test(line)) {
			open.clear();
			continue;
		}
		if (!line.includes("\\begin{") && !line.includes("\\end{")) continue;
		ENV_TOKEN.lastIndex = 0;
		for (let token = ENV_TOKEN.exec(line); token !== null; token = ENV_TOKEN.exec(line)) {
			const name = token[2] ?? "";
			const stack = open.get(name);
			if (token[1] === "begin") {
				const key = `${row}:${token.index}`;
				if (stack === undefined) open.set(name, [key]);
				else stack.push(key);
				continue;
			}
			const key = stack?.pop();
			if (key !== undefined) ends.set(key, { line: row, after: token.index + token[0].length });
		}
	}
	return ends;
}
