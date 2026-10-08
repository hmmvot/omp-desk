import {
	CONTROL_NATIVE_ACTIVITY_CAPACITY,
	CONTROL_NATIVE_ACTIVITY_ID_CHARS,
	CONTROL_NATIVE_ACTIVITY_QUESTION_POINTS,
	type ControlNativeActivity,
	type ControlNativeActivityEntry,
	type ControlNativeActivityOutcome,
} from "./control-protocol.ts";
import { notificationLine } from "./notification-text.ts";
import type { TurnActivity, TurnNotice, NotificationSuppression } from "./notifications.ts";

export const NATIVE_ACTIVITY_HOOKS = ["agent_start", "message_end", "agent_end", "tool_execution_start", "tool_execution_end", "tool_approval_requested", "tool_approval_resolved"] as const;
export type NativeActivityHook = (typeof NATIVE_ACTIVITY_HOOKS)[number];
type UnsequencedEntry<T = ControlNativeActivityEntry> = T extends unknown ? Omit<T, "seq"> : never;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const identity = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= CONTROL_NATIVE_ACTIVITY_ID_CHARS;
function outcome(value: unknown): ControlNativeActivityOutcome | null {
	return value === "stop" || value === "length" || value === "toolUse" || value === "error" || value === "aborted" ? value : null;
}

/** Producer closure: no SDK objects, transcript content or module-global agent state is retained. */
export class NativeActivityJournal {
	#entries: readonly ControlNativeActivityEntry[] = [];
	#nextSeq = 1;
	#fresh: { sessionId: string; outcome: ControlNativeActivityOutcome | null } | null = null;
	#activeSessionId: string | null = null;

	get entries(): readonly ControlNativeActivityEntry[] { return this.#entries; }
	get oldestSeq(): number { return this.#entries[0]?.seq ?? this.#nextSeq; }

	resetFreshOutcome(): void { this.#fresh = null; this.#activeSessionId = null; }

	#append(entry: UnsequencedEntry): void {
		const entries = this.#entries.slice(this.#entries.length === CONTROL_NATIVE_ACTIVITY_CAPACITY ? 1 : 0);
		entries.push({ ...entry, seq: this.#nextSeq++ });
		this.#entries = entries;
	}

	/** The adapter gates main TUI context before calling this synchronous recorder. */
	observe(kind: NativeActivityHook, event: unknown, sessionId: unknown): void {
		if (!identity(sessionId)) return;
		if (kind === "agent_start") {
			this.resetFreshOutcome();
			this.#activeSessionId = sessionId;
			this.#append({ kind, sessionId });
			return;
		}
		if (this.#activeSessionId !== sessionId || !record(event)) return;
		if (kind === "message_end") {
			if (record(event.message) && event.message.role === "assistant") {
				this.#fresh = { sessionId, outcome: outcome(event.message.stopReason) };
			}
			return;
		}
		if (kind === "agent_end") {
			const fresh = this.#fresh;
			this.#fresh = null;
			if (event.willContinue !== true) this.#activeSessionId = null;
			let final: ControlNativeActivityOutcome | null = null;
			if (Array.isArray(event.messages)) {
				for (let index = event.messages.length - 1; index >= 0; index--) {
					const message: unknown = event.messages[index];
					if (!record(message)) continue;
					if (message.role === "user") break;
					if (message.role === "assistant") { final = outcome(message.stopReason); break; }
				}
			}
			// The full message list can veto an exception-path abort but never establishes
			// freshness by itself: no assistant message from history can create a candidate.
			// A fresh end is provisional. Native hooks fold async pauses and ordinary
			// continuation into `willContinue`, so the ledger cancels it on a later
			// agent_start/abort until the authenticated SDK proves idle.
			const terminal = final === "aborted" ? "aborted"
				: fresh?.sessionId === sessionId && fresh.outcome === final ? final : null;
			this.#append({ kind, sessionId, outcome: terminal });
			return;
		}
		if (!identity(event.toolCallId)) return;
		const toolCallId = event.toolCallId;
		if (kind === "tool_approval_requested") {
			this.#append({ kind: "approval_start", sessionId, toolCallId, question: "Approve tool execution" });
		} else if (kind === "tool_approval_resolved") {
			this.#append({ kind: "approval_end", sessionId, toolCallId });
		} else if (event.toolName === "ask") {
			if (kind === "tool_execution_end") this.#append({ kind: "ask_end", sessionId, toolCallId });
			else if (record(event.args) && Array.isArray(event.args.questions) && record(event.args.questions[0]) && typeof event.args.questions[0].question === "string") {
				this.#append({ kind: "ask_start", sessionId, toolCallId, question: notificationLine(event.args.questions[0].question, CONTROL_NATIVE_ACTIVITY_QUESTION_POINTS) });
			}
		}
	}
}

interface PendingWait {
	entry: Extract<ControlNativeActivityEntry, { kind: "ask_start" | "approval_start" }>;
	consumed: boolean;
}

/** Consumer lives with one native watch; restart/switch/epoch/gap baselines cannot replay history. */
export class NativeActivityLedger {
	#epoch: string | null = null;
	#sessionId: string | null = null;
	#lastSeq = 0;
	#completion: Extract<ControlNativeActivityEntry, { kind: "agent_end" }> | null = null;
	readonly #waits = new Map<string, PendingWait>();

	readonly #onSuppressed: ((kind: TurnNotice["kind"], reason: NotificationSuppression | "aborted") => void) | undefined;

	constructor(onSuppressed?: (kind: TurnNotice["kind"], reason: NotificationSuppression | "aborted") => void) { this.#onSuppressed = onSuppressed; }

	/** Consuming a notification does not answer the actual pending dialog. */
	get pendingRequest(): TurnActivity["pendingRequest"] {
		const wait = this.#waits.values().next().value as PendingWait | undefined;
		return wait === undefined ? null : {
			id: `${wait.entry.kind}:${wait.entry.toolCallId}`,
			kind: wait.entry.kind === "ask_start" ? "select" : "confirm",
			question: wait.entry.question,
		};
	}

	/**
	 * A baseline never replays history, with one exception: a dialog that is still
	 * awaiting the user is current state, not history. The ring holds the host's
	 * own start/end pairs, so a wait that opened after the last turn boundary and
	 * never closed is recovered for the row it belongs to. A host-reported settled
	 * session cannot be waiting for anything, so it recovers nothing.
	 */
	#baseline(activity: ControlNativeActivity, expectedSessionId: string | null): void {
		const state = activity.state;
		this.#epoch = activity.epoch;
		this.#sessionId = state.sessionId;
		this.#lastSeq = activity.entries.at(-1)?.seq ?? activity.oldestSeq - 1;
		this.#completion = null;
		this.#waits.clear();
		if (!state.available || state.sessionId === null || state.sessionId !== expectedSessionId || state.settled === true) return;
		for (const entry of activity.entries) {
			if (entry.sessionId !== state.sessionId) continue;
			switch (entry.kind) {
				case "agent_start": case "agent_end": this.#waits.clear(); break;
				case "ask_start": case "approval_start":
					this.#waits.set(`${entry.kind}:${entry.toolCallId}`, { entry, consumed: false });
					break;
				case "ask_end": this.#waits.delete(`ask_start:${entry.toolCallId}`); break;
				case "approval_end": this.#waits.delete(`approval_start:${entry.toolCallId}`); break;
			}
		}
	}

	observe(activity: ControlNativeActivity, expectedSessionId: string | null, suppression: NotificationSuppression | null): TurnNotice[] {
		const state = activity.state;
		if (!state.available || state.sessionId === null || state.sessionId !== expectedSessionId
			|| this.#epoch !== activity.epoch || this.#sessionId !== state.sessionId
			|| activity.oldestSeq > this.#lastSeq + 1) {
			this.#baseline(activity, expectedSessionId);
		}
		for (const entry of activity.entries) {
			if (entry.seq <= this.#lastSeq) continue;
			this.#lastSeq = entry.seq;
			if (entry.sessionId !== state.sessionId) continue;
			switch (entry.kind) {
				case "agent_start": this.#completion = null; this.#waits.clear(); break;
				case "agent_end":
					this.#waits.clear();
					if (entry.outcome === "aborted") this.#onSuppressed?.("turn-complete", "aborted");
					this.#completion = entry.outcome !== null && entry.outcome !== "aborted" ? entry : null;
					break;
				case "ask_start": case "approval_start":
					this.#waits.set(`${entry.kind}:${entry.toolCallId}`, { entry, consumed: false });
					break;
				case "ask_end": this.#waits.delete(`ask_start:${entry.toolCallId}`); break;
				case "approval_end": this.#waits.delete(`approval_start:${entry.toolCallId}`); break;
			}
		}
		const notices: TurnNotice[] = [];
		for (const wait of this.#waits.values()) {
			if (wait.consumed) continue;
			wait.consumed = true;
			if (suppression === null) notices.push({ kind: "request-pending", requestId: `${wait.entry.kind}:${wait.entry.toolCallId}`, requestKind: wait.entry.kind === "ask_start" ? "select" : "approval", question: wait.entry.question });
			else this.#onSuppressed?.("request-pending", suppression);
		}
		if (this.#completion !== null && state.settled === true && this.#waits.size === 0 &&
			activity.work?.working !== true && activity.work?.backgroundWork !== true) {
			if (suppression === null) notices.push({ kind: "turn-complete", outcome: this.#completion.outcome });
			else this.#onSuppressed?.("turn-complete", suppression);
			this.#completion = null;
		}
		return notices;
	}
}
