import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import { build } from "esbuild";

/**
 * The pure half of quoting, on the real parse: a model of the DOM (each leaf's shown text, leaves separated by a line break)
 * stands in for the page, so a selection is given as the text it starts at and the text it ends at (the end is searched after the
 * start). The real DOM is checked in `chat-ui.test.ts`.
 */
type Capture = (source: string, start: string, end: string, emphasis?: boolean) => { markdown: string; plain: boolean };
let capture: Capture;
let leavesOf: (source: string, emphasis?: boolean) => { id: number; kind: string; emphasis: boolean; first: number; last: number; language?: string; closed?: boolean; open?: { text: string }; lines: { line: number; start: number; quote: number; text: string }[] }[];
/** Every text leaf selected whole while the DOM disagrees with the record (one more character than the record shows). */
let captureDisagreeing: (source: string) => { markdown: string; plain: boolean };
/** Every `[from, to)` with `from > 0` of every text leaf of `source`, alone: how many degraded, and the ranges whose slice did not show the text it covers, as `[markdown, covered]`. */
let sliceFailures: (source: string, emphasis?: boolean) => { checked: number; degraded: number; failures: string[][] };
/** Every `[from, to)` of every cell of every table of `source`, alone: as `sliceFailures` reports a text leaf. */
let cellFailures: (source: string) => { checked: number; degraded: number; failures: string[][] };
/** Streams `text` in the given prefix lengths and returns the leaves of each step. */
let leavesStreamed: (text: string, lengths: readonly number[]) => { id: number }[][];

before(async () => {
	const bundled = await build({ stdin: { contents: `
		import { parseMarkdown } from "./components/Markdown";
		import { quoteSurface } from "./lib/quote-capture";
		import { inlinePieces } from "./lib/markdown-inline";
		import { splitTableCells } from "./lib/markdown-table";
		const cellsOf = leaf => { const wanted = splitTableCells(leaf.table.header.text).length; const cells = splitTableCells(leaf.lines[0].text); return Array.from({ length: wanted }, (_, column) => cells[column] ? inlinePieces(cells[column].text, leaf.emphasis).map(piece => piece.visible).join("") : ""); };
		const shown = leaf => leaf.kind === "text" ? leaf.lines.map(line => inlinePieces(line.text, leaf.emphasis).map(piece => piece.visible).join("")).join("") : leaf.kind === "code" ? leaf.lines.map(line => line.text).join("\\n") : leaf.kind === "row" ? cellsOf(leaf).join("\\t") : leaf.lines[0].text;
		const model = (source, emphasis = true) => {
			const parsed = parseMarkdown(source, null, true, emphasis);
			let at = 0;
			return parsed.leaves.map(leaf => { const text = shown(leaf); const entry = { leaf, text, start: at }; at += text.length + 1; return entry; });
		};
		export const capture = (source, start, end, emphasis = true) => {
			const entries = model(source, emphasis);
			const document = entries.map(entry => entry.text).join("\\n");
			const from = document.indexOf(start);
			if (from < 0) throw new Error("start not found: " + start);
			const upTo = document.indexOf(end, from + start.length);
			if (upTo < 0) throw new Error("end not found: " + end);
			const to = upTo + end.length;
			const picks = [];
			const tables = new Map();
			for (const { leaf, text, start: at } of entries) if (leaf.kind === "row") { const span = tables.get(leaf.table) ?? [at, at]; span[1] = at + text.length; tables.set(leaf.table, span); }
			for (const { leaf, text, start: at } of entries) {
				const lo = Math.max(from, at) - at;
				const hi = Math.min(to, at + text.length) - at;
				if (hi <= lo) continue;
				if (leaf.kind === "row") {
					const cells = [];
					let cellStart = 0;
					cellsOf(leaf).forEach((cell, column) => {
						const a = Math.max(lo, cellStart);
						const b = Math.min(hi, cellStart + cell.length);
						if (b > a) cells.push({ column, text: cell, from: a - cellStart, to: b - cellStart });
						cellStart += cell.length + 1;
					});
					const [tableStart, tableEnd] = tables.get(leaf.table);
					const whole = (from < tableStart && document.slice(from, tableStart).trim() !== "") || (to > tableEnd && document.slice(tableEnd, to).trim() !== "");
					picks.push({ leaf, text: "", from: 0, to: 0, cells, whole });
				} else picks.push(leaf.kind === "text" || leaf.kind === "code" ? { leaf, text, from: lo, to: hi } : { leaf, text: "", from: 0, to: 0 });
			}
			return quoteSurface(source.split(/\\r?\\n/), picks);
		};
		export const leavesOf = (source, emphasis = true) => parseMarkdown(source, null, true, emphasis).leaves;
		export const captureDisagreeing = source => quoteSurface(source.split(/\\r?\\n/), model(source).filter(entry => entry.leaf.kind === "text").map(entry => ({ leaf: entry.leaf, text: entry.text + "!", from: 0, to: entry.text.length + 1 })));
		export const sliceFailures = (source, emphasis = true) => {
			let checked = 0;
			let degraded = 0;
			const failures = [];
			const lines = source.split(/\\r?\\n/);
			const bare = text => text.replace(/^(?:> ?)+/, "");
			for (const { leaf, text } of model(source, emphasis)) {
				if (leaf.kind !== "text") continue;
				for (let from = 1; from < text.length; from++) for (let to = from + 1; to <= text.length; to++) {
					checked++;
					const result = quoteSurface(lines, [{ leaf, text, from, to }]);
					const back = result.markdown.split("\\n").map(bare).map(line => result.plain ? line : inlinePieces(line, emphasis).map(piece => piece.visible).join("")).join("");
					if (result.plain) degraded++;
					if (back !== text.slice(from, to)) failures.push([result.markdown, text.slice(from, to)]);
				}
			}
			return { checked, degraded, failures };
		};
		export const cellFailures = source => {
			let checked = 0;
			let degraded = 0;
			const failures = [];
			const lines = source.split(/\\r?\\n/);
			const bare = text => text.replace(/^(?:> ?)+/, "");
			for (const { leaf } of model(source)) {
				if (leaf.kind !== "row") continue;
				cellsOf(leaf).forEach((text, column) => {
					for (let from = 0; from < text.length; from++) for (let to = from + 1; to <= text.length; to++) {
						if (text.slice(from, to).trim().length === 0) continue;
						checked++;
						const result = quoteSurface(lines, [{ leaf, text: "", from: 0, to: 0, cells: [{ column, text, from, to }], whole: false }]);
						const back = result.markdown.split("\\n").map(bare).map(line => result.plain ? line : inlinePieces(line, true).map(piece => piece.visible).join("")).join("");
						if (result.plain) degraded++;
						if (back !== text.slice(from, to)) failures.push([result.markdown, text.slice(from, to)]);
					}
				});
			}
			return { checked, degraded, failures };
		};
		export const leavesStreamed = (text, lengths) => {
			let previous = null;
			return lengths.map(length => {
				const parsed = parseMarkdown(text.slice(0, length), previous, true);
				previous = parsed;
				return parsed.leaves;
			});
		};
	`, loader: "ts", resolveDir: join(process.cwd(), "src/webview") }, bundle: true, write: false,
	format: "cjs", platform: "node", packages: "external", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' } });
	const module = { exports: {} as { capture: Capture; leavesOf: typeof leavesOf; captureDisagreeing: typeof captureDisagreeing; sliceFailures: typeof sliceFailures; cellFailures: typeof sliceFailures; leavesStreamed: typeof leavesStreamed } };
	new Function("require", "module", "exports", bundled.outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports);
	({ capture, leavesOf, captureDisagreeing, sliceFailures, cellFailures, leavesStreamed } = module.exports);
});

const md = (source: string, start: string, end: string): string => capture(source, start, end).markdown;

describe("the leaf records", () => {
	it("give a paragraph its source lines, and a heading, a rule and a table row theirs", () => {
		const leaves = leavesOf("# Title\n\nfirst\nsecond\n\n---\n\n| a | b |\n| - | - |\n| 1 | 2 |");
		assert.deepEqual(leaves.map(leaf => [leaf.kind, leaf.first, leaf.last]), [["text", 0, 0], ["text", 2, 3], ["rule", 5, 5], ["row", 7, 7], ["row", 9, 9]]);
		assert.deepEqual(leaves[0]!.lines.map(line => [line.line, line.start, line.text]), [[0, 2, "Title"]]);
		assert.deepEqual(leaves[1]!.lines.map(line => [line.line, line.start, line.text]), [[2, 0, "first"], [3, 0, "second"]]);
	});

	it("record the columns a quote, a list item and a lazy continuation stripped, and the depth of the quote", () => {
		const leaves = leavesOf("> - item\n>   more\n> > deep\n\n- a\ncontinued");
		const lines = leaves.flatMap(leaf => leaf.lines.map(line => [line.line, line.start, line.quote, line.text]));
		assert.deepEqual(lines, [[0, 4, 1, "item"], [1, 4, 1, "more"], [2, 4, 2, "deep"], [4, 2, 0, "a"], [5, 0, 0, "continued"]]);
	});

	it("record a code block's fences, language and body, inside a list too", () => {
		const [code] = leavesOf("```ts extra\nconst a = 1;\n```");
		assert.equal(code!.kind, "code");
		assert.deepEqual([code!.first, code!.last, code!.language, code!.closed, code!.open!.text], [0, 2, "ts", true, "```ts extra"]);
		assert.deepEqual(code!.lines.map(line => [line.line, line.start, line.text]), [[1, 0, "const a = 1;"]]);
		const list = leavesOf("- item\n\n  ```py\n  x = 1\n  ```")[1]!;
		assert.equal(list.kind, "code");
		assert.deepEqual(list.lines.map(line => [line.line, line.start, line.text]), [[3, 2, "x = 1"]]);
	});

	it("keep their numbers and objects for the blocks a streaming parse reuses", () => {
		const text = "first paragraph\n\n- a\n- b\n\n```ts\nconst x = 1;\n```\n\nlast";
		const steps = leavesStreamed(text, [30, 45, text.length]);
		for (const leaves of steps) assert.deepEqual(leaves.map(leaf => leaf.id), leaves.map((_, index) => index), "the leaves are numbered from 0 without a gap");
		for (const leaves of steps) assert.equal(leaves[0], steps[0]![0], "the first block's leaf is the same object in every step");
		assert.ok(steps[steps.length - 1]!.length >= 5);
	});

	it("number a stalled line's paragraph like any other and never leave a leaf of an undone block", () => {
		const leaves = leavesOf("1234567890. x\n\ntext");
		assert.deepEqual(leaves.map(leaf => leaf.id), leaves.map((_, index) => index));
	});
});

describe("the Markdown of a selection", () => {
	it("is the whole source of a whole paragraph, tokens included", () => {
		assert.equal(md("Hello **bold** and `code` and [a link](https://example.com/x) world", "Hello", "world"), "Hello **bold** and `code` and [a link](https://example.com/x) world");
	});

	it("carries a token as source only when the selection covers its whole shown text, and its shown text when it cuts it", () => {
		assert.equal(md("a **bold** b", "bold", " b"), "**bold** b");
		assert.equal(md("a **bold** b", "ld", " b"), "ld b");
		assert.equal(md("a **bold** b", "a ", "bol"), "a bol", "a cut token keeps only its shown text");
		assert.equal(md("see [the guide](https://example.com/g) now", "the guide", " now"), "[the guide](https://example.com/g) now");
		assert.equal(md("see [the guide](https://example.com/g) now", "guide", " now"), "guide now");
		assert.equal(md("run `npm test` now", "npm", " now"), "`npm test` now");
		assert.equal(md("run `npm test` now", "test", " now"), "test now");
	});

	it("keeps the marker of a list item or a heading only when the selection starts at its shown start", () => {
		assert.equal(md("- one\n- two\n- three", "one", "tw"), "- one\n- tw");
		assert.equal(md("- one\n- two\n- three", "ne", "tw"), "ne\n- tw");
		assert.equal(md("3. one\n4. two", "one", "two"), "3. one\n4. two");
		assert.equal(md("# Title\n\npara", "Title", "para"), "# Title\n\npara");
		assert.equal(md("# Title\n\npara", "tle", "para"), "tle\n\npara");
	});

	it("joins pieces on neighbouring source lines with a line break and the others with one blank line", () => {
		assert.equal(md("first\n\nsecond\nthird\n\nfourth", "first", "fourth"), "first\n\nsecond\nthird\n\nfourth");
		assert.equal(md("a\n\n\n\nb", "a", "b"), "a\n\nb");
	});

	it("keeps a quote's prefixes, so quoted lines are quoted again, nested", () => {
		assert.equal(md("> quoted *x*\n> more\n\nafter", "quoted", "more"), "> quoted *x*\n> more");
		assert.equal(md("> quoted *x*\n> more\n\nafter", "ted", "more"), "> ted *x*\n> more", "a token the selection covers whole is source even when the line is cut before it");
		assert.equal(md("> quoted *x*\n> more\n\nafter", "x", "after"), "> *x*\n> more\n\nafter");
		assert.equal(md("> a\n> > b\n> > c", "a", "c"), "> a\n> > b\n> > c");
		assert.equal(md("> - item *a* here\n> - second", "item", "here"), "> - item *a* here");
		assert.equal(md("> - item *a* here\n> - second", "a", " here"), "> *a* here");
	});

	it("separates quoted pieces that are not on neighbouring lines with a bare quote line", () => {
		assert.equal(md("> one\n>\n> two", "one", "two"), "> one\n>\n> two");
		assert.equal(md("> > one\n> >\n> > two", "one", "two"), "> > one\n> >\n> > two");
	});

	it("re-fences a code selection with the language and a fence longer than any backtick run at a line start", () => {
		const code = "```ts\nconst a = 1;\nconst b = 2;\n```";
		assert.equal(md(code, "const a", "= 2;"), "```ts\nconst a = 1;\nconst b = 2;\n```");
		assert.equal(md(code, "a = 1;", "const b"), "```ts\na = 1;\nconst b\n```");
		assert.equal(md("````md\n```\ninner\n```\n````", "```\ninner", "```"), "````md\n```\ninner\n```\n````");
		assert.equal(md("````md\n  ```\ninner\n````", "  ```", "inner"), "````md\n  ```\ninner\n````", "an indented run closes a fence, so it is counted");
		assert.equal(md("```\nplain\n```", "pl", "ain"), "```\nplain\n```");
	});

	it("re-fences a code block inside a quote with the quote's prefix and a list's code without it", () => {
		assert.equal(md("> ```ts\n> let a;\n> ```", "let", "a;"), "> ```ts\n> let a;\n> ```");
		assert.equal(md("- item\n\n  ```py\n  x = 1\n  ```", "item", "x = 1"), "- item\n\n```py\nx = 1\n```");
	});

	it("keeps a rule, and a table whole when the selection starts or ends outside it", () => {
		const table = "intro\n\n| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |\n\nafter";
		assert.equal(md(table, "intro", "3"), "intro\n\n| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |", "a selection that starts before the table takes the rows it reaches whole");
		assert.equal(md(table, "3", "after"), "| a | b |\n| - | - |\n| 3 | 4 |\n\nafter", "and so does one that ends after it");
		assert.equal(md("above\n\n---\n\nbelow", "above", "below"), "above\n\n---\n\nbelow");
	});

	describe("a table", () => {
		const table = "intro\n\n| alpha | beta | gamma |\n| :-- | :-: | --: |\n| 1 | **two** and x | 3 |\n| 4 | five | 6 \\| z |\n\nafter";

		it("quotes the selected text of one cell and nothing of the table", () => {
			assert.equal(md(table, "wo", "an"), "wo an", "a cut token is its shown text");
			assert.equal(md(table, "two", " and"), "**two** and", "a token the selection covers whole is source");
			assert.equal(md(table, "two", "x"), "**two** and x");
			assert.equal(md(table, "bet", "a"), "beta", "a header cell is quoted the same way");
			assert.equal(md(table, "6", "z"), "6 | z", "a pipe the cell escaped is a plain pipe once the cell stands alone");
			assert.equal(md(table, "iv", "e"), "ive");
			assert.equal(md("> | alpha | beta |\n> | - | - |\n> | one | two |", "lp", "ha"), "> lpha", "a table inside a quote keeps the quote");
		});

		it("keeps a table of the columns between the start cell and the end cell, the two edge cells cut to the selection", () => {
			assert.equal(md(table, "wo", "3"), "| beta | gamma |\n| :-: | --: |\n| wo and x | 3 |");
			assert.equal(md(table, "two", "3"), "| beta | gamma |\n| :-: | --: |\n| **two** and x | 3 |", "an edge cell the selection covers whole is source");
			assert.equal(md(table, "1", "wo"), "| alpha | beta |\n| :-- | :-: |\n| 1 | **two** |", "the end cell is cut to the selected text, and a token it covers whole is source");
			assert.equal(md(table, "1", "tw"), "| alpha | beta |\n| :-- | :-: |\n| 1 | tw |", "a token the end cell cuts is its shown text");
			assert.equal(md(table, "five", "6 |"), "| beta | gamma |\n| :-: | --: |\n| five | 6 \\| |", "a pipe in a cut cell is escaped again");
			assert.equal(md(table, "five", "z"), "| beta | gamma |\n| :-: | --: |\n| five | 6 \\| z |", "an uncut cell keeps its source, escapes included");
		});

		it("keeps the rectangle between the start cell and the end cell across rows", () => {
			assert.equal(md(table, "two", "five"), "| beta |\n| :-: |\n| **two** and x |\n| five |", "one column, two rows: still a table");
			assert.equal(md(table, "3", "4"), "| alpha | beta | gamma |\n| :-- | :-: | --: |\n| 1 | **two** and x | 3 |\n| 4 | five | 6 \\| z |", "the start cell is right of the end cell: the columns are the range between them");
			assert.equal(md(table, "lph", "wo"), "| lpha | beta |\n| :-- | :-: |\n| 1 | **two** |", "the start cell is cut from the selection point to its end, in the header too");
		});

		it("takes the touched rows whole when the selection starts before the table or ends after it", () => {
			assert.equal(md(table, "intro", "five"), "intro\n\n| alpha | beta | gamma |\n| :-- | :-: | --: |\n| 1 | **two** and x | 3 |\n| 4 | five | 6 \\| z |");
			assert.equal(md(table, "five", "after"), "| alpha | beta | gamma |\n| :-- | :-: | --: |\n| 4 | five | 6 \\| z |\n\nafter");
		});

		it("shows the text of every cell range, whole and cut, without degrading", () => {
			for (const source of [table, "| a **b** `c` | [l](https://example.com) _d_ |\n| - | - |\n| *e* f | g ~~h~~ |", "> | alpha | **beta** |\n> | - | - |\n> | one | two |"]) {
				const result = cellFailures(source);
				assert.ok(result.checked > 10, source);
				assert.deepEqual(result.failures, [], source);
				assert.equal(result.degraded, 0, source);
			}
		});
	});

	it("degrades a leaf whose record disagrees with what is drawn to its shown text, and says so", () => {
		const result = captureDisagreeing("Hello **bold** world");
		assert.equal(result.plain, true);
		assert.equal(result.markdown, "Hello bold world!");
		assert.equal(capture("Hello **bold** world", "Hello", "world").plain, false);
	});
});

describe("every range of a leaf", () => {
	const CORPUS = [
		"Plain text with **bold**, *italic*, `code`, ~~strike~~, [a link](https://example.com/a-b) and https://example.com/x-y-z end.",
		"- item **one** with [link](https://example.com)\n- item `two` and *more*\n  - nested _deep_ item",
		"> quoted **bold** and `code`\n> second *line*\n> > nested [x](https://example.com)",
		"1. first **a**\n2. second `b` text\n\n   continued paragraph with *emphasis*",
		"# Heading with **bold** and `code`",
		"line one **bold**\nline two `code` and [l](https://example.com)",
		"> - item *a* here\n>   more `c`",
	];

	it("shows the text it covers, and a partial selection inside a quoted list item is exact without degrading", () => {
		for (const source of CORPUS) {
			const result = sliceFailures(source);
			assert.ok(result.checked > 10, source);
			assert.deepEqual(result.failures, [], source);
			assert.equal(result.degraded, 0, source);
		}
	});

	it("degrades, rather than changes the text, where a cut token's shown text would read as markup once quoted", () => {
		const result = sliceFailures("see https://example.com/x_y_z now");
		assert.deepEqual(result.failures, []);
		assert.ok(result.degraded > 0);
	});
});

describe("text the user typed (no emphasis)", () => {
	const user = (source: string, start: string, end: string): string => capture(source, start, end, false).markdown;

	it("records the mode on every leaf, so capture reads the line the way the renderer drew it", () => {
		assert.equal(leavesOf("a _b_ c\n\n> q *x*", false).every(leaf => !leaf.emphasis), true);
		assert.equal(leavesOf("a _b_ c").every(leaf => leaf.emphasis), true);
	});

	it("quotes a selection of `_` and `*` text exactly as typed, whole and cut", () => {
		const source = "call obj._method() ..... obj._otherMethod() then 1*234*343 and **b** ~~s~~ done";
		assert.deepEqual(capture(source, "call", "done", false), { markdown: source, plain: false });
		assert.equal(user(source, "_method", "_other"), "_method() ..... obj._other");
		assert.equal(user(source, "234", "343"), "234*343");
		assert.equal(user(source, "1*", "343"), "1*234*343");
		assert.equal(user(source, "**b**", "~~s~~"), "**b** ~~s~~");
		assert.equal(user(source, "b**", "~~s"), "b** ~~s");
	});

	it("is not what the same text quotes as in a styled message", () => {
		assert.equal(md("1*234*343", "1234", "343"), "1*234*343");
		assert.equal(md("a *b* c", "b", " c"), "*b* c", "a styled token the selection covers whole is source");
		assert.equal(md("a *b* c", "b", "c"), "*b* c");
		assert.equal(user("a *b* c", "b", " c"), "b* c", "a user message's `*` is a character of the shown text");
	});

	it("still carries code spans and links as source when the selection covers them whole", () => {
		assert.equal(user("run `npm test` and [a link](https://example.com/x) now", "npm", " now"), "`npm test` and [a link](https://example.com/x) now");
		assert.equal(user("run `npm test` now", "test", " now"), "test now");
		assert.equal(user("> quoted _x_ here\n> more", "quoted", "more"), "> quoted _x_ here\n> more");
	});

	it("shows the text it covers for every range, without degrading", () => {
		const sources = ["obj._method() ..... obj._otherMethod()", "1*234*343 and **b** ~~s~~", "> quoted _x_ and `code`\n> second *line*", "- item *one*\n- item _two_ [l](https://example.com)"];
		for (const source of sources) {
			const result = sliceFailures(source, false);
			assert.ok(result.checked > 10, source);
			assert.deepEqual(result.failures, [], source);
			assert.equal(result.degraded, 0, source);
		}
	});
});
