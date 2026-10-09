/**
 * Markdown renderer for transcript text.
 *
 * Renders to React nodes instead of HTML strings: there is no
 * `dangerouslySetInnerHTML` path, so raw HTML in model output is displayed as
 * text and can never become markup. Supported syntax is the subset the chat
 * transcript needs — fenced code, headings, lists, blockquotes, horizontal
 * rules, pipe tables, plus inline code/bold/italic/strikethrough/links. Web links
 * (`[label](https://…)`, `<https://…>` and bare URLs in prose) accept only
 * `http:`/`https:`; any other destination keeps its label as text.
 *
 * This is a small project-owned renderer: a general-purpose Markdown library would
 * add a package to the bundle for behavior this panel does not need.
 */
import type { ReactNode } from "react";
import { Fragment, memo, useMemo } from "react";
import { detectChatFileLinks, fileTargetOfHref, isFileLinkCandidate } from "../lib/chat-file-links";
import { detectWebLinks } from "../lib/chat-web-links";
import { webLinkUrl } from "../terminal-links";
import { FileLink, FileLinkText } from "./FileLinks.tsx";
import { ImageReferenceToken } from "./ImageReference.tsx";
import { WebLink } from "./WebLinks.tsx";
import { CopyButton } from "./CopyButton.tsx";

/**
 * Inline token grammar; code wins over emphasis, bold over italic, matching markdown. A bare URL
 * is one token so the `_`/`*` inside it never start emphasis; `<https://…>` is an autolink.
 */
const INLINE_TOKEN =
	/(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(\*[^*\n]+\*)|(_[^_\n]+_)|(~~[^~\n]+~~)|(\[[^\]\n]*\]\((?:[^()\s]|\([^()\s]*\))+\))|(\[Image #[1-9]\d*(?:,[^\]\n]*)?\])|(<https?:\/\/[^\s<>]+>)|((?<![A-Za-z\d+.-])[Hh][Tt][Tt][Pp][Ss]?:\/\/[^\s<>"`]+)/g;

const HEADING = /^(#{1,6})\s+(.*)$/;
const FENCE = /^\s*```(\S*)\s*$/;
const UNORDERED_ITEM = /^\s*[-*+]\s+(.*)$/;
const ORDERED_ITEM = /^\s*\d+[.)]\s+(.*)$/;
/** A list item line: indent, marker, spacing after the marker, content. */
const LIST_ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+)(.*)$/;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const QUOTE = /^\s*>\s?(.*)$/;
const TABLE_SEPARATOR = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/;

/** Text whose file references the host has proven can become links; text without a candidate stays a bare string. */
function files(text: string, key: string): ReactNode {
	return detectChatFileLinks(text).length === 0 ? text : <FileLinkText key={key} text={text} />;
}

/** Plain text with its bare web URLs linked and its file references offered to the host; the characters are never altered. */
function plain(text: string, key: string): ReactNode {
	const web = detectWebLinks(text);
	if (web.length === 0) return files(text, key);
	const nodes: ReactNode[] = [];
	let cursor = 0;
	web.forEach((link, index) => {
		if (link.start > cursor) nodes.push(files(text.slice(cursor, link.start), `${key}-f${index}`));
		nodes.push(<WebLink key={`${key}-w${index}`} url={link.target}>{text.slice(link.start, link.end)}</WebLink>);
		cursor = link.end;
	});
	if (cursor < text.length) nodes.push(files(text.slice(cursor), `${key}-f${web.length}`));
	return <Fragment key={key}>{nodes}</Fragment>;
}

/** A whole code span that is one path (spaces allowed only after a drive, home or relative prefix) links as a unit; an `@` mention and any other span link the file references they hold. A URL in code stays code. */
function codeSpan(content: string, key: string): ReactNode {
	const whole = content.trim();
	const single = !whole.startsWith("@") && (!/\s/.test(whole) || /^(?:[a-z]:[\\/]|~[\\/]|\.{1,2}[\\/]|\/)/i.test(whole) && !/\s-/.test(whole));
	return <code key={key}>{single && isFileLinkCandidate(whole) ? <FileLink target={whole}>{content}</FileLink> : files(content, `${key}f`)}</code>;
}

function renderInline(text: string, keyPrefix: string): ReactNode[] {
	const nodes: ReactNode[] = [];
	let cursor = 0;
	let tokenIndex = 0;
	INLINE_TOKEN.lastIndex = 0;
	let match = INLINE_TOKEN.exec(text);
	while (match !== null) {
		if (match.index > cursor) nodes.push(plain(text.slice(cursor, match.index), `${keyPrefix}-p${tokenIndex}`));
		const token = match[0];
		const key = `${keyPrefix}-t${tokenIndex++}`;
		cursor = match.index + token.length;
		if (token.startsWith("`")) {
			nodes.push(codeSpan(token.slice(1, -1), key));
		} else if (token.startsWith("**") || token.startsWith("__")) {
			nodes.push(<strong key={key}>{plain(token.slice(2, -2), `${key}f`)}</strong>);
		} else if (token.startsWith("~~")) {
			nodes.push(<s key={key}>{plain(token.slice(2, -2), `${key}f`)}</s>);
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
			// A rejected scheme keeps its label but never its URL: the transcript
			// must not carry a `javascript:`/`data:`/`command:` destination at all.
			nodes.push(file !== null ? <FileLink key={key} target={file}>{label}</FileLink> : url === null ? label : <WebLink key={key} url={url}>{label}</WebLink>);
		} else if (token.startsWith("<")) {
			const url = webLinkUrl(token.slice(1, -1));
			nodes.push(url === null ? plain(token, key) : <WebLink key={key} url={url}>{token.slice(1, -1)}</WebLink>);
		} else if (/^https?:/i.test(token)) {
			// A bare URL: its trailing punctuation is prose again.
			nodes.push(plain(token, key));
		} else {
			nodes.push(<em key={key}>{plain(token.slice(1, -1), `${key}f`)}</em>);
		}
		match = INLINE_TOKEN.exec(text);
	}
	if (cursor < text.length) nodes.push(plain(text.slice(cursor), `${keyPrefix}-p${tokenIndex}`));
	return nodes;
}

/** Render soft-wrapped lines as inline content separated by `<br/>` (markdown `breaks` mode). */
function renderLines(lines: readonly string[], keyPrefix: string): ReactNode[] {
	const nodes: ReactNode[] = [];
	lines.forEach((line, lineIndex) => {
		if (lineIndex > 0) nodes.push(<br key={`${keyPrefix}-br${lineIndex}`} />);
		nodes.push(...renderInline(line, `${keyPrefix}-l${lineIndex}`));
	});
	return nodes;
}

/** Split a table row on unescaped pipes, dropping the optional edge pipes. */
function splitTableRow(line: string): string[] {
	const cells: string[] = [];
	let current = "";
	for (let i = 0; i < line.length; i++) {
		const ch = line[i] as string;
		if (ch === "\\" && i + 1 < line.length) {
			current += line[i + 1] as string;
			i++;
			continue;
		}
		if (ch === "|") {
			cells.push(current);
			current = "";
			continue;
		}
		current += ch;
	}
	cells.push(current);
	if (cells.length > 1 && (cells[0] as string).trim() === "") cells.shift();
	if (cells.length > 1 && (cells[cells.length - 1] as string).trim() === "") cells.pop();
	return cells.map(cell => cell.trim());
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
function parseList(lines: readonly string[], start: number, listKey: string): { node: ReactNode; next: number } {
	const first = listItem(lines[start] as string) as ListItemMatch;
	const items: string[][] = [];
	let loose = false;
	let index = start;
	while (index < lines.length) {
		const head = listItem(lines[index] as string);
		if (head === null || head.indent < first.indent || head.ordered !== first.ordered) break;
		const body = [head.content];
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
					for (let blank = index; blank < ahead; blank++) body.push("");
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
				body.push(dedent(line, Math.min(indent, head.contentOffset)));
			} else if (nested === null && !previousBlank && !FENCE.test(line) && !HEADING.test(line) && !RULE.test(line) && !QUOTE.test(line)) {
				body.push(line.trim());
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
		<li key={`li${itemIndex}`}>{parseBlocks(body.join("\n"), !loose, `${listKey}-${itemIndex}`)}</li>
	));
	return {
		node: first.ordered
			? <ol key={listKey} start={first.number === 1 ? undefined : first.number}>{rendered}</ol>
			: <ul key={listKey}>{rendered}</ul>,
		next: index,
	};
}

/** Parse block structure; `tight` renders paragraphs inline, as in a tight list item. */
function parseBlocks(text: string, tight = false, keyPrefix = "b"): ReactNode[] {
	const lines = text.split(/\r?\n/);
	const blocks: ReactNode[] = [];
	let index = 0;
	let key = 0;

	while (index < lines.length) {
		const line = lines[index] as string;
		if (line.trim() === "") {
			index++;
			continue;
		}

		const fence = FENCE.exec(line);
		if (fence !== null) {
			const language = fence[1] ?? "";
			const body: string[] = [];
			index++;
			while (index < lines.length && !/^\s*```\s*$/.test(lines[index] as string)) {
				body.push(lines[index] as string);
				index++;
			}
			index++; // closing fence (or EOF)
			const source = body.join("\n");
			blocks.push(
				<div key={`b${key++}`} className="omp-code-block">
					<pre>
						<code data-language={language}>{source}</code>
					</pre>
					{source.length > 0 && <CopyButton text={source} label="Copy code" className="omp-code-copy" />}
				</div>,
			);
			continue;
		}

		const heading = HEADING.exec(line);
		if (heading !== null) {
			const level = Math.min(6, (heading[1] as string).length);
			const Tag = `h${level}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
			blocks.push(<Tag key={`b${key++}`}>{renderInline(heading[2] as string, `h${key}`)}</Tag>);
			index++;
			continue;
		}

		if (RULE.test(line)) {
			blocks.push(<hr key={`b${key++}`} />);
			index++;
			continue;
		}

		if (QUOTE.test(line)) {
			const quoted: string[] = [];
			while (index < lines.length) {
				const quotedLine = QUOTE.exec(lines[index] as string);
				if (quotedLine === null) break;
				quoted.push(quotedLine[1] as string);
				index++;
			}
			blocks.push(
				<blockquote key={`b${key++}`}>{renderLines(quoted, `q${key}`)}</blockquote>,
			);
			continue;
		}

		if (listItem(line) !== null) {
			const list = parseList(lines, index, `${keyPrefix}${key++}`);
			blocks.push(list.node);
			index = list.next;
			continue;
		}

		const nextLine = lines[index + 1];
		if (line.includes("|") && nextLine !== undefined && TABLE_SEPARATOR.test(nextLine)) {
			const header = splitTableRow(line);
			index += 2;
			const rows: string[][] = [];
			while (index < lines.length) {
				const row = lines[index] as string;
				if (row.trim() === "" || !row.includes("|")) break;
				rows.push(splitTableRow(row));
				index++;
			}
			blocks.push(
				<table key={`b${key++}`}>
					<thead>
						<tr>
							{header.map((cell, cellIndex) => (
								<th key={`th${cellIndex}`}>{renderInline(cell, `th${cellIndex}`)}</th>
							))}
						</tr>
					</thead>
					<tbody>
						{rows.map((row, rowIndex) => (
							<tr key={`tr${rowIndex}`}>
								{header.map((_, cellIndex) => (
									<td key={`td${cellIndex}`}>{renderInline(row[cellIndex] ?? "", `td${rowIndex}-${cellIndex}`)}</td>
								))}
							</tr>
						))}
					</tbody>
				</table>,
			);
			continue;
		}

		// Paragraph: consecutive lines that do not open another block, joined by a soft break.
		const paragraph: string[] = [];
		while (index < lines.length) {
			const paragraphLine = lines[index] as string;
			if (
				paragraphLine.trim() === "" ||
				FENCE.test(paragraphLine) ||
				HEADING.test(paragraphLine) ||
				RULE.test(paragraphLine) ||
				QUOTE.test(paragraphLine) ||
				UNORDERED_ITEM.test(paragraphLine) ||
				ORDERED_ITEM.test(paragraphLine)
			) {
				break;
			}
			paragraph.push(paragraphLine);
			index++;
		}
		const paragraphKey = `${keyPrefix}${key++}`;
		blocks.push(tight ? <span key={paragraphKey}>{renderLines(paragraph, paragraphKey)}</span> : <p key={paragraphKey}>{renderLines(paragraph, paragraphKey)}</p>);
	}

	return blocks;
}

export const Markdown = memo(function Markdown({ text }: { text: string }): ReactNode {
	const blocks = useMemo(() => parseBlocks(text), [text]);
	return <div className="omp-md">{blocks}</div>;
});
