import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as entry from "./draft.ts";

/**
 * The ledger of the entry (see the comment at the top of `draft.ts`): every export is listed here, the transitional ones with the group of
 * docs/designs/2026-10-23-composer-draft-module.md, section 6, whose commit removes them (`3`). Group 3 removes those lines, so the
 * list never drifts from the file; afterwards only the kept names are left.
 */
const VALUES: Record<string, "kept" | 3> = {
	MAX_DRAFT_BYTES: 3,
	activeDocuments: 3,
	compactForSend: 3,
	documentChars: 3,
	rawTotal: 3,
	withState: 3,
	acceptCompletion: "kept",
	addRecoverable: "kept",
	attach: "kept",
	attachGuardRefusal: "kept",
	clearText: "kept",
	cleared: "kept",
	commandResolver: "kept",
	completionAt: "kept",
	createDraftCell: "kept",
	dismissLost: "kept",
	dismissRecoverable: "kept",
	emptyDraft: "kept",
	fieldRules: "kept",
	insertCommand: "kept",
	insertText: "kept",
	keyEdit: "kept",
	knowsReference: "kept",
	quote: "kept",
	QUOTE_HELD_NOTICE: "kept",
	quoteTitle: "kept",
	readingBy: "kept",
	recall: "kept",
	removeAttachment: "kept",
	removeQuote: "kept",
	restoreHandoff: "kept",
	restoreQueued: "kept",
	rewind: "kept",
	setEditorText: "kept",
	viewOf: "kept",
};

const TYPES: Record<string, "kept"> = {
	Alerts: "kept",
	AttachEntry: "kept",
	AttachEvents: "kept",
	AttachReader: "kept",
	AttachResult: "kept",
	Change: "kept",
	ChipSpan: "kept",
	CompletionRow: "kept",
	CompletionTokens: "kept",
	DocumentRead: "kept",
	Draft: "kept",
	DraftCell: "kept",
	DraftCellState: "kept",
	DraftDocument: "kept",
	DraftImage: "kept",
	DraftView: "kept",
	EditKind: "kept",
	FieldEdit: "kept",
	FieldPort: "kept",
	FieldRules: "kept",
	FileClass: "kept",
	HistoryMode: "kept",
	ImageRead: "kept",
	IsKnownReference: "kept",
	KeyContext: "kept",
	KeyEdit: "kept",
	KeyPress: "kept",
	Op: "kept",
	Outcome: "kept",
	QuoteContext: "kept",
	QuoteLineFlags: "kept",
	QuoteRequest: "kept",
	QuoteResult: "kept",
	QuoteRun: "kept",
	Recoverable: "kept",
	ReferenceKind: "kept",
	ResolveCommand: "kept",
	RestoredQueued: "kept",
	RewindAnswer: "kept",
	Selection: "kept",
	Timing: "kept",
	Write: "kept",
};

test("the entry exports exactly the listed values", () => {
	assert.deepEqual(Object.keys(entry).sort(), Object.keys(VALUES).sort());
});

test("the entry exports exactly the listed types", () => {
	const source = readFileSync(new URL("./draft.ts", import.meta.url), "utf8");
	const found: string[] = [];
	for (const match of source.matchAll(/^export type \{([^}]*)\}/gm)) {
		for (const name of match[1]!.split(",").map(part => part.trim()).filter(Boolean)) found.push(name);
	}
	assert.deepEqual(found.sort(), Object.keys(TYPES).sort());
});
