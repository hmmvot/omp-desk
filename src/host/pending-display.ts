/**
 * Carries the registry's operations to the surfaces that show them outside a Chat page: the Sessions tree rows, the Sessions
 * view's own progress bar, and the status bar for an action that has no row or button to show anything.
 *
 * Presentation only, like the registry it reads (`pending-operations.ts`): nothing here changes what an action does. Every
 * surface is behind {@link PendingDisplayShell}, so this module imports no `vscode` and its timing is tested with a manual clock.
 *
 * - **Rows.** Every change is pushed to the tree as one snapshot, coalesced to one push per turn: a launch changes its step several
 *   times in a row and the host's loop is not to be spent on each. The tree repaints only the rows whose words changed.
 * - **Clock.** One timer exists while an operation does: it fires at the 5 s mark (when seconds start to show), then every second.
 *   With nothing pending there is no timer.
 * - **Sessions view progress.** The view's progress bar runs while an operation of a row or folder is pending, visible even when the
 *   row is scrolled out of sight or its folder is collapsed.
 * - **Status bar.** An operation begun outside a panel (`origin: "command"`: the Command Palette, Go to Session, a keybinding, and
 *   the actions with no row such as Export HTML and Reload All Windows) gets window progress with its words, after a one-second
 *   grace so a quick action does not flash.
 */
import { PENDING_SECONDS_AFTER_MS, pendingText, type PendingKind } from "../shared/pending-operation.ts";
import type { PendingOperation, PendingOperations, PendingTimers } from "./pending-operations.ts";

/** One operation as the tree shows it (the shape `SessionTreeProvider.setPending` takes). */
export interface PendingRow {
	readonly key: string;
	readonly kind: PendingKind;
	readonly step: PendingOperation["step"];
	readonly startedAt: number;
	readonly still: boolean;
}

/** A progress indicator that is showing; `end` removes it, and `update` changes its words. */
export interface PendingProgress {
	update(text: string): void;
	end(): void;
}

/** What the surfaces are, as the host provides them. */
export interface PendingDisplayShell {
	/** Replace the operations the Sessions tree shows. */
	setRows(rows: readonly PendingRow[]): void;
	/** Begin progress at the Sessions view (`view`) or the status bar (`window`). */
	beginProgress(location: "view" | "window", text: string): PendingProgress;
}

export interface PendingDisplayOptions {
	readonly now?: () => number;
	readonly timers?: PendingTimers;
	/** How long a command-origin operation runs before the status bar shows it. */
	readonly graceMs?: number;
}

/** The kinds that belong to no row of the Sessions view: they show in the status bar and nowhere else. */
const NO_ROW_KINDS: Partial<Record<PendingKind, true>> = { export: true, "reload-windows": true, "inventory-toggle": true };

const REAL_TIMERS: PendingTimers = {
	set: (callback, ms) => setTimeout(callback, ms),
	clear: handle => clearTimeout(handle as number),
};

/** Whether the operation has a row (or folder row) in the Sessions view. */
function hasRow(operation: PendingOperation): boolean {
	return NO_ROW_KINDS[operation.kind] !== true;
}

/** The identity of one operation: a later operation on the same key is another one. */
function identity(operation: PendingOperation): string {
	return `${operation.key}\0${operation.startedAt}`;
}

export class PendingDisplay {
	readonly #registry: PendingOperations;
	readonly #shell: PendingDisplayShell;
	readonly #now: () => number;
	readonly #timers: PendingTimers;
	readonly #graceMs: number;
	readonly #unsubscribe: () => void;
	/** The command-origin operations waiting out the grace, or showing in the status bar. */
	readonly #status = new Map<string, { grace: unknown; progress: PendingProgress | null }>();
	#push: unknown;
	#clock: unknown;
	#viewProgress: PendingProgress | null = null;
	#disposed = false;

	constructor(registry: PendingOperations, shell: PendingDisplayShell, options: PendingDisplayOptions = {}) {
		this.#registry = registry;
		this.#shell = shell;
		this.#now = options.now ?? Date.now;
		this.#timers = options.timers ?? REAL_TIMERS;
		this.#graceMs = options.graceMs ?? 1_000;
		this.#unsubscribe = registry.onDidChange(() => this.#changed());
	}

	/** The surfaces stop; the registry is the window's own and is disposed with it. */
	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#unsubscribe();
		this.#timers.clear(this.#push);
		this.#timers.clear(this.#clock);
		this.#viewProgress?.end();
		this.#viewProgress = null;
		for (const tracked of this.#status.values()) {
			this.#timers.clear(tracked.grace);
			tracked.progress?.end();
		}
		this.#status.clear();
	}

	#changed(): void {
		if (this.#disposed) return;
		this.#schedulePush();
		this.#sync();
	}

	/** One push per turn, however many steps the turn changed. */
	#schedulePush(): void {
		if (this.#push !== undefined) return;
		this.#push = this.#timers.set(() => {
			this.#push = undefined;
			if (this.#disposed) return;
			this.#shell.setRows(this.#registry.list().filter(hasRow).map(operation => ({
				key: operation.key, kind: operation.kind, step: operation.step, startedAt: operation.startedAt, still: operation.still,
			})));
		}, 0);
	}

	/** Bring the view progress, the status bar and the clock in line with what the registry holds now. */
	#sync(): void {
		const operations = this.#registry.list();
		const rows = operations.some(hasRow);
		if (rows && this.#viewProgress === null) this.#viewProgress = this.#shell.beginProgress("view", "");
		else if (!rows && this.#viewProgress !== null) {
			this.#viewProgress.end();
			this.#viewProgress = null;
		}
		const live = new Set<string>();
		for (const operation of operations) {
			if (operation.origin !== "command") continue;
			const id = identity(operation);
			live.add(id);
			const tracked = this.#status.get(id);
			if (tracked === undefined) {
				const grace = this.#timers.set(() => this.#showStatus(id), this.#graceMs);
				this.#status.set(id, { grace, progress: null });
			} else tracked.progress?.update(this.#words(operation));
		}
		for (const [id, tracked] of [...this.#status]) {
			if (live.has(id)) continue;
			this.#timers.clear(tracked.grace);
			tracked.progress?.end();
			this.#status.delete(id);
		}
		this.#arm(operations);
	}

	#showStatus(id: string): void {
		const tracked = this.#status.get(id);
		if (this.#disposed || tracked === undefined || tracked.progress !== null) return;
		const operation = this.#registry.list().find(candidate => identity(candidate) === id);
		if (operation === undefined) return;
		tracked.progress = this.#shell.beginProgress("window", this.#words(operation));
	}

	#words(operation: PendingOperation): string {
		return pendingText(operation.kind, operation.step, this.#registry.elapsedMs(operation), operation.still);
	}

	/** One timer: the 5 s mark of the oldest operation while none shows seconds yet, then every second. */
	#arm(operations: readonly PendingOperation[]): void {
		this.#timers.clear(this.#clock);
		this.#clock = undefined;
		if (operations.length === 0) return;
		const oldest = Math.max(...operations.map(operation => this.#registry.elapsedMs(operation)));
		const delay = oldest >= PENDING_SECONDS_AFTER_MS ? 1_000 : PENDING_SECONDS_AFTER_MS - oldest;
		this.#clock = this.#timers.set(() => this.#tick(), Math.max(1, delay));
	}

	#tick(): void {
		this.#clock = undefined;
		if (this.#disposed) return;
		this.#schedulePush();
		for (const [id, tracked] of this.#status) {
			if (tracked.progress === null) continue;
			const operation = this.#registry.list().find(candidate => identity(candidate) === id);
			if (operation !== undefined) tracked.progress.update(this.#words(operation));
		}
		this.#arm(this.#registry.list());
	}
}
