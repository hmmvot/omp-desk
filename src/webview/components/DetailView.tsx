import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import type { RunningAgent } from "../../chat/agents";
import type { ChatModel } from "../../chat/model";
import { agentActivityText, agentDescription, agentRow, AGENT_STATUS_ICON, runningAgentDescriptions, sortedAgents, todoGlyph, todoNoteMarker, todoSummary, TODO_STATUS_WORD } from "../../chat/hud-summary";
import { todoMatchesDescriptions } from "../../chat/todos";
import type { DetailTarget } from "../detail-target";
import type { ChatClient } from "../lib/chat-client";
import { chatBanner } from "../lib/chat-banner";
import { fmtDuration } from "../lib/format";
import { useAgentElapsed } from "../lib/live-clock";
import { AgentProgressView } from "./AgentProgress";
import { ChildTranscriptBody } from "./ChildTranscript";
import { useDetailOpener } from "./HudRows";
import { Markdown } from "./Markdown";

/** How often a live agent's tab re-reads the newest child rows. */
export const AGENT_REFRESH_MS = 2000;
const NO_PROGRESS: Record<string, unknown> = {};

/** The facts a detail tab renders; streaming deltas and transcript rows are not among them. */
interface DetailSlice extends Pick<ChatModel, "epoch" | "phase" | "code" | "readOnlyReason" | "todo" | "agents" | "agentActivity" | "agentAvailability"> {
	title: string;
}

function sliceOf(client: ChatClient): DetailSlice {
	const model = client.getSnapshot();
	return {
		epoch: model.epoch,
		phase: model.phase,
		code: model.code,
		readOnlyReason: model.readOnlyReason,
		todo: model.todo,
		agents: model.agents,
		agentActivity: model.agentActivity,
		agentAvailability: model.agentAvailability,
		title: model.header?.title ?? model.state?.sessionName ?? "omp session",
	};
}

/**
 * Every chat event reaches a detail tab, including token deltas; a view that re-rendered on each
 * would do work for nothing. The slice keeps its identity until one of these facts changes.
 */
function useDetailSlice(client: ChatClient): DetailSlice {
	const cached = useRef<DetailSlice | null>(null);
	const getSlice = useCallback((): DetailSlice => {
		const next = sliceOf(client);
		const previous = cached.current;
		if (previous !== null && (Object.keys(next) as (keyof DetailSlice)[]).every(key => Object.is(previous[key], next[key]))) return previous;
		cached.current = next;
		return next;
	}, [client]);
	return useSyncExternalStore(client.subscribe, getSlice, getSlice);
}

/** What a detail tab says about its session when the conversation is not live; `null` while it is. */
function EndedNote({ snapshot }: { snapshot: DetailSlice }): ReactNode {
	const banner = snapshot.phase === "live" ? null : chatBanner(snapshot);
	if (banner === null) return null;
	return <div className={`omp-notice omp-notice--${banner.level === "warn" ? "warning" : banner.level}`} role="status"><span className={`codicon codicon-${banner.icon}`} aria-hidden="true" /><span className="omp-notice-description">{banner.text}</span></div>;
}

function TodoDetail({ snapshot }: { snapshot: DetailSlice }): ReactNode {
	const phases = (snapshot.todo?.phases ?? []).filter(phase => phase.tasks.length > 0);
	const summary = todoSummary(phases);
	const descriptions = runningAgentDescriptions(snapshot.agents.values());
	return (
		<article className="omp-detail-body" aria-label="TODO">
			<h1 className="omp-detail-title">TODO{summary !== null && <span className="omp-detail-count" title={summary.title}> · {summary.title}</span>}</h1>
			{summary === null && <p className="omp-native-note">No TODO list in this session.</p>}
			{phases.map((phase, phaseIndex) => (
				<section key={`${phaseIndex}:${phase.name}`} className="omp-detail-phase">
					<h2>{phase.name}</h2>
					<ul className="omp-detail-tasks">
						{phase.tasks.map((task, taskIndex) => {
							const matched = task.status === "pending" && todoMatchesDescriptions(task.content, descriptions);
							const glyph = todoGlyph(task.status, matched);
							return (
								<li key={`${taskIndex}:${task.content}`} className={`omp-detail-task omp-hud-tone--${glyph.tone}`}>
									<div className="omp-detail-task-head">
										<span className={`codicon codicon-${glyph.icon}`} aria-hidden="true" />
										<span className="omp-detail-task-text">{glyph.struck ? <s>{task.content}</s> : task.content}</span>
										<span className="omp-detail-status">{TODO_STATUS_WORD[task.status]}{matched ? " · active agent match" : ""}</span>
									</div>
									{task.blocker !== undefined && <div className="omp-detail-blocker"><strong>Blocker: </strong>{task.blocker}</div>}
									{task.details !== undefined && <div className="omp-detail-section"><h3>Details</h3><Markdown text={task.details} /></div>}
									{task.notes !== undefined && task.notes.length > 0 && (
										<div className="omp-detail-section"><h3>Notes {todoNoteMarker(task.notes.length)}</h3><ul>{task.notes.map((note, noteIndex) => <li key={noteIndex}><Markdown text={note} /></li>)}</ul></div>
									)}
								</li>
							);
						})}
					</ul>
				</section>
			))}
		</article>
	);
}

function AgentsDetail({ snapshot }: { snapshot: DetailSlice }): ReactNode {
	const opener = useDetailOpener();
	const agents = sortedAgents(snapshot.agents);
	const elapsedOf = useAgentElapsed(snapshot.agents.values(), snapshot.phase === "live");
	return (
		<article className="omp-detail-body" aria-label="Agents">
			<h1 className="omp-detail-title">Agents<span className="omp-detail-count"> · {agents.length}</span></h1>
			{snapshot.agentAvailability === "unavailable" && <p className="omp-native-note" role="status">The native running-agent registry is unavailable.</p>}
			{agents.length === 0 && snapshot.agentAvailability !== "unavailable" && <p className="omp-native-note">No agents are running.</p>}
			<ul className="omp-detail-agents">
				{agents.map(agent => agentRow(agent, snapshot.agentActivity.get(agent.id))).map(row => {
					const agent = snapshot.agents.get(row.id);
					const elapsed = elapsedOf(row.id);
					return (
						<li key={row.id} className={`omp-hud-agent--${row.status}`}>
							<button type="button" className="omp-detail-agent" disabled={!opener.available} onClick={() => opener.open({ kind: "agent", agentId: row.id })}>
								<span className={`codicon codicon-${row.icon}`} aria-hidden="true" />
								<strong>{row.id}</strong>
								{row.badge !== "" && <span className="omp-hud-dim">{row.badge}</span>}
								<span className="omp-detail-status">{row.status}</span>
								{elapsed !== null && <span className="omp-hud-elapsed">{fmtDuration(elapsed)}</span>}
								{row.description !== "" && <span className="omp-detail-agent-line">{row.description}</span>}
								{row.activity !== "" && <span className="omp-detail-agent-line omp-hud-dim">{row.activity}</span>}
								<AgentProgressView progress={agent?.progress ?? NO_PROGRESS} activity={snapshot.agentActivity.get(row.id)} showActivity={false} showElapsed={false} elapsedMs={elapsed} />
							</button>
						</li>
					);
				})}
			</ul>
		</article>
	);
}

function AgentDetail({ client, snapshot, agentId }: { client: ChatClient; snapshot: DetailSlice; agentId: string }): ReactNode {
	// The registry drops an agent the moment it finishes; the tab keeps the last row it saw.
	const lastSeen = useRef<RunningAgent | null>(null);
	const current = snapshot.agents.get(agentId);
	if (current !== undefined) lastSeen.current = current;
	const agent = current ?? lastSeen.current;
	const live = current !== undefined && snapshot.phase === "live" && current.status === "running";
	const loading = snapshot.epoch === null || snapshot.phase === "starting" || snapshot.phase === "attaching" || snapshot.phase === "resyncing";
	const readChild = useCallback(async (id: string, options?: { fromByte?: number; beforeId?: string }) => {
		const page = await client.readSubagent(id, options);
		const phase = client.getSnapshot().phase;
		// A rejected read is not evidence that a running parent has stopped.
		return page.status === "unavailable" && page.reason === "not-live" && phase !== "stopped" && phase !== "view-only"
			? { status: "unavailable" as const, reason: "read-failed" as const }
			: page;
	}, [client]);
	const elapsedOf = useAgentElapsed(agent === null ? [] : [agent], current !== undefined && snapshot.phase === "live");
	const measured = agent === null ? null : elapsedOf(agent.id);
	// An agent dropped from the registry while still "running" has no further progress: its clock stops at the last value shown.
	const shown = useRef<number | null>(null);
	if (current !== undefined) shown.current = measured;
	const elapsed = current === undefined && agent?.status === "running" ? shown.current ?? measured : measured;
	const description = agent === null ? "" : agentDescription(agent);
	const assignment = agent?.assignment ?? "";
	return (
		<article className="omp-detail-body omp-detail-body--agent" aria-label={`Agent ${agentId}`}>
			<header className="omp-detail-agent-head">
				<h1 className="omp-detail-title">
					{agent !== null && <span className={`codicon codicon-${AGENT_STATUS_ICON[agent.status]}`} aria-hidden="true" />}
					<span>{agentId}</span>
					{agent !== null && agent.agent.trim() !== "" && agent.agent.trim() !== "task" && <span className="omp-hud-dim"> {agent.agent.trim()}</span>}
					<span className="omp-detail-status">{current !== undefined ? current.status : agent === null ? "not in the native registry" : "no longer in the native registry"}</span>
					{elapsed !== null && <span className="omp-hud-elapsed">{fmtDuration(elapsed)}</span>}
				</h1>
				{description !== "" && <div className="omp-detail-agent-line">{description}</div>}
				{agent !== null && (
					<div className="omp-detail-agent-line omp-hud-dim">
						<AgentProgressView progress={agent.progress ?? NO_PROGRESS} activity={snapshot.agentActivity.get(agentId)} showElapsed={false} elapsedMs={elapsed} />
						{agentActivityText(agent.progress, snapshot.agentActivity.get(agentId)) === "" && agent.progress === undefined && "No progress reported yet."}
					</div>
				)}
			</header>
			{loading
				? <div className="omp-native-note" role="status" aria-busy="true"><span className="codicon codicon-loading codicon-modifier-spin" aria-hidden="true" /> Loading child history…</div>
				: <ChildTranscriptBody key={agentId} subagentId={agentId} reader={readChild} depth={1} assignment={assignment} keepOnFailure {...(live ? { refreshMs: AGENT_REFRESH_MS } : {})} />}
		</article>
	);
}

/** The document of a detail tab: the conversation's own snapshot, read-only, narrowed to one target. */
export function DetailView({ client, target }: { client: ChatClient; target: DetailTarget }): ReactNode {
	const snapshot = useDetailSlice(client);
	const title = target.kind === "todo" ? "TODO" : target.kind === "agents" ? "Agents" : target.agentId;
	useEffect(() => {
		document.title = `${title} · ${snapshot.title}`;
	}, [title, snapshot.title]);
	return (
		<div className={`omp-detail omp-detail--${target.kind}`}>
			<EndedNote snapshot={snapshot} />
			{target.kind === "todo" && <TodoDetail snapshot={snapshot} />}
			{target.kind === "agents" && <AgentsDetail snapshot={snapshot} />}
			{target.kind === "agent" && <AgentDetail client={client} snapshot={snapshot} agentId={target.agentId} />}
		</div>
	);
}
