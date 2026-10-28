/**
 * The loop-lag gauge of the restore timing line: how late a 10 ms timer ran while a call was in flight.
 *
 * The clock is injected and jumped, so a "blocked loop" costs the test nothing: the timer fires on time in real time
 * and the gauge sees a stretch it did not expect.
 *
 * Runner: `node --test src/host/loop-gauge.test.ts`
 */
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, it } from "node:test";
import { LOOP_LAG_INTERVAL_MS, startLoopLagGauge } from "./loop-gauge.ts";

describe("startLoopLagGauge", () => {
	it("reads the stretch a firing ran late as the loop's lag", async () => {
		let clock = 1_000;
		const gauge = startLoopLagGauge(() => clock);
		clock += 260;
		await sleep(40);
		assert.equal(gauge.stop(), 260 - LOOP_LAG_INTERVAL_MS, "the first firing came 260 ms after the start instead of 10");
	});

	it("keeps the worst firing, not the last", async () => {
		let clock = 0;
		const gauge = startLoopLagGauge(() => clock);
		clock += 110;
		await sleep(30);
		clock += LOOP_LAG_INTERVAL_MS;
		await sleep(30);
		assert.equal(gauge.stop(), 100);
	});

	it("counts a block that ended just before the call did, though the timer has not fired since", () => {
		let clock = 0;
		const gauge = startLoopLagGauge(() => clock);
		clock += 510;
		assert.equal(gauge.stop(), 500);
	});

	it("reports no lag for a loop that kept time", () => {
		let clock = 0;
		const gauge = startLoopLagGauge(() => clock);
		clock += 4;
		assert.equal(gauge.stop(), 0);
	});

	it("stops its timer", async () => {
		let reads = 0;
		const gauge = startLoopLagGauge(() => {
			reads += 1;
			return 0;
		});
		gauge.stop();
		const after = reads;
		await sleep(50);
		assert.equal(reads, after, "no firing after stop");
	});
});
