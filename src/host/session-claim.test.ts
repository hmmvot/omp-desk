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
import { existsSync, symlinkSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import {
	ClaimBusyError,
	ClaimConflictError,
	ClaimHolderError,
	ClaimOwnershipError,
	acquireClaim,
	claimMutexPath,
	claimPathFor,
	createClaimHolder,
	createDraftIdentity,
	createOwnerGeneration,
	normalizeClaimIdentity,
	promoteDraftClaim,
	readClaim,
	type ClaimHolder,
	type SessionClaim,
} from "./session-claim.ts";
import { shortDirectoryAlias } from "./short-name-test-support.ts";

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

after(async () => {
	await Promise.all(tempRoots.map(root => rm(root, { recursive: true, force: true })));
});

describe("acquireClaim", () => {
	it("retains the owning folder or saved workspace URI without affecting holder exclusion", async () => {
		const storage = await makeStorageDir();
		const file = await makeSessionFile();
		const owner = { ...holder(), windowUri: "file:///C:/sample/sample.code-workspace" };
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
