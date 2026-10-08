/**
 * React bindings for the chat page's store.
 *
 * {@link useChatSnapshot} binds a {@link ChatClient} through `useSyncExternalStore`, and
 * {@link useComposerPopupReport} forwards the composer's `@`-popup state to the host, which
 * mirrors it into the context key its stop keybinding reads (Escape dismisses an open popup
 * and never aborts a running turn in the same press).
 */
import { useEffect, useSyncExternalStore } from "react";
import { guestTransport } from "../bridge";
import type { ChatClient, ChatSnapshot } from "./chat-client";
import { composerPopupOpen, subscribeComposerPopupOpen } from "./composer-overlay";

export function useChatSnapshot(client: ChatClient): ChatSnapshot {
	return useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
}

/** Report every change of the popup state once; the host learns `false` again on unmount. */
export function useComposerPopupReport(): void {
	useEffect(() => {
		let sent = composerPopupOpen();
		if (sent) guestTransport.post({ type: "omp:composer-popup", open: true });
		const release = subscribeComposerPopupOpen(open => {
			if (open === sent) return;
			sent = open;
			guestTransport.post({ type: "omp:composer-popup", open });
		});
		return () => {
			release();
			if (sent) guestTransport.post({ type: "omp:composer-popup", open: false });
		};
	}, []);
}
