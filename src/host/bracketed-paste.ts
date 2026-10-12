import { MAX_INSERT_TEXT_LENGTH } from "../protocol/messages.ts";

/** Control characters, C1 included, would corrupt a prompt line or a bracketed paste. */
export const UNSAFE_PATH = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * The native TUI's input as a paste: bracketed-paste markers around one line, with a space on each
 * side so the mention starts after whitespace (OMP ignores `@` glued to a word) and typing can
 * continue. There is deliberately no carriage return or newline: Enter would submit.
 *
 * `null` for text the TUI could not take as one small paste.
 */
export function bracketedPaste(text: string): string | null {
	// Checked before trimming: a trailing carriage return is exactly the Enter this must never send.
	if (UNSAFE_PATH.test(text)) return null;
	const body = text.trim();
	if (body.length === 0 || body.length > MAX_INSERT_TEXT_LENGTH - 2) return null;
	return `\u001b[200~ ${body} \u001b[201~`;
}
