/**
 * The live-session half of `ConversationPort` (ADR-0066) over a fake chat runtime: what an incarnation names,
 * the values a snapshot carries, and that every operation keyed by an incarnation refuses, without reaching any
 * session, once the conversation holds another one.
 *
 * Runner: `node --test src/runtime/local-conversations.test.ts`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChatRuntime } from "../host/chat-runtime.ts";
import { SETTINGS_APPLY_NOT_LIVE } from "../host/omp-settings-apply.ts";
import { LocalConversations } from "./local-conversations.ts";
import type { ConversationPort } from "./session-runtime.ts";

const TAB = "tab:one";
const OTHER = "tab:two";

interface FakeSession {
	readonly calls: string[];
	model: Record<string, unknown>;
	epoch: { nonce: string; counter: number };
	sessionFile: string | null;
	sessionId: string | null;
	restartOffered: boolean;
	nativeStateUnanswered: boolean;
	listeners: Set<(output: unknown) => void>;
	[method: string]: unknown;
}

function fakeSession(name: string): FakeSession {
	const calls: string[] = [];
	const record = (method: string) => (...args: unknown[]): Promise<unknown> => { calls.push(`${method}:${JSON.stringify(args)}`); return Promise.resolve({ status: "ok", from: name, method }); };
	const session: FakeSession = {
		calls,
		model: {
			phase: "live", working: false, asyncPaused: true, maintenance: { action: "compact", status: "working" }, pendingControl: { thinking: "high" },
			commands: [{ name: "share" }], header: { id: `header-${name}` },
			state: { model: { provider: "p", id: `model-${name}` }, thinkingLevel: "low", isStreaming: false },
		},
		epoch: { nonce: "nonce", counter: 3 },
		get phase() { return session.model.phase; },
		sessionFile: `${name}.jsonl`,
		sessionId: `provider-${name}`,
		restartOffered: true,
		nativeStateUnanswered: false,
		listeners: new Set(),
		start: () => { calls.push("start"); return Promise.resolve(); },
		subscribe(listener: (output: unknown) => void) { session.listeners.add(listener); return () => { session.listeners.delete(listener); }; },
		setMutationFence: (reason: string | null) => { calls.push(`fence:${reason}`); },
	};
	for (const method of [
		"getAvailableModels", "getAvailableThinkingLevels", "readSessionCost", "readToolDescriptors", "readContext", "requestContextReport", "chooseModel",
		"chooseThinkingLevel", "cycleModel", "cycleThinkingLevel", "maintain", "exportHtml", "prompt", "setSessionName",
	]) session[method] = record(method);
	return session;
}

function fixture() {
	const sessions = new Map<string, FakeSession>();
	const chat = { sessionOf: (conversation: string) => sessions.get(conversation) ?? null } as unknown as ChatRuntime;
	return { port: new LocalConversations(chat) as ConversationPort & LocalConversations, sessions };
}

describe("incarnations", () => {
	it("is null while the conversation holds no live session", () => {
		const { port } = fixture();
		assert.equal(port.incarnationOf(TAB), null);
		assert.equal(port.liveOf(TAB), null);
	});

	it("names one session by one number, and a replacement by a larger one that is never reused", () => {
		const { port, sessions } = fixture();
		const first = fakeSession("a");
		sessions.set(TAB, first);
		const a = port.incarnationOf(TAB);
		assert.equal(typeof a, "number");
		assert.equal(port.incarnationOf(TAB), a, "asking again names the same session by the same number");

		const second = fakeSession("b");
		sessions.set(TAB, second);
		const b = port.incarnationOf(TAB)!;
		assert.ok(b > a!, "a replacement is a later incarnation");

		sessions.set(TAB, first);
		assert.equal(port.incarnationOf(TAB), a, "a session keeps its own number");
		sessions.delete(TAB);
		sessions.set(TAB, fakeSession("c"));
		const c = port.incarnationOf(TAB)!;
		assert.ok(c > b, "a number is never handed to a later session");
	});

	it("numbers the sessions of different conversations apart", () => {
		const { port, sessions } = fixture();
		sessions.set(TAB, fakeSession("a"));
		sessions.set(OTHER, fakeSession("b"));
		assert.notEqual(port.incarnationOf(TAB), port.incarnationOf(OTHER));
	});
});

describe("liveOf", () => {
	it("carries the session's facts as values", () => {
		const { port, sessions } = fixture();
		sessions.set(TAB, fakeSession("a"));
		const live = port.liveOf(TAB)!;
		assert.equal(live.incarnation, port.incarnationOf(TAB));
		assert.equal(live.phase, "live");
		assert.deepEqual(live.epoch, { nonce: "nonce", counter: 3 });
		assert.deepEqual(live.state?.model, { provider: "p", id: "model-a" });
		assert.equal(live.state?.thinkingLevel, "low");
		assert.equal(live.working, false);
		assert.equal(live.asyncPaused, true);
		assert.deepEqual(live.maintenance, { action: "compact", status: "working" });
		assert.deepEqual(live.pendingControl, { thinking: "high" });
		assert.deepEqual(live.commands, [{ name: "share" }]);
		assert.equal(live.sessionFile, "a.jsonl");
		assert.equal(live.sessionId, "provider-a");
		assert.equal(live.headerId, "header-a");
		assert.equal(live.restartOffered, true);
		assert.equal(live.nativeStateUnanswered, false);
	});

	it("reads no header before the session has one", () => {
		const { port, sessions } = fixture();
		const session = fakeSession("a");
		session.model.header = null;
		sessions.set(TAB, session);
		assert.equal(port.liveOf(TAB)!.headerId, null);
	});

	it("is a snapshot: it does not follow the session, and a new read does", () => {
		const { port, sessions } = fixture();
		const session = fakeSession("a");
		sessions.set(TAB, session);
		const before = port.liveOf(TAB)!;
		session.model = { ...session.model, phase: "resyncing", working: true };
		session.epoch = { nonce: "nonce", counter: 4 };
		session.restartOffered = false;
		assert.equal(before.phase, "live");
		assert.equal(before.working, false);
		assert.equal(before.epoch.counter, 3);
		assert.equal(before.restartOffered, true);
		const after = port.liveOf(TAB)!;
		assert.equal(after.phase, "resyncing");
		assert.equal(after.working, true);
		assert.equal(after.epoch.counter, 4);
		assert.equal(after.restartOffered, false);
		assert.equal(after.incarnation, before.incarnation, "the same session is the same incarnation");
	});
});

describe("subagentKnownOf", () => {
	it("asks the conversation's own live session and knows nothing without one", () => {
		const { port, sessions } = fixture();
		assert.equal(port.subagentKnownOf(TAB, "Worker"), null);
		sessions.set(TAB, Object.assign(fakeSession("a"), { subagentKnown: (id: string) => id === "Worker" ? "roster" : id === "Nested" ? "reference" : null }));
		sessions.set(OTHER, Object.assign(fakeSession("b"), { subagentKnown: () => null }));
		assert.equal(port.subagentKnownOf(TAB, "Worker"), "roster");
		assert.equal(port.subagentKnownOf(TAB, "Nested"), "reference");
		assert.equal(port.subagentKnownOf(TAB, "Other"), null);
		assert.equal(port.subagentKnownOf(OTHER, "Worker"), null, "another conversation's agents are not this one's");
	});
});

type Operation = readonly [name: string, call: (port: ConversationPort, incarnation: number) => Promise<unknown>, method: string];

const OPERATIONS: readonly Operation[] = [
	["readAvailableModels", (port, i) => port.readAvailableModels(TAB, i), "getAvailableModels"],
	["readAvailableThinkingLevels", (port, i) => port.readAvailableThinkingLevels(TAB, i), "getAvailableThinkingLevels"],
	["requestContextReport", (port, i) => port.requestContextReport(TAB, i), "requestContextReport"],
	["chooseModel", (port, i) => port.chooseModel(TAB, i, "p", "m", "M"), "chooseModel"],
	["chooseThinkingLevel", (port, i) => port.chooseThinkingLevel(TAB, i, "high"), "chooseThinkingLevel"],
	["cycleModel", (port, i) => port.cycleModel(TAB, i), "cycleModel"],
	["cycleThinkingLevel", (port, i) => port.cycleThinkingLevel(TAB, i), "cycleThinkingLevel"],
	["maintain", (port, i) => port.maintain(TAB, i, { kind: "shake", mode: "elide" }), "maintain"],
	["exportHtml", (port, i) => port.exportHtml(TAB, i, "out.html"), "exportHtml"],
	["prompt", (port, i) => port.prompt(TAB, i, { requestId: "r", text: "/share" }), "prompt"],
	["setSessionName", (port, i) => port.setSessionName(TAB, i, "Name"), "setSessionName"],
];

const READS: readonly Operation[] = [
	["readSessionCost", (port, i) => port.readSessionCost(TAB, i), "readSessionCost"],
	["readToolDescriptors", (port, i) => port.readToolDescriptors(TAB, i), "readToolDescriptors"],
	["readContext", (port, i) => port.readContext(TAB, i), "readContext"],
];

describe("operations keyed by an incarnation", () => {
	for (const [name, call, method] of OPERATIONS) {
		it(`${name} reaches the named session and answers its result`, async () => {
			const { port, sessions } = fixture();
			const session = fakeSession("a");
			sessions.set(TAB, session);
			const result = await call(port, port.incarnationOf(TAB)!);
			assert.deepEqual(result, { status: "ok", from: "a", method });
			assert.equal(session.calls.length, 1);
		});

		it(`${name} answers stale and sends nothing once the conversation holds another session`, async () => {
			const { port, sessions } = fixture();
			const old = fakeSession("old");
			sessions.set(TAB, old);
			const incarnation = port.incarnationOf(TAB)!;
			const successor = fakeSession("new");
			sessions.set(TAB, successor);
			assert.deepEqual(await call(port, incarnation), { status: "stale" });
			assert.deepEqual([old.calls, successor.calls], [[], []], "neither the old nor the new session was reached");
		});

		it(`${name} answers stale when the conversation holds no session`, async () => {
			const { port, sessions } = fixture();
			sessions.set(TAB, fakeSession("a"));
			const incarnation = port.incarnationOf(TAB)!;
			sessions.delete(TAB);
			assert.deepEqual(await call(port, incarnation), { status: "stale" });
		});
	}

	for (const [name, call, method] of READS) {
		it(`${name} reads the named session`, async () => {
			const { port, sessions } = fixture();
			const session = fakeSession("a");
			sessions.set(TAB, session);
			assert.deepEqual(await call(port, port.incarnationOf(TAB)!), { status: "ok", from: "a", method });
		});

		it(`${name} reads nothing from another session`, async () => {
			const { port, sessions } = fixture();
			const old = fakeSession("old");
			sessions.set(TAB, old);
			const incarnation = port.incarnationOf(TAB)!;
			const successor = fakeSession("new");
			sessions.set(TAB, successor);
			assert.equal(await call(port, incarnation), null);
			assert.deepEqual([old.calls, successor.calls], [[], []]);
		});
	}

	it("an incarnation of another conversation is stale here", async () => {
		const { port, sessions } = fixture();
		sessions.set(TAB, fakeSession("a"));
		const other = fakeSession("b");
		sessions.set(OTHER, other);
		assert.deepEqual(await port.cycleModel(TAB, port.incarnationOf(OTHER)!), { status: "stale" });
		assert.deepEqual(other.calls, []);
	});

	it("join waits for the named session's start and is stale for another", async () => {
		const { port, sessions } = fixture();
		const old = fakeSession("old");
		sessions.set(TAB, old);
		const incarnation = port.incarnationOf(TAB)!;
		assert.deepEqual(await port.join(TAB, incarnation), { status: "joined" });
		assert.deepEqual(old.calls, ["start"]);
		sessions.set(TAB, fakeSession("new"));
		assert.deepEqual(await port.join(TAB, incarnation), { status: "stale" });
		assert.deepEqual(old.calls, ["start"], "the old session was not started again");
	});

	it("observe subscribes to the named session and gives back its unsubscribe, or nothing when it is gone", () => {
		const { port, sessions } = fixture();
		const old = fakeSession("old");
		sessions.set(TAB, old);
		const incarnation = port.incarnationOf(TAB)!;
		const seen: unknown[] = [];
		const unsubscribe = port.observe(TAB, incarnation, output => { seen.push(output); });
		assert.ok(unsubscribe);
		for (const listener of old.listeners) listener({ type: "state" });
		assert.deepEqual(seen, [{ type: "state" }]);
		unsubscribe();
		assert.equal(old.listeners.size, 0);

		const successor = fakeSession("new");
		sessions.set(TAB, successor);
		assert.equal(port.observe(TAB, incarnation, () => undefined), null);
		assert.equal(successor.listeners.size, 0);
	});
});

describe("setFence", () => {
	it("raises and lowers the fence of the session the conversation holds now", () => {
		const { port, sessions } = fixture();
		const first = fakeSession("a");
		sessions.set(TAB, first);
		port.setFence(TAB, "Session lifecycle transition.");
		port.setFence(TAB, null);
		assert.deepEqual(first.calls, ["fence:Session lifecycle transition.", "fence:null"]);
		const second = fakeSession("b");
		sessions.set(TAB, second);
		port.setFence(TAB, "again");
		assert.deepEqual(second.calls, ["fence:again"]);
	});

	it("does nothing for a conversation without a live session", () => {
		const { port } = fixture();
		assert.doesNotThrow(() => port.setFence(TAB, "reason"));
	});
});

describe("applyModelDefault", () => {
	it("is stale for a session the conversation no longer holds, and asks nothing of the window", async () => {
		const { port, sessions } = fixture();
		sessions.set(TAB, fakeSession("old"));
		const incarnation = port.incarnationOf(TAB)!;
		sessions.set(TAB, fakeSession("new"));
		let asked = 0;
		assert.deepEqual(await port.applyModelDefault(TAB, incarnation, { provider: "p", id: "m" }, () => { asked += 1; return true; }), { status: "stale" });
		assert.equal(asked, 0);
	});

	it("is refused as not live when the window's own check says the launching Chat changed, and sends nothing", async () => {
		const { port, sessions } = fixture();
		const session = fakeSession("a");
		sessions.set(TAB, session);
		const applied = await port.applyModelDefault(TAB, port.incarnationOf(TAB)!, { provider: "p", id: "m" }, () => false);
		assert.equal(applied, SETTINGS_APPLY_NOT_LIVE);
		assert.deepEqual(session.calls, []);
	});

	it("is refused as not idle while the session works, and sends nothing", async () => {
		const { port, sessions } = fixture();
		const session = fakeSession("a");
		session.model.working = true;
		sessions.set(TAB, session);
		const applied = await port.applyModelDefault(TAB, port.incarnationOf(TAB)!, { provider: "p", id: "m" }, () => true);
		assert.equal(applied, SETTINGS_APPLY_NOT_LIVE, "a working session is not idle");
		assert.deepEqual(session.calls, []);
	});
});
