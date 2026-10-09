/**
 * Tests for the managed-rpc pipe child: line draining, the broker's own protocol negotiation,
 * whole-line stdin writes, dialog release on an answer, and stop.
 *
 * Runner: `node --test src/broker/rpc-child.test.ts`
 *
 * The child is a small node script that speaks the rpc-ui shape the broker depends on
 * (`ready` first, `negotiate_protocol`, JSONL echo), so the pipe behaviour is exercised for
 * real: actual process, actual pipes, actual line boundaries. OMP itself is not involved.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { RpcChildWriteError, startRpcChild, offersProtocol2, RPC_NEGOTIATE_ID, type RpcChild } from "./rpc-child.ts";
import { peekRpcLine, RpcLineRing } from "./rpc-ring.ts";
import { PTY_RPC_STDERR_TAIL_BYTES } from "../host/pty-protocol.ts";

/**
 * The stand-in for `omp --mode rpc-ui`. argv[2] picks a behaviour:
 * - `v2`: `ready` lists protocols 1 and 2 and answers `negotiate_protocol` with success;
 * - `v1`: `ready` lists no protocol versions (an older OMP);
 * - `refuse`: offers 2 but answers the negotiation with a failure;
 * - `die`: exits before `ready`;
 * - `partial`: like `v2`, and ends stdout with a line that has no newline.
 * Every other stdin line is echoed as `{"type":"echo",...}` with whether negotiation had
 * already been seen; `ask` makes it raise a dialog; closing stdin makes it say `bye` and exit.
 */
const CHILD_SOURCE = String.raw`
const mode = process.argv[2];
const out = value => process.stdout.write(JSON.stringify(value) + "\n");
if (mode === "die") {
	process.stderr.write("\x1b[31mboom before ready\x1b[0m");
	process.exit(3);
}
let negotiated = false;
const ready = mode === "v1" ? { type: "ready" } : { type: "ready", supportedProtocolVersions: [1, 2] };
out(ready);
let pending = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
	pending += chunk;
	for (;;) {
		const newline = pending.indexOf("\n");
		if (newline < 0) break;
		const line = pending.slice(0, newline);
		pending = pending.slice(newline + 1);
		const command = JSON.parse(line);
		if (command.type === "negotiate_protocol") {
			negotiated = mode !== "refuse";
			process.stdout.write(JSON.stringify({ id: command.id, type: "response", command: "negotiate_protocol", success: negotiated }) + "\n");
		} else if (command.type === "ask") {
			out({ type: "extension_ui_request", id: command.dialogId, method: "select", title: "Approve?", options: ["Approve", "Deny"] });
		} else if (command.type === "noise") {
			if (command.text !== undefined) process.stderr.write(command.text);
			process.stderr.write("x".repeat(command.stderrBytes));
			out({ type: "echo", negotiated, done: true });
		} else {
			out({ type: "echo", negotiated, line });
		}
	}
});
process.stdin.on("end", () => {
	out({ type: "bye" });
	if (mode === "partial") process.stdout.write('{"type":"tail"}');
	process.stdout.write("", () => process.exit(0));
});
`;

let scratch = "";
let script = "";
const running: RpcChild[] = [];
/** Called whenever the child delivers a line or stderr, so a wait re-checks its condition. */
const watchers = new Set<() => void>();
const notify = (): void => {
	for (const watcher of [...watchers]) watcher();
};

before(async () => {
	scratch = await mkdtemp(join(tmpdir(), "omp-rpc-child-"));
	script = join(scratch, "fake-rpc-child.cjs");
	await writeFile(script, CHILD_SOURCE);
});

afterEach(() => {
	for (const child of running.splice(0)) child.kill();
});

after(async () => {
	await rm(scratch, { recursive: true, force: true });
});

interface Started {
	readonly child: RpcChild;
	readonly ring: RpcLineRing;
	readonly ready: Promise<{ readonly line: string; readonly protocol: 1 | 2 }>;
	readonly exit: Promise<{ readonly code: number; readonly signal: number }>;
	readonly stderr: string[];
	readonly logs: string[];
}

async function start(mode: string): Promise<Started> {
	const ring = new RpcLineRing();
	const ready = Promise.withResolvers<{ line: string; protocol: 1 | 2 }>();
	const exit = Promise.withResolvers<{ code: number; signal: number }>();
	const stderr: string[] = [];
	const logs: string[] = [];
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
	const child = await startRpcChild(
		{ file: process.execPath, args: [script, mode], cwd: scratch, env },
		{
			onLine: notify,
			onReady: (line, protocol) => ready.resolve({ line, protocol }),
			onStderr: text => {
				stderr.push(text);
				notify();
			},
			onExit: info => exit.resolve(info),
			log: line => logs.push(line),
		},
		ring,
	);
	running.push(child);
	return { child, ring, ready: ready.promise, exit: exit.promise, stderr, logs };
}

/** The retained lines, parsed. */
function lines(ring: RpcLineRing): Array<Record<string, unknown>> {
	return ring.replay(0).entries.map(entry => JSON.parse(entry.bytes.toString("utf8")) as Record<string, unknown>);
}

const send = (child: RpcChild, value: unknown): Promise<void> => child.writeLine(Buffer.from(JSON.stringify(value), "utf8"));

describe("negotiation", { timeout: 30_000 }, () => {
	it("keeps `ready` and the negotiation response out of the ring and settles on protocol 2", async () => {
		const { child, ring, ready } = await start("v2");
		const settled = await ready;
		assert.equal(settled.protocol, 2);
		assert.equal(child.rpcProtocol, 2);
		assert.equal(child.readyLine, settled.line);
		assert.equal(peekRpcLine(settled.line).type, "ready");
		await send(child, { type: "echo-me" });
		await waitFor(() => lines(ring).length === 1);
		const [echo] = lines(ring);
		assert.equal(echo?.type, "echo");
		assert.equal(echo?.negotiated, true, "the child saw the broker's negotiate line before any client line");
		assert.equal(
			lines(ring).some(line => line.type === "response" || line.type === "ready"),
			false,
		);
		assert.equal(RPC_NEGOTIATE_ID, "broker:negotiate");
	});

	it("holds a client write made before `ready` until the negotiation is out", async () => {
		// The write is issued straight after spawn, before the child could have printed `ready`.
		const { child, ring, ready } = await start("v2");
		const early = send(child, { type: "first-client-line" });
		assert.equal(child.rpcProtocol, null);
		await ready;
		await early;
		await waitFor(() => lines(ring).length === 1);
		assert.equal(lines(ring)[0]?.negotiated, true, "the client's line comes after the negotiate line");
	});

	it("does not negotiate with a child that offers no protocol 2, and writes are not held", async () => {
		const { child, ring, ready } = await start("v1");
		assert.equal((await ready).protocol, 1);
		await send(child, { type: "plain" });
		await waitFor(() => lines(ring).length === 1);
		assert.equal(lines(ring)[0]?.negotiated, false);
	});

	it("falls back to protocol 1 when the child refuses the negotiation", async () => {
		const { child, ring, ready } = await start("refuse");
		assert.equal((await ready).protocol, 1);
		await send(child, { type: "plain" });
		await waitFor(() => lines(ring).length === 1);
		assert.equal(lines(ring)[0]?.negotiated, false);
	});

	it("reads the offer from `supportedProtocolVersions` and nothing looser", () => {
		assert.equal(offersProtocol2('{"type":"ready","supportedProtocolVersions":[1,2]}'), true);
		assert.equal(offersProtocol2('{"type":"ready","supportedProtocolVersions":[1]}'), false);
		assert.equal(offersProtocol2('{"type":"ready"}'), false);
		assert.equal(offersProtocol2('{"type":"ready","supportedProtocolVersions":"2"}'), false);
		assert.equal(offersProtocol2("not json"), false);
	});
});

describe("stdout and stdin lines", { timeout: 30_000 }, () => {
	it("round-trips a quote-dense 1 MiB line as a whole line each way", async () => {
		const { child, ring, ready } = await start("v2");
		await ready;
		// Every quote and backslash doubles when the line is embedded in the echo's JSON.
		const payload = '"\\\\"'.repeat(262_144);
		const command = JSON.stringify({ type: "big", text: payload });
		assert.ok(Buffer.byteLength(command) >= 1024 * 1024);
		await child.writeLine(Buffer.from(command, "utf8"));
		await waitFor(() => lines(ring).length === 1);
		assert.equal(lines(ring)[0]?.line, command, "the echoed line is byte-for-byte the line written");
	});

	it("keeps a UTF-8 sequence intact across arbitrary stdout chunking", async () => {
		const { child, ring, ready } = await start("v2");
		await ready;
		const command = JSON.stringify({ type: "text", text: "€😀é".repeat(50_000) });
		await child.writeLine(Buffer.from(command, "utf8"));
		await waitFor(() => lines(ring).length === 1);
		assert.equal(lines(ring)[0]?.line, command);
	});

	it("writes concurrent lines whole and in call order", async () => {
		const { child, ring, ready } = await start("v2");
		await ready;
		const commands = Array.from({ length: 20 }, (_, index) => JSON.stringify({ type: "n", index, pad: "p".repeat(index * 5000) }));
		await Promise.all(commands.map(command => child.writeLine(Buffer.from(command, "utf8"))));
		await waitFor(() => lines(ring).length === commands.length);
		assert.deepEqual(
			lines(ring).map(line => line.line),
			commands,
		);
	});

	it("keeps a final line that had no newline when the child ends", async () => {
		const { child, ring, ready, exit } = await start("partial");
		await ready;
		child.closeStdin();
		await exit;
		assert.deepEqual(
			lines(ring).map(line => line.type),
			["bye", "tail"],
		);
	});

	it("keeps a bounded tail of stderr and reports it as it arrives", async () => {
		const { child, ready, stderr, ring } = await start("v2");
		await ready;
		await send(child, { type: "noise", stderrBytes: 100_000 });
		await waitFor(() => lines(ring).some(line => line.done === true));
		await waitFor(() => stderr.join("").length >= 100_000);
		assert.ok(Buffer.byteLength(child.stderrTail()) <= PTY_RPC_STDERR_TAIL_BYTES, "only a bounded tail is kept");
		assert.ok(child.stderrTail().length > 0);
	});

	it("strips ANSI sequences split across chunks and bounds the UTF-8 tail in bytes", async () => {
		const { child, ready, stderr } = await start("v2");
		await ready;
		for (const text of ["prefix\x1b[", "31mred\x1b[0m\x1b]8;;secret-url", "\x1b\\label\x1b]8;;\x07\x1b(", "B\n", "😀".repeat(3000) + "END"]) {
			await send(child, { type: "noise", stderrBytes: 0, text });
		}
		await waitFor(() => child.stderrTail().endsWith("END"));
		assert.match(stderr.join(""), /^prefixredlabel\n/);
		assert.doesNotMatch(stderr.join(""), /\x1b|secret-url/);
		assert.ok(Buffer.byteLength(child.stderrTail()) <= PTY_RPC_STDERR_TAIL_BYTES);
		assert.doesNotMatch(child.stderrTail(), /�/);
		assert.ok(child.stderrTail().endsWith("END"));
	});
});

describe("dialogs", { timeout: 30_000 }, () => {
	it("stops replaying a dialog the client answered, and only that one", async () => {
		const { child, ring, ready } = await start("v2");
		await ready;
		await send(child, { type: "ask", dialogId: "ui-1" });
		await send(child, { type: "ask", dialogId: "ui-2" });
		await waitFor(() => ring.stats().dialogs === 2);
		await send(child, { type: "extension_ui_response", id: "ui-1", value: "Approve" });
		assert.equal(ring.stats().dialogs, 1);
		const pending = ring
			.replay(0)
			.entries.map(entry => JSON.parse(entry.bytes.toString("utf8")) as { id?: string })
			.filter(line => line.id !== undefined)
			.map(line => line.id);
		assert.deepEqual(pending, ["ui-2"]);
	});

	it("leaves a dialog pinned when the answer names none", async () => {
		const { child, ring, ready } = await start("v2");
		await ready;
		await send(child, { type: "ask", dialogId: "ui-1" });
		await waitFor(() => ring.stats().dialogs === 1);
		await send(child, { type: "extension_ui_response", id: "ui-9", value: "x" });
		assert.equal(ring.stats().dialogs, 1);
	});
});

describe("stop", { timeout: 30_000 }, () => {
	it("ends the child when stdin is closed, and refuses a write afterwards", async () => {
		const { child, ring, ready, exit } = await start("v2");
		await ready;
		child.closeStdin();
		const info = await exit;
		assert.equal(info.code, 0);
		assert.equal(child.exited, true);
		assert.deepEqual(
			lines(ring).map(line => line.type),
			["bye"],
			"what the child wrote while shutting down is still delivered",
		);
		await assert.rejects(
			() => send(child, { type: "late" }),
			(error: unknown) => error instanceof RpcChildWriteError && error.code === "child-exited",
		);
	});

	it("terminates the exact process on force", async () => {
		const { child, ready, exit } = await start("v2");
		await ready;
		assert.equal(child.kill(), true);
		await exit;
		assert.equal(child.exited, true);
	});

	it("fails a write held for `ready` when the child dies before it", async () => {
		const { child, exit, stderr } = await start("die");
		await assert.rejects(
			() => send(child, { type: "x" }),
			(error: unknown) => error instanceof RpcChildWriteError && error.code === "child-exited",
		);
		const info = await exit;
		assert.equal(info.code, 3);
		assert.equal(child.rpcProtocol, null, "never negotiated");
		assert.equal(child.stderrTail(), "boom before ready", "stderr is drained and stripped before exit is announced");
	});
});

/** Resolve once `condition` holds, re-checking on each delivery; the runner's timeout bounds a hang. */
function waitFor(condition: () => boolean): Promise<void> {
	if (condition()) return Promise.resolve();
	const { promise, resolve } = Promise.withResolvers<void>();
	const watcher = (): void => {
		if (!condition()) return;
		watchers.delete(watcher);
		resolve();
	};
	watchers.add(watcher);
	return promise;
}
