/**
 * Which Enter chord sends in Chat's message inputs (`ompDesk.chatSendWith`), which the host pushes with the display preferences
 * (the rules are in `src/chat/send-with.ts`). A module-level store, like the tool-intent switch, so a composer, the queued-message
 * editor, the side-question box and an ask's answer field read it without a prop. A preference the host has not sent reads as `enter`.
 */
import { useSyncExternalStore } from "react";
import { DEFAULT_SEND_WITH, type ChatSendWith } from "../../chat/send-with.ts";

let active: ChatSendWith = DEFAULT_SEND_WITH;
const listeners = new Set<() => void>();

export function setSendWith(value: ChatSendWith): void {
	if (active === value) return;
	active = value;
	for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function useSendWith(): ChatSendWith {
	return useSyncExternalStore(subscribe, () => active, () => active);
}
