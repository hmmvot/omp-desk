/**
 * The start of the Bun plan's pipe-only check at activation: it must not delay activation, and nothing it meets may escape it.
 *
 * Runner: `node --test src/host/chat-runtime-warmup.test.ts`
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { recordingLogger, type LoggedLine } from "../shared/logger.ts";
import type { OmpLaunchFacts } from "./chat-broker-runtime.ts";
import { startChatRuntimeWarmup } from "./chat-runtime-warmup.ts";
import type { ChatRuntimeWarmup } from "./pty-client.ts";

const BINARY: OmpLaunchFacts = { command: "C:\\bun\\bin\\bun.exe", launcher: "bun-shim" };

async function until(condition: () => boolean): Promise<void> {
	for (let turns = 0; turns < 10_000 && !condition(); turns += 1) await yieldTurn();
	assert.ok(condition(), "the condition never held");
}

describe("the Bun runtime pre-check at activation", () => {
	it("returns before it resolves or checks anything, so activation does not wait for it", async () => {
		let resolved = 0;
		let warmed = 0;
		const pending = Promise.withResolvers<OmpLaunchFacts>();
		const deferred: (() => void)[] = [];
		const lines: LoggedLine[] = [];
		startChatRuntimeWarmup({
			resolve: () => {
				resolved += 1;
				return pending.promise;
			},
			warm: async () => {
				warmed += 1;
				return { outcome: "proved", detail: "" };
			},
			log: recordingLogger(lines),
			defer: run => deferred.push(run),
		});
		assert.deepEqual([resolved, warmed, deferred.length], [0, 0, 1], "the call only handed its work to a later turn");
		deferred[0]?.();
		assert.deepEqual([resolved, warmed], [1, 0], "resolving the OMP launch is the work, and a pending one holds nothing back");
		pending.resolve(BINARY);
		await until(() => warmed === 1);
	});

	it("does the same on the real default turn: nothing runs inside the call", async () => {
		let resolved = 0;
		let seen: OmpLaunchFacts | null = null;
		startChatRuntimeWarmup({
			resolve: async () => {
				resolved += 1;
				return BINARY;
			},
			warm: async binary => {
				seen = binary;
				return { outcome: "reused", detail: "" };
			},
			log: recordingLogger([]),
		});
		assert.equal(resolved, 0);
		await until(() => seen !== null);
		assert.deepEqual(seen, BINARY);
	});

	it("ends in a log line, never in a rejection, when the OMP launch cannot be resolved", async () => {
		const lines: LoggedLine[] = [];
		let warmed = 0;
		startChatRuntimeWarmup({
			resolve: async () => {
				throw new Error("No usable OMP launcher was found.");
			},
			warm: async () => {
				warmed += 1;
				return { outcome: "proved", detail: "" };
			},
			log: recordingLogger(lines),
			defer: run => run(),
		});
		await until(() => lines.length === 1);
		assert.equal(lines[0]?.level, "info");
		assert.match(lines[0]?.message ?? "", /not run, the OMP launch could not be resolved \(No usable OMP launcher was found\.\)/);
		assert.equal(warmed, 0);
	});

	it("ends in a log line, never in a rejection, when the check itself throws", async () => {
		const lines: LoggedLine[] = [];
		startChatRuntimeWarmup({
			resolve: async () => BINARY,
			warm: async () => {
				throw new Error("the proof store could not be read");
			},
			log: recordingLogger(lines),
			defer: run => run(),
		});
		await until(() => lines.length === 1);
		assert.equal(lines[0]?.level, "warn");
		assert.match(lines[0]?.message ?? "", /failed \(the proof store could not be read\)/);
	});

	it("says in the debug log why a launch that would not take the Bun plan was not checked", async () => {
		const lines: LoggedLine[] = [];
		const skipped: ChatRuntimeWarmup = { outcome: "skipped", detail: "this session's OMP is OMP's own compiled program" };
		startChatRuntimeWarmup({ resolve: async () => BINARY, warm: async () => skipped, log: recordingLogger(lines), defer: run => run() });
		await until(() => lines.length === 1);
		assert.equal(lines[0]?.level, "debug");
		assert.match(lines[0]?.message ?? "", /not needed \(this session's OMP is OMP's own compiled program\)/);
	});
});
