import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NAVIGATE_COMMAND, NAVIGATION_MARKER_TYPE, encodeNavigateCommand, type NavigateArgs, type NavigationMarkerData } from "../chat/rewind.ts";
import { registerNavigateCommand, runNavigateCommand, type NavigateCommandApi, type NavigateCommandContext, type TreeObservation, type TreeObserver } from "./navigate-command.ts";

const REQUEST = "00112233445566778899aabbccddeeff";
type Entry = { type: string; id: string; parentId: string | null; message?: { role: string }; customType?: string; data?: unknown };
const user = (id: string, parentId: string | null): Entry => ({ type: "message", id, parentId, message: { role: "user" } });
const assistant = (id: string, parentId: string | null): Entry => ({ type: "message", id, parentId, message: { role: "assistant" } });

/** A session tree with a movable leaf, the `navigateTree` OMP runs, and the `session_tree` events it emits. */
class FakeSession {
	readonly entries = new Map<string, Entry>();
	leafId: string | null;
	idle = true;
	pending = false;
	mode = "rpc";
	readonly appended: Array<{ customType: string; data: NavigationMarkerData }> = [];
	readonly observations: TreeObservation[] = [];
	/** Replaces the move OMP performs; the default moves to the target's parent for a user target, else the target. */
	move: (targetId: string, summarize: boolean) => Promise<{ cancelled: boolean }> = async (targetId, summarize) => {
		const target = this.entries.get(targetId)!;
		const to = target.message?.role === "user" ? target.parentId : targetId;
		this.tree(this.leafId, to, summarize);
		this.leafId = to;
		return { cancelled: false };
	};

	constructor(entries: readonly Entry[], leafId: string | null) {
		for (const entry of entries) this.entries.set(entry.id, entry);
		this.leafId = leafId;
	}

	tree(oldLeafId: string | null, newLeafId: string | null, summarized = false): void {
		this.observations.push({ oldLeafId, newLeafId, summarized });
	}

	branch(fromId = this.leafId): Entry[] {
		const path: Entry[] = [];
		for (let id = fromId; id !== null;) {
			const entry = this.entries.get(id)!;
			path.unshift(entry);
			id = entry.parentId;
		}
		return path;
	}

	get context(): NavigateCommandContext {
		return {
			mode: this.mode,
			sessionManager: { getSessionId: () => "s1", getLeafId: () => this.leafId, getEntry: id => this.entries.get(id), getBranch: fromId => this.branch(fromId) },
			isIdle: () => this.idle,
			hasPendingMessages: () => this.pending,
			navigateTree: (targetId, options) => this.move(targetId, options?.summarize === true),
		};
	}

	readonly observer: TreeObserver = {
		begin: () => { this.observations.length = 0; },
		take: () => this.observations.at(-1) ?? null,
	};

	run(args: Partial<NavigateArgs>): Promise<NavigationMarkerData> {
		const request: NavigateArgs = { v: 1, requestId: REQUEST, kind: "rewind", sessionId: "s1", expectedLeafId: this.leafId, targetId: "u2", summarize: false, ...args };
		return runNavigateCommand(encodeNavigateCommand(request).slice(NAVIGATE_COMMAND.length + 2), this.context, (customType, data) => {
			this.appended.push({ customType, data });
			const id = `m${this.appended.length}`;
			this.entries.set(id, { type: "custom", id, parentId: this.leafId, customType, data });
			this.leafId = id;
		}, this.observer);
	}
}

const conversation = (): FakeSession => new FakeSession([user("u1", null), assistant("a1", "u1"), user("u2", "a1"), assistant("a2", "u2")], "a2");
const refusal = (code: string) => ({ message: `omp-desk-navigate:${code}` });

describe("omp-desk-navigate command", () => {
	it("rewinds to the prompt's parent and appends one marker naming the tip that was left", async () => {
		const session = conversation();
		const marker = await session.run({ summarize: true });
		assert.deepEqual(marker, { v: 1, requestId: REQUEST, kind: "rewind", from: "a2", target: "u2", to: "a1", summarized: true });
		assert.deepEqual(session.appended, [{ customType: NAVIGATION_MARKER_TYPE, data: marker }]);
		assert.equal(session.entries.get("m1")?.parentId, "a1", "the marker makes the move durable on the new branch");
	});

	it("refuses before anything moves: wrong mode, busy, other session, moved leaf, non-prompt or off-branch target", async () => {
		const cases: Array<[string, (session: FakeSession) => Partial<NavigateArgs>]> = [
			["mode", session => { session.mode = "interactive"; return {}; }],
			["busy", session => { session.idle = false; return {}; }],
			["busy", session => { session.pending = true; return {}; }],
			["session", () => ({ sessionId: "other" })],
			["stale", () => ({ expectedLeafId: "a1" })],
			["target", () => ({ targetId: "missing" })],
			["target", () => ({ targetId: "a1" })],
		];
		for (const [code, arrange] of cases) {
			const session = conversation();
			let moved = false;
			session.move = async () => { moved = true; return { cancelled: false }; };
			await assert.rejects(session.run(arrange(session)), refusal(code), code);
			assert.equal(moved, false, code);
			assert.deepEqual(session.appended, [], code);
		}
		await assert.rejects(runNavigateCommand("{not json", conversation().context, () => {}, conversation().observer), refusal("bad-request"));
	});

	it("Undo returns only to the tip the branch's marker recorded, and a switch only to another branch", async () => {
		const session = conversation();
		await session.run({});
		await assert.rejects(session.run({ kind: "undo", targetId: "a1" }), refusal("stale"));
		const undo = await session.run({ kind: "undo", targetId: "a2" });
		assert.deepEqual([undo.kind, undo.from, undo.to], ["undo", "m1", "a2"]);
		await assert.rejects(session.run({ kind: "undo", targetId: "m1" }), refusal("stale"), "an Undo is not undone");
		await assert.rejects(session.run({ kind: "switch", targetId: "a1" }), refusal("target"), "a switch target on the current branch would be a rewind");
		const switched = await session.run({ kind: "switch", targetId: "m1" });
		assert.deepEqual([switched.kind, switched.to], ["switch", "m1"]);
	});

	it("reports a move that did not happen with its cause and appends nothing", async () => {
		for (const [code, move] of [
			["cancelled", async () => ({ cancelled: true })],
			["unchanged", async () => ({ cancelled: false })],
			["failed", async () => { throw new Error("summary model failed"); }],
		] as const) {
			const session = conversation();
			session.move = move;
			await assert.rejects(session.run({}), refusal(code), code);
			assert.deepEqual(session.appended, [], code);
		}
	});

	it("still marks a move that happened before navigateTree threw, and flags a leaf that someone else moved", async () => {
		const session = conversation();
		session.move = async targetId => {
			session.tree("a2", "a1");
			session.leafId = session.entries.get(targetId)!.parentId;
			throw new Error("late failure");
		};
		assert.deepEqual(await session.run({}), { v: 1, requestId: REQUEST, kind: "rewind", from: "a2", target: "u2", to: "a1", summarized: false });

		const raced = conversation();
		raced.move = async () => {
			raced.tree("a2", "a1");
			raced.leafId = "u1";
			return { cancelled: false };
		};
		const marker = await raced.run({});
		assert.deepEqual([marker.from, marker.to, marker.raced], ["a2", "u1", true]);

		const unobserved = conversation();
		unobserved.move = async () => { unobserved.leafId = "a1"; return { cancelled: false }; };
		assert.equal((await unobserved.run({})).raced, true, "no session_tree event cannot prove the move was ours");
	});

	it("accepts a request made before OMP appended its usage record, and records the real leaf it left", async () => {
		const session = new FakeSession([user("u1", null), assistant("a1", "u1"), user("u2", "a1"), assistant("a2", "u2"), { type: "model_usage", id: "mu", parentId: "a2" }], "mu");
		const marker = await session.run({ expectedLeafId: "a2" });
		assert.deepEqual([marker.from, marker.to, marker.raced], ["mu", "a1", undefined]);
		const later = new FakeSession([user("u1", null), assistant("a1", "u1"), user("u2", "a1"), assistant("a2", "u2"), { type: "model_usage", id: "mu", parentId: "a2" }, user("u3", "mu")], "u3");
		await assert.rejects(later.run({ expectedLeafId: "a2" }), refusal("stale"), "a prompt after it is a real change");
	});
});

describe("registerNavigateCommand", () => {
	const fakePi = (withCommands = true) => {
		const handlers = new Map<string, Array<(event: unknown, ctx: { mode?: string }) => unknown>>();
		const commands: string[] = [];
		const appended: unknown[] = [];
		const pi: NavigateCommandApi = {
			on: (event, handler) => { handlers.set(event, [...handlers.get(event) ?? [], handler]); },
			...(withCommands ? {
				registerCommand: (name: string) => { commands.push(name); },
				appendEntry: (_type: string, data?: unknown) => { appended.push(data); },
			} : {}),
		};
		const emit = (event: string, payload: unknown, mode?: string) => { for (const handler of handlers.get(event) ?? []) handler(payload, mode === undefined ? {} : { mode }); };
		return { pi, commands, emit };
	};

	it("registers once, and only in an RPC-mode session", () => {
		const { pi, commands, emit } = fakePi();
		registerNavigateCommand(pi);
		emit("session_start", {}, "interactive");
		assert.deepEqual(commands, []);
		emit("session_start", {}, "rpc");
		emit("session_start", {}, "rpc");
		assert.deepEqual(commands, [NAVIGATE_COMMAND]);
	});

	it("registers nothing when OMP lacks the command or append API", () => {
		const { pi, commands, emit } = fakePi(false);
		registerNavigateCommand(pi);
		emit("session_start", {}, "rpc");
		assert.deepEqual(commands, []);
	});
});
