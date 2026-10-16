/**
 * Panel-local registry for quoting text into the draft (docs/designs/2026-10-15-quote-chat-selection.md).
 *
 * The composer owns the draft, so the host's `quote-selection` panel action (`Alt+Q`, the context menu item) asks it through this
 * registry and the composer decides: the refusals, the notice and the edit are the composer's. Like {@link providePanelActions},
 * the newest provider answers.
 */

/**
 * What to quote: the Markdown of a selection (`plain`: some part of it could only be quoted as the text it shows); the quotes of an
 * editor (`sources`: one Markdown per selection, each its own quote, and `size` the characters of the selected text, which the
 * size limit counts); or nothing, with the words that say why.
 */
export type QuoteRequest =
	| { readonly kind: "selection"; readonly source: string; readonly plain: boolean }
	| { readonly kind: "editor"; readonly sources: readonly string[]; readonly size: number }
	| { readonly kind: "nothing"; readonly message: string };

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
