import assert from "node:assert/strict";
import { test } from "node:test";
import type { CodeThemeRule } from "../../chat/code-theme.ts";
import { cachedSpans, codeChunks, isHighlightable, MAX_HIGHLIGHT_CHARS, MAX_HIGHLIGHT_LINES, withinCaps, runCss, runsByLine, spansOf, styledRuns } from "./code-highlight.ts";
import { createCodeThemeStyler, FONT_BOLD, FONT_ITALIC, FONT_UNDERLINE } from "./code-theme-style.ts";

/** The colours Dark Modern gives these scopes (its tokenColors, abridged). */
const DARK: CodeThemeRule[] = [
	{ scopes: ["comment"], foreground: "#6A9955" },
	{ scopes: ["string", "string.quoted"], foreground: "#CE9178" },
	{ scopes: ["constant.numeric"], foreground: "#B5CEA8" },
	{ scopes: ["keyword.control"], foreground: "#C586C0" },
	{ scopes: ["storage.type", "keyword.operator.new", "constant.language"], foreground: "#569CD6" },
	{ scopes: ["entity.name.function"], foreground: "#DCDCAA" },
	{ scopes: ["support.type.property-name"], foreground: "#9CDCFE" },
];
const styler = createCodeThemeStyler(DARK);

/** `[text, colour]` of every coloured run (plain runs are `null`). */
function painted(info: string, source: string): Array<[string, string | null]> {
	const spans = spansOf(info, source);
	assert.ok(spans !== null, `${info} is tokenized`);
	return styledRuns(spans, styler).map(run => [run.text, run.style?.color ?? null]);
}

test("TypeScript is coloured with the theme's colours for the scopes", () => {
	const runs = painted("ts", 'const n = 42; // note\nreturn "a";');
	assert.deepEqual(runs.filter(([, color]) => color !== null), [
		["const", "#569CD6"],
		["42", "#B5CEA8"],
		["// note", "#6A9955"],
		["return", "#C586C0"],
		['"a"', "#CE9178"],
	]);
});

test("Python and JSON follow the same table", () => {
	assert.deepEqual(painted("py", "def f(a):\n  return 'x'").filter(([, color]) => color !== null), [
		["def", "#569CD6"],
		["f", "#DCDCAA"],
		["return", "#C586C0"],
		["'x'", "#CE9178"],
	]);
	assert.deepEqual(painted("json", '{"a": [1, true]}').filter(([, color]) => color !== null), [
		['"a"', "#9CDCFE"],
		["1", "#B5CEA8"],
		["true", "#569CD6"],
	]);
});

test("the runs always spell the source, exactly, whatever the language", () => {
	const samples: Record<string, string> = {
		ts: "export async function f<T>(x: T): Promise<T> {\n\treturn `a${x}b`;\n}\n",
		py: "class A:\n    def f(self):\n        '''doc'''\n        return {1: 2}\n",
		json: '{\n  "a": [1, 2, {"b": null}]\n}',
		sh: 'for f in *.ts; do echo "$f" | grep -q x && exit 1; done',
		diff: "--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new",
		yaml: "a:\n  - b: 1\n  - c: 'd'\n",
		css: ".a > b:hover { color: #fff; margin: 1px }",
		html: '<div class="a">x &amp; y</div>',
		cpp: "#include <vector>\nint main() { return 0; }",
		go: 'package main\nfunc main() { println("x") }',
		rs: "fn main() { let x: u32 = 1; }",
		cs: "public class A { void F() { } }",
		ps1: 'Get-ChildItem | Where-Object { $_.Length -gt 1 }',
		md: "# T\n\n- a\n- `b`\n",
	};
	for (const [info, source] of Object.entries(samples)) {
		const spans = spansOf(info, source);
		assert.ok(spans !== null, `${info} is a language`);
		assert.equal(spans.map(span => span.text).join(""), source, `${info}: the spans spell the source`);
		assert.equal(styledRuns(spans, styler).map(run => run.text).join(""), source, `${info}: the runs spell the source`);
	}
});

test("an unknown language, an empty block and an oversized block are not highlighted", () => {
	assert.equal(spansOf("nosuchlang", "x"), null);
	assert.equal(isHighlightable("ts", "x"), true);
	assert.equal(isHighlightable("", "x"), false);
	assert.equal(isHighlightable("ts", ""), false);
	assert.equal(isHighlightable("ts", "x".repeat(MAX_HIGHLIGHT_CHARS + 1)), false);
	assert.equal(isHighlightable("ts", "x".repeat(MAX_HIGHLIGHT_CHARS)), true);
	assert.equal(isHighlightable("ts", "\n".repeat(MAX_HIGHLIGHT_LINES - 1)), true);
	assert.equal(isHighlightable("ts", "\n".repeat(MAX_HIGHLIGHT_LINES)), false);
});

test("a block tokenizes once and a theme change only re-styles it", () => {
	const source = "const cache = 1;";
	assert.equal(cachedSpans("ts", source), null);
	const first = spansOf("ts", source);
	assert.equal(cachedSpans("ts", source), first);
	assert.equal(spansOf("typescript", source), first, "an alias is the same language");
	const light = createCodeThemeStyler([{ scopes: ["constant.numeric"], foreground: "#098658" }]);
	assert.ok(first !== null);
	assert.deepEqual(styledRuns(first, light).filter(run => run.style !== null).map(run => [run.text, run.style?.color]), [["1", "#098658"]]);
});

test("runs of one style merge and a rule that sets nothing leaves the text plain", () => {
	const rules = createCodeThemeStyler([{ scopes: ["keyword"], foreground: "#ff0000" }, { scopes: ["comment"] }]);
	const runs = styledRuns(
		[
			{ text: "a", scopes: ["source.ts", "keyword.a"] },
			{ text: "b", scopes: ["source.ts", "keyword.b"] },
			{ text: "c", scopes: ["source.ts", "comment.ts"] },
			{ text: "d", scopes: ["source.ts"] },
		],
		rules,
	);
	assert.deepEqual(runs.map(run => [run.text, run.style?.color ?? null]), [["ab", "#ff0000"], ["cd", null]]);
});

test("a run's css never changes a glyph's width or a line's height", () => {
	assert.deepEqual(runCss({ color: "#fff", fontStyle: 0 }), { color: "#fff" });
	assert.deepEqual(runCss({ color: null, fontStyle: FONT_ITALIC | FONT_BOLD | FONT_UNDERLINE }), { fontStyle: "italic", fontWeight: "bold", textDecoration: "underline" });
});

test("runs are cut into one list per line, and a run never spans two lines", () => {
	const style = { color: "#fff", fontStyle: 0 };
	const lines = runsByLine([{ text: "a\nb", style }, { text: "c\n\nd", style: null }, { text: "\n", style: null }]);
	assert.deepEqual(lines.map(line => line.map(run => run.text)), [["a"], ["b", "c"], [], ["d"], []]);
	assert.equal(lines[0]![0]!.style, style);
	assert.deepEqual(runsByLine([]).map(line => line.length), [0]);
});

test("a text within the caps is tokenized whole; a longer one in aligned chunks, each up to the caps", () => {
	assert.equal(withinCaps(["a", "b", "c", "d"]), true);
	const many = Array.from({ length: MAX_HIGHLIGHT_LINES + 50 }, (_, index) => `l${index}`);
	assert.equal(withinCaps(many), false, "over the line cap");
	assert.equal(withinCaps(Array.from({ length: 10 }, () => "x".repeat(MAX_HIGHLIGHT_CHARS / 4))), false, "over the character cap");
	const chunks = codeChunks(many, 120, 330);
	assert.deepEqual(chunks.map(chunk => chunk.first), [100, 200, 300], "chunks start at multiples of 100 whatever the window");
	assert.equal(chunks[0]!.source, many.slice(100, 200).join("\n"));
	assert.equal(codeChunks(many, 130, 160)[0]!.source, chunks[0]!.source, "moving the window inside a chunk does not change what is tokenized");
	assert.equal(codeChunks(many, 420, 430)[0]!.source, many.slice(400).join("\n"), "the last chunk is the rest");
	const wide = Array.from({ length: 10 }, () => "x".repeat(MAX_HIGHLIGHT_CHARS / 4));
	const cut = codeChunks(wide, 0, 10)[0]!;
	assert.equal(cut.source.split("\n").length, 3, "capped at the character cap");
	assert.ok(cut.source.length <= MAX_HIGHLIGHT_CHARS);
	assert.equal(codeChunks([`${"y".repeat(MAX_HIGHLIGHT_CHARS + 1)}`], 0, 1)[0]!.source, "", "one line over the cap stays plain");
});
