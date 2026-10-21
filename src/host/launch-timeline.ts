/**
 * Where one explicitly started launch spent its time: New Session, and Resume or Open of an existing session.
 *
 * Restore has a per-row step timer (`session-restore-trace.ts`) and a log line per row; a session the user starts has
 * neither, so a launch that took half a minute left a log with nothing between "panel bound" and "running". A run
 * starts when the command is entered ({@link LaunchTimeline.begin}, with the kind of the command: New Session reserves a
 * draft, Resume from the composer, a folder's history or Resume Session, and Open of a row, which launches when the row is
 * stopped); every step the start reaches is recorded as milliseconds from that command: the laps of the launch path
 * ({@link LaunchTimeline.lap}), the phases the broker launch timed itself ({@link LaunchTimeline.add}) and the steps OMP and the
 * Desk reach later ({@link LaunchTimeline.mark}: OMP spawned, its control record published, OMP `ready`, Chat `live`). The launcher
 * claims the run when it takes the launch ({@link LaunchTimeline.reached}); the host-control step ends it
 * ({@link LaunchTimeline.finish}) and the run is reported as ONE Info line: at that moment, or, for a Chat, once it is live. A
 * start that fails or is cancelled reports the steps reached so far with the step that failed ({@link LaunchTimeline.discard}).
 * A command whose launch never reaches the launcher (the session is already running, the admission refused it, another window
 * runs it) drops its run with {@link LaunchTimeline.abandon}, so a later launch of the tab is not reported as that command's.
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
	/** The tab's run ended: host control was verified (`finish`) or the launch failed or the tab closed (`discard`). */
	onEnd(tabId: string): void;
}

interface Run {
	readonly kind: LaunchKind;
	readonly startedAt: number;
	/** Where the last lap or timed phase ended (absolute time): the point the next timed phase continues from. */
	cursor: number;
	/** The launcher took the launch this run was begun for. */
	launched: boolean;
	/** The launcher started a Chat conversation: the run is reported when it is live, not when host control is verified. */
	awaitsLive: boolean;
	/** Every step reached so far, in the order it was reached, as milliseconds from the command. */
	readonly marks: [name: string, ms: number][];
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
}

/** The steps the Desk and OMP reach that are not laps of the launch path (see {@link LaunchTimeline.mark}). */
export type LaunchMilestone = "omp spawned" | "omp control published" | "omp ready" | "host control verified" | "host control unavailable" | "chat live";

export class LaunchTimeline {
	readonly #now: () => number;
	readonly #report: (line: string) => void;
	readonly #runs = new Map<string, Run>();
	/** Runs whose host control ended but whose Chat is not live yet; the Chat's `live` (or its failure) reports them. */
	readonly #settling = new Map<string, Run>();

	#observer: LaunchTimelineObserver | null = null;

	/** `report` receives the one timeline line of each started session (or of the start that failed); omitted: nothing is reported. */
	constructor(now: () => number = Date.now, report: (line: string) => void = () => {}) {
		this.#now = now;
		this.#report = report;
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
		this.#settling.delete(tabId);
		this.#runs.set(tabId, { kind, startedAt, cursor: startedAt, launched: false, awaitsLive: false, marks: [] });
		for (const map of [this.#runs, this.#settling]) {
			for (const [id, run] of map) {
				if (map.size <= RUN_KEEP_MAX && at - run.startedAt < RUN_KEEP_MS) break;
				map.delete(id);
			}
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

	/** The launch starts a Chat conversation: the run is reported once the Chat is live, after host control has been verified or has given up. */
	expectLive(tabId: string): void {
		const run = this.#runs.get(tabId);
		if (run !== undefined) run.awaitsLive = true;
	}

	/** Record `phase` as reached now (milliseconds from the command). No run: nothing happens. */
	lap(tabId: string, phase: LaunchLap): void {
		const run = this.#runs.get(tabId);
		if (run === undefined) return;
		const at = this.#now();
		run.marks.push([phase, Math.max(0, at - run.startedAt)]);
		run.cursor = at;
		this.#observer?.onLap(tabId, phase);
	}

	/** Record a phase the caller timed itself: it ended `ms` after the previous lap or timed phase (never later than now), so the phases the broker launch reports stay in order. */
	add(tabId: string, phase: string, ms: number): void {
		const run = this.#runs.get(tabId);
		if (run === undefined) return;
		run.cursor = Math.min(this.#now(), run.cursor + Math.max(0, Math.round(ms)));
		run.marks.push([phase, Math.max(0, run.cursor - run.startedAt)]);
		this.#observer?.onAdd(tabId);
	}

	/**
	 * A step happened now, or at `at` (an absolute time another process stamped, clamped between the command and now). Only the first
	 * time a run reaches a step is kept. A tab with no run, or a run already reported, adds nothing. `chat live` also reports a run
	 * that was waiting for it.
	 */
	mark(tabId: string, step: LaunchMilestone, at?: number): void {
		const waiting = this.#settling.get(tabId);
		const run = this.#runs.get(tabId) ?? waiting;
		if (run === undefined || run.marks.some(([name]) => name === step)) return;
		const now = this.#now();
		// A stamp before the command cannot belong to this start (another clock or unit): the moment it was seen stands.
		const stamped = at !== undefined && at >= run.startedAt ? Math.min(at, now) : now;
		run.marks.push([step, Math.round(stamped - run.startedAt)]);
		if (waiting !== undefined && step === "chat live") {
			this.#settling.delete(tabId);
			this.#report(this.#line(tabId, run, null));
		}
	}

	/** The run so far, without ending it; `null` when the tab has none. */
	summary(tabId: string): LaunchSummary | null {
		const run = this.#runs.get(tabId);
		if (run === undefined) return null;
		return { kind: run.kind, totalMs: Math.round(this.#now() - run.startedAt) };
	}

	/** Host control was verified: the run ends, its kind and whole milliseconds since the command are returned, and it is reported unless its Chat is still to go live. */
	finish(tabId: string): { readonly kind: LaunchKind; readonly totalMs: number } | null {
		const run = this.#runs.get(tabId);
		if (run === undefined) return null;
		this.mark(tabId, "host control verified");
		this.#end(tabId, run);
		return { kind: run.kind, totalMs: Math.round(this.#now() - run.startedAt) };
	}

	/** Host control will not report (the launcher did not carry it, or it failed): the run ends the same way, with that said in the line. */
	finishWithoutControl(tabId: string): void {
		const run = this.#runs.get(tabId);
		if (run === undefined) return;
		this.mark(tabId, "host control unavailable");
		this.#end(tabId, run);
	}

	/**
	 * The command that began the run ended without any launch reaching the launcher (already running, refused, another window's): the
	 * run is dropped, unreported unless `cancelledAt` says why it ended (an error, a Cancel), which reports the steps reached. A run the
	 * launcher took is left to its own end.
	 */
	abandon(tabId: string, cancelledAt?: string): void {
		const run = this.#runs.get(tabId);
		if (run === undefined || run.launched) return;
		this.#runs.delete(tabId);
		if (cancelledAt !== undefined) this.#report(this.#line(tabId, run, cancelledAt));
	}

	/**
	 * The tab's run ends: without `failure`, unreported (the tab closed, nothing started); with it, the steps reached so far are
	 * reported, naming the step that failed or was cancelled.
	 */
	discard(tabId: string, failure?: string): void {
		const waiting = this.#settling.get(tabId);
		if (waiting !== undefined) {
			this.#settling.delete(tabId);
			if (failure !== undefined) this.#report(this.#line(tabId, waiting, failure));
			return;
		}
		const run = this.#runs.get(tabId);
		if (run === undefined) return;
		this.#runs.delete(tabId);
		this.#observer?.onEnd(tabId);
		if (failure !== undefined) this.#report(this.#line(tabId, run, failure));
	}

	#end(tabId: string, run: Run): void {
		this.#runs.delete(tabId);
		this.#observer?.onEnd(tabId);
		if (run.awaitsLive && !run.marks.some(([name]) => name === "chat live")) this.#settling.set(tabId, run);
		else this.#report(this.#line(tabId, run, null));
	}

	/** `window timing: <kind> <tab> start timeline, ms from the command: …`, or the same cut short with the step that failed or was cancelled; one line. */
	#line(tabId: string, run: Run, failure: string | null): string {
		const steps = run.marks.map(([name, ms]) => `${name} ${Math.round(ms)}`).join(" · ");
		if (failure === null) return `window timing: ${run.kind} ${tabId} start timeline, ms from the command: ${steps}`;
		return `window timing: ${run.kind} ${tabId} start ended after ${Math.round(this.#now() - run.startedAt)} ms, failed or cancelled at ${failure}; ms from the command: ${steps === "" ? "no step reached" : steps}`;
	}
}
