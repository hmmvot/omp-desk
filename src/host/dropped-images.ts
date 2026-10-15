/**
 * Reads the image files a drag from VS Code's own Explorer or an editor tab names.
 *
 * Such a drag carries `file:` URIs, never `File` objects, so the composer cannot read it and asks the host (`omp:attach-uris`).
 * The URIs are untrusted text from a page, so nothing is read unless it is a local drive path (a `file:` URI with a host
 * would be a network share, which Windows authenticates to by itself) naming a regular file of a supported image format
 * within the per-image and per-prompt limits; a file that is anything else is refused in one sentence, never returned.
 */
import { open, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_CHAT_IMAGES_BYTES, MAX_CHAT_IMAGE_BYTES } from "../protocol/chat-messages.ts";
import type { GuestAttachedFile } from "../protocol/messages.ts";
import { sniffImageMimeType } from "../shared/image-sniff.ts";

const LOCAL_DRIVE_PATH = /^[A-Za-z]:[\\/]/;
const FORMATS = "PNG, JPEG, GIF, or WebP";

export interface DroppedImages {
	readonly files: GuestAttachedFile[];
	/** One sentence per URI that was not attached. */
	readonly refusals: string[];
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The local drive path a `file:` URI names, or why it names none. */
function localPathOf(uri: string): { readonly path: string } | { readonly refusal: string } {
	let url: URL;
	try {
		url = new URL(uri);
	} catch {
		return { refusal: "only files can be attached by dropping; this is not a file address." };
	}
	if (url.protocol !== "file:") return { refusal: "only files on this computer can be attached by dropping." };
	if (url.hostname !== "") return { refusal: "files on a network share are not read by dropping; open or copy the image locally first." };
	let file: string;
	try {
		file = fileURLToPath(url);
	} catch {
		return { refusal: "this is not a local file path." };
	}
	return LOCAL_DRIVE_PATH.test(file) ? { path: file } : { refusal: "this is not a local file path." };
}

/** Read what `uris` name, refusing each that is not a supported image within the prompt's limits. */
export async function readDroppedImages(uris: readonly string[]): Promise<DroppedImages> {
	const files: GuestAttachedFile[] = [];
	const refusals: string[] = [];
	let total = 0;
	for (const uri of new Set(uris)) {
		const located = localPathOf(uri);
		if ("refusal" in located) {
			refusals.push(`Dropped item: ${located.refusal}`);
			continue;
		}
		const name = path.basename(located.path);
		const refuse = (reason: string): void => void refusals.push(`${name}: ${reason}`);
		try {
			const info = await stat(located.path);
			if (!info.isFile()) {
				refuse("is not a file.");
				continue;
			}
			if (info.size === 0) {
				refuse("the file is empty.");
				continue;
			}
			if (info.size > MAX_CHAT_IMAGE_BYTES) {
				refuse(`${formatBytes(info.size)} exceeds the ${formatBytes(MAX_CHAT_IMAGE_BYTES)} limit per image.`);
				continue;
			}
			if (total + info.size > MAX_CHAT_IMAGES_BYTES) {
				refuse(`this prompt would carry ${formatBytes(total + info.size)} of images; the limit is ${formatBytes(MAX_CHAT_IMAGES_BYTES)} per prompt.`);
				continue;
			}
			const handle = await open(located.path, "r");
			let bytes: Buffer;
			try {
				bytes = Buffer.allocUnsafe(info.size);
				let read = 0;
				while (read < bytes.length) {
					const { bytesRead } = await handle.read(bytes, read, bytes.length - read, read);
					if (bytesRead === 0) break;
					read += bytesRead;
				}
				if (read !== bytes.length) {
					refuse("the file changed while it was read.");
					continue;
				}
			} finally {
				await handle.close();
			}
			const mimeType = sniffImageMimeType(bytes);
			if (mimeType === null) {
				refuse(`not a ${FORMATS} image.`);
				continue;
			}
			total += bytes.length;
			files.push({ name, mimeType, data: bytes.toString("base64") });
		} catch {
			refuse("could not be read.");
		}
	}
	return { files, refusals };
}
