import path from "node:path";
import { isRecord } from "../../shared/guards.ts";
import type { HostToolContext, HostToolDefinition, HostToolResult } from "../tools/host-tool.ts";
import { breakpointTool } from "./breakpoint-tool.ts";
import type { LaunchOutcome, SessionView } from "./coordinator.ts";
import { describeState } from "./coordinator.ts";
import type { ControlCommand, LaunchConfigurations, WorkspaceFolderInfo } from "./debug-api.ts";
import { inspectTool } from "./inspect-tool.ts";
import { admit, ArgumentError, Args, errorResult, guarded, raceTimeout, requireGrant, textResult } from "./tool-support.ts";
import type { DebugToolEnv } from "./tool-support.ts";

const CONTROL_ACTIONS = ["continue", "next", "stepIn", "stepOut", "pause", "stop"] as const;
const DEFAULT_WAIT_SECONDS = 600;
const MAX_WAIT_SECONDS = 3600;
const MAX_HANDOFF_MESSAGE = 500;

function originText(view: SessionView, conversationId: string): string {
	if (!view.tracked) return "untracked: debugger state is not available in this extension-host lifetime";
	if (view.origin === "user") return "started by the user";
	if (view.handedOff) return "started by Desk, handed off to the user";
	return view.startedBy === conversationId ? "started by this conversation (you may control it)" : "started by Desk for another conversation";
}

function sessionLine(view: SessionView, conversationId: string): string {
	const parent = view.parentId !== undefined ? `; parent ${view.parentId}` : "";
	return `${view.id}  ${view.type} "${view.name}"${parent}; ${originText(view, conversationId)}; ${view.tracked ? describeState(view.state) : "state not available"}${view.adapterError !== undefined ? ` (last adapter error: ${view.adapterError})` : ""}; generation ${view.generation}`;
}

function folderFor(env: DebugToolEnv, text: string | undefined): WorkspaceFolderInfo | { error: string } {
	const folders = env.api.workspaceFolders();
	if (text === undefined || text === "") {
		if (folders.length === 1) return folders[0]!;
		return { error: folders.length === 0 ? "No workspace folder is open in this window." : `"folder" is required: this window has ${folders.length} workspace folders (${folders.map(folder => folder.name).join(", ")}).` };
	}
	const wanted = path.normalize(text).toLowerCase();
	const match = folders.find(folder => folder.name === text || path.normalize(folder.path).toLowerCase() === wanted);
	return match ?? { error: `"${text}" is not a workspace folder of this window (${folders.map(folder => folder.name).join(", ") || "none"}).` };
}

function configsTool(env: DebugToolEnv): HostToolDefinition {
	return {
		name: "vscode_debug_configs",
		label: "Debug configurations",
		description: "List the user's VS Code debug setup: named launch configurations per workspace folder (compound configurations are listed but cannot be started), the Desk presets available in this window, and the current debug sessions with their origin (started by the user, or by this or another conversation) and state. Use the session ids it shows with the other vscode_debug_* tools.",
		parameters: { type: "object", properties: {}, additionalProperties: false },
		loadMode: "discoverable",
		async execute(_raw, ctx) {
			return await guarded(() => undefined, async () => {
				admit(env, ctx);
				const lines: string[] = [];
				const folders = env.api.workspaceFolders();
				const folderRows: Record<string, unknown>[] = [];
				for (const folder of folders) {
					let launch: LaunchConfigurations;
					try {
						launch = env.api.launchConfigurations(folder.path);
					} catch (error) {
						lines.push(`Folder "${folder.name}": launch configurations could not be read (${error instanceof Error ? error.message : String(error)}).`);
						continue;
					}
					lines.push(`Folder "${folder.name}" (${folder.path}):`);
					for (const configuration of launch.configurations) {
						const program = typeof configuration.program === "string" ? `, program ${configuration.program}` : "";
						lines.push(`  - ${String(configuration.name)}  [${String(configuration.type)} ${String(configuration.request)}${program}]`);
					}
					for (const compound of launch.compounds) lines.push(`  - ${compound}  [compound: not supported; start its member configurations one by one]`);
					if (launch.configurations.length === 0 && launch.compounds.length === 0) lines.push("  (no launch configurations)");
					folderRows.push({ name: folder.name, configurations: launch.configurations.map(configuration => String(configuration.name)), compounds: [...launch.compounds] });
				}
				if (folders.length === 0) lines.push("No workspace folder is open in this window.");
				const presets = env.presets().filter(preset => preset.available());
				lines.push(presets.length > 0 ? `Presets: ${presets.map(preset => `${preset.id} (${preset.label})`).join(", ")}` : "Presets: none available in this window.");
				const sessions = env.coordinator.sessions();
				lines.push(sessions.length > 0 ? "Debug sessions:" : "No debug sessions.");
				for (const view of sessions) lines.push(`  - ${sessionLine(view, ctx.conversationId)}`);
				return textResult(lines.join("\n"), {
					folders: folderRows,
					presets: presets.map(preset => preset.id),
					sessions: sessions.map(view => ({ id: view.id, type: view.type, name: view.name, state: view.state.kind, generation: view.generation })),
				});
			});
		},
	};
}

function describeLaunchOutcome(env: DebugToolEnv, outcome: LaunchOutcome, label: string, conversationId: string): HostToolResult {
	switch (outcome.kind) {
		case "started": {
			const lines = outcome.sessionIds.map(id => {
				const view = env.coordinator.session(id);
				return view ? `  - ${sessionLine(view, conversationId)}` : `  - ${id}`;
			});
			return textResult(`Started ${label}. You may control the session(s) below until you hand off.\n${lines.join("\n")}\nNext: set breakpoints, then vscode_debug_wait for a stop. A program that spawns debug targets (for example Node) may add child sessions: list them with vscode_debug_configs.`, { outcome: "started", sessionIds: [...outcome.sessionIds] });
		}
		case "refused": return errorResult(`VS Code refused to start ${label}: ${outcome.detail}`, { outcome: "refused" });
		case "error": return errorResult(`VS Code could not start ${label}: ${outcome.detail}`, { outcome: "error" });
		case "not-identified": return errorResult(`VS Code reported that ${label} started, but no debug session carrying this start's marker appeared (session not identified). It is not controllable by this conversation. Look for it with vscode_debug_configs; it is read-only.`, { outcome: "not-identified" });
		case "unknown": return errorResult(`The outcome of starting ${label} is unknown: ${outcome.detail}`, { outcome: "unknown" });
	}
}

function startTool(env: DebugToolEnv): HostToolDefinition {
	return {
		name: "vscode_debug_start",
		label: "Debug start",
		get description() {
			const presets = env.presets().filter(preset => preset.available());
			return `Start debugging in the user's VS Code: either a named launch configuration (folder and name from vscode_debug_configs; compound configurations are refused) or a Desk preset by id.${presets.length > 0 ? ` ${presets.map(preset => preset.description).join(" ")}` : ""} The user may be asked to confirm. On success you get the debug session id and may control that session (and its child sessions) until you hand off. There is no fallback to any other session and nothing is retried.`;
		},
		parameters: {
			type: "object",
			properties: {
				folder: { type: "string", description: "Workspace folder name or path (optional when the window has one folder)." },
				name: { type: "string", description: "Launch configuration name." },
				preset: { type: "string", description: "Desk preset id instead of a named configuration." },
				endPoint: { type: "string", description: "Preset option: where to attach (host:port), when the preset supports it." },
				projectPath: { type: "string", description: "Preset option: absolute path of the project (the Unity project folder), when it is not the workspace folder." },
			},
			additionalProperties: false,
		},
		loadMode: "discoverable",
		async execute(raw, ctx) {
			return await guarded(() => undefined, async () => {
				const args = new Args(raw);
				const folderText = args.string("folder");
				const name = args.string("name");
				const presetId = args.string("preset");
				if ((name === undefined) === (presetId === undefined)) return errorResult('Give either "name" (a launch configuration) or "preset".');
				admit(env, ctx);
				let configuration: Record<string, unknown>;
				let label: string;
				let folder: WorkspaceFolderInfo | undefined;
				if (name !== undefined) {
					const resolved = folderFor(env, folderText);
					if ("error" in resolved) return errorResult(resolved.error);
					folder = resolved;
					const found = findConfiguration(env, folder, name);
					if ("error" in found) return errorResult(found.error);
					configuration = found.configuration;
					label = `configuration "${name}" in folder "${folder.name}"`;
				} else {
					const preset = env.presets().find(candidate => candidate.id === presetId);
					if (!preset || !preset.available()) return errorResult(`Preset "${presetId}" is not available in this window.`);
					const endPoint = args.string("endPoint");
					const projectPath = args.string("projectPath");
					const built = preset.build({ ...(endPoint !== undefined ? { endPoint } : {}), ...(projectPath !== undefined ? { projectPath } : {}) });
					if ("error" in built) return errorResult(built.error);
					configuration = built.configuration;
					label = `preset "${preset.label}"`;
					if (folderText !== undefined) {
						const resolved = folderFor(env, folderText);
						if ("error" in resolved) return errorResult(resolved.error);
						folder = resolved;
					} else if (env.api.workspaceFolders().length === 1) {
						folder = env.api.workspaceFolders()[0];
					}
				}

				if (env.policy.startMode() === "ask") {
					const confirmed = await env.policy.confirm({
						title: "Allow the agent to start debugging?",
						setting: "start",
						lines: [
							`Folder: ${folder ? `${folder.name} (${folder.path})` : "none"}`,
							`Configuration: ${label}`,
							`Type: ${String(configuration.type)}  Request: ${String(configuration.request)}`,
							...(typeof configuration.program === "string" ? [`Program: ${configuration.program}`] : []),
							"A configuration can run programs and tasks and save files.",
						],
					});
					// The user may have taken a long time, or edited launch.json meanwhile.
					admit(env, ctx);
					if (!confirmed) return errorResult("The user declined to start this debug configuration.", { outcome: "declined" });
					if (name !== undefined && folder) {
						const again = findConfiguration(env, folder, name);
						if ("error" in again) return errorResult(`The configuration changed while the confirmation was open: ${again.error}`);
						if (JSON.stringify(again.configuration) !== JSON.stringify(configuration)) return errorResult("The configuration changed while the confirmation was open; nothing was started. Ask again.");
					}
				}
				admit(env, ctx);
				const outcome = await env.coordinator.launch({ conversationId: ctx.conversationId, ...(folder ? { folderPath: folder.path } : {}), configuration, signal: ctx.signal });
				return describeLaunchOutcome(env, outcome, label, ctx.conversationId);
			});
		},
	};
}

function findConfiguration(env: DebugToolEnv, folder: WorkspaceFolderInfo, name: string): { configuration: Record<string, unknown> } | { error: string } {
	const launch = env.api.launchConfigurations(folder.path);
	const matches = launch.configurations.filter(configuration => configuration.name === name);
	if (matches.length === 0) {
		if (launch.compounds.includes(name)) return { error: `"${name}" is a compound configuration; compound configurations are not supported. Start its member configurations one by one.` };
		return { error: `Folder "${folder.name}" has no launch configuration named "${name}".` };
	}
	if (matches.length > 1) return { error: `Folder "${folder.name}" has ${matches.length} launch configurations named "${name}"; ask the user to rename one.` };
	return { configuration: { ...matches[0]! } };
}

function waitTool(env: DebugToolEnv): HostToolDefinition {
	return {
		name: "vscode_debug_wait",
		label: "Debug wait",
		description: "Wait until a debug session stops (breakpoint, step, exception) or ends. Returns at once if the session is already stopped at a generation newer than `afterGeneration`. Every result states the session's generation; after a control (continue, step), pass the generation it returned as `afterGeneration` so an older stop cannot satisfy the wait. Some debuggers (Node's) run the program in a child session of the session you started: waiting on the started session also covers its child sessions and the result names the session that stopped; use that id for inspect and control. Default timeout 600 s, maximum 3600 s; reports progress and can be cancelled. Works on any tracked session, including the user's.",
		parameters: {
			type: "object",
			properties: {
				sessionId: { type: "string" },
				afterGeneration: { type: "integer", minimum: 0, description: "Only a stop at a newer generation satisfies the wait." },
				timeoutSeconds: { type: "integer", minimum: 1, maximum: MAX_WAIT_SECONDS },
			},
			required: ["sessionId"],
			additionalProperties: false,
		},
		loadMode: "discoverable",
		async execute(raw, ctx) {
			const requested = isRecord(raw) && typeof raw.sessionId === "string" ? raw.sessionId : undefined;
			return await guarded(() => (requested !== undefined ? env.coordinator.session(requested)?.type : undefined), async () => {
				const args = new Args(raw);
				const sessionId = args.requiredString("sessionId");
				const after = args.integer("afterGeneration", 0, Number.MAX_SAFE_INTEGER);
				const timeoutSeconds = args.integer("timeoutSeconds", 1, MAX_WAIT_SECONDS) ?? DEFAULT_WAIT_SECONDS;
				admit(env, ctx);
				const startedAt = Date.now();
				ctx.update(textResult(`Waiting for a stop of session ${sessionId}.`, { waiting: true, elapsedMs: 0 }));
				const outcome = await env.coordinator.waitForStop(sessionId, {
					...(after !== undefined ? { after } : {}),
					timeoutMs: timeoutSeconds * 1000,
					signal: ctx.signal,
					tickMs: env.waitTickMs,
					recheck: () => admit(env, ctx),
					onTick: elapsedMs => {
						const view = env.coordinator.session(sessionId);
						ctx.update(textResult(`Waiting for a stop of session ${sessionId} (${Math.round(elapsedMs / 1000)} s so far; ${view ? describeState(view.state) : "gone"}).`, { waiting: true, elapsedMs }));
					},
				});
				const elapsedMs = Date.now() - startedAt;
				if (outcome.kind === "terminated") {
					const adapterError = env.coordinator.adapterErrorOf(sessionId);
					return textResult(`Debug session ${sessionId} ended (generation ${outcome.generation}).${adapterError !== undefined ? ` The last adapter error was: ${adapterError}.` : ""}`, { outcome: "terminated", generation: outcome.generation, elapsedMs, ...(adapterError !== undefined ? { adapterError } : {}) });
				}
				if (outcome.kind === "timeout") return textResult(`No stop within ${timeoutSeconds} s; the session is ${describeState(outcome.state)} (generation ${outcome.generation}). Wait again with afterGeneration=${outcome.generation}, or pause it with vscode_debug_control.`, { outcome: "timeout", generation: outcome.generation, elapsedMs });
				const top = await topFrame(env, outcome.sessionId, ctx, outcome.state.threadId);
				const where = outcome.sessionId === sessionId ? `Session ${sessionId}` : `Child session ${outcome.sessionId} of ${sessionId}`;
				return textResult(`${where} stopped: ${outcome.state.reason}${outcome.state.description ? ` (${outcome.state.description})` : ""}${outcome.state.threadId !== undefined ? `, thread ${outcome.state.threadId}` : ""}. Generation ${outcome.generation}.${outcome.sessionId === sessionId ? "" : ` Use session id ${outcome.sessionId} to inspect and control it.`}${top ? `\nTop frame: ${top}` : ""}`, { outcome: "stopped", sessionId: outcome.sessionId, generation: outcome.generation, reason: outcome.state.reason, threadId: outcome.state.threadId, elapsedMs });
			});
		},
	};
}

/** The stopped location, best effort: a failure here never fails the wait. */
async function topFrame(env: DebugToolEnv, sessionId: string, ctx: HostToolContext, threadId: number | undefined): Promise<string | undefined> {
	if (threadId === undefined) return undefined;
	try {
		const reader = env.coordinator.reader(sessionId, ctx.signal, { requireStopped: true });
		const body = await reader.request("stackTrace", { threadId, startFrame: 0, levels: 1 });
		const frame = isRecord(body) && Array.isArray(body.stackFrames) ? body.stackFrames.find(isRecord) : undefined;
		if (!frame) return undefined;
		const source = isRecord(frame.source) ? frame.source : undefined;
		const hasPath = source !== undefined && typeof source.path === "string" && !(typeof source.sourceReference === "number" && source.sourceReference > 0);
		return `${String(frame.name ?? "?")} at ${hasPath ? `${source.path as string}${typeof frame.line === "number" ? `:${frame.line}` : ""}` : "(source not available)"}`;
	} catch {
		return undefined;
	}
}

const COMMAND_FOR_ACTION: Readonly<Record<"continue" | "next" | "stepIn" | "stepOut" | "pause", ControlCommand>> = {
	continue: "continue",
	next: "next",
	stepIn: "stepIn",
	stepOut: "stepOut",
	pause: "pause",
};

function controlTool(env: DebugToolEnv): HostToolDefinition {
	return {
		name: "vscode_debug_control",
		label: "Debug control",
		description: "Control a debug session that you started with vscode_debug_start: continue, next (step over), stepIn, stepOut, pause, or stop. Execution actions go through VS Code's own debug commands for one explicit thread, so Run and Debug stays in sync; threadId defaults to the thread that stopped. The result returns the new generation: pass it as afterGeneration to vscode_debug_wait to wait for the next stop. Sessions the user started are read-only to you.",
		parameters: {
			type: "object",
			properties: {
				sessionId: { type: "string" },
				action: { type: "string", enum: [...CONTROL_ACTIONS] },
				threadId: { type: "integer", description: "Adapter thread id; defaults to the stopped thread." },
			},
			required: ["sessionId", "action"],
			additionalProperties: false,
		},
		loadMode: "discoverable",
		async execute(raw, ctx) {
			const requested = isRecord(raw) && typeof raw.sessionId === "string" ? raw.sessionId : undefined;
			return await guarded(() => (requested !== undefined ? env.coordinator.session(requested)?.type : undefined), async () => {
				const args = new Args(raw);
				const sessionId = args.requiredString("sessionId");
				const action = args.requiredOneOf("action", CONTROL_ACTIONS);
				const givenThread = args.integer("threadId", 0, 2_147_483_647);
				admit(env, ctx);
				requireGrant(env, ctx, sessionId);
				return await env.coordinator.mutate(sessionId, ctx.signal, async () => {
					admit(env, ctx);
					const view = requireGrant(env, ctx, sessionId);
					if (action === "stop") return await stop(env, ctx, view);
					return await execute(env, ctx, view, action, givenThread);
				});
			});
		},
	};
}

async function stop(env: DebugToolEnv, ctx: HostToolContext, view: SessionView): Promise<HostToolResult> {
	admit(env, ctx);
	const timeoutMs = env.coordinator.limits.requestTimeoutMs;
	const raced = await raceTimeout(env.api.stopDebugging(view.id), timeoutMs);
	if (raced === "timeout") return errorResult(`VS Code did not confirm within ${Math.round(timeoutMs / 1000)} s that session ${view.id} stopped; its state is unknown.`, { action: "stop", outcome: "unknown" });
	return textResult(`Stop requested for debug session ${view.id}.`, { action: "stop", outcome: "stopped" });
}

async function execute(env: DebugToolEnv, ctx: HostToolContext, view: SessionView, action: Exclude<(typeof CONTROL_ACTIONS)[number], "stop">, givenThread: number | undefined): Promise<HostToolResult> {
	const sessionId = view.id;
	const needsStop = action !== "pause";
	const reader = env.coordinator.reader(sessionId, ctx.signal, { requireStopped: needsStop });
	if (!needsStop && view.state.kind === "stopped") throw new ArgumentError(`Session ${sessionId} is already stopped; pause only applies to a running program.`);
	let threadId = givenThread;
	const threadsBody = await reader.request("threads", {});
	const threads = isRecord(threadsBody) && Array.isArray(threadsBody.threads) ? threadsBody.threads.filter(isRecord) : [];
	if (threadId === undefined) {
		if (view.state.kind === "stopped" && view.state.threadId !== undefined) threadId = view.state.threadId;
		else if (threads.length === 1 && typeof threads[0]!.id === "number") threadId = threads[0]!.id;
		else return errorResult(`"threadId" is required: the session has ${threads.length} thread(s).`);
	}
	// VS Code's debug commands fall back to the focused thread when they cannot resolve the one given, so Desk
	// confirms in this generation that the thread exists in this session and refuses otherwise.
	if (!threads.some(thread => thread.id === threadId)) return errorResult(`Thread ${threadId} does not exist in session ${sessionId}.`);
	reader.assertFresh();
	admit(env, ctx);
	requireGrant(env, ctx, sessionId);
	const transition = env.coordinator.beginDeskTransition(sessionId, action as Exclude<typeof action, "stop">, threadId);
	const timeoutMs = env.coordinator.limits.requestTimeoutMs;
	let outcome: "done" | "timeout";
	try {
		const raced = await raceTimeout(env.api.dispatchControl(COMMAND_FOR_ACTION[action], sessionId, threadId), timeoutMs);
		outcome = raced === "timeout" ? "timeout" : "done";
	} catch (error) {
		transition.failed();
		return errorResult(`VS Code refused to ${action} session ${sessionId}: ${error instanceof Error ? error.message : String(error)}. The state was restored; read it again before acting.`, { action, outcome: "failed" });
	}
	const after = env.coordinator.session(sessionId);
	const state = after ? describeState(after.state) : "gone";
	const note = outcome === "timeout" ? ` The command did not complete within ${Math.round(timeoutMs / 1000)} s; its effect is unknown until the next event.` : "";
	return textResult(`${action} dispatched on thread ${threadId} of session ${sessionId}. State: ${state}.${note}\nNext: vscode_debug_wait with afterGeneration=${transition.generation}. The generation counts every state change, so the next stop arrives with a higher generation than ${transition.generation}, not necessarily ${transition.generation + 1}.`, { action, outcome, generation: transition.generation, threadId });
}

function handoffTool(env: DebugToolEnv): HostToolDefinition {
	return {
		name: "vscode_debug_handoff",
		label: "Debug handoff",
		description: "Hand a paused debug session to the user: reveal the stopped frame in an editor, show Run and Debug and a notification with your message. This ends your control of the session (and its child sessions) for good and passes your breakpoints to the user; you may still read the session. Use it when you have found what the user should see.",
		parameters: {
			type: "object",
			properties: {
				sessionId: { type: "string" },
				message: { type: "string", description: `What the user should look at (up to ${MAX_HANDOFF_MESSAGE} characters).` },
			},
			required: ["sessionId", "message"],
			additionalProperties: false,
		},
		loadMode: "discoverable",
		async execute(raw, ctx) {
			const requested = isRecord(raw) && typeof raw.sessionId === "string" ? raw.sessionId : undefined;
			return await guarded(() => (requested !== undefined ? env.coordinator.session(requested)?.type : undefined), async () => {
				const args = new Args(raw);
				const sessionId = args.requiredString("sessionId");
				const message = args.requiredString("message").slice(0, MAX_HANDOFF_MESSAGE);
				admit(env, ctx);
				requireGrant(env, ctx, sessionId);
				return await env.coordinator.mutate(sessionId, ctx.signal, async () => {
					admit(env, ctx);
					const view = requireGrant(env, ctx, sessionId);
					let location: { path: string; line: number } | undefined;
					if (view.state.kind === "stopped" && view.state.threadId !== undefined) location = await topLocation(env, ctx, sessionId, view.state.threadId);
					admit(env, ctx);
					requireGrant(env, ctx, sessionId);
					// Terminal: from here the conversation no longer controls the session or owns its breakpoints.
					env.coordinator.handoff(sessionId);
					const notes: string[] = [];
					try {
						if (location) await env.api.revealLocation(location.path, location.line);
						else notes.push("the stopped frame has no local source file to show");
					} catch (error) {
						notes.push(`revealing the frame failed (${error instanceof Error ? error.message : String(error)})`);
					}
					try {
						await env.api.showRunAndDebug();
					} catch (error) {
						notes.push(`showing Run and Debug failed (${error instanceof Error ? error.message : String(error)})`);
					}
					env.api.notify(message);
					return textResult(`Handed debug session ${sessionId} to the user. You can no longer control it or change your breakpoints; reads are still allowed.${notes.length > 0 ? ` Note: ${notes.join("; ")}.` : ""}`, { action: "handoff", sessionId });
				});
			});
		},
	};
}

async function topLocation(env: DebugToolEnv, ctx: HostToolContext, sessionId: string, threadId: number): Promise<{ path: string; line: number } | undefined> {
	try {
		const reader = env.coordinator.reader(sessionId, ctx.signal, { requireStopped: true });
		const body = await reader.request("stackTrace", { threadId, startFrame: 0, levels: 1 });
		const frame = isRecord(body) && Array.isArray(body.stackFrames) ? body.stackFrames.find(isRecord) : undefined;
		const source = frame && isRecord(frame.source) ? frame.source : undefined;
		if (!frame || !source || typeof source.path !== "string" || (typeof source.sourceReference === "number" && source.sourceReference > 0) || typeof frame.line !== "number") return undefined;
		return { path: source.path, line: frame.line };
	} catch {
		return undefined;
	}
}

/** The seven `vscode_debug_*` tools; the set is the same whether or not the user enabled them, the provider decides. */
export function createDebugTools(env: DebugToolEnv): readonly HostToolDefinition[] {
	return [configsTool(env), breakpointTool(env), startTool(env), waitTool(env), inspectTool(env), controlTool(env), handoffTool(env)];
}
