/**
 * Replace a small file in one rename, so a reader never observes a half-written or
 * missing file. The staged entry (`<target>.<uuid>.tmp`) is private to this call and is
 * removed whatever happens. A rename that another process's open handle briefly blocks
 * (`EPERM`, `EBUSY`, `EACCES` on Windows) is retried with a growing wait (`RENAME_BACKOFF_MS`).
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

/** Block this thread for `ms` without using the CPU. */
export function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

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

export async function replaceFileAtomic(target: string, content: string): Promise<void> {
	await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
	const staged = `${target}.${randomUUID()}.tmp`;
	try {
		await fsp.writeFile(staged, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
		await renameReplacing(() => fsp.rename(staged, target), delay);
	} finally {
		await fsp.rm(staged, { force: true }).catch(() => {});
	}
}

/** Whether a rename failed only because another process holds the target or the staged file open. */
function isSharingViolation(error: unknown): boolean {
	const code = errorCode(error);
	return code === "EPERM" || code === "EBUSY" || code === "EACCES";
}

/** Run `rename` until it lands, waiting out `RENAME_BACKOFF_MS`; any other error, or the last sharing violation, is thrown. */
export async function renameReplacing(rename: () => Promise<void>, wait: (ms: number) => Promise<void>): Promise<void> {
	for (let attempt = 0; ; attempt++) {
		try {
			await rename();
			return;
		} catch (error) {
			const pause = RENAME_BACKOFF_MS[attempt];
			if (pause === undefined || !isSharingViolation(error)) throw error;
			await wait(pause);
		}
	}
}

/** `renameReplacing` for a caller that must finish before it returns; the wait blocks without spinning. */
export function renameReplacingSync(rename: () => void, wait: (ms: number) => void = sleepSync): void {
	for (let attempt = 0; ; attempt++) {
		try {
			rename();
			return;
		} catch (error) {
			const pause = RENAME_BACKOFF_MS[attempt];
			if (pause === undefined || !isSharingViolation(error)) throw error;
			wait(pause);
		}
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
