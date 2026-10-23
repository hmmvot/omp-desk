/**
 * The composer's side of quoting (docs/designs/2026-10-15-quote-chat-selection.md, Section 2): the Draft's `quote` decides (the
 * refusals, the edit, the notice sentences); this hook runs it through the cell, holds a host-sent quote while the session is starting
 * and says what the Draft says. A held draft capture refuses the quote (a deferral would be lost when the capture ends in an editor
 * replacement), an open IME composition defers it to its settle in the same editor.
 */
import { useCallback, useEffect, useRef } from "react";
import type { ChatNoticeLevel } from "./chat-notices.ts";
import { QUOTE_HELD_NOTICE, quote as quoteOp, type DraftCell, type QuoteRequest } from "./draft/draft.ts";
import { createQuoteHold } from "./quote-hold.ts";

/** What the quote needs to know about the composer, read at the moment it runs. */
export interface QuoteHost {
	readonly cell: DraftCell;
	/** The session can take a message. */
	readonly writable: () => boolean;
	/** The session has not settled yet (starting, attaching, resyncing): a host-sent quote waits for it instead of being refused. */
	readonly settling: () => boolean;
	/** Shows a sentence about the quote where the page shows its notices, for a few seconds. */
	readonly notify: (words: string, level: ChatNoticeLevel) => void;
}

/** `settling` is the same fact as `host.settling()`, as render state: the held quotes are tried when it turns false. */
export function useQuoteDraft(host: QuoteHost, settling: boolean): { quote: (request: QuoteRequest) => void } {
	const hostRef = useRef(host);
	hostRef.current = host;
	const held = useRef(createQuoteHold());

	const quote = useCallback((request: QuoteRequest): void => {
		const { cell, writable, settling: isSettling, notify } = hostRef.current;
		cell.perform(quoteOp(request, { writable: writable(), settling: isSettling() }), { composing: "wait", held: "drop" }, outcome => {
			if (outcome.kind !== "applied") { notify(QUOTE_HELD_NOTICE, "warn"); return; }
			if (outcome.result.kind === "hold") held.current.hold(request);
			else if (outcome.result.kind === "notice") notify(outcome.result.text, outcome.result.level);
		});
	}, []);

	// A quote the host sent while the session was starting is placed (or refused, by the Draft's rules) once the session has settled.
	useEffect(() => {
		if (settling) return;
		for (const request of held.current.release()) quote(request);
	}, [settling, quote]);

	return { quote };
}
