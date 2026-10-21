/**
 * The profile catalog's own contract: durability, cross-window merging, refusal and
 * the lock.
 *
 * These are the properties the whole design rests on, so they are exercised against
 * the real file system (a temporary directory per test), not a fake:
 *
 * - a commit is durable and advances the revision;
 * - two windows committing different changes to one record both keep theirs
 *   (the whole reason this module exists);
 * - a window that reaches the catalog while another holds the lock refuses rather
 *   than overwriting, and a lock whose owner is provably gone is reclaimed exactly
 *   once, visibly;
 * - an unreadable catalog blocks mutation and is never replaced with an empty one;
 * - a window's own change is never computed from a stale snapshot.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import fsModule, { existsSync, readFileSync, renameSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { hostname, tmpdir } from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { setImmediate as nextTurn, setTimeout as sleep } from "node:timers/promises";
import { CATALOG_CONFLICT_GROUP_KEEP, CatalogError, catalogPaths, compactConflicts, createCatalogStore, parseCatalogDocument, readCatalogDocument, startCatalogWatch, transactCatalog } from "./profile-catalog.ts";
import type { CatalogConflictRecord, CatalogDocument, CatalogPaths, CatalogRecovery, CatalogStore } from "./profile-catalog.ts";

const roots: string[] = [];

after(async () => {
	for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function tempCatalog(): Promise<{ readonly dir: string; readonly paths: CatalogPaths }> {
	const dir = await mkdtemp(path.join(tmpdir(), "omp-catalog-"));
	roots.push(dir);
	return { dir, paths: catalogPaths(dir) };
}

interface Row {
	readonly id: string;
	readonly value: string;
}

/** A record of rows keyed by id, with the delta rule every key shares. */
function rowsMerger(input: { readonly base: unknown; readonly desired: unknown; readonly latest: unknown }): {
	readonly value: unknown;
	readonly conflicts: readonly { readonly identity: string; readonly reason: string; readonly retained: unknown; readonly rejected: unknown }[];
} {
	const read = (value: unknown): Map<string, Row> =>
		new Map(
			Array.isArray(value)
				? value
						.filter((row): row is Row => typeof row === "object" && row !== null && typeof (row as Row).id === "string")
						.map(row => [row.id, row])
				: [],
		);
	const base = read(input.base);
	const latest = read(input.latest);
	const conflicts: { identity: string; reason: string; retained: unknown; rejected: unknown }[] = [];
	const merged = new Map<string, Row>();
	for (const row of read(input.desired).values()) {
		const before = base.get(row.id);
		const theirs = latest.get(row.id);
		if (before !== undefined && before.value === row.value) {
			// Untouched here: the committed record is the answer, and its absence is the
			// other window's deletion rather than something to re-add.
			if (theirs !== undefined) merged.set(row.id, theirs);
			continue;
		}
		if (theirs !== undefined && before !== undefined && before.value !== theirs.value && theirs.value !== row.value) {
			conflicts.push({ identity: row.id, reason: "both windows changed this row", retained: row, rejected: theirs });
		}
		merged.set(row.id, row);
	}
	for (const [id, row] of latest) {
		if (merged.has(id)) continue;
		const before = base.get(id);
		if (before !== undefined && before.value === row.value) continue; // removed here, unchanged there
		merged.set(id, row);
	}
	return { value: [...merged.values()], conflicts };
}

function window(paths: CatalogPaths): Promise<CatalogStore> {
	return createCatalogStore({ paths, mergers: { "test.rows.v1": rowsMerger } });
}

async function readDocument(paths: CatalogPaths): Promise<{ revision: number; records: Record<string, unknown>; imports: unknown[]; conflicts: unknown[] }> {
	const text = await readFile(paths.document, "utf8");
	return JSON.parse(text) as { revision: number; records: Record<string, unknown>; imports: unknown[]; conflicts: unknown[] };
}

describe("profile catalog", () => {
	it("commits durably, advances the revision and reports it to this window", async () => {
		const { paths } = await tempCatalog();
		const one = await window(paths);
		assert.equal(one.revision(), 0);
		await one.update("test.rows.v1", [{ id: "a", value: "1" }]);
		assert.equal(one.revision(), 1);
		const document = await readDocument(paths);
		assert.equal(document.revision, 1);
		assert.deepEqual(document.records["test.rows.v1"], [{ id: "a", value: "1" }]);

		// A second window over the same directory sees the committed record.
		const two = await window(paths);
		assert.equal(two.revision(), 1);
		assert.deepEqual(two.get("test.rows.v1"), [{ id: "a", value: "1" }]);
	});

	it("keeps two windows' different rows when both write one record", async () => {
		const { paths } = await tempCatalog();
		const one = await window(paths);
		const two = await window(paths);
		await one.update("test.rows.v1", [{ id: "a", value: "1" }]);
		// Window two read the record before window one committed.
		await two.refresh();
		await two.update("test.rows.v1", [
			{ id: "a", value: "1" },
			{ id: "b", value: "2" },
		]);
		const committed = (await readDocument(paths)).records["test.rows.v1"] as Row[];
		assert.deepEqual(
			committed.map(row => [row.id, row.value]),
			[
				["a", "1"],
				["b", "2"],
			],
			"neither window's row is lost",
		);
	});

	it("merges a stale window's edit into the newest revision and records the disagreement", async () => {
		const { paths } = await tempCatalog();
		const one = await window(paths);
		const two = await window(paths);
		await one.update("test.rows.v1", [
			{ id: "a", value: "1" },
			{ id: "b", value: "2" },
		]);
		// Both windows now hold the same base and change different rows.
		await two.refresh();
		await one.update("test.rows.v1", [
			{ id: "a", value: "1-edited-by-one" },
			{ id: "b", value: "2" },
		]);
		await two.update("test.rows.v1", [
			{ id: "a", value: "1" },
			{ id: "b", value: "2-edited-by-two" },
		]);
		const document = await readDocument(paths);
		assert.deepEqual(
			(document.records["test.rows.v1"] as Row[]).map(row => [row.id, row.value]),
			[
				["a", "1-edited-by-one"],
				["b", "2-edited-by-two"],
			],
			"a stale writer contributes its own delta, not its whole snapshot",
		);
		assert.equal(document.conflicts.length, 0, "different rows are not a conflict");

		// Two windows changing the *same* row is a retained conflict, and this window's
		// own action is the one applied.
		await two.refresh();
		await one.update("test.rows.v1", [
			{ id: "a", value: "a-by-one" },
			{ id: "b", value: "2-edited-by-two" },
		]);
		await two.update("test.rows.v1", [
			{ id: "a", value: "a-by-two" },
			{ id: "b", value: "2-edited-by-two" },
		]);
		const after = await readDocument(paths);
		assert.equal((after.records["test.rows.v1"] as Row[]).find(row => row.id === "a")?.value, "a-by-two");
		assert.equal(after.conflicts.length, 1, "the rejected value is retained for recovery");
	});

	it("adopts another window's commit through refresh and notifies listeners", async () => {
		const { paths } = await tempCatalog();
		const one = await window(paths);
		const two = await window(paths);
		const seen: number[] = [];
		two.onChange(refresh => seen.push(refresh.revision));
		await one.update("test.rows.v1", [{ id: "a", value: "1" }]);
		const refresh = await two.refresh();
		assert.equal(refresh?.revision, 1);
		assert.deepEqual(refresh?.keys, ["test.rows.v1"]);
		assert.deepEqual(seen, [1], "the change is published to this window's listeners");
		assert.deepEqual(two.get("test.rows.v1"), [{ id: "a", value: "1" }]);
		// Nothing new: no second publication.
		assert.equal(await two.refresh(), null);
		assert.deepEqual(seen, [1]);
	});

	it("reports a catalog that cannot be read and refuses to write over it", async () => {
		const { paths } = await tempCatalog();
		const one = await window(paths);
		await one.update("test.rows.v1", [{ id: "a", value: "1" }]);
		// Another build (or a damaged file) leaves something this version cannot read.
		await writeFile(paths.document, "{ not json", "utf8");
		const refusalMessages: string[] = [];
		const two = await createCatalogStore({
			paths,
			mergers: { "test.rows.v1": rowsMerger },
			onUnavailable: reason => refusalMessages.push(reason),
		});
		assert.equal(two.revision(), 0);
		assert.equal(two.get("test.rows.v1"), undefined);
		assert.ok(two.unavailableReason() !== null, "the reason is visible");
		assert.equal(refusalMessages.length, 1, "the unusable catalog is reported once");
		await assert.rejects(() => two.update("test.rows.v1", [{ id: "b", value: "2" }]), (error: unknown) => {
			return error instanceof CatalogError && error.reason === "unavailable";
		});
		assert.equal(await readFile(paths.document, "utf8"), "{ not json", "the unreadable catalog is left exactly as it was");
	});

	it("refuses while another live process holds the lock", async () => {
		const { paths } = await tempCatalog();
		const one = await window(paths);
		await one.update("test.rows.v1", [{ id: "a", value: "1" }]);
		// A lock of *this* process: it is provably alive, so it is never reclaimed.
		await writeFile(paths.lock, JSON.stringify({ token: "held", pid: process.pid, host: osHostname(), at: "now" }), "utf8");
		const two = await window(paths);
		await assert.rejects(() => two.update("test.rows.v1", [{ id: "b", value: "2" }]), (error: unknown) => {
			return error instanceof CatalogError && error.reason === "busy";
		});
		assert.equal(existsSync(paths.lock), true, "the live holder's lock is left alone");
		assert.equal((await readDocument(paths)).revision, 1, "nothing was committed");
	});

	it("reclaims only a lock whose owner is provably gone and old enough, and records it", async () => {
		const { paths } = await tempCatalog();
		const one = await window(paths);
		await one.update("test.rows.v1", [{ id: "a", value: "1" }]);
		// A process id that cannot exist, with an old timestamp.
		await writeFile(
			paths.lock,
			JSON.stringify({ token: "dead", pid: 0x7ffffff0, host: osHostname(), at: "2020-01-01T00:00:00.000Z" }),
			"utf8",
		);
		const two = await createCatalogStore({
			paths,
			mergers: { "test.rows.v1": rowsMerger },
			// A zero stale threshold makes the old lock count as old enough without
			// waiting for the real grace period.
			lockStaleMs: 0,
		});
		await two.update("test.rows.v1", [
			{ id: "a", value: "1" },
			{ id: "b", value: "2" },
		]);
		const document = await readDocument(paths);
		assert.equal(document.revision, 2, "the dead owner's lock was reclaimed and the commit landed");
		assert.equal(document.conflicts.length, 1, "the reclaim is recorded in the ledger");
		assert.equal(existsSync(paths.lock), false, "the lock is released");
	});

	it("does not resurrect a record another window deleted", async () => {
		const { paths } = await tempCatalog();
		const one = await window(paths);
		const two = await window(paths);
		await one.update("test.rows.v1", [
			{ id: "a", value: "1" },
			{ id: "b", value: "2" },
		]);
		await two.refresh();
		// Window two removes one row; window one, holding a stale copy, changes the other.
		await two.update("test.rows.v1", [{ id: "b", value: "2" }]);
		await one.update("test.rows.v1", [
			{ id: "a", value: "1" },
			{ id: "b", value: "2-edited" },
		]);
		const committed = (await readDocument(paths)).records["test.rows.v1"] as Row[];
		assert.deepEqual(
			committed.map(row => [row.id, row.value]),
			[["b", "2-edited"]],
			"the row deleted elsewhere stays deleted; only the changed row is written",
		);
	});

	it("merges against the value this window's consumer read, not the one committed since", async () => {
		const { paths } = await tempCatalog();
		const one = await window(paths);
		await one.update("test.rows.v1", [{ id: "a", value: "1" }]);

		// Window two is constructed before window one's change and has not re-read: its
		// in-memory snapshot is empty, and it now writes that snapshot back unchanged.
		const two = await window(paths);
		await one.update("test.rows.v1", [
			{ id: "a", value: "1" },
			{ id: "b", value: "2" },
		]);
		// A consumer that re-read (the ordinary case after an adoption) cannot delete the
		// other window's row: its next write is a delta against what it read.
		await two.refresh();
		const readBack = two.get<Row[]>("test.rows.v1") ?? [];
		await two.update("test.rows.v1", [
			...readBack,
			{ id: "c", value: "3" },
		]);
		const committed = (await readDocument(paths)).records["test.rows.v1"] as Row[];
		assert.deepEqual(
			committed.map(row => row.id).sort(),
			["a", "b", "c"],
			"nothing another window committed is lost",
		);
	});

	it("refuses while the lock cannot be read, because age is not proof of a dead owner", async () => {
		const { paths } = await tempCatalog();
		const one = await window(paths);
		await one.update("test.rows.v1", [{ id: "a", value: "1" }]);
		await writeFile(paths.lock, "{ not a lock record", "utf8");
		const two = await createCatalogStore({
			paths,
			mergers: { "test.rows.v1": rowsMerger },
			lockTimeoutMs: 150,
			lockStaleMs: 0,
		});
		await assert.rejects(() => two.update("test.rows.v1", [{ id: "b", value: "2" }]), (error: unknown) => {
			return error instanceof CatalogError && error.reason === "busy";
		});
		assert.equal(await readFile(paths.lock, "utf8"), "{ not a lock record", "the ambiguous lock is left alone");
	});

	it("keeps another window's record when a consumer names the base it actually read", async () => {
		const { paths } = await tempCatalog();
		const one = await window(paths);
		const two = await window(paths);
		await one.update("test.rows.v1", [{ id: "a", value: "1" }]);
		// Window two read the empty record and remembers exactly that snapshot.
		const twoBase = two.get<Row[]>("test.rows.v1") ?? [];
		await one.update("test.rows.v1", [
			{ id: "a", value: "1" },
			{ id: "b", value: "2" },
		]);
		// Window two writes its own change and names that snapshot as its base: window one's
		// row is simply newer than what window two saw, not something window two removed.
		await two.update("test.rows.v1", [{ id: "c", value: "3" }], twoBase);
		const committed = (await readDocument(paths)).records["test.rows.v1"] as Row[];
		assert.deepEqual(
			committed.map(row => row.id).sort(),
			["a", "b", "c"],
			"an unrelated record committed since the consumer's snapshot is kept",
		);
	});

	it("watches the document and reports a commit", async () => {
		const { paths } = await tempCatalog();
		const one = await window(paths);
		// This deliberately exercises a real file-system notification, which no fake
		// clock can produce, so the signal is awaited with a bounded guard: the test
		// resolves from the watcher's own callback, not from a guessed delay.
		const arrived = Promise.withResolvers<void>();
		const dispose = startCatalogWatch(paths, () => arrived.resolve(), { debounceMs: 5 });
		const guard = setTimeout(() => arrived.reject(new Error("the watcher reported nothing")), 5_000);
		guard.unref?.();
		try {
			await one.update("test.rows.v1", [{ id: "a", value: "1" }]);
			await arrived.promise;
		} finally {
			clearTimeout(guard);
			dispose();
		}
	});

	it("ignores a commit's staged sibling and reports only the document itself", async () => {
		const { paths } = await tempCatalog();
		const one = await window(paths);
		await one.update("test.rows.v1", [{ id: "a", value: "1" }]);
		let signals = 0;
		const arrived = Promise.withResolvers<void>();
		const dispose = startCatalogWatch(paths, () => { signals += 1; arrived.resolve(); }, { debounceMs: 5 });
		const guard = setTimeout(() => arrived.reject(new Error("the watcher reported nothing")), 5_000);
		guard.unref?.();
		try {
			// What a committing window writes beside the document before it renames over it.
			await writeFile(`${paths.document}.${process.pid}.staged.tmp`, "{}");
			await sleep(250);
			assert.equal(signals, 0, "a re-read triggered by the staged file would hold the document open under the committer's rename");
			await one.update("test.rows.v1", [{ id: "a", value: "1" }, { id: "b", value: "2" }]);
			await arrived.promise;
			assert.ok(signals >= 1);
		} finally {
			clearTimeout(guard);
			dispose();
		}
	});

	it("hands a commit's own document to its caller exactly as it was written", async () => {
		const { paths } = await tempCatalog();
		const result = await transactCatalog(paths, tx => { tx.set("test.key", { nested: [1, 2, { three: 3 }] }); });
		assert.ok(result.changed);
		assert.deepEqual(result.document, await readCatalogDocument(paths));
		const unchanged = await transactCatalog(paths, () => false);
		assert.equal(unchanged.changed, false);
		assert.equal("document" in unchanged, false);
	});

	it("reads the document once per commit, under the lock, and not again to adopt what it just wrote", async () => {
		const { paths } = await tempCatalog();
		const one = await window(paths);
		const adopted: number[] = [];
		one.onChange(refresh => adopted.push(refresh.revision));
		// `profile-catalog.ts` imports the `node:fs` namespace, whose live bindings follow the module object once re-synced.
		const reads: string[] = [];
		const original = fsModule.readFileSync;
		fsModule.readFileSync = ((target: Parameters<typeof original>[0], ...rest: unknown[]) => {
			reads.push(String(target));
			return (original as (...args: unknown[]) => unknown)(target, ...rest);
		}) as typeof original;
		syncBuiltinESMExports();
		try {
			await one.update("test.rows.v1", [{ id: "a", value: "1" }]);
		} finally {
			fsModule.readFileSync = original;
			syncBuiltinESMExports();
		}
		assert.deepEqual(reads.filter(target => target === paths.document), [paths.document], "the transaction's own read under the lock, and no other");
		assert.deepEqual(adopted, [1]);
		assert.deepEqual(one.get<Row[]>("test.rows.v1"), [{ id: "a", value: "1" }]);
		assert.equal(await one.refresh(), null, "nothing newer is on disk, so a refresh has nothing to report");
	});

	it("reads the document within one turn, so a rename over it is never blocked by this window's read", { skip: process.platform !== "win32" }, async () => {
		const { paths } = await tempCatalog();
		const one = await window(paths);
		await one.update("test.rows.v1", [{ id: "a", value: "1" }]);
		const staged = `${paths.document}.${process.pid}.next.tmp`;
		await writeFile(staged, readFileSync(paths.document));
		// An asynchronous read has opened the file by now and keeps it open until its next turns; Windows then refuses the
		// rename. A committing window whose neighbour's loop is stalled at this point waits for the whole stall.
		const reading = readCatalogDocument(paths);
		await nextTurn();
		renameSync(staged, paths.document);
		assert.equal((await reading)?.revision, 1);
	});
});

function conflict(identity: string, n: number, extra: { reason?: string; key?: string; earlier?: number } = {}): CatalogConflictRecord {
	return {
		key: extra.key ?? "test.rows.v1", identity, source: null, at: `2026-10-12T00:00:${String(n).padStart(2, "0")}.000Z`,
		reason: extra.reason ?? "both windows changed this row", retained: { n }, rejected: { n: -n - 1 },
		...(extra.earlier === undefined ? {} : { earlier: extra.earlier }),
	};
}

describe("conflict ledger bound (ADR-0034)", () => {
	it("keeps the newest records of one disagreement and counts the older ones into the oldest it keeps", () => {
		const ledger = [1, 2, 3, 4, 5, 6, 7].map(n => conflict("a", n));
		const compacted = compactConflicts(ledger);
		assert.deepEqual(compacted.map(record => (record.retained as { n: number }).n), [5, 6, 7]);
		assert.deepEqual(compacted.map(record => record.earlier), [4, undefined, undefined]);
	});

	it("never merges different rows, reasons or keys: each disagreement keeps its own records, in ledger order", () => {
		const ledger = [
			conflict("a", 1), conflict("b", 2), conflict("a", 3, { reason: "other reason" }), conflict("a", 4), conflict("c", 5, { key: "other.key" }),
			conflict("a", 6), conflict("b", 7), conflict("a", 8), conflict("a", 9),
		];
		const compacted = compactConflicts(ledger);
		assert.deepEqual(compacted.map(record => (record.retained as { n: number }).n), [2, 3, 5, 6, 7, 8, 9]);
		assert.equal(compacted.find(record => (record.retained as { n: number }).n === 6)?.earlier, 2, "records 1 and 4 were dropped");
		assert.equal(compacted.filter(record => record.identity === "b" && record.earlier !== undefined).length, 0);
		assert.ok(compacted.some(record => record.reason === "other reason"), "a different reason survives a flood of another");
		assert.ok(compacted.some(record => record.key === "other.key"));
	});

	it("carries the count a dropped record already held, and returns the same ledger when nothing is over the bound", () => {
		const ledger = [conflict("a", 1, { earlier: 10 }), conflict("a", 2), conflict("a", 3), conflict("a", 4)];
		const compacted = compactConflicts(ledger);
		assert.deepEqual(compacted.map(record => record.earlier), [11, undefined, undefined]);
		const small = [conflict("a", 1), conflict("a", 2), conflict("b", 3)];
		assert.equal(compactConflicts(small), small);
	});

	it("drops a record whose two sides are the same value, and keeps one that really disagrees", () => {
		const same = { ...conflict("a", 1), retained: { n: 1 }, rejected: { n: 1 }, earlier: 30 };
		const real = conflict("a", 2);
		const removal: CatalogConflictRecord = { ...conflict("a", 3), reason: "removed while changed", rejected: null };
		assert.deepEqual(compactConflicts([same, real, removal]), [real, removal]);
		const unchanged = [real, removal];
		assert.equal(compactConflicts(unchanged), unchanged);
	});

	it("shrinks an oversized ledger on the next ordinary commit, and a transaction that changes nothing leaves the file alone", async () => {
		const { paths } = await tempCatalog();
		const one = await window(paths);
		await one.update("test.rows.v1", [{ id: "a", value: "1" }]);
		// A ledger an earlier build let grow: 40 records of one disagreement and one of another.
		const document = await readDocument(paths);
		const oversized = [...Array.from({ length: 40 }, (_, n) => conflict("a", n)), conflict("b", 41)];
		await writeFile(paths.document, JSON.stringify({ ...document, conflicts: oversized }), "utf8");
		const two = await window(paths);
		assert.equal(two.conflicts().length, 41, "reading never compacts");

		const before = await readFile(paths.document, "utf8");
		await two.run(() => false);
		assert.equal(await readFile(paths.document, "utf8"), before, "no change, no write, no compaction");

		await two.update("test.rows.v1", [{ id: "a", value: "1" }, { id: "b", value: "2" }]);
		const after = await readDocument(paths);
		assert.equal(after.conflicts.length, CATALOG_CONFLICT_GROUP_KEEP + 1);
		assert.equal((after.conflicts[0] as CatalogConflictRecord).earlier, 40 - CATALOG_CONFLICT_GROUP_KEEP);
		assert.equal(two.conflicts().length, CATALOG_CONFLICT_GROUP_KEEP + 1, "this window adopted the compacted ledger");

		const older = await window(paths);
		assert.equal(older.conflicts().length, CATALOG_CONFLICT_GROUP_KEEP + 1);
		assert.equal(older.conflicts()[0]?.earlier, 40 - CATALOG_CONFLICT_GROUP_KEEP, "a reader keeps the count");
	});
});
describe("catalog recovery (ADR-0081)", () => {
	/** A committed catalog with `rows` at `revisions` revisions, as a parsed document taken from another directory. */
	async function backupWith(rows: readonly Row[], revisions = 1): Promise<CatalogDocument> {
		const { paths } = await tempCatalog();
		const source = await window(paths);
		await source.update("test.rows.v1", [...rows]);
		for (let index = 1; index < revisions; index += 1) await source.transact([{ key: "test.tick", apply: () => index }]);
		return parseCatalogDocument(await readFile(paths.document, "utf8"));
	}
	const recoverFrom = (document: CatalogDocument | null, calls: { count: number } = { count: 0 }) => async (): Promise<CatalogRecovery | null> => {
		calls.count += 1;
		return document === null ? null : { document, label: "test backup", info: { calls: calls.count } };
	};
	const noRowsReset = (document: CatalogDocument): boolean => !Array.isArray(document.records["test.rows.v1"]) || (document.records["test.rows.v1"] as Row[]).length === 0;

	it("commits the recovered base over a missing document, even when the operation changes nothing, and reports it once", async () => {
		const backup = await backupWith([{ id: "a", value: "1" }], 5);
		const { paths } = await tempCatalog();
		const reported: unknown[] = [];
		const store = await createCatalogStore({
			paths,
			mergers: { "test.rows.v1": rowsMerger },
			recover: recoverFrom(backup),
			onRecovered: (recovery, committed) => reported.push([recovery.label, committed.revision]),
		});
		assert.equal(store.openedWithoutDocument(), true);
		assert.equal(await store.recoverIfNeeded(), true);
		const document = await readDocument(paths);
		assert.equal(document.revision, backup.revision + 1, "above the recovered revision");
		assert.deepEqual(document.records["test.rows.v1"], [{ id: "a", value: "1" }]);
		assert.equal((document.conflicts as CatalogConflictRecord[]).some(entry => entry.key === "catalog.recovery"), true, "the recovery is on the conflict ledger");
		assert.deepEqual(store.get("test.rows.v1"), [{ id: "a", value: "1" }]);
		assert.deepEqual(reported, [["test backup", backup.revision + 1]]);
		assert.equal(await store.recoverIfNeeded(), false, "asked once");
	});

	it("takes the lock for nothing when the document exists", async () => {
		const { paths } = await tempCatalog();
		const first = await window(paths);
		await first.update("test.rows.v1", [{ id: "a", value: "1" }]);
		const calls = { count: 0 };
		const second = await createCatalogStore({ paths, mergers: { "test.rows.v1": rowsMerger }, recover: recoverFrom(await backupWith([{ id: "z", value: "9" }]), calls) });
		const before = await readFile(paths.document, "utf8");
		assert.equal(await second.recoverIfNeeded(), false);
		assert.equal(calls.count, 0);
		assert.equal(await readFile(paths.document, "utf8"), before, "no revision committed by a normal start");
	});

	it("restores once when two windows start together on a missing document, and the second adopts it", async () => {
		const backup = await backupWith([{ id: "a", value: "1" }, { id: "b", value: "2" }], 3);
		const { paths } = await tempCatalog();
		const calls = { count: 0 };
		const open = (): Promise<CatalogStore> => createCatalogStore({ paths, mergers: { "test.rows.v1": rowsMerger }, recover: recoverFrom(backup, calls) });
		const [one, two] = await Promise.all([open(), open()]);
		const results = await Promise.all([one.recoverIfNeeded(), two.recoverIfNeeded()]);
		assert.equal(results.filter(Boolean).length, 1, "exactly one window committed the restore");
		assert.equal(calls.count, 1, "the second window found the document already restored");
		const expected = [{ id: "a", value: "1" }, { id: "b", value: "2" }];
		assert.deepEqual(one.get("test.rows.v1"), expected);
		assert.deepEqual(two.get("test.rows.v1"), expected, "the window that restored nothing exposes the restored rows without waiting");
		assert.equal(one.revision(), two.revision());
	});

	it("restores over an empty shell that lost to its backup, carrying the shell's own rows by the key's merge rule", async () => {
		const backup = await backupWith([{ id: "a", value: "1" }], 9);
		const { paths } = await tempCatalog();
		const shell = await window(paths);
		await shell.update("test.rows.v1", [{ id: "shell", value: "s" }]);
		await shell.update("test.rows.v1", []);
		await shell.update("test.rows.v1", []);
		const shellDocument = await readDocument(paths);
		assert.equal(shellDocument.revision < backup.revision, true, "the shell is below the backup");
		const reset = (document: CatalogDocument): boolean => noRowsReset(document) && document.revision < backup.revision;
		const store = await createCatalogStore({ paths, mergers: { "test.rows.v1": rowsMerger }, recover: recoverFrom(backup), isReset: reset });
		assert.equal(await store.recoverIfNeeded(), true);
		assert.deepEqual((await readDocument(paths)).records["test.rows.v1"], [{ id: "a", value: "1" }]);
		assert.equal((await readDocument(paths)).revision, backup.revision + 1);
	});

	it("does not call an emptied catalog with a revision at or above its backup a reset", async () => {
		const backup = await backupWith([{ id: "a", value: "1" }], 1);
		const { paths } = await tempCatalog();
		const user = await window(paths);
		await user.update("test.rows.v1", [{ id: "a", value: "1" }]);
		await user.update("test.rows.v1", []);
		await user.update("test.rows.v1", []);
		const calls = { count: 0 };
		const reset = (document: CatalogDocument): boolean => noRowsReset(document) && document.revision < backup.revision;
		const store = await createCatalogStore({ paths, mergers: { "test.rows.v1": rowsMerger }, recover: recoverFrom(backup, calls), isReset: reset });
		assert.equal(await store.recoverIfNeeded(), false);
		assert.equal(calls.count, 0);
	});

	it("recovers a document that vanished under a running window from what the window last read", async () => {
		const { paths } = await tempCatalog();
		const store = await createCatalogStore({ paths, mergers: { "test.rows.v1": rowsMerger }, recover: recoverFrom(null) });
		await store.update("test.rows.v1", [{ id: "a", value: "1" }]);
		await store.update("test.rows.v1", [{ id: "a", value: "1" }, { id: "b", value: "2" }]);
		const known = store.revision();
		await rm(paths.document, { force: true });
		await store.refresh();
		// The refresh started the recovery in the background.
		for (let waited = 0; waited < 4000 && !existsSync(paths.document); waited += 20) await sleep(20);
		const document = await readDocument(paths);
		assert.equal(document.revision > known, true, "never backwards");
		assert.deepEqual(document.records["test.rows.v1"], [{ id: "a", value: "1" }, { id: "b", value: "2" }]);
	});

	it("prefers a newer backup to this window's own last read, and runs the preparation outside the lock", async () => {
		const backup = await backupWith([{ id: "a", value: "1" }, { id: "b", value: "2" }, { id: "c", value: "3" }], 40);
		const { paths } = await tempCatalog();
		const events: string[] = [];
		const store = await createCatalogStore({
			paths,
			mergers: { "test.rows.v1": rowsMerger },
			recover: async () => {
				events.push(`recover lock=${existsSync(paths.lock)}`);
				return { document: backup, label: "test backup", info: null };
			},
			prepareRecovery: async () => {
				events.push(`prepare lock=${existsSync(paths.lock)}`);
			},
		});
		await store.recoverIfNeeded();
		assert.deepEqual(events, ["prepare lock=false", "recover lock=true"]);
	});

	it("adopts a document that reuses its revision with different content", async () => {
		const { paths } = await tempCatalog();
		const one = await window(paths);
		await one.update("test.rows.v1", [{ id: "a", value: "1" }]);
		const seen: string[][] = [];
		one.onChange(refresh => seen.push([...refresh.keys]));
		const text = await readFile(paths.document, "utf8");
		const replaced = JSON.parse(text) as { records: Record<string, unknown> };
		replaced.records["test.rows.v1"] = [{ id: "other", value: "2" }];
		await writeFile(paths.document, JSON.stringify(replaced), "utf8");
		await one.refresh();
		assert.deepEqual(one.get("test.rows.v1"), [{ id: "other", value: "2" }]);
		assert.deepEqual(seen, [["test.rows.v1"]]);
	});

	it("behaves exactly as before without a recovery hook", async () => {
		const { paths } = await tempCatalog();
		const store = await window(paths);
		assert.equal(store.openedWithoutDocument(), true);
		assert.equal(await store.recoverIfNeeded(), false);
		await store.update("test.rows.v1", [{ id: "a", value: "1" }]);
		assert.equal((await readDocument(paths)).revision, 1);
	});
});

/** The host recorded in the lock, which is this machine. */
function osHostname(): string {
	return hostname();
}
