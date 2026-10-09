/**
 * `RpcSession.navigate` (ADR-0051) on a real `RpcSession` over the fake child. The fake answers the
 * `/omp-desk-navigate` prompt the way OMP 18.8.5 does for an extension command (a bare acknowledgement, then a
 * `prompt_result` with the same id), and the test moves the child's leaf and appends the `omp-desk/navigation` marker
 * the way the registered command does. Runner: `node --test src/host/rpc/session-navigate.test.ts`.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { afterEach, describe, it } from "node:test";
import type { ChatEntry } from "../../chat/messages.ts";
import type { ChatModel } from "../../chat/model.ts";
import { NAVIGATE_COMMAND, NAVIGATE_ERROR_PATH, NAVIGATION_MARKER_TYPE, parseNavigateArgs, undoOffer, type NavigateArgs } from "../../chat/rewind.ts";
import { FakeRpcChannel, type FakeChildModel } from "./fake-channel.ts";
import { RpcSession, type NavigateOutcome, type NavigateRequest, type RpcSessionOptions, type RpcSessionOutput } from "./session.ts";
import { ManualTimers, ScratchDir, assistantMessage, isoOf, messageEntry, sessionFileText, tick, userMessage, waitUntil } from "./test-support.ts";

const scratches: ScratchDir[] = [];
const sessions: RpcSession[] = [];
afterEach(async () => {
	for (const session of sessions.splice(0)) session.dispose();
	for (const scratch of scratches.splice(0)) await scratch.remove();
});

const PREFIX = `/${NAVIGATE_COMMAND} `;
const CATALOG = [{ name: NAVIGATE_COMMAND, source: "extension", description: "Desk navigation" }];

/** Records every timer delay, so a test can tell when the session scheduled its 150 ms second look at the disk. */
class SpyTimers extends ManualTimers {
	readonly delays: number[] = [];
	override setTimeout(handler: () => void, ms: number): unknown {
		this.delays.push(ms);
		return super.setTimeout(handler, ms);
	}
}

interface Rig {
	channel: FakeRpcChannel;
	session: RpcSession;
	timers: SpyTimers;
	outputs: RpcSessionOutput[];
}

interface BootOptions {
	file?: string | null;
	child?: Partial<FakeChildModel>;
	/** The `get_available_commands` answer; `null` answers without a list. */
	catalog?: readonly Record<string, unknown>[] | null;
	session?: Partial<RpcSessionOptions>;
}

async function boot(options: BootOptions = {}): Promise<Rig> {
	const channel = new FakeRpcChannel({ sessionFile: options.file ?? null, entries: [u1, a1, u2, a2] as never, leafId: "a2", ...options.child });
	const catalog = options.catalog === undefined ? CATALOG : options.catalog;
	channel.handlers.set("get_available_commands", () => (catalog === null ? {} : { data: { commands: catalog } }));
	const timers = new SpyTimers();
	const session = new RpcSession({
		channel,
		sessionFile: options.file ?? null,
		cwd: "D:\\scratch",
		hostNonce: "host-a",
		timers,
		fileExists: async () => true,
		watchdogIntervalMs: 60 * 60_000,
		...options.session,
	});
	sessions.push(session);
	const outputs: RpcSessionOutput[] = [];
	session.subscribe(output => outputs.push(output));
	await session.start();
	await waitUntil(() => session.model.commands.length > 0 || catalog === null || catalog.length === 0);
	await tick();
	return { channel, session, timers, outputs };
}

async function scratchFile(entries: readonly unknown[]): Promise<string> {
	const scratch = await ScratchDir.create();
	scratches.push(scratch);
	return scratch.file("s.jsonl", sessionFileText({ id: "sess-1", entries }));
}

const u1 = messageEntry("u1", null, userMessage("hi", 1000));
const a1 = messageEntry("a1", "u1", assistantMessage("hello", 2000));
const u2 = messageEntry("u2", "a1", userMessage("again", 3000));
const a2 = messageEntry("a2", "u2", assistantMessage("sure", 4000));

const RID = "0123456789abcdef0123456789abcdef";
let ridSeq = 0;
/** A fresh 32-hex request id. */
function rid(): string {
	ridSeq += 1;
	return ridSeq.toString(16).padStart(32, "0");
}

function rewind(targetId: string, expectedLeafId: string | null, requestId = rid()): NavigateRequest {
	return { requestId, kind: "rewind", targetId, expectedLeafId, summarize: false };
}

function ids(model: ChatModel): string[] {
	return model.entries.map(entry => entry.id);
}

function durable(model: ChatModel): ChatEntry[] {
	return model.entries.slice(0, model.durableCount);
}

function fullReads(channel: FakeRpcChannel): number {
	return channel.commandsOfType("get_entries").filter(command => command.since === undefined).length;
}

let markerSeq = 0;
interface MoveOptions {
	raced?: boolean;
	summarized?: boolean;
	after?: (markerId: string) => Record<string, unknown>[];
}

/**
 * What the OMP-side command does on success: move the leaf (a rewind lands on the target's parent, Undo and switch on
 * the target), then append the marker as the new leaf. `after` entries are appended below the marker.
 */
function ompMove(channel: FakeRpcChannel, args: NavigateArgs, options: MoveOptions = {}): string {
	const from = channel.child.leafId;
	const target = channel.child.entries.find(entry => entry.id === args.targetId);
	assert.ok(target !== undefined, `the target ${args.targetId} exists in the child`);
	const to = args.kind === "rewind" ? ((target.parentId as string | null) ?? null) : args.targetId;
	markerSeq += 1;
	const id = `nav-${markerSeq}`;
	channel.child.entries.push({
		type: "custom",
		customType: NAVIGATION_MARKER_TYPE,
		id,
		parentId: to,
		timestamp: isoOf(50_000 + markerSeq),
		data: { v: 1, requestId: args.requestId, kind: args.kind, from, target: args.targetId, to, summarized: options.summarized === true, ...(options.raced === true ? { raced: true } : {}) },
	});
	channel.child.leafId = id;
	for (const entry of options.after?.(id) ?? []) {
		channel.child.entries.push(entry);
		channel.child.leafId = entry.id as string;
	}
	return id;
}

interface NavigateCall {
	args: NavigateArgs;
	id: string;
}

/**
 * Answer the navigate prompt with `script` (an acknowledgement or `drop`); every other prompt gets the fake's
 * default. Returns the calls seen, each with the parsed request and the internal command id. A frame the script
 * schedules with `setImmediate` goes out after the acknowledgement (the fake writes it right after `script` returns).
 */
function onNavigate(channel: FakeRpcChannel, script: (call: NavigateCall) => Record<string, unknown> | "drop"): NavigateCall[] {
	const calls: NavigateCall[] = [];
	channel.handlers.set("prompt", command => {
		const message = String(command.message);
		if (!message.startsWith(PREFIX)) return undefined;
		assert.equal(command.streamingBehavior, undefined, "the navigation prompt carries no streamingBehavior");
		const args = parseNavigateArgs(message.slice(PREFIX.length));
		assert.ok(args !== null, "the host encodes a well-formed request");
		const call = { args, id: String(command.id) };
		calls.push(call);
		return script(call);
	});
	return calls;
}

function promptResult(channel: FakeRpcChannel, id: string, agentInvoked = false): void {
	channel.emit({ type: "prompt_result", id, agentInvoked, status: "completed", sessionSettled: true });
}

/** OMP 18.8.5 running an extension command that moved the leaf: bare ack, the move, then `prompt_result`. */
function completes(channel: FakeRpcChannel, options: MoveOptions = {}): NavigateCall[] {
	return onNavigate(channel, call => {
		ompMove(channel, call.args, options);
		setImmediate(() => promptResult(channel, call.id));
		return {};
	});
}

describe("navigate refusals (nothing written)", () => {
	it("refuses a malformed request id and a session that is not live", async () => {
		const { channel, session } = await boot();
		assert.deepEqual(await session.navigate(rewind("u2", "a2", "NOT-HEX")), { status: "refused", reason: "bad-request-id" });
		assert.equal(channel.commandsOfType("prompt").length, 0);
		const idle = new FakeRpcChannel();
		const notStarted = new RpcSession({ channel: idle, sessionFile: null, cwd: "D:\\scratch", hostNonce: "host-a", timers: new ManualTimers() });
		sessions.push(notStarted);
		assert.deepEqual(await notStarted.navigate(rewind("u2", "a2")), { status: "refused", reason: "not-live" });
		assert.equal(idle.commandsOfType("prompt").length, 0);
	});

	// Each setup, and the model fact `#navigationRefusal` reads for it (so the refusal has the named cause).
	const busy: [string, (channel: FakeRpcChannel) => void, (model: ChatModel) => boolean][] = [
		["a turn is working", channel => channel.emit({ type: "agent_start" }), model => model.working],
		["the session has not settled", channel => { channel.emit({ type: "agent_start" }); channel.emit({ type: "agent_end", messages: [] }); }, model => !model.working && !model.settled && !model.asyncPaused],
		["async work paused the turn", channel => { channel.emit({ type: "agent_start" }); channel.emit({ type: "agent_end", messages: [], isTerminal: false }); }, model => !model.working && model.asyncPaused],
		["a message is queued", channel => channel.emit({ type: "queue_update", steering: ["later"], followUp: [] }), model => model.settled && model.state?.queuedMessageCount === 1],
		["a dialog is open", channel => channel.emit({ type: "extension_ui_request", id: "ui-1", method: "confirm", title: "Sure?", message: "?" }), model => model.settled && model.uiRequest !== null],
		["a user row is not reconciled yet", channel => channel.emitMessage("message_end", "m-1", userMessage("typed", 9_000) as never), model => model.settled && [...model.pending.values()].some(row => !row.unsaved)],
	];
	for (const [name, setup, holds] of busy) {
		it(`answers busy while ${name}`, async () => {
			const rig = await boot();
			setup(rig.channel);
			await tick();
			assert.ok(holds(rig.session.model), "the setup produced the state under test");
			assert.deepEqual(await rig.session.navigate(rewind("u2", "a2")), { status: "refused", reason: "busy" });
			assert.equal(rig.channel.commandsOfType("prompt").length, 0);
		});
	}

	it("answers busy while a prompt's fate is unknown (unconfirmed ledger entry), until its result arrives", async () => {
		const rig = await boot({ session: { commandTimeoutMs: 1_000 } });
		rig.channel.handlers.set("prompt", () => "drop");
		const sent = rig.session.prompt({ requestId: "p1", text: "lost?" });
		await tick();
		rig.timers.advance(1_000);
		assert.deepEqual(await sent, { status: "unconfirmed" });
		assert.deepEqual(await rig.session.navigate(rewind("u2", "a2")), { status: "refused", reason: "busy" });
		assert.equal(rig.channel.commandsOfType("prompt").length, 1, "only the user's prompt");
		// Its late result settles the entry; nothing else stood in the way.
		promptResult(rig.channel, "vsc:p1");
		await tick();
		completes(rig.channel);
		assert.equal((await rig.session.navigate(rewind("u2", "a2"))).status, "done");
	});

	it("answers compacting while OMP compacts", async () => {
		const { channel, session } = await boot();
		channel.emit({ type: "auto_compaction_start", action: "context-full", reason: "threshold" });
		await tick();
		assert.deepEqual(await session.navigate(rewind("u2", "a2")), { status: "refused", reason: "compacting" });
		assert.equal(channel.commandsOfType("prompt").length, 0);
	});

	it("answers unsupported unless the catalog lists the command from an extension", async () => {
		for (const catalog of [[], [{ name: NAVIGATE_COMMAND, source: "prompt" }], [{ name: NAVIGATE_COMMAND, source: "skill" }]]) {
			const { channel, session } = await boot({ catalog });
			assert.deepEqual(await session.navigate(rewind("u2", "a2")), { status: "refused", reason: "unsupported" }, JSON.stringify(catalog));
			assert.equal(channel.commandsOfType("prompt").length, 0);
		}
	});

	it("checks the expected leaf and each kind's target on host-known state", async () => {
		const m1 = { type: "custom", customType: NAVIGATION_MARKER_TYPE, id: "m1", parentId: "a1", timestamp: isoOf(5_000), data: { v: 1, requestId: RID, kind: "rewind", from: "a2", target: "u2", to: "a1", summarized: false } };
		const u2b = messageEntry("u2b", "m1", userMessage("other", 6_000));
		const a2b = messageEntry("a2b", "u2b", assistantMessage("other reply", 7_000));
		const { channel, session } = await boot({ child: { entries: [u1, a1, u2, a2, m1, u2b, a2b] as never, leafId: "a2b" } });
		assert.deepEqual(session.model.branches.map(point => [point.entryId, point.branches.map(branch => branch.tipId)]), [["a1", ["a2"]]]);
		assert.deepEqual(await session.navigate(rewind("u2b", "a2")), { status: "refused", reason: "stale" }, "expectedLeafId is not the leaf");
		assert.deepEqual(await session.navigate(rewind("a2b", "a2b")), { status: "refused", reason: "target" }, "a rewind target must be a user prompt");
		assert.deepEqual(await session.navigate(rewind("u2", "a2b")), { status: "refused", reason: "target" }, "a rewind target must be on the active branch");
		assert.deepEqual(await session.navigate({ requestId: rid(), kind: "undo", targetId: "a2", expectedLeafId: "a2b", summarize: false }), { status: "refused", reason: "stale" }, "no Undo is offered once a prompt followed the marker");
		assert.deepEqual(await session.navigate({ requestId: rid(), kind: "switch", targetId: "u2", expectedLeafId: "a2b", summarize: false }), { status: "refused", reason: "target" }, "a switch target must be a branch tip");
		assert.equal(channel.commandsOfType("prompt").length, 0);
	});

	it("refuses an Undo whose target is not the offered `from`", async () => {
		const m1 = { type: "custom", customType: NAVIGATION_MARKER_TYPE, id: "m1", parentId: "a1", timestamp: isoOf(5_000), data: { v: 1, requestId: RID, kind: "rewind", from: "a2", target: "u2", to: "a1", summarized: false } };
		const { channel, session } = await boot({ child: { entries: [u1, a1, u2, a2, m1] as never, leafId: "m1" } });
		assert.equal(undoOffer(durable(session.model), session.model.leafId)?.from, "a2");
		assert.deepEqual(await session.navigate({ requestId: rid(), kind: "undo", targetId: "u2", expectedLeafId: "m1", summarize: false }), { status: "refused", reason: "stale" });
		assert.equal(channel.commandsOfType("prompt").length, 0);
	});
});

describe("navigate outcomes", () => {
	it("rewinds: the marker proves it, the draft is the prompt, and the model re-syncs to the new branch", async () => {
		const { channel, session } = await boot();
		const calls = completes(channel);
		const reads = fullReads(channel);
		const outcome = await session.navigate(rewind("u2", "a2"));
		assert.deepEqual(outcome, { status: "done", kind: "rewind", summarized: false, raced: false, draft: { text: "again", images: [], unavailableImages: 0 } });
		assert.equal(calls.length, 1);
		assert.deepEqual({ ...calls[0]!.args, requestId: "-" }, { v: 1, requestId: "-", kind: "rewind", sessionId: "sess-1", expectedLeafId: "a2", targetId: "u2", summarize: false });
		assert.equal(session.model.leafId, "nav-" + markerSeq);
		assert.deepEqual(ids(session.model), ["u1", "a1", `nav-${markerSeq}`], "the abandoned prompt and reply left the active entries");
		assert.equal(fullReads(channel), reads + 1, "a delta that does not extend the known leaf rebuilds with one full read");
		assert.deepEqual(session.model.branches.map(point => [point.entryId, point.branches.map(branch => branch.tipId)]), [["a1", ["a2"]]], "the abandoned branch is listed");
		assert.equal(undoOffer(durable(session.model), session.model.leafId)?.from, "a2");
	});

	it("counts a marker on the path but no longer at the leaf, and carries raced and summarized", async () => {
		const { channel, session } = await boot();
		completes(channel, {
			raced: true,
			summarized: true,
			after: marker => [{ type: "thinking_level_change", id: "tl", parentId: marker, timestamp: isoOf(60_000), thinkingLevel: "high" }],
		});
		const outcome = await session.navigate(rewind("u2", "a2"));
		assert.equal(outcome.status, "done");
		assert.equal(outcome.status === "done" && outcome.raced, true);
		assert.equal(outcome.status === "done" && outcome.summarized, true);
		assert.equal(session.model.leafId, "tl");
	});

	it("re-syncs an empty delta whose leaf moved, and a delta that does not extend the known leaf", async () => {
		const { channel, session } = await boot();
		let reads = fullReads(channel);
		// OMP moved the leaf without appending anything (its own turn recovery): an empty delta, another leaf.
		channel.child.leafId = "a1";
		channel.emit({ type: "agent_end", messages: [] });
		await waitUntil(() => session.model.leafId === "a1");
		assert.deepEqual(ids(session.model), ["u1", "a1"]);
		assert.equal(fullReads(channel), reads + 1);
		// A delta rooted elsewhere than the known leaf.
		reads = fullReads(channel);
		channel.child.entries.push(messageEntry("u3", "a2", userMessage("elsewhere", 8_000)) as never);
		channel.child.leafId = "u3";
		channel.emit({ type: "agent_end", messages: [] });
		await waitUntil(() => session.model.leafId === "u3");
		assert.deepEqual(ids(session.model), ["u1", "a1", "u2", "a2", "u3"]);
		assert.equal(fullReads(channel), reads + 1);
	});

	it("reports a coded refusal from the command as that refusal", async () => {
		const { channel, session } = await boot();
		const cases: [string, string][] = [["omp-desk-navigate:stale", "stale"], ["omp-desk-navigate:cancelled", "cancelled"], ["omp-desk-navigate:mode", "failed"], ["boom", "failed"]];
		for (const [error, reason] of cases) {
			onNavigate(channel, call => {
				setImmediate(() => {
					channel.emit({ type: "extension_error", extensionPath: NAVIGATE_ERROR_PATH, event: "command", error });
					promptResult(channel, call.id);
				});
				return {};
			});
			assert.deepEqual(await session.navigate(rewind("u2", "a2")), { status: "refused", reason }, error);
		}
		assert.equal(session.model.leafId, "a2");
		assert.deepEqual(ids(session.model), ["u1", "a1", "u2", "a2"]);
	});

	it("ends the wait on a local acknowledgement and on an error acknowledgement; the marker decides", async () => {
		const { channel, session } = await boot();
		onNavigate(channel, () => ({ data: { agentInvoked: false } }));
		assert.deepEqual(await session.navigate(rewind("u2", "a2")), { status: "refused", reason: "failed" }, "local, nothing moved");
		onNavigate(channel, () => ({ success: false, error: "no" }));
		assert.deepEqual(await session.navigate(rewind("u2", "a2")), { status: "refused", reason: "failed" }, "rejected, nothing moved");
		onNavigate(channel, call => {
			ompMove(channel, call.args);
			return { success: false, error: "late failure after the move" };
		});
		const moved = await session.navigate(rewind("u2", "a2"));
		assert.equal(moved.status, "done", "the marker outranks an error acknowledgement");
		onNavigate(channel, call => {
			ompMove(channel, call.args);
			return { data: { agentInvoked: false } };
		});
		const local = await session.navigate(rewind("u1", session.model.leafId));
		assert.equal(local.status, "done");
		assert.equal(local.status === "done" && local.draft?.text, "hi");
		assert.equal(channel.commandsOfType("abort").length, 0);
	});

	const fallThrough: [string, (channel: FakeRpcChannel, call: NavigateCall) => Record<string, unknown>][] = [
		["the acknowledgement says agentInvoked", () => ({ data: { agentInvoked: true } })],
		["the prompt_result says agentInvoked", (channel, call) => { setImmediate(() => promptResult(channel, call.id, true)); return {}; }],
		["the text arrives as a user message", (channel, call) => {
			setImmediate(() => channel.emitMessage("message_start", "msg-x", userMessage(`${PREFIX}${JSON.stringify(call.args)}`, 9_000) as never));
			return {};
		}],
	];
	for (const [name, script] of fallThrough) {
		it(`aborts and fails when ${name}`, async () => {
			const { channel, session } = await boot();
			onNavigate(channel, call => script(channel, call));
			assert.deepEqual(await session.navigate(rewind("u2", "a2")), { status: "refused", reason: "failed" });
			await waitUntil(() => channel.commandsOfType("abort").length > 0);
			assert.equal(channel.commandsOfType("abort").length, 1);
		});
	}

	it("is exactly-once per request id", async () => {
		const { channel, session } = await boot();
		completes(channel);
		const request = rewind("u2", "a2");
		const first = session.navigate(request);
		const again = session.navigate({ ...request });
		assert.equal(again, first, "the same promise");
		await first;
		assert.equal(session.navigate(request), first, "remembered after it settled");
		assert.equal(channel.commandsOfType("prompt").length, 1);
	});
});

describe("unanswered navigation fence", () => {
	async function timedOut(): Promise<Rig & { call: NavigateCall; outcome: NavigateOutcome }> {
		const rig = await boot();
		const calls = onNavigate(rig.channel, () => ({}));
		const pending = rig.session.navigate(rewind("u2", "a2"));
		await waitUntil(() => calls.length === 1);
		await tick();
		rig.timers.advance(30_000);
		const outcome = await pending;
		return { ...rig, call: calls[0]!, outcome };
	}

	it("reports unconfirmed and refuses every mutation until the late prompt_result", async () => {
		const { channel, session, call, outcome } = await timedOut();
		assert.deepEqual(outcome, { status: "unconfirmed" });
		assert.deepEqual(await session.prompt({ requestId: "p1", text: "next" }), { status: "refused", reason: "busy" });
		assert.deepEqual(await session.steer({ requestId: "p2", text: "steer" }), { status: "refused", reason: "busy" });
		assert.deepEqual(await session.followUp({ requestId: "p3", text: "later" }), { status: "refused", reason: "busy" });
		assert.deepEqual(await session.navigate(rewind("u2", "a2")), { status: "refused", reason: "busy" });
		promptResult(channel, "int:999999");
		await tick();
		assert.deepEqual(await session.prompt({ requestId: "p4", text: "next" }), { status: "refused", reason: "busy" }, "another internal id does not lift it");
		promptResult(channel, call.id);
		await tick();
		assert.equal((await session.prompt({ requestId: "p5", text: "next" })).status, "accepted");
	});

	it("lifts the fence when the marker shows up on the active path", async () => {
		const { channel, session, call } = await timedOut();
		assert.deepEqual(await session.prompt({ requestId: "p1", text: "next" }), { status: "refused", reason: "busy" });
		const marker = ompMove(channel, call.args);
		channel.emit({ type: "agent_end", messages: [] });
		await waitUntil(() => session.model.leafId === marker);
		await tick();
		assert.equal((await session.prompt({ requestId: "p2", text: "next" })).status, "accepted");
	});

	it("drops a late extension_error through the ordinary frame path: no child text reaches the page", async () => {
		const { channel, session, outputs } = await timedOut();
		const before = session.model;
		const seen = outputs.length;
		channel.emit({ type: "extension_error", extensionPath: NAVIGATE_ERROR_PATH, event: "command", error: "omp-desk-navigate:stale <script>secret child text</script>" });
		await tick();
		const after = outputs.slice(seen);
		assert.equal(JSON.stringify(after).includes("secret child text"), false);
		assert.equal(after.some(output => output.type === "event" && (output.frame.type as string) === "extension_error"), false);
		assert.equal(session.model, before, "the model is untouched");
		assert.deepEqual(await session.prompt({ requestId: "p1", text: "next" }), { status: "refused", reason: "busy" }, "an error frame does not lift the fence");
	});
});

describe("disk re-sync of a navigation", () => {
	async function bootOnDisk(): Promise<Rig & { file: string }> {
		const file = await scratchFile([u1, a1, u2, a2]);
		const rig = await boot({ file, child: { sessionFile: file } });
		return { ...rig, file };
	}

	it("takes the disk when it holds exactly what the process reports", async () => {
		const { channel, session, timers, file } = await bootOnDisk();
		onNavigate(channel, call => {
			ompMove(channel, call.args);
			void writeFile(file, sessionFileText({ id: "sess-1", entries: channel.child.entries })).then(() => promptResult(channel, call.id));
			return {};
		});
		const reads = fullReads(channel);
		const outcome = await session.navigate(rewind("u2", "a2"));
		assert.equal(outcome.status, "done");
		assert.equal(fullReads(channel), reads, "no full get_entries");
		assert.equal(timers.delays.includes(150), false, "no second look");
		assert.deepEqual(ids(session.model), ["u1", "a1", `nav-${markerSeq}`]);
	});

	it("looks again after 150 ms when the disk trails, then takes it", async () => {
		const { channel, session, timers, file } = await bootOnDisk();
		const calls = completes(channel);
		const reads = fullReads(channel);
		const pending = session.navigate(rewind("u2", "a2"));
		await waitUntil(() => timers.delays.includes(150));
		assert.equal(calls.length, 1);
		await writeFile(file, sessionFileText({ id: "sess-1", entries: channel.child.entries }));
		timers.advance(150);
		const outcome = await pending;
		assert.equal(outcome.status, "done");
		assert.equal(fullReads(channel), reads, "the second look agreed");
		assert.deepEqual(ids(session.model), ["u1", "a1", `nav-${markerSeq}`]);
	});

	it("falls back to a full get_entries when the disk still trails", async () => {
		const { channel, session, timers } = await bootOnDisk();
		completes(channel);
		const reads = fullReads(channel);
		const pending = session.navigate(rewind("u2", "a2"));
		await waitUntil(() => timers.delays.includes(150));
		timers.advance(150);
		const outcome = await pending;
		assert.equal(outcome.status, "done");
		assert.equal(fullReads(channel), reads + 1);
		assert.equal(session.model.leafId, `nav-${markerSeq}`);
		assert.deepEqual(ids(session.model), ["u1", "a1", `nav-${markerSeq}`]);
	});
});

describe("Undo and pending rows across a navigation", () => {
	const marker = { type: "custom", customType: NAVIGATION_MARKER_TYPE, id: "m1", parentId: "a1", timestamp: isoOf(5_000), data: { v: 1, requestId: RID, kind: "rewind", from: "a2", target: "u2", to: "a1", summarized: false } };

	it("offers and performs Undo after a restart (marker, session_exit, model_change)", async () => {
		const exit = { type: "custom", customType: "session_exit", id: "x1", parentId: "m1", timestamp: isoOf(6_000), data: {} };
		const model = { type: "model_change", id: "mc", parentId: "x1", timestamp: isoOf(7_000), model: "p/m" };
		const { channel, session } = await boot({ child: { entries: [u1, a1, u2, a2, marker, exit, model] as never, leafId: "mc" } });
		const offer = undoOffer(durable(session.model), session.model.leafId);
		assert.deepEqual(offer, { markerId: "m1", from: "a2", kind: "rewind", summarized: false });
		completes(channel);
		const outcome = await session.navigate({ requestId: rid(), kind: "undo", targetId: offer!.from, expectedLeafId: "mc", summarize: false });
		assert.deepEqual(outcome, { status: "done", kind: "undo", summarized: false, raced: false, draft: null });
		assert.deepEqual(ids(session.model), ["u1", "a1", "u2", "a2", `nav-${markerSeq}`]);
		assert.equal(undoOffer(durable(session.model), session.model.leafId), null, "an Undo is not undone");
	});

	for (const type of ["label", "mode_change", "service_tier_change"]) {
		it(`withholds Undo after a ${type} follows the marker`, async () => {
			const extra = { type, id: "z1", parentId: "m1", timestamp: isoOf(6_000), label: "x", mode: "plan", serviceTier: "flex" };
			const { channel, session } = await boot({ child: { entries: [u1, a1, u2, a2, marker, extra] as never, leafId: "z1" } });
			assert.equal(undoOffer(durable(session.model), session.model.leafId), null);
			assert.deepEqual(await session.navigate({ requestId: rid(), kind: "undo", targetId: "a2", expectedLeafId: "z1", summarize: false }), { status: "refused", reason: "stale" });
			assert.equal(channel.commandsOfType("prompt").length, 0);
		});
	}

	it("withholds Undo when the disk paint drops a label after the marker", async () => {
		const label = { type: "label", id: "z1", parentId: "m1", timestamp: isoOf(6_000), label: "x" };
		const file = await scratchFile([u1, a1, u2, a2, marker, label]);
		const { session } = await boot({ file, child: { sessionFile: file, entries: [u1, a1, u2, a2, marker, label] as never, leafId: "z1" } });
		assert.equal(session.model.leafId, "z1");
		assert.equal(undoOffer(durable(session.model), session.model.leafId), null);
	});

	it("keeps an unsaved pending row visible, unanchored, across a rewind", async () => {
		const { channel, session } = await boot({ session: { reconcileAttempts: 1 } });
		channel.emitMessage("message_end", "m-lost", userMessage("never saved", 9_000) as never);
		channel.emit({ type: "agent_end", messages: [] });
		await waitUntil(() => [...session.model.pending.values()].some(row => row.unsaved));
		const [rowId, row] = [...session.model.pending.entries()][0]!;
		assert.equal(row.anchorId, "a2");
		completes(channel);
		const outcome = await session.navigate(rewind("u2", "a2"));
		assert.equal(outcome.status, "done", "an unsaved row does not block a navigation");
		const kept = session.model.pending.get(rowId);
		assert.equal(kept?.unsaved, true);
		assert.equal(kept?.anchorId, null, "its anchor left the branch");
		assert.ok(session.model.entries.some(entry => entry.id === rowId), "still shown");
		assert.deepEqual(ids(session.model).filter(id => id !== rowId), ["u1", "a1", `nav-${markerSeq}`]);
	});
});

describe("switch", () => {
	it("switches to a branch tip", async () => {
		const m1 = { type: "custom", customType: NAVIGATION_MARKER_TYPE, id: "m1", parentId: "a1", timestamp: isoOf(5_000), data: { v: 1, requestId: RID, kind: "rewind", from: "a2", target: "u2", to: "a1", summarized: false } };
		const u2b = messageEntry("u2b", "m1", userMessage("other", 6_000));
		const a2b = messageEntry("a2b", "u2b", assistantMessage("other reply", 7_000));
		const { channel, session } = await boot({ child: { entries: [u1, a1, u2, a2, m1, u2b, a2b] as never, leafId: "a2b" } });
		completes(channel);
		const outcome = await session.navigate({ requestId: rid(), kind: "switch", targetId: "a2", expectedLeafId: "a2b", summarize: false });
		assert.deepEqual(outcome, { status: "done", kind: "switch", summarized: false, raced: false, draft: null });
		assert.deepEqual(ids(session.model), ["u1", "a1", "u2", "a2", `nav-${markerSeq}`]);
		assert.deepEqual(session.model.branches.map(point => [point.entryId, point.branches.map(branch => branch.tipId)]), [["a1", ["a2b"]]]);
	});
});

describe("replayed rows from a branch rewound away from", () => {
	// Branch A (u2, a2) was rewound away from; the active leaf is on branch B (u2b, a2b).
	const m1 = { type: "custom", customType: NAVIGATION_MARKER_TYPE, id: "m1", parentId: "a1", timestamp: isoOf(5_000), data: { v: 1, requestId: RID, kind: "rewind", from: "a2", target: "u2", to: "a1", summarized: false } };
	const u2b = messageEntry("u2b", "m1", userMessage("other", 6_000));
	const a2b = messageEntry("a2b", "u2b", assistantMessage("other reply", 7_000));

	/** Replay message frames, as a reattach replays the broker ring, then run reconcile passes until the budget is spent. */
	async function replay(messages: readonly Record<string, unknown>[]): Promise<Rig & { reads: number }> {
		const rig = await boot({ child: { entries: [u1, a1, u2, a2, m1, u2b, a2b] as never, leafId: "a2b" } });
		assert.ok(rig.session.model.branches.length > 0);
		const reads = fullReads(rig.channel);
		messages.forEach((message, index) => {
			rig.channel.emitMessage("message_start", `replay-${index}`, message);
			rig.channel.emitMessage("message_end", `replay-${index}`, message);
		});
		await tick();
		assert.equal(rig.session.model.pending.size, messages.length, "each replayed message is a pending row");
		rig.channel.emit({ type: "agent_end", messages: [] });
		for (let pass = 0; pass < 4; pass += 1) {
			await tick();
			rig.timers.advance(500);
		}
		await tick();
		return { ...rig, reads };
	}

	it("drops a pending row whose message is saved on another branch, never flagging it unsaved", async () => {
		// The same messages u2 and a2 persisted on branch A.
		const { channel, session, outputs, reads } = await replay([userMessage("again", 3000) as never, assistantMessage("sure", 4000) as never]);
		await waitUntil(() => session.model.pending.size === 0);
		assert.equal(session.model.pending.size, 0);
		assert.deepEqual(ids(session.model), ["u1", "a1", "m1", "u2b", "a2b"], "nothing from branch A is shown");
		assert.equal(outputs.some(output => output.type === "model" && [...output.model.pending.values()].some(row => row.unsaved)), false, "never flagged not yet saved");
		assert.equal(fullReads(channel), reads + 1, "one full read");
	});

	it("still flags a row saved nowhere once the budget is spent", async () => {
		const { channel, session, reads } = await replay([userMessage("never saved", 9_000) as never]);
		await waitUntil(() => [...session.model.pending.values()].some(row => row.unsaved));
		assert.deepEqual([...session.model.pending.values()].map(row => row.unsaved), [true]);
		assert.equal(fullReads(channel), reads + 1, "one full read");
	});
});
