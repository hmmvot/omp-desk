import type { ReactNode } from "react";
import { runCss, type StyledRun } from "../lib/code-highlight.ts";

/** Runs of themed code as text and coloured spans; copying or selecting yields the plain text. */
export function CodeRuns({ runs }: { runs: readonly StyledRun[] }): ReactNode {
	return <>{runs.map((run, index) => (run.style === null ? run.text : <span key={index} style={runCss(run.style)}>{run.text}</span>))}</>;
}
