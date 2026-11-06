import type { ReactNode } from "react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createChatModel } from "../../chat/model";
import type { ActiveTool } from "../../chat/pending";
import type { ChatEntry } from "../../chat/messages";
import {
	SUBAGENT_PAGE_ROWS,
	SUBAGENT_UNAVAILABLE_TEXT,
	type SubagentReader,
	type SubagentReadOptions,
	type SubagentTranscriptPage,
} from "../../chat/subagent-transcript";
import { Transcript } from "./Transcript";
import { messageText } from "../../shared/format";
import { Markdown } from "./Markdown";

export interface ChildTranscriptProps {
	subagentId: string;
	reader?: SubagentReader;
	depth?: number;
}

/** The last assistant message's tool calls that no later result answers, as the running tools they are. */
function unansweredTailCalls(entries: readonly ChatEntry[]): ReadonlyMap<string, ActiveTool> {
	const tools = new Map<string, ActiveTool>();
	let tail = -1;
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index]!;
		if (entry.type === "message" && entry.message.role === "assistant") { tail = index; break; }
	}
	if (tail < 0) return tools;
	const assistant = entries[tail]!;
	if (assistant.type !== "message" || assistant.message.role !== "assistant" || assistant.message.stopReason === "error" || assistant.message.stopReason === "aborted") return tools;
	const answered = new Set<string>();
	for (const entry of entries.slice(tail + 1)) if (entry.type === "message" && entry.message.role === "toolResult") answered.add(entry.message.toolCallId);
	for (const block of assistant.message.content) {
		if (block.type === "toolCall" && !answered.has(block.id)) tools.set(block.id, { toolCallId: block.id, toolName: block.name, args: block.arguments, startedAt: assistant.message.timestamp });
	}
	return tools;
}

type AvailablePage = Extract<SubagentTranscriptPage, { status: "available" }>;
type ReadKind = "initial" | "refresh" | "older";

/**
 * Retain only the most recent bridge-sized page, never a growing child model. A read that brings nothing new keeps the
 * page's `entries` array itself, so the caller can tell "the same page" without comparing rows.
 */
function appendChildPage(previous: AvailablePage, incoming: AvailablePage): AvailablePage {
	if (incoming.entries.length === 0) return { ...previous, olderCount: previous.olderCount + incoming.olderCount, nextByte: incoming.nextByte, reset: false };
	const updated = new Map(incoming.entries.map(entry => [entry.id, entry]));
	const previousIds = new Set(previous.entries.map(entry => entry.id));
	const entries = [
		...previous.entries.map(entry => updated.get(entry.id) ?? entry),
		...incoming.entries.filter(entry => !previousIds.has(entry.id)),
	];
	const discarded = Math.max(0, entries.length - SUBAGENT_PAGE_ROWS);
	return {
		status: "available",
		entries: entries.slice(discarded),
		olderCount: previous.olderCount + incoming.olderCount + discarded,
		fromByte: previous.fromByte,
		nextByte: incoming.nextByte,
		reset: false,
	};
}

export interface ChildTranscriptBodyProps extends Required<Pick<ChildTranscriptProps, "subagentId" | "depth">>, Pick<ChildTranscriptProps, "reader"> {
	/** Re-read the latest page this often while set (a live agent's tab); one final read when it is cleared. */
	refreshMs?: number;
	/** A refresh that fails keeps the rows already read and says why, instead of replacing them (a detail tab). */
	keepOnFailure?: boolean;
	/** The registry assignment is omitted when the first transcript card already contains it. */
	assignment?: string;
	/**
	 * The body is the page of an agent's detail tab: its transcript is the page's one scroller and behaves as the Chat's own (it
	 * follows the tail, windows long histories, finds text), not an inline block of a tool card. A child nested in one of its calls
	 * still counts the tab as one level.
	 */
	standalone?: boolean;
	/** With `standalone`: where the Refresh button goes (the tab's header); the button waits until the host exists. */
	toolbarHost?: HTMLElement | null;
}

/**
 * The agent's child history. A refresh the user did not ask for (the timer, a return to the tab, the final read after the agent
 * stopped) is a background read: it touches nothing the user sees until the rows actually change (no busy state, no disabled
 * button, no note; a timer read that fails keeps the rows and says nothing, the next one tries again). A tick that finds a read
 * in flight is dropped (the next one comes soon). The user's own request waits for that read and the newest one runs; the final
 * read has a slot of its own, so neither a user request nor another read costs the agent's last rows, except that nothing
 * background runs while the user is reading earlier history (the same rule as the timer's).
 */
type ReadMode = "user" | "tick" | "final";
export const ChildTranscriptBody = memo(function ChildTranscriptBody({ subagentId, reader, depth, refreshMs, keepOnFailure = false, assignment = "", standalone = false, toolbarHost = null }: ChildTranscriptBodyProps): ReactNode {
	const [page, setPage] = useState<SubagentTranscriptPage | null>(null);
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string | null>(null);
	const [earlier, setEarlier] = useState(false);
	const pageRef = useRef<SubagentTranscriptPage | null>(null);
	const earlierRef = useRef(false);
	const inFlight = useRef(false);
	const queued = useRef<{ user: ReadKind | null; final: boolean }>({ user: null, final: false });
	const generation = useRef(0);
	const mounted = useRef(false);
	const readRef = useRef<(kind: ReadKind, mode?: ReadMode) => boolean>(() => false);

	const read = useCallback((kind: ReadKind, mode: ReadMode = "user"): boolean => {
		if (!mounted.current || reader === undefined) return false;
		if (inFlight.current) {
			if (mode === "tick") return false;
			if (mode === "final") queued.current.final = true;
			else queued.current.user = kind;
			return mode === "user";
		}
		const previous = pageRef.current;
		const available = previous?.status === "available" ? previous : null;
		const firstId = available?.entries[0]?.id;
		if (kind === "older" && (available === null || available.olderCount === 0 || firstId === undefined)) return false;
		const incremental = kind === "refresh" && available !== null && !earlierRef.current;
		const options: SubagentReadOptions = kind === "older"
			? { fromByte: 0, beforeId: firstId }
			: { fromByte: incremental ? available!.nextByte : 0 };
		const request = ++generation.current;
		inFlight.current = true;
		if (mode === "user") setBusy(true);
		void (async () => {
			let result: SubagentTranscriptPage;
			let reset = false;
			try {
				result = await reader(subagentId, options);
				if (!mounted.current || request !== generation.current) return;
				if (result.status === "available" && result.reset) {
					// A byte cursor from before a truncation/rewrite must never preserve old rows.
					reset = true;
					pageRef.current = null;
					setPage(null);
					earlierRef.current = false;
					setEarlier(false);
					result = await reader(subagentId, { fromByte: 0 });
					if (!mounted.current || request !== generation.current) return;
					if (result.status === "available" && result.reset) result = { status: "unavailable", reason: "changed" };
				}
			} catch {
				result = { status: "unavailable", reason: "read-failed" };
			}
			if (!mounted.current || request !== generation.current) return;
			const kept = keepOnFailure && kind === "refresh" && !reset && available !== null && result.status === "unavailable";
			const next = kept ? available : incremental && !reset && available !== null && result.status === "available"
				? appendChildPage(available, result)
				: result;
			// A timer read that failed leaves the rows and the note as they are: only the user's request and the final read say why.
			if (!(kept && mode === "tick")) setFailure(kept && result.status === "unavailable" ? SUBAGENT_UNAVAILABLE_TEXT[result.reason] : null);
			// A background read that brought no row keeps the rendered page as it is (only its byte cursor moves).
			const unchanged = incremental && available !== null && next.status === "available" && next.entries === available.entries && next.olderCount === available.olderCount;
			pageRef.current = next;
			if (!unchanged) setPage(next);
			const showingEarlier = next.status === "available" && kind === "older" && !reset;
			earlierRef.current = showingEarlier;
			setEarlier(showingEarlier);
			inFlight.current = false;
			setBusy(false);
			const { user, final } = queued.current;
			queued.current = { user: null, final };
			if (user !== null) readRef.current(user, "user");
			else if (final) {
				queued.current.final = false;
				if (!earlierRef.current) readRef.current("refresh", "final");
			}
		})();
		return true;
	}, [reader, subagentId, keepOnFailure]);
	readRef.current = read;

	useEffect(() => {
		mounted.current = true;
		pageRef.current = null;
		earlierRef.current = false;
		inFlight.current = false;
		queued.current = { user: null, final: false };
		setPage(null);
		setEarlier(false);
		setBusy(false);
		if (reader === undefined) {
			const unavailable: SubagentTranscriptPage = { status: "unavailable", reason: "not-live" };
			pageRef.current = unavailable;
			setPage(unavailable);
		} else {
			read("initial");
		}
		return () => {
			mounted.current = false;
			generation.current += 1;
			inFlight.current = false;
			queued.current = { user: null, final: false };
		};
	}, [read, reader]);

	useEffect(() => {
		if (refreshMs === undefined || reader === undefined) return;
		const timer = setInterval(() => {
			if (document.hidden || earlierRef.current) return;
			read("refresh", "tick");
		}, refreshMs);
		// A tab that was hidden missed its ticks: catch up as soon as it shows again, not at the next tick.
		const shown = (): void => { if (!document.hidden && !earlierRef.current) read("refresh", "tick"); };
		document.addEventListener("visibilitychange", shown);
		return () => {
			clearInterval(timer);
			document.removeEventListener("visibilitychange", shown);
			// The agent stopped being live: pick up what it wrote last (a no-op when the document unmounts).
			if (!earlierRef.current) read("refresh", "final");
		};
	}, [read, reader, refreshMs]);

	const live = refreshMs !== undefined;
	const childModel = useMemo(() => {
		if (page?.status !== "available") return null;
		return {
			...createChatModel(),
			// A running child's newest turn is unfinished, as in the Chat (no reply footer under it yet); a finished child is read-only history.
			phase: live ? "live" as const : "view-only" as const,
			readOnlyReason: "Read-only child transcript",
			entries: page.entries,
			durableCount: page.entries.length,
			olderCount: page.olderCount,
			leafId: page.entries.at(-1)?.id ?? null,
			agentAvailability: "available" as const,
			// A running child's last unanswered calls are in flight, not skipped.
			...(live ? { activeTools: unansweredTailCalls(page.entries), working: true } : {}),
		};
	}, [page, live]);

	const [assignmentOpen, setAssignmentOpen] = useState(false);
	const assignmentId = `assignment-${subagentId}`;
	const firstEntry = page?.status === "available" ? page.entries[0] : undefined;
	const duplicatesAssignment = firstEntry?.type === "message" && firstEntry.message.role === "user"
		&& messageText(firstEntry.message).trim() === assignment.trim();

	const refresh = (
		<div className="omp-native-child-toolbar">
			<button type="button" className="omp-btn" aria-label={earlier ? "Refresh latest child history" : "Refresh child history"} title={earlier ? "Refresh latest child history" : "Refresh child history"} disabled={busy || reader === undefined} onClick={() => read("refresh")}>
				<span className="codicon codicon-refresh" aria-hidden="true" />
			</button>
		</div>
	);

	return (
		<div className="omp-native-child-body" aria-busy={busy}>
			{page !== null && assignment.trim() !== "" && !duplicatesAssignment && (
				<div className="omp-native-tool omp-detail-assignment">
					<button type="button" className="omp-tool-head" aria-expanded={assignmentOpen} aria-controls={assignmentOpen ? assignmentId : undefined} onClick={() => setAssignmentOpen(open => !open)}>
						<span className={`codicon codicon-${assignmentOpen ? "chevron-down" : "chevron-right"}`} aria-hidden="true" />
						<span className="omp-tool-name">Assignment</span>
					</button>
					{assignmentOpen && <div id={assignmentId} className="omp-tool-body"><Markdown text={assignment} /></div>}
				</div>
			)}
			{standalone ? toolbarHost !== null && createPortal(refresh, toolbarHost) : refresh}
			{busy && (page === null || refreshMs === undefined) && <div className="omp-native-note" role="status">Loading child history…</div>}
			{page?.status === "unavailable" && <div className="omp-native-child-unavailable" role="status">{SUBAGENT_UNAVAILABLE_TEXT[page.reason]}</div>}
			{failure !== null && <div className="omp-native-note omp-native-child-stale" role="status">Showing the rows already read — {failure}</div>}
			{earlier && <div className="omp-native-note">Viewing an earlier page. Refresh returns to the latest history.</div>}
			{page?.status === "available" && page.entries.length === 0 && <div className="omp-native-note">OMP returned no child transcript entries.</div>}
			{childModel !== null && page?.status === "available" && page.entries.length > 0 && (
				<Transcript entries={childModel.entries} durableCount={childModel.durableCount} stream={childModel.stream} activeTools={childModel.activeTools} working={childModel.working} phase={childModel.phase} olderCount={childModel.olderCount} pending={childModel.pending} cards={childModel.ephemeral} depth={standalone ? 0 : depth} slidingPage renderChild={(id, nextDepth) => <ChildTranscript subagentId={id} reader={reader} depth={standalone ? nextDepth + depth : nextDepth} />} onLoadOlder={() => read("older")} />
			)}
		</div>
	);
});

function ChildDisclosure({ subagentId, reader, depth }: Required<Pick<ChildTranscriptProps, "subagentId" | "depth">> & Pick<ChildTranscriptProps, "reader">): ReactNode {
	const [open, setOpen] = useState(false);
	return (
		<details className="omp-native-child" onToggle={event => setOpen(event.currentTarget.open)}>
			<summary><span className="codicon codicon-comment-discussion" aria-hidden="true" /> Child transcript</summary>
			{open && <ChildTranscriptBody subagentId={subagentId} reader={reader} depth={depth} />}
		</details>
	);
}

/** Requests start only on disclosure; closing it releases cached rows and pending replies. */
export function ChildTranscript({ subagentId, reader, depth = 1 }: ChildTranscriptProps): ReactNode {
	if (depth > 2) return <div className="omp-native-note">Nested child transcript limit reached (maximum depth 2).</div>;
	return <ChildDisclosure key={`${subagentId}:${depth}`} subagentId={subagentId} reader={reader} depth={depth} />;
}
