/**
 * Host-sent quotes that arrive while the session is still starting. The host delivers an editor quote as soon as the Chat page has
 * announced itself, which for a session started by the quote itself is before the session is writable; refusing it then dropped
 * the quote ("This session cannot take a message") although the session was seconds from live. The composer holds it instead
 * and places it, by the usual rules, once the session has settled.
 */
import type { QuoteRequest } from "./quote-sink.ts";

/** How many quotes may wait; older ones are dropped first. */
export const MAX_HELD_QUOTES = 8;

export interface QuoteHold {
	/** Holds `request` when it is a host-sent editor quote and the session is settling; returns whether it was held. */
	hold(request: QuoteRequest, settling: boolean): boolean;
	/** The held quotes in arrival order, emptying the hold. */
	release(): QuoteRequest[];
}

export function createQuoteHold(): QuoteHold {
	const held: QuoteRequest[] = [];
	return {
		hold(request, settling) {
			if (request.kind !== "editor" || !settling) return false;
			held.push(request);
			while (held.length > MAX_HELD_QUOTES) held.shift();
			return true;
		},
		release: () => held.splice(0),
	};
}
