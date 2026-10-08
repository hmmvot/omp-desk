/**
 * Queued messages taken back out of OMP's queue to be edited: the pure merge into the composer draft, and
 * the small registry that hands them from the queue row to the mounted composer.
 *
 * The native TUI does the same on Alt+Up (`input-controller.ts` `#restoreEntriesToEditor`): the dequeued
 * messages' text goes into the editor and their images back into the pending-image buffer, with every
 * `[Image #N]` marker renumbered so it still points at its own image next to the draft's. This module is that
 * contract for the chat composer, with one deliberate difference: the dequeued text is **appended** after
 * an existing draft (the TUI prepends it), so what the user was typing stays where they left it.
 *
 * Everything here is pure except the registry; the composer owns the DOM, selection and focus.
 */
import type { PendingImage } from "./attachments.ts";
import { imageReferenceLabel, imageReferencePattern } from "./image-references.ts";

/** One image of a dequeued message, as OMP's queue returned it. */
export interface RestoredImage {
	mimeType: string;
	data: string;
}

/** One dequeued message: its exact text (with its own `[Image #N]` markers) and its images in marker order. */
export interface RestoredQueued {
	text: string;
	images: readonly RestoredImage[];
}

/** An image of the composer's draft: the attachment plus its stable reference number. */
export type NumberedImage = PendingImage & { number: number };

/** What the merge needs to know about the draft. */
export interface DraftState {
	text: string;
	images: readonly NumberedImage[];
	/** Next unused reference number. */
	nextNumber: number;
	/** Next unused attachment key. */
	nextId: number;
}

export interface MergedDraft {
	text: string;
	images: NumberedImage[];
	nextNumber: number;
	nextId: number;
	/** Images that could not be attached (a format the composer does not carry); their text stays. */
	imagesLost: number;
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
 * `entries` (oldest first) appended to `draft`. Each entry's image markers are renumbered onto fresh numbers
 * of this draft (the Nth image of an entry answers its `[Image #N]`), an image the text never mentions gets a
 * marker at the end of its message, and a marker with no image behind it stays ordinary text — never renumbered
 * onto a number that is now somebody's image.
 */
export function mergeRestoredQueued(draft: DraftState, entries: readonly RestoredQueued[]): MergedDraft {
	let nextNumber = draft.nextNumber;
	let nextId = draft.nextId;
	let imagesLost = 0;
	const added: NumberedImage[] = [];
	const orphanNumbers = new Set<number>();
	// A marker already in the draft that no image of the draft backs is ordinary text; a new image must not take its number.
	const known = new Set(draft.images.map(image => image.number));
	const draftPattern = imageReferencePattern();
	for (let match = draftPattern.exec(draft.text); match !== null; match = draftPattern.exec(draft.text)) {
		if (!known.has(Number(match[1]))) orphanNumbers.add(Number(match[1]));
	}
	for (const entry of entries) {
		const pattern = imageReferencePattern();
		for (let match = pattern.exec(entry.text); match !== null; match = pattern.exec(entry.text)) {
			const number = Number(match[1]);
			if (number > entry.images.length || SUPPORTED[entry.images[number - 1]?.mimeType ?? ""] !== true) orphanNumbers.add(number);
		}
	}
	const fresh = (): number => {
		while (orphanNumbers.has(nextNumber)) nextNumber += 1;
		return nextNumber++;
	};
	const texts: string[] = [];
	for (const entry of entries) {
		const mapped = new Map<number, NumberedImage>();
		entry.images.forEach((image, index) => {
			if (SUPPORTED[image.mimeType] !== true) {
				imagesLost += 1;
				return;
			}
			const size = markerSize(entry.text, index + 1);
			const attached: NumberedImage = {
				id: nextId++,
				name: `queued-image-${added.length + 1}`,
				mimeType: image.mimeType as NumberedImage["mimeType"],
				bytes: decodedBytes(image.data),
				data: image.data,
				...(size === undefined ? {} : size),
				number: fresh(),
			};
			mapped.set(index + 1, attached);
			added.push(attached);
		});
		const present = new Set<number>();
		let text = entry.text.replace(imageReferencePattern(), (marker, number: string, tail: string) => {
			const image = mapped.get(Number(number));
			if (image === undefined) return marker;
			present.add(image.number);
			return `[Image #${image.number}${tail}]`;
		});
		const missing = [...mapped.values()].filter(image => !present.has(image.number));
		if (missing.length > 0) {
			const markers = missing.map(image => imageReferenceLabel(image.number, image.width !== undefined && image.height !== undefined ? { width: image.width, height: image.height } : undefined)).join(" ");
			text = text.length === 0 || /\s$/.test(text) ? `${text}${markers}` : `${text} ${markers}`;
		}
		if (text.length > 0) texts.push(text);
	}
	const queued = texts.join("\n\n");
	const text = draft.text.trim().length === 0 ? queued : queued.length === 0 ? draft.text : `${draft.text}\n\n${queued}`;
	return { text, images: [...draft.images, ...added], nextNumber, nextId, imagesLost };
}

/** How many hand-overs may wait for a composer; older ones are dropped first. */
const MAX_PENDING = 8;

type RestoreListener = (entries: readonly RestoredQueued[]) => void;

const listeners: RestoreListener[] = [];
const pending: (readonly RestoredQueued[])[] = [];

/** Deliver dequeued messages to the newest mounted composer, or hold them for the next one. */
export function offerQueuedForEditing(entries: readonly RestoredQueued[]): void {
	if (entries.length === 0) return;
	const listener = listeners[listeners.length - 1];
	if (listener !== undefined) {
		listener(entries);
		return;
	}
	pending.push(entries);
	while (pending.length > MAX_PENDING) pending.shift();
}

/**
 * Register a composer's handler. Anything held while no composer existed is delivered to it first, in order;
 * the returned function releases the handler.
 */
export function subscribeQueuedForEditing(listener: RestoreListener): () => void {
	listeners.push(listener);
	for (const entries of pending.splice(0)) listener(entries);
	return () => {
		const position = listeners.indexOf(listener);
		if (position >= 0) listeners.splice(position, 1);
	};
}
