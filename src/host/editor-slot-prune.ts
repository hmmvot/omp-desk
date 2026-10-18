/**
 * OMP Desk — dropping the passive editor-slot bindings of editors that were closed (2026-10-17 amendment to ADR-0025,
 * 2026-10-19 completion).
 *
 * A binding is how a restored editor finds its conversation, and VS Code revives a background tab's webview only when the
 * tab is shown, possibly in another window long after the binding was written. A binding of a closed editor can therefore
 * only go when the one window that held the editor saw it close and every other live window confirms it holds no editor
 * with that slot id. Nothing else is evidence: a binding of an editor this window never held may belong to a window that
 * is closed (VS Code restores it with its tabs), starting (not yet published) or opening it right now.
 *
 * {@link EditorSlotWatch} is this window's memory of the slot ids it has held an editor for, kept in the window's own
 * local store so that a reload does not forget an editor that closed just before it. {@link EditorSlotPruner} decides, on
 * every heartbeat, which of them may go: the editor has been absent for a whole settle interval, every other live window
 * has published since it vanished, none of them lists the slot id, and the binding is passive (a controlling binding is
 * what broker provenance and a recorded stop read for a conversation that runs without an editor, so it stays until a
 * later controller demotes it).
 *
 * This module is VS Code–free: the editor membership, the registry, the index and the clock are injected.
 */

import { isEditorSlotId } from "./editor-slots.ts";
import type { OtherWindowsSnapshot } from "./window-registry.ts";

/** Local-store key of the slot ids this window has held an editor for and not yet settled. */
export const EDITOR_SLOT_WATCH_KEY = "omp.editorSlotWatch.v1";
/** An editor must be gone this long before its binding is considered: two registry heartbeats, so every live window has published since. */
export const EDITOR_SLOT_SETTLE_MS = 30_000;
/** What a window remembers: a bound on the local record, not a limit a real window reaches. */
const MAX_TRACKED = 1_024;
const WATCH_VERSION = 1;

/** The part of `vscode.Memento` the watch uses; `workspaceState` satisfies it. */
export interface EditorSlotWatchStore {
	get<T>(key: string): T | undefined;
	update(key: string, value: unknown): unknown;
}

/** A slot id whose editor has not been seen for a while, and since when. */
export interface AbsentSlot {
	readonly slotId: string;
	readonly absentSince: number;
}

/**
 * The slot ids this window has held an editor for since they were last settled, and for how long each has been absent.
 *
 * A slot id that was tracked by an earlier extension host starts absent *now*: whether its editor is still there is what
 * the first observation says, and a reload is not evidence that it closed.
 */
export class EditorSlotWatch {
	readonly #store: EditorSlotWatchStore;
	readonly #now: () => number;
	/** Every tracked slot id, with when it was first missed (`null` while its editor is present). */
	readonly #tracked = new Map<string, number | null>();

	constructor(options: { readonly store: EditorSlotWatchStore; readonly now?: () => number }) {
		this.#store = options.store;
		this.#now = options.now ?? Date.now;
		const now = this.#now();
		for (const slotId of this.#read()) this.#tracked.set(slotId, now);
	}

	/** The slot ids of the editors this window holds right now: tracks each, and starts the absence clock of every other tracked one. */
	observe(present: ReadonlySet<string>): void {
		const now = this.#now();
		let changed = false;
		for (const slotId of present) {
			if (!isEditorSlotId(slotId)) continue;
			if (!this.#tracked.has(slotId)) changed = true;
			this.#tracked.set(slotId, null);
		}
		for (const [slotId, absentSince] of this.#tracked) {
			if (present.has(slotId)) continue;
			if (absentSince === null) this.#tracked.set(slotId, now);
		}
		if (this.#tracked.size > MAX_TRACKED) {
			// The oldest absences first; a present editor is never dropped.
			const absent = [...this.#tracked].filter(([, since]) => since !== null).sort((left, right) => left[1]! - right[1]!);
			for (const [slotId] of absent) {
				if (this.#tracked.size <= MAX_TRACKED) break;
				this.#tracked.delete(slotId);
				changed = true;
			}
		}
		if (changed) this.#write();
	}

	/** The tracked slots whose editor has been absent for at least `settleMs`. */
	due(settleMs: number = EDITOR_SLOT_SETTLE_MS): AbsentSlot[] {
		const now = this.#now();
		const due: AbsentSlot[] = [];
		for (const [slotId, absentSince] of this.#tracked) {
			if (absentSince !== null && now - absentSince >= settleMs) due.push({ slotId, absentSince });
		}
		return due;
	}

	/** Stop tracking slot ids: their binding is gone or belongs to another window now. */
	forget(slotIds: Iterable<string>): void {
		let changed = false;
		for (const slotId of slotIds) if (this.#tracked.delete(slotId)) changed = true;
		if (changed) this.#write();
	}

	/** Every tracked slot id, in stable order. */
	tracked(): string[] {
		return [...this.#tracked.keys()].sort();
	}

	#read(): string[] {
		let raw: unknown;
		try {
			raw = this.#store.get<unknown>(EDITOR_SLOT_WATCH_KEY);
		} catch {
			return [];
		}
		if (typeof raw !== "object" || raw === null) return [];
		const record = raw as { version?: unknown; slots?: unknown };
		if (record.version !== WATCH_VERSION || !Array.isArray(record.slots)) return [];
		return record.slots.filter(isEditorSlotId).slice(0, MAX_TRACKED);
	}

	#write(): void {
		try {
			// A failed write costs a binding that stays until a later observation of its editor: nothing depends on it.
			void Promise.resolve(this.#store.update(EDITOR_SLOT_WATCH_KEY, { version: WATCH_VERSION, slots: this.tracked() })).catch(() => {});
		} catch {
			// A store that throws synchronously is the same case.
		}
	}
}

/** What one pass did, for the log and the tests. */
export interface SlotPruneReport {
	/** Why nothing was decided, or `null` when the pass reached a decision about every due slot. */
	readonly held: string | null;
	readonly dropped: readonly string[];
	/** Slots another live window lists: no longer this window's to prune. */
	readonly handedOver: readonly string[];
	/** Due slots left for a later pass (a controlling binding, or a window that has not published since). */
	readonly waiting: readonly string[];
}

/** The registry as the pruner reads it. */
export interface SlotPruneRegistry {
	readOtherWindows(): Promise<OtherWindowsSnapshot>;
}

/** The index as the pruner writes it. */
export interface SlotPruneIndex {
	dropClosedPassiveSlots(slotIds: readonly string[]): Promise<string[]>;
}

export interface EditorSlotPrunerOptions {
	readonly watch: EditorSlotWatch;
	/** The slot ids of the editors VS Code holds in this window right now, from the tab set. */
	readonly membership: () => ReadonlySet<string>;
	readonly registry: () => SlotPruneRegistry | undefined;
	readonly index: () => SlotPruneIndex | null;
	readonly settleMs?: number;
}

const NOTHING: SlotPruneReport = { held: null, dropped: [], handedOver: [], waiting: [] };

export class EditorSlotPruner {
	readonly #options: EditorSlotPrunerOptions;
	#running: Promise<SlotPruneReport> | null = null;
	#complete = false;

	constructor(options: EditorSlotPrunerOptions) {
		this.#options = options;
	}

	/**
	 * Whether the tab set is known to list every editor this window restored. At activation it may not yet (VS Code hands
	 * the window its restored tabs while the extension starts), and an incomplete set read as "no editor" would publish a
	 * false absence and mark every remembered slot gone: until the first heartbeat nothing is published about it and
	 * nothing is decided.
	 */
	get complete(): boolean {
		return this.#complete;
	}

	/** The tab set is complete from now on: the first heartbeat has passed (the window's registry calls this before it renews). */
	markComplete(): void {
		this.#complete = true;
	}

	/** Record which editors this window holds now. */
	observe(): void {
		this.#options.watch.observe(this.#options.membership());
	}

	/**
	 * Decide about the slots whose editor has been gone for a whole settle interval. One pass at a time: a call that finds
	 * one running returns that pass's report.
	 */
	run(): Promise<SlotPruneReport> {
		this.#running ??= this.#decide().finally(() => { this.#running = null; });
		return this.#running;
	}

	async #decide(): Promise<SlotPruneReport> {
		const { watch } = this.#options;
		this.observe();
		const due = watch.due(this.#options.settleMs);
		if (due.length === 0) return NOTHING;
		if (!this.#complete) return this.#held("the tab set is not known to be complete yet", due);
		const registry = this.#options.registry();
		const index = this.#options.index();
		if (registry === undefined || index === null) return { ...NOTHING, held: "no registry or index", waiting: due.map(slot => slot.slotId) };
		let others: OtherWindowsSnapshot;
		try {
			others = await registry.readOtherWindows();
		} catch (error) {
			return this.#held(`the window registry could not be read: ${error instanceof Error ? error.message : String(error)}`, due);
		}
		// A record that could not be read may be a window that holds the editor; a window that published no list (an earlier build)
		// or one that did not fit says nothing about its editors. Neither is "no editor".
		if (others.unreadable > 0) return this.#held(`${others.unreadable} window record(s) could not be read`, due);
		const silent = others.windows.find(entry => entry.window.slots === undefined);
		if (silent !== undefined) return this.#held(`window ${silent.window.holderId} published no editor list`, due);
		// The tab set may have changed while the registry was read: an editor that came back is not due.
		this.observe();
		const stillDue = new Map(watch.due(this.#options.settleMs).map(slot => [slot.slotId, slot] as const));
		const handedOver: string[] = [];
		const candidates: string[] = [];
		const waiting: string[] = [];
		for (const { slotId, absentSince } of due) {
			if (!stillDue.has(slotId)) continue;
			if (others.windows.some(entry => entry.window.slots!.includes(slotId))) {
				handedOver.push(slotId);
				continue;
			}
			// A window that has not published since the editor vanished here may have received it in the meantime.
			if (others.windows.some(entry => !(entry.updatedAtMs > absentSince))) {
				waiting.push(slotId);
				continue;
			}
			candidates.push(slotId);
		}
		const settled = candidates.length === 0 ? [] : await index.dropClosedPassiveSlots(candidates);
		const done = new Set(settled);
		for (const slotId of candidates) if (!done.has(slotId)) waiting.push(slotId);
		watch.forget([...handedOver, ...settled]);
		return { held: null, dropped: settled, handedOver, waiting };
	}

	#held(reason: string, due: readonly AbsentSlot[]): SlotPruneReport {
		return { ...NOTHING, held: reason, waiting: due.map(slot => slot.slotId) };
	}
}
