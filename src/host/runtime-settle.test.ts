/**
 * Tests for the wait that lets a Resume clicked during an ended runtime's exit cleanup start after it.
 *
 * Runner: `node --test src/host/runtime-settle.test.ts`
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { awaitEndedRuntimeCleanup } from "./runtime-settle.ts";
import type { RuntimeSettlePorts } from "./runtime-settle.ts";

function clock() {
	let now = 0;
	return {
		now: () => now,
		pause: async (ms: number) => {
			now += ms;
		},
	};
}

describe("a request that arrives while an ended runtime is still being cleaned up", () => {
	it("waits for the runtime to leave the tab, then for the queued lifecycle work, and only then proceeds", async () => {
		const events: string[] = [];
		const time = clock();
		let holds = 3;
		const ports: RuntimeSettlePorts = {
			...time,
			holdsEndedRuntime: () => {
				events.push("look");
				return holds-- > 0;
			},
			drainLifecycle: async () => void events.push("drain"),
		};
		assert.equal(await awaitEndedRuntimeCleanup(ports), true);
		assert.deepEqual(events, ["look", "look", "look", "look", "drain"], "no proceeding before the cleanup and the drain");
	});

	it("does not wait at all for a tab that no longer holds the runtime, beyond draining its queued work", async () => {
		const events: string[] = [];
		const ports: RuntimeSettlePorts = {
			...clock(),
			holdsEndedRuntime: () => false,
			drainLifecycle: async () => void events.push("drain"),
		};
		assert.equal(await awaitEndedRuntimeCleanup(ports), true);
		assert.deepEqual(events, ["drain"]);
	});

	it("gives up at the deadline when the cleanup never completes, so the request is answered instead of hanging", async () => {
		let drained = false;
		const ports: RuntimeSettlePorts = {
			...clock(),
			holdsEndedRuntime: () => true,
			drainLifecycle: async () => void (drained = true),
		};
		assert.equal(await awaitEndedRuntimeCleanup(ports, 1_000), false);
		assert.equal(drained, false);
	});

	it("does not wait forever on a lifecycle drain that never completes (a caller that holds the tab's gate itself)", async () => {
		const ports: RuntimeSettlePorts = {
			...clock(),
			holdsEndedRuntime: () => false,
			drainLifecycle: () => new Promise<void>(() => {}),
		};
		assert.equal(await awaitEndedRuntimeCleanup(ports, 1_000), false);
	});
});
