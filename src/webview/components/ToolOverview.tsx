import type { ReactNode } from "react";
import type { ToolRun } from "../../chat/tool-overview";

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
	return <div className="omp-tool-overview" data-source-id={run.id}>
		<button type="button" className="omp-overview-head" aria-expanded={expanded} onClick={() => onExpandedChange(!expanded)} title={run.summary}>
			<span className={`codicon codicon-${expanded ? "chevron-down" : "chevron-right"}`} aria-hidden="true" />
			<span className={`codicon codicon-${run.runningCount ? "loading codicon-modifier-spin" : run.failureCount ? "error" : "tools"}`} aria-hidden="true" />
			<span className="omp-overview-summary">{run.summary}</span>
			{run.runningCount > 0 && <span className="omp-chip omp-chip--work">Running</span>}
		</button>
		{expanded && calls.total > 0 && <div className="omp-overview-actions" role="group" aria-label="Calls in this group">
			<button type="button" className="omp-output-more" aria-disabled={calls.open === calls.total ? true : undefined} onClick={() => { if (calls.open < calls.total) calls.setAll(true); }}>Expand all {calls.total}</button>
			<button type="button" className="omp-output-more" aria-disabled={calls.open === 0 ? true : undefined} onClick={() => { if (calls.open > 0) calls.setAll(false); }}>Collapse all</button>
		</div>}
	</div>;
}
