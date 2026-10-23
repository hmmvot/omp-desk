/**
 * Local image attachments for the chat composer.
 *
 * Wire shape, as the host forwards it to OMP's `prompt`/`steer`/`follow_up`
 * commands (`ImageContent` of `@oh-my-pi/pi-wire`):
 *
 *     ImageContent = { type: "image"; data: string; mimeType: string }
 *
 * `data` is standard base64 (the same encoding the native TUI produces with
 * `Buffer.toString("base64")`). The session stores the images on the user
 * message, which this panel renders through the transcript's `MsgContent` image
 * path. Nothing is queued locally: the queue row lists OMP's own queue readback, and a
 * dequeued message's images come back through `queue-restore`.
 *
 * Limits come from the transport, not from taste:
 * - accepted formats mirror `SUPPORTED_IMAGE_MIME_TYPES` in the installed
 *   `@oh-my-pi/pi-utils` (PNG, JPEG, GIF, WebP) — the same set the native TUI
 *   accepts for image input;
 * - the byte budget is the chat message grammar's own image budget
 *   (`MAX_CHAT_IMAGE_BYTES` and `MAX_CHAT_IMAGES_BYTES` in
 *   `../../protocol/chat-messages.ts`, the one place the numbers live), so an
 *   oversized attachment is refused at selection time instead of being refused
 *   after the user pressed Send. The grammar's own budget sits under the broker's
 *   16 MiB stdin line, the tightest bound a prompt crosses on the panel route.
 *   OMP normalizes an attached image (at most 1568 px a side, about 500 KB)
 *   before it reaches the model and the session file, so the original is never
 *   stored and the panel does not downscale.
 *
 * Previews are `data:` URLs built from the very string that gets sent, because
 * the panel CSP allows `img-src <cspSource> data:` and nothing else — an object
 * URL would not render. Image bytes therefore live only in the values returned
 * here, which the composer drops on send, removal, and unmount.
 */

import { formatBytes } from "../../../shared/file-size.ts";
import { sniffImageMimeType } from "../../../shared/image-sniff.ts";
import { MAX_CHAT_IMAGES_BYTES, MAX_CHAT_IMAGE_BYTES } from "../../../protocol/chat-messages.ts";
import { MAX_ATTACH_ITEMS } from "../../../shared/attach-limits.ts";

/** Formats the host accepts for image input (pi-utils `SUPPORTED_IMAGE_MIME_TYPES`). */
export const SUPPORTED_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

export type SupportedImageMimeType = (typeof SUPPORTED_IMAGE_MIME_TYPES)[number];

/** `accept` attribute for the hidden file input. */
export const IMAGE_ACCEPT_ATTRIBUTE = SUPPORTED_IMAGE_MIME_TYPES.join(",");

/** Raw bytes allowed for one selected image. */
export const MAX_ATTACHMENT_BYTES = MAX_CHAT_IMAGE_BYTES;

/** Raw bytes allowed across one prompt's images. */
export const MAX_DRAFT_BYTES = MAX_CHAT_IMAGES_BYTES;

/** Human-readable format list used in failure messages. */
const FORMAT_LABELS = "PNG, JPEG, GIF, or WebP";

/** Bytes read at a time when base64-encoding; see {@link toBase64}. */
const BASE64_CHUNK_BYTES = 0x8000;

/** One image held in the current composer draft. */
export interface PendingImage {
	/** Stable key for React and for removal. */
	id: number;
	/** File name shown on the chip. */
	name: string;
	/** Sniffed from the bytes, never trusted from `File.type` alone. */
	mimeType: SupportedImageMimeType;
	/** Raw file size in bytes. */
	bytes: number;
	/** Standard base64 — the wire `ImageContent.data`. */
	data: string;
	/** Decoded pixel size, when the browser could read it; the draft's `[Image #N, WxH]` marker carries it. */
	width?: number;
	height?: number;
}

/** Outcome of reading one selected file: the image, or the reason it cannot be attached. */
export type AttachmentRead = { ok: true; image: PendingImage } | { ok: false; reason: string };

/** Raw bytes the draft already holds. */
export function rawTotal(images: readonly PendingImage[]): number {
	let total = 0;
	for (const image of images) total += image.bytes;
	return total;
}

/**
 * Why `file` cannot join a draft that already holds `rawSoFar` bytes, or `null`
 * when only {@link readImageAttachment} can still reject it (a mislabeled file:
 * the declared type is a hint, the bytes decide).
 *
 * Runs before the file is read, so an oversized pick is never loaded into
 * memory at all.
 */
export function sizeRejection(file: { name: string; size: number }, rawSoFar: number): string | null {
	if (file.size === 0) return `${file.name}: the file is empty.`;
	if (file.size > MAX_ATTACHMENT_BYTES) {
		return `${file.name}: ${formatBytes(file.size)} exceeds the ${formatBytes(MAX_ATTACHMENT_BYTES)} limit per image.`;
	}
	if (rawSoFar + file.size > MAX_DRAFT_BYTES) {
		return `${file.name}: this prompt would carry ${formatBytes(rawSoFar + file.size)} of images; the limit is ${formatBytes(MAX_DRAFT_BYTES)} per prompt.`;
	}
	return null;
}

/**
 * Read `file` into a draft image. Resolves a failure reason instead of throwing:
 * every rejection here is ordinary user input, not an exception.
 */
export async function readImageAttachment(file: File, id: number): Promise<AttachmentRead> {
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
	// A declared supported type that failed the byte check is a mislabeled file
	// (a renamed download, an HTML error page saved as `.png`): the bytes are the
	// problem, so offering the format list again would mislead.
	if (isSupportedImageMimeType(declared)) return `${file.name}: its contents are not a valid ${declared} image.`;
	return declared.length > 0 && declared !== "application/octet-stream"
		? `${file.name}: unsupported format (${declared}) — attach ${FORMAT_LABELS}.`
		: `${file.name}: not a ${FORMAT_LABELS} image.`;
}

/** Type guard over the host's format list, for a runtime MIME string. */
function isSupportedImageMimeType(value: string): value is SupportedImageMimeType {
	// `as readonly string[]` widens the literal tuple so an arbitrary string can be tested against it.
	return (SUPPORTED_IMAGE_MIME_TYPES as readonly string[]).includes(value);
}

/** Files in a paste or drop payload, in clipboard order: images and documents alike, told apart later by their first bytes. */
export function filesFrom(data: DataTransfer | null): File[] {
	if (data === null) return [];
	const files: File[] = [];
	for (let index = 0; index < data.items.length; index++) {
		const item = data.items[index];
		if (item === undefined || item.kind !== "file") continue;
		const file = item.getAsFile();
		if (file !== null) files.push(file);
	}
	return files;
}

/** Drag type VS Code's Explorer and editor tabs write: every dragged item as a `file:` URI line. */
const CODE_URI_LIST = "application/vnd.code.uri-list";

/**
 * What a drag carries that the composer can attach: `files` (an OS drag: the page reads the bytes), `uris` (a drag from
 * VS Code's Explorer or an editor tab: only addresses, the host reads them), or `null` (text, a link: left to the browser).
 * Only the type names are readable while a drag is over the page, never its data.
 */
export function dragCarries(data: DataTransfer): "files" | "uris" | null {
	if (Array.from(data.items).some(item => item.kind === "file")) return "files";
	const types = Array.from(data.types);
	return types.includes(CODE_URI_LIST) || types.includes("ResourceURLs") ? "uris" : null;
}

/** What a drop named: its `file:` URIs, or the sentence that refuses the whole drop (then `uris` is empty). */
export interface DroppedUris {
	readonly uris: string[];
	readonly refusal: string | null;
}

/**
 * Why `adding` more attachments cannot join a draft that already holds `held`: the structural guard of the wire grammar
 * (`MAX_ATTACH_ITEMS`, decision 9 of the attachments design), a bound on the parsers and the broker's line rather than a
 * rule the user is told about before reaching it. `null` when they fit.
 */
export function attachGuardRefusal(held: number, adding: number, limit = MAX_ATTACH_ITEMS): string | null {
	return held + adding > limit ? `At most ${limit} files can be attached at once.` : null;
}

/**
 * The `file:` URIs a drop names, in drag order; other schemes and comments are not attachments. It reads one past `limit`
 * so a drop over it is refused whole instead of silently losing everything after the `limit`th URI.
 */
export function droppedFileUris(data: DataTransfer | null, limit: number): DroppedUris {
	if (data === null) return { uris: [], refusal: null };
	const raw = data.getData(CODE_URI_LIST) || data.getData("text/uri-list");
	const uris: string[] = [];
	for (const line of raw.split(/\r?\n/)) {
		const uri = line.trim();
		if (/^file:/i.test(uri)) uris.push(uri);
		if (uris.length > limit) return { uris: [], refusal: attachGuardRefusal(uris.length, 0, limit) };
	}
	return { uris, refusal: null };
}

/** An image the host read for a drop, as a `File` the ordinary attach path takes. */
export function fileFromAttached(attached: { readonly name: string; readonly mimeType: string; readonly data: string }): File {
	const binary = atob(attached.data);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
	return new File([bytes as BlobPart], attached.name, { type: attached.mimeType });
}
