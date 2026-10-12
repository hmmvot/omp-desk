import fs from "node:fs";
import * as vscode from "vscode";
import { isRecord } from "../../shared/guards.ts";
import type {
	BreakpointChange,
	BreakpointInfo,
	ControlCommand,
	DapMessage,
	DebugApi,
	DebugDisposable,
	DebugSessionInfo,
	LaunchConfigurations,
	NewSourceBreakpoint,
	ProtocolBreakpoint,
	SessionTracker,
	WorkspaceFolderInfo,
} from "./debug-api.ts";

/** VS Code's own execution commands; each takes `(unused, { sessionId, threadId })`, see `dispatchControl`. */
const CONTROL_COMMAND_IDS: Readonly<Record<ControlCommand, string>> = {
	continue: "workbench.action.debug.continue",
	next: "workbench.action.debug.stepOver",
	stepIn: "workbench.action.debug.stepInto",
	stepOut: "workbench.action.debug.stepOut",
	pause: "workbench.action.debug.pause",
};

function infoOf(session: vscode.DebugSession): DebugSessionInfo {
	return {
		id: session.id,
		type: session.type,
		name: session.name,
		...(session.workspaceFolder ? { folderPath: session.workspaceFolder.uri.fsPath } : {}),
		...(session.parentSession ? { parentId: session.parentSession.id } : {}),
		configuration: session.configuration,
	};
}

function breakpointInfoOf(breakpoint: vscode.Breakpoint): BreakpointInfo {
	const common = {
		id: breakpoint.id,
		enabled: breakpoint.enabled,
		...(breakpoint.condition ? { condition: breakpoint.condition } : {}),
		...(breakpoint.hitCondition ? { hitCondition: breakpoint.hitCondition } : {}),
		...(breakpoint.logMessage ? { logMessage: breakpoint.logMessage } : {}),
	};
	if (breakpoint instanceof vscode.SourceBreakpoint) {
		return { ...common, kind: "source", path: breakpoint.location.uri.fsPath, line: breakpoint.location.range.start.line + 1, column: breakpoint.location.range.start.character + 1 };
	}
	if (breakpoint instanceof vscode.FunctionBreakpoint) return { ...common, kind: "function", label: `function ${breakpoint.functionName}` };
	return { ...common, kind: "other" };
}

/**
 * The only module of the debugger tools that imports `vscode`: `vscode.debug`, the launch.json reader and the few
 * window calls behind `DebugApi`. Behaviour that matters (state, generations, grants) lives in the coordinator.
 */
export class VscodeDebugApi implements DebugApi {
	readonly #sessions = new Map<string, vscode.DebugSession>();

	get activeSession(): DebugSessionInfo | undefined {
		const session = vscode.debug.activeDebugSession;
		if (!session) return undefined;
		this.#sessions.set(session.id, session);
		return infoOf(session);
	}

	onDidStartSession(listener: (session: DebugSessionInfo) => void): DebugDisposable {
		return vscode.debug.onDidStartDebugSession(session => {
			this.#sessions.set(session.id, session);
			listener(infoOf(session));
		});
	}

	onDidTerminateSession(listener: (session: DebugSessionInfo) => void): DebugDisposable {
		return vscode.debug.onDidTerminateDebugSession(session => {
			listener(infoOf(session));
			this.#sessions.delete(session.id);
		});
	}

	onDidChangeActiveSession(listener: (session: DebugSessionInfo | undefined) => void): DebugDisposable {
		return vscode.debug.onDidChangeActiveDebugSession(session => {
			if (session) this.#sessions.set(session.id, session);
			listener(session ? infoOf(session) : undefined);
		});
	}

	registerTrackerFactory(factory: (session: DebugSessionInfo) => SessionTracker): DebugDisposable {
		return vscode.debug.registerDebugAdapterTrackerFactory("*", {
			createDebugAdapterTracker: session => {
				this.#sessions.set(session.id, session);
				const tracker = factory(infoOf(session));
				return {
					onWillReceiveMessage: message => tracker.request?.(message as DapMessage),
					onDidSendMessage: message => tracker.message?.(message as DapMessage),
					onError: error => tracker.error?.(error),
					onExit: (code, signal) => tracker.exit?.(code, signal),
				};
			},
		});
	}

	async customRequest(sessionId: string, command: string, args?: unknown): Promise<unknown> {
		const session = this.#sessions.get(sessionId);
		if (!session) throw new Error(`Debug session ${sessionId} is not known to this window.`);
		return await session.customRequest(command, args);
	}

	async startDebugging(folderPath: string | undefined, configuration: Record<string, unknown>): Promise<boolean> {
		const folder = folderPath === undefined ? undefined : vscode.workspace.workspaceFolders?.find(candidate => candidate.uri.fsPath === folderPath);
		return await vscode.debug.startDebugging(folder, configuration as vscode.DebugConfiguration);
	}

	async stopDebugging(sessionId: string): Promise<void> {
		const session = this.#sessions.get(sessionId);
		if (!session) throw new Error(`Debug session ${sessionId} is not known to this window.`);
		await vscode.debug.stopDebugging(session);
	}

	async dispatchControl(command: ControlCommand, sessionId: string, threadId: number): Promise<void> {
		// VS Code resolves the thread from the second argument: `thread:<sessionId>:<adapter thread id>`.
		await vscode.commands.executeCommand(CONTROL_COMMAND_IDS[command], undefined, { sessionId, threadId: `thread:${sessionId}:${threadId}` });
	}

	breakpoints(): readonly BreakpointInfo[] {
		return vscode.debug.breakpoints.map(breakpointInfoOf);
	}

	addSourceBreakpoint(spec: NewSourceBreakpoint): string {
		const location = new vscode.Location(vscode.Uri.file(spec.path), new vscode.Position(spec.line - 1, 0));
		const breakpoint = new vscode.SourceBreakpoint(location, true, spec.condition, spec.hitCondition, spec.logMessage);
		vscode.debug.addBreakpoints([breakpoint]);
		return breakpoint.id;
	}

	removeBreakpoints(ids: readonly string[]): void {
		const present = vscode.debug.breakpoints.filter(breakpoint => ids.includes(breakpoint.id));
		if (present.length > 0) vscode.debug.removeBreakpoints(present);
	}

	onDidChangeBreakpoints(listener: (change: BreakpointChange) => void): DebugDisposable {
		return vscode.debug.onDidChangeBreakpoints(event => listener({
			added: event.added.map(breakpointInfoOf),
			removed: event.removed.map(breakpointInfoOf),
			changed: event.changed.map(breakpointInfoOf),
		}));
	}

	async protocolBreakpoint(sessionId: string, breakpointId: string): Promise<ProtocolBreakpoint | undefined> {
		const session = this.#sessions.get(sessionId);
		const breakpoint = vscode.debug.breakpoints.find(candidate => candidate.id === breakpointId);
		if (!session || !breakpoint) return undefined;
		const report = await session.getDebugProtocolBreakpoint(breakpoint);
		if (!isRecord(report)) return undefined;
		return {
			verified: report.verified === true,
			...(typeof report.message === "string" ? { message: report.message } : {}),
			...(typeof report.line === "number" ? { line: report.line } : {}),
		};
	}

	workspaceFolders(): readonly WorkspaceFolderInfo[] {
		return (vscode.workspace.workspaceFolders ?? []).map(folder => ({ name: folder.name, path: folder.uri.fsPath }));
	}

	launchConfigurations(folderPath: string): LaunchConfigurations {
		const folder = vscode.workspace.workspaceFolders?.find(candidate => candidate.uri.fsPath === folderPath);
		const launch = vscode.workspace.getConfiguration("launch", folder?.uri);
		const configurations = launch.get<unknown[]>("configurations") ?? [];
		const compounds = launch.get<unknown[]>("compounds") ?? [];
		return {
			configurations: configurations.filter(isRecord).filter(entry => typeof entry.name === "string"),
			compounds: compounds.filter(isRecord).map(entry => entry.name).filter((name): name is string => typeof name === "string"),
		};
	}

	isFile(path: string): boolean {
		try {
			return fs.statSync(path).isFile();
		} catch {
			return false;
		}
	}

	async revealLocation(path: string, line: number): Promise<void> {
		const position = new vscode.Position(Math.max(0, line - 1), 0);
		await vscode.window.showTextDocument(vscode.Uri.file(path), { selection: new vscode.Range(position, position), preview: false });
	}

	async showRunAndDebug(): Promise<void> {
		await vscode.commands.executeCommand("workbench.view.debug");
	}

	notify(message: string): void {
		void vscode.window.showInformationMessage(message);
	}
}
