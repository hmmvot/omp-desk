/**
 * Tests for the private catalog backup and its restore (ADR-0081).
 *
 * Runner: `node --test src/host/catalog-backup.test.ts`
 *
 * Everything runs on temp directories with injected clocks, timers, owner-only verdicts and process identities, so no test
 * depends on this machine's ACLs, its processes or its real recovery folder.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import {
	BACKUP_MIN_INTERVAL_MS,
	BROKER_COPY_MAX_AGE_MS,
	BROKER_TOUCH_MS,
	CatalogBackupWriter,
	NOTICE_WINDOW_MS,
	ORPHAN_FOLDER_MAX_AGE_MS,
	RETAIN_NEWEST,
	brokerLife,
	cachedVerdict,
	catalogContent,
	claimNotice,
	copyName,
	createRecoverySource,
	listCopies,
	locateRecovery,
	parseCopyName,
	recoveryBase,
	recoveryKey,
	restoreBrokerRecords,
	restrictRecoveryFolder,
	retainedCopies,
	sweepRecoveryBase,
	restoreInfoOf,
	userDataDirectoryOf,
} from "./catalog-backup.ts";
import type { BackupWriterDeps, CatalogContentKeys, CatalogCopy, CatalogRegression, RecoveryLocation, RecoverySource, RecoverySourceDeps } from "./catalog-backup.ts";
import { catalogPaths, createCatalogStore, readCatalogDocument } from "./profile-catalog.ts";
import type { CatalogPaths, CatalogRecordMerger } from "./profile-catalog.ts";
import type { PrivateStorageCommandResult, PrivateStorageProbe } from "../wire/private-storage.ts";
import { TEST_CURRENT_SID, fixtureAcl, fixturePrincipal } from "./private-storage-test-support.ts";
import type { PtyIdentityReading } from "../wire/pty-identity.ts";
import { PTY_PROTOCOL_VERSION, PTY_RECORD_VERSION, PTY_SERVICE, createPtyToken } from "../wire/pty-protocol.ts";
import type { PtyBrokerRecord } from "../wire/pty-protocol.ts";
import { claimPtyRecord, ptyRecordPath, readPtyRecord } from "../wire/pty-registry.ts";

const DAY = 24 * 60 * 60_000;
const KEYS: CatalogContentKeys = { sessions: "test.sessions", folders: "test.folders" };
const OK = async () => ({ ok: true, reason: null });
const roots: string[] = [];

after(async () => {
	for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function temp(): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), "omp-backup-"));
	roots.push(dir);
	return dir;
}

interface Fixture {
	readonly base: string;
	readonly storage: string;
	readonly location: RecoveryLocation;
	readonly paths: CatalogPaths;
}

/** A user-data directory with its storage folder, and a recovery base beside it. */
async function fixture(): Promise<Fixture> {
	const dir = await temp();
	const storage = path.join(dir, "userdata", "User", "globalStorage", "publisher.extension");
	await mkdir(storage, { recursive: true });
	const base = path.join(dir, "recovery");
	const location = locateRecovery(storage, base) as RecoveryLocation;
	await mkdir(location.catalogDirectory, { recursive: true });
	await mkdir(location.brokersDirectory, { recursive: true });
	return { base, storage, location, paths: catalogPaths(storage) };
}

const rowsMerger: CatalogRecordMerger = ({ desired }) => ({ value: desired });
const MERGERS = { [KEYS.sessions]: rowsMerger, [KEYS.folders]: rowsMerger };

/** Commit a catalog state to `storage` through a real store. */
async function commit(storage: string, rows: number, folders: number, extra = 0): Promise<CatalogPaths> {
	const paths = catalogPaths(storage);
	const store = await createCatalogStore({ paths, mergers: MERGERS });
	await store.transact([
		{ key: KEYS.sessions, apply: () => ({ entries: Array.from({ length: rows }, (_unused, index) => ({ tabId: `tab:${index}` })) }) },
		{ key: KEYS.folders, apply: () => ({ folders: Array.from({ length: folders }, (_unused, index) => ({ id: `f${index}` })) }) },
	]);
	for (let index = 0; index < extra; index += 1) await store.transact([{ key: "test.tick", apply: () => index }]);
	return paths;
}

interface FakeClock {
	now(): number;
	advance(ms: number): void;
	setTimer(callback: () => void, ms: number): () => void;
	/** Fire every live timer due by `now`. */
	fire(): void;
	pending(): number;
}

/** The number of session rows in a stored sessions record. */
function rowCount(value: unknown): number {
	return typeof value === "object" && value !== null && "entries" in value && Array.isArray(value.entries) ? value.entries.length : -1;
}
/** A manual clock and timers. */
function clock(start = Date.UTC(2026, 9, 21, 12)): FakeClock {
	let now = start;
	const timers: { at: number; callback: () => void; cancelled: boolean }[] = [];
	return {
		now: () => now,
		advance(ms: number) {
			now += ms;
		},
		setTimer(callback: () => void, ms: number) {
			const timer = { at: now + ms, callback, cancelled: false };
			timers.push(timer);
			return () => {
				timer.cancelled = true;
			};
		},
		/** Fire every live timer due by `now`. */
		fire() {
			for (const timer of timers.filter(entry => !entry.cancelled && entry.at <= now)) {
				timer.cancelled = true;
				timer.callback();
			}
		},
		pending: () => timers.filter(entry => !entry.cancelled).length,
	};
}

function writer(fx: Fixture, overrides: Partial<BackupWriterDeps> = {}, time: FakeClock = clock()) {
	const logs: string[] = [];
	const instance = new CatalogBackupWriter({
		location: fx.location,
		storageDir: fx.storage,
		documentPath: fx.paths.document,
		keys: KEYS,
		ensurePrivate: OK,
		now: time.now,
		setTimer: time.setTimer,
		log: (level, message) => logs.push(`${level}: ${message}`),
		brokerRecords: async () => [],
		queryIdentity: async () => ({ kind: "gone" }),
		...overrides,
	});
	return { instance, logs, time };
}

const names = async (directory: string): Promise<string[]> => (await readdir(directory).catch(() => [] as string[])).sort();
/** A kernel creation time is 10 to 20 digits; the tests name short stamps and this pads them. */
const stamp = (value: string): string => value.padEnd(12, "0");

function brokerRecord(slot: string, pid = 4242, creation: string | null = "134349421014308869"): PtyBrokerRecord {
	return {
		version: PTY_RECORD_VERSION,
		service: PTY_SERVICE,
		protocolVersion: PTY_PROTOCOL_VERSION,
		runtimeVersion: 1,
		treeDigest: "a".repeat(64),
		brokerId: "pty-11111111-2222-3333-4444-555555555555",
		generation: "gen-11111111-2222-3333-4444-555555555555",
		slot,
		kind: "managed-omp",
		port: 51234,
		token: createPtyToken(),
		brokerPid: pid,
		brokerCreationTime: creation === null ? null : stamp(creation),
		startedAt: new Date(0).toISOString(),
		cols: 100,
		rows: 30,
		title: null,
	};
}

const identityOf = (live: Record<number, string>) => async (pid: number): Promise<PtyIdentityReading> => {
	const creation = live[pid];
	return creation === undefined ? { kind: "gone" } : { kind: "found", creationTime: stamp(creation) };
};

describe("recovery location", () => {
	it("keys a storage by its normalised, case-insensitive path", () => {
		assert.equal(recoveryKey("C:\\Users\\a\\Code\\User\\globalStorage\\x.y"), recoveryKey("c:\\users\\a\\code\\user\\globalstorage\\x.y\\"));
		assert.notEqual(recoveryKey("C:\\one"), recoveryKey("C:\\two"));
		assert.match(recoveryKey("C:\\one"), /^[0-9a-f]{16}$/);
	});

	it("resolves the root: override, then LOCALAPPDATA, then the profile, and none when nothing resolves", () => {
		assert.equal(recoveryBase({ OMP_DESK_RECOVERY_ROOT: "D:\\r" }, "win32", "C:\\home"), path.resolve("D:\\r"));
		assert.equal(recoveryBase({ LOCALAPPDATA: path.resolve("/appdata") }, "win32", "/home"), path.join(path.resolve("/appdata"), "omp-desk", "recovery"));
		assert.equal(recoveryBase({}, "win32", "/home"), path.join("/home", "AppData", "Local", "omp-desk", "recovery"));
		assert.equal(recoveryBase({}, "win32", ""), null);
		assert.equal(locateRecovery("C:\\x", null), null);
	});

	it("names the user-data directory above the storage folder", () => {
		assert.equal(userDataDirectoryOf(path.join("/d", "u", "User", "globalStorage", "x.y")), path.resolve("/d", "u"));
	});

	it("brings the folder under the owner-only convention before use, and reports a refusal", async () => {
		const fx = await fixture();
		const account = "WORKSTATION\\dev";
		const ownerOnly = [account, "NT AUTHORITY\\SYSTEM", "BUILTIN\\Administrators"];
		const probe = (principals: readonly string[]): PrivateStorageProbe => ({
			platform: "win32",
			currentSid: TEST_CURRENT_SID,
			readAcl: async (): Promise<PrivateStorageCommandResult> => ({ ok: true, stdout: fixtureAcl(principals.map(principal => `${principal}:(OI)(CI)(F)`)), detail: null }),
			applyIcacls: async (): Promise<PrivateStorageCommandResult> => ({ ok: true, stdout: "", detail: null }),
			readOwners: async (paths: readonly string[]): Promise<PrivateStorageCommandResult> => ({ ok: true, stdout: paths.map(target => `${target}|${fixturePrincipal(account)}`).join("\r\n"), detail: null }),
		});
		assert.deepEqual(await restrictRecoveryFolder(fx.location, probe(ownerOnly))(), { ok: true, reason: null });
		const refused = await restrictRecoveryFolder(fx.location, probe([...ownerOnly, "Everyone"]))();
		assert.equal(refused.ok, false);
		assert.match(refused.reason ?? "", /Everyone/);
	});

	it("remembers a pass for the process and a failure for a minute", async () => {
		let calls = 0;
		const time = clock();
		const verdict = cachedVerdict(async () => {
			calls += 1;
			return calls === 1 ? { ok: false, reason: "no" } : { ok: true, reason: null };
		}, time.now);
		assert.equal((await verdict()).ok, false);
		await verdict();
		assert.equal(calls, 1);
		time.advance(61_000);
		assert.equal((await verdict()).ok, true);
		await verdict();
		assert.equal(calls, 2);
	});
});

describe("copy names and retention", () => {
	it("round-trips a name and refuses a stranger", () => {
		const entry = { generation: 2, revision: 7979, rows: 40, folders: 3, hash: "deadbeef" };
		assert.deepEqual(parseCopyName(copyName(entry)), { ...entry, name: "catalog-g2-r7979-c40x3-deadbeef.json" });
		assert.equal(parseCopyName("catalog.json"), null);
		assert.equal(parseCopyName("catalog-g1-r1-c1x1-xyz.json"), null);
	});

	const copy = (generation: number, revision: number, size: number, daysAgo: number, now: number): CatalogCopy => ({
		...(parseCopyName(copyName({ generation, revision, rows: size, folders: 0, hash: "00000000" })) as Omit<CatalogCopy, "mtimeMs">),
		mtimeMs: now - daysAgo * DAY,
	});

	it("keeps the newest six, the newest of each of the last seven days, and the peak", () => {
		const now = Date.UTC(2026, 9, 21, 12);
		const copies: CatalogCopy[] = [];
		// The real catalog, then 20 newer, smaller ones (the incident's shape), all within the day.
		copies.push(copy(1, 7979, 40, 1, now));
		for (let revision = 1; revision <= 20; revision += 1) copies.push(copy(2, revision, 2, 0, now));
		// One per earlier day, and an old one outside every window.
		for (let day = 2; day <= 9; day += 1) copies.push(copy(1, 7979 - day, 5, day, now));
		const keep = retainedCopies(copies, now);
		assert.equal(keep.has(copyName({ generation: 1, revision: 7979, rows: 40, folders: 0, hash: "00000000" })), true, "the peak survives 20 newer smaller copies");
		assert.equal(copies.filter(entry => keep.has(entry.name) && entry.generation === 2).length, RETAIN_NEWEST - 0 > 0 ? RETAIN_NEWEST : 0, "the newest six of the newest generation");
		const olderDays = copies.filter(entry => entry.generation === 1 && entry.revision !== 7979 && keep.has(entry.name)).length;
		assert.ok(olderDays >= 5 && olderDays <= 6, `one per earlier day within the week, kept ${olderDays}`);
		assert.equal(keep.has(copyName({ generation: 1, revision: 7979 - 9, rows: 5, folders: 0, hash: "00000000" })), false, "outside every window");
	});

	it("orders by generation before revision, never by revision alone", () => {
		const now = Date.UTC(2026, 9, 21, 12);
		const old = copy(1, 7979, 3, 0, now);
		const repaired = copy(2, 13, 3, 0, now);
		const keep = retainedCopies([old, repaired], now);
		assert.equal(keep.size, 2);
	});
});

describe("backup writer", () => {
	it("copies a committed catalog under a name that carries its generation, revision and content", async () => {
		const fx = await fixture();
		await commit(fx.storage, 3, 2);
		const { instance } = writer(fx);
		await instance.flush();
		const copies = await listCopies(fx.location.catalogDirectory);
		assert.equal(copies.length, 1);
		assert.equal(copies[0]?.generation, 1);
		assert.equal(copies[0]?.rows, 3);
		assert.equal(copies[0]?.folders, 2);
		assert.equal(await readFile(path.join(fx.location.catalogDirectory, copies[0]?.name ?? ""), "utf8"), await readFile(fx.paths.document, "utf8"), "byte for byte");
		const source: RecoverySource = JSON.parse(await readFile(path.join(fx.location.root, "source.json"), "utf8"));
		assert.equal(source.userDataDirectory, userDataDirectoryOf(fx.storage));
	});

	it("writes nothing for an empty first catalog, a missing one, or an unreadable one", async () => {
		const fx = await fixture();
		const { instance } = writer(fx);
		await instance.flush();
		await commit(fx.storage, 0, 0);
		await instance.flush();
		await writeFile(fx.paths.document, "{ not json", "utf8");
		await instance.flush();
		assert.deepEqual(await names(fx.location.catalogDirectory), []);
	});

	it("limits writes to one per interval: the leading edge at once, one trailing write after", async () => {
		const fx = await fixture();
		const time = clock();
		const { instance } = writer(fx, {}, time);
		await commit(fx.storage, 1, 0);
		instance.notifyChange();
		await instance.flush();
		assert.equal((await listCopies(fx.location.catalogDirectory)).length, 1);

		await commit(fx.storage, 2, 0);
		time.advance(5_000);
		instance.notifyChange();
		instance.notifyChange();
		assert.equal(time.pending(), 1, "one trailing write is scheduled for the burst");
		assert.equal((await listCopies(fx.location.catalogDirectory)).length, 1, "nothing written inside the interval");
		time.advance(BACKUP_MIN_INTERVAL_MS);
		time.fire();
		await instance.flush();
		const copies = await listCopies(fx.location.catalogDirectory);
		assert.equal(copies.length, 2);
		assert.equal(copies[0]?.rows, 2);
	});

	it("does not write a document it already holds", async () => {
		const fx = await fixture();
		await commit(fx.storage, 2, 0);
		const { instance } = writer(fx);
		await instance.flush();
		await instance.flush();
		assert.equal((await listCopies(fx.location.catalogDirectory)).length, 1);
	});

	it("starts a new generation for a replaced catalog and keeps the earlier one, and does not copy a wiped shell", async () => {
		const fx = await fixture();
		const time = clock();
		await commit(fx.storage, 5, 1, 9);
		const { instance } = writer(fx, {}, time);
		await instance.flush();
		const before = (await listCopies(fx.location.catalogDirectory))[0];
		assert.ok(before && before.revision >= 10);

		// A wipe, then a fresh empty catalog that gains revisions.
		await rm(fx.paths.document, { force: true });
		await commit(fx.storage, 0, 0, 2);
		await instance.flush();
		assert.equal((await listCopies(fx.location.catalogDirectory)).length, 1, "the empty shell is not an incarnation worth keeping");

		// An operator replaces the catalog with a smaller one at a lower revision.
		const regressions: CatalogRegression[] = [];
		const replaced = writer(fx, { onRegressed: regression => regressions.push(regression) }, time);
		await rm(fx.paths.document, { force: true });
		await commit(fx.storage, 2, 0, 0);
		await replaced.instance.flush();
		const copies = await listCopies(fx.location.catalogDirectory);
		assert.equal(copies.length, 2);
		assert.equal(copies[0]?.generation, 2, "the replacement is the newest generation");
		assert.equal(copies[1]?.generation, 1, "the earlier incarnation is kept");
		assert.equal(regressions.length, 1);
		assert.deepEqual(regressions[0]?.before, { rows: 5, folders: 1 });
	});

	it("keeps an emptied catalog's own empty copy as the newest of its generation", async () => {
		const fx = await fixture();
		await commit(fx.storage, 3, 0);
		const { instance, time } = writer(fx);
		await instance.flush();
		time.advance(2 * BACKUP_MIN_INTERVAL_MS);
		await commit(fx.storage, 0, 0);
		await instance.flush();
		const copies = await listCopies(fx.location.catalogDirectory);
		assert.equal(copies[0]?.rows, 0);
		assert.equal(copies[0]?.generation, copies[1]?.generation);
	});

	it("stays off and reports once when the recovery folder cannot be shown owner-only", async () => {
		const fx = await fixture();
		await commit(fx.storage, 2, 0);
		const reasons: string[] = [];
		const { instance, logs } = writer(fx, { ensurePrivate: async () => ({ ok: false, reason: "Everyone has access" }), onUnusable: reason => reasons.push(reason) });
		await instance.flush();
		await instance.flush();
		assert.deepEqual(await names(fx.location.catalogDirectory), []);
		assert.deepEqual(reasons, ["Everyone has access"]);
		assert.equal(logs.filter(line => line.startsWith("warn")).length, 1);
	});

	it("prunes by the retention rule while writing", async () => {
		const fx = await fixture();
		const time = clock();
		const { instance } = writer(fx, {}, time);
		for (let round = 0; round < 12; round += 1) {
			await commit(fx.storage, 1, 0, 1);
			time.advance(BACKUP_MIN_INTERVAL_MS + 1);
			await instance.flush();
		}
		const copies = await listCopies(fx.location.catalogDirectory);
		assert.ok(copies.length <= RETAIN_NEWEST + 2, `kept ${copies.length}`);
		assert.equal(copies[0]?.revision, (await listCopies(fx.location.catalogDirectory)).reduce((max, entry) => Math.max(max, entry.revision), 0));
	});
});

describe("broker record copies", () => {
	it("copies the record of a live broker, and not that of a gone one", async () => {
		const fx = await fixture();
		const live = brokerRecord("tab:live", 100, "111");
		const dead = brokerRecord("tab:dead", 200, "222");
		const time = clock();
		const { instance } = writer(fx, { brokerRecords: async () => [live, dead], queryIdentity: identityOf({ 100: "111" }) }, time);
		await instance.flush();
		assert.deepEqual(await names(fx.location.brokersDirectory), [path.basename(ptyRecordPath(fx.storage, "tab:live"))]);
		const copied: PtyBrokerRecord = JSON.parse(await readFile(path.join(fx.location.brokersDirectory, path.basename(ptyRecordPath(fx.storage, "tab:live"))), "utf8"));
		assert.equal(copied.token, live.token, "the token is what the copy is for");
	});

	it("removes a copy whose broker is provably gone, including a pid reused by a later process", async () => {
		const fx = await fixture();
		const record = brokerRecord("tab:one", 100, "111");
		const copyPath = path.join(fx.location.brokersDirectory, path.basename(ptyRecordPath(fx.storage, "tab:one")));
		await writeFile(copyPath, `${JSON.stringify(record)}\n`);
		const time = clock();
		const reused = writer(fx, { queryIdentity: identityOf({ 100: "999" }) }, time);
		await reused.instance.flush();
		assert.equal(existsSync(copyPath), false);
	});

	it("never removes a copy because its source record is missing, and refreshes the age of a live one", async () => {
		const fx = await fixture();
		const record = brokerRecord("tab:one", 100, "111");
		const copyPath = path.join(fx.location.brokersDirectory, path.basename(ptyRecordPath(fx.storage, "tab:one")));
		await writeFile(copyPath, `${JSON.stringify(record)}\n`);
		const time = clock();
		const stale = new Date(time.now() - (BROKER_TOUCH_MS + 1_000));
		await utimes(copyPath, stale, stale);
		const { instance } = writer(fx, { brokerRecords: async () => [], queryIdentity: identityOf({ 100: "111" }) }, time);
		await instance.flush();
		assert.equal(existsSync(copyPath), true);
		assert.ok((await stat(copyPath)).mtimeMs >= time.now() - 1_000, "its age says still alive");
	});

	it("removes a copy nobody refreshed for fourteen days when the broker cannot be probed", async () => {
		const fx = await fixture();
		const record = brokerRecord("tab:one", 100, null);
		const copyPath = path.join(fx.location.brokersDirectory, path.basename(ptyRecordPath(fx.storage, "tab:one")));
		await writeFile(copyPath, `${JSON.stringify(record)}\n`);
		const time = clock();
		const young = writer(fx, { queryIdentity: identityOf({ 100: "111" }) }, time);
		await young.instance.flush();
		assert.equal(existsSync(copyPath), true, "unknown and young: kept");
		const old = new Date(time.now() - (BROKER_COPY_MAX_AGE_MS + DAY));
		await utimes(copyPath, old, old);
		time.advance(2 * 60_000);
		await young.instance.flush();
		assert.equal(existsSync(copyPath), false);
	});

	it("classifies a record by the kernel's creation time", async () => {
		const record = brokerRecord("tab:one", 100, "111");
		assert.equal(await brokerLife(record, identityOf({ 100: "111" })), "alive");
		assert.equal(await brokerLife(record, identityOf({ 100: "222" })), "gone");
		assert.equal(await brokerLife(record, identityOf({})), "gone");
		assert.equal(await brokerLife(record, async () => ({ kind: "unknown", detail: "x" })), "unknown");
		assert.equal(await brokerLife(brokerRecord("tab:one", 100, null), identityOf({ 100: "111" })), "unknown");
	});
});

describe("restore source", () => {
	async function backedUp(rows: number, folders: number, extra = 0): Promise<{ fx: Fixture; time: FakeClock }> {
		const fx = await fixture();
		await commit(fx.storage, rows, folders, extra);
		const time = clock();
		await writer(fx, {}, time).instance.flush();
		return { fx, time };
	}
	const source = (fx: Fixture, overrides: Partial<RecoverySourceDeps> = {}) =>
		createRecoverySource({ location: fx.location, storageDir: fx.storage, keys: KEYS, ensurePrivate: OK, ensurePtyAccess: OK, queryIdentity: identityOf({}), ...overrides });

	it("offers the highest revision of the newest generation, whatever it holds", async () => {
		const { fx, time } = await backedUp(4, 1, 3);
		await commit(fx.storage, 0, 0);
		time.advance(2 * BACKUP_MIN_INTERVAL_MS);
		await writer(fx, {}, time).instance.flush();
		const recovered = await source(fx).recover(null);
		assert.ok(recovered);
		assert.deepEqual(catalogContent(recovered.document, KEYS), { rows: 0, folders: 0 }, "the catalog its user emptied is restored as the user left it");
	});

	it("tries an older copy when the newest does not validate, and says so", async () => {
		const { fx, time } = await backedUp(4, 1);
		await commit(fx.storage, 5, 1);
		time.advance(2 * BACKUP_MIN_INTERVAL_MS);
		await writer(fx, {}, time).instance.flush();
		const [newest] = await listCopies(fx.location.catalogDirectory);
		await writeFile(path.join(fx.location.catalogDirectory, newest?.name ?? ""), "{ damaged", "utf8");
		const logs: string[] = [];
		const recovered = await source(fx, { log: (_level, message) => logs.push(message) }).recover(null);
		assert.ok(recovered);
		assert.deepEqual(catalogContent(recovered.document, KEYS), { rows: 4, folders: 1 });
		assert.equal(restoreInfoOf(recovered)?.refused.length, 1);
	});

	it("returns nothing when there is no copy, when the folder is not owner-only, or when no copy validates", async () => {
		const fx = await fixture();
		assert.equal(await source(fx).recover(null), null);
		assert.deepEqual(await source(fx).inspect(), { state: "none" });

		const { fx: withCopy } = await backedUp(2, 0);
		const logs: string[] = [];
		const refused = source(withCopy, { ensurePrivate: async () => ({ ok: false, reason: "Everyone" }), log: (_level, message) => logs.push(message) });
		assert.equal(await refused.recover(null), null);
		assert.match(logs.join("\n"), /backup exists but was not used/);
		const inspected = await refused.inspect();
		assert.equal(inspected.state, "unusable");

		const [only] = await listCopies(withCopy.location.catalogDirectory);
		await writeFile(path.join(withCopy.location.catalogDirectory, only?.name ?? ""), "nope", "utf8");
		assert.equal(await source(withCopy).recover(null), null);
		assert.equal((await source(withCopy).inspect()).state, "unusable");
	});

	it("reads an empty shell below a substantive copy as reset, and nothing else", async () => {
		const { fx } = await backedUp(3, 1, 4);
		const current = source(fx);
		const read = async (rows: number, extra: number): Promise<boolean> => {
			const dir = await temp();
			await commit(dir, rows, 0, extra);
			const document = await readCatalogDocument(catalogPaths(dir));
			assert.ok(document);
			return current.isReset(document);
		};
		assert.equal(await read(0, 0), true, "an empty catalog far below the copy");
		assert.equal(await read(1, 0), false, "any row is not a shell");
		assert.equal(await read(0, 9), false, "an emptied catalog at or above the copy's revision");
	});

	it("restores the records of running brokers to their slot paths, validated and without replacing one", async () => {
		const { fx } = await backedUp(2, 0);
		const live = brokerRecord("tab:live", 100, "111");
		const dead = brokerRecord("tab:dead", 200, "222");
		const present = brokerRecord("tab:present", 300, "333");
		for (const record of [live, dead, present]) {
			await writeFile(path.join(fx.location.brokersDirectory, path.basename(ptyRecordPath(fx.storage, record.slot))), `${JSON.stringify(record)}\n`);
		}
		await writeFile(path.join(fx.location.brokersDirectory, "stranger.json"), `${JSON.stringify(brokerRecord("tab:other", 100, "111"))}\n`);
		await writeFile(path.join(fx.location.brokersDirectory, "garbage.json"), "garbage");
		await claimPtyRecord(fx.storage, { ...present, token: "x".repeat(43) });
		const report = await restoreBrokerRecords(fx.storage, fx.location, identityOf({ 100: "111", 300: "333" }));
		assert.equal(report.restored, 1);
		assert.equal(report.considered, 5);
		const restored = await readPtyRecord(fx.storage, "tab:live");
		assert.equal(restored.kind === "ok" ? restored.record.token : "", live.token);
		assert.equal((await readPtyRecord(fx.storage, "tab:dead")).kind, "none", "a record of a process that is not running is not published");
		const kept = await readPtyRecord(fx.storage, "tab:present");
		assert.equal(kept.kind === "ok" ? kept.record.token : "", "x".repeat(43), "an existing record is never replaced");
		assert.equal(report.skipped.length, 4);
	});

	it("publishes no token into a pty folder that cannot be shown owner-only, and still restores the catalog", async () => {
		const { fx } = await backedUp(2, 0);
		const live = brokerRecord("tab:live", 100, "111");
		await writeFile(path.join(fx.location.brokersDirectory, path.basename(ptyRecordPath(fx.storage, live.slot))), `${JSON.stringify(live)}\n`);
		const recovered = await source(fx, { ensurePtyAccess: async () => ({ ok: false, reason: "Everyone" }), queryIdentity: identityOf({ 100: "111" }) }).recover(null);
		assert.ok(recovered);
		assert.equal((await readPtyRecord(fx.storage, "tab:live")).kind, "none");
		assert.match(restoreInfoOf(recovered)?.brokers.skipped.join(" ") ?? "", /pty folder cannot be shown owner-only/);
	});

	it("takes the verdicts before the lock through prepare, and only when a copy exists", async () => {
		const fx = await fixture();
		let calls = 0;
		const counting = async () => {
			calls += 1;
			return { ok: true, reason: null };
		};
		await source(fx, { ensurePrivate: counting, ensurePtyAccess: counting }).prepare();
		assert.equal(calls, 0, "no copy, no verification");
		const { fx: withCopy } = await backedUp(1, 0);
		await source(withCopy, { ensurePrivate: counting, ensurePtyAccess: counting }).prepare();
		assert.equal(calls, 2);
	});
});

describe("wipe and restore through the catalog store", () => {
	it("restores the catalog and the running broker's record after the storage folder is deleted, then adopts it in a second window", async () => {
		const fx = await fixture();
		await commit(fx.storage, 6, 2, 3);
		const live = brokerRecord("tab:live", 100, "111");
		await claimPtyRecord(fx.storage, live);
		const identity = identityOf({ 100: "111" });
		const time = clock();
		const { instance } = writer(fx, { brokerRecords: async () => [live], queryIdentity: identity }, time);
		await instance.flush();
		const expected = await readFile(fx.paths.document, "utf8");

		// VS Code deletes the storage folder.
		await rm(fx.storage, { recursive: true, force: true });
		await mkdir(fx.storage, { recursive: true });

		const recovery = createRecoverySource({ location: fx.location, storageDir: fx.storage, keys: KEYS, ensurePrivate: OK, ensurePtyAccess: OK, queryIdentity: identity });
		const open = () => createCatalogStore({
			paths: fx.paths,
			mergers: MERGERS,
			recover: recovery.recover,
			isReset: recovery.isReset,
			prepareRecovery: recovery.prepare,
		});
		const [one, two] = await Promise.all([open(), open()]);
		const results = await Promise.all([one.recoverIfNeeded(), two.recoverIfNeeded()]);
		assert.equal(results.filter(Boolean).length, 1);
		for (const store of [one, two]) assert.equal(rowCount(store.get(KEYS.sessions)), 6);
		const restored: { revision: number } = JSON.parse(await readFile(fx.paths.document, "utf8"));
		const before: { revision: number } = JSON.parse(expected);
		assert.equal(restored.revision, before.revision + 1);
		const record = await readPtyRecord(fx.storage, "tab:live");
		assert.equal(record.kind === "ok" ? record.record.token : "", live.token, "the broker's token is back");
	});
});

describe("sweep of the recovery base", () => {
	it("removes the broker copies of provably gone brokers in other folders, and a folder whose user-data directory is gone and untouched for half a year", async () => {
		const base = await temp();
		const time = clock();
		const make = async (key: string, userData: string, ageDays: number): Promise<string> => {
			const folder = path.join(base, key);
			await mkdir(path.join(folder, "brokers"), { recursive: true });
			await writeFile(path.join(folder, "source.json"), JSON.stringify({ storagePath: "x", userDataDirectory: userData, writtenAt: "x" }));
			await writeFile(path.join(folder, "brokers", "pty-aaaa.json"), `${JSON.stringify(brokerRecord("tab:one", 100, "111"))}\n`);
			const when = new Date(time.now() - ageDays * DAY);
			for (const target of [path.join(folder, "brokers", "pty-aaaa.json"), path.join(folder, "brokers"), path.join(folder, "source.json"), folder]) await utimes(target, when, when);
			return folder;
		};
		const own = await make("0000000000000001", base, 0);
		const orphanOld = await make("0000000000000002", path.join(base, "gone-old"), (ORPHAN_FOLDER_MAX_AGE_MS / DAY) + 5);
		const orphanYoung = await make("0000000000000003", path.join(base, "gone-young"), 20);
		const alive = await make("0000000000000004", base, 20);
		const removed = await sweepRecoveryBase({ base, ownKey: "0000000000000001", now: time.now, queryIdentity: identityOf({}) });
		assert.equal(existsSync(orphanOld), false, "a long-orphaned folder is gone");
		assert.equal(existsSync(orphanYoung), true, "an orphan written to recently stays");
		assert.equal(existsSync(alive), true, "a folder whose user-data directory exists stays");
		assert.equal(existsSync(own), true, "the sweep never touches this storage's own folder");
		assert.equal(existsSync(path.join(own, "brokers", "pty-aaaa.json")), true);
		assert.equal(existsSync(path.join(orphanYoung, "brokers", "pty-aaaa.json")), false, "the broker copy of a gone broker is removed in any folder");
		assert.ok(removed.folders === 1 && removed.brokerCopies >= 2);
	});
});

describe("loss notice marker", () => {
	it("lets the first window show a notice and holds the others off for the window", async () => {
		const fx = await fixture();
		const time = clock();
		assert.equal(await claimNotice(fx.location, "no-backup", time.now), true);
		assert.equal(await claimNotice(fx.location, "no-backup", time.now), false);
		assert.equal(await claimNotice(fx.location, "regressed", time.now), true, "another kind is its own notice");
		time.advance(NOTICE_WINDOW_MS + 1);
		assert.equal(await claimNotice(fx.location, "no-backup", time.now), true);
		assert.equal(await claimNotice(null, "no-backup", time.now), true, "no folder, no marker: each window shows its own");
	});
});
