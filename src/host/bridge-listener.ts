/**
 * The one exact loopback listener an editor owns (ADR-0023).
 *
 * Per editor `E`, never per window: the bind itself is the resource-writer
 * lease, so an occupied port is a refusal, never a reason to scan for another
 * one. The listener accepts exactly one kind of request — a WebSocket upgrade on
 * {@link BRIDGE_PATH}, on literal IPv4 `127.0.0.1`, with `Host` exactly
 * `127.0.0.1:<bound port>`, exactly the pinned Webview `Origin`, no query, no
 * credential in the query/body/subprotocol, and no duplicate `Host`/`Origin`
 * header — and it has no other route at all (no discovery, no health page, no
 * compression).
 *
 * The handshake is a debt the guest pays with its document secret `K`: the guest
 * sends `hello` (which names `W/T/E/D/bootstrapId/bindingHash` and a fresh nonce
 * `C`), the host answers `challenge` with a fresh nonce `S`, this activation's
 * host generation `H` and a per-connection id `Q` plus an HMAC over the pinned
 * transcript, and only a guest that proves knowledge of `K` for that exact
 * transcript is authenticated. Until that proof is verified, no session payload
 * and no control authority crosses, and the whole handshake must finish within
 * {@link BRIDGE_HANDSHAKE_TIMEOUT_MS} of TCP acceptance.
 *
 * After authentication every message is a sequenced AES-GCM frame with its own
 * direction: the first server frame is `ready`, and a frame that repeats, skips
 * or arrives on the wrong direction closes the connection instead of
 * resynchronising. A silent or dead peer is marked `disconnected` — never
 * `closed` — because the guest may come back on its own reconnect.
 */

import { createHash } from "node:crypto";
import * as http from "node:http";
import type { Duplex } from "node:stream";
import {
	BRIDGE_DIRECTION_CLIENT_TO_SERVER,
	BRIDGE_DIRECTION_SERVER_TO_CLIENT,
	BRIDGE_HANDSHAKE_TIMEOUT_MS,
	BRIDGE_HEARTBEAT_MS,
	BRIDGE_IDLE_DISCONNECT_MS,
	BRIDGE_MAX_FRAME_BYTES,
	BRIDGE_MAX_HANDSHAKE_BYTES,
	BRIDGE_MAX_HTTP_HEADER_BYTES,
	BRIDGE_MAX_OUTSTANDING_READS,
	BRIDGE_MAX_PLAINTEXT_BYTES,
	BRIDGE_MAX_QUEUED_OUTBOUND_BYTES,
	BRIDGE_MAX_UNAUTHENTICATED_SOCKETS,
	BRIDGE_MAX_UNAUTHENTICATED_SOCKETS_PER_LISTENER,
	BRIDGE_PATH,
	BRIDGE_PROTOCOL_VERSION,
	BridgeProtocolError,
	BridgeSequence,
	challengeFrame,
	createToken,
	encodeBase64Url,
	frameAdditionalData,
	frameKeys,
	handshakeTranscript,
	invalidateFrame,
	isCanonicalToken,
	isRouteStatus,
	openFrame,
	parseAsciiJsonText,
	parseHello,
	parseTextFrame,
	pingFrame,
	proofFrame,
	randomBytes,
	readyFrame,
	replyFrame,
	routeOfferFrame,
	sealFrame,
	statusFrame,
	terminalPushFrame,
	verifyProof,
} from "../bridge-protocol.ts";
import type { BridgeHello, BridgeRouteStatus } from "../bridge-protocol.ts";
import { fragmentBridgeMessage } from "../bridge-fragments.ts";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const WS_OPCODE_TEXT = 0x1;
const WS_OPCODE_BINARY = 0x2;
const WS_OPCODE_CLOSE = 0x8;
const WS_OPCODE_PING = 0x9;
const WS_OPCODE_PONG = 0xa;
const MASK_BYTES = 4;

/**
 * Bridge exchanges independent from an irreversible OMP/session mutation.
 *
 * Ordered terminal traffic, read-only child history and shared display
 * preferences must not take the one-mutation slot. Each still requires the
 * exact authenticated document/route, is bounded while outstanding and receives
 * its own answer; none grants session writer authority.
 */
const BRIDGE_STREAM_OPERATIONS: Record<string, true> = {
	"guest-version": true,
	"provider-login": true,
	"chat-tool-detail": true,
	"chat-subagent-read": true,
	"terminal-attach": true,
	"terminal-probe": true,
	"terminal-copy-reply": true,
	"terminal-link-validate": true,
	"terminal-link-open": true,
	"terminal-input": true,
	"terminal-resize": true,
	"terminal-focus": true,
	"terminal-visibility": true,
};

/** Stream answers one page may leave outstanding before the session is closed. */
const BRIDGE_MAX_STREAM_REQUESTS = 32;

/** What one connection may turn into. */
export type BridgeSessionState = "authenticated" | "disconnected" | "closed";

/** Who the connection is, once the handshake proved it. */
export interface BridgeDocumentAuthorization {
	/** The document's reconnect secret `K`; never leaves this module after use. */
	readonly secret: Uint8Array;
	/** Lowercase SHA-256 hex of the acknowledged chat-host binding. */
	readonly bindingHash: string;
	readonly workspace: string;
	readonly tabId: string;
	/** 16 bytes, as they arrived in `hello`. */
	readonly editorId: Uint8Array;
	/** 16 bytes, as they arrived in `hello`. */
	readonly documentId: Uint8Array;
}

/** One admitted application request, already fenced to this document. */
export interface BridgeAdmittedRequest {
	readonly routeGeneration: string;
	readonly requestId: string;
	readonly actionSeq: string;
	readonly operation: string;
	readonly payload: unknown;
}

/** A live authenticated connection. `close()` is idempotent. */
export interface BridgeSession {
	readonly documentId: Uint8Array;
	readonly connectionId: Uint8Array;
	readonly hostGeneration: Uint8Array;
	readonly origin: string;
	readonly state: BridgeSessionState;
	/** Route generation this session last acknowledged, or `null`. */
	readonly acknowledgedRoute: string | null;
	/** `true` once the guest acknowledged this session's newest route offer. */
	routeAcknowledged(routeGeneration: string): boolean;
	/** Send one application frame (sealed, sequenced, in the session's write order). */
	send(
		kind: "route-offer" | "invalidate" | "status" | "terminal",
		fields: { readonly routeGeneration: string; readonly status?: BridgeRouteStatus; readonly payload?: unknown },
	): void;
	/** Answer one admitted request. */
	reply(requestId: string, result: unknown): void;
	/** Admit a replaceable authoritative snapshot, producing only one frame at a time. */
	sendSnapshot(routeGeneration: string, messages: Iterable<unknown>): boolean;
	close(reason: BridgeCloseReason): void;
}

/** Why a session ended. Bounded vocabulary; no external text. */
export type BridgeCloseReason =
	| "local"
	| "peer"
	| "timeout"
	| "protocol"
	| "authentication"
	| "superseded"
	| "listener-closed";

/** Everything the listener needs from the extension. */
export interface BridgeListenerHooks {
	/**
	 * The exact Webview Origin this listener is pinned to, or `null` while the
	 * document the listener serves has not pinned one yet — in which case every
	 * upgrade is refused. It comes from the panel route or the document's own
	 * persisted record (never from `cspSource`, a socket or configuration).
	 */
	readonly origin: string | null;
	/** The exact port to bind, or `null` to choose one (only a brand-new editor may). */
	readonly requestedPort: number | null;
	/** Resolve the document a `hello` names, or `null` to refuse it. */
	authorize(hello: BridgeHello): Promise<BridgeDocumentAuthorization | null>;
	/** An admitted request already passed the host's admission path. */
	onRequest(session: BridgeSession, request: BridgeAdmittedRequest): void;
	/** One authenticated connection ended (for any reason but a local close). */
	onSessionEnded(session: BridgeSession, reason: BridgeCloseReason): void;
	/** One authenticated connection began, before the first application frame. */
	onSessionAuthenticated?(session: BridgeSession): void;
	/**
	 * The guest acknowledged a route generation.
	 *
	 * Returning `false` refuses it: the session does not adopt it, so nothing may
	 * be dispatched under it. The hook is what lets the document's own route
	 * selection own the decision instead of the wire.
	 */
	onRouteAcknowledged?(session: BridgeSession, routeGeneration: string): boolean | void;
	/** A bounded, fixed-code diagnostic; never carries external text. */
	onDiagnostic?(code: string, detail: string): void;
	/** Heartbeat interval; defaults to the protocol's 15 s. */
	readonly heartbeatMs?: number;
	/** Silence after which a session is marked `disconnected`; defaults to the protocol's 45 s. */
	readonly idleMs?: number;
}

/** A snapshot keeps DTO references, never a serialized transcript backlog. */
interface SnapshotWrite {
	source: Iterator<unknown> | null;
	readonly routeGeneration: string;
}

type OutboundWrite = { readonly text: string; readonly bytes: number } | SnapshotWrite;

const BRIDGE_WRITE_TIMEOUT_MS = 5_000;

/** Stop codes a listener can report without leaking anything about the peer. */
export type BridgeListenerFailure = "port-occupied" | "bind-failed";

/**
 * Unauthenticated sockets across every listener of this activation.
 *
 * The per-listener bound alone would let one editor accumulate the whole
 * allowance; the bound is per host, so the counter is shared and every
 * listener decrements it the moment its socket authenticates or ends.
 */
const unauthenticatedSockets = { count: 0 };

/** One editor's exact listener. */
export class BridgeListener {
	readonly #hooks: BridgeListenerHooks;
	readonly #hostGeneration: Uint8Array;
	readonly #sockets = new Set<Duplex>();
	/** Sessions that have not proved their secret yet. */
	readonly #pending = new Set<Session>();
	/** Sessions that have: at most one per document. */
	readonly #active = new Set<Session>();
	#server: http.Server | null = null;
	#port: number | null = null;
	#failure: BridgeListenerFailure | null = null;
	#closed = false;

	constructor(hooks: BridgeListenerHooks) {
		this.#hooks = hooks;
		// One generation per activation, not per connection: it is what makes an
		// old host's frames and acknowledgements unusable in a new one.
		this.#hostGeneration = randomBytes(16);
	}

	/** The exact port this listener holds, or `null` before it binds. */
	get port(): number | null {
		return this.#port;
	}

	get failure(): BridgeListenerFailure | null {
		return this.#failure;
	}

	/** The activation-wide generation every authenticated session is fenced to. */
	get hostGeneration(): Uint8Array {
		return this.#hostGeneration;
	}

	/**
	 * Bind the exact port. An occupied port (by any process) fails this call and
	 * leaves {@link failure} set: the caller must never substitute another port
	 * for an editor whose page already knows this one.
	 */
	async listen(): Promise<boolean> {
		if (this.#server !== null) return true;
		const server = http.createServer({ maxHeaderSize: BRIDGE_MAX_HTTP_HEADER_BYTES }, (request, response) => {
			// Only the upgrade route exists. Anything else is refused without a body.
			this.#hooks.onDiagnostic?.("http-route-refused", "a non-upgrade request reached the bridge listener");
			response.writeHead(404, { "content-type": "application/json" });
			response.end('{"ok":false}');
			request.socket.destroy();
		});
		server.on("upgrade", (request, socket, head) => this.#upgrade(request, socket, head));
		server.on("clientError", (_error, socket) => socket.destroy());
		server.on("error", error => {
			const code = (error as { code?: unknown }).code;
			this.#failure = code === "EADDRINUSE" ? "port-occupied" : "bind-failed";
			this.#hooks.onDiagnostic?.(`bind-${this.#failure ?? "bind-failed"}`, "the bridge listener could not bind its exact port");
		});
		const bound = await new Promise<number | null>(resolve => {
			server.listen({ host: "127.0.0.1", port: this.#hooks.requestedPort ?? 0, exclusive: true }, () => {
				const address = server.address();
				resolve(address === null || typeof address === "string" ? null : address.port);
			});
			server.once("error", () => resolve(null));
		});
		if (bound === null) {
			server.close();
			return false;
		}
		this.#server = server;
		this.#port = bound;
		return true;
	}

	/** Release the port and end every session of this editor. */
	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		for (const socket of this.#sockets) socket.destroy();
		this.#sockets.clear();
		this.#server?.close();
		this.#server = null;
		this.#port = null;
	}

	#upgrade(request: http.IncomingMessage, socket: Duplex, head: Buffer): void {
		if (this.#closed || !this.#validUpgrade(request)) {
			this.#hooks.onDiagnostic?.("upgrade-refused", "a socket did not satisfy the bridge listener's upgrade rules");
			socket.destroy();
			return;
		}
		// Two bounds, both about *unauthenticated* sockets: this listener's own, and
		// the activation-wide one every listener shares. An authenticated endpoint is
		// not a liability and is never counted here.
		if (unauthenticatedSockets.count >= BRIDGE_MAX_UNAUTHENTICATED_SOCKETS || this.#pending.size >= BRIDGE_MAX_UNAUTHENTICATED_SOCKETS_PER_LISTENER) {
			this.#hooks.onDiagnostic?.("unauthorized-sockets", "the listener is at its unauthenticated socket limit");
			socket.destroy();
			return;
		}
		this.#sockets.add(socket);
		unauthenticatedSockets.count += 1;
		const key = request.headers["sec-websocket-key"];
		const accept = createHash("sha1")
			.update(`${typeof key === "string" ? key : ""}${WS_GUID}`)
			.digest("base64");
		// The session attaches its readers BEFORE the 101 is written: a guest that
		// sends its hello as soon as it sees the response must never race a socket
		// whose handlers are not in place yet.
		const session = new Session(this.#hooks, socket, this.#hostGeneration, this.#port ?? 0, {
			onAuthenticated: authenticated => this.#authenticated(authenticated),
			onEnded: (ended, reason) => {
				this.#sockets.delete(socket);
				// The activation-wide allowance counts *unauthenticated* sockets, so the
				// unit is returned here as well as on authentication: a socket that dies
				// during its handshake must not consume the allowance forever, or a few
				// refused attempts would stop every listener in this window.
				this.#releasePending(ended);
				this.#active.delete(ended);
				this.#hooks.onSessionEnded(ended, reason);
			},
		});
		this.#pending.add(session);
		session.start(head);
		socket.write(
			`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
		);
	}

	/** Return the one unauthenticated-socket unit this session holds, at most once. */
	#releasePending(session: Session): void {
		if (this.#pending.delete(session)) unauthenticatedSockets.count -= 1;
	}

	/**
	 * One authenticated endpoint per document `D`: a later connection that proves
	 * the same document supersedes the incumbent, because two live endpoints for
	 * one document would each believe they own the guest's answers. A newcomer that
	 * fails its handshake never reaches this point and never evicts the incumbent.
	 */
	#authenticated(session: Session): void {
		this.#releasePending(session);
		for (const incumbent of this.#active) {
			if (incumbent !== session && sameBytes(incumbent.documentId, session.documentId)) incumbent.close("superseded");
		}
		this.#active.add(session);
		this.#hooks.onSessionAuthenticated?.(session);
	}

	/**
	 * Every clause is a fact the listener owns, and a raw-header count is used so
	 * a duplicated `Host`/`Origin` cannot smuggle a second value past the first.
	 */
	#validUpgrade(request: http.IncomingMessage): boolean {
		if (request.method !== "GET") return false;
		const url = request.url ?? "";
		if (url !== BRIDGE_PATH) return false;
		const headers = request.headers;
		const duplicates = countRawHeaders(request.rawHeaders, ["host", "origin"]);
		if (duplicates !== 0) return false;
		if (headers.host !== `127.0.0.1:${this.#port ?? 0}`) return false;
		const origin = this.#hooks.origin;
		if (origin === null) return false;
		if (typeof headers.origin !== "string" || headers.origin !== origin) return false;
		if (typeof headers.upgrade !== "string" || headers.upgrade.toLowerCase() !== "websocket") return false;
		const connection = headers.connection;
		if (typeof connection !== "string" || !connection.toLowerCase().split(/,\s*/).includes("upgrade")) return false;
		if (typeof headers["sec-websocket-version"] !== "string" || headers["sec-websocket-version"] !== "13") return false;
		const key = headers["sec-websocket-key"];
		return typeof key === "string" && key.length === 24;
	}
}

/** How many of the named headers appear more than once in the raw header list. */
function countRawHeaders(rawHeaders: readonly string[], names: readonly string[]): number {
	let duplicates = 0;
	for (const name of names) {
		let seen = 0;
		for (let index = 0; index < rawHeaders.length; index += 2) {
			if ((rawHeaders[index] ?? "").toLowerCase() === name) seen += 1;
		}
		if (seen > 1) duplicates += 1;
	}
	return duplicates;
}

/** What the listener learns about a session it owns. */
interface SessionHooks {
	/** The handshake succeeded: the session may now be superseding an incumbent. */
	readonly onAuthenticated: (session: Session) => void;
	readonly onEnded: (session: Session, reason: BridgeCloseReason) => void;
}

/** One connection: handshake, then sequenced frames. */
class Session implements BridgeSession {
	readonly #hooks: BridgeListenerHooks;
	readonly #socket: Duplex;
	readonly #hostGeneration: Uint8Array;
	readonly #sessionHooks: SessionHooks;
	readonly #inbound = new BridgeSequence();
	readonly #outbound = new BridgeSequence();
	#documentId: Uint8Array = new Uint8Array(16);
	/** The pinned Origin this session's document was served on. */
	#origin = "";
	#connectionId: Uint8Array = new Uint8Array(16);
	#state: BridgeSessionState = "authenticated";
	/** `false` until the proof is verified; nothing may be sent before that. */
	#proved = false;
	#acknowledgedRoute: string | null = null;
	#keys: { readonly clientToServer: Uint8Array; readonly serverToClient: Uint8Array } | null = null;
	#buffer = Buffer.alloc(0);
	readonly #writes: OutboundWrite[] = [];
	#writing = false;
	#activeSnapshot: SnapshotWrite | null = null;
	#pongPending = false;
	#receiveChain: Promise<void> = Promise.resolve();
	#queuedBytes = 0;
	#pendingReads = new Set<string>();
	/**
	 * The request id of the one mutation this document has in flight, or `null`.
	 *
	 * A request id rather than a boolean: a stream operation (terminal input,
	 * resize or attach) is answered too, and its reply must not release a mutation
	 * slot it never reserved. Only the reply naming this exact id settles it, so a
	 * late or foreign answer cannot clear a newer mutation.
	 */
	#mutationRequestId: string | null = null;
	/**
	 * Requests in flight that reserved nothing: a terminal stream operation.
	 *
	 * They are tracked only so {@link reply} can tell them apart from the one
	 * mutation slot; they are bounded because a page that stops reading its own
	 * answers must not accumulate them without limit.
	 */
	readonly #streamRequests = new Set<string>();
	#handshakeTimer: NodeJS.Timeout | undefined;
	#heartbeatTimer: NodeJS.Timeout | undefined;
	#lastTrafficAt = Date.now();

	readonly #port: number;

	constructor(hooks: BridgeListenerHooks, socket: Duplex, hostGeneration: Uint8Array, port: number, sessionHooks: SessionHooks) {
		this.#hooks = hooks;
		this.#socket = socket;
		this.#hostGeneration = hostGeneration;
		this.#port = port;
		this.#sessionHooks = sessionHooks;
	}

	get documentId(): Uint8Array {
		return this.#documentId;
	}

	get connectionId(): Uint8Array {
		return this.#connectionId;
	}

	get hostGeneration(): Uint8Array {
		return this.#hostGeneration;
	}

	get origin(): string {
		return this.#origin;
	}

	get state(): BridgeSessionState {
		return this.#state;
	}

	get acknowledgedRoute(): string | null {
		return this.#acknowledgedRoute;
	}

	routeAcknowledged(routeGeneration: string): boolean {
		return this.#proved && this.#state === "authenticated" && this.#acknowledgedRoute === routeGeneration;
	}

	/** Read the socket: the handshake first, then one frame at a time. */
	start(head: Buffer): void {
		if (head.length > 0) this.#buffer = Buffer.concat([this.#buffer, head]);
		this.#socket.on("error", () => this.close("protocol"));
		this.#socket.on("close", () => this.close("peer"));
		this.#socket.on("data", chunk => {
			this.#lastTrafficAt = Date.now();
			this.#buffer = Buffer.concat([this.#buffer, chunk as Buffer]);
			this.#drain();
		});
		// The whole handshake has one absolute deadline from TCP acceptance.
		this.#handshakeTimer = setTimeout(() => this.close("timeout"), BRIDGE_HANDSHAKE_TIMEOUT_MS);
		this.#heartbeatTimer = setInterval(() => this.#heartbeat(), this.#hooks.heartbeatMs ?? BRIDGE_HEARTBEAT_MS);
		this.#drain();
	}

	send(
		kind: "route-offer" | "invalidate" | "status" | "terminal",
		fields: { readonly routeGeneration: string; readonly status?: BridgeRouteStatus; readonly payload?: unknown },
	): void {
		if (!this.#proved || this.#state !== "authenticated") return;
		let frame: string;
		if (kind === "terminal") {
			// A terminal push is meaningful only under the page's current
			// acknowledged route: it is one page's terminal output, and a route that
			// has been re-offered or fenced must not keep feeding a stale renderer.
			if (this.#acknowledgedRoute === null || fields.routeGeneration !== this.#acknowledgedRoute) return;
			if (fields.payload === undefined) return;
			frame = terminalPushFrame(this.#hostGeneration, this.#documentId, fields.payload);
		} else {
			frame =
				kind === "route-offer"
					? routeOfferFrame(this.#hostGeneration, this.#documentId, fields.routeGeneration, fields.status ?? "waiting")
					: kind === "invalidate"
						? invalidateFrame(this.#hostGeneration, this.#documentId, fields.routeGeneration)
						: statusFrame(this.#hostGeneration, this.#documentId, fields.routeGeneration, fields.status ?? "ready");
		}
		this.#sealAndWrite(frame);
	}

	reply(requestId: string, result: unknown): void {
		if (!this.#proved || this.#state !== "authenticated" || this.#acknowledgedRoute === null) return;
		// The reply is the only thing that releases the reservation it was admitted
		// under: until it is sent, the guest cannot issue the next read or mutation.
		// A stream operation reserved nothing, so its answer passes through without
		// touching the mutation slot — and only the mutation slot's own request id
		// settles it, so a foreign or late answer can never clear a newer mutation.
		if (this.#streamRequests.delete(requestId)) {
			// Nothing to release: terminal input, resize and attach hold no slot.
		} else if (!this.#pendingReads.delete(requestId) && this.#mutationRequestId === requestId) {
			this.#mutationRequestId = null;
		}
		this.#sealAndWrite(replyFrame(this.#hostGeneration, this.#documentId, this.#acknowledgedRoute, requestId, result));
	}

	sendSnapshot(routeGeneration: string, messages: Iterable<unknown>): boolean {
		if (!this.routeAcknowledged(routeGeneration)) return false;
		// Finish the earliest train so disk-first paint cannot be starved by live
		// hydration. Replace only later, wholly unsent trains; live events retain
		// their positions and the latest snapshot is appended after them.
		let retained = this.#activeSnapshot !== null;
		for (let index = 0; index < this.#writes.length;) {
			const queued = this.#writes[index]!;
			if ("source" in queued) {
				if (retained) {
					queued.source = null;
					this.#writes.splice(index, 1);
					continue;
				}
				retained = true;
			}
			index++;
		}
		this.#writes.push({ source: messages[Symbol.iterator](), routeGeneration });
		void this.#flushWrites();
		return true;
	}

	close(reason: BridgeCloseReason): void {
		if (this.#state === "closed") return;
		this.#state = "closed";
		if (this.#activeSnapshot !== null) this.#activeSnapshot.source = null;
		for (const queued of this.#writes) if ("source" in queued) queued.source = null;
		this.#writes.length = 0;
		clearTimeout(this.#handshakeTimer);
		clearInterval(this.#heartbeatTimer);
		this.#handshakeTimer = undefined;
		this.#heartbeatTimer = undefined;
		try {
			this.#socket.destroy();
		} catch {
			/* the socket may already be gone */
		}
		this.#sessionHooks.onEnded(this, reason);
	}

	#drain(): void {
		while (this.#state !== "closed") {
			const frame = readWebSocketFrame(this.#buffer);
			if (frame === null) {
				if (this.#buffer.length > BRIDGE_MAX_FRAME_BYTES + MASK_BYTES) this.close("protocol");
				return;
			}
			this.#buffer = this.#buffer.subarray(frame.consumed);
			if (frame.overflow || !frame.masked) {
				this.close("protocol");
				return;
			}
			if (frame.opcode === WS_OPCODE_CLOSE) {
				this.close("peer");
				return;
			}
			if (frame.opcode === WS_OPCODE_PING) {
				// RFC 6455 permits coalescing pongs. Keep at most one tiny control
				// response in flight, even before authentication, under a deadline.
				if (!this.#pongPending) {
					this.#pongPending = true;
					void this.#writeSocketFrame(encodeWebSocketFrame(WS_OPCODE_PONG, frame.payload))
						.catch(() => this.close("protocol"))
						.finally(() => { this.#pongPending = false; });
				}
				continue;
			}
			if (frame.opcode === WS_OPCODE_PONG) continue;
			if (frame.opcode === WS_OPCODE_BINARY) {
				if (this.#keys === null) {
					this.close("protocol");
					return;
				}
				this.#receive(frame.payload);
				continue;
			}
			if (frame.opcode !== WS_OPCODE_TEXT) {
				this.close("protocol");
				return;
			}
			const text = frame.payload.toString("utf8");
			if (this.#keys !== null) {
				// After authentication every payload is an encrypted binary frame.
				this.close("protocol");
				return;
			}
			this.#handshake(text);
		}
	}

	/** The guest's `hello` and `proof`, in that order, within the one deadline. */
	#handshake(text: string): void {
		if (this.#handshakeStarted) {
			// One socket gets exactly one hello and one proof: a second text frame is
			// either the proof of that handshake or a refusal. Without this, a burst of
			// text frames would start a full concurrent handshake each, inside the same
			// deadline, and each would write its own challenge.
			if (this.#challengePending) void this.#finishHandshake(text);
			else this.close("protocol");
			return;
		}
		this.#handshakeStarted = true;
		void this.#beginHandshake(text);
	}

	#challengePending = false;
	/** `true` once this socket spent its one hello. */
	#handshakeStarted = false;
	#expectedTranscript = "";
	#authorization: BridgeDocumentAuthorization | null = null;
	#clientNonce: Uint8Array | null = null;

	async #beginHandshake(text: string): Promise<void> {
		let hello: BridgeHello;
		try {
			hello = parseHello(text);
		} catch (error) {
			this.#hooks.onDiagnostic?.(error instanceof BridgeProtocolError ? `hello-${error.code}` : "hello-malformed", "a handshake hello was refused");
			this.close("protocol");
			return;
		}
		const origin = this.#hooks.origin;
		if (origin === null) {
			this.#hooks.onDiagnostic?.("hello-unpinned", "a handshake arrived before this listener was pinned to a document origin");
			this.close("authentication");
			return;
		}
		this.#origin = origin;
		this.#documentId = hello.documentId;
		const authorization = await this.#hooks.authorize(hello);
		// An unknown, foreign or uncommitted document is refused without a challenge,
		// so an unauthenticated peer learns nothing beyond "no". The document id the
		// hello claims must be the very document the host resolved: the listener
		// checks it here as well as the resolver, so a resolver that validates only a
		// tab id cannot be talked into serving a different document incarnation.
		if (
			authorization === null ||
			!sameBytes(authorization.editorId, hello.editorId) ||
			!sameBytes(authorization.documentId, hello.documentId) ||
			authorization.bindingHash !== hello.bindingHash ||
			// The transcript is pinned to host-held facts only: a peer that names another
			// workspace or tab is refused instead of having the host MAC its claim.
			authorization.workspace !== hello.workspace ||
			authorization.tabId.toLowerCase() !== hello.tabId.toLowerCase()
		) {
			this.#hooks.onDiagnostic?.("hello-unauthorized", "a handshake named a document this listener does not own");
			this.close("authentication");
			return;
		}
		const serverNonce = randomBytes(32);
		this.#connectionId = randomBytes(16);
		this.#clientNonce = hello.clientNonce;
		this.#authorization = authorization;
		this.#expectedTranscript = handshakeTranscript({
			workspace: hello.workspace,
			tabId: hello.tabId,
			editorId: encodeBase64Url(hello.editorId),
			documentId: encodeBase64Url(hello.documentId),
			bindingHash: hello.bindingHash,
			port: this.#port,
			origin,
			clientNonce: encodeBase64Url(hello.clientNonce),
			serverNonce: encodeBase64Url(serverNonce),
			hostGeneration: encodeBase64Url(this.#hostGeneration),
			connectionId: encodeBase64Url(this.#connectionId),
		});
		this.#challengePending = true;
		const challenge = await challengeFrame(authorization.secret, {
			workspace: hello.workspace,
			tabId: hello.tabId,
			editorId: encodeBase64Url(hello.editorId),
			documentId: encodeBase64Url(hello.documentId),
			bindingHash: hello.bindingHash,
			port: this.#port,
			origin,
			clientNonce: encodeBase64Url(hello.clientNonce),
			serverNonce: encodeBase64Url(serverNonce),
			hostGeneration: encodeBase64Url(this.#hostGeneration),
			connectionId: encodeBase64Url(this.#connectionId),
		}, {
			clientNonce: hello.clientNonce,
			serverNonce,
			hostGeneration: this.#hostGeneration,
			connectionId: this.#connectionId,
		});
		this.#socket.write(encodeWebSocketFrame(WS_OPCODE_TEXT, Buffer.from(challenge, "utf8")));
	}

	async #finishHandshake(text: string): Promise<void> {
		const authorization = this.#authorization;
		if (authorization === null) {
			this.close("authentication");
			return;
		}
		try {
			await verifyProof(text, authorization.secret, this.#expectedTranscript);
		} catch (error) {
			this.#hooks.onDiagnostic?.(error instanceof BridgeProtocolError ? `proof-${error.code}` : "proof-malformed", "a handshake proof was refused");
			this.close("authentication");
			return;
		}
		this.#keys = await frameKeys(authorization.secret, this.#expectedTranscript);
		this.#challengePending = false;
		this.#authorization = null;
		this.#proved = true;
		clearTimeout(this.#handshakeTimer);
		this.#handshakeTimer = undefined;
		// `ready` is the first application frame of an authenticated connection, so it
		// is queued before anything the host may offer: a guest that had to
		// acknowledge a route before it was told its connection was up would keep
		// answering into the void.
		this.#sealAndWrite(readyFrame(this.#hostGeneration, this.#documentId, "ready"));
		// The listener learns about the authentication before that first frame is
		// written, so a superseded incumbent cannot win a race for the guest's answer.
		this.#sessionHooks.onAuthenticated(this);
	}

	/**
	 * Accept one sealed frame.
	 *
	 * Opening is asynchronous (WebCrypto), so frames are chained rather than
	 * opened concurrently: two frames in one TCP read must still be validated in
	 * the order they arrived, or a sequence check could pass out of order.
	 */
	#receive(sealed: Buffer): void {
		this.#receiveChain = this.#receiveChain.then(async () => {
			if (this.#state === "closed") return;
			await this.#open(sealed);
		});
	}

	async #open(sealed: Buffer): Promise<void> {
		const keys = this.#keys;
		if (keys === null) return;
		let sequence = -1;
		let plaintext: Uint8Array;
		try {
			const opened = await openFrame({
				key: keys.clientToServer,
				frame: sealed,
				expectedDirection: BRIDGE_DIRECTION_CLIENT_TO_SERVER,
				hostGeneration: this.#hostGeneration,
				connectionId: this.#connectionId,
				documentId: this.#documentId,
			});
			sequence = opened.sequence;
			plaintext = opened.plaintext;
		} catch (error) {
			this.#hooks.onDiagnostic?.(error instanceof BridgeProtocolError ? `frame-${error.code}` : "frame-malformed", "an encrypted frame was refused");
			this.close("protocol");
			return;
		}
		try {
			this.#inbound.accept(sequence);
		} catch {
			this.#hooks.onDiagnostic?.("frame-sequence", "an encrypted frame was not the next one");
			this.close("protocol");
			return;
		}
		let message: unknown;
		try {
			message = parseTextFrame(plaintext);
		} catch {
			this.close("protocol");
			return;
		}
		this.#dispatch(message);
	}

	#dispatch(message: unknown): void {
		if (!Array.isArray(message)) {
			this.close("protocol");
			return;
		}
		const kind = message[0];
		// A heartbeat is a correlation token with no route authority, so it is
		// answered by echoing it and carries no identity of its own.
		if (kind === "pong") {
			if (message.length !== 2 || !isCanonicalToken(message[1])) this.close("protocol");
			return;
		}
		const hostGeneration = encodeBase64Url(this.#hostGeneration);
		const documentId = encodeBase64Url(this.#documentId);
		// Every other post-handshake frame names this session's own generation and
		// document, so a frame minted for another host activation or another
		// document incarnation of the same editor is refused rather than applied.
		if (message.length < 2 || message[1] !== hostGeneration) {
			this.close("protocol");
			return;
		}
		if (message.length < 3 || message[2] !== documentId) {
			this.close("protocol");
			return;
		}
		if (kind === "route-ack") {
			const route = message[3];
			if (message.length !== 4 || !isCanonicalToken(route)) {
				this.close("protocol");
				return;
			}
			// A valid acknowledgement synchronously publishes document readiness,
			// which can attach a page and resend its snapshot. Enable wire pushes
			// during that callback, but preserve the previous route if it is fenced.
			const previous = this.#acknowledgedRoute;
			this.#acknowledgedRoute = route;
			if (this.#hooks.onRouteAcknowledged?.(this, route) === false) this.#acknowledgedRoute = previous;
			return;
		}
		if (kind !== "request") {
			this.close("protocol");
			return;
		}
		if (this.#state !== "authenticated") {
			// An idle session is never *closed* for being idle, but it cannot carry or
			// answer a request either: admitting one would leave the guest's mutation
			// unanswered and the reservation held. Closing lets the page's own reconnect
			// re-authenticate this document immediately.
			this.close("timeout");
			return;
		}
		const [, , , route, requestId, actionSeq, operation, payload] = message as unknown[];
		if (
			message.length !== 8 ||
			!isCanonicalToken(route) ||
			!isCanonicalToken(requestId) ||
			typeof actionSeq !== "string" ||
			!/^[0-9]{1,20}$/.test(actionSeq) ||
			typeof operation !== "string" ||
			typeof payload !== "string"
		) {
			this.close("protocol");
			return;
		}
		if (route !== this.#acknowledgedRoute) {
			// A sealed read-only capability probe for a fenced route has no authority
			// or reservation. Ignore it; the current route's fixed deadline still applies.
			if (operation === "guest-version") return;
			this.close("protocol");
			return;
		}
		if (this.#pendingReads.has(requestId) || this.#streamRequests.has(requestId)) {
			this.close("protocol");
			return;
		}
		if (operation === "snapshot") {
			if (this.#pendingReads.size >= BRIDGE_MAX_OUTSTANDING_READS) {
				this.close("protocol");
				return;
			}
			this.#pendingReads.add(requestId);
		} else if (BRIDGE_STREAM_OPERATIONS[operation] === true) {
			// Terminal traffic and presentation/child-read exchanges hold no
			// OMP mutation slot. Track their own replies independently, so a slow
			// read or preference write cannot block prompt/abort/answer admission.
			if (this.#streamRequests.size >= BRIDGE_MAX_STREAM_REQUESTS) {
				this.close("protocol");
				return;
			}
			this.#streamRequests.add(requestId);
		} else {
			// One mutation per document: a second one before the first is answered
			// would give the guest two native mutations it cannot correlate.
			if (this.#mutationRequestId !== null) {
				this.close("protocol");
				return;
			}
			this.#mutationRequestId = requestId;
		}
		let decoded: unknown;
		try {
			decoded = parseAsciiJsonText(payload);
		} catch {
			this.#hooks.onDiagnostic?.("payload-malformed", "a request payload was refused");
			this.close("protocol");
			return;
		}
		try {
			this.#hooks.onRequest(this, { routeGeneration: route, requestId, actionSeq, operation, payload: decoded });
		} catch {
			this.#hooks.onDiagnostic?.("request-failed", "the host refused a bridge request");
			this.close("protocol");
		}
	}

	/** Heartbeat: ping on the wire, and mark a silent peer disconnected. */
	#heartbeat(): void {
		if (!this.#proved || this.#state !== "authenticated") return;
		if (Date.now() - this.#lastTrafficAt > (this.#hooks.idleMs ?? BRIDGE_IDLE_DISCONNECT_MS)) {
			if (this.#state === "authenticated") {
				this.#state = "disconnected";
				this.#hooks.onSessionEnded(this, "timeout");
			}
			return;
		}
		this.#sealAndWrite(pingFrame(createToken()));
	}

	/** Admit ordinary traffic under the unchanged plaintext queue budget. */
	#sealAndWrite(text: string): void {
		if (this.#state === "closed" || this.#keys === null) return;
		const bytes = Buffer.byteLength(text, "utf8");
		if (!this.#reserveBytes(bytes)) return;
		this.#writes.push({ text, bytes });
		void this.#flushWrites();
	}

	#reserveBytes(bytes: number): boolean {
		if (bytes > BRIDGE_MAX_PLAINTEXT_BYTES || this.#queuedBytes + bytes > BRIDGE_MAX_QUEUED_OUTBOUND_BYTES) {
			this.#hooks.onDiagnostic?.("outbound-queue", "the bridge session exceeded its outbound queue bound");
			this.close("protocol");
			return false;
		}
		this.#queuedBytes += bytes;
		return true;
	}

	async #flushWrites(): Promise<void> {
		if (this.#writing) return;
		this.#writing = true;
		try {
			while (this.#state !== "closed") {
				const queued = this.#writes.shift();
				if (queued === undefined) break;
				if ("source" in queued) {
					this.#activeSnapshot = queued;
					while (queued.source !== null && this.routeAcknowledged(queued.routeGeneration)) {
						const next = queued.source.next();
						if (next.done) break;
						for (const payload of fragmentBridgeMessage(next.value, queued.routeGeneration)) {
							if (queued.source === null || !this.routeAcknowledged(queued.routeGeneration)) break;
							const text = terminalPushFrame(this.#hostGeneration, this.#documentId, payload);
							const bytes = Buffer.byteLength(text, "utf8");
							if (!this.#reserveBytes(bytes)) break;
							try { await this.#writeSealed(text); }
							finally { this.#queuedBytes -= bytes; }
						}
					}
					queued.source = null;
					this.#activeSnapshot = null;
				} else {
					try { await this.#writeSealed(queued.text); }
					finally { this.#queuedBytes -= queued.bytes; }
				}
			}
		} catch {
			this.close("protocol");
		} finally {
			this.#writing = false;
		}
	}

	async #writeSealed(text: string): Promise<void> {
		const keys = this.#keys;
		if (this.#state === "closed" || keys === null) return;
		const sequence = this.#outbound.next;
		const sealed = await sealFrame({
			key: keys.serverToClient,
			direction: BRIDGE_DIRECTION_SERVER_TO_CLIENT,
			sequence,
			plaintext: Buffer.from(text, "utf8"),
			additionalData: frameAdditionalData(this.#hostGeneration, this.#connectionId, this.#documentId, BRIDGE_DIRECTION_SERVER_TO_CLIENT, sequence),
		});
		this.#outbound.accept(sequence);
		if (this.state === "closed") return;
		await this.#writeSocketFrame(encodeWebSocketFrame(WS_OPCODE_BINARY, Buffer.from(sealed)));
	}

	/** Complete at most one data frame plus one 125-byte pong in socket memory. */
	async #writeSocketFrame(frame: Buffer): Promise<void> {
		if (this.#state === "closed") return;
		const written = Promise.withResolvers<void>();
		const timer = setTimeout(() => {
			this.#hooks.onDiagnostic?.("outbound-stalled", "the bridge peer did not drain an outbound frame");
			this.close("timeout");
			written.reject(new Error("bridge write deadline"));
		}, BRIDGE_WRITE_TIMEOUT_MS);
		const closed = (): void => written.reject(new Error("bridge socket closed"));
		this.#socket.once("close", closed);
		try {
			this.#socket.write(frame, error => {
				if (error) written.reject(error);
				else written.resolve();
			});
			await written.promise;
		} finally {
			clearTimeout(timer);
			this.#socket.off("close", closed);
		}
	}
}

/** One application frame as the protocol's fixed ASCII array. */
function applicationFrame(
	kind: "reply",
	hostGeneration: Uint8Array,
	documentId: Uint8Array,
	routeGeneration: string,
	fields: readonly [string, unknown],
): string {
	if (kind === "reply") {
		return replyFrame(hostGeneration, documentId, routeGeneration, fields[0], fields[1]);
	}
	throw new BridgeProtocolError("malformed", "unsupported application frame");
}





function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	if (left.length !== right.length) return false;
	let difference = 0;
	for (let index = 0; index < left.length; index++) difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
	return difference === 0;
}

/** One WebSocket frame off the wire; `null` when more bytes are needed. */
interface WebSocketFrame {
	readonly opcode: number;
	readonly masked: boolean;
	readonly payload: Buffer;
	readonly consumed: number;
	readonly overflow: boolean;
}

function readWebSocketFrame(buffer: Buffer): WebSocketFrame | null {
	if (buffer.length < 2) return null;
	const opcode = (buffer[0] ?? 0) & 0x0f;
	const masked = ((buffer[1] ?? 0) & 0x80) !== 0;
	let length = (buffer[1] ?? 0) & 0x7f;
	let offset = 2;
	if (length === 126) {
		if (buffer.length < 4) return null;
		length = buffer.readUInt16BE(2);
		offset = 4;
	} else if (length === 127) {
		if (buffer.length < 10) return null;
		const declared = buffer.readBigUInt64BE(2);
		if (declared > BigInt(BRIDGE_MAX_FRAME_BYTES)) return { opcode, masked, payload: Buffer.alloc(0), consumed: 2, overflow: true };
		length = Number(declared);
		offset = 10;
	}
	if (((buffer[0] ?? 0) & 0x80) === 0 || (opcode >= WS_OPCODE_CLOSE && length > 125)) {
		return { opcode, masked, payload: Buffer.alloc(0), consumed: 2, overflow: true };
	}
	if (length > BRIDGE_MAX_FRAME_BYTES) return { opcode, masked, payload: Buffer.alloc(0), consumed: 2, overflow: true };
	const maskLength = masked ? MASK_BYTES : 0;
	if (buffer.length < offset + maskLength + length) return null;
	const payload = Buffer.from(buffer.subarray(offset + maskLength, offset + maskLength + length));
	if (masked) {
		const mask = buffer.subarray(offset, offset + MASK_BYTES);
		for (let index = 0; index < payload.length; index++) payload[index] = (payload[index] ?? 0) ^ (mask[index % MASK_BYTES] ?? 0);
	}
	return { opcode, masked, payload, consumed: offset + maskLength + length, overflow: false };
}

function encodeWebSocketFrame(opcode: number, payload: Buffer): Buffer {
	const header = Buffer.alloc(payload.length < 126 ? 2 : payload.length <= 0xffff ? 4 : 10);
	header[0] = 0x80 | opcode;
	if (payload.length < 126) {
		header[1] = payload.length;
		return Buffer.concat([header, payload]);
	}
	if (payload.length <= 0xffff) {
		header[1] = 126;
		header.writeUInt16BE(payload.length, 2);
	} else {
		header[1] = 127;
		header.writeBigUInt64BE(BigInt(payload.length), 2);
	}
	return Buffer.concat([header, payload]);
}
