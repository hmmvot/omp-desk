/**
 * The entry of the Draft module (docs/designs/2026-10-23-composer-draft-module.md): the only file of this directory that a
 * module outside it may import (`scripts/check-imports.mjs`, rules R-draft-1 and R-draft-2).
 *
 * The module owns the composer's draft rules: markers and attachments, quotes, completions, refills, the hand-off capture and
 * the send composition. It has no React and no DOM; node tests cross this file.
 *
 * LEDGER OF TRANSITIONAL EXPORTS. While the design's migration groups land, this file re-exports the helpers that the code
 * outside the module still calls, so that moving a file is a mechanical change. Each line below names the group of the design
 * (section 6) whose commit removes it; after group 3 this file exports only the operations and types of the design's
 * section 4 (`draft.test.ts` pins the list).
 */

// Group 1 removes: the image and document attachment rules become the Draft value and `attach`, `removeAttachment`.
export {
	MAX_DRAFT_BYTES,
	attachGuardRefusal,
	dragCarries,
	droppedFileUris,
	fileFromAttached,
	filesFrom,
	rawTotal,
	readImageAttachment,
	sizeRejection,
} from "./attachments.ts";
export type { PendingImage } from "./attachments.ts";
export { classifyFile, draftRoomRefusal, readDocumentFile } from "./attached-documents.ts";
export {
	activeDocuments,
	documentChars,
	documentExtension,
	documentIcon,
	documentTooltip,
	draftFromSentText,
	isKnownDocument,
	pruneInactiveDocuments,
} from "./draft-documents.ts";
export type { DraftDocument } from "./draft-documents.ts";
export {
	activeImages,
	compactForSend,
	deletionRange,
	fileReferencePattern,
	findReferences,
	imageReferenceLabel,
	imageReferencePattern,
	pruneInactive,
	referencedNumbers,
	repairDamagedReferences,
	snapSelection,
} from "./image-references.ts";
export type { IsKnownReference, ReferenceKind } from "./image-references.ts";
export { findChips, isBareChip } from "./command-chips.ts";
export type { ChipSpan } from "./command-chips.ts";

// Group 2 removes: quotes and the key rules of fenced blocks and quote lines become operations of the Draft.
export { findQuoteRuns, isQuoteLineAt } from "./quote-lines.ts";
export type { QuoteLineFlags, QuoteRun } from "./quote-lines.ts";
export { quoteKeyEdit, quotePasteEdit } from "./quote-edits.ts";
export { placeQuote, quoteBlock, quoteLineCount, quoteTitle, removalRange } from "./quote-draft.ts";

// Kept in the final interface: the catalogue's resolver of command and skill chips.
export { commandResolver } from "./command-chips.ts";
export type { ResolveCommand } from "./command-chips.ts";
