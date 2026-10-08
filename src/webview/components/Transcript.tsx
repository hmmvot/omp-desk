/**
 * Transcript view: committed session entries, the live streaming assistant
 * ghost, tool calls still executing on the host, and the output cards of slash
 * builtins the host handled.
 *
 * Ordering is the host's: entries arrive in arrival order and every frame that
 * mutates them replaces the array reference, so `memo` on a row only re-renders
 * when that row, or a tool result pairing into it, actually changed.
 *
 * Only the newest rows render: the model holds a window of the session, but opening
 * a long history paints a bounded tail that lands on the latest message, and
 * older rows are revealed a step at a time without moving what is on screen —
 * first the rows already loaded, then, when none are left, the next page the host
 * reads from disk. A tool result whose call row fell outside the window is shown
 * on its own card in its own place in the row order, and costs one of the same
 * bound's cards, since a result has no row of its own to be shown on.
 */
import { assistantPersistenceKey, entryMessage, userSkill, type AssistantMessage, type ChatEntry } from "../../chat/messages";
import type { ReactNode } from "react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ActiveTool, ChatPhase, DisplayTurn, PendingRow } from "../../chat/model";
import type { EphemeralItem, TranscriptPosition } from "../../chat/projection";
import type { AgentActivity, RunningAgent } from "../../chat/agents";
import type { MaintenanceState, RetryState } from "../../chat/events";
import type { SubagentReader } from "../../chat/subagent-transcript";
import { positionTranscript } from "../../chat/projection";
import { projectTranscript, type ProjectedTool, type TranscriptCard } from "../../chat/transcript";
import { isOverviewMessage, overviewMemberId, projectToolOverview, type DensityCard, type OverviewProjection } from "../../chat/tool-overview";
import { replyFooters, type ReplyFooter as ReplyFooterData } from "../../chat/reply-turns";
import { ReplyFooter } from "./ReplyFooter";
import { ToolOverview } from "./ToolOverview";
import { TRANSCRIPT_WINDOW_ROWS, pageTranscriptCards, windowTranscriptCards } from "../lib/transcript-window";
import { measuredTranscriptRows, presentationRowId } from "../lib/transcript-layout";
import { MeasuredRows, type RowViewport } from "./MeasuredRows";
import { TranscriptScrollController, type TranscriptScrollMode } from "../lib/transcript-scroll";
import { captureToolInteraction, heldToolInteractions, restoreToolInteraction, type ToolInteraction } from "../lib/tool-interaction";
import { NativeMessage } from "./NativeMessage";
import { AssistantContentView } from "./MessageContent";
import { ChildTranscript } from "./ChildTranscript";
import { ToolCard, type ToolCardProps } from "./ToolCard";
import { WorkingStatus } from "./WorkingStatus";

/** How long a requested older page may stay unanswered before the button offers to ask again. */
const OLDER_REPLY_TIMEOUT_MS = 8_000;

export interface TranscriptProps {
	entries: readonly ChatEntry[];
	stream: AssistantMessage | null;
	activeTools: ReadonlyMap<string, ActiveTool>;
	working: boolean;
	turnInProgress?: boolean;
	workingIntent?: string | null;
	phase: ChatPhase;
	waitingForAnswer?: boolean;
	/** Rows still on disk above `entries`; `0` when the window already starts at the session's start. */
	olderCount: number;
	/** Ask the host for the next page above `entries[0]`; `false` when nothing was sent. */
	onLoadOlder: () => boolean;
	/** Rows that ended live and whose durable entry has not arrived; an `unsaved` one is flagged. */
	pending: ReadonlyMap<string, PendingRow>;
	/** Output of slash builtins the host handled, oldest first. */
	cards: readonly EphemeralItem[];
	durableCount?: number;
	streamId?: string | null;
	streamPosition?: TranscriptPosition | null;
	retrySuppressedIds?: readonly string[];
	sealedSeq?: number;
	durablePositions?: ReadonlyMap<string, TranscriptPosition>;
	agents?: ReadonlyMap<string, RunningAgent>;
	model?: { id: string; name?: string; provider?: string } | null;
	agentActivity?: ReadonlyMap<string, AgentActivity>;
	reader?: SubagentReader;
	depth?: number;
	maintenance?: MaintenanceState | null;
	cwd?: string;
	retry?: RetryState | null;
	toolCallDetail?: "overview" | "detailed";
	conversationKey?: string;
	disclosures?: ReadonlyMap<string, boolean>;
	onDisclosureChange?: (key: string, value: boolean) => void;
	displayTurns?: readonly DisplayTurn[];
	settled?: boolean;
	asyncPaused?: boolean;
	pagedHistory?: boolean;
	footerByHost?: ReadonlyMap<string, ReplyFooterData>;
}


function Row({
	kind,
	flag,
	children,
}: {
	kind: "user" | "assistant" | "custom" | "marker";
	/** A caution shown above the row body (a pending row the host has not seen saved). */
	flag?: string;
	children: ReactNode;
}): ReactNode {
	return (
		<div className={`omp-row omp-row--${kind}`}>
			<div className="omp-body-block">
				{flag !== undefined && <span className="omp-chip omp-chip--warn"><span className="codicon codicon-warning" aria-hidden="true" />{flag}</span>}
				{children}
			</div>
		</div>
	);
}

/** The DOM consumes exactly the cards counted by the semantic window. */
export function TranscriptCardView({ card, props, autoExpanded }: { card: TranscriptCard; props: TranscriptProps; autoExpanded?: boolean }): ReactNode {
	const renderChild = (id: string) => <ChildTranscript subagentId={id} reader={props.reader} depth={(props.depth ?? 0) + 1} />;
	const toolProps = (tool: ProjectedTool): ToolCardProps => ({
		name: tool.call.name, callId: tool.call.id, args: tool.active?.args ?? tool.call.arguments,
		intent: tool.call.intent ?? tool.active?.intent, result: tool.result, status: tool.status,
		partialResult: tool.active?.partialResult, streamUpdate: tool.active?.streamUpdate,
		attachments: tool.attachments, agents: props.agents, agentActivity: props.agentActivity, renderChild, cwd: props.cwd,
		expanded: props.disclosures?.get(`call:${props.conversationKey ?? "chat"}:${tool.call.id}`) ?? false,
		onExpandedChange: value => props.onDisclosureChange?.(`call:${props.conversationKey ?? "chat"}:${tool.call.id}`, value),
		autoExpanded,
	});
	const unsaved = card.sourceIds.some(id => props.pending.get(id)?.unsaved === true);
	let body: ReactNode;
	switch (card.kind) {
		case "entry": {
			const key = `irc:${props.conversationKey ?? "chat"}:${card.id}`;
			body = <NativeMessage entry={card.entry} model={props.model} superseded={card.superseded} irc={{ expanded: props.disclosures?.get(key) ?? false, onChange: value => props.onDisclosureChange?.(key, value) }} />;
			break;
		}
		case "assistant": {
			const failed = !card.streaming && card.content.length === 0 && (card.message.stopReason === "error" || card.message.stopReason === "aborted");
			body = <><AssistantContentView content={card.content} streaming={card.streaming && !props.waitingForAnswer} bypassPacing={props.pagedHistory} />{failed && <div className={card.message.stopReason === "error" ? "omp-error" : "omp-warning"} role="status"><strong>{card.message.stopReason === "error" ? "Provider error" : "Aborted"}</strong>{card.message.errorMessage && <p>{card.message.errorMessage}</p>}</div>}</>;
			break;
		}
		case "recovery": body = <div className="omp-native-recovery"><strong>Recovered provider error</strong>{card.message.retryRecovery?.note && <p>{card.message.retryRecovery.note}</p>}</div>; break;
		case "tool": body = <ToolCard {...toolProps(card.tool)} />; break;
		case "results": body = <>{card.tools.map(tool => <ToolCard key={tool.call.id} {...toolProps(tool)} />)}</>; break;
	}
	const message = card.kind === "entry" ? entryMessage(card.entry) : null;
	return <Row kind={message?.role === "user" && !message.synthetic || message?.role === "custom" && userSkill(message) !== null ? "user" : "assistant"} flag={unsaved ? "not yet saved" : undefined}>{body}{props.footerByHost?.has(card.id) && <ReplyFooter reply={props.footerByHost.get(card.id)!} />}</Row>;
}

export function Transcript(props: TranscriptProps): ReactNode {
	const { entries, stream, activeTools, working, phase, olderCount, onLoadOlder, pending, cards } = props;

	/**
	 * The oldest row the reader is holding, or null while the view follows the
	 * tail. Holding it is what keeps a live append from sliding rows out from
	 * under what is being read; a transcript that no longer contains it — a
	 * different session — opens on its newest rows again.
	 */
	const [pinnedTopId, setPinnedTopId] = useState<string | null>(null);
	const [pageEndId, setPageEndId] = useState<string | null>(null);
	const [heldPageEndId, setHeldPageEndId] = useState<string | null>(null);
	const controllerRef = useRef<TranscriptScrollController | null>(null);
	const previousPaged = useRef(Boolean(props.pagedHistory));
	const activatingPaged = Boolean(props.pagedHistory) && !previousPaged.current;
	const { rows, topId, olderRows, earlierTopId, canonical, page } = useMemo(() => {
		const live = stream && props.streamId && props.streamPosition ? { message: stream, messageId: props.streamId, position: props.streamPosition } : null;
		const positioned = positionTranscript(entries, props.durableCount ?? entries.length - pending.size, pending, cards, live, props.durablePositions);
		const canonical = projectTranscript(positioned, {
			pending, activeTools, working, stream: live === null ? stream : null, streamId: props.streamId ?? (stream === null ? null : "stream"),
			retrySuppressedIds: props.retrySuppressedIds, sealedSeq: props.sealedSeq, cwd: props.cwd,
		});
		let end = pageEndId ?? heldPageEndId;
		const anchor = activatingPaged ? controllerRef.current?.anchor : null;
		if (anchor) {
			const position = canonical.findIndex(card => card.sourceIds.some(source => anchor.sources.includes(source)) || card.kind === "tool" && anchor.sources.includes(`call:${card.tool.call.id}`));
			if (position >= 0) end = canonical[Math.min(canonical.length - 1, position + TRANSCRIPT_WINDOW_ROWS - 1)]!.id;
		}
		const page = pageTranscriptCards(canonical, TRANSCRIPT_WINDOW_ROWS, end);
		const window = props.pagedHistory ? page : windowTranscriptCards(canonical, TRANSCRIPT_WINDOW_ROWS, pinnedTopId ?? (previousPaged.current ? page.topId : null));
		return { ...window, canonical, page };
	}, [entries, pending, cards, pinnedTopId, activeTools, working, stream, props.durableCount, props.streamId, props.streamPosition, props.retrySuppressedIds, props.sealedSeq, props.cwd, props.durablePositions, props.pagedHistory, pageEndId, heldPageEndId, activatingPaged]);

	const overviewRef = useRef<OverviewProjection | undefined>(undefined);
	const namespace = props.conversationKey ?? "chat";
	const overview = useMemo(() => projectToolOverview(rows, namespace, overviewRef.current, props.cwd), [rows, namespace, props.cwd]);
	overviewRef.current = overview;
	const footerByHost = useMemo(() => replyFooters(rows, { displayTurns: props.displayTurns, working, settled: props.settled ?? true, asyncPaused: props.asyncPaused ?? false, phase }),
		[rows, props.displayTurns, working, props.settled, props.asyncPaused, phase]);
	const disclosures = useRef(new Map<string, boolean>());
	const [disclosureRevision, redrawDisclosures] = useState(0);
	for (const [old, current] of overview.redirects) {
		if (disclosures.current.has(old) && !disclosures.current.has(current)) disclosures.current.set(current, disclosures.current.get(old)!);
		disclosures.current.delete(old);
	}
	const presentationProps: TranscriptProps = { ...props, footerByHost, disclosures: disclosures.current, onDisclosureChange: (key, value) => { controllerRef.current?.retain(); disclosures.current.set(key, value); redrawDisclosures(version => version + 1); } };

	const rootRef = useRef<HTMLDivElement | null>(null);
	const contentRef = useRef<HTMLDivElement | null>(null);
	const previousDensity = useRef(props.toolCallDetail);
	const interactionNamespace = useRef(namespace);
	const forcedCalls = useRef<ReadonlyMap<string, boolean>>(new Map());
	const densityInteraction = useRef<ToolInteraction | null>(null);
	const [, redrawInteraction] = useState(0);
	if (interactionNamespace.current !== namespace) {
		interactionNamespace.current = namespace; forcedCalls.current = new Map(); densityInteraction.current = null;
		previousDensity.current = props.toolCallDetail;
	} else if (previousDensity.current !== props.toolCallDetail && rootRef.current) {
		controllerRef.current?.retain();
		densityInteraction.current = captureToolInteraction(rootRef.current, overview.runs);
		forcedCalls.current = densityInteraction.current.calls;
	}
	const measuredRef = useRef<HTMLDivElement | null>(null);
	const [viewport, setViewport] = useState<RowViewport>({ top: 0, height: 600, width: 840 });
	const [readerMode, setReaderMode] = useState<TranscriptScrollMode>("following");
	const [anchorNotice, setAnchorNotice] = useState("");
	const messageAliases = useRef(new Map<string, string>());
	const aliasNamespace = useRef(namespace);
	if (aliasNamespace.current !== namespace) { messageAliases.current.clear(); aliasNamespace.current = namespace; }
	const { groupByCall, autoCalls, densityRows, heldRunIds } = useMemo(() => {
		const groupByCall = new Map<string, OverviewProjection["runs"][number]>();
		const autoCalls = new Map(forcedCalls.current);
		const heldRunIds = new Set<string>();
		const densityRows: DensityCard[] = [];
		if (props.toolCallDetail === "detailed") densityRows.push(...rows);
		else for (const card of overview.rows) {
			densityRows.push(card);
			if (card.kind !== "run") continue;
			const expanded = disclosures.current.get(card.id) ?? false;
			const live = new Set(card.liveEditIds);
			for (const member of card.members) {
				const id = overviewMemberId(member);
				if (forcedCalls.current.has(id)) heldRunIds.add(card.id);
				if (live.has(id)) autoCalls.set(id, true);
				if (!expanded && !live.has(id) && !forcedCalls.current.has(id)) continue;
				groupByCall.set(id, card);
				densityRows.push(member);
			}
		}
		return { groupByCall, autoCalls, densityRows, heldRunIds };
	}, [rows, overview, props.toolCallDetail, disclosureRevision, forcedCalls.current]);
	const sourceBindings = useMemo(() => {
		const sources = new Map<string, readonly string[]>();
		const order: string[] = [];
		for (const card of rows) {
			// Prefer row-specific identities over the shared entry of a multi-call reply.
			const aliases = [card.id, ...card.sourceIds.filter(source => source !== card.id)];
			if (card.kind === "tool") aliases.unshift(`call:${card.tool.call.id}`);
			if (isOverviewMessage(card)) aliases.unshift(`call:${overviewMemberId(card)}`);
			if (card.kind === "assistant") {
				const key = assistantPersistenceKey(card.message);
				const messageId = pending.get(card.sourceIds[0]!)?.messageId ?? (card.message === stream ? props.streamId : null) ?? messageAliases.current.get(key);
				if (messageId) {
					if (!card.streaming) messageAliases.current.set(key, messageId);
					aliases.unshift(`message:${messageId}:slot:${card.message.content.indexOf(card.content[0]!)}`);
				}
			}
			sources.set(card.id, aliases);
			sources.set(presentationRowId(card, namespace), aliases);
			order.push(...aliases);
		}
		for (const run of overview.runs) sources.set(run.id, disclosures.current.get(run.id) ? [run.id] : [run.id, ...run.members.flatMap(card => sources.get(card.id) ?? card.sourceIds)]);
		return { sources, order };
	}, [rows, overview, pending, stream, props.streamId, disclosureRevision]);
	let bodyHeld = false;
	for (const inBody of forcedCalls.current.values()) if (inBody) { bodyHeld = true; break; }
	const bindingsRef = useRef({ sourceBindings, topId, bodyHeld });
	bindingsRef.current = { sourceBindings, topId, bodyHeld };
	const measuredRows = useMemo(() => measuredTranscriptRows(densityRows, sourceBindings.sources, viewport.width, disclosures.current, namespace, autoCalls), [densityRows, sourceBindings, viewport.width, disclosureRevision, namespace, autoCalls]);
	const updateViewport = (): void => {
		const root = rootRef.current, measured = measuredRef.current;
		if (!root || !measured) return;
		const next = { top: Math.max(0, root.getBoundingClientRect().top - measured.getBoundingClientRect().top), height: root.clientHeight, width: measured.clientWidth };
		setViewport(previous => Math.abs(previous.top - next.top) < 0.5 && previous.height === next.height && previous.width === next.width ? previous : next);
	};
	const viewportCallback = useRef(updateViewport); viewportCallback.current = updateViewport;
	useLayoutEffect(() => {
		if (previousPaged.current === Boolean(props.pagedHistory)) return;
		if (props.pagedHistory) {
			if (controllerRef.current?.anchor) setPageEndId(page.endId);
		} else { setPinnedTopId(page.topId); setPageEndId(null); setHeldPageEndId(null); }
		previousPaged.current = Boolean(props.pagedHistory);
	}, [props.pagedHistory, page.endId, page.topId]);
	useLayoutEffect(() => {
		previousDensity.current = props.toolCallDetail;
		if (rootRef.current && densityInteraction.current) restoreToolInteraction(rootRef.current, densityInteraction.current);
		densityInteraction.current = null;
	}, [props.toolCallDetail]);
	useEffect(() => {
		const update = (): void => {
			if (!rootRef.current || densityInteraction.current) return;
			const interaction = captureToolInteraction(rootRef.current, overviewRef.current?.runs ?? []);
			const next = heldToolInteractions(rootRef.current, interaction.calls);
			if (next.size === forcedCalls.current.size && [...next].every(([id, body]) => forcedCalls.current.get(id) === body)) return;
			if (next.size > 0) controllerRef.current?.retain();
			forcedCalls.current = next; redrawInteraction(version => version + 1); controllerRef.current?.layout();
		};
		document.addEventListener("selectionchange", update); document.addEventListener("focusin", update); document.addEventListener("focusout", update);
		return () => { document.removeEventListener("selectionchange", update); document.removeEventListener("focusin", update); document.removeEventListener("focusout", update); };
	}, []);
	useLayoutEffect(() => {
		const root = rootRef.current, content = contentRef.current;
		if (!root || !content) return;
		disclosures.current.clear();
		setPinnedTopId(null);
		setPageEndId(null); setHeldPageEndId(null);
		setReaderMode("following");
		setAnchorNotice("");
		if ((props.depth ?? 0) > 0) return;
		const controller = new TranscriptScrollController(root, content, {
			sources: key => bindingsRef.current.sourceBindings.sources.get(key) ?? [],
			order: () => bindingsRef.current.sourceBindings.order,
			changed: mode => {
				setReaderMode(mode);
				if (mode === "detached") setPinnedTopId(current => current ?? bindingsRef.current.topId);
			},
			viewport: () => viewportCallback.current(),
			reset: () => setAnchorNotice("Your previous position changed; showing the nearest surviving message."),
			held: () => bindingsRef.current.bodyHeld,
		});
		controllerRef.current = controller;
		return () => { controller.dispose(); controllerRef.current = null; };
	}, [namespace, props.depth]);
	useLayoutEffect(() => controllerRef.current?.layout(), [rows, overview, phase, props.toolCallDetail, props.pagedHistory, disclosureRevision]);

	// A page requested from the host is in flight from the click until the rows above the
	// old top arrive (the top changes), the host says nothing is left (the count changes),
	// or the conversation is re-based; a reply that never comes re-arms the button.
	const topEntryId = entries[0]?.id ?? null;
	const [awaitingOlder, setAwaitingOlder] = useState<string | null>(null);
	useLayoutEffect(() => {
		if (awaitingOlder === null) return;
		if ((topEntryId ?? "") === awaitingOlder) return;
		setAwaitingOlder(null);
		if (topEntryId !== null) {
			// Rows arrived above the old top: hold the new top, so they mount, and the
			// reveal anchor puts the reader back where they were.
			setPinnedTopId(topEntryId);
		}
	}, [topEntryId, awaitingOlder]);
	useEffect(() => {
		if (awaitingOlder === null) return;
		const timer = setTimeout(() => setAwaitingOlder(null), OLDER_REPLY_TIMEOUT_MS);
		return () => clearTimeout(timer);
	}, [awaitingOlder]);
	useEffect(() => {
		setAwaitingOlder(null);
	}, [olderCount, phase]);


	const loading = phase === "starting" || phase === "attaching" || phase === "resyncing";
	// One reveal step, capped by how much history is actually left above the window.
	const step = Math.min(olderRows, TRANSCRIPT_WINDOW_ROWS);

	return (
		<div className="omp-transcript-frame">
		<div ref={rootRef} className="omp-transcript" role="region" aria-label="Conversation transcript" onKeyDown={event => {
			if (event.key !== "Escape" || event.defaultPrevented) return;
			const element = event.target instanceof Element ? event.target : null;
			const id = element?.closest<HTMLElement>("[data-run-id]")?.dataset.runId ?? element?.closest<HTMLElement>(".omp-tool-overview")?.dataset.sourceId;
			if (!id || !disclosures.current.get(id)) return;
			const head = [...(rootRef.current?.querySelectorAll<HTMLElement>(".omp-tool-overview") ?? [])].find(group => group.dataset.sourceId === id)?.querySelector<HTMLButtonElement>(".omp-overview-head");
			if (!head) return;
			event.preventDefault(); event.stopPropagation(); head.focus({ preventScroll: true }); presentationProps.onDisclosureChange?.(id, false);
		}}>
			<div ref={contentRef} className="omp-transcript-content">
			{entries.length === 0 && stream === null && !working && (
				<div className="omp-empty">{loading ? "joining the session…" : "no activity yet"}</div>
			)}
			{props.pagedHistory ? <nav className="omp-history-pages" aria-label="History pages">
				<button type="button" disabled={page.previousEndId === null || heldPageEndId !== null} onClick={() => { setPageEndId(page.previousEndId); controllerRef.current?.pageStart(); }}>Previous page</button>
				<span>{rows.length} messages on this page</span>
				<button type="button" disabled={page.nextEndId === null || heldPageEndId !== null} onClick={() => { const latest = page.nextEndId === canonical.at(-1)?.id; setPageEndId(latest ? null : page.nextEndId); if (latest) controllerRef.current?.jump(); else controllerRef.current?.pageStart(); }}>Next page</button>
				{page.newCount > 0 && <button type="button" disabled={heldPageEndId !== null} onClick={() => { setPageEndId(null); controllerRef.current?.jump(); }}>{page.newCount} new activities · Latest</button>}
			</nav> : null}
			{!props.pagedHistory && earlierTopId !== null ? (
				<div className="omp-earlier">
					<button
						type="button"
						onClick={() => {
							controllerRef.current?.hold();
							setPinnedTopId(earlierTopId);
						}}
					>
						load {step} earlier messages ({olderRows + olderCount} older)
					</button>
				</div>
			) : (
				olderCount > 0 && (!props.pagedHistory || page.previousEndId === null) && (
					<div className="omp-earlier">
						<button
							type="button"
							disabled={awaitingOlder !== null}
							onClick={() => {
								controllerRef.current?.hold();
								if (onLoadOlder()) setAwaitingOlder(topEntryId ?? "");
							}}
						>
							{awaitingOlder !== null ? "loading earlier messages…" : `load earlier messages (${olderCount} older)`}
						</button>
					</div>
				)
			)}
			<MeasuredRows rows={measuredRows} context={`${namespace}:${props.toolCallDetail}`} viewport={viewport}
				elementRef={measuredRef} following={readerMode === "following" && !bodyHeld} anchor={controllerRef.current?.anchor} paged={props.pagedHistory || (props.depth ?? 0) > 0} forcedSources={forcedCalls.current} forcedRows={heldRunIds}
				onLayout={() => controllerRef.current?.layout()} onInteraction={held => { if (props.pagedHistory) setHeldPageEndId(held ? page.endId : null); }}
				renderRow={index => { const card = densityRows[index]!; if (card.kind === "run") return <ToolOverview run={card} expanded={disclosures.current.get(card.id) ?? false}
					onExpandedChange={value => presentationProps.onDisclosureChange?.(card.id, value)} />;
					const run = card.kind === "tool" || isOverviewMessage(card) ? groupByCall.get(overviewMemberId(card)) : undefined;
					const body = <TranscriptCardView card={card} props={presentationProps} autoExpanded={card.kind === "tool" && autoCalls.get(card.tool.call.id) === true} />;
					// One wrapper element whether the call is flat or a group member, so a call that gains or loses its group keeps its DOM and focus.
					if (card.kind !== "tool" && !isOverviewMessage(card) || props.toolCallDetail === "detailed") return body;
					return run ? <div className="omp-overview-member" data-run-id={run.id} role="group" aria-label={run.summary}>{body}</div> : <div>{body}</div>;
				}} />
			<WorkingStatus working={props.turnInProgress ?? working} intent={props.workingIntent}
				waitingForAnswer={props.waitingForAnswer} maintenance={props.maintenance}
				startedAt={props.displayTurns?.at(-1)?.complete === false ? props.displayTurns.at(-1)?.startedAt : null} />
			</div>
		</div>
		{readerMode === "detached" && <button type="button" className="omp-jump-latest" aria-label="Jump to latest" title="Jump to latest" onClick={() => {
			setPinnedTopId(null); setPageEndId(null); controllerRef.current?.jump();
		}}><i className="codicon codicon-arrow-down" aria-hidden="true" /></button>}
		<span className="omp-sr-only" role="status">{anchorNotice}</span>
		</div>
	);
}
