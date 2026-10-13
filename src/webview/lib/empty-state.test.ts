/** What the empty chat shows of a folder and of a conversation's age. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { folderName, shortAge } from "./empty-state.ts";

const NOW = Date.UTC(2026, 9, 13, 12, 0, 0);
const minutes = (count: number): number => NOW - count * 60_000;

describe("shortAge", () => {
	it("is one short unit: now, minutes, hours, days, months, years", () => {
		assert.equal(shortAge(NOW, NOW), "now");
		assert.equal(shortAge(minutes(0.5), NOW), "now");
		assert.equal(shortAge(minutes(1), NOW), "1m");
		assert.equal(shortAge(minutes(59), NOW), "59m");
		assert.equal(shortAge(minutes(120), NOW), "2h");
		assert.equal(shortAge(minutes(24 * 60), NOW), "1d");
		assert.equal(shortAge(minutes(3 * 24 * 60), NOW), "3d");
		assert.equal(shortAge(minutes(65 * 24 * 60), NOW), "2mo");
		assert.equal(shortAge(minutes(800 * 24 * 60), NOW), "2y");
	});

	it("never shows a negative age for a clock that is ahead", () => {
		assert.equal(shortAge(NOW + 5 * 60_000, NOW), "now");
		assert.equal(shortAge(Number.NaN, NOW), "now");
	});
});

describe("folderName", () => {
	it("is the last path segment, whichever separator and with or without a trailing one", () => {
		assert.equal(folderName("D:/work/alpha-desk"), "alpha-desk");
		assert.equal(folderName("D:\\work\\alpha-desk\\"), "alpha-desk");
		assert.equal(folderName("/home/me/app//"), "app");
		assert.equal(folderName("app"), "app");
		assert.equal(folderName("/"), "/");
	});
});
