import assert from "node:assert/strict";
import { test } from "node:test";
import type { TranscriptCard } from "../../chat/transcript.ts";
import { measuredTranscriptRows } from "./transcript-layout.ts";
import { TranscriptHeightIndex } from "./transcript-virtualizer.ts";

test("cleared history disclosure invalidates its measured height when toggled", () => {
	const card: TranscriptCard = { kind: "entry", id: "clear", sourceIds: ["clear"], entry: { type: "reset_boundary", id: "clear", parentId: null, timestamp: "2026-10-11T00:00:00Z" } };
	const disclosures = new Map<string, boolean>();
	const rows = () => measuredTranscriptRows([card], new Map(), 840, disclosures, "session");
	const model = new TranscriptHeightIndex();
	const closed = rows();
	model.update(closed, "session");
	model.measure("clear", 40);
	disclosures.set("cleared:session:clear", true);
	const open = rows();
	assert.notDeepEqual(open[0]!.revision, closed[0]!.revision);
	model.update(open, "session");
	model.measure("clear", 500);
	assert.equal(model.update(rows(), "session").total, 500, "an unchanged disclosure retains its measured body");
	disclosures.set("cleared:session:clear", false);
	assert.equal(model.update(rows(), "session").total, closed[0]!.estimate, "closing cannot retain the expanded height");
});

test("a call whose card shows everything is estimated from its line count, and its revision follows the view", () => {
	const call = { type: "toolCall" as const, id: "c1", name: "bash", arguments: {} };
	const card = { kind: "tool", id: "tool:c1", sourceIds: ["c1"], ownership: "owned", tool: { call, entryId: "e", status: "complete", attachments: [] } } as unknown as Parameters<typeof measuredTranscriptRows>[0][number];
	const disclosures = new Map([["call:session:c1", true]]);
	let view: { full: boolean; rows: number } | undefined = { full: false, rows: 0 };
	const rows = () => measuredTranscriptRows([card], new Map(), 840, disclosures, "session", undefined, () => view);
	const preview = rows()[0]!;
	assert.equal(preview.estimate, 260);
	view = { full: true, rows: 4200 };
	const full = rows()[0]!;
	assert.equal(full.estimate, 90 + 4200 * 18, "a windowed block is its row count tall");
	assert.notDeepEqual(full.revision, preview.revision, "going full invalidates the measured height");
	view = { full: true, rows: 5000 };
	assert.notDeepEqual(rows()[0]!.revision, full.revision, "so does a change of its line count");
	disclosures.set("call:session:c1", false);
	assert.equal(rows()[0]!.estimate, 26, "a closed call is one row whatever it remembers");
});
