/**
 * OMP Desk — on-demand, folder-scoped discovery of OMP conversation files.
 *
 * This is the query behind "Resume" for one registered workspace folder, and the
 * only way this extension enumerates OMP's own session files. It is strictly
 * read-only, runs only when the user asks for that folder, and retains nothing: no
 * snapshot, no cache, no timer, no module state. `SessionIndex` remains the only
 * owner of what this extension manages, so a file this module returns is a
 * *candidate* — the caller either reuses the index row that already owns it
 * (`tabId`) or imports that exact file through the existing claim path.
 *
 * There is deliberately no global, continuously refreshed history tree: a bounded
 * global snapshot filtered by cwd would silently omit older sessions, which this
 * picker must not do. This pass instead enumerates every candidate under every
 * supported root, reads each bounded header once, keeps the files whose own header
 * records the folder, and reports what it could not read instead of presenting a
 * shorter list as complete:
 *
 * - root resolution is `resolveNativeHistoryRoots`, so coverage is the ordinary
 *   default profile (independent of an inherited named profile), the active
 *   override, every named profile, applicable XDG storage and the exact session
 *   directories the index knows;
 * - direct `*.jsonl` files and one workspace bucket below each root are scanned,
 *   with backups (`<name>.jsonl.<snowflake>.bak`), symlinks and a session's own
 *   subagent/artifact directory excluded;
 * - matches are deduplicated by canonical file identity, so one file reachable
 *   through several roots appears once;
 * - an unreadable root, bucket or file, an invalid header, a missing indexed
 *   file and a cancelled scan are all distinct, visible outcomes.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describeError, isSessionFileName, probePathKind } from "./native-history.ts";
import type { NativeHistoryRoot } from "./native-history.ts";
import { nativeHistoryEnvironment, resolveNativeHistoryRoots } from "./native-history-roots.ts";
import type { NativeHistoryEnvironment, NativeHistoryExplicitPath } from "./native-history-roots.ts";
import {
	isAbsoluteWorkspaceDirectory,
	normalizeSessionIdentityKey,
	normalizeWorkspaceDirectory,
	readSessionFileHeader,
} from "./session-index.ts";
import type { SessionFileHeader } from "./session-index.ts";
import type { SessionDeletionSubject } from "./session-lifecycle.ts";

/**
 * One materialized row the index already owns, narrowed to what this query needs.
 *
 * The caller passes *every* materialized entry of the index, not only the ones it
 * believes match: an indexed file is offered once with its existing tab, and the
 * directories the index knows are scanned even when no profile root covers them.
 */
export interface FolderHistoryIndexedEntry {
	/** Stable editor-tab identity; returned on the candidate so the caller reuses it. */
	readonly tabId: string;
	/** Exact session file the index owns, or `null` for a fileless draft. */
	readonly sessionFile: string | null;
	/**
	 * Working directory the index recorded; may be stale or an older, ambiguous
	 * value. A file that still exists is matched to a folder through its own header,
	 * so this record is only ever used for a file that is gone.
	 */
	readonly cwd: string | null;
	readonly sessionId?: string | null;
	/** OMP profile the entry's scope records; `null` for the default profile. */
	readonly profile: string | null;
	/**
	 * Exact session directories this entry knows: its effective session directory
	 * and/or an explicit `--session-dir`. They are scanned because a custom
	 * directory can sit outside every profile root.
	 */
	readonly sessionDirs?: readonly string[];
}

export type FolderHistoryCandidateSource =
	/**
	 * The index already owns this exact file; use `tabId`.
	 *
	 * Provenance only: it is **not** a presentation tier. A picker shows one row
	 * per canonical file for indexed and discovered candidates alike, with the same
	 * actions (ADR-0027) — the difference is which identity the caller reuses
	 * (`tabId`) and which file it must import.
	 */
	| "indexed"
	/** Found on disk under a supported root and not tracked yet. */
	| "discovered";

/** One session file offered for the selected folder. */
export interface FolderHistoryCandidate {
	/** Exact absolute session file. */
	readonly file: string;
	/** The cwd this row is offered under: the header-verified cwd when one matched, else the index record. */
	readonly cwd: string;
	/**
	 * Absolute working directory read from the file's header during this pass, or
	 * `null` when the file is missing, unreadable, carries no usable cwd. A caller
	 * that compares it with the selected folder can tell that the file changed.
	 */
	readonly verifiedCwd: string | null;
	/** Profile the file belongs to: the indexed scope, or the root it was found under. */
	readonly profile: string | null;
	readonly sessionId: string | null;
	readonly title: string | null;
	/** File modification time (ISO-8601), or `null` when the file could not be read. */
	readonly modifiedAt: string | null;
	readonly sizeBytes: number | null;
	/**
	 * Session directory a launch of a *discovered* file belongs in: the root it was
	 * found under, which is the directory OMP was pointed at (its own sessions root
	 * for a profile root, or the custom `--session-dir`). `null` for an indexed row:
	 * the index's own recorded scope is authoritative there, and the bucket a file
	 * happens to sit in is not the directory to pass as `--session-dir`.
	 */
	readonly sessionDir: string | null;
	readonly source: FolderHistoryCandidateSource;
	/** Existing index row for this exact file, or `null` when it must be imported. */
	readonly tabId: string | null;
	/** `false` when an indexed file is gone or unreadable, so the caller can show it as unavailable. */
	readonly available: boolean;
}

/**
 * Why a pass could not show everything it should have.
 *
 * `missing-*` names a path that is gone; `unreadable-*` names something that
 * exists but could not be read, so sessions may exist that this pass could not
 * see; `invalid-*` names a file that is readable but is not an OMP session;
 * `cancelled` means the user stopped it.
 */
export type FolderHistoryIssueKind =
	/** The folder path itself cannot be used (not an absolute path). */
	| "invalid-folder"
	/** A root that is supposed to exist does not. */
	| "missing-root"
	/** A root exists but could not be listed. */
	| "unreadable-root"
	/** A profile name in the environment or the index is not a valid OMP profile. */
	| "invalid-profile"
	/** A workspace bucket disappeared between listing the root and listing the bucket. */
	| "missing-bucket"
	/** A workspace bucket exists but could not be listed. */
	| "unreadable-bucket"
	/** A listed session file disappeared before it could be read. */
	| "missing-file"
	/** A session file exists but could not be opened or read. */
	| "unreadable-file"
	/** A listed `*.jsonl` file is readable but carries no OMP session header. */
	| "invalid-header"
	/** An indexed entry's recorded session file cannot be canonicalized (relative or malformed). */
	| "indexed-file-unusable"
	/** An indexed entry's file is gone, so its row is no longer available. */
	| "indexed-file-missing"
	/** An indexed entry's file exists but could not be opened or read. */
	| "indexed-file-unreadable"
	/** An indexed entry's file is readable but carries no OMP session header. */
	| "indexed-file-invalid"
	/** The scan was cancelled; the returned list is partial. */
	| "cancelled";

export interface FolderHistoryIssue {
	readonly kind: FolderHistoryIssueKind;
	/** Path the issue concerns, or `null` when it is not path-specific. */
	readonly path: string | null;
	readonly detail: string;
}

/**
 * Kinds that mean sessions may exist that this pass could not see.
 *
 * A declared, absent root is deliberately not one of them: nothing was hidden
 * where a directory the environment names simply does not exist. A bucket or a
 * listed file that disappeared *during* the pass is one, because it existed when
 * this pass started and its sessions are now missing from the list.
 */
const INCOMPLETE_ISSUES: Partial<Record<FolderHistoryIssueKind, true>> = {
	"invalid-folder": true,
	"unreadable-root": true,
	"missing-bucket": true,
	"unreadable-bucket": true,
	"missing-file": true,
	"unreadable-file": true,
	"indexed-file-unreadable": true,
	cancelled: true,
};

/** The outcome of one header read, with "cannot read" kept apart from "not a session". */
export type SessionFileInspection =
	/** Readable and carries an OMP session header. */
	| { readonly kind: "ok"; readonly header: SessionFileHeader; readonly modifiedAt: string; readonly sizeBytes: number }
	/** Readable but empty or without an OMP session header. */
	| { readonly kind: "invalid"; readonly detail: string; readonly modifiedAt: string; readonly sizeBytes: number }
	/** The path does not exist. */
	| { readonly kind: "missing"; readonly detail: string }
	/** The path exists but could not be opened or read (permissions, lock, I/O error). */
	| { readonly kind: "unreadable"; readonly detail: string };

export interface FolderHistoryScanOptions {
	/** Absolute registered folder the sessions must belong to. */
	readonly cwd: string;
	/** Every materialized index entry; fileless drafts are ignored. */
	readonly indexed?: readonly FolderHistoryIndexedEntry[];
	readonly signal?: AbortSignal;
	readonly isCancelled?: () => boolean;
	/** OMP path environment; the real process by default (tests inject a layout). */
	readonly environment?: Partial<NativeHistoryEnvironment>;
	readonly now?: () => Date;
	/**
	 * Directory listing used for roots and workspace buckets. Defaults to the real
	 * filesystem; injectable so "exists but cannot be listed" is testable without
	 * depending on platform permissions.
	 */
	readonly listDirectory?: (target: string) => Promise<readonly fs.Dirent[]>;
}

/** Everything one folder-scoped pass found, and everything it could not see. */
export interface FolderHistoryScan {
	/** Echo of the folder that was scanned. */
	readonly cwd: string;
	/** Matching sessions, newest first, one row per canonical exact file. */
	readonly candidates: readonly FolderHistoryCandidate[];
	/** Deduplicated by kind and path. */
	readonly issues: readonly FolderHistoryIssue[];
	/** Roots this pass scanned, for provenance. */
	readonly roots: readonly NativeHistoryRoot[];
	readonly scannedAt: string;
	/** `true` when an unreadable item or a cancellation may have hidden sessions. */
	readonly incomplete: boolean;
	readonly cancelled: boolean;
	/** Files that were listed but are not readable OMP sessions. */
	readonly skippedFiles: number;
}

interface IndexedFileState {
	readonly entry: FolderHistoryIndexedEntry;
	readonly file: string;
	readonly inspection: SessionFileInspection;
	/** Absolute header cwd when the file is readable and records one, else `null`. */
	readonly verifiedCwd: string | null;
}

interface RootScanContext {
	readonly listDirectory: (target: string) => Promise<readonly fs.Dirent[]>;
	readonly report: (kind: FolderHistoryIssueKind, target: string | null, detail: string) => void;
	readonly isCancelled: () => boolean;
}

/**
 * Canonical key for a folder path, or `null` when the value cannot be a folder.
 *
 * Empty, relative and Windows drive-relative values (`C:`, `\foo`) are refused
 * rather than resolved: an older, ambiguous index row must never be interpreted as
 * the extension host's own working directory, which is what any `path.resolve`
 * fallback would produce. Two keys are equal exactly when the index considers the
 * two paths the same folder, because both the absoluteness rule and the casing
 * rule come from `SessionIndex` rather than from a second convention here.
 */
export function canonicalFolderKey(value: string | null | undefined): string | null {
	const trimmed = value?.trim() ?? "";
	if (!isAbsoluteWorkspaceDirectory(trimmed)) return null;
	return normalizeWorkspaceDirectory(trimmed);
}

/** The value trimmed when it is a usable absolute path, `null` otherwise. */
function usableAbsolutePath(value: string | null | undefined): string | null {
	const trimmed = value?.trim() ?? "";
	return trimmed.length === 0 || canonicalFolderKey(trimmed) === null ? null : trimmed;
}

/**
 * What a deletion acts on for one Resume candidate.
 *
 * Provenance does not appear here on purpose (ADR-0027): an indexed candidate and
 * a discovered one are deleted through the same exact-file transaction, which
 * takes the canonical exclusive claim itself. An indexed candidate is named by its
 * tab — so the row can be finalized with the deletion's own held claim — and a
 * discovered one by its exact file.
 *
 * The subject is only an address. It is not permission: the transaction re-reads
 * the file's own header, the claim and the reconciler's verdict under the claim it
 * takes, and a candidate can still be refused there.
 */
export function folderHistoryDeletionSubject(candidate: FolderHistoryCandidate): SessionDeletionSubject {
	return { sessionFile: candidate.file, profile: candidate.profile, tabId: candidate.tabId };
}

/** Canonical identity of a session file, or `null` when the recorded path is unusable. */
function canonicalFileKey(file: string): string | null {
	try {
		return normalizeSessionIdentityKey(file);
	} catch {
		return null;
	}
}

/**
 * Read one session file's header, separating "cannot read" from "not a session".
 *
 * `readSessionFileHeader` answers `null` for a missing file, an unreadable one and
 * a file without a header alike, which would make a permissions failure look like
 * a stray file. The open, the stat and the bounded header read are therefore kept
 * apart here. Exported so a caller's selection-time revalidation reads a header
 * exactly the way this scan did.
 */
export async function inspectSessionFile(file: string): Promise<SessionFileInspection> {
	let handle: fs.promises.FileHandle;
	try {
		handle = await fs.promises.open(file, "r");
	} catch (error) {
		const kind = await probePathKind(file);
		if (kind === "missing") return { kind: "missing", detail: `${file} does not exist.` };
		if (kind === "directory") return { kind: "unreadable", detail: `${file} is a directory, not a session file.` };
		return { kind: "unreadable", detail: `${file} could not be opened: ${describeError(error)}` };
	}
	let sizeBytes: number;
	let modifiedAt: string;
	try {
		const stats = await handle.stat();
		if (!stats.isFile()) return { kind: "unreadable", detail: `${file} is not a regular file.` };
		sizeBytes = stats.size;
		modifiedAt = new Date(stats.mtimeMs).toISOString();
	} catch (error) {
		return { kind: "unreadable", detail: `${file} could not be inspected: ${describeError(error)}` };
	} finally {
		await handle.close();
	}
	if (sizeBytes === 0) return { kind: "invalid", detail: `${file} is empty.`, modifiedAt, sizeBytes };
	const header = await readSessionFileHeader(file);
	if (header === null) {
		return { kind: "invalid", detail: `${file} carries no readable OMP session header.`, modifiedAt, sizeBytes };
	}
	return { kind: "ok", header, modifiedAt, sizeBytes };
}

/**
 * Every session file one root holds, with no bound on buckets or files.
 *
 * Two shapes are scanned: files directly under the root (a root that *is* a
 * session directory, e.g. an explicit `--session-dir`) and files one workspace
 * directory below it (the standard `<sessions root>/<bucket>/*.jsonl` layout). A
 * directory named after a session file beside it — `<name>.jsonl` next to
 * `<name>/` — is that session's own storage, where OMP keeps subagent children
 * and artifacts, and is not descended into. Symlinks are never followed: a link
 * can cycle, and a root that escapes the scanned directory would make this
 * browser read something the user did not point it at. Backup files never match
 * `*.jsonl` and are left alone.
 */
async function listRootSessionFiles(
	root: NativeHistoryRoot,
	context: RootScanContext,
): Promise<{ files: readonly string[]; cancelled: boolean }> {
	const files: string[] = [];
	let dirents: readonly fs.Dirent[];
	try {
		dirents = await context.listDirectory(root.root);
	} catch (error) {
		const kind = await probePathKind(root.root);
		context.report(
			kind === "missing" ? "missing-root" : "unreadable-root",
			root.root,
			kind === "file" ? `${root.root} is a file, not a session directory.` : describeError(error),
		);
		return { files, cancelled: false };
	}
	const sessionNames = new Set<string>();
	const buckets: string[] = [];
	for (const dirent of dirents) {
		if (dirent.isSymbolicLink()) continue;
		if (dirent.isFile()) {
			if (isSessionFileName(dirent.name)) {
				files.push(path.join(root.root, dirent.name));
				sessionNames.add(dirent.name.slice(0, -".jsonl".length));
			}
			continue;
		}
		if (dirent.isDirectory()) buckets.push(path.join(root.root, dirent.name));
	}
	// A cancellation during the listing still returns the direct session files it
	// already enumerated; descending further is what stops.
	if (context.isCancelled()) return { files, cancelled: true };
	for (const bucket of buckets) {
		if (context.isCancelled()) return { files, cancelled: true };
		if (sessionNames.has(path.basename(bucket))) continue;
		let entries: readonly fs.Dirent[];
		try {
			entries = await context.listDirectory(bucket);
		} catch (error) {
			const kind = await probePathKind(bucket);
			context.report(
				kind === "missing" ? "missing-bucket" : "unreadable-bucket",
				bucket,
				kind === "file" ? `${bucket} is a file, not a workspace directory.` : describeError(error),
			);
			continue;
		}
		for (const entry of entries) {
			if (entry.isSymbolicLink() || !entry.isFile() || !isSessionFileName(entry.name)) continue;
			files.push(path.join(bucket, entry.name));
		}
	}
	return { files, cancelled: false };
}

function candidateForIndexed(state: IndexedFileState, matchedCwd: string): FolderHistoryCandidate {
	const stats = state.inspection.kind === "ok" || state.inspection.kind === "invalid" ? state.inspection : null;
	return {
		file: state.file,
		cwd: matchedCwd,
		verifiedCwd: state.verifiedCwd,
		profile: state.entry.profile,
		sessionId: state.inspection.kind === "ok" ? state.inspection.header.sessionId : (state.entry.sessionId ?? null),
		title: state.inspection.kind === "ok" ? state.inspection.header.title : null,
		modifiedAt: stats?.modifiedAt ?? null,
		sizeBytes: stats?.sizeBytes ?? null,
		sessionDir: null,
		source: "indexed",
		tabId: state.entry.tabId,
		available: state.inspection.kind === "ok",
	};
}

/**
 * Discover every session file whose own header records `options.cwd`.
 *
 * Indexed rows are considered first: the index owns their identity and their tab,
 * so an indexed file is never offered twice or as a new discovery. A readable
 * indexed file belongs to the folder only when its *own header* records that
 * folder — the header is what the file actually says, and a row whose cwd went
 * stale must not offer a file under a folder it has left. The one exception is a
 * file that is gone: the index's own record is all that is left of it, so it is
 * returned in the folder the record names, marked unavailable. A row whose file
 * cannot be read or carries no header proves nothing and is reported as an issue
 * rather than offered as a choice.
 */
export async function scanFolderHistory(options: FolderHistoryScanOptions): Promise<FolderHistoryScan> {
	const issues: FolderHistoryIssue[] = [];
	const reported = new Set<string>();
	const report = (kind: FolderHistoryIssueKind, target: string | null, detail: string): void => {
		const key = `${kind}\u0000${target ?? ""}`;
		if (reported.has(key)) return;
		reported.add(key);
		issues.push({ kind, path: target, detail });
	};
	const scannedAt = (options.now?.() ?? new Date()).toISOString();
	const isCancelled = (): boolean => options.signal?.aborted === true || options.isCancelled?.() === true;
	const folderKey = canonicalFolderKey(options.cwd);
	if (folderKey === null) {
		report("invalid-folder", null, `"${options.cwd}" is not an absolute folder path, so no session can be matched to it.`);
		return {
			cwd: options.cwd,
			candidates: [],
			issues,
			roots: [],
			scannedAt,
			incomplete: true,
			cancelled: false,
			skippedFiles: 0,
		};
	}
	const context: RootScanContext = {
		listDirectory:
			options.listDirectory ?? ((target: string) => fs.promises.readdir(target, { withFileTypes: true })),
		report,
		isCancelled,
	};
	const indexed = options.indexed ?? [];
	const explicitPaths: NativeHistoryExplicitPath[] = [];
	const profileHints: (string | null)[] = [];
	for (const entry of indexed) {
		profileHints.push(entry.profile);
		if (entry.sessionFile !== null && entry.sessionFile.trim().length > 0) {
			explicitPaths.push({ path: entry.sessionFile, profile: entry.profile });
		}
		for (const directory of entry.sessionDirs ?? []) {
			if (directory.trim().length > 0) explicitPaths.push({ path: directory, profile: entry.profile });
		}
	}
	const resolved = await resolveNativeHistoryRoots(
		explicitPaths,
		profileHints,
		nativeHistoryEnvironment(options.environment),
	);
	for (const diagnostic of resolved.diagnostics) {
		// The resolver reports root and profile problems only; its kinds are a subset
		// of this scan's issue kinds, so they pass through unchanged.
		report(diagnostic.kind, diagnostic.root, diagnostic.detail);
	}
	const candidates = new Map<string, FolderHistoryCandidate>();
	const indexedFiles = new Map<string, IndexedFileState>();
	let skippedFiles = 0;
	let cancelled = false;

	// Indexed rows first: the index owns their identity and tab.
	for (const entry of indexed) {
		if (isCancelled()) {
			cancelled = true;
			break;
		}
		const file = entry.sessionFile;
		// A fileless draft has no history to resume.
		if (file === null || file.trim().length === 0) continue;
		const key = canonicalFileKey(file);
		if (key === null) {
			report("indexed-file-unusable", file, `${file} is not a usable absolute session file path.`);
			continue;
		}
		if (indexedFiles.has(key)) continue;
		const inspection = await inspectSessionFile(file);
		const state: IndexedFileState = {
			entry,
			file,
			inspection,
			verifiedCwd: inspection.kind === "ok" ? usableAbsolutePath(inspection.header.cwd) : null,
		};
		indexedFiles.set(key, state);
		if (inspection.kind === "missing") {
			report("indexed-file-missing", file, `${file} no longer exists.`);
		} else if (inspection.kind === "unreadable") {
			report("indexed-file-unreadable", file, inspection.detail);
		} else if (inspection.kind === "invalid") {
			report("indexed-file-invalid", file, inspection.detail);
			skippedFiles++;
		}
		// Which folder a readable indexed row belongs to is decided by the file
		// itself: its own header must record the folder, so a stale row cwd can
		// neither move it here nor keep it here. Only a file that is gone falls back
		// to the record — the record is all that is left of it — and it is then shown
		// as unavailable. An unreadable or headerless file proves nothing and is
		// reported as an issue instead of being offered as a choice.
		let matchedCwd: string | null = null;
		if (state.verifiedCwd !== null) {
			if (canonicalFolderKey(state.verifiedCwd) === folderKey) matchedCwd = state.verifiedCwd;
		} else if (inspection.kind === "missing") {
			const recordedCwd = usableAbsolutePath(entry.cwd);
			if (recordedCwd !== null && canonicalFolderKey(recordedCwd) === folderKey) matchedCwd = recordedCwd;
		}
		if (matchedCwd === null) continue;
		candidates.set(key, candidateForIndexed(state, matchedCwd));
	}

	// Then discovery under every resolved root.
	const inspected = new Set<string>();
	for (const root of resolved.roots) {
		if (isCancelled()) {
			cancelled = true;
			break;
		}
		const listing = await listRootSessionFiles(root, context);
		// Cancellation is honoured for every candidate, not once per bucket: a single
		// workspace directory can hold thousands of session files, and a Cancel that
		// waits for the whole bucket reads files the user no longer asked for. Rows
		// already resolved stay in the result, so a cancelled pass returns the part it
		// can stand behind and says it is incomplete.
		for (const file of listing.files) {
			if (isCancelled()) {
				cancelled = true;
				break;
			}
			const key = canonicalFileKey(file);
			if (key !== null && !inspected.has(key)) {
				inspected.add(key);
				const owned = indexedFiles.get(key);
				if (owned !== undefined) {
					// The index owns this file: its row appears under the folder only when
					// the file itself proves the folder, and never as a second row.
					if (
						!candidates.has(key) &&
						owned.verifiedCwd !== null &&
						canonicalFolderKey(owned.verifiedCwd) === folderKey
					) {
						candidates.set(key, candidateForIndexed(owned, owned.verifiedCwd));
					}
				} else if (!candidates.has(key)) {
					const inspection = await inspectSessionFile(file);
					if (inspection.kind === "ok") {
						const cwd = usableAbsolutePath(inspection.header.cwd);
						if (cwd !== null && canonicalFolderKey(cwd) === folderKey) {
							candidates.set(key, {
								file,
								cwd,
								verifiedCwd: cwd,
								profile: root.profile,
								sessionId: inspection.header.sessionId,
								title: inspection.header.title,
								modifiedAt: inspection.modifiedAt,
								sizeBytes: inspection.sizeBytes,
								sessionDir: root.root,
								source: "discovered",
								tabId: null,
								available: true,
							});
						}
					} else if (inspection.kind === "invalid") {
						report("invalid-header", file, inspection.detail);
						skippedFiles++;
					} else if (inspection.kind === "unreadable") {
						report("unreadable-file", file, inspection.detail);
					} else {
						report("missing-file", file, inspection.detail);
					}
				}
			}
			// Also after the awaited header read: a cancellation that arrived while this
			// file was being read stops the pass here instead of starting the next one.
			if (isCancelled()) {
				cancelled = true;
				break;
			}
		}
		if (listing.cancelled) {
			cancelled = true;
			break;
		}
	}

	if (cancelled) report("cancelled", null, "The folder history scan was cancelled, so the list may be missing sessions.");
	const ordered = [...candidates.values()].sort((left, right) => {
		const leftTime = left.modifiedAt === null ? Number.NEGATIVE_INFINITY : Date.parse(left.modifiedAt);
		const rightTime = right.modifiedAt === null ? Number.NEGATIVE_INFINITY : Date.parse(right.modifiedAt);
		if (leftTime !== rightTime) return rightTime - leftTime;
		return left.file < right.file ? -1 : left.file > right.file ? 1 : 0;
	});
	return {
		cwd: options.cwd,
		candidates: ordered,
		issues,
		roots: resolved.roots,
		scannedAt,
		incomplete: cancelled || issues.some(issue => INCOMPLETE_ISSUES[issue.kind] === true),
		cancelled,
		skippedFiles,
	};
}
