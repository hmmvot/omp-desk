/**
 * Session-file readers: the JSONL header, the last conversation activity and the
 * path identity helpers that read nothing but a file or a path.
 *
 * Nothing here knows the session index; the index, the Sessions view, the folder
 * history and the deletion lifecycle all read through these functions.
 */

import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { createReadStream } from "node:fs";
import type { Readable } from "node:stream";
import { createInterface } from "node:readline";
import * as path from "node:path";
import { normalizeClaimIdentity } from "./session-claim.ts";
import { isUserSkillInvocation, skillPromptText } from "../chat/messages.ts";

/** How much of a session file is read to find its JSONL header. */
const SESSION_HEADER_SCAN_BYTES = 64 * 1024;

/** Identity fields read from an OMP session file's JSONL header. */
export interface SessionFileHeader {
	readonly sessionId: string;
	/** Working directory recorded in the header, or `null` when absent. */
	readonly cwd: string | null;
	readonly title: string | null;
	/** First user prompt summary, used only when OMP has not named the session. */
	readonly promptTitle?: string;
}

/**
 * `type` marker of OMP's fixed-width title slot, the physical first line of a
 * session file (pi-coding-agent `src/session/session-entries.ts`, `SESSION_TITLE_SLOT_ENTRY_TYPE`).
 * OMP keeps the current title there, in a 256-byte line it can rewrite in place,
 * so a rename does not have to rewrite the transcript.
 */
const SESSION_TITLE_SLOT_TYPE = "title";

/** One reading of a session file's header, with the file stamp it was read at. */
export interface SessionFileHeaderReading {
	readonly mtimeMs: number;
	readonly size: number;
	readonly header: SessionFileHeader | null;
}

/**
 * Read the JSONL header of an OMP session file, or `null` when the file is
 * missing, unreadable, or does not carry a session header.
 *
 * Identity comes from a bounded prefix. Only an unnamed session whose first prompt
 * is outside that prefix needs a streaming scan, stopped at the first user entry.
 */
export async function readSessionFileHeader(file: string): Promise<SessionFileHeader | null> {
	return (await readSessionFileHeaderReading(file, null))?.header ?? null;
}

/**
 * {@link readSessionFileHeader} for a reader that keeps asking: `previous` is its last reading of the
 * same file, and a file whose `mtimeMs` and `size` still match it costs one `fstat` and returns
 * `previous` as is. `null` is a file that could not be opened or read.
 *
 * Only a completed reading is reusable: when the streaming scan for the first prompt fails, the
 * header is returned as far as the prefix gave it, with a stamp that matches no file, so the next
 * call reads again. `openStream` is the scan's file stream, replaceable by a test.
 */
export async function readSessionFileHeaderReading(
	file: string,
	previous: SessionFileHeaderReading | null,
	openStream: (file: string) => Readable = file => createReadStream(file, { encoding: "utf8" }),
): Promise<SessionFileHeaderReading | null> {
	let content: string;
	let truncated = false;
	let stamp: { readonly mtimeMs: number; readonly size: number };
	try {
		const handle = await open(file, "r");
		try {
			const { mtimeMs, size } = await handle.stat();
			if (previous !== null && previous.mtimeMs === mtimeMs && previous.size === size) return previous;
			stamp = { mtimeMs, size };
			const buffer = Buffer.allocUnsafe(SESSION_HEADER_SCAN_BYTES);
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
			truncated = bytesRead === buffer.length;
			content = buffer.subarray(0, bytesRead).toString("utf8");
		} finally {
			await handle.close();
		}
	} catch {
		return null;
	}
	const { header, complete } = await parseSessionFileHeaderFully(file, content, truncated, openStream);
	return complete ? { ...stamp, header } : { mtimeMs: Number.NaN, size: stamp.size, header };
}

/**
 * The header of `content`, a prefix of `file`; a truncated prefix without a title is followed to the
 * first user entry. `complete` is false when that scan failed and the header may lack its prompt title.
 */
async function parseSessionFileHeaderFully(
	file: string,
	content: string,
	truncated: boolean,
	openStream: (file: string) => Readable,
): Promise<{ readonly header: SessionFileHeader | null; readonly complete: boolean }> {
	const header = parseSessionFileHeader(content);
	if (header === null || header.title !== null || header.promptTitle !== undefined || !truncated) return { header, complete: true };
	// A large first prompt or preceding metadata can lie beyond the header prefix.
	// Stream only until the first user entry; never retain the growing transcript.
	const stream = openStream(file);
	const lines = createInterface({ input: stream, crlfDelay: Infinity });
	try {
		for await (const line of lines) {
			let entry: unknown;
			try { entry = JSON.parse(line); } catch { continue; }
			const title = firstPromptTitle(entry);
			if (title !== undefined) return { header: title ? { ...header, promptTitle: title } : header, complete: true };
		}
	} catch {
		return { header, complete: false };
	} finally {
		lines.close();
		stream.destroy();
	}
	return { header, complete: true };
}

/**
 * Interpret a session file's head: the first JSON object with `type === "session"`
 * is the header, and the title comes from the fixed-width slot ahead of it.
 *
 * The title rule mirrors OMP's own resolution (pi-coding-agent `src/session/session-loader.ts`,
 * `applyTitleSlot`): the current slot is authoritative, including an empty title
 * that clears a legacy header name. Without a slot, the header's `title` answers.
 * Appended `title_change` entries are deliberately not consulted:
 * they live arbitrarily far down a growing file, and OMP itself reads the slot,
 * so reading anything else here would report a title OMP does not.
 *
 * The first line is not assumed to be the slot: a header without one (an older
 * file, or a test file) is read the same way, and a line that is not JSON is
 * skipped rather than treated as a header.
 */
export function parseSessionFileHeader(content: string): SessionFileHeader | null {
	let slotTitle: string | null = null;
	let header: SessionFileHeader | null = null;
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("{")) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			continue;
		}
		if (typeof parsed !== "object" || parsed === null) continue;
		const record = parsed as { type?: unknown; v?: unknown; id?: unknown; cwd?: unknown; title?: unknown };
		if (header !== null) {
			const title = firstPromptTitle(parsed);
			if (title !== undefined) return title ? { ...header, promptTitle: title } : header;
		}
		// The slot is identified by its own marker and version, so a `session`
		// header that also happens to carry a title cannot be mistaken for one.
		if (slotTitle === null && record.type === SESSION_TITLE_SLOT_TYPE && record.v === 1) {
			slotTitle = typeof record.title === "string" ? record.title.trim() : "";
			continue;
		}
		if (record.type !== "session") continue;
		if (typeof record.id !== "string" || record.id.length === 0) continue;
		const headerTitle = typeof record.title === "string" ? record.title.trim() : "";
		header = {
			sessionId: record.id,
			cwd: typeof record.cwd === "string" && record.cwd.length > 0 ? record.cwd : null,
			title: slotTitle !== null ? slotTitle || null : headerTitle || null,
		};
		if (header.title !== null) return header;
	}
	return header;
}

function firstPromptTitle(entry: unknown): string | undefined {
	if (typeof entry !== "object" || entry === null || !("type" in entry)) return undefined;
	let text: string;
	if (isUserSkillInvocation(entry)) {
		const details = entry.type === "custom_message" ? ("details" in entry ? entry.details : undefined) : "message" in entry && typeof entry.message === "object" && entry.message !== null && "details" in entry.message ? entry.message.details : undefined;
		text = skillPromptText(details);
	} else {
		if (entry.type !== "message" || !("message" in entry)) return undefined;
		const message = entry.message;
		if (typeof message !== "object" || message === null || !("role" in message) || message.role !== "user" || !("content" in message)) return undefined;
		const content = message.content;
		text = typeof content === "string" ? content : Array.isArray(content)
			? content.filter((part: unknown): part is { type: "text"; text: string } => typeof part === "object" && part !== null && "type" in part && part.type === "text" && "text" in part && typeof part.text === "string").map(part => part.text).join(" ")
			: "";
	}
	const title = text.replace(/\s+/g, " ").trim();
	return title.length > 60 ? `${title.slice(0, 59).trimEnd()}…` : title;
}

/**
 * When an OMP session file last recorded conversation, with the file identity it
 * was read from.
 *
 * This is what the Sessions view reports as a row's "Last activity". It is read
 * from the file, never from {@link SessionIndexEntry.lastActiveAt}: the index
 * moves that on its own bookkeeping (restore, reattach, conflicts, failures,
 * focus), none of which is the conversation advancing.
 */
export interface SessionFileActivity {
	/** `mtimeMs` of the file when it was read; with {@link size}, the key a later read compares. */
	readonly mtimeMs: number;
	readonly size: number;
	/** `timestamp` of the last conversation entry, or `null` when the file holds none yet. */
	readonly lastConversationAt: string | null;
}

/**
 * Entry types OMP turns into messages of the conversation itself
 * (pi-coding-agent `src/session/session-entries.ts`): messages, injected custom
 * messages, compactions and branch summaries.
 *
 * Everything else OMP appends is bookkeeping that is written without the
 * conversation advancing — a host exit appends a `session_exit` custom entry, a
 * resume or model switch appends `model_change`/`thinking_level_change`/
 * `service_tier_change`, a rename rewrites the title slot in place. That is also
 * why the file's mtime is not conversation activity.
 */
const CONVERSATION_ENTRY_TYPES: Partial<Record<string, true>> = { message: true, custom_message: true, compaction: true, branch_summary: true };

/** How much of the file one backwards step of the tail scan reads. */
const SESSION_TAIL_CHUNK_BYTES = 64 * 1024;

/** Bytes of an entry's start that classify it without reading the whole line. */
const SESSION_ENTRY_HEAD_BYTES = 512;

/**
 * An entry's start as OMP writes it: `type` first, then the common fields
 * `id`, `parentId` and `timestamp` (`SessionManager#freshEntryFields`). Entries
 * with another layout — a custom message puts its content first — are classified
 * by `type` and, when they are conversation, read whole.
 */
const ENTRY_HEAD = /^\{"type":"([a-z_]+)"(?:,"id":"[^"\\]*","parentId":(?:"[^"\\]*"|null),"timestamp":"([^"\\]+)")?/;

/**
 * Read when a session file last recorded conversation, or `null` when the file
 * is missing or unreadable.
 *
 * `previous` is the last result for the same file: when the file's `mtimeMs` and
 * `size` still match it, it is returned as is after one `fstat`, so an unchanged
 * file is never read again. Otherwise only the tail is read, backwards in bounded
 * chunks, until the last conversation entry; nothing of the transcript is retained.
 */
export async function readSessionFileActivity(
	file: string,
	previous: SessionFileActivity | null = null,
): Promise<SessionFileActivity | null> {
	let handle: FileHandle;
	try {
		handle = await open(file, "r");
	} catch {
		return null;
	}
	try {
		const { mtimeMs, size } = await handle.stat();
		if (previous !== null && previous.mtimeMs === mtimeMs && previous.size === size) return previous;
		return { mtimeMs, size, lastConversationAt: await lastConversationTimestamp(handle, size) };
	} catch {
		return null;
	} finally {
		await handle.close().catch(() => undefined);
	}
}

/**
 * Scan lines from the end of the file. OMP serializes each entry as one JSON
 * line, and JSON escapes every newline inside it, so a `\n` byte always ends an
 * entry. A trailing line still being written is classified by its start like any
 * other.
 */
async function lastConversationTimestamp(handle: FileHandle, size: number): Promise<string | null> {
	// Each read also covers the head of a line that starts near the chunk's end.
	const buffer = Buffer.allocUnsafe(SESSION_TAIL_CHUNK_BYTES + SESSION_ENTRY_HEAD_BYTES);
	let position = size;
	// Exclusive end of the line that starts at the next line start found.
	let lineEnd = size;
	while (position > 0) {
		const start = Math.max(0, position - SESSION_TAIL_CHUNK_BYTES);
		const { bytesRead } = await handle.read(buffer, 0, Math.min(size, position + SESSION_ENTRY_HEAD_BYTES) - start, start);
		const chunk = buffer.subarray(0, bytesRead);
		let searchEnd = position - start;
		for (;;) {
			const newline = searchEnd === 0 ? -1 : chunk.lastIndexOf(0x0a, searchEnd - 1);
			if (newline === -1 && start > 0) break;
			const lineStart = newline + 1;
			if (start + lineStart < lineEnd) {
				const head = chunk.subarray(lineStart, Math.min(lineStart + SESSION_ENTRY_HEAD_BYTES, lineEnd - start)).toString("utf8");
				const at = await conversationTimestamp(handle, head, start + lineStart, lineEnd);
				if (at !== null) return at;
			}
			if (newline === -1) return null;
			lineEnd = start + newline;
			searchEnd = newline;
		}
		position = start;
	}
	return null;
}

/** The entry's timestamp when it is a conversation entry, else `null`. */
async function conversationTimestamp(handle: FileHandle, head: string, lineStart: number, lineEnd: number): Promise<string | null> {
	const match = ENTRY_HEAD.exec(head);
	if (match !== null) {
		if (CONVERSATION_ENTRY_TYPES[match[1]!] !== true) return null;
		if (match[2] !== undefined) return Number.isFinite(Date.parse(match[2])) ? match[2] : null;
	}
	const line = Buffer.allocUnsafe(lineEnd - lineStart);
	const { bytesRead } = await handle.read(line, 0, line.length, lineStart);
	let entry: unknown;
	try {
		entry = JSON.parse(line.subarray(0, bytesRead).toString("utf8"));
	} catch {
		return null;
	}
	if (typeof entry !== "object" || entry === null) return null;
	const { type, timestamp } = entry as { type?: unknown; timestamp?: unknown };
	if (typeof type !== "string" || CONVERSATION_ENTRY_TYPES[type] !== true) return null;
	return typeof timestamp === "string" && Number.isFinite(Date.parse(timestamp)) ? timestamp : null;
}

/**
 * The absolute root a directory string names, or `""` when it names none.
 *
 * `path.parse().root` alone is not enough on Windows: a drive-less rooted path
 * (`\foo`) reports a root there too, yet it is *drive-relative* — it depends on
 * whatever drive this process happens to run on — and must never be resolved as
 * if the caller had named an absolute directory.
 */
function absoluteDirectoryRoot(directory: string): string {
	const trimmed = directory.trim();
	if (trimmed.length === 0) return "";
	const root = path.parse(trimmed).root;
	if (root.length === 0) return "";
	if (process.platform === "win32" && !/^[A-Za-z]:[\\/]$/.test(root) && !root.startsWith("\\\\")) return "";
	return root;
}

/**
 * Whether `directory` is a usable absolute directory: a POSIX root, a drive root
 * (`C:\`) or a UNC share root.
 *
 * An empty string, a relative path and Windows's drive-relative forms (`C:`,
 * `\foo`) are all refused. The distinction matters because every fallback for
 * such a value — `path.resolve`, a launch's working directory — silently becomes
 * the directory of *this* process, which is not the folder the caller asked for.
 */
export function isAbsoluteWorkspaceDirectory(directory: string): boolean {
	return typeof directory === "string" && absoluteDirectoryRoot(directory) !== "";
}

/**
 * Normalized comparison form for a working directory (Windows: case-folded).
 *
 * A *root* survives normalization: `C:\`, `C:/` and `/` stay usable absolute
 * roots, because stripping the trailing separator would turn them into the
 * drive-relative `C:` or the empty string. A folder registered as a root and the
 * cwd of a session launched in it therefore compare equal.
 *
 * A value that is not absolute — an empty string, a relative path, a Windows
 * drive-relative `C:` — is never resolved against this process's working
 * directory: `path.resolve` would turn precisely the rows that must stay
 * ambiguous into the extension host's own folder. Such a value is returned
 * case-folded and separator-trimmed verbatim, so it can only ever equal another
 * equally unusable value.
 */
export function normalizeWorkspaceDirectory(directory: string): string {
	const trimmed = directory.trim();
	if (trimmed.length === 0) return "";
	const resolved = isAbsoluteWorkspaceDirectory(trimmed) ? path.resolve(trimmed) : trimmed;
	const root = path.parse(resolved).root;
	let end = resolved.length;
	while (end > root.length && (resolved[end - 1] === "/" || resolved[end - 1] === "\\")) end--;
	const bounded = resolved.slice(0, end);
	return process.platform === "win32" ? bounded.toLowerCase() : bounded;
}

/**
 * Dedupe key for a session identity. Delegates to the claim module so "the same
 * session" means exactly the same thing here and in its claim file, including
 * Windows aliases and 8.3 short names.
 */
export function normalizeSessionIdentityKey(target: string): string {
	return normalizeClaimIdentity(target);
}
