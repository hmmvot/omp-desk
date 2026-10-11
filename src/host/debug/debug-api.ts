/**
 * The narrow, injectable face of `vscode.debug` (plus the few workspace and window calls the debugger tools need).
 * `debug-coordinator.ts` and `debug-tools.ts` depend only on this module, so every state-machine rule is tested
 * against `fake-debug-api.ts` without an editor process; `vscode-debug-api.ts` is the one file that imports `vscode`.
 *
 * Design: docs/designs/2026-10-10-agent-debugger-tools.md sections 2 and 3.
 */

export interface DebugDisposable {
	dispose(): void;
}

/** A Debug Adapter Protocol message as a tracker sees it. Only the fields the coordinator reads are named. */
export interface DapMessage {
	readonly type: string;
	readonly seq?: number;
	readonly command?: string;
	readonly event?: string;
	readonly request_seq?: number;
	readonly success?: boolean;
	readonly message?: string;
	readonly arguments?: unknown;
	readonly body?: unknown;
}

/** What the extension host knows about one debug session. */
export interface DebugSessionInfo {
	readonly id: string;
	readonly type: string;
	readonly name: string;
	/** `fsPath` of the session's workspace folder, when it has one. */
	readonly folderPath?: string;
	readonly parentId?: string;
	readonly configuration: Readonly<Record<string, unknown>>;
}

/** Callbacks of one `DebugAdapterTracker`; every one is optional, like the VS Code interface. */
export interface SessionTracker {
	/** The editor sends a request to the adapter (the user's actions and Desk's own controls both pass here). */
	request?(message: DapMessage): void;
	/** The adapter sends a response or an event to the editor. */
	message?(message: DapMessage): void;
	error?(error: Error): void;
	exit?(code: number | undefined, signal: string | undefined): void;
}

/** One breakpoint of VS Code's window-wide list. `line` is one-based. */
export interface BreakpointInfo {
	readonly id: string;
	readonly kind: "source" | "function" | "other";
	readonly path?: string;
	readonly line?: number;
	readonly column?: number;
	readonly label?: string;
	readonly enabled: boolean;
	readonly condition?: string;
	readonly hitCondition?: string;
	readonly logMessage?: string;
}

export interface NewSourceBreakpoint {
	readonly path: string;
	readonly line: number;
	readonly condition?: string;
	readonly hitCondition?: string;
	readonly logMessage?: string;
}

export interface BreakpointChange {
	readonly added: readonly BreakpointInfo[];
	readonly removed: readonly BreakpointInfo[];
	readonly changed: readonly BreakpointInfo[];
}

/** What an adapter reported for one breakpoint in one session (`getDebugProtocolBreakpoint`). */
export interface ProtocolBreakpoint {
	readonly verified: boolean;
	readonly message?: string;
	readonly line?: number;
}

export interface LaunchConfigurations {
	/** Each entry as written in `launch.json` (`name`, `type`, `request`, ...). */
	readonly configurations: readonly Readonly<Record<string, unknown>>[];
	readonly compounds: readonly string[];
}

export interface WorkspaceFolderInfo {
	readonly name: string;
	readonly path: string;
}

export type ControlCommand = "continue" | "next" | "stepIn" | "stepOut" | "pause";

export interface DebugApi {
	readonly activeSession: DebugSessionInfo | undefined;
	onDidStartSession(listener: (session: DebugSessionInfo) => void): DebugDisposable;
	onDidTerminateSession(listener: (session: DebugSessionInfo) => void): DebugDisposable;
	onDidChangeActiveSession(listener: (session: DebugSessionInfo | undefined) => void): DebugDisposable;
	/** Registers a tracker factory for every debug type (`*`). The factory runs before a session starts. */
	registerTrackerFactory(factory: (session: DebugSessionInfo) => SessionTracker): DebugDisposable;

	/** Sends one DAP request through the session and resolves with the response body; rejects with the adapter's message. */
	customRequest(sessionId: string, command: string, args?: unknown): Promise<unknown>;
	/** VS Code's `debug.startDebugging`; `false` means VS Code refused. */
	startDebugging(folderPath: string | undefined, configuration: Record<string, unknown>): Promise<boolean>;
	stopDebugging(sessionId: string): Promise<void>;
	/**
	 * Runs one of VS Code's own execution commands (`workbench.action.debug.continue` and the others) with an
	 * explicit `{ sessionId, threadId }` context. `threadId` is the adapter's thread id.
	 */
	dispatchControl(command: ControlCommand, sessionId: string, threadId: number): Promise<void>;

	breakpoints(): readonly BreakpointInfo[];
	/** Adds a source breakpoint and returns the id VS Code gave it. */
	addSourceBreakpoint(spec: NewSourceBreakpoint): string;
	removeBreakpoints(ids: readonly string[]): void;
	onDidChangeBreakpoints(listener: (change: BreakpointChange) => void): DebugDisposable;
	protocolBreakpoint(sessionId: string, breakpointId: string): Promise<ProtocolBreakpoint | undefined>;

	workspaceFolders(): readonly WorkspaceFolderInfo[];
	launchConfigurations(folderPath: string): LaunchConfigurations;
	isFile(path: string): boolean;

	/** Opens the file at the line in an editor and reveals it. */
	revealLocation(path: string, line: number): Promise<void>;
	showRunAndDebug(): Promise<void>;
	notify(message: string): void;
}
