/**
 * The draft as it is kept across a window reload (docs/designs/2026-11-03-keep-the-chat-draft-across-a-window-reload.md): the
 * hand-off's content plus the images, which the hand-off only counts. `snapshotOf` is what the page posts to the host, `restorePersisted`
 * what it does with the record the host gives back to a composer that has just mounted. Both are pure.
 *
 * What is kept is what a send would carry: the text (every marker, quote, command chip and `@path` is in it), the images and files whose
 * marker is in it, the recovery cards (their images are counted, not carried, as in the hand-off) and the message awaiting admission as
 * an unconfirmed card. Attachments kept only so Undo could bring a marker back are not, and neither is the undo history.
 */
import type { DraftHandoffContent, PersistedDraftImage } from "../../../protocol/messages.ts";
import { addRecoverable, captureOf, restoreHandoff } from "./handoff.ts";
import type { Change } from "./field.ts";
import { activeImages } from "./image-references.ts";
import type { Draft, DraftImage } from "./value.ts";

/** What the page posts to be kept: the hand-off's content, the image set and the key that names it. */
export interface DraftSnapshot {
	readonly content: DraftHandoffContent;
	/** The ids of the images, in number order, comma separated; empty for none. */
	readonly imagesKey: string;
	/** The images this snapshot carries; empty when `carry` was off or the draft has none. */
	readonly images: readonly PersistedDraftImage[];
	/** Nothing is worth keeping: the host deletes its record. */
	readonly empty: boolean;
}

/**
 * The part of `draft` that is kept. With `carry` off the images are counted as not carried (what the host could not store): the key
 * is empty, `images` is empty and `content.attachments` includes them, so a restore says how many must be attached again.
 */
export function snapshotOf(draft: Draft, carry = true): DraftSnapshot {
	const active = activeImages(draft.text, draft.images);
	const handoff = captureOf(draft);
	const images = carry
		? active.map((image): PersistedDraftImage => ({
			number: image.number,
			name: image.name,
			mimeType: image.mimeType,
			bytes: image.bytes,
			data: image.data,
			...(image.width !== undefined && image.height !== undefined ? { width: image.width, height: image.height } : {}),
		}))
		: [];
	// `captureOf` counts the active images as not carried; the images this snapshot carries are not among them.
	const content: DraftHandoffContent = { ...handoff, attachments: carry ? draft.lostImages : handoff.attachments };
	return {
		content,
		imagesKey: carry ? active.map(image => image.id).join(",") : "",
		images,
		empty: content.text === "" && content.attachments === 0 && content.recoverable.length === 0 && content.documents.length === 0 && images.length === 0,
	};
}

/** A composer nobody has used: nothing typed, attached or kept, never edited. Only such a draft is replaced by a record of an earlier page. */
function pristine(draft: Draft): boolean {
	return draft.revision === 0 && draft.text === "" && draft.images.length === 0 && draft.documents.length === 0 && draft.recoverable.length === 0
		&& draft.inFlight === null && draft.lostImages === 0 && draft.reading === 0;
}

const RECALLED_CARD = "This is the draft you had before the window reloaded. Add it to the draft when you want it back.";

/**
 * The draft of an earlier page, given to a composer that has just mounted. A pristine composer takes it whole (the text is written
 * without taking the focus; the undo history starts over; new reference numbers never collide with the text's); a composer the user
 * already typed in keeps its own draft and gets the recalled text as a recovery card, so nothing is lost and nothing is merged.
 *
 * The images keep the ids their key names (when it names distinct ones), so the draft's own key equals the one the host holds and the
 * next save leaves the image bytes out.
 */
export function restorePersisted(draft: Draft, recalled: DraftHandoffContent & { readonly imagesKey: string; readonly images: readonly PersistedDraftImage[] }): Change {
	const { images, imagesKey, ...content } = recalled;
	if (!pristine(draft)) {
		// The recalled recovery cards are rebuilt by the hand-off's own restore, over a draft that has no text of its own.
		const cards = restoreHandoff({ ...draft, recoverable: [] }, { text: "", attachments: 0, recoverable: content.recoverable, documents: [] }).draft;
		let change: Change = { draft: { ...draft, recoverable: [...draft.recoverable, ...cards.recoverable], next: cards.next }, writes: [] };
		if (content.text.trim() !== "") {
			const lostAttachments = content.attachments + images.length;
			const lostFiles = content.documents.length;
			change = addRecoverable(change.draft, { text: content.text, images: [], reason: RECALLED_CARD, unconfirmed: false, ...(lostAttachments > 0 ? { lostAttachments } : {}), ...(lostFiles > 0 ? { lostFiles } : {}) });
		}
		return change;
	}
	const restored = restoreHandoff(draft, content);
	const named = imagesKey === "" ? [] : imagesKey.split(",").map(Number);
	const own = named.length === images.length && named.every(id => id >= restored.draft.next.key) && new Set(named).size === named.length;
	let key = restored.draft.next.key;
	const held: DraftImage[] = images.map((image, index) => ({
		id: own ? named[index]! : key++,
		number: image.number,
		name: image.name,
		mimeType: image.mimeType,
		bytes: image.bytes,
		data: image.data,
		...(image.width !== undefined && image.height !== undefined ? { width: image.width, height: image.height } : {}),
	}));
	if (own) key = Math.max(key, ...named.map(id => id + 1));
	let imageNumber = restored.draft.next.image;
	for (const image of held) imageNumber = Math.max(imageNumber, image.number + 1);
	return {
		draft: { ...restored.draft, images: held, next: { ...restored.draft.next, key, image: imageNumber } },
		// The page has just loaded: restoring does not take the focus from wherever VS Code put it.
		writes: restored.writes.map(write => write.kind === "text" ? { ...write, focus: false } : write),
	};
}
