/**
 * Text the extension host adds to the composer draft: `omp:insert-text` (the `@path` references of "OMP Desk: Add File to Session",
 * and the `path:N` line reference of "OMP Desk: Quote Selection to Session" with nothing selected) and `omp:insert-quote` (the quotes
 * of "OMP Desk: Quote Selection to Session", handed to the quote sink).
 *
 * The registry lives here so it can be tested without a DOM: it holds a message that arrives before a composer is mounted (a session that has
 *   only just started renders its transcript first) and hands it over, once and in order, to
 *   the composer that mounts. A composer that is already mounted receives it immediately.
 *
 * Nothing here submits, and the text never reaches Webview state or a log.
 */
import type { GuestHostMessage } from "../../protocol/messages";
import { editorQuoteRequest } from "./editor-quote.ts";
import { offerQuote } from "./quote-sink.ts";

/** How many insertions may wait for a composer; older ones are dropped first. */
const MAX_PENDING = 8;

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
		if (message.type === "omp:insert-quote" && mode() === "chat") offerQuote(editorQuoteRequest(message.quotes));
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
