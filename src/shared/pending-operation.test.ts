import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PENDING_KINDS, PENDING_STEPS, isLaunchFamily, isLaunchingStep, pendingBannerText, pendingText, pendingVerb, sameFamily } from "./pending-operation.ts";

describe("pending operation text", () => {
	it("names the verb and the step, and adds whole seconds only from 5 s", () => {
		assert.equal(pendingText("resume", "ownership", 0), "Starting · checking for another OMP process");
		assert.equal(pendingText("resume", "ownership", 4_999), "Starting · checking for another OMP process");
		assert.equal(pendingText("resume", "ownership", 7_400), "Starting · checking for another OMP process · 7 s");
	});

	it("shows no seconds while the flow waits for the user's own answer, and says still past the mark", () => {
		assert.equal(pendingText("delete", "confirm", 20_000), "Deleting · waiting for your answer");
		assert.equal(pendingText("resume", "spawn", 61_000, true), "Starting · still starting the background process · 61 s");
		assert.equal(pendingText("resume", "boot", 61_000, true), "Starting · OMP is still starting · 61 s");
		assert.equal(pendingText("delete", "confirm", 61_000, true), "Deleting · waiting for your answer");
	});

	it("reads Starting for a history open only once it launches, and Stopping for a Close only once it stops", () => {
		assert.equal(pendingVerb("open", "ownership"), "Opening");
		assert.equal(pendingVerb("open", "admission"), "Starting");
		assert.equal(pendingVerb("open", "boot"), "Starting");
		assert.equal(pendingVerb("close", "checking"), "Closing");
		assert.equal(pendingVerb("close", "working"), "Stopping");
	});

	it("walks a launch through the steps the extension can observe, from the checks to OMP's own start", () => {
		const steps = ["ownership", "admission", "prepare", "runtime", "spawn", "boot", "connect"] as const;
		assert.deepEqual(steps.map(step => isLaunchingStep(step)), [false, true, true, true, true, true, true]);
		assert.deepEqual(steps.slice(3).map(step => pendingBannerText("resume", step, 12_000)), [
			"Starting the session · checking the runtime · 12 s",
			"Starting the session · starting the background process · 12 s",
			"Starting the session · OMP is starting · 12 s",
			"Starting the session · connecting · 12 s",
		]);
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
