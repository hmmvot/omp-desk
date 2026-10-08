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
 *   (`MAX_CHAT_IMAGE_BASE64_CHARS` and `MAX_CHAT_IMAGES_BASE64_CHARS` in
 *   `../chat-messages.ts`), so an oversized attachment is refused at selection
 *   time instead of being refused after the user pressed Send.
 *   {@link MAX_DRAFT_BYTES} raw bytes encode to ≈768 KiB of base64.
 *
 * Previews are `data:` URLs built from the very string that gets sent, because
 * the panel CSP allows `img-src <cspSource> data:` and nothing else — an object
 * URL would not render. Image bytes therefore live only in the values returned
 * here, which the composer drops on send, removal, and unmount.
 */

/** Formats the host accepts for image input (pi-utils `SUPPORTED_IMAGE_MIME_TYPES`). */
export const SUPPORTED_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

export type SupportedImageMimeType = (typeof SUPPORTED_IMAGE_MIME_TYPES)[number];

/** `accept` attribute for the hidden file input. */
export const IMAGE_ACCEPT_ATTRIBUTE = SUPPORTED_IMAGE_MIME_TYPES.join(",");

/** Raw bytes allowed for one selected image. */
export const MAX_ATTACHMENT_BYTES = 512 * 1024;

/** Raw bytes allowed across one prompt's images (≈768 KiB as base64). */
export const MAX_DRAFT_BYTES = 576 * 1024;

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

/** "912 B", "512 KB", "1.4 MB". */
export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

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
 * Standard base64 of `bytes`, chunked: a single spread of a 512 KiB file into
 * `String.fromCharCode` would exceed the argument limit.
 */
function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_BYTES) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK_BYTES));
	}
	return btoa(binary);
}

/** Full PNG signature: 89 50 4E 47 0D 0A 1A 0A. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** JPEG start of image plus the first marker prefix. */
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];

/** RIFF container magic and the WebP form type that must follow its size field. */
const RIFF_SIGNATURE = [..."RIFF"].map(character => character.charCodeAt(0));
const WEBP_FORM_TYPE = [..."WEBP"].map(character => character.charCodeAt(0));

/**
 * MIME type of `bytes` from its file signature, or `null` when it is not one of
 * the formats the host advertises.
 *
 * A signature is a structural check, not a decode: a truncated or corrupt file
 * whose header is intact still passes here and is left to the provider boundary
 * (and the model) to reject. What this does catch is a file that is not that
 * format at all — which matters because the host forwards `mimeType` straight
 * to the model provider, and a mislabeled payload is a provider error rather
 * than a visible failure. The declared `File.type` is a hint from an OS
 * extension mapping (empty for some clipboard and renamed files); the bytes
 * decide.
 */
function sniffImageMimeType(bytes: Uint8Array): SupportedImageMimeType | null {
	if (signatureAt(bytes, 0, PNG_SIGNATURE)) return "image/png";
	if (signatureAt(bytes, 0, JPEG_SIGNATURE)) return "image/jpeg";
	// GIF87a / GIF89a: the 6-byte version-stamped header.
	const gifHeader = ascii(bytes, 0, 6);
	if (gifHeader === "GIF87a" || gifHeader === "GIF89a") return "image/gif";
	if (signatureAt(bytes, 0, RIFF_SIGNATURE) && signatureAt(bytes, 8, WEBP_FORM_TYPE)) return "image/webp";
	return null;
}

/** True when `signature` sits at `offset` in `bytes`. */
function signatureAt(bytes: Uint8Array, offset: number, signature: readonly number[]): boolean {
	if (bytes.length < offset + signature.length) return false;
	for (let index = 0; index < signature.length; index++) {
		if (bytes[offset + index] !== signature[index]) return false;
	}
	return true;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
	let text = "";
	for (let index = offset; index < offset + length; index++) text += String.fromCharCode(bytes[index] ?? 0);
	return text;
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

/** Image files in a paste payload, in clipboard order. */
export function imageFilesFrom(data: DataTransfer | null): File[] {
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
