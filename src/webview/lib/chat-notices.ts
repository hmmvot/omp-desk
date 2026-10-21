/**
 * The page's transient notices: one-line facts the user did not ask a question for (a quote refused, a model change the host
 * rejected, a command's outcome). `App` shows them in the notice block above the conversation, below the connection and phase
 * banner; nothing is shown under the composer. A notice is keyed: posting the same key again replaces it and restarts its timer,
 * so one source never stacks. `ttlMs` auto-dismisses; without it a notice stays until the user dismisses it.
 */
export type ChatNoticeLevel = "info" | "warn" | "error";

export interface ChatNotice {
	readonly key: string;
	readonly text: string;
	readonly level: ChatNoticeLevel;
}

export interface ChatNoticeInput extends ChatNotice {
	/** Milliseconds until the notice goes away by itself. */
	readonly ttlMs?: number;
}

export class ChatNoticeStore {
	#notices: readonly ChatNotice[] = [];
	readonly #timers = new Map<string, number>();
	readonly #listeners = new Set<() => void>();

	getState = (): readonly ChatNotice[] => this.#notices;

	subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener);
		return () => { this.#listeners.delete(listener); };
	};

	post({ key, text, level, ttlMs }: ChatNoticeInput): void {
		this.#cancelTimer(key);
		const notice: ChatNotice = { key, text, level };
		const at = this.#notices.findIndex(existing => existing.key === key);
		this.#set(at < 0 ? [...this.#notices, notice] : this.#notices.map((existing, index) => index === at ? notice : existing));
		if (ttlMs !== undefined) this.#timers.set(key, window.setTimeout(() => this.dismiss(key), ttlMs));
	}

	dismiss(key: string): void {
		this.#cancelTimer(key);
		if (this.#notices.some(notice => notice.key === key)) this.#set(this.#notices.filter(notice => notice.key !== key));
	}

	#cancelTimer(key: string): void {
		const timer = this.#timers.get(key);
		if (timer === undefined) return;
		clearTimeout(timer);
		this.#timers.delete(key);
	}

	#set(next: readonly ChatNotice[]): void {
		this.#notices = next;
		for (const listener of [...this.#listeners]) listener();
	}
}
