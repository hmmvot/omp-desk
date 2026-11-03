/**
 * The page's half of keeping the Chat draft across a window reload
 * (docs/designs/2026-11-03-keep-the-chat-draft-across-a-window-reload.md): it watches the composer's Draft cell, posts what is worth
 * keeping to the host (`omp:draft-save`) and puts back what the host kept (`omp:draft-recall`).
 *
 * Saving is bounded: one message in flight, at most one per 400 ms of quiet and at the latest 2 s after the first unsaved change, at once
 * when the page is hidden or unloading and when the draft has just become empty (a send, a cleared composer), so a record of text that
 * was already sent is deleted without waiting. The image bytes travel only when the image set changes (its key differs from the key the
 * host last acknowledged); the host's answer states the key it now holds, so a lost or refused write corrects itself, and a set the host
 * refused is counted as not carried instead of being sent again. A composer that has just mounted is empty because its draft has not
 * been restored yet, not because the user emptied it: nothing is posted until the draft has had content, so an empty page never erases
 * the record it is about to be given.
 *
 * The draft is never logged or put in the webview's persisted state.
 */
import { parseDraftHandoffContent } from "../../protocol/messages.ts";
import type { GuestDraftRecallMessage, GuestDraftSaveMessage, GuestDraftSavedMessage } from "../../protocol/messages.ts";
import { restorePersisted, snapshotOf } from "./draft/draft.ts";
import type { Draft, DraftCell } from "./draft/draft.ts";

/** Quiet time before a save. */
export const SAVE_QUIET_MS = 400;
/** The longest a change waits for its save while the user keeps typing. */
export const SAVE_MAX_WAIT_MS = 2_000;
/** How long one save may wait for its answer before it is given up. */
export const SAVE_ACK_MS = 10_000;
/** Saves that got no answer in a row before the page stops asking until the draft changes again. */
const MAX_UNANSWERED = 2;

/** What the persistence needs from its page; every member has a fake in the node test. */
export interface PersistenceHost {
	/** `false` when the message provably went nowhere (a route that cannot carry it). */
	post(message: GuestDraftSaveMessage): boolean;
	/** The route changed: a save that could not be posted may be posted now. */
	onRoute(listener: () => void): () => void;
	/** The page became hidden or is being unloaded. */
	onLeaving(listener: () => void): () => void;
}

export interface DraftPersistence {
	/** The host's answer to a save, or the record of an earlier page. */
	receive(message: GuestDraftSavedMessage | GuestDraftRecallMessage): void;
	stop(): void;
}

type Timer = ReturnType<typeof setTimeout>;

/** The parts of the draft that are kept; a change of any other (reads in flight, the history walk, the caret) is no change. */
function partsOf(draft: Draft): readonly unknown[] {
	return [draft.text, draft.images, draft.documents, draft.recoverable, draft.inFlight, draft.lostImages];
}

function sameParts(a: readonly unknown[], b: readonly unknown[]): boolean {
	return a.every((part, index) => part === b[index]);
}

/** Nothing of the draft is kept, attachments only Undo could bring back included. */
function hasNothing(draft: Draft): boolean {
	return draft.text === "" && draft.images.length === 0 && draft.documents.length === 0 && draft.recoverable.length === 0 && draft.inFlight === null && draft.lostImages === 0;
}

export function startDraftPersistence(cell: DraftCell, host: PersistenceHost): DraftPersistence {
	let last = partsOf(cell.read());
	/** The draft has held something since this page started: only then is an empty draft the user's doing and worth telling the host. */
	let armed = false;
	let dirty = false;
	let hostKey: string | undefined;
	/** The image set the host answered with another key for after it was sent whole: counted as not carried until the images change. */
	let refusedKey: string | null = null;
	let inFlight: { readonly saveId: number; readonly key: string; readonly sentImages: boolean } | null = null;
	let unanswered = 0;
	/** A recall the cell refused (it was held by a hand-off): applied when the cell lets go. */
	let waiting: GuestDraftRecallMessage | null = null;
	let seq = 0;
	let quiet: Timer | undefined;
	let maxWait: Timer | undefined;
	let ack: Timer | undefined;
	let stopped = false;

	const cancel = (timer: Timer | undefined): undefined => {
		clearTimeout(timer);
		return undefined;
	};

	const send = (): void => {
		quiet = cancel(quiet);
		maxWait = cancel(maxWait);
		if (stopped || !dirty || inFlight !== null || unanswered >= MAX_UNANSWERED) return;
		const draft = cell.read();
		const carry = refusedKey === null || snapshotOf(draft, true).imagesKey !== refusedKey;
		const snapshot = snapshotOf(draft, carry);
		if (!armed && snapshot.empty) {
			dirty = false;
			return;
		}
		// A draft the boundary would refuse whole (over its text bound, a control character) is not posted: no answer would come, and
		// the same snapshot would be tried again.
		if (parseDraftHandoffContent(snapshot.content) === null) {
			dirty = false;
			return;
		}
		const images = snapshot.imagesKey === hostKey ? null : [...snapshot.images];
		const message: GuestDraftSaveMessage = { type: "omp:draft-save", saveId: ++seq, imagesKey: snapshot.imagesKey, images, ...snapshot.content };
		if (!host.post(message)) return;
		dirty = false;
		inFlight = { saveId: message.saveId, key: snapshot.imagesKey, sentImages: images !== null };
		ack = setTimeout(() => {
			ack = undefined;
			// No answer: what the host holds is unknown, so the next save sends the images again.
			inFlight = null;
			hostKey = undefined;
			unanswered += 1;
			dirty = true;
			schedule();
		}, SAVE_ACK_MS);
	};

	const schedule = (): void => {
		if (stopped) return;
		quiet = cancel(quiet);
		quiet = setTimeout(send, SAVE_QUIET_MS);
		maxWait ??= setTimeout(send, SAVE_MAX_WAIT_MS);
	};

	const apply = (message: GuestDraftRecallMessage): void => {
		waiting = null;
		if (!cell.commit(restorePersisted(cell.read(), message))) {
			waiting = message;
			return;
		}
		// The record the host holds is exactly this draft when the images came back under the ids its key names.
		if (snapshotOf(cell.read()).imagesKey === message.imagesKey) hostKey = message.imagesKey;
	};

	const unsubscribe = cell.subscribe(() => {
		if (waiting !== null && !cell.getState().held) apply(waiting);
		const draft = cell.read();
		const parts = partsOf(draft);
		if (sameParts(parts, last)) return;
		last = parts;
		dirty = true;
		unanswered = 0;
		if (hasNothing(draft)) {
			// The draft just became empty: a send, a cleared composer, a dismissed card. The record of what is gone is deleted now.
			if (armed) send();
			return;
		}
		armed = true;
		schedule();
	});
	const offRoute = host.onRoute(() => {
		if (dirty) schedule();
	});
	const offLeaving = host.onLeaving(send);

	return {
		receive(message) {
			if (stopped) return;
			if (message.type === "omp:draft-recall") {
				apply(message);
				return;
			}
			if (inFlight === null || inFlight.saveId !== message.saveId) return;
			ack = cancel(ack);
			const sent = inFlight;
			inFlight = null;
			unanswered = 0;
			hostKey = message.imagesKey;
			if (message.imagesKey !== sent.key) {
				// The host does not hold the set this save named: refused if it was sent whole, missing if it was left out.
				if (sent.sentImages) refusedKey = sent.key;
				dirty = true;
			}
			if (dirty) schedule();
		},
		stop() {
			stopped = true;
			unsubscribe();
			offRoute();
			offLeaving();
			quiet = cancel(quiet);
			maxWait = cancel(maxWait);
			ack = cancel(ack);
		},
	};
}

type Receiver = (message: GuestDraftSavedMessage | GuestDraftRecallMessage) => void;
const receivers: Receiver[] = [];
let pendingRecall: GuestDraftRecallMessage | null = null;
let lastRecallId: number | null = null;

/**
 * The page's inbound path: the host's answers reach the newest composer's persistence; a recall that arrives before a composer has
 * mounted waits for it (apart from the hand-off's own pending draft), and the same recall is delivered once.
 */
export function offerDraftPersistence(message: GuestDraftSavedMessage | GuestDraftRecallMessage): void {
	if (message.type === "omp:draft-recall") {
		if (lastRecallId === message.recallId) return;
		lastRecallId = message.recallId;
		const receiver = receivers[receivers.length - 1];
		if (receiver === undefined) {
			pendingRecall = message;
			return;
		}
		receiver(message);
		return;
	}
	receivers[receivers.length - 1]?.(message);
}

/** Registers the persistence of a mounted composer as the receiver of the host's answers, and hands it the recall that was waiting. */
export function receiveDraftPersistence(receiver: Receiver): () => void {
	receivers.push(receiver);
	const waiting = pendingRecall;
	pendingRecall = null;
	if (waiting !== null) receiver(waiting);
	return () => {
		const index = receivers.indexOf(receiver);
		if (index >= 0) receivers.splice(index, 1);
	};
}
