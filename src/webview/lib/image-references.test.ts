import assert from "node:assert/strict";
import { test } from "node:test";
import {
	activeImages,
	compactForSend,
	deletionRange,
	draftSegments,
	findImageReferences,
	imageReferenceLabel,
	pruneInactive,
	repairDamagedReferences,
	snapSelection,
} from "./image-references.ts";

const all = (): boolean => true;
const image = (number: number, bytes = 10): { number: number; bytes: number } => ({ number, bytes });

test("the marker is exactly the TUI's `[Image #N, WxH]`, bare when the size is unknown", () => {
	assert.equal(imageReferenceLabel(1, { width: 589, height: 200 }), "[Image #1, 589x200]");
	assert.equal(imageReferenceLabel(3), "[Image #3]");
	const text = "a [Image #1, 589x200] b [Image #2] c [Image #0] d [Image #x]";
	assert.deepEqual(findImageReferences(text, all).map(span => span.number), [1, 2]);
	assert.deepEqual(findImageReferences(text, number => number === 2).map(span => text.slice(span.start, span.end)), ["[Image #2]"]);
});

test("a caret hops out of a marker in its direction of travel; a range grows to cover the markers it touches", () => {
	const text = "ab [Image #1] cd";
	const [span] = findImageReferences(text, all);
	assert.ok(span);
	assert.deepEqual(snapSelection([span], span.end - 2, span.end - 2, true), { start: span.end, end: span.end });
	assert.deepEqual(snapSelection([span], span.end - 2, span.end - 2, false), { start: span.start, end: span.start });
	assert.deepEqual(snapSelection([span], span.start + 1, span.start + 1, null), { start: span.start, end: span.start });
	assert.deepEqual(snapSelection([span], 1, span.start + 3, null), { start: 1, end: span.end });
	assert.deepEqual(snapSelection([span], span.start, span.end, null), { start: span.start, end: span.end });
});

test("Backspace after and Delete before a marker remove it whole; unrelated deletions stay the browser's", () => {
	const text = "x [Image #1, 5x5] y";
	const spans = findImageReferences(text, all);
	const [span] = spans;
	assert.ok(span);
	assert.deepEqual(deletionRange(spans, span.end, span.end, "backward"), { start: span.start, end: span.end });
	assert.deepEqual(deletionRange(spans, span.start, span.start, "forward"), { start: span.start, end: span.end });
	assert.equal(deletionRange(spans, span.end, span.end, "forward"), null);
	assert.equal(deletionRange(spans, span.start, span.start, "backward"), null);
	assert.deepEqual(deletionRange(spans, 0, span.start + 2, "range"), { start: 0, end: span.end });
	assert.equal(deletionRange(spans, 0, 1, "range"), null);
});

test("a damaged marker is removed whole, an exact removal is left alone", () => {
	const text = "x [Image #1, 5x5] y";
	const spans = findImageReferences(text, all);
	const [span] = spans;
	assert.ok(span);
	assert.equal(repairDamagedReferences(text, text.slice(0, span.start) + text.slice(span.end), spans), null);
	const wordDelete = text.slice(0, span.start + 3) + text.slice(span.end - 3);
	assert.deepEqual(repairDamagedReferences(text, wordDelete, spans), { text: "x  y", caret: 2 });
	const typedInside = text.slice(0, span.start + 4) + "Z" + text.slice(span.start + 4);
	assert.deepEqual(repairDamagedReferences(text, typedInside, spans), { text: "x Z y", caret: 3 });
	assert.equal(repairDamagedReferences(text, text + "!", spans), null);
});

test("images without a marker are not carried; surviving markers are renumbered densely in number order", () => {
	const images = [image(1), image(2), image(3)];
	const text = "see [Image #3, 9x9] and [Image #1, 4x4]";
	assert.deepEqual(activeImages(text, images).map(item => item.number), [1, 3]);
	const sent = compactForSend(text, images);
	assert.equal(sent.text, "see [Image #2, 9x9] and [Image #1, 4x4]");
	assert.deepEqual(sent.images.map(item => item.number), [1, 3]);
	assert.equal(compactForSend("no images here [Image #7]", images).text, "no images here [Image #7]", "an unknown number stays text");
	assert.deepEqual(compactForSend("[Image #2] twice [Image #2]", images).text, "[Image #1] twice [Image #1]");
});

test("deleted images are released oldest first and only when the draft would exceed its budget", () => {
	const images = [image(1, 40), image(2, 40), image(3, 40)];
	const active = new Set([3]);
	assert.equal(pruneInactive(images, number => active.has(number), new Set(), 200).length, 3);
	assert.deepEqual(pruneInactive(images, number => active.has(number), new Set(), 100).map(item => item.number), [2, 3]);
	assert.deepEqual(pruneInactive(images, number => active.has(number), new Set([2]), 100).map(item => item.number), [2, 3], "a protected image survives");
});

test("draft segments split exactly at the markers", () => {
	const text = "a [Image #1] b";
	assert.deepEqual(draftSegments(text, findImageReferences(text, all)), [
		{ marker: false, text: "a " },
		{ marker: true, text: "[Image #1]", number: 1 },
		{ marker: false, text: " b" },
	]);
});
