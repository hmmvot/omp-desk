/**
 * Pure view-model of the queued-messages row above the composer: the rows OMP's queue readback becomes, the
 * line budget of the bottom block, and the fixed sentences that report what a removal did.
 *
 * Nothing here queues, caches or guesses a message: the rows are exactly `get_state.queuedMessages` /
 * `queue_update` as the host read them back, and a removal's outcome is exactly the host's per-item answer.
 */
import type { ChatQueuedMessages } from "../../chat/model.ts";
import type { ChatQueuePurpose, ChatQueueResultItem, ChatQueuedRef } from "../chat-messages.ts";
import type { RestoredQueued } from "./queue-restore.ts";
import { HUD_HEADER_PX, HUD_LINE_PX, HUD_LIST_PAD_PX, HUD_STACK_PAD_PX } from "../../chat/hud-summary.ts";

/** The queue row may take at most this share of the viewport, so the transcript keeps its room. */
export const QUEUE_VIEWPORT_SHARE = 0.25;
/** Content lines (the `+N more` line included) however tall the window is. */
export const QUEUE_MAX_LINES = 6;
/** The most text a row's tooltip carries; a longer message is cut with an ellipsis. */
export const QUEUE_TITLE_LIMIT = 4_000;

/** One queued message as the row lists it. */
export interface QueueRow extends ChatQueuedRef {
	/** `Steering` is injected into the running turn; `Follow-up` waits for the turn to end. */
	label: "Steering" | "Follow-up";
	/** The message on one line: runs of whitespace collapsed. */
	preview: string;
	/** The message for the tooltip, bounded. */
	title: string;
}

/** Steering first, then follow-up, each in OMP's delivery order — the TUI's two groups, flattened. */
export function queueRows(queue: ChatQueuedMessages | undefined): QueueRow[] {
	if (queue === undefined) return [];
	const row = (kind: ChatQueuedRef["queue"], text: string): QueueRow => ({
		queue: kind,
		text,
		label: kind === "steering" ? "Steering" : "Follow-up",
		preview: text.replace(/\s+/g, " ").trim() || "(image only)",
		title: text.length > QUEUE_TITLE_LIMIT ? `${text.slice(0, QUEUE_TITLE_LIMIT)}…` : text,
	});
	return [...queue.steering.map(text => row("steering", text)), ...queue.followUp.map(text => row("followUp", text))];
}

/** "2 steering · 1 follow-up", plus how many pending messages the host could not list (too many or too large). */
export function queueSummary(rows: readonly QueueRow[], unlisted = 0): string {
	const steering = rows.filter(row => row.queue === "steering").length;
	const followUp = rows.length - steering;
	return [steering > 0 ? `${steering} steering` : "", followUp > 0 ? `${followUp} follow-up${followUp === 1 ? "" : "s"}` : "", unlisted > 0 ? `${unlisted} not listed` : ""].filter(part => part.length > 0).join(" · ");
}

/** How many of `total` rows are listed in a window of this height, and how many hide behind `+N more`. */
export function queueWindow(total: number, viewportHeight: number): { shown: number; hidden: number } {
	const room = viewportHeight * QUEUE_VIEWPORT_SHARE - HUD_STACK_PAD_PX - HUD_HEADER_PX - HUD_LIST_PAD_PX;
	const lines = Math.max(1, Math.min(QUEUE_MAX_LINES, Math.floor(room / HUD_LINE_PX)));
	if (total <= lines) return { shown: total, hidden: 0 };
	const shown = Math.max(1, lines - 1);
	return { shown, hidden: total - shown };
}

/** The messages an `edit` took out of the queue, oldest first, ready for the composer. */
export function restoredEntries(results: readonly ChatQueueResultItem[]): RestoredQueued[] {
	const entries: RestoredQueued[] = [];
	for (const result of results) {
		if (result.status === "removed") entries.push({ text: result.text, images: result.images ?? [] });
	}
	return entries;
}

export type QueueNoticeTone = "info" | "warn";

/** What the row tells the user after a removal; `detail` carries any text the user could otherwise lose. */
export interface QueueNotice {
	tone: QueueNoticeTone;
	text: string;
	detail?: string;
}

const messages = (count: number): string => (count === 1 ? "1 queued message" : `${count} queued messages`);

/**
 * The notice a finished removal or promotion leaves, or `null` when every item was handled and nothing needs
 * saying. `gone` is the already-delivered race: the message was sent between the click and the command, so it
 * is reported as sent — never as removed, and never dropped silently.
 */
export function queueNotice(purpose: ChatQueuePurpose, outcome: { ok: true; results: readonly ChatQueueResultItem[] } | { ok: false; reason: string }): QueueNotice | null {
	if (!outcome.ok) return { tone: "warn", text: `The queue was not changed: ${outcome.reason}.` };
	const gone = outcome.results.filter(result => result.status === "gone");
	const unknown = outcome.results.filter(result => result.status === "unknown");
	const failed = outcome.results.filter(result => result.status === "failed");
	const imagesDropped = outcome.results.some(result => result.status === "removed" && result.imagesDropped === true);
	const done = purpose === "promote" ? "moved to steering" : "removed";
	const parts: string[] = [];
	if (gone.length > 0) {
		// OMP answers `removed: false` for a message it delivered, but also for one removed elsewhere (the TUI, another window).
		parts.push(`${messages(gone.length)} ${gone.length === 1 ? "was" : "were"} already sent or ${gone.length === 1 ? "is" : "are"} no longer queued, so ${gone.length === 1 ? "it" : "they"} could not be ${purpose === "edit" ? "edited" : purpose === "promote" ? "sent now" : "removed"}.`);
	}
	if (unknown.length > 0) {
		parts.push(`OMP did not confirm whether ${messages(unknown.length)} ${unknown.length === 1 ? "was" : "were"} ${done}; the list shows what is still queued.`);
	}
	if (failed.length > 0) parts.push(`${messages(failed.length)} could not be ${done} and ${failed.length === 1 ? "is" : "are"} still queued.`);
	if (imagesDropped && purpose === "edit") parts.push("Some images could not be restored to the composer.");
	if (parts.length === 0) return null;
	const detail = unknown.length === 0 ? undefined : unknown.map(result => result.text).join("\n\n");
	const text = parts.join(" ");
	return { tone: "warn", text, ...(detail === undefined ? {} : { detail: detail.length > QUEUE_TITLE_LIMIT ? `${detail.slice(0, QUEUE_TITLE_LIMIT)}…` : detail }) };
}
