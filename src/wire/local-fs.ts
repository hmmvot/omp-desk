/**
 * The file operations of the session claims and the profile catalog, as the asynchronous calls of `fs/promises` or, for
 * the directories Desk has verified are on a local fixed NTFS volume, as one synchronous step each (ADR-0076, decision 12).
 *
 * Why: every asynchronous file call is a job in the host's one pool of four file-system threads and then a turn of its
 * event loop, behind everything the other extensions of the host queued at the same moment. At a window reload that
 * queue made a call that takes a tenth of a millisecond come back after tens or hundreds (a startup measurement:
 * asynchronous `stat` median 11-31 ms, largest 693 ms; synchronous `stat` 0 ms), and a claim's fifteen calls or a catalog
 * commit's dozen added up to seconds. A synchronous call waits for neither.
 *
 * What does not change: the order of the calls, the flags, the errors (the same `code`s), and every wait. The synchronous
 * implementation is `async` functions around the synchronous calls, so a caller written against `fs/promises` runs
 * unchanged, a lock that has to wait still waits on a timer (never in a loop), and a retry still sleeps between attempts.
 * A call that was already a promise costs a microtask, not a turn of the loop.
 *
 * Where: only the directories passed to {@link useSynchronousLocalFs} (or marked by a test), and only after
 * {@link synchronousLocalPaths} proved them local, fixed and reached through plain directories. Anything else, and every
 * window whose native module is missing, keeps the asynchronous calls.
 */
import * as fsSync from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

/** The part of a file handle the claims and the catalog use. */
export interface LocalFileHandle {
	stat(): Promise<fsSync.Stats>;
	writeFile(data: string | Uint8Array, encoding?: BufferEncoding): Promise<void>;
	sync(): Promise<void>;
	close(): Promise<void>;
}

/** The calls the claims and the catalog make, with the signatures of `fs/promises`. */
export interface LocalFs {
	mkdir(directory: string, options: { readonly recursive?: boolean; readonly mode?: number }): Promise<unknown>;
	readFile(file: string, encoding: "utf8"): Promise<string>;
	/** {@link readFile} of a file that must be at most `maxBytes`: the size is read from the open file first, and a larger one fails with the code `EFBIG` before it is read. */
	readSmallFile(file: string, maxBytes: number): Promise<string>;
	rm(target: string, options: { readonly force?: boolean; readonly recursive?: boolean }): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	link(existing: string, created: string): Promise<void>;
	stat(target: string): Promise<fsSync.Stats>;
	open(file: string, flags: string, mode?: number): Promise<LocalFileHandle>;
}

/** The error of a bounded read of a file larger than its bound: the code `EFBIG`, as the system's own "file too large". */
function assertSmall(file: string, size: number, maxBytes: number): void {
	if (size > maxBytes) throw Object.assign(new Error(`${file} is ${size} bytes, over the ${maxBytes} this read accepts`), { code: "EFBIG" });
}

const asynchronousFs: LocalFs = {
	mkdir: (directory, options) => fsp.mkdir(directory, options),
	readFile: (file, encoding) => fsp.readFile(file, encoding),
	readSmallFile: async (file, maxBytes) => {
		const handle = await fsp.open(file, "r");
		try {
			assertSmall(file, (await handle.stat()).size, maxBytes);
			const text = await handle.readFile("utf8");
			assertSmall(file, Buffer.byteLength(text, "utf8"), maxBytes);
			return text;
		} finally {
			await handle.close();
		}
	},
	rm: (target, options) => fsp.rm(target, options),
	rename: (from, to) => fsp.rename(from, to),
	link: (existing, created) => fsp.link(existing, created),
	stat: target => fsp.stat(target),
	open: (file, flags, mode) => fsp.open(file, flags, mode),
};

/** One open descriptor, driven by synchronous calls. A descriptor is closed exactly once: a second `close` is a no-op. */
function synchronousHandle(descriptor: number): LocalFileHandle {
	let closed = false;
	return {
		stat: async () => fsSync.fstatSync(descriptor),
		writeFile: async (data, encoding) => {
			if (typeof data === "string") fsSync.writeFileSync(descriptor, data, encoding ?? "utf8");
			else fsSync.writeFileSync(descriptor, data);
		},
		sync: async () => { fsSync.fsyncSync(descriptor); },
		close: async () => {
			if (closed) return;
			closed = true;
			fsSync.closeSync(descriptor);
		},
	};
}

const synchronousFs: LocalFs = {
	mkdir: async (directory, options) => fsSync.mkdirSync(directory, options),
	readFile: async (file, encoding) => fsSync.readFileSync(file, encoding),
	readSmallFile: async (file, maxBytes) => {
		const descriptor = fsSync.openSync(file, "r");
		try {
			assertSmall(file, fsSync.fstatSync(descriptor).size, maxBytes);
			const text = fsSync.readFileSync(descriptor, "utf8");
			assertSmall(file, Buffer.byteLength(text, "utf8"), maxBytes);
			return text;
		} finally {
			fsSync.closeSync(descriptor);
		}
	},
	rm: async (target, options) => { fsSync.rmSync(target, options); },
	rename: async (from, to) => { fsSync.renameSync(from, to); },
	link: async (existing, created) => { fsSync.linkSync(existing, created); },
	stat: async target => fsSync.statSync(target),
	open: async (file, flags, mode) => synchronousHandle(fsSync.openSync(file, flags, mode)),
};

/** Lower-cased, resolved directories whose contents may be reached synchronously. */
const synchronousRoots = new Set<string>();

function keyOf(target: string): string {
	return path.resolve(target).toLowerCase();
}

/** Mark directories as verified for synchronous calls; returns the function that unmarks them. Only after the verdict, or in a test. */
export function markSynchronousLocalRoots(roots: readonly string[]): () => void {
	const keys = roots.map(keyOf);
	for (const key of keys) synchronousRoots.add(key);
	return () => { for (const key of keys) synchronousRoots.delete(key); };
}

/**
 * Serve every file call below `roots` synchronously from now on when `verdict` says they may be. The caller passes
 * `synchronousLocalPaths`, which proves them local fixed NTFS paths reached through plain directories. Returns the
 * verdict; a `false` leaves every call asynchronous. Only Desk's own directories belong here, because the match is by prefix
 * and covers everything below them: a root that is a drive root or a UNC share root is refused without asking.
 */
export async function useSynchronousLocalFs(
	roots: readonly string[],
	verdict: (targets: readonly string[]) => Promise<boolean>,
): Promise<boolean> {
	if (roots.some(root => keyOf(root) === path.parse(path.resolve(root)).root.toLowerCase())) return false;
	if (!(await verdict(roots))) return false;
	markSynchronousLocalRoots(roots);
	return true;
}

/** The file operations to use for `target`: synchronous below a verified root, asynchronous anywhere else. */
export function localFs(target: string): LocalFs {
	if (synchronousRoots.size === 0) return asynchronousFs;
	const key = keyOf(target);
	for (const root of synchronousRoots) {
		if (key === root || key.startsWith(root.endsWith(path.sep) ? root : root + path.sep)) return synchronousFs;
	}
	return asynchronousFs;
}
