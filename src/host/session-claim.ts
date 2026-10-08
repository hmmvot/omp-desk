/**
 * Exact-session leases between extension windows (ADR-0039).
 *
 * Only a readable holder verified alive in its recorded process generation
 * excludes another holder. Dead, reused, absent, malformed and unanswerable
 * records are not ownership. Claim replacement/release is atomic under the
 * identity mutex; no caller directly unlinks a claim.
 *
 * If storage or its mutex cannot be used, a process-local lease protects this
 * window's integrity without modifying that namespace. A readable verified-live
 * rival still wins. This intentionally cannot exclude other windows in the
 * unrecorded-launch interval; that residual risk is accepted by design.
 */

import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fsSync from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { retryWindowsFileOperation } from "./file-operation-retry.ts";
import { windowsPowerShellEnvironment, windowsPowerShellExecutable } from "./windows-powershell.ts";

/** Directory created under `storageDir` that owns every claim file. */
export const CLAIM_DIRECTORY = "session-claims";

/**
 * Prefix distinguishing a reserved draft identity (a session that has no file
 * yet) from a materialized session file path.
 */
export const DRAFT_IDENTITY_PREFIX = "draft:";

const CLAIM_FILE_SUFFIX = ".claim";
const CLAIM_MUTEX_SUFFIX = ".mutex";
const CLAIM_RECORD_VERSION = 1;
const DRAFT_ID_RE = /^[A-Za-z0-9._-]{1,200}$/;
const OWNER_GENERATION_RE = /^[A-Za-z0-9._:-]{1,200}$/;
/** How long a contender waits for a claim mutation lock before failing closed. */
const CLAIM_LOCK_WAIT_MS = 1000;
const CLAIM_LOCK_POLL_MS = 10;

/** A claim held by this owner; `release()` is the only way to give it up. */
export interface SessionClaim {
	/** Absolute storage directory this claim is filed under. */
	readonly storageDir: string;
	/** Identity exactly as the owner passed it. */
	readonly identity: string;
	/** Normalized identity that selects the claim file. */
	readonly normalizedIdentity: string;
	/** Absolute path of the claim file. */
	readonly claimPath: string;
	/** Random generation identifying this particular owner. */
	readonly ownerGeneration: string;
	/** The live holder that took this claim; only it may release it. */
	readonly holder: ClaimHolder;
	/**
	 * Release the claim. Idempotent. Rejects with {@link ClaimOwnershipError}
	 * when the claim now belongs to a different owner generation, and with
	 * {@link ClaimHolderError} when another live holder of this generation has
	 * taken it; in both cases the claim file is left untouched. Callers MUST
	 * stop the owning host first.
	 */
	release(): Promise<void>;
}

/**
 * One live holder of a claim: an extension host, for as long as it runs.
 *
 * A persisted `ownerGeneration` cannot keep two windows apart — both read the
 * same session record and present the same generation — so the holder does. It is minted
 * per extension host, never persisted, and never shared with another process,
 * which makes "same generation, different holder" mean exactly "same logical
 * session, another live window".
 */
export interface ClaimHolder {
	/** Random id minted per holder; distinct in every process, never persisted. */
	readonly id: string;
	/**
	 * Process id of that holder, recorded on disk so a later holder can ask
	 * whether the one that filed the claim can still be running.
	 */
	readonly pid: number;
	readonly processCreationTime?: string | null;
	/** Owning window's folder or saved workspace URI, for explicit window navigation only. */
	readonly windowUri?: string | null;
}

/**
 * A claim file as read back from disk. `verifiable === false` means the file
 * exists but is not a readable record for this identity; that is never
 * evidence that the identity is free.
 */
export interface ObservedClaim {
	/** Absolute path of the claim file. */
	readonly claimPath: string;
	/** Normalized identity the claim file is filed under. */
	readonly normalizedIdentity: string;
	/** `false` when the claim file exists but holds no readable record. */
	readonly verifiable: boolean;
	/** Recorded owner generation, or `null` when unverifiable. */
	readonly ownerGeneration: string | null;
	/**
	 * Holder that filed this claim, or `null` when unverifiable or when the
	 * record predates the holder lease (those are replaced on the next acquisition).
	 */
	readonly holderId: string | null;
	/** Identity the owner passed, or `null` when unverifiable. */
	readonly identity: string | null;
	/** Holding process id at claim time, or `null`. */
	readonly pid: number | null;
	/** ISO creation timestamp, or `null`. */
	readonly createdAt: string | null;
	readonly processCreationTime?: string | null;
	readonly windowUri?: string | null;
}

/** Fields shared by every claim failure. */
interface ClaimLocation {
	identity: string;
	normalizedIdentity: string;
	claimPath: string;
}

/** Base class for claim failures. */
export class ClaimError extends Error {
	/** Identity the caller asked about, exactly as passed. */
	readonly identity: string;
	/** Normalized identity that selects the claim file. */
	readonly normalizedIdentity: string;
	/** Absolute path of the claim file. */
	readonly claimPath: string;

	constructor(message: string, location: ClaimLocation) {
		super(message);
		this.name = "ClaimError";
		this.identity = location.identity;
		this.normalizedIdentity = location.normalizedIdentity;
		this.claimPath = location.claimPath;
	}
}

/**
 * The identity is already claimed by another owner generation, or by another
 * live holder of the caller's own generation. The existing claim is left
 * untouched: recovering from this requires the higher layer to prove that no
 * writer is alive (live terminal, authenticated OMP registry, recorded owner)
 * before any reconciliation.
 */
export class ClaimConflictError extends ClaimError {
	/** Owner generation recorded in the existing claim, or `null`. */
	readonly existingOwnerGeneration: string | null;
	/** Holder recorded in the existing claim, or `null` on a pre-lease record. */
	readonly existingHolderId: string | null;
	/** PID recorded in the existing claim (the holder's process), or `null`. */
	readonly existingPid: number | null;
	/** Creation timestamp of the existing claim, or `null`. */
	readonly existingCreatedAt: string | null;
	/** `true` when the existing claim file could not be read as a record. */
	readonly unverifiable: boolean;

	constructor(observed: ObservedClaim, identity: string, message?: string) {
		const owner = observed.verifiable
			? `ownerGeneration=${observed.ownerGeneration}, holder=${observed.holderId ?? "none recorded"}, ` +
				`pid=${observed.pid}, createdAt=${observed.createdAt}`
			: "unreadable claim record";
		super(
			message ??
				`A claim for ${identity} already exists at ${observed.claimPath} (${owner}); existing claims are never stolen, ` +
					"so reconcile the recorded owner before taking this session.",
			{ identity, normalizedIdentity: observed.normalizedIdentity, claimPath: observed.claimPath },
		);
		this.name = "ClaimConflictError";
		this.existingOwnerGeneration = observed.ownerGeneration;
		this.existingHolderId = observed.holderId;
		this.existingPid = observed.pid;
		this.existingCreatedAt = observed.createdAt;
		this.unverifiable = !observed.verifiable;
	}
}


/**
 * The claim carries this owner's generation but another live holder took it, so
 * this holder released nothing.
 *
 * Distinct from {@link ClaimOwnershipError} on purpose: a different generation
 * means a higher layer reconciled the claim away and the identity is free for
 * this owner to take again, while a different *holder* means a live window of
 * this very session holds it, and treating that as "free" would erase its claim.
 */
export class ClaimHolderError extends ClaimError {
	/** Holder the caller holds (or expected to hold). */
	readonly expectedHolderId: string;
	/** Holder actually recorded, or `null` on a pre-lease record. */
	readonly actualHolderId: string | null;
	/** Recorded process id of that holder, or `null`. */
	readonly actualPid: number | null;

	constructor(observed: ObservedClaim, identity: string, expectedHolderId: string) {
		super(
			`Claim at ${observed.claimPath} is held by holder ${observed.holderId ?? "none recorded"} ` +
				`(pid ${observed.pid ?? "unknown"}) of this owner generation, not by holder ${expectedHolderId}; ` +
				"refusing to release a claim another live window holds.",
			{ identity, normalizedIdentity: observed.normalizedIdentity, claimPath: observed.claimPath },
		);
		this.name = "ClaimHolderError";
		this.expectedHolderId = expectedHolderId;
		this.actualHolderId = observed.holderId;
		this.actualPid = observed.pid;
	}
}

/**
 * The per-identity claim mutation lock is held — by another contender, or
 * abandoned by a holder that died inside its critical section. Nothing was
 * changed. A busy lock is never stolen and is reported as a conflict so the
 * higher layer reconciles (or retries) instead of launching a writer.
 */
export class ClaimBusyError extends ClaimConflictError {
	/** Mutex directory that blocked the operation. */
	readonly mutexPath: string;

	constructor(location: ClaimLocation, mutexPath: string) {
		super(
			observedClaim(location.claimPath, location.normalizedIdentity, null),
			location.identity,
			`Claim mutations for ${location.identity} are serialized by ${mutexPath}, which is held by another ` +
				"operation or was abandoned by a crash; nothing was changed, so re-read the claim state and reconcile " +
				"before retrying.",
		);
		this.name = "ClaimBusyError";
		this.mutexPath = mutexPath;
	}
}

/**
 * The claim at this path is not owned by the caller's generation, so it was
 * not released and not removed.
 */
export class ClaimOwnershipError extends ClaimError {
	/** Owner generation the caller claimed. */
	readonly expectedOwnerGeneration: string;
	/** Owner generation actually recorded, or `null` when unverifiable. */
	readonly actualOwnerGeneration: string | null;

	constructor(observed: ObservedClaim, identity: string, expectedOwnerGeneration: string) {
		const actual = observed.verifiable ? observed.ownerGeneration : "an unreadable claim record";
		super(
			`Claim at ${observed.claimPath} is owned by ${actual}, not ${expectedOwnerGeneration}; ` +
				"refusing to release a claim this owner does not hold.",
			{ identity, normalizedIdentity: observed.normalizedIdentity, claimPath: observed.claimPath },
		);
		this.name = "ClaimOwnershipError";
		this.expectedOwnerGeneration = expectedOwnerGeneration;
		this.actualOwnerGeneration = observed.ownerGeneration;
	}
}

/**
 * The canonical claim was acquired but the superseded draft claim could not be
 * released. The canonical claim is still held and is available as
 * {@link ClaimPromotionError.claim}; the caller MUST keep using it (or release
 * it explicitly) instead of acquiring again.
 */
export class ClaimPromotionError extends ClaimError {
	/** The canonical claim that was successfully acquired. */
	readonly claim: SessionClaim;
	/** Why releasing the draft claim failed. */
	readonly reason: unknown;

	constructor(claim: SessionClaim, reason: unknown) {
		super(
			`Canonical claim ${claim.claimPath} was acquired, but releasing the draft claim failed ` +
				`(${reason instanceof Error ? reason.message : String(reason)}). The canonical claim is still held by this owner.`,
			{ identity: claim.identity, normalizedIdentity: claim.normalizedIdentity, claimPath: claim.claimPath },
		);
		this.name = "ClaimPromotionError";
		this.claim = claim;
		this.reason = reason;
	}
}

/** Mint a reserved draft identity for a session that has no file yet. */
export function createDraftIdentity(): string {
	return `${DRAFT_IDENTITY_PREFIX}${randomUUID()}`;
}

/** Mint a random owner generation for one logical claim owner. */
export function createOwnerGeneration(): string {
	return randomUUID();
}

/**
 * Ids of holders this process has minted, so it can tell its own leases from a
 * rival's even when both run in one process. Never persisted and never shared
 * with another process.
 */
const liveHolderIds = new Set<string>();
/** Process-local integrity when the on-disk claim namespace cannot be used. */
const localClaims = new Map<string, ClaimRecord>();

/**
 * Mint the holder lease for one extension host.
 *
 * `pid` is the process the holder lives in and defaults to this one. A holder
 * for any other pid stands for a process that has to be probed on disk, so it is
 * deliberately *not* registered as live here.
 */
export function createClaimHolder(pid: number = process.pid): ClaimHolder {
	const id = randomUUID();
	if (pid === process.pid) liveHolderIds.add(id);
	return { id, pid, processCreationTime: processCreationTime(pid) };
}

/** `true` when `identity` is a reserved draft identity rather than a path. */
export function isDraftIdentity(identity: string): boolean {
	return typeof identity === "string" && identity.startsWith(DRAFT_IDENTITY_PREFIX);
}

/**
 * Fold an identity into the key that selects its claim file.
 *
 * Draft identities keep their reserved namespace. Path identities are resolved
 * to an absolute path, canonicalized against the filesystem (existing ancestors
 * as well, so a not-yet-materialized session file still collects its directory's
 * real casing), and on Windows folded to case-insensitive `\`-separated form so
 * aliases such as `C:\Users\X\S.jsonl`, `c:/users/x/s.jsonl`, `\\?\C:\...`,
 * 8.3 short names and trailing dots or spaces all collide on one claim.
 */
export function normalizeClaimIdentity(identity: string): string {
	if (typeof identity !== "string") throw new TypeError("claim identity must be a string");
	if (identity.length === 0) throw new TypeError("claim identity must not be empty");
	if (identity.includes("\0")) throw new TypeError("claim identity must not contain a NUL character");
	if (isDraftIdentity(identity)) {
		const draftId = identity.slice(DRAFT_IDENTITY_PREFIX.length).toLowerCase();
		if (!DRAFT_ID_RE.test(draftId)) throw new TypeError(`invalid draft claim identity: ${identity}`);
		return `${DRAFT_IDENTITY_PREFIX}${draftId}`;
	}
	return foldPathIdentity(path.resolve(identity));
}

/** Directory holding every claim file for `storageDir`. */
export function claimsDirectory(storageDir: string): string {
	if (typeof storageDir !== "string" || storageDir.trim().length === 0) {
		throw new TypeError("claim storageDir must be a non-empty directory path");
	}
	return path.join(path.resolve(storageDir), CLAIM_DIRECTORY);
}

/** Absolute claim file path for `identity` under `storageDir`. */
export function claimPathFor(storageDir: string, identity: string): string {
	return claimFilePath(storageDir, normalizeClaimIdentity(identity));
}

/**
 * Directory used as the per-identity mutation lock for `identity`.
 *
 * Exported for explicit reconciliation: a higher layer that has proven no
 * writer is alive may take this lock (`mkdir`, then `rm -r`) around its own
 * change instead of mutating a claim path behind the module's back.
 */
export function claimMutexPath(storageDir: string, identity: string): string {
	return mutexPathFor(claimPathFor(storageDir, identity));
}

/** Claim file path for an identity that is already normalized. */
function claimFilePath(storageDir: string, normalizedIdentity: string): string {
	return path.join(claimsDirectory(storageDir), `${claimKey(normalizedIdentity)}${CLAIM_FILE_SUFFIX}`);
}

/** Lock directory that serializes mutations of one claim path. */
function mutexPathFor(claimPath: string): string {
	return `${claimPath}${CLAIM_MUTEX_SUFFIX}`;
}

function foldPathIdentity(resolvedPath: string): string {
	const canonical = canonicalizeExistingAncestor(resolvedPath);
	return process.platform === "win32" ? foldWindowsPath(canonical) : canonical;
}

/**
 * `realpathSync` on the deepest existing ancestor of `target`, re-joined with
 * the not-yet-existing suffix. Falls back to `target` when nothing resolves.
 */
function canonicalizeExistingAncestor(target: string): string {
	const resolved = path.resolve(target);
	const pending: string[] = [];
	let current = resolved;
	for (;;) {
		try {
			const real = resolveRealPath(current);
			return pending.length === 0 ? real : path.join(real, ...pending.reverse());
		} catch {
			const parent = path.dirname(current);
			if (parent === current) return resolved;
			pending.push(path.basename(current));
			current = parent;
		}
	}
}

/**
 * Resolve `target` through the OS, preferring `realpathSync.native`: unlike the
 * portable implementation it also resolves 8.3 short names, so `PROGRA~1` and
 * `Program Files` fold onto the same claim instead of two writers.
 */
function resolveRealPath(target: string): string {
	if (typeof fsSync.realpathSync.native === "function") {
		try {
			return fsSync.realpathSync.native(target);
		} catch {
			// Fall through to the portable implementation.
		}
	}
	return fsSync.realpathSync(target);
}

/**
 * Win32 comparison form: strip the `\\?\`/`\\?\UNC\` long-path prefix, fold
 * separators, drop trailing dots and spaces that Win32 ignores on each
 * component, and lowercase (Win32 path comparison is case-insensitive).
 */
function foldWindowsPath(winPath: string): string {
	const unfolded = winPath.replace(/\//g, "\\").replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/i, "");
	const segments = unfolded.split("\\");
	for (let index = 1; index < segments.length; index++) {
		const segment = segments[index] ?? "";
		const trimmed = segment.replace(/[ .]+$/, "");
		// Keep a segment that is only dots (`..`) or empty: only real trailing
		// dots/spaces are aliases, and a component must not become empty.
		if (trimmed.length > 0 || segment.length === 0) segments[index] = trimmed;
	}
	while (segments.length > 1 && segments[segments.length - 1] === "") segments.pop();
	return segments.join("\\").toLowerCase();
}

function claimKey(normalizedIdentity: string): string {
	return createHash("sha256").update(normalizedIdentity, "utf8").digest("hex");
}

/**
 * Atomically take the exclusive claim for `identity`.
 *
 * The whole decision runs under the per-identity mutation lock, so no contender
 * can observe or change the claim path while this one is deciding:
 *
 * 1. the record is written to a private staging file in the claims directory,
 * 2. `link` publishes it at the claim path, failing with `EEXIST` when another
 *    owner already holds it,
 * 3. the staging entry is removed, leaving the claim as an ordinary file.
 *
 * Because the claim path is only ever published with its complete record, a
 * contender that loses the race can always report the winning owner instead of
 * an unreadable file. Filesystems without hard links fall back to exclusive
 * create plus write; that fallback's empty window is invisible to contenders
 * because they must hold the same lock to touch the path.
 *
 * Only a different positively verified live holder is a conflict, regardless of
 * owner generation. Missing, corrupt, dead or unverifiable records are replaced
 * under the mutation lock. Unusable storage or an unavailable lock falls back to
 * a process-local lease without modifying another holder's namespace.
 *
 * `ownerGeneration` identifies the logical owner across restarts (see
 * {@link createOwnerGeneration}); `holder` identifies the extension host taking
 * the claim right now (see {@link createClaimHolder}). `identity` is a session
 * file path once the session is materialized, or `createDraftIdentity()` before
 * any file exists.
 */
export async function acquireClaim(
	storageDir: string,
	identity: string,
	ownerGeneration: string,
	holder: ClaimHolder,
): Promise<SessionClaim> {
	assertOwnerGeneration(ownerGeneration);
	assertHolder(holder);
	const normalizedIdentity = normalizeClaimIdentity(identity);
	const claimPath = claimFilePath(storageDir, normalizedIdentity);

	const record = claimRecord(identity, normalizedIdentity, ownerGeneration, holder);
	const location: ClaimLocation = { identity, normalizedIdentity, claimPath };
	const handle = (): SessionClaim => {
		return createClaimHandle(storageDir, identity, normalizedIdentity, claimPath, ownerGeneration, holder);
	};

	const local = localClaims.get(claimPath);
	if (local !== undefined) {
		const observed = observedClaim(claimPath, normalizedIdentity, local);
		if (local.holderId !== holder.id && claimHolderMayBeAlive(observed)) {
			throw rivalHolderConflict(observed, identity, ownerGeneration);
		}
		localClaims.set(claimPath, record);
		return handle();
	}
	try {
		await fsp.mkdir(path.dirname(claimPath), { recursive: true, mode: 0o700 });
		return await withIdentityLock(location, async () => {
			if (await publishClaimFile(claimPath, record)) return handle();
			const observed = await readClaimFile(claimPath, normalizedIdentity);
			if (observed !== null && observed.holderId === holder.id) return handle();
			if (observed !== null && claimHolderMayBeAlive(observed)) {
				throw rivalHolderConflict(observed, identity, ownerGeneration);
			}
			await replaceClaimRecord(claimPath, record);
			return handle();
		});
	} catch (error) {
		if (error instanceof ClaimConflictError && !(error instanceof ClaimBusyError)) throw error;
		const observed = await readClaimFile(claimPath, normalizedIdentity).catch(() => null);
		if (observed !== null && observed.holderId !== holder.id && claimHolderMayBeAlive(observed)) {
			throw rivalHolderConflict(observed, identity, ownerGeneration);
		}
		localClaims.set(claimPath, record);
		return handle();
	}
}


/** The record one holder files; the single definition of the on-disk claim format. */
function claimRecord(
	identity: string,
	normalizedIdentity: string,
	ownerGeneration: string,
	holder: ClaimHolder,
): ClaimRecord {
	return {
		version: CLAIM_RECORD_VERSION,
		identity,
		normalizedIdentity,
		ownerGeneration,
		holderId: holder.id,
		pid: holder.pid,
		processCreationTime: holder.processCreationTime ?? null,
		windowUri: holder.windowUri ?? null,
		createdAt: new Date().toISOString(),
	};
}

/** The refusal a second live holder of one generation gets; nothing was changed. */
function rivalHolderConflict(
	observed: ObservedClaim,
	identity: string,
	ownerGeneration: string,
): ClaimConflictError {
	return new ClaimConflictError(
		observed,
		identity,
		`Another live window holds this session: claim ${observed.claimPath} is held by holder ` +
			`${observed.holderId} (pid ${observed.pid ?? "unknown"}) of owner generation ${ownerGeneration}, ` +
			"and this window is a different holder of that generation. Nothing was taken; close or reconcile " +
			"the other window before opening this session here.",
	);
}

/**
 * Replace the claim record at `claimPath` with `record`, taking over a claim
 * whose holder is not verified alive (including the caller's own pre-lease record).
 *
 * Callers MUST hold the identity lock and MUST have established that the record
 * is not held by a verified-live holder (a pre-lease record, or a holder that
 * is gone). `rename` replaces the path in one step, so a contender can
 * never observe a missing claim file.
 */
async function replaceClaimRecord(claimPath: string, record: ClaimRecord): Promise<void> {
	await replaceStagedFile(claimPath, `${JSON.stringify(record, null, "\t")}\n`);
}

/**
 * Replace the file at `target` with `content` in one rename, so no contender can
 * observe a missing file. The staged entry is private to this process and is
 * removed whatever happens.
 */
async function replaceStagedFile(target: string, content: string): Promise<void> {
	const staged = `${target}.${process.pid}.${randomUUID()}.staged`;
	try {
		const handle = await fsp.open(staged, "wx", 0o600);
		try {
			await handle.writeFile(content, "utf8");
		} finally {
			await handle.close();
		}
		await retryWindowsFileOperation(() => fsp.rename(staged, target));
	} finally {
		await fsp.rm(staged, { force: true }).catch(() => undefined);
	}
}

/**
 * Publish `record` at `claimPath`; `false` when another owner already holds it.
 * Callers MUST already hold the identity lock — this mutates the claim path.
 */
async function publishClaimFile(claimPath: string, record: ClaimRecord): Promise<boolean> {
	return await publishStagedFile(claimPath, `${JSON.stringify(record, null, "\t")}\n`);
}

/**
 * Publish `content` at `target` without replacing anything that is already
 * there; `false` when the target exists. Callers MUST already hold the target's
 * identity lock — this mutates the path.
 *
 * The record is written to a private staging file and linked into place, so a
 * contender that loses the race always reads a complete record rather than an
 * empty or half-written one.
 */
async function publishStagedFile(target: string, content: string): Promise<boolean> {
	const staged = `${target}.${process.pid}.${randomUUID()}.staged`;
	try {
		const stagedHandle = await fsp.open(staged, "wx", 0o600);
		try {
			await stagedHandle.writeFile(content, "utf8");
		} finally {
			await stagedHandle.close();
		}

		try {
			await fsp.link(staged, target);
			return true;
		} catch (error) {
			if (isErrorCode(error, "EEXIST")) return false;
			if (!isLinkUnsupported(error)) throw error;
		}

		// Hard links are unavailable on this volume: create exclusively instead.
		try {
			await writeExclusiveFile(target, content);
			return true;
		} catch (fallbackError) {
			if (isErrorCode(fallbackError, "EEXIST")) return false;
			throw fallbackError;
		}
	} finally {
		// The staged entry is inert once linked; never leave it behind.
		await fsp.rm(staged, { force: true }).catch(() => undefined);
	}
}

/**
 * Fallback for volumes without hard links: exclusive create, then write.
 *
 * The target is created empty and filled, so a failed write must not leave an
 * unreadable record behind. Cleanup only removes the file this call created:
 * the lock already prevents a contender from replacing the path, and the file
 * identity check additionally refuses to delete a record that a mutation
 * ignoring the lock put in its place.
 */
async function writeExclusiveFile(target: string, content: string): Promise<void> {
	const handle = await fsp.open(target, "wx", 0o600);
	const created = await handle.stat();
	try {
		await handle.writeFile(content, "utf8");
	} catch (error) {
		await handle.close().catch(() => undefined);
		const current = await fsp.stat(target).catch(() => null);
		const replaced =
			created.ino !== 0 &&
			current !== null &&
			current.ino !== 0 &&
			(created.ino !== current.ino || created.dev !== current.dev);
		if (!replaced) await fsp.rm(target, { force: true }).catch(() => undefined);
		throw error;
	}
	await handle.close();
}

/** Filesystem errors reported by volumes without hard-link support. */
function isLinkUnsupported(error: unknown): boolean {
	return (
		isErrorCode(error, "EPERM") ||
		isErrorCode(error, "EACCES") ||
		isErrorCode(error, "ENOSYS") ||
		isErrorCode(error, "ENOTSUP") ||
		isErrorCode(error, "EOPNOTSUPP") ||
		isErrorCode(error, "EXDEV")
	);
}

/**
 * Acquire the canonical session-file claim while the draft claim stays held,
 * then release the draft. The canonical claim exists before the draft is given
 * up, so no window can observe a moment where this session is unclaimed.
 *
 * The draft and the session-file identity each take their own mutation lock,
 * sequentially (never nested). On conflict, on a busy lock, or on any other
 * acquisition failure the draft claim is retained untouched: the caller still
 * owns the session and must reconcile before launching a host.
 */
export async function promoteDraftClaim(draft: SessionClaim, sessionFilePath: string): Promise<SessionClaim> {
	assertClaimHandle(draft);
	if (!isDraftIdentity(draft.identity)) {
		throw new TypeError(`promoteDraftClaim requires a draft claim, received ${draft.identity}`);
	}
	const promoted = await acquireClaim(draft.storageDir, sessionFilePath, draft.ownerGeneration, draft.holder);
	try {
		await draft.release();
	} catch (error) {
		// The draft identity was taken over or removed by a higher-layer
		// reconciliation: there is nothing left for this owner to release. The
		// canonical claim is unaffected and stays held.
		if (!(error instanceof ClaimOwnershipError)) throw new ClaimPromotionError(promoted, error);
	}
	return promoted;
}

/**
 * Read the current claim for `identity` without taking it. Returns `null` only
 * when no claim file exists; a corrupt file is returned as
 * `verifiable: false`, never as a free identity.
 */
export async function readClaim(storageDir: string, identity: string): Promise<ObservedClaim | null> {
	const normalizedIdentity = normalizeClaimIdentity(identity);
	const claimPath = claimFilePath(storageDir, normalizedIdentity);
	const local = localClaims.get(claimPath);
	if (local !== undefined) return observedClaim(claimPath, normalizedIdentity, local);
	return readClaimFile(claimPath, normalizedIdentity);
}

function createClaimHandle(
	storageDir: string,
	identity: string,
	normalizedIdentity: string,
	claimPath: string,
	ownerGeneration: string,
	holder: ClaimHolder,
): SessionClaim {
	let released = false;
	const claim: SessionClaim = {
		storageDir: path.resolve(storageDir),
		identity,
		normalizedIdentity,
		claimPath,
		ownerGeneration,
		holder,
		async release(): Promise<void> {
			if (released) return;
			const local = localClaims.get(claimPath);
			if (local !== undefined && local.holderId === holder.id) {
				localClaims.delete(claimPath);
				released = true;
				return;
			}
			await releaseClaimFile(claimPath, identity, normalizedIdentity, ownerGeneration, holder.id);
			released = true;
		},
	};
	return Object.freeze(claim);
}

/**
 * Release one claim, serialized against every other mutation of this identity.
 *
 * Under the lock the record is re-read and must be this owner generation *and*
 * this holder before anything is removed, so a claim another owner took, another
 * live window of this same session took, or a reconciliation replaced is never
 * deleted — it is reported instead. No rename or unlink happens outside the
 * lock, so a release can never open a window in which a third contender could
 * take the identity while a foreign claim lives.
 */
async function releaseClaimFile(
	claimPath: string,
	identity: string,
	normalizedIdentity: string,
	ownerGeneration: string,
	holderId: string,
): Promise<void> {
	await withIdentityLock({ identity, normalizedIdentity, claimPath }, async () => {
		const observed = await readClaimFile(claimPath, normalizedIdentity);
		// No file: this owner holds nothing. A higher layer may have reconciled the
		// claim away (or a previous release already finished), so this is a no-op.
		if (observed === null) return;
		if (!isSameOwner(observed, normalizedIdentity, ownerGeneration)) {
			throw new ClaimOwnershipError(observed, identity, ownerGeneration);
		}
		if (observed.holderId !== holderId) throw new ClaimHolderError(observed, identity, holderId);
		// Re-read under the same lock before deleting, so a mutation that ignores
		// the lock is caught here instead of having its claim removed by this
		// release; the lock itself is what makes the ordinary case race-free.
		const confirmed = await readClaimFile(claimPath, normalizedIdentity);
		if (confirmed === null || !isSameOwner(confirmed, normalizedIdentity, ownerGeneration)) {
			throw new ClaimOwnershipError(
				confirmed ?? observedClaim(claimPath, normalizedIdentity, null),
				identity,
				ownerGeneration,
			);
		}
		if (confirmed.holderId !== holderId) throw new ClaimHolderError(confirmed, identity, holderId);
		await fsp.rm(claimPath, { force: true });
	});
}

/**
 * Serialize every claim-path mutation for one identity.
 *
 * `mkdir` is the atomic primitive: exactly one contender creates the mutex
 * directory, everyone else gets `EEXIST` and waits for it to disappear. The
 * wait exists only to outlast a live critical section — an abandoned mutex (a
 * holder that died inside the section) is NEVER stolen by age or PID; once the
 * bounded wait is exhausted the operation fails closed with
 * {@link ClaimBusyError} and leaves the mutex in place for reconciliation.
 */
async function withIdentityLock<T>(location: ClaimLocation, operation: () => Promise<T>): Promise<T> {
	const mutexPath = mutexPathFor(location.claimPath);
	const deadline = Date.now() + CLAIM_LOCK_WAIT_MS;
	for (;;) {
		try {
			await fsp.mkdir(mutexPath, { mode: 0o700 });
			break;
		} catch (error) {
			if (!isErrorCode(error, "EEXIST")) throw error;
			if (Date.now() >= deadline) throw new ClaimBusyError(location, mutexPath);
			await delay(CLAIM_LOCK_POLL_MS);
		}
	}

	try {
		return await operation();
	} finally {
		// Best effort: if this fails the mutex stays behind and later operations
		// fail closed rather than proceeding unguarded.
		await fsp.rm(mutexPath, { recursive: true, force: true }).catch(() => undefined);
	}
}

interface ClaimRecord {
	version: number;
	identity: string;
	normalizedIdentity: string;
	ownerGeneration: string;
	/**
	 * Holder lease that filed this claim. Absent on a record written before the
	 * lease existed; such a record is replaced on the next acquisition by any
	 * holder, so the absence never outlives one acquisition.
	 */
	holderId?: string;
	/** Process id of that holder — the one fact a later holder may probe. */
	pid: number;
	createdAt: string;
	processCreationTime?: string | null;
	windowUri?: string | null;
}

/** `null` when no claim file exists; an unverifiable observation otherwise. */
async function readClaimFile(claimPath: string, normalizedIdentity: string): Promise<ObservedClaim | null> {
	let content: string;
	try {
		content = await fsp.readFile(claimPath, "utf8");
	} catch (error) {
		if (isErrorCode(error, "ENOENT")) return null;
		throw error;
	}
	return parseClaimRecord(content, claimPath, normalizedIdentity);
}

function parseClaimRecord(content: string, claimPath: string, normalizedIdentity: string): ObservedClaim {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		return observedClaim(claimPath, normalizedIdentity, null);
	}
	// A record filed under another identity means the claim path and its content
	// disagree (tampering or a hashing change): treat it as unverifiable.
	if (!isClaimRecord(parsed) || parsed.normalizedIdentity !== normalizedIdentity) {
		return observedClaim(claimPath, normalizedIdentity, null);
	}
	return observedClaim(claimPath, normalizedIdentity, parsed);
}

function observedClaim(
	claimPath: string,
	normalizedIdentity: string,
	record: ClaimRecord | null,
): ObservedClaim {
	if (record === null) {
		return {
			claimPath,
			normalizedIdentity,
			verifiable: false,
			ownerGeneration: null,
			holderId: null,
			identity: null,
			pid: null,
			createdAt: null,
		};
	}
	return {
		claimPath,
		normalizedIdentity,
		verifiable: true,
		ownerGeneration: record.ownerGeneration,
		holderId: record.holderId ?? null,
		identity: record.identity,
		pid: record.pid,
		createdAt: record.createdAt,
		processCreationTime: record.processCreationTime ?? null,
		windowUri: typeof record.windowUri === "string" ? record.windowUri : null,
	};
}

function isClaimRecord(value: unknown): value is ClaimRecord {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Partial<ClaimRecord>;
	return (
		record.version === CLAIM_RECORD_VERSION &&
		typeof record.identity === "string" &&
		typeof record.normalizedIdentity === "string" &&
		OWNER_GENERATION_RE.test(record.ownerGeneration ?? "") &&
		(record.holderId === undefined || OWNER_GENERATION_RE.test(record.holderId)) &&
		typeof record.pid === "number" &&
		typeof record.createdAt === "string"
	);
}

/** `true` when the record belongs to this logical owner, whatever holder filed it. */
function isSameOwner(observed: ObservedClaim, normalizedIdentity: string, ownerGeneration: string): boolean {
	return (
		observed.verifiable &&
		observed.normalizedIdentity === normalizedIdentity &&
		observed.ownerGeneration === ownerGeneration
	);
}

/**
 * `true` only when the extension host that filed this claim is verified alive.
 *
 * This process's registered holder ids are definitive. A foreign holder needs
 * a current process and matching kernel creation time; older claims must have
 * been written after that process started. Missing or unreadable evidence is
 * not ownership. Native OMP children are verified separately by their broker.
 */
export function claimHolderMayBeAlive(observed: ObservedClaim): boolean {
	if (!observed.verifiable || observed.pid === null || observed.holderId === null) return false;
	if (observed.pid === process.pid) return liveHolderIds.has(observed.holderId);
	if (!holderProcessAlive(observed.pid)) return false;
	const creationTime = processCreationTime(observed.pid);
	if (creationTime === null) return false;
	if (observed.processCreationTime != null) return creationTime === observed.processCreationTime;
	return observed.createdAt !== null && Date.parse(creationTime) <= Date.parse(observed.createdAt);
}

/** A successful existence probe; generation matching is required separately. */
function holderProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return false;
	}
}

let ownProcessCreationTime: string | null | undefined;

/** Read a process generation; an unavailable reading never proves a claim holder. */
function processCreationTime(pid: number): string | null {
	if (pid === process.pid && ownProcessCreationTime !== undefined) return ownProcessCreationTime;
	let result: string | null = null;
	try {
		const raw = process.platform === "win32"
			? execFileSync(windowsPowerShellExecutable(), ["-NoProfile", "-NonInteractive", "-Command",
				`(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`],
				{ encoding: "utf8", timeout: 5000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"], env: windowsPowerShellEnvironment() })
			: execFileSync("ps", ["-o", "lstart=", "-p", String(pid)],
				{ encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
		const time = Date.parse(raw.trim());
		if (Number.isFinite(time)) result = new Date(time).toISOString();
	} catch {
		// No verified generation means not owned.
	}
	if (pid === process.pid) ownProcessCreationTime = result;
	return result;
}

function assertOwnerGeneration(ownerGeneration: string): void {
	if (typeof ownerGeneration !== "string" || !OWNER_GENERATION_RE.test(ownerGeneration)) {
		throw new TypeError(
			"claim ownerGeneration must be a non-empty string of at most 200 characters from [A-Za-z0-9._:-]",
		);
	}
}

function assertHolder(holder: ClaimHolder): void {
	if (typeof holder !== "object" || holder === null) {
		throw new TypeError("claim holder must come from createClaimHolder()");
	}
	assertOwnerGeneration(holder.id);
	if (!Number.isInteger(holder.pid) || holder.pid <= 0) {
		throw new TypeError("claim holder must carry a positive integer process id");
	}
}

function assertClaimHandle(draft: SessionClaim): void {
	if (
		typeof draft !== "object" ||
		draft === null ||
		typeof draft.release !== "function" ||
		typeof draft.storageDir !== "string" ||
		typeof draft.identity !== "string" ||
		typeof draft.ownerGeneration !== "string" ||
		typeof draft.holder !== "object" ||
		draft.holder === null
	) {
		throw new TypeError("promoteDraftClaim requires a claim handle returned by acquireClaim");
	}
}

function isErrorCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}
