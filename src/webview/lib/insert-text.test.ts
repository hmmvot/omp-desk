/**
 * Host-added references reach the composer once, in order, and never glue to a word.
 *
 * Runner: `node --test src/webview/lib/insert-text.test.ts`
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { GuestHostMessage } from "../../protocol/messages.ts";
import { attachInsertedText, offerInsertedText, subscribeInsertedText } from "./insert-text.ts";
import { provideQuoteSink } from "./quote-sink.ts";
import type { QuoteRequest } from "./draft/draft.ts";

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

describe("attachInsertedText with editor quotes", () => {
	it("hands an omp:insert-quote to the quote sink, held until a composer provides one, and only on a chat page", () => {
		const listeners = new Set<(message: GuestHostMessage) => void>();
		const transport = { subscribe(listener: (message: GuestHostMessage) => void) { listeners.add(listener); return () => listeners.delete(listener); } };
		const post = (message: GuestHostMessage): void => { for (const listener of listeners) listener(message); };
		let mode: "chat" | "terminal" = "terminal";
		const detach = attachInsertedText(transport, () => mode);
		const message: GuestHostMessage = { type: "omp:insert-quote", quotes: [{ location: "src/a.ts:3", fileName: "a.ts", languageId: "typescript", text: "x" }] };
		post(message);
		const received: QuoteRequest[] = [];
		const release = provideQuoteSink(request => received.push(request));
		assert.deepEqual(received, [], "a terminal page does not take it");
		mode = "chat";
		post(message);
		assert.equal(received.length, 1);
		assert.deepEqual(received[0], { kind: "editor", sources: ["`src/a.ts:3`\n```ts\nx\n```"], size: 1 });
		release();
		// Held while no composer is mounted, then delivered to the first one.
		post(message);
		const later: QuoteRequest[] = [];
		provideQuoteSink(request => later.push(request))();
		assert.equal(later.length, 1);
		detach();
	});
});
