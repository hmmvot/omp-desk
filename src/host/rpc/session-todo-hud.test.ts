/**
 * The Chat's TODO row on a real `RpcSession` over the fake child: a fully closed list leaves the row after OMP's delay, a list the
 * terminal UI dismissed never shows, a reload past the delay hides at once, and a changed list shows again.
 * Runner: `node --test src/host/rpc/session-todo-hud.test.ts`.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { ChatEntry } from "../../chat/messages.ts";
import { snapshotOf } from "../../chat/model.ts";
import { todoFingerprint } from "../../chat/todo-hud.ts";
import type { TodoPhase } from "../../chat/todos.ts";
import { FakeRpcChannel } from "./fake-channel.ts";
import { RpcSession, type RpcSessionOptions, type RpcSessionOutput } from "./session.ts";
import { ManualTimers, ScratchDir, isoOf, messageEntry, sessionFileText, tick, toolResultMessage } from "./test-support.ts";

const scratches: ScratchDir[] = [];
const sessions: RpcSession[] = [];
afterEach(async () => {
	for (const session of sessions.splice(0)) session.dispose();
	for (const scratch of scratches.splice(0)) await scratch.remove();
});

const closed: TodoPhase[] = [{ name: "Work", tasks: [{ content: "One", status: "completed" }, { content: "Two", status: "abandoned" }] }];
const reopened: TodoPhase[] = [{ name: "Work", tasks: [{ content: "One", status: "completed" }, { content: "Two", status: "pending" }] }];

async function boot(options: { todoPhases?: TodoPhase[]; entries?: ChatEntry[]; delay?: RpcSessionOptions["readTodoClearDelay"] } = {}) {
	let file: string | null = null;
	if (options.entries !== undefined) {
		const scratch = await ScratchDir.create();
		scratches.push(scratch);
		file = await scratch.file("session.jsonl", sessionFileText({ entries: options.entries }));
	}
	const channel = new FakeRpcChannel({ sessionFile: file, todoPhases: options.todoPhases ?? [], ...(options.entries === undefined ? {} : { entries: options.entries as unknown as Record<string, unknown>[], leafId: options.entries.at(-1)!.id }) });
	const timers = new ManualTimers();
	const session = new RpcSession({
		channel, sessionFile: file, cwd: "D:\\scratch", hostNonce: "host-a", timers, fileExists: async () => true, watchdogIntervalMs: 60 * 60_000,
		...(options.delay === undefined ? {} : { readTodoClearDelay: options.delay }),
	});
	sessions.push(session);
	const outputs: RpcSessionOutput[] = [];
	session.subscribe(output => outputs.push(output));
	await session.start();
	await tick();
	return { channel, session, timers, outputs };
}

const hides = (outputs: readonly RpcSessionOutput[]): number => outputs.filter(output => output.type === "event" && output.frame.type === "todo_hud_hide").length;
const todoEntry = (id: string, parentId: string | null, phases: readonly TodoPhase[], at: number): ChatEntry => messageEntry(id, parentId, toolResultMessage(`call-${id}`, at, "todo", { op: "update", phases }));
const dismissal = (id: string, parentId: string, source: string, phases: readonly TodoPhase[], visibility: string): ChatEntry => ({ type: "custom", id, parentId, timestamp: isoOf(9_000), customType: "todo_hud_state", data: { sourceEntryId: source, fingerprint: todoFingerprint(phases), visibility } });

describe("the TODO row of a live session", () => {
	it("clears a fully closed list after OMP's delay, sends the frame to the page and carries it in the next snapshot", async () => {
		const { session, timers, outputs } = await boot({ todoPhases: closed, delay: async () => 30 });
		assert.equal(session.model.todo?.hidden, false);
		timers.advance(29_999);
		assert.equal(session.model.todo?.hidden, false);
		timers.advance(1);
		assert.equal(session.model.todo?.hidden, true);
		assert.equal(hides(outputs), 1);
		assert.deepEqual(session.model.todo?.phases, closed, "the list itself is untouched");
		assert.equal(snapshotOf(session.model, session.epoch).todoHidden, true);
	});

	it("shows the row again when the list changes, and clears the new list after its own delay", async () => {
		const { session, channel, timers, outputs } = await boot({ todoPhases: closed, delay: async () => 30 });
		timers.advance(30_000);
		assert.equal(session.model.todo?.hidden, true);
		channel.emit({ type: "tool_execution_end", toolCallId: "todo-2", toolName: "todo", result: { details: { op: "update", phases: reopened } } });
		await tick();
		assert.equal(session.model.todo?.hidden, false);
		channel.emit({ type: "tool_execution_end", toolCallId: "todo-3", toolName: "todo", result: { details: { op: "update", phases: closed } } });
		await tick();
		timers.advance(29_999);
		assert.equal(session.model.todo?.hidden, false);
		timers.advance(1);
		assert.equal(session.model.todo?.hidden, true);
		assert.equal(hides(outputs), 2);
	});

	it("never clears a list while a task is open or the delay is negative, and falls back to 60 seconds when the setting cannot be read", async () => {
		const open = await boot({ todoPhases: reopened, delay: async () => 1 });
		open.timers.advance(3_600_000);
		assert.equal(open.session.model.todo?.hidden, false);
		const never = await boot({ todoPhases: closed, delay: async () => -1 });
		never.timers.advance(3_600_000);
		assert.equal(never.session.model.todo?.hidden, false);
		const unreadable = await boot({ todoPhases: closed, delay: async () => { throw new Error("omp failed"); } });
		unreadable.timers.advance(59_999);
		assert.equal(unreadable.session.model.todo?.hidden, false);
		unreadable.timers.advance(1);
		assert.equal(unreadable.session.model.todo?.hidden, true);
		const unset = await boot({ todoPhases: closed });
		unset.timers.advance(60_000);
		assert.equal(unset.session.model.todo?.hidden, true, "a session without a reader uses OMP's default");
	});
});

describe("the TODO row of a session opened from its file", () => {
	it("hides at once a list that has been closed for longer than the delay when the window opens", async () => {
		const entries = [todoEntry("t1", null, closed, 5_000)];
		const { session, timers } = await boot({ todoPhases: closed, entries, delay: async () => 60 });
		timers.advance(0);
		assert.equal(session.model.todo?.hidden, true, "the list was written long before the manual clock's now");
	});

	it("waits only the rest of the delay for a list closed shortly before the window opened", async () => {
		const probe = new ManualTimers();
		const entries = [todoEntry("t1", null, closed, probe.now() - 2_000 - 45_000)];
		const { session, timers } = await boot({ todoPhases: closed, entries, delay: async () => 60 });
		timers.advance(14_999);
		assert.equal(session.model.todo?.hidden, false);
		timers.advance(1);
		assert.equal(session.model.todo?.hidden, true);
	});

	it("keeps a list the terminal UI dismissed hidden from the first paint, and shows a list it changed since", async () => {
		const t1 = todoEntry("t1", null, closed, 5_000);
		const dismissed = await boot({ todoPhases: closed, entries: [t1, dismissal("h1", "t1", "t1", closed, "dismissed")], delay: async () => 60 });
		assert.equal(dismissed.session.model.todo?.hidden, true);
		const firstPaint = dismissed.outputs.find(output => output.type === "snapshot");
		assert.equal(firstPaint?.type === "snapshot" && firstPaint.payload.todoHidden, true, "the disk-paint snapshot already has the row cleared");
		const changed = await boot({ todoPhases: reopened, entries: [t1, dismissal("h1", "t1", "t1", closed, "dismissed"), todoEntry("t2", "h1", reopened, 6_000)], delay: async () => 60 });
		assert.equal(changed.session.model.todo?.hidden, false);
	});

	it("never clears a list the terminal UI revealed", async () => {
		const t1 = todoEntry("t1", null, closed, 5_000);
		const { session, timers } = await boot({ todoPhases: closed, entries: [t1, dismissal("h1", "t1", "t1", closed, "revealed")], delay: async () => 1 });
		timers.advance(3_600_000);
		assert.equal(session.model.todo?.hidden, false);
	});

	it("does not write to the session file", async () => {
		const entries = [todoEntry("t1", null, closed, 5_000)];
		const { session, timers, channel } = await boot({ todoPhases: closed, entries, delay: async () => 0 });
		timers.advance(0);
		assert.equal(session.model.todo?.hidden, true);
		assert.equal(JSON.stringify(channel.written).includes("todo_hud"), false, "no command carries a TODO row record");
	});
});
