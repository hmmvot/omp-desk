import type { ReactNode } from "react";
import { useContext, useEffect, useState, useSyncExternalStore } from "react";
import type { ChatModel } from "../../chat/model";
import { hudSectionLines } from "../../chat/hud-summary";
import { todoRowShown } from "../../chat/todo-hud";
import { JobsContext, useJobsUiState } from "../lib/jobs-context";
import { JobsHud } from "./JobsHud";
import { RunningAgents } from "./RunningAgents";
import { TodoHud } from "./TodoHud";

function subscribeViewport(notify: () => void): () => void {
	window.addEventListener("resize", notify);
	return () => window.removeEventListener("resize", notify);
}
const viewportHeight = (): number => window.innerHeight;

/**
 * The TODO, Agents and Jobs rows, the top of the chat's bottom block: in the column's flow directly
 * above the composer card, at the transcript's column width, never inside the scrolling transcript.
 * The dock owns the rows' expansion so their combined height can be capped (a share of the
 * viewport) by giving each open row fewer lines plus `+N more`, never a scroll region. The Jobs row
 * is also shown while a cancel is open or has just answered, and while a link or the working row
 * asks to see a job (and opens for that request).
 */
export function HudDock({ model }: { model: ChatModel }): ReactNode {
	const [todoOpen, setTodoOpen] = useState(false);
	const [agentsOpen, setAgentsOpen] = useState(false);
	const [jobsOpen, setJobsOpen] = useState(false);
	const height = useSyncExternalStore(subscribeViewport, viewportHeight);
	const jobs = useContext(JobsContext);
	const jobsUi = useJobsUiState(jobs?.ui ?? null);
	const focusNonce = jobsUi.focus?.nonce ?? null;
	const todoShown = todoRowShown(model.todo);
	const agentsShown = model.agents.size > 0;
	const jobsShown = jobs !== null && (jobs.view.shown || jobsUi.focus !== null || jobsUi.pending !== null || jobsUi.outcome !== null);
	useEffect(() => {
		if (focusNonce !== null) setJobsOpen(true);
	}, [focusNonce]);
	// A cancel started from the collapsed row (Cancel all) opens it: its answer must be seen.
	const cancelling = jobsUi.pending !== null;
	useEffect(() => {
		if (cancelling) setJobsOpen(true);
	}, [cancelling]);
	useEffect(() => {
		if (!jobsShown) setJobsOpen(false);
	}, [jobsShown]);
	if (!todoShown && !agentsShown && !jobsShown) return null;
	const lines = hudSectionLines(height, Number(todoShown) + Number(agentsShown) + Number(jobsShown), Number(todoShown && todoOpen) + Number(agentsShown && agentsOpen) + Number(jobsShown && jobsOpen));
	return (
		<div className="omp-hud-stack">
			<TodoHud model={model} expanded={todoOpen} onToggle={() => setTodoOpen(value => !value)} lines={lines} />
			<RunningAgents model={model} expanded={agentsOpen} onToggle={() => setAgentsOpen(value => !value)} lines={lines} />
			{jobs !== null && jobsShown && (
				<JobsHud
					jobs={jobs}
					expanded={jobsOpen}
					onToggle={() => {
						// Closing the row ends a request to show a job (and the row's forced visibility with it).
						if (jobsOpen) jobs.ui.release();
						setJobsOpen(!jobsOpen);
					}}
					lines={lines}
				/>
			)}
		</div>
	);
}
