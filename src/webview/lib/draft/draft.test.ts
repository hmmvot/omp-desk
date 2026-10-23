import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as entry from "./draft.ts";

/**
 * The ledger of the entry (see the comment at the top of `draft.ts`): every export is listed here with the group of
 * docs/designs/2026-10-23-composer-draft-module.md, section 6, whose commit removes it. A group that removes an export removes
 * its line here, so the list never drifts from the file; after group 3 only the kept names are left.
 */
const VALUES: Record<string, "kept" | 1 | 2> = {
	MAX_DRAFT_BYTES: 1,
	attachGuardRefusal: 1,
	dragCarries: 1,
	droppedFileUris: 1,
	fileFromAttached: 1,
	filesFrom: 1,
	rawTotal: 1,
	readImageAttachment: 1,
	sizeRejection: 1,
	classifyFile: 1,
	draftRoomRefusal: 1,
	readDocumentFile: 1,
	activeDocuments: 1,
	documentChars: 1,
	documentExtension: 1,
	documentIcon: 1,
	documentTooltip: 1,
	draftFromSentText: 1,
	isKnownDocument: 1,
	pruneInactiveDocuments: 1,
	activeImages: 1,
	compactForSend: 1,
	deletionRange: 1,
	fileReferencePattern: 1,
	findReferences: 1,
	imageReferenceLabel: 1,
	imageReferencePattern: 1,
	pruneInactive: 1,
	referencedNumbers: 1,
	repairDamagedReferences: 1,
	snapSelection: 1,
	findChips: 1,
	isBareChip: 1,
	findQuoteRuns: 2,
	isQuoteLineAt: 2,
	quoteKeyEdit: 2,
	quotePasteEdit: 2,
	placeQuote: 2,
	quoteBlock: 2,
	quoteLineCount: 2,
	quoteTitle: 2,
	removalRange: 2,
	commandResolver: "kept",
};

const TYPES: Record<string, "kept" | 1 | 2> = {
	PendingImage: 1,
	DraftDocument: "kept",
	IsKnownReference: "kept",
	ReferenceKind: "kept",
	ChipSpan: "kept",
	QuoteLineFlags: 2,
	QuoteRun: 2,
	ResolveCommand: "kept",
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
