/**
 * The lazily loaded diagram renderer: `media/mermaid.js`, a classic script of its own.
 *
 * The chat page (`guest.js`) never imports this file; it adds a `<script>` for it when the first closed
 * `mermaid` block of the page needs drawing (`../lib/mermaid-render.ts`). The script publishes one global,
 * {@link OmpMermaid}, and does nothing else on load.
 *
 * Model text reaches `mermaid.render` here, so every behaviour the policy depends on is stated in
 * {@link configuration} instead of being left to mermaid's defaults, which change between major versions
 * (12.x made ELK the default layout):
 *
 * - `securityLevel: "strict"` with `htmlLabels: false`: no click callbacks, no HTML labels or `foreignObject`
 *   in the flowchart, class and state diagrams, text escaped (a `click … href` still yields an `<a>`, which is
 *   inert inside the image the page shows);
 * - `layout: "dagre"` and a `secure` list that also covers theme, CSS, layout, look, font and security keys, so
 *   a diagram's own `%%{init}%%` or front matter cannot change them;
 * - the source is limited before it reaches mermaid ({@link mermaidSourceRefusal}), `maxEdges` bounds a flowchart,
 *   and the SVG that comes back is limited in size.
 *
 * What the renderer does not do is isolate: while it runs, mermaid builds the diagram in the page's own document
 * (the measuring container below), where its `<style>` takes the page nonce. The isolation is the image the page
 * shows afterwards, and the document policy during the render.
 */
import mermaid from "mermaid";
import {
	MAX_MERMAID_SIDE_PX, MAX_MERMAID_SVG_CHARS, MAX_MERMAID_SOURCE_CHARS, MERMAID_CONTRACT, MERMAID_GLOBAL, mermaidKindRefusal, mermaidSourceRefusal,
	type MermaidRenderResult, type MermaidTheme, type OmpMermaid,
} from "./contract.ts";

/** Edges a flowchart may have (mermaid enforces it in the flowchart parser only). */
const MAX_EDGES = 200;

/** Keys a diagram's own directive or front matter may not set, on top of mermaid's own secure keys. */
const SECURE_KEYS = [
	"secure", "securityLevel", "startOnLoad", "maxTextSize", "suppressErrorRendering", "maxEdges",
	"theme", "themeVariables", "themeCSS", "layout", "look", "fontFamily", "fontSize", "htmlLabels", "darkMode",
];

/** The edge animations of a diagram that asks for them (`animate: true`), switched off for a reader who asked for less motion. */
const STILL_CSS = ".edge-animation-slow, .edge-animation-fast { animation: none !important; }";

function configuration(theme: MermaidTheme): Parameters<typeof mermaid.initialize>[0] {
	return {
		startOnLoad: false,
		securityLevel: "strict",
		suppressErrorRendering: true,
		theme: "base",
		layout: "dagre",
		look: "classic",
		htmlLabels: false,
		flowchart: { htmlLabels: false },
		maxTextSize: MAX_MERMAID_SOURCE_CHARS,
		maxEdges: MAX_EDGES,
		fontFamily: theme.fontFamily,
		themeCSS: theme.reducedMotion ? STILL_CSS : "",
		secure: SECURE_KEYS,
		themeVariables: { ...theme.variables, darkMode: theme.darkMode, fontFamily: theme.fontFamily, fontSize: theme.fontSize },
	};
}

let applied: string | null = null;

/** Mermaid's configuration is global: renders are serialized by the page, and each one starts from the theme it was asked for. */
function configure(theme: MermaidTheme): void {
	const key = JSON.stringify(theme);
	if (key === applied) return;
	mermaid.initialize(configuration(theme));
	applied = key;
}

let sandbox: HTMLElement | null = null;

/** Where mermaid measures text: off screen, laid out (`display: none` would make every size zero), never seen or focused, emptied after each render. */
function measuringContainer(): HTMLElement {
	if (sandbox !== null && sandbox.isConnected) return sandbox;
	sandbox = document.createElement("div");
	sandbox.setAttribute("aria-hidden", "true");
	sandbox.setAttribute("inert", "");
	sandbox.style.cssText = "position:fixed;left:-10000px;top:0;width:1200px;height:0;overflow:hidden;visibility:hidden;pointer-events:none";
	document.body.append(sandbox);
	return sandbox;
}

/** The reason, reduced to its first line: mermaid's parse errors quote the source and a caret ruler after it. */
function firstLine(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error);
	return (text.split(/\r?\n/, 1)[0] ?? "").replace(/:\s*$/, "").trim() || "Unknown error";
}

/**
 * The diagram as a standalone XML document string, which is what an `<img>` can decode.
 *
 * Mermaid hands back the serialization of an HTML-parsed tree, so a non-breaking space comes out as `&nbsp;`
 * (not an XML entity: the image would fail to load) and the page's nonce is copied onto the `<style>` element.
 * Parsing the string again in an inert HTML document and writing the root `<svg>` out with the XML serializer
 * fixes the first; the nonce is of no use inside an image, so it is dropped.
 */
function asXml(svg: string): string | null {
	const root = new DOMParser().parseFromString(svg, "text/html").querySelector("svg");
	if (root === null) return null;
	for (const element of [root, ...root.querySelectorAll("*")]) element.removeAttribute("nonce");
	return new XMLSerializer().serializeToString(root);
}

/** The diagram's size in CSS pixels from the root's `viewBox` (every diagram type sets one), or `null`. */
function sizeOf(svg: string): { width: number; height: number } | null {
	const root = /<svg\b[^>]*>/.exec(svg)?.[0] ?? "";
	const box = /\bviewBox="([^"]*)"/.exec(root)?.[1]?.trim().split(/[\s,]+/).map(Number);
	if (box === undefined || box.length !== 4) return null;
	const [width, height] = [box[2] as number, box[3] as number];
	return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 ? { width, height } : null;
}

let sequence = 0;

async function render(id: string, source: string, theme: MermaidTheme): Promise<MermaidRenderResult> {
	const refusal = mermaidSourceRefusal(source);
	if (refusal !== null) return { ok: false, message: refusal };
	// Mermaid wants an element id that is unique in the document and starts with a letter.
	const elementId = `omp-mermaid-${++sequence}-${id.replace(/[^A-Za-z0-9_-]/g, "")}`;
	try {
		configure(theme);
		// Mermaid's own reading of the type decides: a header written to fool the page's keyword check is still a block diagram here. Parsing is cheap; layout is the cost.
		const parsed = await mermaid.parse(source, { suppressErrors: true });
		const undrawn = parsed === false ? null : mermaidKindRefusal(parsed.diagramType);
		if (undrawn !== null) return { ok: false, message: undrawn };
		const { svg: drawn } = await mermaid.render(elementId, source, measuringContainer());
		if (drawn.length > MAX_MERMAID_SVG_CHARS) return { ok: false, message: "The diagram is too large" };
		const svg = asXml(drawn);
		if (svg === null) return { ok: false, message: "The diagram has no drawing" };
		const size = sizeOf(svg);
		if (size === null) return { ok: false, message: "The diagram has no size" };
		if (size.width > MAX_MERMAID_SIDE_PX || size.height > MAX_MERMAID_SIDE_PX) return { ok: false, message: "The diagram is too large" };
		return { ok: true, svg, ...size };
	} catch (error) {
		return { ok: false, message: firstLine(error) };
	} finally {
		// A failed render leaves its measuring element behind.
		document.getElementById(`d${elementId}`)?.remove();
		sandbox?.replaceChildren();
	}
}

const renderer: OmpMermaid = { contract: MERMAID_CONTRACT, render };
Reflect.set(window, MERMAID_GLOBAL, renderer);
