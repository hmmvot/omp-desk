/**
 * The stop verdict operations over fake ports: the verdict a caller records under its own gate, the
 * fallback to an already-ended root, and the identity check against the window's tab record.
 *
 * The module's host imports resolve extensionless specifiers the way esbuild does, so it is compiled
 * with the project's bundler.
 *
 * Runner: `node --test src/runtime/local-stop.test.ts`.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { recordingLogger, silentLogger } from "../shared/logger.ts";
import type { LoggedLine } from "../shared/logger.ts";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setImmediate as nextTurn } from "node:timers/promises";
import { after, before, describe, it } from "node:test";
import { build } from "esbuild";
import type { SessionHostRuntime } from "../host/native-session.ts";
import type { LocalStopDeps, LocalStopOperations as LocalStopOperationsType, StopRecord } from "./local-stop.ts";

let LocalStopOperations: new (deps: LocalStopDeps) => LocalStopOperationsType;
let temp: string;
before(async () => {
	temp = await mkdtemp(path.join(tmpdir(), "omp-stop-"));
	const outfile = path.join(temp, "local-stop.mjs");
	await build({ entryPoints: [fileURLToPath(new URL("./local-stop.ts", import.meta.url))], outfile, bundle: true, platform: "node", format: "esm", target: "node20" });
	LocalStopOperations = ((await import(pathToFileURL(outfile).href)) as { LocalStopOperations: typeof LocalStopOperations }).LocalStopOperations;
});
after(async () => { await rm(temp, { recursive: true, force: true }); });

const TAB = "tab:one";
const runtime = { kind: "chat", pid: 4242, identity: { childCreationTime: "created-1" } } as unknown as SessionHostRuntime;

function fixture(options: { rootGone?: boolean; broker?: boolean; settled?: boolean; epoch?: number; read?: () => Promise<unknown> } = {}) {
	let aborted = 0;
	const lines: LoggedLine[] = [];
	const session = {
		epoch: { nonce: "n", counter: options.epoch ?? 1 },
		readSettlement: options.read ?? (async () => ({ sessionFile: "s.jsonl", sessionId: "id-1", settled: options.settled ?? true, hasContent: true })),
		abortForShutdown: async () => { aborted++; return { status: "accepted" }; },
	};
	const ops = new LocalStopOperations({
		chat: () => ({ sessionOf: () => session }) as never,
		attachBrokerClient: async () => (options.broker === false ? null : ({}) as never),
		rootGone: async () => options.rootGone === true,
		log: options.read === undefined ? silentLogger : recordingLogger(lines),
	});
	const record: StopRecord = { tabId: TAB, runtime, control: null, transitioning: false, pipeline: null };
	return { ops, record, lines, aborts: () => aborted };
}

describe("confirmEnded", () => {
	it("is null while the recorded root cannot be shown gone, and an ended verdict once it is", async () => {
		assert.equal(await fixture().ops.confirmEnded(runtime), null);
		const verdict = await fixture({ rootGone: true }).ops.confirmEnded(runtime);
		assert.equal(verdict?.writerGone, true);
		assert.equal(verdict?.detail, "The OMP process had already ended.");
	});
});

describe("requestStop", () => {
	it("refuses a graceful stop of a busy chat session without consent and aborts nothing", async () => {
		const f = fixture({ settled: false });
		const verdict = await f.ops.requestStop(f.record, runtime, "graceful", false);
		assert.equal(verdict.writerGone, false);
		assert.match(verdict.detail, /OMP is busy/);
		assert.equal(f.aborts(), 0);
	});

	it("reports an ended root as stopped when the broker cannot be reached", async () => {
		const f = fixture({ broker: false, rootGone: true });
		const verdict = await f.ops.requestStop(f.record, runtime, "graceful", true);
		assert.equal(verdict.writerGone, true);
		const unreachable = fixture({ broker: false });
		const refused = await unreachable.ops.requestStop(unreachable.record, runtime, "graceful", true);
		assert.equal(refused.writerGone, false);
		assert.match(refused.detail, /disconnected/);
	});
});

describe("readTransitionFacts and awaitSettled", () => {
	it("reads the facts only while the record still holds this very runtime", async () => {
		const f = fixture();
		const facts = await f.ops.readTransitionFacts(f.record, runtime);
		assert.deepEqual(facts, { file: "s.jsonl", sessionId: "id-1", epoch: "n:1", settled: true, hasContent: true, nativeTarget: null });
		assert.equal(await f.ops.readTransitionFacts({ ...f.record, runtime: null }, runtime), null);
		assert.equal(await f.ops.readTransitionFacts({ ...f.record, tabId: null }, runtime), null);
	});

	it("settles on the confirmed facts and refuses a session that changed", async () => {
		const f = fixture();
		const confirmed = (await f.ops.readTransitionFacts(f.record, runtime))!;
		assert.equal((await f.ops.awaitSettled(f.record, runtime, confirmed))?.settled, true);
		assert.equal(await f.ops.awaitSettled(f.record, runtime, { ...confirmed, epoch: "n:0" }), null);
	});

	it("is null, never an exception, when OMP does not answer in time or the read fails: a hung session has to stay stoppable", async t => {
		const failing = fixture({ read: async () => { throw new Error("the link closed"); } });
		assert.equal(await failing.ops.readTransitionFacts(failing.record, runtime), null);
		assert.match(failing.lines.find(line => line.level === "warn")?.message ?? "", /tab:one: the session's state could not be read \(the link closed\)/);

		const silent = fixture({ read: () => new Promise<never>(() => undefined) });
		t.mock.timers.enable({ apis: ["setTimeout"] });
		try {
			const reading = silent.ops.readTransitionFacts(silent.record, runtime);
			t.mock.timers.tick(10_000); // SESSION_TRANSITION_READ_TIMEOUT_MS
			assert.equal(await reading, null);
			assert.match(silent.lines.find(line => line.level === "warn")?.message ?? "", /the session's state could not be read \(Session state read timed out\.\)/);
			// What a Stop does with an unreadable session is to say so (the Force Stop question follows); it aborts and stops nothing.
			const stopping = silent.ops.requestStop(silent.record, runtime, "graceful", true);
			await nextTurn();
			t.mock.timers.tick(10_000);
			const verdict = await stopping;
			assert.equal(verdict.writerGone, false);
			assert.match(verdict.detail, /could not be checked/);
			assert.equal(silent.aborts(), 0);
		} finally { t.mock.timers.reset(); }
	});
});
