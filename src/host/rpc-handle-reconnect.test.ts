/**
 * The in-place reconnect of an `RpcHandle` always ends.
 *
 * Runner: `node --test src/host/rpc-handle-reconnect.test.ts`
 *
 * A handle whose connection the broker closed (a consumer closed as paced, a dropped socket) dials its broker again inside
 * `attach`. That dial is one flight shared by every caller; before it was bounded, a dial that never settled left the handle,
 * and the session reattaching through it, pending for ever with no log line (a Chat tab that stayed on "Connecting to the
 * session…" until the window was reloaded). These tests drive the handle with a scripted connection and a scripted dial, so
 * they need no broker; the timers are real because the bound under test is a real timer's.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PTY_PROTOCOL_VERSION, type PtyBrokerFrame, type PtyBrokerRecord, type PtyRequestFrame, type PtyStatusPayload } from "../wire/pty-protocol.ts";
import type { PtyClientSideConnection } from "../wire/pty-ipc.ts";
import { RpcHandle } from "./rpc-handle.ts";

const STATUS = { state: "running", exitCode: null, signal: null, nativePid: 4243, brokerPid: 4242 } as unknown as PtyStatusPayload;

/** A connection that answers the three requests an attach makes, and can be closed by the test. */
class ScriptedConnection implements PtyClientSideConnection {
	readonly sessionId = "scripted";
	readonly sessionKey = Buffer.alloc(32);
	readonly hello = {} as PtyClientSideConnection["hello"];
	readonly pendingBytes = 0;
	closed = false;
	closeReason: string | null = null;
	readonly #frames: Array<(frame: PtyBrokerFrame) => void> = [];
	readonly #closes: Array<(reason: string) => void> = [];

	send(body: PtyRequestFrame): void {
		queueMicrotask(() => {
			for (const frame of this.#answers(body)) for (const listener of this.#frames) listener(frame);
		});
	}

	onDrain(): void {}

	onFrame(listener: (frame: PtyBrokerFrame) => void): void {
		this.#frames.push(listener);
	}

	onClosed(listener: (reason: string) => void): void {
		this.#closes.push(listener);
	}

	close(reason = "closed"): void {
		if (this.closed) return;
		this.closed = true;
		this.closeReason = reason;
		for (const listener of this.#closes) listener(reason);
	}

	#answers(body: PtyRequestFrame): PtyBrokerFrame[] {
		// The handle does not check a frame's sequence number or proof; the transport that would has no part here.
		const frame = (answer: object): PtyBrokerFrame => ({ ...answer, seq: 0, mac: "" }) as PtyBrokerFrame;
		switch (body.t) {
			case "status":
				return [frame({ v: PTY_PROTOCOL_VERSION, t: "status", id: body.id, status: STATUS })];
			case "claim-input":
				return [frame({ v: PTY_PROTOCOL_VERSION, t: "input-owner", id: body.id, frontendId: body.frontendId, previous: null })];
			case "rpc-attach":
				return [frame({
					v: PTY_PROTOCOL_VERSION,
					t: "rpc-attached",
					id: body.id,
					fromSeq: body.sinceSeq,
					oldestSeq: 0,
					latestSeq: 0,
					truncated: false,
					pinnedOverflow: false,
					hostToolRetention: true,
					hostCallOverflow: false,
					rpcProtocol: 2,
					ready: null,
					negotiating: false,
					child: STATUS,
				})];
			default:
				return [];
		}
	}
}

/** A handle whose first connection the broker has closed, and whose dial is whatever the test sets. */
function closedHandle(dial: { current: () => Promise<PtyClientSideConnection> }, timeoutMs: number): RpcHandle {
	const first = new ScriptedConnection();
	const handle = new RpcHandle(first, { slot: "scripted" } as unknown as PtyBrokerRecord, true, true, () => dial.current(), timeoutMs);
	first.close("the peer closed the connection");
	return handle;
}

describe("an in-place reconnect", () => {
	it("fails within its bound when the dial never settles, and the next attach starts a new flight instead of joining the stuck one", async () => {
		const dial = { current: (): Promise<PtyClientSideConnection> => new Promise<PtyClientSideConnection>(() => undefined) };
		const handle = closedHandle(dial, 40);
		await assert.rejects(handle.attach({ sinceSeq: 7 }), /did not reconnect within 40ms/);
		const second = new ScriptedConnection();
		dial.current = () => Promise.resolve(second);
		const attached = await handle.attach({ sinceSeq: 7 });
		assert.equal(attached.fromSeq, 7);
		assert.equal(handle.closed, false, "the handle runs on the connection the second dial opened");
	});

	it("closes a connection that arrives after the deadline instead of adopting it", async () => {
		const late = new ScriptedConnection();
		const arrival = Promise.withResolvers<PtyClientSideConnection>();
		const dial = { current: (): Promise<PtyClientSideConnection> => arrival.promise };
		const handle = closedHandle(dial, 30);
		await assert.rejects(handle.attach({ sinceSeq: 0 }), /did not reconnect/);
		arrival.resolve(late);
		await arrival.promise;
		await Promise.resolve();
		assert.equal(late.closed, true, "a dial that finished too late must not leave a connection open that nothing owns");
		assert.equal(handle.closed, true, "the handle stays closed until a later attach reconnects it");
	});

	it("reports a dial that fails with its own reason", async () => {
		const dial = { current: (): Promise<PtyClientSideConnection> => Promise.reject(new Error("the broker refused the connection: busy")) };
		const handle = closedHandle(dial, 1_000);
		await assert.rejects(handle.attach({ sinceSeq: 0 }), /the broker refused the connection: busy/);
	});
});
