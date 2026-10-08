import { webLinkUrl } from "../terminal-links.ts";
import type { TerminalTextLink } from "../terminal-links.ts";

/**
 * Bare `http(s)` URLs in Chat prose. A web link needs no host proof (the host re-validates the URL
 * when it is opened), so detection alone decides what is linked; like a file link, it wraps the
 * characters the text already has and never changes them.
 */

/** The tooltip line that states what each gesture on a web link does, in the Chat and the Terminal alike. */
export const WEB_LINK_HINT = "Open in editor · Ctrl+Click to open in browser";

/** A scheme that does not continue a word (`xhttps://` is not a URL) and everything up to whitespace, a quote, a backtick or an angle bracket. */
const BARE_URL = /(?<![a-z\d+.-])https?:\/\/[^\s<>"`]+/gi;
/** Punctuation that ends a sentence or closes emphasis rather than the URL, as in GitHub's autolinks. */
const TRAILING = /[.,;:!?'*_~]/;
const CLOSERS: Readonly<Record<string, string>> = { ")": "(", "]": "[", "}": "{" };

/** The length of `raw` without trailing punctuation and without closing brackets the URL never opened (`(see https://a.test/x)`). */
function urlEnd(raw: string): number {
	let end = raw.length;
	while (end > 0) {
		const last = raw[end - 1]!;
		const opener = CLOSERS[last];
		if (opener !== undefined) {
			const body = raw.slice(0, end);
			if (body.split(last).length <= body.split(opener).length) break;
		} else if (!TRAILING.test(last)) {
			break;
		}
		end--;
	}
	return end;
}

/** The web links in `text`, in order: each covers exactly its own characters and targets the normalized URL. */
export function detectWebLinks(text: string): TerminalTextLink[] {
	if (!/https?:\/\//i.test(text)) return [];
	const links: TerminalTextLink[] = [];
	for (const match of text.matchAll(BARE_URL)) {
		const end = match.index + urlEnd(match[0]);
		const target = webLinkUrl(text.slice(match.index, end));
		if (target !== null) links.push({ target, start: match.index, end });
	}
	return links;
}
