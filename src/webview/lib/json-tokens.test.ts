import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { splitToolNotices } from "../../chat/tool-notices.ts";
import { detectOutputFormat, foldLabel, jsonTree, jsonTreeOfValue, lexJsonLine, MAX_JSON_BYTES } from "./json-tokens.ts";

interface Call { id: string; resultText: string }
const calls: readonly Call[] = JSON.parse(readFileSync(new URL("../fixtures/tool-calls.json", import.meta.url), "utf8"));
const body = (id: string): string => splitToolNotices(calls.find(call => call.id === id)?.resultText ?? assert.fail(id)).body;

test("the lexer spells exactly its row and names keys, strings, numbers and constants", () => {
	const line = `  "a": [1, -2.5e3, "x\\"y", true, null, false], "b": nope`;
	const spans = lexJsonLine(line);
	assert.equal(spans.map(span => span.text).join(""), line);
	const scope = (text: string): string | undefined => spans.find(span => span.text === text)?.scopes.at(-1);
	assert.equal(scope('"a"'), "support.type.property-name.json");
	assert.equal(scope('"x\\"y"'), "string.quoted.double.json");
	assert.equal(scope("1"), "constant.numeric.json");
	assert.equal(scope("-2.5e3"), "constant.numeric.json");
	assert.equal(scope("true"), "keyword.other.json");
});

test("a string cut at the end of its row (OMP cuts long lines) closes there instead of swallowing the next row", () => {
	const spans = lexJsonLine(`    "description": "Runs the tests (job: …`);
	assert.equal(spans.at(-1)?.scopes.at(-1), "string.quoted.double.json");
	assert.equal(spans.map(span => span.text).join(""), `    "description": "Runs the tests (job: …`);
});

test("a compact document is re-indented by tokens and keeps the spelling of big integers, exponents and -0", () => {
	const tree = jsonTree(`{"id":12345678901234567890,"big":1e400,"zero":-0,"s":"a, b: {c}","list":[1,2,{"k":[]}],"empty":{}}`);
	assert.deepEqual(tree.rows, [
		"{",
		`  "id": 12345678901234567890,`,
		`  "big": 1e400,`,
		`  "zero": -0,`,
		`  "s": "a, b: {c}",`,
		`  "list": [`,
		"    1,",
		"    2,",
		"    {",
		`      "k": []`,
		"    }",
		"  ],",
		`  "empty": {}`,
		"}",
	]);
	assert.equal(tree.end[0], 13); assert.equal(tree.size[0], 6);
	assert.equal(tree.end[5], 11); assert.equal(tree.size[5], 3); assert.equal(tree.level[5], 1);
	assert.equal(tree.end[8], 10); assert.equal(foldLabel(tree, 5), "… 3 items"); assert.equal(foldLabel(tree, 0), "… 6 keys");
	assert.equal(tree.end[9], -1, "an empty container does not fold");
});

test("an indented document keeps its own rows and indentation", () => {
	const text = `{\n    "a": {\n        "b": 1\n    },\n    "c": [\n        2\n    ]\n}`;
	const tree = jsonTree(text);
	assert.deepEqual(tree.rows, text.split("\n"));
	assert.deepEqual([...tree.end], [7, 3, -1, -1, 6, -1, -1, -1]);
});

test("detection: one JSON document, newline-delimited JSON, and plain text that merely contains braces", () => {
	const doc = detectOutputFormat(body("bash-json-pretty"));
	assert.equal(doc?.kind, "json"); assert.match(doc?.badge ?? "", /^JSON · 3\d lines$/);
	const records = detectOutputFormat(body("bash-ndjson"));
	assert.equal(records?.kind, "ndjson"); assert.equal(records?.badge, "NDJSON · 25 records");
	assert.equal(detectOutputFormat(body("bash-git-log-status")), null);
	assert.equal(detectOutputFormat("1 file {changed}"), null);
	assert.equal(detectOutputFormat("[1, 2"), null, "an unterminated document is text");
	assert.equal(detectOutputFormat("{\"a\":1}\nnot json\nnot json\nnot json\n{\"b\":2}"), null, "less than 80 % of the lines are records");
	assert.equal(detectOutputFormat("```json\n{\"a\":1}\n```")?.kind, "json", "a fence is not part of the document");
});

test("a result whose long lines OMP cut is shown as JSON with its lines cut, never as parsed data", () => {
	const text = body("bash-json-long-columntruncated");
	assert.throws(() => JSON.parse(text));
	const found = detectOutputFormat(text);
	assert.ok(found?.kind === "json"); assert.equal(found.cut, true); assert.equal(found.badge, "JSON · lines cut");
	assert.ok(found.tree.rows.length > 400);
	assert.ok(found.tree.foldable);
});

test("a result over 1 MiB is text, and detection cost grows in proportion to the size under the cap", () => {
	assert.equal(detectOutputFormat(`[${"1,".repeat(MAX_JSON_BYTES)}1]`), null);
	// The property is that one detection stays one bounded task up to the cap, which holds only while the cost is linear in the text. An
	// absolute time bound measures the machine as much as the code, so the cost of a document 8 times larger is compared with the cost
	// of the small one in this same process: linear work costs about 8 times as much, quadratic work about 64 times. The fastest of
	// several runs on each side leaves out a pause the machine took; each run is a different text because detection is cached by text.
	const fastest = (items: number): number => {
		let best = Infinity;
		for (let salt = 0; salt < 5; salt++) {
			const text = JSON.stringify(Array.from({ length: items }, (_, index) => ({ id: index, name: `item-${salt}-${index}`, tags: ["a", "b"] })));
			assert.ok(text.length < MAX_JSON_BYTES);
			const started = performance.now();
			const found = detectOutputFormat(text);
			best = Math.min(best, performance.now() - started);
			assert.equal(found?.kind, "json");
		}
		return best;
	};
	const small = fastest(2_500);
	const large = fastest(20_000);
	assert.ok(large < small * 24, `8 times the text costs ${(large / small).toFixed(1)} times as much (linear is about 8, quadratic about 64)`);
});

test("a tree of data leaves out nulls and the named root keys on request", () => {
	const tree = jsonTreeOfValue({ i: "intent", a: 1, b: null, c: { d: null, e: 2 } }, { absent: true, rootKeys: ["i"] });
	assert.deepEqual(tree.rows, ["{", `  "a": 1,`, `  "c": {`, `    "e": 2`, "  }", "}"]);
});
