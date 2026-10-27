import assert from "node:assert/strict";
import { test } from "node:test";
import { parseChatHostMessage, type ChatHostMessage } from "../protocol/chat-messages.ts";
import type { LinkRuleEntry } from "../shared/link-rules.ts";
import { ChatRuntime, type ChatPage } from "./chat-runtime.ts";
import { FakeRpcChannel } from "./rpc/fake-channel.ts";
import { RpcSession } from "./rpc/session.ts";
import { ManualTimers, messageEntry, userMessage, waitUntil } from "./rpc/test-support.ts";

const ISSUE: LinkRuleEntry = { id: 0, pattern: "#(\\d+)\\b", url: "https://example.test/issues/$1", ignoreCase: false, name: null };
const TICKET: LinkRuleEntry = { id: 1, pattern: "PROJ-(\\d+)", url: "https://example.test/browse/$1", ignoreCase: true, name: "Tracker" };

type Rules = readonly LinkRuleEntry[];

function recordingPage(id: string): { page: ChatPage; messages: Rules[]; order: string[] } {
	const messages: Rules[] = [];
	const order: string[] = [];
	const page: ChatPage = {
		id,
		post(message: ChatHostMessage) {
			order.push(message.type);
			if (message.type === "omp:chat-link-rules") messages.push(message.rules);
			return "sent";
		},
	};
	return { page, messages, order };
}

function newRuntime(readLinkRules: (() => Rules) | undefined): { runtime: ChatRuntime; start(): Promise<void> } {
	const timers = new ManualTimers();
	const runtime = new ChatRuntime({
		hostNonce: "link-rules-test",
		onEvent() {},
		createSession: options => new RpcSession({ ...options, timers, fileExists: async () => true }),
		...(readLinkRules === undefined ? {} : { readLinkRules }),
	});
	const start = async (): Promise<void> => {
		const channels = [0, 1].map(index => new FakeRpcChannel({ sessionFile: `D:/scratch/link-rules-${index}.jsonl`, entries: [{ ...messageEntry(`u${index}`, null, userMessage(`draft ${index}`, 1000)) }] }));
		const sessions = channels.map((channel, index) => runtime.startLive(`chat${index}`, { channel, sessionFile: null, cwd: "D:/scratch", title: null }));
		await waitUntil(() => sessions.every(session => session.phase === "live"));
	};
	return { runtime, start };
}

test("a page that is attached gets the current rules once, before the state, the empty list included", async () => {
	let rules: Rules = [];
	const { runtime, start } = newRuntime(() => rules);
	await start();
	const quiet = recordingPage("quiet");
	runtime.attachPage("chat0", quiet.page);
	assert.deepEqual(quiet.messages, [[]], "no rule: the page is told so, because a document that outlived a host restart may still hold rules the user has since removed");
	rules = [ISSUE, TICKET];
	const page = recordingPage("p0");
	runtime.attachPage("chat0", page.page);
	assert.deepEqual(page.messages, [[ISSUE, TICKET]]);
	assert.ok(page.order.indexOf("omp:chat-link-rules") < page.order.lastIndexOf("omp:chat-state"), "the rules go before the state");
	runtime.dispose();
});

test("refreshLinkRules reaches every attached page of every tab, an empty list included, and not a detached one", async () => {
	let rules: Rules = [ISSUE];
	const { runtime, start } = newRuntime(() => rules);
	await start();
	const a = recordingPage("a");
	const b = recordingPage("b");
	const c = recordingPage("c");
	runtime.attachPage("chat0", a.page);
	runtime.attachPage("chat1", b.page);
	const detach = runtime.attachPage("chat1", c.page);
	detach();
	rules = [ISSUE, TICKET];
	runtime.refreshLinkRules();
	assert.deepEqual(a.messages.at(-1), [ISSUE, TICKET]);
	assert.deepEqual(b.messages.at(-1), [ISSUE, TICKET]);
	assert.deepEqual(c.messages, [[ISSUE]], "a detached page hears only what it was sent while attached");
	rules = [];
	runtime.refreshLinkRules();
	assert.deepEqual(a.messages.at(-1), [], "removing the last rule reaches the page, so its links go");
	runtime.dispose();
});

test("a runtime with no reader sends nothing, and what it sends survives the page's own parser", async () => {
	const plain = newRuntime(undefined);
	await plain.start();
	const quiet = recordingPage("quiet");
	plain.runtime.attachPage("chat0", quiet.page);
	assert.deepEqual(quiet.messages, []);
	plain.runtime.dispose();

	const { runtime, start } = newRuntime(() => [ISSUE, TICKET]);
	await start();
	const seen: unknown[] = [];
	runtime.attachPage("chat0", {
		id: "wire",
		post(message) {
			if (message.type === "omp:chat-link-rules") seen.push(parseChatHostMessage(JSON.parse(JSON.stringify(message))));
			return "sent";
		},
	});
	assert.deepEqual(seen, [{ type: "omp:chat-link-rules", rules: [ISSUE, TICKET] }]);
	runtime.dispose();
});

test("the page's parser keeps a well-formed list, drops undeclared fields and refuses the rest whole", () => {
	const message = { type: "omp:chat-link-rules", rules: [ISSUE, TICKET] };
	assert.deepEqual(parseChatHostMessage({ ...message, extra: 1 }), message);
	assert.deepEqual(parseChatHostMessage({ ...message, rules: [{ ...ISSUE, extra: "x" }] }), { ...message, rules: [ISSUE] });
	assert.deepEqual(parseChatHostMessage({ type: "omp:chat-link-rules", rules: [] }), { type: "omp:chat-link-rules", rules: [] });
	for (const rules of [
		"nope", [null], [{ ...ISSUE, id: -1 }], [{ ...ISSUE, id: 1.5 }], [{ ...ISSUE, pattern: "" }], [{ ...ISSUE, url: 7 }], [{ ...ISSUE, ignoreCase: "yes" }], [{ ...ISSUE, name: "" }], [ISSUE, ISSUE],
		Array.from({ length: 21 }, (_, id) => ({ ...ISSUE, id })),
	]) {
		assert.equal(parseChatHostMessage({ type: "omp:chat-link-rules", rules }), null, JSON.stringify(rules).slice(0, 80));
	}
});
