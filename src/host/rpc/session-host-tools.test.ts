/**
 * `RpcSession` and Desk's host tools (ADR-0055, design section 1): registration in the resync, the executor gate on a
 * live session, settings changes, reconnects and an older broker.
 *
 * Runner: `node --test src/host/rpc/session-host-tools.test.ts`
 *
 * The child is the scripted `FakeRpcChannel`, which models the broker's ring (a pinned call is replayed until its
 * result is written), live input ownership and the `hostToolRetention` capability.
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { HOST_TOOL_EARLIER_ATTACHMENT_ERROR } from "../tools/host-tool-calls.ts";
import type { HostToolContext, HostToolDefinition, HostToolProvider, HostToolResult } from "../tools/host-tool.ts";
import { FakeRpcChannel, responseLine } from "./fake-channel.ts";
import { RpcSession, type RpcSessionOptions } from "./session.ts";
import { recordingLogger, type LoggedLine } from "../../shared/logger.ts";
import { ManualTimers, tick } from "./test-support.ts";

const FILE = "D:\\scratch\\host-tools.jsonl";

class Provider implements HostToolProvider {
	list: readonly HostToolDefinition[];
	readonly #listeners = new Set<() => void>();
	readonly started: Array<{ name: string; args: unknown; ctx: HostToolContext }> = [];
	readonly changed = (listener: () => void): { dispose(): void } => {
		this.#listeners.add(listener);
		return { dispose: () => void this.#listeners.delete(listener) };
	};

	constructor(names: readonly string[] = ["vscode_probe"]) {
		this.list = names.map(name => this.#tool(name));
	}

	tools(): readonly HostToolDefinition[] {
		return this.list;
	}

	set(names: readonly string[]): void {
		this.list = names.map(name => this.#tool(name));
		for (const listener of [...this.#listeners]) listener();
	}

	get listeners(): number {
		return this.#listeners.size;
	}

	/** Releases tool executions by hand. */
	readonly #waiters: Array<{ resolve(result: HostToolResult): void; reject(error: unknown): void }> = [];

	finish(index = 0, text = "done"): void {
		this.#waiters[index]?.resolve({ content: [{ type: "text", text }] });
	}

	#tool(name: string): HostToolDefinition {
		return {
			name,
			label: name,
			description: `${name} description`,
			parameters: { type: "object", properties: { n: { type: "number" } } },
			loadMode: "discoverable",
			execute: (args, ctx) => {
				this.started.push({ name, args, ctx });
				return new Promise<HostToolResult>((resolve, reject) => this.#waiters.push({ resolve, reject }));
			},
		};
	}
}

interface Rig {
	readonly channel: FakeRpcChannel;
	readonly session: RpcSession;
	readonly provider: Provider;
	readonly timers: ManualTimers;
	readonly logs: LoggedLine[];
}

const sessions: RpcSession[] = [];

afterEach(() => {
	for (const session of sessions.splice(0)) session.dispose();
});

async function boot(options: { provider?: Provider | null; setup?: (channel: FakeRpcChannel, provider: Provider) => void; session?: Partial<RpcSessionOptions>; wait?: boolean } = {}): Promise<Rig> {
	const provider = options.provider ?? new Provider();
	const channel = new FakeRpcChannel({ sessionFile: FILE });
	options.setup?.(channel, provider);
	const timers = new ManualTimers();
	const logs: LoggedLine[] = [];
	const session = new RpcSession({
		channel,
		sessionFile: FILE,
		cwd: "D:\\scratch",
		hostNonce: "host-a",
		timers,
		fileExists: async () => true,
		openHistory: async () => { throw new Error("no history"); },
		watchdogIntervalMs: 60 * 60_000,
		commandTimeoutMs: 10,
		reattachDelaysMs: [0],
		autoRecoveryDelaysMs: [],
		hostTools: provider,
		log: recordingLogger(logs),
		...options.session,
	});
	sessions.push(session);
	const started = session.start();
	if (options.wait !== false) await started;
	await tick();
	return { channel, session, provider, timers, logs };
}

const results = (channel: FakeRpcChannel, id?: string): Record<string, unknown>[] =>
	channel.commandsOfType("host_tool_result").filter(frame => id === undefined || frame.id === id);

const textOf = (frame: Record<string, unknown> | undefined): string => {
	const result = frame?.result as { content?: Array<{ text?: string }> } | undefined;
	return (result?.content ?? []).map(block => block.text ?? "").join("");
};

describe("registration", () => {
	it("registers the provider's tools before the session is live and answers a call after it", async () => {
		const { channel, session, provider } = await boot();
		assert.equal(session.phase, "live");
		const registrations = channel.commandsOfType("set_host_tools");
		assert.equal(registrations.length, 1);
		assert.deepEqual(registrations[0]?.tools, [
			{ name: "vscode_probe", label: "vscode_probe", description: "vscode_probe description", parameters: { type: "object", properties: { n: { type: "number" } } }, loadMode: "discoverable" },
		]);
		const order = channel.written.map(command => command.type);
		assert.ok(order.indexOf("set_host_tools") < order.indexOf("get_available_commands"), "registered during the resync, before the live publication");

		channel.emitHostCall("call-1", "vscode_probe", { n: 3 });
		await tick();
		assert.equal(provider.started.length, 1);
		assert.deepEqual(provider.started[0]?.args, { n: 3 });
		assert.equal(provider.started[0]?.ctx.conversationId, FILE, "the calling Chat's identity is its bound session file");
		provider.finish(0, "stopped at line 3");
		await tick();
		assert.equal(results(channel, "call-1").length, 1);
		assert.equal(textOf(results(channel, "call-1")[0]), "stopped at line 3");
	});

	it("sends nothing while the provider has no tools (the debugger is off), and ordinary Chat is live", async () => {
		const { channel, session } = await boot({ provider: new Provider([]) });
		assert.equal(session.phase, "live");
		assert.equal(channel.commandsOfType("set_host_tools").length, 0);
	});

	it("registers nothing without a provider and ignores a stray call frame", async () => {
		const channel = new FakeRpcChannel({ sessionFile: FILE });
		const session = new RpcSession({ channel, sessionFile: FILE, cwd: "D:\\scratch", hostNonce: "host-a", timers: new ManualTimers(), fileExists: async () => true, openHistory: async () => { throw new Error("no history"); } });
		sessions.push(session);
		await session.start();
		channel.emitHostCall("call-1", "vscode_probe");
		await tick();
		assert.equal(channel.commandsOfType("set_host_tools").length, 0);
		assert.equal(results(channel).length, 0);
	});

	it("registers no tools on a broker from an earlier build, tells the Chat once, and refuses a call it cannot hold", async () => {
		const { channel, session, provider } = await boot({ setup: channel => { channel.hostToolRetention = false; } });
		assert.equal(session.phase, "live");
		assert.equal(channel.commandsOfType("set_host_tools").length, 0);
		assert.match(session.model.commandFeedback?.message ?? "", /Stop and restart the session/);
		const feedbackId = session.model.commandFeedback?.id;
		// A later resync (and a reattach) does not repeat the notice.
		channel.closeLink("disconnected");
		await tick();
		assert.equal(session.phase, "live");
		assert.equal(session.model.commandFeedback?.id, feedbackId, "the notice is shown once");
		channel.emitHostCall("call-1", "vscode_probe");
		await tick();
		assert.equal(provider.started.length, 0);
	});

	it("says nothing to an older broker's session when the debugger is off", async () => {
		const { session } = await boot({ provider: new Provider([]), setup: channel => { channel.hostToolRetention = false; } });
		assert.equal(session.model.commandFeedback ?? null, null);
	});

	it("keeps Chat working and refuses every call when OMP rejects the registration", async () => {
		const { channel, session, provider, logs } = await boot({ setup: channel => { channel.hostToolsAnswer = "reject"; } });
		assert.equal(session.phase, "live");
		assert.deepEqual(logs.filter(line => /rejected set_host_tools/.test(line.message)).map(line => line.level), ["warn"]);
		channel.emitHostCall("call-1", "vscode_probe");
		await tick();
		assert.equal(provider.started.length, 0, "an unavailable debugger runs nothing");
		assert.match(textOf(results(channel, "call-1")[0]), /not available in this session/);
	});

	it("leaves availability unknown when OMP never answers, refusing calls until a later registration succeeds", async () => {
		const { channel, session, provider, timers, logs } = await boot({
			wait: false,
			setup: channel => channel.handlers.set("set_host_tools", () => "drop"),
		});
		await tick();
		timers.advance(10);
		await tick();
		assert.equal(session.phase, "live", "a registration timeout does not fail the session");
		assert.deepEqual(logs.filter(line => /did not answer set_host_tools/.test(line.message)).map(line => line.level), ["warn"]);
		channel.emitHostCall("call-1", "vscode_probe");
		await tick();
		assert.equal(provider.started.length, 0);
		assert.equal(results(channel, "call-1").length, 1);

		channel.handlers.delete("set_host_tools");
		provider.set(["vscode_probe"]);
		await tick();
		channel.emitHostCall("call-2", "vscode_probe");
		await tick();
		assert.equal(provider.started.length, 1, "the next successful registration makes the tools available");
	});

	it("re-registers a live session when the tool set changes, serialized and coalesced", async () => {
		const { channel, provider } = await boot({ setup: channel => channel.handlers.set("set_host_tools", () => undefined) });
		channel.handlers.set("set_host_tools", () => "drop");
		const before = channel.commandsOfType("set_host_tools").length;
		provider.set(["vscode_probe", "vscode_second"]);
		await tick();
		provider.set(["vscode_probe", "vscode_third"]);
		provider.set(["vscode_probe", "vscode_fourth"]);
		await tick();
		assert.equal(channel.commandsOfType("set_host_tools").length, before + 1, "one registration in flight; later changes wait");
		const inFlight = channel.commandsOfType("set_host_tools").at(-1)!;
		channel.handlers.delete("set_host_tools");
		channel.emit(responseLine(String(inFlight.id), "set_host_tools", true, { data: { toolNames: ["vscode_probe", "vscode_second"] } }));
		await tick();
		const sent = channel.commandsOfType("set_host_tools");
		assert.equal(sent.length, before + 2, "the changes that arrived meanwhile are sent once, as the newest set");
		assert.deepEqual((sent.at(-1)?.tools as Array<{ name: string }>).map(tool => tool.name), ["vscode_probe", "vscode_fourth"]);
	});

	it("stops running calls when the settings disable the tools, sends an empty registration and still answers", async () => {
		const { channel, provider } = await boot();
		channel.emitHostCall("call-1", "vscode_probe");
		await tick();
		const { ctx } = provider.started[0]!;
		provider.set([]);
		assert.equal(ctx.signal.aborted, true, "disabling aborts running calls");
		assert.throws(() => ctx.checkExecutor(), /disabled|stopped/);
		await tick();
		assert.deepEqual(channel.commandsOfType("set_host_tools").at(-1)?.tools, [], "the registration is replaced by an empty one");
		channel.emitHostCall("call-2", "vscode_probe");
		await tick();
		assert.equal(provider.started.length, 1);
		assert.match(textOf(results(channel, "call-2")[0]), /not available in this session/);
	});

	it("unsubscribes from the provider when the session is disposed", async () => {
		const { session, provider } = await boot();
		assert.equal(provider.listeners, 1);
		session.dispose();
		assert.equal(provider.listeners, 0);
	});
});

describe("executor gate on a live session", () => {
	it("answers with the earlier-attachment error, without running, a call that was pending before the first attach", async () => {
		const provider = new Provider();
		const { channel } = await boot({
			provider,
			wait: false,
			setup: channel => {
				channel.emitHostCall("old-1", "vscode_probe");
				channel.emitHostCall("old-2", "vscode_probe");
			},
		});
		await tick();
		assert.equal(provider.started.length, 0, "a call from before this attachment is never run");
		assert.equal(textOf(results(channel, "old-1")[0]), HOST_TOOL_EARLIER_ATTACHMENT_ERROR);
		assert.equal(textOf(results(channel, "old-2")[0]), HOST_TOOL_EARLIER_ATTACHMENT_ERROR);
		assert.equal(results(channel, "old-1")[0]?.isError, true);
	});

	it("answers a call first seen in a reconnect's replay, runs the live one, and answers the known one once", async () => {
		const { channel, provider, session, timers } = await boot();
		channel.emitHostCall("known", "vscode_probe");
		await tick();
		assert.equal(provider.started.length, 1);
		// The link drops while OMP asks for another tool; the session reattaches from its cursor.
		channel.disconnect();
		channel.emitHostCall("missed", "vscode_probe");
		channel.closeLink("disconnected");
		await tick(20);
		assert.equal(session.phase, "live");
		assert.equal(provider.started.length, 1, "the replayed call did not run");
		assert.equal(textOf(results(channel, "missed")[0]), HOST_TOOL_EARLIER_ATTACHMENT_ERROR);
		assert.equal(results(channel, "missed")[0]?.isError, true);
		timers.advance(5_000);
		await tick();
		assert.equal(results(channel, "known").length, 1, "the running call was stopped by the reattachment and answered once");
		assert.match(textOf(results(channel, "known")[0]), /Desk stopped this tool call/);
		channel.emitHostCall("fresh", "vscode_probe");
		await tick();
		assert.equal(provider.started.length, 2, "a call after the new attachment runs");
	});

	it("neither runs nor answers a call while another window holds input, and registers only when it takes the claim itself", async () => {
		const { channel, provider } = await boot({ setup: channel => { channel.inputClaimable = false; } });
		channel.emitHostCall("call-1", "vscode_probe");
		await tick();
		assert.equal(provider.started.length, 0);
		assert.equal(results(channel).length, 0);
		assert.equal(channel.commandsOfType("set_host_tools").length, 0, "a read-only window cannot write to OMP, so it registers nothing");
		channel.setOwned(true);
		await tick();
		assert.equal(channel.commandsOfType("set_host_tools").length, 1, "taking the claim registers the tools");
		assert.equal(textOf(results(channel, "call-1")[0]), HOST_TOOL_EARLIER_ATTACHMENT_ERROR, "the call it saw while read-only is answered, not run");
		channel.emitHostCall("call-2", "vscode_probe");
		await tick();
		assert.equal(provider.started.length, 1);
	});

	it("aborts a running call when input is lost and, once the claim is back, answers it once", async () => {
		const { channel, provider, timers } = await boot();
		channel.emitHostCall("call-1", "vscode_probe");
		await tick();
		const { ctx } = provider.started[0]!;
		channel.setOwned(false);
		assert.equal(ctx.signal.aborted, true);
		assert.throws(() => ctx.checkExecutor());
		timers.advance(5_000);
		await tick();
		assert.equal(results(channel).length, 0, "nothing can be written without the claim");
		channel.setOwned(true);
		await tick();
		assert.equal(results(channel, "call-1").length, 1);
		assert.equal(results(channel, "call-1")[0]?.isError, true);
		assert.match(textOf(results(channel, "call-1")[0]), /another window took over this session or released it/);
		provider.finish(0);
		await tick();
		assert.equal(results(channel, "call-1").length, 1, "the tool settling late changes nothing");
	});

	it("honors OMP's cancel: the signal aborts and nothing is written for the call", async () => {
		const { channel, provider } = await boot();
		channel.emitHostCall("call-1", "vscode_probe");
		await tick();
		const { ctx } = provider.started[0]!;
		channel.emitHostCancel("call-1");
		await tick();
		assert.equal(ctx.signal.aborted, true);
		provider.finish(0);
		await tick();
		assert.equal(results(channel).length, 0);
	});

	it("stops serving calls for good after the conversation's identity diverged", async () => {
		const { channel, provider, session } = await boot();
		channel.emitHostCall("call-1", "vscode_probe");
		await tick();
		const { ctx } = provider.started[0]!;
		channel.child.sessionId = "another-session";
		await session.readSettlement();
		await tick();
		assert.equal(session.phase, "failed");
		assert.equal(ctx.signal.aborted, true, "divergence fences execution");
		channel.emitHostCall("call-2", "vscode_probe");
		await tick();
		assert.equal(provider.started.length, 1);
	});

	it("drops the calls when the child exits", async () => {
		const { channel, provider } = await boot();
		channel.emitHostCall("call-1", "vscode_probe");
		await tick();
		const { ctx } = provider.started[0]!;
		channel.exitChild(1);
		await tick();
		assert.equal(ctx.signal.aborted, true);
		assert.equal(results(channel).length, 0);
	});
});
