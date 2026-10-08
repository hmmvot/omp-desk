import type { ReactNode } from "react";
import { useState } from "react";
import { isRecord } from "../../guards";
import { Markdown } from "./Markdown";
import { FileLink, FileLinkText } from "./FileLinks";
import type { ExplicitFileLink } from "./FileLinks";
import { SavedImage } from "./SavedImage";
import { WebLink } from "./WebLinks";
import { webLinkUrl } from "../terminal-links";

export function record(value: unknown): Record<string, unknown> { return isRecord(value) ? value : {}; }
export function string(value: unknown): string { return typeof value === "string" ? value : ""; }
export function records(value: unknown): Record<string, unknown>[] { return Array.isArray(value) ? value.filter(isRecord) : []; }
export function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : typeof value === "string" ? [value] : []; }
export function scalar(value: unknown): string { return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : ""; }

/** Strip terminal styling before presenting native output in the DOM. */
export function displayText(value: string): string {
	return value.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\r/g, "");
}
/** Bound rendered rows as well as logical newlines, so wrapped output stays compact. */
export function PreviewWindow({ children, lines, tail = false, code = false }: { children: ReactNode; lines: number; tail?: boolean; code?: boolean }): ReactNode {
	if (lines <= 0) return null;
	return <div className={`omp-native-preview-window${tail ? " omp-native-preview-window--tail" : ""}${code ? " omp-native-preview-window--code" : ""}`} style={{ maxHeight: `calc(${lines}lh + ${code ? 8 : 0}px)` }}><div className="omp-native-preview-window-content">{children}</div></div>;
}
/** Long native output is disclosed in flow, never placed in a second scroll region. */
function OutputLines({ all, render }: { all: readonly string[]; render: (lines: readonly string[], offset: number) => ReactNode }): ReactNode {
	const [limit, setLimit] = useState(200);
	const end = Math.min(all.length, limit), tail = end < all.length ? Math.max(end, all.length - 20) : all.length;
	const hidden = tail - end;
	return <>{render(all.slice(0, end), 0)}{hidden > 0 && <div className="omp-output-disclosure">
		<button type="button" onClick={() => setLimit(current => current + 200)}>Show {Math.min(200, hidden)} more lines</button>
		<button type="button" onClick={() => setLimit(all.length)}>Show all {all.length} lines</button>
		<span className="omp-empty-note">{hidden} lines hidden</span>
	</div>}{tail < all.length && render(all.slice(tail), tail)}</>;
}
export function TextPreview({ text, expanded, lines = 3, tail = false, prose = false }: { text: string; expanded: boolean; lines?: number; tail?: boolean; prose?: boolean }): ReactNode {
	if (!text) return null;
	const all = displayText(text).split("\n");
	const hidden = expanded ? 0 : Math.max(0, all.length - lines);
	const shown = expanded ? all : tail ? all.slice(-lines) : all.slice(0, lines);
	return <div className="omp-native-preview">
		{hidden > 0 && tail && <div className="omp-empty-note">{hidden} earlier lines</div>}
		{shown.length > 0 && (expanded ? <OutputLines all={all} render={part => prose ? <Markdown text={part.join("\n")} /> : <pre className="omp-pre">{part.join("\n")}</pre>} /> : <PreviewWindow lines={lines} tail={tail} code={!prose}>{prose ? <Markdown text={shown.join("\n")} /> : <pre className="omp-pre">{shown.join("\n")}</pre>}</PreviewWindow>)}
		{hidden > 0 && !tail && <div className="omp-empty-note">{hidden} more lines</div>}
	</div>;
}
export function CodePreview({ text, expanded, lines = 6, start = 1, lineNumbers, tail = false }: { text: string; expanded: boolean; lines?: number; start?: number; lineNumbers?: unknown; tail?: boolean }): ReactNode {
	if (!text) return null;
	const all = displayText(text).split("\n");
	const hidden = expanded ? 0 : Math.max(0, all.length - lines);
	const offset = !expanded && tail ? hidden : 0;
	const shown = expanded ? all : all.slice(offset, offset + lines);
	const numbers = Array.isArray(lineNumbers) && lineNumbers.length === all.length && lineNumbers.every(number => number === null || typeof number === "number" && Number.isFinite(number)) ? lineNumbers : null;
	return <div className="omp-native-source">
		{hidden > 0 && tail && <div className="omp-empty-note">{hidden} earlier lines</div>}
		{expanded ? <OutputLines all={all} render={(part, offset) => <pre className="omp-pre omp-native-code">{part.map((line, index) => {
			const number = numbers ? numbers[index + offset] : start + index + offset;
			return <span className="omp-native-code-line" key={index + offset}><span className="omp-native-line-number">{typeof number === "number" ? number : ""}</span>{" "}{line}{"\n"}</span>;
		})}</pre>} /> : <pre className="omp-pre omp-native-code">{shown.map((line, index) => {
			const number = numbers ? numbers[index + offset] : start + index + offset;
			return <span className="omp-native-code-line" key={index + offset}><span className="omp-native-line-number">{typeof number === "number" ? number : ""}</span>{" "}{line}{"\n"}</span>;
		})}</pre>}
		{hidden > 0 && !tail && <div className="omp-empty-note">{hidden} more lines</div>}
	</div>;
}
export function DiffPreview({ text, expanded, lines = 40 }: { text: string; expanded: boolean; lines?: number }): ReactNode {
	if (!text) return null;
	const all = displayText(text).split("\n");
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
	const render = (part: readonly string[], offset: number): ReactNode => <pre className="omp-pre">{part.map((line, index) => {
		const numbered = /^([+\- ])(\d+)\|(.*)$/.exec(line);
		const className = /^(?:diff --git|---|\+\+\+|Index:)/.test(line) ? "omp-native-diff-file" : line.startsWith("+") ? "omp-native-diff-add" : line.startsWith("-") ? "omp-native-diff-remove" : line.startsWith("@@") ? "omp-native-diff-hunk" : "";
		return <span key={index + offset} className={className}>{numbered ? <><span className="omp-native-diff-sign">{numbered[1]}</span><span className="omp-native-line-number">{numbered[2]}</span>{numbered[3]}</> : line}{"\n"}</span>;
	})}</pre>;
	return <div className="omp-native-diff">{expanded ? <OutputLines all={all} render={render} /> : render(shown, 0)}{shown.length < all.length && <div className="omp-empty-note">{all.length - shown.length} more diff lines</div>}</div>;
}
export function Section({ title, link, children }: { title: string; link?: ExplicitFileLink; children: ReactNode }): ReactNode {
	return <section className="omp-tool-section"><div className="omp-tool-section-title"><FileLinkText text={title} link={link} /></div>{children}</section>;
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
		return <Section key={index} title={file.path || "Matches"}><pre className="omp-pre">{lines.map((line, row) => {
			const match = /^\s*(\*)?(\d+)(?:│|:)\s?(.*)$/.exec(line);
			return <span key={row} className={match?.[1] ? "omp-native-match" : ""}>{match ? <>{file.path ? <FileLink target={`${file.path}:${match[2]}`} proof={file.path}><span className="omp-native-line-number">{match[2]}</span></FileLink> : <span className="omp-native-line-number">{match[2]}</span>}{" "}{match[3]}</> : line}{"\n"}</span>;
		})}</pre>{lines.length < file.lines.length && <div className="omp-empty-note">{file.lines.length - lines.length} more lines</div>}</Section>;
	})}{files.length < all.length && <div className="omp-empty-note">{all.length - files.length} more files</div>}</>;
}
