import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	containsMagicKeyword,
	enabledMagicKeywords,
	findMagicKeywords,
	hasMagicKeyword,
	isMagicKeywordId,
	magicKeywordSetting,
	magicPhaseAt,
	magicStopAt,
	magicStopHue,
	MAGIC_KEYWORDS,
	MAGIC_KEYWORD_SETTING_KEYS,
	maskNonProse,
	type MagicKeywordId,
} from "./magic-keywords.ts";

/** The words found in `text`, in text order. */
const found = (text: string, enabled?: ReadonlySet<MagicKeywordId>): string[] => findMagicKeywords(text, enabled).map(match => text.slice(match.from, match.to));

describe("the magic keyword table", () => {
	it("has OMP's four keywords in OMP's order, the `workflow` setting being triggered by `workflowz`", () => {
		assert.deepEqual(MAGIC_KEYWORDS.map(keyword => [keyword.id, keyword.word]), [["ultrathink", "ultrathink"], ["orchestrate", "orchestrate"], ["workflow", "workflowz"], ["jevify", "jevify"]]);
		assert.deepEqual(MAGIC_KEYWORD_SETTING_KEYS, ["magicKeywords.enabled", "magicKeywords.ultrathink", "magicKeywords.orchestrate", "magicKeywords.workflow", "magicKeywords.jevify"]);
		assert.equal(magicKeywordSetting("workflow"), "magicKeywords.workflow");
		assert.equal(isMagicKeywordId("workflow"), true);
		assert.equal(isMagicKeywordId("workflowz"), false, "the word is not the id");
		assert.equal(isMagicKeywordId(7), false);
	});
});

describe("standalone prose: the boundaries", () => {
	it("finds a word alone, at either end of the text and beside sentence punctuation or quotes", () => {
		assert.deepEqual(findMagicKeywords("ultrathink"), [{ id: "ultrathink", from: 0, to: 10 }]);
		for (const text of ["please ultrathink about it", "(ultrathink)", '"ultrathink"', "'ultrathink'", "ultrathink, then", "ultrathink.", "ultrathink!", "ultrathink?", "ultrathink:", "ultrathink; done", "x: ultrathink", "foo:ultrathink", "ultrathink\nmore", "tab\tultrathink", "ultrathink. Next", "ultrathink (see below)", "[ultrathink]", "**ultrathink**", "> ultrathink", "- ultrathink", "ultrathink…"]) {
			assert.deepEqual(found(text), ["ultrathink"], text);
		}
	});

	it("refuses a word bound into an identifier, a path, a file name, a symbol or a call on its left", () => {
		for (const text of ["fooultrathink", "foo-ultrathink", "foo_ultrathink", "1ultrathink", "path/ultrathink", "path\\ultrathink", ".ultrathink", "foo.ultrathink", "foo::ultrathink", "::ultrathink", "éultrathink", "日本ultrathink", "٣ultrathink", "--ultrathink"]) {
			assert.deepEqual(found(text), [], text);
		}
	});

	it("refuses a word bound into an identifier, a path, a file name, a symbol or a call on its right", () => {
		for (const text of ["ultrathinking", "ultrathink1", "ultrathink_x", "ultrathink-x", "ultrathink/x", "ultrathink\\x", "ultrathink()", "ultrathink(x)", "ultrathink.md", "ultrathink.x", "ultrathink.5", "ultrathink._", "ultrathink.-", "ultrathinké", "ultrathink日本", "ultrathink٣"]) {
			assert.deepEqual(found(text), [], text);
		}
	});

	it("is case-sensitive and does not take a part of a longer word or a near miss", () => {
		for (const text of ["Ultrathink", "ULTRATHINK", "orchestratE", "ultrathin", "workflow", "ultra think", "ultrathink2", "jevif"]) assert.deepEqual(found(text), [], text);
	});

	it("reports UTF-16 offsets, so a word after an emoji or an astral character keeps its place", () => {
		assert.deepEqual(findMagicKeywords("😀 ultrathink"), [{ id: "ultrathink", from: 3, to: 13 }]);
		assert.deepEqual(findMagicKeywords("😀ultrathink"), [{ id: "ultrathink", from: 2, to: 12 }], "an emoji is neither a letter nor a digit, so it does not bind the word");
	});

	it("finds every keyword in text order, each repeat on its own, with `workflowz` reported as `workflow`", () => {
		const text = "jevify then orchestrate, workflowz and ultrathink; ultrathink again";
		assert.deepEqual(findMagicKeywords(text).map(match => [match.id, match.from]), [["jevify", 0], ["orchestrate", 12], ["workflow", 25], ["ultrathink", 39], ["ultrathink", 51]]);
		assert.deepEqual(found("ultrathink ultrathink"), ["ultrathink", "ultrathink"]);
	});

	it("limits the search to the enabled keywords", () => {
		const text = "orchestrate and ultrathink";
		assert.deepEqual(found(text, new Set<MagicKeywordId>(["ultrathink"])), ["ultrathink"]);
		assert.deepEqual(found(text, new Set<MagicKeywordId>()), []);
		assert.deepEqual(found(text, new Set<MagicKeywordId>(["orchestrate", "ultrathink"])), ["orchestrate", "ultrathink"]);
	});
});

describe("standalone prose: code and markup are not prose", () => {
	it("skips inline code spans of any backtick count, and reads an unmatched run as plain text", () => {
		assert.deepEqual(found("`ultrathink`"), []);
		assert.deepEqual(found("use `ultrathink` and ultrathink"), ["ultrathink"]);
		assert.deepEqual(findMagicKeywords("use `ultrathink` and ultrathink")[0]!.from, 21);
		assert.deepEqual(found("``a ` ultrathink``"), []);
		assert.deepEqual(found("`a` ultrathink `b`"), ["ultrathink"]);
		assert.deepEqual(found("`ultrathink"), ["ultrathink"], "an unmatched backtick opens no span");
		assert.deepEqual(found("``ultrathink`"), ["ultrathink"], "a run of another length does not close the span");
		assert.deepEqual(found("`a`ultrathink`b`"), ["ultrathink"], "a code span does not bind the word: its characters are blanked");
	});

	it("skips fenced code blocks, backtick or tilde, with the indentation and closing rules of the fence", () => {
		assert.deepEqual(found("```\nultrathink\n```"), []);
		assert.deepEqual(found("```ts\nultrathink\n```\nultrathink"), ["ultrathink"]);
		assert.deepEqual(findMagicKeywords("```ts\nultrathink\n```\nultrathink")[0]!.from, 21);
		assert.deepEqual(found("~~~\nultrathink\n~~~"), []);
		assert.deepEqual(found("   ```\nultrathink\n   ```"), [], "up to three spaces still open a fence");
		assert.deepEqual(found("    ```\nultrathink"), ["ultrathink"], "four spaces is no fence");
		assert.deepEqual(found("```\nultrathink"), [], "an unclosed fence runs to the end");
		assert.deepEqual(found("````\n```\nultrathink\n````\nultrathink"), ["ultrathink"], "a shorter fence does not close it");
		assert.deepEqual(found("```\n``` js\nultrathink\n```\nultrathink"), ["ultrathink"], "a closing fence has nothing after it");
		assert.deepEqual(found("~~~\nultrathink\n```\nultrathink\n~~~\nultrathink"), ["ultrathink"], "another character does not close it");
		assert.deepEqual(found("```a`b\nultrathink"), ["ultrathink"], "a backtick in the info string means no fence");
		assert.deepEqual(found("before ultrathink\n```\nx\n```"), ["ultrathink"]);
	});

	it("skips HTML and XML sections, comments, and the tag itself, and keeps what a tag does not enclose", () => {
		for (const text of ["<b>ultrathink</b>", "<B>ultrathink</b>", "<!-- ultrathink -->", "<!-- ultrathink", '<a title="x > y">ultrathink</a>', "<a><a>x</a>ultrathink</a>", "<a href=ultrathink>x</a>", "<x\nattr>ultrathink</x>"]) {
			assert.deepEqual(found(text), [], text);
		}
		for (const text of ["<b>x</b> ultrathink", "<br/> ultrathink", "<div>ultrathink", "a < b ultrathink", "1<2 ultrathink", "<a><a>x</a>y</a> ultrathink", "`<b>` ultrathink `</b>`", "</b> ultrathink", "<3 ultrathink"]) {
			assert.deepEqual(found(text), ["ultrathink"], text);
		}
	});

	it("masks length-preservingly, keeps newlines and returns a text with nothing to mask as it is", () => {
		const plain = "no markup here";
		assert.equal(maskNonProse(plain), plain);
		assert.equal(maskNonProse("a `b` c"), "a     c");
		assert.equal(maskNonProse("```\nx\n```\ny"), "   \n \n   \ny");
		assert.equal(maskNonProse("<b>x</b>y"), "        y");
		const mixed = "a `b`\n```\nc\n```\n<i>d</i>\ne ~~~\nf";
		const masked = maskNonProse(mixed);
		assert.equal(masked.length, mixed.length);
		assert.deepEqual([...masked].flatMap((ch, index) => (ch === "\n" ? [index] : [])), [...mixed].flatMap((ch, index) => (ch === "\n" ? [index] : [])));
	});
});

describe("containsMagicKeyword and hasMagicKeyword", () => {
	it("ask OMP's question: is the word standing as prose in the text", () => {
		assert.equal(containsMagicKeyword("please ultrathink", "ultrathink"), true);
		assert.equal(containsMagicKeyword("`ultrathink`", "ultrathink"), false);
		assert.equal(containsMagicKeyword("ultrathink()", "ultrathink"), false);
		assert.equal(containsMagicKeyword("ultrathink", "orchestrate"), false);
		assert.equal(containsMagicKeyword("anything.here is a word", "anything.here"), true, "a word with a dot is escaped, not a pattern");
		assert.equal(containsMagicKeyword("anythingXhere", "anything.here"), false);
	});

	it("tell whether any enabled keyword stands in the text", () => {
		assert.equal(hasMagicKeyword("nothing to see"), false);
		assert.equal(hasMagicKeyword("jevify"), true);
		assert.equal(hasMagicKeyword("jevify", new Set<MagicKeywordId>(["ultrathink"])), false);
		assert.equal(hasMagicKeyword("`jevify` and ultrathink", new Set<MagicKeywordId>(["jevify"])), false);
	});
});

describe("enabledMagicKeywords", () => {
	const all = Object.fromEntries(MAGIC_KEYWORD_SETTING_KEYS.map(key => [key, true]));

	it("takes the master switch and the keyword's own switch, as OMP's session does", () => {
		assert.deepEqual(enabledMagicKeywords(all), ["ultrathink", "orchestrate", "workflow", "jevify"]);
		assert.deepEqual(enabledMagicKeywords({ ...all, "magicKeywords.enabled": false }), []);
		assert.deepEqual(enabledMagicKeywords({ ...all, "magicKeywords.workflow": false }), ["ultrathink", "orchestrate", "jevify"]);
		assert.deepEqual(enabledMagicKeywords({ ...all, "magicKeywords.ultrathink": false, "magicKeywords.orchestrate": false, "magicKeywords.workflow": false, "magicKeywords.jevify": false }), []);
	});

	it("treats a key the installed OMP does not report, and a value that is not a boolean, as off", () => {
		assert.deepEqual(enabledMagicKeywords({}), [], "an OMP without magic keywords");
		const { "magicKeywords.enabled": _master, ...withoutMaster } = all;
		assert.deepEqual(enabledMagicKeywords(withoutMaster), []);
		const { "magicKeywords.jevify": _jevify, ...withoutJevify } = all;
		assert.deepEqual(enabledMagicKeywords(withoutJevify), ["ultrathink", "orchestrate", "workflow"]);
		assert.deepEqual(enabledMagicKeywords({ ...all, "magicKeywords.orchestrate": "true", "magicKeywords.workflow": 1, "magicKeywords.jevify": null }), ["ultrathink"]);
	});
});

describe("the gradient", () => {
	it("sweeps each keyword's hue over 14 stops, rounded after the wrap as OMP does", () => {
		const ultrathink = MAGIC_KEYWORDS[0]!;
		assert.deepEqual([0, 1, 7, 13].map(stop => magicStopHue(ultrathink, stop)), [0, 24, 165, 306]);
		const jevify = MAGIC_KEYWORDS[3]!;
		assert.deepEqual([0, 7, 8, 13].map(stop => magicStopHue(jevify, stop)), [300, 0, 9, 51], "a sweep past 360 wraps through red");
		const workflow = MAGIC_KEYWORDS[2]!;
		assert.deepEqual([0, 13].map(stop => magicStopHue(workflow, stop)), [30, 141]);
		const orchestrate = MAGIC_KEYWORDS[1]!;
		assert.deepEqual([0, 13].map(stop => magicStopHue(orchestrate, stop)), [150, 271]);
	});

	it("gives the characters of a word successive stops, and a growing phase rotates them", () => {
		assert.deepEqual([0, 5, 9].map(index => magicStopAt(index, 10)), [0, 7, 12]);
		assert.deepEqual([0, 5, 9].map(index => magicStopAt(index, 10, 0.5)), [7, 0, 5]);
		assert.equal(magicStopAt(0, 10, 1), magicStopAt(0, 10, 0), "a whole sweep is no change");
		assert.equal(magicStopAt(0, 10, -0.25), magicStopAt(0, 10, 0.75), "a negative phase wraps");
		assert.equal(magicPhaseAt(0), 0);
		assert.equal(magicPhaseAt(900), 0.5);
		assert.equal(magicPhaseAt(1800), 0);
		assert.equal(magicPhaseAt(1800 + 450), 0.25);
	});
});
