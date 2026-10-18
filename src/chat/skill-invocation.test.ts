import assert from "node:assert/strict";
import { test } from "node:test";
import { invokedSkillName, invokesListedSkill } from "./skill-invocation.ts";

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
