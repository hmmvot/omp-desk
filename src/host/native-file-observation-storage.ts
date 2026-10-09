/**
 * Storage for native file observations: namespace resolution, Windows access
 * verification, consent and disablement state, and the committed journal of
 * immutable blobs and records.
 *
 * Implements the storage half of
 * [Observe Native OMP File Changes Before Offering Guarded Reversal](../../docs/designs/2026-09-24-native-file-observation-and-reversibility.md)
 * under
 * [ADR-0007](../../docs/decisions/0007-native-file-evidence-and-guarded-restore.md)
 * and, for the storage location and its trust boundary,
 * [ADR-0006](../../docs/decisions/0006-host-generated-key-peer-verified-pipe.md).
 * Four properties this file must never break:
 *
 * 1. **Nothing is stored before the gates pass.** Raw bytes require a granted,
 *    disclosure-acknowledging consent record for this exact owner/slot/
 *    workspace/session namespace *and* a storage location that passed
 *    {@link verifyNativeFileObservationStorage}. When the store inherits broader
 *    access from its parent, {@link restrictNativeFileObservationStorage}
 *    establishes the same-user rules over the store's own directories — never as
 *    a recursive rewrite, which would leave every file it reached with no access
 *    entry at all — and verifies each of them again, together with the directory
 *    that carries the store and the consent and disablement records themselves.
 *    A durable disablement marker stops capture across extension-host reloads.
 * 2. **A blob is committed before the record that references it.** Blobs are
 *    written to a temporary file, flushed and renamed into `blobs/` first; only
 *    then is the record renamed into `records/`. A crash between the two leaves
 *    an orphan blob, which maintenance collects, and never a record that points
 *    at bytes nobody can read.
 * 3. **A reader validates everything it returns.** Every record is re-parsed
 *    strictly, its id recomputed from its own contents, its namespace binding
 *    re-checked against this store, and every referenced blob re-hashed. A
 *    missing, truncated or edited blob is `unavailable`, never empty.
 * 4. **Deletion is explicit and never silent.** Retention, quota eviction and
 *    the explicit delete API are the only ways history shrinks, and the disable
 *    marker survives them unless the caller asks otherwise. Power-loss
 *    durability is not claimed from a rename alone.
 *
 * The namespace is derived from the bound identities, not from caller-chosen
 * names: `ownerId`/`slotId` are validated, and the workspace and session levels
 * are `sha256` digests of the bound workspace root and session id, so neither
 * writer nor reader can address another session's evidence by passing a
 * different string.
 */

import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { retryWindowsFileOperation } from "./file-operation-retry.ts";

import { isControlSlotId } from "./control-protocol.ts";
import {
	type PrivateStorageAclReport,
	type PrivateStorageCommandResult,
	type PrivateStorageLayout,
	type PrivateStorageProbe,
	type PrivateStorageReadiness,
	type PrivateStorageRestriction,
	describeStorageError,
	inspectLocalRoot,
	isPermittedAclPrincipal,
	parseWindowsAcl,
	restrictPrivateStorage,
	verifyPrivateStorage,
} from "./private-storage.ts";
import {
	type NativeFileObservationCommit,
	type NativeFileObservationLimits,
	type NativeFileObservationParseFailure,
	type NativeFileObservationRecord,
	nativeFileObservationRecordId,
	nativeObservationDigestBytes,
	nativeObservationDigestText,
	parseNativeFileObservationRecord,
	resolveNativeFileObservationLimits,
} from "./native-file-observation.ts";

// Namespace

export interface NativeFileObservationStoreIdentity {
	/** Extension-owned directory outside the workspace. */
	readonly storageRoot: string;
	readonly ownerId: string;
	readonly slotId: string;
	/** Absolute workspace root the consent is scoped to. */
	readonly workspaceRoot: string;
	readonly sessionId: string;
}

export interface NativeFileObservationStorePaths {
	readonly storageRoot: string;
	readonly ownerId: string;
	readonly slotId: string;
	readonly workspaceRoot: string;
	readonly workspaceDigest: string;
	readonly sessionId: string;
	readonly sessionDigest: string;
	readonly ownerDirectory: string;
	readonly slotDirectory: string;
	readonly workspaceDirectory: string;
	readonly sessionDirectory: string;
	readonly blobsDirectory: string;
	readonly recordsDirectory: string;
	readonly temporaryDirectory: string;
	readonly consentFile: string;
	readonly disabledFile: string;
}

/** Raised when a store namespace cannot be derived; the producer then stays off. */
export class NativeFileObservationStoreError extends Error {
	/** The identity field that was rejected. */
	readonly field: string;

	constructor(field: string, detail: string) {
		super(`native file observation store ${field} is ${detail}`);
		this.name = "NativeFileObservationStoreError";
		this.field = field;
	}
}

const SESSION_DIGEST_DIRECTORY_RE = /^[0-9a-f]{64}$/;
const RECORD_NAME_RE = /^(\d{12})-([0-9a-f]{64})\.json$/;
const BLOB_NAME_RE = /^[0-9a-f]{64}$/;
const RECORD_ID_RE = /^[0-9a-f]{64}$/;

function requireAbsoluteLocalRoot(value: unknown, field: string): string {
	const inspected = inspectLocalRoot(value);
	if (!inspected.ok) throw new NativeFileObservationStoreError(field, inspected.detail);
	return inspected.root;
}

/**
 * Derive the exact namespace for one owner/slot/workspace/session binding.
 *
 * The two digest levels are the binding check: both writer and reader recompute
 * them from the bound workspace root and session id, so a record stored for
 * another workspace or session can never be read as this one's evidence.
 */
export function resolveNativeFileObservationStorePaths(
	identity: NativeFileObservationStoreIdentity,
): NativeFileObservationStorePaths {
	const storageRoot = requireAbsoluteLocalRoot(identity.storageRoot, "storage root");
	const workspaceRoot = requireAbsoluteLocalRoot(identity.workspaceRoot, "workspace root");
	const relativeToWorkspace = path.relative(workspaceRoot, storageRoot);
	if (relativeToWorkspace.length === 0 || (!relativeToWorkspace.startsWith("..") && !path.isAbsolute(relativeToWorkspace))) {
		throw new NativeFileObservationStoreError("storage root", "inside the workspace it observes");
	}
	if (!isControlSlotId(identity.ownerId)) {
		throw new NativeFileObservationStoreError("owner id", "not a launch-shaped identifier");
	}
	if (!isControlSlotId(identity.slotId)) {
		throw new NativeFileObservationStoreError("slot id", "not a launch-shaped identifier");
	}
	if (typeof identity.sessionId !== "string" || identity.sessionId.length === 0 || identity.sessionId.length > 200) {
		throw new NativeFileObservationStoreError("session id", "empty or above the accepted length");
	}
	const workspaceDigest = nativeObservationDigestText(
		(process.platform === "win32" ? workspaceRoot.toLowerCase() : workspaceRoot).replaceAll(path.sep, "/"),
	);
	const sessionDigest = nativeObservationDigestText(identity.sessionId);
	const ownerDirectory = path.join(storageRoot, identity.ownerId);
	const slotDirectory = path.join(ownerDirectory, identity.slotId);
	const workspaceDirectory = path.join(slotDirectory, workspaceDigest);
	const sessionDirectory = path.join(workspaceDirectory, sessionDigest);
	return {
		storageRoot,
		ownerId: identity.ownerId,
		slotId: identity.slotId,
		workspaceRoot,
		workspaceDigest,
		sessionId: identity.sessionId,
		sessionDigest,
		ownerDirectory,
		slotDirectory,
		workspaceDirectory,
		sessionDirectory,
		blobsDirectory: path.join(sessionDirectory, "blobs"),
		recordsDirectory: path.join(sessionDirectory, "records"),
		temporaryDirectory: path.join(sessionDirectory, "tmp"),
		consentFile: path.join(sessionDirectory, "consent.json"),
		disabledFile: path.join(workspaceDirectory, "disabled.json"),
	};
}

/** The directories this store owns, deepest last. */
function namespaceDirectories(paths: NativeFileObservationStorePaths): readonly string[] {
	return [
		paths.ownerDirectory,
		paths.slotDirectory,
		paths.workspaceDirectory,
		paths.sessionDirectory,
		paths.blobsDirectory,
		paths.recordsDirectory,
		paths.temporaryDirectory,
	];
}

async function ensureDirectories(created: string[], paths: NativeFileObservationStorePaths): Promise<void> {
	for (const directory of namespaceDirectories(paths)) {
		await fs.mkdir(directory, { recursive: true, mode: 0o700 });
		created.push(directory);
	}
}

// Storage verification

/** One bounded security-tool result; the shared private-storage mechanics run the tool. */
export type NativeFileObservationCommandResult = PrivateStorageCommandResult;

export type NativeFileObservationStorageProbe = PrivateStorageProbe;

export type NativeFileObservationStorageReadiness = PrivateStorageReadiness;

export type NativeFileObservationStorageRestriction = PrivateStorageRestriction;

export type NativeFileObservationAclReport = PrivateStorageAclReport;

/** Shared SID-based access parsing and permitted-principal policy. */
export { isPermittedAclPrincipal, parseWindowsAcl };

const NATIVE_FILE_OBSERVATION_PROBE_TEXT = "omp-native-file-observation-probe";

/** This feature's store described in the terms the shared verifier takes. */
function privateStorageLayout(paths: NativeFileObservationStorePaths): PrivateStorageLayout {
	return {
		root: paths.storageRoot,
		workspaceRoot: paths.workspaceRoot,
		directories: namespaceDirectories(paths),
		// Every directory the restriction rewrites is read back, not only the
		// namespace's own session level: a directory that kept an entry beyond this
		// account, SYSTEM and Administrators must leave capture off.
		verifiedDirectories: [paths.storageRoot, ...namespaceDirectories(paths)],
		// The consent and disablement records decide whether a byte is captured at all,
		// so their own access listing is read too. A parent's rules are not proof for a
		// file: a record written while the store was broader keeps the entries it was
		// given. Retained blobs and records are left to the digest every read recomputes,
		// which reports a replaced blob even where a file's entries said nothing.
		verifiedFiles: [paths.consentFile, paths.disabledFile],
		probeDirectory: paths.temporaryDirectory,
		probeText: NATIVE_FILE_OBSERVATION_PROBE_TEXT,
	};
}

/**
 * Prove this observation store is usable before a single byte is captured: a
 * real local directory outside the workspace, not a link or reparse point, with
 * an ACL limited to the same user (plus SYSTEM and Administrators), and a write
 * probe that reads back.
 */
export async function verifyNativeFileObservationStorage(input: {
	readonly paths: NativeFileObservationStorePaths;
	readonly probe?: NativeFileObservationStorageProbe;
}): Promise<NativeFileObservationStorageReadiness> {
	return verifyPrivateStorage({
		layout: privateStorageLayout(input.paths),
		...(input.probe ? { probe: input.probe } : {}),
	});
}

/**
 * Establish the Windows access rules the observation store requires, then verify
 * them independently. Only the store's own directories are rewritten, each from
 * itself, so retained blobs and records keep the access they reach through their
 * directory — a recursive rewrite would leave every file it reached with an
 * empty access list, unreadable and undeletable. A failed or partial rewrite
 * leaves capture off rather than assumed safe. Call this from the consent flow,
 * not from a tool hook: it runs security tools and is not bounded by the
 * per-event observation budget.
 */
export async function restrictNativeFileObservationStorage(input: {
	readonly paths: NativeFileObservationStorePaths;
	readonly probe?: NativeFileObservationStorageProbe;
}): Promise<NativeFileObservationStorageRestriction> {
	return restrictPrivateStorage({
		layout: privateStorageLayout(input.paths),
		...(input.probe ? { probe: input.probe } : {}),
	});
}

// Consent and disablement

/**
 * Disclosure a user must acknowledge before any byte is captured. It names the
 * pre-approval consequence rather than burying it, because a snapshot taken at
 * admission can preserve bytes of an operation the user denies.
 */
export const NATIVE_FILE_OBSERVATION_DISCLOSURE_ID = "native-file-observation-v1";

export const NATIVE_FILE_OBSERVATION_DISCLOSURE: readonly string[] = [
	"OMP file tools will be observed: when a write or edit names a local file inside this workspace, the bytes present at that moment are read twice \u2014 once before the tool runs and once after it reports \u2014 and stored outside the workspace.",
	"These are interval observations, not exact per-tool before/after images: an observation can miss an unrelated edit, and a snapshot taken before a tool runs can preserve bytes of an operation you later deny.",
	"Stored bytes are sensitive. They stay on this machine, under the extension's own directory, readable only by your Windows account, and are removed by an explicit action or by the configured retention window.",
	"No file inside the workspace is written, and no automatic undo, redo or rollback is offered from these observations.",
];

export interface NativeFileObservationConsent {
	readonly schemaVersion: number;
	readonly disclosureId: string;
	readonly grantedAtMs: number;
	readonly workspaceDigest: string;
	readonly sessionDigest: string;
	readonly retentionMs: number;
	readonly maxTotalBlobBytes: number;
	readonly recordId: string;
}

export type NativeFileObservationConsentState =
	| { readonly state: "granted"; readonly consent: NativeFileObservationConsent; readonly reason: null }
	| { readonly state: "absent" | "mismatched" | "unreadable"; readonly consent: null; readonly reason: string };

interface BoundedRead {
	readonly ok: true;
	readonly bytes: Buffer;
}

interface FailedBoundedRead {
	readonly ok: false;
	readonly reason: "missing" | "too-large" | "unreadable";
}

type BoundedReadResult = BoundedRead | FailedBoundedRead;

/** Read at most `maxBytes` through one handle; anything larger is refused whole. */
async function readBytesBounded(file: string, maxBytes: number): Promise<BoundedReadResult> {
	let handle: FileHandle;
	try {
		handle = await fs.open(file, "r");
	} catch (error) {
		return { ok: false, reason: describeStorageError(error) === "ENOENT" ? "missing" : "unreadable" };
	}
	try {
		const buffer = Buffer.allocUnsafe(maxBytes + 1);
		let read = 0;
		for (let attempt = 0; attempt < 16 && read < buffer.length; attempt += 1) {
			const chunk = await handle.read(buffer, read, buffer.length - read, read);
			if (chunk.bytesRead <= 0) break;
			read += chunk.bytesRead;
		}
		if (read > maxBytes) return { ok: false, reason: "too-large" };
		return { ok: true, bytes: Buffer.from(buffer.subarray(0, read)) };
	} catch {
		return { ok: false, reason: "unreadable" };
	} finally {
		await handle.close().catch(() => {});
	}
}

/** Write bytes to a temporary file, flush them, then rename into place. */
async function writeFileAtomically(
	directory: string,
	temporary: string,
	name: string,
	bytes: Uint8Array,
): Promise<void> {
	const staged = path.join(temporary, `.${process.pid}-${randomUUID()}.staged`);
	const handle = await fs.open(staged, "wx", 0o600);
	try {
		await handle.writeFile(bytes);
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		await retryWindowsFileOperation(() => fs.rename(staged, path.join(directory, name)));
	} catch (error) {
		await fs.rm(staged, { force: true }).catch(() => {});
		throw error;
	}
}

/** Key order is fixed here so the consent digest is stable without a canonical encoder. */
function canonicalConsent(body: Omit<NativeFileObservationConsent, "recordId">): string {
	return JSON.stringify({
		schemaVersion: body.schemaVersion,
		disclosureId: body.disclosureId,
		grantedAtMs: body.grantedAtMs,
		workspaceDigest: body.workspaceDigest,
		sessionDigest: body.sessionDigest,
		retentionMs: body.retentionMs,
		maxTotalBlobBytes: body.maxTotalBlobBytes,
	});
}

export async function readNativeFileObservationConsent(input: {
	readonly paths: NativeFileObservationStorePaths;
}): Promise<NativeFileObservationConsentState> {
	const read = await readBytesBounded(input.paths.consentFile, 8 * 1024);
	if (!read.ok) {
		if (read.reason === "missing") return { state: "absent", consent: null, reason: "no consent has been granted" };
		return { state: "unreadable", consent: null, reason: `the consent record could not be read (${read.reason})` };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(read.bytes.toString("utf8"));
	} catch {
		return { state: "unreadable", consent: null, reason: "the consent record is not readable JSON" };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { state: "unreadable", consent: null, reason: "the consent record is not an object" };
	}
	const fields = parsed as Record<string, unknown>;
	const consent: NativeFileObservationConsent = {
		schemaVersion: typeof fields["schemaVersion"] === "number" ? fields["schemaVersion"] : -1,
		disclosureId: typeof fields["disclosureId"] === "string" ? fields["disclosureId"] : "",
		grantedAtMs: typeof fields["grantedAtMs"] === "number" ? fields["grantedAtMs"] : -1,
		workspaceDigest: typeof fields["workspaceDigest"] === "string" ? fields["workspaceDigest"] : "",
		sessionDigest: typeof fields["sessionDigest"] === "string" ? fields["sessionDigest"] : "",
		retentionMs: typeof fields["retentionMs"] === "number" ? fields["retentionMs"] : -1,
		maxTotalBlobBytes: typeof fields["maxTotalBlobBytes"] === "number" ? fields["maxTotalBlobBytes"] : -1,
		recordId: typeof fields["recordId"] === "string" ? fields["recordId"] : "",
	};
	if (consent.schemaVersion !== 1 || consent.recordId !== nativeObservationDigestText(canonicalConsent(consent))) {
		return { state: "mismatched", consent: null, reason: "the consent record does not match its own contents" };
	}
	if (consent.disclosureId !== NATIVE_FILE_OBSERVATION_DISCLOSURE_ID) {
		return { state: "mismatched", consent: null, reason: "the consent record predates the current disclosure" };
	}
	if (consent.workspaceDigest !== input.paths.workspaceDigest || consent.sessionDigest !== input.paths.sessionDigest) {
		return {
			state: "mismatched",
			consent: null,
			reason: "the consent record belongs to another workspace or session",
		};
	}
	return { state: "granted", consent, reason: null };
}

export interface NativeFileObservationConsentGrant {
	readonly granted: boolean;
	readonly reason: string | null;
	readonly consent: NativeFileObservationConsent | null;
}

/**
 * Record explicit opt-in for one workspace/session.
 *
 * Both the disclosure id and the acknowledgement flag are required, so a caller
 * cannot enable capture while claiming a stale or unacknowledged disclosure. A
 * durable disablement marker wins until the caller passes `allowReEnable`, which
 * is the explicit re-enable action rather than an implicit side effect.
 */
export async function grantNativeFileObservationConsent(input: {
	readonly paths: NativeFileObservationStorePaths;
	readonly disclosureId: unknown;
	readonly preApprovalCaptureAcknowledged: unknown;
	readonly allowReEnable?: boolean;
	readonly limits?: Partial<NativeFileObservationLimits>;
	readonly now?: () => number;
}): Promise<NativeFileObservationConsentGrant> {
	const limits = resolveNativeFileObservationLimits(input.limits);
	if (input.disclosureId !== NATIVE_FILE_OBSERVATION_DISCLOSURE_ID) {
		return { granted: false, reason: "the disclosure being acknowledged is not the current one", consent: null };
	}
	if (input.preApprovalCaptureAcknowledged !== true) {
		return { granted: false, reason: "the acknowledgement of pre-approval capture must be explicit", consent: null };
	}
	const disabled = await readNativeFileObservationDisable({ paths: input.paths });
	if (disabled.disabled && input.allowReEnable !== true) {
		return {
			granted: false,
			reason: `capture was disabled for this workspace (${disabled.reason ?? "no reason recorded"})`,
			consent: null,
		};
	}
	try {
		await ensureDirectories([], input.paths);
		if (disabled.disabled) await fs.rm(input.paths.disabledFile, { force: true });
		const body = {
			schemaVersion: 1,
			disclosureId: NATIVE_FILE_OBSERVATION_DISCLOSURE_ID,
			grantedAtMs: (input.now ?? Date.now)(),
			workspaceDigest: input.paths.workspaceDigest,
			sessionDigest: input.paths.sessionDigest,
			retentionMs: limits.retentionMs,
			maxTotalBlobBytes: limits.maxTotalBlobBytes,
		};
		const canonical = canonicalConsent(body);
		const recordId = nativeObservationDigestText(canonical);
		await writeFileAtomically(
			input.paths.sessionDirectory,
			input.paths.temporaryDirectory,
			"consent.json",
			Buffer.from(JSON.stringify({ ...body, recordId }), "utf8"),
		);
		return { granted: true, reason: null, consent: { ...body, recordId } };
	} catch (error) {
		return { granted: false, reason: `the consent record could not be stored (${describeStorageError(error)})`, consent: null };
	}
}

/** Remove the consent record, which stops capture for a surviving producer. */
export async function revokeNativeFileObservationConsent(input: {
	readonly paths: NativeFileObservationStorePaths;
}): Promise<{ readonly revoked: boolean; readonly detail: string | null }> {
	try {
		const before = await fs.lstat(input.paths.consentFile).catch(() => null);
		await fs.rm(input.paths.consentFile, { force: true });
		return { revoked: before !== null, detail: null };
	} catch (error) {
		return { revoked: false, detail: describeStorageError(error) };
	}
}

export interface NativeFileObservationDisableState {
	readonly disabled: boolean;
	readonly atMs: number | null;
	readonly reason: string | null;
}

/**
 * Durable disablement for one workspace. The marker lives one level above the
 * session namespace so it survives extension-host reloads, new sessions and
 * process restarts, and no producer captures while it exists.
 */
export async function disableNativeFileObservationCapture(input: {
	readonly paths: NativeFileObservationStorePaths;
	readonly reason: string;
	readonly now?: () => number;
}): Promise<{ readonly disabled: boolean; readonly detail: string | null }> {
	try {
		await fs.mkdir(input.paths.workspaceDirectory, { recursive: true, mode: 0o700 });
		const body = {
			disabledAtMs: (input.now ?? Date.now)(),
			reason: input.reason.slice(0, 256),
			workspaceDigest: input.paths.workspaceDigest,
		};
		await writeFileAtomically(
			input.paths.workspaceDirectory,
			input.paths.workspaceDirectory,
			"disabled.json",
			Buffer.from(JSON.stringify(body), "utf8"),
		);
		return { disabled: true, detail: null };
	} catch (error) {
		return { disabled: false, detail: describeStorageError(error) };
	}
}

export async function readNativeFileObservationDisable(input: {
	readonly paths: NativeFileObservationStorePaths;
}): Promise<NativeFileObservationDisableState> {
	const read = await readBytesBounded(input.paths.disabledFile, 4 * 1024);
	if (!read.ok) {
		return {
			disabled: false,
			atMs: null,
			reason: read.reason === "missing" ? null : `the disable marker is ${read.reason}`,
		};
	}
	try {
		const parsed = JSON.parse(read.bytes.toString("utf8")) as Record<string, unknown>;
		if (parsed["workspaceDigest"] !== input.paths.workspaceDigest) {
			return { disabled: true, atMs: null, reason: "the disable marker names another workspace" };
		}
		return {
			disabled: true,
			atMs: typeof parsed["disabledAtMs"] === "number" ? parsed["disabledAtMs"] : null,
			reason: typeof parsed["reason"] === "string" ? parsed["reason"] : null,
		};
	} catch {
		return { disabled: true, atMs: null, reason: "the disable marker could not be read" };
	}
}

// Explicit deletion

export type NativeFileObservationDeleteScope = "session" | "workspace";

export interface NativeFileObservationDeleteResult {
	readonly removedRecords: number;
	readonly removedBlobs: number;
	readonly removedNamespaces: number;
	readonly revokedConsent: boolean;
	readonly detail: string | null;
}

/**
 * Delete retained history. `session` removes this session's records, blobs and
 * consent; `workspace` removes every session namespace for this workspace. The
 * disable marker survives by default, because disablement and deletion are
 * separate visible actions.
 */
export async function deleteNativeFileObservationHistory(input: {
	readonly paths: NativeFileObservationStorePaths;
	readonly scope?: NativeFileObservationDeleteScope;
	readonly revokeConsent?: boolean;
	readonly keepDisableMarker?: boolean;
}): Promise<NativeFileObservationDeleteResult> {
	const scope = input.scope ?? "session";
	const result = {
		removedRecords: 0,
		removedBlobs: 0,
		removedNamespaces: 0,
		revokedConsent: false,
		detail: null as string | null,
	};
	const directories = scope === "session" ? [input.paths.sessionDirectory] : await sessionNamespaces(input.paths);
	if (scope === "workspace" && input.keepDisableMarker !== true) {
		await fs.rm(input.paths.disabledFile, { force: true }).catch(() => {});
	}
	for (const directory of directories) {
		try {
			result.removedRecords += await countAndRemove(path.join(directory, "records"));
			result.removedBlobs += await countAndRemove(path.join(directory, "blobs"));
			await fs.rm(path.join(directory, "tmp"), { recursive: true, force: true });
			result.removedNamespaces += 1;
			if (input.revokeConsent !== false) {
				const consent = await fs.lstat(path.join(directory, "consent.json")).catch(() => null);
				await fs.rm(path.join(directory, "consent.json"), { force: true });
				if (consent !== null) result.revokedConsent = true;
			}
		} catch (error) {
			result.detail = describeStorageError(error);
		}
	}
	return result;
}

async function sessionNamespaces(paths: NativeFileObservationStorePaths): Promise<string[]> {
	let entries: Dirent[];
	try {
		entries = await fs.readdir(paths.workspaceDirectory, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries
		.filter(entry => entry.isDirectory() && SESSION_DIGEST_DIRECTORY_RE.test(entry.name))
		.map(entry => path.join(paths.workspaceDirectory, entry.name));
}

async function countAndRemove(directory: string): Promise<number> {
	let entries: string[];
	try {
		entries = await fs.readdir(directory);
	} catch {
		return 0;
	}
	let removed = 0;
	for (const entry of entries) {
		try {
			await fs.rm(path.join(directory, entry), { force: true });
			removed += 1;
		} catch {
			// A file another process already removed is not a failure to report.
		}
	}
	return removed;
}

// Journal

export type NativeFileObservationJournalMode = "producer" | "reader";

export type NativeFileObservationPublishReason =
	| "published"
	| "invalid-commit"
	| "quota"
	| "storage-unavailable"
	| "closed";

export interface NativeFileObservationPublishResult {
	readonly published: boolean;
	readonly reason: NativeFileObservationPublishReason;
	readonly recordId: string | null;
	readonly sequence: number | null;
	readonly detail: string | null;
	readonly evictedRecords: number;
}

export interface NativeFileObservationListResult {
	readonly records: readonly NativeFileObservationRecord[];
	readonly rejected: number;
	readonly truncated: boolean;
}

export type NativeFileObservationReadFailure =
	| "invalid-request"
	| "not-found"
	| "record-too-large"
	| "corrupt-record"
	| "missing-blob"
	| "corrupt-blob"
	| "unavailable";

export type NativeFileObservationReadResult =
	| {
			readonly available: true;
			readonly record: NativeFileObservationRecord;
			/** Verified immutable bytes, or `null` when this observation stored none. */
			readonly bytes: Uint8Array | null;
	  }
	| { readonly available: false; readonly reason: NativeFileObservationReadFailure; readonly detail: string };

export type NativeFileObservationBlobResult =
	| { readonly available: true; readonly bytes: Uint8Array }
	| {
			readonly available: false;
			readonly reason: "invalid-request" | "not-found" | "corrupt-blob" | "unavailable";
			readonly detail: string;
	  };

export interface NativeFileObservationUsage {
	readonly records: number;
	readonly blobBytes: number;
	readonly oldestObservedAtMs: number | null;
}

export interface NativeFileObservationMaintenanceResult {
	readonly records: number;
	readonly blobBytes: number;
	readonly evictedRecords: number;
	readonly removedBlobs: number;
	readonly detail: string | null;
}

export interface NativeFileObservationJournal {
	readonly paths: NativeFileObservationStorePaths;
	readonly mode: NativeFileObservationJournalMode;
	/** Commit one observation; the blob is published before the record. */
	publish(commit: NativeFileObservationCommit, bytes: Uint8Array | null): Promise<NativeFileObservationPublishResult>;
	/** Newest-first validated records, bounded by `limit`. */
	list(options?: { readonly limit?: number }): Promise<NativeFileObservationListResult>;
	read(recordId: string): Promise<NativeFileObservationReadResult>;
	readBlob(blobId: string): Promise<NativeFileObservationBlobResult>;
	usage(): Promise<NativeFileObservationUsage>;
	/** Apply retention, quota and orphan collection. Producer mode only. */
	maintain(options?: { readonly applyRetention?: boolean }): Promise<NativeFileObservationMaintenanceResult>;
	deleteAll(): Promise<NativeFileObservationDeleteResult>;
	close(): Promise<void>;
}

export interface NativeFileObservationJournalOptions {
	readonly paths: NativeFileObservationStorePaths;
	readonly mode?: NativeFileObservationJournalMode;
	readonly limits?: Partial<NativeFileObservationLimits>;
	readonly now?: () => number;
}

interface JournalEntry {
	readonly sequence: number;
	readonly recordId: string;
	readonly name: string;
	readonly observedAtMs: number;
	readonly blobId: string | null;
	readonly byteLength: number;
}

/** Serialize in-process mutations so publication, eviction and deletion cannot interleave. */
function createMutationLock(): <T>(task: () => Promise<T>) => Promise<T> {
	let tail: Promise<unknown> = Promise.resolve();
	return <T>(task: () => Promise<T>): Promise<T> => {
		const run = tail.then(task, task);
		tail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	};
}

/**
 * Open one namespace. Producer mode creates the namespace, indexes it, applies
 * retention and collects orphan blobs; reader mode touches nothing and resolves
 * records lazily, so an extension-host reader can never race the producer into
 * deleting evidence it is about to show.
 */
export async function openNativeFileObservationJournal(
	options: NativeFileObservationJournalOptions,
): Promise<NativeFileObservationJournal> {
	const limits = resolveNativeFileObservationLimits(options.limits);
	const now = options.now ?? Date.now;
	const mode: NativeFileObservationJournalMode = options.mode ?? "producer";
	const paths = options.paths;
	const entries = new Map<string, JournalEntry>();
	const withLock = createMutationLock();
	let closed = false;
	let rejectedOnScan = 0;

	if (mode === "producer") await ensureDirectories([], paths);

	/**
	 * Records this store can read, ordered oldest first. A failed scan is
	 * reported rather than treated as "no records", because treating an
	 * unreadable directory as empty would make every blob look orphaned.
	 */
	async function scanRecordNames(): Promise<
		{ readonly ok: true; readonly files: ReadonlyArray<{ name: string; sequence: number; recordId: string }> } | { readonly ok: false; readonly reason: string }
	> {
		let names: string[];
		try {
			names = await fs.readdir(paths.recordsDirectory);
		} catch (error) {
			const code = describeStorageError(error);
			if (code === "ENOENT" && mode === "reader") return { ok: true, files: [] };
			return { ok: false, reason: `the record directory could not be listed (${code})` };
		}
		const found: Array<{ name: string; sequence: number; recordId: string }> = [];
		for (const name of names) {
			const match = RECORD_NAME_RE.exec(name);
			if (!match) continue;
			found.push({ name, sequence: Number.parseInt(match[1]!, 10), recordId: match[2]! });
		}
		found.sort((left, right) =>
			left.sequence === right.sequence ? (left.recordId < right.recordId ? -1 : 1) : left.sequence - right.sequence,
		);
		return { ok: true, files: found };
	}

	/** A record is evidence for this store only when it re-parses and names this namespace. */
	function recordBelongsToStore(record: NativeFileObservationRecord): boolean {
		return (
			record.session.workspaceDigest === paths.workspaceDigest &&
			nativeObservationDigestText(record.session.sessionId) === paths.sessionDigest
		);
	}

	async function loadRecord(name: string, recordId: string): Promise<NativeFileObservationRecord | null> {
		const read = await readBytesBounded(path.join(paths.recordsDirectory, name), limits.maxRecordBytes);
		if (!read.ok) return null;
		const parsed = parseNativeFileObservationRecord({
			text: read.bytes.toString("utf8"),
			expectedRecordId: recordId,
			limits,
		});
		if (!parsed.ok) return null;
		return recordBelongsToStore(parsed.record) ? parsed.record : null;
	}

	/** Rebuild the in-memory index from the newest `keep` record files. */
	async function refreshIndex(keep: number): Promise<void> {
		const scan = await scanRecordNames();
		if (!scan.ok) return;
		entries.clear();
		rejectedOnScan = 0;
		for (const file of scan.files.slice(Math.max(0, scan.files.length - keep))) {
			const record = await loadRecord(file.name, file.recordId);
			if (record === null) {
				rejectedOnScan += 1;
				continue;
			}
			entries.set(record.recordId, {
				sequence: file.sequence,
				recordId: file.recordId,
				name: file.name,
				observedAtMs: record.observedAtMs,
				blobId: record.observation.blobId,
				byteLength: record.observation.byteLength ?? 0,
			});
		}
	}

	function sortedEntries(): JournalEntry[] {
		return [...entries.values()].sort((left, right) =>
			left.sequence === right.sequence ? (left.recordId < right.recordId ? -1 : 1) : left.sequence - right.sequence,
		);
	}

	/** Quota counts stored bytes, so two observations of identical content count once. */
	function blobBytesOf(ordered: readonly JournalEntry[]): number {
		const unique = new Map<string, number>();
		for (const entry of ordered) {
			if (entry.blobId !== null) unique.set(entry.blobId, entry.byteLength);
		}
		let total = 0;
		for (const size of unique.values()) total += size;
		return total;
	}

	function referencedBlobs(): Map<string, number> {
		const referenced = new Map<string, number>();
		for (const entry of entries.values()) {
			if (entry.blobId !== null) referenced.set(entry.blobId, entry.byteLength);
		}
		return referenced;
	}

	async function removeEntry(entry: JournalEntry): Promise<number> {
		entries.delete(entry.recordId);
		await fs.rm(path.join(paths.recordsDirectory, entry.name), { force: true }).catch(() => {});
		if (entry.blobId === null || referencedBlobs().has(entry.blobId)) return 0;
		await fs.rm(path.join(paths.blobsDirectory, entry.blobId), { force: true }).catch(() => {});
		return 1;
	}

	async function evictToQuota(): Promise<number> {
		let evicted = 0;
		const budget = limits.maxJournalRecords * 2 + 8;
		for (let guard = 0; guard < budget; guard += 1) {
			const ordered = sortedEntries();
			if (entries.size <= limits.maxJournalRecords && blobBytesOf(ordered) <= limits.maxTotalBlobBytes) break;
			const oldest = ordered[0];
			if (oldest === undefined) break;
			await removeEntry(oldest);
			evicted += 1;
		}
		return evicted;
	}

	async function collectOrphanBlobs(): Promise<number> {
		let names: string[];
		try {
			names = await fs.readdir(paths.blobsDirectory);
		} catch {
			return 0;
		}
		const referenced = referencedBlobs();
		let removed = 0;
		for (const name of names) {
			if (!BLOB_NAME_RE.test(name) || referenced.has(name)) continue;
			await fs.rm(path.join(paths.blobsDirectory, name), { force: true }).catch(() => {});
			removed += 1;
		}
		return removed;
	}

	async function maintainInternal(applyRetention: boolean): Promise<NativeFileObservationMaintenanceResult> {
		let evicted = 0;
		let removedBlobs = 0;
		try {
			// Maintenance is a rebuild from disk: entries whose files another
			// process already removed must not hold quota slots here. A scan that
			// fails stops maintenance instead of making every blob look orphaned.
			const scan = await scanRecordNames();
			if (!scan.ok) return maintenanceResult(0, 0, scan.reason);
			entries.clear();
			for (const file of scan.files) {
				const record = await loadRecord(file.name, file.recordId);
				if (record === null) {
					// Unreadable bytes can never become evidence, so producer
					// maintenance drops them instead of letting them hold a quota slot.
					await fs.rm(path.join(paths.recordsDirectory, file.name), { force: true }).catch(() => {});
					evicted += 1;
					continue;
				}
				entries.set(file.recordId, {
					sequence: file.sequence,
					recordId: file.recordId,
					name: file.name,
					observedAtMs: record.observedAtMs,
					blobId: record.observation.blobId,
					byteLength: record.observation.byteLength ?? 0,
				});
			}
			if (applyRetention) {
				const cutoff = now() - limits.retentionMs;
				for (const entry of sortedEntries()) {
					if (entry.observedAtMs >= cutoff) continue;
					removedBlobs += await removeEntry(entry);
					evicted += 1;
				}
			}
			evicted += await evictToQuota();
			removedBlobs += await collectOrphanBlobs();
		} catch (error) {
			return maintenanceResult(evicted, removedBlobs, describeStorageError(error));
		}
		return maintenanceResult(evicted, removedBlobs, null);
	}

	function maintenanceResult(
		evictedRecords: number,
		removedBlobs: number,
		detail: string | null,
	): NativeFileObservationMaintenanceResult {
		const ordered = sortedEntries();
		return {
			records: ordered.length,
			blobBytes: blobBytesOf(ordered),
			evictedRecords,
			removedBlobs,
			detail,
		};
	}

	function bindCheck(commit: NativeFileObservationCommit): string | null {
		if (commit.origin.ownerId !== paths.ownerId || commit.origin.slotId !== paths.slotId) {
			return "the commit names another owner or slot";
		}
		if (
			commit.session.workspaceDigest !== paths.workspaceDigest ||
			nativeObservationDigestText(commit.session.sessionId) !== paths.sessionDigest
		) {
			return "the commit names another workspace or session";
		}
		return null;
	}

	async function storeBlob(blobId: string, bytes: Uint8Array): Promise<string | null> {
		const blobPath = path.join(paths.blobsDirectory, blobId);
		const existing = await fs.lstat(blobPath).catch(() => null);
		if (existing === null) {
			await writeFileAtomically(paths.blobsDirectory, paths.temporaryDirectory, blobId, bytes);
			return null;
		}
		if (!existing.isFile()) return "the blob path is occupied by something that is not a file";
		if (existing.size !== bytes.length) return "a stored blob with this digest has a different length";
		return null;
	}

	async function readBlobFromStore(blobId: string, expectedLength: number): Promise<NativeFileObservationBlobResult> {
		if (typeof blobId !== "string" || !BLOB_NAME_RE.test(blobId)) {
			return { available: false, reason: "invalid-request", detail: "the blob id is not a digest" };
		}
		const read = await readBytesBounded(path.join(paths.blobsDirectory, blobId), limits.maxObservedBlobBytes);
		if (!read.ok) {
			if (read.reason === "missing") {
				return { available: false, reason: "not-found", detail: "the referenced blob is not present" };
			}
			if (read.reason === "too-large") {
				return { available: false, reason: "corrupt-blob", detail: "the blob exceeds the observation cap" };
			}
			return { available: false, reason: "unavailable", detail: "the blob could not be read" };
		}
		if (expectedLength >= 0 && read.bytes.length !== expectedLength) {
			return { available: false, reason: "corrupt-blob", detail: "the blob length does not match the record" };
		}
		if (nativeObservationDigestBytes(read.bytes) !== blobId) {
			return { available: false, reason: "corrupt-blob", detail: "the blob content does not match its digest" };
		}
		return { available: true, bytes: read.bytes };
	}

	if (mode === "producer") {
		await withLock(() => maintainInternal(true));
	} else {
		await refreshIndex(limits.maxJournalRecords);
	}

	return {
		paths,
		mode,
		async publish(commit, bytes) {
			if (closed) {
				return {
					published: false,
					reason: "closed",
					recordId: null,
					sequence: null,
					detail: "the journal is closed",
					evictedRecords: 0,
				};
			}
			if (mode !== "producer") {
				return {
					published: false,
					reason: "storage-unavailable",
					recordId: null,
					sequence: null,
					detail: "a read-only journal never publishes",
					evictedRecords: 0,
				};
			}
			const invalid = bindCheck(commit) ?? validateCommit(commit, bytes, limits);
			if (invalid !== null) {
				return { published: false, reason: "invalid-commit", recordId: null, sequence: null, detail: invalid, evictedRecords: 0 };
			}
			return withLock(async () => {
				let evicted = 0;
				try {
					const ordered = sortedEntries();
					const saturated =
						entries.size >= limits.maxJournalRecords || blobBytesOf(ordered) >= limits.maxTotalBlobBytes;
					if (saturated) {
						// Only rebuild at the quota boundary, so the common publish
						// path stays a bounded write instead of a directory scan.
						await refreshIndex(limits.maxJournalRecords);
						evicted += await evictToQuota();
					}
					const projectedBlobBytes = blobBytesOf(sortedEntries()) + (bytes === null ? 0 : bytes.length);
					if (projectedBlobBytes > limits.maxTotalBlobBytes && bytes !== null && bytes.length > 0) {
						return {
							published: false,
							reason: "quota",
							recordId: null,
							sequence: null,
							detail: `one observation of ${bytes.length} bytes does not fit the remaining blob quota`,
							evictedRecords: evicted,
						};
					}
					if (bytes !== null && commit.observation.blobId !== null) {
						const failure = await storeBlob(commit.observation.blobId, bytes);
						if (failure !== null) {
							return {
								published: false,
								reason: "storage-unavailable",
								recordId: null,
								sequence: null,
								detail: failure,
								evictedRecords: evicted,
							};
						}
					}
					const sequence = (sortedEntries().at(-1)?.sequence ?? 0) + 1;
					const body = {
						schemaVersion: 1,
						sequence,
						stage: commit.stage,
						observedAtMs: commit.observedAtMs,
						committedAtMs: now(),
						origin: commit.origin,
						session: commit.session,
						toolCall: commit.toolCall,
						target: commit.target,
						observation: commit.observation,
						toolOutcome: commit.toolOutcome,
						notes: commit.notes ?? [],
					};
					const recordId = nativeFileObservationRecordId(body);
					const text = `${JSON.stringify({ ...body, recordId })}\n`;
					if (Buffer.byteLength(text, "utf8") > limits.maxRecordBytes) {
						return {
							published: false,
							reason: "invalid-commit",
							recordId: null,
							sequence: null,
							detail: "the serialized record is above the record size cap",
							evictedRecords: evicted,
						};
					}
					const name = `${String(sequence).padStart(12, "0")}-${recordId}.json`;
					await writeFileAtomically(paths.recordsDirectory, paths.temporaryDirectory, name, Buffer.from(text, "utf8"));
					entries.set(recordId, {
						sequence,
						recordId,
						name,
						observedAtMs: commit.observedAtMs,
						blobId: commit.observation.blobId,
						byteLength: commit.observation.byteLength ?? 0,
					});
					evicted += await evictToQuota();
					return { published: true, reason: "published", recordId, sequence, detail: null, evictedRecords: evicted };
				} catch (error) {
					return {
						published: false,
						reason: "storage-unavailable",
						recordId: null,
						sequence: null,
						detail: describeStorageError(error),
						evictedRecords: evicted,
					};
				}
			});
		},
		async list(listOptions) {
			const limit = Math.max(1, Math.min(listOptions?.limit ?? limits.maxReaderRecords, limits.maxReaderRecords));
			const scan = await scanRecordNames();
			if (!scan.ok) return { records: [], rejected: 0, truncated: false };
			const selected = scan.files.slice(Math.max(0, scan.files.length - limit));
			const records: NativeFileObservationRecord[] = [];
			let unreadable = 0;
			for (const file of selected) {
				const record = await loadRecord(file.name, file.recordId);
				if (record === null) unreadable += 1;
				else records.push(record);
			}
			records.reverse();
			return { records, rejected: unreadable + rejectedOnScan, truncated: scan.files.length > limit };
		},
		async read(recordId) {
			if (typeof recordId !== "string" || !RECORD_ID_RE.test(recordId)) {
				return { available: false, reason: "invalid-request", detail: "the record id is not a digest" };
			}
			const scan = await scanRecordNames();
			const file = scan.ok ? scan.files.find(candidate => candidate.recordId === recordId) : undefined;
			if (file === undefined) {
				return {
					available: false,
					reason: scan.ok ? "not-found" : "unavailable",
					detail: scan.ok ? "no committed record carries this id" : scan.reason,
				};
			}
			const read = await readBytesBounded(path.join(paths.recordsDirectory, file.name), limits.maxRecordBytes);
			if (!read.ok) {
				if (read.reason === "missing") {
					return { available: false, reason: "not-found", detail: "the record was removed before it could be read" };
				}
				if (read.reason === "too-large") {
					return { available: false, reason: "record-too-large", detail: "the record exceeds the record size cap" };
				}
				return { available: false, reason: "unavailable", detail: "the record could not be read" };
			}
			const parsed = parseNativeFileObservationRecord({
				text: read.bytes.toString("utf8"),
				expectedRecordId: recordId,
				limits,
			});
			if (!parsed.ok) return { available: false, reason: "corrupt-record", detail: parseFailureDetail(parsed.reason) };
			if (!recordBelongsToStore(parsed.record)) {
				return {
					available: false,
					reason: "corrupt-record",
					detail: "the record names another workspace or session",
				};
			}
			const blobId = parsed.record.observation.blobId;
			if (blobId === null) return { available: true, record: parsed.record, bytes: null };
			const blob = await readBlobFromStore(blobId, parsed.record.observation.byteLength ?? -1);
			if (!blob.available) {
				return {
					available: false,
					reason: blob.reason === "not-found" ? "missing-blob" : "corrupt-blob",
					detail: blob.detail,
				};
			}
			return { available: true, record: parsed.record, bytes: blob.bytes };
		},
		async readBlob(blobId) {
			return readBlobFromStore(blobId, -1);
		},
		async usage() {
			const ordered = sortedEntries();
			return {
				records: ordered.length,
				blobBytes: blobBytesOf(ordered),
				oldestObservedAtMs: ordered.length === 0 ? null : ordered[0]!.observedAtMs,
			};
		},
		async maintain(maintainOptions) {
			if (mode !== "producer") {
				const ordered = sortedEntries();
				return {
					records: ordered.length,
					blobBytes: blobBytesOf(ordered),
					evictedRecords: 0,
					removedBlobs: 0,
					detail: "a read-only journal never deletes evidence",
				};
			}
			return withLock(() => maintainInternal(maintainOptions?.applyRetention ?? true));
		},
		async deleteAll() {
			return withLock(async () => {
				const result = await deleteNativeFileObservationHistory({
					paths,
					scope: "session",
					revokeConsent: false,
				});
				entries.clear();
				return result;
			});
		},
		async close() {
			closed = true;
			entries.clear();
		},
	};
}

function parseFailureDetail(reason: NativeFileObservationParseFailure): string {
	switch (reason) {
		case "malformed-json":
			return "the record is not readable JSON";
		case "unsupported-schema":
			return "the record was written by another schema version";
		case "record-id-mismatch":
			return "the record does not match its own id";
		default:
			return "the record has an invalid field";
	}
}

/**
 * Refuse a commit whose declared facts do not match the bytes handed over, so a
 * mismatch is never stored as evidence.
 */
function validateCommit(
	commit: NativeFileObservationCommit,
	bytes: Uint8Array | null,
	limits: NativeFileObservationLimits,
): string | null {
	if (commit.stage !== "admission-observed" && commit.stage !== "observed-post-result") {
		return "the stage is not a recognized read interval";
	}
	if (commit.toolOutcome !== "unknown" && commit.toolOutcome !== "success" && commit.toolOutcome !== "error" && commit.toolOutcome !== "denied") {
		return "the tool outcome is not recognized";
	}
	if (!Number.isSafeInteger(commit.observedAtMs) || commit.observedAtMs < 0) return "the observation time is not a timestamp";
	if (commit.target.raw.length === 0) return "the recorded raw path is empty";
	if (commit.target.raw.length > limits.maxRawPathChars) return "the recorded raw path is above the accepted length";
	if ((commit.notes ?? []).length > 8) return "too many record notes";
	for (const note of commit.notes ?? []) {
		if (note.length === 0 || note.length > 256) return "a record note is empty or too long";
	}
	const facts = commit.observation;
	if (bytes === null) {
		if (facts.blobId !== null || facts.byteLength !== null) return "the commit declares bytes that were not supplied";
		return null;
	}
	if (facts.blobId === null || facts.byteLength === null) return "the commit supplies bytes without a digest";
	if (facts.consistency !== "stable") return "only a stable read may be stored";
	if (bytes.length !== facts.byteLength) return "the supplied byte length does not match the commit";
	if (bytes.length > limits.maxObservedBlobBytes) return "the supplied bytes are above the observation cap";
	if (nativeObservationDigestBytes(bytes) !== facts.blobId) return "the supplied bytes do not match the declared digest";
	return null;
}
