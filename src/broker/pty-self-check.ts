/**
 * The positive proof a PTY self-check must produce
 * ([ADR-0024](../../docs/decisions/0024-own-omp-pty-for-in-tab-terminal.md)).
 *
 * The staged runtime proves itself by starting one real child through its own PTY
 * backend before a user's session is allowed to run in it. What that proof is made of
 * is decided here, so it is one contract shared by the broker that observes a run and
 * the host gate that admits the tree:
 *
 * - the child is a plain console client — the command interpreter a folder-shell
 *   terminal itself runs, never this runtime's own executable ({@link selfCheckChild}
 *   records the measurement that rules that out) — and it prints two markers, minted
 *   for this one run, through its pseudo console before it exits;
 * - the markers and the exit report are each half of the proof. An exit report without
 *   the markers says only that something ended, which is exactly what a backend that
 *   delivered nothing to the child would also produce, and markers without the exit
 *   report say the child printed but not that the backend saw it end. The report is this
 *   backend's own notification, not an independent reading of process absence, and
 *   nothing here claims one.
 *
 * The exit *code* is deliberately not the proof. The Windows ConPTY backend does not
 * always report one, and a runtime that this gate wrongly refused was measured doing
 * exactly that. A code the backend does report must be zero, and an unreported code is
 * accepted only together with both markers — never by itself, and never for a run that
 * reported a nonzero code.
 */

import { silentLogger } from "../shared/logger.ts";
import { startWin32Native } from "../host/win32-native.ts";

/** Namespace of both markers, so one observed here is ours and not a child's own text. */
export const SELF_CHECK_MARKER = "omp-pty-check";

/** The longest token a marker may carry: the whole marker must fit one console line. */
export const SELF_CHECK_TOKEN_MAX = 16;

/** Bound on the output one self-check run keeps, so a noisy child cannot grow it. */
export const SELF_CHECK_OUTPUT_LIMIT = 8 * 1024;

/** How long the node child waits between printing its two markers. */
export const SELF_CHECK_CHILD_DELAY_MS = 40;

/**
 * How long one run waits for its whole proof: the child's markers and the backend's
 * exit report together.
 *
 * The bundled ConPTY backend's first flush of *child* output was measured at about
 * three seconds after the spawn on a VS Code installation (its terminal queries
 * arrive at once; the child's own bytes do not), the child's own pause adds about a
 * second, and the exit report can arrive before either marker. One deadline therefore
 * covers both halves instead of a moment sampled after the exit. A run that reaches it
 * without the whole proof fails; the host that started this entry additionally kills
 * it after a longer bound of its own (`src/host/pty-runtime.ts`).
 */
export const SELF_CHECK_DEADLINE_MS = 15_000;

/**
 * The deadline the host asks for when it re-runs a probe that was inconclusive
 * ({@link SelfCheckInconclusive}). Measured under saturation (twice the logical
 * processors spinning at normal priority) one run took 8 to 14 s against an unloaded
 * 4.3 s, and a run on a loaded machine with other windows starting missed the 15 s
 * bound of its pipe phase; six times the unloaded cost covers that without waiting
 * indefinitely on a tree that really delivers nothing.
 */
export const SELF_CHECK_EXTENDED_DEADLINE_MS = 90_000;

/** Command-line flag carrying a deadline other than {@link SELF_CHECK_DEADLINE_MS}. */
export const SELF_CHECK_DEADLINE_FLAG = "--self-check-deadline-ms";

/** The shortest and longest deadline the flag may carry; the shortest is above the measured first flush. */
export const SELF_CHECK_DEADLINE_MIN_MS = 5_000;
export const SELF_CHECK_DEADLINE_MAX_MS = 300_000;

/**
 * The deadline one run is asked for: the default when the flag is absent, otherwise the
 * flag's whole-number milliseconds inside the allowed range. A malformed or
 * out-of-range value is an error, never silently replaced by the default, so a caller
 * that asked for a longer budget cannot believe it got one.
 */
export function selfCheckDeadlineFromArgs(args: readonly string[]): number {
	const prefix = `${SELF_CHECK_DEADLINE_FLAG}=`;
	const given = args.filter(argument => argument.startsWith(prefix));
	if (given.length === 0) return SELF_CHECK_DEADLINE_MS;
	if (given.length > 1) throw new TypeError(`${SELF_CHECK_DEADLINE_FLAG} may be given once`);
	const text = given[0]!.slice(prefix.length);
	const value = /^[0-9]{1,7}$/.test(text) ? Number(text) : Number.NaN;
	if (!Number.isSafeInteger(value) || value < SELF_CHECK_DEADLINE_MIN_MS || value > SELF_CHECK_DEADLINE_MAX_MS) {
		throw new TypeError(
			`${SELF_CHECK_DEADLINE_FLAG} takes whole milliseconds from ${SELF_CHECK_DEADLINE_MIN_MS} to ${SELF_CHECK_DEADLINE_MAX_MS}`,
		);
	}
	return value;
}

/** Command-line flags carrying the staged native module a run loads (ADR-0076). */
export const SELF_CHECK_NATIVE_FLAG = "--native";
export const SELF_CHECK_NATIVE_DIGEST_FLAG = "--native-sha256";

/**
 * The native module this run was given, loaded the way a broker loads it, and one creation
 * time read through it (this process's own, which must be `found`). A runtime that cannot
 * load the addon, or whose addon cannot answer, must not be proven: every identity reading
 * and every stop's absence evidence of a broker started in it would be `unknown`. Throws a
 * refusal naming the cause; the module's own one-line failure log is the cause when it has one.
 */
export async function proveNativeCreationTime(args: readonly string[]): Promise<void> {
	const value = (flag: string): string | undefined => {
		const index = args.indexOf(flag);
		return index < 0 ? undefined : args[index + 1];
	};
	const path = value(SELF_CHECK_NATIVE_FLAG);
	const sha256 = value(SELF_CHECK_NATIVE_DIGEST_FLAG);
	if (path === undefined || sha256 === undefined) {
		throw new Error(`${SELF_CHECK_NATIVE_FLAG} and ${SELF_CHECK_NATIVE_DIGEST_FLAG} are required: the runtime cannot be proven without its native module`);
	}
	const causes: string[] = [];
	const native = await startWin32Native(async () => ({ path, sha256 }), { ...silentLogger, warn: message => causes.push(message) });
	if (native === null) throw new Error(causes[0] ?? "the native module is unavailable");
	const reading = native.processCreation(process.pid);
	if (reading.kind !== "found") {
		throw new Error(`the native module could not read this process's creation time (${reading.kind === "unknown" ? reading.detail : "gone"})`);
	}
}

/**
 * A probe that ran out of time with nothing contradicting the runtime.
 *
 * Reaching a deadline is not evidence of a broken runtime: a saturated machine starts
 * processes and flushes pseudo-console output late. It is also not evidence of a good
 * one. The entry reports it as `outcome: "inconclusive"` (exit 8), distinct from a run
 * that *observed* a fault — an addon that does not load, a child that cannot be
 * started, a nonzero exit, a pipe child that echoed something else — which is
 * `outcome: "broken"` (exit 7). The host admits the former provisionally and keeps
 * probing, and refuses the latter (ADR-0032, 2026-10-12 amendment).
 */
export class SelfCheckInconclusive extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SelfCheckInconclusive";
	}
}

/** The two markers one self-check run's child must print, in order. */
export interface SelfCheckMarkers {
	/** Printed as soon as the child runs, so the data path is proven early. */
	readonly start: string;
	/** Printed after the child's own pause, so a live child's stream is proven too. */
	readonly end: string;
}

/** The markers and the child script of one self-check run. */
export interface SelfCheckPlan {
	readonly markers: SelfCheckMarkers;
	/** The script the node child runs; the command interpreter's line is built from the markers. */
	readonly source: string;
}

/**
 * Plan one run from a per-run token.
 *
 * The markers carry the token, so a marker observed in this run's output can only have
 * come from this run's own child: no earlier output, no echo of a caller's own write
 * and no other process's text can satisfy the check. The token is bounded so both
 * markers stay shorter than the check's console width, because a marker a pseudo
 * console wrapped would never appear contiguously in the stream and could never be read
 * back.
 *
 * @throws TypeError when the token is not 1..{@link SELF_CHECK_TOKEN_MAX} lowercase hex
 *   characters, which is what keeps a marker inside one console line.
 */
export function selfCheckPlan(token: string): SelfCheckPlan {
	if (!/^[0-9a-f]{1,16}$/.test(token)) throw new TypeError("a self-check token is 1 to 16 lowercase hex characters");
	const start = `${SELF_CHECK_MARKER}-${token}-start`;
	const end = `${SELF_CHECK_MARKER}-${token}-end`;
	return {
		markers: { start, end },
		// The child proves the data path first and completion second: the second marker
		// comes from a timer, so a child that died before its timer never prints it.
		source:
			`process.stdout.write(${JSON.stringify(`${start}\n`)});` +
			`setTimeout(function(){process.stdout.write(${JSON.stringify(`${end}\n`)});process.exit(0)},${SELF_CHECK_CHILD_DELAY_MS});`,
	};
}

/** The child one self-check run starts, and the arguments that make it print its markers. */
export interface SelfCheckChild {
	readonly file: string;
	readonly args: readonly string[];
}

/** The console programs one run's child is built from, or `null`s where it is a node child. */
export interface SelfCheckTools {
	/** The platform's command interpreter, or `null` where the check uses a node child. */
	readonly interpreter: string | null;
	/** A console program that spends about a second without reading input, or `null` for no pause. */
	readonly pause: string | null;
}

/**
 * The console programs this platform's self-check child runs.
 *
 * The interpreter is the same one a folder-shell terminal runs, so the self-check starts
 * the kind of child a session actually starts. Both are absolute paths under the
 * platform's own system directory, because a toolchain earlier on `PATH` can shadow a
 * bare system tool (a shadowed `whoami` prints an account without its machine, for
 * example). The interpreter is named by this module rather than taken from `ComSpec`,
 * which this process inherits from whatever environment started the extension host,
 * and the child is run with `cmd.exe`'s own argument line.
 */
export function selfCheckTools(
	platform: NodeJS.Platform,
	env: Readonly<Record<string, string | undefined>>,
): SelfCheckTools {
	if (platform !== "win32") return { interpreter: null, pause: null };
	const root = typeof env.SystemRoot === "string" && env.SystemRoot.length > 0 ? env.SystemRoot : "C:\\Windows";
	// The pause is a loopback `ping` to this same console: it is the system tool that
	// waits a fixed moment without needing input or a console to send to.
	return { interpreter: `${root}\\System32\\cmd.exe`, pause: `${root}\\System32\\ping.exe` };
}

/**
 * The child this run starts, with the command that prints its markers.
 *
 * It is deliberately **not** this runtime's own executable. The extension host is
 * Electron and starts the broker with `ELECTRON_RUN_AS_NODE=1`, so `process.execPath` is
 * `Code.exe` — and an Electron-as-node process attached to a pseudo console writes
 * nothing to it, whatever the backend: measured on the installed runtime, the child's
 * script ran (it proved so through a side effect of its own) and the child exited, while
 * the console delivered no byte at all and the exit code came back `undefined`; the same
 * script under plain node printed both markers. A check that spawned `process.execPath`
 * therefore proved nothing about the console and refused a runtime whose console was
 * fine. What the native-addon ABI check actually needs is the *parent* — the broker
 * loading the addon in the runtime a session runs under — and the parent is the one
 * process here that is not spawned through the console.
 *
 * On Windows the child is the command interpreter (`cmd.exe`), a real console client:
 * it prints both markers through the console, pauses between them, and exits. `/d`
 * skips the machine's AutoRun commands, so what prints the markers is this line and
 * nothing a registry setting added.
 */
export function selfCheckChild(input: {
	readonly plan: SelfCheckPlan;
	readonly tools: SelfCheckTools;
	/** This runtime's own executable, used only where there is no interpreter. */
	readonly execPath: string;
}): SelfCheckChild {
	if (input.tools.interpreter === null) return { file: input.execPath, args: ["-e", input.plan.source] };
	// The second `echo` runs whether or not the pause does, so a machine without it still
	// reaches both markers; the pause is what keeps a proven stream from looking like one
	// teardown flush. Both tool paths are left unquoted: a quoted path inside `/c` reaches
	// cmd escaped — measured — and fails as an unknown command, silently dropping the pause.
	const pause = input.tools.pause === null ? "" : `${input.tools.pause} -n 2 127.0.0.1 >nul& `;
	return {
		file: input.tools.interpreter,
		args: ["/d", "/s", "/c", `echo ${input.plan.markers.start}& ${pause}echo ${input.plan.markers.end}`],
	};
}

/** What one self-check run observed. */
export interface SelfCheckObservation {
	/** Everything the pseudo console delivered from the child, as text. */
	readonly output: string;
	readonly markers: SelfCheckMarkers;
	/** Whether the backend reported that the child ended. */
	readonly exitReported: boolean;
	/** The exit code the backend reported, or `undefined` when it reported none. */
	readonly exitCode: number | undefined;
	/** The run stopped waiting because its deadline ran out, not because the proof was complete. */
	readonly timedOut: boolean;
	/** The deadline this run was given. */
	readonly deadlineMs: number;
}

/**
 * Whether a run that ran out of time may only have been late.
 *
 * Reaching the default deadline can be lateness: a saturated machine starts processes and
 * flushes pseudo-console output late (measured 8 to 14 s against 4.3 s unloaded). A run
 * that was already given the extended window ({@link SELF_CHECK_EXTENDED_DEADLINE_MS})
 * and still did not finish has no such excuse: its timeout is a refusal.
 */
export function selfCheckTimeoutMayBeLateness(deadlineMs: number): boolean {
	return deadlineMs < SELF_CHECK_EXTENDED_DEADLINE_MS;
}

/** The entry's exit code for an inconclusive run; the host admits nothing else as lateness. */
export const SELF_CHECK_INCONCLUSIVE_EXIT = 8;

/**
 * Whether what the pipe child echoed so far already contradicts the line it was given.
 *
 * The echo child writes back exactly the bytes it read, so the whole echo must be
 * `line` and one `\n`. Echo that is still a prefix of that (nothing, or a partial flush)
 * is only late; any other byte is a fault the runtime showed.
 */
export function pipeEchoContradicts(echoed: string, line: string): boolean {
	return !`${line}\n`.startsWith(echoed);
}

/** The parts of a spawned pipe child {@link watchPipeEcho} uses; a `ChildProcess` with piped stdio fits. */
export interface PipeEchoChild {
	readonly stdin: { write(data: string): unknown; end(): unknown; on(event: "error", listener: (error: Error) => void): unknown };
	readonly stdout: { setEncoding(encoding: "utf8"): unknown; on(event: "data", listener: (chunk: string) => void): unknown };
	once(event: "error", listener: (error: Error) => void): unknown;
	once(event: "exit" | "close", listener: (code: number | null) => void): unknown;
	kill(): unknown;
}

/** Test seam for {@link watchPipeEcho}'s deadline. */
export interface PipeEchoTimers {
	setTimeout(run: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

const REAL_TIMERS: PipeEchoTimers = {
	setTimeout: (run, ms) => setTimeout(run, ms),
	clearTimeout: handle => clearTimeout(handle as NodeJS.Timeout),
};

/**
 * Prove the pipe path with one echo child: write `line`, read it back exactly, close
 * stdin, and see the child exit 0.
 *
 * Every fault is a refusal the moment it is observed — a write error, an echo that is
 * not a prefix of the line, an exit with any code other than 0, an incomplete echo at
 * close. Only a deadline reached with nothing of that observed rejects with
 * {@link SelfCheckInconclusive}, and only when the deadline may excuse lateness
 * ({@link selfCheckTimeoutMayBeLateness}).
 */
export function watchPipeEcho(
	child: PipeEchoChild,
	line: string,
	deadlineMs: number,
	timers: PipeEchoTimers = REAL_TIMERS,
): Promise<void> {
	const outcome = Promise.withResolvers<void>();
	let settled = false;
	let echoed = "";
	let exitCode: number | null | undefined;
	const settle = (error: Error | null): void => {
		if (settled) return;
		settled = true;
		timers.clearTimeout(deadline);
		if (error === null) {
			outcome.resolve();
			return;
		}
		child.kill();
		outcome.reject(error);
	};
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", chunk => {
		echoed += chunk;
		if (pipeEchoContradicts(echoed, line)) settle(new Error("the pipe child echoed something other than the line it was given"));
		else if (echoed.endsWith("\n")) child.stdin.end();
	});
	child.stdin.on("error", error => settle(new Error(`writing to the pipe child failed: ${error.message}`)));
	child.once("error", error => settle(error));
	child.once("exit", code => {
		exitCode = code;
		if (code !== 0) settle(new Error(`the pipe child did not exit cleanly after its stdin closed (${String(code)})`));
	});
	child.once("close", code => {
		if (echoed !== `${line}\n`) settle(new Error("the pipe child did not echo the line it was given"));
		else if ((exitCode ?? code) !== 0) settle(new Error(`the pipe child did not exit cleanly after its stdin closed (${String(exitCode ?? code)})`));
		else settle(null);
	});
	const deadline = timers.setTimeout(() => {
		const detail = `the pipe child did not finish within the self-check deadline of ${Math.round(deadlineMs / 1000)} s`;
		settle(selfCheckTimeoutMayBeLateness(deadlineMs) ? new SelfCheckInconclusive(detail) : new Error(detail));
	}, deadlineMs);
	child.stdin.write(`${line}\n`);
	return outcome.promise;
}

/**
 * Whether one run proved the backend, and what it observed.
 *
 * A refusal is `inconclusive` only when the run ran out of time *and* nothing it did
 * observe contradicts the runtime (no nonzero exit code), *and* the deadline was short
 * enough for lateness to explain it ({@link selfCheckTimeoutMayBeLateness}). Every
 * other refusal observed a fault, or waited out the extended window, and is final.
 */
export type SelfCheckVerdict =
	| { readonly ok: true; readonly childExitCode: number | null }
	| { readonly ok: false; readonly detail: string; readonly inconclusive: boolean };

/**
 * Decide one run from what it observed and nothing else.
 *
 * `exitCode` is what a reported exit carried; `undefined` means the backend reported an
 * exit without a code, which is the measured Windows case. A reported exit is this
 * backend's own notification that the child ended, not an independent reading of
 * process absence, and it is only half of the proof: the child's own markers are the
 * other half.
 */
export function selfCheckVerdict(observation: SelfCheckObservation): SelfCheckVerdict {
	// A code the backend did report is evidence about the runtime however the rest went.
	if (observation.exitReported && observation.exitCode !== undefined && observation.exitCode !== 0) {
		return { ok: false, detail: `the self-check child exited with code ${observation.exitCode}`, inconclusive: false };
	}
	const startSeen = observation.output.includes(observation.markers.start);
	const endSeen = observation.output.includes(observation.markers.end);
	const markers = `start ${startSeen ? "seen" : "missing"}, completion ${endSeen ? "seen" : "missing"}`;
	const late = observation.timedOut && selfCheckTimeoutMayBeLateness(observation.deadlineMs);
	const window = `${Math.round(observation.deadlineMs / 1000)} s`;
	if (!observation.exitReported) {
		return {
			ok: false,
			detail: `the self-check child did not report its exit within the self-check deadline of ${window} (${markers})`,
			inconclusive: late,
		};
	}
	if (!startSeen || !endSeen) {
		// The backend reported the child's end, so what is missing is bytes, not a
		// process: the measured first flush is about three seconds.
		return {
			ok: false,
			detail: `the self-check child did not prove itself through its pseudo console within ${window} (${markers})`,
			inconclusive: late,
		};
	}
	// Both markers arrived and the backend reported the child's exit. The code is
	// reported when this backend has one; the markers are what make an unreported code
	// acceptable.
	return { ok: true, childExitCode: observation.exitCode ?? null };
}
