/**
 * Behaviour tests for the coalescing runner behind catalog adoption.
 *
 * Runner: `node --test src/host/coalesced-run.test.ts`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CoalescedRun } from "./coalesced-run.ts";

function gate(): { readonly opened: Promise<void>; open(): void } {
	const { promise, resolve } = Promise.withResolvers<void>();
	return { opened: promise, open: () => resolve() };
}

describe("CoalescedRun", () => {
	it("starts an idle request at once", async () => {
		const seen: number[] = [];
		const runner = new CoalescedRun<number>(async request => { seen.push(request); }, (a, b) => a + b);
		await runner.request(1);
		await runner.request(2);
		assert.deepEqual(seen, [1, 2]);
	});

	it("folds every request that arrives during a run into one follow-up that sees all of them", async () => {
		const seen: number[] = [];
		const first = gate();
		const runner = new CoalescedRun<number>(async request => {
			seen.push(request);
			if (seen.length === 1) await first.opened;
		}, (a, b) => a + b);
		const started = runner.request(1);
		const joined = [runner.request(10), runner.request(20), runner.request(30)];
		assert.deepEqual(seen, [1], "nothing runs beside the job in flight");
		first.open();
		await Promise.all([started, ...joined]);
		assert.deepEqual(seen, [1, 60], "one follow-up carries the merged request");
	});

	it("does not resolve a request before a run that began after it has finished", async () => {
		const order: string[] = [];
		const first = gate();
		const second = gate();
		let runs = 0;
		const runner = new CoalescedRun<void>(async () => {
			const run = ++runs;
			order.push(`start ${run}`);
			await (run === 1 ? first : second).opened;
			order.push(`end ${run}`);
		}, () => undefined);
		const early = runner.request();
		const late = runner.request().then(() => order.push("late resolved"));
		first.open();
		await early;
		order.push("early resolved");
		second.open();
		await late;
		assert.deepEqual(order, ["start 1", "end 1", "start 2", "early resolved", "end 2", "late resolved"]);
	});

	it("reports a failure to the requests that run served and still runs the follow-up", async () => {
		const first = gate();
		let runs = 0;
		const runner = new CoalescedRun<void>(async () => {
			runs++;
			if (runs === 1) {
				await first.opened;
				throw new Error("first failed");
			}
		}, () => undefined);
		const failing = runner.request();
		const follow = runner.request();
		first.open();
		await assert.rejects(failing, /first failed/);
		await follow;
		assert.equal(runs, 2);
		await runner.request();
		assert.equal(runs, 3, "a failed run leaves the runner usable");
	});

	it("reports a follow-up's failure only to the requests it served", async () => {
		const first = gate();
		let runs = 0;
		const runner = new CoalescedRun<void>(async () => {
			runs++;
			if (runs === 1) await first.opened;
			else throw new Error("follow-up failed");
		}, () => undefined);
		const started = runner.request();
		const follow = runner.request();
		first.open();
		await started;
		await assert.rejects(follow, /follow-up failed/);
	});
});
