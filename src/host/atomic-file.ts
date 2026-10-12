/**
 * The one module for replacing a file's content and for retrying a file operation.
 *
 * `replaceFileAtomic` stages the content in a private sibling (`<target>.<pid>.<uuid>.tmp`,
 * created exclusively by `stageBeside`) and renames it over the target in one step, so a
 * reader never observes a half-written or missing file; the staged entry is removed whatever
 * happens. A rename (or any other file operation) that another process's open handle briefly
 * blocks (`EPERM`, `EBUSY`, `EACCES` on Windows) is retried through `retryFileOperation` with
 * a growing wait. Two budgets are named: `RENAME_BACKOFF_MS` (the default of
 * `replaceFileAtomic`, shared records that other windows re-read) and
 * `FILE_OPERATION_BACKOFF_MS` (the shorter one that bounds a launch admission).
 */

import { randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

/**
 * Waits between rename attempts, about 2.1 s in all. On Windows a rename over a file fails for as long as any process
 * holds the target open (another window re-reading the catalog after each change, an antivirus or indexer scan), and a
 * slow machine keeps such handles open for hundreds of milliseconds, so a window of ~120 ms was not enough.
 */
export const RENAME_BACKOFF_MS: readonly number[] = [10, 20, 40, 80, 160, 320, 640, 800];

/**
 * Waits between attempts of the shorter budget, about 0.9 s in all (seven attempts). It bounds the writers that run
 * under a launch, a claim or a transaction, where a longer wait would be a change in how long that step may take.
 */
export const FILE_OPERATION_BACKOFF_MS: readonly number[] = [25, 50, 100, 200, 250, 250];

/** The error's `code`, when it has one. */
export function errorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	return typeof error.code === "string" ? error.code : undefined;
}

function delay(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

/** Whether an operation failed only because another process holds a file open. */
function isSharingViolation(error: unknown): boolean {
	const code = errorCode(error);
	return code === "EPERM" || code === "EBUSY" || code === "EACCES";
}

/** Test seams of `retryFileOperation`. */
export interface RetryFileOperationOptions {
	readonly platform?: NodeJS.Platform;
	readonly wait?: (ms: number) => Promise<unknown>;
}

/**
 * Run `operation`, and when it fails with a Windows sharing or access violation (`EPERM`, `EBUSY`,
 * `EACCES`) wait the next entry of `backoff` and run it again: `backoff.length + 1` attempts at most.
 * Any other error, any error off Windows, and the last violation are thrown as they are. Never
 * unlinks the target: each attempt is the same atomic replacement or pre-launch claim admission.
 */
export async function retryFileOperation<T>(
	operation: () => Promise<T>,
	backoff: readonly number[],
	options: RetryFileOperationOptions = {},
): Promise<T> {
	const wait = options.wait ?? delay;
	for (let attempt = 0; ; attempt += 1) {
		try {
			return await operation();
		} catch (error) {
			const pause = backoff[attempt];
			if ((options.platform ?? process.platform) !== "win32" || pause === undefined || !isSharingViolation(error)) throw error;
			await wait(pause);
		}
	}
}

/** Run `rename` until it lands, waiting out `RENAME_BACKOFF_MS` on Windows (see `retryFileOperation`); any other error, or the last sharing violation, is thrown. */
export function renameReplacing(rename: () => Promise<void>, wait: (ms: number) => Promise<void>, options: Pick<RetryFileOperationOptions, "platform"> = {}): Promise<void> {
	return retryFileOperation(rename, RENAME_BACKOFF_MS, { ...options, wait });
}

/** How a staged sibling is written. */
export interface StageBesideOptions {
	/** Permission bits of the staged file; `0o600`. */
	readonly mode?: number;
	/** Flush the staged file to disk before it is handed out. */
	readonly sync?: boolean;
	/** Stage in this directory instead of the target's own, for a store whose staging area has its own access rules. */
	readonly stagingDirectory?: string;
}

/**
 * Write `content` to a private sibling of `target`, `<target>.<pid>.<uuid>.tmp`, created exclusively
 * (an existing entry of that name is an error, never reused or overwritten), and return its path. A
 * failed write removes what it created. Once this returns, removing the staged entry is the caller's:
 * the one that renames it, links it into place or gives up.
 */
export async function stageBeside(target: string, content: string | Uint8Array, options: StageBesideOptions = {}): Promise<string> {
	const unique = `${process.pid}.${randomUUID()}.tmp`;
	const staged = options.stagingDirectory === undefined
		? `${target}.${unique}`
		: path.join(options.stagingDirectory, `${path.basename(target)}.${unique}`);
	const handle = await fsp.open(staged, "wx", options.mode ?? 0o600);
	try {
		try {
			await handle.writeFile(content, "utf8");
			if (options.sync === true) await handle.sync();
		} finally {
			await handle.close();
		}
	} catch (error) {
		await fsp.rm(staged, { force: true }).catch(() => {});
		throw error;
	}
	return staged;
}

/** How `replaceFileAtomic` stages and publishes. */
export interface ReplaceFileOptions extends StageBesideOptions {
	/** Waits between rename attempts; `RENAME_BACKOFF_MS`. */
	readonly backoff?: readonly number[];
	/** Create the target's directory (owner-only) when it is missing; `true`. A store that verified its directories first passes `false`. */
	readonly createDirectory?: boolean;
}

/** Replace the file at `target` with `content` in one rename; the old content stays whole until the new lands. */
export async function replaceFileAtomic(target: string, content: string | Uint8Array, options: ReplaceFileOptions = {}): Promise<void> {
	if (options.createDirectory !== false) await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
	const staged = await stageBeside(target, content, options);
	try {
		await retryFileOperation(() => fsp.rename(staged, target), options.backoff ?? RENAME_BACKOFF_MS);
	} finally {
		await fsp.rm(staged, { force: true }).catch(() => {});
	}
}

/** What a bounded read of one small shared file found. */
export type BoundedRead =
	| { readonly kind: "missing" }
	/** Not a regular file, or more than the byte limit: never trusted, never read in full. */
	| { readonly kind: "invalid" }
	| { readonly kind: "text"; readonly text: string };

/**
 * Read a small file another process wrote, through one open handle: the handle must be a
 * regular file no larger than `maxBytes`, and at most `maxBytes + 1` bytes are ever read, so a
 * file that grows between the check and the read is still bounded.
 */
export async function readBoundedFile(file: string, maxBytes: number): Promise<BoundedRead> {
	let handle: fsp.FileHandle;
	try {
		handle = await fsp.open(file, "r");
	} catch (error) {
		if (errorCode(error) === "ENOENT") return { kind: "missing" };
		throw error;
	}
	try {
		const stat = await handle.stat();
		if (!stat.isFile() || stat.size > maxBytes) return { kind: "invalid" };
		const buffer = Buffer.alloc(maxBytes + 1);
		const { bytesRead } = await handle.read(buffer, 0, maxBytes + 1, 0);
		if (bytesRead > maxBytes) return { kind: "invalid" };
		return { kind: "text", text: buffer.toString("utf8", 0, bytesRead) };
	} finally {
		await handle.close().catch(() => {});
	}
}
