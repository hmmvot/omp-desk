/**
 * The Chat page's liveness report to the extension host: `omp:page-health`.
 *
 * A page whose main thread is stuck says nothing, and the host cannot tell that from a quiet page. The page therefore posts a
 * small report while it is visible (a beat every {@link PAGE_BEAT_INTERVAL_MS}, one sooner when something happens), and the host
 * logs the silence (`src/host/page-health.ts`). A report carries only facts the page can count: a bounded ring of the kinds of
 * thing it did last, how overdue its own timer was, and, for a long task, the browser's attribution of it. Every string is from a
 * vocabulary this module defines (ADR-0017's rule for diagnostic surfaces): an event kind is one of a closed list or a host message
 * type of the form `omp:<lowercase-and-dashes>`, a long task's `name` and `container` are the browser's fixed values, and a script
 * is a file name with a position, a function identifier and an invoker built from the browser's own invoker types. No message text,
 * draft, key, element id or folder reaches the host, whatever the page tries to send: a message with another shape is refused.
 *
 * The report travels the panel route only. A bridge route has no panel handle on the host side to answer for, and a surviving
 * page whose host restarted is not the case this diagnoses.
 */
import { isRecord } from "../shared/guards.ts";

/** How often a visible page reports with nothing else to say. */
export const PAGE_BEAT_INTERVAL_MS = 2_000;
/** The least time between two reports a page makes because something happened (an event, not the beat). */
export const PAGE_EVENT_POST_GAP_MS = 500;
/** How long a visible page may be silent before the host logs it as stalled. */
export const PAGE_STALL_THRESHOLD_MS = 10_000;
/** The shortest task the page reports as a long task (the platform's own threshold is 50 ms). */
export const PAGE_LONG_TASK_REPORT_MS = 1_000;
/** Events the page remembers for its next report. */
export const PAGE_EVENT_RING_SIZE = 12;
/** Scripts of a long animation frame one report names. */
export const PAGE_LONG_TASK_SCRIPTS = 3;

/** Why one report was sent: the timer's beat, an event that came after a quiet gap, a visibility change, or a long task. */
export type PageHealthReason = "beat" | "events" | "visibility" | "long-task";

/** The kinds of event that are not a host message: a redraw, an input kind (never which key or where), a visibility change. */
export type PageLocalEventKind = "render" | "key" | "pointer" | "input" | "paste" | "drop" | "visible" | "hidden";

/** What the page did: a local kind, or the type of a host message it received (`rx:other` for a type of another form). */
export type PageEventKind = PageLocalEventKind | `rx:omp:${string}` | "rx:other";

/** What the page did, as a kind and a run length: consecutive events of one kind are one entry. */
export interface PageHealthEvent {
	kind: PageEventKind;
	/** How many in a row. */
	count: number;
	/** How long before the report the last one happened. */
	agoMs: number;
}

/** One script the browser blames for a long animation frame. */
export interface PageLongTaskScript {
	/** `<invoker type>:<detail>`: the browser's invoker type with the callback or promise kind or the listener's `TAG.onevent`; `-` when unknown. */
	invoker: string;
	/** The file name of the script and the character position in it (`webview.js:812345`); `-` when unknown. */
	source: string;
	/** The function's identifier as the (minified) bundle has it; `-` when anonymous or not an identifier. */
	fn: string;
	durationMs: number;
}

/** A task that kept the page's main thread for at least {@link PAGE_LONG_TASK_REPORT_MS}. */
export interface PageLongTask {
	durationMs: number;
	/** The browser's `name` of the long-task entry (`self`, `same-origin-ancestor`, …), `unknown` for a value outside its list. */
	name: string;
	/** The container the browser attributes it to (`window`, `iframe`, `embed`, `object`), when it names one. */
	container?: string;
	/** The scripts of the long animation frame that overlapped it, longest first, when the browser reports those. */
	scripts: PageLongTaskScript[];
}

export interface GuestPageHealthMessage {
	type: "omp:page-health";
	reason: PageHealthReason;
	/** The page's own report counter, from 0 for a document's first report; a smaller or equal value than the last means a new document. */
	seq: number;
	/** Whether the page is visible (`document.visibilityState`) at the time of the report. */
	visible: boolean;
	/** How overdue the page's pending beat is at the time of the report, in ms (0 while it is not due, or while the page is hidden): after a freeze, the length of it. */
	lateMs: number;
	/** The page's last events, oldest first. */
	events: PageHealthEvent[];
	/** Present exactly when `reason` is `long-task`. */
	longTask?: PageLongTask;
}

const REASONS: Readonly<Record<string, true>> = Object.freeze({ beat: true, events: true, visibility: true, "long-task": true });
const LOCAL_KINDS: Readonly<Record<string, true>> = Object.freeze({ render: true, key: true, pointer: true, input: true, paste: true, drop: true, visible: true, hidden: true, "rx:other": true });
/** The values the platform defines for a long-task entry's `name` and its attribution's `containerType`; another value is sent as `unknown`. */
export const LONG_TASK_NAMES: Readonly<Record<string, true>> = Object.freeze({
	self: true, "same-origin-ancestor": true, "same-origin-descendant": true, "same-origin": true, "cross-origin-ancestor": true,
	"cross-origin-descendant": true, "cross-origin-unreachable": true, "multiple-contexts": true, unknown: true,
});
export const LONG_TASK_CONTAINERS: Readonly<Record<string, true>> = Object.freeze({ window: true, iframe: true, embed: true, object: true });
/** The invoker types of a long-animation-frame script; the callback or promise kind and the listener's `TAG.onevent` follow the colon. */
export const SCRIPT_INVOKER_TYPES: Readonly<Record<string, true>> = Object.freeze({
	"classic-script": true, "module-script": true, "event-listener": true, "user-callback": true, "resolve-promise": true, "reject-promise": true,
});
const MAX_SEQ = 2_147_483_647;
const MAX_MS = 86_400_000;
const MAX_COUNT = 1_000_000;
const HOST_MESSAGE_KIND = /^rx:omp:[a-z0-9-]{1,40}$/;
const INVOKER = /^(?:-|[a-z]+(?:-[a-z]+)*:(?:-|[A-Za-z][A-Za-z0-9]{0,31}(?::[A-Za-z]{1,31})?(?:\.[A-Za-z][A-Za-z0-9]{0,31}){0,2}))$/;
const SOURCE = /^(?:-|[A-Za-z0-9_.-]{1,48}(?::\d{1,9})?)$/;
const FUNCTION = /^(?:-|[A-Za-z_$][A-Za-z0-9_$]{0,47})$/;

function isCount(value: unknown, max: number): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
}

function matches(value: unknown, pattern: RegExp): value is string {
	return typeof value === "string" && pattern.test(value);
}

function parseEvents(value: unknown): PageHealthEvent[] | null {
	if (!Array.isArray(value) || value.length > PAGE_EVENT_RING_SIZE) return null;
	const events: PageHealthEvent[] = [];
	for (const entry of value) {
		if (!isRecord(entry) || typeof entry.kind !== "string") return null;
		if (LOCAL_KINDS[entry.kind] !== true && !HOST_MESSAGE_KIND.test(entry.kind)) return null;
		if (!isCount(entry.count, MAX_COUNT) || entry.count < 1 || !isCount(entry.agoMs, MAX_MS)) return null;
		events.push({ kind: entry.kind as PageEventKind, count: entry.count, agoMs: entry.agoMs });
	}
	return events;
}

function parseLongTask(value: unknown): PageLongTask | null {
	if (!isRecord(value) || !isCount(value.durationMs, MAX_MS)) return null;
	if (typeof value.name !== "string" || LONG_TASK_NAMES[value.name] !== true) return null;
	if (value.container !== undefined && (typeof value.container !== "string" || LONG_TASK_CONTAINERS[value.container] !== true)) return null;
	if (!Array.isArray(value.scripts) || value.scripts.length > PAGE_LONG_TASK_SCRIPTS) return null;
	const scripts: PageLongTaskScript[] = [];
	for (const script of value.scripts) {
		if (!isRecord(script) || !matches(script.invoker, INVOKER) || !matches(script.source, SOURCE) || !matches(script.fn, FUNCTION) || !isCount(script.durationMs, MAX_MS)) return null;
		const type = script.invoker.split(":")[0]!;
		if (script.invoker !== "-" && SCRIPT_INVOKER_TYPES[type] !== true) return null;
		scripts.push({ invoker: script.invoker, source: script.source, fn: script.fn, durationMs: script.durationMs });
	}
	return { durationMs: value.durationMs, name: value.name, ...(value.container === undefined ? {} : { container: value.container }), scripts };
}

/** Validate one page report; anything outside the shape above is `null`, and a field a page invented is dropped. */
export function parsePageHealthMessage(value: Record<string, unknown>): GuestPageHealthMessage | null {
	if (typeof value.reason !== "string" || REASONS[value.reason] !== true) return null;
	const reason = value.reason as PageHealthReason;
	if (!isCount(value.seq, MAX_SEQ) || typeof value.visible !== "boolean" || !isCount(value.lateMs, MAX_MS)) return null;
	const events = parseEvents(value.events);
	if (events === null) return null;
	const base = { type: "omp:page-health" as const, reason, seq: value.seq, visible: value.visible, lateMs: value.lateMs, events };
	if (reason !== "long-task") return value.longTask === undefined ? base : null;
	const longTask = parseLongTask(value.longTask);
	return longTask === null ? null : { ...base, longTask };
}
