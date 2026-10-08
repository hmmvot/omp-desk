/**
 * Native file-observation policy: which tool targets may be read, how far a
 * read may go, and how one observation is described.
 *
 * Implements the observation half of
 * [Observe Native OMP File Changes Before Offering Guarded Reversal](../../docs/designs/2026-09-24-native-file-observation-and-reversibility.md)
 * under
 * [ADR-0007](../../docs/decisions/0007-native-file-evidence-and-guarded-restore.md).
 * Three properties this file must never break:
 *
 * 1. **A record is an interval observation, never an attributed pre/post
 *    image.** {@link NativeObservationStage} names the read interval
 *    (`admission-observed` before tool execution, `observed-post-result`
 *    after), and nothing here claims authorship, an instantaneous filesystem
 *    state or an atomic snapshot. `consistency` reports only what was compared
 *    around the read, and the stored bytes are the bytes one bounded read
 *    returned.
 * 2. **Unsupported targets fail closed.** Internal/remote URLs, UNC and device
 *    paths, alternate data streams, archive members, database files, glob
 *    patterns, links, reparse points, hard links and paths outside the
 *    consented workspace are classified and reported, never guessed at. A
 *    malformed path must never cause the producer to read an unrelated file.
 * 3. **Bounded.** Every read is capped in bytes, every record in size, every
 *    tool event in candidate count, and the caller caps wall-clock time. An
 *    oversize or unstable read stores no bytes at all rather than a partial or
 *    racy image.
 *
 * The OMP extension surface this is written against (not imported: the bundle
 * must run inside the OMP process without resolving OMP packages), as of
 * OMP 18.2.11: `tool_call` carries `toolCallId`/`toolName`/`input` and can
 * block, while `tool_result` carries `toolCallId`/`input`/`content`/`isError`
 * (pi-coding-agent `src/extensibility/extensions/types.ts`). A `tool_call`
 * handler that times out blocks the tool (`extensions/runner.ts`), which is
 * why nothing here is allowed to throw or wait unboundedly on a tool's behalf.
 *
 * `write` takes `{ path, content }` (`tools/write.ts`) and `edit` takes a
 * top-level `path` for its replace and patch forms, while its
 * `apply_patch`/hashline/sloppy forms embed their targets in patch text
 * (`edit/schemas.ts`) and `ast_edit` takes patterns or directories
 * (`tools/ast-edit.ts`). Only a directly named local file is addressable; the
 * embedded and pattern forms are reported as unaddressable instead of being
 * resolved approximately.
 */

import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { createHash } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";

import { canonicalJson } from "./control-protocol.ts";

// Limits

/**
 * Every bound the producer applies. Values are per-process configuration, and
 * {@link resolveNativeFileObservationLimits} refuses anything that is not a
 * positive integer within {@link NATIVE_FILE_OBSERVATION_LIMIT_CEILINGS}, so a
 * caller cannot raise a limit past the hard ceiling by passing garbage.
 */
export interface NativeFileObservationLimits {
	/** Largest file whose bytes may be stored. Larger files are reported, not read. */
	readonly maxObservedBlobBytes: number;
	/** Candidate targets considered for one tool event. */
	readonly maxPathsPerToolCall: number;
	/** Wall-clock budget the caller enforces around one tool event. */
	readonly maxObservationMs: number;
	/** Largest serialized record, enforced before publication. */
	readonly maxRecordBytes: number;
	/** Retained record count for one owner/slot/workspace/session namespace. */
	readonly maxJournalRecords: number;
	/** Retained blob bytes for one owner/slot/workspace/session namespace. */
	readonly maxTotalBlobBytes: number;
	/** Records a single reader call may return. */
	readonly maxReaderRecords: number;
	/** Age after which a record is deleted by maintenance. */
	readonly retentionMs: number;
	/** Largest raw path string accepted from a tool event. */
	readonly maxRawPathChars: number;
}

export const NATIVE_FILE_OBSERVATION_LIMITS: NativeFileObservationLimits = {
	// 4 MiB covers ordinary source files while keeping one observation cheap;
	// anything larger is reported as above the byte cap and stores nothing.
	maxObservedBlobBytes: 4 * 1024 * 1024,
	maxPathsPerToolCall: 8,
	maxObservationMs: 2000,
	maxRecordBytes: 32 * 1024,
	maxJournalRecords: 2048,
	maxTotalBlobBytes: 256 * 1024 * 1024,
	maxReaderRecords: 64,
	retentionMs: 7 * 24 * 60 * 60 * 1000,
	maxRawPathChars: 512,
};

/** Hard ceilings a caller may configure up to, never past. */
export const NATIVE_FILE_OBSERVATION_LIMIT_CEILINGS: NativeFileObservationLimits = {
	maxObservedBlobBytes: 64 * 1024 * 1024,
	maxPathsPerToolCall: 64,
	maxObservationMs: 10_000,
	maxRecordBytes: 256 * 1024,
	maxJournalRecords: 65_536,
	maxTotalBlobBytes: 2 * 1024 * 1024 * 1024,
	maxReaderRecords: 1024,
	retentionMs: 365 * 24 * 60 * 60 * 1000,
	maxRawPathChars: 4096,
};

/** Raised when a configured limit is not usable; callers fail closed instead. */
export class NativeFileObservationConfigurationError extends Error {
	/** The limit that was rejected. */
	readonly field: string;

	constructor(field: string, detail: string) {
		super(`native file observation limit ${field} is ${detail}`);
		this.name = "NativeFileObservationConfigurationError";
		this.field = field;
	}
}

/** Validate overrides against the hard ceilings; throws on anything unusable. */
export function resolveNativeFileObservationLimits(
	overrides?: Partial<NativeFileObservationLimits>,
): NativeFileObservationLimits {
	if (overrides === undefined) return NATIVE_FILE_OBSERVATION_LIMITS;
	const resolved: Record<string, number> = { ...NATIVE_FILE_OBSERVATION_LIMITS };
	for (const key of Object.keys(NATIVE_FILE_OBSERVATION_LIMIT_CEILINGS) as (keyof NativeFileObservationLimits)[]) {
		const provided = overrides[key];
		if (provided === undefined) continue;
		const ceiling = NATIVE_FILE_OBSERVATION_LIMIT_CEILINGS[key];
		if (!Number.isSafeInteger(provided) || provided <= 0) {
			throw new NativeFileObservationConfigurationError(key, `not a positive integer (${String(provided)})`);
		}
		if (provided > ceiling) {
			throw new NativeFileObservationConfigurationError(key, `above the hard ceiling of ${ceiling}`);
		}
		resolved[key] = provided;
	}
	return resolved as unknown as NativeFileObservationLimits;
}

// Digests

const HEX64_RE = /^[0-9a-f]{64}$/;

/** `sha256` over raw bytes, hex encoded. Blob ids are exactly this. */
export function nativeObservationDigestBytes(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/** `sha256` over UTF-8 text, hex encoded. */
export function nativeObservationDigestText(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

/** `sha256` over the canonical JSON encoding of a value. */
export function nativeObservationDigestValue(value: unknown): string {
	return nativeObservationDigestText(canonicalJson(value));
}

/** True for a 64-character lowercase hex digest; narrows so ids are never guesses. */
export function isNativeObservationDigest(value: unknown): value is string {
	return typeof value === "string" && HEX64_RE.test(value);
}

/**
 * Path-identity digest. On Windows the comparison is case-insensitive and
 * separator-normalized, matching the claim-identity folding in
 * `normalizeClaimIdentity` (`./session-claim.ts`), so `C:\A\b` and `c:/a/B`
 * bind to one digest instead of producing two records for one file.
 */
export function nativeObservationPathDigest(absolutePath: string, platform: NodeJS.Platform = process.platform): string {
	const api = platformPath(platform);
	const resolved = api.resolve(absolutePath).replaceAll(api.sep, "/");
	return nativeObservationDigestText(platform === "win32" ? resolved.toLowerCase() : resolved);
}

// Target classification

/**
 * How a target named by a tool is treated. Only `regular-local-file` may be
 * read; every other kind is recorded as metadata-only with a reason, because a
 * wrong guess here would read bytes the tool never meant to name.
 */
export type NativeObservationTargetKind =
	| "regular-local-file"
	| "empty-path"
	| "internal-url"
	| "ssh"
	| "unc-or-device"
	| "alternate-data-stream"
	| "archive-member"
	| "sqlite-database"
	| "unsupported-path-shape"
	| "outside-workspace";

export interface NativeObservationTarget {
	/** Bounded, exactly as the tool supplied it (never truncated). */
	readonly raw: string;
	readonly kind: NativeObservationTargetKind;
	/** Absolute resolved path, present only when the target is a local path shape. */
	readonly absolutePath: string | null;
	/** Workspace-relative label with `/` separators, for display only. */
	readonly displayPath: string | null;
	readonly byteCaptureAllowed: boolean;
	readonly unavailableReason: string | null;
}

export interface ClassifyNativeObservationTargetInput {
	readonly rawPath: unknown;
	readonly cwd: string;
	readonly workspaceRoot: string;
	readonly platform?: NodeJS.Platform;
	readonly limits?: Partial<NativeFileObservationLimits>;
}

/** `scheme://rest` or `scheme:/rest`, the write tool's own URI grammar (pi-coding-agent `tools/write.ts`). */
const URI_LIKE_RE = /^([A-Za-z][A-Za-z0-9+.-]*):\/{1,2}(.*)$/;
const WINDOWS_DRIVE_PATH_RE = /^[A-Za-z]:[\\/]/;
const DEVICE_PREFIX_RE = /^[\\/]{2}[.?][\\/]/;
const UNC_PREFIX_RE = /^[\\/]{2}/;
const RESERVED_DEVICE_NAME_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.[^\\/]*)?$/i;
const GLOB_CHAR_RE = /[*?[\]{}]/;
const TILDE_PREFIX_RE = /^~([\\/]|$)/;

/** Container extensions whose `file.ext:member` form rewrites the whole archive. */
const ARCHIVE_EXTENSIONS: Record<string, true> = {
	".zip": true, ".zipx": true, ".tar": true, ".gz": true, ".tgz": true, ".bz2": true, ".tbz2": true,
	".xz": true, ".txz": true, ".zst": true, ".7z": true, ".rar": true, ".jar": true, ".war": true,
	".ear": true, ".whl": true, ".apk": true, ".aar": true, ".asar": true, ".nupkg": true, ".vsix": true,
	".deb": true, ".rpm": true, ".iso": true, ".cab": true, ".cpio": true, ".lzh": true, ".ar": true, ".a": true,
};

/** Database extensions; OMP detects databases by content, this is the name-level gate. */
const DATABASE_EXTENSIONS: Record<string, true> = {
	".sqlite": true, ".sqlite3": true, ".db": true, ".db3": true, ".s3db": true, ".sl3": true,
};

function platformPath(platform: NodeJS.Platform): typeof path.posix {
	return platform === "win32" ? path.win32 : path.posix;
}

/** Build the classification result; `byteCaptureAllowed` is derived, never passed. */
function classifyTarget(
	raw: string,
	kind: NativeObservationTargetKind,
	reason: string | null,
	absolutePath: string | null = null,
	displayPath: string | null = null,
): NativeObservationTarget {
	return {
		raw,
		kind,
		absolutePath,
		displayPath,
		byteCaptureAllowed: kind === "regular-local-file" && absolutePath !== null,
		unavailableReason: kind === "regular-local-file" ? null : reason,
	};
}

function expandTilde(raw: string, platform: NodeJS.Platform): string {
	if (!TILDE_PREFIX_RE.test(raw)) return raw;
	const home = os.homedir();
	if (raw === "~") return home;
	return platformPath(platform).join(home, raw.slice(2));
}

/**
 * Classify one tool-named target. The order of the checks is the safety
 * argument: nothing is resolved to a filesystem path until the string is known
 * to be a plain local path shape inside the consented workspace.
 */
export function classifyNativeObservationTarget(
	input: ClassifyNativeObservationTargetInput,
): NativeObservationTarget {
	const platform = input.platform ?? process.platform;
	const limits = resolveNativeFileObservationLimits(input.limits);
	const api = platformPath(platform);
	const win32 = platform === "win32";
	const workspaceRoot = api.resolve(input.workspaceRoot);
	const cwd = api.resolve(input.cwd);
	const raw = typeof input.rawPath === "string" ? input.rawPath.trim() : "";

	if (raw.length === 0) return classifyTarget(raw, "empty-path", "the tool named no path");
	if (raw.length > limits.maxRawPathChars) {
		return classifyTarget(raw, "unsupported-path-shape", "the path is above the accepted length");
	}
	if (DEVICE_PREFIX_RE.test(raw)) {
		return classifyTarget(raw, "unc-or-device", "device and namespace paths are never read");
	}
	if (UNC_PREFIX_RE.test(raw)) {
		return classifyTarget(raw, "unc-or-device", "network and device paths are never read");
	}
	if (URI_LIKE_RE.test(raw) && !WINDOWS_DRIVE_PATH_RE.test(raw)) {
		if (/^ssh:\/\//i.test(raw)) return classifyTarget(raw, "ssh", "remote targets are never read");
		return classifyTarget(raw, "internal-url", "internal, virtual and remote URLs are never read");
	}
	if (win32) {
		if (/^[A-Za-z]:/.test(raw) && !WINDOWS_DRIVE_PATH_RE.test(raw)) {
			return classifyTarget(raw, "unsupported-path-shape", "drive-relative paths are ambiguous");
		}
		if (raw.startsWith("/") || raw.startsWith("\\")) {
			return classifyTarget(raw, "unsupported-path-shape", "root-relative paths are ambiguous on Windows");
		}
	}
	if (GLOB_CHAR_RE.test(raw)) {
		return classifyTarget(raw, "unsupported-path-shape", "patterns and globs do not name one file");
	}
	const basename = raw.slice(raw.replaceAll("\\", "/").lastIndexOf("/") + 1);
	if (win32 && RESERVED_DEVICE_NAME_RE.test(basename)) {
		return classifyTarget(raw, "unc-or-device", "reserved device names are never read");
	}
	const relativeToDrive = win32 ? raw.slice(2) : raw;
	const colon = win32 ? relativeToDrive.indexOf(":") : -1;
	if (colon >= 0) {
		const extension = api.extname(relativeToDrive.slice(0, colon)).toLowerCase();
		if (Object.hasOwn(ARCHIVE_EXTENSIONS, extension)) {
			return classifyTarget(raw, "archive-member", "archive members are rewritten as whole archives");
		}
		if (Object.hasOwn(DATABASE_EXTENSIONS, extension)) {
			return classifyTarget(raw, "sqlite-database", "database rows are not a file byte image");
		}
		return classifyTarget(raw, "alternate-data-stream", "alternate data streams are never read");
	}
	if (/[\\/]$/.test(raw)) {
		return classifyTarget(raw, "unsupported-path-shape", "a directory was named, not a file");
	}

	const absolute = api.resolve(cwd, expandTilde(raw, platform));
	const relative = api.relative(workspaceRoot, absolute);
	const insideWorkspace = relative.length > 0 && relative !== ".." && !relative.startsWith("..") && !api.isAbsolute(relative);
	if (!insideWorkspace) {
		return classifyTarget(raw, "outside-workspace", "the target is outside the consented workspace");
	}
	return classifyTarget(raw, "regular-local-file", null, absolute, relative.replaceAll(api.sep, "/"));
}

// Tool-event target extraction

export interface NativeObservationTargetExtraction {
	/** Raw path strings, at most `maxPathsPerToolCall`, in tool order. */
	readonly rawPaths: readonly string[];
	/** Why no target could be named, when `rawPaths` is empty. */
	readonly unaddressableReason: string | null;
}

/** `edit` forms whose targets live inside patch text rather than a `path` field. */
const EMBEDDED_EDIT_REASON =
	"this edit form embeds its targets in patch text (apply_patch/hashline/sloppy), so no single file can be resolved";

/**
 * Extract the directly named local-file targets of a tool event.
 *
 * Only `write` and `edit` name a file in their input contract. Everything else
 * (bash, eval, MCP, custom tools, `ast_edit` patterns, embedded patch text) is
 * reported as unaddressable rather than approximated, because a mis-resolved
 * path would read a file the tool never named.
 */
export function extractNativeObservationTargets(input: {
	readonly toolName: unknown;
	readonly input: unknown;
	readonly limits?: Partial<NativeFileObservationLimits>;
}): NativeObservationTargetExtraction {
	const limits = resolveNativeFileObservationLimits(input.limits);
	const toolName = typeof input.toolName === "string" ? input.toolName : "";
	const candidate = input.input;
	const named =
		typeof candidate === "object" && candidate !== null && !Array.isArray(candidate)
			? (candidate as { path?: unknown }).path
			: undefined;
	const path = typeof named === "string" ? named.trim() : "";
	const rawPaths = path.length > 0 ? [path].slice(0, limits.maxPathsPerToolCall) : [];
	if (rawPaths.length > 0 && (toolName === "write" || toolName === "edit")) {
		return { rawPaths, unaddressableReason: null };
	}
	if (toolName === "write") return { rawPaths: [], unaddressableReason: "the write call named no usable path" };
	if (toolName === "edit") return { rawPaths: [], unaddressableReason: EMBEDDED_EDIT_REASON };
	if (toolName === "ast_edit") {
		return {
			rawPaths: [],
			unaddressableReason:
				"ast_edit targets may be patterns, directories or internal URLs and its write may be deferred to a later resolve",
		};
	}
	return {
		rawPaths: [],
		unaddressableReason: `tool ${toolName.length > 0 ? toolName : "<unknown>"} has no per-file target contract`,
	};
}

// Bounded observation of one file

export type NativeObservationPresence = "absent" | "file" | "directory" | "unsupported" | "unknown";
export type NativeObservationConsistency = "stable" | "unstable" | "unknown";
export type NativeFileObservationContentKind = "empty" | "text" | "binary" | "unknown";

export interface NativeObservedFileState {
	readonly presence: NativeObservationPresence;
	/** What was actually compared around the read; never a claim of atomicity. */
	readonly consistency: NativeObservationConsistency;
	readonly contentKind: NativeFileObservationContentKind;
	/** Bytes in {@link bytes}, or `null` when nothing was captured. */
	readonly byteLength: number | null;
	/** `sha256` of {@link bytes}, or `null` when nothing was captured. */
	readonly blobId: string | null;
	/** The bytes one bounded read returned; `null` unless the read was stable. */
	readonly bytes: Uint8Array | null;
	/** Identity fields compared and found equal around the read. */
	readonly comparedFields: readonly string[];
	readonly unavailableReason: string | null;
	readonly elapsedMs: number;
}

export interface ObserveNativeFileStateInput {
	readonly target: NativeObservationTarget;
	/**
	 * Physical (realpath) form of the consented workspace root. `null` means it
	 * could not be resolved, which makes the observation unavailable rather than
	 * silently skipping the containment check.
	 */
	readonly physicalWorkspaceRoot: string | null;
	readonly limits?: Partial<NativeFileObservationLimits>;
	readonly now?: () => number;
}

interface RawFileMetadata {
	readonly ok: true;
	readonly stats: Stats;
}

interface FailedFileMetadata {
	readonly ok: false;
	readonly missing: boolean;
	readonly code: string;
}

type FileMetadata = RawFileMetadata | FailedFileMetadata;

function errorCode(error: unknown): string {
	if (typeof error === "object" && error !== null) {
		const code = (error as { code?: unknown }).code;
		if (typeof code === "string") return code;
	}
	return error instanceof Error ? error.name : "unknown";
}

async function readMetadata(target: string): Promise<FileMetadata> {
	try {
		return { ok: true, stats: await fs.lstat(target) };
	} catch (error) {
		const code = errorCode(error);
		return { ok: false, missing: code === "ENOENT" || code === "ENOTDIR", code };
	}
}

/**
 * Read one supported local file through a single bounded handle.
 *
 * The bytes come from one handle opened once; the pathname binding, the handle
 * identity and the pre/post path metadata are compared around the read, and the
 * physical path must still sit under the physical workspace root, so an
 * ancestor junction cannot redirect a "workspace" path outside it. When
 * anything moved, or when the file is larger than the byte cap, or when the
 * filesystem does not report a file identity this can bind to, no bytes are
 * returned at all — a partial or racy image is never presented as an
 * observation.
 */
export async function observeNativeFileState(input: ObserveNativeFileStateInput): Promise<NativeObservedFileState> {
	const limits = resolveNativeFileObservationLimits(input.limits);
	const now = input.now ?? Date.now;
	const startedAt = now();
	const finish = (state: Omit<NativeObservedFileState, "elapsedMs">): NativeObservedFileState => ({
		...state,
		elapsedMs: Math.max(0, now() - startedAt),
	});
	const empty = {
		presence: "unknown" as NativeObservationPresence,
		consistency: "unknown" as NativeObservationConsistency,
		contentKind: "unknown" as NativeFileObservationContentKind,
		byteLength: null as number | null,
		blobId: null as string | null,
		bytes: null as Uint8Array | null,
		comparedFields: [] as readonly string[],
		unavailableReason: null as string | null,
	};

	if (!input.target.byteCaptureAllowed || input.target.absolutePath === null) {
		return finish({
			...empty,
			presence: "unsupported",
			unavailableReason: input.target.unavailableReason ?? "the target is not a supported local file",
		});
	}
	if (input.physicalWorkspaceRoot === null) {
		return finish({
			...empty,
			presence: "unsupported",
			unavailableReason: "the workspace root has no physical form this read could be checked against",
		});
	}
	const absolutePath = input.target.absolutePath;
	const before = await readMetadata(absolutePath);
	if (!before.ok) {
		if (before.missing) return finish({ ...empty, presence: "absent" });
		return finish({ ...empty, unavailableReason: `the target could not be inspected (${before.code})` });
	}

	const api = platformPath(process.platform);
	const physicalRoot = api.resolve(input.physicalWorkspaceRoot);

	/** Metadata-only observations still report whether the target held still. */
	const metadataOnly = async (
		presence: NativeObservationPresence,
		reason: string,
	): Promise<NativeObservedFileState> => {
		const after = await readMetadata(absolutePath);
		const stable =
			after.ok &&
			after.stats.isDirectory() === before.stats.isDirectory() &&
			after.stats.isFile() === before.stats.isFile() &&
			after.stats.size === before.stats.size &&
			after.stats.mtimeMs === before.stats.mtimeMs &&
			after.stats.nlink === before.stats.nlink;
		return finish({
			...empty,
			presence,
			consistency: stable ? "stable" : "unstable",
			comparedFields: stable ? ["shape", "size", "mtimeMs", "nlink"] : [],
			unavailableReason: reason,
		});
	};

	if (before.stats.isSymbolicLink()) {
		return metadataOnly("unsupported", "the target is a symbolic link, junction or other reparse point");
	}
	if (before.stats.isDirectory()) {
		return metadataOnly("directory", "the target is a directory, not a regular file");
	}
	if (!before.stats.isFile()) {
		return metadataOnly("unsupported", "the target is not a regular file");
	}
	if (before.stats.nlink > 1) {
		return metadataOnly("unsupported", "the target has more than one link, so it is not one addressable file");
	}
	if (before.stats.ino === 0) {
		return metadataOnly("unsupported", "this filesystem does not report a file identity the read can bind to");
	}
	if (before.stats.size > limits.maxObservedBlobBytes) {
		return metadataOnly(
			"file",
			`the target is ${before.stats.size} bytes, above the ${limits.maxObservedBlobBytes} byte observation cap`,
		);
	}

	let realBefore: string;
	try {
		realBefore = await fs.realpath(absolutePath);
	} catch (error) {
		return finish({
			...empty,
			presence: "unknown",
			unavailableReason: `the target path could not be resolved (${errorCode(error)})`,
		});
	}
	const physicalRelative = api.relative(physicalRoot, realBefore);
	if (physicalRelative.length === 0 || physicalRelative === ".." || physicalRelative.startsWith("..") || api.isAbsolute(physicalRelative)) {
		return finish({
			...empty,
			presence: "unsupported",
			unavailableReason: "the target resolves outside the physical workspace, through a link or reparse point",
		});
	}

	let handle: FileHandle;
	try {
		handle = await fs.open(absolutePath, "r");
	} catch (error) {
		const code = errorCode(error);
		return finish({
			...empty,
			presence: code === "ENOENT" ? "absent" : "unknown",
			unavailableReason: `the target could not be opened (${code})`,
		});
	}

	try {
		const openedBefore = await handle.stat();
		if (openedBefore.ino !== before.stats.ino || openedBefore.dev !== before.stats.dev) {
			return finish({
				...empty,
				presence: "unsupported",
				unavailableReason: "the path no longer points at the file that was opened",
			});
		}
		const buffer = Buffer.allocUnsafe(Math.min(before.stats.size, limits.maxObservedBlobBytes) + 1);
		let read = 0;
		for (let attempt = 0; attempt < 16 && read < buffer.length; attempt += 1) {
			const chunk = await handle.read(buffer, read, buffer.length - read, read);
			if (chunk.bytesRead <= 0) break;
			read += chunk.bytesRead;
		}
		if (read > limits.maxObservedBlobBytes || read > before.stats.size) {
			return metadataOnly("file", "the target changed while it was read, so no bytes were stored");
		}

		const openedAfter = await handle.stat();
		const after = await readMetadata(absolutePath);
		if (!after.ok) {
			return finish({ ...empty, presence: "unknown", unavailableReason: "the path disappeared during the read" });
		}
		const realAfter = await fs.realpath(absolutePath).catch(() => null);
		const compared: string[] = [];
		const same = (name: string, equal: boolean): boolean => {
			if (!equal) return false;
			compared.push(name);
			return true;
		};
		const stable =
			same("dev", openedAfter.dev === openedBefore.dev && after.stats.dev === before.stats.dev) &&
			same("ino", openedAfter.ino === openedBefore.ino && after.stats.ino === before.stats.ino) &&
			same("size", openedAfter.size === openedBefore.size && after.stats.size === before.stats.size && read === before.stats.size) &&
			same("mtimeMs", openedAfter.mtimeMs === openedBefore.mtimeMs && after.stats.mtimeMs === before.stats.mtimeMs) &&
			same("nlink", after.stats.nlink === before.stats.nlink) &&
			same("pathnameBinding", realAfter === realBefore);
		if (!stable) {
			return finish({
				...empty,
				presence: "file",
				consistency: "unstable",
				unavailableReason: "the target changed during the read, so no bytes were stored",
			});
		}

		const bytes = Buffer.from(buffer.subarray(0, read));
		return finish({
			presence: "file",
			consistency: "stable",
			contentKind: classifyContentKind(bytes),
			byteLength: bytes.length,
			blobId: nativeObservationDigestBytes(bytes),
			bytes,
			comparedFields: compared,
			unavailableReason: null,
		});
	} catch (error) {
		return finish({ ...empty, presence: "unknown", unavailableReason: `the target read failed (${errorCode(error)})` });
	} finally {
		await handle.close().catch(() => {});
	}
}

function classifyContentKind(bytes: Uint8Array): NativeFileObservationContentKind {
	if (bytes.length === 0) return "empty";
	if (bytes.includes(0)) return "binary";
	try {
		new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		return "text";
	} catch {
		return "binary";
	}
}

// Records

export const NATIVE_FILE_OBSERVATION_SCHEMA_VERSION = 1;

/**
 * The read interval a record describes. Neither value is an attributed
 * per-tool pre/post image: OMP checks every tool's `tool_call` hook in a batch
 * before executing any tool, so an admission observation can predate unrelated
 * writes, and a result observation can follow a partial or deferred write.
 */
export type NativeObservationStage = "admission-observed" | "observed-post-result";

/**
 * What the tool reported for this call at the time of the observation.
 *
 * `unknown` is what an admission record carries (the tool has not reported yet)
 * and what a result-less admission keeps. `denied` is part of the schema for a
 * future producer that can observe a denial, but this producer never emits it:
 * OMP's `tool_call` and `tool_result` events do not tell a later handler whether
 * another handler blocked the call, so a denial surfaces as `unknown` rather
 * than as a guess.
 */
export type NativeObservationToolOutcome = "unknown" | "success" | "error" | "denied";

export interface NativeFileObservationOrigin {
	/** Extension-host owner this producer reports to. */
	readonly ownerId: string;
	/** Launch slot of the native host. */
	readonly slotId: string;
	/** Kernel-level process instance of the native host. */
	readonly processInstanceId: string;
	/** Producer epoch; a restart begins a new one and never replays the old. */
	readonly producerEpoch: string;
}

export interface NativeFileObservationSessionBinding {
	readonly sessionId: string;
	readonly sessionFileDigest: string | null;
	readonly workspaceDigest: string;
}

export interface NativeFileObservationToolCallRef {
	readonly toolCallId: string;
	readonly toolName: string;
	/** Distinguishes repeated sightings of one id inside one producer epoch. */
	readonly occurrence: number;
}

export interface NativeFileObservationTargetRef {
	readonly raw: string;
	readonly kind: NativeObservationTargetKind;
	readonly pathDigest: string | null;
	readonly displayPath: string | null;
	readonly unavailableReason: string | null;
}

export interface NativeFileObservationFacts {
	readonly presence: NativeObservationPresence;
	readonly consistency: NativeObservationConsistency;
	readonly contentKind: NativeFileObservationContentKind;
	readonly byteLength: number | null;
	readonly blobId: string | null;
	readonly elapsedMs: number;
	readonly comparedFields: readonly string[];
	readonly unavailableReason: string | null;
}

export interface NativeFileObservationRecordBody {
	readonly schemaVersion: number;
	readonly sequence: number;
	readonly stage: NativeObservationStage;
	readonly observedAtMs: number;
	readonly committedAtMs: number;
	readonly origin: NativeFileObservationOrigin;
	readonly session: NativeFileObservationSessionBinding;
	readonly toolCall: NativeFileObservationToolCallRef;
	readonly target: NativeFileObservationTargetRef;
	readonly observation: NativeFileObservationFacts;
	readonly toolOutcome: NativeObservationToolOutcome;
	readonly notes: readonly string[];
}

export interface NativeFileObservationRecord extends NativeFileObservationRecordBody {
	/** `sha256` of the canonical encoding of every other field. */
	readonly recordId: string;
}

/** Content-addressed record id; a reader recomputes this on every read. */
export function nativeFileObservationRecordId(body: NativeFileObservationRecordBody): string {
	return nativeObservationDigestValue(body);
}

export interface NativeFileObservationCommit {
	readonly stage: NativeObservationStage;
	readonly observedAtMs: number;
	readonly origin: NativeFileObservationOrigin;
	readonly session: NativeFileObservationSessionBinding;
	readonly toolCall: NativeFileObservationToolCallRef;
	readonly target: NativeFileObservationTargetRef;
	readonly observation: NativeFileObservationFacts;
	readonly toolOutcome: NativeObservationToolOutcome;
	readonly notes?: readonly string[];
}

export type NativeFileObservationParseFailure =
	| "malformed-json"
	| "unsupported-schema"
	| "invalid-field"
	| "record-id-mismatch";

export type NativeFileObservationParseResult =
	| { readonly ok: true; readonly record: NativeFileObservationRecord }
	| { readonly ok: false; readonly reason: NativeFileObservationParseFailure };

export type NativeFileObservationResolution = "observed" | "unknown" | "result-without-admission";

// Strict field readers
//
// One vocabulary for the whole parser: every field is read through a bounded
// reader that returns `null` for anything it cannot prove, so an unreadable or
// tampered record becomes `invalid-field` instead of a partially trusted object.

const STAGE_VALUES: Record<string, true> = { "admission-observed": true, "observed-post-result": true };
const OUTCOME_VALUES: Record<string, true> = { unknown: true, success: true, error: true, denied: true };
const PRESENCE_VALUES: Record<string, true> = {
	absent: true, file: true, directory: true, unsupported: true, unknown: true,
};
const CONSISTENCY_VALUES: Record<string, true> = { stable: true, unstable: true, unknown: true };
const CONTENT_KIND_VALUES: Record<string, true> = { empty: true, text: true, binary: true, unknown: true };
const TARGET_KIND_VALUES: Record<string, true> = {
	"regular-local-file": true, "empty-path": true, "internal-url": true, ssh: true, "unc-or-device": true,
	"alternate-data-stream": true, "archive-member": true, "sqlite-database": true,
	"unsupported-path-shape": true, "outside-workspace": true,
};

/**
 * Read a stored object that must carry exactly the given keys. Unknown or
 * missing fields fail the parse, mirroring `hasExactKeys` in the control
 * protocol parser (`./control-protocol.ts`), so a record cannot smuggle extra
 * content past the digest check.
 */
function readExactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (Object.keys(record).length !== keys.length) return null;
	for (const key of keys) {
		if (!Object.hasOwn(record, key)) return null;
	}
	return record;
}

function boundedText(value: unknown, max: number): string | null {
	return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

function optionalBoundedText(value: unknown, max: number): string | null | undefined {
	if (value === null) return null;
	return boundedText(value, max) ?? undefined;
}

function counter(value: unknown, max: number): number | null {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) return null;
	return value;
}

function optionalCounter(value: unknown, max: number): number | null | undefined {
	if (value === null) return null;
	return counter(value, max) ?? undefined;
}

function memberOf(value: unknown, allowed: Record<string, true>): string | null {
	return typeof value === "string" && Object.hasOwn(allowed, value) ? value : null;
}

function boundedTextList(value: unknown, maxItems: number, maxChars: number): readonly string[] | null {
	if (!Array.isArray(value) || value.length > maxItems) return null;
	const items: string[] = [];
	for (const item of value) {
		const text = boundedText(item, maxChars);
		if (text === null) return null;
		items.push(text);
	}
	return items;
}

function readOrigin(value: unknown): NativeFileObservationOrigin | null {
	const record = readExactRecord(value, ["ownerId", "slotId", "processInstanceId", "producerEpoch"]);
	if (!record) return null;
	const ownerId = boundedText(record["ownerId"], 64);
	const slotId = boundedText(record["slotId"], 64);
	const processInstanceId = boundedText(record["processInstanceId"], 64);
	const producerEpoch = boundedText(record["producerEpoch"], 64);
	if (ownerId === null || slotId === null || processInstanceId === null || producerEpoch === null) return null;
	return { ownerId, slotId, processInstanceId, producerEpoch };
}

function readSessionBinding(value: unknown): NativeFileObservationSessionBinding | null {
	const record = readExactRecord(value, ["sessionId", "sessionFileDigest", "workspaceDigest"]);
	if (!record) return null;
	const sessionId = boundedText(record["sessionId"], 200);
	const sessionFileDigest = optionalBoundedText(record["sessionFileDigest"], 64);
	const workspaceDigest = boundedText(record["workspaceDigest"], 64);
	if (sessionId === null || sessionFileDigest === undefined || workspaceDigest === null) return null;
	if (!isNativeObservationDigest(workspaceDigest)) return null;
	if (sessionFileDigest !== null && !isNativeObservationDigest(sessionFileDigest)) return null;
	return { sessionId, sessionFileDigest, workspaceDigest };
}

function readToolCallRef(value: unknown): NativeFileObservationToolCallRef | null {
	const record = readExactRecord(value, ["toolCallId", "toolName", "occurrence"]);
	if (!record) return null;
	const toolCallId = boundedText(record["toolCallId"], 200);
	const toolName = boundedText(record["toolName"], 64);
	const occurrence = counter(record["occurrence"], 1_000_000);
	if (toolCallId === null || toolName === null || occurrence === null) return null;
	return { toolCallId, toolName, occurrence };
}

function readTargetRef(value: unknown, maxRawPathChars: number): NativeFileObservationTargetRef | null {
	const record = readExactRecord(value, ["raw", "kind", "pathDigest", "displayPath", "unavailableReason"]);
	if (!record) return null;
	const raw = boundedText(record["raw"], maxRawPathChars);
	const kind = memberOf(record["kind"], TARGET_KIND_VALUES) as NativeObservationTargetKind | null;
	const pathDigest = optionalBoundedText(record["pathDigest"], 64);
	const displayPath = optionalBoundedText(record["displayPath"], 1024);
	const unavailableReason = optionalBoundedText(record["unavailableReason"], 512);
	if (raw === null || kind === null) return null;
	if (pathDigest === undefined || displayPath === undefined || unavailableReason === undefined) return null;
	if (pathDigest !== null && !isNativeObservationDigest(pathDigest)) return null;
	return { raw, kind, pathDigest, displayPath, unavailableReason };
}

function readFacts(value: unknown, limits: NativeFileObservationLimits): NativeFileObservationFacts | null {
	const record = readExactRecord(value, [
		"presence", "consistency", "contentKind", "byteLength", "blobId", "elapsedMs", "comparedFields", "unavailableReason",
	]);
	if (!record) return null;
	const presence = memberOf(record["presence"], PRESENCE_VALUES) as NativeObservationPresence | null;
	const consistency = memberOf(record["consistency"], CONSISTENCY_VALUES) as NativeObservationConsistency | null;
	const contentKind = memberOf(record["contentKind"], CONTENT_KIND_VALUES) as NativeFileObservationContentKind | null;
	const byteLength = optionalCounter(record["byteLength"], limits.maxObservedBlobBytes);
	const blobId = optionalBoundedText(record["blobId"], 64);
	const elapsedMs = counter(record["elapsedMs"], 86_400_000);
	const comparedFields = boundedTextList(record["comparedFields"], 32, 64);
	const unavailableReason = optionalBoundedText(record["unavailableReason"], 512);
	if (presence === null || consistency === null || contentKind === null) return null;
	if (byteLength === undefined || elapsedMs === null || comparedFields === null) return null;
	if (blobId === undefined || unavailableReason === undefined) return null;
	if (blobId !== null && !isNativeObservationDigest(blobId)) return null;
	if ((byteLength === null) !== (blobId === null)) return null;
	if (byteLength !== null && consistency !== "stable") return null;
	if (contentKind === "empty" && byteLength !== 0) return null;
	return { presence, consistency, contentKind, byteLength, blobId, elapsedMs, comparedFields, unavailableReason };
}

/**
 * Strict parser for a stored record. It refuses an unknown schema, a malformed
 * or internally inconsistent field, and any record whose id does not match its
 * own contents, so a tampered journal entry can never be presented as evidence.
 */
export function parseNativeFileObservationRecord(input: {
	readonly text: string;
	readonly expectedRecordId?: string | undefined;
	readonly limits?: Partial<NativeFileObservationLimits>;
}): NativeFileObservationParseResult {
	const limits = resolveNativeFileObservationLimits(input.limits);
	const expected =
		input.expectedRecordId === undefined || isNativeObservationDigest(input.expectedRecordId)
			? input.expectedRecordId
			: undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(input.text);
	} catch {
		return { ok: false, reason: "malformed-json" };
	}
	const record = readExactRecord(parsed, [
		"schemaVersion", "sequence", "stage", "observedAtMs", "committedAtMs", "origin", "session", "toolCall",
		"target", "observation", "toolOutcome", "notes", "recordId",
	]);
	if (!record) return { ok: false, reason: "invalid-field" };
	if (record["schemaVersion"] !== NATIVE_FILE_OBSERVATION_SCHEMA_VERSION) {
		return { ok: false, reason: "unsupported-schema" };
	}
	const sequence = counter(record["sequence"], Number.MAX_SAFE_INTEGER);
	const stage = memberOf(record["stage"], STAGE_VALUES) as NativeObservationStage | null;
	const observedAtMs = counter(record["observedAtMs"], Number.MAX_SAFE_INTEGER);
	const committedAtMs = counter(record["committedAtMs"], Number.MAX_SAFE_INTEGER);
	const origin = readOrigin(record["origin"]);
	const session = readSessionBinding(record["session"]);
	const toolCall = readToolCallRef(record["toolCall"]);
	const target = readTargetRef(record["target"], limits.maxRawPathChars);
	const observation = readFacts(record["observation"], limits);
	const toolOutcome = memberOf(record["toolOutcome"], OUTCOME_VALUES) as NativeObservationToolOutcome | null;
	const notes = boundedTextList(record["notes"], 8, 256);
	if (
		sequence === null || stage === null || observedAtMs === null || committedAtMs === null ||
		origin === null || session === null || toolCall === null || target === null ||
		observation === null || toolOutcome === null || notes === null
	) {
		return { ok: false, reason: "invalid-field" };
	}
	const recordId = record["recordId"];
	if (typeof recordId !== "string" || !isNativeObservationDigest(recordId)) {
		return { ok: false, reason: "invalid-field" };
	}
	const body: NativeFileObservationRecordBody = {
		schemaVersion: NATIVE_FILE_OBSERVATION_SCHEMA_VERSION,
		sequence,
		stage,
		observedAtMs,
		committedAtMs,
		origin,
		session,
		toolCall,
		target,
		observation,
		toolOutcome,
		notes,
	};
	let recomputed: string;
	try {
		recomputed = nativeFileObservationRecordId(body);
	} catch {
		return { ok: false, reason: "invalid-field" };
	}
	if (recomputed !== recordId) return { ok: false, reason: "record-id-mismatch" };
	if (expected !== undefined && expected !== recordId) return { ok: false, reason: "record-id-mismatch" };
	return { ok: true, record: { ...body, recordId } };
}

// Derivation

export interface NativeFileObservationCallView {
	readonly producerEpoch: string;
	readonly toolCallId: string;
	readonly toolName: string;
	readonly occurrence: number;
	readonly admission: readonly NativeFileObservationRecord[];
	readonly result: readonly NativeFileObservationRecord[];
	readonly resolution: NativeFileObservationResolution;
}

/**
 * Derive, per producer epoch and tool call, whether a witnessed result exists.
 *
 * Records stay immutable: an admission with no witnessed result is reported
 * `unknown` here rather than being rewritten on disk, because approval denial,
 * nested dispatch, a missed `tool_result` hook and a producer restart all
 * produce that state and none of them is evidence that the file was untouched.
 */
export function summarizeNativeFileObservations(
	records: readonly NativeFileObservationRecord[],
): NativeFileObservationCallView[] {
	const groups = new Map<string, { admission: NativeFileObservationRecord[]; result: NativeFileObservationRecord[] }>();
	for (const record of records) {
		const key = `${record.origin.producerEpoch}\u0000${record.toolCall.toolCallId}\u0000${record.toolCall.occurrence}`;
		const group = groups.get(key) ?? { admission: [], result: [] };
		(record.stage === "admission-observed" ? group.admission : group.result).push(record);
		groups.set(key, group);
	}
	const views: NativeFileObservationCallView[] = [];
	for (const group of groups.values()) {
		const sample = (group.admission[0] ?? group.result[0])!;
		views.push({
			producerEpoch: sample.origin.producerEpoch,
			toolCallId: sample.toolCall.toolCallId,
			toolName: sample.toolCall.toolName,
			occurrence: sample.toolCall.occurrence,
			admission: group.admission,
			result: group.result,
			resolution:
				group.result.length > 0
					? group.admission.length > 0
						? "observed"
						: "result-without-admission"
					: "unknown",
		});
	}
	return views;
}
