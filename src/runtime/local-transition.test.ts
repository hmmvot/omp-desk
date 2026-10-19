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
import { silentLogger } from "../shared/logger.ts";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, before, describe, it } from "node:test";
import { build } from "esbuild";
import type { SessionHostRuntime, SessionTransitionFacts } from "../host/native-session.ts";
import type * as Module from "./local-transition.ts";
import type { RuntimeRecord } from "./runtime-record.ts";
import type { DetachRequest, ReplaceWriterRequest, StopRequest, TransitionPhase, TransitionToken } from "./session-runtime.ts";
import type * as IndexModule from "../host/session-index.ts";
import type { DetachLiveClaimResult } from "../host/session-index.ts";

let temp: string;
let mod: typeof Module;
let indexMod: typeof IndexModule;
before(async () => {
	temp = await mkdtemp(path.join(tmpdir(), "omp-transition-"));
	// One bundle with a shared chunk, so the index classes the transitions test with are the ones the module checks against.
	await build({
		entryPoints: {
			"local-transition": fileURLToPath(new URL("./local-transition.ts", import.meta.url)),
			"session-index": fileURLToPath(new URL("../host/session-index.ts", import.meta.url)),
		},
		outdir: temp, outExtension: { ".js": ".mjs" }, bundle: true, splitting: true, platform: "node", format: "esm", target: "node20",
	});
	mod = (await import(pathToFileURL(path.join(temp, "local-transition.mjs")).href)) as typeof Module;
	indexMod = (await import(pathToFileURL(path.join(temp, "session-index.mjs")).href)) as typeof IndexModule;
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

/** What the fixture's chat runtime was asked to render read-only. */
interface RenderedView { readonly file: string | null; readonly cwd: string; readonly title: string | null; readonly reason: string; readonly phase?: string }

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
	/** The row the index reports, the views rendered (and whether the gate was held at each), the expectations `detachLiveClaim` was given. */
	readonly entry: { ownership: { ownerGeneration: string } | null; sessionFile: string | null; cwd: string; title: string; runIntent: string; host: { startedAt: string; pid: number; rpc: Record<string, unknown> } | null };
	readonly views: RenderedView[];
	readonly viewedUnderGate: boolean[];
	readonly detachCalls: unknown[];
	readonly brokerWatches: WeakMap<SessionHostRuntime, () => void>;
	setClaim(next: { ok: boolean; claim: { holderId: string | null; ownerGeneration: string | null } | null }): void;
	/** What a fresh claim read returns once `detachLiveClaim` ran. */
	setClaimAfterDetach(next: { ok: boolean; claim: { holderId: string | null; ownerGeneration: string | null } | null }): void;
	setLive(next: boolean): void;
	setDetach(next: DetachLiveClaimResult | Error): void;
	failView(): void;
	/** The incarnation a requester names for the row. */
	incarnation(): string;
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
		identity: { slot: "host:one", brokerId: "b1", brokerGeneration: "g1", childPid: 4242, childCreationTime: "created-1" },
	} as unknown as SessionHostRuntime;
	const record = {
		tabId: TAB, slotId: "slot-1", runtime, control: null, controlFailure: null as string | null, endedNotice: null,
		transitioning: false, nativeWatch: (() => { order.push("watch"); }) as (() => void) | null, pipeline: null,
	} satisfies RuntimeRecord as RuntimeRecord;
	const entry = {
		ownership: { ownerGeneration: "owner-1" }, sessionFile: null as string | null, cwd: "C:/proj", title: "A title", runIntent: "running",
		host: { startedAt: "2026-10-20T10:00:00.000Z", pid: 4242, rpc: { slot: "host:one", brokerId: "b1", brokerGeneration: "g1", childPid: 4242, childCreationTime: "created-1" } },
	};
	let claimRead: { ok: boolean; claim: { holderId: string | null; ownerGeneration: string | null } | null } = { ok: true, claim: { holderId: "holder-1", ownerGeneration: "owner-1" } };
	let live = true;
	let detachResult: DetachLiveClaimResult | Error = { status: "released" };
	let viewFails = false;
	let claimAfterDetach: typeof claimRead | null = null;
	let gateHeld = false;
	const views: RenderedView[] = [];
	const viewedUnderGate: boolean[] = [];
	const detachCalls: unknown[] = [];
	const brokerWatches = new WeakMap<SessionHostRuntime, () => void>();
	brokerWatches.set(runtime, () => { order.push("broker-watch"); });
	let tail: Promise<unknown> = Promise.resolve();
	const index = {
		lifecycle: {
			run: <T>(tabId: string, work: (lease: object) => Promise<T>): Promise<T> => {
				const running = tail.then(async () => {
					gateHolders.push(tabId);
					gateHeld = true;
					try { return await work({}); } finally { gateHeld = false; }
				});
				tail = running.then(() => undefined, () => undefined);
				return running;
			},
		},
		claimHolder: { id: "holder-1" },
		get: () => entry,
		hasLiveHost: () => live,
		observeOwnership: async () => claimRead,
		detachLiveClaim: async (_tab: string, expected: unknown) => {
			order.push("detach-claim");
			detachCalls.push(expected);
			if (claimAfterDetach !== null) claimRead = claimAfterDetach;
			if (detachResult instanceof Error) throw detachResult;
			return detachResult;
		},
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
			showViewOnly: async (_conversation: string, input: { readonly phase?: string; readonly reason: string; readonly file: string | null; readonly cwd: string; readonly title: string | null }) => {
				order.push(`view:${input.phase}`);
				views.push(input);
				viewedUnderGate.push(gateHeld);
				if (viewFails) throw new Error("the transcript could not be read");
			},
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
		log: silentLogger,
		brokerWatches,
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
		entry, views, viewedUnderGate, detachCalls, brokerWatches,
		setClaim: (next: typeof claimRead) => { claimRead = next; },
		setClaimAfterDetach: (next: typeof claimRead) => { claimAfterDetach = next; },
		setLive: (next: boolean) => { live = next; },
		setDetach: (next: DetachLiveClaimResult | Error) => { detachResult = next; },
		failView: () => { viewFails = true; },
		incarnation: () => "owner-1_2026-10-20T10:00:00.000Z.4242",
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
			chat: { sessionOf: () => null, release: () => undefined, showViewOnly: async () => undefined }, stop: {} as never,
			control: {} as never, exit: {} as never, writer: { pid: async () => null }, attachBrokerClient: async () => null,
			launcher: () => { throw new Error("unused"); }, brokerWatches: new WeakMap(), log: silentLogger,
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

describe("detach", () => {
	const request = (f: TransitionFixture, overrides: Partial<DetachRequest> = {}): DetachRequest => ({ conversation: TAB, binding: "slot-1.3", ...overrides, incarnation: overrides.incarnation ?? f.incarnation() });
	/** What an untouched fixture records: the broker watch is still installed and nothing was asked of a collaborator. */
	const untouched = (f: TransitionFixture): void => {
		assert.deepEqual(f.order, [], "no collaborator was asked anything");
		assert.notEqual(f.record.runtime, null);
		assert.equal(f.record.transitioning, false);
		assert.deepEqual(f.views, []);
		assert.deepEqual(f.detachCalls, []);
	};

	it("drops the conversation, ends the record and its watches, closes control keeping its credentials, releases the claim, and only then renders", async () => {
		const f = fixture();
		const result = await f.transitions.detach(request(f));
		assert.deepEqual(result, { status: "detached" });
		assert.deepEqual(f.order, ["release-chat", "broker-watch", "watch", "terminal", "dispose-control", "detach-claim", "view:blocked"]);
		assert.deepEqual(f.viewedUnderGate, [false], "the read-only view is rendered after the gate is let go");
		assert.deepEqual(f.gateHolders, [TAB], "one hold of the gate");
		assert.equal(f.record.runtime, null);
		assert.equal(f.record.nativeWatch, null);
		assert.equal(f.brokerWatches.has(f.runtime), false, "the broker watch is disposed and forgotten");
		assert.deepEqual(f.detachCalls, [{ pid: 4242, slot: "host:one", brokerId: "b1", brokerGeneration: "g1", childPid: 4242, childCreationTime: "created-1" }]);
		assert.deepEqual(f.views, [{ file: null, cwd: "C:/proj", title: "A title", reason: "This session was moved to another window.", phase: "blocked" }]);
	});

	it("stops nothing and writes nothing: no stop, no intent, no close, no credential release, no broker retirement", async () => {
		const f = fixture();
		await f.transitions.detach(request(f));
		assert.deepEqual(f.stopCalls, []);
		for (const forbidden of ["intent:stopped", "intent:running", "close", "promote", "replaceHost", "release-control", "retire", "stopped:session", "stopped:local-copy"]) {
			assert.ok(!f.order.includes(forbidden), forbidden);
		}
	});

	it("holds the fence for the hold of the gate and lowers it on every outcome", async () => {
		const f = fixture();
		await f.transitions.detach(request(f));
		assert.deepEqual([f.record.transitioning, f.fenced, f.mutationFences], [false, [true, false], [mod.TRANSITION_FENCE_REASON, null]]);
		const unfinished = fixture();
		unfinished.setDetach({ status: "claim-unreleased", stillHeld: true });
		await unfinished.transitions.detach(request(unfinished));
		assert.deepEqual([unfinished.record.transitioning, unfinished.fenced], [false, [true, false]]);
		const refused = fixture();
		refused.setDetach(new Error("the claim file is unreadable"));
		await refused.transitions.detach(request(refused));
		assert.deepEqual([refused.record.transitioning, refused.fenced], [false, [true, false]]);
	});

	it("answers not-holder to a second detach in a row and touches nothing for it", async () => {
		const f = fixture();
		assert.deepEqual(await f.transitions.detach(request(f)), { status: "detached" });
		const order = [...f.order];
		assert.deepEqual(await f.transitions.detach(request(f)), { status: "refused", code: "not-holder" });
		assert.deepEqual(f.order, order);
		assert.equal(f.views.length, 1);
		assert.equal(f.detachCalls.length, 1);
	});

	it("serves two queued requests one after the other: the first moves it, the second finds it no longer held here", async () => {
		const f = fixture();
		const [first, second] = await Promise.all([f.transitions.detach(request(f)), f.transitions.detach(request(f))]);
		assert.deepEqual([first, second], [{ status: "detached" }, { status: "refused", code: "not-holder" }]);
		assert.equal(f.detachCalls.length, 1);
	});

	it("answers busy while a stop, close, restart or view switch holds the fence, and touches nothing", async () => {
		const f = fixture();
		const token = f.transitions.beginTransition({ conversation: TAB, target: f.attachment() });
		const order = [...f.order];
		assert.deepEqual(await f.transitions.detach(request(f)), { status: "refused", code: "busy" });
		assert.deepEqual([f.order, f.views, f.detachCalls, f.record.transitioning], [order, [], [], true], "the flow's own fence is not lowered by the refusal");
		f.transitions.endTransition(token, "none");
		assert.deepEqual(await f.transitions.detach(request(f)), { status: "detached" });
	});

	it("queues behind a stop in flight and then finds the session no longer held here, never painting 'moved' over a stopped session", async () => {
		const f = fixture();
		const target = f.attachment();
		const token = f.transitions.beginTransition({ conversation: TAB, target });
		const hold = f.blockStop();
		const stopping = f.transitions.stop(session(token, target));
		await hold.entered;
		const detaching = f.transitions.detach(request(f));
		hold.release();
		assert.equal((await stopping).status, "stopped");
		assert.deepEqual(await detaching, { status: "refused", code: "not-holder" });
		assert.deepEqual(f.views, []);
		assert.deepEqual(f.detachCalls, []);
	});

	it("answers not-holder for a run it does not hold: another incarnation, another editor binding, no runtime, no live host", async () => {
		const other = fixture();
		assert.deepEqual(await other.transitions.detach(request(other, { incarnation: `${other.incarnation()}9` })), { status: "refused", code: "not-holder" });
		untouched(other);
		const rebound = fixture();
		assert.deepEqual(await rebound.transitions.detach(request(rebound, { binding: "slot-1.2" })), { status: "refused", code: "not-holder" });
		assert.deepEqual(await rebound.transitions.detach(request(rebound, { binding: "slot-9.3" })), { status: "refused", code: "not-holder" });
		untouched(rebound);
		const moved = fixture({ binding: { tabId: "tab:other", generation: 3 } });
		assert.deepEqual(await moved.transitions.detach(request(moved)), { status: "refused", code: "not-holder" });
		untouched(moved);
		const none = fixture();
		none.record.runtime = null;
		assert.deepEqual(await none.transitions.detach(request(none)), { status: "refused", code: "not-holder" });
		const dead = fixture();
		dead.setLive(false);
		assert.deepEqual(await dead.transitions.detach(request(dead)), { status: "refused", code: "not-holder" });
		untouched(dead);
		const unbound = fixture({ binding: null });
		assert.deepEqual(await unbound.transitions.detach(request(unbound, { binding: null })), { status: "detached" }, "a request that names no binding is not fenced to one");
	});

	it("answers not-holder when the row records another outcome than a running host this window serves", async () => {
		for (const change of [
			(f: TransitionFixture) => { f.entry.runIntent = "stopped"; },
			(f: TransitionFixture) => { f.entry.host = null; },
			(f: TransitionFixture) => { f.entry.host!.pid = 1; },
			(f: TransitionFixture) => { f.entry.host!.rpc = { ...f.entry.host!.rpc, brokerGeneration: "g2" }; },
			(f: TransitionFixture) => { f.entry.host!.rpc = { ...f.entry.host!.rpc, childCreationTime: "created-2" }; },
			(f: TransitionFixture) => { f.entry.ownership = null; },
		]) {
			const f = fixture();
			const incarnation = f.incarnation();
			change(f);
			assert.deepEqual(await f.transitions.detach(request(f, { incarnation })), { status: "refused", code: "not-holder" }, change.toString());
			untouched(f);
		}
	});

	it("answers not-holder unless a fresh claim read names this window and this owner generation", async () => {
		for (const claim of [
			{ ok: false, claim: null },
			{ ok: true, claim: null },
			{ ok: true, claim: { holderId: "another-window", ownerGeneration: "owner-1" } },
			{ ok: true, claim: { holderId: "holder-1", ownerGeneration: "owner-2" } },
			{ ok: true, claim: { holderId: null, ownerGeneration: null } },
		]) {
			const f = fixture();
			f.setClaim(claim);
			assert.deepEqual(await f.transitions.detach(request(f)), { status: "refused", code: "not-holder" }, JSON.stringify(claim));
			untouched(f);
		}
	});

	it("answers terminal for a Terminal runtime and touches nothing", async () => {
		const f = fixture({ kind: "terminal" });
		assert.deepEqual(await f.transitions.detach(request(f)), { status: "refused", code: "terminal" });
		untouched(f);
	});

	it("says the session was moved elsewhere, and does not call it moved, when the claim is no longer this window's to release", async () => {
		const f = fixture();
		f.setDetach({ status: "target-changed" });
		assert.deepEqual(await f.transitions.detach(request(f)), { status: "refused", code: "not-holder" });
		assert.deepEqual(f.order, ["release-chat", "broker-watch", "watch", "terminal", "dispose-control", "detach-claim", "view:blocked"], "the connection was already dropped");
		assert.deepEqual(f.views.map(view => view.reason), ["This session is open in another window."]);
	});

	it("reports an unreleased claim with whether it is still held, and offers a reconnect only while the claim still names this window", async () => {
		const held = fixture();
		held.setDetach({ status: "claim-unreleased", stillHeld: true });
		assert.deepEqual(await held.transitions.detach(request(held)), { status: "failed", code: "claim-unreleased", stillHeld: true });
		assert.deepEqual(held.views.map(view => view.phase), ["blocked"]);
		assert.deepEqual(held.views.map(view => view.reason), ["The move could not finish. Open the session here to reconnect it."]);
		assert.deepEqual(held.viewedUnderGate, [false]);
		const gone = fixture();
		gone.setDetach({ status: "claim-unreleased", stillHeld: false });
		gone.setClaimAfterDetach({ ok: true, claim: { holderId: "another-window", ownerGeneration: "owner-1" } });
		assert.deepEqual(await gone.transitions.detach(request(gone)), { status: "failed", code: "claim-unreleased", stillHeld: false });
		assert.deepEqual(gone.views.map(view => view.reason), ["This session is open in another window."]);
	});

	it("maps a lease the index refuses to not-holder and any other failure to an unfinished handover, never throwing", async () => {
		const lease = fixture();
		lease.setDetach(new indexMod.SessionIndexError("invalid-input", "A lifecycle lease for another tab cannot run an operation."));
		assert.deepEqual(await lease.transitions.detach(request(lease)), { status: "refused", code: "not-holder" });
		const broken = fixture();
		broken.setDetach(new Error("disk full"));
		assert.deepEqual(await broken.transitions.detach(request(broken)), { status: "failed", code: "claim-unreleased", stillHeld: true });
	});

	it("keeps its answer when the read-only view cannot be rendered", async () => {
		const f = fixture();
		f.failView();
		assert.deepEqual(await f.transitions.detach(request(f)), { status: "detached" });
		assert.equal(f.record.runtime, null);
	});
});
