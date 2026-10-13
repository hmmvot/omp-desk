import type { ReactNode } from "react";
import { Fragment, useMemo, useState } from "react";
import { parseAnsi, stripAnsi, type AnsiLimits, type AnsiLine } from "../../chat/ansi";
import { AnsiLines } from "./AnsiText";
import { isRecord } from "../../shared/guards";
import { Markdown } from "./Markdown";
import { FileLink, FileLinkText } from "./FileLinks";
import type { ExplicitFileLink } from "./FileLinks";
import { SavedImage } from "./SavedImage";
import { CodeRuns } from "./CodeRuns";
import { languageForPath, languageId } from "../lib/code-languages";
import { useCodeLines } from "../lib/use-highlighted-runs";
import { WebLink } from "./WebLinks";
import { webLinkUrl } from "../../shared/terminal-links";

export function record(value: unknown): Record<string, unknown> { return isRecord(value) ? value : {}; }
export function string(value: unknown): string { return typeof value === "string" ? value : ""; }
export function records(value: unknown): Record<string, unknown>[] { return Array.isArray(value) ? value.filter(isRecord) : []; }
export function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : typeof value === "string" ? [value] : []; }
export function scalar(value: unknown): string { return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : ""; }

/** Strip terminal styling before presenting native output as plain text in the DOM. */
export function displayText(value: string): string {
	return stripAnsi(value);
}
/** Tool output is longer than a notice; it is still read within a bound. */
const PREVIEW_ANSI_LIMITS: AnsiLimits = { maxChars: 1024 * 1024, maxSpans: 20_000 };
const joinedLine = (line: AnsiLine): string => line.map(span => span.text).join("");
/** Bound rendered rows as well as logical newlines, so wrapped output stays compact. */
export function PreviewWindow({ children, lines, tail = false, code = false }: { children: ReactNode; lines: number; tail?: boolean; code?: boolean }): ReactNode {
	if (lines <= 0) return null;
	return <div className={`omp-native-preview-window${tail ? " omp-native-preview-window--tail" : ""}${code ? " omp-native-preview-window--code" : ""}`} style={{ maxHeight: `calc(${lines}lh + ${code ? 8 : 0}px)` }}><div className="omp-native-preview-window-content">{children}</div></div>;
}
/** Long native output is disclosed in flow, never placed in a second scroll region. */
function OutputLines<T>({ all, render }: { all: readonly T[]; render: (lines: readonly T[], offset: number) => ReactNode }): ReactNode {
	const [limit, setLimit] = useState(200);
	const end = Math.min(all.length, limit), tail = end < all.length ? Math.max(end, all.length - 20) : all.length;
	const hidden = tail - end;
	return <>{render(all.slice(0, end), 0)}{hidden > 0 && <div className="omp-output-disclosure">
		<button type="button" onClick={() => setLimit(current => current + 200)}>Show {Math.min(200, hidden)} more lines</button>
		<button type="button" onClick={() => setLimit(all.length)}>Show all {all.length} lines</button>
		<span className="omp-empty-note">{hidden} lines hidden</span>
	</div>}{tail < all.length && render(all.slice(tail), tail)}</>;
}
/**
 * The lines `from..to` of `all` as plain text rows joined by newlines, coloured as `language` when the
 * page has a theme and the language is ours; copying yields the plain text either way.
 */
function CodeText({ all, from, to, language, closed }: { all: readonly string[]; from: number; to: number; language: string | null; closed: boolean }): ReactNode {
	const code = useCodeLines(language, all, from, to, closed);
	return <>{all.slice(from, to).map((line, index) => {
		const runs = code.at(from + index);
		return <Fragment key={from + index}>{index > 0 && "\n"}{runs === null ? line : <CodeRuns runs={runs} />}</Fragment>;
	})}</>;
}
/** `language` is a fence id or alias (`python`, `js`): the text is then code, coloured by the theme instead of read for terminal styling. */
export function TextPreview({ text, expanded, lines = 3, tail = false, prose = false, language, closed = true }: { text: string; expanded: boolean; lines?: number; tail?: boolean; prose?: boolean; language?: string; closed?: boolean }): ReactNode {
	const all = useMemo(() => text ? parseAnsi(text, PREVIEW_ANSI_LIMITS) : [], [text]);
	const code = useMemo(() => !prose && language !== undefined && languageId(language) !== null ? all.map(joinedLine) : null, [all, language, prose]);
	if (!text) return null;
	const hidden = expanded ? 0 : Math.max(0, all.length - lines);
	const shown = expanded ? all : tail ? all.slice(-lines) : all.slice(0, lines);
	const body = (part: readonly AnsiLine[], offset = 0): ReactNode => prose ? <Markdown text={part.map(joinedLine).join("\n")} /> : code !== null ? <pre className="omp-pre"><CodeText all={code} from={offset} to={offset + part.length} language={language!} closed={closed} /></pre> : <pre className="omp-pre"><AnsiLines lines={part} /></pre>;
	return <div className="omp-native-preview">
		{hidden > 0 && tail && <div className="omp-empty-note">{hidden} earlier lines</div>}
		{shown.length > 0 && (expanded ? <OutputLines all={all} render={body} /> : <PreviewWindow lines={lines} tail={tail} code={!prose}>{body(shown, all.length - shown.length > 0 && tail ? all.length - shown.length : 0)}</PreviewWindow>)}
		{hidden > 0 && !tail && <div className="omp-empty-note">{hidden} more lines</div>}
	</div>;
}
/** The code rows `from..to` of `all`, each behind its line number. */
function CodeRows({ all, from, to, language, closed, numbers, start }: { all: readonly string[]; from: number; to: number; language: string | null; closed: boolean; numbers: readonly (number | null)[] | null; start: number }): ReactNode {
	const code = useCodeLines(language, all, from, to, closed);
	return <pre className="omp-pre omp-native-code">{all.slice(from, to).map((line, index) => {
		const at = from + index;
		const number = numbers ? numbers[at] : start + at;
		const runs = code.at(at);
		return <span className="omp-native-code-line" key={at}><span className="omp-native-line-number">{typeof number === "number" ? number : ""}</span>{" "}{runs === null ? line : <CodeRuns runs={runs} />}{"\n"}</span>;
	})}</pre>;
}
/** `path` names the file the text is from: its language, when it is one of ours, colours the code. `closed` is false while the text is still being written. */
export function CodePreview({ text, expanded, lines = 6, start = 1, lineNumbers, tail = false, path, closed = true }: { text: string; expanded: boolean; lines?: number; start?: number; lineNumbers?: unknown; tail?: boolean; path?: string; closed?: boolean }): ReactNode {
	const all = useMemo(() => text ? displayText(text).split("\n") : [], [text]);
	if (!text) return null;
	const language = path === undefined ? null : languageForPath(path);
	const hidden = expanded ? 0 : Math.max(0, all.length - lines);
	const offset = !expanded && tail ? hidden : 0;
	const numbers = Array.isArray(lineNumbers) && lineNumbers.length === all.length && lineNumbers.every(number => number === null || typeof number === "number" && Number.isFinite(number)) ? lineNumbers as (number | null)[] : null;
	const rows = (from: number, to: number): ReactNode => <CodeRows all={all} from={from} to={to} language={language} closed={closed} numbers={numbers} start={start} />;
	return <div className="omp-native-source">
		{hidden > 0 && tail && <div className="omp-empty-note">{hidden} earlier lines</div>}
		{expanded ? <OutputLines all={all} render={(part, at) => rows(at, at + part.length)} /> : rows(offset, Math.min(all.length, offset + lines))}
		{hidden > 0 && !tail && <div className="omp-empty-note">{hidden} more lines</div>}
	</div>;
}
type DiffKind = "file" | "hunk" | "add" | "remove" | "other";
/** One diff line: its class, the code it carries (`null` for headers and notes), and where that code sits in each side's text. */
interface DiffRow { readonly line: string; readonly kind: DiffKind; readonly sign: string; readonly numbered: RegExpExecArray | null; readonly code: string | null; readonly before: number; readonly after: number }
/**
 * A diff read as the two texts it joins: `before` (context and removed lines) and `after` (context and
 * added lines), so each side is tokenized as a whole file would be and multi-line constructs hold within
 * a hunk. Hunks are not contiguous in the file, so a construct that spans a gap is cut there. The prefixes
 * count each side's lines before row `n`, to find the window of a part of rows.
 */
interface DiffModel { readonly rows: readonly DiffRow[]; readonly before: readonly string[]; readonly after: readonly string[]; readonly beforePrefix: readonly number[]; readonly afterPrefix: readonly number[] }
function diffModel(all: readonly string[]): DiffModel {
	const rows: DiffRow[] = [], before: string[] = [], after: string[] = [], beforePrefix: number[] = [], afterPrefix: number[] = [];
	for (const line of all) {
		beforePrefix.push(before.length); afterPrefix.push(after.length);
		const numbered = /^([+\- ])(\d+)\|(.*)$/.exec(line);
		const kind: DiffKind = /^(?:diff --git|---|\+\+\+|Index:)/.test(line) ? "file" : line.startsWith("+") ? "add" : line.startsWith("-") ? "remove" : line.startsWith("@@") ? "hunk" : "other";
		const sign = numbered ? numbered[1]! : line.charAt(0);
		const code = numbered ? numbered[3]! : kind === "add" || kind === "remove" || kind === "other" && sign === " " ? line.slice(1) : null;
		// Only a numbered row's sign decides its side; a `---` header never carries code.
		const side = code === null ? "none" : sign === "+" ? "after" : sign === "-" ? "before" : "both";
		rows.push({ line, kind, sign, numbered, code, before: side === "before" || side === "both" ? before.length : -1, after: side === "after" || side === "both" ? after.length : -1 });
		if (side === "before" || side === "both") before.push(code!);
		if (side === "after" || side === "both") after.push(code!);
	}
	beforePrefix.push(before.length); afterPrefix.push(after.length);
	return { rows, before, after, beforePrefix, afterPrefix };
}
function DiffRows({ model, from, to, language, closed }: { model: DiffModel; from: number; to: number; language: string | null; closed: boolean }): ReactNode {
	const after = useCodeLines(language, model.after, model.afterPrefix[from]!, model.afterPrefix[to]!, closed);
	const before = useCodeLines(language, model.before, model.beforePrefix[from]!, model.beforePrefix[to]!, closed);
	return <pre className="omp-pre">{model.rows.slice(from, to).map((row, index) => {
		const runs = row.code === null ? null : row.kind === "remove" || row.numbered?.[1] === "-" ? before.at(row.before) : after.at(row.after);
		const code = runs === null || row.code === null ? row.code : <CodeRuns runs={runs} />;
		const className = row.kind === "file" ? "omp-native-diff-file" : row.kind === "add" ? "omp-native-diff-add" : row.kind === "remove" ? "omp-native-diff-remove" : row.kind === "hunk" ? "omp-native-diff-hunk" : "";
		return <span key={from + index} className={className}>{row.numbered ? <><span className="omp-native-diff-sign">{row.sign}</span><span className="omp-native-line-number">{row.numbered[2]}</span>{code}</> : runs !== null && row.code !== null ? <>{row.sign}<CodeRuns runs={runs} /></> : row.line}{"\n"}</span>;
	})}</pre>;
}
/** `path` names the file the diff is of: its language colours the code of every line; the signs, numbers and line backgrounds are the diff's own. */
export function DiffPreview({ text, expanded, lines = 40, path, closed = true }: { text: string; expanded: boolean; lines?: number; path?: string; closed?: boolean }): ReactNode {
	const all = useMemo(() => text ? displayText(text).split("\n") : [], [text]);
	const model = useMemo(() => diffModel(all), [all]);
	if (!text) return null;
	const language = path === undefined ? null : languageForPath(path);
	let hunks = 0;
	let shown = all;
	if (!expanded) {
		let end = 0;
		while (end < all.length && end < lines) {
			if (all[end]!.startsWith("@@") && ++hunks > 8) break;
			end++;
		}
		shown = all.slice(0, end);
	}
	return <div className="omp-native-diff">{expanded ? <OutputLines all={all} render={(part, offset) => <DiffRows model={model} from={offset} to={offset + part.length} language={language} closed={closed} />} /> : <DiffRows model={model} from={0} to={shown.length} language={language} closed={closed} />}{shown.length < all.length && <div className="omp-empty-note">{all.length - shown.length} more diff lines</div>}</div>;
}
export function Section({ title, link, children }: { title?: string; link?: ExplicitFileLink; children: ReactNode }): ReactNode {
	return <section className="omp-tool-section">{title !== undefined && <div className="omp-tool-section-title"><FileLinkText text={title} link={link} /></div>}{children}</section>;
}
/** Bounded JSON view for tool arguments and display output only; never used for `details`. */
export function JsonOutput({ value, expanded, omitAbsent = false }: { value: unknown; expanded: boolean; omitAbsent?: boolean }): ReactNode {
	const maxDepth = expanded ? 6 : 2;
	const maxLines = expanded ? 200 : 6;
	const maxScalar = expanded ? 2000 : 60;
	const lines: string[] = [];
	let truncated = false;
	function visit(item: unknown, label: string, depth: number): void {
		if (omitAbsent && item == null) return;
		if (lines.length >= maxLines) { truncated = true; return; }
		const prefix = `${"  ".repeat(depth)}${label}`;
		if (item !== null && typeof item === "object") {
			const array = Array.isArray(item);
			lines.push(`${prefix}${array ? "[]" : "{}"}`);
			for (const key in item) {
				if (!Object.hasOwn(item, key) || depth === 0 && (key === "i" || key === "__partialJson")) continue;
				const child = array ? item[Number(key)] : (item as Record<string, unknown>)[key];
				if (omitAbsent && child == null) continue;
				if (depth >= maxDepth || lines.length >= maxLines) { truncated = true; break; }
				visit(child, `${array ? `[${key}]` : displayText(key)}: `, depth + 1);
			}
			return;
		}
		const text = typeof item === "string" ? JSON.stringify(displayText(item)) : String(item);
		lines.push(`${prefix}${text.length > maxScalar ? `${text.slice(0, maxScalar)}…` : text}`);
	}
	visit(value, "", 0);
	return <><pre className="omp-pre">{lines.join("\n")}</pre>{truncated && <div className="omp-empty-note">…</div>}</>;
}
export function ToolImage({ value }: { value: unknown }): ReactNode {
	const image = record(value);
	if (image.type !== "image" || typeof image.mimeType !== "string" || typeof image.data !== "string") return null;
	return <SavedImage className="omp-img" alt="Tool image" mimeType={image.mimeType} data={image.data} />;
}
/** A tool result's `http(s)` URL as a web link; anything else shows its label as text. */
export function Link({ href, children }: { href: unknown; children: ReactNode }): ReactNode {
	const url = typeof href === "string" ? webLinkUrl(href) : null;
	return url === null ? <>{children}</> : <WebLink url={url}>{children}</WebLink>;
}
export function LimitedList<T>({ items, expanded, limit = 8, render }: { items: readonly T[]; expanded: boolean; limit?: number; render: (item: T, index: number) => ReactNode }): ReactNode {
	const shown = expanded ? items : items.slice(0, limit);
	return <><ul className="omp-native-list">{shown.map((item, index) => <li key={index}>{render(item, index)}</li>)}</ul>{shown.length < items.length && <div className="omp-empty-note">{items.length - shown.length} more items</div>}</>;
}
export function Diagnostics({ value, expanded }: { value: unknown; expanded: boolean }): ReactNode {
	const data = record(value);
	const messages = strings(data.messages);
	if (Object.keys(data).length === 0) return null;
	return <Section title={`Diagnostics${data.summary ? ` · ${scalar(data.summary)}` : ""}`}><LimitedList items={messages} expanded={expanded} limit={5} render={message => <span className={data.errored === true ? "omp-native-error" : "omp-native-warning"}>{string(message)}</span>} /></Section>;
}
export interface FileOutput { path: string; lines: string[] }
/** Parses grouped-file output: nested `#` directory headers, file headers, and bracketed hashline headers. */
export function groupedFiles(text: string): FileOutput[] {
	const files: FileOutput[] = [];
	const dirs: string[] = [];
	let current: FileOutput | undefined;
	for (const line of displayText(text).split("\n")) {
		const header = /^(#+)\s+(.*)$/.exec(line);
		const bracket = /^\[(.+)#[0-9a-f]+\]$/i.exec(line);
		if (header) {
			const depth = header[1]!.length;
			const name = header[2]!.replace(/\s+\([^)]*\)\s*$/, "").replace(/#[0-9a-f]+$/i, "");
			dirs.length = depth - 1;
			if (name.endsWith("/")) { dirs[depth - 1] = name.slice(0, -1); current = undefined; continue; }
			current = { path: /^\w+:\/\//.test(name) ? name : [...dirs.filter(Boolean), name].join("/"), lines: [] };
			files.push(current);
		} else if (bracket) {
			current = { path: bracket[1]!, lines: [] }; files.push(current);
		} else {
			if (!current) { current = { path: "", lines: [] }; files.push(current); }
			current.lines.push(line);
		}
	}
	return files.filter(file => file.path || file.lines.some(line => line.trim()));
}
/**
 * The numbered match and context lines of one file of search output. The code after each number is coloured
 * by the file's language as one text of the lines in order; the lines are not contiguous in the file, so a
 * construct that spans two of them is cut between.
 */
function MatchLines({ path, lines }: { path: string; lines: readonly string[] }): ReactNode {
	const rows = useMemo(() => lines.map(line => /^\s*(\*)?(\d+)(?:│|:)\s?(.*)$/.exec(line)), [lines]);
	const codes = useMemo(() => rows.flatMap(match => match ? [match[3]!] : []), [rows]);
	const code = useCodeLines(path ? languageForPath(path) : null, codes, 0, codes.length, true);
	let at = 0;
	return <pre className="omp-pre">{rows.map((match, row) => {
		const runs = match ? code.at(at++) : null;
		return <span key={row} className={match?.[1] ? "omp-native-match" : ""}>{match ? <>{path ? <FileLink target={`${path}:${match[2]}`} proof={path}><span className="omp-native-line-number">{match[2]}</span></FileLink> : <span className="omp-native-line-number">{match[2]}</span>}{" "}{runs ? <CodeRuns runs={runs} /> : match[3]}</> : lines[row]}{"\n"}</span>;
	})}</pre>;
}
export function MatchOutput({ text, expanded, fileLimit, matchLimit }: { text: string; expanded: boolean; fileLimit?: number; matchLimit?: number }): ReactNode {
	const all = groupedFiles(text);
	const files = expanded || fileLimit === undefined ? all : all.slice(0, fileLimit);
	let remaining = expanded || matchLimit === undefined ? Infinity : matchLimit;
	return <>{files.map((file, index) => {
		const lines: string[] = [];
		for (const line of file.lines) {
			if (/^\s*\*?\d+(?:│|:)/.test(line)) { if (remaining <= 0) break; remaining--; }
			lines.push(line);
		}
		return <Section key={index} title={file.path || "Matches"}><MatchLines path={file.path} lines={lines} />{lines.length < file.lines.length && <div className="omp-empty-note">{file.lines.length - lines.length} more lines</div>}</Section>;
	})}{files.length < all.length && <div className="omp-empty-note">{all.length - files.length} more files</div>}</>;
}
