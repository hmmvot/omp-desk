import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatOperationMessage } from "../protocol/chat-messages.ts";
import type { ChatHostMessage } from "../protocol/chat-messages.ts";
import { ChatRuntime, type ChatPage } from "./chat-runtime.ts";
import { PendingOperations } from "./pending-operations.ts";
import { FakeRpcChannel } from "./rpc/fake-channel.ts";
import { RpcSession } from "./rpc/session.ts";
import { ManualTimers, messageEntry, userMessage, waitUntil } from "./rpc/test-support.ts";

const REQUEST_ID = "0123456789abcdef0123456789abcdef";

function recordingPage(id: string): { page: ChatPage; operations: ChatOperationMessage[] } {
	const operations: ChatOperationMessage[] = [];
	const page: ChatPage = {
		id,
		post(message: ChatHostMessage) {
			if (message.type === "omp:chat-operation") operations.push(message);
			return "sent";
		},
	};
	return { page, operations };
}

async function liveRuntime(pending: PendingOperations): Promise<{ runtime: ChatRuntime; resumeRequests: string[] }> {
	const timers = new ManualTimers();
	const resumeRequests: string[] = [];
	const runtime = new ChatRuntime({
		hostNonce: "operation-test",
		pending,
		onEvent(_tabId, event) { if (event.type === "resume-requested") resumeRequests.push(event.requestId); },
		createSession: options => new RpcSession({ ...options, timers, fileExists: async () => true }),
	});
	const channel = new FakeRpcChannel({ sessionFile: "D:/scratch/operation.jsonl", entries: [{ ...messageEntry("u0", null, userMessage("draft", 1000)) }] });
	const session = runtime.startLive("chat0", { channel, sessionFile: null, cwd: "D:/scratch", title: null });
	await waitUntil(() => session.phase === "live");
	return { runtime, resumeRequests };
}

test("a tab's pending operation reaches its attached pages as it changes and ends, and a page that attaches later is told what is pending", async () => {
	let now = 5_000;
	const pending = new PendingOperations({ now: () => now });
	const { runtime } = await liveRuntime(pending);
	const early = recordingPage("early");
	runtime.attachPage("chat0", early.page);
	assert.deepEqual(early.operations, [], "nothing pending: nothing is posted on attach");
	const handle = pending.begin("chat0", "resume", { origin: "composer", requestId: REQUEST_ID, step: "ownership" });
	now += 1_500;
	handle.step("admission");
	assert.deepEqual(early.operations.at(-1), { type: "omp:chat-operation", operation: { kind: "resume", step: "admission", elapsedMs: 1_500, requestId: REQUEST_ID, still: false } });
	const late = recordingPage("late");
	runtime.attachPage("chat0", late.page);
	assert.deepEqual(late.operations, [{ type: "omp:chat-operation", operation: { kind: "resume", step: "admission", elapsedMs: 1_500, requestId: REQUEST_ID, still: false } }], "a page that attaches is told what is pending");
	handle.end("running");
	assert.deepEqual(early.operations.at(-1), { type: "omp:chat-operation", operation: null, ended: { kind: "resume", requestId: REQUEST_ID, status: "running" } });
	assert.deepEqual(late.operations.at(-1), early.operations.at(-1));
	runtime.dispose();
});

test("an operation of another tab, and one a row or the status bar shows, never reaches a page", async () => {
	const pending = new PendingOperations();
	const { runtime } = await liveRuntime(pending);
	const page = recordingPage("p");
	runtime.attachPage("chat0", page.page);
	pending.begin("chat1", "resume").end("running");
	pending.begin("chat0", "rename").end("running");
	pending.begin("chat0", "delete").end("failed");
	assert.deepEqual(page.operations, []);
	runtime.dispose();
});

test("a request the host refuses on the spot is answered with an end, so the page stops waiting", async () => {
	const pending = new PendingOperations();
	const { runtime, resumeRequests } = await liveRuntime(pending);
	const asking = recordingPage("asking");
	const other = recordingPage("other");
	runtime.attachPage("chat0", asking.page);
	runtime.attachPage("chat0", other.page);
	const outcome = await runtime.handleMessage("chat0", { type: "omp:chat-resume", requestId: REQUEST_ID }, asking.page);
	assert.equal(outcome, "refused", "a live conversation has nothing to resume");
	assert.deepEqual(resumeRequests, []);
	assert.deepEqual(asking.operations, [{ type: "omp:chat-operation", operation: null, ended: { kind: "resume", requestId: REQUEST_ID, status: "refused" } }]);
	assert.deepEqual(other.operations, [], "only the page that asked is told");
	runtime.dispose();
});

test("an accepted resume carries the page's request id to the host", async () => {
	const pending = new PendingOperations();
	const { runtime, resumeRequests } = await liveRuntime(pending);
	runtime.release("chat0");
	assert.equal(await runtime.handleMessage("chat0", { type: "omp:chat-resume", requestId: REQUEST_ID }, null), "accepted");
	assert.deepEqual(resumeRequests, [REQUEST_ID]);
	runtime.dispose();
});

test("disposing the runtime stops it listening to the registry", async () => {
	const pending = new PendingOperations();
	const { runtime } = await liveRuntime(pending);
	const page = recordingPage("p");
	runtime.attachPage("chat0", page.page);
	runtime.dispose();
	pending.begin("chat0", "resume").end("running");
	assert.deepEqual(page.operations, []);
});
