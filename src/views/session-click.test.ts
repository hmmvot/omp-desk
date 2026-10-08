import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionClickRecognizer } from "./session-click.ts";

test("stopped first click shows history and same-row second click launches through the 400ms boundary", () => {
	let now = 1000;
	const clicks = new SessionClickRecognizer(() => now);
	assert.equal(clicks.click("a", true), "history");
	now += 399;
	assert.equal(clicks.click("a", true), "launch");
	assert.equal(clicks.click("a", true), "history");
	now += 400;
	assert.equal(clicks.click("a", true), "launch");
	assert.equal(clicks.click("a", true), "history");
	now += 401;
	assert.equal(clicks.click("a", true), "history");
});

test("other rows, running/blocked clicks, changed identity and backward clocks do not form a stopped pair", () => {
	let now = 1000;
	const clicks = new SessionClickRecognizer(() => now);
	assert.equal(clicks.click("a", true), "history");
	assert.equal(clicks.click("b", true), "history");
	assert.equal(clicks.click("a", true), "history");
	assert.equal(clicks.click("running", false), "reveal");
	assert.equal(clicks.click("a", true), "history");
	assert.equal(clicks.click("a:new-file", true), "history");
	now--;
	assert.equal(clicks.click("a:new-file", true), "history");
});
