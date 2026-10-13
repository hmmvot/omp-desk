import { isRecord } from "../../shared/guards.ts";
import type { BreakpointInfo, BreakpointOwnershipStore, DapMessage, DebugApi, DebugDisposable, DebugSessionInfo, SessionTracker } from "./debug-api.ts";

/**
 * The window-lifetime debug coordinator (design section 2): a registry of VS Code debug sessions fed by trackers,
 * a per-session state machine with generations, bounded adapter requests, per-session mutation queues, control
 * grants, breakpoint ownership and the launch coordinator. It knows nothing about tools, settings or Unity.
 */

export interface DebugLimits {
	/** Every adapter request (including inspection) gives up after this long. */
	requestTimeoutMs: number;
	/** A dispatched continue, step or pause that sees no resolution leaves the session `unknown` after this long. */
	transitionTimeoutMs: number;
	/** `debug.startDebugging` may take this long (pre-launch tasks, builds) before the outcome is reported unknown. */
	launchTimeoutMs: number;
	/** After `startDebugging` answered `true`, how long to wait for a session that carries the attempt's marker. */
	markerGraceMs: number;
	maxSessions: number;
	maxWaitersPerSession: number;
}

export const DEFAULT_LIMITS: DebugLimits = {
	requestTimeoutMs: 10_000,
	transitionTimeoutMs: 10_000,
	launchTimeoutMs: 120_000,
	markerGraceMs: 5_000,
	maxSessions: 64,
	maxWaitersPerSession: 8,
};

/** The property added to the configuration of every Desk start; its value is unique per attempt. */
export const LAUNCH_MARKER_KEY = "__ompDeskLaunchMarker";

export type SessionState =
	| { readonly kind: "running" }
	| { readonly kind: "transitioning"; readonly action: string; readonly threadId?: number }
	| { readonly kind: "stopped"; readonly reason: string; readonly threadId: number | undefined; readonly description?: string }
	| { readonly kind: "unknown" }
	| { readonly kind: "terminated" };

export type SessionOrigin = "user" | "desk";

/** Why the session is not controllable by a conversation, or which one holds the grant. */
export interface SessionView {
	readonly id: string;
	readonly name: string;
	readonly type: string;
	readonly folderPath?: string;
	readonly parentId?: string;
	readonly tracked: boolean;
	readonly origin: SessionOrigin;
	/** The conversation (OMP session file id) that started the session through `vscode_debug_start`. */
	readonly startedBy?: string;
	/** The conversation that may mutate the session now; undefined after handoff or for user sessions. */
	readonly controlOwner?: string;
	readonly handedOff: boolean;
	readonly state: SessionState;
	readonly generation: number;
	/** The last transport error the adapter connection reported (for example `read error` or `write EPIPE`); it often explains why a session died. */
	readonly adapterError?: string;
}

interface Transition {
	readonly action: string;
	readonly threadId?: number;
	readonly previous: SessionState;
	boundSeq?: number;
	acknowledged: boolean;
	timer: NodeJS.Timeout | undefined;
}

interface SessionRecord {
	readonly id: string;
	readonly name: string;
	readonly type: string;
	readonly folderPath?: string;
	readonly parentId?: string;
	readonly tracked: boolean;
	origin: SessionOrigin;
	startedBy?: string;
	controlOwner?: string;
	handedOff: boolean;
	state: SessionState;
	generation: number;
	adapterError?: string;
	transition?: Transition;
	capabilities: Record<string, unknown>;
	/** Adapter breakpoint reports from tracker `breakpoint` events, by `path:line`. */
	trackerBreakpoints: Map<string, { verified: boolean; message?: string }>;
	waiters: number;
}

export class DebugRequestTimeout extends Error {
	constructor(command: string, timeoutMs: number) {
		super(`The debug adapter did not answer "${command}" within ${Math.round(timeoutMs / 1000)} s; the request may still take effect.`);
		this.name = "DebugRequestTimeout";
	}
}

export class DebugRequestCancelled extends Error {
	constructor(command: string) {
		super(`Cancelled while "${command}" was in flight; its effect on the debuggee is unknown.`);
		this.name = "DebugRequestCancelled";
	}
}

export class DebugRequestFailed extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DebugRequestFailed";
	}
}

/** A read finished after the program ran (the session's generation moved), so its reply is not trustworthy. */
export class StaleGenerationError extends Error {
	constructor() {
		super("The program ran since this was requested; read the stack again.");
		this.name = "StaleGenerationError";
	}
}

/** The session ended or is not known to this window. */
export class SessionGoneError extends Error {
	constructor(sessionId: string, detail = "is not a debug session of this window") {
		super(`Debug session ${sessionId} ${detail}.`);
		this.name = "SessionGoneError";
	}
}

export class OperationCancelledError extends Error {
	constructor() {
		super("The call was cancelled.");
		this.name = "OperationCancelledError";
	}
}

const EXECUTION_COMMANDS = new Set(["continue", "next", "stepIn", "stepOut", "stepBack", "reverseContinue", "pause"]);

export type ExecutionAction = "continue" | "next" | "stepIn" | "stepOut" | "pause";

/** An adapter's error that means it does not implement the request. */
export function isUnsupportedMessage(message: string): boolean {
	return /unrecogni[sz]ed request|unknown request|not supported|unsupported|not implemented|no handler|cannot handle|is not understood/i.test(message);
}

export type LaunchOutcome =
	| { readonly kind: "started"; readonly sessionIds: readonly string[] }
	| { readonly kind: "refused"; readonly detail: string }
	| { readonly kind: "error"; readonly detail: string }
	| { readonly kind: "not-identified" }
	| { readonly kind: "unknown"; readonly detail: string };

interface LaunchAttempt {
	readonly marker: string;
	readonly conversationId: string;
	open: boolean;
	readonly sessionIds: string[];
	notify?: () => void;
}

export interface LaunchRequest {
	readonly conversationId: string;
	readonly folderPath?: string;
	readonly configuration: Readonly<Record<string, unknown>>;
	readonly signal: AbortSignal;
}

export interface BreakpointOwnership {
	owner(id: string): string | undefined;
}

/** The saved owner records kept across extension-host restarts: bounded, oldest dropped first. */
const MAX_SAVED_OWNERS = 500;

/** Reads what a store saved; anything that is not a `{ breakpointId: conversationId }` record of strings is ignored. */
function restoredOwners(saved: unknown): [string, string][] {
	if (!isRecord(saved)) return [];
	const owners: [string, string][] = [];
	for (const [id, conversation] of Object.entries(saved)) {
		if (id.length > 0 && typeof conversation === "string" && conversation.length > 0) owners.push([id, conversation]);
	}
	return owners.slice(-MAX_SAVED_OWNERS);
}

type Listener = () => void;

export class DebugCoordinator implements BreakpointOwnership {
	readonly limits: DebugLimits;
	readonly #api: DebugApi;
	readonly #log: (line: string) => void;
	readonly #records = new Map<string, SessionRecord>();
	readonly #disposables: DebugDisposable[] = [];
	readonly #listeners = new Set<Listener>();
	readonly #queues = new Map<string, Promise<void>>();
	readonly #attempts = new Map<string, LaunchAttempt>();
	readonly #breakpointOwners = new Map<string, string>();
	readonly #ownershipStore: BreakpointOwnershipStore | undefined;
	#launchChain: Promise<void> = Promise.resolve();
	#disposed = false;

	constructor(api: DebugApi, options: { limits?: Partial<DebugLimits>; log?: (line: string) => void; ownershipStore?: BreakpointOwnershipStore } = {}) {
		this.#api = api;
		this.limits = { ...DEFAULT_LIMITS, ...options.limits };
		this.#log = options.log ?? (() => {});
		this.#ownershipStore = options.ownershipStore;
		// VS Code keeps a breakpoint's id across a window reload (it stores the id with the breakpoint), but this window's
		// memory does not survive an extension-host restart: the saved owners are what keeps `clear` and `remove` working.
		if (this.#ownershipStore) {
			for (const [id, conversation] of restoredOwners(this.#ownershipStore.load())) this.#breakpointOwners.set(id, conversation);
			if (this.#breakpointOwners.size > 0) this.#log(`debug breakpoints: restored ${this.#breakpointOwners.size} saved owner record(s)`);
		}
		this.#disposables.push(
			api.registerTrackerFactory(session => this.#trackerFor(session)),
			api.onDidStartSession(session => this.#ensureRecord(session, false)),
			api.onDidChangeActiveSession(session => { if (session) this.#ensureRecord(session, false); }),
			api.onDidTerminateSession(session => this.#terminated(session.id)),
			api.onDidChangeBreakpoints(change => this.#breakpointsChanged(change.removed)),
		);
		// Sessions that exist before activation have no tracker: they are listed, never driven.
		if (api.activeSession) this.#ensureRecord(api.activeSession, false);
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		for (const d of this.#disposables.splice(0)) d.dispose();
		for (const record of this.#records.values()) this.#clearTransition(record);
		this.#listeners.clear();
	}

	/** Fires after any registry or state change; waiters re-evaluate their own condition. */
	onDidChange(listener: Listener): DebugDisposable {
		this.#listeners.add(listener);
		return { dispose: () => { this.#listeners.delete(listener); } };
	}

	#changed(): void {
		for (const listener of [...this.#listeners]) {
			try { listener(); } catch (error) { this.#log(`debug coordinator listener failed: ${String(error)}`); }
		}
	}

	// ---- registry ----

	sessions(): readonly SessionView[] {
		return [...this.#records.values()].map(viewOf);
	}

	session(id: string): SessionView | undefined {
		const record = this.#records.get(id);
		return record ? viewOf(record) : undefined;
	}

	capabilities(id: string): Readonly<Record<string, unknown>> {
		return this.#records.get(id)?.capabilities ?? {};
	}

	/** Adapter breakpoint reports from tracker events for one session, by `path:line`. */
	trackerBreakpoint(id: string, path: string, line: number): { verified: boolean; message?: string } | undefined {
		return this.#records.get(id)?.trackerBreakpoints.get(`${path.toLowerCase()}:${line}`);
	}

	#trackerFor(session: DebugSessionInfo): SessionTracker {
		const record = this.#ensureRecord(session, true);
		return {
			request: message => this.#onRequest(record, message),
			message: message => this.#onAdapterMessage(record, message),
			error: error => this.#onTrackerError(record, error),
		};
	}

	#ensureRecord(session: DebugSessionInfo, tracked: boolean): SessionRecord {
		const existing = this.#records.get(session.id);
		if (existing) return existing;
		this.#prune();
		const marker = typeof session.configuration[LAUNCH_MARKER_KEY] === "string" ? session.configuration[LAUNCH_MARKER_KEY] as string : undefined;
		const attempt = marker !== undefined ? this.#attempts.get(marker) : undefined;
		const parent = session.parentId !== undefined ? this.#records.get(session.parentId) : undefined;
		let origin: SessionOrigin = "user";
		let startedBy: string | undefined;
		let controlOwner: string | undefined;
		if (tracked && attempt?.open) {
			origin = "desk";
			startedBy = attempt.conversationId;
			controlOwner = attempt.conversationId;
			attempt.sessionIds.push(session.id);
			attempt.notify?.();
		} else if (tracked && parent && parent.tracked && parent.origin === "desk") {
			// A child of a Desk-started session (a debug target a launcher session spawned) belongs to the same conversation.
			origin = "desk";
			startedBy = parent.startedBy;
			controlOwner = parent.controlOwner;
		}
		const record: SessionRecord = {
			id: session.id,
			name: session.name,
			type: session.type,
			folderPath: session.folderPath,
			parentId: session.parentId,
			tracked,
			origin,
			startedBy,
			controlOwner,
			handedOff: false,
			// A tracked session has run since its first event; an untracked one is unknowable.
			state: tracked ? { kind: "running" } : { kind: "unknown" },
			generation: 0,
			capabilities: {},
			trackerBreakpoints: new Map(),
			waiters: 0,
		};
		this.#records.set(record.id, record);
		this.#changed();
		return record;
	}

	/** Keeps the registry bounded: only terminated sessions are dropped, oldest first. */
	#prune(): void {
		if (this.#records.size < this.limits.maxSessions) return;
		for (const [id, record] of this.#records) {
			if (record.state.kind === "terminated") {
				this.#records.delete(id);
				if (this.#records.size < this.limits.maxSessions) return;
			}
		}
	}

	// ---- tracker messages and state transitions ----

	#setState(record: SessionRecord, state: SessionState): void {
		record.state = state;
		record.generation += 1;
		this.#changed();
	}

	#clearTransition(record: SessionRecord): void {
		if (record.transition?.timer !== undefined) clearTimeout(record.transition.timer);
		record.transition = undefined;
	}

	#beginTransition(record: SessionRecord, action: string, threadId: number | undefined, boundSeq: number | undefined): void {
		// A transition on top of an unresolved one remembers the state from before the whole chain.
		const previous = record.transition?.previous ?? record.state;
		this.#clearTransition(record);
		const transition: Transition = { action, threadId, previous, boundSeq, acknowledged: false, timer: undefined };
		transition.timer = setTimeout(() => this.#transitionTimedOut(record, transition), this.limits.transitionTimeoutMs);
		record.transition = transition;
		this.#setState(record, { kind: "transitioning", action, ...(threadId !== undefined ? { threadId } : {}) });
	}

	#transitionTimedOut(record: SessionRecord, transition: Transition): void {
		if (record.transition !== transition) return;
		record.transition = undefined;
		this.#log(`debug session ${record.id}: ${transition.action} not resolved in ${this.limits.transitionTimeoutMs} ms; state unknown`);
		this.#setState(record, { kind: "unknown" });
	}

	#onRequest(record: SessionRecord, message: DapMessage): void {
		if (message.type !== "request" || message.command === undefined || !EXECUTION_COMMANDS.has(message.command)) return;
		if (record.state.kind === "terminated") return;
		const threadId = isRecord(message.arguments) && typeof message.arguments.threadId === "number" ? message.arguments.threadId : undefined;
		const open = record.transition;
		if (open && open.boundSeq === undefined && open.action === message.command) {
			// The request of the control Desk dispatched: bind it so its response resolves the transition.
			open.boundSeq = message.seq;
			return;
		}
		// An action of the user (or anything not dispatched by Desk), observed as far as the adapter connection shows it.
		this.#beginTransition(record, message.command, threadId, message.seq);
	}

	#onAdapterMessage(record: SessionRecord, message: DapMessage): void {
		if (message.type === "event") {
			this.#onEvent(record, message);
			return;
		}
		if (message.type !== "response") return;
		if (message.command === "initialize" && message.success === true && isRecord(message.body)) record.capabilities = { ...message.body };
		const transition = record.transition;
		if (!transition || transition.boundSeq === undefined || transition.boundSeq !== message.request_seq) return;
		if (message.success !== true) {
			// A failed response restores the state from before the transition.
			this.#clearTransition(record);
			this.#setState(record, transition.previous);
			return;
		}
		if (transition.action === "pause") {
			// A pause response is only an acknowledgement: the transition ends on `stopped`, `terminated`, a failure or the timeout.
			transition.acknowledged = true;
			return;
		}
		// DAP does not require a `continued` event after continue or a step: a successful response means running.
		this.#clearTransition(record);
		this.#setState(record, { kind: "running" });
	}

	#onEvent(record: SessionRecord, message: DapMessage): void {
		const body = isRecord(message.body) ? message.body : {};
		switch (message.event) {
			case "stopped": {
				this.#clearTransition(record);
				const threadId = typeof body.threadId === "number" ? body.threadId : undefined;
				this.#setState(record, {
					kind: "stopped",
					reason: typeof body.reason === "string" ? body.reason : "unknown",
					threadId,
					...(typeof body.description === "string" ? { description: body.description } : {}),
				});
				return;
			}
			case "continued":
				this.#clearTransition(record);
				this.#setState(record, { kind: "running" });
				return;
			case "terminated":
				this.#terminated(record.id);
				return;
			case "breakpoint": {
				const breakpoint = isRecord(body.breakpoint) ? body.breakpoint : undefined;
				const source = breakpoint && isRecord(breakpoint.source) ? breakpoint.source : undefined;
				if (breakpoint && source && typeof source.path === "string" && typeof breakpoint.line === "number") {
					record.trackerBreakpoints.set(`${source.path.toLowerCase()}:${breakpoint.line}`, {
						verified: breakpoint.verified === true,
						...(typeof breakpoint.message === "string" ? { message: breakpoint.message } : {}),
					});
					this.#changed();
				}
				return;
			}
			default:
				return;
		}
	}

	#onTrackerError(record: SessionRecord, error: Error): void {
		// Kept even when the session already ended: the error usually arrives just before or after the end.
		record.adapterError = error.message;
		if (record.state.kind === "terminated") return;
		this.#log(`debug session ${record.id}: adapter error: ${error.message}`);
		this.#clearTransition(record);
		this.#setState(record, { kind: "unknown" });
	}

	#terminated(id: string): void {
		const record = this.#records.get(id);
		if (!record || record.state.kind === "terminated") return;
		this.#clearTransition(record);
		this.#setState(record, { kind: "terminated" });
	}

	// ---- grants ----

	/** A conversation may mutate a tracked session only while it holds the grant `vscode_debug_start` gave it. */
	canControl(id: string, conversationId: string): boolean {
		const record = this.#records.get(id);
		return !!record && record.tracked && record.state.kind !== "terminated" && record.controlOwner !== undefined && record.controlOwner === conversationId;
	}

	/**
	 * Terminally revokes the grant of the session's whole tree (the launcher session and every target it spawned) and
	 * passes the conversation's breakpoints to the user. Reads stay allowed. Returns the ids of the breakpoints that
	 * passed to the user, so the tool can name them.
	 */
	handoff(id: string): string[] {
		const record = this.#records.get(id);
		if (!record) return [];
		const conversation = record.controlOwner;
		const tree = new Set<string>([id]);
		for (let grew = true; grew;) {
			grew = false;
			for (const other of this.#records.values()) {
				const connected = (other.parentId !== undefined && tree.has(other.parentId)) || [...tree].some(member => this.#records.get(member)?.parentId === other.id);
				if (connected && !tree.has(other.id)) { tree.add(other.id); grew = true; }
			}
		}
		for (const member of tree) {
			const target = this.#records.get(member);
			if (!target) continue;
			target.controlOwner = undefined;
			target.handedOff = true;
		}
		const passed: string[] = [];
		if (conversation !== undefined) {
			for (const [breakpointId, owner] of this.#breakpointOwners) {
				if (owner !== conversation) continue;
				this.#breakpointOwners.delete(breakpointId);
				passed.push(breakpointId);
			}
			if (passed.length > 0) this.#persistOwners();
		}
		this.#changed();
		return passed;
	}

	// ---- breakpoint ownership ----

	owner(breakpointId: string): string | undefined {
		return this.#breakpointOwners.get(breakpointId);
	}

	claimBreakpoint(breakpointId: string, conversationId: string): void {
		// Tool calls run long after activation, so VS Code's breakpoint list is complete here: records of breakpoints
		// that vanished while this window was not watching (deleted while the host was down) are dropped now.
		const present = new Set(this.#api.breakpoints().map(breakpoint => breakpoint.id));
		for (const knownId of [...this.#breakpointOwners.keys()]) if (!present.has(knownId)) this.#breakpointOwners.delete(knownId);
		this.#breakpointOwners.set(breakpointId, conversationId);
		while (this.#breakpointOwners.size > MAX_SAVED_OWNERS) {
			const oldest = this.#breakpointOwners.keys().next();
			if (oldest.done) break;
			this.#breakpointOwners.delete(oldest.value);
		}
		this.#persistOwners();
	}

	releaseBreakpoint(breakpointId: string): void {
		if (this.#breakpointOwners.delete(breakpointId)) this.#persistOwners();
	}

	ownedBreakpoints(conversationId: string): string[] {
		return [...this.#breakpointOwners].filter(([, owner]) => owner === conversationId).map(([id]) => id);
	}

	/**
	 * Ownership is keyed by the id VS Code gave the breakpoint, and only an id that was claimed is ever owned: a
	 * breakpoint the user deletes and creates again at the same place is a new breakpoint with a new id, so it is the
	 * user's. No location or content match transfers ownership.
	 */
	#breakpointsChanged(removed: readonly BreakpointInfo[]): void {
		let any = false;
		for (const breakpoint of removed) any = this.#breakpointOwners.delete(breakpoint.id) || any;
		if (any) this.#persistOwners();
	}

	#persistOwners(): void {
		if (!this.#ownershipStore) return;
		try {
			this.#ownershipStore.save(Object.fromEntries(this.#breakpointOwners));
		} catch (error) {
			this.#log(`debug breakpoints: could not save owner records: ${String(error)}`);
		}
	}

	// ---- serialization ----

	/**
	 * Runs `action` after every earlier action on the same key. A key is a debug session id, or a window-level key for
	 * breakpoint changes. An action whose call was cancelled while queued never runs.
	 */
	async mutate<T>(key: string, signal: AbortSignal, action: () => Promise<T>): Promise<T> {
		const previous = this.#queues.get(key) ?? Promise.resolve();
		let release!: () => void;
		const turn = new Promise<void>(resolve => { release = resolve; });
		const tail = previous.then(() => turn);
		this.#queues.set(key, tail);
		try {
			await previous;
			if (signal.aborted) throw new OperationCancelledError();
			return await action();
		} finally {
			release();
			void tail.then(() => { if (this.#queues.get(key) === tail) this.#queues.delete(key); });
		}
	}

	// ---- adapter requests ----

	/** One adapter request, bounded by the request timeout and the call's signal. A timeout never undoes a request already sent. */
	async request(id: string, command: string, args: unknown, signal: AbortSignal): Promise<unknown> {
		if (signal.aborted) throw new OperationCancelledError();
		const record = this.#records.get(id);
		if (!record) throw new SessionGoneError(id);
		if (record.state.kind === "terminated") throw new SessionGoneError(id, "has ended");
		const timeoutMs = this.limits.requestTimeoutMs;
		return await new Promise<unknown>((resolve, reject) => {
			let settled = false;
			const done = (fn: () => void): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal.removeEventListener("abort", onAbort);
				fn();
			};
			const timer = setTimeout(() => done(() => reject(new DebugRequestTimeout(command, timeoutMs))), timeoutMs);
			const onAbort = (): void => done(() => reject(new DebugRequestCancelled(command)));
			signal.addEventListener("abort", onAbort, { once: true });
			this.#api.customRequest(id, command, args).then(
				body => done(() => resolve(body)),
				(error: unknown) => done(() => reject(new DebugRequestFailed(error instanceof Error ? error.message : String(error)))),
			);
		});
	}

	/**
	 * A generation-checked read: every reply is verified against the generation captured when the read started,
	 * and a reply from an older generation is rejected, never relabelled.
	 */
	reader(id: string, signal: AbortSignal, options: { requireStopped: boolean }): SessionReader {
		const record = this.#records.get(id);
		if (!record) throw new SessionGoneError(id);
		if (!record.tracked) throw new SessionGoneError(id, "was started before this window's debugger tools were active, so its debugger state is not available in this extension-host lifetime");
		if (record.state.kind === "terminated") throw new SessionGoneError(id, "has ended");
		if (options.requireStopped && record.state.kind !== "stopped") {
			const children = this.#descendantRecords(id).filter(child => child.state.kind !== "terminated");
			const hint = children.length > 0 ? ` This session has child sessions that run the program: ${children.map(child => `${child.id} (${describeState(child.state)})`).join(", ")}; act on a child session.` : "";
			throw new SessionNotStoppedError(id, record.state, hint);
		}
		const generation = record.generation;
		const assertFresh = (): void => {
			if (record.state.kind === "terminated") throw new SessionGoneError(id, "ended while it was being read");
			if (record.generation !== generation) throw new StaleGenerationError();
		};
		return {
			sessionId: id,
			generation,
			assertFresh,
			request: async (command, args) => {
				const body = await this.request(id, command, args, signal);
				assertFresh();
				return body;
			},
		};
	}

	// ---- waiting ----

	/**
	 * Resolves with the first stopped (at a generation above `after`) or terminated state of the session, or `timeout`.
	 * `onTick` runs about every `tickMs` while waiting (progress updates).
	 */
	async waitForStop(id: string, options: { after?: number; timeoutMs: number; signal: AbortSignal; tickMs?: number; onTick?: (elapsedMs: number) => void; recheck?: () => void }): Promise<WaitOutcome> {
		const record = this.#records.get(id);
		if (!record) throw new SessionGoneError(id);
		if (!record.tracked) throw new SessionGoneError(id, "was started before this window's debugger tools were active, so its debugger state is not available in this extension-host lifetime");
		if (record.waiters >= this.limits.maxWaitersPerSession) throw new Error(`Too many concurrent waits on debug session ${id}.`);
		record.waiters += 1;
		const startedAt = Date.now();
		const deadline = startedAt + options.timeoutMs;
		let lastTick = startedAt;
		try {
			for (;;) {
				// A launcher session (js-debug runs the program in a child session) is waited on together with its children.
				const outcome = evaluateWait(record, [record, ...this.#descendantRecords(id)], options.after);
				if (outcome) return outcome;
				if (options.signal.aborted) throw new OperationCancelledError();
				const now = Date.now();
				if (now >= deadline) return { kind: "timeout", state: record.state, generation: record.generation };
				await this.#nextChange(Math.min(deadline - now, options.tickMs ?? deadline - now), options.signal);
				options.recheck?.();
				const after = Date.now();
				if (options.tickMs !== undefined && after - lastTick >= options.tickMs) {
					lastTick = after;
					options.onTick?.(after - startedAt);
				}
			}
		} finally {
			record.waiters -= 1;
		}
	}

	/** Every session below `id` in the parent chain, nearest first. */
	#descendantRecords(id: string): SessionRecord[] {
		const found: SessionRecord[] = [];
		const seen = new Set<string>([id]);
		for (let grew = true; grew;) {
			grew = false;
			for (const other of this.#records.values()) {
				if (other.parentId !== undefined && seen.has(other.parentId) && !seen.has(other.id)) {
					seen.add(other.id);
					found.push(other);
					grew = true;
				}
			}
		}
		return found;
	}

	/** The last adapter error of the session or, failing that, of its descendants. */
	adapterErrorOf(id: string): string | undefined {
		const own = this.#records.get(id)?.adapterError;
		if (own !== undefined) return own;
		return this.#descendantRecords(id).find(child => child.adapterError !== undefined)?.adapterError;
	}

	/** The child sessions of a session, for tools that explain where a launcher's program actually runs. */
	children(id: string): readonly SessionView[] {
		return this.#descendantRecords(id).map(viewOf);
	}

	#nextChange(timeoutMs: number, signal: AbortSignal): Promise<void> {
		return new Promise<void>(resolve => {
			let done = false;
			const finish = (): void => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				subscription.dispose();
				signal.removeEventListener("abort", finish);
				resolve();
			};
			const timer = setTimeout(finish, timeoutMs);
			const subscription = this.onDidChange(finish);
			signal.addEventListener("abort", finish, { once: true });
		});
	}

	// ---- controls ----

	/**
	 * Marks the session `transitioning` for a control Desk is about to dispatch. Returns a handle that restores the
	 * previous state when the dispatch itself failed before any adapter request was seen.
	 */
	beginDeskTransition(id: string, action: ExecutionAction, threadId: number): DeskTransition {
		const record = this.#records.get(id);
		if (!record) throw new SessionGoneError(id);
		this.#beginTransition(record, action, threadId, undefined);
		const transition = record.transition!;
		return {
			generation: record.generation,
			failed: () => {
				// The command was rejected: if nothing resolved the transition meanwhile, the previous state stands.
				if (record.transition !== transition) return;
				this.#clearTransition(record);
				this.#setState(record, transition.previous);
			},
		};
	}

	// ---- launches ----

	/**
	 * Starts a configuration through VS Code and identifies the session by a fresh per-attempt marker property.
	 * One launch at a time per window: no session id exists before a start, so concurrent starts could not be told apart.
	 */
	async launch(request: LaunchRequest): Promise<LaunchOutcome> {
		const previous = this.#launchChain;
		let release!: () => void;
		const turn = new Promise<void>(resolve => { release = resolve; });
		this.#launchChain = previous.then(() => turn);
		try {
			await previous;
			if (request.signal.aborted) return { kind: "unknown", detail: "The call was cancelled before the start was requested; nothing was started." };
			return await this.#launchNow(request);
		} finally {
			release();
		}
	}

	async #launchNow(request: LaunchRequest): Promise<LaunchOutcome> {
		const marker = globalThis.crypto.randomUUID();
		const attempt: LaunchAttempt = { marker, conversationId: request.conversationId, open: true, sessionIds: [] };
		this.#attempts.set(marker, attempt);
		try {
			const configuration = { ...request.configuration, [LAUNCH_MARKER_KEY]: marker };
			const start = this.#api.startDebugging(request.folderPath, configuration);
			type Settled = { kind: "result"; value: boolean } | { kind: "error"; message: string } | { kind: "timeout" } | { kind: "cancelled" };
			const settled = await this.#settle<Settled>(
				start.then<Settled, Settled>(value => ({ kind: "result", value }), (error: unknown) => ({ kind: "error", message: error instanceof Error ? error.message : String(error) })),
				this.limits.launchTimeoutMs,
				request.signal,
				{ kind: "timeout" },
				{ kind: "cancelled" },
			);
			if (settled.kind === "cancelled") return { kind: "unknown", detail: "The call was cancelled while VS Code was starting the configuration; whether a debug session starts is unknown, and it will not be controllable by this conversation." };
			if (settled.kind === "timeout") return { kind: "unknown", detail: `VS Code did not answer within ${Math.round(this.limits.launchTimeoutMs / 1000)} s; whether a debug session starts is unknown, and it will not be controllable by this conversation.` };
			if (settled.kind === "error") return { kind: "error", detail: settled.message };
			if (!settled.value) return { kind: "refused", detail: "VS Code did not start the configuration (startDebugging returned false)." };
			if (attempt.sessionIds.length === 0) {
				await this.#settle<void>(
					new Promise<void>(resolve => { attempt.notify = resolve; }),
					this.limits.markerGraceMs,
					request.signal,
					undefined,
					undefined,
				);
			}
			if (attempt.sessionIds.length === 0) return { kind: "not-identified" };
			return { kind: "started", sessionIds: [...attempt.sessionIds] };
		} finally {
			// A session carrying the marker that appears after this point is nobody's to control.
			attempt.open = false;
			attempt.notify = undefined;
			const timer = setTimeout(() => { this.#attempts.delete(marker); }, 5 * 60_000);
			timer.unref?.();
		}
	}

	#settle<T>(promise: Promise<T>, timeoutMs: number, signal: AbortSignal, onTimeout: T, onAbort: T): Promise<T> {
		return new Promise<T>(resolve => {
			const finish = (value: T): void => {
				clearTimeout(timer);
				signal.removeEventListener("abort", abort);
				resolve(value);
			};
			const timer = setTimeout(() => finish(onTimeout), timeoutMs);
			const abort = (): void => finish(onAbort);
			if (signal.aborted) { abort(); return; }
			signal.addEventListener("abort", abort, { once: true });
			void promise.then(finish);
		});
	}
}

export class SessionNotStoppedError extends Error {
	constructor(sessionId: string, state: SessionState, hint = "") {
		super(`Debug session ${sessionId} is not stopped (${describeState(state)}); wait for a stop first.${hint}`);
		this.name = "SessionNotStoppedError";
	}
}

export interface SessionReader {
	readonly sessionId: string;
	readonly generation: number;
	assertFresh(): void;
	request(command: string, args?: unknown): Promise<unknown>;
}

export interface DeskTransition {
	readonly generation: number;
	failed(): void;
}

export type WaitOutcome =
	| { readonly kind: "stopped"; readonly sessionId: string; readonly state: Extract<SessionState, { kind: "stopped" }>; readonly generation: number }
	| { readonly kind: "terminated"; readonly generation: number }
	| { readonly kind: "timeout"; readonly state: SessionState; readonly generation: number };

function evaluateWait(root: SessionRecord, members: readonly SessionRecord[], after: number | undefined): WaitOutcome | undefined {
	if (root.state.kind === "terminated") return { kind: "terminated", generation: root.generation };
	for (const member of members) {
		if (member.state.kind === "stopped" && (after === undefined || member.generation > after)) {
			return { kind: "stopped", sessionId: member.id, state: member.state, generation: member.generation };
		}
	}
	return undefined;
}

export function describeState(state: SessionState): string {
	switch (state.kind) {
		case "running": return "running";
		case "transitioning": return `transitioning (${state.action})`;
		case "stopped": return `stopped (${state.reason}${state.threadId !== undefined ? `, thread ${state.threadId}` : ""})`;
		case "unknown": return "state unknown";
		case "terminated": return "terminated";
	}
}

function viewOf(record: SessionRecord): SessionView {
	return {
		id: record.id,
		name: record.name,
		type: record.type,
		...(record.folderPath !== undefined ? { folderPath: record.folderPath } : {}),
		...(record.parentId !== undefined ? { parentId: record.parentId } : {}),
		tracked: record.tracked,
		origin: record.origin,
		...(record.startedBy !== undefined ? { startedBy: record.startedBy } : {}),
		...(record.controlOwner !== undefined ? { controlOwner: record.controlOwner } : {}),
		handedOff: record.handedOff,
		state: record.state,
		generation: record.generation,
		...(record.adapterError !== undefined ? { adapterError: record.adapterError } : {}),
	};
}
