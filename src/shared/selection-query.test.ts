import assert from "node:assert/strict";
import { test } from "node:test";
import { parseGuestWebviewMessage } from "../protocol/messages.ts";
import { MAX_SYMBOL_QUERY_LENGTH, fileSearchValue, normalizeSymbolQuery, selectedText, symbolSearchValue } from "./selection-query.ts";

test("a selection is trimmed to its first non-empty line", () => {
	assert.equal(normalizeSymbolQuery("  SessionData.Cast  "), "SessionData.Cast");
	assert.equal(normalizeSymbolQuery("\r\n  \n  Session  \nsecond line"), "Session");
	assert.equal(normalizeSymbolQuery(" \t\r\n "), "");
});

test("a long selection is cut to the cap and an overlong single line never grows past it", () => {
	const cut = normalizeSymbolQuery("x".repeat(500));
	assert.equal(cut.length, MAX_SYMBOL_QUERY_LENGTH);
	assert.equal(normalizeSymbolQuery(`${"x".repeat(MAX_SYMBOL_QUERY_LENGTH - 1)} tail`).length, MAX_SYMBOL_QUERY_LENGTH - 1);
});

test("the quick open argument is '#' plus the selection; an empty selection means the plain symbol search", () => {
	assert.equal(symbolSearchValue("Session"), "#Session");
	assert.equal(symbolSearchValue("  Cast()\nmore"), "#Cast()");
	assert.equal(symbolSearchValue(""), null);
	assert.equal(symbolSearchValue("   \n  "), null);
	assert.equal(symbolSearchValue(null), null);
	assert.equal(symbolSearchValue(undefined), null);
});

test("the Go to File argument is the selection itself; an empty selection means the plain Go to File", () => {
	assert.equal(fileSearchValue("  src/Foo.cs  "), "src/Foo.cs");
	assert.equal(fileSearchValue("Foo.cs\nmore"), "Foo.cs");
	assert.equal(fileSearchValue(""), null);
	assert.equal(fileSearchValue("  \n "), null);
	assert.equal(fileSearchValue(null), null);
	assert.equal(fileSearchValue(undefined), null);
});

test("the focused text field's selection wins over the document selection", () => {
	const doc = {
		activeElement: { tagName: "TEXTAREA", value: "call Session.Cast now", selectionStart: 5, selectionEnd: 17 },
		getSelection: () => ({ toString: () => "document text" }),
	};
	assert.equal(selectedText(doc), "Session.Cast");
});

test("a collapsed text field or another element falls back to the document selection", () => {
	const selection = { toString: () => "  Heal \n" };
	assert.equal(selectedText({ activeElement: { tagName: "TEXTAREA", value: "abc", selectionStart: 2, selectionEnd: 2 }, getSelection: () => selection }), "Heal");
	assert.equal(selectedText({ activeElement: { tagName: "DIV" }, getSelection: () => selection }), "Heal");
	assert.equal(selectedText({ activeElement: null, getSelection: () => null }), "");
});

test("the selection reply is bounded and normalized at the host boundary", () => {
	assert.deepEqual(parseGuestWebviewMessage({ type: "omp:selection-reply", requestId: 3, text: "  Session  " }), { type: "omp:selection-reply", requestId: 3, text: "Session" });
	assert.equal(parseGuestWebviewMessage({ type: "omp:selection-reply", requestId: 3, text: "x".repeat(MAX_SYMBOL_QUERY_LENGTH + 1) }), null);
	assert.equal(parseGuestWebviewMessage({ type: "omp:selection-reply", requestId: -1, text: "a" }), null);
	assert.equal(parseGuestWebviewMessage({ type: "omp:selection-reply", requestId: 1, text: 5 }), null);
	assert.equal(parseGuestWebviewMessage({ type: "omp:selection-reply", requestId: 1, text: "a", extra: true }), null);
});
