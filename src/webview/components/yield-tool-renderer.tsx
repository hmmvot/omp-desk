import type { ReactNode } from "react";
import { readYieldSubmission, YIELD_TITLE } from "../../chat/yield-submission";
import { JsonOutput, TextPreview } from "./tool-renderer-primitives";
import type { ToolRenderContext, ToolSemanticView } from "./tool-render-types";

/**
 * The subagent `yield` tool as OMP's terminal UI shows it (`pi-tui/src/tools/yield.ts`): the submitted data in place of the
 * tool's own acknowledgement. A string is a report (Markdown), anything else a folding tree; a rejected or aborted call shows
 * its error in full; a call accepted although it failed the output schema says so in the head.
 */
function YieldData({ data, expanded }: { data: unknown; expanded: boolean }): ReactNode {
	if (data === undefined) return null;
	if (typeof data === "string") return data.trim() ? <TextPreview text={data} expanded={expanded} prose /> : <div className="omp-empty-note">(empty)</div>;
	return <JsonOutput value={data} expanded={expanded} id="yield.data" />;
}

export function yieldTool(c: ToolRenderContext): ToolSemanticView {
	const submission = readYieldSubmission({ args: c.args, details: c.details, text: c.text, isError: c.isError, settled: c.hasResult && !c.partial });
	const failed = submission.settled && submission.error !== undefined;
	return { title: YIELD_TITLE, family: "yield", target: submission.target,
		meta: [submission.size, submission.aborted ? "aborted" : undefined].filter((fact): fact is string => fact !== undefined),
		tone: failed ? "error" : undefined,
		inline: submission.overridden ? <span className="omp-chip omp-chip--warn"><span className="codicon codicon-warning" aria-hidden="true" />schema overridden</span> : undefined,
		body: <>
			{submission.error !== undefined && <div className="omp-native-error omp-tool-wrap">{submission.error}</div>}
			<YieldData data={submission.data} expanded={c.expanded} />
			{submission.note !== undefined && <div className="omp-empty-note">{submission.note}</div>}
		</> };
}
