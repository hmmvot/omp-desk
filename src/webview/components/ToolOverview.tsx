import type { ReactNode } from "react";
import type { ToolRun } from "../../chat/tool-overview";
import { formatToolGroupTime, toolGroupTime } from "../../chat/tool-group-time";
import { useSecondTick } from "../lib/live-clock";
import { peekObservedToolSpan, useObservedToolVersion } from "../lib/tool-view-state";

/** What an open group offers about its member calls: how many there are, how many are open, and a way to open or close them all. */
export interface OverviewCalls {
	readonly total: number;
	readonly open: number;
	readonly setAll: (open: boolean) => void;
}

/** Group disclosure, and for an open group Expand all N / Collapse all (each member's own disclosure, never the global tool mode); member rows belong to the outer measured transcript. */
export function ToolOverview({ run, expanded, onExpandedChange, calls }: {
	run: ToolRun; expanded: boolean; onExpandedChange: (value: boolean) => void; calls: OverviewCalls;
}): ReactNode {
	// The running group's clock rides the page's one shared second tick; a settled group does not tick. A watched call is recorded once, and redraws the header then.
	useSecondTick(run.runningCount > 0);
	useObservedToolVersion();
	const time = toolGroupTime(run.members, peekObservedToolSpan, Date.now());
	const took = time === null ? null : formatToolGroupTime(time);
	return <div className="omp-tool-overview" data-source-id={run.id}>
		<button type="button" className="omp-overview-head" aria-expanded={expanded} onClick={() => onExpandedChange(!expanded)} title={took === null ? run.summary : `${run.summary} · ${took}`}>
			<span className={`codicon codicon-${expanded ? "chevron-down" : "chevron-right"}`} aria-hidden="true" />
			<span className={`codicon codicon-${run.runningCount ? "loading codicon-modifier-spin" : run.failureCount ? "error" : "tools"}`} aria-hidden="true" />
			<span className="omp-overview-summary">{run.summary}</span>
			{took !== null && <span className="omp-overview-time">{took}</span>}
			{run.runningCount > 0 && <span className="omp-chip omp-chip--work">Running</span>}
		</button>
		{expanded && calls.total > 0 && <div className="omp-overview-actions" role="group" aria-label="Calls in this group">
			<button type="button" className="omp-output-more" aria-disabled={calls.open === calls.total ? true : undefined} onClick={() => { if (calls.open < calls.total) calls.setAll(true); }}>Expand all {calls.total}</button>
			<button type="button" className="omp-output-more" aria-disabled={calls.open === 0 ? true : undefined} onClick={() => { if (calls.open > 0) calls.setAll(false); }}>Collapse all</button>
		</div>}
	</div>;
}
