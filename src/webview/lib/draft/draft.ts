/**
 * The entry of the Draft module (docs/designs/2026-10-23-composer-draft-module.md): the only file of this directory that a
 * module outside it may import (`scripts/check-imports.mjs`, rules R-draft-1 and R-draft-2).
 *
 * The module owns the composer's draft rules: markers and attachments, quotes, completions, refills, the hand-off capture and
 * the send composition. It has no React and no DOM; node tests cross this file.
 *
 * Seams: the cell reaches the field through a `FieldPort` (`lib/draft-write.ts` over the surface of ADR-0077) and `attach` reads files
 * through an `AttachReader` (`lib/attach-reader.ts`); each has a fake in the node tests.
 *
 * The export list is final: the operations and types of the design's section 4 (`draft.test.ts` pins it). Nothing is re-exported for a
 * caller that has not moved.
 */

// The value, the cell and its field port, the field rules, the operations.
export { emptyDraft, knowsReference } from "./value.ts";
export type { Draft, DraftImage, Recoverable } from "./value.ts";
export { viewOf } from "./view.ts";
export type { DraftView } from "./view.ts";
export { createDraftCell } from "./cell.ts";
export type { DraftCell, DraftCellState } from "./cell.ts";
export type { Change, EditKind, FieldEdit, FieldPort, HistoryMode, Op, Outcome, Selection, Timing, Write } from "./field.ts";
export { fieldRules } from "./field-rules.ts";
export type { FieldRules } from "./field-rules.ts";
export { attach, readingBy, removeAttachment } from "./attach.ts";
export type { AttachEntry, AttachEvents, AttachReader, AttachResult } from "./attach.ts";
export type { DocumentRead, FileClass } from "./attached-documents.ts";
export type { ImageRead } from "./attachments.ts";
// The sentence of the attach count guard, which a refused drop of too many files shares (`lib/attach-dom.ts`).
export { attachGuardRefusal } from "./attachments.ts";
export type { DraftDocument } from "./draft-documents.ts";
export type { IsKnownReference, ReferenceKind } from "./image-references.ts";
export type { ChipSpan, ResolveCommand } from "./command-chips.ts";
export { commandResolver } from "./command-chips.ts";
export { keyEdit } from "./key-edit.ts";
export type { KeyContext, KeyEdit, KeyPress } from "./key-edit.ts";
export { acceptCompletion, completionAt, insertCommand } from "./completion.ts";
export type { CompletionRow, CompletionTokens } from "./completion.ts";
export { recall } from "./recall.ts";
export { clearText, cleared, insertText, restoreQueued, rewind, setEditorText } from "./refill.ts";
export type { Alerts, RewindAnswer } from "./refill.ts";
export type { RestoredQueued } from "./queue-merge.ts";
export { addRecoverable, dismissLost, dismissRecoverable, keepUnsent, restoreHandoff } from "./handoff.ts";
export { QUOTE_HELD_NOTICE, quote, removeQuote } from "./quote.ts";
export type { QuoteContext, QuoteRequest, QuoteResult } from "./quote.ts";
export { quoteTitle } from "./quote-draft.ts";
export type { QuoteLineFlags, QuoteRun } from "./quote-lines.ts";
export { compose, beginSend, settleSend } from "./compose.ts";
export type { Composition, LinkedContent, OutgoingMessage, SendContext, SendResult, Settled } from "./compose.ts";
export { addToDraft } from "./composition.ts";
