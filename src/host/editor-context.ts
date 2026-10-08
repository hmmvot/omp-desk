/**
 * "OMP: Add Selection to Session" and "OMP: Add File to Session": the pure rules.
 *
 * What is sent is a **reference**, never file contents: OMP reads a mention itself, from the
 * session's working directory, when the prompt is submitted. Three facts about the installed
 * OMP (18.6.3, `pi-coding-agent src/utils/file-mentions.ts`) decide the text:
 *
 * - a mention is `@path` (or `@"quoted path"`), read after whitespace or an opening
 *   bracket/quote, resolved with `resolveReadPath(path, sessionCwd)` and, when it does not resolve
 *   to an existing file or directory, left as ordinary prose. There is **no line-range syntax**:
 *   `@src/a.ts:12-30` resolves to a file literally named `a.ts:12-30`, finds nothing, and the file
 *   is not read at all. A range therefore travels as a note beside the mention:
 *   `@src/a.ts [lines 12-30]`. Square brackets, not parentheses, on purpose: on submit the native
 *   TUI rewrites emoticons at a token boundary (`expandEmoticons`, `pi-tui/src/prompt/emoji-autocomplete.ts`),
 *   and `(line 8)` ends in the emoticon `8)`; no bracketed note contains one;
 * - the base is the session's cwd, not the VS Code workspace folder, which is why the path is
 *   made relative with {@link mentionPath} against the *target session's* cwd (and stays
 *   absolute, forward-slashed, when the file is outside it);
 * - the native TUI inserts a bracketed paste verbatim at the caret and never submits it, except
 *   that a paste above ten lines or 1,000 characters opens its large-paste menu, so one insertion
 *   is bounded by {@link MAX_INSERT_TEXT_LENGTH} and is a single line.
 *
 * No `vscode` import: everything here is exercised by plain `node --test`.
 *
 * Runner: `node --test src/host/editor-context.test.ts`
 */
import type { SessionItemState } from "../views/session-tree.ts";
import { MAX_INSERT_TEXT_LENGTH, mentionTokenForPath } from "../webview/messages.ts";
import { mentionPath } from "./file-mentions.ts";

/** Inclusive, one-based line numbers. */
export interface LineRange {
	readonly start: number;
	readonly end: number;
}

/** A VS Code position, minus the class. */
export interface PositionLike {
	readonly line: number;
	readonly character: number;
}

/**
 * The lines a selection covers. A selection that ends at column 0 of a later line stops at the end of
 * the previous one (a whole-line selection made with Shift+Down does not "include" the next line).
 */
export function selectionLines(start: PositionLike, end: PositionLike): LineRange {
	const first = Math.min(start.line, end.line);
	const last = Math.max(start.line, end.line);
	const lastCharacter = start.line <= end.line ? end.character : start.character;
	const covered = last > first && lastCharacter === 0 ? last - 1 : last;
	return { start: first + 1, end: covered + 1 };
}

/** Sort and merge overlapping or adjacent ranges. */
export function mergeRanges(ranges: readonly LineRange[]): LineRange[] {
	const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
	const merged: LineRange[] = [];
	for (const range of sorted) {
		const last = merged[merged.length - 1];
		if (last !== undefined && range.start <= last.end + 1) merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, range.end) };
		else merged.push({ start: range.start, end: range.end });
	}
	return merged;
}

/** `[line 7]`, `[lines 12-30]` or `[lines 12-30, 45]`; empty without ranges. */
export function lineNote(ranges: readonly LineRange[]): string {
	const merged = mergeRanges(ranges);
	if (merged.length === 0) return "";
	const parts = merged.map(range => (range.start === range.end ? `${range.start}` : `${range.start}-${range.end}`));
	const single = merged.length === 1 && merged[0]?.start === merged[0]?.end;
	return `[${single ? "line" : "lines"} ${parts.join(", ")}]`;
}

/** One file (or folder) to mention, and the lines of it the user selected, if any. */
export interface ReferenceSource {
	readonly fsPath: string;
	readonly ranges?: readonly LineRange[];
}

export type Refusal = { readonly ok: false; readonly reason: string };

/** Control characters, C1 included, would corrupt a prompt line or a bracketed paste. */
const UNSAFE_PATH = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * The reference text for one source against the target session's `cwd`.
 *
 * A path the mention grammar cannot represent (it holds both quote kinds, or a control character)
 * is refused: OMP would read it as prose, and an inserted mention that silently names nothing is
 * worse than none.
 */
export function formatReference(source: ReferenceSource, cwd: string): { readonly ok: true; readonly reference: string } | Refusal {
	const path = mentionPath(source.fsPath, cwd);
	if (path.length === 0 || UNSAFE_PATH.test(path)) return { ok: false, reason: `“${source.fsPath}” has a character a prompt cannot carry.` };
	if (path.includes('"') && path.includes("'")) return { ok: false, reason: `“${source.fsPath}” contains both quote kinds, which OMP's @ mentions cannot express.` };
	const note = lineNote(source.ranges ?? []);
	return { ok: true, reference: note.length === 0 ? mentionTokenForPath(path) : `${mentionTokenForPath(path)} ${note}` };
}

export interface Insertion {
	readonly ok: true;
	/** One line of references, space-separated, exactly what is inserted (before spacing). */
	readonly text: string;
	/** What the status bar names: the reference itself, or a count. */
	readonly summary: string;
	readonly count: number;
}

/**
 * Every source as one single-line insertion, in order, without duplicates. Refuses the whole
 * insertion rather than dropping part of it: the user asked for these files.
 */
export function composeInsertion(sources: readonly ReferenceSource[], cwd: string): Insertion | Refusal {
	const references: string[] = [];
	for (const source of sources) {
		const formatted = formatReference(source, cwd);
		if (!formatted.ok) return formatted;
		if (!references.includes(formatted.reference)) references.push(formatted.reference);
	}
	if (references.length === 0) return { ok: false, reason: "There is nothing to add." };
	const text = references.join(" ");
	// Leave room for the one space before and after that the insertion adds.
	if (text.length > MAX_INSERT_TEXT_LENGTH - 2) {
		return { ok: false, reason: `${references.length} references are too long to add at once (the limit is about ${MAX_INSERT_TEXT_LENGTH} characters). Add fewer files.` };
	}
	return { ok: true, text, summary: references.length === 1 ? (references[0] as string) : `${references.length} file references`, count: references.length };
}

/**
 * The native TUI's input as a paste: bracketed-paste markers around one line, with a space on each
 * side so the mention starts after whitespace (OMP ignores `@` glued to a word) and typing can
 * continue. There is deliberately no carriage return or newline: Enter would submit.
 *
 * `null` for text the TUI could not take as one small paste.
 */
export function bracketedPaste(text: string): string | null {
	// Checked before trimming: a trailing carriage return is exactly the Enter this must never send.
	if (UNSAFE_PATH.test(text)) return null;
	const body = text.trim();
	if (body.length === 0 || body.length > MAX_INSERT_TEXT_LENGTH - 2) return null;
	return `\u001b[200~ ${body} \u001b[201~`;
}

export type InsertAvailability = "live" | "resume";

/** Row states whose composer or TUI input is there to type into. */
const INSERTABLE: Partial<Record<SessionItemState, true>> = { running: true, working: true, background: true, unread: true, waiting: true };

/** Row states of a session that is not running but that opening starts. */
const RESUMABLE: Partial<Record<SessionItemState, true>> = { stopped: true, draft: true };

/**
 * Whether a session may be offered, and how it receives the text:
 *
 * - `live`: this window runs it and its input is free;
 * - `resume`: it is stopped but has an editor open here, and choosing it opens (starts) it first;
 * - `null`: never offered. A blocked or held-elsewhere row belongs to another writer; a row that
 *   needs the user's answer has its input covered by the question; a starting, stopping, checking or
 *   restoring row has no settled input.
 */
export function insertAvailability(state: SessionItemState, facts: { readonly running: boolean; readonly open: boolean }): InsertAvailability | null {
	if (facts.running && INSERTABLE[state] === true) return "live";
	if (!facts.running && facts.open && RESUMABLE[state] === true) return "resume";
	return null;
}

export interface SendCandidate {
	readonly tabId: string;
	/** The editor slot showing it, or `null` when no editor is open. */
	readonly slotId: string | null;
	readonly title: string;
	readonly cwd: string;
	readonly mode: "chat" | "terminal";
	readonly stateLabel: string;
	readonly availability: InsertAvailability;
}

/** The last path segment of a folder, for either separator. */
export function folderName(cwd: string): string {
	const trimmed = cwd.replace(/[\\/]+$/, "");
	const slash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
	return slash >= 0 ? trimmed.slice(slash + 1) || trimmed : trimmed;
}

export const MODE_LABEL: Record<"chat" | "terminal", string> = { chat: "Chat", terminal: "Terminal" };

/** `folder · Chat · Running`, the line a picker row shows under its title. */
export function candidateDescription(candidate: SendCandidate): string {
	return `${folderName(candidate.cwd)} · ${MODE_LABEL[candidate.mode]} · ${candidate.stateLabel}`;
}

/**
 * Most recently focused first, then the rest: running before stopped, then by title. A session the
 * recency list does not know (no editor focused yet, or closed since) is simply not ranked.
 */
export function orderCandidates(candidates: readonly SendCandidate[], recency: readonly string[]): SendCandidate[] {
	const rank = (candidate: SendCandidate): number => {
		const position = candidate.slotId === null ? -1 : recency.indexOf(candidate.slotId);
		return position < 0 ? Number.MAX_SAFE_INTEGER : position;
	};
	return [...candidates].sort((a, b) =>
		rank(a) - rank(b)
		|| (a.availability === b.availability ? 0 : a.availability === "live" ? -1 : 1)
		|| a.title.localeCompare(b.title));
}

/** The editors of this window in the order the user last focused them (newest first). */
export class EditorRecency {
	readonly #order: string[] = [];
	readonly #limit: number;

	constructor(limit = 64) {
		this.#limit = limit;
	}

	/** Note that this editor slot just took focus. */
	touch(slotId: string): void {
		const position = this.#order.indexOf(slotId);
		if (position === 0) return;
		if (position > 0) this.#order.splice(position, 1);
		this.#order.unshift(slotId);
		if (this.#order.length > this.#limit) this.#order.length = this.#limit;
	}

	/** Drop an editor that no longer exists. */
	forget(slotId: string): void {
		const position = this.#order.indexOf(slotId);
		if (position >= 0) this.#order.splice(position, 1);
	}

	order(): readonly string[] {
		return this.#order;
	}
}

/**
 * The folder a "New session" for these files starts in: the workspace folder holding the first file,
 * else the folder that directly holds it. The mention base is then that folder, so files under it
 * stay short `@src/a.ts` paths.
 */
export function newSessionFolder(firstFsPath: string, workspaceFolderPath: string | null): string {
	if (workspaceFolderPath !== null && workspaceFolderPath.length > 0) return workspaceFolderPath;
	const slash = Math.max(firstFsPath.lastIndexOf("/"), firstFsPath.lastIndexOf("\\"));
	if (slash < 0) return firstFsPath;
	const folder = firstFsPath.slice(0, slash);
	// A file at a drive or filesystem root: `C:` alone is drive-relative, `` is nothing.
	return folder.length === 0 || /^[A-Za-z]:$/.test(folder) ? firstFsPath.slice(0, slash + 1) : folder;
}

/** One row of the target picker, before it becomes a QuickPick item. */
export type PickerEntry =
	| { readonly kind: "session"; readonly candidate: SendCandidate }
	| { readonly kind: "new"; readonly folder: string; readonly label: string; readonly description: string };

/**
 * The picker's rows: every eligible session with the most recently focused editor first (and so
 * preselected), then "New session in <folder>". With no eligible session the new-session row is the
 * only one, so the picker never silently picks for the user and never comes up empty.
 */
export function pickerEntries(
	candidates: readonly SendCandidate[],
	recency: readonly string[],
	folder: string,
	defaultMode: "chat" | "terminal",
	folderListed: boolean,
): PickerEntry[] {
	const entries: PickerEntry[] = orderCandidates(candidates, recency).map(candidate => ({ kind: "session", candidate }));
	// Choosing the row for a folder the launcher does not show is the explicit act of pinning it; it says so.
	const listing = folderListed ? "" : " · pins this folder to the OMP launcher";
	entries.push({ kind: "new", folder, label: `New session in ${folderName(folder)}`, description: `${MODE_LABEL[defaultMode]} · ${folder}${listing}` });
	return entries;
}
