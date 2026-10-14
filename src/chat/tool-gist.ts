/**
 * The result gist of a tool call: the few facts a closed row says after its target (`exit 2 · 11 lines · 205 ms`),
 * so a settled call answers "did it work, how big, how long" without being opened. Pure and DOM-free, built from
 * the call's data only (never from a renderer), so a row reads the same closed and open.
 *
 * Silent success: an exit code of 0, an empty result and a duration that is only derived and short are not said.
 */
import { isRecord } from "../shared/guards.ts";
import { backgroundJobOf, exitCodeOf, wallTimeOf, type ToolNotice } from "./tool-notices.ts";

export interface GistPart {
	readonly text: string;
	readonly tone: "plain" | "err" | "warn";
	/** Dropped first when the row is narrow. */
	readonly optional?: true;
}

export interface GistInput {
	/** The tool after routing (`xd://` devices resolved), so a wrapped grep is a grep. */
	readonly name: string;
	readonly args: Record<string, unknown>;
	readonly details: Record<string, unknown>;
	/** The result text with OMP's notices removed. */
	readonly body: string;
	readonly notices: readonly ToolNotice[];
	readonly failed: boolean;
	/** A result (not a partial one) has arrived. */
	readonly settled: boolean;
	/** The assistant message's timestamp and the result's: only their difference is used, and marked `≈`. */
	readonly startedAt?: number;
	readonly endedAt?: number;
	/** How long the call ran, measured by a page that watched it run: exact, so it carries no `≈`. */
	readonly observedMs?: number;
}

/** A derived duration is shown only above this; shorter ones are mostly the model's own time. */
export const DERIVED_DURATION_FLOOR_MS = 1500;

const record = (value: unknown): Record<string, unknown> => isRecord(value) ? value : {};
const records = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.filter(isRecord) : [];
const num = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const text = (value: unknown): string => typeof value === "string" ? value : "";

function plural(count: number, word: string, many = `${word}s`): string {
	return `${count.toLocaleString("en-US")} ${count === 1 ? word : many}`;
}

/** `205 ms`, `4.67 s`, `41.3 s`, `2m 5s`. */
export function formatGistDuration(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)} ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
	return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/** The number of lines of a trimmed text; 0 for none. */
export function countLines(body: string): number {
	if (body.trim() === "") return 0;
	let count = 1;
	for (let at = body.indexOf("\n"); at !== -1; at = body.indexOf("\n", at + 1)) count++;
	return count;
}

export function toolGist(input: GistInput): readonly GistPart[] {
	const { name, args, details, body, notices } = input;
	const parts: GistPart[] = [];
	const say = (value: string, tone: GistPart["tone"] = "plain", optional = false): void => { parts.push(optional ? { text: value, tone, optional } : { text: value, tone }); };
	let exactMs: number | undefined;
	const lines = countLines(body);
	switch (name) {
		case "bash": {
			const exit = exitCodeOf(details, notices);
			if (exit !== undefined && exit !== 0) say(`exit ${exit}`, "err");
			if (details.timedOut === true || notices.some(notice => notice.kind === "timeout")) say("timed out", "warn");
			if (backgroundJobOf(details, notices) !== undefined) say("background");
			if (lines > 0) say(plural(lines, "line"), "plain", true);
			exactMs = wallTimeOf(details, notices);
			if (exactMs !== undefined) say(formatGistDuration(exactMs));
			break;
		}
		case "read": {
			const path = text(args.path ?? args.file_path);
			if (details.proc !== undefined || details.cfg !== undefined || /^(?:proc|cfg):\/\//i.test(path)) break;
			if (details.isDirectory === true) { say(plural(lines, "entry", "entries")); break; }
			if (typeof details.fileSize === "number" && text(details.mediaPath) !== "") { say(`${(details.fileSize / 1024).toFixed(1)} KB`); break; }
			const total = num(details.totalLines);
			if (lines > 0 || total !== undefined) say(plural(total ?? lines, "line"), "plain", true);
			if (details.truncated === true || record(details.truncation).truncated === true) say("truncated", "warn");
			break;
		}
		case "write": {
			const path = text(args.path ?? args.file_path);
			if (/^(?:agent|proc|cfg|xd):\/\//i.test(path) || details.message !== undefined || details.proc !== undefined || details.cfg !== undefined) break;
			const content = typeof args.content === "string" ? args.content : "";
			if (content !== "") say(plural(content.split("\n").length, "line"), "plain", true);
			break;
		}
		case "grep": case "ast_grep": {
			const matches = num(details.matchCount), files = num(details.fileCount);
			if (matches !== undefined) say(plural(matches, "match", "matches"));
			if (files !== undefined && files > 0) say(plural(files, "file"), "plain", true);
			if (details.truncated === true || details.limitReached === true) say("truncated", "warn");
			break;
		}
		case "glob": {
			const files = Array.isArray(details.files) ? details.files.length : num(details.fileCount);
			if (files !== undefined) say(plural(files, "file"));
			if (details.truncated === true || details.resultLimitReached === true) say("limit reached", "warn");
			break;
		}
		case "find": {
			if (Array.isArray(details.hits)) say(plural(details.hits.length, "hit"));
			const cost = num(record(details.stats).cost);
			if (cost !== undefined) say(`$${cost.toFixed(4)}`, "plain", true);
			break;
		}
		case "eval": {
			const cells = records(details.cells);
			const first = cells[0] ?? {};
			const language = text(first.language) || text(details.language);
			if (language) say(language === "python" ? "py" : language === "javascript" || language === "js" ? "js" : language, "plain", true);
			const exit = num(first.exitCode);
			if (exit !== undefined && exit !== 0) say(`exit ${exit}`, "err");
			exactMs = num(first.durationMs);
			if (exactMs !== undefined) say(formatGistDuration(exactMs));
			if (cells.length > 1) say(`${cells.length} cells`);
			break;
		}
		case "task": {
			const rows = records(details.progress).length ? records(details.progress) : records(details.results);
			const count = rows.length || (Array.isArray(args.tasks) ? args.tasks.filter(isRecord).length : 0) || 1;
			say(plural(count, "agent"));
			if (record(details.async).state !== undefined) say("background");
			break;
		}
		case "wait": {
			const jobs = records(details.jobs).length ? records(details.jobs) : isRecord(details.job) ? [details.job] : [];
			if (jobs.length === 0) { if (details.interrupted === true || input.failed) say("interrupted", "warn"); break; }
			const settled = jobs.filter(job => job.status !== "running");
			say(settled.length > 0 ? `${plural(settled.length, "job")} settled` : plural(jobs.length, "job"));
			exactMs = num((settled[0] ?? jobs[0])?.durationMs);
			if (exactMs !== undefined) say(formatGistDuration(exactMs));
			break;
		}
		case "web_search": {
			const response = record(details.response);
			if (text(response.provider)) say(text(response.provider), "plain", true);
			if (Array.isArray(response.sources)) say(plural(response.sources.length, "source"));
			break;
		}
		case "ask": {
			const count = records(details.results).length || (details.question !== undefined ? 1 : 0);
			if (count > 0) say(plural(count, "question"));
			break;
		}
		case "edit": case "apply_patch": case "ast_edit": case "todo": case "lsp": case "debug": break;
		default: {
			if (input.failed || !input.settled) break;
			const trimmed = body.trim();
			if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) say("JSON");
			else if (lines > 0) say(plural(lines, "line"), "plain", true);
		}
	}
	if (exactMs === undefined && input.settled) {
		if (input.observedMs !== undefined) {
			if (input.observedMs > DERIVED_DURATION_FLOOR_MS) say(formatGistDuration(input.observedMs), "plain", true);
		} else if (input.startedAt !== undefined && input.endedAt !== undefined) {
			const derived = input.endedAt - input.startedAt;
			if (derived > DERIVED_DURATION_FLOOR_MS) say(`≈ ${formatGistDuration(derived)}`, "plain", true);
		}
	}
	if (input.failed && !parts.some(part => part.tone === "err")) parts.unshift({ text: "failed", tone: "err" });
	return parts;
}
