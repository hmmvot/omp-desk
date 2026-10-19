/**
 * When the TODO row of the Chat's bottom block is shown. It mirrors the terminal UI's auto-clear without writing to the
 * session file: a list whose every task is closed (`completed` or `abandoned`) leaves the row after OMP's
 * `tasks.todoClearDelay`, and a list that changes shows again (OMP 18.11.1: `interactive-mode.ts` `#syncTodoHudState`,
 * `tools/todo.ts` `getTodoHudVisibility`). The row is presentation only: `model.todo.phases`, the TODO detail tab and the
 * transcript's todo cards are untouched. Pure; the host's clock is `src/host/rpc/todo-hud.ts`.
 */
import { isClosedTodo, type TodoPhase, type TodoProjection } from "./todos.ts";
import { todoSummary } from "./hud-summary.ts";

/** The custom entry type OMP's terminal UI writes when it clears or reveals the TODO row (`tools/todo.ts`). Desk only reads it. */
export const TODO_HUD_STATE_CUSTOM_TYPE = "todo_hud_state";

/** The two values OMP's `todo_hud_state` custom entry carries. */
export type TodoHudVisibility = "dismissed" | "revealed";

/** OMP's default for `tasks.todoClearDelay`, in seconds; what applies when the setting cannot be read. */
export const DEFAULT_TODO_CLEAR_DELAY_SECONDS = 60;

/** The longest delay a timer can hold (a larger one would fire at once); a delay beyond it counts as never. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * What the session file says about the latest durable todo list on the branch: the identity OMP gives it, when it was
 * written, and the visibility the newest `todo_hud_state` entry that was written for exactly this list records.
 */
export interface TodoHudHistory {
	/** OMP's `todoPhasesFingerprint` of the list; a live list matches only when its own fingerprint is equal. */
	readonly fingerprint: string;
	/** Epoch milliseconds of the entry that holds the list, or `null` when its timestamp is unreadable. */
	readonly changedAt: number | null;
	readonly visibility: TodoHudVisibility | null;
}

/** OMP's own list identity (`todoPhasesFingerprint`): names, task text, statuses and blockers; notes and details are not part of it. */
export function todoFingerprint(phases: readonly TodoPhase[]): string {
	return JSON.stringify(
		phases.map(phase => ({
			name: phase.name,
			tasks: phase.tasks.map(task =>
				task.blocker === undefined
					? { content: task.content, status: task.status }
					: { content: task.content, status: task.status, blocker: task.blocker },
			),
		})),
	);
}

/** Whether the list has tasks and every one is closed, as the terminal UI checks before it starts its timer. */
export function todoListClosed(phases: readonly TodoPhase[]): boolean {
	let any = false;
	for (const phase of phases) for (const task of phase.tasks) {
		if (!isClosedTodo(task)) return false;
		any = true;
	}
	return any;
}

/**
 * The delay in milliseconds, or `null` for never. `undefined` (the setting could not be read) takes OMP's default;
 * anything else is judged as OMP judges it: only a finite, non-negative number hides the list.
 */
export function todoClearDelayMs(seconds: unknown): number | null {
	if (seconds === undefined) return DEFAULT_TODO_CLEAR_DELAY_SECONDS * 1000;
	if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return null;
	const ms = seconds * 1000;
	return ms > MAX_TIMER_MS ? null : ms;
}

/** Whether the Chat's TODO row shows: there is a list with tasks and its row has not been cleared. */
export function todoRowShown(todo: TodoProjection | null): boolean {
	return todo !== null && !todo.hidden && todoSummary(todo.phases) !== null;
}
