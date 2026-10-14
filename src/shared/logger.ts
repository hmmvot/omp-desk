/**
 * The one logging interface of the extension host: five levels, as VS Code's `LogOutputChannel` has them, and no
 * plain-string form. The channel adds its own time and level, so a message carries neither.
 *
 * Levels (the default shown in the OMP Desk output is Info; raise it with the gear of the Output panel or
 * **Developer: Set Log Level…** → OMP Desk):
 * - `error`: a failure that broke an action the user took.
 * - `warn`: degraded but continuing (a probe failed, a deadline passed, host control unavailable).
 * - `info`: lifecycle and summaries (activation, restore, attach, launch outcomes, settings moves).
 * - `debug`: high-frequency diagnostics (per-spawn, per-tab timing, lookups, bridge and focus traces).
 * - `trace`: anything noisier than that.
 *
 * Nothing here imports `vscode`.
 */
export interface Logger {
	error(message: string): void;
	warn(message: string): void;
	info(message: string): void;
	debug(message: string): void;
	trace(message: string): void;
}

export type LogLevel = "error" | "warn" | "info" | "debug" | "trace";

/** A logger that drops everything: the default of an optional `log` dependency and of tests that read no log. */
export const silentLogger: Logger = {
	error: () => {},
	warn: () => {},
	info: () => {},
	debug: () => {},
	trace: () => {},
};

/** A logger that writes `prefix` before every message of `base`, at the message's own level. */
export function prefixedLogger(base: Logger, prefix: string): Logger {
	return {
		error: message => base.error(prefix + message),
		warn: message => base.warn(prefix + message),
		info: message => base.info(prefix + message),
		debug: message => base.debug(prefix + message),
		trace: message => base.trace(prefix + message),
	};
}

/** One recorded line: its level and its text. */
export interface LoggedLine {
	readonly level: LogLevel;
	readonly message: string;
}

/** A logger that appends every message to `lines`, for tests that assert what was logged and at which level. */
export function recordingLogger(lines: LoggedLine[]): Logger {
	const record = (level: LogLevel) => (message: string): void => {
		lines.push({ level, message });
	};
	return { error: record("error"), warn: record("warn"), info: record("info"), debug: record("debug"), trace: record("trace") };
}
