/**
 * Read-only, bounded reader of an OMP session JSONL file.
 *
 * A running rpc session's history is painted from this file first and reconciled with rpc afterwards; a stopped
 * session's history can only come from here (opening it in rpc-ui would append `session_exit`). Reading never writes.
 *
 * One streaming pass indexes every entry (`id`, `parentId`, `type`, byte offset and length, whether it renders a
 * transcript row) without keeping the entries themselves; rows are read back by byte range on demand, so the
 * reader holds the index plus whatever window the caller asked for, not the transcript. A file starts with a
 * fixed-width `title` slot line, then the `session` header, then id/parentId-linked entries. An incomplete last line
 * (no newline yet) is ignored. The active path is the parent chain from the leaf; the leaf is the last entry in file
 * order (`SessionManager` sets the leaf to every inserted entry). No file handle stays open between calls, so the
 * reader never holds a Windows lock on a file OMP may rewrite.
 */
import { open, stat, type FileHandle } from "node:fs/promises";
import { parseChatEntry, type ChatEntry } from "../../chat/messages.ts";
import { computeBranchPoints, rewindTargets, type BranchInfo, type BranchPoint } from "../../chat/rewind.ts";
import { todoPhasesFromEntry, type TodoPhase } from "../../chat/todos.ts";
import {
	CHAT_ENTRY_TYPES,
	type ChatCode,
	type ChatEpoch,
	type ChatHeader,
	type ChatPhase,
	type ChatSnapshotPayload,
} from "../../chat/model.ts";
import { TRANSCRIPT_WINDOW_ROWS, transcriptWindow } from "../../webview/lib/transcript-window.ts";
import { BLOB_BYTES_BUDGET, blobsDirectoryFor, resolveBlobImages } from "./history-blobs.ts";

export const DEFAULT_TAIL_ROWS = TRANSCRIPT_WINDOW_ROWS;
const SCAN_CHUNK_BYTES = 1024 * 1024;
const HEAD_BYTES = 1024;
/** A row larger than this is replaced by a placeholder instead of being parsed. */
const MAX_ROW_BYTES = 32 * 1024 * 1024;
/** Adjacent rows closer than this are read with one syscall. */
const COALESCE_GAP_BYTES = 64 * 1024;
const MAX_COALESCED_BYTES = 16 * 1024 * 1024;
/** Branch first-prompt bodies one snapshot reads for their previews; the rest show without one. */
const MAX_BRANCH_PREVIEWS = 40;
/** The custom type of the placeholder row that stands for an oversize entry. */
export const ENTRY_TOO_LARGE_CUSTOM_TYPE = "entry-too-large";

export type HistoryReadErrorCode = "missing" | "unreadable" | "no-header";

/** A visible read failure; the caller shows an error state, never a shortened transcript. */
export class HistoryReadError extends Error {
	readonly code: HistoryReadErrorCode;
	constructor(code: HistoryReadErrorCode) {
		super(`history ${code}`);
		this.name = "HistoryReadError";
		this.code = code;
	}
}

interface IndexEntry {
	id: string;
	parentId: string | null;
	type: string;
	offset: number;
	length: number;
	renders: boolean;
	/** Message role (`user`, `assistant`, …) for a `message` entry, else null; branch points count messages. */
	role: string | null;
	todoCandidate: boolean;
}

export interface HistorySnapshot {
	header: ChatHeader;
	/** Current title: the fixed title slot when present, else the header's. */
	title: string | null;
	/** Durable chat rows of the tail window in file order, active path only. */
	entries: ChatEntry[];
	/** Rendering rows on the active path above the window. */
	olderCount: number;
	leafId: string | null;
	/** Off-path branches of the active path, from the index alone (ADR-0051). */
	branches: BranchPoint[];
	/** Id of the last complete entry in file order: the `get_entries { since }` cursor. */
	lastId: string | null;
	/**
	 * True for a header version below 3: OMP re-ids such files at load time, so ids on disk are not the ids the
	 * process reports and `lastId` must not be used as a cursor (one full `get_entries` instead).
	 */
	legacyIds: boolean;
	/** Lines that were complete but not valid JSON (skipped). */
	badLines: number;
	/** Latest canonical todo evidence on this branch, independent of the rendered tail. */
	todoSeed: readonly TodoPhase[] | null;
}

export interface HistoryOlder {
	entries: ChatEntry[];
	olderCount: number;
	/** False when `beforeId` is not in the index (the caller must reload the tail). */
	found: boolean;
}

export interface HistoryRefresh {
	/** Entries added since the last pass. */
	appended: number;
	/** The file changed under the index (rewrite, truncation) and was re-indexed from scratch. */
	reindexed: boolean;
}

interface LineFacts {
	type: string;
	id: string | null;
	parentId: string | null;
	role: string | null;
	customType: string | null;
	display: boolean;
	todoCandidate: boolean;
}

const HEAD_PATTERN = /^\{"type":"([^"\\]*)","id":"([^"\\]*)","parentId":(?:null|"([^"\\]*)")/;
const ROLE_PATTERN = /"message":\{"role":"([A-Za-z]+)"/;

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Coarse visibility for indexing; decoded windows use the exact semantic projection. */
export function rendersByFacts(facts: { type: string; role?: string | null; customType?: string | null; display?: boolean }): boolean {
	switch (facts.type) {
		case "message":
			if (facts.role === "custom" || facts.role === "hookMessage") return facts.display === true;
			return facts.role === "user" || facts.role === "assistant" || facts.role === "bashExecution" ||
				facts.role === "pythonExecution" || facts.role === "compactionSummary" || facts.role === "branchSummary" || facts.role === "fileMention";
		case "custom_message":
			return facts.display === true;
		case "compaction":
		case "branch_summary":
		case "model_change":
		case "thinking_level_change":
		case "reset_boundary":
			return true;
		default:
			return false;
	}
}

function factsOf(line: Buffer): LineFacts | null {
	const head = line.toString("utf8", 0, Math.min(line.length, HEAD_BYTES));
	const match = HEAD_PATTERN.exec(head);
	if (match !== null) {
		const type = match[1]!;
		if (type === "message") {
			const role = ROLE_PATTERN.exec(head);
			if (role !== null && role[1] !== "custom" && role[1] !== "hookMessage") {
				return { type, id: match[2]!, parentId: match[3] ?? null, role: role[1]!, customType: null, display: false, todoCandidate: role[1] === "toolResult" };
			}
		} else if (type !== "custom_message" && type !== "custom") {
			return { type, id: match[2]!, parentId: match[3] ?? null, role: null, customType: null, display: false, todoCandidate: false };
		}
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(line.toString("utf8"));
	} catch {
		return null;
	}
	if (!isObject(parsed) || typeof parsed.type !== "string") return null;
	const message = parsed.message;
	return {
		type: parsed.type,
		id: typeof parsed.id === "string" ? parsed.id : null,
		parentId: typeof parsed.parentId === "string" ? parsed.parentId : null,
		role: isObject(message) && typeof message.role === "string" ? message.role : null,
		customType: typeof parsed.customType === "string" ? parsed.customType : null,
		display: parsed.display === true || (isObject(message) && message.display === true),
		todoCandidate: (parsed.type === "custom" && parsed.customType === "user_todo_edit") || (isObject(message) && message.role === "toolResult"),
	};
}

async function readRange(handle: FileHandle, offset: number, length: number): Promise<Buffer> {
	const buffer = Buffer.allocUnsafe(length);
	let done = 0;
	while (done < length) {
		const { bytesRead } = await handle.read(buffer, done, length - done, offset + done);
		if (bytesRead === 0) break;
		done += bytesRead;
	}
	return done === length ? buffer : buffer.subarray(0, done);
}

export class HistoryReader {
	readonly #path: string;
	/** OMP's content-addressed image store beside this file's `sessions/` directory, when it has one. */
	readonly #blobs: string | null;
	#header: ChatHeader | null = null;
	#version: number | null = null;
	#slotTitle: string | null = null;
	#entries: IndexEntry[] = [];
	#byId = new Map<string, number>();
	#indexedBytes = 0;
	#badLines = 0;
	#pathCache: number[] | null = null;
	#lastTag: { offset: number; length: number; text: string } | null = null;

	private constructor(path: string) {
		this.#path = path;
		this.#blobs = blobsDirectoryFor(path);
	}

	/** Index `path`. Throws {@link HistoryReadError}. */
	static async open(path: string): Promise<HistoryReader> {
		const reader = new HistoryReader(path);
		await reader.#withFile(handle => reader.#scan(handle));
		return reader;
	}

	get sessionFile(): string {
		return this.#path;
	}

	/** Re-read appended bytes; a file that shrank or whose last indexed line changed is re-indexed once. */
	async refresh(): Promise<HistoryRefresh> {
		return this.#withFile(async handle => {
			const size = (await handle.stat()).size;
			const unchanged = size >= this.#indexedBytes && (await this.#lastLineIntact(handle));
			if (!unchanged) {
				this.#reset();
				await this.#scan(handle);
				return { appended: this.#entries.length, reindexed: true };
			}
			const before = this.#entries.length;
			await this.#scan(handle);
			await this.#readSlotTitle(handle);
			return { appended: this.#entries.length - before, reindexed: false };
		});
	}

	/**
	 * The tail window and the facts the resync needs. The window ends at `leafId` when the index holds it, otherwise
	 * at the last entry in file order (OMP's leaf after a load); `leafId` of the result names the leaf actually used, so
	 * a caller that passed the live leaf can tell a disk that trails the process. Legacy files ignore `leafId`.
	 */
	async snapshot(rows: number = DEFAULT_TAIL_ROWS, leafId?: string | null): Promise<HistorySnapshot> {
		const header = this.#header;
		if (header === null) throw new HistoryReadError("no-header");
		const legacy = this.#version === null || this.#version < 3;
		const wanted = legacy || leafId === undefined || leafId === null ? undefined : this.#byId.get(leafId);
		const leaf = wanted ?? this.#entries.length - 1;
		const path = this.#pathTo(leaf);
		// Legacy files have no parent links, hence no branches.
		const points = legacy ? [] : computeBranchPoints(this.#entries, path.map(position => this.#entries[position]!.id));
		const { entries, start, todoSeed, branches } = await this.#withFile(async handle => ({
			...await this.#readWindow(handle, path, path.length, rows),
			todoSeed: await this.#readTodoSeed(handle, path),
			branches: await this.#previewBranches(handle, points),
		}));
		return {
			header,
			title: this.#slotTitle ?? header.title ?? null,
			entries,
			olderCount: this.#rendersBefore(path, start),
			leafId: this.#entries[leaf]?.id ?? null,
			branches,
			lastId: this.#entries.at(-1)?.id ?? null,
			legacyIds: legacy,
			badLines: this.#badLines,
			todoSeed,
		};
	}

	/**
	 * The next `rows` rendering rows above the row `beforeId` (the top of what the caller holds), walking that row's
	 * own ancestors: the caller's window may end at a leaf that is not the last line of the file (ADR-0051).
	 */
	async loadOlder(beforeId: string, rows: number = DEFAULT_TAIL_ROWS): Promise<HistoryOlder> {
		const top = this.#byId.get(beforeId);
		if (top === undefined) return { entries: [], olderCount: 0, found: false };
		const path = this.#pathTo(top);
		const { entries, start } = await this.#withFile(handle => this.#readWindow(handle, path, path.length - 1, rows));
		return { entries, olderCount: this.#rendersBefore(path, start), found: true };
	}

	async #withFile<T>(work: (handle: FileHandle) => Promise<T>): Promise<T> {
		let handle: FileHandle;
		try {
			handle = await open(this.#path, "r");
		} catch (error) {
			throw new HistoryReadError(isObject(error) && error.code === "ENOENT" ? "missing" : "unreadable");
		}
		try {
			return await work(handle);
		} catch (error) {
			if (error instanceof HistoryReadError) throw error;
			throw new HistoryReadError("unreadable");
		} finally {
			await handle.close().catch(() => undefined);
		}
	}

	#reset(): void {
		this.#header = null;
		this.#version = null;
		this.#slotTitle = null;
		this.#entries = [];
		this.#byId = new Map();
		this.#indexedBytes = 0;
		this.#badLines = 0;
		this.#pathCache = null;
		this.#lastTag = null;
	}

	async #lastLineIntact(handle: FileHandle): Promise<boolean> {
		const tag = this.#lastTag;
		if (tag === null) return true;
		const bytes = await readRange(handle, tag.offset, Math.min(tag.length, 128));
		return bytes.toString("utf8") === tag.text;
	}

	async #readSlotTitle(handle: FileHandle): Promise<void> {
		const first = await readRange(handle, 0, HEAD_BYTES);
		const end = first.indexOf(0x0a);
		if (end < 0) return;
		this.#slotTitle = HistoryReader.#titleOfSlot(first.subarray(0, end));
	}

	static #titleOfSlot(line: Buffer): string | null {
		try {
			const parsed: unknown = JSON.parse(line.toString("utf8"));
			if (isObject(parsed) && parsed.type === "title" && typeof parsed.title === "string" && parsed.title.length > 0) {
				return parsed.title;
			}
		} catch {
			// A slot that is not JSON is not a title.
		}
		return null;
	}

	/** Index complete lines from `#indexedBytes` to the current end of file. */
	async #scan(handle: FileHandle): Promise<void> {
		const size = (await handle.stat()).size;
		let position = this.#indexedBytes;
		let lineStart = position;
		let carry: Buffer[] = [];
		let carryBytes = 0;
		while (position < size) {
			const chunk = await readRange(handle, position, Math.min(SCAN_CHUNK_BYTES, size - position));
			if (chunk.length === 0) break;
			position += chunk.length;
			let cursor = 0;
			for (;;) {
				const newline = chunk.indexOf(0x0a, cursor);
				if (newline < 0) break;
				const piece = chunk.subarray(cursor, newline);
				const line = carry.length === 0 ? piece : Buffer.concat([...carry, piece], carryBytes + piece.length);
				carry = [];
				carryBytes = 0;
				this.#indexLine(line, lineStart);
				lineStart += line.length + 1;
				cursor = newline + 1;
			}
			if (cursor < chunk.length) {
				const rest = Buffer.from(chunk.subarray(cursor));
				carry.push(rest);
				carryBytes += rest.length;
			}
		}
		this.#indexedBytes = lineStart;
	}

	#indexLine(line: Buffer, offset: number): void {
		const content = line.length > 0 && line[line.length - 1] === 0x0d ? line.subarray(0, -1) : line;
		if (content.length === 0) return;
		if (this.#header === null) {
			this.#indexHeaderLine(content);
			return;
		}
		const facts = factsOf(content);
		if (facts === null) {
			this.#badLines += 1;
			return;
		}
		if (facts.id === null || facts.type === "session" || facts.type === "title") return;
		const position = this.#entries.length;
		const renders = rendersByFacts(facts);
		// Legacy files (version < 3) may carry no parent links; the active path is then the file order.
		this.#entries.push({ id: facts.id, parentId: facts.parentId, type: facts.type, offset, length: line.length, renders, role: facts.type === "message" ? facts.role : null, todoCandidate: facts.todoCandidate });
		this.#byId.set(facts.id, position);
		this.#pathCache = null;
		this.#lastTag = { offset, length: line.length, text: line.toString("utf8", 0, Math.min(line.length, 128)) };
	}

	#indexHeaderLine(content: Buffer): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(content.toString("utf8"));
		} catch {
			throw new HistoryReadError("no-header");
		}
		if (!isObject(parsed)) throw new HistoryReadError("no-header");
		if (parsed.type === "title") {
			this.#slotTitle = HistoryReader.#titleOfSlot(content);
			return;
		}
		if (parsed.type !== "session" || typeof parsed.id !== "string" || typeof parsed.cwd !== "string") {
			throw new HistoryReadError("no-header");
		}
		this.#version = typeof parsed.version === "number" ? parsed.version : null;
		this.#header = {
			id: parsed.id,
			cwd: parsed.cwd,
			timestamp: typeof parsed.timestamp === "string" ? parsed.timestamp : "",
			...(typeof parsed.title === "string" ? { title: parsed.title } : {}),
		};
	}

	/** Positions from the root to `leaf` (an index position), oldest first; the file-order leaf's path is cached. */
	#pathTo(leaf: number): number[] {
		const last = this.#entries.length - 1;
		if (leaf === last && this.#pathCache !== null) return this.#pathCache;
		let result: number[];
		if (this.#version === null || this.#version < 3) {
			result = [];
			for (let index = 0; index <= leaf; index += 1) result.push(index);
		} else {
			result = [];
			const seen = new Set<number>();
			let position: number | undefined = leaf;
			while (position !== undefined && position >= 0 && !seen.has(position)) {
				seen.add(position);
				result.push(position);
				const parentId: string | null = this.#entries[position]!.parentId;
				position = parentId === null ? undefined : this.#byId.get(parentId);
			}
			result.reverse();
		}
		if (leaf === last) this.#pathCache = result;
		return result;
	}

	/** Fill in the first-prompt preview of each branch from its body; bounded, and a failed read keeps the bare branch. */
	async #previewBranches(handle: FileHandle, points: readonly BranchPoint[]): Promise<BranchPoint[]> {
		let budget = MAX_BRANCH_PREVIEWS;
		const result: BranchPoint[] = [];
		for (let pointIndex = points.length - 1; pointIndex >= 0; pointIndex -= 1) {
			const point = points[pointIndex]!;
			const branches: BranchInfo[] = [];
			for (const branch of point.branches) {
				const position = branch.firstPromptId === null || budget <= 0 ? undefined : this.#byId.get(branch.firstPromptId);
				const entry = position === undefined ? undefined : this.#entries[position];
				if (entry === undefined || entry.length > MAX_ROW_BYTES) {
					branches.push(branch);
					continue;
				}
				budget -= 1;
				const row = await this.#rowOf(entry, await readRange(handle, entry.offset, entry.length), { bytes: BLOB_BYTES_BUDGET });
				const preview = rewindTargets([row])[0]?.preview;
				branches.push(preview === undefined ? branch : { ...branch, firstPrompt: preview });
			}
			result.push({ entryId: point.entryId, branches });
		}
		return result.reverse();
	}

	/** Fill by displayed cards, not raw assistant rows: a long read run costs one card. */
	async #readWindow(handle: FileHandle, path: readonly number[], end: number, rows: number): Promise<{ entries: ChatEntry[]; start: number }> {
		let start = this.#windowStart(path, end, rows);
		let entries = await this.#readPositions(handle, path.slice(start, end));
		let window = transcriptWindow(entries, rows, null);
		while (start > 0 && rows > 0 && window.olderRows === 0) {
			const previous = this.#windowStart(path, start, Math.max(rows, DEFAULT_TAIL_ROWS));
			entries = [...await this.#readPositions(handle, path.slice(previous, start)), ...entries];
			start = previous;
			window = transcriptWindow(entries, rows, null);
		}
		const sourceIds = new Set(window.rows.flatMap(card => card.sourceIds));
		const first = entries.findIndex(entry => sourceIds.has(entry.id));
		if (first > 0) {
			const firstId = entries[first]!.id;
			start = path.findIndex(position => this.#entries[position]!.id === firstId);
			entries = entries.slice(first);
		}
		return { entries, start };
	}

	/**
	 * Index into `path` where a window ending before `end` starts: it holds at most `rows` rendering rows, plus the
	 * row-less entries (tool results, hidden messages) that follow the oldest of them.
	 */
	#windowStart(path: readonly number[], end: number, rows: number): number {
		let cards = 0;
		let start = end;
		for (let index = end - 1; index >= 0; index -= 1) {
			const entry = this.#entries[path[index]!]!;
			if (entry.renders) {
				if (cards === rows) break;
				cards += 1;
			}
			start = index;
		}
		return start;
	}

	#rendersBefore(path: readonly number[], start: number): number {
		let count = 0;
		for (let index = 0; index < start; index += 1) if (this.#entries[path[index]!]!.renders) count += 1;
		return count;
	}

	/** Read the latest canonical todo candidate, even when it precedes the transcript tail. */
	async #readTodoSeed(handle: FileHandle, path: readonly number[]): Promise<readonly TodoPhase[] | null> {
		for (let index = path.length - 1; index >= 0; index -= 1) {
			const candidate = this.#entries[path[index]!]!;
			if (!candidate.todoCandidate || candidate.length > MAX_ROW_BYTES) continue;
			const row = await this.#rowOf(candidate, await readRange(handle, candidate.offset, candidate.length), { bytes: 0 });
			const phases = todoPhasesFromEntry(row);
			if (phases !== null) return phases;
		}
		return null;
	}

	/** Read rows by byte range (coalescing near neighbours) and keep the chat entry types. */
	async #readPositions(handle: FileHandle, positions: readonly number[]): Promise<ChatEntry[]> {
		const spent = { bytes: 0 };
		const wanted = positions.filter(position => CHAT_ENTRY_TYPES[this.#entries[position]!.type] === true);
		const rows: ChatEntry[] = [];
		let group: number[] = [];
		const flush = async (): Promise<void> => {
			if (group.length === 0) return;
			const first = this.#entries[group[0]!]!;
			const last = this.#entries[group.at(-1)!]!;
			const span = await readRange(handle, first.offset, last.offset + last.length - first.offset);
			for (const position of group) {
				const entry = this.#entries[position]!;
				rows.push(await this.#rowOf(entry, span.subarray(entry.offset - first.offset, entry.offset - first.offset + entry.length), spent));
			}
			group = [];
		};
		for (const position of wanted) {
			const entry = this.#entries[position]!;
			if (entry.length > MAX_ROW_BYTES) {
				await flush();
				rows.push(this.#placeholder(entry));
				continue;
			}
			const tail = group.length === 0 ? null : this.#entries[group.at(-1)!]!;
			const first = group.length === 0 ? null : this.#entries[group[0]!]!;
			const contiguous =
				tail !== null &&
				first !== null &&
				entry.offset - (tail.offset + tail.length) <= COALESCE_GAP_BYTES &&
				entry.offset + entry.length - first.offset <= MAX_COALESCED_BYTES;
			if (!contiguous) await flush();
			group.push(position);
		}
		await flush();
		return rows;
	}

	/** Decode one row; saved image references are swapped for their bytes before the shared parser sees them. */
	async #rowOf(entry: IndexEntry, bytes: Buffer, spent: { bytes: number }): Promise<ChatEntry> {
		try {
			const text = bytes.toString("utf8");
			const raw: unknown = JSON.parse(text);
			if (text.includes("blob:sha256:")) await resolveBlobImages(raw, this.#blobs, spent);
			const parsed = parseChatEntry(raw);
			if (parsed !== null) return parsed;
		} catch {
			// A line that changed under the reader is shown as a placeholder, never dropped.
		}
		return this.#placeholder(entry);
	}

	#placeholder(entry: IndexEntry): ChatEntry {
		return {
			type: "custom_message",
			id: entry.id,
			parentId: entry.parentId,
			timestamp: this.#header?.timestamp ?? "",
			customType: ENTRY_TOO_LARGE_CUSTOM_TYPE,
			content: "[This entry is too large to display.]",
			display: true,
		};
	}
}

/** Size of the session file in bytes, or null when it cannot be stat'ed (used to skip a pointless re-index). */
export async function historyFileSize(path: string): Promise<number | null> {
	try {
		return (await stat(path)).size;
	} catch {
		return null;
	}
}

/**
 * The snapshot payload for a disk read alone (no process): the tail window with nothing in flight. Used for the
 * disk paint of a running session and for a stopped session's view-only page.
 */
export function chatSnapshotFromHistory(
	history: HistorySnapshot,
	epoch: ChatEpoch,
	phase: ChatPhase,
	code: ChatCode | null,
	readOnlyReason: string | null,
): ChatSnapshotPayload {
	return {
		epoch,
		phase,
		code,
		readOnlyReason,
		header: { ...history.header, ...(history.title === null ? {} : { title: history.title }) },
		entries: history.entries,
		olderCount: history.olderCount,
		leafId: history.leafId,
		branches: history.branches,
		state: null,
		pending: [],
		stream: null,
		activeTools: [],
		working: false,
		settled: true,
		uiRequests: [],
		todoSeed: history.todoSeed,
		todoAuthoritative: false,
		agents: [],
		agentActivity: [],
		agentAvailability: "unavailable",
		maintenance: null,
		retry: null,
		retrySuppressedIds: [],
		goal: null,
		transcriptEventSeq: 0,
		ephemeral: [],
		commands: [],
	};
}
