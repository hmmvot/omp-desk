/**
 * The composer surface's own undo and redo stack (docs/designs/2026-10-15-composer-contenteditable-surface.md, section 3).
 *
 * The browser's native undo cannot serve a surface whose nodes the page replaces, so every edit records a
 * snapshot of the draft and its selection before it is applied. Pure; the clock is passed in.
 */

export interface DraftSnapshot {
	readonly text: string;
	/** Selection anchor, as a model offset. */
	readonly anchor: number;
	/** Selection focus (the caret end), as a model offset. */
	readonly focus: number;
}

/** What kind of edit a step records; only `type` and `delete` ever merge into a previous step. */
export type EditKind = "type" | "delete" | "newline" | "paste" | "cut" | "block" | "marker" | "replace" | "external" | "composition" | "complete";

export interface DraftHistoryLimits {
	/** Most steps kept (oldest dropped first). */
	readonly steps: number;
	/** Most characters kept across all snapshots; the latest step always survives, even alone over the limit. */
	readonly characters: number;
	/** Consecutive typing or deleting less than this far apart merges into one step. */
	readonly mergeWindowMs: number;
}

export const DEFAULT_LIMITS: DraftHistoryLimits = { steps: 200, characters: 2_000_000, mergeWindowMs: 1000 };

export class DraftHistory {
	readonly #limits: DraftHistoryLimits;
	#undo: DraftSnapshot[] = [];
	#redo: DraftSnapshot[] = [];
	#characters = 0;
	#lastKind: EditKind | null = null;
	#lastTime = 0;
	#lastCaret = -1;

	constructor(limits: DraftHistoryLimits = DEFAULT_LIMITS) {
		this.#limits = limits;
	}

	get canUndo(): boolean {
		return this.#undo.length > 0;
	}

	get canRedo(): boolean {
		return this.#redo.length > 0;
	}

	/**
	 * Records the draft as it was before an edit of `kind` that leaves the caret at `caretAfter`. Typing and deleting
	 * merge into the previous step while they continue at the caret it left, less than the merge window apart; every other
	 * kind is a step of its own. A new edit clears the redo stack.
	 */
	record(before: DraftSnapshot, kind: EditKind, caretAfter: number, now: number): void {
		const mergeable = (kind === "type" || kind === "delete") && kind === this.#lastKind && before.anchor === before.focus
			&& before.focus === this.#lastCaret && now - this.#lastTime < this.#limits.mergeWindowMs && this.#undo.length > 0;
		if (!mergeable) {
			this.#undo.push(before);
			this.#characters += before.text.length;
			this.#trim();
		}
		this.#redo = [];
		this.#lastKind = kind;
		this.#lastTime = now;
		this.#lastCaret = caretAfter;
	}

	/** The state to return to, given the current one (which becomes redoable), or `null` when there is nothing to undo. */
	undo(current: DraftSnapshot): DraftSnapshot | null {
		const step = this.#undo.pop();
		if (step === undefined) return null;
		this.#characters -= step.text.length;
		this.#redo.push(current);
		this.#lastKind = null;
		return step;
	}

	/** The state to return to after an undo, given the current one (which becomes undoable), or `null`. */
	redo(current: DraftSnapshot): DraftSnapshot | null {
		const step = this.#redo.pop();
		if (step === undefined) return null;
		this.#undo.push(current);
		this.#characters += current.text.length;
		this.#lastKind = null;
		return step;
	}

	/** Forgets every step: the draft was consumed or replaced by something the old text must not be restorable over. */
	reset(): void {
		this.#undo = [];
		this.#redo = [];
		this.#characters = 0;
		this.#lastKind = null;
	}

	#trim(): void {
		let drop = 0;
		let characters = this.#characters;
		const size = this.#undo.length;
		while (size - drop > 1 && (size - drop > this.#limits.steps || characters > this.#limits.characters)) {
			characters -= this.#undo[drop]!.text.length;
			drop++;
		}
		if (drop > 0) {
			this.#undo.splice(0, drop);
			this.#characters = characters;
		}
	}
}
