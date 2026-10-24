/**
 * A fenced code block of a message: the text, coloured with the editor theme when the language is one we know.
 *
 * Plain text is always the first paint and the whole answer for an unknown language, an oversized block or
 * a page that has no theme; the markup then is the same as it ever was. Colour is added by a later task
 * ({@link useHighlightedRuns}), so a long block never holds up a frame.
 */
import { useContext, useEffect, useRef, useState } from "react";
import { codeWrapKey, isCodeWrapped, setCodeWrapped, showsWrapToggle } from "../lib/code-wrap.ts";
import { useHighlightedRuns } from "../lib/use-highlighted-runs.ts";
import { CodeRuns } from "./CodeRuns.tsx";
import { CodeWrapScopeContext } from "./CodeWrapScope.tsx";
import { WrapButton } from "./OutputWrap.tsx";
import { CopyButton } from "./CopyButton.tsx";

/**
 * `leaf` is the quote record number of a block in a quotable message (`data-md-leaf`). `name` is the block's place in its Markdown
 * text: with the row's scope it names the block, so the reader's choice to wrap its lines outlives the row's unmount.
 */
export function CodeBlock({ language, source, closed, copy = true, leaf, name }: { language: string; source: string; closed: boolean; copy?: boolean; leaf?: number; name?: string }) {
	const runs = useHighlightedRuns(language, source, closed);
	const scope = useContext(CodeWrapScopeContext);
	const key = name === undefined ? null : codeWrapKey(scope, name);
	const [wrapped, setWrapped] = useState(() => isCodeWrapped(key));
	const [overflows, setOverflows] = useState(false);
	const pre = useRef<HTMLPreElement>(null);
	// Wider than the box is read where the browser has just laid the block out: a resize of the box and growth of its text (streaming, colour arriving) both resize one of the two observed elements, and nothing is measured per frame otherwise.
	useEffect(() => {
		const box = pre.current;
		const text = box?.firstElementChild;
		// While wrapped nothing is measured and the last answer stays, so the button does not blink away under the pointer when it unwraps.
		if (box === null || text === null || text === undefined || wrapped) return;
		const measure = (): void => setOverflows(showsWrapToggle(false, box.scrollWidth, box.clientWidth));
		const observer = new ResizeObserver(measure);
		observer.observe(box);
		observer.observe(text);
		measure();
		return () => observer.disconnect();
	}, [wrapped]);
	const toggle = (): void => {
		const next = !wrapped;
		setWrapped(next);
		setCodeWrapped(key, next);
	};
	const wrapButton = wrapped || overflows;
	return (
		<div className="omp-code-block" data-md-leaf={leaf} data-wrapped={wrapped ? "" : undefined}>
			<pre ref={pre}>
				{runs === null ? (
					<code data-language={language}>{source}</code>
				) : (
					<code data-language={language} data-highlighted="">
						<CodeRuns runs={runs} />
					</code>
				)}
			</pre>
			{(copy && source.length > 0 || wrapButton) && (
				<div className="omp-code-actions">
					{wrapButton && <WrapButton wrapped={wrapped} onToggle={toggle} />}
					{copy && source.length > 0 && <CopyButton text={source} label="Copy code" className="omp-code-copy" />}
				</div>
			)}
		</div>
	);
}
