/**
 * Tests for the broker's runtime staging and its ABI gate.
 *
 * Runner: `node --test src/host/pty-runtime.test.ts`
 *
 * A broker is a tree, not a file: the entry, the PowerShell identity probe and the
 * `node-pty` package with its native addon and its DLLs. What matters is that the
 * packaged tree is enumerated as it is (minus the bundle's source map), that a staged
 * tree is named by the content it holds — so two builds cannot be handed each other's
 * copy — that a copy which changed is detected before anything runs from it, and that
 * the packaged tree is *proved* in the runtime that will use it rather than assumed
 * to work.
 *
 * The last part runs the real self-check against the real build output. It is skipped
 * when that output is absent (a checkout that has not been built).
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { createHash } from "node:crypto";
import type { PrivateStorageCommandResult, PrivateStorageProbe } from "./private-storage.ts";
import { TEST_CURRENT_SID, fixtureAcl, fixturePrincipal } from "./private-storage-test-support.ts";
import { hashRuntimeTree, stageRuntimeTree, verifyStagedRuntimeTree, type RuntimeTreeSource } from "./runtime-assets.ts";
import type { PtySelfCheckAnswer } from "./pty-runtime-proof-store.ts";
import {
	PTY_BROKER_ENTRY,
	PTY_OWNER_HELPER,
	PTY_PROBE_HELPER,
	ensurePtyProbeHelper,
	ensurePtyRuntime,
	discardReusedPtyProof,
	forgetProvedPtyRuntimes,
	ptyRuntimeCommand,
	ptyRuntimeSources,
	spawnPtyBroker,
} from "./pty-runtime.ts";

const EXTENSION_ROOT = fileURLToPath(new URL("../..", import.meta.url));

const ACCOUNT = "WORKSTATION\\dev";
const OWNER_ONLY = [ACCOUNT, "NT AUTHORITY\\SYSTEM", "BUILTIN\\Administrators"];

const roots: string[] = [];

after(async () => {
	for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function makeTemp(name: string): Promise<string> {
	return await makeTempUnder(tmpdir(), name);
}

async function makeTempUnder(parent: string, name: string): Promise<string> {
	const root = await mkdtemp(path.join(parent, name));
	roots.push(root);
	return root;
}

function aclListing(target: string, principals: readonly string[]): string {
	return fixtureAcl(principals.map(principal => `${principal}:(OI)(CI)(F)`));
}

/** An access seam describing an owner-only tree, so staging does not depend on this host's ACLs. */
function ownerOnlyProbe(): PrivateStorageProbe {
	return {
		platform: "win32",
		currentSid: TEST_CURRENT_SID,
		readAcl: async (target: string): Promise<PrivateStorageCommandResult> => ({
			ok: true,
			stdout: aclListing(target, OWNER_ONLY),
			detail: null,
		}),
		applyIcacls: async (): Promise<PrivateStorageCommandResult> => ({ ok: true, stdout: "", detail: null }),
		readOwners: async (paths: readonly string[]): Promise<PrivateStorageCommandResult> => ({
			ok: true,
			stdout: paths.map(target => `${target}|${fixturePrincipal(ACCOUNT)}`).join("\r\n"),
			detail: null,
		}),
	};
}

/** A packaged tree with the layout the runtime expects, and one file it must ignore. */
async function packagedTree(files: Record<string, string>): Promise<string> {
	const root = await makeTemp("omp-pty-tree-");
	for (const [relative, content] of Object.entries(files)) {
		const target = path.join(root, "out", "pty", ...relative.split("/"));
		await mkdir(path.dirname(target), { recursive: true });
		await writeFile(target, content, "utf8");
	}
	return root;
}

describe("packaged tree listing", () => {
	it("lists every packaged file except the bundle's own source map", async () => {
		const root = await packagedTree({
			"pty-broker.js": "// entry",
			"pty-broker.js.map": "{}",
			"pty-process-probe.ps1": "# probe",
			"node_modules/node-pty/package.json": "{}",
			"node_modules/node-pty/lib/index.js": "// index",
			"node_modules/node-pty/prebuilds/win32-x64/pty.node": "binary",
		});
		const listed = (await ptyRuntimeSources(root)).map(source => source.relativePath);
		assert.deepEqual(listed, [
			"node_modules/node-pty/lib/index.js",
			"node_modules/node-pty/package.json",
			"node_modules/node-pty/prebuilds/win32-x64/pty.node",
			"pty-broker.js",
			"pty-process-probe.ps1",
		]);
	});

	it("refuses a packaged tree that cannot be listed at all", async () => {
		const root = await makeTemp("omp-pty-empty-");
		await assert.rejects(ptyRuntimeSources(root));
	});
});

describe("staged tree", () => {
	it("is named by the content it holds, and is reused when it has not changed", async () => {
		const root = await packagedTree({ "pty-broker.js": "// entry", "pty-process-probe.ps1": "# probe" });
		const storage = await makeTemp("omp-pty-storage-");
		const sources = await ptyRuntimeSources(root);
		const first = await stageRuntimeTree({
			storageDir: storage,
			namespace: "pty-tree",
			sources,
			access: ownerOnlyProbe(),
		});
		const second = await stageRuntimeTree({
			storageDir: storage,
			namespace: "pty-tree",
			sources,
			access: ownerOnlyProbe(),
		});
		assert.equal(first.digest, second.digest);
		assert.equal(first.directory, second.directory);
		assert.equal(await verifyStagedRuntimeTree(first), true);
		assert.equal(await readFile(path.join(first.directory, "pty-broker.js"), "utf8"), "// entry");

		// A changed file is a different tree, and the old copy is left alone: a process
		// may still be running from it.
		const changed = await packagedTree({ "pty-broker.js": "// entry v2", "pty-process-probe.ps1": "# probe" });
		const third = await stageRuntimeTree({
			storageDir: storage,
			namespace: "pty-tree",
			sources: await ptyRuntimeSources(changed),
			access: ownerOnlyProbe(),
		});
		assert.notEqual(first.digest, third.digest);
		assert.equal(existsSync(first.directory), true);
	});

	it("detects a copy that no longer holds the bytes it was staged with", async () => {
		const root = await packagedTree({ "pty-broker.js": "// entry", "pty-process-probe.ps1": "# probe" });
		const storage = await makeTemp("omp-pty-storage-");
		const tree = await stageRuntimeTree({
			storageDir: storage,
			namespace: "pty-tree",
			sources: await ptyRuntimeSources(root),
			access: ownerOnlyProbe(),
		});
		await writeFile(path.join(tree.directory, "pty-broker.js"), "// replaced", "utf8");
		assert.equal(await verifyStagedRuntimeTree(tree), false);
	});

	it("refuses a tree entry that is not a path inside the tree", async () => {
		const storage = await makeTemp("omp-pty-storage-");
		const sources: RuntimeTreeSource[] = [{ relativePath: "../escape.js", sourcePath: EXTENSION_ROOT }];
		await assert.rejects(
			stageRuntimeTree({ storageDir: storage, namespace: "pty-tree", sources, access: ownerOnlyProbe() }),
			/relative path/,
		);
	});
});

describe("runtime command", () => {
	it("uses the given runtime verbatim, and this process's executable otherwise", () => {
		const given = ptyRuntimeCommand("C:\\custom\\node.exe");
		assert.equal(given.command, "C:\\custom\\node.exe");
		const own = ptyRuntimeCommand();
		assert.equal(own.command, process.execPath);
		// This test process is not Electron, so nothing is switched on for it; the flag
		// exists for the extension host, where `process.execPath` is Electron.
		assert.equal(own.env.ELECTRON_RUN_AS_NODE, undefined);
	});
});

/**
 * A packaged tree whose entry answers `--self-check` however the test wants, so the
 * gate's own decisions can be exercised without a native addon in the loop.
 */
async function fakeRuntimeTree(entry: string): Promise<string> {
	const root = await makeTempUnder(homedir(), ".omp-pty-fake-");
	const directory = path.join(root, "out", "pty");
	await mkdir(directory, { recursive: true });
	await writeFile(path.join(directory, PTY_PROBE_HELPER), "# probe", "utf8");
	await writeFile(path.join(directory, PTY_OWNER_HELPER), "# owner watch", "utf8");
	await writeFile(path.join(directory, PTY_BROKER_ENTRY), entry, "utf8");
	return root;
}

const built = existsSync(path.join(EXTENSION_ROOT, "out", "pty", PTY_BROKER_ENTRY));

describe("attach readiness", { skip: process.platform !== "win32" ? "the runtime is Windows-only" : false }, () => {
	it("stages and verifies only the identity probe, without running the tree's entry, and names the build's whole tree", async () => {
		// The entry is a script that would fail loudly if anything executed it: an attach must
		// never start the staged tree, only read the probe helper from it.
		const root = await packagedTree({
			[PTY_PROBE_HELPER]: "# probe",
			[PTY_BROKER_ENTRY]: "process.exit(9);",
			[PTY_OWNER_HELPER]: "# owner",
			"node_modules/node-pty/index.js": "// pty",
		});
		const storageDir = await makeTemp("omp-pty-storage-");
		const readiness = await ensurePtyProbeHelper({ storageDir, extensionRoot: root, access: ownerOnlyProbe() });

		assert.equal(readiness.ready, true, readiness.reason ?? "");
		assert.ok(readiness.helper !== null);
		assert.equal(await readFile(readiness.helper.path, "utf8"), "# probe");
		assert.equal(readiness.helper.sha256, createHash("sha256").update("# probe").digest("hex"));
		assert.equal(path.basename(readiness.helper.path), PTY_PROBE_HELPER);
		const whole = await hashRuntimeTree(await ptyRuntimeSources(root));
		assert.equal(readiness.treeDigest, whole.digest, "a broker of this build reports the whole tree's digest, which an attach compares");
		// Nothing but the probe was copied: the staged tree is not there to be run.
		assert.equal(existsSync(path.join(path.dirname(readiness.helper.path), PTY_BROKER_ENTRY)), false);
	});

	it("refuses a packaged tree that has no identity probe", async () => {
		const root = await packagedTree({ [PTY_BROKER_ENTRY]: "// entry" });
		const readiness = await ensurePtyProbeHelper({ storageDir: await makeTemp("omp-pty-storage-"), extensionRoot: root, access: ownerOnlyProbe() });
		assert.equal(readiness.ready, false);
		assert.match(readiness.reason ?? "", /pty-process-probe\.ps1/);
		assert.equal(readiness.helper, null);
	});
});

describe("runtime proof gate", { skip: process.platform !== "win32" ? "the runtime proof is Windows-only" : false }, () => {
	it("refuses a tree that has no owner-watch helper, so a watch is never silently missing", async () => {
		// The owner watch is a capability of the staged tree, not of the entry's argument
		// line: a tree without the helper must be reported incomplete rather than starting
		// a broker that would have to disarm for every shell.
		const root = await makeTempUnder(homedir(), ".omp-pty-fake-");
		const directory = path.join(root, "out", "pty");
		await mkdir(directory, { recursive: true });
		await writeFile(path.join(directory, PTY_PROBE_HELPER), "# probe", "utf8");
		await writeFile(path.join(directory, PTY_BROKER_ENTRY), "// entry", "utf8");
		const readiness = await ensurePtyRuntime({
			storageDir: await makeTempUnder(homedir(), ".omp-pty-storage-"),
			extensionRoot: root,
		});
		assert.equal(readiness.ready, false);
		assert.match(readiness.reason ?? "", /pty-owner-watch\.ps1/);
	});

	it("refuses a runtime whose self-check child failed, and one that ran no child", async () => {
		const report = (fields: Record<string, unknown>): string =>
			`process.stdout.write(JSON.stringify(${JSON.stringify({
				runtimeVersion: 1,
				platform: "win32",
				arch: "x64",
				node: "24.0.0",
				electron: null,
				nodePty: "fake",
				conptyDll: true,
				childPid: process.pid,
				childOutput: true,
				pipeChild: true,
				childExitCode: 0,
				durationMs: 1,
				ok: true,
				...fields,
			})}) + "\\n");`;
		// A child that exited with a failure is not proof that a terminal can run.
		const failedChild = await fakeRuntimeTree(report({ childExitCode: 1 }));
		const firstReadiness = await ensurePtyRuntime({
			storageDir: await makeTempUnder(homedir(), ".omp-pty-storage-"),
			extensionRoot: failedChild,
		});
		assert.equal(firstReadiness.ready, false);
		assert.match(firstReadiness.reason ?? "", /did not exit cleanly/);
		// An unreported exit code is never enough on its own, however the answer is spelled.
		for (const childOutput of [false, undefined, "yes"]) {
			const unproven = await fakeRuntimeTree(report({ childExitCode: null, childOutput }));
			const unprovenReadiness = await ensurePtyRuntime({
				storageDir: await makeTempUnder(homedir(), ".omp-pty-storage-"),
				extensionRoot: unproven,
			});
			assert.equal(unprovenReadiness.ready, false, `accepted childOutput ${String(childOutput)}`);
			assert.match(unprovenReadiness.reason ?? "", /did not prove the child's output/);
		}
		// So is a self-check that claims success but names no child process.
		const noChild = await fakeRuntimeTree(report({ childPid: 0 }));
		const secondReadiness = await ensurePtyRuntime({
			storageDir: await makeTempUnder(homedir(), ".omp-pty-storage-"),
			extensionRoot: noChild,
		});
		assert.equal(secondReadiness.ready, false);
		assert.match(secondReadiness.reason ?? "", /did not report the child process/);
		// And a self-check process that exits nonzero is refused even when its answer
		// claims success.
		const badExit = await fakeRuntimeTree(`process.stdout.write(JSON.stringify({ ok: true, runtimeVersion: 1, platform: "win32", arch: "x64", node: "24.0.0", electron: null, nodePty: "fake", conptyDll: true, childPid: 4242, childOutput: true, pipeChild: true, childExitCode: 0, durationMs: 1 }) + "\\n"); process.exit(3);`);
		const thirdReadiness = await ensurePtyRuntime({
			storageDir: await makeTempUnder(homedir(), ".omp-pty-storage-"),
			extensionRoot: badExit,
		});
		assert.equal(thirdReadiness.ready, false);
		assert.match(thirdReadiness.reason ?? "", /exit code 3/);
	});

	it("reports the reason a nonzero self-check printed, not only its exit code", async () => {
		// The entry exits 7 and prints why on stdout. A caller that kept only "exit code 7"
		// would force an operator to dig through logs to learn what the runtime measured.
		const explained = await fakeRuntimeTree(
			`process.stdout.write(JSON.stringify({ ok: false, detail: "the self-check child did not prove itself through its pseudo console (start missing, completion missing)" }) + "\\n"); process.exit(7);`,
		);
		const readiness = await ensurePtyRuntime({
			storageDir: await makeTempUnder(homedir(), ".omp-pty-storage-"),
			extensionRoot: explained,
		});
		assert.equal(readiness.ready, false);
		assert.match(readiness.reason ?? "", /failed with exit code 7/);
		assert.match(readiness.reason ?? "", /did not prove itself through its pseudo console/);
	});

	it("accepts a runtime whose self-check ran a child to a clean exit", async () => {
		const answer = (fields: Record<string, unknown>): string =>
			`process.stdout.write(JSON.stringify({ ok: true, runtimeVersion: 1, platform: "win32", arch: "x64", node: "24.0.0", electron: null, nodePty: "fake", conptyDll: true, childPid: ${process.pid}, childOutput: true, pipeChild: true, childExitCode: 0, durationMs: 1, ${Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join(", ")} }) + "\\n");`;
		const clean = await fakeRuntimeTree(answer({}));
		const readiness = await ensurePtyRuntime({
			storageDir: await makeTempUnder(homedir(), ".omp-pty-storage-"),
			extensionRoot: clean,
		});
		assert.equal(readiness.ready, true, readiness.reason ?? "not ready");
		// The measured Windows case: the child proved itself through the pseudo console
		// and this backend reported no exit code at all.
		const unreported = await fakeRuntimeTree(answer({ childExitCode: null }));
		const unreportedReadiness = await ensurePtyRuntime({
			storageDir: await makeTempUnder(homedir(), ".omp-pty-storage-"),
			extensionRoot: unreported,
		});
		assert.equal(unreportedReadiness.ready, true, unreportedReadiness.reason ?? "not ready");
		assert.equal(unreportedReadiness.proven, true);
		assert.equal(unreportedReadiness.runtime?.selfCheck?.childExitCode, null);
		assert.equal(unreportedReadiness.runtime?.selfCheck?.childOutput, true);
	});

	describe("a self-check that ran out of time", () => {
		/** An entry that records each run's argument line in `log`, then prints `answer` and exits with `code`. */
		const entryWith = (log: string, answer: Record<string, unknown>, code: number): string =>
			`require("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");` +
			`process.stdout.write(JSON.stringify(${JSON.stringify(answer)}) + "\\n"); process.exit(${code});`;
		const lateAnswer = {
			ok: false,
			outcome: "inconclusive",
			detail: "the pipe child did not finish within the self-check deadline of 15 s",
		};

		it("is admitted provisionally, not as a proof, and is probed again by the next call", async () => {
			const log = path.join(await makeTempUnder(homedir(), ".omp-pty-log-"), "runs.log");
			const root = await fakeRuntimeTree(entryWith(log, lateAnswer, 8));
			const storageDir = await makeTempUnder(homedir(), ".omp-pty-storage-");
			const first = await ensurePtyRuntime({ storageDir, extensionRoot: root });
			assert.equal(first.ready, true, first.reason ?? "not ready");
			assert.equal(first.proven, false);
			assert.ok(first.runtime, "a broker may be started from the staged, verified tree");
			assert.equal(first.runtime.selfCheck, null);
			assert.match(first.reason ?? "", /did not finish within the self-check deadline of 15 s/);
			assert.match(first.reason ?? "", /admitted unproven/);
			// Not cached: the same tree in the same storage runs its check again.
			const second = await ensurePtyRuntime({ storageDir, extensionRoot: root });
			assert.equal(second.proven, false);
			assert.equal((await readFile(log, "utf8")).trim().split("\n").length, 2);
		});

		it("asks the entry for the deadline it is given, and for its default otherwise", async () => {
			const log = path.join(await makeTempUnder(homedir(), ".omp-pty-log-"), "runs.log");
			const root = await fakeRuntimeTree(entryWith(log, lateAnswer, 8));
			const storageDir = await makeTempUnder(homedir(), ".omp-pty-storage-");
			await ensurePtyRuntime({ storageDir, extensionRoot: root });
			await ensurePtyRuntime({ storageDir, extensionRoot: root, selfCheckDeadlineMs: 90_000 });
			const runs = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line) as string[]);
			assert.deepEqual(runs[0], ["--self-check"]);
			assert.deepEqual(runs[1], ["--self-check", "--self-check-deadline-ms=90000"]);
		});

		it("is refused when the entry says it observed a fault, even though it also ran long", async () => {
			const log = path.join(await makeTempUnder(homedir(), ".omp-pty-log-"), "runs.log");
			const broken = { ok: false, outcome: "broken", detail: "the self-check child exited with code 3" };
			const root = await fakeRuntimeTree(entryWith(log, broken, 7));
			const readiness = await ensurePtyRuntime({ storageDir: await makeTempUnder(homedir(), ".omp-pty-storage-"), extensionRoot: root });
			assert.equal(readiness.ready, false);
			assert.equal(readiness.proven, false);
			assert.match(readiness.reason ?? "", /exit code 7: the self-check child exited with code 3/);
		});

		it("is refused when the entry's answer carries no outcome, as an old entry's would", async () => {
			// Only an explicit `inconclusive` is lateness; a bare nonzero status never is.
			const log = path.join(await makeTempUnder(homedir(), ".omp-pty-log-"), "runs.log");
			const root = await fakeRuntimeTree(entryWith(log, { ok: false, detail: "no outcome field" }, 8));
			const readiness = await ensurePtyRuntime({ storageDir: await makeTempUnder(homedir(), ".omp-pty-storage-"), extensionRoot: root });
			assert.equal(readiness.ready, false);
			assert.match(readiness.reason ?? "", /exit code 8: no outcome field/);
		});

		it("is refused when the classification contradicts the exit code the entry chose", async () => {
			// "inconclusive" under the fault exit code is a contradiction, not lateness.
			const log = path.join(await makeTempUnder(homedir(), ".omp-pty-log-"), "runs.log");
			const root = await fakeRuntimeTree(entryWith(log, lateAnswer, 7));
			const readiness = await ensurePtyRuntime({ storageDir: await makeTempUnder(homedir(), ".omp-pty-storage-"), extensionRoot: root });
			assert.equal(readiness.ready, false);
			assert.match(readiness.reason ?? "", /exit code 7/);
		});

		it("is refused when an inconclusive answer also reports a nonzero child exit", async () => {
			// The child's own nonzero code is an observed fault, whatever the run called itself.
			const log = path.join(await makeTempUnder(homedir(), ".omp-pty-log-"), "runs.log");
			const root = await fakeRuntimeTree(entryWith(log, { ...lateAnswer, childExitCode: 3 }, 8));
			const readiness = await ensurePtyRuntime({ storageDir: await makeTempUnder(homedir(), ".omp-pty-storage-"), extensionRoot: root });
			assert.equal(readiness.ready, false);
		});

		it("is refused when a run given the extended deadline still calls itself late", async () => {
			// The re-run is what settles a provisional admission; it must never answer "late" again.
			const log = path.join(await makeTempUnder(homedir(), ".omp-pty-log-"), "runs.log");
			const root = await fakeRuntimeTree(entryWith(log, lateAnswer, 8));
			const readiness = await ensurePtyRuntime({
				storageDir: await makeTempUnder(homedir(), ".omp-pty-storage-"),
				extensionRoot: root,
				selfCheckDeadlineMs: 90_000,
			});
			assert.equal(readiness.ready, false);
			assert.equal(readiness.proven, false);
		});
	});
});

describe("runtime proof", { skip: built ? false : "the packaged broker tree is absent: run `node esbuild.mjs --pty` first" }, () => {
	it("proves the packaged tree by running a child through its own PTY backend", async () => {
		// The real access convention runs here, and the shared temporary directory fails
		// its ancestor rule by measurement (another account may write it), so a test that
		// stages for real uses this account's profile — the same choice the runtime-asset
		// tests document.
		const storage = await makeTempUnder(homedir(), ".omp-pty-storage-");
		const readiness = await ensurePtyRuntime({
			storageDir: storage,
			extensionRoot: EXTENSION_ROOT,
		});
		assert.equal(readiness.ready, true, readiness.reason ?? "not ready");
		const runtime = readiness.runtime;
		assert.ok(runtime);
		assert.match(runtime.tree.digest, /^[a-f0-9]{64}$/);
		assert.equal(runtime.tree.files.some(file => file.relativePath === PTY_BROKER_ENTRY), true);
		assert.equal(runtime.tree.files.some(file => file.relativePath === PTY_PROBE_HELPER), true);
		assert.equal(runtime.tree.files.some(file => file.relativePath === PTY_OWNER_HELPER), true);
		assert.equal(runtime.ownerHelper.path.endsWith(PTY_OWNER_HELPER), true);
		assert.match(runtime.ownerHelper.sha256, /^[a-f0-9]{64}$/);
		assert.equal(runtime.tree.files.some(file => file.relativePath === "node_modules/node-pty/lib/index.js"), true);
		assert.equal(runtime.tree.files.some(file => file.relativePath.endsWith(".map")), false);
		const proof = runtime.selfCheck;
		assert.ok(proof, "a proven runtime carries what its self-check observed");
		assert.equal(readiness.proven, true);
		assert.equal(proof.childOutput, true, "the child's own proof must have been read back");
		// The measured Windows backend does not always report the child's exit code, so a
		// proof with an unreported code is a proof: the markers are what admitted it.
		assert.ok(
			proof.childExitCode === 0 || proof.childExitCode === null,
			`unexpected child exit code ${String(proof.childExitCode)}`,
		);
		if (process.platform === "win32") assert.equal(proof.conptyDll, true);
		// The second call is the cached proof of the same tree in the same storage.
		const again = await ensurePtyRuntime({ storageDir: storage, extensionRoot: EXTENSION_ROOT });
		assert.equal(again.treeDigest, readiness.treeDigest);
		assert.equal(again.runtime?.tree.directory, runtime.tree.directory);
	});
});

/** A runnable real Bun of this machine, whatever its version (the pipe-only proof does not gate on one): `BUN_INSTALL`, the profile's `.bun`, then `PATH`. */
function findRealBun(): { readonly executable: string; readonly version: string } | null {
	const candidates = [
		...(process.env.BUN_INSTALL === undefined ? [] : [path.join(process.env.BUN_INSTALL, "bin", "bun.exe")]),
		path.join(homedir(), ".bun", "bin", "bun.exe"),
		...(process.env.PATH ?? "").split(path.delimiter).filter(entry => entry.length > 0).map(entry => path.join(entry, "bun.exe")),
	];
	for (const candidate of candidates) {
		if (!existsSync(candidate)) continue;
		const probe = spawnSync(candidate, ["--version"], { encoding: "utf8", windowsHide: true, timeout: 20_000 });
		const version = probe.status === 0 ? probe.stdout.trim() : "";
		if (/^\d+\.\d+\.\d+/.test(version)) return { executable: candidate, version };
	}
	return null;
}

describe("pipe-only runtime proof (ADR-0074)", { skip: process.platform !== "win32" ? "the runtime proof is Windows-only" : false }, () => {
	const FULL_ANSWER: PtySelfCheckAnswer = {
		runtimeVersion: 2,
		platform: "win32",
		arch: "x64",
		node: "24.0.0",
		electron: null,
		nodePty: "fake",
		conptyDll: true,
		childOutput: true,
		pipeChild: true,
		childExitCode: null,
		durationMs: 1,
	};
	const PIPE_ONLY_ANSWER: PtySelfCheckAnswer = { ...FULL_ANSWER, nodePty: null, conptyDll: false, childOutput: false, pipeOnly: true, bun: "1.4.3", execPath: "C:\\bun\\bun.exe" };

	it("keeps a full proof and a pipe-only proof of the same tree and executable apart, in process and on disk", async () => {
		forgetProvedPtyRuntimes();
		const root = await packagedTree({ [PTY_BROKER_ENTRY]: "// entry", [PTY_PROBE_HELPER]: "# probe", [PTY_OWNER_HELPER]: "# owner" });
		const storageDir = await makeTemp("omp-pty-pipe-only-storage-");
		const seen: (boolean | undefined)[] = [];
		const run = (pipeOnly: boolean | undefined) => ensurePtyRuntime({
			storageDir,
			extensionRoot: root,
			nodePath: process.execPath,
			access: ownerOnlyProbe(),
			...(pipeOnly === undefined ? {} : { pipeOnly }),
			runSelfCheck: async (_runtime, options) => {
				seen.push(options.pipeOnly);
				return { kind: "proven", answer: options.pipeOnly === true ? PIPE_ONLY_ANSWER : FULL_ANSWER, detail: "the runtime proved itself" };
			},
		});
		const full = await run(undefined);
		const pipeOnly = await run(true);
		assert.equal(seen.length, 2, "the pipe-only call must not be answered from the full proof's cache entry");
		assert.deepEqual(seen, [undefined, true]);
		assert.equal(full.runtime?.selfCheck?.childOutput, true);
		assert.equal(pipeOnly.runtime?.selfCheck?.childOutput, false);
		assert.equal(pipeOnly.runtime?.selfCheck?.pipeOnly, true);
		assert.equal(pipeOnly.runtime?.selfCheck?.bun, "1.4.3");
		// Each is now cached in process under its own entry.
		assert.equal((await run(undefined)).runtime?.selfCheck?.childOutput, true);
		assert.equal((await run(true)).runtime?.selfCheck?.pipeOnly, true);
		assert.equal((await run(false)).runtime?.selfCheck?.childOutput, true);
		assert.equal(seen.length, 2);
		// A new window finds each proof under its own file.
		forgetProvedPtyRuntimes();
		const reusedFull = await run(undefined);
		const reusedPipeOnly = await run(true);
		assert.equal(seen.length, 2, "both proofs were stored");
		assert.ok(reusedFull.reusedProof && reusedPipeOnly.reusedProof);
		assert.notEqual(reusedFull.reusedProof.file, reusedPipeOnly.reusedProof.file);
		assert.equal(reusedFull.runtime?.selfCheck?.childOutput, true);
		assert.equal(reusedPipeOnly.runtime?.selfCheck?.pipeOnly, true);
		assert.equal(reusedPipeOnly.runtime?.selfCheck?.bun, "1.4.3");
	});

	describe("the in-process proof of a pipe-only runtime, keyed to the executable file", () => {
		/** A run of `ensurePtyRuntime` whose self-check is a counted seam, on an executable that is any small file. */
		async function counted() {
			forgetProvedPtyRuntimes();
			const root = await packagedTree({ [PTY_BROKER_ENTRY]: "// entry", [PTY_PROBE_HELPER]: "# probe", [PTY_OWNER_HELPER]: "# owner" });
			const storageDir = await makeTemp("omp-pty-stamp-storage-");
			const executable = path.join(await makeTemp("omp-pty-stamp-exe-"), "bun.exe");
			await copyFile(fileURLToPath(import.meta.url), executable);
			let runs = 0;
			const run = (pipeOnly: boolean) => ensurePtyRuntime({
				storageDir,
				extensionRoot: root,
				nodePath: executable,
				access: ownerOnlyProbe(),
				pipeOnly,
				runSelfCheck: async () => {
					runs += 1;
					return { kind: "proven", answer: pipeOnly ? PIPE_ONLY_ANSWER : FULL_ANSWER, detail: "the runtime proved itself" };
				},
			});
			return { executable, storageDir, run, runs: () => runs };
		}

		it("proves the file again once its modification time changes, and not before", async () => {
			const { executable, run, runs } = await counted();
			assert.equal((await run(true)).proven, true);
			assert.equal(runs(), 1);
			assert.equal((await run(true)).proven, true);
			assert.equal(runs(), 1, "an unchanged file is answered from the cache");
			const later = new Date(Date.now() + 120_000);
			await utimes(executable, later, later);
			assert.equal((await run(true)).proven, true);
			assert.equal(runs(), 2, "a changed file is a different executable and is proven afresh");
			assert.equal((await run(true)).proven, true);
			assert.equal(runs(), 2);
		});

		it("keeps a full proof's cache entry when a pipe-only proof is discarded", async () => {
			const { run, runs } = await counted();
			await run(false);
			await run(true);
			assert.equal(runs(), 2);
			// A later window finds both stored proofs; the pipe-only one is then withdrawn after a failed Bun start.
			forgetProvedPtyRuntimes();
			const full = await run(false);
			const pipeOnly = await run(true);
			assert.equal(runs(), 2, "both proofs were stored");
			assert.ok(full.reusedProof && pipeOnly.reusedProof);
			await discardReusedPtyProof(pipeOnly.reusedProof, { pipeOnly: true });
			const fullAgain = await run(false);
			assert.equal(fullAgain.reusedProof, undefined, "the full proof is still in the in-process cache");
			assert.equal(runs(), 2);
			const pipeOnlyAgain = await run(true);
			assert.equal(pipeOnlyAgain.proven, true);
			assert.equal(pipeOnlyAgain.reusedProof, undefined, "the stored pipe-only proof is gone");
			assert.equal(runs(), 3, "the pipe-only proof is run again");
		});

		it("drops the full proof's cache entry too when the discard is not limited to pipe-only", async () => {
			const { run, runs } = await counted();
			await run(false);
			await run(true);
			forgetProvedPtyRuntimes();
			const full = await run(false);
			const pipeOnly = await run(true);
			assert.ok(full.reusedProof && pipeOnly.reusedProof);
			await discardReusedPtyProof(pipeOnly.reusedProof);
			const fullAgain = await run(false);
			assert.ok(fullAgain.reusedProof, "the full proof is read from its stored file again, not from the in-process cache");
			assert.equal(runs(), 2);
		});
	});

	describe("the default self-check, against an entry that answers by script", () => {
		/** An entry that records its runtime options and its argument line, then prints `answer` and exits 0. */
		const entryWith = (log: string, answer: Record<string, unknown>): string =>
			`require("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify({ execArgv: process.execArgv, args: process.argv.slice(2) }) + "\\n");` +
			`process.stdout.write(JSON.stringify(${JSON.stringify(answer)}) + "\\n");`;
		const pipeOnlyReport = { ok: true, runtimeVersion: 2, platform: "win32", arch: "x64", node: "24.0.0", bun: "1.4.3", electron: null, pipeOnly: true, pipeChild: true, childOutput: false, loopback: true, execPath: "C:\\bun\\bun.exe", childExitCode: null, durationMs: 1 };

		async function readinessFor(answer: Record<string, unknown>, pipeOnly: boolean, runtimeArgs?: readonly string[]) {
			forgetProvedPtyRuntimes();
			const log = path.join(await makeTempUnder(homedir(), ".omp-pty-log-"), "runs.log");
			const root = await fakeRuntimeTree(entryWith(log, answer));
			const readiness = await ensurePtyRuntime({
				storageDir: await makeTempUnder(homedir(), ".omp-pty-storage-"),
				extensionRoot: root,
				nodePath: process.execPath,
				...(pipeOnly ? { pipeOnly: true } : {}),
				...(runtimeArgs === undefined ? {} : { runtimeArgs }),
			});
			const runs = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { execArgv: string[]; args: string[] });
			return { readiness, runs };
		}

		it("asks for `--self-check --pipe-only` and reads the pipe-only answer", async () => {
			const { readiness, runs } = await readinessFor(pipeOnlyReport, true);
			assert.deepEqual(runs, [{ execArgv: [], args: ["--self-check", "--pipe-only"] }]);
			assert.equal(readiness.ready, true, readiness.reason ?? "not ready");
			assert.equal(readiness.proven, true);
			const answer = readiness.runtime?.selfCheck;
			assert.equal(answer?.pipeOnly, true);
			assert.equal(answer?.childOutput, false);
			assert.equal(answer?.childExitCode, null);
			assert.equal(answer?.bun, "1.4.3");
			assert.equal(answer?.execPath, "C:\\bun\\bun.exe");
		});

		it("reports no Bun version when the runtime that answered was not Bun", async () => {
			const { readiness } = await readinessFor({ ...pipeOnlyReport, bun: null }, true);
			assert.equal(readiness.ready, true, readiness.reason ?? "not ready");
			assert.equal(readiness.runtime?.selfCheck?.bun, null);
		});

		it("puts the runtime's own arguments before the entry", async () => {
			const { readiness, runs } = await readinessFor(pipeOnlyReport, true, ["--no-warnings"]);
			assert.equal(readiness.ready, true, readiness.reason ?? "not ready");
			assert.deepEqual(runs, [{ execArgv: ["--no-warnings"], args: ["--self-check", "--pipe-only"] }]);
		});

		it("refuses an answer that does not say it is the pipe-only one", async () => {
			const answers = [
				{ ...pipeOnlyReport, pipeOnly: undefined },
				{ ...pipeOnlyReport, childOutput: true, childPid: 4242 },
				{ ...pipeOnlyReport, loopback: undefined },
				{ ...pipeOnlyReport, loopback: false },
				{ ...pipeOnlyReport, execPath: undefined },
				{ ...pipeOnlyReport, execPath: 7 },
			];
			for (const answer of answers) {
				const { readiness } = await readinessFor(answer, true);
				assert.equal(readiness.ready, false, JSON.stringify(answer));
				assert.match(readiness.reason ?? "", /answered as something else/);
			}
		});

		it("does not ask a full check for `--pipe-only`", async () => {
			const { runs } = await readinessFor({ ...pipeOnlyReport, childOutput: true, childPid: 4242, pipeOnly: undefined }, false);
			assert.deepEqual(runs, [{ execArgv: [], args: ["--self-check"] }]);
		});
	});

	describe("the real packaged entry", { skip: built ? false : "the packaged broker tree is absent: run `node esbuild.mjs --pty` first" }, () => {
		async function proveWith(nodePath: string) {
			forgetProvedPtyRuntimes();
			return await ensurePtyRuntime({
				storageDir: await makeTempUnder(homedir(), ".omp-pty-storage-"),
				extensionRoot: EXTENSION_ROOT,
				nodePath,
				pipeOnly: true,
			});
		}

		const bun = findRealBun();

		it("is proven under the real Bun, which names its own version", { skip: bun === null ? "no Bun was found (BUN_INSTALL, ~/.bun/bin, PATH)" : false, timeout: 120_000 }, async () => {
			assert.ok(bun);
			const readiness = await proveWith(bun.executable);
			assert.equal(readiness.ready, true, readiness.reason ?? "not ready");
			assert.equal(readiness.proven, true);
			const answer = readiness.runtime?.selfCheck;
			assert.ok(answer, "a proven runtime carries what its self-check observed");
			assert.equal(answer.pipeOnly, true);
			assert.equal(answer.childOutput, false);
			assert.equal(answer.pipeChild, true);
			assert.equal(answer.bun, bun.version);
			assert.equal(answer.conptyDll, false);
			assert.equal(answer.childExitCode, null);
			assert.equal((await realpath(answer.execPath ?? "")).toLowerCase(), (await realpath(bun.executable)).toLowerCase(), "the answer names the executable that ran it");
		});

		it("is proven under Node, which is not Bun, so the answer carries no Bun version", { timeout: 120_000 }, async () => {
			const readiness = await proveWith(process.execPath);
			assert.equal(readiness.ready, true, readiness.reason ?? "not ready");
			assert.equal(readiness.proven, true);
			const answer = readiness.runtime?.selfCheck;
			assert.ok(answer);
			assert.equal(answer.pipeOnly, true);
			assert.equal(answer.childOutput, false);
			assert.equal(answer.bun, null);
			assert.equal(answer.execPath, process.execPath);
		});
	});
});

const SPAWN_TEST_ANSWER: PtySelfCheckAnswer = {
	runtimeVersion: 2,
	platform: "win32",
	arch: "x64",
	node: "24.0.0",
	electron: null,
	nodePty: "fake",
	conptyDll: true,
	childOutput: true,
	pipeChild: true,
	childExitCode: null,
	durationMs: 1,
};

describe("spawning a broker on an executable that is not there", { skip: process.platform !== "win32" ? "the runtime proof is Windows-only" : false }, () => {
	it("raises no uncaught exception, reports no pid, and leaves the caller an exit code to read", { timeout: 30_000 }, async () => {
		forgetProvedPtyRuntimes();
		const root = await packagedTree({ [PTY_BROKER_ENTRY]: "// entry", [PTY_PROBE_HELPER]: "# probe", [PTY_OWNER_HELPER]: "# owner" });
		const storageDir = await makeTemp("omp-pty-missing-exe-");
		const readiness = await ensurePtyRuntime({
			storageDir,
			extensionRoot: root,
			nodePath: process.execPath,
			access: ownerOnlyProbe(),
			runSelfCheck: async () => ({ kind: "proven", answer: SPAWN_TEST_ANSWER, detail: "the runtime proved itself" }),
		});
		assert.ok(readiness.runtime, readiness.reason ?? "no runtime");
		const missing = path.join(await makeTemp("omp-pty-missing-exe-dir-"), "gone", "bun.exe");
		const uncaught: Error[] = [];
		const onUncaught = (error: Error): void => {
			uncaught.push(error);
		};
		process.on("uncaughtException", onUncaught);
		try {
			const child = spawnPtyBroker(readiness.runtime, ["--slot", "tab:missing"], { storageDir, extensionRoot: root, nodePath: missing, runtimeArgs: ["--no-install"] });
			assert.ok(child.listenerCount("error") >= 1, "an error listener is attached, so a failed spawn cannot become an uncaught error");
			assert.equal(child.pid, undefined, "a file that is not there has no process");
			const closed = Promise.withResolvers<void>();
			child.once("close", () => closed.resolve());
			await closed.promise;
			// One turn of the event loop, so an error event queued behind the close is delivered before the check.
			const turned = Promise.withResolvers<void>();
			setImmediate(() => turned.resolve());
			await turned.promise;
			assert.deepEqual(uncaught.map(error => error.message), []);
			assert.notEqual(child.exitCode, null, "the caller reads the failure from the exit code");
		} finally {
			process.off("uncaughtException", onUncaught);
		}
	});
});
