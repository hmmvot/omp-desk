/**
 * The compound flows of one session's editor: open or focus a tab, open it in an explicit view, change an editor's
 * view (Chat or Terminal), restart an unresponsive Chat process and resume a stopped Chat.
 *
 * The policies live below this module: the admission of a row is the runtime's (`SessionRuntime.open`,
 * `replaceWriter`), the fence of a flow is the runtime's transition token, the ownership verdicts are
 * `session-availability.ts`'s and the editors themselves are `editor-panels.ts`'s. This module sequences them in the order
 * the flows were written to rely on (the catalog is read before a row is resolved, one attempt per tab, the editor before the
 * first question, the stop confirmed before a successor starts) and asks the user. It keeps no state of its own: every table
 * a flow reads or marks (`openingTabs`, the pending view changes, the draft restores, the event sequence, the restore outcomes)
 * is also read elsewhere in the extension, so each arrives through {@link SessionFlowsDeps} as a getter.
 *
 * What the flows end in stays with the extension: presenting a restore outcome (`handleRestoreOutcome`, shared with the
 * startup restore), reviving a restored editor (`editor-panels.ts` takes it as a dep), the Sessions click admission
 * (`openSession`) and the view projection (`pushSessionView`).
 */

import type * as vscode from "vscode";
import { bindingMatches } from "../host/bridge-records.ts";
import type { BridgeNativeBinding } from "../host/bridge-records.ts";
import { controlPathEquals } from "../host/control-protocol.ts";
import type { LaunchKind, LaunchTimeline } from "../host/launch-timeline.ts";
import type { SessionHostRuntime } from "../host/native-session.ts";
import type { PtyHandle } from "../host/pty-client.ts";
import type { PendingHandle, PendingOperations } from "../host/pending-operations.ts";
import { awaitEndedRuntimeCleanup } from "../host/runtime-settle.ts";
import { readSessionFileHeader } from "../host/session-files.ts";
import type { RestoreOutcome, SessionIndex } from "../host/session-index.ts";
import { isManagedHost } from "../host/session-model.ts";
import type { SessionIndexEntry, SessionViewMode } from "../host/session-model.ts";
import type { LocalSessionRuntime } from "../runtime/local-runtime.ts";
import type { ConversationRecord } from "../runtime/runtime-record.ts";
import type { LiveConversation, ReplaceRefusal, TransitionPhase, TransitionToken } from "../runtime/session-runtime.ts";
import type { Logger } from "../shared/logger.ts";
import type { PendingKind, PendingOrigin, PendingStep } from "../shared/pending-operation.ts";
import type { SessionLauncherFacts, SessionOwnershipFacts, SessionTreeProvider } from "../views/session-tree.ts";
import { setTimeout as delayMs } from "node:timers/promises";
import type { BridgeHost } from "./bridge-host.ts";
import type { StartupRestore } from "./catalog-adoption.ts";
import type { EditorPanels, EditorPanelsTab } from "./editor-panels.ts";
import type { CarriedDraft, GuestDispatcher } from "./guest-dispatcher.ts";
import type { SessionActions } from "./session-actions.ts";
import type { WindowRouting } from "./window-routing.ts";

/** What the flows read and change of one editor record of this window. */
export interface SessionFlowsTab extends EditorPanelsTab {
	/** The sequence number of this tab's last open or view request ({@link SessionFlowsWindow.nextEditorEvent}); `-1` when it never happened. */
	lastOpenRequest: number;
	/** The sequence number of this tab's last editor close; `-1` when it never happened. */
	lastEditorClose: number;
	/** This tab's editor was created by the open attempt now in flight. */
	editorOfAttempt: boolean;
	/** The verb of the open attempt now in flight for this tab, or `null`. */
	openingVerb: "started" | "opened" | "resumed" | null;
	/** The last open attempt of this tab ended at a Cancel of its external-writer question. */
	openDeclined: boolean;
}

/**
 * What one flow checks under the gate that only the window can know (the editor's role, the last view request, the
 * identity of its panel and document), and what it refreshes between a replacement's teardown and its successor's
 * launch. Registered by the flow right after it raised its fence, keyed by the fence's token.
 */
export interface TransitionChecks {
	check(phase: TransitionPhase): boolean | Promise<boolean>;
	prepare?(): Promise<void>;
}

/** The window's own records and bookkeeping the flows read and change. */
export interface SessionFlowsWindow<Tab extends SessionFlowsTab> {
	/** The record an editor slot or a conversation resolves to. */
	tab(key: string | null): Tab | undefined;
	/** The record of an editor slot, created empty when the window has none. */
	tabState(key: string): Tab;
	/** Explicit opens in flight, one promise per tab: two clicks on one row converge on one attempt. */
	openingTabs(): Map<string, Promise<void>>;
	/** Editor ids present in this window's actual editor membership right now. */
	liveEditors(): ReadonlySet<string>;
	/** The next number of the window-wide counter that orders every editor event. */
	nextEditorEvent(): number;
	/** Pending view requests by editor record; they disable the title actions before the fence is up. */
	pendingSessionViewChanges(): Map<Tab, number>;
	/** Drafts captured from a replaced document, waiting for its successor to be ready (by editor slot). */
	draftRestores(): Map<string, CarriedDraft<Tab>>;
	/** The last restore outcome per tab, as the launcher shows it. */
	outcomes(): ReadonlyMap<string, RestoreOutcome>;
	/** Resolves once the profile catalog and the predecessor import have settled. */
	ensureCatalogReady(): Promise<void>;
	/** The startup restore pass while it runs, or `null` before it starts and after it is over. */
	startupRestore(): StartupRestore | null;
	/** The other windows of the profile: who holds a session, where a launch goes, and the marks an explicit open supersedes. */
	routing(): Pick<WindowRouting, "consumeRequestedSelection" | "heldByAnotherWindow" | "switchToWindow" | "routeOpen">;
	/** The reason the editor slot is passive, or `null` when it controls. */
	passiveReasonForSlot(slot: string): string | null;
	defaultSessionMode(context: vscode.ExtensionContext): SessionViewMode;
}

/** The actions the user asked for that are still being processed, and the launch timeline of the commands that wait on a launch. */
export interface SessionFlowsProgress {
	pending(): Pick<PendingOperations, "begin" | "step">;
	launchTimeline(): Pick<LaunchTimeline, "begin" | "lap" | "abandon">;
	/**
	 * Run the entry of an action the user asked for as a pending operation: it begins at once and ends when `run` settles
	 * (`run` may end it earlier with its own status).
	 */
	pendingEntry<T>(
		key: string,
		kind: PendingKind,
		options: { readonly origin?: PendingOrigin; readonly requestId?: string | null; readonly step?: PendingStep },
		run: (handle: PendingHandle) => Promise<T>,
	): Promise<T>;
	/** Run one explicit launch command under a timeline run that began when the command was entered. */
	timedLaunch<T>(tabId: string, kind: LaunchKind, commandAt: number, run: () => Promise<T>): Promise<T>;
}

/** This window's session runtime and what the window knows of the process, control channel and fence of one editor's conversation. */
export interface SessionFlowsRuntime<Tab extends SessionFlowsTab> {
	sessionRuntime(): Pick<LocalSessionRuntime,
		"conversations" | "control" | "nativeWatch" | "exit" | "open" | "verifiedWriterPid" | "snapshot" | "readTransitionFacts" |
		"endEnded" | "replaceWriter" | "endTransition">;
	/** The process this window runs for the editor's conversation. */
	hostOf(state: { readonly tabId: string | null } | null | undefined): SessionHostRuntime | null;
	/** What the runtime holds for the conversation an editor shows; `undefined` for a folder shell. */
	recordOf(state: { readonly tabId: string | null } | null | undefined): ConversationRecord | undefined;
	/** The runtime's record of the conversation an editor shows, created for the editor on first use. */
	recordFor(state: Tab): ConversationRecord;
	/** The verified host-control channel of the editor's conversation. */
	controlOf(state: { readonly tabId: string | null } | null | undefined): ConversationRecord["control"];
	/** Whether the conversation's admission fence is up. */
	fencedOf(state: { readonly tabId: string | null } | null | undefined): boolean;
	/** The conversation's live Chat session as values, when it is still the incarnation the caller named. */
	liveAt(tabId: string, incarnation: number): LiveConversation | null;
	/** Raise the admission fence of a conversation for one flow, with the checks it makes under the gate. */
	beginTransition(conversation: string, checks: TransitionChecks): TransitionToken;
	/** Bound readback and gate admission, not a destructive transaction or a user's dialog. */
	withSessionReadDeadline<T>(read: Promise<T>, timeoutMs?: number): Promise<T>;
	/** Attach the PTY of a Terminal runtime to the editor's pipeline. */
	ensureTerminalPipeline(index: SessionIndex, slot: string, handle: PtyHandle): unknown;
}

/** The Sessions view and the facts the open flow asks of a row. */
export interface SessionFlowsLauncher {
	refreshLauncher(): void;
	/** What only this window knows about a tab: its panel, its host, its last outcome. */
	launcherFacts(tabId: string): Pick<SessionLauncherFacts, "running">;
	/** Probe who holds the session now (`fresh` bypasses the cached reading). */
	launcherOwnershipFacts(index: SessionIndex, tabId: string, options: { readonly fresh?: boolean }): Promise<Pick<SessionOwnershipFacts, "externalOmp">>;
	/** Ask whether to open a session another process outside this extension holds (ADR-0046); `false` on Cancel. */
	confirmOpenAnyway(): Promise<boolean>;
	/** The Sessions tree provider this window created, when it has one. */
	launcherProvider(): Pick<SessionTreeProvider, "refreshOwnership"> | undefined;
	/** The indexed row one row command names, falling back to the editor in front. */
	sessionTarget(index: SessionIndex, argument: unknown): { readonly tabId: string; readonly entry: SessionIndexEntry } | null;
	/** Select the active session in the Sessions view. */
	revealActiveSession(index: SessionIndex): Promise<void>;
}

/** The editors, the conversation pages and the modules that act on them. */
export interface SessionFlowsEditors<Tab extends SessionFlowsTab> {
	editorPanels(): Pick<EditorPanels, "openPanel" | "renderPanelDocument">;
	bridgeHost(): Pick<BridgeHost<Tab>, "prepareDocument">;
	guestDispatcher(): Pick<GuestDispatcher<Tab>, "presentUnavailable" | "carryDraftFrom" | "captureDraft" | "releaseCarriedDraft">;
	/** Stop the verified writer or a recorded host after the caller's one confirmation. */
	sessionActions(): Pick<SessionActions, "stopVerifiedOwnedWriter" | "stopHost">;
	/** Make VS Code show the editor of a tab this window already holds a panel for. */
	revealExistingTab(index: SessionIndex, tabId: string, panel: vscode.WebviewPanel): Promise<void>;
	/** Select an editor VS Code restored but never showed, and wait for it to hand over its panel. */
	reviveEditorPanel(index: SessionIndex, tabId: string): Promise<{ readonly selected: boolean; readonly panel: vscode.WebviewPanel | null }>;
	/** Publish this window's editor as the conversation's controller once it holds it. */
	electLocalController(index: SessionIndex, tabId: string): Promise<void>;
	/** Point every editor showing one conversation at its route (after its host or view changed). */
	attachChatRoutes(tabId: string, force?: boolean): void;
	/** Tell every editor the view facts of one tab (title, running, switchable). */
	pushSessionView(index: SessionIndex | null, state: Tab, force?: boolean): void;
	/** Issue keyboard intent to a Terminal editor that was just activated. */
	activateNativeEditor(state: Tab): void;
	/** Publish the editor-in-front facts the keybinding contexts read. */
	refreshGuestContext(): void;
	/** Show a restore outcome in the launcher, elect the controller and present what is not a running host. */
	handleRestoreOutcome(context: vscode.ExtensionContext, index: SessionIndex, tabId: string, outcome: RestoreOutcome): Promise<void>;
}

/** The dialogs of `vscode.window` the flows ask the user through. */
export interface SessionFlowsDialogs {
	/** A message with options (a modal confirmation) and the buttons it offers. */
	showWarningMessage(message: string, options: vscode.MessageOptions, ...items: string[]): Thenable<string | undefined>;
	/** A message with only the buttons it offers. */
	showWarningActions(message: string, ...items: string[]): Thenable<string | undefined>;
}

/** The log and the notifications. Notifications carry the extension's own prefix. */
export interface SessionFlowsNotices {
	log: Logger;
	warn(message: string): void;
	error(message: string): void;
}

export interface SessionFlowsDeps<Tab extends SessionFlowsTab = SessionFlowsTab>
	extends SessionFlowsWindow<Tab>, SessionFlowsProgress, SessionFlowsRuntime<Tab>, SessionFlowsLauncher, SessionFlowsEditors<Tab>,
		SessionFlowsDialogs, SessionFlowsNotices {}

/** What the extension calls into the session flows. */
export interface SessionFlows<Tab extends SessionFlowsTab = SessionFlowsTab> {
	/**
	 * Open or focus one indexed tab.
	 *
	 * An editor that is already showing a running host is revealed and nothing else
	 * happens: a second restore of one row is what the index refuses as a duplicate,
	 * and a second panel is a second guest for one seat. Otherwise this is a real
	 * open — a row with no editor yet, a draft whose editor VS Code restored but
	 * whose host only an explicit action may start, or a row whose own restore was
	 * refused or failed. A second click joins the attempt already in flight, and
	 * `openPanel` reuses an editor that already exists, so the attempt always reports
	 * into the panel the user is looking at. `keepLiveView` (a launch another window asked for)
	 * never switches a writer's view afterwards: a new launch is created in the requested view
	 * (`openTabOnce` takes it), while a writer that is live when the call arrives, that a launch
	 * already in flight or the startup restoration brings up, or that the attempt only adopts, is
	 * revealed and left as it is.
	 */
	openTab(
		context: vscode.ExtensionContext,
		index: SessionIndex,
		tabId: string,
		verb: "started" | "opened" | "resumed",
		openIntent?: "explicit" | "restored",
		requestedMode?: SessionViewMode,
		externalConfirmed?: boolean,
		keepLiveView?: boolean,
		externalRowClicked?: boolean,
	): Promise<void>;
	/**
	 * Open (a stopped row launches) or show (a live row reveals its editor, reopening it when only the tab
	 * was closed) one session in an explicit view. Both verbs are the same admitted path; only the wording differs.
	 * `noRouting` keeps it in this window; `revealIfLive` (a launch another window asked for) leaves the view of a session that is live here alone.
	 */
	openSessionInMode(context: vscode.ExtensionContext, index: SessionIndex, argument: unknown, mode: SessionViewMode, verb?: "open" | "show", noRouting?: boolean, revealIfLive?: boolean): Promise<void>;
	/**
	 * Change an editor's view (Chat or Terminal): the editor says so from the click, with the step. A stopped session's change ends in a launch
	 * (`openTab`), so it is a `resume` and joins the attempt its caller may already have begun; a live one is a `view-switch`.
	 */
	switchSessionMode(context: vscode.ExtensionContext, index: SessionIndex, state: Tab, mode: SessionViewMode, reload?: boolean, keepLiveView?: boolean): Promise<void>;
	/** Explicit owned-Chat recovery from an unanswered state request or a process that no longer serves this conversation; never asks that native dispatcher to settle. */
	restartChat(context: vscode.ExtensionContext, index: SessionIndex, tabId: string, nativeNonce: string, requestId: string): Promise<void>;
	/**
	 * The Resume button of a stopped or view-only Chat: start the session again through the same
	 * admission as the Sessions row's Open (`openTab` → `index.restore`: ownership, claim and
	 * one-writer checks), then report the outcome.
	 *
	 * A successful start shows itself — the conversation is attached again and the composer
	 * becomes writable. Anything else is told to the page in its footer, with the reason the
	 * admission gave, so the button is never answered with silence.
	 */
	resumeFromChat(context: vscode.ExtensionContext, index: SessionIndex, tabId: string, requestId: string): Promise<void>;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** What a refused view switch tells the user; `null` when the refusal is silent because the flow was superseded. */
function viewSwitchRefusal(code: ReplaceRefusal, detail: string | undefined): string | null {
	switch (code) {
		case "target-changed": case "no-control": return null;
		case "facts-changed": return "The OMP target or busy state changed while the action was pending; nothing was stopped.";
		case "not-durable": return "The conversation is not durable yet; nothing was stopped.";
		case "no-broker": return "The exact writer's broker/root identity cannot be proven; nothing was stopped.";
		case "native-refused": return `Native shutdown was refused (${detail ?? "unknown"}); nothing was replaced.`;
		case "abort-unconfirmed": return "Abort was not confirmed; no replacement was started.";
		case "settle-failed": return "RPC did not settle on the captured session; nothing was replaced.";
		case "checked-after-stop": return null;
	}
}

export function registerSessionFlows<Tab extends SessionFlowsTab>(deps: SessionFlowsDeps<Tab>): SessionFlows<Tab> {
	const {
		log, warn: showWarning, error: showError, tab: stateOf, tabState, passiveReasonForSlot, defaultSessionMode, pendingEntry, timedLaunch,
		hostOf, recordOf, recordFor, controlOf, fencedOf, liveAt, beginTransition, withSessionReadDeadline, ensureTerminalPipeline,
		refreshLauncher, launcherFacts, launcherOwnershipFacts, sessionTarget: sessionTargetFromArgument, revealActiveSession,
		revealExistingTab, electLocalController, attachChatRoutes, pushSessionView, activateNativeEditor, refreshGuestContext,
		handleRestoreOutcome,
	} = deps;

	async function openTab(
		context: vscode.ExtensionContext,
		index: SessionIndex,
		tabId: string,
		verb: "started" | "opened" | "resumed",
		openIntent: "explicit" | "restored" = "explicit",
		requestedMode?: SessionViewMode,
		externalConfirmed = false,
		keepLiveView = false,
		externalRowClicked = false,
	): Promise<void> {
		// The user's own Open supersedes a request's deferral of this tab's restore.
		if (openIntent === "explicit") deps.routing().consumeRequestedSelection(tabId);
		// Explicit mode actions use switchSessionMode; ordinary Open never changes a live editor.
		// The folder list may still be receiving the predecessor build's folders, so every
		// explicit open waits for that one pass to settle before it resolves anything.
		deps.pending().step(tabId, "waiting");
		await deps.ensureCatalogReady();
		// A chat whose process ended shows the ended state before its exit cleanup is finished, and offers Resume at once. A click
		// in that gap would find the dead runtime still in place, take the session for one already running here and start nothing,
		// so every open waits for the cleanup of the runtime that ended, then for the tab's queued lifecycle work (src/host/runtime-settle.ts).
		const ending = hostOf(stateOf(tabId)) ?? null;
		if (ending !== null && ending.kind === "chat" && deps.sessionRuntime().conversations.stateOf(tabId)?.phase === "stopped") {
			const settled = await awaitEndedRuntimeCleanup({
				holdsEndedRuntime: () => hostOf(stateOf(tabId)) === ending,
				drainLifecycle: () => index.lifecycle.run(tabId, async () => undefined),
				pause: ms => delayMs(ms),
				now: () => Date.now(),
			}, 15_000);
			if (!settled) log.warn(`tab ${tabId}: the exit cleanup of the ended session had not finished after 15 s; the open continues without it`);
		}
		// Number this request before it can wait: a close during the wait overrides
		// it, while a subsequent explicit click is a new request to open the editor.
		const intent = tabState(tabId);
		intent.lastOpenRequest = deps.nextEditorEvent();
		// A new editor uses today's preference even when its conversation still has a
		// writer. Reattachment first discovers that writer's actual mode; the guarded
		// switch below then applies the requested view without overlapping writers.
		const existing = stateOf(tabId);
		const mode = requestedMode ?? (openIntent === "explicit" && existing?.panel == null &&
			!(existing !== undefined && deps.liveEditors().has(existing.slotId))
			? defaultSessionMode(context) : undefined);
		const inFlight = deps.openingTabs().get(tabId);
		if (inFlight !== undefined) {
			// A later click is its own editor request even while the first native
			// attempt is pending. Show a missing editor now; the shared attempt will
			// still perform exactly one restore, and a subsequent close cancels focus.
			const row = index.get(tabId);
			if (row !== null && (stateOf(tabId)?.panel ?? null) === null) {
				tabState(tabId).editorOfAttempt = true;
				deps.editorPanels().openPanel(context, index, tabId);
				refreshLauncher();
			}
			const inFlightVerb = tabState(tabId).openingVerb;
			await inFlight;
			// The second click of a double click on a stopped row arrives while the first click's history view is still being opened. It is a
			// launch request: the history view it joined is over, so the launch runs now (the row already says `Starting`) instead of being dropped.
			if (verb === "resumed" && inFlightVerb === "opened") {
				await openTab(context, index, tabId, verb, openIntent, requestedMode, externalConfirmed, keepLiveView, externalRowClicked);
				return;
			}
			if (intent.lastOpenRequest > intent.lastEditorClose) {
				const published = stateOf(tabId)?.panel ?? null;
				if (published !== null) await revealExistingTab(index, tabId, published);
			}
			const published = stateOf(tabId);
			if (!keepLiveView && mode !== undefined && published !== undefined && hostOf(published) != null && published.mode !== mode) await switchSessionMode(context, index, published, mode);
			return;
		}
		const state = stateOf(tabId) ?? null;
		if (state !== null && state.panel !== null && hostOf(state) !== null) {
			// This window already runs this session, so nothing native is attempted — but the
			// editor showing it must still end up controlling it, in case its election was
			// refused earlier (before this window held the writer) and never retried.
			await electLocalController(index, tabId);
			await revealExistingTab(index, tabId, state.panel);
			if (!keepLiveView && mode !== undefined && mode !== state.mode) await switchSessionMode(context, index, state, mode);
			return;
		}
		const attempt = openTabOnce(context, index, tabId, verb, openIntent, mode, externalConfirmed, externalRowClicked);
		deps.openingTabs().set(tabId, attempt);
		tabState(tabId).openingVerb = verb;
		try {
			await attempt;
		} finally {
			if (deps.openingTabs().get(tabId) === attempt) { deps.openingTabs().delete(tabId); tabState(tabId).openingVerb = null; }
			tabState(tabId).editorOfAttempt = false;
		}
		const published = stateOf(tabId);
		if (published !== undefined) {
			pushSessionView(index, published);
			if (!keepLiveView && mode !== undefined && hostOf(published) !== null && published.mode !== mode) await switchSessionMode(context, index, published, mode);
		}
	}

	/** One tab's open attempt; {@link openTab} serializes every caller onto it. */
	async function openTabOnce(
		context: vscode.ExtensionContext,
		index: SessionIndex,
		tabId: string,
		verb: "started" | "opened" | "resumed",
		intent: "explicit" | "restored" = "explicit",
		requestedMode?: SessionViewMode,
		externalConfirmed = false,
		/** The click was on a row displayed as held by a plain omp process outside this extension: it asks (ADR-0046) even for a stopped row's history view. */
		externalRowClicked = false,
	): Promise<void> {
		// Wait for the activation pass before touching this tab: it may be restoring
		// the very row this click is for, and a second restore of one row is what the
		// index refuses as a duplicate. No tab lifecycle is held while waiting — this
		// is only the pass's own completion — and ownership is still decided by the
		// index afterwards, exactly as for any other open.
		const startup = deps.startupRestore();
		if (startup !== null && startup.cohort.has(tabId)) {
			deps.pending().step(tabId, "waiting");
			await startup.settled;
			// The pass is this row's one authoritative native attempt. When it connected
			// a host — and this tab's editor was restored meanwhile, which is the ordinary
			// case for a row that was open when the app closed — this click only brings
			// that editor forward. When it refused or failed, the click is an ordinary
			// open of the row as it now is: the index re-derives its verdict from current
			// facts rather than from the pass's own failure, which says nothing about who
			// owns the session.
			const connected = stateOf(tabId)?.panel ?? null;
			const runtime = hostOf(stateOf(tabId)) ?? null;
			if (verb !== "resumed" && connected !== null && runtime !== null) {
				await revealExistingTab(index, tabId, connected);
				return;
			}
		}
		const recorded = index.get(tabId);
		const row = recorded;
		if (row === null) {
			showError("This session is no longer in Sessions. Refresh and try again.");
			return;
		}
		const opening = tabState(tabId);
		opening.openDeclined = false;
		const opened = hostOf(opening);
		if (opened !== null) opening.mode = opened.kind;
		else if (requestedMode !== undefined) opening.mode = requestedMode;
		else if (opening.panel === null) opening.mode = intent === "restored" || deps.liveEditors().has(opening.slotId)
			? index.slotBinding(opening.slotId)?.mode ?? defaultSessionMode(context)
			: defaultSessionMode(context);
		// The wait above is where a resume can undo what the user did: the editor VS
		// Code restored may have been closed while this attempt waited. An editor the
		// user closed is not reopened by the attempt's continuation — but a click that
		// arrived after that close is an ordinary open of a row without an editor, and
		// it does open one. The rest of the attempt runs either way, so the row is
		// reconciled exactly once and a refused or failed restore is still retried.
		if (tabState(tabId).lastOpenRequest <= tabState(tabId).lastEditorClose) {
			log.debug(`tab ${tabId}: its editor was closed while this open was waiting; no editor is opened for it`);
		} else {
			// The editor is created (or revealed) before anything native or any question: it is where the user sees
			// whatever comes next (the saved history, the step in progress, a question about another process), and a
			// launch that is slow or cannot start must not delay the chat surface or hide the reason it is unavailable.
			// This is the ADR-0046 amendment: the editor no longer waits for the ownership checks.
			if (opening.panel === null) opening.editorOfAttempt = true;
			deps.editorPanels().openPanel(context, index, tabId);
			deps.launchTimeline().lap(tabId, "panel");
			refreshLauncher();
		}
		const openedState = stateOf(tabId);
		if (openedState !== undefined && hostOf(openedState) != null) {
			await electLocalController(index, tabId);
			pushSessionView(index, openedState);
			return;
		}
		// History is painted from the session file on disk while the process starts: the page
		// shows the saved transcript at once, read-only, and the live conversation replaces it
		// when the process is ready. Nothing here claims, launches or writes.
		if (opening.mode === "chat" && row.sessionFile !== null && deps.sessionRuntime().conversations.kindOf(tabId) !== "live") {
			void deps.sessionRuntime().conversations
				.showViewOnly(tabId, {
					file: row.sessionFile, cwd: row.cwd, title: row.title,
					reason: row.runIntent === "stopped" && verb === "opened" ? "This session is stopped." : "Starting the session…",
					phase: "resyncing",
				})
				.then(() => {
					// The live conversation may already have replaced this placeholder.
					if (deps.sessionRuntime().conversations.kindOf(tabId) === "view-only") attachChatRoutes(tabId, true);
				});
		}
		/** A Cancel starts nothing and writes nothing. The editor this attempt created is closed again unless the row is stopped (its startup restore never starts a stopped row). */
		const declined = (): void => {
			opening.openDeclined = true;
			if (opening.editorOfAttempt && index.get(tabId)?.runIntent !== "stopped") opening.panel?.dispose();
		};
		let stoppedForOpen = false;
		if (intent === "explicit" && hostOf(stateOf(tabId)) == null && recorded?.host != null && !isManagedHost(recorded.host) && (verb === "resumed" || verb === "opened")) {
			deps.pending().step(tabId, "ownership");
			const pid = await deps.sessionRuntime().verifiedWriterPid(tabId);
			if (pid !== null) {
				const label = "Stop and Open";
				deps.pending().step(tabId, "confirm");
				const choice = await deps.showWarningMessage(
					"Stop the running session and open it here?",
					{ modal: true, detail: "Unsaved replies and work in progress may be lost." },
					label,
				);
				if (choice !== label || !(await deps.sessionActions().stopVerifiedOwnedWriter(context, index, tabId, pid))) { declined(); return; }
				stoppedForOpen = verb === "opened";
			}
		}
		// A plain omp outside this extension that writes this session is not replaced or joined silently:
		// an explicit attempt that can launch a writer asks first (a Resume, or an Open of a row whose
		// run intent is not stopped), and OMP then saves to a sibling file (ADR-0046). A click on a row that
		// shows such a process asks even for a stopped row's history view. Any other stopped row's plain Open and
		// history views start no writer here, so they never ask.
		if (intent === "explicit" && (externalRowClicked || verb === "resumed" || recorded?.runIntent !== "stopped") && !externalConfirmed && hostOf(stateOf(tabId)) == null) {
			deps.pending().step(tabId, "ownership");
			const fresh = await launcherOwnershipFacts(index, tabId, { fresh: true });
			if (fresh.externalOmp === true) {
				deps.pending().step(tabId, "confirm");
				if (!(await deps.confirmOpenAnyway())) {
					deps.launcherProvider()?.refreshOwnership(new Set([tabId]));
					declined();
					return;
				}
				// Open Anyway is the user's explicit launch, so it resumes (OMP then saves to a sibling file instead of mixing writes).
				if (externalRowClicked) verb = "resumed";
			} else if (externalRowClicked) {
				deps.launcherProvider()?.refreshOwnership(new Set([tabId]));
			}
		}
		if (index.get(tabId) === null) {
			showError("This session is no longer in Sessions. Refresh and try again.");
			return;
		}
		let outcome: RestoreOutcome;
		deps.pending().step(tabId, "admission");
		try {
			// Restoring the editor or opening stopped history never lifts its stopped intent.
			// Only Resume (or explicitly starting a draft with no history) may do that.
			const editorSlot = stateOf(tabId)?.slotId;
			outcome = await deps.sessionRuntime().open({
				conversation: tabId,
				mode: opening.mode,
				allowStoppedResume: intent === "explicit" && (verb !== "opened" || stoppedForOpen),
				...(editorSlot === undefined ? {} : { editorBinding: { slot: editorSlot } }),
			});
		} catch (error) {
			deps.guestDispatcher().presentUnavailable(index, tabId, messageOf(error));
			showError(`The OMP session could not be ${verb}: ${messageOf(error)}`);
			return;
		}
		await handleRestoreOutcome(context, index, tabId, outcome);
		const publishedState = stateOf(tabId);
		if (publishedState !== undefined) pushSessionView(index, publishedState);
		void revealActiveSession(index);
	}

	async function openSessionInMode(context: vscode.ExtensionContext, index: SessionIndex, argument: unknown, mode: SessionViewMode, verb: "open" | "show" = "open", noRouting = false, revealIfLive = false): Promise<void> {
		const commandAt = Date.now();
		const target = sessionTargetFromArgument(index, argument);
		if (target === null) { showWarning(`Select an OMP session to ${verb}.`); return; }
		if (!noRouting && !launcherFacts(target.tabId).running) {
			// A session another window holds is switched to, as for a click; the claim is read afresh, before anything is asked of the user.
			if (await deps.routing().heldByAnotherWindow(index, target.tabId)) {
				await deps.routing().switchToWindow(index, target.tabId);
				return;
			}
			// A session of a folder that only another window has open is opened there, in the same view (ADR-0057).
			if (await deps.routing().routeOpen(index, target.tabId, "resumed", mode)) return;
		}
		let state = stateOf(target.tabId);
		// A tab VS Code has not shown since the window loaded has no panel handle yet; showing it is what creates one.
		if (state !== undefined && state.panel === null) {
			await deps.reviveEditorPanel(index, target.tabId);
			state = stateOf(target.tabId);
		}
		if (state?.panel != null) {
			await revealExistingTab(index, target.tabId, state.panel);
			// A launch another window asked for never changes the view of a session that is live here, even one that went live while this waited.
			if (revealIfLive && (hostOf(state) !== null || launcherFacts(target.tabId).running)) return;
			// A live session's view change is a mode switch, which is not a launch the user is waiting on; a stopped one is.
			const view = state;
			if (hostOf(view) === null) await timedLaunch(target.tabId, "open", commandAt, () => switchSessionMode(context, index, view, mode, false, revealIfLive));
			else await switchSessionMode(context, index, view, mode, false, revealIfLive);
			return;
		}
		if (state?.bridge != null && deps.liveEditors().has(state.bridge.editorId)) {
			showWarning("This tab was kept running while OMP restarted in the background, so its view cannot be changed from here. Run “Developer: Reload Window”, then try again.");
			return;
		}
		await timedLaunch(target.tabId, "open", commandAt, () => openTab(context, index, target.tabId, "resumed", "explicit", mode, false, revealIfLive));
	}

	async function switchSessionMode(context: vscode.ExtensionContext, index: SessionIndex, state: Tab, mode: SessionViewMode, reload = false, keepLiveView = false): Promise<void> {
		const tabId = state.tabId;
		if (tabId === null || state.panel === null) return switchSessionModeNow(context, index, state, mode, reload, keepLiveView);
		await pendingEntry(tabId, hostOf(state) === null ? "resume" : "view-switch", { origin: "composer", step: "checking" }, () => switchSessionModeNow(context, index, state, mode, reload, keepLiveView));
	}

	/** One editor, one held claim, positively non-overlapping exact root generations. */
	async function switchSessionModeNow(context: vscode.ExtensionContext, index: SessionIndex, state: Tab, mode: SessionViewMode, reload = false, keepLiveView = false): Promise<void> {
		if (state.tabId === null || state.panel === null || fencedOf(state) || passiveReasonForSlot(state.slotId) !== null || deps.openingTabs().has(state.tabId)) {
			showWarning("This editor cannot change views while the session is starting or stopping, or another editor controls it.");
			return;
		}
		const modeRequest = state.lastOpenRequest = deps.nextEditorEvent();
		const runtime = hostOf(state);
		if (runtime === null) {
			deps.pendingSessionViewChanges().set(state, modeRequest);
			state.mode = mode;
			recordFor(state).controlFailure = null;
			pushSessionView(index, state);
			try {
				await index.setEditorMode(state.slotId, mode);
				refreshGuestContext();
				state.document = null;
				if (state.bridge !== null) await deps.bridgeHost().prepareDocument(context, state.bridge.editorId);
				deps.editorPanels().renderPanelDocument(context, state.slotId);
				await openTab(context, index, state.tabId, "resumed", "explicit", undefined, false, keepLiveView);
			} finally {
				if (deps.pendingSessionViewChanges().get(state) === modeRequest) deps.pendingSessionViewChanges().delete(state);
				pushSessionView(index, state);
			}
			return;
		}
		if (runtime.kind === mode && !reload) {
			if (runtime.kind === "terminal") {
				try {
					await runtime.handle.refreshStatus();
					if (hostOf(state) !== runtime || state.panel === null) return;
					if (runtime.handle.state === "exited") {
						await deps.sessionRuntime().exit.nativeExited(recordFor(state), runtime);
						if (hostOf(state) === null) await switchSessionMode(context, index, state, mode);
						else showWarning("This Terminal has stopped but could not be reopened safely. Use Stop in Processes, then open the session again.");
						return;
					}
					ensureTerminalPipeline(index, state.slotId, runtime.handle);
					await runtime.handle.attach();
					pushSessionView(index, state, true);
					activateNativeEditor(state);
				} catch (error) {
					log.error(`tab ${state.tabId}: Terminal reopen failed: ${messageOf(error)}`);
					showWarning("This Terminal could not be reconnected. Use Stop in Processes, then open the session again.");
				}
			}
			return;
		}
		const tabId = state.tabId;
		deps.pendingSessionViewChanges().set(state, modeRequest);
		refreshGuestContext();
		let acceptedStop = false;
		let token: TransitionToken | null = null;
		const target = deps.sessionRuntime().snapshot(tabId)?.attachment ?? -1;
		let replacement: RestoreOutcome | null = null;
		let carried: CarriedDraft<Tab> | null = null;
		try {
			const live = runtime.kind === "chat" ? deps.sessionRuntime().conversations.liveOf(tabId) : null;
			const pending: Promise<unknown> | undefined = runtime.kind === "terminal" ? deps.sessionRuntime().control.attempt(runtime)
				: live !== null && (live.phase === "starting" || live.phase === "attaching" || live.phase === "resyncing")
					? deps.sessionRuntime().conversations.join(tabId, live.incarnation) : undefined;
			if (pending !== undefined) {
				// Control publication needs the gate: join initialization outside it.
				const panel = state.panel;
				await withSessionReadDeadline(pending);
				if (state.lastOpenRequest !== modeRequest || hostOf(state) !== runtime || state.tabId !== tabId || state.panel !== panel ||
						passiveReasonForSlot(state.slotId) !== null || deps.openingTabs().has(tabId) ||
						(runtime.kind === "chat" && deps.sessionRuntime().conversations.incarnationOf(tabId) !== (live?.incarnation ?? null))) return;
			}
			const control = controlOf(state);
			if (runtime.kind === "terminal" && control !== null) {
				try {
					const observed = await withSessionReadDeadline(control.client.nativeState());
					runtime.observed = observed;
					if (observed.available) await deps.sessionRuntime().nativeWatch.observe(recordFor(state), runtime, observed);
				} catch { /* Unavailable control is refused at the fenced boundary below. */ }
			}
			if (state.tabId !== tabId || state.lastOpenRequest !== modeRequest || hostOf(state) !== runtime || passiveReasonForSlot(state.slotId) !== null) return;
			const binding = index.slotBinding(state.slotId);
			if (binding === null || binding.tabId !== tabId) return;
			const held = token = beginTransition(tabId, {
				check: () => state.lastOpenRequest === modeRequest && passiveReasonForSlot(state.slotId) === null,
				async prepare() {
					state.mode = mode;
					recordFor(state).controlFailure = null;
					pushSessionView(index, state);
					state.document = null;
					if (state.bridge !== null) await deps.bridgeHost().prepareDocument(context, state.bridge.editorId);
					deps.editorPanels().renderPanelDocument(context, state.slotId);
				},
			});
			const captured = await deps.sessionRuntime().readTransitionFacts({ conversation: tabId, target, token: held, bounded: true });
			if (captured === null) {
				// The facts of a session whose process already ended (killed from outside, crashed) cannot be read: end it as its exit
				// would and take the request as one for a stopped session, which Resumes it in the requested view.
				if (state.lastOpenRequest === modeRequest && await deps.sessionRuntime().endEnded(tabId, target)) {
					await switchSessionMode(context, index, state, mode, false, keepLiveView);
					return;
				}
				showWarning(runtime.kind === "terminal" ? "Native control is unavailable. Use native /exit or explicit force Stop (tree unknown); no automatic replacement follows uncontrolled force." : "The current RPC session state could not be verified; nothing was stopped.");
				return;
			}
			const row = index.get(tabId);
			if (row === null) return;
			if (runtime.kind === "terminal" && (captured.sessionId !== row.sessionId || (row.sessionFile !== null && (captured.file === null || !controlPathEquals(captured.file, row.sessionFile))))) {
				showWarning("Native OMP serves a different observed conversation, but its row could not be rebound. Nothing was stopped; retry after the native session is available.");
				return;
			}
			const beforeFile = captured.file === null ? null : await readSessionFileHeader(captured.file);
			if (beforeFile === null && (row.sessionFile !== null || captured.hasContent !== false)) {
				showError("This session has conversation content or an unknown content state without a durable file. Nothing was stopped; the extension cannot materialize it.");
				return;
			}
			let consent = false;
			if (!captured.settled || reload) {
				const label = reload ? "Reload" : `Switch to ${mode === "chat" ? "Chat" : "Terminal"}`;
				deps.pending().step(tabId, "confirm", "view-switch");
				consent = await deps.showWarningMessage(
					reload ? "Reload this OMP process in the same view?" : `OMP is busy. Abort the current turn and switch to ${mode === "chat" ? "Chat" : "Terminal"}?`,
					{ modal: true, detail: "The current process must stop before the new view opens. Queued or background work may delay shutdown, and an accepted shutdown cannot be cancelled. In-flight tool effects may not be fully saved." },
					label,
				) === label;
				if (!consent) return;
			}
			carried = state.mode === "chat" ? await deps.guestDispatcher().carryDraftFrom(state.panel) : null;
			if (carried !== null) deps.draftRestores().set(state.slotId, carried);
			deps.pending().step(tabId, "working", "view-switch");
			deps.launchTimeline().begin(tabId, "view switch");
			const result = await deps.sessionRuntime().replaceWriter({
				conversation: tabId, token: held, target, mode, binding: { slot: state.slotId, generation: binding.generation },
				stop: { kind: "graceful", consent, captured }, bounded: true,
			});
			acceptedStop = result.stopDispatched;
			switch (result.status) {
				case "replaced": replacement = result.outcome; break;
				case "failed": throw new Error(result.detail);
				case "unconfirmed":
					recordFor(state).controlFailure = result.detail;
					showWarning(result.detail);
					break;
				case "closed": showError("The durable session file disappeared after disposal; no replacement was started."); break;
				case "refused": {
					const sentence = viewSwitchRefusal(result.code, result.detail);
					if (sentence !== null) showWarning(sentence);
					break;
				}
			}
			if (replacement !== null) await handleRestoreOutcome(context, index, tabId, replacement);
		} catch (error) {
			const superseded = state.lastOpenRequest !== modeRequest;
			if (!superseded) state.lastOpenRequest = deps.nextEditorEvent();
			log.error(`tab ${tabId}: view switch failed: ${messageOf(error)}`);
			// A read or an abort that timed out on a process that already ended is not a failed switch: finish it as a Resume.
			if (!superseded && !acceptedStop && hostOf(state) === runtime && await deps.sessionRuntime().endEnded(tabId, target)) {
				await switchSessionMode(context, index, state, mode, false, keepLiveView);
				return;
			}
			const failure = acceptedStop
				? "The view switch could not finish because the session has not been confirmed stopped. Use Stop Session to recover."
				: "The view switch could not finish. The current view is still available; try switching again.";
			recordFor(state).controlFailure = failure;
			showWarning(failure);
		} finally {
			if (carried !== null && state.document === carried.document) {
				deps.guestDispatcher().releaseCarriedDraft(carried);
				if (deps.draftRestores().get(state.slotId) === carried) deps.draftRestores().delete(state.slotId);
			}
			deps.launchTimeline().abandon(tabId);
			if (deps.pendingSessionViewChanges().get(state) === modeRequest) deps.pendingSessionViewChanges().delete(state);
			if (token !== null) deps.sessionRuntime().endTransition(token, "dispatched-stop");
			else pushSessionView(index, state);
			refreshGuestContext();
			refreshLauncher();
			if (acceptedStop && hostOf(state) === runtime) {
				void deps.showWarningActions(
					"The session is still stopping. Stop it before trying the view switch again.",
					"Stop Session",
				).then(action => {
					if (action === "Stop Session" && hostOf(state) === runtime) return deps.sessionActions().stopHost(context, index, tabId, undefined, "view-switch");
				}).then(undefined, error => {
					log.error(`tab ${tabId}: view switch recovery failed: ${messageOf(error)}`);
					showWarning("The session could not be stopped from this editor. Use Stop in Processes, then reopen the session.");
				});
			}
		}
	}

	async function restartChat(context: vscode.ExtensionContext, index: SessionIndex, tabId: string, nativeNonce: string, requestId: string): Promise<void> {
		const state = stateOf(tabId);
		const runtime = hostOf(state);
		const conversations = deps.sessionRuntime().conversations;
		const live = conversations.liveOf(tabId);
		const row = index.get(tabId);
		const binding = state === undefined ? null : index.slotBinding(state.slotId);
		const committed = restartBinding(index, tabId);
		const document = state?.document;
		const panel = state?.panel;
		const refuse = (text: string): void => { deps.sessionRuntime().conversations.notify(tabId, text); showWarning(text); };
		if (state === undefined || runtime?.kind !== "chat" || live === null || !live.restartOffered ||
				live.epoch.nonce !== nativeNonce || state.mode !== "chat" || document?.kind !== "guest" || panel == null ||
				row?.sessionFile == null || row.sessionId === null || binding === null || committed === null ||
				runtime.identity.childCreationTime === null || passiveReasonForSlot(state.slotId) !== null ||
				fencedOf(state) || deps.pendingSessionViewChanges().has(state) || deps.openingTabs().has(tabId)) {
			refuse("Restart requires this controlling Chat editor, an OMP process that does not answer or no longer serves this conversation, and its exact saved conversation. Nothing was stopped.");
			return;
		}
		const pendingRestart = deps.pending().begin(tabId, "restart", { origin: "composer", requestId, step: "checking" });
		const file = row.sessionFile;
		const sessionId = row.host?.sessionId ?? row.sessionId;
		const durableSessionId = row.sessionId;
		const creationTime = runtime.identity.childCreationTime;
		const modeRequest = deps.nextEditorEvent();
		state.lastOpenRequest = modeRequest;
		deps.pendingSessionViewChanges().set(state, modeRequest);
		let carried: CarriedDraft<Tab> | null = null;
		let stopRequested = false;
		let writerGone = false;
		let replacement: RestoreOutcome | null = null;
		const sameTarget = (requireOffered: boolean): boolean => {
			const current = index.get(tabId);
			const currentBinding = index.slotBinding(state.slotId);
			const currentCommitted = restartBinding(index, tabId);
			const now = liveAt(tabId, live.incarnation);
			return stateOf(tabId) === state && hostOf(state) === runtime && state.tabId === tabId &&
				state.lastOpenRequest === modeRequest && state.panel === panel && state.document === document &&
				state.mode === "chat" && passiveReasonForSlot(state.slotId) === null &&
				currentBinding?.generation === binding.generation && currentBinding.role === "controlling" &&
				currentBinding.tabId === tabId && current?.sessionFile === file && current.sessionId === durableSessionId &&
				current.availability === "live" && current.host?.pid === runtime.pid && current.host.sessionId === sessionId &&
				current.host.rpc?.childCreationTime === creationTime && current.ownership !== null &&
				current.ownership.releasedAt === null && current.ownership.ownerGeneration === committed.ownerGeneration &&
				currentCommitted !== null && bindingMatches(committed, currentCommitted) &&
				committed.pid === runtime.pid && committed.processCreation === creationTime &&
				committed.slot === runtime.identity.slot && committed.brokerId === runtime.identity.brokerId &&
				committed.brokerGeneration === runtime.identity.brokerGeneration && committed.sessionFile === file &&
				committed.sessionId === durableSessionId && now !== null &&
				now.epoch.nonce === nativeNonce && now.sessionFile !== null && controlPathEquals(now.sessionFile, file) &&
				now.sessionId === sessionId && (!requireOffered || now.restartOffered);
		};
		const held = beginTransition(tabId, {
			check: phase => sameTarget(phase !== "stopped"),
			async prepare() {
				deps.draftRestores().set(state.slotId, carried as CarriedDraft<Tab>);
				recordFor(state).controlFailure = null;
				state.document = null;
				if (state.bridge !== null) await deps.bridgeHost().prepareDocument(context, state.bridge.editorId);
				deps.editorPanels().renderPanelDocument(context, state.slotId);
			},
		});
		const target = deps.sessionRuntime().snapshot(tabId)?.attachment ?? -1;
		try {
			const eligible = await index.lifecycle.run(tabId, async () => {
				const header = await readSessionFileHeader(file);
				return header?.sessionId === durableSessionId && sameTarget(true);
			});
			if (!eligible) { refuse("The saved conversation or controlling writer changed. Nothing was stopped."); return; }
			carried = await deps.guestDispatcher().captureDraft(state);
			if (carried === null || !sameTarget(true)) {
				refuse("Restart could not capture this editor's complete input: an image read or an edit is still pending, or the input is longer than 2 000 000 characters. Wait for a pending read or edit to finish and try again; nothing was stopped.");
				return;
			}
			const attachments = carried.reply.attachments + carried.reply.recoverable.reduce((count, original) => count + original.attachments, 0);
			const imageWarning = attachments === 0 ? "" : ` ${attachments} attachment reference${attachments === 1 ? "" : "s"} cannot be transferred; reattach the images to the preserved text after Restart.`;
			const unanswered = conversations.liveOf(tabId)?.nativeStateUnanswered === true;
			const identityWarning = unanswered ? "" : " It is the exact process recorded for this conversation, but it now reports another conversation or identity; stopping it also ends whatever it is running now.";
			deps.pending().step(tabId, "confirm");
			const consent = await deps.showWarningMessage(
				unanswered ? "Stop this unresponsive OMP process and restart its saved conversation?" : "Stop the OMP process that no longer serves this conversation and restart its saved conversation?",
				{ modal: true, detail: "Unconfirmed input may already have been admitted; it will be preserved, not resent. Unsaved replies and in-flight tool effects may be lost. Commands or tools started by OMP may continue running separately and still modify files. The exact old process must be confirmed stopped before the same saved conversation is reopened." + identityWarning + imageWarning },
				"Restart",
			);
			if (consent !== "Restart") return;
			deps.pending().step(tabId, "working");
			deps.launchTimeline().begin(tabId, "restart");
			const result = await deps.sessionRuntime().replaceWriter({
				conversation: tabId, token: held, target, mode: "chat",
				binding: { slot: state.slotId, generation: binding.generation }, stop: { kind: "force", file, durableSessionId },
			});
			stopRequested = result.stopDispatched;
			writerGone = result.writerGone;
			switch (result.status) {
				case "replaced": replacement = result.outcome; break;
				case "failed": throw new Error(result.detail);
				case "unconfirmed": {
					const text = "The exact OMP process could not be confirmed stopped. No successor was started; your original input remains here. Use Stop Session before retrying.";
					recordFor(state).controlFailure = text;
					refuse(text);
					break;
				}
				case "closed": refuse("The exact saved conversation is unavailable after the process stopped. No successor was started; your input remains in this editor."); break;
				case "refused":
					refuse(result.code === "no-broker" ? "The captured writer's broker is unavailable. Nothing was stopped."
						: result.code === "checked-after-stop" ? "The captured process stopped, but this editor or saved binding changed. No successor was started."
						: "The writer recovered or the editor or saved conversation changed while confirmation was open. Nothing was stopped.");
					break;
			}
			if (replacement !== null) await handleRestoreOutcome(context, index, tabId, replacement);
		} catch (error) {
			log.error(`tab ${tabId}: explicit Restart failed: ${messageOf(error)}`);
			const failure = writerGone
				? "The old process stopped, but Restart could not finish. The saved conversation and captured input are kept; reopen this session to recover."
				: stopRequested
					? "Restart could not confirm that the old process stopped. No successor was started; your input is kept. Use Stop Session to recover."
					: "Restart could not finish. Nothing was stopped; your input is kept.";
			recordFor(state).controlFailure = failure;
			refuse(failure);
		} finally {
			if (carried !== null && state.document === document) {
				deps.guestDispatcher().releaseCarriedDraft(carried);
				if (deps.draftRestores().get(state.slotId) === carried) deps.draftRestores().delete(state.slotId);
			}
			if (deps.pendingSessionViewChanges().get(state) === modeRequest) deps.pendingSessionViewChanges().delete(state);
			deps.sessionRuntime().endTransition(held, "dispatched-stop");
			deps.launchTimeline().abandon(tabId);
			pendingRestart.end(replacement !== null ? "running" : "failed");
			refreshGuestContext();
			refreshLauncher();
		}
	}

	/**
	 * The native binding Restart holds its target to: the one this tab's bridge document
	 * committed, or, when none was (a session that failed before it went live in this host,
	 * such as an identity failure right after Reload Window, never commits one), the same
	 * facts read from the row and the runtime. Nothing OMP reports is part of it.
	 */
	function restartBinding(index: SessionIndex, tabId: string): BridgeNativeBinding | null {
		const state = stateOf(tabId);
		const recorded = state?.bridge?.endpoint.committedBinding() ?? null;
		if (recorded !== null) return recorded;
		const entry = index.get(tabId);
		const runtime = hostOf(state);
		if (entry === null || runtime?.kind !== "chat" || entry.ownership === null || entry.ownership.releasedAt !== null ||
				entry.sessionFile === null || entry.sessionId === null || runtime.identity.childCreationTime === null) return null;
		return {
			ownerGeneration: entry.ownership.ownerGeneration,
			pid: runtime.pid,
			processCreation: runtime.identity.childCreationTime,
			slot: runtime.identity.slot,
			brokerId: runtime.identity.brokerId,
			brokerGeneration: runtime.identity.brokerGeneration,
			sessionId: entry.sessionId,
			sessionFile: entry.sessionFile,
		};
	}

	async function resumeFromChat(context: vscode.ExtensionContext, index: SessionIndex, tabId: string, requestId: string): Promise<void> {
		const commandAt = Date.now();
		const before = deps.outcomes().get(tabId);
		await pendingEntry(tabId, "resume", { origin: "composer", requestId }, async handle => {
			try {
				await timedLaunch(tabId, "resume", commandAt, () => openTab(context, index, tabId, "resumed"));
			} catch (error) {
				handle.end("failed");
				log.error(`tab ${tabId}: Resume from Chat failed: ${messageOf(error)}`);
				const reason = `The session could not be resumed: ${messageOf(error)}`;
				if (!deps.sessionRuntime().conversations.notify(tabId, reason) && !deps.sessionRuntime().conversations.has(tabId)) deps.guestDispatcher().presentUnavailable(index, tabId, reason);
				return;
			}
			const phase = deps.sessionRuntime().conversations.stateOf(tabId)?.phase ?? null;
			if (phase === "live" || phase === "starting" || phase === "attaching" || phase === "resyncing") return;
			handle.end("failed");
			const outcome = deps.outcomes().get(tabId);
			log.warn(`tab ${tabId}: Resume from Chat did not start the session (${outcome?.status ?? "no outcome"})`);
			// A refused, failed or conflicting admission already put its reason on the page (banner and, for a
			// conflict, an error): `handleRestoreOutcome` presents every outcome that is not a running host.
			if (outcome !== undefined && outcome !== before && outcome.status !== "restored" && outcome.status !== "attached") return;
			// The admission was never reached (the editor or row changed, or this window still holds a process it could not
			// prove gone): say so in the footer, or on the page itself when no conversation is shown.
			const reason = (recordOf(stateOf(tabId))?.controlFailure ?? null) ?? "The session could not be resumed. The OMP Desk output channel has details.";
			if (!deps.sessionRuntime().conversations.notify(tabId, reason) && !deps.sessionRuntime().conversations.has(tabId)) deps.guestDispatcher().presentUnavailable(index, tabId, reason);
		});
	}

	return { openTab, openSessionInMode, switchSessionMode, restartChat, resumeFromChat };
}
