/**
 * Tests for the watch that notices an ended broker (Kill, Task Manager, a crash).
 *
 * Runner: `node --test src/host/broker-loss.test.ts`
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { awaitWriterGone, watchBrokerLoss } from "./broker-loss.ts";

/** A scheduler the test advances by hand: no real time passes. */
function manualTimers() {
	let pending: (() => void) | null = null;
	return {
		setTimer: (callback: () => void) => {
			pending = callback;
			return {};
		},
		clearTimer: () => {
			pending = null;
		},
		/** Run what is scheduled now, once. */
		tick(): boolean {
			const callback = pending;
			pending = null;
			callback?.();
			return callback !== null;
		},
		get armed(): boolean {
			return pending !== null;
		},
	};
}

const settle = async (): Promise<void> => {
	await Promise.resolve();
	await Promise.resolve();
};

describe("watching a broker", () => {
	it("keeps looking while the broker's process exists, and reports its loss once when it does not", async () => {
		const timers = manualTimers();
		let alive = true;
		const lost: number[] = [];
		watchBrokerLoss({ brokerPid: 4100, isCurrent: () => true, onLost: () => void lost.push(4100), isAlive: () => alive, ...timers });
		assert.equal(timers.armed, true);
		timers.tick();
		timers.tick();
		assert.deepEqual(lost, []);
		alive = false;
		timers.tick();
		await settle();
		assert.deepEqual(lost, [4100]);
		assert.equal(timers.armed, false, "a lost broker is reported once and the watch ends");
		assert.equal(timers.tick(), false);
	});

	it("asks the process by its own id", () => {
		const timers = manualTimers();
		const asked: number[] = [];
		watchBrokerLoss({ brokerPid: 4242, isCurrent: () => true, onLost: () => {}, isAlive: pid => (asked.push(pid), true), ...timers });
		timers.tick();
		assert.deepEqual(asked, [4242]);
	});

	it("ends silently when the runtime is no longer the one this window drives, even if its broker is gone (a stop's own shutdown ends the broker)", async () => {
		const timers = manualTimers();
		let current = true;
		const lost: string[] = [];
		watchBrokerLoss({ brokerPid: 1, isCurrent: () => current, onLost: () => void lost.push("lost"), isAlive: () => false, ...timers });
		current = false;
		timers.tick();
		await settle();
		assert.deepEqual(lost, []);
		assert.equal(timers.armed, false);
	});

	it("ends when asked to, and treats a liveness read that throws as alive: a guess never reports a loss", async () => {
		const timers = manualTimers();
		const lost: string[] = [];
		const stop = watchBrokerLoss({ brokerPid: 1, isCurrent: () => true, onLost: () => void lost.push("lost"), isAlive: () => { throw new Error("EPERM"); }, ...timers });
		timers.tick();
		assert.equal(timers.armed, true, "still watching after an unreadable look");
		stop();
		assert.equal(timers.armed, false);
		timers.tick();
		await settle();
		assert.deepEqual(lost, []);
	});

	it("does not let a failing exit handler escape", async () => {
		const timers = manualTimers();
		watchBrokerLoss({ brokerPid: 1, isCurrent: () => true, onLost: () => { throw new Error("boom"); }, isAlive: () => false, ...timers });
		timers.tick();
		await settle();
		assert.equal(timers.armed, false);
	});
});

describe("waiting for the writer of a runtime whose broker is gone", () => {
	const ports = (overrides: Partial<Parameters<typeof awaitWriterGone>[0]> = {}) => {
		const calls: string[] = [];
		return {
			calls,
			ports: {
				prove: async () => (calls.push("prove"), false),
				rootAlive: () => (calls.push("alive"), true),
				isCurrent: () => true,
				pause: async () => void calls.push("pause"),
				...overrides,
			} satisfies Parameters<typeof awaitWriterGone>[0],
		};
	};

	it("is proven at once when both recorded identities are gone", async () => {
		const { ports: p, calls } = ports({ prove: async () => true });
		assert.equal(await awaitWriterGone(p), true);
		assert.deepEqual(calls, []);
	});

	it("waits for a root that follows its broker, then proves it once the id stops existing", async () => {
		let alive = 3;
		let proofs = 0;
		const { ports: p } = ports({ rootAlive: () => --alive > 0, prove: async () => ++proofs >= 2 });
		assert.equal(await awaitWriterGone(p), true);
		assert.equal(proofs, 2, "the first proof came before the root was gone, the second after");
	});

	it("gives up with false when the root is still there after the whole wait, and never proves on a guess", async () => {
		let proofs = 0;
		const { ports: p } = ports({ prove: async () => (proofs++, false) });
		assert.equal(await awaitWriterGone(p), false);
		assert.equal(proofs, 2, "the first look and the last; an id that never stops existing is not probed in between");
	});

	it("tries the proof a few times when the root's id is gone but a probe fails, and treats a throwing probe as no proof", async () => {
		let proofs = 0;
		const { ports: p } = ports({ rootAlive: () => false, prove: async () => { proofs++; throw new Error("probe"); } });
		assert.equal(await awaitWriterGone(p), false);
		assert.equal(proofs, 4, "the first look and three tries");
	});

	it("stops waiting when the runtime is no longer this window's", async () => {
		let current = true;
		const { ports: p } = ports({ isCurrent: () => current, pause: async () => { current = false; } });
		assert.equal(await awaitWriterGone(p), false);
	});
});
