/**
 * Which Enter chord sends in Chat's message inputs (`ompDesk.chatSendWith`).
 *
 * - `enter` (the default): Enter sends, Shift+Enter is a new line.
 * - `shiftEnter`: Shift+Enter sends, Enter is a new line.
 *
 * Ctrl+Enter and Meta+Enter send in both. Alt+Enter queues a follow-up while a turn runs in `enter`; in `shiftEnter` the
 * queueing chord is Alt+Shift+Enter (plain Alt+Enter is no send there). An open slash or `@` completion takes a plain Enter
 * first in both, and an IME composition never sends: those rules stay with the callers.
 */

export type ChatSendWith = "enter" | "shiftEnter";

export const DEFAULT_SEND_WITH: ChatSendWith = "enter";

export function isChatSendWith(value: unknown): value is ChatSendWith {
	return value === "enter" || value === "shiftEnter";
}

/** The fields of a keyboard event the chord depends on. */
export interface SendKey {
	readonly key: string;
	readonly shiftKey: boolean;
	readonly ctrlKey?: boolean;
	readonly metaKey?: boolean;
}

/** Whether this Enter keydown sends under `mode`. Composition and completion are the caller's to rule out first. */
export function isSendChord(event: SendKey, mode: ChatSendWith): boolean {
	if (event.key !== "Enter") return false;
	if (mode === "enter") return !event.shiftKey;
	return event.shiftKey || event.ctrlKey === true || event.metaKey === true;
}

/** The labels of the keys, for hints, tooltips and `aria-keyshortcuts`: what sends, what inserts a new line, what queues a follow-up while a turn runs. */
export const SEND_KEY_LABELS: Record<ChatSendWith, { readonly send: string; readonly newline: string; readonly queue: string }> = {
	enter: { send: "Enter", newline: "Shift+Enter", queue: "Alt+Enter" },
	shiftEnter: { send: "Shift+Enter", newline: "Enter", queue: "Alt+Shift+Enter" },
};
