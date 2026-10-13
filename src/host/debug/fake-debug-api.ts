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

/**
 * A scriptable stand-in for `vscode.debug`, for the coordinator and tool tests (`node --test`, no editor process).
 * Like the real tracker, a session started after construction gets a tracker from the registered factory; a session
 * added with `addPreexisting` has none. Tests drive adapter messages with `adapterEvent`, `adapterResponse` and
 * `editorRequest`, and script `customRequest` with `onRequest`.
 */

type Listener<T> = (value: T) => void;

class Emitter<T> {
	readonly #listeners = new Set<Listener<T>>();

	event(listener: Listener<T>): DebugDisposable {
		this.#listeners.add(listener);
		return { dispose: () => { this.#listeners.delete(listener); } };
	}

	fire(value: T): void {
		for (const listener of [...this.#listeners]) listener(value);
	}
}

export type RequestHandler = (args: unknown) => unknown | Promise<unknown>;

export class FakeDebugApi implements DebugApi {
	activeSession: DebugSessionInfo | undefined;
	readonly sessions = new Map<string, DebugSessionInfo>();
	readonly trackers = new Map<string, SessionTracker>();
	readonly requests: { sessionId: string; command: string; args: unknown }[] = [];
	readonly controls: { command: ControlCommand; sessionId: string; threadId: number }[] = [];
	readonly stopped: string[] = [];
	readonly started: { folderPath: string | undefined; configuration: Record<string, unknown> }[] = [];
	readonly revealed: { path: string; line: number }[] = [];
	readonly notifications: string[] = [];
	runAndDebugShown = 0;
	folders: WorkspaceFolderInfo[] = [{ name: "app", path: "C:\\work\\app" }];
	launch = new Map<string, LaunchConfigurations>([["C:\\work\\app", { configurations: [{ name: "Run app", type: "node", request: "launch", program: "${workspaceFolder}\\main.js" }], compounds: ["Both"] }]]);
	files = new Set<string>(["C:\\work\\app\\main.js"]);
	capabilities: Record<string, unknown> = { supportsConditionalBreakpoints: true, supportsHitConditionalBreakpoints: true, supportsLogPoints: true };
	/** `startDebugging` behaviour: what the call does and returns; the default starts one session carrying the marker. */
	startBehavior: (folderPath: string | undefined, configuration: Record<string, unknown>) => Promise<boolean> = async (_folderPath, configuration) => {
		this.startSession({ id: `s${this.#nextSession++}`, type: String(configuration.type), name: String(configuration.name), configuration });
		return true;
	};
	/** What `dispatchControl` does; the default mimics VS Code: the adapter sees the request and answers it. */
	controlBehavior: (command: ControlCommand, sessionId: string, threadId: number) => Promise<void> = async (command, sessionId, threadId) => {
		const seq = this.#nextSeq++;
		this.editorRequest(sessionId, { type: "request", seq, command, arguments: { threadId } });
		this.adapterResponse(sessionId, { type: "response", seq: this.#nextSeq++, request_seq: seq, command, success: true });
	};
	stopBehavior: (sessionId: string) => Promise<void> = async sessionId => {
		this.endSession(sessionId);
	};
	#nextSession = 1;
	#nextSeq = 100;
	#nextBreakpoint = 1;
	readonly #handlers = new Map<string, RequestHandler>();
	#breakpoints: BreakpointInfo[] = [];
	readonly #protocol = new Map<string, ProtocolBreakpoint>();
	readonly #factories: ((session: DebugSessionInfo) => SessionTracker)[] = [];
	readonly #started = new Emitter<DebugSessionInfo>();
	readonly #terminated = new Emitter<DebugSessionInfo>();
	readonly #active = new Emitter<DebugSessionInfo | undefined>();
	readonly #breakpointChanges = new Emitter<BreakpointChange>();

	constructor() {
		this.onRequest("initialize", () => this.capabilities);
		this.onRequest("threads", () => ({ threads: [{ id: 1, name: "main" }, { id: 2, name: "worker" }] }));
		this.onRequest("stackTrace", () => ({ stackFrames: [{ id: 1000, name: "main", source: { path: "C:\\work\\app\\main.js" }, line: 3, column: 1 }, { id: 1001, name: "lib", source: { name: "gen", sourceReference: 7 }, line: 1, column: 1 }], totalFrames: 2 }));
		this.onRequest("scopes", () => ({ scopes: [{ name: "Locals", variablesReference: 11, expensive: false }] }));
		this.onRequest("variables", () => ({ variables: [{ name: "x", value: "1", type: "number", variablesReference: 0 }] }));
		this.onRequest("evaluate", args => ({ result: `evaluated ${isRecord(args) ? String(args.expression) : ""}`, type: "string", variablesReference: 0 }));
	}

	/** Scripts the answer to one DAP request command (a rejection becomes the adapter's error). */
	onRequest(command: string, handler: RequestHandler): void {
		this.#handlers.set(command, handler);
	}

	get activeSessionInfo(): DebugSessionInfo | undefined {
		return this.activeSession;
	}

	// ---- scripting ----

	/** A session that starts now: the factory runs first, as in VS Code. */
	startSession(info: Partial<DebugSessionInfo> & { id: string }): DebugSessionInfo {
		const session: DebugSessionInfo = { type: "node", name: info.id, configuration: {}, folderPath: "C:\\work\\app", ...info };
		this.sessions.set(session.id, session);
		for (const factory of this.#factories) this.trackers.set(session.id, factory(session));
		this.activeSession = session;
		this.#started.fire(session);
		this.#active.fire(session);
		// The adapter answers `initialize` before anything else.
		this.adapterResponse(session.id, { type: "response", seq: this.#nextSeq++, request_seq: 1, command: "initialize", success: true, body: this.capabilities });
		return session;
	}

	/** A session that existed before the coordinator was created: no tracker, visible only as the active session. */
	addPreexisting(info: Partial<DebugSessionInfo> & { id: string }): DebugSessionInfo {
		const session: DebugSessionInfo = { type: "node", name: info.id, configuration: {}, folderPath: "C:\\work\\app", ...info };
		this.sessions.set(session.id, session);
		this.activeSession = session;
		return session;
	}

	/** The user focuses a session in the UI. */
	setActive(sessionId: string): void {
		this.activeSession = this.sessions.get(sessionId);
		this.#active.fire(this.activeSession);
	}

	endSession(sessionId: string): void {
		const session = this.sessions.get(sessionId);
		if (!session) return;
		this.sessions.delete(sessionId);
		this.trackers.delete(sessionId);
		if (this.activeSession?.id === sessionId) this.activeSession = undefined;
		this.#terminated.fire(session);
	}

	adapterEvent(sessionId: string, event: string, body?: unknown): void {
		this.trackers.get(sessionId)?.message?.({ type: "event", seq: this.#nextSeq++, event, body });
	}

	adapterResponse(sessionId: string, message: DapMessage): void {
		this.trackers.get(sessionId)?.message?.(message);
	}

	editorRequest(sessionId: string, message: DapMessage): void {
		this.trackers.get(sessionId)?.request?.(message);
	}

	stop(sessionId: string, reason = "breakpoint", threadId = 1): void {
		this.adapterEvent(sessionId, "stopped", { reason, threadId });
	}

	setProtocolBreakpoint(sessionId: string, breakpointId: string, report: ProtocolBreakpoint): void {
		this.#protocol.set(`${sessionId}:${breakpointId}`, report);
	}

	addUserBreakpoint(path: string, line: number): string {
		const id = `bp${this.#nextBreakpoint++}`;
		const info: BreakpointInfo = { id, kind: "source", path, line, enabled: true };
		this.#breakpoints = [...this.#breakpoints, info];
		this.#breakpointChanges.fire({ added: [info], removed: [], changed: [] });
		return id;
	}

	// ---- DebugApi ----

	onDidStartSession(listener: (session: DebugSessionInfo) => void): DebugDisposable {
		return this.#started.event(listener);
	}

	onDidTerminateSession(listener: (session: DebugSessionInfo) => void): DebugDisposable {
		return this.#terminated.event(listener);
	}

	onDidChangeActiveSession(listener: (session: DebugSessionInfo | undefined) => void): DebugDisposable {
		return this.#active.event(listener);
	}

	registerTrackerFactory(factory: (session: DebugSessionInfo) => SessionTracker): DebugDisposable {
		this.#factories.push(factory);
		return { dispose: () => { this.#factories.splice(this.#factories.indexOf(factory), 1); } };
	}

	async customRequest(sessionId: string, command: string, args?: unknown): Promise<unknown> {
		this.requests.push({ sessionId, command, args });
		const handler = this.#handlers.get(command);
		if (!handler) throw new Error(`Unrecognized request: ${command}`);
		return await handler(args);
	}

	startDebugging(folderPath: string | undefined, configuration: Record<string, unknown>): Promise<boolean> {
		this.started.push({ folderPath, configuration });
		return this.startBehavior(folderPath, configuration);
	}

	async stopDebugging(sessionId: string): Promise<void> {
		this.stopped.push(sessionId);
		await this.stopBehavior(sessionId);
	}

	async dispatchControl(command: ControlCommand, sessionId: string, threadId: number): Promise<void> {
		this.controls.push({ command, sessionId, threadId });
		await this.controlBehavior(command, sessionId, threadId);
	}

	breakpoints(): readonly BreakpointInfo[] {
		return this.#breakpoints;
	}

	addSourceBreakpoint(spec: NewSourceBreakpoint): string {
		const id = `bp${this.#nextBreakpoint++}`;
		const info: BreakpointInfo = { id, kind: "source", path: spec.path, line: spec.line, enabled: true, ...(spec.condition ? { condition: spec.condition } : {}), ...(spec.hitCondition ? { hitCondition: spec.hitCondition } : {}), ...(spec.logMessage ? { logMessage: spec.logMessage } : {}) };
		this.#breakpoints = [...this.#breakpoints, info];
		this.#breakpointChanges.fire({ added: [info], removed: [], changed: [] });
		return id;
	}

	removeBreakpoints(ids: readonly string[]): void {
		const removed = this.#breakpoints.filter(breakpoint => ids.includes(breakpoint.id));
		this.#breakpoints = this.#breakpoints.filter(breakpoint => !ids.includes(breakpoint.id));
		this.#breakpointChanges.fire({ added: [], removed, changed: [] });
	}

	/** One VS Code change that removes breakpoints and adds new ones (new ids), as an adapter-driven or bulk edit would. */
	replaceBreakpoints(removed: readonly BreakpointInfo[], added: readonly Omit<BreakpointInfo, "id">[]): void {
		const gone = new Set(removed.map(breakpoint => breakpoint.id));
		const created = added.map((spec): BreakpointInfo => ({ ...spec, id: `bp${this.#nextBreakpoint++}` }));
		this.#breakpoints = [...this.#breakpoints.filter(breakpoint => !gone.has(breakpoint.id)), ...created];
		this.#breakpointChanges.fire({ added: created, removed, changed: [] });
	}

	onDidChangeBreakpoints(listener: (change: BreakpointChange) => void): DebugDisposable {
		return this.#breakpointChanges.event(listener);
	}

	async protocolBreakpoint(sessionId: string, breakpointId: string): Promise<ProtocolBreakpoint | undefined> {
		return this.#protocol.get(`${sessionId}:${breakpointId}`);
	}

	workspaceFolders(): readonly WorkspaceFolderInfo[] {
		return this.folders;
	}

	launchConfigurations(folderPath: string): LaunchConfigurations {
		return this.launch.get(folderPath) ?? { configurations: [], compounds: [] };
	}

	isFile(path: string): boolean {
		return this.files.has(path);
	}

	async revealLocation(path: string, line: number): Promise<void> {
		this.revealed.push({ path, line });
	}

	async showRunAndDebug(): Promise<void> {
		this.runAndDebugShown += 1;
	}

	notify(message: string): void {
		this.notifications.push(message);
	}
}
