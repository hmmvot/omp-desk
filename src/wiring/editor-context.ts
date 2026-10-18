/**
 * "OMP Desk: Add File to Session" and "OMP Desk: Quote Selection to Session" (the quote of a selection, or the reference to the
 * caret's line when nothing is selected): the pure rules.
 *
 * What Add File sends is a **reference**, never file contents: OMP reads a mention itself, from the session's working directory,
 * when the prompt is submitted. Three facts about the installed OMP (18.6.3, `pi-coding-agent src/utils/file-mentions.ts`) decide
 * the text:
 *
 * - a mention is `@path` (or `@"quoted path"`), read after whitespace or an opening bracket/quote, resolved with
 *   `resolveReadPath(path, sessionCwd)` and, when it does not resolve to an existing file or directory, left as ordinary prose.
 *   There is **no line-range syntax**: `@src/a.ts:12-30` resolves to a file literally named `a.ts:12-30`, finds nothing, and the
 *   file is not read at all. That is why a quote and a line reference name their location as inline code (`src/a.ts:42`), never
 *   as a mention;
 * - the base is the session's cwd, not the VS Code workspace folder, which is why the path is made relative with
 *   {@link mentionPath} against the *target session's* cwd (and stays absolute, forward-slashed, when the file is outside it);
 * - the native TUI inserts a bracketed paste verbatim at the caret and never submits it, except that a paste above ten lines or
 *   1,000 characters opens its large-paste menu, so one insertion is bounded by {@link MAX_INSERT_TEXT_LENGTH} and is a single line.
 *
 * No `vscode` import: everything here is exercised by plain `node --test`.
 *
 * Runner: `node --test src/wiring/editor-context.test.ts`
 */
import type { SessionItemState } from "../views/session-tree.ts";
import { codeSpan } from "../shared/code-span.ts";
import { MAX_EDITOR_QUOTES, MAX_INSERT_TEXT_LENGTH, MAX_QUOTE_LOCATION_LENGTH, mentionTokenForPath } from "../protocol/messages.ts";
import type { GuestEditorQuote } from "../protocol/messages.ts";
import { quoteSizeRefusal } from "../shared/quote-limit.ts";
import { quoteLocationText } from "../shared/quote-location.ts";
import { mentionPath } from "../host/file-mentions.ts";
import { UNSAFE_PATH } from "../host/bracketed-paste.ts";

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

/** One file (or folder) to mention. */
export interface ReferenceSource {
	readonly fsPath: string;
}

export type Refusal = { readonly ok: false; readonly reason: string };

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
	return { ok: true, reference: mentionTokenForPath(path) };
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

/** One selection of a text editor, as the host reads it: its two positions and the exact text between them. */
export interface EditorSelection {
	readonly start: PositionLike;
	readonly end: PositionLike;
	readonly text: string;
}

/**
 * The document a quote is taken from. `fsPath` is `null` when it has no path OMP can open (untitled, or a scheme other than `file`
 * and the `git` documents of a diff). `version` is `null` for the file on disk and the words naming the version otherwise (a side of
 * a diff that is a Git revision: `index`, `HEAD (3f2a9c1)`; see `quote-revision.ts`); the lines of a quote are lines of that version.
 */
export interface EditorQuoteSource {
	readonly fsPath: string | null;
	readonly version: string | null;
	readonly fileName: string;
	readonly languageId: string;
	readonly selections: readonly EditorSelection[];
}

/** `src/app.ts:42` for one line, `src/app.ts:42-50` for several, `src/app.ts:42-50 @ HEAD (3f2a9c1)` for a Git revision: the path of {@link formatReference}'s rule (relative inside `cwd`, else absolute). */
export function quoteLocation(fsPath: string, cwd: string, lines: LineRange, version: string | null = null): { readonly ok: true; readonly location: string } | Refusal {
	const path = mentionPath(fsPath, cwd);
	if (path.length === 0 || UNSAFE_PATH.test(path)) return { ok: false, reason: `“${fsPath}” has a character a message cannot carry.` };
	const location = quoteLocationText(path, lines.start, lines.end, version);
	if (location.length > MAX_QUOTE_LOCATION_LENGTH) return { ok: false, reason: `The path of “${fsPath}” is too long to quote.` };
	return { ok: true, location };
}

export interface EditorQuotes {
	readonly ok: true;
	readonly quotes: GuestEditorQuote[];
	/** What the status bar names: the one location, or a count. */
	readonly summary: string;
}

/**
 * Every non-empty selection of one editor as its own quote, in document order, for the target session's `cwd`.
 *
 * A selection ending at column 0 of a later line does not include that line (as for {@link selectionLines}); its text loses the
 * line break that column 0 leaves behind. Line ends are `\n`. A whitespace-only selection is no selection. The size limit is the
 * Chat quote's (`MAX_QUOTE_CHARACTERS`, counted over all the selections of one gesture) and is refused with the size; a control
 * character other than a tab or a line end is refused, because a draft carrying one cannot be handed to a replacement editor.
 * Nothing is dropped silently: either every selection is quoted or the whole gesture is refused with the reason.
 */
export function composeEditorQuotes(source: EditorQuoteSource, cwd: string): EditorQuotes | Refusal {
	const ordered = [...source.selections].sort((a, b) => a.start.line - b.start.line || a.start.character - b.start.character);
	const quotes: GuestEditorQuote[] = [];
	const locations: string[] = [];
	let total = 0;
	let last: EditorSelection | undefined;
	for (const selection of ordered) {
		if (last !== undefined && last.start.line === selection.start.line && last.start.character === selection.start.character && last.end.line === selection.end.line && last.end.character === selection.end.character) continue;
		last = selection;
		const text = selection.text.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
		if (text.trim().length === 0) continue;
		if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(text)) return { ok: false, reason: "The selection holds a control character that a message cannot carry." };
		total += text.length;
		let location: string | null = null;
		if (source.fsPath !== null) {
			const located = quoteLocation(source.fsPath, cwd, selectionLines(selection.start, selection.end), source.version);
			if (!located.ok) return located;
			location = located.location;
			locations.push(location);
		}
		quotes.push({ location, fileName: source.fileName, languageId: source.languageId, text });
	}
	if (quotes.length === 0) return { ok: false, reason: "Select some text first." };
	if (quotes.length > MAX_EDITOR_QUOTES) return { ok: false, reason: `Quote takes at most ${MAX_EDITOR_QUOTES} selections at once.` };
	const tooLong = quoteSizeRefusal(total);
	if (tooLong !== null) return { ok: false, reason: tooLong };
	return { ok: true, quotes, summary: quotes.length === 1 ? (locations[0] ?? `${source.fileName || "the selection"}`) : `${quotes.length} selections` };
}

/**
 * The document and line `Alt+Q` points at when nothing is selected: the primary caret's line of the active editor. `fsPath` and
 * `version` are the quote's ({@link EditorQuoteSource}): `null` when the document has no location, and the words naming a Git
 * version for a side of a diff; `line` is one-based.
 */
export interface LineReferenceSource {
	readonly fsPath: string | null;
	readonly version: string | null;
	readonly line: number;
}

export const NO_LOCATION_REASON = "This document has no file location to reference. Select text to quote it instead.";

export interface LineReference {
	readonly ok: true;
	/** What goes into the draft: the location as inline code, `` `src/app.ts:42` ``, one line, never an `@` mention. */
	readonly text: string;
	/** What the status bar names: the location. */
	readonly summary: string;
}

/**
 * The reference to one line for the target session's `cwd`: the quote's own location (`quoteLocation`: relative inside `cwd`, else
 * absolute; ` @ <version>` for a Git version) as an inline code span. Refused when the document has no location, or when the text
 * would not fit the one-line insertion that carries it (`MAX_INSERT_TEXT_LENGTH`, less the space before and after).
 */
export function composeLineReference(source: LineReferenceSource, cwd: string): LineReference | Refusal {
	if (source.fsPath === null) return { ok: false, reason: NO_LOCATION_REASON };
	const located = quoteLocation(source.fsPath, cwd, { start: source.line, end: source.line }, source.version);
	if (!located.ok) return located;
	const text = codeSpan(located.location);
	if (text.length > MAX_INSERT_TEXT_LENGTH - 2) return { ok: false, reason: `The path of “${source.fsPath}” is too long to reference.` };
	return { ok: true, text, summary: located.location };
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
	/** The session's editor is shown on screen now (its panel reports `visible`); a tab hidden behind another tab of its group is not. */
	readonly visible: boolean;
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

/**
 * Where "Quote Selection to Session" goes without asking: the Chat session the user can see. A candidate counts when its editor is
 * visible, it is a Chat (a terminal has no composer) and it is `live` (its input is free: a session still starting or stopped is not
 * a composer to land in yet, and the picker, which also leaves it out or starts it, keeps deciding for those). Several visible Chats:
 * the one focused last, by the same recency the picker orders by; one no recency knows ranks after the ones it knows. `null` when no
 * Chat is visible, and the picker then asks.
 */
export function visibleQuoteTarget(candidates: readonly SendCandidate[], recency: readonly string[]): SendCandidate | null {
	const shown = candidates.filter(candidate => candidate.visible && candidate.slotId !== null && candidate.mode === "chat" && candidate.availability === "live");
	return orderCandidates(shown, recency)[0] ?? null;
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
	const listing = folderListed ? "" : " · pins this folder to the Sessions view";
	entries.push({ kind: "new", folder, label: `New session in ${folderName(folder)}`, description: `${MODE_LABEL[defaultMode]} · ${folder}${listing}` });
	return entries;
}
