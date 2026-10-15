/** The activation timer: each phase's wall and CPU time, and the one line it makes. Runner: `node --test src/host/activation-timing.test.ts`. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ActivationTimer } from "./activation-timing.ts";

function clock(): { readonly at: { wall: number; cpu: number }; readonly timer: ActivationTimer } {
	const at = { wall: 1_000, cpu: 500 };
	return { at, timer: new ActivationTimer({ now: () => at.wall, cpu: () => at.cpu }) };
}

describe("the activation timer", () => {
	it("measures each phase from the previous mark, wall and CPU", () => {
		const { at, timer } = clock();
		at.wall += 40; at.cpu += 35;
		timer.mark("setup");
		at.wall += 900; at.cpu += 20;
		timer.mark("catalog");
		assert.deepEqual(timer.phases(), [
			{ name: "setup", wallMs: 40, cpuMs: 35 },
			{ name: "catalog", wallMs: 900, cpuMs: 20 },
		]);
	});

	it("reads as one line with the lead-in, the phases and the total, rounded", () => {
		const { at, timer } = clock();
		at.wall += 40.4; at.cpu += 35.2;
		timer.mark("setup");
		at.wall += 900.4; at.cpu += 20;
		timer.mark("catalog");
		assert.equal(
			timer.summary([["host up when the bundle began loading", 812.6], ["bundle evaluation", 140.2]]),
			"host up when the bundle began loading 813 · bundle evaluation 140 · setup 40 (cpu 35) · catalog 900 (cpu 20) · activate() total 941 (cpu 55)",
		);
	});

	it("reads without a lead-in or phases", () => {
		const { timer } = clock();
		assert.equal(timer.summary(), "activate() total 0 (cpu 0)");
	});
});
