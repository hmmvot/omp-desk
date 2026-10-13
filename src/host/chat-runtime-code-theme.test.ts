import assert from "node:assert/strict";
import { test } from "node:test";
import type { CodeTheme } from "../chat/code-theme.ts";
import { parseChatHostMessage, type ChatHostMessage } from "../protocol/chat-messages.ts";
import { ChatRuntime, type ChatPage } from "./chat-runtime.ts";
import { FakeRpcChannel } from "./rpc/fake-channel.ts";
import { RpcSession } from "./rpc/session.ts";
import { ManualTimers, messageEntry, userMessage, waitUntil } from "./rpc/test-support.ts";

const DARK: CodeTheme = { id: "Demo Dark", rules: [{ scopes: ["string"], foreground: "#ce9178" }] };
const LIGHT: CodeTheme = { id: "Demo Light", rules: [{ scopes: ["string"], foreground: "#a31515", fontStyle: "italic" }] };

type Themes = readonly CodeTheme[];

function recordingPage(id: string): { page: ChatPage; messages: Themes[] } {
	const messages: Themes[] = [];
	const page: ChatPage = {
		id,
		post(message: ChatHostMessage) {
			if (message.type === "omp:chat-code-theme") messages.push(message.themes);
			return "sent";
		},
	};
	return { page, messages };
}

function newRuntime(readCodeThemes: (() => Themes) | undefined): { runtime: ChatRuntime; start(): Promise<void> } {
	const timers = new ManualTimers();
	const runtime = new ChatRuntime({
		hostNonce: "code-theme-test",
		onEvent() {},
		createSession: options => new RpcSession({ ...options, timers, fileExists: async () => true }),
		...(readCodeThemes === undefined ? {} : { readCodeThemes }),
	});
	const start = async (): Promise<void> => {
		const channels = [0, 1].map(index => new FakeRpcChannel({ sessionFile: `D:/scratch/code-theme-${index}.jsonl`, entries: [{ ...messageEntry(`u${index}`, null, userMessage(`draft ${index}`, 1000)) }] }));
		const sessions = channels.map((channel, index) => runtime.startLive(`chat${index}`, { channel, sessionFile: null, cwd: "D:/scratch", title: null }));
		await waitUntil(() => sessions.every(session => session.phase === "live"));
	};
	return { runtime, start };
}

async function startRuntime(readCodeThemes: (() => Themes) | undefined): Promise<ChatRuntime> {
	const { runtime, start } = newRuntime(readCodeThemes);
	await start();
	return runtime;
}

test("a page that is attached or re-sent gets the current themes first, once per resend, before the state", async () => {
	let themes: Themes = [DARK];
	const runtime = await startRuntime(() => themes);
	const order: string[] = [];
	const seen: Themes[] = [];
	runtime.attachPage("chat0", {
		id: "p0",
		post(message) {
			order.push(message.type);
			if (message.type === "omp:chat-code-theme") seen.push(message.themes);
			return "sent";
		},
	});
	assert.deepEqual(seen, [[DARK]], "attach resends: one message");
	assert.equal(order[0], "omp:chat-code-theme");
	assert.ok(order.includes("omp:chat-state"), "the state follows");
	themes = [LIGHT, DARK];
	runtime.resend("chat0", "p0");
	assert.deepEqual(seen, [[DARK], [LIGHT, DARK]]);
	runtime.dispose();
});

test("a page attached before its conversation exists still receives the themes", async () => {
	const { runtime, start } = newRuntime(() => [DARK]);
	const early = recordingPage("early");
	runtime.attachPage("chat0", early.page);
	assert.deepEqual(early.messages, [[DARK]]);
	await start();
	runtime.resend("chat0", "early");
	assert.deepEqual(early.messages, [[DARK], [DARK]]);
	runtime.dispose();
});

test("refreshCodeThemes reaches every attached page of every tab, not a detached one", async () => {
	let themes: Themes = [DARK];
	const runtime = await startRuntime(() => themes);
	const a = recordingPage("a");
	const b = recordingPage("b");
	const c = recordingPage("c");
	const detached = recordingPage("d");
	runtime.attachPage("chat0", a.page);
	runtime.attachPage("chat0", b.page);
	runtime.attachPage("chat1", c.page);
	const detach = runtime.attachPage("chat1", detached.page);
	detach();
	for (const recorded of [a, b, c, detached]) recorded.messages.length = 0;
	themes = [LIGHT];
	runtime.refreshCodeThemes();
	assert.deepEqual(a.messages, [[LIGHT]]);
	assert.deepEqual(b.messages, [[LIGHT]]);
	assert.deepEqual(c.messages, [[LIGHT]]);
	assert.deepEqual(detached.messages, [], "a detached page gets nothing");
	runtime.dispose();
});

test("no themes are sent as an empty list, also by a runtime without a reader", async () => {
	let themes: Themes = [];
	const runtime = await startRuntime(() => themes);
	const page = recordingPage("p");
	runtime.attachPage("chat0", page.page);
	runtime.refreshCodeThemes();
	assert.deepEqual(page.messages, [[], []]);
	themes = [DARK];
	runtime.refreshCodeThemes();
	assert.deepEqual(page.messages.at(-1), [DARK]);
	runtime.dispose();

	const plain = await startRuntime(undefined);
	const plainPage = recordingPage("q");
	plain.attachPage("chat0", plainPage.page);
	plain.refreshCodeThemes();
	assert.deepEqual(plainPage.messages, [[], []]);
	plain.dispose();
});

test("a page that was never attached gets nothing, and resend for it is ignored", async () => {
	const runtime = await startRuntime(() => [DARK]);
	const stranger = recordingPage("stranger");
	runtime.resend("chat0", "stranger");
	runtime.refreshCodeThemes();
	assert.deepEqual(stranger.messages, []);
	runtime.dispose();
});

test("the message the runtime sends passes the page-side parser", async () => {
	const runtime = await startRuntime(() => [DARK, LIGHT]);
	const seen: unknown[] = [];
	runtime.attachPage("chat0", {
		id: "p",
		post(message) {
			if (message.type === "omp:chat-code-theme") seen.push(parseChatHostMessage(JSON.parse(JSON.stringify(message))));
			return "sent";
		},
	});
	assert.deepEqual(seen, [{ type: "omp:chat-code-theme", themes: [DARK, LIGHT] }]);
	runtime.dispose();
});
