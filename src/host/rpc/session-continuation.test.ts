/**
 * Tests for `RpcSession` and session continuations (OMP 18.13): a session that moved to a newer file of its own chain is
 * the same session, anything else OMP reports stays a divergence. Real session files in a scratch directory, the way OMP
 * writes them, a scripted child that reports the newest file and its own id, and the session's manual timers.
 *
 * Runner: `node --test src/host/rpc/session-continuation.test.ts`.
 */
import assert from "node:assert/strict";
import { stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import type { ContinuationProof } from "../session-chain.ts";
import { FakeRpcChannel, type FakeChildModel } from "./fake-channel.ts";
import { RpcSession, type RpcSessionOptions, type RpcSessionOutput } from "./session.ts";
import { ManualTimers, ScratchDir, assistantMessage, isoOf, jsonl, messageEntry, tick, userMessage, waitUntil } from "./test-support.ts";

const scratches: ScratchDir[] = [];
afterEach(async () => {
	for (const scratch of scratches.splice(0)) await scratch.remove();
});

const u1 = messageEntry("u1", null, userMessage("hi", 1000));
const a1 = messageEntry("a1", "u1", assistantMessage("hello", 2000));

interface Rig {
	channel: FakeRpcChannel;
	session: RpcSession;
	timers: ManualTimers;
	outputs: RpcSessionOutput[];
	accepted: ContinuationProof[];
}

interface BootOptions {
	file: string;
	child: Partial<FakeChildModel>;
	/** What the catalog hook does with a proof; absent: it accepts. `"none"` leaves the option out so the session emits the event. */
	hook?: "none" | ((proof: ContinuationProof) => Promise<void>);
	session?: Partial<RpcSessionOptions>;
}

async function exists(file: string): Promise<boolean> {
	try {
		await stat(file);
		return true;
	} catch {
		return false;
	}
}

async function boot(options: BootOptions): Promise<Rig> {
	const channel = new FakeRpcChannel({ sessionFile: options.file, entries: [u1, a1] as never, leafId: "a1", ...options.child });
	const timers = new ManualTimers();
	const accepted: ContinuationProof[] = [];
	const hook = options.hook;
	const session = new RpcSession({
		channel,
		sessionFile: options.file,
		cwd: "C:\\work",
		hostNonce: "host-a",
		timers,
		fileExists: exists,
		...(hook === "none" ? {} : {
			acceptContinuation: async (proof: ContinuationProof) => {
				accepted.push(proof);
				await hook?.(proof);
			},
		}),
		...options.session,
	});
	const outputs: RpcSessionOutput[] = [];
	session.subscribe(output => outputs.push(output));
	await session.start();
	await tick();
	return { channel, session, timers, outputs, accepted };
}

async function scratchDirectory(): Promise<ScratchDir> {
	const scratch = await ScratchDir.create();
	scratches.push(scratch);
	return scratch;
}

/** The text of a session file as OMP 18.13 writes it: the title slot, then the header (the link before the carried fields), then the entries. */
function sessionText(id: string, continuationOf?: string): string {
	const title = { type: "title", v: 1, title: "T", source: "auto", updatedAt: isoOf(0), pad: " ".repeat(40) };
	const header = {
		type: "session",
		version: 3,
		id,
		timestamp: isoOf(0),
		...(continuationOf === undefined ? {} : { parentSession: continuationOf, continuationOf }),
		cwd: "C:\\work",
	};
	return jsonl([title, header, u1, a1]);
}

/** `<time>_<id>.jsonl`, the name OMP gives a file; later times sort later. */
function fileName(id: string, minute: number): string {
	return `2026-10-29T12-${String(minute).padStart(2, "0")}-00-000Z_${id}.jsonl`;
}

async function writeSession(scratch: ScratchDir, id: string, minute: number, continuationOf?: string): Promise<string> {
	return scratch.file(fileName(id, minute), sessionText(id, continuationOf));
}

/** Advance the manual clock in poll-sized steps until `done`; the real file reads the session makes get a few real milliseconds between steps. */
async function pump(timers: ManualTimers, done: () => boolean, stepMs = 200, steps = 40): Promise<void> {
	for (let step = 0; step < steps && !done(); step += 1) {
		await new Promise<void>(resolve => setTimeout(resolve, 5));
		timers.advance(stepMs);
	}
	await tick();
}

describe("a continuation at the first attach", () => {
	it("accepts a chain of one hop: live, one acceptance with the proof, the new file and id reported", async () => {
		const scratch = await scratchDirectory();
		const first = await writeSession(scratch, "AAA", 0);
		const second = await writeSession(scratch, "BBB", 5, "AAA");
		const { session, channel, accepted } = await boot({ file: first, child: { sessionFile: second, sessionId: "BBB" } });
		assert.equal(session.phase, "live");
		assert.deepEqual(accepted, [{ fromFile: first, toFile: second, fromId: "AAA", toId: "BBB", hops: 1 }]);
		assert.equal(session.sessionFile, second);
		assert.equal(session.sessionId, "BBB");
		assert.equal(session.model.header?.id, "BBB");
		assert.equal(channel.commandsOfType("get_entries").length, 1);
		assert.equal((await session.prompt({ requestId: "p1", text: "hello again" })).status, "accepted");
		session.dispose();
	});

	it("accepts a chain of two hops with the hop count in the proof", async () => {
		const scratch = await scratchDirectory();
		const first = await writeSession(scratch, "AAA", 0);
		await writeSession(scratch, "BBB", 5, "AAA");
		const third = await writeSession(scratch, "CCC", 10, "BBB");
		const { session, accepted } = await boot({ file: first, child: { sessionFile: third, sessionId: "CCC" } });
		assert.equal(session.phase, "live");
		assert.deepEqual(accepted, [{ fromFile: first, toFile: third, fromId: "AAA", toId: "CCC", hops: 2 }]);
		assert.equal(session.sessionFile, third);
		assert.equal(session.sessionId, "CCC");
		session.dispose();
	});

	it("asks the catalog through the identity output when no hook is given", async () => {
		const scratch = await scratchDirectory();
		const first = await writeSession(scratch, "AAA", 0);
		const second = await writeSession(scratch, "BBB", 5, "AAA");
		const { session, outputs } = await boot({ file: first, child: { sessionFile: second, sessionId: "BBB" }, hook: "none" });
		assert.equal(session.phase, "live");
		const identities = outputs.flatMap(output => (output.type === "identity" ? [output] : []));
		assert.deepEqual(identities, [{
			type: "identity",
			sessionFile: second,
			sessionId: "BBB",
			continuation: { fromFile: first, toFile: second, fromId: "AAA", toId: "BBB", hops: 1 },
		}]);
		assert.equal(session.sessionFile, second);
		session.dispose();
	});

	it("refuses a reported file whose continuationOf names no file of the directory", async () => {
		const scratch = await scratchDirectory();
		const first = await writeSession(scratch, "AAA", 0);
		const forged = await writeSession(scratch, "BBB", 5, "ZZZ");
		const { session, accepted, channel } = await boot({ file: first, child: { sessionFile: forged, sessionId: "BBB" } });
		assert.equal(session.phase, "failed");
		assert.equal(session.model.code, "identity-mismatch");
		assert.equal(accepted.length, 0);
		assert.equal(session.sessionFile, first);
		assert.equal(channel.commandsOfType("get_entries").length, 0);
		session.dispose();
	});

	it("refuses an unrelated file of the same directory", async () => {
		const scratch = await scratchDirectory();
		const first = await writeSession(scratch, "AAA", 0);
		const other = await writeSession(scratch, "BBB", 5);
		const { session, accepted } = await boot({ file: first, child: { sessionFile: other, sessionId: "BBB" } });
		assert.equal(session.model.code, "identity-mismatch");
		assert.equal(accepted.length, 0);
		session.dispose();
	});

	it("refuses a cycle of links that never reaches the requested file", async () => {
		const scratch = await scratchDirectory();
		const first = await writeSession(scratch, "AAA", 0);
		const second = await writeSession(scratch, "BBB", 5, "CCC");
		await writeSession(scratch, "CCC", 10, "BBB");
		const { session, accepted } = await boot({ file: first, child: { sessionFile: second, sessionId: "BBB" } });
		assert.equal(session.model.code, "identity-mismatch");
		assert.equal(accepted.length, 0);
		session.dispose();
	});

	it("refuses a proven file when OMP reports another id than the file's own", async () => {
		const scratch = await scratchDirectory();
		const first = await writeSession(scratch, "AAA", 0);
		const second = await writeSession(scratch, "BBB", 5, "AAA");
		const { session, accepted } = await boot({ file: first, child: { sessionFile: second, sessionId: "OTHER" } });
		assert.equal(session.model.code, "identity-mismatch");
		assert.equal(accepted.length, 0);
		assert.equal(session.sessionFile, first);
		session.dispose();
	});

	it("ends the tab with identity-diverged when the catalog refuses the continuation", async () => {
		const scratch = await scratchDirectory();
		const first = await writeSession(scratch, "AAA", 0);
		const second = await writeSession(scratch, "BBB", 5, "AAA");
		const { session, accepted, channel } = await boot({
			file: first,
			child: { sessionFile: second, sessionId: "BBB" },
			hook: async () => { throw new Error("another row owns that file"); },
		});
		assert.equal(accepted.length, 1);
		assert.equal(session.phase, "failed");
		assert.equal(session.model.code, "identity-diverged");
		assert.equal(channel.commandsOfType("get_entries").length, 0);
		assert.deepEqual(await session.prompt({ requestId: "p1", text: "hello" }), { status: "refused", reason: "not-live" });
		session.dispose();
	});

	it("uses the proof function it is given and trusts nothing else", async () => {
		const scratch = await scratchDirectory();
		const first = await writeSession(scratch, "AAA", 0);
		const second = await writeSession(scratch, "BBB", 5, "AAA");
		const asked: [string, string][] = [];
		const { session, accepted } = await boot({
			file: first,
			child: { sessionFile: second, sessionId: "BBB" },
			session: { proveContinuation: async (from, to) => { asked.push([from, to]); return null; } },
		});
		assert.deepEqual(asked, [[first, second]]);
		assert.equal(session.model.code, "identity-mismatch");
		assert.equal(accepted.length, 0);
		session.dispose();
	});
});

describe("a continuation while attached", () => {
	it("accepts it at a reattach (the process serves the continuation after the link dropped)", async () => {
		const scratch = await scratchDirectory();
		const first = await writeSession(scratch, "AAA", 0);
		const second = await writeSession(scratch, "BBB", 5, "AAA");
		const { session, channel, accepted } = await boot({ file: first, child: { sessionFile: first, sessionId: "AAA" } });
		assert.equal(session.phase, "live");
		assert.equal(accepted.length, 0);
		channel.child.sessionFile = second;
		channel.child.sessionId = "BBB";
		channel.closeLink("disconnected");
		await waitUntil(() => accepted.length > 0 && session.phase === "live" && session.sessionFile === second);
		await tick();
		assert.equal(session.phase, "live");
		assert.equal(accepted.length, 1, "the resync and the state read share one acceptance");
		assert.deepEqual(accepted[0], { fromFile: first, toFile: second, fromId: "AAA", toId: "BBB", hops: 1 });
		assert.equal(session.sessionId, "BBB");
		assert.equal(session.model.code, null);
		session.dispose();
	});

	it("accepts a move after a prompt whose new file appears a little later, once, and goes on", async () => {
		const scratch = await scratchDirectory();
		const first = await writeSession(scratch, "AAA", 0);
		const secondPath = path.join(scratch.dir, fileName("BBB", 5));
		const { session, channel, timers, accepted, outputs } = await boot({ file: first, child: { sessionFile: first, sessionId: "AAA" } });
		assert.equal(session.phase, "live");
		assert.equal((await session.prompt({ requestId: "p1", text: "work" })).status, "accepted");
		// OMP moved off the file while it handled the prompt: it reports the new pair, whose file is not on disk yet.
		channel.child.sessionFile = secondPath;
		channel.child.sessionId = "BBB";
		channel.emit({ type: "session_settled" });
		await tick();
		assert.equal(session.phase, "live", "the wait for the new file is not a failure");
		assert.equal(accepted.length, 0);
		await writeFile(secondPath, sessionText("BBB", "AAA"));
		await pump(timers, () => accepted.length > 0 && outputs.some(output => output.type === "state" && output.payload.sessionId === "BBB"));
		assert.equal(accepted.length, 1, "the post-settle read and the state read share one acceptance");
		assert.deepEqual(accepted[0], { fromFile: first, toFile: secondPath, fromId: "AAA", toId: "BBB", hops: 1 });
		assert.equal(session.phase, "live");
		assert.equal(session.model.code, null);
		assert.equal(session.sessionFile, secondPath);
		assert.equal(session.sessionId, "BBB");
		assert.equal(session.model.header?.id, "BBB");
		assert.ok(outputs.some(output => output.type === "state" && output.payload.sessionId === "BBB"), "the page is told the new id");
		const entriesBefore = channel.commandsOfType("get_entries").length;
		assert.equal((await session.prompt({ requestId: "p2", text: "more" })).status, "accepted");
		channel.emit({ type: "session_settled" });
		await pump(timers, () => channel.commandsOfType("get_entries").length > entriesBefore, 10, 20);
		assert.ok(channel.commandsOfType("get_entries").length > entriesBefore, "commands still go through after adoption");
		assert.equal(session.phase, "live");
		assert.equal(accepted.length, 1);
		session.dispose();
	});

	it("fails identity-diverged when the reported new file never appears", async () => {
		const scratch = await scratchDirectory();
		const first = await writeSession(scratch, "AAA", 0);
		const missing = path.join(scratch.dir, fileName("BBB", 5));
		const { session, channel, timers, accepted } = await boot({ file: first, child: { sessionFile: first, sessionId: "AAA" } });
		channel.child.sessionFile = missing;
		channel.child.sessionId = "BBB";
		channel.emit({ type: "session_settled" });
		await pump(timers, () => session.phase === "failed", 200, 30);
		assert.equal(session.phase, "failed");
		assert.equal(session.model.code, "identity-diverged");
		assert.equal(accepted.length, 0);
		assert.equal(session.sessionFile, first);
		session.dispose();
	});

	it("fails identity-diverged on an unrelated file that is already on disk, without waiting", async () => {
		const scratch = await scratchDirectory();
		const first = await writeSession(scratch, "AAA", 0);
		const other = await writeSession(scratch, "BBB", 5);
		const { session, channel, accepted } = await boot({ file: first, child: { sessionFile: first, sessionId: "AAA" } });
		channel.child.sessionFile = other;
		channel.child.sessionId = "BBB";
		channel.emit({ type: "session_settled" });
		await waitUntil(() => session.phase === "failed");
		assert.equal(session.model.code, "identity-diverged");
		assert.equal(accepted.length, 0);
		session.dispose();
	});

	it("ends the tab with identity-diverged when the catalog refuses a move while attached", async () => {
		const scratch = await scratchDirectory();
		const first = await writeSession(scratch, "AAA", 0);
		const second = await writeSession(scratch, "BBB", 5, "AAA");
		const { session, channel, accepted } = await boot({
			file: first,
			child: { sessionFile: first, sessionId: "AAA" },
			hook: async () => { throw new Error("refused"); },
		});
		channel.child.sessionFile = second;
		channel.child.sessionId = "BBB";
		channel.emit({ type: "session_settled" });
		await waitUntil(() => session.phase === "failed");
		assert.equal(session.model.code, "identity-diverged");
		assert.equal(accepted.length, 1, "two reads of the move ask the catalog once");
		session.dispose();
	});

	it("follows a continuation reported after a slash prompt without failing the identity backstop", async () => {
		const scratch = await scratchDirectory();
		const first = await writeSession(scratch, "AAA", 0);
		const second = await writeSession(scratch, "BBB", 5, "AAA");
		const { session, channel, accepted } = await boot({ file: first, child: { sessionFile: first, sessionId: "AAA" } });
		assert.equal((await session.prompt({ requestId: "s1", text: "/usr/bin/x" })).status, "accepted");
		channel.child.sessionFile = second;
		channel.child.sessionId = "BBB";
		channel.emit({ type: "prompt_result", id: "vsc:s1", agentInvoked: false, status: "completed", sessionSettled: true });
		await waitUntil(() => accepted.length > 0);
		await tick();
		assert.equal(session.phase, "live");
		assert.equal(accepted.length, 1);
		assert.equal(session.sessionFile, second);
		session.dispose();
	});
});
