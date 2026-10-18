/**
 * A display math block of a message (`$$ … $$`, `\[ … \]` or a bare math environment on lines of their own): the formula's
 * stacked layout as monospace text (`lib/latex-block.ts`), one line of the layout per line of the text.
 *
 * The shown text is the DOM text and nothing else: Find reads it, and a selection of it quotes as the text selected (the
 * block's leaf has the code leaf's shape, so `quote-selection` reads its `<code>`). The TeX is the tooltip, never markup.
 */
export function MathBlock({ shown, source, leaf }: { shown: readonly string[]; source: string; leaf?: number }) {
	return (
		<div className="omp-math-block" data-md-leaf={leaf} title={source}>
			<pre>
				<code>{shown.join("\n")}</code>
			</pre>
		</div>
	);
}
