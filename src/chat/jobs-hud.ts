/**
 * Pure view-model of the Jobs row: its summary, its bounded window, the words of its honesty note and the reading of OMP's answer to
 * `/jobs kill`. The row's data comes from {@link ./background-jobs.ts}.
 */
import type { JobRecord, JobsView } from "./background-jobs.ts";
import { HUD_ROW_LIMIT } from "./hud-summary.ts";
import type { ChatSlashCommand } from "./model.ts";
import { fmtDuration } from "../shared/format.ts";

/** The one line under an expanded row's list (the rest is its tooltip): what the list is made of, and what Cancel all reaches. */
export const JOBS_NOTE = "Listed from this chat's transcript and OMP's live events; a job it never showed may be missing. Cancel all stops the jobs OMP owns for this session.";

export const JOBS_BLOCKED_NOT_WRITABLE = "This conversation is not accepting commands right now.";
export const JOBS_BLOCKED_NO_COMMAND = "OMP did not list a /jobs kill command for this session.";

/**
 * Why a cancel is not offered, or null when it is. Cancel is OMP's own `/jobs kill`: without that command in the session's list the
 * text would reach the model as a message instead, so it is never sent.
 */
export function jobsCancelBlocked(commands: readonly ChatSlashCommand[], writable: boolean): string | null {
	if (!writable) return JOBS_BLOCKED_NOT_WRITABLE;
	return commands.some(command => command.name === "jobs" && command.subcommands?.some(sub => sub.name === "kill") === true) ? null : JOBS_BLOCKED_NO_COMMAND;
}

/** `bash: npm run dev`; a job whose label is only its id is the type and the id. */
export function jobTitle(job: JobRecord): string {
	return job.type === null ? job.label : `${job.type}: ${job.label}`;
}

/** How long a job has run, or ran: its reported duration once it ended, else the time since it began; null when neither is known. */
export function jobAgeMs(job: JobRecord, now: number): number | null {
	if (job.state !== "running") return job.durationMs ?? (job.startedAt !== null && job.endedAt !== null ? Math.max(0, job.endedAt - job.startedAt) : null);
	return job.startedAt === null ? null : Math.max(0, now - job.startedAt);
}

const STATE_WORD: Record<JobRecord["state"], string> = { running: "running", completed: "done", failed: "failed", cancelled: "cancelled" };

/** The word of a job's state: `done`, not `completed`, as the card chip and the revealed line say it; `ended` for a job OMP says is not running and nothing says how it ended. */
export function jobStateWord(job: Pick<JobRecord, "state" | "gone">): string {
	return job.gone ? "ended" : STATE_WORD[job.state];
}

export interface JobsSummary {
	text: string;
	/** What the one line leaves out, for the row's tooltip: the note when OMP reports work no job names; why the list is a lower bound. */
	detail?: string;
	/** The list cannot name the pending work: drawn in the warning colour. */
	warn: boolean;
}

/**
 * The collapsed line: `2 background jobs · bash: npm run dev · 3m` (the count, the newest job, its age). A list known to be
 * incomplete says `at least`; OMP reporting work that no job names says that instead of a count of zero.
 */
export function jobsSummary(view: JobsView, now: number): JobsSummary {
	if (view.running.length === 0) {
		if (!view.pending) return { text: "No background jobs running", warn: false };
		return { text: "Background work is pending · no job is named in this chat", detail: JOBS_NOTE, warn: true };
	}
	const newest = view.running[0]!;
	const age = jobAgeMs(newest, now);
	const count = view.running.length === 1 && !view.incomplete ? "1 background job" : `${view.incomplete ? "at least " : ""}${view.running.length} background job${view.running.length === 1 ? "" : "s"}`;
	const text = [count, jobTitle(newest), age === null ? "" : fmtDuration(age)].filter(part => part.length > 0).join(" · ");
	return { text, ...(view.incomplete ? { detail: "This chat's list is a lower bound: older history is not loaded, or a task may have started jobs no result names." } : {}), warn: false };
}

export interface JobsWindow {
	rows: readonly JobRecord[];
	hidden: number;
}

/**
 * The job lines an expanded row shows within `lines` lines of which `extra` are the note and feedback: at most {@link HUD_ROW_LIMIT},
 * at least one, and a `+N more` line (which takes a line of its own) when some are left out. `rows` is newest first.
 */
export function jobsWindow(rows: readonly JobRecord[], lines: number, extra: number): JobsWindow {
	const limit = Math.min(HUD_ROW_LIMIT, Math.max(1, lines - extra));
	if (rows.length <= limit) return { rows, hidden: 0 };
	const shown = Math.max(1, limit - 1);
	return { rows: rows.slice(0, shown), hidden: rows.length - shown };
}

/** What a `/jobs kill` came to, in the words the row and the card say. `text` is OMP's own sentence for the three that OMP answered. */
export type JobCancelOutcome =
	| { kind: "cancelled" | "gone" | "failed" | "unknown"; text: string }
	| { kind: "refused" | "unconfirmed" | "silent"; text: string };

const SGR = /\u001b\[[0-9;]*m/g;

/**
 * OMP's answer to `/jobs kill` (`handleJobsKillCommand`, `builtin-session.ts`): `Cancelled …` ended work; `No running background job…`
 * means the job had ended already; `Could not cancel …` and `… unavailable …` did not end it. Anything else is shown as OMP wrote it and
 * never counted as a success, so a changed wording cannot claim a cancel that did not happen.
 */
export function classifyJobsReply(reply: string): JobCancelOutcome {
	const text = reply.replace(SGR, "").replace(/\s+/g, " ").trim().slice(0, 300);
	if (/^Cancelled\b/.test(text)) return { kind: "cancelled", text };
	if (/^No running background jobs?\b/.test(text)) return { kind: "gone", text };
	if (/^Could not cancel\b/.test(text) || /\bunavailable\b/.test(text)) return { kind: "failed", text };
	return { kind: "unknown", text };
}

/** The command that cancels `target`: one job, or `all` of them. */
export function jobsKillCommand(target: string): string {
	return `/jobs kill ${target}`;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether `reply` is OMP's answer to `/jobs kill <target>`: its sentences name the id (OMP echoes at most 60 characters of it) or are the
 * fixed `all` sentences, so another command's output, or the answer to another page's cancel, is never read as this one's.
 */
export function isJobsKillReply(target: string, reply: string): boolean {
	const text = reply.replace(SGR, "").replace(/\s+/g, " ").trim();
	if (/^Async background jobs are unavailable\b/.test(text)) return true;
	if (target === "all") return /^(Cancelled \d+ background jobs?\.|No running background jobs to cancel\.)/.test(text);
	const id = escapeRegExp(target.slice(0, 50));
	// OMP echoes the whole id (at most 60 characters) and then `.` or `"`: `bg_10` is never the answer about `bg_1`.
	const end = target.length > 50 ? "" : "[.\"]";
	return new RegExp(`^(Cancelled background job |Could not cancel background job |No running background job with id ")${id}${end}`).test(text);
}
