/**
 * The session facts OMP's terminal UI keeps in its status line and `get_state` reports: the goal, fast and slow mode
 * and the usage-limit stage. Shared by the host parser and the page parser, so both bound and validate them the same
 * way (OMP 18.11.1 `get_state`: `goal`, `fastModeEnabled`, `fastModeActive`, `slowModeSupported`, `slowModeEnabled`,
 * `slowModeScope`, `usageLimit`).
 */
import { isRecord } from "../shared/guards.ts";
import { stripAnsi } from "./ansi.ts";

export type ChatGoalStatus = "active" | "paused" | "budget-limited" | "complete" | "dropped";
const GOAL_STATUSES: Record<ChatGoalStatus, true> = { active: true, paused: true, "budget-limited": true, complete: true, dropped: true };

const MAX_OBJECTIVE_CHARS = 2_000;

/** The goal of goal mode, as the footer chip and the goal notices show it. */
export interface ChatGoal {
	objective: string;
	status: ChatGoalStatus;
	tokensUsed: number;
	tokenBudget?: number;
	timeUsedSeconds?: number;
}

export interface ChatFastMode {
	enabled: boolean;
	/** The active model supports it: `enabled` alone means the setting is on but this model ignores it. */
	active: boolean;
}

export interface ChatSlowMode {
	supported: boolean;
	enabled: boolean;
	/** Where the active model's `/slow` lives: persisted config shared by every session, or this session's flex tier. */
	scope?: "session" | "global";
}

/** Usage-limit stage of the active model's account; absent outside wrap-up and low priority. */
export type ChatUsageLimit =
	| { stage: "low_priority"; resetsAtSec: number; allowanceLeftPercent?: number }
	| { stage: "wrap_up"; resetsAtSec?: number; extraUsage: boolean };

function count(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function parseChatGoal(value: unknown): ChatGoal | null {
	if (!isRecord(value) || typeof value.objective !== "string" || typeof value.status !== "string" || !Object.hasOwn(GOAL_STATUSES, value.status) || !count(value.tokensUsed)) return null;
	const objective = stripAnsi(value.objective, MAX_OBJECTIVE_CHARS * 4).trim();
	return {
		objective: objective.length <= MAX_OBJECTIVE_CHARS ? objective : `${objective.slice(0, MAX_OBJECTIVE_CHARS - 1)}…`,
		status: value.status as ChatGoalStatus,
		tokensUsed: value.tokensUsed,
		...(count(value.tokenBudget) ? { tokenBudget: value.tokenBudget } : {}),
		...(count(value.timeUsedSeconds) ? { timeUsedSeconds: value.timeUsedSeconds } : {}),
	};
}

/**
 * The goal the footer shows, as the terminal UI's goal segment decides: while goal mode is on (`state.enabled`) or the
 * goal is paused; a dropped goal, a cleared one and a goal without a mode state are not shown. `state` is a
 * `GoalModeState` (`get_state.goal`, `goal_updated.state`), `goal` its `Goal`.
 */
export function footerGoal(goal: unknown, state: unknown): ChatGoal | null {
	const parsed = parseChatGoal(goal);
	if (parsed === null || parsed.status === "dropped") return null;
	return (isRecord(state) && state.enabled === true) || parsed.status === "paused" ? parsed : null;
}

export function parseFastMode(data: Record<string, unknown>): ChatFastMode | null {
	if (typeof data.fastModeEnabled !== "boolean" && typeof data.fastModeActive !== "boolean") return null;
	return { enabled: data.fastModeEnabled === true, active: data.fastModeActive === true };
}

export function parseSlowMode(data: Record<string, unknown>): ChatSlowMode | null {
	if (typeof data.slowModeSupported !== "boolean") return null;
	return {
		supported: data.slowModeSupported,
		enabled: data.slowModeSupported && data.slowModeEnabled === true,
		...(data.slowModeScope === "session" || data.slowModeScope === "global" ? { scope: data.slowModeScope } : {}),
	};
}

export function parseUsageLimit(value: unknown): ChatUsageLimit | null {
	if (!isRecord(value)) return null;
	if (value.stage === "low_priority") {
		if (!count(value.resetsAtSec)) return null;
		return { stage: "low_priority", resetsAtSec: value.resetsAtSec, ...(count(value.allowanceLeftPercent) ? { allowanceLeftPercent: Math.min(100, Math.round(value.allowanceLeftPercent)) } : {}) };
	}
	if (value.stage === "wrap_up") return { stage: "wrap_up", extraUsage: value.extraUsage === true, ...(count(value.resetsAtSec) ? { resetsAtSec: value.resetsAtSec } : {}) };
	return null;
}

/** OMP's `formatSlowModeResetClock`: a clock time when the reset is within 20 hours, a weekday and clock time beyond. */
function resetClock(resetsAtSec: number, now: number): string {
	const at = new Date(resetsAtSec * 1000);
	return resetsAtSec * 1000 - now > 20 * 3_600_000
		? at.toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })
		: at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** The terminal UI's status-line text for a usage-limit stage (`formatUsageLimitLabel`). */
export function usageLimitLabel(limit: ChatUsageLimit, now: number): string {
	if (limit.stage === "low_priority") {
		return `low priority until ${resetClock(limit.resetsAtSec, now)}${limit.allowanceLeftPercent === undefined ? "" : ` · ${limit.allowanceLeftPercent}% left`}`;
	}
	if (limit.extraUsage) return "limit reached · wrap-up, then extra usage";
	return `limit reached · wrapping up${limit.resetsAtSec === undefined ? "" : ` · resets ${resetClock(limit.resetsAtSec, now)}`}`;
}

/** Why a prompt that ended in `error` failed (`prompt_result.error`): OMP's own retries are already spent when it arrives. */
export interface ChatPromptError {
	/** The provider's error text, without OMP-local diagnostics. */
	message: string;
	provider?: string;
	model?: string;
	httpStatus?: number;
	/** The failure is classed transient: sending the message again later may succeed. */
	retryable: boolean;
}

function bounded(value: unknown, max: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const clean = stripAnsi(value, max * 4).trim();
	if (clean.length === 0) return undefined;
	return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

export function parsePromptError(value: unknown): ChatPromptError | null {
	if (!isRecord(value)) return null;
	const message = bounded(value.message, 2_000);
	if (message === undefined) return null;
	const provider = bounded(value.provider, 100);
	const model = bounded(value.model, 200);
	return {
		message,
		...(provider === undefined ? {} : { provider }),
		...(model === undefined ? {} : { model }),
		...(typeof value.httpStatus === "number" && Number.isInteger(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599 ? { httpStatus: value.httpStatus } : {}),
		retryable: value.retryable === true,
	};
}
