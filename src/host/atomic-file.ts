/**
 * Replace a small file in one rename, so a reader never observes a half-written or
 * missing file. The staged entry (`<target>.<uuid>.tmp`) is private to this call and is
 * removed whatever happens. A rename that another process's open handle briefly blocks
 * (`EPERM`, `EBUSY`, `EACCES` on Windows) is retried a few times.
 */

import { randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

const RENAME_ATTEMPTS = 4;
const RENAME_RETRY_MS = 25;

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
		for (let attempt = 1; ; attempt++) {
			try {
				await fsp.rename(staged, target);
				return;
			} catch (error) {
				const code = errorCode(error);
				if (attempt >= RENAME_ATTEMPTS || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw error;
				await delay(RENAME_RETRY_MS);
			}
		}
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
