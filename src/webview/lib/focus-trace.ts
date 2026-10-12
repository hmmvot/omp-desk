/**
 * An attributable record of what moved the keyboard focus away from the composer.
 *
 * A user who reports "the composer lost focus while I was typing" gives the extension nothing to go on: the
 * page cannot be inspected afterwards and nothing in the host knows the page's focus. This module keeps a short
 * ring of what the page itself saw (focus moves, window focus and blur, a field being disabled or removed, the
 * caller of every `focus()` and `blur()`), and when the composer loses focus without a pointer press or a Tab or
 * Escape key, it posts that ring once, as one bounded line, for the host to write to the OMP Desk output.
 *
 * A normal keystroke, a window deactivation and the operating system giving the window focus back are not losses
 * and are never reported. Reports are rate-limited, so a page that loses focus in a loop cannot flood the log.
 */
import { MAX_FOCUS_TRACE_DETAIL_LENGTH } from "../../protocol/messages.ts";

/** Events remembered for the next report. */
export const TRACE_RING_SIZE = 16;
/** A pointer press or Tab/Escape key this recently counts as the user moving the focus. */
export const USER_ACTION_WINDOW_MS = 400;
/** The least time between two reports. */
export const TRACE_MIN_GAP_MS = 1000;
/** Reports one page may make in its lifetime. */
export const TRACE_MAX_REPORTS = 30;

interface RingEntry {
	readonly at: number;
	readonly text: string;
}

/** The ring, the user-action window and the rate limit; no DOM, so it is tested with a fake clock. */
export class FocusTrace {
	readonly #now: () => number;
	readonly #post: (line: string) => void;
	readonly #ring: RingEntry[] = [];
	#userAt = Number.NEGATIVE_INFINITY;
	#reportedAt = Number.NEGATIVE_INFINITY;
	#reports = 0;

	constructor(now: () => number, post: (line: string) => void) {
		this.#now = now;
		this.#post = post;
	}

	/** Remember one thing the page saw. */
	note(text: string): void {
		this.#ring.push({ at: this.#now(), text });
		if (this.#ring.length > TRACE_RING_SIZE) this.#ring.shift();
	}

	/** The user pressed a pointer button or a key that moves focus. */
	userMoved(): void {
		this.#userAt = this.#now();
	}

	/** Whether the user moved focus within {@link USER_ACTION_WINDOW_MS}. */
	get userRecently(): boolean {
		return this.#now() - this.#userAt <= USER_ACTION_WINDOW_MS;
	}

	/** Post `reason` with the ring; `false` when the rate limit held it back. */
	report(reason: string): boolean {
		const now = this.#now();
		if (this.#reports >= TRACE_MAX_REPORTS || now - this.#reportedAt < TRACE_MIN_GAP_MS) return false;
		this.#reports += 1;
		this.#reportedAt = now;
		const trail = this.#ring.map(entry => `-${Math.round(now - entry.at)}ms ${entry.text}`).reverse().join(" | ");
		this.#post(`${reason}${trail.length === 0 ? "" : ` | ${trail}`}`.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, MAX_FOCUS_TRACE_DETAIL_LENGTH));
		return true;
	}
}

/** `tag.firstClass` of an element, `none` for no element. */
export function describeElement(element: unknown): string {
	if (element === null || element === undefined) return "none";
	const node = element as { nodeType?: number; tagName?: string; classList?: { item(index: number): string | null }; id?: string };
	if (node.nodeType !== 1 || typeof node.tagName !== "string") return "window";
	const first = node.classList?.item(0);
	return `${node.tagName.toLowerCase()}${first ? `.${first}` : node.id ? `#${node.id}` : ""}`;
}

/** The first frame of `stack` that is not in this module, as `function@file:line`. */
export function callerOf(stack: string | undefined): string {
	for (const raw of (stack ?? "").split("\n").slice(1)) {
		const line = raw.trim();
		if (line.length === 0 || line.includes("focus-trace")) continue;
		const named = /^at (?:async )?(\S+) \((.*?)([^/\\():]+:\d+):\d+\)$/.exec(line);
		if (named !== null) return `${named[1]}@${named[3]}`;
		const bare = /^at (?:.*?)([^/\\():]+:\d+):\d+$/.exec(line);
		if (bare !== null) return bare[1] ?? "?";
		return line.slice(0, 80);
	}
	return "unknown";
}

export interface FocusTraceHandle {
	/** Remember one page-side event (a restore, the composer being disabled for a reason). */
	note(text: string): void;
	/** Post a report now, rate-limited. */
	report(reason: string): void;
	dispose(): void;
}

let active: FocusTraceHandle | null = null;

/** Remember one event in the installed trace; nothing happens when none is installed. */
export function traceNote(text: string): void {
	active?.note(text);
}

/** Report to the installed trace; nothing happens when none is installed. */
export function traceReport(reason: string): void {
	active?.report(reason);
}

/**
 * Watches `win` and reports a composer that lost focus without the user taking it.
 *
 * `isComposer` picks the element whose focus matters. `post` hands one line to the host.
 */
export function installFocusTrace(win: Window & typeof globalThis, isComposer: (element: Element) => boolean, post: (line: string) => void): FocusTraceHandle {
	const doc = win.document;
	const trace = new FocusTrace(() => performance.now(), post);
	let composer: Element | null = null;
	let held = false;

	const onFocusIn = (event: FocusEvent): void => {
		const target = event.target;
		trace.note(`in ${describeElement(target)}`);
		if (target instanceof win.Element && isComposer(target)) {
			composer = target;
			held = true;
		}
	};
	const onFocusOut = (event: FocusEvent): void => {
		const target = event.target;
		trace.note(`out ${describeElement(target)}->${describeElement(event.relatedTarget)}`);
		if (!(target instanceof win.Element) || !isComposer(target)) return;
		// The window being deactivated keeps the page's active element, so the composer still holds its place.
		if (doc.activeElement === target) return;
		// A field that was disabled is reported by the observer below, which knows why.
		if ((target as HTMLTextAreaElement).disabled) return;
		held = false;
		if (!trace.userRecently) trace.report(`composer lost focus to ${describeElement(event.relatedTarget)}`);
	};
	const onWindowFocus = (event: Event): void => {
		if (event.target === win) trace.note("window focus");
	};
	const onWindowBlur = (event: Event): void => {
		if (event.target === win) trace.note("window blur");
	};
	const onVisibility = (): void => trace.note(`visibility ${doc.visibilityState}`);
	const onUser = (): void => trace.userMoved();
	const onKey = (event: KeyboardEvent): void => {
		if (event.key === "Tab" || event.key === "Escape") trace.userMoved();
	};

	const proto = win.HTMLElement.prototype;
	const nativeFocus = proto.focus;
	const nativeBlur = proto.blur;
	proto.focus = function focusTraced(this: HTMLElement, options?: FocusOptions): void {
		trace.note(`focus() ${describeElement(this)} by ${callerOf(new Error().stack)}`);
		nativeFocus.call(this, options);
	};
	proto.blur = function blurTraced(this: HTMLElement): void {
		trace.note(`blur() ${describeElement(this)} by ${callerOf(new Error().stack)}`);
		nativeBlur.call(this);
	};

	const observer = new win.MutationObserver(records => {
		for (const record of records) {
			if (record.type === "attributes" && record.target instanceof win.Element && isComposer(record.target)) {
				const disabled = (record.target as HTMLTextAreaElement).disabled;
				trace.note(`${describeElement(record.target)} ${disabled ? "disabled" : "enabled"}`);
				if (disabled && held && record.target === composer) {
					held = false;
					trace.report("composer disabled while it held focus");
				}
			}
		}
		if (held && composer !== null && !composer.isConnected) {
			held = false;
			trace.note(`${describeElement(composer)} removed`);
			trace.report("composer removed while it held focus");
		}
	});
	observer.observe(doc.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["disabled"] });

	doc.addEventListener("focusin", onFocusIn, true);
	doc.addEventListener("focusout", onFocusOut, true);
	doc.addEventListener("pointerdown", onUser, true);
	doc.addEventListener("keydown", onKey, true);
	doc.addEventListener("visibilitychange", onVisibility, true);
	win.addEventListener("focus", onWindowFocus, true);
	win.addEventListener("blur", onWindowBlur, true);

	const handle: FocusTraceHandle = {
		note: text => trace.note(text),
		report: reason => void trace.report(reason),
		dispose() {
			if (active === handle) active = null;
			observer.disconnect();
			proto.focus = nativeFocus;
			proto.blur = nativeBlur;
			doc.removeEventListener("focusin", onFocusIn, true);
			doc.removeEventListener("focusout", onFocusOut, true);
			doc.removeEventListener("pointerdown", onUser, true);
			doc.removeEventListener("keydown", onKey, true);
			doc.removeEventListener("visibilitychange", onVisibility, true);
			win.removeEventListener("focus", onWindowFocus, true);
			win.removeEventListener("blur", onWindowBlur, true);
		},
	};
	active = handle;
	return handle;
}
