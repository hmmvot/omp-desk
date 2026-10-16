/**
 * Panel-local registry for quoting text into the draft (docs/designs/2026-10-15-quote-chat-selection.md).
 *
 * The composer owns the draft, so every trigger (the per-message buttons, the floating button, the host's
 * `quote-selection` panel action) asks it through this registry and the composer decides: the same refusals, the same
 * notice, the same edit, whoever asked. Like {@link providePanelActions}, the newest provider answers.
 */

/** What to quote: the Markdown source of a whole message, of a selection (`plain`: some part of it could only be quoted as the text it shows), or nothing, with the words that say why. */
export type QuoteRequest =
	| { readonly kind: "message"; readonly source: string }
	| { readonly kind: "selection"; readonly source: string; readonly plain: boolean }
	| { readonly kind: "nothing"; readonly message: string };

type QuoteSink = (request: QuoteRequest) => void;

interface QuoteProvider {
	readonly sink: QuoteSink;
	/** The composer has a field that takes the quote now: mounted, writable, no dialog in its place. */
	readonly ready: () => boolean;
}

const providers: QuoteProvider[] = [];
const listeners = new Set<() => void>();

/** Tells everything that watches {@link quoteReady} to read it again. */
export function announceQuoteReady(): void {
	for (const listener of [...listeners]) listener();
}

/** Registers this composer's sink; call the returned function on unmount. */
export function provideQuoteSink(sink: QuoteSink, ready: () => boolean): () => void {
	const provider: QuoteProvider = { sink, ready };
	providers.push(provider);
	announceQuoteReady();
	return () => {
		const index = providers.indexOf(provider);
		if (index >= 0) providers.splice(index, 1);
		announceQuoteReady();
	};
}

/** Whether a composer is mounted and can take a quote now (the floating button shows only then). */
export function quoteReady(): boolean {
	return providers[providers.length - 1]?.ready() === true;
}

export function subscribeQuoteReady(listener: () => void): () => void {
	listeners.add(listener);
	return () => { listeners.delete(listener); };
}

/** Asks the panel's composer to quote; `false` when none is mounted (the caller says so). */
export function requestQuote(request: QuoteRequest): boolean {
	const provider = providers[providers.length - 1];
	if (provider === undefined) return false;
	provider.sink(request);
	return true;
}
