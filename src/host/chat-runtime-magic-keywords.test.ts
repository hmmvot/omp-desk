/** The magic-keywords query is a read-only settings read answered to the asking page alone. Runner: `node --test src/host/chat-runtime-magic-keywords.test.ts`. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseChatHostMessage, type ChatHostMessage, type ChatWebviewMessage } from "../protocol/chat-messages.ts";
import { recordingLogger, type LoggedLine } from "../shared/logger.ts";
import type { MagicKeywordId } from "../shared/magic-keywords.ts";
import { ChatRuntime, type ChatPage } from "./chat-runtime.ts";
import { FakeRpcChannel } from "./rpc/fake-channel.ts";
import { RpcSession } from "./rpc/session.ts";
import { ManualTimers, waitUntil } from "./rpc/test-support.ts";

const READ: ChatWebviewMessage = { type: "omp:chat-magic-keywords-read" };

function recordingPage(id: string, readOnlyReason?: string): { page: ChatPage; answers: MagicKeywordId[][]; all: ChatHostMessage[] } {
	const answers: MagicKeywordId[][] = [];
	const all: ChatHostMessage[] = [];
	const page: ChatPage = {
		id,
		post(message) {
			all.push(message);
			// What the page sees is what survives the wire.
			const parsed = parseChatHostMessage(JSON.parse(JSON.stringify(message)));
			if (parsed?.type === "omp:chat-magic-keywords") answers.push(parsed.keywords);
			return "sent";
		},
		...(readOnlyReason === undefined ? {} : { readOnlyReason: () => readOnlyReason }),
	};
	return { page, answers, all };
}

type MagicKeywordsRead = (tabId: string, cwd: string | undefined, profile: string | null) => Promise<readonly MagicKeywordId[] | null>;

function rig(readMagicKeywords: MagicKeywordsRead | undefined) {
	const profile: { current: string | null } = { current: null };
	const clock = { now: 10_000 };
	const logs: LoggedLine[] = [];
	const timers = new ManualTimers();
	const runtime = new ChatRuntime({
		hostNonce: "magic-keywords-test",
		onEvent() {},
		log: recordingLogger(logs),
		now: () => clock.now,
		createSession: options => new RpcSession({ ...options, timers, fileExists: async () => true, watchdogIntervalMs: 60 * 60_000 }),
		profileOf: () => profile.current,
		...(readMagicKeywords === undefined ? {} : { readMagicKeywords }),
	});
	const live = async (tabId: string, cwd: string): Promise<void> => {
		const session = runtime.startLive(tabId, { channel: new FakeRpcChannel({ sessionFile: `D:/scratch/${tabId}.jsonl` }), sessionFile: null, cwd, title: null });
		await waitUntil(() => session.phase === "live");
	};
	return { runtime, clock, logs, live, profile };
}

test("the asking page alone is answered, with the conversation's folder for a live tab and none for a tab without one", async () => {
	const asked: [string, string | undefined][] = [];
	const { runtime, live } = rig(async (tabId, cwd) => { asked.push([tabId, cwd]); return ["ultrathink", "jevify"]; });
	await live("chat0", "D:/project");
	const asker = recordingPage("asker");
	const bystander = recordingPage("bystander");
	runtime.attachPage("chat0", asker.page);
	runtime.attachPage("chat0", bystander.page);
	assert.equal(await runtime.handleMessage("chat0", READ, asker.page), "accepted");
	assert.deepEqual(asker.answers, [["ultrathink", "jevify"]]);
	assert.deepEqual(bystander.answers, [], "another page of the same tab is not told");
	assert.deepEqual(asked, [["chat0", "D:/project"]]);

	const orphan = recordingPage("orphan");
	assert.equal(await runtime.handleMessage("ghost", READ, orphan.page), "accepted", "a tab with no conversation is answered too");
	assert.deepEqual(orphan.answers, [["ultrathink", "jevify"]]);
	assert.deepEqual(asked.at(-1), ["ghost", undefined]);
	runtime.dispose();
});

test("an empty answer is an answer: none of the keywords is acted on", async () => {
	const { runtime } = rig(async () => []);
	const page = recordingPage("p");
	assert.equal(await runtime.handleMessage("ghost", READ, page.page), "accepted");
	assert.deepEqual(page.answers, [[]]);
	runtime.dispose();
});

test("a read-only route is answered, before the refusal that every other message gets", async () => {
	const { runtime, live } = rig(async () => ["orchestrate"]);
	await live("chat0", "D:/project");
	const readOnly = recordingPage("detail", "This page is read-only.");
	runtime.attachPage("chat0", readOnly.page);
	const before = readOnly.all.length;
	assert.equal(await runtime.handleMessage("chat0", READ, readOnly.page), "accepted");
	assert.deepEqual(readOnly.answers, [["orchestrate"]]);
	assert.deepEqual(readOnly.all.slice(before).map(message => message.type), ["omp:chat-magic-keywords"], "no notice rides along");
	runtime.dispose();
});

test("a read that is missing, returns null or throws sends nothing, and the next ask reads again", async () => {
	const none = rig(undefined);
	const page = recordingPage("p");
	assert.equal(await none.runtime.handleMessage("ghost", READ, page.page), "ignored");
	assert.deepEqual(page.all, []);
	none.runtime.dispose();

	let behaviour: "null" | "throw" | "ok" = "null";
	let reads = 0;
	const { runtime, logs } = rig(async () => {
		reads += 1;
		if (behaviour === "throw") throw new Error("omp config list exited with 1");
		return behaviour === "null" ? null : ["workflow"];
	});
	assert.equal(await runtime.handleMessage("ghost", READ, page.page), "ignored");
	behaviour = "throw";
	assert.equal(await runtime.handleMessage("ghost", READ, page.page), "ignored");
	assert.deepEqual(page.all, [], "the page keeps what it has");
	assert.ok(logs.some(line => line.level === "debug" && line.message.includes("omp config list exited with 1")));
	assert.ok(logs.every(line => line.level === "debug"));
	behaviour = "ok";
	assert.equal(await runtime.handleMessage("ghost", READ, page.page), "accepted");
	assert.deepEqual(page.answers, [["workflow"]]);
	assert.equal(reads, 3, "a failure is not remembered");
	runtime.dispose();
});

test("concurrent askers of one tab share one read and each is answered; another tab reads for itself", async () => {
	const gates: ((keywords: readonly MagicKeywordId[]) => void)[] = [];
	const asked: string[] = [];
	const { runtime } = rig(tabId => {
		asked.push(tabId);
		const gate = Promise.withResolvers<readonly MagicKeywordId[]>();
		gates.push(gate.resolve);
		return gate.promise;
	});
	const first = recordingPage("first");
	const second = recordingPage("second");
	const other = recordingPage("other");
	const pending = [
		runtime.handleMessage("chat0", READ, first.page),
		runtime.handleMessage("chat0", READ, second.page),
		runtime.handleMessage("chat1", READ, other.page),
	];
	await waitUntil(() => gates.length === 2);
	assert.deepEqual(asked, ["chat0", "chat1"], "two askers of chat0 spawned one read");
	assert.deepEqual([first.answers, second.answers], [[], []], "nobody is answered before the read ends");
	gates[0]!(["ultrathink"]);
	gates[1]!(["jevify"]);
	assert.deepEqual(await Promise.all(pending), ["accepted", "accepted", "accepted"]);
	assert.deepEqual(first.answers, [["ultrathink"]]);
	assert.deepEqual(second.answers, [["ultrathink"]], "the second page got its own answer");
	assert.deepEqual(other.answers, [["jevify"]]);
	runtime.dispose();
});

test("an answer is reused for 5 s and then asked again", async () => {
	let reads = 0;
	const { runtime, clock } = rig(async () => { reads += 1; return reads === 1 ? ["ultrathink"] : []; });
	const page = recordingPage("p");
	await runtime.handleMessage("ghost", READ, page.page);
	clock.now += 4_999;
	await runtime.handleMessage("ghost", READ, page.page);
	assert.equal(reads, 1, "inside the window the CLI is not spawned again");
	assert.deepEqual(page.answers, [["ultrathink"], ["ultrathink"]], "the asking page is answered from the earlier read");
	await runtime.handleMessage("chat9", READ, page.page);
	assert.equal(reads, 2, "the reuse belongs to its own tab");
	clock.now += 1;
	await runtime.handleMessage("ghost", READ, page.page);
	assert.equal(reads, 3, "at 5 s the settings are read again");
	assert.deepEqual(page.answers.at(-1), []);
	runtime.dispose();
});

test("an answer is reused for one profile only: a tab rebound to another profile reads again, a read in flight is not joined", async () => {
	const asked: (string | null)[] = [];
	const gates: ((keywords: readonly MagicKeywordId[]) => void)[] = [];
	const { runtime, clock, profile } = rig((_tabId, _cwd, askedProfile) => {
		asked.push(askedProfile);
		const gate = Promise.withResolvers<readonly MagicKeywordId[]>();
		gates.push(gate.resolve);
		return gate.promise;
	});
	const page = recordingPage("p");

	profile.current = "work";
	const first = runtime.handleMessage("chat0", READ, page.page);
	await waitUntil(() => gates.length === 1);
	gates[0]!(["ultrathink"]);
	await first;
	clock.now += 1_000;
	profile.current = "home";
	const second = runtime.handleMessage("chat0", READ, page.page);
	await waitUntil(() => gates.length === 2);
	assert.deepEqual(asked, ["work", "home"], "a different profile inside the window reads again, with the profile that was asked under");
	gates[1]!(["jevify"]);
	await second;
	assert.deepEqual(page.answers, [["ultrathink"], ["jevify"]], "the second answer is the new profile's, not the earlier one's");
	clock.now += 1_000;
	await runtime.handleMessage("chat0", READ, page.page);
	assert.equal(gates.length, 2, "the new profile's answer is the one reused");
	assert.deepEqual(page.answers.at(-1), ["jevify"]);

	// A read in flight under one profile is not joined by an ask under another, and the two do not overwrite each other's answer.
	clock.now += 10_000;
	profile.current = "work";
	const underWork = runtime.handleMessage("chat0", READ, page.page);
	await waitUntil(() => gates.length === 3);
	profile.current = "home";
	const underHome = runtime.handleMessage("chat0", READ, page.page);
	await waitUntil(() => gates.length === 4);
	assert.deepEqual(asked.slice(2), ["work", "home"], "the ask under another profile started its own read");
	gates[3]!(["jevify"]);
	await underHome;
	gates[2]!(["ultrathink"]);
	await underWork;
	assert.deepEqual(page.answers.slice(-2), [["jevify"], ["ultrathink"]], "each ask got the answer of its own profile");
	await runtime.handleMessage("chat0", READ, page.page);
	assert.equal(gates.length, 4);
	assert.deepEqual(page.answers.at(-1), ["jevify"], "the read that was replaced did not become the reusable answer");
	runtime.dispose();
});

test("replacing the conversation of a tab forgets its answer and does not let the new one join the old read", async () => {
	const gates: ((keywords: readonly MagicKeywordId[]) => void)[] = [];
	const { runtime, live } = rig(() => {
		const gate = Promise.withResolvers<readonly MagicKeywordId[]>();
		gates.push(gate.resolve);
		return gate.promise;
	});
	const page = recordingPage("p");
	await live("chat0", "D:/project");

	const first = runtime.handleMessage("chat0", READ, page.page);
	await waitUntil(() => gates.length === 1);
	gates[0]!(["ultrathink"]);
	await first;
	await runtime.handleMessage("chat0", READ, page.page);
	assert.equal(gates.length, 1, "before the replacement the answer is reused");

	await live("chat0", "D:/project");
	const second = runtime.handleMessage("chat0", READ, page.page);
	await waitUntil(() => gates.length === 2);
	assert.deepEqual(page.answers, [["ultrathink"], ["ultrathink"]], "the replaced conversation's answer is not served to the new one");

	// A read in flight when the conversation is replaced is not joined by the new conversation, and does not seed its answer.
	await live("chat0", "D:/project");
	const third = runtime.handleMessage("chat0", READ, page.page);
	await waitUntil(() => gates.length === 3);
	gates[2]!(["jevify"]);
	await third;
	gates[1]!(["ultrathink"]);
	await second;
	assert.deepEqual(page.answers.slice(-2), [["jevify"], ["ultrathink"]]);
	await runtime.handleMessage("chat0", READ, page.page);
	assert.equal(gates.length, 3, "the newest conversation's answer is the one reused");
	assert.deepEqual(page.answers.at(-1), ["jevify"]);
	runtime.dispose();
});
