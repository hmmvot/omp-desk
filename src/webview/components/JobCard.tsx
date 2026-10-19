import type { ReactNode } from "react";
import { useContext } from "react";
import type { JobRecord } from "../../chat/background-jobs";
import { jobAgeMs, jobStateWord } from "../../chat/jobs-hud";
import { isRecord } from "../../shared/guards";
import { fmtDuration } from "../../shared/format";
import { JobsContext, useJobsUiState, type JobsContextValue } from "../lib/jobs-context";
import { useSecondTick } from "../lib/live-clock";

export interface CardJob {
	jobs: JobsContextValue;
	job: JobRecord;
}

/**
 * The background job a tool card started: the card's result says `details.async.jobId`, and the page's job list holds that id for the
 * call that made this card (OMP ids restart with each process, so another call's job of the same id is not this card's). Null for any
 * other card, and where the page has no Jobs row.
 */
export function useCardJob(details: Record<string, unknown>, callId: string | undefined): CardJob | null {
	const jobs = useContext(JobsContext);
	const started = details.async;
	if (jobs === null || callId === undefined || !isRecord(started) || typeof started.jobId !== "string") return null;
	const job = jobs.view.byId.get(started.jobId);
	return job === undefined || job.callId !== callId ? null : { jobs, job };
}

/** Whether the card says its job is still running: an old call whose job nothing ever ended, with nothing pending, says nothing. */
export function cardJobShown({ jobs, job }: CardJob): boolean {
	return job.state !== "running" || jobs.view.shown;
}

/** The card's live status chip: `running · 3m`, then `done`, `failed`, `cancelled` or `ended` with the time the job took. */
export function JobChip({ cardJob }: { cardJob: CardJob }): ReactNode {
	const { job } = cardJob;
	useSecondTick(job.state === "running");
	const age = jobAgeMs(job, Date.now());
	const word = jobStateWord(job);
	const text = age === null ? word : `${word} · ${fmtDuration(age)}`;
	return <span className={`omp-job-chip omp-job-chip--${job.state}`} data-job-id={job.id} data-job-state={job.gone ? "gone" : job.state} title={`Background job ${job.id}: ${text}`}>{text}</span>;
}

/** Whether the card offers Cancel: the job is running and this OMP session reported it. */
export function cardJobCancelable({ job, jobs }: CardJob): boolean {
	return job.state === "running" && job.live && jobs.view.shown;
}

/** Cancel for the job a card started, a sibling of the card's head (a button never sits inside the head button). */
export function JobCancel({ cardJob }: { cardJob: CardJob }): ReactNode {
	const { jobs, job } = cardJob;
	const state = useJobsUiState(jobs.ui);
	const cancelling = state.pending === job.id;
	return (
		<button
			type="button"
			className="omp-job-cancel"
			disabled={jobs.cancelBlocked !== null || state.pending !== null}
			aria-label={cancelling ? `Cancelling ${job.id}` : `Cancel background job ${job.id}`}
			title={cancelling ? "Waiting for OMP's answer" : jobs.cancelBlocked ?? `Cancel ${job.id} (/jobs kill ${job.id})`}
			onClick={() => void jobs.ui.cancel(job.id, job.callId)}
		>
			{cancelling ? "Cancelling…" : "Cancel"}
		</button>
	);
}
