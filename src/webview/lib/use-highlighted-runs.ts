/**
 * The themed runs of one piece of code, for every place that shows code: a fenced block, a tool card's
 * file preview, a diff's sides, a command in a tool's header.
 *
 * Plain text is always the first paint; colour arrives from a later task so long code never holds up a
 * frame. Code that is still being written waits for its text to stop changing, and while it grows the
 * text that was already coloured stays coloured and only the new text is plain.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { cachedSpans, codeWindow, enqueueHighlight, isHighlightable, runsByLine, SETTLE_MS, spansOf, styledRuns, type StyledRun } from "./code-highlight.ts";
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

/**
 * Colours the lines `from..to` of `lines` that a view shows, tokenizing the whole text when it is within the
 * caps so multi-line constructs keep their colour, and only the window otherwise ({@link codeWindow}).
 * Lines that stay plain answer `null`.
 */
export function useCodeLines(language: string | null, lines: readonly string[], from: number, to: number, closed: boolean): CodeLines {
	const window = useMemo(() => (language === null ? null : codeWindow(lines, from, to)), [language, lines, from, to]);
	const runs = useHighlightedRuns(language, window?.source ?? "", closed);
	return useMemo(() => {
		if (runs === null || window === null) return PLAIN;
		const split = runsByLine(runs);
		return { at: (index: number) => split[index - window.first] ?? null };
	}, [runs, window]);
}
