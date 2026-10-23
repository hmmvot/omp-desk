import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as entry from "./draft.ts";

/**
 * The ledger of the entry (see the comment at the top of `draft.ts`): every export is listed here with the group of
 * docs/designs/2026-10-23-composer-draft-module.md, section 6, whose commit removes it. A group that removes an export removes
 * its line here, so the list never drifts from the file; after group 3 only the kept names are left.
 */
const VALUES: Record<string, "kept" | 2 | 3> = {
	MAX_DRAFT_BYTES: 2,
	draftFromSentText: 2,
	fileReferencePattern: 2,
	findQuoteRuns: 2,
	findReferences: 2,
	imageReferenceLabel: 2,
	imageReferencePattern: 2,
	isKnownDocument: 2,
	placeQuote: 2,
	pruneInactive: 2,
	pruneInactiveDocuments: 2,
	quoteBlock: 2,
	quoteKeyEdit: 2,
	quoteLineCount: 2,
	quotePasteEdit: 2,
	quoteTitle: 2,
	referencedNumbers: 2,
	removalRange: 2,
	activeDocuments: 3,
	compactForSend: 3,
	documentChars: 3,
	rawTotal: 3,
	withState: 3,
	attach: "kept",
	attachGuardRefusal: "kept",
	commandResolver: "kept",
	createDraftCell: "kept",
	emptyDraft: "kept",
	fieldRules: "kept",
	knowsReference: "kept",
	readingBy: "kept",
	removeAttachment: "kept",
	viewOf: "kept",
};

const TYPES: Record<string, "kept" | 2 | 3> = {
	QuoteLineFlags: 2,
	QuoteRun: 2,
	AttachEntry: "kept",
	AttachEvents: "kept",
	AttachReader: "kept",
	AttachResult: "kept",
	Change: "kept",
	ChipSpan: "kept",
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
	Op: "kept",
	Outcome: "kept",
	Recoverable: "kept",
	ReferenceKind: "kept",
	ResolveCommand: "kept",
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
