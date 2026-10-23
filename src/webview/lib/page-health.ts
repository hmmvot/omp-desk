/**
 * The page's side of the liveness report (`omp:page-health`, `src/protocol/page-health.ts`).
 *
 * What it keeps is cheap: constant work per event, one timer while the page is visible, a ring of twelve counters, and two
 * `PerformanceObserver`s that the browser calls only for a task of 50 ms or more. Nothing it sends holds text of the conversation:
 * the ring has event kinds (`rx:<host message type>`, `render`, `key`, …) and the long-task attribution is reduced to shapes the
 * protocol module defines (a file name and position, a function identifier, the browser's invoker types), anything else being `-`.
 *
 * A report goes out at most every {@link PAGE_EVENT_POST_GAP_MS} when something happened and every {@link PAGE_BEAT_INTERVAL_MS}
 * whatever happened, because the most useful thing the host can quote after a freeze is what the page was doing just before it,
 * and a freeze sends nothing. The post happens in the event's own handler, before the work it announces: the message is already
 * on its way when the main thread stops.
 *
 * A hidden page (`document.visibilityState`) stops its beat timer and says so, so the host does not read the throttled timers of a
 * hidden page as a freeze; the timer starts again, with a report, when the page is visible. Host messages and redraws still run in
 * a hidden page; they are remembered in the ring and not posted.
 */
import {
	LONG_TASK_CONTAINERS,
	LONG_TASK_NAMES,
	PAGE_BEAT_INTERVAL_MS,
	PAGE_EVENT_POST_GAP_MS,
	PAGE_EVENT_RING_SIZE,
	PAGE_LONG_TASK_REPORT_MS,
	PAGE_LONG_TASK_SCRIPTS,
	SCRIPT_INVOKER_TYPES,
} from "../../protocol/page-health.ts";
import type { GuestPageHealthMessage, PageEventKind, PageHealthEvent, PageHealthReason, PageLongTask, PageLongTaskScript } from "../../protocol/page-health.ts";

const MAX_EVENT_COUNT = 1_000_000;
const MAX_MS = 86_400_000;
/** How long a long task waits for the long-animation-frame entry that names its scripts: the two observers deliver separately. */
export const LONG_TASK_JOIN_MS = 100;
/** Long animation frames remembered for that join. */
const FRAME_MEMORY = 4;

/** The kind of a host message the page received: the type when it has the form the protocol allows, `rx:other` otherwise. */
export function receivedKind(type: string): PageEventKind {
	const hostType: `omp:${string}` | null = /^omp:[a-z0-9-]{1,40}$/.test(type) ? (type as `omp:${string}`) : null;
	return hostType === null ? "rx:other" : `rx:${hostType}`;
}

/** The last events of the page as runs of one kind, newest last, bounded. */
export class PageEventRing {
	readonly #entries: { kind: PageEventKind; count: number; at: number }[] = [];

	note(kind: PageEventKind, now: number): void {
		const last = this.#entries[this.#entries.length - 1];
		if (last !== undefined && last.kind === kind) {
			if (last.count < MAX_EVENT_COUNT) last.count += 1;
			last.at = now;
			return;
		}
		this.#entries.push({ kind, count: 1, at: now });
		if (this.#entries.length > PAGE_EVENT_RING_SIZE) this.#entries.shift();
	}

	snapshot(now: number): PageHealthEvent[] {
		return this.#entries.map(entry => ({ kind: entry.kind, count: entry.count, agoMs: clampMs(now - entry.at) }));
	}
}

function clampMs(ms: number): number {
	return Math.min(MAX_MS, Math.max(0, Math.round(ms)));
}

/** What the heartbeat needs from its page, so a fake clock and a fake post test it. */
export interface HeartbeatEnvironment {
	now(): number;
	visible(): boolean;
	post(message: GuestPageHealthMessage): void;
	setTimer(callback: () => void, ms: number): unknown;
	clearTimer(handle: unknown): void;
}

/** Beats while visible, reports sooner when something happened, and reports a visibility change and a long task. */
export class PageHeartbeat {
	readonly #env: HeartbeatEnvironment;
	readonly #ring = new PageEventRing();
	#seq = 0;
	#lastPostAt = Number.NEGATIVE_INFINITY;
	#timer: unknown = null;
	#expectedAt = 0;
	#visible: boolean;
	#disposed = false;

	constructor(env: HeartbeatEnvironment) {
		this.#env = env;
		this.#visible = env.visible();
	}

	/** Report once and, when visible, start the beat. */
	start(): void {
		this.#post("beat");
		if (this.#visible) this.#schedule();
	}

	/** Remember one event; report it now if the last report is old enough. Runs inside the event's own handler. */
	note(kind: PageEventKind): void {
		if (this.#disposed) return;
		const now = this.#env.now();
		this.#ring.note(kind, now);
		if (this.#visible && now - this.#lastPostAt >= PAGE_EVENT_POST_GAP_MS) this.#post("events");
	}

	/** The page became visible or hidden: report it, and stop or restart the beat. */
	visibilityChanged(): void {
		if (this.#disposed) return;
		const visible = this.#env.visible();
		if (visible === this.#visible) return;
		this.#visible = visible;
		this.#ring.note(visible ? "visible" : "hidden", this.#env.now());
		// The overdue figure is taken before the timer is cancelled: a freeze that ends in a visibility change still says how long it was.
		const overdue = this.#overdue();
		this.#cancel();
		this.#post("visibility", undefined, overdue);
		if (visible) this.#schedule();
	}

	/** One long task, already joined with its attribution. */
	longTask(task: PageLongTask): void {
		if (this.#disposed) return;
		this.#post("long-task", task);
	}

	dispose(): void {
		this.#disposed = true;
		this.#cancel();
	}

	#schedule(): void {
		this.#expectedAt = this.#env.now() + PAGE_BEAT_INTERVAL_MS;
		this.#timer = this.#env.setTimer(() => this.#fire(), PAGE_BEAT_INTERVAL_MS);
	}

	#fire(): void {
		// The pending beat is still the pending one while this report is built, so its lateness is the report's.
		this.#post("beat");
		this.#timer = null;
		if (this.#visible && !this.#disposed) this.#schedule();
	}

	#cancel(): void {
		if (this.#timer !== null) this.#env.clearTimer(this.#timer);
		this.#timer = null;
	}

	/** How overdue the pending beat is: after a freeze the first report out says how long the page was stuck, whichever event it was. */
	#overdue(): number {
		return this.#timer === null ? 0 : clampMs(this.#env.now() - this.#expectedAt);
	}

	#post(reason: PageHealthReason, longTask?: PageLongTask, lateMs: number = this.#overdue()): void {
		const now = this.#env.now();
		this.#lastPostAt = now;
		const message: GuestPageHealthMessage = { type: "omp:page-health", reason, seq: this.#seq, visible: this.#visible, lateMs, events: this.#ring.snapshot(now), ...(longTask === undefined ? {} : { longTask }) };
		this.#seq += 1;
		try {
			this.#env.post(message);
		} catch {
			// A report that cannot be sent is not a page error; the next one tries again.
		}
	}
}

/** The fields of a `longtask` entry the report uses. */
export interface LongTaskEntryLike {
	readonly startTime: number;
	readonly duration: number;
	readonly name: string;
	readonly attribution?: ReadonlyArray<{ readonly containerType?: string }>;
}

/** The fields of a `long-animation-frame` entry the report uses. */
export interface FrameEntryLike {
	readonly startTime: number;
	readonly duration: number;
	readonly scripts?: ReadonlyArray<{
		readonly invoker?: string;
		readonly invokerType?: string;
		readonly sourceURL?: string;
		readonly sourceFunctionName?: string;
		readonly sourceCharPosition?: number;
		readonly duration: number;
	}>;
}

/**
 * An invoker in the shapes the protocol defines, or `-`: the browser's invoker type, then for a listener the element's tag and the
 * event handler (`BUTTON#send.onclick` is `event-listener:BUTTON.onclick`, so no id or class the page's content might have chosen,
 * and no `src` attribute, is reported), for a callback or a promise its own name (`TimerHandler:setTimeout`, `Promise.then`),
 * and nothing for a script, whose address is the report's `source`.
 */
export function normalizeInvoker(invokerType: string | undefined, invoker: string | undefined): string {
	if (invokerType === undefined || SCRIPT_INVOKER_TYPES[invokerType] !== true) return "-";
	const text = invoker ?? "";
	let detail = "-";
	if (invokerType === "event-listener") {
		const tag = /^[A-Za-z][A-Za-z0-9]{0,31}/.exec(text)?.[0];
		const handler = /\.(on[a-z]{1,30})$/.exec(text)?.[1];
		if (tag !== undefined && handler !== undefined) detail = `${tag}.${handler}`;
	} else if (invokerType === "user-callback" || invokerType === "resolve-promise" || invokerType === "reject-promise") {
		if (/^[A-Za-z][A-Za-z0-9]{0,31}(?::[A-Za-z]{1,31})?(?:\.[A-Za-z][A-Za-z0-9]{0,31}){0,2}$/.test(text)) detail = text;
	}
	return `${invokerType}:${detail}`;
}

/** A script's address as its file name and position: no folder, no query, no host, so no path of this machine; `-` for anything else. */
export function normalizeSource(url: string | undefined, position: number | undefined): string {
	const file = (url ?? "").split(/[?#]/)[0]?.split(/[/\\]/).pop() ?? "";
	if (!/^[A-Za-z0-9_.-]{1,48}$/.test(file)) return "-";
	const at = position === undefined ? -1 : Math.round(position);
	return at >= 0 && at <= 999_999_999 ? `${file}:${at}` : file;
}

/** A function name when it is an identifier, `-` otherwise. */
export function normalizeFunction(name: string | undefined): string {
	return name !== undefined && /^[A-Za-z_$][A-Za-z0-9_$]{0,47}$/.test(name) ? name : "-";
}

function scriptsOf(frame: FrameEntryLike | undefined): PageLongTaskScript[] {
	if (frame?.scripts === undefined) return [];
	return [...frame.scripts]
		.sort((a, b) => b.duration - a.duration)
		.slice(0, PAGE_LONG_TASK_SCRIPTS)
		.map(script => ({
			invoker: normalizeInvoker(script.invokerType, script.invoker),
			source: normalizeSource(script.sourceURL, script.sourceCharPosition),
			fn: normalizeFunction(script.sourceFunctionName),
			durationMs: clampMs(script.duration),
		}));
}

/**
 * Joins what the two observers deliver for one stall: the long task (how long, the browser's `name` and container) and the long
 * animation frame that overlapped it (which scripts ran). The task is reported {@link LONG_TASK_JOIN_MS} after it was seen, so the
 * frame, which the browser may deliver in another callback, has arrived; a browser without long animation frames reports the task alone.
 */
export class LongTaskJoin {
	readonly #frames: FrameEntryLike[] = [];
	readonly #report: (task: PageLongTask) => void;
	readonly #setTimer: (callback: () => void, ms: number) => unknown;

	constructor(report: (task: PageLongTask) => void, setTimer: (callback: () => void, ms: number) => unknown) {
		this.#report = report;
		this.#setTimer = setTimer;
	}

	frame(entry: FrameEntryLike): void {
		this.#frames.push(entry);
		if (this.#frames.length > FRAME_MEMORY) this.#frames.shift();
	}

	task(entry: LongTaskEntryLike): void {
		if (entry.duration < PAGE_LONG_TASK_REPORT_MS) return;
		this.#setTimer(() => {
			const end = entry.startTime + entry.duration;
			// The frame that contains the task: it starts no later than the task ends and ends no earlier than the task starts.
			const frame = [...this.#frames].reverse().find(candidate => candidate.startTime <= end + 50 && candidate.startTime + candidate.duration >= entry.startTime - 50);
			const container = entry.attribution?.[0]?.containerType;
			this.#report({
				durationMs: clampMs(entry.duration),
				name: LONG_TASK_NAMES[entry.name] === true ? entry.name : "unknown",
				...(container !== undefined && LONG_TASK_CONTAINERS[container] === true ? { container } : {}),
				scripts: scriptsOf(frame),
			});
		}, LONG_TASK_JOIN_MS);
	}
}

/** What {@link installPageHealth} needs from the transport: where reports go and a tap on every host message that arrives. */
export interface PageHealthTransport {
	post(message: GuestPageHealthMessage): boolean;
	/** Tell `tap` the type of every validated host message before it is handled; returns the function that stops it. */
	observeInbound(tap: (type: string) => void): () => void;
}

export interface PageHealthHandle {
	dispose(): void;
}

let active: PageHeartbeat | null = null;

/** Remember one event in the installed page health; nothing happens when none is installed. */
export function notePageEvent(kind: PageEventKind): void {
	active?.note(kind);
}

/** The user input kinds the page remembers: the kind only, never a key, a position or text. */
const INPUT_EVENTS: ReadonlyArray<readonly [string, PageEventKind]> = [
	["keydown", "key"],
	["pointerdown", "pointer"],
	["input", "input"],
	["paste", "paste"],
	["drop", "drop"],
];

/** Start reporting this page's liveness to the host through `transport`. */
export function installPageHealth(win: Window & typeof globalThis, transport: PageHealthTransport): PageHealthHandle {
	const heartbeat = new PageHeartbeat({
		now: () => win.performance.now(),
		visible: () => win.document.visibilityState === "visible",
		post: message => void transport.post(message),
		setTimer: (callback, ms) => win.setTimeout(callback, ms),
		clearTimer: handle => win.clearTimeout(handle as number),
	});
	active = heartbeat;
	const join = new LongTaskJoin(task => heartbeat.longTask(task), (callback, ms) => win.setTimeout(callback, ms));
	const stopTap = transport.observeInbound(type => heartbeat.note(receivedKind(type)));
	const onVisibility = (): void => heartbeat.visibilityChanged();
	win.document.addEventListener("visibilitychange", onVisibility);
	const unlisten: (() => void)[] = [];
	for (const [domEvent, kind] of INPUT_EVENTS) {
		const listener = (): void => heartbeat.note(kind);
		win.addEventListener(domEvent, listener, { capture: true, passive: true });
		unlisten.push(() => win.removeEventListener(domEvent, listener, { capture: true }));
	}
	const observers: PerformanceObserver[] = [];
	const supported = win.PerformanceObserver?.supportedEntryTypes ?? [];
	for (const [type, deliver] of [
		["long-animation-frame", (entry: PerformanceEntry) => join.frame(entry as unknown as FrameEntryLike)],
		["longtask", (entry: PerformanceEntry) => join.task(entry as unknown as LongTaskEntryLike)],
	] as const) {
		if (!supported.includes(type)) continue;
		try {
			const observer = new win.PerformanceObserver(list => {
				for (const entry of list.getEntries()) deliver(entry);
			});
			observer.observe({ type, buffered: false });
			observers.push(observer);
		} catch {
			// An entry type the browser lists and then refuses is not an error of the page.
		}
	}
	heartbeat.start();
	return {
		dispose(): void {
			heartbeat.dispose();
			if (active === heartbeat) active = null;
			stopTap();
			win.document.removeEventListener("visibilitychange", onVisibility);
			for (const remove of unlisten) remove();
			for (const observer of observers) observer.disconnect();
		},
	};
}
