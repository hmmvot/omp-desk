/**
 * The Desk-owned subagent liveness signal (ADR-0053), shared by the OMP-side publisher
 * (`src/omp/agent-liveness.ts`), the host and the page.
 *
 * OMP 18.8.5 builds its RPC roster (`get_subagents`, `subagent_lifecycle`/`subagent_progress`) only from
 * task-executor run monitors, so a subagent a parent's `write agent://<id>` resumed without a monitor runs
 * invisibly. The Desk's own `-e` module reads the process-global AgentRegistry and each subagent binding's run
 * events and publishes the agents that are actually working as one `setStatus` text under
 * {@link AGENT_LIVENESS_STATUS_KEY} on the session's own RPC stream. The host never shows that text: it parses it
 * here, drops anything not addressed to the session it bound, and folds the result into the Agents roster as
 * `agents_liveness`.
 *
 * Everything here is pure and bounded; no field is trusted beyond its validated shape and length.
 */
import { isRecord } from "../guards.ts";

/** The `setStatus` key the publisher writes and the host intercepts; it never reaches the status line. */
export const AGENT_LIVENESS_STATUS_KEY = "omp-desk.agent-liveness";
export const AGENT_LIVENESS_VERSION = 1;
/** At most this many agents per publication; the TUI's own roster is never larger in practice. */
export const MAX_LIVE_AGENTS = 32;
/** The whole encoded publication; the publisher sheds detail rather than exceed it. */
export const MAX_AGENT_LIVENESS_CHARS = 16_384;
const MAX_ID_CHARS = 256;
const MAX_AGENT_CHARS = 64;
const MAX_TOOL_CHARS = 64;
const MAX_INTENT_CHARS = 200;
const MAX_SESSION_FILE_CHARS = 1_024;
const INSTANCE_RE = /^[0-9a-f]{16,64}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/**
 * The registry status behind a published agent: `running`, or `idle` while the publisher observed the agent's own
 * session doing work after the registry ref left `running` (a resumed run OMP's roster cannot see).
 */
export type LiveAgentState = "running" | "idle";

/** One subagent the publisher observed working. */
export interface LiveAgent {
	readonly id: string;
	/** The agent definition name (`task`, `explore`, …) the registry recorded, or its display name. */
	readonly agent: string;
	readonly state: LiveAgentState;
	readonly sessionFile?: string;
	/** The tool the agent last started and its intent, when the publisher observed one. */
	readonly tool?: string;
	readonly intent?: string;
}

/** One publication: everything the publisher considers live at `seq`, for the main session `sessionId`. */
export interface AgentLivenessPublication {
	readonly v: typeof AGENT_LIVENESS_VERSION;
	/** Random per publisher (one OMP process); `seq` is monotonic within it. */
	readonly instance: string;
	readonly seq: number;
	/** The main session the publisher serves, read from its own session manager at publication time. */
	readonly sessionId: string;
	readonly agents: readonly LiveAgent[];
}

function boundedText(value: unknown, max: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
	return text.length === 0 ? undefined : text.slice(0, max);
}

function identity(value: unknown, max: number): string | undefined {
	return typeof value === "string" && value.length > 0 && value.length <= max && !CONTROL_RE.test(value) ? value : undefined;
}

/** Clamp an agent to the wire bounds; null when its identity or state is unusable. */
export function boundLiveAgent(agent: { id: unknown; state: unknown; agent?: unknown; sessionFile?: unknown; tool?: unknown; intent?: unknown }): LiveAgent | null {
	const id = identity(agent.id, MAX_ID_CHARS);
	if (id === undefined || (agent.state !== "running" && agent.state !== "idle")) return null;
	const sessionFile = identity(agent.sessionFile, MAX_SESSION_FILE_CHARS);
	const tool = boundedText(agent.tool, MAX_TOOL_CHARS);
	const intent = boundedText(agent.intent, MAX_INTENT_CHARS);
	return {
		id,
		agent: boundedText(agent.agent, MAX_AGENT_CHARS) ?? "",
		state: agent.state,
		...(sessionFile === undefined ? {} : { sessionFile }),
		...(tool === undefined ? {} : { tool }),
		...(intent === undefined ? {} : { intent }),
	};
}

/**
 * The `setStatus` text of one publication within {@link MAX_AGENT_LIVENESS_CHARS}. Detail is shed in a fixed order
 * until it fits — intents, then tools, then session files, then trailing agents — so membership survives as long
 * as possible and a publication is never skipped (an id-only entry is a few hundred characters at most).
 */
export function encodeAgentLiveness(publication: AgentLivenessPublication): string {
	const shed: ((agent: LiveAgent) => LiveAgent)[] = [
		({ intent: _intent, ...agent }) => agent,
		({ tool: _tool, ...agent }) => agent,
		({ sessionFile: _sessionFile, ...agent }) => agent,
	];
	let agents = publication.agents.slice(0, MAX_LIVE_AGENTS);
	let text = JSON.stringify({ ...publication, agents });
	for (const step of shed) {
		if (text.length <= MAX_AGENT_LIVENESS_CHARS) return text;
		agents = agents.map(step);
		text = JSON.stringify({ ...publication, agents });
	}
	while (text.length > MAX_AGENT_LIVENESS_CHARS && agents.length > 0) {
		agents = agents.slice(0, -1);
		text = JSON.stringify({ ...publication, agents });
	}
	return text;
}

/** A validated list of live agents (a page frame or a decoded publication); null on any malformed member. */
export function parseLiveAgents(value: unknown): LiveAgent[] | null {
	if (!Array.isArray(value) || value.length > MAX_LIVE_AGENTS) return null;
	const agents: LiveAgent[] = [];
	const seen = new Set<string>();
	for (const raw of value) {
		if (!isRecord(raw)) return null;
		for (const key of ["agent", "sessionFile", "tool", "intent"]) if (raw[key] !== undefined && typeof raw[key] !== "string") return null;
		if (raw.sessionFile !== undefined && identity(raw.sessionFile, MAX_SESSION_FILE_CHARS) === undefined) return null;
		const agent = boundLiveAgent(raw as { id: unknown; state: unknown });
		if (agent === null || seen.has(agent.id)) return null;
		seen.add(agent.id);
		agents.push(agent);
	}
	return agents;
}

/** Decode one `setStatus` text; null when it is not a well-formed publication. */
export function decodeAgentLiveness(text: unknown): AgentLivenessPublication | null {
	if (typeof text !== "string" || text.length > MAX_AGENT_LIVENESS_CHARS) return null;
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return null;
	}
	if (!isRecord(value) || value.v !== AGENT_LIVENESS_VERSION) return null;
	if (typeof value.instance !== "string" || !INSTANCE_RE.test(value.instance)) return null;
	if (typeof value.seq !== "number" || !Number.isSafeInteger(value.seq) || value.seq < 1) return null;
	const sessionId = identity(value.sessionId, MAX_ID_CHARS);
	if (sessionId === undefined) return null;
	const agents = parseLiveAgents(value.agents);
	return agents === null ? null : { v: AGENT_LIVENESS_VERSION, instance: value.instance, seq: value.seq, sessionId, agents };
}

/**
 * The host's identity guard for one conversation. A publication is accepted only when it names the session the
 * host bound and is newer than the last accepted one of the same publisher; a new publisher (a restarted process)
 * starts a new sequence. That last-writer rule relies on one invariant: at most one publisher writes to one RPC
 * stdout at a time (the first RPC main binding of the process). Everything else — a malformed text, another
 * session's signal, a replayed or reordered older publication, or a text before the host bound its session — is
 * dropped. The signal is trusted at the RPC stream's own level; it can only add Agents rows and child-transcript
 * read permissions for the ids it names.
 */
export class AgentLivenessGuard {
	#instance: string | null = null;
	#seq = 0;
	#last: readonly LiveAgent[] | null = null;

	/** The newest accepted list, re-applied after a resynchronisation cleared the roster. */
	get last(): readonly LiveAgent[] | null {
		return this.#last;
	}

	/** A replay gap may have lost a newer publication: never re-apply a list that could be stale. */
	forgetLast(): void {
		this.#last = null;
	}

	accept(text: unknown, boundSessionId: string | null): readonly LiveAgent[] | null {
		if (boundSessionId === null) return null;
		const publication = decodeAgentLiveness(text);
		if (publication === null || publication.sessionId !== boundSessionId) return null;
		if (publication.instance === this.#instance && publication.seq <= this.#seq) return null;
		this.#instance = publication.instance;
		this.#seq = publication.seq;
		this.#last = publication.agents;
		return publication.agents;
	}
}
