import assert from "node:assert/strict";
import { test } from "node:test";
import { parseChatHostMessage, type ChatHostMessage } from "../protocol/chat-messages.ts";
import type { ChatKeyHint } from "../shared/key-hints.ts";
import { ChatRuntime, type ChatPage } from "./chat-runtime.ts";
import { FakeRpcChannel } from "./rpc/fake-channel.ts";
import { RpcSession } from "./rpc/session.ts";
import { ManualTimers, messageEntry, userMessage, waitUntil } from "./rpc/test-support.ts";

const ALT_T: ChatKeyHint = { command: "ompDesk.toggleThinking", key: "Alt+T", conflicts: [{ by: "IntelliJ IDEA Keymap", command: "git.sync" }], more: 2 };
const FIND: ChatKeyHint = { command: "ompDesk.findInChat", key: null, conflicts: [], more: 0 };

type Keys = readonly ChatKeyHint[];

function recordingPage(id: string): { page: ChatPage; messages: Keys[]; order: string[] } {
	const messages: Keys[] = [];
	const order: string[] = [];
	const page: ChatPage = {
		id,
		post(message: ChatHostMessage) {
			order.push(message.type);
			if (message.type === "omp:chat-keys") messages.push(message.keys);
			return "sent";
		},
	};
	return { page, messages, order };
}

function newRuntime(readKeyHints: (() => Keys) | undefined): { runtime: ChatRuntime; start(): Promise<void> } {
	const timers = new ManualTimers();
	const runtime = new ChatRuntime({
		hostNonce: "key-hints-test",
		onEvent() {},
		createSession: options => new RpcSession({ ...options, timers, fileExists: async () => true }),
		...(readKeyHints === undefined ? {} : { readKeyHints }),
	});
	const start = async (): Promise<void> => {
		const channels = [0, 1].map(index => new FakeRpcChannel({ sessionFile: `D:/scratch/key-hints-${index}.jsonl`, entries: [{ ...messageEntry(`u${index}`, null, userMessage(`draft ${index}`, 1000)) }] }));
		const sessions = channels.map((channel, index) => runtime.startLive(`chat${index}`, { channel, sessionFile: null, cwd: "D:/scratch", title: null }));
		await waitUntil(() => sessions.every(session => session.phase === "live"));
	};
	return { runtime, start };
}

test("a page that is attached or re-sent gets the current keys once, before the state, and none while they are unknown", async () => {
	let keys: Keys = [];
	const { runtime, start } = newRuntime(() => keys);
	await start();
	const page = recordingPage("p0");
	runtime.attachPage("chat0", page.page);
	assert.deepEqual(page.messages, [], "nothing is sent before the host has read the keys: the page keeps its defaults");
	keys = [ALT_T, FIND];
	runtime.resend("chat0", "p0");
	assert.deepEqual(page.messages, [[ALT_T, FIND]]);
	assert.ok(page.order.indexOf("omp:chat-keys") < page.order.lastIndexOf("omp:chat-state"), "the keys go before the state");
	runtime.dispose();
});

test("refreshKeyHints reaches every attached page of every tab, not a detached one", async () => {
	let keys: Keys = [ALT_T];
	const { runtime, start } = newRuntime(() => keys);
	await start();
	const a = recordingPage("a");
	const b = recordingPage("b");
	const c = recordingPage("c");
	runtime.attachPage("chat0", a.page);
	runtime.attachPage("chat0", b.page);
	const detach = runtime.attachPage("chat1", c.page);
	detach();
	keys = [{ ...ALT_T, key: "Ctrl+Alt+T", conflicts: [], more: 0 }];
	runtime.refreshKeyHints();
	assert.deepEqual(a.messages.at(-1), keys);
	assert.deepEqual(b.messages.at(-1), keys);
	assert.deepEqual(c.messages, [[ALT_T]], "a detached page hears only what it was sent while attached");
	runtime.dispose();
});

test("a runtime with no reader sends nothing, and what it sends survives the page's own parser", async () => {
	const plain = newRuntime(undefined);
	await plain.start();
	const quiet = recordingPage("quiet");
	plain.runtime.attachPage("chat0", quiet.page);
	plain.runtime.refreshKeyHints();
	assert.deepEqual(quiet.messages, []);
	plain.runtime.dispose();

	const { runtime, start } = newRuntime(() => [ALT_T, FIND]);
	await start();
	const seen: unknown[] = [];
	runtime.attachPage("chat0", {
		id: "wire",
		post(message) {
			if (message.type === "omp:chat-keys") seen.push(parseChatHostMessage(JSON.parse(JSON.stringify(message))));
			return "sent";
		},
	});
	assert.deepEqual(seen, [{ type: "omp:chat-keys", keys: [ALT_T, FIND] }]);
	runtime.dispose();
});
