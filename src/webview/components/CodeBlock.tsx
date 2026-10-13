/**
 * A fenced code block of a message: the text, coloured with the editor theme when the language is one we know.
 *
 * Plain text is always the first paint and the whole answer for an unknown language, an oversized block or
 * a page that has no theme; the markup then is the same as it ever was. Colour is added by a later task, so
 * a long block never holds up a frame: an unfinished fence waits for its text to stop changing, and while
 * it grows the already coloured text stays coloured and only the new text is plain.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { cachedSpans, enqueueHighlight, isHighlightable, runCss, SETTLE_MS, spansOf, styledRuns } from "../lib/code-highlight.ts";
import type { CodeSpan } from "../lib/code-tokens.ts";
import { codeThemeSnapshot, subscribeCodeTheme } from "../lib/code-theme-store.ts";
import { CopyButton } from "./CopyButton.tsx";

interface Tokenized {
	readonly language: string;
	readonly source: string;
	readonly spans: readonly CodeSpan[];
}

export function CodeBlock({ language, source, closed }: { language: string; source: string; closed: boolean }) {
	const { styler } = useSyncExternalStore(subscribeCodeTheme, codeThemeSnapshot, codeThemeSnapshot);
	const highlightable = styler !== null && isHighlightable(language, source);
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

	let spans: readonly CodeSpan[] | null = null;
	let tail = "";
	if (highlightable) {
		if (cached !== null) spans = cached;
		else if (tokenized !== null && tokenized.language === language && source.startsWith(tokenized.source)) {
			spans = tokenized.spans;
			tail = source.slice(tokenized.source.length);
		}
	}
	const runs = useMemo(() => (spans !== null && styler !== null ? styledRuns(spans, styler) : null), [spans, styler]);

	return (
		<div className="omp-code-block">
			<pre>
				{runs === null ? (
					<code data-language={language}>{source}</code>
				) : (
					<code data-language={language} data-highlighted="">
						{runs.map((run, index) => (run.style === null ? run.text : <span key={index} style={runCss(run.style)}>{run.text}</span>))}
						{tail}
					</code>
				)}
			</pre>
			{source.length > 0 && <CopyButton text={source} label="Copy code" className="omp-code-copy" />}
		</div>
	);
}
