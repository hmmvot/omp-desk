/**
 * Stands in for `katex` in `media/mermaid.js` (see `esbuild.mjs`).
 *
 * KaTeX needs its stylesheet and fonts, which the chat page does not ship, so a label with `$$…$$` is not
 * rendered; the diagram fails with this message and Chat shows its source.
 */
export default {
	renderToString(): string {
		throw new Error("Math ($$…$$) in a diagram label is not supported");
	},
};
