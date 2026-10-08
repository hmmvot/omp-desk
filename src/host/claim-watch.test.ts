/**
 * The claims-directory watch against the real file system: real claims filed by
 * `acquireClaim`, a real temporary storage directory per test.
 *
 * - a claim and its release each report exactly that session's claim file;
 * - a burst folds into few callbacks that together name every changed claim;
 * - mutex and staging entries are never reported;
 * - a disposed watch is silent, including for an already queued event;
 * - a missing claims directory is created and then watched;
 * - a throwing handler is reported and does not stop the watch.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { claimFileNameFor, startClaimWatch } from "./claim-watch.ts";
import type { ClaimWatchOptions } from "./claim-watch.ts";
import {
	acquireClaim,
	claimPathFor,
	claimsDirectory,
	createClaimHolder,
	createOwnerGeneration,
} from "./session-claim.ts";
import type { SessionClaim } from "./session-claim.ts";

const WAIT_TIMEOUT_MS = 5000;
const roots: string[] = [];
const disposers: Array<() => void> = [];

afterEach(() => {
	for (const dispose of disposers.splice(0)) dispose();
});

after(async () => {
	for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function tempStorage(): Promise<string> {
	const root = await mkdtemp(path.join(tmpdir(), "omp-claim-watch-"));
	roots.push(root);
	return path.join(root, "storage");
}

interface Recorder {
	readonly calls: Array<ReadonlySet<string>>;
	readonly errors: string[];
	readonly dispose: () => void;
	/** Resolves once `predicate` holds over the calls so far; rejects on timeout. */
	readonly until: (predicate: (calls: ReadonlyArray<ReadonlySet<string>>) => boolean) => Promise<void>;
	/** Union of every name delivered so far. */
	readonly names: () => Set<string>;
}

function watch(storageDir: string, options: ClaimWatchOptions = {}, onChange?: (files: ReadonlySet<string>) => void): Recorder {
	const calls: Array<ReadonlySet<string>> = [];
	const errors: string[] = [];
	let notify: (() => void) | null = null;
	const dispose = startClaimWatch(
		storageDir,
		files => {
			calls.push(files);
			notify?.();
			onChange?.(files);
		},
		{ ...options, onError: detail => errors.push(detail) },
	);
	disposers.push(dispose);
	return {
		calls,
		errors,
		dispose,
		until: predicate => {
			const { promise, resolve, reject } = Promise.withResolvers<void>();
			if (predicate(calls)) {
				resolve();
				return promise;
			}
			const timeout = setTimeout(() => {
				notify = null;
				reject(new Error(`timed out waiting for claim changes; saw ${JSON.stringify(calls.map(c => [...c]))}`));
			}, WAIT_TIMEOUT_MS);
			notify = () => {
				if (!predicate(calls)) return;
				clearTimeout(timeout);
				notify = null;
				resolve();
			};
			return promise;
		},
		names: () => new Set(calls.flatMap(files => [...files])),
	};
}

/**
 * Real delay, used only to prove a negative (no callback) against the platform
 * file watcher and its debounce clock; positive waits use `until`.
 */
function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

function acquire(storageDir: string, sessionFile: string): Promise<SessionClaim> {
	return acquireClaim(storageDir, sessionFile, createOwnerGeneration(), createClaimHolder());
}

describe("startClaimWatch", () => {
	it("reports exactly the claim file on acquire and again on release", async () => {
		const storageDir = await tempStorage();
		const file = path.join(storageDir, "sessions", "a.jsonl");
		const expected = claimFileNameFor(storageDir, file);
		const recorder = watch(storageDir, { debounceMs: 20 });

		const claim = await acquire(storageDir, file);
		assert.ok(existsSync(claimPathFor(storageDir, file)), "the claim must really be filed in the claims directory");
		await recorder.until(calls => calls.length > 0);
		assert.ok(recorder.calls.every(files => files.size === 1 && files.has(expected)));

		await sleep(100);
		recorder.calls.length = 0;
		await claim.release();
		assert.ok(!existsSync(claimPathFor(storageDir, file)));
		await recorder.until(calls => calls.length > 0);
		assert.ok(recorder.calls.every(files => files.size === 1 && files.has(expected)));
	});

	it("folds a burst over two files into few callbacks naming both", async () => {
		const storageDir = await tempStorage();
		const fileA = path.join(storageDir, "sessions", "a.jsonl");
		const fileB = path.join(storageDir, "sessions", "b.jsonl");
		const nameA = claimFileNameFor(storageDir, fileA);
		const nameB = claimFileNameFor(storageDir, fileB);
		assert.notEqual(nameA, nameB);
		const recorder = watch(storageDir, { debounceMs: 300 });

		const [claimA, claimB] = await Promise.all([acquire(storageDir, fileA), acquire(storageDir, fileB)]);
		assert.ok(existsSync(claimPathFor(storageDir, fileA)) && existsSync(claimPathFor(storageDir, fileB)));
		await Promise.all([claimA.release(), claimB.release()]);
		assert.ok(!existsSync(claimPathFor(storageDir, fileA)) && !existsSync(claimPathFor(storageDir, fileB)));

		await recorder.until(calls => calls.some(files => files.has(nameA)) && calls.some(files => files.has(nameB)));
		assert.deepEqual(recorder.names(), new Set([nameA, nameB]));
		assert.ok(recorder.calls.length <= 3, `expected a folded burst, got ${recorder.calls.length} callbacks`);
	});

	it("ignores mutex, staging and temporary entries", async () => {
		const storageDir = await tempStorage();
		const directory = claimsDirectory(storageDir);
		const recorder = watch(storageDir, { debounceMs: 20 });

		await writeFile(path.join(directory, `${"0".repeat(64)}.claim.mutex`), "x");
		await mkdir(path.join(directory, `${"1".repeat(64)}.claim.mutex.d`));
		await writeFile(path.join(directory, `.${"2".repeat(64)}.claim.${createOwnerGeneration()}.tmp`), "x");
		await writeFile(path.join(directory, createOwnerGeneration()), "x");
		await sleep(200);
		assert.deepEqual(recorder.calls, []);

		const file = path.join(storageDir, "sessions", "c.jsonl");
		await acquire(storageDir, file);
		await recorder.until(calls => calls.length > 0);
		assert.deepEqual(recorder.names(), new Set([claimFileNameFor(storageDir, file)]));
	});

	it("is silent after dispose, safe to dispose twice, and drops a queued event", async () => {
		const storageDir = await tempStorage();
		const file = path.join(storageDir, "sessions", "d.jsonl");
		const disposed = watch(storageDir, { debounceMs: 150 });
		const control = watch(storageDir, { debounceMs: 150 });

		await acquire(storageDir, file);
		await sleep(40);
		disposed.dispose();
		disposed.dispose();
		await control.until(calls => calls.length > 0);
		await sleep(200);
		assert.deepEqual(disposed.calls, [], "an event queued before dispose must not fire");

		const other = path.join(storageDir, "sessions", "e.jsonl");
		const before = control.calls.length;
		await acquire(storageDir, other);
		await control.until(calls => calls.length > before);
		await sleep(200);
		assert.deepEqual(disposed.calls, [], "a write after dispose must not fire");
		assert.deepEqual(disposed.errors, []);
	});

	it("creates a missing claims directory and observes a later claim", async () => {
		const storageDir = await tempStorage();
		assert.ok(!existsSync(storageDir));
		const recorder = watch(storageDir, { debounceMs: 20 });
		assert.ok(existsSync(claimsDirectory(storageDir)));

		const file = path.join(storageDir, "sessions", "f.jsonl");
		await acquire(storageDir, file);
		assert.ok(existsSync(claimPathFor(storageDir, file)));
		await recorder.until(calls => calls.length > 0);
		assert.deepEqual(recorder.names(), new Set([claimFileNameFor(storageDir, file)]));
		assert.deepEqual(recorder.errors, []);
	});

	it("reports a throwing handler and keeps watching", async () => {
		const storageDir = await tempStorage();
		let throwing = true;
		const recorder = watch(storageDir, { debounceMs: 20 }, () => {
			if (throwing) throw new Error("handler boom");
		});

		await acquire(storageDir, path.join(storageDir, "sessions", "g.jsonl"));
		await recorder.until(calls => calls.length > 0);
		assert.ok(recorder.errors.some(detail => detail.includes("handler boom")));

		await sleep(100);
		throwing = false;
		const before = recorder.calls.length;
		const other = path.join(storageDir, "sessions", "h.jsonl");
		await acquire(storageDir, other);
		await recorder.until(calls => calls.length > before);
		assert.ok(recorder.names().has(claimFileNameFor(storageDir, other)));
	});

	it("reports an unwatchable directory through onError instead of throwing", async () => {
		const storageDir = await tempStorage();
		await mkdir(path.dirname(storageDir), { recursive: true });
		await writeFile(storageDir, "not a directory");
		const recorder = watch(storageDir, { debounceMs: 20 });
		assert.equal(recorder.errors.length, 1);
		assert.doesNotThrow(() => recorder.dispose());
	});
});
