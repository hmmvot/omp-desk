import path from "node:path";
import type { HostToolContext, HostToolDefinition, HostToolResult } from "../tools/host-tool.ts";
import type { BreakpointInfo, DebugApi, ProtocolBreakpoint } from "./debug-api.ts";
import { admit, Args, errorResult, expressionDenial, guarded, textResult, unsupported } from "./tool-support.ts";
import type { DebugToolEnv } from "./tool-support.ts";

/** Window-level queue key: breakpoints are window-wide in VS Code, so their changes serialize together. */
const BREAKPOINT_QUEUE = "breakpoints";
const MAX_LISTED = 100;
const SOURCE_BREAKPOINT_ACTIONS = ["list", "add", "remove", "clear"] as const;

type Ownership = "user" | "this conversation" | "another conversation";

function ownershipOf(env: DebugToolEnv, id: string, conversationId: string): Ownership {
	const owner = env.coordinator.owner(id);
	if (owner === undefined) return "user";
	return owner === conversationId ? "this conversation" : "another conversation";
}

function locationOf(breakpoint: BreakpointInfo): string {
	if (breakpoint.kind === "source") return `${breakpoint.path ?? "?"}:${breakpoint.line ?? "?"}`;
	return breakpoint.label ?? breakpoint.kind;
}

/** What one live debug session says about one breakpoint. */
async function sessionStates(env: DebugToolEnv, breakpoint: BreakpointInfo): Promise<string[]> {
	const states: string[] = [];
	for (const session of env.coordinator.sessions()) {
		if (session.state.kind === "terminated") continue;
		let report: ProtocolBreakpoint | undefined;
		try {
			report = await env.api.protocolBreakpoint(session.id, breakpoint.id);
		} catch {
			report = undefined;
		}
		if (!report && breakpoint.path !== undefined && breakpoint.line !== undefined) {
			report = env.coordinator.trackerBreakpoint(session.id, breakpoint.path, breakpoint.line);
		}
		const label = `${session.type} ${session.id}`;
		if (!report) states.push(`${label}: requested`);
		else if (report.verified) states.push(`${label}: verified`);
		else states.push(`${label}: unverified${report.message ? ` (${report.message})` : ""}`);
	}
	return states;
}

async function describeBreakpoint(env: DebugToolEnv, breakpoint: BreakpointInfo, conversationId: string): Promise<{ text: string; row: Record<string, unknown> }> {
	const owner = ownershipOf(env, breakpoint.id, conversationId);
	const states = await sessionStates(env, breakpoint);
	const parts = [`${breakpoint.id}  ${locationOf(breakpoint)}${breakpoint.enabled ? "" : " (disabled)"}  owner: ${owner}`];
	if (breakpoint.condition) parts.push(`condition: ${breakpoint.condition}`);
	if (breakpoint.hitCondition) parts.push(`hit condition: ${breakpoint.hitCondition}`);
	if (breakpoint.logMessage) parts.push(`log message: ${breakpoint.logMessage}`);
	if (states.length > 0) parts.push(`sessions: ${states.join("; ")}`);
	return { text: parts.join("; "), row: { id: breakpoint.id, location: locationOf(breakpoint), owner, states } };
}

function resolveFile(api: DebugApi, file: string): string | undefined {
	if (path.isAbsolute(file)) return api.isFile(file) ? path.normalize(file) : undefined;
	for (const folder of api.workspaceFolders()) {
		const candidate = path.resolve(folder.path, file);
		if (api.isFile(candidate)) return candidate;
	}
	return undefined;
}

async function list(env: DebugToolEnv, conversationId: string): Promise<HostToolResult> {
	const all = env.api.breakpoints();
	if (all.length === 0) return textResult("No breakpoints are set in this window.", { action: "list", count: 0, rows: [] });
	const shown = all.slice(0, MAX_LISTED);
	const lines: string[] = [];
	const rows: Record<string, unknown>[] = [];
	for (const breakpoint of shown) {
		const described = await describeBreakpoint(env, breakpoint, conversationId);
		lines.push(described.text);
		rows.push(described.row);
	}
	const more = all.length - shown.length;
	return textResult(`${all.length} breakpoint(s). Breakpoints are window-wide and apply to every debug session.\n${lines.join("\n")}${more > 0 ? `\n... ${more} more not shown` : ""}`, { action: "list", count: all.length, rows });
}

async function add(env: DebugToolEnv, args: Args, ctx: HostToolContext): Promise<HostToolResult> {
	const file = args.requiredString("file");
	const line = args.integer("line", 1, 10_000_000);
	if (line === undefined) return errorResult('"line" is required (a one-based line number).');
	const condition = args.string("condition");
	const logMessage = args.string("logMessage");
	const hitCount = args.integer("hitCount", 1, 2_147_483_647);
	const resolved = resolveFile(env.api, file);
	if (resolved === undefined) return errorResult(`"${file}" is not an existing file (give an absolute path, or one relative to a workspace folder).`);

	const expressions = [
		...(condition ? [`Condition: ${condition}`] : []),
		...(logMessage ? [`Log message: ${logMessage}`] : []),
	];
	if (expressions.length > 0) {
		const denial = await expressionDenial(env, ctx, [`Breakpoint at ${resolved}:${line}`, ...expressions]);
		if (denial) return errorResult(denial);
	}
	return await env.coordinator.mutate(BREAKPOINT_QUEUE, ctx.signal, async () => {
		admit(env, ctx);
		const live = env.coordinator.sessions().filter(session => session.state.kind !== "terminated");
		const needs: { feature: string; capability: string; wanted: boolean }[] = [
			{ feature: "conditions", capability: "supportsConditionalBreakpoints", wanted: !!condition },
			{ feature: "hit counts", capability: "supportsHitConditionalBreakpoints", wanted: hitCount !== undefined },
			{ feature: "log messages", capability: "supportsLogPoints", wanted: !!logMessage },
		];
		for (const need of needs) {
			if (!need.wanted) continue;
			// Refused only when every tracked session is known not to support it; with no session the adapter is not yet known.
			const tracked = live.filter(session => session.tracked);
			if (tracked.length > 0 && tracked.length === live.length && tracked.every(session => env.coordinator.capabilities(session.id)[need.capability] !== true)) {
				return errorResult(`Breakpoint ${need.feature} are ${unsupported(tracked.map(session => session.type).join(", "))}.`);
			}
		}
		const existing = env.api.breakpoints().find(breakpoint => breakpoint.kind === "source" && breakpoint.line === line && breakpoint.path !== undefined && path.normalize(breakpoint.path).toLowerCase() === resolved.toLowerCase());
		const hitCondition = hitCount !== undefined ? String(hitCount) : undefined;
		if (existing) {
			const owner = ownershipOf(env, existing.id, ctx.conversationId);
			const same = (existing.condition ?? undefined) === (condition || undefined) && (existing.hitCondition ?? undefined) === hitCondition && (existing.logMessage ?? undefined) === (logMessage || undefined);
			if (owner === "this conversation" && same) {
				return textResult(`A breakpoint with these settings already exists at ${resolved}:${line} (${existing.id}).`, { action: "add", id: existing.id, location: `${resolved}:${line}`, existing: true });
			}
			return errorResult(`A breakpoint already exists at ${resolved}:${line} (${existing.id}, owner: ${owner}). Desk never changes an existing breakpoint${owner === "this conversation" ? "; remove it first" : ""}.`);
		}
		admit(env, ctx);
		const id = env.api.addSourceBreakpoint({
			path: resolved,
			line,
			...(condition ? { condition } : {}),
			...(hitCondition !== undefined ? { hitCondition } : {}),
			...(logMessage ? { logMessage } : {}),
		});
		env.coordinator.claimBreakpoint(id, ctx.conversationId);
		const breakpoint = env.api.breakpoints().find(candidate => candidate.id === id);
		const described = breakpoint ? await settle(env, breakpoint) : undefined;
		return textResult(`Breakpoint ${id} added at ${resolved}:${line}.${described ? ` ${described.states.join("; ") || "No debug session is running; adapters verify it when a session starts."}` : ""} Unverified is not an error: an adapter may verify it later, for example when Unity loads the assembly.`, { action: "add", id, location: `${resolved}:${line}`, states: described?.states ?? [] });
	});
}

/** Gives adapters a short moment to verify a breakpoint just added, then reports what each session says. */
async function settle(env: DebugToolEnv, breakpoint: BreakpointInfo): Promise<{ states: string[] }> {
	const deadline = Date.now() + env.breakpointSettleMs;
	for (;;) {
		const states = await sessionStates(env, breakpoint);
		if (states.every(state => state.endsWith(": verified")) || Date.now() >= deadline) return { states };
		await new Promise<void>(resolve => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))));
	}
}

async function remove(env: DebugToolEnv, args: Args, ctx: HostToolContext): Promise<HostToolResult> {
	const id = args.string("id");
	const file = args.string("file");
	const line = args.integer("line", 1, 10_000_000);
	if (id === undefined && (file === undefined || line === undefined)) return errorResult('Give the breakpoint "id" from the list, or its "file" and "line".');
	return await env.coordinator.mutate(BREAKPOINT_QUEUE, ctx.signal, async () => {
		admit(env, ctx);
		let target: BreakpointInfo | undefined;
		if (id !== undefined) {
			target = env.api.breakpoints().find(breakpoint => breakpoint.id === id);
		} else {
			const resolved = resolveFile(env.api, file!);
			target = env.api.breakpoints().find(breakpoint => breakpoint.kind === "source" && breakpoint.line === line && resolved !== undefined && breakpoint.path !== undefined && path.normalize(breakpoint.path).toLowerCase() === resolved.toLowerCase());
		}
		if (!target) return errorResult("No such breakpoint.");
		const owner = ownershipOf(env, target.id, ctx.conversationId);
		if (owner !== "this conversation") return errorResult(`Breakpoint ${target.id} at ${locationOf(target)} is not owned by this conversation (owner: ${owner}); Desk never removes a breakpoint the user or another conversation set.`);
		env.api.removeBreakpoints([target.id]);
		env.coordinator.releaseBreakpoint(target.id);
		return textResult(`Breakpoint ${target.id} at ${locationOf(target)} removed.`, { action: "remove", id: target.id });
	});
}

async function clear(env: DebugToolEnv, ctx: HostToolContext): Promise<HostToolResult> {
	return await env.coordinator.mutate(BREAKPOINT_QUEUE, ctx.signal, async () => {
		admit(env, ctx);
		const present = new Set(env.api.breakpoints().map(breakpoint => breakpoint.id));
		const owned = env.coordinator.ownedBreakpoints(ctx.conversationId).filter(id => present.has(id));
		if (owned.length > 0) env.api.removeBreakpoints(owned);
		for (const id of owned) env.coordinator.releaseBreakpoint(id);
		return textResult(owned.length === 0 ? "This conversation has no breakpoints to remove." : `Removed ${owned.length} breakpoint(s) set by this conversation. The user's breakpoints are untouched.`, { action: "clear", removed: owned.length });
	});
}

export function breakpointTool(env: DebugToolEnv): HostToolDefinition {
	return {
		name: "vscode_debug_breakpoints",
		label: "Debug breakpoints",
		description: "List, add, remove or clear breakpoints in the user's VS Code window. Breakpoints are window-wide and apply to every debug session; the list shows the user's breakpoints and this conversation's, with each debug session's state (requested, verified, or unverified with the adapter's message; an adapter may verify later, for example when Unity loads the assembly). You can only remove breakpoints you added. `hitCount` is a positive integer. Conditions and log messages run code in the debuggee and need the user's permission.",
		parameters: {
			type: "object",
			properties: {
				action: { type: "string", enum: [...SOURCE_BREAKPOINT_ACTIONS], description: "list, add, remove (one of yours, by id or file and line) or clear (all of yours)." },
				file: { type: "string", description: "Source file: absolute, or relative to a workspace folder." },
				line: { type: "integer", minimum: 1, description: "One-based line." },
				condition: { type: "string", description: "Stop only when this expression is true (runs code in the debuggee)." },
				hitCount: { type: "integer", minimum: 1, description: "Stop on this hit count." },
				logMessage: { type: "string", description: "Log this message instead of stopping (runs code in the debuggee)." },
				id: { type: "string", description: "Breakpoint id from list, for remove." },
			},
			required: ["action"],
			additionalProperties: false,
		},
		loadMode: "discoverable",
		async execute(raw, ctx) {
			return await guarded(() => undefined, async () => {
				const args = new Args(raw);
				const action = args.requiredOneOf("action", SOURCE_BREAKPOINT_ACTIONS);
				admit(env, ctx);
				switch (action) {
					case "list": return await list(env, ctx.conversationId);
					case "add": return await add(env, args, ctx);
					case "remove": return await remove(env, args, ctx);
					case "clear": return await clear(env, ctx);
				}
			});
		},
	};
}
