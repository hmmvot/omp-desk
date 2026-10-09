/**
 * The managed-rpc broker, end to end, through the handle the chat runtime drives.
 *
 * Runner: `node --test src/host/rpc-handle.test.ts`
 *
 * No mock is in the path between the handle and the child: the real staged runtime, the real
 * detached broker, a real pipe child and the real authenticated transport. The child is a
 * small node script speaking the rpc-ui shape the broker depends on (`ready` first,
 * `negotiate_protocol`, JSONL commands), so what is proved is the broker's contract:
 *
 * - a slot runs an rpc child without a pseudo console, negotiating protocol 2 itself and never
 *   showing `ready` or the negotiation response as a line;
 * - a line of about a megabyte, dense with quotes, crosses the transport whole in both directions;
 * - a window that reattaches with its last `seq` is replayed exactly what it missed, an open
 *   message shows only its newest update, and an unanswered dialog survives every reattach until
 *   it is answered;
 * - only the input owner writes, and a second window is refused rather than interleaved;
 * - kind gating: terminal requests are refused by an rpc broker and rpc requests by a terminal one;
 * - stop is a stdin close, and the broker never stops the child because a window went away.
 *
 * Waits are events (a line, a state frame). Skipped outside Windows (identity readings are
 * Windows-only) and when the packaged broker tree has not been built (`node esbuild.mjs --pty`).
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { BrokerHandle } from "./broker-handle.ts";
import { PTY_PROTOCOL_VERSION, type PtyBrokerFrame, type PtyRequestFrame } from "./pty-protocol.ts";
import { PtyBrokerClient } from "./pty-client.ts";
import { RpcHandle, RpcWriteError } from "./rpc-handle.ts";
import type { RpcChannelEvent } from "./rpc/protocol.ts";

const EXTENSION_ROOT = fileURLToPath(new URL("../..", import.meta.url));

const WINDOWS_ONLY = process.platform !== "win32" ? "the process identity readings are implemented for Windows only" : false;
const BUILT = existsSync(path.join(EXTENSION_ROOT, "out", "pty", "pty-broker.js"));
const SKIP = WINDOWS_ONLY || (BUILT ? false : "the packaged broker tree is absent: run `node esbuild.mjs --pty` first");

/** The stand-in for `omp --mode rpc-ui`. */
const RPC_CHILD_SCRIPT = String.raw`
const out = value => process.stdout.write(JSON.stringify(value) + "\n");
out({ type: "ready", supportedProtocolVersions: [1, 2] });
let pending = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
	pending += chunk;
	for (;;) {
		const newline = pending.indexOf("\n");
		if (newline < 0) break;
		const line = pending.slice(0, newline);
		pending = pending.slice(newline + 1);
		handle(JSON.parse(line), line);
	}
});
function handle(command, line) {
	switch (command.type) {
		case "negotiate_protocol":
			out({ id: command.id, type: "response", command: "negotiate_protocol", success: true });
			break;
		case "stream":
			out({ type: "message_start", message: { role: "assistant" }, messageId: "msg-1" });
			for (let index = 1; index <= command.updates; index += 1) {
				out({ type: "message_update", message: { role: "assistant", content: "t".repeat(index) }, messageId: "msg-1" });
			}
			out({ type: "marker", name: command.name });
			break;
		case "finish":
			out({ type: "message_end", message: { role: "assistant" }, messageId: "msg-1" });
			out({ type: "marker", name: command.name });
			break;
		case "ask":
			out({ type: "extension_ui_request", id: command.dialogId, method: "select", title: "Approve?", options: ["Approve", "Deny"] });
			out({ type: "marker", name: command.name });
			break;
		case "extension_ui_response":
			out({ type: "marker", name: "answered:" + command.id });
			break;
		case "echo":
			out({ type: "echo", line });
			break;
		case "mark":
			out({ type: "marker", name: command.name });
			break;
	}
}
process.stdin.on("end", () => {
	out({ type: "bye" });
	process.exit(0);
});
`;

/** A terminal child, for the other kind. */
const TERMINAL_SCRIPT = "process.stdout.write('READY\\r\\n'); setInterval(() => {}, 1000);";

/** A handle that lets a test send any request, to prove what a broker of one kind refuses. */
class RawHandle extends BrokerHandle {
	ask(body: PtyRequestFrame): Promise<PtyBrokerFrame> {
		return this.request(body);
	}
}

let storage: string;
let client: PtyBrokerClient;
const opened: RpcHandle[] = [];
const rawOpened: BrokerHandle[] = [];
let counter = 0;

const nextSlot = (): string => {
	counter += 1;
	return `tab:rpc-e2e-${counter}`;
};

/** Everything a handle delivers, with waits that resolve when a condition holds. */
interface Seen {
	readonly events: RpcChannelEvent[];
	readonly lines: () => Array<{ seq: number; text: string; json: Record<string, unknown> }>;
	readonly whenLine: (match: (json: Record<string, unknown>) => boolean) => Promise<Record<string, unknown>>;
	readonly whenEvent: (match: (event: RpcChannelEvent) => boolean) => Promise<RpcChannelEvent>;
}

function watch(handle: RpcHandle): Seen {
	const events: RpcChannelEvent[] = [];
	const waiters: Array<() => void> = [];
	handle.onEvent(event => {
		events.push(event);
		for (const waiter of [...waiters]) waiter();
	});
	const lines = (): Array<{ seq: number; text: string; json: Record<string, unknown> }> =>
		events.flatMap(event =>
			event.type === "line" ? [{ seq: event.seq, text: event.line, json: JSON.parse(event.line) as Record<string, unknown> }] : [],
		);
	const until = <T>(find: () => T | undefined): Promise<T> => {
		const found = find();
		if (found !== undefined) return Promise.resolve(found);
		const { promise, resolve } = Promise.withResolvers<T>();
		const waiter = (): void => {
			const value = find();
			if (value === undefined) return;
			waiters.splice(waiters.indexOf(waiter), 1);
			resolve(value);
		};
		waiters.push(waiter);
		return promise;
	};
	return {
		events,
		lines,
		whenLine: match => until(() => lines().find(line => match(line.json))?.json),
		whenEvent: match => until(() => events.find(match)),
	};
}

const marker = (name: string) => (json: Record<string, unknown>) => json.type === "marker" && json.name === name;

async function launchRpc(slot = nextSlot()): Promise<RpcHandle> {
	const outcome = await client.launchRpc({
		slot,
		kind: "managed-rpc",
		file: process.execPath,
		args: ["-e", RPC_CHILD_SCRIPT],
		cwd: tmpdir(),
		title: `rpc ${slot}`,
	});
	assert.equal(outcome.state, "running", outcome.reason);
	assert.ok(outcome.handle);
	opened.push(outcome.handle);
	return outcome.handle;
}

/** A second window: a new client that finds the slot's record and reattaches. */
async function reattach(slot: string): Promise<RpcHandle> {
	const other = new PtyBrokerClient({ storageDir: storage, extensionRoot: EXTENSION_ROOT });
	const outcome = await other.attachRpc(slot);
	assert.equal(outcome.state, "attached", outcome.reason);
	assert.ok(outcome.handle);
	opened.push(outcome.handle);
	return outcome.handle;
}

const send = (handle: RpcHandle, value: unknown): Promise<void> => handle.writeLine(JSON.stringify(value));

before(async () => {
	// The record directory must satisfy the real access convention: it lives in this account's profile.
	storage = await mkdtemp(path.join(homedir(), ".omp-rpc-e2e-"));
	client = new PtyBrokerClient({ storageDir: storage, extensionRoot: EXTENSION_ROOT });
});

after(async () => {
	for (const handle of opened) {
		try {
			await handle.stop({ mode: "force", timeoutMs: 10_000 });
			await handle.shutdown({ requireStopped: false });
		} catch {
			handle.disconnect();
		}
	}
	for (const handle of rawOpened) handle.disconnect();
	await rm(storage, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe("managed-rpc broker end to end", { skip: SKIP, timeout: 120_000 }, () => {
	before(async () => {
		const readiness = await client.ready();
		assert.equal(readiness.ready, true, readiness.reason ?? "not ready");
	});

	it("runs a pipe child, negotiates protocol 2 itself, and shows neither `ready` nor the negotiation as lines", async () => {
		const slot = nextSlot();
		const handle = await launchRpc(slot);
		const seen = watch(handle);
		const attached = await handle.attach({ sinceSeq: 0 });
		assert.equal(handle.record.kind, "managed-rpc");
		assert.equal(attached.child.state, "running");
		assert.ok((attached.child.pid ?? 0) > 0);
		assert.notEqual(attached.child.pid, handle.brokerPid);
		assert.equal(attached.rpcProtocol, 2, "the broker negotiated after ready");
		assert.equal(JSON.parse(attached.ready ?? "{}").type, "ready");
		assert.equal(handle.inputOwned, true);

		await send(handle, { type: "echo", text: "hello" });
		const echo = await seen.whenLine(json => json.type === "echo");
		assert.equal(JSON.parse(String(echo.line)).text, "hello");
		assert.equal(
			seen.lines().some(line => line.json.type === "ready" || line.json.type === "response"),
			false,
		);
		const status = await handle.refreshStatus();
		assert.match(status.nativeCreationTime ?? "", /^[1-9][0-9]{9,19}$/, "the child's kernel identity is recorded like any child's");
	});

	it("carries a quote-dense 1 MiB line whole in both directions", async () => {
		const handle = await launchRpc();
		const seen = watch(handle);
		await handle.attach({ sinceSeq: 0 });
		// Each quote and backslash doubles when the echo embeds the line, so the line the child
		// sends back is more than twice the size: several fragments each way.
		const command = JSON.stringify({ type: "echo", text: '"\\\\"'.repeat(262_144) });
		assert.ok(Buffer.byteLength(command) >= 1024 * 1024);
		await handle.writeLine(command);
		const echo = await seen.whenLine(json => json.type === "echo");
		assert.equal(echo.line, command, "the child received exactly the bytes written");
		const back = seen.lines().find(line => line.json.type === "echo");
		assert.ok(back && back.text.length > 2 * 1024 * 1024);
	});

	it("replays from the last seq: only what was missed, an open message as its newest update", async () => {
		const slot = nextSlot();
		const first = await launchRpc(slot);
		const firstSeen = watch(first);
		await first.attach({ sinceSeq: 0 });
		await send(first, { type: "stream", updates: 200, name: "streamed" });
		await firstSeen.whenLine(marker("streamed"));
		const start = firstSeen.lines().find(line => line.json.type === "message_start");
		assert.ok(start);
		first.disconnect();

		// A reloaded window reattaches to the surviving child with what it had seen.
		const second = await reattach(slot);
		const secondSeen = watch(second);
		const resumed = await second.attach({ sinceSeq: start.seq });
		assert.equal(resumed.fromSeq, start.seq);
		assert.equal(resumed.truncated, false);
		assert.equal(resumed.child.state, "running", "no window's going away stops the child");
		await secondSeen.whenLine(marker("streamed"));
		const types = secondSeen.lines().map(line => line.json.type);
		assert.deepEqual(types, ["message_update", "marker"], "the start was already seen; 199 superseded updates are not sent");
		const update = secondSeen.lines()[0]?.json.message as { content: string };
		assert.equal(update.content.length, 200, "the one update carries the whole accumulated message");

		// Input follows the connection: once this window is gone the next one can write.
		second.disconnect();
		// From the beginning the same window would get the start, the newest update and the marker.
		const third = await reattach(slot);
		const thirdSeen = watch(third);
		await third.attach({ sinceSeq: 0 });
		await thirdSeen.whenLine(marker("streamed"));
		assert.deepEqual(
			thirdSeen.lines().map(line => line.json.type),
			["message_start", "message_update", "marker"],
		);
		const seqs = thirdSeen.lines().map(line => line.seq);
		assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));

		// Once the message ended nothing of it is replayed as an update.
		await send(third, { type: "finish", name: "finished" });
		await thirdSeen.whenLine(marker("finished"));
		const fourth = await reattach(slot);
		const fourthSeen = watch(fourth);
		await fourth.attach({ sinceSeq: 0 });
		await send(third, { type: "mark", name: "sentinel" });
		await fourthSeen.whenLine(marker("sentinel"));
		assert.equal(
			fourthSeen.lines().some(line => line.json.type === "message_update"),
			false,
		);
	});

	it("keeps an unanswered dialog across every reattach until it is answered", async () => {
		const slot = nextSlot();
		const first = await launchRpc(slot);
		const firstSeen = watch(first);
		await first.attach({ sinceSeq: 0 });
		await send(first, { type: "ask", dialogId: "ui-1", name: "asked" });
		await firstSeen.whenLine(marker("asked"));
		first.disconnect();

		const second = await reattach(slot);
		const secondSeen = watch(second);
		await second.attach({ sinceSeq: 0 });
		const pending = await secondSeen.whenLine(json => json.type === "extension_ui_request");
		assert.equal(pending.id, "ui-1", "an approval nobody saw is still waiting for the next window");
		await send(second, { type: "extension_ui_response", id: "ui-1", value: "Approve" });
		await secondSeen.whenLine(marker("answered:ui-1"));
		second.disconnect();

		const third = await reattach(slot);
		const thirdSeen = watch(third);
		await third.attach({ sinceSeq: 0 });
		await send(third, { type: "mark", name: "sentinel" });
		await thirdSeen.whenLine(marker("sentinel"));
		assert.equal(
			thirdSeen.lines().some(line => line.json.type === "extension_ui_request"),
			false,
			"an answered dialog is never replayed",
		);
	});

	it("lets only the input owner write, and refuses a second window instead of interleaving", async () => {
		const slot = nextSlot();
		const owner = await launchRpc(slot);
		await owner.attach({ sinceSeq: 0 });
		const reader = await reattach(slot);
		const readerSeen = watch(reader);
		await reader.attach({ sinceSeq: 0 });
		assert.equal(reader.inputOwned, false);
		await assert.rejects(send(reader, { type: "mark", name: "nope" }), (error: unknown) => {
			assert.ok(error instanceof RpcWriteError);
			assert.equal(error.code, "input-not-owner");
			return true;
		});
		// The reader still reads what the owner makes the child say.
		await send(owner, { type: "mark", name: "from-owner" });
		await readerSeen.whenLine(marker("from-owner"));
		assert.equal(
			readerSeen.lines().some(line => line.json.name === "nope"),
			false,
		);
	});

	it("refuses each kind's requests on the other kind's broker", async () => {
		const rpcSlot = nextSlot();
		const rpc = await launchRpc(rpcSlot);
		const terminalSlot = `tab:rpc-e2e-terminal-${counter}`;
		const terminal = await client.launch({
			slot: terminalSlot,
			kind: "managed-omp",
			file: process.execPath,
			args: ["-e", TERMINAL_SCRIPT],
			cwd: tmpdir(),
			cols: 80,
			rows: 24,
		});
		assert.equal(terminal.state, "running", terminal.reason);
		assert.ok(terminal.handle);
		const terminalHandle = terminal.handle;
		try {
			// A terminal request on the rpc broker.
			const rawRpc = await rawHandle(rpc.record);
			for (const body of [
				{ v: PTY_PROTOCOL_VERSION, t: "attach", id: 0, sincePosition: 0 },
				{ v: PTY_PROTOCOL_VERSION, t: "snapshot", id: 0 },
				{ v: PTY_PROTOCOL_VERSION, t: "input", id: 0, frontendId: "x:1", data: "a" },
				{ v: PTY_PROTOCOL_VERSION, t: "resize", id: 0, frontendId: "x:1", cols: 80, rows: 24 },
			] as unknown as PtyRequestFrame[]) {
				const answer = await rawRpc.ask(body);
				assert.equal(answer.t, "ack");
				assert.equal(answer.t === "ack" ? answer.ok : true, false, body.t);
				assert.equal(answer.t === "ack" ? answer.code : "", "wrong-kind", body.t);
			}
			// An rpc request on the terminal broker.
			const rawTerminal = await rawHandle(terminalHandle.record);
			const answer = await rawTerminal.ask({ v: PTY_PROTOCOL_VERSION, t: "rpc-attach", id: 0, sinceSeq: 0 });
			assert.equal(answer.t, "ack");
			assert.equal(answer.t === "ack" ? answer.code : "", "wrong-kind");
			// And the typed clients agree: a terminal attach never adopts an rpc record.
			const wrongClient = new PtyBrokerClient({ storageDir: storage, extensionRoot: EXTENSION_ROOT });
			const asTerminal = await wrongClient.attach(rpcSlot);
			assert.equal(asTerminal.state, "unavailable");
			const asRpc = await wrongClient.attachRpc(terminalSlot);
			assert.equal(asRpc.state, "unavailable");
			// Both brokers still serve their own kind after the refusals.
			assert.equal((await rpc.refreshStatus()).state, "running");
			assert.equal((await terminalHandle.refreshStatus()).state, "running");
		} finally {
			await terminalHandle.stop({ mode: "force", timeoutMs: 10_000 }).catch(() => undefined);
			await terminalHandle.shutdown({ requireStopped: false }).catch(() => undefined);
		}
	});

	it("stops as a stdin close: the child says goodbye and exits, and the channel reports `stopped`", async () => {
		const handle = await launchRpc();
		const seen = watch(handle);
		await handle.attach({ sinceSeq: 0 });
		const result = await handle.stop({ mode: "graceful", timeoutMs: 20_000 });
		assert.equal(result.pidGone, true, result.detail);
		await seen.whenLine(json => json.type === "bye");
		const closed = await seen.whenEvent(event => event.type === "closed");
		assert.deepEqual(closed, { type: "closed", reason: "stopped" });
		assert.equal(seen.events.some(event => event.type === "child" && event.status.state === "exited"), false, "an intentional stop does not announce an autonomous child exit");
		assert.equal((await handle.refreshStatus()).state, "exited");
		await assert.rejects(send(handle, { type: "mark", name: "late" }), (error: unknown) => {
			assert.ok(error instanceof RpcWriteError);
			assert.equal(error.code === "child-exited" || error.code === "closed", true, error.code);
			return true;
		});
	});
});

/** A raw authenticated connection to a record's broker, for requests the typed handles never make. */
async function rawHandle(record: import("./pty-protocol.ts").PtyBrokerRecord): Promise<RawHandle> {
	const { connectPtyBroker } = await import("./pty-ipc.ts");
	const connection = await connectPtyBroker({
		token: record.token,
		brokerId: record.brokerId,
		generation: record.generation,
		port: record.port,
	});
	const handle = new RawHandle(connection, record, true, true);
	rawOpened.push(handle);
	return handle;
}
