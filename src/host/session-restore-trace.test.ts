import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { IdentityTurns, RestoreStepTimer, mapBounded, timedStep } from "./session-restore-trace.ts";

describe("mapBounded", () => {
	it("returns results by input position and never runs more than the limit at once", async () => {
		const gates = Array.from({ length: 5 }, () => Promise.withResolvers<void>());
		let inFlight = 0;
		let peak = 0;
		const started: number[] = [];
		const run = mapBounded([0, 1, 2, 3, 4], 2, async position => {
			started.push(position);
			peak = Math.max(peak, ++inFlight);
			await gates[position]?.promise;
			inFlight--;
			return `row ${position}`;
		});
		await Promise.resolve();
		assert.deepEqual(started, [0, 1], "items start in input order, up to the limit");
		for (const position of [1, 0, 3, 2, 4]) {
			gates[position]?.resolve();
			await Promise.resolve();
		}
		assert.deepEqual(await run, ["row 0", "row 1", "row 2", "row 3", "row 4"]);
		assert.equal(peak, 2);
	});

	it("treats a limit below one as one and an empty list as nothing to do", async () => {
		assert.deepEqual(await mapBounded([], 4, async () => 1), []);
		let peak = 0;
		let inFlight = 0;
		await mapBounded([1, 2, 3], 0, async () => {
			peak = Math.max(peak, ++inFlight);
			await Promise.resolve();
			inFlight--;
		});
		assert.equal(peak, 1);
	});
});

describe("RestoreStepTimer", () => {
	it("reports admission before the first measured step, each step once, and the rest as persist", async () => {
		let clock = 1_000;
		const timer = new RestoreStepTimer(() => clock);
		clock += 40; // claim checks
		await timer.measure("reconcile", async () => { clock += 300; });
		await timer.measure("reconcile", async () => { clock += 20; });
		await timer.measure("attach", async () => { clock += 500; });
		timer.detail("attach", { connect: 450.4, conversation: 49.6 });
		clock += 15; // row persistence
		assert.equal(
			timer.finish("attached"),
			"attached in 875 ms · admission 40 · reconcile 320 · attach 500 (connect 450, conversation 50) · persist 15",
		);
	});

	it("names the pieces of admission under it, in the order they ran", async () => {
		let clock = 0;
		const timer = new RestoreStepTimer(() => clock);
		const admission = timer.sink("admission");
		await admission.measure("session file", async () => { clock += 2; });
		await admission.measure("claim take", async () => { clock += 3_900; });
		clock += 5;
		await timer.measure("reconcile", async () => { clock += 40; });
		assert.equal(
			timer.finish("attached"),
			"attached in 3947 ms · admission 3907 (session file 2, claim take 3900) · reconcile 40 · persist 0",
		);
	});

	it("still times a row that ended before any measured step", () => {
		let clock = 0;
		const timer = new RestoreStepTimer(() => clock);
		clock += 12;
		assert.equal(timer.finish("failed:missing-file"), "failed:missing-file in 12 ms · admission 12");
	});

	it("counts a step whose call threw", async () => {
		let clock = 0;
		const timer = new RestoreStepTimer(() => clock);
		await assert.rejects(timer.measure("attach", async () => { clock += 30; throw new Error("reset"); }));
		assert.match(timer.finish("failed"), /attach 30/);
	});

	it("breaks a reconcile into the pieces its sink timed, summed over calls and in the order first seen", async () => {
		let clock = 0;
		const timer = new RestoreStepTimer(() => clock);
		await timer.measure("reconcile", async () => {
			const sink = timer.sink("reconcile");
			await sink.measure("record", async () => { clock += 3; });
			await sink.measure("tree digest (shared)", async () => { clock += 8_100; });
			await sink.measure("connect", async () => { clock += 40; });
		});
		await timer.measure("reconcile", async () => {
			await timer.sink("reconcile").measure("record", async () => { clock += 2; });
		});
		assert.equal(
			timer.finish("attached"),
			"attached in 8145 ms · admission 0 · reconcile 8145 (record 5, tree digest (shared) 8100, connect 40) · persist 0",
		);
	});

	it("times a piece that threw and runs a piece unmeasured when no sink is given", async () => {
		let clock = 0;
		const timer = new RestoreStepTimer(() => clock);
		await timer.measure("reconcile", async () => {
			await assert.rejects(timer.sink("reconcile").measure("connect", async () => { clock += 7; throw new Error("refused"); }));
		});
		assert.match(timer.finish("failed"), /reconcile 7 \(connect 7\)/);
		assert.equal(await timedStep(undefined, "connect", async () => 42), 42);
	});
});

describe("IdentityTurns", () => {
	it("lets rows with one identity pass in the order they were issued, and others not wait", async () => {
		const turns = new IdentityTurns();
		const first = turns.next("a");
		const second = turns.next("a");
		const other = turns.next("b");
		const order: string[] = [];
		const secondPassed = second.wait().then(() => order.push("second"));
		await other.wait();
		await Promise.resolve();
		assert.equal(order.length, 0, "the later row waits for the earlier one");
		await first.wait();
		order.push("first");
		first.release();
		await secondPassed;
		assert.deepEqual(order, ["first", "second"]);
		second.release();
		second.release();
	});

	it("never waits when no identity is known", async () => {
		const turns = new IdentityTurns();
		await turns.next(null).wait();
		await turns.next(null).wait();
	});
});
