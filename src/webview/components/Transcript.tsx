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
import type { BackgroundWait } from "../../chat/background-wait";
import { assistantPersistenceKey, entryMessage, userSkill, type AssistantMessage, type ChatEntry } from "../../chat/messages";
import type { ReactNode } from "react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ChatPhase, DisplayTurn } from "../../chat/model";
import type { ActiveTool, PendingRow } from "../../chat/pending";
import type { EphemeralItem, TranscriptPosition } from "../../chat/projection";
import type { AgentActivity, RunningAgent } from "../../chat/agents";
import type { MaintenanceState, RetryState } from "../../chat/events";
import type { SubagentReader } from "../../chat/subagent-transcript";
import { positionTranscript } from "../../chat/projection";
import { projectTranscript, type ProjectedTool, type TranscriptCard } from "../../chat/transcript";
import { splitClearedHistory, type ClearedHistorySplit } from "../../chat/cleared-history";
import { CLEAR_REFUSAL_SENTENCES } from "../../chat/clear";
import { isOverviewMessage, overviewMemberId, projectToolOverview, type DensityCard, type OverviewProjection } from "../../chat/tool-overview";
import { replyFooters, type ReplyFooter as ReplyFooterData } from "../../chat/reply-turns";
import { ReplyFooter } from "./ReplyFooter";
import { ToolOverview } from "./ToolOverview";
import { TRANSCRIPT_WINDOW_ROWS, pageTranscriptCards, windowTranscriptCards } from "../../chat/transcript-window";
import { measuredTranscriptRows, presentationRowId } from "../lib/transcript-layout";
import { MeasuredRows, type RowViewport } from "./MeasuredRows";
import { TranscriptScrollController, type TranscriptScrollMode } from "../lib/transcript-scroll";
import { captureToolInteraction, heldToolInteractions, restoreToolInteraction, type ToolInteraction } from "../lib/tool-interaction";
import { focusAfter } from "../lib/focus-after";
import { isHeadNavigation, nextHead } from "../lib/tool-navigation";
import { NativeMessage } from "./NativeMessage";
import { EmptyState } from "./EmptyState";
import { AssistantContentView } from "./MessageContent";
import { NativeDisclosure } from "./NativeDisclosure";
import { ToolCard, type ToolCardProps } from "./ToolCard";
import { WorkingStatus } from "./WorkingStatus";
import { CopyButton } from "./CopyButton";
import { CHAT_TEXT_MENU_CONTEXT } from "../../shared/quote-menu";
import { sentTextOf } from "../lib/file-block-rows";
import { requestPanelAction } from "../lib/panel-actions";
import { clearToolDisclosures, getTranscriptToggles, subscribeTranscriptToggles, withToolDefault } from "../lib/transcript-toggles";
import { peekToolView, recordObservedToolMs, resetAllToolViews, useToolViewVersion } from "../lib/tool-view-state";
import type { BranchPoint } from "../../chat/rewind";
import { BranchPointMarker } from "./Rewind";
import { useTranscriptFind } from "./TranscriptFind";
import { findIdOf } from "../lib/transcript-find";

/** How long a requested older page may stay unanswered before the button offers to ask again. */
const OLDER_REPLY_TIMEOUT_MS = 8_000;

export interface TranscriptProps {
	entries: readonly ChatEntry[];
	unconfirmedClearBoundaryId?: string | null;
	stream: AssistantMessage | null;
	activeTools: ReadonlyMap<string, ActiveTool>;
	working: boolean;
	turnInProgress?: boolean;
	/** Set while only background work keeps the turn open; replaces the intent and the whole-turn timer. */
	backgroundWait?: BackgroundWait | null;
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
	/** Renders the read-only child transcript of a subagent at `depth`; the page and `ChildTranscript` supply it so this module does not import them. */
	renderChild?: (subagentId: string, depth: number) => ReactNode;
	depth?: number;
	maintenance?: MaintenanceState | null;
	cwd?: string;
	retry?: RetryState | null;
	toolCallDetail?: "overview" | "detailed";
	/** The thinking level the empty state names beside the model. */
	thinkingLevel?: string | null;
	conversationKey?: string;
	disclosures?: ReadonlyMap<string, boolean>;
	onDisclosureChange?: (key: string, value: boolean) => void;
	displayTurns?: readonly DisplayTurn[];
	settled?: boolean;
	asyncPaused?: boolean;
	pagedHistory?: boolean;
	footerByHost?: ReadonlyMap<string, ReplyFooterData>;
	/** The failed or aborted last reply that offers Retry, or `null`. */
	retryTailId?: string | null;
	/** Rewind (ADR-0051): the hover action, the picked prompt and the branch markers. Absent in child transcripts. */
	rewind?: TranscriptRewind;
	/** Derived from `rewind`: cards after the picked prompt (dimmed), and the branch points shown after each card. */
	rewindDimmed?: ReadonlySet<string>;
	branchesByCard?: ReadonlyMap<string, readonly BranchPoint[]>;
	/** Counts the user's own submissions from the composer; each increase returns the view to the tail and follows it again, as Jump to latest does. */
	followLatest?: number;
	/** `false` for rows Find in the conversation does not search (the history shown under a context reset). */
	findable?: boolean;
}

export interface TranscriptRewind {
	/** Prompts that can be rewound to: durable user messages of the loaded branch. Empty hides the action. */
	targets: ReadonlySet<string>;
	/** The prompt being picked, or null. */
	selectedId: string | null;
	branchPoints: readonly BranchPoint[];
	/** The hover action, or a click on a prompt while picking: select it, or rewind when it is already selected. */
	onPick(entryId: string): void;
	/** Switch to the branch whose tip is `tipId`; absent while that is unavailable. */
	onSwitch?(tipId: string): void;
}


function Row({
	kind,
	flag,
	actions,
	rewindState,
	onPick,
	findId,
	children,
}: {
	kind: "user" | "assistant" | "custom" | "marker";
	/** A caution shown above the row body (a pending row the host has not seen saved). */
	flag?: string;
	/** Hover actions of the row (`.omp-row-actions`): Copy and Rewind on the user's messages. */
	actions?: ReactNode;
	/** While picking a rewind target: the selected prompt, or a row that would leave the branch. */
	rewindState?: "selected" | "dimmed";
	/** While picking, a click on a rewindable prompt picks it. */
	onPick?: () => void;
	/** Find in the conversation searches this row under this id (`lib/transcript-find.ts`); absent for rows it does not search. */
	findId?: string;
	children: ReactNode;
}): ReactNode {
	return (
		<div className={`omp-row omp-row--${kind}${rewindState === undefined ? "" : ` omp-row--rewind-${rewindState}`}`} data-find-id={findId} aria-current={rewindState === "selected" ? "true" : undefined} onClick={onPick === undefined ? undefined : event => {
			if (event.target instanceof Element && event.target.closest("a,button")) return;
			onPick();
		}}>
			<div className="omp-body-block">
				{flag !== undefined && <span className="omp-chip omp-chip--warn"><span className="codicon codicon-warning" aria-hidden="true" />{flag}</span>}
				{children}
			</div>
			{actions}
		</div>
	);
}

/** The DOM consumes exactly the cards counted by the semantic window. */
export function TranscriptCardView({ card, props, autoExpanded, clearedHistory }: { card: TranscriptCard; props: TranscriptProps; autoExpanded?: boolean; clearedHistory?: ReactNode }): ReactNode {
	const renderChild = props.renderChild === undefined ? undefined : (id: string) => props.renderChild!(id, (props.depth ?? 0) + 1);
	const toolProps = (tool: ProjectedTool): ToolCardProps => ({
		name: tool.call.name, callId: tool.call.id, args: tool.active?.args ?? tool.call.arguments,
		intent: tool.call.intent ?? tool.active?.intent, result: tool.result, status: tool.status,
		partialResult: tool.active?.partialResult, streamUpdate: tool.active?.streamUpdate,
		attachments: tool.attachments, agents: props.agents, agentActivity: props.agentActivity, renderChild, cwd: props.cwd,
		expanded: props.disclosures?.get(`call:${props.conversationKey ?? "chat"}:${tool.call.id}`) ?? false,
		onExpandedChange: value => props.onDisclosureChange?.(`call:${props.conversationKey ?? "chat"}:${tool.call.id}`, value),
		viewKey: `call:${props.conversationKey ?? "chat"}:${tool.call.id}`, startedAt: tool.active?.startedAt ?? tool.startedAt, endedAt: tool.result?.timestamp,
		autoExpanded,
	});
	const unsaved = card.sourceIds.some(id => props.pending.get(id)?.unsaved === true);
	let body: ReactNode;
	switch (card.kind) {
		case "entry": {
			const key = `irc:${props.conversationKey ?? "chat"}:${card.id}`;
			body = clearedHistory ?? (card.entry.type === "reset_boundary" && props.unconfirmedClearBoundaryId === card.entry.id
				? <div className="omp-warning" role="status">{CLEAR_REFUSAL_SENTENCES.unconfirmed}</div>
				: <NativeMessage entry={card.entry} model={props.model} superseded={card.superseded} irc={{ expanded: props.disclosures?.get(key) ?? false, onChange: value => props.onDisclosureChange?.(key, value) }} />);
			break;
		}
		case "assistant": {
			const failed = !card.streaming && card.content.length === 0 && (card.message.stopReason === "error" || card.message.stopReason === "aborted");
			const retry = card.id === props.retryTailId && <button type="button" className="omp-retry-turn" title="Retry: run the failed or aborted turn again (F5)" onClick={() => requestPanelAction("retry-turn")}><span className="codicon codicon-refresh" aria-hidden="true" />Retry</button>;
			const failure = card.message.errorMessage;
			// One line each: an aborted reply is a muted note with the reply's own message, a provider error says what it is and why inline.
			const notice = !failed ? null : card.message.stopReason === "error"
				? <div className="omp-error omp-turn-error" role="status"><strong>Provider error</strong>{failure && <span>{failure}</span>}</div>
				: <div className="omp-turn-aborted" role="status"><span className="codicon codicon-circle-slash" aria-hidden="true" /><span>{failure || "Aborted"}</span></div>;
			body = <><AssistantContentView content={card.content} streaming={card.streaming && !props.waitingForAnswer} bypassPacing={props.pagedHistory} />{notice}{retry}</>;
			break;
		}
		case "recovery": body = <div className="omp-native-recovery"><strong>Recovered provider error</strong>{card.message.retryRecovery?.note && <p>{card.message.retryRecovery.note}</p>}</div>; break;
		case "tool": body = <ToolCard {...toolProps(card.tool)} />; break;
		case "results": body = <>{card.tools.map(tool => <ToolCard key={tool.call.id} {...toolProps(tool)} />)}</>; break;
	}
	const message = card.kind === "entry" ? entryMessage(card.entry) : null;
	const user = message?.role === "user" && !message.synthetic;
	// A message that carries files copies its text as sent, markers included and blocks left out; each row copies its own file.
	const copyText = user ? sentTextOf(message.content) : "";
	const rewind = props.rewind;
	const rewindId = rewind !== undefined && card.kind === "entry" && user && rewind.targets.has(card.entry.id) ? card.entry.id : null;
	const copy = copyText.trim().length > 0 ? <CopyButton text={copyText} label="Copy message" /> : null;
	const actions = copy !== null || rewindId !== null ? (
		<div className="omp-row-actions">
			{copy}
			{rewindId !== null && <button type="button" className="omp-copy-button" aria-label="Rewind to here" title="Rewind to here: edit this message and send it again" onClick={event => { event.stopPropagation(); rewind!.onPick(rewindId); }}>
				<span className="codicon codicon-discard" aria-hidden="true" />
			</button>}
		</div>
	) : undefined;
	const picking = rewind?.selectedId != null;
	const rewindState = !picking ? undefined : rewindId !== null && rewindId === rewind.selectedId ? "selected" : props.rewindDimmed?.has(card.id) ? "dimmed" : undefined;
	const points = props.branchesByCard?.get(card.id);
	return (
		<Row kind={user || message?.role === "custom" && userSkill(message) !== null ? "user" : "assistant"} flag={unsaved ? "not yet saved" : undefined} actions={actions}
			findId={(props.depth ?? 0) === 0 && props.findable !== false && (user || card.kind === "assistant" || card.kind === "tool") ? findIdOf(card) : undefined}
			rewindState={rewindState} onPick={picking && rewindId !== null ? () => rewind!.onPick(rewindId) : undefined}>
			{body}
			{props.footerByHost?.has(card.id) && <ReplyFooter reply={props.footerByHost.get(card.id)!} />}
			{points?.map(point => <BranchPointMarker key={point.entryId ?? "root"} point={point} onSwitch={rewind?.onSwitch} />)}
		</Row>
	);
}

/** Mounted only while open: dropped history never participates in the live transcript's projection or actions. */
function ClearedHistoryCards({ entries, props }: { entries: readonly ChatEntry[]; props: TranscriptProps }): ReactNode {
	const cards = useMemo(() => projectTranscript(entries, { cwd: props.cwd }), [entries, props.cwd]);
	const historyProps: TranscriptProps = {
		entries, stream: null, activeTools: new Map(), working: false, phase: props.phase, olderCount: 0,
		onLoadOlder: () => false, pending: new Map(), cards: [], pagedHistory: true, findable: false,
		model: props.model, cwd: props.cwd, renderChild: props.renderChild, depth: props.depth,
		agents: props.agents, agentActivity: props.agentActivity, conversationKey: props.conversationKey,
		disclosures: props.disclosures, onDisclosureChange: props.onDisclosureChange,
	};
	return <div className="omp-cleared-history-cards">{cards.map(card => <TranscriptCardView key={card.id} card={card} props={historyProps} />)}</div>;
}

function ClearedHistory({ history, props, earlier }: { history: ClearedHistorySplit; props: TranscriptProps; earlier: ReactNode }): ReactNode {
	const key = `cleared:${props.conversationKey ?? "chat"}:${history.boundary.id}`;
	return <section className="omp-native-summary omp-native-summary--divider omp-cleared-history">
		<NativeDisclosure title={<span className="omp-native-summary-label">{history.summary}</span>}
			expanded={props.disclosures?.get(key) ?? false} onExpandedChange={value => props.onDisclosureChange?.(key, value)}>
			{earlier}
			<ClearedHistoryCards entries={history.before} props={props} />
		</NativeDisclosure>
	</section>;
}

export function Transcript(props: TranscriptProps): ReactNode {
	const { entries, stream, activeTools, working, phase, olderCount, onLoadOlder, pending, cards } = props;
	// A call this page watched run has an exact duration, which its head gist shows instead of an approximation from timestamps.
	const watchedTools = useRef(new Map<string, number>());
	useEffect(() => {
		const now = Date.now();
		for (const [id, startedAt] of watchedTools.current) if (!activeTools.has(id)) { recordObservedToolMs(id, now - startedAt); watchedTools.current.delete(id); }
		// Only a call whose start was seen has a measurable duration: one first seen at an update began earlier than `startedAt` says.
		for (const tool of activeTools.values()) if (tool.startObserved === true && !watchedTools.current.has(tool.toolCallId)) watchedTools.current.set(tool.toolCallId, tool.startedAt);
	}, [activeTools]);

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
	const { rows, topId, olderRows, earlierTopId, canonical, page, cleared } = useMemo(() => {
		const live = stream && props.streamId && props.streamPosition ? { message: stream, messageId: props.streamId, position: props.streamPosition } : null;
		const positioned = positionTranscript(entries, props.durableCount ?? entries.length - pending.size, pending, cards, live, props.durablePositions);
		const cleared = splitClearedHistory(positioned, olderCount);
		const canonical = projectTranscript(cleared?.after ?? positioned, {
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
		return { ...window, canonical, page, cleared };
	}, [entries, pending, cards, pinnedTopId, activeTools, working, stream, olderCount, props.durableCount, props.streamId, props.streamPosition, props.retrySuppressedIds, props.sealedSeq, props.cwd, props.durablePositions, props.pagedHistory, pageEndId, heldPageEndId, activatingPaged]);

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
	// The tools toggle (`Ctrl+O`) is a default: a press forgets every tool block's own state, keeping the reader's
	// place, and a block opened or closed afterwards keeps its own state until the next press.
	const toggles = useSyncExternalStore(subscribeTranscriptToggles, getTranscriptToggles);
	const appliedToggles = useRef(toggles.generation);
	if (appliedToggles.current !== toggles.generation) {
		appliedToggles.current = toggles.generation;
		controllerRef.current?.retain();
		clearToolDisclosures(disclosures.current);
	}
	useEffect(() => { if (toggles.generation > 0) resetAllToolViews(); }, [toggles.generation]);
	const shown = useMemo(() => withToolDefault(disclosures.current, toggles.tools), [toggles.tools, toggles.generation]);
	// A failed or aborted last reply offers Retry (the TUI's F5) while nothing runs.
	const retryTailId = useMemo(() => {
		if (working || phase !== "live") return null;
		for (let index = canonical.length - 1; index >= 0; index--) {
			const card = canonical[index]!;
			if (card.kind === "assistant") return !card.streaming && (card.message.stopReason === "error" || card.message.stopReason === "aborted") ? card.id : null;
			if (card.kind === "entry" && entryMessage(card.entry)?.role === "user") return null;
		}
		return null;
	}, [canonical, working, phase]);
	// Rewind: what the picked prompt would abandon, and which card carries each branch point. A branch point that is
	// not itself on a card (a marker or a settings change) goes to the nearest earlier entry that is.
	const rewindSelected = props.rewind?.selectedId ?? null;
	const rewindDimmed = useMemo(() => {
		if (rewindSelected === null) return undefined;
		const at = canonical.findIndex(card => card.sourceIds.includes(rewindSelected));
		return at < 0 ? undefined : new Set(canonical.slice(at + 1).map(card => card.id));
	}, [canonical, rewindSelected]);
	const branchPoints = props.rewind?.branchPoints;
	const branchesByCard = useMemo(() => {
		if (branchPoints === undefined || branchPoints.length === 0) return undefined;
		const cardOf = new Map<string, string>();
		for (const card of canonical) for (const source of card.sourceIds) if (!cardOf.has(source)) cardOf.set(source, card.id);
		const position = new Map(entries.map((entry, index) => [entry.id, index]));
		const byCard = new Map<string, BranchPoint[]>();
		for (const point of branchPoints) {
			let cardId: string | undefined;
			if (point.entryId === null) cardId = cleared === null && olderCount === 0 ? canonical[0]?.id : undefined;
			else for (let index = position.get(point.entryId) ?? -1; index >= 0 && cardId === undefined; index -= 1) cardId = cardOf.get(entries[index]!.id);
			if (cardId === undefined) continue;
			const list = byCard.get(cardId);
			if (list === undefined) byCard.set(cardId, [point]);
			else list.push(point);
		}
		return byCard;
	}, [canonical, entries, branchPoints, olderCount, cleared]);
	const presentationProps: TranscriptProps = { ...props, footerByHost, retryTailId, rewindDimmed, branchesByCard, disclosures: shown, onDisclosureChange: (key, value) => { controllerRef.current?.retain(); disclosures.current.set(key, value); redrawDisclosures(version => version + 1); } };

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
			const expanded = shown.get(card.id) ?? false;
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
	}, [rows, overview, props.toolCallDetail, disclosureRevision, forcedCalls.current, shown]);
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
		for (const run of overview.runs) sources.set(run.id, shown.get(run.id) ? [run.id] : [run.id, ...run.members.flatMap(card => sources.get(card.id) ?? card.sourceIds)]);
		return { sources, order };
	}, [rows, overview, pending, stream, props.streamId, disclosureRevision, shown]);
	let bodyHeld = false;
	for (const inBody of forcedCalls.current.values()) if (inBody) { bodyHeld = true; break; }
	const bindingsRef = useRef({ sourceBindings, topId, bodyHeld });
	bindingsRef.current = { sourceBindings, topId, bodyHeld };
	const toolViewVersion = useToolViewVersion();
	const measuredRows = useMemo(() => measuredTranscriptRows(densityRows, sourceBindings.sources, viewport.width, shown, namespace, autoCalls, peekToolView), [densityRows, sourceBindings, viewport.width, disclosureRevision, namespace, autoCalls, shown, toolViewVersion]);
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
		const update = (event: Event): void => {
			if (!rootRef.current || densityInteraction.current) return;
			const active = focusAfter(event);
			const interaction = captureToolInteraction(rootRef.current, overviewRef.current?.runs ?? [], active);
			const next = heldToolInteractions(rootRef.current, interaction.calls, active);
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
	// The reader's own prompt (Send, a steer, a follow-up) must never leave itself and its reply off-screen: re-attach to the tail.
	const followedLatest = useRef(props.followLatest ?? 0);
	useLayoutEffect(() => {
		const requested = props.followLatest ?? 0;
		if (requested === followedLatest.current) return;
		followedLatest.current = requested;
		setPinnedTopId(null); setPageEndId(null); setHeldPageEndId(null);
		controllerRef.current?.jump();
	}, [props.followLatest]);
	// A newly picked rewind target is brought into view, loading it into the rendered window first when needed.
	useLayoutEffect(() => {
		if (rewindSelected === null) return;
		const card = canonical.find(candidate => candidate.sourceIds.includes(rewindSelected));
		if (card === undefined) return;
		if (!props.pagedHistory && !rows.some(row => row.id === card.id)) setPinnedTopId(card.id);
		controllerRef.current?.reveal([rewindSelected]);
	}, [rewindSelected]);

	// A page requested from the host is in flight from the click until the rows above the
	// old top arrive (the top changes), the host says nothing is left (the count changes),
	// or the conversation is re-based; a reply that never comes re-arms the button.
	const topEntryId = entries[0]?.id ?? null;
	const [awaitingOlder, setAwaitingOlder] = useState<string | null>(null);
	useLayoutEffect(() => {
		if (awaitingOlder === null) return;
		if ((topEntryId ?? "") === awaitingOlder) return;
		setAwaitingOlder(null);
		if (topEntryId !== null && cleared === null) {
			// Rows arrived above the old top: hold the new top, so they mount, and the
			// reveal anchor puts the reader back where they were.
			setPinnedTopId(topEntryId);
		}
	}, [topEntryId, awaitingOlder, cleared]);
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
	const earlier = olderCount > 0 ? <div className="omp-earlier">
		<button type="button" disabled={awaitingOlder !== null} onClick={() => {
			controllerRef.current?.hold();
			if (onLoadOlder()) setAwaitingOlder(topEntryId ?? "");
		}}>{awaitingOlder !== null ? "loading earlier messages…" : `load earlier messages (${olderCount} older)`}</button>
	</div> : null;

	// Find in the conversation (Ctrl+F): only the conversation's own transcript has it, not a child agent's inside a call.
	const find = useTranscriptFind({
		enabled: (props.depth ?? 0) === 0, canonical, rows, overview, grouped: props.toolCallDetail !== "detailed", shown, namespace, cwd: props.cwd,
		paged: Boolean(props.pagedHistory), olderCount, beforeReset: cleared !== null, rootRef, controllerRef,
		pinTop: setPinnedTopId,
		showPage: cardId => {
			const at = canonical.findIndex(card => card.id === cardId);
			if (at < 0) return;
			const end = canonical[Math.min(canonical.length - 1, at + TRANSCRIPT_WINDOW_ROWS - 1)]!;
			setPageEndId(end.id === canonical.at(-1)?.id ? null : end.id);
		},
		disclose: (key, value) => presentationProps.onDisclosureChange?.(key, value),
	});

	return (
		<div className="omp-transcript-frame">
		<div ref={rootRef} className="omp-transcript" role="region" aria-label="Conversation transcript" data-vscode-context={CHAT_TEXT_MENU_CONTEXT} onKeyDown={event => {
			if (event.defaultPrevented) return;
			// Arrows, Home and End on a head move to the previous, next, first or last head that is mounted; inside a body, a filter or a menu they are not ours.
			if (rootRef.current !== null && event.target instanceof Element && isHeadNavigation(event.key, event.target)) {
				event.preventDefault();
				nextHead(rootRef.current, event.target, event.key)?.focus();
				return;
			}
			if (event.key !== "Escape") return;
			const element = event.target instanceof Element ? event.target : null;
			const id = element?.closest<HTMLElement>("[data-run-id]")?.dataset.runId ?? element?.closest<HTMLElement>(".omp-tool-overview")?.dataset.sourceId;
			if (!id || !shown.get(id)) return;
			const head = [...(rootRef.current?.querySelectorAll<HTMLElement>(".omp-tool-overview") ?? [])].find(group => group.dataset.sourceId === id)?.querySelector<HTMLButtonElement>(".omp-overview-head");
			if (!head) return;
			event.preventDefault(); event.stopPropagation(); head.focus({ preventScroll: true }); presentationProps.onDisclosureChange?.(id, false);
		}}>
			<div ref={contentRef} className="omp-transcript-content">
			{canonical.length === 0 && cleared === null && stream === null && !working && (
				loading || (props.depth ?? 0) > 0
					? <div className="omp-empty">{loading ? "joining the session…" : "no activity yet"}</div>
					: <EmptyState cwd={props.cwd} model={props.model} thinkingLevel={props.thinkingLevel} />
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
						load {step} earlier messages ({olderRows + (cleared === null ? olderCount : 0)} older)
					</button>
				</div>
			) : (
				cleared === null && (!props.pagedHistory || page.previousEndId === null) ? earlier : null
			)}
			<MeasuredRows rows={measuredRows} context={`${namespace}:${props.toolCallDetail}`} viewport={viewport}
				elementRef={measuredRef} following={readerMode === "following" && !bodyHeld} anchor={controllerRef.current?.anchor} paged={props.pagedHistory || (props.depth ?? 0) > 0} forcedSources={forcedCalls.current} forcedRows={heldRunIds}
				onLayout={() => controllerRef.current?.layout()} onInteraction={held => { if (props.pagedHistory) setHeldPageEndId(held ? page.endId : null); }}
				renderRow={index => { const card = densityRows[index]!; if (card.kind === "run") {
					const callKeys = card.members.flatMap(member => member.kind === "tool" ? [`call:${props.conversationKey ?? "chat"}:${member.tool.call.id}`] : []);
					return <ToolOverview run={card} expanded={shown.get(card.id) ?? false}
						onExpandedChange={value => presentationProps.onDisclosureChange?.(card.id, value)}
						calls={{ total: callKeys.length, open: callKeys.filter(key => shown.get(key) === true).length, setAll: open => { for (const key of callKeys) presentationProps.onDisclosureChange?.(key, open); } }} />;
				}
					const run = card.kind === "tool" || isOverviewMessage(card) ? groupByCall.get(overviewMemberId(card)) : undefined;
					const body = <TranscriptCardView card={card} props={presentationProps} autoExpanded={card.kind === "tool" && autoCalls.get(card.tool.call.id) === true}
						clearedHistory={cleared !== null && card.kind === "entry" && card.id === cleared.boundary.id ? <ClearedHistory history={cleared} props={presentationProps} earlier={earlier} /> : undefined} />;
					// One wrapper element whether the call is flat or a group member, so a call that gains or loses its group keeps its DOM and focus.
					if (card.kind !== "tool" && !isOverviewMessage(card) || props.toolCallDetail === "detailed") return body;
					return run ? <div className="omp-overview-member" data-run-id={run.id} role="group" aria-label={run.summary}>{body}</div> : <div>{body}</div>;
				}} />
			<WorkingStatus working={props.turnInProgress ?? working} intent={props.workingIntent}
				waitingForAnswer={props.waitingForAnswer} maintenance={props.maintenance} backgroundWait={props.backgroundWait}
				startedAt={props.displayTurns?.at(-1)?.complete === false ? props.displayTurns.at(-1)?.startedAt : null} />
			</div>
		</div>
		{readerMode === "detached" && <button type="button" className="omp-jump-latest" aria-label="Jump to latest" title="Jump to latest" onClick={() => {
			setPinnedTopId(null); setPageEndId(null); controllerRef.current?.jump();
		}}><i className="codicon codicon-arrow-down" aria-hidden="true" /></button>}
		<span className="omp-sr-only" role="status">{anchorNotice}</span>
		{find}
		</div>
	);
}
