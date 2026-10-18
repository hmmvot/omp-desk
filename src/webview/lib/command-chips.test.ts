import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatSlashCommand } from "../../chat/model.ts";
import { commandResolver, findChips, findCommandChips, type ResolveCommand } from "./command-chips.ts";
import { deletionRange, snapSelection } from "./image-references.ts";

const COMMANDS: readonly ChatSlashCommand[] = [
	{ name: "compact", source: "builtin" },
	{ name: "status", aliases: ["m"], source: "builtin" },
	{ name: "skill:review", source: "skill", aliases: ["review"] },
	{ name: "skill:ns/deep", source: "skill" },
	{ name: "skill:other", source: "skill" },
	{ name: "worktree", source: "builtin" },
	{ name: "clear", source: "OMP Desk" },
];
const resolve: ResolveCommand = commandResolver(COMMANDS);
const spans = (text: string): [number, number, string][] => findCommandChips(text, resolve).map(chip => [chip.start, chip.end, chip.kind]);

test("a command or a skill that the catalogue lists tells a command from a skill, and an alias is its entry's kind", () => {
	assert.equal(resolve("compact"), "command");
	assert.equal(resolve("m"), "command");
	assert.equal(resolve("skill:review"), "skill");
	assert.equal(resolve("review"), "skill");
	assert.equal(resolve("rewind"), "command", "Desk's own commands are always known");
	assert.equal(resolve("Compact"), null, "names match exactly, as OMP's own lookup does");
	assert.equal(resolve("REWIND"), "command", "Chat's own interceptors match in any case, so their commands do too");
	assert.equal(resolve("worktree"), null, "a denied identity-changing builtin stays plain text");
});

test("a leading command becomes a chip once whitespace follows its name, taking the one space after it", () => {
	assert.deepEqual(spans("/compact now"), [[0, 9, "command"]]);
	assert.deepEqual(spans("/compact  now"), [[0, 9, "command"]], "only the first space belongs to the chip");
	assert.deepEqual(spans("/compact\nnow"), [[0, 8, "command"]], "a line break follows without being part of it");
	assert.deepEqual(spans("/compact\tnow"), [[0, 8, "command"]]);
	assert.deepEqual(spans("/skill:review file.ts"), [[0, 14, "skill"]]);
	assert.deepEqual(spans("/m x"), [[0, 3, "command"]]);
	assert.deepEqual(spans(" /compact now"), [[1, 10, "command"]], "the send trims the left edge, so a leading blank does not make it text");
	assert.deepEqual(spans("\n\n/skill:review x"), [[2, 16, "skill"]]);
});

test("a name that is still being typed, an unknown command and a path stay plain text", () => {
	for (const text of ["/compact", "/skill:review", "/comp now", "/foo bar", "/usr/bin/x now", "/compact/x now", "x /compact now", "/Compact now", "/worktree now", "/ now", "", "/"]) {
		assert.deepEqual(spans(text), [], JSON.stringify(text));
	}
});

test("a skill is a chip mid-text exactly where OMP would invoke it: the first token, delimited by whitespace", () => {
	assert.deepEqual(spans("please /skill:review the file"), [[7, 21, "skill"]]);
	assert.deepEqual(spans("line one\n/skill:review\ntwo"), [[9, 22, "skill"]]);
	assert.deepEqual(spans("a /skill:ns/deep b"), [[2, 17, "skill"]], "a namespaced name has exactly one slash");
	assert.deepEqual(spans("  /skill:review x"), [[2, 16, "skill"]], "OMP trims the left edge of a leading skill");
	assert.deepEqual(spans("a /skill:review /skill:other b"), [[2, 16, "skill"]], "only the first token is invoked");
	for (const text of ["a /skill:nope /skill:review b", "a/skill:review b", "a /skill:review", "a /skill:ns/deep/x b", "a /skill:ns/ b", "see /usr/skill:review b"]) {
		assert.deepEqual(spans(text), [], `${JSON.stringify(text)}: an unknown first token or no delimiter means no invocation`);
	}
});

test("a skill token is plain text inside another command, a shell sigil or a local execution", () => {
	for (const text of ["/compact do /skill:review x", "/foo /skill:review x", "!ls /skill:review x", "$ echo /skill:review x", "$$ echo /skill:review x", "$\n/skill:review x"]) {
		assert.deepEqual(spans(text).filter(([, , kind]) => kind === "skill"), [], JSON.stringify(text));
	}
	assert.deepEqual(spans("${HOME} /skill:review x"), [[8, 22, "skill"]], "`${` is not a sigil");
	assert.deepEqual(spans("$HOME /skill:review x"), [[6, 20, "skill"]], "a `$` that is not followed by a blank is not a sigil");
});

test("an attachment marker keeps the text it covers and the chips come out in text order", () => {
	const known = (kind: string, number: number): boolean => kind === "image" && number === 1;
	const text = "/compact [Image #1, 5x5] x";
	assert.deepEqual(findChips(text, known, resolve).map(chip => [chip.kind, chip.start, chip.end]), [["command", 0, 9], ["image", 9, 24]]);
	const inside = "a [File #1: x /skill:review y.md] z";
	assert.deepEqual(findChips(inside, (kind, number) => kind === "file" && number === 1, resolve).map(chip => chip.kind), ["file"], "a token inside a marker's label is not a second chip");
});

test("the chip is atomic for the existing selection and deletion rules, and Backspace after it removes the name and its space", () => {
	const text = "/compact args";
	const chips = findCommandChips(text, resolve);
	assert.deepEqual(deletionRange(chips, 9, 9, "backward"), { start: 0, end: 9 });
	assert.deepEqual(deletionRange(chips, 0, 0, "forward"), { start: 0, end: 9 });
	assert.deepEqual(deletionRange(chips, 5, 9, "range"), { start: 0, end: 9 }, "a range that cuts into it takes it whole");
	assert.deepEqual(snapSelection(chips, 4, 4, true), { start: 9, end: 9 });
	assert.deepEqual(snapSelection(chips, 4, 4, false), { start: 0, end: 0 });
	assert.equal(deletionRange(chips, 11, 11, "backward"), null, "text after the chip is the browser's");
});

test("the same catalogue gives the same chips whether or not a turn runs: the host sends a command or a skill as a prompt either way", () => {
	assert.equal(resolve("compact"), "command");
	assert.equal(resolve("skill:review"), "skill");
	assert.equal(resolve("clear"), "command");
	assert.equal(resolve("REWIND"), "command");
	assert.deepEqual(findCommandChips("/compact x", resolve).map(chip => chip.kind), ["command"]);
	assert.deepEqual(findCommandChips("see /skill:review now", resolve).map(chip => chip.kind), ["skill"]);
});
