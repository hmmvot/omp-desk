import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type LoggedLine, recordingLogger } from "../shared/logger.ts";
import { startFsTurnaroundProbe } from "./fs-turnaround.ts";

describe("startup file-system turnaround probe", () => {
	it("logs one line with the median and the largest turnaround of each call style once the last sample has returned", async () => {
		const logged: LoggedLine[] = [];
		let clock = 0;
		const asyncCosts = [5, 400, 7];
		let call = 0;
		startFsTurnaroundProbe({
			log: recordingLogger(logged),
			target: "unused",
			samples: 3,
			intervalMs: 1,
			now: () => clock,
			statSync: () => { clock += 1; },
			statAsync: async () => { clock += asyncCosts[call++]!; },
		});
		for (let waited = 0; waited < 200 && logged.length === 0; waited++) await new Promise(resolve => setTimeout(resolve, 5));
		assert.equal(logged.length, 1);
		assert.equal(logged[0]!.level, "info");
		assert.equal(
			logged[0]!.message,
			"window timing: startup file-system turnaround over 3 samples every 1 ms (asynchronous stat: median 7 ms, max 400 ms; synchronous stat: median 1 ms, max 1 ms); slowest asynchronous stats: 400 ms at +7 ms",
		);
	});

	it("says nothing when it is stopped before the last sample", async () => {
		const logged: LoggedLine[] = [];
		const stop = startFsTurnaroundProbe({ log: recordingLogger(logged), target: "unused", samples: 50, intervalMs: 1 });
		stop();
		await new Promise(resolve => setTimeout(resolve, 20));
		assert.deepEqual(logged, []);
	});
});
