/**
 * Pure view-model of the pinned TODO and Agents rows and their detail tabs.
 *
 * Collapsed summaries, the bounded expanded row windows and the glyph choices live here, not in
 * React, so the rules the OMP TUI applies (`#renderTodoList`, `#formatTodoLine`,
 * `renderSubagentHudLines`) are testable without a browser and cannot drift between the rows
 * and the detail tab. Nothing here writes native status or reproduces interactive auto-clear.
 */
import type { AgentActivity, AgentStatus, RunningAgent } from "./agents.ts";
import { isClosedTodo, selectCollapsedTodos, todoHudSelection, todoMatchesDescriptions, type TodoPhase, type TodoStatus, type TodoTask } from "./todos.ts";

/** Content rows an expanded pinned row shows before its single `+N more` row. */
export const HUD_ROW_LIMIT = 8;
/**
 * The pinned rows sit in the bottom block (above the composer), so together they may take at most
 * this share of the viewport. The pixel heights are the rows' fixed CSS heights (`hud-styles.ts`
 * interpolates them), which is what makes the cap computable without measuring.
 */
export const HUD_VIEWPORT_SHARE = 0.4;
/** A header row (the disclosure line): 4px + 18px line + 4px. */
export const HUD_HEADER_PX = 26;
/** One expanded content line, and the `+N more` line. */
export const HUD_LINE_PX = 20;
/** Bottom padding under an expanded list. */
export const HUD_LIST_PAD_PX = 4;
/** Breathing room between the stack and the composer card. */
export const HUD_STACK_PAD_PX = 4;

/**
 * Lines (content rows plus the `+N more` row) each expanded row may use so that the whole stack
 * stays within {@link HUD_VIEWPORT_SHARE} of the viewport. `visible` counts the rendered header
 * rows, `expanded` those of them that are open; the open ones split the room evenly.
 */
export function hudSectionLines(viewportHeight: number, visible: number, expanded: number): number {
	if (expanded <= 0) return 0;
	const room = viewportHeight * HUD_VIEWPORT_SHARE - HUD_STACK_PAD_PX - visible * HUD_HEADER_PX - expanded * HUD_LIST_PAD_PX;
	return Math.max(0, Math.floor(room / expanded / HUD_LINE_PX));
}

/**
 * Fit a window into `lines` rows including its `+N more` row. The usual 8-row bound applies first;
 * when a truncated window would still exceed the room, the row for `+N more` is taken from the
 * content. `min` keeps the invariant content (the actionable task) even in a very short viewport.
 */
function fitWindow<T extends { rows: readonly unknown[]; hidden: number }>(build: (limit: number) => T, lines: number, min: number): T {
	const first = build(Math.max(min, Math.min(HUD_ROW_LIMIT, lines)));
	if (first.hidden === 0 || first.rows.length + 1 <= lines) return first;
	return build(Math.max(min, lines - 1));
}
/** Running-agent fragments a collapsed Agents line names. */
export const AGENTS_SUMMARY_NAMES = 2;

function collapse(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

// TODO

/** Descriptions of running agents: a pending task naming one of them is shown as active work. */
export function runningAgentDescriptions(agents: Iterable<RunningAgent>): string[] {
	const descriptions: string[] = [];
	for (const agent of agents) {
		if (agent.status !== "running") continue;
		const progressDescription = agent.progress?.description;
		const description = agent.description?.trim() || (typeof progressDescription === "string" ? progressDescription.trim() : "") || agent.agent.trim();
		if (description.length > 0) descriptions.push(description);
	}
	return descriptions;
}

export interface TodoSummary {
	/** The in-progress or first pending task, else the sentence that says why there is none. */
	current: string;
	closed: number;
	total: number;
	/** The one counter: `closed/total`. */
	counter: string;
	/** Its accessible name: "3 of 9 tasks closed". */
	title: string;
}

/** `null` when no phase has a task: the row is not rendered at all. */
export function todoSummary(phases: readonly TodoPhase[]): TodoSummary | null {
	const selection = todoHudSelection(phases);
	if (selection.total === 0) return null;
	const current = selection.task?.content ?? (selection.closed === selection.total ? "All tasks closed" : "No actionable task");
	return {
		current,
		closed: selection.closed,
		total: selection.total,
		counter: `${selection.closed}/${selection.total}`,
		title: `${selection.closed} of ${selection.total} ${selection.total === 1 ? "task" : "tasks"} closed`,
	};
}

export type TodoTone = "success" | "accent" | "dim" | "error" | "warning";
export interface TodoGlyph { icon: string; tone: TodoTone; struck: boolean }

/** The TUI's `#formatTodoLine`: completed/abandoned struck, in-progress and agent-matched pending accented. */
export function todoGlyph(status: TodoStatus, matched: boolean): TodoGlyph {
	switch (status) {
		case "completed": return { icon: "check", tone: "success", struck: true };
		case "in_progress": return { icon: "play", tone: "accent", struck: false };
		case "abandoned": return { icon: "circle-slash", tone: "error", struck: true };
		case "blocked": return { icon: "warning", tone: "warning", struck: false };
		case "pending": return { icon: "circle-large-outline", tone: matched ? "accent" : "dim", struck: false };
	}
}

/** Status in words, for assistive technology and the detail tab (never a visible chip in the pinned row). */
export const TODO_STATUS_WORD: Record<TodoStatus, string> = {
	pending: "pending",
	in_progress: "in progress",
	completed: "completed",
	abandoned: "abandoned",
	blocked: "blocked",
};

const SUPERSCRIPT_DIGITS = "\u2070\u00b9\u00b2\u00b3\u2074\u2075\u2076\u2077\u2078\u2079";
/** The TUI's compact note marker: superscript plus and count, e.g. `⁺²`; empty without notes. */
export function todoNoteMarker(count: number): string {
	if (!Number.isSafeInteger(count) || count <= 0) return "";
	return `\u207a${[...String(count)].map(digit => SUPERSCRIPT_DIGITS[Number(digit)] ?? digit).join("")}`;
}

/** One-based roman numeral (I, II, III, IV …), as the TUI labels stages. */
export function romanNumeral(oneBased: number): string {
	if (!Number.isSafeInteger(oneBased) || oneBased <= 0) return "";
	const table: ReadonlyArray<readonly [number, string]> = [[1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"], [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]];
	let remaining = oneBased;
	let out = "";
	for (const [value, numeral] of table) {
		while (remaining >= value) { out += numeral; remaining -= value; }
	}
	return out;
}

export interface TodoPhaseRow { kind: "phase"; key: string; label: string; closed: number; total: number; current: boolean }
export interface TodoTaskRow {
	kind: "task";
	key: string;
	task: TodoTask;
	glyph: TodoGlyph;
	/** A pending task a running agent's description names. */
	matched: boolean;
	noteCount: number;
}
export type TodoRow = TodoPhaseRow | TodoTaskRow;
export interface TodoWindow {
	rows: readonly TodoRow[];
	/** Tasks outside the window, before or after it. The row that reports them opens the TODO tab. */
	hidden: number;
}

/**
 * The expanded TODO rows. When every phase header and task fits in `limit` rows, all of them, in
 * order. Past that, the TUI's walking viewport (`selectCollapsedTodos`): the phase holding the
 * actionable task (else the current phase) with its open tasks, active work first and the last
 * closed task as lead-in, followed by later phases as headers only. Earlier phases and closed
 * history are omitted. The actionable task is always among the rows.
 */
export function todoWindow(phases: readonly TodoPhase[], descriptions: readonly string[], limit = HUD_ROW_LIMIT): TodoWindow {
	const nonEmpty = phases.filter(phase => phase.tasks.length > 0);
	const multiPhase = nonEmpty.length > 1;
	const selection = todoHudSelection(phases);
	const holding = selection.task === null ? undefined : nonEmpty.find(phase => phase.tasks.includes(selection.task!));
	const current = holding ?? selection.phase ?? nonEmpty[0];
	if (current === undefined) return { rows: [], hidden: 0 };
	const currentIndex = nonEmpty.indexOf(current);
	const totalTasks = nonEmpty.reduce((sum, phase) => sum + phase.tasks.length, 0);

	const header = (phase: TodoPhase, phaseIndex: number): TodoPhaseRow => ({
		kind: "phase",
		key: `phase:${phaseIndex}:${phase.name}`,
		label: `${romanNumeral(phaseIndex + 1)}. ${collapse(phase.name)}`,
		closed: phase.tasks.filter(isClosedTodo).length,
		total: phase.tasks.length,
		current: phase === current,
	});
	const task = (phase: TodoPhase, phaseIndex: number, item: TodoTask): TodoTaskRow => {
		const matched = item.status === "pending" && todoMatchesDescriptions(item.content, descriptions);
		return { kind: "task", key: `task:${phaseIndex}:${phase.tasks.indexOf(item)}:${item.content}`, task: item, glyph: todoGlyph(item.status, matched), matched, noteCount: item.notes?.length ?? 0 };
	};

	if (totalTasks + (multiPhase ? nonEmpty.length : 0) <= limit) {
		return { rows: nonEmpty.flatMap((phase, phaseIndex) => [...(multiPhase ? [header(phase, phaseIndex)] : []), ...phase.tasks.map(item => task(phase, phaseIndex, item))]), hidden: 0 };
	}

	const rows: TodoRow[] = [];
	if (multiPhase && limit >= 2) rows.push(header(current, currentIndex));
	const room = Math.max(1, limit - rows.length);
	const picked = selectCollapsedTodos(current.tasks, descriptions, room).items.slice(0, room);
	const actionable = selection.task !== null && current.tasks.includes(selection.task) ? selection.task : null;
	if (actionable !== null && !picked.includes(actionable)) picked.splice(Math.max(0, picked.length - 1), picked.length > 0 ? 1 : 0, actionable);
	picked.sort((left, right) => current.tasks.indexOf(left) - current.tasks.indexOf(right));
	for (const item of picked) rows.push(task(current, currentIndex, item));
	if (multiPhase) {
		for (let phaseIndex = currentIndex + 1; phaseIndex < nonEmpty.length && rows.length < limit; phaseIndex += 1) rows.push(header(nonEmpty[phaseIndex]!, phaseIndex));
	}
	return { rows, hidden: totalTasks - picked.length };
}

/** {@link todoWindow} within `lines` rows, `+N more` included. The actionable task always shows; the phase header gives way first. */
export function todoWindowWithin(phases: readonly TodoPhase[], descriptions: readonly string[], lines: number): TodoWindow {
	return fitWindow(limit => todoWindow(phases, descriptions, limit), lines, 1);
}

// Agents

export const AGENT_STATUS_ICON: Record<AgentStatus, string> = {
	// The same two classes the tool rows use, so every running glyph shares one rotating animation.
	running: "loading codicon-modifier-spin",
	pending: "clock",
	completed: "check",
	failed: "error",
	aborted: "circle-slash",
};

export interface AgentsModelView {
	readonly agents: ReadonlyMap<string, RunningAgent>;
	readonly agentActivity: ReadonlyMap<string, AgentActivity>;
	readonly agentAvailability: string;
}

export function sortedAgents(agents: ReadonlyMap<string, RunningAgent>): RunningAgent[] {
	return [...agents.values()].sort((left, right) => left.index - right.index || left.id.localeCompare(right.id));
}

/** The current `tool · intent` of one agent: native progress first, then the latest activity event. */
export function agentActivityText(progress: Record<string, unknown> | undefined, activity: AgentActivity | undefined): string {
	const tool = typeof progress?.currentTool === "string" && progress.currentTool ? progress.currentTool : activity?.tool;
	const intent = typeof progress?.lastIntent === "string" && progress.lastIntent ? progress.lastIntent : activity?.intent;
	return collapse(tool && intent ? `${tool} · ${intent}` : tool || intent || "");
}

/**
 * The spawn description (the TUI's `: description`), else the first line of the spawn's assignment. A woken
 * agent's `task` is the IRC message that woke it, so it is never a description.
 */
export function agentDescription(agent: RunningAgent): string {
	const progressDescription = agent.progress?.description;
	const described = collapse(agent.description ?? (typeof progressDescription === "string" ? progressDescription : ""));
	if (described.length > 0) return described;
	// An assignment often opens with a markdown heading such as "# Target"; the first line of real text says more.
	const lines = (agent.assignment ?? "").split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0);
	return collapse(lines.find(line => !line.startsWith("#")) ?? (lines[0] ?? "").replace(/^#+\s*/, ""));
}

/** The last native elapsed time reported; an agent whose progress carries none shows none, never an estimate. The webview's `useAgentElapsed` advances it between reports. */
export function agentElapsedMs(agent: RunningAgent): number | null {
	const duration = agent.progress?.durationMs;
	return typeof duration === "number" && Number.isFinite(duration) && duration > 0 ? duration : null;
}

export interface AgentRow {
	id: string;
	type: string;
	/** The `⟨type⟩` badge; empty for the generic `task` worker (like the TUI) and for an agent whose type is its own id. */
	badge: string;
	status: AgentStatus;
	icon: string;
	description: string;
	activity: string;
	elapsedMs: number | null;
}

export function agentRow(agent: RunningAgent, activity: AgentActivity | undefined): AgentRow {
	const type = agent.agent.trim();
	return {
		id: agent.id,
		type,
		badge: type.length === 0 || type === "task" || type === agent.id ? "" : type,
		status: agent.status,
		icon: AGENT_STATUS_ICON[agent.status],
		description: agentDescription(agent),
		activity: agentActivityText(agent.progress, activity),
		elapsedMs: agentElapsedMs(agent),
	};
}

export interface AgentWindow { rows: readonly AgentRow[]; hidden: number }

export function agentWindow(model: AgentsModelView, limit = HUD_ROW_LIMIT): AgentWindow {
	const all = sortedAgents(model.agents);
	return { rows: all.slice(0, limit).map(agent => agentRow(agent, model.agentActivity.get(agent.id))), hidden: Math.max(0, all.length - limit) };
}

/** {@link agentWindow} within `lines` rows, `+N more` included; at least one agent shows. */
export function agentWindowWithin(model: AgentsModelView, lines: number): AgentWindow {
	return fitWindow(limit => agentWindow(model, limit), lines, 1);
}

const SUMMARY_STATES: readonly AgentStatus[] = ["running", "pending", "completed", "failed", "aborted"];

/**
 * The collapsed Agents line: counts by state, then who is doing what for the first running agents.
 * An unavailable native registry is stated, never shown as zero.
 */
export function agentsSummary(model: AgentsModelView): { text: string; warn: boolean } {
	if (model.agentAvailability === "unavailable") return { text: "registry unavailable", warn: true };
	const agents = sortedAgents(model.agents);
	const counts = SUMMARY_STATES.map(status => [status, agents.filter(agent => agent.status === status).length] as const).filter(([, count]) => count > 0);
	const parts = counts.map(([status, count]) => `${count} ${status}`);
	const fragments: string[] = [];
	for (const agent of agents) {
		if (agent.status !== "running" || fragments.length >= AGENTS_SUMMARY_NAMES) continue;
		const row = agentRow(agent, model.agentActivity.get(agent.id));
		const doing = row.activity || row.description || row.type;
		fragments.push(doing.length > 0 ? `${agent.id}: ${doing}` : agent.id);
	}
	return { text: [parts.join(", "), ...fragments].filter(part => part.length > 0).join(" · "), warn: false };
}
