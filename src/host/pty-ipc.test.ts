/**
 * Tests for the PTY broker's loopback transport.
 *
 * Runner: `node --test src/host/pty-ipc.test.ts`
 *
 * The broker has no other door: everything a caller can do to a terminal goes
 * through this socket. What matters is that a peer without the token cannot open one,
 * that a peer naming another generation is turned away rather than confused with the
 * broker it asks for, that a frame not authenticated by the connection's own key
 * closes that connection, and that a peer which never authenticates cannot occupy the
 * broker at all.
 *
 * Every wait is an event: a connection arriving, a line arriving, a socket closing.
 * Nothing polls on a guessed duration, so a failure names the missing signal rather
 * than a timeout.
 */

import assert from "node:assert/strict";
import { connect } from "node:net";
import { after, describe, it } from "node:test";
import {
	PTY_LOOPBACK_HOST,
	connectPtyBroker,
	createLineReader,
	startPtyBrokerServer,
	type PtyBrokerServer,
	type PtyBrokerSideConnection,
} from "./pty-ipc.ts";
import {
	PTY_PROTOCOL_VERSION,
	createPtyGeneration,
	createPtyNonce,
	createPtyToken,
	derivePtySessionId,
	derivePtySessionKey,
	ptyHelloMac,
	type PtyBrokerFrame,
	type PtyHelloOk,
} from "./pty-protocol.ts";

const IDENTITY = {
	brokerId: "pty-11111111-2222-3333-4444-555555555555",
	slot: "tab:1",
	kind: "managed-omp" as const,
	treeDigest: "b".repeat(64),
	brokerPid: 4242,
	brokerCreationTime: "134349421014308869",
};

interface Harness {
	readonly server: PtyBrokerServer;
	readonly token: string;
	readonly generation: string;
	readonly closed: string[];
	/** The next connection the broker accepts. */
	nextConnection(): Promise<PtyBrokerSideConnection>;
}

const harnesses: Harness[] = [];

async function start(options: { readonly maxClients?: number; readonly handshakeTimeoutMs?: number } = {}): Promise<Harness> {
	const token = createPtyToken();
	const generation = createPtyGeneration();
	const server = await startPtyBrokerServer({
		...IDENTITY,
		token,
		generation,
		protocolVersion: PTY_PROTOCOL_VERSION,
		runtimeVersion: 1,
		brokerPid: process.pid,
		brokerCreationTime: null,
		...(options.maxClients === undefined ? {} : { maxClients: options.maxClients }),
		...(options.handshakeTimeoutMs === undefined ? {} : { handshakeTimeoutMs: options.handshakeTimeoutMs }),
	});
	const pending: Array<(connection: PtyBrokerSideConnection) => void> = [];
	const accepted: PtyBrokerSideConnection[] = [];
	const closed: string[] = [];
	server.onConnection(connection => {
		connection.onClosed(reason => closed.push(reason));
		const waiter = pending.shift();
		if (waiter !== undefined) waiter(connection);
		else accepted.push(connection);
	});
	const harness: Harness = {
		server,
		token,
		generation,
		closed,
		nextConnection() {
			const ready = accepted.shift();
			if (ready !== undefined) return Promise.resolve(ready);
			return new Promise<PtyBrokerSideConnection>(resolve => pending.push(resolve));
		},
	};
	harnesses.push(harness);
	return harness;
}

after(async () => {
	for (const harness of harnesses) await harness.server.close();
});

/** A peer that speaks the opening frame by hand, for the refusal cases. */
function rawPeer(port: number): {
	readonly send: (frame: unknown) => void;
	readonly write: (text: string) => void;
	readonly closed: Promise<void>;
	/** The next line matching `match`, which resolves as soon as it arrives. */
	next(match: (line: string) => boolean): Promise<string>;
	/** Stop reading from the socket, as a peer that walked away would. */
	pause(): void;
} {
	const lines: string[] = [];
	const waiting: Array<{ match: (line: string) => boolean; resolve: (line: string) => void }> = [];
	let buffered = "";
	const socket = connect({ host: PTY_LOOPBACK_HOST, port });
	socket.setEncoding("utf8");
	socket.on("data", chunk => {
		buffered += chunk;
		for (;;) {
			const newline = buffered.indexOf("\n");
			if (newline < 0) break;
			const line = buffered.slice(0, newline);
			buffered = buffered.slice(newline + 1);
			lines.push(line);
			const index = waiting.findIndex(entry => entry.match(line));
			if (index >= 0) {
				const entry = waiting.splice(index, 1)[0];
				entry?.resolve(line);
			}
		}
	});
	const closed = Promise.withResolvers<void>();
	socket.on("close", () => closed.resolve());
	socket.on("error", () => closed.resolve());
	return {
		send: frame => socket.write(`${JSON.stringify(frame)}\n`),
		write: text => socket.write(text),
		pause: () => socket.pause(),
		closed: closed.promise,
		next: match => {
			const already = lines.find(line => match(line));
			if (already !== undefined) return Promise.resolve(already);
			return new Promise<string>(resolve => waiting.push({ match, resolve }));
		},
	};
}

/**
 * The line framing both the handshake and the frame stream use.
 *
 * The handshake reads exactly one line and leaves the rest of the chunk to the frame
 * reader, so the reader must be able to give a taken line back *with its delimiter*.
 * Appending it instead splices it into the next bytes and hands the frame reader two
 * frames joined into one, which surfaces as `frame is not JSON` when `hello-ok` and
 * the broker's first status frame arrive in one TCP segment.
 */
describe("line framing", () => {
	it("keeps line boundaries when a handshake line is put back", () => {
		const reader = createLineReader();
		reader.push(`{"t":"hello-ok"}\n{"t":"status"}\n`);

		assert.equal(reader.take(), `{"t":"hello-ok"}`);
		const leftover = reader.take();
		assert.equal(leftover, `{"t":"status"}`);
		assert.ok(leftover !== null);
		reader.unshift(leftover);
		// The next frame the broker writes shares the chunk with the restored line.
		reader.push(`{"t":"notice"}\n`);

		assert.equal(reader.take(), `{"t":"status"}`, "the restored line is a frame of its own");
		assert.equal(reader.take(), `{"t":"notice"}`);
		assert.equal(reader.take(), null);
	});

	it("keeps an incomplete tail across the handshake", () => {
		const reader = createLineReader();
		reader.push(`{"t":"hello-ok"}\n{"t":"stat`);

		assert.equal(reader.take(), `{"t":"hello-ok"}`);
		assert.equal(reader.take(), null, "a partial line is not a line");
		assert.equal(reader.take(), null);
		reader.push(`us"}\n`);

		assert.equal(reader.take(), `{"t":"status"}`);
	});
});

describe("handshake", () => {
	it("carries frames both ways once the peer proves the token", async () => {
		const harness = await start();
		const connection = await connectPtyBroker({
			token: harness.token,
			brokerId: IDENTITY.brokerId,
			generation: harness.generation,
			port: harness.server.port,
		});
		try {
			assert.equal(connection.hello.slot, "tab:1");
			// The broker's own process id, which the client checks against its own
			// kernel reading of the record's pid.
			assert.equal(connection.hello.brokerPid, process.pid);
			assert.equal(connection.sessionId, derivePtySessionId(connection.sessionKey));

			const fromBroker = Promise.withResolvers<PtyBrokerFrame>();
			connection.onFrame(frame => fromBroker.resolve(frame));
			const accepted = await harness.nextConnection();
			const toBroker = Promise.withResolvers<import("./pty-protocol.ts").PtyClientFrame>();
			accepted.onFrame(frame => toBroker.resolve(frame));

			accepted.send({ v: PTY_PROTOCOL_VERSION, t: "state", status: statusPayload() });
			assert.equal((await fromBroker.promise).t, "state");

			connection.send({ v: PTY_PROTOCOL_VERSION, t: "status", id: 1 });
			assert.equal((await toBroker.promise).t, "status");
		} finally {
			connection.close();
		}
	});

	it("refuses a peer that does not hold the token, and one that names another generation", async () => {
		const harness = await start();
		const wrongToken = createPtyToken();
		const firstNonce = createPtyNonce();
		const peer = rawPeer(harness.server.port);
		peer.send({
			v: PTY_PROTOCOL_VERSION,
			t: "hello",
			brokerId: IDENTITY.brokerId,
			generation: harness.generation,
			clientNonce: firstNonce,
			mac: ptyHelloMac(wrongToken, {
				brokerId: IDENTITY.brokerId,
				generation: harness.generation,
				clientNonce: firstNonce,
			}),
		});
		assert.match(await peer.next(line => line.length > 0), /unauthorized/);
		await peer.closed;

		const secondNonce = createPtyNonce();
		const other = rawPeer(harness.server.port);
		other.send({
			v: PTY_PROTOCOL_VERSION,
			t: "hello",
			brokerId: IDENTITY.brokerId,
			generation: createPtyGeneration(),
			clientNonce: secondNonce,
			mac: ptyHelloMac(harness.token, {
				brokerId: IDENTITY.brokerId,
				generation: harness.generation,
				clientNonce: secondNonce,
			}),
		});
		assert.match(await other.next(line => line.length > 0), /generation-mismatch/);
		await other.closed;
	});

	it("turns away a peer that never authenticates, and refuses junk rather than parsing it", async () => {
		const harness = await start({ handshakeTimeoutMs: 150 });
		const silent = rawPeer(harness.server.port);
		await silent.closed;

		const noisy = rawPeer(harness.server.port);
		noisy.write("this is not a frame\n");
		assert.match(await noisy.next(line => line.length > 0), /malformed/);
		await noisy.closed;
	});

	it("refuses a connection beyond its bound instead of queueing it", async () => {
		const harness = await start({ maxClients: 1 });
		const first = await connectPtyBroker({
			token: harness.token,
			brokerId: IDENTITY.brokerId,
			generation: harness.generation,
			port: harness.server.port,
		});
		try {
			await harness.nextConnection();
			await assert.rejects(
				connectPtyBroker({
					token: harness.token,
					brokerId: IDENTITY.brokerId,
					generation: harness.generation,
					port: harness.server.port,
				}),
				/busy/,
			);
		} finally {
			first.close();
		}
	});
});

describe("a frame listener that throws", () => {
	it("closes the connection instead of silently abandoning the frames behind it", async () => {
		const harness = await start();
		const connection = await connectPtyBroker({
			token: harness.token,
			brokerId: IDENTITY.brokerId,
			generation: harness.generation,
			port: harness.server.port,
		});
		const closed = Promise.withResolvers<string>();
		connection.onClosed(reason => closed.resolve(reason));
		connection.onFrame(() => {
			throw new Error("listener bug");
		});
		const accepted = await harness.nextConnection();
		accepted.send({ v: PTY_PROTOCOL_VERSION, t: "state", status: statusPayload() });
		accepted.send({ v: PTY_PROTOCOL_VERSION, t: "state", status: statusPayload() });
		assert.equal(await closed.promise, "a frame listener failed", "the owner learns the stream is broken and can reattach");
	});
});

describe("authenticated frames", () => {
	it("closes a connection whose frame is not proofed by its own key", async () => {
		const harness = await start();
		const peer = rawPeer(harness.server.port);
		const clientNonce = createPtyNonce();
		peer.send({
			v: PTY_PROTOCOL_VERSION,
			t: "hello",
			brokerId: IDENTITY.brokerId,
			generation: harness.generation,
			clientNonce,
			mac: ptyHelloMac(harness.token, {
				brokerId: IDENTITY.brokerId,
				generation: harness.generation,
				clientNonce,
			}),
		});
		const answer = JSON.parse(await peer.next(line => line.includes("hello-ok"))) as PtyHelloOk;
		assert.equal(answer.slot, "tab:1");
		const connection = await harness.nextConnection();
		// A well-formed frame with a proof that is not this connection's: the sequence
		// number is right, the MAC is not.
		peer.write(`${JSON.stringify({ v: PTY_PROTOCOL_VERSION, t: "ack", id: 1, ok: true, seq: 1, mac: "A".repeat(43) })}\n`);
		await peer.closed;
		assert.equal(harness.closed.length, 1);
		assert.match(harness.closed[0] ?? "", /proof/);
		assert.equal(connection.closed, true);
	});
});

describe("backpressure", () => {
	it("disconnects a peer that stops reading instead of buffering without limit", async () => {
		const harness = await start();
		const peer = rawPeer(harness.server.port);
		const clientNonce = createPtyNonce();
		peer.send({
			v: PTY_PROTOCOL_VERSION,
			t: "hello",
			brokerId: IDENTITY.brokerId,
			generation: harness.generation,
			clientNonce,
			mac: ptyHelloMac(harness.token, {
				brokerId: IDENTITY.brokerId,
				generation: harness.generation,
				clientNonce,
			}),
		});
		await peer.next(line => line.includes("hello-ok"));
		const connection = await harness.nextConnection();
		const closed = Promise.withResolvers<string>();
		connection.onClosed(reason => closed.resolve(reason));
		// The peer stops reading: the frames it is sent can no longer drain, so the broker
		// must disconnect it rather than hold an unbounded amount of terminal output.
		peer.pause();
		const chunk = "x".repeat(32 * 1024);
		for (let index = 0; index < 400 && !connection.closed; index += 1) {
			connection.send({ v: PTY_PROTOCOL_VERSION, t: "output", fromPosition: index * chunk.length, data: chunk });
		}
		assert.equal(connection.closed, true, "the broker kept writing to a peer that stopped reading");
		assert.match(await closed.promise, /stopped reading/);
	});
});

/** A status payload that satisfies the protocol's own validator. */
function statusPayload() {
	return {
		state: "running" as const,
		exitCode: null,
		signal: null,
		cols: 80,
		rows: 24,
		alt: false,
		title: null,
		nativePid: 4243,
		nativeCreationTime: null,
		brokerPid: IDENTITY.brokerPid,
		brokerCreationTime: null,
		clients: 1,
		inputOwner: null,
		uptimeMs: 1,
		noClientForMs: null,
		childExitedAtMs: null,
		outputPosition: 0,
		oldestPosition: 0,
		notices: [],
		ownerStop: {
			state: "not-applicable" as const,
			detail: "a managed OMP host is never stopped by an owner watch",
			owners: [],
			graceRemainingMs: null,
		},
	};
}
