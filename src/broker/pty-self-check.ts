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
	/** The exit code the backend reported, or `undefined` when it reported none. */
	readonly exitCode: number | undefined;
}

/** Whether one run proved the backend, and what it observed. */
export type SelfCheckVerdict =
	| { readonly ok: true; readonly childExitCode: number | null }
	| { readonly ok: false; readonly detail: string };

/**
 * Decide one run from what it observed and nothing else.
 *
 * `exitCode` is what a reported exit carried; `undefined` means the backend reported an
 * exit without a code, which is the measured Windows case. Whether an exit was reported
 * at all is not visible here — a run that reported none before its deadline is refused
 * by the observer (`src/broker/pty-broker.ts`), because this event is the backend's own
 * notification that the child ended, not an independent reading of process absence.
 */
export function selfCheckVerdict(observation: SelfCheckObservation): SelfCheckVerdict {
	const startSeen = observation.output.includes(observation.markers.start);
	const endSeen = observation.output.includes(observation.markers.end);
	if (!startSeen || !endSeen) {
		return {
			ok: false,
			detail:
				`the self-check child did not prove itself through its pseudo console (start ${startSeen ? "seen" : "missing"}, ` +
				`completion ${endSeen ? "seen" : "missing"})`,
		};
	}
	if (observation.exitCode !== undefined && observation.exitCode !== 0) {
		return { ok: false, detail: `the self-check child exited with code ${observation.exitCode}` };
	}
	// Both markers arrived and the backend reported the child's exit. The code is
	// reported when this backend has one; the markers are what make an unreported code
	// acceptable.
	return { ok: true, childExitCode: observation.exitCode ?? null };
}
