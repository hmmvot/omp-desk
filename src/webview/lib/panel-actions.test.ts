/**
 * Tests for the composer-action registry.
 *
 * The contract is that a VS Code command reaches the *current* composer and no
 * stale one: a replacement composer can mount before the first unmounts,
 * and the newest registration must own the action. A registration that is
 * released must stop answering, which is what makes the returned release
 * function a real part of the contract rather than bookkeeping.
 *
 * Runner: `node --test src/webview/lib/panel-actions.test.ts`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { providePanelActions, requestPanelAction } from "./panel-actions.ts";

/** A handler set that records every call, so a dispatch can be attributed. */
function recorder(name: string, calls: string[]) {
	return {
		"send-prompt": () => calls.push(`${name}:send`),
		"stop-turn": () => calls.push(`${name}:stop`),
		"focus-composer": () => calls.push(`${name}:focus`),
		"retry-turn": () => calls.push(`${name}:retry`),
	};
}

describe("dispatch", () => {
	it("reports when no composer is mounted", () => {
		assert.equal(requestPanelAction("send-prompt"), false);
	});

	it("runs the mounted composer's own action", () => {
		const calls: string[] = [];
		const release = providePanelActions(recorder("a", calls));
		assert.equal(requestPanelAction("stop-turn"), true);
		assert.deepEqual(calls, ["a:stop"]);
		release();
	});

	it("hands the action to the newest composer and stops after its release", () => {
		const calls: string[] = [];
		const releaseFirst = providePanelActions(recorder("first", calls));
		const releaseSecond = providePanelActions(recorder("second", calls));
		assert.equal(requestPanelAction("focus-composer"), true);
		assert.deepEqual(calls, ["second:focus"]);
		releaseSecond();
		assert.equal(requestPanelAction("focus-composer"), true);
		assert.deepEqual(calls, ["second:focus", "first:focus"]);
		releaseFirst();
		assert.equal(requestPanelAction("focus-composer"), false);
		assert.deepEqual(calls, ["second:focus", "first:focus"]);
	});

	it("releases only the registration it was given", () => {
		const calls: string[] = [];
		const releaseFirst = providePanelActions(recorder("first", calls));
		const releaseSecond = providePanelActions(recorder("second", calls));
		releaseFirst();
		assert.equal(requestPanelAction("send-prompt"), true);
		assert.deepEqual(calls, ["second:send"]);
		releaseSecond();
	});
});
