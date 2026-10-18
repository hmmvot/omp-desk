/** The provider-error frame's facts: the recorded HTTP status, the copied text and when a message is long. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AssistantMessage } from "./messages.ts";
import { LONG_ERROR_CHARACTERS, LONG_ERROR_LINES, copyableError, errorStatusOf, isLongError } from "./provider-error.ts";

const failed = (patch: Record<string, unknown> = {}): AssistantMessage => ({ role: "assistant", timestamp: 1, model: "m", stopReason: "error", content: [], ...patch });

describe("the recorded status", () => {
	it("is the HTTP status OMP recorded, and nothing otherwise", () => {
		assert.equal(errorStatusOf(failed({ errorStatus: 429 })), 429);
		assert.equal(errorStatusOf(failed()), undefined, "older sessions and network failures record none");
		for (const bad of [0, 99, 600, 42.5, Number.NaN, "429", null, {}]) assert.equal(errorStatusOf(failed({ errorStatus: bad })), undefined, String(bad));
	});
});

describe("the copied error", () => {
	it("puts the status before the provider's message and survives a missing half", () => {
		assert.equal(copyableError(failed({ errorStatus: 503, errorMessage: " Service unavailable \n" })), "HTTP 503: Service unavailable");
		assert.equal(copyableError(failed({ errorMessage: "Overloaded" })), "Overloaded");
		assert.equal(copyableError(failed({ errorStatus: 500 })), "Provider error (HTTP 500)");
		assert.equal(copyableError(failed()), "Provider error");
	});
});

describe("a long message", () => {
	it("is cut by length or by lines, and a short one is not", () => {
		assert.equal(isLongError("Provider overloaded; try again later"), false);
		assert.equal(isLongError("x".repeat(LONG_ERROR_CHARACTERS)), false);
		assert.equal(isLongError("x".repeat(LONG_ERROR_CHARACTERS + 1)), true);
		assert.equal(isLongError(Array.from({ length: LONG_ERROR_LINES }, () => "line").join("\n")), false);
		assert.equal(isLongError(Array.from({ length: LONG_ERROR_LINES + 1 }, () => "line").join("\n")), true);
	});
});
