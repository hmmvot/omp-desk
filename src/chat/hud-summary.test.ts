import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentActivity, RunningAgent } from "./agents.ts";
import {
	agentsSummary,
	agentWindow,
	agentWindowWithin,
	HUD_HEADER_PX,
	HUD_LINE_PX,
	HUD_LIST_PAD_PX,
	HUD_ROW_LIMIT,
	HUD_STACK_PAD_PX,
	HUD_VIEWPORT_SHARE,
	hudSectionLines,
	romanNumeral,
	runningAgentDescriptions,
	todoGlyph,
	todoNoteMarker,
	todoSummary,
	todoWindow,
	todoWindowWithin,
} from "./hud-summary.ts";
import type { TodoPhase, TodoTask } from "./todos.ts";

function tasks(count: number, status: TodoTask["status"] = "pending", prefix = "Task"): TodoTask[] {
	return Array.from({ length: count }, (_, index) => ({ content: `${prefix} ${index + 1}`, status }));
}
function agent(id: string, patch: Partial<RunningAgent> = {}): RunningAgent {
	return { id, index: 0, agent: "implementer", agentSource: "builtin", status: "running", lastUpdate: 1, ...patch };
}
function view(rows: RunningAgent[], activity: [string, AgentActivity][] = [], agentAvailability = "available") {
	return { agents: new Map(rows.map(row => [row.id, row])), agentActivity: new Map(activity), agentAvailability };
}

describe("TODO collapsed summary", () => {
	it("has exactly one counter with an unambiguous title and the current task", () => {
		const phases: TodoPhase[] = [
			{ name: "A", tasks: [...tasks(3, "completed"), { content: "Doing it", status: "in_progress" }] },
			{ name: "B", tasks: tasks(5) },
		];
		const summary = todoSummary(phases)!;
		assert.equal(summary.current, "Doing it");
		assert.equal(summary.counter, "3/9");
		assert.equal(summary.title, "3 of 9 tasks closed");
		assert.deepEqual(Object.keys(summary).sort(), ["closed", "counter", "current", "title", "total"]);
	});

	it("counts abandoned as closed and says why no task is current", () => {
		assert.equal(todoSummary([{ name: "A", tasks: [{ content: "Done", status: "completed" }, { content: "Dropped", status: "abandoned" }] }])!.current, "All tasks closed");
		assert.equal(todoSummary([{ name: "A", tasks: [{ content: "Wait", status: "blocked", blocker: "CI" }] }])!.current, "No actionable task");
		assert.equal(todoSummary([{ name: "A", tasks: tasks(1) }])!.title, "0 of 1 task closed");
	});

	it("renders nothing without tasks", () => {
		assert.equal(todoSummary([]), null);
		assert.equal(todoSummary([{ name: "Empty", tasks: [] }]), null);
	});
});

describe("TODO expanded rows", () => {
	it("lists everything, with roman phase headers only for several phases", () => {
		const single = todoWindow([{ name: "Only", tasks: tasks(3) }], []);
		assert.deepEqual(single.rows.map(row => row.kind), ["task", "task", "task"]);
		assert.equal(single.hidden, 0);
		const multi = todoWindow([{ name: "First", tasks: [...tasks(1, "completed"), ...tasks(1)] }, { name: "Second", tasks: tasks(2) }], []);
		assert.deepEqual(multi.rows.map(row => row.kind), ["phase", "task", "task", "phase", "task", "task"]);
		const headers = multi.rows.filter(row => row.kind === "phase");
		assert.deepEqual(headers.map(row => row.label), ["I. First", "II. Second"]);
		assert.deepEqual(headers.map(row => `${row.closed}/${row.total}`), ["1/2", "0/2"]);
		assert.equal(headers[0]!.current, true);
		assert.equal(headers[1]!.current, false);
	});

	it("past eight rows walks the TUI viewport: current phase, open tasks, later phases as headers", () => {
		const phases: TodoPhase[] = [
			{ name: "Done", tasks: tasks(4, "completed") },
			{ name: "Now", tasks: [...tasks(2, "completed", "Old"), { content: "Active", status: "in_progress" }, ...tasks(9)] },
			{ name: "Later", tasks: tasks(3) },
			{ name: "Last", tasks: tasks(2) },
		];
		const window = todoWindow(phases, []);
		assert.ok(window.rows.length <= HUD_ROW_LIMIT);
		assert.equal(window.rows[0]!.kind === "phase" && window.rows[0]!.label, "II. Now");
		const contents = window.rows.map(row => row.kind === "task" ? row.task.content : `[${row.label}]`);
		assert.ok(contents.includes("Active"), "the actionable task is visible");
		assert.equal(contents.includes("Old 1"), false, "closed history is omitted but the last closed task leads in");
		assert.ok(contents.includes("Old 2"));
		assert.equal(window.rows.some(row => row.kind === "task" && (phases[2]!.tasks.includes(row.task) || phases[3]!.tasks.includes(row.task))), false, "later phases never show tasks");
		const shownTasks = window.rows.filter(row => row.kind === "task").length;
		assert.equal(window.hidden, 4 + 12 + 3 + 2 - shownTasks, "hidden counts tasks, not rows");
	});

	it("always shows the actionable task, even when it lives in a later phase than the first open one", () => {
		const phases: TodoPhase[] = [
			{ name: "First", tasks: [{ content: "Waiting", status: "blocked" }, ...tasks(3)] },
			{ name: "Second", tasks: [...tasks(12, "pending", "Later"), { content: "Current", status: "in_progress" }] },
		];
		const window = todoWindow(phases, []);
		assert.ok(window.rows.length <= HUD_ROW_LIMIT);
		assert.ok(window.rows.some(row => row.kind === "task" && row.task.content === "Current"));
	});

	it("keeps the actionable task in a long single phase", () => {
		const list = [...tasks(10, "completed"), { content: "Active", status: "in_progress" as const }, ...tasks(10)];
		const window = todoWindow([{ name: "Long", tasks: list }], []);
		assert.ok(window.rows.length <= HUD_ROW_LIMIT);
		const contents = window.rows.map(row => row.kind === "task" ? row.task.content : "");
		assert.ok(contents.includes("Active"));
		assert.equal(window.hidden, 21 - window.rows.length);
	});

	it("lights a pending task a running agent names, like the TUI", () => {
		const rows = todoWindow([{ name: "A", tasks: [{ content: "Implement native UI", status: "pending" }, { content: "Other thing here", status: "pending" }] }], ["implement native ui"]).rows;
		assert.equal(rows[0]!.kind === "task" && rows[0]!.matched, true);
		assert.equal(rows[1]!.kind === "task" && rows[1]!.matched, false);
	});

	it("uses the TUI's glyph semantics and compact note marker", () => {
		assert.deepEqual(todoGlyph("completed", false), { icon: "check", tone: "success", struck: true });
		assert.deepEqual(todoGlyph("abandoned", false), { icon: "circle-slash", tone: "error", struck: true });
		assert.equal(todoGlyph("blocked", false).icon, "warning");
		assert.equal(todoGlyph("pending", true).tone, "accent");
		assert.equal(todoGlyph("pending", false).tone, "dim");
		assert.equal(todoNoteMarker(0), "");
		assert.equal(todoNoteMarker(2), "\u207a\u00b2");
		assert.equal(todoNoteMarker(12), "\u207a\u00b9\u00b2");
		assert.deepEqual([1, 4, 9, 14].map(romanNumeral), ["I", "IV", "IX", "XIV"]);
	});
});

describe("Agents rows", () => {
	it("summarizes counts and who is doing what, for the first two running agents", () => {
		const model = view(
			[
				agent("ScrollJump", { index: 0, progress: { currentTool: "read", lastIntent: "Reading App.tsx" } }),
				agent("AskDialogRefresh", { index: 1, description: "Fix menu" }),
				agent("Third", { index: 2 }),
				agent("Done", { index: 3, status: "completed" }),
			],
			[["Third", { type: "x", tool: "edit", timestamp: 1 }]],
		);
		assert.equal(agentsSummary(model).text, "3 running, 1 completed · ScrollJump: read · Reading App.tsx · AskDialogRefresh: Fix menu");
	});

	it("names the registry as unavailable instead of showing zero", () => {
		assert.deepEqual(agentsSummary(view([], [], "unavailable")), { text: "registry unavailable", warn: true });
	});

	it("rows carry glyph, id, type badge, description, activity and native elapsed only", () => {
		const model = view(
			[
				agent("Anna", { index: 0, description: "Review\nthe change", progress: { durationMs: 41_000, currentTool: "grep" } }),
				agent("Bob", { index: 1, agent: "task", task: "IRC wake text that is never a description", assignment: "First line\nsecond line" }),
			],
			[["Bob", { type: "x", intent: "Listing", timestamp: 2 }]],
		);
		const [anna, bob] = agentWindow(model).rows;
		assert.deepEqual([anna!.id, anna!.badge, anna!.icon, anna!.description, anna!.activity, anna!.elapsedMs], ["Anna", "implementer", "loading codicon-modifier-spin", "Review the change", "grep", 41_000]);
		assert.deepEqual([bob!.badge, bob!.description, bob!.activity, bob!.elapsedMs], ["", "First line", "Listing", null]);
	});

	it("the assignment fallback skips markdown headings and keeps a lone heading's text", () => {
		const [headed, lone] = agentWindow(view([agent("A", { index: 0, assignment: "# Target\n\nNo files, no tools.\n# Change" }), agent("B", { index: 1, assignment: "## Only a heading" })])).rows;
		assert.deepEqual([headed!.description, lone!.description], ["No files, no tools.", "Only a heading"]);
	});

	it("bounds the rows and counts the rest", () => {
		const many = Array.from({ length: 11 }, (_, index) => agent(`A${String(index).padStart(2, "0")}`, { index }));
		const window = agentWindow(view(many));
		assert.equal(window.rows.length, HUD_ROW_LIMIT);
		assert.equal(window.hidden, 3);
	});

	it("matches pending tasks against running agents only", () => {
		const descriptions = runningAgentDescriptions([agent("A", { description: " Build it " }), agent("B", { status: "completed", description: "Done thing" }), agent("C", { progress: { description: "From progress" } })]);
		assert.deepEqual(descriptions, ["Build it", "From progress"]);
	});
});

describe("bottom block height cap", () => {
	const stackHeight = (visible: number, expanded: number, lines: number, shown: number): number =>
		HUD_STACK_PAD_PX + visible * HUD_HEADER_PX + expanded * HUD_LIST_PAD_PX + shown * lines * HUD_LINE_PX;

	it("gives one open row the whole share and splits it between two", () => {
		assert.equal(hudSectionLines(900, 2, 0), 0);
		assert.ok(hudSectionLines(900, 1, 1) >= HUD_ROW_LIMIT + 1, "a tall window keeps the eight rows and +N more");
		const alone = hudSectionLines(600, 2, 1), both = hudSectionLines(600, 2, 2);
		assert.ok(both < alone && both >= 1);
	});

	it("never lets the rows exceed the viewport share once the floor of one row plus +N more fits", () => {
		for (const height of [300, 360, 400, 500, 600, 700, 900, 1200]) {
			for (const [visible, expanded] of [[1, 1], [2, 1], [2, 2]] as const) {
				const lines = hudSectionLines(height, visible, expanded);
				if (lines < 2) continue;
				assert.ok(stackHeight(visible, expanded, lines, expanded) <= height * HUD_VIEWPORT_SHARE + 0.001, `${height}px, ${visible} shown, ${expanded} open`);
			}
		}
	});

	it("fits a truncated TODO window into its lines including +N more, and keeps the actionable task", () => {
		const phases: TodoPhase[] = [
			{ name: "A", tasks: tasks(4, "completed", "Done") },
			{ name: "B", tasks: [...tasks(2, "completed", "Built"), { content: "Current", status: "in_progress" }, ...tasks(5, "pending", "Later")] },
			{ name: "C", tasks: tasks(3, "pending", "Ship") },
		];
		for (const lines of [1, 2, 3, 4, 5, 6, 9, 20]) {
			const window = todoWindowWithin(phases, [], lines);
			assert.ok(window.rows.some(row => row.kind === "task" && row.task.content === "Current"), `lines ${lines}: the actionable task shows`);
			if (lines >= 2) assert.ok(window.rows.length + (window.hidden > 0 ? 1 : 0) <= lines, `lines ${lines}: ${window.rows.length} rows + more`);
			else assert.deepEqual(window.rows.map(row => row.kind), ["task"], "the phase header gives way when only one row fits");
			assert.ok(window.hidden > 0);
		}
		assert.equal(todoWindowWithin([{ name: "Only", tasks: tasks(3) }], [], 3).hidden, 0, "everything that fits shows without +N more");
	});

	it("fits the agent window and names the rest", () => {
		const roster = view(Array.from({ length: 11 }, (_, index) => agent(`A${index}`, { index })));
		for (const lines of [1, 2, 4, 9, 30]) {
			const window = agentWindowWithin(roster, lines);
			assert.ok(window.rows.length >= 1);
			assert.ok(window.rows.length + (window.hidden > 0 ? 1 : 0) <= Math.max(lines, 2), `lines ${lines}`);
			assert.equal(window.rows.length + window.hidden, 11);
		}
		assert.equal(agentWindowWithin(roster, 9).rows.length, HUD_ROW_LIMIT);
		assert.equal(agentWindowWithin(view([agent("only")]), 1).hidden, 0);
	});
});
