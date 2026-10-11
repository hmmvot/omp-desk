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
