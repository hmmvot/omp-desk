/**
 * What the Draft says to the field that shows it, and what it asks of that field (docs/designs/2026-10-23-composer-draft-module.md,
 * sections 1 and 3). A {@link Write} is data, never a callback: the cell performs it through a {@link FieldPort}, and the real port
 * (`lib/draft-write.ts`) turns it into calls of the surface (ADR-0077), so the Draft needs no DOM and a test needs no browser.
 */
import type { Draft } from "./value.ts";

/** The selection as model offsets; `focus` is the caret end. */
export interface Selection {
	readonly anchor: number;
	readonly focus: number;
}

/** What kind of edit an undo step records; only `type` and `delete` ever merge into a previous step. */
export type EditKind = "type" | "delete" | "newline" | "paste" | "cut" | "block" | "marker" | "replace" | "external" | "composition" | "complete";

/** How a write from outside the surface treats the undo stack: one more step, or a fresh start. */
export type HistoryMode = "record" | "reset";

/** One replacement of `[from, to)`. Without a `selection` the caret rests after the inserted text and the field widens the edit over a marker it cuts into. */
export interface FieldEdit {
	readonly from: number;
	readonly to: number;
	readonly insert: string;
	readonly selection?: Selection;
}

/** What the field must do. `focus` says whether the field takes the focus first. */
export type Write =
	| { readonly kind: "text"; readonly text: string; readonly caret?: number; readonly history: HistoryMode; readonly focus: boolean }
	| { readonly kind: "edit"; readonly edit: FieldEdit; readonly as: EditKind; readonly focus: boolean }
	| { readonly kind: "remove"; readonly ranges: readonly { readonly from: number; readonly to: number }[]; readonly focus: boolean }
	| { readonly kind: "caret"; readonly at: number; readonly focus: boolean };

/**
 * The new value and what the field must do for it. A change has at most one refusable write and it comes first (`edit` and `remove`
 * while the field is frozen or composing, `text` while it is frozen); every later write is a `caret` move, which is never refused.
 */
export interface Change {
	readonly draft: Draft;
	readonly writes: readonly Write[];
}

/**
 * An operation as the cell runs it: the draft as it is at that moment and the field's selection then (the end of the text when no
 * field is mounted, with `mounted: false`). `null` is nothing to do; `change: null` is something done that changes nothing.
 */
export type Op<R> = (draft: Draft, at: { readonly selection: Selection; readonly mounted: boolean }) => { readonly change: Change | null; readonly result: R } | null;

/** What a writer asks while a composition window is open and while the hand-off holds the draft (the table of *Current State*). */
export interface Timing {
	readonly composing: "wait" | "skip" | "now";
	readonly held: "wait" | "drop";
}

export type Outcome<R> =
	| { readonly kind: "applied"; readonly result: R }
	| { readonly kind: "refused"; readonly result: R }
	| { readonly kind: "dropped" };

/** The field behind the cell: the second seam. The real one is `lib/draft-write.ts` over `DraftSurface`; a test has its own. */
export interface FieldPort {
	/** A field is attached. */
	mounted(): boolean;
	/** A composition window is open: the browser owns the field's DOM. */
	composing(): boolean;
	/** The field's selection (`anchor` is the start, `focus` the end); meaningful only while mounted. */
	selection(): Selection;
	/** Performs one write; `false` is a refusal (a frozen or composing field). Never called while no field is mounted. */
	write(write: Write): boolean;
	/** Draws the field again: its rules (the attachments, the catalogue) changed under it. */
	redraw(): void;
	/** The hand-off holds the draft: every way of changing it refuses until {@link thaw}. A freeze received while no field is attached applies when one mounts. */
	freeze(): void;
	thaw(): void;
}
