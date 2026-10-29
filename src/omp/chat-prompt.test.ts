import assert from "node:assert/strict";
import { test } from "node:test";
import { CHAT_PROMPT, CHAT_PROMPT_INJECTIONS, HTML_PAGE_INJECTION, LINK_REMINDER, MAX_CHAT_PROMPT_CHARS, MAX_HTML_PAGE_INJECTION_CHARS, MAX_INJECTION_CHARS, MAX_LINK_REMINDER_CHARS, MAX_TOOL_INTENT_INJECTION_CHARS, TOOL_INTENT_INJECTION, chatPromptFor, registerChatPrompt, renderChatPrompt } from "./chat-prompt.ts";
import { HTML_PAGES_ENV, LINK_REMINDER_ENV, TOOL_INTENT_ENV } from "../wire/control-protocol.ts";
import type { ChatPromptContext } from "./chat-prompt.ts";

function bindEvent(name: string, env: Record<string, string | undefined> = {}): ((event: unknown, ctx: ChatPromptContext) => unknown) | undefined {
	const handlers = new Map<string, (event: unknown, ctx: ChatPromptContext) => unknown>();
	registerChatPrompt({ on: (event, handler) => { handlers.set(event, handler); } }, env);
	return handlers.get(name);
}

function bind(): (event: unknown, ctx: ChatPromptContext) => unknown {
	const handler = bindEvent("before_agent_start");
	assert.ok(handler);
	return handler;
}

const MAIN: ChatPromptContext = { mode: "rpc", agent: { kind: "main" } };
const IMAGE = { type: "image", data: "AAAA", mimeType: "image/png" };

function remind(messages: unknown[], ctx: ChatPromptContext = MAIN, env: Record<string, string | undefined> = { [LINK_REMINDER_ENV]: "1" }): unknown[] | undefined {
	const handler = bindEvent("context", env);
	assert.ok(handler);
	const result = handler({ type: "context", messages }, ctx) as { messages: unknown[] } | undefined;
	return result?.messages;
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

const TOOL_INTENT_TEXT = "This replaces the built-in rule for `i` (2–6-word present-participle intent). For every tool whose schema has an `i` field, set `i` to what you are doing and why, in terms of the current task: the question the call answers or the change it makes, naming its subject (feature, bug, file, agent). At most 10 words. It is shown beside the tool name and its arguments, so do not repeat them, and do not use a bare verb such as check, read, search, run, fix or wait. Examples: not \"Find menu\" but \"Find where the tool card menu is drawn\"; not \"Tree state\" but \"Check that agents left no uncommitted changes\". Do not add `i` to tools whose schema lacks this field.";

test("the tool-intent rule is in the Chat prompt only when ompDesk.toolIntentDescriptions is on", () => {
	const event = { type: "before_agent_start", prompt: "hi", systemPrompt: ["base"] };
	const on = bindEvent("before_agent_start", { [TOOL_INTENT_ENV]: "1" });
	assert.ok(on);
	const expected = renderChatPrompt([...CHAT_PROMPT_INJECTIONS, TOOL_INTENT_INJECTION]);
	assert.deepEqual(on(event, MAIN), { systemPrompt: ["base", expected] });
	assert.equal(expected.split("\n").at(-1), `- ${TOOL_INTENT_TEXT}`, "one more bullet, verbatim, after the standing rules");
	assert.equal(expected.startsWith(CHAT_PROMPT), true);
	assert.equal(on(event, { mode: "rpc", agent: { kind: "sub" } }), undefined, "a subagent is untouched");
	assert.equal(on(event, { mode: "tui", agent: { kind: "main" } }), undefined, "a Terminal session is untouched");
	assert.equal(on({ ...event, systemPrompt: ["base", expected] }, MAIN), undefined, "added once");
	for (const env of [{}, { [TOOL_INTENT_ENV]: "0" }, { [TOOL_INTENT_ENV]: "true" }]) {
		assert.equal(chatPromptFor(env), CHAT_PROMPT);
		assert.doesNotMatch(chatPromptFor(env), /`i`/, "off adds nothing about i");
		assert.deepEqual(bindEvent("before_agent_start", env)?.(event, MAIN), { systemPrompt: ["base", CHAT_PROMPT] });
	}
	assert.ok(TOOL_INTENT_INJECTION.text.length <= MAX_TOOL_INTENT_INJECTION_CHARS, `the rule is ${TOOL_INTENT_INJECTION.text.length} characters`);
	assert.doesNotMatch(TOOL_INTENT_INJECTION.text, /\n/);
});

test("the HTML page rule is in the Chat prompt only when ompDesk.chatHtmlPages is on, before the tool-intent rule", () => {
	const event = { type: "before_agent_start", prompt: "hi", systemPrompt: ["base"] };
	const on = bindEvent("before_agent_start", { [HTML_PAGES_ENV]: "1" });
	assert.ok(on);
	const expected = renderChatPrompt([...CHAT_PROMPT_INJECTIONS, HTML_PAGE_INJECTION]);
	assert.deepEqual(on(event, MAIN), { systemPrompt: ["base", expected] });
	assert.equal(expected.split("\n").at(-1), `- ${HTML_PAGE_INJECTION.text}`);
	assert.equal(on(event, { mode: "rpc", agent: { kind: "sub" } }), undefined, "a subagent is untouched");
	assert.equal(on(event, { mode: "tui", agent: { kind: "main" } }), undefined, "a Terminal session is untouched");
	assert.equal(chatPromptFor({ [HTML_PAGES_ENV]: "1", [TOOL_INTENT_ENV]: "1" }), renderChatPrompt([...CHAT_PROMPT_INJECTIONS, HTML_PAGE_INJECTION, TOOL_INTENT_INJECTION]));
	for (const env of [{}, { [HTML_PAGES_ENV]: "0" }, { [HTML_PAGES_ENV]: "true" }]) {
		assert.equal(chatPromptFor(env), CHAT_PROMPT);
		assert.doesNotMatch(chatPromptFor(env), /```html/, "off says nothing about pages");
	}
	assert.ok(HTML_PAGE_INJECTION.text.length <= MAX_HTML_PAGE_INJECTION_CHARS, `the rule is ${HTML_PAGE_INJECTION.text.length} characters`);
	assert.doesNotMatch(HTML_PAGE_INJECTION.text, /\n/);
	for (const token of ["--bg", "--fg", "--accent", "--c1", "--font-mono", "800px", "100vh", "`data:`", "height fixed", "fixed-height container", "Show full page"]) assert.ok(HTML_PAGE_INJECTION.text.includes(token), token);
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

test("the per-message reminder stays short and has one marker", () => {
	assert.ok(LINK_REMINDER.length <= MAX_LINK_REMINDER_CHARS, `the reminder is ${LINK_REMINDER.length} characters; the limit is ${MAX_LINK_REMINDER_CHARS}`);
	assert.doesNotMatch(LINK_REMINDER, /\n/);
	assert.ok(LINK_REMINDER.startsWith("[OMP Desk reminder]"));
});

test("every user prompt of a request is followed by its own reminder message, once, and nothing else changes", () => {
	const toolResult = { role: "toolResult", toolCallId: "t1", content: [{ type: "text", text: "ok" }] };
	const custom = { role: "custom", customType: "note", content: "hello" };
	const assistant = { role: "assistant", content: [{ type: "text", text: "hi" }] };
	const first = { role: "user", content: "first", timestamp: 1 };
	const second = { role: "user", content: [{ type: "text", text: "second" }, IMAGE], timestamp: 2 };
	const messages = [first, assistant, toolResult, custom, second];
	const reminder = (timestamp: number) => ({ role: "user", content: LINK_REMINDER, synthetic: true, attribution: "agent", timestamp });
	const result = remind(messages);
	assert.ok(result);
	assert.equal(result.length, 7);
	assert.equal(result[0], first, "the prompt itself is the very same object, so no cache breakpoint is lost on it");
	assert.deepEqual(result[1], reminder(1));
	assert.equal(result[2], assistant);
	assert.equal(result[3], toolResult);
	assert.equal(result[4], custom);
	assert.equal(result[5], second);
	assert.deepEqual(result[6], reminder(2));
	assert.equal(messages.length, 5, "the input array is not mutated");
	assert.deepEqual(remind(messages), result, "the same request always yields the same bytes");
	assert.equal(remind(result), undefined, "a request that already carries every reminder is left alone");
});

test("a synthetic message, a history rewrite and a non-message are not prompts", () => {
	const synthetic = { role: "user", content: "Continue.", synthetic: true };
	const rewrite = { role: "user", content: "rewound", historyRewriteAt: 5 };
	assert.equal(remind([synthetic, rewrite, null, "text", { role: "developer", content: "x" }]), undefined);
});

test("the reminder reaches only an RPC main session whose launch setting allows it", () => {
	const messages = [{ role: "user", content: "hi" }];
	assert.ok(remind(messages, MAIN));
	assert.equal(remind(messages, { mode: "tui", agent: { kind: "main" } }), undefined, "the native TUI renders replies itself");
	assert.equal(remind(messages, { mode: "rpc", agent: { kind: "sub" } }), undefined, "a subagent answers its parent, not the user");
	assert.equal(bindEvent("context", { [LINK_REMINDER_ENV]: "0" }), undefined, "ompDesk.linkReminder off registers no handler");
	assert.ok(bindEvent("context", { [LINK_REMINDER_ENV]: "1" }));
	assert.equal(bindEvent("context", {}), undefined, "an unset variable means the default, off");
	assert.equal(bindEvent("context", { [LINK_REMINDER_ENV]: "1" })?.({ type: "context", messages: "no" }, MAIN), undefined, "an unexpected event shape is left alone");
});
