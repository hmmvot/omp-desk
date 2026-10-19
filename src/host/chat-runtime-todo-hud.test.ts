/** The TODO row's clock reaches every page of a tab, with the tab's own folder asked for OMP's delay. Runner: `node --test src/host/chat-runtime-todo-hud.test.ts`. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatHostMessage } from "../protocol/chat-messages.ts";
import type { TodoPhase } from "../chat/todos.ts";
import { ChatRuntime, type ChatPage } from "./chat-runtime.ts";
import { FakeRpcChannel } from "./rpc/fake-channel.ts";
import { RpcSession } from "./rpc/session.ts";
import { ManualTimers, tick, waitUntil } from "./rpc/test-support.ts";

const closed: TodoPhase[] = [{ name: "Work", tasks: [{ content: "One", status: "completed" }, { content: "Two", status: "abandoned" }] }];

function recordingPage(id: string): { page: ChatPage; messages: ChatHostMessage[] } {
	const messages: ChatHostMessage[] = [];
	return { page: { id, post: message => { messages.push(message); return "sent"; } }, messages };
}

test("the delay is read for the tab and its folder, and the hide reaches the attached pages and later snapshots", async () => {
	const timers = new ManualTimers();
	const asked: [string, string][] = [];
	const runtime = new ChatRuntime({
		hostNonce: "todo-hud-test",
		onEvent() {},
		createSession: options => new RpcSession({ ...options, timers, fileExists: async () => true, watchdogIntervalMs: 60 * 60_000 }),
		readTodoClearDelay: async (tabId, cwd) => { asked.push([tabId, cwd]); return 45; },
	});
	const channel = new FakeRpcChannel({ sessionFile: "D:/scratch/todo.jsonl", todoPhases: closed });
	const session = runtime.startLive("chat0", { channel, sessionFile: null, cwd: "D:/project", title: null });
	await waitUntil(() => session.phase === "live");
	await tick();
	const early = recordingPage("early");
	runtime.attachPage("chat0", early.page);
	assert.deepEqual(asked, [["chat0", "D:/project"]]);
	timers.advance(44_999);
	assert.equal(early.messages.some(message => message.type === "omp:chat-event" && message.frame.type === "todo_hud_hide"), false);
	timers.advance(1);
	assert.equal(early.messages.some(message => message.type === "omp:chat-event" && message.frame.type === "todo_hud_hide"), true, "the page is told");
	const late = recordingPage("late");
	runtime.attachPage("chat0", late.page);
	const snapshot = late.messages.findLast(message => message.type === "omp:chat-snapshot");
	assert.ok(snapshot !== undefined && snapshot.type === "omp:chat-snapshot");
	assert.equal(snapshot.head.todoHidden, true, "a page that attaches afterwards starts with the row cleared");
	runtime.dispose();
});

test("a runtime without a reader still clears the row after OMP's default", async () => {
	const timers = new ManualTimers();
	const runtime = new ChatRuntime({
		hostNonce: "todo-hud-default",
		onEvent() {},
		createSession: options => new RpcSession({ ...options, timers, fileExists: async () => true, watchdogIntervalMs: 60 * 60_000 }),
	});
	const channel = new FakeRpcChannel({ sessionFile: "D:/scratch/todo.jsonl", todoPhases: closed });
	const session = runtime.startLive("chat0", { channel, sessionFile: null, cwd: "D:/project", title: null });
	await waitUntil(() => session.phase === "live");
	await tick();
	timers.advance(60_000);
	assert.equal(session.model.todo?.hidden, true);
	runtime.dispose();
});
