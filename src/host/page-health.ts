/**
 * What the host makes of a Chat page's liveness reports (`omp:page-health`, `src/protocol/page-health.ts`).
 *
 * A page whose main thread is stuck sends nothing, and the extension host still runs, so the stall is only visible as silence. This
 * module keeps one {@link PageStallDetector} per page and writes, at Info, the line a stall and the line its end deserve, plus a line
 * for every long task the page itself measured. It reads no message text: a report holds counts, kinds and the browser's
 * attribution of a long task, all of them from the protocol module's closed vocabularies.
 *
 * Silence is not proof that the page's main thread was stuck: a report also needs the window's renderer to carry it, so the lines
 * say that no report reached the host, and the end of a stall adds how overdue the page's own timer was (a figure close to the
 * silence means the page was stuck; one near zero means the reports were held up on the way).
 *
 * Only a visible page is held to the threshold. A page that VS Code or the browser hides is throttled (timers run once a second at
 * best, once a minute after five minutes), so its silence is not a stall: the detector measures silence only while the host sees
 * the panel visible *and* either the page's last report said it was visible or the host has seen the user away (window unfocused or
 * tab not in front) at some check since that report and both are true again (a page that is shown to a user after that cannot still
 * be hidden, so a page that has not said it is visible again is stuck), and starts the clock again when that holds
 * again. The host's own pauses (its event loop blocked, the machine asleep) are recognised by a gap between two checks and never
 * charged to the page.
 *
 * No `vscode` import: the panel and the window arrive as closures, so every rule is tested with a fake clock.
 */
import type { Logger } from "../shared/logger.ts";
import { PAGE_BEAT_INTERVAL_MS, PAGE_STALL_THRESHOLD_MS } from "../protocol/page-health.ts";
import type { GuestPageHealthMessage, PageHealthEvent, PageLongTask } from "../protocol/page-health.ts";

/** How often the host looks at every page it watches. */
export const PAGE_CHECK_INTERVAL_MS = PAGE_BEAT_INTERVAL_MS;
/** A gap this long between two host checks means the host itself did not run (blocked or asleep): silence in it proves nothing. */
export const PAGE_CHECK_MAX_GAP_MS = PAGE_BEAT_INTERVAL_MS * 3;
/** Long-task lines one page may cause per second, and over its lifetime; the host's own bound, whatever a page sends. */
export const LONG_TASK_LOG_GAP_MS = 1_000;
export const LONG_TASK_LOG_CAP = 50;
/** Stall lines one page may cause over its lifetime. */
export const STALL_LOG_CAP = 20;
/** The lateness of a page's own timer worth quoting (a smaller figure is the ordinary jitter of a timer). */
export const LATENESS_WORTH_QUOTING_MS = 1_000;

export type StallVerdict =
	| { kind: "stalled"; silentMs: number; lastReportAgoMs: number }
	| { kind: "recovered"; stalledMs: number; hostPaused: boolean; replaced: boolean };

/** A page's silence, judged by a clock the caller supplies. Pure: no timer, no log, no panel. */
export class PageStallDetector {
	readonly #thresholdMs: number;
	readonly #maxGapMs: number;
	#last: GuestPageHealthMessage | null = null;
	#lastAt = 0;
	/** The moment the current silence is measured from: the last report, the last time the page was held to the threshold again, or the last host pause. */
	#anchor = 0;
	#pageVisible = true;
	#watched = true;
	#replaced = false;
	#checkedAt: number | null = null;
	#stall: { since: number; hostPaused: boolean } | null = null;
	/**
	 * Whether the host has seen the user leave the window (or the tab) since the page's last report. A page's own report that it is hidden,
	 * received while the user is in the window, is the page's word that it is hidden for another reason (a window of its own that is
	 * minimised): only a user who is seen to leave and come back can have been shown a page that must have said it is visible again.
	 */
	#armed = false;

	constructor(options: { thresholdMs?: number; maxGapMs?: number } = {}) {
		this.#thresholdMs = options.thresholdMs ?? PAGE_STALL_THRESHOLD_MS;
		this.#maxGapMs = options.maxGapMs ?? PAGE_CHECK_MAX_GAP_MS;
	}

	/** The page's last report, or `null` before the first. */
	get last(): GuestPageHealthMessage | null {
		return this.#last;
	}

	/** Whether the last report began a new document (its counter did not advance). */
	get replaced(): boolean {
		return this.#replaced;
	}

	/** Whether a stall was logged and the page has not answered since. */
	get stalled(): boolean {
		return this.#stall !== null;
	}

	/** How long the page has been silent in a stall that was logged, or `null` when none is open. */
	stalledFor(now: number): number | null {
		return this.#stall === null ? null : now - this.#stall.since;
	}

	/** A report arrived. Returns the end of a stall, once. */
	report(now: number, message: GuestPageHealthMessage, hostVisible: boolean): StallVerdict | null {
		this.#replaced = this.#last !== null && message.seq <= this.#last.seq;
		const verdict: StallVerdict | null = this.#stall === null ? null
			: { kind: "recovered", stalledMs: now - this.#stall.since, hostPaused: this.#stall.hostPaused, replaced: this.#replaced };
		this.#stall = null;
		this.#last = message;
		this.#lastAt = now;
		this.#anchor = now;
		this.#pageVisible = message.visible;
		this.#armed = false;
		this.#watched = hostVisible && message.visible;
		return verdict;
	}

	/** One look from the host's timer. Returns a stall when the silence of a watched page first reaches the threshold. */
	check(now: number, hostVisible: boolean, windowFocused: boolean): StallVerdict | null {
		const gap = this.#checkedAt === null ? 0 : now - this.#checkedAt;
		this.#checkedAt = now;
		if (gap > this.#maxGapMs) {
			// The host did not run for this long; neither did anything it was waiting for. Measure silence from now.
			this.#anchor = now;
			if (this.#stall !== null) this.#stall.hostPaused = true;
			return null;
		}
		if (!windowFocused) this.#armed = true;
		const watched = hostVisible && (this.#pageVisible || (this.#armed && windowFocused));
		if (watched && !this.#watched) this.#anchor = now;
		this.#watched = watched;
		if (!watched || this.#stall !== null || now - this.#anchor < this.#thresholdMs) return null;
		this.#stall = { since: this.#anchor, hostPaused: false };
		return { kind: "stalled", silentMs: now - this.#anchor, lastReportAgoMs: now - this.#lastAt };
	}
}

/** A duration as a reader wants it: milliseconds under a second, tenths under ten, whole seconds, then minutes. */
export function pageDuration(ms: number): string {
	if (ms < 1_000) return `${Math.round(ms)} ms`;
	if (ms < 10_000) return `${(ms / 1_000).toFixed(1)} s`;
	const seconds = Math.round(ms / 1_000);
	return seconds < 120 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

/** The ring as one line, oldest first: `rx:omp:chat-event ×230 (1.2 s before), render ×14 (0.4 s), key (0 ms)`. */
export function describeEvents(events: readonly PageHealthEvent[]): string {
	if (events.length === 0) return "none";
	return events.map(event => `${event.kind}${event.count > 1 ? ` ×${event.count}` : ""} (${pageDuration(event.agoMs)})`).join(", ");
}

/** A long task as one phrase: its duration, the browser's name for it and the scripts it blamed. */
export function describeLongTask(task: PageLongTask): string {
	const where = task.container === undefined ? task.name : `${task.name} in ${task.container}`;
	const scripts = task.scripts.map(script => `${script.invoker} ${script.fn} ${script.source} ${pageDuration(script.durationMs)}`).join("; ");
	return `${pageDuration(task.durationMs)}, ${where}${scripts.length === 0 ? ", no script attribution" : `, scripts: ${scripts}`}`;
}

/** How the host watches one panel: whether it is visible now, whether the window has the focus, and the label its lines carry. */
export interface WatchedPage {
	/** The panel this page lives in; a report from another panel under the same key is a new page. */
	readonly panel: object;
	/** `tab <id>`: what the log lines call the page. */
	readonly label: string;
	/**
	 * The document this page was loaded from. The host replaces it inside a panel (a mode switch, an explanation page that loads no
	 * bundle), and a replaced document is a new page whose silence starts nothing of its predecessor's.
	 */
	readonly document: object;
	/**
	 * Whether the host sees this page's document in a visible panel. It must answer `false` for a disposed panel and for a panel whose
	 * current document is no longer the one that reported.
	 */
	visible(): boolean;
	/** Whether the user is in the window with this tab in front. */
	windowFocused(): boolean;
}

interface Entry {
	readonly panel: object;
	readonly document: object;
	label: string;
	visible: () => boolean;
	windowFocused: () => boolean;
	readonly detector: PageStallDetector;
	longTasksLogged: number;
	lastLongTaskLoggedAt: number;
	stallsLogged: number;
	capsAnnounced: boolean;
	/** Whether the open stall's own line was logged: only a logged stall gets an end line. */
	stallLogged: boolean;
}

export interface PageHealthMonitorOptions {
	readonly log: Logger;
	/** A monotonic clock in milliseconds; defaults to `performance.now`, which no change of the system time moves. */
	readonly now?: () => number;
	/** Start the periodic check; returns its stop function. Tests pass their own and call {@link PageHealthMonitor.check}. */
	readonly startTimer?: (tick: () => void, intervalMs: number) => () => void;
}

/** One window's pages, by editor slot. The timer runs only while at least one page is watched. */
export class PageHealthMonitor {
	readonly #log: Logger;
	readonly #now: () => number;
	readonly #startTimer: (tick: () => void, intervalMs: number) => () => void;
	readonly #pages = new Map<string, Entry>();
	#stopTimer: (() => void) | null = null;

	constructor(options: PageHealthMonitorOptions) {
		this.#log = options.log;
		this.#now = options.now ?? (() => performance.now());
		this.#startTimer = options.startTimer ?? ((tick, ms) => {
			const timer = setInterval(tick, ms);
			timer.unref?.();
			return () => clearInterval(timer);
		});
	}

	/** Pages being watched, for tests. */
	get size(): number {
		return this.#pages.size;
	}

	/** One validated report from the page of `slot`. */
	note(slot: string, page: WatchedPage, message: GuestPageHealthMessage): void {
		const now = this.#now();
		let entry = this.#pages.get(slot);
		if (entry === undefined || entry.panel !== page.panel || entry.document !== page.document) {
			// A new panel or a new document under the slot is a new page: its predecessor's silence says nothing about it, and neither do its budgets.
			if (entry !== undefined) this.#retire(entry, "replaced");
			entry = { panel: page.panel, document: page.document, label: page.label, visible: page.visible, windowFocused: page.windowFocused, detector: new PageStallDetector(), longTasksLogged: 0, lastLongTaskLoggedAt: Number.NEGATIVE_INFINITY, stallsLogged: 0, capsAnnounced: false, stallLogged: false };
			this.#pages.set(slot, entry);
		}
		entry.label = page.label;
		entry.visible = page.visible;
		entry.windowFocused = page.windowFocused;
		const previous = entry.detector.last;
		const verdict = entry.detector.report(now, message, entry.visible());
		if (verdict?.kind === "recovered") {
			if (entry.stallLogged) {
				const quoted = message.lateMs >= LATENESS_WORTH_QUOTING_MS;
				const timer = quoted ? `; its own timer was ${pageDuration(message.lateMs)} overdue`
					: previous !== null && !previous.visible ? "; the page had reported itself hidden, so its own timer figure cannot tell whether it was stuck" : "";
				const host = verdict.hostPaused ? "; this window's extension host was itself paused meanwhile, so the figure may include that" : "";
				const replaced = verdict.replaced ? "; the page was reloaded (a new document reports)" : "";
				this.#log.info(`${entry.label}: the Chat page reports again after ${pageDuration(verdict.stalledMs)} without a report${timer}${host}${replaced}`);
			}
			entry.stallLogged = false;
		}
		if (message.longTask !== undefined) this.#logLongTask(entry, now, message);
		this.#ensureTimer();
	}

	/** The page of `slot` is gone (its panel was disposed): stop watching it. A stale panel does not remove its successor. */
	forget(slot: string, panel: object): void {
		const entry = this.#pages.get(slot);
		if (entry === undefined || entry.panel !== panel) return;
		this.#retire(entry, "closed");
		this.#pages.delete(slot);
		if (this.#pages.size === 0) this.dispose();
	}

	/** One look at every watched page; the timer's tick. */
	check(): void {
		const now = this.#now();
		for (const entry of this.#pages.values()) {
			const verdict = entry.detector.check(now, entry.visible(), entry.windowFocused());
			if (verdict?.kind !== "stalled") continue;
			if (entry.stallsLogged >= STALL_LOG_CAP) {
				this.#announceCaps(entry);
				continue;
			}
			entry.stallsLogged += 1;
			entry.stallLogged = true;
			const last = entry.detector.last;
			const seen = last === null ? "no report" : `its last report, #${last.seq} (${last.reason}), came ${pageDuration(verdict.lastReportAgoMs)} ago${last.visible ? "" : " and said the page was hidden"}`;
			this.#log.info(`${entry.label}: no report from the Chat page has reached the host for ${pageDuration(verdict.silentMs)} while it was visible (${seen}); its last events before it: ${last === null ? "none" : describeEvents(last.events)}`);
		}
	}

	dispose(): void {
		this.#stopTimer?.();
		this.#stopTimer = null;
	}

	#ensureTimer(): void {
		if (this.#stopTimer === null) this.#stopTimer = this.#startTimer(() => this.check(), PAGE_CHECK_INTERVAL_MS);
	}

	#retire(entry: Entry, how: "closed" | "replaced"): void {
		const stalledFor = entry.detector.stalledFor(this.#now());
		if (stalledFor !== null && entry.stallLogged) this.#log.info(`${entry.label}: the Chat page was ${how} after ${pageDuration(stalledFor)} without a report`);
	}

	#announceCaps(entry: Entry): void {
		if (entry.capsAnnounced) return;
		entry.capsAnnounced = true;
		this.#log.info(`${entry.label}: the Chat page has stalled or reported long tasks often; further stalls and long tasks of this page are not logged for the rest of its life`);
	}

	#logLongTask(entry: Entry, now: number, message: GuestPageHealthMessage): void {
		if (message.longTask === undefined) return;
		if (entry.longTasksLogged >= LONG_TASK_LOG_CAP) {
			this.#announceCaps(entry);
			return;
		}
		if (now - entry.lastLongTaskLoggedAt < LONG_TASK_LOG_GAP_MS) return;
		entry.longTasksLogged += 1;
		entry.lastLongTaskLoggedAt = now;
		this.#log.info(`${entry.label}: the Chat page ran one task for ${describeLongTask(message.longTask)}; its last events: ${describeEvents(message.events)}`);
	}
}
