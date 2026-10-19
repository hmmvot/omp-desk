/** `proc://` addresses of background jobs. Runner: `node --test src/shared/proc-links.test.ts`. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detectProcLinks, isJobId, parseProcLink } from "./proc-links.ts";

describe("isJobId", () => {
	it("accepts words OMP mints and refuses anything that could change a command", () => {
		for (const id of ["bg_1", "job-1", "agent.name:2", "_x", "all"]) assert.equal(isJobId(id), true, id);
		for (const id of ["", "x; rm", "a b", "-x", ".x", "a/b", "x\n", "a".repeat(129)]) assert.equal(isJobId(id), false, JSON.stringify(id));
		assert.equal(isJobId("a".repeat(128)), true);
	});
});

describe("parseProcLink", () => {
	it("parses the listing, an id, and the kill and mode suffixes", () => {
		assert.deepEqual(parseProcLink("proc://"), { id: null, suffix: null });
		assert.deepEqual(parseProcLink("proc://bg_3"), { id: "bg_3", suffix: null });
		assert.deepEqual(parseProcLink("proc://bg_3/kill"), { id: "bg_3", suffix: "kill" });
		assert.deepEqual(parseProcLink("  proc://svc/mode "), { id: "svc", suffix: "mode" });
	});

	it("refuses a suffix without an id, unknown suffixes and anything that is not the whole text", () => {
		for (const text of ["proc:///kill", "proc:///mode", "proc://bg_1/other", "proc://bg_1/kill/x", "see proc://bg_1", "proc://bg_1 now", "http://bg_1", "proc://x;y", ""]) assert.equal(parseProcLink(text), null, text);
	});
});

describe("detectProcLinks", () => {
	const spans = (text: string) => detectProcLinks(text).map(found => ({ id: found.link.id, suffix: found.link.suffix, text: text.slice(found.start, found.end) }));

	it("finds links in prose with exact spans, in order", () => {
		const text = "Cancel proc://bg_1/kill and read proc://bg_2, or list proc://";
		assert.deepEqual(spans(text), [
			{ id: "bg_1", suffix: "kill", text: "proc://bg_1/kill" },
			{ id: "bg_2", suffix: null, text: "proc://bg_2" },
			{ id: null, suffix: null, text: "proc://" },
		]);
	});

	it("leaves a sentence's closing punctuation out of the link", () => {
		for (const [text, link] of [["See proc://bg_1.", "proc://bg_1"], ["(proc://bg_1)", "proc://bg_1"], ["proc://bg_1:", "proc://bg_1"], ["proc://bg_1/kill.", "proc://bg_1/kill"], ["proc://bg_1...", "proc://bg_1"]] as const) {
			assert.deepEqual(spans(text).map(found => found.text), [link], text);
		}
	});

	it("does not link inside a word, a URL or a longer path", () => {
		for (const text of ["xproc://bg_1", "http://host/proc://bg_1", "a/proc://bg_1", "foo.proc://bg_1", "proc://bg_1/kill/extra", "proc://bg_1/killer", "proc:///kill"]) assert.deepEqual(spans(text), [], text);
	});

	it("links at most 100 addresses of one text", () => {
		const found = detectProcLinks(Array.from({ length: 150 }, (_, index) => `proc://bg_${index}`).join(" "));
		assert.equal(found.length, 100);
		assert.equal(found.at(-1)?.link.id, "bg_99");
	});
});
