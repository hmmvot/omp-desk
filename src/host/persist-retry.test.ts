import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { recordingLogger } from "../shared/logger.ts";
import type { LoggedLine } from "../shared/logger.ts";
import { PersistRetry } from "./persist-retry.ts";
import { PersistFailureReporter } from "./persist-report.ts";

describe("persist retry", () => {
	/** A write that keeps failing: every run asks for the next try, with `limit` tries allowed. */
	function rig(options?: { firstMs?: number; maxMs?: number }, limit = Number.POSITIVE_INFINITY) {
		mock.timers.enable({ apis: ["setTimeout"] });
		const runs: number[] = [];
		const retry: PersistRetry = new PersistRetry(async () => { runs.push(runs.length + 1); retry.schedule(limit); }, options);
		return { retry, runs };
	}

	it("doubles from one second up to thirty, then keeps that interval", () => {
		const { retry, runs } = rig();
		try {
			retry.schedule();
			const waits = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000];
			for (const [at, wait] of waits.entries()) {
				mock.timers.tick(wait - 1);
				assert.equal(runs.length, at, `no run before ${wait} ms`);
				mock.timers.tick(1);
				assert.equal(runs.length, at + 1, `a run at ${wait} ms`);
			}
		} finally {
			retry.reset();
			mock.timers.reset();
		}
	});

	it("folds calls made while a try is waiting into it, and a success ends it", () => {
		const { retry, runs } = rig({ firstMs: 10, maxMs: 10 });
		try {
			retry.schedule();
			retry.schedule();
			mock.timers.tick(10);
			assert.equal(runs.length, 1, "one try, however often it was asked for");
			retry.reset();
			mock.timers.tick(100);
			assert.equal(runs.length, 1, "nothing runs after a write landed");
			assert.equal(retry.attempts, 0);
		} finally {
			retry.reset();
			mock.timers.reset();
		}
	});

	it("stops at a limit, for a failure that is not contention", () => {
		const { retry, runs } = rig({ firstMs: 10, maxMs: 10 }, 2);
		try {
			retry.schedule(2);
			for (let tick = 0; tick < 5; tick++) mock.timers.tick(10);
			assert.equal(runs.length, 2, "two tries, then no third");
		} finally {
			retry.reset();
			mock.timers.reset();
		}
	});
});

describe("persist failure reporter", () => {
	function reporter() {
		const lines: LoggedLine[] = [];
		const shown: string[] = [];
		return { lines, shown, reporter: new PersistFailureReporter(recordingLogger(lines), message => shown.push(message)) };
	}

	it("only logs contention between windows, with its cause, and shows nothing", () => {
		const r = reporter();
		const cause = "The session index could not be persisted: Another VS Code window is writing the OMP Desk profile catalog, so this change was not saved yet.";
		r.reporter.report({ persistError: cause, persistBusy: true }, "The OMP session index could not be saved: ");
		r.reporter.report({ persistError: cause, persistBusy: true });
		assert.deepEqual(r.shown, []);
		assert.equal(r.lines.length, 2);
		assert.ok(r.lines.every(line => line.level === "warn" && line.message.includes(cause) && line.message.includes("contention between windows")));
	});

	it("shows a fault once per cause, however often it is reported, and logs it every time", () => {
		const r = reporter();
		r.reporter.report({ persistError: "disk is full", persistBusy: false }, "Not saved: ");
		r.reporter.report({ persistError: "disk is full", persistBusy: false }, "Not saved: ");
		r.reporter.report({ persistError: "catalog damaged" }, "Not saved: ");
		r.reporter.report({ persistError: null });
		assert.deepEqual(r.shown, ["Not saved: disk is full", "Not saved: catalog damaged"]);
		assert.equal(r.lines.length, 3);
	});
});
