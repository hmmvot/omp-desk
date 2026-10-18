import { mcpArgsSummary, mcpOutputText, mcpToolLabel, visibleMcpArgs } from "../../chat/mcp-tool";
import { JsonOutput, OutputText, Section, TextPreview } from "./tool-renderer-primitives";
import type { ToolRenderContext, ToolSemanticView } from "./tool-render-types";

/**
 * An MCP tool as OMP's terminal UI shows it (`pi-tui/src/tools/mcp.ts`): titled `server/tool`, the head's target a one-line
 * summary of the arguments, a JSON result as a folding tree and any other result as text. The card's footer carries the
 * truncation and artifact notices from the result's details, so the output here is shown without OMP's trailing notice.
 */
export function mcpTool(c: ToolRenderContext): ToolSemanticView {
	const args = visibleMcpArgs(c.args);
	const summary = mcpArgsSummary(args);
	const isError = c.isError || c.details.isError === true;
	const output = mcpOutputText(c.text, c.details);
	return { title: mcpToolLabel(c.name, c.details) ?? c.name, icon: "plug", family: "mcp", target: summary || undefined, tone: isError ? "error" : undefined,
		output: isError || !output ? undefined : { structured: output },
		body: <>
			{Object.keys(args).length > 0 && <Section title="Args"><JsonOutput value={args} expanded={c.expanded} id="args" /></Section>}
			{c.hasResult && (!output ? <div className="omp-empty-note">(no output)</div> : isError ? <div className="omp-native-error"><TextPreview text={output} expanded={c.expanded} /></div> : <OutputText text={output} expanded={c.expanded} />)}
		</> };
}
