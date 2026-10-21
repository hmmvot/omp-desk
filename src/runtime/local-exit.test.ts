/**
 * What the end of an OMP process the window did not ask for records, over fake ports: a normal exit
 * (code 0, OMP's own `/exit`) is the user's stop, and so is the end of a row that already records the stopped
 * intent (the user's own Kill or Stop wrote it first: the row says it was stopped, never that it ended unexpectedly
 * or restarts); every other end (the operating system ending the session, a crash) leaves the run intent for the
 * next startup to act on. The row is closed in one `closeSession` carrying the decision, never a separate
 * stopped-intent write beside it. The proof of the exit is bounded: a client, a broker or a kernel probe that
 * never answers ends its step at the deadline and the kernel's proof closes the row, while an unreadable probe
 * never closes it.
 *
 * The module's host imports resolve extensionless specifiers the way esbuild does, so it is compiled
 * with the project's bundler.
 *
 * Runner: `node --test src/runtime/local-exit.test.ts`.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, before, describe, it } from "node:test";
import { build } from "esbuild";
import { recordingLogger } from "../shared/logger.ts";
import type { LoggedLine } from "../shared/logger.ts";
import type { NativeHostRuntime } from "../host/native-session.ts";
import type { RpcHostRuntime } from "../host/rpc-launch.ts";
import type { NativeStopVerdict } from "../host/rpc-reconcile.ts";
import type { CloseSessionOptions } from "../host/session-index.ts";
import type { exitOutcome as exitOutcomeType, LocalExitDeps, LocalExitOperations as LocalExitOperationsType } from "./local-exit.ts";

let LocalExitOperations: new (deps: LocalExitDeps) => LocalExitOperationsType;
let exitOutcome: typeof exitOutcomeType;
let temp: string;
before(async () => {
	temp = await mkdtemp(path.join(tmpdir(), "omp-exit-"));
	const outfile = path.join(temp, "local-exit.mjs");
	await build({ entryPoints: [fileURLToPath(new URL("./local-exit.ts", import.meta.url))], outfile, bundle: true, platform: "node", format: "esm", target: "node20" });
	const loaded = (await import(pathToFileURL(outfile).href)) as { LocalExitOperations: typeof LocalExitOperations; exitOutcome: typeof exitOutcome };
	LocalExitOperations = loaded.LocalExitOperations;
	exitOutcome = loaded.exitOutcome;
});
after(async () => { await rm(temp, { recursive: true, force: true }); });

const TAB = "tab:one";
type Exit = NativeStopVerdict["exit"];

/** A verdict as `waitForManagedRootExit` returns it: the root proven gone, and how it ended when the broker said. */
function verdict(exit: Exit): NativeStopVerdict {
	return { writerGone: true, treeEmpty: false, detail: "The session is stopped.", ...(exit === undefined ? {} : { exit }) };
}

interface FixtureOptions {
	/** The broker answers `proveExit` with a proof (the default) or with a closed connection. */
	brokerProves?: boolean;
	/** The kernel shows the recorded root gone. */
	rootGone?: boolean;
	/** The run intent the row records when the exit is handled (`running` by default). */
	intent?: "running" | "stopped";
	/** Replace a port; a promise that never settles stands for the await that hangs. */
	attachBrokerClient?: LocalExitDeps["attachBrokerClient"];
	proveExit?: LocalExitDeps["proveExit"];
	confirmEnded?: LocalExitDeps["stop"]["confirmEnded"];
	/** The bound of each step of the proof; short, so a hanging step costs milliseconds. */
	proofDeadlineMs?: number;
}

/** An await that never settles. */
const hangs = (): Promise<never> => Promise.withResolvers<never>().promise;

function fixture(kind: "chat" | "terminal", exit: Exit, options: FixtureOptions = {}) {
	const events: string[] = [];
	const closes: CloseSessionOptions[] = [];
	const lines: LoggedLine[] = [];
	const runtime = {
		kind,
		pid: 4242,
		observedSurvivors: [],
		handle: { shutdown: async () => { events.push("shutdown"); }, disconnect: () => undefined },
		identity: { slot: "slot-1" },
	} as unknown as RpcHostRuntime & NativeHostRuntime;
	const record = { tabId: TAB, slotId: "slot-1", runtime, control: null, controlFailure: null as string | null, endedNotice: null, transitioning: true, nativeWatch: null, pipeline: null };
	const ops = new LocalExitOperations({
		index: {
			lifecycle: { run: async (_tab: string, operation: (lease: unknown) => Promise<unknown>) => await operation({ tabId: TAB }) },
			get: () => ({ ownership: { ownerGeneration: "gen-1" }, runIntent: options.intent ?? "running" }),
			closeSession: async (_tab: string, close: CloseSessionOptions) => { closes.push(close); events.push("closeSession"); return { released: true, detail: "released" }; },
			setRunIntent: async () => { events.push("setRunIntent"); },
		} as never,
		window: {
			activated: () => true, fence: () => { events.push("fence"); }, forgetOutcome: () => undefined, endTerminal: () => undefined,
			view: () => undefined, refresh: () => undefined, nativeEnded: () => undefined, notice: (_level: string, text: string) => { events.push(`notice ${text}`); },
		} as never,
		records: { get: () => record } as never,
		control: { release: async () => { events.push("release"); }, dispose: () => undefined },
		stop: { confirmEnded: options.confirmEnded ?? (async () => options.rootGone === true ? { writerGone: true, treeEmpty: false, detail: "The OMP process had already ended." } : null) },
		attachBrokerClient: options.attachBrokerClient ?? (async () => ({}) as never),
		proveExit: options.proveExit ?? (async () => options.brokerProves === false ? { writerGone: false, treeEmpty: false, detail: "the broker connection closed" } : verdict(exit)),
		brokerSlots: () => undefined,
		log: recordingLogger(lines),
		...(options.proofDeadlineMs === undefined ? {} : { proofDeadlineMs: options.proofDeadlineMs }),
	});
	return { ops, record, runtime, events, closes, lines };
}

/** The Info lines of a fixture that contain `text`. */
function infoLines(lines: readonly LoggedLine[], text: string): string[] {
	return lines.filter(line => line.level === "info" && line.message.includes(text)).map(line => line.message);
}

describe("exitOutcome", () => {
	it("calls only exit code 0 the user's own exit", () => {
		assert.equal(exitOutcome(verdict({ code: 0, signal: 0 })).intent, "stopped");
		assert.equal(exitOutcome(verdict({ code: 0, signal: null })).intent, "stopped");
	});

	it("leaves the intent for the end Windows gave a logoff (code 4), a failure, a forced kill, a signal and an unreported code", () => {
		for (const exit of [{ code: 4, signal: 0 }, { code: 1, signal: 0 }, { code: 130, signal: 0 }, { code: -1, signal: 15 }, { code: 0, signal: 15 }, { code: null, signal: 0 }, { code: null, signal: null }]) {
			assert.equal(exitOutcome(verdict(exit)).intent, "unchanged", JSON.stringify(exit));
		}
		assert.equal(exitOutcome(verdict(undefined)).intent, "unchanged", "a broker that could not say how the process ended: it was killed with it");
	});

	it("says what happened in the row's detail and the log", () => {
		assert.match(exitOutcome(verdict({ code: 4, signal: 0 })).detail, /exit code 4.*restarts the next time VS Code starts/);
		assert.match(exitOutcome(verdict({ code: -1, signal: 15 })).detail, /exit code -1, signal 15/);
		assert.match(exitOutcome(verdict({ code: null, signal: 0 })).detail, /no exit code/);
		assert.match(exitOutcome(verdict(undefined)).log, /did not report how it ended/);
		assert.match(exitOutcome(verdict({ code: 0, signal: 0 })).log, /exited normally/);
	});

	it("calls the end of a row that already records the stopped intent the user's stop, whatever the broker said", () => {
		for (const exit of [undefined, { code: 1, signal: 0 }, { code: 4, signal: 0 }, { code: -1, signal: 15 }, { code: null, signal: null }, { code: 0, signal: 0 }]) {
			const outcome = exitOutcome(verdict(exit), "stopped");
			assert.equal(outcome.intent, "stopped", JSON.stringify(exit));
			assert.match(outcome.detail, /^The session was stopped\./);
			assert.doesNotMatch(outcome.detail, /unexpectedly|restarts/, "a stopped row restarts nothing");
			assert.match(outcome.log, /user stop/);
			assert.doesNotMatch(outcome.log, /abnormally/);
		}
	});

	it("keeps the abnormal wording for a row that records the running intent", () => {
		for (const recorded of ["running", null] as const) {
			const outcome = exitOutcome(verdict({ code: 4, signal: 0 }), recorded);
			assert.equal(outcome.intent, "unchanged");
			assert.match(outcome.detail, /ended unexpectedly.*restarts the next time VS Code starts/);
			assert.match(outcome.log, /ended abnormally/);
		}
	});
});

describe("rpcExited", () => {
	it("records a Windows logoff (exit code 4) with the run intent left alone, in a single closeSession", async () => {
		const f = fixture("chat", { code: 4, signal: 0 });
		await f.ops.rpcExited(TAB, f.runtime);
		assert.equal(f.closes.length, 1, f.events.join(" | "));
		assert.equal(f.closes[0]?.runIntent, "unchanged");
		assert.equal(f.closes[0]?.confirmedStopped, true);
		assert.match(f.closes[0]?.detail ?? "", /exit code 4/);
		assert.ok(!f.events.includes("setRunIntent"), "no separate stopped-intent write precedes the close");
		assert.deepEqual(f.events.filter(event => ["shutdown", "closeSession", "release"].includes(event)), ["shutdown", "closeSession", "release"]);
		assert.equal(f.record.runtime, null, "the tab shows the process ended");
	});

	it("records a normal exit as the user's stop, still without a separate intent write", async () => {
		const f = fixture("chat", { code: 0, signal: 0 });
		await f.ops.rpcExited(TAB, f.runtime);
		assert.equal(f.closes[0]?.runIntent, "stopped");
		assert.ok(!f.events.includes("setRunIntent"));
	});

	it("leaves the intent when the broker was killed with the process and said nothing", async () => {
		const f = fixture("chat", undefined);
		await f.ops.rpcExited(TAB, f.runtime);
		assert.equal(f.closes[0]?.runIntent, "unchanged");
	});

	it("records nothing when a replacement runtime already owns the tab", async () => {
		const f = fixture("chat", { code: 4, signal: 0 });
		f.record.runtime = {} as never;
		await f.ops.rpcExited(TAB, f.runtime);
		assert.deepEqual(f.closes, []);
	});

	it("closes the row from the kernel's proof when the broker died with the process and could not answer", async () => {
		const f = fixture("chat", undefined, { brokerProves: false, rootGone: true });
		await f.ops.rpcExited(TAB, f.runtime);
		assert.equal(f.closes.length, 1, f.events.join(" | "));
		assert.equal(f.closes[0]?.confirmedStopped, true);
		assert.equal(f.record.runtime, null, "the row no longer shows a running process");
	});

	it("keeps the row as it is while neither the broker nor the kernel shows the root gone", async () => {
		const f = fixture("chat", undefined, { brokerProves: false });
		await f.ops.rpcExited(TAB, f.runtime);
		assert.deepEqual(f.closes, []);
		assert.ok(f.events.includes("fence"));
	});

	it("ends the user's own Kill as a stop: the row says it was stopped and promises no relaunch", async () => {
		// Kill recorded the stopped intent, then ended the broker together with the process: no exit status, only the kernel's proof.
		const f = fixture("chat", undefined, { intent: "stopped", brokerProves: false, rootGone: true });
		await f.ops.rpcExited(TAB, f.runtime);
		assert.equal(f.closes.length, 1, f.events.join(" | "));
		assert.equal(f.closes[0]?.runIntent, "stopped");
		assert.match(f.closes[0]?.detail ?? "", /^The session was stopped\./);
		assert.doesNotMatch(f.closes[0]?.detail ?? "", /unexpectedly|restarts/);
		assert.equal(infoLines(f.lines, "user stop").length, 1, "the Output names it the user's stop");
		assert.deepEqual(f.lines.filter(line => line.message.includes("abnormally")), []);
	});

	it("keeps the abnormal wording for a crash of a row that records the running intent", async () => {
		const f = fixture("chat", undefined, { brokerProves: false, rootGone: true });
		await f.ops.rpcExited(TAB, f.runtime);
		assert.equal(f.closes[0]?.runIntent, "unchanged");
		assert.match(f.closes[0]?.detail ?? "", /ended unexpectedly.*restarts the next time VS Code starts/);
		assert.equal(infoLines(f.lines, "ended abnormally").length, 1);
		assert.deepEqual(infoLines(f.lines, "user stop"), []);
	});

	it("says in one Info line how long each step of the proof took and what it came to", async () => {
		const f = fixture("chat", undefined, { brokerProves: false, rootGone: true });
		await f.ops.rpcExited(TAB, f.runtime);
		assert.match(infoLines(f.lines, "exit proof")[0] ?? "", /^tab tab:one: exit proof: broker client \d+ ms, broker proof \d+ ms \(writer not proven\), kernel root check \d+ ms -> gone$/);
	});

	it("does not ask the kernel when the broker proved the exit", async () => {
		let asked = 0;
		const f = fixture("chat", { code: 0, signal: 0 }, { confirmEnded: async () => { asked++; return null; } });
		await f.ops.rpcExited(TAB, f.runtime);
		assert.equal(asked, 0);
		assert.match(infoLines(f.lines, "exit proof")[0] ?? "", /broker client \d+ ms, broker proof \d+ ms -> gone$/);
	});

	it("closes the row from the kernel's proof when the broker client never attaches", async () => {
		const f = fixture("chat", undefined, { attachBrokerClient: hangs, rootGone: true, proofDeadlineMs: 20 });
		await f.ops.rpcExited(TAB, f.runtime);
		assert.equal(f.closes.length, 1, f.events.join(" | "));
		assert.equal(f.closes[0]?.confirmedStopped, true);
		assert.equal(f.record.runtime, null, "the row no longer shows a running process");
		assert.match(infoLines(f.lines, "exit proof")[0] ?? "", /^tab tab:one: exit proof: broker client \d+ ms \(no answer within 20 ms\), kernel root check \d+ ms -> gone$/);
	});

	it("closes the row from the kernel's proof when the broker never answers the proof", async () => {
		const f = fixture("chat", undefined, { proveExit: hangs, rootGone: true, proofDeadlineMs: 20 });
		await f.ops.rpcExited(TAB, f.runtime);
		assert.equal(f.closes.length, 1, f.events.join(" | "));
		assert.equal(f.record.runtime, null);
		assert.match(infoLines(f.lines, "exit proof")[0] ?? "", /broker client \d+ ms, broker proof \d+ ms \(no answer within 20 ms\), kernel root check \d+ ms -> gone$/);
	});

	it("goes on to the kernel's proof when the broker client is unavailable or throws", async () => {
		const none = fixture("chat", undefined, { attachBrokerClient: async () => null, rootGone: true });
		await none.ops.rpcExited(TAB, none.runtime);
		assert.equal(none.closes.length, 1, none.events.join(" | "));
		assert.match(infoLines(none.lines, "exit proof")[0] ?? "", /broker client \d+ ms \(unavailable\), kernel root check \d+ ms -> gone$/);

		const thrown = fixture("chat", undefined, { attachBrokerClient: async () => { throw new Error("the PTY gate failed"); }, rootGone: true });
		await thrown.ops.rpcExited(TAB, thrown.runtime);
		assert.equal(thrown.closes.length, 1, thrown.events.join(" | "));
		assert.match(infoLines(thrown.lines, "exit proof")[0] ?? "", /broker client \d+ ms \(failed: the PTY gate failed\), kernel root check/);
	});

	it("takes an answer that arrived during a stall of the host before it gives the step up", async () => {
		// The order of the event loop's phases is the subject: after a stall inside the check phase the deadline's timer
		// (timers phase) runs before an answer queued meanwhile (next check phase), so fake timers, which have no phases,
		// cannot stand in for the real ones.
		const stalled: LocalExitDeps["attachBrokerClient"] = () => {
			const answer = Promise.withResolvers<never>();
			setImmediate(() => {
				setImmediate(() => answer.resolve({} as never));
				for (const until = Date.now() + 60; Date.now() < until;) { /* the host is stalled */ }
			});
			return answer.promise;
		};
		const f = fixture("chat", { code: 0, signal: 0 }, { attachBrokerClient: stalled, proofDeadlineMs: 20 });
		await f.ops.rpcExited(TAB, f.runtime);
		assert.equal(f.closes[0]?.runIntent, "stopped", "the broker's own exit status was read");
		assert.doesNotMatch(infoLines(f.lines, "exit proof")[0] ?? "", /no answer/);
	});

	it("keeps the row open when the kernel's probe cannot be read or never answers", async () => {
		const unreadable = fixture("chat", undefined, { brokerProves: false, confirmEnded: async () => { throw new Error("the probe could not be read"); } });
		await unreadable.ops.rpcExited(TAB, unreadable.runtime);
		assert.deepEqual(unreadable.closes, []);
		assert.ok(unreadable.events.includes("fence"));
		assert.equal(unreadable.record.runtime, unreadable.runtime, "the row still shows the process");
		assert.match(infoLines(unreadable.lines, "exit proof")[0] ?? "", /kernel root check \d+ ms \(failed: the probe could not be read\) -> not proven$/);

		const silent = fixture("chat", undefined, { brokerProves: false, confirmEnded: hangs, proofDeadlineMs: 20 });
		await silent.ops.rpcExited(TAB, silent.runtime);
		assert.deepEqual(silent.closes, []);
		assert.ok(silent.events.includes("fence"));
		assert.equal(silent.record.runtime, silent.runtime);
		assert.match(infoLines(silent.lines, "exit proof")[0] ?? "", /kernel root check \d+ ms \(no answer within 20 ms\) -> not proven$/);
	});

	it("keeps the row open when nothing at all answered", async () => {
		const f = fixture("chat", undefined, { attachBrokerClient: hangs, confirmEnded: hangs, proofDeadlineMs: 20 });
		await f.ops.rpcExited(TAB, f.runtime);
		assert.deepEqual(f.closes, []);
		assert.ok(f.events.includes("fence"));
		assert.equal(f.record.runtime, f.runtime);
		assert.match(f.record.controlFailure ?? "", /disconnected/, "the tab says what to do");
	});
});

describe("nativeExited", () => {
	it("applies the same rule to a Terminal: a typed /exit is stopped, a Windows logoff is not", async () => {
		const clean = fixture("terminal", { code: 0, signal: 0 });
		await clean.ops.nativeExited(clean.record as never, clean.runtime);
		assert.equal(clean.closes[0]?.runIntent, "stopped");
		assert.ok(!clean.events.includes("setRunIntent"));

		const logoff = fixture("terminal", { code: 4, signal: 0 });
		await logoff.ops.nativeExited(logoff.record as never, logoff.runtime);
		assert.equal(logoff.closes[0]?.runIntent, "unchanged");
		assert.ok(!logoff.events.includes("setRunIntent"));
	});

	it("ends a Terminal the user killed as a stop", async () => {
		const f = fixture("terminal", undefined, { intent: "stopped", brokerProves: false, rootGone: true });
		await f.ops.nativeExited(f.record as never, f.runtime);
		assert.equal(f.closes.length, 1, f.events.join(" | "));
		assert.equal(f.closes[0]?.runIntent, "stopped");
		assert.match(f.closes[0]?.detail ?? "", /^The session was stopped\./);
		assert.equal(infoLines(f.lines, "user stop").length, 1);
	});

	it("closes a Terminal from the kernel's proof when its broker never answers, and keeps it when the kernel cannot read", async () => {
		const gone = fixture("terminal", undefined, { attachBrokerClient: hangs, rootGone: true, proofDeadlineMs: 20 });
		await gone.ops.nativeExited(gone.record as never, gone.runtime);
		assert.equal(gone.closes.length, 1, gone.events.join(" | "));
		assert.equal(gone.record.runtime, null);
		assert.match(infoLines(gone.lines, "exit proof")[0] ?? "", /broker client \d+ ms \(no answer within 20 ms\), kernel root check \d+ ms -> gone$/);

		const unreadable = fixture("terminal", undefined, { attachBrokerClient: hangs, confirmEnded: async () => { throw new Error("the probe could not be read"); }, proofDeadlineMs: 20 });
		await unreadable.ops.nativeExited(unreadable.record as never, unreadable.runtime);
		assert.deepEqual(unreadable.closes, []);
		assert.equal(unreadable.record.runtime, unreadable.runtime);
		assert.ok(unreadable.record.controlFailure !== null, "the tab keeps the reason");
	});
});

describe("endEnded", () => {
	it("ends the runtime of a root the kernel shows gone", async () => {
		const f = fixture("chat", { code: 4, signal: 0 }, { rootGone: true });
		assert.equal(await f.ops.endEnded(f.record as never, f.runtime), true);
		assert.equal(f.closes.length, 1, f.events.join(" | "));
	});

	it("leaves the runtime alone, and says so, when the kernel's check never answers or cannot read", async () => {
		const silent = fixture("chat", { code: 4, signal: 0 }, { confirmEnded: hangs, proofDeadlineMs: 20 });
		assert.equal(await silent.ops.endEnded(silent.record as never, silent.runtime), false);
		assert.deepEqual(silent.closes, []);
		assert.equal(silent.lines.filter(line => line.level === "warn").length, 1);

		const unreadable = fixture("chat", { code: 4, signal: 0 }, { confirmEnded: async () => { throw new Error("the probe could not be read"); } });
		assert.equal(await unreadable.ops.endEnded(unreadable.record as never, unreadable.runtime), false);
		assert.deepEqual(unreadable.closes, []);
		assert.match(unreadable.lines.find(line => line.level === "warn")?.message ?? "", /the probe could not be read/);
	});
});
