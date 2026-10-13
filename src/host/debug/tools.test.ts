import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HostToolResult } from "../tools/host-tool.ts";
import { HostToolRefusal } from "../tools/host-tool.ts";
import { LAUNCH_MARKER_KEY } from "./coordinator.ts";
import type { Harness } from "./test-harness.ts";
import { createHarness, GateLost, MemoryOwnershipStore, sleep, text } from "./test-harness.ts";

/** Starts the configured "Run app" through the tool and returns the session id the grant covers. */
async function startGranted(h: Harness, conversationId = "conv-1"): Promise<string> {
	const result = await h.call("vscode_debug_start", { name: "Run app" }, { conversationId });
	assert.equal(result.isError, undefined, text(result));
	const details = result.details as { sessionIds: string[] };
	return details.sessionIds[0]!;
}

function generationOf(result: HostToolResult): number {
	return (result.details as { generation: number }).generation;
}

describe("vscode_debug_start", () => {
	it("starts a named configuration with a per-attempt marker and grants control to the starting conversation", async () => {
		const h = createHarness();
		const result = await h.call("vscode_debug_start", { name: "Run app" });
		assert.equal(result.isError, undefined, text(result));
		assert.equal(h.api.started.length, 1);
		const marker = h.api.started[0]!.configuration[LAUNCH_MARKER_KEY];
		assert.equal(typeof marker, "string");
		assert.equal(h.api.started[0]!.folderPath, "C:\\work\\app");
		const view = h.parts.coordinator.sessions()[0]!;
		assert.equal(view.origin, "desk");
		assert.equal(h.parts.coordinator.canControl(view.id, "conv-1"), true);
		assert.equal(h.parts.coordinator.canControl(view.id, "conv-2"), false);
		// A second attempt gets a different marker.
		await h.call("vscode_debug_start", { name: "Run app" });
		assert.notEqual(h.api.started[1]!.configuration[LAUNCH_MARKER_KEY], marker);
		h.dispose();
	});

	it("refuses a compound configuration without calling VS Code", async () => {
		const h = createHarness();
		const result = await h.call("vscode_debug_start", { name: "Both" });
		assert.equal(result.isError, true);
		assert.match(text(result), /compound/i);
		assert.equal(h.api.started.length, 0);
		h.dispose();
	});

	it("reports VS Code refusing (false) without a grant", async () => {
		const h = createHarness();
		h.api.startBehavior = async () => false;
		const result = await h.call("vscode_debug_start", { name: "Run app" });
		assert.equal(result.isError, true);
		assert.match(text(result), /refused/i);
		assert.equal((result.details as { outcome: string }).outcome, "refused");
		assert.equal(h.parts.coordinator.sessions().length, 0);
		h.dispose();
	});

	it("reports an error thrown by VS Code", async () => {
		const h = createHarness();
		h.api.startBehavior = async () => { throw new Error("preLaunchTask failed"); };
		const result = await h.call("vscode_debug_start", { name: "Run app" });
		assert.equal(result.isError, true);
		assert.match(text(result), /preLaunchTask failed/);
		h.dispose();
	});

	it("says 'session not identified' and grants nothing when success is reported but no session carries the marker", async () => {
		const h = createHarness();
		h.api.startBehavior = async () => true;
		const result = await h.call("vscode_debug_start", { name: "Run app" });
		assert.equal(result.isError, true);
		assert.equal((result.details as { outcome: string }).outcome, "not-identified");
		h.dispose();
	});

	it("does not grant a session that appears after the call was cancelled (late start after cancel)", async () => {
		const h = createHarness();
		let finish!: () => void;
		let configuration!: Record<string, unknown>;
		h.api.startBehavior = (_folder, config) => {
			configuration = config;
			return new Promise<boolean>(resolve => { finish = () => resolve(true); });
		};
		const abort = new AbortController();
		const pending = h.call("vscode_debug_start", { name: "Run app" }, { signal: abort.signal });
		await sleep(20);
		abort.abort();
		const result = await pending;
		assert.equal((result.details as { outcome: string }).outcome, "unknown");
		// VS Code starts the session after all.
		h.api.startSession({ id: "late", type: "node", name: "Run app", configuration });
		finish();
		const view = h.parts.coordinator.session("late")!;
		assert.equal(view.origin, "user");
		assert.equal(h.parts.coordinator.canControl("late", "conv-1"), false);
		const control = await h.call("vscode_debug_control", { sessionId: "late", action: "continue" });
		assert.equal(control.isError, true);
		h.dispose();
	});

	it("reports an unknown outcome when VS Code does not answer in time", async () => {
		const h = createHarness({ limits: { launchTimeoutMs: 60 } });
		h.api.startBehavior = () => new Promise<boolean>(() => {});
		const result = await h.call("vscode_debug_start", { name: "Run app" });
		assert.equal((result.details as { outcome: string }).outcome, "unknown");
		h.dispose();
	});

	it("asks first when the start setting is ask, naming folder, configuration, type, request and program", async () => {
		const h = createHarness();
		h.policy.start = "ask";
		await h.call("vscode_debug_start", { name: "Run app" });
		assert.equal(h.policy.confirmations.length, 1);
		const lines = h.policy.confirmations[0]!.lines.join("\n");
		assert.match(lines, /app/);
		assert.match(lines, /Run app/);
		assert.match(lines, /node/);
		assert.match(lines, /launch/);
		assert.match(lines, /main\.js/);
		h.dispose();
	});

	it("starts nothing when the user declines", async () => {
		const h = createHarness();
		h.policy.start = "ask";
		h.policy.answer = async () => false;
		const result = await h.call("vscode_debug_start", { name: "Run app" });
		assert.equal(result.isError, true);
		assert.equal(h.api.started.length, 0);
		h.dispose();
	});

	it("starts nothing when launch.json changed while the confirmation was open", async () => {
		const h = createHarness();
		h.policy.start = "ask";
		h.policy.answer = async () => {
			h.api.launch.set("C:\\work\\app", { configurations: [{ name: "Run app", type: "node", request: "launch", program: "evil.js" }], compounds: [] });
			return true;
		};
		const result = await h.call("vscode_debug_start", { name: "Run app" });
		assert.equal(result.isError, true);
		assert.match(text(result), /changed/);
		assert.equal(h.api.started.length, 0);
		h.dispose();
	});

	it("starts nothing when the tools were disabled during the confirmation", async () => {
		const h = createHarness();
		h.policy.start = "ask";
		h.policy.answer = async () => {
			h.policy.isEnabled = false;
			return true;
		};
		await assert.rejects(() => h.call("vscode_debug_start", { name: "Run app" }), HostToolRefusal);
		assert.equal(h.api.started.length, 0);
		h.dispose();
	});

	it("starts nothing when the executor gate was lost during the confirmation", async () => {
		const h = createHarness();
		h.policy.start = "ask";
		let lost = false;
		h.policy.answer = async () => {
			lost = true;
			return true;
		};
		await assert.rejects(() => h.call("vscode_debug_start", { name: "Run app" }, { gateLost: () => lost }), GateLost);
		assert.equal(h.api.started.length, 0);
		h.dispose();
	});

	it("starts a Desk preset", async () => {
		const h = createHarness({
			presets: [{ id: "unity-attach", label: "Attach to Unity Editor", description: "Preset unity-attach attaches to the Editor.", available: () => true, build: () => ({ configuration: { name: "Attach to Unity Editor", type: "vstuc", request: "attach" } }) }],
		});
		const result = await h.call("vscode_debug_start", { preset: "unity-attach" });
		assert.equal(result.isError, undefined, text(result));
		assert.equal(h.api.started[0]!.configuration.type, "vstuc");
		assert.match(String(h.tool("vscode_debug_start").description), /unity-attach/);
		const missing = await h.call("vscode_debug_start", { preset: "nope" });
		assert.equal(missing.isError, true);
		h.dispose();
	});

	it("asks before starting a preset when the start setting is ask, and starts nothing when declined", async () => {
		const h = createHarness({
			presets: [{ id: "unity-attach", label: "Attach to Unity Editor", description: "Preset unity-attach attaches to the Editor.", available: () => true, build: () => ({ configuration: { name: "Attach to Unity Editor", type: "vstuc", request: "attach" } }) }],
		});
		h.policy.start = "ask";
		h.policy.answer = async () => false;
		const declined = await h.call("vscode_debug_start", { preset: "unity-attach" });
		assert.equal(declined.isError, true);
		assert.equal(h.policy.confirmations.length, 1);
		assert.equal(h.policy.confirmations[0]!.setting, "start");
		assert.match(h.policy.confirmations[0]!.lines.join("\n"), /preset "Attach to Unity Editor"/);
		assert.match(h.policy.confirmations[0]!.lines.join("\n"), /vstuc/);
		assert.equal(h.api.started.length, 0);
		h.policy.answer = async () => true;
		const allowed = await h.call("vscode_debug_start", { preset: "unity-attach" });
		assert.equal(allowed.isError, undefined, text(allowed));
		assert.equal(h.policy.confirmations.length, 2);
		assert.equal(h.api.started.length, 1);
		h.dispose();
	});

	it("serializes launches through one coordinator", async () => {
		const h = createHarness();
		const order: string[] = [];
		h.api.startBehavior = async (_folder, configuration) => {
			order.push(`begin ${String(configuration.name)}`);
			await sleep(30);
			h.api.startSession({ id: `s-${order.length}`, name: String(configuration.name), configuration });
			order.push(`end ${String(configuration.name)}`);
			return true;
		};
		h.api.launch.set("C:\\work\\app", { configurations: [{ name: "A", type: "node", request: "launch" }, { name: "B", type: "node", request: "launch" }], compounds: [] });
		await Promise.all([h.call("vscode_debug_start", { name: "A" }), h.call("vscode_debug_start", { name: "B" })]);
		assert.deepEqual(order, ["begin A", "end A", "begin B", "end B"]);
		h.dispose();
	});
});

describe("vscode_debug_wait", () => {
	it("returns at once when the session is already stopped (immediate stop before wait)", async () => {
		const h = createHarness();
		const id = await startGranted(h);
		h.api.stop(id, "breakpoint", 1);
		const result = await h.call("vscode_debug_wait", { sessionId: id });
		assert.equal((result.details as { outcome: string }).outcome, "stopped");
		assert.match(text(result), /breakpoint/);
		assert.match(text(result), /main/);
		h.dispose();
	});

	it("is not satisfied by a stop at or below the generation the agent passes", async () => {
		const h = createHarness();
		const id = await startGranted(h);
		h.api.stop(id);
		const first = await h.call("vscode_debug_wait", { sessionId: id });
		const generation = generationOf(first);
		const pending = h.call("vscode_debug_wait", { sessionId: id, afterGeneration: generation, timeoutSeconds: 1 });
		await sleep(30);
		h.api.stop(id, "step");
		const second = await pending;
		assert.equal((second.details as { outcome: string }).outcome, "stopped");
		assert.ok(generationOf(second) > generation);
		h.dispose();
	});

	it("ends when the session terminates during the wait", async () => {
		const h = createHarness();
		const id = await startGranted(h);
		const pending = h.call("vscode_debug_wait", { sessionId: id });
		await sleep(20);
		h.api.endSession(id);
		const result = await pending;
		assert.equal((result.details as { outcome: string }).outcome, "terminated");
		h.dispose();
	});

	it("times out with the state and generation to wait on again", async () => {
		const h = createHarness();
		const id = await startGranted(h);
		const result = await h.call("vscode_debug_wait", { sessionId: id, timeoutSeconds: 1 }, { updates: [] });
		assert.equal((result.details as { outcome: string }).outcome, "timeout");
		assert.match(text(result), /running/);
		h.dispose();
	});

	it("reports progress while waiting", async () => {
		const h = createHarness();
		const id = await startGranted(h);
		const updates: HostToolResult[] = [];
		const abort = new AbortController();
		const pending = h.call("vscode_debug_wait", { sessionId: id, timeoutSeconds: 60 }, { updates, signal: abort.signal });
		await sleep(150);
		abort.abort();
		const result = await pending;
		assert.equal(result.isError, true);
		assert.ok(updates.length >= 1);
		assert.match(text(updates[0]!), /Waiting/);
		h.dispose();
	});

	it("refuses an untracked session started before activation", async () => {
		const h = createHarness({ beforeCoordinator: api => { api.addPreexisting({ id: "old" }); } });
		const configs = await h.call("vscode_debug_configs", {});
		assert.match(text(configs), /untracked/);
		const result = await h.call("vscode_debug_wait", { sessionId: "old" });
		assert.equal(result.isError, true);
		assert.match(text(result), /not available/);
		const inspect = await h.call("vscode_debug_inspect", { sessionId: "old", what: "stack" });
		assert.equal(inspect.isError, true);
		h.dispose();
	});

	it("waiting on a launcher session covers its child sessions and names the one that stopped", async () => {
		const h = createHarness();
		const parent = await startGranted(h);
		const pending = h.call("vscode_debug_wait", { sessionId: parent, timeoutSeconds: 5 });
		await sleep(20);
		h.api.startSession({ id: "child", parentId: parent });
		h.api.stop("child");
		const result = await pending;
		assert.equal((result.details as { sessionId: string }).sessionId, "child");
		assert.match(text(result), /Child session child of /);
		// The launcher itself is not stopped, and says where the program runs.
		const refused = await h.call("vscode_debug_control", { sessionId: parent, action: "continue" });
		assert.equal(refused.isError, true);
		assert.match(text(refused), /child sessions that run the program: child \(stopped/);
		const control = await h.call("vscode_debug_control", { sessionId: "child", action: "continue" });
		assert.equal(control.isError, undefined, text(control));
		h.dispose();
	});

	it("can wait on a session the user started", async () => {
		const h = createHarness();
		h.api.startSession({ id: "mine-not" });
		h.api.stop("mine-not");
		const result = await h.call("vscode_debug_wait", { sessionId: "mine-not" });
		assert.equal((result.details as { outcome: string }).outcome, "stopped");
		h.dispose();
	});
});

describe("vscode_debug_control", () => {
	it("an adapter that never sends continued: a successful response means running, so a cached stop cannot satisfy the next wait", async () => {
		const h = createHarness();
		const id = await startGranted(h);
		h.api.stop(id);
		const control = await h.call("vscode_debug_control", { sessionId: id, action: "continue" });
		assert.equal(control.isError, undefined, text(control));
		assert.deepEqual(h.api.controls, [{ command: "continue", sessionId: id, threadId: 1 }]);
		assert.equal(h.parts.coordinator.session(id)!.state.kind, "running");
		const afterControl = generationOf(control);
		const wait = await h.call("vscode_debug_wait", { sessionId: id, afterGeneration: afterControl, timeoutSeconds: 1 });
		assert.equal((wait.details as { outcome: string }).outcome, "timeout");
		h.dispose();
	});

	it("a failed continue response restores the previous state", async () => {
		const h = createHarness();
		const id = await startGranted(h);
		h.api.stop(id);
		h.api.controlBehavior = async (command, sessionId, threadId) => {
			h.api.editorRequest(sessionId, { type: "request", seq: 900, command, arguments: { threadId } });
			h.api.adapterResponse(sessionId, { type: "response", seq: 901, request_seq: 900, command, success: false, message: "not stopped" });
		};
		await h.call("vscode_debug_control", { sessionId: id, action: "continue" });
		const view = h.parts.coordinator.session(id)!;
		assert.equal(view.state.kind, "stopped");
		h.dispose();
	});

	it("a rejected VS Code command restores the previous state and says so", async () => {
		const h = createHarness();
		const id = await startGranted(h);
		h.api.stop(id);
		h.api.controlBehavior = async () => { throw new Error("command failed"); };
		const result = await h.call("vscode_debug_control", { sessionId: id, action: "next" });
		assert.equal(result.isError, true);
		assert.match(text(result), /command failed/);
		assert.equal(h.parts.coordinator.session(id)!.state.kind, "stopped");
		h.dispose();
	});

	it("a stop that arrives before the step's response is not overwritten by it", async () => {
		const h = createHarness();
		const id = await startGranted(h);
		h.api.stop(id);
		h.api.controlBehavior = async (command, sessionId, threadId) => {
			h.api.editorRequest(sessionId, { type: "request", seq: 910, command, arguments: { threadId } });
			h.api.stop(sessionId, "step", threadId);
			h.api.adapterResponse(sessionId, { type: "response", seq: 911, request_seq: 910, command, success: true });
		};
		await h.call("vscode_debug_control", { sessionId: id, action: "next" });
		assert.equal(h.parts.coordinator.session(id)!.state.kind, "stopped");
		h.dispose();
	});

	it("a pause response is only an acknowledgement; the stop ends the transition", async () => {
		const h = createHarness();
		const id = await startGranted(h);
		const result = await h.call("vscode_debug_control", { sessionId: id, action: "pause", threadId: 1 });
		assert.equal(result.isError, undefined, text(result));
		assert.equal(h.parts.coordinator.session(id)!.state.kind, "transitioning");
		h.api.stop(id, "pause");
		assert.equal(h.parts.coordinator.session(id)!.state.kind, "stopped");
		h.dispose();
	});

	it("an unresolved transition leaves the state unknown after the timeout", async () => {
		const h = createHarness({ limits: { transitionTimeoutMs: 40 } });
		const id = await startGranted(h);
		h.api.stop(id);
		h.api.controlBehavior = async () => {};
		await h.call("vscode_debug_control", { sessionId: id, action: "continue" });
		assert.equal(h.parts.coordinator.session(id)!.state.kind, "transitioning");
		await sleep(80);
		assert.equal(h.parts.coordinator.session(id)!.state.kind, "unknown");
		h.api.stop(id);
		assert.equal(h.parts.coordinator.session(id)!.state.kind, "stopped");
		h.dispose();
	});

	it("serializes parallel controls: the second sees the first's effect and is refused", async () => {
		const h = createHarness();
		const id = await startGranted(h);
		h.api.stop(id);
		h.api.controlBehavior = async (command, sessionId, threadId) => {
			await sleep(30);
			h.api.editorRequest(sessionId, { type: "request", seq: 920, command, arguments: { threadId } });
			h.api.adapterResponse(sessionId, { type: "response", seq: 921, request_seq: 920, command, success: true });
		};
		const [a, b] = await Promise.all([
			h.call("vscode_debug_control", { sessionId: id, action: "next" }),
			h.call("vscode_debug_control", { sessionId: id, action: "stepIn" }),
		]);
		assert.equal(h.api.controls.length, 1);
		assert.equal([a, b].filter(result => result.isError).length, 1);
		assert.match(text([a, b].find(result => result.isError)!), /not stopped/);
		h.dispose();
	});

	it("refuses a thread that does not exist in the session (VS Code would fall back to the focused thread)", async () => {
		const h = createHarness();
		const id = await startGranted(h);
		h.api.stop(id);
		const result = await h.call("vscode_debug_control", { sessionId: id, action: "continue", threadId: 99 });
		assert.equal(result.isError, true);
		assert.match(text(result), /does not exist/);
		assert.equal(h.api.controls.length, 0);
		h.dispose();
	});

	it("passes the explicit session and thread to VS Code", async () => {
		const h = createHarness();
		const id = await startGranted(h);
		h.api.stop(id, "breakpoint", 1);
		await h.call("vscode_debug_control", { sessionId: id, action: "stepOut", threadId: 2 });
		assert.deepEqual(h.api.controls, [{ command: "stepOut", sessionId: id, threadId: 2 }]);
		h.dispose();
	});

	it("does not control sessions it did not start, sessions of other conversations or untracked sessions", async () => {
		const h = createHarness({ beforeCoordinator: api => { api.addPreexisting({ id: "old" }); } });
		h.api.startSession({ id: "user-session" });
		h.api.stop("user-session");
		const mine = await startGranted(h, "conv-1");
		h.api.stop(mine);
		for (const [id, conversation] of [["user-session", "conv-1"], [mine, "conv-2"], ["old", "conv-1"]] as const) {
			const result = await h.call("vscode_debug_control", { sessionId: id, action: "continue" }, { conversationId: conversation });
			assert.equal(result.isError, true, `${id} as ${conversation}`);
		}
		assert.equal(h.api.controls.length, 0);
		h.dispose();
	});

	it("stops a session it started through debug.stopDebugging with that session", async () => {
		const h = createHarness();
		const id = await startGranted(h);
		const result = await h.call("vscode_debug_control", { sessionId: id, action: "stop" });
		assert.equal(result.isError, undefined, text(result));
		assert.deepEqual(h.api.stopped, [id]);
		assert.equal(h.parts.coordinator.session(id)!.state.kind, "terminated");
		h.dispose();
	});

	it("a queued control whose call was cancelled never runs", async () => {
		const h = createHarness();
		const id = await startGranted(h);
		h.api.stop(id);
		let release!: () => void;
		h.api.controlBehavior = async (command, sessionId, threadId) => {
			await new Promise<void>(resolve => { release = resolve; });
			h.api.editorRequest(sessionId, { type: "request", seq: 930, command, arguments: { threadId } });
			h.api.adapterResponse(sessionId, { type: "response", seq: 931, request_seq: 930, command, success: true });
		};
		const first = h.call("vscode_debug_control", { sessionId: id, action: "next" });
		await sleep(20);
		const abort = new AbortController();
		const second = h.call("vscode_debug_control", { sessionId: id, action: "continue" }, { signal: abort.signal });
		await sleep(10);
		abort.abort();
		release();
		await first;
		const result = await second;
		assert.equal(result.isError, true);
		assert.equal(h.api.controls.length, 1);
		h.dispose();
	});

	it("an executor gate lost while the control was queued stops it before dispatch", async () => {
		const h = createHarness();
		const id = await startGranted(h);
		h.api.stop(id);
		let lost = false;
		const call = h.call("vscode_debug_control", { sessionId: id, action: "continue" }, { gateLost: () => lost });
		lost = true;
		await assert.rejects(call, GateLost);
		assert.equal(h.api.controls.length, 0);
		h.dispose();
	});
});

describe("vscode_debug_inspect", () => {
	it("returns the stack with generation-bearing frame references and says when a source is not available", async () => {
		const h = createHarness();
		const id = await startGranted(h);
		h.api.stop(id);
		const result = await h.call("vscode_debug_inspect", { sessionId: id, what: "stack" });
		assert.equal(result.isError, undefined, text(result));
		assert.match(text(result), /main at C:\\work\\app\\main\.js:3/);
		assert.match(text(result), /lib at \(source not available\)/);
		assert.match(text(result), /\[frame g\d+:f1000\]/);
		h.dispose();
	});

	it("walks scopes and variables, and a reference from an older stop fails", async () => {
		const h = createHarness();
		const id = await startGranted(h);
		h.api.stop(id);
		const stack = await h.call("vscode_debug_inspect", { sessionId: id, what: "stack" });
		const frameRef = /\[frame (g\d+:f\d+)\]/.exec(text(stack))![1]!;
		const scopes = await h.call("vscode_debug_inspect", { sessionId: id, what: "scopes", frameRef });
		const varRef = /\[variables (g\d+:v\d+)\]/.exec(text(scopes))![1]!;
		const variables = await h.call("vscode_debug_inspect", { sessionId: id, what: "variables", ref: varRef });
		assert.match(text(variables), /x: 1 \(number\)/);
		// The program runs and stops again: the old reference belongs to a stopped generation that is gone.
		h.api.stop(id, "step");
		const stale = await h.call("vscode_debug_inspect", { sessionId: id, what: "variables", ref: varRef });
		assert.equal(stale.isError, true);
		assert.match(text(stale), /ran since/);
		const staleFrame = await h.call("vscode_debug_inspect", { sessionId: id, what: "scopes", frameRef });
		assert.equal(staleFrame.isError, true);
		h.dispose();
	});

	it("rejects a reply that arrives after the program ran, never relabelling it", async () => {
		const h = createHarness();
		const id = await startGranted(h);
		h.api.stop(id);
		let resolveStack!: () => void;
		h.api.onRequest("stackTrace", () => new Promise(resolve => { resolveStack = () => resolve({ stackFrames: [{ id: 1, name: "old", line: 1, source: { path: "C:\\x.js" } }], totalFrames: 1 }); }));
		const pending = h.call("vscode_debug_inspect", { sessionId: id, what: "stack" });
		await sleep(20);
		h.api.adapterEvent(id, "continued", { threadId: 1 });
		resolveStack();
		const result = await pending;
		assert.equal(result.isError, true);
		assert.match(text(result), /ran since/);
		h.dispose();
	});

	it("refuses stack reads while the program runs", async () => {
		const h = createHarness();
		const id = await startGranted(h);
		const result = await h.call("vscode_debug_inspect", { sessionId: id, what: "stack" });
		assert.equal(result.isError, true);
		assert.match(text(result), /not stopped/);
		h.dispose();
	});

	it("lists threads even while running, marking the stopped one", async () => {
		const h = createHarness();
		const id = await startGranted(h);
		const running = await h.call("vscode_debug_inspect", { sessionId: id, what: "threads" });
		assert.equal(running.isError, undefined, text(running));
		h.api.stop(id, "breakpoint", 2);
		const stopped = await h.call("vscode_debug_inspect", { sessionId: id, what: "threads" });
		assert.match(text(stopped), /\* 2/);
		h.dispose();
	});

	it("times out an adapter that never answers and says the request may still take effect", async () => {
		const h = createHarness({ limits: { requestTimeoutMs: 40 } });
		const id = await startGranted(h);
		h.api.stop(id);
		h.api.onRequest("stackTrace", () => new Promise(() => {}));
		const result = await h.call("vscode_debug_inspect", { sessionId: id, what: "stack" });
		assert.equal(result.isError, true);
		assert.match(text(result), /may still take effect/);
		h.dispose();
	});

	it("maps an adapter that does not implement a request to 'not supported by this debugger'", async () => {
		const h = createHarness();
		const id = await startGranted(h);
		h.api.stop(id);
		h.api.onRequest("scopes", () => { throw new Error("Unrecognized request: scopes"); });
		const result = await h.call("vscode_debug_inspect", { sessionId: id, what: "scopes", frameRef: `g${h.parts.coordinator.session(id)!.generation}:f1` });
		assert.equal(result.isError, true);
		assert.match(text(result), /not supported by this debugger \(node\)/);
		h.dispose();
	});

	it("bounds variable expansion by requests and says the result is partial", async () => {
		const h = createHarness();
		const id = await startGranted(h);
		h.api.stop(id);
		h.api.onRequest("variables", () => ({ variables: Array.from({ length: 30 }, (_unused, index) => ({ name: `child${index}`, value: "{...}", variablesReference: 100 + index })) }));
		const generation = h.parts.coordinator.session(id)!.generation;
		const result = await h.call("vscode_debug_inspect", { sessionId: id, what: "variables", ref: `g${generation}:v1`, depth: 2, count: 30 });
		assert.equal(result.isError, undefined, text(result));
		assert.match(text(result), /partial/);
		assert.ok(h.api.requests.filter(request => request.command === "variables").length <= 24);
		h.dispose();
	});
});

describe("vscode_debug_inspect evaluate", () => {
	it("needs the session grant", async () => {
		const h = createHarness();
		h.api.startSession({ id: "user-session" });
		h.api.stop("user-session");
		const result = await h.call("vscode_debug_inspect", { sessionId: "user-session", what: "evaluate", expression: "1+1" });
		assert.equal(result.isError, true);
		assert.equal(h.api.requests.filter(request => request.command === "evaluate").length, 0);
		h.dispose();
	});

	it("is refused when expressions are off and runs without a prompt when allowed", async () => {
		const h = createHarness();
		const id = await startGranted(h);
		h.api.stop(id);
		h.policy.expressions = "off";
		const refused = await h.call("vscode_debug_inspect", { sessionId: id, what: "evaluate", expression: "1+1" });
		assert.equal(refused.isError, true);
		h.policy.expressions = "allow";
		const allowed = await h.call("vscode_debug_inspect", { sessionId: id, what: "evaluate", expression: "1+1" });
		assert.equal(allowed.isError, undefined, text(allowed));
		assert.match(text(allowed), /evaluated 1\+1/);
		assert.equal(h.policy.confirmations.length, 0);
		h.dispose();
	});

	it("asks with the debug session and the exact expression, and honours a refusal", async () => {
		const h = createHarness();
		const id = await startGranted(h);
		h.api.stop(id);
		h.policy.expressions = "ask";
		h.policy.answer = async () => false;
		const result = await h.call("vscode_debug_inspect", { sessionId: id, what: "evaluate", expression: "process.exit(1)" });
		assert.equal(result.isError, true);
		assert.match(h.policy.confirmations[0]!.lines.join("\n"), /Expression: process\.exit\(1\)/);
		assert.match(h.policy.confirmations[0]!.lines.join("\n"), new RegExp(id));
		assert.equal(h.api.requests.filter(request => request.command === "evaluate").length, 0);
		h.dispose();
	});

	it("refuses to evaluate when the user continued the program during the confirmation", async () => {
		const h = createHarness();
		const id = await startGranted(h);
		h.api.stop(id);
		h.policy.expressions = "ask";
		h.policy.answer = async () => {
			// The user presses Continue in the UI while the dialog is open: the tracker sees the request and a response.
			h.api.editorRequest(id, { type: "request", seq: 940, command: "continue", arguments: { threadId: 1 } });
			h.api.adapterResponse(id, { type: "response", seq: 941, request_seq: 940, command: "continue", success: true });
			return true;
		};
		const result = await h.call("vscode_debug_inspect", { sessionId: id, what: "evaluate", expression: "x" });
		assert.equal(result.isError, true);
		assert.match(text(result), /ran since/);
		assert.equal(h.api.requests.filter(request => request.command === "evaluate").length, 0);
		h.dispose();
	});
});

describe("vscode_debug_breakpoints", () => {
	it("adds, lists with per-session states, and removes only its own breakpoints", async () => {
		const h = createHarness();
		const id = await startGranted(h);
		const userBreakpoint = h.api.addUserBreakpoint("C:\\work\\app\\main.js", 9);
		const added = await h.call("vscode_debug_breakpoints", { action: "add", file: "C:\\work\\app\\main.js", line: 3 });
		assert.equal(added.isError, undefined, text(added));
		const mine = (added.details as { id: string }).id;
		h.api.setProtocolBreakpoint(id, mine, { verified: false, message: "Assembly not loaded" });
		const listed = await h.call("vscode_debug_breakpoints", { action: "list" });
		assert.match(text(listed), new RegExp(`${mine}.*owner: this conversation.*unverified \\(Assembly not loaded\\)`));
		assert.match(text(listed), new RegExp(`${userBreakpoint}.*owner: user`));
		const refusal = await h.call("vscode_debug_breakpoints", { action: "remove", id: userBreakpoint });
		assert.equal(refusal.isError, true);
		const removed = await h.call("vscode_debug_breakpoints", { action: "remove", id: mine });
		assert.equal(removed.isError, undefined, text(removed));
		assert.ok(h.api.breakpoints().some(breakpoint => breakpoint.id === userBreakpoint));
		assert.ok(!h.api.breakpoints().some(breakpoint => breakpoint.id === mine));
		h.dispose();
	});

	it("converts hitCount to a decimal hit condition and runs no expression", async () => {
		const h = createHarness();
		h.policy.expressions = "off";
		const result = await h.call("vscode_debug_breakpoints", { action: "add", file: "C:\\work\\app\\main.js", line: 4, hitCount: 3 });
		assert.equal(result.isError, undefined, text(result));
		assert.equal(h.api.breakpoints()[0]!.hitCondition, "3");
		const bad = await h.call("vscode_debug_breakpoints", { action: "add", file: "C:\\work\\app\\main.js", line: 5, hitCount: 0 });
		assert.equal(bad.isError, true);
		h.dispose();
	});

	it("treats conditions and log messages as expressions: off refuses, ask shows them, allow adds", async () => {
		const h = createHarness();
		h.policy.expressions = "off";
		const off = await h.call("vscode_debug_breakpoints", { action: "add", file: "C:\\work\\app\\main.js", line: 6, condition: "x > 1" });
		assert.equal(off.isError, true);
		h.policy.expressions = "ask";
		const asked = await h.call("vscode_debug_breakpoints", { action: "add", file: "C:\\work\\app\\main.js", line: 6, condition: "x > 1", logMessage: "x={x}" });
		assert.equal(asked.isError, undefined, text(asked));
		assert.match(h.policy.confirmations[0]!.lines.join("\n"), /Condition: x > 1/);
		assert.match(h.policy.confirmations[0]!.lines.join("\n"), /Log message: x=\{x\}/);
		assert.equal(h.api.breakpoints()[0]!.condition, "x > 1");
		h.dispose();
	});

	it("refuses a condition when every live session's adapter lacks the capability", async () => {
		const h = createHarness({ beforeCoordinator: () => {} });
		h.api.capabilities = {};
		await startGranted(h);
		const result = await h.call("vscode_debug_breakpoints", { action: "add", file: "C:\\work\\app\\main.js", line: 7, condition: "x" });
		assert.equal(result.isError, true);
		assert.match(text(result), /not supported by this debugger \(node\)/);
		h.dispose();
	});

	it("clear removes only this conversation's breakpoints", async () => {
		const h = createHarness();
		const userBreakpoint = h.api.addUserBreakpoint("C:\\work\\app\\main.js", 1);
		await h.call("vscode_debug_breakpoints", { action: "add", file: "C:\\work\\app\\main.js", line: 2 }, { conversationId: "conv-1" });
		await h.call("vscode_debug_breakpoints", { action: "add", file: "C:\\work\\app\\main.js", line: 3 }, { conversationId: "conv-2" });
		const cleared = await h.call("vscode_debug_breakpoints", { action: "clear" }, { conversationId: "conv-1" });
		assert.equal((cleared.details as { removed: number }).removed, 1);
		const lines = h.api.breakpoints().map(breakpoint => breakpoint.line).sort();
		assert.deepEqual(lines, [1, 3]);
		assert.ok(h.api.breakpoints().some(breakpoint => breakpoint.id === userBreakpoint));
		h.dispose();
	});

	it("refuses a path that is not an existing file and never changes an existing breakpoint", async () => {
		const h = createHarness();
		const missing = await h.call("vscode_debug_breakpoints", { action: "add", file: "C:\\nope.js", line: 1 });
		assert.equal(missing.isError, true);
		h.api.addUserBreakpoint("C:\\work\\app\\main.js", 8);
		const duplicate = await h.call("vscode_debug_breakpoints", { action: "add", file: "C:\\work\\app\\main.js", line: 8 });
		assert.equal(duplicate.isError, true);
		assert.match(text(duplicate), /already exists/);
		h.dispose();
	});

	it("drops ownership when the user removes the breakpoint in the UI", async () => {
		const h = createHarness();
		const added = await h.call("vscode_debug_breakpoints", { action: "add", file: "C:\\work\\app\\main.js", line: 2 });
		const id = (added.details as { id: string }).id;
		h.api.removeBreakpoints([id]);
		assert.equal(h.parts.coordinator.owner(id), undefined);
		h.dispose();
	});
});

describe("breakpoint ownership across debug-session loss and window reload", () => {
	const FILE = "C:\\work\\app\\main.js";

	it("keeps ownership when the debug session ends (Unity domain reload): list names the owner and clear removes them", async () => {
		const h = createHarness();
		const session = await startGranted(h);
		const user = h.api.addUserBreakpoint(FILE, 9);
		const added = await h.call("vscode_debug_breakpoints", { action: "add", file: FILE, line: 2 });
		const mine = (added.details as { id: string }).id;
		h.api.endSession(session);
		const listed = text(await h.call("vscode_debug_breakpoints", { action: "list" }));
		assert.match(listed, new RegExp(`${mine}.*owner: this conversation`));
		assert.match(listed, new RegExp(`${user}.*owner: user`));
		const cleared = await h.call("vscode_debug_breakpoints", { action: "clear" });
		assert.equal((cleared.details as { removed: number }).removed, 1);
		assert.deepEqual(h.api.breakpoints().map(breakpoint => breakpoint.id), [user]);
		h.dispose();
	});

	it("keeps ownership across an extension-host restart: VS Code keeps the breakpoint ids, the saved owners cover them", async () => {
		const store = new MemoryOwnershipStore();
		const before = createHarness({ ownershipStore: store });
		const user = before.api.addUserBreakpoint(FILE, 9);
		const mine = ((await before.call("vscode_debug_breakpoints", { action: "add", file: FILE, line: 2 })).details as { id: string }).id;
		const theirs = ((await before.call("vscode_debug_breakpoints", { action: "add", file: FILE, line: 4 }, { conversationId: "conv-2" })).details as { id: string }).id;
		before.dispose();

		const after = createHarness({ api: before.api, ownershipStore: store });
		assert.equal(after.parts.coordinator.owner(mine), "conv-1");
		const listed = text(await after.call("vscode_debug_breakpoints", { action: "list" }));
		assert.match(listed, new RegExp(`${mine}.*owner: this conversation`));
		assert.match(listed, new RegExp(`${theirs}.*owner: another conversation`));
		assert.match(listed, new RegExp(`${user}.*owner: user`));
		const cleared = await after.call("vscode_debug_breakpoints", { action: "clear" });
		assert.equal((cleared.details as { removed: number }).removed, 1);
		assert.deepEqual(after.api.breakpoints().map(breakpoint => breakpoint.id).sort(), [user, theirs].sort());
		after.dispose();
	});

	it("does not hand a breakpoint the user deleted and created again at the same place to the agent", async () => {
		const store = new MemoryOwnershipStore();
		const h = createHarness({ ownershipStore: store });
		const mine = ((await h.call("vscode_debug_breakpoints", { action: "add", file: FILE, line: 2 })).details as { id: string }).id;
		// While Desk watches: delete, then create again with the same content.
		h.api.removeBreakpoints([mine]);
		const again = h.api.addUserBreakpoint(FILE, 2);
		assert.notEqual(again, mine);
		assert.equal(h.parts.coordinator.owner(again), undefined);
		const removal = await h.call("vscode_debug_breakpoints", { action: "remove", id: again });
		assert.equal(removal.isError, true);
		assert.match(text(removal), /owner: user/);
		const cleared = await h.call("vscode_debug_breakpoints", { action: "clear" });
		assert.equal((cleared.details as { removed: number }).removed, 0);
		assert.ok(h.api.breakpoints().some(breakpoint => breakpoint.id === again));
		h.dispose();
	});

	it("does not transfer ownership to an equal breakpoint that appears while the host is down, and forgets the vanished one", async () => {
		const store = new MemoryOwnershipStore();
		const before = createHarness({ ownershipStore: store });
		const mine = ((await before.call("vscode_debug_breakpoints", { action: "add", file: FILE, line: 2 })).details as { id: string }).id;
		before.dispose();
		// The user deletes it and sets an equal one while no Desk coordinator listens.
		before.api.removeBreakpoints([mine]);
		const again = before.api.addUserBreakpoint(FILE, 2);

		const after = createHarness({ api: before.api, ownershipStore: store });
		const listed = text(await after.call("vscode_debug_breakpoints", { action: "list" }));
		assert.match(listed, new RegExp(`${again}.*owner: user`));
		const cleared = await after.call("vscode_debug_breakpoints", { action: "clear" });
		assert.equal((cleared.details as { removed: number }).removed, 0);
		assert.ok(after.api.breakpoints().some(breakpoint => breakpoint.id === again));
		// The next claim drops the saved record of the breakpoint that no longer exists.
		await after.call("vscode_debug_breakpoints", { action: "add", file: FILE, line: 6 });
		assert.ok(!Object.keys(store.saved as Record<string, string>).includes(mine));
		after.dispose();
	});

	it("does not carry ownership over a remove and re-add of equal content in one VS Code change", async () => {
		const h = createHarness();
		const mine = ((await h.call("vscode_debug_breakpoints", { action: "add", file: FILE, line: 2 })).details as { id: string }).id;
		const removed = h.api.breakpoints().filter(breakpoint => breakpoint.id === mine);
		h.api.replaceBreakpoints(removed, [{ kind: "source", path: FILE, line: 2, enabled: true }]);
		const replacement = h.api.breakpoints().find(breakpoint => breakpoint.id !== mine)!;
		assert.equal(h.parts.coordinator.owner(replacement.id), undefined);
		assert.equal(h.parts.coordinator.owner(mine), undefined);
		h.dispose();
	});

	it("a handoff passes the conversation's breakpoints to the user for good, also across a restart, and names them", async () => {
		const store = new MemoryOwnershipStore();
		const h = createHarness({ ownershipStore: store });
		const session = await startGranted(h);
		const first = ((await h.call("vscode_debug_breakpoints", { action: "add", file: FILE, line: 3 })).details as { id: string }).id;
		const second = ((await h.call("vscode_debug_breakpoints", { action: "add", file: FILE, line: 5 })).details as { id: string }).id;
		h.api.stop(session);
		const result = await h.call("vscode_debug_handoff", { sessionId: session, message: "look" });
		assert.equal(result.isError, undefined, text(result));
		assert.match(text(result), /2 breakpoint\(s\) passed to the user and you can no longer remove them/);
		assert.match(text(result), new RegExp(`main\\.js:3 \\(${first}\\)`));
		assert.match(text(result), new RegExp(`main\\.js:5 \\(${second}\\)`));
		assert.deepEqual((result.details as { passedBreakpoints: string[] }).passedBreakpoints.length, 2);
		h.dispose();

		const after = createHarness({ api: h.api, ownershipStore: store });
		assert.equal(after.parts.coordinator.owner(first), undefined);
		const removal = await after.call("vscode_debug_breakpoints", { action: "remove", id: first });
		assert.equal(removal.isError, true);
		assert.match(text(removal), /handed off a session/);
		assert.match(text(removal), /Ask the user/);
		after.dispose();
	});

	it("tells a conversation with no breakpoints that none passed at handoff, and why clear found nothing", async () => {
		const h = createHarness();
		const session = await startGranted(h);
		h.api.addUserBreakpoint(FILE, 9);
		h.api.stop(session);
		const result = await h.call("vscode_debug_handoff", { sessionId: session, message: "look" });
		assert.match(text(result), /no breakpoints set, so none passed/);
		const cleared = await h.call("vscode_debug_breakpoints", { action: "clear" });
		assert.match(text(cleared), /no breakpoints to remove.*1 breakpoint\(s\) in the window are the user's or another conversation's/);
		h.dispose();
	});

	it("ignores a saved record that is not a map of conversation ids", async () => {
		for (const saved of ["garbage", 7, ["a"], { bp1: 3, "": "conv-1", bp2: "" }]) {
			const store = new MemoryOwnershipStore();
			store.saved = saved;
			const h = createHarness({ ownershipStore: store });
			assert.deepEqual(h.parts.coordinator.ownedBreakpoints("conv-1"), []);
			h.dispose();
		}
	});
});

describe("vscode_debug_handoff", () => {
	it("reveals the stopped frame, shows Run and Debug, notifies, and revokes control and breakpoint ownership", async () => {
		const h = createHarness();
		const id = await startGranted(h);
		const added = await h.call("vscode_debug_breakpoints", { action: "add", file: "C:\\work\\app\\main.js", line: 3 });
		const breakpointId = (added.details as { id: string }).id;
		h.api.stop(id);
		const result = await h.call("vscode_debug_handoff", { sessionId: id, message: "x is wrong here" });
		assert.equal(result.isError, undefined, text(result));
		assert.deepEqual(h.api.revealed, [{ path: "C:\\work\\app\\main.js", line: 3 }]);
		assert.equal(h.api.runAndDebugShown, 1);
		assert.deepEqual(h.api.notifications, ["x is wrong here"]);
		// The grant is gone terminally; reads stay allowed; the breakpoint is the user's now.
		const control = await h.call("vscode_debug_control", { sessionId: id, action: "continue" });
		assert.equal(control.isError, true);
		assert.match(text(control), /handed off/);
		const inspect = await h.call("vscode_debug_inspect", { sessionId: id, what: "stack" });
		assert.equal(inspect.isError, undefined, text(inspect));
		const removal = await h.call("vscode_debug_breakpoints", { action: "remove", id: breakpointId });
		assert.equal(removal.isError, true);
		assert.ok(h.api.breakpoints().some(breakpoint => breakpoint.id === breakpointId));
		h.dispose();
	});

	it("hands off a session tree: children of a Desk-started session share the grant and lose it together", async () => {
		const h = createHarness();
		const parent = await startGranted(h);
		h.api.startSession({ id: "child", parentId: parent });
		assert.equal(h.parts.coordinator.canControl("child", "conv-1"), true);
		h.api.stop("child");
		await h.call("vscode_debug_handoff", { sessionId: "child", message: "look" });
		assert.equal(h.parts.coordinator.canControl("child", "conv-1"), false);
		assert.equal(h.parts.coordinator.canControl(parent, "conv-1"), false);
		h.api.startSession({ id: "child2", parentId: parent });
		assert.equal(h.parts.coordinator.canControl("child2", "conv-1"), false);
		h.dispose();
	});

	it("refuses to hand off a session the conversation did not start", async () => {
		const h = createHarness();
		h.api.startSession({ id: "user-session" });
		const result = await h.call("vscode_debug_handoff", { sessionId: "user-session", message: "hi" });
		assert.equal(result.isError, true);
		assert.equal(h.api.notifications.length, 0);
		h.dispose();
	});
});

describe("vscode_debug_inspect stack paging", () => {
	/** An adapter that ignores startFrame and levels, as vstuc does: it always returns the whole stack. */
	function wholeStackAdapter(h: Harness, total: number): void {
		h.api.onRequest("stackTrace", () => ({ stackFrames: Array.from({ length: total }, (_, index) => ({ id: 100 + index, name: `frame${index}`, source: { path: "C:\\work\\app\\main.js" }, line: index + 1 })), totalFrames: total }));
	}

	it("bounds the frames by levels even when the adapter returns the whole stack", async () => {
		const h = createHarness();
		const id = await startGranted(h);
		h.api.stop(id);
		wholeStackAdapter(h, 44);
		const one = await h.call("vscode_debug_inspect", { sessionId: id, what: "stack", levels: 1 });
		assert.match(text(one), /frames 0-0 of 44/);
		assert.equal((one.details as { frames: unknown[] }).frames.length, 1);
		assert.match(text(one), /startFrame=1/);
		const five = await h.call("vscode_debug_inspect", { sessionId: id, what: "stack", levels: 5 });
		assert.match(text(five), /frames 0-4 of 44/);
		assert.equal((five.details as { frames: unknown[] }).frames.length, 5);
		h.dispose();
	});

	it("defaults to 20 frames and pages with startFrame against an adapter that ignores both", async () => {
		const h = createHarness();
		const id = await startGranted(h);
		h.api.stop(id);
		wholeStackAdapter(h, 44);
		const first = await h.call("vscode_debug_inspect", { sessionId: id, what: "stack" });
		assert.match(text(first), /frames 0-19 of 44/);
		assert.match(text(first), /24 more frame\(s\); call again with startFrame=20/);
		const second = await h.call("vscode_debug_inspect", { sessionId: id, what: "stack", startFrame: 20 });
		assert.match(text(second), /frames 20-39 of 44/);
		assert.match(text(second), /#20 frame20 /);
		const last = await h.call("vscode_debug_inspect", { sessionId: id, what: "stack", startFrame: 40 });
		assert.match(text(last), /frames 40-43 of 44/);
		assert.doesNotMatch(text(last), /more frame/);
		h.dispose();
	});

	it("keeps an adapter's own paging: frames it returns for startFrame are not sliced again", async () => {
		const h = createHarness();
		const id = await startGranted(h);
		h.api.stop(id);
		h.api.onRequest("stackTrace", args => {
			const start = (args as { startFrame: number }).startFrame;
			return { stackFrames: [0, 1].map(offset => ({ id: 100 + start + offset, name: `f${start + offset}`, source: { path: "C:\\a.js" }, line: 1 })), totalFrames: 44 };
		});
		const page = await h.call("vscode_debug_inspect", { sessionId: id, what: "stack", startFrame: 10, levels: 2 });
		assert.match(text(page), /frames 10-11 of 44/);
		assert.match(text(page), /#10 f10 /);
		h.dispose();
	});
});

describe("adapter failures and generations", () => {
	it("names the last adapter error when a wait ends and in the session list", async () => {
		const h = createHarness();
		const id = await startGranted(h);
		h.api.trackers.get(id)!.error!(new Error("read error"));
		h.api.trackers.get(id)!.error!(new Error("write EPIPE"));
		const configs = await h.call("vscode_debug_configs", {});
		assert.match(text(configs), /last adapter error: write EPIPE/);
		h.api.endSession(id);
		const wait = await h.call("vscode_debug_wait", { sessionId: id, timeoutSeconds: 1 });
		assert.equal((wait.details as { outcome: string }).outcome, "terminated");
		assert.match(text(wait), /ended \(generation \d+\)\. The last adapter error was: write EPIPE\./);
		assert.equal((wait.details as { adapterError: string }).adapterError, "write EPIPE");
		h.dispose();
	});

	it("a session that ended without an adapter error says nothing about one", async () => {
		const h = createHarness();
		const id = await startGranted(h);
		h.api.endSession(id);
		const wait = await h.call("vscode_debug_wait", { sessionId: id, timeoutSeconds: 1 });
		assert.doesNotMatch(text(wait), /adapter error/);
		h.dispose();
	});

	it("the control result says the next stop has a higher generation, not necessarily the next number", async () => {
		const h = createHarness();
		const id = await startGranted(h);
		h.api.stop(id);
		const control = await h.call("vscode_debug_control", { sessionId: id, action: "next" });
		assert.match(text(control), new RegExp(`afterGeneration=${generationOf(control)}\\. .*higher generation than ${generationOf(control)}`));
		h.dispose();
	});
});

describe("vscode_debug_configs", () => {
	it("lists configurations per folder, marks compounds unsupported, and shows sessions with origin and state", async () => {
		const h = createHarness();
		h.api.startSession({ id: "user-session", name: "Other" });
		const mine = await startGranted(h);
		h.api.stop(mine);
		const result = await h.call("vscode_debug_configs", {});
		const out = text(result);
		assert.match(out, /Run app\s+\[node launch, program/);
		assert.match(out, /Both\s+\[compound: not supported/);
		assert.match(out, /user-session.*started by the user.*running/);
		assert.match(out, new RegExp(`${mine}.*started by this conversation.*stopped \\(breakpoint`));
		h.dispose();
	});
});

describe("provider and settings", () => {
	it("offers no tools while disabled and the seven tools while enabled", () => {
		const h = createHarness();
		const names = h.parts.provider.tools().map(tool => tool.name);
		assert.deepEqual(names, ["vscode_debug_configs", "vscode_debug_breakpoints", "vscode_debug_start", "vscode_debug_wait", "vscode_debug_inspect", "vscode_debug_control", "vscode_debug_handoff"]);
		assert.ok(h.parts.provider.tools().every(tool => tool.loadMode === "discoverable"));
		h.policy.isEnabled = false;
		assert.deepEqual(h.parts.provider.tools(), []);
		h.dispose();
	});

	it("fires changed on request and stops after dispose", () => {
		const h = createHarness();
		let count = 0;
		const subscription = h.parts.provider.changed(() => { count += 1; });
		h.parts.fireChanged();
		subscription.dispose();
		h.parts.fireChanged();
		assert.equal(count, 1);
		h.dispose();
	});

	it("a tool selected before the setting was switched off is refused at execution", async () => {
		const h = createHarness();
		h.policy.isEnabled = false;
		await assert.rejects(() => h.call("vscode_debug_configs", {}), /disabled/);
		h.dispose();
	});

	it("rejects malformed arguments with an error result", async () => {
		const h = createHarness();
		const result = await h.call("vscode_debug_wait", { sessionId: 5 });
		assert.equal(result.isError, true);
		const missing = await h.call("vscode_debug_control", { sessionId: "x" });
		assert.equal(missing.isError, true);
		h.dispose();
	});
});
