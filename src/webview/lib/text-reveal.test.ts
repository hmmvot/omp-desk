import assert from "node:assert/strict";
import test from "node:test";
import { TextReveal, computeRevealStep, nextTextRevealFrame } from "./text-reveal.ts";

test("append growth never paints a partial ZWJ, combining, surrogate or regional-indicator cluster", () => {
	for (const [first, second, expected] of [
		["A👩", "A👩‍💻 ", "A👩‍💻"],
		["Ae", "Ae\u0301 ", "Ae\u0301"],
		["A\ud83d", "A😀 ", "A😀"],
		["A🇺", "A🇺🇸 ", "A🇺🇸"],
	] as const) {
		const slot = new TextReveal("");
		slot.retarget(first, true);
		slot.advance(250);
		assert.equal(slot.visible, "A");
		slot.retarget(second, true);
		slot.advance(250);
		assert.equal(slot.visible, expected);
		slot.flush();
		assert.equal(slot.visible, second);
	}
});

test("hydration/remount paints full text; replacements and nonpaced arrivals flush instead of replaying", () => {
	const hydrated = new TextReveal("History 👩‍💻");
	assert.equal(hydrated.visible, "History 👩‍💻");
	hydrated.retarget("History 👩‍💻 long append", true);
	assert.equal(hydrated.visible, "History 👩‍💻");
	hydrated.advance(16);
	assert.ok(hydrated.visible.length < "History 👩‍💻 long append".length);
	hydrated.retarget("Different reply", true);
	assert.equal(hydrated.visible, "Different reply");
	hydrated.retarget("Different reply complete", false);
	assert.equal(hydrated.visible, "Different reply complete");
	hydrated.retarget("", true);
	assert.equal(hydrated.visible, "");
	const unsupported = new TextReveal("", null);
	unsupported.retarget("Whole 👩‍💻 arrival", true);
	assert.equal(unsupported.visible, "Whole 👩‍💻 arrival");
});

test("60Hz clock carries remainder; elapsed/backlog policy settles stalls without overrun", () => {
	assert.equal(nextTextRevealFrame(0, 8), null);
	const frame = nextTextRevealFrame(0, 19)!;
	assert.ok(Math.abs(frame.at - 1000 / 60) < 1e-9);
	assert.equal(nextTextRevealFrame(frame.at, 25), null);
	assert.equal(computeRevealStep(100, -1), 0);
	assert.equal(computeRevealStep(100, 15), 10);
	assert.equal(computeRevealStep(100, 10000), 100);
	const slot = new TextReveal("");
	slot.retarget("The final held letter", true);
	for (let index = 0; index < 100; index++) slot.advance(17);
	assert.equal(slot.visible, "The final held lette");
	slot.flush();
	assert.equal(slot.visible, "The final held letter");
});
