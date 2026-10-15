import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { localFs, markSynchronousLocalRoots, useSynchronousLocalFs, useSynchronousLocalFsFor } from "./local-fs.ts";
import { ptyRecordPath, ptyStateDirectory, readPtyRecord } from "./pty-registry.ts";
import { ptyRecordedTreeDigest, ptyRecordedTreeDigestFile } from "./pty-runtime.ts";
import { catalogPaths, readCatalogDocument, transactCatalog } from "./profile-catalog.ts";
import { acquireClaim, claimMutexPath, claimPathFor, createClaimHolder, createOwnerGeneration, readClaim } from "./session-claim.ts";

const roots: string[] = [];
const unmark: Array<() => void> = [];

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), "omp-local-fs-"));
	roots.push(dir);
	return dir;
}

afterEach(async () => {
	for (const undo of unmark.splice(0)) undo();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** Whether the event loop took a turn while `work` ran: false for calls that never leave the microtask queue. */
async function loopTurnedDuring(work: () => Promise<unknown>): Promise<boolean> {
	let turned = false;
	const mark = setImmediate(() => { turned = true; });
	await work();
	clearImmediate(mark);
	return turned;
}

/** A claim record without its creation time, which is the one field two takes of the same claim do not share. */
function withoutTime(record: string): string {
	return record.replace(/"createdAt": "[^"]*"/, "");
}

describe("synchronous local file calls", () => {
	it("serve nothing synchronously until a verdict marks a root, and only below that root", async () => {
		const dir = await tempDir();
		const other = await tempDir();
		const asynchronous = localFs(dir);
		unmark.push(markSynchronousLocalRoots([dir]));
		assert.notEqual(localFs(dir), asynchronous);
		assert.equal(localFs(path.join(dir, "a", "b")), localFs(dir));
		assert.equal(localFs(other), asynchronous, "a directory that was not verified keeps the asynchronous calls");
		assert.equal(localFs(`${dir}-sibling`), asynchronous, "a sibling that only shares the prefix is not below the root");
	});

	it("marks nothing when the verdict is no", async () => {
		const dir = await tempDir();
		const before = localFs(dir);
		assert.equal(await useSynchronousLocalFs([dir], async () => false), false);
		assert.equal(localFs(dir), before);
		assert.equal(await useSynchronousLocalFs([dir], async () => true), true);
		unmark.push(markSynchronousLocalRoots([dir]));
		assert.notEqual(localFs(dir), before);
	});

	it("take a claim, read it and release it without the event loop taking a turn, with the record an asynchronous take writes", async () => {
		const storage = await tempDir();
		const identity = path.join(storage, "sessions", "a.jsonl");
		const generation = createOwnerGeneration();
		const holder = createClaimHolder();
		const asynchronous = await acquireClaim(storage, identity, generation, holder);
		const asyncRecord = await readFile(claimPathFor(storage, identity), "utf8");
		await asynchronous.release();

		unmark.push(markSynchronousLocalRoots([storage]));
		let claim = await acquireClaim(storage, identity, generation, holder);
		await claim.release();
		const turned = await loopTurnedDuring(async () => {
			claim = await acquireClaim(storage, identity, generation, holder);
		});
		assert.equal(turned, false, "no file call of the take waited for the loop");
		assert.equal(withoutTime(await readFile(claimPathFor(storage, identity), "utf8")), withoutTime(asyncRecord));
		const observed = await readClaim(storage, identity);
		assert.equal(observed?.holderId, holder.id);
		await claim.release();
		assert.equal(await readClaim(storage, identity), null);
	});

	it("keep a claim lock waiting on a timer: a mutex another window holds delays the take, and the loop runs meanwhile", async () => {
		const storage = await tempDir();
		const identity = path.join(storage, "sessions", "b.jsonl");
		unmark.push(markSynchronousLocalRoots([storage]));
		const first = await acquireClaim(storage, identity, createOwnerGeneration(), createClaimHolder());
		const mutex = claimMutexPath(storage, identity);
		const probe = localFs(mutex);
		await probe.mkdir(mutex, { mode: 0o700 });
		let timers = 0;
		const tick = setInterval(() => { timers++; }, 5);
		const releasing = setTimeout(() => { void probe.rm(mutex, { recursive: true, force: true }); }, 60);
		try {
			const again = await acquireClaim(storage, identity, first.ownerGeneration, first.holder);
			assert.ok(timers >= 3, `timers kept firing while the take waited (${timers})`);
			await again.release();
		} finally {
			clearInterval(tick);
			clearTimeout(releasing);
		}
	});

	it("commit a catalog revision synchronously and keep its lock waiting on a timer", async () => {
		const dir = await tempDir();
		const paths = catalogPaths(dir);
		unmark.push(markSynchronousLocalRoots([paths.root]));
		const turned = await loopTurnedDuring(async () => {
			const result = await transactCatalog(paths, tx => { tx.set("test.key", { value: 1 }); });
			assert.ok(result.changed);
		});
		assert.equal(turned, false, "an uncontended commit needs no turn of the loop");
		assert.deepEqual((await readCatalogDocument(paths))?.records["test.key"], { value: 1 });

		await writeFile(paths.lock, JSON.stringify({ token: "other", pid: process.pid, host: "elsewhere", at: new Date().toISOString() }));
		let timers = 0;
		const tick = setInterval(() => { timers++; }, 5);
		const releasing = setTimeout(() => { void rm(paths.lock, { force: true }); }, 80);
		try {
			const result = await transactCatalog(paths, tx => { tx.set("test.key", { value: 2 }); });
			assert.ok(result.changed);
			assert.ok(timers >= 3, `timers kept firing while the commit waited for the lock (${timers})`);
		} finally {
			clearInterval(tick);
			clearTimeout(releasing);
		}
		assert.deepEqual((await readCatalogDocument(paths))?.records["test.key"], { value: 2 });
	});

	it("report the same error codes as the asynchronous calls", async () => {
		const dir = await tempDir();
		unmark.push(markSynchronousLocalRoots([dir]));
		const io = localFs(dir);
		await assert.rejects(io.readFile(path.join(dir, "missing"), "utf8"), { code: "ENOENT" });
		const target = path.join(dir, "x");
		const handle = await io.open(target, "wx", 0o600);
		await handle.close();
		await handle.close();
		await assert.rejects(io.open(target, "wx", 0o600), { code: "EEXIST" });
		await io.rm(path.join(dir, "missing"), { force: true });
	});

	it("read a broker record and the build's tree digest without a turn of the loop, with the answers the asynchronous reads give", async () => {
		const storage = await tempDir();
		const extension = await tempDir();
		const unbuilt = await tempDir();
		await mkdir(ptyStateDirectory(storage), { recursive: true });
		for (const root of [extension, unbuilt]) await mkdir(path.dirname(ptyRecordedTreeDigestFile(root)), { recursive: true });
		await writeFile(ptyRecordPath(storage, "tab:bad"), "{ this is not json", "utf8");
		await writeFile(ptyRecordedTreeDigestFile(extension), `${JSON.stringify({ format: "omp-runtime-tree/v1", digest: "ab".repeat(32), files: 3 })}\n`, "utf8");
		const asynchronous = [await readPtyRecord(storage, "tab:bad"), await readPtyRecord(storage, "tab:none"), await ptyRecordedTreeDigest(extension), await ptyRecordedTreeDigest(unbuilt)];
		assert.deepEqual(asynchronous.map(answer => (typeof answer === "object" && answer !== null ? answer.kind : answer)), ["invalid", "none", "ab".repeat(32), null]);

		unmark.push(markSynchronousLocalRoots([ptyStateDirectory(storage), ...[extension, unbuilt].map(root => path.dirname(ptyRecordedTreeDigestFile(root)))]));
		let synchronous: typeof asynchronous = [];
		const turned = await loopTurnedDuring(async () => {
			synchronous = [await readPtyRecord(storage, "tab:bad"), await readPtyRecord(storage, "tab:none"), await ptyRecordedTreeDigest(extension), await ptyRecordedTreeDigest(unbuilt)];
		});
		assert.equal(turned, false, "no read of the restore's record or of the tree digest waited for the loop");
		assert.deepEqual(synchronous, asynchronous);
	});

	it("ask once per directory whether a file there may be reached synchronously, and keep the answer", async () => {
		const yes = await tempDir();
		const no = await tempDir();
		await writeFile(path.join(yes, "a.jsonl"), "a", "utf8");
		await writeFile(path.join(yes, "b.jsonl"), "b", "utf8");
		await writeFile(path.join(no, "c.jsonl"), "c", "utf8");
		const asked: string[] = [];
		const verdict = async (targets: readonly string[]): Promise<boolean> => {
			asked.push(...targets);
			return targets[0] === yes;
		};
		const asynchronous = localFs(yes);
		assert.equal(await useSynchronousLocalFsFor(yes, verdict), true);
		unmark.push(markSynchronousLocalRoots([yes]));
		assert.equal(await useSynchronousLocalFsFor(yes, verdict), true);
		assert.equal(await useSynchronousLocalFsFor(no, verdict), false);
		assert.equal(await useSynchronousLocalFsFor(no, verdict), false);
		assert.deepEqual(asked, [yes, no], "each directory was judged once");
		assert.notEqual(localFs(path.join(yes, "a.jsonl")), asynchronous);
		assert.equal(localFs(path.join(no, "c.jsonl")), asynchronous, "a directory judged no keeps the asynchronous calls");
		assert.equal(await useSynchronousLocalFsFor(yes, async () => { throw new Error("native module failed"); }), true, "the first answer stays");
		assert.equal(await useSynchronousLocalFsFor(path.join(yes, "sub"), async () => { throw new Error("native module failed"); }), false, "a verdict that fails is no");
	});
});
