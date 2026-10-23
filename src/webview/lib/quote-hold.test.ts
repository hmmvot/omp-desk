/** Runner: `node --test src/webview/lib/quote-hold.test.ts` */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_HELD_QUOTES, createQuoteHold } from "./quote-hold.ts";
import type { QuoteRequest } from "./draft/draft.ts";

const editor = (text: string): QuoteRequest => ({ kind: "editor", sources: [text], size: text.length });

describe("quotes that arrive while the session is starting", () => {
	it("a held quote is released in order once, when the session has settled", () => {
		const hold = createQuoteHold();
		hold.hold(editor("a"));
		hold.hold(editor("b"));
		assert.deepEqual(hold.release(), [editor("a"), editor("b")]);
		assert.deepEqual(hold.release(), [], "released once");
	});

	it("drops the oldest beyond the limit", () => {
		const hold = createQuoteHold();
		for (let i = 0; i < MAX_HELD_QUOTES + 2; i++) hold.hold(editor(String(i)));
		const kept = hold.release();
		assert.equal(kept.length, MAX_HELD_QUOTES);
		assert.deepEqual(kept[0], editor("2"));
	});
});
