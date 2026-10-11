import assert from "node:assert/strict";
import { test } from "node:test";
import { CLEAR_COMMAND, CLEAR_MARKER_TYPE, clearError, clearErrorCode, clearMarker, encodeClearCommand, parseClearArgs } from "./clear.ts";
import { deskSessionCommand } from "./desk-commands.ts";

const REQUEST = "00112233445566778899aabbccddeeff";

test("only a leading /clear, /new, /delete or /fresh token is a Desk session command, with or without arguments", () => {
	assert.deepEqual(deskSessionCommand("/clear"), { command: "clear", hasArguments: false });
	assert.deepEqual(deskSessionCommand("  /NEW \n"), { command: "new", hasArguments: false });
	assert.deepEqual(deskSessionCommand("/delete now"), { command: "delete", hasArguments: true });
	assert.deepEqual(deskSessionCommand("/clear\nsecond line"), { command: "clear", hasArguments: true });
	assert.deepEqual(deskSessionCommand("/fresh"), { command: "fresh", hasArguments: false });
	for (const text of ["explain /clear", "/cleared", "/clear-all", "/usr/new", "/news", "/omp-desk-clear {}", "clear", ""]) assert.equal(deskSessionCommand(text), null, text);
});

test("the clear request round-trips and anything malformed is refused", () => {
	const text = encodeClearCommand({ v: 1, requestId: REQUEST, sessionId: "s1" });
	assert.ok(text.startsWith(`/${CLEAR_COMMAND} {`));
	assert.deepEqual(parseClearArgs(text.slice(CLEAR_COMMAND.length + 2)), { v: 1, requestId: REQUEST, sessionId: "s1" });
	for (const bad of ["{", "[]", "{}", JSON.stringify({ v: 2, requestId: REQUEST, sessionId: "s1" }), JSON.stringify({ v: 1, requestId: "x", sessionId: "s1" }), JSON.stringify({ v: 1, requestId: REQUEST, sessionId: "" })]) assert.equal(parseClearArgs(bad), null, bad);
});

test("a refusal maps to its fixed code and any other text to failed", () => {
	assert.equal(clearErrorCode(clearError("reload-failed").message), "reload-failed");
	assert.equal(clearErrorCode("omp-desk-clear:unknown-code"), "failed");
	assert.equal(clearErrorCode("TypeError: x"), "failed");
	assert.equal(clearErrorCode(undefined), "failed");
});

test("the marker is recognised only with its request id and boundary", () => {
	const entry = { type: "custom", id: "m1", parentId: "b1", customType: CLEAR_MARKER_TYPE, data: { v: 1, requestId: REQUEST, boundaryId: "b1" } };
	assert.deepEqual(clearMarker(entry), { id: "m1", v: 1, requestId: REQUEST, boundaryId: "b1" });
	assert.equal(clearMarker({ ...entry, customType: "omp-desk/navigation" }), null);
	assert.equal(clearMarker({ ...entry, data: { v: 1, requestId: REQUEST } }), null);
	assert.equal(clearMarker({ ...entry, type: "message" }), null);
});
