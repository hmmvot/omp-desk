import assert from "node:assert/strict";
import { test } from "node:test";
import { commitLinkTarget, commitTargetOfSpan, detectCommitHashes, parseCommitLinkTarget } from "./commit-links.ts";

test("a code span that is one 7 to 40 digit hex hash is a commit candidate, whatever mix of digits and letters, and its target is lower case", () => {
	assert.equal(commitTargetOfSpan("c7398070"), "commit://c7398070");
	assert.equal(commitTargetOfSpan(" C7398070 "), "commit://c7398070", "whitespace is ignored and the target is canonical");
	assert.equal(commitTargetOfSpan("1234567"), "commit://1234567", "in code the span is the evidence: the host decides whether a commit exists");
	assert.equal(commitTargetOfSpan("deadbeef"), "commit://deadbeef");
	assert.equal(commitTargetOfSpan("a".repeat(40)), `commit://${"a".repeat(40)}`);
});

test("a code span that is not exactly a 7 to 40 digit hash is no candidate", () => {
	for (const span of ["abc123", "a".repeat(41), "c739807g", "c7398070.ts", "git show c7398070", "0xc7398070", "#c7398070", "c739-8070", "", "   "]) {
		assert.equal(commitTargetOfSpan(span), null, JSON.stringify(span));
	}
});

test("a link target round-trips only in the canonical form", () => {
	assert.equal(parseCommitLinkTarget(commitLinkTarget("c7398070")), "c7398070");
	for (const target of ["commit://C7398070", "commit://c73980", `commit://${"a".repeat(41)}`, "commit://c7398070/x", "commit:c7398070", "c7398070", "agent://c7398070", "commit://c7398070 "]) {
		assert.equal(parseCommitLinkTarget(target), null, target);
	}
});

test("prose: a lower-case hash with both a digit and a letter is a candidate, covering exactly its characters", () => {
	const text = "Fixed in c7398070, see (a1b2c3d) and 5f3a9b2e1d.";
	const found = detectCommitHashes(text);
	assert.deepEqual(found.map(link => text.slice(link.start, link.end)), ["c7398070", "a1b2c3d", "5f3a9b2e1d"]);
	assert.deepEqual(found.map(link => link.target), ["commit://c7398070", "commit://a1b2c3d", "commit://5f3a9b2e1d"]);
	assert.equal(detectCommitHashes("commit c7398070: the fix").length, 1, "a colon and a space after the hash end a sentence part");
});

test("prose: ordinary numbers, words, constants, versions, paths, URLs, colours and longer identifiers are not hashes", () => {
	for (const text of [
		"1234567 and 20261017 and 123456789012",
		"defaced decaded effaced deadbeef accede",
		"ABCDEF12 and C7398070",
		"0xdeadbeef1 and #c7398070 and @c7398070",
		"https://example.test/commit/c7398070 and https://example.test/c7398070",
		"src/c7398070/x.ts and c7398070.ts and c7398070.5",
		"c7398070-rc1 and my-c7398070 and c7398070_x and xc7398070",
		"abc123 is too short and a1b2c3 too",
		`${"a1".repeat(21)} is too long`,
		"key:c7398070 and c7398070:12 and c7398070/x",
	]) {
		assert.deepEqual(detectCommitHashes(text), [], text);
	}
});

test("prose: one text is bounded", () => {
	const text = Array.from({ length: 100 }, (_, index) => `a1b2c3${String(index).padStart(2, "0")}`).join(" ");
	assert.equal(detectCommitHashes(text).length, 32);
});
