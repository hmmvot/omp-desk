/**
 * The draft as the hand-off carries it between documents (ADR-0050): the text, the number of images (their bytes are counted, never
 * carried), the documents (held ones with their text, linked ones by reference) and every recovery card plus the message awaiting
 * admission, which is carried as unconfirmed. The restore into the document that replaces this one is the inverse.
 */
import type { DraftHandoffContent } from "../../../protocol/messages.ts";
import { activeDocuments, type DraftDocument } from "./draft-documents.ts";
import type { Change } from "./field.ts";
import { activeImages, findReferences } from "./image-references.ts";
import type { Draft, Recoverable } from "./value.ts";

export function captureOf(draft: Draft): DraftHandoffContent {
	const recoverable = draft.recoverable.map(entry => ({ text: entry.text, attachments: entry.images.length + (entry.lostAttachments ?? 0), unconfirmed: entry.unconfirmed }));
	const pending = draft.inFlight;
	if (pending !== null) recoverable.push({ text: pending.text, attachments: pending.images.length, unconfirmed: true });
	const documents = activeDocuments(draft.text, draft.documents).map(document => document.source.kind === "held"
		? { number: document.number, name: document.name, ref: null, label: document.source.label, content: document.source.content, bytes: document.source.bytes, chars: document.source.content.length }
		: { number: document.number, name: document.name, ref: document.source.ref, label: null, content: null, bytes: document.source.bytes, chars: document.source.chars });
	return { text: draft.text, attachments: activeImages(draft.text, draft.images).length + draft.lostImages, recoverable, documents };
}

const UNCONFIRMED_CARD = "OMP did not confirm this message before this editor was replaced. It may already have been accepted. Review the conversation before sending it again.";
const REFUSED_CARD = "This original message was not sent. Add it to the draft only when you want to send it.";

/**
 * A draft handed back to a document that has just been created (`capture`, read from the host): the text replaces the draft (the undo
 * stack starts over), the held files and linked ones come back, the images that could not be carried are counted so the warning can say
 * so, and every recovery card is rebuilt. Markers of the restored texts keep their numbers, so new attachments never reuse one.
 */
export function restoreHandoff(draft: Draft, capture: DraftHandoffContent): Change {
	let imageNumber = draft.next.image;
	let documentNumber = draft.next.document;
	const bump = (text: string): void => {
		for (const span of findReferences(text, () => true)) {
			if (span.kind === "image") imageNumber = Math.max(imageNumber, span.number + 1);
			else documentNumber = Math.max(documentNumber, span.number + 1);
		}
	};
	bump(capture.text);
	for (const original of capture.recoverable) bump(original.text);
	for (const file of capture.documents) documentNumber = Math.max(documentNumber, file.number + 1);
	const cards = capture.recoverable.map((entry, index): Recoverable => ({
		id: draft.next.card + index,
		text: entry.text,
		images: [],
		unconfirmed: entry.unconfirmed,
		lostAttachments: entry.attachments,
		reason: entry.unconfirmed ? UNCONFIRMED_CARD : REFUSED_CARD,
	}));
	return {
		draft: {
			...draft,
			text: capture.text,
			lostImages: capture.attachments,
			documents: capture.documents.map((file): DraftDocument => ({
				number: file.number,
				name: file.name,
				source: file.ref !== null ? { kind: "linked", ref: file.ref, bytes: file.bytes, chars: file.chars } : { kind: "held", content: file.content ?? "", label: file.label, bytes: file.bytes },
			})),
			recoverable: cards,
			next: { ...draft.next, image: imageNumber, document: documentNumber, card: draft.next.card + cards.length },
		},
		writes: [{ kind: "text", text: capture.text, caret: capture.text.length, history: "reset", focus: true }],
	};
}

/** The warning that images could not be carried to this document is dismissed. */
export function dismissLost(draft: Draft): Change {
	return { draft: { ...draft, lostImages: 0 }, writes: [] };
}

/** A message kept as a card beside the draft: a refused or uncertain send. */
export function addRecoverable(draft: Draft, entry: Omit<Recoverable, "id">): Change {
	return { draft: { ...draft, recoverable: [...draft.recoverable, { ...entry, id: draft.next.card }], next: { ...draft.next, card: draft.next.card + 1 } }, writes: [] };
}

export function dismissRecoverable(draft: Draft, id: number): Change {
	return { draft: { ...draft, recoverable: draft.recoverable.filter(item => item.id !== id) }, writes: [] };
}
