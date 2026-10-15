/**
 * Where one explicitly started launch spent its time: New Session, and Resume or Open of an existing session.
 *
 * Restore has a per-row step timer (`session-restore-trace.ts`) and a log line per row; a session the user starts has
 * neither, so a launch that took half a minute left a log with nothing between "panel bound" and "running". A run
 * starts when the command is entered ({@link LaunchTimeline.begin}, with the kind of the command: New Session reserves a
 * draft, Resume from the composer, a folder's history or Resume Session, and Open of a row, which launches when the row is
 * stopped); the launch path then adds the duration of every phase it already measures ({@link LaunchTimeline.add}) and the
 * lap from the previous mark to now ({@link LaunchTimeline.lap}); the launcher claims the run when it takes the launch
 * ({@link LaunchTimeline.reached}) and asks for the summary when the host is running, and the host-control step asks how
 * long after the command its channel was verified ({@link LaunchTimeline.finish}). A command whose launch never reaches the
 * launcher (the session is already running, the admission refused it, another window runs it) drops its run with
 * {@link LaunchTimeline.abandon}, so a later launch of the tab is not reported as that command's.
 *
 * Only a launch that began a run is reported, so the startup restore adds no line (a Restart after a failed Chat and a Chat/Terminal
 * view switch begin runs too, so their launch phases are timed, and shown as steps by the pending-operation display through
 * {@link LaunchTimeline.observe}). Diagnostic and presentation only: nothing here decides anything. Nothing here imports `vscode`.
 */

/** What the user asked for; the word the timing lines carry. */
export type LaunchKind = "new session" | "resume" | "open" | "restart" | "view switch";

/**
 * The laps a launch records, one per phase boundary it measures. A closed union: the pending-operation display derives its
 * step from these names (`src/host/pending-steps.ts`), so a rename is a compile error there, not a silent wrong step.
 */
export type LaunchLap =
	| "draft"
	| "wait"
	| "ownership"
	| "panel"
	| "admission"
	| "stage"
	| "host control keys"
	| "runtime proof"
	| "editor document"
	| "broker slot"
	| "conversation"
	| "run intent";

/** Told of each lap and of each timed phase the launcher adds, for a tab that has a run. Presentation only. */
export interface LaunchTimelineObserver {
	onLap(tabId: string, lap: LaunchLap): void;
	/** A phase the caller timed itself was added (the broker launch's own timings, reported after it returns). */
	onAdd(tabId: string): void;
}

interface Run {
	readonly kind: LaunchKind;
	readonly startedAt: number;
	/** Where the last lap ended. */
	lastMark: number;
	/** The launcher took the launch this run was begun for. */
	launched: boolean;
	readonly phases: [name: string, ms: number][];
}

/** A run kept this long without finishing is dropped (a launch that never reached `running`). */
const RUN_KEEP_MS = 10 * 60_000;
/** Runs kept at once; the oldest is dropped first. */
const RUN_KEEP_MAX = 16;

export interface LaunchSummary {
	/** What the user asked for. */
	readonly kind: LaunchKind;
	/** Whole milliseconds from the command to now. */
	readonly totalMs: number;
	/** `a 12 · b 340`, in the order recorded; empty when nothing was recorded. */
	readonly phases: string;
}

export class LaunchTimeline {
	readonly #now: () => number;
	readonly #runs = new Map<string, Run>();

	#observer: LaunchTimelineObserver | null = null;

	constructor(now: () => number = Date.now) {
		this.#now = now;
	}

	/** The one observer of this timeline's laps (the pending-operation display); `null` removes it. */
	observe(observer: LaunchTimelineObserver | null): void {
		this.#observer = observer;
	}

	/**
	 * A command that starts this tab's launch was entered (at `startedAt`, default now): the clock of this tab's run starts.
	 * An earlier run of the tab is replaced.
	 */
	begin(tabId: string, kind: LaunchKind, startedAt: number = this.#now()): void {
		const at = this.#now();
		this.#runs.delete(tabId);
		this.#runs.set(tabId, { kind, startedAt, lastMark: startedAt, launched: false, phases: [] });
		for (const [id, run] of this.#runs) {
			if (this.#runs.size <= RUN_KEEP_MAX && at - run.startedAt < RUN_KEEP_MS) break;
			this.#runs.delete(id);
		}
	}

	/** Whether a run of the tab is open. */
	has(tabId: string): boolean {
		return this.#runs.has(tabId);
	}

	/** The launcher took the launch the tab's run was begun for: the run now belongs to it. Returns the run's kind, or `null` when the tab has none. */
	reached(tabId: string): LaunchKind | null {
		const run = this.#runs.get(tabId);
		if (run === undefined) return null;
		run.launched = true;
		return run.kind;
	}

	/** Record `phase` as the time since the previous lap (or the command). No run: nothing happens. */
	lap(tabId: string, phase: LaunchLap): void {
		const run = this.#runs.get(tabId);
		if (run === undefined) return;
		const at = this.#now();
		run.phases.push([phase, Math.max(0, at - run.lastMark)]);
		run.lastMark = at;
		this.#observer?.onLap(tabId, phase);
	}

	/** Record a phase the caller timed itself; the lap pointer moves to now, so a following {@link lap} excludes it. */
	add(tabId: string, phase: string, ms: number): void {
		const run = this.#runs.get(tabId);
		if (run === undefined) return;
		run.phases.push([phase, Math.max(0, Math.round(ms))]);
		run.lastMark = this.#now();
		this.#observer?.onAdd(tabId);
	}

	/** The run so far, without ending it; `null` when the tab has none. */
	summary(tabId: string): LaunchSummary | null {
		const run = this.#runs.get(tabId);
		if (run === undefined) return null;
		return {
			kind: run.kind,
			totalMs: Math.round(this.#now() - run.startedAt),
			phases: run.phases.map(([name, ms]) => `${name} ${Math.round(ms)}`).join(" · "),
		};
	}

	/** The run ends and its kind and whole milliseconds since the command are returned: the second report of a launch is its last. */
	finish(tabId: string): { readonly kind: LaunchKind; readonly totalMs: number } | null {
		const run = this.#runs.get(tabId);
		if (run === undefined) return null;
		this.#runs.delete(tabId);
		return { kind: run.kind, totalMs: Math.round(this.#now() - run.startedAt) };
	}

	/** The command that began the run ended without any launch reaching the launcher (already running, refused, another window's): the run is dropped unreported. A run the launcher took is left to its own end. */
	abandon(tabId: string): void {
		if (this.#runs.get(tabId)?.launched === false) this.#runs.delete(tabId);
	}

	/** The tab's run ends without a report (the launch failed or the tab closed). */
	discard(tabId: string): void {
		this.#runs.delete(tabId);
	}
}
