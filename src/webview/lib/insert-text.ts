/**
 * Text the extension host adds to the composer draft (`omp:insert-text`): the `@path`
 * references of "OMP: Add Selection/File to Session".
 *
 * Two small pieces live here so they can be tested without a DOM:
 *
 * - {@link spaceInsertion} decides the exact string that goes into the textarea, so the
 *   reference never glues itself to the word before it (OMP only reads an `@` mention after
 *   whitespace or an opening bracket/quote) and typing can continue straight after it;
 * - the registry holds a message that arrives before a composer is mounted (a session that has
 *   only just started renders its transcript first) and hands it over, once and in order, to
 *   the composer that mounts. A composer that is already mounted receives it immediately.
 *
 * Nothing here submits, and the text never reaches Webview state or a log.
 */
import type { GuestHostMessage } from "../messages";

/** How many insertions may wait for a composer; older ones are dropped first. */
const MAX_PENDING = 8;

/** Whitespace as the mention grammar sees it. */
const SPACE = /\s/;

/** A space or tab straight after `end`: the draft already has the separator the caret should step over. */
export function followedByBlank(current: string, end: number): boolean {
	return end < current.length && (current[end] === " " || current[end] === "\t");
}

/**
 * `text` with the spacing the draft around `[start, end)` needs: one leading space unless the
 * draft is empty there or whitespace already precedes, and one trailing space unless a space or
 * tab already follows (a line break does not count: the caret must not rest right after a bare
 * `@path`, where the composer's own `@` popup would open and take the next Enter). When one already
 * follows, the caller moves the caret past it ({@link followedByBlank}).
 */
export function spaceInsertion(current: string, start: number, end: number, text: string): string {
	const body = text.trim();
	const lead = start > 0 && !SPACE.test(current[start - 1] as string) ? " " : "";
	const trail = followedByBlank(current, end) ? "" : " ";
	return `${lead}${body}${trail}`;
}

/** What this module needs from the page's host transport. */
interface InsertTransport {
	subscribe(listener: (message: GuestHostMessage) => void): () => void;
}

/**
 * Listen for `omp:insert-text` from the moment the document boots.
 *
 * Attached before the document announces itself (`omp:ready`), exactly like the chat client and
 * the session view: the host posts as soon as it has seen the announcement, and a listener that a
 * React effect registers after mount would miss a message posted in that gap. A page that shows
 * the native terminal has no composer and drops it.
 */
export function attachInsertedText(transport: InsertTransport, mode: () => "chat" | "terminal"): () => void {
	return transport.subscribe(message => {
		if (message.type === "omp:insert-text" && mode() === "chat") offerInsertedText(message.text);
	});
}

type InsertListener = (text: string) => void;

const listeners: InsertListener[] = [];
const pending: string[] = [];

/**
 * Deliver `text` to the newest mounted composer, or hold it for the next one.
 */
export function offerInsertedText(text: string): void {
	const listener = listeners[listeners.length - 1];
	if (listener !== undefined) {
		listener(text);
		return;
	}
	pending.push(text);
	while (pending.length > MAX_PENDING) pending.shift();
}

/**
 * Register a composer's insertion handler. Anything held while no composer existed is delivered
 * to it first; the returned function releases the handler.
 */
export function subscribeInsertedText(listener: InsertListener): () => void {
	listeners.push(listener);
	for (const text of pending.splice(0)) listener(text);
	return () => {
		const position = listeners.indexOf(listener);
		if (position >= 0) listeners.splice(position, 1);
	};
}
