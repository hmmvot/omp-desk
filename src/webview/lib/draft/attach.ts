/**
 * Attaching to the draft and removing an attachment (docs/designs/2026-10-23-composer-draft-module.md, section 4, group 1).
 *
 * An attachment exists exactly while its marker is in the text: attaching numbers the attachment, publishes it with the draft and
 * inserts its marker at the caret, and removing one deletes its marker. A refusal is a sentence, never a silence; a rejected file
 * changes nothing. Reads are asynchronous, so what they hold (the count in flight and the bytes and characters reserved) lives in the
 * value, and every step reads the cell afresh: two overlapping attaches budget against one running total, and a published draft never
 * overshoots the budget by what is still being read.
 */
import { fileMarker } from "../../../shared/file-blocks.ts";
import type { GuestAttachedDocument } from "../../../protocol/messages.ts";
import { MAX_DRAFT_BYTES, attachGuardRefusal, rawTotal, sizeRejection, type ImageRead, type PendingImage } from "./attachments.ts";
import { draftRoomRefusal, type DocumentRead, type FileClass } from "./attached-documents.ts";
import type { DraftCell } from "./cell.ts";
import { activeDocuments, documentChars, isKnownDocument, pruneInactiveDocuments, type DraftDocument } from "./draft-documents.ts";
import type { Change, Op, Timing } from "./field.ts";
import { activeImages, findReferences, imageReferenceLabel, pruneInactive, referencedNumbers, type ReferenceKind } from "./image-references.ts";
import { knowsReference, withState, type Draft, type DraftImage } from "./value.ts";

/** One thing to attach: a `File` the page was handed (the reader reads it), or a document the host attached by path (never read here). */
export type AttachEntry =
	| { readonly kind: "file"; readonly file: File }
	| { readonly kind: "linked"; readonly item: GuestAttachedDocument };

/** The third seam: how a `File` is told apart and read. The real one is `lib/attach-reader.ts`; a test has a fake with timing and failures of its own. */
export interface AttachReader {
	/** What the file is, decided by its first bytes before its size is judged. */
	classify(file: File): Promise<FileClass>;
	/** Reads an image under the stable `key` of its draft. */
	readImage(file: File, key: number): Promise<ImageRead>;
	readDocument(file: File): Promise<DocumentRead>;
}

export interface AttachEvents {
	/** The attach began reading; the composer clears its send notice. */
	started(): void;
}

/** What an attach says: the alert row's new text (`null` clears it), or nothing to leave the alert alone. */
export interface AttachResult {
	readonly alert?: string | null;
}

/** What one attach call accepted, in order, so the markers go into the draft in that order. */
type Accepted =
	| { readonly kind: "image"; readonly image: PendingImage }
	| { readonly kind: "document"; readonly name: string; readonly source: DraftDocument["source"] };

/** The markers wait for a composition window to close and are dropped while the hand-off holds the draft. */
const MARKER_TIMING: Timing = { composing: "wait", held: "drop" };

/** One line for the alert region: the first failures plus a count of the rest. */
function rejectionSummary(rejected: readonly string[]): string | null {
	if (rejected.length === 0) return null;
	const shown = rejected.slice(0, 2).join(" ");
	return rejected.length <= 2 ? shown : `${shown} (+${rejected.length - 2} more)`;
}

/** A value-only change, computed from the cell now. Bookkeeping: it never raises the revision. */
function adjust(cell: DraftCell, patch: (draft: Draft) => Partial<Omit<Draft, "revision">>): boolean {
	const draft = cell.read();
	return cell.commit({ draft: withState(draft, patch(draft)), writes: [] });
}

/**
 * Insert `markers` at the caret (or over the selection), one space apart and with a space on each side unless whitespace is already
 * there, so typing can continue straight after the last marker. One edit of the field without a selection, so it still widens over a
 * marker it cuts into; with no field the markers are appended.
 */
function insertMarkers(markers: readonly string[]): Op<void> {
	return (draft, at) => {
		const current = draft.text;
		const start = Math.min(at.selection.anchor, at.selection.focus);
		const end = Math.max(at.selection.anchor, at.selection.focus);
		const lead = start > 0 && !/\s/.test(current[start - 1]!) ? " " : "";
		const trail = end < current.length && /\s/.test(current[end]!) ? "" : " ";
		const inserted = `${lead}${markers.join(" ")}${trail}`;
		const text = current.slice(0, start) + inserted + current.slice(end);
		return { change: { draft: withState(draft, { text }), writes: [{ kind: "edit", edit: { from: start, to: end, insert: inserted }, as: "replace", focus: true }] }, result: undefined };
	};
}

/**
 * Validate, read and add `entries`; `earlier` are refusals that came before them (the host's, for a drop or a pick). Every rejection is
 * reported, never dropped. A `File` is classified by its first bytes before its size is judged; an image is budgeted and read as an image,
 * a text becomes a held document, and a document the host linked is added by reference. The caller keeps two preconditions: the draft is
 * not held and the session is writable.
 */
export async function attach(cell: DraftCell, entries: readonly AttachEntry[], reader: AttachReader, earlier: readonly string[], events: AttachEvents): Promise<AttachResult> {
	if (entries.length === 0 && earlier.length === 0) return {};
	const start = cell.read();
	const overGuard = attachGuardRefusal(activeImages(start.text, start.images).length + activeDocuments(start.text, start.documents).length, entries.length);
	if (overGuard !== null) return { alert: overGuard };
	adjust(cell, draft => ({ reading: draft.reading + entries.length }));
	events.started();
	const accepted: Accepted[] = [];
	const rejected: string[] = [...earlier];
	// This call's share of the reservations, so the release in `finally` stays balanced even if a read throws instead of reporting
	// failure. A leaked reservation would shrink the draft budget with nothing to show for it.
	let heldBytes = 0;
	let heldChars = 0;
	/** The characters the draft would hold: its text, every document of it and the reads still in flight. */
	const knownChars = (): number => {
		const draft = cell.read();
		return activeDocuments(draft.text, draft.documents).reduce((sum, document) => sum + documentChars(document), draft.text.length + draft.reserved.chars);
	};
	const addDocument = (name: string, chars: number, source: DraftDocument["source"]): void => {
		const room = draftRoomRefusal(name, chars, knownChars());
		if (room !== null) {
			rejected.push(room);
			return;
		}
		adjust(cell, draft => ({ reserved: { ...draft.reserved, chars: draft.reserved.chars + chars } }));
		heldChars += chars;
		accepted.push({ kind: "document", name, source });
	};
	try {
		for (const entry of entries) {
			if (entry.kind === "linked") {
				const { item } = entry;
				const linkedTwice = (candidate: DraftDocument["source"]): boolean => candidate.kind === "linked" && candidate.ref === item.ref;
				const draft = cell.read();
				if (activeDocuments(draft.text, draft.documents).some(document => linkedTwice(document.source)) || accepted.some(done => done.kind === "document" && linkedTwice(done.source))) {
					rejected.push(`${item.name} is already attached.`);
					continue;
				}
				addDocument(item.name, item.chars, { kind: "linked", ref: item.ref, bytes: item.bytes, chars: item.chars });
				continue;
			}
			const { file } = entry;
			const sort = await reader.classify(file);
			if (sort.kind === "refused") {
				rejected.push(sort.reason);
				continue;
			}
			if (sort.kind === "image") {
				// Reserve before reading: the check and the reservation happen in one synchronous step, so a concurrent selection sees
				// these bytes. Only images still referenced by the text count: a removed one is released first.
				const draft = cell.read();
				const oversize = sizeRejection(file, rawTotal(activeImages(draft.text, draft.images)) + draft.reserved.bytes);
				if (oversize !== null) {
					rejected.push(oversize);
					continue;
				}
				adjust(cell, current => ({ reserved: { ...current.reserved, bytes: current.reserved.bytes + file.size } }));
				heldBytes += file.size;
				const key = cell.read().next.key;
				adjust(cell, current => ({ next: { ...current.next, key: current.next.key + 1 } }));
				const read = await reader.readImage(file, key).catch(() => null);
				if (read !== null && read.ok) {
					accepted.push({ kind: "image", image: read.image });
				} else {
					// A failed read releases exactly what it reserved.
					adjust(cell, current => ({ reserved: { ...current.reserved, bytes: current.reserved.bytes - file.size } }));
					heldBytes -= file.size;
					rejected.push(read === null ? `${file.name}: could not be read.` : read.reason);
				}
				continue;
			}
			const text = await reader.readDocument(file).catch(() => null);
			if (text === null || !text.ok) {
				rejected.push(text === null ? `${file.name}: could not be read.` : text.reason);
				continue;
			}
			addDocument(file.name, text.content.length, { kind: "held", content: text.content, label: null, bytes: text.bytes });
		}
	} finally {
		// What `accepted` reserved stops being reserved here and is published below with no await in between, so the invariant
		// "published + reserved fits" never has a gap.
		adjust(cell, draft => ({
			reading: Math.max(0, draft.reading - entries.length),
			reserved: { bytes: Math.max(0, draft.reserved.bytes - heldBytes), chars: Math.max(0, draft.reserved.chars - heldChars) },
		}));
	}
	if (!cell.alive()) return {};
	const current = cell.read();
	const addedImages: DraftImage[] = [];
	const addedDocuments: DraftDocument[] = [];
	const markers: string[] = [];
	let imageNumber = current.next.image;
	let documentNumber = current.next.document;
	for (const done of accepted) {
		if (done.kind === "image") {
			const image: DraftImage = { ...done.image, number: imageNumber++ };
			addedImages.push(image);
			markers.push(imageReferenceLabel(image.number, image.width !== undefined && image.height !== undefined ? { width: image.width, height: image.height } : undefined));
		} else {
			const document: DraftDocument = { number: documentNumber++, name: done.name, source: done.source };
			addedDocuments.push(document);
			markers.push(fileMarker(document.number, document.name));
		}
	}
	let published = true;
	if (addedImages.length > 0 || addedDocuments.length > 0) {
		let images = current.images;
		let documents = current.documents;
		if (addedImages.length > 0) {
			const merged = [...current.images, ...addedImages];
			const present = referencedNumbers(current.text, "image", (kind, number) => kind === "image" && merged.some(image => image.number === number));
			// Deleted images stay only for Undo and never push the draft past the prompt budget.
			images = pruneInactive(merged, number => present.has(number), new Set(addedImages.map(image => image.number)), MAX_DRAFT_BYTES);
		}
		if (addedDocuments.length > 0) {
			const merged = [...current.documents, ...addedDocuments];
			const present = referencedNumbers(current.text, "file", (kind, number, name) => kind === "file" && isKnownDocument(merged, number, name));
			// Deleted documents stay only for Undo, and what they hold is bounded like an image's bytes.
			documents = pruneInactiveDocuments(merged, number => present.has(number), new Set(addedDocuments.map(document => document.number)));
		}
		published = cell.commit({ draft: withState(current, { images, documents, next: { ...current.next, image: imageNumber, document: documentNumber } }), writes: [] });
	}
	if (published && markers.length > 0) cell.perform(insertMarkers(markers), MARKER_TIMING);
	return accepted.length > 0 || rejected.length > 0 ? { alert: rejectionSummary(rejected) } : {};
}

/**
 * The × on a thumbnail or a tile: one `remove` write that deletes the marker(s) of that attachment from the text as one undo step; the
 * attachment follows its marker and stays in the lists until the budget forces its release. Nothing without a field to remove from.
 * Perform it with `{ composing: "wait", held: "drop" }`.
 */
export function removeAttachment(kind: ReferenceKind, number: number): Op<void> {
	return (draft, at) => {
		if (!at.mounted) return null;
		const spans = findReferences(draft.text, (found, foundNumber, name) => knowsReference(draft, found, foundNumber, name)).filter(span => span.kind === kind && span.number === number);
		let text = draft.text;
		for (const span of [...spans].sort((a, b) => b.start - a.start)) text = text.slice(0, span.start) + text.slice(span.end);
		return { change: { draft: withState(draft, { text }), writes: [{ kind: "remove", ranges: spans.map(span => ({ from: span.start, to: span.end })), focus: true }] }, result: undefined };
	};
}

/** A host-read drop or pick starts (`+1`) or ends (`-1`): it counts as a read in flight, so a hand-off cannot capture a draft its answer is about to change. */
export function readingBy(draft: Draft, delta: number): Change {
	return { draft: withState(draft, { reading: Math.max(0, draft.reading + delta) }), writes: [] };
}
