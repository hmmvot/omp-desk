/**
 * OMP Desk's profile-wide catalog, which owns the extension's durable state
 * ([ADR-0034](../../docs/decisions/0034-store-sessions-in-one-profile-catalog.md)).
 *
 * ## Why this exists
 *
 * `context.workspaceState` is scoped to the VS Code workspace the window has open.
 * A folder the user added, and the conversations that folder's window indexed,
 * became unreachable whenever another folder was opened, because the new workspace
 * had a different Memento. The state was never deleted, only hidden. This module
 * replaces that authority with one versioned file in the extension's
 * `globalStorageUri`, shared by every window of the same local extension profile.
 *
 * ## Shape
 *
 * The catalog is one JSON document:
 *
 * ```jsonc
 * {
 *   "version": 1,
 *   "revision": 7,                       // advances on every committed transaction
 *   "records": { "omp.sessionIndex.v1": { … } },
 *   "imports": [                         // one ledger entry per imported source
 *     { "source": "predecessor:<extension id>", "digest": "sha256:…", … }
 *   ],
 *   "conflicts": [                       // imported records that disagreed, kept raw
 *     { "key": "omp.sessionIndex.v1", "identity": "tab:…", … }
 *   ]
 * }
 * ```
 *
 * Each `records` value is the snapshot one owning module persists, so the modules
 * keep their own schema, validation and semantics; this file owns their durability,
 * atomicity and cross-window merge.
 *
 * ## Transactions
 *
 * Read-modify-write only, under a short cross-process lock:
 *
 * 1. take the lock (`catalog.lock`, exclusive create);
 * 2. read and validate the newest committed document;
 * 3. apply the caller's operation to that newest state;
 * 4. write a sibling file, flush it, and atomically rename it over the document;
 * 5. release the lock and publish the new revision.
 *
 * A mutation therefore never writes a stale whole snapshot: the operation sees
 * whatever the last writer committed. Two windows adding two different
 * conversations both keep their row.
 *
 * ## Refusal, not erasure
 *
 * A catalog that exists but cannot be read (malformed JSON, an unknown newer
 * version) makes every mutation *refuse* and reports the reason; it is never
 * replaced with an empty writable document, because doing so would destroy the
 * user's sessions and folders to recover from a parse error. A missing file is a
 * fresh install and is created by the first commit. An unavailable catalog is
 * visible: {@link CatalogStore.unavailableReason} is set, mutations reject with
 * {@link CatalogError}, and readers see no records — the same as an install that
 * has never written anything, which is honest, and nothing is lost.
 *
 * ## Locking
 *
 * The lock is a file created exclusively (`wx`). It records the owning process,
 * host and timestamp. A lock held by a live process is never taken over: the
 * acquirer waits, then refuses with {@link CatalogError} `busy`, and the caller
 * reports that the change was not saved. Only a lock whose recorded process is
 * *provably gone* **and** which is older than {@link CATALOG_LOCK_STALE_MS} is
 * reclaimed, and the reclaim is recorded in the document's conflict ledger. Time
 * alone never steals a lock: a slow writer must not have its transaction
 * overwritten by a thief.
 *
 * ## Watching
 *
 * {@link startCatalogWatch} reports that the document changed inside a directory;
 * it is a *hint* — the window re-reads the document and compares revisions, so a
 * missed event costs a refresh, never correctness. A watcher never restores,
 * launches or claims anything by itself.
 */
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { renameReplacingSync } from "./atomic-file.ts";

/** Document schema version this build writes and accepts. */
export const CATALOG_VERSION = 1;

/** How long a mutation waits for a contended lock before refusing. */
export const CATALOG_LOCK_TIMEOUT_MS = 4_000;

/**
 * How old a lock held by a *provably dead* process must be before it is reclaimed.
 *
 * The dead-owner check is the evidence; this grace covers a lock whose writer has
 * died between creating the file and writing its own record, and any file system
 * timestamp granularity.
 */
export const CATALOG_LOCK_STALE_MS = 10_000;

/** How many raw legacy records the conflict ledger keeps, newest last. */
export const CATALOG_CONFLICT_LIMIT = 128;

/** How many import-ledger entries are kept. */
export const CATALOG_IMPORT_LIMIT = 512;

/** The directory and the two files one catalog owns. */
export interface CatalogPaths {
  /** Directory holding the document, the lock and the staging files. */
  readonly root: string;
  /** The committed document. */
  readonly document: string;
  /** The exclusive lock. */
  readonly lock: string;
}

/**
 * Where a catalog lives inside the extension's global storage.
 *
 * It is a subdirectory of the extension's own `globalStorageUri`, not the
 * extension directory itself: the storage directory also holds staged runtime
 * copies and claims, and this module must be able to list and replace its own
 * files without touching them.
 */
export function catalogPaths(storageDir: string): CatalogPaths {
  const root = path.join(storageDir, "catalog", "v1");
  return { root, document: path.join(root, "catalog.json"), lock: path.join(root, "catalog.lock") };
}

/** One legacy source this catalog has imported, and what that import produced. */
export interface CatalogImportRecord {
  /**
   * Stable identity of the source, e.g. `predecessor:<extension id>`.
   *
   * The ledger is keyed by this alone, deliberately *not* by digest: a source that
   * was imported once stays imported even when the data behind it changes later,
   * so it can never resurrect a row or folder the user removed afterwards.
   */
  readonly source: string;
  /** Digest of the allowlisted records this source carried when it was read. */
  readonly digest: string;
  readonly at: string;
  /**
   * What the import did: records were merged, nothing readable was present, the
   * source was quarantined for internal disagreement, or its runtime/layout is
   * unsupported.
   */
  readonly outcome: "imported" | "empty" | "quarantined" | "unsupported";
  /** Record keys this source carried. */
  readonly keys: readonly string[];
  /** Human-readable detail for a non-`imported` outcome. */
  readonly detail: string | null;
}

/** One legacy record that disagreed with what the catalog already holds. */
export interface CatalogConflictRecord {
  /** Catalog record key the disagreement belongs to. */
  readonly key: string;
  /** Identity inside that record (tab id, editor slot id, folder path). */
  readonly identity: string;
  /** Source that carried the rejected value, or `null` for a lock reclaim. */
  readonly source: string | null;
  readonly at: string;
  readonly reason: string;
  /** The value the catalog kept. */
  readonly retained: unknown;
  /** The value that was not applied, retained for recovery. */
  readonly rejected: unknown;
}

/** The committed document. */
export interface CatalogDocument {
  readonly version: number;
  readonly revision: number;
  readonly records: Readonly<Record<string, unknown>>;
  readonly imports: readonly CatalogImportRecord[];
  readonly conflicts: readonly CatalogConflictRecord[];
}

/** Why a catalog operation could not proceed. */
export type CatalogErrorReason =
  /** The document exists and cannot be read as this version. */
  | "unavailable"
  /** Another process holds the lock, or the lock cannot be reclaimed safely. */
  | "busy"
  /** A key without a registered merge rule diverged from this window's view. */
  | "divergence"
  /** The commit itself failed; the previous revision is intact. */
  | "write"
  /** The lock file could not be created or inspected. */
  | "lock";

export class CatalogError extends Error {
  readonly reason: CatalogErrorReason;

  constructor(reason: CatalogErrorReason, message: string, options?: { readonly cause?: unknown }) {
    super(message, options as ErrorOptions);
    this.name = "CatalogError";
    this.reason = reason;
  }
}

/** The empty document a fresh install starts from (never written until a change). */
export function emptyCatalogDocument(): CatalogDocument {
  return { version: CATALOG_VERSION, revision: 0, records: {}, imports: [], conflicts: [] };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate one import-ledger entry as this version reads it. */
function readImportRecord(value: unknown): CatalogImportRecord | null {
  if (!isPlainObject(value)) return null;
  if (typeof value.source !== "string" || value.source.length === 0 || value.source.length > 256) return null;
  if (typeof value.digest !== "string") return null;
  if (typeof value.at !== "string") return null;
  const outcome = value.outcome;
  if (outcome !== "imported" && outcome !== "empty" && outcome !== "quarantined" && outcome !== "unsupported") return null;
  const keys = Array.isArray(value.keys) ? value.keys.filter((key): key is string => typeof key === "string") : [];
  const detail = typeof value.detail === "string" ? value.detail : null;
  return { source: value.source, digest: value.digest, at: value.at, outcome, keys, detail };
}

/** Validate one conflict record as this version reads it. */
function readConflictRecord(value: unknown): CatalogConflictRecord | null {
  if (!isPlainObject(value)) return null;
  const { key, identity, source, at, reason } = value;
  if (typeof key !== "string" || typeof identity !== "string" || typeof at !== "string" || typeof reason !== "string") {
    return null;
  }
  if (source !== null && typeof source !== "string") return null;
  return { key, identity, source, at, reason, retained: value.retained, rejected: value.rejected };
}

/**
 * Read and validate one committed document.
 *
 * Returns `null` when no document exists (a fresh install). Any other unreadable
 * state throws {@link CatalogError} `unavailable`: the caller must refuse to write
 * rather than treat the catalog as empty.
 */
export function readCatalogDocument(paths: CatalogPaths): CatalogDocument | null {
  let text: string;
  try {
    text = fs.readFileSync(paths.document, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new CatalogError("unavailable", `The OMP profile catalog could not be read: ${messageOf(error)}`, { cause: error });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new CatalogError(
      "unavailable",
      `The OMP profile catalog is not valid JSON and was left untouched: ${messageOf(error)}`,
      { cause: error },
    );
  }
  if (!isPlainObject(parsed)) {
    throw new CatalogError("unavailable", "The OMP profile catalog is not a JSON object and was left untouched.");
  }
  if (parsed.version !== CATALOG_VERSION) {
    throw new CatalogError(
      "unavailable",
      `The OMP profile catalog was written by another version (${String(parsed.version)}); this build reads version ${CATALOG_VERSION} and will not replace it.`,
    );
  }
  const revision = parsed.revision;
  if (typeof revision !== "number" || !Number.isFinite(revision) || revision < 0) {
    throw new CatalogError("unavailable", "The OMP profile catalog carries no usable revision and was left untouched.");
  }
  if (!isPlainObject(parsed.records)) {
    throw new CatalogError("unavailable", "The OMP profile catalog carries no usable record table and was left untouched.");
  }
  const imports: CatalogImportRecord[] = [];
  if (parsed.imports !== undefined) {
    if (!Array.isArray(parsed.imports)) {
      throw new CatalogError("unavailable", "The OMP profile catalog carries a malformed import ledger and was left untouched.");
    }
    for (const candidate of parsed.imports) {
      const record = readImportRecord(candidate);
      if (record !== null) imports.push(record);
    }
  }
  const conflicts: CatalogConflictRecord[] = [];
  if (parsed.conflicts !== undefined) {
    if (!Array.isArray(parsed.conflicts)) {
      throw new CatalogError("unavailable", "The OMP profile catalog carries a malformed conflict ledger and was left untouched.");
    }
    for (const candidate of parsed.conflicts) {
      const record = readConflictRecord(candidate);
      if (record !== null) conflicts.push(record);
    }
  }
  return { version: CATALOG_VERSION, revision, records: parsed.records, imports, conflicts };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Lock

interface LockRecord {
  readonly token: string;
  readonly pid: number;
  readonly host: string;
  readonly at: string;
}

function readLockRecord(lockPath: string): LockRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, "utf8")) as Partial<LockRecord>;
    if (typeof parsed.token !== "string" || parsed.token.length === 0) return null;
    if (typeof parsed.pid !== "number" || !Number.isFinite(parsed.pid)) return null;
    return {
      token: parsed.token,
      pid: parsed.pid,
      host: typeof parsed.host === "string" ? parsed.host : "unknown",
      at: typeof parsed.at === "string" ? parsed.at : "unknown",
    };
  } catch {
    return null;
  }
}

/** Whether the recorded owner process is provably gone on this host. */
function ownerIsProvablyGone(record: LockRecord): boolean {
  if (process.platform === "win32" && record.host !== osHostname()) return false;
  if (record.host !== osHostname()) return false;
  if (record.pid === process.pid) return false;
  try {
    process.kill(record.pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

let cachedHostname: string | null = null;

function osHostname(): string {
  if (cachedHostname === null) cachedHostname = os.hostname();
  return cachedHostname;
}

/** What acquiring the lock decided, so the caller can release exactly its own lock. */
interface HeldLock {
  readonly token: string;
  /** A reclaimed lock's dead owner, recorded so the reclaim is visible. */
  readonly reclaimedFrom: LockRecord | null;
}

function tryCreateLock(lockPath: string, token: string): boolean {
  try {
    const fd = fs.openSync(lockPath, "wx");
    try {
      const record: LockRecord = { token, pid: process.pid, host: osHostname(), at: new Date().toISOString() };
      fs.writeSync(fd, JSON.stringify(record));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw new CatalogError("lock", `The OMP profile catalog lock could not be created: ${messageOf(error)}`, { cause: error });
  }
}

async function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

interface AcquireLockOptions {
  readonly timeoutMs: number;
  readonly staleMs: number;
  readonly now: () => number;
}

async function acquireLock(lockPath: string, options: AcquireLockOptions): Promise<HeldLock> {
  const token = randomUUID();
  const deadline = options.now() + options.timeoutMs;
  /** The lock this acquisition had to reclaim, recorded so the reclaim is visible. */
  let reclaimedFrom: LockRecord | null = null;
  for (;;) {
    if (tryCreateLock(lockPath, token)) return { token, reclaimedFrom };
    const record = readLockRecord(lockPath);
    if (record === null) {
      // A lock file this process cannot read is ambiguous: it may be a live holder's
      // record being written right now, or a damaged file. Age is not proof of a dead
      // owner, so it is never reclaimed on age alone — the acquisition waits and then
      // refuses, and the caller reports that the change was not saved.
    } else if (ownerIsProvablyGone(record)) {
      const age = lockAgeMs(lockPath, options.now);
      if (age !== null && age > options.staleMs) {
        // Reclaim the lock of a process that provably no longer exists. The
        // transaction that follows still re-reads the latest revision, so a lost
        // partial write cannot be committed as this window's values.
        try {
          const current = readLockRecord(lockPath);
          if (current !== null && current.token === record.token) fs.rmSync(lockPath, { force: true });
          reclaimedFrom = record;
          continue;
        } catch {
          /* raced with the owner; retry below */
        }
      }
    }
    if (options.now() >= deadline) {
      throw new CatalogError(
        "busy",
        "Another VS Code window is writing the OMP profile catalog, so this change was not saved. It will be retried by the next action.",
      );
    }
    await delay(15 + Math.floor(Math.random() * 25));
  }
}

function lockAgeMs(lockPath: string, now: () => number): number | null {
  try {
    return now() - fs.statSync(lockPath).mtimeMs;
  } catch {
    return null;
  }
}

function releaseLock(lockPath: string, token: string): void {
  const record = readLockRecord(lockPath);
  if (record === null || record.token !== token) return;
  try {
    fs.rmSync(lockPath, { force: true });
  } catch {
    /* the lock is left for a dead-owner reclaim; the commit already landed */
  }
}

// Commit

/**
 * Replace the document with `next`, durably.
 *
 * The new revision is written to a sibling file, flushed, and renamed over the
 * document. A reader therefore always sees a complete revision: either the old one
 * or the new one, never a partial write, and a crash leaves the previous revision
 * in place.
 */
function commitDocument(paths: CatalogPaths, next: CatalogDocument): void {
  const staging = `${paths.document}.${process.pid}.${randomUUID()}.tmp`;
  const payload = JSON.stringify(next);
  let fd: number;
  try {
    fd = fs.openSync(staging, "w");
  } catch (error) {
    throw new CatalogError("write", `The OMP profile catalog could not be staged: ${messageOf(error)}`, { cause: error });
  }
  try {
    fs.writeSync(fd, payload);
    fs.fsyncSync(fd);
  } catch (error) {
    fs.closeSync(fd);
    fs.rmSync(staging, { force: true });
    throw new CatalogError("write", `The OMP profile catalog could not be written: ${messageOf(error)}`, { cause: error });
  }
  fs.closeSync(fd);
  try {
    // Windows refuses a replace while another process has the destination open (another window re-reading the catalog,
    // an antivirus scan, a backup tool). The rename is retried over about two seconds, then reported; the previous
    // revision is still intact either way.
    renameReplacingSync(() => fs.renameSync(staging, paths.document));
    return;
  } catch (error) {
    fs.rmSync(staging, { force: true });
    const code = (error as NodeJS.ErrnoException).code;
    const held = code === "EPERM" || code === "EACCES" || code === "EBUSY"
      ? " Another program kept the file open for too long; this window keeps the change and saves it again on its next save."
      : "";
    throw new CatalogError("write", `The OMP profile catalog could not be replaced: ${messageOf(error)}.${held}`, { cause: error });
  }
}

// Transactions

/** One legacy record a transaction refuses to apply, kept raw for recovery. */
export interface CatalogConflictDraft {
  readonly identity: string;
  readonly reason: string;
  readonly retained: unknown;
  readonly rejected: unknown;
}

/** What one transaction may read and change. */
export interface CatalogTransaction {
  /** The revision this transaction read. */
  readonly revision: number;
  /** The newest committed value of one record key. */
  latest(key: string): unknown;
  /** Replace one record key's value. */
  set(key: string, value: unknown): void;
  /** Append a raw legacy record that could not be applied. */
  addConflict(key: string, draft: CatalogConflictDraft): void;
  /** Append one legacy-source ledger entry. */
  addImport(record: CatalogImportRecord): void;
}

/** What one committed transaction produced. */
export interface CatalogCommitResult {
  readonly revision: number;
  readonly changed: boolean;
}

export interface CatalogTransactionOptions {
  readonly lockTimeoutMs?: number;
  readonly lockStaleMs?: number;
  readonly now?: () => number;
  readonly clock?: () => Date;
}

/**
 * Run one read-modify-write transaction against the newest committed document.
 *
 * `operation` returning `false` means "nothing to change": the revision is not
 * advanced and no file is written. Everything the operation does happens under the
 * lock, so two windows' operations are totally ordered and neither can compute its
 * change from a stale snapshot.
 */
export async function transactCatalog(
  paths: CatalogPaths,
  operation: (tx: CatalogTransaction) => boolean | void,
  options: CatalogTransactionOptions = {},
): Promise<CatalogCommitResult> {
  fs.mkdirSync(paths.root, { recursive: true });
  const now = options.now ?? (() => Date.now());
  const clock = options.clock ?? (() => new Date());
  const held = await acquireLock(paths.lock, {
    timeoutMs: options.lockTimeoutMs ?? CATALOG_LOCK_TIMEOUT_MS,
    staleMs: options.lockStaleMs ?? CATALOG_LOCK_STALE_MS,
    now,
  });
  try {
    const current = readCatalogDocument(paths) ?? emptyCatalogDocument();
    const records: Record<string, unknown> = { ...current.records };
    const imports: CatalogImportRecord[] = [...current.imports];
    const conflicts: CatalogConflictRecord[] = [...current.conflicts];
    const tx: CatalogTransaction = {
      revision: current.revision,
      latest: key => (Object.prototype.hasOwnProperty.call(records, key) ? records[key] : undefined),
      set: (key, value) => {
        records[key] = value;
      },
      addConflict: (key, draft) => {
        conflicts.push({
          key,
          identity: draft.identity,
          source: null,
          at: clock().toISOString(),
          reason: draft.reason,
          retained: draft.retained,
          rejected: draft.rejected,
        });
      },
      addImport: record => {
        const index = imports.findIndex(existing => existing.source === record.source);
        if (index >= 0) imports.splice(index, 1);
        imports.push(record);
      },
    };
    if (held.reclaimedFrom !== null) {
      conflicts.push({
        key: "catalog.lock",
        identity: held.reclaimedFrom.token,
        source: null,
        at: clock().toISOString(),
        reason: `reclaimed the catalog lock of process ${held.reclaimedFrom.pid} (started ${held.reclaimedFrom.at}) after it was provably gone`,
        retained: null,
        rejected: held.reclaimedFrom,
      });
    }
    const decided = operation(tx);
    if (decided === false) return { revision: current.revision, changed: false };
    const next: CatalogDocument = {
      version: CATALOG_VERSION,
      revision: current.revision + 1,
      records,
      // Both ledgers are *non-evicting*. An import tombstone that could be evicted would
      // make its source eligible again and let it resurrect a row the user removed
      // afterwards; a dropped conflict would destroy the only raw copy of a record two
      // sources disagreed about. They are therefore kept whole, and a pathological
      // number of them is a size problem to solve by retention policy, never by silently
      // forgetting an identity.
      imports,
      conflicts,
    };
    commitDocument(paths, next);
    return { revision: next.revision, changed: true };
  } finally {
    releaseLock(paths.lock, held.token);
  }
}

// Window-side store

/**
 * How one record key merges a stale window's desired value with the newest
 * committed one.
 *
 * The merger belongs to the module that owns the record, so its semantics (what
 * identity means, what may be added, what must be refused) live next to the schema
 * they apply to. `base` is the value this window last saw for the key — the
 * projection its in-memory state was derived from, or `undefined` when this
 * window's change is additive and needs no delta.
 */
export type CatalogRecordMerger = (input: {
  readonly base: unknown;
  readonly desired: unknown;
  readonly latest: unknown;
}) => CatalogMergeResult;

export interface CatalogMergeResult {
  readonly value: unknown;
  /** Raw records this merge refused to apply; kept for recovery. */
  readonly conflicts?: readonly CatalogConflictDraft[];
}

/** One record key's change inside a multi-key transaction. */
export interface CatalogChange {
  readonly key: string;
  /** Compute the value to commit from the newest committed value of that key. */
  readonly apply: (latest: unknown) => unknown;
}

export interface CatalogRefresh {
  readonly revision: number;
  /** Record keys whose committed value changed since this window last read. */
  readonly keys: readonly string[];
}

type CatalogListener = (refresh: CatalogRefresh) => void;

/** One record key's value to commit, merged by that key's own rule. */
export type CatalogRecordChange =
	| { readonly key: string; readonly desired: unknown; readonly base?: unknown }
	|	{
			readonly key: string;
			/** The snapshot this change was derived from, when the caller can name it. */
			readonly base?: unknown;
			/**
			 * Decide this record's new value from the *newest committed* value, inside the
			 * transaction. A refusal aborts the whole commit and is reported to the caller, so
			 * a change whose precondition another window has invalidated cannot be merged into
			 * the newest state as if it were still valid.
			 */
			readonly decide: (latest: unknown) => { readonly desired: unknown } | { readonly refused: string };
		};

export interface CatalogStore {
	readonly paths: CatalogPaths;
	/** The last known committed value of one record key, or the fallback. */
	get<T>(key: string, fallback?: T): T | undefined;
	/**
	 * Merge `value` into the newest committed value of one key and commit it.
	 *
	 * Rejects with {@link CatalogError} when the catalog is unavailable, the lock is
	 * contended, or an unregistered key diverged from this window's view.
	 */
	update(key: string, value: unknown, base?: unknown): Promise<void>;
	/**
	 * Commit several records in *one* revision, each merged by its own rule.
	 *
	 * Related facts that only make sense together — a settled conversation switch
	 * publishes which conversation a process serves while the broker mapping follows the
	 * same process — must not be visible to another window one revision apart: a reader
	 * between the two writes would find a row whose recorded transport serves a
	 * different conversation. One transaction removes that window.
	 */
	transactRecords(changes: readonly CatalogRecordChange[]): Promise<void>;
  /** Apply several record changes in one commit. */
  transact(changes: readonly CatalogChange[]): Promise<void>;
  /** Run one arbitrary transaction (used by the predecessor extension import). */
  run<T>(operation: (tx: CatalogTransaction) => T): Promise<{ readonly result: T; readonly changed: boolean }>;
  /** The revision this window last read or committed. */
  revision(): number;
  /** Why mutations are refused, or `null` when the catalog is usable. */
  unavailableReason(): string | null;
  /** Re-read the document; reports the change, or `null` when it did not change. */
  refresh(): Promise<CatalogRefresh | null>;
  /** The ledger entries this window last read. */
  imports(): readonly CatalogImportRecord[];
  /** The conflict records this window last read. */
  conflicts(): readonly CatalogConflictRecord[];
  onChange(listener: CatalogListener): () => void;
  /** Forget every listener; the store keeps working for direct reads. */
  close(): void;
}

export interface CatalogStoreOptions {
  readonly paths: CatalogPaths;
  readonly mergers: Readonly<Record<string, CatalogRecordMerger>>;
  readonly lockTimeoutMs?: number;
  readonly lockStaleMs?: number;
  readonly now?: () => number;
  readonly clock?: () => Date;
  /** Called once when the catalog is found unusable, for one visible report. */
  readonly onUnavailable?: (reason: string) => void;
}

function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined || left === null || right === null) return false;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

/**
 * Build this window's view of the profile catalog.
 *
 * The initial read is synchronous so activation can construct its consumers with
 * the real state in hand (a sidebar built from an empty projection would show the
 * welcome view and then flicker). Mutations are asynchronous and serialized inside
 * this window as well as across windows.
 */
export function createCatalogStore(options: CatalogStoreOptions): CatalogStore {
  const { paths, mergers } = options;
  const now = options.now ?? (() => Date.now());
  const clock = options.clock ?? (() => new Date());
  let revision = 0;
  let records: Readonly<Record<string, unknown>> = {};
  /**
   * The value this window last handed to a consumer for each key.
   *
   * A consumer writes a *delta* against the snapshot it read, so the merge base must be
   * that snapshot — not whatever is committed now. Using the committed value as the base
   * would read a record the consumer never saw as a deliberate removal by that consumer
   * and delete another window's row. Every reader (a module's load, a reload, an
   * adoption) refreshes this map, so the next write from that consumer is a delta
   * against exactly what it was derived from.
   */
  const handedOut = new Map<string, unknown>();
  let imports: readonly CatalogImportRecord[] = [];
  let conflicts: readonly CatalogConflictRecord[] = [];
  let unavailable: string | null = null;
  const listeners = new Set<CatalogListener>();
  let chain: Promise<unknown> = Promise.resolve();

  try {
    fs.mkdirSync(paths.root, { recursive: true });
    const document = readCatalogDocument(paths);
    if (document !== null) {
      records = document.records;
      imports = document.imports;
      conflicts = document.conflicts;
      revision = document.revision;
    }
  } catch (error) {
    unavailable = messageOf(error);
    options.onUnavailable?.(unavailable);
  }

  const applyDocument = (document: CatalogDocument): CatalogRefresh => {
    const changed: string[] = [];
    const keys = new Set([...Object.keys(records), ...Object.keys(document.records)]);
    for (const key of keys) {
      if (!sameValue(records[key], document.records[key])) changed.push(key);
    }
    // The pin is deliberately *not* cleared here: it is the snapshot the consumer's own
    // state was derived from, and a committed change it has not read yet must not silently
    // become its base. The pin moves when that consumer reads (`get`) or writes, which is
    // what makes its next write a delta against what it actually holds.
    records = document.records;
    imports = document.imports;
    conflicts = document.conflicts;
    revision = Math.max(revision, document.revision);
    return { revision, keys: changed };
  };

  const notify = (refresh: CatalogRefresh): void => {
    for (const listener of [...listeners]) {
      try {
        listener(refresh);
      } catch {
        /* a listener's failure must not fail the commit that published it */
      }
    }
  };

  /** Serialize every write of this window, so two of them never contend for the lock. */
  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const next = chain.then(work, work);
    chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const transact = async (
    operation: (tx: CatalogTransaction) => boolean | void,
  ): Promise<{ readonly changed: boolean; readonly revision: number }> => {
    if (unavailable !== null) {
      throw new CatalogError("unavailable", `The OMP profile catalog is unusable: ${unavailable}`);
    }
    const result = await transactCatalog(paths, operation, {
      lockTimeoutMs: options.lockTimeoutMs,
      lockStaleMs: options.lockStaleMs,
      now,
      clock,
    });
    if (result.changed) {
      const document = readCatalogDocument(paths) ?? emptyCatalogDocument();
      notify(applyDocument(document));
    } else {
      revision = Math.max(revision, result.revision);
    }
    return result;
  };

  /**
   * Merge one desired value into the transaction's newest value of that key.
   *
   * This is where the per-key rule is applied: a key with a registered merger is
   * merged, and a key without one may only be written when the committed value is the
   * one this window last saw — anything else would be exactly the stale whole-record
   * overwrite the catalog exists to prevent.
   */
  const mergeInto = (tx: CatalogTransaction, key: string, desired: unknown, base: unknown): void => {
    const merger = mergers[key];
    const latest = tx.latest(key);
    if (merger === undefined) {
      if (latest !== undefined && !sameValue(latest, base)) {
        throw new CatalogError(
          "divergence",
          `The ${key} record changed in another window and this build has no merge rule for it, so the change was not saved.`,
        );
      }
      tx.set(key, desired);
      return;
    }
    const merged = merger({ base, desired, latest });
    tx.set(key, merged.value);
    for (const conflict of merged.conflicts ?? []) tx.addConflict(key, conflict);
  };

  const store: CatalogStore = {
    paths,
    get<T>(key: string, fallback?: T): T | undefined {
      const value = records[key];
      if (value !== undefined) handedOut.set(key, value);
      return value === undefined ? fallback : (value as T);
    },
    async update(key: string, desired: unknown, namedBase?: unknown): Promise<void> {
      const merger = mergers[key];
      // The caller's own base wins: it is the snapshot the value being written was derived
      // from, which is what makes its change a *delta* rather than a claim about records it
      // never saw.
      const base = namedBase !== undefined ? namedBase : (handedOut.get(key) ?? records[key]);
      if (merger === undefined) {
        // A key with no declared merge rule must not be written over a value this
        // window never saw: that would be exactly the stale whole-snapshot
        // overwrite this catalog exists to prevent.
        if (base !== undefined && !sameValue(base, desired)) {
          throw new CatalogError(
            "divergence",
            `The ${key} record changed in another window and this build has no merge rule for it, so the change was not saved.`,
          );
        }
      }
      await enqueue(async () => {
        await transact(tx => {
          mergeInto(tx, key, desired, base);
          return true;
        });
        // What this consumer holds now is what it asked to write; the merged-in records it has
        // not adopted yet must not become the base of its next delta.
        handedOut.set(key, desired);
      });
    },
    async transactRecords(changes: readonly CatalogRecordChange[]): Promise<void> {
      if (changes.length === 0) return;
      let refusal: string | null = null;
      await enqueue(async () => {
        await transact(tx => {
          for (const change of changes) {
            if ("decide" in change) {
              const decided = change.decide(tx.latest(change.key));
              if ("refused" in decided) {
                // Nothing is committed: the caller keeps the coherent state it had and is
                // told why, instead of this window publishing half a coupled change.
                refusal = decided.refused;
                return false;
              }
              mergeInto(tx, change.key, decided.desired, change.base !== undefined ? change.base : (handedOut.get(change.key) ?? records[change.key]));
              continue;
            }
            mergeInto(tx, change.key, change.desired, change.base !== undefined ? change.base : (handedOut.get(change.key) ?? records[change.key]));
          }
          return true;
        });
      });
      if (refusal !== null) throw new CatalogError("divergence", refusal);
    },
    async transact(changes: readonly CatalogChange[]): Promise<void> {
      if (changes.length === 0) return;
      await enqueue(async () => {
        await transact(tx => {
          for (const change of changes) tx.set(change.key, change.apply(tx.latest(change.key)));
          return true;
        });
      });
    },
    async run<T>(operation: (tx: CatalogTransaction) => T) {
      let result!: T;
      const outcome = await enqueue(async () =>
        // Only a `false` return means "nothing to change"; anything else (including
        // `undefined`) commits, because the operation already set what it wanted.
        transact(tx => {
          result = operation(tx);
          return result === false ? false : true;
        }),
      );
      return { result, changed: outcome.changed };
    },
    revision: () => revision,
    unavailableReason: () => unavailable,
    async refresh(): Promise<CatalogRefresh | null> {
      let document: CatalogDocument | null;
      try {
        document = readCatalogDocument(paths);
      } catch (error) {
        unavailable = messageOf(error);
        return null;
      }
      // A document that reads cleanly again (an operator fixed it, or another
      // window replaced it) makes mutations usable once more.
      unavailable = null;
      if (document === null) return null;
      if (document.revision <= revision) {
        // Same revision: adopt the ledger without publishing a change, so a
        // conflict or import record written by a re-read is still visible.
        imports = document.imports;
        conflicts = document.conflicts;
        return null;
      }
      const refresh = applyDocument(document);
      notify(refresh);
      return refresh;
    },
    imports: () => imports,
    conflicts: () => conflicts,
    onChange(listener: CatalogListener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close(): void {
      listeners.clear();
    },
  };
  return store;
}

// Change notification

export interface CatalogWatchOptions {
  /** Debounce window that folds a replace's several events into one refresh. */
  readonly debounceMs?: number;
  readonly onError?: (detail: string) => void;
}

/**
 * Watch the catalog directory and call `onSignal` when the document changes.
 *
 * The signal is a hint only: the caller re-reads the document and compares
 * revisions, so a missed, duplicated or spurious event can only cost a refresh.
 * Returns a disposer.
 */
export function startCatalogWatch(
  paths: CatalogPaths,
  onSignal: () => void,
  options: CatalogWatchOptions = {},
): () => void {
  const debounceMs = options.debounceMs ?? 60;
  let timer: NodeJS.Timeout | null = null;
  const schedule = (): void => {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      onSignal();
    }, debounceMs);
    timer.unref?.();
  };
  let watcher: fs.FSWatcher | null = null;
  try {
    watcher = fs.watch(paths.root, { persistent: false }, (_event, filename) => {
      if (filename === null) {
        schedule();
        return;
      }
      const name = String(filename);
      if (name === path.basename(paths.document) || name.startsWith(`${path.basename(paths.document)}.`)) schedule();
    });
    watcher.on("error", error => {
      options.onError?.(`the OMP profile catalog could not be watched: ${messageOf(error)}`);
    });
  } catch (error) {
    options.onError?.(`the OMP profile catalog could not be watched: ${messageOf(error)}`);
  }
  return () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    watcher?.close();
    watcher = null;
  };
}

/** Digest of one canonical record bundle, for the import ledger. */
export function catalogDigest(value: unknown): string {
  const canonical = JSON.stringify(value, (_key, item) => {
    if (isPlainObject(item)) {
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(item).sort()) sorted[key] = item[key];
      return sorted;
    }
    return item;
  });
  return `sha256:${createHash("sha256").update(canonical ?? "null").digest("hex")}`;
}
