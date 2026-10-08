/**
 * The broker's owner-watch client (ADR-0030): what it accepts from the staged helper,
 * and what it refuses to read as an owner having exited.
 *
 * Runner: `node --test src/host/pty-owner-watch.test.ts`
 *
 * The helper is a long-lived process whose whole value is that it holds a handle on a
 * live process. That makes its *failure modes* part of the safety argument: a helper
 * that dies, floods, prints something unrecognised or never announces itself must be
 * surfaced as loss of the watch — which disarms automatic stopping upstream — and must
 * never be turned into a signal. This file runs a real helper-shaped process for each
 * of those, so the framing is exercised rather than described.
 *
 * The production launch path (the Windows PowerShell command line) is covered by the
 * end-to-end fixture in `src/broker/pty-owner-monitor.test.ts`, which runs the real
 * staged helper against real processes.
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import {
	startPtyOwnerWatcher,
	type PtyOwnerAdmission,
	type PtyOwnerWatchEvents,
	type PtyOwnerWatchHelper,
	type PtyOwnerWatcher,
} from "./pty-owner-watch.ts";

const roots: string[] = [];
let counter = 0;

after(async () => {
	for (const root of roots) await rm(root, { recursive: true, force: true });
});

/**
 * A helper-shaped process: the tests decide what it prints, and the client under test
 * decides what that means. `mode` selects the behaviour; every branch writes `!`-lines
 * exactly as the staged PowerShell helper does.
 */
const HELPER_MODE = `const mode = process.argv[2];
const send = line => process.stdout.write(line + "\\n");
if (mode === "silent") { setInterval(() => {}, 1000); } else { send("!READY " + process.pid); }
let stdin = "";
process.stdin.on("data", chunk => {
  stdin += chunk.toString();
  let index;
  while ((index = stdin.indexOf("\\n")) >= 0) {
    const line = stdin.slice(0, index);
    stdin = stdin.slice(index + 1);
    const parts = line.trim().split(" ");
    if (parts[0] === "quit") { send("!BYE"); process.exit(0); }
    if (parts[0] !== "admit") continue;
    const requestId = parts[1];
    const mainPid = parts[2];
    if (mode === "unsupported") { send("!UNSUPPORTED " + requestId + " PARENT_MISMATCH"); continue; }
    if (mode === "unusable") { send("!ADMITTED " + requestId + " not-a-pid not-a-time"); continue; }
    send("!ADMITTED " + requestId + " " + mainPid + " 134349421014308869");
    if (mode === "signal") setTimeout(() => send("!SIGNAL " + mainPid + " 134349421014308869"), 20);
    if (mode === "wait-failed") setTimeout(() => send("!FAILED SIGNAL_WAIT_FAILED " + mainPid), 20);
    if (mode === "exit") setTimeout(() => process.exit(3), 20);
  }
});
if (mode === "flood") send("!" + "x".repeat(16 * 1024));
if (mode === "unknown-line") setTimeout(() => send("!WHATEVER 1 2"), 20);
`;

interface Harness {
	readonly watcher: PtyOwnerWatcher;
	readonly signals: Array<{ pid: number; creationTime: string }>;
	readonly losses: string[];
}

async function start(helperMode: string, options: { timeoutMs?: number } = {}): Promise<Harness> {
	const root = await mkdtemp(path.join(tmpdir(), "omp-owner-watch-"));
	roots.push(root);
	counter += 1;
	const script = path.join(root, `helper-${counter}.js`);
	await writeFile(script, HELPER_MODE, "utf8");
	const bytes = await readFile(script);
	const helper: PtyOwnerWatchHelper = { path: script, sha256: createHash("sha256").update(bytes).digest("hex") };
	const signals: Array<{ pid: number; creationTime: string }> = [];
	const losses: string[] = [];
	const events: PtyOwnerWatchEvents = {
		onSignaledMain: (pid, creationTime) => signals.push({ pid, creationTime }),
		onWatchLost: detail => losses.push(detail),
	};
	const launch = (_helper: PtyOwnerWatchHelper, _args: readonly string[]): ChildProcess =>
		spawn(process.execPath, [script, helperMode], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
	const started = await startPtyOwnerWatcher(events, {
		helper,
		brokerPid: process.pid,
		admitTimeoutMs: options.timeoutMs ?? 3_000,
		launch,
	});
	assert.ok(started.watcher, started.detail ?? "the watch did not start");
	return { watcher: started.watcher, signals, losses };
}

const hint = { extensionHostPid: 700, parentPid: 701, mainPid: 701 };

async function waitFor(check: () => boolean, timeoutMs = 3_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("the awaited condition did not hold in time");
		await new Promise<void>(resolve => {
			const timer = setTimeout(resolve, 5);
			timer.unref();
		});
	}
}

describe("owner-watch client", () => {
	it("reads an admission and the signal that follows it", async () => {
		const test = await start("signal");
		try {
			const admission: PtyOwnerAdmission = await test.watcher.admit(hint);
			assert.deepEqual(admission, { kind: "admitted", pid: 701, creationTime: "134349421014308869" });
			await waitFor(() => test.signals.length === 1);
			assert.deepEqual(test.signals, [{ pid: 701, creationTime: "134349421014308869" }]);
			assert.deepEqual(test.losses, []);
		} finally {
			await test.watcher.stop();
		}
	});

	it("reports an unattestable hint as a refusal rather than a failure", async () => {
		const test = await start("unsupported");
		try {
			const admission = await test.watcher.admit(hint);
			assert.equal(admission.kind, "unsupported");
			assert.equal(admission.kind === "unsupported" ? admission.code : "", "PARENT_MISMATCH");
			assert.deepEqual(test.losses, [], "a refusal is not loss of the watch");
		} finally {
			await test.watcher.stop();
		}
	});

	it("treats an unusable admission as unusable, and keeps no half-admitted owner", async () => {
		const test = await start("unusable");
		try {
			const admission = await test.watcher.admit(hint);
			assert.equal(admission.kind, "unsupported");
			assert.equal(admission.kind === "unsupported" ? admission.code : "", "UNUSABLE_ANSWER");
			assert.deepEqual(test.signals, []);
		} finally {
			await test.watcher.stop();
		}
	});

	it("reads a helper that exits as loss of the watch, never as a signal", async () => {
		const test = await start("exit");
		try {
			const admission = await test.watcher.admit(hint);
			assert.equal(admission.kind, "admitted");
			await waitFor(() => test.losses.length === 1);
			assert.match(test.losses[0] ?? "", /exited with code 3/);
			assert.deepEqual(test.signals, [], "a helper's exit says nothing about the process it watched");
			assert.equal(test.watcher.alive, false);
			// Once the watch is gone, no admission can be made against it.
			assert.equal((await test.watcher.admit(hint)).kind, "unsupported");
		} finally {
			await test.watcher.stop();
		}
	});

	it("reads a failed wait as loss of the watch, never as a signal", async () => {
		// `WAIT_FAILED` is the opposite of an exit: the helper could not tell whether the
		// process is alive, so nothing may be stopped on that answer.
		const test = await start("wait-failed");
		try {
			const admission = await test.watcher.admit(hint);
			assert.equal(admission.kind, "admitted");
			await waitFor(() => test.losses.length === 1);
			assert.match(test.losses[0] ?? "", /could not wait on a watched process \(SIGNAL_WAIT_FAILED\)/);
			assert.deepEqual(test.signals, [], "a failed wait must never be read as a process ending");
			assert.equal(test.watcher.alive, false);
		} finally {
			await test.watcher.stop();
		}
	});

	it("reads a helper that never announces itself as unavailable in the bound", async () => {
		const test = await start("silent", { timeoutMs: 300 });
		try {
			const admission = await test.watcher.admit(hint);
			assert.equal(admission.kind, "unsupported");
			assert.equal(admission.kind === "unsupported" ? admission.code : "", "WATCH_LOST");
			assert.deepEqual(test.signals, []);
		} finally {
			await test.watcher.stop();
		}
	});

	it("reads a flood and an unknown line as loss of the watch", async () => {
		const flooded = await start("flood");
		try {
			await waitFor(() => flooded.losses.length === 1);
			assert.match(flooded.losses[0] ?? "", /flooded/);
			assert.deepEqual(flooded.signals, []);
		} finally {
			await flooded.watcher.stop();
		}
		const unknown = await start("unknown-line");
		try {
			await waitFor(() => unknown.losses.length === 1);
			assert.match(unknown.losses[0] ?? "", /unusable line/);
			assert.deepEqual(unknown.signals, []);
		} finally {
			await unknown.watcher.stop();
		}
	});

	it("refuses to run a helper whose bytes no longer match its digest", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "omp-owner-watch-"));
		roots.push(root);
		const script = path.join(root, "replaced-helper.js");
		await writeFile(script, "// replaced\n", "utf8");
		const started = await startPtyOwnerWatcher(
			{ onSignaledMain: () => undefined, onWatchLost: () => undefined },
			{ helper: { path: script, sha256: "f".repeat(64) }, brokerPid: process.pid },
		);
		assert.equal(started.watcher, null);
		assert.match(started.detail ?? "", /no longer holds the bytes/);
	});

	it("ends an asked-to-stop helper without reporting a loss", async () => {
		const test = await start("signal");
		await test.watcher.stop();
		await new Promise<void>(resolve => {
			const timer = setTimeout(resolve, 200);
			timer.unref();
		});
		assert.deepEqual(test.losses, [], "a helper this broker stopped is not a lost watch");
	});
});
