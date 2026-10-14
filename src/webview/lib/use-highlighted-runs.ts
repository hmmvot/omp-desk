/**
 * The themed runs of one piece of code, for every place that shows code: a fenced block, a tool card's
 * file preview, a diff's sides, a command in a tool's header.
 *
 * Plain text is always the first paint; colour arrives from a later task so long code never holds up a
 * frame. Code that is still being written waits for its text to stop changing, and while it grows the
 * text that was already coloured stays coloured and only the new text is plain.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { cachedSpans, CHUNK_LINES, codeChunks, enqueueHighlight, isHighlightable, runsByLine, SETTLE_MS, spansOf, styledRuns, withinCaps, type StyledRun } from "./code-highlight.ts";
import type { CodeSpan } from "./code-tokens.ts";
import { codeThemeSnapshot, subscribeCodeTheme } from "./code-theme-store.ts";

interface Tokenized {
	readonly language: string;
	readonly source: string;
	readonly spans: readonly CodeSpan[];
}

/**
 * `source` in `language` (a fence id or alias) as styled runs spelling exactly `source`, or `null` while
 * it is plain: no language, no theme, over the caps, or not yet coloured. `closed` is false while the text
 * is still growing.
 */
export function useHighlightedRuns(language: string | null, source: string, closed: boolean): StyledRun[] | null {
	const { styler } = useSyncExternalStore(subscribeCodeTheme, codeThemeSnapshot, codeThemeSnapshot);
	const highlightable = language !== null && styler !== null && isHighlightable(language, source);
	const cached = useMemo(() => (highlightable ? cachedSpans(language, source) : null), [highlightable, language, source]);
	const [tokenized, setTokenized] = useState<Tokenized | null>(null);

	useEffect(() => {
		if (!highlightable || cached !== null) return;
		let withdraw: (() => void) | null = null;
		const timer = setTimeout(
			() => {
				withdraw = enqueueHighlight(() => {
					const spans = spansOf(language, source);
					setTokenized(spans === null ? null : { language, source, spans });
				});
			},
			closed ? 0 : SETTLE_MS,
		);
		return () => {
			clearTimeout(timer);
			withdraw?.();
		};
	}, [highlightable, cached, closed, language, source]);

	return useMemo(() => {
		if (!highlightable || styler === null) return null;
		let spans: readonly CodeSpan[] | null = null;
		let tail = "";
		if (cached !== null) spans = cached;
		else if (tokenized !== null && tokenized.language === language && source.startsWith(tokenized.source)) {
			spans = tokenized.spans;
			tail = source.slice(tokenized.source.length);
		}
		if (spans === null) return null;
		const runs = styledRuns(spans, styler);
		if (tail !== "") {
			const last = runs.at(-1);
			if (last !== undefined && last.style === null) runs[runs.length - 1] = { text: last.text + tail, style: null };
			else runs.push({ text: tail, style: null });
		}
		return runs;
	}, [highlightable, styler, cached, tokenized, language, source]);
}

/** The runs of lines `from..to` of `lines` (`null` while plain), in `language`; the runs of line `index` are `at(index)`. */
export interface CodeLines {
	at(index: number): readonly StyledRun[] | null;
}

const PLAIN: CodeLines = { at: () => null };
const NO_CHUNKS: readonly { first: number; source: string }[] = [];

/**
 * The runs of each chunk a view of a long text touches, as lines. A chunk is coloured once, from a later task, and stays in the
 * cache: moving the view over the text never recolours a row, and a row is plain only until its chunk has been tokenized.
 */
function useChunkRuns(language: string | null, chunks: readonly { first: number; source: string }[], closed: boolean): ReadonlyMap<number, readonly (readonly StyledRun[])[]> {
	const { styler } = useSyncExternalStore(subscribeCodeTheme, codeThemeSnapshot, codeThemeSnapshot);
	const [done, setDone] = useState(0);
	useEffect(() => {
		if (language === null || styler === null) return;
		const pending: Array<() => void> = [];
		const timers: ReturnType<typeof setTimeout>[] = [];
		for (const chunk of chunks) {
			if (chunk.source === "" || !isHighlightable(language, chunk.source) || cachedSpans(language, chunk.source) !== null) continue;
			timers.push(setTimeout(() => { pending.push(enqueueHighlight(() => { spansOf(language, chunk.source); setDone(count => count + 1); })); }, closed ? 0 : SETTLE_MS));
		}
		return () => { for (const timer of timers) clearTimeout(timer); for (const withdraw of pending) withdraw(); };
	}, [language, styler, chunks, closed]);
	return useMemo(() => {
		const runs = new Map<number, readonly (readonly StyledRun[])[]>();
		if (language === null || styler === null) return runs;
		for (const chunk of chunks) {
			const spans = chunk.source === "" ? null : cachedSpans(language, chunk.source);
			if (spans !== null) runs.set(chunk.first, runsByLine(styledRuns(spans, styler)));
		}
		return runs;
		// `done` is what tells this a chunk was tokenized since.
	}, [language, styler, chunks, done]);
}

/**
 * Colours the lines `from..to` of `lines` that a view shows. A text within the caps is tokenized whole so multi-line
 * constructs keep their colour; a longer one in aligned chunks of 100 lines that stay in the cache as the view moves,
 * so a row's colours never change under a scroll. Lines that stay plain answer `null`.
 */
export function useCodeLines(language: string | null, lines: readonly string[], from: number, to: number, closed: boolean): CodeLines {
	const whole = useMemo(() => language !== null && withinCaps(lines), [language, lines]);
	const source = useMemo(() => (whole ? lines.join("\n") : ""), [whole, lines]);
	const runs = useHighlightedRuns(whole ? language : null, source, closed);
	const chunks = useMemo(() => (language === null || whole ? NO_CHUNKS : codeChunks(lines, from, to)), [language, whole, lines, from, to]);
	const chunked = useChunkRuns(whole ? null : language, chunks, closed);
	return useMemo(() => {
		if (whole) {
			if (runs === null) return PLAIN;
			const split = runsByLine(runs);
			return { at: (index: number) => split[index] ?? null };
		}
		if (chunked.size === 0) return PLAIN;
		return { at: (index: number) => chunked.get(Math.floor(index / CHUNK_LINES) * CHUNK_LINES)?.[index % CHUNK_LINES] ?? null };
	}, [whole, runs, chunked]);
}
