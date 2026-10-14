/**
 * The notices OMP appends to a tool result's text (and keeps in `details`), read apart from the output they
 * follow: a pretty JSON result is not valid JSON while `Wall time: …` trails it, and a status fact is not
 * output. Pure and DOM-free; `ToolCard` shows them as the head gist (exit, duration) and one footer line.
 */
import { isRecord } from "../shared/guards.ts";

export type ToolNotice =
	| { readonly kind: "wall"; readonly ms: number }
	| { readonly kind: "exit"; readonly code: number }
	| { readonly kind: "timeout"; readonly seconds: number }
	| { readonly kind: "truncated"; readonly text: string; readonly artifact?: string }
	| { readonly kind: "columns"; readonly limit: number; readonly unit: "bytes" | "chars"; readonly artifact?: string }
	| { readonly kind: "raw"; readonly artifact: string }
	| { readonly kind: "background"; readonly job: string };

/** Notices are always the last thing in the text; only this much of its end is read, so the cost is bounded by it, not by the output. */
const TAIL_CHARS = 4096;
const MAX_PASSES = 10;

type TailRule = readonly [pattern: RegExp, make: (match: RegExpExecArray) => ToolNotice];
const RULES: readonly TailRule[] = [
	[/\n*Wall time: (\d+(?:\.\d+)?) seconds[ \t]*\n*$/, m => ({ kind: "wall", ms: Math.round(Number(m[1]) * 1000) })],
	[/\n*Command exited with code (\d+)[ \t]*\n*$/, m => ({ kind: "exit", code: Number(m[1]) })],
	[/\n*\[Command timed out after (\d+) seconds\][ \t]*\n*$/, m => ({ kind: "timeout", seconds: Number(m[1]) })],
	[/\n*\[Showing lines ([^\]\n]*?)(?:\. Read artifact:\/\/(\d+) for full output)?\][ \t]*\n*$/, m => ({ kind: "truncated", text: `Showing lines ${m[1]}`, ...(m[2] ? { artifact: m[2] } : {}) })],
	[/\n*\[Some lines truncated to (\d+) (bytes|chars)(?:\. Read artifact:\/\/(\d+) for full output)?\][ \t]*\n*$/, m => ({ kind: "columns", limit: Number(m[1]), unit: m[2] as "bytes" | "chars", ...(m[3] ? { artifact: m[3] } : {}) })],
	[/\n*\[raw output: artifact:\/\/(\d+)\][ \t]*\n*$/, m => ({ kind: "raw", artifact: m[1]! })],
];
const BACKGROUND = /\n*Backgrounded as job ([^\s;(]+)(?: \([^)\n]*\))?; its output is injected into the conversation[^]*$/;

/**
 * `text` without the notices at its end, and the notices, in the order they appear in the text. Anything the
 * output itself says in the middle of its body is left alone.
 */
export function splitToolNotices(text: string): { body: string; notices: readonly ToolNotice[] } {
	let body = text;
	const found: ToolNotice[] = [];
	for (let pass = 0; pass < MAX_PASSES; pass++) {
		const start = Math.max(0, body.length - TAIL_CHARS);
		const tail = body.slice(start);
		let matched = false;
		const background = BACKGROUND.exec(tail);
		if (background) {
			found.unshift({ kind: "background", job: background[1]! });
			body = body.slice(0, start + background.index);
			matched = true;
		}
		for (const [pattern, make] of RULES) {
			const current = body.slice(Math.max(0, body.length - TAIL_CHARS));
			const match = pattern.exec(current);
			if (!match) continue;
			found.unshift(make(match));
			body = body.slice(0, body.length - current.length + match.index);
			matched = true;
		}
		if (!matched) break;
	}
	return { body: body.replace(/\s+$/, ""), notices: found };
}

/** One piece of the footer line: plain text, a warning, or a link to an artifact (`artifact` is its number). */
export interface FooterPart {
	readonly tone: "plain" | "warn";
	readonly text: string;
	readonly artifact?: string;
}

const scalar = (value: unknown): string => typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : "";
const record = (value: unknown): Record<string, unknown> => isRecord(value) ? value : {};

/** The truncation, limit and artifact facts OMP keeps in `details`, as footer parts (the artifact ones carry the number). */
export function detailFooterParts(details: Record<string, unknown>): FooterPart[] {
	const meta = record(details.meta);
	const truncation = record(meta.truncation ?? details.truncation);
	const limits = record(meta.limits ?? details.limits);
	const parts: FooterPart[] = [];
	if (typeof truncation.totalLines === "number") {
		const range = record(truncation.shownRange), head = record(truncation.headRange), tail = record(truncation.tailRange);
		let text: string;
		if (truncation.direction === "middle") {
			const ranges = [typeof head.start === "number" && typeof head.end === "number" ? `${head.start}–${head.end}` : "", typeof tail.start === "number" && typeof tail.end === "number" ? `${tail.start}–${tail.end}` : ""].filter(Boolean).join(" and ");
			const elidedLines = typeof truncation.elidedLines === "number" ? truncation.elidedLines : typeof truncation.outputLines === "number" ? Math.max(0, truncation.totalLines - truncation.outputLines) : undefined;
			const elidedBytes = typeof truncation.elidedBytes === "number" ? truncation.elidedBytes : typeof truncation.totalBytes === "number" && typeof truncation.outputBytes === "number" ? Math.max(0, truncation.totalBytes - truncation.outputBytes) : undefined;
			text = ranges ? `Showing lines ${ranges} of ${truncation.totalLines}; ${elidedLines === undefined ? "middle" : `${elidedLines.toLocaleString("en-US")} middle lines`}${elidedBytes === undefined ? "" : ` (${elidedBytes} bytes)`} elided` : typeof elidedBytes === "number" && elidedBytes > 0 ? `Showing head and tail bytes of ${truncation.totalLines} lines; ${elidedBytes} bytes elided` : `Showing ${scalar(truncation.outputLines)} of ${truncation.totalLines} lines; middle elided`;
		} else if (truncation.partialLine === true) {
			text = `Showing line ${typeof range.start === "number" ? range.start : 1} (partial, ${scalar(truncation.outputBytes)} of ${scalar(truncation.totalBytes)} bytes) of ${truncation.totalLines}`;
		} else {
			text = typeof range.start === "number" && typeof range.end === "number" ? `Showing lines ${range.start}–${range.end} of ${truncation.totalLines}` : `Showing ${scalar(truncation.outputLines)} of ${truncation.totalLines} lines`;
		}
		parts.push({ tone: "warn", text: `Output truncated · ${text}` });
		if (truncation.direction !== "middle" && truncation.partialLine !== true && truncation.truncatedBy === "bytes" && typeof (truncation.maxBytes ?? truncation.outputBytes) === "number") parts.push({ tone: "plain", text: `${scalar(truncation.maxBytes ?? truncation.outputBytes)} bytes limit` });
		if (truncation.partialLine !== true && typeof truncation.nextOffset === "number") parts.push({ tone: "plain", text: `use :${truncation.nextOffset} to continue` });
	}
	const artifact = scalar(truncation.artifactId ?? meta.artifactId);
	if (artifact) parts.push({ tone: "plain", text: record(meta.source).type === "report" ? `full report (${scalar(record(meta.source).value)})` : "full output", artifact });
	const artifactError = meta.artifactError ?? details.artifactError;
	if (artifactError === "open" || artifactError === "write" || artifactError === "flush" || artifactError === "end") parts.push({ tone: "warn", text: `Full output was not saved completely (artifact ${artifactError} failed)` });
	for (const key of ["matchLimit", "resultLimit", "headLimit"]) {
		const limit = record(limits[key]);
		if (typeof limit.reached === "number") parts.push({ tone: "warn", text: `${limit.reached} ${key === "matchLimit" ? "matches" : "results"} limit reached${typeof limit.suggestion === "number" ? `; use limit=${limit.suggestion} for more` : ""}` });
	}
	const column = record(limits.columnTruncated);
	if (typeof column.maxColumn === "number") {
		parts.push({ tone: "warn", text: `Some lines truncated to ${column.maxColumn} ${column.unit === "bytes" ? "bytes" : "chars"}` });
		if (scalar(column.artifactId)) parts.push({ tone: "plain", text: "full output", artifact: scalar(column.artifactId) });
	}
	return parts;
}

/**
 * The one footer line of a result: what `details` says (preferred where both name the same fact) and what only the
 * text said. Exit code and wall time are not here; the head gist and the output bar carry them.
 */
export function footerParts(notices: readonly ToolNotice[], details: Record<string, unknown>): FooterPart[] {
	const parts = detailFooterParts(details);
	const hasTruncation = parts.some(part => part.text.startsWith("Output truncated"));
	const hasColumns = parts.some(part => part.text.startsWith("Some lines truncated"));
	const artifacts = new Set(parts.flatMap(part => part.artifact === undefined ? [] : [part.artifact]));
	const add = (part: FooterPart): void => {
		if (part.artifact !== undefined) { if (artifacts.has(part.artifact)) return; artifacts.add(part.artifact); }
		parts.push(part);
	};
	for (const notice of notices) {
		switch (notice.kind) {
			case "truncated":
				if (!hasTruncation) parts.push({ tone: "warn", text: `Output truncated · ${notice.text}` });
				if (notice.artifact !== undefined) add({ tone: "plain", text: "full output", artifact: notice.artifact });
				break;
			case "columns":
				if (!hasColumns) parts.push({ tone: "warn", text: `Some lines cut to ${notice.limit} ${notice.unit}` });
				if (notice.artifact !== undefined) add({ tone: "plain", text: "full output", artifact: notice.artifact });
				break;
			case "raw": add({ tone: "plain", text: "unfiltered output", artifact: notice.artifact }); break;
			case "timeout": parts.push({ tone: "warn", text: `timed out after ${notice.seconds} s` }); break;
			case "background": parts.push({ tone: "plain", text: `running in background as ${notice.job}; the result is delivered later` }); break;
			case "wall": case "exit": break;
		}
	}
	return parts;
}

/** The exit code a result reports: `details.exitCode` first, else the text notice. */
export function exitCodeOf(details: Record<string, unknown>, notices: readonly ToolNotice[]): number | undefined {
	if (typeof details.exitCode === "number") return details.exitCode;
	const notice = notices.find(item => item.kind === "exit");
	return notice?.kind === "exit" ? notice.code : undefined;
}

/** The wall time in milliseconds: `details.wallTimeMs` first, else the text notice. */
export function wallTimeOf(details: Record<string, unknown>, notices: readonly ToolNotice[]): number | undefined {
	if (typeof details.wallTimeMs === "number" && Number.isFinite(details.wallTimeMs)) return details.wallTimeMs;
	const notice = notices.find(item => item.kind === "wall");
	return notice?.kind === "wall" ? notice.ms : undefined;
}

/** Whether the result says the command was backgrounded: `details.async` running, or the text notice. */
export function backgroundJobOf(details: Record<string, unknown>, notices: readonly ToolNotice[]): string | undefined {
	const async = record(details.async);
	if (async.state === "running" && typeof async.jobId === "string") return async.jobId;
	const notice = notices.find(item => item.kind === "background");
	return notice?.kind === "background" ? notice.job : undefined;
}
