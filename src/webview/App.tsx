/**
 * Chat page root.
 *
 * The extension host owns the conversation: it runs the OMP session, keeps the model, and
 * sends this page `omp:chat-*` messages. The page renders the {@link ChatClient} snapshot the
 * host's messages build and posts the user's commands back — it holds no credential and opens
 * no socket. Everything shown about the session's state — starting, catching up, stopped,
 * failed, view-only, legacy — is the host's own phase, never inferred from silence, and a
 * failure is shown as one of the fixed sentences (`./lib/chat-banner`).
 *
 * The client is created and attached to the transport before this component renders
 * (`./main`), so no host message sent after the page announces itself can be missed.
 * A page that survives an extension-host restart keeps its rendered model until the new
 * host's first `omp:chat-snapshot` replaces it.
 */
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { guestTransport } from "./bridge";
import type { GuestRouteKind } from "./bridge";
import { chatTurnInProgress } from "../chat/model";
import { Composer } from "./components/Composer";
import { FileLinksProvider } from "./components/FileLinks";
import { WebLinksProvider } from "./components/WebLinks";
import { DetailView } from "./components/DetailView";
import { HudDock } from "./components/HudDock";
import { QueuedMessages } from "./components/QueuedMessages";
import { DETAIL_META, parseDetailMeta } from "./detail-target";
import { Transcript, type TranscriptRewind } from "./components/Transcript";
import { RewindBar } from "./components/Rewind";
import { NAVIGATE_REFUSAL_SENTENCES, rewindTargets, undoOffer, type NavigationKind } from "../chat/rewind";
import { REWIND_IDLE, conversationMovedPastLeaf, reduceRewind, rewindBlockedReason } from "./lib/rewind-mode";
import { parseDraftHandoffContent } from "./messages";
import type { ChatClient } from "./lib/chat-client";
import { chatBanner } from "./lib/chat-banner";
import { captureDraft, offerRestoredDraft, releaseDraftCapture } from "./lib/draft-handoff";
import { requestPanelAction } from "./lib/panel-actions";
import { useChatSnapshot, useComposerPopupReport } from "./lib/use-chat";
import { TerminalPane } from "./components/TerminalPane";
import { sessionViewSnapshot, subscribeSessionView } from "./lib/session-view";
import { adoptTranscriptToggles } from "./lib/transcript-toggles";

export function App({ client }: { client: ChatClient }): ReactNode {
	if (!guestTransport.hosted) {
		return (
			<div className="omp-chat">
				<div className="omp-notices">
					<div className="omp-notice omp-notice--error">
						<span className="omp-notice-description">This page is not running inside a VS Code webview.</span>
					</div>
				</div>
			</div>
		);
	}
	// A detail document names what it shows in its own meta tag and never becomes a session view.
	const detailMeta = document.querySelector(`meta[name="${DETAIL_META}"]`);
	if (detailMeta !== null) {
		const detail = parseDetailMeta(detailMeta.getAttribute("content"));
		if (detail === null) {
			return (
				<div className="omp-chat">
					<div className="omp-notices">
						<div className="omp-notice omp-notice--error">
							<span className="omp-notice-description">This detail tab names nothing the extension can show.</span>
						</div>
					</div>
				</div>
			);
		}
		return <WebLinksProvider transport={guestTransport}><DetailView client={client} target={detail} /></WebLinksProvider>;
	}
	return <WebLinksProvider transport={guestTransport}><SessionView client={client} /></WebLinksProvider>;
}

function SessionView({ client }: { client: ChatClient }): ReactNode {
	const view = useSyncExternalStore(subscribeSessionView, sessionViewSnapshot);
	const route = useRouteKind();
	useEffect(() => guestTransport.subscribe(message => {
		if (message.type === "omp:webview-action" && view.mode === "chat") {
			requestPanelAction(message.action);
		} else if (message.type === "omp:draft-request") {
			const capture = view.mode === "chat" ? captureDraft(message.requestId) : null;
			const content = parseDraftHandoffContent(capture);
			if (content === null) releaseDraftCapture(message.requestId);
			guestTransport.post({ type: "omp:draft-reply", requestId: message.requestId, captured: content !== null, ...(content ?? { text: "", attachments: 0, recoverable: [] }) });
		} else if (message.type === "omp:draft-release") {
			releaseDraftCapture(message.requestId);
		} else if (message.type === "omp:draft-restore" && view.mode === "chat") {
			offerRestoredDraft(message.requestId, message);
			guestTransport.post({ type: "omp:draft-restored", requestId: message.requestId });
		}
	}), [view.mode]);
	useEffect(() => {
		if (view.mode === "terminal") document.title = view.title;
	}, [view.mode, view.title]);
	const disabled = !view.canSwitch || view.starting || view.stopping || route === "bridge";
	return (
		<div className="omp-session-view">
			{view.mode === "chat" ? <ChatView client={client} /> : (
				<div className="omp-native-session">
					{view.reason !== null && !view.starting && <div className="omp-notices"><div className="omp-notice omp-notice--warning"><span className="omp-notice-description">{view.reason}</span></div></div>}
					<TerminalPane active passive={disabled} title={view.title} focusSignal={view.focusToken} managedSession hostAvailable={view.running} starting={view.starting} />
					{!view.running && !view.starting && !view.stopping && <div className="omp-native-session-actions">
						<span>This session is stopped.</span>
						<button type="button" disabled={disabled} onClick={() => guestTransport.post({ type: "omp:session-mode", mode: "terminal" })}>Start in Terminal</button>
						<button type="button" disabled={disabled} onClick={() => guestTransport.post({ type: "omp:session-mode", mode: "chat" })}>Open in Chat</button>
					</div>}
					{route === "bridge" && <div className="omp-route-notice">OMP reconnected after restarting in the background. Reload the window to switch between Chat and Terminal.</div>}
				</div>
			)}
		</div>
	);
}

/**
 * The route this document is currently using.
 *
 * `none` until the host offers one and this page acknowledges it, which is exactly
 * the state in which nothing but the panel channel exists.
 */
function useRouteKind(): GuestRouteKind {
	const [kind, setKind] = useState<GuestRouteKind>(() => guestTransport.routeKind());
	useEffect(() => {
		setKind(guestTransport.routeKind());
		return guestTransport.onRouteChange(setKind);
	}, []);
	return kind;
}

function ChatView({ client }: { client: ChatClient }): ReactNode {
	const snapshot = useChatSnapshot(client);
	const [unansweredNative, setUnansweredNative] = useState<string | null>(null);
	useEffect(() => {
		if (snapshot.code === "state-failed" && snapshot.epoch !== null) setUnansweredNative(snapshot.epoch.nonce);
		else if (snapshot.phase === "live" || snapshot.phase === "stopped" || snapshot.phase === "view-only" || snapshot.epoch?.nonce !== unansweredNative) setUnansweredNative(null);
	}, [snapshot.code, snapshot.phase, snapshot.epoch?.nonce, unansweredNative]);
	const restartOffered = snapshot.epoch !== null && (snapshot.code === "state-failed" ||
		(unansweredNative === snapshot.epoch.nonce && (snapshot.phase === "attaching" || snapshot.phase === "resyncing")));
	// Which route the host selected for this document and this page acknowledged.
	// A bridge route keeps the chat, the composer and the controls that need only the
	// authenticated channel; the panel-only exchanges are reported as unavailable
	// instead of appearing to work.
	const route = useRouteKind();
	// The composer's `@`-popup state goes to the host, whose stop keybinding needs it.
	useComposerPopupReport();
	const preferences = useSyncExternalStore(client.subscribe, client.getDisplayPreferences);
	// Screen-reader paging is not a menu choice: it follows VS Code's `editor.accessibilitySupport`, which the host pushes with the display preferences.
	const pagedHistory = preferences.accessibilitySupport;
	// The host's remembered thinking and tool defaults (`omp.toggleThinking`, `omp.toggleToolOutput`).
	useEffect(() => adoptTranscriptToggles(preferences.thinkingExpanded === true, preferences.toolsExpanded === true), [preferences.thinkingExpanded, preferences.toolsExpanded]);

	useEffect(() => {
		document.title = snapshot.header?.title ?? snapshot.state?.sessionName ?? "omp session";
	}, [snapshot.header?.title, snapshot.state?.sessionName]);

	const banner = chatBanner(snapshot);
	// A severed host link is shown as a lost connection, never as silence; the draft lives in the composer and is kept.
	const hostLost = useSyncExternalStore(guestTransport.onRouteChange, guestTransport.hostConnectionLost);
	// While the link is down or the session is being (re)attached, a remembered `working` is not an observation: show none.
	const workUnknown = hostLost || snapshot.phase === "attaching" || snapshot.phase === "resyncing" || snapshot.phase === "failed";
	const shown = workUnknown && snapshot.working ? { ...snapshot, working: false } : snapshot;
	const readChild = useCallback((id: string, options?: { fromByte?: number; beforeId?: string }) => client.readSubagent(id, options), [client]);

	// Rewind (ADR-0051): picking a prompt, one navigation at a time, the Undo offer and branch switches.
	const [rewind, dispatchRewind] = useReducer(reduceRewind, REWIND_IDLE);
	const [rewindNotice, setRewindNotice] = useState<string | null>(null);
	const rewindBarRef = useRef<HTMLDivElement | null>(null);
	const durable = useMemo(() => snapshot.entries.slice(0, snapshot.durableCount), [snapshot.entries, snapshot.durableCount]);
	const targets = useMemo(() => rewindTargets(durable), [durable]);
	const targetIds = useMemo(() => new Set(targets.map(target => target.id)), [targets]);
	const movedOn = conversationMovedPastLeaf(snapshot);
	const undo = useMemo(() => movedOn ? null : undoOffer(durable, snapshot.leafId), [movedOn, durable, snapshot.leafId]);
	const rewindBlocked = hostLost ? NAVIGATE_REFUSAL_SENTENCES["not-live"] : rewindBlockedReason(snapshot);
	useEffect(() => dispatchRewind({ type: "snapshot", targets, leafId: snapshot.leafId }), [targets, snapshot.leafId]);
	const startRewind = useCallback((targetId?: string): void => {
		setRewindNotice(targets.length === 0 ? "There is no earlier message in this conversation to rewind to." : null);
		dispatchRewind({ type: "start", targets, leafId: snapshot.leafId, ...(targetId === undefined ? {} : { targetId }) });
	}, [targets, snapshot.leafId]);
	const navigate = useCallback(async (kind: NavigationKind, targetId: string, leafId: string | null, summarize: boolean): Promise<void> => {
		dispatchRewind({ type: "submit", action: kind, targetId, leafId, summarize });
		const answer = await client.navigate({ kind, targetId, expectedLeafId: leafId, summarize });
		dispatchRewind({ type: "settled" });
		setRewindNotice(answer.status === "done"
			? (answer.raced === true ? "Done, but OMP also changed the conversation meanwhile. Check the transcript." : null)
			: NAVIGATE_REFUSAL_SENTENCES[answer.status === "unconfirmed" ? "unconfirmed" : answer.reason ?? "failed"]);
		if (answer.status !== "done" || answer.kind !== "rewind") requestPanelAction("focus-composer");
	}, [client]);
	const pickedId = rewind.kind === "picking" ? rewind.targetId : null;
	const transcriptRewind = useMemo((): TranscriptRewind => ({
		targets: rewindBlocked === null || rewind.kind === "picking" ? targetIds : new Set<string>(),
		selectedId: pickedId,
		branchPoints: snapshot.branches,
		onPick: entryId => {
			if (rewind.kind === "picking" && rewind.targetId === entryId && rewindBlocked === null) void navigate("rewind", entryId, rewind.leafId, false);
			else if (rewind.kind === "picking") dispatchRewind({ type: "select", targets, targetId: entryId });
			else startRewind(entryId);
		},
		...(rewindBlocked === null && rewind.kind !== "pending" ? { onSwitch: (tipId: string) => void navigate("switch", tipId, snapshot.leafId, false) } : {}),
	}), [rewindBlocked, rewind, targetIds, pickedId, snapshot.branches, snapshot.leafId, targets, navigate, startRewind]);
	// Picking owns the keyboard in the bar; leaving it returns focus to the composer.
	const picking = rewind.kind === "picking";
	useEffect(() => {
		if (picking) rewindBarRef.current?.focus({ preventScroll: true });
	}, [picking]);
	const notice = hostLost
		? { level: "warn", icon: "debug-disconnect", text: "Lost connection to the extension host — reconnecting. Your draft is kept." }
		: restartOffered
			? { level: "warn", icon: "debug-disconnect", text: "OMP has not answered a state request. Reconnect keeps the same process; Restart can stop it and reopen the saved conversation. Unconfirmed input is kept and never resent automatically." }
			: banner;
	const banners = notice === null ? null : (
		<div className="omp-notices">
			<div className={`omp-notice omp-notice--${notice.level === "warn" ? "warning" : notice.level}`} role="status">
				<span className={`codicon codicon-${notice.icon}`} aria-hidden="true" />
				<span className="omp-notice-description">{notice.text}</span>
				{!hostLost && (banner?.action === "reconnect" || restartOffered) && <button type="button" className="omp-btn" disabled={snapshot.phase !== "failed"} onClick={() => client.reconnect()}>Reconnect</button>}
				{!hostLost && restartOffered && <button type="button" className="omp-btn" onClick={() => client.restart()}>Restart</button>}
			</div>
		</div>
	);

	// A tab that belongs to a previous build shows its explanation and nothing else:
	// no transcript, no controls, no composer, and nothing that could reach a session.
	if (snapshot.phase === "legacy") {
		return <div className="omp-chat">{banners}</div>;
	}

	return (
		<div className="omp-chat">
			{banners}
			{/* One link-validation cache for the transcript and the rewind bar's changed files (a context only, no DOM). */}
			<FileLinksProvider transport={guestTransport} cwd={snapshot.header?.cwd}>
			<div className="omp-body">
				<div className="omp-main">
					<Transcript
						toolCallDetail={preferences.toolCallDetail}
						conversationKey={snapshot.header?.id ?? snapshot.epoch?.nonce ?? "chat"}
						entries={snapshot.entries}
						stream={snapshot.stream}
						activeTools={snapshot.activeTools}
						working={shown.working}
						turnInProgress={!workUnknown && chatTurnInProgress(snapshot)}
						workingIntent={snapshot.workingIntent}
						phase={snapshot.phase}
						olderCount={snapshot.olderCount}
						onLoadOlder={() => client.loadOlder()}
						pending={snapshot.pending}
						cards={snapshot.ephemeral}
						durableCount={snapshot.durableCount}
						streamId={snapshot.streamId}
						streamPosition={snapshot.streamPosition}
						sealedSeq={snapshot.sealedSeq}
						durablePositions={snapshot.durablePositions}
						cwd={snapshot.header?.cwd}
						retrySuppressedIds={snapshot.retrySuppressedIds}
						agents={snapshot.agents}
						agentActivity={snapshot.agentActivity}
						reader={readChild}
						model={snapshot.state?.model}
						maintenance={snapshot.maintenance}
						retry={snapshot.retry}
						displayTurns={snapshot.displayTurns}
						settled={snapshot.settled}
						asyncPaused={snapshot.asyncPaused}
						waitingForAnswer={snapshot.uiRequest !== null}
						pagedHistory={pagedHistory}
						rewind={transcriptRewind}
					/>
				</div>
			</div>
			{/* Only panel-only composer/editor requests are unavailable on a bridge route. */}
			{route === "bridge" && (
				<div className="omp-route-notice">
					OMP reconnected after restarting in the background. Reload the window to use @ file completion
					and editor commands.
				</div>
			)}
			<div className="omp-dock">
				<HudDock model={snapshot} />
				<QueuedMessages client={client} model={snapshot} />
				<RewindBar mode={rewind} targets={targets} entries={durable} cwd={snapshot.header?.cwd} blocked={rewindBlocked} undo={undo} notice={rewindNotice} barRef={rewindBarRef}
					onMove={to => dispatchRewind({ type: "move", targets, to })}
					onSubmit={summarize => { if (rewind.kind === "picking") void navigate("rewind", rewind.targetId, rewind.leafId, summarize); }}
					onCancel={() => { dispatchRewind({ type: "cancel" }); requestPanelAction("focus-composer"); }}
					onUndo={() => { if (undo !== null) void navigate("undo", undo.from, snapshot.leafId, false); }}
					onDismissNotice={() => setRewindNotice(null)} />
				<Composer client={client} snapshot={shown} progressAvailable={!workUnknown} onRewind={startRewind} />
			</div>
			</FileLinksProvider>
		</div>
	);
}
