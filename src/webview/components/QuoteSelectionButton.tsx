/**
 * The floating Quote button (docs/designs/2026-10-15-quote-chat-selection.md, Sections 1 and 7): it exists only while the Chat's text
 * selection holds quotable message text and the composer can take a quote, sits at the end of the selection, and never takes the
 * selection or the focus (a pointer affordance: the key, the palette and the per-message buttons are its equivalents).
 */
import type { ReactNode } from "react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { quoteSelectionIntoDraft, hasQuotableText } from "../lib/quote-selection";
import { quoteReady, subscribeQuoteReady } from "../lib/quote-sink";

const GAP = 6;
const FALLBACK_SIZE = { width: 80, height: 26 };

export function QuoteSelectionButton(): ReactNode {
	const ready = useSyncExternalStore(subscribeQuoteReady, quoteReady);
	const [at, setAt] = useState<{ left: number; top: number } | null>(null);
	const button = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		if (!ready) { setAt(null); return undefined; }
		let frame = 0;
		const measure = (): void => {
			frame = 0;
			const region = document.querySelector(".omp-transcript");
			const selection = document.getSelection();
			if (region === null || selection === null || !hasQuotableText(selection, region)) { setAt(null); return; }
			const rects = selection.getRangeAt(0).getClientRects();
			const last = rects[rects.length - 1];
			if (last === undefined) { setAt(null); return; }
			const width = button.current?.offsetWidth ?? FALLBACK_SIZE.width;
			const height = button.current?.offsetHeight ?? FALLBACK_SIZE.height;
			const below = last.bottom + GAP + height <= window.innerHeight;
			const top = below ? last.bottom + GAP : Math.max(GAP, last.top - GAP - height);
			const left = Math.min(Math.max(GAP, last.right - width), Math.max(GAP, window.innerWidth - width - GAP));
			setAt(previous => (previous !== null && previous.left === left && previous.top === top ? previous : { left, top }));
		};
		const schedule = (): void => { if (frame === 0) frame = requestAnimationFrame(measure); };
		document.addEventListener("selectionchange", schedule);
		document.addEventListener("scroll", schedule, true);
		window.addEventListener("resize", schedule);
		schedule();
		return () => {
			if (frame !== 0) cancelAnimationFrame(frame);
			document.removeEventListener("selectionchange", schedule);
			document.removeEventListener("scroll", schedule, true);
			window.removeEventListener("resize", schedule);
		};
	}, [ready]);
	if (!ready || at === null) return null;
	return <button ref={button} type="button" className="omp-quote-selection" tabIndex={-1} aria-label="Quote selection in draft" aria-keyshortcuts="Alt+Q" title="Quote selection in draft (Alt+Q)" style={{ left: at.left, top: at.top }}
		// The press must not move the focus or collapse the selection it quotes.
		onMouseDown={event => event.preventDefault()}
		onClick={() => { quoteSelectionIntoDraft(); setAt(null); }}>
		<span className="codicon codicon-quote" aria-hidden="true" />Quote
	</button>;
}
