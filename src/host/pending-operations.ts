/**
 * The actions the user asked for that are still being processed in this window, kept only so the surfaces that show them can say
 * "accepted, and this is where it is" from the click (the Sessions tree, the status bar, the Chat page). See
 * `docs/designs/2026-10-15-immediate-click-feedback.md`.
 *
 * Presentation only: nothing here decides ownership, admission, a lease, run intent or a refusal, nothing is persisted and
 * nothing is published to another window. Operations on one key in the same family (`open`/`resume`/`new-session`/`restart` are one
 * attempt, as `openTab` already treats them) join: the later `begin` shares the operation, and the operation ends with its last
 * handle. An operation is cleared by its handle's `end`, by `dispose`, or by the window going away; its age never clears it (the
 * 60 s mark only changes the words and logs once, because the awaited work may still finish).
 *
 * A launch that ends `running` is not over while its process is still booting: the entry returns when the broker has started the
 * process, but OMP then needs seconds more (20 s and more with many plugins and providers) before it answers. An operation that has
 * reached the launching steps and ends `running` while `launchReady` says `booting` is *held*: it stays displayed (`Starting…`,
 * with the step the booting process is in) and ends by itself when the launch is ready, or gone. The check runs when the launch
 * says so ({@link PendingOperations.settle}: a conversation phase change, host control verified) and once a second as a net.
 *
 * Nothing here imports `vscode`.
 */
import {
	PENDING_STILL_AFTER_MS,
	isLaunchFamily,
	isLaunchingStep,
	sameFamily,
	type PendingEnd,
	type PendingKind,
	type PendingOrigin,
	type PendingStep,
} from "../shared/pending-operation.ts";

/** What the registry reports about one operation. */
export interface PendingOperation {
	readonly key: string;
	readonly kind: PendingKind;
	readonly step: PendingStep;
	readonly origin: PendingOrigin;
	/** The Chat page's request id that began it, or `null`. */
	readonly requestId: string | null;
	readonly startedAt: number;
	/** Past the 60 s mark: the words say "still …". */
	readonly still: boolean;
}

/** One change: `ended` is present when the operation of `key` ended (its last handle ended). */
export interface PendingChange {
	readonly key: string;
	readonly ended?: { readonly kind: PendingKind; readonly requestId: string | null; readonly status: PendingEnd };
}

export interface PendingHandle {
	/** Name the step the operation is in now; no effect after the operation ended. */
	step(step: PendingStep): void;
	/** This handle's part of the work is over. The operation ends when its last handle ends; calling it again does nothing. */
	end(status: PendingEnd): void;
}

export interface PendingBeginOptions {
	/** Who the user clicked; the default is `command`, the one with no surface of its own. */
	readonly origin?: PendingOrigin;
	readonly requestId?: string | null;
	/** The first step; the default is `waiting`, the generic "not started yet". */
	readonly step?: PendingStep;
}

export interface PendingTimers {
	set(callback: () => void, ms: number): unknown;
	clear(handle: unknown): void;
}

/** Whether the writer a launch started is still booting (its conversation or host control is not ready yet), ready, or no longer there. */
export type LaunchReadiness = "booting" | "ready" | "gone";

export interface PendingOperationsOptions {
	readonly now?: () => number;
	readonly timers?: PendingTimers;
	/** One line, for the 60 s mark. */
	readonly log?: (line: string) => void;
	/** The readiness of the writer of a launch key; without it nothing is ever held. */
	readonly launchReady?: (key: string) => LaunchReadiness;
}

/** How often a held launch re-checks its readiness when nothing told it. */
const SETTLE_POLL_MS = 1_000;

interface Live {
	readonly key: string;
	kind: PendingKind;
	step: PendingStep;
	readonly origin: PendingOrigin;
	requestId: string | null;
	readonly startedAt: number;
	still: boolean;
	handles: number;
	/** Ended `running` while its process was still booting: displayed until the launch is ready. */
	holding: boolean;
	timer: unknown;
}

const REAL_TIMERS: PendingTimers = {
	set: (callback, ms) => setTimeout(callback, ms),
	clear: handle => clearTimeout(handle as number),
};

export class PendingOperations {
	readonly #now: () => number;
	readonly #timers: PendingTimers;
	readonly #log: (line: string) => void;
	readonly #launchReady: ((key: string) => LaunchReadiness) | undefined;
	/** Per key, oldest first; the last one is the displayed operation. */
	readonly #byKey = new Map<string, Live[]>();
	readonly #listeners = new Set<(change: PendingChange) => void>();
	#settleTimer: unknown;
	#disposed = false;

	constructor(options: PendingOperationsOptions = {}) {
		this.#now = options.now ?? Date.now;
		this.#timers = options.timers ?? REAL_TIMERS;
		this.#log = options.log ?? (() => undefined);
		this.#launchReady = options.launchReady;
	}

	/** Listen to changes (begin, step, end); returns the way to stop. */
	onDidChange(listener: (change: PendingChange) => void): () => void {
		this.#listeners.add(listener);
		return () => { this.#listeners.delete(listener); };
	}

	/**
	 * An action was accepted. Synchronous. An operation of the same family already pending on the key is joined (a later `resume`
	 * upgrades an earlier `open`), not duplicated.
	 */
	begin(key: string, kind: PendingKind, options: PendingBeginOptions = {}): PendingHandle {
		if (this.#disposed) return { step: () => undefined, end: () => undefined };
		const live = this.#byKey.get(key) ?? [];
		let operation = live.find(candidate => sameFamily(candidate.kind, kind));
		if (operation === undefined) {
			operation = {
				key, kind, step: options.step ?? "waiting", origin: options.origin ?? "command", requestId: options.requestId ?? null,
				startedAt: this.#now(), still: false, handles: 0, holding: false, timer: undefined,
			};
			const created = operation;
			operation.timer = this.#timers.set(() => this.#markStill(created), PENDING_STILL_AFTER_MS);
			live.push(operation);
			this.#byKey.set(key, live);
		} else {
			if (operation.kind === "open" && kind !== "open") operation.kind = kind;
			if (operation.requestId === null && options.requestId != null) operation.requestId = options.requestId;
			if (options.step !== undefined) operation.step = options.step;
		}
		operation.handles += 1;
		this.#emit({ key });
		return this.#handle(operation);
	}

	#handle(operation: Live): PendingHandle {
		let ended = false;
		return {
			step: step => {
				if (ended || operation.handles === 0 || operation.step === step) return;
				operation.step = step;
				this.#emit({ key: operation.key });
			},
			end: status => {
				if (ended) return;
				ended = true;
				operation.handles -= 1;
				// A later handle of the same attempt (a second click that joined) never ends the launch the held operation waits for.
				if (operation.handles > 0 || operation.holding) return;
				if (status === "running" && this.#booting(operation)) {
					operation.holding = true;
					this.#armSettle();
					this.#emit({ key: operation.key });
					return;
				}
				this.#remove(operation, status);
			},
		};
	}

	/** Whether an operation that just ended `running` is a launch whose process has not finished starting. */
	#booting(operation: Live): boolean {
		const launches = isLaunchFamily(operation.kind) || operation.kind === "view-switch";
		return launches && isLaunchingStep(operation.step) && this.#launchReady?.(operation.key) === "booting";
	}

	#remove(operation: Live, status: PendingEnd): void {
		operation.holding = false;
		this.#timers.clear(operation.timer);
		const live = this.#byKey.get(operation.key);
		if (live !== undefined) {
			const at = live.indexOf(operation);
			if (at >= 0) live.splice(at, 1);
			if (live.length === 0) this.#byKey.delete(operation.key);
		}
		this.#emit({ key: operation.key, ended: { kind: operation.kind, requestId: operation.requestId, status } });
	}

	/**
	 * The launch of `key` says something about its writer changed (its conversation reached a phase, host control was verified or the
	 * launch was given up): a held operation of the key ends when its launch is ready (`running`) or gone (`failed`), and stays
	 * while it is still booting. Nothing happens without a held operation.
	 */
	settle(key: string): void {
		const ready = this.#launchReady;
		if (ready === undefined) return;
		for (const operation of [...(this.#byKey.get(key) ?? [])]) {
			if (!operation.holding) continue;
			const readiness = ready(key);
			if (readiness !== "booting") this.#remove(operation, readiness === "ready" ? "running" : "failed");
		}
	}

	#armSettle(): void {
		if (this.#settleTimer !== undefined || this.#disposed) return;
		this.#settleTimer = this.#timers.set(() => {
			this.#settleTimer = undefined;
			for (const key of [...this.#byKey.keys()]) this.settle(key);
			for (const live of this.#byKey.values()) if (live.some(operation => operation.holding)) { this.#armSettle(); break; }
		}, SETTLE_POLL_MS);
	}

	/**
	 * Name the step of the displayed launch operation of `key` (the launch family, or a view switch, which relaunches), or of its latest
	 * operation of `kind` when one is given; nothing happens when there is none. For code that does not hold the handle.
	 */
	step(key: string, step: PendingStep, kind?: PendingKind): void {
		const live = this.#byKey.get(key);
		const operation = kind === undefined
			? live?.findLast(candidate => isLaunchFamily(candidate.kind) || candidate.kind === "view-switch")
			: live?.findLast(candidate => candidate.kind === kind);
		if (operation === undefined || operation.step === step) return;
		operation.step = step;
		this.#emit({ key });
	}

	/**
	 * The displayed operation of the key (the latest begun that is still pending), or `undefined`. With `accept`, the latest one of an
	 * accepted kind: a surface that shows only some kinds is not blanked by an operation it does not show.
	 */
	get(key: string, accept?: (kind: PendingKind) => boolean): PendingOperation | undefined {
		const live = this.#byKey.get(key);
		const operation = accept === undefined ? live?.[live.length - 1] : live?.findLast(candidate => accept(candidate.kind));
		return operation === undefined ? undefined : this.#snapshot(operation);
	}

	/** The displayed operation of every key that has one. */
	list(): PendingOperation[] {
		const out: PendingOperation[] = [];
		for (const live of this.#byKey.values()) {
			const operation = live[live.length - 1];
			if (operation !== undefined) out.push(this.#snapshot(operation));
		}
		return out;
	}

	/** Milliseconds since the operation began. */
	elapsedMs(operation: PendingOperation): number {
		return Math.max(0, this.#now() - operation.startedAt);
	}

	/** The registry is gone with its window: every operation is dropped, silently. */
	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		for (const live of this.#byKey.values()) for (const operation of live) this.#timers.clear(operation.timer);
		if (this.#settleTimer !== undefined) this.#timers.clear(this.#settleTimer);
		this.#settleTimer = undefined;
		this.#byKey.clear();
		this.#listeners.clear();
	}

	#snapshot(operation: Live): PendingOperation {
		const { key, kind, step, origin, requestId, startedAt, still } = operation;
		return { key, kind, step, origin, requestId, startedAt, still };
	}

	#markStill(operation: Live): void {
		if (operation.still || (operation.handles === 0 && !operation.holding)) return;
		operation.still = true;
		this.#log(`window timing: ${operation.kind} ${operation.key} still at ${operation.step} after ${Math.round(PENDING_STILL_AFTER_MS / 1000)} s`);
		this.#emit({ key: operation.key });
	}

	#emit(change: PendingChange): void {
		for (const listener of [...this.#listeners]) listener(change);
	}
}
