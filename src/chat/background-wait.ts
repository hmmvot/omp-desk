/**
 * What the Chat working row says while the only thing keeping a turn open is OMP's background work.
 *
 * OMP 18.8.5 reports background work over RPC as one boolean (`get_state.hasPendingAsyncWork`); there is no job list,
 * no job start/end event and no RPC command to cancel a bash job. The jobs are therefore read from the transcript,
 * where OMP writes them as it creates and delivers them: a started job is a tool result with
 * `details.async = { state: "running", jobId, type }` (bash, eval, task), a `job`/`wait` poll lists
 * `details.jobs[] = { id, status, label }`, and a finished job is delivered as an `async-result` custom message with
 * `details.jobs[] = { jobId, label }`. The list is an inference: jobs older than the loaded window, additional task spawns
 * (only the primary job id is reported) and jobs cancelled outside the transcript are not seen, so a count is a lower bound
 * and the generic sentence is used when nothing could be named.
 */
import { entryMessage, type ChatEntry, type ChatMessage } from "./messages.ts";
import type { ChatModel } from "./model.ts";
import { isRecord } from "../shared/guards.ts";

export interface BackgroundJob {
	id: string;
	label: string;
}

export interface BackgroundWait {
	text: string;
	/** Epoch ms of the newest transcript activity: when the agent last did something and the wait began. Null when unknown. */
	since: number | null;
	jobs: readonly BackgroundJob[];
}

const MAX_LABEL = 80;

/** One short line: the first non-blank line, whitespace collapsed, bounded. */
function shortLabel(value: string): string {
	const line = value.split(/\r?\n/).find(part => part.trim().length > 0) ?? "";
	const flat = line.replace(/\s+/g, " ").trim();
	return flat.length > MAX_LABEL ? `${flat.slice(0, MAX_LABEL - 1)}…` : flat;
}

function callLabel(args: Record<string, unknown>, intent: string | undefined): string | null {
	const named = typeof args.i === "string" ? args.i : intent;
	const text = typeof named === "string" && named.trim().length > 0 ? named
		: typeof args.command === "string" ? args.command : "";
	const label = shortLabel(text).replace(/\.+$/, "");
	return label.length > 0 ? label : null;
}

function messageTime(message: ChatMessage): number | null {
	const stamp = message.role === "assistant" ? message.completedAt ?? message.timestamp : message.timestamp;
	return typeof stamp === "number" && Number.isFinite(stamp) && stamp > 0 ? stamp : null;
}

/** Background jobs the transcript shows started and not yet finished, with the newest activity time. */
export function readBackgroundJobs(entries: readonly ChatEntry[]): { jobs: BackgroundJob[]; since: number | null } {
	const calls = new Map<string, string>();
	const running = new Map<string, string>();
	let since: number | null = null;
	for (const entry of entries) {
		const message = entryMessage(entry);
		if (message === null) continue;
		const stamp = messageTime(message);
		if (stamp !== null && (since === null || stamp > since)) since = stamp;
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type !== "toolCall") continue;
				const label = callLabel(block.arguments, block.intent);
				if (label !== null) calls.set(block.id, label);
			}
		} else if (message.role === "toolResult") {
			const details = message.details;
			if (!isRecord(details)) continue;
			const started = details.async;
			if (isRecord(started) && typeof started.jobId === "string") {
				if (started.state === "running") running.set(started.jobId, calls.get(message.toolCallId) ?? started.jobId);
				else running.delete(started.jobId);
			}
			if (Array.isArray(details.jobs)) {
				for (const job of details.jobs) {
					if (!isRecord(job) || typeof job.id !== "string") continue;
					if (job.status === "running") running.set(job.id, running.get(job.id) ?? (typeof job.label === "string" && shortLabel(job.label) || job.id));
					else if (typeof job.status === "string") running.delete(job.id);
				}
			}
		} else if (message.role === "custom" && message.customType === "async-result" && isRecord(message.details)) {
			const delivered = Array.isArray(message.details.jobs) ? message.details.jobs : [message.details];
			for (const job of delivered) if (isRecord(job) && typeof job.jobId === "string") running.delete(job.jobId);
		}
	}
	return { jobs: [...running].map(([id, label]) => ({ id, label })), since };
}

/**
 * The waiting state, or null when the row should keep its normal wording: the agent is working or streaming, a dialog
 * is open, the context is being compacted, or OMP does not report pending background work.
 */
export function backgroundWaitOf(model: Pick<ChatModel, "phase" | "asyncPaused" | "working" | "stream" | "uiRequest" | "maintenance" | "state" | "entries">): BackgroundWait | null {
	if (model.phase !== "live" || !model.asyncPaused || model.working || model.stream !== null || model.uiRequest !== null) return null;
	if (model.maintenance?.status === "working" || model.state?.isCompacting === true) return null;
	const { jobs, since } = readBackgroundJobs(model.entries);
	const text = jobs.length === 0 ? "Waiting for background work"
		: jobs.length === 1 ? `Waiting for background job: ${jobs[0]!.label}`
		: `Waiting for ${jobs.length} background jobs`;
	return { text, since, jobs };
}
