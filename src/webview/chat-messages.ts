/**
 * The `omp:chat-*` wire between the extension host and the chat page.
 *
 * The host owns the conversation (an `RpcSession` over `omp --mode rpc-ui`) and folds the
 * child's frames into the shared chat model (`src/chat/model.ts`); the page folds the
 * messages defined here into the same model to render. Everything that arrives from the
 * host is validated here before the reducer sees it — the reducer trusts its input types —
 * and everything the page sends is validated again by the host through the same guards.
 *
 * Nothing here carries a credential: no link, no key, no process id. A row's text is
 * transcript content and is relayed verbatim; every *label* the page shows about the
 * connection (phase, code) is a bounded vocabulary, never child text.
 *
 * Host → page:
 *
 * | message | content |
 * | --- | --- |
 * | `omp:chat-state` | phase/code/read-only reason/title for one epoch |
 * | `omp:chat-snapshot` + `omp:chat-snapshot-chunk` | the authoritative reset, its rows chunked |
 * | `omp:chat-event` | one allow-listed frame for the current epoch |
 * | `omp:chat-entries` | reconciled durable rows |
 * | `omp:chat-older` | rows above the loaded window |
 * | `omp:chat-ui-request` / `omp:chat-ui-cancel` | one dialog, or the withdrawal of one |
 * | `omp:chat-subagent-chunk` | one chunk of a subagent transcript the page asked for |
 * | `omp:chat-display-preferences` | tool-call detail and accessibility settings |
 * | `omp:chat-queue-result` | the outcome of a queue removal or promotion the page requested |
 * | `omp:chat-send-result` | correlated text admission, refusal, uncertain delivery, or a terminal-UI command the host answered itself; not a turn result |
 * | `omp:chat-abort-result` | what a Stop the page requested withdrew from OMP's queues, for its composer |
 * | `omp:chat-navigate-result` | the outcome of an in-place Rewind/Undo/branch switch, and a rewound prompt for the composer |
 *
 * Page → host: `omp:chat-prompt`, `-steer`, `-follow-up`, `-abort`, `-ui-response`,
 * `-load-older`, `-resume`, `-reconnect`, `-restart`, `-subagent-read`, `-tool-detail`, `-queue-remove`, `-navigate`.
 * Every mutation carries a page-minted `requestId`, which the host uses as the
 * exactly-once key (the rpc command id is `vsc:<requestId>`).
 */
// Explicit `.ts` specifiers and type-only imports: this module is imported by the node:test
// runner, which does not resolve extensionless specifiers, and it must stay free of host code.
import type { ImageContent } from "@oh-my-pi/pi-wire";
import { parseChatMessage, parseChatEntry, type AssistantMessage, type ChatEntry } from "../chat/messages.ts";
import { MAX_AGENT_IDENTITIES, parseAgentRoster, parseAgentActivity, parseSubagentFrame } from "../chat/agents.ts";
import { parseLiveAgents } from "../chat/agent-liveness.ts";
import { parseNativeEventFrame, type MaintenanceState, type RetryState } from "../chat/events.ts";
import { parseTodoPhases } from "../chat/todos.ts";
import type { EphemeralItem } from "../chat/projection.ts";
import { MAX_EPHEMERAL_ITEMS, MAX_QUEUED_ITEMS, MAX_QUEUED_TEXT_LENGTH, MAX_QUEUED_TOTAL_BYTES, MAX_WIDGET_LINES, normalizeQueuedMessages, queuedJsonBytes } from "../chat/model.ts";
import { NAVIGATE_REFUSAL_SENTENCES, parseBranchPoints, type NavigateRefusal, type NavigationKind } from "../chat/rewind.ts";
import { SUBAGENT_CHUNK_CHARS } from "../chat/subagent-transcript.ts";
import type {
	ActiveTool,
	ChatEpoch,
	ChatEntriesPayload,
	ChatEventFrame,
	ChatHeader,
	ChatAskAnswer,
	ChatAskQuestion,
	ChatLiteModel,
	ChatLiteState,
	ChatOlderPayload,
	ChatPendingRowPayload,
	ChatPhase,
	ChatSlashCommand,
	ChatSnapshotPayload,
	ChatStatePayload,
	ChatUiRequest,
	ChatUiResponse,
} from "../chat/model.ts";
import { isRecord } from "../guards.ts";

// Bounds

/** Longest prompt/steer/follow-up text one message carries. */
export const MAX_CHAT_TEXT_LENGTH = 200_000;
/** Messages one Stop hands back to the composer (the host's own bound on `abort_and_restore_queue`). */
export const MAX_RESTORED_MESSAGES = 64;
/** Images one prompt may carry. */
export const MAX_CHAT_IMAGES = 8;
/** Base64 characters of one image (512 KiB raw). */
export const MAX_CHAT_IMAGE_BASE64_CHARS = Math.ceil((512 * 1024) / 3) * 4;
/** Base64 characters of all of one prompt's images (576 KiB raw). */
export const MAX_CHAT_IMAGES_BASE64_CHARS = Math.ceil((576 * 1024) / 3) * 4;
/** Rows one chunk, `omp:chat-entries` or `omp:chat-older` message may carry. */
export const MAX_CHAT_ROWS_PER_MESSAGE = 5_000;
/** Chunks one snapshot may announce. */
export const MAX_CHAT_SNAPSHOT_CHUNKS = 1_024;
/** Rows one assembled snapshot may hold. */
export const MAX_CHAT_SNAPSHOT_ROWS = 20_000;
/** Target JSON size of one snapshot chunk, matching the bridge's plaintext frame ceiling. */
export const CHAT_SNAPSHOT_CHUNK_BYTES = 256 * 1024 - 8 * 1024;
/** Dialogs one snapshot may carry (the host pins at most this many). */
export const MAX_CHAT_UI_REQUESTS = 256;
/** Longest dialog answer text. */
export const MAX_CHAT_UI_VALUE_LENGTH = 256 * 1024;

const MAX_ID_LENGTH = 256;
const MAX_LABEL_LENGTH = 64;
const MAX_UI_OPTIONS = 200;
const MAX_ASK_QUESTIONS = 64;
const MAX_ACTIVE_TOOLS = 256;
const MAX_PENDING_ROWS = 1_024;
const MAX_COMMANDS = 500;

/** Mutation ids: 128 random bits as lowercase hex, the bridge's own token grammar. */
const REQUEST_ID = /^[0-9a-f]{32}$/;

/** True for a page-minted mutation id. */
export function isChatRequestId(value: unknown): value is string {
	return typeof value === "string" && REQUEST_ID.test(value);
}

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const IMAGE_MIME: Record<string, true> = { "image/png": true, "image/jpeg": true, "image/gif": true, "image/webp": true };

// Message shapes

export interface ChatStateMessage extends ChatStatePayload {
	type: "omp:chat-state";
}

/** Everything of a snapshot except its epoch and rows, which travel beside it. */
export type ChatSnapshotHead = Omit<ChatSnapshotPayload, "epoch" | "entries">;

export interface ChatSnapshotMessage {
	type: "omp:chat-snapshot";
	epoch: ChatEpoch;
	/** Host-minted; every chunk of this reset names it. */
	snapshotId: string;
	/** Chunks that follow; `0` means the snapshot holds no rows. */
	chunks: number;
	head: ChatSnapshotHead;
}

export interface ChatSnapshotChunkMessage {
	type: "omp:chat-snapshot-chunk";
	epoch: ChatEpoch;
	snapshotId: string;
	index: number;
	entries: ChatEntry[];
}

export interface ChatEventMessage {
	type: "omp:chat-event";
	epoch: ChatEpoch;
	frame: ChatEventFrame;
}

export interface ChatEntriesMessage extends ChatEntriesPayload {
	type: "omp:chat-entries";
}

export interface ChatOlderMessage extends ChatOlderPayload {
	type: "omp:chat-older";
}

export interface ChatUiRequestMessage {
	type: "omp:chat-ui-request";
	epoch: ChatEpoch;
	request: ChatUiRequest;
}

export interface ChatUiCancelMessage {
	type: "omp:chat-ui-cancel";
	epoch: ChatEpoch;
	/** The dialog the child withdrew. */
	targetId: string;
}

/** One chunk of a subagent's serialized read-only transcript, split so even a single large tool/image row fits the bridge. */
export interface ChatSubagentChunkMessage {
	type: "omp:chat-subagent-chunk";
	epoch: ChatEpoch;
	requestId: string;
	subagentId: string;
	index: number;
	chunks: number;
	text: string;
}

export interface ChatDisplayPreferences {
	toolCallDetail: "overview" | "detailed";
	accessibilitySupport: boolean;
	/** The remembered thinking default (the TUI's `Ctrl+T`); absent = closed. */
	thinkingExpanded?: boolean;
	/** The remembered tool-call default (the TUI's `Ctrl+O`); absent = collapsed. */
	toolsExpanded?: boolean;
}
export interface ChatDisplayPreferencesMessage extends ChatDisplayPreferences {
	type: "omp:chat-display-preferences";
	epoch: ChatEpoch;
}
/** The page asks the host to open the native Tools output picker; the choice never travels back through the page. */
export interface ChatToolDetailMessage {
	type: "omp:chat-tool-detail";
	requestId: string;
	epoch: ChatEpoch;
}

/** One pending user message, named by the queue it waits in and its exact queue-chip text (what OMP matches on). */
export interface ChatQueuedRef {
	queue: "steering" | "followUp";
	text: string;
}

/**
 * Act on pending messages in OMP's queues. `cancel` discards what is removed; `edit` hands it back to the
 * page that asked, which puts it in its composer; `promote` turns a queued follow-up into steering, delivered
 * before the agent's next step. Several items are handled in order, one by one.
 */
export interface ChatQueueRemoveMessage {
	type: "omp:chat-queue-remove";
	requestId: string;
	epoch: ChatEpoch;
	purpose: ChatQueuePurpose;
	items: ChatQueuedRef[];
}

export type ChatQueuePurpose = "cancel" | "edit" | "promote";

/**
 * What happened to one requested item: `removed` (taken out of the queue — or, for `promote`, moved to steering;
 * its images when `purpose` is `edit`), `gone` (not in the queue when the command ran: already delivered, or
 * removed elsewhere), `unknown` (no confirmed answer) or `failed` (still queued).
 */
export type ChatQueueResultEntry = { status: "removed"; images?: ChatImageWire[]; imagesDropped?: true } | { status: "gone" | "unknown" | "failed" };

/** A {@link ChatQueueResultEntry} paired with the item it answers (the page pairs them; the wire carries no text). */
export type ChatQueueResultItem = ChatQueuedRef & ChatQueueResultEntry;

/**
 * The answer to one {@link ChatQueueRemoveMessage}, sent to the page that asked: one entry per item, in request order.
 * It repeats no message text, so it stays small however large the queue was; `epoch` is the request's own.
 */
export interface ChatQueueResultMessage {
	type: "omp:chat-queue-result";
	epoch: ChatEpoch;
	requestId: string;
	purpose: ChatQueuePurpose;
	results: ChatQueueResultEntry[];
}

/**
 * Correlated admission result, not the eventual prompt_result at a turn's yield. `explained` is a terminal-UI
 * command the host did not send to OMP: it answered it in the transcript, and ran its Desk equivalent if any.
 */
export interface ChatSendResultMessage {
	type: "omp:chat-send-result";
	epoch: ChatEpoch;
	requestId: string;
	status: "accepted" | "refused" | "unconfirmed" | "explained";
}

/** One message a Stop withdrew from OMP's queues, as the composer takes it back. */
export interface ChatRestoredMessage {
	text: string;
	images?: ChatImageWire[];
}

/**
 * The answer to one `omp:chat-abort`, sent to the page that asked: what `abort_and_restore_queue` took out of the
 * steering and follow-up queues (oldest first), for that page's composer. `imagesDropped`/`truncated` say some
 * images, or the newest texts, could not be carried; `refused`/`unconfirmed` withdrew nothing the page can know of.
 */
export interface ChatAbortResultMessage {
	type: "omp:chat-abort-result";
	epoch: ChatEpoch;
	requestId: string;
	status: "accepted" | "refused" | "unconfirmed";
	entries: ChatRestoredMessage[];
	imagesDropped?: true;
	truncated?: true;
}

/**
 * The answer to one in-place navigation (ADR-0051), sent to the page that asked, or to every page of the tab for a
 * command-palette Rewind. `draft` is the rewound prompt for the composer; `unavailableImages` counts images that could
 * not be carried (an unresolved stored image, or a route that could not take the bytes).
 */
export interface ChatNavigateResultMessage {
	type: "omp:chat-navigate-result";
	requestId: string;
	status: "done" | "refused" | "unconfirmed";
	reason?: NavigateRefusal;
	kind?: NavigationKind;
	summarized?: boolean;
	/** The session moved while OMP ran the navigation; the move happened, but not exactly from the point the page saw. */
	raced?: true;
	draft?: { text: string; images: ChatImageWire[]; unavailableImages: number };
}

export type ChatHostMessage =
	| ChatDisplayPreferencesMessage
	| ChatStateMessage
	| ChatSnapshotMessage
	| ChatSnapshotChunkMessage
	| ChatEventMessage
	| ChatEntriesMessage
	| ChatOlderMessage
	| ChatUiRequestMessage
	| ChatSubagentChunkMessage
	| ChatQueueResultMessage
	| ChatSendResultMessage
	| ChatAbortResultMessage
	| ChatNavigateResultMessage
	| ChatUiCancelMessage;

/** One image of a prompt, as OMP's `prompt`/`steer`/`follow_up` accept it. */
export type ChatImageWire = Pick<ImageContent, "type" | "mimeType" | "data">;

export interface ChatPromptMessage {
	type: "omp:chat-prompt";
	requestId: string;
	text: string;
	images?: ChatImageWire[];
}

export interface ChatSteerMessage {
	type: "omp:chat-steer";
	requestId: string;
	text: string;
	images?: ChatImageWire[];
}

export interface ChatFollowUpMessage {
	type: "omp:chat-follow-up";
	requestId: string;
	text: string;
	images?: ChatImageWire[];
}

export interface ChatAbortMessage {
	type: "omp:chat-abort";
	requestId: string;
}

/** The user's answer to one dialog; the host answers OMP at most once per dialog id. */
export interface ChatUiResponseMessage {
	type: "omp:chat-ui-response";
	requestId: string;
	response: ChatUiResponse;
}

export interface ChatLoadOlderMessage {
	type: "omp:chat-load-older";
	requestId: string;
	/** The oldest row the page holds; the host serves the rows above it. */
	beforeId: string;
}

export interface ChatSubagentRequestMessage {
	type: "omp:chat-subagent-read";
	requestId: string;
	epoch: ChatEpoch;
	subagentId: string;
	fromByte: number;
	beforeId?: string;
}

/** The Open button of a view-only tab. */
export interface ChatResumeMessage {
	type: "omp:chat-resume";
	requestId: string;
}

/** The Reconnect button of a failed tab: the host reattaches to the same running session (never launches). */
export interface ChatReconnectMessage {
	type: "omp:chat-reconnect";
	requestId: string;
}

/** Explicitly confirmed exact-file recovery; native nonce prevents a late click targeting a successor. */
export interface ChatRestartMessage {
	type: "omp:chat-restart";
	requestId: string;
	epoch: ChatEpoch;
}

/** Rewind, Undo or switch branches in place; `expectedLeafId` is the leaf the page saw (compare-and-swap). */
export interface ChatNavigateMessage {
	type: "omp:chat-navigate";
	requestId: string;
	kind: NavigationKind;
	targetId: string;
	expectedLeafId: string | null;
	summarize: boolean;
}

export type ChatWebviewMessage =
	| ChatToolDetailMessage
	| ChatPromptMessage
	| ChatSteerMessage
	| ChatFollowUpMessage
	| ChatAbortMessage
	| ChatUiResponseMessage
	| ChatLoadOlderMessage
	| ChatSubagentRequestMessage
	| ChatResumeMessage
	| ChatReconnectMessage
	| ChatRestartMessage
	| ChatNavigateMessage
	| ChatQueueRemoveMessage;

// Small guards

function isCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isText(value: unknown, max: number): value is string {
	return typeof value === "string" && value.length <= max;
}

function isName(value: unknown, max: number): value is string {
	return isText(value, max) && value.length > 0;
}

function optionalText(value: unknown, max: number): string | undefined | null {
	if (value === undefined) return undefined;
	return isText(value, max) ? value : null;
}

const PHASES: Record<string, ChatPhase> = {
	starting: "starting",
	attaching: "attaching",
	resyncing: "resyncing",
	live: "live",
	stopped: "stopped",
	failed: "failed",
	"view-only": "view-only",
	blocked: "blocked",
	legacy: "legacy",
};

const PROMPT_STATUS: Record<string, "completed" | "aborted" | "error"> = { completed: "completed", aborted: "aborted", error: "error" };

/** Parse an epoch: a non-empty nonce and a counter. */
export function parseChatEpoch(value: unknown): ChatEpoch | null {
	if (!isRecord(value)) return null;
	if (!isName(value.nonce, MAX_LABEL_LENGTH) || !isCount(value.counter)) return null;
	return { nonce: value.nonce, counter: value.counter };
}


function parseAssistantMessage(value: unknown): AssistantMessage | null {
	const message = parseChatMessage(value);
	return message !== null && message.role === "assistant" ? message : null;
}

/** One durable row: an id and a type. Row types the chat does not render are dropped by the model. */
function parseEntry(value: unknown): ChatEntry | null {
	if (!isRecord(value) || !isName(value.id, MAX_ID_LENGTH) || !isName(value.type, MAX_LABEL_LENGTH)) return null;
	return parseChatEntry(value);
}

function parseEntries(value: unknown, max: number): ChatEntry[] | null {
	if (!Array.isArray(value) || value.length > max) return null;
	const rows: ChatEntry[] = [];
	for (const candidate of value) {
		const row = parseEntry(candidate);
		if (row === null) return null;
		rows.push(row);
	}
	return rows;
}

function parseLiteModel(value: unknown): ChatLiteModel | null {
	if (!isRecord(value)) return null;
	if (!isName(value.provider, MAX_ID_LENGTH) || !isName(value.id, MAX_ID_LENGTH)) return null;
	const name = optionalText(value.name, MAX_ID_LENGTH);
	if (name === null) return null;
	if (value.contextWindow !== null && !isFiniteNumber(value.contextWindow)) return null;
	const model: ChatLiteModel = { provider: value.provider, id: value.id, contextWindow: value.contextWindow };
	if (name !== undefined) model.name = name;
	return model;
}

function parseLiteState(value: unknown): ChatLiteState | null {
	if (!isRecord(value)) return null;
	const model = value.model === null ? null : parseLiteModel(value.model);
	if (model === null && value.model !== null) return null;
	if (value.thinkingLevel !== null && !isText(value.thinkingLevel, MAX_LABEL_LENGTH)) return null;
	if (typeof value.isStreaming !== "boolean" || typeof value.isCompacting !== "boolean") return null;
	if (value.hasPendingAsyncWork !== undefined && typeof value.hasPendingAsyncWork !== "boolean") return null;
	if (value.isSettled !== undefined && typeof value.isSettled !== "boolean") return null;
	if (!isCount(value.queuedMessageCount)) return null;
	const sessionName = optionalText(value.sessionName, MAX_ID_LENGTH);
	if (sessionName === null) return null;
	const state: ChatLiteState = {
		model,
		thinkingLevel: value.thinkingLevel,
		isStreaming: value.isStreaming,
		isCompacting: value.isCompacting,
		...(typeof value.hasPendingAsyncWork === "boolean" ? { hasPendingAsyncWork: value.hasPendingAsyncWork } : {}),
		...(typeof value.isSettled === "boolean" ? { isSettled: value.isSettled } : {}),
		queuedMessageCount: value.queuedMessageCount,
	};
	if (sessionName !== undefined) state.sessionName = sessionName;
	if (value.queuedMessages !== undefined) {
		const queuedMessages = normalizeQueuedMessages(value.queuedMessages);
		if (queuedMessages === null) return null;
		state.queuedMessages = queuedMessages;
	}
	if (value.contextUsage !== undefined) {
		const usage = value.contextUsage;
		if (!isRecord(usage)) return null;
		for (const field of [usage.tokens, usage.contextWindow, usage.percent]) {
			if (field !== null && !isFiniteNumber(field)) return null;
		}
		state.contextUsage = {
			tokens: usage.tokens as number | null,
			contextWindow: usage.contextWindow as number | null,
			percent: usage.percent as number | null,
		};
	}
	return state;
}

function parseHeader(value: unknown): ChatHeader | null {
	if (!isRecord(value)) return null;
	if (!isName(value.id, MAX_ID_LENGTH) || typeof value.cwd !== "string" || typeof value.timestamp !== "string") return null;
	const title = optionalText(value.title, 2_000);
	if (title === null) return null;
	const header: ChatHeader = { id: value.id, cwd: value.cwd, timestamp: value.timestamp };
	if (title !== undefined) header.title = title;
	return header;
}

function parseActiveTool(value: unknown): ActiveTool | null {
	if (!isRecord(value)) return null;
	if (!isName(value.toolCallId, MAX_ID_LENGTH) || typeof value.toolName !== "string" || !isFiniteNumber(value.startedAt)) return null;
	const intent = optionalText(value.intent, 2_000);
	if (intent === null) return null;
	const tool: ActiveTool = { toolCallId: value.toolCallId, toolName: value.toolName, args: value.args, startedAt: value.startedAt };
	if (intent !== undefined) tool.intent = intent;
	if (value.partialResult !== undefined) tool.partialResult = value.partialResult;
	if (value.streamUpdate !== undefined) tool.streamUpdate = value.streamUpdate;
	return tool;
}

/** One dialog. A shape this page cannot render is refused, so the host is never left thinking it was shown. */
export function parseChatUiRequest(value: unknown): ChatUiRequest | null {
	if (!isRecord(value) || !isName(value.id, MAX_ID_LENGTH) || typeof value.title !== "string" || value.title.length > 2_000) return null;
	const { id, title } = value;
	switch (value.method) {
		case "select": {
			if (!Array.isArray(value.options) || value.options.length > MAX_UI_OPTIONS) return null;
			const options: { label: string; description?: string }[] = [];
			for (const option of value.options) {
				if (!isRecord(option) || !isText(option.label, 2_000)) return null;
				const description = optionalText(option.description, 4_000);
				if (description === null) return null;
				options.push(description === undefined ? { label: option.label } : { label: option.label, description });
			}
			return { id, method: "select", title, options };
		}
		case "confirm":
			return isText(value.message, 20_000) ? { id, method: "confirm", title, message: value.message } : null;
		case "input": {
			const placeholder = optionalText(value.placeholder, 2_000);
			if (placeholder === null) return null;
			return placeholder === undefined ? { id, method: "input", title } : { id, method: "input", title, placeholder };
		}
		case "editor": {
			const prefill = optionalText(value.prefill, MAX_CHAT_UI_VALUE_LENGTH);
			if (prefill === null) return null;
			if (value.promptStyle !== undefined && typeof value.promptStyle !== "boolean") return null;
			const request: ChatUiRequest = { id, method: "editor", title };
			if (prefill !== undefined) request.prefill = prefill;
			if (value.promptStyle !== undefined) request.promptStyle = value.promptStyle;
			return request;
		}
		case "ask": {
			if (!Array.isArray(value.questions) || value.questions.length === 0 || value.questions.length > MAX_ASK_QUESTIONS) return null;
			const questions: ChatAskQuestion[] = [];
			for (const raw of value.questions) {
				if (!isRecord(raw) || !isName(raw.id, MAX_ID_LENGTH) || !isText(raw.question, 8_000) || typeof raw.multi !== "boolean") return null;
				if (!Array.isArray(raw.options) || raw.options.length > MAX_UI_OPTIONS) return null;
				const options: { label: string; description?: string }[] = [];
				for (const option of raw.options) {
					if (!isRecord(option) || !isText(option.label, 2_000)) return null;
					const description = optionalText(option.description, 4_000);
					if (description === null) return null;
					options.push(description === undefined ? { label: option.label } : { label: option.label, description });
				}
				const header = optionalText(raw.header, 500);
				if (header === null) return null;
				if (raw.recommended !== undefined && !(typeof raw.recommended === "number" && Number.isInteger(raw.recommended) && raw.recommended >= 0 && raw.recommended < options.length)) return null;
				const question: ChatAskQuestion = { id: raw.id, question: raw.question, options, multi: raw.multi };
				if (header !== undefined) question.header = header;
				if (raw.recommended !== undefined) question.recommended = raw.recommended as number;
				questions.push(question);
			}
			return { id, method: "ask", title, questions };
		}
		default:
			return null;
	}
}

function parseCommands(value: unknown): ChatSlashCommand[] | null {
	if (!Array.isArray(value) || value.length > MAX_COMMANDS) return null;
	const commands: ChatSlashCommand[] = [];
	for (const candidate of value) {
		if (!isRecord(candidate) || !isName(candidate.name, 200)) return null;
		const description = optionalText(candidate.description, 2_000);
		const source = optionalText(candidate.source, MAX_LABEL_LENGTH);
		if (description === null || source === null) return null;
		const command: ChatSlashCommand = { name: candidate.name };
		if (description !== undefined) command.description = description;
		if (source !== undefined) command.source = source;
		const inputHint = optionalText(candidate.inputHint, 500);
		if (inputHint === null) return null;
		if (inputHint !== undefined) command.inputHint = inputHint;
		if (candidate.aliases !== undefined) {
			if (!Array.isArray(candidate.aliases) || candidate.aliases.length > 50 || candidate.aliases.some(alias => !isName(alias, 200))) return null;
			command.aliases = candidate.aliases;
		}
		if (candidate.subcommands !== undefined) {
			if (!Array.isArray(candidate.subcommands) || candidate.subcommands.length > 100) return null;
			const subcommands: { name: string; description?: string; usage?: string }[] = [];
			for (const row of candidate.subcommands) {
				if (!isRecord(row) || !isName(row.name, 200)) return null;
				const description = optionalText(row.description, 500);
				const usage = optionalText(row.usage, 500);
				if (description === null || usage === null) return null;
				subcommands.push({ name: row.name, ...(description === undefined ? {} : { description }), ...(usage === undefined ? {} : { usage }) });
			}
			command.subcommands = subcommands;
		}
		commands.push(command);
	}
	return commands;
}

// Event frames

/**
 * Validate one forwarded frame. The reducer indexes into `message`, `commands` and the
 * like without checking, so every variant it reads is checked field by field here; a frame
 * of a type this page does not know is refused (an older page never guesses at a newer host).
 */
export function parseChatEventFrame(value: unknown): ChatEventFrame | null {
	if (!isRecord(value) || typeof value.type !== "string") return null;
	const native = parseSubagentFrame(value) ?? parseNativeEventFrame(value);
	if (native !== null) return native;
	switch (value.type) {
		case "agent_start":
		case "abort_requested":
		case "turn_start":
		case "turn_end":
		case "session_settled":
		case "model_changed":
		case "todo_auto_clear":
			return { type: value.type };
		case "agent_end": {
			for (const key of ["isTerminal", "yielded", "awaitingAsyncWork"]) {
				if (value[key] !== undefined && typeof value[key] !== "boolean") return null;
			}
			const outcome = value.outcome;
			if (outcome !== undefined && outcome !== null && outcome !== "stop" && outcome !== "length" && outcome !== "toolUse" && outcome !== "error" && outcome !== "aborted") return null;
			return {
				type: "agent_end",
				...(typeof value.isTerminal === "boolean" ? { isTerminal: value.isTerminal } : {}),
				...(typeof value.yielded === "boolean" ? { yielded: value.yielded } : {}),
				...(typeof value.awaitingAsyncWork === "boolean" ? { awaitingAsyncWork: value.awaitingAsyncWork } : {}),
				...(outcome === undefined ? {} : { outcome }),
			};
		}
		case "message_start":
		case "message_update":
		case "message_end": {
			if (!isName(value.messageId, MAX_ID_LENGTH)) return null;
			const message = parseChatMessage(value.message);
			return message === null ? null : { type: value.type, messageId: value.messageId, message };
		}
		case "tool_execution_start": {
			if (!isName(value.toolCallId, MAX_ID_LENGTH) || typeof value.toolName !== "string") return null;
			const intent = optionalText(value.intent, 2_000);
			if (intent === null) return null;
			const frame: ChatEventFrame = { type: "tool_execution_start", toolCallId: value.toolCallId, toolName: value.toolName, args: value.args };
			if (intent !== undefined) frame.intent = intent;
			return frame;
		}
		case "tool_execution_update": {
			if (!isName(value.toolCallId, MAX_ID_LENGTH) || typeof value.toolName !== "string") return null;
			const frame: ChatEventFrame = { type: "tool_execution_update", toolCallId: value.toolCallId, toolName: value.toolName, partialResult: value.partialResult };
			if (value.args !== undefined) frame.args = value.args;
			return frame;
		}
		case "tool_stream_update":
			if (!isName(value.toolCallId, MAX_ID_LENGTH) || typeof value.toolName !== "string") return null;
			return { type: "tool_stream_update", toolCallId: value.toolCallId, toolName: value.toolName, update: value.update };
		case "tool_execution_end": {
			if (!isName(value.toolCallId, MAX_ID_LENGTH) || typeof value.toolName !== "string") return null;
			if (value.isError !== undefined && typeof value.isError !== "boolean") return null;
			const frame: ChatEventFrame = { type: "tool_execution_end", toolCallId: value.toolCallId, toolName: value.toolName, result: value.result };
			if (value.isError !== undefined) frame.isError = value.isError;
			return frame;
		}
		case "prompt_result": {
			const status = typeof value.status === "string" ? PROMPT_STATUS[value.status] : undefined;
			if (status === undefined || typeof value.agentInvoked !== "boolean" || typeof value.sessionSettled !== "boolean") return null;
			const id = optionalText(value.id, MAX_ID_LENGTH);
			if (id === null) return null;
			const frame: ChatEventFrame = { type: "prompt_result", status, agentInvoked: value.agentInvoked, sessionSettled: value.sessionSettled };
			if (id !== undefined) frame.id = id;
			return frame;
		}
		case "command_feedback":
			return isText(value.message, 2_000) ? { type: "command_feedback", message: value.message } : null;
		case "thinking_level_changed": {
			if (value.thinkingLevel !== undefined && value.thinkingLevel !== null && !isText(value.thinkingLevel, MAX_LABEL_LENGTH)) return null;
			return value.thinkingLevel === undefined ? { type: "thinking_level_changed" } : { type: "thinking_level_changed", thinkingLevel: value.thinkingLevel };
		}
		case "queue_update": {
			const queuedMessages = normalizeQueuedMessages(value.queuedMessages);
			return isCount(value.queuedMessageCount) && queuedMessages !== null ? { type: "queue_update", queuedMessageCount: value.queuedMessageCount, queuedMessages } : null;
		}
		case "state_update": {
			const state = parseLiteState(value.state);
			const todoSeed = value.todoSeed === null ? null : parseTodoPhases(value.todoSeed);
			return state === null || (todoSeed === null && value.todoSeed !== null) ? null : { type: "state_update", state, todoSeed };
		}
		case "agents_snapshot": {
			const agents = parseAgentRoster(value.agents);
			return agents === null || (value.availability !== "available" && value.availability !== "unavailable") ? null : { type: "agents_snapshot", agents, availability: value.availability };
		}
		case "agents_liveness": {
			const agents = parseLiveAgents(value.agents);
			return agents === null ? null : { type: "agents_liveness", agents };
		}
		case "config_update": {
			const frame: ChatEventFrame = { type: "config_update" };
			if (value.model !== undefined) {
				const model = value.model === null ? null : parseLiteModel(value.model);
				if (model === null && value.model !== null) return null;
				frame.model = model;
			}
			if (value.thinkingLevel !== undefined) {
				if (value.thinkingLevel !== null && !isText(value.thinkingLevel, MAX_LABEL_LENGTH)) return null;
				frame.thinkingLevel = value.thinkingLevel;
			}
			return frame;
		}
		case "session_info_update": {
			const title = optionalText(value.title, 2_000);
			if (title === null) return null;
			return title === undefined ? { type: "session_info_update" } : { type: "session_info_update", title };
		}
		case "available_commands_update": {
			const commands = parseCommands(value.commands);
			return commands === null ? null : { type: "available_commands_update", commands };
		}
		case "command_output":
			return isText(value.text, 100_000) ? { type: "command_output", text: value.text } : null;
		case "ui_status":
			if (!isName(value.key, MAX_LABEL_LENGTH)) return null;
			if (value.text !== null && !isText(value.text, 2_000)) return null;
			return { type: "ui_status", key: value.key, text: value.text };
		case "ui_widget": {
			if (!isName(value.key, MAX_LABEL_LENGTH)) return null;
			if (value.placement !== undefined && value.placement !== "aboveEditor" && value.placement !== "belowEditor") return null;
			const placement: { placement?: "aboveEditor" | "belowEditor" } = value.placement === undefined ? {} : { placement: value.placement };
			if (value.lines === null) return { type: "ui_widget", key: value.key, lines: null, ...placement };
			if (!Array.isArray(value.lines) || value.lines.length > MAX_WIDGET_LINES) return null;
			const lines: string[] = [];
			for (const line of value.lines) {
				if (!isText(line, 2_000)) return null;
				lines.push(line);
			}
			return { type: "ui_widget", key: value.key, lines, ...placement };
		}
		case "ui_notify":
			return value.level === "warning" && isText(value.message, 2_000) ? { type: "ui_notify", level: "warning", message: value.message } : null;
		case "ui_editor_text":
			return isText(value.text, MAX_CHAT_UI_VALUE_LENGTH) ? { type: "ui_editor_text", text: value.text } : null;
		default:
			return null;
	}
}

// Host → page

function parseSnapshotHead(value: unknown): ChatSnapshotHead | null {
	if (!isRecord(value)) return null;
	const phase = typeof value.phase === "string" ? PHASES[value.phase] : undefined;
	if (phase === undefined) return null;
	if (value.code !== null && !isText(value.code, MAX_LABEL_LENGTH)) return null;
	if (value.readOnlyReason !== null && !isText(value.readOnlyReason, 2_000)) return null;
	const header = value.header === null ? null : parseHeader(value.header);
	if (header === null && value.header !== null) return null;
	if (!isCount(value.olderCount)) return null;
	if (value.leafId !== null && !isText(value.leafId, MAX_ID_LENGTH)) return null;
	const state = value.state === null ? null : parseLiteState(value.state);
	if (state === null && value.state !== null) return null;
	if (typeof value.working !== "boolean" || typeof value.settled !== "boolean") return null;
	if (value.asyncPaused !== undefined && typeof value.asyncPaused !== "boolean") return null;

	if (!Array.isArray(value.pending) || value.pending.length > MAX_PENDING_ROWS) return null;
	const pending: ChatPendingRowPayload[] = [];
	for (const candidate of value.pending) {
		if (!isRecord(candidate) || !isName(candidate.messageId, MAX_ID_LENGTH) || typeof candidate.unsaved !== "boolean" || !isCount(candidate.seq) || (candidate.anchorId !== null && !isName(candidate.anchorId, MAX_ID_LENGTH))) continue;
		const entry = parseEntry(candidate.entry);
		if (entry === null) continue;
		pending.push({ entry, messageId: candidate.messageId, unsaved: candidate.unsaved, anchorId: candidate.anchorId, seq: candidate.seq });
	}

	let stream: ChatSnapshotHead["stream"] = null;
	if (value.stream !== null) {
		if (!isRecord(value.stream) || !isName(value.stream.messageId, MAX_ID_LENGTH)) return null;
		const message = parseAssistantMessage(value.stream.message);
		if (message === null) return null;
		stream = { messageId: value.stream.messageId, message };
	}

	if (!Array.isArray(value.activeTools) || value.activeTools.length > MAX_ACTIVE_TOOLS) return null;
	const activeTools: ActiveTool[] = [];
	for (const candidate of value.activeTools) {
		const tool = parseActiveTool(candidate);
		if (tool === null) return null;
		activeTools.push(tool);
	}

	if (!Array.isArray(value.uiRequests) || value.uiRequests.length > MAX_CHAT_UI_REQUESTS) return null;
	const uiRequests: ChatUiRequest[] = [];
	for (const candidate of value.uiRequests) {
		const request = parseChatUiRequest(candidate);
		if (request === null) return null;
		uiRequests.push(request);
	}

	const commands = parseCommands(value.commands);
	if (commands === null) return null;
	if (typeof value.todoAuthoritative !== "boolean" || !isCount(value.transcriptEventSeq)) return null;
	const agents = parseAgentRoster(value.agents);
	if (agents === null || !Array.isArray(value.agentActivity) || (value.agentAvailability !== "loading" && value.agentAvailability !== "available" && value.agentAvailability !== "unavailable")) return null;
	const agentIds = new Set(agents.map(agent => agent.id));
	const agentActivity: ChatSnapshotHead["agentActivity"][number][] = [];
	for (const row of value.agentActivity) {
		if (!isRecord(row) || typeof row.id !== "string" || !agentIds.has(row.id)) continue;
		const activity = parseAgentActivity(row.activity);
		if (activity !== null) agentActivity.push({ id: row.id, activity });
	}
	const agentIdentities: NonNullable<ChatSnapshotHead["agentIdentities"]>[number][] = [];
	if (Array.isArray(value.agentIdentities)) {
		for (const row of value.agentIdentities.slice(0, MAX_AGENT_IDENTITIES)) {
			if (!isRecord(row) || !isName(row.id, 256) || typeof row.agent !== "string" || typeof row.agentSource !== "string" || (row.description !== undefined && typeof row.description !== "string") || (row.assignment !== undefined && typeof row.assignment !== "string")) continue;
			agentIdentities.push({ id: row.id, agent: row.agent, agentSource: row.agentSource, ...(row.description === undefined ? {} : { description: row.description }), ...(row.assignment === undefined ? {} : { assignment: row.assignment }) });
		}
	}
	let maintenance: MaintenanceState | null = null;
	if (value.maintenance !== null) {
		const raw = value.maintenance;
		if (!isRecord(raw) || typeof raw.action !== "string" || (raw.status !== "working" && raw.status !== "complete" && raw.status !== "cancelled" && raw.status !== "failed" && raw.status !== "skipped")) return null;
		maintenance = { action: raw.action, status: raw.status, ...(typeof raw.reason === "string" ? { reason: raw.reason } : {}), ...(typeof raw.errorMessage === "string" ? { errorMessage: raw.errorMessage } : {}), ...(typeof raw.willRetry === "boolean" ? { willRetry: raw.willRetry } : {}) };
	}
	let retry: RetryState | null = null;
	if (value.retry !== null) {
		const raw = value.retry;
		if (!isRecord(raw) || !isCount(raw.attempt) || !isCount(raw.maxAttempts) || !isCount(raw.delayMs) || typeof raw.errorMessage !== "string" || (raw.status !== "waiting" && raw.status !== "recovered" && raw.status !== "failed")) return null;
		retry = { attempt: raw.attempt, maxAttempts: raw.maxAttempts, delayMs: raw.delayMs, errorMessage: raw.errorMessage, status: raw.status };
	}
	if (!Array.isArray(value.retrySuppressedIds) || value.retrySuppressedIds.some(id => !isName(id, MAX_ID_LENGTH)) || (value.goal !== null && !isRecord(value.goal))) return null;
	if (!Array.isArray(value.ephemeral) || value.ephemeral.length > MAX_EPHEMERAL_ITEMS) return null;
	const ephemeral: EphemeralItem[] = [];
	for (const row of value.ephemeral) {
		if (!isRecord(row) || !isName(row.id, MAX_ID_LENGTH) || !isName(row.kind, MAX_LABEL_LENGTH) || !isCount(row.seq) || !isFiniteNumber(row.timestamp) || (row.anchorId !== null && !isName(row.anchorId, MAX_ID_LENGTH))) continue;
		ephemeral.push({ id: row.id, kind: row.kind, seq: row.seq, anchorId: row.anchorId, timestamp: row.timestamp, payload: row.payload });
	}
	let streamPosition: { anchorId: string | null; seq: number } | null = null;
	if (value.streamPosition !== undefined && value.streamPosition !== null) {
		if (!isRecord(value.streamPosition) || !isCount(value.streamPosition.seq) || (value.streamPosition.anchorId !== null && !isName(value.streamPosition.anchorId, MAX_ID_LENGTH))) return null;
		streamPosition = { anchorId: value.streamPosition.anchorId, seq: value.streamPosition.seq };
	}
	if (value.sealedSeq !== undefined && !isCount(value.sealedSeq)) return null;
	const durablePositions: { entryId: string; anchorId: string | null; seq: number }[] = [];
	if (value.durablePositions !== undefined) {
		if (!Array.isArray(value.durablePositions)) return null;
		for (const row of value.durablePositions) {
			if (!isRecord(row) || !isName(row.entryId, MAX_ID_LENGTH) || !isCount(row.seq) || (row.anchorId !== null && !isName(row.anchorId, MAX_ID_LENGTH))) return null;
			durablePositions.push({ entryId: row.entryId, anchorId: row.anchorId, seq: row.seq });
		}
	}
	const displayTurns: NonNullable<ChatSnapshotHead["displayTurns"]>[number][] = [];
	if (value.displayTurns !== undefined) {
		if (!Array.isArray(value.displayTurns) || value.displayTurns.length > 200) return null;
		for (const turn of value.displayTurns) {
			if (!isRecord(turn) || !isCount(turn.id) || (turn.startedAt !== null && (!isFiniteNumber(turn.startedAt) || turn.startedAt < 0)) || (turn.completedAt !== undefined && turn.completedAt !== null && (!isFiniteNumber(turn.completedAt) || turn.completedAt < 0 || isFiniteNumber(turn.startedAt) && turn.completedAt < turn.startedAt)) || typeof turn.complete !== "boolean" || !Array.isArray(turn.memberKeys) || turn.memberKeys.some(key => typeof key !== "string")) return null;
			displayTurns.push({ id: turn.id, startedAt: turn.startedAt, completedAt: isFiniteNumber(turn.completedAt) ? turn.completedAt : null, complete: turn.complete, memberKeys: turn.memberKeys });
		}
	}

	return {
		phase,
		code: value.code,
		readOnlyReason: value.readOnlyReason,
		header,
		olderCount: value.olderCount,
		leafId: value.leafId,
		branches: parseBranchPoints(value.branches),
		state,
		pending,
		stream,
		activeTools,
		working: value.working,
		workingIntent: typeof value.workingIntent === "string" ? value.workingIntent : null,
		settled: value.settled,
		asyncPaused: value.asyncPaused === true,
		uiRequests,
		todoSeed: value.todoSeed,
		todoAuthoritative: value.todoAuthoritative,
		agents,
		agentActivity,
		agentIdentities,
		agentAvailability: value.agentAvailability,
		maintenance,
		retry,
		retrySuppressedIds: value.retrySuppressedIds,
		goal: value.goal,
		transcriptEventSeq: value.transcriptEventSeq,
		streamPosition,
		sealedSeq: value.sealedSeq ?? 0,
		durablePositions,
		ephemeral,
		commands,
		displayTurns,
	};
}

/** Validate one untrusted host→page `omp:chat-*` payload; `null` when it is not one, or its shape is wrong. */
export function parseChatHostMessage(value: unknown): ChatHostMessage | null {
	if (!isRecord(value) || typeof value.type !== "string") return null;
	switch (value.type) {
		case "omp:chat-send-result": {
			const epoch = parseChatEpoch(value.epoch);
			if (epoch === null || !isChatRequestId(value.requestId) || (value.status !== "accepted" && value.status !== "refused" && value.status !== "unconfirmed" && value.status !== "explained")) return null;
			return { type: value.type, epoch, requestId: value.requestId, status: value.status };
		}
		case "omp:chat-abort-result": {
			const epoch = parseChatEpoch(value.epoch);
			if (epoch === null || !isChatRequestId(value.requestId) || (value.status !== "accepted" && value.status !== "refused" && value.status !== "unconfirmed")) return null;
			if (!Array.isArray(value.entries) || value.entries.length > MAX_RESTORED_MESSAGES || (value.status !== "accepted" && value.entries.length > 0)) return null;
			const entries: ChatRestoredMessage[] = [];
			let imagesDropped = value.imagesDropped === true;
			for (const raw of value.entries) {
				if (!isRecord(raw) || typeof raw.text !== "string" || raw.text.length > MAX_CHAT_TEXT_LENGTH) return null;
				const images = parseRestoredImages(raw.images, false);
				if (images.imagesDropped) imagesDropped = true;
				entries.push(images.images === undefined ? { text: raw.text } : { text: raw.text, images: images.images });
			}
			return { type: value.type, epoch, requestId: value.requestId, status: value.status, entries, ...(imagesDropped ? { imagesDropped: true as const } : {}), ...(value.truncated === true ? { truncated: true as const } : {}) };
		}
		case "omp:chat-navigate-result": {
			if (!isChatRequestId(value.requestId) || (value.status !== "done" && value.status !== "refused" && value.status !== "unconfirmed")) return null;
			const message: ChatNavigateResultMessage = { type: value.type, requestId: value.requestId, status: value.status };
			if (value.status === "refused") {
				if (typeof value.reason !== "string" || !Object.hasOwn(NAVIGATE_REFUSAL_SENTENCES, value.reason) || value.reason === "unconfirmed") return null;
				message.reason = value.reason as NavigateRefusal;
			}
			if (value.status !== "done") return message;
			if (value.kind !== "rewind" && value.kind !== "undo" && value.kind !== "switch") return null;
			message.kind = value.kind;
			message.summarized = value.summarized === true;
			if (value.raced === true) message.raced = true;
			if (value.draft !== undefined) {
				const draft = value.draft;
				if (!isRecord(draft) || typeof draft.text !== "string" || draft.text.length > MAX_CHAT_TEXT_LENGTH || !isCount(draft.unavailableImages)) return null;
				const images = parseRestoredImages(draft.images, false);
				message.draft = { text: draft.text, images: images.images ?? [], unavailableImages: draft.unavailableImages + (images.imagesDropped ? 1 : 0) };
			}
			return message;
		}
		case "omp:chat-display-preferences": {
			const epoch = parseChatEpoch(value.epoch);
			if (epoch === null || (value.toolCallDetail !== "overview" && value.toolCallDetail !== "detailed") || typeof value.accessibilitySupport !== "boolean") return null;
			if ((value.thinkingExpanded !== undefined && typeof value.thinkingExpanded !== "boolean") || (value.toolsExpanded !== undefined && typeof value.toolsExpanded !== "boolean")) return null;
			return {
				type: value.type, epoch, toolCallDetail: value.toolCallDetail, accessibilitySupport: value.accessibilitySupport,
				...(value.thinkingExpanded === undefined ? {} : { thinkingExpanded: value.thinkingExpanded }),
				...(value.toolsExpanded === undefined ? {} : { toolsExpanded: value.toolsExpanded }),
			};
		}
		case "omp:chat-subagent-chunk": {
			const epoch = parseChatEpoch(value.epoch);
			if (epoch === null || !isChatRequestId(value.requestId) || !isName(value.subagentId, 256) || !isCount(value.index) || !isCount(value.chunks) || value.chunks < 1 || value.chunks > MAX_CHAT_SNAPSHOT_CHUNKS || value.index >= value.chunks || !isText(value.text, SUBAGENT_CHUNK_CHARS)) return null;
			return { type: value.type, epoch, requestId: value.requestId, subagentId: value.subagentId, index: value.index, chunks: value.chunks, text: value.text };
		}
		case "omp:chat-queue-result": {
			const epoch = parseChatEpoch(value.epoch);
			if (epoch === null || !isChatRequestId(value.requestId) || !isQueuePurpose(value.purpose)) return null;
			if (!Array.isArray(value.results) || value.results.length === 0 || value.results.length > 2 * MAX_QUEUED_ITEMS) return null;
			const results: ChatQueueResultEntry[] = [];
			for (const raw of value.results) {
				if (!isRecord(raw)) return null;
				if (raw.status !== "removed" && raw.status !== "gone" && raw.status !== "unknown" && raw.status !== "failed") return null;
				results.push(raw.status === "removed" ? { status: "removed", ...parseRestoredImages(raw.images, raw.imagesDropped === true) } : { status: raw.status });
			}
			return { type: "omp:chat-queue-result", epoch, requestId: value.requestId, purpose: value.purpose, results };
		}
		case "omp:chat-state": {
			const epoch = parseChatEpoch(value.epoch);
			const phase = typeof value.phase === "string" ? PHASES[value.phase] : undefined;
			if (epoch === null || phase === undefined) return null;
			if (value.code !== null && !isText(value.code, MAX_LABEL_LENGTH)) return null;
			for (const field of [value.sessionId, value.cwd, value.title]) {
				if (field !== null && !isText(field, 2_000)) return null;
			}
			if (value.readOnlyReason !== null && !isText(value.readOnlyReason, 2_000)) return null;
			return {
				type: "omp:chat-state",
				epoch,
				phase,
				code: value.code,
				sessionId: value.sessionId as string | null,
				cwd: value.cwd as string | null,
				title: value.title as string | null,
				readOnlyReason: value.readOnlyReason,
			};
		}
		case "omp:chat-snapshot": {
			const epoch = parseChatEpoch(value.epoch);
			if (epoch === null || !isName(value.snapshotId, MAX_LABEL_LENGTH)) return null;
			if (!isCount(value.chunks) || value.chunks > MAX_CHAT_SNAPSHOT_CHUNKS) return null;
			const head = parseSnapshotHead(value.head);
			return head === null ? null : { type: "omp:chat-snapshot", epoch, snapshotId: value.snapshotId, chunks: value.chunks, head };
		}
		case "omp:chat-snapshot-chunk": {
			const epoch = parseChatEpoch(value.epoch);
			if (epoch === null || !isName(value.snapshotId, MAX_LABEL_LENGTH) || !isCount(value.index)) return null;
			const entries = parseEntries(value.entries, MAX_CHAT_ROWS_PER_MESSAGE);
			return entries === null ? null : { type: "omp:chat-snapshot-chunk", epoch, snapshotId: value.snapshotId, index: value.index, entries };
		}
		case "omp:chat-event": {
			const epoch = parseChatEpoch(value.epoch);
			if (epoch === null) return null;
			const frame = parseChatEventFrame(value.frame);
			return frame === null ? null : { type: "omp:chat-event", epoch, frame };
		}
		case "omp:chat-entries": {
			const epoch = parseChatEpoch(value.epoch);
			if (epoch === null) return null;
			if (value.leafId !== null && !isText(value.leafId, MAX_ID_LENGTH)) return null;
			const entries = parseEntries(value.entries, MAX_CHAT_ROWS_PER_MESSAGE);
			return entries === null ? null : { type: "omp:chat-entries", epoch, entries, leafId: value.leafId };
		}
		case "omp:chat-older": {
			const epoch = parseChatEpoch(value.epoch);
			if (epoch === null || !isCount(value.olderCount)) return null;
			const entries = parseEntries(value.entries, MAX_CHAT_ROWS_PER_MESSAGE);
			return entries === null ? null : { type: "omp:chat-older", epoch, entries, olderCount: value.olderCount };
		}
		case "omp:chat-ui-request": {
			const epoch = parseChatEpoch(value.epoch);
			const request = parseChatUiRequest(value.request);
			return epoch === null || request === null ? null : { type: "omp:chat-ui-request", epoch, request };
		}
		case "omp:chat-ui-cancel": {
			const epoch = parseChatEpoch(value.epoch);
			if (epoch === null || !isName(value.targetId, MAX_ID_LENGTH)) return null;
			return { type: "omp:chat-ui-cancel", epoch, targetId: value.targetId };
		}
		default:
			return null;
	}
}

// Page → host

/**
 * Images of one prompt: a bounded count, a supported type, canonical base64 that fits the
 * per-image and per-prompt budgets. `undefined` means "none" and is valid; `null` means unusable.
 */
function parseImages(value: unknown): ChatImageWire[] | undefined | null {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CHAT_IMAGES) return null;
	const images: ChatImageWire[] = [];
	let total = 0;
	for (const candidate of value) {
		if (!isRecord(candidate) || candidate.type !== "image") return null;
		if (typeof candidate.mimeType !== "string" || IMAGE_MIME[candidate.mimeType] !== true) return null;
		const data = candidate.data;
		if (typeof data !== "string" || data.length === 0 || data.length > MAX_CHAT_IMAGE_BASE64_CHARS) return null;
		total += data.length;
		if (total > MAX_CHAT_IMAGES_BASE64_CHARS || !BASE64.test(data)) return null;
		images.push({ type: "image", mimeType: candidate.mimeType, data });
	}
	return images;
}

/**
 * The images of one removed queued message, as the page may attach them. A queued message must never be lost
 * because its attachment cannot be carried, so an unparsable or oversized set is reported as dropped instead
 * of failing the whole result.
 */
export function parseRestoredImages(images: unknown, reportedDropped: boolean): { images?: ChatImageWire[]; imagesDropped?: true } {
	if (images === undefined || (Array.isArray(images) && images.length === 0)) return reportedDropped ? { imagesDropped: true } : {};
	const parsed = parseImages(images);
	if (parsed === null || parsed === undefined) return { imagesDropped: true };
	return reportedDropped ? { images: parsed, imagesDropped: true } : { images: parsed };
}

/** `items` of a queue removal: exact queue-chip texts, each named with the queue it waits in. */
function parseQueuedRefs(value: unknown): ChatQueuedRef[] | null {
	if (!Array.isArray(value) || value.length === 0 || value.length > 2 * MAX_QUEUED_ITEMS) return null;
	const refs: ChatQueuedRef[] = [];
	let total = 0;
	for (const raw of value) {
		if (!isRecord(raw) || (raw.queue !== "steering" && raw.queue !== "followUp") || !isText(raw.text, MAX_QUEUED_TEXT_LENGTH)) return null;
		total += queuedJsonBytes(raw.text);
		if (total > MAX_QUEUED_TOTAL_BYTES) return null;
		refs.push({ queue: raw.queue, text: raw.text });
	}
	return refs;
}

function isQueuePurpose(value: unknown): value is ChatQueuePurpose {
	return value === "cancel" || value === "edit" || value === "promote";
}

/**
 * Validate one untrusted page→host `omp:chat-*` payload. The host parses with this before it
 * touches the rpc channel, so a malformed or oversized command never becomes a stdin line.
 */
export function parseChatWebviewMessage(value: unknown): ChatWebviewMessage | null {
	if (!isRecord(value) || typeof value.type !== "string") return null;
	if (!isChatRequestId(value.requestId)) return null;
	const requestId = value.requestId;
	switch (value.type) {
		case "omp:chat-tool-detail": {
			const epoch = parseChatEpoch(value.epoch);
			if (epoch === null) return null;
			return { type: value.type, epoch, requestId };
		}
		case "omp:chat-subagent-read": {
			const epoch = parseChatEpoch(value.epoch);
			if (epoch === null || !isName(value.subagentId, 256) || !isCount(value.fromByte) || (value.beforeId !== undefined && !isName(value.beforeId, MAX_ID_LENGTH))) return null;
			return { type: value.type, epoch, requestId, subagentId: value.subagentId, fromByte: value.fromByte, ...(value.beforeId === undefined ? {} : { beforeId: value.beforeId }) };
		}
		case "omp:chat-prompt":
		case "omp:chat-steer":
		case "omp:chat-follow-up": {
			if (typeof value.text !== "string" || value.text.length > MAX_CHAT_TEXT_LENGTH) return null;
			const images = parseImages(value.images);
			if (images === null) return null;
			// A message with neither text nor image asks OMP for nothing.
			if (value.text.trim().length === 0 && images === undefined) return null;
			const message = { type: value.type, requestId, text: value.text } as ChatPromptMessage | ChatSteerMessage | ChatFollowUpMessage;
			if (images !== undefined) message.images = images;
			return message;
		}
		case "omp:chat-abort":
			return { type: "omp:chat-abort", requestId };
		case "omp:chat-navigate": {
			const { kind, targetId, expectedLeafId, summarize } = value;
			if ((kind !== "rewind" && kind !== "undo" && kind !== "switch") || !isName(targetId, MAX_ID_LENGTH) || (expectedLeafId !== null && !isName(expectedLeafId, MAX_ID_LENGTH)) || typeof summarize !== "boolean") return null;
			return { type: "omp:chat-navigate", requestId, kind, targetId, expectedLeafId, summarize };
		}
		case "omp:chat-ui-response": {
			const response = value.response;
			if (!isRecord(response) || !isName(response.id, MAX_ID_LENGTH)) return null;
			const { id } = response;
			// Exactly one answer field: a response naming two would be ambiguous to settle.
			const answers = ["value", "confirmed", "cancelled", "answers"].filter(key => response[key] !== undefined);
			if (answers.length !== 1) return null;
			if (response.value !== undefined) {
				if (!isText(response.value, MAX_CHAT_UI_VALUE_LENGTH)) return null;
				return { type: "omp:chat-ui-response", requestId, response: { id, value: response.value } };
			}
			if (response.confirmed !== undefined) {
				if (typeof response.confirmed !== "boolean") return null;
				return { type: "omp:chat-ui-response", requestId, response: { id, confirmed: response.confirmed } };
			}
			if (response.answers !== undefined) {
				if (!Array.isArray(response.answers) || response.answers.length === 0 || response.answers.length > MAX_ASK_QUESTIONS) return null;
				const given: ChatAskAnswer[] = [];
				for (const raw of response.answers) {
					if (!isRecord(raw) || !isName(raw.id, MAX_ID_LENGTH) || !Array.isArray(raw.selectedOptions) || raw.selectedOptions.length > MAX_UI_OPTIONS) return null;
					if (!raw.selectedOptions.every((label): label is string => isText(label, 2_000))) return null;
					const customInput = optionalText(raw.customInput, MAX_CHAT_UI_VALUE_LENGTH);
					if (customInput === null) return null;
					given.push(customInput === undefined ? { id: raw.id, selectedOptions: raw.selectedOptions } : { id: raw.id, selectedOptions: raw.selectedOptions, customInput });
				}
				return { type: "omp:chat-ui-response", requestId, response: { id, answers: given } };
			}
			return response.cancelled === true ? { type: "omp:chat-ui-response", requestId, response: { id, cancelled: true } } : null;
		}
		case "omp:chat-load-older":
			return isName(value.beforeId, MAX_ID_LENGTH) ? { type: "omp:chat-load-older", requestId, beforeId: value.beforeId } : null;
		case "omp:chat-resume":
			return { type: "omp:chat-resume", requestId };
		case "omp:chat-reconnect":
			return { type: "omp:chat-reconnect", requestId };
		case "omp:chat-restart": {
			const epoch = parseChatEpoch(value.epoch);
			return epoch === null ? null : { type: "omp:chat-restart", requestId, epoch };
		}
		case "omp:chat-queue-remove": {
			const epoch = parseChatEpoch(value.epoch);
			if (epoch === null || !isQueuePurpose(value.purpose)) return null;
			const items = parseQueuedRefs(value.items);
			return items === null ? null : { type: "omp:chat-queue-remove", requestId, epoch, purpose: value.purpose, items };
		}
		default:
			return null;
	}
}

// Snapshot transport

const encoder = new TextEncoder();

/**
 * Split an authoritative snapshot into the head message and row chunks, each within
 * `maxChunkBytes` of JSON. A row larger than the budget travels alone (a row cannot be split).
 * The head carries everything but the rows, so a snapshot of no rows is one message.
 */
export function splitChatSnapshot(
	payload: ChatSnapshotPayload,
	snapshotId: string,
	maxChunkBytes: number = CHAT_SNAPSHOT_CHUNK_BYTES,
): { snapshot: ChatSnapshotMessage; chunks: ChatSnapshotChunkMessage[] } {
	const { epoch, entries, ...head } = payload;
	const groups: ChatEntry[][] = [];
	let current: ChatEntry[] = [];
	let bytes = 0;
	for (const entry of entries) {
		const size = encoder.encode(JSON.stringify(entry)).length + 1;
		if (current.length > 0 && (bytes + size > maxChunkBytes || current.length >= MAX_CHAT_ROWS_PER_MESSAGE)) {
			groups.push(current);
			current = [];
			bytes = 0;
		}
		current.push(entry);
		bytes += size;
	}
	if (current.length > 0) groups.push(current);
	return {
		snapshot: { type: "omp:chat-snapshot", epoch, snapshotId, chunks: groups.length, head },
		chunks: groups.map((rows, index) => ({ type: "omp:chat-snapshot-chunk", epoch, snapshotId, index, entries: rows })),
	};
}

/**
 * Reassembles a chunked snapshot on the page. The page never sees half a transcript: the
 * payload is returned only when every announced chunk has arrived, and a newer snapshot
 * abandons a train still in flight (a chunk that names no open train is dropped).
 */
export class ChatSnapshotAssembler {
	#open: { message: ChatSnapshotMessage; parts: Map<number, readonly ChatEntry[]>; rows: number } | null = null;

	/** Begin a snapshot; returns the payload at once when it announces no chunks. */
	begin(message: ChatSnapshotMessage): ChatSnapshotPayload | null {
		this.#open = null;
		if (message.chunks === 0) return { epoch: message.epoch, entries: [], ...message.head };
		this.#open = { message, parts: new Map(), rows: 0 };
		return null;
	}

	/** Add one chunk; returns the complete payload when this was the last one. */
	add(chunk: ChatSnapshotChunkMessage): ChatSnapshotPayload | null {
		const open = this.#open;
		if (open === null) return null;
		const { message } = open;
		if (chunk.snapshotId !== message.snapshotId) return null;
		if (chunk.epoch.nonce !== message.epoch.nonce || chunk.epoch.counter !== message.epoch.counter) return null;
		if (chunk.index >= message.chunks || open.parts.has(chunk.index)) return null;
		open.rows += chunk.entries.length;
		if (open.rows > MAX_CHAT_SNAPSHOT_ROWS) {
			this.#open = null;
			return null;
		}
		open.parts.set(chunk.index, chunk.entries);
		if (open.parts.size < message.chunks) return null;
		const entries: ChatEntry[] = [];
		for (let index = 0; index < message.chunks; index += 1) entries.push(...(open.parts.get(index) ?? []));
		this.#open = null;
		return { epoch: message.epoch, entries, ...message.head };
	}

	/** Drop an unfinished train. */
	reset(): void {
		this.#open = null;
	}
}
