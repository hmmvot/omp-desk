/**
 * Quoting into the draft and removing a quote, through the Draft interface: every refusal and notice sentence, the edit, and when it may be
 * written (a composition window, the hand-off).
 *
 * Runner: `node --test src/webview/lib/draft/quote.test.ts`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_CHAT_TEXT_LENGTH } from "../../../protocol/chat-messages.ts";
import { MAX_QUOTE_CHARACTERS } from "../../../shared/quote-limit.ts";
import { createDraftCell, type DraftCell } from "./cell.ts";
import { stubPort, type StubPort } from "./draft-test-stub.ts";
import type { Outcome } from "./field.ts";
import { quote, removeQuote, type QuoteContext, type QuoteRequest, type QuoteResult } from "./quote.ts";
import { withState } from "./value.ts";

function open(text = ""): { cell: DraftCell; port: StubPort } {
	const port = stubPort();
	const cell = createDraftCell(port);
	port.bind(cell);
	cell.commit({ draft: withState(cell.read(), { text }), writes: [{ kind: "text", text, history: "reset", focus: false }] });
	port.calls.length = 0;
	return { cell, port };
}

const READY: QuoteContext = { writable: true, settling: false };
const WHEN = { composing: "wait", held: "drop" } as const;

function run(cell: DraftCell, request: QuoteRequest, context: QuoteContext = READY): Outcome<QuoteResult>[] {
	const seen: Outcome<QuoteResult>[] = [];
	cell.perform(quote(request, context), WHEN, outcome => seen.push(outcome));
	return seen;
}

const selection = (source: string, plain = false): QuoteRequest => ({ kind: "selection", source, plain });
const notice = (text: string, level: "info" | "warn"): Outcome<QuoteResult> => ({ kind: "applied", result: { kind: "notice", text, level } });

describe("a quote is placed", () => {
	it("at the end of an empty draft, the caret on the line under it, as one replace step, and says how many lines", () => {
		const { cell, port } = open();
		assert.deepEqual(run(cell, selection("one\ntwo")), [notice("Quoted 2 lines into the draft", "info")]);
		assert.equal(cell.read().text, "> one\n> two\n");
		assert.deepEqual(port.calls, ['write edit 0..0 "> one\\n> two\\n" as replace focus']);
		assert.equal(cell.getState().caret, 12);
	});

	it("after a blank line, which is also what keeps two quotes two runs", () => {
		const { cell } = open("my comment");
		run(cell, selection("a"));
		assert.equal(cell.read().text, "my comment\n\n> a\n");
		run(cell, selection("b"));
		assert.equal(cell.read().text, "my comment\n\n> a\n\n> b\n");
	});

	it("each editor selection is its own quote, and a plain quote says so", () => {
		const { cell } = open();
		assert.deepEqual(run(cell, { kind: "editor", sources: ["a", "b"], size: 2 }), [notice("Quoted 3 lines into the draft", "info")]);
		assert.equal(cell.read().text, "> a\n\n> b\n");
		assert.deepEqual(run(cell, selection("c", true)), [notice("Quoted 1 line as plain text", "info")]);
	});

	it("never inside a fenced block the draft left open: the fence is closed first", () => {
		const { cell } = open("```\ncode");
		run(cell, selection("q"));
		assert.equal(cell.read().text, "```\ncode\n```\n\n> q\n");
	});
});

describe("a quote is refused with its sentence", () => {
	it("nothing to quote says why, an empty selection says what to do", () => {
		const { cell } = open("x");
		assert.deepEqual(run(cell, { kind: "nothing", message: "No selection." }), [notice("No selection.", "warn")]);
		assert.deepEqual(run(cell, selection("  \n")), [notice("Select text in the conversation first", "warn")]);
		assert.deepEqual(run(cell, { kind: "editor", sources: [" "], size: 1 }), [notice("Select some text first", "warn")]);
		assert.equal(cell.read().text, "x");
	});

	it("a session that cannot take a message, or no field at all", () => {
		const { cell, port } = open();
		assert.deepEqual(run(cell, selection("a"), { writable: false, settling: false }), [notice("This session cannot take a message", "warn")]);
		port.unmount();
		assert.deepEqual(run(cell, selection("a")), [notice("This session cannot take a message", "warn")]);
		assert.equal(cell.read().text, "");
	});

	it("a quote over the size limit, and a draft that would pass the length the host accepts", () => {
		const { cell } = open();
		const size = MAX_QUOTE_CHARACTERS + 1;
		assert.deepEqual(run(cell, selection("x".repeat(size))), [notice(`That selection is 20 001 characters; Quote takes at most 20 000.`, "warn")]);
		assert.deepEqual(run(cell, selection("x".repeat(31_482))), [notice("That selection is 31 482 characters; Quote takes at most 20 000.", "warn")]);
		assert.equal(run(cell, selection("x".repeat(MAX_QUOTE_CHARACTERS)))[0]?.kind, "applied", "exactly the limit is taken");
		assert.ok(cell.read().text.length > MAX_QUOTE_CHARACTERS);
		const full = open("y".repeat(MAX_CHAT_TEXT_LENGTH - 3));
		assert.deepEqual(run(full.cell, selection("zzzz")), [notice("That would make the draft longer than OMP Desk can send", "warn")]);
	});

	it("a host-sent editor quote while the session is settling is held, a Chat selection is not", () => {
		const { cell } = open();
		assert.deepEqual(run(cell, { kind: "editor", sources: ["a"], size: 1 }, { writable: false, settling: true }), [{ kind: "applied", result: { kind: "hold" } }]);
		assert.deepEqual(run(cell, selection("a"), { writable: false, settling: true }), [notice("This session cannot take a message", "warn")]);
		assert.equal(cell.read().text, "");
	});
});

describe("when a quote is written", () => {
	it("waits for a composition window and is written once it closes", () => {
		const { cell, port } = open();
		port.openWindow();
		assert.deepEqual(run(cell, selection("a")), []);
		assert.equal(cell.read().text, "");
		port.closeWindow();
		assert.equal(cell.read().text, "> a\n");
	});

	it("is dropped while the hand-off holds the draft, and the caller says the draft is held", () => {
		const { cell } = open("x");
		cell.capture(1);
		assert.deepEqual(run(cell, selection("a")), [{ kind: "dropped" }]);
		assert.equal(cell.read().text, "x");
	});

	it("is refused when the field refuses the edit, and the value stays as it was", () => {
		const { cell, port } = open("x");
		port.refuseNext();
		const [outcome] = run(cell, selection("a"));
		assert.equal(outcome?.kind, "refused");
		assert.equal(cell.read().text, "x");
	});
});

describe("Remove quote", () => {
	it("deletes the run that starts at the offset and its line break as one replace step, the caret where it was", () => {
		const { cell, port } = open("note\n\n> a\n> b\n\nafter");
		cell.perform(removeQuote(6), WHEN);
		assert.equal(cell.read().text, "note\n\n\nafter");
		assert.deepEqual(port.calls, ['write edit 6..14 "" as replace focus']);
		assert.equal(cell.getState().caret, 6);
	});

	it("finds nothing at an offset that starts no quote, and is dropped while no field is mounted", () => {
		const { cell, port } = open("> a");
		cell.perform(removeQuote(1), WHEN);
		assert.equal(cell.read().text, "> a");
		port.unmount();
		cell.perform(removeQuote(0), WHEN);
		assert.equal(cell.read().text, "> a");
	});

	it("waits for a composition window and is dropped while the draft is held", () => {
		const { cell, port } = open("> a");
		port.openWindow();
		cell.perform(removeQuote(0), WHEN);
		assert.equal(cell.read().text, "> a");
		port.closeWindow();
		assert.equal(cell.read().text, "");
		const held = open("> a");
		held.cell.capture(1);
		held.cell.perform(removeQuote(0), WHEN);
		assert.equal(held.cell.read().text, "> a");
	});
});
