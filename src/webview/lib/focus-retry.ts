/**
 * Move focus into an element that may not be able to take it yet.
 *
 * A host command (Ctrl+Shift+Q) posts its focus request while VS Code is still revealing the editor, so the
 * composer's textarea can be hidden with its frame, or disabled while the panel reconnects, and `focus()` is then
 * ignored without an error. This tries at once and again every `intervalMs` until the element holds focus, giving up
 * after `attempts` tries or as soon as something else the user chose in the meantime holds it.
 */
export interface FocusRetryOptions {
	/** The element to focus, or `null` when it is not mounted (nothing to do). */
	readonly element: () => { focus(): void } | null;
	/** The element that holds focus now (`document.activeElement`). */
	readonly active: () => unknown;
	/** What counts as "nothing in particular has focus" (`document.body`, `null`). */
	readonly idle: (active: unknown) => boolean;
	readonly schedule: (callback: () => void, delayMs: number) => void;
	readonly attempts?: number;
	readonly intervalMs?: number;
}

/** Returns `true` when the first attempt already worked. */
export function focusWhenPossible(options: FocusRetryOptions): boolean {
	const attempts = options.attempts ?? 10;
	const intervalMs = options.intervalMs ?? 100;
	const attempt = (remaining: number): boolean => {
		const element = options.element();
		if (element === null) return true;
		// Another element took focus on purpose between two tries: leave it there.
		if (remaining < attempts && !options.idle(options.active())) return true;
		element.focus();
		if (options.active() === element) return true;
		if (remaining > 1) options.schedule(() => { attempt(remaining - 1); }, intervalMs);
		return false;
	};
	return attempt(attempts);
}
