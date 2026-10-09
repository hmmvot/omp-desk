/**
 * The host-side view of OMP's `--mode rpc-ui` JSONL protocol (written against OMP 18.4.x).
 *
 * OMP's own package cannot be imported, so the subset the extension uses is
 * mirrored here as plain JSON shapes. Everything that arrives from a child is
 * `unknown` until a guard in this module (or `session.ts`) proves the fields it reads.
 *
 * This module also owns the {@link RpcChannel} port: the transport-neutral surface
 * `RpcSession` needs from a broker connection. `RpcHandle` (`src/host/rpc-handle.ts`)
 * implements it; tests implement it with an in-memory fake.
 */
import { parseChatMessage } from "../../chat/messages.ts";
import { parseSubagentFrame } from "../../chat/agents.ts";
import { parseNativeEventFrame } from "../../chat/events.ts";
import type { ChatEventFrame, ChatLiteModel, ChatLiteState, ChatSlashCommand } from "../../chat/model.ts";
import { normalizeQueuedMessages } from "../../chat/model.ts";
import type { AssistantMessage } from "../../chat/messages.ts";
import { isRecord } from "../../guards.ts";

/** What the broker reports about its child. Mapped from the broker's status payload by the handle. */
export interface RpcChildStatus {
	state: "running" | "exited" | "unknown";
	pid: number | null;
	exitCode: number | null;
}

/** Result of one broker attach; the replay lines follow as `line` events. */
export interface RpcAttachResult {
	/** First `seq` the replay starts after (the `sinceSeq` the caller asked for, clamped by the broker). */
	fromSeq: number;
	oldestSeq: number;
	/**
	 * Newest `seq` the ring held when the attach was answered. The replay is complete once a `line` with
	 * `seq >= latestSeq` has been delivered (or immediately when `latestSeq <= fromSeq`).
	 */
	latestSeq: number;
	/** The ring was exceeded: lines between `sinceSeq` and `oldestSeq` are gone. */
	truncated: boolean;
	/** Unanswered dialogs exceeded the broker's pinned budget. */
	pinnedOverflow: boolean;
	rpcProtocol: 1 | 2 | null;
	/** The raw `ready` line, or `null` when the child has not produced it yet. */
	ready: string | null;
	child: RpcChildStatus;
}

export type RpcChannelClosedReason = "child-exited" | "disconnected" | "stopped";

export type RpcChannelEvent =
	/** One COMPLETE stdout line (UTF-8, no trailing newline). Gaps in `seq` are normal. */
	| { type: "line"; seq: number; line: string }
	/**
	 * The child's `ready` line arriving after the attach answered (it is not a ring line, so it has
	 * no `seq` and must never be deduplicated against one). `rpcProtocol` is what the broker then negotiated.
	 */
	| { type: "ready"; line: string; rpcProtocol: 1 | 2 | null }
	| { type: "stderr"; text: string }
	| { type: "child"; status: RpcChildStatus }
	| { type: "closed"; reason: RpcChannelClosedReason };

/** Codes a `writeLine` rejection carries in its `code` property. */
export type RpcWriteErrorCode = "input-not-owner" | "child-exited" | "line-too-long" | "closed";

export interface RpcChannel {
	/**
	 * Connect (or reconnect after a `closed` event) and attach with a replay cursor. Idempotent per
	 * connection: a second call on a live connection re-attaches with the new cursor. The handle claims
	 * input on attach without takeover.
	 */
	attach(request: { sinceSeq: number }): Promise<RpcAttachResult>;
	/** Write one whole stdin line (no trailing newline). Rejects with an error whose `code` is an {@link RpcWriteErrorCode}. */
	writeLine(line: string): Promise<void>;
	/** Subscribe to channel events; returns the unsubscribe function. */
	onEvent(listener: (event: RpcChannelEvent) => void): () => void;
	/** Drop the connection. The child is untouched. */
	disconnect(): void;
}

/** The `code` of a rejected `writeLine`, or `"closed"` when the rejection carries none. */
export function writeErrorCode(error: unknown): RpcWriteErrorCode {
	const code = isRecord(error) ? error.code : undefined;
	switch (code) {
		case "input-not-owner":
		case "child-exited":
		case "line-too-long":
		case "closed":
			return code;
		case "frame-too-large":
			return "line-too-long";
		default:
			return "closed";
	}
}

/** Every command id the extension issues starts with this; the broker retains such small `response` lines. */
export const VSC_ID_PREFIX = "vsc:";
/** Ids of session-internal commands (state/entries/model reads); never retained by the broker. */
export const INTERNAL_ID_PREFIX = "int:";

/** Image content shape OMP's `prompt`/`steer`/`follow_up` accept. */
export interface RpcImage {
	type: "image";
	data: string;
	mimeType: string;
}

export type RpcThinkingLevel = string;

/** Child commands issued by the host; historical child reads never grant page filesystem authority. */
export type RpcCommand =
	/** Without `streamingBehavior`, OMP refuses a prompt that would start a turn while one runs (`AgentBusyError`). */
	| { type: "prompt"; message: string; images?: readonly RpcImage[]; streamingBehavior?: "steer" | "followUp" }
	| { type: "steer"; message: string; images?: readonly RpcImage[] }
	| { type: "follow_up"; message: string; images?: readonly RpcImage[] }
	/** Remove the first pending user message whose queue-chip text is `message` from one queue; the child answers `removed`. */
	| { type: "remove_queued_message"; message: string; queue: "steering" | "followUp" }
	/** Move the first matching follow-up to the end of the steering queue; the child answers `{promoted}` (OMP 18.8.5 `rpc-mode.ts`). */
	| { type: "promote_queued_message"; message: string }
	| { type: "abort" }
	/** Withdraw the user's queued messages, then abort; the child answers `{steering, followUp, imagesDropped?, truncated?}`. */
	| { type: "abort_and_restore_queue" }
	/** Manual compaction; the child answers with its compaction result. */
	| { type: "compact"; customInstructions?: string }
	/** Next role/scoped model; the child answers `null` when there is nothing to cycle to. */
	| { type: "cycle_model" }
	/** Next thinking selector of the live model; `null` when the model has none. */
	| { type: "cycle_thinking_level" }
	/** Render the session to an HTML file; the child answers `{path}`. */
	| { type: "export_html"; outputPath?: string }
	| { type: "get_state" }
	| { type: "get_session_stats" }
	| { type: "set_subagent_subscription"; level: "progress" }
	/** Opt in to one `ask` request per tool call (all questions at once) instead of one `select` per question. */
	| { type: "set_ask_dialog"; enabled: boolean }
	| { type: "get_subagents" }
	| { type: "get_subagent_messages"; subagentId?: string; sessionFile?: string; fromByte?: number }
	| { type: "get_entries"; since?: string }
	| { type: "get_available_commands" }
	| { type: "get_available_models" }
	| { type: "get_available_thinking_levels" }
	| { type: "set_model"; provider: string; modelId: string }
	| { type: "set_thinking_level"; level: RpcThinkingLevel }
	| { type: "set_session_name"; name: string };

export type RpcCommandType = RpcCommand["type"];

/** Serialize one command line (no trailing newline). */
export function encodeCommand(id: string, command: RpcCommand): string {
	return JSON.stringify({ id, ...command });
}

/** The `extension_ui_response` a dialog answer becomes. `answers` settles an `ask`: one entry per question, in request order. */
export type RpcUiAnswer =
	| { value: string }
	| { confirmed: boolean }
	| { answers: readonly { id: string; selectedOptions: readonly string[]; customInput?: string }[] }
	| { cancelled: true; timedOut?: boolean };

export function encodeUiResponse(id: string, answer: RpcUiAnswer): string {
	return JSON.stringify({ type: "extension_ui_response", id, ...answer });
}

export interface RpcResponseFrame {
	type: "response";
	id?: string;
	command: string;
	success: boolean;
	data?: unknown;
	error?: string;
	code?: string;
}

export interface RpcReadyFrame {
	type: "ready";
	protocolVersion: number;
	supportedProtocolVersions: number[];
}

export interface RpcPromptResultFrame {
	type: "prompt_result";
	id?: string;
	agentInvoked: boolean;
	status: "completed" | "aborted" | "error";
	error?: { message: string; retryable?: boolean };
	sessionSettled: boolean;
}

export function isResponseFrame(frame: Record<string, unknown>): frame is Record<string, unknown> & RpcResponseFrame {
	return frame.type === "response" && typeof frame.command === "string" && typeof frame.success === "boolean";
}

export function isPromptResultFrame(
	frame: Record<string, unknown>,
): frame is Record<string, unknown> & RpcPromptResultFrame {
	return (
		frame.type === "prompt_result" &&
		typeof frame.status === "string" &&
		(frame.status === "completed" || frame.status === "aborted" || frame.status === "error")
	);
}

/** `get_state` fields the session reads. Every field is optional because the child is untrusted input. */
export interface RpcToolDescriptor {
	name: string;
	description: string;
}

export interface RpcStateData {
	model?: { provider?: string; id?: string; name?: string; contextWindow?: number };
	thinkingLevel?: string | null;
	isStreaming?: boolean;
	isCompacting?: boolean;
	isSettled?: boolean;
	hasPendingAsyncWork?: boolean;
	sessionFile?: string;
	sessionId?: string;
	sessionName?: string;
	queuedMessageCount?: number;
	queuedMessages?: unknown;
	messageCount?: number;
	contextUsage?: { tokens: number | null; contextWindow: number | null; percent: number | null };
	todoPhases?: unknown;
}

/**
 * The bounded machine code behind every user-visible failure. The extension never forwards arbitrary
 * child text (ADR-0017 principle); a code selects a fixed sentence at the render site.
 */
export type RpcErrorCode =
	| "identity-mismatch"
	| "identity-diverged"
	| "ready-timeout"
	| "state-failed"
	| "history-unreadable"
	| "child-exited"
	| "attach-failed"
	| "write-refused"
	| "not-input-owner"
	| "protocol-error"
	| "state-unavailable";

/** Fixed sentences per code. */
export const RPC_ERROR_SENTENCES: Readonly<Record<RpcErrorCode, string>> = {
	"identity-mismatch": "The running OMP process is not serving this session file.",
	"identity-diverged": "The session identity changed inside the OMP process; this tab is now read-only.",
	"ready-timeout": "OMP did not become ready.",
	"state-failed": "Lost the connection to OMP: it did not answer a state request.",
	"history-unreadable": "The session file could not be read.",
	"child-exited": "The OMP process has exited.",
	"attach-failed": "Lost the connection to the OMP process.",
	"write-refused": "The command could not be delivered to OMP.",
	"not-input-owner": "Another window controls this session.",
	"protocol-error": "OMP sent data this extension could not read.",
	"state-unavailable": "This OMP process cannot serve chat control; the history is shown from disk.",
};

/**
 * Failures that describe a lost or unusable *connection* to a process that may still be running.
 * Reattaching to the same session is safe for these: the attach sequence re-proves identity, so
 * a different or diverged session still ends in its own non-recoverable code. Everything else
 * (identity changes, an exited process, an unreadable file, another window holding input, a
 * process that cannot serve chat) needs a different user action, not a retry.
 */
const RECOVERABLE_FAILURES: Readonly<Partial<Record<RpcErrorCode, true>>> = {
	"attach-failed": true,
	"state-failed": true,
	"ready-timeout": true,
	"protocol-error": true,
	"write-refused": true,
};

/** Whether a failed session with this code may be reconnected in place (page "Reconnect" and the host's own retry). */
export function isRecoverableRpcFailure(code: string | null): boolean {
	return code !== null && Object.hasOwn(RECOVERABLE_FAILURES, code);
}

/**
 * Builtins that change the session's identity, file or process. `new`/`resume`/`fork` have no text-mode
 * handler in rpc and would be sent to the model verbatim; `handoff`/`move` change identity or cwd inside the
 * process; `session` can delete the bound file (`/session delete`), bypassing the delete guards;
 * `quit`/`exit` would end the process from under the tab. `branch` (alias `rewind`) and `tree` open TUI selectors;
 * `/branch` is OMP's in-place rewind selector, not the RPC `branch` command that forks into a new file. The page runs
 * `/rewind` and `/branch` as Chat's own in-place Rewind before anything is sent (ADR-0051), so only a `/branch` with
 * arguments reaches this list. `omp-desk-navigate` is that Rewind's internal command; typed by hand it is refused,
 * never forwarded.
 */
export const DENIED_SLASH_COMMANDS: Readonly<Record<string, true>> = {
	"omp-desk-navigate": true,
	new: true,
	fresh: true,
	resume: true,
	fork: true,
	handoff: true,
	move: true,
	wt: true,
	worktree: true,
	branch: true,
	tree: true,
	session: true,
	delete: true,
	quit: true,
	exit: true,
};

/** The one sentence shown when a denied builtin is typed. */
export const SLASH_DENIED_SENTENCE =
	"This command changes the session's identity or file, so it is not available in the chat. Use the Sessions panel instead.";

/** `/branch` or `/rewind` typed with arguments: both are Chat's Rewind, which takes none (ADR-0051). */
export const REWIND_ARGUMENTS_SENTENCE =
	"Rewind takes no arguments: send /rewind or /branch alone, press Esc twice in an empty composer, or use a message's Rewind action.";

/** The sentence for a denied builtin the page refuses; `command` is the canonical name `classifySlashInput` reported. */
export function slashDeniedSentence(command: string): string {
	return command === "branch" ? REWIND_ARGUMENTS_SENTENCE : SLASH_DENIED_SENTENCE;
}

export type SlashVerdict = { denied: false } | { denied: true; command: string };

/**
 * Whether prompt text is a denied identity-changing builtin. Only a leading `/name` token (case-insensitive, up to
 * whitespace) counts. The command catalog is consulted solely to resolve aliases of denied builtins: an unknown
 * `/foo` (or a pasted `/usr/bin/x fails`) is ordinary text and passes through, exactly as OMP treats it, and a
 * path-like token (`/usr/bin`) has a second `/` and never matches.
 */
export function classifySlashInput(text: string, commands: readonly ChatSlashCommand[] = []): SlashVerdict {
	const match = /^\s*\/([A-Za-z][A-Za-z0-9_-]*)(?=\s|$)/.exec(text);
	if (match === null) return { denied: false };
	const name = match[1]!.toLowerCase();
	if (Object.hasOwn(DENIED_SLASH_COMMANDS, name)) return { denied: true, command: name };
	const owner = commands.find(command => command.aliases?.some(alias => alias.toLowerCase() === name));
	return owner && Object.hasOwn(DENIED_SLASH_COMMANDS, owner.name.toLowerCase()) ? { denied: true, command: owner.name } : { denied: false };
}

function str(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/** The model fields the chat shows, from an rpc `Model` object; `null` when it has no usable identity. */
export function parseLiteModel(value: unknown): ChatLiteModel | null {
	if (!isRecord(value) || typeof value.id !== "string" || typeof value.provider !== "string") return null;
	const name = str(value.name);
	const contextWindow = typeof value.contextWindow === "number" ? value.contextWindow : null;
	return { provider: value.provider, id: value.id, ...(name === undefined ? {} : { name }), contextWindow };
}

export interface ParsedState {
	lite: ChatLiteState;
	sessionFile: string | null;
	sessionId: string | null;
	isSettled: boolean;
	messageCount: number | null;
	todoSeed: unknown;
	dumpTools: readonly RpcToolDescriptor[] | null;
}

/** Provider-facing descriptors only; schemas/examples never cross this host boundary. */
export function parseDumpTools(value: unknown): readonly RpcToolDescriptor[] | null {
	if (!Array.isArray(value) || value.length > 1024) return null;
	const tools: RpcToolDescriptor[] = [];
	const names = new Set<string>();
	for (const tool of value) {
		if (!isRecord(tool) || typeof tool.name !== "string" || !/^[\x21-\x7e]{1,128}$/.test(tool.name) ||
			typeof tool.description !== "string" || tool.description.length > 8192 || names.has(tool.name)) return null;
		names.add(tool.name);
		tools.push({ name: tool.name, description: tool.description });
	}
	return tools;
}

/** The parts of a `get_state` response the session uses; `null` for a payload that is not a state object. */
export function parseStateData(data: unknown): ParsedState | null {
	if (!isRecord(data) || typeof data.isStreaming !== "boolean") return null;
	const usage = data.contextUsage;
	const sessionName = str(data.sessionName);
	const queuedMessages = normalizeQueuedMessages(data.queuedMessages);
	const lite: ChatLiteState = {
		model: parseLiteModel(data.model),
		thinkingLevel: typeof data.thinkingLevel === "string" ? data.thinkingLevel : null,
		isStreaming: data.isStreaming,
		isCompacting: data.isCompacting === true,
		...(typeof data.hasPendingAsyncWork === "boolean" ? { hasPendingAsyncWork: data.hasPendingAsyncWork } : {}),
		...(typeof data.isSettled === "boolean" ? { isSettled: data.isSettled } : {}),
		queuedMessageCount: typeof data.queuedMessageCount === "number" ? data.queuedMessageCount : 0,
		...(queuedMessages === null ? {} : { queuedMessages }),
		...(sessionName === undefined ? {} : { sessionName }),
		...(isRecord(usage)
			? {
					contextUsage: {
						tokens: typeof usage.tokens === "number" ? usage.tokens : null,
						contextWindow: typeof usage.contextWindow === "number" ? usage.contextWindow : null,
						percent: typeof usage.percent === "number" ? usage.percent : null,
					},
				}
			: {}),
	};
	return {
		lite,
		sessionFile: str(data.sessionFile) ?? null,
		sessionId: str(data.sessionId) ?? null,
		isSettled: data.isSettled === true,
		messageCount: typeof data.messageCount === "number" && Number.isSafeInteger(data.messageCount) && data.messageCount >= 0 ? data.messageCount : null,
		todoSeed: data.todoPhases ?? null,
		dumpTools: parseDumpTools(data.dumpTools),
	};
}


/** Stop reason of the last assistant message of the turn in `agent_end.messages`; only this outcome is kept, never the payload. */
function agentEndOutcome(messages: unknown): AssistantMessage["stopReason"] | null {
	if (!Array.isArray(messages)) return null;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message: unknown = messages[index];
		if (!isRecord(message)) continue;
		if (message.role === "user") break;
		if (message.role !== "assistant") continue;
		const reason = message.stopReason;
		return reason === "stop" || reason === "length" || reason === "toolUse" || reason === "error" || reason === "aborted" ? reason : null;
	}
	return null;
}

/**
 * Map one rpc stdout frame to the allow-listed, stripped frame the chat model and the page consume, or `null` for
 * anything else (responses, `ready`, host-tool frames, unknown newer frames). `agent_end.messages`
 * and `message_update.assistantMessageEvent` are never copied: the reducer reads `message` only. Presentation
 * `extension_ui_request` methods are mapped by `session.ts`, not here.
 */
export function toChatEventFrame(frame: Record<string, unknown>, now = 0): ChatEventFrame | null {
	const native = parseSubagentFrame(frame, now) ?? parseNativeEventFrame(frame);
	if (native !== null) return native;
	switch (frame.type) {
		case "agent_start":
		case "turn_start":
		case "turn_end":
		case "session_settled":
		case "model_changed":
		case "todo_auto_clear":
			return { type: frame.type };
		case "agent_end":
			return { type: "agent_end", outcome: agentEndOutcome(frame.messages), ...(typeof frame.isTerminal === "boolean" ? { isTerminal: frame.isTerminal } : {}), ...(typeof frame.yielded === "boolean" ? { yielded: frame.yielded } : {}), ...(typeof frame.awaitingAsyncWork === "boolean" ? { awaitingAsyncWork: frame.awaitingAsyncWork } : {}) };
		case "queue_update": {
			const queuedMessages = normalizeQueuedMessages(frame);
			if (queuedMessages === null) return null;
			// The chip counts every entry OMP listed, including one too large to list here.
			const listed = (frame.steering as readonly unknown[]).length + (frame.followUp as readonly unknown[]).length;
			return { type: "queue_update", queuedMessageCount: listed, queuedMessages };
		}
		case "message_start":
		case "message_update":
		case "message_end": {
			const message = parseChatMessage(frame.message);
			if (typeof frame.messageId !== "string" || message === null) return null;
			return { type: frame.type, messageId: frame.messageId, message };
		}
		case "tool_execution_start": {
			if (typeof frame.toolCallId !== "string" || typeof frame.toolName !== "string") return null;
			const intent = str(frame.intent);
			return {
				type: "tool_execution_start",
				toolCallId: frame.toolCallId,
				toolName: frame.toolName,
				args: frame.args,
				...(intent === undefined ? {} : { intent }),
			};
		}
		case "tool_execution_update":
			if (typeof frame.toolCallId !== "string" || typeof frame.toolName !== "string") return null;
			return {
				type: "tool_execution_update",
				toolCallId: frame.toolCallId,
				toolName: frame.toolName,
				args: frame.args,
				partialResult: frame.partialResult,
			};
		case "tool_stream_update":
			if (typeof frame.toolCallId !== "string" || typeof frame.toolName !== "string") return null;
			return { type: "tool_stream_update", toolCallId: frame.toolCallId, toolName: frame.toolName, update: frame.update };
		case "tool_execution_end":
			if (typeof frame.toolCallId !== "string" || typeof frame.toolName !== "string") return null;
			return {
				type: "tool_execution_end",
				toolCallId: frame.toolCallId,
				toolName: frame.toolName,
				result: frame.result,
				...(typeof frame.isError === "boolean" ? { isError: frame.isError } : {}),
			};
		case "prompt_result":
			if (!isPromptResultFrame(frame)) return null;
			return {
				type: "prompt_result",
				...(typeof frame.id === "string" ? { id: frame.id } : {}),
				status: frame.status,
				agentInvoked: frame.agentInvoked === true,
				sessionSettled: frame.sessionSettled === true,
			};
		case "thinking_level_changed":
			return { type: "thinking_level_changed", thinkingLevel: typeof frame.thinkingLevel === "string" ? frame.thinkingLevel : null };
		case "config_update":
			return {
				type: "config_update",
				...("model" in frame ? { model: parseLiteModel(frame.model) } : {}),
				...("thinkingLevel" in frame
					? { thinkingLevel: typeof frame.thinkingLevel === "string" ? frame.thinkingLevel : null }
					: {}),
			};
		case "session_info_update": {
			const title = str(frame.title);
			return title === undefined ? { type: "session_info_update" } : { type: "session_info_update", title };
		}
		case "available_commands_update":
			if (!Array.isArray(frame.commands)) return null;
			return { type: "available_commands_update", commands: parseCommands(frame.commands) };
		case "command_output":
			return typeof frame.text === "string" ? { type: "command_output", text: frame.text } : null;
		default:
			return null;
	}
}

/** Slash-command catalog entries, bounded and reduced to the fields the composer shows. */
export function parseCommands(commands: readonly unknown[]): ChatSlashCommand[] {
	const result: ChatSlashCommand[] = [];
	for (const command of commands.slice(0, 500)) {
		if (!isRecord(command) || typeof command.name !== "string") continue;
		const description = str(command.description);
		const source = str(command.source);
		const inputHint = isRecord(command.input) ? str(command.input.hint) : str(command.inputHint);
		const aliases = Array.isArray(command.aliases) ? command.aliases.filter((alias): alias is string => typeof alias === "string" && alias.length > 0 && alias.length <= 200).slice(0, 50) : undefined;
		const subcommands = Array.isArray(command.subcommands) ? command.subcommands.flatMap(row => isRecord(row) && typeof row.name === "string" ? [{ name: row.name.slice(0, 200), ...(typeof row.description === "string" ? { description: row.description.slice(0, 500) } : {}), ...(typeof row.usage === "string" ? { usage: row.usage.slice(0, 500) } : {}) }] : []).slice(0, 100) : undefined;
		result.push({
			name: command.name.slice(0, 200),
			...(description === undefined ? {} : { description: description.slice(0, 500) }),
			...(source === undefined ? {} : { source: source.slice(0, 50) }),
			...(inputHint === undefined ? {} : { inputHint: inputHint.slice(0, 500) }),
			...(aliases === undefined ? {} : { aliases }),
			...(subcommands === undefined ? {} : { subcommands }),
		});
	}
	return result;
}
