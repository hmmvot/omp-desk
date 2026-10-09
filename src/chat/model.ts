/**
 * The chat model: one pure reducer shared by the extension host and the Webview page.
 *
 * The host folds rpc-ui frames into it to know a conversation's activity (working, unanswered dialog, last
 * completed reply) whether or not a page is open and to build authoritative snapshots; the page folds the
 * host's `omp:chat-*` messages into it to render. Nothing here reads the clock, the file system, the network
 * or a global: every function returns a new {@link ChatModel} (structural sharing for untouched fields) and
 * time comes in through {@link ChatClock}. Runtime imports are pure transcript, todo and registry helpers.
 *
 * Durable rows are local `ChatEntry` objects from the JSONL file / `get_entries`. A message that ended live
 * (`message_end`, process-local `messageId`) before its entry is durable is held as a *pending row*, a synthetic
 * entry with id `live:<messageId>`, rendered by the same row component and reconciled to the durable entry by
 * role + `message.timestamp` (+ `toolCallId` for results). A pending row is never dropped and never duplicated.
 */
import type { ImageContent } from "@oh-my-pi/pi-wire";
import { assistantPersistenceKey, entryMessage, isInterruptedToolResult, type AssistantMessage, type ChatEntry, type ChatMessage, type RetryErrorUpdate } from "./messages.ts";
import { latestTodoFromEntries, parseTodoPhases, todoPhasesFromEntry, todoPhasesFromToolResult, type TodoProjection } from "./todos.ts";
import { reduceAgentFrame, reduceAgentLiveness, reduceAgentRoster, taskSpawnIdentity, withRegistryRows, type AgentActivity, type AgentIdentities, type AgentIdentity, type RunningAgent, type SpawnLookup, type SubagentFrame } from "./agents.ts";
import type { LiveAgent } from "./agent-liveness.ts";
import type { MaintenanceState, NativeEventFrame, RetryState } from "./events.ts";
import { positionTranscript, type EphemeralItem, type TranscriptPosition } from "./projection.ts";
import { transcriptWindow, type TranscriptWindow } from "../webview/lib/transcript-window.ts";
import type { BranchPoint } from "./rewind.ts";
import type { ChatExitReason } from "./exit-reason.ts";

// Vocabulary

/** Identity of one host instance's snapshot generation. The nonce differs per extension-host start. */
export interface ChatEpoch {
	nonce: string;
	counter: number;
}

/**
 * `RpcSession` phases (`starting → attaching → resyncing → live`, `stopped`, `failed`) plus host-built
 * history phases: `view-only` (stopped, Resume available), `blocked` (ownership refusal, no Resume),
 * and `legacy` (a host from the earlier Collab-based build owns the row; nothing connects).
 */
export type ChatPhase = "starting" | "attaching" | "resyncing" | "live" | "stopped" | "failed" | "view-only" | "blocked" | "legacy";

/** Bounded machine code behind an error phase; the page maps it to a fixed sentence (`RPC_ERROR_SENTENCES`). */
export type ChatCode = string;

export interface ChatHeader {
	id: string;
	cwd: string;
	title?: string;
	timestamp: string;
}

export interface ChatLiteModel {
	provider: string;
	id: string;
	name?: string;
	contextWindow: number | null;
}

/** OMP's displayable queue readback: the exact chip text of each pending user message, oldest first. */
export interface ChatQueuedMessages {
	steering: readonly string[];
	followUp: readonly string[];
	/** Messages OMP reported that the lists leave out (too many or too large); absent when there are none. */
	unlisted?: number;
}

/** The footer state: the part of `get_state` the page renders. */
export interface ChatLiteState {
	model: ChatLiteModel | null;
	thinkingLevel: string | null;
	isStreaming: boolean;
	isCompacting: boolean;
	/** Public all-jobs/delivery observation; absent for older state providers. */
	hasPendingAsyncWork?: boolean;
	isSettled?: boolean;
	queuedMessageCount: number;
	/**
	 * The user-authored pending messages OMP reports (`get_state.queuedMessages`, `queue_update`): the exact
	 * text of each, steering then follow-up, each in delivery order. Absent for a provider that reports none.
	 */
	queuedMessages?: ChatQueuedMessages;
	sessionName?: string;
	contextUsage?: { tokens: number | null; contextWindow: number | null; percent: number | null };
}

export interface ActiveTool {
	toolCallId: string;
	toolName: string;
	args: unknown;
	intent?: string;
	partialResult?: unknown;
	/** Latest `tool_stream_update.update` projection (e.g. a diff preview). */
	streamUpdate?: unknown;
	startedAt: number;
}


/** Latest host-owned command refusal/unknown outcome; no notice history. */
export interface CommandFeedback {
	id: number;
	message: string;
}

/** An extension's `setWidget` block: its lines, shown where the extension placed it relative to the composer. */
export interface ChatWidget {
	lines: readonly string[];
	placement: "aboveEditor" | "belowEditor";
}

/** The latest `notify` warning of an OMP extension; `id` changes per notice so a repeat shows again. */
export interface ExtensionNotice {
	id: number;
	level: "warning";
	message: string;
}

export interface ChatUiOption {
	label: string;
	description?: string;
}

/** One question of the native `ask` tool, as the rich RPC dialog (`set_ask_dialog`) carries it. */
export interface ChatAskQuestion {
	id: string;
	question: string;
	/** Short chip label; the tab shows it instead of the question text. */
	header?: string;
	options: readonly ChatUiOption[];
	multi: boolean;
	/** 0-based index of the recommended option. */
	recommended?: number;
}

/** The answer to one {@link ChatAskQuestion}; `customInput` is the "Other" text. */
export interface ChatAskAnswer {
	id: string;
	selectedOptions: readonly string[];
	customInput?: string;
}

/**
 * One dialog the child asked the user (`extension_ui_request` select|confirm|input|editor|ask).
 * `ask` carries every question of one tool call; its `title` is derived (the first question) so every consumer
 * of a pending dialog still has one line to show.
 */
export type ChatUiRequest =
	| { id: string; method: "select"; title: string; options: readonly ChatUiOption[] }
	| { id: string; method: "confirm"; title: string; message: string }
	| { id: string; method: "input"; title: string; placeholder?: string }
	| { id: string; method: "editor"; title: string; prefill?: string; promptStyle?: boolean }
	| { id: string; method: "ask"; title: string; questions: readonly ChatAskQuestion[] };

/** What the page sends back for a dialog. An `ask` is answered once, with one answer per question in request order. */
export type ChatUiResponse =
	| { id: string; value: string }
	| { id: string; confirmed: boolean }
	| { id: string; answers: readonly ChatAskAnswer[] }
	| { id: string; cancelled: true };

export interface ChatSlashCommand {
	name: string;
	description?: string;
	source?: string;
	inputHint?: string;
	aliases?: readonly string[];
	subcommands?: readonly { name: string; description?: string; usage?: string }[];
}

export interface ChatPromptResult {
	/** The rpc command id (`vsc:<requestId>`), when the frame carried one. */
	id: string | null;
	status: "completed" | "aborted" | "error";
	agentInvoked: boolean;
	sessionSettled: boolean;
}

/** A message that ended live and whose durable entry has not been seen yet. */
export interface PendingRow extends TranscriptPosition {
	/** The synthetic entry id, `live:<messageId>`; also the key in {@link ChatModel.pending}. */
	entryId: string;
	messageId: string;
	role: ChatMessage["role"];
	timestamp: number;
	toolCallId: string | null;
	customType?: string;
	/** Hidden context is persisted and reconciled, but never receives a visible unsaved warning. */
	hidden?: boolean;
	/** Custom rows only: customType + content + details, the identity that survives a differing persist timestamp. */
	fingerprint?: string;
	/** True once the reconcile attempts ran out after the session settled: shown as *not yet saved*. */
	unsaved: boolean;
}

export interface DisplayTurn { id: number; startedAt: number | null; completedAt: number | null; memberKeys: readonly string[]; complete: boolean }

/** The native TUI keeps the last nonempty tool intent until another distinct intent arrives. */
function workingIntent(args: unknown, intent?: string): string | null {
	const value = args !== null && typeof args === "object" && "i" in args ? args.i : intent;
	return typeof value === "string" ? value.trim().replace(/\.+$/, "").trim() || null : null;
}

function messageWorkingIntent(message: AssistantMessage): string | null {
	let latest: string | null = null;
	for (const block of message.content) if (block.type === "toolCall") latest = workingIntent(block.arguments, block.intent) ?? latest;
	return latest;
}

/** Presentation spans engine steps and asks, until the observed turn settles. */
export function chatTurnInProgress(model: ChatModel): boolean {
	return model.phase === "live" && (model.working || model.maintenance?.status === "working" || model.state?.isCompacting === true
		|| !model.settled && model.displayTurns.at(-1)?.complete === false);
}

function finishDisplayTurn(turns: readonly DisplayTurn[], now: number): readonly DisplayTurn[] {
	const last = turns.at(-1);
	if (!last || last.complete) return turns;
	return [...turns.slice(0, -1), { ...last, complete: true, completedAt: now > 0 && (last.startedAt === null || now >= last.startedAt) ? now : null }];
}

export interface ChatModel {
	/** Observed engine invocations; member keys survive pending→durable reconciliation. */
	displayTurns: readonly DisplayTurn[];
	/** Epoch of the last applied snapshot; events with another epoch are dropped. */
	epoch: ChatEpoch | null;
	phase: ChatPhase;
	code: ChatCode | null;
	readOnlyReason: string | null;
	/** Present only after an autonomous managed-RPC child exit. */
	exitReason?: ChatExitReason;
	header: ChatHeader | null;
	/** Durable rows in file order (active path), then pending rows. `durableCount` splits them. */
	entries: readonly ChatEntry[];
	durableCount: number;
	pending: ReadonlyMap<string, PendingRow>;
	/** Rendering rows still on disk above the loaded window. */
	olderCount: number;
	leafId: string | null;
	/** Off-path branches of the active path (ADR-0051), replaced with every authoritative rewrite or snapshot. */
	branches: readonly BranchPoint[];
	state: ChatLiteState | null;
	/** The assistant message being streamed (`message_start`/`message_update`), cleared by its `message_end`. */
	stream: AssistantMessage | null;
	streamId: string | null;
	streamPosition: TranscriptPosition | null;
	sealedSeq: number;
	durablePositions: ReadonlyMap<string, TranscriptPosition>;
	activeTools: ReadonlyMap<string, ActiveTool>;
	/** `agent_start`..`agent_end`, reconciled by `state.isStreaming`. */
	working: boolean;
	/** Latest tool intent for this turn, retained across tool completion and stream gaps. */
	workingIntent: string | null;
	/** Explicit non-terminal agent-end pause awaiting later async delivery. */
	asyncPaused: boolean;
	/** True from `session_settled` until the next `agent_start`. */
	settled: boolean;
	lastPromptResult: ChatPromptResult | null;
	/** Newest assistant outcome since agent_start; live only, never reconstructed from history. */
	lastAgentOutcome: AssistantMessage["stopReason"] | null;
	/** User cancellation vetoes completion notices until a new main run starts. */
	abortRequested: boolean;
	/** FIFO head, and the requests behind it. */
	uiRequest: ChatUiRequest | null;
	uiQueue: readonly ChatUiRequest[];
	todo: TodoProjection | null;
	/** State cut wins over all durable folds for this live generation. */
	todoAuthoritative: boolean;
	agents: ReadonlyMap<string, RunningAgent>;
	agentActivity: ReadonlyMap<string, AgentActivity>;
	/** Type, description and assignment each agent was spawned with, kept after the native roster drops it so a woken agent keeps them. */
	agentIdentity: AgentIdentities;
	agentAvailability: "loading" | "available" | "unavailable";
	maintenance: MaintenanceState | null;
	retry: RetryState | null;
	retrySuppressedIds: readonly string[];
	goal: unknown;
	transcriptEventSeq: number;
	/** Bounded live-only notifications positioned at their arrival point in the transcript. */
	ephemeral: readonly EphemeralItem[];
	commandFeedback: CommandFeedback | null;
	/** One bounded text line from `setStatus`, or null. */
	statusLine: string | null;
	statusEntries: ReadonlyMap<string, string>;
	/** `setWidget` blocks by key, in arrival order. */
	widgets: ReadonlyMap<string, ChatWidget>;
	extensionNotice: ExtensionNotice | null;
	/** `set_editor_text`: the composer prefill request; `seq` changes per request so the same text can repeat. */
	pendingEditorText: { text: string; seq: number } | null;
	commands: readonly ChatSlashCommand[];
	/** Canonical phases from state cuts or the latest live todo update, including an explicit empty array. */
	todoSeed: unknown;
}

/** Time source; injectable so the reducer stays deterministic in tests. */
export interface ChatClock {
	now?: number;
}

export const MAX_EPHEMERAL_ITEMS = 200;
export const MAX_COMMAND_OUTPUTS = 50;
export const MAX_COMMANDS = 500;
export const MAX_STATUS_KEYS = 16;
export const MAX_STATUS_TEXT = 200;
export const MAX_WIDGET_LINES = 100;
export const MAX_COMMAND_FEEDBACK_TEXT = 2_000;
export const MAX_COMMAND_OUTPUT_TEXT = 16_000;

/** Prefix of the synthetic id of a pending row. */
export const PENDING_ID_PREFIX = "live:";

/** Entry types the chat renders or projects from; the host filters `get_entries`/file rows to these. */
export const CHAT_ENTRY_TYPES: Record<string, true> = {
	message: true,
	custom_message: true,
	compaction: true,
	branch_summary: true,
	model_change: true,
	thinking_level_change: true,
	custom: true,
	reset_boundary: true,
	unknown: true,
};

// Frames and payloads (host <-> page)

/**
 * One allow-listed rpc frame as the host forwards it (`omp:chat-event`). `agent_end.messages`
 * are reduced to an optional outcome enum; message-update event internals are stripped.
 * `ui_status`, `ui_widget` and `ui_editor_text` are host-normalized presentation methods of `extension_ui_request`.
 */
export type ChatEventFrame = SubagentFrame | NativeEventFrame
	| { type: "agent_start" }
	| { type: "agent_end"; isTerminal?: boolean; yielded?: boolean; awaitingAsyncWork?: boolean; outcome?: AssistantMessage["stopReason"] | null }
	| { type: "turn_start" }
	| { type: "turn_end" }
	| { type: "message_start"; messageId: string; message: ChatMessage }
	| { type: "message_update"; messageId: string; message: ChatMessage }
	| { type: "message_end"; messageId: string; message: ChatMessage }
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown; intent?: string }
	| { type: "tool_execution_update"; toolCallId: string; toolName: string; args?: unknown; partialResult: unknown }
	| { type: "tool_stream_update"; toolCallId: string; toolName: string; update: unknown }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError?: boolean }
	| ({ type: "prompt_result" } & Omit<ChatPromptResult, "id"> & { id?: string })
	| { type: "session_settled" }
	/** Host-owned intent, not a claim that the child has stopped or settled. */
	| { type: "abort_requested" }
	/** Host-owned only: the child mapper never produces this frame. */
	| { type: "command_feedback"; message: string }
	| { type: "model_changed" }
	| { type: "thinking_level_changed"; thinkingLevel?: string | null; configured?: string; resolved?: string }
	| { type: "config_update"; model?: ChatLiteModel | null; thinkingLevel?: string | null }
	| { type: "session_info_update"; title?: string }
	| { type: "todo_auto_clear" }
	| { type: "available_commands_update"; commands: readonly ChatSlashCommand[] }
	| { type: "command_output"; text: string }
	| { type: "ui_status"; key: string; text: string | null }
	| { type: "ui_widget"; key: string; lines: readonly string[] | null; placement?: "aboveEditor" | "belowEditor" }
	/** An extension's `notify` warning (errors go to the host's error message; `info` is not shown). */
	| { type: "ui_notify"; level: "warning"; message: string }
	| { type: "ui_editor_text"; text: string }
	| { type: "queue_update"; queuedMessageCount: number; queuedMessages: ChatQueuedMessages }
	/** Host-normalized `get_state` refresh: replaces the footer state. */
	| { type: "state_update"; state: ChatLiteState; todoSeed: unknown }
	| { type: "agents_snapshot"; agents: readonly RunningAgent[]; availability: "available" | "unavailable" }
	/** The host-accepted Desk liveness signal (ADR-0053): every subagent the OMP process observes working. */
	| { type: "agents_liveness"; agents: readonly LiveAgent[] };

/** `omp:chat-state`. */
export interface ChatStatePayload {
	epoch: ChatEpoch;
	phase: ChatPhase;
	code: ChatCode | null;
	sessionId: string | null;
	cwd: string | null;
	title: string | null;
	readOnlyReason: string | null;
	exitReason?: ChatExitReason;
}

export interface ChatPendingRowPayload extends TranscriptPosition {
	entry: ChatEntry;
	messageId: string;
	unsaved: boolean;
}

/** `omp:chat-snapshot`: the authoritative reset. Chunked by the transport on `entries`. */
export interface ChatSnapshotPayload {
	epoch: ChatEpoch;
	phase: ChatPhase;
	code: ChatCode | null;
	readOnlyReason: string | null;
	exitReason?: ChatExitReason;
	header: ChatHeader | null;
	/** Durable rows of the tail window in file order. */
	entries: readonly ChatEntry[];
	olderCount: number;
	leafId: string | null;
	/** Off-path branches of the active path; absent means none known. */
	branches?: readonly BranchPoint[];
	state: ChatLiteState | null;
	pending: readonly ChatPendingRowPayload[];
	/** The in-flight assistant message, if any. */
	stream: { messageId: string; message: AssistantMessage } | null;
	activeTools: readonly ActiveTool[];
	working: boolean;
	workingIntent?: string | null;
	settled: boolean;
	asyncPaused?: boolean;
	uiRequests: readonly ChatUiRequest[];
	todoSeed: unknown;
	todoAuthoritative: boolean;
	agents: readonly RunningAgent[];
	agentActivity: readonly { id: string; activity: AgentActivity }[];
	agentIdentities?: readonly (AgentIdentity & { id: string })[];
	agentAvailability: "loading" | "available" | "unavailable";
	maintenance: MaintenanceState | null;
	retry: RetryState | null;
	retrySuppressedIds: readonly string[];
	goal: unknown;
	transcriptEventSeq: number;
	streamPosition?: TranscriptPosition | null;
	sealedSeq?: number;
	durablePositions?: readonly ({ entryId: string } & TranscriptPosition)[];
	ephemeral: readonly EphemeralItem[];
	commands: readonly ChatSlashCommand[];
	displayTurns?: readonly DisplayTurn[];
}

/** `omp:chat-entries`. */
export interface ChatEntriesPayload {
	epoch: ChatEpoch;
	entries: readonly ChatEntry[];
	leafId: string | null;
}

/** `omp:chat-older`. */
export interface ChatOlderPayload {
	epoch: ChatEpoch;
	entries: readonly ChatEntry[];
	olderCount: number;
}

// Construction and helpers

const NO_ENTRIES: readonly ChatEntry[] = Object.freeze([]);
const NO_EPHEMERAL: readonly EphemeralItem[] = Object.freeze([]);
const NO_COMMANDS: readonly ChatSlashCommand[] = Object.freeze([]);
const NO_UI: readonly ChatUiRequest[] = Object.freeze([]);
const EMPTY_PENDING: ReadonlyMap<string, PendingRow> = new Map();
const EMPTY_TOOLS: ReadonlyMap<string, ActiveTool> = new Map();
const EMPTY_STATUS: ReadonlyMap<string, string> = new Map();
const NO_WIDGETS: ReadonlyMap<string, ChatWidget> = new Map();

export function createChatModel(): ChatModel {
	return {
		epoch: null,
		phase: "starting",
		code: null,
		readOnlyReason: null,
		header: null,
		entries: NO_ENTRIES,
		durableCount: 0,
		pending: EMPTY_PENDING,
		olderCount: 0,
		leafId: null,
		branches: [],
		state: null,
		stream: null,
		streamId: null,
		streamPosition: null,
		sealedSeq: 0,
		durablePositions: new Map(),
		displayTurns: [],
		activeTools: EMPTY_TOOLS,
		working: false,
		workingIntent: null,
		asyncPaused: false,
		settled: true,
		lastPromptResult: null,
		lastAgentOutcome: null,
		abortRequested: false,
		uiRequest: null,
		uiQueue: NO_UI,
		todo: null,
		todoAuthoritative: false,
		agents: new Map(),
		agentActivity: new Map(),
		agentIdentity: new Map(),
		agentAvailability: "loading",
		maintenance: null,
		retry: null,
		retrySuppressedIds: [],
		goal: null,
		transcriptEventSeq: 0,
		ephemeral: NO_EPHEMERAL,
		commandFeedback: null,
		statusLine: null,
		statusEntries: EMPTY_STATUS,
		widgets: NO_WIDGETS,
		extensionNotice: null,
		pendingEditorText: null,
		commands: NO_COMMANDS,
		todoSeed: null,
	};
}

export function sameEpoch(a: ChatEpoch | null, b: ChatEpoch | null): boolean {
	return a !== null && b !== null && a.nonce === b.nonce && a.counter === b.counter;
}

function clampText(text: string, max: number): string {
	// Control characters other than tab/newline are dropped: the text is rendered as plain text only.
	// oxlint-disable-next-line no-control-regex
	const clean = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
	return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The most queued messages per kind the model keeps; the count chip stays accurate beyond it. */
export const MAX_QUEUED_ITEMS = 50;
/**
 * Bytes (JSON-encoded, UTF-8) of all listed queued messages together. The readback rides in `get_state` snapshots
 * and `queue_update` events, which the bridge route carries in frames of at most 256 KiB and a snapshot head is
 * never split, so the list must leave the rest of the state room in the narrowest route.
 */
export const MAX_QUEUED_TOTAL_BYTES = 128 * 1024;
/** A cheap upper bound on the characters of one listable message (a character is at least one byte). */
export const MAX_QUEUED_TEXT_LENGTH = MAX_QUEUED_TOTAL_BYTES;

/** The UTF-8 size of `text` as a JSON string, escapes and quotes included. */
export function queuedJsonBytes(text: string): number {
	const json = JSON.stringify(text);
	let bytes = 0;
	for (let index = 0; index < json.length; index += 1) {
		const code = json.charCodeAt(index);
		if (code < 0x80) bytes += 1;
		else if (code < 0x800) bytes += 2;
		else if (code >= 0xd800 && code <= 0xdbff) {
			bytes += 4;
			index += 1;
		} else bytes += 3;
	}
	return bytes;
}

/**
 * Bound OMP's `queuedMessages` readback (`get_state`) or `queue_update` lists. The text is **never** cleaned or
 * clamped: `remove_queued_message` matches it exactly, so a changed character would make a listed message
 * impossible to remove. A message that does not fit (too many, too large, or past the total) is left out of the
 * list rather than listed in a form that could not be acted on, and is counted in `unlisted` so the row can say
 * so. `null` for a value that is not a queue readback.
 */
export function normalizeQueuedMessages(value: unknown): ChatQueuedMessages | null {
	if (!isObject(value) || !Array.isArray(value.steering) || !Array.isArray(value.followUp)) return null;
	let total = 0;
	// A readback this module already normalized (host → page) carries its own count of what it left out.
	let unlisted = typeof value.unlisted === "number" && Number.isSafeInteger(value.unlisted) && value.unlisted > 0 ? value.unlisted : 0;
	const take = (items: readonly unknown[]): string[] => {
		const kept: string[] = [];
		for (const item of items) {
			if (typeof item !== "string") continue;
			const bytes = item.length > MAX_QUEUED_TEXT_LENGTH || kept.length >= MAX_QUEUED_ITEMS ? Infinity : queuedJsonBytes(item);
			if (total + bytes > MAX_QUEUED_TOTAL_BYTES) {
				unlisted += 1;
				continue;
			}
			total += bytes;
			kept.push(item);
		}
		return kept;
	};
	const steering = take(value.steering);
	const followUp = take(value.followUp);
	return unlisted === 0 ? { steering, followUp } : { steering, followUp, unlisted };
}

/** Whether two queue readbacks list the same messages in the same order. */
export function sameQueuedMessages(a: ChatQueuedMessages, b: ChatQueuedMessages): boolean {
	const same = (x: readonly string[], y: readonly string[]): boolean => x.length === y.length && x.every((text, index) => text === y[index]);
	return same(a.steering, b.steering) && same(a.followUp, b.followUp) && (a.unlisted ?? 0) === (b.unlisted ?? 0);
}

function pendingEntryId(messageId: string): string {
	return `${PENDING_ID_PREFIX}${messageId}`;
}

/** Whether `id` is the synthetic entry id of a pending row. */
export function isPendingEntryId(id: string): boolean {
	return id.startsWith(PENDING_ID_PREFIX);
}

/** Live custom messages share the saved custom_message identity, not its entry type. */
function messageKey(message: ChatMessage): { role: ChatMessage["role"]; timestamp: number; toolCallId: string | null; customType?: string } {
	return {
		role: message.role === "hookMessage" ? "custom" : message.role,
		timestamp: message.timestamp,
		toolCallId: message.role === "toolResult" ? message.toolCallId : null,
		...(message.role === "custom" || message.role === "hookMessage" ? { customType: message.customType } : {}),
	};
}

/** How far a saved custom entry's own timestamp may sit from the live message's: OMP stamps some entries at append time, not with the message. */
const CUSTOM_RECONCILE_WINDOW_MS = 60_000;
const fingerprints = new WeakMap<object, string>();

/** What a custom message says, independent of when it was stamped; memoized per message object. */
function customFingerprint(message: ChatMessage): string | undefined {
	if (message.role !== "custom" && message.role !== "hookMessage") return undefined;
	let fingerprint = fingerprints.get(message);
	if (fingerprint === undefined) {
		fingerprint = JSON.stringify([message.customType, message.content, message.details ?? null]);
		fingerprints.set(message, fingerprint);
	}
	return fingerprint;
}

type MessageIdentity = { role: string; timestamp: number; toolCallId: string | null; customType?: string; fingerprint?: string };

/**
 * Whether `message` is the saved form of a held identity: the exact role/timestamp/toolCallId/customType, or for a
 * custom message the same content within {@link CUSTOM_RECONCILE_WINDOW_MS} (sendCustomMessage and plan-mode IRC persist
 * with the append time, so their entry timestamp differs from the live message's).
 */
function matchesIdentity(held: MessageIdentity, message: ChatMessage, exact: boolean): boolean {
	const candidate = messageKey(message);
	if (candidate.role !== held.role || candidate.toolCallId !== held.toolCallId || candidate.customType !== held.customType) return false;
	if (candidate.timestamp === held.timestamp) return true;
	if (exact || held.fingerprint === undefined || Math.abs(candidate.timestamp - held.timestamp) > CUSTOM_RECONCILE_WINDOW_MS) return false;
	return customFingerprint(message) === held.fingerprint;
}

function matchingPending(pending: ReadonlyMap<string, PendingRow>, message: ChatMessage, fuzzy = true): string | undefined {
	for (const exact of fuzzy ? [true, false] : [true]) for (const [entryId, held] of pending) if (matchesIdentity(held, message, exact)) return entryId;
	return undefined;
}

function entryMatches(entry: ChatEntry, held: MessageIdentity): boolean {
	const message = entryMessage(entry);
	return message !== null && matchesIdentity(held, message, false);
}

/**
 * Whether a live message's durable entry is already in the loaded durable rows, or older than the window (the
 * durable rows are a prefix of the ended messages, so anything older than the oldest loaded message is durable).
 * A ring replay after a reattach re-delivers such `message_end`s; they must not become pending rows.
 */
function isAlreadyDurable(model: ChatModel, message: ChatMessage): boolean {
	const key: MessageIdentity = { ...messageKey(message), fingerprint: customFingerprint(message) };
	let oldest = Number.POSITIVE_INFINITY;
	for (let index = 0; index < model.durableCount; index += 1) {
		const entry = model.entries[index];
		if (entry === undefined) continue;
		if (entryMatches(entry, key)) return true;
		const candidate = entryMessage(entry);
		if (candidate !== null && candidate.timestamp < oldest) oldest = candidate.timestamp;
	}
	return model.olderCount > 0 && key.timestamp < oldest;
}

/** Durable folds never overwrite a live state cut, nor do older-page folds change canonical state. */
function reproject(model: ChatModel, clock: ChatClock): ChatModel {
	if (model.todoAuthoritative) return model;
	const candidate = latestTodoFromEntries(model.entries);
	const phases = candidate?.phases ?? parseTodoPhases(model.todoSeed);
	return { ...model, todo: phases === null ? null : { phases, entryId: candidate?.entryId ?? null, appliedAt: clock.now ?? 0 } };
}

function withPending(model: ChatModel, durable: readonly ChatEntry[], pending: ReadonlyMap<string, PendingRow>, pendingEntries: readonly ChatEntry[]): ChatModel {
	return {
		...model,
		entries: pendingEntries.length === 0 ? durable : [...durable, ...pendingEntries],
		durableCount: durable.length,
		pending,
	};
}

function durableRows(model: ChatModel): readonly ChatEntry[] {
	return model.entries.slice(0, model.durableCount);
}

function pendingEntries(model: ChatModel): ChatEntry[] {
	return model.entries.slice(model.durableCount);
}

/** Follow reconciliation/eviction redirects without moving the durable partition. */
function redirectedAnchor(anchor: string | null, redirects: ReadonlyMap<string, string | null>): string | null {
	const visited = new Set<string>();
	while (anchor !== null && redirects.has(anchor) && !visited.has(anchor)) {
		visited.add(anchor);
		anchor = redirects.get(anchor) ?? null;
	}
	return anchor;
}

function retargetPositions(model: ChatModel, redirects: ReadonlyMap<string, string | null>): ChatModel {
	if (redirects.size === 0) return model;
	const pending = new Map(model.pending);
	for (const [id, row] of pending) {
		const anchorId = redirectedAnchor(row.anchorId, redirects);
		if (anchorId !== row.anchorId) pending.set(id, { ...row, anchorId });
	}
	const ephemeral = model.ephemeral.map(item => {
		const anchorId = redirectedAnchor(item.anchorId, redirects);
		return anchorId === item.anchorId ? item : { ...item, anchorId };
	});
	const durablePositions = new Map(model.durablePositions);
	for (const [id, position] of durablePositions) durablePositions.set(id, { ...position, anchorId: redirectedAnchor(position.anchorId, redirects) });
	const streamPosition = model.streamPosition === null ? null : { ...model.streamPosition, anchorId: redirectedAnchor(model.streamPosition.anchorId, redirects) };
	return { ...model, pending, ephemeral, streamPosition, durablePositions };
}

function appendEphemeral(model: ChatModel, kind: string, payload: unknown, timestamp: number, id?: string): ChatModel {
	const seq = model.transcriptEventSeq + 1;
	const anchorId = positionTranscript(model.entries, model.durableCount, model.pending, model.ephemeral, model.stream && model.streamId && model.streamPosition ? { message: model.stream, messageId: model.streamId, position: model.streamPosition } : null, model.durablePositions).at(-1)?.id ?? null;
	const items = [...model.ephemeral, { id: id ?? `event:${seq}`, seq, anchorId, timestamp, kind, payload }];
	const redirects = new Map<string, string | null>();
	const retained: EphemeralItem[] = [];
	let commands = 0;
	for (let index = items.length - 1; index >= 0; index -= 1) {
		const item = items[index]!;
		if (item.kind === "command_output") commands += 1;
		if (retained.length >= MAX_EPHEMERAL_ITEMS || (item.kind === "command_output" && commands > MAX_COMMAND_OUTPUTS)) redirects.set(item.id, item.anchorId);
		else retained.push(item);
	}
	return retargetPositions({ ...model, transcriptEventSeq: seq, ephemeral: retained.reverse() }, redirects);
}

/** Native recovery annotates already-held rows; incremental entry-id dedup cannot apply these patches. */
function patchRetryErrors(model: ChatModel, updates: readonly RetryErrorUpdate[]): ChatModel {
	if (updates.length === 0) return model;
	const byId = new Map(updates.map(update => [update.entryId, update]));
	const byKey = new Map(updates.filter(update => update.persistenceKey !== undefined).map(update => [update.persistenceKey!, update]));
	let changed = false;
	const entries = model.entries.map(entry => {
		if (entry.type !== "message" || entry.message.role !== "assistant") return entry;
		const update = byId.get(entry.id) ?? byKey.get(assistantPersistenceKey(entry.message));
		if (update === undefined) return entry;
		changed = true;
		return { ...entry, message: { ...entry.message, errorMessage: update.note, retryRecovery: update.retryRecovery } };
	});
	if (!changed) return model;
	const synthetic = new Set<string>();
	for (const entry of entries) if (entry.type === "message" && entry.message.role === "toolResult" && isInterruptedToolResult(entry.message)) synthetic.add(entry.message.toolCallId);
	const suppressed = new Set(model.retrySuppressedIds);
	for (const entry of entries) if (entry.type === "message" && entry.message.role === "assistant" && entry.message.retryRecovery?.status === "superseded") {
		for (const block of entry.message.content) if (block.type === "toolCall" && synthetic.has(block.id)) suppressed.add(block.id);
	}
	return { ...model, entries, retrySuppressedIds: [...suppressed] };
}

// Snapshot, state

/** Authoritative snapshot reset; local feedback and editor text survive. */
export function applyChatSnapshot(model: ChatModel, snapshot: ChatSnapshotPayload, clock: ChatClock = {}): ChatModel {
	const todoPhases = parseTodoPhases(snapshot.todoSeed);
	const agents = new Map(snapshot.agents.map(agent => [agent.id, agent]));
	const pending = new Map<string, PendingRow>();
	const pendingRows: ChatEntry[] = [];
	for (const row of snapshot.pending) {
		const message = entryMessage(row.entry);
		if (message === null) continue;
		const key = messageKey(message);
		pending.set(row.entry.id, { entryId: row.entry.id, messageId: row.messageId, ...key, fingerprint: customFingerprint(message), unsaved: row.unsaved, anchorId: row.anchorId, seq: row.seq, hidden: (message.role === "custom" || message.role === "hookMessage") && !message.display });
		pendingRows.push(row.entry);
	}
	const durable = [...snapshot.entries];
	const tools = new Map<string, ActiveTool>();
	for (const tool of snapshot.activeTools) tools.set(tool.toolCallId, tool);
	const [head, ...rest] = snapshot.uiRequests;
	return reproject(
		{
			...model,
			epoch: snapshot.epoch,
			phase: snapshot.phase,
			code: snapshot.code,
			readOnlyReason: snapshot.readOnlyReason,
			exitReason: snapshot.exitReason,
			header: snapshot.header,
			entries: pendingRows.length === 0 ? durable : [...durable, ...pendingRows],
			durableCount: durable.length,
			pending,
			olderCount: snapshot.olderCount,
			leafId: snapshot.leafId,
			branches: snapshot.branches ?? [],
			state: snapshot.state,
			stream: snapshot.stream?.message ?? null,
			streamId: snapshot.stream?.messageId ?? null,
			streamPosition: snapshot.streamPosition ?? null,
			sealedSeq: snapshot.sealedSeq ?? 0,
			durablePositions: new Map((snapshot.durablePositions ?? []).map(row => [row.entryId, { anchorId: row.anchorId, seq: row.seq }])),
			activeTools: tools,
			working: snapshot.working,
			workingIntent: snapshot.workingIntent ?? null,
			settled: snapshot.settled,
			asyncPaused: snapshot.asyncPaused ?? false,
			displayTurns: snapshot.displayTurns ?? [],
			lastPromptResult: null,
			lastAgentOutcome: null,
			abortRequested: false,
			uiRequest: head ?? null,
			uiQueue: rest,
			todoSeed: snapshot.todoSeed,
			todo: todoPhases === null ? null : { phases: todoPhases, entryId: null, appliedAt: clock.now ?? 0 },
			todoAuthoritative: snapshot.todoAuthoritative,
			agents,
			agentActivity: new Map(snapshot.agentActivity.filter(row => agents.has(row.id)).map(row => [row.id, row.activity])),
			agentIdentity: new Map((snapshot.agentIdentities ?? []).map(({ id, ...identity }) => [id, identity])),
			agentAvailability: snapshot.agentAvailability,
			maintenance: snapshot.maintenance,
			retry: snapshot.retry,
			retrySuppressedIds: snapshot.retrySuppressedIds,
			goal: snapshot.goal,
			transcriptEventSeq: snapshot.transcriptEventSeq,
			ephemeral: snapshot.ephemeral,
			commands: snapshot.commands,
		},
		clock,
	);
}

/** Apply `omp:chat-state`; a state for another epoch than the current snapshot is dropped. */
export function applyChatState(model: ChatModel, payload: ChatStatePayload): ChatModel {
	if (model.epoch !== null && payload.epoch.nonce === model.epoch.nonce && payload.epoch.counter < model.epoch.counter) return model;
	const header =
		model.header !== null && payload.title !== null && payload.title !== model.header.title
			? { ...model.header, title: payload.title }
			: model.header;
	return setChatPhase({ ...model, header, exitReason: payload.exitReason }, payload.phase, payload.code, payload.readOnlyReason);
}

/** Apply a get_state cut atomically; phases cross host→page on every refresh. */
export function applyChatLiteState(model: ChatModel, state: ChatLiteState, todoSeed: unknown, clock: ChatClock = {}): ChatModel {
	const phases = parseTodoPhases(todoSeed);
	const settled = !state.isStreaming && !state.isCompacting && state.hasPendingAsyncWork !== true
		&& (state.isSettled === undefined ? model.settled : state.isSettled);
	const asyncPaused = state.hasPendingAsyncWork === undefined
		? settled ? false : model.asyncPaused
		: state.hasPendingAsyncWork && !state.isStreaming;
	return {
		...model, state, working: state.isStreaming, asyncPaused, settled,
		displayTurns: settled ? finishDisplayTurn(model.displayTurns, clock.now ?? 0) : model.displayTurns,
		activeTools: state.isStreaming ? model.activeTools : EMPTY_TOOLS,
		todoSeed: phases ?? model.todoSeed,
		todo: phases === null ? model.todo : { phases, entryId: null, appliedAt: clock.now ?? 0 },
		todoAuthoritative: true,
	};
}

/** Set the phase and code (host side: `RpcSession` transitions). */
export function setChatPhase(model: ChatModel, phase: ChatPhase, code: ChatCode | null, readOnlyReason: string | null = model.readOnlyReason): ChatModel {
	if (model.phase === phase && model.code === code && model.readOnlyReason === readOnlyReason) return model;
	const resetAgents = phase === "resyncing" || phase === "stopped" || phase === "failed" || phase === "view-only" || phase === "blocked" || phase === "legacy";
	return { ...model, phase, code, readOnlyReason,
		...(resetAgents ? { asyncPaused: false, lastPromptResult: null, lastAgentOutcome: null, agents: new Map(), agentActivity: new Map(), agentAvailability: phase === "resyncing" ? "loading" as const : "unavailable" as const } : {}),
		...(phase === "resyncing" || phase === "view-only" || phase === "stopped" ? { todoAuthoritative: false } : {}),
	};
}

// Events

/**
 * Fold one forwarded frame. A frame whose epoch is not the model's current one belongs to another generation
 * (before the page's last snapshot, or a previous host) and is dropped.
 */
export function applyChatEvent(model: ChatModel, epoch: ChatEpoch | null, frame: ChatEventFrame, clock: ChatClock = {}): ChatModel {
	if (!sameEpoch(model.epoch, epoch)) return model;
	return reduceChatFrame(model, frame, clock);
}

/** What the transcript's own `task` call recorded about an agent, for an agent the roster knows nothing else of. */
function spawnLookup(model: ChatModel): SpawnLookup {
	return id => taskSpawnIdentity(model.entries, id);
}

/**
 * The epoch-free core of {@link applyChatEvent}: the host folds frames it reads itself with this (its shadow
 * model has no page epoch to compare against).
 */
export function reduceChatFrame(model: ChatModel, frame: ChatEventFrame, clock: ChatClock = {}): ChatModel {
	const now = clock.now ?? 0;
	switch (frame.type) {
		case "subagent_lifecycle":
		case "subagent_progress":
		case "subagent_event":
			return { ...model, ...reduceAgentFrame(model.agents, model.agentActivity, model.agentIdentity, frame, now, spawnLookup(model)) };
		case "agents_snapshot": {
			const roster = reduceAgentRoster(frame.agents, model.agentIdentity, spawnLookup(model));
			const agents = withRegistryRows(roster.agents, model.agents);
			return { ...model, agents, agentIdentity: roster.agentIdentity, agentAvailability: frame.availability, agentActivity: new Map([...model.agentActivity].filter(([id]) => agents.has(id))) };
		}
		case "agents_liveness":
			return { ...model, ...reduceAgentLiveness(model.agents, model.agentActivity, model.agentIdentity, frame.agents, now, spawnLookup(model)) };
		case "auto_compaction_start":
			return { ...model, maintenance: { action: frame.action, reason: frame.reason, status: "working" } };
		case "auto_compaction_end": {
			const maintenance: MaintenanceState = { action: frame.action, status: frame.aborted ? "cancelled" : frame.skipped ? "skipped" : frame.errorMessage ? "failed" : "complete", errorMessage: frame.errorMessage, willRetry: frame.willRetry };
			return appendEphemeral({ ...model, maintenance }, "maintenance", maintenance, now);
		}
		case "auto_retry_start": {
			const retry: RetryState = { attempt: frame.attempt, maxAttempts: frame.maxAttempts, delayMs: frame.delayMs, errorMessage: frame.errorMessage, status: "waiting" };
			return appendEphemeral({ ...model, retry }, "retry", retry, now);
		}
		case "auto_retry_end": {
			const patched = patchRetryErrors(model, frame.retryErrors ?? []);
			const retry: RetryState = { attempt: frame.attempt, maxAttempts: model.retry?.maxAttempts ?? frame.attempt, delayMs: 0, errorMessage: frame.finalError ?? "", status: frame.success ? "recovered" : "failed" };
			const index = patched.ephemeral.findLastIndex(item => item.kind === "retry" && isObject(item.payload) && item.payload.attempt === frame.attempt && item.payload.status === "waiting");
			if (index < 0) return { ...patched, retry };
			const ephemeral = [...patched.ephemeral];
			ephemeral[index] = { ...ephemeral[index]!, payload: retry };
			return { ...patched, retry, ephemeral };
		}
		case "retry_fallback_applied":
		case "retry_fallback_succeeded":
		case "todo_reminder":
			return appendEphemeral(model, frame.type, frame, now);
		case "notice":
			// OMP announces xd:// device mounts for the model's benefit; in Chat they only list tool names.
			if (frame.level === "info" && frame.source === "xdev") return model;
			return appendEphemeral(model, frame.type, frame, now);
		case "ttsr_triggered": {
			const last = positionTranscript(model.entries, model.durableCount, model.pending, model.ephemeral, model.stream && model.streamId && model.streamPosition ? { message: model.stream, messageId: model.streamId, position: model.streamPosition } : null, model.durablePositions).at(-1);
			const previous = model.ephemeral.at(-1);
			if (previous?.kind === frame.type && previous.id === last?.id && isObject(previous.payload) && Array.isArray(previous.payload.rules)) {
				return { ...model, ephemeral: [...model.ephemeral.slice(0, -1), { ...previous, payload: { ...frame, rules: [...previous.payload.rules, ...frame.rules] } }] };
			}
			return appendEphemeral(model, frame.type, frame, now);
		}
		case "irc_message":
			return observeIrc(model, frame.message, clock);
		case "goal_updated":
			return appendEphemeral({ ...model, goal: frame.goal }, "goal_updated", frame, now);
		case "config_warnings_changed":
		case "advisor_cost_changed":
		case "advisor_yielded":
			return model;
		case "agent_start": {
			const last = model.displayTurns.at(-1);
			const displayTurns = last && !last.complete ? model.displayTurns : [...model.displayTurns.slice(-199), { id: (last?.id ?? 0) + 1, startedAt: now > 0 ? now : null, completedAt: null, memberKeys: [], complete: false }];
			return { ...model, displayTurns, workingIntent: last && !last.complete ? model.workingIntent : null, working: true, asyncPaused: false, settled: false, lastPromptResult: null, lastAgentOutcome: null, abortRequested: false };
		}
		case "agent_end": {
			const asyncPaused = frame.isTerminal === false || frame.awaitingAsyncWork === true;
			return { ...model, working: false, asyncPaused, settled: asyncPaused ? false : model.settled, lastAgentOutcome: frame.outcome ?? model.lastAgentOutcome, activeTools: model.activeTools.size === 0 ? model.activeTools : EMPTY_TOOLS };
		}
		case "abort_requested":
			return { ...model, abortRequested: true };
		case "message_start":
		case "message_update": {
			if (frame.message.role !== "assistant") return model;
			model = { ...model, workingIntent: messageWorkingIntent(frame.message) ?? model.workingIntent };
			if (model.streamId === frame.messageId) return { ...model, stream: frame.message };
			const seq = model.transcriptEventSeq + 1;
			const anchorId = positionTranscript(model.entries, model.durableCount, model.pending, model.ephemeral, null, model.durablePositions).at(-1)?.id ?? null;
			return { ...model, stream: frame.message, streamId: frame.messageId, streamPosition: { anchorId, seq }, transcriptEventSeq: seq };
		}
		case "message_end":
			return reduceMessageEnd(frame.message.role === "assistant" ? { ...model, workingIntent: messageWorkingIntent(frame.message) ?? model.workingIntent } : model, frame.messageId, frame.message, clock);
		case "tool_execution_start": {
			const tool: ActiveTool = {
				toolCallId: frame.toolCallId,
				toolName: frame.toolName,
				args: frame.args,
				intent: frame.intent,
				startedAt: now,
			};
			return { ...model, workingIntent: workingIntent(frame.args, frame.intent) ?? model.workingIntent, activeTools: new Map(model.activeTools).set(frame.toolCallId, tool) };
		}
		case "tool_execution_update": {
			const existing = model.activeTools.get(frame.toolCallId);
			const tool: ActiveTool = existing
				? { ...existing, partialResult: frame.partialResult }
				: { toolCallId: frame.toolCallId, toolName: frame.toolName, args: frame.args, partialResult: frame.partialResult, startedAt: now };
			return { ...model, workingIntent: existing ? model.workingIntent : workingIntent(frame.args) ?? model.workingIntent, activeTools: new Map(model.activeTools).set(frame.toolCallId, tool) };
		}
		case "tool_stream_update": {
			const existing = model.activeTools.get(frame.toolCallId);
			const tool: ActiveTool = existing
				? { ...existing, streamUpdate: frame.update }
				: { toolCallId: frame.toolCallId, toolName: frame.toolName, args: undefined, streamUpdate: frame.update, startedAt: now };
			return { ...model, activeTools: new Map(model.activeTools).set(frame.toolCallId, tool) };
		}
		case "tool_execution_end": {
			const tools = new Map(model.activeTools);
			tools.delete(frame.toolCallId);
			const phases = frame.toolName === "todo" && frame.isError !== true ? todoPhasesFromToolResult(frame.result) : null;
			return { ...model, activeTools: tools,
				...(phases !== null ? { todoSeed: phases, todo: { phases, entryId: null, appliedAt: now } } : {}),
			};
		}
		case "prompt_result":
			return {
				...model,
				displayTurns: frame.sessionSettled && !model.asyncPaused ? finishDisplayTurn(model.displayTurns, now) : model.displayTurns,
				lastPromptResult: {
					id: typeof frame.id === "string" ? frame.id : null,
					status: frame.status,
					agentInvoked: frame.agentInvoked,
					sessionSettled: frame.sessionSettled,
				},
				settled: frame.sessionSettled && !model.asyncPaused ? true : model.settled,
				working: frame.sessionSettled && !model.asyncPaused ? false : model.working,
			};
		case "session_settled":
			if (model.asyncPaused) return model;
			return { ...model, displayTurns: finishDisplayTurn(model.displayTurns, now), settled: true, working: false, activeTools: model.activeTools.size === 0 ? model.activeTools : EMPTY_TOOLS };
		case "command_feedback":
			return { ...model, commandFeedback: { id: (model.commandFeedback?.id ?? 0) + 1, message: clampText(frame.message, MAX_COMMAND_FEEDBACK_TEXT) } };
		case "model_changed":
			return model;
		case "turn_start":
		case "turn_end":
			return { ...model, sealedSeq: model.transcriptEventSeq };
		case "queue_update": {
			if (model.state === null) return model;
			const sameQueue = model.state.queuedMessages !== undefined && sameQueuedMessages(model.state.queuedMessages, frame.queuedMessages);
			if (model.state.queuedMessageCount === frame.queuedMessageCount && sameQueue) return model;
			return { ...model, state: { ...model.state, queuedMessageCount: frame.queuedMessageCount, queuedMessages: frame.queuedMessages } };
		}
		case "thinking_level_changed":
			return model.state === null
				? model
				: { ...model, state: { ...model.state, thinkingLevel: typeof frame.thinkingLevel === "string" ? frame.thinkingLevel : null } };
		case "config_update": {
			if (model.state === null) return model;
			const model_ = frame.model === undefined ? model.state.model : frame.model;
			const thinking = frame.thinkingLevel === undefined ? model.state.thinkingLevel : frame.thinkingLevel;
			return { ...model, state: { ...model.state, model: model_, thinkingLevel: thinking } };
		}
		case "session_info_update": {
			if (typeof frame.title !== "string") return model;
			return {
				...model,
				header: model.header === null ? model.header : { ...model.header, title: frame.title },
				state: model.state === null ? model.state : { ...model.state, sessionName: frame.title },
			};
		}
		case "todo_auto_clear":
			// Native auto-clear is conditional; only the following get_state cut establishes its result.
			return model;
		case "available_commands_update":
			return { ...model, commands: frame.commands.slice(0, MAX_COMMANDS) };
		case "command_output":
			return appendEphemeral(model, "command_output", { text: clampText(frame.text, MAX_COMMAND_OUTPUT_TEXT) }, now);
		case "ui_status": {
			const entries = new Map(model.statusEntries);
			if (frame.text === null || frame.text.length === 0) entries.delete(frame.key);
			else if (entries.has(frame.key) || entries.size < MAX_STATUS_KEYS) entries.set(frame.key, clampText(frame.text, MAX_STATUS_TEXT));
			return { ...model, statusEntries: entries, statusLine: statusLineOf(entries) };
		}
		case "ui_widget": {
			const widgets = new Map(model.widgets);
			const lines = (frame.lines ?? []).slice(0, MAX_WIDGET_LINES).map(line => clampText(line, MAX_STATUS_TEXT));
			if (lines.every(line => line.trim().length === 0)) widgets.delete(frame.key);
			else if (widgets.has(frame.key) || widgets.size < MAX_STATUS_KEYS) widgets.set(frame.key, { lines, placement: frame.placement ?? "aboveEditor" });
			return { ...model, widgets };
		}
		case "ui_notify":
			return { ...model, extensionNotice: { id: (model.extensionNotice?.id ?? 0) + 1, level: frame.level, message: clampText(frame.message, MAX_COMMAND_FEEDBACK_TEXT) } };
		case "state_update":
			return applyChatLiteState(model, frame.state, frame.todoSeed, clock);
		case "ui_editor_text":
			return {
				...model,
				pendingEditorText: { text: clampText(frame.text, 256 * 1024), seq: (model.pendingEditorText?.seq ?? 0) + 1 },
			};
		default:
			// Unknown frame from a newer OMP: ignored.
			return model;
	}
}

function statusLineOf(entries: ReadonlyMap<string, string>): string | null {
	if (entries.size === 0) return null;
	return clampText([...entries.values()].join(" · "), MAX_STATUS_TEXT);
}

function reduceMessageEnd(model: ChatModel, messageId: string, message: ChatMessage, clock: ChatClock): ChatModel {
	if (message.role === "assistant" && model.displayTurns.length) {
		const key = assistantPersistenceKey(message);
		const last = model.displayTurns.at(-1)!;
		if (!last.complete && !last.memberKeys.includes(key)) model = { ...model, displayTurns: [...model.displayTurns.slice(0, -1), { ...last, memberKeys: [...last.memberKeys, key] }] };
	}
	const streamPosition = message.role === "assistant" && model.streamId === messageId ? model.streamPosition : null;
	const cleared: ChatModel = message.role !== "assistant" ? model
		: model.streamId === messageId ? { ...model, lastAgentOutcome: message.stopReason, stream: null, streamId: null, streamPosition: null }
		: { ...model, lastAgentOutcome: message.stopReason };
	const entryId = pendingEntryId(messageId);
	if ((message.role === "custom" || message.role === "hookMessage") && (message.customType === "prewalk-plan" || message.customType === "vibe-mode-context")) {
		if (!message.display || cleared.ephemeral.some(item => item.id === entryId)) return cleared;
		return appendEphemeral(cleared, "custom", message, clock.now ?? 0, entryId);
	}
	// An IRC observation and the agent's own message_end are the same record under two ids: the later one updates the earlier row.
	const observation = ircObservationId(message);
	const existing = cleared.pending.get(entryId) ?? (observation === null ? undefined : cleared.pending.get(observation));
	const rowId = existing?.entryId ?? entryId;
	if (existing === undefined && isAlreadyDurable(cleared, message)) return cleared;
	const key = messageKey(message);
	const seq = existing?.seq ?? streamPosition?.seq ?? cleared.transcriptEventSeq + 1;
	const anchorId = existing ? existing.anchorId : streamPosition ? streamPosition.anchorId : positionTranscript(cleared.entries, cleared.durableCount, cleared.pending, cleared.ephemeral, cleared.stream && cleared.streamId && cleared.streamPosition ? { message: cleared.stream, messageId: cleared.streamId, position: cleared.streamPosition } : null, cleared.durablePositions).at(-1)?.id ?? null;
	const row: PendingRow = { entryId: rowId, messageId, ...key, fingerprint: customFingerprint(message), anchorId, seq, unsaved: existing?.unsaved ?? false, hidden: (message.role === "custom" || message.role === "hookMessage") && !message.display };
	const entry: ChatEntry = { type: "message", id: rowId, parentId: cleared.leafId, timestamp: new Date(message.timestamp).toISOString(), message };
	const pending = new Map(cleared.pending).set(rowId, row);
	const rows = pendingEntries(cleared);
	const at = rows.findIndex(candidate => candidate.id === rowId);
	if (at >= 0) rows[at] = entry;
	else rows.push(entry);
	const next = withPending({ ...cleared, transcriptEventSeq: Math.max(cleared.transcriptEventSeq, seq) }, durableRows(cleared), pending, rows);
	const phases = todoPhasesFromEntry(entry);
	return phases === null ? reproject(next, clock) : { ...next, todoSeed: phases, todo: { phases, entryId: rowId, appliedAt: clock.now ?? 0 } };
}

/** The pending id a live `irc:incoming` observation takes, so the agent's own message_end for the same record updates that row. */
function ircObservationId(message: ChatMessage): string | null {
	return (message.role === "custom" || message.role === "hookMessage") && message.customType === "irc:incoming" ? pendingEntryId(`irc:${message.customType}:${message.timestamp}`) : null;
}

/**
 * OMP's `irc_message` event shows IRC traffic live. Only `irc:incoming` is also a saved message (its own message_end and
 * entry follow), so it is a pending row that those reconcile into. Relay and work-pool cards are display-only: OMP emits
 * them "without persisting", so they are ephemeral rows that never wait for an entry and are never flagged *not yet saved*.
 */
function observeIrc(model: ChatModel, message: ChatMessage, clock: ChatClock): ChatModel {
	if (message.role !== "custom" && message.role !== "hookMessage") return model;
	const key = `irc:${message.customType}:${message.timestamp}`;
	if (message.customType !== "irc:incoming") {
		const id = pendingEntryId(key);
		if (!message.display || model.ephemeral.some(item => item.id === id)) return model;
		return appendEphemeral(model, "custom", message, message.timestamp, id);
	}
	// A replayed observation, or one that arrives after its own message_end or entry, is already represented.
	if (matchingPending(model.pending, message, false) !== undefined || isAlreadyDurable(model, message)) return model;
	return reduceMessageEnd(model, key, message, clock);
}

// Durable rows

/**
 * Merge durable rows (the reconciled delta, or a live append). A row already held by id is skipped; a `message`
 * row consumes the pending row it matches by role + timestamp (+ `toolCallId`), so the durable entry replaces it
 * in place of an addition. Durable rows come before the remaining pending rows.
 */
export function applyChatEntries(model: ChatModel, rows: readonly ChatEntry[], leafId: string | null | undefined, clock: ChatClock = {}): ChatModel {
	const known = new Set<string>();
	for (let index = 0; index < model.durableCount; index += 1) {
		const entry = model.entries[index];
		if (entry !== undefined) known.add(entry.id);
	}
	const durable = [...durableRows(model)];
	const pending = new Map(model.pending);
	const pendingRows = pendingEntries(model);
	const redirects = new Map<string, string | null>();
	const durablePositions = new Map(model.durablePositions);
	let changed = false;
	for (const row of rows) {
		if (CHAT_ENTRY_TYPES[row.type] !== true || known.has(row.id)) continue;
		known.add(row.id);
		changed = true;
		const message = entryMessage(row);
		if (message !== null && pending.size > 0) {
			const entryId = matchingPending(pending, message);
			const held = entryId === undefined ? undefined : pending.get(entryId);
			if (entryId !== undefined && held !== undefined) {
				pending.delete(entryId);
				redirects.set(entryId, row.id);
				if (held.anchorId !== null) durablePositions.set(row.id, { anchorId: held.anchorId, seq: held.seq });
				const at = pendingRows.findIndex(candidate => candidate.id === entryId);
				if (at >= 0) pendingRows.splice(at, 1);
			}
		}
		durable.push(row);
	}
	const nextLeaf = leafId === undefined ? model.leafId : leafId;
	if (!changed && nextLeaf === model.leafId) return model;
	const next = retargetPositions(withPending({ ...model, leafId: nextLeaf, durablePositions }, durable, pending, pendingRows), redirects);
	return changed ? reproject(next, clock) : next;
}

/** Prepend older durable rows (a `load-older` reply). Rows already held are skipped. */
export function applyChatOlder(model: ChatModel, rows: readonly ChatEntry[], olderCount: number, _clock: ChatClock = {}): ChatModel {
	const known = new Set(model.entries.map(entry => entry.id));
	const fresh = rows.filter(row => CHAT_ENTRY_TYPES[row.type] === true && !known.has(row.id));
	if (fresh.length === 0 && olderCount === model.olderCount) return model;
	const durable = [...fresh, ...durableRows(model)];
	return { ...withPending(model, durable, model.pending, pendingEntries(model)), olderCount };
}

/**
 * Replace the durable rows wholesale (a full `get_entries` after `unknown_since`, a legacy-id file, or an active-path
 * change). A pending row whose durable entry is now in `rows` is consumed; the others stay.
 */
export function applyChatRewrite(
	model: ChatModel,
	rows: readonly ChatEntry[],
	olderCount: number,
	leafId: string | null,
	clock: ChatClock = {},
): ChatModel {
	const durable = rows.filter(row => CHAT_ENTRY_TYPES[row.type] === true);
	const pending = new Map(model.pending);
	const pendingRows = pendingEntries(model);
	const redirects = new Map<string, string | null>();
	const durablePositions = new Map([...model.durablePositions].filter(([id]) => durable.some(row => row.id === id)));
	// The two passes of matchingPending put an exact timestamp ahead of a same-content custom message.
	for (const row of durable) {
		const message = entryMessage(row);
		if (message === null || pending.size === 0) continue;
		const entryId = matchingPending(pending, message);
		const held = entryId === undefined ? undefined : pending.get(entryId);
		if (entryId !== undefined && held !== undefined) {
			pending.delete(entryId);
			redirects.set(entryId, row.id);
			if (held.anchorId !== null) durablePositions.set(row.id, { anchorId: held.anchorId, seq: held.seq });
			const at = pendingRows.findIndex(candidate => candidate.id === entryId);
			if (at >= 0) pendingRows.splice(at, 1);
		}
	}
	const next = retargetPositions({ ...withPending({ ...model, durablePositions }, durable, pending, pendingRows), olderCount, leafId }, redirects);
	const ids = new Set(next.entries.map(entry => entry.id));
	const ephemeral: EphemeralItem[] = [];
	for (const item of next.ephemeral) {
		if (item.anchorId !== null && !ids.has(item.anchorId)) continue;
		ephemeral.push(item);
		ids.add(item.id);
	}
	const surviving = new Map(next.pending);
	for (const [id, row] of surviving) if (row.anchorId !== null && !ids.has(row.anchorId)) surviving.set(id, { ...row, anchorId: null });
	return reproject({ ...next, pending: surviving, ephemeral }, clock);
}

/**
 * Drop the pending rows whose message is saved on another branch of the file (ADR-0051): a reattach replays the
 * broker's ring, which still holds the turns of a branch the user rewound away from. Those rows can never match
 * the active path, yet they are not *unsaved*. `offPath` are the file's entries off the active path.
 */
export function dropPendingSavedElsewhere(model: ChatModel, offPath: readonly ChatEntry[], clock: ChatClock = {}): ChatModel {
	if (model.pending.size === 0) return model;
	const pending = new Map(model.pending);
	const pendingRows = pendingEntries(model);
	for (const row of offPath) {
		const message = entryMessage(row);
		if (message === null || pending.size === 0) continue;
		const entryId = matchingPending(pending, message);
		if (entryId === undefined) continue;
		pending.delete(entryId);
		const at = pendingRows.findIndex(candidate => candidate.id === entryId);
		if (at >= 0) pendingRows.splice(at, 1);
	}
	if (pending.size === model.pending.size) return model;
	return reproject(withPending(model, [...durableRows(model)], pending, pendingRows), clock);
}

/** Flag every remaining pending row *not yet saved* (the reconcile budget ran out). */
export function markPendingUnsaved(model: ChatModel): ChatModel {
	let changed = false;
	const pending = new Map<string, PendingRow>();
	for (const [id, row] of model.pending) {
		if (row.unsaved || row.hidden) pending.set(id, row);
		else {
			changed = true;
			pending.set(id, { ...row, unsaved: true });
		}
	}
	return changed ? { ...model, pending } : model;
}

// Dialogs

const MAX_UI_OPTIONS = 200;
const MAX_ASK_QUESTIONS = 64;

/**
 * Bound an `ask` frame. Ids and option labels are answer keys the child compares by identity, so one that
 * clamping or control-character stripping would change makes the whole dialog unrenderable (answered
 * `cancelled`) rather than answerable with a key the child would refuse. Question text, header and descriptions are
 * display-only and are clamped freely.
 */
function normalizeAskRequest(id: string, frame: Record<string, unknown>): ChatUiRequest | null {
	if (!Array.isArray(frame.questions) || frame.questions.length === 0 || frame.questions.length > MAX_ASK_QUESTIONS) return null;
	const questions: ChatAskQuestion[] = [];
	const seen = new Set<string>();
	for (const raw of frame.questions) {
		if (!isObject(raw) || typeof raw.id !== "string" || raw.id.length === 0 || raw.id.length > 256 || clampText(raw.id, 256) !== raw.id || typeof raw.question !== "string") return null;
		if (seen.has(raw.id) || !Array.isArray(raw.options) || raw.options.length > MAX_UI_OPTIONS) return null;
		seen.add(raw.id);
		const options: ChatUiOption[] = [];
		const labels = new Set<string>();
		for (const option of raw.options) {
			if (!isObject(option) || typeof option.label !== "string" || option.label.length > 2_000 || clampText(option.label, 2_000) !== option.label || labels.has(option.label)) return null;
			labels.add(option.label);
			const description = typeof option.description === "string" && option.description.trim().length > 0 ? clampText(option.description.trim(), 2_000) : undefined;
			options.push(description === undefined ? { label: option.label } : { label: option.label, description });
		}
		const question: ChatAskQuestion = { id: raw.id, question: clampText(raw.question, 4_000), options, multi: raw.multi === true };
		if (typeof raw.header === "string" && raw.header.trim().length > 0) question.header = clampText(raw.header.trim(), 200);
		if (typeof raw.recommended === "number" && Number.isInteger(raw.recommended) && raw.recommended >= 0 && raw.recommended < options.length) question.recommended = raw.recommended;
		questions.push(question);
	}
	const first = questions[0]!;
	const title = clampText(questions.length === 1 ? first.question : `${first.question} (+${questions.length - 1} more)`, 500);
	return { id, method: "ask", title, questions };
}

/** Whether `answers` settles `request` the way the child accepts it: one per question in order, known labels once each, one choice for a single-select. */
export function askAnswersMatch(request: Extract<ChatUiRequest, { method: "ask" }>, answers: readonly ChatAskAnswer[]): boolean {
	if (answers.length !== request.questions.length) return false;
	return request.questions.every((question, index) => {
		const answer = answers[index];
		if (answer === undefined || answer.id !== question.id) return false;
		const labels = new Set(question.options.map(option => option.label));
		const picked = new Set(answer.selectedOptions);
		if (picked.size !== answer.selectedOptions.length || answer.selectedOptions.some(label => !labels.has(label))) return false;
		const custom = answer.customInput?.trim();
		return question.multi || (picked.size <= 1 && !(picked.size > 0 && custom !== undefined && custom.length > 0));
	});
}

/**
 * Bound and normalize an `extension_ui_request` (select|confirm|input|editor|ask) frame. Returns `null` for a shape
 * this module cannot render; the caller then answers `cancelled` so OMP is never left waiting.
 */
export function normalizeUiRequest(frame: Record<string, unknown>): ChatUiRequest | null {
	const id = frame.id;
	if (frame.method === "ask") return typeof id === "string" && id.length > 0 && id.length <= 256 ? normalizeAskRequest(id, frame) : null;
	const title = frame.title;
	if (typeof id !== "string" || id.length === 0 || id.length > 256 || typeof title !== "string") return null;
	const cleanTitle = clampText(title, 500);
	switch (frame.method) {
		case "select": {
			if (!Array.isArray(frame.options)) return null;
			const details = Array.isArray(frame.optionDetails) ? frame.optionDetails : [];
			const options: ChatUiOption[] = [];
			for (const [index, option] of frame.options.slice(0, MAX_UI_OPTIONS).entries()) {
				if (typeof option !== "string") return null;
				const detail: unknown = details[index];
				const description = isObject(detail) && typeof detail.description === "string" ? clampText(detail.description, 2_000) : undefined;
				options.push(description === undefined ? { label: clampText(option, 500) } : { label: clampText(option, 500), description });
			}
			return { id, method: "select", title: cleanTitle, options };
		}
		case "confirm":
			return { id, method: "confirm", title: cleanTitle, message: typeof frame.message === "string" ? clampText(frame.message, 16_000) : "" };
		case "input":
			return typeof frame.placeholder === "string"
				? { id, method: "input", title: cleanTitle, placeholder: clampText(frame.placeholder, 500) }
				: { id, method: "input", title: cleanTitle };
		case "editor": {
			const request: ChatUiRequest = { id, method: "editor", title: cleanTitle };
			if (typeof frame.prefill === "string") request.prefill = clampText(frame.prefill, 256 * 1024);
			if (typeof frame.promptStyle === "boolean") request.promptStyle = frame.promptStyle;
			return request;
		}
		default:
			return null;
	}
}

/** Queue a dialog behind the ones already pending (FIFO); a duplicate id is ignored. */
export function applyChatUiRequest(model: ChatModel, request: ChatUiRequest): ChatModel {
	if (model.uiRequest?.id === request.id || model.uiQueue.some(queued => queued.id === request.id)) return model;
	return model.uiRequest === null ? { ...model, uiRequest: request } : { ...model, uiQueue: [...model.uiQueue, request] };
}

/** Remove the dialog the child withdrew (`cancel` naming its id), or that was answered. */
export function applyChatUiCancel(model: ChatModel, targetId: string): ChatModel {
	if (model.uiRequest?.id === targetId) {
		const [next, ...rest] = model.uiQueue;
		return { ...model, uiRequest: next ?? null, uiQueue: rest };
	}
	if (!model.uiQueue.some(queued => queued.id === targetId)) return model;
	return { ...model, uiQueue: model.uiQueue.filter(queued => queued.id !== targetId) };
}

// Projections

/** The rows the view mounts (`transcript-window.ts`), over durable and pending rows. */
export function windowOf(model: ChatModel, rows: number, pinnedTopId: string | null): TranscriptWindow {
	const stream = model.stream && model.streamId && model.streamPosition ? { message: model.stream, messageId: model.streamId, position: model.streamPosition } : null;
	return transcriptWindow(positionTranscript(model.entries, model.durableCount, model.pending, model.ephemeral, stream, model.durablePositions), rows, pinnedTopId, { pending: model.pending, activeTools: model.activeTools, working: model.working, sealedSeq: model.sealedSeq, retrySuppressedIds: model.retrySuppressedIds, streamId: model.streamId });
}

/** The snapshot payload for the model's current state; `entries` is the durable tail the model holds. */
export function snapshotOf(model: ChatModel, epoch: ChatEpoch): ChatSnapshotPayload {
	const pending: ChatPendingRowPayload[] = [];
	for (const entry of pendingEntries(model)) {
		const row = model.pending.get(entry.id);
		if (row !== undefined) pending.push({ entry, messageId: row.messageId, unsaved: row.unsaved, anchorId: row.anchorId, seq: row.seq });
	}
	return {
		epoch,
		phase: model.phase,
		code: model.code,
		readOnlyReason: model.readOnlyReason,
		...(model.exitReason === undefined ? {} : { exitReason: model.exitReason }),
		header: model.header,
		entries: durableRows(model),
		olderCount: model.olderCount,
		leafId: model.leafId,
		branches: model.branches,
		state: model.state,
		pending,
		stream: model.stream !== null && model.streamId !== null ? { messageId: model.streamId, message: model.stream } : null,
		activeTools: [...model.activeTools.values()],
		working: model.working,
		workingIntent: model.workingIntent,
		settled: model.settled,
		asyncPaused: model.asyncPaused,
		uiRequests: model.uiRequest === null ? [] : [model.uiRequest, ...model.uiQueue],
		todoSeed: model.todoSeed,
		todoAuthoritative: model.todoAuthoritative,
		agents: [...model.agents.values()],
		agentActivity: [...model.agentActivity].map(([id, activity]) => ({ id, activity })),
		agentIdentities: [...model.agentIdentity].map(([id, identity]) => ({ id, ...identity })),
		agentAvailability: model.agentAvailability,
		maintenance: model.maintenance,
		retry: model.retry,
		retrySuppressedIds: model.retrySuppressedIds,
		goal: model.goal,
		transcriptEventSeq: model.transcriptEventSeq,
		streamPosition: model.streamPosition,
		sealedSeq: model.sealedSeq,
		durablePositions: [...model.durablePositions].map(([entryId, position]) => ({ entryId, ...position })),
		ephemeral: model.ephemeral,
		commands: model.commands,
		displayTurns: model.displayTurns,
	};
}

/** Whether a row is a pending row flagged *not yet saved*. */
export function isUnsavedRow(model: ChatModel, entryId: string): boolean {
	return model.pending.get(entryId)?.unsaved === true;
}

/** Image content type re-exported for the composer/host command payloads. */
export type ChatImage = ImageContent;
