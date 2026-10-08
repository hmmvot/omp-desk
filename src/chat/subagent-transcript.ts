/** Read-only child-history contract. Only the host resolves a previously observed native identity. */
import { isRecord } from "../guards.ts";
import { parseChatEntry, type ChatEntry } from "./messages.ts";

export const SUBAGENT_PAGE_ROWS = 200;
export const SUBAGENT_CHUNK_CHARS = 32_000;
export type SubagentUnavailableReason = "not-live" | "unknown" | "read-failed" | "changed";
export type SubagentTranscriptPage =
	| { status: "unavailable"; reason: SubagentUnavailableReason }
	| { status: "available"; entries: readonly ChatEntry[]; olderCount: number; fromByte: number; nextByte: number; reset: boolean };

export interface SubagentReadOptions { fromByte?: number; beforeId?: string }
export type SubagentReader = (subagentId: string, options?: SubagentReadOptions) => Promise<SubagentTranscriptPage>;
export const SUBAGENT_UNAVAILABLE_TEXT: Record<SubagentUnavailableReason, string> = {
	"not-live": "Child history is unavailable while the parent session is stopped or disconnected.",
	unknown: "This child is no longer available in the native registry or its retained transcript references.",
	"read-failed": "OMP could not provide this child's transcript.",
	changed: "The child history changed; reopen it to load its current transcript.",
};
function isOffset(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }

export function childPageFromNative(data: unknown, beforeId?: string): SubagentTranscriptPage {
	if (!isRecord(data) || !Array.isArray(data.entries) || !isOffset(data.fromByte) || !isOffset(data.nextByte) || typeof data.reset !== "boolean") return { status: "unavailable", reason: "read-failed" };
	const rows: ChatEntry[] = [];
	for (const raw of data.entries) {
		if (isRecord(raw) && (raw.type === "session" || raw.type === "title" || raw.type === "session_exit")) continue;
		const entry = parseChatEntry(raw);
		if (entry !== null) rows.push(entry);
	}
	const end = beforeId === undefined ? rows.length : rows.findIndex(entry => entry.id === beforeId);
	if (end < 0) return { status: "unavailable", reason: "changed" };
	const start = Math.max(0, end - SUBAGENT_PAGE_ROWS);
	return { status: "available", entries: rows.slice(start, end), olderCount: start, fromByte: data.fromByte, nextByte: data.nextByte, reset: data.reset };
}
export function parseSubagentPage(value: unknown): SubagentTranscriptPage | null {
	if (!isRecord(value)) return null;
	if (value.status === "unavailable") return typeof value.reason === "string" && Object.hasOwn(SUBAGENT_UNAVAILABLE_TEXT, value.reason) ? { status: value.status, reason: value.reason as SubagentUnavailableReason } : null;
	if (value.status !== "available" || !Array.isArray(value.entries) || value.entries.length > SUBAGENT_PAGE_ROWS || !isOffset(value.olderCount) || !isOffset(value.fromByte) || !isOffset(value.nextByte) || typeof value.reset !== "boolean") return null;
	const entries: ChatEntry[] = [];
	for (const raw of value.entries) { const entry = parseChatEntry(raw); if (entry !== null) entries.push(entry); }
	return { status: "available", entries, olderCount: value.olderCount, fromByte: value.fromByte, nextByte: value.nextByte, reset: value.reset };
}
