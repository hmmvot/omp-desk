/**
 * OMP's background jobs as Chat can know them.
 *
 * OMP 18.11.1 reports background work over RPC as one boolean (`get_state.hasPendingAsyncWork`); there is no job list, no job
 * event and no RPC command to cancel one. What Chat can read is what the session writes and streams:
 * - a started job is a tool result with `details.async = { state, jobId, type }` (bash, eval, task);
 * - a `job`/`wait` poll lists `details.jobs[] = { id, type, status, label, durationMs }`, and a cancel lists
 *   `details.cancelled[]` (or `details.proc.cancelled[]` for a `proc://<id>/kill` write) with `{ id, status }`;
 * - a finished job is delivered as an `async-result` custom message with `details.jobs[] = { jobId, type, status, label, durationMs }`;
 *   a cancelled job is never delivered;
 * - after the starting call returned, the job keeps sending `tool_execution_update` frames whose `partialResult.details.async` carries
 *   its state, and the last one says how it ended ({@link jobFrameOf}). These are live-only, so the model keeps the newest per job.
 *
 * The list is an inference and says so: jobs older than the loaded window, task spawns beyond the first of a call (only the primary job
 * id is reported) and jobs that ended outside the transcript are not seen, so a count is a lower bound, and a job that is gone may
 * still be listed until OMP reports nothing pending.
 */
import { entryMessage, type ChatEntry, type ChatMessage } from "./messages.ts";
import { isRecord } from "../shared/guards.ts";
import { isJobId } from "../shared/proc-links.ts";

export type JobType = "bash" | "eval" | "task";
export type JobState = "running" | "completed" | "failed" | "cancelled";

/** One background job: what the transcript and the live frames say of it. `label` is the job's id when nothing better is known. */
export interface JobRecord {
	id: string;
	type: JobType | null;
	label: string;
	state: JobState;
	/** Epoch ms the job began, when the transcript or a frame gives it; null otherwise. */
	startedAt: number | null;
	/** Epoch ms the job ended, when it has and the time is known. */
	endedAt: number | null;
	/** How long the job ran, as OMP reported it. */
	durationMs: number | null;
	/** The tool call that started it, when known. */
	callId: string | null;
	/** This OMP process reported the job (a live frame names it), so `/jobs kill` reaches it; an id from history alone may be an earlier process's. */
	live: boolean;
	/** OMP answered a cancel with "not running": the job is over, how it ended is not known. */
	gone: boolean;
}

/** The newest live frame of one job. */
export interface JobFrame {
	state: JobState;
	type: JobType | null;
	callId: string;
	/** Epoch ms this window received it. */
	at: number;
}

/** The most job frames a model keeps; the oldest go first. */
export const MAX_JOB_FRAMES = 200;
const MAX_LABEL = 80;
const MAX_ID = 128;

/** Whether `id` is a job id Chat will put into a `/jobs kill` command: a word OMP minted, and not `all`, which means every job. */
export function isCancelableJobId(id: string): boolean {
	return isJobId(id) && id !== "all";
}

const STATES: readonly JobState[] = ["running", "completed", "failed", "cancelled"];
const TYPES: readonly JobType[] = ["bash", "eval", "task"];

const stateOf = (value: unknown): JobState | null => typeof value === "string" && (STATES as readonly string[]).includes(value) ? value as JobState : null;
const typeOf = (value: unknown): JobType | null => typeof value === "string" && (TYPES as readonly string[]).includes(value) ? value as JobType : null;
const idOf = (value: unknown): string | null => typeof value === "string" && value.length > 0 && value.length <= MAX_ID ? value : null;
const finite = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

/** One short line: the first non-blank line, whitespace collapsed, bounded. */
export function shortLabel(value: string): string {
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

/**
 * The job a `tool_execution_update` frame reports, or null when the frame is ordinary tool progress. A job frame is one whose
 * `partialResult.details.async` names a job and a state; the first frames of a still-running call carry none.
 */
export function jobFrameOf(partialResult: unknown): { id: string; state: JobState; type: JobType | null } | null {
	if (!isRecord(partialResult) || !isRecord(partialResult.details)) return null;
	const async = partialResult.details.async;
	if (!isRecord(async)) return null;
	const id = idOf(async.jobId);
	const state = stateOf(async.state);
	return id === null || state === null ? null : { id, state, type: typeOf(async.type) };
}

/**
 * `frames` with `id`'s newest frame, the oldest dropped past {@link MAX_JOB_FRAMES}. The same map comes back when the frame says nothing
 * new (a running job reports again and again), so views over it stay equal. A settled job's state is never put back to running by its own
 * call; a different call with the same id is a different job (OMP ids restart with each process).
 */
export function withJobFrame(frames: ReadonlyMap<string, JobFrame>, id: string, frame: JobFrame): ReadonlyMap<string, JobFrame> {
	const previous = frames.get(id);
	const sameCall = previous !== undefined && previous.callId === frame.callId;
	if (sameCall && previous.state === frame.state) return frames;
	const next = new Map(frames);
	next.delete(id);
	next.set(id, sameCall && previous.state !== "running" && frame.state === "running" ? { ...frame, state: previous.state } : frame);
	while (next.size > MAX_JOB_FRAMES) next.delete(next.keys().next().value!);
	return next;
}

/** The `jobFrames` of a snapshot: absent means none; one malformed row refuses the whole list. */
export function parseJobFrames(value: unknown): ({ id: string } & JobFrame)[] | null {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > MAX_JOB_FRAMES) return null;
	const frames: ({ id: string } & JobFrame)[] = [];
	for (const row of value) {
		if (!isRecord(row)) return null;
		const id = idOf(row.id);
		const state = stateOf(row.state);
		const type = typeOf(row.type);
		const at = finite(row.at);
		if (id === null || state === null || at === null || (row.type !== null && type === null)) return null;
		if (typeof row.callId !== "string" || row.callId.length === 0 || row.callId.length > 256) return null;
		frames.push({ id, state, type, callId: row.callId, at });
	}
	return frames;
}

/** What the transcript alone says of its jobs, the call labels the live frames are named by, and the newest message time. */
interface TranscriptScan {
	jobs: ReadonlyMap<string, JobRecord>;
	calls: ReadonlyMap<string, string>;
	since: number | null;
}

/** One scan per transcript array: a frame arriving (a running bash job reports often) never rescans the transcript. */
const scans = new WeakMap<readonly ChatEntry[], TranscriptScan>();

/** A settled job stays settled: a later `running` (an old frame, an old poll) never reopens it. */
function settle(job: JobRecord, state: JobState, at: number | null, durationMs: number | null): void {
	if (state === "running" || job.state !== "running") return;
	job.state = state;
	job.endedAt = at;
	if (durationMs !== null) job.durationMs = durationMs;
	else if (job.startedAt !== null && at !== null && at >= job.startedAt) job.durationMs = at - job.startedAt;
}

function freshJob(id: string): JobRecord {
	return { id, type: null, label: id, state: "running", startedAt: null, endedAt: null, durationMs: null, callId: null, live: false, gone: false };
}

/**
 * The jobs a transcript shows, by id. OMP ids (`bg_1`) restart with each OMP process, so an id names one job only until the next start
 * that uses it: a later start result replaces the record, and a poll or a delivery belongs to the latest start before it.
 */
function scanTranscript(entries: readonly ChatEntry[]): TranscriptScan {
	const cached = scans.get(entries);
	if (cached !== undefined) return cached;
	const calls = new Map<string, string>();
	const jobs = new Map<string, JobRecord>();
	const named = new Set<string>();
	let since: number | null = null;

	const record = (id: string): JobRecord => {
		let job = jobs.get(id);
		if (job === undefined) {
			job = freshJob(id);
			jobs.set(id, job);
		}
		return job;
	};
	const label = (job: JobRecord, text: string | null): void => {
		if (text === null || text.length === 0 || named.has(job.id)) return;
		job.label = text;
		named.add(job.id);
	};

	for (const entry of entries) {
		const message = entryMessage(entry);
		if (message === null) continue;
		const stamp = messageTime(message);
		if (stamp !== null && (since === null || stamp > since)) since = stamp;
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type !== "toolCall") continue;
				const text = callLabel(block.arguments, block.intent);
				if (text !== null) calls.set(block.id, text);
			}
		} else if (message.role === "toolResult") {
			const details = message.details;
			if (!isRecord(details)) continue;
			const started = details.async;
			const startedId = isRecord(started) ? idOf(started.jobId) : null;
			if (startedId !== null && isRecord(started)) {
				const previous = jobs.get(startedId);
				if (previous !== undefined && previous.callId !== message.toolCallId) {
					jobs.delete(startedId);
					named.delete(startedId);
				}
				const job = record(startedId);
				job.type ??= typeOf(started.type);
				job.callId ??= message.toolCallId;
				job.startedAt ??= stamp;
				label(job, calls.get(message.toolCallId) ?? null);
				const state = stateOf(started.state);
				if (state !== null) settle(job, state, stamp, null);
			}
			if (Array.isArray(details.jobs)) readJobRows(details.jobs, "id", null, stamp, record, label);
			if (Array.isArray(details.cancelled)) readCancelled(details.cancelled, stamp, record);
			if (isRecord(details.proc) && Array.isArray(details.proc.cancelled)) readCancelled(details.proc.cancelled, stamp, record);
		} else if (message.role === "custom" && message.customType === "async-result" && isRecord(message.details)) {
			const delivered = Array.isArray(message.details.jobs) ? message.details.jobs : [message.details];
			readJobRows(delivered, "jobId", "completed", stamp, record, label);
		}
	}
	const scan = { jobs, calls, since };
	scans.set(entries, scan);
	return scan;
}

/** Epoch ms of the newest message of the transcript: when the agent last did something. Null when no message carries a time. */
export function transcriptActivityAt(entries: readonly ChatEntry[]): number | null {
	return scanTranscript(entries).since;
}

/** What a page learned by cancelling: the id of a job OMP said it is not running, and the call that started the job meant (null when unknown). */
export type GoneJobs = ReadonlyMap<string, string | null>;
const NO_GONE: GoneJobs = new Map();
const NO_FRAMES: ReadonlyMap<string, JobFrame> = new Map();

/**
 * Background jobs the transcript and the live frames show, in the order they were first seen. A live frame is the word of this OMP
 * process: it marks its job `live` and replaces a transcript record of an earlier job that had the same id. A job OMP answered "not
 * running" for is ended (`gone`) whatever the transcript says.
 */
export function scanJobs(entries: readonly ChatEntry[], frames: ReadonlyMap<string, JobFrame> = NO_FRAMES, gone: GoneJobs = NO_GONE): JobRecord[] {
	const scan = scanTranscript(entries);
	const jobs = new Map<string, JobRecord>();
	for (const [id, job] of scan.jobs) jobs.set(id, { ...job });
	for (const [id, frame] of frames) {
		let job = jobs.get(id);
		if (job !== undefined && job.callId !== frame.callId) {
			jobs.delete(id);
			job = undefined;
		}
		if (job === undefined) {
			job = freshJob(id);
			jobs.set(id, job);
		}
		job.live = true;
		job.type ??= frame.type;
		job.callId ??= frame.callId;
		if (job.startedAt === null && frame.state === "running") job.startedAt = frame.at;
		const text = scan.calls.get(frame.callId);
		if (text !== undefined && job.label === id) job.label = text;
		settle(job, frame.state, frame.at, null);
	}
	for (const job of jobs.values()) {
		if (job.state === "running" && gone.has(job.id) && gone.get(job.id) === job.callId) {
			job.state = "completed";
			job.gone = true;
		}
	}
	return [...jobs.values()];
}

type Label = (job: JobRecord, text: string | null) => void;

/**
 * `details.jobs[]` of a poll (`id`) or of a delivery (`jobId`). A running row of a poll says how long the job had run when it was taken.
 * A delivery whose row names no status ended the job all the same (`ended`).
 */
function readJobRows(rows: readonly unknown[], idKey: "id" | "jobId", ended: JobState | null, stamp: number | null, record: (id: string) => JobRecord, label: Label): void {
	for (const row of rows) {
		if (!isRecord(row)) continue;
		const id = idOf(row[idKey]);
		if (id === null) continue;
		const job = record(id);
		job.type ??= typeOf(row.type);
		label(job, typeof row.label === "string" ? shortLabel(row.label) : null);
		const duration = finite(row.durationMs);
		const state = stateOf(row.status) ?? ended;
		if (state === "running" && job.startedAt === null && stamp !== null && duration !== null) job.startedAt = stamp - duration;
		if (state !== null) settle(job, state, stamp, duration);
	}
}

/** The rows of a cancel result: `{ id, status: "cancelled" }` ended the job; `already_completed` and `not_found` say nothing of how. */
function readCancelled(rows: readonly unknown[], stamp: number | null, record: (id: string) => JobRecord): void {
	for (const row of rows) {
		if (!isRecord(row) || row.status !== "cancelled") continue;
		const id = idOf(row.id);
		if (id !== null) settle(record(id), "cancelled", stamp, null);
	}
}

/** What the Jobs row and the cards read. */
export interface JobsView {
	/** The Jobs row is drawn: OMP reports pending work, or the transcript shows a job running while the session is not settled. */
	shown: boolean;
	/** OMP's own flag: background work is pending. */
	pending: boolean;
	/** Jobs the transcript and frames show running, newest first. */
	running: readonly JobRecord[];
	/** Every job seen, running or ended, by id (the latest job that used the id). */
	byId: ReadonlyMap<string, JobRecord>;
	/** Known to be a lower bound: older history is not loaded, or a task spawn may have started jobs no result names. */
	incomplete: boolean;
}

/** What the job view reads of a model (structural: `model.ts` imports this module, so it cannot be imported back). */
export interface JobsSource {
	phase: string;
	asyncPaused: boolean;
	settled: boolean;
	state: { hasPendingAsyncWork?: boolean } | null;
	entries: readonly ChatEntry[];
	olderCount: number;
	jobFrames: ReadonlyMap<string, JobFrame>;
}

export function jobsViewOf(model: JobsSource, gone: GoneJobs = NO_GONE): JobsView {
	const jobs = scanJobs(model.entries, model.jobFrames, gone);
	const running = jobs.filter(job => job.state === "running").reverse();
	const pending = model.asyncPaused || model.state?.hasPendingAsyncWork === true;
	return {
		shown: model.phase === "live" && (pending || !model.settled && running.length > 0),
		pending,
		running,
		byId: new Map(jobs.map(job => [job.id, job])),
		incomplete: model.olderCount > 0 || running.some(job => job.type === "task"),
	};
}

/** Whether two views would draw the same: the page keeps the previous object then, so a card re-renders only when a job changed. */
export function sameJobsView(left: JobsView, right: JobsView): boolean {
	if (left.shown !== right.shown || left.pending !== right.pending || left.incomplete !== right.incomplete) return false;
	if (left.byId.size !== right.byId.size) return false;
	for (const [id, job] of left.byId) {
		const other = right.byId.get(id);
		if (other === undefined || other.state !== job.state || other.label !== job.label || other.type !== job.type || other.startedAt !== job.startedAt || other.endedAt !== job.endedAt || other.durationMs !== job.durationMs || other.callId !== job.callId || other.live !== job.live || other.gone !== job.gone) return false;
	}
	if (left.running.length !== right.running.length) return false;
	return left.running.every((job, index) => job.id === right.running[index]!.id);
}
