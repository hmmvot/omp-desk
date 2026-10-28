/**
 * The store that keeps a restore reconcile's broker connection for the attach that follows.
 *
 * It decides only whose connection is whose: a connection is handed out for exactly the pin it was kept under, once, while
 * it is open and inside its time limit, and everything else is closed. What an attach then proves over it is tested with a
 * real broker in `pty-attach-identity.test.ts`.
 *
 * Runner: `node --test src/host/rpc-parked.test.ts`
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PARKED_RPC_TTL_MS, ParkedRpcConnections } from "./rpc-parked.ts";
import type { ParkedConnection } from "./rpc-parked.ts";
import type { AttachPin } from "./session-availability.ts";

const PIN: AttachPin = {
	kind: "broker",
	slot: "host:slot-a",
	brokerId: "pty-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
	brokerGeneration: "generation-a",
	brokerPid: 100,
	brokerCreationTime: "133700000000000000",
	nativePid: 200,
	nativeCreationTime: "133700000000000500",
};

class FakeConnection implements ParkedConnection {
	closed = false;
	disconnects = 0;
	disconnect(): void {
		this.disconnects += 1;
		this.closed = true;
	}
}

describe("ParkedRpcConnections", () => {
	it("hands out a parked connection once, for exactly the pin it was kept under", () => {
		const store = new ParkedRpcConnections();
		const connection = new FakeConnection();
		assert.equal(store.park(PIN, connection), true);
		assert.equal(store.size, 1);
		assert.equal(store.take({ ...PIN }), connection, "a pin equal field by field claims it");
		assert.equal(store.size, 0);
		assert.equal(connection.closed, false, "a claimed connection stays open for the attach");
		assert.equal(store.take(PIN), null, "and is handed out only once");
	});

	it("names no connection for a slot nothing was kept for", () => {
		assert.equal(new ParkedRpcConnections().take(PIN), null);
	});

	it("closes the connection and hands out nothing when the pin differs in any field", () => {
		const changes: Array<Partial<AttachPin>> = [
			{ brokerId: "pty-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
			{ brokerGeneration: "generation-b" },
			{ brokerPid: 101 },
			{ brokerCreationTime: "133700000000000001" },
			{ brokerCreationTime: null },
			{ nativePid: 201 },
			{ nativeCreationTime: "133700000000000501" },
		];
		for (const change of changes) {
			const store = new ParkedRpcConnections();
			const connection = new FakeConnection();
			store.park(PIN, connection);
			assert.equal(store.take({ ...PIN, ...change }), null, JSON.stringify(change));
			assert.equal(connection.closed, true, `${JSON.stringify(change)} closed the connection it did not match`);
			assert.equal(store.size, 0);
		}
	});

	it("closes a connection whose socket already closed instead of handing it out", () => {
		const store = new ParkedRpcConnections();
		const connection = new FakeConnection();
		store.park(PIN, connection);
		connection.closed = true;
		assert.equal(store.take(PIN), null);
		assert.equal(connection.disconnects, 1);
		assert.equal(store.size, 0);
	});

	it("does not keep a connection that is already closed", () => {
		const store = new ParkedRpcConnections();
		const connection = new FakeConnection();
		connection.closed = true;
		assert.equal(store.park(PIN, connection), false);
		assert.equal(store.size, 0);
	});

	it("keeps a connection whose handle does not say whether it closed", () => {
		const store = new ParkedRpcConnections();
		const connection = { disconnects: 0, disconnect() { this.disconnects += 1; } };
		assert.equal(store.park(PIN, connection), true);
		assert.equal(store.take(PIN), connection);
		assert.equal(connection.disconnects, 0);
	});

	it("closes the connection it replaces: one slot has one broker, and the newer proof is the one an attach checks", () => {
		const store = new ParkedRpcConnections();
		const first = new FakeConnection();
		const second = new FakeConnection();
		store.park(PIN, first);
		store.park(PIN, second);
		assert.equal(first.closed, true);
		assert.equal(store.size, 1);
		assert.equal(store.take(PIN), second);
	});

	it("keeps the connections of different slots apart", () => {
		const store = new ParkedRpcConnections();
		const a = new FakeConnection();
		const b = new FakeConnection();
		const otherPin = { ...PIN, slot: "host:slot-b" };
		store.park(PIN, a);
		store.park(otherPin, b);
		assert.equal(store.take(otherPin), b);
		assert.equal(a.closed, false, "taking one slot's connection leaves the other's");
		assert.equal(store.take(PIN), a);
	});

	it("closes every connection nobody claimed when the pass ends, and says how many", () => {
		const store = new ParkedRpcConnections();
		const a = new FakeConnection();
		const b = new FakeConnection();
		store.park(PIN, a);
		store.park({ ...PIN, slot: "host:slot-b" }, b);
		assert.equal(store.release(), 2);
		assert.equal(a.closed && b.closed, true);
		assert.equal(store.size, 0);
		assert.equal(store.release(), 0, "ending twice closes nothing twice");
	});

	it("refuses a connection a reconcile offers after the pass ended, and closes it at once", () => {
		const store = new ParkedRpcConnections();
		store.release();
		const late = new FakeConnection();
		assert.equal(store.park(PIN, late), false);
		assert.equal(late.closed, true);
		assert.equal(store.size, 0);
	});

	describe("the time limit", () => {
		it("closes a connection nobody claimed once its limit is up, and not before", (context) => {
			context.mock.timers.enable({ apis: ["setTimeout"] });
			const store = new ParkedRpcConnections();
			const connection = new FakeConnection();
			store.park(PIN, connection);
			context.mock.timers.tick(PARKED_RPC_TTL_MS - 1);
			assert.equal(connection.closed, false);
			assert.equal(store.size, 1);
			context.mock.timers.tick(1);
			assert.equal(connection.closed, true);
			assert.equal(store.size, 0);
			assert.equal(store.take(PIN), null);
		});

		it("does not close a connection the attach already claimed", (context) => {
			context.mock.timers.enable({ apis: ["setTimeout"] });
			const store = new ParkedRpcConnections({ ttlMs: 100 });
			const connection = new FakeConnection();
			store.park(PIN, connection);
			assert.equal(store.take(PIN), connection);
			context.mock.timers.tick(1_000);
			assert.equal(connection.closed, false, "the claimed connection is the attach's now");
		});

		it("does not let a replaced connection's limit close its successor", (context) => {
			context.mock.timers.enable({ apis: ["setTimeout"] });
			const store = new ParkedRpcConnections({ ttlMs: 100 });
			const first = new FakeConnection();
			const second = new FakeConnection();
			store.park(PIN, first);
			context.mock.timers.tick(60);
			store.park(PIN, second);
			context.mock.timers.tick(60);
			assert.equal(second.closed, false, "the successor has its own full limit");
			context.mock.timers.tick(40);
			assert.equal(second.closed, true);
		});
	});
});
