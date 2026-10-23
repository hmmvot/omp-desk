/**
 * The real {@link AttachReader}: how the page tells and reads the `File` of a paste or a drop from the operating system
 * (docs/designs/2026-10-16-chat-document-attachments.md, *Proposed Design* 1). It touches `File` and `Blob` only, which node has too, so
 * its rules (the sentences included) have node tests of their own; `createImageBitmap` is guarded, so a node run only lacks the pixel size.
 *
 * The file's first bytes decide what it is, never its name or declared type, and the host applies the same rule to a file it reads by path
 * (`src/host/attached-files.ts`, through `src/shared/text-file.ts`), so a file is refused with the same sentence whichever way it arrived.
 *
 * Image formats mirror `SUPPORTED_IMAGE_MIME_TYPES` in the installed `@oh-my-pi/pi-utils` (PNG, JPEG, GIF, WebP), the same set the native
 * TUI accepts for image input.
 */
import { MAX_DOCUMENT_BYTES, MAX_MESSAGE_CHARS } from "../../shared/attach-limits.ts";
import { formatBytes, groupedCount } from "../../shared/file-size.ts";
import { sniffImageMimeType, sniffUnsupportedImageMimeType } from "../../shared/image-sniff.ts";
import { TEXT_SNIFF_BYTES, decodeTextFile, sniffTextFile, textFileRefusalSentence } from "../../shared/text-file.ts";
import type { AttachReader, DocumentRead, FileClass, ImageRead } from "./draft/draft.ts";

/** Human-readable format list used in failure messages. */
const FORMATS = "PNG, JPEG, GIF, or WebP";

/** Formats the host accepts for image input, as a declared type names them. */
const SUPPORTED_IMAGE_MIME_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/** Bytes read at a time when base64-encoding; see {@link toBase64}. */
const BASE64_CHUNK_BYTES = 0x8000;

/** Classify `file` by its first bytes: a supported image, a candidate document (its prefix is text), or a refusal naming it. */
export async function classifyFile(file: File): Promise<FileClass> {
	let prefix: Uint8Array;
	try {
		prefix = new Uint8Array(await file.slice(0, TEXT_SNIFF_BYTES).arrayBuffer());
	} catch {
		return { kind: "refused", reason: `${file.name}: could not be read.` };
	}
	if (sniffImageMimeType(prefix) !== null) return { kind: "image" };
	const unsupported = sniffUnsupportedImageMimeType(prefix);
	if (unsupported !== null) return { kind: "refused", reason: `${file.name}: unsupported format (${unsupported}) — attach ${FORMATS}.` };
	const refusal = sniffTextFile(prefix);
	return refusal === null ? { kind: "text" } : { kind: "refused", reason: textFileRefusalSentence(file.name, refusal) };
}

/** Read the whole of a file that {@link classifyFile} found to be text. A file above the byte bound is refused unread. */
export async function readDocumentFile(file: File): Promise<DocumentRead> {
	const limit = `one message carries at most ${groupedCount(MAX_MESSAGE_CHARS)} characters.`;
	if (file.size > MAX_DOCUMENT_BYTES) return { ok: false, reason: `${file.name} is ${formatBytes(file.size)}; ${limit}` };
	let bytes: Uint8Array;
	try {
		bytes = new Uint8Array(await file.arrayBuffer());
	} catch {
		return { ok: false, reason: `${file.name}: could not be read.` };
	}
	const decoded = decodeTextFile(bytes);
	if (!decoded.ok) return { ok: false, reason: textFileRefusalSentence(file.name, decoded.reason) };
	if (decoded.text.length > MAX_MESSAGE_CHARS) return { ok: false, reason: `${file.name} is ${groupedCount(decoded.text.length)} characters; ${limit}` };
	return { ok: true, content: decoded.text, bytes: bytes.byteLength };
}

/**
 * Read `file` into a draft image under the stable key `id`. Resolves a failure reason instead of throwing:
 * every rejection here is ordinary user input, not an exception.
 */
export async function readImageAttachment(file: File, id: number): Promise<ImageRead> {
	let bytes: Uint8Array;
	try {
		bytes = new Uint8Array(await file.arrayBuffer());
	} catch {
		return { ok: false, reason: `${file.name}: could not be read.` };
	}
	const mimeType = sniffImageMimeType(bytes);
	if (mimeType === null) return { ok: false, reason: unsupportedReason(file) };
	const size = await decodedSize(bytes, mimeType);
	return { ok: true, image: { id, name: file.name, mimeType, bytes: bytes.byteLength, data: toBase64(bytes), ...size } };
}

/** Pixel size of an image the browser can decode, or nothing (the marker then omits it, as the TUI's does). */
async function decodedSize(bytes: Uint8Array, mimeType: string): Promise<{ width: number; height: number } | undefined> {
	if (typeof createImageBitmap !== "function") return undefined;
	try {
		const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: mimeType }));
		const size = { width: bitmap.width, height: bitmap.height };
		bitmap.close();
		return size.width > 0 && size.height > 0 ? size : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Standard base64 of `bytes`, chunked: a single spread of a multi-megabyte file into
 * `String.fromCharCode` would exceed the argument limit.
 */
function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_BYTES) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK_BYTES));
	}
	return btoa(binary);
}

/** Failure text for a file whose bytes are not a supported image. */
function unsupportedReason(file: File): string {
	const declared = file.type.toLowerCase();
	// A declared supported type that failed the byte check is a mislabeled file (a renamed download, an HTML error page saved as `.png`):
	// the bytes are the problem, so offering the format list again would mislead.
	if (SUPPORTED_IMAGE_MIME_TYPES.includes(declared)) return `${file.name}: its contents are not a valid ${declared} image.`;
	return declared.length > 0 && declared !== "application/octet-stream"
		? `${file.name}: unsupported format (${declared}) — attach ${FORMATS}.`
		: `${file.name}: not a ${FORMATS} image.`;
}

export const attachReader: AttachReader = {
	classify: classifyFile,
	readImage: readImageAttachment,
	readDocument: readDocumentFile,
};
