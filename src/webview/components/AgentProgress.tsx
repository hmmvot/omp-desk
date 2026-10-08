import type { ReactNode } from "react";
import type { AgentActivity } from "../../chat/agents";
import { fmtDuration, fmtTokens } from "../lib/format";
import { useLiveDurations } from "../lib/live-clock";
import { isRecord } from "../../guards";
import { agentActivityText } from "../../chat/hud-summary";

export interface AgentProgressViewProps {
	progress: Record<string, unknown>;
	activity?: AgentActivity;
	/** False where the caller already shows the current tool and intent on a line of its own; the stats stay. */
	showActivity?: boolean;
	/** True where the agent is running in a live session: its duration then ticks once a second between progress events instead of freezing. */
	live?: boolean;
	/** The duration the caller already shows and ticks (null for none); it replaces the view's own clock so both read the same. */
	elapsedMs?: number | null;
	/** False where elapsed time is already shown in the row or tab heading. */
	showElapsed?: boolean;
}

/** Native agent counters and current/last intent, never the transported progress record. */
export function AgentProgressView({ progress, activity, showActivity = true, showElapsed = true, live = false, elapsedMs }: AgentProgressViewProps): ReactNode {
	const id = typeof progress.id === "string" ? progress.id : "";
	const durationOf = useLiveDurations([{ id, reportedMs: typeof progress.durationMs === "number" ? progress.durationMs : undefined, running: progress.status === "running" }], live && elapsedMs === undefined);
	const current = showActivity ? agentActivityText(progress, activity) : "";
	const stats: string[] = [];
	if (typeof progress.toolCount === "number" && progress.toolCount > 0) stats.push(`${fmtTokens(progress.toolCount)} ${progress.toolCount === 1 ? "tool" : "tools"}`);
	if (typeof progress.requests === "number" && progress.requests > 0) stats.push(`${fmtTokens(progress.requests)} req`);
	if (typeof progress.tokens === "number" && progress.tokens > 0) stats.push(`${fmtTokens(progress.tokens)} tokens`);
	if (typeof progress.contextTokens === "number" && progress.contextTokens > 0) {
		stats.push(`context ${fmtTokens(progress.contextTokens)}${typeof progress.contextWindow === "number" && progress.contextWindow > 0 ? `/${fmtTokens(progress.contextWindow)}` : ""}`);
	}
	const usageCost = isRecord(progress.usage) && isRecord(progress.usage.cost) ? progress.usage.cost.total : undefined;
	const cost = typeof progress.cost === "number" ? progress.cost : usageCost;
	if (typeof cost === "number" && cost > 0) stats.push(`$${cost.toFixed(2)}`);
	const elapsed = elapsedMs !== undefined ? elapsedMs : durationOf(id);
	if (showElapsed && typeof elapsed === "number" && Number.isFinite(elapsed) && elapsed > 0) stats.push(fmtDuration(elapsed));
	if (!current && stats.length === 0) return null;
	return <span className="omp-native-agent-progress">
		{current && <span className="omp-native-agent-activity" title={current}>{current}</span>}
		{stats.length > 0 && <span className="omp-native-agent-stats">{stats.join(" · ")}</span>}
	</span>;
}
