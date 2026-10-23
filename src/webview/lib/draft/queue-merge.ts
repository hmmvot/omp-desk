/**
 * Queued messages taken back out of OMP's queue to be edited: the pure merge into the composer draft (the registry that hands them
 * from the queue row to the mounted composer is `lib/queue-handover.ts`).
 *
 * The native TUI does the same on Alt+Up (`input-controller.ts` `#restoreEntriesToEditor`): the dequeued
 * messages' text goes into the editor and their images back into the pending-image buffer, with every
 * `[Image #N]` marker renumbered so it still points at its own image next to the draft's. This module is that
 * contract for the chat composer, with one deliberate difference: the dequeued text is **appended** after
 * an existing draft (the TUI prepends it), so what the user was typing stays where they left it.
 *
 * Everything here is pure; the Draft's `restoreQueued` is the operation that applies it.
 */
import { fileMarker, markerName } from "../../../shared/file-blocks.ts";
import { draftFromSentText, type DraftDocument } from "./draft-documents.ts";
import { fileReferencePattern, imageReferenceLabel, imageReferencePattern } from "./image-references.ts";
import type { DraftImage } from "./value.ts";

/** One image of a dequeued message, as OMP's queue returned it. */
export interface RestoredImage {
	mimeType: string;
	data: string;
}

/** A file a restored message names by reference rather than by content: the host re-validated its path (the history search's other conversations). */
export interface RestoredLinked {
	number: number;
	name: string;
	ref: string;
	bytes: number;
	chars: number;
}

/**
 * One dequeued message: its exact text (with its own `[Image #N]` markers and, for a message that carried files, its
 * `<file>` blocks, which become held documents) and its images in marker order. `documents` are files named by reference and
 * `notes` are sentences about what could not come back (a file whose text was not remembered).
 */
export interface RestoredQueued {
	text: string;
	images: readonly RestoredImage[];
	documents?: readonly RestoredLinked[];
	notes?: readonly string[];
	/** The message a Stop took back out of the conversation (ADR-0082), not one withdrawn from a queue. */
	withdrawn?: true;
}

/** What the merge needs to know about the draft. */
export interface DraftState {
	text: string;
	images: readonly DraftImage[];
	documents: readonly DraftDocument[];
	/** Next unused reference number. */
	nextNumber: number;
	/** Next unused document number. */
	nextDocumentNumber: number;
	/** Next unused attachment key. */
	nextId: number;
}

export interface MergedDraft {
	text: string;
	images: DraftImage[];
	documents: DraftDocument[];
	nextNumber: number;
	nextDocumentNumber: number;
	nextId: number;
	/** Images that could not be attached (a format the composer does not carry); their text stays. */
	imagesLost: number;
	/** Sentences about what a restored message could not bring back. */
	notes: string[];
}

const SUPPORTED: Record<string, true> = { "image/png": true, "image/jpeg": true, "image/gif": true, "image/webp": true };

/** Raw byte size of standard base64. */
function decodedBytes(data: string): number {
	const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
	return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

/** The `WxH` of the first marker numbered `number` in `text`, when it carries one. */
function markerSize(text: string, number: number): { width: number; height: number } | undefined {
	const pattern = imageReferencePattern();
	for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
		if (Number(match[1]) !== number) continue;
		const size = /^,\s*(\d+)x(\d+)\s*$/.exec(match[2] ?? "");
		if (size !== null) return { width: Number(size[1]), height: Number(size[2]) };
	}
	return undefined;
}

/**
 * `entries` (oldest first) appended to `draft`. Each entry's file blocks are read first (`draftFromSentText`): the prose goes on
 * and each block becomes a held document, so an `[Image #N]` inside a file's text is never renumbered. Each entry's image
 * markers are renumbered onto fresh numbers of this draft (the Nth image of an entry answers its `[Image #N]`), an image the
 * text never mentions gets a marker at the end of its message, and a marker with no image behind it stays ordinary text —
 * never renumbered onto a number that is now somebody's image. A document is renumbered the same way, in its own number space.
 */
export function mergeRestoredQueued(draft: DraftState, entries: readonly RestoredQueued[]): MergedDraft {
	let nextNumber = draft.nextNumber;
	let nextDocumentNumber = draft.nextDocumentNumber;
	let nextId = draft.nextId;
	let imagesLost = 0;
	const added: DraftImage[] = [];
	const addedDocuments: DraftDocument[] = [];
	const notes: string[] = [];
	const orphanNumbers = new Set<number>();
	const orphanDocumentNumbers = new Set<number>();
	// A marker already in the draft that no attachment of the draft backs is ordinary text; a new one must not take its number.
	const known = new Set(draft.images.map(image => image.number));
	const draftPattern = imageReferencePattern();
	for (let match = draftPattern.exec(draft.text); match !== null; match = draftPattern.exec(draft.text)) {
		if (!known.has(Number(match[1]))) orphanNumbers.add(Number(match[1]));
	}
	const knownDocuments = new Set(draft.documents.map(document => document.number));
	const draftFilePattern = fileReferencePattern();
	for (let match = draftFilePattern.exec(draft.text); match !== null; match = draftFilePattern.exec(draft.text)) {
		if (!knownDocuments.has(Number(match[1]))) orphanDocumentNumbers.add(Number(match[1]));
	}
	const parsed = entries.map(entry => {
		const split = draftFromSentText(entry.text);
		const linked: DraftDocument[] = (entry.documents ?? []).map(link => ({ number: link.number, name: link.name, source: { kind: "linked", ref: link.ref, bytes: link.bytes, chars: link.chars } }));
		return { entry, prose: split.text, documents: [...split.documents, ...linked] };
	});
	for (const { entry, prose, documents } of parsed) {
		const pattern = imageReferencePattern();
		for (let match = pattern.exec(prose); match !== null; match = pattern.exec(prose)) {
			const number = Number(match[1]);
			if (number > entry.images.length || SUPPORTED[entry.images[number - 1]?.mimeType ?? ""] !== true) orphanNumbers.add(number);
		}
		const own = new Set(documents.map(document => document.number));
		const filePattern = fileReferencePattern();
		for (let match = filePattern.exec(prose); match !== null; match = filePattern.exec(prose)) {
			if (!own.has(Number(match[1]))) orphanDocumentNumbers.add(Number(match[1]));
		}
	}
	const fresh = (): number => {
		while (orphanNumbers.has(nextNumber)) nextNumber += 1;
		return nextNumber++;
	};
	const freshDocument = (): number => {
		while (orphanDocumentNumbers.has(nextDocumentNumber)) nextDocumentNumber += 1;
		return nextDocumentNumber++;
	};
	const texts: string[] = [];
	for (const { entry, prose, documents } of parsed) {
		const mapped = new Map<number, DraftImage>();
		entry.images.forEach((image, index) => {
			if (SUPPORTED[image.mimeType] !== true) {
				imagesLost += 1;
				return;
			}
			const size = markerSize(prose, index + 1);
			const attached: DraftImage = {
				id: nextId++,
				name: `queued-image-${added.length + 1}`,
				mimeType: image.mimeType as DraftImage["mimeType"],
				bytes: decodedBytes(image.data),
				data: image.data,
				...(size === undefined ? {} : size),
				number: fresh(),
			};
			mapped.set(index + 1, attached);
			added.push(attached);
		});
		const placed = new Map<number, DraftDocument>();
		for (const document of documents) {
			const renumbered: DraftDocument = { ...document, number: freshDocument() };
			placed.set(document.number, renumbered);
			addedDocuments.push(renumbered);
		}
		const present = new Set<number>();
		const presentDocuments = new Set<number>();
		let text = prose
			.replace(imageReferencePattern(), (marker, number: string, tail: string) => {
				const image = mapped.get(Number(number));
				if (image === undefined) return marker;
				present.add(image.number);
				return `[Image #${image.number}${tail}]`;
			})
			.replace(fileReferencePattern(), (marker, number: string, label: string) => {
				const document = placed.get(Number(number));
				if (document === undefined || markerName(document.name) !== label) return marker;
				presentDocuments.add(document.number);
				return fileMarker(document.number, document.name);
			});
		const missing = [
			...[...mapped.values()].filter(image => !present.has(image.number)).map(image => imageReferenceLabel(image.number, image.width !== undefined && image.height !== undefined ? { width: image.width, height: image.height } : undefined)),
			...[...placed.values()].filter(document => !presentDocuments.has(document.number)).map(document => fileMarker(document.number, document.name)),
		];
		if (missing.length > 0) {
			const markers = missing.join(" ");
			text = text.length === 0 || /\s$/.test(text) ? `${text}${markers}` : `${text} ${markers}`;
		}
		if (text.length > 0) texts.push(text);
		notes.push(...(entry.notes ?? []));
	}
	const queued = texts.join("\n\n");
	const text = draft.text.trim().length === 0 ? queued : queued.length === 0 ? draft.text : `${draft.text}\n\n${queued}`;
	return { text, images: [...draft.images, ...added], documents: [...draft.documents, ...addedDocuments], nextNumber, nextDocumentNumber, nextId, imagesLost, notes };
}
