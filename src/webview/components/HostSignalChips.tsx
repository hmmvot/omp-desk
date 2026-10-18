/**
 * The session facts the terminal UI's status line keeps next to the model, as quiet chips beside the model and thinking
 * pickers: the goal of goal mode (with its token budget), fast mode, slow mode and the usage-limit stage of the account.
 * They are display only and come from OMP's own `get_state` readback (kept current by `goal_updated`); a chip appears only
 * while its fact holds. The per-reply token rate is not shown here: `get_state` carries one sample, not a stream.
 */
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import type { ChatGoal } from "../../chat/host-signals.ts";
import { usageLimitLabel } from "../../chat/host-signals.ts";
import type { ChatLiteState } from "../../chat/model.ts";
import { fmtDuration, fmtTokens } from "../../shared/format.ts";

const GOAL_ICON: Record<ChatGoal["status"], string> = { active: "target", paused: "debug-pause", "budget-limited": "warning", complete: "pass", dropped: "target" };
const GOAL_STATUS_WORD: Record<ChatGoal["status"], string> = { active: "active", paused: "paused", "budget-limited": "budget used up", complete: "complete", dropped: "dropped" };

/** `12.3k` or `12.3k/50k`: the tokens a goal has used, against its budget when it has one. */
export function goalBudgetText(goal: ChatGoal): string {
	return goal.tokenBudget === undefined ? fmtTokens(goal.tokensUsed) : `${fmtTokens(goal.tokensUsed)}/${fmtTokens(goal.tokenBudget)}`;
}

function goalTitle(goal: ChatGoal): string {
	const lines = [`Goal (${GOAL_STATUS_WORD[goal.status]}): ${goal.objective}`, `Tokens: ${goalBudgetText(goal)}${goal.tokenBudget === undefined ? "" : " used"}`];
	if (goal.timeUsedSeconds !== undefined && goal.timeUsedSeconds > 0) lines.push(`Time: ${fmtDuration(goal.timeUsedSeconds * 1000)}`);
	return lines.join("\n");
}

function useMinuteClock(active: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!active) return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), 60_000);
		return () => clearInterval(timer);
	}, [active]);
	return now;
}

export function HostSignalChips({ state }: { state: ChatLiteState | null }): ReactNode {
	const limit = state?.usageLimit;
	const now = useMinuteClock(limit !== undefined);
	if (state === null) return null;
	const { goal, fastMode, slowMode } = state;
	// Claude's low-priority lane is both a slow mode and a usage-limit stage: the limit's text already says it.
	const slow = slowMode?.enabled === true && limit?.stage !== "low_priority";
	if (goal === undefined && fastMode?.active !== true && !slow && limit === undefined) return null;
	return (
		<span className="omp-signals">
			{goal !== undefined && (
				<span className={`omp-signal${goal.status === "paused" || goal.status === "budget-limited" ? " omp-signal--warn" : ""}`} data-signal="goal" data-goal-status={goal.status} title={goalTitle(goal)}>
					<span aria-hidden="true" className={`codicon codicon-${GOAL_ICON[goal.status]}`} />
					<span className="omp-signal-text">Goal {goalBudgetText(goal)}</span>
				</span>
			)}
			{fastMode?.active === true && (
				<span className="omp-signal" data-signal="fast" title="Fast mode is on for this model">
					<span aria-hidden="true" className="codicon codicon-zap" />
					<span className="omp-signal-text">Fast</span>
				</span>
			)}
			{slow && (
				<span className="omp-signal" data-signal="slow" title={slowMode?.scope === "global" ? "Slow mode is on for this model, in OMP's settings (every session)" : "Slow mode is on for this model, in this session"}>
					<span aria-hidden="true" className="codicon codicon-watch" />
					<span className="omp-signal-text">Slow</span>
				</span>
			)}
			{limit !== undefined && (
				<span className="omp-signal omp-signal--warn" data-signal="usage-limit" data-usage-stage={limit.stage} title="Your account has reached its usage limit; OMP keeps serving requests under the stage shown">
					<span aria-hidden="true" className="codicon codicon-warning" />
					<span className="omp-signal-text">{usageLimitLabel(limit, now)}</span>
				</span>
			)}
		</span>
	);
}
