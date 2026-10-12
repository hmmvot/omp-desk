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
