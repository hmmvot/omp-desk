/**
 * What the end of an OMP process the window did not ask for records, over fake ports: a normal exit
 * (code 0, OMP's own `/exit`) is the user's stop; every other end (the operating system ending the session,
 * a crash, a kill, no answer from the broker) leaves the run intent for the next startup to act on. The row is
 * closed in one `closeSession` carrying the decision, never a separate stopped-intent write beside it.
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
import { silentLogger } from "../shared/logger.ts";
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

function fixture(kind: "chat" | "terminal", exit: Exit) {
	const events: string[] = [];
	const closes: CloseSessionOptions[] = [];
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
			get: () => ({ ownership: { ownerGeneration: "gen-1" } }),
			closeSession: async (_tab: string, options: CloseSessionOptions) => { closes.push(options); events.push("closeSession"); return { released: true, detail: "released" }; },
			setRunIntent: async () => { events.push("setRunIntent"); },
		} as never,
		window: {
			activated: () => true, fence: () => { events.push("fence"); }, forgetOutcome: () => undefined, endTerminal: () => undefined,
			view: () => undefined, refresh: () => undefined, nativeEnded: () => undefined, notice: (_level: string, text: string) => { events.push(`notice ${text}`); },
		} as never,
		records: { get: () => record } as never,
		control: { release: async () => { events.push("release"); }, dispose: () => undefined },
		stop: { confirmEnded: async () => null },
		attachBrokerClient: async () => ({}) as never,
		proveExit: async () => verdict(exit),
		brokerSlots: () => undefined,
		log: silentLogger,
	});
	return { ops, record, runtime, events, closes };
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
});
