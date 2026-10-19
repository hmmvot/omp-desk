import type { ReactNode } from "react";
import { useId, useState } from "react";
import type { JobRecord } from "../../chat/background-jobs";
import { JOBS_NOTE, jobAgeMs, jobStateWord, jobTitle, jobsSummary, jobsWindow } from "../../chat/jobs-hud";
import { fmtDuration } from "../../shared/format";
import { useJobsUiState, type JobsContextValue } from "../lib/jobs-context";
import { useSecondTick } from "../lib/live-clock";
import { HudHeader } from "./HudRows";

export interface JobsHudProps {
	jobs: JobsContextValue;
	expanded: boolean;
	onToggle: () => void;
	/** Rows (content plus `+N more`) the bottom block's height cap leaves this row when expanded. */
	lines: number;
}

/** The colour of what a cancel came to: an answer that ended work or found nothing to end is calm, anything else warns. */
const OUTCOME_TONE: Partial<Record<string, string>> = { cancelled: "success", gone: "dim" };

const JOB_ICON: Record<JobRecord["state"], string> = { running: "loading codicon-modifier-spin", completed: "check", failed: "error", cancelled: "circle-slash" };

/**
 * The Jobs row of the bottom block: OMP's background jobs as this chat can know them (see `chat/background-jobs.ts`). Collapsed it is
 * one summary line; expanded, one line per running job with its own Cancel, a one-line honesty note and the last cancel's answer.
 * A cancel is OMP's `/jobs kill`; the row never claims a job stopped before OMP said so. Expansion is owned by the dock.
 */
export function JobsHud({ jobs, expanded, onToggle, lines }: JobsHudProps): ReactNode {
	const listId = useId();
	const { view, ui, cancelBlocked } = jobs;
	const state = useJobsUiState(ui);
	const [armed, setArmed] = useState(false);
	useSecondTick(view.running.length > 0);
	const summary = jobsSummary(view, Date.now());
	const busy = state.pending !== null;
	const canCancelAll = cancelBlocked === null && (view.running.length > 0 || view.pending);

	const focusId = state.focus?.id ?? null;
	const focused = focusId === null ? null : view.byId.get(focusId) ?? null;
	const missing = focusId !== null && focused === null;
	// A shown job leads the list, running or not; an id the chat never showed gets a line of its own.
	const rows: JobRecord[] = focused === null ? [...view.running] : [focused, ...view.running.filter(job => job.id !== focused.id)];
	const feedback = busy || state.outcome !== null;
	const extra = (feedback ? 1 : 0) + (missing ? 1 : 0);
	const window = jobsWindow(rows, lines, extra);
	// The note is the first thing to go when room is short: it shows only when it fits after every job line, `+N more` and the feedback.
	const note = lines >= window.rows.length + (window.hidden > 0 ? 1 : 0) + extra + 1;

	const cancelAll = (
		<button
			type="button"
			className={`omp-hud-open omp-hud-cancel-all${armed ? " omp-hud-cancel-all--armed" : ""}`}
			disabled={!canCancelAll || busy}
			title={cancelBlocked ?? (armed ? "Click again to stop every background job OMP is running for this session" : "Cancel all background jobs (asks to confirm)")}
			aria-label={armed ? "Confirm: cancel all background jobs" : "Cancel all background jobs"}
			onBlur={() => setArmed(false)}
			onKeyDown={event => { if (event.key === "Escape") setArmed(false); }}
			onClick={() => {
				if (!armed) {
					setArmed(true);
					return;
				}
				setArmed(false);
				void ui.cancel("all");
			}}
		>
			{armed ? "Confirm cancel all" : "Cancel all"}
		</button>
	);

	return (
		<section className="omp-hud omp-hud--jobs" aria-label="Jobs">
			<HudHeader
				name="Jobs"
				icon="server-process"
				summary={summary.text}
				detail={summary.detail}
				warn={summary.warn}
				expanded={expanded}
				controls={listId}
				onToggle={onToggle}
				action={cancelAll}
			/>
			{expanded && (
				<ul id={listId} className="omp-hud-rows">
					{missing && (
						<li className="omp-hud-job-item omp-hud-job--focus" data-job-id={focusId}>
							<div className="omp-hud-line omp-hud-job">
								<span className="codicon codicon-question" aria-hidden="true" />
								<strong className="omp-hud-job-id">{focusId}</strong>
								<span className="omp-hud-dim omp-hud-job-title" title="No background job of this chat's list has this id; a task's agent is in the Agents row">no such job in this chat's list (an agent is in the Agents row)</span>
							</div>
						</li>
					)}
					{window.rows.map(job => {
						const age = jobAgeMs(job, Date.now());
						const running = job.state === "running";
						const cancelling = state.pending === job.id;
						const stateWord = jobStateWord(job);
						const cancelTitle = cancelBlocked ?? (job.live ? `Cancel ${job.id}` : `Cancel is not offered for ${job.id}: it comes from earlier history and may not belong to this OMP session`);
						return (
							<li key={job.id} className={`omp-hud-job-item omp-hud-job--${job.state}${focusId === job.id ? " omp-hud-job--focus" : ""}`} data-job-id={job.id}>
								<div className="omp-hud-line omp-hud-job" title={`${job.id} · ${jobTitle(job)} · ${stateWord}`}>
									<span className={`codicon codicon-${JOB_ICON[job.state]}`} aria-hidden="true" />
									<strong className="omp-hud-job-id">{job.id}</strong>
									<span className="omp-hud-dim omp-hud-job-title">{jobTitle(job)}</span>
									{!running && <span className="omp-hud-dim">{stateWord}</span>}
									{age !== null && <span className="omp-hud-elapsed">{fmtDuration(age)}</span>}
									{running && job.live && (
										<button type="button" className="omp-hud-cancel" disabled={cancelBlocked !== null || busy} aria-label={cancelling ? `Cancelling ${job.id}` : `Cancel ${job.id}`} title={cancelling ? "Waiting for OMP's answer" : cancelTitle} onClick={() => void ui.cancel(job.id, job.callId)}>
											{cancelling ? "Cancelling…" : "Cancel"}
										</button>
									)}
								</div>
							</li>
						);
					})}
					{window.hidden > 0 && <li className="omp-hud-line"><span className="omp-hud-more">+{window.hidden} more</span></li>}
					{feedback && (
						<li className="omp-hud-line omp-hud-jobs-feedback" role="status">
							{busy
								? <span className="omp-hud-dim">Cancelling {state.pending === "all" ? "all background jobs" : state.pending}… waiting for OMP's answer</span>
								: <>
									<span className={`omp-hud-job-outcome omp-hud-tone--${OUTCOME_TONE[state.outcome!.result.kind] ?? "warning"}`} title={state.outcome!.result.text}>{state.outcome!.result.text}</span>
									<button type="button" className="omp-hud-cancel" onClick={() => ui.dismiss()}>Dismiss</button>
								</>}
						</li>
					)}
					{note && <li className="omp-hud-line omp-hud-jobs-note" title={JOBS_NOTE}>{JOBS_NOTE}</li>}
				</ul>
			)}
		</section>
	);
}
