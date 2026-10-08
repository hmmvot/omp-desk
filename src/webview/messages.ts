/**
 * Typed message contract between the extension host and the OMP chat Webview.
 *
 * This module is the single source of truth for the boundary; the extension side
 * imports these types instead of re-declaring shapes. Direction is explicit:
 *
 * - {@link GuestHostMessage} — extension host → Webview.
 * - {@link GuestWebviewMessage} — Webview → extension host.
 *
 * The chat channel (`omp:chat-*`) carries the host-owned conversation: the extension
 * host holds the `omp --mode rpc-ui` session and the authoritative chat model, and the
 * page is a view over it. Apart from the per-document reconnect secret
 * (`omp:bridge-bind`), nothing on this boundary carries a key or a
 * capability: the page holds no session credential, and the host answers a mutation
 * with the state it actually read back, never with the page's own claim.
 *
 * The `@`-completion exchange (`omp:complete-files` →
 * `omp:file-completions`) carries no bearer, no session identity and no paths
 * beyond workspace file names: the Webview asks a bounded text query, the
 * extension host answers a bounded list of workspace paths it already knows
 * from VS Code's file index. Both directions are validated here, so neither side
 * can hand the other a shape it did not declare.
 *
 * The host-control exchange (`omp:control-request` → `omp:control-state`) is the
 * panel's view of the session's model and thinking level. A request carries a
 * panel-minted correlation scope and a monotonic id — neither authorizes anything:
 * the extension host decides what may run, mints the exact-once ledger id for a
 * mutation, and answers with reported options, gating and outcomes. The footer's
 * displayed model and thinking level come only from pushed chat state.
 */
// Explicit `.ts` specifiers: this module is imported by the node:test runner
// through `src/webview/messages.test.ts`, and Node's ESM loader does not resolve
// extensionless specifiers (the Webview bundle itself does not care).
import type { ControlModelRef } from "../host/control-protocol.ts";
import { isRecord } from "../guards.ts";
import { parseChatHostMessage, parseChatWebviewMessage } from "./chat-messages.ts";
import type { ChatHostMessage, ChatWebviewMessage } from "./chat-messages.ts";
import { isPanelTabId } from "./panel-identity.ts";
import { parseFooterMetadata } from "./footer-metadata.ts";
import type { FooterMetadataMessage } from "./footer-metadata.ts";
import { parseTerminalLinkRequest, parseTerminalLinkValidation } from "./terminal-links.ts";
import type { TerminalLinkRequest, TerminalLinkValidation } from "./terminal-links.ts";

/** Provider-qualified model display shape shared with the host. */
export type { ControlModelRef };
export * from "./chat-messages.ts";

/**
 * Bumped when a message shape changes incompatibly. The host refuses a page that
 * speaks another version, so a surviving page of an older build is never driven
 * by this host.
 */
export const GUEST_PROTOCOL_VERSION = 7;

/**
 * Paths the completion popup may show for one query. The extension host asks
 * `findFiles` for a bounded multiple of this and the Webview renders at most
 * this many, so one keystroke can never produce an unbounded list.
 */
export const FILE_COMPLETION_LIMIT = 20;

/** Longest `@…` query this boundary accepts. Longer tokens are ordinary prose. */
export const MAX_FILE_QUERY_LENGTH = 256;

/** Longest file path this boundary accepts from the extension host. */
export const MAX_FILE_PATH_LENGTH = 512;

/**
 * Longest provider id, model id, read-gap note or control notice this boundary
 * accepts. Control text is display text: it never becomes a path, a prompt line
 * or a credential.
 */
export const MAX_CONTROL_TEXT_LENGTH = 200;

/**
 * Longest thinking level this boundary accepts. The vocabulary is the host's
 * (`xhigh`, `medium`, …); this side bounds the shape, not the membership, so a
 * level a future host adds is still relayed instead of silently dropped.
 */
export const MAX_THINKING_LEVEL_LENGTH = 64;



/** Control characters would corrupt a message and, once inserted, a prompt line. */
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

/**
 * True when `value` is free of control characters, i.e. safe to carry across
 * the boundary and to splice into a prompt.
 */
export function isSafeBoundaryText(value: string): boolean {
	return !CONTROL_CHARACTER.test(value);
}

/**
 * Canonical UUID. A control scope is a *correlation tag*, never an
 * authorization: it names the panel mount a report belongs to, so a panel can
 * discard a report meant for another panel — or for an earlier mount of this
 * one. Version and variant nibbles are pinned so a truncated or hand-typed
 * placeholder fails here rather than halfway across the boundary.
 */
const CONTROL_SCOPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** True for a scope this boundary will relay. */
export function isControlScope(value: unknown): value is string {
	return typeof value === "string" && CONTROL_SCOPE.test(value);
}

/**
 * The bridge's own token grammar: 128 bits as lowercase hex.
 *
 * Host generations, document and editor ids, route generations and bootstrap ids
 * all use it, and each is only ever compared with the value the host itself
 * minted for the message it is answering.
 */
const BRIDGE_TOKEN = /^[0-9a-f]{32}$/;

/** True for one canonical bridge token. */
export function isBridgeToken(value: unknown): value is string {
	return typeof value === "string" && BRIDGE_TOKEN.test(value);
}

/** Canonical lowercase SHA-256 hex for workspace and native binding hashes. */
const BRIDGE_HASH = /^[0-9a-f]{64}$/;

function isBridgeHash(value: unknown): value is string {
	return typeof value === "string" && BRIDGE_HASH.test(value);
}

/** The three words a route status may be; anything else is a mismatch. */
const ROUTE_STATUS: Record<string, "ready" | "waiting" | "disconnected"> = {
	ready: "ready",
	waiting: "waiting",
	disconnected: "disconnected",
};

/**
 * The canonical Webview Origin an installed page runs on.
 *
 * `location.origin` was measured as `vscode-webview://<document id>` in VS Code
 * 1.139.1: a non-opaque origin whose host is the document id. Only that exact
 * shape is carried, so `null`, `*`, a hosted origin or a path cannot be sent to
 * the host as a pinnable origin.
 */
const WEBVIEW_ORIGIN = /^vscode-webview:\/\/[a-z0-9]{1,128}$/;

/**
 * Mint the correlation scope of one mounted guest panel.
 *
 * The assertion is not a fallback: `crypto.randomUUID` is the only minter, so a
 * value that fails the grammar is a bug to surface here rather than a scope that
 * would silently discard every report the host sends back.
 */
export function newControlScope(): string {
	const scope = crypto.randomUUID();
	if (!isControlScope(scope)) throw new Error("crypto.randomUUID did not produce a UUID");
	return scope;
}

/**
 * Tell the panel that the host-control facts it last read are stale, so a surface
 * that already reported "not verified yet" asks again instead of waiting for the
 * user's Refresh.
 *
 * It carries no state and no identity: it is a bounded invalidation the extension
 * sends when the thing that made controls unavailable has changed (the
 * authenticated channel was established, or a draft was promoted to its exact
 * session file). The panel answers with its ordinary correlated snapshot request,
 * so a report can still only be applied to the request that asked for it.
 */
export interface GuestControlInvalidateMessage {
	type: "omp:control-invalidate";
}

/**
 * Select one route for this document and name the generation the page must echo.
 *
 * Exactly one route is offered at a time. The page acknowledges the generation
 * over the transport that carried the offer; only then may a mutation be
 * dispatched, so a lost offer leaves the document readable-but-frozen rather than
 * dispatching under a route the page never agreed to.
 */
export interface GuestRouteOfferMessage {
	type: "omp:route-offer";
	/** Activation-wide host generation (`H`); a page echoes it in its answer. */
	hostGeneration: string;
	/** The document incarnation (`D`) this route belongs to. */
	documentId: string;
	/** The route generation (`R`) being offered. */
	routeGeneration: string;
	/** Bounded state word: `ready`, `waiting` or `disconnected`. */
	status: string;
}

/**
 * Hand one document its independent reconnect secret and the exact listener it
 * belongs to.
 *
 * Delivered over the panel route only, and only once the page's Origin and the
 * chat-host binding have been verified and the document committed, so the
 * secret never exists in a document that cannot yet authenticate with it. The
 * page keeps it in memory and never persists it.
 */
export interface GuestBridgeBindMessage {
	type: "omp:bridge-bind";
	/** Activation-wide host generation (`H`). */
	hostGeneration: string;
	/** The document this secret belongs to (`D`). */
	documentId: string;
	/** The bootstrap this delivery answers; the page echoes it back. */
	bootstrapId: string;
	/** Canonical SHA-256 workspace hash (`W`) the handshake transcript carries. */
	workspace: string;
	/** Indexed tab id (`T`). */
	tabId: string;
	/** Actual editor id (`E`). */
	editorId: string;
	/** Exact loopback port this document's listener is bound to. */
	port: number;
	/** Canonical Webview Origin this listener accepts. */
	origin: string;
	/** The only path the listener upgrades on. */
	path: string;
	/** Lowercase SHA-256 hex of the acknowledged chat-host binding. */
	bindingHash: string;
	/** The document's reconnect secret, base64url; never persisted by the page. */
	secret: string;
}

/** Answer to {@link GuestFileCompletionRequestMessage}; paths only, never a link. */
export interface GuestFileCompletionsMessage {
	type: "omp:file-completions";
	/** Echoes the request this answers; a reply with any other id is stale. */
	requestId: number;
	/** Workspace-relative (preferred) or absolute paths, already ranked and bounded. */
	paths: string[];
}

/** Answer to {@link GuestControlRequestMessage}. */
export interface GuestControlStateMessage {
	type: "omp:control-state";
	/** Echo of the requesting panel's correlation scope; only that panel applies this. */
	scope: string;
	/** Echo of the request this answers; a report for any other id is stale. */
	requestId: number;
	/** False when the host-owned rpc session cannot report its controls. */
	available: boolean;
	/** Model the host read back, or `null` when it could not read one. */
	model: ControlModelRef | null;
	/** Thinking level the host read back, or `null` when it could not read one. */
	thinkingLevel: string | null;
	/** Native picker selection, distinct from effective host readback. Absent on cancellation. */
	selectedModel?: ControlModelRef;
	selectedThinking?: string;
	/** `unavailable` means this host build refuses a mutation before reserving an id. */
	mutationMode: "best-effort" | "unavailable";
	/** Extension-owned, credential-free notice about the last request. */
	notice?: string;
	/** Why control is unavailable; required when `available` is false. */
	reason?: string;
}


/**
 * A VS Code command or keybinding asking the focused panel's UI to do something
 * the panel already offers as a control: submit the composer, stop the running
 * turn, or move focus into the prompt.
 *
 * The panel dispatches these into the same handlers its own buttons use
 * (`webview/lib/panel-actions`), so a keybinding cannot send a draft the Send
 * button would refuse, and a keybinding pressed with no composer mounted is
 * reported instead of silently doing nothing.
 */
export interface GuestPanelActionMessage {
	type: "omp:webview-action";
	action: GuestPanelAction;
}

export type GuestPanelAction = "send-prompt" | "stop-turn" | "focus-composer";

/**
 * Longest reference text one editor-context insertion may carry.
 *
 * The limit is the native TUI's, not the page's: a bracketed paste above 1,000 characters
 * (or ten lines) collapses into a `[Paste #N]` marker and opens its large-paste menu, which is
 * not the prompt input. Chat uses the same bound so one gesture inserts the same thing in both
 * views.
 */
export const MAX_INSERT_TEXT_LENGTH = 900;

/**
 * File references the user chose in the editor, to be inserted into the composer draft.
 *
 * The text is one line of `@path` mentions (and their line notes) the host composed for this
 * session's working directory. The composer inserts it at the caret, or at the end of the draft,
 * and never submits. A page whose composer is not mounted yet holds it until one is.
 */
export interface GuestInsertTextMessage {
	type: "omp:insert-text";
	text: string;
}

/**
 * Longest composer draft this boundary carries in one handoff.
 *
 * A draft is the user's own unsent text, so it is carried verbatim — but not without
 * bound: the handoff exists so a document that must be replaced does not lose what
 * the user typed, and a value larger than this is refused rather than truncated into
 * a half-draft.
 */
export const MAX_DRAFT_TEXT_LENGTH = 8192;

/**
 * Control characters a draft may not carry.
 *
 * Newlines and tabs are part of prose and are kept; everything else — including a
 * bare carriage return — would corrupt the message or, once restored, the prompt
 * line, so a draft containing one is refused as a whole rather than repaired.
 */
const DRAFT_CONTROL_CHARACTER = /[\u0000-\u0008\u000b-\u001f\u007f]/;

/** True for text this boundary relays as a composer draft. */
export function isDraftText(value: unknown): value is string {
	return typeof value === "string" && value.length <= MAX_DRAFT_TEXT_LENGTH && !DRAFT_CONTROL_CHARACTER.test(value);
}

/** Uncertain or refused original retained separately from the current draft. */
export interface DraftRecoveryRecord {
	text: string;
	attachments: number;
	unconfirmed: boolean;
}

/** Complete text-only content of one document handoff; never trimmed or submitted. */
export interface DraftHandoffContent {
	text: string;
	attachments: number;
	recoverable: readonly DraftRecoveryRecord[];
}

const MAX_DRAFT_RECOVERY_RECORDS = 64;

/** Validate and sanitize the entire bounded capture, including edited-away originals. */
export function parseDraftHandoffContent(value: unknown): DraftHandoffContent | null {
	if (!isRecord(value) || !isDraftText(value.text) || !isRequestId(value.attachments) || !Array.isArray(value.recoverable) || value.recoverable.length > MAX_DRAFT_RECOVERY_RECORDS) return null;
	let length = value.text.length;
	const recoverable: DraftRecoveryRecord[] = [];
	for (const entry of value.recoverable) {
		if (!isRecord(entry) || !isDraftText(entry.text) || !isRequestId(entry.attachments) || typeof entry.unconfirmed !== "boolean") return null;
		length += entry.text.length;
		if (length > MAX_DRAFT_TEXT_LENGTH) return null;
		recoverable.push({ text: entry.text, attachments: entry.attachments, unconfirmed: entry.unconfirmed });
	}
	return { text: value.text, attachments: value.attachments, recoverable };
}

/**
 * Ask the page for its unsent draft, before its document is replaced.
 *
 * Answered with {@link GuestDraftReplyMessage} under the same `requestId`, or not at
 * all when no document is listening — the asker must treat silence as "not captured"
 * rather than as an empty draft, and must not replace a document whose draft it has
 * not accounted for.
 */
export interface GuestDraftRequestMessage {
	type: "omp:draft-request";
	/** Correlation of this one handoff; an answer for another id is not this one. */
	requestId: number;
}

/**
 * The draft this page was holding, or that it held none.
 *
 * `attachments` is the count of attached files the handoff could **not** carry: the
 * bytes live in this page's memory only, so a restored document starts without them
 * and the user is told instead of finding them silently gone.
 */
export interface GuestDraftReplyMessage extends DraftHandoffContent {
	type: "omp:draft-reply";
	requestId: number;
	/** False when no complete, stable composer capture could be made. */
	captured: boolean;
}

/** Put a draft back into the composer of a document that has just been created. */
export interface GuestDraftRestoreMessage extends DraftHandoffContent {
	type: "omp:draft-restore";
	requestId: number;
}

/** Release only the matching document-local capture transaction on cancellation/refusal. */
export interface GuestDraftReleaseMessage {
	type: "omp:draft-release";
	requestId: number;
}

/** A replacement page has retained the complete capture in its composer registry. */
export interface GuestDraftRestoredMessage {
	type: "omp:draft-restored";
	requestId: number;
}

// Native terminal pane messages (ADR-0024).

/**
 * Decoded bytes one output frame may carry, before base64.
 *
 * A terminal's output is a byte stream, not text: one chunk can split a UTF-8
 * sequence or an escape sequence in half, and the renderer's own decoder
 * reassembles it across writes. So both directions carry **bytes**, base64'd, and
 * every bound below is on the decoded length — checked before anything is decoded
 * or copied.
 */
export const MAX_TERMINAL_DATA_BYTES = 64 * 1024;
/**
 * Base64 characters {@link MAX_TERMINAL_DATA_BYTES} occupies.
 *
 * `floor(bytes / 3) * 4` is the largest string whose *decoded* length cannot exceed
 * the byte budget (only whole 3-byte groups are counted, and padding only ever
 * shortens a group), so this boundary can reject an over-long payload from its
 * length alone — nothing is decoded, copied or allocated first.
 */
export const MAX_TERMINAL_DATA_BASE64_CHARS = Math.floor(MAX_TERMINAL_DATA_BYTES / 3) * 4;

/**
 * Decoded bytes one screen snapshot may carry.
 *
 * The authenticated bridge refuses a plaintext frame above 256 KiB, and the same
 * message must fit that route as well as the panel route, so the screen budget is
 * chosen to leave room for the JSON envelope (128 KiB decoded is 175 KiB encoded).
 * A host with more screen state than this sends the newest part of it.
 */
export const MAX_TERMINAL_SNAPSHOT_BYTES = 128 * 1024;
/** Base64 characters {@link MAX_TERMINAL_SNAPSHOT_BYTES} occupies, bounded as for output. */
export const MAX_TERMINAL_SNAPSHOT_BASE64_CHARS = Math.floor(MAX_TERMINAL_SNAPSHOT_BYTES / 3) * 4;

/**
 * Decoded bytes one input message may carry.
 *
 * Keystrokes are tiny; a paste is not. The pane chunks a paste into messages of
 * at most this size, in order, on one transport, and a chunk boundary may fall
 * inside a UTF-8 sequence — which is safe because the host writes the bytes to the
 * single PTY in that same order.
 */
export const MAX_TERMINAL_INPUT_BYTES = 8 * 1024;
/** Base64 characters {@link MAX_TERMINAL_INPUT_BYTES} occupies, bounded as for output. */
export const MAX_TERMINAL_INPUT_BASE64_CHARS = Math.floor(MAX_TERMINAL_INPUT_BYTES / 3) * 4;

/** Widest grid a pane may ask the host for, and the bounds the host's report must sit in. */
export const MAX_TERMINAL_COLS = 512;
export const MIN_TERMINAL_COLS = 2;
/** Tallest grid a pane may ask the host for, and the bounds the host's report must sit in. */
export const MAX_TERMINAL_ROWS = 256;
export const MIN_TERMINAL_ROWS = 1;

/** Longest session label or reason this boundary relays; display text, never a path it acts on. */
export const MAX_TERMINAL_TEXT_LENGTH = 200;
/** Longest exit signal name relayed (a POSIX name such as `SIGINT`). */
export const MAX_TERMINAL_SIGNAL_LENGTH = 32;

/**
 * The opaque generation token of one native terminal.
 *
 * The host mints it for one broker/native process generation, and the pane only
 * ever compares it: every frame carries the generation it belongs to, so output
 * from a process that has already been replaced is dropped instead of being
 * written into the screen of its successor. A pane never interprets it, and it is
 * never a credential — the pane echoes the host's own value back.
 */
export function isTerminalGeneration(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{32}$/.test(value);
}

/** What the host knows about the managed terminal right now. */
export type GuestTerminalPhase = "attached" | "stopped" | "unavailable";

/** Resolved VS Code terminal font settings; presentation only, never a capability. */
export interface TerminalFontSettings {
	readonly fontFamily: string;
	readonly fontSize: number;
	readonly lineHeight: number;
	readonly letterSpacing: number;
}

export interface GuestTerminalFontMessage extends TerminalFontSettings {
	type: "omp:terminal-font";
}

/**
 * The host's account of the terminal this pane may render.
 *
 * `seq` is the host's own output position: it is the sequence *at which* the state
 * was taken, so a pane that adopts a state reports `seq` and applies only later
 * frames. `snapshot` says whether a screen for this generation is being sent, which
 * is what lets a pane that has just attached (or just lost output) wait for a
 * consistent screen instead of writing a partial stream into an empty one.
 *
 * `input` is the host's decision, not the pane's: exactly one frontend owns input
 * and resize, and a pane that does not own them renders the host's grid, keeps its
 * screen, and stays copyable. Nothing in this message is a capability: a pane that
 * receives it gains only the right to render, and its own requests are authorized
 * separately by the host.
 */
export interface GuestTerminalStateMessage {
	type: "omp:terminal-state";
	/** Generation this state describes; a pane drops frames of any other one. */
	generation: string;
	/** The host's output sequence this state reflects. */
	seq: number;
	phase: GuestTerminalPhase;
	/** True when this document may write input and resize the PTY. */
	input: boolean;
	/** The host's authoritative grid; a pane that does not own input renders exactly this. */
	cols: number;
	rows: number;
	/** Explicit snapshot outcome; ordinary health/ownership reports use `none`. */
	snapshot: "follows" | "failed" | "none";
	/** Session or folder label for the pane header; display only. */
	sessionLabel?: string;
	/** Supplemental terminal metadata, shown only in the chrome tooltip. */
	description?: string;
	/** Why the terminal is stopped or unavailable; display only. */
	reason?: string;
}

/**
 * One screen: the bytes to write into a freshly reset renderer.
 *
 * It is bytes rather than text so a host that replays a raw stream and a host that
 * serializes a screen are the same message, and it is bounded by
 * {@link MAX_TERMINAL_SNAPSHOT_BYTES} so neither route can be made to carry an
 * unbounded screen.
 */
export interface GuestTerminalSnapshotMessage {
	type: "omp:terminal-snapshot";
	generation: string;
	/** The sequence this screen is current at; every later frame is applied after it. */
	seq: number;
	/** Base64 screen bytes. */
	bytes: string;
}

/**
 * One chunk of output.
 *
 * `seq` is dense per generation (each frame is the previous plus one), which is
 * what makes a missing chunk detectable: a pane that sees a gap shows that it
 * missed output and asks the host to re-verify it rather than pretending the
 * screen is complete.
 */
export interface GuestTerminalDataMessage {
	type: "omp:terminal-data";
	generation: string;
	seq: number;
	/** Base64 output bytes. */
	bytes: string;
}

/** The native process ended; the pane keeps its last screen and becomes copyable. */
export interface GuestTerminalExitMessage {
	type: "omp:terminal-exit";
	generation: string;
	seq: number;
	/** Process exit code, or `null` when it was signalled or never reported. */
	code: number | null;
	/** Signal name when the process was killed, else `null`. */
	signal: string | null;
}

/**
 * Ask the host to verify this document's right to this terminal and to describe
 * what it actually has.
 *
 * This is the pane's *only* re-verification request: it is sent when the pane
 * first shows, whenever the generation it holds changes, when the page's route
 * changes, and when a gap makes its screen untrustworthy. `generation` is what the
 * pane currently holds (`null` when it holds nothing), so the host can answer with
 * a snapshot only when the reply would continue the same screen — and can refuse a
 * pane whose generation is not its own.
 */
export interface GuestTerminalAttachMessage {
	type: "omp:terminal-attach";
	/** The generation this pane holds, or `null`. */
	generation: string | null;
	/** Grid the pane is asking for; the host may answer a different one. */
	cols: number;
	rows: number;
}

/** Check host liveness and stream continuity without replacing an intact screen. */
export interface GuestTerminalProbeMessage {
	type: "omp:terminal-probe";
	generation: string | null;
	seq: number;
}

/** A user-owned host clipboard request; the terminal program cannot mint one. */
export interface GuestTerminalCopyRequestMessage {
	type: "omp:terminal-copy-request";
	requestId: string;
}

export interface GuestTerminalCopyReplyMessage {
	type: "omp:terminal-copy-reply";
	requestId: string;
	generation: string | null;
	/** Null refuses a copy that cannot travel whole; never silently truncate. */
	text: string | null;
}

/** Leave room for bridge framing below its 256 KiB payload ceiling. */
export const MAX_TERMINAL_COPY_REPLY_BYTES = 240 * 1024;
export function fitsTerminalCopyReply(message: GuestTerminalCopyReplyMessage): boolean {
	return message.text === null || (message.text.length <= MAX_TERMINAL_COPY_REPLY_BYTES
		&& new TextEncoder().encode(JSON.stringify(message)).byteLength <= MAX_TERMINAL_COPY_REPLY_BYTES);
}

/** One explicit active-editor intent; unrelated view projections do not focus. */
export interface GuestTerminalActivateMessage {
	type: "omp:terminal-activate";
	token: string;
}

/**
 * Keyboard and paste input, as the exact bytes to write.
 *
 * Sentinel-free by construction: the bytes are base64, so a control character, an
 * escape sequence or a paste containing `\r\n` cannot be read as message syntax.
 * Input is never retried and never re-sent — the host either wrote it or did not.
 */
export interface GuestTerminalInputMessage {
	type: "omp:terminal-input";
	/** The generation this input belongs to; a stale generation is refused by the host. */
	generation: string;
	/** Base64 input bytes, at most {@link MAX_TERMINAL_INPUT_BYTES} decoded. */
	data: string;
}

/** Ask the host to resize the PTY; only the pane that owns input sends this. */
export interface GuestTerminalResizeMessage {
	type: "omp:terminal-resize";
	generation: string;
	cols: number;
	rows: number;
}

/**
 * Keyboard focus entered or left the terminal pane.
 *
 * The host uses it to decide which frontend owns input when more than one editor
 * shows the same terminal.
 */
export interface GuestTerminalFocusMessage {
	type: "omp:terminal-focus";
	focused: boolean;
	/** True only for an actual focus/click intent, never a replayed presence report. */
	intent: boolean;
}

/**
 * Whether the terminal pane is currently displayed in this document.
 *
 * Hidden panes do not own input, so this is the fact the host needs to decide which
 * frontend may type.
 */
export interface GuestTerminalVisibilityMessage {
	type: "omp:terminal-visibility";
	visible: boolean;
}

export type SessionViewMode = "chat" | "terminal";
export interface GuestSessionViewMessage {
	type: "omp:session-view";
	mode: SessionViewMode;
	running: boolean;
	starting: boolean;
	stopping: boolean;
	canSwitch: boolean;
	title: string;
	reason: string | null;
}
export interface GuestSessionModeRequest {
	type: "omp:session-mode";
	mode: SessionViewMode;
}

export type GuestHostMessage =
	| ChatHostMessage
	| TerminalLinkValidation
	| GuestSessionViewMessage
	| GuestTerminalActivateMessage
	| GuestTerminalCopyRequestMessage
	| FooterMetadataMessage
	| GuestRouteOfferMessage
	| GuestBridgeBindMessage
	| GuestControlInvalidateMessage
	| GuestFileCompletionsMessage
	| GuestControlStateMessage
	| GuestPanelActionMessage
	| GuestInsertTextMessage
	| GuestDraftRequestMessage
	| GuestDraftRestoreMessage
	| GuestDraftReleaseMessage
	| GuestTerminalFontMessage
	| GuestTerminalStateMessage
	| GuestTerminalSnapshotMessage
	| GuestTerminalDataMessage
	| GuestTerminalExitMessage;

export interface GuestReadyMessage {
	type: "omp:ready";
	protocolVersion: number;
	/**
	 * The document ticket this page was rendered with, plus the Origin it is
	 * actually running on.
	 *
	 * This is the *only* way an Origin reaches the host: it travels the panel route
	 * from the document the host itself created, and the host pins that exact string
	 * for that ticket — never a value inferred from `cspSource` and never one learned
	 * from an unauthenticated socket. A ticket naming another document, or an origin
	 * that is not a canonical non-opaque Webview origin, is refused rather than
	 * normalised. All four fields are present together or absent together, which is
	 * what lets the host tell a bridge-capable page from an older one.
	 */
	editorId?: string;
	documentId?: string;
	bootstrapId?: string;
	origin?: string;
}

/** The page acknowledges one offered route generation. */
export interface GuestRouteAckMessage {
	type: "omp:route-ack";
	hostGeneration: string;
	documentId: string;
	routeGeneration: string;
}

/**
 * The page acknowledges the bridge secret it was handed.
 *
 * The host checks that `bindingHash` is the one it pinned for this document, so a
 * page that never received the binding (or received another) cannot claim it.
 */
export interface GuestBridgeAckMessage {
	type: "omp:bridge-ack";
	hostGeneration: string;
	documentId: string;
	/** Lowercase SHA-256 hex of the acknowledged session binding. */
	bindingHash: string;
}

/**
 * Ask the extension host for workspace paths matching the `@` token under the
 * caret. `query` is the text between `@` and the caret — never a path the host
 * is asked to read, and never proof of anything: the host answers from VS Code's
 * own workspace file index and the panel decides what to show.
 */
export interface GuestFileCompletionRequestMessage {
	type: "omp:complete-files";
	/** Monotonic per panel; replies for any other id are discarded as stale. */
	requestId: number;
	/** Bounded by {@link MAX_FILE_QUERY_LENGTH}, without control characters. */
	query: string;
}

/** What a {@link GuestControlRequestMessage} asks the host to do. */
export type GuestControlAction = "snapshot" | "set-model" | "set-thinking";

/**
 * Ask the extension host for this session's model/thinking control state, or ask
 * it to change one of them.
 *
 * The panel mints `scope` and `requestId`; both are correlation only. The
 * extension host decides whether the request may run, mints the exact-once
 * ledger id a mutation is dispatched under, and answers with
 * {@link GuestControlStateMessage} — so a lost answer is visible to the user
 * rather than retried behind their back. Action-specific fields are `picker`
 * optionally for a snapshot, `model` for set-model, or `level` for set-thinking.
 */
export interface GuestControlRequestMessage {
	type: "omp:control-request";
	/** Correlation tag of the panel asking; a non-authorizing UUID. */
	scope: string;
	/** Panel-local and monotonic; the newest request is the only live one. */
	requestId: number;
	action: GuestControlAction;
	/**
	 * Strictly increasing per *document* sequence for an irreversible change.
	 *
	 * Present on `set-model` and `set-thinking` and absent on `snapshot`. The host
	 * reserves it once per document, whichever route carried the request, and never
	 * re-reserves it — so a duplicate or replayed change cannot run twice even if a
	 * reply was lost.
	 */
	actionSeq?: string;
	/** Present for `set-model` only; provider-qualified, bounded, no control characters. */
	model?: ControlModelRef;
	/** Present for `set-thinking` only; bounded, no control characters. */
	level?: string;
	/** Snapshot only: open a native searchable picker using OMP's current catalogue. */
	picker?: "model" | "thinking";
}


/**
 * Whether the composer's `@`-completion popup is open.
 *
 * This is the page's own UI state, and it exists so one key can mean one thing: the
 * host's stop keybinding requires the popup to be closed, because a popup dismissal
 * must never abort a running turn. The host mirrors it into a context key; it is not
 * a session fact and changes nothing else.
 */
export interface GuestComposerPopupMessage {
	type: "omp:composer-popup";
	open: boolean;
}

/** What a detail tab shows: the whole TODO, the agent roster, or one agent's activity and child transcript. */
export type DetailKind = "todo" | "agents" | "agent";
/** The registry's own identity bound (`src/chat/agents.ts`); the host never resolves it as a path. */
export const MAX_DETAIL_AGENT_ID_LENGTH = 256;
/** A UTF-16 half without its pair: not encodable into the detail document's meta, so never a valid id. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Ask the host to open, or reveal, the detail tab of the conversation this editor shows.
 *
 * Presentation only and no authority: the conversation is resolved from the sending editor, never
 * from this message, and an agent id is only ever looked up in the native registry's own ids.
 */
export type GuestOpenDetailMessage =
	| { type: "omp:open-detail"; kind: "todo" | "agents" }
	| { type: "omp:open-detail"; kind: "agent"; agentId: string };

/** `StopReason` of the newest assistant reply, as the wire package defines it. */
export type GuestTurnOutcome = "stop" | "length" | "toolUse" | "error" | "aborted";


export type GuestWebviewMessage =
	| ChatWebviewMessage
	| TerminalLinkRequest
	| GuestSessionModeRequest
	| GuestReadyMessage
	| GuestRouteAckMessage
	| GuestBridgeAckMessage
	| GuestFileCompletionRequestMessage
	| GuestControlRequestMessage
	| GuestComposerPopupMessage
	| GuestTerminalAttachMessage
	| GuestTerminalProbeMessage
	| GuestTerminalCopyReplyMessage
	| GuestTerminalInputMessage
	| GuestTerminalResizeMessage
	| GuestTerminalFocusMessage
	| GuestTerminalVisibilityMessage
	| GuestDraftReplyMessage
	| GuestDraftRestoredMessage
	| GuestOpenDetailMessage;


/**
 * Text this boundary relays as-is: `max` characters, no control characters.
 * Empty is allowed — a config value or a source label may legitimately be empty.
 */
function isBoundedText(value: unknown, max: number): value is string {
	return typeof value === "string" && value.length <= max && isSafeBoundaryText(value);
}

/** As {@link isBoundedText}, but an empty value means "nothing to say" and is refused. */
function isNamedBoundaryText(value: unknown, max: number): value is string {
	return isBoundedText(value, max) && value.length > 0;
}


/** A provider-qualified model reference, or `null` when it is not one this panel may act on. */
function parseModelRef(value: unknown): ControlModelRef | null {
	if (!isRecord(value)) return null;
	if (!isNamedBoundaryText(value.provider, MAX_CONTROL_TEXT_LENGTH)) return null;
	if (!isNamedBoundaryText(value.id, MAX_CONTROL_TEXT_LENGTH)) return null;
	const name = value.name === undefined ? undefined : isNamedBoundaryText(value.name, MAX_CONTROL_TEXT_LENGTH) ? value.name : null;
	if (name === null) return null;
	return { provider: value.provider, id: value.id, ...(name === undefined ? {} : { name }) };
}


/** Parse an untrusted `omp:control-state` report; `null` when it may not be shown. */
function parseControlState(value: Record<string, unknown>): GuestControlStateMessage | null {
	// A report without the requesting panel's scope and newest id answers a
	// question this panel did not ask, so it is not parsed at all.
	if (!isControlScope(value.scope) || !isRequestId(value.requestId)) return null;
	if (typeof value.available !== "boolean") return null;
	const mutationMode =
		value.mutationMode === "best-effort" || value.mutationMode === "unavailable" ? value.mutationMode : null;
	if (mutationMode === null) return null;

	const model = value.model === null ? null : parseModelRef(value.model);
	if (model === null && value.model !== null) return null;
	const thinkingLevel =
		value.thinkingLevel === null
			? null
			: isNamedBoundaryText(value.thinkingLevel, MAX_THINKING_LEVEL_LENGTH)
				? value.thinkingLevel
				: undefined;
	if (thinkingLevel === undefined) return null;

	const selectedModel = value.selectedModel === undefined ? undefined : parseModelRef(value.selectedModel);
	if (selectedModel === null) return null;
	const selectedThinking = value.selectedThinking;
	if (selectedThinking !== undefined && !isNamedBoundaryText(selectedThinking, MAX_THINKING_LEVEL_LENGTH)) return null;
	if (selectedModel !== undefined && selectedThinking !== undefined) return null;


	const notice =
		value.notice === undefined ? undefined : isNamedBoundaryText(value.notice, MAX_CONTROL_TEXT_LENGTH) ? value.notice : null;
	if (notice === null) return null;
	const reason = value.reason === undefined ? undefined : isBoundedText(value.reason, MAX_CONTROL_TEXT_LENGTH) ? value.reason : null;
	if (reason === null) return null;

	if (!value.available) {
		// An unavailable host has nothing to read back. A report claiming both
		// would let the panel display a model as if the host had verified it, so
		// the whole report is refused.
		if (model !== null || thinkingLevel !== null || selectedModel !== undefined || selectedThinking !== undefined) return null;
		if (mutationMode !== "unavailable") return null;
		if (reason === undefined || reason.length === 0) return null;
	}

	const state: GuestControlStateMessage = {
		type: "omp:control-state",
		scope: value.scope,
		requestId: value.requestId,
		available: value.available,
		model,
		thinkingLevel,
		mutationMode,
	};
	if (notice !== undefined) state.notice = notice;
	if (reason !== undefined) state.reason = reason;
	if (selectedModel !== undefined) state.selectedModel = selectedModel;
	if (selectedThinking !== undefined) state.selectedThinking = selectedThinking as string;
	return state;
}


/** Every panel action this extension may ask a composer to run. */
const PANEL_ACTION: Record<string, GuestPanelAction> = {
	"send-prompt": "send-prompt",
	"stop-turn": "stop-turn",
	"focus-composer": "focus-composer",
};


/** Every phase a terminal report may carry. */
const TERMINAL_PHASE: Record<string, GuestTerminalPhase> = {
	attached: "attached",
	stopped: "stopped",
	unavailable: "unavailable",
};

/** A grid dimension inside the bounds this boundary relays. */
function isTerminalDimension(value: unknown, min: number, max: number): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

/** Base64 of a byte count bounded *before* anything is decoded. */
function isBoundedBase64(value: unknown, maxChars: number): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= maxChars && BOUNDARY_BASE64.test(value);
}

/** `undefined` means absent, `null` means present-but-unusable — as for raw capture. */
function optionalTerminalText(value: unknown): string | null | undefined {
	if (value === undefined || value === null) return null;
	return isBoundedText(value, MAX_TERMINAL_TEXT_LENGTH) ? value : undefined;
}

/** Validate an untrusted host→page payload; `null` when the shape is wrong. */
export function parseGuestHostMessage(value: unknown): GuestHostMessage | null {
	if (!isRecord(value) || typeof value.type !== "string") return null;
	if (value.type.startsWith("omp:chat-")) return parseChatHostMessage(value);
	if (value.type === "omp:footer-metadata") return parseFooterMetadata(value);
	if (value.type === "omp:terminal-link-validation") return parseTerminalLinkValidation(value);
	if (value.type === "omp:session-view") {
		if (Object.keys(value).some(key => !["type", "mode", "running", "starting", "stopping", "canSwitch", "title", "reason"].includes(key))) return null;
		if (value.mode !== "chat" && value.mode !== "terminal") return null;
		if (typeof value.running !== "boolean" || typeof value.starting !== "boolean" || typeof value.stopping !== "boolean" || typeof value.canSwitch !== "boolean") return null;
		if (!isBoundedText(value.title, MAX_CONTROL_TEXT_LENGTH) || (value.reason !== null && !isBoundedText(value.reason, MAX_CONTROL_TEXT_LENGTH))) return null;
		return { type: "omp:session-view", mode: value.mode, running: value.running, starting: value.starting, stopping: value.stopping, canSwitch: value.canSwitch, title: value.title, reason: value.reason };
	}
	if (value.type === "omp:terminal-activate") {
		return isBridgeToken(value.token) ? { type: "omp:terminal-activate", token: value.token } : null;
	}
	if (value.type === "omp:terminal-copy-request") {
		return isBridgeToken(value.requestId) ? { type: "omp:terminal-copy-request", requestId: value.requestId } : null;
	}
	if (value.type === "omp:route-offer") {
		const { hostGeneration, documentId, routeGeneration } = value;
		if (!isBridgeToken(hostGeneration) || !isBridgeToken(documentId) || !isBridgeToken(routeGeneration)) return null;
		const status = typeof value.status === "string" ? ROUTE_STATUS[value.status] : undefined;
		if (status === undefined) return null;
		return { type: "omp:route-offer", hostGeneration, documentId, routeGeneration, status };
	}
	if (value.type === "omp:bridge-bind") {
		const { hostGeneration, documentId, bootstrapId, editorId, tabId, origin, bindingHash } = value;
		const workspace = value.workspace;
		if (!isBridgeToken(hostGeneration) || !isBridgeToken(documentId) || !isBridgeToken(bootstrapId)) return null;
		if (!isBridgeToken(editorId) || !isBridgeHash(bindingHash)) return null;
		if (!isBridgeHash(workspace)) return null;
		if (!isPanelTabId(tabId)) return null;
		if (typeof origin !== "string" || !WEBVIEW_ORIGIN.test(origin)) return null;
		if (typeof value.path !== "string" || !value.path.startsWith("/") || value.path.length > 200) return null;
		if (typeof value.port !== "number" || !Number.isInteger(value.port) || value.port <= 0 || value.port > 65535) return null;
		// The secret is a 32-byte value in unpadded base64url (43 characters); the
		// host's own encoder is the only minter, so the shape is checked exactly.
		if (typeof value.secret !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.secret)) return null;
		return {
			type: "omp:bridge-bind",
			hostGeneration,
			documentId,
			bootstrapId,
			workspace,
			tabId,
			editorId,
			port: value.port,
			origin,
			path: value.path,
			bindingHash,
			secret: value.secret,
		};
	}
	if (value.type === "omp:control-invalidate") return { type: "omp:control-invalidate" };
	if (value.type === "omp:file-completions") {
		if (!isRequestId(value.requestId) || !Array.isArray(value.paths)) return null;
		const paths: string[] = [];
		for (const candidate of value.paths) {
			// Strict per-entry shape: the answering side is this extension, so a
			// malformed entry is a bug to surface by dropping the whole reply, not
			// something to repair into a path the user might insert.
			if (typeof candidate !== "string") return null;
			if (candidate.length === 0 || candidate.length > MAX_FILE_PATH_LENGTH) return null;
			if (!isSafeBoundaryText(candidate)) return null;
			paths.push(candidate);
		}
		// Count is truncated rather than rejected: the popup must stay bounded
		// even if a future host forgets its own limit.
		return { type: "omp:file-completions", requestId: value.requestId, paths: paths.slice(0, FILE_COMPLETION_LIMIT) };
	}
	if (value.type === "omp:control-state") return parseControlState(value);
	if (value.type === "omp:insert-text") {
		// One line only: a control character would corrupt the message and, once inserted, the
		// prompt, and a longer text is what the host's own limit already refused.
		const { text } = value;
		return typeof text === "string" && text.trim().length > 0 && text.length <= MAX_INSERT_TEXT_LENGTH && isSafeBoundaryText(text)
			? { type: "omp:insert-text", text }
			: null;
	}
	if (value.type === "omp:webview-action") {
		// Only the three actions the composer itself offers: anything else is a
		// host/guest version mismatch, and ignoring it is safer than guessing.
		const action = typeof value.action === "string" ? PANEL_ACTION[value.action] : undefined;
		return action === undefined ? null : { type: "omp:webview-action", action };
	}
	if (value.type === "omp:draft-request") {
		return isRequestId(value.requestId) ? { type: "omp:draft-request", requestId: value.requestId } : null;
	}
	if (value.type === "omp:draft-release") {
		return isRequestId(value.requestId) ? { type: "omp:draft-release", requestId: value.requestId } : null;
	}
	if (value.type === "omp:draft-restore") {
		const content = parseDraftHandoffContent(value);
		return content === null || !isRequestId(value.requestId) ? null : { type: "omp:draft-restore", requestId: value.requestId, ...content };
	}
	if (value.type === "omp:terminal-font") {
		const { fontFamily, fontSize, lineHeight, letterSpacing } = value;
		if (!isNamedBoundaryText(fontFamily, 32 * 1024)) return null;
		if (typeof fontSize !== "number" || !Number.isFinite(fontSize) || fontSize < 6 || fontSize > 100) return null;
		if (typeof lineHeight !== "number" || !Number.isFinite(lineHeight) || lineHeight < 1) return null;
		if (typeof letterSpacing !== "number" || !Number.isFinite(letterSpacing) || letterSpacing < -5 || letterSpacing > 20) return null;
		return { type: "omp:terminal-font", fontFamily, fontSize, lineHeight, letterSpacing };
	}
	if (value.type === "omp:terminal-state") {
		const { generation, seq, input, cols, rows, snapshot } = value;
		if (!isTerminalGeneration(generation) || !isRequestId(seq)) return null;
		const phase = typeof value.phase === "string" ? TERMINAL_PHASE[value.phase] : undefined;
		if (phase === undefined || typeof input !== "boolean" || (snapshot !== "follows" && snapshot !== "failed" && snapshot !== "none")) return null;
		if (!isTerminalDimension(cols, MIN_TERMINAL_COLS, MAX_TERMINAL_COLS)) return null;
		if (!isTerminalDimension(rows, MIN_TERMINAL_ROWS, MAX_TERMINAL_ROWS)) return null;
		// Both are display text, so an unusable one drops the whole state rather than
		// being repaired: a pane that showed a mangled reason would describe the
		// terminal wrongly, and the bounded phase is what a consumer acts on.
		const sessionLabel = optionalTerminalText(value.sessionLabel);
		if (sessionLabel === undefined) return null;
		const description = optionalTerminalText(value.description);
		if (description === undefined) return null;
		const reason = optionalTerminalText(value.reason);
		if (reason === undefined) return null;
		const state: GuestTerminalStateMessage = { type: "omp:terminal-state", generation, seq, phase, input, cols, rows, snapshot };
		if (sessionLabel !== null) state.sessionLabel = sessionLabel;
		if (description !== null) state.description = description;
		if (reason !== null) state.reason = reason;
		return state;
	}
	if (value.type === "omp:terminal-snapshot") {
		const { generation, seq, bytes } = value;
		if (!isTerminalGeneration(generation) || !isRequestId(seq)) return null;
		if (!isBoundedBase64(bytes, MAX_TERMINAL_SNAPSHOT_BASE64_CHARS)) return null;
		return { type: "omp:terminal-snapshot", generation, seq, bytes };
	}
	if (value.type === "omp:terminal-data") {
		const { generation, seq, bytes } = value;
		if (!isTerminalGeneration(generation) || !isRequestId(seq)) return null;
		if (!isBoundedBase64(bytes, MAX_TERMINAL_DATA_BASE64_CHARS)) return null;
		return { type: "omp:terminal-data", generation, seq, bytes };
	}
	if (value.type === "omp:terminal-exit") {
		const { generation, seq, code, signal } = value;
		if (!isTerminalGeneration(generation) || !isRequestId(seq)) return null;
		if (code !== null && (typeof code !== "number" || !Number.isSafeInteger(code) || code < 0 || code > 255)) return null;
		if (signal !== null && !isNamedBoundaryText(signal, MAX_TERMINAL_SIGNAL_LENGTH)) return null;
		return { type: "omp:terminal-exit", generation, seq, code, signal };
	}
	return null;
}

/** Validate an untrusted Webview→host message; `null` when the shape is wrong. */
export function parseGuestWebviewMessage(value: unknown): GuestWebviewMessage | null {
	if (!isRecord(value) || typeof value.type !== "string") return null;
	if (value.type.startsWith("omp:chat-")) return parseChatWebviewMessage(value);
	if (value.type === "omp:terminal-link-validate" || value.type === "omp:terminal-link-open") return parseTerminalLinkRequest(value);
	switch (value.type) {
		case "omp:session-mode":
			if (Object.keys(value).length !== 2 || (value.mode !== "chat" && value.mode !== "terminal")) return null;
			return { type: "omp:session-mode", mode: value.mode };
		case "omp:open-detail": {
			if (value.kind === "agent") {
				if (Object.keys(value).length !== 3 || !isNamedBoundaryText(value.agentId, MAX_DETAIL_AGENT_ID_LENGTH) || LONE_SURROGATE.test(value.agentId)) return null;
				return { type: "omp:open-detail", kind: "agent", agentId: value.agentId };
			}
			if (Object.keys(value).length !== 2 || (value.kind !== "todo" && value.kind !== "agents")) return null;
			return { type: "omp:open-detail", kind: value.kind };
		}
		case "omp:ready": {
			if (typeof value.protocolVersion !== "number") return null;
			// The document ticket and its origin travel together: a page either knows
			// all four or none, and the host pins nothing from a partial report.
			const ticket = [value.editorId, value.documentId, value.bootstrapId];
			if (ticket.every(field => field === undefined)) return { type: "omp:ready", protocolVersion: value.protocolVersion };
			if (!ticket.every(field => isBridgeToken(field))) return null;
			if (typeof value.origin !== "string" || !WEBVIEW_ORIGIN.test(value.origin)) return null;
			return {
				type: "omp:ready",
				protocolVersion: value.protocolVersion,
				editorId: String(value.editorId),
				documentId: String(value.documentId),
				bootstrapId: String(value.bootstrapId),
				origin: value.origin,
			};
		}
		case "omp:route-ack": {
			const { hostGeneration, documentId, routeGeneration } = value;
			if (!isBridgeToken(hostGeneration) || !isBridgeToken(documentId) || !isBridgeToken(routeGeneration)) return null;
			return { type: "omp:route-ack", hostGeneration, documentId, routeGeneration };
		}
		case "omp:bridge-ack": {
			const { hostGeneration, documentId, bindingHash } = value;
			if (!isBridgeToken(hostGeneration) || !isBridgeToken(documentId) || !isBridgeHash(bindingHash)) return null;
			return { type: "omp:bridge-ack", hostGeneration, documentId, bindingHash };
		}
		case "omp:complete-files": {
			if (!isRequestId(value.requestId) || typeof value.query !== "string") return null;
			if (value.query.length > MAX_FILE_QUERY_LENGTH || !isSafeBoundaryText(value.query)) return null;
			return { type: "omp:complete-files", requestId: value.requestId, query: value.query };
		}
		case "omp:control-request": {
			// Neither field authorizes anything: the scope only tells a later report
			// which panel mount it belongs to, and the extension host keeps its own
			// exact-once ledger id for whatever it decides to run.
			if (!isControlScope(value.scope) || !isRequestId(value.requestId)) return null;
			const scope = value.scope;
			const requestId = value.requestId;
			// A mutation carries the document's own strictly increasing sequence; a
			// read carries none, because a read reserves nothing.
			const actionSeq = typeof value.actionSeq === "string" ? value.actionSeq : undefined;
			if (actionSeq !== undefined && !/^(0|[1-9][0-9]{0,19})$/.test(actionSeq)) return null;
			switch (value.action) {
				case "snapshot":
					// A read has nothing to change, so it may carry neither field.
					if (value.model !== undefined || value.level !== undefined) return null;
					if (actionSeq !== undefined) return null;
					if (value.picker !== undefined && value.picker !== "model" && value.picker !== "thinking") return null;
					return { type: "omp:control-request", scope, requestId, action: "snapshot",
						...(value.picker === undefined ? {} : { picker: value.picker }) };
				case "set-model": {
					if (value.picker !== undefined) return null;
					const model = parseModelRef(value.model);
					if (model === null || value.level !== undefined || actionSeq === undefined) return null;
					return { type: "omp:control-request", scope, requestId, action: "set-model", model, actionSeq };
				}
				case "set-thinking": {
					if (value.picker !== undefined) return null;
					if (!isNamedBoundaryText(value.level, MAX_THINKING_LEVEL_LENGTH) || value.model !== undefined || actionSeq === undefined) return null;
					return { type: "omp:control-request", scope, requestId, action: "set-thinking", level: value.level, actionSeq };
				}
				default:
					return null;
			}
		}
		case "omp:composer-popup": {
			if (typeof value.open !== "boolean") return null;
			return { type: "omp:composer-popup", open: value.open };
		}
		case "omp:terminal-attach": {
			const { generation, cols, rows } = value;
			// `null` is the pane saying it holds no generation; anything else must be one
			// the host could have minted, so a pane cannot ask about someone else's.
			if (generation !== null && !isTerminalGeneration(generation)) return null;
			if (!isTerminalDimension(cols, MIN_TERMINAL_COLS, MAX_TERMINAL_COLS)) return null;
			if (!isTerminalDimension(rows, MIN_TERMINAL_ROWS, MAX_TERMINAL_ROWS)) return null;
			return { type: "omp:terminal-attach", generation, cols, rows };
		}
		case "omp:terminal-probe": {
			const { generation, seq } = value;
			if (generation !== null && !isTerminalGeneration(generation)) return null;
			if (!isRequestId(seq)) return null;
			return { type: "omp:terminal-probe", generation, seq };
		}
		case "omp:terminal-input": {
			const { generation, data } = value;
			if (!isTerminalGeneration(generation)) return null;
			if (!isBoundedBase64(data, MAX_TERMINAL_INPUT_BASE64_CHARS)) return null;
			return { type: "omp:terminal-input", generation, data };
		}
		case "omp:terminal-resize": {
			const { generation, cols, rows } = value;
			if (!isTerminalGeneration(generation)) return null;
			if (!isTerminalDimension(cols, MIN_TERMINAL_COLS, MAX_TERMINAL_COLS)) return null;
			if (!isTerminalDimension(rows, MIN_TERMINAL_ROWS, MAX_TERMINAL_ROWS)) return null;
			return { type: "omp:terminal-resize", generation, cols, rows };
		}
		case "omp:terminal-focus": {
			if (typeof value.focused !== "boolean" || typeof value.intent !== "boolean" || (value.intent && !value.focused)) return null;
			return { type: "omp:terminal-focus", focused: value.focused, intent: value.intent };
		}
		case "omp:terminal-visibility": {
			if (typeof value.visible !== "boolean") return null;
			return { type: "omp:terminal-visibility", visible: value.visible };
		}
		case "omp:terminal-copy-reply": {
			const { requestId, generation, text } = value;
			if (!isBridgeToken(requestId) || (generation !== null && !isTerminalGeneration(generation))) return null;
			if (text !== null && typeof text !== "string") return null;
			const reply: GuestTerminalCopyReplyMessage = { type: "omp:terminal-copy-reply", requestId, generation, text };
			return fitsTerminalCopyReply(reply) ? reply : null;
		}
		case "omp:draft-restored":
			return isRequestId(value.requestId) ? { type: "omp:draft-restored", requestId: value.requestId } : null;
		case "omp:draft-reply": {
			// The draft travels back exactly as it was typed, bounded and without control
			// characters (newlines and tabs excepted): a reply this boundary cannot carry
			// whole is refused, so the asker reports an unaccounted draft instead of
			// replacing a document with part of one.
			if (!isRequestId(value.requestId) || typeof value.captured !== "boolean") return null;
			const content = parseDraftHandoffContent(value);
			return content === null ? null : { type: "omp:draft-reply", requestId: value.requestId, captured: value.captured, ...content };
		}
		default:
			return null;
	}
}

/**
 * Standard base64 (RFC 4648, padded), the byte encoding this boundary carries.
 *
 * It is checked by shape and by encoded length before a payload is decoded or
 * copied, for terminal output, screen snapshots and input alike.
 */
const BOUNDARY_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Ids are dense non-negative integers this panel hands out; anything else is not ours. */
function isRequestId(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * The mention grammar is OMP's, not this panel's:
 * `FILE_MENTION_REGEX = /@(?:"([^"]+)"|'([^']+)'|([^\s@]+))/g` with the token
 * boundary `/[\s([{<"'`]/` in `pi-coding-agent src/utils/file-mentions.ts`.
 * A path inserted here must parse back to exactly itself when the host reads
 * the submitted prompt, so both directions live in one place:
 * {@link mentionQueryAt} decides what may be asked from the draft,
 * {@link mentionTokenForPath} decides what may be inserted.
 */

/** A token starts at the text start or after whitespace or an opening quote/bracket. */
const MENTION_BOUNDARY = /[\s([{<"'`]/;

/**
 * Unquoted `@path` cannot carry whitespace or `@`, and the host strips edge
 * punctuation from that form — so anything unusual has to use the quoted form,
 * which the same grammar takes verbatim.
 */
const MENTION_NEEDS_QUOTES = /[\s@"'`]|^[`"'([{<]|[)\]}>.,;:!?"'`]$/;

/**
 * The `@` token containing `caret`, or `null` when the caret is not inside one.
 *
 * Only the unquoted form is completed: once a path is chosen this module inserts
 * the quoted form itself, and a query containing a quote is text the user typed
 * (so `@"my notes` is prose, not a half-typed mention).
 */
export function mentionQueryAt(text: string, caret: number): { start: number; query: string } | null {
	if (caret < 0 || caret > text.length) return null;
	let index = caret - 1;
	while (index >= 0 && text[index] !== "@") {
		// The unquoted body ends at whitespace, so a caret after one is not in a token.
		if (/\s/.test(text[index] as string)) return null;
		index--;
	}
	if (index < 0 || !(index === 0 || MENTION_BOUNDARY.test(text[index - 1] as string))) return null;
	const query = text.slice(index + 1, caret);
	if (query.length > MAX_FILE_QUERY_LENGTH || !isSafeBoundaryText(query)) return null;
	return { start: index, query };
}

/**
 * The prompt token for `path`, quoted when the bare form would not parse back to
 * it. Double quotes are the readable default; a path that itself contains one
 * falls back to single quotes, and a path containing both quote kinds has no
 * representation in the grammar at all (the mention then parses as prose rather
 * than as a wrong path — visible, not silently wrong).
 */
export function mentionTokenForPath(path: string): string {
	if (!MENTION_NEEDS_QUOTES.test(path)) return `@${path}`;
	return path.includes('"') && !path.includes("'") ? `@'${path}'` : `@"${path}"`;
}

/**
 * Replace the `@` token spanning `start`…`caret` with the chosen `path` and
 * return the new draft plus the caret that follows the insertion.
 *
 * Only that range changes: everything before it and after it survives verbatim,
 * which is what keeps an accepted suggestion from costing the user the rest of
 * their prompt. The attachment draft is separate state and is not touched here at
 * all.
 */
export function spliceMention(
	text: string,
	caret: number,
	start: number,
	path: string,
): { text: string; caret: number } {
	const inserted = `${mentionTokenForPath(path)} `;
	return { text: `${text.slice(0, start)}${inserted}${text.slice(caret)}`, caret: start + inserted.length };
}
