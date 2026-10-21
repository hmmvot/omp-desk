/**
 * The one way a webview page reads a letter, digit or punctuation key of a shortcut: by the physical key, never by the
 * character it typed.
 *
 * A shortcut's letter is a place on the keyboard. On a Russian layout the key that types `c` types `с` (U+0441), on a
 * Greek or Hebrew one another letter again, and `event.key` follows the layout while `event.code` (`KeyC`) does not.
 * Every chord of a Desk page (Ctrl+F, Alt+C, Ctrl+Z, Ctrl+V, the terminal's Ctrl+C, ...) is matched with
 * {@link isPhysicalKey} so that it works the same on every layout.
 *
 * What this decides, and what it costs: the physical key wins on every layout, a Latin one too. On Dvorak or AZERTY
 * the key labelled `c` is not the one a page reads as C; the user gets the shortcut on the key where QWERTY has the
 * letter. That is the price of one rule with no layout list behind it. (VS Code's own keybindings, which Desk's host
 * commands use, follow VS Code's keyboard mapper instead: on Windows it reads the virtual key, which a Latin layout
 * assigns by character and a Cyrillic one by position. The page never overrides that mapper; the two agree on every
 * QWERTY-based and Cyrillic layout, and only a layout that moves Latin letters can tell them apart.)
 *
 * Named keys (`Enter`, `Escape`, `Tab`, `Insert`, `ArrowUp`, `F3`, ...) are not letters: they have the same `key` on every
 * layout and are compared with `event.key`. `scripts/check-keys.mjs` fails the typecheck for a modifier chord that compares
 * `event.key` with a character instead, so the rule cannot be bypassed by accident.
 */

/** The parts of a `KeyboardEvent` that name the pressed key. */
export interface PhysicalKeyEvent {
	readonly key: string;
	readonly code?: string;
}

/**
 * The code of the physical key (`KeyC`, `Digit1`, `Slash`). A real keyboard event always carries one. An event a script
 * built without `code` is read by its Latin letter or digit, the only reading it has.
 */
export function physicalCode(event: PhysicalKeyEvent): string {
	if (event.code !== undefined && event.code !== "") return event.code;
	if (/^[a-z]$/i.test(event.key)) return `Key${event.key.toUpperCase()}`;
	if (/^[0-9]$/.test(event.key)) return `Digit${event.key}`;
	return "";
}

/** Whether the event is the physical key `code` (`KeyC`, `Digit1`, `Slash`, `BracketLeft`, ...), on whatever layout. */
export function isPhysicalKey(event: PhysicalKeyEvent, code: string): boolean {
	return physicalCode(event) === code;
}

