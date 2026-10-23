/**
 * What the Draft asks of a `File` it was handed by a paste or a drop from the operating system
 * (docs/designs/2026-10-16-chat-document-attachments.md, *Proposed Design* 1), and the courtesy check of a document's room. The reading
 * itself is `lib/attach-reader.ts`'s: it decides what a file is by its first bytes and reads the text of one that is a document, by the
 * same rule as the host's own (`src/host/attached-files.ts`, through `src/shared/text-file.ts`), so a file is refused with the same
 * sentence whichever way it arrived.
 */
import { MAX_MESSAGE_CHARS } from "../../../shared/attach-limits.ts";
import { groupedCount } from "../../../shared/file-size.ts";

/** What a file is, decided before its size is judged: a 6 MiB `.pdf` is a binary, not an oversized image. */
export type FileClass =
	| { readonly kind: "image" }
	| { readonly kind: "text" }
	| { readonly kind: "refused"; readonly reason: string };

/** The text of a document, or the sentence for why it is not attached. */
export type DocumentRead =
	| { readonly ok: true; readonly content: string; readonly bytes: number }
	| { readonly ok: false; readonly reason: string };

/** The courtesy check of an attach: whether adding `chars` characters keeps the draft within one message. `known` is the draft's text plus every document already in it. */
export function draftRoomRefusal(name: string, chars: number, known: number): string | null {
	return known + chars > MAX_MESSAGE_CHARS
		? `Adding ${name} (${groupedCount(chars)} characters) would take the draft over ${groupedCount(MAX_MESSAGE_CHARS)} characters.`
		: null;
}
