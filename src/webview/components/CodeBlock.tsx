/**
 * A fenced code block of a message: the text, coloured with the editor theme when the language is one we know.
 *
 * Plain text is always the first paint and the whole answer for an unknown language, an oversized block or
 * a page that has no theme; the markup then is the same as it ever was. Colour is added by a later task
 * ({@link useHighlightedRuns}), so a long block never holds up a frame.
 */
import { useHighlightedRuns } from "../lib/use-highlighted-runs.ts";
import { CodeRuns } from "./CodeRuns.tsx";
import { CopyButton } from "./CopyButton.tsx";

/** `leaf` is the quote record number of a block in a quotable message (`data-md-leaf`). */
export function CodeBlock({ language, source, closed, copy = true, leaf }: { language: string; source: string; closed: boolean; copy?: boolean; leaf?: number }) {
	const runs = useHighlightedRuns(language, source, closed);
	return (
		<div className="omp-code-block" data-md-leaf={leaf}>
			<pre>
				{runs === null ? (
					<code data-language={language}>{source}</code>
				) : (
					<code data-language={language} data-highlighted="">
						<CodeRuns runs={runs} />
					</code>
				)}
			</pre>
			{copy && source.length > 0 && <CopyButton text={source} label="Copy code" className="omp-code-copy" />}
		</div>
	);
}
