/**
 * The documents attached to a composer draft (docs/designs/2026-10-16-chat-document-attachments.md, *Proposed Design* 1 and 3).
 *
 * A document is one `[File #N: name]` marker in the draft and one entry here, with the lifecycle of an image: it is attached
 * exactly while its marker is in the text, it keeps its number while editing, and one whose marker was deleted is retained
 * only so Undo can bring it back. Where its text lives until the send is the only difference between the two sources:
 * a **linked** file has a path the host knows by an opaque `ref` and is read from disk when sent; a **held** file has no
 * path (it was pasted or dropped from the OS, or it is a message restored from history) and the page keeps its text.
 *
 * Everything here is pure; the composer owns the state.
 */
import { MAX_MESSAGE_CHARS } from "../../../shared/attach-limits.ts";
import { markerName, splitFileBlocks } from "../../../shared/file-blocks.ts";
import { utf8Length } from "../../../shared/utf8-length.ts";
import { findReferences } from "./image-references.ts";

/** A file the host attached by path: the page knows its reference and its size, never its path or text. */
export interface LinkedSource {
	readonly kind: "linked";
	readonly ref: string;
	readonly bytes: number;
	/** The file's characters when the host read it; the send reads it again. */
	readonly chars: number;
}

/** A file whose text the page holds. */
export interface HeldSource {
	readonly kind: "held";
	readonly content: string;
	/** The path text of a document restored from a sent message, `null` for a file that never had a path. */
	readonly label: string | null;
	readonly bytes: number;
}

/** One document of the current draft. */
export interface DraftDocument {
	/** The draft-wide stable reference number of its `[File #N: …]` marker. */
	readonly number: number;
	/** The file's base name. The marker shows it through {@link markerName}. */
	readonly name: string;
	readonly source: LinkedSource | HeldSource;
}

/** The characters a document adds to a message, as far as the page knows them. */
export function documentChars(document: DraftDocument): number {
	return document.source.kind === "held" ? document.source.content.length : document.source.chars;
}

/** Whether a `[File #number: label]` marker is the marker of one of `documents`: its whole label must be the document's own. */
export function isKnownDocument(documents: readonly DraftDocument[], number: number, label: string): boolean {
	return documents.some(document => document.number === number && markerName(document.name) === label);
}

/** The documents whose marker is present in `text`, in number order: the ones a send would carry. */
export function activeDocuments(text: string, documents: readonly DraftDocument[]): DraftDocument[] {
	if (documents.length === 0) return [];
	const present = new Set(findReferences(text, (kind, number, label) => kind === "file" && isKnownDocument(documents, number, label)).map(span => span.number));
	return documents.filter(document => present.has(document.number)).sort((a, b) => a.number - b.number);
}

/**
 * Releases held documents whose marker was deleted, oldest first, until the text they keep fits `budget`. A deleted document
 * is retained only so Undo can bring its marker back; linked ones hold no text and cost nothing.
 */
export function pruneInactiveDocuments(documents: readonly DraftDocument[], isActive: (number: number) => boolean, protectedNumbers: ReadonlySet<number>, budget: number = MAX_MESSAGE_CHARS): DraftDocument[] {
	const retained = (document: DraftDocument): number => (document.source.kind === "held" && !isActive(document.number) ? document.source.content.length : 0);
	let total = 0;
	for (const document of documents) total += retained(document);
	if (total <= budget) return [...documents];
	const dropped = new Set<number>();
	for (const document of [...documents].sort((a, b) => a.number - b.number)) {
		if (total <= budget) break;
		if (isActive(document.number) || protectedNumbers.has(document.number) || document.source.kind !== "held") continue;
		dropped.add(document.number);
		total -= document.source.content.length;
	}
	return documents.filter(document => !dropped.has(document.number));
}

/** A sent message read back as a draft: its prose and one held document per block, numbered as the message numbers them. */
export interface DraftFromSentText {
	readonly text: string;
	readonly documents: readonly DraftDocument[];
}

/**
 * Turns a sent text into a draft (rewind, queue edit, ↑/↓, recall, "Add to draft"). Each file block becomes a **held**
 * document: the content that was sent, and the path text when the block had one, so a rewind brings back what the model saw.
 * A text that does not parse is returned whole with no documents. A block the host's history stripped to a reference
 * (`omitted`) has no text to hold and is skipped.
 */
export function draftFromSentText(text: string): DraftFromSentText {
	const split = splitFileBlocks(text);
	if (split.blocks.length === 0) return { text, documents: [] };
	return {
		text: split.prose,
		documents: split.blocks
			.filter(block => !block.omitted)
			.map(block => ({ number: block.number, name: block.name, source: { kind: "held" as const, content: block.content, label: block.label, bytes: utf8Length(block.content) } })),
	};
}
