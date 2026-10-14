/**
 * Tests for the host tool call ledger (ADR-0055, design section 1): the executor gate, call states, the replay
 * boundary, OMP's cancel versus local cancellation, and the exactly-one-result outbox.
 *
 * Runner: `node --test src/host/tools/host-tool-calls.test.ts`
 *
 * The ledger is driven through its ports with an in-memory writer, so every ordering a broker link can produce
 * (a refused write, an unacknowledged one, a lost and regained claim) is scripted and awaited as an event.
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { recordingLogger, silentLogger, type LoggedLine } from "../../shared/logger.ts";
import { ManualTimers, tick } from "../rpc/test-support.ts";
import {
	HOST_TOOL_CLOSED_CACHE,
	HOST_TOOL_EARLIER_ATTACHMENT_ERROR,
	HOST_TOOL_LOCAL_CANCEL_GRACE_MS,
	HOST_TOOL_MAX_RESULT_BYTES,
	HOST_TOOL_OUTBOX_WARN,
	HostToolCalls,
} from "./host-tool-calls.ts";
import { HostToolRefusal, type HostToolContext, type HostToolDefinition, type HostToolResult } from "./host-tool.ts";

type Written = Record<string, unknown>;

/** A tool whose execution a test releases or fails by hand. */
class Probe {
	readonly started: Array<{ args: unknown; ctx: HostToolContext }> = [];
	#waiters: Array<{ resolve(result: HostToolResult): void; reject(error: unknown): void }> = [];

	definition(name = "probe"): HostToolDefinition {
		return {
			name,
			label: name,
			description: `${name} tool`,
			parameters: { type: "object" },
			loadMode: "discoverable",
			execute: (args, ctx) => {
				this.started.push({ args, ctx });
				return new Promise<HostToolResult>((resolve, reject) => this.#waiters.push({ resolve, reject }));
			},
		};
	}

	finish(index = 0, text = "done"): void {
		this.#waiters[index]?.resolve({ content: [{ type: "text", text }] });
	}

	fail(index: number, error: unknown): void {
		this.#waiters[index]?.reject(error);
	}
}

class Rig {
	owned = true;
	ownerGeneration = 1;
	/** Result lines the broker accepted, in order (a refused or unacknowledged write is recorded separately). */
	readonly accepted: Written[] = [];
	readonly updates: Written[] = [];
	readonly lostAck: Written[] = [];
	readonly logs: LoggedLine[] = [];
	writeMode: "ok" | "refuse-not-owner" | "closed" | "lose-ack" | "child-exited" = "ok";
	tools: HostToolDefinition[];
	readonly timers = new ManualTimers();
	readonly calls: HostToolCalls;
	seq = 0;

	constructor(tools: HostToolDefinition[], maxRunning?: number) {
		this.tools = tools;
		this.calls = new HostToolCalls({
			conversationId: () => "D:/scratch/session.jsonl",
			writeLine: async line => {
				const frame = JSON.parse(line) as Written;
				if (frame.type === "host_tool_update") {
					this.updates.push(frame);
					return;
				}
				switch (this.writeMode) {
					case "ok":
						this.accepted.push(frame);
						return;
					case "lose-ack":
						this.lostAck.push(frame);
						throw Object.assign(new Error("no acknowledgement"), { code: "closed" });
					case "refuse-not-owner":
						throw Object.assign(new Error("not owner"), { code: "input-not-owner" });
					case "child-exited":
						throw Object.assign(new Error("gone"), { code: "child-exited" });
					default:
						throw Object.assign(new Error("closed"), { code: "closed" });
				}
			},
			inputOwned: () => this.owned,
			ownerGeneration: () => this.ownerGeneration,
			tools: () => this.tools,
			timers: this.timers,
			log: recordingLogger(this.logs),
			...(maxRunning === undefined ? {} : { maxRunning }),
		});
	}

	/** One attachment: the broker's `latestSeq`, a verified resync, registered tools, the gate open. */
	attach(latestSeq = 0, registered: string[] = this.tools.map(tool => tool.name)): void {
		this.calls.attached(latestSeq);
		this.calls.setRegistered(new Set(registered));
		this.calls.open();
	}

	/** A line OMP writes: `host_tool_call` with the next `seq`. */
	call(id: string, toolName = "probe", args: Record<string, unknown> = {}, seq = ++this.seq): number {
		this.seq = Math.max(this.seq, seq);
		this.calls.onCall({ type: "host_tool_call", id, toolCallId: `tc-${id}`, toolName, arguments: args }, seq);
		return seq;
	}

	cancel(targetId: string): void {
		this.calls.onCancel({ type: "host_tool_cancel", id: `cancel-${targetId}`, targetId });
	}

	loseOwnership(): void {
		this.owned = false;
		this.ownerGeneration += 1;
		this.calls.ownerChanged();
	}

	regainOwnership(): void {
		this.owned = true;
		this.ownerGeneration += 1;
		this.calls.ownerChanged();
	}

	resultsFor(id: string): Written[] {
		return this.accepted.filter(frame => frame.id === id);
	}
}

const textOf = (frame: Written | undefined): string => {
	const result = frame?.result as { content?: Array<{ text?: string }> } | undefined;
	return (result?.content ?? []).map(block => block.text ?? "").join("");
};

const rigs: Rig[] = [];
const rig = (probe: Probe, maxRunning?: number): Rig => {
	const created = new Rig([probe.definition()], maxRunning);
	rigs.push(created);
	return created;
};

afterEach(() => {
	for (const created of rigs.splice(0)) created.calls.dispose();
});

describe("admission", () => {
	it("runs a live call, writes one result frame and then reports it delivered", async () => {
		const probe = new Probe();
		const r = rig(probe);
		r.attach(0);
		r.call("c1", "probe", { n: 1 });
		assert.equal(r.calls.stateOf("c1"), "running");
		assert.deepEqual(probe.started[0]?.args, { n: 1 });
		assert.equal(probe.started[0]?.ctx.conversationId, "D:/scratch/session.jsonl");
		probe.finish(0, "hello");
		await tick();
		assert.equal(r.calls.stateOf("c1"), "delivered");
		assert.equal(r.resultsFor("c1").length, 1);
		const frame = r.resultsFor("c1")[0]!;
		assert.equal(frame.type, "host_tool_result");
		assert.equal(Object.keys(frame)[0], "type", "the broker reads the frame type from the head of the line");
		assert.equal(textOf(frame), "hello");
		assert.equal(frame.isError, undefined);
	});

	it("turns a thrown error and a refusal into one error result", async () => {
		const probe = new Probe();
		const r = rig(probe);
		r.attach(0);
		r.call("c1");
		r.call("c2");
		probe.fail(0, new HostToolRefusal("Not allowed here."));
		probe.fail(1, new Error("boom"));
		await tick();
		assert.equal(textOf(r.resultsFor("c1")[0]), "Not allowed here.");
		assert.equal(r.resultsFor("c1")[0]?.isError, true);
		assert.match(textOf(r.resultsFor("c2")[0]), /boom/);
		assert.equal(r.resultsFor("c2")[0]?.isError, true);
	});

	it("refuses an unknown or unregistered tool with an error result and runs nothing", async () => {
		const probe = new Probe();
		const r = rig(probe);
		r.attach(0, []);
		r.call("c1", "probe");
		r.call("c2", "nope");
		await tick();
		assert.equal(probe.started.length, 0);
		assert.match(textOf(r.resultsFor("c1")[0]), /not available in this session/);
		assert.match(textOf(r.resultsFor("c2")[0]), /not available in this session/);
	});

	it("ignores a call line without a string id and counts it", () => {
		const probe = new Probe();
		const r = rig(probe);
		r.attach(0);
		r.calls.onCall({ type: "host_tool_call", toolName: "probe", arguments: {} }, 1);
		r.calls.onCall({ type: "host_tool_call", id: 7, toolName: "probe", arguments: {} }, 2);
		assert.equal(r.calls.malformedCount, 2);
		assert.equal(probe.started.length, 0);
	});

	it("cuts an oversized result and replaces a malformed one with an error", async () => {
		const r = new Rig([
			{ name: "big", label: "big", description: "d", parameters: {}, loadMode: "discoverable", execute: async () => ({ content: [{ type: "text", text: "x".repeat(HOST_TOOL_MAX_RESULT_BYTES * 2) }] }) },
			{ name: "bad", label: "bad", description: "d", parameters: {}, loadMode: "discoverable", execute: async () => ({ content: "not an array" }) as unknown as HostToolResult },
		]);
		rigs.push(r);
		r.attach(0);
		r.call("big", "big");
		r.call("bad", "bad");
		await tick();
		const big = textOf(r.resultsFor("big")[0]);
		assert.ok(Buffer.byteLength(big) < HOST_TOOL_MAX_RESULT_BYTES + 200);
		assert.match(big, /Desk cut this result/);
		assert.equal(r.resultsFor("bad")[0]?.isError, true);
		assert.match(textOf(r.resultsFor("bad")[0]), /malformed/);
	});
});

describe("calls and cancels before the resync", () => {
	it("buffers a call and applies a cancel that follows it, so a cancelled call never starts and is never answered", async () => {
		const probe = new Probe();
		const r = rig(probe);
		r.calls.attached(0);
		r.call("c1");
		r.call("c2");
		assert.equal(r.calls.stateOf("c1"), "buffered");
		r.cancel("c1");
		assert.equal(r.calls.stateOf("c1"), "cancelled");
		r.calls.setRegistered(new Set(["probe"]));
		r.calls.open();
		await tick();
		assert.equal(probe.started.length, 1, "only the call OMP kept is started");
		assert.equal(r.calls.stateOf("c2"), "running");
		assert.equal(r.resultsFor("c1").length, 0);
	});

	it("decides buffered calls in arrival order after the resync", async () => {
		const probe = new Probe();
		const r = rig(probe);
		r.calls.attached(0);
		r.call("c1", "probe", { n: 1 });
		r.call("c2", "probe", { n: 2 });
		r.call("c3", "probe", { n: 3 });
		assert.equal(probe.started.length, 0, "nothing runs before the resync finished");
		r.calls.setRegistered(new Set(["probe"]));
		r.calls.open();
		assert.deepEqual(probe.started.map(item => (item.args as { n: number }).n), [1, 2, 3]);
	});
});

describe("replay boundary", () => {
	it("answers a buffered call at or before the first attach's latestSeq with the earlier-attachment error and runs nothing", async () => {
		const probe = new Probe();
		const r = rig(probe);
		r.calls.attached(10);
		r.call("old-1", "probe", {}, 9);
		r.call("old-2", "probe", {}, 10);
		r.call("live", "probe", {}, 11);
		r.calls.setRegistered(new Set(["probe"]));
		r.calls.open();
		await tick();
		assert.equal(probe.started.length, 1, "only the call after the boundary ran");
		for (const id of ["old-1", "old-2"]) {
			assert.equal(textOf(r.resultsFor(id)[0]), HOST_TOOL_EARLIER_ATTACHMENT_ERROR);
			assert.equal(r.resultsFor(id)[0]?.isError, true);
		}
		assert.equal(r.calls.stateOf("live"), "running");
	});

	it("answers a call first seen in the replay of a reconnect, and ignores a known call seen again", async () => {
		const probe = new Probe();
		const r = rig(probe);
		r.attach(0);
		r.call("known", "probe", {}, 1);
		assert.equal(r.calls.stateOf("known"), "running");
		// The link drops; the session reattaches. Lines up to latestSeq 5 are replay.
		r.calls.closeGate("the broker connection closed");
		r.calls.attached(5);
		r.call("known", "probe", {}, 1);
		r.call("missed", "probe", {}, 4);
		r.call("fresh", "probe", {}, 6);
		r.calls.setRegistered(new Set(["probe"]));
		r.calls.open();
		await tick();
		assert.equal(textOf(r.resultsFor("missed")[0]), HOST_TOOL_EARLIER_ATTACHMENT_ERROR);
		r.timers.advance(HOST_TOOL_LOCAL_CANCEL_GRACE_MS);
		await tick();
		assert.equal(r.resultsFor("known").length, 1, "the known call is answered once, by its local cancellation (its tool never settled)");
		assert.equal(probe.started.length, 2, "the first call (started once) and the fresh one; the replayed ones never ran");
	});

	it("keeps a call past the reconnect cursor out of the replay: nothing is re-run and nothing duplicated", async () => {
		const probe = new Probe();
		const r = rig(probe);
		r.attach(0);
		r.call("c1", "probe", {}, 1);
		probe.finish(0);
		await tick();
		assert.equal(r.calls.stateOf("c1"), "delivered");
		r.calls.closeGate("the broker connection closed");
		r.calls.attached(1);
		r.call("c1", "probe", {}, 1);
		r.calls.setRegistered(new Set(["probe"]));
		r.calls.open();
		await tick();
		assert.equal(probe.started.length, 1);
		assert.equal(r.accepted.length, 1);
	});
});

describe("outbox", () => {
	it("keeps a result completed while another window holds input and delivers it exactly once when this one does again", async () => {
		const probe = new Probe();
		const r = rig(probe);
		r.attach(0);
		r.call("c1");
		r.writeMode = "refuse-not-owner";
		r.owned = false;
		r.ownerGeneration += 1;
		r.calls.ownerChanged();
		// The tool ignores the abort and returns a result of its own while the claim is gone.
		probe.finish(0, "late");
		await tick();
		assert.equal(r.calls.stateOf("c1"), "completed");
		assert.equal(r.accepted.length, 0, "a read-only window does not answer");
		r.writeMode = "ok";
		r.regainOwnership();
		await tick();
		assert.equal(r.resultsFor("c1").length, 1);
		assert.equal(r.calls.stateOf("c1"), "delivered");
		r.regainOwnership();
		r.calls.ownerChanged();
		await tick();
		assert.equal(r.resultsFor("c1").length, 1, "a delivered result is never written again");
	});

	it("re-sends a result whose acknowledgement was lost, under the same id, until the broker accepts it", async () => {
		const probe = new Probe();
		const r = rig(probe);
		r.attach(0);
		r.writeMode = "lose-ack";
		r.call("c1");
		probe.finish(0);
		await tick();
		assert.equal(r.lostAck.length, 1);
		assert.equal(r.calls.stateOf("c1"), "completed", "an unacknowledged write is not delivery");
		// Reconnect: the gate opens again and the outbox is flushed.
		r.writeMode = "ok";
		r.calls.closeGate("the broker connection closed");
		r.calls.attached(5);
		r.calls.setRegistered(new Set(["probe"]));
		r.calls.open();
		await tick();
		assert.equal(r.resultsFor("c1").length, 1);
		assert.equal(r.lostAck[0]?.id, "c1");
		assert.equal(r.calls.stateOf("c1"), "delivered");
		assert.equal(probe.started.length, 1, "nothing is re-run");
	});

	it("delivers results oldest first, one at a time", async () => {
		const probe = new Probe();
		const r = rig(probe);
		r.attach(0);
		r.call("c1");
		r.call("c2");
		r.call("c3");
		probe.finish(2);
		probe.finish(0);
		probe.finish(1);
		await tick();
		assert.deepEqual(r.accepted.map(frame => frame.id), ["c3", "c1", "c2"], "completion order, not arrival order");
	});

	it("never evicts an undelivered result, and warns once past the soft threshold", async () => {
		const probe = new Probe();
		const r = rig(probe, 100);
		r.attach(0);
		r.writeMode = "closed";
		const count = HOST_TOOL_OUTBOX_WARN + 5;
		for (let index = 0; index < count; index += 1) r.call(`c${index}`);
		for (let index = 0; index < count; index += 1) probe.finish(index);
		await tick();
		assert.equal(r.calls.outstandingResults, count);
		assert.equal(r.logs.length, 1);
		assert.match(r.logs[0]?.message ?? "", /waiting for delivery/);
		assert.equal(r.logs[0]?.level, "warn");
		r.writeMode = "ok";
		r.calls.ownerChanged();
		await tick(count + 4);
		assert.equal(r.accepted.length, count);
	});

	it("bounds the delivered-id cache and still ignores a recent replayed id", async () => {
		const probe = new Probe();
		const r = rig(probe, 1000);
		r.attach(0);
		for (let index = 0; index < HOST_TOOL_CLOSED_CACHE + 20; index += 1) {
			r.call(`c${index}`);
			probe.finish(index);
			await tick(2);
		}
		assert.equal(r.calls.stateOf("c0"), undefined, "the oldest id fell out of the cache");
		const latest = `c${HOST_TOOL_CLOSED_CACHE + 19}`;
		assert.equal(r.calls.stateOf(latest), "delivered");
		const before = probe.started.length;
		r.call(latest, "probe", {}, 1);
		assert.equal(probe.started.length, before, "a replayed delivered id is not run again");
	});

	it("drops the outbox and stops everything when the child exits", async () => {
		const probe = new Probe();
		const r = rig(probe);
		r.attach(0);
		r.writeMode = "closed";
		r.call("done");
		r.call("running");
		probe.finish(0);
		await tick();
		assert.equal(r.calls.stateOf("done"), "completed");
		r.calls.childExited();
		assert.equal(probe.started[1]?.ctx.signal.aborted, true);
		assert.equal(r.calls.stateOf("done"), undefined);
		assert.equal(r.calls.outstandingResults, 0);
		r.writeMode = "ok";
		r.regainOwnership();
		await tick();
		assert.equal(r.accepted.length, 0, "OMP is gone: nothing is delivered");
	});

	it("treats a write that learns the child is gone as the child exiting", async () => {
		const probe = new Probe();
		const r = rig(probe);
		r.attach(0);
		r.writeMode = "child-exited";
		r.call("c1");
		probe.finish(0);
		await tick();
		assert.equal(r.calls.stateOf("c1"), undefined);
	});
});

describe("read-only subscriber", () => {
	it("neither executes nor answers a call while another window holds input", async () => {
		const probe = new Probe();
		const r = rig(probe);
		r.attach(0);
		r.owned = false;
		r.ownerGeneration += 1;
		r.calls.ownerChanged();
		r.call("c1");
		await tick();
		assert.equal(r.calls.stateOf("c1"), "unadmitted");
		assert.equal(probe.started.length, 0);
		assert.equal(r.accepted.length, 0);
	});

	it("answers what it saw while read-only with the earlier-attachment error once it holds the gate itself, and not if OMP cancelled it", async () => {
		const probe = new Probe();
		const r = rig(probe);
		r.attach(0);
		r.owned = false;
		r.ownerGeneration += 1;
		r.calls.ownerChanged();
		r.call("c1");
		r.call("c2");
		r.cancel("c2");
		r.regainOwnership();
		await tick();
		assert.equal(probe.started.length, 0);
		assert.equal(textOf(r.resultsFor("c1")[0]), HOST_TOOL_EARLIER_ATTACHMENT_ERROR);
		assert.equal(r.resultsFor("c2").length, 0);
		assert.equal(r.accepted.length, 1);
	});

	it("does not run a buffered call when another window held input at the resync", async () => {
		const probe = new Probe();
		const r = rig(probe);
		r.calls.attached(0);
		r.owned = false;
		r.call("c1");
		r.calls.setRegistered(new Set(["probe"]));
		r.calls.open();
		await tick();
		assert.equal(r.calls.stateOf("c1"), "unadmitted");
		assert.equal(probe.started.length, 0);
		assert.equal(r.accepted.length, 0);
	});
});

describe("local cancellation", () => {
	it("aborts a running call when ownership is lost, and still answers it once with an error after the gate returns", async () => {
		const probe = new Probe();
		const r = rig(probe);
		r.attach(0);
		r.call("c1");
		const { ctx } = probe.started[0]!;
		r.writeMode = "refuse-not-owner";
		r.loseOwnership();
		assert.equal(ctx.signal.aborted, true);
		assert.throws(() => ctx.checkExecutor(), HostToolRefusal);
		probe.fail(0, new HostToolRefusal("Stopped before the request was sent."));
		await tick();
		assert.equal(r.calls.stateOf("c1"), "completed", "the error result waits in the outbox");
		assert.equal(r.accepted.length, 0);
		r.writeMode = "ok";
		r.regainOwnership();
		await tick();
		assert.equal(r.resultsFor("c1").length, 1);
		assert.equal(r.resultsFor("c1")[0]?.isError, true);
		assert.match(textOf(r.resultsFor("c1")[0]), /Desk stopped this tool call/);
	});

	it("answers for a tool that ignores its signal after the grace period, saying the effect is unknown", async () => {
		const probe = new Probe();
		const r = rig(probe);
		r.attach(0);
		r.call("c1");
		r.loseOwnership();
		assert.equal(r.calls.stateOf("c1"), "running");
		r.timers.advance(HOST_TOOL_LOCAL_CANCEL_GRACE_MS);
		assert.equal(r.calls.stateOf("c1"), "completed");
		r.regainOwnership();
		await tick();
		assert.match(textOf(r.resultsFor("c1")[0]), /effect is unknown/);
		// The tool finally settles: nothing more is written.
		probe.finish(0);
		await tick();
		assert.equal(r.resultsFor("c1").length, 1);
	});

	it("does not trust a result a tool returns after the gate was lost", async () => {
		const probe = new Probe();
		const r = rig(probe);
		r.attach(0);
		r.call("c1");
		r.loseOwnership();
		probe.finish(0, "everything went fine");
		r.regainOwnership();
		await tick();
		const frame = r.resultsFor("c1")[0]!;
		assert.equal(frame.isError, true);
		assert.match(textOf(frame), /did not trust/);
	});

	it("answers a queued call without starting it when the connection drops, and answers the running one", async () => {
		const probe = new Probe();
		const r = rig(probe, 1);
		r.attach(0);
		r.call("running");
		r.call("queued");
		assert.equal(r.calls.stateOf("running"), "running");
		assert.equal(r.calls.stateOf("queued"), "queued");
		r.writeMode = "closed";
		r.calls.closeGate("the broker connection closed");
		assert.equal(r.calls.stateOf("queued"), "completed", "a call that never left its queue still gets its result");
		probe.fail(0, new HostToolRefusal("Stopped."));
		await tick();
		assert.equal(probe.started.length, 1, "the queued call never started");
		// Reconnect: both results go out, once each.
		r.writeMode = "ok";
		r.calls.attached(10);
		r.calls.setRegistered(new Set(["probe"]));
		r.calls.open();
		await tick();
		assert.equal(r.resultsFor("running").length, 1);
		assert.equal(r.resultsFor("queued").length, 1);
		assert.match(textOf(r.resultsFor("queued")[0]), /before it started/);
		assert.equal(probe.started.length, 1);
	});

	it("never starts a call admitted under a lost owner generation, even when the claim comes back", async () => {
		const probe = new Probe();
		const r = rig(probe, 1);
		r.attach(0);
		r.call("running");
		r.call("queued");
		r.loseOwnership();
		r.regainOwnership();
		probe.fail(0, new Error("aborted"));
		await tick();
		assert.equal(probe.started.length, 1);
		assert.equal(r.resultsFor("queued").length, 1);
		assert.equal(r.resultsFor("queued")[0]?.isError, true);
	});

	it("refuses to continue a running call whose owner generation changed, even though the gate holds again", () => {
		const probe = new Probe();
		const r = rig(probe);
		r.attach(0);
		r.call("c1");
		const { ctx } = probe.started[0]!;
		ctx.checkExecutor();
		r.ownerGeneration += 1;
		assert.throws(() => ctx.checkExecutor(), /lost and regained/);
	});

	it("aborts running and queued calls of a tool the settings disabled, and answers each once", async () => {
		const probe = new Probe();
		const r = rig(probe, 1);
		r.attach(0);
		r.call("running");
		r.call("queued");
		const { ctx } = probe.started[0]!;
		r.tools = [];
		r.calls.retract(new Set());
		assert.equal(ctx.signal.aborted, true);
		assert.throws(() => ctx.checkExecutor(), HostToolRefusal);
		probe.fail(0, new HostToolRefusal("Stopped."));
		await tick();
		assert.equal(r.resultsFor("running").length, 1);
		assert.equal(r.resultsFor("queued").length, 1);
		assert.match(textOf(r.resultsFor("running")[0]), /the tool was disabled/);
		assert.equal(probe.started.length, 1);
		r.call("later");
		await tick();
		assert.match(textOf(r.resultsFor("later")[0]), /not available in this session/);
	});

	it("stops everything for good when the conversation diverges", async () => {
		const probe = new Probe();
		const r = rig(probe);
		r.attach(0);
		r.call("c1");
		r.calls.diverged();
		assert.equal(probe.started[0]?.ctx.signal.aborted, true);
		r.calls.open();
		r.call("c2");
		await tick();
		assert.equal(probe.started.length, 1, "a diverged session never executes again");
		assert.equal(r.calls.stateOf("c2"), undefined);
	});
});

describe("OMP's cancel", () => {
	it("aborts a running call, stops its updates and retires its result without answering", async () => {
		const probe = new Probe();
		const r = rig(probe);
		r.attach(0);
		r.call("c1");
		const { ctx } = probe.started[0]!;
		ctx.update({ content: [{ type: "text", text: "halfway" }] });
		await tick();
		assert.equal(r.updates.length, 1);
		r.cancel("c1");
		assert.equal(ctx.signal.aborted, true);
		assert.equal(r.calls.stateOf("c1"), "cancelled");
		ctx.update({ content: [{ type: "text", text: "after the cancel" }] });
		probe.finish(0, "too late");
		await tick();
		assert.equal(r.updates.length, 1, "no progress after the cancel");
		assert.equal(r.accepted.length, 0, "OMP needs no answer for its own cancel");
	});

	it("retires a completed result that was not yet accepted, and a duplicate cancel or one for an unknown id changes nothing", async () => {
		const probe = new Probe();
		const r = rig(probe);
		r.attach(0);
		r.writeMode = "closed";
		r.call("c1");
		probe.finish(0);
		await tick();
		assert.equal(r.calls.stateOf("c1"), "completed");
		r.cancel("c1");
		r.cancel("c1");
		r.cancel("nope");
		assert.equal(r.calls.stateOf("c1"), "cancelled");
		r.writeMode = "ok";
		r.calls.ownerChanged();
		await tick();
		assert.equal(r.accepted.length, 0);
	});

	it("frees the slot of a cancelled running call so a queued call can start", async () => {
		const probe = new Probe();
		const r = rig(probe, 1);
		r.attach(0);
		r.call("c1");
		r.call("c2");
		assert.equal(r.calls.stateOf("c2"), "queued");
		r.cancel("c1");
		assert.equal(r.calls.stateOf("c2"), "running");
		assert.equal(probe.started.length, 2);
	});

	it("does not answer or start a queued call OMP cancelled", async () => {
		const probe = new Probe();
		const r = rig(probe, 1);
		r.attach(0);
		r.call("c1");
		r.call("c2");
		r.cancel("c2");
		probe.finish(0);
		await tick();
		assert.equal(probe.started.length, 1);
		assert.equal(r.calls.stateOf("c2"), "cancelled");
		assert.equal(r.accepted.length, 1);
	});

	it("ignores a cancel for a call already delivered", async () => {
		const probe = new Probe();
		const r = rig(probe);
		r.attach(0);
		r.call("c1");
		probe.finish(0);
		await tick();
		r.cancel("c1");
		assert.equal(r.calls.stateOf("c1"), "delivered");
	});
});

describe("progress updates", () => {
	it("sends the newest partial after the one in flight", async () => {
		const sent: string[] = [];
		const release: Array<() => void> = [];
		const probe = new Probe();
		const calls = new HostToolCalls({
			conversationId: () => "c",
			writeLine: line => {
				const frame = JSON.parse(line) as Written;
				if (frame.type !== "host_tool_update") return Promise.resolve();
				sent.push(textOf({ result: frame.partialResult }));
				return new Promise<void>(resolve => release.push(resolve));
			},
			inputOwned: () => true,
			ownerGeneration: () => 1,
			tools: () => [probe.definition()],
			timers: new ManualTimers(),
			log: silentLogger,
		});
		try {
			calls.attached(0);
			calls.setRegistered(new Set(["probe"]));
			calls.open();
			calls.onCall({ type: "host_tool_call", id: "c1", toolName: "probe", arguments: {} }, 1);
			const { ctx } = probe.started[0]!;
			for (const text of ["one", "two", "three", "four"]) ctx.update({ content: [{ type: "text", text }] });
			assert.deepEqual(sent, ["one"], "one update in flight at a time");
			release.shift()?.();
			await tick();
			assert.deepEqual(sent, ["one", "four"], "the intermediate partials were superseded");
		} finally {
			calls.dispose();
		}
	});
});
