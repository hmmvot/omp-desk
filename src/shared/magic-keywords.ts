/**
 * OMP's magic keywords, as Chat knows them.
 *
 * A magic keyword is a standalone lowercase prose word in a prompt: OMP appends a hidden notice to that turn when it finds one
 * (and `ultrathink` asks for the highest thinking level), and its terminal UI paints the word with a hue gradient in the editor
 * and in the sent message. Chat paints the same words in the composer and in the user's own messages. What counts as
 * "standalone prose" is OMP's own rule, so this module repeats it exactly; a word OMP does not act on is never painted.
 *
 * Mirrored from the installed OMP (18.12.2):
 * - the table: `coding-agent` `src/modes/magic-keywords.ts` (`MAGIC_KEYWORDS`) and the `magicKeywords.*` settings of
 *   `src/modes/settings.ts`;
 * - the matcher: `pi-tui` `src/prompt/magic-keywords.ts` (the two boundary patterns, `magicKeywordRanges`, `containsMagicKeyword`;
 *   adapted source, MIT, see THIRD_PARTY_NOTICES.txt);
 * - the mask of code and markup: `pi-tui` `src/prompt/markdown-prose.ts` (`maskNonProse`; adapted source, MIT, see
 *   THIRD_PARTY_NOTICES.txt);
 * - the gradient: `pi-tui` `src/prompt/gradient-highlight.ts` (14 stops, saturation 90 %, lightness 62 %) and the shimmer of
 *   `src/prompt/custom-editor.ts` (a frame every 70 ms, one sweep in 1800 ms).
 * `src/omp/magic-keywords.test.ts` pins all of it to a recording of the installed OMP, and `src/omp/magic-keywords.live.test.ts`
 * compares that recording with the installed OMP, so a change in OMP fails a test instead of drifting silently.
 *
 * Pure and DOM-free: the page, the host and the tests share it.
 */

/** The settings key suffix of a keyword (`magicKeywords.<id>`). It is not always the word: `workflow` is triggered by `workflowz`. */
export type MagicKeywordId = "ultrathink" | "orchestrate" | "workflow" | "jevify";

export interface MagicKeyword {
	readonly id: MagicKeywordId;
	/** The exact lowercase trigger, matched case-sensitively and only as standalone prose. */
	readonly word: string;
	/** The HSL hue sweep `[from, to]` in degrees painted across the word; `to` may pass 360 and wrap through red. */
	readonly hue: readonly [number, number];
	/**
	 * The tools that must all be enabled for OMP to append the notice. Recorded for the pin only: OMP's terminal UI paints the word
	 * whether or not the notice applies, and so does Chat.
	 */
	readonly requires: readonly string[];
}

/** OMP's table, in OMP's order. */
export const MAGIC_KEYWORDS: readonly MagicKeyword[] = [
	{ id: "ultrathink", word: "ultrathink", hue: [0, 330], requires: [] },
	{ id: "orchestrate", word: "orchestrate", hue: [150, 280], requires: ["task"] },
	{ id: "workflow", word: "workflowz", hue: [30, 150], requires: ["task", "eval"] },
	{ id: "jevify", word: "jevify", hue: [300, 420], requires: ["eval"] },
];

/** The master switch of OMP's settings; with it off no keyword is acted on. */
export const MAGIC_KEYWORDS_SETTING = "magicKeywords.enabled";

/** The per-keyword switch of OMP's settings. */
export function magicKeywordSetting(id: MagicKeywordId): string {
	return `magicKeywords.${id}`;
}

/** Every setting that decides whether a keyword is acted on: the master switch first. */
export const MAGIC_KEYWORD_SETTING_KEYS: readonly string[] = [MAGIC_KEYWORDS_SETTING, ...MAGIC_KEYWORDS.map(keyword => magicKeywordSetting(keyword.id))];

export function isMagicKeywordId(value: unknown): value is MagicKeywordId {
	return typeof value === "string" && MAGIC_KEYWORDS.some(keyword => keyword.id === value);
}

/**
 * The keywords OMP acts on, from the effective values of {@link MAGIC_KEYWORD_SETTING_KEYS}, as OMP's session judges them: the master
 * switch and the keyword's own switch both on. A key the installed OMP does not report (an OMP before magic keywords, or one that
 * dropped a keyword) is a keyword it does not act on; a value that is not a boolean is read as off.
 */
export function enabledMagicKeywords(values: Readonly<Record<string, unknown>>): MagicKeywordId[] {
	if (values[MAGIC_KEYWORDS_SETTING] !== true) return [];
	return MAGIC_KEYWORDS.filter(keyword => values[magicKeywordSetting(keyword.id)] === true).map(keyword => keyword.id);
}

// ---- the matcher --------------------------------------------------------------------------------------------------------------

/** Characters that bind a magic keyword into an identifier or path segment. */
const LEFT_BOUNDARY = String.raw`(?<![\p{L}\p{N}_./\\-])(?<!::)`;

/** Characters that cannot immediately follow a standalone magic keyword. */
const RIGHT_BOUNDARY = String.raw`(?![\p{L}\p{N}_/\\-])(?!\.[\p{L}\p{N}_-])(?!\()`;

/**
 * A case-sensitive matcher for `word` at prose punctuation boundaries. Sentence punctuation and quotes may touch the keyword;
 * letters, digits, underscores, slashes, backslashes, hyphens, file-extension dots, symbol references (`foo::keyword`) and an
 * immediate call parenthesis (`keyword()`) keep the occurrence embedded in code rather than prose.
 */
function magicKeywordRegex(word: string, flags = ""): RegExp {
	const escaped = word.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
	return new RegExp(`${LEFT_BOUNDARY}${escaped}${RIGHT_BOUNDARY}`, `${flags}u`);
}

/** Each keyword with its global matcher, walked over masked text. */
const PATTERNS: readonly (MagicKeyword & { readonly pattern: RegExp })[] = MAGIC_KEYWORDS.map(keyword => ({ ...keyword, pattern: magicKeywordRegex(keyword.word, "g") }));

/** The non-global matchers `containsMagicKeyword` tests with (`test` stays stateless on them). */
const PROBES = new Map<string, RegExp>();

function probeFor(word: string): RegExp {
	let probe = PROBES.get(word);
	if (probe === undefined) {
		probe = magicKeywordRegex(word);
		PROBES.set(word, probe);
	}
	return probe;
}

// ---- the mask of code and markup (adapted from `pi-tui` `src/prompt/markdown-prose.ts`) ---------------------------------------

/** A Markdown fenced-code opener: its indentation and its marker. */
const FENCE_RE = /^( {0,3})([`~]{3,})/;

/** A tag or element name: an HTML5/XML start character and name characters. Sticky, so it probes at a precise offset. */
const TAG_NAME = /[A-Za-z][A-Za-z0-9-]*/y;

/** The index just past the run of backticks that begins at `i`. */
function backtickRunEnd(text: string, i: number, n: number): number {
	let j = i;
	while (j < n && text[j] === "`") j++;
	return j;
}

/**
 * The index just past the closing backtick run of an opening run of `runLength` backticks, scanning from `from`; -1 when no run of the
 * exact length exists (an unmatched run is literal text, not a code span). Positions already masked (fenced code) are skipped.
 */
function findBacktickClose(text: string, from: number, n: number, runLength: number, masked: Uint8Array): number {
	let k = from;
	while (k < n) {
		if (masked[k]) {
			k++;
			continue;
		}
		if (text[k] === "`") {
			const end = backtickRunEnd(text, k, n);
			if (end - k === runLength) return end;
			k = end;
			continue;
		}
		k++;
	}
	return -1;
}

/**
 * The index of the `>` that closes a tag whose attributes begin at `j`, honouring quoted attribute values; -1 when the tag is
 * malformed (a new `<` comes first, or there is no `>`), so the caller reads the `<` as literal text.
 */
function findTagEnd(text: string, j: number, n: number): number {
	let quote = "";
	for (let k = j; k < n; k++) {
		const ch = text[k];
		if (quote) {
			if (ch === quote) quote = "";
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			continue;
		}
		if (ch === ">") return k;
		if (ch === "<") return -1;
	}
	return -1;
}

/**
 * The index just past the `>` of the `</name>` that balances an opening `<name>` which ends at `start`, counting nested tags of the
 * same name; -1 when the section is never closed (the caller then masks only the opening tag, not the rest of the text).
 */
function findMatchingClose(text: string, start: number, n: number, name: string, masked: Uint8Array): number {
	const lowerName = name.toLowerCase();
	let depth = 1;
	let k = start;
	while (k < n) {
		if (masked[k] || text[k] !== "<") {
			k++;
			continue;
		}
		let m = k + 1;
		let isClose = false;
		if (text[m] === "/") {
			isClose = true;
			m++;
		}
		TAG_NAME.lastIndex = m;
		const found = TAG_NAME.exec(text);
		if (!found) {
			k++;
			continue;
		}
		const gt = findTagEnd(text, TAG_NAME.lastIndex, n);
		if (gt < 0) {
			k++;
			continue;
		}
		if (found[0].toLowerCase() === lowerName) {
			if (isClose) {
				depth--;
				if (depth === 0) return gt + 1;
			} else if (text[gt - 1] !== "/") {
				depth++;
			}
		}
		k = gt + 1;
	}
	return -1;
}

/**
 * Masks the HTML or XML construct that begins at `<` (index `i`): a comment, a closing or self-closing tag (the tag alone), or an
 * opening tag with the content through its matching close tag. Returns the index just past the masked region, or `i` when the `<`
 * does not begin a tag (a stray less-than).
 */
function maskTagAt(text: string, i: number, n: number, masked: Uint8Array): number {
	if (text.startsWith("<!--", i)) {
		const end = text.indexOf("-->", i + 4);
		const stop = end < 0 ? n : end + 3;
		for (let p = i; p < stop; p++) masked[p] = 1;
		return stop;
	}
	let j = i + 1;
	let closing = false;
	if (text[j] === "/") {
		closing = true;
		j++;
	}
	TAG_NAME.lastIndex = j;
	const found = TAG_NAME.exec(text);
	if (!found) return i;
	const gt = findTagEnd(text, TAG_NAME.lastIndex, n);
	if (gt < 0) return i;
	const tagEnd = gt + 1;
	const selfClosing = text[gt - 1] === "/";
	for (let p = i; p < tagEnd; p++) masked[p] = 1;
	if (closing || selfClosing) return tagEnd;
	const close = findMatchingClose(text, tagEnd, n, found[0], masked);
	if (close < 0) return tagEnd;
	for (let p = tagEnd; p < close; p++) masked[p] = 1;
	return close;
}

/**
 * A copy of `text` with the same length (every index addresses the original) in which each character of a non-prose region is a
 * space: Markdown fenced code blocks, inline code spans, and HTML or XML tags with the content they enclose. Newlines stay. A text
 * with nothing that could open such a region is returned as it is.
 */
export function maskNonProse(text: string): string {
	if (!text.includes("`") && !text.includes("<") && !text.includes("~~~")) return text;
	const n = text.length;
	const masked = new Uint8Array(n);

	// Phase 1: fenced code blocks, line by line.
	let fenceChar = "";
	let fenceLength = 0;
	let lineStart = 0;
	while (lineStart <= n) {
		let newline = text.indexOf("\n", lineStart);
		if (newline < 0) newline = n;
		const line = text.slice(lineStart, newline);
		const open = FENCE_RE.exec(line);
		if (fenceChar) {
			for (let p = lineStart; p < newline; p++) masked[p] = 1;
			// A closing fence is the same character, at least as long, with nothing else on the line.
			if (open && open[2]![0] === fenceChar && open[2]!.length >= fenceLength && line.slice(open[1]!.length + open[2]!.length).trim() === "") {
				fenceChar = "";
				fenceLength = 0;
			}
		} else if (open) {
			const marker = open[2]!;
			const ch = marker[0]!;
			// A backtick fence's info string may not contain a backtick.
			if (!(ch === "`" && line.slice(open[1]!.length + marker.length).includes("`"))) {
				fenceChar = ch;
				fenceLength = marker.length;
				for (let p = lineStart; p < newline; p++) masked[p] = 1;
			}
		}
		if (newline === n) break;
		lineStart = newline + 1;
	}

	// Phase 2: inline code spans and HTML or XML, over the regions not masked yet.
	let i = 0;
	while (i < n) {
		if (masked[i]) {
			i++;
			continue;
		}
		const c = text[i];
		if (c === "`") {
			const runEnd = backtickRunEnd(text, i, n);
			const close = findBacktickClose(text, runEnd, n, runEnd - i, masked);
			if (close >= 0) {
				for (let p = i; p < close; p++) masked[p] = 1;
				i = close;
			} else {
				i = runEnd;
			}
			continue;
		}
		if (c === "<") {
			const end = maskTagAt(text, i, n, masked);
			i = end > i ? end : i + 1;
			continue;
		}
		i++;
	}

	const chars = text.split("");
	for (let p = 0; p < n; p++) {
		if (masked[p] && chars[p] !== "\n") chars[p] = " ";
	}
	return chars.join("");
}

/** One keyword standing as prose in a text: `[from, to)` are UTF-16 offsets into the text. */
export interface MagicKeywordMatch {
	readonly id: MagicKeywordId;
	readonly from: number;
	readonly to: number;
}

/**
 * Every keyword standing as prose in `text` (never inside code or an HTML or XML section), in text order, as OMP's
 * `magicKeywordRanges` finds them. `enabled` limits the search to the keywords OMP acts on; absent, every keyword counts.
 */
export function findMagicKeywords(text: string, enabled?: ReadonlySet<MagicKeywordId>): MagicKeywordMatch[] {
	const found: MagicKeywordMatch[] = [];
	let masked: string | undefined;
	for (const keyword of PATTERNS) {
		if (enabled !== undefined && !enabled.has(keyword.id)) continue;
		// The cheap probe first: almost every text holds no keyword at all.
		if (!text.includes(keyword.word)) continue;
		masked ??= maskNonProse(text);
		for (const match of masked.matchAll(keyword.pattern)) {
			const from = match.index ?? 0;
			found.push({ id: keyword.id, from, to: from + match[0].length });
		}
	}
	return found.sort((a, b) => a.from - b.from);
}

/** Whether `text` holds `word` as standalone prose, as OMP's session asks before it appends a notice. Does not need `word` to be in the table. */
export function containsMagicKeyword(text: string, word: string): boolean {
	const probe = probeFor(word);
	return probe.test(text) && probe.test(maskNonProse(text));
}

/** Whether `text` holds any of `enabled` (every keyword when absent) as standalone prose. */
export function hasMagicKeyword(text: string, enabled?: ReadonlySet<MagicKeywordId>): boolean {
	for (const keyword of MAGIC_KEYWORDS) {
		if (enabled !== undefined && !enabled.has(keyword.id)) continue;
		if (text.includes(keyword.word) && containsMagicKeyword(text, keyword.word)) return true;
	}
	return false;
}

// ---- the gradient -------------------------------------------------------------------------------------------------------------

/** The colour stops swept across a keyword. */
export const MAGIC_GRADIENT_STOPS = 14;
/** The HSL saturation and lightness (percent) OMP's terminal UI paints every stop with, on the dark terminal it assumes. */
export const MAGIC_TUI_SATURATION = 90;
export const MAGIC_TUI_LIGHTNESS = 62;
/** The shimmer of a focused editor: one repaint per frame, one full sweep of the gradient per period. */
export const MAGIC_SHIMMER_FRAME_MS = 70;
export const MAGIC_SHIMMER_PERIOD_MS = 1800;

/** The hue (degrees, an integer from 0 to 360: OMP rounds after the wrap, so 359.6 reads 360) of stop `stop` of a keyword's sweep. */
export function magicStopHue(keyword: Pick<MagicKeyword, "hue">, stop: number): number {
	const [from, to] = keyword.hue;
	return Math.round((from + (stop / MAGIC_GRADIENT_STOPS) * (to - from)) % 360);
}

/**
 * The stop the character at `index` of a `length`-character keyword takes at `phase` (a fraction of one sweep; any number, wrapped into
 * [0, 1)): the characters step through the stops in order and a growing phase rotates them, which is the shimmer. Phase 0 is the static
 * gradient of a sent message.
 */
export function magicStopAt(index: number, length: number, phase = 0): number {
	const wrapped = ((phase % 1) + 1) % 1;
	const t = (index / length + wrapped) % 1;
	return Math.floor(t * MAGIC_GRADIENT_STOPS) % MAGIC_GRADIENT_STOPS;
}

/** The shimmer phase at wall-clock time `now` (milliseconds). */
export function magicPhaseAt(now: number): number {
	return (now % MAGIC_SHIMMER_PERIOD_MS) / MAGIC_SHIMMER_PERIOD_MS;
}
