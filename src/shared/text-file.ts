/**
 * The text rule for an attached file, one module for the page and the host so both refuse the same bytes
 * (docs/designs/2026-10-16-chat-document-attachments.md, *Proposed Design* 2).
 *
 * A file is text because its bytes are: valid UTF-8 with no control character other than tab and newline. There is no
 * extension or MIME rule, so `Makefile`, `.foo` and a renamed `.png` that is not an image are decided by content.
 */

/**
 * Control characters a draft or a file's text may not carry.
 *
 * Newlines and tabs are part of prose and are kept; everything else, including a bare carriage return, would corrupt the
 * message or, once restored, the prompt line. A draft holding one is refused as a whole rather than repaired.
 */
export const DRAFT_CONTROL_CHARACTER = /[\u0000-\u0008\u000b-\u001f\u007f]/;

/** Line endings of pasted, dropped or read text, as the draft keeps them: a lone `\r` is a line ending too. */
export function normalizeLineEndings(text: string): string {
	return text.replace(/\r\n?/g, "\n");
}

/** Why bytes are not a text file. */
export type TextFileRefusal = "not-utf8" | "control-characters";

export type DecodedTextFile = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: TextFileRefusal };

/** How many leading bytes of a file decide, before the whole file is read, that it is not text. */
export const TEXT_SNIFF_BYTES = 64 * 1024;

/**
 * The text of `bytes`: decoded as strict UTF-8 (the decoder drops one leading byte order mark), line endings normalised to
 * `\n`. Refused when the bytes are not UTF-8 or the text holds a control character other than tab and newline.
 */
export function decodeTextFile(bytes: Uint8Array): DecodedTextFile {
	let decoded: string;
	try {
		decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return { ok: false, reason: "not-utf8" };
	}
	const text = normalizeLineEndings(decoded);
	return DRAFT_CONTROL_CHARACTER.test(text) ? { ok: false, reason: "control-characters" } : { ok: true, text };
}

/**
 * The text rule on a bounded prefix of a file: refuses a binary of any size without reading it whole. An incomplete UTF-8
 * sequence at the cut is ignored, because the prefix may end in the middle of a character.
 */
export function sniffTextFile(prefix: Uint8Array): TextFileRefusal | null {
	let decoded: string;
	try {
		decoded = new TextDecoder("utf-8", { fatal: true }).decode(prefix, { stream: true });
	} catch {
		return "not-utf8";
	}
	return DRAFT_CONTROL_CHARACTER.test(normalizeLineEndings(decoded)) ? "control-characters" : null;
}

/** The sentence for a refusal, naming the file. */
export function textFileRefusalSentence(name: string, reason: TextFileRefusal): string {
	return `${name} is not a text file (${reason === "not-utf8" ? "its bytes are not UTF-8" : "it contains control characters"}).`;
}
