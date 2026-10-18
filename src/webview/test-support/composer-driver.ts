/**
 * Test-only: the one place the owned-browser tests learn how to read and drive the Chat composer's field.
 *
 * The tests run page-side code as strings (`ui.evaluate("window.composer.value()")`), so everything here is
 * JSON-friendly and installed on `window.composer` by the fixture. Tests must never address the field by its
 * element type, only through this driver, so that the field's implementation can change without touching them.
 *
 * The field is the composer's contenteditable surface (docs/designs/2026-10-15-composer-contenteditable-surface.md):
 * the draft and the selection are read back from its DOM through the same pure functions the surface uses, and edits go
 * through the platform's own editing commands, so the page sees user edits.
 */
import { isChip, locate, offsetOf, readText } from "../lib/draft-dom";

const FIELD = ".omp-composer-row--input .omp-composer-input";

export interface ComposerSelection {
	readonly start: number;
	readonly end: number;
	readonly direction: "forward" | "backward" | "none";
}

function field(): HTMLElement | null {
	return document.querySelector<HTMLElement>(FIELD);
}

function required(): HTMLElement {
	const element = field();
	if (element === null) throw new Error("the composer field is not mounted");
	return element;
}

function writeSelection(element: HTMLElement, start: number, end: number): void {
	const from = locate(element, start);
	const to = start === end ? from : locate(element, end);
	document.getSelection()?.setBaseAndExtent(from.node, from.offset, to.node, to.offset);
}

export const composerDriver = {
	/** The field is mounted (it is not while a dialog owns the composer). */
	exists(): boolean {
		return field() !== null;
	},
	/** The field's element, for generic DOM reads (geometry, computed style, events). */
	el(): HTMLElement | null {
		return field();
	},
	/** The draft: the plain Markdown string. */
	value(): string {
		return readText(required());
	},
	/** The selection in draft offsets; a field the selection is not in reports a caret at the end, like a fresh draft. */
	selection(): ComposerSelection {
		const element = required();
		const selection = document.getSelection();
		if (selection === null || selection.anchorNode === null || selection.focusNode === null || !element.contains(selection.anchorNode) || !element.contains(selection.focusNode)) {
			const end = readText(element).length;
			return { start: end, end, direction: "none" };
		}
		const anchor = offsetOf(element, selection.anchorNode, selection.anchorOffset);
		const focus = offsetOf(element, selection.focusNode, selection.focusOffset);
		return { start: Math.min(anchor, focus), end: Math.max(anchor, focus), direction: anchor === focus ? "none" : anchor < focus ? "forward" : "backward" };
	},
	/** Focuses the field and selects `[start, end)`. */
	select(start: number, end: number = start): void {
		const element = required();
		element.focus();
		writeSelection(element, start, end);
	},
	selectAll(): void {
		const element = required();
		element.focus();
		writeSelection(element, 0, readText(element).length);
	},
	focus(): void {
		required().focus();
	},
	blur(): void {
		required().blur();
	},
	focused(): boolean {
		const element = field();
		return element !== null && document.activeElement === element;
	},
	disabled(): boolean {
		return required().getAttribute("aria-disabled") === "true";
	},
	readOnly(): boolean {
		return required().getAttribute("aria-readonly") === "true";
	},
	placeholder(): string {
		return required().getAttribute("data-placeholder") ?? "";
	},
	/**
	 * Replaces the whole draft through the platform's own editing commands, so the page sees user edits. A selection that holds a
	 * chip is deleted first: the platform's one-command replacement of a range with a non-editable element in it sends the page a
	 * delete the page applies, and then stops before the insertion.
	 */
	setText(text: string): void {
		const element = required();
		element.focus();
		writeSelection(element, 0, readText(element).length);
		if (text.length === 0 || element.querySelector(".omp-chip") !== null) document.execCommand("delete");
		if (text.length > 0) document.execCommand("insertText", false, text);
	},
	/**
	 * Every model offset of the draft that is not inside a chip (an image or file marker, a command or a skill), mapped to a DOM
	 * point and back. The offsets that come back different are returned: an empty list is the identity the design requires of the caret mapping.
	 */
	roundTrip(): { offset: number; back: number }[] {
		const element = required();
		const text = readText(element);
		const inside = new Set<number>();
		for (const chip of Array.from(element.querySelectorAll("*")).filter(isChip)) {
			const start = offsetOf(element, chip, 0);
			for (let at = start + 1; at < start + (chip.textContent?.length ?? 0); at++) inside.add(at);
		}
		const failures: { offset: number; back: number }[] = [];
		for (let offset = 0; offset <= text.length; offset++) {
			if (inside.has(offset)) continue;
			const point = locate(element, offset);
			const back = offsetOf(element, point.node, point.offset);
			if (back !== offset) failures.push({ offset, back });
		}
		return failures;
	},
};

export type ComposerDriver = typeof composerDriver;

/** Defines `window.composer`. */
export function installComposerDriver(target: Window): void {
	Object.assign(target, { composer: composerDriver });
}
