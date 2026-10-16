/**
 * The composer's side of quoting (docs/designs/2026-10-15-quote-chat-selection.md, Section 2): the refusals, the edit and the
 * notice. The edit is one undo step at the end of the draft; a held draft capture refuses the quote (a deferral would be
 * lost when the capture ends in an editor replacement), an open IME composition defers it to its settle in the same editor.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { DraftSurface } from "./draft-surface.ts";
import { placeQuote, quoteBlock, quoteLineCount, quoteSizeRefusal } from "./quote-draft.ts";
import type { QuoteRequest } from "./quote-sink.ts";

/** How long the notice stays under the field. */
const NOTICE_MS = 5000;

/** What the quote needs to know about the composer, read at the moment it runs. */
export interface QuoteHost {
	readonly surface: () => DraftSurface | null;
	/** The draft hand-off holds the draft. */
	readonly captured: () => boolean;
	readonly composing: () => boolean;
	/** Runs `work` once the composition settles, in this editor. */
	readonly defer: (work: () => void) => void;
	/** The session can take a message. */
	readonly writable: () => boolean;
}

const HELD = "Your draft is being moved to a new editor; quote again in a moment";

export function useQuoteDraft(host: QuoteHost): { notice: string | null; quote: (request: QuoteRequest) => void } {
	const hostRef = useRef(host);
	hostRef.current = host;
	const [notice, setNotice] = useState<string | null>(null);
	const timer = useRef<number | undefined>(undefined);
	const say = useCallback((words: string): void => {
		clearTimeout(timer.current);
		setNotice(words);
		timer.current = window.setTimeout(() => setNotice(null), NOTICE_MS);
	}, []);
	useEffect(() => () => clearTimeout(timer.current), []);

	const quote = useCallback((request: QuoteRequest): void => {
		const current = hostRef.current;
		if (request.kind === "nothing") { say(request.message); return; }
		if (request.source.trim().length === 0) { say("Select text in the conversation first"); return; }
		if (current.surface() === null || !current.writable()) { say("This session cannot take a message"); return; }
		if (current.captured()) { say(HELD); return; }
		const tooLong = quoteSizeRefusal(request.source);
		if (tooLong !== null) { say(tooLong); return; }
		const place = (): void => {
			const now = hostRef.current;
			const surface = now.surface();
			if (surface === null) return;
			if (now.captured()) { say(HELD); return; }
			const block = quoteBlock(request.source);
			const placed = placeQuote(surface.text, block);
			if (placed === null) { say("That would make the draft longer than OMP Desk can send"); return; }
			if (!surface.apply({ from: placed.from, to: placed.to, insert: placed.insert, selection: { anchor: placed.caret, focus: placed.caret } }, "replace")) { say(HELD); return; }
			surface.focus();
			const lines = quoteLineCount(block);
			say(request.plain ? `Quoted ${lines} line${lines === 1 ? "" : "s"} as plain text` : `Quoted ${lines} line${lines === 1 ? "" : "s"} into the draft`);
		};
		if (current.composing()) current.defer(place);
		else place();
	}, [say]);

	return { notice, quote };
}
