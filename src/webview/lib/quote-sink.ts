/**
 * Panel-local registry for quoting text into the draft (docs/designs/2026-10-15-quote-chat-selection.md).
 *
 * The composer owns the draft, so the host's `quote-selection` panel action (`Alt+Q`, the context menu item) asks it through this
 * registry and the composer decides: the refusals, the notice and the edit are the composer's. Like {@link providePanelActions},
 * the newest provider answers.
 */

/** What to quote: the Markdown of a selection (`plain`: some part of it could only be quoted as the text it shows), or nothing, with the words that say why. */
export type QuoteRequest =
	| { readonly kind: "selection"; readonly source: string; readonly plain: boolean }
	| { readonly kind: "nothing"; readonly message: string };

type QuoteSink = (request: QuoteRequest) => void;

const sinks: QuoteSink[] = [];

/** Registers this composer's sink; call the returned function on unmount. */
export function provideQuoteSink(sink: QuoteSink): () => void {
	sinks.push(sink);
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
