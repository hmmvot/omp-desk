/**
 * Every write that comes from outside the field and replaces or extends the draft (docs/designs/2026-10-23-composer-draft-module.md,
 * section 4, group 2): the editor text of the session, the reference the host inserts, what a Stop or a queue edit takes back, Rewind's
 * prompt and the clears. Each is a pure function of the draft; the cell decides when it may be written (`Timing`, carried by the caller).
 */
import type { ChatNavigateResultMessage } from "../../../protocol/chat-messages.ts";
import { MAX_DRAFT_BYTES } from "./attachments.ts";
import { heldMessage } from "./composition.ts";
import { isKnownDocument, pruneInactiveDocuments } from "./draft-documents.ts";
import type { Change, Op } from "./field.ts";
import { pruneInactive, referencedNumbers } from "./image-references.ts";
import { mergeRestoredQueued, type RestoredQueued } from "./queue-merge.ts";
import type { Draft } from "./value.ts";

/** The sentences the composer shows in its two alert rows; `undefined` leaves a row as it is, `null` clears it. */
export interface Alerts {
	readonly attach?: string | null;
	readonly send?: string | null;
}

const SPACE = /\s/;

/** A space or tab straight after `end`: the draft already has the separator the caret should step over. */
export function followedByBlank(current: string, end: number): boolean {
	return end < current.length && (current[end] === " " || current[end] === "\t");
}

/**
 * `text` with the spacing the draft around `[start, end)` needs: one leading space unless the draft is empty there or whitespace already
 * precedes, and one trailing space unless a space or tab already follows (a line break does not count: the caret must not rest right
 * after a bare `@path`, where the composer's own `@` popup would open and take the next Enter). When one already follows, the caret
 * moves past it ({@link followedByBlank}).
 */
export function spaceInsertion(current: string, start: number, end: number, text: string): string {
	const body = text.trim();
	const lead = start > 0 && !SPACE.test(current[start - 1] as string) ? " " : "";
	const trail = followedByBlank(current, end) ? "" : " ";
	return `${lead}${body}${trail}`;
}

/** `set_editor_text` from the session: the draft is replaced, as one undoable step. */
export function setEditorText(draft: Draft, text: string): Change {
	return { draft: { ...draft, text }, writes: [{ kind: "text", text, history: "record", focus: true }] };
}

/**
 * Text the host adds (the `@path` references of "Add File to Session", the `path:N` line reference of "Quote Selection to Session"): it
 * goes at the caret, over a selection, as one undoable step, and at the end of the draft while no field is mounted. The field widens the
 * edit over a marker it cuts into; it is never submitted.
 */
export function insertText(reference: string): Op<void> {
	return (draft, at) => {
		const current = draft.text;
		const start = Math.min(at.selection.anchor, at.selection.focus);
		const end = Math.max(at.selection.anchor, at.selection.focus);
		const inserted = spaceInsertion(current, start, end, reference);
		const writes: Change["writes"][number][] = [{ kind: "edit", edit: { from: start, to: end, insert: inserted }, as: "replace", focus: true }];
		// A space already follows: the caret steps over it, so it never rests right after a bare `@path`.
		if (at.mounted && followedByBlank(current, end)) writes.push({ kind: "caret", at: start + inserted.length + 1, focus: false });
		return { change: { draft: { ...draft, text: current.slice(0, start) + inserted + current.slice(end) }, writes }, result: undefined };
	};
}

/**
 * Messages taken back (a queue edit, Alt+Up, a Stop, the history search, a recovery card's "Add to draft") are appended after what is
 * typed, their images re-attached under fresh numbers; nothing the draft held is replaced. A taken-back message that filled an empty
 * composer on its own latches `unedited`, so Undo of its move clears it while it stays unedited (ADR-0082); never a typed draft, and
 * never a refill that also carries messages the Stop took out of OMP's queue: they exist nowhere else.
 */
export function restoreQueued(entries: readonly RestoredQueued[]): Op<Alerts> {
	return draft => {
		const held = draft.images.length;
		const heldDocuments = draft.documents.length;
		const wasEmpty = draft.text.trim().length === 0 && held === 0 && heldDocuments === 0;
		const merged = mergeRestoredQueued({ text: draft.text, images: draft.images, documents: draft.documents, nextNumber: draft.next.image, nextDocumentNumber: draft.next.document, nextId: draft.next.key }, entries);
		const present = referencedNumbers(merged.text, "image", (kind, number) => kind === "image" && merged.images.some(image => image.number === number));
		const images = pruneInactive(merged.images, number => present.has(number), new Set(merged.images.slice(held).map(image => image.number)), MAX_DRAFT_BYTES);
		const presentFiles = referencedNumbers(merged.text, "file", (kind, number, name) => kind === "file" && isKnownDocument(merged.documents, number, name));
		const documents = pruneInactiveDocuments(merged.documents, number => presentFiles.has(number), new Set(merged.documents.slice(heldDocuments).map(document => document.number)));
		const latch = wasEmpty && entries.length === 1 && entries[0]!.withdrawn === true ? { unedited: draft.revision + 1 } : {};
		const sentences = [...(merged.imagesLost > 0 ? [`${merged.imagesLost} image${merged.imagesLost === 1 ? "" : "s"} of the edited message could not be attached (unsupported format).`] : []), ...merged.notes];
		return {
			change: {
				draft: { ...draft, text: merged.text, images, documents, next: { ...draft.next, image: merged.nextNumber, document: merged.nextDocumentNumber, key: merged.nextId }, ...latch },
				writes: [{ kind: "text", text: merged.text, caret: merged.text.length, history: "record", focus: true }],
			},
			result: { attach: sentences.length > 0 ? sentences.join(" ") : null },
		};
	};
}

/** What a finished navigation hands the composer: the kind and, for a Rewind, the prompt that was rewound. */
export type RewindAnswer = Pick<ChatNavigateResultMessage, "kind" | "draft">;

/**
 * Rewind's edit and resubmit (ADR-0051): a rewound prompt replaces the draft, and a draft typed before it moves to a recovery card
 * first, never overwritten. Undo takes the prompt back out while it is still unedited (the draft's `unedited` holds the revision right
 * after it was placed). Every finished navigation consumes that latch: a switch, or a rewind with no prompt, is a change that only clears it.
 */
export function rewind(answer: RewindAnswer): Op<Alerts> {
	return draft => {
		const unedited = draft.unedited !== null && draft.unedited === draft.revision;
		const consumed: Draft = { ...draft, unedited: null };
		if (answer.kind === "undo") {
			if (!unedited) return { change: { draft: consumed, writes: [] }, result: {} };
			return {
				change: { draft: { ...consumed, text: "", images: [], documents: [], next: { ...draft.next, image: 1, document: 1 } }, writes: [{ kind: "text", text: "", history: "reset", focus: false }] },
				result: { attach: null },
			};
		}
		const prompt = answer.draft;
		if (answer.kind !== "rewind" || prompt === undefined) return { change: { draft: consumed, writes: [] }, result: {} };
		let recoverable = draft.recoverable;
		let card = draft.next.card;
		const held = heldMessage(draft);
		if (held !== null) {
			recoverable = [...recoverable, { id: card++, text: held.text, images: held.images, reason: "Your draft from before the rewind. Add it to the draft only when you want it back.", unconfirmed: false, ...(held.lostFiles > 0 ? { lostFiles: held.lostFiles } : {}) }];
		}
		const merged = mergeRestoredQueued({ text: "", images: [], documents: [], nextNumber: 1, nextDocumentNumber: 1, nextId: draft.next.key }, [{ text: prompt.text, images: prompt.images }]);
		const lost = merged.imagesLost + prompt.unavailableImages;
		return {
			change: {
				draft: {
					...consumed,
					text: merged.text,
					images: pruneInactive(merged.images, () => true, new Set(merged.images.map(image => image.number)), MAX_DRAFT_BYTES),
					documents: merged.documents,
					walk: null,
					recoverable,
					next: { image: merged.nextNumber, document: merged.nextDocumentNumber, key: merged.nextId, card },
					unedited: draft.revision + 1,
				},
				writes: [{ kind: "text", text: merged.text, caret: merged.text.length, history: "reset", focus: true }],
			},
			result: { attach: lost > 0 ? `${lost} image${lost === 1 ? "" : "s"} of the rewound message could not be restored.` : null, send: null },
		};
	};
}

/** `/rewind` or `/branch` typed alone: the text is cleared and nothing else (attachments and counters stay). */
export function clearText(draft: Draft): Change {
	return { draft: { ...draft, text: "" }, writes: [{ kind: "text", text: "", history: "reset", focus: false }] };
}

/**
 * The draft after an accepted send: text, attachments, counters and the history walk are cleared and the undo stack starts over, so
 * Undo cannot bring a sent draft back.
 */
export function cleared(draft: Draft): Change {
	return {
		draft: { ...draft, text: "", images: [], documents: [], walk: null, next: { ...draft.next, image: 1, document: 1 } },
		writes: [{ kind: "text", text: "", history: "reset", focus: false }],
	};
}
