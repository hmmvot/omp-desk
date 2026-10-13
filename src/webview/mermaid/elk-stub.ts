/**
 * Stands in for `elkjs/lib/elk.bundled.js` in `media/mermaid.js` (see `esbuild.mjs`).
 *
 * ELK is 1.6 MB and EPL-2.0, and only a diagram that asks for the `elk` layout reaches it. The renderer
 * fixes the layout to `dagre` and forbids a diagram from changing it, so this constructor is never called;
 * if it ever is, the diagram fails with this message instead of loading code that was left out.
 */
export default class ELK {
	constructor() {
		throw new Error("The ELK layout is not included in this build");
	}
}
