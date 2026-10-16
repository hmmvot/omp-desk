/**
 * The wire form of an attached file and the escape of its text
 * (docs/designs/2026-10-16-chat-document-attachments.md, *Proposed Design* 4 and 4a, decisions 16 and 25).
 *
 * A message with files is the user's text followed by one block per file:
 *
 *     Summarise [File #1: plan.md]
 *
 *     <file path="docs/plan.md" n="1" chars="1204">
 *     …the file's text, line endings \n…
 *     </file>
 *
 * The page composes it at send and parses it back from stored history, so everything here is pure over strings. A block is
 * read back by **counting** its characters, never by looking for `</file>`, so a file that contains a closing tag, a whole
 * block or a header is read correctly, and text that does not parse exactly is plain prose.
 *
 * OMP acts on four sigils in the text of a prompt (`@path`, `^model`, `+N`, `/skill:name`). The text of a file is escaped with
 * U+200B before each of them, so none of them fires; `chars` counts the escaped text because that is what the stored message
 * holds, and parsing returns the original text.
 */
import { MAX_ATTACH_ITEMS } from "./attach-limits.ts";

/** U+200B: not whitespace for JavaScript's `\s`, so it ends the boundary all four sigils need. */
export const ZERO_WIDTH_SPACE = "\u200b";

/** Characters after which OMP's `@` mention may start (`isMentionBoundary`, `utils/file-mentions.ts`). */
const AT_BOUNDARY = /[\s([{<"'`]/;
const SPACE = /\s/;
/** The rest of each sigil's pattern, tested at the sigil (the boundary is tested before it). */
const CARET_TOKEN = /\^[^\s^]+(?=\s|$)/y;
const PLUS_TOKEN = /\+\d+(?:\.\d+)?[km]?!?(?=\s|$)/iy;
const SKILL_TOKEN = /\/skill:[^\s/]+(?:\/[^\s/]+)?(?=\s|$)/y;

interface Site {
	/** Where the run of U+200B before the sigil starts (the sigil's own index when there is none). */
	readonly runStart: number;
	/** The sigil's index. */
	readonly index: number;
}

function sticky(pattern: RegExp, text: string, index: number): boolean {
	pattern.lastIndex = index;
	return pattern.test(text);
}

/** Every position OMP would (or, shadowed by an existing U+200B, would nearly) act on, in order. */
function sigilSites(text: string): Site[] {
	const sites: Site[] = [];
	let runStart = -1;
	for (let index = 0; index < text.length; index++) {
		const character = text.charCodeAt(index);
		if (character === 0x200b) {
			if (runStart < 0) runStart = index;
			continue;
		}
		const start = runStart < 0 ? index : runStart;
		runStart = -1;
		// 64 `@`, 94 `^`, 43 `+`, 47 `/`.
		if (character !== 64 && character !== 94 && character !== 43 && character !== 47) continue;
		const before = start === 0 ? null : text[start - 1]!;
		if (character === 64) {
			if (before === null || AT_BOUNDARY.test(before)) sites.push({ runStart: start, index });
			continue;
		}
		if (before !== null && !SPACE.test(before)) continue;
		if (character === 94 ? sticky(CARET_TOKEN, text, index) : character === 43 ? sticky(PLUS_TOKEN, text, index) : sticky(SKILL_TOKEN, text, index)) sites.push({ runStart: start, index });
	}
	return sites;
}

/**
 * `text` with U+200B inserted before every sigil OMP acts on (and so before any U+200B that already stands in front of
 * such a sigil, which is what keeps {@link unescapeFileText} unambiguous). The start of the text counts as a boundary.
 */
export function escapeFileText(text: string): string {
	const sites = sigilSites(text);
	if (sites.length === 0) return text;
	let escaped = "";
	let from = 0;
	for (const site of sites) {
		escaped += text.slice(from, site.runStart) + ZERO_WIDTH_SPACE;
		from = site.runStart;
	}
	return escaped + text.slice(from);
}

/** The inverse of {@link escapeFileText}, decided from the stored text alone: one U+200B is removed at every site that has one. */
export function unescapeFileText(text: string): string {
	let restored = "";
	let from = 0;
	let changed = false;
	for (const site of sigilSites(text)) {
		if (site.runStart === site.index) continue;
		restored += text.slice(from, site.runStart);
		from = site.runStart + 1;
		changed = true;
	}
	return changed ? restored + text.slice(from) : text;
}

/** A file's name as its marker shows it: brackets and control characters replaced, at most 60 code points. */
export function markerName(name: string): string {
	const cleaned = name.replace(/[\u0000-\u001f\u007f]/g, " ").replaceAll("[", "(").replaceAll("]", ")");
	const points = Array.from(cleaned);
	return points.length > 60 ? points.slice(0, 60).join("") : cleaned;
}

/** The marker the draft shows for document `number`: `[File #2: notes.md]`. */
export function fileMarker(number: number, name: string): string {
	return `[File #${number}: ${markerName(name)}]`;
}

/** What `composeFileBlocks` takes for one document. */
export interface FileBlockSource {
	readonly number: number;
	readonly name: string;
	/** The path text of a file that has one, `null` for a file that has none. */
	readonly label: string | null;
	/** The file's own text. */
	readonly content: string;
}

/** A block read back from a message. `content` is the file's own text, unescaped. */
export interface FileBlock {
	readonly number: number;
	readonly name: string;
	readonly label: string | null;
	readonly content: string;
	/** True for the reduced form the host's prompt history stores: the text is not there. */
	readonly omitted: boolean;
}

/** A message read back: the text the user wrote, then its blocks in order (none when the message does not parse). */
export interface SplitMessage {
	readonly prose: string;
	readonly blocks: readonly FileBlock[];
}

/**
 * A header's value as a JSON string with the four sigils written as `\uXXXX` escapes, so a name such as `a @b.md` cannot make
 * OMP act on the header line. `JSON.parse` returns the original.
 */
export function headerValue(value: string): string {
	return JSON.stringify(value)
		.replace(/[@^+]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`)
		.replaceAll("/skill:", "\\u002fskill:");
}

/** The message text for `prose` and its documents: the prose, then one block per document after a blank line each. */
export function composeFileBlocks(prose: string, documents: readonly FileBlockSource[]): string {
	if (documents.length === 0) return prose;
	const blocks = documents.map(document => {
		const body = escapeFileText(document.content);
		return `<file ${document.label === null ? "name" : "path"}=${headerValue(document.label ?? document.name)} n="${document.number}" chars="${body.length}">\n${body}\n</file>`;
	});
	return `${prose}\n\n${blocks.join("\n\n")}`;
}

const JSON_STRING = String.raw`"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"`;
const HEADER = new RegExp(String.raw`<file (path|name)=(${JSON_STRING}) n="([1-9]\d*)" chars="(0|[1-9]\d*)"( omitted="true")?>\n`, "y");
const BLOCK_SEPARATOR = "\n\n<file ";
const FOOTER = "\n</file>";
const MARKER = /\[File #([1-9]\d*): ([^\]\n]+)\]/g;

interface RawBlock {
	readonly kind: "path" | "name";
	readonly value: string;
	readonly number: number;
	readonly omitted: boolean;
	readonly contentStart: number;
	readonly contentEnd: number;
	/** The index after the block's footer. */
	readonly after: number;
}

/** The block whose header starts at `at`, or null when it is not a complete block (header, exactly `chars` characters, footer). */
function readBlock(text: string, at: number): RawBlock | null {
	HEADER.lastIndex = at;
	const header = HEADER.exec(text);
	if (header === null) return null;
	const number = Number(header[3]);
	const chars = Number(header[4]);
	if (!Number.isSafeInteger(number) || !Number.isSafeInteger(chars)) return null;
	const omitted = header[5] !== undefined;
	if (omitted && chars !== 0) return null;
	const contentStart = at + header[0].length;
	const contentEnd = contentStart + chars;
	if (contentEnd > text.length || !text.startsWith(FOOTER, contentEnd)) return null;
	let value: unknown;
	try {
		value = JSON.parse(header[2]!);
	} catch {
		return null;
	}
	if (typeof value !== "string") return null;
	return { kind: header[1] as "path" | "name", value, number, omitted, contentStart, contentEnd, after: contentEnd + FOOTER.length };
}

/** The last segment of a path label, split on `/` and `\`. */
function baseName(label: string): string {
	return label.slice(Math.max(label.lastIndexOf("/"), label.lastIndexOf("\\")) + 1);
}

/**
 * Reads a message's file blocks back. A chain of blocks is accepted only when it ends exactly at the end of the text, its
 * numbers strictly ascend, there are at most `MAX_ATTACH_ITEMS` of them and the text before it holds each block's marker.
 * The first candidate that yields such a chain wins; anything else is returned as prose with no blocks.
 */
export function splitFileBlocks(text: string): SplitMessage {
	const none: SplitMessage = { prose: text, blocks: [] };
	if (!text.includes(BLOCK_SEPARATOR)) return none;

	// How many blocks lie from a header position to the end of the text: -1 when the walk does not reach it. The walk from a position is
	// one path, so each position is resolved once and the scan is linear; the semantic checks below are never memoised.
	const remaining = new Map<number, number>();
	const blocksFrom = (start: number): number => {
		const path: number[] = [];
		let position = start;
		let tail = -1;
		for (;;) {
			const known = remaining.get(position);
			if (known !== undefined) {
				tail = known;
				break;
			}
			path.push(position);
			const block = readBlock(text, position);
			if (block === null) {
				tail = -1;
				break;
			}
			if (block.after === text.length) {
				tail = 0;
				break;
			}
			if (!text.startsWith(BLOCK_SEPARATOR, block.after)) {
				tail = -1;
				break;
			}
			position = block.after + 2;
		}
		for (let index = path.length - 1; index >= 0; index--) {
			if (tail >= 0) tail += 1;
			remaining.set(path[index]!, tail);
		}
		return remaining.get(start)!;
	};

	// The first position of every marker, so a candidate's markers are looked up, not searched for.
	const markers = new Map<string, number>();
	for (const match of text.matchAll(MARKER)) {
		const key = `${match[1]}:${match[2]}`;
		if (!markers.has(key)) markers.set(key, match.index);
	}

	for (let candidate = text.indexOf(BLOCK_SEPARATOR); candidate >= 0; candidate = text.indexOf(BLOCK_SEPARATOR, candidate + 1)) {
		const count = blocksFrom(candidate + 2);
		if (count > MAX_ATTACH_ITEMS) return none;
		if (count < 1) continue;
		const blocks: FileBlock[] = [];
		let position = candidate + 2;
		let accepted = true;
		let previous = 0;
		for (let index = 0; index < count; index++) {
			const raw = readBlock(text, position)!;
			const name = raw.kind === "name" ? raw.value : baseName(raw.value);
			const seen = markers.get(`${raw.number}:${markerName(name)}`);
			if (raw.number <= previous || seen === undefined || seen >= candidate) {
				accepted = false;
				break;
			}
			previous = raw.number;
			blocks.push({ number: raw.number, name, label: raw.kind === "path" ? raw.value : null, content: unescapeFileText(text.slice(raw.contentStart, raw.contentEnd)), omitted: raw.omitted });
			position = raw.after + 2;
		}
		if (accepted) return { prose: text.slice(0, candidate), blocks };
	}
	return none;
}
