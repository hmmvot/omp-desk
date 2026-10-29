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
 * - only the input owner writes, and a second window is refused rather than interleaved; ownership is live
 *   on the handle (takeover, release and disconnect are reported at once);
 * - an unanswered host tool call survives every reattach until its result is written or OMP cancels it;
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
import { PTY_PROTOCOL_VERSION, attestationOf, type PtyBrokerFrame, type PtyRequestFrame } from "../wire/pty-protocol.ts";
import { PtyBrokerClient } from "./pty-client.ts";
import { RpcHandle, RpcWriteError } from "./rpc-handle.ts";
import { loadWin32Native, setWin32NativeForTest } from "../wire/win32-native.ts";
import { installedAddonAsset } from "./win32-test-support.ts";
import type { RpcChannelEvent } from "../protocol/rpc.ts";

const EXTENSION_ROOT = fileURLToPath(new URL("../..", import.meta.url));

const WINDOWS_ONLY = process.platform !== "win32" ? "the process identity readings are implemented for Windows only" : false;
const BUILT = existsSync(path.join(EXTENSION_ROOT, "out", "pty", "pty-broker.js"));
const SKIP = WINDOWS_ONLY || (BUILT ? false : "the packaged broker tree is absent: run `node esbuild.mjs --pty` first");

/**
 * The bound of one test, which launches its own detached broker (seconds each, many more on a loaded
 * runner). A bound on the whole suite would instead add the tests up: ten sequential launches can
 * exceed any fixed total on a slow machine with every test healthy, and cancel the last one mid-run.
 */
const TEST_TIMEOUT_MS = 90_000;

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
		case "hostcall":
			out({ type: "host_tool_call", id: command.callId, toolCallId: "tc-" + command.callId, toolName: "probe", arguments: {} });
			out({ type: "marker", name: command.name });
			break;
		case "hostcancel_later":
			setTimeout(() => out({ type: "host_tool_cancel", id: "cancel-" + command.callId, targetId: command.callId }), command.ms);
			break;
		case "host_tool_result":
			out({ type: "marker", name: "result:" + command.id });
			break;
		case "mark":
			out({ type: "marker", name: command.name });
			break;
		case "history":
			for (let index = 0; index < command.lines; index += 1) out({ type: "tool_execution_update", n: index, pad: "h".repeat(command.bytes) });
			out({ type: "marker", name: command.name });
			break;
		case "answer":
			out({ id: "int:state", type: "response", command: "get_state", success: true });
			for (let index = 0; index < command.chunks; index += 1) out({ type: "rpc_chunk", chunkId: "c1", index, count: command.chunks, data: "c".repeat(command.bytes) });
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

async function launchRpc(slot = nextSlot(), extra: { rpcPacedCloseMs?: number } = {}): Promise<RpcHandle> {
	const outcome = await client.launchRpc({
		slot,
		kind: "managed-rpc",
		file: process.execPath,
		args: ["-e", RPC_CHILD_SCRIPT],
		cwd: tmpdir(),
		title: `rpc ${slot}`,
		...extra,
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

describe("managed-rpc broker end to end", { skip: SKIP }, () => {
	before(async () => {
		// Staging reads the account and its access rules through the process's native module.
		setWin32NativeForTest(await loadWin32Native(await installedAddonAsset()));
		const readiness = await client.ready();
		assert.equal(readiness.ready, true, readiness.reason ?? "not ready");
	});

	it("runs a pipe child, negotiates protocol 2 itself, and shows neither `ready` nor the negotiation as lines", { timeout: TEST_TIMEOUT_MS }, async () => {
		const slot = nextSlot();
		const handle = await launchRpc(slot);
		const seen = watch(handle);
		const attached = await handle.attach({ sinceSeq: 0 });
		assert.equal(handle.record.kind, "managed-rpc");
		assert.equal(attached.child.state, "running");
		assert.ok((attached.child.pid ?? 0) > 0);
		assert.notEqual(attached.child.pid, handle.brokerPid);
		// The child's `ready` line can arrive after the attach answered; the broker then pushes it once, as an event.
		const late = attached.rpcProtocol === null ? await seen.whenEvent(event => event.type === "ready") : null;
		const readyLine = late?.type === "ready" ? late.line : attached.ready;
		assert.equal(late?.type === "ready" ? late.rpcProtocol : attached.rpcProtocol, 2, "the broker negotiated after ready");
		assert.equal(JSON.parse(readyLine ?? "{}").type, "ready");
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

	it("answers a link probe from the broker itself, and not once the connection is closed", { timeout: TEST_TIMEOUT_MS }, async () => {
		const handle = await launchRpc();
		await handle.attach({ sinceSeq: 0 });
		const ms = await handle.probeLink(10_000);
		assert.ok(ms !== null && ms >= 0 && ms < 10_000, `the broker answers a status request (${String(ms)})`);
		handle.disconnect();
		assert.equal(await handle.probeLink(1_000), null, "a closed connection cannot be probed");
	});

	it("carries a quote-dense 1 MiB line whole in both directions", { timeout: TEST_TIMEOUT_MS }, async () => {
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

	it("replays from the last seq: only what was missed, an open message as its newest update", { timeout: TEST_TIMEOUT_MS }, async () => {
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

	it("keeps a window that reattaches to a full ring while its catch-up answer is larger than the ring", { timeout: TEST_TIMEOUT_MS }, async () => {
		// A long session: about 3.5 MiB of retained lines, then a window reloads and asks for the
		// session's entries, which OMP answers with chunk lines larger than the whole ring. The
		// broker used to disconnect such a window as fallen behind on every attempt.
		const slot = nextSlot();
		const first = await launchRpc(slot);
		const firstSeen = watch(first);
		await first.attach({ sinceSeq: 0 });
		await send(first, { type: "history", lines: 220, bytes: 16 * 1024, name: "history" });
		await firstSeen.whenLine(marker("history"));
		first.disconnect();

		const second = await reattach(slot);
		const secondSeen = watch(second);
		await second.attach({ sinceSeq: 0 });
		const closed = secondSeen.whenEvent(event => event.type === "closed");
		const answered = secondSeen.whenLine(marker("answered"));
		void send(second, { type: "answer", chunks: 6, bytes: 1024 * 1024, name: "answered" });
		// The window is busy (an extension host under load reads its socket late): the replay and
		// the answer queue up at the broker while nothing is read.
		await new Promise(resolve => setImmediate(resolve));
		const until = Date.now() + 3_000;
		while (Date.now() < until) { /* hold the event loop, as a busy extension host does */ }
		const outcome = await Promise.race([answered.then(() => "answered"), closed.then(event => JSON.stringify(event))]);
		assert.equal(outcome, "answered");
		assert.equal(secondSeen.lines().filter(line => line.json.type === "rpc_chunk").length, 6, "every chunk of the answer arrived");
	});

	it("closes a consumer that does not read as paced after the limit, names it on the next attach, and the reattached window gets the rest", { timeout: TEST_TIMEOUT_MS }, async () => {
		// A window whose extension host is stuck stops reading its socket: the broker's queue for it passes the pace bound and
		// stays there. The broker used to leave it until the ring evicted its cursor (minutes of a quiet session); it now closes
		// it after `rpcPacedCloseMs`, with its own reason, and says so to the window that comes back.
		const slot = nextSlot();
		const first = await launchRpc(slot, { rpcPacedCloseMs: 1_000 });
		const firstSeen = watch(first);
		await first.attach({ sinceSeq: 0 });
		const closed = firstSeen.whenEvent(event => event.type === "closed");
		// About 12 MiB: more than any socket buffer plus the pace bound (2 MiB), less than a ring the stuck window is behind by.
		void send(first, { type: "history", lines: 700, bytes: 16 * 1024, name: "flood" });
		await new Promise(resolve => setImmediate(resolve));
		const until = Date.now() + 4_000;
		while (Date.now() < until) { /* a stuck extension host: nothing reads the socket */ }
		const event = await closed;
		assert.equal(event.type === "closed" ? event.reason : null, "disconnected");
		// The wire carries no reason: the broker ends the connection, and says why only on the next attach (`lastForcedClose`).
		const seenSeq = firstSeen.lines().at(-1)?.seq ?? 0;

		const second = await reattach(slot);
		const secondSeen = watch(second);
		const attached = await second.attach({ sinceSeq: seenSeq });
		assert.equal(attached.lastForcedClose?.reason, "paced");
		assert.ok((attached.lastForcedClose?.ageMs ?? Infinity) < 30_000);
		await send(second, { type: "mark", name: "after" });
		await secondSeen.whenLine(marker("after"));
		await secondSeen.whenLine(marker("flood"));
	});

	it("keeps an unanswered dialog across every reattach until it is answered", { timeout: TEST_TIMEOUT_MS }, async () => {
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

	it("lets only the input owner write, and refuses a second window instead of interleaving", { timeout: TEST_TIMEOUT_MS }, async () => {
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

	it("repeats a refused input claim a bounded number of times when asked, winning it once the previous owner lets go", { timeout: TEST_TIMEOUT_MS }, async () => {
		const slot = nextSlot();
		const previous = await launchRpc(slot);
		await previous.attach({ sinceSeq: 0 });
		const adopter = await reattach(slot);
		// A previous window's close reaches the broker after the adopter's first claim: the owner clears a little later.
		const released = new Promise<void>(resolve => setTimeout(() => { void previous.releaseInput(previous.frontendId).then(resolve); }, 120));
		await adopter.attach({ sinceSeq: 0, reclaimInput: { attempts: 20, intervalMs: 40 } });
		await released;
		assert.equal(adopter.inputOwned, true, "the adopter holds input before its attach returns");
		assert.equal(previous.inputOwned, false);
		const seen = watch(adopter);
		await send(adopter, { type: "mark", name: "from-adopter" });
		await seen.whenLine(marker("from-adopter"));
	});

	it("never takes input over: a frontend that keeps it stays the owner, and the retries end after their bound", { timeout: TEST_TIMEOUT_MS }, async () => {
		const slot = nextSlot();
		const owner = await launchRpc(slot);
		await owner.attach({ sinceSeq: 0 });
		const adopter = await reattach(slot);
		const started = Date.now();
		await adopter.attach({ sinceSeq: 0, reclaimInput: { attempts: 3, intervalMs: 30 } });
		assert.ok(Date.now() - started >= 80, "three retries were made before it settled");
		assert.equal(adopter.inputOwned, false);
		assert.equal(owner.inputOwned, true, "the owner was never displaced");
		await assert.rejects(send(adopter, { type: "mark", name: "nope" }), (error: unknown) => error instanceof RpcWriteError && error.code === "input-not-owner");
		await send(owner, { type: "mark", name: "still-owner" });
	});

	it("does not retry a refused claim unless asked to", { timeout: TEST_TIMEOUT_MS }, async () => {
		const slot = nextSlot();
		const owner = await launchRpc(slot);
		await owner.attach({ sinceSeq: 0 });
		const adopter = await reattach(slot);
		const started = Date.now();
		await adopter.attach({ sinceSeq: 0 });
		assert.ok(Date.now() - started < 500);
		assert.equal(adopter.inputOwned, false);
	});

	it("reports input ownership live: takeover, release and disconnect reach the handle at once", { timeout: TEST_TIMEOUT_MS }, async () => {
		const slot = nextSlot();
		const first = await launchRpc(slot);
		const firstSeen = watch(first);
		await first.attach({ sinceSeq: 0 });
		assert.equal(first.inputOwned, true);
		const before = first.ownerGeneration;
		const second = await reattach(slot);
		const secondSeen = watch(second);
		await second.attach({ sinceSeq: 0 });
		assert.equal(second.inputOwned, false);

		await second.claimInput(second.frontendId, { takeover: true });
		await firstSeen.whenEvent(event => event.type === "input-owner" && !event.owned);
		assert.equal(first.inputOwned, false, "the previous owner learns of the takeover without writing");
		assert.ok(first.ownerGeneration > before);
		assert.equal(second.inputOwned, true);
		assert.equal(secondSeen.events.some(event => event.type === "input-owner" && event.owned), true);
		await assert.rejects(send(first, { type: "mark", name: "stale" }), (error: unknown) => error instanceof RpcWriteError && error.code === "input-not-owner");

		await second.releaseInput(second.frontendId);
		assert.equal(second.inputOwned, false, "a release clears ownership");
		await second.claimInput(second.frontendId);
		assert.equal(second.inputOwned, true);
		const generation = second.ownerGeneration;
		second.disconnect();
		assert.equal(second.inputOwned, false, "a disconnect clears ownership before the socket closes");
		assert.ok(second.ownerGeneration > generation);
		assert.equal(secondSeen.events.some(event => event.type === "closed"), true);
	});

	it("pins a host tool call until its result is written, whatever windows come and go", { timeout: TEST_TIMEOUT_MS }, async () => {
		const slot = nextSlot();
		const first = await launchRpc(slot);
		const firstSeen = watch(first);
		const attached = await first.attach({ sinceSeq: 0 });
		assert.equal(attached.hostToolRetention, true, "this broker pins host tool calls");
		assert.equal(attached.hostCallOverflow, false);
		await send(first, { type: "hostcall", callId: "call-1", name: "called-1" });
		await send(first, { type: "hostcall", callId: "call-2", name: "called-2" });
		await firstSeen.whenLine(marker("called-2"));
		first.disconnect();

		const second = await reattach(slot);
		const secondSeen = watch(second);
		await second.attach({ sinceSeq: 0 });
		await secondSeen.whenLine(json => json.type === "host_tool_call" && json.id === "call-2");
		assert.deepEqual(
			secondSeen.lines().filter(line => line.json.type === "host_tool_call").map(line => line.json.id),
			["call-1", "call-2"],
			"calls nobody answered are shown to the next window",
		);
		await send(second, { type: "host_tool_result", id: "call-1", result: { content: [{ type: "text", text: "ok" }] } });
		await secondSeen.whenLine(marker("result:call-1"));
		second.disconnect();

		const third = await reattach(slot);
		const thirdSeen = watch(third);
		await third.attach({ sinceSeq: 0 });
		await send(third, { type: "mark", name: "sentinel" });
		await thirdSeen.whenLine(marker("sentinel"));
		assert.deepEqual(
			thirdSeen.lines().filter(line => line.json.type === "host_tool_call").map(line => line.json.id),
			["call-2"],
			"an answered call is never replayed",
		);
	});

	it("releases a host tool call OMP cancels while no window is attached", { timeout: TEST_TIMEOUT_MS }, async () => {
		const slot = nextSlot();
		const first = await launchRpc(slot);
		const firstSeen = watch(first);
		await first.attach({ sinceSeq: 0 });
		await send(first, { type: "hostcall", callId: "call-1", name: "called" });
		await firstSeen.whenLine(marker("called"));
		await send(first, { type: "hostcancel_later", callId: "call-1", ms: 300 });
		first.disconnect();
		// The cancel is produced by the child's own 300 ms timer while no client is connected, so there is no event to
		// await from this side; a fake clock cannot advance a real child process.
		await new Promise<void>(resolve => setTimeout(resolve, 900));

		const second = await reattach(slot);
		const secondSeen = watch(second);
		await second.attach({ sinceSeq: 0 });
		await secondSeen.whenLine(json => json.type === "host_tool_cancel");
		assert.equal(secondSeen.lines().some(line => line.json.type === "host_tool_call"), false, "the cancelled call is gone from the replay");
	});

	it("refuses each kind's requests on the other kind's broker", { timeout: TEST_TIMEOUT_MS }, async () => {
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

	it("stops as a stdin close: the child says goodbye and exits, and the channel reports `stopped`", { timeout: TEST_TIMEOUT_MS }, async () => {
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

	it("attests its child's handle only while the child runs", { timeout: TEST_TIMEOUT_MS }, async () => {
		// The host skips its own kernel reading of the child on this attestation, so the broker must withdraw it
		// the moment the child is over; a broker that kept saying `true` would have the host trust a dead pid.
		const handle = await launchRpc();
		await handle.attach({ sinceSeq: 0 });
		const running = await handle.refreshStatus();
		assert.equal(running.state, "running");
		assert.deepEqual(attestationOf(running), { brokerSelfRead: true, childHandleLive: true });
		assert.equal(running.nativeCreationTime !== null, true, "the creation time the attestation vouches for was read while the handle was held");

		const result = await handle.stop({ mode: "graceful", timeoutMs: 20_000 });
		assert.equal(result.pidGone, true, result.detail);
		const exited = await handle.refreshStatus();
		assert.equal(exited.state, "exited");
		assert.deepEqual(attestationOf(exited), { brokerSelfRead: true, childHandleLive: false });
	});
});

/** A raw authenticated connection to a record's broker, for requests the typed handles never make. */
async function rawHandle(record: import("../wire/pty-protocol.ts").PtyBrokerRecord): Promise<RawHandle> {
	const { connectPtyBroker } = await import("../wire/pty-ipc.ts");
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
