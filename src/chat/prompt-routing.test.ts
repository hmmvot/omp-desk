import assert from "node:assert/strict";
import { test } from "node:test";
import { embeddedSkillInvokedAt, invokedSkillName, invokesListedSkill, leadingCommandToken, routesAsPrompt } from "./prompt-routing.ts";

test("the skill a text invokes is the one OMP's parseSkillInvocation finds", () => {
	for (const [text, name] of [
		["/skill:review", "review"],
		["/skill:review src/a.ts", "review"],
		["  /skill:review\nmore", "review"],
		["/skill:agents/tracker x", "agents/tracker"],
		["please /skill:review the file", "review"],
		["line\n/skill:review", "review"],
		["a /skill:one /skill:two b", "one"],
		["a /skill:x/y/z b", null],
		["/skill:", null],
		["/compact /skill:review x", null],
		["!ls /skill:review", null],
		["$ echo /skill:review", null],
		["a/skill:review b", null],
		["plain", null],
	] as const) assert.equal(invokedSkillName(text), name, JSON.stringify(text));
});

test("a skill token beginning at an offset is OMP's invocation only under the gates of invokedSkillName and with no earlier skill-shaped token", () => {
	const at = (text: string): boolean => embeddedSkillInvokedAt(text, text.lastIndexOf("/"));
	for (const text of ["fix /skill:x", "line\n/skill:x", "${HOME} /skill:x", "$HOME /skill:x", "a /skill:x/y/z /skill:x"]) assert.equal(at(text), true, JSON.stringify(text));
	for (const text of ["/compact /skill:x", "  /compact /skill:x", "!ls /skill:x", "$ echo /skill:x", "$$ echo /skill:x", "a /skill:one /skill:two", "a /skill:unknown /skill:x", "a /skill:ns/y b /skill:x"]) assert.equal(at(text), false, JSON.stringify(text));
	assert.equal(embeddedSkillInvokedAt("a /skill:x/y/z /skill:w", 15), true, "a token OMP does not read as a skill (two slashes) is no earlier token");
});

test("only a skill the session lists is an invocation", () => {
	const commands = [{ name: "skill:review", source: "skill" }, { name: "skill:fake", source: "extension" }, { name: "compact", source: "builtin" }];
	assert.equal(invokesListedSkill("/skill:review x", commands), true);
	assert.equal(invokesListedSkill("go /skill:review", commands), true);
	assert.equal(invokesListedSkill("/skill:other x", commands), false);
	assert.equal(invokesListedSkill("/skill:fake x", commands), false);
	assert.equal(invokesListedSkill("/compact x", commands), false);
});

test("a leading slash command the session lists, by name or alias, is sent as a prompt; text that is not one is not", () => {
	const commands = [
		{ name: "compact", source: "builtin" },
		{ name: "model", aliases: ["models"], source: "builtin" },
		{ name: "review", source: "custom" },
		{ name: "wakeup", source: "extension" },
		{ name: "skill:review", source: "skill" },
	];
	for (const text of ["/compact", "/compact keep files", "/models gpt", "/review focus", "/wakeup now", "/skill:review x", "see /skill:review"]) assert.equal(routesAsPrompt(text, commands), true, text);
	for (const text of ["", "plain", "/unknown x", "/Compact x", " /compact x", "x /compact", "/usr/bin/x", "/", "/compact:x", "/skill:other x"]) assert.equal(routesAsPrompt(text, commands), false, JSON.stringify(text));
	assert.equal(leadingCommandToken("/compact\nmore"), "compact");
	assert.equal(leadingCommandToken("compact"), null);
});
