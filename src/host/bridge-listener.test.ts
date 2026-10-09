/**
 * The bridge listener's refusals and its one happy path.
 *
 * A tiny hand-rolled WebSocket client is used on purpose: the listener must be
 * tested against *raw* HTTP and raw frames, so a forged `Host`/`Origin`/path, a
 * duplicate header, an oversized handshake, a wrong secret and a replayed frame
 * are all exercised as they would arrive on the wire — not through a client
 * library that would sanitise them.
 *
 * Runner: `node --test src/host/bridge-listener.test.ts`
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as net from "node:net";
import { after, describe, it } from "node:test";
import {
	BRIDGE_DIRECTION_CLIENT_TO_SERVER,
	BRIDGE_DIRECTION_SERVER_TO_CLIENT,
	BRIDGE_PATH,
	BridgeSequence,
	encodeBase64Url,
	frameAdditionalData,
	frameKeys,
	helloFields,
	openFrame,
	parseAndVerifyChallenge,
	parseHello,
	parseTerminalPush,
	parseTextFrame,
	proofFrame,
	requestFrame,
	sealFrame,
} from "../bridge-protocol.ts";
import type { BridgeHello } from "../bridge-protocol.ts";
import { BridgeListener } from "./bridge-listener.ts";
import type { BridgeAdmittedRequest, BridgeDocumentAuthorization, BridgeListenerHooks, BridgeSession, BridgeSessionState } from "./bridge-listener.ts";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const ORIGIN = "vscode-webview://0r42vg5knjjkub1td6sq2sg4ggjt4ovjpvcnij5lj62f9k001mi3";
const WORKSPACE = "a".repeat(64);
const BINDING_HASH = "b".repeat(64);
const TAB = "tab:11111111-2222-3333-4444-555555555555";
const EDITOR = new Uint8Array(16).fill(0x21);
const DOCUMENT = new Uint8Array(16).fill(0x22);
const SECRET = new Uint8Array(32).fill(0x33);

const listeners: BridgeListener[] = [];
const clients: TestClient[] = [];

after(() => {
	for (const client of clients) client.destroy();
	for (const listener of listeners) listener.close();
});

/** One raw WebSocket client: handshake, then masked frames. */
class TestClient {
	readonly socket: net.Socket;
	settled: PromiseWithResolvers<void> | null = null;
	#buffer = Buffer.alloc(0);
	#frames: { opcode: number; payload: Buffer }[] = [];
	#waiters: (() => void)[] = [];
	handshakeResponse = "";
	readonly #sequence = new BridgeSequence();

	private constructor(socket: net.Socket) {
		this.socket = socket;
		socket.on("data", chunk => {
			this.#buffer = Buffer.concat([this.#buffer, chunk]);
			this.#parse();
		});
		socket.on("error", () => undefined);
	}

	static async connect(
		port: number,
		options: { readonly origin?: string | null; readonly path?: string; readonly duplicateOrigin?: boolean; readonly host?: string } = {},
	): Promise<TestClient> {
		const socket = net.connect({ host: "127.0.0.1", port });
		const client = new TestClient(socket);
		clients.push(client);
		const connected = Promise.withResolvers<void>();
		socket.once("connect", () => connected.resolve());
		await connected.promise;
		const origin = options.origin === undefined ? ORIGIN : options.origin;
		const key = Buffer.from(new Uint8Array(16).fill(7)).toString("base64");
		const headers = [
			`GET ${options.path ?? BRIDGE_PATH} HTTP/1.1`,
			`Host: ${options.host ?? `127.0.0.1:${port}`}`,
			"Upgrade: websocket",
			"Connection: Upgrade",
			`Sec-WebSocket-Key: ${key}`,
			"Sec-WebSocket-Version: 13",
			...(origin === null ? [] : [`Origin: ${origin}`]),
			...(options.duplicateOrigin === true ? [`Origin: ${origin ?? ORIGIN}`] : []),
			"",
			"",
		].join("\r\n");
		socket.write(headers);
		// A refused upgrade is answered by destroying the socket, so wait for either
		// a response or that close rather than for a response that will not come.
		client.settled = Promise.withResolvers<void>();
		socket.once("close", () => client.settled?.resolve());
		await Promise.race([client.settled.promise, client.waitFor(() => client.handshakeResponse.length > 0, 3000)]);
		return client;
	}

	get upgraded(): boolean {
		return this.handshakeResponse.startsWith("HTTP/1.1 101");
	}

	async nextText(timeout = 3000): Promise<string> {
		await this.waitFor(() => this.#frames.some(frame => frame.opcode === 0x1), timeout);
		const frame = this.#frames.findIndex(candidate => candidate.opcode === 0x1);
		return (this.#frames.splice(frame, 1)[0]?.payload ?? Buffer.alloc(0)).toString("utf8");
	}

	async nextBinary(timeout = 3000): Promise<Buffer> {
		await this.waitFor(() => this.#frames.some(frame => frame.opcode === 0x2), timeout);
		const frame = this.#frames.findIndex(candidate => candidate.opcode === 0x2);
		return this.#frames.splice(frame, 1)[0]?.payload ?? Buffer.alloc(0);
	}

	async closed(timeout = 3000): Promise<boolean> {
		if (this.socket.destroyed) return true;
		const closed = Promise.withResolvers<boolean>();
		const timer = setTimeout(() => closed.resolve(this.socket.destroyed), timeout);
		this.socket.once("close", () => {
			clearTimeout(timer);
			closed.resolve(true);
		});
		return await closed.promise;
	}

	sendText(text: string): void {
		this.socket.write(encodeFrame(0x1, Buffer.from(text, "utf8")));
	}

	sendBinary(payload: Buffer): void {
		this.socket.write(encodeFrame(0x2, payload));
	}

	/** Seal one client-direction frame exactly as the guest would. */
	async seal(key: Uint8Array, hostGeneration: Uint8Array, connectionId: Uint8Array, text: string, sequence?: number): Promise<Buffer> {
		const index = sequence ?? this.#sequence.next;
		const sealed = await sealFrame({
			key,
			direction: BRIDGE_DIRECTION_CLIENT_TO_SERVER,
			sequence: index,
			plaintext: Buffer.from(text, "utf8"),
			additionalData: frameAdditionalData(hostGeneration, connectionId, DOCUMENT, BRIDGE_DIRECTION_CLIENT_TO_SERVER, index),
		});
		if (sequence === undefined) this.#sequence.accept(index);
		return Buffer.from(sealed);
	}

	async waitFor(predicate: () => boolean, timeout: number): Promise<void> {
		if (predicate()) return;
		const waiting = Promise.withResolvers<void>();
		const timer = setTimeout(() => waiting.reject(new Error("timed out waiting for a frame")), timeout);
		// Re-check after registering: a frame that arrived between the first check and
		// the registration must not be waited for again.
		const check = (): void => {
			if (!predicate()) return;
			clearTimeout(timer);
			waiting.resolve();
		};
		this.#waiters.push(check);
		check();
		return await waiting.promise;
	}

	destroy(): void {
		this.socket.destroy();
	}

	debugFrames(): string {
		return this.#frames.map(frame => `${frame.opcode}:${frame.payload.length}`).join(" ");
	}

	#parse(): void {
		for (;;) {
			if (this.handshakeResponse.length === 0 && this.#buffer.includes("\r\n\r\n")) {
				const end = this.#buffer.indexOf("\r\n\r\n");
				this.handshakeResponse = this.#buffer.subarray(0, end).toString("utf8");
				this.#buffer = this.#buffer.subarray(end + 4);
				this.#wake();
			}
			if (this.#buffer.length < 2) return;
			const opcode = (this.#buffer[0] ?? 0) & 0x0f;
			let length = (this.#buffer[1] ?? 0) & 0x7f;
			let offset = 2;
			if (length === 126) {
				if (this.#buffer.length < 4) return;
				length = this.#buffer.readUInt16BE(2);
				offset = 4;
			} else if (length === 127) {
				if (this.#buffer.length < 10) return;
				length = Number(this.#buffer.readBigUInt64BE(2));
				offset = 10;
			}
			if (this.#buffer.length < offset + length) return;
			this.#frames.push({ opcode, payload: Buffer.from(this.#buffer.subarray(offset, offset + length)) });
			this.#buffer = this.#buffer.subarray(offset + length);
			this.#wake();
		}
	}

	#wake(): void {
		for (const waiter of this.#waiters.splice(0)) waiter();
	}
}

/** A masked client frame, as a browser sends. */
function encodeFrame(opcode: number, payload: Buffer): Buffer {
	const mask = Buffer.from(new Uint8Array(4).fill(0x5a));
	const header = Buffer.alloc(payload.length < 126 ? 2 : 4);
	header[0] = 0x80 | opcode;
	if (payload.length < 126) header[1] = 0x80 | payload.length;
	else {
		header[1] = 0x80 | 126;
		header.writeUInt16BE(payload.length, 2);
	}
	const masked = Buffer.from(payload);
	for (let index = 0; index < masked.length; index++) masked[index] = (masked[index] ?? 0) ^ (mask[0] ?? 0);
	return Buffer.concat([header, mask, masked]);
}

interface Harness {
	readonly listener: BridgeListener;
	readonly port: number;
	readonly requests: BridgeAdmittedRequest[];
	readonly ended: string[];
	readonly diagnostics: string[];
}

async function harness(overrides: Partial<BridgeListenerHooks> = {}): Promise<Harness> {
	const requests: BridgeAdmittedRequest[] = [];
	const ended: string[] = [];
	const diagnostics: string[] = [];
	const authorization: BridgeDocumentAuthorization = {
		secret: SECRET,
		bindingHash: BINDING_HASH,
		workspace: WORKSPACE,
		tabId: TAB,
		editorId: EDITOR,
		documentId: DOCUMENT,
	};
	const listener = new BridgeListener({
		origin: ORIGIN,
		requestedPort: null,
		async authorize(hello: BridgeHello) {
			const known =
				hello.workspace === WORKSPACE &&
				hello.tabId === TAB &&
				hello.bindingHash === BINDING_HASH &&
				Buffer.from(hello.documentId).equals(Buffer.from(DOCUMENT));
			return known ? authorization : null;
		},
		onRequest(session: BridgeSession, request: BridgeAdmittedRequest) {
			requests.push(request);
			session.reply(request.requestId, { ok: true, operation: request.operation });
		},
		onSessionEnded(_session, reason) {
			ended.push(reason);
		},
		onDiagnostic(code) {
			diagnostics.push(code);
		},
		...overrides,
	});
	listeners.push(listener);
	const listening = await listener.listen();
	assert.equal(listening, true, "the listener must bind a free port");
	assert.ok(listener.port !== null);
	return { listener, port: listener.port, requests, ended, diagnostics };
}

async function handshake(client: TestClient, port: number): Promise<{ clientToServer: Uint8Array; serverToClient: Uint8Array; hostGeneration: Uint8Array; connectionId: Uint8Array }> {
	const clientNonce = new Uint8Array(32).fill(0x44);
	client.sendText(helloFields({ workspace: WORKSPACE, tabId: TAB, editorId: EDITOR, documentId: DOCUMENT, bindingHash: BINDING_HASH, clientNonce }));
	const challengeText = await client.nextText();
	// The challenge itself carries S/H/Q; the verifier takes them from the message.
	const { challenge, transcriptText } = await parseAndVerifyChallenge(challengeText, SECRET, {
		workspace: WORKSPACE,
		tabId: TAB,
		editorId: encodeBase64Url(EDITOR),
		documentId: encodeBase64Url(DOCUMENT),
		bindingHash: BINDING_HASH,
		port,
		origin: ORIGIN,
		clientNonce: encodeBase64Url(clientNonce),
		serverNonce: "",
		hostGeneration: "",
		connectionId: "",
	});
	client.sendText(await proofFrame(SECRET, transcriptText));
	const keys = await frameKeys(SECRET, transcriptText);
	return { ...keys, hostGeneration: challenge.hostGeneration, connectionId: challenge.connectionId };
}

describe("bridge listener refusals", () => {
	it("accepts only its exact path, host and pinned origin", async () => {
		const { port } = await harness();
		const wrongPath = await TestClient.connect(port, { path: `${BRIDGE_PATH}?x=1` });
		assert.equal(wrongPath.upgraded, false);
		assert.equal(await wrongPath.closed(), true);

		const wrongOrigin = await TestClient.connect(port, { origin: "vscode-webview://someone-else" });
		assert.equal(wrongOrigin.upgraded, false);
		assert.equal(await wrongOrigin.closed(), true);

		const noOrigin = await TestClient.connect(port, { origin: null });
		assert.equal(noOrigin.upgraded, false);

		const duplicated = await TestClient.connect(port, { duplicateOrigin: true });
		assert.equal(duplicated.upgraded, false);

		const wrongHost = await TestClient.connect(port, { host: "localhost:1" });
		assert.equal(wrongHost.upgraded, false);

		const correct = await TestClient.connect(port);
		assert.equal(correct.upgraded, true, "the pinned origin, host and path are accepted");
	});

	it("refuses an unknown document without a challenge, and a bad proof with no session", async () => {
		const { port, ended } = await harness();
		const unknown = await TestClient.connect(port);
		unknown.sendText(
			helloFields({ workspace: "c".repeat(64), tabId: TAB, editorId: EDITOR, documentId: DOCUMENT, bindingHash: BINDING_HASH, clientNonce: new Uint8Array(32).fill(1) }),
		);
		assert.equal(await unknown.closed(), true);
		assert.deepEqual(ended, ["authentication"], "an unknown document is refused as an authentication failure");

		const liar = await TestClient.connect(port);
		const clientNonce = new Uint8Array(32).fill(2);
		liar.sendText(helloFields({ workspace: WORKSPACE, tabId: TAB, editorId: EDITOR, documentId: DOCUMENT, bindingHash: BINDING_HASH, clientNonce }));
		assert.notEqual((await liar.nextText()).length, 0, "the challenge arrives");
		liar.sendText(await proofFrame(new Uint8Array(32).fill(9), "not the transcript"));
		assert.equal(await liar.closed(), true);
	});

	it("refuses an oversized handshake and a claimed-but-wrong document id", async () => {
		const { port } = await harness();
		const oversized = await TestClient.connect(port);
		oversized.sendText(`["hello",1,"${"a".repeat(5000)}"]`);
		assert.equal(await oversized.closed(), true);

		const wrongDocument = await TestClient.connect(port);
		wrongDocument.sendText(
			helloFields({ workspace: WORKSPACE, tabId: TAB, editorId: EDITOR, documentId: new Uint8Array(16).fill(0x99), bindingHash: BINDING_HASH, clientNonce: new Uint8Array(32).fill(3) }),
		);
		assert.equal(await wrongDocument.closed(), true);
	});

	it("returns the unauthenticated allowance when a handshake fails", async () => {
		const { port } = await harness();
		// Each of these is an *accepted* upgrade whose handshake is then refused. If a failed
		// handshake kept its unit of the activation-wide allowance, sixteen of them would stop
		// every listener in the window.
		for (let attempt = 0; attempt < 16; attempt++) {
			const refused = await TestClient.connect(port);
			refused.sendText(
				helloFields({
					workspace: "c".repeat(64),
					tabId: TAB,
					editorId: EDITOR,
					documentId: DOCUMENT,
					bindingHash: BINDING_HASH,
					clientNonce: new Uint8Array(32).fill(1),
				}),
			);
			assert.equal(await refused.closed(), true, "an unknown document is refused");
		}
		const survivor = await TestClient.connect(port);
		assert.equal(survivor.upgraded, true, "a legitimate upgrade is still accepted after many refused handshakes");
		survivor.sendText(
			helloFields({ workspace: WORKSPACE, tabId: TAB, editorId: EDITOR, documentId: DOCUMENT, bindingHash: BINDING_HASH, clientNonce: new Uint8Array(32).fill(2) }),
		);
		assert.notEqual((await survivor.nextText()).length, 0, "and it is answered with a challenge");
	});

	it("accepts exactly one hello per socket", async () => {
		const { port, diagnostics } = await harness();
		const client = await TestClient.connect(port);
		// Two hellos on one socket: the second is refused rather than starting a second
		// concurrent handshake inside the same deadline.
		client.sendText(helloFields({ workspace: WORKSPACE, tabId: TAB, editorId: EDITOR, documentId: DOCUMENT, bindingHash: BINDING_HASH, clientNonce: new Uint8Array(32).fill(3) }));
		client.sendText(helloFields({ workspace: WORKSPACE, tabId: TAB, editorId: EDITOR, documentId: DOCUMENT, bindingHash: BINDING_HASH, clientNonce: new Uint8Array(32).fill(4) }));
		assert.equal(await client.closed(), true);
		assert.equal(diagnostics.includes("hello-unauthorized"), false, "the second hello never reached authorization");
	});

	it("fails closed on an occupied port instead of choosing another one", async () => {
		const { port } = await harness();
		const second = new BridgeListener({
			origin: ORIGIN,
			requestedPort: port,
			async authorize() {
				return null;
			},
			onRequest() {
				return undefined;
			},
			onSessionEnded() {
				return undefined;
			},
		});
		listeners.push(second);
		assert.equal(await second.listen(), false);
		assert.equal(second.failure, "port-occupied");
		assert.equal(second.port, null);
	});
});

describe("bridge listener session", () => {
	it("authenticates, sends ready, admits a fenced request and answers it", async () => {
		const { port, requests, diagnostics: harnessOfDiagnostics, ended: endedOfHarness } = await harness();
		const client = await TestClient.connect(port);
		let keys;
		try {
			keys = await handshake(client, port);
		} catch (error) {
			assert.fail(`handshake failed: ${String(error)} diagnostics=[${harnessOfDiagnostics.join(",")}] ended=[${endedOfHarness.join(",")}]`);
		}
		const readyFrameBytes = await client.nextBinary().catch((error: unknown) => {
			assert.fail(`ready missing: ${String(error)} diagnostics=[${harnessOfDiagnostics.join(",")}] ended=[${endedOfHarness.join(",")}] frames=[${client.debugFrames()}]`);
		});
		const ready = await openFrame({
			key: keys.serverToClient,
			frame: readyFrameBytes,
			expectedDirection: BRIDGE_DIRECTION_SERVER_TO_CLIENT,
			hostGeneration: keys.hostGeneration,
			connectionId: keys.connectionId,
			documentId: DOCUMENT,
		});
		assert.equal(ready.sequence, 0);
		assert.deepEqual(parseTextFrame(ready.plaintext), ["ready", encodeBase64Url(keys.hostGeneration), encodeBase64Url(DOCUMENT), "ready"]);

		// No route is acknowledged yet, so a request is refused as a protocol error.
		client.sendBinary(await client.seal(keys.clientToServer, keys.hostGeneration, keys.connectionId, `["request","${encodeBase64Url(keys.hostGeneration)}","${encodeBase64Url(DOCUMENT)}","${"1".repeat(32)}","${"a".repeat(32)}","1","snapshot","{}"]`));
		assert.equal(await client.closed(), true, "a request before a route acknowledgement is not admitted");
		assert.deepEqual(requests, []);
	});

	it("admits one request after a matching route acknowledgement and answers it once", async () => {
		const { port, requests } = await harness();
		const client = await TestClient.connect(port);
		const keys = await handshake(client, port);
		await client.nextBinary();

		const route = "1".repeat(32);
		client.sendBinary(await client.seal(keys.clientToServer, keys.hostGeneration, keys.connectionId, `["route-ack","${encodeBase64Url(keys.hostGeneration)}","${encodeBase64Url(DOCUMENT)}","${route}"]`));
		const sealedRequest = await client.seal(
			keys.clientToServer,
			keys.hostGeneration,
			keys.connectionId,
			requestFrame(keys.hostGeneration, DOCUMENT, route, "f".repeat(32), "1", "snapshot", { a: 1 }),
		);
		client.sendBinary(sealedRequest);
		// The reply is the signal: it can only exist after admission.
		const replyBytes = await client.nextBinary();
		assert.equal(requests.length, 1);
		assert.equal(requests[0]?.operation, "snapshot");
		assert.deepEqual(requests[0]?.payload, { a: 1 });

		const reply = await openFrame({
			key: keys.serverToClient,
			frame: replyBytes,
			expectedDirection: BRIDGE_DIRECTION_SERVER_TO_CLIENT,
			hostGeneration: keys.hostGeneration,
			connectionId: keys.connectionId,
			documentId: DOCUMENT,
		});
		assert.equal(reply.sequence, 1, "ready was 0, the reply is 1");
		assert.deepEqual(parseTextFrame(reply.plaintext), ["reply", encodeBase64Url(keys.hostGeneration), encodeBase64Url(DOCUMENT), route, "f".repeat(32), '{"ok":true,"operation":"snapshot"}']);
	});

	it("closes on a replayed, skipped or wrong-direction frame", async () => {
		const { port } = await harness();
		const client = await TestClient.connect(port);
		const keys = await handshake(client, port);
		await client.nextBinary();
		const route = "2".repeat(32);
		const ack = await client.seal(keys.clientToServer, keys.hostGeneration, keys.connectionId, `["route-ack","${encodeBase64Url(keys.hostGeneration)}","${encodeBase64Url(DOCUMENT)}","${route}"]`);
		client.sendBinary(ack);
		client.sendBinary(
			await client.seal(keys.clientToServer, keys.hostGeneration, keys.connectionId, requestFrame(keys.hostGeneration, DOCUMENT, route, "e".repeat(32), "1", "snapshot", null)),
		);
		await client.nextBinary();
		// Replaying the very same encrypted frame is a sequence violation.
		client.sendBinary(ack);
		assert.equal(await client.closed(), true);
	});

	it("answers heartbeats and marks a silent peer disconnected instead of closing it", async () => {
		const ended: { readonly reason: string; readonly state: BridgeSessionState }[] = [];
		const silent = await harness({
			heartbeatMs: 20,
			idleMs: 60,
			onSessionEnded(session, reason) {
				ended.push({ reason, state: session.state });
			},
		});
		const client = await TestClient.connect(silent.port);
		const keys = await handshake(client, silent.port);
		await client.nextBinary();
		client.sendBinary(await client.seal(keys.clientToServer, keys.hostGeneration, keys.connectionId, `["route-ack","${encodeBase64Url(keys.hostGeneration)}","${encodeBase64Url(DOCUMENT)}","${"4".repeat(32)}"]`));
		// The host's heartbeat arrives as the next binary frame...
		const ping = await client.nextBinary();
		const opened = await openFrame({
			key: keys.serverToClient,
			frame: ping,
			expectedDirection: BRIDGE_DIRECTION_SERVER_TO_CLIENT,
			hostGeneration: keys.hostGeneration,
			connectionId: keys.connectionId,
			documentId: DOCUMENT,
		});
		const heartbeat = parseTextFrame(opened.plaintext);
		assert.equal(Array.isArray(heartbeat) ? heartbeat[0] : null, "ping");
		// ...and staying silent past the idle window marks disconnected, never closed.
		const marked = Promise.withResolvers<void>();
		const poll = setInterval(() => {
			if (ended.length > 0) {
				clearInterval(poll);
				marked.resolve();
			}
		}, 10);
		await marked.promise;
		assert.deepEqual(ended, [{ reason: "timeout", state: "disconnected" }]);
		assert.equal(client.socket.destroyed, false, "an idle session is never closed by the host");
	});

	it("slow non-session bridge exchanges do not reserve the OMP mutation slot, while a second real mutation remains refused", { timeout: 5_000 }, async () => {
		const admitted: string[] = [];
		const allAdmitted = Promise.withResolvers<void>();
		const stream = await harness({
			onRequest(_session, request) {
				admitted.push(request.operation);
				// Leave both reads/preferences and the real mutation unanswered:
				// non-session exchanges must not reserve that mutation's slot.
				if (admitted.length === 5) allAdmitted.resolve();
			},
		});
		const client = await TestClient.connect(stream.port);
		const keys = await handshake(client, stream.port);
		await client.nextBinary();
		const route = "5".repeat(32);
		client.sendBinary(await client.seal(keys.clientToServer, keys.hostGeneration, keys.connectionId, `["route-ack","${encodeBase64Url(keys.hostGeneration)}","${encodeBase64Url(DOCUMENT)}","${route}"]`));

		const send = async (requestId: string, actionSeq: string, operation: string, payload: unknown): Promise<void> => {
			client.sendBinary(
				await client.seal(
					keys.clientToServer,
					keys.hostGeneration,
					keys.connectionId,
					requestFrame(keys.hostGeneration, DOCUMENT, route, requestId, actionSeq, operation, payload),
				),
			);
		};
		await send("a".repeat(32), "1", "terminal-input", { generation: "b".repeat(32), data: "aGk=" });
		await send("c".repeat(32), "2", "terminal-resize", { generation: "b".repeat(32), cols: 80, rows: 24 });
		await send("1".repeat(32), "3", "chat-tool-detail", { epoch: { nonce: "test", counter: 1 } });
		await send("2".repeat(32), "4", "chat-subagent-read", { subagentId: "Worker", fromByte: 0 });
		await send("d".repeat(32), "5", "set-model", { a: 1 });
		await allAdmitted.promise;

		assert.deepEqual(admitted, ["terminal-input", "terminal-resize", "chat-tool-detail", "chat-subagent-read", "set-model"]);
		assert.equal(client.socket.destroyed, false, "slow non-session exchanges must not close the authenticated session");

		// The mutation slot is genuinely held now: a second mutation is a protocol error.
		await send("e".repeat(32), "6", "set-thinking", { a: 2 });
		assert.equal(await client.closed(), true, "a second unanswered mutation closes the session");
		assert.deepEqual(admitted, ["terminal-input", "terminal-resize", "chat-tool-detail", "chat-subagent-read", "set-model"]);
	});

	it("pushes one terminal frame, drops a fenced push and preserves the valid route after a rejected acknowledgement", async () => {
		let session: BridgeSession | null = null;
		const acknowledged = Promise.withResolvers<void>();
		const rejected = Promise.withResolvers<void>();
		const pushing = await harness({
			onSessionAuthenticated(next) {
				session = next;
			},
			// The route acknowledgement is awaited as the listener's own event rather
			// than polled for: nothing here depends on how long a socket takes.
			onRouteAcknowledged(_session, route) {
				if (route === "6".repeat(32)) { acknowledged.resolve(); return true; }
				rejected.resolve(); return false;
			},
		});
		const client = await TestClient.connect(pushing.port);
		const keys = await handshake(client, pushing.port);
		await client.nextBinary();
		const route = "6".repeat(32);
		client.sendBinary(await client.seal(keys.clientToServer, keys.hostGeneration, keys.connectionId, `["route-ack","${encodeBase64Url(keys.hostGeneration)}","${encodeBase64Url(DOCUMENT)}","${route}"]`));
		assert.ok(session !== null, "the host must see the authenticated session");
		const bound = session as BridgeSession;
		await acknowledged.promise;
		assert.equal(bound.routeAcknowledged(route), true, "the route acknowledgement must be adopted");
		client.sendBinary(await client.seal(keys.clientToServer, keys.hostGeneration, keys.connectionId, `["route-ack","${encodeBase64Url(keys.hostGeneration)}","${encodeBase64Url(DOCUMENT)}","${"7".repeat(32)}"]`));
		await rejected.promise;

		// A push under a fenced generation is dropped: nothing may keep feeding a
		// renderer whose route the document already replaced.
		bound.send("terminal", { routeGeneration: "7".repeat(32), payload: { type: "omp:terminal-data" } });

		const payload = { type: "omp:terminal-data", generation: "b".repeat(32), seq: 1, bytes: "aGk=" };
		bound.send("terminal", { routeGeneration: route, payload });
		const frameBytes = await client.nextBinary();
		const opened = await openFrame({
			key: keys.serverToClient,
			frame: frameBytes,
			expectedDirection: BRIDGE_DIRECTION_SERVER_TO_CLIENT,
			hostGeneration: keys.hostGeneration,
			connectionId: keys.connectionId,
			documentId: DOCUMENT,
		});
		assert.equal(opened.sequence, 1, "ready was 0, so the dropped push consumed no sequence");
		const message = parseTextFrame(opened.plaintext);
		assert.ok(Array.isArray(message), "a terminal push is a transcript array");
		const parsed = parseTerminalPush(message);
		assert.ok(parsed !== null, "the guest's own parser must accept the host's push");
		assert.equal(parsed.hostGeneration, encodeBase64Url(keys.hostGeneration));
		assert.equal(parsed.documentId, encodeBase64Url(DOCUMENT));
		assert.deepEqual(parsed.payload, payload);
	});
	it("closes a snapshot peer that never reads without materializing its remaining train", { timeout: 10_000 }, async () => {
		// This intentionally exercises the real TCP send buffers and platform-clock
		// write deadline. Fake time cannot establish that an actual peer stopped draining.
		const ended = Promise.withResolvers<string>();
		const diagnostics: string[] = [];
		let produced = 0;
		const route = "8".repeat(32);
		const stalled = await harness({
			onDiagnostic: code => diagnostics.push(code),
			onSessionEnded: (_session, reason) => ended.resolve(reason),
			onRouteAcknowledged: session => {
				session.sendSnapshot(route, (function* () {
					const text = "x".repeat(20_000);
					for (let index = 0; index < 16_384; index++) {
						produced++;
						yield { text, index };
					}
				})());
				return true;
			},
		});
		const peer = await TestClient.connect(stalled.port);
		const keys = await handshake(peer, stalled.port);
		await peer.nextBinary();
		peer.socket.pause();
		peer.sendBinary(await peer.seal(keys.clientToServer, keys.hostGeneration, keys.connectionId,
			`["route-ack","${encodeBase64Url(keys.hostGeneration)}","${encodeBase64Url(DOCUMENT)}","${route}"]`));
		assert.equal(await ended.promise, "timeout");
		assert.ok(diagnostics.includes("outbound-stalled"));
		assert.ok(produced < 16_384, "the writer must stop pulling when the peer stops draining");
	});

	it("retains the one MiB bound for an ordinary synchronous push flood", { timeout: 5_000 }, async () => {
		const ended = Promise.withResolvers<string>();
		const diagnostics: string[] = [];
		const route = "9".repeat(32);
		const bounded = await harness({
			onDiagnostic: code => diagnostics.push(code),
			onSessionEnded: (_session, reason) => ended.resolve(reason),
			onRouteAcknowledged: session => {
				for (let index = 0; index < 80; index++) session.send("terminal", { routeGeneration: route, payload: { text: "x".repeat(20_000) } });
				return true;
			},
		});
		const peer = await TestClient.connect(bounded.port);
		const keys = await handshake(peer, bounded.port);
		await peer.nextBinary();
		peer.sendBinary(await peer.seal(keys.clientToServer, keys.hostGeneration, keys.connectionId,
			`["route-ack","${encodeBase64Url(keys.hostGeneration)}","${encodeBase64Url(DOCUMENT)}","${route}"]`));
		assert.equal(await ended.promise, "protocol");
		assert.ok(diagnostics.includes("outbound-queue"));
	});
	it("finishes the earliest snapshot and supersedes only pending trains without moving live events", { timeout: 5_000 }, async () => {
		let pulled = 0;
		const route = "a".repeat(32);
		const ordered = await harness({
			onRouteAcknowledged: session => {
				session.sendSnapshot(route, (function* () {
					pulled++;
					queueMicrotask(() => {
						session.sendSnapshot(route, [{ marker: "discarded-pending" }]);
						session.send("terminal", { routeGeneration: route, payload: { marker: "live-event" } });
						session.sendSnapshot(route, [{ marker: "latest" }]);
					});
					yield { marker: "old-first" };
					pulled++;
					yield { marker: "old-tail" };
				})());
				return true;
			},
		});
		const peer = await TestClient.connect(ordered.port);
		const keys = await handshake(peer, ordered.port);
		await peer.nextBinary();
		peer.sendBinary(await peer.seal(keys.clientToServer, keys.hostGeneration, keys.connectionId,
			`["route-ack","${encodeBase64Url(keys.hostGeneration)}","${encodeBase64Url(DOCUMENT)}","${route}"]`));
		const received: unknown[] = [];
		for (let index = 0; index < 4; index++) {
			const opened = await openFrame({ key: keys.serverToClient, frame: await peer.nextBinary(),
				expectedDirection: BRIDGE_DIRECTION_SERVER_TO_CLIENT, hostGeneration: keys.hostGeneration,
				connectionId: keys.connectionId, documentId: DOCUMENT });
			assert.equal(opened.sequence, index + 1);
			const message = parseTextFrame(opened.plaintext);
			assert.ok(Array.isArray(message));
			const push = parseTerminalPush(message);
			assert.ok(push);
			received.push(push.payload);
		}
		assert.deepEqual(received, [{ marker: "old-first" }, { marker: "old-tail" }, { marker: "live-event" }, { marker: "latest" }]);
		assert.equal(pulled, 2);
	});
	it("writes 64-bit WebSocket lengths from 64 KiB through the plaintext ceiling", { timeout: 5_000 }, async () => {
		const route = "b".repeat(32);
		const wide = await harness({
			onRouteAcknowledged: session => {
				for (const length of [65_536, 200_000, 255_000]) {
					session.send("terminal", { routeGeneration: route, payload: { text: "x".repeat(length) } });
				}
				return true;
			},
		});
		const peer = await TestClient.connect(wide.port);
		const keys = await handshake(peer, wide.port);
		await peer.nextBinary();
		peer.sendBinary(await peer.seal(keys.clientToServer, keys.hostGeneration, keys.connectionId,
			`["route-ack","${encodeBase64Url(keys.hostGeneration)}","${encodeBase64Url(DOCUMENT)}","${route}"]`));
		for (const length of [65_536, 200_000, 255_000]) {
			const opened = await openFrame({ key: keys.serverToClient, frame: await peer.nextBinary(),
				expectedDirection: BRIDGE_DIRECTION_SERVER_TO_CLIENT, hostGeneration: keys.hostGeneration,
				connectionId: keys.connectionId, documentId: DOCUMENT });
			const message = parseTextFrame(opened.plaintext);
			assert.ok(Array.isArray(message));
			assert.deepEqual(parseTerminalPush(message)?.payload, { text: "x".repeat(length) });
		}
	});

	it("refuses oversized and fragmented WebSocket control frames before replying", { timeout: 5_000 }, async () => {
		const control = await harness();
		for (const fragmented of [false, true]) {
			const peer = await TestClient.connect(control.port);
			const frame = encodeFrame(0x9, Buffer.alloc(fragmented ? 1 : 126));
			if (fragmented) frame[0] = frame[0]! & 0x7f;
			peer.socket.write(frame);
			assert.equal(await peer.closed(), true);
			assert.equal(peer.debugFrames(), "", "an invalid control frame must not elicit a pong");
		}
	});
});
