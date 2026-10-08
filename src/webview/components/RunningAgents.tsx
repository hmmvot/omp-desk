import type { ReactNode } from "react";
import { useId } from "react";
import type { ChatModel } from "../../chat/model";
import { agentsSummary, agentWindowWithin } from "../../chat/hud-summary";
import { fmtDuration } from "../lib/format";
import { useAgentElapsed } from "../lib/live-clock";
import { HudHeader, useDetailOpener } from "./HudRows";

export interface RunningAgentsProps {
	model: ChatModel;
	expanded: boolean;
	onToggle: () => void;
	/** Rows (content plus `+N more`) the bottom block's height cap leaves this row when expanded. */
	lines: number;
}

/**
 * The Agents row of the bottom block. The roster owns membership; a terminal progress row counts
 * until native removal. Expanded rows are the TUI's one line per agent, bounded; the child
 * transcript and full statistics live in the agent's own tab. Expansion is owned by the dock.
 */
export function RunningAgents({ model, expanded, onToggle, lines }: RunningAgentsProps): ReactNode {
	const listId = useId();
	const detail = useDetailOpener();
	// Native durations arrive only with progress events; the clock between them is local, and only while the rows are shown.
	const elapsedOf = useAgentElapsed(model.agents.values(), model.phase === "live", expanded);
	if (model.agents.size === 0) return null;
	const summary = agentsSummary(model);
	const window = expanded ? agentWindowWithin(model, lines) : null;

	return (
		<section className="omp-hud omp-hud--agents" aria-label="Agents">
			<HudHeader
				name="Agents"
				icon="organization"
				summary={summary.text}
				warn={summary.warn}
				expanded={expanded}
				controls={listId}
				onToggle={onToggle}
				openLabel="Open agents in editor tab"
				onOpen={() => detail.open({ kind: "agents" })}
				openAvailable={detail.available}
			/>
			{window !== null && (
				<ul id={listId} className="omp-hud-rows">
					{window.rows.map(row => {
						// The row names who and what it is doing; the spawn description and the full activity live in the tooltip.
						const title = [`${row.id}${row.badge === "" ? "" : ` · ${row.badge}`} · ${row.status}`, row.description, row.activity].filter(part => part.length > 0).join("\n");
						const elapsed = elapsedOf(row.id);
						return (
							<li key={row.id} className={`omp-hud-agent-item omp-hud-agent--${row.status}`}>
								<button type="button" className="omp-hud-line omp-hud-agent" disabled={!detail.available} aria-label={`Open ${row.id} (${row.status}) in editor tab`} title={title} onClick={() => detail.open({ kind: "agent", agentId: row.id })}>
									<span className={`codicon codicon-${row.icon}`} aria-hidden="true" />
									<strong className="omp-hud-agent-id">{row.id}</strong>
									{row.badge !== "" && <span className="omp-hud-dim omp-hud-badge">{row.badge}</span>}
									{row.activity !== "" && <span className="omp-hud-dim omp-hud-activity">{row.activity}</span>}
									{elapsed !== null && <span className="omp-hud-elapsed">{fmtDuration(elapsed)}</span>}
								</button>
							</li>
						);
					})}
					{window.hidden > 0 && (
						<li className="omp-hud-line">
							<button type="button" className="omp-hud-more" disabled={!detail.available} onClick={() => detail.open({ kind: "agents" })}>+{window.hidden} more</button>
						</li>
					)}
				</ul>
			)}
		</section>
	);
}
