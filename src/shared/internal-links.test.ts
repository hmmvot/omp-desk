import assert from "node:assert/strict";
import { test } from "node:test";
import { detectInternalLinks, internalLinkTarget, internalTargetOf, isAgentId, parseInternalLink } from "./internal-links.ts";

test("an agent or history URL is one subagent id, nested ids are dot-qualified, and a JSON-path suffix is not part of the target", () => {
	assert.deepEqual(parseInternalLink("agent://UniformFieldsReview"), { scheme: "agent", id: "UniformFieldsReview" });
	assert.deepEqual(parseInternalLink("  agent://ReadmeReviewer-2  "), { scheme: "agent", id: "ReadmeReviewer-2" });
	assert.deepEqual(parseInternalLink("agent://Parent.Child"), { scheme: "agent", id: "Parent.Child" });
	assert.deepEqual(parseInternalLink("agent://Parent.Child.Grand"), { scheme: "agent", id: "Parent.Child.Grand" });
	assert.deepEqual(parseInternalLink("history://Worker"), { scheme: "history", id: "Worker" });
	assert.equal(internalTargetOf("agent://Reviewer/reports/0/data"), "agent://Reviewer", "opening ignores the JSON path");
	assert.equal(internalTargetOf("agent://Reviewer"), "agent://Reviewer");
	for (const bad of ["agent://", "agent:///x", "agent://a b", "agent://Reviewer/", "agent://Reviewer//x", "agent://Rev?q=1", "agent://Rev#top", "agent://a..b", "agent://.a", "agent://a.", "agent://a\\b", "agent://" + "x".repeat(257), "Agent://X", "agentx://X", "agent:/X", "agent://a/../b", "agent://a/%2e%2e/b/c d"]) {
		assert.equal(parseInternalLink(bad), null, bad);
	}
	assert.equal(isAgentId("Parent.Child"), true);
	assert.equal(isAgentId("../x"), false);
});

test("an artifact URL is one to nine digits and a local URL a relative path that cannot leave its folder", () => {
	assert.deepEqual(parseInternalLink("artifact://69"), { scheme: "artifact", id: "69" });
	for (const bad of ["artifact://", "artifact://x", "artifact://1234567890", "artifact://12/x", "artifact://12.bash.log", "artifact://-1"]) assert.equal(parseInternalLink(bad), null, bad);
	assert.deepEqual(parseInternalLink("local://plan.md"), { scheme: "local", path: "plan.md" });
	assert.deepEqual(parseInternalLink("local://notes/a%20b.md"), { scheme: "local", path: "notes/a b.md" });
	assert.equal(internalTargetOf("local://notes/a%20b.md"), "local://notes/a%20b.md", "the canonical target keeps every segment encoded");
	assert.equal(internalTargetOf("local://caf\u00e9.md"), "local://caf%C3%A9.md");
	for (const bad of ["local://", "local:///etc/passwd", "local://../x", "local://a/../x", "local://a/./b", "local://a//b", "local://a/%2e%2e/b", "local://a%2fb", "local://a%5cb", "local://C%3A/x", "local://a%00b", "local://a b", "local://a%", "local://a/b/", "local://con?.md", "local://" + "a/".repeat(17) + "b", "local://a%20"]) {
		assert.equal(parseInternalLink(bad), null, bad);
	}
});

test("every other scheme stays text: skill, memory, rule, pr, issue, omp, mcp, proc, xd, file and web addresses", () => {
	for (const text of ["skill://create-plan", "memory://root", "rule://x", "pr://1", "issue://1", "omp://docs", "mcp://s", "proc://1", "xd://find_roots", "file:///C:/x", "https://example.com/agent://X", "javascript:alert(1)"]) {
		assert.equal(parseInternalLink(text), null, text);
	}
});

test("prose links cover exactly their own characters, stop before sentence punctuation and never continue a word", () => {
	const text = "See agent://UniformFieldsReview. Then (agent://Parent.Child, artifact://69) and local://notes/plan.md: agent://Reviewer/reports/0 xagent://No history://Worker!";
	const found = detectInternalLinks(text).map(link => [text.slice(link.start, link.end), link.target]);
	assert.deepEqual(found, [
		["agent://UniformFieldsReview", "agent://UniformFieldsReview"],
		["agent://Parent.Child", "agent://Parent.Child"],
		["artifact://69", "artifact://69"],
		["local://notes/plan.md", "local://notes/plan.md"],
		["agent://Reviewer/reports/0", "agent://Reviewer"],
		["history://Worker", "history://Worker"],
	]);
	assert.deepEqual(detectInternalLinks("no scheme here, nor skill://x, nor https://example.com/agent:/x"), []);
	assert.deepEqual(detectInternalLinks("artifact://12345678901"), [], "ten digits are not an artifact id");
	assert.equal(detectInternalLinks("agent://A ".repeat(100)).length, 64, "one text never asks about more than 64 links");
});

test("internalLinkTarget is the canonical form parseInternalLink reads back", () => {
	for (const text of ["agent://Parent.Child", "history://Worker", "artifact://7", "local://a/b%20c.md"]) {
		const link = parseInternalLink(text)!;
		assert.deepEqual(parseInternalLink(internalLinkTarget(link)), link, text);
	}
});
