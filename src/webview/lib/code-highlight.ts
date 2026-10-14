/**
 * What fenced code is coloured with, and when.
 *
 * Tokenizing is the one costly step; it depends on the language and the text only, never on the theme, so
 * its result is cached and a theme change re-styles without tokenizing again. Work runs one block per
 * task, newest block first, after the first paint; a block over the size caps is never tokenized.
 */
import { languageId } from "./code-languages.ts";
import { tokenize, type CodeSpan } from "./code-tokens.ts";
import { FONT_BOLD, FONT_ITALIC, FONT_STRIKETHROUGH, FONT_UNDERLINE, type CodeThemeStyler, type TokenStyle } from "./code-theme-style.ts";

/**
 * A block longer than this is left plain. One tokenize is one uninterrupted task: measured at 20,000
 * characters it takes about 100 ms (TypeScript, HTML), over the 50 ms a task may take before input stutters,
 * so the caps hold a block to roughly half of that.
 */
export const MAX_HIGHLIGHT_CHARS = 10_000;
export const MAX_HIGHLIGHT_LINES = 400;
/** How long an unfinished fence's text must stay unchanged before it is coloured. */
export const SETTLE_MS = 400;
const CACHE_ENTRIES = 64;

/** Whether `source` in the fence language `info` is coloured at all. */
export function isHighlightable(info: string, source: string): boolean {
	if (source.length === 0 || source.length > MAX_HIGHLIGHT_CHARS || languageId(info) === null) return false;
	let lines = 1;
	for (let at = source.indexOf("\n"); at >= 0; at = source.indexOf("\n", at + 1)) if (++lines > MAX_HIGHLIGHT_LINES) return false;
	return true;
}

const cache = new Map<string, readonly CodeSpan[] | null>();

/** The scoped spans of `source`; cached by language and text. */
export function spansOf(info: string, source: string): readonly CodeSpan[] | null {
	const id = languageId(info);
	if (id === null) return null;
	const key = `${id}\0${source}`;
	if (cache.has(key)) return cache.get(key) ?? null;
	let spans: readonly CodeSpan[] | null;
	try {
		spans = tokenize(source, id);
	} catch {
		spans = null;
	}
	if (cache.size >= CACHE_ENTRIES) cache.delete(cache.keys().next().value as string);
	cache.set(key, spans);
	return spans;
}

/** Spans already tokenized, for a block that remounts. */
export function cachedSpans(info: string, source: string): readonly CodeSpan[] | null {
	const id = languageId(info);
	return id === null ? null : (cache.get(`${id}\0${source}`) ?? null);
}

/** A run of text drawn in one style. */
export interface StyledRun {
	readonly text: string;
	readonly style: TokenStyle | null;
}

/** The spans coloured by the theme; adjacent runs of the same style are one run, a style that changes nothing is `null`. */
export function styledRuns(spans: readonly CodeSpan[], styler: CodeThemeStyler): StyledRun[] {
	const runs: StyledRun[] = [];
	for (const span of spans) {
		const style = styler.styleOf(span.scopes);
		const effective = style.color === null && style.fontStyle === 0 ? null : style;
		const last = runs.at(-1);
		if (last !== undefined && (last.style === effective || (last.style !== null && effective !== null && last.style.color === effective.color && last.style.fontStyle === effective.fontStyle))) {
			runs[runs.length - 1] = { text: last.text + span.text, style: last.style };
		} else {
			runs.push({ text: span.text, style: effective });
		}
	}
	return runs;
}

/** The runs cut at every newline into one run list per line (`n` newlines make `n + 1` lines); a run never spans two lines. */
export function runsByLine(runs: readonly StyledRun[]): StyledRun[][] {
	const lines: StyledRun[][] = [[]];
	for (const run of runs) {
		const parts = run.text.split("\n");
		parts.forEach((part, index) => {
			if (index > 0) lines.push([]);
			if (part !== "") lines[lines.length - 1]!.push({ text: part, style: run.style });
		});
	}
	return lines;
}

/** Whether a whole text is within the caps and is tokenized at once, so a comment or string that opens above the visible lines still colours them. */
export function withinCaps(lines: readonly string[]): boolean {
	if (lines.length > MAX_HIGHLIGHT_LINES) return false;
	let length = -1;
	for (const line of lines) {
		length += line.length + 1;
		if (length > MAX_HIGHLIGHT_CHARS) return false;
	}
	return true;
}

/** A longer text is tokenized in aligned chunks of this many lines, so the colours of a row do not change as a window moves over it. */
export const CHUNK_LINES = 100;

/**
 * The pieces of a text over the caps that the lines `from..to` touch: each a chunk of {@link CHUNK_LINES} lines starting at a
 * multiple of them (as many of its leading lines as fit the character cap; the rest of the chunk is shown plain).
 */
export function codeChunks(lines: readonly string[], from: number, to: number): { first: number; source: string }[] {
	const chunks: { first: number; source: string }[] = [];
	const stop = Math.min(to, lines.length);
	for (let first = Math.floor(from / CHUNK_LINES) * CHUNK_LINES; first < stop; first += CHUNK_LINES) {
		let end = first, length = -1;
		for (const last = Math.min(first + CHUNK_LINES, lines.length); end < last && length + lines[end]!.length + 1 <= MAX_HIGHLIGHT_CHARS; end++) length += lines[end]!.length + 1;
		chunks.push({ first, source: lines.slice(first, end).join("\n") });
	}
	return chunks;
}

/** The inline style of a run: only properties that never change a glyph's advance or a line's height. */
export function runCss(style: TokenStyle): { color?: string; fontStyle?: "italic"; fontWeight?: "bold"; textDecoration?: string } {
	const css: { color?: string; fontStyle?: "italic"; fontWeight?: "bold"; textDecoration?: string } = {};
	if (style.color !== null) css.color = style.color;
	if ((style.fontStyle & FONT_ITALIC) !== 0) css.fontStyle = "italic";
	if ((style.fontStyle & FONT_BOLD) !== 0) css.fontWeight = "bold";
	const lines = [(style.fontStyle & FONT_UNDERLINE) !== 0 ? "underline" : "", (style.fontStyle & FONT_STRIKETHROUGH) !== 0 ? "line-through" : ""].filter(Boolean);
	if (lines.length > 0) css.textDecoration = lines.join(" ");
	return css;
}

// One block per task, the newest first, so the block in view is coloured before history above it.
const queue: Array<() => void> = [];
let scheduled = false;

function drain(): void {
	scheduled = false;
	queue.pop()?.();
	if (queue.length > 0) {
		scheduled = true;
		setTimeout(drain, 0);
	}
}

/** Run `task` in the highlight queue; the returned function withdraws it. */
export function enqueueHighlight(task: () => void): () => void {
	queue.push(task);
	if (!scheduled) {
		scheduled = true;
		setTimeout(drain, 0);
	}
	return () => {
		const at = queue.indexOf(task);
		if (at >= 0) queue.splice(at, 1);
	};
}
