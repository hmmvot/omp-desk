/**
 * Host-added references reach the composer once, in order, and never glue to a word.
 *
 * Runner: `node --test src/webview/lib/insert-text.test.ts`
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { GuestHostMessage } from "../messages.ts";
import { attachInsertedText, followedByBlank, offerInsertedText, spaceInsertion, subscribeInsertedText } from "./insert-text.ts";

describe("spaceInsertion", () => {
	it("adds no space at the start of an empty draft, but one after it so typing can continue", () => {
		assert.equal(spaceInsertion("", 0, 0, "@a.ts"), "@a.ts ");
	});

	it("separates the reference from the word before it, which OMP would otherwise not read as a mention", () => {
		assert.equal(spaceInsertion("look at", 7, 7, "@a.ts [line 3]"), " @a.ts [line 3] ");
	});

	it("reuses whitespace that is already there on either side, stepping the caret over a following blank", () => {
		assert.equal(spaceInsertion("fix  the bug", 4, 4, "@a.ts"), "@a.ts");
		assert.equal(followedByBlank("fix  the bug", 4), true);
		assert.equal(spaceInsertion("fix", 3, 3, "@a.ts"), " @a.ts ");
		assert.equal(followedByBlank("fix", 3), false);
	});

	it("still adds a trailing space before a line break, so the caret never rests right after a bare @path", () => {
		assert.equal(spaceInsertion("fix \nthe bug", 4, 4, "@a.ts"), "@a.ts ");
		assert.equal(followedByBlank("fix \nthe bug", 4), false);
	});

	it("replaces a selection, spacing against what surrounds it", () => {
		const draft = "see THIS now";
		assert.equal(draft.slice(0, 4) + spaceInsertion(draft, 4, 8, "@a.ts") + draft.slice(8), "see @a.ts now");
		assert.equal(spaceInsertion("see THISnow", 4, 8, "@a.ts"), "@a.ts ");
	});
});

describe("the insertion registry", () => {
	it("holds an insertion that arrives before a composer exists and delivers it, in order, to the first one", () => {
		offerInsertedText("@first");
		offerInsertedText("@second");
		const received: string[] = [];
		const release = subscribeInsertedText(text => received.push(text));
		assert.deepEqual(received, ["@first", "@second"]);
		offerInsertedText("@third");
		assert.deepEqual(received, ["@first", "@second", "@third"]);
		release();
		// Nothing is replayed to a later composer: it was consumed.
		const later: string[] = [];
		subscribeInsertedText(text => later.push(text))();
		assert.deepEqual(later, []);
	});

	it("delivers to the newest composer only", () => {
		const older: string[] = [];
		const newer: string[] = [];
		const releaseOlder = subscribeInsertedText(text => older.push(text));
		const releaseNewer = subscribeInsertedText(text => newer.push(text));
		offerInsertedText("@x");
		releaseNewer();
		offerInsertedText("@y");
		releaseOlder();
		assert.deepEqual(older, ["@y"]);
		assert.deepEqual(newer, ["@x"]);
	});

	it("keeps only the newest few insertions while no composer exists", () => {
		for (let number = 0; number < 20; number++) offerInsertedText(`@${number}`);
		const received: string[] = [];
		subscribeInsertedText(text => received.push(text))();
		assert.equal(received.length, 8);
		assert.equal(received.at(-1), "@19");
	});
});

describe("attachInsertedText", () => {
	function fakeTransport() {
		const listeners = new Set<(message: GuestHostMessage) => void>();
		return {
			subscribe(listener: (message: GuestHostMessage) => void) {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			post(message: GuestHostMessage) {
				for (const listener of listeners) listener(message);
			},
		};
	}

	it("holds a message the host posts right after announcing, before any composer has mounted", () => {
		const transport = fakeTransport();
		const detach = attachInsertedText(transport, () => "chat");
		// Posted while no React effect has run yet.
		transport.post({ type: "omp:insert-text", text: "@early.ts [line 3]" });
		const received: string[] = [];
		subscribeInsertedText(text => received.push(text))();
		assert.deepEqual(received, ["@early.ts [line 3]"]);
		detach();
	});

	it("ignores other messages, and a page that shows the native terminal", () => {
		const transport = fakeTransport();
		let mode: "chat" | "terminal" = "terminal";
		const detach = attachInsertedText(transport, () => mode);
		const received: string[] = [];
		const release = subscribeInsertedText(text => received.push(text));
		transport.post({ type: "omp:insert-text", text: "@terminal.ts" });
		transport.post({ type: "omp:control-invalidate" });
		assert.deepEqual(received, []);
		mode = "chat";
		transport.post({ type: "omp:insert-text", text: "@chat.ts" });
		assert.deepEqual(received, ["@chat.ts"]);
		release();
		detach();
	});
});
