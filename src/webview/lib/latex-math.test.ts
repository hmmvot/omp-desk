import assert from "node:assert/strict";
import { test } from "node:test";
import { mathBlockAt, nextMathSpan, type MathSpan } from "./latex-math.ts";

/** Every span of `line`, found the way a caller walks it: each search resumes where the last span ended. */
function allSpans(line: string): MathSpan[] {
	const spans: MathSpan[] = [];
	for (let span = nextMathSpan(line); span !== undefined; span = nextMathSpan(line, span.end)) spans.push(span);
	return spans;
}

test("every opener has a span with its delimiters and display flag", () => {
	const cases: [string, MathSpan][] = [
		["$a$", { opener: "$", display: false, start: 0, end: 3, body: "a" }],
		["$x^2$", { opener: "$", display: false, start: 0, end: 5, body: "x^2" }],
		["$$x$$", { opener: "$$", display: true, start: 0, end: 5, body: "x" }],
		["\\(x\\)", { opener: "\\(", display: false, start: 0, end: 5, body: "x" }],
		["\\[x\\]", { opener: "\\[", display: true, start: 0, end: 5, body: "x" }],
		["so $a+b$ it is", { opener: "$", display: false, start: 3, end: 8, body: "a+b" }],
		["so \\(a+b\\) it is", { opener: "\\(", display: false, start: 3, end: 10, body: "a+b" }],
		["\\(\\)", { opener: "\\(", display: false, start: 0, end: 4, body: "" }],
		["\\[\\]", { opener: "\\[", display: true, start: 0, end: 4, body: "" }],
	];
	for (const [line, expected] of cases) assert.deepEqual(nextMathSpan(line), expected, line);
});

test("prices are prose, not math (pandoc's anti-currency rules)", () => {
	for (const line of ["$5 and $10", "costs $5", "$5-$10", "I paid $5 or $10 for it", "$ 5 $", "$", "$$", "a $ b", "$5 $10 $15"]) {
		assert.equal(nextMathSpan(line), undefined, line);
	}
	// A closing `$` followed by a digit is not a closer, but a later one is.
	assert.deepEqual(nextMathSpan("$a$5b$"), { opener: "$", display: false, start: 0, end: 6, body: "a$5b" });
	assert.deepEqual(nextMathSpan("$a$5 and $b$"), { opener: "$", display: false, start: 9, end: 12, body: "b" }, "a closer after a space is none: only $b$ is math");
});

test("text that merely starts with a dollar follows the TUI grammar", () => {
	assert.equal(nextMathSpan("use $HOME or $PATH"), undefined, "the closer after a space is no closer");
	assert.equal(nextMathSpan("echo $HOME"), undefined, "no closer");
	assert.deepEqual(nextMathSpan("cd $HOME/$USER"), { opener: "$", display: false, start: 3, end: 10, body: "HOME/" });
	assert.equal(nextMathSpan("$ x$")?.body, undefined, "an opener followed by a space is no opener");
	assert.equal(nextMathSpan("$x $")?.body, undefined, "a closer preceded by a space is no closer");
});

test("escaped openers are literal", () => {
	assert.equal(nextMathSpan("\\$a$"), undefined);
	assert.equal(nextMathSpan("cost \\$5 and \\$6"), undefined);
	assert.equal(nextMathSpan("\\\\(x\\)"), undefined, "an escaped backslash leaves the parenthesis plain");
	assert.equal(nextMathSpan("\\\\[x\\]"), undefined);
	assert.deepEqual(nextMathSpan("\\\\\\(x\\)"), { opener: "\\(", display: false, start: 2, end: 7, body: "x" }, "three backslashes: one escaped pair, then an opener");
	assert.equal(nextMathSpan("$a\\$")?.body, undefined, "an escaped dollar does not close");
	assert.equal(nextMathSpan("$a\\$b$")?.body, "a\\$b", "an escaped dollar inside a span is body text");
	assert.deepEqual(nextMathSpan("\\\\$x$"), { opener: "$", display: false, start: 2, end: 5, body: "x" }, "an escaped backslash does not escape the dollar after it");
});

test("a row break inside \\( \\) does not close it", () => {
	assert.deepEqual(nextMathSpan("\\(a \\\\) b\\) c"), { opener: "\\(", display: false, start: 0, end: 11, body: "a \\\\) b" });
});

test("a blank $$ body is no math, and a failed $$ is two literal dollars", () => {
	assert.equal(nextMathSpan("$$ $$"), undefined);
	assert.equal(nextMathSpan("$$$$"), undefined);
	assert.deepEqual(nextMathSpan("$$ $$ $x$"), { opener: "$", display: false, start: 6, end: 9, body: "x" });
	assert.deepEqual(nextMathSpan("$$$x$"), { opener: "$", display: false, start: 2, end: 5, body: "x" });
});

test("an unclosed opener is prose", () => {
	for (const line of ["$$x", "\\(x", "\\[x", "$x", "a \\(b", "\\(x\\"]) assert.equal(nextMathSpan(line), undefined, line);
});

test("spans are found in order, adjacent ones included, resuming from `from`", () => {
	assert.deepEqual(
		allSpans("a $x$ b \\(y\\) c $$z$$ d \\[w\\]").map(span => [span.opener, span.body]),
		[
			["$", "x"],
			["\\(", "y"],
			["$$", "z"],
			["\\[", "w"],
		],
	);
	assert.deepEqual(allSpans("$a$$b$").map(span => [span.start, span.end]), [
		[0, 3],
		[3, 6],
	]);
	assert.deepEqual(allSpans("$a$\\(b\\)").map(span => span.body), ["a", "b"]);
	assert.equal(nextMathSpan("$a$ $b$", 3)?.start, 4);
	assert.equal(nextMathSpan("$a$ $b$", 4)?.start, 4);
	assert.equal(nextMathSpan("$a$ $b$", 5)?.body, undefined, "from inside a span starts mid-text");
	assert.equal(nextMathSpan("$a$", -5)?.start, 0, "a negative start reads from the line start");
	assert.equal(nextMathSpan("", 0), undefined);
	assert.equal(nextMathSpan("$a$", 99), undefined);
});

test("a long run of failing openers is read once, not once per opener", () => {
	const started = performance.now();
	for (const line of ["$5".repeat(50_000), "\\(".repeat(50_000), "\\[".repeat(50_000), "$x ".repeat(30_000), "\\(a$5$5".repeat(10_000)]) {
		assert.deepEqual(allSpans(line).length <= 1, true);
	}
	// Many spans on a line: the walk is linear too, even when failing openers sit between them.
	assert.equal(allSpans("$a$ \\( ".repeat(10_000)).length, 10_000);
	assert.equal(allSpans("$$a ".repeat(25_000)).length, 12_500, "a $$a $$ pair per two repetitions");
	assert.ok(performance.now() - started < 2000, `took ${Math.round(performance.now() - started)}ms`);
});

test("a display block is an own-line opener and closer, with the lines between", () => {
	assert.deepEqual(mathBlockAt(["$$", "x = 1", "$$"], 0), { opener: "$$", bodyLines: ["x = 1"], last: 2 });
	assert.deepEqual(mathBlockAt(["\\[", "x = 1", "y = 2", "\\]"], 0), { opener: "\\[", bodyLines: ["x = 1", "y = 2"], last: 3 });
	assert.deepEqual(mathBlockAt(["text", "$$", "a", "$$", "more"], 1), { opener: "$$", bodyLines: ["a"], last: 3 });
	assert.deepEqual(mathBlockAt(["$$", "", "a", "", "$$"], 0)?.bodyLines, ["", "a", ""], "blank lines inside a block do not split it");
	assert.deepEqual(mathBlockAt(["$$", "a", "$$", "b", "$$"], 0)?.last, 2, "the first closer ends the block");
});

test("an opener takes up to three leading spaces and trailing blanks; a closer too", () => {
	assert.deepEqual(mathBlockAt(["   $$  \t", "a", " $$ "], 0), { opener: "$$", bodyLines: ["a"], last: 2 });
	assert.equal(mathBlockAt(["    $$", "a", "$$"], 0), undefined, "four spaces is an indented code block");
	assert.equal(mathBlockAt(["$$", "a", "    $$"], 0), undefined, "an indented closer closes nothing");
	assert.equal(mathBlockAt(["$$ x", "a", "$$"], 0), undefined, "text after the opener makes it an inline span");
	assert.equal(mathBlockAt(["$$", "a", "$$ x"], 0), undefined, "text after the closer is no closer");
	assert.equal(mathBlockAt(["\\[", "a", "$$"], 0), undefined, "a closer closes its own kind only");
	assert.equal(mathBlockAt(["$$", "a", "\\]"], 0), undefined);
});

test("an unclosed block stays prose, as does one with a blank body", () => {
	assert.equal(mathBlockAt(["$$", "x = 1"], 0), undefined);
	assert.equal(mathBlockAt(["\\[", "x = 1"], 0), undefined);
	assert.equal(mathBlockAt(["$$", "$$"], 0), undefined, "an empty body");
	assert.equal(mathBlockAt(["$$", " ", "\t", "$$"], 0), undefined, "a blank body");
	assert.equal(mathBlockAt(["$$", "a", "$$"], 1), undefined, "a body line starts no block");
	assert.equal(mathBlockAt(["$$", "a", "$$"], 7), undefined, "an index past the end");
	assert.equal(mathBlockAt([], 0), undefined);
});

test("a bare math environment is a block of its own lines", () => {
	assert.deepEqual(mathBlockAt(["\\begin{align}", "a &= b \\\\", "c &= d", "\\end{align}"], 0), {
		opener: "env",
		bodyLines: ["\\begin{align}", "a &= b \\\\", "c &= d", "\\end{align}"],
		last: 3,
	});
	assert.deepEqual(mathBlockAt(["x", "  \\begin{pmatrix} 1 & 2 \\end{pmatrix}"], 1)?.last, 1, "an environment on one line");
	assert.deepEqual(mathBlockAt(["\\begin{align*}", "a", "\\end{align*}  "], 0)?.last, 2, "starred, with trailing blanks");
	assert.deepEqual(mathBlockAt(["\\begin{cases}", "a", "\\end{cases}"], 0)?.opener, "env");
});

test("only math environments, closed in one paragraph, are blocks", () => {
	assert.equal(mathBlockAt(["\\begin{tabular}{c}", "a", "\\end{tabular}"], 0), undefined, "text-mode environments stay prose");
	assert.equal(mathBlockAt(["\\begin{itemize}", "a", "\\end{itemize}"], 0), undefined);
	assert.equal(mathBlockAt(["\\begin{align}", "a"], 0), undefined, "unclosed while streaming");
	assert.equal(mathBlockAt(["\\begin{align}", "a", "", "\\end{align}"], 0), undefined, "a blank line ends the paragraph");
	assert.equal(mathBlockAt(["    \\begin{align}", "a", "\\end{align}"], 0), undefined, "four spaces is code");
	assert.equal(mathBlockAt(["\\begin{align} a", "b", "\\end{align} tail"], 0), undefined, "text after the \\end is prose");
	assert.equal(mathBlockAt(["\\begin{align}", "a", "\\end{aligned}"], 0), undefined, "the \\end must be the matching one");
	assert.deepEqual(
		mathBlockAt(["\\begin{aligned}", "\\begin{aligned} a \\end{aligned}", "\\end{aligned}"], 0)?.last,
		2,
		"a nested environment of the same name is matched by depth",
	);
});

test("asking at every line of a long run of openers is linear", () => {
	const started = performance.now();
	const runs: string[][] = [
		Array.from({ length: 10_000 }, () => "$$"),
		Array.from({ length: 10_000 }, () => "\\["),
		Array.from({ length: 10_000 }, () => "\\begin{align}"),
		Array.from({ length: 10_000 }, (_, index) => (index % 2 === 0 ? "$$" : "x")),
		Array.from({ length: 10_000 }, (_, index) => (index % 3 === 0 ? "\\begin{cases}" : "a")),
	];
	for (const lines of runs) for (let index = 0; index < lines.length; index++) mathBlockAt(lines, index);
	assert.ok(performance.now() - started < 1500, `took ${Math.round(performance.now() - started)}ms`);
	// The same lines asked about again, and an array that grew, still answer correctly.
	const lines = ["$$", "a"];
	assert.equal(mathBlockAt(lines, 0), undefined);
	lines.push("$$");
	assert.deepEqual(mathBlockAt(lines, 0), { opener: "$$", bodyLines: ["a"], last: 2 });
});
