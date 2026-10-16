import { requestQuote } from "../lib/quote-sink";

/** Quotes a whole message into the draft: `source` is the message's Markdown, the same text Copy takes. The composer refuses an oversized quote and says so. */
export function QuoteMessageButton({ source, label, className, disabled = false, title }: { source: string; label: string; className: string; disabled?: boolean; title?: string }) {
	return <button type="button" className={className} disabled={disabled} aria-label={label} title={title ?? `${label} in the draft`} onClick={event => {
		event.stopPropagation();
		requestQuote({ kind: "message", source });
	}}><span className="codicon codicon-quote" aria-hidden="true" /></button>;
}
