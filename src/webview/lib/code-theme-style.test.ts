import assert from "node:assert/strict";
import { test } from "node:test";
import type { CodeThemeRule } from "../../chat/code-theme.ts";
import { createCodeThemeStyler, FONT_BOLD, FONT_ITALIC, PLAIN_STYLE } from "./code-theme-style.ts";

const rule = (scopes: string[], foreground?: string, fontStyle?: string): CodeThemeRule => ({ scopes, ...(foreground === undefined ? {} : { foreground }), ...(fontStyle === undefined ? {} : { fontStyle }) });

test("a rule applies to its scope and to the scopes below it, never to a longer word", () => {
	const styler = createCodeThemeStyler([rule(["keyword.control"], "#c586c0")]);
	assert.equal(styler.styleOf(["source.ts", "keyword.control"]).color, "#c586c0");
	assert.equal(styler.styleOf(["source.ts", "keyword.control.flow.ts"]).color, "#c586c0");
	assert.equal(styler.styleOf(["source.ts", "keyword.controller.ts"]).color, null);
	assert.equal(styler.styleOf(["source.ts", "keyword"]).color, null);
});

test("the longer scope wins whatever the order, equal scopes merge in theme order field by field", () => {
	const styler = createCodeThemeStyler([rule(["string.quoted"], "#111111"), rule(["string"], "#222222", "italic"), rule(["string"], "#333333")]);
	assert.equal(styler.styleOf(["string.quoted.double.ts"]).color, "#111111");
	assert.deepEqual(styler.styleOf(["string.regexp.ts"]), { color: "#333333", fontStyle: FONT_ITALIC });
	// A more specific scope starts from what the less specific rules set.
	assert.equal(styler.styleOf(["string.quoted.double.ts"]).fontStyle, FONT_ITALIC);
});

test("an enclosing scope decides when its selector names it, nearest first", () => {
	const styler = createCodeThemeStyler([rule(["variable"], "#aaaaaa"), rule(["source.css variable"], "#bbbbbb"), rule(["meta.block > variable"], "#cccccc")]);
	assert.equal(styler.styleOf(["source.ts", "variable.other.ts"]).color, "#aaaaaa");
	assert.equal(styler.styleOf(["source.css", "meta.rule", "variable.css"]).color, "#bbbbbb");
	assert.equal(styler.styleOf(["source.ts", "meta.block", "variable.ts"]).color, "#cccccc");
	assert.equal(styler.styleOf(["source.ts", "meta.block", "meta.other", "variable.ts"]).color, "#aaaaaa", "`>` needs the enclosing scope directly around");
});

test("a token takes the style of the scopes around it for what its own rule leaves unset", () => {
	const styler = createCodeThemeStyler([rule(["comment"], "#6a9955", "italic"), rule(["comment.block.documentation"], undefined, "bold")]);
	assert.deepEqual(styler.styleOf(["source.ts", "comment.ts", "punctuation.definition.comment.ts"]), { color: "#6a9955", fontStyle: FONT_ITALIC });
	assert.deepEqual(styler.styleOf(["source.ts", "comment.block.documentation.ts"]), { color: "#6a9955", fontStyle: FONT_BOLD });
});

test("a scope no rule names is plain, and an empty theme styles nothing", () => {
	assert.deepEqual(createCodeThemeStyler([]).styleOf(["source.ts", "keyword.control.ts"]), PLAIN_STYLE);
	assert.deepEqual(createCodeThemeStyler([rule(["keyword"], "#569cd6")]).styleOf(["source.ts"]), PLAIN_STYLE);
});
