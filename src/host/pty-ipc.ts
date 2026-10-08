/**
 * Loopback transport for the PTY broker protocol
 * ([ADR-0024](../../docs/decisions/0024-own-omp-pty-for-in-tab-terminal.md)).
 *
 * Both ends live here so there is exactly one implementation of the framing,
 * the handshake and the buffering rules: the broker
 * (`src/broker/pty-broker.ts`) uses {@link startPtyBrokerServer}, and the
 * extension host uses {@link connectPtyBroker}. The transport is deliberately
 * dumb: it authenticates a connection, sequences and verifies frames, and hands
 * them to its owner, so the meaning of a request lives in one place.
 *
 * Invariants:
 * - The broker binds `127.0.0.1` on an ephemeral port and never any other
 *   address; there is no unauthenticated path, no fallback to a plain socket, and
 *   a frame that fails its MAC closes the connection.
 * - The handshake is a mutual proof of one shared token: the broker mints the token,
 *   the client proves it holds that token, the broker proves it holds the same token
 *   *and* names its own claimed process identity inside that proof, and both derive a
 *   per-connection session key from the nonce pair through a domain-separated
 *   HMAC. Sequence numbers start at 1 per connection and must arrive contiguously,
 *   which is what makes a captured frame from an earlier connection useless here.
 * - Every buffer is bounded. Output the broker retains while no frontend is
 *   attached is bounded elsewhere (the screen model and the replay backlog); a
 *   client that stops reading is disconnected once its own queue passes the bound
 *   rather than being allowed to grow this process without limit.
 */

import { connect, createServer, type Server, type Socket } from "node:net";
import {
	PTY_MAX_FRAME_BYTES,
	PTY_PROTOCOL_VERSION,
	PtyProtocolError,
	createPtyNonce,
	derivePtySessionId,
	derivePtySessionKey,
	encodePtyFrame,
	parsePtyFrame,
	ptyHelloMac,
	ptyHelloOkMac,
	verifyPtyHelloMac,
	verifyPtyHelloOkMac,
	type PtyBrokerFrame,
	type PtyClientFrame,
	type PtyDirection,
	type PtyEventFrame,
	type PtyFrame,
	type PtyHello,
	type PtyHelloOk,
	type PtyKind,
	type PtyRefusalCode,
	type PtyRequestFrame,
} from "./pty-protocol.ts";

/** Host the broker binds and the client dials. Nothing else is reachable. */
export const PTY_LOOPBACK_HOST = "127.0.0.1";

/** Default bound for the opening handshake. */
export const PTY_HANDSHAKE_TIMEOUT_MS = 10_000;

/** Largest queue of unflushed frame bytes one connection may accumulate. */
export const PTY_MAX_SEND_QUEUE_BYTES = 8 * 1024 * 1024;

/** Largest unterminated line one connection may accumulate before it is refused. */
const MAX_LINE_BYTES = PTY_MAX_FRAME_BYTES;

/**
 * One authenticated connection, seen from whichever end owns it.
 *
 * The two type parameters are the direction this end speaks: what it receives and what
 * it may send. They are what keep a client from sending a state push and a broker from
 * sending a request — a mistake that would otherwise type-check and then be refused at
 * run time on the peer's side.
 */
export interface PtyConnection<Received extends PtyFrame = PtyFrame, Sent extends PtyRequestFrame | PtyEventFrame = PtyRequestFrame | PtyEventFrame> {
	/** Non-secret label of this connection; also the MAC domain separator. */
	readonly sessionId: string;
	/** Key every frame on this connection is authenticated with. */
	readonly sessionKey: Buffer;
	/** What the broker proved about itself in the handshake. */
	readonly hello: PtyHelloOk;
	readonly closed: boolean;
	/**
	 * Bytes this connection has accepted and not yet flushed to the socket. A sender that
	 * streams an unbounded backlog paces itself on this and {@link onDrain} instead of
	 * relying on {@link PTY_MAX_SEND_QUEUE_BYTES}, which closes the connection.
	 */
	readonly pendingBytes: number;
	send(body: Sent): void;
	/** Called each time the socket has flushed everything it was holding. */
	onDrain(listener: () => void): void;
	onFrame(listener: (frame: Received) => void): void;
	onClosed(listener: (reason: string) => void): void;
	close(reason?: string): void;
}

/** What the broker's side of one connection speaks. */
export type PtyBrokerSideConnection = PtyConnection<PtyClientFrame, PtyEventFrame>;
/** What a client's side of one connection speaks. */
export type PtyClientSideConnection = PtyConnection<PtyBrokerFrame, PtyRequestFrame>;

/** The broker's listening side. */
export interface PtyBrokerServer {
	readonly port: number;
	readonly address: string;
	onConnection(listener: (connection: PtyBrokerSideConnection) => void): void;
	close(): Promise<void>;
}

/** Sockets accepted but not yet authenticated, per server; they count against the pending-handshake bound. */
const pendingHandshakes = new WeakMap<Server, Set<Socket>>();

export interface PtyBrokerServerOptions {
	/** Bearer token for this broker generation. Never logged. */
	readonly token: string;
	readonly brokerId: string;
	readonly generation: string;
	readonly slot: string;
	readonly kind: PtyKind;
	readonly protocolVersion: number;
	readonly runtimeVersion: number;
	readonly treeDigest: string;
	readonly brokerPid: number;
	readonly brokerCreationTime: string | null;
	readonly maxClients?: number;
	readonly handshakeTimeoutMs?: number;
	/** Sockets allowed to be mid-handshake at once. */
	readonly maxPendingHandshakes?: number;
}

/**
 * Line framing shared by the handshake and the authenticated frame stream.
 *
 * The handshake reads exactly one line (its opening frame) and leaves everything after
 * it to the frame reader. Because {@link LineReader.take} removes the delimiter it split
 * on, the line it returned cannot simply be appended again: `push` would splice it into
 * whatever arrives next and hand the frame reader two frames joined into one. That
 * happens when the broker's `hello-ok` and its first status frame arrive in one TCP
 * segment and surface as a `frame is not JSON` error.
 */
export interface LineReader {
	/** `null` when the peer's bytes are not a complete line yet. */
	readonly take: () => string | null;
	readonly push: (chunk: string) => { readonly overflow: boolean };
	/**
	 * Put one line `take` returned back at the front, restoring its delimiter.
	 *
	 * This is the only lossless way to keep a line for a later reader: the buffer's
	 * line boundaries stay exactly as the peer wrote them.
	 */
	readonly unshift: (line: string) => void;
	readonly reset: () => void;
}

export function createLineReader(): LineReader {
	let buffered = "";
	return {
		take() {
			const newline = buffered.indexOf("\n");
			if (newline < 0) return null;
			const line = buffered.slice(0, newline).replace(/\r$/, "");
			buffered = buffered.slice(newline + 1);
			return line;
		},
		push(chunk) {
			buffered += chunk;
			if (buffered.length <= MAX_LINE_BYTES) return { overflow: false };
			buffered = "";
			return { overflow: true };
		},
		unshift(line) {
			buffered = `${line}\n${buffered}`;
		},
		reset() {
			buffered = "";
		},
	};
}

/** Write a frame that precedes the session key: no sequence number, no MAC. */
function writeOpeningFrame(socket: Socket, frame: PtyHello | PtyHelloOk | {
	readonly v: number;
	readonly t: "error";
	readonly code: PtyRefusalCode;
	readonly detail: string;
}): void {
	if (socket.destroyed) return;
	socket.write(`${JSON.stringify(frame)}\n`);
}

interface ConnectionState {
	readonly socket: Socket;
	readonly reader: LineReader;
	readonly direction: PtyDirection;
	/**
	 * Hands one parsed frame to this connection's listeners. Assigned by
	 * {@link makeConnection} before any socket data can be read, so the parser's
	 * direction-checked union becomes the listener's own type exactly once.
	 */
	deliver: (frame: PtyFrame) => void;
	readonly closeListeners: Array<(reason: string) => void>;
	readonly drainListeners: Array<() => void>;
	readonly key: Buffer;
	readonly sessionId: string;
	readonly hello: PtyHelloOk;
	sendSeq: number;
	recvSeq: number;
	queue: string[];
	queued: number;
	closed: boolean;
}

/**
 * Write queued frames until the socket is backed up again.
 *
 * A frame is written exactly once: `socket.write` returning `false` means the frame was
 * *accepted* into Node's own buffer, not that it was refused, so it is never written
 * again from here — it simply ends the drain.
 */
function drainQueue(state: ConnectionState): void {
	if (state.closed) return;
	while (state.queue.length > 0) {
		if (state.queued + state.socket.writableLength > PTY_MAX_SEND_QUEUE_BYTES) return;
		const next = state.queue.shift();
		if (next === undefined) break;
		state.queued -= Buffer.byteLength(next, "utf8");
		if (!state.socket.write(next)) return;
	}
}

/** The socket flushed: write what this side queued, then tell any paced sender. */
function handleDrain(state: ConnectionState): void {
	drainQueue(state);
	for (const listener of state.drainListeners) listener();
}

function closeConnection(state: ConnectionState, reason: string): void {
	if (state.closed) return;
	state.closed = true;
	state.queue = [];
	state.queued = 0;
	state.socket.end();
	// A peer that does not answer the FIN does not keep a broker slot: the socket
	// is destroyed once the grace period passes.
	const timer = setTimeout(() => state.socket.destroy(), 250);
	timer.unref();
	for (const listener of state.closeListeners) listener(reason);
}

function makeConnection<Received extends PtyFrame>(state: ConnectionState): PtyConnection<Received> {
	const frameListeners: Array<(frame: Received) => void> = [];
	state.deliver = frame => {
		// The parser validated the body against `state.direction`, which is the same
		// thing `Received` names at compile time: this is the boundary where the two
		// meet, and the only place the compiler needs telling.
		const typed = frame as Received;
		for (const listener of frameListeners) listener(typed);
	};
	return {
		sessionId: state.sessionId,
		sessionKey: state.key,
		hello: state.hello,
		get closed() {
			return state.closed;
		},
		get pendingBytes() {
			return state.queued + state.socket.writableLength;
		},
		send(body) {
			if (state.closed) return;
			state.sendSeq += 1;
			const line = encodePtyFrame(state.key, state.sessionId, state.sendSeq, body);
			const bytes = Buffer.byteLength(line, "utf8");
			// Both queues count: what this side has not handed to the socket yet, and what
			// the socket itself is still holding. A peer that stops reading is disconnected
			// once either passes the bound; the retained screen lives elsewhere.
			if (state.queued + state.socket.writableLength + bytes > PTY_MAX_SEND_QUEUE_BYTES) {
				closeConnection(state, "the peer stopped reading and its send queue passed its bound");
				return;
			}
			if (state.queue.length === 0) {
				// Accepted by the socket, buffered or not: it must not be written twice.
				state.socket.write(line);
				return;
			}
			state.queue.push(line);
			state.queued += bytes;
		},
		onDrain(listener) {
			state.drainListeners.push(listener);
		},
		onFrame(listener) {
			frameListeners.push(listener);
		},
		onClosed(listener) {
			state.closeListeners.push(listener);
		},
		close(reason = "closed by caller") {
			closeConnection(state, reason);
		},
	};
}

/** Read post-handshake frames off a socket until it ends. */
function pumpFrames(state: ConnectionState): void {
	state.socket.on("data", (chunk: string) => {
		if (state.closed) return;
		const pushed = state.reader.push(chunk);
		if (pushed.overflow) {
			closeConnection(state, "the peer sent more than one frame's worth of bytes without a line end");
			return;
		}
		for (;;) {
			const line = state.reader.take();
			if (line === null) return;
			if (line.length === 0) continue;
			let frame: PtyFrame;
			try {
				frame = parsePtyFrame(state.key, state.sessionId, state.recvSeq + 1, line, state.direction);
			} catch (error) {
				closeConnection(state, error instanceof Error ? error.message : "frame refused");
				return;
			}
			state.recvSeq += 1;
			try {
				state.deliver(frame);
			} catch {
				// A throw out of a socket "data" handler would abandon every complete line still buffered
				// behind this one and leave them unread until the peer happens to send again. After a
				// turn ends that is never, so the stream would freeze. Closing is the recoverable answer:
				// the owner reconnects and resynchronises from its own cursor.
				closeConnection(state, "a frame listener failed");
				return;
			}
		}
	});
	state.socket.on("error", error => closeConnection(state, `socket error: ${error.message}`));
	state.socket.on("close", () => closeConnection(state, "the peer closed the connection"));
}

/**
 * Start the broker's listening socket.
 *
 * The port is ephemeral and the address is loopback: the record publishes which
 * port was chosen, and a client that cannot read that record has no other way to
 * find this socket.
 */
export async function startPtyBrokerServer(options: PtyBrokerServerOptions): Promise<PtyBrokerServer> {
	const connectionListeners: Array<(connection: PtyBrokerSideConnection) => void> = [];
	const open = new Set<ConnectionState>();
	const maxClients = options.maxClients ?? 8;
	const handshakeTimeout = options.handshakeTimeoutMs ?? PTY_HANDSHAKE_TIMEOUT_MS;
	/** Sockets still proving themselves count against their own bound, not the client one. */
	const maxPending = options.maxPendingHandshakes ?? Math.max(2, maxClients);
	const server: Server = createServer(socket => {
		socket.setNoDelay(true);
		socket.setEncoding("utf8");
		const reader = createLineReader();
		let settled = false;
		let bufferedHandshake = "";
		const pending = pendingHandshakes.get(server) ?? ((): Set<Socket> => {
			const set = new Set<Socket>();
			pendingHandshakes.set(server, set);
			return set;
		})();
		const abort = (code: PtyRefusalCode, detail: string): void => {
			if (settled) return;
			settled = true;
			pending.delete(socket);
			writeOpeningFrame(socket, { v: options.protocolVersion, t: "error", code, detail });
			socket.end();
			const timer = setTimeout(() => socket.destroy(), 250);
			timer.unref();
		};
		if (pending.size >= maxPending) {
			// An unauthenticated peer may not consume the broker: it is refused before it
			// can hold a socket, a timer or a partial frame for the handshake timeout.
			abort("busy", `this broker already has ${pending.size} unauthenticated connections`);
			return;
		}
		pending.add(socket);
		socket.on("close", () => pending.delete(socket));
		if (open.size >= maxClients) {
			abort("busy", `this broker already serves ${open.size} connections`);
			return;
		}
		const timer = setTimeout(() => abort("unauthorized", "the handshake did not complete in time"), handshakeTimeout);
		timer.unref();
		const onHandshakeData = (chunk: string): void => {
			bufferedHandshake += chunk;
			if (bufferedHandshake.length > MAX_LINE_BYTES) {
				abort("frame-too-large", "the handshake frame is above the frame bound");
				return;
			}
			const newline = bufferedHandshake.indexOf("\n");
			if (newline < 0) return;
			const line = bufferedHandshake.slice(0, newline).replace(/\r$/, "");
			bufferedHandshake = bufferedHandshake.slice(newline + 1);
			socket.off("data", onHandshakeData);
			clearTimeout(timer);
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				abort("malformed", "the handshake frame is not JSON");
				return;
			}
			if (typeof parsed !== "object" || parsed === null) {
				abort("malformed", "the handshake frame is not an object");
				return;
			}
			const hello = parsed as Partial<PtyHello>;
			if (hello.t !== "hello" || hello.v !== options.protocolVersion) {
				abort("protocol-mismatch", `this broker speaks protocol version ${options.protocolVersion}`);
				return;
			}
			if (hello.brokerId !== options.brokerId || hello.generation !== options.generation) {
				abort("generation-mismatch", "the client named another broker or generation");
				return;
			}
			if (typeof hello.clientNonce !== "string" || !verifyPtyHelloMac(options.token, {
				brokerId: options.brokerId,
				generation: options.generation,
				clientNonce: hello.clientNonce,
			}, hello.mac)) {
				abort("unauthorized", "the handshake did not prove the token");
				return;
			}
			const clientNonce = hello.clientNonce;
			const serverNonce = createPtyNonce();
			const helloOk: PtyHelloOk = {
				v: options.protocolVersion,
				t: "hello-ok",
				brokerId: options.brokerId,
				generation: options.generation,
				serverNonce,
				slot: options.slot,
				kind: options.kind,
				protocolVersion: options.protocolVersion,
				runtimeVersion: options.runtimeVersion,
				treeDigest: options.treeDigest,
				brokerPid: options.brokerPid,
				brokerCreationTime: options.brokerCreationTime,
				mac: ptyHelloOkMac(options.token, {
					brokerId: options.brokerId,
					generation: options.generation,
					slot: options.slot,
					clientNonce,
					serverNonce,
					brokerPid: options.brokerPid,
					brokerCreationTime: options.brokerCreationTime,
				}),
			};
			settled = true;
			pending.delete(socket);
			writeOpeningFrame(socket, helloOk);
			const key = derivePtySessionKey(options.token, clientNonce, serverNonce);
			const state: ConnectionState = {
				socket,
				reader,
				direction: "client-to-broker",
				closeListeners: [],
				drainListeners: [],
				key,
				sessionId: derivePtySessionId(key),
				hello: helloOk,
				deliver: () => undefined,
				sendSeq: 0,
				recvSeq: 0,
				queue: [],
				queued: 0,
				closed: false,
			};
			// Anything past the handshake line belongs to the frame reader.
			if (bufferedHandshake.length > 0) {
				const leftover = bufferedHandshake;
				bufferedHandshake = "";
				reader.push(leftover);
			}
			open.add(state);
			socket.on("close", () => open.delete(state));
			socket.on("drain", () => handleDrain(state));
			pumpFrames(state);
			const connection = makeConnection<PtyClientFrame>(state);
			for (const listener of connectionListeners) listener(connection);
		};
		socket.on("data", onHandshakeData);
		socket.on("error", () => {
			if (settled) return;
			settled = true;
			socket.destroy();
		});
		socket.on("close", () => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
			}
		});
	});
	const listening = Promise.withResolvers<void>();
	server.once("error", error => listening.reject(error));
	server.listen({ host: PTY_LOOPBACK_HOST, port: 0, exclusive: true }, () => listening.resolve());
	await listening.promise;
	const address = server.address();
	if (address === null || typeof address === "string") {
		server.close();
		throw new PtyProtocolError("the broker socket did not report a loopback port");
	}
	return {
		port: address.port,
		address: PTY_LOOPBACK_HOST,
		onConnection(listener) {
			connectionListeners.push(listener);
		},
		async close() {
			for (const state of open) closeConnection(state, "the broker is shutting down");
			open.clear();
			const done = Promise.withResolvers<void>();
			server.close(() => done.resolve());
			await done.promise;
		},
	};
}

export interface PtyConnectOptions {
	readonly token: string;
	readonly brokerId: string;
	readonly generation: string;
	readonly port: number;
	readonly host?: string;
	readonly timeoutMs?: number;
}

/**
 * Dial a broker and complete the handshake.
 *
 * Fails closed on every unexpected answer: a socket that opens but says nothing,
 * names another broker or generation, or returns a proof this token does not
 * produce is refused with its reason, never retried against a different address.
 */
export async function connectPtyBroker(options: PtyConnectOptions): Promise<PtyClientSideConnection> {
	const host = options.host ?? PTY_LOOPBACK_HOST;
	if (host !== PTY_LOOPBACK_HOST) {
		throw new PtyProtocolError("the PTY broker is only reachable over loopback");
	}
	if (!Number.isSafeInteger(options.port) || options.port < 1 || options.port > 65535) {
		throw new PtyProtocolError("the PTY broker record does not carry a usable port");
	}
	const clientNonce = createPtyNonce();
	const socket = connect({ host, port: options.port });
	socket.setNoDelay(true);
	socket.setEncoding("utf8");
	const ready = Promise.withResolvers<void>();
	const failure = Promise.withResolvers<never>();
	socket.once("connect", () => ready.resolve());
	socket.once("error", error => failure.reject(new PtyProtocolError(`the broker socket failed: ${error.message}`)));
	socket.once("close", () => failure.reject(new PtyProtocolError("the broker closed the connection before the handshake")));
	const timeoutMs = options.timeoutMs ?? PTY_HANDSHAKE_TIMEOUT_MS;
	const timer = setTimeout(() => {
		socket.destroy();
		failure.reject(new PtyProtocolError(`the broker did not complete the handshake within ${timeoutMs}ms`));
	}, timeoutMs);
	timer.unref();
	try {
		await Promise.race([ready.promise, failure.promise]);
		const hello: PtyHello = {
			v: PTY_PROTOCOL_VERSION,
			t: "hello",
			brokerId: options.brokerId,
			generation: options.generation,
			clientNonce,
			mac: ptyHelloMac(options.token, {
				brokerId: options.brokerId,
				generation: options.generation,
				clientNonce,
			}),
		};
		socket.write(`${JSON.stringify(hello)}\n`);
		const reader = createLineReader();
		const answer = Promise.withResolvers<PtyHelloOk>();
		const onAnswer = (chunk: string): void => {
			const pushed = reader.push(chunk);
			if (pushed.overflow) {
				answer.reject(new PtyProtocolError("the broker's handshake answer is above the frame bound"));
				socket.destroy();
				return;
			}
			const line = reader.take();
			if (line === null) return;
			socket.off("data", onAnswer);
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				answer.reject(new PtyProtocolError("the broker's handshake answer is not JSON"));
				return;
			}
			if (typeof parsed !== "object" || parsed === null) {
				answer.reject(new PtyProtocolError("the broker's handshake answer is not an object"));
				return;
			}
			const record = parsed as Record<string, unknown>;
			if (record.t === "error") {
				answer.reject(
					new PtyProtocolError(
						`the broker refused the connection: ${String(record.code ?? "unknown")}${
							typeof record.detail === "string" ? ` (${record.detail})` : ""
						}`,
					),
				);
				return;
			}
			if (record.t !== "hello-ok" || record.v !== PTY_PROTOCOL_VERSION) {
				answer.reject(new PtyProtocolError("the broker's handshake answer names another protocol version"));
				return;
			}
			const helloOk = record as unknown as PtyHelloOk;
			if (helloOk.brokerId !== options.brokerId || helloOk.generation !== options.generation) {
				answer.reject(new PtyProtocolError("the broker proved another broker id or generation"));
				return;
			}
			if (!verifyPtyHelloOkMac(options.token, {
				brokerId: options.brokerId,
				generation: options.generation,
				slot: helloOk.slot,
				clientNonce,
				serverNonce: helloOk.serverNonce,
				brokerPid: helloOk.brokerPid,
				brokerCreationTime: helloOk.brokerCreationTime,
			}, helloOk.mac)) {
				answer.reject(new PtyProtocolError("the broker's handshake answer does not prove this token"));
				return;
			}
			answer.resolve(helloOk);
		};
		socket.on("data", onAnswer);
		const helloOk = await answer.promise;
		const key = derivePtySessionKey(options.token, clientNonce, helloOk.serverNonce);
		const leftover = reader.take();
		const state: ConnectionState = {
			socket,
			reader,
			direction: "broker-to-client",
			closeListeners: [],
			drainListeners: [],
			key,
			sessionId: derivePtySessionId(key),
			hello: helloOk,
			deliver: () => undefined,
			// Both counters start at 0 and are incremented before use, so the first frame
			// each side sends is number 1; a repeated or skipped number is refused.
			sendSeq: 0,
			recvSeq: 0,
			queue: [],
			queued: 0,
			closed: false,
		};
		// The handshake line was taken from this very reader. The rest of the chunk it
		// came in (a first frame the broker wrote right after `hello-ok`) has to keep its
		// own line boundary, so it is put back with its delimiter rather than appended.
		if (leftover !== null && leftover.length > 0) state.reader.unshift(leftover);
		socket.on("drain", () => handleDrain(state));
		pumpFrames(state);
		return makeConnection<PtyBrokerFrame>(state);
	} finally {
		clearTimeout(timer);
	}
}
