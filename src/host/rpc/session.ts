/**
 * `RpcSession`: the extension host's runtime for one conversation served by one `omp --mode rpc-ui` child.
 *
 * A state machine over an {@link RpcChannel} port: `starting → attaching → resyncing → live`, then `stopped`
 * (child exited / closed) or `failed` (bounded code, fixed sentence at the render site). Phase names are a fixed
 * vocabulary; the session never forwards arbitrary child text.
 *
 * Attach sequence (identical for the first attach after launch, an extension-host restart and a full restart):
 * 1. disk paint — `history-reader.ts` reads the JSONL (in parallel with the rest) and the tail window is published
 *    at once, so history shows independent of `ready`;
 * 2. broker attach with a replay cursor; replayed and live lines fold into the *shadow* model only (nothing reaches
 *    a page) until the resync completes;
 * 3. `get_state` (identity bound here, before any `set_model`) then `get_entries { since: cursor }`;
 * 4. one authoritative snapshot (phase `live`, epoch counter + 1); afterwards every frame is forwarded as an event.
 *
 * Commands are correlated by id (`vsc:<requestId>` for user mutations, `int:<n>` internally). `message_update`
 * frames are coalesced per `messageId` within one synchronous burst of lines, so the parse cost is linear in the
 * reply length. A message that ended live before its entry is durable is a pending row in the model; the session
 * reconciles at `agent_end`, `prompt_result`, `session_settled` and on every reattach, and flags rows still
 * unmatched after three attempts and one settle as *not yet saved* — never dropping or duplicating them.
 */
import { stat } from "node:fs/promises";
import path from "node:path";
import { CHAT_EXIT_STDERR_BYTES, parseChatExitReason, type ChatExitReason } from "../../chat/exit-reason.ts";
import {
	applyChatEntries,
	applyChatLiteState,
	applyChatOlder,
	applyChatRewrite,
	askAnswersMatch,
	applyChatUiCancel,
	applyChatUiRequest,
	createChatModel,
	dropPendingSavedElsewhere,
	markPendingUnsaved,
	normalizeUiRequest,
	reduceChatFrame,
	setChatPhase,
	snapshotOf,
	type ChatCode,
	type ChatEntriesPayload,
	type ChatEpoch,
	type ChatEventFrame,
	type ChatModel,
	type ChatLiteState,
	type ChatOlderPayload,
	type ChatPhase,
	type ChatPromptResult,
	type ChatSnapshotPayload,
	type ChatStatePayload,
	type ChatUiRequest,
	type ChatUiResponse,
	type ChatLiteModel,
} from "../../chat/model.ts";
import { parseChatEntry, type ChatEntry } from "../../chat/messages.ts";
import {
	NAVIGATE_COMMAND,
	NAVIGATE_ERROR_PATH,
	branchNodesOf,
	computeBranchPoints,
	encodeNavigateCommand,
	isRewindTarget,
	navigateErrorCode,
	navigationMarker,
	rewindDraft,
	undoOffer,
	leafReaches,
	type NavigateRefusal,
	type NavigationKind,
	type RewindDraft,
} from "../../chat/rewind.ts";
import { rendersTranscriptEntry } from "../../chat/transcript.ts";
import { transcriptWindow } from "../../webview/lib/transcript-window.ts";
import { blobsDirectoryFor, resolveBlobImages } from "./history-blobs.ts";
import { parseAgentRoster } from "../../chat/agents.ts";
import { childPageFromNative, type SubagentTranscriptPage } from "../../chat/subagent-transcript.ts";
import { isRecord } from "../../guards.ts";
import { RpcFrameReader, type RpcFrameCounters } from "./frames.ts";
import {
	DENIED_SLASH_COMMANDS,
	INTERNAL_ID_PREFIX,
	VSC_ID_PREFIX,
	classifySlashInput,
	encodeCommand,
	encodeUiResponse,
	isRecoverableRpcFailure,
	isResponseFrame,
	parseLiteModel,
	parseCommands,
	parseStateData,
	toChatEventFrame,
	writeErrorCode,
	type ParsedState,
	type RpcAttachResult,
	type RpcChannel,
	type RpcChannelEvent,
	type RpcCommand,
	type RpcErrorCode,
	type RpcImage,
	type RpcResponseFrame,
	type RpcWriteErrorCode,
	type RpcToolDescriptor,
} from "./protocol.ts";
import { AGENT_LIVENESS_STATUS_KEY, AgentLivenessGuard } from "../../chat/agent-liveness.ts";
import {
	DEFAULT_TAIL_ROWS,
	HistoryReader,
	chatSnapshotFromHistory,
	type HistoryOlder,
	type HistoryRefresh,
	type HistorySnapshot,
} from "./history-reader.ts";

/** Time and timers; injectable so the state machine is deterministic in tests. */
export interface RpcSessionTimers {
	now(): number;
	setTimeout(handler: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

export const SYSTEM_TIMERS: RpcSessionTimers = {
	now: () => Date.now(),
	setTimeout: (handler, ms) => setTimeout(handler, ms),
	clearTimeout: handle => clearTimeout(handle as NodeJS.Timeout),
};

/** The part of {@link HistoryReader} the session uses. */
export interface HistoryPort {
	snapshot(rows?: number, leafId?: string | null): Promise<HistorySnapshot>;
	loadOlder(beforeId: string, rows?: number): Promise<HistoryOlder>;
	refresh(): Promise<HistoryRefresh>;
}

export interface RpcSessionOptions {
	channel: RpcChannel;
	/** The exact session file the process must serve; `null` for a new conversation (learned from `get_state`). */
	sessionFile: string | null;
	/** Working directory shown for a new conversation (an existing file's header cwd wins). */
	cwd: string;
	/** Identifies this host instance in every {@link ChatEpoch}; differs per extension-host start. */
	hostNonce: string;
	timers?: RpcSessionTimers;
	/** Opens the history reader; defaults to {@link HistoryReader.open}. */
	openHistory?: (file: string) => Promise<HistoryPort>;
	/** Whether a file exists; defaults to `fs.stat`. */
	fileExists?: (file: string) => Promise<boolean>;
	/** Last broker line seq already folded (0 after a host restart). */
	initialSeq?: number;
	tailRows?: number;
	readyTimeoutMs?: number;
	commandTimeoutMs?: number;
	reconcileIntervalMs?: number;
	reconcileAttempts?: number;
	/** Delays between reattach attempts after a broker link drop; the list length is the attempt budget. */
	reattachDelaysMs?: readonly number[];
	/** Delays between background retries of a failed (recoverable) session; the list length is the retry budget. */
	autoRecoveryDelaysMs?: readonly number[];
	/** How often the liveness watchdog looks at the silence of a live connection. */
	watchdogIntervalMs?: number;
	/** Silence tolerated while a turn (or background work) is in flight before the connection is probed. */
	workingSilenceMs?: number;
	/** Silence tolerated by an idle live session before the connection is probed. */
	idleSilenceMs?: number;
	/** How long a watchdog probe (`get_state`) may stay unanswered before the connection is dropped and reattached. */
	probeTimeoutMs?: number;
}

export type RpcSessionOutput =
	| { type: "state"; payload: ChatStatePayload }
	| { type: "snapshot"; payload: ChatSnapshotPayload; baseline: boolean }
	| { type: "event"; epoch: ChatEpoch; frame: ChatEventFrame }
	| { type: "entries"; payload: ChatEntriesPayload }
	| { type: "ui-request"; epoch: ChatEpoch; request: ChatUiRequest }
	| { type: "ui-cancel"; epoch: ChatEpoch; targetId: string }
	/** `open_url`: the host shows an extension-owned confirm naming the URL. */
	| { type: "open-url"; url: string; launchUrl?: string; instructions?: string }
	/** The bound identity: learned for a new session, verified for a resumed one. */
	| { type: "identity"; sessionFile: string; sessionId: string }
	| { type: "prompt-result"; requestId: string | null; result: ChatPromptResult }
	/** A prompt sent, unconfirmed across a disconnect, never showed up: *not delivered — send again manually*. */
	| { type: "prompt-lost"; requestId: string }
	/** A retained `vsc:` response no pending command claims (learned after a host restart). */
	| { type: "late-response"; requestId: string; success: boolean; code?: string }
	/** Fires after every applied frame or reconciliation while live; consumers read the model for activity. */
	| { type: "model"; model: ChatModel }
	/** The session healed itself (or was asked to): a bounded reason for the diagnostics log, never child text. */
	| { type: "recovery"; reason: RpcRecoveryReason }
	/** An OMP extension's error `notify`; the host shows it as an error message rather than in the transcript. */
	| { type: "extension-error"; message: string };

export type RpcRecoveryReason = "probe-timeout" | "stale-working" | "frame-failure" | "manual-reconnect" | "auto-retry";

export type SendRefusal =
	| "slash-denied"
	| "not-live"
	| "not-owner"
	| "busy"
	| "bad-request-id"
	| "write-failed"
	| "rejected";

/** Fresh process facts used at a fenced lifecycle boundary, not screen activity. */
export interface RpcSettlementState {
	readonly sessionFile: string | null;
	readonly sessionId: string | null;
	readonly settled: boolean;
	readonly hasContent: boolean | null;
}

export type SendOutcome =
	| { status: "accepted"; agentInvoked: boolean | null }
	| { status: "refused"; reason: SendRefusal; command?: string; code?: string }
	/** The line may or may not have reached the child (the link dropped first). Never resent automatically. */
	| { status: "unconfirmed" };

export interface PromptRequest {
	requestId: string;
	text: string;
	images?: readonly RpcImage[];
	/** How a prompt that races a running turn is queued. Default `steer`. */
	streamingBehavior?: "steer" | "followUp";
}

export interface MessageRequest {
	requestId: string;
	text: string;
	images?: readonly RpcImage[];
}

/** One pending user message, named by the queue it waits in and its exact queue-chip text. */
export interface QueuedRef {
	queue: "steering" | "followUp";
	text: string;
}

/**
 * What happened to one {@link QueuedRef}:
 * - `removed`: OMP took it out of its queue; `images` are its attachments (`imagesDropped` when OMP or this host
 *   could not carry some of them);
 * - `gone`: OMP found no such message — it had already been delivered (or removed) before the command ran;
 * - `unknown`: the answer was lost, so the message may or may not have been removed;
 * - `failed`: OMP refused the command or it was never sent; the message is still queued as far as the host knows.
 */
export type QueueRemoval = QueuedRef &
	(
		| { status: "removed"; images: readonly RpcImage[]; imagesDropped: boolean }
		| { status: "gone" }
		| { status: "unknown" }
		| { status: "failed" }
	);

export type RemoveQueuedOutcome = { status: "done"; removals: readonly QueueRemoval[] } | { status: "refused"; reason: SendRefusal };

const MAX_RESTORED_IMAGES = 8;

function parseRemoval(item: QueuedRef, data: unknown): QueueRemoval {
	if (!isRecord(data) || typeof data.removed !== "boolean") return { queue: item.queue, text: item.text, status: "unknown" };
	if (!data.removed) return { queue: item.queue, text: item.text, status: "gone" };
	const images: RpcImage[] = [];
	let imagesDropped = data.imagesDropped === true;
	for (const image of Array.isArray(data.images) ? data.images : []) {
		if (images.length < MAX_RESTORED_IMAGES && isRecord(image) && image.type === "image" && typeof image.data === "string" && typeof image.mimeType === "string") {
			images.push({ type: "image", data: image.data, mimeType: image.mimeType });
		} else {
			imagesDropped = true;
		}
	}
	return { queue: item.queue, text: item.text, status: "removed", images, imagesDropped };
}

export type ModelsResult =
	| { status: "ok"; models: ChatLiteModel[] }
	| { status: "refused"; reason: SendRefusal }
	| { status: "failed" };

export type ThinkingLevelsResult =
	| { status: "ok"; levels: string[] }
	| { status: "refused"; reason: SendRefusal }
	| { status: "failed" };

/** What `abort_and_restore_queue` handed back: the user's withdrawn messages, steering then follow-ups, oldest first. */
export interface RestoredQueue {
	readonly entries: readonly { readonly text: string; readonly images: readonly RpcImage[] }[];
	/** OMP withheld the images to fit its response; the texts are complete. */
	readonly imagesDropped: boolean;
	/** OMP kept only an oldest-first prefix of the texts to fit its response. */
	readonly truncated: boolean;
}

export type AbortRestoreOutcome =
	| { status: "accepted"; restored: RestoredQueue }
	| { status: "refused"; reason: SendRefusal }
	| { status: "unconfirmed" };

/** One in-place navigation (ADR-0051): rewind to a prompt, Undo to the previous tip, or switch to a branch tip. */
export interface NavigateRequest {
	/** 32 lowercase hex: it also names the marker OMP appends. */
	requestId: string;
	kind: NavigationKind;
	targetId: string;
	/** The leaf the request was made against (compare-and-swap, checked here and again inside OMP). */
	expectedLeafId: string | null;
	summarize: boolean;
}

export type NavigateOutcome =
	/** `raced`: OMP reported a leaf other than the one checked (the session moved meanwhile); the move is still real. */
	| { status: "done"; kind: NavigationKind; summarized: boolean; raced: boolean; draft: RewindDraft | null }
	| { status: "refused"; reason: NavigateRefusal }
	/** The command may or may not have run (lost answer or result). Never retried; the re-read shows the outcome. */
	| { status: "unconfirmed" };

const NAVIGATE_REQUEST_ID = /^[0-9a-f]{32}$/;
/** How long the command's `prompt_result` may take; a summary is a model call. */
const NAVIGATE_RESULT_MS = 30_000;
const NAVIGATE_SUMMARY_RESULT_MS = 180_000;
/** A disk that trails the live process gets one more look after this long before the re-sync reads `get_entries`. */
const REBUILD_RETRY_MS = 150;

/**
 * How the wait for a navigation command ended (ADR-0051). `result`: its `prompt_result`; `local`: OMP answered the
 * prompt itself (an input hook) and owes no result; `rejected`: an error acknowledgement; `fell-through`: the text
 * reached the model as a prompt; `timeout`/`lost`: no answer, so the command may still be running.
 */
type NavigationWait = "result" | "local" | "rejected" | "fell-through" | "timeout" | "lost";

/** A one-shot child command whose answer carries data (`cycle_*`, `promote`, `export_html`, a maintenance report). */
export type CommandResult<T> =
	| { status: "ok"; value: T }
	| { status: "refused"; reason: SendRefusal; code?: string }
	| { status: "unconfirmed" };

/** The `/compact` modes of installed OMP (`session/compact-modes.ts`). */
export type CompactMode = "snapcompact" | "soft" | "remote";
/** The `/shake` modes of installed OMP (`slash-commands/builtin-lifecycle.ts`). */
export type ShakeMode = "elide" | "images" | "thinking";
/** A manual context-maintenance pass: `/compact <mode> [focus]` or `/shake <mode>`. */
export type MaintenanceRequest =
	| { readonly kind: "compact"; readonly mode: CompactMode; readonly instructions?: string }
	| { readonly kind: "shake"; readonly mode: ShakeMode };

/** A manual compaction can run a model summary: its report is awaited far longer than an ordinary command. */
const MAINTENANCE_REPORT_TIMEOUT_MS = 15 * 60_000;
/** HTML export renders the whole session. */
const EXPORT_TIMEOUT_MS = 2 * 60_000;
/**
 * Stop queues behind whatever serial command the child is running (a manual shake at worst) and then waits
 * for the turn to go idle. OMP has already withdrawn the queue when it answers, so the answer must not be given up early.
 */
const ABORT_RESTORE_TIMEOUT_MS = MAINTENANCE_REPORT_TIMEOUT_MS + 2 * 60_000;
const MAX_RESTORED_ENTRIES = 64;

/** The `abort_and_restore_queue` answer, validated; anything malformed restores nothing rather than guessing. */
export function parseRestoredQueue(data: unknown): RestoredQueue {
	const entries: { text: string; images: RpcImage[] }[] = [];
	// OMP has already withdrawn these messages: whatever is not handed back is flagged, never dropped silently.
	let imagesDropped = isRecord(data) && data.imagesDropped === true;
	let truncated = isRecord(data) && data.truncated === true;
	if (isRecord(data)) {
		for (const queue of [data.steering, data.followUp]) {
			if (!Array.isArray(queue)) continue;
			for (const entry of queue) {
				if (!isRecord(entry) || typeof entry.text !== "string") continue;
				if (entries.length >= MAX_RESTORED_ENTRIES) { truncated = true; continue; }
				const offered = Array.isArray(entry.images) ? entry.images : [];
				const images = offered.slice(0, MAX_RESTORED_IMAGES).flatMap(image => isRecord(image) && image.type === "image" && typeof image.mimeType === "string" && typeof image.data === "string"
					? [{ type: "image" as const, mimeType: image.mimeType, data: image.data }] : []);
				if (images.length < offered.length) imagesDropped = true;
				entries.push({ text: entry.text, images });
			}
		}
	}
	return { entries, imagesDropped, truncated };
}

export interface RpcSessionDiagnostics {
	frames: Readonly<RpcFrameCounters>;
	protocolErrors: number;
	resyncs: number;
	historyFallbacks: number;
	unrenderableDialogs: number;
	/** Frames that could not be applied and were healed by a rebuild instead of stalling the stream. */
	frameFailures: number;
	watchdogProbes: number;
	recoveries: number;
	stderrTail: string;
	lastSeq: number;
}

const DEFAULT_READY_TIMEOUT_MS = 120_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_RECONCILE_INTERVAL_MS = 500;
const DEFAULT_RECONCILE_ATTEMPTS = 3;
const DEFAULT_REATTACH_DELAYS_MS: readonly number[] = [250, 500, 1_000, 2_000, 4_000, 5_000, 5_000, 5_000, 5_000, 5_000];
/** After the reattach budget is spent: slower background retries of a recoverable failure, then the page's Reconnect is the only way. */
const DEFAULT_AUTO_RECOVERY_DELAYS_MS: readonly number[] = [3_000, 10_000, 30_000, 60_000, 60_000, 60_000];
const DEFAULT_WATCHDOG_INTERVAL_MS = 15_000;
const DEFAULT_WORKING_SILENCE_MS = 45_000;
const DEFAULT_IDLE_SILENCE_MS = 90_000;
const DEFAULT_PROBE_TIMEOUT_MS = 15_000;
/** A frame that cannot be applied triggers at most one rebuild per this interval. */
const FRAME_FAILURE_RESYNC_GAP_MS = 2_000;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,120}$/;
const MAX_REMEMBERED_REQUESTS = 256;
const MAX_LEDGER = 64;
const STDERR_TAIL_BYTES = CHAT_EXIT_STDERR_BYTES;
const MESSAGE_ID_TAIL = /,"messageId":"([^"\\]{1,64})"\}$/;

/** A failure that ends the establish sequence with a bounded code. */
class SessionFailure extends Error {
	readonly code: RpcErrorCode;
	constructor(code: RpcErrorCode) {
		super(code);
		this.name = "SessionFailure";
		this.code = code;
	}
}

class CommandFailure extends Error {
	readonly reason: "timeout" | "write" | "closed" | "unconfirmed";
	readonly writeCode: RpcWriteErrorCode | null;
	constructor(reason: CommandFailure["reason"], writeCode: RpcWriteErrorCode | null = null) {
		super(reason);
		this.name = "CommandFailure";
		this.reason = reason;
		this.writeCode = writeCode;
	}
}

interface PendingCommand {
	command: RpcCommand;
	resolve(response: RpcResponseFrame): void;
	reject(error: CommandFailure): void;
	timer: unknown;
	/** `#queueRevision` when the command was written: a `get_state` answer is no newer than a later `queue_update`. */
	queueRevision: number;
}

interface LedgerEntry {
	requestId: string;
	text: string;
	sentAt: number;
	unconfirmed: boolean;
}

/** Whether two file paths name the same file (Windows: case- and separator-insensitive). */
export function samePath(a: string, b: string): boolean {
	const left = path.resolve(a);
	const right = path.resolve(b);
	return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/** The raw entries of a `get_entries` response that are on the branch ending at `leafId`, oldest first. */
function branchOf(
	entries: readonly Record<string, unknown>[],
	leafId: string | null,
): { rows: Record<string, unknown>[]; rootParent: string | null; found: boolean } {
	if (entries.length === 0) return { rows: [], rootParent: null, found: true };
	if (leafId === null) return { rows: [...entries], rootParent: null, found: true };
	const byId = new Map<string, Record<string, unknown>>();
	for (const entry of entries) byId.set(entry.id as string, entry);
	const chain: Record<string, unknown>[] = [];
	const seen = new Set<string>();
	let current = byId.get(leafId);
	if (current === undefined) return { rows: [], rootParent: null, found: false };
	while (current !== undefined && !seen.has(current.id as string)) {
		seen.add(current.id as string);
		chain.push(current);
		const parentId: unknown = current.parentId;
		current = typeof parentId === "string" ? byId.get(parentId) : undefined;
	}
	chain.reverse();
	const first = chain[0]!;
	return { rows: chain, rootParent: typeof first.parentId === "string" ? first.parentId : null, found: true };
}

function isEntryRecord(value: unknown): value is Record<string, unknown> {
	return isRecord(value) && typeof value.id === "string" && typeof value.type === "string";
}

async function defaultFileExists(file: string): Promise<boolean> {
	try {
		await stat(file);
		return true;
	} catch {
		return false;
	}
}

function userMessageText(entry: ChatEntry): string | null {
	if (entry.type !== "message" || entry.message.role !== "user") return null;
	const content = entry.message.content;
	if (typeof content === "string") return content;
	const first = content.find(block => block.type === "text");
	return first !== undefined && first.type === "text" ? first.text : "";
}

export class RpcSession {
	readonly #channel: RpcChannel;
	readonly #timers: RpcSessionTimers;
	readonly #options: RpcSessionOptions;
	readonly #listeners = new Set<(output: RpcSessionOutput) => void>();
	readonly #frames = new RpcFrameReader();
	readonly #pendingCommands = new Map<string, PendingCommand>();
	readonly #subagentReferences = new Set<string>();
	/** Session-bound, sequence-checked acceptance of the Desk liveness signal (ADR-0053). */
	readonly #agentLiveness = new AgentLivenessGuard();
	readonly #requests = new Map<string, Promise<SendOutcome>>();
	readonly #queueRequests = new Map<string, Promise<RemoveQueuedOutcome>>();
	readonly #abortRequests = new Map<string, Promise<AbortRestoreOutcome>>();
	readonly #ledger: LedgerEntry[] = [];

	#model: ChatModel;
	#epochCounter = 0;
	#commandRevision = 0;
	#reader: HistoryPort | null = null;
	#tailRows: number;
	#lastSeq: number;
	/** Last raw entry id known durable (the `get_entries { since }` cursor); null = a full read is needed. */
	#cursor: string | null = null;
	#boundFile: string | null;
	#boundId: string | null = null;
	#identityVerified = false;
	#nativeStateUnanswered = false;
	#stateAnswerRevision = 0;
	/**
	 * Counts the child's `queue_update` frames. OMP can cut a `get_state` queue before a dequeue it then reports in a
	 * `queue_update`, yet write the answer after that frame (a read sent while an abort runs is answered behind it);
	 * folding that answer would bring back a message already delivered, and OMP coalesces, so nothing would remove it.
	 */
	#queueRevision = 0;
	#fileMaterialized: boolean;
	#slashArmed = false;
	#internalSeq = 0;
	/** Takes the next `command_output` line while a manual maintenance pass waits for its report. */
	#maintenanceReport: ((text: string | null) => void) | null = null;
	#unsubscribe: (() => void) | null = null;
	#startPromise: Promise<void> | null = null;
	#paint: Promise<void> = Promise.resolve();
	#readySeen = false;
	#readyWaiters: Array<(ok: boolean) => void> = [];
	#supportsV2 = false;
	#rpcProtocol: 1 | 2 | null = null;
	#updates = new Map<string, string>();
	#flushScheduled = false;
	#reconcileRunning = false;
	#reconcileAgain = false;
	#reconcileAttempts = 0;
	/** A full read checking pending rows against the file's other branches is in flight. */
	#offPathCheck = false;
	#reconcileTimer: unknown = null;
	#pausedStateTimer: unknown = null;
	#pausedStatePending = false;
	#pausedStateAgain = false;
	#needFull = false;
	#resyncScheduled = false;
	#reattaching = false;
	#establishing = false;
	#dropDuringEstablish = false;
	#disposed = false;
	#ended = false;
	#stderr = "";
	#protocolErrors = 0;
	#resyncs = 0;
	#historyFallbacks = 0;
	#unrenderableDialogs = 0;
	#frameFailures = 0;
	#watchdogProbes = 0;
	#recoveries = 0;
	#lastActivityAt = 0;
	#watchdogTimer: unknown = null;
	#watchdogRunning = false;
	#lastFrameResyncAt = Number.NEGATIVE_INFINITY;
	#autoRecoveryAttempt = 0;
	#autoRecoveryTimer: unknown = null;
	#mutationFence: string | null = null;
	readonly #navigateRequests = new Map<string, Promise<NavigateOutcome>>();
	/** The navigation command in flight: its internal id, its request id, the coded errors OMP reported, its waiter. */
	#navigation: { id: string; requestId: string; errors: string[]; finish(how: NavigationWait): void } | null = null;
	/**
	 * A navigation whose answer never came: its handler may still move the leaf, so every mutation stays refused
	 * until its late `prompt_result`, its marker on the active path, or the end of the process.
	 */
	#navigationFence: { id: string; requestId: string } | null = null;
	#reconcileIdleWaiters: (() => void)[] = [];
	/** Reads that replaced or extended the model with what the process holds; a navigation compares it across its re-sync. */
	#authoritativeReads = 0;
	/** The reader's file re-ids at load (version < 3): its ids are not the process's, so older rows cannot load by id. */
	#readerLegacyIds = false;

	constructor(options: RpcSessionOptions) {
		this.#options = options;
		this.#channel = options.channel;
		this.#timers = options.timers ?? SYSTEM_TIMERS;
		this.#tailRows = options.tailRows ?? DEFAULT_TAIL_ROWS;
		this.#lastSeq = options.initialSeq ?? 0;
		this.#boundFile = options.sessionFile;
		this.#fileMaterialized = options.sessionFile !== null;
		this.#model = { ...createChatModel(), epoch: { nonce: options.hostNonce, counter: 0 } };
	}

	get model(): ChatModel {
		return this.#model;
	}

	/** A fresh, identity-checked provider-facing inventory for host-only views. */
	async readToolDescriptors(): Promise<readonly RpcToolDescriptor[] | null> {
		if (this.#disposed || this.#ended || !this.#live || !this.#identityVerified) return null;
		const epoch = this.#epochCounter;
		const state = await this.#fetchState();
		if (state === null || this.#disposed || this.#ended || !this.#live ||
			epoch !== this.#epochCounter || this.#identityMismatch(state, false) !== null) return null;
		return state.dumpTools;
	}

	get phase(): ChatPhase {
		return this.#model.phase;
	}

	get epoch(): ChatEpoch {
		return { nonce: this.#options.hostNonce, counter: this.#epochCounter };
	}

	/** The exact file the process serves: the binding, or the path learned for a new conversation. */
	get sessionFile(): string | null {
		return this.#boundFile;
	}

	get sessionId(): string | null {
		return this.#boundId;
	}

	/** Same-native evidence; reattaching or transcript events cannot establish command responsiveness. */
	get nativeStateUnanswered(): boolean {
		return this.#nativeStateUnanswered && !this.#disposed && !this.#ended;
	}

	/** The last broker line seq folded; a restarted host may resume from it. */
	get lastSeq(): number {
		return this.#lastSeq;
	}

	diagnostics(): RpcSessionDiagnostics {
		return {
			frames: this.#frames.counters,
			protocolErrors: this.#protocolErrors,
			resyncs: this.#resyncs,
			historyFallbacks: this.#historyFallbacks,
			unrenderableDialogs: this.#unrenderableDialogs,
			frameFailures: this.#frameFailures,
			watchdogProbes: this.#watchdogProbes,
			recoveries: this.#recoveries,
			stderrTail: this.#stderr,
			lastSeq: this.#lastSeq,
		};
	}

	subscribe(listener: (output: RpcSessionOutput) => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	/** The authoritative snapshot of the current state, for a page that attaches now. */
	snapshot(): ChatSnapshotPayload {
		return snapshotOf(this.#model, this.epoch);
	}

	setMutationFence(reason: string | null): void {
		this.#mutationFence = reason;
	}

	async readSettlement(): Promise<RpcSettlementState | null> {
		if (this.#disposed || this.#ended || !this.#live) return null;
		const state = await this.#fetchState();
		if (state === null || this.#disposed || this.#ended || !this.#live || this.#identityMismatch(state, false) !== null) return null;
		return {
			sessionFile: state.sessionFile,
			sessionId: state.sessionId,
			settled: state.isSettled && !state.lite.isCompacting,
			hasContent: state.messageCount === null ? null : state.messageCount > 0,
		};
	}

	/** Only the owning lifecycle calls this after consent while ordinary input is fenced. */
	async abortForShutdown(): Promise<SendOutcome> {
		const outcome = await this.#sendInternal({ type: "abort" });
		return outcome.status === "accepted" ? { status: "accepted", agentInvoked: null } : outcome;
	}

	/**
	 * Run the attach sequence. Resolves when the session reached `live`, `stopped` or `failed` for the first time;
	 * never rejects (a failure is a `failed` phase with a bounded code).
	 */
	start(): Promise<void> {
		this.#startPromise ??= this.#run();
		return this.#startPromise;
	}

	/** Stop reading and drop the connection. The child is untouched. Idempotent. */
	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#unsubscribe?.();
		this.#unsubscribe = null;
		this.#clearReconcileTimer();
		this.#clearPausedStateTimer();
		this.#disarmWatchdog();
		this.#clearAutoRecovery();
		this.#failAllCommands("closed");
		this.#maintenanceReport?.(null);
		this.#maintenanceReport = null;
		for (const waiter of this.#readyWaiters.splice(0)) waiter(false);
		this.#channel.disconnect();
		this.#listeners.clear();
	}

	/** Send a prompt. Exactly-once per `requestId`: a repeat returns the first outcome. */
	prompt(request: PromptRequest): Promise<SendOutcome> {
		return this.#once(request.requestId, async () => {
			const verdict = classifySlashInput(request.text, this.#model.commands);
			if (verdict.denied) return { status: "refused", reason: "slash-denied", command: verdict.command };
			const refusal = this.#controlRefusal();
			if (refusal !== null) return { status: "refused", reason: refusal };
			this.#slashArmed = request.text.trimStart().startsWith("/");
			this.#remember({ requestId: request.requestId, text: request.text, sentAt: this.#timers.now(), unconfirmed: false });
			return this.#sendUser(request.requestId, {
				type: "prompt",
				message: request.text,
				...(request.images !== undefined && request.images.length > 0 ? { images: request.images } : {}),
				streamingBehavior: request.streamingBehavior ?? "steer",
			});
		});
	}

	steer(request: MessageRequest): Promise<SendOutcome> {
		return this.#once(request.requestId, () => {
			const refusal = this.#controlRefusal();
			if (refusal !== null) return Promise.resolve<SendOutcome>({ status: "refused", reason: refusal });
			return this.#sendUser(request.requestId, {
				type: "steer",
				message: request.text,
				...(request.images !== undefined && request.images.length > 0 ? { images: request.images } : {}),
			});
		});
	}

	followUp(request: MessageRequest): Promise<SendOutcome> {
		return this.#once(request.requestId, () => {
			const refusal = this.#controlRefusal();
			if (refusal !== null) return Promise.resolve<SendOutcome>({ status: "refused", reason: refusal });
			return this.#sendUser(request.requestId, {
				type: "follow_up",
				message: request.text,
				...(request.images !== undefined && request.images.length > 0 ? { images: request.images } : {}),
			});
		});
	}

	/**
	 * Take pending user messages out of OMP's queues, one `remove_queued_message` per item, in the order given.
	 * OMP matches the exact queue-chip text and removes the first match, so a message it delivered before the
	 * command ran answers `gone` — never dropped and never removed twice. A command whose answer was lost is
	 * `unknown` and is never resent; the queue readback that follows shows what is left. Exactly-once per `requestId`.
	 */
	removeQueued(requestId: string, items: readonly QueuedRef[]): Promise<RemoveQueuedOutcome> {
		if (!REQUEST_ID_PATTERN.test(requestId)) return Promise.resolve({ status: "refused", reason: "bad-request-id" });
		const known = this.#queueRequests.get(requestId);
		if (known !== undefined) return known;
		const promise = this.#removeQueued(items);
		this.#queueRequests.set(requestId, promise);
		if (this.#queueRequests.size > MAX_REMEMBERED_REQUESTS) {
			const oldest = this.#queueRequests.keys().next();
			if (oldest.done !== true) this.#queueRequests.delete(oldest.value);
		}
		return promise;
	}

	async #removeQueued(items: readonly QueuedRef[]): Promise<RemoveQueuedOutcome> {
		const refusal = this.#controlRefusal();
		if (refusal !== null) return { status: "refused", reason: refusal };
		const removals: QueueRemoval[] = [];
		// After an unconfirmed command the link or the child is suspect and its serial queue may still hold that
		// command: later items are not sent (still queued as far as this host knows), which also bounds how long
		// one request can take to one command timeout.
		let halted = false;
		for (const item of items) {
			if (halted || this.#controlRefusal() !== null) {
				removals.push({ queue: item.queue, text: item.text, status: "failed" });
				continue;
			}
			const outcome = await this.#sendInternal({ type: "remove_queued_message", message: item.text, queue: item.queue });
			const removal: QueueRemoval =
				outcome.status === "unconfirmed"
					? { queue: item.queue, text: item.text, status: "unknown" }
					: outcome.status === "refused"
						? { queue: item.queue, text: item.text, status: "failed" }
						: parseRemoval(item, outcome.response.data);
			if (removal.status === "unknown") halted = true;
			removals.push(removal);
		}
		return { status: "done", removals };
	}

	/**
	 * Stop the running turn the way the TUI's Escape does: `abort_and_restore_queue` withdraws the user's queued
	 * messages before aborting, so neither the aborted turn nor OMP's stranded-queue drain can run them, and hands
	 * them back for the draft. Queues behind any command the child is already running (serial FIFO), so the answer is
	 * awaited past the longest serial command. An OMP without the command (before 18.8.5) gets a plain `abort`: the
	 * turn still stops, and its queue stays in OMP, where the dock keeps showing it. Exactly-once per `requestId`.
	 */
	abortAndRestore(requestId: string): Promise<AbortRestoreOutcome> {
		if (!REQUEST_ID_PATTERN.test(requestId)) return Promise.resolve({ status: "refused", reason: "bad-request-id" });
		const known = this.#abortRequests.get(requestId);
		if (known !== undefined) return known;
		const promise = (async (): Promise<AbortRestoreOutcome> => {
			const refusal = this.#controlRefusal();
			if (refusal !== null) return { status: "refused", reason: refusal };
			this.#applyLocal({ type: "abort_requested" });
			try {
				const response = await this.#send(`${VSC_ID_PREFIX}${requestId}`, { type: "abort_and_restore_queue" }, ABORT_RESTORE_TIMEOUT_MS);
				if (response.success) return { status: "accepted", restored: parseRestoredQueue(response.data) };
				if (response.error !== "Unknown command: abort_and_restore_queue") return { status: "refused", reason: "rejected" };
				const fallback = await this.#sendInternal({ type: "abort" });
				return fallback.status === "accepted" ? { status: "accepted", restored: { entries: [], imagesDropped: false, truncated: false } } : fallback;
			} catch (error) {
				return this.#failureOutcome(error, requestId);
			}
		})();
		this.#abortRequests.set(requestId, promise);
		if (this.#abortRequests.size > MAX_REMEMBERED_REQUESTS) {
			const oldest = this.#abortRequests.keys().next();
			if (oldest.done !== true) this.#abortRequests.delete(oldest.value);
		}
		return promise;
	}

	/**
	 * Move queued follow-ups to the end of the steering queue (`promote_queued_message`), one per item, in order.
	 * OMP matches like a removal, so a follow-up it already delivered answers `gone`. Exactly-once per `requestId`.
	 */
	promoteQueued(requestId: string, items: readonly QueuedRef[]): Promise<RemoveQueuedOutcome> {
		if (!REQUEST_ID_PATTERN.test(requestId)) return Promise.resolve({ status: "refused", reason: "bad-request-id" });
		const known = this.#queueRequests.get(requestId);
		if (known !== undefined) return known;
		const promise = (async (): Promise<RemoveQueuedOutcome> => {
			const refusal = this.#controlRefusal();
			if (refusal !== null) return { status: "refused", reason: refusal };
			const removals: QueueRemoval[] = [];
			let halted = false;
			for (const item of items) {
				if (halted || item.queue !== "followUp" || this.#controlRefusal() !== null) {
					removals.push({ queue: item.queue, text: item.text, status: "failed" });
					continue;
				}
				const outcome = await this.#sendInternal({ type: "promote_queued_message", message: item.text });
				if (outcome.status === "unconfirmed") halted = true;
				removals.push(outcome.status === "unconfirmed" ? { queue: item.queue, text: item.text, status: "unknown" }
					: outcome.status === "refused" ? { queue: item.queue, text: item.text, status: "failed" }
						: isRecord(outcome.response.data) && outcome.response.data.promoted === true
							? { queue: item.queue, text: item.text, status: "removed", images: [], imagesDropped: false }
							: { queue: item.queue, text: item.text, status: "gone" });
			}
			return { status: "done", removals };
		})();
		this.#queueRequests.set(requestId, promise);
		if (this.#queueRequests.size > MAX_REMEMBERED_REQUESTS) {
			const oldest = this.#queueRequests.keys().next();
			if (oldest.done !== true) this.#queueRequests.delete(oldest.value);
		}
		return promise;
	}

	/**
	 * Move the active branch in place (ADR-0051): `/omp-desk-navigate` through `prompt`, then one re-sync through the
	 * ordinary reconcile serializer. Success is proven only by the marker carrying this `requestId` on the active path
	 * (the leaf or an ancestor of it); acknowledgements, results and errors only decide what to say otherwise. Never
	 * written to the prompt ledger, never a pending user row. Exactly-once per `requestId`.
	 */
	navigate(request: NavigateRequest): Promise<NavigateOutcome> {
		if (!NAVIGATE_REQUEST_ID.test(request.requestId)) return Promise.resolve({ status: "refused", reason: "bad-request-id" });
		const known = this.#navigateRequests.get(request.requestId);
		if (known !== undefined) return known;
		const promise = this.#navigate(request);
		this.#navigateRequests.set(request.requestId, promise);
		if (this.#navigateRequests.size > MAX_REMEMBERED_REQUESTS) {
			const oldest = this.#navigateRequests.keys().next();
			if (oldest.done !== true) this.#navigateRequests.delete(oldest.value);
		}
		return promise;
	}

	/** Why a navigation cannot start now, or null. Every check is on host-known state; OMP re-checks its own. */
	#navigationRefusal(request: NavigateRequest): NavigateRefusal | null {
		const control = this.#controlRefusal();
		if (control !== null) return control === "busy" ? "busy" : "not-live";
		const model = this.#model;
		if (model.state?.isCompacting === true || model.maintenance?.status === "working") return "compacting";
		// Anything that could still append to the branch or wake a turn: a turn, a dialog, queued input, async work.
		if (model.working || model.state?.isStreaming === true || model.uiRequest !== null || (model.state?.queuedMessageCount ?? 0) > 0 || !model.settled || model.asyncPaused) return "busy";
		// A prompt whose fate is unknown, or a row not reconciled yet that a rewrite would re-anchor onto the new branch.
		if (this.#ledger.some(entry => entry.unconfirmed) || [...model.pending.values()].some(row => !row.unsaved && row.hidden !== true)) return "busy";
		// Only the command this module registered: a same-named prompt template or skill would reach the model.
		if (!model.commands.some(command => command.name === NAVIGATE_COMMAND && command.source === "extension")) return "unsupported";
		const durable = model.entries.slice(0, model.durableCount);
		if (model.leafId !== request.expectedLeafId && !leafReaches(durable, request.expectedLeafId)) return "stale";
		switch (request.kind) {
			case "rewind": {
				const target = durable.find(entry => entry.id === request.targetId);
				if (target === undefined || !isRewindTarget(target)) return "target";
				return null;
			}
			case "undo":
				return undoOffer(durable, model.leafId)?.from === request.targetId ? null : "stale";
			case "switch":
				return model.branches.some(point => point.branches.some(branch => branch.tipId === request.targetId)) ? null : "target";
		}
	}

	async #navigate(request: NavigateRequest): Promise<NavigateOutcome> {
		let refusal = this.#navigationRefusal(request);
		if (refusal !== null) return { status: "refused", reason: refusal };
		// The model the request was checked against must be the one the command runs on.
		while (this.#reconcileRunning) await new Promise<void>(resolve => this.#reconcileIdleWaiters.push(resolve));
		refusal = this.#navigationRefusal(request);
		if (refusal !== null) return { status: "refused", reason: refusal };
		const sessionId = this.#boundId;
		if (sessionId === null) return { status: "refused", reason: "not-live" };
		// The draft comes from the entry the host holds: OMP's extension wrapper drops `editorText`/`editorImages`.
		const target = request.kind === "rewind" ? this.#model.entries.find(entry => entry.id === request.targetId) : undefined;
		const id = `${INTERNAL_ID_PREFIX}${++this.#internalSeq}`;
		const wait = Promise.withResolvers<NavigationWait>();
		const navigation = { id, requestId: request.requestId, errors: [] as string[], finish: (how: NavigationWait) => wait.resolve(how) };
		this.#navigation = navigation;
		const timer = this.#timers.setTimeout(() => wait.resolve("timeout"), request.summarize ? NAVIGATE_SUMMARY_RESULT_MS : NAVIGATE_RESULT_MS);
		// Set from the send's callback when nothing was written; `as` keeps it from narrowing to `null`.
		let notSent = null as NavigateRefusal | null;
		const message = encodeNavigateCommand({ v: 1, requestId: request.requestId, kind: request.kind, sessionId, expectedLeafId: request.expectedLeafId, targetId: request.targetId, summarize: request.summarize });
		// No `streamingBehavior`: if the text ever reached the model during a race, OMP refuses it as busy instead of
		// queueing it as a steer. The acknowledgement comes when OMP routed the command, before its handler ran.
		this.#send(id, { type: "prompt", message }).then(
			ack => {
				if (!ack.success) navigation.finish("rejected");
				else if (isRecord(ack.data) && ack.data.agentInvoked === false) navigation.finish("local");
				else if (isRecord(ack.data) && ack.data.agentInvoked === true) navigation.finish("fell-through");
			},
			(error: unknown) => {
				const failure = this.#failureOutcome(error, null);
				if (failure.status === "refused") notSent = failure.reason === "not-owner" ? "not-owner" : failure.reason === "not-live" ? "not-live" : "failed";
				navigation.finish(failure.status === "refused" ? "rejected" : "lost");
			},
		);
		const how = await wait.promise;
		this.#timers.clearTimeout(timer);
		this.#navigation = null;
		if (notSent !== null) return { status: "refused", reason: notSent };
		// The command reached the model as text: stop that turn before it does anything.
		if (how === "fell-through") void this.#sendInternal({ type: "abort" });
		if (how === "timeout" || how === "lost") this.#navigationFence = { id, requestId: request.requestId };
		const reads = this.#authoritativeReads;
		await this.#reconcileSettled();
		const read = this.#authoritativeReads !== reads;
		const durable = this.#model.entries.slice(0, this.#model.durableCount);
		const marker = durable.map(entry => navigationMarker(entry)).find(found => found?.requestId === request.requestId) ?? null;
		if (marker !== null) {
			if (this.#navigationFence?.requestId === request.requestId) this.#navigationFence = null;
			let draft: RewindDraft | null = null;
			if (target !== undefined) {
				const copy = structuredClone(target);
				const file = this.#boundFile ?? this.#options.sessionFile;
				await resolveBlobImages(copy, file === null ? null : blobsDirectoryFor(file), { bytes: 0 });
				draft = rewindDraft(copy);
			}
			return { status: "done", kind: marker.kind, summarized: marker.summarized, raced: marker.raced === true, draft };
		}
		if (how === "fell-through") return { status: "refused", reason: "failed" };
		// A coded refusal is thrown before anything moved, so it stands without the re-read.
		if (navigation.errors.length > 0) return { status: "refused", reason: this.#navigateRefusalOf(navigation.errors) };
		return read && (how === "result" || how === "local" || how === "rejected") ? { status: "refused", reason: "failed" } : { status: "unconfirmed" };
	}

	#navigateRefusalOf(errors: readonly string[]): NavigateRefusal {
		const code = navigateErrorCode(errors[0]);
		return code === "bad-request" || code === "mode" ? "failed" : code;
	}

	/** Run (or join) the one reconcile serializer and wait until it is idle. */
	async #reconcileSettled(): Promise<void> {
		this.#requestReconcile();
		while (this.#reconcileRunning) await new Promise<void>(resolve => this.#reconcileIdleWaiters.push(resolve));
	}

	/**
	 * Manual compaction or shake, sent as the slash command the TUI runs: OMP's RPC `compact` takes no mode and there
	 * is no RPC `shake`. The `prompt` carries no `streamingBehavior`: OMP runs a builtin before any turn logic, so it
	 * also works during a turn (a compaction aborts the turn, compacts, then resumes it), and text that ever reached
	 * the model would be refused as busy instead of queued. Refused while a pass is already running. OMP emits no
	 * maintenance event for a manual pass and reports its outcome only as one `command_output` line (`/shake` before
	 * its acknowledgement, `/compact` after it, from the background), so the session shows its own progress until
	 * that line arrives; the line still renders as the notice it always is.
	 */
	async maintain(request: MaintenanceRequest): Promise<CommandResult<string>> {
		const refusal = this.#controlRefusal() ?? (this.#model.maintenance?.status === "working" ? "busy" : null);
		if (refusal !== null) return { status: "refused", reason: refusal };
		const action = request.kind === "shake" ? "shake" : request.mode === "soft" ? "compact" : request.mode;
		const focus = request.kind === "compact" && request.instructions !== undefined && request.instructions.trim() !== "" ? ` ${request.instructions.trim()}` : "";
		const report = Promise.withResolvers<string | null>();
		this.#maintenanceReport = report.resolve;
		this.#applyLocal({ type: "auto_compaction_start", action, reason: "manual" });
		let result: CommandResult<string>;
		// `/shake` answers only after it rewrote the branch, so its acknowledgement gets the report's patience too.
		const ack = await this.#sendInternal({ type: "prompt", message: `/${request.kind} ${request.mode}${focus}` }, MAINTENANCE_REPORT_TIMEOUT_MS);
		if (ack.status !== "accepted") result = ack;
		// The text became a turn instead of a command: an input hook rewrote it, or this OMP does not have the builtin.
		else if (!isRecord(ack.response.data) || ack.response.data.agentInvoked !== false) result = { status: "refused", reason: "rejected" };
		else {
			const timer = this.#timers.setTimeout(() => report.resolve(null), MAINTENANCE_REPORT_TIMEOUT_MS);
			const text = await report.promise;
			this.#timers.clearTimeout(timer);
			result = text === null ? { status: "unconfirmed" } : { status: "ok", value: text };
		}
		if (this.#maintenanceReport === report.resolve) this.#maintenanceReport = null;
		// OMP's own failure report is already in the transcript as command output; the pass ends as skipped so the
		// progress line does not repeat it. Only a missing report or command leaves a failure line of its own.
		const reportedFailure = result.status === "ok" && /^\w+ failed\b/i.test(result.value);
		const errorMessage = result.status === "ok" ? undefined
			: result.status === "unconfirmed" ? "OMP did not report the outcome." : "OMP did not run the command.";
		if (this.#live) this.#applyLocal({ type: "auto_compaction_end", action, aborted: false, willRetry: false, ...(reportedFailure ? { skipped: true } : {}), ...(errorMessage === undefined ? {} : { errorMessage }) });
		this.#requestReconcile();
		return result;
	}

	/** `cycle_model`: the next role or scoped model. `null` when OMP had nothing to cycle to. */
	async cycleModel(): Promise<CommandResult<{ model: ChatLiteModel; thinkingLevel: string | null } | null>> {
		const refusal = this.#controlRefusal();
		if (refusal !== null) return { status: "refused", reason: refusal };
		const outcome = await this.#sendInternal({ type: "cycle_model" });
		if (outcome.status !== "accepted") return outcome;
		const data = outcome.response.data;
		if (data === null || data === undefined) return { status: "ok", value: null };
		const model = isRecord(data) ? parseLiteModel(data.model) : null;
		if (model === null) return { status: "unconfirmed" };
		const thinkingLevel = isRecord(data) && typeof data.thinkingLevel === "string" ? data.thinkingLevel : null;
		this.#applyLocal({ type: "config_update", model, ...(thinkingLevel === null ? {} : { thinkingLevel }) });
		return { status: "ok", value: { model, thinkingLevel } };
	}

	/** `cycle_thinking_level`: the next selector of the live model. `null` when the model has none. */
	async cycleThinkingLevel(): Promise<CommandResult<string | null>> {
		const refusal = this.#controlRefusal();
		if (refusal !== null) return { status: "refused", reason: refusal };
		const outcome = await this.#sendInternal({ type: "cycle_thinking_level" });
		if (outcome.status !== "accepted") return outcome;
		const data = outcome.response.data;
		const level = isRecord(data) && typeof data.level === "string" ? data.level : null;
		if (level !== null) this.#applyLocal({ type: "thinking_level_changed", thinkingLevel: level });
		return { status: "ok", value: level };
	}

	/** `export_html` to `outputPath`; the value is the path OMP wrote. */
	async exportHtml(outputPath: string): Promise<CommandResult<string>> {
		const refusal = this.#controlRefusal();
		if (refusal !== null) return { status: "refused", reason: refusal };
		const outcome = await this.#sendInternal({ type: "export_html", outputPath }, EXPORT_TIMEOUT_MS);
		if (outcome.status !== "accepted") return outcome;
		const data = outcome.response.data;
		return isRecord(data) && typeof data.path === "string" && data.path.length > 0 ? { status: "ok", value: data.path } : { status: "unconfirmed" };
	}

	/** Answer the dialog `response.id`. Returns false when no such dialog is pending or the write failed. */
	async respondUi(response: ChatUiResponse): Promise<boolean> {
		const request = this.#model.uiRequest?.id === response.id ? this.#model.uiRequest : this.#model.uiQueue.find(queued => queued.id === response.id);
		if (this.#mutationFence !== null || request === undefined || this.#model.phase !== "live") return false;
		// An `ask` answer the child would refuse (the child throws on a mismatch) never reaches it.
		if ("answers" in response && !(request.method === "ask" && askAnswersMatch(request, response.answers))) return false;
		const answer =
			"value" in response
				? { value: response.value }
				: "confirmed" in response
					? { confirmed: response.confirmed }
					: "answers" in response
						? { answers: response.answers }
						: ({ cancelled: true } as const);
		try {
			await this.#channel.writeLine(encodeUiResponse(response.id, answer));
		} catch (error) {
			this.#onWriteFailure(writeErrorCode(error));
			return false;
		}
		this.#dropDialog(response.id);
		return true;
	}

	/** Guarded get_state readback for native settings application; never changes session identity. */
	async readSettingsState(): Promise<ChatLiteState | null> {
		if (this.#controlRefusal() !== null || this.#model.working || this.#model.asyncPaused) return null;
		const epoch = this.#epochCounter;
		const state = await this.#fetchState();
		if (state === null || this.#epochCounter !== epoch || this.#controlRefusal() !== null || this.#identityMismatch(state, false) !== null) return null;
		return state.lite;
	}

	/** `set_model`. Requires a bound identity (verified by `get_state`) and phase `live`. */
	async setModel(provider: string, modelId: string): Promise<SendOutcome> {
		const refusal = this.#controlRefusal();
		if (refusal !== null) return { status: "refused", reason: refusal };
		const outcome = await this.#sendInternal({ type: "set_model", provider, modelId });
		if (outcome.status === "accepted") {
			const response = outcome.response;
			const model = parseLiteModel(response.data);
			if (model === null) return { status: "unconfirmed" };
			this.#applyLocal({ type: "config_update", model });
		}
		return outcome.status === "accepted" ? { status: "accepted", agentInvoked: null } : outcome;
	}

	async setThinkingLevel(level: string): Promise<SendOutcome> {
		const refusal = this.#controlRefusal();
		if (refusal !== null) return { status: "refused", reason: refusal };
		const outcome = await this.#sendInternal({ type: "set_thinking_level", level });
		return outcome.status === "accepted" ? { status: "accepted", agentInvoked: null } : outcome;
	}

	async setSessionName(name: string): Promise<SendOutcome> {
		const refusal = this.#controlRefusal();
		if (refusal !== null) return { status: "refused", reason: refusal };
		const outcome = await this.#sendInternal({ type: "set_session_name", name });
		if (outcome.status === "accepted") this.#applyLocal({ type: "session_info_update", title: name });
		return outcome.status === "accepted" ? { status: "accepted", agentInvoked: null } : outcome;
	}

	/** Native session totals, never a sum of the extension's truncated history window. */
	async readSessionCost(): Promise<number | null> {
		if (this.#disposed || this.#ended || !this.#live || !this.#identityVerified) return null;
		const epoch = this.#epochCounter;
		const file = this.#boundFile;
		const id = this.#boundId;
		const outcome = await this.#sendInternal({ type: "get_session_stats" });
		if (outcome.status !== "accepted" || this.#disposed || this.#ended || !this.#live ||
			epoch !== this.#epochCounter || file !== this.#boundFile || id !== this.#boundId) return null;
		const data = outcome.response.data;
		if (!isRecord(data) || id === null || data.sessionId !== id ||
			(file !== null && (typeof data.sessionFile !== "string" || !samePath(data.sessionFile, file)))) return null;
		// OMP initializes cost to zero even for absent/unpriced usage; it has no availability flag.
		return typeof data.cost === "number" && Number.isFinite(data.cost) && data.cost > 0 ? data.cost : null;
	}

	/** Model catalogue; fetched lazily (never while a turn streams: it queues ahead of `abort`). */
	async getAvailableModels(): Promise<ModelsResult> {
		const refusal = this.#controlRefusal() ?? (this.#model.working ? "busy" : null);
		if (refusal !== null) return { status: "refused", reason: refusal };
		const outcome = await this.#sendInternal({ type: "get_available_models" });
		if (outcome.status !== "accepted") return { status: "failed" };
		const data = outcome.response.data;
		const raw = isRecord(data) && Array.isArray(data.models) ? data.models : [];
		const models: ChatLiteModel[] = [];
		for (const item of raw.slice(0, 2_000)) {
			const parsed = parseLiteModel(item);
			if (parsed !== null) models.push(parsed);
		}
		return { status: "ok", models };
	}

	async getAvailableThinkingLevels(): Promise<ThinkingLevelsResult> {
		const refusal = this.#controlRefusal() ?? (this.#model.working ? "busy" : null);
		if (refusal !== null) return { status: "refused", reason: refusal };
		const outcome = await this.#sendInternal({ type: "get_available_thinking_levels" });
		if (outcome.status !== "accepted") return { status: "failed" };
		const data = outcome.response.data;
		const raw = isRecord(data) && Array.isArray(data.levels) ? data.levels : [];
		return { status: "ok", levels: raw.filter((level): level is string => typeof level === "string").slice(0, 32) };
	}

	/** Serve `omp:chat-load-older` from the indexed file. */
	async loadOlder(beforeId: string): Promise<ChatOlderPayload | null> {
		const reader = this.#reader;
		if (reader === null) return null;
		let older: HistoryOlder;
		try {
			older = await reader.loadOlder(beforeId, this.#tailRows);
		} catch {
			return null;
		}
		if (!older.found) return null;
		this.#model = applyChatOlder(this.#model, older.entries, older.olderCount, { now: this.#timers.now() });
		return { epoch: this.epoch, entries: older.entries, olderCount: older.olderCount };
	}

	/** Native lookup only: a page id must already exist in our roster, lifecycle history or held task results. */
	async subagentMessages(subagentId: string, fromByte: number, beforeId?: string): Promise<SubagentTranscriptPage> {
		if (!this.#live || this.#disposed || this.#ended) return { status: "unavailable", reason: "not-live" };
		for (const agent of this.#model.agents.values()) this.#rememberTaskReferences(agent.progress);
		for (const tool of this.#model.activeTools.values()) if (tool.toolName === "task" && isRecord(tool.partialResult)) this.#rememberTaskReferences(tool.partialResult.details);
		for (const entry of this.#model.entries) {
			if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "task") this.#rememberTaskReferences(entry.message.details);
		}
		const known = this.#model.agents.has(subagentId) || this.#subagentReferences.has(subagentId);
		if (!known) return { status: "unavailable", reason: "unknown" };
		const outcome = await this.#sendInternal({ type: "get_subagent_messages", subagentId, fromByte: beforeId === undefined ? fromByte : 0 });
		if (!this.#live || this.#disposed || this.#ended) return { status: "unavailable", reason: "not-live" };
		const page = outcome.status === "accepted" ? childPageFromNative(outcome.response.data, beforeId) : { status: "unavailable" as const, reason: "read-failed" as const };
		if (page.status === "available") for (const entry of page.entries) {
			if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "task") this.#rememberTaskReferences(entry.message.details);
		}
		return page;
	}

	/** Only native task/progress containers can grant a nested identity; no page paths or arbitrary data walk. */
	#rememberTaskReferences(value: unknown): void {
		const queue: unknown[] = [value];
		const seen = new Set<object>();
		while (queue.length > 0) {
			const data = queue.pop();
			if (!isRecord(data) || seen.has(data)) continue;
			seen.add(data);
			for (const key of ["results", "progress"]) if (Array.isArray(data[key])) for (const row of data[key]) {
				if (!isRecord(row)) continue;
				if (typeof row.id === "string" && row.id.length > 0 && row.id.length <= 256) {
					this.#subagentReferences.delete(row.id);
					this.#subagentReferences.add(row.id);
				}
				queue.push(row);
			}
			queue.push(data.inflightTaskDetails);
			if (isRecord(data.extractedToolData) && Array.isArray(data.extractedToolData.task)) queue.push(...data.extractedToolData.task);
		}
		while (this.#subagentReferences.size > 256) {
			const oldest = this.#subagentReferences.values().next();
			if (!oldest.done) this.#subagentReferences.delete(oldest.value);
		}
	}

	async #run(): Promise<void> {
		this.#unsubscribe = this.#channel.onEvent(event => this.#onChannelEvent(event));
		this.#paint = this.#diskPaint();
		this.#establishing = true;
		try {
			await this.#establish("start");
		} catch (error) {
			await this.#paint;
			this.#fail(error instanceof SessionFailure ? error.code : "attach-failed");
		} finally {
			this.#establishing = false;
		}
		if (this.#dropDuringEstablish && !this.#ended && !this.#disposed) {
			this.#dropDuringEstablish = false;
			await this.#reattach();
		}
	}

	/** Read the JSONL and publish the tail window; a failure only means the history comes from rpc later. */
	async #diskPaint(): Promise<void> {
		const file = this.#options.sessionFile;
		if (file === null) return;
		try {
			const open = this.#options.openHistory ?? ((path: string) => HistoryReader.open(path));
			const reader = await open(file);
			const history = await reader.snapshot(this.#tailRows);
			if (this.#disposed) return;
			this.#reader = reader;
			this.#readerLegacyIds = history.legacyIds;
			this.#boundId = history.header.id;
			this.#cursor = history.legacyIds ? null : history.lastId;
			if (!this.#model.todoAuthoritative) this.#model = { ...this.#model, todoSeed: history.todoSeed };
			this.#model = { ...applyChatRewrite(this.#model, history.entries, history.olderCount, history.leafId, { now: this.#timers.now() }), branches: history.branches };
			this.#model = {
				...this.#model,
				header: { ...history.header, ...(history.title === null ? {} : { title: history.title }) },
			};
			this.#emitSnapshot();
		} catch {
			this.#reader = null;
			this.#cursor = null;
			this.#historyFallbacks += 1;
		}
	}

	async #establish(kind: "start" | "reattach"): Promise<void> {
		this.#flushUpdates();
		this.#frames.reset();
		this.#disarmWatchdog();
		this.#setPhase(kind === "start" ? "starting" : "attaching", null);
		let result: RpcAttachResult;
		try {
			result = await this.#channel.attach({ sinceSeq: this.#lastSeq });
		} catch {
			throw new SessionFailure("attach-failed");
		}
		if (this.#disposed) return;
		if (result.truncated) this.#agentLiveness.forgetLast();
		if (result.child.state === "exited") {
			await this.#paint;
			this.#stopped("child-exited", { exitCode: result.child.exitCode, stderr: result.child.stderrTail ?? this.#stderr });
			return;
		}
		this.#rpcProtocol = result.rpcProtocol;
		if (result.ready !== null) this.#processLine(result.ready);
		if (!this.#readySeen) {
			this.#setPhase("attaching", null);
			const ok = await this.#awaitReady(this.#options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
			if (this.#disposed || this.#ended) return;
			if (!ok) throw new SessionFailure("ready-timeout");
		}
		await this.#resync(kind === "start");
	}

	/** Bind identity from `get_state`, take the delta since the cursor, and go live with one snapshot. */
	async #resync(bind: boolean): Promise<void> {
		this.#resyncs += 1;
		this.#setPhase("resyncing", null);
		const v2 = this.#rpcProtocol === 2 || (this.#rpcProtocol === null && this.#supportsV2);
		if (!v2) {
			await this.#paint;
			this.#fail("state-unavailable");
			return;
		}
		const statePromise = this.#fetchState();
		const agentsPromise = this.#fetchAgents();
		const askDialogPromise = this.#enableAskDialog();
		await this.#paint;
		const state = await statePromise;
		if (this.#disposed || this.#ended) return;
		if (state === null) throw new SessionFailure("state-failed");
		const mismatch = this.#identityMismatch(state, bind);
		if (mismatch !== null) {
			this.#fail(mismatch);
			return;
		}
		if (this.#boundFile === null && state.sessionFile !== null && state.sessionId !== null) {
			this.#boundFile = state.sessionFile;
			this.#boundId = state.sessionId;
			this.#emit({ type: "identity", sessionFile: state.sessionFile, sessionId: state.sessionId });
		} else if (this.#boundId === null && state.sessionId !== null) {
			this.#boundId = state.sessionId;
		}
		if (this.#model.header === null && this.#boundId !== null) {
			this.#model = {
				...this.#model,
				header: { id: this.#boundId, cwd: this.#options.cwd, timestamp: new Date(this.#timers.now()).toISOString() },
			};
		}
		this.#identityVerified = true;
		const catalogueRevision = this.#commandRevision;
		void this.#sendInternal({ type: "get_available_commands" }).then(outcome => {
			if (this.#disposed || this.#ended || catalogueRevision !== this.#commandRevision || outcome.status !== "accepted") return;
			const data = outcome.response.data;
			if (isRecord(data) && Array.isArray(data.commands)) this.#applyFrame({ type: "available_commands_update", commands: parseCommands(data.commands) });
		});
		await agentsPromise;
		// The resync reset cleared the registry rows; the newest accepted publication restores them until the next one.
		const liveAgents = this.#agentLiveness.last;
		if (liveAgents !== null && !this.#disposed && !this.#ended) this.#applyLocal({ type: "agents_liveness", agents: liveAgents });
		await askDialogPromise;
		await this.#reconcileEntries();
		if (this.#disposed || this.#ended) return;
		this.#model = setChatPhase(this.#model, "live", null, null);
		this.#autoRecoveryAttempt = 0;
		this.#publish(true);
		this.#afterReconcile();
		this.#syncPausedStateReadback();
		this.#lastActivityAt = this.#timers.now();
		this.#armWatchdog();
	}

	#identityMismatch(state: ParsedState, bind: boolean): RpcErrorCode | null {
		const code: RpcErrorCode = bind ? "identity-mismatch" : "identity-diverged";
		if (this.#boundFile !== null) {
			if (state.sessionFile === null || !samePath(state.sessionFile, this.#boundFile)) return code;
		}
		if (this.#boundId !== null && state.sessionId !== this.#boundId) return code;
		return null;
	}

	async #fetchState(): Promise<ParsedState | null> {
		const answerRevision = this.#stateAnswerRevision;
		const outcome = await this.#sendInternal({ type: "get_state" });
		if (outcome.status !== "accepted") {
			if (outcome.status === "unconfirmed" && answerRevision === this.#stateAnswerRevision) this.#nativeStateUnanswered = true;
			return null;
		}
		return parseStateData(outcome.response.data);
	}

	/**
	 * Opt in to the rich `ask` dialog so one multi-question `ask` arrives as one request carrying every question
	 * (tabs, free switching, one submit). A child without the command keeps asking question by question through
	 * `select`, which this page still renders; the refusal is therefore not an error.
	 */
	async #enableAskDialog(): Promise<void> {
		await this.#sendInternal({ type: "set_ask_dialog", enabled: true });
	}

	/** Subscribe to bounded progress and read the subagent snapshot on every attach; on failure the agents list is marked unavailable. */
	async #fetchAgents(): Promise<void> {
		const subscription = await this.#sendInternal({ type: "set_subagent_subscription", level: "progress" });
		if (subscription.status === "accepted") {
			const outcome = await this.#sendInternal({ type: "get_subagents" });
			if (outcome.status === "accepted") return;
		}
		if (!this.#disposed && !this.#ended) this.#applyLocal({ type: "agents_snapshot", agents: [], availability: "unavailable" });
	}

	#onChannelEvent(event: RpcChannelEvent): void {
		if (this.#disposed) return;
		switch (event.type) {
			case "line":
				this.#lastActivityAt = this.#timers.now();
				this.#onLine(event.seq, event.line);
				return;
			case "ready":
				// Not a ring line: never deduplicated against the folded seq. A repeat is harmless.
				if (event.rpcProtocol !== null) this.#rpcProtocol = event.rpcProtocol;
				if (!this.#readySeen) this.#processLine(event.line);
				return;
			case "stderr": {
				const bytes = Buffer.from(this.#stderr + event.text);
				let start = Math.max(0, bytes.length - STDERR_TAIL_BYTES);
				while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
				this.#stderr = bytes.subarray(start).toString("utf8");
				return;
			}
			case "child":
				if (event.status.state === "exited") this.#stopped("child-exited", { exitCode: event.status.exitCode, stderr: event.status.stderrTail ?? this.#stderr });
				return;
			case "closed":
				if (event.reason === "disconnected") {
					if (this.#establishing) this.#dropDuringEstablish = true;
					else void this.#reattach();
				}
				else this.#stopped(event.reason === "child-exited" ? "child-exited" : null);
				return;
		}
	}

	#onLine(seq: number, line: string): void {
		if (seq <= this.#lastSeq) return;
		this.#lastSeq = seq;
		if (line.startsWith('{"type":"message_update"')) {
			const match = MESSAGE_ID_TAIL.exec(line.slice(-100));
			if (match !== null) {
				const id = match[1]!;
				this.#updates.delete(id);
				this.#updates.set(id, line);
				if (!this.#flushScheduled) {
					this.#flushScheduled = true;
					queueMicrotask(() => this.#flushUpdates());
				}
				return;
			}
		}
		this.#flushUpdates();
		this.#processLine(line);
	}

	/** Parse and apply the latest `message_update` per `messageId` collected in this burst. */
	#flushUpdates(): void {
		this.#flushScheduled = false;
		if (this.#updates.size === 0) return;
		const lines = [...this.#updates.values()];
		this.#updates.clear();
		for (const line of lines) this.#processLine(line);
	}

	#processLine(line: string): void {
		const read = this.#frames.pushLine(line);
		switch (read.kind) {
			case "frame":
				try {
					this.#onFrame(read.frame);
				} catch {
					// A frame the model cannot fold must not strand the rest of the stream half-applied:
					// the authoritative rebuild repairs whatever the failed fold missed.
					this.#frameFailed();
				}
				return;
			case "error":
				this.#protocolErrors += 1;
				this.#scheduleResync();
				return;
			default:
				return;
		}
	}

	#onFrame(frame: Record<string, unknown>): void {
		const navigation = this.#navigation;
		// The navigation command's own completion and coded refusals belong to `navigate`, not to the transcript.
		if (navigation !== null) {
			if (frame.type === "prompt_result" && frame.id === navigation.id) {
				navigation.finish(frame.agentInvoked === true ? "fell-through" : "result");
				return;
			}
			if (frame.type === "extension_error" && frame.extensionPath === NAVIGATE_ERROR_PATH) {
				if (navigation.errors.length < 8) navigation.errors.push(typeof frame.error === "string" ? frame.error.slice(0, 200) : "");
				return;
			}
			// The command text became a user message: an input hook rewrote it, or OMP no longer routes it.
			if (frame.type === "message_start" && isRecord(frame.message) && frame.message.role === "user" && JSON.stringify(frame.message.content ?? "").includes(navigation.requestId)) navigation.finish("fell-through");
		}
		// A maintenance pass takes the next command output as its report; the line still renders as a notice. Any
		// other output is a background builtin (`/compact`, `/handoff` typed in the composer) that reports only when it
		// is done, long after its acknowledgement: that line is the first moment the context usage can be read back.
		if (frame.type === "command_output") {
			const report = this.#maintenanceReport;
			if (report !== null) {
				this.#maintenanceReport = null;
				report(typeof frame.text === "string" ? frame.text : "");
			} else if (this.#live) void this.#refreshState();
		}
		// Only a navigation or a maintenance pass sends a prompt with an internal id: a result after its wait ended
		// (timeout, fall-through) is not a user turn. It lifts a navigation's fence; the re-read shows the outcome.
		if (frame.type === "prompt_result" && typeof frame.id === "string" && frame.id.startsWith(INTERNAL_ID_PREFIX)) {
			if (this.#navigationFence?.id === frame.id) this.#navigationFence = null;
			this.#requestReconcile();
			return;
		}
		switch (frame.type) {
			case "response":
				this.#onResponse(frame);
				return;
			case "ready":
				this.#onReady(frame);
				return;
			case "extension_ui_request":
				this.#onUiRequest(frame);
				return;
			default: {
				const event = toChatEventFrame(frame, this.#timers.now());
				if (event !== null) this.#applyFrame(event);
			}
		}
	}

	#onReady(frame: Record<string, unknown>): void {
		const versions = frame.supportedProtocolVersions;
		this.#supportsV2 = Array.isArray(versions) && versions.includes(2);
		this.#readySeen = true;
		for (const waiter of this.#readyWaiters.splice(0)) waiter(true);
	}

	#onResponse(frame: Record<string, unknown>): void {
		if (!isResponseFrame(frame)) return;
		const id = frame.id;
		if (typeof id !== "string") return;
		const pending = this.#pendingCommands.get(id);
		if (pending !== undefined) {
			this.#pendingCommands.delete(id);
			this.#timers.clearTimeout(pending.timer);
			// Apply authority at dispatch, before resolving the promise or processing a later stdout line.
			if (pending.command.type === "get_state" && frame.success) {
				const state = parseStateData(frame.data);
				if (state !== null) {
					this.#stateAnswerRevision += 1;
					this.#nativeStateUnanswered = false;
					const mismatch = this.#identityVerified ? this.#identityMismatch(state, false) : null;
					if (mismatch !== null) this.#fail(mismatch);
					else this.#applyFrame({ type: "state_update", state: this.#newestQueue(state.lite, pending.queueRevision), todoSeed: state.todoSeed });
				}
			}
			if (pending.command.type === "get_subagents") {
				const agents = frame.success && isRecord(frame.data) ? parseAgentRoster(frame.data.subagents) : null;
				this.#applyLocal({ type: "agents_snapshot", agents: agents ?? [], availability: agents === null ? "unavailable" : "available" });
			}
			pending.resolve(frame);
			return;
		}
		if (id.startsWith(VSC_ID_PREFIX)) {
			this.#emit({
				type: "late-response",
				requestId: id.slice(VSC_ID_PREFIX.length),
				success: frame.success,
				...(typeof frame.code === "string" ? { code: frame.code } : {}),
			});
		}
	}

	#onUiRequest(frame: Record<string, unknown>): void {
		const id = frame.id;
		switch (frame.method) {
			case "select":
			case "confirm":
			case "input":
			case "ask":
			case "editor": {
				const request = normalizeUiRequest(frame);
				if (request === null) {
					// Never leave OMP waiting on a dialog this extension cannot render.
					this.#unrenderableDialogs += 1;
					if (typeof id === "string") void this.#channel.writeLine(encodeUiResponse(id, { cancelled: true })).catch(() => undefined);
					return;
				}
				this.#model = applyChatUiRequest(this.#model, request);
				if (this.#live) this.#emit({ type: "ui-request", epoch: this.epoch, request });
				this.#emitModel();
				return;
			}
			case "cancel":
				if (typeof frame.targetId === "string") this.#dropDialog(frame.targetId);
				return;
			case "setStatus":
				// The Desk liveness signal is data for the Agents row, never status-line text.
				if (frame.statusKey === AGENT_LIVENESS_STATUS_KEY) {
					const agents = this.#agentLiveness.accept(frame.statusText, this.#boundId);
					if (agents !== null) this.#applyFrame({ type: "agents_liveness", agents });
					return;
				}
				if (typeof frame.statusKey === "string") {
					this.#applyFrame({
						type: "ui_status",
						key: frame.statusKey,
						text: typeof frame.statusText === "string" ? frame.statusText : null,
					});
				}
				return;
			case "setWidget":
				if (typeof frame.widgetKey === "string") {
					const lines = Array.isArray(frame.widgetLines)
						? frame.widgetLines.filter((line): line is string => typeof line === "string")
						: null;
					const placement: { placement?: "aboveEditor" | "belowEditor" } = frame.widgetPlacement === "aboveEditor" || frame.widgetPlacement === "belowEditor" ? { placement: frame.widgetPlacement } : {};
					this.#applyFrame({ type: "ui_widget", key: frame.widgetKey, lines, ...placement });
				}
				return;
			case "notify": {
				if (typeof frame.message !== "string" || frame.message.trim().length === 0) return;
				// Untrusted extension text: bounded here, shown as text (never markup) by the page and the host.
				const message = frame.message.slice(0, 2_000);
				if (frame.notifyType === "error") { if (this.#live) this.#emit({ type: "extension-error", message }); }
				// `info` is dropped: extensions use it for running commentary (a tool intent per call) that the working
				// status already shows; a banner per call only duplicated it. Warnings stay until dismissed.
				else if (frame.notifyType === "warning") this.#applyFrame({ type: "ui_notify", level: "warning", message });
				return;
			}
			case "set_editor_text":
				if (typeof frame.text === "string") this.#applyFrame({ type: "ui_editor_text", text: frame.text });
				return;
			case "open_url":
				if (typeof frame.url === "string") {
					this.#emit({
						type: "open-url",
						url: frame.url,
						...(typeof frame.launchUrl === "string" ? { launchUrl: frame.launchUrl } : {}),
						...(typeof frame.instructions === "string" ? { instructions: frame.instructions } : {}),
					});
				}
				return;
			default:
				// `setTitle` is ignored (the title stays the index's); unknown methods are ignored.
				return;
		}
	}

	#dropDialog(targetId: string): void {
		const before = this.#model;
		this.#model = applyChatUiCancel(this.#model, targetId);
		if (this.#model !== before && this.#live) this.#emit({ type: "ui-cancel", epoch: this.epoch, targetId });
		this.#emitModel();
	}

	get #live(): boolean {
		return this.#model.phase === "live";
	}

	/** Fold one frame into the shadow model, forward it when live, and run its side effects. */
	#applyFrame(frame: ChatEventFrame): void {
		if (frame.type === "available_commands_update") this.#commandRevision += 1;
		const previousAgents = this.#model.agents;
		this.#model = reduceChatFrame(this.#model, frame, { now: this.#timers.now() });
		if (frame.type === "subagent_lifecycle" && frame.payload.status === "started" && this.#model.agents.has(frame.payload.id)) {
			this.#subagentReferences.delete(frame.payload.id);
			this.#subagentReferences.add(frame.payload.id);
		} else if (frame.type === "agents_snapshot" || frame.type === "agents_liveness") {
			for (const agent of frame.agents) { this.#subagentReferences.delete(agent.id); this.#subagentReferences.add(agent.id); }
		}
		while (this.#subagentReferences.size > 256) {
			const oldest = this.#subagentReferences.values().next();
			if (!oldest.done) this.#subagentReferences.delete(oldest.value);
		}
		if (this.#live) {
			this.#emit({ type: "event", epoch: this.epoch, frame });
			this.#emitModel();
		}
		this.#syncPausedStateReadback();
		if (this.#live && this.#model.asyncPaused) {
			let terminalChild = false;
			if (frame.type === "subagent_lifecycle") {
				terminalChild = frame.payload.status !== "started" && previousAgents.has(frame.payload.id) && !this.#model.agents.has(frame.payload.id);
			} else if (frame.type === "subagent_progress") {
				const before = previousAgents.get(frame.payload.progress.id)?.status;
				const after = this.#model.agents.get(frame.payload.progress.id)?.status;
				terminalChild = (before === "pending" || before === "running") && (after === "completed" || after === "failed" || after === "aborted");
			}
			if (terminalChild) void this.#readPausedState();
		}
		switch (frame.type) {
			case "message_end":
				this.#reconcileAttempts = 0;
				// The transcript recorded a prompt while messages are listed: OMP does not report every delivery of a
				// steer it took into a streaming response, so read the queue back rather than keep listing it.
				if (frame.message.role === "user" && this.#live && (this.#model.state?.queuedMessageCount ?? 0) > 0) void this.#refreshState();
				return;
			case "queue_update":
				this.#queueRevision += 1;
				return;
			case "agent_end":
				this.#requestReconcile();
				return;
			case "prompt_result":
				this.#onPromptResult(frame);
				return;
			case "session_settled":
				void this.#afterSettle();
				return;
			case "todo_auto_clear":
				if (this.#live) void this.#refreshState();
				return;
			case "tool_execution_end":
				if (frame.toolName === "eval" && this.#live) void this.#refreshState();
				return;
			case "auto_compaction_end":
				// A pass changes the context size without a turn: `session_settled` never follows it, so the footer's
				// context usage (read only from `get_state`) would keep the figure from before the pass.
				if (this.#live) {
					void this.#rebuild();
					void this.#refreshState();
				}
				return;
			case "session_info_update":
			case "config_update":
			case "available_commands_update":
				if (this.#slashArmed && this.#live) void this.#checkIdentity();
				return;
			default:
				return;
		}
	}

	/** Apply a frame this session produced itself (never forwarded from the child). */
	#applyLocal(frame: ChatEventFrame): void {
		this.#applyFrame(frame);
	}

	#onPromptResult(frame: Extract<ChatEventFrame, { type: "prompt_result" }>): void {
		const requestId = typeof frame.id === "string" && frame.id.startsWith(VSC_ID_PREFIX) ? frame.id.slice(VSC_ID_PREFIX.length) : null;
		const result: ChatPromptResult = {
			id: typeof frame.id === "string" ? frame.id : null,
			status: frame.status,
			agentInvoked: frame.agentInvoked,
			sessionSettled: frame.sessionSettled,
		};
		if (requestId !== null) {
			const at = this.#ledger.findIndex(entry => entry.requestId === requestId);
			if (at >= 0) this.#ledger.splice(at, 1);
		}
		this.#emit({ type: "prompt-result", requestId, result });
		if (this.#slashArmed && !frame.agentInvoked && this.#live) void this.#checkIdentity();
		this.#requestReconcile();
	}

	#requestReconcile(): void {
		if (!this.#live) return;
		if (this.#reconcileRunning) {
			this.#reconcileAgain = true;
			return;
		}
		void this.#runReconcile();
	}

	async #runReconcile(): Promise<void> {
		// A navigation re-syncs through this serializer as soon as its command answered; reading mid-command could
		// only show a leaf that moved without its marker yet.
		if (this.#navigation !== null) return;
		this.#reconcileRunning = true;
		try {
			do {
				this.#reconcileAgain = false;
				await this.#reconcileEntries();
			} while (this.#reconcileAgain && this.#live);
		} finally {
			this.#reconcileRunning = false;
			for (const resolve of this.#reconcileIdleWaiters.splice(0)) resolve();
		}
		this.#afterReconcile();
	}

	/** After a pass: retry while a pending row stays unmatched, then flag it *not yet saved* once settled. */
	#afterReconcile(): void {
		this.#clearReconcileTimer();
		const fence = this.#navigationFence;
		if (fence !== null && this.#model.entries.some(entry => navigationMarker(entry)?.requestId === fence.requestId)) this.#navigationFence = null;
		if (!this.#live) return;
		if (this.#model.pending.size === 0) {
			this.#reconcileAttempts = 0;
			this.#lostPromptCheck();
			return;
		}
		// Rows replayed from a branch the user rewound away from are saved there, not lost: drop them once settled.
		if (this.#reconcileAttempts === 0 && this.#model.settled && this.#model.branches.length > 0 && !this.#offPathCheck && [...this.#model.pending.values()].some(row => !row.unsaved && row.hidden !== true)) {
			this.#offPathCheck = true;
			void this.#dropPendingSavedElsewhere().finally(() => { this.#offPathCheck = false; });
		}
		this.#reconcileAttempts += 1;
		const budget = this.#options.reconcileAttempts ?? DEFAULT_RECONCILE_ATTEMPTS;
		if (this.#reconcileAttempts < budget) {
			this.#reconcileTimer = this.#timers.setTimeout(() => {
				this.#reconcileTimer = null;
				this.#requestReconcile();
			}, this.#options.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS);
			return;
		}
		if (this.#model.settled) {
			const marked = markPendingUnsaved(this.#model);
			if (marked !== this.#model) {
				this.#model = marked;
				this.#publish();
			}
			this.#lostPromptCheck();
		}
	}

	/** One full read: the file's entries off the active path consume the pending rows they persisted. */
	async #dropPendingSavedElsewhere(): Promise<void> {
		const outcome = await this.#sendInternal({ type: "get_entries" });
		if (outcome.status !== "accepted" || this.#disposed || this.#ended) return;
		const data = outcome.response.data;
		if (!isRecord(data) || !Array.isArray(data.entries)) return;
		const raw = data.entries.filter(isRecord);
		const onPath = new Set(branchOf(raw, typeof data.leafId === "string" ? data.leafId : null).rows.map(row => row.id));
		const offPath = raw.flatMap(row => { if (onPath.has(row.id)) return []; const parsed = parseChatEntry(row); return parsed === null ? [] : [parsed]; });
		const next = dropPendingSavedElsewhere(this.#model, offPath, { now: this.#timers.now() });
		if (next === this.#model) return;
		this.#model = next;
		if (this.#live) this.#publish();
	}

	#clearReconcileTimer(): void {
		if (this.#reconcileTimer !== null) {
			this.#timers.clearTimeout(this.#reconcileTimer);
			this.#reconcileTimer = null;
		}
	}

	/**
	 * `get_entries { since: cursor }` merged into the model. An unknown cursor, a legacy-id file or a missing reader
	 * takes one full read (deferred to settle while a turn streams). A delta that does not extend the known leaf, or
	 * an empty one whose leaf moved (a rewind, OMP's own turn recovery), rebuilds the window at the live leaf.
	 */
	async #reconcileEntries(): Promise<void> {
		const since = this.#cursor;
		if (since === null && this.#model.working) {
			this.#needFull = true;
			return;
		}
		const outcome = await this.#sendInternal(since === null ? { type: "get_entries" } : { type: "get_entries", since });
		if (this.#disposed || this.#ended) return;
		if (outcome.status !== "accepted") {
			if (outcome.status === "refused" && outcome.code === "unknown_since") {
				this.#cursor = null;
				if (this.#model.working) this.#needFull = true;
				else await this.#reconcileEntries();
			}
			return;
		}
		const data = outcome.response.data;
		if (!isRecord(data) || !Array.isArray(data.entries)) return;
		const raw = data.entries.filter(isEntryRecord);
		const leafId = typeof data.leafId === "string" ? data.leafId : null;
		this.#needFull = false;
		if (since === null) {
			this.#applyFull(raw, leafId);
			return;
		}
		const live = { leafId, lastId: typeof raw.at(-1)?.id === "string" ? raw.at(-1)!.id as string : since };
		if (raw.length === 0) {
			if (leafId !== this.#model.leafId) await this.#rebuild(live);
			else this.#authoritativeReads += 1;
			return;
		}
		const branch = branchOf(raw, leafId);
		const expectedParent = this.#model.leafId;
		if (!branch.found || (expectedParent !== null && branch.rootParent !== expectedParent)) {
			await this.#rebuild(live);
			return;
		}
		this.#cursor = live.lastId;
		const rows = branch.rows.flatMap(row => { const parsed = parseChatEntry(row); return parsed === null ? [] : [parsed]; });
		this.#model = applyChatEntries(this.#model, rows, leafId, { now: this.#timers.now() });
		this.#authoritativeReads += 1;
		if (this.#live) {
			this.#emit({ type: "entries", payload: { epoch: this.epoch, entries: rows, leafId } });
			this.#emitModel();
		}
	}

	/**
	 * A full `get_entries`: authoritative for the whole active branch. With a reader, only the tail window is applied
	 * (older rows load from disk, by ancestry), so a long session never repaints in full.
	 */
	#applyFull(raw: readonly Record<string, unknown>[], leafId: string | null): void {
		const branch = branchOf(raw, leafId);
		let rows = branch.rows.flatMap(row => { const parsed = parseChatEntry(row); return parsed === null ? [] : [parsed]; });
		let olderCount = 0;
		if (this.#reader !== null && !this.#readerLegacyIds) {
			const window = transcriptWindow(rows, this.#tailRows, null);
			const sourceIds = new Set(window.rows.flatMap(card => card.sourceIds));
			const first = window.olderRows === 0 ? 0 : rows.findIndex(entry => sourceIds.has(entry.id));
			if (first > 0) {
				olderCount = rows.slice(0, first).filter(entry => rendersTranscriptEntry(entry)).length;
				rows = rows.slice(first);
			}
		}
		this.#cursor = raw.at(-1)?.id === undefined ? null : (raw.at(-1)!.id as string);
		const branches = computeBranchPoints(branchNodesOf(raw), branch.rows.map(row => row.id as string));
		this.#model = { ...applyChatRewrite(this.#model, rows, olderCount, leafId, { now: this.#timers.now() }), branches };
		this.#authoritativeReads += 1;
		if (this.#live) this.#publish();
	}

	/**
	 * The active branch changed under us (or the delta cannot be attached): reload the window from disk, else a full
	 * read. `live` is what the process just reported; the disk is used only when it holds exactly that (its last entry
	 * is the live cursor, and the live leaf is indexed), because OMP's write queue can trail the process. One short
	 * second look, then `get_entries`. Without `live` (after compaction) the disk is taken as it is.
	 */
	async #rebuild(live?: { leafId: string | null; lastId: string }): Promise<void> {
		const reader = this.#reader;
		if (reader !== null) {
			try {
				for (let attempt = 0; ; attempt += 1) {
					await reader.refresh();
					const history = await reader.snapshot(this.#tailRows, live?.leafId);
					if (this.#disposed || this.#ended) return;
					const agrees = live === undefined || (history.lastId === live.lastId && history.leafId === live.leafId);
					if (agrees || history.legacyIds) {
						this.#cursor = history.legacyIds ? null : history.lastId;
						this.#model = { ...applyChatRewrite(this.#model, history.entries, history.olderCount, history.leafId, { now: this.#timers.now() }), branches: history.branches };
						if (this.#live) this.#publish();
						if (history.legacyIds) break;
						this.#authoritativeReads += 1;
						return;
					}
					if (attempt > 0) break;
					await new Promise<void>(resolve => this.#timers.setTimeout(resolve, REBUILD_RETRY_MS));
					if (this.#disposed || this.#ended) return;
				}
			} catch {
				this.#historyFallbacks += 1;
			}
		}
		this.#cursor = null;
		if (this.#model.working) this.#needFull = true;
		else await this.#reconcileEntries();
	}

	async #afterSettle(): Promise<void> {
		if (!this.#live) return;
		const state = await this.#fetchState();
		if (this.#disposed || this.#ended || !this.#live || state === null) return;
		const mismatch = this.#identityMismatch(state, false);
		if (mismatch !== null) {
			this.#fail(mismatch);
			return;
		}
		this.#slashArmed = false;
		if (this.#needFull) this.#cursor = null;
		if (this.#reconcileRunning) this.#reconcileAgain = true;
		else await this.#runReconcile();
	}

	/** A state-producing builtin need not emit a todo tool frame (slash edit, eval or auto-clear). */
	async #refreshState(): Promise<void> {
		const state = await this.#fetchState();
		if (this.#disposed || this.#ended || !this.#live || state === null) return;
		const mismatch = this.#identityMismatch(state, false);
		if (mismatch !== null) this.#fail(mismatch);
	}

	/** A `get_state` cut, with the queue the model already holds when a `queue_update` arrived after the read was sent. */
	#newestQueue(state: ChatLiteState, sentAtRevision: number): ChatLiteState {
		const current = this.#model.state;
		if (sentAtRevision === this.#queueRevision || current === null) return state;
		const { queuedMessages: _stale, ...rest } = state;
		return { ...rest, queuedMessageCount: current.queuedMessageCount, ...(current.queuedMessages === undefined ? {} : { queuedMessages: current.queuedMessages }) };
	}

	/** Public idle covers background jobs/delivery that never emit another main-agent end. */
	async #readPausedState(): Promise<void> {
		if (!this.#live || !this.#model.asyncPaused) return;
		if (this.#pausedStatePending) { this.#pausedStateAgain = true; return; }
		this.#pausedStatePending = true;
		this.#clearPausedStateTimer();
		try {
			await this.#refreshState();
		} finally {
			this.#pausedStatePending = false;
			const again = this.#pausedStateAgain;
			this.#pausedStateAgain = false;
			if (again && this.#live && this.#model.asyncPaused) void this.#readPausedState();
			else this.#syncPausedStateReadback();
		}
	}

	#syncPausedStateReadback(): void {
		let activeChild = false;
		for (const agent of this.#model.agents.values()) {
			if (agent.status === "pending" || agent.status === "running") { activeChild = true; break; }
		}
		if (!this.#live || this.#disposed || this.#ended || !this.#model.asyncPaused || activeChild) {
			this.#clearPausedStateTimer();
			return;
		}
		if (this.#pausedStatePending || this.#pausedStateTimer !== null) return;
		this.#pausedStateTimer = this.#timers.setTimeout(() => {
			this.#pausedStateTimer = null;
			void this.#readPausedState();
		}, 1000);
	}

	#clearPausedStateTimer(): void {
		if (this.#pausedStateTimer === null) return;
		this.#timers.clearTimeout(this.#pausedStateTimer);
		this.#pausedStateTimer = null;
	}

	/** The identity backstop: a `/` prompt may have moved or replaced the session inside the process. */
	async #checkIdentity(): Promise<void> {
		const file = this.#boundFile;
		if (!this.#live) return;
		const state = await this.#fetchState();
		if (this.#disposed || this.#ended || !this.#live || state === null) return;
		// A new unsaved session still has authoritative todo state after a slash builtin.
		if (file === null) return;
		const exists = await (this.#options.fileExists ?? defaultFileExists)(file);
		const mismatch = this.#identityMismatch(state, false);
		if (mismatch !== null || (this.#fileMaterialized && !exists)) this.#fail("identity-diverged");
	}

	#lostPromptCheck(): void {
		if (this.#ledger.length === 0 || !this.#model.settled) return;
		for (const entry of [...this.#ledger]) {
			if (!entry.unconfirmed) continue;
			const delivered = this.#model.entries.some(row => {
				const text = userMessageText(row);
				return text !== null && text === entry.text && row.type === "message" && row.message.timestamp >= entry.sentAt - 5_000;
			});
			this.#ledger.splice(this.#ledger.indexOf(entry), 1);
			if (!delivered) this.#emit({ type: "prompt-lost", requestId: entry.requestId });
		}
	}

	/**
	 * Why a mutation cannot be sent now, or null. A navigation in flight, or one whose answer never came, fences every
	 * mutation (prompts, queue edits, settings, compaction) so nothing appends to the branch it is moving.
	 */
	#controlRefusal(): SendRefusal | null {
		return this.#mutationFence !== null || this.#navigation !== null || this.#navigationFence !== null ? "busy" : this.#live && this.#identityVerified ? null : "not-live";
	}

	#once(requestId: string, run: () => Promise<SendOutcome>): Promise<SendOutcome> {
		if (!REQUEST_ID_PATTERN.test(requestId)) return Promise.resolve({ status: "refused", reason: "bad-request-id" });
		const known = this.#requests.get(requestId);
		if (known !== undefined) return known;
		const promise = run();
		this.#requests.set(requestId, promise);
		if (this.#requests.size > MAX_REMEMBERED_REQUESTS) {
			const oldest = this.#requests.keys().next();
			if (oldest.done !== true) this.#requests.delete(oldest.value);
		}
		return promise;
	}

	#remember(entry: LedgerEntry): void {
		this.#ledger.push(entry);
		if (this.#ledger.length > MAX_LEDGER) this.#ledger.shift();
	}

	async #sendUser(requestId: string, command: RpcCommand): Promise<SendOutcome> {
		try {
			const response = await this.#send(`${VSC_ID_PREFIX}${requestId}`, command);
			if (response.success) {
				const data = response.data;
				const invoked = isRecord(data) && typeof data.agentInvoked === "boolean" ? data.agentInvoked : null;
				return { status: "accepted", agentInvoked: invoked };
			}
			return { status: "refused", reason: "rejected", ...(typeof response.code === "string" ? { code: response.code } : {}) };
		} catch (error) {
			return this.#failureOutcome(error, requestId);
		}
	}

	async #sendInternal(
		command: RpcCommand,
		timeoutMs?: number,
	): Promise<
		| { status: "accepted"; response: RpcResponseFrame }
		| { status: "refused"; reason: SendRefusal; code?: string }
		| { status: "unconfirmed" }
	> {
		try {
			const response = await this.#send(`${INTERNAL_ID_PREFIX}${++this.#internalSeq}`, command, timeoutMs);
			if (response.success) return { status: "accepted", response };
			return { status: "refused", reason: "rejected", ...(typeof response.code === "string" ? { code: response.code } : {}) };
		} catch (error) {
			return this.#failureOutcome(error, null);
		}
	}

	#failureOutcome(error: unknown, requestId: string | null): { status: "refused"; reason: SendRefusal } | { status: "unconfirmed" } {
		if (!(error instanceof CommandFailure)) return { status: "refused", reason: "write-failed" };
		if (error.reason === "unconfirmed" || error.reason === "timeout") {
			const entry = requestId === null ? undefined : this.#ledger.find(item => item.requestId === requestId);
			if (entry !== undefined) entry.unconfirmed = true;
			return { status: "unconfirmed" };
		}
		if (error.writeCode === "input-not-owner") return { status: "refused", reason: "not-owner" };
		return { status: "refused", reason: error.reason === "closed" ? "not-live" : "write-failed" };
	}

	/** Write one command and wait for the response carrying the same id. */
	#send(id: string, command: RpcCommand, timeoutMs?: number): Promise<RpcResponseFrame> {
		return new Promise<RpcResponseFrame>((resolve, reject) => {
			const timer = this.#timers.setTimeout(() => {
				this.#pendingCommands.delete(id);
				reject(new CommandFailure("timeout"));
			}, timeoutMs ?? this.#options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS);
			this.#pendingCommands.set(id, { resolve, reject, timer, command, queueRevision: this.#queueRevision });
			this.#channel.writeLine(encodeCommand(id, command)).catch((error: unknown) => {
				if (this.#pendingCommands.get(id) === undefined) return;
				this.#pendingCommands.delete(id);
				this.#timers.clearTimeout(timer);
				const code = writeErrorCode(error);
				this.#onWriteFailure(code);
				reject(new CommandFailure("write", code));
			});
		});
	}

	#onWriteFailure(code: RpcWriteErrorCode): void {
		if (code === "child-exited") this.#stopped("child-exited");
	}

	#failAllCommands(reason: CommandFailure["reason"]): void {
		for (const [id, pending] of [...this.#pendingCommands]) {
			this.#pendingCommands.delete(id);
			this.#timers.clearTimeout(pending.timer);
			pending.reject(new CommandFailure(reason));
		}
	}

	#awaitReady(timeoutMs: number): Promise<boolean> {
		if (this.#readySeen) return Promise.resolve(true);
		return new Promise<boolean>(resolve => {
			const timer = this.#timers.setTimeout(() => {
				const at = this.#readyWaiters.indexOf(waiter);
				if (at >= 0) this.#readyWaiters.splice(at, 1);
				resolve(false);
			}, timeoutMs);
			const waiter = (ok: boolean): void => {
				this.#timers.clearTimeout(timer);
				resolve(ok);
			};
			this.#readyWaiters.push(waiter);
		});
	}

	#setPhase(phase: ChatPhase, code: ChatCode | null): void {
		const next = setChatPhase(this.#model, phase, code, phase === "failed" || phase === "stopped" ? this.#model.readOnlyReason : null);
		if (next === this.#model) return;
		this.#model = next;
		this.#emitState();
		this.#syncPausedStateReadback();
	}

	#fail(code: RpcErrorCode): void {
		if (this.#disposed) return;
		this.#failAllCommands("closed");
		// A failed connection says nothing about the turn it carried: keeping `working` would show a
		// frozen spinner. The next successful attach reads the real state back.
		this.#model = {
			...setChatPhase(this.#model, "failed", code, code),
			working: false,
			asyncPaused: false,
			activeTools: new Map(),
		};
		this.#clearPausedStateTimer();
		this.#disarmWatchdog();
		this.#publish();
		this.#scheduleAutoRecovery(code);
	}

	#stopped(code: RpcErrorCode | null, reason?: ChatExitReason): void {
		if (this.#disposed) return;
		if (this.#ended) {
			// A failed in-flight write may learn of exit before the final broker status.
			const exitReason = reason === undefined ? null : parseChatExitReason(reason);
			if (this.#model.code === "child-exited" && this.#model.exitReason === undefined && exitReason !== null) {
				this.#model = { ...this.#model, exitReason };
				this.#publish();
			}
			return;
		}
		this.#ended = true;
		this.#clearReconcileTimer();
		this.#clearPausedStateTimer();
		this.#disarmWatchdog();
		this.#clearAutoRecovery();
		this.#failAllCommands("closed");
		for (const waiter of this.#readyWaiters.splice(0)) waiter(false);
		this.#model = setChatPhase(this.#model, "stopped", code, "stopped");
		const exitReason = reason === undefined ? null : parseChatExitReason(reason);
		if (exitReason !== null) this.#model = { ...this.#model, exitReason };
		this.#publish();
	}

	/** Publish an authoritative snapshot (epoch + 1): live transition, failure, stop, rewrite. */
	#publish(baseline = false): void {
		this.#epochCounter += 1;
		this.#model = { ...this.#model, epoch: this.epoch };
		this.#emitState();
		this.#emit({ type: "snapshot", payload: snapshotOf(this.#model, this.epoch), baseline });
		this.#emitModel();
	}

	/** The disk-paint snapshot: history visible while the child is still starting. */
	#emitSnapshot(): void {
		this.#epochCounter += 1;
		this.#model = { ...this.#model, epoch: this.epoch };
		this.#emit({ type: "snapshot", payload: snapshotOf(this.#model, this.epoch), baseline: false });
	}

	#emitState(): void {
		this.#emit({ type: "state", payload: this.#statePayload() });
	}

	#statePayload(): ChatStatePayload {
		return {
			epoch: this.epoch,
			phase: this.#model.phase,
			code: this.#model.code,
			sessionId: this.#boundId,
			cwd: this.#model.header?.cwd ?? this.#options.cwd,
			title: this.#model.header?.title ?? null,
			readOnlyReason: this.#model.readOnlyReason,
			...(this.#model.exitReason === undefined ? {} : { exitReason: this.#model.exitReason }),
		};
	}

	#emitModel(): void {
		if (this.#live) this.#emit({ type: "model", model: this.#model });
	}

	#emit(output: RpcSessionOutput): void {
		for (const listener of [...this.#listeners]) {
			try {
				listener(output);
			} catch {
				// A consumer failure must not break the session's own state machine.
			}
		}
	}

	/**
	 * A live connection can stop delivering without ever closing (a stalled broker link, a child
	 * that stopped answering, a stream that lost frames). The watchdog looks at its silence on a
	 * timer, asks the child for its state when the silence is long, and replaces a connection that
	 * does not answer instead of waiting on it: the page must never stay on a frozen "working".
	 */
	#armWatchdog(): void {
		if (this.#watchdogTimer !== null || this.#disposed || this.#ended) return;
		this.#watchdogTimer = this.#timers.setTimeout(() => {
			this.#watchdogTimer = null;
			void this.#watchdogTick();
		}, this.#options.watchdogIntervalMs ?? DEFAULT_WATCHDOG_INTERVAL_MS);
	}

	#disarmWatchdog(): void {
		if (this.#watchdogTimer === null) return;
		this.#timers.clearTimeout(this.#watchdogTimer);
		this.#watchdogTimer = null;
	}

	async #watchdogTick(): Promise<void> {
		// A session that is not live is re-armed by the publication that makes it live again.
		if (!this.#live || this.#disposed || this.#ended) return;
		const busy = this.#model.working || this.#model.asyncPaused;
		const limit = busy
			? (this.#options.workingSilenceMs ?? DEFAULT_WORKING_SILENCE_MS)
			: (this.#options.idleSilenceMs ?? DEFAULT_IDLE_SILENCE_MS);
		if (this.#watchdogRunning || this.#timers.now() - this.#lastActivityAt < limit) {
			this.#armWatchdog();
			return;
		}
		this.#watchdogRunning = true;
		try {
			this.#watchdogProbes += 1;
			const epoch = this.#epochCounter;
			const answerRevision = this.#stateAnswerRevision;
			const outcome = await this.#sendInternal({ type: "get_state" }, this.#options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
			if (this.#disposed || this.#ended || !this.#live || epoch !== this.#epochCounter) return;
			if (outcome.status === "unconfirmed") {
				if (answerRevision === this.#stateAnswerRevision) this.#nativeStateUnanswered = true;
				this.#recover("probe-timeout");
				return;
			}
			// Any answer, even a refusal, proves the child and the link are alive. The answer to
			// `get_state` was already folded at dispatch; a turn it no longer reports as running
			// was a stale "working" the stream never closed, so the entries it produced are read.
			this.#lastActivityAt = this.#timers.now();
			if (outcome.status === "accepted" && busy && !this.#model.working && !this.#model.asyncPaused) {
				this.#recoveries += 1;
				this.#emit({ type: "recovery", reason: "stale-working" });
				this.#requestReconcile();
			}
		} finally {
			this.#watchdogRunning = false;
			if (this.#live) this.#armWatchdog();
		}
	}

	/** Drop the connection and attach to the same process again; the process and the transcript are untouched. */
	#recover(reason: RpcRecoveryReason): void {
		this.#recoveries += 1;
		this.#emit({ type: "recovery", reason });
		this.#disarmWatchdog();
		this.#clearAutoRecovery();
		this.#channel.disconnect();
		void this.#reattach();
	}

	/**
	 * Re-run the attach sequence over a fresh connection after the link to the process was lost.
	 *
	 * Refused when the session ended, was disposed, never started, or failed for a reason a retry
	 * cannot fix (a different identity, an exited process). A reconnect already in flight is joined.
	 * Identity is proved again by the attach sequence, so a reconnect can never drive another session.
	 */
	reconnect(): "started" | "refused" {
		if (this.#disposed || this.#ended || this.#startPromise === null) return "refused";
		if (this.#reattaching || this.#establishing) return "started";
		const phase = this.#model.phase;
		if (phase === "failed" ? !isRecoverableRpcFailure(this.#model.code) : phase !== "live") return "refused";
		this.#recover("manual-reconnect");
		return "started";
	}

	/** A recoverable failure is retried on its own with a growing delay; the page's Reconnect is the immediate form. */
	#scheduleAutoRecovery(code: RpcErrorCode): void {
		this.#clearAutoRecovery();
		if (!isRecoverableRpcFailure(code) || this.#disposed || this.#ended) return;
		const delays = this.#options.autoRecoveryDelaysMs ?? DEFAULT_AUTO_RECOVERY_DELAYS_MS;
		const delay = delays[this.#autoRecoveryAttempt];
		if (delay === undefined) return;
		this.#autoRecoveryAttempt += 1;
		this.#autoRecoveryTimer = this.#timers.setTimeout(() => {
			this.#autoRecoveryTimer = null;
			if (this.#disposed || this.#ended || this.#model.phase !== "failed" || !isRecoverableRpcFailure(this.#model.code)) return;
			this.#recover("auto-retry");
		}, delay);
	}

	#clearAutoRecovery(): void {
		if (this.#autoRecoveryTimer === null) return;
		this.#timers.clearTimeout(this.#autoRecoveryTimer);
		this.#autoRecoveryTimer = null;
	}

	/** A frame threw while being folded: count it and schedule (at most once per gap) an authoritative rebuild. */
	#frameFailed(): void {
		this.#frameFailures += 1;
		const now = this.#timers.now();
		if (now - this.#lastFrameResyncAt < FRAME_FAILURE_RESYNC_GAP_MS) return;
		this.#lastFrameResyncAt = now;
		this.#emit({ type: "recovery", reason: "frame-failure" });
		this.#scheduleResync();
	}

	/** A parse or chunk-contract violation: rebuild state from `get_state` and the delta (never fatal). */
	#scheduleResync(): void {
		if (!this.#live || this.#resyncScheduled) return;
		this.#resyncScheduled = true;
		queueMicrotask(() => {
			this.#resyncScheduled = false;
			if (!this.#live) return;
			void this.#resync(false).catch(() => this.#fail("state-failed"));
		});
	}

	/** The broker link dropped while the child may still run: reattach with the last seq, with backoff. */
	async #reattach(): Promise<void> {
		if (this.#reattaching || this.#ended || this.#disposed) return;
		this.#reattaching = true;
		this.#failAllCommands("unconfirmed");
		this.#clearReconcileTimer();
		const delays = this.#options.reattachDelaysMs ?? DEFAULT_REATTACH_DELAYS_MS;
		try {
			for (let attempt = 0; attempt <= delays.length; attempt += 1) {
				if (this.#ended || this.#disposed) return;
				this.#establishing = true;
				try {
					await this.#establish("reattach");
					return;
				} catch (error) {
					if (!(error instanceof SessionFailure) || error.code !== "attach-failed" || attempt === delays.length) {
						this.#fail(error instanceof SessionFailure ? error.code : "attach-failed");
						return;
					}
				} finally {
					this.#establishing = false;
				}
				await new Promise<void>(resolve => {
					this.#timers.setTimeout(resolve, delays[attempt]!);
				});
			}
		} finally {
			this.#reattaching = false;
			if (this.#dropDuringEstablish && !this.#ended && !this.#disposed) {
				this.#dropDuringEstablish = false;
				void this.#reattach();
			}
		}
	}
}

/** Whether `name` is a denied slash builtin (see {@link DENIED_SLASH_COMMANDS}); lets the composer pre-check like the host. */
export function isDeniedSlashCommand(name: string): boolean {
	return Object.hasOwn(DENIED_SLASH_COMMANDS, name.toLowerCase());
}

/**
 * The view-only snapshot of a stopped session: history from the file, phase `view-only`, composer disabled. It never
 * claims and never starts a process. Returns the reader too so `load-older` can be served from it.
 */
export async function readViewOnlySnapshot(
	file: string,
	epoch: ChatEpoch,
	reason: string | null = "stopped",
	tailRows: number = DEFAULT_TAIL_ROWS,
): Promise<{ snapshot: ChatSnapshotPayload; reader: HistoryReader }> {
	const reader = await HistoryReader.open(file);
	const history = await reader.snapshot(tailRows);
	return { snapshot: chatSnapshotFromHistory(history, epoch, "view-only", null, reason), reader };
}
