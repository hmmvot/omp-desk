/**
 * OMP's own internal URLs as they appear in a Chat reply (`agent://UniformFieldsReview`, `artifact://69`,
 * `local://plan.md`, `history://Worker`). The page recognises them in text and in inline code and asks the host to
 * prove them against THIS session; the host parses the same text again before it resolves or opens anything, so this
 * grammar is the one boundary. It names no file system path: the host derives every path from the session it serves.
 *
 * Only the schemes the host can resolve from OMP's own session data layout are recognised (see
 * `docs/designs/2026-10-10-code-symbol-links.md`, "Internal OMP URLs"); every other scheme stays text.
 */
import type { TerminalTextLink } from "./terminal-links.ts";

/** What an internal URL names. `agent` and `history` name a subagent of the session; `artifact` a numbered tool-output file; `local` a file of the session's scratch space. */
export type InternalLink =
	| { readonly scheme: "agent" | "history"; readonly id: string }
	| { readonly scheme: "artifact"; readonly id: string }
	| { readonly scheme: "local"; readonly path: string };

/** OMP's task agent names are `[A-Za-z0-9_-]+`; a nested subagent is its parent's id and its own, joined by dots (`Parent.Child`). */
export const MAX_AGENT_ID_LENGTH = 256;
const AGENT_ID = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;
const ARTIFACT_ID = /^\d{1,9}$/;
const MAX_LOCAL_PATH_LENGTH = 512;
const MAX_LOCAL_SEGMENTS = 16;
/** A path segment of `local://` in a URL: letters, digits and `_ @ + ~ % - .` (percent-escapes carry anything else). */
const LOCAL_SEGMENT = /^[\p{L}\p{N}_@+~%.-]+$/u;
/** What a Windows file name may not hold or end with. */
const WINDOWS_FORBIDDEN = /[<>:"|?*\\/\u0000-\u001f\u007f]|[ .]$/u;

const SEGMENT = "[A-Za-z0-9_-]+";
const AGENT_TEXT = `${SEGMENT}(?:\\.${SEGMENT})*`;
/** A JSON-path suffix (`agent://Id/reports/0`): the link text covers it, the target never does. */
const JSON_PATH_TEXT = "(?:/[A-Za-z0-9_%-]+(?:\\.[A-Za-z0-9_%-]+)*)*";
const LOCAL_SEGMENT_TEXT = "[\\p{L}\\p{N}_@+~%-]+(?:\\.[\\p{L}\\p{N}_@+~%-]+)*";
/** A scheme that does not continue a word (`xagent://` is not one); a link ends where its grammar does, so sentence punctuation is prose again. */
const IN_TEXT = new RegExp(`(?<![A-Za-z0-9+.-])(?:(?:agent|history)://${AGENT_TEXT}${JSON_PATH_TEXT}|artifact://\\d{1,9}(?![\\p{L}\\p{N}])|local://${LOCAL_SEGMENT_TEXT}(?:/${LOCAL_SEGMENT_TEXT})*)`, "gu");
const JSON_PATH = new RegExp(`^${JSON_PATH_TEXT}$`);
const MAX_INTERNAL_LINKS_PER_TEXT = 64;
/** Whether `value` is one subagent id (a nested one is dot-qualified): the grammar the host also applies before it builds any path from an id. */
export function isAgentId(value: string): boolean {
	return value.length <= MAX_AGENT_ID_LENGTH && AGENT_ID.test(value);
}

function localPath(raw: string): string | null {
	const segments: string[] = [];
	for (const piece of raw.split("/")) {
		if (piece === "" || !LOCAL_SEGMENT.test(piece)) return null;
		let segment: string;
		try { segment = decodeURIComponent(piece); } catch { return null; }
		if (segment === "." || segment === ".." || segment.length > 128 || WINDOWS_FORBIDDEN.test(segment)) return null;
		segments.push(segment);
	}
	const path = segments.join("/");
	return segments.length === 0 || segments.length > MAX_LOCAL_SEGMENTS || path.length > MAX_LOCAL_PATH_LENGTH ? null : path;
}

/**
 * The internal link one whole text is (surrounding whitespace ignored), or `null`. An `agent://` or `history://` text
 * may carry a `/<json-path>` suffix, which opening ignores. Anything else around the URL, any other scheme and any
 * path that could leave a folder (`..`, `\`, a drive colon) is not a link.
 */
export function parseInternalLink(text: string): InternalLink | null {
	const trimmed = text.trim();
	if (trimmed.length < 9 || trimmed.length > 1024) return null;
	const scheme = /^(agent|history|artifact|local):\/\//.exec(trimmed)?.[1];
	if (scheme === undefined) return null;
	const rest = trimmed.slice(scheme.length + 3);
	if (scheme === "agent" || scheme === "history") {
		const id = rest.split("/", 1)[0]!;
		const suffix = rest.slice(id.length);
		if (!isAgentId(id)) return null;
		if (suffix !== "" && !JSON_PATH.test(suffix)) return null;
		return { scheme, id };
	}
	if (scheme === "artifact") return ARTIFACT_ID.test(rest) ? { scheme, id: rest } : null;
	const path = localPath(rest);
	return path === null ? null : { scheme: "local", path };
}

/** The canonical text of a link: what the page asks the host about and what a click sends back. A JSON-path suffix is gone; a local path is percent-encoded segment by segment. */
export function internalLinkTarget(link: InternalLink): string {
	return link.scheme === "local" ? `local://${link.path.split("/").map(encodeURIComponent).join("/")}` : `${link.scheme}://${link.id}`;
}

/** The canonical target of a whole text that is one internal link, or `null`. */
export function internalTargetOf(text: string): string | null {
	const link = parseInternalLink(text);
	return link === null ? null : internalLinkTarget(link);
}

/** The internal links in a piece of prose, in order and without overlap; each covers exactly its own characters and targets its canonical text. */
export function detectInternalLinks(text: string): TerminalTextLink[] {
	if (!text.includes("://")) return [];
	const links: TerminalTextLink[] = [];
	for (const match of text.matchAll(IN_TEXT)) {
		const target = internalTargetOf(match[0]);
		if (target !== null) links.push({ target, start: match.index, end: match.index + match[0].length });
		if (links.length >= MAX_INTERNAL_LINKS_PER_TEXT) break;
	}
	return links;
}
