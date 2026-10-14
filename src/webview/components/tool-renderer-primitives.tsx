import type { ReactNode } from "react";
import { Fragment, useMemo } from "react";
import { stripAnsi } from "../../chat/ansi";
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
import { OutputRows, PREVIEW_ROWS, ShowAll, useToolViewContext } from "./tool-view";
import { JsonRows } from "./JsonRows";
import type { JsonSource } from "../lib/json-rows";
import { jsonTreeOfValue } from "../lib/json-tokens";

export function record(value: unknown): Record<string, unknown> { return isRecord(value) ? value : {}; }
export function string(value: unknown): string { return typeof value === "string" ? value : ""; }
export function records(value: unknown): Record<string, unknown>[] { return Array.isArray(value) ? value.filter(isRecord) : []; }
export function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : typeof value === "string" ? [value] : []; }
export function scalar(value: unknown): string { return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : ""; }

/** Strip terminal styling before presenting native output as plain text in the DOM: OMP stores none, but MCP, web and extension tools may. */
export function displayText(value: string): string {
	return stripAnsi(value);
}
/** A prose block is clipped at this many lines before "Show all". */
const PROSE_CLAMP_LINES = 14;
/** At most this many lines of prose are rendered while it is clipped. */
const PROSE_CLIP_SOURCE_LINES = 200;
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
/** Markdown clipped at about 14 lines until the card shows everything; the clip is CSS over a bounded amount of rendered source. */
function Prose({ lines, expanded }: { lines: readonly string[]; expanded: boolean }): ReactNode {
	if (expanded) return <OutputRows all={lines} expanded render={part => <Markdown text={part.join("\n")} />} />;
	const clipped = lines.length > PROSE_CLAMP_LINES + 3;
	return <>
		<div className={clipped ? "omp-prose-clip" : undefined}><Markdown text={(clipped ? lines.slice(0, PROSE_CLIP_SOURCE_LINES) : lines).join("\n")} /></div>
		{clipped && <div className="omp-output-marker omp-output-marker--bottom"><span>… clipped ({lines.length.toLocaleString("en-US")} lines)</span><ShowAll count={lines.length} unit="lines" /></div>}
	</>;
}
/**
 * Plain text rows, at most `lines` of them (the last ones for `tail`) until the card shows everything.
 * `language` is a fence id or alias (`python`, `js`): the text is then code, coloured by the theme.
 */
export function TextPreview({ text, expanded, lines = PREVIEW_ROWS, tail = false, prose = false, language, closed = true }: { text: string; expanded: boolean; lines?: number; tail?: boolean; prose?: boolean; language?: string; closed?: boolean }): ReactNode {
	const all = useMemo(() => text.trim() ? displayText(text).replace(/\s+$/, "").split("\n") : [], [text]);
	if (all.length === 0) return null;
	const code = !prose && language !== undefined && languageId(language) !== null ? language : null;
	return <div className="omp-native-preview">{prose
		? <Prose lines={all} expanded={expanded} />
		: <OutputRows all={all} expanded={expanded} limit={lines} tail={tail} render={(rows, offset) => <pre className="omp-pre">{code !== null ? <CodeText all={all} from={offset} to={offset + rows.length} language={code} closed={closed} /> : rows.join("\n")}</pre>} />}</div>;
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
export function CodePreview({ text, expanded, lines = PREVIEW_ROWS, start = 1, lineNumbers, tail = false, path, closed = true }: { text: string; expanded: boolean; lines?: number; start?: number; lineNumbers?: unknown; tail?: boolean; path?: string; closed?: boolean }): ReactNode {
	const all = useMemo(() => text ? displayText(text).split("\n") : [], [text]);
	if (!text) return null;
	const language = path === undefined ? null : languageForPath(path);
	const numbers = Array.isArray(lineNumbers) && lineNumbers.length === all.length && lineNumbers.every(number => number === null || typeof number === "number" && Number.isFinite(number)) ? lineNumbers as (number | null)[] : null;
	return <div className="omp-native-source"><OutputRows all={all} expanded={expanded} limit={lines} tail={tail} render={(rows, at) => <CodeRows all={all} from={at} to={at + rows.length} language={language} closed={closed} numbers={numbers} start={start} />} /></div>;
}
type DiffKind = "file" | "hunk" | "gap" | "add" | "remove" | "other";
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
		const kind: DiffKind = line.trim() === "" ? "gap" : /^(?:diff --git|---|\+\+\+|Index:)/.test(line) ? "file" : line.startsWith("+") ? "add" : line.startsWith("-") ? "remove" : line.startsWith("@@") ? "hunk" : "other";
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
		const className = row.kind === "file" ? "omp-native-diff-file" : row.kind === "add" ? "omp-native-diff-add" : row.kind === "remove" ? "omp-native-diff-remove" : row.kind === "hunk" || row.kind === "gap" ? "omp-native-diff-hunk" : "";
		return <span key={from + index} className={className}>{row.kind === "gap" ? "⋯" : row.numbered ? <><span className="omp-native-diff-sign">{row.sign}</span><span className="omp-native-line-number">{row.numbered[2]}</span>{code}</> : runs !== null && row.code !== null ? <>{row.sign}<CodeRuns runs={runs} /></> : row.line}{"\n"}</span>;
	})}</pre>;
}
/** `path` names the file the diff is of: its language colours the code of every line; the signs, numbers and line backgrounds are the diff's own. */
export function DiffPreview({ text, expanded, lines = PREVIEW_ROWS, path, closed = true }: { text: string; expanded: boolean; lines?: number; path?: string; closed?: boolean }): ReactNode {
	const all = useMemo(() => text ? displayText(text).replace(/\s+$/, "").split("\n") : [], [text]);
	const model = useMemo(() => diffModel(all), [all]);
	if (all.length === 0) return null;
	const language = path === undefined ? null : languageForPath(path);
	return <div className="omp-native-diff"><OutputRows all={all} expanded={expanded} limit={lines} unit="line" render={(rows, offset) => <DiffRows model={model} from={offset} to={offset + rows.length} language={language} closed={closed} />}
		hidden={rest => {
			const gaps = rest.filter(line => line.trim() === "" || line.startsWith("@@")).length, more = rest.length - gaps;
			return gaps > 0 ? `(${gaps} more ${gaps === 1 ? "hunk" : "hunks"}, ${more} more ${more === 1 ? "line" : "lines"})` : `${more} more ${more === 1 ? "line" : "lines"}`;
		}} /></div>;
}
export function Section({ title, link, children }: { title?: string; link?: ExplicitFileLink; children: ReactNode }): ReactNode {
	return <section className="omp-tool-section">{title !== undefined && <div className="omp-tool-section-title"><FileLinkText text={title} link={link} /></div>}{children}</section>;
}
/** The id the card's primary output keeps its folds under. */
export const OUTPUT_SCOPE = "output";
/**
 * A tool's primary output as text: the format the card detected in it (JSON, newline-delimited JSON) shown as a
 * folding tree unless the reader chose Text, else plain rows. Output the card detected nothing in, and any other
 * text, is a `TextPreview`.
 */
export function OutputText({ text, expanded, tail = false }: { text: string; expanded: boolean; tail?: boolean }): ReactNode {
	const { structured, view } = useToolViewContext();
	if (structured === undefined || structured.text !== text || (view?.format ?? "formatted") === "text") return <TextPreview text={text} expanded={expanded} tail={tail} />;
	return <JsonRows source={structured.format} scope={OUTPUT_SCOPE} expanded={expanded} />;
}
/**
 * A value tool arguments or display output carry, as a folding tree. `id` is where the card keeps its folds.
 */
export function JsonOutput({ value, expanded, omitAbsent = false, id = "value" }: { value: unknown; expanded: boolean; omitAbsent?: boolean; id?: string }): ReactNode {
	const source = useMemo((): JsonSource => ({ kind: "json", tree: jsonTreeOfValue(value, { absent: omitAbsent, rootKeys: ["i", "__partialJson"] }) }), [value, omitAbsent]);
	return <JsonRows source={source} scope={id} expanded={expanded} />;
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
export function LimitedList<T>({ items, expanded, limit = PREVIEW_ROWS, unit = "item", units, render }: { items: readonly T[]; expanded: boolean; limit?: number; unit?: string; units?: string; render: (item: T, index: number) => ReactNode }): ReactNode {
	return <OutputRows all={items} expanded={expanded} limit={limit} unit={unit} units={units} render={(rows, offset) => <ul className="omp-native-list">{rows.map((item, index) => <li key={offset + index}>{render(item, offset + index)}</li>)}</ul>} />;
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
/** One row of search output: a file's name, or one of its numbered match and context lines. */
type MatchRow = { readonly kind: "file"; readonly path: string } | { readonly kind: "line"; readonly path: string; readonly text: string };
/** Consecutive rows of one file: the file's header when the window starts there, then its lines. */
function MatchRows({ rows }: { rows: readonly MatchRow[] }): ReactNode {
	const runs: { path: string; header: boolean; lines: string[] }[] = [];
	for (const row of rows) {
		let run = runs.at(-1);
		if (row.kind === "file" || run === undefined || run.path !== row.path) { run = { path: row.path, header: row.kind === "file", lines: [] }; runs.push(run); }
		if (row.kind === "line") run.lines.push(row.text);
	}
	return <>{runs.map((run, index) => <Section key={index} title={run.header ? run.path || "Matches" : undefined}>{run.lines.length > 0 && <MatchLines path={run.path} lines={run.lines} />}</Section>)}</>;
}
/** Search output grouped per file: file headers and numbered lines are rows, at most `limit` of them until the card shows everything. */
export function MatchOutput({ text, expanded, limit = PREVIEW_ROWS }: { text: string; expanded: boolean; limit?: number }): ReactNode {
	const rows = useMemo(() => groupedFiles(text).flatMap((file): MatchRow[] => [{ kind: "file", path: file.path }, ...file.lines.map((line): MatchRow => ({ kind: "line", path: file.path, text: line }))]), [text]);
	return <OutputRows all={rows} expanded={expanded} limit={limit} render={part => <MatchRows rows={part} />} />;
}
