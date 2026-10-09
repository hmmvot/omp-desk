/** Native registry membership plus bounded latest activity; no child transcript is retained here. */
import { isRecord } from "../guards.ts";
import type { LiveAgent, LiveAgentState } from "./agent-liveness.ts";

export type AgentStatus = "pending" | "running" | "completed" | "failed" | "aborted";
export interface RunningAgent {
	id: string;
	index: number;
	agent: string;
	agentSource: string;
	status: AgentStatus;
	lastUpdate: number;
	description?: string;
	task?: string;
	assignment?: string;
	sessionFile?: string;
	parentToolCallId?: string;
	progress?: Record<string, unknown>;
	/**
	 * `"registry"`: the row exists only because the Desk liveness signal (ADR-0053) reported the agent working while
	 * OMP's RPC roster did not list it. Absent for a row the RPC roster owns. A later RPC frame for the id takes over.
	 */
	origin?: "registry";
	/** The registry state the newest liveness publication reported for this id; absent when it did not list it. */
	liveState?: LiveAgentState;
}
export interface AgentActivity { type: string; tool?: string; intent?: string; timestamp: number }
export interface AgentOwner { sessionFile?: string; parentToolCallId?: string }
export interface AgentLifecycle extends AgentOwner {
	id: string; index: number; agent: string; agentSource: string; description?: string;
	status: "started" | "completed" | "failed" | "aborted";
}
export interface AgentProgress extends AgentOwner {
	index: number; agent: string; agentSource: string; task: string; assignment?: string;
	progress: Record<string, unknown> & { id: string; status: AgentStatus; description?: string };
}
export type SubagentFrame =
	| { type: "subagent_lifecycle"; payload: AgentLifecycle }
	| { type: "subagent_progress"; payload: AgentProgress }
	| { type: "subagent_event"; payload: { id: string; event: AgentActivity } };

const AGENT_STATUSES: Record<string, true> = { pending: true, running: true, completed: true, failed: true, aborted: true };
function isIdentity(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 256; }

export function parseRunningAgent(value: unknown): RunningAgent | null {
	if (!isRecord(value) || !isIdentity(value.id) || typeof value.agent !== "string" || typeof value.agentSource !== "string" || typeof value.index !== "number" || !Number.isSafeInteger(value.index) || typeof value.lastUpdate !== "number" || !Number.isFinite(value.lastUpdate) || typeof value.status !== "string" || !Object.hasOwn(AGENT_STATUSES, value.status)) return null;
	for (const key of ["description", "task", "assignment", "sessionFile", "parentToolCallId"]) if (value[key] !== undefined && typeof value[key] !== "string") return null;
	if (value.progress !== undefined && !isRecord(value.progress)) return null;
	if (value.origin !== undefined && value.origin !== "registry") return null;
	if (value.liveState !== undefined && value.liveState !== "running" && value.liveState !== "idle") return null;
	return value as unknown as RunningAgent;
}
export function parseAgentRoster(value: unknown): RunningAgent[] | null {
	if (!Array.isArray(value)) return null;
	const rows: RunningAgent[] = [];
	const seen = new Set<string>();
	for (const raw of value) {
		const row = parseRunningAgent(raw);
		if (row === null || seen.has(row.id)) continue;
		seen.add(row.id);
		rows.push(row);
	}
	return rows;
}
export function parseAgentActivity(value: unknown, now = 0): AgentActivity | null {
	if (!isRecord(value) || !isIdentity(value.type)) return null;
	const message = isRecord(value.message) ? value.message : null;
	const timestamp = typeof value.timestamp === "number" && Number.isFinite(value.timestamp) ? value.timestamp : typeof message?.timestamp === "number" && Number.isFinite(message.timestamp) ? message.timestamp : now;
	const activity: AgentActivity = { type: value.type, timestamp };
	const tool = typeof value.tool === "string" ? value.tool : value.toolName;
	if (typeof tool === "string") activity.tool = tool.slice(0, 256);
	if (typeof value.intent === "string") activity.intent = value.intent.slice(0, 500);
	return activity;
}
export function parseSubagentFrame(value: unknown, now = 0): SubagentFrame | null {
	if (!isRecord(value) || !isRecord(value.payload)) return null;
	const payload = value.payload;
	if (value.type === "subagent_event") {
		const event = parseAgentActivity(payload.event, now);
		return isIdentity(payload.id) && event !== null ? { type: "subagent_event", payload: { id: payload.id, event } } : null;
	}
	if (typeof payload.index !== "number" || !Number.isSafeInteger(payload.index) || typeof payload.agent !== "string" || typeof payload.agentSource !== "string") return null;
	for (const key of ["sessionFile", "parentToolCallId"]) if (payload[key] !== undefined && typeof payload[key] !== "string") return null;
	if (value.type === "subagent_lifecycle") {
		if (!isIdentity(payload.id) || (payload.status !== "started" && payload.status !== "completed" && payload.status !== "failed" && payload.status !== "aborted") || (payload.description !== undefined && typeof payload.description !== "string")) return null;
		return { type: "subagent_lifecycle", payload: payload as unknown as AgentLifecycle };
	}
	if (value.type === "subagent_progress") {
		if (!isRecord(payload.progress) || !isIdentity(payload.progress.id) || typeof payload.progress.status !== "string" || !Object.hasOwn(AGENT_STATUSES, payload.progress.status) || typeof payload.task !== "string" || (payload.assignment !== undefined && typeof payload.assignment !== "string") || (payload.progress.description !== undefined && typeof payload.progress.description !== "string")) return null;
		return { type: "subagent_progress", payload: payload as unknown as AgentProgress };
	}
	return null;
}
export function sameAgentOwner(payload: AgentOwner, row: RunningAgent): boolean {
	if (payload.parentToolCallId !== undefined && row.parentToolCallId !== undefined) return payload.parentToolCallId === row.parentToolCallId;
	if (payload.sessionFile !== undefined && row.sessionFile !== undefined) return payload.sessionFile === row.sessionFile;
	return true;
}
/**
 * What a roster row keeps about the spawn once the native roster has dropped it. A woken agent's frames carry
 * the IRC message as `task`, no label, and (for a cold revive) its own id as the agent type; this memory is what
 * lets the row keep the type, description and assignment the agent was spawned with.
 */
export interface AgentIdentity { agent: string; agentSource: string; description?: string; assignment?: string }
export type AgentIdentities = ReadonlyMap<string, AgentIdentity>;
/** The spawn's type and assignment read from the transcript's own `task` call, when the model has it. */
export type SpawnLookup = (id: string) => Partial<AgentIdentity> | undefined;
export const MAX_AGENT_IDENTITIES = 256;

function realType(id: string, ...candidates: readonly (string | undefined)[]): string | undefined {
	for (const candidate of candidates) {
		const type = candidate?.trim();
		if (type !== undefined && type.length > 0 && type !== id) return type;
	}
	return undefined;
}

interface RowFacts { id: string; agent: string; agentSource: string; description?: string; assignment?: string }

/**
 * The row's identity from this frame, the live row it replaces, the remembered spawn and, only when none of
 * those know the type or assignment, the transcript's `task` call. Frame text that belongs to a wake (no
 * `assignment`) never becomes the assignment; a genuinely new spawn (a different assignment) inherits nothing.
 */
function resolveIdentity(frame: RowFacts, existing: RunningAgent | undefined, known: AgentIdentity | undefined, spawn: SpawnLookup | undefined): { agent: string; description?: string; assignment?: string } {
	const { id } = frame;
	const sameSpawn = (prior: { assignment?: string } | undefined): boolean => prior !== undefined && (frame.assignment === undefined || prior.assignment === undefined || frame.assignment === prior.assignment);
	const live = sameSpawn(existing) ? existing : undefined;
	const remembered = sameSpawn(known) ? known : undefined;
	let agent = realType(id, frame.agent, live?.agent, remembered?.agent);
	const description = frame.description ?? live?.description ?? remembered?.description;
	let assignment = frame.assignment ?? live?.assignment ?? remembered?.assignment;
	if ((agent === undefined || assignment === undefined) && known === undefined && existing === undefined) {
		const spawned = spawn?.(id);
		agent ??= realType(id, spawned?.agent);
		assignment ??= spawned?.assignment;
	}
	return { agent: agent ?? frame.agent, ...(description === undefined ? {} : { description }), ...(assignment === undefined ? {} : { assignment }) };
}

function remember(identities: AgentIdentities, row: RunningAgent): AgentIdentities {
	const next = new Map(identities);
	next.delete(row.id);
	next.set(row.id, { agent: row.agent, agentSource: row.agentSource, ...(row.description === undefined ? {} : { description: row.description }), ...(row.assignment === undefined ? {} : { assignment: row.assignment }) });
	while (next.size > MAX_AGENT_IDENTITIES) next.delete(next.keys().next().value as string);
	return next;
}

/** A native roster snapshot (`get_subagents`): rows enriched with what is remembered or recorded about their spawn. */
export function reduceAgentRoster(rows: readonly RunningAgent[], identities: AgentIdentities, spawn?: SpawnLookup): { agents: ReadonlyMap<string, RunningAgent>; agentIdentity: AgentIdentities } {
	const agents = new Map<string, RunningAgent>();
	let agentIdentity = identities;
	for (const raw of rows) {
		const { description: progressDescription } = raw.progress ?? {};
		const resolved = resolveIdentity({ id: raw.id, agent: raw.agent, agentSource: raw.agentSource, description: raw.description ?? (typeof progressDescription === "string" ? progressDescription : undefined), assignment: raw.assignment }, undefined, identities.get(raw.id), spawn);
		const row: RunningAgent = { ...raw, agent: resolved.agent, description: resolved.description, assignment: resolved.assignment };
		agents.set(row.id, row);
		agentIdentity = remember(agentIdentity, row);
	}
	return { agents, agentIdentity };
}

export function reduceAgentFrame(
	agents: ReadonlyMap<string, RunningAgent>, activity: ReadonlyMap<string, AgentActivity>, identities: AgentIdentities, frame: SubagentFrame, now: number, spawn?: SpawnLookup,
): { agents: ReadonlyMap<string, RunningAgent>; agentActivity: ReadonlyMap<string, AgentActivity>; agentIdentity: AgentIdentities } {
	if (frame.type === "subagent_event") {
		return { agents, agentActivity: agents.has(frame.payload.id) ? new Map(activity).set(frame.payload.id, frame.payload.event) : activity, agentIdentity: identities };
	}
	const payload = frame.payload;
	const id = frame.type === "subagent_progress" ? frame.payload.progress.id : frame.payload.id;
	const existing = agents.get(id);
	// A registry-only row yields to OMP's own roster: any RPC frame for its id replaces or removes it.
	if ((existing === undefined && (frame.type !== "subagent_lifecycle" || frame.payload.status !== "started")) || (existing !== undefined && existing.origin !== "registry" && !sameAgentOwner(payload, existing))) return { agents, agentActivity: activity, agentIdentity: identities };
	const next = new Map(agents);
	if (frame.type === "subagent_lifecycle" && frame.payload.status !== "started") {
		// The finished run's activity never labels anything after it, whether the row goes or stays.
		const latest = new Map(activity);
		latest.delete(id);
		// The newest publication already reported this agent working after its registry ref went idle: OMP's run
		// ended, but a resumed run it does not observe goes on, so the row stays as a registry row.
		if (existing?.liveState === "idle") {
			next.set(id, { id, index: existing.index, agent: existing.agent, agentSource: existing.agentSource, status: "running", lastUpdate: existing.lastUpdate, ...(existing.sessionFile === undefined ? {} : { sessionFile: existing.sessionFile }), ...(existing.description === undefined ? {} : { description: existing.description }), ...(existing.assignment === undefined ? {} : { assignment: existing.assignment }), origin: "registry", liveState: "idle" });
			return { agents: next, agentActivity: latest, agentIdentity: identities };
		}
		next.delete(id);
		return { agents: next, agentActivity: latest, agentIdentity: identities };
	}
	const resolved = resolveIdentity({
		id, agent: payload.agent, agentSource: payload.agentSource,
		description: frame.type === "subagent_progress" ? frame.payload.progress.description : frame.payload.description,
		assignment: frame.type === "subagent_progress" ? frame.payload.assignment : undefined,
	}, existing, identities.get(id), spawn);
	const row: RunningAgent = {
		id, index: payload.index, agent: resolved.agent, agentSource: payload.agentSource, lastUpdate: now,
		status: frame.type === "subagent_progress" ? frame.payload.progress.status : "running",
		sessionFile: payload.sessionFile ?? existing?.sessionFile,
		parentToolCallId: payload.parentToolCallId ?? existing?.parentToolCallId,
		description: resolved.description,
		task: frame.type === "subagent_progress" ? frame.payload.task : existing?.task,
		assignment: resolved.assignment,
		progress: frame.type === "subagent_progress" ? frame.payload.progress : existing?.progress,
		...(existing?.liveState === undefined ? {} : { liveState: existing.liveState }),
	};
	next.set(id, row);
	return { agents: next, agentActivity: activity, agentIdentity: remember(identities, row) };
}

/** Index of a registry-only row: after every agent the RPC roster numbered, then ordered by id. */
const REGISTRY_ROW_INDEX = 1_000_000;

/**
 * Fold one accepted liveness publication (ADR-0053) into the roster. The RPC roster stays authoritative for every
 * id it lists: a published agent it already shows keeps its row, only annotated with the published `liveState`, so
 * no agent appears twice and a publication never removes an RPC row. A published agent it does not show becomes a
 * `"registry"` row running with the published activity and the identity remembered from its spawn; a registry row
 * the publication no longer lists is removed.
 */
export function reduceAgentLiveness(
	agents: ReadonlyMap<string, RunningAgent>, activity: ReadonlyMap<string, AgentActivity>, identities: AgentIdentities, live: readonly LiveAgent[], now: number, spawn?: SpawnLookup,
): { agents: ReadonlyMap<string, RunningAgent>; agentActivity: ReadonlyMap<string, AgentActivity>; agentIdentity: AgentIdentities } {
	const next = new Map(agents);
	const latest = new Map(activity);
	let agentIdentity = identities;
	const listed = new Map(live.map(agent => [agent.id, agent]));
	for (const [id, row] of agents) {
		if (row.origin === "registry" && !listed.has(id)) {
			next.delete(id);
			latest.delete(id);
		} else if (row.origin !== "registry" && row.liveState !== listed.get(id)?.state) {
			const { liveState: _previous, ...rest } = row;
			const state = listed.get(id)?.state;
			next.set(id, state === undefined ? rest : { ...rest, liveState: state });
		}
	}
	for (const signal of live) {
		const existing = next.get(signal.id);
		if (existing !== undefined && existing.origin !== "registry") continue;
		const known = identities.get(signal.id);
		const resolved = resolveIdentity({ id: signal.id, agent: signal.agent, agentSource: known?.agentSource ?? "" }, existing, known, spawn);
		const row: RunningAgent = {
			id: signal.id, index: existing?.index ?? REGISTRY_ROW_INDEX, agent: resolved.agent, agentSource: known?.agentSource ?? existing?.agentSource ?? "",
			status: "running", lastUpdate: existing?.lastUpdate ?? now,
			...(signal.sessionFile === undefined ? {} : { sessionFile: signal.sessionFile }),
			...(resolved.description === undefined ? {} : { description: resolved.description }),
			...(resolved.assignment === undefined ? {} : { assignment: resolved.assignment }),
			origin: "registry",
			liveState: signal.state,
		};
		next.set(signal.id, row);
		agentIdentity = remember(agentIdentity, row);
		if (signal.tool !== undefined || signal.intent !== undefined) {
			latest.set(signal.id, { type: "registry", timestamp: now, ...(signal.tool === undefined ? {} : { tool: signal.tool }), ...(signal.intent === undefined ? {} : { intent: signal.intent }) });
		} else {
			latest.delete(signal.id);
		}
	}
	return { agents: next, agentActivity: latest, agentIdentity };
}

/** A `get_subagents` snapshot replaces OMP's rows only: registry rows for ids it does not list are kept. */
export function withRegistryRows(snapshot: ReadonlyMap<string, RunningAgent>, previous: ReadonlyMap<string, RunningAgent>): ReadonlyMap<string, RunningAgent> {
	let merged: Map<string, RunningAgent> | null = null;
	for (const [id, row] of previous) {
		if (row.origin !== "registry" || snapshot.has(id)) continue;
		merged ??= new Map(snapshot);
		merged.set(id, row);
	}
	return merged ?? snapshot;
}

/** The type and assignment a `task` tool call in the transcript gave the agent named `id`, newest call first. */
export function taskSpawnIdentity(entries: readonly unknown[], id: string): Partial<AgentIdentity> | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message) || entry.message.role !== "assistant" || !Array.isArray(entry.message.content)) continue;
		for (const block of entry.message.content as unknown[]) {
			if (!isRecord(block) || block.type !== "toolCall" || block.name !== "task" || !isRecord(block.arguments)) continue;
			const args = block.arguments;
			const items = Array.isArray(args.tasks) ? args.tasks.filter(isRecord) : [args];
			for (const item of items) {
				if ((item.name ?? item.id) !== id) continue;
				const agent = typeof item.agent === "string" ? item.agent : typeof args.agent === "string" ? args.agent : undefined;
				const assignment = typeof item.task === "string" ? item.task : typeof item.assignment === "string" ? item.assignment : undefined;
				return { ...(agent === undefined ? {} : { agent }), ...(assignment === undefined ? {} : { assignment }) };
			}
		}
	}
	return undefined;
}
