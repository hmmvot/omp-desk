/**
 * What a reply's HTML page (`components/HtmlPageBlock.tsx`) says to its frame and what it takes back. Pure functions, so the
 * policy is testable without a browser.
 *
 * The frame is `<iframe sandbox="allow-scripts" src>` of the loopback frame server (`host/html-page-server.ts`): an opaque origin,
 * so it reaches nothing of this page, of VS Code's webview host or of the workbench; no popups, forms, modals, downloads or top
 * navigation; and its own Content-Security-Policy, a response header, that allows no request of any kind and holds no nonce
 * (`shared/html-page-frame.ts`, ADR-0079). The model's markup is not part of any document this page builds: it is sent to the
 * frame by `postMessage` once the frame says `ready`, and the frame rebuilds it.
 */
import type { MermaidTheme } from "../mermaid/contract.ts";
import { HTML_PAGE_CHANNEL } from "../../shared/html-page-frame.ts";
import { safeFontFamily } from "./mermaid-theme.ts";
import type { FigurePalette } from "./svg-figure.ts";

export { HTML_PAGE_CHANNEL };

/** The longest page source shown as a page; a longer one stays a code block. */
export const MAX_HTML_PAGE_CHARS = 200_000;
/** The frame's height before the page has reported its own, the least it takes and the most it grows to (the page scrolls inside beyond it). */
export const HTML_PAGE_INITIAL_HEIGHT = 160;
export const HTML_PAGE_MIN_HEIGHT = 40;
export const HTML_PAGE_MAX_HEIGHT = 480;

/** A theme value the frame accepts: colours, font stacks and sizes, nothing that can end a declaration. */
const SAFE_VALUE = /^[#A-Za-z0-9 ,.'_()%-]{1,200}$/;

export interface HtmlPageTheme {
	/** Whether the theme is dark (`color-scheme` of the page's controls). */
	readonly dark: boolean;
	/** `--bg`, `--fg`, `--muted`, `--border`, `--surface`, `--accent`, `--success`, `--warning`, `--error`, `--c1`…`--c6`, `--font`, `--font-size` and `--font-mono`. */
	readonly variables: Readonly<Record<string, string>>;
}

/** The variables a page can read, from the theme the Chat is in (the same colours an `svg` figure's `var(--fg)` resolves to). */
export function htmlPageTheme(theme: MermaidTheme, palette: FigurePalette, monoFont: string): HtmlPageTheme {
	const candidates: [string, string][] = [
		["--bg", theme.variables.background ?? ""],
		["--fg", palette.fg],
		["--muted", palette.muted],
		["--border", palette.border],
		["--surface", palette.surface],
		["--accent", palette.accent],
		["--success", palette.success],
		["--warning", palette.warning],
		["--error", palette.error],
		["--c1", palette.c1],
		["--c2", palette.c2],
		["--c3", palette.c3],
		["--c4", palette.c4],
		["--c5", palette.c5],
		["--c6", palette.c6],
		["--font", safeFontFamily(theme.fontFamily)],
		["--font-size", theme.fontSize],
		["--font-mono", safeFontFamily(monoFont)],
	];
	const variables: Record<string, string> = {};
	for (const [name, value] of candidates) if (SAFE_VALUE.test(value)) variables[name] = value;
	return { dark: theme.darkMode, variables };
}

/** A character a page source cannot hold: NUL and unpaired surrogates would make the frame's document ill-formed. */
const ILLEGAL = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export type PreparedHtmlPage = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** Whether a page source can be shown as a page, or why not. */
export function prepareHtmlPage(source: string): PreparedHtmlPage {
	if (source.trim().length === 0) return { ok: false, reason: "The page is empty" };
	if (source.length > MAX_HTML_PAGE_CHARS) return { ok: false, reason: `The page is larger than ${MAX_HTML_PAGE_CHARS.toLocaleString("en-US")} characters` };
	if (ILLEGAL.test(source)) return { ok: false, reason: "The page has a character HTML does not allow" };
	return { ok: true };
}

/** The one message that gives a frame its page: the source, in the theme the Chat is in now. */
export function htmlPageMessage(source: string, theme: HtmlPageTheme): Record<string, unknown> {
	return { [HTML_PAGE_CHANNEL]: "page", html: source, dark: theme.dark, variables: theme.variables };
}

/** The message that gives a running frame a new theme. */
export function htmlPageThemeMessage(theme: HtmlPageTheme): Record<string, unknown> {
	return { [HTML_PAGE_CHANNEL]: "theme", dark: theme.dark, variables: theme.variables };
}

/** Whether a frame's message is its `ready` report: its listener is running and takes the page. */
export function isHtmlPageReady(data: unknown): boolean {
	return typeof data === "object" && data !== null && (data as Record<string, unknown>)[HTML_PAGE_CHANNEL] === "ready";
}

/** The height a frame reported, clamped to what a page may take, or `null` for anything that is not a size report. */
export function parseHtmlPageSize(data: unknown): number | null {
	if (typeof data !== "object" || data === null) return null;
	const record = data as Record<string, unknown>;
	if (record[HTML_PAGE_CHANNEL] !== "size" || typeof record.height !== "number" || !Number.isFinite(record.height)) return null;
	return Math.min(HTML_PAGE_MAX_HEIGHT, Math.max(HTML_PAGE_MIN_HEIGHT, Math.ceil(record.height)));
}
