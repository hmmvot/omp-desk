/**
 * Markdown renderer for transcript text.
 *
 * Renders to React nodes instead of HTML strings: there is no
 * `dangerouslySetInnerHTML` path, so raw HTML in model output is displayed as
 * text and can never become markup. Supported syntax is the subset the chat
 * transcript needs — fenced code, headings, lists, blockquotes, horizontal
 * rules, pipe tables, plus inline code/bold/italic/strikethrough/links. Text the user typed is parsed with `emphasis` off: `**x**`, `__x__`,
 * `*x*`, `_x_` and `~~x~~` stay literal characters there (`obj._m() … obj._n()`, `1*234*343` must not turn italic), while code spans and fences,
 * quotes, lists, tables, headings, links and `[Image #N]` references keep working. Web links
 * (`[label](https://…)`, `<https://…>` and bare URLs in prose) accept only
 * `http:`/`https:`; any other destination keeps its label as text. A fenced `mermaid`
 * block is {@link MermaidBlock}: the diagram once the block is closed and drawn, the code before.
 *
 * This is a small project-owned renderer: a general-purpose Markdown library would
 * add a package to the bundle for behavior this panel does not need.
 */
import type { ReactNode } from "react";
import { Fragment, memo, useLayoutEffect, useMemo, useRef } from "react";
import { INLINE_TOKEN, MAX_EMPHASIS_DEPTH, USER_INLINE_TOKEN, inlinePieces } from "../lib/markdown-inline.ts";
import { LeafCollector, registerMarkdown, unregisterMarkdown, type Leaf, type LeafLine, type LeafTable, type LineOrigin } from "../lib/markdown-leaves.ts";
import { splitTableCells } from "../lib/markdown-table.ts";
import { detectChatFileLinks, fileTargetOfHref, isFileLinkCandidate } from "../lib/chat-file-links";
import { detectWebLinks } from "../lib/chat-web-links";
import { parseBareFileName, parseCodeSymbol } from "../../shared/code-symbols";
import { detectInternalLinks, internalTargetOf } from "../../shared/internal-links";
import { isHunkLocation, isRevisionLocation } from "../../shared/quote-location";
import { commitTargetOfSpan, detectCommitHashes } from "../../shared/commit-links";
import { webLinkUrl } from "../../shared/terminal-links";
import type { TerminalTextLink } from "../../shared/terminal-links";
import { CodeSymbolSpan, FileLink, FileLinkText, InternalLink } from "./FileLinks.tsx";
import { CommitHashSpan, CommitLink } from "./CommitLinks.tsx";
import { breakable } from "./BreakPoints.tsx";
import { ImageReferenceToken } from "./ImageReference.tsx";
import { WebLink } from "./WebLinks.tsx";
import { CodeBlock } from "./CodeBlock.tsx";
import { MermaidBlock } from "./MermaidBlock.tsx";

const HEADING = /^(#{1,6})\s+(.*)$/;
/** An opening fence: a run of three or more backticks and an info string without backticks (the composer's rule, `code-fence.ts`); the language is the first token of the info string. Leading whitespace of any width is tolerated: list item bodies keep their extra columns. */
const FENCE = /^\s*(`{3,})([^`]*)$/;
/** A closing fence: a run of backticks at least as long as the opening one (checked by the caller), nothing else. */
const FENCE_CLOSE = /^\s*(`{3,})\s*$/;

/** Whether `line` closes a fence opened with `openLength` backticks: a closing run is at least as long. */
function closesFence(line: string, openLength: number): boolean {
	const close = FENCE_CLOSE.exec(line);
	return close !== null && (close[1] as string).length >= openLength;
}

/** A list item line: indent, marker, spacing after the marker, content. */
const LIST_ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+)(.*)$/;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const QUOTE = /^\s*>\s?(.*)$/;
/** How many blockquotes may nest; a `>` inside the deepest one is literal text. */
const MAX_QUOTE_DEPTH = 8;

/** Where a block is parsed: inside a quote (a `mermaid` fence is then plain code, not a drawn diagram), how many quotes deep, whether inline emphasis is parsed (not in text the user typed), and the collector of the leaf records when the message is quotable. */
interface BlockContext { readonly quoted: boolean; readonly depth: number; readonly emphasis: boolean; readonly leaves: LeafCollector | null }
const TOP_LEVEL: BlockContext = { quoted: false, depth: 0, emphasis: true, leaves: null };

/** Where line `index` of a nested parse came from; `null` origins are the source's own lines. */
function originAt(origins: readonly LineOrigin[] | null, index: number): LineOrigin {
	return origins === null ? { line: index, start: 0, quote: 0 } : (origins[index] as LineOrigin);
}

/** The origin of `content`, what is left of `line` once the parse took its prefix (and `quotes` levels of quote) off. */
function stripped(origin: LineOrigin, line: string, content: string, quotes = 0): LineOrigin {
	return { line: origin.line, start: origin.start + Math.max(0, line.length - content.length), quote: origin.quote + quotes };
}

/** Whether `line` opens or continues a quote at this depth. */
function quoteLine(line: string, context: BlockContext): boolean {
	return context.depth < MAX_QUOTE_DEPTH && QUOTE.test(line);
}
const TABLE_SEPARATOR = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/;

/** Text whose file references the host has proven can become links; text without a candidate stays a bare string. `breaks` offers line-break points after path separators (inline code only). */
function files(text: string, key: string, breaks = false): ReactNode {
	return detectChatFileLinks(text).length === 0 ? (breaks ? breakable(text) : text) : <FileLinkText key={key} text={text} breaks={breaks} />;
}

/** The bare web URLs, the internal OMP URLs (`agent://Name`) and the commit hashes of `text`, in order and without overlap; a URL inside a web link is only that link. */
function textLinks(text: string): { link: TerminalTextLink; kind: "web" | "internal" | "commit" }[] {
	const links: { link: TerminalTextLink; kind: "web" | "internal" | "commit" }[] = detectWebLinks(text).map(link => ({ link, kind: "web" as const }));
	const addApart = (found: readonly TerminalTextLink[], kind: "internal" | "commit"): void => {
		const taken = links.slice();
		for (const link of found) if (!taken.some(other => link.start < other.link.end && other.link.start < link.end)) links.push({ link, kind });
	};
	addApart(detectInternalLinks(text), "internal");
	addApart(detectCommitHashes(text), "commit");
	return links.sort((a, b) => a.link.start - b.link.start);
}

/** Plain text with its bare web URLs, internal OMP URLs and commit hashes linked and its file references offered to the host; the characters are never altered. */
function plain(text: string, key: string): ReactNode {
	const links = textLinks(text);
	if (links.length === 0) return files(text, key);
	const nodes: ReactNode[] = [];
	let cursor = 0;
	links.forEach(({ link, kind }, index) => {
		if (link.start > cursor) nodes.push(files(text.slice(cursor, link.start), `${key}-f${index}`));
		const label = breakable(text.slice(link.start, link.end));
		nodes.push(kind === "internal" ? <InternalLink key={`${key}-i${index}`} target={link.target}>{label}</InternalLink>
			: kind === "commit" ? <CommitLink key={`${key}-c${index}`} target={link.target}>{label}</CommitLink>
			: <WebLink key={`${key}-w${index}`} url={link.target}>{label}</WebLink>);
		cursor = link.end;
	});
	if (cursor < text.length) nodes.push(files(text.slice(cursor), `${key}-f${links.length}`));
	return <Fragment key={key}>{nodes}</Fragment>;
}

/**
 * A whole code span that is one path (spaces allowed only after a drive, home or relative prefix) links as a unit; an `@` mention and any other span link the file references they hold. A URL in code stays code.
 * A span that names a code symbol (`Session`, `A.B`, `Run()`, `[Attr]`) or is a bare file name or the trailing part of a path (`session-index.ts:849`, `session-index.ts(849)`, `host/session-index.ts:579`) is one {@link CodeSymbolSpan}: its path proof first when it also looks like a path, then the host's workspace symbol and file lookup, in assistant text only.
 * A whole span that is one internal OMP URL of the session (`agent://Name`, `artifact://69`, `local://plan.md`) is one {@link InternalLink}: plain code until the host proves the session has what it names.
 * A whole span that is one commit hash (7 to 40 hex digits) is one {@link CommitHashSpan}: a link to the commit once the host proves it exists, otherwise what it would be without this rule.
 * A whole span that is the location of a Git revision (`src/app.ts:42-50 @ HEAD (3f2a9c1)`, from an editor quote of a diff) or of a hunk of a diff (`src/app.ts:3-5 was src/app.ts:3-4 @ HEAD (3f2a9c1)`) is plain code: its path and lines are those of that version, or two paths at once, so a link to the file on disk would open other lines.
 */
function codeSpan(content: string, key: string): ReactNode {
	if (isRevisionLocation(content) || isHunkLocation(content)) return <code key={key}>{breakable(content)}</code>;
	const internal = internalTargetOf(content);
	if (internal !== null) return <code key={key}><InternalLink target={internal}>{breakable(content)}</InternalLink></code>;
	const whole = content.trim();
	const single = !whole.startsWith("@") && (!/\s/.test(whole) || /^(?:[a-z]:[\\/]|~[\\/]|\.{1,2}[\\/]|\/)/i.test(whole) && !/\s-/.test(whole));
	const path = single && isFileLinkCandidate(whole) ? whole : null;
	const symbol = parseCodeSymbol(content) !== null;
	// A bare file name or path suffix (`session-index.ts:849`, `host/session-index.ts:579`) is looked up by the host in assistant text; where it links nothing the span renders as before.
	const node = symbol || parseBareFileName(content) !== null
		? <CodeSymbolSpan key={key} content={content} path={path} plain={symbol || path !== null ? undefined : files(content, `${key}f`, true)} />
		: <code key={key}>{path !== null ? <FileLink target={path}>{breakable(content)}</FileLink> : files(content, `${key}f`, true)}</code>;
	// A span that is one commit hash is asked about as a commit first; `node` is what it is where the host knows no such commit.
	const commit = commitTargetOfSpan(content);
	return commit === null ? node : <CommitHashSpan key={key} target={commit} content={content} plain={node} />;
}

/** A link label keeps its inline code spans as code; nothing inside a label is linked again. */
function linkLabel(label: string, key: string): ReactNode {
	if (!label.includes("`")) return breakable(label);
	const nodes: ReactNode[] = [];
	const spans = /`([^`]+)`/g;
	let cursor = 0;
	for (const span of label.matchAll(spans)) {
		if (span.index > cursor) nodes.push(<Fragment key={`${key}t${span.index}`}>{breakable(label.slice(cursor, span.index))}</Fragment>);
		nodes.push(<code key={`${key}c${span.index}`}>{breakable(span[1]!)}</code>);
		cursor = span.index + span[0].length;
	}
	if (cursor < label.length) nodes.push(<Fragment key={`${key}t${cursor}`}>{breakable(label.slice(cursor))}</Fragment>);
	return <Fragment key={key}>{nodes}</Fragment>;
}

/** The content of an emphasis token: links, code spans and file paths like top-level text, nesting bounded. */
function emphasized(inner: string, key: string, depth: number): ReactNode {
	return depth < MAX_EMPHASIS_DEPTH ? <Fragment key={key}>{renderInline(inner, key, true, depth + 1)}</Fragment> : plain(inner, key);
}

/** One line of inline Markdown. `emphasis` false is text the user typed: `*`, `_` and `~~` are never markup there (links, code spans and `[Image #N]` still are). */
function renderInline(text: string, keyPrefix: string, emphasis = true, depth = 0): ReactNode[] {
	const nodes: ReactNode[] = [];
	let cursor = 0;
	let tokenIndex = 0;
	const grammar = emphasis ? INLINE_TOKEN : USER_INLINE_TOKEN;
	grammar.lastIndex = 0;
	let match = grammar.exec(text);
	while (match !== null) {
		if (match.index > cursor) nodes.push(plain(text.slice(cursor, match.index), `${keyPrefix}-p${tokenIndex}`));
		const token = match[0];
		const key = `${keyPrefix}-t${tokenIndex++}`;
		cursor = match.index + token.length;
		if (token.startsWith("`")) {
			nodes.push(codeSpan(token.slice(1, -1), key));
		} else if (token.startsWith("**") || token.startsWith("__")) {
			nodes.push(<strong key={key}>{emphasized(token.slice(2, -2), `${key}f`, depth)}</strong>);
		} else if (token.startsWith("~~")) {
			nodes.push(<s key={key}>{emphasized(token.slice(2, -2), `${key}f`, depth)}</s>);
		} else if (token.startsWith("[Image #") && !token.includes("](")) {
			// Resolved against the surrounding user message's images; plain text anywhere else.
			nodes.push(<ImageReferenceToken key={key} number={Number(/^\[Image #(\d+)/.exec(token)![1])} label={token} />);
		} else if (token.startsWith("[")) {
			const split = token.indexOf("](");
			const label = token.slice(1, split);
			const destination = token.slice(split + 2, -1);
			// A path or `file:` URL is a file reference: a link only once the host proves the file exists, the bare label before.
			const file = fileTargetOfHref(destination);
			const url = file === null ? webLinkUrl(destination) : null;
			// An internal OMP URL of the session (`[the review](agent://Name)`) is a link only once the host proves the session has what it names.
			const internal = file === null && url === null ? internalTargetOf(destination) : null;
			// A rejected scheme keeps its label but never its URL: the transcript
			// must not carry a `javascript:`/`data:`/`command:` destination at all.
			const text = linkLabel(label, `${key}l`);
			nodes.push(file !== null ? <FileLink key={key} target={file}>{text}</FileLink> : internal !== null ? <InternalLink key={key} target={internal}>{text}</InternalLink> : url === null ? <Fragment key={key}>{text}</Fragment> : <WebLink key={key} url={url}>{text}</WebLink>);
		} else if (token.startsWith("<")) {
			const url = webLinkUrl(token.slice(1, -1));
			nodes.push(url === null ? plain(token, key) : <WebLink key={key} url={url}>{breakable(token.slice(1, -1))}</WebLink>);
		} else if (/^https?:/i.test(token)) {
			// A bare URL: its trailing punctuation is prose again.
			nodes.push(plain(token, key));
		} else {
			nodes.push(<em key={key}>{emphasized(token.slice(1, -1), `${key}f`, depth)}</em>);
		}
		// A nested call moved the shared regex; continue right after this token.
		grammar.lastIndex = cursor;
		match = grammar.exec(text);
	}
	if (cursor < text.length) nodes.push(plain(text.slice(cursor), `${keyPrefix}-p${tokenIndex}`));
	return nodes;
}

/** Render soft-wrapped lines as inline content separated by `<br/>` (markdown `breaks` mode). */
function renderLines(lines: readonly string[], keyPrefix: string, emphasis: boolean): ReactNode[] {
	const nodes: ReactNode[] = [];
	lines.forEach((line, lineIndex) => {
		if (lineIndex > 0) nodes.push(<br key={`${keyPrefix}-br${lineIndex}`} />);
		nodes.push(...renderInline(line, `${keyPrefix}-l${lineIndex}`, emphasis));
	});
	return nodes;
}

/** Split a table row on unescaped pipes, dropping the optional edge pipes. */
function splitTableRow(line: string): string[] {
	return splitTableCells(line).map(cell => cell.text);
}

/** Column width of leading whitespace, with tabs as four columns. */
function indentWidth(text: string): number {
	let width = 0;
	for (const ch of text) {
		if (ch === "\t") width += 4 - (width % 4);
		else if (ch === " ") width++;
		else break;
	}
	return width;
}

/** Remove up to `columns` columns of leading whitespace. */
function dedent(line: string, columns: number): string {
	let width = 0;
	let cut = 0;
	while (cut < line.length && width < columns) {
		const ch = line[cut];
		if (ch === " ") width++;
		else if (ch === "\t") width += 4 - (width % 4);
		else break;
		cut++;
	}
	return line.slice(cut);
}

interface ListItemMatch { readonly indent: number; readonly ordered: boolean; readonly number: number; readonly contentOffset: number; readonly content: string }

function listItem(line: string): ListItemMatch | null {
	if (RULE.test(line)) return null;
	const match = LIST_ITEM.exec(line);
	if (match === null) return null;
	const indent = indentWidth(match[1] as string);
	const marker = match[2] as string;
	const spacing = (match[3] as string).replace(/\t/g, "    ").length;
	// More than four spaces after the marker starts indented content; the item text begins after one.
	const contentOffset = indent + marker.length + (spacing > 4 ? 1 : spacing);
	const ordered = /\d/.test(marker);
	return { indent, ordered, number: ordered ? Number.parseInt(marker, 10) : 1, contentOffset, content: (spacing > 4 ? " ".repeat(spacing - 1) : "") + (match[4] as string) };
}

/**
 * Parse one list starting at `start`. Each item owns the following lines that are
 * indented to its content (or deeper than the list's own markers, so the common
 * two-space nesting under `1.` still nests), lazy paragraph continuations and the
 * blank lines between them; the owned text is rendered as nested blocks, so
 * nested lists, code fences and paragraphs inside items keep their structure.
 */
function parseList(lines: readonly string[], origins: readonly LineOrigin[] | null, start: number, listKey: string, context: BlockContext): { node: ReactNode; next: number } {
	const first = listItem(lines[start] as string) as ListItemMatch;
	const tracking = context.leaves !== null;
	const items: { lines: string[]; origins: LineOrigin[] }[] = [];
	let loose = false;
	let index = start;
	while (index < lines.length) {
		const head = listItem(lines[index] as string);
		if (head === null || head.indent < first.indent || head.ordered !== first.ordered) break;
		const body = { lines: [head.content], origins: tracking ? [stripped(originAt(origins, index), lines[index] as string, head.content)] : [] };
		index++;
		let previousBlank = false;
		while (index < lines.length) {
			const line = lines[index] as string;
			if (line.trim() === "") {
				let ahead = index + 1;
				while (ahead < lines.length && (lines[ahead] as string).trim() === "") ahead++;
				if (ahead >= lines.length) { index = ahead; break; }
				const following = lines[ahead] as string;
				const nested = listItem(following);
				if (indentWidth(following) >= head.contentOffset || (nested !== null && nested.indent > first.indent)) {
					for (let blank = index; blank < ahead; blank++) {
						body.lines.push("");
						if (tracking) body.origins.push(stripped(originAt(origins, blank), lines[blank] as string, ""));
					}
					loose = true;
					previousBlank = true;
					index = ahead;
					continue;
				}
				if (nested !== null && nested.indent >= first.indent && nested.ordered === first.ordered) loose = true;
				index = ahead;
				break;
			}
			const nested = listItem(line);
			const indent = indentWidth(line);
			if (indent >= head.contentOffset || (nested !== null && nested.indent > first.indent)) {
				const content = dedent(line, Math.min(indent, head.contentOffset));
				body.lines.push(content);
				if (tracking) body.origins.push(stripped(originAt(origins, index), line, content));
			} else if (nested === null && !previousBlank && !FENCE.test(line) && !HEADING.test(line) && !RULE.test(line) && !quoteLine(line, context)) {
				const content = line.trim();
				body.lines.push(content);
				if (tracking) body.origins.push(stripped(originAt(origins, index), line, line.trimStart()));
			} else {
				break;
			}
			previousBlank = false;
			index++;
		}
		items.push(body);
		if (index < lines.length && (lines[index] as string).trim() === "") break;
		const sibling = index < lines.length ? listItem(lines[index] as string) : null;
		if (sibling === null || sibling.indent < first.indent || sibling.ordered !== first.ordered) break;
	}
	const rendered = items.map((body, itemIndex) => (
		<li key={`li${itemIndex}`}>{parseBlockRange(body.lines, tracking ? body.origins : null, 0, 0, !loose, `${listKey}-${itemIndex}`, context).blocks}</li>
	));
	return {
		node: first.ordered
			? <ol key={listKey} start={first.number === 1 ? undefined : first.number}>{rendered}</ol>
			: <ul key={listKey}>{rendered}</ul>,
		next: index,
	};
}

/**
 * One parse of a whole text, with what a later parse of a longer text can reuse: the
 * number of lines, and the line each block started on. The block keys are the block's index.
 * A quotable parse also holds its leaf records (`leaves`, numbered from 0) and the number of leaves before each block
 * (`leafStarts`), so a reused block keeps its leaf numbers.
 */
export interface MarkdownParse {
	readonly text: string;
	readonly lineCount: number;
	readonly blocks: readonly ReactNode[];
	readonly starts: readonly number[];
	readonly quotable: boolean;
	/** Whether inline emphasis was parsed; `false` for text the user typed. A parse is reused only by one of the same mode. */
	readonly emphasis: boolean;
	readonly leaves: readonly Leaf[];
	readonly leafStarts: readonly number[];
}

/**
 * Parse `text`, reusing the blocks of `previous` when `text` only appends to its text (a
 * reply streaming in). A block's parse depends on its own lines and on the first non-blank
 * line after it (a list reads past blank lines, a paragraph stops at the line that opens
 * the next block), so every block that ends before the previous text's last line — the one
 * line an append can change — is kept as the same element, and only the tail is parsed again.
 */
export function parseMarkdown(text: string, previous: MarkdownParse | null, quotable = false, emphasis = true): MarkdownParse {
	const lines = text.split(/\r?\n/);
	if (previous !== null && previous.quotable === quotable && previous.emphasis === emphasis && previous.starts.length >= 2 && text.length > previous.text.length && text.startsWith(previous.text)) {
		const modified = previous.lineCount - 1;
		const last = previous.starts.length - 1;
		// A block that starts on the modified line may now be joined by the block before it
		// (a second list item after a blank, a table separator under a paragraph): that one is
		// parsed again too.
		const from = (previous.starts[last] as number) < modified ? last : last - 1;
		if (from >= 1) {
			const kept = previous.leafStarts[from] as number;
			const collector = quotable ? new LeafCollector(kept, emphasis) : null;
			const tail = parseBlockRange(lines, null, previous.starts[from] as number, from, false, "b", { ...TOP_LEVEL, emphasis, leaves: collector });
			return {
				text,
				lineCount: lines.length,
				blocks: [...previous.blocks.slice(0, from), ...tail.blocks],
				starts: [...previous.starts.slice(0, from), ...tail.starts],
				quotable,
				emphasis,
				leaves: collector === null ? [] : [...previous.leaves.slice(0, kept), ...collector.leaves],
				leafStarts: [...previous.leafStarts.slice(0, from), ...tail.leafStarts],
			};
		}
	}
	const collector = quotable ? new LeafCollector(0, emphasis) : null;
	const parsed = parseBlockRange(lines, null, 0, 0, false, "b", { ...TOP_LEVEL, emphasis, leaves: collector });
	return { text, lineCount: lines.length, blocks: parsed.blocks, starts: parsed.starts, quotable, emphasis, leaves: collector === null ? [] : collector.leaves, leafStarts: parsed.leafStarts };
}

/**
 * The text `text` shows once rendered, leaf by leaf (a paragraph or item line per line, a code line as written, a table row cell by cell,
 * no rule), joined by newlines: what Find in the transcript searches in place of the DOM it cannot see, so that a word written
 * between `**` or inside a link is found as it reads and a fence or a `|` never is.
 */
export function markdownShownText(text: string, emphasis = true): string {
	const shown: string[] = [];
	for (const leaf of parseMarkdown(text, null, true, emphasis).leaves) {
		if (leaf.kind === "rule") continue;
		if (leaf.kind === "code") shown.push(...leaf.lines.map(line => line.text));
		else if (leaf.kind === "row") for (const line of leaf.lines) shown.push(...splitTableCells(line.text).map(cell => inlinePieces(cell.text, leaf.emphasis).map(piece => piece.visible).join("")));
		else for (const line of leaf.lines) shown.push(inlinePieces(line.text, leaf.emphasis).map(piece => piece.visible).join(""));
	}
	return shown.join("\n");
}

/** The leaf's line `index` of `lines`: its origin, with the text the leaf draws from it and the characters of it the parse dropped. */
function leafLine(origins: readonly LineOrigin[] | null, lines: readonly string[], index: number, text = lines[index] as string): LeafLine {
	const origin = stripped(originAt(origins, index), lines[index] as string, text);
	return { ...origin, text };
}

/**
 * Parse the blocks from line `from` on; `firstKey` numbers the first of them. Every block takes exactly one key.
 * `origins` says where each line came from when it is not a line of the text itself (`null`: the lines are the source's own); the
 * leaf collector of `context`, when there is one, records every leaf block and its element carries the leaf's number.
 */
function parseBlockRange(lines: readonly string[], origins: readonly LineOrigin[] | null, from: number, firstKey: number, tight: boolean, keyPrefix: string, context: BlockContext): { blocks: ReactNode[]; starts: number[]; leafStarts: number[] } {
	const blocks: ReactNode[] = [];
	const starts: number[] = [];
	const leafStarts: number[] = [];
	const collector = context.leaves;
	let index = from;
	let key = firstKey;
	// Progress invariant: every iteration consumes at least one line. An iteration that did not is undone and its line becomes paragraph text, so the parse is total even if a rule is wrong in some way not yet found.
	let stalled = -1;
	const begin = (at: number): void => {
		starts.push(at);
		leafStarts.push(collector === null ? 0 : collector.count);
	};
	const paragraphOf = (paragraphLines: readonly string[], firstLine: number, paragraphKey: string): ReactNode => {
		const leaf = collector?.add({
			kind: "text",
			lines: paragraphLines.map((_, offset) => leafLine(origins, lines, firstLine + offset)),
			first: originAt(origins, firstLine).line,
			last: originAt(origins, firstLine + paragraphLines.length - 1).line,
		});
		return tight
			? <span key={paragraphKey} data-md-leaf={leaf}>{renderLines(paragraphLines, paragraphKey, context.emphasis)}</span>
			: <p key={paragraphKey} data-md-leaf={leaf}>{renderLines(paragraphLines, paragraphKey, context.emphasis)}</p>;
	};

	while (index < lines.length) {
		if (index === stalled) {
			const keep = starts.indexOf(index);
			if (keep >= 0) {
				blocks.length = keep;
				collector?.truncate(leafStarts[keep] as number);
				starts.length = keep;
				leafStarts.length = keep;
				key = firstKey + keep;
			}
			const paragraphKey = `${keyPrefix}${key++}`;
			begin(index);
			blocks.push(paragraphOf([lines[index] as string], index, paragraphKey));
			index++;
			continue;
		}
		stalled = index;
		const line = lines[index] as string;
		if (line.trim() === "") {
			index++;
			continue;
		}
		begin(index);

		const fence = FENCE.exec(line);
		if (fence !== null) {
			const fenceLength = (fence[1] as string).length;
			const language = (fence[2] as string).trim().split(/\s+/)[0] ?? "";
			const open = index;
			const body: string[] = [];
			index++;
			while (index < lines.length && !closesFence(lines[index] as string, fenceLength)) {
				body.push(lines[index] as string);
				index++;
			}
			const closed = index < lines.length;
			const closing = index;
			index++; // closing fence (or EOF)
			const text = body.join("\n");
			const leaf = collector?.add({
				kind: "code",
				lines: body.map((_, offset) => leafLine(origins, lines, open + 1 + offset)),
				first: originAt(origins, open).line,
				last: originAt(origins, closed ? closing : Math.max(open, closing - 1)).line,
				open: leafLine(origins, lines, open),
				language,
				closed,
			});
			blocks.push(
				language.toLowerCase() === "mermaid" && !context.quoted ? (
					<MermaidBlock key={`b${key++}`} source={text} closed={closed} leaf={leaf} />
				) : (
					<CodeBlock key={`b${key++}`} language={language} source={text} closed={closed} leaf={leaf} />
				),
			);
			continue;
		}

		const heading = HEADING.exec(line);
		if (heading !== null) {
			const level = Math.min(6, (heading[1] as string).length);
			const Tag = `h${level}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
			const leaf = collector?.add({ kind: "text", lines: [leafLine(origins, lines, index, heading[2] as string)], first: originAt(origins, index).line, last: originAt(origins, index).line });
			blocks.push(<Tag key={`b${key++}`} data-md-leaf={leaf}>{renderInline(heading[2] as string, `h${key}`, context.emphasis)}</Tag>);
			index++;
			continue;
		}

		if (RULE.test(line)) {
			const leaf = collector?.add({ kind: "rule", lines: [leafLine(origins, lines, index)], first: originAt(origins, index).line, last: originAt(origins, index).line });
			blocks.push(<hr key={`b${key++}`} data-md-leaf={leaf} />);
			index++;
			continue;
		}

		if (quoteLine(line, context)) {
			// A quote ends at the first line without `>`: a comment written right under it is its own paragraph (no lazy continuation).
			const quoted: string[] = [];
			const quotedOrigins: LineOrigin[] = [];
			while (index < lines.length && quoteLine(lines[index] as string, context)) {
				const content = (QUOTE.exec(lines[index] as string) as RegExpExecArray)[1] as string;
				quoted.push(content);
				if (collector !== null) quotedOrigins.push(stripped(originAt(origins, index), lines[index] as string, content, 1));
				index++;
			}
			const quoteKey = key++;
			blocks.push(
				<blockquote key={`b${quoteKey}`}>{parseBlockRange(quoted, collector === null ? null : quotedOrigins, 0, 0, false, `q${quoteKey}-`, { ...context, quoted: true, depth: context.depth + 1 }).blocks}</blockquote>,
			);
			continue;
		}

		if (listItem(line) !== null) {
			const list = parseList(lines, origins, index, `${keyPrefix}${key++}`, context);
			blocks.push(list.node);
			index = list.next;
			continue;
		}

		const nextLine = lines[index + 1];
		if (line.includes("|") && nextLine !== undefined && TABLE_SEPARATOR.test(nextLine)) {
			const header = splitTableRow(line);
			const table: LeafTable | undefined = collector === null ? undefined : { header: leafLine(origins, lines, index), separator: leafLine(origins, lines, index + 1) };
			const headerLeaf = collector?.add({ kind: "row", lines: [table!.header], first: table!.header.line, last: table!.header.line, table, header: true });
			index += 2;
			const rows: string[][] = [];
			const rowLeaves: (number | undefined)[] = [];
			while (index < lines.length) {
				const row = lines[index] as string;
				if (row.trim() === "" || !row.includes("|")) break;
				rows.push(splitTableRow(row));
				const rowLine = collector === null ? undefined : leafLine(origins, lines, index);
				rowLeaves.push(collector?.add({ kind: "row", lines: [rowLine!], first: rowLine!.line, last: rowLine!.line, table, header: false }));
				index++;
			}
			// A table cannot wrap below its longest words: a wide one scrolls inside its own block, never the transcript.
			blocks.push(
				<div className="omp-table-scroll" key={`b${key++}`}>
					<table>
						<thead>
							<tr data-md-leaf={headerLeaf}>
								{header.map((cell, cellIndex) => (
									<th key={`th${cellIndex}`}>{renderInline(cell, `th${cellIndex}`, context.emphasis)}</th>
								))}
							</tr>
						</thead>
						<tbody>
							{rows.map((row, rowIndex) => (
								<tr key={`tr${rowIndex}`} data-md-leaf={rowLeaves[rowIndex]}>
									{header.map((_, cellIndex) => (
										<td key={`td${cellIndex}`}>{renderInline(row[cellIndex] ?? "", `td${rowIndex}-${cellIndex}`, context.emphasis)}</td>
									))}
								</tr>
							))}
						</tbody>
					</table>
				</div>,
			);
			continue;
		}

		// Paragraph: consecutive lines that do not open another block, joined by a soft break. The first line is always taken (the branches above did not take it); a list-like line that `listItem` rejects (`1234567890. x`, a no-break space after the marker) is paragraph text, not a block opener.
		const paragraphStart = index;
		const paragraph: string[] = [];
		while (index < lines.length) {
			const paragraphLine = lines[index] as string;
			if (
				paragraph.length > 0 &&
				(paragraphLine.trim() === "" ||
					FENCE.test(paragraphLine) ||
					HEADING.test(paragraphLine) ||
					RULE.test(paragraphLine) ||
					quoteLine(paragraphLine, context) ||
					listItem(paragraphLine) !== null)
			) {
				break;
			}
			paragraph.push(paragraphLine);
			index++;
		}
		blocks.push(paragraphOf(paragraph, paragraphStart, `${keyPrefix}${key++}`));
	}

	return { blocks, starts, leafStarts };
}

export const Markdown = memo(function Markdown({ text, quotable = false, emphasis = true }: { text: string; quotable?: boolean; emphasis?: boolean }): ReactNode {
	// The previous parse feeds the next one: while a reply streams, only the tail is parsed again.
	const previous = useRef<MarkdownParse | null>(null);
	const parsed = useMemo(() => parseMarkdown(text, previous.current, quotable, emphasis), [text, quotable, emphasis]);
	previous.current = parsed;
	const root = useRef<HTMLDivElement>(null);
	// A quotable message hands the page the parse that produced its DOM, once the DOM is committed.
	useLayoutEffect(() => {
		const element = root.current;
		if (!quotable || element === null) return undefined;
		registerMarkdown(element, { text: parsed.text, leaves: parsed.leaves });
		return () => unregisterMarkdown(element);
	}, [parsed, quotable]);
	return <div ref={root} className="omp-md">{parsed.blocks}</div>;
});
