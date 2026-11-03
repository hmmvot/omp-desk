/**
 * How long a group of tool calls took, for the group's header. Pure and DOM-free.
 *
 * The rule is the **time during which at least one call of the group was executing**: each call is an interval, the intervals are merged
 * (overlaps count once) and their lengths added. Calls that ran in parallel therefore count as the stretch they filled together (a plain sum
 * of the rows' times would exceed the clock), calls that ran one after the other add up, and the pauses between them (the model deciding on
 * its next call) are left out, so the number is "how long this group's tools worked", not how long the turn took.
 *
 * Where an interval comes from, best source first, as the rows' own gists do (`tool-gist.ts`):
 * 1. this page watched the call run (`observed`): exact;
 * 2. the call's start was seen live and its result is in, or it still runs (then it ends now): exact;
 * 3. the timestamp of the assistant entry that made the call up to its result's timestamp: derived, so the total is marked `≈`.
 * Calls that never ran (skipped, queued, a request that failed before the call) add nothing. A call that ran but whose interval cannot be
 * known (a result that was not saved, a running call whose start this page did not see) makes the whole total unknown: a number that leaves
 * it out would be wrong, so none is shown. Like the rows, a total of 1.5 s or less is not shown either.
 */
import { DERIVED_DURATION_FLOOR_MS, formatGistDuration } from "./tool-gist.ts";
import type { OverviewMember } from "./tool-overview.ts";

/** When a page that watched a call run saw it start and end, on its own clock. */
export interface ObservedSpan { readonly start: number; readonly end: number }

export interface ToolGroupTime {
	readonly ms: number;
	/** Some interval is derived from saved timestamps rather than watched, so the number is an approximation. */
	readonly approximate: boolean;
}

/** The group's execution time, or `null` when it is unknown or not worth saying. `now` is the page clock and ends the calls that still run. */
export function toolGroupTime(members: readonly OverviewMember[], observed: (callId: string) => ObservedSpan | undefined, now: number): ToolGroupTime | null {
	const spans: [number, number][] = [];
	let approximate = false;
	for (const member of members) {
		if (member.kind !== "tool") continue;
		const { tool } = member;
		const running = tool.status === "running" && tool.result === undefined;
		// Never started: skipped, queued behind others, or the request that made the call failed.
		if (!running && tool.result === undefined && tool.status !== "complete") continue;
		if (tool.result !== undefined && tool.status === "skipped") continue;
		const watched = observed(tool.call.id);
		const seen = tool.active?.startObserved === true ? tool.active.startedAt : undefined;
		const ended = tool.result?.timestamp;
		if (watched !== undefined) { spans.push([watched.start, watched.end]); continue; }
		if (running) {
			if (seen === undefined) return null;
			spans.push([seen, Math.max(seen, now)]);
			continue;
		}
		if (typeof ended !== "number" || !Number.isFinite(ended)) return null;
		if (seen !== undefined) { spans.push([seen, Math.max(seen, ended)]); continue; }
		if (tool.startedAt === undefined || !Number.isFinite(tool.startedAt) || ended < tool.startedAt) return null;
		spans.push([tool.startedAt, ended]);
		approximate = true;
	}
	if (spans.length === 0) return null;
	spans.sort((a, b) => a[0] - b[0]);
	let total = 0;
	let [from, to] = spans[0]!;
	for (const [start, end] of spans.slice(1)) {
		if (start > to) { total += to - from; from = start; to = end; }
		else if (end > to) to = end;
	}
	total += to - from;
	const ms = Math.round(total);
	return ms > DERIVED_DURATION_FLOOR_MS ? { ms, approximate } : null;
}

/** `4.20 s`, or `≈ 4.20 s` for a derived total: the rows' own format. */
export function formatToolGroupTime(time: ToolGroupTime): string {
	return `${time.approximate ? "≈ " : ""}${formatGistDuration(time.ms)}`;
}
