import type { ReactNode } from "react";
import { DEBUG_TOOL_TITLES } from "../../chat/tool-presentation";
import { fmtDuration } from "../../shared/format";
import { useLiveDurations } from "../lib/live-clock";
import { JsonOutput, scalar, Section, string, TextPreview } from "./tool-renderer-primitives";
import type { ToolRenderContext, ToolSemanticView } from "./tool-render-types";

/**
 * Chat cards for the host-run `vscode_debug_*` tools (docs/designs/2026-10-10-agent-debugger-tools.md section 5):
 * one line in the Overview (`Wait for stop · 2m 13s`), the arguments and the result text in Detailed. Facts come from
 * the structured `details` the tools return, and the call's own arguments; the model's text is never parsed.
 */


export const DEBUG_TOOL_ICONS: Readonly<Record<string, string>> = {
	vscode_debug_configs: "debug-console",
	vscode_debug_breakpoints: "debug-breakpoint",
	vscode_debug_start: "debug-start",
	vscode_debug_wait: "watch",
	vscode_debug_inspect: "eye",
	vscode_debug_control: "debug-continue",
	vscode_debug_handoff: "account",
};

const CONTROL_TITLES: Readonly<Record<string, string>> = {
	continue: "Debug continue",
	next: "Debug step over",
	stepIn: "Debug step into",
	stepOut: "Debug step out",
	pause: "Debug pause",
	stop: "Stop debugging",
};

/** Outcomes of `vscode_debug_start` that did not start a controllable session. */
const FAILED_START = new Set(["refused", "error", "not-identified", "unknown", "declined"]);

/** The last path segment of a file the call names, so a row shows `a.js:3`, not a long path. */
function baseName(path: string): string {
	return path.replaceAll("\\", "/").split("/").filter(Boolean).pop() ?? path;
}

function Elapsed({ id, reportedMs, live }: { id: string; reportedMs: number; live: boolean }): ReactNode {
	const durationOf = useLiveDurations([{ id, reportedMs, running: live }], live);
	const ms = durationOf(id);
	return ms === undefined ? null : <span className="omp-empty-note omp-tool-elapsed">{fmtDuration(ms)}</span>;
}

function body(c: ToolRenderContext): ReactNode {
	const args = Object.fromEntries(Object.entries(c.args).filter(([key, value]) => value != null && key !== "i" && key !== "__partialJson"));
	const text = c.text.trimEnd();
	return <>
		{Object.keys(args).length > 0 && <Section title="Arguments"><JsonOutput value={args} expanded={c.expanded} omitAbsent /></Section>}
		{c.hasResult && (text ? <Section title="Result"><TextPreview text={text} expanded={c.expanded} lines={6} /></Section> : <div className="omp-empty-note">(no output)</div>)}
	</>;
}

function view(c: ToolRenderContext, title: string, target: string, patch: Partial<ToolSemanticView> = {}): ToolSemanticView {
	return { title, family: "vscode-debug", target: target || undefined, body: body(c), tone: c.isError ? "error" : undefined, ...patch };
}

function configs(c: ToolRenderContext): ToolSemanticView {
	const sessions = Array.isArray(c.details.sessions) ? c.details.sessions.length : undefined;
	const folders = Array.isArray(c.details.folders) ? c.details.folders.length : undefined;
	const target = folders === undefined ? "" : `${folders} folder${folders === 1 ? "" : "s"} · ${sessions ?? 0} session${sessions === 1 ? "" : "s"}`;
	return view(c, DEBUG_TOOL_TITLES.vscode_debug_configs!, target);
}

function breakpoints(c: ToolRenderContext): ToolSemanticView {
	const action = string(c.args.action) || string(c.details.action);
	const where = string(c.args.file) ? `${baseName(string(c.args.file))}${c.args.line !== undefined ? `:${scalar(c.args.line)}` : ""}` : string(c.details.location) ? baseName(string(c.details.location)) : "";
	const count = action === "list" && typeof c.details.count === "number" ? `${c.details.count} set` : "";
	return view(c, DEBUG_TOOL_TITLES.vscode_debug_breakpoints!, [action, where, count].filter(Boolean).join(" · "));
}

function start(c: ToolRenderContext): ToolSemanticView {
	const outcome = string(c.details.outcome);
	const label = string(c.args.name) || string(c.args.preset);
	const failed = FAILED_START.has(outcome);
	return view(c, DEBUG_TOOL_TITLES.vscode_debug_start!, label, { meta: outcome && outcome !== "started" ? [outcome] : [], tone: c.isError || failed ? "error" : undefined });
}

function wait(c: ToolRenderContext): ToolSemanticView {
	const outcome = string(c.details.outcome);
	const elapsed = typeof c.details.elapsedMs === "number" ? c.details.elapsedMs : undefined;
	const live = c.partial;
	const target = live ? "waiting" : outcome === "stopped" ? `stopped${string(c.details.reason) ? ` · ${string(c.details.reason)}` : ""}` : outcome === "terminated" ? "session ended" : outcome === "timeout" ? "timed out" : "";
	return view(c, DEBUG_TOOL_TITLES.vscode_debug_wait!, target, {
		tone: c.isError ? "error" : outcome === "timeout" ? "warning" : undefined,
		trailing: elapsed !== undefined ? <Elapsed id={c.callId ?? "wait"} reportedMs={elapsed} live={live} /> : undefined,
	});
}

function inspect(c: ToolRenderContext): ToolSemanticView {
	const what = string(c.args.what) || string(c.details.what);
	const detail = what === "evaluate" ? string(c.args.expression) : what === "stack" && c.args.threadId !== undefined ? `thread ${scalar(c.args.threadId)}` : "";
	return view(c, DEBUG_TOOL_TITLES.vscode_debug_inspect!, [what, detail].filter(Boolean).join(" · "));
}

function control(c: ToolRenderContext): ToolSemanticView {
	const action = string(c.args.action) || string(c.details.action);
	const thread = c.args.threadId !== undefined ? `thread ${scalar(c.args.threadId)}` : typeof c.details.threadId === "number" ? `thread ${c.details.threadId}` : "";
	return view(c, CONTROL_TITLES[action] ?? DEBUG_TOOL_TITLES.vscode_debug_control!, thread);
}

function handoff(c: ToolRenderContext): ToolSemanticView {
	return view(c, DEBUG_TOOL_TITLES.vscode_debug_handoff!, string(c.args.message).replace(/\s+/g, " ").slice(0, 100));
}

export const debugToolRenderers: Record<string, (context: ToolRenderContext) => ToolSemanticView> = {
	vscode_debug_configs: configs,
	vscode_debug_breakpoints: breakpoints,
	vscode_debug_start: start,
	vscode_debug_wait: wait,
	vscode_debug_inspect: inspect,
	vscode_debug_control: control,
	vscode_debug_handoff: handoff,
};

