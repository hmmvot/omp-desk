import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { installStatsOpener, statsWindowsOpenerTarget } from "../../media/stats-opener.mjs";

function command(target: string): string[] {
	return ["C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(`$ErrorActionPreference='Stop';Start-Process '${target}'`, "utf16le").toString("base64")];
}

function harness() {
	const spawns: unknown[][] = [];
	const logs: unknown[][] = [];
	const reports: string[] = [];
	const result = { exited: Promise.resolve(0), pid: 1234 };
	const runtime = { spawn(...args: unknown[]) { spawns.push(args); return result; } };
	const logger = { log(...args: unknown[]) { logs.push(args); } };
	return { runtime, logger, reports, spawns, logs, result };
}

describe("child-local Stats opener interception", () => {
	it("suppresses only the exact printed dashboard's native Windows opener", () => {
		const h = harness();
		assert.equal(installStatsOpener(h.runtime, h.logger, (marker: string) => h.reports.push(marker)), true);
		h.logger.log("\x1b[32mDashboard available at: http://127.0.0.1:3847\x1b[0m");
		const options = { stdin: "ignore", stdout: "ignore", stderr: "ignore", windowsHide: true };
		assert.equal(h.runtime.spawn(command("http://127.0.0.1:3847"), options), h.result);
		assert.deepEqual(h.spawns[0], [[command("")[0], "-NoProfile", "-NonInteractive", "-Command", "exit 0"], options]);
		assert.equal(h.logs.length, 1);
		assert.ok(h.reports.includes("OMP_DESK_STATS_OPENER_SUPPRESSED"));
	});
	it("passes unrelated subprocesses and other URL openers through with their original arguments", () => {
		const h = harness(); installStatsOpener(h.runtime, h.logger, (marker: string) => h.reports.push(marker));
		h.logger.log("Dashboard available at: http://127.0.0.1:3847");
		for (const args of [[command("https://example.com"), { stdout: "pipe" }], [["bun.exe", "worker.ts"]], [command("http://127.0.0.1:3848")]]) {
			h.runtime.spawn(...args); assert.deepEqual(h.spawns.at(-1), args);
		}
	});
	it("cannot suppress a browser opener before this process prints readiness", () => {
		const h = harness(); installStatsOpener(h.runtime, h.logger, (marker: string) => h.reports.push(marker));
		const args = command("http://127.0.0.1:3847"); h.runtime.spawn(args);
		assert.equal(h.spawns[0]?.[0], args);
	});
	it("does not match changed scripts, executables, extra flags or a nonidentical URL", () => {
		const url = "http://127.0.0.1:3847";
		assert.equal(statsWindowsOpenerTarget(command(url), url), url);
		for (const args of [[...command(url), "extra"], ["other.exe", ...command(url).slice(1)], command(`${url}/`), command(`${url};anything`), [command(url)[0], "-Command", "Start-Process anything"]]) {
			assert.equal(statsWindowsOpenerTarget(args, url), null);
		}
	});
	it("degrades without changing an immutable runtime or inventing a subprocess result", () => {
		const h = harness(); Object.freeze(h.runtime);
		assert.equal(installStatsOpener(h.runtime, h.logger, (marker: string) => h.reports.push(marker)), false);
		h.runtime.spawn(["bun.exe", "--version"]);
		assert.equal(h.spawns.length, 1);
		assert.ok(!h.reports.includes("OMP_DESK_STATS_PRELOAD_READY"));
	});
});
