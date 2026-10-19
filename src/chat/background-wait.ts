/**
 * What the Chat working row says while the only thing keeping a turn open is OMP's background work.
 *
 * OMP reports background work over RPC as one boolean (`get_state.hasPendingAsyncWork`); the jobs themselves are read from the
 * transcript and the live job frames (see {@link ./background-jobs.ts}), so a count is a lower bound and the generic sentence is used
 * when nothing could be named.
 */
import { scanJobs, transcriptActivityAt, type GoneJobs, type JobRecord } from "./background-jobs.ts";
import type { ChatModel } from "./model.ts";

export interface BackgroundWait {
	text: string;
	/** Epoch ms of the newest transcript activity: when the agent last did something and the wait began. Null when unknown. */
	since: number | null;
	/** The jobs shown running, oldest first. */
	jobs: readonly JobRecord[];
}

/**
 * The waiting state, or null when the row should keep its normal wording: the agent is working or streaming, a dialog
 * is open, the context is being compacted, or OMP does not report pending background work.
 */
export function backgroundWaitOf(model: Pick<ChatModel, "phase" | "asyncPaused" | "working" | "stream" | "uiRequest" | "maintenance" | "state" | "entries" | "jobFrames">, gone?: GoneJobs): BackgroundWait | null {
	if (model.phase !== "live" || !model.asyncPaused || model.working || model.stream !== null || model.uiRequest !== null) return null;
	if (model.maintenance?.status === "working" || model.state?.isCompacting === true) return null;
	const jobs = scanJobs(model.entries, model.jobFrames, gone).filter(job => job.state === "running");
	const since = transcriptActivityAt(model.entries);
	const text = jobs.length === 0 ? "Waiting for background work"
		: jobs.length === 1 ? `Waiting for background job: ${jobs[0]!.label}`
		: `Waiting for ${jobs.length} background jobs`;
	return { text, since, jobs };
}
