/**
 * The shapes and wording of OMP's autoresearch tools (`init_experiment`, `run_experiment`, `log_experiment`,
 * `update_notes`) as its terminal UI shows them (`pi-tui/src/tools/autoresearch.ts`). The details are read defensively:
 * a result without the expected shape is shown as its text, as OMP does. Pure and DOM-free.
 */
import { isRecord } from "../shared/guards.ts";

const AUTORESEARCH_TOOLS: Readonly<Record<string, true>> = { init_experiment: true, run_experiment: true, log_experiment: true, update_notes: true };

export function isAutoresearchTool(name: string): boolean {
	return Object.hasOwn(AUTORESEARCH_TOOLS, name);
}

/** Command the benchmark harness runs (`DEFAULT_HARNESS_COMMAND`): `run_experiment` takes no command, only a timeout. */
export const HARNESS_COMMAND = "bash autoresearch.sh";

export type ExperimentStatus = "keep" | "discard" | "crash" | "checks_failed";
export type ExperimentTone = "success" | "warning" | "error";

export function isExperimentStatus(value: unknown): value is ExperimentStatus {
	return value === "keep" || value === "discard" || value === "crash" || value === "checks_failed";
}

/** A kept experiment succeeds, a discarded one warns, a crash or failed checks fail. */
export function experimentTone(status: ExperimentStatus): ExperimentTone {
	return status === "keep" ? "success" : status === "discard" ? "warning" : "error";
}

function commas(value: number): string {
	const digits = String(Math.trunc(Math.abs(value)));
	const groups: string[] = [];
	for (let end = digits.length; end > 0; end -= 3) groups.unshift(digits.slice(Math.max(0, end - 3), end));
	return `${value < 0 ? "-" : ""}${groups.join(",")}`;
}

function grouped(value: number, decimals: number): string {
	if (decimals <= 0) return commas(Math.round(value));
	const absolute = Math.abs(value);
	const whole = Math.floor(absolute);
	return `${value < 0 ? "-" : ""}${commas(whole)}${(absolute - whole).toFixed(decimals).slice(1)}`;
}

/** A metric value with its unit, `-` when absent: integers as they are, others to two decimals, digits grouped by thousands. */
export function formatMetric(value: number | null, unit: string): string {
	if (value === null) return "-";
	return `${grouped(value, Number.isInteger(value) ? 0 : 2)}${unit}`;
}

const num = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
const text = (value: unknown): string => typeof value === "string" ? value : "";

/** The first line of a free-form argument, for a one-line head. */
export function firstLine(value: unknown): string {
	const trimmed = text(value).trimStart();
	const end = trimmed.indexOf("\n");
	return (end < 0 ? trimmed : trimmed.slice(0, end)).trim();
}

export interface LoggedExperiment {
	readonly status: ExperimentStatus;
	readonly description: string;
	readonly metric: number | null;
	readonly metricName: string;
	readonly metricUnit: string;
	readonly baseline: number | null;
	readonly confidence: number | null;
	readonly scopeDeviations: readonly string[];
}

/** A `log_experiment` result's `LogDetails` (`experiment`, `state`, `scopeDeviations`), or `null` when it is not one. */
export function readLoggedExperiment(details: Record<string, unknown>): LoggedExperiment | null {
	const { experiment, state } = details;
	if (!isRecord(experiment) || !isRecord(state) || !isExperimentStatus(experiment.status)) return null;
	return {
		status: experiment.status,
		description: text(experiment.description),
		metric: num(experiment.metric),
		metricName: text(state.metricName),
		metricUnit: text(state.metricUnit),
		baseline: num(state.bestMetric),
		confidence: num(state.confidence),
		scopeDeviations: (Array.isArray(details.scopeDeviations) ? details.scopeDeviations : []).filter((item): item is string => typeof item === "string"),
	};
}

export interface ExperimentRun {
	readonly label: "PASS" | "FAIL" | "TIMEOUT";
	readonly tone: ExperimentTone;
	/** `12.4s`, `exit=2 12.4s` or `12.4s speed=1,200ms`: the duration with the exit code or the primary metric. */
	readonly summary: string;
	readonly tailOutput: string;
	readonly truncated: boolean;
	readonly fullOutputPath: string;
}

/** A finished `run_experiment` result's `RunDetails` (it names its `command` and `durationSeconds`), or `null`. */
export function readExperimentRun(details: Record<string, unknown>): ExperimentRun | null {
	const duration = num(details.durationSeconds);
	if (!("command" in details) || duration === null) return null;
	const seconds = `${duration.toFixed(1)}s`;
	const exitCode = details.exitCode === null ? null : num(details.exitCode);
	const primary = num(details.parsedPrimary);
	let label: ExperimentRun["label"] = "PASS";
	let summary = seconds;
	if (details.timedOut === true) label = "TIMEOUT";
	else if (exitCode !== 0) {
		label = "FAIL";
		summary = `exit=${exitCode} ${seconds}`;
	} else if (primary !== null) summary = `${seconds} ${text(details.metricName)}=${formatMetric(primary, text(details.metricUnit))}`;
	return { label, tone: label === "PASS" ? "success" : "error", summary, tailOutput: text(details.tailOutput), truncated: isRecord(details.truncation), fullOutputPath: text(details.fullOutputPath) };
}

/** The elapsed time of a running `run_experiment` (`RunExperimentProgressDetails`), or `null` for any other details. */
export function readExperimentProgress(details: Record<string, unknown>): string | null {
	return details.phase === "running" ? text(details.elapsed) : null;
}
