/**
 * Numbered image references in the composer draft.
 *
 * The OMP TUI marks every pasted image in the prompt text itself as `[Image #N, WxH]`
 * (`[Image #N]` when the pixel size is unknown) and sends the images in the same request:
 * the Nth marker is backed by the Nth image (`packages/tui` `prompt/composer-attachments`,
 * `coding-agent` `input-controller`). This module reproduces that contract for the chat
 * composer, with exactly the TUI's marker grammar, so the agent sees the same convention it
 * sees in a terminal and a resumed native history renders the same text.
 *
 * Rules, all taken from the TUI:
 * - numbers are assigned sequentially per draft and are **stable while editing** — deleting
 *   `#2` never renumbers `#3`, and the next attachment takes the next unused number;
 * - a marker is atomic: one Backspace/Delete removes it whole, a selection never ends inside it;
 * - an image whose marker is gone from the text is not sent;
 * - on send the surviving markers are renumbered densely (1..K, in number order) because the
 *   wire mapping is positional.
 *
 * Everything here is pure; the composer owns the DOM, selection and focus.
 */

/** The TUI's `VISION_MARKER_REGEX`, restricted to images. Group 1 is the number, group 2 the `, WxH` tail. */
const IMAGE_REFERENCE_SOURCE = String.raw`\[Image #([1-9]\d*)((?:,[^\]\n]*)?)\]`;

/** A fresh global matcher; sharing one instance would share `lastIndex` between callers. */
export function imageReferencePattern(): RegExp {
	return new RegExp(IMAGE_REFERENCE_SOURCE, "g");
}

/** One image reference found in a draft. */
export interface ImageReferenceSpan {
	/** Offset of `[`. */
	readonly start: number;
	/** Offset just past `]`. */
	readonly end: number;
	readonly number: number;
}

/** The marker text for image `number`, with its pixel size when it could be read. */
export function imageReferenceLabel(number: number, size?: { width: number; height: number }): string {
	return size === undefined ? `[Image #${number}]` : `[Image #${number}, ${size.width}x${size.height}]`;
}

/**
 * Every marker in `text` whose number belongs to an image of this draft. A marker of an
 * unknown number is ordinary text: it is neither atomic nor highlighted nor sent as a reference.
 */
export function findImageReferences(text: string, isKnown: (number: number) => boolean): ImageReferenceSpan[] {
	const spans: ImageReferenceSpan[] = [];
	const pattern = imageReferencePattern();
	for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
		const number = Number(match[1]);
		if (isKnown(number)) spans.push({ start: match.index, end: match.index + match[0].length, number });
	}
	return spans;
}

/** Numbers of the images whose marker is still present in `text`. */
export function referencedNumbers(text: string, isKnown: (number: number) => boolean): Set<number> {
	return new Set(findImageReferences(text, isKnown).map(span => span.number));
}

/**
 * Moves selection edges that fall strictly inside a marker to the marker's edge.
 *
 * A collapsed caret hops to the edge in its direction of travel (`forward` is `null` for the
 * nearest edge, as after a pointer click); a range grows to cover every marker it touches.
 */
export function snapSelection(
	spans: readonly ImageReferenceSpan[],
	start: number,
	end: number,
	forward: boolean | null,
): { start: number; end: number } {
	if (start === end) {
		const inside = spans.find(span => start > span.start && start < span.end);
		if (inside === undefined) return { start, end };
		const edge = forward === null ? (start - inside.start <= inside.end - start ? inside.start : inside.end) : forward ? inside.end : inside.start;
		return { start: edge, end: edge };
	}
	let from = start;
	let to = end;
	for (const span of spans) {
		if (from > span.start && from < span.end) from = span.start;
		if (to > span.start && to < span.end) to = span.end;
	}
	return { start: from, end: to };
}

/**
 * The range a deletion must remove given the browser's own `[start, end)`: a collapsed
 * Backspace/Delete that touches a marker removes that marker whole, and a range that cuts
 * a marker swallows it. `null` leaves the deletion to the browser.
 */
export function deletionRange(
	spans: readonly ImageReferenceSpan[],
	start: number,
	end: number,
	direction: "backward" | "forward" | "range",
): { start: number; end: number } | null {
	if (start === end) {
		const touching = spans.find(span =>
			(start > span.start && start < span.end) ||
			(direction === "backward" && start === span.end) ||
			(direction === "forward" && start === span.start));
		return touching === undefined ? null : { start: touching.start, end: touching.end };
	}
	const snapped = snapSelection(spans, start, end, null);
	return snapped.start === start && snapped.end === end ? null : snapped;
}

/**
 * Repairs an edit that already happened and damaged a marker — a word-wise delete, a drop or
 * any path the `beforeinput` handling did not intercept. Returns the draft with every marker
 * the edit touched removed whole, plus the caret after the edit, or `null` when no marker was hurt.
 */
export function repairDamagedReferences(
	previous: string,
	next: string,
	previousSpans: readonly ImageReferenceSpan[],
): { text: string; caret: number } | null {
	if (previous === next || previousSpans.length === 0) return null;
	const limit = Math.min(previous.length, next.length);
	let prefix = 0;
	while (prefix < limit && previous.charCodeAt(prefix) === next.charCodeAt(prefix)) prefix++;
	let suffix = 0;
	while (suffix < limit - prefix && previous.charCodeAt(previous.length - 1 - suffix) === next.charCodeAt(next.length - 1 - suffix)) suffix++;
	let from = prefix;
	let to = previous.length - suffix;
	const inserted = next.slice(prefix, next.length - suffix);
	// Whether a marker overlaps the replaced range, counting an insertion strictly inside one.
	const hurt = previousSpans.filter(span => (from === to ? from > span.start && from < span.end : from < span.end && to > span.start));
	if (hurt.length === 0) return null;
	// A marker the edit removed *exactly* is a deliberate removal, not damage.
	if (hurt.length === 1 && from === hurt[0]!.start && to === hurt[0]!.end) return null;
	for (const span of hurt) {
		from = Math.min(from, span.start);
		to = Math.max(to, span.end);
	}
	return { text: previous.slice(0, from) + inserted + previous.slice(to), caret: from + inserted.length };
}

/** One image of a draft that can carry a marker. */
export interface NumberedImage {
	/** The draft-wide stable reference number. */
	readonly number: number;
	/** Raw bytes, for the draft budget. */
	readonly bytes: number;
}

/** The images whose marker is present, in number order — the ones a send would carry. */
export function activeImages<T extends NumberedImage>(text: string, images: readonly T[]): T[] {
	const known = new Set(images.map(image => image.number));
	const present = referencedNumbers(text, number => known.has(number));
	return images.filter(image => present.has(image.number)).sort((a, b) => a.number - b.number);
}

/**
 * The text and image order a send puts on the wire: unreferenced images are dropped and the
 * surviving markers are renumbered densely (1..K by original number), exactly as the TUI does
 * before submitting, because the wire pairs the Nth marker with the Nth image.
 */
export function compactForSend<T extends NumberedImage>(text: string, images: readonly T[]): { text: string; images: T[] } {
	const kept = activeImages(text, images);
	const dense = new Map(kept.map((image, index) => [image.number, index + 1]));
	const pattern = imageReferencePattern();
	return {
		text: text.replace(pattern, (match, number: string, tail: string) => {
			const mapped = dense.get(Number(number));
			return mapped === undefined ? match : `[Image #${mapped}${tail}]`;
		}),
		images: kept,
	};
}

/**
 * Releases images whose marker was deleted, oldest first, until the retained bytes fit
 * `budget`. A deleted image is kept only so Undo can bring its marker (and so it) back;
 * it must never make the draft hold more than a prompt may carry.
 */
export function pruneInactive<T extends NumberedImage>(images: readonly T[], isActive: (number: number) => boolean, protectedNumbers: ReadonlySet<number>, budget: number): T[] {
	let total = 0;
	for (const image of images) total += image.bytes;
	if (total <= budget) return [...images];
	const dropped = new Set<number>();
	for (const image of [...images].sort((a, b) => a.number - b.number)) {
		if (total <= budget) break;
		if (isActive(image.number) || protectedNumbers.has(image.number)) continue;
		dropped.add(image.number);
		total -= image.bytes;
	}
	return images.filter(image => !dropped.has(image.number));
}

/** A piece of draft text for the highlight layer: plain text or a marker. */
export type DraftSegment = { readonly marker: false; readonly text: string } | { readonly marker: true; readonly text: string; readonly number: number };

/** Splits `text` at the markers of `spans` so the composer can paint them. */
export function draftSegments(text: string, spans: readonly ImageReferenceSpan[]): DraftSegment[] {
	const segments: DraftSegment[] = [];
	let cursor = 0;
	for (const span of spans) {
		if (span.start > cursor) segments.push({ marker: false, text: text.slice(cursor, span.start) });
		segments.push({ marker: true, text: text.slice(span.start, span.end), number: span.number });
		cursor = span.end;
	}
	if (cursor < text.length) segments.push({ marker: false, text: text.slice(cursor) });
	return segments;
}
