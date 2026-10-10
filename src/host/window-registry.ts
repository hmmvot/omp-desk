/**
 * OMP Desk — the leased registry of the extension windows of one profile (ADR-0056).
 *
 * Every window of the profile shows the same Sessions content, so each extension host
 * publishes what only it knows — the folders VS Code has open in it, the working
 * directories of the sessions it runs and the status of each of them — as one small
 * record in shared global storage, `window-registry/<holder id>.window`. Every window
 * reads the others' records and derives the same union.
 *
 * A record is a **lease**, never a fact about the world: the writer renews it every
 * heartbeat, and a reader counts another window's record only while its `updatedAt` is
 * within the lease *and* its pid still exists, so a crashed or hung window drops out by
 * itself. Nothing here is durable state: records live outside the profile catalog, never
 * become pinned folders and are deleted by their owner on a normal close and by any
 * reader once they are dead and stale. The watch on the directory is a hint like the
 * claims watch; the heartbeat and the focus re-read are the recovery.
 *
 * This module is VS Code–free: every input (clock, pid probe, timers' intervals) is
 * injected, so the merge, expiry and cleanup rules are testable against a real
 * temporary directory.
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { errorCode, readBoundedFile, replaceFileAtomic } from "./atomic-file.ts";
import { watchDirectory } from "./directory-watch.ts";

/** Directory under the global storage folder that holds one record per live window. */
export const WINDOW_REGISTRY_DIRECTORY = "window-registry";
/** A writer renews its record this often. */
export const WINDOW_HEARTBEAT_MS = 15_000;
/** Another window's record counts for this long after its last write. */
export const WINDOW_LEASE_MS = 60_000;

const RECORD_SUFFIX = ".window";
const RECORD_VERSION = 1;
const DEFAULT_WRITE_DEBOUNCE_MS = 250;
const MAX_RECORD_BYTES = 512 * 1024;
/** What folders, live cwds and rows may cost together: the rest of the record is a few hundred bytes. */
const MAX_PAYLOAD_BYTES = 384 * 1024;
const MAX_FOLDERS = 64;
const MAX_LIVE_CWDS = 256;
const MAX_ROWS = 512;
const MAX_TEXT = 4096;
const MAX_ID = 200;
const ID_RE = /^[A-Za-z0-9-]{1,100}$/;
const INCARNATION_RE = /^[A-Za-z0-9._:-]{1,300}$/;
const BINDING_RE = /^[A-Za-z0-9._-]{1,200}$/;
/** How far ahead of the reader's clock a record's stamp may be before it is not trusted. */
const FUTURE_SKEW_MS = 5_000;

/**
 * The status a window publishes for a session it runs: the part of a row's state that only
 * its owner's own facts decide. The unread mark is deliberately not here — it is derived by
 * every reader from the shared reply markers, so no second authority for it exists — and
 * everything else a row can show comes from shared data (the catalog, claims) or is
 * observed by each window the same way.
 */
export const PUBLISHED_ROW_STATUSES = [
	"starting",
	"stopping",
	"restoring",
	"running",
	"working",
	"background",
	"question",
	"waiting",
] as const;
export type PublishedRowStatus = (typeof PUBLISHED_ROW_STATUSES)[number];

/**
 * One published row, fenced to the run it was published for: a reader applies it only while
 * the shared catalog's record of that session names the same {@link sessionIncarnation}, so
 * a status of an earlier run (a stop and relaunch, a rebound conversation) is never shown for
 * a later one.
 */
export interface PublishedRow {
	readonly status: PublishedRowStatus;
	/** {@link sessionIncarnation} of the run the owner published this for. */
	readonly incarnation: string;
	/** `<editor slot>.<binding generation>` of the owner's editor serving the session (the generation changes on a native handover), so a request is fenced to the exact binding the requester saw; `none` when the owner has no editor binding for it. */
	readonly binding: string;
	/** The conversation's last activity as the owner read it (ISO), so every window orders the row by the same fact; `null` before it is read. */
	readonly lastActivityAt: string | null;
}

/**
 * The identity of one run of a session: the owner generation of its claim (a durable logical
 * identity that stop and resume keep) together with the launch attempt the catalog records
 * for it (start time and child pid, which every launch renews). Every window computes it from
 * the shared catalog entry, so a publication or request for an earlier run never matches the
 * current one. `null` when the entry has no owner generation.
 */
export function sessionIncarnation(entry: {
	readonly ownership: { readonly ownerGeneration: string } | null;
	readonly host: { readonly startedAt: string; readonly pid: number | null } | null;
}): string | null {
	const generation = entry.ownership?.ownerGeneration;
	if (generation === undefined || !/^[A-Za-z0-9-]{1,100}$/.test(generation)) return null;
	const host = entry.host === null ? "none" : `${String(entry.host.startedAt ?? "").replace(/[^A-Za-z0-9.:-]/g, "")}.${entry.host.pid ?? "x"}`;
	return `${generation}_${host}`;
}

/** What one window says about itself. Bounded, so every record this module writes is one it reads back. */
export interface WindowSnapshot {
	/** The saved workspace or single-folder `file` URI a reopen can focus, or `null` (an unsaved multi-root window). */
	readonly windowUri: string | null;
	/** The window's VS Code workspace name, for tooltips. */
	readonly label: string;
	/** `file` folders open in the window, in VS Code's order, as opened (before agent-root substitution). */
	readonly folders: readonly string[];
	/** Working directories of the sessions this window runs or is launching. */
	readonly liveCwds: readonly string[];
	/** The sessions this window runs, by tab id. */
	readonly rows: Readonly<Record<string, PublishedRow>>;
}

/** The record as stored. */
export interface WindowRecord extends WindowSnapshot {
	readonly version: 1;
	readonly holderId: string;
	readonly pid: number;
	/** ISO time the writing extension host started: the order every window sorts by. */
	readonly startedAt: string;
	/** ISO time of the last write: the lease. */
	readonly updatedAt: string;
}

/** One live window as the rest of the extension sees it. */
export interface OpenWindow extends WindowSnapshot {
	readonly holderId: string;
	/** This is the window asking. */
	readonly here: boolean;
	readonly startedAt: string;
}

export const EMPTY_WINDOW_SNAPSHOT: WindowSnapshot = {
	windowUri: null,
	label: "",
	folders: [],
	liveCwds: [],
	rows: {},
};

/** `true` when a process with this id exists; a process this one may not signal still exists. */
export function processExists(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return errorCode(error) === "EPERM";
	}
}

function clampText(value: string): string {
	return value.length > MAX_TEXT ? value.slice(0, MAX_TEXT) : value;
}

/** UTF-8 bytes of the JSON text of `value`: what it costs in the record. */
function encodedBytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/**
 * Bound a snapshot so the record written from it is accepted by every reader, and so the
 * publisher and every reader work from the same inputs. Paths are **never altered**: one that
 * is too long, or that would not fit the byte budget, is left out whole (a truncated path
 * would be a different folder). Rows come first (a row left out would show another status
 * elsewhere than in its owner, and rows are small), then folders, then live working
 * directories.
 */
export function boundWindowSnapshot(snapshot: WindowSnapshot): WindowSnapshot {
	let budget = MAX_PAYLOAD_BYTES;
	const rows: Record<string, PublishedRow> = {};
	let count = 0;
	for (const [tabId, row] of Object.entries(snapshot.rows)) {
		if (count >= MAX_ROWS) break;
		if (tabId.length === 0 || tabId.length > MAX_ID || !INCARNATION_RE.test(row.incarnation)) continue;
		if (!BINDING_RE.test(row.binding)) continue;
		if (row.lastActivityAt !== null && !isIsoTime(row.lastActivityAt)) continue;
		const cost = encodedBytes([tabId, row]) + 1;
		if (cost > budget) continue;
		budget -= cost;
		rows[tabId] = row;
		count++;
	}
	const take = <T>(items: readonly T[], limit: number, accept: (item: T) => boolean): T[] => {
		const kept: T[] = [];
		for (const item of items) {
			if (kept.length >= limit) break;
			if (!accept(item)) continue;
			const cost = encodedBytes(item) + 1;
			if (cost > budget) continue;
			budget -= cost;
			kept.push(item);
		}
		return kept;
	};
	const fits = (text: string): boolean => text.length > 0 && text.length <= MAX_TEXT;
	const folders = take(snapshot.folders, MAX_FOLDERS, fits);
	const liveCwds = take(snapshot.liveCwds, MAX_LIVE_CWDS, fits);
	return {
		windowUri: snapshot.windowUri !== null && snapshot.windowUri.startsWith("file:") && snapshot.windowUri.length <= MAX_TEXT ? snapshot.windowUri : null,
		label: clampText(snapshot.label),
		folders,
		liveCwds,
		rows,
	};
}

function isStringArray(value: unknown, limit: number): value is string[] {
	return Array.isArray(value) && value.length <= limit && value.every(item => typeof item === "string" && item.length <= MAX_TEXT);
}

function isIsoTime(value: unknown): value is string {
	return typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));
}

/** The record in `text`, or `null` for anything that is not a well-formed record filed under `fileHolderId`. */
export function parseWindowRecord(text: string, fileHolderId: string): WindowRecord | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	// Every field is checked one by one below; nothing of this shape is trusted before that.
	const record = parsed as Record<string, unknown>;
	if (record.version !== RECORD_VERSION || record.holderId !== fileHolderId || !ID_RE.test(fileHolderId)) return null;
	const { pid, startedAt, updatedAt, windowUri, label, folders, liveCwds, rows } = record;
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
	if (!isIsoTime(startedAt) || !isIsoTime(updatedAt)) return null;
	// Navigation is `vscode.openFolder` on a local file URI and nothing else.
	if (windowUri !== null && (typeof windowUri !== "string" || windowUri.length > MAX_TEXT || !windowUri.startsWith("file:"))) return null;
	if (typeof label !== "string" || label.length > MAX_TEXT) return null;
	if (!isStringArray(folders, MAX_FOLDERS) || !isStringArray(liveCwds, MAX_LIVE_CWDS)) return null;
	if (typeof rows !== "object" || rows === null || Array.isArray(rows)) return null;
	const checkedRows: Record<string, PublishedRow> = {};
	const entries = Object.entries(rows);
	if (entries.length > MAX_ROWS) return null;
	for (const [tabId, row] of entries) {
		if (tabId.length === 0 || tabId.length > MAX_ID) return null;
		if (typeof row !== "object" || row === null) return null;
		const { status, incarnation, binding, lastActivityAt } = row as Record<string, unknown>;
		if (typeof status !== "string" || !PUBLISHED_ROW_STATUSES.includes(status as PublishedRowStatus)) return null;
		if (typeof incarnation !== "string" || !INCARNATION_RE.test(incarnation)) return null;
		if (typeof binding !== "string" || !BINDING_RE.test(binding)) return null;
		if (lastActivityAt !== null && !isIsoTime(lastActivityAt)) return null;
		checkedRows[tabId] = { status: status as PublishedRowStatus, incarnation, binding, lastActivityAt };
	}
	return {
		version: RECORD_VERSION,
		holderId: fileHolderId,
		pid,
		startedAt,
		updatedAt,
		windowUri: windowUri === null ? null : String(windowUri),
		label,
		folders,
		liveCwds,
		rows: checkedRows,
	};
}

/**
 * A record of another window is live while its lease holds and its process exists. A record
 * stamped further in the future than a clock-skew allowance is not trusted at all: after a
 * backward clock change the stamp would otherwise outlive every lease.
 */
export function recordIsLive(
	record: Pick<WindowRecord, "pid" | "updatedAt">,
	now: number,
	leaseMs: number,
	pidAlive: (pid: number) => boolean,
): boolean {
	return leaseHolds(record, now, leaseMs) && pidAlive(record.pid);
}

function leaseHolds(record: Pick<WindowRecord, "updatedAt">, now: number, leaseMs: number): boolean {
	const age = now - Date.parse(record.updatedAt);
	return age <= leaseMs && age >= -FUTURE_SKEW_MS;
}

/**
 * The union of live windows in the one order every window derives: by the start of their
 * extension host, then by holder id. `others` must already be filtered for liveness.
 */
export function orderWindows(windows: readonly OpenWindow[]): readonly OpenWindow[] {
	return [...windows].sort((left, right) => {
		const byStart = Date.parse(left.startedAt) - Date.parse(right.startedAt);
		if (byStart !== 0) return byStart;
		return left.holderId < right.holderId ? -1 : left.holderId > right.holderId ? 1 : 0;
	});
}

function snapshotOf(window: WindowSnapshot): WindowSnapshot {
	return { windowUri: window.windowUri, label: window.label, folders: window.folders, liveCwds: window.liveCwds, rows: window.rows };
}

/** A stable text of what the windows show, never of how fresh it is. */
export function windowsSignature(windows: readonly OpenWindow[]): string {
	return JSON.stringify(windows.map(window => [window.holderId, window.here, window.startedAt, snapshotOf(window)]));
}

export interface WindowRegistryOptions {
	/** The extension's global storage folder; the registry lives in a directory under it. */
	readonly storageDir: string;
	/** The claim holder id of this extension host. */
	readonly holderId: string;
	readonly pid?: number;
	readonly startedAt?: string;
	readonly now?: () => number;
	readonly leaseMs?: number;
	readonly heartbeatMs?: number;
	/** Delay that folds a burst of snapshot changes into one write. */
	readonly writeDebounceMs?: number;
	readonly watchDebounceMs?: number;
	/** Process existence probe; injected so a test can declare a pid dead. */
	readonly pidAlive?: (pid: number) => boolean;
	readonly onError?: (detail: string) => void;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}


/**
 * This window's lease and its view of the others'.
 *
 * `windows()` is synchronous and cheap — the tree calls it on every projection — and
 * reads only what the last {@link refresh} cached, plus the lease check against the
 * clock. All disk access is in {@link flush}, {@link refresh} and {@link removeSync}.
 */
export class WindowRegistry {
	readonly #directory: string;
	readonly #file: string;
	readonly #holderId: string;
	readonly #pid: number;
	readonly #startedAt: string;
	readonly #now: () => number;
	readonly #leaseMs: number;
	readonly #heartbeatMs: number;
	readonly #writeDebounceMs: number;
	readonly #watchDebounceMs: number | undefined;
	readonly #pidAlive: (pid: number) => boolean;
	readonly #onError: (detail: string) => void;
	#own: WindowSnapshot = EMPTY_WINDOW_SNAPSHOT;
	#ownSignature = JSON.stringify(EMPTY_WINDOW_SNAPSHOT);
	/** Records of other windows from the last read, with the verdict of the pid probe made then. */
	#others: Array<{ readonly record: WindowRecord; readonly alive: boolean }> = [];
	#reportedSignature = "";
	#writeTimer: NodeJS.Timeout | null = null;
	#writing: Promise<void> = Promise.resolve();
	#heartbeat: NodeJS.Timeout | null = null;
	#stopWatch: (() => void) | null = null;
	#disposed = false;
	#removed = false;

	constructor(options: WindowRegistryOptions) {
		if (!ID_RE.test(options.holderId)) throw new TypeError("the window registry needs a holder id of letters, digits and dashes");
		this.#directory = path.join(path.resolve(options.storageDir), WINDOW_REGISTRY_DIRECTORY);
		this.#holderId = options.holderId;
		this.#file = path.join(this.#directory, `${options.holderId}${RECORD_SUFFIX}`);
		this.#pid = options.pid ?? process.pid;
		this.#startedAt = options.startedAt ?? new Date((options.now ?? Date.now)()).toISOString();
		this.#now = options.now ?? Date.now;
		this.#leaseMs = options.leaseMs ?? WINDOW_LEASE_MS;
		this.#heartbeatMs = options.heartbeatMs ?? WINDOW_HEARTBEAT_MS;
		this.#writeDebounceMs = options.writeDebounceMs ?? DEFAULT_WRITE_DEBOUNCE_MS;
		this.#watchDebounceMs = options.watchDebounceMs;
		this.#pidAlive = options.pidAlive ?? processExists;
		this.#onError = options.onError ?? (() => {});
	}

	get directory(): string {
		return this.#directory;
	}

	get holderId(): string {
		return this.#holderId;
	}

	/**
	 * Begin publishing and reading: write this window's record, read the others', watch the
	 * directory and renew the lease every heartbeat. `onChange` runs whenever what the
	 * windows show — not how fresh it is — differs from what it last reported;
	 * `onHeartbeat` runs on every heartbeat, for work that must be repeated whatever the
	 * registry saw (re-probing agent roots).
	 */
	start(hooks: { readonly onChange: () => void; readonly onHeartbeat?: () => void }): void {
		const onChange = hooks.onChange;
		if (this.#disposed || this.#stopWatch !== null) return;
		const reread = (): void => {
			void this.refresh().then(changed => { if (changed && !this.#disposed) onChange(); }, error => this.#report(`could not read the window registry: ${messageOf(error)}`));
		};
		this.#stopWatch = watchDirectory(this.#directory, names => {
			// A change that names only this window's own record is this window's own write.
			if (names.size > 0 && [...names].every(name => name === `${this.#holderId}${RECORD_SUFFIX}`)) return;
			reread();
		}, {
			suffix: RECORD_SUFFIX,
			description: "the window registry",
			onError: detail => this.#report(detail),
			...(this.#watchDebounceMs === undefined ? {} : { debounceMs: this.#watchDebounceMs }),
		});
		this.#heartbeat = setInterval(() => {
			void this.flush();
			reread();
			try {
				hooks.onHeartbeat?.();
			} catch (error) {
				this.#report(`a heartbeat handler failed: ${messageOf(error)}`);
			}
		}, this.#heartbeatMs);
		this.#heartbeat.unref?.();
		void this.flush();
		reread();
	}

	/**
	 * Replace what this window says about itself. Returns whether anything changed; a change
	 * schedules one debounced write. Never touches the disk itself.
	 */
	setSnapshot(snapshot: WindowSnapshot): boolean {
		const bounded = boundWindowSnapshot(snapshot);
		const signature = JSON.stringify(bounded);
		if (signature === this.#ownSignature) return false;
		this.#own = bounded;
		this.#ownSignature = signature;
		this.#scheduleWrite();
		return true;
	}

	/** The live windows, this one included, in the order every window derives. */
	windows(): readonly OpenWindow[] {
		const now = this.#now();
		const windows: OpenWindow[] = [{ holderId: this.#holderId, here: true, startedAt: this.#startedAt, ...this.#own }];
		for (const { record, alive } of this.#others) {
			if (!alive || !leaseHolds(record, now, this.#leaseMs)) continue;
			windows.push({
				holderId: record.holderId,
				here: false,
				startedAt: record.startedAt,
				windowUri: record.windowUri,
				label: record.label,
				folders: record.folders,
				liveCwds: record.liveCwds,
				rows: record.rows,
			});
		}
		return orderWindows(windows);
	}

	/** The live window of this holder, if any. */
	windowOf(holderId: string): OpenWindow | undefined {
		return this.windows().find(window => window.holderId === holderId);
	}

	/**
	 * Re-read the other windows' records, drop the dead ones from view and sweep the stale
	 * files. Whether what the windows show differs from what was last reported.
	 */
	async refresh(): Promise<boolean> {
		if (this.#disposed) return false;
		const others = await this.#readOthers();
		if (this.#disposed) return false;
		this.#others = others;
		const signature = windowsSignature(this.windows());
		const changed = signature !== this.#reportedSignature;
		this.#reportedSignature = signature;
		return changed;
	}

	/** Write this window's record now (a lease renewal when nothing changed). */
	flush(): Promise<void> {
		clearTimeout(this.#writeTimer ?? undefined);
		this.#writeTimer = null;
		if (this.#disposed) return this.#writing;
		this.#writing = this.#writing.then(() => this.#writeRecord()).catch(error => this.#report(`could not publish this window: ${messageOf(error)}`));
		return this.#writing;
	}

	/** Stop watching and renewing. The record stays until its lease lapses; see {@link removeSync}. */
	dispose(): void {
		this.#disposed = true;
		clearTimeout(this.#writeTimer ?? undefined);
		this.#writeTimer = null;
		clearInterval(this.#heartbeat ?? undefined);
		this.#heartbeat = null;
		this.#stopWatch?.();
		this.#stopWatch = null;
	}

	/** Stop and delete this window's record: a normal close, within `deactivate`'s short budget. */
	removeSync(): void {
		this.#removed = true;
		this.dispose();
		try {
			fs.rmSync(this.#file, { force: true });
		} catch (error) {
			this.#report(`could not remove this window's record: ${messageOf(error)}`);
		}
	}

	#report(detail: string): void {
		try {
			this.#onError(detail);
		} catch {
			// An error sink that throws must not take the registry down.
		}
	}

	#scheduleWrite(): void {
		if (this.#writeTimer !== null || this.#disposed) return;
		this.#writeTimer = setTimeout(() => {
			this.#writeTimer = null;
			void this.flush();
		}, this.#writeDebounceMs);
		this.#writeTimer.unref?.();
	}

	async #writeRecord(): Promise<void> {
		if (this.#disposed) return;
		const record: WindowRecord = {
			version: RECORD_VERSION,
			holderId: this.#holderId,
			pid: this.#pid,
			startedAt: this.#startedAt,
			updatedAt: new Date(this.#now()).toISOString(),
			...this.#own,
		};
		await replaceFileAtomic(this.#file, `${JSON.stringify(record)}\n`);
		// A write that was in flight when the window closed must not bring its record back.
		if (this.#removed) await fsp.rm(this.#file, { force: true });
	}

	async #readOthers(): Promise<Array<{ readonly record: WindowRecord; readonly alive: boolean }>> {
		let names: string[];
		try {
			names = await fsp.readdir(this.#directory);
		} catch (error) {
			if (errorCode(error) === "ENOENT") return [];
			throw error;
		}
		const now = this.#now();
		const own = `${this.#holderId}${RECORD_SUFFIX}`;
		const others: Array<{ readonly record: WindowRecord; readonly alive: boolean }> = [];
		for (const name of names) {
			if (name === own) continue;
			const file = path.join(this.#directory, name);
			if (!name.endsWith(RECORD_SUFFIX)) {
				// Staging files of a writer that died mid-write.
				if (name.endsWith(".tmp")) await this.#sweep(file, now);
				continue;
			}
			const record = await this.#readRecord(file, name.slice(0, -RECORD_SUFFIX.length));
			if (record === null) {
				await this.#sweep(file, now);
				continue;
			}
			const alive = recordIsLive(record, now, this.#leaseMs, this.#pidAlive);
			if (!alive) await this.#sweep(file, now);
			others.push({ record, alive });
		}
		return others;
	}

	async #readRecord(file: string, holderId: string): Promise<WindowRecord | null> {
		try {
			const read = await readBoundedFile(file, MAX_RECORD_BYTES);
			return read.kind === "text" ? parseWindowRecord(read.text, holderId) : null;
		} catch (error) {
			this.#report(`could not read ${path.basename(file)}: ${messageOf(error)}`);
			return null;
		}
	}

	/**
	 * Delete a file that is dead and has not been written for a whole lease. The file's own
	 * modification time is read again here: a live owner that was only slow rewrites it, and
	 * a record deleted by mistake is republished at its next heartbeat.
	 */
	async #sweep(file: string, now: number): Promise<void> {
		try {
			const stat = await fsp.stat(file);
			if (now - stat.mtimeMs <= this.#leaseMs) return;
			await fsp.rm(file, { force: true });
		} catch (error) {
			if (errorCode(error) !== "ENOENT") this.#report(`could not sweep ${path.basename(file)}: ${messageOf(error)}`);
		}
	}
}
