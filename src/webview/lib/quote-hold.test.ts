/** Runner: `node --test src/webview/lib/quote-hold.test.ts` */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_HELD_QUOTES, createQuoteHold } from "./quote-hold.ts";
import type { QuoteRequest } from "./quote-sink.ts";

const editor = (text: string): QuoteRequest => ({ kind: "editor", sources: [text], size: text.length });

describe("quotes that arrive while the session is starting", () => {
	it("an editor quote is held while the session settles and released in order once it has", () => {
		const hold = createQuoteHold();
		assert.equal(hold.hold(editor("a"), true), true);
		assert.equal(hold.hold(editor("b"), true), true);
		assert.deepEqual(hold.release(), [editor("a"), editor("b")]);
		assert.deepEqual(hold.release(), [], "released once");
	});

	it("is not held when the session has settled, and a Chat selection or a notice is never held", () => {
		const hold = createQuoteHold();
		assert.equal(hold.hold(editor("a"), false), false);
		assert.equal(hold.hold({ kind: "selection", source: "s", plain: false }, true), false);
		assert.equal(hold.hold({ kind: "nothing", message: "m" }, true), false);
		assert.deepEqual(hold.release(), []);
	});

	it("drops the oldest beyond the limit", () => {
		const hold = createQuoteHold();
		for (let i = 0; i < MAX_HELD_QUOTES + 2; i++) hold.hold(editor(String(i)), true);
		const kept = hold.release();
		assert.equal(kept.length, MAX_HELD_QUOTES);
		assert.deepEqual(kept[0], editor("2"));
	});
});
