import { detectTerminalFileLinks } from "../terminal-links.ts";
import type { FileLinkAction, TerminalTextLink } from "../terminal-links.ts";
import type { GuestHostMessage, GuestWebviewMessage } from "../messages.ts";
import { ValidationCache } from "./link-validation-cache.ts";
import { TerminalLinkClient } from "./terminal-link-client.ts";

/**
 * File references in Chat text, found with the Terminal mode detector and proven by the same host
 * validation: a candidate becomes a link only when the host finds an existing file for it. Nothing
 * here changes the text it scans; a link wraps the characters the text already has.
 */

/** One text node never asks the host about more candidates than this. */
const MAX_LINKS_PER_TEXT = 64;

/** A path-looking token: a separator, a home or drive prefix, or a word with a letter-led extension. */
const PATH_LIKE = /[\\/]|^~|^[a-z]:|\.[a-z][a-z\d]{0,9}(?::|#|$)/i;
const HAS_LETTER = /\p{L}/u;
/** `@path`, `@"quoted path"` or `@'quoted path'` after whitespace or an opening bracket/quote, with the optional `[line 7]` / `[lines 12-30, 45]` note the Add-to-Session commands append. */
const MENTION = /(?<![^\s(\[{"'])@(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s<>"'`|()\[\]{}]+))(?: \[(?:line|lines) (\d+)(?:-\d+)?(?:, [^\]\r\n]*)?\])?/gu;
const HAS_POSITION = /(?::L?|#L)\d+(?:[:C]\d+)?(?:-L?\d+(?:[:C]\d+)?)?$/i;

/** Whether a target is worth asking the host about: it looks like a path and is not just numbers or a fraction. */
export function isFileLinkCandidate(target: string): boolean {
	return HAS_LETTER.test(target) && PATH_LIKE.test(target) && !/^[-+]/.test(target);
}

/**
 * The candidate file references in `text`, in order and without overlap. `@path [lines a-b]`
 * mentions are one link that reveals line `a`; every other candidate comes from the Terminal detector.
 */
export function detectChatFileLinks(text: string): TerminalTextLink[] {
	if (text.length < 2) return [];
	const links: TerminalTextLink[] = [];
	const taken: [number, number][] = [];
	if (text.includes("@")) {
		for (const match of text.matchAll(MENTION)) {
			const quoted = match[1] ?? match[2];
			let path = quoted ?? match[3] ?? "";
			let end = match.index + match[0].length;
			if (quoted === undefined && match[4] === undefined) {
				const trimmed = path.replace(/[.,;:!?]+$/, "");
				end -= path.length - trimmed.length;
				path = trimmed;
			}
			const target = match[4] !== undefined && !HAS_POSITION.test(path) ? `${path}:${match[4]}` : path;
			if (path.length === 0 || !isFileLinkCandidate(target)) continue;
			links.push({ target, start: match.index, end });
			taken.push([match.index, end]);
		}
	}
	for (const link of detectTerminalFileLinks(text)) {
		if (taken.some(([from, to]) => link.start < to && link.end > from)) continue;
		if (!isFileLinkCandidate(link.target)) continue;
		links.push(link);
	}
	links.sort((a, b) => a.start - b.start);
	return links.length > MAX_LINKS_PER_TEXT ? links.slice(0, MAX_LINKS_PER_TEXT) : links;
}

/** Markdown link destinations that name a file: a relative or drive path or a `file:` URL, never another scheme, anchor or network path. */
export function fileTargetOfHref(href: string): string | null {
	const trimmed = href.trim();
	if (trimmed === "" || /^(?:#|\?|\/\/)/.test(trimmed) || /[\u0000-\u001f\u007f]/.test(trimmed)) return null;
	if (/^[a-z][a-z\d+.-]*:/i.test(trimmed) && !/^[a-z]:[\\/]/i.test(trimmed) && !/^file:/i.test(trimmed)) return null;
	if (/^file:/i.test(trimmed)) return trimmed;
	// `[x](src/a%20b.ts#L3)`: the path part is URL-encoded, the position suffix is not.
	const suffixAt = trimmed.search(/[#?]/);
	const pathPart = suffixAt < 0 ? trimmed : trimmed.slice(0, suffixAt);
	const suffix = suffixAt < 0 ? "" : trimmed.slice(suffixAt);
	try { return decodeURIComponent(pathPart) + (suffix.startsWith("#") ? suffix : ""); }
	catch { return pathPart + (suffix.startsWith("#") ? suffix : ""); }
}

/** The most concurrent validations one document keeps in flight; the rest wait their turn. */
const MAX_IN_FLIGHT = 8;

/**
 * One Chat document's file links: host validation (cached, de-duplicated and bounded) and
 * activation. Both go through the Terminal mode request pair, so the host resolves against the
 * session cwd, re-checks the file on disk and opens it exactly as a Terminal link does.
 */
export class ChatFileLinks {
	readonly #client: TerminalLinkClient;
	readonly #cache: ValidationCache;
	#active = 0;
	readonly #waiting: (() => void)[] = [];
	constructor(transport: { post(message: GuestWebviewMessage): boolean; subscribe(listener: (message: GuestHostMessage) => void): () => void }, now: () => number = Date.now) {
		this.#client = new TerminalLinkClient(transport);
		this.#cache = new ValidationCache(target => this.#validate(target), now);
	}
	async #validate(target: string): Promise<boolean> {
		while (this.#active >= MAX_IN_FLIGHT) await new Promise<void>(resolve => this.#waiting.push(resolve));
		this.#active++;
		try { return await this.#client.validate(target, true); }
		finally { this.#active--; this.#waiting.shift()?.(); }
	}
	/** The fresh answer for `target`, or `undefined` while the host has not been asked or the answer expired. */
	peek(target: string): boolean | undefined { return this.#cache.peek(target); }
	resolve(target: string): Promise<boolean> { return this.#cache.resolve(target); }
	open(target: string, action?: FileLinkAction): void { this.#client.openPath(target, action); }
	dispose(): void { this.#client.dispose(); }
}
