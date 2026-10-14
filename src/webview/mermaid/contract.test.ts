import assert from "node:assert/strict";
import { test } from "node:test";
import { mermaidKeyword } from "../../shared/mermaid-source.ts";
import { mermaidSourceRefusal } from "./contract.ts";

test("the diagram type is read after front matter, directives and comments", () => {
	assert.equal(mermaidKeyword("flowchart TD\n A-->B"), "flowchart");
	assert.equal(mermaidKeyword("---\ntitle: T\n---\nSequenceDiagram\n A->>B: x"), "sequencediagram");
	assert.equal(mermaidKeyword("%%{init: {\n\"theme\": \"x\"}}%%\n%% note\nblock-beta\n a"), "block-beta");
	assert.equal(mermaidKeyword("%% only a comment"), null);
});

test("a --- inside a front matter value does not end the front matter", () => {
	const source = "---\ntitle: a---b\n---\nblock-beta\n  columns 3\n  a b c";
	assert.equal(mermaidKeyword(source), "block-beta");
	assert.equal(mermaidSourceRefusal(source), "Block diagrams are not drawn");
});

test("limits count statements, not just lines", () => {
	assert.equal(mermaidSourceRefusal("flowchart LR\n  A-->B"), null);
	assert.match(mermaidSourceRefusal(`flowchart LR\n${"A-->B;".repeat(100)}`) ?? "", /over 80 statements/);
	assert.match(mermaidSourceRefusal(`flowchart LR\n${"A-->B\n".repeat(100)}`) ?? "", /over 80 statements/);
	assert.match(mermaidSourceRefusal("x".repeat(8001)) ?? "", /over 8,000 characters/);
});

test("the tab scope has no statement limit and draws block diagrams, up to the message cap", () => {
	assert.equal(mermaidSourceRefusal(`flowchart LR\n${"A-->B\n".repeat(500)}`, "tab"), null);
	assert.equal(mermaidSourceRefusal("block-beta\n  columns 3\n  a b c", "tab"), null);
	assert.match(mermaidSourceRefusal("x".repeat(50_001), "tab") ?? "", /over 50,000 characters/);
});
