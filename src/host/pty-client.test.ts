/**
 * The PTY broker, end to end, through the client the extension host uses.
 *
 * Runner: `node --test src/host/pty-client.test.ts`
 *
 * This is the transport proof, with no mock in the path: the real staged runtime, the
 * real detached broker process, a real pseudo console and a real native child, driven by
 * `PtyBrokerClient` the way the extension host drives it. It covers the acceptance
 * path itself:
 *
 * - a broker starts, publishes its record, proves its own identity and runs a child
 *   that nobody is watching yet;
 * - output produced before a frontend existed is retained and replayed exactly, and
 *   the serialized screen matches the position the replay continues from;
 * - one frontend holds input, another is refused until it takes over explicitly;
 * - the same slot never gets a second writer: a second launch adopts the first, and a
 *   slot that already has a record keeps it; a recorded broker whose process is gone
 *   or cannot be established is reported, never replaced (ADR-0029);
 * - stopping reports what it proved: the native pid's absence is proven through its
 *   kernel creation time, while the descendant tree is named as observed, remaining or
 *   unknown because this provider has no kernel-enforced group (ADR-0029), and the slot
 *   keeps its recovery record either way;
 * - a folder shell whose owning VS Code instance was attested is stopped exactly once,
 *   after that instance's main process exits and after a finite grace, and never
 *   because an extension host went away, and never at all for a managed host or for a
 *   hint the broker's own helper could not attest (ADR-0030);
 * - the record's token is the only way in.
 *
 * The waits are events (an output frame, a state frame, a kernel reading), plus the
 * module's own bounded waits (`waitForPtyProcessGone`) where the thing awaited is a
 * process actually exiting. Nothing sleeps on a guessed duration.
 *
 * Skipped outside Windows (the identity readings are Windows-only) and when the
 * packaged broker tree has not been built (`node esbuild.mjs --pty`).
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import {
	PTY_PROTOCOL_VERSION,
	PTY_RECORD_VERSION,
	PTY_RUNTIME_VERSION,
	PTY_SERVICE,
	createPtyToken,
	type PtyBrokerRecord,
} from "./pty-protocol.ts";
import { PtyBrokerClient, type PtyHandle, type PtyHandleEvent } from "./pty-client.ts";
import { PtyRequestError } from "./broker-handle.ts";
import { connectPtyBroker } from "./pty-ipc.ts";
import { isPtyProcessAlive, queryPtyProcessTree, waitForPtyProcessGone, type PtyProbeHelper } from "./pty-identity.ts";
import { ptyRecordPath, readPtyRecord } from "./pty-registry.ts";

const EXTENSION_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** A child that announces itself, echoes what it is given, and stays alive. */
const MANAGED_SCRIPT = [
	"process.stdout.write('READY ' + process.pid + '\\r\\n');",
	"process.stdin.on('data', data => process.stdout.write('ECHO:' + JSON.stringify(data.toString()) + '\\r\\n'));",
	"setInterval(() => {}, 1000);",
].join(" ");

/** A shell that starts a descendant of its own and stays alive. */
const SHELL_SCRIPT = [
	"const { spawn } = require('node:child_process');",
	"const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });",
	"process.stdout.write('GRANDCHILD=' + child.pid + '\\r\\n');",
	"setInterval(() => {}, 1000);",
].join(" ");

const WINDOWS_ONLY = process.platform !== "win32" ? "the process identity readings are implemented for Windows only" : false;
const BUILT = existsSync(path.join(EXTENSION_ROOT, "out", "pty", "pty-broker.js"));
const SKIP = WINDOWS_ONLY || (BUILT ? false : "the packaged broker tree is absent: run `node esbuild.mjs --pty` first");

/** Strip escape sequences, so an assertion is about text rather than ConPTY's cursor moves. */
function plain(text: string): string {
	// eslint-disable-next-line no-control-regex -- terminal escapes are what is being removed
	return text.replace(/\u001b\][^\u0007]*\u0007|\u001b\[[0-9;?]*[A-Za-z]|\u001b[()][A-Za-z0-9]/g, "");
}

/** Output seen so far, with promises that resolve as soon as a condition holds. */
interface PtyWatcher {
	readonly text: () => string;
	readonly inputOwner: () => string | null;
	readonly whenText: (match: (value: string) => boolean) => Promise<string>;
	readonly whenEvent: (match: (event: PtyHandleEvent) => boolean) => Promise<PtyHandleEvent>;
	readonly stop: () => void;
}

/** Collect what a handle pushes, so a test waits for the signal rather than a duration. */
function watch(handle: PtyHandle): PtyWatcher {
	let collected = "";
	let owner: string | null = null;
	const textWaiters: Array<{ match: (value: string) => boolean; resolve: (value: string) => void }> = [];
	const eventWaiters: Array<{ match: (event: PtyHandleEvent) => boolean; resolve: (event: PtyHandleEvent) => void }> = [];
	const stop = handle.subscribe(event => {
		if (event.type === "output") {
			collected += event.data;
			const value = plain(collected);
			const index = textWaiters.findIndex(waiter => waiter.match(value));
			if (index >= 0) {
				const waiter = textWaiters.splice(index, 1)[0];
				waiter?.resolve(value);
			}
		}
		if (event.type === "input-owner") owner = event.frontendId;
		const eventIndex = eventWaiters.findIndex(waiter => waiter.match(event));
		if (eventIndex >= 0) {
			const waiter = eventWaiters.splice(eventIndex, 1)[0];
			waiter?.resolve(event);
		}
	});
	return {
		text: () => plain(collected),
		inputOwner: () => owner,
		whenText: match => {
			const current = plain(collected);
			if (match(current)) return Promise.resolve(current);
			return new Promise<string>(resolve => textWaiters.push({ match, resolve }));
		},
		whenEvent: match => new Promise<PtyHandleEvent>(resolve => eventWaiters.push({ match, resolve })),
		stop,
	};
}

/** A broker refusal with a stable code, which is what a caller branches on. */
function refusesWith(code: string): (error: unknown) => boolean {
	return error => {
		assert.ok(error instanceof PtyRequestError, `expected a broker refusal, got ${String(error)}`);
		assert.equal(error.code, code);
		return true;
	};
}

const opened: PtyHandle[] = [];
let storage: string;
let client: PtyBrokerClient;
let helper: PtyProbeHelper;

/**
 * A "main" process that starts an "extension-host-role" child, both this runtime's own
 * executable: the real parent/child shape the broker's private owner helper attests.
 * The role marker lives in a file the main runs, so the main's own command line carries
 * no `--type=` (a main that did would rightly be refused as a child role).
 */
const OWNER_MAIN_SCRIPT = [
	"const { spawn } = require('node:child_process');",
	"const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', '--type=extensionHost'], { stdio: 'ignore' });",
	"process.stdout.write('HOST=' + child.pid + '\\n');",
	"setInterval(() => {}, 1000);",
].join("\n");

const ownerFixtures: ChildProcess[] = [];
let ownerFixtureDir: string | null = null;

function delayMs(ms: number): Promise<void> {
	return new Promise<void>(resolve => {
		const timer = setTimeout(resolve, ms);
		timer.unref();
	});
}

/** Start one owner fixture and read the pid it reports for its "extension host". */
async function startOwnerFixture(name: string): Promise<{ main: ChildProcess; hostPid: number; mainPid: number }> {
	ownerFixtureDir ??= await mkdtemp(path.join(tmpdir(), "omp-pty-owner-"));
	const file = path.join(ownerFixtureDir, name);
	await writeFile(file, OWNER_MAIN_SCRIPT, "utf8");
	const main = spawn(process.execPath, [file], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
	ownerFixtures.push(main);
	assert.ok(typeof main.pid === "number", "the owner fixture main did not start");
	const hostPid = await new Promise<number>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("the owner fixture never reported its host child")), 10_000);
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

/**
 * Wait for the broker's own status to satisfy a condition, or fail within the bound.
 *
 * The broker reports an exit a moment after the process exits (the pseudo console's
 * exit event arrives when the operating system reports it), so a condition about what
 * the broker observed is awaited rather than read once.
 */
async function waitForStatus(
	handle: PtyHandle,
	match: (status: { readonly state: string; readonly ownerStop: { readonly state: string } }) => boolean,
	timeoutMs = 15_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const status = handle.statusValue;
		if (status !== null && match(status)) return;
		if (Date.now() > deadline) {
			throw new Error(`the broker never reported the expected status (last: ${String(status?.state)}/${String(status?.ownerStop.state)})`);
		}
		await handle.refreshStatus().catch(() => undefined);
		await delayMs(100);
	}
}

before(async () => {
	// The record directory must satisfy the real access convention, so the storage tree
	// lives in this account's profile rather than in the shared temporary directory.
	storage = await mkdtemp(path.join(homedir(), ".omp-pty-e2e-"));
	client = new PtyBrokerClient({ storageDir: storage, extensionRoot: EXTENSION_ROOT });
});

after(async () => {
	for (const child of ownerFixtures) {
		try {
			child.kill();
		} catch {
			// Already gone.
		}
	}
	if (ownerFixtureDir !== null) await rm(ownerFixtureDir, { recursive: true, force: true });
	for (const handle of opened) {
		try {
			await handle.stop({ mode: "force", timeoutMs: 10_000 });
			await handle.shutdown({ requireStopped: false });
		} catch {
			handle.disconnect();
		}
	}
	// A broker is started with the staged tree as its working directory, so a Windows
	// removal can still see the tree busy for a moment after the process exits.
	await rm(storage, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

let counter = 0;
function nextSlot(): string {
	counter += 1;
	return `tab:e2e-${counter}`;
}

/** Launch a managed-style child and keep the handle for cleanup. */
async function launchChild(slot: string, script = MANAGED_SCRIPT): Promise<{ handle: PtyHandle; watch: PtyWatcher }> {
	const outcome = await client.launch({
		slot,
		kind: "managed-omp",
		file: process.execPath,
		args: ["-e", script],
		cwd: tmpdir(),
		cols: 100,
		rows: 30,
		title: `e2e ${slot}`,
	});
	assert.equal(outcome.state, "running", outcome.reason);
	assert.ok(outcome.handle);
	opened.push(outcome.handle);
	return { handle: outcome.handle, watch: watch(outcome.handle) };
}

describe("broker end to end", { skip: SKIP }, () => {
	before(async () => {
		const readiness = await client.ready();
		assert.equal(readiness.ready, true, readiness.reason ?? "not ready");
		assert.ok(readiness.runtime);
		helper = readiness.runtime.helper;
	});

	it("runs a terminal nobody is watching, and records the child's own identity", async () => {
		const slot = nextSlot();
		const { handle, watch: seen } = await launchChild(slot);
		await handle.attach({ since: 0 });
		const text = await seen.whenText(value => value.includes("READY"));
		assert.match(text, /READY \d+/);
		const status = await handle.refreshStatus();
		assert.equal(status.state, "running");
		assert.ok(status.nativePid > 0);
		assert.notEqual(status.nativePid, handle.brokerPid);
		assert.match(status.nativeCreationTime ?? "", /^[1-9][0-9]{9,19}$/);
		assert.equal(handle.record.kind, "managed-omp");
		assert.equal(handle.record.brokerPid, handle.brokerPid);
		assert.equal(handle.buildMatches, true);
		assert.equal(status.oldestPosition, 0);
		assert.ok(status.outputPosition > 0);
		// A managed OMP host is outside the owner watch entirely: nothing about a window
		// closing may ever stop it (ADR-0030).
		assert.equal(status.ownerStop.state, "not-applicable");
		assert.deepEqual(status.ownerStop.owners, []);
	});

	it("retains output produced while no frontend was attached, exactly", async () => {
		const slot = nextSlot();
		const { handle, watch: seen } = await launchChild(slot);
		await handle.attach({ since: 0 });
		await seen.whenText(value => value.includes("READY"));
		const position = (await handle.refreshStatus()).outputPosition;
		// Detach: the broker keeps the child and everything it produced.
		handle.disconnect();
		seen.stop();

		// A second client, as a reloaded window would be, replays from the beginning of
		// the retained stream.
		const reloaded = new PtyBrokerClient({ storageDir: storage, extensionRoot: EXTENSION_ROOT });
		const reconnected = await reloaded.attach(slot);
		assert.equal(reconnected.state, "attached", reconnected.reason);
		const second = reconnected.handle;
		assert.ok(second);
		opened.push(second);
		assert.equal(second.brokerPid, handle.brokerPid);
		const replay = watch(second);
		const attached = await second.attach({ since: 0 });
		assert.equal(attached.truncated, false);
		const text = await replay.whenText(value => value.includes("READY"));
		assert.match(text, /READY \d+/);
		assert.equal(attached.status.outputPosition >= position, true);
		// The screen the broker serializes is the same terminal, at the position the
		// replay continues from.
		const snapshot = await second.snapshot();
		assert.match(plain(snapshot.data), /READY/);
		assert.equal(snapshot.meta.position, (await second.refreshStatus()).outputPosition);
		assert.equal(snapshot.meta.cols, 100);
	});

	it("gives input to one frontend, and hands it over only when asked", async () => {
		const slot = nextSlot();
		const { handle, watch: seen } = await launchChild(slot);
		await handle.attach({ since: 0 });
		await seen.whenText(value => value.includes("READY"));

		const first = await handle.claimInput("frontend-a");
		assert.equal(first.frontendId, "frontend-a");
		assert.equal((await handle.refreshStatus()).inputOwner, "frontend-a");

		await handle.write("hello-a\r", "frontend-a");
		// The pseudo console echoes keystrokes back before the child answers, so the
		// signal is the child's own echo line rather than the text arriving at all.
		assert.match(await seen.whenText(value => value.includes("ECHO") && value.includes("hello-a")), /hello-a/);

		// A second frontend cannot type, resize, or take over by accident.
		await assert.rejects(handle.write("nope\r", "frontend-b"), refusesWith("input-not-owner"));
		await assert.rejects(handle.resize(120, 40, "frontend-b"), refusesWith("input-not-owner"));
		await assert.rejects(handle.claimInput("frontend-b"), refusesWith("input-not-owner"));

		// Taking over is explicit, and the previous owner is told.
		const handedOver = handle.claimInput("frontend-b", { takeover: true });
		const announced = await seen.whenEvent(event => event.type === "input-owner" && event.frontendId === "frontend-b");
		assert.equal((await handedOver).previous, "frontend-a");
		assert.equal(announced.type === "input-owner" ? announced.previous : "", "frontend-a");
		await assert.rejects(handle.write("still-a\r", "frontend-a"), refusesWith("input-not-owner"));
		await handle.write("hello-b\r", "frontend-b");
		assert.match(await seen.whenText(value => value.includes("ECHO") && value.includes("hello-b")), /hello-b/);

		// Only the owner may resize, and the size is real.
		await handle.resize(120, 40, "frontend-b");
		const status = await handle.refreshStatus();
		assert.deepEqual([status.cols, status.rows], [120, 40]);
		await handle.releaseInput("frontend-b");
		assert.equal((await handle.refreshStatus()).inputOwner, null);
	});

	it("never starts a second writer for one slot", async () => {
		const slot = nextSlot();
		const { handle } = await launchChild(slot);
		const second = await client.launch({
			slot,
			kind: "managed-omp",
			file: process.execPath,
			args: ["-e", MANAGED_SCRIPT],
			cwd: tmpdir(),
		});
		assert.equal(second.state, "running", second.reason);
		assert.equal(second.adopted, true);
		assert.equal(second.brokerPid, handle.brokerPid);
		assert.ok(second.handle);
		opened.push(second.handle);
		assert.equal(second.handle.record.generation, handle.record.generation);
		assert.equal(second.handle.nativePid, handle.nativePid);
	});

	it("detects a broker that runs another build's runtime and adopts it without replacing or stopping it", async () => {
		const slot = nextSlot();
		const { handle } = await launchChild(slot);
		assert.equal(handle.buildMatches, true, "the broker this build started runs this build's tree");
		// A later build: the same packaged tree plus one changed byte, so its digest differs.
		const later = await mkdtemp(path.join(homedir(), ".omp-pty-build-"));
		try {
			await cp(path.join(EXTENSION_ROOT, "out", "pty"), path.join(later, "out", "pty"), { recursive: true });
			const entry = path.join(later, "out", "pty", "pty-broker.js");
			await writeFile(entry, `${await readFile(entry, "utf8")}\n// a later build\n`);
			const upgraded = new PtyBrokerClient({ storageDir: storage, extensionRoot: later });
			const adopted = await upgraded.attach(slot);
			assert.equal(adopted.state, "attached", adopted.reason);
			assert.ok(adopted.handle);
			opened.push(adopted.handle);
			assert.equal(adopted.handle.buildMatches, false, "the surviving broker is recognised as an older build");
			assert.match(adopted.reason, /another build/);
			// Nothing about the mismatch touches the running session: same broker, same child, still running.
			assert.equal(adopted.handle.brokerPid, handle.brokerPid);
			assert.equal(adopted.handle.nativePid, handle.nativePid);
			assert.equal((await adopted.handle.refreshStatus()).state, "running");
		} finally {
			await rm(later, { recursive: true, force: true });
		}
	});

	it("retains a record whose broker is gone, and reports one it cannot establish", async () => {
		const slot = nextSlot();
		const { handle } = await launchChild(slot);
		const gone = handle.brokerPid;
		const creation = handle.record.brokerCreationTime;
		assert.ok(creation !== null);
		process.kill(gone);
		const absence = await waitForPtyProcessGone(helper, gone, creation, 20_000);
		assert.equal(absence.gone, true, absence.detail);
		handle.disconnect();

		const refusedReplacement = await client.launch({
			slot,
			kind: "managed-omp",
			file: process.execPath,
			args: ["-e", MANAGED_SCRIPT],
			cwd: tmpdir(),
			title: `e2e ${slot} again`,
		});
		// The broker is gone, but nothing proved its child's tree gone: the record stays as
		// recovery metadata and no second writer may start in the slot.
		assert.equal(refusedReplacement.state, "slot-occupied", refusedReplacement.reason);
		assert.equal(refusedReplacement.adopted, false);
		assert.equal(refusedReplacement.brokerPid, gone);
		const retained = await readPtyRecord(storage, slot);
		assert.equal(retained.kind, "ok");
		assert.equal(retained.kind === "ok" ? retained.record.brokerId : "", handle.record.brokerId);

		// A record that names a live process which is not a broker: reported, never
		// replaced, because writing over it would start a second writer in that slot.
		const stubborn = nextSlot();
		const holder = await launchChild(nextSlot());
		const bogusPath = ptyRecordPath(storage, stubborn);
		const bogus: PtyBrokerRecord = {
			version: PTY_RECORD_VERSION,
			service: PTY_SERVICE,
			protocolVersion: PTY_PROTOCOL_VERSION,
			runtimeVersion: PTY_RUNTIME_VERSION,
			treeDigest: holder.handle.record.treeDigest,
			brokerId: "pty-99999999-2222-3333-4444-555555555555",
			generation: "gen-99999999-2222-3333-4444-555555555555",
			slot: stubborn,
			kind: "managed-omp",
			port: 1,
			token: createPtyToken(),
			brokerPid: holder.handle.brokerPid,
			brokerCreationTime: holder.handle.record.brokerCreationTime,
			startedAt: new Date().toISOString(),
			cols: 80,
			rows: 24,
			title: null,
		};
		await writeFile(bogusPath, `${JSON.stringify(bogus)}\n`, { encoding: "utf8" });
		const refused = await client.launch({
			slot: stubborn,
			kind: "managed-omp",
			file: process.execPath,
			args: ["-e", MANAGED_SCRIPT],
			cwd: tmpdir(),
		});
		assert.equal(refused.state, "slot-occupied");
		assert.equal(refused.brokerPid, holder.handle.brokerPid);
		const untouched = await readPtyRecord(storage, stubborn);
		assert.equal(untouched.kind === "ok" ? untouched.record.brokerId : "", bogus.brokerId);
	});

	it("stops a folder shell's entire process tree, and says what it proved", async () => {
		const slot = nextSlot();
		const outcome = await client.launchFolderShell({
			slot,
			cwd: tmpdir(),
			shellPath: process.execPath,
			shellArgs: ["-e", SHELL_SCRIPT],
			cols: 100,
			rows: 30,
		});
		assert.equal(outcome.state, "running", outcome.reason);
		const handle = outcome.handle;
		assert.ok(handle);
		opened.push(handle);
		assert.equal(handle.kind, "folder-shell");
		const seen = watch(handle);
		await handle.attach({ since: 0 });
		const text = await seen.whenText(value => value.includes("GRANDCHILD="));
		const grandchild = Number.parseInt(/GRANDCHILD=(\d+)/.exec(text)?.[1] ?? "0", 10);
		assert.ok(grandchild > 0, text);
		const nativePid = (await handle.refreshStatus()).nativePid;
		assert.ok(nativePid !== null);
		const tree = await queryPtyProcessTree(helper, nativePid as number);
		assert.equal(tree.kind, "found");
		assert.equal(tree.kind === "found" ? tree.pids.includes(grandchild) : false, true);

		const stopped = await handle.stop({ timeoutMs: 30_000 });
		// The writer (the shell itself) is proven gone; the tree beyond it is not provable
		// with this provider, so `verified` stays false and the evidence is named.
		assert.equal(stopped.pidGone, true, stopped.detail);
		assert.equal(stopped.verified, false, stopped.detail);
		assert.equal(stopped.treeEvidence, "parent-links-only");
		// The root's exit is asserted through `pidGone`, the broker's identity-safe
		// reading, not by asking the kernel about a bare process id: a numeric id alone is
		// not evidence, because a reused id reads as alive.
		assert.equal(isPtyProcessAlive(grandchild), false, "the shell's descendant outlived the stop");
		// The broker keeps its record and stays reachable: the slot must remain recoverable
		// while the tree is unproven.
		assert.equal((await readPtyRecord(storage, slot)).kind, "ok");
	});

	it("reports a descendant that outlived the shell instead of claiming the tree stopped", async () => {
		const slot = nextSlot();
		// A shell that starts a descendant with its own console: closing this shell's
		// pseudo console does not terminate that process, and the stop verdict must say so
		// rather than reporting an empty tree.
		const script = [
			"const { spawn } = require('node:child_process');",
			"const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true });",
			"process.stdout.write('SURVIVOR=' + child.pid + '\\r\\n');",
			"setInterval(() => {}, 1000);",
		].join(" ");
		const outcome = await client.launchFolderShell({
			slot,
			cwd: tmpdir(),
			shellPath: process.execPath,
			shellArgs: ["-e", script],
		});
		assert.equal(outcome.state, "running", outcome.reason);
		const handle = outcome.handle;
		assert.ok(handle);
		opened.push(handle);
		const seen = watch(handle);
		await handle.attach({ since: 0 });
		const text = await seen.whenText(value => value.includes("SURVIVOR="));
		const survivor = Number.parseInt(/SURVIVOR=(\d+)/.exec(text)?.[1] ?? "0", 10);
		assert.ok(survivor > 0, text);
		try {
			const stopped = await handle.stop({ timeoutMs: 30_000 });
			assert.equal(stopped.pidGone, true, stopped.detail);
			assert.equal(stopped.verified, false, stopped.detail);
			assert.equal(stopped.tree, "remaining", stopped.detail);
			assert.equal(stopped.remainingPids.includes(survivor), true, stopped.detail);
			assert.equal(isPtyProcessAlive(survivor), true, "the detached descendant was reported gone");
			// The slot stays recoverable while the tree is unproven.
			assert.equal((await readPtyRecord(storage, slot)).kind, "ok");
		} finally {
			try {
				process.kill(survivor);
			} catch {
				// already gone
			}
		}
	});

	it("never signals a process id it cannot verify, and says what it did instead", async () => {
		const slot = nextSlot();
		const { handle } = await launchChild(slot);
		const stopped = await handle.stop({ mode: "force", timeoutMs: 20_000 });
		// A force stop escalates inside the handles this broker holds. No numeric process
		// id is signalled, and the verdict says only what was read.
		assert.equal(stopped.pidGone, true, stopped.detail);
		assert.equal(stopped.verified, false, stopped.detail);
		assert.equal(stopped.tree, "unknown", stopped.detail);
		assert.equal(stopped.treeEvidence, "parent-links-only");
		// The broker logs beside its record, under the record's own name minus its suffix.
		const recordName = path.basename(client.recordPath(slot));
		const logName = recordName.endsWith(".json") ? recordName.slice(0, -".json".length) : recordName;
		const logText = await readFile(path.join(client.stateDirectory(), "logs", `${logName}.log`), "utf8");
		assert.match(logText, /no process id is signalled/);
	});

	it("stops a folder shell once, after the verified owning VS Code instance itself exits", async () => {
		// The owner watch is the only automatic stop. It is exercised here with real
		// processes in the shape the broker's private helper looks for: a main process that
		// started an extension-host-role child, so the helper attests a parent, a creation
		// order, images, roles and an image identity from the kernel rather than from the
		// hint.
		const slot = nextSlot();
		const fixture = await startOwnerFixture("owner-e2e-main.js");
		try {
			const spec = await client.shellSpec({
				slot,
				cwd: tmpdir(),
				shellPath: process.execPath,
				shellArgs: ["-e", SHELL_SCRIPT],
				owner: { extensionHostPid: fixture.hostPid, parentPid: fixture.mainPid, mainPid: fixture.mainPid },
			});
			// A short finite grace, so the test observes the real sequence rather than a
			// minute of it; the broker clamps it into its own finite range.
			const outcome = await client.launch({ ...spec, ownerGraceMs: 1_100 });
			assert.equal(outcome.state, "running", outcome.reason);
			const handle = outcome.handle;
			assert.ok(handle);
			opened.push(handle);
			const seen = watch(handle);
			await handle.attach({ since: 0 });
			await seen.whenText(value => value.includes("GRANDCHILD="));
			const shellPid = (await handle.refreshStatus()).nativePid;
			assert.ok(shellPid !== null && shellPid > 0);

			// The admission is answered before `launch` resolves, so the handle already
			// carries what the broker attested.
			const armed = handle.statusValue?.ownerStop;
			assert.equal(armed?.state, "armed", armed?.detail);
			assert.deepEqual(
				(armed?.owners ?? []).map(owner => owner.pid),
				[fixture.mainPid],
			);

			// The extension host going away is NOT the owning instance going away: no
			// window's main process has ended, so nothing may be stopped.
			assert.equal(process.kill(fixture.hostPid, "SIGKILL"), true);
			await waitForStatus(handle, status => status.ownerStop.state === "armed");
			await delayMs(2_500);
			assert.equal(isPtyProcessAlive(shellPid), true, "the shell was stopped by its extension host closing");
			assert.equal(handle.statusValue?.ownerStop.state, "armed");
			assert.equal(handle.statusValue?.ownerStop.owners[0]?.signaled, false);

			// The owning main process ending is what authorizes the stop attempt.
			assert.equal(fixture.main.kill(), true);
			await waitForStatus(handle, status => status.ownerStop.state === "stopped");
			assert.equal(handle.statusValue?.ownerStop.owners[0]?.signaled, true);
			assert.equal(isPtyProcessAlive(shellPid), false, "the owning instance exited and the shell survived");
			// The attempt is the broker's ordinary identity-safe stop, so it claims exactly
			// what it proved and keeps the slot recoverable (ADR-0029).
			assert.match(handle.statusValue?.ownerStop.detail ?? "", /tree unknown/);
			assert.equal((await readPtyRecord(storage, slot)).kind, "ok");
			const logName = path.basename(client.recordPath(slot)).replace(/\.json$/, "");
			assert.match(await readFile(path.join(client.stateDirectory(), "logs", `${logName}.log`), "utf8"), /owner stop attempt/);
		} finally {
			try {
				fixture.main.kill();
			} catch {
				// Already gone.
			}
		}
	});

	it("stops an orphaned folder shell with no frontend attached at all", async () => {
		// The case the watch exists for: the window is gone, so nobody is attached, and
		// the broker must still act on the owning instance's exit, because the watch lives
		// in the broker, not in a frontend (ADR-0030).
		const slot = nextSlot();
		const fixture = await startOwnerFixture("owner-orphan-main.js");
		try {
			const spec = await client.shellSpec({
				slot,
				cwd: tmpdir(),
				shellPath: process.execPath,
				shellArgs: ["-e", SHELL_SCRIPT],
				owner: { extensionHostPid: fixture.hostPid, parentPid: fixture.mainPid, mainPid: fixture.mainPid },
			});
			const outcome = await client.launch({ ...spec, ownerGraceMs: 1_100 });
			assert.equal(outcome.state, "running", outcome.reason);
			const handle = outcome.handle;
			assert.ok(handle);
			opened.push(handle);
			const status = await handle.refreshStatus();
			assert.equal(status.ownerStop.state, "armed", status.ownerStop.detail);
			const shellPid = status.nativePid;
			const shellCreation = status.nativeCreationTime;
			assert.ok(shellPid > 0 && shellCreation !== null);
			handle.disconnect();
			assert.equal(handle.closed, true);

			assert.equal(fixture.main.kill(), true);
			const gone = await waitForPtyProcessGone(helper, shellPid, shellCreation, 30_000);
			assert.equal(gone.gone, true, `the orphaned shell survived its owning instance: ${gone.detail}`);

			// The broker is still there, with its recovery record and the verdict it reached.
			const reattached = await client.attach(slot);
			assert.equal(reattached.state, "attached", reattached.reason);
			assert.ok(reattached.handle);
			opened.push(reattached.handle);
			await waitForStatus(reattached.handle, status => status.state === "exited" && status.ownerStop.state === "stopped");
			const after = reattached.handle.statusValue;
			assert.equal(after?.ownerStop.owners[0]?.signaled, true);
			assert.match(after?.ownerStop.detail ?? "", /tree unknown/);
			assert.equal((await readPtyRecord(storage, slot)).kind, "ok");
		} finally {
			try {
				fixture.main.kill();
			} catch {
				// Already gone.
			}
		}
	});

	it("disarms a shell when a second authenticated window cannot attest its owner, and never stops it", async () => {
		// The race: window A attests and arms the shell, then a second live window
		// attaches and states that it cannot attest an owner of its own. If A's main then
		// exits, the armed grace must NOT stop a shell that second window is using: an
		// authenticated attachment whose main cannot be attested disarms (ADR-0030).
		const slot = nextSlot();
		const fixture = await startOwnerFixture("owner-second-window-main.js");
		try {
			const spec = await client.shellSpec({
				slot,
				cwd: tmpdir(),
				shellPath: process.execPath,
				shellArgs: ["-e", MANAGED_SCRIPT],
				owner: { extensionHostPid: fixture.hostPid, parentPid: fixture.mainPid, mainPid: fixture.mainPid },
			});
			const outcome = await client.launch({ ...spec, ownerGraceMs: 1_100 });
			assert.equal(outcome.state, "running", outcome.reason);
			const handle = outcome.handle;
			assert.ok(handle);
			opened.push(handle);
			const seen = watch(handle);
			await handle.attach({ since: 0 });
			await seen.whenText(value => value.includes("READY"));
			const shellPid = (await handle.refreshStatus()).nativePid;
			assert.ok(shellPid !== null && shellPid > 0);
			assert.equal(handle.statusValue?.ownerStop.state, "armed", handle.statusValue?.ownerStop.detail);

			// An attach that makes no ownership claim is a read-only observation: it must
			// neither admit nor disarm anything.
			const observer = await client.attach(slot);
			assert.equal(observer.state, "attached", observer.reason);
			assert.equal(observer.handle?.statusValue?.ownerStop.state, "armed", "an observation changed the watch");
			observer.handle?.disconnect();

			// Window B: authenticated, and it cannot attest an owning main process.
			const second = await client.attach(slot, { owner: null });
			assert.equal(second.state, "attached", second.reason);
			const secondHandle = second.handle;
			assert.ok(secondHandle);
			opened.push(secondHandle);
			const disarmed = secondHandle.statusValue?.ownerStop;
			assert.equal(disarmed?.state, "disarmed", disarmed?.detail);
			assert.match(disarmed?.detail ?? "", /could not attest an owning VS Code main process/);
			assert.equal(handle.statusValue?.ownerStop.state, "disarmed", "the first window must see the same verdict");

			// A's main exits. The grace that would have stopped this shell must not fire.
			assert.equal(fixture.main.kill(), true);
			await delayMs(3_500);
			assert.equal(isPtyProcessAlive(shellPid), true, "a shell a live unattested window is using was stopped");
			assert.equal(secondHandle.statusValue?.ownerStop.state, "disarmed");

			// The terminal is still the user's: input still reaches the child, which answers
			// with its own echo line (the console echoes keystrokes first, so the signal is
			// the child's line, exactly as the input-ownership test waits for it).
			const secondSeen = watch(secondHandle);
			await secondHandle.attach({ since: 0 });
			await secondHandle.claimInput("second-window", { takeover: true });
			await secondHandle.write("PING\r", "second-window");
			const echoed = await secondSeen.whenText(value => value.includes("ECHO") && value.includes("PING"));
			assert.match(echoed, /PING/);
			// And the slot keeps its record: nothing was retired on a disarmed shell.
			assert.equal((await readPtyRecord(storage, slot)).kind, "ok");
		} finally {
			try {
				fixture.main.kill();
			} catch {
				// Already gone.
			}
		}
	});

	it("disarms automatic stopping for a hint it cannot verify, and leaves the shell alone", async () => {
		const slot = nextSlot();
		// A hint that names this test process as the extension host and its parent: the
		// helper refuses it, and the refusal must leave the shell running with the reason
		// visible, never stop it and never error the attach.
		const outcome = await client.launchFolderShell({
			slot,
			cwd: tmpdir(),
			shellPath: process.execPath,
			shellArgs: ["-e", SHELL_SCRIPT],
			owner: { extensionHostPid: process.pid, parentPid: process.pid + 1, mainPid: process.pid + 1 },
		});
		assert.equal(outcome.state, "running", outcome.reason);
		const handle = outcome.handle;
		assert.ok(handle);
		opened.push(handle);
		const seen = watch(handle);
		await handle.attach({ since: 0 });
		await seen.whenText(value => value.includes("GRANDCHILD="));
		const shellPid = (await handle.refreshStatus()).nativePid;
		assert.ok(shellPid !== null && shellPid > 0);
		const disarmed = handle.statusValue?.ownerStop;
		assert.equal(disarmed?.state, "disarmed", disarmed?.detail);
		assert.match(disarmed?.detail ?? "", /automatic stopping is disarmed/);
		assert.deepEqual(disarmed?.owners, []);
		await delayMs(1_500);
		assert.equal(isPtyProcessAlive(shellPid), true, "a disarmed shell must be left for an explicit Close");
	});

	it("keeps the record when the child exits on its own, through retention and an explicit shutdown", async () => {
		const slot = nextSlot();
		const outcome = await client.launch({
			slot,
			kind: "managed-omp",
			file: process.execPath,
			args: ["-e", "process.stdout.write('DONE'); process.exit(0);"],
			cwd: tmpdir(),
			exitRetentionMs: 500,
		});
		assert.equal(outcome.state, "running", outcome.reason);
		const handle = outcome.handle;
		assert.ok(handle);
		opened.push(handle);
		const seen = watch(handle);
		await handle.attach({ since: 0 });
		// The child exits by itself, so nothing ever proved its tree gone. The exit may
		// already have happened (the status says so) or still be coming; waiting on the
		// state itself means an exit before this test subscribed is not missed.
		if ((await handle.refreshStatus()).state !== "exited") {
			await seen.whenEvent(event => event.type === "state" && event.status.state === "exited");
		}
		// A real wait, because the retention timer under test is a real timer, and it must
		// not fire while the tree is unproven.
		await new Promise<void>(resolve => setTimeout(resolve, 1_200));
		assert.equal((await readPtyRecord(storage, slot)).kind, "ok", "the record was retired for an unproven tree");
		assert.equal((await handle.refreshStatus()).state, "exited");
		const closed = await handle.shutdown();
		assert.equal(closed.stopped, true);
		// A shutdown closes the endpoint, not the question: the record survives as recovery
		// metadata because nothing proved the tree gone.
		assert.equal((await readPtyRecord(storage, slot)).kind, "ok", "the shutdown retired an unproven record");
		// The endpoint is gone and the tree was never proven: the slot stays occupied by an
		// uncertain record, so no successor may take it.
		const refused = await client.launch({
			slot,
			kind: "managed-omp",
			file: process.execPath,
			args: ["-e", MANAGED_SCRIPT],
			cwd: tmpdir(),
		});
		assert.equal(refused.state, "slot-occupied", refused.reason);
		assert.equal(refused.adopted, false);
		assert.match(refused.reason, /recovery metadata/);
		const stillThere = await readPtyRecord(storage, slot);
		assert.equal(stillThere.kind === "ok" ? stillThere.record.brokerId : "", handle.record.brokerId);
	});

	it("retains its record across a termination signal until a window proves it gone", async () => {
		const slot = nextSlot();
		const { handle } = await launchChild(slot);
		const brokerPid = handle.brokerPid;
		const creation = handle.record.brokerCreationTime;
		assert.ok(creation !== null);
		process.kill(brokerPid, "SIGTERM");
		const gone = await waitForPtyProcessGone(helper, brokerPid, creation, 20_000);
		assert.equal(gone.gone, true, gone.detail);
		handle.disconnect();
		// The broker exited on a signal: the record stays as recovery metadata.
		assert.equal((await readPtyRecord(storage, slot)).kind, "ok");
		// On Windows an external `process.kill(pid, "SIGTERM")` terminates the target without
		// running its handler, so the broker cannot be asked to log its own signal path here.
		// What must hold either way: no stop was initiated, and the record survived.
		const recordName = path.basename(client.recordPath(slot));
		const logName = recordName.endsWith(".json") ? recordName.slice(0, -".json".length) : recordName;
		const logText = await readFile(path.join(client.stateDirectory(), "logs", `${logName}.log`), "utf8").catch(() => "");
		assert.doesNotMatch(logText, /stop mode=/);
		// The next window proves the broker gone, and still may not take an uncertain slot.
		const refused = await client.launch({
			slot,
			kind: "managed-omp",
			file: process.execPath,
			args: ["-e", MANAGED_SCRIPT],
			cwd: tmpdir(),
		});
		assert.equal(refused.state, "slot-occupied", refused.reason);
		assert.equal(refused.adopted, false);
		assert.match(refused.reason, /recovery metadata/);
	});

	it("admits only the token from the record", async () => {
		const slot = nextSlot();
		const { handle } = await launchChild(slot);
		const lookup = await readPtyRecord(storage, slot);
		assert.equal(lookup.kind, "ok");
		const record = lookup.kind === "ok" ? lookup.record : null;
		assert.ok(record);
		await assert.rejects(
			connectPtyBroker({
				token: createPtyToken(),
				brokerId: record.brokerId,
				generation: record.generation,
				port: record.port,
			}),
			/refused the connection/,
		);
		await assert.rejects(
			connectPtyBroker({
				token: record.token,
				brokerId: "pty-99999999-2222-3333-4444-555555555555",
				generation: record.generation,
				port: record.port,
			}),
			/refused the connection/,
		);
		// The handle that already holds the record still works.
		assert.equal((await handle.refreshStatus()).state, "running");
	});

	it("keeps its record when an explicit shutdown follows an unproven tree stop", async () => {
		const slot = nextSlot();
		const { handle } = await launchChild(slot);
		// Nothing has been proved yet, so the gate refuses: an unobserved child is not a
		// stopped one.
		await assert.rejects(handle.shutdown(), refusesWith("child-alive"));
		assert.equal((await readPtyRecord(storage, slot)).kind, "ok");
		const stopped = await handle.stop({ timeoutMs: 30_000 });
		assert.equal(stopped.pidGone, true, stopped.detail);
		assert.equal(stopped.verified, false, stopped.detail);
		// The stop proved the exact child generation gone, so a shutdown that requires a
		// stopped child is accepted even when node-pty's own exit event never arrived for
		// it: absence proof is what the gate reads, not the event alone.
		const closed = await handle.shutdown();
		assert.equal(closed.stopped, true);
		const absence = await waitForPtyProcessGone(helper, handle.brokerPid, handle.record.brokerCreationTime, 20_000);
		assert.equal(absence.gone, true, absence.detail);
		// The root is gone and the tree was never proven: an explicit shutdown still leaves
		// the record, so a later window can tell an uncertain stop from one that never ran.
		const left = await readPtyRecord(storage, slot);
		assert.equal(left.kind, "ok");
		// Retained means this run's own recovery metadata, not an erased or replaced slot.
		assert.equal(left.kind === "ok" ? left.record.brokerId : "", handle.record.brokerId);
		assert.equal(left.kind === "ok" ? left.record.generation : "", handle.record.generation);
		const refusedAfterStop = await client.launch({
			slot,
			kind: "managed-omp",
			file: process.execPath,
			args: ["-e", MANAGED_SCRIPT],
			cwd: tmpdir(),
		});
		assert.equal(refusedAfterStop.state, "slot-occupied", refusedAfterStop.reason);
		assert.equal(refusedAfterStop.adopted, false);
		assert.equal((await readPtyRecord(storage, slot)).kind, "ok");
	});
});
