import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findFencedBlocks } from "./code-fence.ts";
import { findQuoteRuns, isQuoteLineAt, lineIndexAt, quotePrefixLength } from "./quote-lines.ts";

/** The run line ranges and the per-line flags as short strings: `-` plain, `q` quote, `c` nested code (quote and code). */
function layout(text: string): { runs: string[]; flags: string } {
	const found = findQuoteRuns(text, findFencedBlocks(text));
	return {
		runs: found.runs.map(run => `${run.firstLine}-${run.lastLine}:${text.slice(run.start, run.end)}`),
		flags: found.lines.map(line => (!line.quote ? "-" : line.code ? "c" : "q")).join(""),
	};
}

describe("quote lines and runs", () => {
	it("reads the prefix of a quote line: up to three blanks, one > per level, each optionally followed by one blank", () => {
		assert.equal(quotePrefixLength("> a"), 2);
		assert.equal(quotePrefixLength("  > a"), 4);
		assert.equal(quotePrefixLength("> > a"), 4);
		assert.equal(quotePrefixLength(">a"), 1);
		assert.equal(quotePrefixLength(">>a"), 2);
		assert.equal(quotePrefixLength(">\ta"), 2);
		assert.equal(quotePrefixLength(">"), 1);
		assert.equal(quotePrefixLength("    > a"), null, "four blanks of indentation is not a quote");
		assert.equal(quotePrefixLength("a > b"), null);
		assert.equal(quotePrefixLength(""), null);
	});

	it("ends a run at a blank line and at any line without the prefix", () => {
		assert.deepEqual(layout("> a\n> b\n\n> c"), { runs: ["0-1:> a\n> b", "3-3:> c"], flags: "qq-q" });
		assert.deepEqual(layout("> a\ncomment\n> b"), { runs: ["0-0:> a", "2-2:> b"], flags: "q-q" });
		assert.deepEqual(layout("foo\n> a\n>\n> b\nbar"), { runs: ["1-3:> a\n>\n> b"], flags: "-qqq-" });
		assert.deepEqual(layout("> a\n"), { runs: ["0-0:> a"], flags: "q-" });
		assert.deepEqual(layout(""), { runs: [], flags: "-" });
		assert.deepEqual(layout("> a"), { runs: ["0-0:> a"], flags: "q" });
	});

	it("never reads a > line inside a top-level fenced block as a quote, and a quote line never opens a block", () => {
		assert.deepEqual(layout("```\n> a\n```\n> b"), { runs: ["3-3:> b"], flags: "---q" });
		assert.deepEqual(layout("> ```ts\n> x"), { runs: ["0-1:> ```ts\n> x"], flags: "cc" }, "an unclosed nested fence runs to the end of the run");
		assert.deepEqual(findFencedBlocks("> ```ts\n> x"), [], "no top-level block opens inside a quote line");
	});

	it("flags the lines of a fenced block nested in a run, fences included, and ends the nesting at the run", () => {
		assert.deepEqual(layout("> a\n> ```ts\n> const x = 1;\n> ```\n> b"), { runs: ["0-4:> a\n> ```ts\n> const x = 1;\n> ```\n> b"], flags: "qcccq" });
		assert.deepEqual(layout("> ```\n> x\n\n> y"), { runs: ["0-1:> ```\n> x", "3-3:> y"], flags: "cc-q" }, "a blank line ends the run and its unclosed fence");
		assert.deepEqual(layout("> ````\n> ```\n> x\n> ````\n> y"), { runs: ["0-4:> ````\n> ```\n> x\n> ````\n> y"], flags: "ccccq" }, "a shorter run does not close it");
		assert.deepEqual(layout("> > ```\n> > x\n> > ```"), { runs: ["0-2:> > ```\n> > x\n> > ```"], flags: "ccc" });
	});

	it("finds the line of an offset and whether it is a quote line", () => {
		const text = "foo\n> a\n\n> b";
		const found = findQuoteRuns(text, findFencedBlocks(text));
		assert.equal(lineIndexAt(text, 0), 0);
		assert.equal(lineIndexAt(text, 3), 0, "the offset before a line break is on that line");
		assert.equal(lineIndexAt(text, 4), 1);
		assert.equal(lineIndexAt(text, text.length), 3);
		assert.equal(isQuoteLineAt(found, text, 3), false);
		assert.equal(isQuoteLineAt(found, text, 4), true);
		assert.equal(isQuoteLineAt(found, text, 7), true);
		assert.equal(isQuoteLineAt(found, text, 8), false);
		assert.equal(isQuoteLineAt(found, text, text.length), true);
	});
});
