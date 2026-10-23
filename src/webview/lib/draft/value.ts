/**
 * The Draft value (docs/designs/2026-10-23-composer-draft-module.md, section 2): one immutable record that holds everything the
 * composer's rules read, so a rule is a function of it and a node test can build it with {@link emptyDraft}.
 *
 * The text is the only text, and an attachment exists exactly while its marker is in it; the lists keep attachments whose marker
 * was deleted until the budget forces their release, so Undo (the surface's, text only) brings the marker and its attachment back.
 */
import type { ImageContent } from "@oh-my-pi/pi-wire";
import type { HistoryCursor } from "../../../chat/prompt-history.ts";
import type { PendingImage } from "./attachments.ts";
import { isKnownDocument, type DraftDocument } from "./draft-documents.ts";
import type { ReferenceKind } from "./image-references.ts";

/** An image of the current draft: the attachment plus its stable reference number. */
export type DraftImage = PendingImage & { readonly number: number };

/** A message kept as a card beside the draft: a refused or uncertain send, or the draft a Rewind held. */
export interface Recoverable {
	readonly id: number;
	readonly text: string;
	readonly images: readonly ImageContent[];
	readonly reason: string;
	readonly unconfirmed: boolean;
	/** Images of a draft that moved here: their bytes were never carried, so they must be attached again. */
	readonly lostAttachments?: number;
	/** Linked files of a draft that moved here: their text is not on the page, so the file must be attached again. */
	readonly lostFiles?: number;
}

export interface Draft {
	/** The Markdown string; the only text. */
	readonly text: string;
	/** Every attached image, including ones whose marker was deleted and Undo can bring back. */
	readonly images: readonly DraftImage[];
	/** The same for files (linked: read at send; held: text on the page). */
	readonly documents: readonly DraftDocument[];
	/** Never reused within a draft; `image` and `document` restart when a draft is cleared, `key` and `card` never do. */
	readonly next: { readonly image: number; readonly document: number; readonly key: number; readonly card: number };
	/** Held by reads in flight, so overlapping attaches budget against one running total. */
	readonly reserved: { readonly bytes: number; readonly chars: number };
	/** Reads in flight (attach and host-read drops); the linked read at send is not one. */
	readonly reading: number;
	/** Images a hand-off could not carry. */
	readonly lostImages: number;
	/** Goes up in the cell's `commit` and for a user edit, and nowhere else (`cell.ts`). */
	readonly revision: number;
	/** The revision right after a Rewind or Stop refill; Undo of that refill clears the draft only while it still holds. */
	readonly unedited: number | null;
	/** The ↑/↓ prompt-history walk in progress. */
	readonly walk: HistoryCursor | null;
	readonly recoverable: readonly Recoverable[];
	/** The message awaiting admission (a capture carries it as unconfirmed). */
	readonly inFlight: { readonly text: string; readonly images: readonly ImageContent[] } | null;
}

/** The draft of a composer that has just opened. */
export function emptyDraft(): Draft {
	return {
		text: "",
		images: [],
		documents: [],
		next: { image: 1, document: 1, key: 1, card: 1 },
		reserved: { bytes: 0, chars: 0 },
		reading: 0,
		lostImages: 0,
		revision: 0,
		unedited: null,
		walk: null,
		recoverable: [],
		inFlight: null,
	};
}

/**
 * `draft` with the fields of `patch` replaced, for the writers that have not moved into the module yet. Never the revision: that
 * is the cell's alone. An operation that sets `unedited` carries a `text` write, and the cell stores the revision it produced.
 */
export function withState(draft: Draft, patch: Partial<Omit<Draft, "revision">>): Draft {
	return { ...draft, ...patch };
}

/**
 * Whether a marker belongs to an attachment of `draft`. For a file `name` is the label after `File #N: `: a marker counts only when
 * its whole label is the document's own, so a pasted `[File #1: other.md]` is prose; an image's `name` is empty.
 */
export function knowsReference(draft: Draft, kind: ReferenceKind, number: number, name: string): boolean {
	return kind === "image" ? draft.images.some(image => image.number === number) : isKnownDocument(draft.documents, number, name);
}
