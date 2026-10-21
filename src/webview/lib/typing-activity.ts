/**
 * Whether the user is typing in the composer right now.
 *
 * A draft edit is a `beforeinput` the composer's surface cancels and applies itself (`lib/draft-surface.ts`); each one,
 * and each step of an IME composition, marks the moment, and the user counts as typing until {@link TYPING_QUIET_MS}
 * pass without another. Between two keystrokes the page has a few milliseconds of main thread, and a running reply
 * that re-renders the transcript thirty times a second and re-parses its text on every animation frame would spend
 * them all, so the live work yields while this is true: `ChatClient` tells its subscribers about a reply's frames
 * less often and `PacedMarkdown` shows the text at once instead of revealing it frame by frame. Nothing is dropped:
 * the model holds every frame, and the first change after the pause shows the latest text.
 */

/** How long after the last edit the user still counts as typing: longer than the gap between two keystrokes of a slow typist. */
export const TYPING_QUIET_MS = 500;

const COMPOSER_FIELD = ".omp-composer-input";

const listeners = new Set<() => void>();
let lastEdit = Number.NEGATIVE_INFINITY;
let quietTimer: unknown;
let typing = false;

/** An edit of the composer's draft happened within {@link TYPING_QUIET_MS}. */
export function isTyping(): boolean {
	return typing;
}

/** Called when {@link isTyping} changes; returns the function that stops listening. */
export function subscribeTyping(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

function settle(): void {
	const quietFor = Date.now() - lastEdit;
	if (quietFor < TYPING_QUIET_MS) {
		quietTimer = setTimeout(settle, TYPING_QUIET_MS - quietFor);
		return;
	}
	quietTimer = undefined;
	typing = false;
	for (const listener of [...listeners]) listener();
}

/** Marks an edit now. */
export function noteEdit(): void {
	lastEdit = Date.now();
	if (typing) return;
	typing = true;
	quietTimer = setTimeout(settle, TYPING_QUIET_MS);
	for (const listener of [...listeners]) listener();
}

/**
 * Starts watching `doc` for edits of the composer's field (capture phase, passive: it never sees a keystroke
 * before the field does and never delays one). Returns the function that stops watching and forgets the activity.
 */
export function trackTyping(doc: Document): () => void {
	const mark = (event: Event): void => {
		if (event.isTrusted && event.target instanceof Element && event.target.closest(COMPOSER_FIELD) !== null) noteEdit();
	};
	const options = { capture: true, passive: true } as const;
	doc.addEventListener("beforeinput", mark, options);
	doc.addEventListener("compositionupdate", mark, options);
	return () => {
		doc.removeEventListener("beforeinput", mark, options);
		doc.removeEventListener("compositionupdate", mark, options);
		clearTimeout(quietTimer as number);
		quietTimer = undefined;
		lastEdit = Number.NEGATIVE_INFINITY;
		if (typing) {
			typing = false;
			for (const listener of [...listeners]) listener();
		}
	};
}
