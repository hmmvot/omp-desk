/**
 * Which carrier host control's Bun flags use for one launcher, decided by observation (ADR-0075).
 *
 * - A recognised bun shim (`launcher: "bun-shim"`) is Bun's own CLI: the flags go on the command line, as
 *   they always have. Nothing is probed.
 * - Anything else — OMP's own compiled program, or a launch a caller built by hand — is never given Bun's flags
 *   on its command line, where they would be OMP's unknown flags (`OMP exited with code 2`). Its flags travel in
 *   `BUN_OPTIONS`, and only after a harmless `omp --version` run has shown that this very executable honoured a
 *   preloaded module and a define carried that way. A definitive answer (the run succeeded and the nonce did or
 *   did not come back) is remembered per executable identity (path, size and modification time), so an update
 *   is probed again and nothing else is probed twice.
 * - A launcher that did not honour them gets no flags at all: the launch runs as OMP alone, and the session says
 *   once, per executable, that host control is unavailable.
 *
 * A probe that could not give an answer about the executable — it timed out, could not be created, or ended with
 * a non-zero exit code or a signal (on Windows a kill or a crash by something else is an exit code, not a signal) —
 * is not remembered: that launch runs without the flags, and the next launch asks again.
 */
import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { runOmpCli } from "./native-terminal";
import type { NativeControlBootstrap, OmpBinary, OmpCliResult, OmpCommand } from "./native-terminal";
import { controlRuntimeFlagSet, NO_RUNTIME_FLAGS, planRuntimeFlags } from "./runtime-flags";
import type { RuntimeFlagPlan } from "./runtime-flags";

/** Line the probe module (`media/runtime-probe.mjs`) writes to stderr: marker, space, the nonce it was given. */
export const RUNTIME_PROBE_MARKER = "OMP_DESK_RUNTIME_PROBE";
/** The identifier the probe nonce is defined as. */
export const RUNTIME_PROBE_DEFINE = "__OMP_VSCODE_PROBE_NONCE";
/** How long one probe may take; a compiled OMP's first start can be slow while a scanner reads it. */
const PROBE_TIMEOUT_MS = 15_000;

/** The injectable parts, so the choice is testable without a real launcher. */
export interface CarrierDeps {
	readonly run: (executable: OmpCommand, args: readonly string[], timeoutMs: number, options: { readonly cwd?: string; readonly env?: Readonly<Record<string, string>> }) => Promise<OmpCliResult>;
	readonly inheritedBunOptions: () => string | undefined;
	readonly identity: (binary: OmpCommand) => Promise<string>;
}

const defaultDeps: CarrierDeps = {
	run: runOmpCli,
	inheritedBunOptions: () => process.env.BUN_OPTIONS,
	identity: executableIdentity,
};

/**
 * The executable a launch stands for: its path, and the size and modification time of the file Windows would
 * run (the program, or the entry a runtime runs). Two paths to one file are two keys; a replaced file is a new one.
 */
export async function executableIdentity(binary: OmpCommand): Promise<string> {
	const files = [binary.command, ...binary.prefixArgs.slice(-1)];
	const parts: string[] = [];
	for (const file of files) {
		try {
			const stats = await fs.stat(file);
			parts.push(`${file}\u0000${stats.size}\u0000${stats.mtimeMs}`);
		} catch {
			parts.push(`${file}\u0000?`);
		}
	}
	const key = parts.join("\u0001");
	return process.platform === "win32" ? key.toLowerCase() : key;
}

/** What one probe established. `remember: false` is an answer about this run, not about the executable. */
interface ProbeAnswer {
	readonly honoured: boolean;
	readonly remember: boolean;
	readonly detail: string;
}

/** One probe answer kept per executable identity; plus the notices already shown. */
export class CarrierMemory {
	readonly #answers = new Map<string, Promise<ProbeAnswer>>();
	readonly #announced = new Set<string>();

	/** The remembered answer, or a probe run now (concurrent callers share it). An answer that is not remembered is forgotten at once. */
	async answer(key: string, probe: () => Promise<ProbeAnswer>): Promise<ProbeAnswer> {
		let pending = this.#answers.get(key);
		if (pending === undefined) {
			pending = probe().then(
				answer => {
					if (!answer.remember) this.#answers.delete(key);
					return answer;
				},
				(error: unknown) => {
					this.#answers.delete(key);
					throw error;
				},
			);
			this.#answers.set(key, pending);
		}
		return await pending;
	}

	/** True the first time a key is announced. */
	firstAnnouncement(key: string): boolean {
		if (this.#announced.has(key)) return false;
		this.#announced.add(key);
		return true;
	}
}

/** The window's memory; tests make their own. */
export const sharedCarrierMemory = new CarrierMemory();

/** What a launch decided about host control. */
export interface ControlLaunchPlan {
	/** Flags to put on the launch (`NO_RUNTIME_FLAGS` when none can be delivered or no control was asked for). */
	readonly runtime: RuntimeFlagPlan;
	/** Whether the host-control module will have the recipient: the host may connect. */
	readonly delivered: boolean;
	/** A sentence to show the user, once per executable and kind of answer; `null` when everything was delivered or nothing was asked. */
	readonly notice: string | null;
	/** The log line for this launch. */
	readonly log: string | null;
}

/**
 * Probe one executable: `omp --version` with the probe module preloaded and `nonce` defined, both carried in
 * `BUN_OPTIONS` exactly as a launch carries its own flags. Only the nonce coming back with exit code 0 admits it.
 */
async function probeBunOptions(binary: OmpCommand, control: NativeControlBootstrap, deps: CarrierDeps): Promise<ProbeAnswer> {
	const nonce = randomBytes(12).toString("hex");
	const plan = planRuntimeFlags({ define: { name: RUNTIME_PROBE_DEFINE, value: nonce }, preload: control.probeModulePath }, "bun-options", deps.inheritedBunOptions());
	const result = await deps.run(binary, ["--version"], PROBE_TIMEOUT_MS, { cwd: os.homedir(), env: plan.env });
	if (result.signal !== undefined) return { honoured: false, remember: false, detail: `its \`--version\` run was ended by ${result.signal}` };
	if (result.exitCode !== 0) return { honoured: false, remember: false, detail: `its \`--version\` run exited with code ${result.exitCode}` };
	if (`${result.stdout}\n${result.stderr}`.split(/\r?\n/).includes(`${RUNTIME_PROBE_MARKER} ${nonce}`)) return { honoured: true, remember: true, detail: "" };
	return { honoured: false, remember: true, detail: "its `--version` run did not report the preloaded module" };
}

/**
 * Decide how one launch carries host control. `control === null` asks for none. A launcher that does not honour
 * Bun's flags from `BUN_OPTIONS` yields `delivered: false` and a notice the first time per executable.
 */
export async function planControlLaunch(
	binary: OmpBinary | OmpCommand,
	control: NativeControlBootstrap | null,
	memory: CarrierMemory = sharedCarrierMemory,
	deps: CarrierDeps = defaultDeps,
): Promise<ControlLaunchPlan> {
	if (control === null) return { runtime: NO_RUNTIME_FLAGS, delivered: false, notice: null, log: null };
	const launcher = "launcher" in binary ? binary.launcher : undefined;
	if (launcher === "bun-shim") {
		return { runtime: planRuntimeFlags(controlRuntimeFlagSet(control), "argv", deps.inheritedBunOptions()), delivered: true, notice: null, log: null };
	}
	const identity = await deps.identity(binary);
	let answer: ProbeAnswer;
	try {
		answer = await memory.answer(identity, () => probeBunOptions(binary, control, deps));
	} catch (error) {
		answer = { honoured: false, remember: false, detail: `its launch options could not be checked (${error instanceof Error ? error.message : String(error)})` };
	}
	if (answer.honoured) {
		return { runtime: planRuntimeFlags(controlRuntimeFlagSet(control), "bun-options", deps.inheritedBunOptions()), delivered: true, notice: null, log: "host control delivered through BUN_OPTIONS" };
	}
	// A negative that is not remembered is a different statement from a definitive one, and shown separately.
	const notice = memory.firstAnnouncement(`${identity}\u0002${answer.remember ? "refused" : "unchecked"}`)
		? answer.remember
			? `${binary.command} does not accept the startup options OMP Desk uses for host control (${answer.detail}), so this session runs without it. ` +
				"Chat works; the model readback and subagent work indicators that need host control are unavailable, and a Terminal session loses its status tracking. An OMP installed through Bun keeps them."
			: `OMP Desk could not check whether ${binary.command} accepts the startup options host control needs (${answer.detail}), so this session runs without it. Chat works; start the session again to retry.`
		: null;
	return { runtime: NO_RUNTIME_FLAGS, delivered: false, notice, log: `host control not delivered: ${answer.detail}` };
}
