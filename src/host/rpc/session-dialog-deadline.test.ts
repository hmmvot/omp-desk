/**
 * A command that asks the user through a dialog before it returns (`/review` opens its pickers inside the `prompt`,
 * and OMP acknowledges the prompt only when the command is done) must not be reported as unconfirmed while the
 * dialog waits. Runner: `node --test src/host/rpc/session-dialog-deadline.test.ts`.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { FakeRpcChannel, responseLine } from "./fake-channel.ts";
import { RpcSession } from "./session.ts";
import type { SendOutcome } from "./session.ts";
import { ManualTimers, tick } from "./test-support.ts";

const COMMAND_TIMEOUT_MS = 30_000;
const sessions: RpcSession[] = [];
afterEach(() => {
	for (const session of sessions.splice(0)) session.dispose();
});

async function boot() {
	const channel = new FakeRpcChannel({ sessionFile: null });
	const timers = new ManualTimers();
	const session = new RpcSession({ channel, sessionFile: null, cwd: "D:\\scratch", hostNonce: "host-a", timers, fileExists: async () => true, watchdogIntervalMs: 60 * 60_000 });
	sessions.push(session);
	await session.start();
	await tick();
	// The command is running and has not answered: the way OMP holds a `prompt` while its extension command asks.
	channel.handlers.set("prompt", () => "drop");
	return { channel, session, timers };
}

/** The outcome of `promise` once it has settled, or `"pending"`. */
async function state(promise: Promise<SendOutcome>): Promise<SendOutcome | "pending"> {
	return await Promise.race([promise, tick(2).then(() => "pending" as const)]);
}

const picker = { type: "extension_ui_request", id: "ui-1", method: "select", title: "Review Mode", options: ["1. Review uncommitted changes", "2. Custom review instructions"] };

describe("the deadline of a command that waits for a dialog", () => {
	it("does not run while the dialog is open, and starts over when it is answered", async () => {
		const { channel, session, timers } = await boot();
		const outcome = session.prompt({ requestId: "review-1", text: "/review" });
		await tick();
		timers.advance(10_000);
		channel.emit(picker);
		await tick();
		assert.equal(session.model.uiRequest?.id, "ui-1");
		timers.advance(5 * COMMAND_TIMEOUT_MS);
		await tick();
		assert.equal(await state(outcome), "pending", "minutes of waiting for the user are not a lost message");

		assert.equal(await session.respondUi({ id: "ui-1", value: "1. Review uncommitted changes" }), true);
		timers.advance(COMMAND_TIMEOUT_MS - 1);
		assert.equal(await state(outcome), "pending", "the command gets its whole deadline after the answer");
		channel.emit(responseLine("vsc:review-1", "prompt", true, {}));
		assert.deepEqual(await outcome, { status: "accepted", agentInvoked: null });
	});

	it("restarts for every dialog of the command, including one that is cancelled", async () => {
		const { channel, session, timers } = await boot();
		const outcome = session.prompt({ requestId: "review-2", text: "/review" });
		await tick();
		channel.emit(picker);
		await tick();
		timers.advance(COMMAND_TIMEOUT_MS * 2);
		assert.equal(await session.respondUi({ id: "ui-1", value: "2. Custom review instructions" }), true);
		timers.advance(COMMAND_TIMEOUT_MS - 1_000);
		channel.emit({ type: "extension_ui_request", id: "ui-2", method: "editor", title: "Enter custom review instructions", prefill: "Review the following:\n\n" });
		await tick();
		timers.advance(COMMAND_TIMEOUT_MS * 3);
		await tick();
		assert.equal(await state(outcome), "pending");
		channel.emit({ type: "extension_ui_request", id: "cancel-1", method: "cancel", targetId: "ui-2" });
		await tick();
		timers.advance(COMMAND_TIMEOUT_MS - 1);
		assert.equal(await state(outcome), "pending", "a dialog OMP withdrew restarts the deadline as an answer does");
		channel.emit(responseLine("vsc:review-2", "prompt", true, {}));
		assert.deepEqual(await outcome, { status: "accepted", agentInvoked: null });
	});

	it("still reports a command that stays silent with no dialog open, one deadline after the last dialog", async () => {
		const { channel, session, timers } = await boot();
		const quiet = session.prompt({ requestId: "quiet-1", text: "/review" });
		await tick();
		timers.advance(COMMAND_TIMEOUT_MS);
		assert.deepEqual(await quiet, { status: "unconfirmed" }, "no dialog: the ordinary deadline");

		const asking = session.prompt({ requestId: "asking-1", text: "/review again" });
		await tick();
		channel.emit(picker);
		await tick();
		timers.advance(COMMAND_TIMEOUT_MS * 4);
		assert.equal(await session.respondUi({ id: "ui-1", value: "1. Review uncommitted changes" }), true);
		timers.advance(COMMAND_TIMEOUT_MS);
		assert.deepEqual(await asking, { status: "unconfirmed" }, "a command that never answers after the dialog is still lost, one deadline later");
	});
	it("never suspends a state read: OMP answers it while a command waits, so an unanswered one is a lost child even with a dialog open", async () => {
		const { channel, session, timers } = await boot();
		channel.handlers.set("get_state", () => "drop");
		void session.prompt({ requestId: "review-3", text: "/review" });
		await tick();
		channel.emit(picker);
		await tick();
		const read = session.readSettingsState();
		await tick();
		timers.advance(COMMAND_TIMEOUT_MS);
		assert.equal(await Promise.race([read, tick(2).then(() => "pending" as const)]), null, "the read ended at its deadline, as without a dialog");
		assert.equal(session.model.uiRequest?.id, "ui-1");
	});
});
