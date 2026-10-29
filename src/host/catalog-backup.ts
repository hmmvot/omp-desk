/**
 * A private copy of the profile catalog and of the broker records, kept outside every folder VS Code's extension lifecycle
 * manages, and the restore from it ([ADR-0081](../../docs/decisions/0081-keep-a-private-backup-of-the-catalog-and-broker-records-outside-vs-codes-storage-and-restore-it-over-a-missing-catalog.md)).
 *
 * VS Code deletes `globalStorage/<extension id>` for an id whose installed versions are all marked obsolete; the catalog and the
 * broker records (which hold the tokens no other copy has) lived only there. This module has no `vscode` import: the location,
 * the writer, the retention rule, the restore source and the sweep are plain functions over injected seams, tested on temp
 * directories.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, utimes } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { replaceFileAtomic } from "../wire/atomic-file.ts";
import { restrictPrivateStorage } from "../wire/private-storage.ts";
import type { PrivateStorageProbe } from "../wire/private-storage.ts";
import { parseCatalogDocument } from "./profile-catalog.ts";
import type { CatalogDocument, CatalogRecovery } from "./profile-catalog.ts";
import { queryPtyProcessIdentity } from "../wire/pty-identity.ts";
import type { PtyIdentityReading } from "../wire/pty-identity.ts";
import { parsePtyBrokerRecord } from "../wire/pty-protocol.ts";
import type { PtyBrokerRecord } from "../wire/pty-protocol.ts";
import { claimPtyRecord, ensurePtyStateAccess, listPtyRecords, ptyRecordPath, readPtyRecord } from "../wire/pty-registry.ts";

/** Replaces the root of the recovery folders; for tests and isolated environments, not a setting. */
export const RECOVERY_ROOT_ENV = "OMP_DESK_RECOVERY_ROOT";

/** At most one catalog copy per window in this interval (leading edge, plus one trailing write). */
export const BACKUP_MIN_INTERVAL_MS = 30_000;
/** A seed copy is made this long after the startup restore. */
export const BACKUP_SEED_DELAY_MS = 10_000;
/** The broker-record copies are refreshed at most this often. */
export const BROKER_REFRESH_MS = 60_000;
/** A broker copy whose broker is alive is touched when it is older than this, so its age says "still alive". */
export const BROKER_TOUCH_MS = 24 * 60 * 60_000;
/** A broker copy nobody refreshed for this long is removed whatever the probe says. */
export const BROKER_COPY_MAX_AGE_MS = 14 * 24 * 60 * 60_000;
/** A recovery folder of a storage that is gone is removed when nothing in it was written for this long. */
export const ORPHAN_FOLDER_MAX_AGE_MS = 180 * 24 * 60 * 60_000;
/** One loss notice per kind is shown at most this often across windows. */
export const NOTICE_WINDOW_MS = 10 * 60_000;

/** Retention: the newest copies, the newest of each of the last days, and the copy with the most content of the last month. */
export const RETAIN_NEWEST = 6;
export const RETAIN_DAYS = 7;
export const RETAIN_PEAK_DAYS = 30;

const DAY_MS = 24 * 60 * 60_000;
const KEY_NAME = /^[0-9a-f]{16}$/;
const COPY_NAME = /^catalog-g(\d+)-r(\d+)-c(\d+)x(\d+)-([0-9a-f]{8})\.json$/;
const PROBE_TEXT = "omp-desk-recovery-probe";
const GUARD_FAILURE_RETRY_MS = 60_000;

// Location

/** First 16 hex digits of the SHA-256 of the lower-cased, normalised absolute storage path. */
export function recoveryKey(storageDir: string): string {
	const normalised = path.resolve(storageDir).replace(/[\\/]+$/, "").toLowerCase();
	return createHash("sha256").update(normalised, "utf8").digest("hex").slice(0, 16);
}

export interface RecoveryLocation {
	readonly key: string;
	/** The folder that holds every key's folder. */
	readonly base: string;
	/** This storage's folder. */
	readonly root: string;
	readonly catalogDirectory: string;
	readonly brokersDirectory: string;
}

/** Where the recovery folders live, or `null` when no root can be resolved. */
export function recoveryBase(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home: string = os.homedir()): string | null {
	const override = env[RECOVERY_ROOT_ENV];
	if (typeof override === "string" && override.length > 0) return path.resolve(override);
	if (platform === "win32") {
		const local = env.LOCALAPPDATA;
		if (typeof local === "string" && path.isAbsolute(local)) return path.join(local, "omp-desk", "recovery");
		return home.length > 0 ? path.join(home, "AppData", "Local", "omp-desk", "recovery") : null;
	}
	const state = env.XDG_STATE_HOME;
	if (typeof state === "string" && path.isAbsolute(state)) return path.join(state, "omp-desk", "recovery");
	return home.length > 0 ? path.join(home, ".local", "state", "omp-desk", "recovery") : null;
}

export function locateRecovery(storageDir: string, base: string | null = recoveryBase()): RecoveryLocation | null {
	if (base === null) return null;
	const key = recoveryKey(storageDir);
	const root = path.join(base, key);
	return { key, base, root, catalogDirectory: path.join(root, "catalog"), brokersDirectory: path.join(root, "brokers") };
}

/** Bring the recovery folder under the owner-only convention; a folder that cannot be shown owner-only is not used. */
export function restrictRecoveryFolder(location: RecoveryLocation, probe?: PrivateStorageProbe): () => Promise<EnsureVerdict> {
	return async () => {
		const restriction = await restrictPrivateStorage({
			layout: {
				root: location.root,
				directories: [location.root, location.catalogDirectory, location.brokersDirectory],
				verifiedDirectories: [],
				probeDirectory: location.root,
				probeText: PROBE_TEXT,
			},
			...(probe === undefined ? {} : { probe }),
		});
		return restriction.restricted ? { ok: true, reason: null } : { ok: false, reason: restriction.reason ?? "the folder could not be shown owner-only" };
	};
}

export interface EnsureVerdict {
	readonly ok: boolean;
	readonly reason: string | null;
}

/** Remember a verdict: a pass for the process, a failure for a minute (the folder may be fixed meanwhile). */
export function cachedVerdict(compute: () => Promise<EnsureVerdict>, now: () => number = Date.now): () => Promise<EnsureVerdict> {
	let pending: Promise<EnsureVerdict> | null = null;
	let failedAt = 0;
	return () => {
		if (pending !== null && failedAt !== 0 && now() - failedAt >= GUARD_FAILURE_RETRY_MS) {
			pending = null;
			failedAt = 0;
		}
		if (pending === null) {
			pending = compute().catch(error => ({ ok: false, reason: error instanceof Error ? error.message : String(error) }));
			void pending.then(verdict => {
				if (!verdict.ok) failedAt = now();
			});
		}
		return pending;
	};
}

// Content

export interface CatalogContentKeys {
	/** The record key of the session rows (`{ entries: [] }`). */
	readonly sessions: string;
	/** The record key of the registered folders (`{ folders: [] }`). */
	readonly folders: string;
}

export interface CatalogContent {
	readonly rows: number;
	readonly folders: number;
}

function listLength(value: unknown, field: string): number {
	if (typeof value !== "object" || value === null) return 0;
	const list = (value as Record<string, unknown>)[field];
	return Array.isArray(list) ? list.length : 0;
}

export function catalogContent(document: CatalogDocument, keys: CatalogContentKeys): CatalogContent {
	return { rows: listLength(document.records[keys.sessions], "entries"), folders: listLength(document.records[keys.folders], "folders") };
}

export const isEmptyContent = (content: CatalogContent): boolean => content.rows + content.folders === 0;

// Copies

export interface CatalogCopy {
	readonly name: string;
	readonly generation: number;
	readonly revision: number;
	readonly rows: number;
	readonly folders: number;
	readonly hash: string;
	/** Write time; used for the daily retention and the age of a copy, never to order copies. */
	readonly mtimeMs: number;
}

export function copyName(copy: Pick<CatalogCopy, "generation" | "revision" | "rows" | "folders" | "hash">): string {
	return `catalog-g${copy.generation}-r${copy.revision}-c${copy.rows}x${copy.folders}-${copy.hash}.json`;
}

export function parseCopyName(name: string): Omit<CatalogCopy, "mtimeMs"> | null {
	const match = COPY_NAME.exec(name);
	if (match === null) return null;
	return { name, generation: Number(match[1]), revision: Number(match[2]), rows: Number(match[3]), folders: Number(match[4]), hash: match[5] as string };
}

/** Newest first: by generation, then revision, then write time. */
export function compareCopies(left: CatalogCopy, right: CatalogCopy): number {
	return right.generation - left.generation || right.revision - left.revision || right.mtimeMs - left.mtimeMs;
}

/** The names to keep: the newest {@link RETAIN_NEWEST}, the newest of each of the last {@link RETAIN_DAYS} UTC days, and the peak. */
export function retainedCopies(copies: readonly CatalogCopy[], nowMs: number): ReadonlySet<string> {
	const ordered = [...copies].sort(compareCopies);
	const keep = new Set<string>(ordered.slice(0, RETAIN_NEWEST).map(copy => copy.name));
	const today = Math.floor(nowMs / DAY_MS);
	const seenDays = new Set<number>();
	for (const copy of ordered) {
		const day = Math.floor(copy.mtimeMs / DAY_MS);
		if (day > today || today - day >= RETAIN_DAYS || seenDays.has(day)) continue;
		seenDays.add(day);
		keep.add(copy.name);
	}
	let peak: CatalogCopy | null = null;
	for (const copy of ordered) {
		if (nowMs - copy.mtimeMs > RETAIN_PEAK_DAYS * DAY_MS) continue;
		if (peak === null || copy.rows + copy.folders > peak.rows + peak.folders) peak = copy;
	}
	if (peak !== null) keep.add(peak.name);
	return keep;
}

function copiesOfNames(names: readonly string[]): Omit<CatalogCopy, "mtimeMs">[] {
	return names.map(parseCopyName).filter((copy): copy is Omit<CatalogCopy, "mtimeMs"> => copy !== null);
}

/** Every copy in a folder, newest first. A folder that does not exist has none. */
export async function listCopies(directory: string): Promise<CatalogCopy[]> {
	let names: string[];
	try {
		names = await readdir(directory);
	} catch {
		return [];
	}
	const copies: CatalogCopy[] = [];
	for (const parsed of copiesOfNames(names)) {
		try {
			copies.push({ ...parsed, mtimeMs: (await stat(path.join(directory, parsed.name))).mtimeMs });
		} catch {
			/* removed by another window's prune while it was listed */
		}
	}
	return copies.sort(compareCopies);
}

/** The same, by name only and synchronously: the content is encoded in the name, so a reset check reads no file. */
export function listCopyNames(directory: string): Omit<CatalogCopy, "mtimeMs">[] {
	try {
		return copiesOfNames(readdirSync(directory)).sort((left, right) => right.generation - left.generation || right.revision - left.revision);
	} catch {
		return [];
	}
}

// Broker records

export type BrokerLife = "alive" | "gone" | "unknown";

/**
 * Whether the process a record describes runs. `gone` also covers a pid that now belongs to a process created later; a record
 * without a creation time cannot be told from a reused id and stays `unknown`.
 */
export async function brokerLife(record: PtyBrokerRecord, queryIdentity: (pid: number) => Promise<PtyIdentityReading> = queryPtyProcessIdentity): Promise<BrokerLife> {
	const reading = await queryIdentity(record.brokerPid);
	if (reading.kind === "gone") return "gone";
	if (reading.kind === "unknown" || record.brokerCreationTime === null) return "unknown";
	return reading.creationTime === record.brokerCreationTime ? "alive" : "gone";
}

interface BrokerCopy {
	readonly file: string;
	readonly record: PtyBrokerRecord;
	readonly mtimeMs: number;
}

async function readBrokerCopies(directory: string): Promise<{ readonly copies: BrokerCopy[]; readonly unreadable: string[] }> {
	const copies: BrokerCopy[] = [];
	const unreadable: string[] = [];
	let names: string[];
	try {
		names = await readdir(directory);
	} catch {
		return { copies, unreadable };
	}
	for (const name of names.filter(entry => entry.endsWith(".json")).sort()) {
		const file = path.join(directory, name);
		try {
			copies.push({ file, record: parsePtyBrokerRecord(JSON.parse(await readFile(file, "utf8"))), mtimeMs: (await stat(file)).mtimeMs });
		} catch {
			unreadable.push(name);
		}
	}
	return { copies, unreadable };
}

/** Apply the lifetime rules of the record copies in one folder: remove a copy whose broker is gone or that nobody refreshed for 14 days, touch one of a live broker. */
async function maintainBrokerCopies(directory: string, nowMs: number, queryIdentity: (pid: number) => Promise<PtyIdentityReading>): Promise<{ removed: number; touched: number }> {
	let removed = 0;
	let touched = 0;
	const { copies } = await readBrokerCopies(directory);
	for (const copy of copies) {
		const life = await brokerLife(copy.record, queryIdentity);
		const age = nowMs - copy.mtimeMs;
		if (life === "gone" || age > BROKER_COPY_MAX_AGE_MS) {
			await rm(copy.file, { force: true });
			removed += 1;
		} else if (life === "alive" && age > BROKER_TOUCH_MS) {
			await utimes(copy.file, new Date(nowMs), new Date(nowMs)).catch(() => undefined);
			touched += 1;
		}
	}
	return { removed, touched };
}

export interface BrokerRestoreReport {
	readonly considered: number;
	readonly restored: number;
	/** One line per copy that was not restored, with the reason. */
	readonly skipped: readonly string[];
}

/**
 * Publish the copies of the records whose broker still runs, to the slot path each names. A record is validated, must name a
 * process that is alive with the creation time it recorded, and never replaces a record that exists.
 */
export async function restoreBrokerRecords(
	storageDir: string,
	location: RecoveryLocation,
	queryIdentity: (pid: number) => Promise<PtyIdentityReading> = queryPtyProcessIdentity,
): Promise<BrokerRestoreReport> {
	const { copies, unreadable } = await readBrokerCopies(location.brokersDirectory);
	const skipped = unreadable.map(name => `${name}: not a broker record`);
	let restored = 0;
	for (const copy of copies) {
		const name = path.basename(copy.file);
		if (path.basename(ptyRecordPath(storageDir, copy.record.slot)) !== name) {
			skipped.push(`${name}: the file name is not the one its slot names`);
			continue;
		}
		if ((await brokerLife(copy.record, queryIdentity)) !== "alive") {
			skipped.push(`${name}: the broker process is not running`);
			continue;
		}
		const existing = await readPtyRecord(storageDir, copy.record.slot);
		if (existing.kind !== "none") {
			skipped.push(`${name}: the slot already has ${existing.kind === "ok" ? "a record" : "an unreadable record"}`);
			continue;
		}
		const claimed = await claimPtyRecord(storageDir, copy.record);
		if (claimed.claimed) restored += 1;
		else skipped.push(`${name}: ${claimed.detail}`);
	}
	return { considered: copies.length + unreadable.length, restored, skipped };
}

// Writer

export interface CatalogRegression {
	readonly before: CatalogContent;
	readonly now: CatalogContent;
	readonly generation: number;
}

export interface BackupWriterDeps {
	readonly location: RecoveryLocation;
	readonly storageDir: string;
	/** The catalog document of this storage; read synchronously, as `readCatalogDocument` does. */
	readonly documentPath: string;
	readonly keys: CatalogContentKeys;
	/** The owner-only verdict of the recovery folder; consulted before any write. */
	readonly ensurePrivate: () => Promise<EnsureVerdict>;
	readonly now?: () => number;
	/** Run `callback` once after `ms`; returns the cancel. The default is an unref'd `setTimeout`. */
	readonly setTimer?: (callback: () => void, ms: number) => () => void;
	readonly queryIdentity?: (pid: number) => Promise<PtyIdentityReading>;
	/** The records the broker copies are made from; default: the `pty/` folder of the storage. */
	readonly brokerRecords?: () => Promise<readonly PtyBrokerRecord[]>;
	readonly log?: (level: "info" | "warn", message: string) => void;
	/** Called once with the reason when the recovery folder cannot be used. */
	readonly onUnusable?: (reason: string) => void;
	/** Called when a new generation starts whose document holds fewer sessions and folders than the previous one's newest copy. */
	readonly onRegressed?: (regression: CatalogRegression) => void;
}

/** The recovery folder's `source.json`: which storage it belongs to, for the sweep of folders whose storage is gone. */
export interface RecoverySource {
	readonly storagePath: string;
	readonly userDataDirectory: string;
	readonly writtenAt: string;
}

/** The directory VS Code keeps the user data in: `<userData>/User/globalStorage/<extension id>`. */
export function userDataDirectoryOf(storageDir: string): string {
	return path.dirname(path.dirname(path.dirname(path.resolve(storageDir))));
}

const defaultTimer = (callback: () => void, ms: number): (() => void) => {
	const timer = setTimeout(callback, ms);
	timer.unref?.();
	return () => clearTimeout(timer);
};

/**
 * The per-window writer: copies the committed catalog after changes (rate limited), keeps the broker records of live brokers,
 * prunes by the retention rule and sweeps the recovery root once.
 */
export class CatalogBackupWriter {
	readonly #deps: BackupWriterDeps;
	readonly #now: () => number;
	readonly #setTimer: (callback: () => void, ms: number) => () => void;
	readonly #queryIdentity: (pid: number) => Promise<PtyIdentityReading>;
	#lastWrite = Number.NEGATIVE_INFINITY;
	#lastBrokers = Number.NEGATIVE_INFINITY;
	#cancelTrailing: (() => void) | null = null;
	#cancelBrokers: (() => void) | null = null;
	#chain: Promise<void> = Promise.resolve();
	#disposed = false;
	#reportedUnusable = false;
	#sourceWritten = false;
	#swept = false;

	constructor(deps: BackupWriterDeps) {
		this.#deps = deps;
		this.#now = deps.now ?? Date.now;
		this.#setTimer = deps.setTimer ?? defaultTimer;
		this.#queryIdentity = deps.queryIdentity ?? queryPtyProcessIdentity;
	}

	/** The catalog changed (this window's commit or another window's): copy it, at most once per interval. */
	notifyChange(): void {
		if (this.#disposed || this.#cancelTrailing !== null) return;
		const wait = this.#lastWrite + BACKUP_MIN_INTERVAL_MS - this.#now();
		if (wait <= 0) {
			this.#lastWrite = this.#now();
			void this.#queue(() => this.#writeCatalog());
			return;
		}
		this.#cancelTrailing = this.#setTimer(() => {
			this.#cancelTrailing = null;
			void this.#queue(() => this.#writeCatalog());
		}, wait);
	}

	/** After the startup restore: seed a copy of the current document and begin refreshing the broker copies. */
	start(): void {
		if (this.#disposed) return;
		this.#setTimer(() => {
			if (this.#disposed) return;
			void this.#queue(() => this.#writeCatalog());
			void this.#queue(() => this.#refreshBrokers());
			void this.#queue(() => this.#sweep());
			this.#scheduleBrokers();
		}, BACKUP_SEED_DELAY_MS);
	}

	/** Run the pending work now, for tests and shutdown. */
	flush(): Promise<void> {
		return this.#queue(async () => {
			await this.#writeCatalog();
			await this.#refreshBrokers();
		});
	}

	dispose(): void {
		this.#disposed = true;
		this.#cancelTrailing?.();
		this.#cancelBrokers?.();
		this.#cancelTrailing = null;
		this.#cancelBrokers = null;
	}

	#scheduleBrokers(): void {
		if (this.#disposed) return;
		this.#cancelBrokers = this.#setTimer(() => {
			void this.#queue(() => this.#refreshBrokers());
			this.#scheduleBrokers();
		}, BROKER_REFRESH_MS);
	}

	#queue(work: () => Promise<void>): Promise<void> {
		const next = this.#chain.then(work, work).catch(error => {
			this.#deps.log?.("warn", `the catalog backup failed: ${error instanceof Error ? error.message : String(error)}`);
		});
		this.#chain = next;
		return next;
	}

	async #usable(): Promise<boolean> {
		const verdict = await this.#deps.ensurePrivate();
		if (verdict.ok) return true;
		if (!this.#reportedUnusable) {
			this.#reportedUnusable = true;
			const reason = verdict.reason ?? "unknown";
			this.#deps.log?.("warn", `the catalog backup is off: the recovery folder cannot be shown owner-only (${reason})`);
			this.#deps.onUnusable?.(reason);
		}
		return false;
	}

	async #writeSource(): Promise<void> {
		if (this.#sourceWritten) return;
		const target = path.join(this.#deps.location.root, "source.json");
		const source: RecoverySource = { storagePath: path.resolve(this.#deps.storageDir), userDataDirectory: userDataDirectoryOf(this.#deps.storageDir), writtenAt: new Date(this.#now()).toISOString() };
		await replaceFileAtomic(target, `${JSON.stringify(source)}\n`, { createDirectory: false });
		this.#sourceWritten = true;
	}

	async #writeCatalog(): Promise<void> {
		this.#lastWrite = this.#now();
		if (!(await this.#usable())) return;
		let text: string;
		let document: CatalogDocument;
		try {
			text = readFileSync(this.#deps.documentPath, "utf8");
			document = parseCatalogDocument(text);
		} catch {
			// Missing or unreadable: never copied. The store reports an unreadable document itself.
			return;
		}
		const directory = this.#deps.location.catalogDirectory;
		const content = catalogContent(document, this.#deps.keys);
		const copies = await listCopies(directory);
		const top = copies[0];
		let generation: number;
		if (top === undefined) {
			if (isEmptyContent(content)) return;
			generation = 1;
		} else if (document.revision >= top.revision) {
			generation = top.generation;
		} else {
			// A revision below the newest copy's: an operator replaced the catalog, or a wipe left a fresh one. A fresh empty one
			// is not an incarnation worth keeping; recording it as the newest would hide the real one.
			if (isEmptyContent(content)) return;
			generation = top.generation + 1;
			if (content.rows + content.folders < top.rows + top.folders) this.#deps.onRegressed?.({ before: { rows: top.rows, folders: top.folders }, now: content, generation });
		}
		const hash = createHash("sha256").update(text, "utf8").digest("hex").slice(0, 8);
		const entry = { generation, revision: document.revision, rows: content.rows, folders: content.folders, hash };
		if (copies.some(copy => copy.generation === generation && copy.revision === document.revision && copy.hash === hash)) return;
		await this.#writeSource();
		await replaceFileAtomic(path.join(directory, copyName(entry)), text, { createDirectory: false });
		await this.#prune();
	}

	async #prune(): Promise<void> {
		const directory = this.#deps.location.catalogDirectory;
		const copies = await listCopies(directory);
		const keep = retainedCopies(copies, this.#now());
		for (const copy of copies) if (!keep.has(copy.name)) await rm(path.join(directory, copy.name), { force: true });
	}

	async #refreshBrokers(): Promise<void> {
		const nowMs = this.#now();
		if (nowMs - this.#lastBrokers < BROKER_REFRESH_MS) return;
		this.#lastBrokers = nowMs;
		if (!(await this.#usable())) return;
		const directory = this.#deps.location.brokersDirectory;
		await maintainBrokerCopies(directory, nowMs, this.#queryIdentity);
		let records: readonly PtyBrokerRecord[];
		try {
			records = this.#deps.brokerRecords === undefined ? (await listPtyRecords(this.#deps.storageDir)).records : await this.#deps.brokerRecords();
		} catch {
			return;
		}
		for (const record of records) {
			if ((await brokerLife(record, this.#queryIdentity)) !== "alive") continue;
			const target = path.join(directory, path.basename(ptyRecordPath(this.#deps.storageDir, record.slot)));
			const text = `${JSON.stringify(record)}\n`;
			const existing = await readFile(target, "utf8").catch(() => null);
			if (existing === text) continue;
			await this.#writeSource();
			await replaceFileAtomic(target, text, { createDirectory: false });
		}
	}

	async #sweep(): Promise<void> {
		if (this.#swept) return;
		this.#swept = true;
		const removed = await sweepRecoveryBase({ base: this.#deps.location.base, ownKey: this.#deps.location.key, now: this.#now, queryIdentity: this.#queryIdentity });
		if (removed.folders > 0 || removed.brokerCopies > 0) {
			this.#deps.log?.("info", `catalog backup: removed ${removed.brokerCopies} stale broker record cop${removed.brokerCopies === 1 ? "y" : "ies"} and ${removed.folders} recovery folder(s) of storage that no longer exists`);
		}
	}
}

// Sweep

/**
 * Apply the lifetime rules to the broker copies of every *other* recovery folder, and remove a folder whose user-data directory
 * is gone and where nothing was written for {@link ORPHAN_FOLDER_MAX_AGE_MS}. A storage folder that was wiped while its user-data
 * directory remains is the case the copy exists for, so the existence test is on the user-data directory.
 */
export async function sweepRecoveryBase(input: {
	readonly base: string;
	readonly ownKey: string;
	readonly now?: () => number;
	readonly queryIdentity?: (pid: number) => Promise<PtyIdentityReading>;
}): Promise<{ readonly folders: number; readonly brokerCopies: number }> {
	const nowMs = (input.now ?? Date.now)();
	const queryIdentity = input.queryIdentity ?? queryPtyProcessIdentity;
	let folders = 0;
	let brokerCopies = 0;
	let names: string[];
	try {
		names = await readdir(input.base);
	} catch {
		return { folders, brokerCopies };
	}
	for (const name of names) {
		if (name === input.ownKey || !KEY_NAME.test(name)) continue;
		const folder = path.join(input.base, name);
		try {
			// The age is read first: removing a stale copy below would otherwise make the folder look freshly written.
			const newest = await newestWrite(folder);
			brokerCopies += (await maintainBrokerCopies(path.join(folder, "brokers"), nowMs, queryIdentity)).removed;
			const source = await readFile(path.join(folder, "source.json"), "utf8").then((text): Partial<RecoverySource> => JSON.parse(text), () => null);
			if (source === null || typeof source.userDataDirectory !== "string" || existsSync(source.userDataDirectory)) continue;
			if (nowMs - newest < ORPHAN_FOLDER_MAX_AGE_MS) continue;
			await rm(folder, { recursive: true, force: true });
			folders += 1;
		} catch {
			/* a folder this sweep cannot judge is left alone */
		}
	}
	return { folders, brokerCopies };
}

async function newestWrite(folder: string): Promise<number> {
	let newest = (await stat(folder)).mtimeMs;
	for (const entry of await readdir(folder, { withFileTypes: true })) {
		const full = path.join(folder, entry.name);
		newest = Math.max(newest, (await stat(full)).mtimeMs);
		if (entry.isDirectory()) for (const child of await readdir(full)) newest = Math.max(newest, (await stat(path.join(full, child))).mtimeMs);
	}
	return newest;
}

// Restore source

export type BackupInspection =
	| { readonly state: "none" }
	| { readonly state: "unusable"; readonly reason: string }
	| { readonly state: "available"; readonly copy: Omit<CatalogCopy, "mtimeMs">; readonly mtimeMs: number };

/** What a restore carries in {@link CatalogRecovery.info}. */
export interface RestoreInfo {
	readonly copy: CatalogCopy;
	readonly content: CatalogContent;
	readonly brokers: BrokerRestoreReport;
	/** Copies tried and refused before this one, with the reason. */
	readonly refused: readonly string[];
}

/** The restore details of a recovery this module produced, or `null` for one it did not (this window's own last read). */
export function restoreInfoOf(recovery: CatalogRecovery): RestoreInfo | null {
	const info = recovery.info;
	if (typeof info !== "object" || info === null || !("copy" in info) || !("brokers" in info) || !("refused" in info) || !("content" in info)) return null;
	const { copy, content, brokers, refused } = info;
	if (typeof copy !== "object" || copy === null || typeof content !== "object" || content === null || typeof brokers !== "object" || brokers === null || !Array.isArray(refused)) return null;
	return info as RestoreInfo;
}

export interface RecoverySourceDeps {
	readonly location: RecoveryLocation;
	readonly storageDir: string;
	readonly keys: CatalogContentKeys;
	readonly ensurePrivate: () => Promise<EnsureVerdict>;
	/** The owner-only verdict of the `pty/` folder, taken before any token is written into it. */
	readonly ensurePtyAccess?: () => Promise<EnsureVerdict>;
	readonly queryIdentity?: (pid: number) => Promise<PtyIdentityReading>;
	readonly log?: (level: "info" | "warn", message: string) => void;
}

export interface CatalogRecoverySource {
	/** Whether `document` is an empty shell of a lost catalog: no rows, no folders, and a revision below the newest copy's, which has data. Reads no file. */
	isReset(document: CatalogDocument): boolean;
	/** Take the access verdicts the restore needs, outside the catalog lock. Does nothing when there is no copy. */
	prepare(): Promise<void>;
	/** The catalog store's recovery hook. */
	recover(current: CatalogDocument | null): Promise<CatalogRecovery | null>;
	/** What a backup offers now, for the report of a loss that could not be repaired. */
	inspect(): Promise<BackupInspection>;
}

export function createRecoverySource(deps: RecoverySourceDeps): CatalogRecoverySource {
	const queryIdentity = deps.queryIdentity ?? queryPtyProcessIdentity;
	const ensurePtyAccess = cachedVerdict(deps.ensurePtyAccess ?? (async () => {
		const verdict = await ensurePtyStateAccess(deps.storageDir);
		return { ok: verdict.ok, reason: verdict.reason };
	}));
	const isReset = (document: CatalogDocument): boolean => {
		if (!isEmptyContent(catalogContent(document, deps.keys))) return false;
		const top = listCopyNames(deps.location.catalogDirectory)[0];
		return top !== undefined && top.rows + top.folders > 0 && document.revision < top.revision;
	};
	return {
		isReset,
		async prepare() {
			if (listCopyNames(deps.location.catalogDirectory).length === 0) return;
			if (!(await deps.ensurePrivate()).ok) return;
			await ensurePtyAccess();
		},
		async recover(current) {
			const names = listCopyNames(deps.location.catalogDirectory);
			if (names.length === 0) return null;
			const verdict = await deps.ensurePrivate();
			if (!verdict.ok) {
				deps.log?.("warn", `catalog: a backup exists but was not used: the recovery folder cannot be shown owner-only (${verdict.reason ?? "unknown"})`);
				return null;
			}
			const refused: string[] = [];
			const copies = await listCopies(deps.location.catalogDirectory);
			for (const copy of copies) {
				let document: CatalogDocument;
				try {
					document = parseCatalogDocument(await readFile(path.join(deps.location.catalogDirectory, copy.name), "utf8"));
				} catch (error) {
					refused.push(`${copy.name}: ${error instanceof Error ? error.message : String(error)}`);
					continue;
				}
				const ptyVerdict = await ensurePtyAccess();
				const brokers = ptyVerdict.ok
					? await restoreBrokerRecords(deps.storageDir, deps.location, queryIdentity)
					: { considered: 0, restored: 0 as const, skipped: [`the pty folder cannot be shown owner-only (${ptyVerdict.reason ?? "unknown"}), so no broker record was restored`] };
				const info: RestoreInfo = { copy, content: { rows: copy.rows, folders: copy.folders }, brokers, refused };
				return { document, label: `backup ${copy.name}`, info };
			}
			deps.log?.("warn", `catalog: a backup exists but no copy could be used: ${refused.join("; ")}`);
			return null;
		},
		async inspect() {
			const names = listCopyNames(deps.location.catalogDirectory);
			if (names.length === 0) return { state: "none" };
			const verdict = await deps.ensurePrivate();
			if (!verdict.ok) return { state: "unusable", reason: `the recovery folder cannot be shown owner-only (${verdict.reason ?? "unknown"})` };
			for (const copy of await listCopies(deps.location.catalogDirectory)) {
				try {
					parseCatalogDocument(await readFile(path.join(deps.location.catalogDirectory, copy.name), "utf8"));
					return { state: "available", copy, mtimeMs: copy.mtimeMs };
				} catch {
					/* the next copy */
				}
			}
			return { state: "unusable", reason: "no copy could be read as a catalog" };
		},
	};
}

// Cross-window notice marker

/** Claim the right to show one loss notice: `true` for the first window in {@link NOTICE_WINDOW_MS}; without a usable folder, `true`. */
export async function claimNotice(location: RecoveryLocation | null, kind: string, now: () => number = Date.now): Promise<boolean> {
	if (location === null || !/^[a-z-]+$/.test(kind)) return true;
	const marker = path.join(location.root, `notice-${kind}.json`);
	try {
		const shown = JSON.parse(await readFile(marker, "utf8")) as { at?: unknown };
		if (typeof shown.at === "number" && now() - shown.at < NOTICE_WINDOW_MS) return false;
	} catch {
		/* no marker, or one that cannot be read: the notice is shown */
	}
	try {
		if (!existsSync(location.root)) return true;
		await replaceFileAtomic(marker, `${JSON.stringify({ at: now() })}\n`, { createDirectory: false });
	} catch {
		/* the marker is a convenience; a window that cannot write it shows its own notice */
	}
	return true;
}
