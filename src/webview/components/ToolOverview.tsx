import type { ReactNode } from "react";
import type { ToolRun } from "../../chat/tool-overview";

/** Group disclosure only; member rows belong to the outer measured transcript. */
export function ToolOverview({ run, expanded, onExpandedChange }: {
	run: ToolRun; expanded: boolean; onExpandedChange: (value: boolean) => void;
}): ReactNode {
	return <div className="omp-tool-overview" data-source-id={run.id}>
		<button type="button" className="omp-overview-head" aria-expanded={expanded} onClick={() => onExpandedChange(!expanded)} title={run.summary}>
			<span className={`codicon codicon-${expanded ? "chevron-down" : "chevron-right"}`} aria-hidden="true" />
			<span className={`codicon codicon-${run.runningCount ? "loading codicon-modifier-spin" : run.failureCount ? "error" : "tools"}`} aria-hidden="true" />
			<span className="omp-overview-summary">{run.summary}</span>
			{run.runningCount > 0 && <span className="omp-chip omp-chip--work">Running</span>}
		</button>
	</div>;
}
