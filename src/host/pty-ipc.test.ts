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
import { connect, createServer, type AddressInfo, type Socket } from "node:net";
import { after, describe, it } from "node:test";
import {
	PTY_LOOPBACK_HOST,
	connectPtyBroker,
	createLineReader,
	startPtyBrokerServer,
	type PtyBrokerServer,
	type PtyBrokerSideConnection,
} from "./pty-ipc.ts";
import { startLoopLagMonitor } from "./loop-lag.ts";
import {
	PTY_MAX_FRAME_BYTES,
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

	it("accepts one chunk of many complete small lines that total above the frame bound", () => {
		const reader = createLineReader();
		const lines = Array.from({ length: 4096 }, (_, index) => `${index}:${"x".repeat(125)}`);
		const chunk = `${lines.join("\n")}\n`;
		assert.ok(chunk.length > PTY_MAX_FRAME_BYTES * 1.5, "the chunk must be well above one frame");

		assert.deepEqual(reader.push(chunk), { overflow: false });
		for (const expected of lines) assert.equal(reader.take(), expected);
		assert.equal(reader.take(), null);
	});

	it("accepts one complete line at the frame bound inside a larger chunk", () => {
		const reader = createLineReader();
		const atBound = "y".repeat(PTY_MAX_FRAME_BYTES);

		assert.deepEqual(reader.push(`${atBound}\n${atBound}\n`), { overflow: false });
		assert.equal(reader.take(), atBound);
		assert.equal(reader.take(), atBound);
	});

	it("refuses a complete line longer than the frame bound, whatever else the chunk holds", () => {
		const reader = createLineReader();
		const tooLong = "z".repeat(PTY_MAX_FRAME_BYTES + 1);

		assert.deepEqual(reader.push(`{"t":"ok"}\n${tooLong}\n`), { overflow: true });
		assert.equal(reader.take(), null, "a refused push leaves nothing to read");
	});

	it("refuses an unterminated tail longer than the frame bound", () => {
		const reader = createLineReader();

		assert.deepEqual(reader.push(`{"t":"ok"}\n${"z".repeat(PTY_MAX_FRAME_BYTES + 1)}`), { overflow: true });
		assert.equal(reader.take(), null);
	});

	it("bounds the tail across chunks, not each chunk", () => {
		const reader = createLineReader();
		const half = "w".repeat(PTY_MAX_FRAME_BYTES / 2 + 1);

		assert.deepEqual(reader.push(half), { overflow: false });
		assert.deepEqual(reader.push(half), { overflow: true });
	});

	it("does not carry a taken line's length into the next line's bound", () => {
		const reader = createLineReader();
		const big = "q".repeat(PTY_MAX_FRAME_BYTES - 10);

		assert.deepEqual(reader.push(`${big}\n`), { overflow: false });
		assert.equal(reader.take(), big);
		assert.deepEqual(reader.push(`${big}\n`), { overflow: false });
		assert.equal(reader.take(), big);
	});

	it("reassembles lines split across chunks, including a split inside the delimiter pair", () => {
		const reader = createLineReader();

		assert.deepEqual(reader.push(`{"a":1`), { overflow: false });
		assert.equal(reader.take(), null);
		assert.deepEqual(reader.push(`}\n{"b":`), { overflow: false });
		assert.equal(reader.take(), `{"a":1}`);
		assert.equal(reader.take(), null);
		assert.deepEqual(reader.push(`2}\r`), { overflow: false });
		assert.equal(reader.take(), null);
		assert.deepEqual(reader.push(`\n{"c":3}\n`), { overflow: false });
		assert.equal(reader.take(), `{"b":2}`);
		assert.equal(reader.take(), `{"c":3}`);
		assert.equal(reader.take(), null);
	});

	it("forgets the tail on reset", () => {
		const reader = createLineReader();
		reader.push("z".repeat(PTY_MAX_FRAME_BYTES));
		reader.reset();

		assert.deepEqual(reader.push("z".repeat(PTY_MAX_FRAME_BYTES)), { overflow: false });
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

	it("reports where the dial spent its time: the socket callback, the broker's answer, the rest, and how late the loop ran a timer", async () => {
		const harness = await start();
		const connection = await connectPtyBroker({
			token: harness.token,
			brokerId: IDENTITY.brokerId,
			generation: harness.generation,
			port: harness.server.port,
		});
		try {
			const timings = connection.connectTimings;
			assert.ok(timings !== undefined, "a connection the client dialled carries its timings");
			for (const [name, value] of Object.entries(timings)) {
				assert.ok(Number.isFinite(value) && value >= 0, `${name} is a non-negative number of milliseconds, got ${value}`);
			}
			assert.deepEqual(Object.keys(timings).sort(), ["finishMs", "helloMs", "loopLateMs", "socketMs"]);
			const accepted = await harness.nextConnection();
			assert.equal("connectTimings" in accepted, false, "the broker's side measures nothing");
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

describe("a handshake that never gets its answer", () => {
	/** A listener that accepts connections and lets the test decide what each one does after the client's hello. */
	async function listen(onHello: (socket: Socket) => void): Promise<{ port: number; close(): Promise<void> }> {
		const sockets = new Set<Socket>();
		const server = createServer(socket => {
			sockets.add(socket);
			socket.on("close", () => sockets.delete(socket));
			socket.on("error", () => undefined);
			socket.once("data", () => onHello(socket));
		});
		await new Promise<void>(resolve => server.listen(0, PTY_LOOPBACK_HOST, resolve));
		const port = (server.address() as AddressInfo).port;
		return {
			port,
			async close() {
				for (const socket of sockets) socket.destroy();
				await new Promise<void>(resolve => server.close(() => resolve()));
			},
		};
	}

	/** How a dial that has not settled by `ms` is told from one that has: a hung dial must fail the test, not the suite. */
	async function settledWithin(dial: Promise<unknown>, ms: number): Promise<"settled" | "hung"> {
		const guard = Promise.withResolvers<"hung">();
		const timer = setTimeout(() => guard.resolve("hung"), ms);
		try {
			return await Promise.race([dial.then(() => "settled" as const, () => "settled" as const), guard.promise]);
		} finally {
			clearTimeout(timer);
		}
	}

	const dial = (port: number, timeoutMs: number) => connectPtyBroker({
		token: createPtyToken(),
		brokerId: IDENTITY.brokerId,
		generation: createPtyGeneration(),
		port,
		timeoutMs,
	});

	it("fails within its bound when the broker takes the connection and never answers the hello", async () => {
		const peer = await listen(() => undefined);
		try {
			const attempt = dial(peer.port, 150);
			attempt.catch(() => undefined);
			assert.equal(await settledWithin(attempt, 3_000), "settled", "the dial must settle: a caller waits on it for ever otherwise");
			await assert.rejects(attempt, /did not complete the handshake within 150ms/);
		} finally {
			await peer.close();
		}
	});

	it("fails at once when the broker closes the socket after the hello without answering", async () => {
		const peer = await listen(socket => socket.destroy());
		try {
			// A long bound: the answer must come from the closed socket, not from the deadline.
			const attempt = dial(peer.port, 60_000);
			attempt.catch(() => undefined);
			assert.equal(await settledWithin(attempt, 3_000), "settled");
			await assert.rejects(attempt, /closed the connection before the handshake/);
		} finally {
			await peer.close();
		}
	});

	it("does not count against the broker a stretch in which this process did not run: an answer already waiting in the socket is read", async () => {
		const harness = await start();
		// The broker answers at once and then this (shared) loop is held for longer than the dial's bound, so the dial's
		// deadline timer comes due before the socket is read, as it does in an extension host that was blocked.
		harness.server.onConnection(() => {
			const until = performance.now() + 800;
			while (performance.now() < until) { /* the host's event loop, blocked */ }
		});
		const attempt = connectPtyBroker({
			token: harness.token,
			brokerId: IDENTITY.brokerId,
			generation: harness.generation,
			port: harness.server.port,
			timeoutMs: 200,
		});
		attempt.catch(() => undefined);
		assert.equal(await settledWithin(attempt, 5_000), "settled");
		const connection = await attempt;
		try {
			assert.equal(connection.hello.slot, "tab:1");
		} finally {
			connection.close();
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

describe("the read-side traffic meter", () => {
	it("counts frames, characters and reads, and times the listener that is slow", async () => {
		const harness = await start();
		const connection = await connectPtyBroker({
			token: harness.token,
			brokerId: IDENTITY.brokerId,
			generation: harness.generation,
			port: harness.server.port,
		});
		const before = connection.traffic?.();
		assert.equal(before?.frames, 0);
		assert.equal(before?.lastFrameAt, null);
		const seen = Promise.withResolvers<void>();
		let frames = 0;
		connection.onFrame(() => {
			frames += 1;
			const until = performance.now() + 20;
			while (performance.now() < until) { /* a slow consumer */ }
			if (frames === 3) seen.resolve();
		});
		const accepted = await harness.nextConnection();
		for (let index = 0; index < 3; index += 1) accepted.send({ v: PTY_PROTOCOL_VERSION, t: "state", status: statusPayload() });
		await seen.promise;
		const after = connection.traffic?.();
		assert.equal(after?.frames, 3);
		assert.ok((after?.chars ?? 0) > 0);
		assert.ok((after?.chunks ?? 0) >= 1);
		assert.ok((after?.maxFrameMs ?? 0) >= 19, "the slowest frame is the one the listener spent 20 ms on");
		assert.ok((after?.busyMs ?? 0) >= 59, "the three frames took at least their listeners' time");
		assert.ok((after?.lastFrameAt ?? 0) > 0);
		assert.equal(accepted.traffic?.().frames, 0, "the broker side has read nothing the client sent");
	});

	it("lets the host's stall report name a slow read of the broker socket", async () => {
		const harness = await start();
		const connection = await connectPtyBroker({
			token: harness.token,
			brokerId: IDENTITY.brokerId,
			generation: harness.generation,
			port: harness.server.port,
		});
		const lines: string[] = [];
		const stalled = Promise.withResolvers<void>();
		const record = (line: string): void => {
			lines.push(line);
			if (line.startsWith("event loop blocked")) stalled.resolve();
		};
		const stop = startLoopLagMonitor({ error: record, warn: record, info: record, debug: record, trace: record });
		try {
			connection.onFrame(() => {
				const until = performance.now() + 700;
				while (performance.now() < until) { /* one frame the consumer is slow on */ }
			});
			const accepted = await harness.nextConnection();
			accepted.send({ v: PTY_PROTOCOL_VERSION, t: "state", status: statusPayload() });
			await stalled.promise;
		} finally {
			stop();
		}
		const line = lines.find(text => text.startsWith("event loop blocked"));
		assert.match(line ?? "", /metered Desk work in that time: broker socket read 1 times, \d+ ms in all/, lines.join("\n"));
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
