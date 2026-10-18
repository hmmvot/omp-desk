/**
 * OMP's bundled `/review` over the session, as the installed OMP 18.11.1 speaks it (frames captured from a real
 * `omp --mode rpc-ui` on a scratch repository): the command is advertised as a `custom` command, runs inside the
 * `prompt` command, asks through `extension_ui_request` dialogs (`select`, `input`, `editor`) with `setStatus` and
 * `notify` lines, acknowledges the prompt only when it returns, and then either starts a turn or ends with
 * `prompt_result` `agentInvoked: false`. Runner: `node --test src/host/rpc/session-review-command.test.ts`.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { FakeRpcChannel, responseLine } from "./fake-channel.ts";
import { RpcSession, type RpcSessionOutput } from "./session.ts";
import { ManualTimers, tick } from "./test-support.ts";

const sessions: RpcSession[] = [];
afterEach(() => {
	for (const session of sessions.splice(0)) session.dispose();
});

const REVIEW_MODE = {
	type: "extension_ui_request",
	id: "15aaf4270852ee70",
	method: "select",
	title: "Review Mode",
	options: ["1. Review against a base branch (PR Style)", "2. Review uncommitted changes", "3. Review a specific commit", "4. Review a specific PR", "5. Custom review instructions"],
};

async function boot() {
	const channel = new FakeRpcChannel({ sessionFile: null });
	channel.handlers.set("get_available_commands", () => ({ data: { commands: [{ name: "review", description: "Launch interactive code review", input: { hint: "arguments" }, source: "custom" }] } }));
	const timers = new ManualTimers();
	const session = new RpcSession({ channel, sessionFile: null, cwd: "D:\\scratch", hostNonce: "host-a", timers, fileExists: async () => true, watchdogIntervalMs: 60 * 60_000 });
	sessions.push(session);
	const outputs: RpcSessionOutput[] = [];
	session.subscribe(output => outputs.push(output));
	await session.start();
	await tick();
	// OMP holds the `prompt` acknowledgement until the command has returned.
	channel.handlers.set("prompt", () => "drop");
	return { channel, session, outputs };
}

describe("/review", () => {
	it("is advertised as the session's own command and is sent to OMP as a prompt, not refused", async () => {
		const { channel, session } = await boot();
		assert.deepEqual(session.model.commands.map(command => [command.name, command.source, command.inputHint]), [["review", "custom", "arguments"]]);
		const outcome = session.prompt({ requestId: "r1", text: "/review" });
		await tick();
		assert.deepEqual(channel.commandsOfType("prompt").map(command => command.message), ["/review"]);
		channel.emit(responseLine("vsc:r1", "prompt", true, {}));
		assert.deepEqual(await outcome, { status: "accepted", agentInvoked: null });
	});

	it("shows the Review Mode select, answers it with the chosen label, and the review prompt becomes the turn", async () => {
		const { channel, session, outputs } = await boot();
		void session.prompt({ requestId: "r2", text: "/review" });
		await tick();
		channel.emit(REVIEW_MODE);
		await tick();
		const request = session.model.uiRequest;
		assert.ok(request !== null && request.method === "select");
		assert.equal(request.title, "Review Mode");
		assert.equal(request.options.length, 5);
		assert.ok(outputs.some(output => output.type === "ui-request" && output.request.id === REVIEW_MODE.id));

		assert.equal(await session.respondUi({ id: REVIEW_MODE.id, value: REVIEW_MODE.options[1]! }), true);
		assert.deepEqual(channel.written.at(-1), { type: "extension_ui_response", id: REVIEW_MODE.id, value: "2. Review uncommitted changes" });
		assert.equal(session.model.uiRequest, null);
		channel.emit(responseLine("vsc:r2", "prompt", true, {}));
		channel.emit({ type: "agent_start" });
		await tick();
		assert.equal(session.model.working, true, "the review prompt starts the turn");
	});

	it("takes a branch list and a commit list as selects of their own, one after the other", async () => {
		const { channel, session } = await boot();
		void session.prompt({ requestId: "r3", text: "/review" });
		await tick();
		channel.emit(REVIEW_MODE);
		await tick();
		await session.respondUi({ id: REVIEW_MODE.id, value: REVIEW_MODE.options[0]! });
		channel.emit({ type: "extension_ui_request", id: "b1", method: "select", title: "Select base branch to compare against", options: ["main", "feature"] });
		await tick();
		assert.equal(session.model.uiRequest?.title, "Select base branch to compare against");
		assert.equal(await session.respondUi({ id: "b1", value: "main" }), true);
		channel.emit({ type: "extension_ui_request", id: "c1", method: "select", title: "Select commit to review", options: ["9a1b2c3 second on feature", "4d5e6f7 first"] });
		await tick();
		assert.equal(await session.respondUi({ id: "c1", value: "9a1b2c3 second on feature" }), true);
		assert.deepEqual(channel.written.filter(frame => frame.type === "extension_ui_response").map(frame => frame.value), ["1. Review against a base branch (PR Style)", "main", "9a1b2c3 second on feature"]);
	});

	it("takes the custom request in the multi-line editor dialog and returns the text exactly as typed", async () => {
		const { channel, session } = await boot();
		void session.prompt({ requestId: "r4", text: "/review" });
		await tick();
		channel.emit({ type: "extension_ui_request", id: "e1", method: "editor", title: "Enter custom review instructions", prefill: "Review the following:\n\n", promptStyle: true });
		await tick();
		assert.deepEqual(session.model.uiRequest, { id: "e1", method: "editor", title: "Enter custom review instructions", prefill: "Review the following:\n\n", promptStyle: true });
		const typed = "Review the following:\n\ncheck the error handling\nand the tests";
		assert.equal(await session.respondUi({ id: "e1", value: typed }), true);
		assert.deepEqual(channel.written.at(-1), { type: "extension_ui_response", id: "e1", value: typed });
	});

	it("takes the pull request search in an input dialog; a cancelled answer returns OMP to its list", async () => {
		const { channel, session } = await boot();
		void session.prompt({ requestId: "r5", text: "/review" });
		await tick();
		channel.emit({ type: "extension_ui_request", id: "i1", method: "input", title: "Search open pull requests — title, author, or #123" });
		await tick();
		assert.deepEqual(session.model.uiRequest, { id: "i1", method: "input", title: "Search open pull requests — title, author, or #123" });
		assert.equal(await session.respondUi({ id: "i1", cancelled: true }), true);
		assert.deepEqual(channel.written.at(-1), { type: "extension_ui_response", id: "i1", cancelled: true });
	});

	it("shows the loading status while it lists pull requests and clears it after", async () => {
		const { channel, session } = await boot();
		void session.prompt({ requestId: "r6", text: "/review" });
		await tick();
		channel.emit({ type: "extension_ui_request", id: "s1", method: "setStatus", statusKey: "review", statusText: "Loading open pull requests…" });
		await tick();
		assert.equal(session.model.statusLine, "Loading open pull requests…");
		channel.emit({ type: "extension_ui_request", id: "s2", method: "setStatus", statusKey: "review" });
		await tick();
		assert.equal(session.model.statusLine, null);
	});

	it("reports an empty diff as a warning in the Chat and a failed lookup (no GitHub CLI) as an error message of the window", async () => {
		const { channel, session, outputs } = await boot();
		void session.prompt({ requestId: "r7", text: "/review" });
		await tick();
		channel.emit({ type: "extension_ui_request", id: "n1", method: "notify", message: "No changes between main and feature", notifyType: "warning" });
		channel.emit({ type: "extension_ui_request", id: "n2", method: "notify", message: "Failed to resolve repository for PR picker: GitHub CLI (gh) is not installed. Install it from https://cli.github.com/.", notifyType: "error" });
		await tick();
		assert.deepEqual({ level: session.model.extensionNotice?.level, message: session.model.extensionNotice?.message }, { level: "warning", message: "No changes between main and feature" });
		const errors = outputs.flatMap(output => (output.type === "extension-error" ? [output.message] : []));
		assert.equal(errors.length, 1);
		assert.match(errors[0]!, /GitHub CLI \(gh\) is not installed/);
	});

	it("ends without a turn when the user cancels: the prompt is accepted, then settles as a command that invoked no agent", async () => {
		const { channel, session, outputs } = await boot();
		const outcome = session.prompt({ requestId: "r8", text: "/review" });
		await tick();
		channel.emit(REVIEW_MODE);
		await tick();
		assert.equal(await session.respondUi({ id: REVIEW_MODE.id, cancelled: true }), true);
		assert.deepEqual(channel.written.at(-1), { type: "extension_ui_response", id: REVIEW_MODE.id, cancelled: true });
		channel.emit(responseLine("vsc:r8", "prompt", true, {}));
		channel.emit({ type: "prompt_result", id: "vsc:r8", agentInvoked: false, status: "completed", sessionSettled: true });
		await tick();
		assert.deepEqual(await outcome, { status: "accepted", agentInvoked: null });
		assert.equal(session.model.uiRequest, null);
		assert.equal(session.model.working, false);
		assert.equal(session.model.settled, true);
		const result = outputs.find(output => output.type === "prompt-result");
		assert.ok(result !== undefined && result.type === "prompt-result" && result.requestId === "r8");
	});
});
