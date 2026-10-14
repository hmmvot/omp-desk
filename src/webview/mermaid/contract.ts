/**
 * What the chat page, the diagram tab and the lazily loaded renderer (`media/mermaid.js`, built from `./entry.ts`) agree on.
 *
 * This module imports nothing heavy, so a page can name the contract without pulling `mermaid` into its own bundle.
 * The bundles are separate files shipped together; they can still meet in different builds when the extension is
 * reinstalled under a page that stayed open, which is what {@link MERMAID_CONTRACT} is for.
 */
import { MAX_MERMAID_OPEN_CHARS } from "../../protocol/mermaid-preview.ts";
import { mermaidKeyword } from "../../shared/mermaid-source.ts";

/** Bumped whenever {@link OmpMermaid} or {@link MermaidTheme} changes shape. */
export const MERMAID_CONTRACT = 2;

/** The page's global the renderer script publishes. */
export const MERMAID_GLOBAL = "ompMermaid";

/**
 * Where a diagram is drawn, which sets how much of it is accepted. `chat` is the transcript: one render is one uninterruptible
 * main-thread task there (mermaid measures text in the page's DOM, so it cannot move to a Worker), so a source is limited. `tab`
 * is the diagram tab a reader asked for by name: a document of its own, where a slow render blocks nothing else, so the limits
 * are the ones the message that carries the source already has.
 */
export type MermaidScope = "chat" | "tab";

/**
 * What a source may be before it is handed to mermaid in the transcript. Its cost follows the number of statements, which are
 * lines and, in most types, `;`-separated parts of a line: with 80 statements the shipped bundle took at most about 0.45 s in
 * the types measured (flowchart 450 ms, class 411, state 324), and a 20,000-character source up to 7 s. `block` diagrams cost
 * the most per line (a line holds any number of blocks: 3 to 6 s at 42 to 80 lines), so the transcript does not draw them.
 */
export const MAX_MERMAID_SOURCE_CHARS = 8_000;
export const MAX_MERMAID_SOURCE_STATEMENTS = 80;

/** What the tab accepts: the source the host opens (`MAX_MERMAID_OPEN_CHARS`), no statement limit, every type. */
export const MAX_MERMAID_TAB_SOURCE_CHARS = MAX_MERMAID_OPEN_CHARS;

/** Diagram types the transcript never draws, by their first keyword, and why. */
const UNDRAWN_KINDS: Readonly<Record<string, string>> = {
	"block-beta": "Block diagrams are not drawn",
	block: "Block diagrams are not drawn",
};

/**
 * A diagram's own spacing options can ask for a canvas of any size; one larger than this (in CSS pixels, either side) is not
 * shown, nor is an SVG over the characters cap. A mermaid SVG is about 1.4 times larger as a `data:` URL, and an `<img>` took 12 MB
 * of URL when measured in Edge, so the tab's cap is a bound on memory, not a URL limit.
 */
export const MAX_MERMAID_SIDE_PX = 10_000;
export const MAX_MERMAID_TAB_SIDE_PX = 30_000;
export const MAX_MERMAID_SVG_CHARS = 1_500_000;
export const MAX_MERMAID_TAB_SVG_CHARS = 8_000_000;


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
	/** `tabHelps`: the diagram was too large for the transcript, so the tab's wider limits may draw it. */
	| { readonly ok: false; readonly message: string; readonly tabHelps?: true };

export interface OmpMermaid {
	readonly contract: number;
	/**
	 * Render `source` with `theme`; never throws, a failure is `{ ok: false }` with the first line of the reason. The limits are the
	 * document's, not the caller's: the diagram tab's document says `tab` in its {@link MERMAID_SCOPE_META}; every other is `chat`.
	 */
	render(id: string, source: string, theme: MermaidTheme): Promise<MermaidRenderResult>;
}

/** Why `source` is not drawn at all in `scope`, or `null`; checked by the page before it loads the renderer and again by the renderer. */
export function mermaidSourceRefusal(source: string, scope: MermaidScope = "chat"): string | null {
	if (scope === "tab") {
		return source.length > MAX_MERMAID_TAB_SOURCE_CHARS ? `The source is over ${MAX_MERMAID_TAB_SOURCE_CHARS.toLocaleString("en-US")} characters` : null;
	}
	if (source.length > MAX_MERMAID_SOURCE_CHARS) return `The source is over ${MAX_MERMAID_SOURCE_CHARS.toLocaleString("en-US")} characters`;
	let statements = 0;
	for (const part of source.split(/[\n;]/)) {
		if (part.trim() !== "" && ++statements > MAX_MERMAID_SOURCE_STATEMENTS) return `The source is over ${MAX_MERMAID_SOURCE_STATEMENTS} statements`;
	}
	const keyword = mermaidKeyword(source);
	return keyword === null ? null : mermaidKindRefusal(keyword);
}

/** Why a diagram type (a keyword, or the id mermaid detected) is not drawn in the transcript, or `null`. */
export function mermaidKindRefusal(kind: string): string | null {
	return UNDRAWN_KINDS[kind.toLowerCase()] ?? null;
}
