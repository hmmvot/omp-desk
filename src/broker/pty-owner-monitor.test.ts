/**
 * The folder-shell owner watch (ADR-0030), driven directly.
 *
 * Runner: `node --test src/broker/pty-owner-monitor.test.ts`
 *
 * What is defended here is the *policy*: which generations may authorize the one
 * automatic stop, what cancels it, and what is never allowed to happen.
 *
 * - an extension host that dies while its owning main is alive starts nothing, because
 *   only a retained main handle signaling counts;
 * - every admitted main must signal: a second live window (or a restarted extension
 *   host of the same instance) can never be mistaken for the death of the first;
 * - a same-main reattach deduplicates and cannot start grace;
 * - a positively attested adoption of a *different* main invalidates the previous
 *   epoch — before the grace fires it cancels it, after it has fired it starts a new
 *   era — while a reused process id is refused rather than adopted;
 * - an unattestable hint, a lost watch and a helper that would not start all disarm
 *   automatic stopping instead of guessing, and a lost watch is never read as an exit;
 * - a managed OMP host has no watch at all;
 * - the automatic stop is one attempt through the broker's ordinary stop, and its
 *   answer is reported as what it proved — an unproven tree stays unknown.
 *
 * The first half drives a scripted watch, so a decision can be isolated from
 * PowerShell. The second half runs the **real staged helper** against real node
 * processes in the real parent/child shape the helper looks for, which approximates an
 * installed VS Code topology without a desktop: the helper opens real handles, reads
 * real creation times, images and command lines, and the automatic stop is triggered
 * by killing the very process whose handle it retained.
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { PTY_OWNER_EXIT_REASON, PtyOwnerMonitor } from "./pty-owner-monitor.ts";
import {
	startPtyOwnerWatcher,
	type PtyOwnerAdmission,
	type PtyOwnerWatcher,
	type PtyOwnerWatcherLaunch,
	type PtyOwnerWatchEvents,
	type PtyOwnerWatchHelper,
} from "../host/pty-owner-watch.ts";
import type { PtyOwnerHint, PtyOwnerStopStatus, PtyStopResult } from "../host/pty-protocol.ts";

/** A creation time no two fixtures share, in the form the protocol accepts. */
function creationFor(pid: number): string {
	return `13434942101430${String(pid % 1_000_000).padStart(6, "0")}`;
}

function hintFor(mainPid: number, hostPid = mainPid + 1): PtyOwnerHint {
	return { extensionHostPid: hostPid, parentPid: mainPid, mainPid };
}

/** A watch whose every answer and event one test decides. */
class FakeWatch implements PtyOwnerWatcher {
	alive = true;
	readonly asked: PtyOwnerHint[] = [];
	readonly answers = new Map<number, PtyOwnerAdmission>();
	private events: PtyOwnerWatchEvents | null = null;

	bind(events: PtyOwnerWatchEvents): void {
		this.events = events;
	}

	async admit(hint: PtyOwnerHint): Promise<PtyOwnerAdmission> {
		this.asked.push(hint);
		return (
			this.answers.get(hint.mainPid) ?? { kind: "admitted", pid: hint.mainPid, creationTime: creationFor(hint.mainPid) }
		);
	}

	async stop(): Promise<void> {
		this.alive = false;
	}

	signal(pid: number): void {
		this.signalWith(pid, creationFor(pid));
	}

	/** A signal naming a specific generation, as the helper's `!SIGNAL` line does. */
	signalWith(pid: number, creationTime: string): void {
		this.events?.onSignaledMain(pid, creationTime);
	}

	lose(detail: string): void {
		this.alive = false;
		this.events?.onWatchLost(detail);
	}
}

interface Harness {
	readonly monitor: PtyOwnerMonitor;
	readonly watch: FakeWatch;
	/** Every automatic stop, in order, by the reason it was attributed to. */
	readonly stops: string[];
	readonly statuses: PtyOwnerStopStatus[];
	readonly launches: { count: number };
	readonly result: PtyStopResult;
}

function harness(options: { kind?: "folder-shell" | "managed-omp"; graceMs?: number; launchFailure?: string } = {}): Harness {
	const watch = new FakeWatch();
	const stops: string[] = [];
	const statuses: PtyOwnerStopStatus[] = [];
	const launches = { count: 0 };
	const result: PtyStopResult = {
		verified: false,
		mode: "graceful",
		nativePid: 4243,
		pidGone: true,
		tree: "unknown",
		treeEvidence: "parent-links-only",
		remainingPids: [],
		checkedPids: [],
		exitCode: 0,
		detail: "the root is gone; no kernel-enforced group proves the tree",
	};
	const monitor = new PtyOwnerMonitor({
		kind: options.kind ?? "folder-shell",
		brokerPid: 4242,
		helper: { path: "staged-owner-watch.ps1", sha256: "a".repeat(64) },
		graceMs: options.graceMs ?? 40,
		onStatusChanged: status => statuses.push(status),
		onAutoStop: async reason => {
			stops.push(reason);
			return result;
		},
		log: () => undefined,
		launchWatcher: async (events): Promise<PtyOwnerWatcherLaunch> => {
			launches.count += 1;
			if (options.launchFailure !== undefined) return { watcher: null, detail: options.launchFailure };
			watch.bind(events);
			return { watcher: watch, detail: null };
		},
	});
	return { monitor, watch, stops, statuses, launches, result };
}

/** Poll a synchronous predicate, so a test waits for the event rather than a duration. */
async function waitFor(check: () => boolean, timeoutMs = 4_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("the awaited condition did not hold in time");
		await delay(10);
	}
}

function delay(ms: number): Promise<void> {
	return new Promise<void>(resolve => {
		const timer = setTimeout(resolve, ms);
		timer.unref();
	});
}

/**
 * A window in which a stop *would* have happened had one been coming.
 *
 * "Nothing automatic happened" cannot be awaited as an event — it is the absence of
 * one — so this is the one place a real duration is the assertion. It is a multiple of
 * the grace the monitor was configured with, which is the only clock it uses.
 */
async function settle(graceMs = 40): Promise<void> {
	await delay(graceMs * 4 + 60);
}

describe("owner watch policy", () => {
	it("has no watch at all for a managed OMP host", async () => {
		const test = harness({ kind: "managed-omp" });
		const status = await test.monitor.admit(hintFor(7001));
		assert.equal(status.state, "not-applicable");
		assert.deepEqual(status.owners, []);
		assert.equal(test.launches.count, 0, "a managed host never starts the owner helper");
		await settle();
		assert.deepEqual(test.stops, []);
	});

	it("reports a shell with no attested owner as nothing automatic, and arms on attestation", async () => {
		const test = harness();
		assert.equal(test.monitor.status().state, "disarmed");
		assert.match(test.monitor.status().detail, /no owning VS Code main process/);
		const status = await test.monitor.admit(hintFor(7002));
		assert.equal(status.state, "armed");
		assert.deepEqual(
			status.owners.map(owner => [owner.pid, owner.signaled]),
			[[7002, false]],
		);
	});

	it("needs every admitted main to signal, so a killed extension host starts nothing", async () => {
		const test = harness();
		await test.monitor.admit(hintFor(7003));
		await test.monitor.admit(hintFor(7004));
		assert.equal(test.monitor.status().state, "armed");
		// Only a main process's retained handle signaling counts. A dead extension host is
		// not a signal, and neither is a still-live second window.
		test.watch.signal(7003);
		await settle();
		assert.deepEqual(test.stops, [], "one live admitted main must block the stop");
		const blocked = test.monitor.status();
		assert.equal(blocked.state, "armed");
		assert.deepEqual(
			blocked.owners.map(owner => [owner.pid, owner.signaled]),
			[
				[7003, true],
				[7004, false],
			],
		);
		// The last admitted main signaling is what starts the finite grace.
		test.watch.signal(7004);
		await waitFor(() => test.stops.length === 1);
		assert.deepEqual(test.stops, [PTY_OWNER_EXIT_REASON]);
		assert.equal(test.monitor.status().state, "stopped");
		// One attempt per era: nothing else fires afterwards.
		await settle();
		assert.equal(test.stops.length, 1);
	});

	it("deduplicates a restarted extension host of the same main, and cannot start grace", async () => {
		const test = harness();
		await test.monitor.admit(hintFor(7005, 8005));
		const again = await test.monitor.admit(hintFor(7005, 8006));
		assert.equal(again.state, "armed");
		assert.equal(again.owners.length, 1, "the same generation is one admitted main");
		assert.match(again.detail, /already the generation/);
		await settle();
		assert.deepEqual(test.stops, [], "a same-main reattach may not start grace");
	});

	it("admits a reused process id as its own generation, and attributes signals by generation", async () => {
		const test = harness({ graceMs: 300 });
		await test.monitor.admit(hintFor(7006));
		test.watch.answers.set(7006, { kind: "admitted", pid: 7006, creationTime: creationFor(9006) });
		const second = await test.monitor.admit(hintFor(7006));
		assert.equal(second.state, "armed");
		assert.deepEqual(
			second.owners.map(owner => [owner.creationTime, owner.signaled]),
			[
				[creationFor(7006), false],
				[creationFor(9006), false],
			],
			"an id that now names another process is a generation of its own",
		);
		// A signal naming the *old* creation time must not satisfy the new generation.
		test.watch.signalWith(7006, creationFor(7006));
		await waitFor(() => test.monitor.status().owners[0]?.signaled === true);
		assert.equal(test.monitor.status().owners[1]?.signaled, false);
		await settle(300);
		assert.deepEqual(test.stops, [], "a stale signal must never authorize a stop for the generation that reused the id");
		// The new generation's own exit is what clears the set.
		test.watch.signalWith(7006, creationFor(9006));
		await waitFor(() => test.stops.length === 1);
		assert.equal(test.monitor.status().state, "stopped");
	});

	it("cancels a grace armed by the earlier generation when a reused id is adopted", async () => {
		const test = harness({ graceMs: 400 });
		await test.monitor.admit(hintFor(7019));
		test.watch.signal(7019);
		await waitFor(() => test.monitor.status().state === "grace");
		test.watch.answers.set(7019, { kind: "admitted", pid: 7019, creationTime: creationFor(9019) });
		const adopted = await test.monitor.admit(hintFor(7019));
		assert.equal(adopted.state, "armed");
		assert.equal(adopted.graceRemainingMs, null);
		await settle(400);
		assert.deepEqual(test.stops, [], "a live generation that reused the id cancels the old era's grace");
	});

	it("cancels a pending grace when a different main is adopted before it fires", async () => {
		const test = harness({ graceMs: 400 });
		await test.monitor.admit(hintFor(7007));
		test.watch.signal(7007);
		await waitFor(() => test.monitor.status().state === "grace");
		const adopted = await test.monitor.admit(hintFor(7008));
		assert.equal(adopted.state, "armed");
		assert.equal(adopted.graceRemainingMs, null);
		assert.deepEqual(
			adopted.owners.map(owner => owner.pid),
			[7007, 7008],
			"an admitted generation is never dropped from the set",
		);
		await settle(400);
		assert.deepEqual(test.stops, [], "the adopted main's lifetime cancels the old grace");
		// The new generation is now part of the set, so clearing that era needs its signal.
		test.watch.signal(7008);
		await waitFor(() => test.stops.length === 1);
	});

	it("starts a new era when a different main is adopted after the stop was attempted", async () => {
		const test = harness();
		await test.monitor.admit(hintFor(7009));
		test.watch.signal(7009);
		await waitFor(() => test.stops.length === 1);
		assert.equal(test.monitor.status().state, "stopped");
		const adopted = await test.monitor.admit(hintFor(7010));
		assert.equal(adopted.state, "armed");
		test.watch.signal(7010);
		await waitFor(() => test.stops.length === 2);
		await settle();
		assert.equal(test.stops.length, 2, "each era gets exactly one attempt");
	});

	it("disarms on a hint it cannot attest instead of dropping or trusting it", async () => {
		const test = harness();
		await test.monitor.admit(hintFor(7011));
		test.watch.answers.set(7012, {
			kind: "unsupported",
			code: "PARENT_MISMATCH",
			detail: "the host's parent is not this process",
		});
		const refused = await test.monitor.admit(hintFor(7012));
		assert.equal(refused.state, "disarmed");
		// The helper's own reason is what a caller is shown, verbatim.
		assert.match(refused.detail, /the host's parent is not this process/);
		assert.match(refused.detail, /left running for an explicit Close/);
		test.watch.signal(7011);
		await settle();
		assert.deepEqual(test.stops, [], "an unattested owner set is never stopped automatically");
	});

	it("disarms when the watch is lost, and never reads that as an exit", async () => {
		const test = harness();
		await test.monitor.admit(hintFor(7013));
		await test.monitor.admit(hintFor(7014));
		test.watch.lose("the owner-watch helper exited with code 1");
		await waitFor(() => test.monitor.status().state === "disarmed");
		const status = test.monitor.status();
		assert.match(status.detail, /owner watch was lost/);
		assert.deepEqual(
			status.owners.map(owner => owner.signaled),
			[false, false],
			"a helper crash must not be recorded as an owner having exited",
		);
		await settle();
		assert.deepEqual(test.stops, []);
	});

	it("cancels a grace that is already running when the watch is lost", async () => {
		const test = harness({ graceMs: 400 });
		await test.monitor.admit(hintFor(7015));
		test.watch.signal(7015);
		await waitFor(() => test.monitor.status().state === "grace");
		test.watch.lose("the owner-watch helper flooded its answer stream");
		await waitFor(() => test.monitor.status().state === "disarmed");
		await settle(400);
		assert.deepEqual(test.stops, [], "an unobservable owner set is disarmed, not acted on");
	});

	it("disarms when no owner-watch helper could be started at all", async () => {
		const test = harness({ launchFailure: "the staged owner-watch helper no longer holds the bytes it was staged with" });
		const status = await test.monitor.admit(hintFor(7016));
		assert.equal(status.state, "disarmed");
		assert.match(status.detail, /no longer holds the bytes/);
		await settle();
		assert.deepEqual(test.stops, []);
	});

	it("drops a pending grace when the child exits on its own", async () => {
		const test = harness({ graceMs: 400 });
		await test.monitor.admit(hintFor(7017));
		test.watch.signal(7017);
		await waitFor(() => test.monitor.status().state === "grace");
		test.monitor.childHasExited();
		assert.equal(test.monitor.status().state, "armed");
		await settle(400);
		assert.deepEqual(test.stops, []);
	});

	it("disarms and cancels an armed grace when an authenticated attachment cannot attest an owner", async () => {
		// The race the rule exists for: an admitted main has already signaled, so a grace is
		// armed — and then a second live window that cannot attest itself attaches. The
		// grace must not overtake that window, because the shell may well still be in use.
		const test = harness({ graceMs: 400 });
		await test.monitor.admit(hintFor(7020));
		test.watch.signal(7020);
		await waitFor(() => test.monitor.status().state === "grace");
		const status = await test.monitor.admitUnattestable();
		assert.equal(status.state, "disarmed");
		assert.match(status.detail, /could not attest an owning VS Code main process/);
		assert.equal(status.graceRemainingMs, null);
		assert.deepEqual(
			status.owners.map(owner => [owner.pid, owner.signaled]),
			[[7020, true]],
			"what was observed before stays visible; it is simply no longer enough to act on",
		);
		await settle(400);
		assert.deepEqual(test.stops, []);
	});

	it("never applies an unattestable attachment to a managed host", async () => {
		const test = harness({ kind: "managed-omp" });
		const status = await test.monitor.admitUnattestable();
		assert.equal(status.state, "not-applicable");
		assert.equal(test.launches.count, 0);
		await settle();
		assert.deepEqual(test.stops, []);
	});

	it("keeps a disarmed shell disarmed when a later hint could be attested", async () => {
		const test = harness();
		assert.equal((await test.monitor.admitUnattestable()).state, "disarmed");
		const after = await test.monitor.admit(hintFor(7021));
		assert.equal(after.state, "disarmed", "disarming is fail-closed for this broker generation");
		assert.deepEqual(after.owners, []);
		await settle();
		assert.deepEqual(test.stops, []);
	});

	it("forgets a signaled generation to make room, and never a live one", async () => {
		const test = harness();
		for (let index = 0; index < 8; index += 1) {
			const pid = 7300 + index;
			await test.monitor.admit(hintFor(pid));
			test.watch.signal(pid);
			await waitFor(() => test.monitor.status().owners.some(owner => owner.pid === pid && owner.signaled));
		}
		assert.equal(test.monitor.status().owners.length, 8);
		const ninth = await test.monitor.admit(hintFor(7400));
		assert.equal(ninth.state, "armed");
		assert.equal(ninth.owners.length, 8, "the set stays bounded");
		assert.equal(
			ninth.owners.some(owner => owner.pid === 7400 && !owner.signaled),
			true,
			"the new live generation is admitted",
		);
	});

	it("reports the stop it made as what it proved, never as a verified tree", async () => {
		const test = harness();
		await test.monitor.admit(hintFor(7018));
		test.watch.signal(7018);
		await waitFor(() => test.stops.length === 1);
		const status = test.monitor.status();
		assert.equal(status.state, "stopped");
		assert.match(status.detail, /process gone/);
		assert.match(status.detail, /tree unknown \(parent-links-only\)/);
		assert.equal(test.result.verified, false, "an uncontained tree is never verified");
		assert.match(test.result.detail, /no kernel-enforced group/);
	});
});

const HELPER_PATH = fileURLToPath(new URL("../host/pty-owner-watch.ps1", import.meta.url));
const PACKAGED_HELPER_PATH = fileURLToPath(new URL("../../out/pty/pty-owner-watch.ps1", import.meta.url));

/**
 * A "main" process that starts an "extension host" child.
 *
 * Both are this runtime's own executable, so the helper's structural rule holds for a
 * real pair of processes: one image, the host's actual parent is the main, the main is
 * older, the host carries the extension-host role marker and the main carries no
 * `--type=` at all. The marker lives in a *file* the main runs rather than in its own
 * command line, because a main whose command line mentioned `--type=` would rightly be
 * refused as a child role — which is itself the property the helper exists to check.
 */
const MAIN_SCRIPT = [
	"const { spawn } = require('node:child_process');",
	"const child = spawn(process.execPath, ['-e', 'process.stdin.resume(); process.stdin.on(\"end\", () => process.exit(0)); setInterval(() => {}, 1000)', '--', '--type=extensionHost'], { stdio: ['pipe', 'ignore', 'ignore'] });",
	"process.stdout.write('HOST=' + child.pid + '\\n');",
	"setInterval(() => {}, 1000);",
].join("\n");

/** The same pair, without the role marker, so the host cannot be attested at all. */
const ROLELESS_MAIN_SCRIPT = MAIN_SCRIPT.replace("'--', '--type=extensionHost'", "");

/** Modern VS Code utilities share argv; only the host's own role pair distinguishes them. */
function utilityFixtureScript(
	args: string[],
	role: Record<string, string> = {},
): string {
	return [
		"const { spawn } = require('node:child_process');",
		"const env = { ...process.env };",
		"delete env.VSCODE_CRASH_REPORTER_PROCESS_TYPE; delete env.VSCODE_ESM_ENTRYPOINT;",
		`Object.assign(env, ${JSON.stringify(role)});`,
		`const child = spawn(process.execPath, ['-e', 'process.stdin.resume(); process.stdin.on("end", () => process.exit(0))', '--', ...${JSON.stringify(args)}], { env, stdio: ['pipe', 'ignore', 'ignore'] });`,
		"process.stdout.write('HOST=' + child.pid + '\\n');",
	].join("\n");
}

const UTILITY_ARGS = ["--type=utility", "--utility-sub-type=node.mojom.NodeService"];
const EXTENSION_HOST_ENV = {
	VSCODE_CRASH_REPORTER_PROCESS_TYPE: "extensionHost",
	VSCODE_ESM_ENTRYPOINT: "vs/workbench/api/node/extensionHostProcess",
};

const fixtures: ChildProcess[] = [];
let fixtureDirectory: string | null = null;

after(async () => {
	for (const child of fixtures) {
		try {
			child.kill();
		} catch {
			// Already gone.
		}
	}
	if (fixtureDirectory !== null) await rm(fixtureDirectory, { recursive: true, force: true });
});

/** Write one fixture program and start it, reading the pid it reports for its host. */
async function startFixture(script: string, name: string): Promise<{ main: ChildProcess; hostPid: number; mainPid: number }> {
	fixtureDirectory ??= await mkdtemp(path.join(tmpdir(), "omp-owner-watch-"));
	const file = path.join(fixtureDirectory, name);
	await writeFile(file, script, "utf8");
	const main = spawn(process.execPath, [file], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
	fixtures.push(main);
	assert.ok(typeof main.pid === "number", "the fixture main did not start");
	const hostPid = await new Promise<number>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("the fixture never reported its host child")), 10_000);
		timer.unref();
		main.stdout?.on("data", (chunk: Buffer) => {
			const match = /HOST=(\d+)/.exec(chunk.toString("utf8"));
			if (match !== null) {
				clearTimeout(timer);
				resolve(Number(match[1]));
			}
		});
	});
	return { main, hostPid, mainPid: main.pid as number };
}

/** The staged helper's own copy: the file is re-hashed before it is ever run. */
async function helperCopy(): Promise<PtyOwnerWatchHelper> {
	const bytes = await readFile(HELPER_PATH);
	return { path: HELPER_PATH, sha256: createHash("sha256").update(bytes).digest("hex") };
}

const windowsOnly = { skip: process.platform !== "win32" ? "the owner-watch helper is implemented for Windows only" : false };

describe("owner watch against real processes", windowsOnly, () => {
	it("admits modern default and debug hosts only with their independently read role pair", async () => {
		const started = await startPtyOwnerWatcher(
			{ onSignaledMain: () => undefined, onWatchLost: () => undefined },
			{ helper: await helperCopy(), brokerPid: process.pid, admitTimeoutMs: 20_000 },
		);
		assert.ok(started.watcher, started.detail ?? "the watch did not start");
		try {
			for (const [index, flags] of [
				["--dns-result-order=ipv4first", "--inspect-port=0"],
				["--inspect=127.0.0.1:9229"],
			].entries()) {
				const fixture = await startFixture(
					utilityFixtureScript([...UTILITY_ARGS, ...flags], EXTENSION_HOST_ENV),
					`modern-host-${index}.js`,
				);
				const admitted = await started.watcher.admit(hintFor(fixture.mainPid, fixture.hostPid));
				assert.equal(admitted.kind, "admitted", admitted.kind === "unsupported" ? admitted.detail : "");
				if (admitted.kind === "admitted") assert.equal(admitted.pid, fixture.mainPid);
				// A different parent hint, not this test broker (which has its own refusal).
				const wrongParent = await started.watcher.admit(hintFor(process.ppid, fixture.hostPid));
				assert.equal(wrongParent.kind, "unsupported");
				if (wrongParent.kind === "unsupported") assert.match(wrongParent.detail, /PARENT_MISMATCH/);
				fixture.main.kill();
			}
		} finally {
			await started.watcher.stop();
		}
	});

	it("refuses generic, conflicting and misleading utility roles without admitting a main", async () => {
		const started = await startPtyOwnerWatcher(
			{ onSignaledMain: () => assert.fail("no refused role may retain an owner handle"), onWatchLost: () => undefined },
			{ helper: await helperCopy(), brokerPid: process.pid, admitTimeoutMs: 20_000 },
		);
		assert.ok(started.watcher, started.detail ?? "the watch did not start");
		const cases: Array<{ args: string[]; env?: Record<string, string> }> = [
			{ args: UTILITY_ARGS },
			{ args: UTILITY_ARGS, env: { VSCODE_CRASH_REPORTER_PROCESS_TYPE: "extensionHost" } },
			{ args: UTILITY_ARGS, env: { VSCODE_ESM_ENTRYPOINT: EXTENSION_HOST_ENV.VSCODE_ESM_ENTRYPOINT } },
			...["shared-process", "ptyHost", "agentHost"].map(role => ({
				args: UTILITY_ARGS,
				env: { ...EXTENSION_HOST_ENV, VSCODE_CRASH_REPORTER_PROCESS_TYPE: role },
			})),
			{ args: UTILITY_ARGS, env: { ...EXTENSION_HOST_ENV, VSCODE_ESM_ENTRYPOINT: "vs/code/node/sharedProcess/sharedProcessMain" } },
			{ args: ["--type=renderer"], env: EXTENSION_HOST_ENV },
			{ args: ["--type=utility", "--utility-sub-type=network.mojom.NetworkService"], env: EXTENSION_HOST_ENV },
			{ args: [...UTILITY_ARGS, "--type=renderer"], env: EXTENSION_HOST_ENV },
			{ args: [...UTILITY_ARGS, "--utility-sub-type=node.mojom.NodeService"], env: EXTENSION_HOST_ENV },
			{ args: ["--type=extensionHost-extra"] },
			{ args: ["--label=--type=extensionHost"] },
			{ args: ["a quoted incidental --type=extensionHost string"] },
			{ args: ["--type=extensionHost", "--type=extensionHost"] },
		];
		try {
			for (const [index, test] of cases.entries()) {
				const fixture = await startFixture(utilityFixtureScript(test.args, test.env), `refused-role-${index}.js`);
				const outcome = await started.watcher.admit(hintFor(fixture.mainPid, fixture.hostPid));
				assert.equal(outcome.kind, "unsupported", `role case ${index}`);
				if (outcome.kind === "unsupported") assert.match(outcome.detail, /HOST_ROLE_NOT_EXTENSION_HOST/);
				fixture.main.kill();
			}
		} finally {
			await started.watcher.stop();
		}
	});

	it("attests a real parent/child pair, ignores the host's exit, and stops on the main's", async () => {
		const helper = await helperCopy();
		const fixture = await startFixture(MAIN_SCRIPT, "main-fixture.js");
		const stops: string[] = [];
		const monitor = new PtyOwnerMonitor({
			kind: "folder-shell",
			brokerPid: process.pid,
			helper,
			graceMs: 300,
			onStatusChanged: () => undefined,
			onAutoStop: async reason => {
				stops.push(reason);
				return {
					verified: false,
					mode: "graceful",
					nativePid: 1,
					pidGone: true,
					tree: "unknown",
					treeEvidence: "unavailable",
					remainingPids: [],
					checkedPids: [],
					exitCode: null,
					detail: "test stop",
				};
			},
			log: () => undefined,
		});
		try {
			const admitted = await monitor.admit(hintFor(fixture.mainPid, fixture.hostPid));
			assert.equal(admitted.state, "armed", admitted.detail);
			assert.deepEqual(
				admitted.owners.map(owner => owner.pid),
				[fixture.mainPid],
			);
			assert.match(admitted.owners[0]?.creationTime ?? "", /^[1-9][0-9]{9,19}$/);

			// The extension host dying is not the owning instance exiting: the retained
			// handle still belongs to a live process, so nothing may be stopped.
			assert.equal(process.kill(fixture.hostPid, "SIGKILL"), true);
			await settle(300);
			assert.deepEqual(stops, [], "the extension host's exit must not stop the shell");
			assert.equal(monitor.status().owners[0]?.signaled, false);

			// The main itself exiting is the event the whole design is about.
			assert.equal(fixture.main.kill(), true);
			await waitFor(() => stops.length === 1, 8_000);
			assert.deepEqual(stops, [PTY_OWNER_EXIT_REASON]);
			const status = monitor.status();
			assert.equal(status.state, "stopped");
			assert.equal(status.owners[0]?.signaled, true);
		} finally {
			await monitor.close();
		}
	});

	it("holds exactly one waiter per generation, whatever a repeated admission says", async () => {
		// The helper's own dedupe: a restarted extension host of the same instance admits
		// the same generation again, and that must not stack a second waiter — while the
		// answer must be the *fresh* reading, never a retained one that could belong to a
		// process id reused by a different process.
		const helper = await helperCopy();
		const fixture = await startFixture(MAIN_SCRIPT, "waiter-fixture.js");
		const signals: Array<{ pid: number; creationTime: string }> = [];
		const losses: string[] = [];
		const started = await startPtyOwnerWatcher(
			{
				onSignaledMain: (pid, creationTime) => signals.push({ pid, creationTime }),
				onWatchLost: detail => losses.push(detail),
			},
			{ helper, brokerPid: process.pid, admitTimeoutMs: 20_000 },
		);
		assert.ok(started.watcher, started.detail ?? "the watch did not start");
		const watcher = started.watcher;
		try {
			const hint = hintFor(fixture.mainPid, fixture.hostPid);
			const first = await watcher.admit(hint);
			const second = await watcher.admit(hint);
			assert.equal(first.kind, "admitted", first.kind === "unsupported" ? first.detail : "");
			assert.deepEqual(second, first, "the same generation answers with the same fresh reading");
			assert.equal(fixture.main.kill(), true);
			await waitFor(() => signals.length === 1, 8_000);
			await settle(200);
			assert.equal(signals.length, 1, "a repeated admission must not stack a second waiter");
			assert.deepEqual(losses, []);
		} finally {
			await watcher.stop();
		}
	});

	it("disarms for a topology it cannot attest, and for a hint that names this process", async () => {
		const helper = await helperCopy();
		const fixture = await startFixture(MAIN_SCRIPT, "main-fixture-2.js");
		const roleless = await startFixture(ROLELESS_MAIN_SCRIPT, "roleless-fixture.js");
		const monitor = new PtyOwnerMonitor({
			kind: "folder-shell",
			brokerPid: 4242,
			helper,
			graceMs: 200,
			onStatusChanged: () => undefined,
			onAutoStop: async () => {
				throw new Error("a disarmed watch must never attempt a stop");
			},
			log: () => undefined,
		});
		try {
			// The candidate main is not the extension host's real parent.
			const wrongParent = await monitor.admit(hintFor(process.pid, fixture.hostPid));
			assert.equal(wrongParent.state, "disarmed", wrongParent.detail);
			assert.match(wrongParent.detail, /PARENT_MISMATCH/);
			assert.equal(monitor.status().owners.length, 0);
		} finally {
			await monitor.close();
		}

		const second = new PtyOwnerMonitor({
			kind: "folder-shell",
			brokerPid: 4242,
			helper,
			graceMs: 200,
			onStatusChanged: () => undefined,
			onAutoStop: async () => {
				throw new Error("a disarmed watch must never attempt a stop");
			},
			log: () => undefined,
		});
		try {
			// A host whose command line is not an extension host's is refused by role.
			const notAnExtensionHost = await second.admit(hintFor(roleless.mainPid, roleless.hostPid));
			assert.equal(notAnExtensionHost.state, "disarmed", notAnExtensionHost.detail);
			assert.match(notAnExtensionHost.detail, /HOST_ROLE_NOT_EXTENSION_HOST/);
			// And a hint naming this very process as the main is refused before the helper
			// is even asked: a process cannot be the owner of itself.
			const selfOwned = await second.admit(hintFor(process.pid, process.pid));
			assert.equal(selfOwned.state, "disarmed");
		} finally {
			await second.close();
		}
	});
});

describe("owner-watch helper staging", () => {
	it("is the file the build copies beside the broker", async () => {
		const source = await readFile(HELPER_PATH, "utf8");
		assert.match(source, /--type=extensionHost/, "the helper attests the extension-host role");
		assert.match(source, /WaitForSingleObject/, "the helper waits on a retained handle");
		assert.match(source, /!SIGNAL/, "the helper reports a signaled owner as an event");
		if (existsSync(PACKAGED_HELPER_PATH)) {
			assert.equal(await readFile(PACKAGED_HELPER_PATH, "utf8"), source, "the packaged helper is the checked-in one");
		}
	});
});
