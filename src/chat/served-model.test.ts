/** Which served-model substitutions the transcript announces, and where (the host's `classifyModel` verdict decides what is one). */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AssistantMessage } from "./messages.ts";
import { announcedMismatches, servedModelKey, servedModelLabel, servedModelPair, type ServedModelCandidate, type ServedModelPair, type ServedModelVerdict } from "./served-model.ts";

const message = (patch: Partial<AssistantMessage>): AssistantMessage => ({ role: "assistant", timestamp: 1, model: "claude-opus-5", provider: "anthropic", stopReason: "stop", content: [], ...patch });
const pair = (served: string, requested = "claude-opus-5", provider = "anthropic"): ServedModelPair => ({ provider, requested, served });
const candidate = (entryId: string, served: string, upstreamProvider?: string): ServedModelCandidate => ({ entryId, pair: pair(served), ...(upstreamProvider === undefined ? {} : { upstreamProvider }) });

describe("which messages are candidates", () => {
	it("needs a served id that differs textually and a known provider", () => {
		assert.deepEqual(servedModelPair(message({ upstreamModel: "claude-haiku-4-5" })), pair("claude-haiku-4-5"));
		assert.equal(servedModelPair(message({})), null, "nothing served is reported");
		assert.equal(servedModelPair(message({ upstreamModel: "claude-opus-5" })), null, "the same id is the same model");
		assert.equal(servedModelPair(message({ upstreamModel: "" })), null);
		assert.equal(servedModelPair(message({ upstreamModel: "claude-haiku-4-5", provider: undefined })), null, "the classifier needs the provider; without it there is no verdict to ask for");
	});
});

describe("which substitutions are announced", () => {
	const verdicts = (known: Record<string, ServedModelVerdict>) => (value: ServedModelPair): ServedModelVerdict | undefined => known[value.served];

	it("shows a mismatch, and nothing for a snapshot, a codename or an answer that has not come", () => {
		const shown = announcedMismatches([candidate("a1", "claude-haiku-4-5"), candidate("a2", "claude-opus-5-20260101"), candidate("a3", "numbat-v6"), candidate("a4", "pending-model")], verdicts({ "claude-haiku-4-5": "mismatch", "claude-opus-5-20260101": "same", "numbat-v6": "unknown" }));
		assert.deepEqual([...shown.keys()], ["a1"]);
	});

	it("announces each distinct pair once, at its first message, and a new pair after a model switch again", () => {
		const shown = announcedMismatches([
			candidate("a1", "claude-haiku-4-5"), candidate("a2", "claude-haiku-4-5"),
			{ entryId: "a3", pair: pair("claude-haiku-4-5", "claude-sonnet-5") }, candidate("a4", "claude-sonnet-4-5"),
		], verdicts({ "claude-haiku-4-5": "mismatch", "claude-sonnet-4-5": "mismatch" }));
		assert.deepEqual([...shown.keys()], ["a1", "a3", "a4"]);
	});

	it("keeps the first occurrence by transcript order, not by when the verdict arrived", () => {
		const list = [candidate("early", "x-model"), candidate("late", "x-model")];
		assert.deepEqual([...announcedMismatches(list, () => "mismatch").keys()], ["early"]);
	});

	it("carries the router's upstream host into the marker", () => {
		const [marker] = [...announcedMismatches([candidate("a1", "claude-haiku-4-5", "Amazon Bedrock")], () => "mismatch").values()];
		assert.equal(servedModelLabel(marker!), "served claude-haiku-4-5 · requested claude-opus-5 · via anthropic/Amazon Bedrock");
		assert.equal(servedModelLabel({ provider: "openrouter", requested: "a", served: "b" }), "served b · requested a · via openrouter");
	});

	it("keys a pair by all three parts", () => {
		assert.notEqual(servedModelKey(pair("x")), servedModelKey(pair("x", "claude-opus-5", "openrouter")));
		assert.notEqual(servedModelKey(pair("x")), servedModelKey(pair("y")));
	});
});
