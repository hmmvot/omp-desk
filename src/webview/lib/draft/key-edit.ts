/**
 * The keys that edit a fenced code block and a quote line (docs/designs/2026-10-15-composer-code-blocks.md, Section 4 of
 * docs/designs/2026-10-15-quote-chat-selection.md): Enter, Tab, Shift+Tab, Backspace and Delete are an editor's there. The rules read the
 * draft and the selection; the composer only asks whether the key is claimed and commits the change, which is one `"block"` undo step.
 */
import type { ChatSendWith } from "../../../chat/send-with.ts";
import { blockContaining, findFencedBlocks, indentEdit, newlineEdit, outdentEdit, type TextEdit } from "../code-fence.ts";
import type { Change, Selection } from "./field.ts";
import { quoteKeyEdit, type QuoteKey } from "./quote-edits.ts";
import { findQuoteRuns } from "./quote-lines.ts";
import { withState, type Draft } from "./value.ts";

/** A key press: what the rules read of a keyboard event. */
export interface KeyPress extends QuoteKey {
	readonly keyCode: number;
}

export interface KeyContext {
	/** An IME composition is active (the keystroke belongs to the candidate window). */
	readonly composing: boolean;
	/** The hand-off holds the draft. */
	readonly held: boolean;
	readonly sendWith: ChatSendWith;
}

/**
 * `claimed: false` is a key the browser or the composer's own rules handle; `inBlock` says the caret is in a fenced block (no popup key
 * and no completion applies there either). `claimed: true` with `change: null` is a key claimed with no edit to make (Tab on a fence line
 * is claimed so the focus stays).
 */
export type KeyEdit =
	| { readonly claimed: false; readonly inBlock: boolean }
	| { readonly claimed: true; readonly change: Change | null };

function blockEdit(draft: Draft, edit: TextEdit): Change {
	return {
		draft: withState(draft, { text: draft.text.slice(0, edit.from) + edit.insert + draft.text.slice(edit.to) }),
		writes: [{ kind: "edit", edit: { from: edit.from, to: edit.to, insert: edit.insert, selection: { anchor: edit.selectionStart, focus: edit.selectionEnd } }, as: "block", focus: false }],
	};
}

/**
 * Inside a fenced code block Enter and Tab are an editor's, with the chord that sends there being Ctrl+Enter, which is not claimed. A
 * quote line follows the same keys: Enter is a new line that carries the prefix (an empty quote line lets go of it), Shift+Tab leaves the
 * quote, Backspace and Delete take the prefix with them. In Shift+Enter mode a plain Shift+Enter in a quote sends. Neither applies while
 * an IME composition is active or the draft is held.
 */
export function keyEdit(draft: Draft, selection: Selection, key: KeyPress, context: KeyContext): KeyEdit {
	const start = Math.min(selection.anchor, selection.focus);
	const end = Math.max(selection.anchor, selection.focus);
	const text = draft.text;
	const blocks = findFencedBlocks(text);
	const idle = !context.composing && key.keyCode !== 229 && !context.held;
	const block = idle ? blockContaining(blocks, start, end) : null;
	if (block !== null) {
		if (key.key === "Tab" && !key.ctrlKey && !key.altKey && !key.metaKey) {
			const edit = key.shiftKey ? outdentEdit(text, block, start, end) : indentEdit(text, block, start, end);
			// Shift+Tab with nothing left to outdent is the way out of the block, backwards, and is the only Tab that moves the focus.
			if (edit === null && key.shiftKey) return { claimed: false, inBlock: true };
			return { claimed: true, change: edit === null ? null : blockEdit(draft, edit) };
		}
		if (key.key === "Enter" && !key.ctrlKey && !key.metaKey) return { claimed: true, change: blockEdit(draft, newlineEdit(text, block, start, end)) };
		return { claimed: false, inBlock: true };
	}
	if (idle && !(context.sendWith === "shiftEnter" && key.key === "Enter" && key.shiftKey && !key.altKey)) {
		const edit = quoteKeyEdit(text, findQuoteRuns(text, blocks), key, start, end);
		if (edit !== null) return { claimed: true, change: blockEdit(draft, edit) };
	}
	return { claimed: false, inBlock: false };
}
