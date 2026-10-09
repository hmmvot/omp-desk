/**
 * OMP-side subagent liveness (ADR-0053), loaded into each Desk-launched OMP process by the host-control `-e`
 * module.
 *
 * OMP 18.8.5's RPC roster hears only task-executor run monitors. A subagent resumed by an IRC message without one
 * (a parent's message steered into a session that is still in flight, or a wake whose observer was skipped) runs
 * with no `subagent_lifecycle started` frame, and its registry ref stays `idle` while the session streams, because
 * the executor forces it idle (`task/executor.ts` `finalizeSubagentLifecycle`) and no new `agent_start` follows.
 * This module derives liveness from the process-global AgentRegistry plus each subagent binding's own run events,
 * and, in an RPC main session only, publishes the live set to the Desk host as a `setStatus` text
 * (`chat/agent-liveness.ts`).
 *
 * Event-driven: registry `onChange` and the subagent bindings' own `agent_start`/`turn_start`/
 * `tool_execution_start`/`agent_end` hooks schedule a coalesced recomputation; nothing is published when the
 * result is unchanged. Two bounded timers exist only while something is live: a 2 s re-check while an `idle` agent
 * is live (OMP emits no event when its streaming ends), and a 10 s repeat of an unchanged non-empty set, so a host
 * that missed a publication converges without asking.
 *
 * Reads only public extension context (`ctx.mode`, `ctx.agent`, `ctx.sessionManager`, `ctx.ui.setStatus`) and the
 * SDK-exported `AgentRegistry` (`list`, `onChange`, ref `id`/`kind`/`status`/`displayName`/`sessionFile`/
 * `activity`/`history.agent`/`lifecycle.acceptedAt`/`lifecycle.terminalAt` and the live session's `isStreaming`/
 * `queuedMessageCount`). Never throws into OMP.
 */
import { randomBytes } from "node:crypto";
import { clearTimeout as clearNodeTimeout, setTimeout as setNodeTimeout } from "node:timers";
import {
	AGENT_LIVENESS_STATUS_KEY,
	AGENT_LIVENESS_VERSION,
	MAX_LIVE_AGENTS,
	boundLiveAgent,
	encodeAgentLiveness,
	type LiveAgent,
	type LiveAgentState,
} from "../chat/agent-liveness.ts";

/** The slice of a registry `AgentRef` (`src/registry/agent-registry.ts`) this module reads. */
export interface OmpAgentRef {
	readonly id?: unknown;
	readonly kind?: unknown;
	readonly status?: unknown;
	readonly displayName?: unknown;
	readonly sessionFile?: unknown;
	readonly activity?: unknown;
	readonly history?: { readonly agent?: unknown } | null;
	readonly session?: { readonly isStreaming?: unknown; readonly queuedMessageCount?: unknown } | null;
	readonly lifecycle?: { readonly acceptedAt?: unknown; readonly terminalAt?: unknown } | null;
}

/** `AgentRegistry.global()`, as far as this module reads it. */
export interface OmpAgentRegistry {
	list?(): readonly OmpAgentRef[];
	onChange?(listener: (event: unknown) => void): () => void;
}

/** What a subagent binding last observed of its own session. */
export interface ObservedRun {
	/** When the binding last saw its session start a run, a turn or a tool (epoch ms, the registry's clock). */
	workAt?: number;
	tool?: string;
	intent?: string;
}

/**
 * The live state of one registry ref, or null when it is not a subagent doing work. The single derivation the
 * host-control `subagentWork` answer, the native settle state and the Agents-row signal share:
 *
 * - `running`, unless its result was accepted and nothing streams (the registry's own "stale accepted run");
 * - `idle` with messages queued for it;
 * - `idle` whose session still streams **and** whose own binding observed a run, turn or tool start after the ref
 *   left `running` (`lifecycle.terminalAt`). That is a resumed run OMP's roster cannot see; a finished run that is
 *   merely unwinding streams without new work and does not count. A subagent without a binding (OMP gives isolated
 *   worktree runs none) therefore never counts by this rule, nor does a ref without a numeric `terminalAt`.
 *
 * Parked, aborted, advisor and main refs never count.
 */
export function subagentLiveState(ref: OmpAgentRef | null | undefined, observed: ReadonlyMap<string, ObservedRun>): LiveAgentState | null {
	if (ref === null || typeof ref !== "object" || ref.kind !== "sub") return null;
	const streaming = ref.session?.isStreaming === true;
	if (ref.status === "running") return streaming || ref.lifecycle?.acceptedAt === undefined ? "running" : null;
	if (ref.status !== "idle") return null;
	const queued = ref.session?.queuedMessageCount;
	if (typeof queued === "number" && queued > 0) return "idle";
	if (!streaming || typeof ref.id !== "string") return null;
	const terminalAt = ref.lifecycle?.terminalAt;
	// Without the time the ref left `running`, a resumed run cannot be told from an unwinding one: fail closed.
	if (typeof terminalAt !== "number") return null;
	const workAt = observed.get(ref.id)?.workAt;
	return workAt !== undefined && workAt > terminalAt ? "idle" : null;
}

export interface AgentLivenessTimers {
	now(): number;
	setTimeout(callback: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

export interface AgentLivenessPublisherOptions {
	registry(): OmpAgentRegistry | undefined;
	/** The main session id at publication time; null skips publishing. */
	sessionId(): string | null;
	publish(text: string): void;
	observed: Map<string, ObservedRun>;
	timers?: AgentLivenessTimers;
	instance?: string;
}

/** Coalescing delay for a membership edge (a registry change, a run start or end). */
export const LIVENESS_EDGE_DELAY_MS = 150;
/** Coalescing delay for an activity-only change, so a busy agent publishes at most about once a second. */
export const LIVENESS_ACTIVITY_DELAY_MS = 1_000;
/** Re-check while an `idle` agent is live, and retry after a failed publication. */
export const LIVENESS_IDLE_RECHECK_MS = 2_000;
/** Repeat an unchanged non-empty set this often. */
export const LIVENESS_REPEAT_MS = 10_000;

const NODE_TIMERS: AgentLivenessTimers = {
	now: () => Date.now(),
	setTimeout: (callback, ms) => {
		const handle = setNodeTimeout(callback, ms);
		handle.unref?.();
		return handle;
	},
	clearTimeout: handle => clearNodeTimeout(handle as NodeJS.Timeout),
};

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
}

/** One process's publisher. */
export class AgentLivenessPublisher {
	readonly #options: AgentLivenessPublisherOptions;
	readonly #timers: AgentLivenessTimers;
	readonly #instance: string;
	#seq = 0;
	#timer: unknown = null;
	#dueAt = 0;
	#lastSignature: string | null = null;
	#lastPublishedAt = 0;
	#unsubscribe: (() => void) | null = null;
	#stopped = false;

	constructor(options: AgentLivenessPublisherOptions) {
		this.#options = options;
		this.#timers = options.timers ?? NODE_TIMERS;
		this.#instance = options.instance ?? randomBytes(16).toString("hex");
	}

	/** Subscribe to the registry and publish the current set. */
	start(): void {
		try {
			const unsubscribe = this.#options.registry()?.onChange?.(event => {
				// A ref that left `running` has no current tool: the previous run's activity must not label a resumed one.
				const ref = record(record(event)?.ref);
				if (record(event)?.type === "status_changed" && ref?.status !== "running" && typeof ref?.id === "string") {
					const observed = this.#options.observed.get(ref.id);
					if (observed !== undefined) this.#options.observed.set(ref.id, observed.workAt === undefined ? {} : { workAt: observed.workAt });
				}
				this.schedule(LIVENESS_EDGE_DELAY_MS);
			});
			if (typeof unsubscribe === "function") this.#unsubscribe = unsubscribe;
		} catch {
			// An older registry without events still publishes on binding hooks and re-checks.
		}
		this.schedule(LIVENESS_EDGE_DELAY_MS);
	}

	stop(): void {
		this.#stopped = true;
		this.#unsubscribe?.();
		this.#unsubscribe = null;
		if (this.#timer !== null) this.#timers.clearTimeout(this.#timer);
		this.#timer = null;
	}

	/** Recompute within `delayMs`; an earlier pending recomputation is kept. */
	schedule(delayMs: number): void {
		if (this.#stopped) return;
		const dueAt = this.#timers.now() + delayMs;
		if (this.#timer !== null) {
			if (this.#dueAt <= dueAt) return;
			this.#timers.clearTimeout(this.#timer);
		}
		this.#dueAt = dueAt;
		this.#timer = this.#timers.setTimeout(() => {
			this.#timer = null;
			this.#run();
		}, delayMs);
	}

	/** The live agents, in registry order and within the wire bound, plus whether any of them is live while `idle`. */
	compute(): { agents: LiveAgent[]; idleLive: boolean } {
		let refs: readonly OmpAgentRef[] | undefined;
		try {
			refs = this.#options.registry()?.list?.();
		} catch {
			refs = undefined;
		}
		const agents: LiveAgent[] = [];
		let idleLive = false;
		if (!Array.isArray(refs)) return { agents, idleLive };
		for (const ref of refs) {
			if (agents.length >= MAX_LIVE_AGENTS) break;
			const state = subagentLiveState(ref, this.#options.observed);
			if (state === null) continue;
			if (state === "idle") idleLive = true;
			const observed = typeof ref.id === "string" ? this.#options.observed.get(ref.id) : undefined;
			const agent = boundLiveAgent({
				id: ref.id,
				state,
				agent: typeof ref.history?.agent === "string" ? ref.history.agent : ref.displayName,
				sessionFile: ref.sessionFile,
				tool: observed?.tool,
				intent: observed?.intent ?? ref.activity,
			});
			if (agent !== null) agents.push(agent);
		}
		return { agents, idleLive };
	}

	#run(): void {
		if (this.#stopped) return;
		let sessionId: string | null;
		try {
			sessionId = this.#options.sessionId();
		} catch {
			sessionId = null;
		}
		const { agents, idleLive } = this.compute();
		let failed = false;
		if (sessionId !== null) {
			// The registry state is part of the signature: a running → idle edge always republishes, so a host that
			// already removed the row on OMP's terminal frame sees the resumed agent again.
			const signature = JSON.stringify([sessionId, agents]);
			const now = this.#timers.now();
			const repeat = agents.length > 0 && now - this.#lastPublishedAt >= LIVENESS_REPEAT_MS;
			if (signature !== this.#lastSignature || repeat) {
				try {
					this.#options.publish(encodeAgentLiveness({ v: AGENT_LIVENESS_VERSION, instance: this.#instance, seq: this.#seq + 1, sessionId, agents }));
					this.#seq += 1;
					this.#lastSignature = signature;
					this.#lastPublishedAt = now;
				} catch {
					failed = true;
				}
			}
		}
		if (failed || idleLive) this.schedule(LIVENESS_IDLE_RECHECK_MS);
		else if (agents.length > 0) this.schedule(LIVENESS_REPEAT_MS);
	}
}

/** The binding context fields this module reads (`ExtensionContext`, pi-coding-agent `extensibility/extensions/types.ts`). */
export interface LivenessContext {
	readonly mode?: unknown;
	readonly agent?: { readonly kind?: unknown; readonly id?: unknown } | null;
	readonly sessionManager?: { getSessionId?(): unknown } | null;
	readonly ui?: { setStatus?(key: string, text: string | undefined): void } | null;
}

export interface AgentLivenessApi {
	on(event: string, handler: (event: unknown, ctx: LivenessContext) => unknown): void;
	readonly pi?: { readonly AgentRegistry?: { global?(): OmpAgentRegistry } };
}

interface LivenessStore {
	readonly observed: Map<string, ObservedRun>;
	publisher: AgentLivenessPublisher | null;
}

/** Shared by every binding of the module in this process: OMP rebinds the factory to each subagent session. */
const STORE_KEY = Symbol.for("omp-vscode.agent-liveness");
const MAX_OBSERVED = 256;

function livenessStore(): LivenessStore {
	const holder = globalThis as { [STORE_KEY]?: LivenessStore };
	return (holder[STORE_KEY] ??= { observed: new Map(), publisher: null });
}

/** {@link subagentLiveState} against this process's binding observations, for host-control's work answers. */
export function isLiveSubagentRef(ref: OmpAgentRef | null | undefined): boolean {
	return subagentLiveState(ref, livenessStore().observed) !== null;
}

/**
 * Wire this binding. A subagent binding records its own session's runs, turns and tools and nudges the publisher;
 * the first RPC main binding creates the publisher, which writes through its own `ctx.ui.setStatus`. The native
 * TUI (`mode` `tui`) and print/json modes publish nothing, so no status text ever appears there.
 */
export function registerAgentLiveness(pi: AgentLivenessApi, timers?: AgentLivenessTimers): void {
	const store = livenessStore();
	const clock = timers ?? NODE_TIMERS;
	let mainContext: LivenessContext | null = null;
	const observe = (kind: string, event: unknown, ctx: LivenessContext): void => {
		try {
			const agent = record(ctx?.agent);
			if (agent?.kind !== "sub" || typeof agent.id !== "string" || agent.id.length === 0) return;
			const id = agent.id;
			const previous = store.observed.get(id);
			store.observed.delete(id);
			if (kind === "agent_end") {
				// The run is over: keep when it last worked, drop what it was doing.
				if (record(event)?.willContinue !== true && previous?.workAt !== undefined) store.observed.set(id, { workAt: previous.workAt });
				else if (previous !== undefined) store.observed.set(id, previous);
			} else if (kind === "tool_execution_start") {
				const payload = record(event);
				const tool = typeof payload?.toolName === "string" ? payload.toolName : undefined;
				const intent = typeof payload?.intent === "string" ? payload.intent : undefined;
				store.observed.set(id, { workAt: clock.now(), ...(tool === undefined ? {} : { tool }), ...(intent === undefined ? {} : { intent }) });
			} else {
				// agent_start opens a run with no tool yet; turn_start keeps the current one.
				store.observed.set(id, kind === "agent_start" ? { workAt: clock.now() } : { ...previous, workAt: clock.now() });
			}
			while (store.observed.size > MAX_OBSERVED) store.observed.delete(store.observed.keys().next().value as string);
			store.publisher?.schedule(kind === "tool_execution_start" ? LIVENESS_ACTIVITY_DELAY_MS : LIVENESS_EDGE_DELAY_MS);
		} catch {
			// Observation is best effort; OMP's own run is never affected.
		}
	};
	for (const kind of ["agent_start", "turn_start", "tool_execution_start", "agent_end"]) {
		pi.on(kind, (event, ctx) => observe(kind, event, ctx));
	}
	pi.on("session_start", (_event, ctx) => {
		try {
			if (store.publisher !== null || ctx?.mode !== "rpc" || record(ctx.agent)?.kind !== "main") return;
			mainContext = ctx;
			const publisher = new AgentLivenessPublisher({
				registry: () => pi.pi?.AgentRegistry?.global?.(),
				sessionId: () => {
					const id = mainContext?.sessionManager?.getSessionId?.();
					return typeof id === "string" && id.length > 0 ? id : null;
				},
				publish: text => mainContext?.ui?.setStatus?.(AGENT_LIVENESS_STATUS_KEY, text),
				observed: store.observed,
				...(timers === undefined ? {} : { timers }),
			});
			store.publisher = publisher;
			publisher.start();
		} catch {
			// Without a publisher the Agents row shows OMP's RPC roster alone, as before.
		}
	});
	// Keep the newest main context so `ui` and the session manager stay current across switches.
	for (const kind of ["session_switch", "session_branch", "session_tree"]) {
		pi.on(kind, (_event, ctx) => {
			if (mainContext !== null && record(ctx?.agent)?.kind === "main") {
				mainContext = ctx;
				store.publisher?.schedule(LIVENESS_EDGE_DELAY_MS);
			}
		});
	}
	// No `session_shutdown` handler of its own: a binding that is not the host-control owner must register nothing
	// that runs at shutdown. The owner's handler calls {@link stopAgentLiveness}; otherwise the unref'd timers and
	// the in-process registry subscription end with the process.
}

/** Stop this process's publisher; the next RPC main `session_start` may start another. */
export function stopAgentLiveness(): void {
	const store = livenessStore();
	store.publisher?.stop();
	store.publisher = null;
}
