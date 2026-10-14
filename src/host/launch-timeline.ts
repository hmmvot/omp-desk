/**
 * Where one new session's launch spent its time.
 *
 * Restore has a per-row step timer (`session-restore-trace.ts`) and a log line per row; a session the user starts has
 * neither, so a launch that took half a minute left a log with nothing between "panel bound" and "running". A run
 * starts when the New Session command reserves its draft ({@link LaunchTimeline.begin}); the launch path then adds the
 * duration of every phase it already measures ({@link LaunchTimeline.add}) and the lap from the previous mark to now
 * ({@link LaunchTimeline.lap}); the launcher asks for the summary when the host is running, and the host-control step
 * asks how long after the command its channel was verified.
 *
 * Only a launch that began a run is reported, so a restore, a Resume or a mode switch adds no line. Diagnostic only:
 * nothing here decides anything. Nothing here imports `vscode`.
 */

interface Run {
	readonly startedAt: number;
	/** Where the last lap ended. */
	lastMark: number;
	readonly phases: [name: string, ms: number][];
}

/** A run kept this long without finishing is dropped (a launch that never reached `running`). */
const RUN_KEEP_MS = 10 * 60_000;
/** Runs kept at once; the oldest is dropped first. */
const RUN_KEEP_MAX = 16;

export interface LaunchSummary {
	/** Whole milliseconds from the command to now. */
	readonly totalMs: number;
	/** `a 12 · b 340`, in the order recorded; empty when nothing was recorded. */
	readonly phases: string;
}

export class LaunchTimeline {
	readonly #now: () => number;
	readonly #runs = new Map<string, Run>();

	constructor(now: () => number = Date.now) {
		this.#now = now;
	}

	/**
	 * The New Session command asked for a draft (at `startedAt`, default now): the clock of this tab's run starts.
	 * An earlier run of the tab is replaced.
	 */
	begin(tabId: string, startedAt: number = this.#now()): void {
		const at = this.#now();
		this.#runs.delete(tabId);
		this.#runs.set(tabId, { startedAt, lastMark: startedAt, phases: [] });
		for (const [id, run] of this.#runs) {
			if (this.#runs.size <= RUN_KEEP_MAX && at - run.startedAt < RUN_KEEP_MS) break;
			this.#runs.delete(id);
		}
	}

	/** Whether a run of the tab is open. */
	has(tabId: string): boolean {
		return this.#runs.has(tabId);
	}

	/** Record `phase` as the time since the previous lap (or the command). No run: nothing happens. */
	lap(tabId: string, phase: string): void {
		const run = this.#runs.get(tabId);
		if (run === undefined) return;
		const at = this.#now();
		run.phases.push([phase, Math.max(0, at - run.lastMark)]);
		run.lastMark = at;
	}

	/** Record a phase the caller timed itself; the lap pointer moves to now, so a following {@link lap} excludes it. */
	add(tabId: string, phase: string, ms: number): void {
		const run = this.#runs.get(tabId);
		if (run === undefined) return;
		run.phases.push([phase, Math.max(0, Math.round(ms))]);
		run.lastMark = this.#now();
	}

	/** The run so far, without ending it; `null` when the tab has none. */
	summary(tabId: string): LaunchSummary | null {
		const run = this.#runs.get(tabId);
		if (run === undefined) return null;
		return {
			totalMs: Math.round(this.#now() - run.startedAt),
			phases: run.phases.map(([name, ms]) => `${name} ${Math.round(ms)}`).join(" · "),
		};
	}

	/** Whole milliseconds since the command, and the run ends: the second report of a launch is its last. */
	finish(tabId: string): number | null {
		const run = this.#runs.get(tabId);
		if (run === undefined) return null;
		this.#runs.delete(tabId);
		return Math.round(this.#now() - run.startedAt);
	}

	/** The tab's run ends without a report (the launch failed or the tab closed). */
	discard(tabId: string): void {
		this.#runs.delete(tabId);
	}
}
