import assert from "node:assert/strict";
import { test } from "node:test";
import { invokedSkillName, invokesListedSkill, leadingCommandToken, routesAsPrompt } from "./prompt-routing.ts";

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
