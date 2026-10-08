import assert from "node:assert/strict";
import { test } from "node:test";
import { TranscriptHeightIndex, rowAt, visibleRowRanges, type MeasuredRow } from "./transcript-virtualizer.ts";

const rows = (count: number): MeasuredRow[] => Array.from({ length: count }, (_, index) => ({ id: `row-${index}`, sources: [`source-${index}`], revision: [index], estimate: 32 }));

test("10k loaded rows mount only viewport overscan, and distant focus remains an isolated exception", () => {
	const model = new TranscriptHeightIndex(), history = rows(10_000), layout = model.update(history, "chat:width-840:overview");
	const ranges = visibleRowRanges(layout, 160_000, 640, [3, 9999]);
	const mounted = ranges.flatMap(range => Array.from({ length: range.end - range.start }, (_, index) => range.start + index));
	assert.ok(mounted.includes(3) && mounted.includes(9999));
	assert.ok(mounted.includes(5000) && mounted.includes(5020));
	assert.ok(mounted.length <= 64, "focus cannot stretch the mounted window across the loaded history");
	assert.equal(mounted.includes(3000), false);
	assert.equal(rowAt(layout.offsets, layout.total), 9999);
	assert.equal(rowAt(layout.offsets, -100), 0);
});

test("measured heights move only later offsets, survive unrelated updates, and invalidate on content/layout changes", () => {
	const model = new TranscriptHeightIndex(), history = rows(100);
	model.update(history, "wide:overview:font-13");
	assert.equal(model.measure("row-10", 180), true);
	let layout = model.update(history.map(row => ({ ...row, revision: [...row.revision] })), "wide:overview:font-13");
	assert.equal(layout.offsets[10], 320);
	assert.equal(layout.offsets[11], 500);
	assert.equal(rowAt(layout.offsets, 490), 10);
	assert.equal(rowAt(layout.offsets, 500), 11);
	assert.equal(model.measure("row-10", 180.2), false);
	const changed = history.map((row, index) => index === 10 ? { ...row, revision: ["replacement"] } : row);
	layout = model.update(changed, "wide:overview:font-13");
	assert.equal(layout.offsets[11], 352);
	model.measure("row-10", 180);
	layout = model.update(changed, "narrow:detailed:font-18");
	assert.equal(layout.offsets[11], 352);
});

test("an anchor can be remounted after a prepend without retaining the intervening DOM", () => {
	const model = new TranscriptHeightIndex(), history = rows(10_000);
	let layout = model.update(history, "chat");
	const source = "source-5000", offset = -7;
	const before = history.findIndex(row => row.sources.includes(source));
	assert.ok(visibleRowRanges(layout, layout.offsets[before]! - offset, 640).some(range => before >= range.start && before < range.end));
	const prepended = [...rows(100).map(row => ({ ...row, id: `older-${row.id}`, sources: [`older-${row.id}`] })), ...history];
	layout = model.update(prepended, "chat");
	const after = prepended.findIndex(row => row.sources.includes(source));
	const ranges = visibleRowRanges(layout, layout.offsets[after]! - offset, 640);
	assert.ok(ranges.some(range => after >= range.start && after < range.end));
	assert.ok(ranges.reduce((count, range) => count + range.end - range.start, 0) <= 62);
});
