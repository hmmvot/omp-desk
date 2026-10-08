/**
 * The page's side of the authenticated host bridge (ADR-0023).
 *
 * A surviving Webview page keeps this client for the whole life of its document.
 * The extension host that created the page can disappear and be replaced — that
 * is the whole point — so this client reconnects on its own, forever, with
 * backoff, and re-proves its document secret `K` on every new connection. Nothing
 * it learns from a previous extension host is trusted: the host generation `H` and
 * the connection id `Q` are fresh on every connection, and every application frame
 * is bound to both.
 *
 * The client owns exactly one direction of the wire: its own masked text
 * handshake, its own sequenced AES-GCM frames, and its own sequence counter, which
 * is reset per connection because the host's counters are. Everything it receives
 * is validated before it is handed to the transport layer, so the page's own
 * routing decides *whether* to use the bridge — never the socket's existence.
 *
 * Environment-neutral on purpose: the installed Webview and Node provide the same
 * `WebSocket`, `crypto.subtle` and timers, so the guest bundle and the protocol's
 * tests run this exact code.
 */

import {
	BRIDGE_DIRECTION_CLIENT_TO_SERVER,
	BRIDGE_DIRECTION_SERVER_TO_CLIENT,
	BRIDGE_PATH,
	BridgeProtocolError,
	BridgeSequence,
	encodeBase64Url,
	frameAdditionalData,
	frameKeys,
	helloFields,
	openFrame,
	parseAndVerifyChallenge,
	parseAsciiJsonText,
	parseTextFrame,
	pongFrame,
	proofFrame,
	randomBytes,
	requestFrame,
	routeAckFrame,
	sealFrame,
} from "../../bridge-protocol.ts";

/** The first reconnect delay, doubling up to {@link BRIDGE_CLIENT_MAX_BACKOFF_MS}. */
export const BRIDGE_CLIENT_INITIAL_BACKOFF_MS = 1_000;
export const BRIDGE_CLIENT_MAX_BACKOFF_MS = 30_000;

/**
 * The platform's WebSocket, optionally built by the caller.
 *
 * The installed Webview needs nothing here: a browser sends the `Origin` header of
 * its own document, which is exactly the header this listener pins. A caller on a
 * platform that does not (Node's WebSocket sends none unless one is passed) builds
 * the socket itself, so the same client can be exercised end to end outside a
 * Webview without a second transport implementation.
 */
export type BridgeSocketFactory = (url: string) => WebSocket;

/** Everything one document needs to open its exact listener again. */
export interface BridgeClientEndpoint {
	/** Canonical workspace hash (`W`), 64 lowercase hex. */
	readonly workspace: string;
	/** Indexed tab id (`T`). */
	readonly tabId: string;
	/** Actual editor id (`E`), 32 lowercase hex. */
	readonly editorId: string;
	/** This document's incarnation (`D`), 32 lowercase hex. */
	readonly documentId: string;
	/** The exact loopback port this document's listener is bound to. */
	readonly port: number;
	/** The canonical `vscode-webview://…` Origin this document reported. */
	readonly origin: string;
	/** Lowercase SHA-256 hex of the acknowledged chat-host binding. */
	readonly bindingHash: string;
	/** The document's independent reconnect secret `K`. */
	readonly secret: Uint8Array;
	/** How to open the socket; defaults to the platform's `WebSocket`. */
	readonly connect?: BridgeSocketFactory;
}

/** What the transport layer learns from the socket. Bounded facts only. */
export interface BridgeClientHooks {
	/** The connection is authenticated and the host's first frame has arrived. */
	readonly onReady?: (status: string) => void;
	/** The host offered a route over the bridge. */
	readonly onRouteOffer: (routeGeneration: string, status: string) => void;
	/** The host invalidated the route named here. */
	readonly onInvalidate: (routeGeneration: string) => void;
	/** The host answered one request. */
	readonly onReply: (requestId: string, payload: unknown) => void;
	/**
	 * The host pushed one message this document did not ask for.
	 *
	 * A terminal's output is the case: it arrives while the host renders it, not in
	 * answer to anything, and a page that survived an extension-host restart has no
	 * panel left to receive it on.
	 */
	readonly onMessage?: (payload: unknown) => void;
	/** The socket is usable, or no longer is. */
	readonly onConnection: (connected: boolean) => void;
	/** A bounded, fixed-code fact about this client; never peer text. */
	readonly onDiagnostic?: (code: string) => void;
}

/** One request the page wants the new extension host to serve. */
export interface BridgeClientRequest {
	readonly routeGeneration: string;
	readonly requestId: string;
	readonly actionSeq: string;
	readonly operation: string;
	readonly payload: unknown;
}

/** The bridge socket, as this page's transport layer drives it. */
export class BridgeClient {
	readonly #endpoint: BridgeClientEndpoint;
	readonly #hooks: BridgeClientHooks;
	#socket: WebSocket | null = null;
	#state: "idle" | "connecting" | "ready" | "closed" = "idle";
	#routeGeneration: string | null = null;
	#keys: { readonly clientToServer: Uint8Array; readonly serverToClient: Uint8Array } | null = null;
	#hostGeneration: Uint8Array = new Uint8Array(16);
	#connectionId: Uint8Array = new Uint8Array(16);
	#sequence = new BridgeSequence();
	#attempt = 0;
	#retryTimer: NodeJS.Timeout | undefined;
	/** Serialises sends so two seals can never reorder on the wire. */
	#sendChain: Promise<void> = Promise.resolve();
	#clientNonce: Uint8Array = new Uint8Array(32);
	/** Server-direction sequence for this connection; reset with every connection. */
	#inbound = new BridgeSequence();
	/** Serialises inbound handling so the arrival order is the accept order. */
	#receiveChain: Promise<void> = Promise.resolve();
	/** The last offer the host sent, so it can be reported again once usable. */
	#reportedOffer: { readonly routeGeneration: string; readonly status: string } | null = null;
	constructor(endpoint: BridgeClientEndpoint, hooks: BridgeClientHooks) {
		this.#endpoint = endpoint;
		this.#hooks = hooks;
	}

	get connected(): boolean {
		return this.#state === "ready";
	}

	/** Start connecting, and keep reconnecting until {@link stop}. */
	start(): void {
		if (this.#state === "closed") return;
		this.#connect();
	}

	/** Stop for good: the document is going away or its credential was retired. */
	stop(): void {
		this.#state = "closed";
		clearTimeout(this.#retryTimer);
		this.#retryTimer = undefined;
		// The secret is not wiped here: the same document keeps it across a host
		// restart, and only the document itself (or its retirement) ends it.
		const socket = this.#socket;
		this.#socket = null;
		this.#keys = null;
		if (socket !== null) {
			socket.onopen = null;
			socket.onmessage = null;
			socket.onclose = null;
			socket.onerror = null;
			try {
				socket.close();
			} catch {
				/* the socket may already be gone */
			}
		}
	}

	/**
	 * Send one request over the bridge.
	 *
	 * Returns `false` when this connection cannot carry it — the caller keeps the
	 * outcome explicitly unknown rather than pretending the request was sent, and
	 * never queues a mutation for a later connection: an uncertain native mutation
	 * is not resent.
	 */
	request(request: BridgeClientRequest): boolean {
		return this.#sendSealed(() =>
			requestFrame(this.#hostGeneration, this.#documentId(), request.routeGeneration, request.requestId, request.actionSeq, request.operation, request.payload),
		);
	}

	/** Acknowledge one route offer the transport layer accepted. */
	acknowledgeRoute(routeGeneration: string): boolean {
		const queued = this.#sendSealed(() => routeAckFrame(this.#hostGeneration, this.#documentId(), routeGeneration));
		if (queued) this.#routeGeneration = routeGeneration;
		return queued;
	}

	#documentId(): Uint8Array {
		return hexBytes(this.#endpoint.documentId);
	}

	#connect(): void {
		if (this.#state === "closed") return;
		this.#state = "connecting";
		this.#keys = null;
		// Both directions are per connection: a new host generation mints a fresh
		// connection id and starts its own counters at zero.
		this.#sequence = new BridgeSequence();
		this.#inbound = new BridgeSequence();
		this.#receiveChain = Promise.resolve();
		this.#reportedOffer = null;
		let socket: WebSocket;
		try {
			const open = this.#endpoint.connect ?? ((url: string) => new WebSocket(url));
			socket = open(`ws://127.0.0.1:${this.#endpoint.port}${BRIDGE_PATH}`);
		} catch {
			this.#reconnect("socket-failed");
			return;
		}
		this.#socket = socket;
		socket.binaryType = "arraybuffer";
		socket.onopen = () => {
			if (socket !== this.#socket) return;
			const clientNonce = randomBytes(32);
			this.#clientNonce = clientNonce;
			socket.send(
				helloFields({
					workspace: this.#endpoint.workspace,
					tabId: this.#endpoint.tabId,
					editorId: hexBytes(this.#endpoint.editorId),
					documentId: this.#documentId(),
					bindingHash: this.#endpoint.bindingHash,
					clientNonce,
				}),
			);
		};
		socket.onmessage = event => this.#received(event.data);
		socket.onclose = () => {
			if (socket !== this.#socket) return;
			this.#reconnect("socket-closed");
		};
		socket.onerror = () => {
			// A refused connection may only surface here, so the retry cannot wait
			// for `onclose`: whichever fires first owns the reconnect, and the other
			// sees a socket that is no longer current.
			if (socket !== this.#socket) return;
			this.#reconnect("socket-error");
		};
	}

	/**
	 * Accept one frame, in arrival order.
	 *
	 * Opening is asynchronous (WebCrypto), so frames are chained rather than opened
	 * concurrently: two frames delivered in one tick must still be validated in the
	 * order they arrived, or the sequence check would see them out of order and the
	 * connection would be dropped for a burst it should have accepted.
	 */
	#received(data: unknown): void {
		this.#receiveChain = this.#receiveChain.then(() => this.#open(data));
	}

	async #open(data: unknown): Promise<void> {
		try {
			if (typeof data === "string") {
				await this.#handshakeText(data);
				return;
			}
			const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data instanceof Uint8Array ? data : null;
			if (bytes === null) {
				this.#reconnect("frame-unusable");
				return;
			}
			await this.#frame(bytes);
		} catch (error) {
			this.#hooks.onDiagnostic?.(error instanceof BridgeProtocolError ? `client-${error.code}` : "client-frame");
			this.#reconnect("frame-refused");
		}
	}

	/** The challenge is the only text frame the host may send after the upgrade. */
	async #handshakeText(text: string): Promise<void> {
		if (this.#keys !== null) throw new BridgeProtocolError("malformed", "A text frame arrived after the handshake.");
		const { challenge, transcriptText } = await parseAndVerifyChallenge(text, this.#endpoint.secret, {
			workspace: this.#endpoint.workspace,
			tabId: this.#endpoint.tabId,
			// The transcript carries the ids in their canonical wire form, which is
			// the unpadded base64url of the 16 bytes — never the hex spelling the
			// durable records use.
			editorId: encodeBase64Url(hexBytes(this.#endpoint.editorId)),
			documentId: encodeBase64Url(this.#documentId()),
			bindingHash: this.#endpoint.bindingHash,
			port: this.#endpoint.port,
			origin: this.#endpoint.origin,
			clientNonce: encodeBase64Url(this.#clientNonce),
			serverNonce: "",
			hostGeneration: "",
			connectionId: "",
		});
		// The proof is only sent after the challenge proved knowledge of our secret.
		this.#hostGeneration = challenge.hostGeneration;
		this.#connectionId = challenge.connectionId;
		const socket = this.#socket;
		if (socket === null) return;
		socket.send(await proofFrame(this.#endpoint.secret, transcriptText));
		this.#keys = await frameKeys(this.#endpoint.secret, transcriptText);
	}

	async #frame(frame: Uint8Array): Promise<void> {
		const keys = this.#keys;
		if (keys === null) throw new BridgeProtocolError("malformed", "A sealed frame arrived before the handshake completed.");
		const opened = await openFrame({
			key: keys.serverToClient,
			frame,
			expectedDirection: BRIDGE_DIRECTION_SERVER_TO_CLIENT,
			hostGeneration: this.#hostGeneration,
			connectionId: this.#connectionId,
			documentId: this.#documentId(),
		});
		this.#inbound.accept(opened.sequence);
		const message = parseTextFrame(opened.plaintext);
		this.#dispatch(message);
	}

	#dispatch(message: unknown): void {
		if (!Array.isArray(message) || message.length < 2) throw new BridgeProtocolError("malformed", "The host sent a frame this client does not know.");
		const kind = message[0];
		// A heartbeat is a correlation token, not an identity: it carries no route
		// authority and is answered by echoing the id, exactly as it arrived.
		if (kind === "ping") {
			const id = message[1];
			if (message.length !== 2 || typeof id !== "string") throw new BridgeProtocolError("malformed", "A heartbeat is not the shape this version defines.");
			this.#sendSealed(() => pongFrame(id));
			return;
		}
		const hostGeneration = encodeBase64Url(this.#hostGeneration);
		if (message[1] !== hostGeneration) throw new BridgeProtocolError("wrong-version", "The host sent a frame for another activation.");
		const documentId = encodeBase64Url(this.#documentId());
		if (message.length < 3 || message[2] !== documentId) {
			throw new BridgeProtocolError("wrong-version", "The host sent a frame for another document.");
		}
		if (kind === "ready") {
			if (message.length !== 4 || typeof message[3] !== "string") throw new BridgeProtocolError("malformed", "The ready frame is not the shape this version defines.");
			this.#state = "ready";
			this.#attempt = 0;
			this.#hooks.onConnection(true);
			this.#hooks.onReady?.(message[3]);
			// An offer that arrived before `ready` (or before this connection was
			// usable at all) is reported once more now that the page can answer it,
			// so a route this host selected is never left unacknowledged because of
			// frame order.
			const pending = this.#reportedOffer;
			if (pending !== null && pending.routeGeneration !== this.#routeGeneration) this.#hooks.onRouteOffer(pending.routeGeneration, pending.status);
			return;
		}
		if (kind === "route-offer") {
			const route = message[3];
			const status = message[4];
			if (message.length !== 5 || typeof route !== "string" || typeof status !== "string") {
				throw new BridgeProtocolError("malformed", "A route offer is not the shape this version defines.");
			}
			this.#reportedOffer = { routeGeneration: route, status };
			this.#hooks.onRouteOffer(route, status);
			return;
		}
		if (kind === "invalidate") {
			const route = message[3];
			if (message.length !== 4 || typeof route !== "string") throw new BridgeProtocolError("malformed", "An invalidation is not the shape this version defines.");
			this.#hooks.onInvalidate(route);
			return;
		}
		if (kind === "status") {
			if (message.length !== 5) throw new BridgeProtocolError("malformed", "A status frame is not the shape this version defines.");
			return;
		}
		if (kind === "reply") {
			const [, , , route, requestId, payload] = message as unknown[];
			if (message.length !== 6 || typeof route !== "string" || typeof requestId !== "string" || typeof payload !== "string") {
				throw new BridgeProtocolError("malformed", "A reply is not the shape this version defines.");
			}
			this.#hooks.onReply(requestId, parseAsciiJsonText(payload));
			return;
		}
		if (kind === "terminal") {
			// One host message this document did not ask for, authenticated by the sealed
			// frame it arrived in and validated by the boundary the page delivers through. The
			// payload carries its own type; there is no second discriminator that could
			// disagree with it.
			const payload = message[3];
			if (message.length !== 4 || typeof payload !== "string") {
				throw new BridgeProtocolError("malformed", "A pushed message is not the shape this version defines.");
			}
			this.#hooks.onMessage?.(parseAsciiJsonText(payload));
			return;
		}
		throw new BridgeProtocolError("unsupported", "The host sent a frame this client does not know.");
	}

	/** Serialize every authenticated outbound frame on the same AES-GCM sequence. */
	#sendSealed(frame: () => string): boolean {
		if (this.#state !== "ready" || this.#keys === null) return false;
		const keys = this.#keys;
		this.#sendChain = this.#sendChain
			.then(async () => {
				if (this.#keys !== keys) return;
				const sequence = this.#sequence.next;
				const sealed = await sealFrame({
					key: keys.clientToServer,
					direction: BRIDGE_DIRECTION_CLIENT_TO_SERVER,
					sequence,
					plaintext: new TextEncoder().encode(frame()),
					additionalData: frameAdditionalData(this.#hostGeneration, this.#connectionId, this.#documentId(), BRIDGE_DIRECTION_CLIENT_TO_SERVER, sequence),
				});
				this.#sequence.accept(sequence);
				const socket = this.#socket;
				if (socket === null || this.#state !== "ready") return;
				socket.send(sealed);
				if (this.#sequence.shouldReconnect) this.#reconnect("sequence-limit");
			})
			.catch(() => this.#reconnect("seal-failed"));
		return true;
	}

	#reconnect(code: string): void {
		if (this.#state === "closed") return;
		const socket = this.#socket;
		this.#socket = null;
		if (socket !== null) {
			socket.onopen = null;
			socket.onmessage = null;
			socket.onclose = null;
			socket.onerror = null;
			try {
				socket.close();
			} catch {
				/* the socket may already be gone */
			}
		}
		const wasReady = this.#state === "ready";
		this.#state = "connecting";
		this.#keys = null;
		this.#hooks.onDiagnostic?.(code);
		if (wasReady) this.#hooks.onConnection(false);
		clearTimeout(this.#retryTimer);
		const delay = Math.min(BRIDGE_CLIENT_MAX_BACKOFF_MS, BRIDGE_CLIENT_INITIAL_BACKOFF_MS * 2 ** Math.min(this.#attempt, 5));
		this.#attempt += 1;
		// Jitter keeps two tabs of one window from retrying in lockstep.
		this.#retryTimer = setTimeout(() => this.#connect(), delay + Math.floor(Math.random() * 250));
	}
}

/** Decode one canonical 32-hex id into bytes; the endpoint was validated first. */
function hexBytes(hex: string): Uint8Array {
	const bytes = new Uint8Array(hex.length / 2);
	for (let index = 0; index < bytes.length; index++) bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
	return bytes;
}
