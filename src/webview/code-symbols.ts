import { isTerminalLinkTarget } from "./terminal-links.ts";

/**
 * Inline code that names a code symbol: which spans are candidates, and the exchange the page uses to ask
 * the host where one is defined. Page and host both run {@link parseCodeSymbol}: the page to decide what to
 * ask about, the host again on whatever it is asked, so the page is never trusted to have normalized.
 */

export const MAX_SYMBOL_TOKEN_LENGTH = 120;
export const MAX_SYMBOL_TOKENS_PER_REQUEST = 16;

export interface CodeSymbol {
	/** The identifiers in order: `A.B.C` is `["A", "B", "C"]`. */
	readonly segments: readonly string[];
	/** `segments` joined by `.`: the canonical name two spellings of one symbol share. */
	readonly name: string;
	/** The last segment: the name a provider is asked for. */
	readonly last: string;
	/** Written as an attribute: `[AllowedOn]`. */
	readonly attribute: boolean;
	/** Written with a call suffix: `parse()`, `Cast(x)`. */
	readonly call: boolean;
}

/** Words that name the language, not a symbol of the workspace. Case-sensitive: `String` is a type, `string` a keyword. */
const KEYWORDS: Record<string, true> = Object.fromEntries([
	"abstract any as async await base bigint bool boolean break byte case catch char class const continue debugger decimal declare def default",
	"delete do double elif else enum event except explicit export extends extern false finally float for foreach from function get global goto if",
	"implements implicit import in instanceof int interface internal is lambda let lock long module namespace never new nil none null number",
	"object of operator out override package params pass private protected public raise readonly record ref require return sbyte sealed set short",
	"sizeof static string struct super switch symbol this throw true try type typeof uint ulong undefined unknown unsafe ushort using var virtual",
	"void volatile when where while with yield",
].join(" ").split(" ").map(word => [word, true]));
const RECEIVERS: Record<string, true> = { this: true, base: true, self: true, super: true, cls: true };
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** `text` with every balanced `<...>` group removed, or `null` when a group is unbalanced or holds more than type arguments. */
function withoutGenerics(text: string): string | null {
	let depth = 0;
	let out = "";
	let inner = "";
	for (const char of text) {
		if (char === "<") { depth++; continue; }
		if (char === ">") {
			if (depth === 0) return null;
			if (--depth === 0) { if (!/^[\w$\s,.<>?\[\]*&:]*$/.test(inner)) return null; inner = ""; }
			continue;
		}
		if (depth > 0) inner += char; else out += char;
	}
	return depth === 0 ? out : null;
}

/** `text` without its final balanced `(...)`, which must close the text; `null` when no such call suffix. */
function withoutCall(text: string): string | null {
	if (!text.endsWith(")")) return null;
	let depth = 0;
	for (let index = text.length - 1; index >= 0; index--) {
		const char = text[index];
		if (char === ")") depth++;
		else if (char === "(" && --depth === 0) return index === 0 ? null : text.slice(0, index);
	}
	return null;
}

/**
 * The code symbol one inline code span names, or `null`. Generic argument lists, array and nullable suffixes, one
 * call argument list and a whole-span attribute wrapper (`[AllowedOn]`, `[AllowedOn(typeof(X))]`) are stripped;
 * what remains must be one to four identifiers joined by `.`. Spans with spaces, operators, literals or keywords,
 * a last name shorter than three characters and bare all-lowercase words (prose: `main`, `json`) are not symbols;
 * a bare lowercase word is one only when written as a call (`parse()`).
 */
export function parseCodeSymbol(content: string): CodeSymbol | null {
	let text = content.trim();
	if (text.length < 3 || content.length > MAX_SYMBOL_TOKEN_LENGTH || /[`\u0000-\u001f\u007f]/.test(content)) return null;
	let attribute = false;
	if (text.startsWith("[") && text.endsWith("]")) { attribute = true; text = text.slice(1, -1).trim(); }
	let call = false;
	const called = withoutCall(text);
	if (called !== null) { call = true; text = called.trim(); }
	const plain = withoutGenerics(text);
	if (plain === null) return null;
	text = plain.replace(/(?:\[\]|\?)+$/, "");
	// A call may follow the generic list of a method: `Run<T>(x)` was stripped above; `Run(x)<T>` is not code.
	if (!/^[A-Za-z_$][\w$.]*$/.test(text)) return null;
	const segments = text.split(".");
	if (segments.length > 4 || !segments.every(segment => IDENTIFIER.test(segment))) return null;
	const last = segments[segments.length - 1]!;
	if (last.length < 3 || Object.hasOwn(RECEIVERS, segments[0]!)) return null;
	if (segments.some(segment => Object.hasOwn(KEYWORDS, segment))) return null;
	if (segments.length === 1 && !call && /^[a-z][a-z\d]*$/.test(last)) return null;
	return { segments, name: segments.join("."), last, attribute, call };
}

/** Page to host: where are these symbols defined? The session folder is the host's, never the page's. */
export interface SymbolLinksRequest {
	type: "omp:terminal-link-symbols";
	requestId: number;
	tokens: string[];
}
/**
 * `ambiguous` (several different definitions inside the session's folders) links to VS Code's workspace symbol search, never to a guessed one.
 * `pending` is not a verdict: the provider is not ready or its queue is full; ask again after an `omp:terminal-link-symbols-retry`.
 */
export type SymbolLinkStatus = "found" | "none" | "unavailable" | "pending" | "ambiguous";
export interface SymbolLinkResult {
	/** The span content the page asked about, echoed exactly. */
	token: string;
	status: SymbolLinkStatus;
	/** A link target (`path:line:column`) the existing open request accepts; only with `found`. */
	target?: string;
	/** How many different definitions the name has inside the session's folders; only with `ambiguous`. */
	definitions?: number;
}
export interface SymbolLinksResolution {
	type: "omp:terminal-link-symbol-resolution";
	requestId: number;
	/** The `omp.linkCodeSymbols` setting is off: every result is `none` and the page should stop asking for a while. */
	disabled?: true;
	results: SymbolLinkResult[];
}

export function parseSymbolLinksRequest(value: Record<string, unknown>): SymbolLinksRequest | null {
	if (value.type !== "omp:terminal-link-symbols") return null;
	if (Object.keys(value).some(key => key !== "type" && key !== "requestId" && key !== "tokens")) return null;
	if (!Number.isSafeInteger(value.requestId) || Number(value.requestId) < 0) return null;
	const tokens = value.tokens;
	if (!Array.isArray(tokens) || tokens.length < 1 || tokens.length > MAX_SYMBOL_TOKENS_PER_REQUEST) return null;
	if (!tokens.every((token): token is string => typeof token === "string" && token.length > 0 && token.length <= MAX_SYMBOL_TOKEN_LENGTH && !/[\u0000-\u001f\u007f]/.test(token))) return null;
	return { type: value.type, requestId: Number(value.requestId), tokens: [...tokens] };
}

/** Host to page: parked tokens (answered `pending`) may be asked again, because the provider became ready or its queue drained. */
export interface SymbolLinksRetry {
	type: "omp:terminal-link-symbols-retry";
}

export function parseSymbolLinksRetry(value: Record<string, unknown>): SymbolLinksRetry | null {
	if (value.type !== "omp:terminal-link-symbols-retry" || Object.keys(value).length !== 1) return null;
	return { type: value.type };
}

export function parseSymbolLinksResolution(value: Record<string, unknown>): SymbolLinksResolution | null {
	if (value.type !== "omp:terminal-link-symbol-resolution") return null;
	if (Object.keys(value).some(key => key !== "type" && key !== "requestId" && key !== "results" && key !== "disabled")) return null;
	if (!Number.isSafeInteger(value.requestId) || Number(value.requestId) < 0) return null;
	if (value.disabled !== undefined && value.disabled !== true) return null;
	const list = value.results;
	if (!Array.isArray(list) || list.length > MAX_SYMBOL_TOKENS_PER_REQUEST) return null;
	const results: SymbolLinkResult[] = [];
	for (const entry of list as unknown[]) {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
		const item = entry as Record<string, unknown>;
		if (Object.keys(item).some(key => key !== "token" && key !== "status" && key !== "target" && key !== "definitions")) return null;
		if (typeof item.token !== "string" || item.token.length > MAX_SYMBOL_TOKEN_LENGTH) return null;
		if (item.status !== "found" && item.status !== "none" && item.status !== "unavailable" && item.status !== "pending" && item.status !== "ambiguous") return null;
		if (item.status === "found" ? !isTerminalLinkTarget(item.target) : item.target !== undefined) return null;
		if (item.status === "ambiguous" ? !Number.isSafeInteger(item.definitions) || Number(item.definitions) < 2 || Number(item.definitions) > 100_000 : item.definitions !== undefined) return null;
		results.push(item.status === "found" ? { token: item.token, status: "found", target: item.target as string } : item.status === "ambiguous" ? { token: item.token, status: "ambiguous", definitions: Number(item.definitions) } : { token: item.token, status: item.status });
	}
	return { type: value.type, requestId: Number(value.requestId), ...(value.disabled === true ? { disabled: true as const } : {}), results };
}
