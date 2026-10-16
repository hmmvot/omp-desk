import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_ATTACH_ITEMS } from "./attach-limits.ts";
import {
	ZERO_WIDTH_SPACE as Z,
	composeFileBlocks,
	escapeFileText,
	fileMarker,
	headerValue,
	markerName,
	reduceFileBlocks,
	splitFileBlocks,
	unescapeFileText,
	type FileBlockSource,
} from "./file-blocks.ts";

/** OMP 18.11.1's own patterns, copied from the installed source (`file-mentions.ts`, `model-mention-syntax.ts`, `turn-budget.ts`, `skill-tokens.ts`). */
const OMP_FILE_MENTION = /@(?:"([^"]+)"|'([^']+)'|([^\s@]+))/g;
const OMP_MENTION_BOUNDARY = /[\s([{<"'`]/;
const OMP_MODEL_MENTION = /(^|\s)\^([^\s^]+)(?=\s|$)/;
const OMP_TURN_BUDGET = /(?:^|\s)\+(\d+(?:\.\d+)?)([km])?(!)?(?=\s|$)/i;
const OMP_SKILL_TOKEN = /(^|\s)\/skill:([^\s/]+(?:\/[^\s/]+)?)(?=\s|$)/;

/** What OMP would act on in `text`: the kinds of sigil it finds. */
function ompActsOn(text: string): string[] {
	const found: string[] = [];
	for (const match of text.matchAll(OMP_FILE_MENTION)) {
		if (match.index === 0 || OMP_MENTION_BOUNDARY.test(text[match.index - 1]!)) found.push(`@ at ${match.index}`);
	}
	if (OMP_MODEL_MENTION.test(text)) found.push("^model");
	if (OMP_TURN_BUDGET.test(text)) found.push("+N");
	if (OMP_SKILL_TOKEN.test(text)) found.push("/skill:");
	return found;
}

function document(number: number, name: string, content: string, label: string | null = null): FileBlockSource {
	return { number, name, label, content };
}

/** The prose a draft would have: a sentence naming every document's marker. */
function proseFor(documents: readonly FileBlockSource[], lead = "Look at"): string {
	return `${lead} ${documents.map(entry => fileMarker(entry.number, entry.name)).join(" and ")}`;
}

describe("escapeFileText", () => {
	it("puts U+200B before each sigil OMP acts on, and nowhere else", () => {
		assert.equal(escapeFileText("@a.ts"), `${Z}@a.ts`);
		assert.equal(escapeFileText("see @a.ts and (@b) and \"@c\" and `@d` and [@e] {@f} <@g> '@h'"), `see ${Z}@a.ts and (${Z}@b) and "${Z}@c" and \`${Z}@d\` and [${Z}@e] {${Z}@f} <${Z}@g> '${Z}@h'`);
		assert.equal(escapeFileText("^fast"), `${Z}^fast`);
		assert.equal(escapeFileText("go +500k now +2m! and +1.5"), `go ${Z}+500k now ${Z}+2m! and ${Z}+1.5`);
		assert.equal(escapeFileText("/skill:review"), `${Z}/skill:review`);
		assert.equal(escapeFileText("run /skill:ns/review please"), `run ${Z}/skill:ns/review please`);
	});

	it("leaves what OMP would not act on untouched", () => {
		for (const text of ["", "plain text", "mail me@example.com", "a+b", "price +5.5x", "a ^b^c", "a ^", "+", "+5abc", "x /skill:", "x /skill:a/b/c", "1 + 2", "/etc/skill:x", "line\n@", "ab^cd"]) {
			if (text === "line\n@") continue;
			assert.equal(escapeFileText(text), text, JSON.stringify(text));
		}
	});

	it("counts the start of every line as a boundary, as OMP sees the message", () => {
		assert.equal(escapeFileText("first\n@a\n^b\n+3\n/skill:s\n\t@c"), `first\n${Z}@a\n${Z}^b\n${Z}+3\n${Z}/skill:s\n\t${Z}@c`);
		assert.equal(escapeFileText("a\r\n@b"), `a\r\n${Z}@b`);
	});

	it("escapes a U+200B that already stands in front of a sigil, so the inverse cannot take it for its own", () => {
		assert.equal(escapeFileText(`${Z}@a`), `${Z}${Z}@a`);
		assert.equal(unescapeFileText(`${Z}${Z}@a`), `${Z}@a`);
		assert.equal(escapeFileText(`x ${Z}${Z}^m`), `x ${Z}${Z}${Z}^m`);
		assert.equal(escapeFileText(`a${Z}@b`), `a${Z}@b`, "a U+200B after a letter shields nothing and is not a site");
		assert.equal(unescapeFileText(`${Z}@a`), `@a`);
		assert.equal(unescapeFileText(`a${Z}@b`), `a${Z}@b`);
	});

	it("is inverted exactly for generated text, and no pattern of OMP acts on its output", () => {
		const alphabet = ["@", "^", "+", "/skill:", "skill:", "/", "a", "b", "1", "5", "k", "m", "!", ".", "-", " ", "\n", "\t", "\r", "\r\n", Z, Z + Z, "(", "[", "{", "<", "\"", "'", "`", ")", "x", "name", "日本", "😀", "\u00a0", "<file ", "</file>", "@@", "^^", "++"];
		let seed = 0x9e3779b9;
		const next = (bound: number): number => {
			seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
			return seed % bound;
		};
		for (let round = 0; round < 6000; round++) {
			let text = "";
			for (let pieces = next(28); pieces > 0; pieces--) text += alphabet[next(alphabet.length)]!;
			const escaped = escapeFileText(text);
			assert.equal(unescapeFileText(escaped), text, `round trip of ${JSON.stringify(text)}`);
			assert.deepEqual(ompActsOn(escaped), [], `OMP acts on ${JSON.stringify(escaped)}`);
			assert.deepEqual(ompActsOn(`note\n\n<file name="a" n="1" chars="${escaped.length}">\n${escaped}\n</file>`), [], `OMP acts on the block of ${JSON.stringify(escaped)}`);
			// Only U+200B was added.
			assert.equal(escaped.replaceAll(Z, ""), text.replaceAll(Z, ""));
		}
	});
});

describe("headerValue", () => {
	it("writes the sigils as JSON escapes so a header cannot be acted on, and parses back to the original", () => {
		for (const value of ["docs/plan.md", "a @b.md", "x ^y", "n +5", "s /skill:k", "\"quoted\" \\ back\\slash", "tab\there", "日本語.md", "e\u0001e"]) {
			const written = headerValue(value);
			assert.deepEqual(ompActsOn(` ${written} `), [], written);
			assert.equal(JSON.parse(written), value);
		}
		assert.equal(headerValue("a/skill:b"), '"a\\u002fskill:b"');
	});
});

describe("markerName", () => {
	it("replaces brackets and control characters and clips by code points", () => {
		assert.equal(markerName("a[1].md"), "a(1).md");
		assert.equal(markerName("a\nb\u0000c"), "a b c");
		assert.equal(markerName("😀".repeat(70)), "😀".repeat(60));
		assert.equal(fileMarker(3, "x.md"), "[File #3: x.md]");
	});
});

describe("composeFileBlocks and splitFileBlocks", () => {
	it("returns the prose alone when there is no document", () => {
		assert.equal(composeFileBlocks("hello", []), "hello");
		assert.deepEqual(splitFileBlocks("hello"), { prose: "hello", blocks: [] });
	});

	it("round-trips one and several blocks, with a path or a name", () => {
		const documents = [document(1, "plan.md", "# Plan\n\ncontent\n", "docs/plan.md"), document(2, "notes.md", "pasted text"), document(5, "c.ts", "const a = 1;", "D:/Other/c.ts")];
		const prose = proseFor(documents);
		const text = composeFileBlocks(prose, documents);
		assert.ok(text.startsWith(`${prose}\n\n<file path="docs/plan.md" n="1" chars="16">\n# Plan\n\ncontent\n\n</file>\n\n<file name="notes.md" n="2" chars="11">`));
		const split = splitFileBlocks(text);
		assert.equal(split.prose, prose);
		assert.deepEqual(split.blocks.map(block => ({ ...block })), documents.map(entry => ({ number: entry.number, name: entry.name, label: entry.label, content: entry.content, omitted: false })));
	});

	it("reads an empty file and astral characters (the count is in UTF-16 units)", () => {
		const documents = [document(1, "empty.txt", ""), document(2, "emoji.md", "😀 and 日本 and 😀\n")];
		const text = composeFileBlocks(proseFor(documents), documents);
		assert.ok(text.includes('<file name="empty.txt" n="1" chars="0">\n\n</file>'));
		assert.deepEqual(splitFileBlocks(text).blocks.map(block => block.content), ["", "😀 and 日本 and 😀\n"]);
	});

	it("reads a file whose text holds a closing tag, a whole block, a header and a blank line", () => {
		const trap = [
			"before </file> after",
			"x\n\n<file name=\"fake.md\" n=\"2\" chars=\"3\">\nabc\n</file>",
			"\n\n<file path=\"p\" n=\"9\" chars=\"1\">\n",
			"tail\n\n",
		].join("\n");
		const documents = [document(1, "a.md", trap), document(2, "b.md", "second")];
		const text = composeFileBlocks(proseFor(documents), documents);
		const split = splitFileBlocks(text);
		assert.deepEqual(split.blocks.map(block => block.content), [trap, "second"]);
	});

	it("counts the escaped text, returns the original, and keeps a file that already holds U+200B", () => {
		const content = `@src/a.ts ^fast +500k /skill:review\n${Z}@x and ${Z}${Z}^y\nline\n@z`;
		const documents = [document(1, "m.md", content, "m.md")];
		const text = composeFileBlocks(proseFor(documents), documents);
		const escaped = escapeFileText(content);
		assert.notEqual(escaped, content);
		assert.ok(text.includes(`chars="${escaped.length}">\n${escaped}\n</file>`));
		assert.deepEqual(ompActsOn(text.slice(text.indexOf("<file"))), []);
		assert.equal(splitFileBlocks(text).blocks[0]!.content, content);
	});

	it("writes a header whose name holds sigils without them in clear, and parses it back", () => {
		const name = "a @b ^c +5 /skill:d.md";
		const documents = [document(1, name, "x")];
		const text = composeFileBlocks(proseFor(documents), documents);
		const header = text.slice(text.indexOf("<file"), text.indexOf(">\n", text.indexOf("<file")));
		assert.deepEqual(ompActsOn(header), []);
		const block = splitFileBlocks(text).blocks[0]!;
		assert.equal(block.name, name);
		const labelled = composeFileBlocks(proseFor([document(1, "z.md", "x")]), [document(1, "z.md", "x", "@scope/a ^b/z.md")]);
		assert.equal(splitFileBlocks(labelled).blocks[0]!.label, "@scope/a ^b/z.md");
	});

	it("round-trips a label with quotes, backslashes and control characters through JSON", () => {
		const named = document(1, "path\twith\u0001ctl.md", "body", 'we"ird \\ ctl\tpath\u0001/path\twith\u0001ctl.md');
		assert.equal(splitFileBlocks(composeFileBlocks(proseFor([named]), [named])).blocks[0]!.label, named.label);
	});

	it("parses the reduced form of the prompt history: omitted with chars 0", () => {
		const text = `Check ${fileMarker(1, "plan.md")}\n\n<file path="D:/proj/docs/plan.md" n="1" chars="0" omitted="true">\n\n</file>`;
		const split = splitFileBlocks(text);
		assert.deepEqual(split.blocks.map(block => ({ ...block })), [{ number: 1, name: "plan.md", label: "D:/proj/docs/plan.md", content: "", omitted: true }]);
		assert.equal(splitFileBlocks(text.replace('chars="0"', 'chars="1"').replace("\n\n</file>", "x\n</file>")).blocks.length, 0, "omitted only goes with chars 0");
	});

	it("takes anything that does not parse exactly for prose", () => {
		const one = [document(1, "a.md", "hello")];
		const good = composeFileBlocks(proseFor(one), one);
		assert.equal(splitFileBlocks(good).blocks.length, 1);
		const cases: Record<string, string> = {
			"a wrong count": good.replace('chars="5">\nhello', 'chars="4">\nhello'),
			"a missing footer": good.replace("\n</file>", ""),
			"trailing text after the last block": `${good}\nmore`,
			"a marker missing from the prose": composeFileBlocks("no marker here", one),
			"a marker whose label differs": composeFileBlocks(fileMarker(1, "other.md"), one),
			"a marker that comes after the block": `${proseFor(one).replace(fileMarker(1, "a.md"), "x")}${good.slice(good.indexOf("\n\n<file"))}\n${fileMarker(1, "a.md")}`,
			"no blank line before the first block": good.replace("\n\n<file", "\n<file"),
		};
		for (const [label, text] of Object.entries(cases)) assert.deepEqual(splitFileBlocks(text), { prose: text, blocks: [] }, label);
	});

	it("reads the blocks after a damaged one and leaves the damaged one in the prose, so nothing is lost", () => {
		const two = [document(1, "a.md", "hello"), document(2, "b.md", "world")];
		const damaged = composeFileBlocks(proseFor(two), two).replace('chars="5">\nhello', 'chars="4">\nhello');
		const split = splitFileBlocks(damaged);
		assert.deepEqual(split.blocks.map(block => block.name), ["b.md"]);
		assert.ok(split.prose.includes('chars="4">\nhello'));
		const descending = composeFileBlocks(proseFor(two), [document(2, "b.md", "world"), document(1, "a.md", "hello")]);
		assert.deepEqual(splitFileBlocks(descending).blocks.map(block => block.number), [1], "numbers must ascend within one chain");
	});

	it("refuses more than MAX_ATTACH_ITEMS blocks and accepts exactly that many", () => {
		const make = (count: number) => {
			const documents = Array.from({ length: count }, (_, index) => document(index + 1, `f${index + 1}.md`, "x"));
			return composeFileBlocks(documents.map(entry => fileMarker(entry.number, entry.name)).join(" "), documents);
		};
		assert.equal(splitFileBlocks(make(MAX_ATTACH_ITEMS)).blocks.length, MAX_ATTACH_ITEMS);
		assert.equal(splitFileBlocks(make(MAX_ATTACH_ITEMS + 1)).blocks.length, 0);
	});

	it("does not let typed text that looks like a block hide a real chain, in either order", () => {
		const real = [document(1, "a.md", "real")];
		const text = composeFileBlocks(proseFor(real), real);
		// Typed look-alike before the chain, with a marker and a valid shape but ending before the end of the text.
		const typed = `${fileMarker(7, "x.md")}\n\n<file name="x.md" n="7" chars="2">\nhi\n</file>\n\nthen`;
		const combined = splitFileBlocks(`${typed}\n\n${text}`);
		assert.deepEqual(combined.blocks.map(block => block.name), ["a.md"]);
		assert.ok(combined.prose.startsWith(typed));
		// A forged header whose count lands exactly on the real chain: the real chain still wins its own candidate.
		const forgedHeader = `<file name="x.md" n="7" chars="`;
		const lead = `${fileMarker(7, "x.md")}\n\n`;
		const forged = `${lead}${forgedHeader}${text.length - text.indexOf("<file") + 4}">\n`;
		const spliced = splitFileBlocks(`${forged}${text}`);
		assert.deepEqual(spliced.blocks.map(block => block.name), ["a.md"]);
	});

	it("parses a 200 000-character text of 20 000 near-headers in linear time", () => {
		const nearHeader = '\n\n<file name="x" n="1" chars="9999999">';
		const noise = nearHeader.repeat(Math.floor(200_000 / nearHeader.length));
		const real = [document(1, "x", "ok")];
		const text = composeFileBlocks(`${proseFor(real)}${noise}`, real);
		const started = performance.now();
		const split = splitFileBlocks(text);
		const elapsed = performance.now() - started;
		assert.equal(split.blocks.length, 1);
		assert.ok(elapsed < 2_000, `took ${elapsed} ms`);
		const unparsed = splitFileBlocks(noise.repeat(2));
		assert.equal(unparsed.blocks.length, 0);
	});
});

describe("reduceFileBlocks", () => {
	it("keeps the prose and reduces each block to its reference, a path made absolute and a name kept", () => {
		const documents = [document(1, "a.md", "text @x\n", "docs/a.md"), document(2, "b [1].txt", "body")];
		const text = composeFileBlocks(proseFor(documents), documents);
		const reduced = reduceFileBlocks(text, label => `D:/work/${label}`);
		assert.ok(!reduced.includes("text"), "no file text is stored");
		const back = splitFileBlocks(reduced);
		assert.equal(back.prose, proseFor(documents));
		assert.deepEqual(back.blocks.map(block => [block.number, block.name, block.label, block.content, block.omitted]), [
			[1, "a.md", "D:/work/docs/a.md", "", true],
			[2, "b [1].txt", null, "", true],
		]);
	});

	it("returns a text that does not parse, and a prose with no document, as it is", () => {
		assert.equal(reduceFileBlocks("just words", label => label), "just words");
		const broken = composeFileBlocks(proseFor([document(1, "a", "x")]), [document(1, "a", "x")]).replace('chars="1"', 'chars="9"');
		assert.equal(reduceFileBlocks(broken, label => label), broken);
	});
});
