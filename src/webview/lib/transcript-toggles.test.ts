/** The transcript's thinking and tools defaults. Runner: `node --test src/webview/lib/transcript-toggles.test.ts`. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { adoptTranscriptToggles, clearToolDisclosures, getTranscriptToggles, subscribeTranscriptToggles, withToolDefault } from "./transcript-toggles.ts";

describe("transcript toggles", () => {
	it("re-applies a changed default once and ignores a repeat of the same values", () => {
		const seen: number[] = [];
		const release = subscribeTranscriptToggles(() => seen.push(getTranscriptToggles().generation));
		const start = getTranscriptToggles().generation;
		adoptTranscriptToggles(true, false);
		adoptTranscriptToggles(true, false);
		adoptTranscriptToggles(true, true);
		release();
		assert.deepEqual(seen, [start + 1, start + 2]);
		assert.deepEqual({ thinking: getTranscriptToggles().thinking, tools: getTranscriptToggles().tools }, { thinking: true, tools: true });
		adoptTranscriptToggles(false, false);
	});

	it("expands tool blocks nobody set, keeps the user's own choices, and leaves other keys alone", () => {
		const map = new Map<string, boolean>([["call:chat:closed", false], ["irc:chat:x", true]]);
		const shown = withToolDefault(map, true);
		assert.equal(shown.get("call:chat:new"), true);
		assert.equal(shown.get("run:chat:a:0"), true);
		assert.equal(shown.get("call:chat:closed"), false, "a block closed after the change stays closed");
		assert.equal(shown.get("irc:chat:other"), undefined, "a non-tool disclosure has no default");
		assert.equal(shown.size, 2);
		assert.equal(withToolDefault(map, false), map);
		clearToolDisclosures(map);
		assert.deepEqual([...map], [["irc:chat:x", true]], "a change forgets only tool blocks' own state");
	});
});
