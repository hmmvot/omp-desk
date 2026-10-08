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
import { existsSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { CatalogError, catalogPaths, createCatalogStore, startCatalogWatch } from "./profile-catalog.ts";
import type { CatalogPaths, CatalogStore } from "./profile-catalog.ts";

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

function window(paths: CatalogPaths): CatalogStore {
	return createCatalogStore({ paths, mergers: { "test.rows.v1": rowsMerger } });
}

async function readDocument(paths: CatalogPaths): Promise<{ revision: number; records: Record<string, unknown>; imports: unknown[]; conflicts: unknown[] }> {
	const text = await readFile(paths.document, "utf8");
	return JSON.parse(text) as { revision: number; records: Record<string, unknown>; imports: unknown[]; conflicts: unknown[] };
}

describe("profile catalog", () => {
	it("commits durably, advances the revision and reports it to this window", async () => {
		const { paths } = await tempCatalog();
		const one = window(paths);
		assert.equal(one.revision(), 0);
		await one.update("test.rows.v1", [{ id: "a", value: "1" }]);
		assert.equal(one.revision(), 1);
		const document = await readDocument(paths);
		assert.equal(document.revision, 1);
		assert.deepEqual(document.records["test.rows.v1"], [{ id: "a", value: "1" }]);

		// A second window over the same directory sees the committed record.
		const two = window(paths);
		assert.equal(two.revision(), 1);
		assert.deepEqual(two.get("test.rows.v1"), [{ id: "a", value: "1" }]);
	});

	it("keeps two windows' different rows when both write one record", async () => {
		const { paths } = await tempCatalog();
		const one = window(paths);
		const two = window(paths);
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
		const one = window(paths);
		const two = window(paths);
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
		const one = window(paths);
		const two = window(paths);
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
		const one = window(paths);
		await one.update("test.rows.v1", [{ id: "a", value: "1" }]);
		// Another build (or a damaged file) leaves something this version cannot read.
		await writeFile(paths.document, "{ not json", "utf8");
		const refusalMessages: string[] = [];
		const two = createCatalogStore({
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
		const one = window(paths);
		await one.update("test.rows.v1", [{ id: "a", value: "1" }]);
		// A lock of *this* process: it is provably alive, so it is never reclaimed.
		await writeFile(paths.lock, JSON.stringify({ token: "held", pid: process.pid, host: osHostname(), at: "now" }), "utf8");
		const two = window(paths);
		await assert.rejects(() => two.update("test.rows.v1", [{ id: "b", value: "2" }]), (error: unknown) => {
			return error instanceof CatalogError && error.reason === "busy";
		});
		assert.equal(existsSync(paths.lock), true, "the live holder's lock is left alone");
		assert.equal((await readDocument(paths)).revision, 1, "nothing was committed");
	});

	it("reclaims only a lock whose owner is provably gone and old enough, and records it", async () => {
		const { paths } = await tempCatalog();
		const one = window(paths);
		await one.update("test.rows.v1", [{ id: "a", value: "1" }]);
		// A process id that cannot exist, with an old timestamp.
		await writeFile(
			paths.lock,
			JSON.stringify({ token: "dead", pid: 0x7ffffff0, host: osHostname(), at: "2020-01-01T00:00:00.000Z" }),
			"utf8",
		);
		const two = createCatalogStore({
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
		const one = window(paths);
		const two = window(paths);
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
		const one = window(paths);
		await one.update("test.rows.v1", [{ id: "a", value: "1" }]);

		// Window two is constructed before window one's change and has not re-read: its
		// in-memory snapshot is empty, and it now writes that snapshot back unchanged.
		const two = window(paths);
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
		const one = window(paths);
		await one.update("test.rows.v1", [{ id: "a", value: "1" }]);
		await writeFile(paths.lock, "{ not a lock record", "utf8");
		const two = createCatalogStore({
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
		const one = window(paths);
		const two = window(paths);
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
		const one = window(paths);
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
});

/** The host recorded in the lock, which is this machine. */
function osHostname(): string {
	return hostname();
}
