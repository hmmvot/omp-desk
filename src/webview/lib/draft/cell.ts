/**
 * The cell: the one place that holds the Draft value and decides when a change may be written to the field
 * (docs/designs/2026-10-23-composer-draft-module.md, section 3). It is plain TypeScript with no React and no DOM; React reads it with
 * `useSyncExternalStore` (`getState`, `subscribe`), and the field is reached only through a {@link FieldPort}, so the timing rules
 * (a composition window, the hand-off of ADR-0050) are tested in node.
 *
 * The revision keeps its old meaning exactly, and `commit` is the only place that raises it for a change: once for a change that carries
 * a `text`, `edit` or `remove` write (an `edit` applied to the value alone while no field is mounted included) or whose image list or
 * document list differs, and in the cell for `windowOpened()` and a user `edited()`. It does not rise for reads in flight, reservations,
 * the in-flight message, recovery cards, the history walk, lost images, a change of `next`, a `caret` write, or the echo of the cell's own
 * surface write, which only reconciles the text.
 */
import type { DraftHandoffContent } from "../../../protocol/messages.ts";
import type { Change, FieldPort, Op, Outcome, Timing, Write } from "./field.ts";
import { captureOf } from "./handoff.ts";
import { emptyDraft, type Draft } from "./value.ts";

/** What React reads. A new object only when something in it changed, so `useSyncExternalStore` sees a stable reference. */
export interface DraftCellState {
	readonly draft: Draft;
	/** The caret offset, mirrored from the field after every edit, selection change and caret write. */
	readonly caret: number;
	/** The hand-off holds the draft: every change refuses until it is released. */
	readonly held: boolean;
}

export interface DraftCell {
	getState(): DraftCellState;
	subscribe(listener: () => void): () => void;
	/** The value now: what a rule judges, never a render's copy. */
	read(): Draft;
	/**
	 * Sets the value, then performs the writes in order through the port. A refused write restores the previous value and returns `false`;
	 * while the draft is held every change is refused (`false`, nothing written), a value-only one included.
	 */
	commit(change: Change): boolean;
	/**
	 * Runs `op` with the draft and selection as they are when it runs: at once, or after `settled()` or `release()` as `when` asks.
	 * `then` is called synchronously for a work that is dropped, skipped or refused and later for one that waited.
	 */
	perform<R>(op: Op<R>, when: Timing, then?: (outcome: Outcome<R>) => void): void;
	/** The field reports a text the surface applied: the echo of the cell's own write, or an edit of the user (which raises the revision). */
	edited(text: string): void;
	/** The field reports that a composition window opened: a composition is an edit. */
	windowOpened(): void;
	/** The field reports that the window closed: the draft is settled, so the work that waited for it runs, in arrival order, once. */
	settled(): void;
	/** The field reports that its selection moved. */
	moved(): void;
	/** The draft as the hand-off carries it, frozen until `release`; `null` while reads are in flight, a composition is open, work waits or a capture is held. */
	capture(requestId: number): DraftHandoffContent | null;
	/** Ends the capture `requestId`: thaws the field, runs the work that waited for it and resolves `held()`. `false` when it is not the held one. */
	release(requestId: number): boolean;
	/** Resolves when the held capture is released; `null` when none is held. */
	held(): Promise<void> | null;
	alive(): boolean;
	/** The component is gone: the work that waited is forgotten and nothing runs again. A later `release` still thaws the field and resolves `held()`. */
	dispose(): void;
}

export function createDraftCell(port: FieldPort): DraftCell {
	let draft = emptyDraft();
	let caret = 0;
	let hold: { readonly requestId: number; readonly released: Promise<void>; readonly release: () => void } | null = null;
	let isAlive = true;
	/** The cell's own write is in progress: the field's echo of it reconciles the text and does not count as an edit. */
	let writing = false;
	const deferred: (() => void)[] = [];
	const listeners = new Set<() => void>();
	let snapshot: DraftCellState = { draft, caret, held: false };
	let announced = snapshot;

	function getState(): DraftCellState {
		const held = hold !== null;
		if (snapshot.draft !== draft || snapshot.caret !== caret || snapshot.held !== held) snapshot = { draft, caret, held };
		return snapshot;
	}

	function announce(): void {
		if (!isAlive) return;
		const now = getState();
		if (now === announced) return;
		announced = now;
		for (const listener of [...listeners]) listener();
	}

	/** The caret the field has now; the one already known while no field is mounted. */
	function caretNow(): number {
		return port.mounted() ? port.selection().anchor : caret;
	}

	/** One write of a change. `false` is the field's refusal. */
	function write(next: Write, previousText: string): boolean {
		if (next.kind === "text") {
			if (port.mounted() && !port.write(next)) return false;
			const at = next.caret ?? (next.text !== previousText ? next.text.length : undefined);
			if (at !== undefined) caret = at;
			return true;
		}
		if (!port.mounted()) {
			// No field: the value alone changes. An edit still moves the caret after what it inserted; a removal and a caret move are dropped.
			if (next.kind === "edit") caret = next.edit.selection?.focus ?? next.edit.from + next.edit.insert.length;
			return true;
		}
		if (!port.write(next)) return false;
		// An edit and a removal echo through `edited`, which reads the caret; a caret write does not.
		if (next.kind === "caret") caret = caretNow();
		return true;
	}

	function commit(change: Change): boolean {
		if (!isAlive || hold !== null) return false;
		const before = draft;
		const caretBefore = caret;
		const after = change.draft;
		const raises = change.writes.some(next => next.kind !== "caret") || after.images !== before.images || after.documents !== before.documents;
		const revision = before.revision + (raises ? 1 : 0);
		// A change that sets the latch of an unedited refill stores the revision it produced.
		draft = { ...after, revision, unedited: after.unedited !== null && after.unedited !== before.unedited ? revision : after.unedited };
		writing = true;
		try {
			for (const next of change.writes) {
				if (write(next, before.text)) continue;
				draft = before;
				caret = caretBefore;
				announce();
				return false;
			}
		} finally {
			writing = false;
		}
		announce();
		return true;
	}

	function flush(): void {
		for (const run of deferred.splice(0)) run();
	}

	function perform<R>(op: Op<R>, when: Timing, then?: (outcome: Outcome<R>) => void): void {
		const attempt = (): void => {
			if (!isAlive) return;
			if (port.composing()) {
				if (when.composing === "wait") {
					deferred.push(attempt);
					return;
				}
				if (when.composing === "skip") {
					then?.({ kind: "dropped" });
					return;
				}
			}
			if (hold !== null) {
				if (when.held === "wait") {
					deferred.push(attempt);
					return;
				}
				then?.({ kind: "dropped" });
				return;
			}
			const mounted = port.mounted();
			const selection = mounted ? port.selection() : { anchor: draft.text.length, focus: draft.text.length };
			const produced = op(draft, { selection, mounted });
			if (produced === null) {
				then?.({ kind: "dropped" });
				return;
			}
			const applied = produced.change === null || commit(produced.change);
			then?.({ kind: applied ? "applied" : "refused", result: produced.result });
		};
		attempt();
	}

	return {
		getState,
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		read: () => draft,
		commit,
		perform,
		edited(text) {
			if (!isAlive) return;
			if (writing) {
				draft = { ...draft, text };
				caret = caretNow();
				return;
			}
			draft = { ...draft, text, revision: draft.revision + 1 };
			caret = caretNow();
			announce();
		},
		windowOpened() {
			if (!isAlive) return;
			draft = { ...draft, revision: draft.revision + 1 };
			announce();
		},
		settled() {
			if (!isAlive) return;
			caret = caretNow();
			port.redraw();
			flush();
			announce();
		},
		moved() {
			if (!isAlive) return;
			caret = caretNow();
			announce();
		},
		capture(requestId) {
			if (!isAlive || draft.reading > 0 || port.composing() || deferred.length > 0 || hold !== null) return null;
			const content = captureOf(draft);
			const { promise, resolve } = Promise.withResolvers<void>();
			hold = { requestId, released: promise, release: resolve };
			port.freeze();
			announce();
			return content;
		},
		release(requestId) {
			const current = hold;
			if (current === null || current.requestId !== requestId) return false;
			port.thaw();
			hold = null;
			announce();
			if (isAlive) flush();
			current.release();
			return true;
		},
		held: () => hold?.released ?? null,
		alive: () => isAlive,
		dispose() {
			isAlive = false;
			deferred.length = 0;
		},
	};
}
