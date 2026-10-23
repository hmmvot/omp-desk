/**
 * The budgets and the shape of the image attachments of the composer draft.
 *
 * Wire shape, as the host forwards it to OMP's `prompt`/`steer`/`follow_up` commands (`ImageContent` of `@oh-my-pi/pi-wire`):
 *
 *     ImageContent = { type: "image"; data: string; mimeType: string }
 *
 * `data` is standard base64 (the same encoding the native TUI produces with `Buffer.toString("base64")`). The session stores the images
 * on the user message, which this panel renders through the transcript's `MsgContent` image path. Nothing is queued locally: the queue
 * row lists OMP's own queue readback, and a dequeued message's images come back through `queue-restore`.
 *
 * Limits come from the transport, not from taste:
 * - the byte budget is the chat message grammar's own image budget (`MAX_CHAT_IMAGE_BYTES` and `MAX_CHAT_IMAGES_BYTES` in
 *   `../../protocol/chat-messages.ts`, the one place the numbers live), so an oversized attachment is refused at selection time instead
 *   of being refused after the user pressed Send. The grammar's budget sits under the broker's 16 MiB stdin line, the tightest bound a
 *   prompt crosses on the panel route. OMP normalizes an attached image (at most 1568 px a side, about 500 KB) before it reaches the model
 *   and the session file, so the original is never stored and the panel does not downscale.
 *
 * Previews are `data:` URLs built from the very string that gets sent, because the panel CSP allows `img-src <cspSource> data:` and
 * nothing else — an object URL would not render. Image bytes therefore live only in the Draft value, which the composer drops on send,
 * removal, and unmount. How a `File` becomes an image is `lib/attach-reader.ts`'s.
 */
import { formatBytes } from "../../../shared/file-size.ts";
import type { SniffedImageMimeType } from "../../../shared/image-sniff.ts";
import { MAX_CHAT_IMAGES_BYTES, MAX_CHAT_IMAGE_BYTES } from "../../../protocol/chat-messages.ts";
import { MAX_ATTACH_ITEMS } from "../../../shared/attach-limits.ts";

/** Raw bytes allowed for one selected image. */
const MAX_ATTACHMENT_BYTES = MAX_CHAT_IMAGE_BYTES;

/** Raw bytes allowed across one prompt's images. */
export const MAX_DRAFT_BYTES = MAX_CHAT_IMAGES_BYTES;

/** One image held in the current composer draft. */
export interface PendingImage {
	/** Stable key for React and for removal. */
	id: number;
	/** File name shown on the chip. */
	name: string;
	/** Sniffed from the bytes, never trusted from `File.type` alone. */
	mimeType: SniffedImageMimeType;
	/** Raw file size in bytes. */
	bytes: number;
	/** Standard base64 — the wire `ImageContent.data`. */
	data: string;
	/** Decoded pixel size, when the browser could read it; the draft's `[Image #N, WxH]` marker carries it. */
	width?: number;
	height?: number;
}

/** Outcome of reading one selected file: the image, or the reason it cannot be attached. */
export type ImageRead = { ok: true; image: PendingImage } | { ok: false; reason: string };

/** Raw bytes the draft already holds. */
export function rawTotal(images: readonly PendingImage[]): number {
	let total = 0;
	for (const image of images) total += image.bytes;
	return total;
}

/**
 * Why `file` cannot join a draft that already holds `rawSoFar` bytes, or `null` when only the reader can still reject it (a mislabeled
 * file: the declared type is a hint, the bytes decide).
 *
 * Runs before the file is read, so an oversized pick is never loaded into memory at all.
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
 * Why `adding` more attachments cannot join a draft that already holds `held`: the structural guard of the wire grammar
 * (`MAX_ATTACH_ITEMS`, decision 9 of the attachments design), a bound on the parsers and the broker's line rather than a
 * rule the user is told about before reaching it. `null` when they fit.
 */
export function attachGuardRefusal(held: number, adding: number, limit = MAX_ATTACH_ITEMS): string | null {
	return held + adding > limit ? `At most ${limit} files can be attached at once.` : null;
}
