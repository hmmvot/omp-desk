import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type LoggedLine, recordingLogger } from "../shared/logger.ts";
import { EventLoopLagMonitor, startLoopLagMonitor, trackOperation } from "./loop-lag.ts";

/** A monitor on a clock the test moves: `tick(ms)` is "the timer fired `ms` after the previous sample". */
function monitor(options: { thresholdMs?: number; tickMs?: number } = {}) {
	let now = 1000;
	let cpu = 0;
	const logged: LoggedLine[] = [];
	const instance = new EventLoopLagMonitor({ log: recordingLogger(logged), now: () => now, cpuMs: () => cpu, ...options });
	return {
		instance,
		logged,
		get lines(): string[] { return logged.map(line => line.message); },
		advance(ms: number) { now += ms; },
		burn(ms: number) { cpu += ms; },
		/** The timer fires `ms` after the last one. */
		tick(ms: number) { now += ms; instance.sample(); },
	};
}

describe("event loop lag monitor", () => {
	it("stays silent while the timer fires on time or slightly late", () => {
		const m = monitor();
		m.tick(100);
		m.tick(180);
		m.tick(100 + 499);
		assert.deepEqual(m.lines, []);
	});

	it("reports a stall of the threshold or more with how late the timer ran and what the process spent", () => {
		const m = monitor();
		m.burn(40);
		m.tick(100 + 1234);
		assert.equal(m.lines.length, 1);
		assert.match(m.lines[0]!, /event loop blocked for 1234 ms/);
		assert.match(m.lines[0]!, /process CPU 40 ms in 1334 ms/);
	});

	it("splits the process CPU by mode and counts the page faults of the stall, so a spinning thread is told from the OS and from memory taken away", () => {
		let split = { userMs: 0, systemMs: 0, pageFaults: 0 };
		let now = 1000;
		const logged: LoggedLine[] = [];
		const instance = new EventLoopLagMonitor({ log: recordingLogger(logged), now: () => now, cpuMs: () => split.userMs + split.systemMs, split: () => split });
		split = { userMs: 300, systemMs: 700, pageFaults: 4200 };
		now += 1334;
		instance.sample();
		assert.match(logged[0]!.message, /process CPU 1000 ms in 1334 ms; user 300 ms, system 700 ms, page faults 4200\)/);
		assert.doesNotMatch(logged[0]!.message, /event loop busy/);
	});

	it("counts real page faults by default: touching new memory between two samples shows in the line", () => {
		let now = 1000;
		const logged: LoggedLine[] = [];
		const instance = new EventLoopLagMonitor({ log: recordingLogger(logged), now: () => now });
		const stop = instance.start();
		stop();
		const touched = Buffer.alloc(64 * 1024 * 1024, 1);
		now += 1334;
		instance.sample();
		assert.ok(touched.length > 0);
		const faults = /page faults (\d+)\)/.exec(logged[0]!.message);
		assert.ok(faults !== null, logged[0]!.message);
		assert.ok(Number(faults[1]) > 1000, `the 64 MB written between the samples left ${faults[1]} page faults`);
	});

	it("logs a stall of a second or more as a warning and a shorter one as debug", () => {
		const m = monitor();
		m.tick(100 + 700);
		m.tick(100 + 1000);
		assert.deepEqual(m.logged.map(line => line.level), ["debug", "warn"]);
	});

	it("logs how long an operation held the thread before its first await at the stall's level", () => {
		const m = monitor({ thresholdMs: 500 });
		m.instance.run("short hold", () => m.advance(600));
		m.instance.run("long hold", () => m.advance(1500));
		assert.deepEqual(m.logged.map(line => line.level), ["debug", "warn"]);
	});

	it("says so when no marked Desk operation overlapped the stall", () => {
		const m = monitor();
		m.tick(100 + 800);
		assert.match(m.lines[0]!, /no marked Desk operation was running/);
	});

	it("names an operation still running and one that ended inside the stall, not one that ended before it", () => {
		const m = monitor();
		const before = m.instance.begin("finished before");
		m.advance(10);
		before();
		m.tick(100);
		const inside = m.instance.begin("ended inside");
		m.instance.begin("still running");
		m.advance(300);
		inside();
		m.tick(100 + 900);
		const line = m.lines[0]!;
		assert.match(line, /ended inside \(ended after 300 ms\)/);
		assert.match(line, /still running \(running 1300 ms\)/);
		assert.doesNotMatch(line, /finished before/);
	});

	it("reports at once how long an operation held the thread before its first await, and keeps a promise open until it settles", async () => {
		const m = monitor({ thresholdMs: 500 });
		const gate = Promise.withResolvers<string>();
		const promise = m.instance.run("slow command", () => {
			m.advance(750);
			return gate.promise;
		});
		assert.match(m.lines[0]!, /slow command held the event loop for 750 ms before its first await/);
		// The timer that was due during the hold fires late by the hold, and the operation is still open.
		m.tick(100);
		assert.match(m.lines[1]!, /blocked for 750 ms.*slow command \(running 850 ms, 750 ms before its first await\)/);
		gate.resolve("done");
		assert.equal(await promise, "done");
		m.tick(100 + 600);
		assert.match(m.lines[2]!, /blocked for 600 ms.*slow command \(ended after 850 ms/);
	});

	it("closes the mark and rethrows when the operation throws or rejects", async () => {
		const m = monitor();
		assert.throws(() => m.instance.run("sync failure", () => { throw new Error("boom"); }), /boom/);
		await assert.rejects(m.instance.run("async failure", () => Promise.reject(new Error("later"))), /later/);
		m.tick(100 + 900);
		assert.doesNotMatch(m.lines[0]!, /running \d+ ms/, "neither operation is still marked running");
		assert.match(m.lines[0]!, /sync failure \(ended/);
		assert.match(m.lines[0]!, /async failure \(ended/);
	});

	it("does not take a machine suspend for a stall", () => {
		const m = monitor();
		m.tick(100 + 11 * 60_000);
		assert.deepEqual(m.lines, []);
	});

	it("names at most six operations and counts the rest", () => {
		const m = monitor();
		for (let index = 0; index < 9; index++) m.instance.begin(`operation ${index}`);
		m.tick(100 + 700);
		assert.match(m.lines[0]!, /and 3 more/);
		assert.match(m.lines[0]!, /operation 8/);
		assert.doesNotMatch(m.lines[0]!, /operation 0 /);
	});

	// The one test on the platform's real timer: the stall it must see is this thread's own, which no fake clock can produce.
	it("detects a real stall of this thread through the started timer", async () => {
		const lines: string[] = [];
		const stalled = Promise.withResolvers<void>();
		const record = (line: string): void => {
			lines.push(line);
			if (line.startsWith("event loop blocked")) stalled.resolve();
		};
		const stop = startLoopLagMonitor({ error: record, warn: record, info: record, debug: record, trace: record });
		try {
			trackOperation("busy section", () => {
				const until = Date.now() + 700;
				while (Date.now() < until) { /* hold the thread */ }
			});
			await stalled.promise;
		} finally {
			stop();
		}
		assert.ok(lines.some(line => /held the event loop for \d+ ms before its first await/.test(line)), lines.join("\n"));
		assert.ok(lines.some(line => /event loop blocked for \d+ ms.*busy section \(ended after/.test(line)), lines.join("\n"));
	});

	it("runs an unmarked operation untouched when no monitor is started", () => {
		assert.equal(trackOperation("nothing watching", () => 7), 7);
	});
});
