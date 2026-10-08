/** Native transcript/maintenance events used identically at child and page JSON boundaries. */
import { isRecord } from "../guards.ts";
import { parseChatMessage, parseRetryRecovery, type CustomMessage, type RetryErrorUpdate } from "./messages.ts";
import { parseTodoPhases, type TodoTask } from "./todos.ts";

export interface MaintenanceState {
	action: string; reason?: string; status: "working" | "complete" | "cancelled" | "failed" | "skipped";
	errorMessage?: string; willRetry?: boolean;
}
export interface RetryState {
	attempt: number; maxAttempts: number; delayMs: number; errorMessage: string;
	status: "waiting" | "recovered" | "failed";
}
export type NativeEventFrame =
	| { type: "auto_compaction_start"; action: string; reason: string }
	| { type: "auto_compaction_end"; action: string; result?: unknown; aborted: boolean; willRetry: boolean; errorMessage?: string; skipped?: boolean }
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string; errorId?: number }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string; retryErrors?: readonly RetryErrorUpdate[] }
	| { type: "retry_fallback_applied"; from: string; to: string; role: string; reason?: string }
	| { type: "retry_fallback_succeeded"; model: string; role: string }
	| { type: "ttsr_triggered"; rules: readonly Record<string, unknown>[] }
	| { type: "todo_reminder"; todos: readonly TodoTask[]; attempt: number; maxAttempts: number }
	| { type: "irc_message"; message: CustomMessage }
	| { type: "notice"; level: "info" | "warning" | "error"; message: string; source?: string }
	| { type: "goal_updated"; goal: unknown; state?: unknown }
	| { type: "config_warnings_changed" | "advisor_cost_changed" | "advisor_yielded" };

const MAINTENANCE_ACTIONS: Record<string, true> = { "context-full": true, remote: true, handoff: true, shake: true, snapcompact: true };
function isCount(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }

export function parseNativeEventFrame(frame: unknown): NativeEventFrame | null {
	if (!isRecord(frame)) return null;
	switch (frame.type) {
		case "config_warnings_changed": case "advisor_cost_changed": case "advisor_yielded": return { type: frame.type };
		case "auto_compaction_start":
			return typeof frame.action === "string" && Object.hasOwn(MAINTENANCE_ACTIONS, frame.action) && typeof frame.reason === "string" ? { type: frame.type, action: frame.action, reason: frame.reason } : null;
		case "auto_compaction_end":
			if (typeof frame.action !== "string" || !Object.hasOwn(MAINTENANCE_ACTIONS, frame.action) || typeof frame.aborted !== "boolean" || typeof frame.willRetry !== "boolean") return null;
			return { type: frame.type, action: frame.action, result: frame.result, aborted: frame.aborted, willRetry: frame.willRetry, ...(typeof frame.errorMessage === "string" ? { errorMessage: frame.errorMessage } : {}), ...(typeof frame.skipped === "boolean" ? { skipped: frame.skipped } : {}) };
		case "auto_retry_start":
			if (!isCount(frame.attempt) || !isCount(frame.maxAttempts) || !isCount(frame.delayMs) || typeof frame.errorMessage !== "string") return null;
			return { type: frame.type, attempt: frame.attempt, maxAttempts: frame.maxAttempts, delayMs: frame.delayMs, errorMessage: frame.errorMessage, ...(typeof frame.errorId === "number" ? { errorId: frame.errorId } : {}) };
		case "auto_retry_end": {
			if (typeof frame.success !== "boolean" || !isCount(frame.attempt)) return null;
			const retryErrors: RetryErrorUpdate[] = [];
			if (Array.isArray(frame.retryErrors)) for (const update of frame.retryErrors) {
				if (!isRecord(update) || typeof update.entryId !== "string" || typeof update.note !== "string") continue;
				const retryRecovery = parseRetryRecovery(update.retryRecovery);
				if (retryRecovery !== null) retryErrors.push({ entryId: update.entryId, note: update.note, retryRecovery, ...(typeof update.persistenceKey === "string" ? { persistenceKey: update.persistenceKey } : {}) });
			}
			return { type: frame.type, success: frame.success, attempt: frame.attempt, retryErrors, ...(typeof frame.finalError === "string" ? { finalError: frame.finalError } : {}) };
		}
		case "retry_fallback_applied":
			return typeof frame.from === "string" && typeof frame.to === "string" && typeof frame.role === "string" ? { type: frame.type, from: frame.from, to: frame.to, role: frame.role, ...(typeof frame.reason === "string" ? { reason: frame.reason } : {}) } : null;
		case "retry_fallback_succeeded": return typeof frame.model === "string" && typeof frame.role === "string" ? { type: frame.type, model: frame.model, role: frame.role } : null;
		case "ttsr_triggered": return Array.isArray(frame.rules) ? { type: frame.type, rules: frame.rules.filter(isRecord) } : null;
		case "todo_reminder": {
			if (!isCount(frame.attempt) || !isCount(frame.maxAttempts)) return null;
			const phases = parseTodoPhases([{ name: "Reminder", tasks: frame.todos }]);
			return phases === null ? null : { type: frame.type, todos: phases[0]!.tasks, attempt: frame.attempt, maxAttempts: frame.maxAttempts };
		}
		case "irc_message": {
			const message = parseChatMessage(frame.message);
			return message?.role === "custom" || message?.role === "hookMessage" ? { type: frame.type, message } : null;
		}
		case "notice":
			return (frame.level === "info" || frame.level === "warning" || frame.level === "error") && typeof frame.message === "string" ? { type: frame.type, level: frame.level, message: frame.message, ...(typeof frame.source === "string" ? { source: frame.source } : {}) } : null;
		case "goal_updated": return frame.goal === null || isRecord(frame.goal) ? { type: frame.type, goal: frame.goal, ...(frame.state !== undefined ? { state: frame.state } : {}) } : null;
		default: return null;
	}
}
