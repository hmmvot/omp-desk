import type { ReactNode } from "react";
import { useState, useSyncExternalStore } from "react";
import type { ChatModel } from "../../chat/model";
import { hudSectionLines, todoSummary } from "../../chat/hud-summary";
import { RunningAgents } from "./RunningAgents";
import { TodoHud } from "./TodoHud";

function subscribeViewport(notify: () => void): () => void {
	window.addEventListener("resize", notify);
	return () => window.removeEventListener("resize", notify);
}
const viewportHeight = (): number => window.innerHeight;

/**
 * The TODO and Agents rows, the top of the chat's bottom block: in the column's flow directly
 * above the composer card, at the transcript's column width, never inside the scrolling transcript.
 * The dock owns both rows' expansion so their combined height can be capped (a share of the
 * viewport) by giving each open row fewer lines plus `+N more`, never a scroll region.
 */
export function HudDock({ model }: { model: ChatModel }): ReactNode {
	const [todoOpen, setTodoOpen] = useState(false);
	const [agentsOpen, setAgentsOpen] = useState(false);
	const height = useSyncExternalStore(subscribeViewport, viewportHeight);
	const todoShown = todoSummary(model.todo?.phases ?? []) !== null;
	const agentsShown = model.agents.size > 0;
	if (!todoShown && !agentsShown) return null;
	const lines = hudSectionLines(height, Number(todoShown) + Number(agentsShown), Number(todoShown && todoOpen) + Number(agentsShown && agentsOpen));
	return (
		<div className="omp-hud-stack">
			<TodoHud model={model} expanded={todoOpen} onToggle={() => setTodoOpen(value => !value)} lines={lines} />
			<RunningAgents model={model} expanded={agentsOpen} onToggle={() => setAgentsOpen(value => !value)} lines={lines} />
		</div>
	);
}
