import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setImmediate } from "node:timers/promises";
import { PtyBroker, childEnvironment, parsePtyBrokerArgs } from "./pty-broker.ts";
import type { PtyBrokerServer, PtyBrokerSideConnection } from "../host/pty-ipc.ts";
import { PTY_PROTOCOL_VERSION, PTY_RUNTIME_VERSION } from "../host/pty-protocol.ts";
import type { PtyClientFrame, PtyEventFrame, PtyStopResult } from "../host/pty-protocol.ts";

const STOP_RESULT: PtyStopResult = {
	verified: false, mode: "graceful", nativePid: 42, pidGone: true,
	tree: "unknown", treeEvidence: "unavailable", remainingPids: [], checkedPids: [],
	exitCode: 0, detail: "exact child absent; descendants unproven",
};

// Ordinary private members are accessed only by this test; production visibility stays unchanged.
interface BrokerFixtureAccess {
	handleFrame(connection: PtyBrokerSideConnection, frame: PtyClientFrame): void;
	performStop(): Promise<PtyStopResult>;
	childExit: { code: number; signal: number } | null;
	childAbsenceProven: boolean;
	server: PtyBrokerServer;
	done: { promise: Promise<number> };
	finish(reason: string, code: number, retire: boolean): Promise<void>;
}

type Trace =
	| { kind: "frame" | "dropped"; connection: string; frame: PtyEventFrame }
	| { kind: "closed" };

function fixture() {
	const parsed = parsePtyBrokerArgs([
		"--slot", "shell:reply-order", "--kind", "folder-shell",
		"--storage-dir", process.cwd(), "--file", process.execPath, "--cwd", process.cwd(),
		"--tree-digest", "a".repeat(64), "--no-helper",
	]);
	if (typeof parsed === "string") throw new Error(parsed);
	const options = parsed;
	const broker = new PtyBroker(options) as unknown as BrokerFixtureAccess;
	const operation = Promise.withResolvers<PtyStopResult>();
	const entered = Promise.withResolvers<void>();
	const trace: Trace[] = [];
	const connections: PtyBrokerSideConnection[] = [];
	let calls = 0;
	broker.performStop = async () => {
		calls++;
		entered.resolve();
		return operation.promise;
	};
	broker.server = {
		port: 0, address: "127.0.0.1", onConnection: () => undefined,
		async close() {
			trace.push({ kind: "closed" });
			for (const connection of connections) connection.close();
		},
	};
	function connection(name: string): PtyBrokerSideConnection {
		let closed = false;
		const result: PtyBrokerSideConnection = {
			sessionId: name, sessionKey: Buffer.alloc(32),
			hello: {
				v: PTY_PROTOCOL_VERSION, t: "hello-ok", brokerId: options.brokerId,
				generation: options.generation, serverNonce: "0".repeat(32), slot: options.slot,
				kind: options.kind, protocolVersion: PTY_PROTOCOL_VERSION, runtimeVersion: PTY_RUNTIME_VERSION,
				treeDigest: options.treeDigest, brokerPid: process.pid, brokerCreationTime: null, mac: "0".repeat(64),
			},
			get closed() { return closed; }, pendingBytes: 0,
			send(frame) { trace.push({ kind: closed ? "dropped" : "frame", connection: name, frame }); },
			onDrain: () => undefined, onFrame: () => undefined, onClosed: () => undefined,
			close() { closed = true; },
		};
		connections.push(result);
		return result;
	}
	return {
		broker, operation, entered, trace, connection, calls: () => calls,
		async cleanup() {
			operation.resolve(STOP_RESULT);
			// An event-loop checkpoint drains request continuations, not a guessed wall-clock delay.
			await setImmediate();
			await broker.finish("test cleanup", 0, false);
		},
	};
}

function repliesBeforeClose(trace: Trace[], ids: number[], type: "stopped" | "ack"): void {
	const closeIndex = trace.findIndex(entry => entry.kind === "closed");
	assert.ok(closeIndex >= 0, "the real broker finish must close the endpoint");
	for (const id of ids) {
		const indices = trace.flatMap((entry, index) =>
			entry.kind === "frame" && entry.frame.t === type && entry.frame.id === id ? [index] : [],
		);
		assert.equal(indices.length, 1, `request ${id} gets exactly one queued reply`);
		assert.ok(indices[0]! < closeIndex, `request ${id} is replied to before endpoint close`);
	}
	assert.equal(trace.some(entry => entry.kind === "dropped"), false);
}

// Ingress is already authenticated by the transport; the unit fixture includes its envelope.
const stop = (id: number): PtyClientFrame => ({ v: PTY_PROTOCOL_VERSION, t: "stop", id, mode: "graceful", timeoutMs: 1_000, seq: id, mac: "0".repeat(64) });
const shutdown = (id = 9): PtyClientFrame => ({ v: PTY_PROTOCOL_VERSION, t: "shutdown", id, requireStopped: true, seq: id, mac: "0".repeat(64) });

// Exercise real request ingress, shared stop and finish with a deferred platform verdict; no native process is started.
describe("broker stop replies before endpoint retirement", { timeout: 10_000 }, () => {
	for (const mode of ["one", "two connections", "one connection twice"] as const) {
		it(`queues ${mode} accepted stop replies before a concurrent shutdown`, async t => {
			const test = fixture();
			t.after(() => test.cleanup());
			const first = test.connection("stop caller");
			const second = mode === "two connections" ? test.connection("other stop caller") : first;
			const watcher = test.connection("natural retirement");
			test.broker.handleFrame(first, stop(1));
			await test.entered.promise;
			if (mode !== "one") test.broker.handleFrame(second, stop(2));
			test.broker.childExit = { code: 0, signal: 0 };
			test.broker.handleFrame(watcher, shutdown());
			await setImmediate();
			assert.equal(test.calls(), 1, "the underlying stop remains single-flight");
			assert.equal(watcher.closed, false, "exit notification must not discard a pending stop verdict");
			assert.equal(test.trace.some(entry => entry.kind === "closed"), false);
			test.operation.resolve(STOP_RESULT);
			await test.broker.done.promise;
			repliesBeforeClose(test.trace, mode === "one" ? [1] : [1, 2], "stopped");
			assert.ok(test.trace.some(entry => entry.kind === "frame" && entry.frame.t === "shutdown-ok" && entry.frame.stopped));
		});
	}

	for (const count of [1, 2]) {
		it(`queues ${count} failed stop replies before concurrent shutdown`, async t => {
			const test = fixture();
			t.after(() => test.cleanup());
			test.broker.handleFrame(test.connection("first stop"), stop(1));
			await test.entered.promise;
			if (count === 2) test.broker.handleFrame(test.connection("second stop"), stop(2));
			test.broker.childExit = { code: 0, signal: 0 };
			test.broker.handleFrame(test.connection("retirement"), shutdown());
			await setImmediate();
			assert.equal(test.trace.some(entry => entry.kind === "closed"), false);
			test.operation.reject(new Error("platform stop failed"));
			await test.broker.done.promise;
			repliesBeforeClose(test.trace, count === 1 ? [1] : [1, 2], "ack");
			const failures = test.trace.filter(entry => entry.kind === "frame" && entry.frame.t === "ack");
			assert.ok(failures.every(entry => entry.kind === "frame" && entry.frame.t === "ack" && !entry.frame.ok && entry.frame.code === "internal"));
		});
	}

	for (const proof of ["exit event", "exact generation absence"] as const) {
		it(`retires without a pending stop after ${proof}`, async t => {
			const test = fixture();
			t.after(() => test.cleanup());
			if (proof === "exit event") test.broker.childExit = { code: 0, signal: 0 };
			else test.broker.childAbsenceProven = true;
			test.broker.handleFrame(test.connection("shutdown"), shutdown());
			await test.broker.done.promise;
			assert.equal(test.calls(), 0);
			assert.ok(test.trace.some(entry => entry.kind === "frame" && entry.frame.t === "shutdown-ok" && entry.frame.stopped));
		});
	}

	it("still refuses requireStopped shutdown without child-absence proof", async t => {
		const test = fixture();
		t.after(() => test.cleanup());
		test.broker.handleFrame(test.connection("shutdown"), shutdown());
		await setImmediate();
		assert.equal(test.trace.some(entry => entry.kind === "closed"), false);
		assert.ok(test.trace.some(entry => entry.kind === "frame" && entry.frame.t === "ack" && !entry.frame.ok && entry.frame.code === "child-alive"));
	});
});

describe("child environment", () => {
	it("drops OMP runtime markers a VS Code started inside OMP inherited, and keeps explicit deltas", () => {
		const env = childEnvironment(
			{ PATH: "C:\\bin", Pi_No_Pty: "1", PI_NO_TITLE: "1", PI_NOTIFICATIONS: "off", OMP_VSCODE_CONTROL_DIR: "C:\\stale", OMP_VSCODE_CONTROL_SLOT: "stale", PI_TOOL_BRIDGE_TOKEN: "t", ELECTRON_RUN_AS_NODE: "1", UNSET: undefined },
			{ OMP_VSCODE_CONTROL_DIR: "C:\\fresh", OMP_VSCODE_CONTROL_SLOT: "slot-1", ELECTRON_RUN_AS_NODE: "1" },
		);
		assert.deepEqual(env, { PATH: "C:\\bin", OMP_VSCODE_CONTROL_DIR: "C:\\fresh", OMP_VSCODE_CONTROL_SLOT: "slot-1" });
	});
});
