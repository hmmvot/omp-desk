/**
 * One self-check of the PTY runtime for all windows at once (ADR-0032, amendment 2026-10-28).
 *
 * What a window notices: how many checks ran, and where its own answer came from. The first group runs the flight over a temporary
 * storage directory with a fake check; the second runs `ensurePtyRuntime` with the real staging, the real proof store and the real
 * lock files and replaces only the self-check child (the `runSelfCheck` seam) and the access probe, as the stored-proof tests do.
 * "Windows" are concurrent calls on one storage directory. They share this test's process id, which is alive, and that is the case
 * that has to wait.
 *
 * Nothing here waits for a guessed time: a check ends when the test opens its gate, and the test opens the gate only once every other
 * window has been seen to pause behind the lock (the `sleep` seam of the flight records that). The wait limit runs on a fake clock
 * that advances by what the flight asks to sleep.
 *
 * Runner: `node --test src/host/pty-proof-flight.test.ts`
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { PTY_BROKER_ENTRY, PTY_OWNER_HELPER, discardReusedPtyProof, ensurePtyRuntime, forgetProvedPtyRuntimes, type PtyRuntimeOptions, type PtyRuntimeReadiness, type ReusedPtyProof, type SelfCheckResult } from "./pty-runtime.ts";
import { PTY_FLIGHT_DIRECTORY, ptyFlightDirectory, singleFlight, type PtyFlightAttempt, type PtyFlightOptions, type PtyFlightResult } from "./pty-proof-flight.ts";
import { PTY_PROOF_DIRECTORY, type PtySelfCheckAnswer } from "./pty-runtime-proof-store.ts";
import type { PrivateStorageCommandResult, PrivateStorageProbe } from "./private-storage.ts";
import { TEST_CURRENT_SID, fixtureAcl, fixturePrincipal } from "./private-storage-test-support.ts";

const roots: string[] = [];

after(async () => {
	for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function temp(name: string): Promise<string> {
	const root = await mkdtemp(path.join(tmpdir(), name));
	roots.push(root);
	return root;
}

/** Turns of the event loop until `condition` holds: the file operations of the other windows finish in between. */
async function until(condition: () => boolean, what: string): Promise<void> {
	for (let turns = 0; turns < 200_000; turns += 1) {
		if (condition()) return;
		await yieldTurn();
	}
	throw new Error(`never happened: ${what}`);
}

/** A gate the test opens when the windows it wants have been seen to wait. */
function gate(): { readonly open: () => void; readonly opened: Promise<void> } {
	const { promise, resolve } = Promise.withResolvers<void>();
	return { open: resolve, opened: promise };
}

/**
 * The pacing the flights of one test share: a fake clock (starting at the real time, so the lock files the tests write by hand
 * agree with it) that advances by what a flight asks to sleep, and the windows that have paused behind a lock.
 */
interface Pacing {
	readonly clock: { now: number };
	/** The windows that have paused behind a lock. */
	readonly paused: Set<string>;
	/** The flight options of one window. */
	readonly of: (id: string, extra?: PtyFlightOptions) => PtyFlightOptions;
}

function pacing(waitMs = 1_000_000_000): Pacing {
	const clock = { now: Date.now() };
	const paused = new Set<string>();
	return {
		clock,
		paused,
		of: (id, extra = {}) => ({
			pollMs: 10,
			waitMs,
			holderId: `holder-${id}`,
			now: () => clock.now,
			sleep: async ms => {
				paused.add(id);
				clock.now += ms;
				await yieldTurn();
			},
			...extra,
		}),
	};
}

interface Harness {
	readonly storage: string;
	readonly pace: Pacing;
	/** The first proof any attempt stored: what the proof store would hold. */
	readonly proofs: { stored: string | null };
	/** The windows whose check ran, in order. */
	readonly attempts: string[];
	window(input: { readonly id: string; readonly name?: string; readonly kind?: PtyFlightAttempt["kind"]; readonly deadlineMs?: number; readonly gate?: Promise<void>; readonly options?: PtyFlightOptions }): Promise<PtyFlightResult<string, PtyFlightAttempt>>;
}

async function harness(waitMs?: number): Promise<Harness> {
	const storage = await temp("omp-flight-");
	const pace = pacing(waitMs);
	const proofs: { stored: string | null } = { stored: null };
	const attempts: string[] = [];
	return {
		storage,
		pace,
		proofs,
		attempts,
		window: async ({ id, name = "key-a", kind = "proven", deadlineMs = 15_000, gate: held, options }) =>
			await singleFlight<string, PtyFlightAttempt>({
				storageDir: storage,
				name,
				deadlineMs,
				maxRunMs: 60_000,
				readStored: async () => proofs.stored,
				attempt: async () => {
					attempts.push(id);
					await held;
					if (kind === "proven") proofs.stored = `proof-of-${id}`;
					return { kind, detail: `${kind} by ${id}` };
				},
				options: pace.of(id, options),
			}),
	};
}

describe("the cross-window single-flight of a self-check", () => {
	it("runs one check for windows that ask at the same time, and the others take its stored proof", async () => {
		const h = await harness();
		const release = gate();
		const ids = ["w1", "w2", "w3", "w4", "w5"];
		const windows = ids.map(id => h.window({ id, gate: release.opened }));
		await until(() => h.attempts.length === 1 && h.pace.paused.size === 4, "four windows paused behind the one that checks");
		release.open();
		const results = await Promise.all(windows);
		assert.equal(h.attempts.length, 1, `one check ran, not ${h.attempts.join(", ")}`);
		assert.deepEqual(results.map(result => result.via).sort(), ["owner", "stored", "stored", "stored", "stored"]);
		for (const result of results) if (result.via === "stored") assert.equal(result.stored, `proof-of-${h.attempts[0]}`);
		assert.deepEqual(await readdir(ptyFlightDirectory(h.storage)), [], "no lock or temporary file is left behind after a proof");
	});

	it("does not touch the disk for a proof that is already stored", async () => {
		const h = await harness();
		h.proofs.stored = "earlier";
		const result = await h.window({ id: "w1" });
		assert.equal(result.via, "stored");
		assert.equal(h.attempts.length, 0);
		await assert.rejects(readdir(ptyFlightDirectory(h.storage)), "not even the directory is created");
	});

	it("keys the flight by the exact inputs: a different key never waits for another's check", async () => {
		const h = await harness();
		const release = gate();
		const a = h.window({ id: "a", name: "key-a", gate: release.opened });
		const b = h.window({ id: "b", name: "key-b", gate: release.opened });
		await until(() => h.attempts.length === 2, "both checks running at the same time");
		assert.equal(h.pace.paused.size, 0, "neither window paused");
		release.open();
		assert.deepEqual((await Promise.all([a, b])).map(result => result.via), ["owner", "owner"]);
	});

	it("takes over the lock of a holder that is gone, a lock past its time and an unreadable lock", async () => {
		const unix = Date.now();
		for (const [label, content] of [
			["a dead holder", { format: 1, holderId: "holder-dead", pid: 2147483000, expiresAt: unix + 600_000 }],
			["a lock past its time (its process id is alive, and may be reused or hung)", { format: 1, holderId: "holder-hung", pid: process.pid, expiresAt: unix - 1 }],
			["an unreadable lock", "{ not json"],
		] as const) {
			const h = await harness();
			await mkdir(ptyFlightDirectory(h.storage), { recursive: true });
			await writeFile(path.join(ptyFlightDirectory(h.storage), "key-a.lock"), typeof content === "string" ? content : JSON.stringify(content));
			const result = await h.window({ id: "w1", options: { now: Date.now, isHolderAlive: pid => pid === process.pid } });
			assert.equal(result.via, "owner", label);
			assert.equal(h.attempts.length, 1, label);
			assert.equal(h.pace.paused.size, 0, `${label}: nothing was waited for`);
		}
	});

	it("waits for a live holder, then takes its proof", async () => {
		const h = await harness();
		await mkdir(ptyFlightDirectory(h.storage), { recursive: true });
		await writeFile(path.join(ptyFlightDirectory(h.storage), "key-a.lock"), JSON.stringify({ format: 1, holderId: "holder-live", pid: process.pid, expiresAt: h.pace.clock.now + 60_000 }));
		const waiting = h.window({ id: "w1" });
		await until(() => h.pace.paused.has("w1"), "the window paused behind the live holder");
		h.proofs.stored = "the live holder's proof";
		const result = await waiting;
		assert.equal(result.via, "stored");
		assert.ok(result.waitedMs > 0);
		assert.equal(h.attempts.length, 0);
	});

	it("runs its own check without the lock when the wait runs out, and leaves the other window's lock alone", async () => {
		const h = await harness(100);
		await mkdir(ptyFlightDirectory(h.storage), { recursive: true });
		const lock = path.join(ptyFlightDirectory(h.storage), "key-a.lock");
		const held = JSON.stringify({ format: 1, holderId: "holder-live", pid: process.pid, expiresAt: h.pace.clock.now + 60_000 });
		await writeFile(lock, held);
		const result = await h.window({ id: "w1" });
		assert.equal(result.via, "local");
		assert.ok(result.waitedMs >= 100);
		assert.match(result.via === "local" ? result.why : "", /did not finish within 100 ms/);
		assert.equal(h.attempts.length, 1);
		assert.equal(await readFile(lock, "utf8"), held);
	});

	it("runs its own check when the lock directory cannot be used at all", async () => {
		const h = await harness();
		// A file where the directory must be.
		await mkdir(path.join(h.storage, "runtime"), { recursive: true });
		await writeFile(ptyFlightDirectory(h.storage), "not a directory");
		const result = await h.window({ id: "w1" });
		assert.equal(result.via, "local");
		assert.equal(h.attempts.length, 1);
	});

	it("never removes a lock entry it cannot read as a file: it waits for the holder, and past the wait runs its own check", async () => {
		const h = await harness(60);
		const lock = path.join(ptyFlightDirectory(h.storage), "key-a.lock");
		await mkdir(lock, { recursive: true });
		const result = await h.window({ id: "w1" });
		assert.equal(result.via, "local");
		assert.equal(h.attempts.length, 1);
		assert.ok((await stat(lock)).isDirectory(), "the entry is untouched");
	});

	it("lets go of the lock when the check throws, so the next window is not held up", async () => {
		const h = await harness();
		await assert.rejects(
			singleFlight<string, PtyFlightAttempt>({
				storageDir: h.storage,
				name: "key-a",
				deadlineMs: 15_000,
				maxRunMs: 60_000,
				readStored: async () => null,
				attempt: async () => {
					throw new Error("the check could not start");
				},
				options: h.pace.of("thrower"),
			}),
			/could not start/,
		);
		const next = await h.window({ id: "w2" });
		assert.equal(next.via, "owner", "the lock was released");
		assert.equal(h.pace.paused.size, 0);
	});

	describe("a check that ends without a proof", () => {
		for (const kind of ["inconclusive", "broken"] as const) {
			it(`is shared with the windows that waited for it (${kind}), never as a stored proof, and costs a later window its own check`, async () => {
				const h = await harness();
				const release = gate();
				const windows = ["w1", "w2", "w3", "w4"].map(id => h.window({ id, kind, gate: release.opened }));
				await until(() => h.attempts.length === 1 && h.pace.paused.size === 3, "three windows paused behind the one that checks");
				release.open();
				const results = await Promise.all(windows);
				assert.equal(h.attempts.length, 1, "the windows that waited did not repeat a check that ended like that");
				assert.deepEqual(results.map(result => result.via).sort(), ["owner", "shared", "shared", "shared"]);
				for (const result of results) {
					if (result.via === "shared") assert.deepEqual(result.outcome, { kind, detail: `${kind} by ${h.attempts[0]}` });
				}
				assert.equal(h.proofs.stored, null, "a failure is never kept as a proof");
				// A window that comes after the attempt ended has not waited for it: it checks for itself and gets its own answer.
				const later = await h.window({ id: "w5", kind });
				assert.equal(later.via, "owner");
				assert.equal(h.attempts.length, 2);
			});
		}

		it("is not taken by a window that asked for a longer deadline than the check had", async () => {
			const h = await harness();
			const release = gate();
			const first = h.window({ id: "short", kind: "inconclusive", deadlineMs: 15_000, gate: release.opened });
			await until(() => h.attempts.length === 1, "the short check running");
			const longer = h.window({ id: "long", kind: "proven", deadlineMs: 90_000 });
			await until(() => h.pace.paused.has("long"), "the longer window paused behind it");
			release.open();
			const [a, b] = await Promise.all([first, longer]);
			assert.equal(a.via, "owner");
			assert.equal(b.via, "owner", "the extended re-check runs, after the shorter one ended");
			assert.deepEqual(h.attempts, ["short", "long"]);
		});

		it("is not read by a window that did not wait for it, and a success after it wins for everyone", async () => {
			const h = await harness();
			assert.equal((await h.window({ id: "w1", kind: "inconclusive" })).via, "owner");
			assert.equal((await h.window({ id: "w2", kind: "proven" })).via, "owner", "the earlier outcome was not taken");
			assert.equal((await h.window({ id: "w3" })).via, "stored");
			assert.deepEqual(h.attempts, ["w1", "w2"]);
		});
	});
});

// The same, through the real staging, the real proof store and the real lock files.

const WINDOWS_ONLY = process.platform !== "win32" ? "the runtime proof is Windows-only" : false;
const ACCOUNT = "WORKSTATION\\dev";
const OWNER_ONLY = [ACCOUNT, "NT AUTHORITY\\SYSTEM", "BUILTIN\\Administrators"];

function ownerOnlyProbe(): PrivateStorageProbe {
	return {
		platform: "win32",
		currentSid: TEST_CURRENT_SID,
		readAcl: async (): Promise<PrivateStorageCommandResult> => ({ ok: true, stdout: fixtureAcl(OWNER_ONLY.map(principal => `${principal}:(OI)(CI)(F)`)), detail: null }),
		applyIcacls: async (): Promise<PrivateStorageCommandResult> => ({ ok: true, stdout: "", detail: null }),
		readOwners: async (paths: readonly string[]): Promise<PrivateStorageCommandResult> => ({
			ok: true,
			stdout: paths.map(target => `${target}|${fixturePrincipal(ACCOUNT)}`).join("\r\n"),
			detail: null,
		}),
	};
}

async function packagedTree(entry = "// entry"): Promise<string> {
	const root = await temp("omp-flight-tree-");
	const directory = path.join(root, "out", "pty");
	await mkdir(directory, { recursive: true });
	await writeFile(path.join(directory, PTY_BROKER_ENTRY), entry, "utf8");
	await mkdir(path.join(root, "out", "native"), { recursive: true });
	await writeFile(path.join(root, "out", "native", "koffi.node"), "native", "utf8");
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

describe("ensurePtyRuntime in windows that start together", { skip: WINDOWS_ONLY }, () => {
	interface Fleet {
		readonly storage: string;
		readonly root: string;
		readonly pace: Pacing;
		/** The self-checks that started, and the most that were running at the same moment. */
		readonly runs: { count: number; running: number; peak: number };
		/** One window's `ensurePtyRuntime`; `check` is what its self-check child ends with. */
		ensure(id: string, check: () => Promise<SelfCheckResult>, overrides?: Partial<PtyRuntimeOptions> & { readonly flightWaitMs?: number }): Promise<PtyRuntimeReadiness>;
	}

	async function fleet(waitMs?: number): Promise<Fleet> {
		const storage = await temp("omp-flight-storage-");
		const root = await packagedTree();
		const pace = pacing(waitMs);
		const runs = { count: 0, running: 0, peak: 0 };
		return {
			storage,
			root,
			pace,
			runs,
			ensure: async (id, check, overrides = {}) => {
				forgetProvedPtyRuntimes();
				return await ensurePtyRuntime({
					storageDir: storage,
					extensionRoot: root,
					nodePath: process.execPath,
					access: ownerOnlyProbe(),
					flight: pace.of(id),
					runSelfCheck: async () => {
						runs.count += 1;
						runs.running += 1;
						runs.peak = Math.max(runs.peak, runs.running);
						try {
							return await check();
						} finally {
							runs.running -= 1;
						}
					},
					...overrides,
				});
			},
		};
	}

	const proves = (held?: Promise<void>) => async (): Promise<SelfCheckResult> => {
		await held;
		return { kind: "proven", answer: ANSWER, detail: "the runtime proved itself" };
	};
	const slow = (held?: Promise<void>) => async (): Promise<SelfCheckResult> => {
		await held;
		return { kind: "inconclusive", answer: null, detail: "the pipe child did not finish within the self-check deadline of 15 s" };
	};

	it("five windows run one self-check; the other four reuse its stored proof and say so", async () => {
		const f = await fleet();
		const release = gate();
		const windows = [1, 2, 3, 4, 5].map(index => f.ensure(`w${index}`, proves(release.opened)));
		await until(() => f.runs.count === 1 && f.pace.paused.size === 4, "four windows paused behind the one that checks");
		release.open();
		const answers = await Promise.all(windows);
		assert.equal(f.runs.count, 1);
		assert.equal(f.runs.peak, 1);
		assert.ok(answers.every(answer => answer.ready && answer.proven));
		const reused = answers.filter(answer => answer.reusedProof !== undefined);
		assert.equal(reused.length, 4, "the windows that waited took the owner's proof");
		for (const answer of reused) assert.equal(answer.flight?.via, "stored");
		assert.equal(answers.filter(answer => answer.reusedProof === undefined).length, 1);
		assert.equal((await readdir(path.join(f.storage, "runtime", PTY_PROOF_DIRECTORY))).length, 1, "one proof file");
		assert.deepEqual(await readdir(path.join(f.storage, "runtime", PTY_FLIGHT_DIRECTORY)), [], "nothing is left of the flight");
	});

	it("a window that starts after the proof was stored does not wait and runs no check", async () => {
		const f = await fleet();
		await f.ensure("w1", proves());
		const later = await f.ensure("w2", proves());
		assert.equal(f.runs.count, 1);
		assert.equal(later.reusedProof !== undefined, true);
		assert.equal(later.flight, undefined, "nothing was waited for");
		assert.equal(f.pace.paused.size, 0);
	});

	it("a key that changed (another tree) is a separate check: it runs at the same time as the first", async () => {
		const f = await fleet();
		const otherRoot = await packagedTree("// another entry");
		const release = gate();
		const first = f.ensure("w1", proves(release.opened));
		const second = f.ensure("w2", proves(release.opened), { extensionRoot: otherRoot });
		await until(() => f.runs.peak === 2, "both trees being checked at the same time");
		assert.equal(f.pace.paused.size, 0, "the second tree did not wait for the first");
		release.open();
		const [a, b] = await Promise.all([first, second]);
		assert.ok(a.proven && b.proven);
		assert.notEqual(a.treeDigest, b.treeDigest);
		assert.equal(f.runs.count, 2);
	});

	it("a check that ran out of time is shared as an unproven admission and is never stored as a proof", async () => {
		const f = await fleet();
		const release = gate();
		const windows = [1, 2, 3, 4].map(index => f.ensure(`w${index}`, slow(release.opened)));
		await until(() => f.runs.count === 1 && f.pace.paused.size === 3, "three windows paused behind the one that checks");
		release.open();
		const answers = await Promise.all(windows);
		assert.equal(f.runs.count, 1, "the windows that waited did not run a check that ended like that");
		assert.ok(answers.every(answer => answer.ready && !answer.proven), "every window is admitted unproven, none is told it is proven");
		assert.equal(answers.filter(answer => answer.flight?.via === "shared").length, 3);
		for (const answer of answers) assert.match(answer.reason ?? "", /did not finish within the self-check deadline of 15 s/);
		assert.deepEqual(await readdir(path.join(f.storage, "runtime", PTY_PROOF_DIRECTORY)).catch(() => []), [], "no proof file");
		// The extended re-check of one of them runs by itself, with the longer deadline, and proves the tree for all.
		const settled = await f.ensure("w1", proves(), { selfCheckDeadlineMs: 90_000 });
		assert.ok(settled.proven);
		assert.equal(f.runs.count, 2);
	});

	it("a refusal is shared only with the windows that waited for it, and is not stored", async () => {
		const f = await fleet();
		const release = gate();
		const broken = async (): Promise<SelfCheckResult> => {
			await release.opened;
			return { kind: "broken", answer: null, detail: "the runtime self-check failed with exit code 7" };
		};
		const windows = [1, 2, 3].map(index => f.ensure(`w${index}`, broken));
		await until(() => f.runs.count === 1 && f.pace.paused.size === 2, "two windows paused behind the one that checks");
		release.open();
		const answers = await Promise.all(windows);
		assert.equal(f.runs.count, 1);
		assert.ok(answers.every(answer => !answer.ready && /exit code 7/.test(answer.reason ?? "")));
		assert.deepEqual(await readdir(path.join(f.storage, "runtime", PTY_PROOF_DIRECTORY)).catch(() => []), []);
		const fixed = await f.ensure("w4", proves());
		assert.ok(fixed.proven, "a later window checks for itself and is not told the old refusal");
	});

	it("a window whose wait ran out runs its own check, once, and says why", async () => {
		const f = await fleet(100);
		const release = gate();
		const owner = f.ensure("owner", proves(release.opened), { flight: f.pace.of("owner", { waitMs: 1_000_000_000 }) });
		await until(() => f.runs.count === 1, "the owner's check running");
		const impatient = await f.ensure("impatient", proves());
		assert.equal(impatient.flight?.via, "local");
		assert.ok(impatient.proven);
		assert.equal(f.runs.count, 2, "the impatient window did not wait for the whole check");
		release.open();
		assert.ok((await owner).proven);
	});

	it("a proof taken from the store stays withdrawable by whoever finds it already in this process (a warm-up read it, a launch relies on it)", async () => {
		const f = await fleet();
		await f.ensure("w1", proves());
		forgetProvedPtyRuntimes();
		const warmUp = await ensurePtyRuntime({ storageDir: f.storage, extensionRoot: f.root, nodePath: process.execPath, access: ownerOnlyProbe(), flight: f.pace.of("warm-up") });
		assert.ok(warmUp.proven && warmUp.reusedProof !== undefined, "the warm-up reused the stored proof");
		const launch = await ensurePtyRuntime({ storageDir: f.storage, extensionRoot: f.root, nodePath: process.execPath, access: ownerOnlyProbe(), flight: f.pace.of("launch") });
		assert.equal(launch.reusedProof?.file, warmUp.reusedProof.file, "the in-process answer names the stored file it came from");
		assert.equal(launch.reusedProof?.provedAt, warmUp.reusedProof.provedAt);
		await discardReusedPtyProof(launch.reusedProof as ReusedPtyProof);
		assert.deepEqual(await readdir(path.join(f.storage, "runtime", PTY_PROOF_DIRECTORY)), [], "the stored proof is gone");
		const next = await f.ensure("w2", proves());
		assert.equal(next.reusedProof, undefined, "the next window checks again");
		assert.equal(f.runs.count, 2);
	});
});
