/**
 * What the chat page and the lazily loaded renderer (`media/mermaid.js`, built from `./entry.ts`) agree on.
 *
 * This module imports nothing, so the page can name the contract without pulling `mermaid` into `guest.js`.
 * Both sides are separate bundles shipped together; they can still meet in different builds when the
 * extension is reinstalled under a page that stayed open, which is what {@link MERMAID_CONTRACT} is for.
 */

/** Bumped whenever {@link OmpMermaid} or {@link MermaidTheme} changes shape. */
export const MERMAID_CONTRACT = 2;

/** The page's global the renderer script publishes. */
export const MERMAID_GLOBAL = "ompMermaid";

/**
 * What a source may be before it is handed to mermaid at all. One render is one uninterruptible main-thread task
 * (mermaid measures text in the page's DOM, so it cannot move to a Worker). Its cost follows the number of
 * statements, which are lines and, in most types, `;`-separated parts of a line: with 80 statements the shipped
 * bundle took at most about 0.45 s in the types measured (flowchart 450 ms, class 411, state 324), and a 20,000-character
 * source up to 7 s. `block` diagrams cost the most per line (a line holds any number of blocks: 3 to 6 s at 42 to 80
 * lines), so they are not drawn.
 */
export const MAX_MERMAID_SOURCE_CHARS = 8_000;
export const MAX_MERMAID_SOURCE_STATEMENTS = 80;

/** Diagram types that are never drawn, by their first keyword, and why. */
const UNDRAWN_KINDS: Readonly<Record<string, string>> = {
	"block-beta": "Block diagrams are not drawn",
	block: "Block diagrams are not drawn",
};

/** A diagram's own spacing options can ask for a canvas of any size; one larger than this (in CSS pixels, either side) or this many characters of SVG is not shown. */
export const MAX_MERMAID_SIDE_PX = 10_000;
export const MAX_MERMAID_SVG_CHARS = 1_500_000;

/** Concrete colours and font the page resolved from the VS Code theme; mermaid cannot read `var(…)`. */
export interface MermaidTheme {
	readonly darkMode: boolean;
	readonly fontFamily: string;
	readonly fontSize: string;
	/** The reader asked for reduced motion: edge animations inside the diagram are switched off. */
	readonly reducedMotion: boolean;
	/** Mermaid `themeVariables` of the `base` theme, every value a `#rrggbb` colour. */
	readonly variables: Readonly<Record<string, string>>;
}

export type MermaidRenderResult =
	| { readonly ok: true; readonly svg: string; readonly width: number; readonly height: number }
	| { readonly ok: false; readonly message: string };

export interface OmpMermaid {
	readonly contract: number;
	/** Render `source` with `theme`; never throws, a failure is `{ ok: false }` with the first line of the reason. */
	render(id: string, source: string, theme: MermaidTheme): Promise<MermaidRenderResult>;
}

/**
 * The diagram type's first keyword, lower-cased, after any front matter, `%%{init …}%%` directive (possibly over several
 * lines) and `%%` comment lines; `null` when there is none.
 */
export function mermaidKeyword(source: string): string | null {
	// Front matter ends at a line that is only `---`; a `---` inside a value does not end it (mermaid reads it the same way).
	const body = source.replace(/^\s*---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "").replace(/^(?:\s*%%\{[\s\S]*?\}%%|\s*%%[^\n]*)+/, "");
	return /^\s*([A-Za-z][\w-]*)/.exec(body)?.[1]?.toLowerCase() ?? null;
}

/** Why `source` is not drawn at all, or `null`; checked by the page before it loads the renderer and again by the renderer. */
export function mermaidSourceRefusal(source: string): string | null {
	if (source.length > MAX_MERMAID_SOURCE_CHARS) return `The source is over ${MAX_MERMAID_SOURCE_CHARS.toLocaleString("en-US")} characters`;
	let statements = 0;
	for (const part of source.split(/[\n;]/)) {
		if (part.trim() !== "" && ++statements > MAX_MERMAID_SOURCE_STATEMENTS) return `The source is over ${MAX_MERMAID_SOURCE_STATEMENTS} statements`;
	}
	const keyword = mermaidKeyword(source);
	return keyword === null ? null : mermaidKindRefusal(keyword);
}

/** Why a diagram type (a keyword, or the id mermaid detected) is never drawn, or `null`. */
export function mermaidKindRefusal(kind: string): string | null {
	return UNDRAWN_KINDS[kind.toLowerCase()] ?? null;
}
