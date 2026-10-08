/** Canonical todo evidence and display selection, shared by host and page. */
import { isRecord } from "../guards.ts";
import type { ChatEntry } from "./messages.ts";

export type TodoStatus = "pending" | "in_progress" | "completed" | "abandoned" | "blocked";
export interface TodoTask { content: string; status: TodoStatus; blocker?: string; details?: string; notes?: readonly string[] }
export interface TodoPhase { name: string; tasks: readonly TodoTask[] }
export interface TodoProjection { phases: readonly TodoPhase[]; entryId: string | null; appliedAt: number }

export function parseTodoPhases(value: unknown): TodoPhase[] | null {
	if (!Array.isArray(value)) return null;
	const phases: TodoPhase[] = [];
	for (const raw of value) {
		if (!isRecord(raw) || typeof raw.name !== "string" || !Array.isArray(raw.tasks)) return null;
		const tasks: TodoTask[] = [];
		for (const item of raw.tasks) {
			if (!isRecord(item) || typeof item.content !== "string") return null;
			const status = item.status;
			if (status !== "pending" && status !== "in_progress" && status !== "completed" && status !== "abandoned" && status !== "blocked") return null;
			const task: TodoTask = { content: item.content, status };
			if (typeof item.blocker === "string") task.blocker = item.blocker;
			if (typeof item.details === "string") task.details = item.details;
			if (Array.isArray(item.notes)) task.notes = item.notes.filter((note): note is string => typeof note === "string");
			tasks.push(task);
		}
		phases.push({ name: raw.name, tasks });
	}
	return phases;
}

export function todoPhasesFromToolResult(result: unknown): TodoPhase[] | null {
	if (!isRecord(result) || result.isError === true || !isRecord(result.details) || result.details.op === "view") return null;
	return parseTodoPhases(result.details.phases);
}
export function todoPhasesFromEntry(entry: ChatEntry): TodoPhase[] | null {
	if (entry.type === "custom" && entry.customType === "user_todo_edit" && isRecord(entry.data)) return parseTodoPhases(entry.data.phases);
	if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "todo") return null;
	return todoPhasesFromToolResult(entry.message);
}
export function latestTodoFromEntries(entries: readonly ChatEntry[]): { phases: readonly TodoPhase[]; entryId: string } | null {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry === undefined) continue;
		const phases = todoPhasesFromEntry(entry);
		if (phases !== null) return { phases, entryId: entry.id };
	}
	return null;
}
export function isClosedTodo(task: Pick<TodoTask, "status">): boolean {
	return task.status === "completed" || task.status === "abandoned";
}
export function todoMatchesDescriptions(content: string, descriptions: readonly string[]): boolean {
	const target = content.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
	if (target.length === 0) return false;
	for (const description of descriptions) {
		const normalized = description.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
		if (target === normalized || (Math.min(target.length, normalized.length) >= 6 && (target.includes(normalized) || normalized.includes(target)))) return true;
	}
	return false;
}
export function selectCollapsedTodos(tasks: readonly TodoTask[], descriptions: readonly string[], cap = 8): { items: readonly TodoTask[]; hidden: number; hiddenActive: boolean } {
	const open = tasks.filter(task => !isClosedTodo(task));
	const base = open.length === 0 ? tasks : open;
	const lead = open.length === 0 ? [] : tasks.filter(isClosedTodo).slice(-1);
	if (base.length <= cap) return { items: [...lead, ...base], hidden: 0, hiddenActive: false };
	const active = base.filter(task => task.status === "in_progress" || (task.status === "pending" && todoMatchesDescriptions(task.content, descriptions)));
	if (active.length > cap) return { items: [...lead, ...active.slice(0, cap)], hidden: active.length - cap, hiddenActive: true };
	const fill: TodoTask[] = [];
	const activeSet = new Set(active);
	for (let index = active.length === 0 ? 0 : base.indexOf(active[0]!); index < base.length && active.length + fill.length < cap; index += 1) {
		const task = base[index]!;
		if (!activeSet.has(task)) fill.push(task);
	}
	return { items: [...lead, ...active, ...fill], hidden: base.length - active.length - fill.length, hiddenActive: false };
}
export function todoHudSelection(phases: readonly TodoPhase[]): {
	phase: TodoPhase | null; task: TodoTask | null; phaseClosed: number; phaseTotal: number; closed: number; total: number;
} {
	const nonempty = phases.filter(phase => phase.tasks.length > 0);
	const phase = nonempty.find(candidate => candidate.tasks.some(task => task.status === "pending" || task.status === "in_progress")) ?? nonempty.at(-1) ?? null;
	let inProgress: TodoTask | null = null;
	let pending: TodoTask | null = null;
	let closed = 0;
	let total = 0;
	for (const candidate of phases) for (const task of candidate.tasks) {
		total += 1;
		if (isClosedTodo(task)) closed += 1;
		if (inProgress === null && task.status === "in_progress") inProgress = task;
		if (pending === null && task.status === "pending") pending = task;
	}
	return { phase, task: inProgress ?? pending, phaseClosed: phase?.tasks.filter(isClosedTodo).length ?? 0, phaseTotal: phase?.tasks.length ?? 0, closed, total };
}
