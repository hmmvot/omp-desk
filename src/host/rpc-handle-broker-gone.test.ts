/**
 * What an `RpcHandle` tells its session when the broker behind it is ended from outside, and how
 * it stops a child after the broker closed this handle's connection.
 *
 * A broker that exits on its own says so over its connection; a killed one only closes it, which the
 * session reads as a drop to reattach after. `brokerGone` is how a window that proved the broker's
 * process gone makes the session end the way a child's exit ends it.
 *
 * Runner: `node --test src/host/rpc-handle-broker-gone.test.ts`
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PtyBrokerRecord } from "./pty-protocol.ts";
import type { PtyClientSideConnection } from "./pty-ipc.ts";
import { RpcHandle } from "./rpc-handle.ts";
import type { RpcChannelEvent } from "./rpc/protocol.ts";

/** A connection that never speaks; the test closes it by hand, as a killed broker's socket closes. */
function silentConnection() {
	const closers: Array<(reason: string) => void> = [];
	const connection = {
		sessionId: "s",
		sessionKey: Buffer.alloc(32),
		hello: {},
		closed: false,
		pendingBytes: 0,
		send: () => {},
		onDrain: () => {},
		onFrame: () => {},
		onClosed: (listener: (reason: string) => void) => void closers.push(listener),
		close: () => {},
	} as unknown as PtyClientSideConnection;
	return { connection, drop: (reason: string) => closers.forEach(listener => listener(reason)) };
}

function handleWithEvents() {
	const { connection, drop } = silentConnection();
	const record = { slot: "tab:one", kind: "managed-rpc", brokerPid: 4100, brokerId: "pty-one", generation: "g1" } as unknown as PtyBrokerRecord;
	const handle = new RpcHandle(connection, record, true, true, async () => connection);
	const events: RpcChannelEvent[] = [];
	handle.onEvent(event => events.push(event));
	return { handle, events, drop };
}

describe("a broker that was ended from outside", () => {
	it("ends the session as a child's exit does: the child is reported exited, then the channel closes as child-exited", () => {
		const { handle, events } = handleWithEvents();
		handle.brokerGone();
		assert.deepEqual(events.map(event => event.type), ["child", "closed"]);
		const child = events[0];
		assert.ok(child?.type === "child" && child.status.state === "exited" && child.status.exitCode === null);
		assert.ok(events[1]?.type === "closed" && events[1].reason === "child-exited");
	});

	it("still ends it after the dropped connection already said `disconnected`: the session was reattaching to nothing", () => {
		const { handle, events, drop } = handleWithEvents();
		drop("the peer closed the connection");
		assert.ok(events.some(event => event.type === "closed" && event.reason === "disconnected"));
		events.length = 0;
		handle.brokerGone();
		assert.ok(events.some(event => event.type === "closed" && event.reason === "child-exited"), "the earlier disconnect does not swallow the end");
	});
});

/** A connection that answers `status` and `stop` requests the way a running broker does. */
function answeringConnection(sent: string[]) {
	let deliver: (frame: unknown) => void = () => {};
	const status = { state: "running", nativePid: 4200, nativeCreationTime: "1", exitCode: null };
	const connection = {
		sessionId: "s2",
		sessionKey: Buffer.alloc(32),
		hello: {},
		closed: false,
		pendingBytes: 0,
		send: (frame: { t: string; id: number; mode?: string }) => {
			sent.push(frame.t);
			queueMicrotask(() => {
				if (frame.t === "status") deliver({ v: 1, t: "status", id: frame.id, status });
				if (frame.t === "stop") {
					deliver({
						v: 1, t: "stopped", id: frame.id,
						result: { verified: true, mode: frame.mode, nativePid: 4200, pidGone: true, tree: "empty", treeEvidence: "descendants-observed", remainingPids: [], checkedPids: [4200], exitCode: null, detail: "stopped" },
					});
				}
			});
		},
		onDrain: () => {},
		onFrame: (listener: (frame: unknown) => void) => { deliver = listener; },
		onClosed: () => {},
		close: () => {},
	} as unknown as PtyClientSideConnection;
	return connection;
}

describe("stopping after the broker closed this handle's connection", () => {
	it("sends the stop over a fresh connection to the same broker instead of failing on the closed one", async () => {
		// The broker disconnects a consumer it judged behind; the session it shows can never stay
		// attached, and Stop must still reach the exact child.
		const { connection, drop } = silentConnection();
		const sent: string[] = [];
		const fresh = answeringConnection(sent);
		let reconnects = 0;
		const record = { slot: "tab:one", kind: "managed-rpc", brokerPid: 4100, brokerId: "pty-one", generation: "g1" } as unknown as PtyBrokerRecord;
		const handle = new RpcHandle(connection, record, true, true, async () => { reconnects += 1; return fresh; });
		drop("the consumer fell behind the retained lines and must reattach");
		const result = await handle.stop({ mode: "force", timeoutMs: 1_000 });
		assert.equal(result.pidGone, true);
		assert.equal(reconnects, 1);
		assert.deepEqual(sent, ["status", "stop", "status"], "no rpc-attach: the stop connection does not subscribe to output");
	});
});
