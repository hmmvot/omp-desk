/** Density-independent semantic cards, mutable replacement and exact call/result ownership. */
import type { ToolCallContent } from "@oh-my-pi/pi-wire";
import { isRecord } from "../guards.ts";
import type { ActiveTool, PendingRow } from "./model.ts";
import { entryMessage, isInterruptedToolResult, type AssistantMessage, type ChatContent, type ChatEntry, type CustomMessage, type ToolResultMessage } from "./messages.ts";
import { todoPhasesFromToolResult } from "./todos.ts";

export interface ProjectedTool {
	call: ToolCallContent;
	entryId: string;
	result?: ToolResultMessage;
	active?: ActiveTool;
	status: "queued" | "running" | "complete" | "error" | "skipped";
	mutable: boolean;
	attachments: readonly CustomMessage[];
}
interface CardBase { id: string; sourceIds: readonly string[] }
export type TranscriptCard =
	| (CardBase & { kind: "entry"; entry: ChatEntry; superseded?: boolean })
	| (CardBase & { kind: "assistant"; message: AssistantMessage; content: readonly ChatContent[]; streaming: boolean })
	| (CardBase & { kind: "tool"; tool: ProjectedTool; ownership: "call" | "orphan" })
	| (CardBase & { kind: "results"; tools: readonly ProjectedTool[] })
	| (CardBase & { kind: "recovery"; message: AssistantMessage });
export interface TranscriptProjectionOptions {
	pending?: ReadonlyMap<string, PendingRow>;
	activeTools?: ReadonlyMap<string, ActiveTool>;
	working?: boolean;
	sealedSeq?: number;
	retrySuppressedIds?: readonly string[];
	stream?: AssistantMessage | null;
	streamId?: string | null;
	cwd?: string;
}
function diagnosticPath(path: string, cwd?: string): string {
	const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
	const root = cwd?.replaceAll("\\", "/").replace(/\/$/, "");
	return root && normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : normalized;
}
export function visibleAssistantContent(block: ChatContent): boolean {
	if (block.type === "text") return block.text.trim().length > 0;
	if (block.type === "thinking") return block.thinking.trim().length > 0;
	return block.type === "image";
}
export function rendersTranscriptEntry(entry: ChatEntry): boolean {
	if (entry.type === "custom" || entry.type === "unknown") return false;
	const message = entryMessage(entry);
	if (message === null) return true;
	if (message.role === "developer" || message.role === "toolResult" || message.role === "unknown") return false;
	if (message.role === "custom" || message.role === "hookMessage") return message.display;
	if (message.role === "assistant") return message.content.some(block => block.type === "toolCall" || visibleAssistantContent(block)) || message.stopReason === "error" || message.stopReason === "aborted";
	return true;
}
/** TUI `isWaitingPollDetails`: a settled wait snapshot whose watched jobs are all still running is a displaceable poll. */
function waitingPoll(tool: ProjectedTool): boolean {
	const details = tool.result?.details;
	return tool.call.name === "wait" && tool.result?.isError !== true && isRecord(details) && Array.isArray(details.jobs) && details.jobs.length > 0 && !(Array.isArray(details.cancelled) && details.cancelled.length > 0) && details.jobs.every(job => isRecord(job) && job.status === "running");
}

export function projectTranscript(entries: readonly ChatEntry[], options: TranscriptProjectionOptions = {}): TranscriptCard[] {
	const results = new Map<string, { message: ToolResultMessage; entryId: string }>();
	const calls = new Map<string, { call: ToolCallContent; entryId: string }>();
	const suppressed = new Set(options.retrySuppressedIds);
	// Only the session-root prefix initializes configuration. A cropped history page must
	// keep its first change, and later differences (including before the first prompt) remain visible.
	let initializing = entries[0]?.parentId === null;
	const models = new Map<string, string>();
	let thinking: string | undefined;
	let activeCompaction: string | null = null;
	for (const entry of entries) {
		if (entry.type === "compaction") activeCompaction = entry.id;
		const message = entryMessage(entry);
		if (message?.role === "toolResult") results.set(message.toolCallId, { message, entryId: entry.id });
		if (message?.role === "assistant") for (const block of message.content) if (block.type === "toolCall") calls.set(block.id, { call: block, entryId: entry.id });
	}
	if (options.stream !== null && options.stream !== undefined) for (const block of options.stream.content) if (block.type === "toolCall") calls.set(block.id, { call: block, entryId: `live:${options.streamId}` });
	const cards: TranscriptCard[] = [];
	const hidden = new Set<string>();
	const hiddenCalls = new Set<string>();
	let todo: Extract<TranscriptCard, { kind: "tool" }> | null = null;
	const emittedCalls = new Set<string>();
	const editableTools: ProjectedTool[] = [];
	const projectedTools = new Map<string, ProjectedTool>();
	const emitTool = (id: string, tool: ProjectedTool, ownership: "call" | "orphan" = "call"): void => {
		if (suppressed.has(tool.call.id) || emittedCalls.has(tool.call.id)) return;
		emittedCalls.add(tool.call.id);
		// Native wait placeholders contain model-only retry guidance, not transcript output.
		if (tool.call.name === "wait" && tool.result && isInterruptedToolResult(tool.result)) return;
		projectedTools.set(tool.call.id, tool);
		if (tool.call.name === "edit" || tool.call.name === "apply_patch" || tool.call.name === "write") editableTools.push(tool);
		const sourceIds = id === tool.entryId ? [id] : [tool.entryId, id];
		const card: Extract<TranscriptCard, { kind: "tool" }> = { kind: "tool", id, sourceIds, tool, ownership };
		if (tool.call.name === "todo") {
			const mutable = tool.mutable && tool.result !== undefined && !tool.result.isError && todoPhasesFromToolResult(tool.result) !== null;
			if (mutable && todo !== null) { hidden.add(todo.id); hiddenCalls.add(todo.tool.call.id); }
			todo = mutable ? card : null;
		}

		cards.push(card);
	};
	const emitAssistant = (entryId: string, message: AssistantMessage, streaming: boolean): void => {
		const recovered = message.retryRecovery?.status;
		let emitted = 0;
		let content: ChatContent[] = [];
		const flush = (): void => {
			if (content.length === 0) return;
			const id = emitted++ === 0 ? entryId : `${entryId}:content:${emitted}`;
			cards.push({ kind: "assistant", id, sourceIds: [entryId, id], message, content, streaming });
			content = [];
		};
		for (const block of message.content) {
			if (block.type !== "toolCall") {
				if (recovered === undefined && visibleAssistantContent(block)) {
					if (content.length && (block.type === "thinking" || content.at(-1)?.type === "thinking")) flush();
					content.push(block);
					if (block.type === "thinking") flush();
				}
				continue;
			}
			flush();
			const result = results.get(block.id);
			const active = options.activeTools?.get(block.id);
			const pendingCall = options.pending?.get(entryId);
			const pendingResult = result === undefined ? undefined : options.pending?.get(result.entryId);
			const mutable = options.working === true && (streaming || active !== undefined || (pendingCall !== undefined && pendingCall.seq > (options.sealedSeq ?? 0)) || (pendingResult !== undefined && pendingResult.seq > (options.sealedSeq ?? 0)));
			const failed = message.stopReason === "error" || message.stopReason === "aborted";
			const status = result !== undefined ? isInterruptedToolResult(result.message) ? "skipped" : result.message.isError ? "error" : "complete" : active !== undefined ? "running" : failed ? message.stopReason === "aborted" ? "skipped" : "error" : mutable ? "queued" : "skipped";
			const id = emitted++ === 0 ? entryId : `${entryId}:tool:${block.id}`;
			emitTool(id, { call: block, entryId, result: result?.message, active, status, mutable, attachments: [] });
		}
		flush();
		if (recovered === "recovered") { cards.push({ kind: "recovery", id: `${entryId}:recovery`, sourceIds: [entryId], message }); }
		else if (recovered === undefined && !streaming && (message.stopReason === "error" || message.stopReason === "aborted")) {
			cards.push({ kind: "assistant", id: emitted === 0 ? entryId : `${entryId}:status`, sourceIds: [entryId], message, content: [], streaming: false });
		}
	};
	for (let index = 0; index < entries.length; index += 1) {
		const entry = entries[index]!;
		if (entry.type === "model_change") {
			const role = entry.role ?? "default";
			const previous = models.get(role);
			models.set(role, entry.model);
			if (previous === entry.model || initializing && previous === undefined) continue;
		} else if (entry.type === "thinking_level_change") {
			const level = entry.thinkingLevel ?? "off";
			const previous = thinking;
			thinking = level;
			if (previous === level || initializing && previous === undefined) continue;
		}
		const message = entryMessage(entry);
		if (message?.role === "user" || message?.role === "assistant" || message?.role === "bashExecution" || message?.role === "pythonExecution") initializing = false;
		if (message?.role === "assistant") { emitAssistant(entry.id, message, entry.id === `live:${options.streamId}` && options.streamId != null); continue; }
		if (message?.role === "toolResult") {
			if (suppressed.has(message.toolCallId) || results.get(message.toolCallId)?.entryId !== entry.id) continue;
			if (message.toolName === "wait" && isInterruptedToolResult(message)) continue;
			const owner = calls.get(message.toolCallId);
			const tool: ProjectedTool = projectedTools.get(message.toolCallId) ?? { entryId: owner?.entryId ?? entry.id, call: owner?.call ?? { type: "toolCall", id: message.toolCallId, name: message.toolName, arguments: {} }, result: message, status: isInterruptedToolResult(message) ? "skipped" : message.isError ? "error" : "complete", mutable: false, attachments: [] };
			if (owner === undefined) emitTool(entry.id, tool, "orphan");
			else cards.push({ kind: "results", id: entry.id, sourceIds: [entry.id], tools: [tool] });
			continue;
		}
		if (!rendersTranscriptEntry(entry)) continue;
		if ((message?.role === "custom" || message?.role === "hookMessage") && message.display && message.customType === "lsp-late-diagnostic" && isRecord(message.details) && Array.isArray(message.details.files)) {
			const unmatched: unknown[] = [];
			const attached = new Map<ProjectedTool, unknown[]>();
			for (const file of message.details.files) {
				if (!isRecord(file) || typeof file.path !== "string") { unmatched.push(file); continue; }
				const wanted = diagnosticPath(file.path, options.cwd);
				let target: ProjectedTool | undefined;
				for (let index = editableTools.length - 1; index >= 0; index -= 1) {
					const tool = editableTools[index]!;
					const args = tool.active?.args ?? tool.call.arguments;
					if (!isRecord(args)) continue;
					const paths: unknown[] = [args.path, args.file_path];
					for (const key of ["edits", "files"]) if (Array.isArray(args[key])) for (const row of args[key]) if (isRecord(row)) paths.push(row.path);
					if (paths.some(path => typeof path === "string" && diagnosticPath(path, options.cwd) === wanted)) { target = tool; break; }
				}
				if (!target) unmatched.push(file);
				else attached.set(target, [...(attached.get(target) ?? []), file]);
			}
			for (const [tool, files] of attached) tool.attachments = [...tool.attachments, { ...message, details: { ...message.details, files } }];
			if (unmatched.length === 0) continue;
			const remainder = { ...message, details: { ...message.details, files: unmatched } };
			cards.push({ kind: "entry", id: entry.id, sourceIds: [entry.id], entry: { type: "message", id: entry.id, parentId: entry.parentId, timestamp: entry.timestamp, message: remainder } });
			continue;
		}
		if (message?.role === "user" || entry.type === "reset_boundary") todo = null;
		if (entry.type === "compaction") {
			const next = entries[index + 1];
			if (next?.type === "compaction" && entry.method === "snapcompact" && next.method === "snapcompact" && next.parentId === entry.id && next.firstKeptEntryId === entry.firstKeptEntryId && next.tokensBefore === entry.tokensBefore) continue;
			cards.push({ kind: "entry", id: entry.id, sourceIds: [entry.id], entry, superseded: entry.id !== activeCompaction });
		} else cards.push({ kind: "entry", id: entry.id, sourceIds: [entry.id], entry });
	}
	if (options.stream !== null && options.stream !== undefined && options.streamId !== null && options.streamId !== undefined) emitAssistant(`live:${options.streamId}`, options.stream, true);
	for (const active of options.activeTools?.values() ?? []) if (!emittedCalls.has(active.toolCallId)) emitTool(`tool:${active.toolCallId}`, { entryId: `tool:${active.toolCallId}`, call: { type: "toolCall", id: active.toolCallId, name: active.toolName, arguments: isRecord(active.args) ? active.args : {} }, active, status: "running", mutable: true, attachments: [] });
	// TUI displaceable poll: a following `wait` call retires a still-running wait snapshot only when no other visible card lies between them.
	let poll: Extract<TranscriptCard, { kind: "tool" }> | null = null;
	for (const card of cards) {
		if (card.kind === "results" || card.kind === "tool" && hidden.has(card.id)) continue;
		if (card.kind === "tool" && card.tool.call.name === "wait") {
			if (poll !== null) { hidden.add(poll.id); hiddenCalls.add(poll.tool.call.id); }
			poll = waitingPoll(card.tool) ? card : null;
		} else poll = null;
	}
	if (hidden.size === 0) return cards;
	const visible: TranscriptCard[] = [];
	for (const card of cards) {
		if (hidden.has(card.id)) continue;
		if (card.kind !== "results") { visible.push(card); continue; }
		const tools = card.tools.filter(tool => !hiddenCalls.has(tool.call.id));
		if (tools.length > 0) visible.push(tools.length === card.tools.length ? card : { ...card, tools });
	}
	return visible;
}
