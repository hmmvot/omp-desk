import assert from "node:assert/strict";
import { test } from "node:test";
import { CHAT_PROMPT, CHAT_PROMPT_INJECTIONS, MAX_CHAT_PROMPT_CHARS, MAX_INJECTION_CHARS, registerChatPrompt } from "./chat-prompt.ts";
import type { ChatPromptContext } from "./chat-prompt.ts";

function bind(): (event: unknown, ctx: ChatPromptContext) => unknown {
	const handlers = new Map<string, (event: unknown, ctx: ChatPromptContext) => unknown>();
	registerChatPrompt({ on: (event, handler) => { handlers.set(event, handler); } });
	const handler = handlers.get("before_agent_start");
	assert.ok(handler);
	return handler;
}

test("only an RPC main session's system prompt gets the Chat prompt, once", () => {
	const handler = bind();
	const event = { type: "before_agent_start", prompt: "hi", systemPrompt: ["base", "rules"] };
	assert.deepEqual(handler(event, { mode: "rpc", agent: { kind: "main" } }), { systemPrompt: ["base", "rules", CHAT_PROMPT] });
	assert.equal(handler(event, { mode: "tui", agent: { kind: "main" } }), undefined, "the native TUI renders replies itself");
	assert.equal(handler(event, { mode: "rpc", agent: { kind: "sub" } }), undefined, "a subagent answers its parent, not the user");
	assert.equal(handler({ ...event, systemPrompt: ["base", CHAT_PROMPT] }, { mode: "rpc", agent: { kind: "main" } }), undefined);
	assert.equal(handler({ ...event, systemPrompt: "base" }, { mode: "rpc", agent: { kind: "main" } }), undefined, "an unexpected shape is left alone");
});

test("the Chat prompt stays within its size budget, one short rule per injection", () => {
	assert.ok(CHAT_PROMPT.length <= MAX_CHAT_PROMPT_CHARS, `the Chat prompt is ${CHAT_PROMPT.length} characters; the budget is ${MAX_CHAT_PROMPT_CHARS}`);
	const ids = new Set<string>();
	for (const injection of CHAT_PROMPT_INJECTIONS) {
		assert.ok(injection.text.length <= MAX_INJECTION_CHARS, `injection "${injection.id}" is ${injection.text.length} characters; the limit is ${MAX_INJECTION_CHARS}`);
		assert.doesNotMatch(injection.text, /\n/, `injection "${injection.id}" must be one line`);
		assert.ok(!ids.has(injection.id), `injection id "${injection.id}" is repeated`);
		ids.add(injection.id);
	}
});
