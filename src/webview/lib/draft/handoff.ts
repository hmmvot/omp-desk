/**
 * The draft as the hand-off carries it between documents (ADR-0050): the text, the number of images (their bytes are counted, never
 * carried), the documents (held ones with their text, linked ones by reference) and every recovery card plus the message awaiting
 * admission, which is carried as unconfirmed.
 */
import type { DraftHandoffContent } from "../../../protocol/messages.ts";
import { activeDocuments } from "./draft-documents.ts";
import { activeImages } from "./image-references.ts";
import type { Draft } from "./value.ts";

export function captureOf(draft: Draft): DraftHandoffContent {
	const recoverable = draft.recoverable.map(entry => ({ text: entry.text, attachments: entry.images.length + (entry.lostAttachments ?? 0), unconfirmed: entry.unconfirmed }));
	const pending = draft.inFlight;
	if (pending !== null) recoverable.push({ text: pending.text, attachments: pending.images.length, unconfirmed: true });
	const documents = activeDocuments(draft.text, draft.documents).map(document => document.source.kind === "held"
		? { number: document.number, name: document.name, ref: null, label: document.source.label, content: document.source.content, bytes: document.source.bytes, chars: document.source.content.length }
		: { number: document.number, name: document.name, ref: document.source.ref, label: null, content: null, bytes: document.source.bytes, chars: document.source.chars });
	return { text: draft.text, attachments: activeImages(draft.text, draft.images).length + draft.lostImages, recoverable, documents };
}
