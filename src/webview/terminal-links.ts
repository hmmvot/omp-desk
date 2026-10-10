/** Terminal-link exchange between page and host; the cwd is owned by the host and never supplied by the page. */
export interface TerminalLinkRequest {
	type: "omp:terminal-link-validate" | "omp:terminal-link-open";
	requestId: number;
	target: string;
	/** Where an `http(s)` target opens: an editor tab (Simple Browser) or the external browser. Only on an open. */
	mode?: WebLinkMode;
	/** Chat only: a folder is a valid target too. Terminal links name files alone. */
	folders?: true;
	/** Chat only, on an open: what a modified click does with a file or folder instead of the plain open. */
	action?: FileLinkAction;
	/** Chat only, on an open: `target` is a code symbol with several definitions; the host opens VS Code's workspace symbol search prefilled with its name instead of a file. */
	search?: true;
}
export interface TerminalLinkValidation {
	type: "omp:terminal-link-validation";
	requestId: number;
	valid: boolean;
}
/** A plain click (or Enter) opens a web link in an editor tab; Ctrl+Click (or Ctrl+Enter) in the external browser. */
export type WebLinkMode = "editor" | "external";
/** Ctrl+Click on a Chat file link reveals it in VS Code's Explorer instead of opening it; Ctrl+Shift+Click shows it in the system file manager. */
export type FileLinkAction = "reveal" | "os";
/**
 * The context menus of Chat file and web links (`webview/context` in package.json). VS Code reads the
 * link's `data-vscode-context`, makes each key a context key for the menu's `when` clauses and passes
 * the object, plus `webview` (the panel's viewType), to the chosen command.
 */
export const FILE_LINK_MENU_SECTION = "ompFileLink";
export const WEB_LINK_MENU_SECTION = "ompWebLink";
export interface FileLinkMenuContext {
	readonly webviewSection: typeof FILE_LINK_MENU_SECTION;
	readonly ompFileLinkTarget: string;
}
export interface WebLinkMenuContext {
	readonly webviewSection: typeof WEB_LINK_MENU_SECTION;
	readonly ompWebLinkUrl: string;
}
export function fileLinkMenuContext(target: string): string {
	return JSON.stringify({ webviewSection: FILE_LINK_MENU_SECTION, ompFileLinkTarget: target } satisfies FileLinkMenuContext);
}
export function webLinkMenuContext(url: string): string {
	return JSON.stringify({ webviewSection: WEB_LINK_MENU_SECTION, ompWebLinkUrl: url } satisfies WebLinkMenuContext);
}
export const MAX_TERMINAL_LINK_LENGTH = 4096;
export function isTerminalLinkTarget(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= MAX_TERMINAL_LINK_LENGTH && !/[\u0000-\u001f\u007f]/.test(value);
}
/**
 * The normalized `http:`/`https:` URL `value` names, or `null` for any other scheme, a relative or
 * malformed address, or one without a host. Page and host both apply it: the page to decide what
 * becomes a web link, the host again before it opens anything.
 */
export function webLinkUrl(value: string): string | null {
	const trimmed = value.trim();
	if (!isTerminalLinkTarget(trimmed) || !/^https?:\/\//i.test(trimmed)) return null;
	let url: URL;
	try { url = new URL(trimmed); }
	catch { return null; }
	if ((url.protocol !== "http:" && url.protocol !== "https:") || url.hostname === "") return null;
	return isTerminalLinkTarget(url.href) ? url.href : null;
}
export function parseTerminalLinkRequest(value: Record<string, unknown>): TerminalLinkRequest | null {
	if (value.type !== "omp:terminal-link-validate" && value.type !== "omp:terminal-link-open") return null;
	const keys = value.type === "omp:terminal-link-open" ? ["type", "requestId", "target", "mode", "folders", "action", "search"] : ["type", "requestId", "target", "folders"];
	if (Object.keys(value).some(key => !keys.includes(key))) return null;
	if (!Number.isSafeInteger(value.requestId) || Number(value.requestId) < 0 || !isTerminalLinkTarget(value.target)) return null;
	if (value.mode !== undefined && value.mode !== "editor" && value.mode !== "external") return null;
	if (value.folders !== undefined && value.folders !== true) return null;
	if (value.action !== undefined && value.action !== "reveal" && value.action !== "os") return null;
	if (value.search !== undefined && (value.search !== true || value.type !== "omp:terminal-link-open")) return null;
	return {
		type: value.type, requestId: Number(value.requestId), target: value.target,
		...(value.mode === undefined ? {} : { mode: value.mode }),
		...(value.folders === undefined ? {} : { folders: true as const }),
		...(value.action === undefined ? {} : { action: value.action }),
		...(value.search === undefined ? {} : { search: true as const }),
	};
}
export function parseTerminalLinkValidation(value: Record<string, unknown>): TerminalLinkValidation | null {
	if (value.type !== "omp:terminal-link-validation" || typeof value.valid !== "boolean" || !Number.isSafeInteger(value.requestId) || Number(value.requestId) < 0) return null;
	return { type: value.type, requestId: Number(value.requestId), valid: value.valid };
}

export interface TerminalTextLink { readonly target: string; readonly start: number; readonly end: number }
/**
 * Quotes preserve spaces; drive paths can also carry unquoted spaces before a filename
 * extension or explicit position. A single quote is only a quote when it is not an
 * apostrophe inside a word, or prose like "it's ... isn't" would swallow a real path.
 * Only host-proven files become links.
 *
 * A position follows a path as `:12`, `:12:3`, `:12-30`, `:L12-L30`, `#L12`, `#L12-30` or `#L12C3`;
 * the host reads the start of a range as the line to reveal.
 */
const TERMINAL_LINK_TOKENS = /"([^"\r\n]+)"|(?<![\p{L}\d])'([^'\r\n]+)'(?![\p{L}\d])|`([^`\r\n]+)`|[a-z]:[\\/][^\r\n<>"'`|]*?(?:\.[\p{L}\d_-]+(?::L?\d+(?::\d+)?(?:-L?\d+(?::\d+)?)?|#L\d+(?:[:C]\d+)?(?:-L?\d+(?:[:C]\d+)?)?)?|:L?\d+(?::\d+)?(?:-L?\d+(?::\d+)?)?|#L\d+(?:[:C]\d+)?(?:-L?\d+(?:[:C]\d+)?)?)(?=$|[\s,;.!?)\]}:])|[^\s<>"'`|()\[\]{}]+/giu;
/** Offsets are UTF-16 offsets into `text`; the renderer maps them to actual terminal cells. */
export function detectTerminalFileLinks(text: string): TerminalTextLink[] {
	const links: TerminalTextLink[] = [];
	for (const match of text.matchAll(TERMINAL_LINK_TOKENS)) {
		const quoted = match[1] ?? match[2] ?? match[3];
		const raw = quoted ?? match[0];
		const target = raw.replace(/[.,;:!?]+$/, "");
		if (!isTerminalLinkTarget(target)) continue;
		// Schemes are only accepted via OSC8; exclude URLs from the local provider.
		if (/^[a-z][a-z\d+.-]*:/i.test(target) && !/^[a-z]:[\\/]/i.test(target) && !/^[^:]+:L?\d+(?::\d+)?(?:-L?\d+(?::\d+)?)?$/i.test(target)) continue;
		const start = match.index + (quoted === undefined ? 0 : 1);
		links.push({ target, start, end: start + target.length });
	}
	return links;
}
