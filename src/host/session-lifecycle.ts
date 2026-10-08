/**
 * OMP Desk — the lifecycle action that removes a native session file.
 *
 * Exactly one such action exists, and it is deliberately the most careful one
 * this project has: **Delete Session** removes an OMP conversation's own files
 * once every proof this project accepts says no *extension* writer of it is
 * alive, and it reports honestly when only part of a removal succeeded.
 *
 * ## What is deleted, and why exactly that
 *
 * The removal mirrors installed OMP's own delete — `/session delete` and the
 * session picker both end in
 * `FileSessionStorage.deleteSessionWithArtifacts` (pi-coding-agent `src/session/session-storage.ts`,
 * `SessionManager.dropSession` in `src/session/session-manager.ts`). The target
 * is a **family**, not one file:
 *
 * - the transcript `<dir>/<stamp>_<id>.jsonl`;
 * - the *adjacent artifacts directory* `<dir>/<stamp>_<id>` (the transcript path
 *   without its `.jsonl`), recursively — OMP keeps drafts, handoff material and
 *   child-agent transcripts under it, so this is the session's own tree;
 * - **every** sibling leftover of a failed atomic rewrite that matches
 *   `<transcript basename>.*.bak`, best-effort, so a later scan cannot resurrect
 *   the deleted session from one. Some of them can appear *after* the
 *   confirmation dialog, so they are enumerated again at removal time.
 *
 * Nothing else. OMP's own delete leaves its `history.db` title/recap index rows
 * for a deleted session id in place — the recent-session listing only looks up
 * titles for transcript files it actually found, so a stale row is inert — and
 * this extension does not reach into OMP's databases to do better than OMP
 * itself does. The file-system removal is also an ordinary delete, not a secure
 * erase of the underlying storage.
 *
 * OMP stops backup cleanup when the artifacts directory fails; this extension may
 * keep attempting the remaining targets, but it must then report each actual
 * outcome rather than claim OMP's own ordering.
 *
 * ## Eligibility is not about provenance
 *
 * An indexed stopped row and a previously unindexed Folder-Resume candidate use
 * this same transaction (ADR-0027). Whether this extension created the file does
 * not decide whether its row may be deleted; the row's *own* evidence does.
 * Imported rows keep their exact-file interactive Resume, and an imported row is
 * deleted only by an explicit user action here, never as a side effect.
 *
 * ## Why a deletion is allowed at all
 *
 * A delete is irreversible, so the bar is the same one a *resume* already has to
 * clear, plus mutual exclusion:
 *
 * 1. the subject names a `.jsonl` OMP transcript that still exists;
 * 2. this window runs no native host for it and no other known extension writer
 *    (a readable claim whose holder is verified alive) holds it;
 * 3. the caller's {@link OwnerReconciler} does not name a live or attachable
 *    writer, and — for a row that recorded a launch of ours — answers `free` with
 *    at least one item of {@link OwnerAbsenceEvidence} this record supports;
 * 4. the canonical claim for the exact transcript is *taken* (adopted when it is
 *    ours, created when it is free) and **held through every removal and through
 *    finalizing the row**, so no second extension window can take the identity
 *    while its files are going away and no import can slip in between the
 *    transcript and the row cleanup;
 * 5. the exact frozen target (canonical file, header session id, profile) is
 *    revalidated **under that claim**, immediately before destructive I/O.
 *
 * ## What this cannot promise
 *
 * The claim coordinates this extension's cooperating windows and nothing else.
 * An OMP process launched outside the extension, and a user typing `/resume` (or
 * a similar command) inside a managed native terminal, can enter this file while
 * it is being deleted, and deletion during their writes can lose or corrupt
 * history. That is stated in the confirmation, not ruled out here, and no
 * extension-side check makes it safe.
 *
 * ## Partial removal is reported as partial
 *
 * The transaction's evidence — the frozen target, the operation owner and claim
 * generation, whether the transcript went away, the artifacts-directory outcome,
 * the per-backup outcomes, and the finalization status — is persisted as its own
 * durable record. A transcript whose related cleanup is incomplete is
 * a **partial deletion**: the durable transaction is retained with the exact
 * leftover category, the result does not claim success, and
 * {@link recoverNativeDeletion} can finish the verified leftovers later.
 *
 * ## What is deliberately absent: rename
 *
 * No title mutation is implemented here. Installed OMP's title writes
 * (`SessionManager.setSessionName`, reached from `/rename`, the extension API and
 * RPC `set_session_name`) take only a name: the session written to is the
 * process's mutable current session, so no caller can pin the mutation to an
 * expected session at the moment it applies — the property ADR-0009 requires for
 * a live mutation. Going through the extension's own control pipe would inherit
 * that window and, unlike a model change, would durably write into whichever
 * session's transcript the process had switched to. So the launcher shows OMP's
 * own title (read from the session file) and changes none.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { retryWindowsFileOperation } from "./file-operation-retry.ts";
import {
	ClaimOwnershipError,
	acquireClaim,
	createOwnerGeneration,
	normalizeClaimIdentity,
	readClaim,
} from "./session-claim.ts";
import type { ObservedClaim, SessionClaim } from "./session-claim.ts";
import { claimHolderMayBeAlive } from "./session-claim.ts";
import { acceptOwnerAbsenceEvidence, normalizeSessionIdentityKey, readSessionFileHeader } from "./session-index.ts";
import type {
	OwnerAbsenceEvidence,
	OwnerReconciler,
	OwnerVerdict,
	RecordedHost,
	RecordedOwnership,
	SessionIndex,
	SessionIndexEntry,
} from "./session-index.ts";
import type { TabLifecycleLease } from "./tab-lifecycle.ts";

/** OMP's extension for a session transcript. */
const SESSION_FILE_SUFFIX = ".jsonl";

/** Suffix of the atomic-rewrite leftovers OMP's own delete also cleans up. */
const BACKUP_SUFFIX = ".bak";

/** Directory the native-deletion transaction evidence is filed under. */
export const NATIVE_DELETION_EVIDENCE_DIRECTORY = "native-deletions";

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isMissing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/**
 * Why a deletion was refused. Every one of them leaves the session exactly as it
 * was: a refusal is never a partial delete, and no refusal has removed a file.
 */
export type SessionDeletionRefusalKind =
	/** The subject names no session file (a fileless draft). */
	| "draft"
	/** The recorded path is not an OMP session transcript. */
	| "unrecognized-file"
	/** The recorded transcript is already gone. */
	| "missing-file"
	/** The file's own header can no longer be read, so the frozen target is unverifiable. */
	| "unreadable-file"
	/** The file's own header no longer carries the session id and profile that were confirmed. */
	| "changed"
	/** This window runs the native host for the tab. */
	| "live-in-window"
	/** Another verified live extension-window holder owns the exact identity. */
	| "claim-held-elsewhere"
	/** The reconciler named a live writer (or one this window could reattach to). */
	| "live-elsewhere"
	/** The claim could not be taken, so removal could not be made exclusive. */
	| "claim-busy"
	/** The subject no longer points at the session file the user confirmed. */
	| "target-changed"
	/** The removal itself failed; the transcript may still be there. */
	| "delete-failed";

/**
 * The identity a deletion acts on, taken from whatever owns it: an indexed row,
 * or the exact file a Folder-Resume candidate named.
 *
 * Provenance is deliberately absent: an indexed imported row and a discovered
 * file are decided by the same facts (ADR-0027).
 */
export interface SessionDeletionSubjectFacts {
	/** Exact session file, or `null` when the subject has none. */
	readonly sessionFile: string | null;
	/** Host this extension recorded for the file, or `null` when none was recorded. */
	readonly host: RecordedHost | null;
	/** Claim record this extension holds for the file, or `null`. */
	readonly ownership: RecordedOwnership | null;
}

/** Everything the deletion policy needs; all of it is gathered, never assumed. */
export interface SessionDeletionFacts {
	readonly subject: SessionDeletionSubjectFacts;
	/** This window runs the native host for the tab (a per-window fact). */
	readonly windowHostRunning: boolean;
	/** The exact recorded session file exists on disk right now. */
	readonly fileExists: boolean;
	/** Durable claim observation for the entry's own identity. */
	readonly claim: ObservedClaim | null;
	/**
	 * Holder lease this window presents. Another live holder of the same owner
	 * generation means another window is running this session, whatever the
	 * generation says.
	 */
	readonly claimHolderId: string;
	/** Set when the claim directory could not be read; never free, only unknown. */
	readonly claimError: string | null;
	/**
	 * `true` only when `claim` is the claim *this very deletion* took and still
	 * holds (the post-acquisition re-check).
	 *
	 * It is what lets that re-check accept the operation's own claim without
	 * weakening the confirmation's preflight, where a claim this window holds for
	 * another purpose — an in-flight Resume of a discovered file, for instance —
	 * must still refuse a foreign generation.
	 */
	readonly claimIsThisDeletions?: boolean;
	readonly verdict: OwnerVerdict;
}

/** The verdict on one deletion, with the removal targets it would use. */
export interface SessionDeletionDecision {
	readonly allowed: boolean;
	/** Set exactly when `allowed` is false. */
	readonly kind: SessionDeletionRefusalKind | null;
	readonly detail: string;
	/** Absence evidence the reconciler supplied that this subject itself supports. */
	readonly evidence: readonly OwnerAbsenceEvidence[];
	/**
	 * The session's own artifacts directory, or `null` when it cannot be derived
	 * from the path — in which case only the transcript is removed.
	 */
	readonly artifactsDirectory: string | null;
}

/**
 * Decide whether one session's files may be deleted. Pure, so every refusal
 * boundary is testable without a filesystem, a registry or a claim.
 *
 * The order is deliberate: the existence of something to delete first, then this
 * window's own live host, then ownership, which is where every remaining refusal
 * lives. The holder lease is checked inside ownership because two windows of one
 * workspace share the owner generation: only the lease names the rival window.
 *
 * A subject that recorded **no host of ours** (an imported row, a discovered
 * file) is still required to have taken the canonical claim, but it is not
 * required to prove a writer of ours is gone — there is no such writer to prove
 * anything about. That is exactly the boundary ADR-0027 and ADR-0039 record: an
 * OMP process started outside this extension, or a user-typed native `/resume`,
 * is not observed and not excluded by anything here.
 */
export function decideSessionDeletion(facts: SessionDeletionFacts): SessionDeletionDecision {
	const { subject, windowHostRunning, fileExists, claim, claimHolderId, claimError, verdict } = facts;
	const heldByThisDeletion = facts.claimIsThisDeletions === true;
	const refuse = (kind: SessionDeletionRefusalKind, detail: string): SessionDeletionDecision => ({
		allowed: false,
		kind,
		detail,
		evidence: [],
		artifactsDirectory: null,
	});

	const file = subject.sessionFile;
	if (file === null) {
		return refuse(
			"draft",
			"This tab has no session file yet, so there is nothing to delete. Forget the tab to drop the row.",
		);
	}
	const layout = sessionFileLayout(file);
	if (layout === null) {
		return refuse(
			"unrecognized-file",
			`${file} is not an OMP session transcript (${SESSION_FILE_SUFFIX}), so this extension will not remove ` +
				"it or guess an adjacent artifacts directory from it.",
		);
	}
	if (!fileExists) {
		return refuse(
			"missing-file",
			`The recorded session file is already gone: ${file}. Nothing was deleted; Forget drops the row.`,
		);
	}
	if (windowHostRunning) {
		return refuse(
			"live-in-window",
			"This session is running in this window. Stop it before deleting its saved conversation.",
		);
	}
	if (!heldByThisDeletion && claim !== null && claim.holderId !== null && claim.holderId !== claimHolderId && claimHolderMayBeAlive(claim)) {
		// Two windows of one workspace share the owner generation, so this is the
		// check that actually sees the other window — before the confirmation
		// dialog, not only when the identity is taken below.
		return refuse(
			"claim-held-elsewhere",
			"This session is open in another window. Close it there before deleting; nothing was deleted.",
		);
	}
	if (verdict.kind === "live" || verdict.kind === "attachable") {
		return refuse("live-elsewhere", "This session is still running. Stop it before deleting its saved conversation.");
	}
	const evidence = verdict.kind === "free" ? verdict.evidence : [];
	return {
		allowed: true,
		kind: null,
		detail: "Close this session in any other app before deleting its saved conversation.",
		evidence,
		artifactsDirectory: layout.artifactsDirectory,
	};
}

/**
 * The two paths a session owns, derived from its transcript path the way OMP
 * itself derives them (pi-coding-agent `session-manager.ts` `artifactsDirectoryFor`, and
 * `session-storage.ts`, which simply strips the six `.jsonl` characters).
 *
 * `null` when the path is not a `.jsonl` transcript at all: refusing is the only
 * safe answer, because OMP's own derivation is a blind suffix strip and would
 * turn any other name into some other path. An artifacts directory that would
 * come out as the transcript itself or as its own parent directory (a transcript
 * literally named `.jsonl`) is reported as absent rather than removed.
 */
function sessionFileLayout(file: string): { readonly artifactsDirectory: string | null } | null {
	if (!file.toLowerCase().endsWith(SESSION_FILE_SUFFIX)) return null;
	const directory = path.resolve(path.dirname(file));
	const base = path.basename(file);
	const candidate = path.resolve(path.join(directory, base.slice(0, -SESSION_FILE_SUFFIX.length)));
	if (candidate === directory || candidate === path.resolve(file)) return { artifactsDirectory: null };
	return { artifactsDirectory: candidate };
}

async function fileExists(file: string): Promise<boolean> {
	try {
		return (await stat(file)).isFile();
	} catch {
		return false;
	}
}

async function directoryExists(directory: string): Promise<boolean> {
	try {
		return (await stat(directory)).isDirectory();
	} catch {
		return false;
	}
}

/** Absolute paths of every failed-atomic-rewrite leftover for one transcript. */
async function backupLeftovers(file: string): Promise<string[]> {
	const directory = path.dirname(file);
	const prefix = `${path.basename(file)}.`;
	const found: string[] = [];
	for (const name of await readdir(directory)) {
		if (!name.startsWith(prefix) || !name.toLowerCase().endsWith(BACKUP_SUFFIX)) continue;
		found.push(path.join(directory, name));
	}
	return found;
}

/** Whether a removal target of the session's own family was removed. */
export interface NativeDeletionTargetOutcome {
	readonly path: string;
	readonly removed: boolean;
	readonly detail: string | null;
}

/**
 * Durable evidence of one native deletion transaction.
 *
 * This record is what makes a partial removal *visible and recoverable*: it names the exact
 * frozen target, who held the deletion claim, what was actually removed, and how
 * the row was finalized.
 */
export interface NativeDeletionTransaction {
	readonly transactionId: string;
	/** Canonical exact transcript this transaction froze. */
	readonly sessionFile: string;
	readonly sessionId: string | null;
	readonly profile: string | null;
	readonly artifactsDirectory: string | null;
	readonly frozenAt: string;
	updatedAt: string;
	readonly owner: {
		readonly ownerGeneration: string;
		readonly holderId: string;
		readonly claimPath: string;
	};
	readonly transcript: NativeDeletionTargetOutcome;
	readonly artifacts: NativeDeletionTargetOutcome | null;
	readonly backups: readonly NativeDeletionTargetOutcome[];
	/** How the launcher row was finalized, when there was one. */
	readonly finalization: "none" | "row-dropped" | "row-kept" | "no-row";
	readonly status: "deleted" | "partial" | "failed";
	readonly detail: string;
}

/** The durable half of the native-deletion evidence; injectable for tests. */
export interface NativeDeletionEvidenceStore {
	read(transactionId: string): Promise<NativeDeletionTransaction | null>;
	write(transaction: NativeDeletionTransaction): Promise<void>;
	list(): Promise<readonly NativeDeletionTransaction[]>;
}

/** Default evidence store: one JSON file per transaction under `directory`. */
export function createNativeDeletionEvidenceStore(directory: string): NativeDeletionEvidenceStore {
	const root = path.resolve(directory);
	return {
		async read(transactionId: string): Promise<NativeDeletionTransaction | null> {
			const file = path.join(root, `${evidenceFileName(transactionId)}.json`);
			try {
				return parseNativeDeletionTransaction(JSON.parse(await readFile(file, "utf8")));
			} catch (error) {
				if (isMissing(error)) return null;
				if (error instanceof SyntaxError) return null;
				throw error;
			}
		},
		async write(transaction: NativeDeletionTransaction): Promise<void> {
			await mkdir(root, { recursive: true, mode: 0o700 });
			const file = path.join(root, `${evidenceFileName(transaction.transactionId)}.json`);
			const staged = `${file}.${process.pid}.${randomUUID()}.staged`;
			await writeFile(staged, `${JSON.stringify(transaction, null, "\t")}\n`, { encoding: "utf8", mode: 0o600 });
			try {
				await retryWindowsFileOperation(() => rename(staged, file));
			} finally {
				await rm(staged, { force: true }).catch(() => undefined);
			}
		},
		async list(): Promise<readonly NativeDeletionTransaction[]> {
			let names: readonly string[];
			try {
				names = await readdir(root);
			} catch (error) {
				if (isMissing(error)) return [];
				throw error;
			}
			const found: NativeDeletionTransaction[] = [];
			for (const name of names) {
				if (!name.toLowerCase().endsWith(".json")) continue;
				const transaction = await this.read(name.slice(0, -".json".length));
				if (transaction !== null) found.push(transaction);
			}
			return found;
		},
	};
}

/** File-name form of a transaction id, kept filesystem-safe and bounded. */
function evidenceFileName(transactionId: string): string {
	const safe = transactionId.replace(/[^A-Za-z0-9._-]/g, "_");
	return safe.slice(0, 120);
}

function parseNativeDeletionTransaction(value: unknown): NativeDeletionTransaction | null {
	if (typeof value !== "object" || value === null) return null;
	const record = value as Partial<NativeDeletionTransaction>;
	if (typeof record.transactionId !== "string" || record.transactionId.length === 0) return null;
	if (typeof record.sessionFile !== "string" || record.sessionFile.length === 0) return null;
	if (typeof record.frozenAt !== "string" || typeof record.updatedAt !== "string") return null;
	if (typeof record.detail !== "string") return null;
	if (record.status !== "deleted" && record.status !== "partial" && record.status !== "failed") return null;
	if (
		record.finalization !== "none" &&
		record.finalization !== "row-dropped" &&
		record.finalization !== "row-kept" &&
		record.finalization !== "no-row"
	) {
		return null;
	}
	const target = (candidate: unknown): NativeDeletionTargetOutcome | null => {
		if (typeof candidate !== "object" || candidate === null) return null;
		const outcome = candidate as Partial<NativeDeletionTargetOutcome>;
		if (typeof outcome.path !== "string" || typeof outcome.removed !== "boolean") return null;
		if (outcome.detail !== null && typeof outcome.detail !== "string") return null;
		return { path: outcome.path, removed: outcome.removed, detail: outcome.detail ?? null };
	};
	const transcript = target(record.transcript);
	if (transcript === null) return null;
	const artifacts = record.artifacts === null || record.artifacts === undefined ? null : target(record.artifacts);
	if (record.artifacts !== null && record.artifacts !== undefined && artifacts === null) return null;
	const backups: NativeDeletionTargetOutcome[] = [];
	for (const candidate of record.backups ?? []) {
		const outcome = target(candidate);
		if (outcome === null) return null;
		backups.push(outcome);
	}
	return {
		transactionId: record.transactionId,
		sessionFile: record.sessionFile,
		sessionId: record.sessionId ?? null,
		profile: record.profile ?? null,
		artifactsDirectory: record.artifactsDirectory ?? null,
		frozenAt: record.frozenAt,
		updatedAt: record.updatedAt,
		owner: {
			ownerGeneration: record.owner?.ownerGeneration ?? "",
			holderId: record.owner?.holderId ?? "",
			claimPath: record.owner?.claimPath ?? "",
		},
		transcript,
		artifacts,
		backups,
		finalization: record.finalization,
		status: record.status,
		detail: record.detail,
	};
}

/**
 * What a deletion acts on: an indexed tab, or the exact file a Folder-Resume
 * candidate named (which may have no index row at all).
 *
 * The object form may carry both: a Resume candidate that the index already
 * tracks names the exact file *and* its row, so the transaction can finalize that
 * row with its own held claim.
 */
export type SessionDeletionSubject =
	| string
	| { readonly sessionFile: string; readonly profile?: string | null; readonly tabId?: string | null };

/** The collaborators a deletion works through; every fact is re-read on each pass. */
export interface SessionDeletionOptions {
	readonly index: SessionIndex;
	readonly reconciler: OwnerReconciler;
	/** `true` when this window runs the native host (or holds the panel) for the tab. */
	windowHostRunning(tabId: string): boolean;
	/** Durable evidence store; defaults to `native-deletions/` under the claim directory. */
	readonly evidence?: NativeDeletionEvidenceStore;
}

/** One path a confirmed deletion removes, and what it is. */
export interface SessionDeletionTarget {
	readonly path: string;
	readonly kind: "transcript" | "artifacts-directory" | "rewrite-backup";
}

/** What a confirmation dialog is shown, and whether deletion may proceed. */
export interface SessionDeletionInspection {
	/** Indexed tab this inspection belongs to, or `null` for a discovered file. */
	readonly tabId: string | null;
	readonly sessionFile: string | null;
	readonly sessionId: string | null;
	readonly profile: string | null;
	readonly cwd: string | null;
	readonly allowed: boolean;
	readonly kind: SessionDeletionRefusalKind | null;
	readonly detail: string;
	readonly evidence: readonly OwnerAbsenceEvidence[];
	/** Everything the removal would delete, as observed at inspection time. */
	readonly targets: readonly SessionDeletionTarget[];
	/** Honest limits of the removal, stated where the user confirms it. */
	readonly notes: readonly string[];
}

/** The deletion the user confirmed: this exact file, frozen with its observed identity. */
export interface ConfirmedSessionDeletion {
	/** Indexed tab, when the subject was one. */
	readonly tabId?: string;
	readonly sessionFile: string;
	/** Header session id observed at confirmation; revalidated before removal. */
	readonly sessionId?: string | null;
	/** Profile observed at confirmation, when one was known. */
	readonly profile?: string | null;
}

/**
 * The deletion to confirm from one inspection.
 *
 * The frozen identity — the exact file and the header session id and profile the
 * inspection observed — is what the removal revalidates under its own claim, so a
 * file that changed while the dialog was open is refused instead of removed.
 */
export function confirmedSessionDeletion(inspection: SessionDeletionInspection): ConfirmedSessionDeletion | null {
	if (inspection.sessionFile === null) return null;
	return {
		tabId: inspection.tabId ?? undefined,
		sessionFile: inspection.sessionFile,
		sessionId: inspection.sessionId,
		profile: inspection.profile,
	};
}

/** Outcome of one deletion attempt. */
export interface SessionDeletionResult {
	/** `true` only when the transcript is gone from disk. */
	readonly deleted: boolean;
	/** `true` when the transcript is gone but related cleanup is not complete. */
	readonly partial: boolean;
	readonly kind: SessionDeletionRefusalKind | null;
	readonly detail: string;
	/** Paths this attempt removed. */
	readonly removedPaths: readonly string[];
	/** Everything that went wrong, worded for the user; empty on a clean delete. */
	readonly failures: readonly string[];
	/** `true` when the launcher row was dropped after the transcript was gone. */
	readonly rowRemoved: boolean;
	/** Durable transaction this attempt recorded, when it reached destructive I/O. */
	readonly transactionId: string | null;
	/** Leftover categories that still need recovery, empty on a clean delete. */
	readonly leftovers: readonly ("artifacts-directory" | "rewrite-backup")[];
}

/** Facts one deletion decision needs, gathered right now. */
interface GatheredDeletion {
	readonly subject: SessionDeletionSubjectFacts;
	readonly entry: SessionIndexEntry | null;
	readonly tabId: string | null;
	readonly sessionFile: string | null;
	readonly sessionId: string | null;
	readonly profile: string | null;
	readonly cwd: string | null;
	readonly decision: SessionDeletionDecision;
}

function evidenceStoreFor(options: SessionDeletionOptions): NativeDeletionEvidenceStore {
	return options.evidence ?? createNativeDeletionEvidenceStore(path.join(options.index.claimStorageDir, NATIVE_DELETION_EVIDENCE_DIRECTORY));
}

/** The tab id a subject names, or `null` when it names a file directly. */
function subjectTabId(subject: SessionDeletionSubject): string | null {
	return typeof subject === "string" ? subject : (subject.tabId ?? null);
}

/** The exact file a direct subject names, already resolved. */
function subjectFile(subject: SessionDeletionSubject): string | null {
	return typeof subject === "string" ? null : path.resolve(subject.sessionFile);
}

/**
 * Gather exact-file integrity and current ownership facts. Unknown ownership does
 * not block the deletion (the user's confirmation covers it) but is never treated
 * as proof that no writer exists. Discovered files follow the same policy.
 */
async function gatherDeletion(
	subject: SessionDeletionSubject,
	options: SessionDeletionOptions,
): Promise<
	| { readonly kind: "unknown-subject"; readonly detail: string }
	| ({ readonly kind: "inspected" } & GatheredDeletion)
> {
	const tabId = subjectTabId(subject);
	let entry: SessionIndexEntry | null = null;
	if (tabId !== null) {
		entry = options.index.get(tabId);
		if (entry === null) return { kind: "unknown-subject", detail: `No indexed tab ${tabId}.` };
	}
	const file = entry !== null ? entry.sessionFile : subjectFile(subject);
	const profile =
		entry !== null
			? (entry.scope.profile ?? null)
			: typeof subject === "string"
				? null
				: (subject.profile ?? null);
	if (file === null) {
		const decision = decideSessionDeletion({
			subject: {
				sessionFile: null,
				host: entry?.host ?? null,
				ownership: entry?.ownership ?? null,
			},
			windowHostRunning: tabId !== null && options.windowHostRunning(tabId),
			fileExists: false,
			claim: null,
			claimHolderId: options.index.claimHolder.id,
			claimError: null,
			verdict: { kind: "unknown", detail: "ownership has not been read yet" },
		});
		return {
			kind: "inspected",
			subject: {
				sessionFile: null,
				host: entry?.host ?? null,
				ownership: entry?.ownership ?? null,
			},
			entry,
			tabId,
			sessionFile: null,
			sessionId: entry?.sessionId ?? null,
			profile,
			cwd: entry?.cwd ?? null,
			decision,
		};
	}
	const truth: SessionDeletionSubjectFacts = {
		sessionFile: file,
		host: entry?.host ?? null,
		ownership: entry?.ownership ?? null,
	};
	const windowHostRunning = tabId !== null && options.windowHostRunning(tabId);
	const checkable = file.toLowerCase().endsWith(SESSION_FILE_SUFFIX);
	const exists = checkable && (await fileExists(file));
	const header = exists ? await readSessionFileHeader(file) : null;
	const provisional = decideSessionDeletion({
		subject: truth,
		windowHostRunning,
		fileExists: exists,
		claim: null,
		claimHolderId: options.index.claimHolder.id,
		claimError: null,
		verdict: { kind: "unknown", detail: "ownership has not been read yet" },
	});
	const gathered: GatheredDeletion = {
		subject: truth,
		entry,
		tabId,
		sessionFile: file,
		sessionId: header?.sessionId ?? entry?.sessionId ?? null,
		profile,
		cwd: header?.cwd ?? entry?.cwd ?? null,
		decision: provisional,
	};
	if (!provisional.allowed) return { kind: "inspected", ...gathered };
	// A file that exists but cannot be read as a session is decided before ownership:
	// nothing about who writes it changes that it is not a session transcript.
	if (exists && header === null) {
		return {
			kind: "inspected",
			...gathered,
			decision: {
				allowed: false,
				kind: "unreadable-file",
				detail: `${file} is readable but carries no OMP session header, so the deletion target cannot be verified.`,
				evidence: [],
				artifactsDirectory: null,
			},
		};
	}

	const observed =
		tabId !== null
			? await options.index.observeOwnership(tabId)
			: await readClaimQuietly(options.index.claimStorageDir, file);
	const claim = observed.ok ? observed.claim : null;
	const verdict: OwnerVerdict = observed.ok
		? await options.reconciler
				.reconcile({
					entry: entry ?? syntheticEntry(truth, file, header?.cwd ?? null, profile),
					sessionFile: file,
					draftIdentity: entry?.ownership?.draftIdentity ?? null,
					ownerGeneration: entry?.ownership?.ownerGeneration ?? "",
					claim,
					host: entry?.host ?? null,
				})
				.catch((error: unknown): OwnerVerdict => ({
					kind: "unknown",
					detail: `Ownership reconciliation failed: ${describeError(error)}`,
				}))
		: { kind: "unknown", detail: observed.detail };
	return {
		kind: "inspected",
		...gathered,
		decision: decideSessionDeletion({
			subject: truth,
			windowHostRunning,
			fileExists: exists,
			claim,
			claimHolderId: options.index.claimHolder.id,
			claimError: observed.ok ? null : observed.detail,
			verdict,
		}),
	};
}

/** Read a file's claim under the index's own claim directory, or report why not. */
async function readClaimQuietly(
	storageDir: string,
	file: string,
): Promise<{ ok: true; claim: ObservedClaim | null } | { ok: false; detail: string }> {
	try {
		return { ok: true, claim: await readClaim(storageDir, file) };
	} catch (error) {
		return {
			ok: false,
			detail: "This session's connection details could not be read. Refresh Sessions and try again.",
		};
	}
}

/**
 * A minimal index-entry shape for reconciling a discovered file.
 *
 * The reconciler is asked about *this extension's* recorded writer, and a
 * discovered file has none: `host` and `ownership` are `null`, which is exactly
 * what makes the reconciler answer `free` with `no-recorded-host` and what makes
 * {@link decideSessionDeletion} not demand absence evidence for it.
 */
function syntheticEntry(
	subject: SessionDeletionSubjectFacts,
	file: string,
	cwd: string | null,
	profile: string | null,
): SessionIndexEntry {
	return {
		tabId: "",
		kind: "session",
		origin: "imported",
		sessionFile: file,
		sessionId: null,
		cwd: cwd ?? "",
		scope: { profile, sessionDir: null },
		sessionDir: path.dirname(file),
		ownership: subject.ownership,
		host: subject.host,
		createdAt: new Date(0).toISOString(),
		lastActiveAt: new Date(0).toISOString(),
		ordinal: 0,
		availability: "saved",
		detail: null,
		runIntent: "stopped",
		title: null,
		lastCompletedReplyId: null,
		lastSeenReplyId: null,
	};
}

/** Everything one confirmed removal would delete, as it stands now. */
async function deletionTargets(
	file: string,
	decision: SessionDeletionDecision,
): Promise<SessionDeletionTarget[]> {
	const targets: SessionDeletionTarget[] = [{ path: file, kind: "transcript" }];
	const artifacts = decision.artifactsDirectory;
	if (artifacts !== null && (await directoryExists(artifacts))) {
		targets.push({ path: artifacts, kind: "artifacts-directory" });
	}
	try {
		for (const backup of await backupLeftovers(file)) targets.push({ path: backup, kind: "rewrite-backup" });
	} catch {
		// A directory that cannot be listed is not a reason to fail an inspection:
		// the transcript and the artifacts directory are named.
	}
	return targets;
}

/**
 * Inspect one deletion without changing anything.
 *
 * This is the pass behind the confirmation dialog: it gathers the same facts the
 * deletion will gather and names every path that would be removed. Its verdict is
 * *not* permission — the deletion re-reads everything under its own claim, because
 * a host can start, a claim can be taken and a file can change while a modal is
 * open.
 */
export async function inspectSessionDeletion(
	subject: SessionDeletionSubject,
	options: SessionDeletionOptions,
): Promise<SessionDeletionInspection | null> {
	const gathered = await gatherDeletion(subject, options);
	if (gathered.kind === "unknown-subject") return null;
	const file = gathered.sessionFile;
	return {
		tabId: gathered.tabId,
		sessionFile: file,
		sessionId: gathered.sessionId,
		profile: gathered.profile,
		cwd: gathered.cwd,
		allowed: gathered.decision.allowed,
		kind: gathered.decision.kind,
		detail: gathered.decision.detail,
		evidence: gathered.decision.evidence,
		// A refused inspection names no path: nothing would be removed, so nothing
		// may be presented as a removal target.
		targets: gathered.decision.allowed && file !== null ? await deletionTargets(file, gathered.decision) : [],
		notes: deletionNotes(file, gathered.decision.evidence),
	};
}

/** The honest limits of this removal, stated where the user confirms it. */
function deletionNotes(
	file: string | null,
	evidence: readonly OwnerAbsenceEvidence[] = [],
): readonly string[] {
	const artifacts = file === null ? null : sessionFileLayout(file)?.artifactsDirectory ?? null;
	return [
		`This removes the transcript${artifacts === null ? "" : `, the artifacts directory ${artifacts} and everything inside it recursively`} ` +
			`and every leftover backup matching \`${file === null ? "<transcript>" : path.basename(file)}.*.bak\`.`,
		"An OMP process started outside this extension, and a /resume (or similar) command typed in a managed native terminal, " +
			"can enter this file while it is being deleted. Deleting during their writes can lose or corrupt history; this " +
			"extension cannot exclude them.",
		"The removal is an ordinary file-system delete, not a secure erase of the underlying storage.",
		"OMP's own title and recap index rows for this session id are left in place, exactly as OMP's own delete leaves them; " +
			"they are inert without the transcript.",
		"Backups can appear after this dialog. Every one found at removal time is removed and reported; a removal that leaves any " +
			"of them behind is reported as a partial deletion.",
	];
}

interface SessionFileRemoval {
	readonly transcript: NativeDeletionTargetOutcome;
	readonly artifacts: NativeDeletionTargetOutcome | null;
	readonly backups: readonly NativeDeletionTargetOutcome[];
	readonly failures: readonly string[];
	readonly leftovers: readonly ("artifacts-directory" | "rewrite-backup")[];
}

/**
 * Remove one session's files: the transcript, then its artifacts directory, then
 * every leftover of a failed atomic rewrite.
 *
 * Once the transcript is gone the rest is cleanup, so a failure there is
 * reported instead of hidden — the caller must be able to say that a session was
 * deleted while something of it remained. A transcript this call cannot remove
 * stops the pass before the artifacts directory is touched, so a session that
 * still exists is not left half-removed.
 */
async function removeSessionFiles(file: string, artifactsDirectory: string | null): Promise<SessionFileRemoval> {
	const failures: string[] = [];
	const leftovers: ("artifacts-directory" | "rewrite-backup")[] = [];
	let transcript: NativeDeletionTargetOutcome;
	try {
		await unlink(file);
		transcript = { path: file, removed: true, detail: null };
	} catch (error) {
		if (isMissing(error)) {
			// Already gone: OMP's own delete treats ENOENT as success.
			transcript = { path: file, removed: true, detail: "It was already gone when the removal ran." };
		} else {
			const detail = `The transcript ${file} could not be removed: ${describeError(error)}`;
			failures.push(detail);
			return { transcript: { path: file, removed: false, detail }, artifacts: null, backups: [], failures, leftovers };
		}
	}

	let artifacts: NativeDeletionTargetOutcome | null = null;
	if (artifactsDirectory !== null && (await directoryExists(artifactsDirectory))) {
		try {
			await rm(artifactsDirectory, { recursive: true, force: true });
			artifacts = { path: artifactsDirectory, removed: true, detail: null };
		} catch (error) {
			const detail = `The session file was deleted, but its artifacts directory ${artifactsDirectory} could not be removed: ${describeError(error)}`;
			failures.push(detail);
			leftovers.push("artifacts-directory");
			artifacts = { path: artifactsDirectory, removed: false, detail };
		}
	}

	const backups: NativeDeletionTargetOutcome[] = [];
	try {
		for (const backup of await backupLeftovers(file)) {
			try {
				await unlink(backup);
				backups.push({ path: backup, removed: true, detail: null });
			} catch (error) {
				// Best-effort, as in OMP: a locked leftover must not fail a delete the
				// user asked for, but it is still reported.
				const detail = `A leftover rewrite backup ${backup} could not be removed: ${describeError(error)}`;
				failures.push(detail);
				leftovers.push("rewrite-backup");
				backups.push({ path: backup, removed: false, detail });
			}
		}
	} catch (error) {
		const detail = `Leftover rewrite backups of ${file} could not be listed: ${describeError(error)}`;
		failures.push(detail);
		leftovers.push("rewrite-backup");
	}
	return { transcript, artifacts, backups, failures, leftovers };
}

/**
 * Delete one confirmed session's files and finalize its launcher row.
 *
 * The caller has confirmed this exact transcript path; nothing else is ever
 * removed, and a subject that now points at a different transcript is refused
 * rather than deleted (`target-changed`). Every fact is re-gathered **under the
 * taken claim**, because the confirmation dialog can stay open while a host
 * starts or a claim is taken, and the claim is held through the removals *and*
 * through finalizing the row, so no other window can adopt the identity or
 * import the file in between. It is released only after the result is recorded.
 *
 * The whole transaction runs with the file's own lifecycle held, and with the
 * tab's gate too when the subject is an indexed tab — a restore of the same tab
 * adopts a claim held by this window's own holder, so the durable claim alone
 * would not exclude *this* window. `lease` is the caller's own tab lease when it
 * already holds one (the extension's delete command holds it across the deletion
 * and the tab-state cleanup that follows), and `undefined` for a caller that must
 * take it here.
 */
export async function deleteManagedSession(
	confirmed: ConfirmedSessionDeletion,
	options: SessionDeletionOptions,
	lease?: TabLifecycleLease,
): Promise<SessionDeletionResult> {
	const tabId = confirmed.tabId ?? null;
	return await options.index.withinFileLifecycle(confirmed.sessionFile, async () => {
		if (tabId === null) {
			return await deleteManagedSessionHeld(confirmed, options, null);
		}
		return await options.index.withinTabLifecycle(tabId, lease, async held =>
			await deleteManagedSessionHeld(confirmed, options, held),
		);
	});
}

/** One native deletion's body; the caller already holds the file's lifecycle. */
async function deleteManagedSessionHeld(
	confirmed: ConfirmedSessionDeletion,
	options: SessionDeletionOptions,
	lease: TabLifecycleLease | null,
): Promise<SessionDeletionResult> {
	const refuse = (kind: SessionDeletionRefusalKind, detail: string): SessionDeletionResult => ({
		deleted: false,
		partial: false,
		kind,
		detail,
		removedPaths: [],
		failures: [],
		rowRemoved: false,
		transactionId: null,
		leftovers: [],
	});

	const gathered = await gatherDeletion(confirmed.tabId ?? { sessionFile: confirmed.sessionFile }, options);
	if (gathered.kind === "unknown-subject") {
		return refuse("target-changed", "This session is no longer in Sessions; nothing was deleted.");
	}
	const file = gathered.sessionFile;
	if (file === null || normalizeSessionIdentityKey(file) !== normalizeSessionIdentityKey(confirmed.sessionFile)) {
		return refuse(
			"target-changed",
			`The subject no longer points at the session file that was confirmed (${confirmed.sessionFile}); nothing was deleted.`,
		);
	}
	if (!gathered.decision.allowed) return refuse(gathered.decision.kind ?? "delete-failed", gathered.decision.detail);

	// Take the identity before touching a file: while this window holds it, no
	// other window can claim the same session, resume it, or start a writer for it.
	// A subject that never recorded a generation (a hand-edited or migrated row, or
	// a discovered file) gets a fresh one.
	const frozenGeneration = gathered.entry?.ownership?.ownerGeneration ?? createOwnerGeneration();
	let claim: SessionClaim;
	try {
		claim = await acquireClaim(options.index.claimStorageDir, file, frozenGeneration, options.index.claimHolder);
	} catch (error) {
		return refuse(
			"claim-busy",
			`The session's identity could not be taken for the deletion (${describeError(error)}); nothing was deleted.`,
		);
	}

	let removal: SessionFileRemoval;
	let rowRemoved = false;
	let finalization: NativeDeletionTransaction["finalization"] = gathered.tabId === null ? "no-row" : "none";
	try {
		// Revalidate the frozen target under the ownership that now excludes every
		// cooperating extension writer: the file must still be the same session.
		const revalidated = await revalidateFrozenTarget(confirmed, gathered, options);
		if (typeof revalidated === "string") {
			await releaseClaimQuietly(claim);
			return refuse("changed", revalidated);
		}
		removal = await removeSessionFiles(file, gathered.decision.artifactsDirectory);
	} catch (error) {
		await releaseClaimQuietly(claim);
		return refuse("delete-failed", `The session files could not be removed: ${describeError(error)}`);
	}

	const failures = [...removal.failures];
	let transaction = buildTransaction(confirmed, gathered, claim, removal, finalization, failures);
	await writeTransaction(transaction, options);

	// The row is finalized while the deletion still holds the exact claim; the
	// claim is released only after the result is recorded.
	if (removal.transcript.removed && !(await fileExists(file))) {
		if (gathered.tabId !== null) {
			const dropped = await options.index.dropDeletedSession(
				gathered.tabId,
				{
					sessionFile: file,
					detail: "The saved conversation was deleted and its row was removed from Sessions.",
					heldClaim: claim,
				},
				lease ?? undefined,
			);
			rowRemoved = dropped.removed;
			finalization = dropped.removed ? "row-dropped" : "row-kept";
			if (!dropped.removed) failures.push(`The row remains in Sessions: ${dropped.detail}`);
		}
		transaction = { ...transaction, finalization, detail: summarizeDeletion(removal, failures) };
		await writeTransaction(transaction, options);
	}

	if (!removal.transcript.removed) {
		await releaseClaimQuietly(claim);
		const detail = [`The session file ${file} is still on disk; nothing else was removed.`, ...failures].join(" ");
		const failed: NativeDeletionTransaction = {
			...transaction,
			status: "failed",
			finalization,
			detail,
		};
		await writeTransaction(failed, options);
		return {
			deleted: false,
			partial: false,
			kind: "delete-failed",
			detail,
			removedPaths: [],
			failures,
			rowRemoved,
			transactionId: failed.transactionId,
			leftovers: removal.leftovers,
		};
	}

	await releaseClaimQuietly(claim);
	const partial = removal.leftovers.length > 0;
	const detail = summarizeDeletion(removal, failures);
	const finalTransaction: NativeDeletionTransaction = { ...transaction, status: partial ? "partial" : "deleted", finalization, detail };
	await writeTransaction(finalTransaction, options);
	const removedPaths: string[] = [];
	if (removal.transcript.removed) removedPaths.push(file);
	if (removal.artifacts?.removed === true) removedPaths.push(removal.artifacts.path);
	for (const backup of removal.backups) if (backup.removed) removedPaths.push(backup.path);
	return {
		deleted: true,
		partial,
		kind: null,
		detail,
		removedPaths,
		failures,
		rowRemoved,
		transactionId: finalTransaction.transactionId,
		leftovers: removal.leftovers,
	};
}

/**
 * Re-check the frozen target under the deletion's own claim.
 *
 * Two things must still hold before any file is touched. The confirmed header
 * identity and profile must still describe this exact file, and the live-target
 * verdict must still refuse a writer: the confirmation's preflight decided before
 * the identity was taken, so a host that appeared in between — or a released
 * unidentified attempt whose session started publishing again — would otherwise be
 * removed under an authorization that no longer describes the row. That second
 * check is the same reconciler, re-applied to the fresh verdict exactly as
 * {@link decideSessionDeletion} applies it to the preflight one, because a
 * *fresher* observation is never a weaker one.
 */
async function revalidateFrozenTarget(
	confirmed: ConfirmedSessionDeletion,
	gathered: GatheredDeletion,
	options: SessionDeletionOptions,
): Promise<string | null> {
	if (!(await fileExists(confirmed.sessionFile))) {
		return `${confirmed.sessionFile} is gone already; nothing was deleted.`;
	}
	const header = await readSessionFileHeader(confirmed.sessionFile);
	if (header === null) {
		return `${confirmed.sessionFile} no longer carries a readable OMP session header; nothing was deleted.`;
	}
	if (confirmed.sessionId != null && header.sessionId !== confirmed.sessionId) {
		return `${confirmed.sessionFile} now reports session ${header.sessionId}, not the confirmed ${confirmed.sessionId}; nothing was deleted.`;
	}
	if (confirmed.profile !== undefined && confirmed.profile !== null && gathered.profile !== confirmed.profile) {
		return `${confirmed.sessionFile} is no longer offered under profile ${confirmed.profile}; nothing was deleted.`;
	}
	// Re-check positive ownership after confirmation. A missing, stale or unreadable
	// claim is not a veto; a newly verified live rival is.
	const observed = await options.index.observeOwnershipOfFile(confirmed.sessionFile);
	const held = observed.ok ? observed.claim : null;
	if (held !== null && held.holderId !== options.index.claimHolder.id && claimHolderMayBeAlive(held)) {
		return "Another verified live extension window now holds this session; nothing was deleted.";
	}
	const heldGeneration = held?.ownerGeneration ?? gathered.entry?.ownership?.ownerGeneration ?? "";
	const verdict: OwnerVerdict = await options.reconciler
		.reconcile({
			entry:
				gathered.entry ?? syntheticEntry(gathered.subject, confirmed.sessionFile, header.cwd ?? gathered.cwd, gathered.profile),
			sessionFile: confirmed.sessionFile,
			draftIdentity: gathered.entry?.ownership?.draftIdentity ?? null,
			ownerGeneration: heldGeneration,
			claim: held,
			host: gathered.entry?.host ?? null,
		})
		.catch((error: unknown): OwnerVerdict => ({
			kind: "unknown",
			detail: `Ownership reconciliation failed: ${describeError(error)}`,
		}));
	const fresh = decideSessionDeletion({
		subject: gathered.subject,
		windowHostRunning: gathered.tabId !== null && options.windowHostRunning(gathered.tabId),
		fileExists: true,
		claim: held,
		claimHolderId: options.index.claimHolder.id,
		claimError: null,
		claimIsThisDeletions: true,
		verdict,
	});
	if (!fresh.allowed) return `${fresh.detail} Nothing was deleted.`;
	return null;
}

async function releaseClaimQuietly(claim: SessionClaim): Promise<string | null> {
	try {
		await claim.release();
		return null;
	} catch (error) {
		// A claim this owner no longer holds was reconciled away elsewhere; the
		// identity is free either way. Anything else is reported.
		if (error instanceof ClaimOwnershipError) return null;
		return `The claim for ${claim.claimPath} could not be released: ${describeError(error)}`;
	}
}

function buildTransaction(
	confirmed: ConfirmedSessionDeletion,
	gathered: GatheredDeletion,
	claim: SessionClaim,
	removal: SessionFileRemoval,
	finalization: NativeDeletionTransaction["finalization"],
	failures: readonly string[],
): NativeDeletionTransaction {
	const now = new Date().toISOString();
	return {
		transactionId: `native-delete:${normalizeClaimIdentity(confirmed.sessionFile).replace(/[^A-Za-z0-9._-]/g, "_").slice(-60)}:${randomUUID()}`,
		sessionFile: confirmed.sessionFile,
		sessionId: gathered.sessionId,
		profile: gathered.profile,
		artifactsDirectory: gathered.decision.artifactsDirectory,
		frozenAt: now,
		updatedAt: now,
		owner: {
			ownerGeneration: claim.ownerGeneration,
			holderId: claim.holder.id,
			claimPath: claim.claimPath,
		},
		transcript: removal.transcript,
		artifacts: removal.artifacts,
		backups: [...removal.backups],
		finalization,
		status: removal.transcript.removed ? (removal.leftovers.length > 0 ? "partial" : "deleted") : "failed",
		detail: summarizeDeletion(removal, failures),
	};
}

async function writeTransaction(transaction: NativeDeletionTransaction, options: SessionDeletionOptions): Promise<void> {
	try {
		await evidenceStoreFor(options).write({
			...transaction,
			updatedAt: new Date().toISOString(),
		});
	} catch {
		// The removal already happened; failing to record its evidence must not turn a
		// completed delete into an error.
	}
}

function summarizeDeletion(removal: SessionFileRemoval, failures: readonly string[]): string {
	const removed: string[] = [];
	if (removal.transcript.removed) removed.push(`the OMP session transcript ${removal.transcript.path}`);
	if (removal.artifacts?.removed === true) removed.push(`its artifacts directory ${removal.artifacts.path}`);
	const backupsRemoved = removal.backups.filter(backup => backup.removed).length;
	if (backupsRemoved > 0) removed.push(`${backupsRemoved} leftover rewrite backup${backupsRemoved === 1 ? "" : "s"}`);
	const list = removed.length === 0 ? "nothing" : removed.length === 1 ? removed[0]! : `${removed.slice(0, -1).join(", ")} and ${removed.at(-1)}`;
	const base = `Deleted ${list}.`;
	if (removal.leftovers.length === 0) return [base, ...failures].join(" ");
	const leftoverText = removal.leftovers
		.map(kind => (kind === "artifacts-directory" ? "the artifacts directory" : "one or more rewrite backups"))
		.join(" and ");
	return [`${base} This is a partial deletion: ${leftoverText} could not be removed and the transaction was kept.`, ...failures].join(" ");
}

/** The durable native-deletion transactions, newest first. */
export async function listNativeDeletionTransactions(
	options: SessionDeletionOptions,
): Promise<readonly NativeDeletionTransaction[]> {
	const all = await evidenceStoreFor(options).list();
	return [...all].sort((left, right) => (left.frozenAt < right.frozenAt ? 1 : left.frozenAt > right.frozenAt ? -1 : 0));
}

/**
 * Finish the verified leftovers of a partial deletion.
 *
 * Only a transaction whose transcript is already gone can be recovered: anything
 * that still has a transcript is a normal deletion and must go through its own
 * confirmation. Everything is re-checked first (the frozen target, this window's
 * own host, and the claim), because a leftover may have been recreated, replaced
 * or claimed since the transaction was recorded.
 */
export async function recoverNativeDeletion(
	transactionId: string,
	options: SessionDeletionOptions,
): Promise<SessionDeletionResult> {
	const refuse = (kind: SessionDeletionRefusalKind, detail: string): SessionDeletionResult => ({
		deleted: false,
		partial: false,
		kind,
		detail,
		removedPaths: [],
		failures: [],
		rowRemoved: false,
		transactionId,
		leftovers: [],
	});
	const store = evidenceStoreFor(options);
	const transaction = await store.read(transactionId);
	if (transaction === null) return refuse("target-changed", `No native-deletion transaction ${transactionId} is recorded.`);
	if (transaction.transcript.removed !== true || (await fileExists(transaction.sessionFile))) {
		return refuse(
			"changed",
			`${transaction.sessionFile} still exists, so this is a normal deletion and not a recovery.`,
		);
	}
	if (transaction.finalization === "none" || transaction.finalization === "row-kept") {
		return refuse(
			"changed",
			"The launcher row of this transaction was never finalized; reconcile the row before recovering its leftovers.",
		);
	}
	return await options.index.withinFileLifecycle(transaction.sessionFile, async () => {
		let claim: SessionClaim;
		try {
			claim = await acquireClaim(
				options.index.claimStorageDir,
				transaction.sessionFile,
				createOwnerGeneration(),
				options.index.claimHolder,
			);
		} catch (error) {
			return refuse(
				"claim-busy",
				`The session's identity could not be taken for the recovery (${describeError(error)}); nothing was removed.`,
			);
		}
		const removedPaths: string[] = [];
		const failures: string[] = [];
		const leftovers: ("artifacts-directory" | "rewrite-backup")[] = [];
		const artifacts = transaction.artifacts;
		if (artifacts !== null && artifacts.removed === false) {
			if (await directoryExists(artifacts.path)) {
				try {
					await rm(artifacts.path, { recursive: true, force: true });
					removedPaths.push(artifacts.path);
				} catch (error) {
					failures.push(`The artifacts directory ${artifacts.path} could not be removed: ${describeError(error)}`);
					leftovers.push("artifacts-directory");
				}
			}
		}
		for (const backup of transaction.backups) {
			if (backup.removed) continue;
			if (!(await fileExists(backup.path))) continue;
			try {
				await unlink(backup.path);
				removedPaths.push(backup.path);
			} catch (error) {
				failures.push(`The rewrite backup ${backup.path} could not be removed: ${describeError(error)}`);
				leftovers.push("rewrite-backup");
			}
		}
		// A backup can have appeared since the transaction was written.
		try {
			for (const leftover of await backupLeftovers(transaction.sessionFile)) {
				try {
					await unlink(leftover);
					removedPaths.push(leftover);
				} catch (error) {
					failures.push(`A rewrite backup ${leftover} could not be removed: ${describeError(error)}`);
					leftovers.push("rewrite-backup");
				}
			}
		} catch (error) {
			failures.push(`Leftover rewrite backups of ${transaction.sessionFile} could not be listed: ${describeError(error)}`);
			leftovers.push("rewrite-backup");
		}
		await releaseClaimQuietly(claim);
		const recovered: NativeDeletionTransaction = {
			...transaction,
			updatedAt: new Date().toISOString(),
			status: leftovers.length === 0 ? "deleted" : "partial",
			detail:
				leftovers.length === 0
					? "The recorded leftovers of this partial deletion were removed."
					: `This deletion is still partial: ${leftovers.join(" and ")} remain.`,
		};
		await store.write(recovered);
		return {
			deleted: true,
			partial: leftovers.length > 0,
			kind: null,
			detail: recovered.detail,
			removedPaths,
			failures,
			rowRemoved: true,
			transactionId,
			leftovers,
		};
	});
}
