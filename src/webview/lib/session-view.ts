import type { GuestHostMessage, GuestSessionViewMessage } from "../messages";
interface SessionViewTransport {
	subscribe(listener: (message: GuestHostMessage) => void): () => void;
}

const mode = typeof document !== "undefined" && document.querySelector('meta[name="omp-session-mode"]')?.getAttribute("content") === "terminal" ? "terminal" : "chat";
let snapshot: GuestSessionViewMessage & { readonly focusToken: string | null } = { type: "omp:session-view", mode, running: false, starting: false, stopping: false, canSwitch: false, title: "OMP session", reason: null, focusToken: null };
const listeners = new Set<() => void>();
let detach: (() => void) | null = null;

/** Attach before the document announces itself, just like the chat client. */
export function attachSessionView(transport: SessionViewTransport): void {
	detach?.();
	detach = transport.subscribe(message => {
		if (message.type === "omp:session-view") {
			snapshot = { ...message, focusToken: message.mode === "terminal" ? snapshot.focusToken : null };
		} else if (message.type === "omp:terminal-activate") {
			snapshot = { ...snapshot, focusToken: message.token };
		} else return;
		for (const listener of listeners) listener();
	});
}

export function sessionViewSnapshot(): typeof snapshot { return snapshot; }
export function subscribeSessionView(listener: () => void): () => void {
	listeners.add(listener);
	return () => { listeners.delete(listener); };
}
