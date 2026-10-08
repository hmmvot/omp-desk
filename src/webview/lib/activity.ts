/**
 * The turn-activity projection of a chat model.
 *
 * The extension host runs the chat model for every conversation it holds (open tab or not),
 * so it can raise a desktop notification for a hidden or closed panel. Its projection
 * carries observed working/settled facts, fresh prompt-result status, the pending dialog's
 * display title, the newest reply's `stopReason`, and its trailing-question heuristic.
 * Dialog options, prefill, answers and raw failure details never cross this boundary.
 *
 * The question flag is the one thing derived here rather than read off a frame:
 * {@link trailingQuestion} states the whole rule, and it says no for everything that is
 * not a completed reply. The host decides whether anything is shown and how often.
 */
import type { AssistantMessage } from "../../chat/messages.ts";
// Explicit `.ts` specifiers: this module is imported by the node:test runner, and Node's
// ESM loader does not resolve extensionless specifiers (the Webview bundle does not care).
import type { ChatModel, ChatUiRequest } from "../../chat/model.ts";
import type { GuestTurnOutcome } from "../messages.ts";
import { notificationLine } from "../../host/notification-text.ts";

/** The dialog a conversation is waiting on, by id and kind. */
export interface TurnPendingRequest {
	readonly id: string;
	readonly kind: ChatUiRequest["method"];
	readonly question: string;
}

/** What the notifier and the Sessions row read about one conversation's turn. */
export interface TurnActivityReport {
	/** True while a turn is running. */
	readonly streaming: boolean;
	/** Background work remains after an explicit async pause or in the live subagent roster. */
	readonly backgroundWork: boolean;
	/** Actual idle boundary, not the intermediate `agent_end` working flag. */
	readonly settled: boolean;
	/** Fresh result for this run; cleared at agent_start. */
	readonly promptStatus: NonNullable<ChatModel["lastPromptResult"]>["status"] | null;
	/** Outcome of the latest agent run; unlike `promptStatus` it also covers autonomous runs that had no prompt result. */
	readonly completionOutcome: ChatModel["lastAgentOutcome"];
	/** The dialog awaiting an answer (the FIFO head), or `null`. */
	readonly pendingRequest: TurnPendingRequest | null;
	/** `stopReason` of the newest assistant reply, or `null` when none is known. */
	readonly outcome: GuestTurnOutcome | null;
	/** The newest completed reply ends by asking the user something. */
	readonly trailingQuestion: boolean;
}

/**
 * The identity of a report, used to skip re-reporting a state the consumer already has.
 * Every field of the observable state is in it, the question flag included: a reply that
 * lands with a different final character must be seen even when nothing else changed.
 */
export function activitySignature(report: TurnActivityReport): string {
	return `${report.streaming}|${report.backgroundWork}|${report.settled}|${report.promptStatus ?? ""}|${report.completionOutcome ?? ""}|${report.pendingRequest?.id ?? ""}|${report.pendingRequest?.kind ?? ""}|${report.pendingRequest?.question ?? ""}|${report.outcome ?? ""}|${report.trailingQuestion}`;
}

/** The newest assistant message among the durable and pending rows, or `null`. */
function newestAssistantMessage(model: ChatModel): AssistantMessage | null {
	for (let index = model.entries.length - 1; index >= 0; index--) {
		const entry = model.entries[index];
		if (entry !== undefined && entry.type === "message" && entry.message.role === "assistant") return entry.message;
	}
	return null;
}

/**
 * The newest assistant reply's `stopReason` — the wire's own vocabulary, so a notice can
 * say what happened rather than that something did. The in-flight message wins while one
 * exists; the newest finalized reply is the fallback for a page that joined after the last turn.
 */
function latestOutcome(model: ChatModel): GuestTurnOutcome | null {
	const message = model.stream ?? newestAssistantMessage(model);
	return message === null ? null : message.stopReason;
}

/** The text a reader sees in one assistant message: its text blocks, and nothing else. */
function visibleText(message: AssistantMessage): string {
	let text = "";
	for (const block of message.content) {
		if (block.type === "text") text += block.text;
	}
	return text;
}

/** True when the last character that is not whitespace is a question mark. */
function endsWithQuestion(text: string): boolean {
	for (let index = text.length - 1; index >= 0; index--) {
		const character = text[index];
		if (character === undefined) break;
		if (character.trim().length === 0) continue;
		return character === "?";
	}
	return false;
}

/**
 * The heuristic "the reply is asking the user something" flag the session tree reads.
 *
 * The newest *completed* assistant text decides, and every case that is not a completion
 * says no: a running turn has no final character yet, and a reply that was aborted,
 * truncated, errored or continued into a tool call is not something the user can answer.
 * Only the message's own text blocks are considered, so a tool argument or a thought that
 * happens to end in `?` cannot raise a question nobody asked; and when the newest assistant
 * message carried no text at all — a tools-only step — the answer is no rather than the
 * previous reply's.
 *
 * The rule is a heuristic on purpose. It never turns a structured pending dialog or a
 * running turn into a question, and it never claims a completion was successful —
 * `stopReason` is the host's own word for that.
 */
export function trailingQuestion(model: ChatModel): boolean {
	if (model.working || model.asyncPaused) return false;
	const message = model.stream ?? newestAssistantMessage(model);
	if (message === null || message.stopReason !== "stop") return false;
	return endsWithQuestion(visibleText(message));
}

export function hasBackgroundWork(model: ChatModel): boolean {
	if (model.settled && model.state?.isSettled === true) return false;
	if (model.asyncPaused) return true;
	for (const agent of model.agents.values()) if (agent.status === "pending" || agent.status === "running") return true;
	return false;
}

/**
 * A report for a conversation whose OMP child says a registry subagent is running or has messages
 * queued (a revived agent is neither a parent job nor in the lifecycle-frame roster, so the
 * session's own settle state and roster miss it): the wait is background work and nothing is settled.
 */
export function withRegistrySubagentWork(report: TurnActivityReport): TurnActivityReport {
	return { ...report, backgroundWork: true, settled: false };
}

/** Project a chat model into a report; `null` while its conversation is not live. */
export function turnActivity(model: ChatModel): TurnActivityReport | null {
	if (model.phase !== "live") return null;
	const request = model.uiRequest;
	return {
		streaming: model.working,
		backgroundWork: hasBackgroundWork(model),
		settled: model.settled,
		promptStatus: !model.asyncPaused && model.lastPromptResult?.agentInvoked === true ? model.abortRequested ? "aborted" : model.lastPromptResult.status : null,
		completionOutcome: model.abortRequested ? "aborted" : model.lastAgentOutcome,
		pendingRequest: request === null ? null : { id: request.id, kind: request.method, question: notificationLine(request.title) },
		outcome: latestOutcome(model),
		trailingQuestion: trailingQuestion(model),
	};
}
