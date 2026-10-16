import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_QUOTE_CHARACTERS, quoteSizeRefusal } from "./quote-limit.ts";

describe("the quote size limit", () => {
	it("refuses a selection over the limit with its size, grouped by thousands", () => {
		assert.equal(MAX_QUOTE_CHARACTERS, 20_000);
		assert.equal(quoteSizeRefusal(MAX_QUOTE_CHARACTERS), null);
		assert.equal(quoteSizeRefusal(31_482), "That selection is 31 482 characters; Quote takes at most 20 000.");
		assert.equal(quoteSizeRefusal(20_001), "That selection is 20 001 characters; Quote takes at most 20 000.");
	});
});
