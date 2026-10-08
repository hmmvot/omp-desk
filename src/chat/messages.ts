/** Installed OMP RPC/JSONL display vocabulary. No runtime dependency on the terminal renderer. */
import type { ImageContent, RedactedThinkingContent, TextContent, ThinkingContent, ToolCallContent, WireUsage } from "@oh-my-pi/pi-wire";
import { isRecord } from "../guards.ts";

export interface RetryRecovery {
	kind: "auto-retry";
	status: "recovered" | "superseded";
	attempt: number;
	recovery: "credential" | "model" | "wait" | "plain";
	note: string;
	recoveredAt?: string;
	supersededBy?: { timestamp: number; responseId?: string; provider: string; model: string };
}
export interface RetryErrorUpdate { entryId: string; persistenceKey?: string; note: string; retryRecovery: RetryRecovery }
export interface UnknownContent { type: "unknown"; nativeType: string; data: unknown }
export interface FallbackContent { type: "fallback"; from: { model: string }; to: { model: string }; reason?: string }
export interface ServerToolContent { type: "anthropicServerTool"; block: unknown }
export type ChatContent = TextContent | ImageContent | ThinkingContent | RedactedThinkingContent | ToolCallContent | FallbackContent | ServerToolContent | UnknownContent;
export type MessageContent = string | readonly ChatContent[];

export interface UserMessage {
	role: "user" | "developer";
	content: MessageContent;
	timestamp: number;
	synthetic?: boolean;
	attribution?: string;
}
export interface AssistantMessage {
	role: "assistant";
	content: readonly ChatContent[];
	model: string;
	provider?: string;
	api?: string;
	usage?: WireUsage;
	stopReason: "stop" | "length" | "toolUse" | "error" | "aborted";
	errorMessage?: string;
	retryRecovery?: RetryRecovery;
	responseId?: string;
	upstreamProvider?: string;
	upstreamModel?: string;
	providerPayload?: unknown;
	inputTransformations?: readonly unknown[];
	toolCallAbortMessages?: Record<string, string>;
	stopDetails?: unknown;
	timestamp: number;
	duration?: number;
	ttft?: number;
	completedAt?: number;
}
export interface ToolResultMessage {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: readonly ChatContent[];
	details?: unknown;
	isError: boolean;
	timestamp: number;
	attribution?: string;
	prunedAt?: number;
}
export interface CustomMessage {
	role: "custom" | "hookMessage";
	customType: string;
	content: MessageContent;
	display: boolean;
	details?: unknown;
	attribution?: string;
	timestamp: number;
}
export interface ExecutionMessage {
	role: "bashExecution" | "pythonExecution";
	command?: string;
	code?: string;
	output: string;
	exitCode?: number;
	cancelled: boolean;
	truncated: boolean;
	images?: readonly ImageContent[];
	meta?: unknown;
	excludeFromContext?: boolean;
	timestamp: number;
}
export interface FileMentionMessage {
	role: "fileMention";
	files: readonly { path: string; content: string; lineCount?: number; byteSize?: number; skippedReason?: "tooLarge" | "binary"; image?: ImageContent }[];
	timestamp: number;
}
export interface SummaryMessage {
	role: "branchSummary" | "compactionSummary";
	summary: string;
	shortSummary?: string;
	fromId?: string;
	tokensBefore?: number;
	tokensAfter?: number;
	method?: string;
	warning?: string;
	blocks?: readonly ChatContent[];
	images?: readonly ImageContent[];
	timestamp: number;
}
export interface UnknownMessage { role: "unknown"; nativeRole: string; timestamp: number; data: unknown }
export type ChatMessage = UserMessage | AssistantMessage | ToolResultMessage | CustomMessage | ExecutionMessage | FileMentionMessage | SummaryMessage | UnknownMessage;
export interface EntryBase { id: string; parentId: string | null; timestamp: string }
export interface MessageEntry extends EntryBase { type: "message"; message: ChatMessage }
export interface CustomMessageEntry extends EntryBase {
	type: "custom_message";
	customType: string;
	content: MessageContent;
	display: boolean;
	details?: unknown;
	attribution?: string;
}
export interface CompactionEntry extends EntryBase {
	type: "compaction";
	summary: string;
	shortSummary?: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	tokensAfter?: number;
	method?: string;
	warning?: string;
	blocks?: readonly ChatContent[];
	images?: readonly ImageContent[];
	preserveData?: unknown;
}
export interface BranchSummaryEntry extends EntryBase { type: "branch_summary"; summary: string; fromId: string }
export interface ModelChangeEntry extends EntryBase { type: "model_change"; model: string; role?: string }
export interface ThinkingLevelEntry extends EntryBase { type: "thinking_level_change"; thinkingLevel?: string | null }
export interface CustomEntry extends EntryBase { type: "custom"; customType: string; data?: unknown }
export interface ResetEntry extends EntryBase { type: "reset_boundary" }
export interface UnknownEntry extends EntryBase { type: "unknown"; nativeType: string; data: unknown }
export type ChatEntry = MessageEntry | CustomMessageEntry | CompactionEntry | BranchSummaryEntry | ModelChangeEntry | ThinkingLevelEntry | CustomEntry | ResetEntry | UnknownEntry;

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const text = (value: unknown): value is string => typeof value === "string";

/** Retain unrecognized provider blocks for reconciliation without displaying internal payloads. */
export function parseChatContent(value: unknown): ChatContent | null {
	if (!isRecord(value) || !text(value.type)) return null;
	switch (value.type) {
		case "text": return text(value.text) ? value as unknown as TextContent : null;
		case "image": return text(value.data) && text(value.mimeType) && /^image\/[a-z0-9.+-]+$/i.test(value.mimeType) ? value as unknown as ImageContent : null;
		case "thinking": return text(value.thinking) ? value as unknown as ThinkingContent : null;
		case "redactedThinking": return text(value.data) ? value as unknown as RedactedThinkingContent : null;
		case "toolCall": return text(value.id) && text(value.name) && isRecord(value.arguments) ? value as unknown as ToolCallContent : null;
		case "fallback": return isRecord(value.from) && text(value.from.model) && isRecord(value.to) && text(value.to.model) ? value as unknown as FallbackContent : null;
		case "anthropicServerTool": return { type: "anthropicServerTool", block: value.block };
		case "unknown": return text(value.nativeType) ? value as unknown as UnknownContent : null;
		default: return { type: "unknown", nativeType: value.type, data: value };
	}
}
function content(value: unknown): MessageContent | null {
	if (text(value)) return value;
	if (!Array.isArray(value)) return null;
	const blocks: ChatContent[] = [];
	for (const raw of value) { const block = parseChatContent(raw); if (block !== null) blocks.push(block); }
	return blocks;
}
export function parseRetryRecovery(value: unknown): RetryRecovery | null {
	if (!isRecord(value) || value.kind !== "auto-retry" || (value.status !== "recovered" && value.status !== "superseded") || !finite(value.attempt) || !text(value.note)) return null;
	if (value.recovery !== "credential" && value.recovery !== "model" && value.recovery !== "wait" && value.recovery !== "plain") return null;
	return value as unknown as RetryRecovery;
}

/** Validate only data this display contract reads; extra native metadata is retained. */
export function parseChatMessage(value: unknown): ChatMessage | null {
	if (!isRecord(value) || !text(value.role) || !finite(value.timestamp)) return null;
	switch (value.role) {
		case "user": case "developer": case "custom": case "hookMessage": {
			const body = content(value.content);
			if (body === null) return null;
			if ((value.role === "custom" || value.role === "hookMessage") && (!text(value.customType) || typeof value.display !== "boolean")) return null;
			return { ...value, content: body } as unknown as UserMessage | CustomMessage;
		}
		case "assistant": {
			const body = content(value.content);
			if (!Array.isArray(body) || !text(value.model) || !["stop", "length", "toolUse", "error", "aborted"].includes(String(value.stopReason))) return null;
			const recovery = parseRetryRecovery(value.retryRecovery);
			return { ...value, content: body, retryRecovery: recovery ?? undefined,
				duration: finite(value.duration) && value.duration >= 0 ? value.duration : undefined,
				ttft: finite(value.ttft) && value.ttft >= 0 ? value.ttft : undefined,
				completedAt: finite(value.completedAt) && value.completedAt >= value.timestamp ? value.completedAt : undefined,
			} as unknown as AssistantMessage;
		}
		case "toolResult": {
			const body = content(value.content);
			if (!Array.isArray(body) || !text(value.toolCallId) || !text(value.toolName) || typeof value.isError !== "boolean") return null;
			return { ...value, content: body } as unknown as ToolResultMessage;
		}
		case "bashExecution": case "pythonExecution":
			return text(value.output) && text(value.role === "bashExecution" ? value.command : value.code) && typeof value.cancelled === "boolean" && typeof value.truncated === "boolean" ? value as unknown as ExecutionMessage : null;
		case "fileMention": {
			if (!Array.isArray(value.files)) return null;
			const files = value.files.filter(file => isRecord(file) && text(file.path) && text(file.content));
			return { ...value, files } as unknown as FileMentionMessage;
		}
		case "branchSummary": case "compactionSummary": return text(value.summary) ? value as unknown as SummaryMessage : null;
		case "unknown": return text(value.nativeRole) ? value as unknown as UnknownMessage : null;
		default: return { role: "unknown", nativeRole: value.role, timestamp: value.timestamp, data: value };
	}
}
export function parseChatEntry(value: unknown): ChatEntry | null {
	if (!isRecord(value) || !text(value.id) || value.id.length === 0 || !text(value.type) || !text(value.timestamp) || (value.parentId !== null && value.parentId !== undefined && !text(value.parentId))) return null;
	const base = { id: value.id, parentId: text(value.parentId) ? value.parentId : null, timestamp: value.timestamp };
	switch (value.type) {
		case "message": { const message = parseChatMessage(value.message); return message === null ? null : { ...base, type: "message", message }; }
		case "custom_message": {
			const body = content(value.content);
			return text(value.customType) && typeof value.display === "boolean" && body !== null ? { ...value, ...base, content: body } as unknown as CustomMessageEntry : null;
		}
		case "custom": return text(value.customType) ? { ...value, ...base } as unknown as CustomEntry : null;
		case "compaction": return text(value.summary) && finite(value.tokensBefore) && text(value.firstKeptEntryId) ? { ...value, ...base } as unknown as CompactionEntry : null;
		case "branch_summary": return text(value.summary) && text(value.fromId) ? { ...value, ...base } as unknown as BranchSummaryEntry : null;
		case "model_change": return text(value.model) ? { ...value, ...base } as unknown as ModelChangeEntry : null;
		case "thinking_level_change": return { ...value, ...base } as unknown as ThinkingLevelEntry;
		case "reset_boundary": return { ...base, type: "reset_boundary" };
		case "unknown": return text(value.nativeType) ? { ...value, ...base } as unknown as UnknownEntry : null;
		default: return { ...base, type: "unknown", nativeType: value.type, data: value };
	}
}
export function entryMessage(entry: ChatEntry): ChatMessage | null {
	if (entry.type === "message") return entry.message;
	if (entry.type === "custom_message") return { ...entry, role: "custom", timestamp: Date.parse(entry.timestamp) };
	return null;
}
export function assistantPersistenceKey(message: AssistantMessage): string {
	return ["assistant", message.timestamp, message.provider ?? "", message.model, message.responseId ?? "", message.stopReason].join(":");
}

/** Native skipped work is neutral, not a failed user operation. */
export function isInterruptedToolResult(message: ToolResultMessage): boolean {
	const details = isRecord(message.details) ? message.details : null;
	return details?.source === "interrupt_skipped" &&
		(details.__synthetic === true || (details.__interrupted === true && details.execution === "started"));
}

export interface AdvisorNote { note: string; severity: "nit" | "concern" | "blocker" | "unknown"; advisor?: string }
/** Only nonempty native notes participate in counts and severity. Unknown severity stays neutral. */
export function advisorNotes(message: CustomMessage): AdvisorNote[] {
	if (!message.display || message.customType !== "advisor" || !isRecord(message.details) || !Array.isArray(message.details.notes)) return [];
	return message.details.notes.flatMap(value => {
		if (!isRecord(value) || typeof value.note !== "string" || !value.note.trim()) return [];
		const severity = value.severity === "nit" || value.severity === "concern" || value.severity === "blocker" ? value.severity : "unknown";
		return [{ note: value.note, severity, ...(typeof value.advisor === "string" && value.advisor.trim() ? { advisor: value.advisor } : {}) } as AdvisorNote];
	});
}

export interface UserSkill { name: string; args: string; prompt: string; reconstructed: boolean }
/** Provenance is native metadata, never prose parsed out of the expanded skill. */
export function userSkill(message: CustomMessage): UserSkill | null {
	if (!message.display || message.customType !== "skill-prompt" || message.attribution !== "user" || !isRecord(message.details)) return null;
	const { name, args, prompt } = message.details;
	if (typeof name !== "string" || !name.trim() || (args !== undefined && typeof args !== "string")) return null;
	if (prompt !== undefined && (typeof prompt !== "string" || !prompt.trim())) return null;
	const argumentsText = typeof args === "string" ? args : "";
	return { name, args: argumentsText, prompt: typeof prompt === "string" ? prompt : `Invoked /skill:${name}${argumentsText ? ` · ${argumentsText}` : ""}`, reconstructed: prompt === undefined };
}
