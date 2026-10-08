/**
 * Tests for the per-tab lifecycle gate: one operation per tab at a time, in request
 * order, across the operations that mutate one tab's facts.
 *
 * The gate is what makes "the runtime this promotion captured cannot be replaced while
 * its claim work is in flight" true, so these tests pin the two properties it depends
 * on: exclusion (nothing interleaves) and liveness (a resolved, rejected or unrelated
 * operation never wedges the tab).
 *
 * Runner: `node:test`. Run with `bun test src/host/tab-lifecycle.test.ts` or
 * `node --test src/host/tab-lifecycle.test.ts`.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TabLifecycle } from "./tab-lifecycle.ts";
import type { TabLifecycleLease } from "./tab-lifecycle.ts";

/** A promise a test settles by hand, so no test waits on real time. */
function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
	const { promise, resolve } = Promise.withResolvers<void>();
	return { promise, resolve };
}

describe("TabLifecycle", () => {
	it("runs one operation per tab at a time, in request order", async () => {
		const gate = new TabLifecycle();
		const events: string[] = [];
		const firstHold = deferred();
		let open = 0;
		let peak = 0;
		const operation = (label: string, hold: Promise<void> | null) =>
			gate.run("tab:a", async () => {
				open += 1;
				peak = Math.max(peak, open);
				events.push(`${label}:enter`);
				if (hold !== null) await hold;
				events.push(`${label}:exit`);
				open -= 1;
			});

		const first = operation("first", firstHold.promise);
		const second = operation("second", null);
		const third = operation("third", null);
		// The first operation stays open until released, so the others can only queue
		// behind it.
		firstHold.resolve();
		await Promise.all([first, second, third]);

		assert.equal(peak, 1, "one operation at a time for the tab");
		assert.deepEqual(events, [
			"first:enter",
			"first:exit",
			"second:enter",
			"second:exit",
			"third:enter",
			"third:exit",
		]);
	});

	it("does not make a different tab wait for the held one", async () => {
		const gate = new TabLifecycle();
		const hold = deferred();
		const held = gate.run("tab:a", async () => {
			await hold.promise;
		});

		assert.equal(await gate.run("tab:b", async () => "done"), "done");
		hold.resolve();
		await held;
	});

	it("keeps the queue moving when an operation rejects", async () => {
		const gate = new TabLifecycle();
		const failing = gate.run("tab:a", async () => {
			throw new Error("boom");
		});
		const queued = gate.run("tab:a", async () => "after failure");

		await assert.rejects(failing, /boom/);
		assert.equal(await queued, "after failure", "one failure does not wedge the tab");
	});

	it("hands the running operation the lease that is held, and no other", async () => {
		const gate = new TabLifecycle();
		const started = Promise.withResolvers<void>();
		const hold = Promise.withResolvers<void>();
		const seen: TabLifecycleLease[] = [];
		const running = gate.run("tab:a", async lease => {
			seen.push(lease);
			started.resolve();
			await hold.promise;
		});
		await started.promise;

		const lease = seen[0];
		assert.ok(lease, "the operation received a lease");
		assert.equal(lease.tabId, "tab:a");
		assert.equal(gate.holds(lease), true, "the running operation's lease is the held one");
		assert.equal(gate.holds({ tabId: "tab:a" }), false, "a lease the gate never created is not held");
		assert.equal(gate.holds({ tabId: "tab:b" }), false, "another tab's lease is not held either");

		hold.resolve();
		await running;
		assert.equal(gate.holds(lease), false, "the tab is free once its operation has settled");
	});
});
