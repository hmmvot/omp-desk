/**
 * Profile-wide exact-file session index and per-tab lifecycle gate.
 *
 * ADR-0039: ownership is positive evidence, not the inability to prove absence.
 * User actions refuse only this window's driven runtime, an authenticated live
 * broker child, or another verified live extension-window claim holder. Unknown
 * ownership is an ordinary draft/saved row. Activation still requires recorded
 * absence evidence before an automatic relaunch; stopped intent never auto-starts.
 *
 * Editor slots keep their immutable identity and one controlling editor per
 * conversation. An unowned draft/stopped editor may control its local surface;
 * a verified rival holder cannot be demoted. External writers are the user's risk.
 */

import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { stat } from "node:fs/promises";
import { synchronousLocalPaths } from "./private-storage.ts";
import * as path from "node:path";
import type { Logger } from "../shared/logger.ts";
import { FILE_OPERATION_BACKOFF_MS, retryFileOperation } from "./atomic-file.ts";
import { IdentityTurns, RESTORE_CONCURRENCY, RestoreStepTimer, mapBounded } from "./session-restore-trace.ts";
import type { IdentityTurn, OmpHostStepTimings, StepSink } from "./session-restore-trace.ts";
import {
	ClaimConflictError,
	ClaimHolderError,
	ClaimOwnershipError,
	acquireClaim,
	claimHolderMayBeAlive,
	claimHolderProvablyGone,
	claimPathFor,
	createClaimHolder,
	createDraftIdentity,
	createOwnerGeneration,
	normalizeClaimIdentity,
	promoteDraftClaim,
	listClaims,
	readClaim,
	removeClaimOfGoneHolder,
} from "./session-claim.ts";
import type { ClaimHolder, ObservedClaim, SessionClaim } from "./session-claim.ts";
import { acceptOwnerAbsenceEvidence, classifySessionAvailability } from "./session-availability.ts";
import type {
	AttachPin,
	DeferredReconcileOptions,
	DeferredReconciliation,
	DeferredReconcileReport,
	KilledHostCapture,
	KilledHostReconcileResult,
	OwnerReconciler,
	OwnerVerdict,
	StopRecordedHostOptions,
	StopRecordedHostResult,
} from "./session-availability.ts";
import {
	isAbsoluteWorkspaceDirectory,
	normalizeSessionIdentityKey,
	normalizeWorkspaceDirectory,
	readSessionFileHeader,
} from "./session-files.ts";
import { IMPORTED_SESSION_DETAIL, isRecordedRpcIdentity, resolveSessionOrigin } from "./session-model.ts";
import type {
	EditorSlotBinding,
	EditorSlotRole,
	NativeHostTransferOutcome,
	OmpHostHandle,
	OmpLaunchScope,
	RecordedHost,
	RecordedOwnership,
	RecordedRpcIdentity,
	RunIntent,
	SessionAvailability,
	SessionImportConflict,
	SessionIndexEntry,
	SessionOrigin,
	SessionViewMode,
} from "./session-model.ts";
import { TabLifecycle } from "./tab-lifecycle.ts";
import type { TabLifecycleLease } from "./tab-lifecycle.ts";
import { compareReplyMarkers, laterReplyMarker } from "./session-unread.ts";
import { mergeKeyedArray, sameRecord } from "./catalog-merge.ts";
import type { RecordConflictDraft } from "./catalog-merge.ts";
import { isCatalogBusy } from "./profile-catalog.ts";
import type { CatalogRecordChange } from "./profile-catalog.ts";
import { PersistRetry } from "./persist-retry.ts";
import type { PersistRetryOptions } from "./persist-retry.ts";
import { windowUriIdentity } from "./window-requests.ts";

/** Contention for the catalog lock this long is not another window's write: a lock nobody releases. */
export const PERSIST_BUSY_ESCALATE_MS = 120_000;

/**
 * Memento key holding the shared index record.
 *
 * It is the catalog key: one record every window of the extension profile reads
 * and writes under a transaction (see `src/host/profile-catalog.ts`). The name is
 * unchanged so a value written by an earlier build is still readable, both by the
 * legacy importer and by this index.
 */
export const SESSION_INDEX_STORAGE_KEY = "omp.sessionIndex.v1";

/**
 * Memento key holding this window's own observations for the shared rows.
 *
 * Deliberately a different key from {@link SESSION_INDEX_STORAGE_KEY}: the legacy
 * importer reads the old key as a source of pre-upgrade state, and this window's
 * observations must never be mistaken for one — nor may a legacy source's
 * observations be resurrected into the shared record.
 */
export const SESSION_INDEX_LOCAL_KEY = "omp.sessionIndex.local.v1";

/** Persisted snapshot schema version; a mismatch discards the snapshot. */
const INDEX_VERSION = 1;

/** Schema version of this window's own observations; a mismatch drops them. */
const LOCAL_VERSION = 1;

// Persistence surface

/**
 * The subset of `vscode.Memento` this index uses for its durable records.
 *
 * Pass the profile catalog (`src/host/profile-catalog.ts`) as `store`: the row
 * facts are shared by every window, while the claims the index coordinates live in
 * a directory every window shares as well. Pass `context.workspaceState` as
 * {@link SessionIndexOptions.localStore}, which is where this window's own
 * observations belong.
 *
 * `update` returns an unspecified value on purpose. VS Code's `Memento.update`
 * returns its own `Thenable`, which is deliberately not structurally a `Promise`,
 * so no bespoke awaitable interface can be satisfied by both a `Memento` and a
 * test double. The index awaits the result through `Promise.resolve`, which
 * adopts any thenable and tolerates a synchronous write.
 */
export interface SessionIndexStore {
	get<T>(key: string): T | undefined;
	update(key: string, value: unknown, base?: unknown): unknown;
	transactRecords?(changes: readonly CatalogRecordChange[]): Promise<void>;
	/** Re-read the committed record; the profile catalog does, a plain memento has nothing to re-read. */
	refresh?(): Promise<unknown>;
}

// Catalog rows

/** Internal mutable mirror of {@link SessionIndexEntry}. */
interface MutableEntry {
	tabId: string;
	origin: SessionOrigin;
	sessionFile: string | null;
	sessionId: string | null;
	cwd: string;
	scope: OmpLaunchScope;
	sessionDir: string | null;
	ownership: RecordedOwnership | null;
	host: RecordedHost | null;
	createdAt: string;
	lastActiveAt: string;
	ordinal: number;
	availability: SessionAvailability;
	detail: string | null;
	runIntent: RunIntent;
	title: string | null;
	lastCompletedReplyId: string | null;
	lastSeenReplyId: string | null;
	/** Window URI of the window that last became this row's driver, `null` for none (ADR-0080, amendment of 2026-10-21). */
	home: string | null;
	importConflict?: SessionImportConflict | null;
}

/**
 * The part of a row every window shares, as it is committed to the profile
 * catalog.
 *
 * Everything except this window's own observations
 * ({@link MutableEntry.availability}, {@link MutableEntry.detail}) and the tab this
 * window had selected. The reply identities of the unread marker are shared: a session
 * read in one window is read in every other, and in this one after it opens another folder.
 */
type SharedEntry = Omit<MutableEntry, "availability" | "detail">;

/** This window's own observation of one shared row. */
interface LocalObservation {
	readonly availability: SessionAvailability;
	readonly detail: string | null;
}

/** One record key's value in the profile catalog: the shared rows. */
interface SharedSnapshot {
	version: number;
	nextOrdinal: number;
	entries: SharedEntry[];
	/**
	 * Durable editor-slot bindings (ADR-0025). Optional on disk: a snapshot
	 * written before slots existed simply has none, and is read as such rather
	 * than discarded.
	 */
	bindings?: EditorSlotBinding[];
}

/** This window's own observations, kept beside the shared rows. */
interface LocalSnapshot {
	version: number;
	activeTabId: string | null;
	observations: Record<string, LocalObservation>;
}

// Caller-provided launch integration

/** Everything the launch integration needs; never carries a secret. */
export interface OmpHostLaunchRequest {
	readonly tabId: string;
	/** Exact session file to resume, or `null` to start a fresh session (draft tab). */
	readonly sessionFile: string | null;
	readonly sessionId: string | null;
	/** Normalized working directory for the native host. */
	readonly cwd: string;
	readonly scope: OmpLaunchScope;
	readonly transport?: "rpc" | "native";
	/** Claim owner generation this launch runs under. */
	readonly ownerGeneration: string;
	/** Claim file held for this session; diagnostics only. */
	readonly claimPath: string;
}

/**
 * Outcome of one launch attempt.
 *
 * `unconfirmed` is the honest answer when the integration cannot tell whether a
 * process exists (a timeout, a crashed terminal, an unexpected throw): the index
 * keeps the claim and reports a conflict instead of freeing an identity that may
 * still have a writer.
 */
export type OmpHostLaunchResult =
	| { readonly state: "running"; readonly host: OmpHostHandle; readonly timings?: OmpHostStepTimings }
	| { readonly state: "not-started"; readonly reason: string }
	| { readonly state: "unconfirmed"; readonly reason: string };

/**
 * Reattach to an already-running native host.
 *
 * Same information as {@link OmpHostLaunchRequest} plus the exact host this
 * index recorded, so the integration can confirm it is reconnecting to that
 * process — never starting one. An attach MUST NOT spawn, resume, or take a new
 * claim: it only re-establishes the GUI's connection to a live writer.
 */
export interface OmpHostAttachRequest extends OmpHostLaunchRequest {
	/** The host this index recorded for the tab, which the attach must target. */
	readonly recordedHost: RecordedHost;
	/**
	 * The transport the reconciler proved for that host.
	 *
	 * The attach must re-prove this exact target rather than resolve a transport of
	 * its own; it is never a licence to start a process.
	 */
	readonly pin: AttachPin;
}

/** Outcome of one attach attempt. */
export type OmpHostAttachResult =
	| { readonly state: "attached"; readonly host: OmpHostHandle; readonly timings?: OmpHostStepTimings }
	/** The host could not be confirmed or reached; release the operation lease and recheck ownership. */
	| { readonly state: "unavailable"; readonly reason: string; readonly timings?: OmpHostStepTimings };

/** Launches or reattaches the native OMP host; implemented by the caller's terminal integration. */
export interface OmpHostLauncher {
	launch(request: OmpHostLaunchRequest): Promise<OmpHostLaunchResult>;
	attach(request: OmpHostAttachRequest): Promise<OmpHostAttachResult>;
}

// Reports

/** A tab that now owns a running native host. */
export interface RestoredSession {
	readonly tabId: string;
	readonly sessionFile: string | null;
	readonly host: OmpHostHandle;
}

/**
 * A tab that was reconnected to an already-running host instead of starting one:
 * either this window never let it go, or the reconciler named the exact host
 * this index recorded and the launcher reattached to it.
 */
export interface AttachedSession {
	readonly tabId: string;
	readonly sessionFile: string | null;
	readonly detail: string;
}

export type SessionConflictKind =
	| "live"
	| "claim-conflict"
	| "duplicate";

export interface SessionConflict {
	readonly tabId: string;
	readonly kind: SessionConflictKind;
	readonly detail: string;
}

export type SessionRestoreFailureKind =
	| "missing-file"
	| "claim-error"
	| "launch-failed"
	| "index-error"
	// The row's recorded working directory is not an absolute path (`C:`, an
	// empty value) and nothing else — its session file's own header included —
	// establishes one. No claim was taken and nothing was started: resolving such
	// a value would have launched the session in whatever directory this process
	// runs in.
	| "ambiguous-cwd";

export interface SessionRestoreFailure {
	readonly tabId: string;
	readonly kind: SessionRestoreFailureKind;
	readonly detail: string;
}

/** A draft tab restored as UI only; no process was started for it. */
export interface DraftTab {
	readonly tabId: string;
	readonly cwd: string;
	readonly scope: OmpLaunchScope;
}

/** A row a pass left stopped because the user stopped it; nothing was started. */
export interface StoppedSession {
	readonly tabId: string;
	readonly detail: string;
}

/** Result of restoring one tab. */
export type RestoreOutcome =
	| {
			readonly status: "restored";
			readonly tabId: string;
			readonly sessionFile: string | null;
			readonly host: OmpHostHandle;
	  }
	| { readonly status: "attached"; readonly tabId: string; readonly sessionFile: string | null; readonly detail: string }
	| { readonly status: "draft"; readonly tabId: string; readonly detail: string }
	| { readonly status: "conflict"; readonly tabId: string; readonly kind: SessionConflictKind; readonly detail: string }
	| { readonly status: "failed"; readonly tabId: string; readonly kind: SessionRestoreFailureKind; readonly detail: string }
	/**
	 * Nothing was started and nothing was adopted: the row's durable run intent is
	 * `stopped` and this pass may not resume it. The row's availability is still
	 * re-derived, so a stopped row whose writer is alive reports a conflict instead.
	 */
	| { readonly status: "stopped"; readonly tabId: string; readonly detail: string }
	| { readonly status: "skipped"; readonly tabId: string; readonly detail: string };

export interface RestoreOptions {
	readonly reconciler: OwnerReconciler;
	readonly launcher: OmpHostLauncher;
	readonly mode?: SessionViewMode;
	readonly editorSlotId?: string;
	/** Checked before each tab and after each claim acquisition. */
	readonly signal?: AbortSignal;
	/**
	 * Whether this pass may start or adopt a host for a row whose durable run intent
	 * is `stopped`.
	 *
	 * The startup batch and history-only Open leave such a row exactly as the user
	 * left it. Explicit Resume (or starting a fileless draft) may lift the intent;
	 * the host actually starting clears it.
	 */
	readonly resumeStopped?: boolean;
	/**
	 * Whether this call may resume a stopped session or start an empty draft.
	 *
	 * Defaults to `true` for Resume, New and Reload. History-only Open and restored
	 * editors pass `false`: they never lift a stopped/released intent or start an
	 * empty draft. A serializer callback restores layout, not a decision to Resume.
	 */
	readonly allowStoppedResume?: boolean;
	/** Activation may relaunch only with recorded-writer absence evidence. */
	readonly automatic?: boolean;
}

export interface RestoreAllOptions extends RestoreOptions {
	/**
	 * Start a fresh native host for restored empty drafts. Defaults to `false`:
	 * activation only ever *reattaches* a draft whose exact recorded host is still
	 * running, and a caller that opens a hostless draft calls
	 * {@link SessionIndex.restore} explicitly.
	 */
	readonly restoreDrafts?: boolean;
	/**
	 * Restore only these tabs, in index order. Omitted, every indexed tab is
	 * restored.
	 *
	 * A caller that captured the rows it is responsible for before it started
	 * ("the cohort activation restores") pins the pass to exactly those rows, so a
	 * row created while the pass was preparing is never swept into it: that row
	 * belongs to the action that created it, which opens it explicitly. Without
	 * this, both the pass and the click could reach {@link SessionIndex.restore}
	 * for one row, and the second is refused as a duplicate.
	 */
	readonly only?: ReadonlySet<string>;
	/**
	 * How many rows the pass restores at once. Defaults to {@link RESTORE_CONCURRENCY}.
	 *
	 * Each row's own steps stay in order and its tab's lifecycle gate is held throughout; only
	 * different rows overlap. The report and the log stay in cohort order whatever the completion order.
	 */
	readonly concurrency?: number;
}

/** Per-tab results of one restore pass; every array is independent. */
export interface RestoreReport {
	/** Tab ids in restore order. */
	readonly order: readonly string[];
	readonly restored: readonly RestoredSession[];
	readonly attached: readonly AttachedSession[];
	readonly conflicts: readonly SessionConflict[];
	readonly failures: readonly SessionRestoreFailure[];
	readonly drafts: readonly DraftTab[];
	/** Rows left stopped by their durable intent; nothing was started or adopted. */
	readonly stopped: readonly StoppedSession[];
	/** Tabs not attempted because the signal aborted. */
	readonly skipped: readonly string[];
	/** Tab that should be focused after restoration. */
	readonly activeTabId: string | null;
	/**
	 * Why the index could not persist its state, as far as the pass knew when it returned. The saves the rows queued are not
	 * waited for (see {@link saved}), so a `null` here does not say they landed.
	 */
	readonly persistError: string | null;
	/**
	 * Settles, after every save the pass's rows queued has run, to the failure text that stands then or `null`. A caller that
	 * reports a failed save reports it from here; the saves are queued in order behind and ahead of all other writes either way.
	 */
	readonly saved: Promise<string | null>;
}

/** Result of promoting a reserved draft to its materialized session file. */
export type DraftPromotion =
	| { readonly status: "promoted"; readonly entry: SessionIndexEntry; readonly claim: SessionClaim }
	| { readonly status: "not-materialized"; readonly detail: string }
	| { readonly status: "claim-conflict"; readonly entry: SessionIndexEntry; readonly detail: string };

// Errors

export type SessionIndexErrorCode = "unknown-tab" | "invalid-input" | "invalid-session-file";

export class SessionIndexError extends Error {
	readonly code: SessionIndexErrorCode;

	constructor(code: SessionIndexErrorCode, message: string) {
		super(message);
		this.name = "SessionIndexError";
		this.code = code;
	}
}

/**
 * Lifecycle-gate key for one session file's own operations.
 *
 * The deletion transaction and the import of a discovered file take the same
 * gate for the canonical identity, so one window cannot import a file while it is
 * being deleted. It is a *local* ordering key — it excludes nothing across
 * windows, which is what the durable claim is for — and it never collides with a
 * tab id because of its prefix.
 */
export function fileLifecycleKey(identity: string): string {
	return `file:${normalizeClaimIdentity(identity)}`;
}

// Session index

/** What one adoption of the shared record changed in this window. */
export interface SessionIndexRefresh {
	/** Rows another window added; they are now visible here. */
	readonly adopted: readonly string[];
	/** Rows the shared record no longer names; they were dropped from this window. */
	readonly removed: readonly string[];
	/** Rows left exactly as they were: this window's own lifecycle holds them. */
	readonly kept: readonly string[];
}

export interface SessionIndexOptions {
	/**
	 * Durable shared record for the rows: the profile catalog.
	 *
	 * Pass the store from `src/host/profile-catalog.ts`. Every window of the
	 * extension profile commits to the same record, so a row added or removed in one
	 * window is what every other window reads.
	 */
	readonly store: SessionIndexStore;
	/**
	 * Durable local record for this window's own observations.
	 *
	 * `context.workspaceState` in the extension: a window's availability read, the
	 * reply its panels displayed and the tab it selected are window facts, and
	 * publishing them to the shared record would let a rival window's refusal
	 * overwrite the status of a session another window is running. Defaults to
	 * {@link store}, so a caller with one store keeps every record in it.
	 */
	readonly localStore?: SessionIndexStore;
	/**
	 * Local directory holding the atomic claims.
	 *
	 * It MUST be the same directory the launch integration files its session
	 * claims under (the extension's `storageDir` / `globalStorageUri.fsPath`),
	 * never a subdirectory of it: a different path is a different claim
	 * namespace, so two windows could hold two "exclusive" claims on one session.
	 */
	readonly claimStorageDir: string;
	/**
	 * The holder lease this index presents when it takes a claim.
	 *
	 * Defaults to a fresh lease for this process (`createClaimHolder()`), which
	 * is what a real window wants: one lease per extension host. Tests pass one
	 * explicitly to model a window whose predecessor process is gone, and a
	 * caller that already owns a lease for this window may reuse it.
	 */
	readonly claimHolder?: ClaimHolder;
	/**
	 * The holder's process start time while it is still being read (a PowerShell command, hundreds of
	 * milliseconds to seconds). Until it resolves the holder is presented without one; a claim this index
	 * writes waits for it, so what it files is verified by the start-time rule (ADR-0035), while everything
	 * that only compares holder ids — the Sessions rows, the commands, the views — goes ahead at once.
	 */
	readonly claimHolderCreationTime?: Promise<string | null>;
	/**
	 * The URI of this window (`file:` folder or saved workspace), read when a row is written: it becomes the row's
	 * {@link SessionIndexEntry.home} wherever this window becomes the driver. `null` for a window with no URI;
	 * defaults to a window with none.
	 */
	readonly windowUri?: () => string | null;
	/** Clock injection for tests; defaults to the system clock. */
	readonly now?: () => Date;
	/** Technical failure details for the extension's Output channel, separate from user-facing status. */
	readonly log?: Logger;
	/** Retry timing of a save that lost the catalog lock; tests shorten it. */
	readonly persistRetry?: PersistRetryOptions;
	/** Called once when contention for the catalog lock has lasted {@link PERSIST_BUSY_ESCALATE_MS}: that is a fault to show, not a wait. */
	readonly onPersistStuck?: (message: string) => void;
}

export interface TrackSessionInput {
	readonly sessionFile: string;
	/**
	 * Absolute directory the session belongs to.
	 *
	 * Used only when the file's own header records none this index can read as
	 * absolute; a non-absolute value is then refused instead of resolved.
	 */
	readonly cwd: string;
	readonly scope?: OmpLaunchScope;
}

export interface CreateDraftInput {
	/** Absolute directory the new session runs in; a non-absolute value is refused. */
	readonly cwd: string;
	readonly scope?: OmpLaunchScope;
}

export interface CloseSessionOptions {
	/** `true` only when the caller has proved the native host stopped. */
	readonly confirmedStopped: boolean;
	readonly detail?: string;
	/**
	 * What the close does to the row's durable run intent. `"stopped"` (the default) is the user's stop:
	 * the row stays stopped until an explicit Resume. `"unchanged"` ends the runtime and releases the claim
	 * and host exactly the same way but leaves the intent as it was recorded, for a process that ended
	 * without the user asking (a crash, the operating system ending the session): the next startup
	 * relaunches such a row in its home window. Either way the intent, the cleared host and the release are one persist.
	 */
	readonly runIntent?: "stopped" | "unchanged";
}

export interface CloseSessionResult {
	readonly released: boolean;
	readonly detail: string;
	/**
	 * The run intent the committed row holds after the close's write, when the close wrote and could read it back. A close that
	 * is not the user's stop (`runIntent: "unchanged"`) never decides the intent, so another window's Stop or Kill shows here.
	 */
	readonly runIntent?: RunIntent;
}

/** The run an intent write is about: the launch attempt a caller examined, and its broker when it named one. */
export interface RunIntentTarget {
	readonly attemptStartedAt: string;
	readonly pid: number | null;
	readonly broker?: { readonly slot: string; readonly brokerId: string; readonly brokerGeneration: string };
}

export interface RecordRunIntentOptions {
	/** Write only while the committed row's host is exactly this run (see {@link SessionIndex.recordRunIntent}). */
	readonly expect?: RunIntentTarget;
	/** This window's own observation text for the row, set with the intent. */
	readonly detail?: string;
}

export type RecordRunIntentResult =
	| { readonly status: "recorded"; readonly previous: RunIntent }
	| { readonly status: "target-changed" }
	| { readonly status: "unknown-tab" }
	| { readonly status: "failed"; readonly detail: string };

/** The incarnation of a driven host a detach is bound to: what the window serves and what the row must still record. */
export interface DetachExpectation {
	/** The OMP child's pid. */
	readonly pid: number | null;
	readonly slot: string;
	readonly brokerId: string;
	readonly brokerGeneration: string;
	readonly childPid: number | null;
	readonly childCreationTime: string | null;
}

/** What {@link SessionIndex.detachLiveClaim} did. `claim-unreleased`: the release failed and `stillHeld` says whether this window's claim file remains. */
export type DetachLiveClaimResult =
	| { readonly status: "released" }
	| { readonly status: "target-changed" }
	| { readonly status: "claim-unreleased"; readonly stillHeld: boolean };

/** Whether a host's pid and broker identity are exactly the incarnation a detach names. */
function isDetachTarget(pid: number | null, rpc: RecordedRpcIdentity | null, expected: DetachExpectation): boolean {
	return pid === expected.pid && rpc !== null && rpc.slot === expected.slot && rpc.brokerId === expected.brokerId &&
		rpc.brokerGeneration === expected.brokerGeneration && rpc.childPid === expected.childPid && rpc.childCreationTime === expected.childCreationTime;
}

/** Sentinel the conditional shared write returns when the committed row no longer records the expected process. */
const HOST_CHANGED = "The row's recorded process changed before this record was accepted.";

/** The part of a recorded host a Kill's capture names. */
type CapturedHostRecord = { readonly startedAt: string; readonly pid: number | null; readonly rpc?: RecordedRpcIdentity | null };

/** Whether a row's host record is exactly the incarnation a Kill captured. */
function recordsCapturedHost(host: CapturedHostRecord | null, captured: KilledHostCapture): boolean {
	return host !== null && host.startedAt === captured.attemptStartedAt && host.pid === captured.hostPid &&
		host.rpc?.slot === captured.slot && host.rpc?.brokerId === captured.brokerId && host.rpc?.brokerGeneration === captured.brokerGeneration;
}

/** Whether a row's host record is exactly the run an intent write names (the broker only when the write named one). */
function runIntentTargetMatches(host: CapturedHostRecord | null, target: RunIntentTarget): boolean {
	if (host === null || host.startedAt !== target.attemptStartedAt || host.pid !== target.pid) return false;
	return target.broker === undefined || (host.rpc?.slot === target.broker.slot && host.rpc?.brokerId === target.broker.brokerId && host.rpc?.brokerGeneration === target.broker.brokerGeneration);
}

/** Whether two host records name the same incarnation of a recorded process. */
function sameHostIncarnation(left: CapturedHostRecord | null, right: CapturedHostRecord | null): boolean {
	if (left === null || right === null) return left === right;
	return left.startedAt === right.startedAt && left.pid === right.pid &&
		(left.rpc?.slot ?? null) === (right.rpc?.slot ?? null) && (left.rpc?.brokerId ?? null) === (right.rpc?.brokerId ?? null) &&
		(left.rpc?.brokerGeneration ?? null) === (right.rpc?.brokerGeneration ?? null) && (left.rpc?.childPid ?? null) === (right.rpc?.childPid ?? null) &&
		(left.rpc?.childCreationTime ?? null) === (right.rpc?.childCreationTime ?? null);
}

export interface GoneRecordSweepOptions {
	readonly reconciler: OwnerReconciler;
	/** Whether the row is this window's own responsibility right now (its activation cohort, a host or an editor it holds); such a row is never touched. */
	readonly ownedHere: (tabId: string) => boolean;
}

export interface GoneRecordSweepReport {
	/** Rows whose recorded process was proven gone and whose record of it was cleared. */
	readonly cleared: readonly string[];
	/** Claim files deleted because their holder is provably gone and no row names them. */
	readonly orphanClaims: number;
}

export interface RemoveResult {
	readonly removed: boolean;
	readonly detail: string;
}

/** What a caller that deleted a transcript itself must name to drop its row. */
export interface DropDeletedSessionOptions {
	/** Exact session file the caller proved deleted. */
	readonly sessionFile: string;
	readonly detail?: string;
	/**
	 * The exclusive claim the deletion still holds for that exact file.
	 *
	 * A deletion deliberately keeps its claim through row finalization (ADR-0027),
	 * so this is what lets the row be dropped *before* the claim is released. The
	 * index verifies that the claim is this window's own holder and is still on
	 * disk for the same identity before it drops anything; a claim it cannot verify
	 * is a refusal, never an assumption.
	 */
	readonly heldClaim?: SessionClaim;
}

/**
 * A claim and the runtime associated with it. A driven runtime is owned by this
 * window and must be stopped before another writer or deletion is admitted.
 * An unconfirmed stop preserves the recorded attempt, not an ownership veto:
 * admission and Stop independently verify current ownership.
 */
interface LiveSession {
	claim: SessionClaim;
	host: OmpHostHandle;
	sessionFile: string | null;
	/** Whether this window currently drives a runtime for the tab, as opposed to retaining its claim. */
	driven: boolean;
}

type LaunchStep =
	| { readonly kind: "running"; readonly handle: OmpHostHandle }
	| { readonly kind: "failed"; readonly detail: string }
	| { readonly kind: "unconfirmed"; readonly detail: string };

/**
 * What a restore pass may do with a row that has no session file.
 *
 * `open` is the explicit intent: an eligible draft may be started, which is what
 * {@link SessionIndex.restore} and `restoreDrafts` select. `reattach` is the
 * activation intent: the row may only be adopted from the host this index
 * recorded, and a row with no such host stays a draft nobody starts.
 */
type DraftRestoreIntent = "open" | "reattach";

/**
 * What a restore pass hands one row so the row can be ordered against, and timed beside, the others.
 * Optional everywhere: a single explicit restore has neither.
 */
interface RestoreTrace {
	/** This row's place among the pass's rows that name the same session identity. */
	readonly turn: IdentityTurn;
	readonly timer: RestoreStepTimer;
	/** The saves this row queued and did not wait for, each settling to the failure text or `null`; the pass owns them. */
	readonly saves: Array<Promise<string | null>>;
}

/**
 * Durable index of the OMP sessions this extension manages.
 *
 * Reads are synchronous against the records loaded at construction; every mutation
 * commits the shared record through the profile catalog (read-modify-write under a
 * cross-process lock, so two windows cannot overwrite each other's rows) and this
 * window's own observations through its local store.
 */
export class SessionIndex {
	readonly #store: SessionIndexStore;
	/**
	 * Where this window's own observations live: its own availability/detail per
	 * row, the reply its panels display, and the tab it last selected. Defaults to
	 * {@link store} so an index built with one store keeps every record there;
	 * the extension passes `context.workspaceState`.
	 */
	readonly #localStore: SessionIndexStore;
	readonly #claimStorageDir: string;
	readonly #now: () => Date;
	readonly #log: Logger | undefined;
	/**
	 * This window's live holder lease for every claim it takes. Minted once per
	 * index (one extension host), never persisted: two windows of one workspace
	 * share the persisted owner generation, so this is what actually keeps them
	 * from both holding one session (see `session-claim.ts`).
	 */
	#claimHolder: ClaimHolder;
	/** The window's own URI, read when a row is written (see {@link SessionIndexOptions.windowUri}). */
	readonly #windowUri: () => string | null;
	/** The holder with its start time, once that has been read; the same lease either way. */
	readonly #claimHolderReady: Promise<ClaimHolder>;
	/**
	 * One tab's lifecycle operations, serialized — promotion, restore/attach,
	 * close and removal all mutate the same per-tab facts after awaiting, and each
	 * was written assuming nothing else does. This is the shared coordinator the
	 * extension host also uses for the transitions the index cannot see (the
	 * runtime, the stop proof, the panel): one gate per index, so every path
	 * reaches the same queue.
	 */
	readonly #lifecycle = new TabLifecycle();
	readonly #entries = new Map<string, MutableEntry>();
	readonly #live = new Map<string, LiveSession>();
	/** Durable editor-slot→conversation bindings (ADR-0025), keyed by immutable editor slot id. */
	readonly #bindings = new Map<string, EditorSlotBinding>();
	/** The tail of each editor slot's queue of elections ({@link bindEditorSlot}); a slot with nothing pending has none. */
	readonly #slotElections = new Map<string, Promise<void>>();
	readonly #restoring = new Set<string>();
	/** This window is recording/executing a launch, not recovering an abandoned attempt. */
	readonly #launching = new Set<string>();
	/**
	 * Rows this window's local record already carries an observation for. A row
	 * without one shows the status derived from the shared record (a fileless row is
	 * `draft`, a materialized one is `saved`), which is what makes another workspace's
	 * row visible and honestly *not* running here.
	 */
	readonly #observedTabIds = new Set<string>();
	#activeTabId: string | null = null;
	#nextOrdinal = 1;
	#persistError: string | null = null;
	#localPersistError: string | null = null;
	/**
	 * The shared record this window's in-memory rows were derived from.
	 *
	 * Every write names it as the merge base, so a record another window committed since is
	 * not read as this window's own removal of it: this window's snapshot is simply older
	 * than that record, and the merge keeps it. It stays the record of what this window *saw*:
	 * a refresh moves it to the committed value of every row and binding it adopts, so a row
	 * another window changed is never mistaken for this window's own edit by its next write.
	 */
	#sharedBase: unknown = undefined;
	#loadError: string | null = null;
	/**
	 * Serializes this window's durable writes; a refresh that adopts another
	 * window's rows is chained here too, so it never interleaves with a mutation.
	 */
	#persistChain: Promise<void> = Promise.resolve();
	/** The ordinary save that is queued but has not taken its turn; a later ordinary save waits for it (see `#persistNow`). */
	#queuedOrdinarySave: Promise<string | null> | null = null;
	/** Whether the last failed shared write only lost the catalog lock to another window. */
	#persistBusy = false;
	/** When the current run of contention began; `null` while writes land. */
	#persistBusySince: number | null = null;
	#persistStuckReported = false;
	readonly #persistRetry: PersistRetry;
	readonly #onPersistStuck: ((message: string) => void) | undefined;

	constructor(options: SessionIndexOptions) {
		if (typeof options.claimStorageDir !== "string" || options.claimStorageDir.trim().length === 0) {
			throw new TypeError("SessionIndex requires a non-empty claimStorageDir");
		}
		this.#store = options.store;
		this.#localStore = options.localStore ?? options.store;
		this.#claimStorageDir = path.resolve(options.claimStorageDir);
		this.#now = options.now ?? (() => new Date());
		this.#log = options.log;
		this.#onPersistStuck = options.onPersistStuck;
		this.#persistRetry = new PersistRetry(() => this.#persistNow(), options.persistRetry);
		this.#claimHolder = options.claimHolder ?? createClaimHolder();
		this.#windowUri = options.windowUri ?? (() => null);
		this.#claimHolderReady = options.claimHolderCreationTime === undefined
			? Promise.resolve(this.#claimHolder)
			: options.claimHolderCreationTime.then(processCreationTime => {
				if (processCreationTime !== null) this.#claimHolder = { ...this.#claimHolder, processCreationTime };
				return this.#claimHolder;
			}, () => this.#claimHolder);
		this.#load();
	}

	// Read state

	/** Every entry in deterministic tab order. */
	list(): readonly SessionIndexEntry[] {
		return [...this.#entries.values()].sort((a, b) => a.ordinal - b.ordinal).map(toEntry);
	}

	get(tabId: string): SessionIndexEntry | null {
		const entry = this.#entries.get(tabId);
		return entry ? toEntry(entry) : null;
	}

	isLaunching(tabId: string): boolean {
		return this.#launching.has(tabId);
	}

	/** Tab that should be focused; recovered from the last active tab. */
	get activeTabId(): string | null {
		if (this.#activeTabId !== null && this.#entries.has(this.#activeTabId)) return this.#activeTabId;
		const mostRecent = [...this.#entries.values()].sort((a, b) =>
			a.lastActiveAt < b.lastActiveAt ? 1 : a.lastActiveAt > b.lastActiveAt ? -1 : 0,
		)[0];
		return mostRecent?.tabId ?? null;
	}

	get persistError(): string | null {
		return this.#persistError;
	}

	/** Whether {@link persistError} is only contention for the profile catalog, which this index saves again by itself. */
	get persistBusy(): boolean {
		return this.#persistBusy;
	}

	/**
	 * Whether this window currently runs a native host for that row.
	 *
	 * It is this window's own fact — the live record a launch or an adoption created
	 * here, while this window still drives it — and is what activation uses to decide
	 * that a row is its own to restore, as opposed to a row another workspace's window
	 * put in the shared index. A claim retained after a Close this window could
	 * not confirm is *not* a runtime this window drives (its terminal is gone), so it
	 * is answered `false` here and the row is re-derived as the stopped, unresolved row
	 * it is.
	 */
	hasLiveHost(tabId: string): boolean {
		return this.#drivesHost(tabId);
	}

	/**
	 * Whether this window drives a runtime for the tab right now.
	 *
	 * Distinct from "holds a live record": an unconfirmed close keeps the claim and the
	 * recorded attempt as bookkeeping while there is nothing left to stop from here.
	 */
	#drivesHost(tabId: string): boolean {
		const live = this.#live.get(tabId);
		return live !== undefined && live.driven;
	}

	/**
	 * Set when this window's own observations could not be saved.
	 *
	 * Separate from {@link persistError} on purpose: the shared row is the durable
	 * authority for what may run, and a local status write never gates a lifecycle
	 * decision that the shared record already settled.
	 */
	get localPersistError(): string | null {
		return this.#localPersistError;
	}

	/**
	 * Adopt the shared record as the newest committed revision holds it.
	 *
	 * Called when the catalog reports another window's commit. The pass adds rows
	 * this window has not seen, re-reads the shared facts of rows it has (keeping its
	 * own observations and the reply its panels displayed), drops rows the shared
	 * record no longer names, and adopts the committed slot bindings. A tab whose
	 * lifecycle operation is in flight, and a tab this window
	 * has a live host for, are left exactly as they are: their operation was written
	 * against the row as it stood, and it commits its own outcome.
	 *
	 * It starts nothing, stops nothing, takes and releases no claim, and never
	 * changes a row's run intent — adopting another window's rows is visibility, not
	 * ownership.
	 */
	async refreshFromStore(): Promise<SessionIndexRefresh> {
		const adopted: string[] = [];
		const removed: string[] = [];
		const kept: string[] = [];
		let markersAhead = false;
		let sweptBindings = false;
		this.#persistChain = this.#persistChain.then(() => {
			let raw: unknown;
			try {
				raw = this.#store.get<unknown>(SESSION_INDEX_STORAGE_KEY);
			} catch {
				return;
			}
			if (raw === undefined || raw === null || !isPersistedSnapshot(raw)) return;
			const present = new Set<string>();
			// The rows this refresh made equal to the committed record, and the ones it dropped with it: the merge base follows them.
			const followed = new Map<string, SharedEntry>();
			const dropped = new Set<string>();
			for (const candidate of raw.entries) {
				const shared = cloneSharedEntry(candidate);
				present.add(shared.tabId);
				const existing = this.#entries.get(shared.tabId);
				if (existing === undefined) {
					this.#entries.set(shared.tabId, composeEntry(shared, undefined));
					adopted.push(shared.tabId);
					followed.set(shared.tabId, candidate);
					continue;
				}
				if (this.#lifecycle.busy(shared.tabId) || this.#live.has(shared.tabId)) {
					kept.push(shared.tabId);
					// The reply identities are not a lifecycle fact: the window that runs a row must follow the
					// window the user read it in, and must hand its own newer identity back to the catalog.
					const completed = laterReplyMarker(null, existing.lastCompletedReplyId, shared.lastCompletedReplyId);
					const seen = laterReplyMarker(null, existing.lastSeenReplyId, shared.lastSeenReplyId);
					if (compareReplyMarkers(existing.lastCompletedReplyId, shared.lastCompletedReplyId)! > 0 ||
						compareReplyMarkers(existing.lastSeenReplyId, shared.lastSeenReplyId)! > 0) markersAhead = true;
					existing.lastCompletedReplyId = completed;
					existing.lastSeenReplyId = seen;
					continue;
				}
				// An identity this window recorded and has not written yet must not be replaced by an older committed one.
				const composed = composeEntry(shared, { availability: existing.availability, detail: existing.detail });
				composed.lastCompletedReplyId = laterReplyMarker(existing.lastCompletedReplyId, existing.lastCompletedReplyId, shared.lastCompletedReplyId) ?? null;
				composed.lastSeenReplyId = laterReplyMarker(existing.lastSeenReplyId, existing.lastSeenReplyId, shared.lastSeenReplyId) ?? null;
				this.#entries.set(shared.tabId, composed);
				followed.set(shared.tabId, candidate);
			}
			for (const tabId of [...this.#entries.keys()]) {
				if (present.has(tabId)) continue;
				if (this.#lifecycle.busy(tabId) || this.#live.has(tabId)) {
					kept.push(tabId);
					continue;
				}
				this.#entries.delete(tabId);
				removed.push(tabId);
				dropped.add(tabId);
			}
			const bindings = persistedBindings(raw.bindings);
			const bound = new Set(bindings.map(binding => binding.slotId));
			for (const binding of bindings) this.#bindings.set(binding.slotId, binding);
			for (const slotId of [...this.#bindings.keys()]) {
				if (bound.has(slotId)) continue;
				this.#bindings.delete(slotId);
			}
			// Adopting a higher ordinal keeps a later row from this window out of an
			// order another window already used.
			this.#nextOrdinal = Math.max(this.#nextOrdinal, raw.nextOrdinal);
			this.#followCommitted(raw, followed, dropped);
			// The bindings are mirrored whole above, orphans included; the sweep is a change of this window's, saved below.
			sweptBindings = this.#dropOrphanBindings();
		});
		await this.#persistChain;
		// A reply identity this window holds and the catalog lost (a stale copy of the row was written over it) is
		// written back, so the other windows show what the user saw here.
		if (markersAhead || sweptBindings) await this.#persist();
		return { adopted, removed, kept };
	}

	/**
	 * Move the merge base to what a refresh just adopted.
	 *
	 * Rows the refresh made equal to the committed record take the committed value, rows it dropped leave the base, and
	 * the bindings (which a refresh mirrors whole) are the committed ones. A row the refresh left alone (a live host or a
	 * lifecycle operation in flight) keeps its old base entry, so its own change still reaches the merge and is reported.
	 */
	#followCommitted(raw: SharedSnapshot, followed: ReadonlyMap<string, SharedEntry>, dropped: ReadonlySet<string>): void {
		const previous = isPersistedSnapshot(this.#sharedBase) ? this.#sharedBase : null;
		const rows = new Map<string, SharedEntry>(previous?.entries.map(entry => [entry.tabId, entry]) ?? []);
		for (const tabId of dropped) rows.delete(tabId);
		for (const [tabId, row] of followed) rows.set(tabId, row);
		this.#sharedBase = { version: INDEX_VERSION, nextOrdinal: raw.nextOrdinal, entries: [...rows.values()], bindings: raw.bindings } satisfies SharedSnapshot;
	}

	/** Set when the persisted snapshot could not be read back as index state. */
	get loadError(): string | null {
		return this.#loadError;
	}

	// Mutations

	/**
	 * Reserve a new draft tab: a stable tab identity plus a reserved draft claim
	 * identity. No process and no session file exist yet.
	 */
	async createDraft(input: CreateDraftInput): Promise<SessionIndexEntry> {
		const cwd = resolveWorkspaceDirectoryInput(input.cwd, "createDraft");
		const timestamp = this.#timestamp();
		const entry: MutableEntry = {
			tabId: `tab:${randomUUID()}`,
			origin: "extension",
			sessionFile: null,
			sessionId: null,
			cwd,
			scope: normalizeScope(input.scope),
			sessionDir: input.scope?.sessionDir ?? null,
			ownership: {
				ownerGeneration: createOwnerGeneration(),
				draftIdentity: createDraftIdentity(),
				releasedAt: null,
			},
			host: null,
			createdAt: timestamp,
			lastActiveAt: timestamp,
			ordinal: this.#nextOrdinal++,
			availability: "draft",
			detail: "This is a new session. Resume to start chatting.",
			runIntent: "stopped",
			title: null,
			lastCompletedReplyId: null,
			lastSeenReplyId: null,
			home: null,
		};
		this.#entries.set(entry.tabId, entry);
		await this.#persist();
		return toEntry(entry);
	}

	/**
	 * Register an existing materialized OMP session found in OMP's own history.
	 *
	 * The entry is marked {@link SessionOrigin} `imported`: provenance for the
	 * destructive paths, which never remove a file this extension did not create.
	 * It is resumed exactly like a created session — same claim, same reconciler,
	 * same launcher, same GUI and the same exact-path `--resume` — and it receives
	 * its own owner generation here, persisted with the row *before* anything
	 * claims the file, so a later window re-opens the very claim this one took. The
	 * exact file, the cwd and the session directory are kept as they were
	 * discovered and are never recomputed.
	 *
	 * Idempotent per session file: a file this workspace already tracks returns its
	 * existing tab instead of creating a second one, which is what makes a
	 * repeated click on the same History row reveal one GUI tab.
	 */
	async trackSession(input: TrackSessionInput): Promise<SessionIndexEntry> {
		const sessionFile = resolveInputPath(input.sessionFile, "trackSession");
		// The import shares the file's own lifecycle gate with the deletion
		// transaction, so a file cannot be adopted here while its files are being
		// removed, and two racing imports of one file serialize instead of both
		// reaching the claim.
		return await this.withinFileLifecycle(sessionFile, async () => await this.#trackSessionHeld(sessionFile, input));
	}

	/** One import's body; the caller already holds the file's lifecycle. */
	async #trackSessionHeld(sessionFile: string, input: TrackSessionInput): Promise<SessionIndexEntry> {
		const key = normalizeSessionIdentityKey(sessionFile);
		for (const existing of this.#entries.values()) {
			if (existing.sessionFile !== null && normalizeSessionIdentityKey(existing.sessionFile) === key) {
				await this.#touch(existing);
				await this.#persist();
				return toEntry(existing);
			}
		}

		const header = await readSessionFileHeader(sessionFile);
		if (header === null) {
			throw new SessionIndexError(
				"invalid-session-file",
				`${sessionFile} is not a readable OMP session file (no session header was found).`,
			);
		}
		// The lookup is repeated after the awaited header read, and there is no
		// await between it and the insert below: two clicks on one History row both
		// reach the read, and the pair of statements is what makes them converge on
		// the first tab instead of registering the file twice.
		for (const existing of this.#entries.values()) {
			if (existing.sessionFile !== null && normalizeSessionIdentityKey(existing.sessionFile) === key) {
				await this.#touch(existing);
				await this.#persist();
				return toEntry(existing);
			}
		}
		const timestamp = this.#timestamp();
		const entry: MutableEntry = {
			tabId: `tab:${randomUUID()}`,
			origin: "imported",
			sessionFile,
			sessionId: header.sessionId,
			// The file's own header is the strongest evidence of the directory the
			// session ran in; the caller's folder stands in only when the header
			// records none this index can read as an absolute directory.
			cwd:
				header.cwd !== null && isAbsoluteWorkspaceDirectory(header.cwd)
					? normalizeWorkspaceDirectory(header.cwd)
					: resolveWorkspaceDirectoryInput(input.cwd, "trackSession"),
			scope: normalizeScope(input.scope),
			sessionDir: path.dirname(sessionFile),
			// The row is claimed like any other tab, so it carries the owner
			// generation it will claim under. It is minted once, here, and persisted
			// with the row: a claim is only ever re-adopted by the generation that
			// filed it, so minting at claim time would leave a claim no later window
			// could recognise as its own. There is no draft identity — the file
			// already exists under the exact path recorded above.
			ownership: {
				ownerGeneration: createOwnerGeneration(),
				draftIdentity: null,
				releasedAt: null,
			},
			host: null,
			createdAt: timestamp,
			lastActiveAt: timestamp,
			ordinal: this.#nextOrdinal++,
			availability: "saved",
			detail: IMPORTED_SESSION_DETAIL,
			runIntent: "stopped",
			title: header.title ?? header.promptTitle ?? null,
			lastCompletedReplyId: null,
			lastSeenReplyId: null,
			home: null,
		};
		this.#entries.set(entry.tabId, entry);
		await this.#persist();
		return toEntry(entry);
	}

	/**
	 * Promote a draft tab to its materialized session file, keeping the tab
	 * identity.
	 *
	 * The canonical claim for the session file is acquired *before* the reserved
	 * draft claim is released, so no window can observe an unclaimed session. A
	 * file already claimed by another owner leaves the draft claim (and the tab)
	 * intact and is reported as a conflict.
	 *
	 * The whole promotion runs with the tab's lifecycle held, and it re-reads the
	 * entry once admitted: a terminal close, a relaunch or a row removal of the
	 * same tab is ordered either before this call — which then reads the tab as
	 * gone, already bound or already closed — or after it, never inside its header
	 * read, claim migration and persistence. Which *runtime* the promotion speaks
	 * for is the caller's own fact, so the caller re-checks that too, inside the
	 * same gate; the exact binding of the runtime's session file to this tab is
	 * what promotes it.
	 *
	 * `lease` is the caller's own lease for `tabId` when it already holds that
	 * gate, so this call joins it instead of queueing behind it.
	 */
	async promoteDraft(tabId: string, sessionFile: string, lease?: TabLifecycleLease): Promise<DraftPromotion> {
		return await this.withinTabLifecycle(tabId, lease, async () => await this.#promoteDraftHeld(tabId, sessionFile));
	}

	/**
	 * Adopt the session file a draft's *dead* host wrote, from a deferred pass.
	 *
	 * The same promotion as {@link SessionIndex.promoteDraft} with two extra rules,
	 * both evaluated inside the tab's lifecycle:
	 *
	 * - it refuses while this window holds a live record for the tab, because a host
	 *   this window runs materializes its own file and only that host's promotion may
	 *   bind it;
	 * - `authorization` must still describe the row. It is the signature the deferred
	 *   reconciliation produced for the classification that found this row startable
	 *   ({@link DeferredReconciliation.authorization}), and the absence it accepted
	 *   says nothing about a row that has since been closed, relaunched, promoted or
	 *   left by an unconfirmed restore — such a row passes every "no runtime, no
	 *   live record" check while nobody has verified that its host is gone.
	 */
	async promoteDeferredDraft(
		tabId: string,
		sessionFile: string,
		authorization: string,
		lease?: TabLifecycleLease,
	): Promise<DraftPromotion> {
		return await this.withinTabLifecycle(tabId, lease, async () => {
			const live = this.#live.get(tabId);
			if (live?.driven === true) {
				return {
					status: "not-materialized",
					detail:
						`This window is running the host for tab ${tabId}, so only that host's own promotion ` +
						`may bind ${sessionFile}.`,
				};
			}
			if (live !== undefined) {
				// The claim is retained from a close this window could not confirm: the
				// host that may have written this file is not this window's to speak for,
				// and only a fresh ownership check (or that host's own promotion) may bind
				// its session file.
				return {
					status: "not-materialized",
					detail:
						"This session could not finish closing. Reopen its editor and try again.",
				};
			}
			const entry = this.#entries.get(tabId);
			if (entry === undefined) {
				return { status: "not-materialized", detail: `No indexed tab ${tabId}.` };
			}
			if (deferredAuthorization(toEntry(entry)) !== authorization) {
				return {
					status: "not-materialized",
					detail:
						`Tab ${tabId} changed after it was reported startable (a launch, a close, a promotion or ` +
						"an unconfirmed restore), so the absence that justified adopting a file for it no longer " +
						"describes it; a fresh deferred pass must re-derive it.",
				};
			}
			return await this.#promoteDraftHeld(tabId, sessionFile);
		});
	}

	/** One promotion's body; the caller already holds the tab's lifecycle. */
	async #promoteDraftHeld(tabId: string, sessionFile: string): Promise<DraftPromotion> {
		const entry = this.#entries.get(tabId) ?? null;
		if (entry === null) {
			return { status: "not-materialized", detail: `No indexed tab ${tabId}.` };
		}
		if (entry.sessionFile !== null) {
			return { status: "not-materialized", detail: `Tab ${tabId} is already bound to ${entry.sessionFile}.` };
		}
		const header = await readSessionFileHeader(sessionFile);
		if (header === null) {
			return {
				status: "not-materialized",
				detail: `${sessionFile} does not exist yet or carries no OMP session header.`,
			};
		}

		let draft: SessionClaim;
		try {
			draft = this.#live.get(tabId)?.claim ?? (await this.#adoptClaim(entry, entry.ownership?.draftIdentity ?? null));
		} catch (error) {
			return { status: "not-materialized", detail: describeError(error) };
		}

		let claim: SessionClaim;
		try {
			claim = await promoteDraftClaim(draft, sessionFile);
		} catch (error) {
			if (error instanceof ClaimConflictError) {
				return {
					status: "claim-conflict",
					entry: toEntry(entry),
					detail:
						"This conversation is already open in another window. Continue there; this session was not changed.",
				};
			}
			return { status: "not-materialized", detail: describeError(error) };
		}

		const live = this.#live.get(tabId);
		if (live) {
			live.claim = claim;
			live.sessionFile = sessionFile;
		}
		entry.sessionFile = sessionFile;
		entry.sessionId = header.sessionId;
		entry.sessionDir = path.dirname(sessionFile);
		if (header.title !== null || header.promptTitle !== undefined) entry.title = header.title ?? header.promptTitle ?? null;
		entry.ownership = {
			ownerGeneration: claim.ownerGeneration,
			draftIdentity: entry.ownership?.draftIdentity ?? draft.identity,
			releasedAt: null,
		};
		entry.availability = live === undefined ? "saved" : "live";
		entry.detail = "Promoted from a reserved draft identity to its session file.";
		await this.#touch(entry);
		await this.#persist();
		return { status: "promoted", entry: toEntry(entry), claim };
	}

	/** Record which tab the user is in; drives active-tab recovery. */
	async setActiveTab(tabId: string): Promise<void> {
		if (!this.#entries.has(tabId)) {
			throw new SessionIndexError("unknown-tab", `No indexed tab ${tabId}.`);
		}
		this.#activeTabId = tabId;
		await this.#persist();
	}

	// Restore

	/**
	 * Restore every indexed tab, independently — or exactly the tabs `only`
	 * names, when the caller pinned the pass to the rows it took responsibility
	 * for (see {@link RestoreAllOptions.only}).
	 *
	 * A fileless row is dispatched attach-only unless `restoreDrafts` is set: the
	 * pass may reattach a host that outlived the extension host that launched it,
	 * never start one. The caller that actually opens a tab with no host behind it
	 * calls {@link SessionIndex.restore}, which keeps its meaning: it may start a
	 * fresh native host for an eligible draft.
	 */
	async restoreAll(options: RestoreAllOptions): Promise<RestoreReport> {
		const only = options.only;
		const order = this.list()
			.map(entry => entry.tabId)
			.filter(tabId => only === undefined || only.has(tabId));
		const restored: RestoredSession[] = [];
		const attached: AttachedSession[] = [];
		const conflicts: SessionConflict[] = [];
		const failures: SessionRestoreFailure[] = [];
		const drafts: DraftTab[] = [];
		const stopped: StoppedSession[] = [];
		const skipped: string[] = [];
		const takenIdentities = new Map<string, string>();
		// A tab this window already has open owns its identity for this pass.
		for (const [tabId, live] of this.#live) {
			const identity = live.sessionFile;
			if (identity !== null) takenIdentities.set(normalizeSessionIdentityKey(identity), tabId);
		}

		// A fileless row is dispatched attach-only unless the caller asked for
		// drafts to be started: an activation pass reattaches a host that outlived
		// the extension host that launched it, and never starts one for a row the
		// user has not asked to open. A caller that *did* ask for a draft to be
		// started is asking for a start — an explicit intent exactly like Resume —
		// so it also lifts a row's stopped intent for this pass.
		const draftIntent: DraftRestoreIntent = options.restoreDrafts === true ? "open" : "reattach";
		const pass: RestoreOptions = options.restoreDrafts === true ? { ...options, resumeStopped: true } : { ...options, automatic: true };
		// Rows run together, at most `concurrency` at a time, and start in cohort order. Each row
		// is still its own tab's whole restore under that tab's lifecycle gate; what is shared is
		// serialized where it already was: catalog writes go through the one persist chain, and the
		// duplicate-identity rule is decided in cohort order among rows that name the same identity.
		const rows = order.flatMap(tabId => {
			const entry = this.#entries.get(tabId);
			return entry === undefined ? [] : [entry];
		});
		const turns = new IdentityTurns();
		const saves: Array<Promise<string | null>> = [];
		const outcomes = await mapBounded(rows, options.concurrency ?? RESTORE_CONCURRENCY, async (entry): Promise<RestoreOutcome> => {
			const tabId = entry.tabId;
			if (options.signal?.aborted === true) {
				return { status: "skipped", tabId, detail: "Restore was cancelled before this tab was started." };
			}
			const timer = new RestoreStepTimer();
			const turn = turns.next(restoreIdentityKey(entry));
			let outcome: RestoreOutcome;
			try {
				outcome = await this.#restoreEntry(entry, pass, takenIdentities, draftIntent, { turn, timer, saves });
			} catch (error) {
				// One row's unexpected failure is that row's failure; the others carry on.
				outcome = { status: "failed", tabId, kind: "index-error", detail: describeError(error) };
			} finally {
				turn.release();
			}
			const kind = outcome.status === "conflict" || outcome.status === "failed" ? `:${outcome.kind}` : "";
			this.#log?.info(`window timing: restore tab ${tabId} ${timer.finish(`${outcome.status}${kind}`)}`);
			return outcome;
		});
		// The report is folded in cohort order, never in completion order.
		for (const [position, outcome] of outcomes.entries()) {
			const entry = rows[position] as MutableEntry;
			const tabId = entry.tabId;
			switch (outcome.status) {
				case "restored":
					restored.push({ tabId, sessionFile: outcome.sessionFile, host: outcome.host });
					break;
				case "attached":
					attached.push({ tabId, sessionFile: outcome.sessionFile, detail: outcome.detail });
					break;
				case "draft":
					drafts.push({ tabId, cwd: entry.cwd, scope: { ...entry.scope } });
					break;
				case "stopped":
					stopped.push({ tabId, detail: outcome.detail });
					break;
				case "conflict":
					conflicts.push({ tabId, kind: outcome.kind, detail: outcome.detail });
					break;
				case "failed":
					failures.push({ tabId, kind: outcome.kind, detail: outcome.detail });
					break;
				case "skipped":
					skipped.push(tabId);
					break;
			}
		}

		return {
			order,
			restored,
			attached,
			conflicts,
			failures,
			drafts,
			stopped,
			skipped,
			activeTabId: this.activeTabId,
			persistError: this.#persistError,
			saved: Promise.all(saves).then(() => this.#persistError),
		};
	}

	/**
	 * Restore one tab. Explicit intent, so a draft tab starts a fresh native
	 * host here even though {@link restoreAll} only ever reattaches one.
	 */
	async restore(tabId: string, options: RestoreOptions): Promise<RestoreOutcome> {
		const entry = this.#entries.get(tabId);
		if (entry === undefined) {
			return { status: "failed", tabId, kind: "index-error", detail: `No indexed tab ${tabId}.` };
		}
		// Resume may lift a stopped intent; Open/history and automatic callers pass
		// `allowStoppedResume: false` and preserve it. The intent is cleared only by
		// the host actually starting.
		const explicit = options.allowStoppedResume !== false;
		return await this.#restoreEntry(
			entry,
			{ ...options, resumeStopped: explicit },
			new Map(),
			explicit ? "open" : "reattach",
		);
	}

	/** Replace a positively settled writer without opening a claim gap. */
	async replaceHost(
		tabId: string,
		input: {
			readonly confirmedStopped: boolean;
			readonly expectedPid: number;
			readonly expectedCreationTime: string;
			readonly mode: SessionViewMode;
			readonly slotId: string;
			readonly emptyFile: string | null;
			readonly launcher: OmpHostLauncher;
		},
		lease: TabLifecycleLease,
	): Promise<RestoreOutcome> {
		return await this.withinTabLifecycle(tabId, lease, async () => {
			const entry = this.#entries.get(tabId);
			const live = this.#live.get(tabId);
			if (!input.confirmedStopped || entry === undefined || live === undefined || entry.host?.pid !== input.expectedPid || entry.host.rpc?.childCreationTime !== input.expectedCreationTime) {
				return { status: "failed", tabId, kind: "index-error", detail: "The running session changed. Try changing its view again." };
			}
			if (entry.sessionFile === null) {
				if (entry.ownership?.draftIdentity == null || (input.emptyFile !== null && await fileExists(input.emptyFile))) {
					return { status: "failed", tabId, kind: "index-error", detail: "Only an empty fileless draft may reset its native identity." };
				}
				entry.sessionId = null;
			} else if (!(await fileExists(entry.sessionFile))) {
				return { status: "failed", tabId, kind: "missing-file", detail: "The durable conversation file disappeared; it cannot be replaced as empty." };
			}
			const binding = this.#bindings.get(input.slotId);
			if (binding === undefined || binding.tabId !== tabId) return { status: "failed", tabId, kind: "index-error", detail: "The editor binding changed before replacement." };
			this.#bindings.set(input.slotId, { ...binding, mode: input.mode });
			entry.host = { pid: null, instanceId: null, generation: null, sessionId: entry.sessionId, startedAt: this.#timestamp(), transport: input.mode === "terminal" ? "native" : "rpc", rpc: null };
			entry.runIntent = "running";
			await this.#persist();
			if (this.#persistError !== null) return { status: "failed", tabId, kind: "index-error", detail: "The successor transport attempt could not be recorded." };
			this.#launching.add(tabId);
			let step: LaunchStep;
			try { step = await this.#launch(entry, live.claim, input.launcher); }
			finally { this.#launching.delete(tabId); }
			if (step.kind !== "running") {
				this.#live.delete(tabId);
				await this.#releaseQuietly(live.claim);
				entry.runIntent = "stopped";
				await this.#touch(entry, entry.sessionFile === null ? "draft" : "saved", step.detail);
				await this.#persist();
				return { status: "failed", tabId, kind: "launch-failed", detail: step.detail };
			}
			this.#live.set(tabId, { claim: live.claim, host: step.handle, sessionFile: entry.sessionFile, driven: true });
			if (entry.sessionFile === null) entry.sessionId = step.handle.sessionId ?? entry.sessionId;
			entry.host = { ...entry.host, pid: step.handle.pid, sessionId: step.handle.sessionId ?? entry.host.sessionId, rpc: step.handle.rpc, transport: step.handle.transport ?? entry.host.transport };
			await this.#touch(entry, "live", "The session restarted in the same editor.");
			await this.#persist();
			return { status: "restored", tabId, sessionFile: entry.sessionFile, host: step.handle };
		});
	}

	/** Best-effort native A→B observation; no root-exit or settled-identity claim. */
	async transferNativeHost(input: {
		readonly fromTabId: string;
		readonly toTabId: string;
		readonly slotId: string;
		readonly expectedPid: number;
		readonly expectedCreationTime: string;
		readonly sessionId: string;
		readonly name: string | null;
		readonly reconciler: OwnerReconciler;
		readonly brokerMapping?: CatalogRecordChange;
	}): Promise<NativeHostTransferOutcome> {
		return await this.#lifecycle.runPair(input.fromTabId, input.toTabId, async () => {
			const from = this.#entries.get(input.fromTabId);
			const to = this.#entries.get(input.toTabId);
			const live = this.#live.get(input.fromTabId);
			const priorBinding = this.#bindings.get(input.slotId);
			if (from === undefined || to === undefined || live === undefined || priorBinding?.tabId !== input.fromTabId || from.host?.transport !== "native" || from.host.pid !== input.expectedPid || from.host.rpc?.childCreationTime !== input.expectedCreationTime) {
				return { status: "refused", kind: "changed", detail: "The native process or editor changed before its observed handover." };
			}
			if (from.tabId === to.tabId) return { status: "bound", binding: cloneBinding(priorBinding) };
			if (this.#live.has(to.tabId)) return { status: "refused", kind: "conflict", detail: "This conversation is already running in another editor." };
			const target = to.sessionFile ?? to.ownership?.draftIdentity ?? null;
			if (target === null) return { status: "refused", kind: "unavailable", detail: "This conversation cannot be opened yet. Try again after it is saved." };
			const observed = await this.#readClaim(target);
			const verdict = await this.#reconcile(to, observed.ok ? observed.claim : null, input.reconciler);
			if (verdict.kind === "live" || verdict.kind === "attachable") return { status: "refused", kind: "conflict", detail: "A verified rival owns the observed native destination; the newcomer cannot control it." };
			let claim: SessionClaim;
			try { claim = await this.#adoptClaim(to, target); }
			catch (error) {
				this.#log?.error(`native destination claim failed: ${describeError(error)}`);
				return { status: "refused", kind: "unavailable", detail: "This conversation could not be opened. Refresh Sessions and try again." };
			}
			const beforeFrom = { ...from };
			const beforeTo = { ...to };
			const beforeBindings = new Map(this.#bindings);
			const host = from.host;
			from.host = null;
			from.runIntent = "stopped";
			from.availability = from.sessionFile === null ? "draft" : "saved";
			from.detail = "Native OMP now serves another observed conversation.";
			from.lastActiveAt = this.#timestamp();
			to.host = { ...host, sessionId: input.sessionId };
			to.home = this.#windowUri();
			to.sessionId = input.sessionId;
			if (input.name !== null) to.title = input.name;
			to.runIntent = "running";
			to.availability = "live";
			to.detail = "Best-effort native current-session observation.";
			to.lastActiveAt = this.#timestamp();
			to.ownership = { ownerGeneration: claim.ownerGeneration, draftIdentity: to.ownership?.draftIdentity ?? null, releasedAt: null };
			this.#live.delete(from.tabId);
			this.#live.set(to.tabId, { ...live, claim, host: { ...live.host, sessionId: input.sessionId }, sessionFile: to.sessionFile });
			const binding: EditorSlotBinding = { ...priorBinding, tabId: to.tabId, generation: priorBinding.generation + 1, mode: "terminal", role: "controlling", roleRefusal: null, committedAt: this.#timestamp() };
			this.#demoteRivalControllers(binding);
			this.#bindings.set(input.slotId, binding);
			const failure = await this.#persistNow(input.brokerMapping);
			if (failure !== null) {
				this.#entries.set(from.tabId, beforeFrom);
				this.#entries.set(to.tabId, beforeTo);
				this.#live.delete(to.tabId);
				this.#live.set(from.tabId, live);
				this.#bindings.clear();
				for (const [slot, prior] of beforeBindings) this.#bindings.set(slot, prior);
				await this.#releaseQuietly(claim);
				return { status: "refused", kind: "unavailable", detail: "The observed native handover could not be recorded durably." };
			}
			await this.#releaseQuietly(live.claim);
			return { status: "bound", binding: cloneBinding(binding) };
		});
	}

	/**
	 * Re-derive the availability of the draft tabs {@link restoreAll} leaves alone.
	 *
	 * A tab with no session file is restored as UI only, so the availability an
	 * earlier extension host persisted for it would never be checked again: a
	 * `live` status could stick for a writer that is provably gone. This pass
	 * re-runs the claim observation and ownership reconciliation a restore would
	 * and stores the result, but it starts nothing and holds nothing; unknown
	 * writers become ordinary startable drafts.
	 *
	 * Each row is re-derived with its tab's lifecycle held, and one that changed
	 * while this pass waited — bound to a file, or given a live record by a
	 * promotion, a restore or a close that reached the tab first — is left to that
	 * operation instead of being overwritten with a classification computed from
	 * the row as it was before.
	 */
	async reconcileDeferred(options: DeferredReconcileOptions): Promise<DeferredReconcileReport> {
		const order: string[] = [];
		const reconciled: DeferredReconciliation[] = [];
		const running: string[] = [];
		const only = options.tabId;
		for (const tabId of this.list().map(entry => entry.tabId)) {
			if (only !== undefined && tabId !== only) continue;
			if (options.tabIds !== undefined && !options.tabIds.has(tabId)) continue;
			const entry = this.#entries.get(tabId);
			if (entry === undefined || entry.sessionFile !== null) continue;
			order.push(tabId);
			if (this.#live.has(tabId)) {
				running.push(tabId);
				continue;
			}
			// A draft that never recorded a launched host has no writer of ours
			// that could have died, so its stored row cannot have gone stale.
			if (entry.host === null && entry.availability === "draft") continue;

			// The row is re-derived with the tab's lifecycle held, and the facts the
			// re-derivation starts from are re-read once admitted: a promotion, a
			// restore or a close that reached this tab first has already decided what
			// the row is, from fresher facts than this pass read.
			await this.withinTabLifecycle(tabId, undefined, async () => {
				if (entry.sessionFile !== null || this.#live.has(tabId)) return;
				const target = entry.ownership?.draftIdentity ?? null;
				const observed = target === null ? { ok: true as const, claim: null } : await this.#readClaim(target);
				const claim = observed.ok ? observed.claim : null;
				const verdict = observed.ok
					? await this.#reconcile(entry, claim, options.reconciler)
					: { kind: "unknown" as const, detail: observed.detail };
				const classification = classifySessionAvailability({
					entry: toEntry(entry),
					fileExists: false,
					claim,
					localLive: false,
					verdict,
				});
				// The row is corrected, not "used": `lastActiveAt` stays where the
				// user left it, so a re-derivation cannot move the recovered focus.
				entry.availability = classification.availability;
				entry.detail = classification.detail;
				reconciled.push({
					tabId,
					availability: classification.availability,
					detail: classification.detail,
					evidence: classification.evidence,
					startable: classification.startable,
					attachableHost: classification.attachableHost,
					authorization: deferredAuthorization(toEntry(entry)),
				});
			});
		}
		if (reconciled.length > 0) await this.#persist();
		return { order, reconciled, running, persistError: this.#persistError };
	}

	/**
	 * Settle the records a window that is gone left behind, for rows this window is not responsible for.
	 *
	 * A row whose process ended while no window watched it (the window was closed, or never recorded the exit) keeps its
	 * recorded host and its claim, and no window's startup pass looks at it: startup restores only the rows a window holds
	 * an editor or a host for. The row is not wrong, it reads "Stopped" and Resume works, but the record names a process
	 * that no longer exists and a claim nobody can release. This pass, started once per activation and after the startup
	 * restore, clears both. It starts nothing, stops nothing and never changes a run intent: a row that was running stays
	 * `running`, so a window that later holds an editor for it relaunches it like any row whose process ended abnormally.
	 *
	 * A row is touched only when all of this holds, each fact read again under the row's lifecycle:
	 * - it records a host, and this window does not own it (`ownedHere`) nor launch, restore or drive it;
	 * - its claim is absent or its holder is *provably* gone ({@link claimHolderProvablyGone}), so a window that holds the
	 *   row, launches it or attaches to it, whichever window it is, is left alone;
	 * - the reconciler proves the exact recorded process gone (`recorded-broker-and-child-gone`, or the broker's own report
	 *   that the child exited), validated against the row like a relaunch is;
	 * - this window then takes the claim (a window that acquires it meanwhile makes this pass step back) and the host is
	 *   cleared with a write that is refused when the committed row no longer records that same process, so a replacement
	 *   another window published is never cleared.
	 *
	 * Afterwards every claim file whose holder is provably gone and which no row names is deleted.
	 */
	async sweepGoneRecords(options: GoneRecordSweepOptions): Promise<GoneRecordSweepReport> {
		const cleared: string[] = [];
		for (const tabId of this.list().map(entry => entry.tabId)) {
			const row = this.#entries.get(tabId);
			if (row === undefined || row.host === null || options.ownedHere(tabId) || this.#drivesRow(tabId)) continue;
			const done = await this.withinTabLifecycle(tabId, undefined, async () => await this.#clearGoneHostHeld(tabId, options));
			if (done) cleared.push(tabId);
		}
		return { cleared, orphanClaims: await this.#removeOrphanClaims() };
	}

	/** Whether this window runs, launches or restores the row: the states in which another operation owns its record. */
	#drivesRow(tabId: string): boolean {
		return this.#live.has(tabId) || this.#restoring.has(tabId) || this.#launching.has(tabId);
	}

	/** One row's cleared host; the caller holds the row's lifecycle. `false` when the row is not this pass's to settle. */
	async #clearGoneHostHeld(tabId: string, options: GoneRecordSweepOptions): Promise<boolean> {
		const entry = this.#entries.get(tabId);
		if (entry === undefined || entry.host === null || options.ownedHere(tabId) || this.#drivesRow(tabId)) return false;
		const recorded: CapturedHostRecord = { startedAt: entry.host.startedAt, pid: entry.host.pid, rpc: entry.host.rpc === undefined || entry.host.rpc === null ? null : { ...entry.host.rpc } };
		const identity = entry.sessionFile ?? entry.ownership?.draftIdentity ?? null;
		if (identity === null) return false;
		const observed = await this.#readClaim(identity);
		if (!observed.ok) return false;
		if (observed.claim !== null && !(await claimHolderProvablyGone(observed.claim))) return false;
		const verdict = await this.#reconcile(entry, observed.claim, options.reconciler);
		if (verdict.kind !== "free" || !verdict.evidence.some(item =>
			(item.kind === "recorded-broker-and-child-gone" || item.kind === "broker-child-exited") && acceptOwnerAbsenceEvidence(toEntry(entry), item))) return false;
		// The proof took awaits: the row, and what this window does with it, are read again before anything is written.
		const current = this.#entries.get(tabId);
		if (current === undefined || !sameHostIncarnation(current.host, recorded) || options.ownedHere(tabId) || this.#drivesRow(tabId)) return false;
		let claim: SessionClaim;
		try {
			claim = await acquireClaim(this.#claimStorageDir, identity, current.ownership?.ownerGeneration ?? createOwnerGeneration(), await this.#claimHolderReady);
		} catch (error) {
			if (!(error instanceof ClaimConflictError)) this.#log?.warn(`gone-record sweep: the claim of ${tabId} could not be taken: ${describeError(error)}`);
			return false;
		}
		const failure = await this.#persistNow(undefined, undefined, {
			tabId,
			matches: host => sameHostIncarnation(host, recorded),
			apply: row => { row.host = null; },
			publish: () => {
				const row = this.#entries.get(tabId);
				if (row === undefined || !sameHostIncarnation(row.host, recorded)) return;
				row.host = null;
				row.availability = row.sessionFile === null ? "draft" : "saved";
				row.detail = "The process this session recorded has ended. Resume to continue.";
			},
		});
		await this.#releaseQuietly(claim);
		if (failure === HOST_CHANGED) {
			await this.refreshFromStore().catch(() => undefined);
			return false;
		}
		return failure === null;
	}

	/** Delete every claim file whose holder is provably gone and which no row, here or in the committed record, names. */
	async #removeOrphanClaims(): Promise<number> {
		const named = new Set<string>();
		const name = (identity: string | null | undefined): void => {
			if (typeof identity !== "string" || identity.length === 0) return;
			try {
				named.add(claimPathFor(this.#claimStorageDir, identity));
			} catch {
				// An identity that cannot name a claim names none.
			}
		};
		const committed = this.#store.get<unknown>(SESSION_INDEX_STORAGE_KEY);
		for (const row of [...this.#entries.values(), ...(isPersistedSnapshot(committed) ? committed.entries : [])]) {
			name(row.sessionFile);
			name(row.ownership?.draftIdentity);
		}
		let removed = 0;
		for (const claim of await listClaims(this.#claimStorageDir)) {
			if (named.has(claim.claimPath) || !(await claimHolderProvablyGone(claim))) continue;
			if (await removeClaimOfGoneHolder(claim)) removed++;
		}
		return removed;
	}

	/**
	 * Serialize one tab's restore, then open it.
	 *
	 * A duplicated UI event or a second activation pass must not adopt the same
	 * claim twice and start two hosts for one tab, so a tab that is already being
	 * restored here is reported as a conflict instead — and that reservation is
	 * taken *before* the tab's lifecycle gate, so the second caller still gets the
	 * refusal rather than queueing and running a whole second restore.
	 *
	 * Once admitted, the row is re-read by id and the restore proceeds with the row
	 * the index holds now: a catalog refresh may have replaced the object of a tab that
	 * was queued, and that is the same tab. Only a row the index no longer names is
	 * refused: the gate may have been held by a removal, and opening a detached entry
	 * would start a host and publish a live record for a tab the index no longer has.
	 */
	async #restoreEntry(
		entry: MutableEntry,
		options: RestoreOptions,
		takenIdentities: Map<string, string>,
		draftIntent: DraftRestoreIntent,
		trace?: RestoreTrace,
	): Promise<RestoreOutcome> {
		const tabId = entry.tabId;
		if (this.#restoring.has(tabId)) {
			return {
				status: "conflict",
				tabId,
				kind: "duplicate",
				detail: "This tab is already being restored in this window; a second host is never started.",
			};
		}
		this.#restoring.add(tabId);
		try {
			return await this.withinTabLifecycle(tabId, undefined, async () => {
				// The row is looked up again: a catalog refresh replaces the row object of a tab that was queued but not yet running,
				// and that is still the same tab. Only a tab the index no longer names is refused.
				const current = this.#entries.get(tabId);
				if (current === undefined) {
					return {
						status: "failed",
						tabId,
						kind: "index-error",
						detail: "This tab was removed from the session index before its host could be started.",
					};
				}
				return await this.#openEntry(current, options, takenIdentities, draftIntent, trace);
			});
		} finally {
			this.#restoring.delete(tabId);
		}
	}

	/** Open one tab's host; the caller has already excluded live and re-entrant tabs. */
	async #openEntry(
		entry: MutableEntry,
		options: RestoreOptions,
		takenIdentities: Map<string, string>,
		draftIntent: DraftRestoreIntent,
		trace?: RestoreTrace,
	): Promise<RestoreOutcome> {
		const tabId = entry.tabId;
		// A runtime this window drives is already open here. A record retained from a
		// close this window could not confirm is *not*: its runtime is gone, so the row
		// is reported through the stopped path below and its intent is never flipped
		// back to running by a restore that adopted nothing.
		if (this.#drivesHost(tabId)) {
			trace?.turn.release();
			entry.runIntent = "running";
			await this.#touch(entry, "live", "This window is already running the native host for this tab.");
			await this.#persist(trace);
			return { status: "attached", tabId, sessionFile: entry.sessionFile, detail: "Already open in this window." };
		}
		// The user's own stop intent is an admission rule, not a hint. A pass that
		// may not resume this row starts nothing and adopts nothing for it, and it
		// takes no claim while deciding: only an explicit Open/Resume
		// (`resumeStopped`) may, because opening a stopped row is exactly that.
		if (entry.runIntent === "stopped" && options.resumeStopped !== true) {
			trace?.turn.release();
			return await this.#reportStoppedEntry(entry, options.reconciler, trace);
		}
		// A row that is still fileless when it is admitted may only be reattached to
		// the host this index recorded; starting one stays an explicit action. A row
		// that gained its session file before admission — a promotion that reached
		// it first — is opened as usual.
		if (draftIntent === "reattach" && entry.sessionFile === null) {
			return await this.#reattachDraft(entry, options, takenIdentities, trace);
		}

		try {
			// A materialized session must still exist before anything is claimed.
			if (entry.sessionFile !== null && !(await this.#admit(trace, "session file", () => fileExists(entry.sessionFile!)))) {
				const detail = `The recorded session file is missing: ${entry.sessionFile}`;
				await this.#touch(entry, "failed", detail);
				await this.#persist(trace);
				return { status: "failed", tabId, kind: "missing-file", detail };
			}
			// A row whose recorded directory is not absolute is refused here, before
			// any claim is taken or attempt recorded: launching it would have to
			// guess a folder. Only the session file's own header may repair it.
			const cwdRefusal = await this.#admit(trace, "workspace directory", () => this.#workspaceDirectoryRefusal(entry));
			if (cwdRefusal !== null) {
				await this.#touch(entry, "failed", cwdRefusal);
				await this.#persist(trace);
				return { status: "failed", tabId, kind: "ambiguous-cwd", detail: cwdRefusal };
			}
			// Every claimed tab needs an owner generation, and it must be on disk
			// before the claim is taken: a claim is only ever re-adopted by the
			// generation that filed it, so a window that died between taking a claim
			// and recording the generation it used would leave an identity no later
			// window could recognise as its own. A draft (`createDraft`) and an
			// imported row (`trackSession`) both mint one when they are created,
			// which leaves exactly the rows an earlier version persisted without a
			// generation — those get one here, before their first claim.
			if (entry.ownership === null) {
				entry.ownership = {
					ownerGeneration: createOwnerGeneration(),
					draftIdentity: null,
					releasedAt: null,
				};
				await this.#persist();
			}
			// A draft always owns a reserved identity to claim.
			if (entry.sessionFile === null && entry.ownership.draftIdentity == null) {
				entry.ownership = {
					ownerGeneration: entry.ownership?.ownerGeneration ?? createOwnerGeneration(),
					draftIdentity: createDraftIdentity(),
					releasedAt: entry.ownership?.releasedAt ?? null,
				};
			}
			const target = entry.sessionFile ?? entry.ownership?.draftIdentity ?? null;
			if (target === null) {
				const detail = "The tab has no session file and no reserved draft identity.";
				await this.#touch(entry, "failed", detail);
				await this.#persist(trace);
				return { status: "failed", tabId, kind: "index-error", detail };
			}

			// One writable session per pass: a second tab for the same session is
			// a conflict, never a second writer.
			const key = normalizeSessionIdentityKey(target);
			// Rows that name this identity pass this check one after another in cohort order, so the
			// first row of the cohort to reach it is the one that keeps it, as in a sequential pass.
			await this.#admit(trace, "identity turn", async () => { await trace?.turn.wait(); });
			const ownerTab = takenIdentities.get(key);
			if (ownerTab !== undefined) {
				trace?.turn.release();
				return {
					status: "conflict",
					tabId,
					kind: "duplicate",
					detail: "This session is already open in another editor. Continue there.",
				};
			}
			takenIdentities.set(key, tabId);
			trace?.turn.release();

			const observed = await this.#admit(trace, "claim read", () => this.#readClaim(target));
			const claimBefore = observed.ok ? observed.claim : null;
			const generation = entry.ownership?.ownerGeneration ?? createOwnerGeneration();
			const heldBefore = claimBefore !== null;
			if (claimBefore !== null && claimBefore.holderId !== this.#claimHolder.id && await this.#admit(trace, "claim holder alive", () => claimHolderMayBeAlive(claimBefore))) {
				const detail = "This session is open in another window. Continue there.";
				await this.#touch(entry, "live", detail);
				await this.#persist(trace);
				return { status: "conflict", tabId, kind: "claim-conflict", detail };
			}

			// Take the atomic claim for the exact identity before anything starts.
			let claim: SessionClaim;
			try {
				// Retry only admission before any launcher call; never replay a restore
				// after it may have started a writer.
				const holder = await this.#admit(trace, "claim holder", () => this.#claimHolderReady);
				claim = await this.#admit(trace, "claim take", () => retryFileOperation(
					() => acquireClaim(this.#claimStorageDir, target, generation, holder),
					FILE_OPERATION_BACKOFF_MS.slice(0, 2),
				));
			} catch (error) {
				if (error instanceof ClaimConflictError) {
					const detail = "This session is open in another window. Continue there.";
					await this.#touch(entry, "live", detail);
					await this.#persist(trace);
					return { status: "conflict", tabId, kind: "claim-conflict", detail };
				}
				const detail = describeError(error);
				await this.#touch(entry, "failed", detail);
				await this.#persist(trace);
				return { status: "failed", tabId, kind: "claim-error", detail };
			}

			// Record the generation that holds the claim before anything can fail
			// (every later path must be able to adopt exactly this claim again),
			// but keep any earlier release proof intact: reconciliation is asked
			// to confirm it, and only a host that actually started — or may have
			// started — invalidates it.
			entry.ownership = {
				ownerGeneration: claim.ownerGeneration,
				draftIdentity: entry.ownership?.draftIdentity ?? null,
				releasedAt: entry.ownership?.releasedAt ?? null,
			};

			if (options.signal?.aborted === true) {
				const release = await this.#releaseQuietly(claim);
				return {
					status: "skipped",
					tabId,
					detail: withReleaseNotice("Restore was cancelled before the host was started.", release),
				};
			}

			let step: LaunchStep;
			/** The record the row carried before this attempt; restored when nothing started. */
			let previousHost: RecordedHost | null = null;
			let previousSessionId: string | null = null;
			let previousIntent: RunIntent = entry.runIntent;
			try {
				// Reconcile external ownership while the claim is held: only `free`
				// may start a process, only `attachable` may reconnect to the host
				// this index recorded, and everything else stays a conflict.
				const verdict = await this.#timed(trace, "reconcile", steps => this.#reconcile(entry, claimBefore, options.reconciler, steps));
				const classification = classifySessionAvailability({
					entry: toEntry(entry),
					fileExists: entry.sessionFile !== null,
					claim: claimBefore,
					localLive: false,
					verdict,
				});
				if (classification.availability === "live") {
					const availability = classification.availability;
					const attachable = classification.attachableHost;
					const pin = classification.attachPin;
					const recorded = entry.host;
					// A verified live host this index still owns may be reattached
					// instead of reported as a conflict: the user asked for
					// recovery and same-process switching, and attaching never
					// starts a second writer. The verdict's own transport is what
					// the attach re-proves; without one (which cannot happen for an
					// attachable verdict) the row stays a conflict rather than
					// falling through to a launch.
					if (attachable !== null && recorded !== null && pin !== null) {
						const attached = await this.#attach(entry, claim, options.launcher, recorded, pin, trace);
						if (attached.kind === "attached") {
							const handle = attached.handle;
							this.#live.set(tabId, { claim, host: handle, sessionFile: entry.sessionFile, driven: true });
							// A live host is attached, so an earlier release is no
							// longer proof of anything.
							this.#dropReleaseProof(entry);
							entry.home = this.#windowUri();
							if (entry.sessionFile === null) entry.sessionId = handle.sessionId ?? attachable.sessionId ?? entry.sessionId;
							entry.host = {
								pid: handle.pid ?? attachable.pid,
								instanceId: null,
								generation: null,
								sessionId: handle.sessionId ?? attachable.sessionId ?? recorded.sessionId,
								startedAt: recorded.startedAt,
								transport: handle.transport ?? recorded.transport ?? "rpc",
								rpc: handle.rpc ?? attachable.rpc,
							};
							entry.runIntent = "running";
							await this.#touch(entry, "live", classification.detail);
							await this.#persist(trace);
							return { status: "attached", tabId, sessionFile: entry.sessionFile, detail: classification.detail };
						}
						await this.#releaseQuietly(claim);
						const current = await this.#timed(trace, "reconcile", steps => this.#reconcile(entry, null, options.reconciler, steps));
						const stillOwned = current.kind === "live" || current.kind === "attachable";
						const detail = `Reattaching failed: ${attached.reason}`;
						await this.#touch(entry, stillOwned ? "live" : "saved", detail);
						await this.#persist(trace);
						return stillOwned ? { status: "conflict", tabId, kind: "live", detail } : { status: "failed", tabId, kind: "launch-failed", detail };
					}
					// A claim that was already held (ours, from an earlier window)
					// may be guarding a live process: keep it. A claim this check
					// created itself guarded nothing, so it is given back.
					let detail: string;
					if (heldBefore) {
						// Holding the identity means the earlier release proves
						// nothing about the writer that may be alive now.
						this.#dropReleaseProof(entry);
						detail = `${classification.detail} Reopen its current editor before trying again.`;
					} else {
						detail = withReleaseNotice(classification.detail, await this.#releaseQuietly(claim));
					}
					await this.#touch(entry, availability, detail);
					await this.#persist(trace);
					return { status: "conflict", tabId, kind: availability, detail };
				}
				if (options.automatic === true && classification.evidence.every(item => !acceptOwnerAbsenceEvidence(toEntry(entry), item))) {
					await this.#releaseQuietly(claim);
					await this.#touch(entry, entry.sessionFile === null ? "draft" : "saved", "This session is not running here. Resume to continue.");
					await this.#persist(trace);
					return { status: "stopped", tabId, detail: entry.detail ?? "" };
				}
				// Persist the attempt before launch so reload and automatic recovery
				// retain its provenance. An unresolved outcome is not ownership and
				// never vetoes the user's next explicit action. The attempt carries the
				// intent to run too (this pass only gets here for a row that may run, or
				// that the user explicitly opened): a window that ends between starting
				// the broker and reading its outcome leaves a row the next window's
				// restore re-adopts through the slot the launch reserved, instead of one
				// that reads as a deliberate stop beside a running writer.
				previousHost = entry.host;
				previousSessionId = entry.sessionId;
				previousIntent = entry.runIntent;
				// Without a file this is a genuinely new conversation, not a resume
				// of the old draft host's identity. Keep existing-file IDs pinned.
				if (entry.sessionFile === null) entry.sessionId = null;
				this.#launching.add(tabId);
				entry.runIntent = "running";
				entry.host = {
					pid: null,
					instanceId: null,
					generation: null,
					sessionId: entry.sessionId,
					startedAt: this.#timestamp(),
					transport: options.mode === "terminal" ? "native" : options.mode === "chat" ? "rpc" : previousHost?.transport ?? "rpc",
					rpc: null,
				};
				if (options.editorSlotId !== undefined && options.mode !== undefined) {
					const binding = this.#bindings.get(options.editorSlotId);
					if (binding !== undefined) this.#bindings.set(binding.slotId, { ...binding, mode: options.mode });
				}
				const recordFailure = await this.#persistNow();
				if (recordFailure !== null) {
					// The attempt could not be recorded, so it must not happen: an
					// unrecorded attempt is indistinguishable from one that started.
					entry.host = previousHost;
					entry.sessionId = previousSessionId;
					entry.runIntent = previousIntent;
					const release = heldBefore ? null : await this.#releaseQuietly(claim);
					const detail = withReleaseNotice(
						`The launch attempt could not be recorded (${recordFailure}), so no native host was started.`,
						release,
					);
					await this.#touch(entry, "failed", detail);
					await this.#persist(trace);
					return { status: "failed", tabId, kind: "index-error", detail };
				}
				step = await this.#launch(entry, claim, options.launcher, trace);
			} catch (error) {
				// Nothing was started: reconciliation or classification failed
				// before the launch, so the identity goes back.
				await this.#releaseQuietly(claim);
				throw error;
			}

			if (step.kind === "failed") {
				const release = await this.#releaseQuietly(claim);
				// The integration confirmed nothing started, so the attempt stops
				// standing for a launch that may exist and the row goes back to the
				// record it carried before the attempt.
				entry.host = previousHost;
				entry.sessionId = previousSessionId;
				entry.runIntent = previousIntent;
				const detail = withReleaseNotice(step.detail, release);
				await this.#touch(entry, "failed", detail);
				await this.#persist(trace);
				return { status: "failed", tabId, kind: "launch-failed", detail };
			}
			if (step.kind === "unconfirmed") {
				await this.#releaseQuietly(claim);
				this.#dropReleaseProof(entry);
				entry.runIntent = "stopped";
				await this.#touch(entry, entry.sessionFile === null ? "draft" : "saved", step.detail);
				await this.#persist(trace);
				return { status: "failed", tabId, kind: "launch-failed", detail: step.detail };
			}

			this.#live.set(tabId, { claim, host: step.handle, sessionFile: entry.sessionFile, driven: true });
			if (entry.sessionFile === null) entry.sessionId = step.handle.sessionId ?? entry.sessionId;
			// A host is now running, so the previous release stops being an
			// authorization for this row.
			this.#dropReleaseProof(entry);
			entry.home = this.#windowUri();
			entry.host = {
				pid: step.handle.pid,
				instanceId: null,
				generation: null,
				sessionId: step.handle.sessionId ?? entry.host?.sessionId ?? entry.sessionId,
				startedAt: this.#timestamp(),
				transport: step.handle.transport ?? entry.host?.transport ?? "rpc",
				rpc: step.handle.rpc,
			};
			entry.runIntent = "running";
			await this.#touch(entry, "live", "Native host launched from the indexed session.");
			await this.#persist(trace);
			return { status: "restored", tabId, sessionFile: entry.sessionFile, host: step.handle };
		} catch (error) {
			const detail = describeError(error);
			await this.#touch(entry, "failed", detail);
			await this.#persist(trace);
			return { status: "failed", tabId, kind: "index-error", detail };
		} finally {
			this.#launching.delete(tabId);
		}
	}

	/**
	 * Report one row the user stopped, without starting or adopting anything.
	 *
	 * The row's availability is re-derived from current facts exactly as an open
	 * would derive it — the same claim observation, the same reconciler and the same
	 * classification — but nothing is acquired, adopted or launched, and the durable
	 * intent stays `stopped`. That is what keeps a restart from silently undoing the
	 * user's decision while still telling the truth about the row: a stopped row
	 * whose writer is alive reports `live` (Resume is what adopts it), an uncertain
	 * earlier stop stays visibly held, a file that disappeared is reported missing,
	 * and a row whose writer is provably gone simply stays stopped.
	 *
	 * `lastActiveAt` is deliberately not touched: re-deriving a row's state is not
	 * the user being active in it, so a restart cannot move the recovered focus.
	 */
	async #reportStoppedEntry(entry: MutableEntry, reconciler: OwnerReconciler, trace?: RestoreTrace): Promise<RestoreOutcome> {
		const tabId = entry.tabId;
		const target = entry.sessionFile ?? entry.ownership?.draftIdentity ?? null;
		const observed = target === null ? { ok: true as const, claim: null } : await this.#readClaim(target);
		const claim = observed.ok ? observed.claim : null;
		const verdict = observed.ok
			? await this.#timed(trace, "reconcile", steps => this.#reconcile(entry, claim, reconciler, steps))
			: { kind: "unknown" as const, detail: observed.detail };
		const classification = classifySessionAvailability({
			entry: toEntry(entry),
			fileExists: entry.sessionFile !== null && (await fileExists(entry.sessionFile)),
			claim,
			localLive: false,
			verdict,
		});
		const stored = classification.availability;
		const detail =
			stored === "failed" || stored === "live"
				? classification.detail
				: "This session is stopped. Resume to continue.";
		// A restart re-derives every stopped row, so a row this pass did not change is
		// not rewritten.
		const changed = entry.availability !== stored || entry.detail !== detail;
		entry.availability = stored;
		entry.detail = detail;
		if (changed) await this.#persist(trace);
		switch (stored) {
			case "live":
				return { status: "conflict", tabId, kind: "live", detail };
			case "failed":
				return { status: "failed", tabId, kind: "missing-file", detail };
			case "draft":
				// A fileless row starts nothing in this pass either way, so it keeps the
				// draft presentation an explicit open may turn into a host — but it is
				// *this* pass that must not adopt a surviving writer for it, which is why
				// the stopped row never reaches the reattach path.
				return { status: "draft", tabId, detail };
			default:
				return { status: "stopped", tabId, detail };
		}
	}

	/**
	 * Reattach a fileless draft tab to the host this index recorded for it.
	 *
	 * A reload leaves a draft's durable row and its reserved claim behind while the
	 * native process that row launched keeps running, so the only operation allowed
	 * here is attachment: nothing is ever started. The row must record a launch and
	 * a reserved identity, and the deferred classification must name exactly that
	 * recorded host as attachable. Only then is the reserved identity's claim taken
	 * for this window's holder lease and the recorded process attached.
	 *
	 * A refusal before the claim step takes no claim and leaves the row untouched
	 * except for diagnostics: a draft nobody can verify must not become a new
	 * process. A failed claim or a failed attach is recorded as a conflict or a
	 * failure, and a failed attach releases the claim again. A row that recorded no
	 * launch of ours has nothing to attach and stays the draft only an explicit
	 * open may start.
	 */
	async #reattachDraft(
		entry: MutableEntry,
		options: RestoreOptions,
		takenIdentities: Map<string, string>,
		trace?: RestoreTrace,
	): Promise<RestoreOutcome> {
		const tabId = entry.tabId;
		const recorded = entry.host;
		const ownership = entry.ownership;
		const identity = ownership?.draftIdentity ?? null;
		if (recorded === null || ownership === null || identity === null) {
			// Nothing to adopt, so nothing is read, claimed, started or written: the
			// row keeps the availability the deferred pass derived for it.
			return {
				status: "draft",
				tabId,
				detail:
					"This new session is not running. Resume to start chatting.",
			};
		}
		// The launch this row recorded is compared against a directory, so a value
		// that is not absolute would have to be guessed: the same refusal the
		// explicit open applies, applied before anything is read or claimed.
		const cwdRefusal = await this.#workspaceDirectoryRefusal(entry);
		if (cwdRefusal !== null) {
			await this.#touch(entry, "failed", cwdRefusal);
			await this.#persist(trace);
			return { status: "failed", tabId, kind: "ambiguous-cwd", detail: cwdRefusal };
		}
		const observed = await this.#readClaim(identity);
		const verdict = await this.#timed(trace, "reconcile", steps => this.#reconcile(entry, observed.ok ? observed.claim : null, options.reconciler, steps));
		const classification = classifySessionAvailability({
			entry: toEntry(entry),
			fileExists: false,
			claim: observed.ok ? observed.claim : null,
			localLive: false,
			verdict,
		});
		const attachable = classification.attachableHost;
		const attachPin = classification.attachPin;
		if (attachable === null || attachPin === null) {
			// Nothing may be started here, and nothing about the row changes: the
			// deferred pass already recorded this classification, and this pass holds
			// no claim, so it reports its answer without rewriting the row.
			if (classification.availability === "draft") {
				return { status: "draft", tabId, detail: classification.detail };
			}
			return {
				status: "conflict",
				tabId,
				kind: "live",
				detail: classification.detail,
			};
		}
		// One writable identity per pass, exactly as the materialized path enforces:
		// two rows claiming one reserved identity would share one claim handle, and
		// releasing it from either row would strand the other's live record.
		const key = normalizeSessionIdentityKey(identity);
		await trace?.turn.wait();
		const ownerTab = takenIdentities.get(key);
		if (ownerTab !== undefined) {
			trace?.turn.release();
			const detail =
				"This session is already open in another editor. Continue there.";
			await this.#touch(entry, entry.sessionFile === null ? "draft" : "saved", detail);
			await this.#persist(trace);
			return { status: "conflict", tabId, kind: "duplicate", detail };
		}
		takenIdentities.set(key, tabId);
		trace?.turn.release();
		// The classification above is authority only for the claim it was computed
		// from. The holder lease is what keeps two windows from holding one
		// session, so it is taken for that exact reserved identity before anything
		// native is touched; a live rival holder makes the acquisition fail.
		let claim: SessionClaim;
		try {
			claim = await acquireClaim(this.#claimStorageDir, identity, ownership.ownerGeneration, await this.#claimHolderReady);
		} catch (error) {
			const conflict = error instanceof ClaimConflictError;
			const detail = conflict
				? "This new session is open in another window. Continue there."
				: describeError(error);
			await this.#touch(entry, "live", detail);
			await this.#persist(trace);
			return { status: "conflict", tabId, kind: "claim-conflict", detail };
		}
		const attached = await this.#attach(entry, claim, options.launcher, recorded, attachPin, trace);
		if (attached.kind !== "attached") {
			await this.#releaseQuietly(claim);
			const current = await this.#timed(trace, "reconcile", steps => this.#reconcile(entry, null, options.reconciler, steps));
			const stillOwned = current.kind === "live" || current.kind === "attachable";
			const detail = `Reattaching failed: ${attached.reason}`;
			await this.#touch(entry, stillOwned ? "live" : "draft", detail);
			await this.#persist(trace);
			return stillOwned ? { status: "conflict", tabId, kind: "live", detail } : { status: "failed", tabId, kind: "launch-failed", detail };
		}
		const handle = attached.handle;
		// The row is still a draft: nothing is bound to a session file here, and the
		// host's own materialization promotes it when it writes one.
		this.#live.set(tabId, { claim, host: handle, sessionFile: null, driven: true });
		// A live host is attached, so an earlier release is no longer proof of anything.
		this.#dropReleaseProof(entry);
		entry.home = this.#windowUri();
		if (entry.sessionFile === null) entry.sessionId = handle.sessionId ?? attachable.sessionId ?? entry.sessionId;
		entry.host = {
			pid: handle.pid ?? attachable.pid,
			instanceId: null,
			generation: null,
			sessionId: handle.sessionId ?? attachable.sessionId ?? recorded.sessionId,
			startedAt: recorded.startedAt,
			transport: handle.transport ?? recorded.transport ?? "rpc",
			rpc: handle.rpc ?? attachable.rpc,
		};
		entry.runIntent = "running";
		await this.#touch(entry, "live", classification.detail);
		await this.#persist(trace);
		return { status: "attached", tabId, sessionFile: null, detail: classification.detail };
	}

	/**
	 * End this window's driven record under the tab gate. An unconfirmed stop
	 * releases the operation lease without asserting writer absence; later actions
	 * recheck ownership.
	 */
	async closeSession(
		tabId: string,
		options: CloseSessionOptions,
		lease?: TabLifecycleLease,
	): Promise<CloseSessionResult> {
		return await this.withinTabLifecycle(tabId, lease, async () => await this.#closeSessionHeld(tabId, options));
	}

	/** One close's body; the caller already holds the tab's lifecycle. */
	async #closeSessionHeld(tabId: string, options: CloseSessionOptions): Promise<CloseSessionResult> {
		const entry = this.#entries.get(tabId);
		if (entry === undefined) {
			return { released: false, detail: `No indexed tab ${tabId}.` };
		}
		if (!options.confirmedStopped) {
			const detail = options.detail ?? "The session could not be confirmed stopped. Refresh Sessions before resuming it.";
			const live = this.#live.get(tabId);
			if (live !== undefined) await this.#releaseQuietly(live.claim);
			this.#live.delete(tabId);
			if (options.runIntent !== "unchanged") entry.runIntent = "stopped";
			await this.#touch(entry, entry.sessionFile === null ? "draft" : "saved", detail);
			await this.#persist();
			return { released: live !== undefined, detail };
		}

		const live = this.#live.get(tabId);
		const target = entry.sessionFile ?? entry.ownership?.draftIdentity ?? null;
		if (target === null) {
			this.#live.delete(tabId);
			entry.host = null;
			if (options.runIntent !== "unchanged") entry.runIntent = "stopped";
			await this.#touch(entry, entry.sessionFile === null ? "draft" : "saved", options.detail);
			await this.#persist();
			return { released: false, detail: "This session could not finish closing. Refresh Sessions and try again." };
		}

		try {
			const claim = live?.claim ?? (await this.#adoptClaim(entry, target));
			await claim.release();
		} catch (error) {
			this.#log?.error(`session close claim release failed: ${describeError(error)}`);
			const detail = "This session could not finish closing. Refresh Sessions and try again.";
			await this.#touch(entry, entry.sessionFile === null ? "draft" : "saved", detail);
			await this.#persist();
			return { released: false, detail };
		}

		this.#live.delete(tabId);
		entry.host = null;
		// The explicit close is the durable run intent: a restarted extension host,
		// a reloaded window and a full VS Code restart must all keep seeing this row
		// as stopped until the user resumes it. A close that is not the user's stop
		// (`runIntent: "unchanged"`) leaves the recorded intent, and the clearing of
		// the host below is in the same persist as that decision.
		if (options.runIntent !== "unchanged") entry.runIntent = "stopped";
		if (entry.ownership !== null) {
			entry.ownership = {
				ownerGeneration: entry.ownership.ownerGeneration,
				draftIdentity: entry.ownership.draftIdentity,
				releasedAt: this.#timestamp(),
			};
		}
		const detail = options.detail ?? "This session is stopped. Resume to continue.";
		await this.#touch(entry, entry.sessionFile === null ? "draft" : "saved", detail);
		await this.#persist();
		// The write above applied the run state field by field to the newest committed row: a Stop or Kill another window recorded
		// meanwhile stands, and this window's copy follows it (a close that is not the user's stop never decides the intent).
		const settled = this.#persistError === null ? this.#adoptSettledRunState(entry) : null;
		return { released: true, detail, ...(settled === null ? {} : { runIntent: settled }) };
	}

	/**
	 * Make a row of this window follow the run state (intent, host, release) the catalog's merge settled for it after a write of
	 * this window's own landed, and move the merge base with it, so the next write does not read the adoption as this window's
	 * own change of the field. Only the fields that differ are touched. `null` when the committed row cannot be read.
	 */
	#adoptSettledRunState(entry: MutableEntry): RunIntent | null {
		const raw = this.#store.get<unknown>(SESSION_INDEX_STORAGE_KEY);
		if (raw === undefined || raw === null || !isPersistedSnapshot(raw)) return null;
		const committed = raw.entries.find(row => row.tabId === entry.tabId);
		if (committed === undefined) return null;
		const row = cloneSharedEntry(committed);
		if (sameRecord([entry.runIntent, entry.host, entry.ownership], [row.runIntent, row.host, row.ownership])) return row.runIntent;
		entry.runIntent = row.runIntent;
		entry.host = row.host;
		entry.ownership = row.ownership;
		const base = isPersistedSnapshot(this.#sharedBase) ? this.#sharedBase : null;
		if (base !== null) {
			this.#sharedBase = {
				...base,
				entries: base.entries.map(held => held.tabId === row.tabId ? { ...held, runIntent: row.runIntent, host: row.host === null ? null : { ...row.host }, ownership: row.ownership === null ? null : { ...row.ownership } } : held),
			} satisfies SharedSnapshot;
		}
		return row.runIntent;
	}

	/**
	 * The run intent the newest committed record holds for a row, read now: the catalog is re-read first, so a Stop or Kill another
	 * window committed a moment ago is seen before this window's own watch has adopted it. `null` when the row or the catalog
	 * cannot be read. It changes nothing; an exit that asks it decides what to say, never what to record.
	 */
	async committedRunIntent(tabId: string): Promise<RunIntent | null> {
		try {
			await this.#store.refresh?.();
		} catch {
			/* the last adopted value below is the best this window has */
		}
		return this.#committedRunIntentOf(tabId);
	}

	/**
	 * Give up the claim of a session this window drives without ending it (a handover, ADR-0080): the caller has already
	 * dropped its connection to the host, and the process, the recorded host and the run intent stay exactly as they are.
	 *
	 * Under the caller's own lease of the tab's gate (it never queues on a gate its caller holds) the live entry must be this
	 * window's driven runtime of exactly the incarnation `expected` names, and the row must still record `runIntent: running`
	 * and that host. The claim is then released and the live entry dropped. It writes **no** run intent, **no** recorded-host
	 * change and **no** `releasedAt`: a recorded release is absence evidence, and this host is not absent.
	 *
	 * `target-changed` ends with nothing released. A live entry of another incarnation is left alone; one of this incarnation
	 * whose row no longer matches (a stop or a Kill recorded meanwhile) is dropped without a release, because the caller no
	 * longer serves it and whoever recorded the row settles the claim. A release that fails leaves the claim held: the live
	 * entry is dropped all the same, so the state says "no runtime here" and an ordinary open adopts this window's own claim
	 * again; a claim another owner or holder already took is not this window's to release (`target-changed`).
	 */
	async detachLiveClaim(tabId: string, expected: DetachExpectation, lease: TabLifecycleLease): Promise<DetachLiveClaimResult> {
		return await this.withinTabLifecycle(tabId, lease, async () => {
			const entry = this.#entries.get(tabId);
			const live = this.#live.get(tabId);
			if (entry === undefined || live === undefined || !live.driven || !isDetachTarget(live.host.pid, live.host.rpc, expected)) return { status: "target-changed" };
			if (entry.runIntent !== "running" || entry.host === null || !isDetachTarget(entry.host.pid, entry.host.rpc ?? null, expected)) {
				this.#live.delete(tabId);
				return { status: "target-changed" };
			}
			try {
				await live.claim.release();
			} catch (error) {
				this.#live.delete(tabId);
				if (error instanceof ClaimOwnershipError || error instanceof ClaimHolderError) return { status: "target-changed" };
				this.#log?.error(`session detach claim release failed: ${describeError(error)}`);
				const observed = await this.#readClaim(live.claim.identity);
				// A claim that cannot be read is assumed still held: the caller must not say the session left this window.
				return { status: "claim-unreleased", stillHeld: !observed.ok || observed.claim?.holderId === this.#claimHolder.id };
			}
			this.#live.delete(tabId);
			return { status: "released" };
		});
	}

	/**
	 * Stop the exact recorded broker child after persisting stopped intent.
	 * Verified rival holders keep their claim; this window's temporary lease ends
	 * with the operation, including unknown outcomes. No PID signalling or
	 * transport fallback.
	 */
	async stopRecordedHost(
		tabId: string,
		options: StopRecordedHostOptions,
		lease?: TabLifecycleLease,
	): Promise<StopRecordedHostResult> {
		return await this.withinTabLifecycle(
			tabId,
			lease,
			async () => await this.#stopRecordedHostHeld(tabId, options),
		);
	}

	/** One explicit stop's body; the caller already holds the tab's lifecycle. */
	async #stopRecordedHostHeld(tabId: string, options: StopRecordedHostOptions): Promise<StopRecordedHostResult> {
		const refuse = (detail: string): StopRecordedHostResult => ({ stopped: false, detail, slot: null });
		const entry = this.#entries.get(tabId);
		if (entry === undefined) return refuse(`No indexed tab ${tabId}.`);
		// A runtime this window drives is stopped with Close, which owns the
		// confirmation of the stop proof. Retained bookkeeping from a close that
		// could not confirm its stop is not that runtime, and refusing on it would
		// leave the row this action exists for — a recorded broker-owned child
		// nothing else can reach — with no way to reach it. Every check below still
		// refuses a writer this window cannot account for.
		if (this.#drivesHost(tabId)) {
			return refuse("This window is running the native host for this tab; stop it with Close instead.");
		}
		if (entry.host === null) {
			return refuse(
				"This row recorded no launch attempt of this extension's, so no OMP process of it can be stopped from " +
					"here; nothing was stopped.",
			);
		}
		if (
			entry.host.startedAt !== options.expect.attemptStartedAt ||
			entry.host.pid !== options.expect.pid
		) {
			return refuse(
				"This row records a different launch attempt than the one that was confirmed, so nothing was stopped; " +
					"run the action again to confirm the attempt it records now.",
			);
		}
		const identity = entry.sessionFile ?? entry.ownership?.draftIdentity ?? null;
		if (identity === null) {
			return refuse(
				"This row recorded neither a session file nor a reserved identity, so its launch attempt cannot be " +
					"held and stopped; nothing was stopped.",
			);
		}
		const observed = await this.#readClaim(identity);
		if (!observed.ok) return refuse(`${observed.detail} Nothing was stopped.`);
		const claimBefore = observed.claim;
		const generation = entry.ownership?.ownerGeneration ?? createOwnerGeneration();
		const publishedTemporaryClaim = claimBefore === null;
		let claim: SessionClaim | null = null;
		try {
			if (claimBefore === null || claimBefore.holderId === this.#claimHolder.id || !(await claimHolderMayBeAlive(claimBefore))) {
				claim = await acquireClaim(this.#claimStorageDir, identity, generation, await this.#claimHolderReady);
			}
		} catch (error) {
			if (error instanceof ClaimConflictError) {
				return refuse("This session is open in another window. Nothing was stopped; try there.");
			}
			return refuse("This session could not be prepared to stop. Refresh Sessions and try again.");
		}
		// The durable intent goes first: whatever happens to the stop below, a reload can
		// never turn this explicit request into an automatic launch. It is conditional on the committed row still recording the
		// attempt that was confirmed, so a run another window replaced meanwhile is not recorded stopped.
		const previousIntent = entry.runIntent;
		const intentWrite = await this.#recordExpectedStop(tabId, { attemptStartedAt: options.expect.attemptStartedAt, pid: options.expect.pid });
		if (intentWrite.status === "failed") {
			if (publishedTemporaryClaim && claim !== null) await this.#releaseQuietly(claim);
			return refuse(`The stopped intent could not be recorded (${intentWrite.detail}), so nothing was stopped.`);
		}
		if (intentWrite.status === "target-changed") {
			if (publishedTemporaryClaim && claim !== null) await this.#releaseQuietly(claim);
			return refuse("This row records a different launch attempt than the one that was confirmed, so nothing was stopped; run the action again to confirm the attempt it records now.");
		}
		if (this.#persistError !== null) {
			const failure = this.#persistError;
			entry.runIntent = previousIntent;
			await this.#persist();
			if (publishedTemporaryClaim && claim !== null) await this.#releaseQuietly(claim);
			return refuse(`The stopped intent could not be recorded (${failure}), so nothing was stopped.`);
		}
		const attempt = await options.stop.stopRecordedHost(toEntry(entry));
		if (attempt.kind === "unknown") {
			if (claim !== null) await this.#releaseQuietly(claim);
			await this.#touch(entry, entry.sessionFile === null ? "draft" : "saved", attempt.detail);
			await this.#persist();
			return refuse(`${attempt.detail} Nothing was started.`);
		}
		if (!attempt.writerGone) {
			if (claim !== null) await this.#releaseQuietly(claim);
			await this.#touch(entry, entry.sessionFile === null ? "draft" : "saved", attempt.detail);
			await this.#persist();
			return {
				stopped: false,
				slot: attempt.slot,
				detail:
					`${attempt.detail} Nothing was started. Refresh Sessions to check whether it is still running.`,
			};
		}
		const held = claim === null ? null : await this.#releaseQuietly(claim);
		if (held !== null) {
			await this.#touch(entry, entry.sessionFile === null ? "draft" : "saved", held);
			await this.#persist();
			return { stopped: false, slot: attempt.slot, detail: `${attempt.detail} ${held}` };
		}
		this.#live.delete(tabId);
		entry.host = null;
		entry.runIntent = "stopped";
		if (entry.ownership !== null) {
			entry.ownership = {
				ownerGeneration: entry.ownership.ownerGeneration,
				draftIdentity: entry.ownership.draftIdentity,
				releasedAt: this.#timestamp(),
			};
		}
		await this.#touch(entry, entry.sessionFile === null ? "draft" : "saved", attempt.detail);
		await this.#persist();
		return { stopped: true, detail: attempt.detail, slot: attempt.slot };
	}

	/**
	 * Record the stopped intent of exactly the incarnation a Kill is about to end, before it is ended.
	 *
	 * The window that drives the session reads the end of its process as a crash and leaves a crash's run
	 * intent as recorded (the next startup relaunches it in its home window), so the user's decision to kill must already be on
	 * record when the process dies. `null` when the row records another process than the captured one (a newer
	 * launch is not what is being killed); otherwise the intent the row had, for {@link SessionIndex.setRunIntent}
	 * to put back if the kill then fails. Nothing else of the row changes: the host, the claim and the release
	 * are recorded by whoever proves the process gone.
	 */
	async recordKillIntent(tabId: string, captured: KilledHostCapture): Promise<{ readonly previous: RunIntent } | null> {
		return await this.withinTabLifecycle(tabId, undefined, async () => {
			const expect: RunIntentTarget = { attemptStartedAt: captured.attemptStartedAt, pid: captured.hostPid, broker: { slot: captured.slot, brokerId: captured.brokerId, brokerGeneration: captured.brokerGeneration } };
			const entry = this.#entries.get(tabId);
			if (entry === undefined || !runIntentTargetMatches(entry.host, expect)) return null;
			const previous = entry.runIntent;
			let recorded = await this.#recordExpectedStop(tabId, expect);
			// The one place a conditional intent is given up: the Kill goes ahead whether or not the catalog accepted the intent (the
			// process is ended either way, and an unrecorded Kill would restart the session), so when even the second conditional write
			// found the catalog unwritable the intent is this window's ordinary save, which the retry timer carries to the catalog.
			if (recorded.status === "failed") recorded = await this.recordRunIntent(tabId, "stopped");
			if (recorded.status === "failed") return { previous };
			return recorded.status === "recorded" ? { previous: recorded.previous } : null;
		});
	}

	/**
	 * Record a row stopped after its exact recorded process was proven gone *by someone else* (Kill).
	 *
	 * Unlike {@link SessionIndex.stopRecordedHost} this takes no rival-Stop exception and asks no broker: it
	 * applies only to the incarnation named by `captured`. Under the tab's gate it requires that this window
	 * does not drive the host, that the row still records that incarnation, and that no live rival window
	 * holds the claim; it then takes the claim (a rival that acquires meanwhile refuses it) and commits the
	 * stopped row with a conditional shared write that is refused when the *committed* row no longer records
	 * that incarnation, so a replacement launch another window published meanwhile is never recorded stopped.
	 */
	async reconcileKilledHost(tabId: string, captured: KilledHostCapture, lease?: TabLifecycleLease): Promise<KilledHostReconcileResult> {
		return await this.withinTabLifecycle(tabId, lease, async () => {
			const skipped = (why: "driven" | "changed" | "rival", detail: string): KilledHostReconcileResult => ({ kind: "skipped", why, detail });
			const entry = this.#entries.get(tabId);
			if (entry === undefined || entry.host === null) return skipped("changed", "The row records no process any more.");
			if (this.#drivesHost(tabId)) return skipped("driven", "This window drives the session; its own broker watch ends it.");
			const matches = (host: CapturedHostRecord | null): boolean => recordsCapturedHost(host, captured);
			if (!matches(entry.host)) return skipped("changed", "The row records another process than the one that was killed.");
			const identity = entry.sessionFile ?? entry.ownership?.draftIdentity ?? null;
			if (identity === null) return { kind: "failed", detail: "The row recorded neither a session file nor a reserved identity, so its record cannot be held." };
			const observed = await this.#readClaim(identity);
			if (!observed.ok) return { kind: "failed", detail: observed.detail };
			const claimBefore = observed.claim;
			if (claimBefore !== null && claimBefore.holderId !== this.#claimHolder.id && await claimHolderMayBeAlive(claimBefore)) {
				return skipped("rival", "Another live window holds the session; its own watch ends it.");
			}
			const generation = entry.ownership?.ownerGeneration ?? createOwnerGeneration();
			let claim: SessionClaim;
			try {
				claim = await acquireClaim(this.#claimStorageDir, identity, generation, await this.#claimHolderReady);
			} catch (error) {
				if (error instanceof ClaimConflictError) return skipped("rival", "Another window took the session meanwhile; its own watch ends it.");
				return { kind: "failed", detail: "The session could not be prepared to record as stopped." };
			}
			const stoppedAt = this.#timestamp();
			const detail = "This session's process was killed. Resume to continue.";
			const stop = (row: { host: unknown; runIntent: string; ownership: { ownerGeneration: string; draftIdentity: string | null; releasedAt: string | null } | null; lastActiveAt: string }): void => {
				row.runIntent = "stopped";
				row.host = null;
				if (row.ownership !== null) row.ownership = { ownerGeneration: row.ownership.ownerGeneration, draftIdentity: row.ownership.draftIdentity, releasedAt: stoppedAt };
				row.lastActiveAt = stoppedAt;
			};
			// Nothing of this window's own state changes until the conditional shared write lands (see `#persistNow`): an
			// unrelated save queued meanwhile can neither publish a tentative stopped row nor observe a refused one.
			const failure = await this.#persistNow(undefined, undefined, {
				tabId,
				matches,
				apply: row => stop(row),
				publish: () => {
					stop(entry);
					entry.availability = entry.sessionFile === null ? "draft" : "saved";
					entry.detail = detail;
					this.#live.delete(tabId);
				},
			});
			if (failure !== null) {
				await this.#releaseQuietly(claim);
				if (failure === HOST_CHANGED) {
					await this.refreshFromStore().catch(() => undefined);
					return skipped("changed", "Another window recorded a different process for this row meanwhile; nothing was recorded.");
				}
				return { kind: "failed", detail: failure };
			}
			const held = await this.#releaseQuietly(claim);
			if (held !== null) return { kind: "failed", detail: `The row was recorded as stopped, but its claim could not be released: ${held}` };
			return { kind: "recorded", slot: captured.slot, detail: "This session's process was killed. Resume to continue." };
		});
	}

	/** Forget metadata under the tab gate; only current positive ownership excludes it. */
	async remove(tabId: string, reconciler?: OwnerReconciler): Promise<RemoveResult> {
		return await this.withinTabLifecycle(tabId, undefined, async () => await this.#removeHeld(tabId, reconciler));
	}

	/** One removal's body; the caller already holds the tab's lifecycle. */
	async #removeHeld(tabId: string, reconciler?: OwnerReconciler): Promise<RemoveResult> {
		const entry = this.#entries.get(tabId);
		if (entry === undefined) {
			return { removed: false, detail: `No indexed tab ${tabId}.` };
		}
		if (this.#drivesHost(tabId)) {
			return { removed: false, detail: "This window is running the host for this tab; stop it first." };
		}
		const target = entry.sessionFile ?? entry.ownership?.draftIdentity ?? null;
		if (target !== null) {
			const observed = await this.#readClaim(target);
			const guard = await this.#claimGuardingRemoval(entry, observed.ok ? observed.claim : null);
			if (guard !== null) return { removed: false, detail: guard };
			if (reconciler !== undefined) {
				const verdict = await this.#reconcile(entry, observed.ok ? observed.claim : null, reconciler);
				if (verdict.kind === "live" || verdict.kind === "attachable") return { removed: false, detail: verdict.detail };
			}
		}
		this.#entries.delete(tabId);
		this.#dropBindingsOf(tabId);
		if (this.#activeTabId === tabId) this.#activeTabId = null;
		await this.#persist();
		return {
			removed: true,
			detail: "Removed from Sessions; its saved conversation was not changed.",
		};
	}

	/**
	 * The claim that must keep a row alive, in one sentence, or `null` when the
	 * row may be dropped.
	 *
	 * Only a live rival holder keeps a row: forgetting a row removes a launcher
	 * bookmark and touches neither the session file nor the claim. Two windows of
	 * one workspace share the owner generation, so only the holder lease names the
	 * other window. A host of this window was already refused before this check.
	 * Provenance is not consulted.
	 */
	async #claimGuardingRemoval(entry: MutableEntry, claim: ObservedClaim | null): Promise<string | null> {
		if (claim === null) return null;
		const rivalHolder =
			claim.holderId !== this.#claimHolder.id && await claimHolderMayBeAlive(claim);
		if (rivalHolder) {
			return "Another live window of this extension holds this session.";
		}
		return null;
	}

	/**
	 * Drop a tab whose transcript this extension has just deleted.
	 *
	 * This is not a variant of {@link SessionIndex.remove}: it exists for the one
	 * caller that has already proved no extension writer is alive and has removed
	 * the file itself (`src/host/session-lifecycle.ts`), and it re-checks the facts
	 * a row must never survive without. The exact confirmed path must still be the
	 * tab's own, the file must be gone (a transcript another process recreated, or
	 * one that was never removed, keeps the row), and no durable claim may be left
	 * by anyone but the deletion itself — `options.heldClaim` is exactly that
	 * deletion's claim, verified to be this window's own holder for this identity
	 * and still readable on disk, which is why the row may be finalized before the
	 * claim is released (ADR-0027).
	 *
	 * Provenance is deliberately not consulted: an imported row is finalized here
	 * like any other once its own transcript has been deleted by the user's
	 * explicit action.
	 *
	 * The drop runs with the tab's lifecycle held, and `lease` is the deletion
	 * operation's own lease when it already holds the gate — the native deletion
	 * and the row it leaves behind are one operation, not two that can be
	 * overtaken by a launch or a promotion in between.
	 */
	async dropDeletedSession(
		tabId: string,
		options: DropDeletedSessionOptions,
		lease?: TabLifecycleLease,
	): Promise<RemoveResult> {
		return await this.withinTabLifecycle(tabId, lease, async () => await this.#dropDeletedSessionHeld(tabId, options));
	}

	/** One deleted-row drop; the caller already holds the tab's lifecycle. */
	async #dropDeletedSessionHeld(tabId: string, options: DropDeletedSessionOptions): Promise<RemoveResult> {
		const entry = this.#entries.get(tabId);
		if (entry === undefined) return { removed: false, detail: `No indexed tab ${tabId}.` };
		if (this.#drivesHost(tabId)) {
			return { removed: false, detail: "This window is running the host for this tab; its row is kept." };
		}
		const file = entry.sessionFile;
		if (file === null) return { removed: false, detail: "The tab has no session file, so nothing was deleted for it." };
		if (normalizeSessionIdentityKey(file) !== normalizeSessionIdentityKey(options.sessionFile)) {
			return {
				removed: false,
				detail: `The tab is bound to ${file}, not to the deleted ${options.sessionFile}; its row is kept.`,
			};
		}
		if (await fileExists(file)) {
			return { removed: false, detail: `${file} still exists, so the row is kept.` };
		}
		const observed = await this.#readClaim(file);
		if (observed.ok && observed.claim !== null && await claimHolderMayBeAlive(observed.claim)) {
			const held = options.heldClaim;
			// A claim that is not the deletion's own keeps the row: it may belong to a
			// writer that is still alive.
			const ownedByDeletion =
				held !== undefined &&
				held.holder.id === this.#claimHolder.id &&
				normalizeSessionIdentityKey(held.identity) === normalizeSessionIdentityKey(file) &&
				observed.claim.ownerGeneration === held.ownerGeneration &&
				observed.claim.holderId === held.holder.id;
			if (!ownedByDeletion) {
				return {
					removed: false,
					detail: "This session is still open in another editor. Close it there before removing its row.",
				};
			}
		}
		this.#entries.delete(tabId);
		this.#dropBindingsOf(tabId);
		if (this.#activeTabId === tabId) this.#activeTabId = null;
		await this.#persist();
		return {
			removed: true,
			detail: options.detail ?? "Removed from the session index after its session file was deleted.",
		};
	}

	/**
	 * Observe the durable claim for one exact file, without a row.
	 *
	 * This is what an unindexed deletion needs: the same claim namespace, read by
	 * the same rules, so a file whose identity is already held is never treated as
	 * free merely because no row recorded it.
	 */
	async observeOwnershipOfFile(
		identity: string,
	): Promise<{ readonly ok: true; readonly claim: ObservedClaim | null } | { readonly ok: false; readonly detail: string }> {
		return await this.#readClaim(identity);
	}

	/**
	 * Run one operation with the local per-file lifecycle of `identity` held.
	 *
	 * The deletion transaction and the import of a discovered file both take this
	 * gate, so one window cannot adopt/import a file while it is being deleted, and
	 * a second deletion of the same file cannot interleave with the first. The key
	 * is the canonical identity, so two aliases of one file share one gate; it is
	 * deliberately *not* a claim, and it excludes nothing outside this window.
	 */
	async withinFileLifecycle<T>(identity: string, operation: (lease: TabLifecycleLease) => Promise<T>): Promise<T> {
		return await this.#lifecycle.run(fileLifecycleKey(identity), operation);
	}

	/**
	 * Observe the durable claim for one tab's own identity.
	 *
	 * The read is filed under this index's own claim directory, so a caller that
	 * must act on ownership (the deletion path, which takes the claim before it
	 * removes a file) cannot be pointed at a different claim namespace and mistake
	 * a held claim for a free one. `ok: false` means the directory itself could not
	 * be read, which is never evidence that the session is free.
	 */
	async observeOwnership(
		tabId: string,
	): Promise<{ readonly ok: true; readonly claim: ObservedClaim | null } | { readonly ok: false; readonly detail: string }> {
		const entry = this.#entries.get(tabId);
		if (entry === undefined) return { ok: false, detail: `No indexed tab ${tabId}.` };
		const target = entry.sessionFile ?? entry.ownership?.draftIdentity ?? null;
		if (target === null) return { ok: true, claim: null };
		return await this.#readClaim(target);
	}

	/** The claim namespace this index files and reads every claim under. */
	get claimStorageDir(): string {
		return this.#claimStorageDir;
	}

	/**
	 * This window's live holder lease, for comparing holder ids: it may still lack its process start
	 * time. Other modules that take a claim for a tab of this index (session deletion, rename) MUST
	 * use {@link claimHolderReady}, so they adopt this window's own claim instead of presenting
	 * themselves as a second holder, and file it with the start time.
	 */
	get claimHolder(): ClaimHolder {
		return this.#claimHolder;
	}

	/** The same lease once its process start time has been read (or the reading failed). */
	claimHolderReady(): Promise<ClaimHolder> {
		return this.#claimHolderReady;
	}

	/**
	 * This index's per-tab lifecycle gate: the same coordinator every lifecycle
	 * mutation of this index runs through.
	 *
	 * The extension host owns the facts the index cannot see — which
	 * `NativeHostRuntime` a tab runs, when a terminal close is admitted, and
	 * whether a draft's own host materialized a file — so it takes the gate for
	 * those operations with {@link TabLifecycle.run} and hands the lease it
	 * receives to the index method that mutates durable state. Reaching the same
	 * coordinator through the index is what keeps one gate per window instead of
	 * one per call site.
	 */
	get lifecycle(): TabLifecycle {
		return this.#lifecycle;
	}

	/**
	 * Run one tab's lifecycle operation, or join the lease its caller already holds.
	 *
	 * This is the one implementation of "hold this tab's lifecycle" for the index
	 * and for a module the index does not own (`src/host/session-lifecycle.ts`
	 * deletes a session's files as one such operation): `lease` is the caller's own
	 * lease for `tabId` when it already holds the gate, and `undefined` for every
	 * caller that must queue. A lease for another tab, or one this gate is not
	 * currently running, is a caller error and throws rather than silently running
	 * outside the exclusion.
	 *
	 * An operation passed here must never await work that itself needs `tabId`'s
	 * gate: an awaited callback is part of this operation, and work it waits for
	 * must not queue behind it. The extension host's launch and attach paths obey
	 * this by leaving the materialization watch detached — it acquires its own
	 * later lease — and by awaiting only ports that mutate no index state.
	 */
	async withinTabLifecycle<T>(
		tabId: string,
		lease: TabLifecycleLease | undefined,
		operation: (lease: TabLifecycleLease) => Promise<T>,
	): Promise<T> {
		if (lease === undefined) return await this.#lifecycle.run(tabId, operation);
		if (lease.tabId !== tabId || !this.#lifecycle.holds(lease)) {
			throw new SessionIndexError(
				"invalid-input",
				`A lifecycle lease for ${lease.tabId} cannot run an operation for tab ${tabId}.`,
			);
		}
		return await operation(lease);
	}

	// Run intent and conversation state

	/**
	 * Record the user's explicit run intent for a row.
	 *
	 * This is the durable half of "the user asked for this to run" / "the user
	 * closed it". It is separate from the observed availability, so a closed editor
	 * or a restarted extension host does not change it. An explicit close records
	 * `stopped`; a verified launch or attach records `running`.
	 *
	 * It is {@link SessionIndex.recordRunIntent} with no expected incarnation; it throws for an unknown tab.
	 */
	async setRunIntent(tabId: string, intent: RunIntent, detail?: string): Promise<SessionIndexEntry> {
		const entry = this.#entries.get(tabId);
		if (entry === undefined) throw new SessionIndexError("unknown-tab", `No indexed tab ${tabId}.`);
		await this.recordRunIntent(tabId, intent, { detail });
		return toEntry(entry);
	}

	/**
	 * The one place a row's durable run intent is decided and written (ADR-0034, amendment of 2026-10-21).
	 *
	 * The write names `intent` as this window's change of the field, so the catalog's merge applies it whatever another window
	 * recorded meanwhile; no other path writes the field except as an explicit consequence of a launch, an attach or a close
	 * that the same persist records together with the host (`mergeSessionIndexRecords` takes the field from the committed row
	 * for every write that does not change it). The merge cannot tell "this window changed the field to the value it already
	 * held" from "did not touch it", so the committed row is read back: a value other than `intent` means the merge kept
	 * another window's (this window's copy still held `intent` while the catalog moved on). This window then follows the
	 * committed row, which makes `intent` a change of the field, and writes once more.
	 *
	 * With `expect`, the write is conditional on the *committed* row: it lands only while the committed host is exactly the
	 * incarnation the caller examined, so a Stop or Kill that was decided against a run another window has since replaced
	 * records nothing (`target-changed`). Without it the intent is written as the caller's own decision.
	 *
	 * The caller holds the tab's lifecycle when it needs one (this method never queues on the gate).
	 */
	async recordRunIntent(tabId: string, intent: RunIntent, options: RecordRunIntentOptions = {}): Promise<RecordRunIntentResult> {
		const entry = this.#entries.get(tabId);
		if (entry === undefined) return { status: "unknown-tab" };
		const first = await this.#recordRunIntentOnce(entry, intent, options);
		if (first.status !== "recorded") return first;
		const committed = this.#committedRunIntentOf(tabId);
		if (committed === null || committed === intent) return first;
		this.#adoptSettledRunState(entry);
		const second = await this.#recordRunIntentOnce(entry, intent, options);
		return second.status === "recorded" ? { status: "recorded", previous: second.previous } : second;
	}

	/** The run intent of the row in the committed record as this window last read it; `null` when it cannot be read (nothing then contradicts a write). */
	#committedRunIntentOf(tabId: string): RunIntent | null {
		const raw = this.#store.get<unknown>(SESSION_INDEX_STORAGE_KEY);
		if (raw === undefined || raw === null || !isPersistedSnapshot(raw)) return null;
		return raw.entries.find(row => row.tabId === tabId)?.runIntent ?? null;
	}

	/** One write of {@link SessionIndex.recordRunIntent}: conditional on the committed row with `expect`, otherwise this window's ordinary save. */
	async #recordRunIntentOnce(entry: MutableEntry, intent: RunIntent, options: RecordRunIntentOptions): Promise<RecordRunIntentResult> {
		const target = options.expect;
		const matches = (host: CapturedHostRecord | null): boolean => target === undefined || runIntentTargetMatches(host, target);
		if (!matches(entry.host)) return { status: "target-changed" };
		const previous = entry.runIntent;
		if (target !== undefined && this.#store.transactRecords !== undefined) {
			// Conditional on the committed row: the tentative row exists only in the private snapshot until the write lands.
			if (previous === intent && options.detail === undefined) return { status: "recorded", previous };
			const failure = await this.#persistNow(undefined, undefined, {
				tabId: entry.tabId,
				matches,
				apply: row => { row.runIntent = intent; },
				publish: () => {
					entry.runIntent = intent;
					if (options.detail !== undefined) entry.detail = options.detail;
				},
			});
			if (failure === HOST_CHANGED) {
				await this.refreshFromStore().catch(() => undefined);
				return { status: "target-changed" };
			}
			if (failure !== null) return { status: "failed", detail: failure };
			return { status: "recorded", previous };
		}
		entry.runIntent = intent;
		if (options.detail !== undefined) entry.detail = options.detail;
		await this.#persist();
		return this.#persistError === null ? { status: "recorded", previous } : { status: "failed", detail: this.#persistError };
	}

	/** The conditional Stop of a recorded host: tried again once after re-reading the catalog when the first write could not land (the catalog was busy). */
	async #recordExpectedStop(tabId: string, expect: RunIntentTarget): Promise<RecordRunIntentResult> {
		const first = await this.recordRunIntent(tabId, "stopped", { expect });
		if (first.status !== "failed") return first;
		await this.#store.refresh?.().catch(() => undefined);
		return await this.recordRunIntent(tabId, "stopped", { expect });
	}

	/**
	 * Persist the conversation-scoped activity identities the guest reports.
	 *
	 * The two reply identities are what make "Answer Ready" a comparison rather
	 * than a flag: the row is unread while the last completed reply is not the last
	 * seen one. `title` caches OMP's stored title so a stopped row whose file is not
	 * readable yet still shows the title OMP last reported.
	 */
	async recordConversationState(
		tabId: string,
		update: {
			readonly title?: string | null;
			readonly lastCompletedReplyId?: string | null;
			readonly lastSeenReplyId?: string | null;
		},
	): Promise<SessionIndexEntry> {
		const entry = this.#entries.get(tabId);
		if (entry === undefined) throw new SessionIndexError("unknown-tab", `No indexed tab ${tabId}.`);
		if (update.title !== undefined) entry.title = update.title;
		if (update.lastCompletedReplyId !== undefined) entry.lastCompletedReplyId = update.lastCompletedReplyId;
		if (update.lastSeenReplyId !== undefined) entry.lastSeenReplyId = update.lastSeenReplyId;
		await this.#persist();
		return toEntry(entry);
	}

	/**
	 * Record the process-bound provider identity separately from the durable file identity.
	 * An authorized rotation commits only against the captured file, runtime and previous
	 * provider identity in the transaction. Only a committed identity is published locally.
	 */
	async recordHostSessionId(tabId: string, sessionId: string, lease?: TabLifecycleLease, previousSessionId?: string): Promise<boolean> {
		return await this.withinTabLifecycle(tabId, lease, async () => {
			const entry = this.#entries.get(tabId);
			if (entry === undefined || sessionId.length === 0) return false;
			const recorded = entry.host?.sessionId ?? entry.sessionId;
			if (recorded !== null && recorded !== sessionId && (previousSessionId === undefined || recorded !== previousSessionId || entry.host?.transport !== "rpc")) return false;
			if (entry.host?.sessionId === sessionId || (entry.host === null && entry.sessionId === sessionId)) return true;
			return await this.#persistNow(undefined, {
				before: sharedEntryOf(entry), sessionId,
				...(previousSessionId === undefined ? {} : { previousSessionId }),
			}) === null;
		});
	}

	// Editor slots

	/** The binding of one editor slot, or `null`. */
	slotBinding(slotId: string): EditorSlotBinding | null {
		const binding = this.#bindings.get(slotId);
		return binding === undefined ? null : cloneBinding(binding);
	}

	/** Every durable slot binding, in stable slot order. */
	slotBindings(): readonly EditorSlotBinding[] {
		return [...this.#bindings.values()]
			.sort((left, right) => (left.slotId < right.slotId ? -1 : left.slotId > right.slotId ? 1 : 0))
			.map(cloneBinding);
	}

	/** Every slot bound to a conversation, in stable slot order. */
	slotsForConversation(tabId: string): readonly EditorSlotBinding[] {
		return this.slotBindings().filter(binding => binding.tabId === tabId);
	}

	/**
	 * Publish one editor slot's binding to one conversation.
	 *
	 * This is the initial binding (a freshly opened editor, a serializer revival that
	 * resolved its conversation from the committed binding) and the explicit `passive`
	 * marking for a duplicate or conflicting editor: a second editor of the same
	 * conversation is kept as a non-controlling, draft-preserving surface, so its unsent
	 * text is not discarded and it can issue no native operation.
	 *
	 * ## Controller election
	 *
	 * A conversation has one controlling editor, and its commands, terminal input
	 * and Reload target that conversation's writer. Requesting `controlling` is
	 * refused — the binding is published `passive` with a `roleRefusal` — only
	 * when another live window verifiably holds the session's claim (ADR-0034,
	 * narrowed by ADR-0039). A refused editor demotes nobody, so a rival window
	 * restoring the same row cannot displace an incumbent. An unowned draft or
	 * stopped row may be controlled from this window. A granted `controlling`
	 * binding makes the conversation's other controlling slots passive.
	 *
	 * A published binding advances its slot's generation when the role or
	 * conversation changes, so a queued callback or page credential that still
	 * names the previous generation is fenced out rather than accepted by a slot
	 * that is no longer controlling.
	 *
	 * ## The election is durable before it is published
	 *
	 * A role this window cannot record durably is not a role it may act on: the commit is
	 * attempted, and when it fails the previous bindings (including any rival this bind
	 * would have demoted) are restored and the caller is told the role was not published.
	 * Nothing is left in memory that a restart could not see.
	 */
	bindEditorSlot(slotId: string, tabId: string, role: EditorSlotRole): Promise<EditorSlotBinding> {
		// Elections of one slot run one after another, in the order they were asked. An election judges its rival from a claim it
		// reads first, and reading it can take long (the start time of a foreign holder waits for the native module, a file call
		// waits behind the host's pool): a later election that finished meanwhile (the window took the session over) would
		// otherwise be overwritten by the earlier one's refusal, and the editor would stay read-only for good.
		const previous = this.#slotElections.get(slotId) ?? Promise.resolve();
		const run = previous.then(() => this.#bindEditorSlotNow(slotId, tabId, role));
		const tail = run.then(() => undefined, () => undefined);
		this.#slotElections.set(slotId, tail);
		void tail.then(() => {
			if (this.#slotElections.get(slotId) === tail) this.#slotElections.delete(slotId);
		});
		return run;
	}

	async #bindEditorSlotNow(slotId: string, tabId: string, role: EditorSlotRole): Promise<EditorSlotBinding> {
		if (slotId.trim().length === 0) throw new SessionIndexError("invalid-input", "bindEditorSlot requires a slot id");
		const entry = this.#entries.get(tabId);
		if (entry === undefined) throw new SessionIndexError("unknown-tab", `No indexed tab ${tabId}.`);
		const refusal = role === "controlling" ? await this.#controllerRefusal(entry) : null;
		const published: EditorSlotRole = refusal === null ? role : "passive";
		const existing = this.#bindings.get(slotId);
		const previous = new Map(this.#bindings);
		// The same conversation, role and refusal again is no change: the generation and `committedAt` stay as committed.
		const unchanged = existing !== undefined && existing.tabId === tabId && existing.role === published && existing.roleRefusal === refusal;
		const binding: EditorSlotBinding = unchanged ? existing : {
			slotId,
			tabId,
			generation: (existing?.generation ?? 0) + (existing?.tabId === tabId && existing.role === published ? 0 : 1),
			role: published,
			committedAt: this.#timestamp(),
			roleRefusal: refusal,
			mode: existing?.mode ?? "chat",
		};
		const demoted = this.#demoteRivalControllers(binding);
		if (unchanged && !demoted) return cloneBinding(binding);
		this.#bindings.set(slotId, binding);
		const failure = await this.#persistNow();
		if (failure === null) return cloneBinding(binding);
		this.#bindings.clear();
		for (const [id, prior] of previous) this.#bindings.set(id, prior);
		// A failed election reports *no* role for the conversation that was requested. The only
		// case where a controlling role is still the truth is a re-bind whose previous binding
		// is durably controlling for this exact conversation; reporting anything else as
		// controlling would let a caller treat a refusal as a grant — including a request for a
		// conversation this slot does not durably serve.
		const stillDurable = existing !== undefined && existing.tabId === tabId && existing.role === "controlling";
		return {
			...(stillDurable ? existing : binding),
			role: stillDurable ? "controlling" : "passive",
			roleRefusal: `The editor-slot role could not be recorded durably (${failure}), so it was not published.`,
		};
	}

	async setEditorMode(slotId: string, mode: SessionViewMode): Promise<void> {
		const binding = this.#bindings.get(slotId);
		if (binding === undefined) throw new SessionIndexError("invalid-input", "The editor has no durable binding.");
		// A mode the binding already records is not a change: no catalog commit for it.
		if (binding.mode === mode) return;
		this.#bindings.set(slotId, { ...binding, mode });
		const failure = await this.#persistNow();
		// Contention for the catalog is not a refusal: the mode stays, the whole index is saved again by itself, and the
		// only cost of a window closing before that is a view the next open takes from the default.
		if (failure !== null && !this.#persistBusy) {
			this.#bindings.set(slotId, binding);
			throw new SessionIndexError("invalid-input", `The editor mode could not be recorded durably: ${failure}`);
		}
	}

	/**
	 * Why this window may *not* make an editor the controlling slot of `entry`, or `null`.
	 *
	 * Only another live window's claim on the row's identity refuses the role; an
	 * unowned row, or one this window drives or holds, may be controlled here. An
	 * unreadable claim directory is not evidence of a rival, so it refuses nothing.
	 */
	async #controllerRefusal(entry: MutableEntry): Promise<string | null> {
		if (this.#drivesHost(entry.tabId)) return null;
		const target = entry.sessionFile ?? entry.ownership?.draftIdentity ?? null;
		const observed = target === null ? null : await this.#readClaim(target);
		const claim = observed?.ok ? observed.claim : null;
		if (claim !== null && claim.holderId !== this.#claimHolder.id && await claimHolderMayBeAlive(claim)) {
			return "This session is open in another window. This editor is read-only; continue there.";
		}
		return null;
	}

	/** Drop one slot's binding; the conversation and the editor are untouched. */
	async unbindEditorSlot(slotId: string): Promise<boolean> {
		if (!this.#bindings.delete(slotId)) return false;
		await this.#persist();
		return true;
	}

	/**
	 * Drop the passive bindings of editors the window that held them has seen close and no live window holds
	 * (`src/host/editor-slot-prune.ts` decides that; this is the write).
	 *
	 * The committed bindings are adopted first, so what is dropped is what is committed now, and a binding another window
	 * has since changed or promoted is judged as it stands: only a binding that is *still passive* goes. A controlling
	 * binding stays (broker provenance and a recorded stop read the controller of a conversation that runs with no editor
	 * open; a later controller demotes it, and it is dropped then). The write is the ordinary merged save, so a binding
	 * another window changed after this window adopted it is kept by the merge and reported, never deleted.
	 *
	 * Returns the slot ids that need no more attention: dropped now, or bound to nothing. A slot whose binding is
	 * controlling is not returned.
	 */
	async dropClosedPassiveSlots(slotIds: readonly string[]): Promise<string[]> {
		await this.refreshFromStore();
		const settled: string[] = [];
		let dropped = false;
		for (const slotId of slotIds) {
			const binding = this.#bindings.get(slotId);
			if (binding === undefined) {
				settled.push(slotId);
				continue;
			}
			if (binding.role !== "passive") continue;
			this.#bindings.delete(slotId);
			settled.push(slotId);
			dropped = true;
		}
		if (dropped) await this.#persist();
		return settled;
	}

	/**
	 * Drop every binding of a row that leaves the index, in the same save that drops the row.
	 *
	 * A binding names a row no window can show once the row is gone: the serializer already treats it as absent and a
	 * restored editor falls back to its tab type's own conversation, so keeping it only grows the catalog.
	 */
	#dropBindingsOf(tabId: string): void {
		for (const [slotId, binding] of this.#bindings) {
			if (binding.tabId === tabId) this.#bindings.delete(slotId);
		}
	}

	/** Drop the bindings whose row this window does not hold (an earlier build never dropped them); whether any went. */
	#dropOrphanBindings(): boolean {
		let dropped = false;
		for (const [slotId, binding] of this.#bindings) {
			if (this.#entries.has(binding.tabId)) continue;
			this.#bindings.delete(slotId);
			dropped = true;
		}
		return dropped;
	}

	/**
	 * Make every *other* controlling binding of this conversation passive.
	 *
	 * A conversation has one controlling editor at a time: the one whose commands
	 * and Reload target it. A rival controlling binding is demoted rather than
	 * dropped, because the editor it names may hold unsent input the user must be
	 * able to copy (ADR-0025), and it must not be able to issue a second native
	 * operation.
	 */
	#demoteRivalControllers(binding: EditorSlotBinding): boolean {
		if (binding.role !== "controlling") return false;
		let demoted = false;
		for (const [slotId, existing] of this.#bindings) {
			if (slotId === binding.slotId || existing.tabId !== binding.tabId || existing.role !== "controlling") continue;
			// The role change *is* a binding change, so the demoted binding advances
			// its generation: a stale Webview credential or queued callback that still
			// names the previous generation is fenced out instead of being accepted by
			// a slot that is no longer controlling.
			this.#bindings.set(slotId, {
				...existing,
				role: "passive",
				generation: existing.generation + 1,
				committedAt: this.#timestamp(),
			});
			demoted = true;
		}
		return demoted;
	}

	// Internals

	/**
	 * Refuse, or repair, a row whose recorded working directory is not absolute.
	 *
	 * `normalizeWorkspaceDirectory` of an earlier version stripped the trailing
	 * separator off a drive or POSIX root, so a session started in `C:\` or `/`
	 * persisted `C:` or an empty cwd. Resolving such a value against this
	 * process's working directory would open the session in an unrelated folder,
	 * so the only evidence allowed to replace it is the row's own session file:
	 * its header records the directory OMP actually ran the session in. When that
	 * directory is absolute the row is repaired from it and the repair is
	 * persisted; otherwise the returned explanation is the visible refusal.
	 */
	async #workspaceDirectoryRefusal(entry: MutableEntry): Promise<string | null> {
		if (isAbsoluteWorkspaceDirectory(entry.cwd)) return null;
		const header = entry.sessionFile === null ? null : await readSessionFileHeader(entry.sessionFile);
		const headerCwd = header?.cwd ?? null;
		if (headerCwd !== null && isAbsoluteWorkspaceDirectory(headerCwd)) {
			entry.cwd = normalizeWorkspaceDirectory(headerCwd);
			await this.#persist();
			return null;
		}
		const evidence =
			headerCwd === null
				? "and its session file records no working directory"
				: `and the working directory its session file records ("${headerCwd}") is not an absolute directory either`;
		return (
			`The working directory recorded for this tab ("${entry.cwd}") is not an absolute directory ${evidence}, ` +
			"so opening it would have to guess the folder. Open the session from the folder it belongs to, or remove the tab."
		);
	}

	/** Run one launcher-or-reconcile call, timing it when the row is part of a restore pass. */
	#timed<T>(trace: RestoreTrace | undefined, step: "reconcile" | "attach" | "launch", work: (steps: StepSink | undefined) => Promise<T>): Promise<T> {
		return trace === undefined ? work(undefined) : trace.timer.measure(step, () => work(step === "reconcile" ? trace.timer.sink("reconcile") : undefined));
	}

	/** Run one piece of a row's admission, timing it under `name` when the row is part of a restore pass. */
	#admit<T>(trace: RestoreTrace | undefined, name: string, work: () => Promise<T>): Promise<T> {
		return trace === undefined ? work() : trace.timer.sink("admission").measure(name, work);
	}

	async #launch(
		entry: MutableEntry,
		claim: SessionClaim,
		launcher: OmpHostLauncher,
		trace?: RestoreTrace,
	): Promise<LaunchStep> {
		const request: OmpHostLaunchRequest = {
			tabId: entry.tabId,
			sessionFile: entry.sessionFile,
			sessionId: entry.sessionId,
			cwd: entry.cwd,
			scope: { ...entry.scope },
			transport: entry.host?.transport ?? "rpc",
			ownerGeneration: claim.ownerGeneration,
			claimPath: claim.claimPath,
		};
		let result: OmpHostLaunchResult;
		try {
			result = await this.#timed(trace, "launch", () => launcher.launch(request));
		} catch (error) {
			return { kind: "unconfirmed", detail: `The launch integration threw: ${describeError(error)}` };
		}
		trace?.timer.detail("launch", result.state === "running" ? result.timings : undefined);
		switch (result.state) {
			case "running":
				return { kind: "running", handle: result.host };
			case "not-started":
				return { kind: "failed", detail: result.reason };
			case "unconfirmed":
				return { kind: "unconfirmed", detail: result.reason };
		}
	}

	/**
	 * Ask the integration to reattach to an already-running host.
	 *
	 * The request names the exact host this index recorded and MUST NOT start a
	 * process. The caller decides what happens to the claim when the attach fails.
	 */
	async #attach(
		entry: MutableEntry,
		claim: SessionClaim,
		launcher: OmpHostLauncher,
		recorded: RecordedHost,
		pin: AttachPin,
		trace?: RestoreTrace,
	): Promise<{ readonly kind: "attached"; readonly handle: OmpHostHandle } | { readonly kind: "unavailable"; readonly reason: string }> {
		const request: OmpHostAttachRequest = {
			tabId: entry.tabId,
			sessionFile: entry.sessionFile,
			sessionId: entry.sessionId,
			cwd: entry.cwd,
			scope: { ...entry.scope },
			transport: recorded.transport ?? "rpc",
			ownerGeneration: claim.ownerGeneration,
			claimPath: claim.claimPath,
			recordedHost: { ...recorded },
			pin,
		};
		let result: OmpHostAttachResult;
		try {
			result = await this.#timed(trace, "attach", () => launcher.attach(request));
		} catch (error) {
			return { kind: "unavailable", reason: `The attach integration threw: ${describeError(error)}` };
		}
		trace?.timer.detail("attach", result.timings);
		if (result.state === "attached") return { kind: "attached", handle: result.host };
		return { kind: "unavailable", reason: result.reason };
	}

	async #reconcile(
		entry: MutableEntry,
		claim: ObservedClaim | null,
		reconciler: OwnerReconciler,
		steps?: StepSink,
	): Promise<OwnerVerdict> {
		if (claim !== null && claim.holderId !== this.#claimHolder.id && await claimHolderMayBeAlive(claim)) {
			return { kind: "live", detail: "Another live window of this extension holds this session." };
		}
		try {
			return await reconciler.reconcile({
				entry: toEntry(entry),
				sessionFile: entry.sessionFile,
				draftIdentity: entry.ownership?.draftIdentity ?? null,
				ownerGeneration: entry.ownership?.ownerGeneration ?? "",
				claim,
				host: entry.host === null ? null : { ...entry.host },
				...(steps === undefined ? {} : { steps }),
			});
		} catch (error) {
			return { kind: "unknown", detail: `Ownership reconciliation failed: ${describeError(error)}` };
		}
	}

	async #adoptClaim(entry: MutableEntry, identity: string | null): Promise<SessionClaim> {
		if (identity === null) {
			throw new SessionIndexError("unknown-tab", `Tab ${entry.tabId} has no claimable identity.`);
		}
		return await acquireClaim(
			this.#claimStorageDir,
			identity,
			entry.ownership?.ownerGeneration ?? createOwnerGeneration(),
			await this.#claimHolderReady,
		);
	}

	/**
	 * Give a claim back, reporting the reason when the release itself failed.
	 *
	 * A release performed here is *not* recorded as absence evidence: only a
	 * confirmed host stop ({@link SessionIndex.closeSession} or
	 * {@link SessionIndex.stopRecordedHost}) may do that, because only it proves
	 * anything about a writer that has gone away.
	 */
	async #releaseQuietly(claim: SessionClaim): Promise<string | null> {
		try {
			await claim.release();
		} catch (error) {
			// A claim this owner no longer holds was reconciled away by a higher
			// layer; the identity is free either way. Any other failure leaves a
			// claim behind and is reported instead of hidden.
			if (error instanceof ClaimOwnershipError) return null;
			this.#log?.error(`session claim release failed: ${describeError(error)}`);
			return "This session could not finish closing. Refresh Sessions and try again.";
		}
		return null;
	}

	/**
	 * Void an entry's recorded release.
	 *
	 * A release only proves that the *previous* host was confirmed gone, so it
	 * stops being absence evidence the moment a new host started, may have
	 * started, or is still being guarded by a claim this window holds.
	 */
	#dropReleaseProof(entry: MutableEntry): void {
		if (entry.ownership === null || entry.ownership.releasedAt === null) return;
		entry.ownership = {
			ownerGeneration: entry.ownership.ownerGeneration,
			draftIdentity: entry.ownership.draftIdentity,
			releasedAt: null,
		};
	}

	async #readClaim(
		identity: string,
	): Promise<{ ok: true; claim: ObservedClaim | null } | { ok: false; detail: string }> {
		try {
			return { ok: true, claim: await readClaim(this.#claimStorageDir, identity) };
		} catch (error) {
			return { ok: true, claim: null };
		}
	}

	/** Record bookkeeping on the row; `lastActiveAt` follows it, the conversation's activity does not. */
	async #touch(
		entry: MutableEntry,
		availability: SessionAvailability | null = null,
		detail: string | null = null,
	): Promise<void> {
		if (availability !== null) entry.availability = availability;
		entry.detail = detail;
		entry.lastActiveAt = this.#timestamp();
	}

	#timestamp(): string {
		return this.#now().toISOString();
	}

	// Persistence

	#load(): void {
		let raw: unknown;
		try {
			raw = this.#store.get<unknown>(SESSION_INDEX_STORAGE_KEY);
		} catch (error) {
			this.#loadError = `The session index could not be read: ${describeError(error)}`;
			return;
		}
		// This window's own observations are read even when the shared record is
		// absent or unreadable: they are keyed by tab id and carry nothing but a
		// status, so a row this window observed keeps its status when the shared
		// record is repaired.
		const local = this.#readLocalSnapshot();
		this.#sharedBase = raw;
		let inlineActiveTabId: string | null = null;
		if (raw !== undefined && raw !== null) {
			if (!isPersistedSnapshot(raw)) {
				this.#loadError =
					"The persisted session index did not match the schema of this version and was discarded; session files were not touched.";
			} else {
				for (const entry of raw.entries) {
					const shared = cloneSharedEntry(entry);
					// This window's own record wins; a status an earlier build wrote into the
					// shared row is used only while this window has none for that row, so an
					// upgraded window keeps the status it had observed until its own record
					// holds one. What this window then shows is written to its own record on the
					// next save, so the inline value migrates out of the shared row by itself.
					const inline = inlineObservationOf(entry, shared);
					this.#entries.set(
						shared.tabId,
						composeEntry(shared, local.observations[shared.tabId] ?? inline),
					);
				}
				this.#nextOrdinal = raw.nextOrdinal;
				// The selected tab is this window's own fact and lives in its local
				// record; a value an earlier build wrote into the shared row is honoured
				// only while this window has none, so an upgraded window keeps its
				// selection and the inline value migrates out on the next save.
				const inlineSelected = (raw as SharedSnapshot & { activeTabId?: unknown }).activeTabId;
				if (typeof inlineSelected === "string" && inlineSelected.length > 0) inlineActiveTabId = inlineSelected;
				// Slot bindings are read leniently: a snapshot written before they existed
				// simply has none, and one carrying a malformed record drops that record
				// rather than the whole snapshot — every tab the user has must never be
				// lost over an optional field. A `heldTransfers` list or a binding
				// `witness` written by an earlier build is tolerated and dropped.
				for (const binding of persistedBindings(raw.bindings)) {
					this.#bindings.set(binding.slotId, binding);
				}
				// An earlier build never dropped a binding with its row. The sweep is in memory only: the next save
				// carries the removal, so a window that never writes leaves the catalog as it found it.
				this.#dropOrphanBindings();
			}
		}
		this.#activeTabId = local.activeTabId ?? inlineActiveTabId;
		this.#observedTabIds.clear();
		for (const tabId of Object.keys(local.observations)) this.#observedTabIds.add(tabId);
	}

	/**
	 * This window's observations of the rows it holds, as its local record stores them.
	 *
	 * Every row this window holds is recorded: what it shows for a row (its own
	 * observation, or the status derived from the shared record) is this window's
	 * projection, and storing it is what keeps a status this window observed across its
	 * own restart without ever publishing it to another window.
	 */
	#localObservations(): Record<string, LocalObservation> {
		const observations: Record<string, LocalObservation> = {};
		for (const [tabId, entry] of this.#entries) {
			observations[tabId] = { availability: entry.availability, detail: entry.detail };
		}
		return observations;
	}

	/**
	 * Read this window's own observations, tolerantly.
	 *
	 * A malformed or unknown local record is *not* a load error over the shared
	 * rows: it costs this window its last observations, which are re-derived, while
	 * the rows themselves stay exactly as the shared record holds them.
	 */
	#readLocalSnapshot(): LocalSnapshot {
		const empty: LocalSnapshot = { version: LOCAL_VERSION, activeTabId: null, observations: {} };
		let raw: unknown;
		try {
			raw = this.#localStore.get<unknown>(SESSION_INDEX_LOCAL_KEY);
		} catch {
			return empty;
		}
		if (typeof raw !== "object" || raw === null) return empty;
		const record = raw as Partial<LocalSnapshot>;
		if (record.version !== LOCAL_VERSION) return empty;
		const observations: Record<string, LocalObservation> = {};
		if (typeof record.observations === "object" && record.observations !== null && !Array.isArray(record.observations)) {
			for (const [tabId, candidate] of Object.entries(record.observations as Record<string, unknown>)) {
				if (!isPlainRecord(candidate)) continue;
				const availability = candidate.availability;
				if (typeof availability !== "string" || PERSISTED_AVAILABILITIES[availability] !== true) continue;
				// The legacy `read-only` value is an earlier build's forced state, not an
				// observation this build makes: such a row is derived like one with no
				// observation (its file decides between `draft` and `saved`).
				if (availability === LEGACY_READ_ONLY_AVAILABILITY || availability === "owner-unknown") continue;
				const detail = candidate.detail;
				if (detail !== null && detail !== undefined && typeof detail !== "string") continue;
				observations[tabId] = { availability: availability as SessionAvailability, detail: detail ?? null };
			}
		}
		const activeTabId = typeof record.activeTabId === "string" && record.activeTabId.length > 0 ? record.activeTabId : null;
		return { version: LOCAL_VERSION, activeTabId, observations };
	}

	/**
	 * The ordinary save. A row of a restore pass does not wait for it: the row's outcome is already decided and nothing here
	 * can change it, while the save is a catalog transaction (the lock other windows contend for, a flushed write, a rename)
	 * that costs a loaded machine seconds. The save is queued exactly as an awaited one is, behind the earlier ones and ahead
	 * of the later ones, so no write is lost or reordered; the pass collects its outcome in {@link RestoreReport.saved}.
	 */
	async #persist(trace?: RestoreTrace): Promise<void> {
		if (trace === undefined) {
			await this.#persistNow();
			return;
		}
		trace.saves.push(this.#persistNow().then(failure => failure, error => describeError(error)));
	}

	/**
	 * Persist the shared record and this window's observations, and *report* the
	 * shared outcome.
	 *
	 * Callers that change what another window may act on must not publish their
	 * result when the write did not land, so this reports the failure itself, not
	 * just the recorded {@link SessionIndex.persistError}. `#persist` is this call
	 * with the result ignored, which is what every path that has nothing to roll
	 * back wants.
	 *
	 * Only the shared write is returned. This window's observations are its own
	 * bookkeeping: failing to record one costs the last status this window showed, so
	 * it is reported through {@link SessionIndex.localPersistError} and never gates a
	 * lifecycle decision that the shared record already settled.
	 */
	async #persistNow(companion?: CatalogRecordChange, identity?: {
		readonly before: SharedEntry;
		readonly sessionId: string;
		readonly previousSessionId?: string;
	}, expectHost?: {
		readonly tabId: string;
		/** Whether the *committed* row's host is still the incarnation this write was decided against. */
		matches(host: { readonly startedAt: string; readonly pid: number | null; readonly rpc?: RecordedRpcIdentity | null } | null): boolean;
		/** Write the tentative row into the private snapshot. */
		apply(row: SharedEntry): void;
		/** Make this window's own state follow a landed write. */
		publish(): void;
	}): Promise<string | null> {
		// An ordinary save writes the whole in-memory index as it is at its turn. One that has not reached its turn yet therefore
		// already carries what a later ordinary save would write, and that later save waits for it instead of queueing a second
		// write of the same document: a restore that records two rows, or a burst of title and unread edits, costs one catalog
		// transaction (a lock, a read, a flushed write, a rename) and not one for each.
		const ordinary = companion === undefined && identity === undefined && expectHost === undefined;
		if (ordinary && this.#queuedOrdinarySave !== null) return this.#queuedOrdinarySave;
		const save = this.#persistTurn(companion, identity, expectHost, ordinary ? () => { this.#queuedOrdinarySave = null; } : undefined);
		if (ordinary) this.#queuedOrdinarySave = save;
		return save;
	}

	/** One save queued behind the earlier ones; `atTurn` runs when it is this save's turn, before it captures its snapshot. */
	async #persistTurn(companion: CatalogRecordChange | undefined, identity: {
		readonly before: SharedEntry;
		readonly sessionId: string;
		readonly previousSessionId?: string;
	} | undefined, expectHost: {
		readonly tabId: string;
		matches(host: { readonly startedAt: string; readonly pid: number | null; readonly rpc?: RecordedRpcIdentity | null } | null): boolean;
		apply(row: SharedEntry): void;
		publish(): void;
	} | undefined, atTurn: (() => void) | undefined): Promise<string | null> {
		let failure: string | null = null;
		// Capture each snapshot only at its serialized turn. An earlier identity transaction
		// publishes or refuses before another save can capture that row, preserving other edits.
		this.#persistChain = this.#persistChain.then(async () => {
			atTurn?.();
			let rejectedIdentity: SharedEntry | null = null;
			let hostChanged = false;
			const snapshot: SharedSnapshot = {
				version: INDEX_VERSION,
				nextOrdinal: this.#nextOrdinal,
				entries: [...this.#entries.values()].map(sharedEntryOf),
				bindings: [...this.#bindings.values()].map(binding => ({ ...binding })),
			};
			if (identity !== undefined) {
				const desired = snapshot.entries.find(row => row.tabId === identity.before.tabId);
				if (desired !== undefined) {
					if (desired.sessionFile === null) desired.sessionId = identity.sessionId;
					if (desired.host !== null) desired.host = { ...desired.host, sessionId: identity.sessionId };
				}
			}
			if (expectHost !== undefined) {
				// The tentative row exists only in this private snapshot until the conditional write lands.
				const tentative = snapshot.entries.find(row => row.tabId === expectHost.tabId);
				if (tentative !== undefined) expectHost.apply(tentative);
			}
			const local: LocalSnapshot = {
				version: LOCAL_VERSION,
				activeTabId: this.#activeTabId,
				observations: this.#localObservations(),
			};
			try {
				if (identity?.previousSessionId !== undefined) {
					if (this.#store.transactRecords === undefined) throw new Error("The shared catalog cannot atomically accept provider identity.");
					await this.#store.transactRecords([{ key: SESSION_INDEX_STORAGE_KEY, base: this.#sharedBase, decide: latest => {
						const before = identity.before;
						const committed = isPersistedSnapshot(latest) ? latest.entries.find(row => row.tabId === before.tabId) : undefined;
						if (committed === undefined || committed.sessionFile !== before.sessionFile ||
							!sameRecord(committed.host, before.host) || !sameRecord(committed.ownership, before.ownership) ||
							committed.host?.sessionId !== identity.previousSessionId) {
							if (committed !== undefined) rejectedIdentity = cloneSharedEntry(committed);
							return { refused: "The captured provider identity, file or runtime generation changed before acceptance." };
						}
						return { desired: mergeSessionIndexRecords({ base: this.#sharedBase, desired: snapshot, latest }).value };
					} }]);
				} else if (expectHost !== undefined) {
					if (this.#store.transactRecords === undefined) throw new Error("The shared catalog cannot atomically accept a conditional record.");
					await this.#store.transactRecords([{ key: SESSION_INDEX_STORAGE_KEY, base: this.#sharedBase, decide: latest => {
						const committed = isPersistedSnapshot(latest) ? latest.entries.find(row => row.tabId === expectHost.tabId) : undefined;
						if (committed === undefined || !expectHost.matches(committed.host)) {
							hostChanged = true;
							return { refused: "The row's recorded process changed before this record was accepted." };
						}
						return { desired: mergeSessionIndexRecords({ base: this.#sharedBase, desired: snapshot, latest }).value };
					} }]);
				} else if (companion !== undefined) {
					if (this.#store.transactRecords === undefined) throw new Error("The shared catalog cannot atomically move the native broker mapping.");
					await this.#store.transactRecords([{ key: SESSION_INDEX_STORAGE_KEY, desired: snapshot, base: this.#sharedBase }, companion]);
				} else {
					await Promise.resolve(this.#store.update(SESSION_INDEX_STORAGE_KEY, snapshot, this.#sharedBase));
				}
				if (identity !== undefined) {
					const entry = this.#entries.get(identity.before.tabId);
					if (entry !== undefined) {
						if (entry.sessionFile === null) entry.sessionId = identity.sessionId;
						if (entry.host !== null) entry.host = { ...entry.host, sessionId: identity.sessionId };
					}
					const live = this.#live.get(identity.before.tabId);
					if (live !== undefined) this.#live.set(identity.before.tabId, { ...live, host: { ...live.host, sessionId: identity.sessionId } });
				}
				// The conditional write landed: only now does this window's own state follow it, inside the same serialized turn.
				if (expectHost !== undefined) expectHost.publish();
				this.#persistError = null;
				this.#persistBusy = false;
				this.#persistBusySince = null;
				this.#persistStuckReported = false;
				this.#persistRetry.reset();
				this.#sharedBase = snapshot;
			} catch (error) {
				if (hostChanged) {
					failure = HOST_CHANGED;
					return;
				}
				if (rejectedIdentity !== null) {
					// Keep the committed runtime identity, without discarding title/unread edits
					// made while the CAS waited. A queued ordinary save must not reassert a stale host.
					const committed = rejectedIdentity as SharedEntry;
					const entry = this.#entries.get(committed.tabId);
					if (entry !== undefined) {
						entry.sessionFile = committed.sessionFile;
						entry.sessionId = committed.sessionId;
						entry.host = committed.host;
						entry.ownership = committed.ownership;
					}
				}
				failure = `The session index could not be persisted: ${describeError(error)}`;
				this.#persistError = failure;
				this.#persistBusy = isCatalogBusy(error);
				if (this.#persistBusy) {
					this.#log?.warn(`${failure} (contention between windows; saved again automatically)`);
					this.#escalateLongBusy();
				} else {
					this.#persistBusySince = null;
				}
				// Identity and companion transactions are not retried as ordinary snapshots.
				if (companion === undefined && identity === undefined) this.#retryPersistLater(this.#persistBusy);
				return;
			}
			try {
				await Promise.resolve(this.#localStore.update(SESSION_INDEX_LOCAL_KEY, local));
				this.#localPersistError = null;
			} catch (error) {
				this.#localPersistError = `This window's own OMP session status could not be saved: ${describeError(error)}`;
			}
		});
		await this.#persistChain;
		return failure;
	}

	/**
	 * After a failed shared write, save the current state again a little later: the snapshot is the whole in-memory index,
	 * so a change a blocked rename (another process holding the catalog open) or another window's lock refused is not lost,
	 * and no further user action is needed. Contention for the catalog lock is retried without end, one second after the
	 * first failure and doubling up to 30 s; any other failure is retried three times. A write that lands, from this retry or
	 * from any later save, ends it (`#persistNow` resets it). The timer never keeps the process alive.
	 */
	#retryPersistLater(busy: boolean): void {
		this.#persistRetry.schedule(busy ? Number.POSITIVE_INFINITY : 3);
	}

	/** Contention that lasts is no longer expected: it becomes a fault, reported once through `onPersistStuck`. */
	#escalateLongBusy(): void {
		const now = this.#now().getTime();
		this.#persistBusySince ??= now;
		if (this.#persistStuckReported || now - this.#persistBusySince < PERSIST_BUSY_ESCALATE_MS) return;
		this.#persistStuckReported = true;
		const minutes = Math.floor((now - this.#persistBusySince) / 60_000);
		this.#onPersistStuck?.(`The OMP session index has not been saved for ${minutes} minutes: the profile catalog stays locked by another window. Close the other VS Code windows, or reload this one.`);
	}
}

// Helpers

/**
 * The availability an earlier version forced on an imported row. It is not a
 * state this version produces: a value carried by a legacy source is dropped when
 * this window's own observations are read, so such a row is derived from the shared
 * record (its file decides between `draft` and `saved`).
 */
const LEGACY_READ_ONLY_AVAILABILITY = "read-only";

/**
 * One row as the extension sees it.
 *
 * The import-conflict marker an older per-workspace record may have set is
 * deliberately not part of this projection: it is a merge-internal fact, and every
 * operation that would act on such a row is already refused with the reason, which
 * the row's own `detail` states. Keeping it internal means the projection stays the
 * row's user-facing facts and not the catalog's bookkeeping.
 */
function toEntry(entry: MutableEntry): SessionIndexEntry {
	const { importConflict: _mergeMarker, ...row } = cloneEntry(entry);
	return {
		...row,
		kind: entry.sessionFile === null ? "draft" : "session",
	};
}

/**
 * Whether a window with the URI `windowUri` may restore this row at the next VS Code start (ADR-0080, amendment of
 * 2026-10-21).
 *
 * Only a `running` row has a window it returns to: a row with no recorded home (written before the field, or driven by a
 * window with no URI, or recorded with a URI this build cannot compare) is restored by any window that has an editor for it,
 * and so is a row that is not `running`. A window with no URI is never a recorded home.
 */
export function homeAllows(entry: Pick<SessionIndexEntry, "home" | "runIntent">, windowUri: string | null): boolean {
	if (entry.runIntent !== "running" || entry.home === undefined || entry.home === null) return true;
	const home = windowUriIdentity(entry.home);
	return home === null || (windowUri !== null && windowUriIdentity(windowUri) === home);
}

/**
 * Signature of the row facts a deferred adoption is authorized by.
 *
 * A deferred pass adopts a file for a host it has proven gone, and that proof was
 * accepted for the row as it stood when the pass classified it. Everything an
 * intervening lifecycle operation can change is in here — the binding, the
 * identity, the availability, the ownership record and the recorded host — while
 * `detail` and `lastActiveAt` are left out: a pass updates both itself, and they
 * carry no ownership meaning. The pass carries the signature forward, and
 * {@link SessionIndex.promoteDeferredDraft} re-derives it inside the adoption's
 * own lifecycle, so a stale authorization is refused instead of applied.
 */
function deferredAuthorization(entry: SessionIndexEntry): string {
	const ownership = entry.ownership;
	const host = entry.host;
	return JSON.stringify([
		entry.origin,
		entry.kind,
		entry.sessionFile,
		entry.sessionId,
		entry.availability,
		entry.cwd,
		entry.scope.sessionDir,
		ownership?.ownerGeneration ?? null,
		ownership?.draftIdentity ?? null,
		ownership?.releasedAt ?? null,
		host?.pid ?? null,
		host?.instanceId ?? null,
		host?.generation ?? null,
		host?.sessionId ?? null,
		host?.startedAt ?? null,
		host?.transport ?? null,
		host?.rpc?.slot ?? null,
		host?.rpc?.childPid ?? null,
		host?.rpc?.childCreationTime ?? null,
	]);
}

/**
 * The run intent a row carries, resolved fail-closed from whatever it recorded.
 *
 * Only a row that both declares `running` and has something to run is read that
 * way; an unknown value, a missing value and a `running` row with neither a
 * session file nor a reserved draft identity all resolve to `stopped`, because
 * the cost of wrongly starting a row the user closed is higher than the cost of
 * asking the user to resume it.
 */
function resolveRunIntent(entry: SharedEntry & { readonly availability?: SessionAvailability }): RunIntent {
	if (entry.runIntent === "running") {
		return entry.sessionFile !== null || entry.ownership?.draftIdentity != null ? "running" : "stopped";
	}
	return entry.availability === "live" && entry.runIntent === undefined ? "running" : "stopped";
}


/**
 * The shared part of one row, normalized.
 *
 * It is what the profile catalog holds: identity, intent, ownership and
 * provenance, with no observation of any window. The resolution rules here are the
 * upgrade path (a row written before `origin` or `runIntent` existed gets them from
 * what it recorded), so they run on every read and every commit — an older record
 * is repaired in memory and written back in its current form.
 */
function cloneSharedEntry(entry: SharedEntry): SharedEntry {
	const scope = entry.scope ?? { profile: null, sessionDir: null };
	return {
		tabId: entry.tabId,
		// A row written before the field existed has no origin: it is derived once
		// here (fail-closed) and persisted from then on.
		origin: resolveSessionOrigin(entry.origin, entry.ownership),
		sessionFile: entry.sessionFile ?? null,
		sessionId: entry.sessionId ?? null,
		cwd: entry.cwd,
		scope: {
			profile: scope.profile ?? null,
			sessionDir: scope.sessionDir ?? null,
		},
		sessionDir: entry.sessionDir ?? null,
		ownership: entry.ownership === null || entry.ownership === undefined ? null : { ...entry.ownership },
		host: entry.host === null || entry.host === undefined ? null : { ...entry.host },
		createdAt: entry.createdAt,
		lastActiveAt: entry.lastActiveAt,
		ordinal: entry.ordinal,
		// A row written before run intent existed gets one from what it recorded:
		// a live writer means the user's intent was to run it, and everything else
		// is read as stopped so no activation pass can start a session the user
		// never asked for. It is persisted in that resolved form from then on.
		runIntent: resolveRunIntent(entry),
		title: entry.title ?? null,
		lastCompletedReplyId: entry.lastCompletedReplyId ?? null,
		lastSeenReplyId: typeof entry.lastSeenReplyId === "string" && entry.lastSeenReplyId.length > 0 ? entry.lastSeenReplyId : null,
		home: typeof entry.home === "string" && entry.home.length > 0 ? entry.home : null,
		importConflict: persistedImportConflict(entry.importConflict),
	};
}

/** The shared part of one in-memory row, ready to commit. */
function sharedEntryOf(entry: MutableEntry): SharedEntry {
	return cloneSharedEntry(entry);
}

/**
 * One shared row with this window's own observation composed onto it.
 *
 * A row this window never observed is derived rather than left blank: a fileless
 * row is `draft`, a materialized one is `saved`, and the detail explains import
 * provenance, a released attempt or an import conflict from the shared record
 * itself. That is what makes a row imported from another workspace visible and
 * honestly *not* running here.
 */
function composeEntry(shared: SharedEntry, observation: LocalObservation | undefined): MutableEntry {
	return {
		...shared,
		availability: observation?.availability ?? (shared.sessionFile === null ? "draft" : "saved"),
		detail: observation !== undefined ? observation.detail : deriveEntryDetail(shared),
	};
}

/** What a row with no observation of this window says about itself. */
function deriveEntryDetail(shared: SharedEntry): string | null {
	if (shared.importConflict != null) {
		return "This saved session can still be used. Refresh Sessions before opening it; Copy Diagnostics has the import details.";
	}
	if (shared.origin === "imported") return IMPORTED_SESSION_DETAIL;
	return null;
}

/**
 * The observation an earlier build wrote into a shared row, or `undefined`.
 *
 * Reading it is what makes the split lossless on the way in: a window that upgrades
 * while its store still holds a row-level status keeps showing that status, and its
 * own record takes over on the next save. The legacy `read-only` value an old build
 * forced on an imported row is deliberately not an observation this version makes, so
 * it reads as absent and the row is derived from its file instead.
 */
function inlineObservationOf(entry: SharedEntry, shared: SharedEntry): LocalObservation | undefined {
	const candidate = entry as SharedEntry & { availability?: unknown; detail?: unknown };
	const availability = candidate.availability;
	if (typeof availability !== "string" || PERSISTED_AVAILABILITIES[availability] !== true) return undefined;
	if (availability === LEGACY_READ_ONLY_AVAILABILITY || availability === "owner-unknown") return undefined;
	const detail = candidate.detail;
	if (detail !== null && detail !== undefined && typeof detail !== "string") return undefined;
	if (availability === (shared.sessionFile === null ? "draft" : "saved") && (detail ?? null) === deriveEntryDetail(shared)) {
		// Indistinguishable from the derived status: nothing worth carrying.
		return undefined;
	}
	return { availability: availability as SessionAvailability, detail: detail ?? null };
}

/**
 * The import conflict a row may carry, read leniently, or `null`.
 *
 * A marker this version cannot read is dropped rather than kept: it would block every
 * operation on the row with no readable reason.
 */
function persistedImportConflict(value: unknown): SessionImportConflict | null {
	if (typeof value !== "object" || value === null) return null;
	const record = value as Partial<SessionImportConflict>;
	if (typeof record.source !== "string" || typeof record.reason !== "string" || typeof record.at !== "string") return null;
	return { source: record.source, reason: record.reason, at: record.at };
}

/** One in-memory row's full copy, including this window's own observation. */
function cloneEntry(entry: MutableEntry): MutableEntry {
	return composeEntry(cloneSharedEntry(entry), { availability: entry.availability, detail: entry.detail ?? null });
}

function normalizeScope(scope: OmpLaunchScope | undefined): OmpLaunchScope {
	const profile = scope?.profile?.trim() ?? "";
	const sessionDir = scope?.sessionDir?.trim() ?? "";
	return {
		profile: profile.length > 0 ? profile : null,
		sessionDir: sessionDir.length > 0 ? path.resolve(sessionDir) : null,
	};
}

function resolveInputPath(value: string, caller: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new SessionIndexError("invalid-input", `${caller} requires a non-empty path`);
	}
	return path.resolve(value);
}

/**
 * A caller-supplied working directory, refused instead of guessed.
 *
 * The index only ever holds an absolute directory: anything else would have to
 * be resolved against this process's working directory (a Windows
 * drive-relative `C:` against the current *drive*), and the folder that came out
 * would not be the one the caller chose.
 */
function resolveWorkspaceDirectoryInput(value: string, caller: string): string {
	if (!isAbsoluteWorkspaceDirectory(value)) {
		throw new SessionIndexError(
			"invalid-input",
			`${caller} requires an absolute working directory, but was given "${String(value)}".`,
		);
	}
	return normalizeWorkspaceDirectory(value);
}

/**
 * Whether `file` is a regular file. When every folder on the way to a recorded OMP session file is a plain directory of one
 * local fixed NTFS volume (`synchronousLocalPaths`, asked again on every call, so a folder replaced by a link is noticed by the
 * next one), the check is one synchronous `lstat` (ADR-0076, decision 15): the restore asks once per tab before anything else,
 * and an asynchronous `stat` came back after 0.6 s in every tab of a reload that kept the host's event loop busy. Nothing is
 * remembered about the folder and no other call of this process becomes synchronous because of it. A session file directly in a
 * drive root, one that is itself a link, and every other volume keep the asynchronous `stat`.
 */
async function fileExists(file: string): Promise<boolean> {
	try {
		if (path.dirname(file) !== path.parse(file).root && (await synchronousLocalPaths([file]))) {
			const stats = lstatSync(file, { throwIfNoEntry: false });
			if (stats === undefined) return false;
			if (!stats.isSymbolicLink()) return stats.isFile();
		}
		return (await stat(file)).isFile();
	} catch {
		return false;
	}
}

function withReleaseNotice(detail: string, release: string | null): string {
	return release === null ? detail : `${detail} ${release}`;
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The identity a row would claim, normalized as the pass's duplicate rule compares it; `null` when none is known yet. */
function restoreIdentityKey(entry: MutableEntry): string | null {
	const target = entry.sessionFile ?? entry.ownership?.draftIdentity ?? null;
	return target === null ? null : normalizeSessionIdentityKey(target);
}

/** Whether a value is a non-array object, the only shape a record field may have. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Availability values a persisted snapshot may carry.
 *
 * `read-only` is not a state this version produces — it is what an earlier
 * version wrote for an imported row, and it is read as no observation at all. It
 * is still accepted here so that one legacy value can never discard an entire
 * snapshot, and with it every tab the user has.
 */
const PERSISTED_AVAILABILITIES: Record<string, true> = {
	draft: true,
	live: true,
	saved: true,
	"owner-unknown": true,
	failed: true,
	[LEGACY_READ_ONLY_AVAILABILITY]: true,
};

function isPersistedSnapshot(value: unknown): value is SharedSnapshot {
	if (typeof value !== "object" || value === null) return false;
	const snapshot = value as Partial<SharedSnapshot> & { activeTabId?: unknown };
	if (snapshot.version !== INDEX_VERSION) return false;
	if (!Array.isArray(snapshot.entries)) return false;
	if (typeof snapshot.nextOrdinal !== "number" || !Number.isFinite(snapshot.nextOrdinal)) return false;
	// `activeTabId` is deliberately ignored here: an earlier build kept the window's
	// selected tab in this record, and this build keeps it in the window's own local
	// record. A value that is still there is neither an error nor a shared fact.
	return snapshot.entries.every(isPersistedEntry);
}

/**
 * The persisted slot bindings a snapshot may carry, one per slot, malformed
 * records dropped.
 */
function persistedBindings(value: unknown): EditorSlotBinding[] {
	if (!Array.isArray(value)) return [];
	const bySlot = new Map<string, EditorSlotBinding>();
	for (const candidate of value) {
		const binding = persistedBinding(candidate);
		if (binding !== null) bySlot.set(binding.slotId, binding);
	}
	return [...bySlot.values()];
}

function persistedBinding(value: unknown): EditorSlotBinding | null {
	if (typeof value !== "object" || value === null) return null;
	const binding = value as Partial<EditorSlotBinding>;
	if (typeof binding.slotId !== "string" || binding.slotId.length === 0) return null;
	if (typeof binding.tabId !== "string" || binding.tabId.length === 0) return null;
	if (typeof binding.generation !== "number" || !Number.isFinite(binding.generation)) return null;
	if (binding.role !== "controlling" && binding.role !== "passive") return null;
	if (typeof binding.committedAt !== "string") return null;
	if (binding.mode !== undefined && binding.mode !== "chat" && binding.mode !== "terminal") return null;
	return {
		slotId: binding.slotId,
		tabId: binding.tabId,
		generation: binding.generation,
		role: binding.role,
		committedAt: binding.committedAt,
		mode: binding.mode ?? "chat",
		// Read leniently, like every other optional field: a binding written before
		// election was claim-bound simply carries no refusal.
		roleRefusal: typeof binding.roleRefusal === "string" ? binding.roleRefusal : null,
	};
}

function cloneBinding(binding: EditorSlotBinding): EditorSlotBinding {
	return { ...binding };
}

function isPersistedEntry(value: unknown): value is SharedEntry {
	if (typeof value !== "object" || value === null) return false;
	const entry = value as Partial<MutableEntry>;
	if (typeof entry.tabId !== "string" || entry.tabId.length === 0) return false;
	// `origin` is deliberately not validated: a row written before the field
	// existed, or one carrying a value from a future version, is resolved
	// fail-closed by `resolveSessionOrigin` when it is cloned. Rejecting it here
	// would discard the whole snapshot — every tab the user has — over one field.
	if (entry.sessionFile !== null && entry.sessionFile !== undefined && typeof entry.sessionFile !== "string") {
		return false;
	}
	if (entry.sessionId !== null && entry.sessionId !== undefined && typeof entry.sessionId !== "string") return false;
	// An empty or drive-relative `cwd` is accepted here on purpose: an earlier
	// version could persist `C:` or an empty value for a session started in a
	// drive or POSIX root, and one unusable row must never discard the whole
	// snapshot — every tab the user has. Such a row is refused at launch unless
	// its own session file's header establishes the directory.
	if (typeof entry.cwd !== "string") return false;
	if (typeof entry.createdAt !== "string" || typeof entry.lastActiveAt !== "string") return false;
	if (typeof entry.ordinal !== "number" || !Number.isFinite(entry.ordinal)) return false;
	// `availability` and `detail` are this window's own observations and live in its
	// local record, not here. A value an earlier build wrote into this record is accepted
	// (it is validated when it is read as an observation) and simply is not part of the
	// shared row. `lastSeenReplyId` is shared and read leniently by `cloneSharedEntry`.
	if (
		entry.availability !== undefined &&
		(typeof entry.availability !== "string" || PERSISTED_AVAILABILITIES[entry.availability] !== true)
	) {
		return false;
	}
	if (entry.detail !== null && entry.detail !== undefined && typeof entry.detail !== "string") return false;
	if (entry.sessionDir !== null && entry.sessionDir !== undefined && typeof entry.sessionDir !== "string") {
		return false;
	}
	if (entry.importConflict !== null && entry.importConflict !== undefined && persistedImportConflict(entry.importConflict) === null) {
		// A marker this version cannot read would block every operation on the row
		// with no readable reason, so it is refused here and reported instead of
		// silently discarded.
		return false;
	}
	if (entry.scope !== undefined && (typeof entry.scope !== "object" || entry.scope === null)) return false;
	const scope = (entry.scope ?? { profile: null, sessionDir: null }) as Partial<OmpLaunchScope>;
	if (scope.profile !== null && scope.profile !== undefined && typeof scope.profile !== "string") return false;
	if (scope.sessionDir !== null && scope.sessionDir !== undefined && typeof scope.sessionDir !== "string") {
		return false;
	}
	if (entry.ownership !== undefined && entry.ownership !== null) {
		const ownership = entry.ownership as Partial<RecordedOwnership>;
		if (typeof ownership.ownerGeneration !== "string") return false;
		if (ownership.draftIdentity !== null && typeof ownership.draftIdentity !== "string") return false;
		if (ownership.releasedAt !== null && typeof ownership.releasedAt !== "string") return false;
	}
	if (entry.host !== undefined && entry.host !== null) {
		const host = entry.host as Partial<RecordedHost>;
		if (host.pid !== null && typeof host.pid !== "number") return false;
		if (host.instanceId !== null && typeof host.instanceId !== "string") return false;
		if (host.generation !== null && typeof host.generation !== "number") return false;
		if (host.sessionId !== null && typeof host.sessionId !== "string") return false;
		if (typeof host.startedAt !== "string") return false;
		if (host.transport !== undefined && host.transport !== "rpc" && host.transport !== "native") return false;
		if (host.rpc !== undefined && host.rpc !== null && !isRecordedRpcIdentity(host.rpc)) return false;
	}
	return true;
}

// The shared record in the profile catalog

/** One shared record this window refused to apply, retained raw for recovery. */
export type SharedRecordConflict = RecordConflictDraft;
/**
 * Merge this window's desired shared record into the newest committed one.
 *
 * This is the concurrency rule. A whole-snapshot overwrite would lose whatever
 * another window committed after this window read the record, so instead the
 * change is computed as a delta against the value this window last saw:
 *
 * - a row this window changed (or added) keeps this window's facts; where the other
 *   window changed the same row too, both versions are recorded as a conflict and
 *   this window's facts are the ones applied — a user's own action is never
 *   silently replaced by another window's — **except the run state** (`runIntent`, `host`,
 *   `ownership`, `home`), which {@link settleRunState} settles field by field: a field this window did
 *   not change takes the committed value, so a window that only ends its own process can never
 *   take back another window's Stop or Kill (ADR-0034, amendments of 2026-10-21);
 * - a row this window did not touch takes the committed value, so another window's
 *   new or updated row survives here;
 * - a row this window removed is removed, unless the other window changed it after
 *   the value this window saw — then the change is kept and reported.
 *
 * The import-conflict marker is sticky: an ordinary write never clears it, so a row
 * two legacy sources disagreed about cannot be made resumable by another window's
 * unrelated edit. Removing the row and resuming its exact file registers one clean
 * row, which is the resolution.
 */
export function mergeSessionIndexRecords(input: {
	readonly base: unknown;
	readonly desired: unknown;
	readonly latest: unknown;
}): { readonly value: unknown; readonly conflicts: readonly SharedRecordConflict[] } {
	if (input.desired === undefined || input.desired === null || !isPersistedSnapshot(input.desired)) {
		// A desired value this version cannot read is never written over a readable
		// one: the committed record is kept and the caller is told nothing changed.
		return { value: input.latest, conflicts: [] };
	}
	const desired = input.desired;
	if (input.latest === undefined || input.latest === null || !isPersistedSnapshot(input.latest)) {
		return { value: input.desired, conflicts: [] };
	}
	const latest = input.latest;
	const base = input.base !== undefined && input.base !== null && isPersistedSnapshot(input.base) ? input.base : null;
	const conflicts: SharedRecordConflict[] = [];
	const baseRows = new Map(base?.entries.map(entry => [entry.tabId, cloneSharedEntry(entry)]) ?? []);
	const latestRows = new Map(latest.entries.map(entry => [entry.tabId, cloneSharedEntry(entry)]));
	const entries: SharedEntry[] = [];
	const taken = new Set<string>();
	for (const candidate of desired.entries) {
		const mine = cloneSharedEntry(candidate);
		taken.add(mine.tabId);
		const before = baseRows.get(mine.tabId) ?? null;
		const theirs = latestRows.get(mine.tabId) ?? null;
		const mineIsLocalChange = before === null || !sameRecord(before, mine);
		if (!mineIsLocalChange) {
			// Untouched here: the committed row is the answer, and its absence is a
			// committed deletion by another window — this window's stale copy must not
			// resurrect the row it never changed. Only the reply identities may come from
			// this side, when it holds a newer one than the committed row.
			if (theirs !== null) entries.push(stickyImportConflict(withLaterReplyMarkers(theirs, mine, before), mine));
			continue;
		}
		const merged = theirs === null ? mine : withLaterReplyMarkers(mine, theirs, before);
		// Both windows changed the row: the run state (intent, host, release) follows the field-conditional rule, not "mine whole".
		const settled = theirs !== null && before !== null && !sameRecord(before, theirs) ? settleRunState(merged, mine, theirs, before) : merged;
		// Both windows wrote the same value: nothing was overwritten, so nothing is reported (as `mergeKeyedArray` does).
		if (theirs !== null && !sameRecord(before, theirs) && !sameRecord(settled, theirs)) {
			conflicts.push({
				identity: mine.tabId,
				reason: "another window changed this row while this window changed it too; this window's own facts were applied",
				retained: settled,
				rejected: theirs,
			});
		}
		entries.push(stickyImportConflict(settled, theirs));
	}
	for (const candidate of latest.entries) {
		const theirs = cloneSharedEntry(candidate);
		if (taken.has(theirs.tabId)) continue;
		const before = baseRows.get(theirs.tabId);
		if (before !== undefined && sameRecord(before, theirs)) continue;
		if (before !== undefined) {
			conflicts.push({
				identity: theirs.tabId,
				reason: "this window removed this row while another window changed it; the change was kept",
				retained: theirs,
				rejected: null,
			});
		}
		entries.push(theirs);
	}
	return {
		value: {
			version: INDEX_VERSION,
			nextOrdinal: Math.max(desired.nextOrdinal, latest.nextOrdinal),
			entries,
			bindings: mergeKeyedArray({
				base: persistedBindings(base?.bindings),
				desired: persistedBindings(desired.bindings),
				latest: persistedBindings(latest.bindings),
				key: binding => binding.slotId,
				label: "editor-slot binding",
				conflicts,
			}),
		},
		conflicts,
	};
}

/**
 * The run state of a row both windows changed, field by field (ADR-0034, amendment of 2026-10-21).
 *
 * `runIntent`, `host`, `ownership` (the release stamp) and `home` (the window that last became the driver) are what a
 * window's launch, attach and end-of-process writes touch. Each keeps the committed value unless this window changed it
 * relative to the value it last saw (`before`), so an exit that clears the host and records the release cannot revert the
 * stopped intent another window recorded meanwhile, and an ordinary edit (a title, a reply identity) never carries a stale
 * host, intent or home back. Two more rules, for a write that replaces the *attempt* of the row (a different `startedAt`):
 * one that clears the host of a run (`before.host` set, `mine.host` null) says nothing about a newer attempt another window
 * committed meanwhile, so the committed run state, home included, stands whole; one that records a new attempt (a launch
 * or an attach) carries its own intent, ownership and home, so a stop or a release another window committed for the older
 * attempt does not stay glued to the new one.
 */
function settleRunState(merged: SharedEntry, mine: SharedEntry, theirs: SharedEntry, before: SharedEntry): SharedEntry {
	if (mine.host === null && before.host !== null && theirs.host !== null && theirs.host.startedAt !== before.host.startedAt) {
		return { ...merged, runIntent: theirs.runIntent, host: theirs.host, ownership: theirs.ownership, home: theirs.home };
	}
	if (mine.host !== null && (before.host === null || mine.host.startedAt !== before.host.startedAt)) {
		// The mirror case: a launch or an attach records the attempt, its intent and its (unreleased) ownership in one write, so
		// a stop or a release another window committed for an *older* attempt of the row must not stay glued to the new one.
		return { ...merged, runIntent: mine.runIntent, host: mine.host, ownership: mine.ownership, home: mine.home };
	}
	return {
		...merged,
		runIntent: sameRecord(mine.runIntent, before.runIntent) ? theirs.runIntent : mine.runIntent,
		host: sameRecord(mine.host, before.host) ? theirs.host : mine.host,
		ownership: sameRecord(mine.ownership, before.ownership) ? theirs.ownership : mine.ownership,
		home: mine.home === before.home ? theirs.home : mine.home,
	};
}

/** Keep an import-conflict marker either side holds: only resolution clears it. */
function stickyImportConflict(mine: SharedEntry, theirs: SharedEntry | null): SharedEntry {
	const marker = mine.importConflict ?? theirs?.importConflict ?? null;
	return marker === null || marker === mine.importConflict ? mine : { ...mine, importConflict: marker };
}

/**
 * `row` with the later of each reply identity of `row` and `other`.
 *
 * The row is merged as a whole, and a window holding a stale copy of it (it adopted the row, and a different window
 * then recorded that the user read it) would otherwise take the identities back with every unrelated field it changes.
 * An identity only advances, so the later one wins whichever side wrote it.
 */
function withLaterReplyMarkers(row: SharedEntry, other: SharedEntry, before: SharedEntry | null): SharedEntry {
	const lastCompletedReplyId = laterReplyMarker(before?.lastCompletedReplyId, row.lastCompletedReplyId, other.lastCompletedReplyId);
	const lastSeenReplyId = laterReplyMarker(before?.lastSeenReplyId, row.lastSeenReplyId, other.lastSeenReplyId);
	return lastCompletedReplyId === row.lastCompletedReplyId && lastSeenReplyId === row.lastSeenReplyId ? row : { ...row, lastCompletedReplyId, lastSeenReplyId };
}
