import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_MERMAID_OPEN_CHARS, isOpenableMermaidSource, parseMermaidPreviewMessage, parseMermaidPreviewSource } from "./mermaid-preview.ts";
import { parseGuestWebviewMessage } from "./messages.ts";

describe("omp:open-mermaid", () => {
	it("carries a source and nothing else, up to the cap", () => {
		assert.equal(MAX_MERMAID_OPEN_CHARS, 50_000);
		assert.deepEqual(parseGuestWebviewMessage({ type: "omp:open-mermaid", source: "flowchart TD\n A-->B" }), { type: "omp:open-mermaid", source: "flowchart TD\n A-->B" });
		const largest = "a".repeat(MAX_MERMAID_OPEN_CHARS);
		assert.equal(parseGuestWebviewMessage({ type: "omp:open-mermaid", source: largest })?.type, "omp:open-mermaid");
	});

	it("refuses an empty, oversized, non-text or padded request", () => {
		for (const message of [
			{ type: "omp:open-mermaid", source: "" },
			{ type: "omp:open-mermaid", source: "a".repeat(MAX_MERMAID_OPEN_CHARS + 1) },
			{ type: "omp:open-mermaid", source: 1 },
			{ type: "omp:open-mermaid", source: ["a"] },
			{ type: "omp:open-mermaid" },
			{ type: "omp:open-mermaid", source: "a", tabId: "tab:x" },
			{ type: "omp:open-mermaid", source: "a", cwd: "D:\\work" },
		]) assert.equal(parseGuestWebviewMessage(message), null, JSON.stringify(message).slice(0, 80));
	});
});

describe("the diagram tab's own messages", () => {
	it("accepts exactly the announcement from the tab and exactly the source from the host", () => {
		assert.deepEqual(parseMermaidPreviewMessage({ type: "omp:mermaid-preview-ready" }), { type: "omp:mermaid-preview-ready" });
		for (const message of [null, [], "x", { type: "omp:mermaid-preview-ready", source: "a" }, { type: "omp:open-mermaid", source: "a" }, {}]) {
			assert.equal(parseMermaidPreviewMessage(message), null, JSON.stringify(message));
		}
		assert.deepEqual(parseMermaidPreviewSource({ type: "omp:mermaid-preview-source", source: "a" }), { type: "omp:mermaid-preview-source", source: "a" });
		for (const message of [null, { type: "omp:mermaid-preview-source" }, { type: "omp:mermaid-preview-source", source: "" }, { type: "omp:mermaid-preview-source", source: "a".repeat(MAX_MERMAID_OPEN_CHARS + 1) }, { type: "omp:mermaid-preview-source", source: "a", x: 1 }]) {
			assert.equal(parseMermaidPreviewSource(message), null);
		}
	});

	it("tells openable sources from the rest", () => {
		assert.equal(isOpenableMermaidSource("a"), true);
		assert.equal(isOpenableMermaidSource(""), false);
		assert.equal(isOpenableMermaidSource(undefined), false);
	});
});
