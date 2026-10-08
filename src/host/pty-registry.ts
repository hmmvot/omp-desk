/**
 * Durable broker records: the one file that outlives a PTY broker's clients
 * ([ADR-0024](../../docs/decisions/0024-own-omp-pty-for-in-tab-terminal.md)).
 *
 * A record answers three questions after an extension-host reload or a window
 * restart, and nothing else: which broker owns this slot, where it listens, and
 * what generation and token authenticate it. Everything that changes while the
 * broker runs is answered over an authenticated connection, so a record is written
 * exactly once and never rewritten under a reader.
 *
 * The slot is claimed by *publishing* the record: the bytes are written to a
 * temporary sibling and then hard-linked onto the record path, so the create is
 * atomic and exclusive — two windows racing for one slot produce one occupant and
 * one honest `occupied` answer instead of a lost update. The record carries the
 * slot it claims, so a name is never the only identity.
 *
 * A record is only removed by the broker that owns it (on a clean shutdown after
 * its child is gone), or by a caller that has *proved* that broker process is gone
 * and that the bytes it retires are still that broker's (`retirePtyRecord`). An
 * unreadable record is never treated as absent: it could belong to a live broker
 * whose protocol version this build cannot parse, and starting a second writer over
 * it is exactly the failure this file exists to prevent.
 *
 * Access is the private-storage convention of [ADR-0012](../../docs/decisions/0012-run-child-process-entries-from-staged-copies.md):
 * the state directory and every record in it must be writable only by this account,
 * verified before the first claim. The token inside is a capability, and it is not
 * defended against code already running as this user — the same boundary ADR-0006
 * draws — so it is never logged, never sent anywhere but back over the loopback
 * connection the token authenticates, and never put in Webview state.
 */

import { link, mkdir, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { restrictPrivateStorage, type PrivateStorageProbe } from "./private-storage.ts";
import { PTY_RECORD_SUFFIX, isPtyCreationTime, parsePtyBrokerRecord, type PtyBrokerRecord } from "./pty-protocol.ts";
import { isPtyProcessAlive } from "./pty-identity.ts";

/** Directory holding broker records, inside the extension's global storage. */
export const PTY_STATE_DIRECTORY = "pty";

/** Suffix of the per-slot lock file that serializes claim, retire and replacement. */
export const PTY_SLOT_LOCK_SUFFIX = ".lock";

/** How long one launcher waits for another window's slot lock before refusing. */
const SLOT_LOCK_WAIT_MS = 5_000;
const SLOT_LOCK_POLL_MS = 100;

/** Fixed text the shared convention's write probe writes and reads back. */
const PTY_STORAGE_PROBE_TEXT = "omp-pty-state-probe";

/**
 * Where the records live. One directory per storage root, outside the staged
 * runtime tree: a record is state this window owns, not code it runs.
 */
export function ptyStateDirectory(storageDir: string): string {
	return join(storageDir, PTY_STATE_DIRECTORY);
}

/**
 * The record path for one slot.
 *
 * The name is derived from the slot's digest rather than the slot itself: a slot is
 * an opaque caller-chosen key that may contain any of `: / \ .`, and two such keys
 * that differ only in punctuation must not be able to share one record. The slot
 * itself is inside the file, which is what readers compare.
 */
export function ptyRecordPath(storageDir: string, slot: string): string {
	const digest = createHash("sha256").update(slot, "utf8").digest("hex");
	return join(ptyStateDirectory(storageDir), `pty-${digest.slice(0, 32)}${PTY_RECORD_SUFFIX}`);
}

/** The lock file's content: who is mid-launch on this slot, and since when. */
interface PtySlotLockRecord {
	readonly holderId: string;
	readonly pid: number;
	readonly creationTime: string | null;
	readonly at: string;
}

/** The slot lock path: outside the record's own name, inside the same verified tree. */
export function ptySlotLockPath(storageDir: string, slot: string): string {
	return `${ptyRecordPath(storageDir, slot)}${PTY_SLOT_LOCK_SUFFIX}`;
}

async function readPtySlotLock(storageDir: string, slot: string): Promise<PtySlotLockRecord | null> {
	try {
		const parsed: unknown = JSON.parse(await readFile(ptySlotLockPath(storageDir, slot), "utf8"));
		if (typeof parsed !== "object" || parsed === null) return null;
		const record = parsed as Record<string, unknown>;
		if (typeof record.holderId !== "string" || !Number.isSafeInteger(record.pid)) return null;
		const creation = record.creationTime === null ? null : record.creationTime;
		if (creation !== null && !isPtyCreationTime(creation)) return null;
		return {
			holderId: record.holderId,
			pid: record.pid as number,
			creationTime: creation,
			at: typeof record.at === "string" ? record.at : "",
		};
	} catch {
		return null;
	}
}

/** Result of trying to take a slot's launcher lock. */
export interface PtySlotLockResult {
	readonly acquired: boolean;
	readonly detail: string;
}

/**
 * Take the slot's interprocess launcher lock.
 *
 * This is what makes "the owner is gone, so the slot is free" safe: a launcher that is
 * reading a stale record, retiring it and starting a replacement does so while holding
 * this lock, and every claim consults it — so the moment between retiring a dead
 * broker's record and publishing the successor's can never be observed as "no owner".
 * A lock whose holder process is gone is taken over; one whose holder is alive is
 * waited for, bounded, and then refused rather than stolen.
 */
export async function acquirePtySlotLock(
	storageDir: string,
	slot: string,
	input: {
		readonly holderId: string;
		readonly waitMs?: number;
		/** Whether the lock's holder process is still alive; defaults to a liveness check. */
		readonly isHolderAlive?: (pid: number, creationTime: string | null) => boolean;
	},
): Promise<PtySlotLockResult> {
	const path = ptySlotLockPath(storageDir, slot);
	await mkdir(ptyStateDirectory(storageDir), { recursive: true, mode: 0o700 });
	const alive = input.isHolderAlive ?? ((pid: number): boolean => isPtyProcessAlive(pid));
	const deadline = Date.now() + (input.waitMs ?? SLOT_LOCK_WAIT_MS);
	for (;;) {
		try {
			await writeFile(
				path,
				`${JSON.stringify({
					holderId: input.holderId,
					pid: process.pid,
					creationTime: null,
					at: new Date().toISOString(),
				})}
`,
				{ flag: "wx", mode: 0o600 },
			);
			return { acquired: true, detail: "the slot lock is held" };
		} catch (error) {
			if ((error as NodeJS.ErrnoException | null)?.code !== "EEXIST") {
				return { acquired: false, detail: `the slot lock could not be created (${errorCode(error)})` };
			}
		}
		const held = await readPtySlotLock(storageDir, slot);
		if (held === null || held.holderId === input.holderId) {
			// Unreadable or already ours: an unreadable lock is replaced rather than
			// respected, because no live launcher ever leaves one behind.
			await rm(path, { force: true });
			continue;
		}
		if (!alive(held.pid, held.creationTime)) {
			// The holder is gone: its lock is stale, and the retire or claim it was
			// serializing cannot still be in progress.
			await rm(path, { force: true });
			continue;
		}
		if (Date.now() >= deadline) {
			return { acquired: false, detail: `another window holds the slot lock (pid ${held.pid})` };
		}
		await new Promise<void>(resolve => {
			const timer = setTimeout(resolve, SLOT_LOCK_POLL_MS);
			timer.unref();
		});
	}
}

/** Release a slot lock, but only the one this holder created. */
export async function releasePtySlotLock(storageDir: string, slot: string, holderId: string): Promise<void> {
	const held = await readPtySlotLock(storageDir, slot);
	if (held === null || held.holderId !== holderId) return;
	await rm(ptySlotLockPath(storageDir, slot), { force: true });
}

/** What one record path holds: nothing, a record, or bytes this build refuses. */
export type PtyRecordLookup =
	| { readonly kind: "none" }
	| { readonly kind: "ok"; readonly record: PtyBrokerRecord }
	| { readonly kind: "invalid"; readonly detail: string };

/** Read one slot's record. A malformed record is reported, never treated as absent. */
export async function readPtyRecord(storageDir: string, slot: string): Promise<PtyRecordLookup> {
	const path = ptyRecordPath(storageDir, slot);
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return { kind: "none" };
		return { kind: "invalid", detail: `the broker record could not be read (${errorCode(error)})` };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { kind: "invalid", detail: "the broker record is not JSON" };
	}
	try {
		return { kind: "ok", record: parsePtyBrokerRecord(parsed) };
	} catch (error) {
		return { kind: "invalid", detail: error instanceof Error ? error.message : "the broker record is malformed" };
	}
}

/** A listing of every record this window can parse, plus the ones it cannot. */
export interface PtyRecordListing {
	readonly directory: string;
	/** `true` when the state directory does not exist yet: no broker ever started. */
	readonly missing: boolean;
	readonly records: readonly PtyBrokerRecord[];
	/** Names present but unreadable or from another protocol version. */
	readonly invalid: readonly string[];
}

export async function listPtyRecords(storageDir: string): Promise<PtyRecordListing> {
	const directory = ptyStateDirectory(storageDir);
	let names: string[];
	try {
		names = await readdir(directory);
	} catch (error) {
		if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") {
			return { directory, missing: true, records: [], invalid: [] };
		}
		throw error;
	}
	const records: PtyBrokerRecord[] = [];
	const invalid: string[] = [];
	for (const name of names.filter(entry => entry.endsWith(PTY_RECORD_SUFFIX)).sort()) {
		let text: string;
		try {
			text = await readFile(join(directory, name), "utf8");
		} catch {
			invalid.push(name);
			continue;
		}
		try {
			records.push(parsePtyBrokerRecord(JSON.parse(text)));
		} catch {
			invalid.push(name);
		}
	}
	return { directory, missing: false, records, invalid };
}

/**
 * Establish and verify owner-only access over the record directory and its records.
 *
 * The directory is this module's own (it is rewritten non-recursively when it is
 * not yet limited, before anything is written into it); the records are verified as
 * files, and every ancestor the tree is reached through is derived and verified by
 * the shared convention. A directory that cannot be shown owner-only refuses, and
 * the PTY surface stays unavailable rather than publishing a token into a shared
 * directory.
 */
export async function ensurePtyStateAccess(
	storageDir: string,
	access?: PrivateStorageProbe,
): Promise<{ readonly ok: boolean; readonly reason: string | null }> {
	const root = ptyStateDirectory(storageDir);
	await mkdir(root, { recursive: true, mode: 0o700 });
	return await verifyPtyStateAccess(storageDir, access);
}

/** The verification half, for a caller that has already created the directory. */
export async function verifyPtyStateAccess(
	storageDir: string,
	access?: PrivateStorageProbe,
): Promise<{ readonly ok: boolean; readonly reason: string | null }> {
	const root = ptyStateDirectory(storageDir);
	const files: string[] = [];
	try {
		for (const name of await readdir(root)) {
			if (name.endsWith(PTY_RECORD_SUFFIX) || name.endsWith(PTY_SLOT_LOCK_SUFFIX)) files.push(join(root, name));
		}
	} catch {
		// A directory that is not there yet has nothing to verify beyond itself.
	}
	const restriction = await restrictPrivateStorage({
		layout: {
			root,
			directories: [root],
			verifiedDirectories: [],
			verifiedFiles: files,
			probeDirectory: root,
			probeText: PTY_STORAGE_PROBE_TEXT,
		},
		...(access === undefined ? {} : { probe: access }),
	});
	return { ok: restriction.restricted, reason: restriction.restricted ? null : restriction.reason };
}

/** Result of trying to occupy a slot. */
export interface PtyClaimResult {
	readonly claimed: boolean;
	readonly detail: string;
}

/** Result of trying to remove one record. */
export interface PtyRetireResult {
	readonly retired: boolean;
	readonly detail: string;
}

/**
 * Publish a record, claiming the slot atomically.
 *
 * `claimed: false` means the slot is occupied — by a live broker, by a stale record
 * whose owner is gone, or by bytes this build cannot read. Which of those it is has
 * to be established by the caller (`readPtyRecord` and a kernel reading of the
 * recorded pid); nothing here guesses, and nothing here replaces the occupant.
 */
export async function claimPtyRecord(
	storageDir: string,
	record: PtyBrokerRecord,
	options: { readonly launchId?: string } = {},
): Promise<PtyClaimResult> {
	const target = ptyRecordPath(storageDir, record.slot);
	// The directory is created here rather than assumed: a broker claims its slot
	// before anything else exists, and a claim that needs its caller to have prepared
	// the directory first is a claim that fails for the wrong reason.
	await mkdir(ptyStateDirectory(storageDir), { recursive: true, mode: 0o700 });
	// A launcher that holds this slot's lock is mid-replacement: publishing under it
	// would start the second writer the lock exists to prevent. This broker's own
	// launcher passes its launch id and is therefore allowed past its own lock.
	const held = await readPtySlotLock(storageDir, record.slot);
	if (held !== null && held.holderId !== options.launchId && isPtyProcessAlive(held.pid)) {
		return { claimed: false, detail: "another window is claiming this slot" };
	}
	const temporary = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
	await writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
	try {
		try {
			await link(temporary, target);
			return { claimed: true, detail: "the record was published" };
		} catch (error) {
			const code = (error as NodeJS.ErrnoException | null)?.code;
			if (code === "EEXIST") return { claimed: false, detail: "the slot already has a record" };
			// A filesystem that cannot hard-link still gets an exclusive create; a
			// path that exists then means the same thing it does above.
			try {
				await writeFile(target, await readFile(temporary), { flag: "wx", mode: 0o600 });
				return { claimed: true, detail: "the record was published" };
			} catch (fallback) {
				if ((fallback as NodeJS.ErrnoException | null)?.code === "EEXIST") {
					return { claimed: false, detail: "the slot already has a record" };
				}
				return { claimed: false, detail: `the record could not be published (${errorCode(fallback)})` };
			}
		}
	} finally {
		await unlink(temporary).catch(() => {});
	}
}

/**
 * Remove the record of a broker whose process this caller has proved is gone.
 *
 * The record is read and its `brokerId` compared with the expected one before it is
 * removed, so a successor's record is never deleted: a mismatch is a failed
 * retirement, not a live broker losing its record. The slot lock makes that check
 * and the removal one step. Callers still retire only after the recorded broker pid
 * was shown to be gone.
 */
export async function retirePtyRecord(
	storageDir: string,
	slot: string,
	expectedBrokerId: string,
	options: { readonly holderId?: string } = {},
): Promise<PtyRetireResult> {
	const target = ptyRecordPath(storageDir, slot);
	// With the lock held (ours or the caller's) no claim can publish into the slot, so
	// the record cannot change between the read below and the removal.
	const mine = options.holderId;
	const lockHolder = mine ?? `retire-${randomBytes(8).toString("hex")}`;
	if (mine === undefined) {
		const acquired = await acquirePtySlotLock(storageDir, slot, { holderId: lockHolder });
		if (!acquired.acquired) return { retired: false, detail: acquired.detail };
	}
	try {
		let owner: string | null = null;
		let present = true;
		try {
			owner = parsePtyBrokerRecord(JSON.parse(await readFile(target, "utf8"))).brokerId;
		} catch (error) {
			if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") present = false;
			else owner = null;
		}
		if (!present) return { retired: true, detail: "the record had already been removed" };
		if (owner !== expectedBrokerId) {
			return { retired: false, detail: "the record names a different broker than the one that was proved gone" };
		}
		await rm(target, { force: true });
		return { retired: true, detail: "the stale record was retired" };
	} catch (error) {
		return { retired: false, detail: `the record could not be retired (${errorCode(error)})` };
	} finally {
		if (mine === undefined) await releasePtySlotLock(storageDir, slot, lockHolder);
	}
}

function errorCode(error: unknown): string {
	const code = (error as NodeJS.ErrnoException | null)?.code;
	return typeof code === "string" ? code : "unknown";
}
