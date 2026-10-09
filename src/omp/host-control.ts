/**
 * Native-side host control for
 * [ADR-0003](../../docs/decisions/0003-native-host-control-pipe.md), extended for
 * native lifecycle by [ADR-0040](../../docs/decisions/0040-switch-one-editor-between-rpc-chat-and-native-pty.md).
 *
 * This file is bundled standalone (`out/omp-host-control.mjs`, ESM, node
 * platform) and loaded into each managed native or rpc-ui OMP child with `-e`.
 * The recipient literal rides Bun's `--define`/`--preload`, which work in either mode.
 * It owns the named pipe (POSIX socket off Windows),
 * authenticates the client before disclosing anything reusable, answers
 * `snapshot`, publishes only non-secret discovery metadata into the
 * launcher's rendezvous directory, and hosts the consented file-evidence hooks.
 * In an rpc-ui child it also registers Chat's internal `omp-desk-navigate`
 * command (ADR-0051, `navigate-command.ts`), which arrives over RPC stdin and
 * never over this pipe, and publishes the subagent liveness signal the Agents
 * row merges with OMP's RPC roster (ADR-0053, `agent-liveness.ts`) through that
 * session's own `setStatus`, never over this pipe.
 *
 * RPC model/thinking/name commands remain on the session's RPC pipe. This channel
 * adds only bounded native state and target-guarded public-SDK shutdown/name operations.
 * Native session-switch callbacks are hints, not settled witnesses. Shutdown is
 * irreversible and may be deferred; its signed acknowledgement is sent before commitment.
 *
 * Three properties this file must never break:
 *
 * 1. **The control key never leaves this process in the clear.** It is generated
 *    here (256 bits), sealed to the launch's public recipient with
 *    RSA-OAEP-SHA256, and used only as an HMAC key: what travels is the
 *    ciphertext in the rendezvous, never the plaintext. The recipient is a Bun
 *    `--define` literal pinned through `--preload`, so no key travels in argv,
 *    the environment, stdin, logs or child environments (ADR-0006). A launch
 *    without a usable recipient serves nothing rather than falling back to an
 *    unencrypted channel.
 * 2. **Native lifecycle mutations are target-guarded.** Shutdown and rename
 *    require an authenticated current epoch/session; other control reads stay read-only.
 * 3. **A session identity that could not be read is not a new session.** Every
 *    observation states whether the session identity was read at all; a failed
 *    or unrecognised read reports no session file *and* the gap that says so.
 *    Only a read that succeeded may mean "this session has no file yet", so a
 *    caller's unsaved-session expectation can never be satisfied by a host that
 *    cannot name the session it is serving
 *    ([ADR-0011](../../docs/decisions/0011-use-installed-omp-without-version-gate.md), invariant F1).
 *
 * Any value this file sends to the client is either a bounded name, count or
 * code, or text this repository authored. An exception message from inside OMP
 * is never forwarded: it can quote a path, a URL or a provider response, so a
 * failed read or call is reported with a fixed reason and its code instead.
 */

import { closeSync, openSync, readSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { clearTimeout as clearNodeTimeout, setTimeout as setNodeTimeout } from "node:timers";
import {
	CONTROL_DIR_ENV,
	CONTROL_MAX_FRAME_BYTES,
	CONTROL_MAX_RENDEZVOUS_BYTES,
	CONTROL_MAX_TOOL_NAME_CHARS,
	CONTROL_MAX_TOOLS,
	CONTROL_PIPE_NAME_RE,
	CONTROL_PROTOCOL_VERSION,
	CONTROL_RECIPIENT_DEFINE,
	CONTROL_SERVICE,
	CONTROL_SLOT_ENV,
	type ControlErrorCode,
	type ControlHostBinding,
	type ControlHostSnapshot,
	type ControlMethod,
	type ControlRendezvous,
	type ControlRequestFrame,
	type ControlResult,
	type ControlToolList,
	type ControlNativeState,
	type ControlNativeActivity,
	type ControlNativeWork,
	type ControlNativeTarget,
	type ControlNativeShutdownStatus,
	type ControlNativeRenameStatus,
	controlDigest,
	controlEndpoint,
	controlErrorMac,
	controlHandshakeMac,
	controlPipeName,
	controlRecipientFingerprint,
	controlResponseDigest,
	controlResponseMac,
	controlRendezvousPath,
	createControlEpoch,
	createControlInstanceId,
	createControlKey,
	createControlNonce,
	encodeControlFrame,
	encryptControlKeyToRecipient,
	isControlRecipientSpki,
	isControlSlotId,
	isControlToolName,
	parseControlClientFrame,
	readControlRecipientPublicKey,
	removeOwnControlRendezvous,
	verifyControlRequestMac,
	writeControlRendezvous,
} from "../host/control-protocol.ts";
import { NativeActivityJournal, NATIVE_ACTIVITY_HOOKS, type NativeActivityHook } from "../host/native-activity.ts";
import { fileEvidenceStoreRoot } from "../host/file-evidence-reader.ts";
import type { NativeFileObservationStorageProbe } from "../host/native-file-observation-storage.ts";
import { createFileEvidenceHooks, createFileEvidenceObserver } from "./file-evidence.ts";
import { registerNavigateCommand, type NavigateCommandApi } from "./navigate-command.ts";
import { isLiveSubagentRef, registerAgentLiveness, stopAgentLiveness, type OmpAgentRegistry } from "./agent-liveness.ts";
import { registerChatPrompt } from "./chat-prompt.ts";
import type { FileEvidenceOmpHooks, FileEvidenceStatus } from "./file-evidence.ts";

// OMP extension surface (declared structurally)

/**
 * The installed OMP is not a compile-time dependency of this repository, so the
 * surface this extension uses is declared structurally instead of imported: the
 * bundle must run inside the OMP process and must not resolve OMP packages.
 * Each shape follows the upstream pi-coding-agent source:
 *
 * - factory shape: `src/extensibility/extensions/types.ts` (`ExtensionFactory`);
 *   module import and selection: `src/extensibility/extensions/loader.ts`.
 * - session identity: `ReadonlySessionManager.getSessionFile/getSessionId/getCwd`,
 *   `src/session/session-manager.ts`.
 * - cancellable transition hooks: `types.ts` (`session_before_switch/branch/tree`).
 */
export interface OmpSessionManager {
	getSessionFile(): string | null | undefined;
	getSessionId(): string | null | undefined;
	getCwd?(): string;
	getSessionName?(): string | undefined;
	getEntries?(): readonly { readonly type?: unknown; readonly message?: { readonly role?: unknown } }[];
}

export interface OmpExtensionContext {
	readonly sessionManager: OmpSessionManager;
	readonly mode?: string;
	readonly agent?: { readonly kind?: string };
	isIdle?(): boolean;
	hasPendingMessages?(): boolean;
	getAsyncJobSnapshot?(): {
		readonly running: readonly unknown[];
		readonly delivery: { readonly queued: number; readonly delivering: boolean; readonly pendingJobIds: readonly string[] };
	} | null;
	abort?(): void;
	shutdown?(): void;
}

export interface OmpLogger {
	warn?(message: string): void;
	error?(message: string): void;
}

/** Only names are read from the SDK's full tool records. */
export interface OmpToolInfo {
	readonly name?: unknown;
}

export interface OmpExtensionAPI {
	on(event: string, handler: (event: unknown, ctx: OmpExtensionContext) => unknown): void;
	getActiveTools(): string[];
	getAllTools(): OmpToolInfo[];
	setSessionName?(name: string): void;
	/** Command registration and custom entries, used only by the RPC-mode navigation command (ADR-0051). */
	registerCommand?: NavigateCommandApi["registerCommand"];
	appendEntry?: NavigateCommandApi["appendEntry"];
	readonly logger?: OmpLogger;
	/**
	 * The injected SDK namespace (`pi.pi`), declared only where this file reads
	 * it. `VERSION` is the release string; there is no lowercase `version`.
	 * `AgentRegistry` is the process-global agent registry the SDK re-exports
	 * (`src/sdk.ts`, `src/registry/agent-registry.ts`): every subagent, however it
	 * was started (a `task` call, or revived from `parked` by an IRC message), has a
	 * ref there, and only some of them are async jobs of the parent.
	 */
	readonly pi?: { readonly VERSION?: unknown; readonly AgentRegistry?: { global?(): OmpAgentRegistry } };
}

/**
 * Whether any subagent of this process is doing work the main session is waiting on, by the
 * shared derivation {@link isLiveSubagentRef} (`subagentLiveState`, ADR-0053): running (not a
 * stale accepted run), idle with messages queued, or idle while its session streams with new
 * work its own binding observed after it left running. An absent or throwing registry (an older
 * OMP) counts nothing.
 */
export function hasLiveSubagents(pi: OmpExtensionAPI): boolean {
	try {
		const refs = pi.pi?.AgentRegistry?.global?.()?.list?.();
		return Array.isArray(refs) && refs.some(isLiveSubagentRef);
	} catch {
		return false;
	}
}

export type OmpExtensionFactory = (pi: OmpExtensionAPI) => void | Promise<void>;

// Errors

/** The host cannot serve the channel because a capability or launch input is absent. */
export class HostControlUnsupportedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "HostControlUnsupportedError";
	}
}

// Adapter contract

/** Host facts read for one request; each field is independently fallible. */
export interface HostControlFacts {
	/**
	 * Canonical session file, or `null` when a read that succeeded says this
	 * session has no file yet. Only {@link sessionIdentityKnown} makes either
	 * reading authoritative.
	 */
	readonly sessionFile: string | null;
	/**
	 * Whether the session identity was read at all for this observation.
	 *
	 * `false` means the host could not read it — the session API threw, is
	 * absent on this build, or answered in a shape this build does not know — so
	 * `sessionFile` says nothing about the session. That is not the same
	 * condition as a successfully read `null`, which is what an unmaterialised
	 * session reports, and the two must never be conflated
	 * ([ADR-0011](../../docs/decisions/0011-use-installed-omp-without-version-gate.md), invariant F1).
	 */
	readonly sessionIdentityKnown: boolean;
	/** Bounded notes naming what could not be read; never a guess. */
	readonly readGaps: readonly string[];
}

export interface HostControlAdapter {
	/** Installed OMP release, or null when it cannot be read. */
	describeVersion(): string | null;
	/** Native process directory; immutable for the process, valid before any session. */
	readonly cwd: string;
	/**
	 * Read the current host facts. An adapter that cannot read the session
	 * identity must report `sessionIdentityKnown: false` instead of a bare
	 * `sessionFile: null`, because the channel treats the two as different
	 * states: only a read that succeeded may stand for a session with no file yet.
	 */
	readFacts(): Promise<HostControlFacts>;
	listTools(): Promise<ControlToolList>;
	nativeState?(includeContent: boolean): ControlNativeState;
	nativeActivity?(epoch: string, includeWork?: boolean): ControlNativeActivity;
	nativeShutdown?(target: ControlNativeTarget, consent: boolean): { readonly status: ControlNativeShutdownStatus; readonly commit?: () => void };
	nativeRename?(target: ControlNativeTarget, name: string): ControlNativeRenameStatus;
	/** Works in every mode: the registry is process-global, so an rpc-ui chat child answers it too. */
	subagentWork?(): boolean;
}

// Server

const HANDSHAKE_TIMEOUT_MS = 5_000;
const MAX_CONNECTIONS = 8;
const SEEN_NONCE_LIMIT = 256;
const MAX_READ_GAPS = 8;
const MAX_MESSAGE_LENGTH = 512;

/**
 * `readGaps` entry that must accompany an observation whose session identity
 * could not be read. It is placed first so a bounded gap list cannot drop it,
 * and it states the condition rather than the value: the host is not saying the
 * session has no file, it is saying it cannot tell.
 */
export const SESSION_IDENTITY_UNREADABLE = "the host could not read which session it is serving";

/** Counts, method names and codes only: never payloads, paths or key material. */
export type HostControlEvent =
	| { readonly kind: "listening" }
	| { readonly kind: "published" }
	| { readonly kind: "connection"; readonly connections: number }
	| { readonly kind: "handshake-rejected"; readonly code: ControlErrorCode }
	| {
			readonly kind: "request";
			readonly method: ControlMethod;
			readonly outcome: "ok" | "refused";
			readonly code?: ControlErrorCode;
	  }
	| { readonly kind: "session-transition" }
	| { readonly kind: "stopped"; readonly reason: string }
	| { readonly kind: "warning"; readonly message: string };

export interface HostControlServerOptions {
	readonly adapter: HostControlAdapter;
	/**
	 * Public recipient key (base64url DER SPKI) pinned into this launch by Bun's
	 * `--define`. The engine generates the control key itself and seals it to this
	 * recipient; the plaintext key never leaves the process.
	 */
	readonly recipientPublicKey: string;
	readonly slotId: string;
	readonly pipeName: string;
	readonly endpoint: string;
	readonly rendezvousDirectory: string;
	readonly maxConnections?: number;
	readonly now?: () => number;
	readonly onEvent?: (event: HostControlEvent) => void;
}

export interface HostControlServer {
	readonly endpoint: string;
	readonly pipeName: string;
	readonly instanceId: string;
	readonly rendezvousPath: string;
	/** The binding this host would report right now (current session file and epoch). */
	identity(): ControlHostBinding;
	/**
	 * Report that a native session transition (new, switch, fork, branch or tree)
	 * is beginning. Mints a new session generation (`epoch`), so a client that
	 * pinned the previous one can tell that the session it verified may no longer
	 * be the one this process serves.
	 *
	 * Observation only: it never cancels and never delays the transition.
	 */
	noteSessionTransition(): void;
	stop(reason?: string): Promise<void>;
	readonly closed: Promise<void>;
}

type RequestOutcome =
	| { readonly kind: "result"; readonly result: ControlResult; readonly afterSend?: () => void }
	| { readonly kind: "refusal"; readonly code: ControlErrorCode; readonly message: string };

interface ControlConnection {
	readonly socket: Socket;
	authenticated: boolean;
	/** First signed request proved the client knows the host-generated key. */
	provenClient: boolean;
	clientNonce: string;
	serverNonce: string;
	binding: ControlHostBinding | null;
	buffer: Buffer;
	queue: Promise<void>;
	closed: boolean;
}

function textOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Start the per-process control listener and publish its rendezvous. */
export async function startHostControlServer(
	options: HostControlServerOptions,
): Promise<HostControlServer> {
	const { adapter, recipientPublicKey, slotId, pipeName, endpoint } = options;
	const now = options.now ?? ((): number => Date.now());
	const maxConnections = options.maxConnections ?? MAX_CONNECTIONS;
	/** Generated here, sealed to the launch recipient below, never logged or sent. */
	const key = createControlKey();
	const emit = (event: HostControlEvent): void => {
		try {
			options.onEvent?.(event);
		} catch {
			// A diagnostic callback never breaks the channel.
		}
	};

	if (!isControlRecipientSpki(recipientPublicKey)) {
		throw new HostControlUnsupportedError("launch recipient public key is missing or unusable");
	}
	if (!isControlSlotId(slotId)) {
		throw new HostControlUnsupportedError("control slot id is missing or malformed");
	}
	if (!CONTROL_PIPE_NAME_RE.test(pipeName)) {
		throw new HostControlUnsupportedError("control pipe name is malformed");
	}
	if (adapter.cwd.length === 0) {
		throw new HostControlUnsupportedError("native process directory is unknown");
	}

	const instanceId = createControlInstanceId();
	const pid = process.pid;
	const ompVersion = adapter.describeVersion();

	let epoch = createControlEpoch();
	let observedSessionFile: string | null = null;

	const connections = new Set<ControlConnection>();
	const seenNonces = new Set<string>();

	const hostBinding = (): ControlHostBinding => ({
		slotId,
		endpoint,
		pipeName,
		instanceId,
		epoch,
		pid,
		sessionFile: observedSessionFile,
		cwd: adapter.cwd,
		ompVersion,
	});

	/**
	 * Bound one observation and make its identity state unambiguous. An identity
	 * that was not read carries no session file — an unproven value must not be
	 * able to satisfy a caller's pin — and always carries
	 * {@link SESSION_IDENTITY_UNREADABLE} first in a bounded gap list, so no
	 * report can present the unknown state as a session that was found to be new
	 * (ADR-0011 invariant F1).
	 */
	function boundFacts(facts: HostControlFacts): HostControlFacts {
		if (facts.sessionIdentityKnown) {
			return { ...facts, readGaps: facts.readGaps.slice(0, MAX_READ_GAPS) };
		}
		const named = facts.readGaps.filter(gap => gap !== SESSION_IDENTITY_UNREADABLE);
		return {
			...facts,
			sessionFile: null,
			readGaps: [SESSION_IDENTITY_UNREADABLE, ...named].slice(0, MAX_READ_GAPS),
		};
	}

	async function readFactsSafely(): Promise<HostControlFacts> {
		try {
			return boundFacts(await adapter.readFacts());
		} catch {
			// The exception message could quote a path, a URL or a provider
			// response, so only the fact that the read failed is reported. Nothing
			// was read, so the identity is unknown rather than absent.
			return boundFacts({
				sessionFile: null,
				sessionIdentityKnown: false,
				readGaps: ["host facts could not be read"],
			});
		}
	}

	/** Read the host and remember its session file, so every response names the current one. */
	async function observe(): Promise<HostControlFacts> {
		const facts = await readFactsSafely();
		observedSessionFile = facts.sessionFile;
		return facts;
	}

	async function readToolListSafely(): Promise<ControlToolList> {
		try {
			return await adapter.listTools();
		} catch {
			return { available: false, all: [], active: [], unavailableReason: "the host could not read its tool catalogue" };
		}
	}


	// Request handling

	async function handleRequest(frame: ControlRequestFrame): Promise<RequestOutcome> {
		// Every answer names the session file as read *now*, not as last observed.
		const facts = await observe();
		switch (frame.method) {
			case "snapshot": {
				const snapshot: ControlHostSnapshot = {
					host: hostBinding(),
					readGaps: facts.readGaps,
				};
				return { kind: "result", result: { kind: "snapshot", snapshot } };
			}
			case "listTools":
				return { kind: "result", result: { kind: "listTools", list: await readToolListSafely() } };
			case "nativeState": {
				const state = adapter.nativeState?.(frame.payload.kind === "nativeState" && frame.payload.includeContent)
					?? unavailableNativeState("this host does not support native state");
				observedSessionFile = state.sessionFile;
				return { kind: "result", result: { kind: "nativeState", state } };
			}
			case "nativeActivity": {
				if (adapter.nativeActivity === undefined) return { kind: "refusal", code: "unknown-method", message: "unsupported method" };
				const activity = adapter.nativeActivity(epoch, frame.payload.kind === "nativeActivity" && frame.payload.work === true);
				observedSessionFile = activity.state.sessionFile;
				return { kind: "result", result: { kind: "nativeActivity", activity } };
			}
			case "subagentWork": {
				if (adapter.subagentWork === undefined) return { kind: "refusal", code: "unknown-method", message: "unsupported method" };
				return { kind: "result", result: { kind: "subagentWork", active: adapter.subagentWork() } };
			}
			default:
				return { kind: "refusal", code: "unknown-method", message: "unsupported method" };
		}
	}

	/** No await between target validation, acknowledgement and native action. */
	function handleNativeAction(frame: ControlRequestFrame): RequestOutcome {
		const payload = frame.payload;
		if (payload.kind === "nativeShutdown") {
			if (payload.target.epoch !== epoch) return { kind: "result", result: { kind: payload.kind, status: "target-changed" } };
			const action = adapter.nativeShutdown?.(payload.target, payload.consent) ?? { status: "unsupported" as const };
			return { kind: "result", result: { kind: payload.kind, status: action.status }, ...(action.commit ? { afterSend: action.commit } : {}) };
		}
		if (payload.kind === "nativeRename") {
			const status = payload.target.epoch !== epoch ? "target-changed" : adapter.nativeRename?.(payload.target, payload.name) ?? "unsupported";
			return { kind: "result", result: { kind: payload.kind, status } };
		}
		return { kind: "refusal", code: "bad-payload", message: "unsupported native action" };
	}

	// Framing

	function send(connection: ControlConnection, payload: string): void {
		if (connection.closed) return;
		try {
			connection.socket.write(payload);
		} catch {
			connection.closed = true;
			connection.socket.destroy();
		}
	}

	function sendError(
		connection: ControlConnection,
		code: ControlErrorCode,
		message: string,
		requestId: string | null,
		phase: "handshake" | "request",
	): void {
		const bound = connection.authenticated;
		send(
			connection,
			encodeControlFrame({
				v: CONTROL_PROTOCOL_VERSION,
				kind: "error",
				code,
				requestId,
				message: message.slice(0, MAX_MESSAGE_LENGTH),
				host: bound ? hostBinding() : null,
				mac: bound
					? controlErrorMac(key, {
							clientNonce: connection.clientNonce,
							serverNonce: connection.serverNonce,
							requestId,
							code,
						})
					: null,
			}),
		);
		if (phase === "handshake") emit({ kind: "handshake-rejected", code });
	}

	function sendResult(connection: ControlConnection, requestId: string, result: ControlResult): void {
		const host = hostBinding();
		const digest = controlResponseDigest(result, host);
		send(
			connection,
			encodeControlFrame({
				v: CONTROL_PROTOCOL_VERSION,
				kind: "response",
				requestId,
				result,
				digest,
				host,
				mac: controlResponseMac(key, {
					clientNonce: connection.clientNonce,
					serverNonce: connection.serverNonce,
					requestId,
					digest,
				}),
			}),
		);
	}

	async function acceptHello(connection: ControlConnection, clientNonce: string): Promise<void> {
		if (connection.authenticated) {
			sendError(connection, "bad-frame", "connection is already authenticated", null, "handshake");
			connection.socket.destroy();
			return;
		}
		if (seenNonces.has(clientNonce)) {
			sendError(connection, "replayed-nonce", "client nonce was already used", null, "handshake");
			connection.socket.destroy();
			return;
		}
		seenNonces.add(clientNonce);
		while (seenNonces.size > SEEN_NONCE_LIMIT) {
			const oldest = seenNonces.values().next();
			if (oldest.done) break;
			seenNonces.delete(oldest.value);
		}

		const facts = await readFactsSafely();
		observedSessionFile = facts.sessionFile;
		connection.clientNonce = clientNonce;
		connection.serverNonce = createControlNonce();
		connection.binding = hostBinding();
		connection.authenticated = true;
		send(
			connection,
			encodeControlFrame({
				v: CONTROL_PROTOCOL_VERSION,
				kind: "challenge",
				serverNonce: connection.serverNonce,
				host: connection.binding,
				mac: controlHandshakeMac(key, {
					clientNonce: connection.clientNonce,
					serverNonce: connection.serverNonce,
					host: connection.binding,
				}),
			}),
		);
	}

	async function acceptRequest(
		connection: ControlConnection,
		frame: ControlRequestFrame,
	): Promise<void> {
		if (!connection.authenticated || connection.binding === null) {
			sendError(connection, "unauthorized", "handshake required before any request", null, "handshake");
			connection.socket.destroy();
			return;
		}
		if (
			frame.clientNonce !== connection.clientNonce ||
			frame.serverNonce !== connection.serverNonce
		) {
			sendError(connection, "unauthorized", "request is not bound to this connection", frame.requestId, "request");
			connection.socket.destroy();
			return;
		}
		const verified = verifyControlRequestMac(
			key,
			{
				clientNonce: connection.clientNonce,
				serverNonce: connection.serverNonce,
				requestId: frame.requestId,
				method: frame.method,
				digest: frame.digest,
			},
			frame.mac,
		);
		if (!verified) {
			sendError(connection, "unauthorized", "request signature did not verify", frame.requestId, "request");
			connection.socket.destroy();
			return;
		}
		if (controlDigest(frame.payload) !== frame.digest) {
			sendError(connection, "bad-payload", "payload digest does not match the payload", frame.requestId, "request");
			connection.socket.destroy();
			return;
		}
		connection.provenClient = true;

		const outcome = frame.payload.kind === "nativeShutdown" || frame.payload.kind === "nativeRename"
			? handleNativeAction(frame) : await handleRequest(frame);
		if (connection.closed) return;
		if (outcome.kind === "result") {
			sendResult(connection, frame.requestId, outcome.result);
			emit({ kind: "request", method: frame.method, outcome: "ok" });
			outcome.afterSend?.();
			return;
		}
		sendError(connection, outcome.code, outcome.message, frame.requestId, "request");
		emit({ kind: "request", method: frame.method, outcome: "refused", code: outcome.code });
	}

	async function processLine(connection: ControlConnection, line: string): Promise<void> {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			sendError(connection, "bad-frame", "control frame is not valid JSON", null, connection.authenticated ? "request" : "handshake");
			connection.socket.destroy();
			return;
		}
		const frame = parseControlClientFrame(parsed);
		if (!frame) {
			sendError(connection, "bad-frame", "control frame did not match the protocol", null, connection.authenticated ? "request" : "handshake");
			connection.socket.destroy();
			return;
		}
		if (frame.kind === "hello") {
			await acceptHello(connection, frame.clientNonce);
			return;
		}
		await acceptRequest(connection, frame);
	}

	function handleConnection(socket: Socket): void {
		if (connections.size >= maxConnections) {
			socket.destroy();
			return;
		}
		const connection: ControlConnection = {
			socket,
			authenticated: false,
			provenClient: false,
			clientNonce: "",
			serverNonce: "",
			binding: null,
			buffer: Buffer.alloc(0),
			queue: Promise.resolve(),
			closed: false,
		};
		connections.add(connection);
		emit({ kind: "connection", connections: connections.size });

		const handshakeTimer = setNodeTimeout(() => {
			if (!connection.provenClient) socket.destroy();
		}, HANDSHAKE_TIMEOUT_MS);
		handshakeTimer.unref();

		socket.on("data", (chunk: Buffer) => {
			if (connection.closed) return;
			if (connection.buffer.length + chunk.length > CONTROL_MAX_FRAME_BYTES) {
				sendError(connection, "too-large", "control frame above the channel limit", null, "request");
				connection.socket.destroy();
				return;
			}
			connection.buffer = Buffer.concat([connection.buffer, chunk]);
			for (;;) {
				const newline = connection.buffer.indexOf(0x0a);
				if (newline < 0) return;
				const line = connection.buffer.subarray(0, newline).toString("utf8");
				connection.buffer = connection.buffer.subarray(newline + 1);
				if (line.length === 0) continue;
				connection.queue = connection.queue
					.then(() => processLine(connection, line))
					.catch(() => {
						connection.socket.destroy();
					});
			}
		});
		socket.on("error", () => {
			connection.closed = true;
			socket.destroy();
		});
		socket.on("close", () => {
			clearNodeTimeout(handshakeTimer);
			connection.closed = true;
			connections.delete(connection);
		});
	}

	// Lifecycle

	const server: Server = createServer(handleConnection);
	const settled = Promise.withResolvers<void>();
	const closed = settled.promise;

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(endpoint, () => resolve());
	});
	server.on("error", error => {
		emit({ kind: "warning", message: `control listener error: ${textOf(error)}` });
	});
	emit({ kind: "listening" });

	const initialFacts = await readFactsSafely();
	observedSessionFile = initialFacts.sessionFile;
	const record: ControlRendezvous = {
		version: CONTROL_PROTOCOL_VERSION,
		service: CONTROL_SERVICE,
		slotId,
		endpoint,
		pipeName,
		instanceId,
		epoch,
		pid,
		sessionFile: observedSessionFile,
		cwd: adapter.cwd,
		ompVersion,
		ciphertext: encryptControlKeyToRecipient(key, recipientPublicKey),
		recipientFingerprint: controlRecipientFingerprint(recipientPublicKey),
		startedAt: now(),
	};
	await mkdir(options.rendezvousDirectory, { recursive: true, mode: 0o700 });
	await writeControlRendezvous(options.rendezvousDirectory, record);
	emit({ kind: "published" });

	let stopping: Promise<void> | null = null;
	async function stop(reason = "requested"): Promise<void> {
		stopping ??= (async () => {
			for (const connection of connections) {
				connection.closed = true;
				connection.socket.destroy();
			}
			connections.clear();
			await new Promise<void>(resolve => server.close(() => resolve()));
			await removeOwnControlRendezvous(options.rendezvousDirectory, slotId, instanceId).catch(
				() => {},
			);
			emit({ kind: "stopped", reason });
			settled.resolve();
		})();
		return stopping;
	}

	return {
		endpoint,
		pipeName,
		instanceId,
		rendezvousPath: controlRendezvousPath(options.rendezvousDirectory, slotId),
		identity: hostBinding,
		noteSessionTransition(): void {
			// Every identity-invalidating transition mints a new generation, even
			// when it later returns to the same session id.
			epoch = createControlEpoch();
			emit({ kind: "session-transition" });
		},
		stop,
		closed,
	};
}

// Launch metadata

/**
 * Where this host publishes and which slot it belongs to. Both are public launch
 * metadata ([ADR-0006](../../docs/decisions/0006-host-generated-key-peer-verified-pipe.md)):
 * the control key never travels through the environment, so there is nothing
 * secret here to scrub and nothing a child process could inherit.
 */
export interface ControlLaunchMetadata {
	readonly directory: string;
	readonly slotId: string;
}

export type ControlLaunchMetadataResult =
	| { readonly kind: "absent" }
	| { readonly kind: "ready"; readonly metadata: ControlLaunchMetadata }
	| { readonly kind: "rejected"; readonly reason: string };

interface BunEnvironment {
	env?: Record<string, string | undefined>;
}

function environmentValue(name: string): string | undefined {
	const bun = (globalThis as { Bun?: BunEnvironment }).Bun;
	return process.env[name] ?? bun?.env?.[name];
}

/**
 * Read the public rendezvous directory and slot from the launch environment.
 * Absence is not an error: an OMP process started without host-control wiring
 * simply serves nothing, which is the visible state the extension renders.
 */
export function readControlLaunchMetadata(): ControlLaunchMetadataResult {
	const directory = environmentValue(CONTROL_DIR_ENV);
	const slotId = environmentValue(CONTROL_SLOT_ENV);
	if (directory === undefined && slotId === undefined) return { kind: "absent" };
	if (typeof directory !== "string" || directory.length === 0) {
		return { kind: "rejected", reason: `${CONTROL_DIR_ENV} is missing` };
	}
	if (!isControlSlotId(slotId)) {
		return { kind: "rejected", reason: `${CONTROL_SLOT_ENV} is missing or malformed` };
	}
	return { kind: "ready", metadata: { directory, slotId } };
}

// OMP adapter

const OMP_VERSION_RE = /\d+\.\d+\.\d+/;
const OMP_TOOL_API = "the installed OMP build exposes no tool catalogue API";

/** OMP adapter, including the context feed the OMP hooks drive. */
export interface OmpHostControlAdapter extends HostControlAdapter {
	/** Store the newest live extension context seen by a handler. */
	observeContext(context: OmpExtensionContext): void;
	observeActivity(kind: NativeActivityHook, event: unknown, context: OmpExtensionContext): void;
	resetActivity(): void;
}

function unavailableNativeState(unavailableReason: string): ControlNativeState {
	return { available: false, sessionFile: null, sessionId: null, cwd: null, name: null, settled: null, hasContent: null, unavailableReason };
}

/**
 * OMP-side adapter. OMP hands a context to event handlers instead of exposing
 * one on the factory API, so the newest live context is kept here; the context's
 * `sessionManager` is a stable live reference (pi-coding-agent
 * `src/extensibility/extensions/runner.ts`).
 */
export function createOmpHostControlAdapter(pi: OmpExtensionAPI): OmpHostControlAdapter {
	let context: OmpExtensionContext | undefined;
	const activity = new NativeActivityJournal();


	const readFacts = async (): Promise<HostControlFacts> => {
		const readGaps: string[] = [];
		const active = context;
		if (!active) readGaps.push("no live extension context yet");
		let sessionFile: string | null = null;
		// `false` unless a read actually succeeded. OMP reports an unmaterialised
		// session as `null`/`undefined`; a missing getter, a throw or any other
		// shape is a failure to read the identity. Reporting that as a bare `null`
		// would make it indistinguishable from a genuinely new session
		// (ADR-0011 invariant F1).
		let sessionIdentityKnown = false;
		if (active) {
			try {
				const manager = active.sessionManager;
				// Probed, not assumed: a build whose session manager lacks the
				// getter is an unread identity rather than an exception that would
				// abandon the whole observation.
				const getter = manager.getSessionFile;
				if (typeof getter !== "function") {
					readGaps.push(SESSION_IDENTITY_UNREADABLE);
				} else {
					const raw: unknown = manager.getSessionFile();
					if (raw === null || raw === undefined) {
						// The reading succeeded: this session has no file allocated yet.
						sessionIdentityKnown = true;
					} else if (typeof raw === "string" && raw.length > 0) {
						sessionFile = raw;
						sessionIdentityKnown = true;
					} else {
						readGaps.push(SESSION_IDENTITY_UNREADABLE);
					}
				}
			} catch {
				readGaps.push(SESSION_IDENTITY_UNREADABLE);
			}
		}
		return { sessionFile, sessionIdentityKnown, readGaps };
	};

	const bounded = (value: string | null | undefined): string | null =>
		typeof value === "string" && value.length <= 4096 ? value : null;
	const readNative = (includeContent: boolean): { state: ControlNativeState; work: ControlNativeWork | null } => {
		const active = context;
		if (active?.mode !== "tui") return { state: unavailableNativeState("no live native TUI context"), work: null };
		try {
			const manager = active.sessionManager;
			const jobs = active.getAsyncJobSnapshot?.();
			const idle = typeof active.isIdle === "function" ? active.isIdle() : null;
			const pendingMessages = typeof active.hasPendingMessages === "function" ? active.hasPendingMessages() : null;
			const work = idle !== null && pendingMessages !== null && jobs !== null && jobs !== undefined
				? { working: !idle, backgroundWork: jobs.running.length > 0 || jobs.delivery.queued > 0 ||
					jobs.delivery.delivering || jobs.delivery.pendingJobIds.length > 0 || hasLiveSubagents(pi) }
				: null;
			const settled = work === null ? null : !work.working && !work.backgroundWork && !pendingMessages;
			const entries = includeContent ? manager.getEntries?.() : undefined;
			return { work, state: {
				available: true, sessionFile: bounded(manager.getSessionFile()), sessionId: bounded(manager.getSessionId()),
				cwd: bounded(manager.getCwd?.()), name: bounded(manager.getSessionName?.()),
				settled, hasContent: entries ? entries.some(entry => entry.type === "message" && (entry.message?.role === "user" || entry.message?.role === "assistant")) : null,
				unavailableReason: null,
			} };
		} catch {
			return { state: unavailableNativeState("native session state could not be read"), work: null };
		}
	};
	const nativeState = (includeContent: boolean): ControlNativeState => readNative(includeContent).state;
	const targetMatches = (target: ControlNativeTarget, state: ControlNativeState): boolean =>
		state.available && state.sessionFile === target.sessionFile && state.sessionId === target.sessionId;

	const unavailableTools = (unavailableReason: string): ControlToolList => ({
		available: false, all: [], active: [], unavailableReason,
	});
	const toolNamesOf = (names: readonly unknown[]): string[] | null => {
		const out = new Set<string>();
		for (const name of names) {
			if (!isControlToolName(name)) return null;
			out.add(name);
		}
		return [...out];
	};


	return {
		observeContext(next: OmpExtensionContext): void {
			context = next;
		},
		observeActivity(kind, event, next): void {
			if (next.mode !== "tui" || next.agent?.kind !== "main") return;
			try {
				context = next;
				activity.observe(kind, event, next.sessionManager.getSessionId());
			} catch {
				// A notification observation cannot affect OMP work or expose its diagnostics.
			}
		},
		resetActivity(): void { activity.resetFreshOutcome(); },
		describeVersion(): string | null {
			try {
				// The SDK namespace exports `VERSION`; there is no lowercase `version`.
				// The value is a diagnostic only, never a gate, so an unreadable or
				// unexpected shape reports the release as unknown.
				const version = pi.pi?.VERSION;
				if (typeof version !== "string") return null;
				const match = OMP_VERSION_RE.exec(version);
				return match ? match[0] : null;
			} catch {
				return null;
			}
		},
		get cwd(): string {
			return process.cwd();
		},
		readFacts,
		nativeState,
		subagentWork: () => hasLiveSubagents(pi),
		nativeActivity(epoch, includeWork = false) {
			const entries = activity.entries;
			const snapshot = readNative(false);
			const journal = { epoch, oldestSeq: activity.oldestSeq, entries, state: snapshot.state };
			return includeWork ? { ...journal, work: snapshot.work } : journal;
		},
		nativeShutdown(target, consent) {
			const active = context;
			if (active?.mode !== "tui" || typeof active.shutdown !== "function" || typeof active.abort !== "function") return { status: "unsupported" };
			const state = nativeState(false);
			if (!targetMatches(target, state)) return { status: "target-changed" };
			if (state.settled !== true && !consent) return { status: "busy" };
			return {
				status: state.settled === true ? "accepted" : "accepted-deferred",
				commit: () => {
					if (consent) active.abort!();
					active.shutdown!();
				},
			};
		},
		nativeRename(target, name) {
			if (context?.mode !== "tui" || typeof pi.setSessionName !== "function") return "unsupported";
			if (!targetMatches(target, nativeState(false))) return "target-changed";
			try {
				pi.setSessionName(name);
				return "renamed";
			} catch {
				return "unsupported";
			}
		},
		async listTools(): Promise<ControlToolList> {
			const readActive = pi.getActiveTools;
			const readAll = pi.getAllTools;
			if (typeof readActive !== "function" || typeof readAll !== "function") return unavailableTools(OMP_TOOL_API);
			let all: string[] | null;
			let active: string[] | null;
			try {
				all = toolNamesOf(readAll.call(pi).map(info => info.name));
				active = toolNamesOf(readActive.call(pi));
			} catch {
				return unavailableTools("this OMP session could not read its tool catalogue");
			}
			if (all === null || active === null || all.length + active.length > CONTROL_MAX_TOOLS) {
				return unavailableTools(
					`this OMP session cannot describe its catalogue in the control form: at most ${CONTROL_MAX_TOOLS} names of at most ${CONTROL_MAX_TOOL_NAME_CHARS} printable characters`,
				);
			}
			return { available: true, all, active, unavailableReason: null };
		},
	};
}

/**
 * Register the native hooks this extension needs. OMP runs the factory before
 * the session is created, so the hooks are in place before any transition can
 * begin.
 *
 * The hooks are observation-only: they mint a new session generation so a client
 * that pinned the previous one can tell the session may have changed, and they
 * never return a cancellation, so a `new_session`, `switch_session`, fork, branch
 * or tree navigation behaves exactly as if this extension were not loaded.
 */
export function registerOmpHostControlHooks(
	pi: OmpExtensionAPI,
	onContext: (context: OmpExtensionContext) => void,
	onSessionTransition: () => void,
): void {
	const observe = (_event: unknown, context: OmpExtensionContext): void => {
		onContext(context);
		onSessionTransition();
	};
	pi.on("session_start", (_event: unknown, context: OmpExtensionContext) => {
		onContext(context);
	});
	pi.on("session_before_switch", observe);
	pi.on("session_before_branch", observe);
	pi.on("session_before_tree", observe);
	pi.on("session_switch", observe);
	pi.on("session_branch", observe);
	pi.on("session_tree", observe);
}

// Native file evidence

/** One launch's file-evidence wiring: the two OMP hooks, their status and close. */
export interface NativeFileEvidenceWiring {
	readonly hooks: FileEvidenceOmpHooks;
	status(): FileEvidenceStatus;
	close(): Promise<void>;
}

export interface NativeFileEvidenceOptions {
	/** Host-control directory this launch published into (`CONTROL_DIR_ENV`). */
	readonly directory: string;
	/** Verified launch slot: the owner, the slot and therefore the evidence namespace. */
	readonly slotId: string;
	/** Kernel instance identity of this host, i.e. the control server's instance id. */
	readonly processInstanceId: string;
	/** Consented workspace root, which the extension indexes as this session's cwd. */
	readonly workspaceRoot: string;
	/** Injected by tests so storage verification never depends on machine ACLs. */
	readonly probe?: NativeFileObservationStorageProbe;
}

/**
 * Create the file-evidence producer for one launch.
 *
 * Contrast with the other capabilities here: this one is **inert until a user
 * consents**. Construction creates no directory and reads no byte, and every
 * stage call re-reads consent, the disable marker and storage readiness before
 * touching a file, so disabling capture from VS Code stops a surviving host
 * without restarting it. Both hooks are bounded by the observation budget, catch
 * their own failures and never return a cancellation, so an unavailable store
 * cannot deny or visibly delay an OMP tool.
 *
 * The identity is deliberately per launch: `slotId` is the launch slot the
 * extension verified through the control handshake, `processInstanceId` is the
 * control server's instance id, and the store lives under this launch's
 * host-control directory. A reader that does not recompute exactly the same
 * owner, slot, workspace and session binding sees no evidence at all.
 */
export function createNativeFileEvidence(options: NativeFileEvidenceOptions): NativeFileEvidenceWiring {
	const observer = createFileEvidenceObserver({
		storageRoot: fileEvidenceStoreRoot(options.directory),
		ownerId: options.slotId,
		slotId: options.slotId,
		workspaceRoot: options.workspaceRoot,
		processInstanceId: options.processInstanceId,
		...(options.probe ? { probe: options.probe } : {}),
	});
	return {
		hooks: createFileEvidenceHooks(observer),
		status: () => observer.status(),
		close: () => observer.close(),
	};
}

// Entry point

/** Remove the rendezvous after this process exits, guarded by its instance id. */
function installExitCleanup(rendezvousPath: string, instanceId: string): void {
	process.once("exit", () => {
		try {
			const descriptor = openSync(rendezvousPath, "r");
			const buffer = Buffer.alloc(CONTROL_MAX_RENDEZVOUS_BYTES + 1);
			let length = 0;
			try {
				while (length < buffer.length) {
					const count = readSync(descriptor, buffer, length, buffer.length - length, length);
					if (count === 0) break;
					length += count;
				}
			} finally {
				closeSync(descriptor);
			}
			if (length > CONTROL_MAX_RENDEZVOUS_BYTES) return;
			const raw = buffer.toString("utf8", 0, length);
			const parsed = JSON.parse(raw) as { instanceId?: unknown };
			if (parsed.instanceId === instanceId) rmSync(rendezvousPath, { force: true });
		} catch {
			// Nothing to clean up.
		}
	});
}

/**
 * Slots whose control server this process already serves. Held on `globalThis`
 * under a registered symbol so a second copy of this module (OMP can import an
 * extension once per binding) still sees the first copy's claim.
 */
const OWNER_CLAIMS_KEY = Symbol.for("omp-vscode.host-control.owners");

function ownerClaims(): Set<string> {
	const holder = globalThis as { [OWNER_CLAIMS_KEY]?: Set<string> };
	return (holder[OWNER_CLAIMS_KEY] ??= new Set<string>());
}

/**
 * OMP `-e` extension entry. Launch metadata contains only public directory and
 * slot; the per-run key is generated here and sealed to the preload-pinned
 * recipient before a control endpoint is published.
 *
 * Exported both ways on purpose: OMP's loader takes the module's `default`
 * (pi-coding-agent `src/extensibility/extensions/loader.ts`), while tests
 * import the named binding.
 */
export async function hostControlExtension(pi: OmpExtensionAPI): Promise<void> {
	const metadata = readControlLaunchMetadata();
	const log = (message: string): void => {
		try {
			pi.logger?.warn?.(`[omp-desk host-control] ${message}`);
		} catch {
			// A logger is not worth failing the extension for.
		}
	};
	if (metadata.kind === "absent") return;
	// Independent of the control channel: an RPC chat child launched by Desk can rewind in place even when the
	// control server below refuses or a later binding stays inert (ADR-0051).
	registerNavigateCommand(pi);
	// Every binding: subagent bindings observe their own runs, the RPC main binding publishes (ADR-0053).
	registerAgentLiveness(pi);
	// Every binding; only the RPC main session's prompt gains the Chat prompt. Like Rewind, it needs no control channel.
	registerChatPrompt(pi);
	if (metadata.kind === "rejected") {
		log(`refusing host control: ${metadata.reason}`);
		return;
	}

	// The recipient public key is a Bun `--define` literal pinned through
	// `--preload`. Without a usable one the control key cannot be sealed, and
	// ADR-0006 forbids an unencrypted fallback, so nothing is served at all.
	const recipientPublicKey = readControlRecipientPublicKey();
	if (recipientPublicKey === null) {
		log(`refusing host control: ${CONTROL_RECIPIENT_DEFINE} is missing or unusable`);
		return;
	}

	const { directory, slotId } = metadata.metadata;
	// One control server per process and slot. OMP binds this extension again for
	// every in-process agent session (each task subagent). If every binding minted
	// its own key, pipe and instance and overwrote the slot's rendezvous, the
	// extension, which pinned the first server's key, would refuse the record as a
	// changed key (or find none once the subagent's server stopped) although the
	// original server was healthy. So the first binding owns the slot for as long
	// as its server lives; later bindings in the same process stay inert.
	const claims = ownerClaims();
	const claimKey = `${directory}\u0000${slotId}`;
	if (claims.has(claimKey)) return;
	claims.add(claimKey);
	const pipeName = controlPipeName(slotId);
	const endpoint = controlEndpoint(pipeName, directory);
	const adapter = createOmpHostControlAdapter(pi);
	let server: HostControlServer | undefined;
	let evidence: NativeFileEvidenceWiring | undefined;
	let shutdownRequested = false;
	// The two tool hooks are registered before the control server is awaited, so a
	// tool call cannot slip past while the channel starts; each one observes nothing
	// until the producer exists, which is also when its process identity — the
	// server's instance id — is known. Registering them is free: the producer stays
	// inert until a consent record exists, and every stage re-reads consent, the
	// workspace disable marker and storage readiness, so a user who disables capture
	// in VS Code stops this process without restarting it. Both handlers are bounded,
	// swallow their own failures and never return a cancellation, so an unavailable
	// store can never deny or delay an OMP tool.
	const toolHooks = {
		onToolCall: (event: unknown, context: unknown): Promise<void> =>
			evidence === undefined ? Promise.resolve() : evidence.hooks.onToolCall(event, context),
		onToolResult: (event: unknown, context: unknown): Promise<void> =>
			evidence === undefined ? Promise.resolve() : evidence.hooks.onToolResult(event, context),
	};

	try {
		registerOmpHostControlHooks(pi, context => adapter.observeContext(context), () => {
			adapter.resetActivity();
			server?.noteSessionTransition();
		});
		for (const kind of NATIVE_ACTIVITY_HOOKS) {
			pi.on(kind, (event, context) => adapter.observeActivity(kind, event, context));
		}
		pi.on("tool_call", toolHooks.onToolCall);
		pi.on("tool_result", toolHooks.onToolResult);
		pi.on("session_shutdown", async () => {
			shutdownRequested = true;
			void evidence?.close();
			stopAgentLiveness();
			try {
				await server?.stop("session-shutdown");
			} finally {
				claims.delete(claimKey);
			}
		});
		server = await startHostControlServer({
			adapter,
			recipientPublicKey,
			slotId,
			pipeName,
			endpoint,
			rendezvousDirectory: directory,
			onEvent: event => {
				if (event.kind === "warning") log(event.message);
			},
		});
		if (shutdownRequested) {
			// The session ended while the listener was still starting: nothing may keep serving it.
			await server.stop("session-shutdown");
			claims.delete(claimKey);
			return;
		}
		installExitCleanup(server.rendezvousPath, server.instanceId);
		evidence = createNativeFileEvidence({
			directory,
			slotId,
			processInstanceId: server.instanceId,
			workspaceRoot: adapter.cwd,
		});
	} catch (error) {
		claims.delete(claimKey);
		// Only the error class is named: this line reaches the native log, and an
		// exception message can quote a path or a provider response.
		const label = error instanceof Error ? error.name : "unknown error";
		log(`host control is unavailable (${/^[\x21-\x7e]{1,64}$/.test(label) ? label : "unknown error"})`);
	}
}

export default hostControlExtension;
