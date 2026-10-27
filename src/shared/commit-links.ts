/**
 * Git commit hashes in a Chat reply. The page decides which text is worth asking about and the host proves it against
 * the repositories of THIS session's folder (`host/commit-links.ts`); both parse the same grammar, so the page is never
 * trusted to have normalized. A hash is a link only when a commit with that hash exists in the session's repository (HEAD or
 * not), and a click opens that commit's changes in a diff editor. The exchange is the Chat file-link validate/open pair, with a
 * target of the form `commit://<hex>`: it names no path and no repository, the host derives both from the session.
 *
 * See `docs/designs/2026-10-17-commit-hash-links.md`.
 */
import type { TerminalTextLink } from "./terminal-links.ts";

/** Git's shortest abbreviation by default is seven hex digits; a full SHA-1 is forty. */
export const MIN_COMMIT_HASH_LENGTH = 7;
export const MAX_COMMIT_HASH_LENGTH = 40;
/** One text never asks the host about more hashes than this. */
const MAX_COMMIT_HASHES_PER_TEXT = 32;

const SCHEME = "commit://";
const HASH = /^[0-9a-f]{7,40}$/i;
const TARGET = /^commit:\/\/([0-9a-f]{7,40})$/;
/**
 * A hash in prose: lowercase (git prints it so; an upper-case run is a constant), both a digit and a letter (a plain word of hex
 * letters such as `defaced` and a plain number are not hashes), and a whole word that does not continue a path, a URL, a file name, a version or a
 * longer identifier (`/commit/abc1234`, `abc1234.ts`, `abc1234-rc1`, `0xdeadbeef1`, `#c7398070`).
 */
const IN_PROSE = /(?<![\w.\-/\\:#@$%+~])(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}(?!-?\w|\.\w|:\w|[/\\@%+~])/g;

/** The canonical text of a commit link: what the page asks the host about and what a click sends back. `hash` is already lower-case hex of an allowed length. */
export function commitLinkTarget(hash: string): string {
	return `${SCHEME}${hash}`;
}

/** The lower-case hex a commit link target carries, or `null` when `target` is not one (any other scheme, upper case, an unusable length). */
export function parseCommitLinkTarget(target: string): string | null {
	return TARGET.exec(target)?.[1] ?? null;
}

/**
 * The canonical target of an inline code span that is one hash (surrounding whitespace ignored), or `null`. In code the
 * span is the whole evidence, so a hash that happens to be all digits or all letters qualifies; the host decides whether a commit exists.
 */
export function commitTargetOfSpan(content: string): string | null {
	const trimmed = content.trim();
	return HASH.test(trimmed) ? commitLinkTarget(trimmed.toLowerCase()) : null;
}

/** The commit hashes in a piece of prose, in order and without overlap; each covers exactly its own characters. */
export function detectCommitHashes(text: string): TerminalTextLink[] {
	if (text.length < MIN_COMMIT_HASH_LENGTH) return [];
	const links: TerminalTextLink[] = [];
	for (const match of text.matchAll(IN_PROSE)) {
		links.push({ target: commitLinkTarget(match[0]), start: match.index, end: match.index + match[0].length });
		if (links.length >= MAX_COMMIT_HASHES_PER_TEXT) break;
	}
	return links;
}
