/**
 * Resolves OMP's externalized image bytes for a history read.
 *
 * OMP never stores a pasted or tool image inline in the session JSONL: `SessionManager` writes
 * `{"type":"image","data":"blob:sha256:<64 hex>","mimeType":"image/png"}` and keeps the bytes in a
 * content-addressed file `<agent dir>/blobs/<64 hex>` (see `session/blob-store.ts` in OMP). Its own loader swaps the
 * reference back to base64 on resume; a live process still holds the original base64. This module is the reader's
 * counterpart of that swap, so a saved image renders after a stopped session is opened or a running one repaints
 * from disk.
 *
 * Only a canonical `blob:sha256:<64 lowercase hex>` reference is ever turned into a path, and the path is always
 * `<blobs dir>/<hash>`, so a crafted reference cannot leave the store. A reference that cannot be resolved (blob
 * missing, unreadable, over {@link MAX_BLOB_BYTES} or past the per-read {@link BLOB_BYTES_BUDGET}) is left in place;
 * the page shows an honest "not available" placeholder for it instead of a broken image.
 */
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { isRecord } from "../../guards.ts";

const BLOB_PREFIX = "blob:sha256:";
const BLOB_REF_PATTERN = /^blob:sha256:[a-f0-9]{64}$/;
/** One image larger than this stays a reference. */
export const MAX_BLOB_BYTES = 16 * 1024 * 1024;
/** Raw bytes one read (one window of rows) may inline before further images stay references. */
export const BLOB_BYTES_BUDGET = 64 * 1024 * 1024;

/**
 * The blob directory beside the nearest `sessions` ancestor of a session file: OMP keeps `sessions/` and `blobs/`
 * under the same agent (or XDG data) directory, and subagent files sit deeper under their parent session's folder.
 * `null` when the file is not inside a sessions directory.
 */
export function blobsDirectoryFor(sessionFile: string): string | null {
	let directory = path.dirname(path.resolve(sessionFile));
	for (;;) {
		if (path.basename(directory).toLowerCase() === "sessions") return path.join(path.dirname(directory), "blobs");
		const parent = path.dirname(directory);
		if (parent === directory) return null;
		directory = parent;
	}
}

function collect(value: unknown, into: Record<string, unknown>[]): void {
	if (Array.isArray(value)) {
		for (const item of value) collect(item, into);
		return;
	}
	if (!isRecord(value)) return;
	if (typeof value.data === "string" && value.data.startsWith(BLOB_PREFIX) && typeof value.mimeType === "string") into.push(value);
	for (const child of Object.values(value)) if (typeof child === "object" && child !== null) collect(child, into);
}

/**
 * Replace every resolvable `{data: "blob:sha256:…", mimeType}` image in `parsed` (a parsed JSONL entry) by its base64
 * bytes, in place. Unresolvable references are left unchanged. Never throws.
 */
export async function resolveBlobImages(parsed: unknown, blobsDirectory: string | null, spent: { bytes: number }): Promise<void> {
	const images: Record<string, unknown>[] = [];
	collect(parsed, images);
	if (images.length === 0 || blobsDirectory === null) return;
	for (const image of images) {
		const reference = image.data as string;
		if (!BLOB_REF_PATTERN.test(reference)) continue;
		const file = path.join(blobsDirectory, reference.slice(BLOB_PREFIX.length));
		try {
			const size = (await stat(file)).size;
			if (size > MAX_BLOB_BYTES || spent.bytes + size > BLOB_BYTES_BUDGET) continue;
			const bytes = await readFile(file);
			spent.bytes += bytes.length;
			image.data = bytes.toString("base64");
		} catch {
			// Missing or unreadable: the reference stays and renders as an unavailable placeholder.
		}
	}
}
