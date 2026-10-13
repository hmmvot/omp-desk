/**
 * The gated transitions of the in-process runtime (ADR-0066, cut 7): the admission fence one flow holds, the read
 * of the facts a stop is confirmed against, the stop of a writer this window drives and the refusals of a
 * replacement before anything is stopped.
 *
 * The success path of a replacement, which launches through the real hosts, is covered by the lifecycle tests of
 * `src/extension-lifecycle.test.ts`. The module's host imports resolve extensionless specifiers the way esbuild
 * does, so it is compiled with the project's bundler.
 *
 * Runner: `node --test src/runtime/local-transition.test.ts`.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, before, describe, it } from "node:test";
import { build } from "esbuild";
import type { SessionHostRuntime, SessionTransitionFacts } from "../host/native-session.ts";
import type * as Module from "./local-transition.ts";
import type { RuntimeRecord } from "./runtime-record.ts";
import type { ReplaceWriterRequest, StopRequest, TransitionPhase, TransitionToken } from "./session-runtime.ts";

let mod: typeof Module;
let temp: string;
before(async () => {
	temp = await mkdtemp(path.join(tmpdir(), "omp-transition-"));
	const outfile = path.join(temp, "local-transition.mjs");
	await build({ entryPoints: [fileURLToPath(new URL("./local-transition.ts", import.meta.url))], outfile, bundle: true, platform: "node", format: "esm", target: "node20" });
	mod = (await import(pathToFileURL(outfile).href)) as typeof Module;
});
after(async () => { await rm(temp, { recursive: true, force: true }); });

const TAB = "tab:11111111-2222-4333-8444-555555555555";

function facts(overrides: Partial<SessionTransitionFacts> = {}): SessionTransitionFacts {
	return { epoch: "e1", sessionId: "s1", file: path.join(temp, "missing.jsonl"), settled: true, hasContent: true, nativeTarget: null, ...overrides } as SessionTransitionFacts;
}

interface FixtureOptions {
	readonly kind?: "chat" | "terminal";
	readonly stopping?: boolean;
	readonly writerGone?: boolean;
	readonly facts?: SessionTransitionFacts | null;
	readonly broker?: boolean;
	readonly binding?: { readonly tabId: string; readonly generation: number } | null;
}

/** One conversation with one runtime, every collaborator recording what it was asked and in which order. */
interface TransitionFixture {
	readonly transitions: Module.LocalTransitions;
	readonly record: RuntimeRecord;
	readonly runtime: SessionHostRuntime;
	/** What the collaborators were asked to record, in order. */
	readonly order: string[];
	/** The conversations whose gate was taken, in order. */
	readonly gateHolders: string[];
	readonly fenced: boolean[];
	readonly mutationFences: (string | null)[];
	readonly stopCalls: string[];
	checks(): TransitionPhase[];
	setFacts(next: SessionTransitionFacts | null): void;
	setPid(next: number | null): void;
	setCheck(answer: boolean): void;
	/** Make the next `requestStop` wait for `release`, holding the gate. */
	blockStop(): { readonly entered: Promise<void>; release(): void };
	attachment(): number;
}

function fixture(options: FixtureOptions = {}): TransitionFixture {
	const order: string[] = [];
	const gateHolders: string[] = [];
	const fenced: boolean[] = [];
	const mutationFences: (string | null)[] = [];
	const checks: TransitionPhase[] = [];
	const verdictGone = options.writerGone ?? true;
	let currentFacts: SessionTransitionFacts | null = options.facts === undefined ? facts() : options.facts;
	let pid: number | null = 4242;
	let checkAnswer = true;
	const runtime = {
		kind: options.kind ?? "chat", pid: 4242, cwd: "C:/proj", stopping: options.stopping ?? false,
		identity: { slot: "host:one", brokerId: "b1", brokerGeneration: "g1", childCreationTime: "created-1" },
	} as unknown as SessionHostRuntime;
	const record = {
		tabId: TAB, slotId: "slot-1", runtime, control: null, controlFailure: null as string | null, endedNotice: null,
		transitioning: false, nativeWatch: (() => { order.push("watch"); }) as (() => void) | null, pipeline: null,
	} satisfies RuntimeRecord as RuntimeRecord;
	let tail: Promise<unknown> = Promise.resolve();
	const index = {
		lifecycle: {
			run: <T>(tabId: string, work: (lease: object) => Promise<T>): Promise<T> => {
				const running = tail.then(async () => { gateHolders.push(tabId); return await work({}); });
				tail = running.then(() => undefined, () => undefined);
				return running;
			},
		},
		get: () => ({ ownership: { ownerGeneration: "owner-1" }, sessionFile: null }),
		slotBinding: () => options.binding === undefined ? { tabId: TAB, generation: 3 } : options.binding,
		setRunIntent: async (_tab: string, intent: string) => { order.push(`intent:${intent}`); },
		closeSession: async () => { order.push("close"); },
		promoteDraft: async () => { order.push("promote"); },
		replaceHost: async () => { order.push("replaceHost"); return { status: "failed", tabId: TAB, kind: "launch-failed", detail: "fixture" }; },
	};
	const stopCalls: string[] = [];
	let blocked: { readonly entered: PromiseWithResolvers<void>; readonly released: Promise<void> } | null = null;
	const transitions = new mod.LocalTransitions({
		index: index as never,
		records: { get: (tabId: string | null) => tabId === TAB ? record : undefined } as never,
		window: {
			fenced: (_conversation, on) => { fenced.push(on); },
			check: (_token, phase) => { checks.push(phase); return checkAnswer; },
			prepare: async () => { order.push("prepare"); },
			endTerminal: () => { order.push("terminal"); },
			stopped: (_conversation, scope) => { order.push(`stopped:${scope}`); },
		},
		chat: {
			sessionOf: () => ({ setMutationFence: (reason: string | null) => { mutationFences.push(reason); } }) as never,
			release: () => { order.push("release-chat"); },
		},
		stop: {
			requestStop: async (_record, _runtime, mode) => {
				stopCalls.push(`request:${mode}`);
				if (blocked !== null) { blocked.entered.resolve(); await blocked.released; } return { writerGone: verdictGone, treeEmpty: verdictGone, detail: "fixture stop" }; },
			confirmEnded: async () => { stopCalls.push("confirm"); return null; },
			awaitSettled: async () => null,
			readTransitionFacts: async () => currentFacts,
		},
		control: { release: async () => { order.push("release-control"); }, dispose: () => { order.push("dispose-control"); } },
		exit: { retireBroker: async () => { order.push("retire"); } },
		writer: { pid: async () => pid },
		attachBrokerClient: async () => options.broker === false ? null : ({}) as never,
		launcher: () => { throw new Error("The fixture launches nothing."); },
		log: () => undefined,
	});
	return {
		transitions, record, runtime, order, gateHolders, fenced, mutationFences, stopCalls,
		checks: () => checks,
		setFacts: (next: SessionTransitionFacts | null) => { currentFacts = next; },
		setPid: (next: number | null) => { pid = next; },
		setCheck: (answer: boolean) => { checkAnswer = answer; },
		blockStop: () => {
			const entered = Promise.withResolvers<void>();
			const released = Promise.withResolvers<void>();
			blocked = { entered, released: released.promise };
			return { entered: entered.promise, release: () => { blocked = null; released.resolve(); } };
		},
		attachment: () => transitions.snapshot(TAB)?.attachment as number,
	};
}

const session = (token: TransitionToken, target: number, extra: Partial<StopRequest> = {}): StopRequest =>
	({ conversation: TAB, token, target, mode: "graceful", consent: true, scope: "session", ...extra }) as StopRequest;

describe("the snapshot", () => {
	it("names the incarnation of the runtime as a value, stable for one runtime and new for the next", () => {
		const f = fixture();
		const first = f.transitions.snapshot(TAB);
		assert.deepEqual([first?.kind, first?.pid, first?.slot, first?.brokerId, first?.brokerGeneration, first?.control], ["chat", 4242, "host:one", "b1", "g1", "unavailable"]);
		assert.equal(f.transitions.snapshot(TAB)?.attachment, first?.attachment);
		f.record.runtime = { ...f.runtime } as SessionHostRuntime;
		assert.notEqual(f.transitions.snapshot(TAB)?.attachment, first?.attachment);
		f.record.runtime = null;
		assert.equal(f.transitions.snapshot(TAB), null);
		assert.equal(f.transitions.snapshot("tab:other"), null);
	});
});

describe("the admission fence", () => {
	it("raises the flag, the chat session's mutation fence and the window's projection, and lowers all three when the flow ends", () => {
		const f = fixture();
		const token = f.transitions.beginTransition({ conversation: TAB, target: f.attachment() });
		assert.deepEqual([f.record.transitioning, f.fenced, f.mutationFences], [true, [true], [mod.TRANSITION_FENCE_REASON]]);
		f.transitions.endTransition(token, "none");
		assert.deepEqual([f.record.transitioning, f.fenced, f.mutationFences], [false, [true, false], [mod.TRANSITION_FENCE_REASON, null]]);
	});

	it("is raised for a conversation without a runtime and lowered again", () => {
		const f = fixture();
		f.record.runtime = null;
		const token = f.transitions.beginTransition({ conversation: TAB, target: null });
		assert.equal(f.record.transitioning, true);
		f.transitions.endTransition(token, "native-stopping");
		assert.equal(f.record.transitioning, false);
	});

	it("stays up after a native shutdown that was accepted and has not ended its process, and only for the incarnation it was raised for", () => {
		const f = fixture({ kind: "terminal", stopping: true });
		const target = f.attachment();
		const kept = f.transitions.beginTransition({ conversation: TAB, target });
		f.transitions.endTransition(kept, "native-stopping");
		assert.deepEqual([f.record.transitioning, f.fenced], [true, [true, true]]);
		const other = f.transitions.beginTransition({ conversation: TAB, target: target + 100 });
		f.transitions.endTransition(other, "native-stopping");
		assert.equal(f.record.transitioning, false, "a fence raised for another incarnation is never kept");
		const chat = fixture({ stopping: true });
		const lowered = chat.transitions.beginTransition({ conversation: TAB, target: chat.attachment() });
		chat.transitions.endTransition(lowered, "native-stopping");
		assert.equal(chat.record.transitioning, false, "only a Terminal's native shutdown is a reason to keep it");
	});

	it("leaves no half-raised fence behind when the window's projection throws", () => {
		const f = fixture();
		let first = true;
		const failing = new mod.LocalTransitions({
			index: {} as never,
			records: { get: () => f.record } as never,
			window: {
				fenced: () => { if (first) { first = false; throw new Error("projection failed"); } },
				check: () => true, prepare: async () => undefined, endTerminal: () => undefined, stopped: () => undefined,
			},
			chat: { sessionOf: () => null, release: () => undefined }, stop: {} as never,
			control: {} as never, exit: {} as never, writer: { pid: async () => null }, attachBrokerClient: async () => null,
			launcher: () => { throw new Error("unused"); }, log: () => undefined,
		});
		assert.throws(() => failing.beginTransition({ conversation: TAB, target: null }), /projection failed/);
		assert.equal(f.record.transitioning, false);
	});
});

describe("reading the facts", () => {
	it("is null for another incarnation and when the flow's own gate-time check refuses, and reads under the gate otherwise", async () => {
		const f = fixture();
		const target = f.attachment();
		const token = f.transitions.beginTransition({ conversation: TAB, target });
		assert.equal(await f.transitions.readTransitionFacts({ conversation: TAB, target: target + 1 }), null);
		assert.equal((await f.transitions.readTransitionFacts({ conversation: TAB, target, token }))?.epoch, "e1");
		assert.deepEqual(f.checks(), ["gate"]);
		f.setCheck(false);
		assert.equal(await f.transitions.readTransitionFacts({ conversation: TAB, target, token }), null);
		assert.deepEqual(f.gateHolders, [TAB, TAB, TAB]);
	});
});

describe("stop", () => {
	it("records what a confirmed stop proves in one order: runtime cleared, watch and frontend ended, credentials released, broker retired, intent, claim, chat dropped, memory dropped", async () => {
		const f = fixture();
		const target = f.attachment();
		const token = f.transitions.beginTransition({ conversation: TAB, target });
		const result = await f.transitions.stop(session(token, target));
		assert.deepEqual(result, { status: "stopped", detail: "fixture stop" });
		assert.equal(f.record.runtime, null);
		assert.deepEqual(f.order, ["watch", "terminal", "dispose-control", "release-control", "retire", "intent:stopped", "close", "release-chat", "stopped:session"]);
		assert.deepEqual(f.gateHolders, [TAB], "one hold of the gate");
	});

	it("ends only this window's copy for a passive editor: no intent, no claim release, no chat drop", async () => {
		const f = fixture();
		const target = f.attachment();
		const token = f.transitions.beginTransition({ conversation: TAB, target });
		assert.equal((await f.transitions.stop({ conversation: TAB, token, target, mode: "graceful", consent: true, scope: "local-copy" })).status, "stopped");
		assert.deepEqual(f.order, ["watch", "terminal", "dispose-control", "release-control", "retire", "stopped:local-copy"]);
	});

	it("keeps the runtime and records nothing when the writer is not proven gone", async () => {
		const f = fixture({ writerGone: false });
		const target = f.attachment();
		const token = f.transitions.beginTransition({ conversation: TAB, target });
		assert.deepEqual(await f.transitions.stop(session(token, target)), { status: "unconfirmed", detail: "fixture stop" });
		assert.notEqual(f.record.runtime, null);
		assert.deepEqual(f.order, []);
	});

	it("refuses another incarnation and a flow whose own check refuses, before anything is asked of the process", async () => {
		const f = fixture();
		const target = f.attachment();
		const token = f.transitions.beginTransition({ conversation: TAB, target });
		assert.deepEqual(await f.transitions.stop(session(token, target + 1)), { status: "refused", code: "target-changed" });
		f.setCheck(false);
		assert.deepEqual(await f.transitions.stop(session(token, target)), { status: "refused", code: "target-changed" });
		assert.deepEqual([f.stopCalls, f.order], [[], []]);
	});

	it("refuses an idle-only stop when the session is busy or is no longer the one that was captured", async () => {
		const f = fixture();
		const target = f.attachment();
		const token = f.transitions.beginTransition({ conversation: TAB, target });
		f.setFacts(facts({ settled: false }));
		assert.deepEqual(await f.transitions.stop(session(token, target, { idleOnly: true, expected: facts() })), { status: "refused", code: "not-idle" });
		f.setFacts(facts({ epoch: "e2" }));
		assert.deepEqual(await f.transitions.stop(session(token, target, { idleOnly: true, expected: facts() })), { status: "refused", code: "not-idle" });
		assert.deepEqual(f.stopCalls, []);
	});

	it("refuses a force stop whose facts changed while its dialog was open, and a force stop of unreadable facts proceeds", async () => {
		const f = fixture();
		const target = f.attachment();
		const token = f.transitions.beginTransition({ conversation: TAB, target });
		f.setFacts(facts({ sessionId: "other" }));
		assert.deepEqual(await f.transitions.stop(session(token, target, { mode: "force", expected: facts() })), { status: "refused", code: "facts-changed" });
		f.setFacts(null);
		assert.equal((await f.transitions.stop(session(token, target, { mode: "force", expected: facts() }))).status, "stopped");
	});

	it("binds a stop to the writer the caller verified, under the gate", async () => {
		const f = fixture();
		const target = f.attachment();
		const token = f.transitions.beginTransition({ conversation: TAB, target });
		f.setPid(null);
		assert.deepEqual(await f.transitions.stop(session(token, target, { expectedWriter: { pid: 4242 } })), { status: "writer-gone" });
		f.setPid(7);
		assert.deepEqual(await f.transitions.stop(session(token, target, { expectedWriter: { pid: 4242 } })), { status: "writer-changed" });
		assert.deepEqual(f.stopCalls, []);
	});

	it("records the stopped intent before the stop is dispatched when asked to", async () => {
		const f = fixture();
		const target = f.attachment();
		const token = f.transitions.beginTransition({ conversation: TAB, target });
		await f.transitions.stop(session(token, target, { recordIntentFirst: true }));
		assert.equal(f.order[0], "intent:stopped");
		assert.equal(f.order.filter(entry => entry === "intent:stopped").length, 2);
	});

	it("only confirms a native shutdown that was already pending when the flow began, and sends no second one", async () => {
		const f = fixture({ kind: "terminal", stopping: true });
		const target = f.attachment();
		const token = f.transitions.beginTransition({ conversation: TAB, target });
		const result = await f.transitions.stop(session(token, target));
		assert.deepEqual([result.status, f.stopCalls], ["unconfirmed", ["confirm"]]);
		assert.equal((await f.transitions.stop(session(token, target, { mode: "force" }))).status, "stopped");
		assert.deepEqual(f.stopCalls, ["confirm", "request:force"]);
	});
});

describe("replaceWriter refusals", () => {
	const request = (f: TransitionFixture, token: TransitionToken, overrides: Partial<ReplaceWriterRequest> = {}): ReplaceWriterRequest => ({
		conversation: TAB, token, target: f.attachment(), mode: "chat", binding: { slot: "slot-1", generation: 3 },
		stop: { kind: "graceful", consent: false, captured: facts() }, ...overrides,
	});

	it("refuses another incarnation and a changed editor binding before anything is checked or stopped", async () => {
		const f = fixture();
		const token = f.transitions.beginTransition({ conversation: TAB, target: f.attachment() });
		for (const refused of [
			request(f, token, { target: f.attachment() + 1 }),
			request(f, token, { binding: { slot: "slot-1", generation: 2 } }),
		]) assert.deepEqual(await f.transitions.replaceWriter(refused), { status: "refused", code: "target-changed", stopDispatched: false, writerGone: false });
		const moved = fixture({ binding: { tabId: "tab:other", generation: 3 } });
		const movedToken = moved.transitions.beginTransition({ conversation: TAB, target: moved.attachment() });
		assert.equal((await moved.transitions.replaceWriter(request(moved, movedToken))).status, "refused");
		assert.deepEqual([f.checks(), f.stopCalls], [[], []]);
	});

	it("refuses when the flow's own gate-time check refuses", async () => {
		const f = fixture();
		const token = f.transitions.beginTransition({ conversation: TAB, target: f.attachment() });
		f.setCheck(false);
		const result = await f.transitions.replaceWriter(request(f, token));
		assert.deepEqual([result.status, result.status === "refused" ? result.code : null], ["refused", "target-changed"]);
		assert.deepEqual(f.checks(), ["gate"]);
	});

	it("refuses facts that changed or a busy session nobody consented to abort, and a conversation that is not durable yet", async () => {
		const f = fixture();
		const token = f.transitions.beginTransition({ conversation: TAB, target: f.attachment() });
		f.setFacts(facts({ epoch: "e2" }));
		const changed = await f.transitions.replaceWriter(request(f, token));
		assert.deepEqual(changed.status === "refused" ? changed.code : null, "facts-changed");
		f.setFacts(facts({ settled: false }));
		const busy = await f.transitions.replaceWriter(request(f, token));
		assert.deepEqual(busy.status === "refused" ? busy.code : null, "facts-changed");
		f.setFacts(facts());
		const notDurable = await f.transitions.replaceWriter(request(f, token));
		assert.deepEqual(notDurable.status === "refused" ? notDurable.code : null, "not-durable");
		assert.deepEqual([f.stopCalls, f.order], [[], []]);
	});

	it("refuses a replacement without a broker that can prove the root, and a Terminal without verified host control", async () => {
		const noBroker = fixture({ broker: false, facts: facts({ file: null }) });
		const token = noBroker.transitions.beginTransition({ conversation: TAB, target: noBroker.attachment() });
		const refused = await noBroker.transitions.replaceWriter(request(noBroker, token, { stop: { kind: "graceful", consent: false, captured: facts({ file: null }) } }));
		assert.deepEqual(refused.status === "refused" ? refused.code : null, "no-broker");
		const terminal = fixture({ kind: "terminal", facts: facts({ file: null }) });
		const terminalToken = terminal.transitions.beginTransition({ conversation: TAB, target: terminal.attachment() });
		const noControl = await terminal.transitions.replaceWriter(request(terminal, terminalToken, { stop: { kind: "graceful", consent: false, captured: facts({ file: null }) } }));
		assert.deepEqual([noControl.status === "refused" ? noControl.code : null, noControl.stopDispatched], ["no-control", false]);
	});

	it("keeps the fence only for the stop it dispatched: nothing dispatched lowers it", async () => {
		const f = fixture();
		const token = f.transitions.beginTransition({ conversation: TAB, target: f.attachment() });
		await f.transitions.replaceWriter(request(f, token));
		f.transitions.endTransition(token, "dispatched-stop");
		assert.equal(f.record.transitioning, false);
	});

	it("never serves a caller that gave up waiting for the gate, and says it failed", async t => {
		const f = fixture();
		const target = f.attachment();
		const token = f.transitions.beginTransition({ conversation: TAB, target });
		const hold = f.blockStop();
		const holding = f.transitions.stop(session(token, target, { mode: "force" }));
		await hold.entered;
		t.mock.timers.enable({ apis: ["setTimeout"] });
		try {
			const waiting = f.transitions.replaceWriter(request(f, token, { bounded: true }));
			await new Promise<void>(resolve => setImmediate(resolve));
			t.mock.timers.tick(10_000);
			const result = await waiting;
			assert.equal(result.status, "failed");
			assert.deepEqual([result.stopDispatched, result.writerGone], [false, false]);
		} finally { t.mock.timers.reset(); }
		hold.release();
		await holding;
		await f.transitions.readTransitionFacts({ conversation: TAB, target: f.attachment() });
		assert.deepEqual(f.order.filter(entry => entry === "replaceHost" || entry === "prepare"), [], "the expired replacement is not served late");
	});
});
