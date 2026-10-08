import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fmtDuration, fmtTokens } from "./format.ts";

describe("fmtDuration", () => {
	it("uses shared, spaced duration units", () => {
		assert.equal(fmtDuration(847), "847ms");
		assert.equal(fmtDuration(12_300), "12.3s");
		assert.equal(fmtDuration(245_000), "4m 05s");
		assert.equal(fmtDuration(3_720_000), "1h 02m");
		assert.equal(fmtDuration(-1), "0ms");
		assert.equal(fmtDuration(Number.NaN), "0ms");
	});

	it("never prints a 60 in a lower unit: the carry happens before the text is built", () => {
		assert.equal(fmtDuration(59_500), "59.5s");
		assert.equal(fmtDuration(59_950), "1m 00s", "round into the next minute before splitting units");
		assert.equal(fmtDuration(119_600), "2m 00s");
		assert.equal(fmtDuration(3_599_600), "1h 00m");
		assert.equal(fmtDuration(999.6), "1s");
		for (let ms = 0; ms < 4_000_000; ms += 137) assert.doesNotMatch(fmtDuration(ms), /^60s|m 60s|h 60m|^1000ms/, `${ms}ms`);
	});
});

describe("fmtTokens", () => {
	it("shares compact case-sensitive suffixes without trailing decimal zeros", () => {
		assert.equal(fmtTokens(1_000_000), "1M");
		assert.equal(fmtTokens(307_000), "307k");
		assert.equal(fmtTokens(12_300), "12.3k");
		assert.equal(fmtTokens(1_000), "1k");
		assert.equal(fmtTokens(950), "950");
		assert.equal(fmtTokens(Number.NaN), "0");
	});
});
