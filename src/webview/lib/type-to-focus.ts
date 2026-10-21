/**
 * Typing on the Chat page always goes into the composer.
 *
 * VS Code gives the webview's document the keyboard focus, but a click on a tool row, a file link, a copy button or
 * the transcript background leaves a button, a link or nothing focused, and the keys the user types then go nowhere.
 * One document-level `keydown` listener (bubble phase) moves the focus into the composer when a key that would insert
 * text arrives at something that cannot take text. The browser's own handling of that same key then runs against the
 * newly focused textarea, so the character (or the paste) lands there exactly once; nothing is inserted from script.
 *
 * What is left alone, and why:
 * - Space, Enter, Tab, Escape and navigation keys: they scroll, activate the focused button or link, move focus or
 *   close a layer, so they keep their native meaning. Space is not text here for the same reason; the first letter
 *   of a word already moved the focus, so a space typed after it lands in the composer.
 * - Ctrl/Meta/Alt chords (copy, find, history search, `Alt+Up` and every keybinding), except AltGr text.
 * - IME composition (`isComposing`, `Process`, keyCode 229) and dead keys: the editor owns them.
 * - Events another handler already claimed (`defaultPrevented`) and untrusted events, which can insert nothing.
 * - Editable targets (input, textarea, select, contenteditable, text-like ARIA roles): the user is typing there.
 * - The Rewind picker: its focused bar owns the arrow keys, which a moved focus would strand.
 * - A composer that is absent (an ask is open), disabled or read-only: there is nowhere to type.
 */

import { isPhysicalKey } from "./physical-keys.ts";

/** The facts of a `keydown` the decision needs; a `KeyboardEvent` satisfies it. */
export interface TypingKey {
	readonly key: string;
	readonly code?: string;
	readonly keyCode?: number;
	readonly ctrlKey: boolean;
	readonly metaKey: boolean;
	readonly altKey: boolean;
	readonly shiftKey: boolean;
	readonly isComposing: boolean;
	/** Whether the AltGraph modifier is held (AltGr reports Ctrl+Alt on Windows). */
	readonly altGraph: boolean;
}

/** `"text"` for a key that inserts one character, `"paste"` for a paste chord, `null` for everything else. */
export function typingIntent(event: TypingKey): "text" | "paste" | null {
	if (event.isComposing || event.keyCode === 229 || event.key === "Process" || event.key === "Dead") return null;
	const paste = isPhysicalKey(event, "KeyV");
	if ((event.ctrlKey || event.metaKey) && !event.altKey && paste) return "paste";
	if (event.key === "Insert" && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) return "paste";
	if (event.metaKey) return null;
	if ((event.ctrlKey || event.altKey) && !event.altGraph) return null;
	// One user-perceived code point: surrogate pairs are one character, `ArrowUp`/`Enter`/`F1` are names.
	const characters = [...event.key];
	if (characters.length !== 1 || event.key === " ") return null;
	return event.key.trim().length === 0 ? null : "text";
}

const EDITABLE = "input,textarea,select,[contenteditable]:not([contenteditable=false]),[role=textbox],[role=searchbox],[role=combobox],[role=menu],[role=listbox]";
const KEEPS_FOCUS = ".omp-rewind-bar--picking";
const COMPOSER = ".omp-composer-row--input .omp-composer-input";

/** Whether `target` is, or sits inside, a field the user types into (or a menu or list that owns its keys). */
export function isEditableTarget(target: Element): boolean {
	return target.closest(EDITABLE) !== null;
}

/** The composer's field when it exists and can take text, else `null`. */
export function writableComposer(doc: Document): HTMLElement | null {
	const field = doc.querySelector<HTMLElement>(COMPOSER);
	return field === null || !field.isContentEditable || field.getAttribute("aria-readonly") === "true" ? null : field;
}

/** Starts redirecting typing into the composer in `win`'s document; returns the function that stops it. */
export function installTypeToFocus(win: Window & typeof globalThis): () => void {
	const doc = win.document;
	const onKeyDown = (event: KeyboardEvent): void => {
		if (event.defaultPrevented || !event.isTrusted) return;
		const intent = typingIntent({
			key: event.key,
			code: event.code,
			keyCode: event.keyCode,
			ctrlKey: event.ctrlKey,
			metaKey: event.metaKey,
			altKey: event.altKey,
			shiftKey: event.shiftKey,
			isComposing: event.isComposing,
			altGraph: event.getModifierState("AltGraph"),
		});
		if (intent === null) return;
		const target = event.target instanceof win.Element ? event.target : doc.activeElement;
		if (target !== null && (isEditableTarget(target) || target.closest(KEEPS_FOCUS) !== null)) return;
		const composer = writableComposer(doc);
		if (composer === null) return;
		composer.focus({ preventScroll: true });
		const selection = doc.getSelection();
		selection?.selectAllChildren(composer);
		selection?.collapseToEnd();
	};
	doc.addEventListener("keydown", onKeyDown);
	return () => doc.removeEventListener("keydown", onKeyDown);
}
