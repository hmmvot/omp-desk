import type { OmpCliResult, OmpCommand } from "./native-terminal.ts";
import { isRecord } from "../shared/guards.ts";

/** The setting OMP's terminal UI waits on before it clears a fully closed TODO list from its widget (seconds; negative means never). */
export const TODO_CLEAR_DELAY_SETTING = "tasks.todoClearDelay";

/** `omp config get` loads OMP's settings and nothing else; a busy machine still answers well inside this. */
export const SETTING_READ_TIMEOUT_MS = 20_000;

export interface OmpSettingRead {
	/** `runOmpCli`, or a test double. */
	readonly run: (
		executable: OmpCommand,
		args: readonly string[],
		timeoutMs: number,
		options: { readonly cwd?: string; readonly env?: Readonly<Record<string, string>> },
	) => Promise<OmpCliResult>;
	readonly executable: OmpCommand;
	/** The folder the session runs in: OMP merges that folder's project settings over the global ones. */
	readonly cwd: string;
	/** The session's profile, named explicitly so an `OMP_PROFILE` this process inherited cannot decide it. */
	readonly env: Readonly<Record<string, string>>;
	readonly key: string;
}

/**
 * One OMP setting as the installed OMP itself reports it for a session's profile and folder: `omp config get <key> --json`,
 * run where the session runs, with the session's profile (the way provider usage is read for a Chat). Read-only: the command
 * never writes a setting. Resolves to the value exactly as OMP prints it (a number, a string, a boolean, ...); rejects when OMP
 * cannot run, exits non-zero, or prints something that is not the answer for `key`. Only the exit code, never OMP's output,
 * goes into the rejection.
 */
export async function readOmpSetting(input: OmpSettingRead): Promise<unknown> {
	const result = await input.run(input.executable, ["config", "get", input.key, "--json"], SETTING_READ_TIMEOUT_MS, { cwd: input.cwd, env: input.env });
	if (result.exitCode !== 0) throw new Error(`omp config get ${input.key} exited with ${result.exitCode}`);
	let parsed: unknown;
	try {
		parsed = JSON.parse(result.stdout);
	} catch {
		throw new Error(`omp config get ${input.key} printed no JSON`);
	}
	if (!isRecord(parsed) || parsed.key !== input.key || !("value" in parsed)) throw new Error(`omp config get ${input.key} answered for another setting`);
	return parsed.value;
}

export interface OmpSettingsRead extends Omit<OmpSettingRead, "key"> {
	/** The settings wanted; the rest of OMP's list is not looked at. */
	readonly keys: readonly string[];
}

/**
 * Several OMP settings with ONE `omp config list --json` call (an object keyed by setting id, each `{ value?, type, description }`),
 * run where the session runs, with the session's profile. Read-only. Resolves to the requested `keys` that OMP reports with a
 * `value`; a key OMP does not know, or lists without a value, is absent from the result (an OMP older than a setting reports
 * nothing for it). Rejects when OMP cannot run, exits non-zero, or prints something that is not an object of settings. Only the
 * exit code, never OMP's output, goes into the rejection.
 */
export async function readOmpSettings(input: OmpSettingsRead): Promise<Record<string, unknown>> {
	const result = await input.run(input.executable, ["config", "list", "--json"], SETTING_READ_TIMEOUT_MS, { cwd: input.cwd, env: input.env });
	if (result.exitCode !== 0) throw new Error(`omp config list exited with ${result.exitCode}`);
	let parsed: unknown;
	try {
		parsed = JSON.parse(result.stdout);
	} catch {
		throw new Error("omp config list printed no JSON");
	}
	if (!isRecord(parsed)) throw new Error("omp config list did not print an object of settings");
	const values: Record<string, unknown> = {};
	for (const key of input.keys) {
		if (!Object.hasOwn(parsed, key)) continue;
		const setting = parsed[key];
		if (isRecord(setting) && "value" in setting) values[key] = setting.value;
	}
	return values;
}
