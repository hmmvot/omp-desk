/**
 * The pure part of what the editing surface does with markers and chips (docs/designs/2026-10-23-composer-draft-module.md, section 4,
 * row `fieldRules`): which stretches of the draft are atomic, where a caret or a selection edge rests, what a deletion removes and how a
 * marker that a native edit damaged is put right. The surface keeps the DOM, the selection and the undo history and asks these rules.
 *
 * The two lookups are live: the real ones read the cell's current value and the catalogue, so an edit judged right after an attachment
 * was published never sees a stale set. A marker without an attachment, and a file marker whose whole label is not the document's
 * own, are prose and so are not chips; a command or skill is a chip only while the session's catalogue lists it.
 */
import { findFencedBlocks, type FencedBlock, type TextEdit } from "../code-fence.ts";
import { findChips, isBareChip, type ChipSpan, type ResolveCommand } from "./command-chips.ts";
import { deletionRange, repairDamagedReferences, snapSelection, type IsKnownReference } from "./image-references.ts";
import { quotePasteEdit } from "./quote-edits.ts";
import { findQuoteRuns, type QuoteLineFlags } from "./quote-lines.ts";

export interface FieldRules {
	/** Every chip of `text` in text order: attachment markers first, then the command or skill the draft names. */
	chips(text: string): ChipSpan[];
	/** The chips an edit removes whole: every chip except a bare command chip, which is still being typed and so is edited like text. */
	atomic(text: string): ChipSpan[];
	/** Whether `[from, to)` is exactly a bare command chip of `text`. */
	bareAt(text: string, from: number, to: number): boolean;
	/**
	 * `[start, end]` with every edge that falls strictly inside a chip moved to the chip's edge: a collapsed caret hops in its direction of
	 * travel (`forward` is `null` for the nearest edge, as after a pointer click) and a range grows to cover the chips it touches.
	 */
	snap(text: string, start: number, end: number, forward: boolean | null): { start: number; end: number };
	/** The range a deletion of `[from, to)` must remove so no atomic chip is cut, or `null` when the range already is whole. */
	deletion(text: string, from: number, to: number): { start: number; end: number } | null;
	/** `next` with every atomic chip of `previous` that a native edit damaged removed whole, plus the caret after the edit; `null` when none was hurt. */
	repair(previous: string, next: string): { text: string; caret: number } | null;
	/** The fenced blocks of `text` and the per-line quote flags the surface draws its bands from. */
	layout(text: string): { blocks: FencedBlock[]; quoteLines: readonly QuoteLineFlags[] };
	/** The edit that keeps a pasted, dropped or multi-character text that holds a line break inside the quote it lands in, or `null` when the text goes in as it is. */
	pasteEdit(text: string, pasted: string, start: number, end: number): TextEdit | null;
}

export function fieldRules(known: IsKnownReference, resolve: ResolveCommand): FieldRules {
	const chips = (text: string): ChipSpan[] => findChips(text, known, resolve);
	const atomic = (text: string): ChipSpan[] => chips(text).filter(span => !isBareChip(span));
	return {
		chips,
		atomic,
		bareAt: (text, from, to) => chips(text).some(span => isBareChip(span) && span.start === from && span.end === to),
		snap: (text, start, end, forward) => snapSelection(chips(text), start, end, forward),
		deletion: (text, from, to) => deletionRange(atomic(text), from, to, "range"),
		repair: (previous, next) => repairDamagedReferences(previous, next, atomic(previous)),
		layout(text) {
			const blocks = findFencedBlocks(text);
			return { blocks, quoteLines: findQuoteRuns(text, blocks).lines };
		},
		pasteEdit(text, pasted, start, end) {
			return quotePasteEdit(text, findQuoteRuns(text, findFencedBlocks(text)), pasted, start, end);
		},
	};
}
