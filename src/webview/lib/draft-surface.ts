/**
 * The composer's editing surface: one `contenteditable` element rendered from the draft string
 * (docs/designs/2026-10-15-composer-contenteditable-surface.md, ADR-0077).
 *
 * The draft string is the only source of truth; the DOM is a rendering of it, one line element per line, and every
 * user edit is cancelled at `beforeinput` and applied to the string by {@link DraftSurface.apply}. The surface mirrors the
 * members of a textarea that the composer used (`value`, `selectionStart`, `setSelectionRange`, `focus`) and keeps its
 * own selection while unfocused, its own undo stack ({@link DraftHistory}), and one *composition window* during which
 * the browser owns the DOM: nothing is written to it between the first `compositionstart` and the settle that reads it
 * back (section 4 of the design).
 *
 * The surface owns every attribute of the element that changes while the user types; React renders the element with a
 * class only and never touches its children or attributes.
 */
import { findChips, isBareChip, type ChipSpan, type ResolveCommand } from "./command-chips.ts";
import { findFencedBlocks } from "./code-fence.ts";
import {
	LineRenderer,
	caretRowEdges,
	lineIndexOf,
	lineSpecs,
	lineTextOf,
	locate,
	offsetOf,
	readText,
	textLength,
	type CaretRowEdges,
} from "./draft-dom.ts";
import { DraftHistory, type DraftSnapshot, type EditKind } from "./draft-history.ts";
import { deletionTarget, type DeleteKind } from "./draft-text.ts";
import { normalizeLineEndings } from "../../shared/text-file.ts";
import { deletionRange, repairDamagedReferences, snapSelection, type IsKnownReference } from "./image-references.ts";
import { findQuoteRuns } from "./quote-lines.ts";
import { isPhysicalKey } from "./physical-keys.ts";
import { quotePasteEdit } from "./quote-edits.ts";

/** How a write from outside the surface treats the undo stack: one more step, or a fresh start. */
export type HistoryMode = "record" | "reset";

/** The selection as model offsets; `focus` is the caret end. */
export interface SurfaceSelection {
	readonly anchor: number;
	readonly focus: number;
}

/** One change of the draft. A missing `selection` leaves a collapsed caret after the inserted text. */
export interface SurfaceEdit {
	readonly from: number;
	readonly to: number;
	readonly insert: string;
	readonly selection?: SurfaceSelection;
}

export interface SurfaceOptions {
	/** Whether a marker belongs to an attachment of the draft, an image or a file (a marker that does not is ordinary text). */
	isKnownReference: IsKnownReference;
	/** Whether a token (the draft's first, without its `/`) names a command or a skill of the session; a token that does not is ordinary text. */
	resolveCommand: ResolveCommand;
	/** The draft changed by the user (or a composition settled). Synchronous: the composer updates its own copy now. */
	onEdit(text: string): void;
	/** The caret or selection moved (never during a composition window). */
	onSelection(): void;
	/** A key was pressed in the field, after the surface's own undo and redo handling. Not called inside a composition window. */
	onKeyDown(event: KeyboardEvent): void;
	/** A composition window opened: a composition is an edit. */
	onWindowOpen(): void;
	/** The window closed and the draft is settled; deferred work may run. */
	onSettled(): void;
	/** Offers a paste to the composer first (an image becomes a marker); `true` means it was consumed. */
	handlePaste(event: ClipboardEvent): boolean;
	/** A drag the composer's document-level handlers own (files, VS Code URIs). */
	isAttachmentDrag(transfer: DataTransfer): boolean;
}

/** Attributes the surface owns. */
export interface SurfaceConfig {
	/** The field takes input; `false` is a disabled field (`contenteditable="false"`, `aria-disabled`). */
	readonly editable: boolean;
	/** The placeholder, which is also the accessible name. */
	readonly placeholder: string;
	readonly describedBy: string | null;
	/** The open completion list, if any. */
	readonly controls: string | null;
	readonly activeDescendant: string | null;
}

const DELETE_KINDS: Readonly<Record<string, DeleteKind>> = {
	deleteContentBackward: "char-back",
	deleteContentForward: "char-fwd",
	deleteWordBackward: "word-back",
	deleteWordForward: "word-fwd",
	deleteSoftLineBackward: "line-back",
	deleteHardLineBackward: "line-back",
	deleteSoftLineForward: "line-fwd",
	deleteHardLineForward: "line-fwd",
	deleteContent: "char-back",
	deleteByCut: "char-back",
};

/** What happens after the composition window closes. */
interface WindowState {
	open: boolean;
	pre: DraftSnapshot;
	preLines: readonly string[];
	/** Line elements that held the selection while the window was open. */
	touched: Element[];
	queuedText: { text: string; caret: number | undefined; history: HistoryMode } | null;
	queuedConfig: SurfaceConfig | null;
	deferred: (() => void)[];
}

const NO_SELECTION: SurfaceSelection = { anchor: 0, focus: 0 };

function emptyWindow(): WindowState {
	return { open: false, pre: { text: "", anchor: 0, focus: 0 }, preLines: [], touched: [], queuedText: null, queuedConfig: null, deferred: [] };
}

export class DraftSurface {
	readonly element: HTMLElement;
	readonly #options: SurfaceOptions;
	readonly #renderer: LineRenderer;
	readonly #history = new DraftHistory();
	readonly #doc: Document;
	#text = "";
	#retained: SurfaceSelection = NO_SELECTION;
	#frozen = false;
	#config: SurfaceConfig = { editable: true, placeholder: "", describedBy: null, controls: null, activeDescendant: null };
	#window: WindowState = emptyWindow();
	#compositionActive = false;
	#settleTimer: number | null = null;
	#pointerDown = false;
	#disposed = false;
	readonly #listeners: [EventTarget, string, EventListener, boolean | undefined][] = [];

	constructor(element: HTMLElement, options: SurfaceOptions) {
		this.element = element;
		this.#options = options;
		this.#doc = element.ownerDocument;
		this.#renderer = new LineRenderer(element);
		element.setAttribute("role", "textbox");
		element.setAttribute("aria-multiline", "true");
		element.setAttribute("aria-autocomplete", "list");
		element.setAttribute("aria-haspopup", "listbox");
		element.setAttribute("spellcheck", "false");
		element.setAttribute("autocapitalize", "off");
		this.#applyConfig(this.#config);
		this.#render();
		const on = (target: EventTarget, type: string, handler: (event: never) => void, capture?: boolean): void => {
			target.addEventListener(type, handler as EventListener, capture);
			this.#listeners.push([target, type, handler as EventListener, capture]);
		};
		on(element, "beforeinput", e => this.#onBeforeInput(e));
		on(element, "input", () => this.#onInput());
		on(element, "keydown", e => this.#onKeyDown(e));
		on(element, "compositionstart", () => this.#onCompositionStart());
		on(element, "compositionend", () => this.#onCompositionEnd());
		on(element, "paste", e => this.#onPaste(e));
		on(element, "copy", e => this.#onCopy(e));
		on(element, "cut", e => this.#onCut(e));
		on(element, "drop", e => this.#onDrop(e));
		on(element, "dragstart", e => (e as DragEvent).preventDefault());
		on(element, "focusout", () => this.#onFocusOut());
		on(element, "focus", () => this.#onFocus());
		on(element, "pointerdown", () => { this.#pointerDown = true; });
		on(this.#doc, "pointerup", () => this.#onPointerUp(), true);
		on(this.#doc, "selectionchange", () => this.#onSelectionChange());
	}

	// ---- reads, shaped like a textarea's ---------------------------------------------------------------------------

	/** The draft. */
	get text(): string {
		return this.#text;
	}

	/** Whether a composition window is open (an IME composition, or a native edit being read back). */
	get composing(): boolean {
		return this.#window.open;
	}

	get frozen(): boolean {
		return this.#frozen;
	}

	get selectionStart(): number {
		const { anchor, focus } = this.#selection();
		return Math.min(anchor, focus);
	}

	get selectionEnd(): number {
		const { anchor, focus } = this.#selection();
		return Math.max(anchor, focus);
	}

	get selectionDirection(): "forward" | "backward" | "none" {
		const { anchor, focus } = this.#selection();
		return anchor === focus ? "none" : anchor < focus ? "forward" : "backward";
	}

	get hasFocus(): boolean {
		return this.#doc.activeElement === this.element;
	}

	/** The caret's row edges for the history arrow keys. */
	rowEdges(offset: number = this.selectionStart): CaretRowEdges {
		const lineHeight = parseFloat(this.#doc.defaultView?.getComputedStyle(this.element).lineHeight ?? "") || 20;
		return caretRowEdges(this.element, this.#text, offset, lineHeight);
	}

	// ---- the selection ---------------------------------------------------------------------------------------------

	/** The live DOM selection in model offsets, or `null` when it is not inside the field. */
	#domSelection(): { selection: SurfaceSelection; atRoot: boolean } | null {
		const selection = this.#doc.getSelection();
		if (selection === null || selection.rangeCount === 0 || selection.anchorNode === null || selection.focusNode === null) return null;
		if (!this.element.contains(selection.anchorNode) || !this.element.contains(selection.focusNode)) return null;
		return {
			selection: {
				anchor: offsetOf(this.element, selection.anchorNode, selection.anchorOffset),
				focus: offsetOf(this.element, selection.focusNode, selection.focusOffset),
			},
			atRoot: selection.anchorNode === this.element || selection.focusNode === this.element,
		};
	}

	/** The selection now: the DOM's while it is inside the field and no window is open, the retained one otherwise. */
	#selection(): SurfaceSelection {
		if (this.#window.open) return this.#retained;
		const live = this.#domSelection();
		if (live === null) return this.#retained;
		return this.#clamp(live.selection);
	}

	#clamp(selection: SurfaceSelection): SurfaceSelection {
		const length = this.#text.length;
		return { anchor: Math.min(Math.max(0, selection.anchor), length), focus: Math.min(Math.max(0, selection.focus), length) };
	}

	/** Every chip of `text` (the draft by default): attachment markers and the command or skill the draft names. */
	#markers(text: string = this.#text): ChipSpan[] {
		return findChips(text, (kind, number, name) => this.#options.isKnownReference(kind, number, name), name => this.#options.resolveCommand(name));
	}

	/** The chips an edit removes whole: every chip except a bare command chip, which is still being typed and so is deleted and cut into like text. */
	#atomic(text: string = this.#text): ChipSpan[] {
		return this.#markers(text).filter(span => !isBareChip(span));
	}

	#writeDomSelection(selection: SurfaceSelection): void {
		if (this.#window.open || !this.hasFocus) return;
		const anchor = locate(this.element, selection.anchor);
		const focus = selection.anchor === selection.focus ? anchor : locate(this.element, selection.focus);
		this.#doc.getSelection()?.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
	}

	setSelectionRange(start: number, end: number, direction: "forward" | "backward" | "none" = "none"): void {
		const clamped = this.#clamp(direction === "backward" ? { anchor: end, focus: start } : { anchor: start, focus: end });
		this.#retained = clamped;
		this.#writeDomSelection(clamped);
		if (this.hasFocus) this.#ensureVisible();
	}

	/** Focuses the field and puts the selection back where it was (a bare `focus()` would put the caret at the start). */
	focus(): void {
		this.element.focus({ preventScroll: true });
		if (this.#window.open) return;
		this.#writeDomSelection(this.#retained);
	}

	/** Keeps the caret inside the scrollport after a programmatic or editing move. */
	#ensureVisible(): void {
		if (this.#window.open) return;
		const { focus } = this.#selection();
		const point = locate(this.element, focus);
		const range = this.#doc.createRange();
		range.setStart(point.node, point.offset);
		range.collapse(true);
		let rect: DOMRect | undefined = Array.from(range.getClientRects()).find(candidate => candidate.height > 0);
		if (rect === undefined) {
			const line = this.element.children[Math.max(0, lineIndexOf(this.element, point.node))];
			rect = line?.getBoundingClientRect();
		}
		if (rect === undefined) return;
		const box = this.element.getBoundingClientRect();
		const padding = 6;
		if (rect.bottom > box.bottom - padding) this.element.scrollTop += rect.bottom - box.bottom + padding;
		else if (rect.top < box.top + padding) this.element.scrollTop -= box.top + padding - rect.top;
	}

	// ---- rendering -------------------------------------------------------------------------------------------------

	#render(replace: ReadonlySet<number> | true = new Set()): void {
		const blocks = findFencedBlocks(this.#text);
		this.#renderer.render(lineSpecs(this.#text, blocks, this.#markers(), findQuoteRuns(this.#text, blocks).lines), replace);
		if (!this.#window.open) this.element.setAttribute("data-empty", String(this.#text === ""));
	}

	/**
	 * Re-renders after the chips of the draft may have changed (an attachment was attached or released, the catalogue of commands
	 * changed: a marker may have become text, or text a chip). The selection is read before the lines are replaced and written
	 * back after, snapped off any chip that now covers it, so a caret never jumps because the field was redrawn under it.
	 */
	refresh(): void {
		if (this.#window.open || this.#disposed) return;
		const before = this.#selection();
		this.#render();
		const snapped = snapSelection(this.#markers(), Math.min(before.anchor, before.focus), Math.max(before.anchor, before.focus), null);
		this.#retained = this.#clamp(before.focus < before.anchor ? { anchor: snapped.end, focus: snapped.start } : { anchor: snapped.start, focus: snapped.end });
		this.#writeDomSelection(this.#retained);
	}

	/** The rectangle of line `index`, `null` past the last line. Read-only: an overlay beside the field places itself by it and never writes into the field. */
	lineRect(index: number): DOMRect | null {
		return this.element.children[index]?.getBoundingClientRect() ?? null;
	}

	#applyConfig(config: SurfaceConfig): void {
		this.#config = config;
		const element = this.element;
		const set = (name: string, value: string | null): void => {
			if (value === null) element.removeAttribute(name);
			else element.setAttribute(name, value);
		};
		set("aria-disabled", config.editable ? null : "true");
		set("contenteditable", config.editable && !this.#frozen ? "true" : "false");
		set("aria-readonly", this.#frozen ? "true" : null);
		set("tabindex", this.#frozen ? "-1" : null);
		set("aria-label", config.placeholder);
		set("data-placeholder", config.placeholder);
		set("aria-describedby", config.describedBy);
		set("aria-controls", config.controls);
		set("aria-activedescendant", config.activeDescendant);
	}

	/** Writes the attributes the surface owns. Inside a composition window they wait for its end, except turning the field off. */
	configure(config: SurfaceConfig): void {
		if (this.#disposed) return;
		if (!this.#window.open) {
			this.#applyConfig(config);
			return;
		}
		if (this.#config.editable && !config.editable) {
			this.element.setAttribute("contenteditable", "false");
			this.#window.queuedConfig = config;
			this.#closeWindow();
			return;
		}
		this.#window.queuedConfig = config;
	}

	/** The draft handoff reads the draft: from now every way of changing it refuses, until {@link thaw}. */
	freeze(): void {
		if (this.#window.open) this.#closeWindow();
		this.#frozen = true;
		this.#applyConfig(this.#config);
	}

	thaw(): void {
		this.#frozen = false;
		this.#applyConfig(this.#config);
		this.#writeDomSelection(this.#retained);
	}

	// ---- writes ----------------------------------------------------------------------------------------------------

	#snapshot(): DraftSnapshot {
		const { anchor, focus } = this.#selection();
		return { text: this.#text, anchor, focus };
	}

	#commit(next: string, selection: SurfaceSelection, kind: EditKind): void {
		this.#history.record(this.#snapshot(), kind, selection.focus, performance.now());
		this.#text = next;
		this.#render();
		this.#retained = this.#clamp(selection);
		this.#writeDomSelection(this.#retained);
		this.#ensureVisible();
		this.#options.onEdit(next);
	}

	/**
	 * One edit of the draft: records the undo step, updates the line elements, puts the selection where the edit says and
	 * reports the new text. Refuses (`false`) while the draft is frozen or a composition window is open; the caller defers.
	 * An edit without a `selection` also widens over any marker it cuts into, so a marker is only ever removed whole.
	 */
	apply(edit: SurfaceEdit, kind: EditKind = "replace"): boolean {
		if (this.#frozen || this.#window.open || this.#disposed) return false;
		const text = this.#text;
		let from = Math.min(Math.max(0, edit.from), text.length);
		let to = Math.min(Math.max(from, edit.to), text.length);
		if (edit.selection === undefined) {
			for (const marker of this.#atomic()) {
				if (from > marker.start && from < marker.end) from = marker.start;
				if (to > marker.start && to < marker.end) to = marker.end;
			}
		}
		const next = text.slice(0, from) + edit.insert + text.slice(to);
		const caret = from + edit.insert.length;
		this.#commit(next, edit.selection ?? { anchor: caret, focus: caret }, kind);
		return true;
	}

	/** An undoable replacement of `[from, to)`, with the caret after the inserted text. */
	replaceRange(from: number, to: number, insert: string, kind: EditKind = "replace"): boolean {
		return this.apply({ from, to, insert }, kind);
	}

	/** Removes several ranges as one undo step, leaving the caret where the first one was. */
	removeRanges(ranges: readonly { from: number; to: number }[]): boolean {
		if (this.#frozen || this.#window.open || this.#disposed || ranges.length === 0) return false;
		let next = this.#text;
		for (const range of [...ranges].sort((a, b) => b.from - a.from)) next = next.slice(0, range.from) + next.slice(range.to);
		const caret = Math.min(...ranges.map(range => range.from));
		this.#commit(next, { anchor: caret, focus: caret }, "replace");
		return true;
	}

	/** Puts the draft the composer decided on into the surface. `history` is stated by the caller, never guessed from the text. */
	setText(text: string, options: { caret?: number; history: HistoryMode }): void {
		if (this.#disposed || this.#frozen) return;
		if (this.#window.open) {
			const queued = this.#window.queuedText;
			this.#window.queuedText = { text, caret: options.caret, history: queued?.history === "reset" ? "reset" : options.history };
			return;
		}
		this.#setTextNow(text, options.caret, options.history);
	}

	#setTextNow(text: string, caret: number | undefined, history: HistoryMode): void {
		const changed = text !== this.#text;
		if (history === "reset") this.#history.reset();
		else if (changed) this.#history.record(this.#snapshot(), "external", caret ?? text.length, performance.now());
		this.#text = text;
		this.#render();
		if (changed || caret !== undefined) {
			const place = Math.min(Math.max(0, caret ?? text.length), text.length);
			this.#retained = { anchor: place, focus: place };
			this.#writeDomSelection(this.#retained);
			if (this.hasFocus) this.#ensureVisible();
		} else {
			this.#retained = this.#clamp(this.#retained);
		}
	}

	/** The draft when the surface is created, with no history and no report. */
	seed(text: string): void {
		this.#text = text;
		this.#render();
		this.#retained = { anchor: text.length, focus: text.length };
	}

	undo(): boolean {
		return this.#travel("undo");
	}

	redo(): boolean {
		return this.#travel("redo");
	}

	#travel(direction: "undo" | "redo"): boolean {
		if (this.#frozen || this.#window.open || this.#disposed) return false;
		const current = this.#snapshot();
		const target = direction === "undo" ? this.#history.undo(current) : this.#history.redo(current);
		if (target === null) return false;
		this.#text = target.text;
		this.#render();
		this.#retained = this.#clamp({ anchor: target.anchor, focus: target.focus });
		this.#writeDomSelection(this.#retained);
		this.#ensureVisible();
		this.#options.onEdit(this.#text);
		return true;
	}

	// ---- input -----------------------------------------------------------------------------------------------------

	#defer(run: () => void): void {
		this.#window.deferred.push(run);
	}

	#insert(text: string, kind: EditKind, at?: number): void {
		const { start, end } = at === undefined ? { start: this.selectionStart, end: this.selectionEnd } : { start: at, end: at };
		// Pasted, dropped and multi-character text that holds a line break stays in the quote it lands in (quote-edits.ts, quotePasteEdit).
		const quoted = kind === "paste" && text.includes("\n") ? quotePasteEdit(this.#text, findQuoteRuns(this.#text, findFencedBlocks(this.#text)), text, start, end) : null;
		this.apply(quoted === null ? { from: start, to: end, insert: text } : { from: quoted.from, to: quoted.to, insert: quoted.insert }, kind);
	}

	#onBeforeInput(event: InputEvent): void {
		if (this.#window.open || event.isComposing) {
			// The browser owns the DOM until the window settles.
			if (!this.#window.open) this.#openWindow();
			return;
		}
		if (!event.cancelable) {
			// A native edit the page cannot refuse: read it back after it lands; never also apply it to the model.
			this.#openWindow();
			this.#scheduleSettle();
			return;
		}
		event.preventDefault();
		if (this.#frozen) return;
		const type = event.inputType;
		if (type === "insertText") {
			const data = event.data ?? event.dataTransfer?.getData("text/plain") ?? "";
			if (data.length > 0) this.#insert(normalizeLineEndings(data), [...data].length === 1 && data !== "\n" ? "type" : "paste");
			return;
		}
		if (type === "insertLineBreak" || type === "insertParagraph") {
			this.#insert("\n", "newline");
			return;
		}
		if (type === "insertReplacementText") {
			const data = event.dataTransfer?.getData("text/plain") ?? event.data ?? "";
			const target = this.#targetRange(event);
			if (data.length > 0) this.apply({ from: target?.from ?? this.selectionStart, to: target?.to ?? this.selectionEnd, insert: normalizeLineEndings(data) }, "replace");
			return;
		}
		const kind = DELETE_KINDS[type];
		if (kind !== undefined) {
			this.#delete(event, kind, type === "deleteByCut" ? "cut" : "delete");
			return;
		}
		// historyUndo / historyRedo (the keyboard drives undo), insertFromPaste/Drop (the paste and drop events do), formatting and the rest: ignored.
	}

	#targetRange(event: InputEvent): { from: number; to: number } | null {
		const ranges = typeof event.getTargetRanges === "function" ? event.getTargetRanges() : [];
		const range = ranges[0];
		if (range === undefined || !this.element.contains(range.startContainer) || !this.element.contains(range.endContainer)) return null;
		const from = offsetOf(this.element, range.startContainer, range.startOffset);
		const to = offsetOf(this.element, range.endContainer, range.endOffset);
		return from <= to ? { from, to } : { from: to, to: from };
	}

	#delete(event: InputEvent, kind: DeleteKind, edit: EditKind): void {
		const native = this.#targetRange(event);
		// The browser takes a non-editable chip whole; a bare command chip is text being typed, so one character goes instead and the chip reverts to text.
		const bare = this.#markers().find(span => isBareChip(span) && native !== null && span.start === native.from && span.end === native.to);
		const range = native !== null && native.from !== native.to && (bare === undefined || (kind !== "char-back" && kind !== "char-fwd")) ? native : deletionTarget(this.#text, this.selectionStart, this.selectionEnd, kind);
		if (range === null) return;
		const widened = deletionRange(this.#atomic(), range.from, range.to, "range");
		this.apply({ from: widened?.start ?? range.from, to: widened?.end ?? range.to, insert: "" }, edit);
	}

	/** A native edit the page did not intercept (an `execCommand`, a stray input): read it back through the same window. */
	#onInput(): void {
		if (this.#window.open || this.#disposed) return;
		this.#openWindow();
		this.#closeWindow();
	}

	#onKeyDown(event: KeyboardEvent): void {
		if (event.isComposing || this.#window.open || event.keyCode === 229) return;
		const modifier = event.ctrlKey || event.metaKey;
		if (modifier && !event.altKey) {
			const z = isPhysicalKey(event, "KeyZ");
			if (z && !event.shiftKey) {
				event.preventDefault();
				this.undo();
				return;
			}
			if (isPhysicalKey(event, "KeyY") || (z && event.shiftKey)) {
				event.preventDefault();
				this.redo();
				return;
			}
		}
		this.#options.onKeyDown(event);
	}

	#onPaste(event: ClipboardEvent): void {
		if (this.#options.handlePaste(event)) {
			event.preventDefault();
			return;
		}
		event.preventDefault();
		if (this.#frozen) return;
		const text = normalizeLineEndings(event.clipboardData?.getData("text/plain") ?? "");
		if (text.length === 0) return;
		if (this.#window.open) this.#defer(() => this.#insert(text, "paste"));
		else this.#insert(text, "paste");
	}

	#onCopy(event: ClipboardEvent): void {
		if (this.#window.open) return;
		const start = this.selectionStart;
		const end = this.selectionEnd;
		if (start === end) return;
		event.preventDefault();
		event.clipboardData?.setData("text/plain", this.#text.slice(start, end));
	}

	/** VS Code delivers Cut as `execCommand('cut')`: a `cut` event and no `beforeinput`, so the page deletes the selection itself. */
	#onCut(event: ClipboardEvent): void {
		if (this.#window.open && !this.#frozen) {
			const start = this.selectionStart;
			const end = this.selectionEnd;
			if (start === end) return;
			event.preventDefault();
			event.clipboardData?.setData("text/plain", this.#text.slice(start, end));
			this.#defer(() => { this.apply({ from: this.selectionStart, to: this.selectionEnd, insert: "" }, "cut"); });
			return;
		}
		const start = this.selectionStart;
		const end = this.selectionEnd;
		if (start === end) return;
		event.preventDefault();
		if (this.#frozen) return;
		event.clipboardData?.setData("text/plain", this.#text.slice(start, end));
		this.apply({ from: start, to: end, insert: "" }, "cut");
	}

	#onDrop(event: DragEvent): void {
		const transfer = event.dataTransfer;
		if (transfer === null || this.#options.isAttachmentDrag(transfer)) return;
		const text = normalizeLineEndings(transfer.getData("text/plain"));
		if (text.length === 0) return;
		event.preventDefault();
		if (this.#frozen) return;
		const at = this.#offsetAtPoint(event.clientX, event.clientY);
		const run = (): void => this.#insert(text, "paste", at ?? this.#text.length);
		if (this.#window.open) this.#defer(run);
		else run();
	}

	#offsetAtPoint(x: number, y: number): number | null {
		const doc = this.#doc as Document & { caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null; caretRangeFromPoint?(x: number, y: number): Range | null };
		let node: Node | null = null;
		let offset = 0;
		const position = doc.caretPositionFromPoint?.(x, y);
		if (position !== undefined && position !== null) ({ offsetNode: node, offset } = position);
		else {
			const range = doc.caretRangeFromPoint?.(x, y);
			if (range !== undefined && range !== null) ({ startContainer: node, startOffset: offset } = range);
		}
		if (node === null || !this.element.contains(node)) return null;
		const at = offsetOf(this.element, node, offset);
		const snapped = snapSelection(this.#markers(), at, at, null);
		return snapped.start;
	}

	// ---- the composition window ------------------------------------------------------------------------------------

	#openWindow(): void {
		const window = this.#window;
		if (window.open || this.#disposed) return;
		const live = this.#domSelection();
		const selection = live === null ? this.#retained : this.#clamp(live.selection);
		window.open = true;
		window.pre = { text: this.#text, anchor: selection.anchor, focus: selection.focus };
		window.preLines = this.#text.split("\n");
		window.touched = [];
		this.#retained = selection;
		const focusNode = this.#doc.getSelection()?.focusNode;
		const line = focusNode === null || focusNode === undefined ? -1 : lineIndexOf(this.element, focusNode);
		if (line >= 0) window.touched.push(this.element.children[line]!);
		this.element.setAttribute("data-empty", "false");
		this.#options.onWindowOpen();
	}

	#onCompositionStart(): void {
		if (this.#frozen) return;
		this.#openWindow();
		this.#compositionActive = true;
	}

	#onCompositionEnd(): void {
		this.#compositionActive = false;
		if (this.#window.open) this.#scheduleSettle();
	}

	#scheduleSettle(): void {
		if (this.#settleTimer !== null) return;
		const view = this.#doc.defaultView;
		if (view === null) return;
		this.#settleTimer = view.setTimeout(() => {
			this.#settleTimer = null;
			if (this.#window.open && !this.#compositionActive) this.#closeWindow();
		}, 0);
	}

	#onFocusOut(): void {
		if (this.#window.open) this.#closeWindow();
	}

	#onFocus(): void {
		if (this.#pointerDown) return;
		queueMicrotask(() => {
			if (this.#disposed || this.#window.open || !this.hasFocus) return;
			const live = this.#domSelection();
			// A programmatic or keyboard focus puts the caret at the start of the draft; the retained selection goes back.
			if (live !== null && live.selection.anchor === 0 && live.selection.focus === 0 && (this.#retained.anchor !== 0 || this.#retained.focus !== 0)) this.#writeDomSelection(this.#retained);
		});
	}

	#onPointerUp(): void {
		if (!this.#pointerDown) return;
		this.#pointerDown = false;
		if (this.#window.open) return;
		const live = this.#domSelection();
		if (live === null) return;
		this.#snapAndRetain(live, true);
		this.#options.onSelection();
	}

	#onSelectionChange(): void {
		if (this.#disposed) return;
		if (this.#window.open) {
			const focusNode = this.#doc.getSelection()?.focusNode;
			if (focusNode !== null && focusNode !== undefined) {
				const line = lineIndexOf(this.element, focusNode);
				const element = line >= 0 ? this.element.children[line] : undefined;
				if (element !== undefined && !this.#window.touched.includes(element)) this.#window.touched.push(element);
			}
			return;
		}
		const live = this.#domSelection();
		if (live === null) return;
		if (this.#pointerDown) {
			this.#retained = this.#clamp(live.selection);
			return;
		}
		this.#snapAndRetain(live, false);
		this.#options.onSelection();
	}

	/** Moves selection edges that rest inside a marker to its edge (a caret hops in its direction of travel) and keeps the selection off the root. */
	#snapAndRetain(live: { selection: SurfaceSelection; atRoot: boolean }, pointer: boolean): void {
		const clamped = this.#clamp(live.selection);
		const start = Math.min(clamped.anchor, clamped.focus);
		const end = Math.max(clamped.anchor, clamped.focus);
		const previousStart = Math.min(this.#retained.anchor, this.#retained.focus);
		const forward = pointer || start !== end || start === previousStart ? null : start > previousStart;
		const next = snapSelection(this.#markers(), start, end, forward);
		const backward = clamped.focus < clamped.anchor;
		const snapped: SurfaceSelection = backward ? { anchor: next.end, focus: next.start } : { anchor: next.start, focus: next.end };
		this.#retained = snapped;
		if (live.atRoot || snapped.anchor !== clamped.anchor || snapped.focus !== clamped.focus) this.#writeDomSelection(snapped);
	}

	/**
	 * Closes the composition window: reads the DOM back into the draft, records one undo step, replaces the line elements the
	 * browser touched (so its own undo stack is left pointing only at detached nodes), restores the selection, and then runs
	 * what waited for it. Also runs on `focusout`, when the field is turned off and on dispose.
	 */
	#closeWindow(): void {
		const window = this.#window;
		if (!window.open) return;
		if (this.#settleTimer !== null) {
			this.#doc.defaultView?.clearTimeout(this.#settleTimer);
			this.#settleTimer = null;
		}
		this.#compositionActive = false;
		const element = this.element;
		const domText = readText(element);
		const live = this.#domSelection();
		const lines = Array.from(element.children);
		let replace: ReadonlySet<number> | true;
		if (lines.length !== window.preLines.length || element.childNodes.length !== element.children.length) replace = true;
		else {
			const dirty = new Set<number>();
			lines.forEach((line, index) => {
				if (lineTextOf(line) !== window.preLines[index]) dirty.add(index);
			});
			for (const touched of window.touched) {
				const index = lines.indexOf(touched);
				if (index >= 0) dirty.add(index);
			}
			replace = dirty;
		}
		const { pre, queuedText, queuedConfig, deferred } = window;
		this.#window = emptyWindow();
		let reported = false;
		if (queuedText !== null) {
			// The composed text never reaches the model: an explicit write replaces it.
			this.#render(replace);
			this.#setTextNow(queuedText.text, queuedText.caret, queuedText.history);
		} else {
			let next = domText;
			let selection: SurfaceSelection = live === null
				? { anchor: Math.min(pre.focus + next.length - pre.text.length, next.length), focus: Math.min(pre.focus + next.length - pre.text.length, next.length) }
				: live.selection;
			const damaged = this.#atomic(pre.text);
			const repaired = repairDamagedReferences(pre.text, next, damaged);
			if (repaired !== null) {
				next = repaired.text;
				selection = { anchor: repaired.caret, focus: repaired.caret };
			}
			if (next !== pre.text) {
				this.#history.record(pre, "composition", selection.focus, performance.now());
				reported = true;
			}
			this.#text = next;
			this.#render(replace);
			this.#retained = this.#clamp(selection);
			this.#writeDomSelection(this.#retained);
			this.#ensureVisible();
		}
		this.#applyConfig(queuedConfig ?? this.#config);
		if (reported) this.#options.onEdit(this.#text);
		for (const run of deferred) run();
		this.#options.onSettled();
	}

	/** Settles any open window and releases every listener. Runs before React removes the element, so the read-back still has its DOM. */
	dispose(): void {
		if (this.#disposed) return;
		if (this.#window.open) this.#closeWindow();
		this.#disposed = true;
		for (const [target, type, handler, capture] of this.#listeners) target.removeEventListener(type, handler, capture);
		this.#listeners.length = 0;
	}

	/** The total number of characters the DOM shows; a test and debugging aid. */
	get renderedLength(): number {
		return textLength(this.element);
	}
}
