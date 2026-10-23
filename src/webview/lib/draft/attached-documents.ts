/**
 * What the page does with a `File` it was handed by a paste or a drop from the operating system
 * (docs/designs/2026-10-16-chat-document-attachments.md, *Proposed Design* 1): decide what the file is by its first bytes,
 * and read the text of one that is a document. The host applies the same rule to a file it reads by path
 * (`src/host/attached-files.ts`), through the same `src/shared/text-file.ts`, so a file is refused with the same sentence
 * whichever way it arrived.
 */
import { MAX_DOCUMENT_BYTES, MAX_MESSAGE_CHARS } from "../../../shared/attach-limits.ts";
import { formatBytes, groupedCount } from "../../../shared/file-size.ts";
import { sniffImageMimeType, sniffUnsupportedImageMimeType } from "../../../shared/image-sniff.ts";
import { TEXT_SNIFF_BYTES, decodeTextFile, sniffTextFile, textFileRefusalSentence } from "../../../shared/text-file.ts";

const FORMATS = "PNG, JPEG, GIF, or WebP";

/** What a file is, decided before its size is judged: a 6 MiB `.pdf` is a binary, not an oversized image. */
export type FileClass =
	| { readonly kind: "image" }
	| { readonly kind: "text" }
	| { readonly kind: "refused"; readonly reason: string };

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

/** The text of a document, or the sentence for why it is not attached. */
export type DocumentRead =
	| { readonly ok: true; readonly content: string; readonly bytes: number }
	| { readonly ok: false; readonly reason: string };

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

/** The courtesy check of an attach: whether adding `chars` characters keeps the draft within one message. `known` is the draft's text plus every document already in it. */
export function draftRoomRefusal(name: string, chars: number, known: number): string | null {
	return known + chars > MAX_MESSAGE_CHARS
		? `Adding ${name} (${groupedCount(chars)} characters) would take the draft over ${groupedCount(MAX_MESSAGE_CHARS)} characters.`
		: null;
}
