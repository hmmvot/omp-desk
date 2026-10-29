import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { CallLane } from "./call-lane.ts";

describe("CallLane", () => {
	beforeEach(() => mock.timers.enable({ apis: ["setTimeout"] }));
	afterEach(() => mock.timers.reset());

	it("runs one call at a time, in request order", async () => {
		const lane = new CallLane();
		const events: string[] = [];
		const first = Promise.withResolvers<string>();
		const one = lane.run(async () => { events.push("one starts"); return await first.promise; }, 1000, () => "expired");
		const two = lane.run(async () => { events.push("two starts"); return "two"; }, 1000, () => "expired");
		await Promise.resolve();
		assert.deepEqual(events, ["one starts"], "the second call waits for the lane");
		first.resolve("one");
		assert.equal(await one, "one");
		assert.equal(await two, "two");
		assert.deepEqual(events, ["one starts", "two starts"]);
	});

	it("answers a request that missed its deadline and never starts a call whose deadline passed in the queue", async () => {
		const lane = new CallLane();
		const held = Promise.withResolvers<string>();
		const running = lane.run(async () => await held.promise, 10_000, () => "expired");
		let started = false;
		const queued = lane.run(async () => { started = true; return "late"; }, 500, () => "expired");
		mock.timers.tick(500);
		assert.equal(await queued, "expired");
		held.resolve("done");
		assert.equal(await running, "done");
		await lane.run(async () => "after", 1000, () => "expired");
		assert.equal(started, false, "a request that was answered as expired is not started later");
	});

	it("keeps the lane while a call that missed its deadline is still running", async () => {
		const lane = new CallLane();
		const stalled = Promise.withResolvers<string>();
		let sawExpired = false;
		const first = lane.run(
			async isExpired => {
				const value = await stalled.promise;
				sawExpired = isExpired();
				return value;
			},
			100,
			() => "expired",
		);
		let secondStarted = false;
		const second = lane.run(async () => { secondStarted = true; return "second"; }, 10_000, () => "expired");
		await Promise.resolve(); // the first call has started and now holds the lane
		mock.timers.tick(100);
		assert.equal(await first, "expired");
		await Promise.resolve();
		assert.equal(secondStarted, false, "no second call starts while the stalled one holds the lane");
		stalled.resolve("late");
		assert.equal(await second, "second");
		assert.equal(sawExpired, true, "a running call learns that nobody waits for it");
	});

	it("rejects with the call's error while its request is still live", async () => {
		const lane = new CallLane();
		await assert.rejects(lane.run(async () => { throw new Error("boom"); }, 1000, () => "expired"), /boom/);
		assert.equal(await lane.run(async () => "next", 1000, () => "expired"), "next", "a failed call frees the lane");
	});
});
