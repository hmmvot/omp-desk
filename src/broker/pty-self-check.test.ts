/**
 * The proof one PTY self-check run has to produce.
 *
 * The regression these defend is a *false negative* that blocked real sessions. Two
 * things were wrong with the gate, and both were measured rather than guessed:
 *
 * - the child was this runtime's own executable, and an Electron-as-node child (the
 *   extension host starts the broker from `Code.exe`) writes nothing at all to a pseudo
 *   console, whatever the backend — so the markers could never arrive in the runtime the
 *   gate actually guards;
 * - the exit code was the whole verdict, and the Windows ConPTY backend does not always
 *   report one.
 *
 * The other direction matters just as much: an unreported code must never be enough on
 * its own, or a backend that delivered nothing to the child would pass.
 *
 * Runner: `node --test src/broker/pty-self-check.test.ts`
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";

import {
	SELF_CHECK_CHILD_DELAY_MS,
	SELF_CHECK_DEADLINE_FLAG,
	SELF_CHECK_DEADLINE_MAX_MS,
	SELF_CHECK_DEADLINE_MIN_MS,
	SELF_CHECK_EXTENDED_DEADLINE_MS,
	SELF_CHECK_MARKER,
	SELF_CHECK_DEADLINE_MS,
	SELF_CHECK_OUTPUT_LIMIT,
	SELF_CHECK_TOKEN_MAX,
	SelfCheckInconclusive,
	type SelfCheckObservation,
	selfCheckChild,
	selfCheckDeadlineFromArgs,
	selfCheckPlan,
	watchPipeEcho,
	selfCheckTimeoutMayBeLateness,
	selfCheckTools,
	selfCheckVerdict,
} from "./pty-self-check.ts";

const TOKEN = "0123456789abcdef";

/** One run's plan with the token the broker would mint for it. */
const plan = selfCheckPlan(TOKEN);

/** The console programs this platform's child is built from, as the broker asks for them. */
const windowsTools = selfCheckTools("win32", { SystemRoot: "C:\\Windows" });

describe("selfCheckPlan", () => {
	it("mints markers that can only have come from this run's child", () => {
		assert.equal(plan.markers.start, `${SELF_CHECK_MARKER}-${TOKEN}-start`);
		assert.equal(plan.markers.end, `${SELF_CHECK_MARKER}-${TOKEN}-end`);
		assert.notEqual(plan.markers.start, plan.markers.end);
		const other = selfCheckPlan("ffffffffffffffff");
		assert.equal(other.markers.start === plan.markers.start, false, "another run's markers are not this run's");
	});

	it("keeps both markers inside the console width the check spawns", () => {
		// A marker a pseudo console wrapped would never appear contiguously in the stream.
		for (const marker of [plan.markers.start, plan.markers.end]) {
			assert.ok(marker.length < 40, `${marker} is too wide for a 40-column console`);
		}
		// The longest token this contract accepts still fits one console line.
		const longest = selfCheckPlan("f".repeat(SELF_CHECK_TOKEN_MAX));
		assert.ok(longest.markers.start.length < 40 && longest.markers.end.length < 40);
		for (const refused of ["", "F".repeat(8), "0123456789abcdef0", "zz", "-"]) {
			assert.throws(() => selfCheckPlan(refused), TypeError, `accepted ${JSON.stringify(refused)}`);
		}
	});

	it("runs a child that prints both markers through its own stdout and exits 0", () => {
		const run = spawnSync(process.execPath, ["-e", plan.source], { encoding: "utf8" });
		assert.equal(run.status, 0, run.stderr);
		assert.equal(run.stdout.includes(plan.markers.start), true, "the child must prove its start");
		assert.equal(run.stdout.includes(plan.markers.end), true, "the child must prove its completion");
		assert.ok(
			run.stdout.indexOf(plan.markers.start) < run.stdout.indexOf(plan.markers.end),
			"the start marker is printed first",
		);
		assert.ok(SELF_CHECK_CHILD_DELAY_MS > 0, "completion comes from the child's own timer, not its first statement");
	});
});

describe("selfCheckTools", () => {
	it("names the interpreter a console child runs, and the pause beside it", () => {
		assert.deepEqual(windowsTools, {
			interpreter: "C:\\Windows\\System32\\cmd.exe",
			pause: "C:\\Windows\\System32\\ping.exe",
		});
		// A machine whose system directory is elsewhere is followed, not overridden.
		assert.deepEqual(selfCheckTools("win32", { SystemRoot: "D:\\Win" }), {
			interpreter: "D:\\Win\\System32\\cmd.exe",
			pause: "D:\\Win\\System32\\ping.exe",
		});
		// The interpreter is not taken from the inherited environment's `ComSpec`: the
		// child is run with cmd's own argument line, and that name comes from here.
		assert.equal(
			selfCheckTools("win32", { SystemRoot: "C:\\Windows", ComSpec: "D:\\Tools\\sh.exe" }).interpreter,
			"C:\\Windows\\System32\\cmd.exe",
		);
		// No platform but Windows is claimed, so no interpreter is named for one.
		assert.deepEqual(selfCheckTools("linux", { SystemRoot: "C:\\Windows" }), { interpreter: null, pause: null });
	});
});

describe("selfCheckChild", () => {
	it("starts a console client, never this runtime's own executable", () => {
		// The measured false negative: `process.execPath` under the extension host is
		// `Code.exe`, and an Electron-as-node child writes nothing to its pseudo console,
		// so its markers could never arrive and a healthy console was refused.
		const child = selfCheckChild({ plan, tools: windowsTools, execPath: "C:\\Program Files\\Microsoft VS Code\\Code.exe" });
		assert.equal(child.file, "C:\\Windows\\System32\\cmd.exe");
		const line = child.args.join(" ");
		assert.ok(line.includes(plan.markers.start), line);
		assert.ok(line.includes(plan.markers.end), line);
		assert.ok(line.indexOf(plan.markers.start) < line.indexOf(plan.markers.end), "the start marker is echoed first");
		// The pause is a system tool named by absolute path: a bare `ping` is resolved
		// from `PATH`, where a toolchain can shadow it.
		assert.ok(line.includes("C:\\Windows\\System32\\ping.exe"), line);
		assert.equal(/(^|\s)ping\s/.test(line), false, "a bare `ping` would come from PATH");
	});

	it(
		"runs that command line for real, and prints both markers in order",
		{ skip: process.platform !== "win32" ? "the console child is Windows-only" : false },
		() => {
			const child = selfCheckChild({ plan, tools: selfCheckTools("win32", process.env), execPath: process.execPath });
			const run = spawnSync(child.file, [...child.args], { encoding: "utf8" });
			assert.equal(run.status, 0, run.stderr);
			assert.ok(run.stdout.includes(plan.markers.start), run.stdout);
			assert.ok(run.stdout.includes(plan.markers.end), run.stdout);
			assert.ok(
				run.stdout.indexOf(plan.markers.start) < run.stdout.indexOf(plan.markers.end),
				"the start marker is printed first",
			);
		},
	);

	it("falls back to this runtime's own executable only where no interpreter exists", () => {
		const child = selfCheckChild({ plan, tools: selfCheckTools("linux", {}), execPath: "/usr/bin/node" });
		assert.equal(child.file, "/usr/bin/node");
		assert.deepEqual(child.args, ["-e", plan.source]);
	});
});

/** One observation as the broker would build it; the defaults are a run that completed in time. */
function observe(fields: Partial<SelfCheckObservation>): SelfCheckObservation {
	return {
		output: `${plan.markers.start}\r\n${plan.markers.end}\r\n`,
		markers: plan.markers,
		exitReported: true,
		exitCode: 0,
		timedOut: false,
		deadlineMs: SELF_CHECK_DEADLINE_MS,
		...fields,
	};
}

describe("selfCheckVerdict", () => {
	const both = `${plan.markers.start}\r\n${plan.markers.end}\r\n`;

	it("accepts a child that proved both markers and reported a clean exit", () => {
		assert.deepEqual(selfCheckVerdict(observe({})), { ok: true, childExitCode: 0 });
	});

	it("accepts an unreported exit code only with both markers", () => {
		// The measured Windows case: the child ran to completion and its code is unknown.
		assert.deepEqual(selfCheckVerdict(observe({ exitCode: undefined })), { ok: true, childExitCode: null });
		// The same unreported code without the child's own proof proves nothing at all.
		const noProof = selfCheckVerdict(observe({ output: "", exitCode: undefined }));
		assert.equal(noProof.ok, false);
		assert.match(noProof.ok ? "" : noProof.detail, /did not prove itself/);
	});

	it("refuses a nonzero exit even when the child printed both markers", () => {
		const verdict = selfCheckVerdict(observe({ output: both, exitCode: 1 }));
		assert.equal(verdict.ok, false);
		assert.match(verdict.ok ? "" : verdict.detail, /exited with code 1/);
	});

	it("refuses a run that never proved its start, its completion, or either", () => {
		const cases: readonly (readonly [string, RegExp])[] = [
			[`${plan.markers.end}\r\n`, /start missing, completion seen/],
			[`${plan.markers.start}\r\n`, /start seen, completion missing/],
			["", /start missing, completion missing/],
			// Another run's markers, or a caller's own echo, are not this run's proof.
			[`${SELF_CHECK_MARKER}-ffffffffffffffff-start\r\n`, /start missing, completion missing/],
		];
		for (const [output, expected] of cases) {
			const verdict = selfCheckVerdict(observe({ output }));
			assert.equal(verdict.ok, false, `accepted ${JSON.stringify(output)}`);
			assert.match(verdict.ok ? "" : verdict.detail, expected);
		}
	});

	it("refuses a child whose end the backend never reported, even with both markers", () => {
		const verdict = selfCheckVerdict(observe({ exitReported: false, exitCode: undefined }));
		assert.equal(verdict.ok, false);
		assert.match(verdict.ok ? "" : verdict.detail, /did not report its exit/);
	});

	it("bounds the output one run keeps, and waits beyond the backend's measured flush", () => {
		assert.ok(SELF_CHECK_OUTPUT_LIMIT > 0 && SELF_CHECK_OUTPUT_LIMIT <= 64 * 1024);
		// The bundled backend's first child bytes were measured about three seconds after
		// the spawn, so a short window judged a working console before its markers arrived.
		assert.ok(
			SELF_CHECK_DEADLINE_MS >= 5_000,
			`${SELF_CHECK_DEADLINE_MS}ms is inside the measured first flush of child output`,
		);
	});
});

describe("selfCheckVerdict: a run that ran out of time", () => {
	const nothing = { output: "", exitCode: undefined } as const;

	it("is inconclusive, not broken, when only the default deadline passed with no fault observed", () => {
		// The measured symptom: under saturation the proof was late, nothing was wrong.
		const lateMarkers = selfCheckVerdict(observe({ ...nothing, timedOut: true }));
		assert.deepEqual(lateMarkers.ok ? null : lateMarkers.inconclusive, true);
		const lateExit = selfCheckVerdict(observe({ ...nothing, exitReported: false, timedOut: true }));
		assert.deepEqual(lateExit.ok ? null : lateExit.inconclusive, true);
		// Half a proof at the deadline is just as unfinished.
		const half = selfCheckVerdict(observe({ output: `${plan.markers.start}\r\n`, timedOut: true }));
		assert.deepEqual(half.ok ? null : half.inconclusive, true);
	});

	it("is broken once the extended window passed, so a console that delivers nothing is still caught", () => {
		for (const fields of [
			{ ...nothing, timedOut: true },
			{ ...nothing, exitReported: false, timedOut: true },
		] as const) {
			const verdict = selfCheckVerdict(observe({ ...fields, deadlineMs: SELF_CHECK_EXTENDED_DEADLINE_MS }));
			assert.equal(verdict.ok, false);
			assert.equal(verdict.ok ? null : verdict.inconclusive, false);
			assert.match(verdict.ok ? "" : verdict.detail, /90 s/);
		}
		assert.equal(selfCheckTimeoutMayBeLateness(SELF_CHECK_DEADLINE_MS), true);
		assert.equal(selfCheckTimeoutMayBeLateness(SELF_CHECK_EXTENDED_DEADLINE_MS), false);
	});

	it("is broken whenever a fault was observed, however little time was left", () => {
		// A nonzero code is evidence about the runtime, not lateness.
		const code = selfCheckVerdict(observe({ output: "", exitCode: 3, timedOut: true }));
		assert.equal(code.ok ? null : code.inconclusive, false);
		assert.match(code.ok ? "" : code.detail, /exited with code 3/);
	});

	it("a run that finished inside the deadline never reports lateness", () => {
		// Markers missing without a timeout cannot be explained by waiting longer.
		const verdict = selfCheckVerdict(observe({ output: "" }));
		assert.equal(verdict.ok ? null : verdict.inconclusive, false);
	});

	it("an extended run proves a late but complete child like any other", () => {
		assert.deepEqual(selfCheckVerdict(observe({ deadlineMs: SELF_CHECK_EXTENDED_DEADLINE_MS })), {
			ok: true,
			childExitCode: 0,
		});
	});
});

describe("watchPipeEcho: the pipe half of the self-check", () => {
	const line = JSON.stringify({ type: "pipe-check", token: "0123456789abcdef" });

	/** A pipe child driven by hand. */
	interface FakeChild extends EventEmitter {
		readonly stdin: EventEmitter & { readonly written: string[]; ended: boolean; write(data: string): void; end(): void };
		readonly stdout: EventEmitter & { setEncoding(): void };
		killed: boolean;
		kill(): void;
	}

	/** A fake child under watch, and a deadline that fires only when the test says so. */
	function harness(deadlineMs = SELF_CHECK_DEADLINE_MS): { readonly child: FakeChild; readonly result: Promise<unknown>; deadline(): void } {
		const child: FakeChild = Object.assign(new EventEmitter(), {
			stdin: Object.assign(new EventEmitter(), { written: [] as string[], ended: false, write(this: { written: string[] }, data: string) { this.written.push(data); }, end(this: { ended: boolean }) { this.ended = true; } }),
			stdout: Object.assign(new EventEmitter(), { setEncoding() {} }),
			killed: false,
			kill(this: { killed: boolean }) { this.killed = true; },
		});
		let fire: (() => void) | null = null;
		const timers = { setTimeout: (run: () => void) => { fire = run; return 1; }, clearTimeout: () => { fire = null; } };
		const result = watchPipeEcho(child, line, deadlineMs, timers).then(() => "proven", (error: unknown) => error);
		return { child, result, deadline: () => fire?.() };
	}

	it("proves an exact echo followed by a clean exit, and closes stdin once the line is back", async () => {
		const { child, result } = harness();
		assert.deepEqual(child.stdin.written, [`${line}\n`]);
		child.stdout.emit("data", line.slice(0, 10));
		assert.equal(child.stdin.ended, false, "half a line is not the echo yet");
		child.stdout.emit("data", `${line.slice(10)}\n`);
		assert.equal(child.stdin.ended, true);
		child.emit("exit", 0);
		child.emit("close", 0);
		assert.equal(await result, "proven");
	});

	it("is inconclusive only when the default deadline passes with nothing wrong observed", async () => {
		const { child, result, deadline } = harness();
		child.stdout.emit("data", line.slice(0, 5));
		deadline();
		const error = await result;
		assert.ok(error instanceof SelfCheckInconclusive, String(error));
		assert.equal(child.killed, true);
		const extended = harness(SELF_CHECK_EXTENDED_DEADLINE_MS);
		extended.deadline();
		const late = await extended.result;
		assert.ok(late instanceof Error && !(late instanceof SelfCheckInconclusive), "the extended window excuses nothing");
	});

	it("refuses every observed fault at once, so a later timeout can never excuse it", async () => {
		const faults: Array<[string, (child: FakeChild) => void, RegExp]> = [
			["a write error such as EPIPE", child => child.stdin.emit("error", new Error("write EPIPE")), /writing to the pipe child failed: write EPIPE/],
			["an echo that differs from the line", child => child.stdout.emit("data", `${line.slice(0, -1)}X`), /echoed something other/],
			["CRLF instead of the exact bytes", child => child.stdout.emit("data", `${line}\r\n`), /echoed something other/],
			["a nonzero exit while the pipes stay open", child => child.emit("exit", 3), /did not exit cleanly.*\(3\)/],
			["a close without the whole line", child => { child.stdout.emit("data", line); child.emit("close", 0); }, /did not echo the line/],
			["a spawn error", child => child.emit("error", new Error("spawn ENOENT")), /spawn ENOENT/],
		];
		for (const [name, act, expected] of faults) {
			const { child, result, deadline } = harness();
			act(child);
			deadline();
			const error = await result;
			assert.ok(error instanceof Error && !(error instanceof SelfCheckInconclusive), `${name}: ${String(error)}`);
			assert.match(error.message, expected, name);
			assert.equal(child.killed, true, `${name}: the child is ended`);
		}
	});
});

describe("selfCheckDeadlineFromArgs", () => {
	it("is the default without the flag and the flag's value with it", () => {
		assert.equal(selfCheckDeadlineFromArgs(["--self-check"]), SELF_CHECK_DEADLINE_MS);
		assert.equal(
			selfCheckDeadlineFromArgs(["--self-check", `${SELF_CHECK_DEADLINE_FLAG}=${SELF_CHECK_EXTENDED_DEADLINE_MS}`]),
			SELF_CHECK_EXTENDED_DEADLINE_MS,
		);
	});

	it("refuses a malformed, out-of-range or repeated value instead of falling back", () => {
		const bad = ["", "abc", "-1", "1.5", "1e4", "4999", String(SELF_CHECK_DEADLINE_MAX_MS + 1), "99999999"];
		for (const value of bad) {
			assert.throws(() => selfCheckDeadlineFromArgs([`${SELF_CHECK_DEADLINE_FLAG}=${value}`]), TypeError, value);
		}
		assert.throws(
			() => selfCheckDeadlineFromArgs([`${SELF_CHECK_DEADLINE_FLAG}=10000`, `${SELF_CHECK_DEADLINE_FLAG}=20000`]),
			TypeError,
		);
		// The bounds themselves are accepted.
		assert.equal(selfCheckDeadlineFromArgs([`${SELF_CHECK_DEADLINE_FLAG}=${SELF_CHECK_DEADLINE_MIN_MS}`]), SELF_CHECK_DEADLINE_MIN_MS);
		assert.equal(selfCheckDeadlineFromArgs([`${SELF_CHECK_DEADLINE_FLAG}=${SELF_CHECK_DEADLINE_MAX_MS}`]), SELF_CHECK_DEADLINE_MAX_MS);
	});

	it("keeps the extended window above the loaded measurement and inside the allowed range", () => {
		// Measured under saturation: a whole run took up to 14 s, each phase had 15 s.
		assert.ok(SELF_CHECK_EXTENDED_DEADLINE_MS >= 4 * SELF_CHECK_DEADLINE_MS);
		assert.ok(SELF_CHECK_EXTENDED_DEADLINE_MS <= SELF_CHECK_DEADLINE_MAX_MS);
	});
});
