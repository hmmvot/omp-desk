/**
 * What the composer draws and gates on, derived from the Draft and the caret (docs/designs/2026-10-23-composer-draft-module.md,
 * section 4, row `viewOf`): the attachments whose marker is in the text, the fenced blocks and quote runs of the text, and where the
 * caret is among them.
 */
import { blockContaining, findFencedBlocks, type FencedBlock } from "../code-fence.ts";
import { activeDocuments, type DraftDocument } from "./draft-documents.ts";
import { activeImages } from "./image-references.ts";
import { findQuoteRuns, isQuoteLineAt, type QuoteLayout } from "./quote-lines.ts";
import type { Draft, DraftImage } from "./value.ts";

export interface DraftView {
	/** Images whose marker is in the text: what the strip shows and a send carries, in number order. */
	readonly images: readonly DraftImage[];
	/** Documents whose marker is in the text, in number order. */
	readonly documents: readonly DraftDocument[];
	/** The fenced code blocks of the text. */
	readonly blocks: readonly FencedBlock[];
	/** The quote lines of the text (bands outside the fenced blocks). */
	readonly quote: QuoteLayout;
	/** The block the caret is in: its keys are an editor's and no completion opens in it. */
	readonly caretBlock: FencedBlock | null;
	/** The caret is on a quote line: it holds text the agent wrote, so no completion opens in it. */
	readonly caretInQuote: boolean;
	/** There is something to send: text beyond blanks, or an attachment whose marker is in the text. */
	readonly hasContent: boolean;
	/** The draft holds nothing at all, retained attachments included: what Esc Esc may open Rewind over. */
	readonly untouched: boolean;
}

/** The parts of a view that do not depend on the caret, kept for the draft they were scanned from. */
interface Scan {
	readonly text: string;
	readonly images: readonly DraftImage[];
	readonly documents: readonly DraftDocument[];
	readonly active: { readonly images: readonly DraftImage[]; readonly documents: readonly DraftDocument[] };
	readonly blocks: readonly FencedBlock[];
	readonly quote: QuoteLayout;
}

let lastScan: Scan | null = null;

/** The scan of `draft`, reused while only the caret moves: a caret is read far more often than the text changes. */
function scanOf(draft: Draft): Scan {
	const last = lastScan;
	if (last !== null && last.text === draft.text && last.images === draft.images && last.documents === draft.documents) return last;
	const blocks = findFencedBlocks(draft.text);
	const scan: Scan = {
		text: draft.text,
		images: draft.images,
		documents: draft.documents,
		active: { images: activeImages(draft.text, draft.images), documents: activeDocuments(draft.text, draft.documents) },
		blocks,
		quote: findQuoteRuns(draft.text, blocks),
	};
	lastScan = scan;
	return scan;
}

export function viewOf(draft: Draft, caret: number): DraftView {
	const { active, blocks, quote } = scanOf(draft);
	return {
		images: active.images,
		documents: active.documents,
		blocks,
		quote,
		caretBlock: blockContaining(blocks, caret),
		caretInQuote: isQuoteLineAt(quote, draft.text, caret),
		hasContent: draft.text.trim().length > 0 || active.images.length > 0 || active.documents.length > 0,
		untouched: draft.text.length === 0 && draft.images.length === 0 && draft.documents.length === 0,
	};
}
