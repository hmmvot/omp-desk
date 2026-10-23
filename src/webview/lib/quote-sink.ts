/**
 * Panel-local registry for quoting text into the draft (docs/designs/2026-10-15-quote-chat-selection.md).
 *
 * The composer owns the draft, so the host's `quote-selection` panel action (`Alt+Q`, the context menu item) asks it through this
 * registry and the Draft decides (`quote`, `lib/draft/`): the refusals, the notice and the edit. Like {@link providePanelActions},
 * the newest provider answers.
 */

import type { QuoteRequest } from "./draft/draft.ts";

type QuoteSink = (request: QuoteRequest) => void;

/** How many quote requests may wait for a composer; older ones are dropped first. */
const MAX_PENDING = 8;

const sinks: QuoteSink[] = [];
const pending: QuoteRequest[] = [];

/** Registers this composer's sink, which first takes what was held while no composer was mounted; call the returned function on unmount. */
export function provideQuoteSink(sink: QuoteSink): () => void {
	sinks.push(sink);
	for (const request of pending.splice(0)) sink(request);
	return () => {
		const index = sinks.indexOf(sink);
		if (index >= 0) sinks.splice(index, 1);
	};
}

/** Asks the panel's composer to quote; `false` when none is mounted (the caller says so). */
export function requestQuote(request: QuoteRequest): boolean {
	const sink = sinks[sinks.length - 1];
	if (sink === undefined) return false;
	sink(request);
	return true;
}

/**
 * Like {@link requestQuote}, but a request that finds no composer is held for the next one (a session that has only just started
 * renders its transcript first, and the host posts an editor quote as soon as the page has announced itself).
 */
export function offerQuote(request: QuoteRequest): void {
	if (requestQuote(request)) return;
	pending.push(request);
	while (pending.length > MAX_PENDING) pending.shift();
}
