import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { splitToolNotices } from "../../chat/tool-notices.ts";
import { detectRows, lineTone, parseFrame } from "./output-rows.ts";
import { detectOutput } from "./output-format.ts";

interface Call { id: string; resultText: string }
const calls: readonly Call[] = JSON.parse(readFileSync(new URL("../fixtures/tool-calls.json", import.meta.url), "utf8"));
const body = (id: string): string => splitToolNotices(calls.find(call => call.id === id)?.resultText ?? assert.fail(id)).body;

test("an ls -l listing is a table of seven columns, with the totals line left as text", () => {
	const found = detectRows(body("bash-table-ls-la"));
	assert.ok(found !== null && found.tables.length >= 1);
	assert.match(found.badge, /^Table · \d+ rows/);
	const first = found.rows.find(row => row.cells !== undefined);
	assert.deepEqual(first?.cells, ["drwxrwxrwx", "1", "somebody", "somegroup", "4096", "Oct  9 22:38", "."]);
	assert.equal(found.rows[0]!.cells, undefined, "`total 450456` is a line of text");
	assert.deepEqual(found.tables[0]!.right.slice(0, 5), [false, true, false, false, true], "link count and size are right-aligned");
	assert.equal(found.rows.length, body("bash-table-ls-la").replace(/\s+$/, "").split("\n").length, "every line is a row");
});

test("a Format-Table result is a table under its title line; the lines around it stay text", () => {
	const found = detectRows(body("bash-table-powershell-format-table"));
	assert.ok(found !== null);
	const head = found.rows.find(row => row.head === true && row.cells?.[0] === "ProcessId");
	assert.deepEqual(head?.cells, ["ProcessId", "Name"]);
	const data = found.rows.find(row => row.cells?.[0] === "159484");
	assert.deepEqual(data?.cells, ["159484", "powershell.exe"]);
	assert.equal(found.tables[0]!.right[0], true, "a column of numbers is right-aligned");
	assert.equal(found.rows[0]!.cells, undefined);
});

test("a stack trace has frames with the path and line to link, and a lone frame is not a trace", () => {
	const python = detectRows(body("bash-stack-python-traceback"));
	assert.ok(python !== null); assert.match(python.badge, /^Stack trace · \d+ frames$/);
	assert.equal(python.rows.some(row => row.dim === true), true, "the source line under a Python frame is dim too");
	assert.deepEqual(parseFrame('  File "/src/a.py", line 12, in run'), { location: "/src/a.py", path: "/src/a.py", line: 12 });
	assert.deepEqual(parseFrame("    at Object.run (C:\\work\\src\\a.ts:41:7)"), { location: "C:\\work\\src\\a.ts:41:7", path: "C:\\work\\src\\a.ts", line: 41, column: 7 });
	assert.deepEqual(parseFrame("    at /work/src/b.js:3:1"), { location: "/work/src/b.js:3:1", path: "/work/src/b.js", line: 3, column: 1 });
	assert.deepEqual(parseFrame("   at App.Run() in C:\\x\\Program.cs:line 42"), { location: "C:\\x\\Program.cs:line 42", path: "C:\\x\\Program.cs", line: 42 });
	assert.equal(parseFrame("    at node:internal/modules/run_main:101:11"), null);
	assert.equal(detectRows("Error: boom\n    at run (/work/a.js:1:1)\nand more"), null);
});

test("error, warning and pass lines are tinted by their words, and nothing else is", () => {
	for (const [line, tone] of [
		["src/extension.ts(902,13): error TS2304: Cannot find name 'x'.", "err"], ["✖ failing test", "err"], ["not ok 3 - thing", "err"], ["npm ERR! code ELIFECYCLE", "err"],
		["TypeError: x is not a function", "err"], ["error: command not found: wmic", "err"], ["fatal: not a git repository", "err"], ["FAIL src/a.test.ts", "err"],
		["⚠ deprecated", "warn"], ["warning: unused variable", "warn"], ["WARN something", "warn"],
		["✔ flat list (6.1164ms)", "pass"], ["ok 1 - thing", "pass"], ["PASS src/a.test.ts", "pass"],
		["a normal line", null], ["the book was okay", null], ["errors: 0", null], ["    ✔ nested pass", "pass"],
	] as const) assert.equal(lineTone(line), tone, line);
});

test("detection prefers JSON, then tables and traces, and leaves plain output alone", () => {
	assert.equal(detectOutput(body("bash-ndjson"))?.kind, "ndjson");
	assert.equal(detectOutput(body("bash-table-ls-la"))?.kind, "rows");
	assert.equal(detectOutput(body("bash-git-log-status")), null);
	assert.equal(detectOutput(body("bash-tsc-npm-typecheck-fail")), null);
});
