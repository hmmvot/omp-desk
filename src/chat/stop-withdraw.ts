/**
 * Stop takes back a message sent a moment ago (ADR-0082, docs/designs/2026-10-21-stop-returns-a-fresh-message.md).
 *
 * Everything here is pure: which sent texts can be taken back at all (`anchorKind`), what a conversation tail since the
 * baseline shows (`tailFacts`), whether a turn can still be taken back while it runs (`mayStillWithdraw`, monotone: once
 * false it stays false, so the host drops the anchor and a long-turn Stop pays nothing), and the verdict after the stop
 * settled (`withdrawVerdict`). The host (`host/rpc/session.ts`) holds the clock, the ledger and the move itself.
 */
import type { ChatContent, ChatEntry, UserMessage } from "./messages.ts";
import type { ChatSlashCommand } from "./model.ts";
import { invokesListedSkill, leadingCommandToken, startsWithLocalExecution } from "./prompt-routing.ts";

/** How long after the send an already started answer still counts as "a moment ago". The only number of the rule. */
export const WITHDRAW_GRACE_MS = 5_000;

/** `customType` OMP gives the entry of a skill invocation (`/skill:name …`). */
const SKILL_PROMPT_TYPE = "skill-prompt";

/**
 * What the sent message is to OMP. `plain`: user input stored as typed. `template`: a markdown command or prompt template,
 * stored as its expansion. `skill`: a skill invocation, stored as a `skill-prompt` entry instead of a user message.
 */
export type AnchorKind = "plain" | "template" | "skill";

/**
 * Which kind of message `text` is, or `null` when it can act before it sends anything (a builtin, extension or custom
 * command, a shell or Python line) and so is never taken back. An unlisted `/name` is text to OMP.
 */
export function anchorKind(text: string, commands: readonly Pick<ChatSlashCommand, "name" | "aliases" | "source">[]): AnchorKind | null {
	if (startsWithLocalExecution(text.trimStart())) return null;
	if (invokesListedSkill(text, commands)) return "skill";
	const token = leadingCommandToken(text);
	if (token === null) return "plain";
	const listed = commands.find(command => command.name === token || command.aliases?.includes(token) === true);
	if (listed === undefined) return "plain";
	return listed.source === "file" ? "template" : null;
}

/** Whether an entry is a bookkeeping row: it says nothing a user or the model said. */
function isBookkeeping(entry: ChatEntry): boolean {
	return entry.type === "custom" || entry.type === "unknown" || entry.type === "model_change" || entry.type === "thinking_level_change";
}

/** The custom message behind an entry, in either of the two shapes OMP's rows take. */
function customMessageOf(entry: ChatEntry): { customType: string; attribution?: string; details?: unknown } | null {
	if (entry.type === "custom_message") return entry;
	if (entry.type === "message" && (entry.message.role === "custom" || entry.message.role === "hookMessage")) return entry.message;
	return null;
}

/** A skill invocation the user typed (OMP's `isUserInvokedSkillPrompt`): a request, like a user message. */
export function isUserSkillInvocation(entry: ChatEntry): boolean {
	const custom = customMessageOf(entry);
	return custom !== null && custom.customType === SKILL_PROMPT_TYPE && custom.attribution === "user";
}

function userMessage(entry: ChatEntry): UserMessage | null {
	return entry.type === "message" && entry.message.role === "user" ? entry.message : null;
}

/** The text blocks of a user message, joined as OMP's `textContent` does. */
function textOf(content: string | readonly ChatContent[]): string {
	if (typeof content === "string") return content;
	let text = "";
	for (const block of content) if (block.type === "text") text += block.text;
	return text;
}

/** What the typed text of an anchor was, as far as a request entry can show it; `null` when it cannot. */
function requestText(entry: ChatEntry): string | null {
	const user = userMessage(entry);
	if (user !== null) return textOf(user.content);
	const custom = customMessageOf(entry);
	const details = custom?.details;
	return typeof details === "object" && details !== null && "prompt" in details && typeof details.prompt === "string" ? details.prompt : null;
}

/** Whether an entry OMP wrote by itself belongs to a turn it starts (notices, attachments, hooks), never to the user. */
function isHarness(entry: ChatEntry): boolean {
	if (entry.type === "custom_message") return !isUserSkillInvocation(entry);
	if (entry.type !== "message") return false;
	const message = entry.message;
	if (message.role === "custom" || message.role === "hookMessage") return !isUserSkillInvocation(entry);
	if (message.role === "developer" || message.role === "fileMention") return true;
	return message.role === "user" && message.synthetic === true;
}

/** What the loaded entries after a baseline are, in the order the rule reads them. */
export interface TailFacts {
	/** The baseline is on the loaded branch (`null` means an empty conversation, which always is). */
	found: boolean;
	/** User messages and user-typed skill invocations. */
	requests: number;
	/** The first request entry, or `null`. */
	request: ChatEntry | null;
	/** Something that can never belong to one turn of an anchor, or a harmless kind of entry in a place it cannot be. */
	foreign: boolean;
	assistants: number;
	/** The newest assistant message stopped because the user interrupted it. */
	aborted: boolean;
	/** An assistant message holds a tool call, a server tool or a block Desk does not know. */
	acted: boolean;
	/** An assistant message holds a non-blank text block. */
	spoke: boolean;
	/** Nothing but bookkeeping follows the baseline. */
	bookkeepingOnly: boolean;
}

/** The blocks of an assistant message that show the agent did something, and whether it wrote anything. */
function assistantFacts(message: { readonly content: readonly ChatContent[] }): { acted: boolean; spoke: boolean } {
	let acted = false;
	let spoke = false;
	for (const block of message.content) {
		switch (block.type) {
			case "text":
				if (block.text.trim().length > 0) spoke = true;
				break;
			case "thinking":
			case "redactedThinking":
			case "fallback":
				break;
			default:
				// toolCall, anthropicServerTool, unknown, and a block an image or a future kind would be: it did something.
				acted = true;
		}
	}
	return { acted, spoke };
}

/** Read the entries after `baselineId` (`null`: all of them). Placement is part of the rule: see the design's rule 2. */
export function tailFacts(entries: readonly ChatEntry[], baselineId: string | null): TailFacts {
	const start = baselineId === null ? 0 : entries.findIndex(entry => entry.id === baselineId) + 1;
	const facts: TailFacts = { found: baselineId === null || start > 0, requests: 0, request: null, foreign: false, assistants: 0, aborted: false, acted: false, spoke: false, bookkeepingOnly: true };
	if (!facts.found) return facts;
	for (let index = start; index < entries.length; index += 1) {
		const entry = entries[index]!;
		if (isBookkeeping(entry)) {
			// OMP appends `custom` and `unknown` rows (digest, credential pin, usage) after a message; a model or
			// thinking-level change after the request means something else switched mid-turn.
			if (facts.request !== null && entry.type !== "custom" && entry.type !== "unknown") facts.foreign = true;
			continue;
		}
		facts.bookkeepingOnly = false;
		const isRequest = (userMessage(entry) !== null && !isHarness(entry)) || isUserSkillInvocation(entry);
		if (isRequest) {
			facts.requests += 1;
			if (facts.request === null) facts.request = entry;
			else facts.foreign = true;
			if (facts.assistants > 0) facts.foreign = true;
			continue;
		}
		if (isHarness(entry)) {
			// Notices ride with the user's message: before it (magic keywords, attachment notes) or right after it (`@file`
			// contents, hook and next-turn messages). After the answer they are something else (an agent message, a job notice).
			if (facts.assistants > 0) facts.foreign = true;
			continue;
		}
		if (entry.type === "message" && entry.message.role === "assistant") {
			facts.assistants += 1;
			if (facts.request === null || facts.assistants > 1) facts.foreign = true;
			const { acted, spoke } = assistantFacts(entry.message);
			facts.aborted = entry.message.stopReason === "aborted";
			if (acted) facts.acted = true;
			if (spoke) facts.spoke = true;
			continue;
		}
		// A tool result, an execution, a summary, a compaction, a reset boundary, a branch summary: another turn's business.
		facts.foreign = true;
	}
	return facts;
}

/** What the live model shows beyond its entries: the streaming assistant message and the running tools. */
export interface LiveFacts {
	stream: { readonly content: readonly ChatContent[] } | null;
	activeTools: number;
}

/**
 * Whether the turn can still be taken back, from what the live model shows. Monotone: a tool call, a second request,
 * a foreign entry or an answer older than the grace only ever get worse, so once this is false the host drops the anchor.
 */
export function mayStillWithdraw(entries: readonly ChatEntry[], baselineId: string | null, live: LiveFacts, elapsedMs: number): boolean {
	const facts = tailFacts(entries, baselineId);
	if (!facts.found || facts.foreign || facts.requests > 1 || facts.acted || live.activeTools > 0) return false;
	let spoke = facts.spoke;
	if (live.stream !== null) {
		const streamed = assistantFacts(live.stream);
		if (streamed.acted) return false;
		spoke = spoke || streamed.spoke;
	}
	return !(spoke && elapsedMs > WITHDRAW_GRACE_MS);
}

/** The anchor's own `prompt_result`, as far as the verdict needs it. */
export interface AnchorResult {
	status: "completed" | "aborted" | "error";
	agentInvoked: boolean;
}

export type WithdrawVerdict =
	/** The request entry is on the branch and goes: move the leaf past it. */
	| { action: "remove"; targetId: string }
	/** OMP dropped the prompt before it wrote anything: nothing to move. */
	| { action: "dropped" }
	/** Not eligible (or not provable): the Stop is today's Stop. */
	| { action: "keep" };

export interface WithdrawInput {
	/** The loaded active branch, durable rows only. */
	entries: readonly ChatEntry[];
	baselineId: string | null;
	kind: AnchorKind;
	/** The text the host sent. */
	text: string;
	elapsedMs: number;
	result: AnchorResult | null;
}

/** Whether the request entry found is the one the anchor sent. */
function isAnchorsRequest(entry: ChatEntry, kind: AnchorKind, text: string): boolean {
	if (kind === "template") return userMessage(entry) !== null;
	if (kind === "skill") return isUserSkillInvocation(entry) && requestText(entry)?.trim() === text.trim();
	return userMessage(entry) !== null && requestText(entry)?.trim() === text.trim();
}

/** The decision after the stop settled and the host re-read the branch. */
export function withdrawVerdict(input: WithdrawInput): WithdrawVerdict {
	const facts = tailFacts(input.entries, input.baselineId);
	if (!facts.found || facts.foreign || facts.acted || facts.requests > 1) return { action: "keep" };
	if (facts.requests === 0) {
		// A skill invocation or a message OMP never wrote: only the dropped-before-dispatch evidence can say which.
		return facts.bookkeepingOnly && input.result?.status === "aborted" && input.result.agentInvoked ? { action: "dropped" } : { action: "keep" };
	}
	const request = facts.request!;
	if (!isAnchorsRequest(request, input.kind, input.text)) return { action: "keep" };
	if (facts.assistants === 0 ? input.result?.status !== "aborted" : !facts.aborted) return { action: "keep" };
	if (facts.spoke && input.elapsedMs > WITHDRAW_GRACE_MS) return { action: "keep" };
	return { action: "remove", targetId: request.id };
}
