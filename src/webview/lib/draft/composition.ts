/**
 * The draft as one message: its images in marker order with the markers renumbered densely, its prose, and the files whose marker is in
 * the text (docs/designs/2026-10-23-composer-draft-module.md, section 5). Every place that needs "what this draft would send" builds it
 * here: the send, the Rewind hold of the previous draft and the "Add to draft" comparison.
 */
import type { ImageContent } from "@oh-my-pi/pi-wire";
import { composeFileBlocks } from "../../../shared/file-blocks.ts";
import { activeDocuments, type DraftDocument } from "./draft-documents.ts";
import { compactForSend } from "./image-references.ts";
import type { Draft, DraftImage } from "./value.ts";

export interface Composed {
	/** The text with the image markers compacted to 1..K and trimmed, files not yet added. */
	readonly prose: string;
	/** The images a send carries, in marker order. */
	readonly images: readonly DraftImage[];
	/** The files whose marker is in the text, in number order. */
	readonly files: readonly DraftDocument[];
}

export function composedOf(draft: Draft): Composed {
	const compacted = compactForSend(draft.text, draft.images);
	return { prose: compacted.text.trim(), images: compacted.images, files: activeDocuments(draft.text, draft.documents) };
}

/** The wire form of the images of a composition. */
export function wireImages(images: readonly DraftImage[]): ImageContent[] {
	return images.map(image => ({ type: "image", mimeType: image.mimeType, data: image.data }));
}

/** A draft as it is kept beside the next one: only what the page holds (a linked file's text is on disk, so it is counted as lost). */
export interface HeldMessage {
	readonly text: string;
	readonly images: readonly ImageContent[];
	readonly lostFiles: number;
}

/** What Rewind keeps of the draft it replaces; `null` when the draft holds nothing to keep. */
export function heldMessage(draft: Draft): HeldMessage | null {
	const { prose, images, files } = composedOf(draft);
	const text = composeFileBlocks(prose, files.flatMap(file => (file.source.kind === "held" ? [{ number: file.number, name: file.name, label: file.source.label, content: file.source.content }] : [])));
	if (text.length === 0 && images.length === 0) return null;
	return { text, images: wireImages(images), lostFiles: files.filter(file => file.source.kind === "linked").length };
}
