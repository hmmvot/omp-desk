import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PENDING_KINDS, PENDING_STEPS, isLaunchFamily, pendingBannerText, pendingText, pendingVerb, sameFamily } from "./pending-operation.ts";

describe("pending operation text", () => {
	it("names the verb and the step, and adds whole seconds only from 5 s", () => {
		assert.equal(pendingText("resume", "ownership", 0), "Starting · checking for another OMP process");
		assert.equal(pendingText("resume", "ownership", 4_999), "Starting · checking for another OMP process");
		assert.equal(pendingText("resume", "ownership", 7_400), "Starting · checking for another OMP process · 7 s");
	});

	it("shows no seconds while the flow waits for the user's own answer, and says still past the mark", () => {
		assert.equal(pendingText("delete", "confirm", 20_000), "Deleting · waiting for your answer");
		assert.equal(pendingText("resume", "spawn", 61_000, true), "Starting · still starting OMP · 61 s");
		assert.equal(pendingText("delete", "confirm", 61_000, true), "Deleting · waiting for your answer");
	});

	it("reads Starting for a history open only once it launches, and Stopping for a Close only once it stops", () => {
		assert.equal(pendingVerb("open", "ownership"), "Opening");
		assert.equal(pendingVerb("open", "admission"), "Starting");
		assert.equal(pendingVerb("close", "checking"), "Closing");
		assert.equal(pendingVerb("close", "working"), "Stopping");
	});

	it("words the Chat banner with the same step phrases", () => {
		assert.equal(pendingBannerText("resume", "runtime", 9_000), "Starting the session · checking the runtime · 9 s");
		assert.equal(pendingBannerText("open", "ownership", 100), "Opening the session · checking for another OMP process");
	});

	it("has a verb and a phrase for every kind and step, and one launch family", () => {
		for (const kind of PENDING_KINDS) for (const step of PENDING_STEPS) assert.match(pendingText(kind, step, 0), /^\S.* · \S/);
		assert.deepEqual(PENDING_KINDS.filter(isLaunchFamily), ["open", "resume", "new-session", "restart"]);
		assert.equal(sameFamily("open", "resume"), true);
		assert.equal(sameFamily("resume", "rename"), false);
		assert.equal(sameFamily("rename", "rename"), true);
	});
});
