/**
 * The byte encoding the terminal frames use, both directions.
 *
 * A terminal's data is a byte stream: one chunk can split a UTF-8 sequence, an
 * escape sequence or a paste in half, and keystrokes include control characters
 * that must never be read as message syntax. So both sides carry bytes as standard
 * base64 and the boundary checks the encoded length *before* anything is decoded
 * (`../messages.ts`).
 *
 * `btoa`/`atob` are the platform's own codecs and are the only ones used: a
 * hand-written codec here would be a second implementation to keep correct, and the
 * payload sizes are bounded by the message budget (128 KiB decoded at most).
 */

/** Chunk size for `String.fromCharCode`, which cannot take a 128 KiB spread. */
const BASE64_CHUNK_BYTES = 4096;

/** Standard base64 (padded) of `bytes`. */
export function encodeBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_BYTES) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK_BYTES));
	}
	return btoa(binary);
}

/** The bytes `text` encodes, or `null` when it is not base64 at all. */
export function decodeBase64(text: string): Uint8Array | null {
	let binary: string;
	try {
		binary = atob(text);
	} catch {
		return null;
	}
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

/**
 * True when `text` is non-empty, canonical standard base64: groups of four, `=` padding only at the end.
 *
 * A linear scan, not a regular expression: the group-repetition expression that expresses this overflows V8's
 * regexp stack on a multi-megabyte string (an image), where this has no depth.
 */
export function isCanonicalBase64Text(text: string): boolean {
	const length = text.length;
	if (length === 0 || length % 4 !== 0) return false;
	let end = length;
	if (text.charCodeAt(end - 1) === 0x3d) end -= text.charCodeAt(end - 2) === 0x3d ? 2 : 1;
	for (let index = 0; index < end; index++) {
		const code = text.charCodeAt(index);
		const alphabet = (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || (code >= 0x30 && code <= 0x39) || code === 0x2b || code === 0x2f;
		if (!alphabet) return false;
	}
	return true;
}

/**
 * `text` as UTF-8 base64 chunks of at most `maxBytes` decoded bytes each.
 *
 * Chunks are cut on byte boundaries, not character boundaries, so one character can
 * straddle two messages. That is safe here and only here: the chunks are sent in
 * order on one transport and the host writes them to the one PTY in that order, so
 * the byte stream the terminal reads is identical to the one this pane produced.
 * Empty text produces no chunk — an empty input frame says nothing.
 */
export function encodeUtf8Chunks(text: string, maxBytes: number): string[] {
	const bytes = new TextEncoder().encode(text);
	const chunks: string[] = [];
	for (let offset = 0; offset < bytes.length; offset += maxBytes) {
		chunks.push(encodeBase64(bytes.subarray(offset, offset + maxBytes)));
	}
	return chunks;
}
