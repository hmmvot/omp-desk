/**
 * The subagent `yield` tool ("Submit Result") as its card shows it, read the way OMP's terminal UI reads it
 * (`pi-tui/src/tools/yield.ts`): from the call's arguments and, once settled, from the result. Pure and DOM-free.
 * The same item shape (`type`, `data`, `status`, `error`) also arrives in a task row's `extractedToolData.yield`.
 */
import { isRecord } from "../shared/guards.ts";

export const YIELD_TITLE = "Submit Result";

export interface YieldSubmission {
	/** The workpool item (`item 3`) or the section labels (`findings, summary`) the call fills; absent for a whole result. */
	readonly target?: string;
	/** The accepted (normalised) data once settled, else the data as sent. */
	readonly data: unknown;
	/** The failure the call reports, or why the tool rejected it. */
	readonly error?: string;
	readonly settled: boolean;
	/** The tool accepted the call as an abort (an error without a workpool item). */
	readonly aborted: boolean;
	/** Accepted although it failed the output schema (after the in-tool retry budget). */
	readonly overridden: boolean;
	/** `13 fields`, `4 items`: the head fact for container data. */
	readonly size?: string;
	/** Where a settled call without data takes its result from. */
	readonly note?: string;
}

export interface YieldInput {
	/** The call's arguments (`type`, `data`, `error`, `key`); strict-mode providers send omitted optionals as `null`. */
	readonly args: Record<string, unknown>;
	/** The result's `details` (`YieldDetails`); read only when the result is not an error. */
	readonly details: Record<string, unknown>;
	/** The result text without OMP's notices. */
	readonly text: string;
	readonly isError: boolean;
	/** A final result (not a partial one) has arrived. */
	readonly settled: boolean;
}

/** The section labels of a yield's `type`: one label as a list of one, a list of labels as it is, anything else none. */
export function yieldLabels(type: unknown): string[] {
	return Array.isArray(type) ? type.filter((item): item is string => typeof item === "string") : typeof type === "string" ? [type] : [];
}

/** The yield items a value carries: one record or a list of them (`extractedToolData.yield` is either), as records. */
export function yieldItems(raw: unknown): Record<string, unknown>[] {
	return (Array.isArray(raw) ? raw : isRecord(raw) ? [raw] : []).filter(isRecord);
}

/** `13 fields`, `4 items` for container data; `undefined` for a scalar. */
export function yieldSize(data: unknown): string | undefined {
	const count = Array.isArray(data) ? { n: data.length, noun: "item" } : isRecord(data) ? { n: Object.keys(data).length, noun: "field" } : undefined;
	return count === undefined ? undefined : `${count.n.toLocaleString("en-US")} ${count.noun}${count.n === 1 ? "" : "s"}`;
}

export function readYieldSubmission(input: YieldInput): YieldSubmission {
	const { args, settled } = input;
	const details = input.isError ? {} : input.details;
	const type = details.type ?? args.type;
	const incremental = Array.isArray(type) && type.length > 0;
	const data = details.data !== undefined ? details.data : args.data ?? undefined;
	const text = input.text.trim();
	let error = typeof args.error === "string" && args.error !== "" ? args.error : undefined;
	let aborted = false;
	if (input.isError) error = text || `${YIELD_TITLE} failed`;
	else if (settled && details.status === "aborted") {
		aborted = true;
		error = typeof details.error === "string" && details.error !== "" ? details.error : text || "Aborted";
	}
	return {
		target: typeof args.key === "number" ? `item ${args.key}` : incremental ? yieldLabels(type).join(", ") || undefined : undefined,
		data,
		error,
		settled,
		aborted,
		overridden: details.schemaOverridden === true,
		size: yieldSize(data),
		note: settled && error === undefined && data === undefined
			? incremental ? "Takes the last message as this section" : "Ends with the sections submitted earlier, or the last message"
			: undefined,
	};
}
