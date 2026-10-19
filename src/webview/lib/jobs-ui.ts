/**
 * What the Jobs row, the working row, the tool cards and the `proc://` links share on one page: a request to show a job, the
 * cancel that is open, and what the last cancel came to.
 *
 * A cancel is OMP's own command, `/jobs kill <id>` or `/jobs kill all`, sent like any typed message: OMP runs a builtin before it queues
 * anything, so it works during a turn as well. OMP answers with a `command_output` line, which the model keeps as a transcript row;
 * the answer is read from the first new row whose sentence is the answer to this very command (another command's output, or another
 * page's cancel, is not), never guessed from the job leaving the list. Sending a command like this also clears a pending `/clear` wait
 * and arms the page's identity check, as any typed message does.
 */
// Explicit `.ts` specifiers: this module is imported by the node:test runner.
import { isCancelableJobId, type GoneJobs } from "../../chat/background-jobs.ts";
import { classifyJobsReply, isJobsKillReply, jobsKillCommand, type JobCancelOutcome } from "../../chat/jobs-hud.ts";
import { isRecord } from "../../shared/guards.ts";
import { chatWritable, type ChatClient } from "./chat-client.ts";

/** A request to show a job: `id` null shows the row alone. `nonce` makes a repeated request for the same job new. */
export interface JobsFocus {
	id: string | null;
	nonce: number;
}

export interface JobsUiState {
	focus: JobsFocus | null;
	/** The target of the cancel that is open (a job id, or `all`), null when none is. */
	pending: string | null;
	/** What the last cancel came to. */
	outcome: { target: string; result: JobCancelOutcome } | null;
	/** Jobs OMP answered "not running" for, so the list stops showing them; the call that started the job each one meant. */
	gone: GoneJobs;
}

/** How long a reply may trail the send's result: the frame is posted before it, so this only guards an unexpected order. */
const REPLY_WAIT_MS = 2_000;
/** How long an outcome that needs no action stays; a refusal or a failure stays until the next action or Dismiss. */
const OUTCOME_MS = 6_000;

export const JOBS_NOT_WRITABLE = "Not cancelled: this conversation is not accepting commands right now.";
export const JOBS_UNCONFIRMED = "OMP did not confirm the cancel; the job may still be running.";
export const JOBS_NOT_A_COMMAND = "Not cancelled: OMP took /jobs kill as a message for the model, not as a command.";
export const JOBS_SILENT = "OMP ran the command but sent no answer; check whether the job is still listed.";

type JobsClient = Pick<ChatClient, "sendPrompt" | "getSnapshot" | "subscribe">;

export interface JobsUiOptions {
	replyWaitMs?: number;
	outcomeMs?: number;
}

export class JobsUi {
	readonly #client: JobsClient;
	readonly #replyWaitMs: number;
	readonly #outcomeMs: number;
	readonly #listeners = new Set<() => void>();
	#state: JobsUiState = { focus: null, pending: null, outcome: null, gone: new Map() };
	#nonce = 0;
	#outcomeTimer: unknown;

	constructor(client: JobsClient, options: JobsUiOptions = {}) {
		this.#client = client;
		this.#replyWaitMs = options.replyWaitMs ?? REPLY_WAIT_MS;
		this.#outcomeMs = options.outcomeMs ?? OUTCOME_MS;
	}

	getState = (): JobsUiState => this.#state;

	subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	};

	#set(patch: Partial<JobsUiState>): void {
		this.#state = { ...this.#state, ...patch };
		for (const listener of [...this.#listeners]) listener();
	}

	/** Open the Jobs row, and show `id` in it when given. Sends nothing. */
	focus(id: string | null): void {
		this.#nonce += 1;
		this.#set({ focus: { id, nonce: this.#nonce } });
	}

	/** The row is closed by the user: a revealed job and the forced visibility end with it. */
	release(): void {
		if (this.#state.focus !== null) this.#set({ focus: null });
	}

	dismiss(): void {
		clearTimeout(this.#outcomeTimer as number);
		if (this.#state.outcome !== null) this.#set({ outcome: null });
	}

	/**
	 * Cancel one job or `all`. One cancel is open at a time; a target that could change the command is never sent. `callId` is the call
	 * that started the job, so an "OMP has no such running job" answer retires exactly that job and not a later one with the same id.
	 */
	async cancel(target: string, callId: string | null = null): Promise<void> {
		if (this.#state.pending !== null || !(target === "all" || isCancelableJobId(target))) return;
		clearTimeout(this.#outcomeTimer as number);
		const snapshot = this.#client.getSnapshot();
		if (!chatWritable(snapshot)) {
			this.#settle(target, callId, { kind: "refused", text: JOBS_NOT_WRITABLE });
			return;
		}
		const before = new Set(snapshot.ephemeral.map(item => item.id));
		this.#set({ pending: target, outcome: null });
		const sent = await this.#client.sendPrompt(jobsKillCommand(target));
		let result: JobCancelOutcome;
		if (!sent.ok) result = sent.unconfirmed === true ? { kind: "unconfirmed", text: JOBS_UNCONFIRMED } : { kind: "refused", text: `Not cancelled: ${sent.reason}` };
		else if (sent.explained !== true) result = { kind: "refused", text: JOBS_NOT_A_COMMAND };
		else {
			const reply = await this.#replyTo(target, before);
			result = reply === null ? { kind: "silent", text: JOBS_SILENT } : classifyJobsReply(reply);
		}
		this.#settle(target, callId, result);
	}

	#settle(target: string, callId: string | null, result: JobCancelOutcome): void {
		// OMP has no running job of that id: it is over, however the page came to think it was running.
		const gone = result.kind === "gone" && target !== "all" ? new Map(this.#state.gone).set(target, callId) : this.#state.gone;
		this.#set({ pending: null, outcome: { target, result }, gone });
		if (result.kind === "cancelled" || result.kind === "gone") {
			this.#outcomeTimer = setTimeout(() => this.dismiss(), this.#outcomeMs);
		}
	}

	/** The text of the first row, new since the send, that answers `/jobs kill <target>`, waiting a little for it; null when there is none. */
	#replyTo(target: string, before: ReadonlySet<string>): Promise<string | null> {
		const find = (): string | null => {
			for (const item of this.#client.getSnapshot().ephemeral) {
				if (item.kind === "command_output" && !before.has(item.id) && isRecord(item.payload) && typeof item.payload.text === "string" && isJobsKillReply(target, item.payload.text)) return item.payload.text;
			}
			return null;
		};
		const now = find();
		if (now !== null) return Promise.resolve(now);
		const { promise, resolve } = Promise.withResolvers<string | null>();
		const stop = this.#client.subscribe(() => {
			const text = find();
			if (text === null) return;
			clearTimeout(timer);
			stop();
			resolve(text);
		});
		const timer = setTimeout(() => {
			stop();
			resolve(null);
		}, this.#replyWaitMs);
		return promise;
	}
}
