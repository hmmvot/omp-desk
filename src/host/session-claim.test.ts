/**
 * Tests for the atomic session-claim module.
 *
 * Two concurrent `acquireClaim` calls in one process model two VS Code windows:
 * exclusion is enforced by the filesystem, not by in-process state.
 *
 * Runner: `node:test` with Node's native type stripping (no test-runner
 * dependency). Run with `node --test src/host/session-claim.test.ts` (what
 * `npm test` discovers) or `bun test src/host/session-claim.test.ts`.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, symlinkSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, before, describe, it, mock } from "node:test";
import {
	ClaimBusyError,
	ClaimConflictError,
	ClaimHolderError,
	ClaimOwnershipError,
	acquireClaim,
	claimHolderMayBeAlive,
	claimHolderProvablyGone,
	claimHolderSeemsAlive,
	claimMutexPath,
	claimPathFor,
	createClaimHolder,
	createDraftIdentity,
	createOwnerGeneration,
	listClaims,
	normalizeClaimIdentity,
	promoteDraftClaim,
	readClaim,
	readProcessCreationTime,
	removeClaimOfGoneHolder,
	setProcessProbeObserver,
	type ClaimHolder,
	type ProcessProbe,
	type SessionClaim,
} from "./session-claim.ts";
import { shortDirectoryAlias } from "./short-name-test-support.ts";
import { loadWin32Native, setWin32NativeForTest } from "./win32-native.ts";
import { installedAddonAsset } from "./win32-test-support.ts";

const tempRoots: string[] = [];

const ONE_EXTENSION_HOST = createClaimHolder();

/**
 * One extension host taking a claim. Each call mints a *new* holder, which is
 * what a second window (or a reloaded window) presents; `ONE_EXTENSION_HOST` is
 * the same host re-entering its own claim.
 */
function holder(): ClaimHolder {
	return createClaimHolder();
}

/** A holder that stands for a process which is not running any more. */
function deadHostHolder(): ClaimHolder {
	return createClaimHolder(4194303);
}

/** A storage directory standing in for one VS Code installation's state dir. */
async function makeStorageDir(): Promise<string> {
	const root = await mkdtemp(path.join(tmpdir(), "omp-claims-"));
	tempRoots.push(root);
	return root;
}

/** A materialized OMP session file whose canonical path is the session identity. */
async function makeSessionFile(parent = tmpdir()): Promise<string> {
	const dir = await mkdtemp(path.join(parent, "omp-session-"));
	tempRoots.push(dir);
	const file = path.join(dir, "chat.jsonl");
	await writeFile(file, '{"type":"session"}\n', "utf8");
	return file;
}

/** The session file spelled through its directory's 8.3 short name, or `null` when there is none. */
function shortNameAlias(filePath: string): string | null {
	const directory = shortDirectoryAlias(path.dirname(filePath));
	return directory === null ? null : path.join(directory, path.basename(filePath));
}

/**
 * Assert that `promise` rejects with an instance of `expected` and return it.
 * `assert.rejects`' typings vary in how they accept a constructor, so the check
 * is explicit here.
 */
async function caughtError(promise: Promise<unknown>, expected: new (...args: never[]) => Error): Promise<Error> {
	try {
		await promise;
	} catch (error) {
		assert.ok(error instanceof expected, `expected ${expected.name}, received ${String(error)}`);
		return error;
	}
	assert.fail(`expected ${expected.name}, but the call resolved`);
}

before(async () => {
	// The start times these tests compare are read in process (ADR-0076).
	if (process.platform === "win32") setWin32NativeForTest(await loadWin32Native(await installedAddonAsset()));
});

after(async () => {
	setWin32NativeForTest(undefined);
	await Promise.all(tempRoots.map(root => rm(root, { recursive: true, force: true })));
});

describe("acquireClaim", () => {
	it("retains the owning folder or saved workspace URI without affecting holder exclusion", async () => {
		const storage = await makeStorageDir();
		const file = await makeSessionFile();
		const owner = { ...holder(), windowUri: "file:///C:/omp-vscode/omp-vscode.code-workspace" };
		const claim = await acquireClaim(storage, file, createOwnerGeneration(), owner);
		assert.equal((await readClaim(storage, file))?.windowUri, owner.windowUri);
		await assert.rejects(acquireClaim(storage, file, claim.ownerGeneration, holder()), ClaimConflictError);
		await claim.release();
	});
	it("replaces corrupt and foreign dead-holder records without a release ceremony", async () => {
		const storageDir = await makeStorageDir();
		const identity = await makeSessionFile();
		const stale = await acquireClaim(storageDir, identity, "old-owner", deadHostHolder());
		await writeFile(stale.claimPath, "{unreadable", "utf8");
		const admitted = await acquireClaim(storageDir, identity, "new-owner", holder());
		assert.equal((await readClaim(storageDir, identity))?.ownerGeneration, "new-owner");
		await admitted.release();
		assert.equal(await readClaim(storageDir, identity), null);
	});

	it("allows a local lease with unusable storage while excluding a second local writer", async () => {
		const parent = await makeStorageDir();
		const storageDir = path.join(parent, "not-a-directory");
		await writeFile(storageDir, "preserved bytes");
		const identity = await makeSessionFile();
		const admitted = await acquireClaim(storageDir, identity, "owner", holder());
		await caughtError(acquireClaim(storageDir, identity, "rival", holder()), ClaimConflictError);
		await admitted.release();
		assert.equal(await readClaim(storageDir, identity), null);
		const next = await acquireClaim(storageDir, identity, "next", holder());
		await next.release();
	});

	it("proceeds under a local lease when an abandoned mutex cannot be claimed, without removing the mutex", async () => {
		const storageDir = await makeStorageDir();
		const identity = await makeSessionFile();
		const mutex = claimMutexPath(storageDir, identity);
		await mkdir(mutex, { recursive: true });
		const admitted = await acquireClaim(storageDir, identity, "owner", holder());
		assert.equal(existsSync(mutex), true);
		await caughtError(acquireClaim(storageDir, identity, "rival", holder()), ClaimConflictError);
		await admitted.release();
		assert.equal(existsSync(mutex), true, "fallback never mutates another operation's namespace");
	});
	it("admits exactly one of two contenders for the same session", async () => {
		const storageDir = await makeStorageDir();
		const sessionFile = await makeSessionFile();

		const results = await Promise.allSettled([
			acquireClaim(storageDir, sessionFile, createOwnerGeneration(), holder()),
			acquireClaim(storageDir, sessionFile, createOwnerGeneration(), holder()),
		]);

		const acquired = results.filter(
			(result): result is PromiseFulfilledResult<SessionClaim> => result.status === "fulfilled",
		);
		const refused = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
		assert.equal(acquired.length, 1);
		assert.equal(refused.length, 1);

		const conflict = refused[0]?.reason;
		assert.ok(conflict instanceof ClaimConflictError);
		assert.equal(conflict.existingOwnerGeneration, acquired[0]?.value.ownerGeneration);

		// The winner's claim survived the refused contender untouched.
		const observed = await readClaim(storageDir, sessionFile);
		assert.equal(observed?.ownerGeneration, acquired[0]?.value.ownerGeneration);
		await acquired[0]?.value.release();
	});

	it("frees the identity for the next owner and tolerates a repeated release", async () => {
		const storageDir = await makeStorageDir();
		const sessionFile = await makeSessionFile();

		const first = await acquireClaim(storageDir, sessionFile, createOwnerGeneration(), holder());
		await first.release();
		await first.release();
		assert.equal(await readClaim(storageDir, sessionFile), null);

		const second = await acquireClaim(storageDir, sessionFile, createOwnerGeneration(), holder());
		assert.notEqual(second.ownerGeneration, first.ownerGeneration);
		await second.release();
	});

	it("adopts a claim this very holder already holds", async () => {
		const storageDir = await makeStorageDir();
		const sessionFile = await makeSessionFile();
		const ownerGeneration = createOwnerGeneration();

		const first = await acquireClaim(storageDir, sessionFile, ownerGeneration, ONE_EXTENSION_HOST);
		const again = await acquireClaim(storageDir, sessionFile, ownerGeneration, ONE_EXTENSION_HOST);
		assert.equal(again.ownerGeneration, ownerGeneration);
		assert.equal(again.claimPath, first.claimPath);
		assert.equal(again.holder.id, first.holder.id);

		await first.release();
		// The second handle is the same lease, so releasing it is a no-op and the
		// identity is free again.
		assert.equal(await readClaim(storageDir, sessionFile), null);
		await again.release();
	});

	it("refuses a second live holder of one owner generation", async () => {
		const storageDir = await makeStorageDir();
		const sessionFile = await makeSessionFile();
		// One persisted owner generation: two windows of one workspace read exactly this.
		const ownerGeneration = createOwnerGeneration();

		const first = await acquireClaim(storageDir, sessionFile, ownerGeneration, holder());
		let conflict: unknown;
		try {
			await acquireClaim(storageDir, sessionFile, ownerGeneration, holder());
		} catch (error) {
			conflict = error;
		}
		assert.ok(conflict instanceof ClaimConflictError, "a live rival holder must never be admitted");
		assert.equal(conflict.existingOwnerGeneration, ownerGeneration);
		assert.equal(conflict.existingHolderId, first.holder.id, "the conflict names the live holder");

		// The winner's claim and its lease are untouched, so a third window is
		// refused as well.
		const observed = await readClaim(storageDir, sessionFile);
		assert.equal(observed?.holderId, first.holder.id);
		await caughtError(
			acquireClaim(storageDir, sessionFile, ownerGeneration, holder()),
			ClaimConflictError,
		);

		await first.release();
		assert.equal(await readClaim(storageDir, sessionFile), null);
	});

	it("takes the lease over once the recorded holder's process is gone", async () => {
		const storageDir = await makeStorageDir();
		const sessionFile = await makeSessionFile();
		const ownerGeneration = createOwnerGeneration();

		// A launch recorded by a window whose process has since exited: the persisted
		// session and its generation survive, the holder lease does not.
		const gone = await acquireClaim(storageDir, sessionFile, ownerGeneration, deadHostHolder());
		const reattached = await acquireClaim(storageDir, sessionFile, ownerGeneration, holder());
		assert.notEqual(reattached.holder.id, gone.holder.id);
		assert.equal((await readClaim(storageDir, sessionFile))?.holderId, reattached.holder.id);

		// The dead holder can no longer release the lease the new one took.
		await caughtError(gone.release(), ClaimHolderError);

		await reattached.release();
		assert.equal(await readClaim(storageDir, sessionFile), null);
	});

	it("upgrades a record written before the holder lease existed", async () => {
		const storageDir = await makeStorageDir();
		const sessionFile = await makeSessionFile();
		const ownerGeneration = createOwnerGeneration();
		const claimPath = claimPathFor(storageDir, sessionFile);
		await mkdir(path.dirname(claimPath), { recursive: true });
		await writeFile(
			claimPath,
			`${JSON.stringify({
				version: 1,
				identity: sessionFile,
				normalizedIdentity: normalizeClaimIdentity(sessionFile),
				ownerGeneration,
				pid: process.pid,
				createdAt: new Date().toISOString(),
			})}\n`,
			"utf8",
		);

		// The generation owner adopts its own pre-lease record and records whose
		// lease it is now …
		const adopted = await acquireClaim(storageDir, sessionFile, ownerGeneration, holder());
		assert.equal((await readClaim(storageDir, sessionFile))?.holderId, adopted.holder.id);
		// … so the second live window is refused from then on.
		await caughtError(acquireClaim(storageDir, sessionFile, ownerGeneration, holder()), ClaimConflictError);

		await adopted.release();
		assert.equal(await readClaim(storageDir, sessionFile), null);
	});


	it("rejects malformed identities and owner generations", async () => {
		const storageDir = await makeStorageDir();
		const sessionFile = await makeSessionFile();

		await caughtError(acquireClaim(storageDir, sessionFile, "bad generation", holder()), TypeError);
		await caughtError(acquireClaim(storageDir, "draft:bad id", createOwnerGeneration(), holder()), TypeError);
		await caughtError(acquireClaim(storageDir, "", createOwnerGeneration(), holder()), TypeError);
	});
});


describe("release", () => {
	it("refuses to release a claim that a newer owner generation holds", async () => {
		const storageDir = await makeStorageDir();
		const sessionFile = await makeSessionFile();

		const stale = await acquireClaim(storageDir, sessionFile, createOwnerGeneration(), holder());
		// A higher layer that proved no writer was alive reconciles the claim away.
		await rm(stale.claimPath, { force: true });
		const current = await acquireClaim(storageDir, sessionFile, createOwnerGeneration(), holder());

		let failure: unknown;
		try {
			await stale.release();
		} catch (error) {
			failure = error;
		}
		assert.ok(failure instanceof ClaimOwnershipError);
		assert.equal(failure.expectedOwnerGeneration, stale.ownerGeneration);
		assert.equal(failure.actualOwnerGeneration, current.ownerGeneration);

		// The newer claim is intact, so a third contender is still refused: the
		// stale release must not have opened a window in which a third contender could acquire.
		const observed = await readClaim(storageDir, sessionFile);
		assert.equal(observed?.ownerGeneration, current.ownerGeneration);
		await caughtError(acquireClaim(storageDir, sessionFile, createOwnerGeneration(), holder()), ClaimConflictError);

		await current.release();
		assert.equal(await readClaim(storageDir, sessionFile), null);
	});

	it("resolves as a no-op once the claim file is gone", async () => {
		const storageDir = await makeStorageDir();
		const sessionFile = await makeSessionFile();

		const claim = await acquireClaim(storageDir, sessionFile, createOwnerGeneration(), holder());
		await rm(claim.claimPath, { force: true });
		await claim.release();
		assert.equal(await readClaim(storageDir, sessionFile), null);
	});
});


describe("normalizeClaimIdentity", () => {
	it("collapses a dotted spelling onto the same absolute session path", async () => {
		const sessionFile = await makeSessionFile();
		const dotted = path.join(path.dirname(sessionFile), ".", path.basename(sessionFile));
		assert.equal(normalizeClaimIdentity(dotted), normalizeClaimIdentity(sessionFile));
	});

	it("keeps draft identities namespaced and stable", () => {
		const draftIdentity = createDraftIdentity();
		assert.equal(normalizeClaimIdentity(draftIdentity), draftIdentity);
		assert.notEqual(normalizeClaimIdentity(draftIdentity), normalizeClaimIdentity(`/${draftIdentity}`));
	});

	it("files Windows path aliases under one claim", { skip: process.platform !== "win32" }, async () => {
		const storageDir = await makeStorageDir();
		const sessionFile = await makeSessionFile();
		const aliasDirectory = await mkdtemp(path.join(tmpdir(), "omp-alias-"));
		tempRoots.push(aliasDirectory);
		const junctionPath = path.join(aliasDirectory, "session-junction");
		symlinkSync(path.dirname(sessionFile), junctionPath, "junction");

		const aliases = [
			sessionFile.toUpperCase(),
			sessionFile.replaceAll("\\", "/"),
			`${sessionFile}.`,
			`\\\\?\\${sessionFile}`,
			path.join(junctionPath, path.basename(sessionFile)),
		];

		const keys = [sessionFile, ...aliases].map(alias => normalizeClaimIdentity(alias));
		assert.equal(new Set(keys).size, 1, `aliases produced multiple keys: ${keys.join(" | ")}`);

		const owner = await acquireClaim(storageDir, sessionFile, createOwnerGeneration(), holder());
		for (const alias of aliases) {
			await caughtError(acquireClaim(storageDir, alias, createOwnerGeneration(), holder()), ClaimConflictError);
		}
		await owner.release();
	});

	it("files an 8.3 short-name alias under the session's claim", { skip: process.platform !== "win32" }, async t => {
		const sessionFile = await makeSessionFile(await makeStorageDir());
		const shortPath = shortNameAlias(sessionFile);
		if (shortPath === null) {
			t.skip("8.3 short names are unavailable on this volume");
			return;
		}
		assert.notEqual(shortPath, sessionFile);
		assert.equal(normalizeClaimIdentity(shortPath), normalizeClaimIdentity(sessionFile));
	});
});

describe("promoteDraftClaim", () => {
	it("keeps the draft claim when the session file is already claimed", async () => {
		const storageDir = await makeStorageDir();
		const sessionFile = await makeSessionFile();
		const other = await acquireClaim(storageDir, sessionFile, createOwnerGeneration(), holder());
		const draftIdentity = createDraftIdentity();
		const draft = await acquireClaim(storageDir, draftIdentity, createOwnerGeneration(), holder());

		await caughtError(promoteDraftClaim(draft, sessionFile), ClaimConflictError);

		// Acquiring the file claim happens before the draft is given up, so a
		// failed promotion must still leave the draft held. Releasing the draft
		// first would make this assertion fail.
		assert.equal((await readClaim(storageDir, draftIdentity))?.ownerGeneration, draft.ownerGeneration);
		assert.equal((await readClaim(storageDir, sessionFile))?.ownerGeneration, other.ownerGeneration);

		await draft.release();
		await other.release();
	});

	it("transfers ownership from the draft identity to the session file", async () => {
		const storageDir = await makeStorageDir();
		const sessionFile = await makeSessionFile();
		const draftIdentity = createDraftIdentity();
		const draft = await acquireClaim(storageDir, draftIdentity, createOwnerGeneration(), holder());

		const promoted = await promoteDraftClaim(draft, sessionFile);
		assert.equal(promoted.ownerGeneration, draft.ownerGeneration);
		assert.notEqual(promoted.normalizedIdentity, draft.normalizedIdentity);
		assert.equal(await readClaim(storageDir, draftIdentity), null);
		assert.equal((await readClaim(storageDir, sessionFile))?.ownerGeneration, draft.ownerGeneration);

		await promoted.release();
		assert.equal(await readClaim(storageDir, sessionFile), null);
	});

	it("refuses a claim that is not a draft", async () => {
		const storageDir = await makeStorageDir();
		const sessionFile = await makeSessionFile();
		const claim = await acquireClaim(storageDir, sessionFile, createOwnerGeneration(), holder());

		await caughtError(promoteDraftClaim(claim, sessionFile), TypeError);
		await claim.release();
	});
});

describe("whether another window's holder looks alive, for display", () => {
	const children: Array<ReturnType<typeof spawn>> = [];
	after(() => { for (const child of children) child.kill(); });
	/**
	 * A live process whose start lies well before any claim filed after this resolves. The verdict
	 * compares the kernel's creation time of a real process with a claim stamped from Node's
	 * `Date.now()`, which on Windows can trail the kernel clock by milliseconds; fake timers move
	 * neither clock, so only real elapsed time puts the claim after the start.
	 */
	const liveProcess = async (): Promise<number> => {
		const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore", windowsHide: true });
		children.push(child);
		await new Promise(resolve => setTimeout(resolve, 100));
		return child.pid!;
	};
	/** A claim another window of this extension filed, in the format an older build wrote (no recorded start time), filed at `filedAt`. */
	async function foreignClaim(storageDir: string, sessionFile: string, pid: number, options: { processCreationTime?: string | null; filedAt?: number } = {}) {
		const claimPath = claimPathFor(storageDir, sessionFile);
		await mkdir(path.dirname(claimPath), { recursive: true });
		await writeFile(claimPath, JSON.stringify({
			version: 1, identity: sessionFile, normalizedIdentity: normalizeClaimIdentity(sessionFile), ownerGeneration: createOwnerGeneration(), holderId: randomUUID(), pid,
			processCreationTime: options.processCreationTime ?? null, windowUri: null, createdAt: new Date(options.filedAt ?? Date.now()).toISOString(),
		}));
		return (await readClaim(storageDir, sessionFile))!;
	}
	async function watchingProbes<T>(run: (probes: ProcessProbe[]) => Promise<T>): Promise<T> {
		const probes: ProcessProbe[] = [];
		setProcessProbeObserver(probe => probes.push(probe));
		try { return await run(probes); } finally { setProcessProbeObserver(null); }
	}
	const purposes = (probes: readonly ProcessProbe[]) => probes.map(probe => probe.purpose);

	it("reads a holder's start time once, without blocking, and answers the verdicts after it from memory", async () => {
		const storageDir = await makeStorageDir();
		const claim = await foreignClaim(storageDir, await makeSessionFile(), await liveProcess());
		await watchingProbes(async probes => {
			assert.equal(await claimHolderSeemsAlive(claim), true);
			assert.deepEqual(purposes(probes), ["display"], "one command, off the event loop");
			for (let at = 0; at < 25; at++) assert.equal(await claimHolderSeemsAlive(claim), true);
			assert.deepEqual(purposes(probes), ["display"], "no verdict after the first starts another command");
		});
	});

	it("shares one command between concurrent verdicts about one holder", async () => {
		const storageDir = await makeStorageDir();
		const pid = await liveProcess();
		const filedAt = Date.now();
		const claims = await Promise.all([foreignClaim(storageDir, await makeSessionFile(), pid, { filedAt }), foreignClaim(storageDir, await makeSessionFile(), pid, { filedAt })]);
		await watchingProbes(async probes => {
			assert.deepEqual(await Promise.all(claims.map(claim => claimHolderSeemsAlive(claim))), [true, true]);
			assert.equal(probes.length, 1);
		});
	});

	it("never starts a command for a holder whose process is gone", async () => {
		const storageDir = await makeStorageDir();
		const claim = await foreignClaim(storageDir, await makeSessionFile(), 4194303);
		await watchingProbes(async probes => {
			assert.equal(await claimHolderSeemsAlive(claim), false);
			assert.deepEqual(probes, []);
		});
	});

	it("takes a claim of another generation of the pid as not held from a reading taken after the claim was filed, and does not read again", async () => {
		const storageDir = await makeStorageDir();
		const claim = await foreignClaim(storageDir, await makeSessionFile(), await liveProcess(), { processCreationTime: "2000-01-01T00:00:00.000Z", filedAt: Date.now() - 1000 });
		await watchingProbes(async probes => {
			assert.equal(await claimHolderSeemsAlive(claim), false);
			assert.equal(await claimHolderSeemsAlive(claim), false);
			assert.deepEqual(purposes(probes), ["display"], "a stale claim of a reused pid costs one command, not one per verdict");
		});
	});

	it("reads again for a claim filed after the reading, which may be a newer process that reused the pid", async () => {
		const storageDir = await makeStorageDir();
		const pid = await liveProcess();
		const earlier = await foreignClaim(storageDir, await makeSessionFile(), pid);
		await watchingProbes(async probes => {
			assert.equal(await claimHolderSeemsAlive(earlier), true);
			const later = await foreignClaim(storageDir, await makeSessionFile(), pid, { processCreationTime: "2000-01-01T00:00:00.000Z", filedAt: Date.now() + 60_000 });
			assert.equal(await claimHolderSeemsAlive(later), false, "this claim is not the process that holds the pid");
			assert.deepEqual(purposes(probes), ["display", "display"], "the reading taken before the claim existed was not used for it");
		});
	});

	it("does not join a command that started before the claim was filed", async () => {
		const storageDir = await makeStorageDir();
		const pid = await liveProcess();
		const first = await foreignClaim(storageDir, await makeSessionFile(), pid);
		const newer = await foreignClaim(storageDir, await makeSessionFile(), pid, { filedAt: Date.now() + 60_000 });
		await watchingProbes(async probes => {
			const verdicts = await Promise.all([claimHolderSeemsAlive(first), claimHolderSeemsAlive(newer)]);
			assert.deepEqual(verdicts, [true, true]);
			assert.equal(probes.length, 2, "the claim filed after the running command started gets a command of its own");
		});
	});

	it("leaves the verdict that admits a launch to read the start time itself, every time, without blocking the thread", async () => {
		const storageDir = await makeStorageDir();
		const claim = await foreignClaim(storageDir, await makeSessionFile(), await liveProcess());
		await watchingProbes(async probes => {
			await claimHolderSeemsAlive(claim);
			const pending = claimHolderMayBeAlive(claim);
			assert.ok(pending instanceof Promise, "the reading is awaited, never run synchronously");
			assert.equal(probes.length, 1, "the command has not finished, so no reading has been taken yet");
			assert.equal(await pending, true);
			assert.equal(await claimHolderMayBeAlive(claim), true);
			assert.deepEqual(purposes(probes), ["display", "verdict", "verdict"]);
		});
	});

	it("reads this process's start time once, off the thread", async () => {
		await watchingProbes(async probes => {
			const first = await readProcessCreationTime(process.pid);
			const second = await readProcessCreationTime(process.pid);
			assert.match(first ?? "", /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
			assert.equal(second, first);
			assert.ok(probes.filter(probe => probe.purpose === "own").length <= 1, "the own start time is read at most once per process");
		});
	});

	it("makes a holder without a start time that is verified by the claim's filing time instead", async () => {
		const bare = createClaimHolder(process.pid);
		assert.equal(bare.processCreationTime, null);
		const storageDir = await makeStorageDir();
		const file = await makeSessionFile();
		const claim = await acquireClaim(storageDir, file, createOwnerGeneration(), bare);
		const observed = await readClaim(storageDir, file);
		assert.equal(observed?.processCreationTime, null);
		assert.equal(await claimHolderMayBeAlive(observed!), true, "this process's own holder is live by registration");
		await claim.release();
	});

	/** `process.kill(pid, 0)` as an account that may not open the holder answers: `EPERM` for the given pid, the real answer otherwise. */
	function denyProbeOf(pid: number): void {
		const real = process.kill.bind(process);
		mock.method(process, "kill", (target: number, signal?: string | number) => {
			if (target === pid && signal === 0) throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
			return real(target, signal);
		});
	}

	it("takes a holder this account may not probe (EPERM) as existing, and lets its start time decide", async () => {
		const storageDir = await makeStorageDir();
		const pid = await liveProcess();
		const filedAt = Date.now();
		const same = await foreignClaim(storageDir, await makeSessionFile(), pid, { filedAt });
		const reused = await foreignClaim(storageDir, await makeSessionFile(), pid, { processCreationTime: "2000-01-01T00:00:00.000Z", filedAt });
		denyProbeOf(pid);
		try {
			assert.equal(await claimHolderMayBeAlive(same), true, "a refused probe is not an absent process");
			assert.equal(await claimHolderSeemsAlive(same), true);
			assert.equal(await claimHolderMayBeAlive(reused), false, "the start time still tells a reused pid apart");
			assert.equal(await claimHolderProvablyGone(same), false);
		} finally {
			mock.restoreAll();
		}
	});
});

describe("claims whose holder is provably gone", () => {
	it("calls a claim gone only on a positive fact: a missing process, never a live holder or a record that cannot be read", async () => {
		const storageDir = await makeStorageDir();
		const deadFile = await makeSessionFile();
		const liveFile = await makeSessionFile();
		await acquireClaim(storageDir, deadFile, createOwnerGeneration(), deadHostHolder());
		const live = await acquireClaim(storageDir, liveFile, createOwnerGeneration(), holder());

		assert.equal(await claimHolderProvablyGone((await readClaim(storageDir, deadFile))!), true);
		assert.equal(await claimHolderProvablyGone((await readClaim(storageDir, liveFile))!), false);
		const unreadable = { ...(await readClaim(storageDir, deadFile))!, verifiable: false as const, holderId: null };
		assert.equal(await claimHolderProvablyGone(unreadable), false, "an unreadable record is never evidence");
		await live.release();
	});

	it("lists readable claim files and leaves everything else out", async () => {
		const storageDir = await makeStorageDir();
		const first = await makeSessionFile();
		const second = await makeSessionFile();
		const claimed = await acquireClaim(storageDir, first, createOwnerGeneration(), holder());
		await acquireClaim(storageDir, second, createOwnerGeneration(), deadHostHolder());
		const corrupt = claimPathFor(storageDir, await makeSessionFile());
		await writeFile(corrupt, "not a claim", "utf8");
		await writeFile(path.join(path.dirname(corrupt), "stray.tmp"), "{}", "utf8");

		const listed = await listClaims(storageDir);

		assert.deepEqual(listed.map(claim => claim.normalizedIdentity).sort(), [normalizeClaimIdentity(first), normalizeClaimIdentity(second)].sort());
		assert.deepEqual(await listClaims(path.join(storageDir, "nothing-here")), []);
		await claimed.release();
	});

	it("deletes a gone holder's claim, but not one a live holder took over after it was read", async () => {
		const storageDir = await makeStorageDir();
		const file = await makeSessionFile();
		await acquireClaim(storageDir, file, createOwnerGeneration(), deadHostHolder());
		const observed = (await readClaim(storageDir, file))!;

		const taken = await acquireClaim(storageDir, file, createOwnerGeneration(), holder());
		assert.equal(await removeClaimOfGoneHolder(observed), false, "the record is now another holder's");
		assert.notEqual(await readClaim(storageDir, file), null);
		await taken.release();

		await acquireClaim(storageDir, file, createOwnerGeneration(), deadHostHolder());
		assert.equal(await removeClaimOfGoneHolder((await readClaim(storageDir, file))!), true);
		assert.equal(await readClaim(storageDir, file), null);
	});
});
