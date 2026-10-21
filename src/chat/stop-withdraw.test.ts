import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AssistantMessage, ChatContent, ChatEntry, ChatMessage, MessageContent } from "./messages.ts";
import { WITHDRAW_GRACE_MS, anchorKind, mayStillWithdraw, tailFacts, withdrawVerdict, type AnchorKind, type AnchorResult, type WithdrawInput } from "./stop-withdraw.ts";

const at = (n: number): string => new Date(Date.UTC(2026, 9, 21, 10, 0, n)).toISOString();
const message = (id: string, parentId: string | null, body: ChatMessage): ChatEntry => ({ type: "message", id, parentId, timestamp: at(1), message: body });
const user = (id: string, content: MessageContent): ChatEntry => message(id, null, { role: "user", timestamp: 1, content });
const assistant = (id: string, content: readonly ChatContent[], stopReason: AssistantMessage["stopReason"] = "aborted"): ChatEntry =>
	message(id, null, { role: "assistant", timestamp: 2, model: "m", stopReason, content } as AssistantMessage);
const bookkeeping = (id: string, type: "custom" | "unknown" | "model_change" | "thinking_level_change"): ChatEntry =>
	(type === "unknown" ? { type, id, parentId: null, timestamp: at(1), nativeType: "credential_pin", data: {} } : type === "custom" ? { type, id, parentId: null, timestamp: at(1), customType: "memory_recall" } : { type, id, parentId: null, timestamp: at(1), model: "m" }) as ChatEntry;
const notice = (id: string, attribution = "agent"): ChatEntry => ({ type: "custom_message", id, parentId: null, timestamp: at(1), customType: "magic-keyword", content: "hidden", display: false, attribution });
const skill = (id: string, prompt: string, attribution = "user"): ChatEntry =>
	({ type: "custom_message", id, parentId: null, timestamp: at(1), customType: "skill-prompt", content: "expanded", display: true, attribution, details: { name: "x", prompt } });
const tool = (id: string): ChatEntry => message(id, null, { role: "toolResult", timestamp: 3, toolCallId: "c", toolName: "read", isError: false, content: [] } as ChatMessage);
const text = (value: string): ChatContent => ({ type: "text", text: value });
const result = (status: AnchorResult["status"] = "aborted", agentInvoked = true): AnchorResult => ({ status, agentInvoked });

const BASE = { id: "base" };
const baseline = bookkeeping("base", "custom");
const input = (entries: readonly ChatEntry[], patch: Partial<WithdrawInput> = {}): WithdrawInput =>
	({ entries: [baseline, ...entries], baselineId: BASE.id, kind: "plain", text: "fix the typo", elapsedMs: 1_000, result: result(), ...patch });
const verdict = (entries: readonly ChatEntry[], patch: Partial<WithdrawInput> = {}): string => {
	const decided = withdrawVerdict(input(entries, patch));
	return decided.action === "remove" ? `remove:${decided.targetId}` : decided.action;
};
const prompt = user("u1", "fix the typo");

describe("anchorKind", () => {
	const commands = [
		{ name: "compact", source: "builtin" },
		{ name: "model", aliases: ["models"], source: "builtin" },
		{ name: "review", source: "custom" },
		{ name: "wakeup", source: "extension" },
		{ name: "fix-bug", source: "file" },
		{ name: "template", source: "prompt" },
		{ name: "skill:review", source: "skill" },
	];
	const kind = (text: string): AnchorKind | null => anchorKind(text, commands);

	it("takes plain text, an unlisted /name and a path as ordinary input", () => {
		for (const text of ["fix it", "", "  indented", "/unknown x", "/usr/bin/x fails", "go /skill:other"]) assert.equal(kind(text), "plain", JSON.stringify(text));
	});

	it("takes a markdown command or prompt template, and a listed skill invocation", () => {
		assert.equal(kind("/fix-bug now"), "template");
		assert.equal(kind("/template"), null, "OMP 18.12.2 has no prompt source: an unknown kind can act first");
		assert.equal(kind("/skill:review x"), "skill");
		assert.equal(kind("do it /skill:review"), "skill");
	});

	it("refuses every command that can act before it sends anything, and a shell or Python line", () => {
		for (const text of ["/compact", "/models p", "/review x", "/wakeup", "!ls", "!!ls", "$ echo", "$$ x"]) assert.equal(kind(text), null, text);
	});
});

describe("tailFacts", () => {
	it("finds the baseline by id, and an empty conversation (null) always", () => {
		assert.equal(tailFacts([baseline, prompt], "base").found, true);
		assert.equal(tailFacts([prompt], "gone").found, false);
		assert.equal(tailFacts([], null).found, true);
		assert.equal(tailFacts([prompt], null).requests, 1);
	});

	it("reads the thinking and the text of an aborted answer apart", () => {
		const thinking = tailFacts([baseline, prompt, assistant("a1", [{ type: "thinking", thinking: "hmm" }])], "base");
		assert.deepEqual([thinking.spoke, thinking.acted, thinking.aborted], [false, false, true]);
		const spoken = tailFacts([baseline, prompt, assistant("a1", [text("   "), text("Sure")])], "base");
		assert.deepEqual([spoken.spoke, spoken.acted], [true, false]);
		const acting = tailFacts([baseline, prompt, assistant("a1", [{ type: "toolCall", id: "c", name: "read", arguments: {} }])], "base");
		assert.equal(acting.acted, true);
		const unknown = tailFacts([baseline, prompt, assistant("a1", [{ type: "unknown", nativeType: "future", data: {} }])], "base");
		assert.equal(unknown.acted, true, "a block Desk does not know is not proven harmless");
	});
});

describe("withdrawVerdict: a persisted message", () => {
	it("removes the request of a stopped turn that has produced nothing, with or without an empty answer", () => {
		assert.equal(verdict([prompt, assistant("a1", [])]), "remove:u1");
		assert.equal(verdict([prompt]), "remove:u1", "no answer entry at all, the result says the turn was aborted");
		assert.equal(verdict([prompt, bookkeeping("d1", "custom"), assistant("a1", []), bookkeeping("p1", "unknown")]), "remove:u1", "bookkeeping around the answer does not count");
	});

	it("does not count thinking, however long the model thought", () => {
		const thinking = assistant("a1", [{ type: "thinking", thinking: "long" }, { type: "redactedThinking", data: "x" }]);
		assert.equal(verdict([prompt, thinking], { elapsedMs: 120_000 }), "remove:u1");
	});

	it("allows text inside the grace window and not after it", () => {
		const spoken = assistant("a1", [text("Sure, I will")]);
		assert.equal(verdict([prompt, spoken], { elapsedMs: WITHDRAW_GRACE_MS }), "remove:u1");
		assert.equal(verdict([prompt, spoken], { elapsedMs: WITHDRAW_GRACE_MS + 1 }), "keep");
	});

	it("never removes a message whose turn acted, whatever the time", () => {
		for (const block of [{ type: "toolCall", id: "c", name: "edit", arguments: {} }, { type: "anthropicServerTool", block: {} }] as const) {
			assert.equal(verdict([prompt, assistant("a1", [block])], { elapsedMs: 10 }), "keep", block.type);
		}
		assert.equal(verdict([prompt, assistant("a1", []), tool("t1")]), "keep");
	});

	it("keeps a turn that ended by itself or failed: nothing was stopped", () => {
		assert.equal(verdict([prompt, assistant("a1", [text("done")], "stop")], { elapsedMs: 10 }), "keep");
		assert.equal(verdict([prompt, assistant("a1", [], "error")]), "keep");
		assert.equal(verdict([prompt], { result: result("completed") }), "keep");
		assert.equal(verdict([prompt], { result: null }), "keep");
	});

	it("keeps the message when the turn holds more than the anchor's", () => {
		assert.equal(verdict([prompt, user("u2", "and also"), assistant("a1", [])]), "keep", "a second request");
		assert.equal(verdict([prompt, assistant("a1", []), assistant("a2", [])]), "keep", "a second answer");
		assert.equal(verdict([user("u0", "an earlier message"), prompt, assistant("a1", [])]), "keep", "a second request before it");
		assert.equal(verdict([assistant("a0", []), prompt]), "keep", "an answer before the request");
		assert.equal(verdict([prompt, assistant("a1", []), notice("n1")]), "keep", "an agent message after the answer");
		assert.equal(verdict([prompt, message("f1", null, { role: "fileMention", timestamp: 1, files: [] }), notice("n2"), assistant("a1", [])]), "remove:u1", "the request's own companions: @file contents, hook and next-turn messages");
		assert.equal(verdict([prompt, bookkeeping("m1", "model_change"), assistant("a1", [])]), "keep", "a switch after the request");
		assert.equal(verdict([prompt, assistant("a1", []), { type: "compaction", id: "c1", parentId: null, timestamp: at(1), summary: "s", firstKeptEntryId: "u1", tokensBefore: 1 }]), "keep");
	});

	it("allows the notices OMP writes before the request", () => {
		assert.equal(verdict([bookkeeping("m0", "model_change"), bookkeeping("t0", "thinking_level_change"), notice("n1"), message("f1", null, { role: "fileMention", timestamp: 1, files: [] }), prompt, assistant("a1", [])]), "remove:u1");
	});

	it("takes the request only when its text is the anchor's", () => {
		assert.equal(verdict([user("u1", "something else"), assistant("a1", [])]), "keep");
		assert.equal(verdict([user("u1", [text("fix the "), text("typo"), { type: "image", data: "AA==", mimeType: "image/png" }]), assistant("a1", [])]), "remove:u1", "text blocks join; images do not matter");
		assert.equal(verdict([user("u1", "  fix the typo\n"), assistant("a1", [])]), "remove:u1", "trimmed");
	});

	it("takes a template's request by position, because OMP stored the expansion", () => {
		assert.equal(verdict([user("u1", "the expanded template body"), assistant("a1", [])], { kind: "template", text: "/fix-bug now" }), "remove:u1");
	});

	it("takes a skill invocation the user typed, and only that", () => {
		const options = { kind: "skill" as const, text: "/skill:review please" };
		assert.equal(verdict([skill("s1", "/skill:review please"), assistant("a1", [])], options), "remove:s1");
		assert.equal(verdict([skill("s1", "/skill:review other"), assistant("a1", [])], options), "keep", "another invocation");
		assert.equal(verdict([skill("s1", "/skill:review please", "agent"), assistant("a1", [])], options), "keep", "injected by the agent: not a request, only a notice before one");
		assert.equal(verdict([user("u1", "/skill:review please"), assistant("a1", [])], options), "keep", "a user message is not an invocation");
	});
});

describe("withdrawVerdict: a prompt OMP dropped before dispatch", () => {
	it("returns the typed text when nothing but bookkeeping followed and the prompt's result says it was aborted", () => {
		assert.equal(verdict([]), "dropped");
		assert.equal(verdict([bookkeeping("m1", "model_change"), bookkeeping("r1", "custom")]), "dropped");
		assert.equal(verdict([], { kind: "skill", text: "/skill:review please" }), "dropped");
	});

	it("is unproven without that result, or with another one", () => {
		assert.equal(verdict([], { result: null }), "keep");
		assert.equal(verdict([], { result: result("completed") }), "keep");
		assert.equal(verdict([], { result: result("aborted", false) }), "keep");
		assert.equal(verdict([], { result: result("error") }), "keep");
	});

	it("is not a drop when OMP wrote anything but bookkeeping", () => {
		assert.equal(verdict([notice("n1")]), "keep");
		assert.equal(verdict([skill("s1", "/skill:review please", "agent")], { kind: "skill", text: "/skill:review please" }), "keep");
	});

	it("keeps the message when the baseline left the loaded branch", () => {
		assert.equal(withdrawVerdict({ ...input([prompt, assistant("a1", [])]), baselineId: "gone" }).action, "keep");
	});
});

describe("mayStillWithdraw", () => {
	const none = { stream: null, activeTools: 0 };
	const entries = (...rest: ChatEntry[]): ChatEntry[] => [baseline, ...rest];

	it("holds while nothing but the request, notices and an unanswered stream are visible", () => {
		assert.equal(mayStillWithdraw(entries(), "base", none, 0), true);
		assert.equal(mayStillWithdraw(entries(prompt), "base", none, 90_000), true);
		assert.equal(mayStillWithdraw(entries(prompt), "base", { stream: { content: [{ type: "thinking", thinking: "..." }] }, activeTools: 0 }, 90_000), true);
	});

	it("is lost by a tool call, a running tool, a second request, a foreign entry or a missing baseline", () => {
		assert.equal(mayStillWithdraw(entries(prompt, assistant("a1", [{ type: "toolCall", id: "c", name: "x", arguments: {} }])), "base", none, 0), false);
		assert.equal(mayStillWithdraw(entries(prompt), "base", { stream: { content: [{ type: "toolCall", id: "c", name: "x", arguments: {} }] }, activeTools: 0 }, 0), false);
		assert.equal(mayStillWithdraw(entries(prompt), "base", { stream: null, activeTools: 1 }, 0), false);
		assert.equal(mayStillWithdraw(entries(prompt, user("u2", "more")), "base", none, 0), false);
		assert.equal(mayStillWithdraw(entries(prompt, tool("t1")), "base", none, 0), false);
		assert.equal(mayStillWithdraw(entries(prompt), "gone", none, 0), false);
	});

	it("is lost by text once the grace is over, and not before", () => {
		const streaming = { stream: { content: [text("Sure")] }, activeTools: 0 };
		assert.equal(mayStillWithdraw(entries(prompt), "base", streaming, WITHDRAW_GRACE_MS), true);
		assert.equal(mayStillWithdraw(entries(prompt), "base", streaming, WITHDRAW_GRACE_MS + 1), false);
		assert.equal(mayStillWithdraw(entries(prompt, assistant("a1", [text("Sure")])), "base", none, WITHDRAW_GRACE_MS + 1), false);
	});
});
