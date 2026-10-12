import { isRecord } from "../../guards.ts";
import { stripAnsi } from "../../chat/ansi.ts";
import type { JournalFacts } from "../session-cost.ts";

/**
 * Pure readers of what installed OMP reports about a session's context (ADR-0063). Every number
 * here is OMP's own; nothing is estimated. Each parser answers `null` rather than a partial guess.
 */

/** One deep read of the session: structured, read-only sources only. Each part is `null` when its source did not answer. */
export interface ContextRead {
	readonly at: number;
	/** `get_state.autoCompactionEnabled`; not part of the Chat state, so it changes only at a deep read. */
	readonly autoCompaction: boolean | null;
	readonly stats: SessionStatsFacts | null;
	readonly files: PromptContextFiles | null;
	readonly journal: JournalFacts | null;
}

/** OMP's `/context` report as one explicit request read it (ADR-0063). */
export interface ContextReportRead {
	readonly at: number;
	/** The tokens `model.state` showed at the instant the report frame arrived: a later, different figure means the context has changed since. */
	readonly usageTokensAtRead: number | null;
	readonly report: ContextReport;
}

// --- get_session_stats --------------------------------------------------------------------------

/** The message counts and billed tokens of the live context window (`get_session_stats`). */
export interface SessionStatsFacts {
	readonly userMessages: number;
	readonly assistantMessages: number;
	readonly toolCalls: number;
	readonly toolResults: number;
	readonly totalMessages: number;
	readonly tokens: { readonly input: number; readonly output: number; readonly reasoning: number; readonly cacheRead: number; readonly cacheWrite: number };
	readonly premiumRequests: number;
}

function count(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** `null` unless every field the view shows is a non-negative integer. */
export function parseSessionStats(data: unknown): SessionStatsFacts | null {
	if (!isRecord(data) || !isRecord(data.tokens)) return null;
	const tokens = data.tokens;
	const values = [data.userMessages, data.assistantMessages, data.toolCalls, data.toolResults, data.totalMessages, tokens.input, tokens.output,
		tokens.reasoning, tokens.cacheRead, tokens.cacheWrite].map(count);
	// A premium request is charged at the model's multiplier (0.25, 0.33 …), so it is a number, not a count.
	const premium = data.premiumRequests ?? 0;
	if (values.some(value => value === null) || typeof premium !== "number" || !Number.isFinite(premium) || premium < 0) return null;
	const [userMessages, assistantMessages, toolCalls, toolResults, totalMessages, input, output, reasoning, cacheRead, cacheWrite] = values as number[];
	return { userMessages: userMessages!, assistantMessages: assistantMessages!, toolCalls: toolCalls!, toolResults: toolResults!, totalMessages: totalMessages!,
		tokens: { input: input!, output: output!, reasoning: reasoning!, cacheRead: cacheRead!, cacheWrite: cacheWrite! }, premiumRequests: premium };
}

// --- /context report ----------------------------------------------------------------------------

export interface ContextReportRow { readonly label: string; readonly tokens: number }

/**
 * OMP's `/context` text (`slash-commands/helpers/context-report.ts`): the window, the used percentage OMP prints, one row per
 * non-zero category, and any line the parser does not know (the Snapcompact estimate), kept verbatim.
 */
export interface ContextReport {
	/** `null` when OMP reported that it has no usage ("no model is selected") or only the minimal form without a window. */
	readonly contextWindow: number | null;
	readonly usedPercent: number | null;
	readonly rows: readonly ContextReportRow[];
	readonly notes: readonly string[];
	/** The text OMP printed when it had no breakdown; the view shows it as the reason. */
	readonly unavailable: string | null;
}

const HEADER = /^Context window: (\d+) tokens \((\d+)% used\)$/;
const ROW = /^ {2}(\S.*?)\s+\[[^\]]*\]\s*\S*\s+(\d+) tokens$/;
const UNAVAILABLE = /^Context usage is unavailable[^\n]*$/;
const MINIMAL = /^Context\nWindow: (\d+)\nUsed: (\d+)$/;
const MAX_REPORT_CHARS = 8_192;
/** OMP colors each bar cell run, so the styled report is several times its plain length. */
const MAX_RAW_REPORT_CHARS = 64 * 1024;
const MAX_NOTES = 12;
const MAX_NOTE_CHARS = 240;

/** Whether `text` begins like a report OMP's `/context` prints (styling aside); the capture in `RpcSession` takes only such a frame. */
export function isContextReportText(text: string): boolean {
	const plain = stripAnsi(text, MAX_RAW_REPORT_CHARS);
	return plain.startsWith("Context window:") || plain.startsWith("Context usage is unavailable") || plain.startsWith("Context\nWindow:");
}

/** The written-out form of a label OMP pads and truncates to sixteen characters. */
const LABELS: Readonly<Record<string, string>> = { "Auto-compact buf": "Auto-compact buffer" };

/** `null` when `text` is not a recognizable report. */
export function parseContextReport(text: string): ContextReport | null {
	if (text.length === 0 || text.length > MAX_RAW_REPORT_CHARS) return null;
	const plain = stripAnsi(text, MAX_RAW_REPORT_CHARS).trim();
	if (plain.length > MAX_REPORT_CHARS || !isContextReportText(plain)) return null;
	if (UNAVAILABLE.test(plain)) return { contextWindow: null, usedPercent: null, rows: [], notes: [], unavailable: plain };
	const minimal = MINIMAL.exec(plain);
	if (minimal !== null) {
		const window = Number(minimal[1]);
		return { contextWindow: window > 0 ? window : null, usedPercent: null, rows: [{ label: "Used", tokens: Number(minimal[2]) }], notes: [], unavailable: null };
	}
	const lines = plain.split("\n");
	const header = HEADER.exec(lines[0]!);
	if (header === null) return null;
	const rows: ContextReportRow[] = [];
	const notes: string[] = [];
	for (const line of lines.slice(1)) {
		if (line.trim().length === 0) continue;
		const row = ROW.exec(line);
		if (row !== null) rows.push({ label: LABELS[row[1]!] ?? row[1]!, tokens: Number(row[2]) });
		else if (notes.length < MAX_NOTES) notes.push(line.trim().slice(0, MAX_NOTE_CHARS));
	}
	return { contextWindow: Number(header[1]), usedPercent: Number(header[2]), rows, notes, unavailable: null };
}

// --- context files in the system prompt ---------------------------------------------------------

export interface ContextFile {
	/** Absolute path as OMP printed it into the prompt. */
	readonly path: string;
	/** Characters of the file's content in the prompt; OMP reports no per-file tokens. */
	readonly chars: number;
}
export interface PromptContextFiles {
	/** The files OMP put in the prompt (`<repo-rules>`). */
	readonly files: readonly ContextFile[];
	/** Directories' rule files OMP asks the agent to read before changing them (`<dir-context>`). */
	readonly onDemand: readonly string[];
}

const MAX_PROMPT_CHARS = 4 * 1024 * 1024;
const MAX_FILES = 64;
const MAX_PATH_CHARS = 1_024;
const REPO_OPEN = "<repo-rules>\nMUST follow these context files for all tasks:\n";
const REPO_CLOSE = "</repo-rules>";
const FILE_OPEN = "<file path=\"";
const FILE_CLOSE_THEN_FILE = `\n</file>\n${FILE_OPEN}`;
const FILE_CLOSE_THEN_END = `\n</file>\n${REPO_CLOSE}`;
const DIR_OPEN = "<dir-context>\n";
const DIR_HEADER_END = "MUST read:\n";
const DIR_CLOSE = "\n</dir-context>";

/** A Windows absolute path (drive or UNC) without control characters, as the view will open it. */
export function isAbsoluteWindowsPath(value: string): boolean {
	if (value.length === 0 || value.length > MAX_PATH_CHARS || /[\u0000-\u001f"<>|?*]/.test(value)) return false;
	return /^[A-Za-z]:[\\/][^\\/]/.test(value) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(value);
}

/**
 * The context files OMP rendered into its system prompt (`prompts/system/project-prompt.md`), read from the prompt text
 * `get_state` returns. Strict on shape: blocks are read in order and a block ends at the first `</file>` that is followed
 * by the next `<file path=` or the section end, so a file whose content contains those exact markers can be split wrongly
 * (documented risk). Paths that are not absolute Windows paths are dropped. `null` when the prompt carries no sections
 * at all (it was not read) is the caller's concern; an empty result means the prompt listed none.
 */
export function extractContextFiles(systemPrompt: readonly string[]): PromptContextFiles {
	const files: ContextFile[] = [];
	const onDemand: string[] = [];
	let scanned = 0;
	for (const block of systemPrompt) {
		scanned += block.length;
		if (scanned > MAX_PROMPT_CHARS) break;
		readRepoRules(block, files);
		readDirContext(block, onDemand);
	}
	return { files, onDemand };
}

function readRepoRules(block: string, files: ContextFile[]): void {
	const start = block.indexOf(REPO_OPEN);
	if (start < 0) return;
	let at = start + REPO_OPEN.length;
	while (files.length < MAX_FILES && block.startsWith(FILE_OPEN, at)) {
		const pathStart = at + FILE_OPEN.length;
		const pathEnd = block.indexOf("\">\n", pathStart);
		if (pathEnd < 0) return;
		const path = block.slice(pathStart, pathEnd);
		const contentStart = pathEnd + 3;
		const next = block.indexOf(FILE_CLOSE_THEN_FILE, contentStart);
		const end = block.indexOf(FILE_CLOSE_THEN_END, contentStart);
		const last = next < 0 || (end >= 0 && end < next);
		const contentEnd = last ? end : next;
		if (contentEnd < 0) return;
		if (isAbsoluteWindowsPath(path)) files.push({ path, chars: Math.max(0, contentEnd - contentStart) });
		if (last) return;
		at = contentEnd + 1 + "</file>\n".length;
	}
}

function readDirContext(block: string, paths: string[]): void {
	const start = block.indexOf(DIR_OPEN);
	if (start < 0) return;
	const end = block.indexOf(DIR_CLOSE, start);
	if (end < 0) return;
	const body = block.slice(start + DIR_OPEN.length, end);
	const list = body.indexOf(DIR_HEADER_END);
	if (list < 0) return;
	for (const line of body.slice(list + DIR_HEADER_END.length).split("\n")) {
		if (paths.length >= MAX_FILES) return;
		if (!line.startsWith("- ")) continue;
		const path = line.slice(2).trim();
		if (isAbsoluteWindowsPath(path)) paths.push(path);
	}
}
