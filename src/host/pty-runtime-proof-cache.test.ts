/**
 * The PTY runtime's self-check, kept on disk so another window or a reload does not repeat it.
 *
 * What a consumer notices: whether the self-check ran. These tests count its runs through the
 * `runSelfCheck` seam and treat each `forgetProvedPtyRuntimes()` as a new window (a fresh
 * process has an empty in-process proof). The staged tree, its byte verification and its access
 * check run exactly as before in every case; only the check itself is skipped, and only for a
 * proof stored under an equal key.
 *
 * Runner: `node --test src/host/pty-runtime-proof-cache.test.ts`
 */
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import type { PrivateStorageCommandResult, PrivateStorageProbe } from "./private-storage.ts";
import { type LoggedLine, recordingLogger } from "../shared/logger.ts";
import { TEST_CURRENT_SID, fixtureAcl, fixturePrincipal } from "./private-storage-test-support.ts";
import {
	PTY_BROKER_ENTRY,
	PTY_OWNER_HELPER,
	PTY_PROBE_HELPER,
	ensurePtyRuntime,
	forgetProvedPtyRuntimes,
	type PtyRuntimeOptions,
	type PtyRuntimeReadiness,
	type SelfCheckResult,
} from "./pty-runtime.ts";
import { PtyBrokerClient } from "./pty-client.ts";
import { PtyRuntimeProof } from "./pty-runtime-proof.ts";
import { PTY_PROOF_DIRECTORY, type PtySelfCheckAnswer } from "./pty-runtime-proof-store.ts";
import { PTY_PROTOCOL_VERSION, PTY_RECORD_VERSION, PTY_RUNTIME_VERSION, PTY_SERVICE, createPtyGeneration, createPtyToken } from "./pty-protocol.ts";
import type { PtyBrokerRecord } from "./pty-protocol.ts";
import { ptyRecordPath } from "./pty-registry.ts";

const WINDOWS_ONLY = process.platform !== "win32" ? "the runtime proof is Windows-only" : false;
const ACCOUNT = "WORKSTATION\\dev";
const OWNER_ONLY = [ACCOUNT, "NT AUTHORITY\\SYSTEM", "BUILTIN\\Administrators"];

const roots: string[] = [];

after(async () => {
	for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function temp(name: string): Promise<string> {
	const root = await mkdtemp(path.join(tmpdir(), name));
	roots.push(root);
	return root;
}

function ownerOnlyProbe(): PrivateStorageProbe {
	return {
		platform: "win32",
		currentSid: TEST_CURRENT_SID,
		readAcl: async (): Promise<PrivateStorageCommandResult> => ({
			ok: true,
			stdout: fixtureAcl(OWNER_ONLY.map(principal => `${principal}:(OI)(CI)(F)`)),
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

async function packagedTree(entry = "// entry"): Promise<string> {
	const root = await temp("omp-proof-tree-");
	const directory = path.join(root, "out", "pty");
	await mkdir(directory, { recursive: true });
	await writeFile(path.join(directory, PTY_BROKER_ENTRY), entry, "utf8");
	await writeFile(path.join(directory, PTY_PROBE_HELPER), "# probe", "utf8");
	await writeFile(path.join(directory, PTY_OWNER_HELPER), "# owner watch", "utf8");
	return root;
}

const ANSWER: PtySelfCheckAnswer = {
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
	durationMs: 4321,
};

interface Window {
	/** One call of `ensurePtyRuntime` in a window that has just started. */
	ensure(overrides?: Partial<PtyRuntimeOptions>): Promise<PtyRuntimeReadiness>;
	readonly runs: { count: number };
}

/** A storage directory shared by every "window" opened on it, with a self-check that counts its runs. */
function sharedStorage(
	storageDir: string,
	extensionRoot: string,
	verdict: SelfCheckResult = { kind: "proven", answer: ANSWER, detail: "the runtime proved itself" },
): Window {
	const runs = { count: 0 };
	return {
		runs,
		ensure: overrides => {
			forgetProvedPtyRuntimes();
			return ensurePtyRuntime({
				storageDir,
				extensionRoot,
				nodePath: process.execPath,
				access: ownerOnlyProbe(),
				runSelfCheck: async () => {
					runs.count += 1;
					return verdict;
				},
				...overrides,
			});
		},
	};
}

async function proofFiles(storageDir: string): Promise<string[]> {
	return await readdir(path.join(storageDir, "runtime", PTY_PROOF_DIRECTORY)).catch(() => []);
}

describe("a stored runtime proof", { skip: WINDOWS_ONLY }, () => {
	it("is reused by the next window and reload: the self-check does not run again", async () => {
		const storage = await temp("omp-proof-storage-");
		const window = sharedStorage(storage, await packagedTree());
		const first = await window.ensure();
		assert.equal(first.ready && first.proven, true, first.reason ?? "");
		assert.equal(first.reusedProof, undefined, "the first window computed its proof");
		assert.equal(window.runs.count, 1);

		const second = await window.ensure();
		assert.equal(second.ready && second.proven, true, second.reason ?? "");
		assert.equal(window.runs.count, 1, "a matching key skips the self-check");
		assert.match(second.reusedProof?.provedAt ?? "", /^\d{4}-\d\d-\d\dT/);
		assert.deepEqual(second.runtime?.selfCheck, ANSWER, "what the first window observed is what the reuse reports");
		assert.equal(second.treeDigest, first.treeDigest);
		assert.equal((await window.ensure()).reusedProof !== undefined, true);
		assert.equal(window.runs.count, 1);
	});

	it("is ignored when the staged tree changed", async () => {
		const storage = await temp("omp-proof-storage-");
		const before = sharedStorage(storage, await packagedTree("// build one"));
		await before.ensure();
		const after = sharedStorage(storage, await packagedTree("// build two"));
		const readiness = await after.ensure();
		assert.equal(readiness.ready && readiness.proven, true, readiness.reason ?? "");
		assert.equal(after.runs.count, 1, "another build's bytes are another key");
		assert.equal(readiness.reusedProof, undefined);
		assert.equal((await proofFiles(storage)).length, 2, "both builds keep their own proof");
	});

	it("is ignored when the executable that runs the broker differs, or was replaced in place", async () => {
		const storage = await temp("omp-proof-storage-");
		const root = await packagedTree();
		const exeDir = await temp("omp-proof-exe-");
		const exe = path.join(exeDir, "node-a.exe");
		await copyFile(process.execPath, exe);
		const window = sharedStorage(storage, root);
		await window.ensure({ nodePath: exe });
		assert.equal(window.runs.count, 1);
		await window.ensure({ nodePath: exe });
		assert.equal(window.runs.count, 1, "the same executable reuses it");

		const other = path.join(exeDir, "node-b.exe");
		await copyFile(process.execPath, other);
		await window.ensure({ nodePath: other });
		assert.equal(window.runs.count, 2, "another path is another executable");

		// Replaced in place: same path, different bytes (a VS Code or node update).
		await writeFile(exe, Buffer.concat([await readFile(exe), Buffer.from("updated")]));
		await window.ensure({ nodePath: exe });
		assert.equal(window.runs.count, 3, "a changed size or modification time is a changed executable");
	});

	it("is ignored when its file is corrupt, and the next proof replaces it", async () => {
		const storage = await temp("omp-proof-storage-");
		const window = sharedStorage(storage, await packagedTree());
		await window.ensure();
		const [name] = await proofFiles(storage);
		assert.ok(name);
		const file = path.join(storage, "runtime", PTY_PROOF_DIRECTORY, name);

		for (const damage of ["{ not json", "[]", "", "x".repeat(64 * 1024)]) {
			await writeFile(file, damage, "utf8");
			const before = window.runs.count;
			const readiness = await window.ensure();
			assert.equal(readiness.ready && readiness.proven, true, readiness.reason ?? "");
			assert.equal(window.runs.count, before + 1, `a file holding ${JSON.stringify(damage.slice(0, 12))} is a miss`);
		}
		const healed = window.runs.count;
		assert.equal((await window.ensure()).reusedProof !== undefined, true, "the replacement is a valid proof");
		assert.equal(window.runs.count, healed);
	});

	it("is ignored when the file names another key, carries a future time, or a malformed answer", async () => {
		const storage = await temp("omp-proof-storage-");
		const window = sharedStorage(storage, await packagedTree());
		await window.ensure();
		const [name] = await proofFiles(storage);
		const file = path.join(storage, "runtime", PTY_PROOF_DIRECTORY, name!);
		const good = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown> & { key: Record<string, unknown> };

		const variants: Record<string, unknown>[] = [
			{ ...good, key: { ...good.key, osRelease: "0.0.1" } },
			{ ...good, provedAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() },
			{ ...good, provedAt: "yesterday-ish" },
			{ ...good, selfCheck: { ...(good.selfCheck as object), childOutput: false } },
			{ ...good, format: 2 },
		];
		for (const variant of variants) {
			await writeFile(file, JSON.stringify(variant), "utf8");
			const before = window.runs.count;
			await window.ensure();
			assert.equal(window.runs.count, before + 1, `rejected: ${JSON.stringify(variant).slice(0, 80)}`);
		}
	});

	it("is never written for a provisional admission, so the next window checks again", async () => {
		const storage = await temp("omp-proof-storage-");
		const window = sharedStorage(storage, await packagedTree(), {
			kind: "inconclusive",
			answer: null,
			detail: "the pipe child did not finish within the self-check deadline of 15 s",
		});
		const first = await window.ensure();
		assert.equal(first.ready, true);
		assert.equal(first.proven, false, "admitted unproven");
		assert.deepEqual(await proofFiles(storage), [], "nothing is stored for an unproven admission");
		const second = await window.ensure();
		assert.equal(second.proven, false);
		assert.equal(window.runs.count, 2, "the second window ran its own check");
	});

	it("is never written for a refused runtime", async () => {
		const storage = await temp("omp-proof-storage-");
		const window = sharedStorage(storage, await packagedTree(), {
			kind: "broken",
			answer: null,
			detail: "the runtime self-check failed with exit code 7",
		});
		const readiness = await window.ensure();
		assert.equal(readiness.ready, false);
		assert.deepEqual(await proofFiles(storage), []);
	});

	it("does not skip the staging pass: a reuse still re-verifies the staged copies", async () => {
		const storage = await temp("omp-proof-storage-");
		const window = sharedStorage(storage, await packagedTree());
		const first = await window.ensure();
		const entry = first.runtime?.entry.path;
		assert.ok(entry);
		// A staged copy that no longer holds its bytes is rewritten by staging, so the reuse still hands out intact code.
		await writeFile(entry, "// tampered", "utf8");
		const second = await window.ensure();
		assert.equal(second.reusedProof !== undefined, true);
		assert.equal(await readFile(entry, "utf8"), "// entry");
		assert.equal(window.runs.count, 1);
	});
});

describe("a stored runtime proof that goes stale", { skip: WINDOWS_ONLY }, () => {
	const DAY_MS = 24 * 60 * 60 * 1000;

	it("is not believed after a day, and the check that replaces it is stored for the next day", async () => {
		const storage = await temp("omp-proof-storage-");
		const window = sharedStorage(storage, await packagedTree());
		await window.ensure();
		await window.ensure({ now: () => Date.now() + DAY_MS - 60_000 });
		assert.equal(window.runs.count, 1, "a proof just under a day old is still reused");

		const aged = await window.ensure({ now: () => Date.now() + DAY_MS + 60_000 });
		assert.equal(aged.ready && aged.proven, true, aged.reason ?? "");
		assert.equal(window.runs.count, 2, "a proof older than a day is checked again");
		assert.equal(aged.reusedProof, undefined);
		await window.ensure({ now: () => Date.now() + DAY_MS + 120_000 });
		assert.equal(window.runs.count, 2, "the fresh proof is what the next window reuses");
	});

	it("is withdrawn when the launch that relied on it fails before a broker exists, so the next launch diagnoses the runtime", async () => {
		const storage = await temp("omp-proof-storage-");
		// A tree whose entry dies at once: what a policy or an update that broke the console spawn looks like to a launch.
		const root = await packagedTree("process.exit(1);");
		const first = sharedStorage(storage, root);
		await first.ensure();
		assert.equal((await proofFiles(storage)).length, 1, "an earlier window stored its proof");

		forgetProvedPtyRuntimes();
		const events: LoggedLine[] = [];
		const client = new PtyBrokerClient({ storageDir: storage, extensionRoot: root, nodePath: process.execPath, access: ownerOnlyProbe(), log: recordingLogger(events) });
		const launch = (slot: string) => client.launch({ slot, kind: "managed-omp", file: process.execPath, args: [], cwd: tmpdir() });

		const failed = await launch("tab:heal-1");
		assert.equal(failed.state, "not-started");
		assert.match(failed.reason, /the broker exited with code 1/);
		assert.match(failed.reason, /proof stored by an earlier window was discarded/);
		assert.deepEqual(await proofFiles(storage), [], "the stored proof is gone");
		assert.ok(events.some(event => /reused from .* withdrawn/.test(event.message)), events.map(event => event.message).join("\n"));

		// The next launch no longer trusts anything it did not check: the self-check itself runs against the dead entry.
		const next = await launch("tab:heal-2");
		assert.equal(next.state, "not-started");
		assert.doesNotMatch(next.reason, /the broker exited with code/, "the refusal comes from the self-check, not from another broker spawn");
		assert.doesNotMatch(next.reason, /discarded/);
		assert.deepEqual(await proofFiles(storage), [], "a refused runtime is not stored");
	});

	it("keeps a proof this window computed itself when a launch fails", async () => {
		const storage = await temp("omp-proof-storage-");
		const root = await packagedTree("process.exit(1);");
		const window = sharedStorage(storage, root);
		const proof = new PtyRuntimeProof({ probe: async () => await window.ensure() });
		assert.equal((await proof.ready()).proven, true);
		assert.equal(proof.discardReusedProof(), null, "nothing here was reused");
		assert.equal(proof.provenAnswer() !== null, true);
		assert.equal((await proofFiles(storage)).length, 1);
	});

	describe("when the broker publishes its record and then ends", () => {
		/** A broker entry that claims its slot with a record nobody can attach to, then ends after `lifetimeMs`. */
		function recordThenEnd(storage: string, slot: string, lifetimeMs: number): string {
			const record: PtyBrokerRecord = {
				version: PTY_RECORD_VERSION,
				service: PTY_SERVICE,
				protocolVersion: PTY_PROTOCOL_VERSION,
				runtimeVersion: PTY_RUNTIME_VERSION,
				treeDigest: "a".repeat(64),
				brokerId: "pty-22222222-2222-4222-8222-222222222222",
				generation: createPtyGeneration(),
				slot,
				kind: "managed-omp",
				port: 1,
				token: createPtyToken(),
				brokerPid: process.pid,
				brokerCreationTime: "133700000000000000",
				startedAt: new Date(0).toISOString(),
				cols: 80,
				rows: 24,
				title: null,
			};
			const file = ptyRecordPath(storage, slot);
			return [
				'const { mkdirSync, writeFileSync } = require("node:fs");',
				'const { dirname } = require("node:path");',
				`mkdirSync(dirname(${JSON.stringify(file)}), { recursive: true });`,
				`writeFileSync(${JSON.stringify(file)}, ${JSON.stringify(JSON.stringify(record))});`,
				`setTimeout(() => process.exit(1), ${lifetimeMs});`,
			].join("\n");
		}

		async function launchOnReusedProof(entryFor: (storage: string, slot: string) => string, slot: string) {
			const storage = await temp("omp-proof-storage-");
			const root = await packagedTree(entryFor(storage, slot));
			await sharedStorage(storage, root).ensure();
			forgetProvedPtyRuntimes();
			const client = new PtyBrokerClient({ storageDir: storage, extensionRoot: root, nodePath: process.execPath, access: ownerOnlyProbe() });
			const outcome = await client.launch({ slot, kind: "managed-omp", file: process.execPath, args: [], cwd: tmpdir() });
			return { storage, outcome };
		}

		it("withdraws a reused proof: a broker that claimed its slot and died could not run", async () => {
			const { storage, outcome } = await launchOnReusedProof((dir, slot) => recordThenEnd(dir, slot, 150), "tab:heal-r1");
			assert.equal(outcome.state, "unconfirmed");
			assert.match(outcome.reason, /could not be attached/);
			assert.match(outcome.reason, /proof stored by an earlier window was discarded/);
			assert.deepEqual(await proofFiles(storage), []);
		});

		it("keeps the proof while that broker is still running: it only answered slowly", async () => {
			const { storage, outcome } = await launchOnReusedProof((dir, slot) => recordThenEnd(dir, slot, 15_000), "tab:heal-r2");
			assert.equal(outcome.state, "unconfirmed");
			assert.doesNotMatch(outcome.reason, /discarded/);
			assert.equal((await proofFiles(storage)).length, 1);
		});
	});
});
