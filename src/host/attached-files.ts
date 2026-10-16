/**
 * Reads the files an attach names, and the text of the ones a message carries, for the Chat composer
 * (docs/designs/2026-10-16-chat-document-attachments.md, *Proposed Design* 2).
 *
 * Three things reach the host: the URIs a drag from VS Code's Explorer or an editor tab names (`omp:attach-uris`), the
 * paths the host's own file dialog returned (`omp:pick-files`), and, at send, the references of the files a draft holds
 * (`omp:read-files`). The URIs are untrusted text from a page, so nothing is read unless it is a local drive path (a
 * `file:` URI with a host would be a network share, which Windows authenticates to by itself); a path the user chose in the
 * dialog may also be a network path. An image comes back as an image. A file that is text comes back as a document **without
 * its text**: the host mints an opaque reference for its path, and reads it again at send. Anything else is one sentence.
 */
import { open, stat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_CHAT_IMAGES_BYTES, MAX_CHAT_IMAGE_BYTES } from "../protocol/chat-messages.ts";
import type { GuestAttachedDocument, GuestAttachedItem, GuestFileReadFailure, GuestFileText, GuestReadFileRef } from "../protocol/messages.ts";
import { MAX_ATTACH_ITEMS, MAX_DOCUMENT_BYTES, MAX_MESSAGE_CHARS } from "../shared/attach-limits.ts";
import { formatBytes, groupedCount } from "../shared/file-size.ts";
import { sniffImageMimeType, sniffUnsupportedImageMimeType } from "../shared/image-sniff.ts";
import { TEXT_SNIFF_BYTES, decodeTextFile, sniffTextFile, textFileRefusalSentence } from "../shared/text-file.ts";
import { comparablePosix, mentionPath } from "./file-mentions.ts";

const LOCAL_DRIVE_PATH = /^[A-Za-z]:[\\/]/;
const FORMATS = "PNG, JPEG, GIF, or WebP";

/** Where a registered path came from: the user chose it in the host's dialog, or a page relayed it from a drop. */
export type AttachOrigin = "dialog" | "drop";

interface RegisteredPath {
	readonly path: string;
	readonly origin: AttachOrigin;
}

/**
 * The paths one tab attached, by the opaque reference the page holds. The page never names a path to read: it hands a
 * reference back at send, so a stale or unknown one fails instead of reading something else, and a network path is opened
 * only when the user chose it in the dialog (the origin is recorded and the drop rule is enforced again at read). The same
 * path attached twice, in any casing, has one reference. At `capacity` entries the least recently used one is evicted.
 */
export class AttachedFileRegistry {
	readonly #byRef = new Map<string, RegisteredPath>();
	readonly #byKey = new Map<string, string>();
	readonly #capacity: number;

	constructor(capacity: number = MAX_ATTACH_ITEMS) {
		this.#capacity = capacity;
	}

	get size(): number {
		return this.#byRef.size;
	}

	/** The reference of `absolutePath`, minting one when it has none. A path first dropped and then chosen in the dialog becomes a dialog path. */
	register(absolutePath: string, origin: AttachOrigin): string {
		const key = comparablePosix(absolutePath);
		const known = this.#byKey.get(key);
		if (known !== undefined) {
			const entry = this.#byRef.get(known)!;
			this.#byRef.delete(known);
			this.#byRef.set(known, origin === "dialog" && entry.origin === "drop" ? { path: entry.path, origin } : entry);
			return known;
		}
		const ref = randomBytes(12).toString("base64url");
		this.#byRef.set(ref, { path: absolutePath, origin });
		this.#byKey.set(key, ref);
		while (this.#byRef.size > this.#capacity) {
			const oldest = this.#byRef.entries().next().value!;
			this.#byRef.delete(oldest[0]);
			this.#byKey.delete(comparablePosix(oldest[1].path));
		}
		return ref;
	}

	/** The path a reference names, or `null` when it is unknown or was evicted. Using it makes it the most recent. */
	resolve(ref: string): RegisteredPath | null {
		const entry = this.#byRef.get(ref);
		if (entry === undefined) return null;
		this.#byRef.delete(ref);
		this.#byRef.set(ref, entry);
		return entry;
	}
}

/** What an attach names: a URI a page relayed from a drop, or a path the host's dialog returned. */
export type AttachSource = { readonly uri: string } | { readonly path: string };

export interface AttachedFiles {
	/** One item per file that was attached, in the order asked. */
	readonly items: GuestAttachedItem[];
	/** One sentence per file that was not attached. */
	readonly refusals: string[];
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
	if (url.hostname !== "") return { refusal: "files on a network share are not read by dropping; attach it with the attach button or copy it locally first." };
	let file: string;
	try {
		file = fileURLToPath(url);
	} catch {
		return { refusal: "this is not a local file path." };
	}
	return LOCAL_DRIVE_PATH.test(file) ? { path: file } : { refusal: "this is not a local file path." };
}

/** Reads exactly `size` bytes, or `null` when the file changed while it was read. */
async function readWhole(file: string, size: number): Promise<Buffer | null> {
	const handle = await open(file, "r");
	try {
		const bytes = Buffer.allocUnsafe(size);
		let read = 0;
		while (read < bytes.length) {
			const { bytesRead } = await handle.read(bytes, read, bytes.length - read, read);
			if (bytesRead === 0) break;
			read += bytesRead;
		}
		return read === bytes.length ? bytes : null;
	} finally {
		await handle.close();
	}
}

/** Reads up to `length` leading bytes of a file. */
async function readPrefix(file: string, length: number): Promise<Buffer> {
	const handle = await open(file, "r");
	try {
		const bytes = Buffer.allocUnsafe(length);
		const { bytesRead } = await handle.read(bytes, 0, length, 0);
		return bytes.subarray(0, bytesRead);
	} finally {
		await handle.close();
	}
}

/**
 * Attach what `sources` name. Each distinct file is classified by its first bytes, never by its name: an image follows the
 * image limits and comes back as an image; anything else must be UTF-8 text with no control character other than tab and
 * newline, at most `MAX_MESSAGE_CHARS` characters (a file above `MAX_DOCUMENT_BYTES` is refused unread), and comes back as a
 * document with a reference. An empty file is a document of 0 bytes.
 */
export async function readAttachedFiles(sources: readonly AttachSource[], registry: AttachedFileRegistry): Promise<AttachedFiles> {
	const items: GuestAttachedItem[] = [];
	const refusals: string[] = [];
	const seen = new Set<string>();
	let imageBytes = 0;
	for (const source of sources) {
		let located: { readonly path: string } | { readonly refusal: string };
		let origin: AttachOrigin;
		if ("uri" in source) {
			located = localPathOf(source.uri);
			origin = "drop";
		} else {
			located = path.isAbsolute(source.path) ? { path: source.path } : { refusal: "this is not an absolute file path." };
			origin = "dialog";
		}
		if ("refusal" in located) {
			const key = `refused:${"uri" in source ? source.uri : source.path}`;
			if (seen.has(key)) continue;
			seen.add(key);
			refusals.push(`${"uri" in source ? "Dropped item" : "Picked item"}: ${located.refusal}`);
			continue;
		}
		const key = comparablePosix(located.path);
		if (seen.has(key)) continue;
		seen.add(key);
		const name = path.basename(located.path);
		const refuse = (reason: string): void => void refusals.push(`${name}: ${reason}`);
		try {
			const info = await stat(located.path);
			if (info.isDirectory()) {
				refuse("a folder cannot be attached; attach the files in it.");
				continue;
			}
			if (!info.isFile()) {
				refuse("is not a file.");
				continue;
			}
			const prefix = info.size === 0 ? Buffer.alloc(0) : await readPrefix(located.path, Math.min(info.size, TEXT_SNIFF_BYTES));
			const mimeType = sniffImageMimeType(prefix);
			if (mimeType !== null) {
				if (info.size > MAX_CHAT_IMAGE_BYTES) {
					refuse(`${formatBytes(info.size)} exceeds the ${formatBytes(MAX_CHAT_IMAGE_BYTES)} limit per image.`);
					continue;
				}
				if (imageBytes + info.size > MAX_CHAT_IMAGES_BYTES) {
					refuse(`this prompt would carry ${formatBytes(imageBytes + info.size)} of images; the limit is ${formatBytes(MAX_CHAT_IMAGES_BYTES)} per prompt.`);
					continue;
				}
				const bytes = await readWhole(located.path, info.size);
				if (bytes === null) {
					refuse("the file changed while it was read.");
					continue;
				}
				imageBytes += bytes.length;
				items.push({ kind: "image", name, mimeType, data: bytes.toString("base64") });
				continue;
			}
			const unsupported = sniffUnsupportedImageMimeType(prefix);
			if (unsupported !== null) {
				refuse(`unsupported format (${unsupported}) — attach ${FORMATS}.`);
				continue;
			}
			const sniffed = sniffTextFile(prefix);
			if (sniffed !== null) {
				refusals.push(textFileRefusalSentence(name, sniffed));
				continue;
			}
			if (info.size > MAX_DOCUMENT_BYTES) {
				refusals.push(`${name} is ${formatBytes(info.size)}; one message carries at most ${groupedCount(MAX_MESSAGE_CHARS)} characters.`);
				continue;
			}
			const bytes = info.size === 0 ? Buffer.alloc(0) : await readWhole(located.path, info.size);
			if (bytes === null) {
				refuse("the file changed while it was read.");
				continue;
			}
			const decoded = decodeTextFile(bytes);
			if (!decoded.ok) {
				refusals.push(textFileRefusalSentence(name, decoded.reason));
				continue;
			}
			if (decoded.text.length > MAX_MESSAGE_CHARS) {
				refusals.push(`${name} is ${groupedCount(decoded.text.length)} characters; one message carries at most ${groupedCount(MAX_MESSAGE_CHARS)}.`);
				continue;
			}
			const document: GuestAttachedDocument = { kind: "document", name, ref: registry.register(located.path, origin), bytes: info.size, chars: decoded.text.length };
			items.push(document);
		} catch {
			refuse("could not be read.");
		}
	}
	return { items, refusals };
}

/** What the read at send needs to know of the session and the window. */
export interface SendReadContext {
	/** The session's working directory, or `null` while it has none (labels are then absolute). */
	readonly cwd: string | null;
	/** True when an open editor holds unsaved changes to this file. */
	isDirty(absolutePath: string): boolean;
}

export interface FilesRead {
	readonly files: GuestFileText[];
	readonly failures: GuestFileReadFailure[];
}

/**
 * Read the files a message is about to carry, in order. Each file is validated again (it may have changed since the attach)
 * and a failure is one entry of `failures`, not a refusal of the request; the page refuses the send on any failure. The
 * running sum of characters may not pass `budget`. The saved file is read, never an editor's unsaved text.
 */
export async function readAttachedForSend(files: readonly GuestReadFileRef[], budget: number, registry: AttachedFileRegistry, context: SendReadContext): Promise<FilesRead> {
	const read: GuestFileText[] = [];
	const failures: GuestFileReadFailure[] = [];
	let sum = 0;
	for (const { number, ref } of files) {
		const entry = registry.resolve(ref);
		if (entry === null) {
			failures.push({ number, name: "", reason: "An attached file is no longer known; attach it again." });
			continue;
		}
		const name = path.basename(entry.path);
		const fail = (reason: string): void => void failures.push({ number, name, reason });
		if (entry.origin === "drop" && !LOCAL_DRIVE_PATH.test(entry.path)) {
			fail(`${name} is on a network share, which only the attach button may open.`);
			continue;
		}
		try {
			const info = await stat(entry.path);
			if (!info.isFile()) {
				fail(`${name} is no longer a file.`);
				continue;
			}
			if (info.size > MAX_DOCUMENT_BYTES) {
				fail(`${name} is now ${formatBytes(info.size)}; one message carries at most ${groupedCount(MAX_MESSAGE_CHARS)} characters.`);
				continue;
			}
			const bytes = info.size === 0 ? Buffer.alloc(0) : await readWhole(entry.path, info.size);
			if (bytes === null) {
				fail(`${name} changed while it was read.`);
				continue;
			}
			const decoded = decodeTextFile(bytes);
			if (!decoded.ok) {
				failures.push({ number, name, reason: textFileRefusalSentence(name, decoded.reason) });
				continue;
			}
			if (sum + decoded.text.length > budget) {
				fail(`${name} (${groupedCount(decoded.text.length)} characters) would take the message over the ${groupedCount(MAX_MESSAGE_CHARS)}-character limit.`);
				continue;
			}
			sum += decoded.text.length;
			read.push({ number, label: mentionPath(entry.path, context.cwd ?? ""), content: decoded.text, dirty: context.isDirty(entry.path) });
		} catch (error) {
			fail((error as NodeJS.ErrnoException).code === "ENOENT" ? `${name} no longer exists.` : `${name} could not be read.`);
		}
	}
	return { files: read, failures };
}
