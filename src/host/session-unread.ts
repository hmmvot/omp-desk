/**
 * OMP Desk — the unread marker of a session.
 *
 * A session is unread when its agent finished a reply or asked the user a question and
 * the user has not looked at the session since. The state is two identities the index
 * already persists, both in the shared catalog row: `lastCompletedReplyId` names the newest
 * finished-or-asked event and `lastSeenReplyId` names the newest one the user has been in
 * front of. They differ exactly while the session is unread, and a later event replaces
 * the first identity instead of toggling a flag.
 *
 * Pure decisions only; `src/extension.ts` calls them from the notification ledgers and
 * from the window/editor focus events and persists the result through
 * `SessionIndex.recordConversationState`.
 */
import { desktopNotificationSuppression } from "./notifications.ts";

export interface ReplyMarkers {
	readonly lastCompletedReplyId: string | null;
	readonly lastSeenReplyId: string | null;
}

export function isUnread(markers: ReplyMarkers): boolean {
	return markers.lastCompletedReplyId != null && markers.lastCompletedReplyId !== (markers.lastSeenReplyId ?? null);
}

/**
 * Whether the user is looking at the session: its editor is the active, visible one of a
 * focused window. This is the same notion that suppresses a desktop notification, minus
 * the notification setting: turning notifications off must not mark a viewed reply unread.
 */
export function isLookedAt(focused: boolean, visible: boolean, active: boolean): boolean {
	return desktopNotificationSuppression(true, focused, visible, active) !== null;
}

/** A fresh identity for one earned event, never equal to the previous one. */
export function nextEventMarker(previous: string | null | undefined, now: number): string {
	const base = `event-${now.toString(36)}`;
	if (previous == null || !previous.startsWith(base)) return base;
	const repeat = Number(previous.slice(base.length + 1));
	return `${base}.${Number.isInteger(repeat) ? repeat + 1 : 1}`;
}

/**
 * The markers after the agent finished a reply or asked a question. Looked at, the event
 * is read at once; otherwise the session turns (or stays) unread.
 */
export function markersAfterEvent(current: ReplyMarkers, lookedAt: boolean, now: number): ReplyMarkers {
	const marker = nextEventMarker(current.lastCompletedReplyId, now);
	return { lastCompletedReplyId: marker, lastSeenReplyId: lookedAt ? marker : current.lastSeenReplyId ?? null };
}

/** The markers after the user looked at the session, or `null` when nothing changes. */
export function markersAfterViewing(current: ReplyMarkers): ReplyMarkers | null {
	return isUnread(current) ? { lastCompletedReplyId: current.lastCompletedReplyId, lastSeenReplyId: current.lastCompletedReplyId } : null;
}
