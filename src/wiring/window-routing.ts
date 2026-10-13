/**
 * What this window does with the other windows of the profile: it publishes itself in the window
 * registry (ADR-0056), keeps the registry's picture current, hands a session or a launch to the
 * window that holds it or has its folder open (ADR-0056, ADR-0057), serves the requests other windows
 * address to it, and owns the file window it opened for files from the chat.
 *
 * The policies are in `window-registry.ts`, `window-requests.ts`, `holder-liveness.ts` and
 * `file-window.ts`; this module sequences them. It reads and writes nothing of the extension's own
 * state except through {@link WindowRoutingDeps}: the window registry, the launcher folders and rows,
 * the tab records and the launch paths are all the extension's, and arrive as getters and callbacks.
 * What it keeps itself is only what no other part of the extension reads: the moment this window was
 * last focused, the two request watches, the Unity project cache, the older-build windows already
 * announced and the file window.
 */

import * as path from "node:path";
import * as vscode from "vscode";
import { EDITOR_GROUP_FOCUS_COMMANDS, chatGroupColumn, filesGroupColumn } from "../host/chat-layout.ts";
import { appearedGroup, FILE_WINDOW_SIZE, FileWindowTracker } from "../host/file-window.ts";
import { holderSeemsAlive } from "../host/holder-liveness.ts";
import type { SessionIndex } from "../host/session-index.ts";
import type { ObservedClaim } from "../host/session-claim.ts";
import type { SessionViewMode } from "../host/session-model.ts";
import { UnityProjectCache, isUnityProject } from "../host/unity-project.ts";
import { PUBLISHED_ROW_STATUSES, sessionIncarnation } from "../host/window-registry.ts";
import type { OpenWindow, PublishedRow, PublishedRowStatus, WindowRegistry } from "../host/window-registry.ts";
import {
	LAUNCH_ANSWER_TIMEOUT_MS,
	PENDING_ANSWER_TIMEOUT_MS,
	RELOAD_ACCEPT_TIMEOUT_MS,
	REQUEST_ANSWER_TIMEOUT_MS,
	awaitPendingLaunchAnswer,
	awaitReloadTakenUp,
	awaitRequestAnswer,
	pendingKeyOf,
	planFolderLaunch,
	planWindowFocus,
	planWindowSwitch,
	postLaunchRequest,
	postModelsRequest,
	postPendingLaunch,
	postReloadRequest,
	postSwitchRequest,
	startPendingLaunchWatch,
	startRequestWatch,
	withdrawPendingLaunch,
	withdrawRequest,
} from "../host/window-requests.ts";
import type {
	LaunchAction,
	LaunchRequest,
	LaunchWorkspace,
	RefusalReason,
	ReloadRequest,
	RequestAnswer,
	RequestWatch,
	ServeContext,
	ServeOutcome,
	StopRequest,
	SwitchRequest,
	WindowFocusPlan,
} from "../host/window-requests.ts";
import type { LauncherFolder, LauncherFolders } from "../views/launcher-folders.ts";
import { folderHeadline, sessionItemState } from "../views/session-tree.ts";
import type { SessionLauncherFacts, SessionTreeProvider } from "../views/session-tree.ts";
import type { SessionProcesses } from "./process-wiring.ts";

/** How long an owner window waits to hold the focus before it tells a requester that it is not in front. */
const WINDOW_FOCUS_WAIT_MS = 1_500;
/** A request is read as soon as its file shows up (the watch's default of 150 ms folds bursts of events a person is waiting behind). */
const WINDOW_REQUEST_WATCH_DEBOUNCE_MS = 30;
/** What each window remembers of which Unity project a folder's launches run in: one project per folder, shared by every window of the profile. */
const UNITY_CHOICE_KEY = "omp.unityProjectChoice.v1";
/** VS Code's editor-group target that opens an editor in a new auxiliary window (`AUX_WINDOW_GROUP`). */
const AUX_WINDOW_GROUP = -3;
/** The workbench command Developer: Reload Window runs; it restarts this window's extension host. */
const RELOAD_WINDOW_COMMAND = "workbench.action.reloadWindow";

/** What the routing reads of one tab record of this window. */
export interface RoutingTab {
	readonly slotId: string;
	readonly panel: vscode.WebviewPanel | null;
}

/** What a launch in a folder needs of the folder: its path and the paths of the folders it stands for. */
export interface RoutedFolder {
	readonly path: string;
	readonly openedPaths?: readonly string[];
}

/** The launcher rows the routing repaints, asks to re-observe, or reads the activity of. */
export type RoutingLauncher = Pick<SessionTreeProvider, "lastActivityOf" | "refreshOwnership" | "refresh" | "listedSessions">;

/** The window's own records the routing reads. */
export interface RoutingWindowFacts {
	/** The window registry, `undefined` before activation created it. */
	registry(): WindowRegistry | undefined;
	/** The folders the launcher shows, `undefined` before activation created them. */
	folders(): LauncherFolders | undefined;
	/** A credential changed (another window's provider login or logout): re-read model availability here, as the window does for its own. Never announces it again. */
	refreshProviderModels(): void;
	/** The session index the window publishes, `null` before activation created it. */
	index(): SessionIndex | null;
	/** Tabs another window asked this window to show whose editor VS Code has not revived yet. */
	requestSelections(): Set<string>;
	/** The installed package no longer holds the bytes this host started from. */
	packageStale(): boolean;
	/** The window's global state, which remembers the Unity project chosen for a folder. */
	unityChoices(): vscode.Memento | undefined;
	/** The activation restore pass covers this tab. */
	startupRestoreCovers(tabId: string): boolean;
	/** The detached request of agent roots of the folders of every live window. */
	resolveAgentRoots(): Promise<void>;
	/** Whether the installed package changed under this host (publishes the verdict when it flips). */
	packageChangedOnDisk(): boolean;
	/** Wait until the catalog and the predecessor import have settled. */
	ensureCatalogReady(): Promise<void>;
	/** The processes of this window's Sessions view, `null` while the window is still starting. */
	sessionProcesses(): Pick<SessionProcesses, "serveStopRequest"> | null;
}

/** The Sessions view and the rows of its tree. */
export interface RoutingLauncherPort {
	launcherProvider(): RoutingLauncher | undefined;
	sessionsViewVisible(): boolean;
	refreshLauncher(): void;
	/** What only this window knows about a tab: its panel, its host, its last outcome. */
	facts(tabId: string): SessionLauncherFacts;
	/** Put the Sessions selection back on this window's own session when it rests on a row another window runs. */
	releaseSelection(index: SessionIndex): void;
}

/** This window's editors. */
export interface RoutingEditorPort {
	tab(tabId: string): RoutingTab | undefined;
	/** VS Code shows a tab for the editor slot. */
	hasEditorTab(slot: string): boolean;
	/** Make VS Code show the slot's tab; `false` when it did not become active. */
	selectEditorTab(slot: string): Promise<boolean>;
	revealExistingTab(index: SessionIndex, tabId: string, panel: vscode.WebviewPanel): Promise<void>;
	/** Whether a tab input is a session editor of this extension. */
	isSessionTabInput(input: unknown): boolean;
	/** The election of the editor that holds a tab that is already connected here. */
	electLocalController(index: SessionIndex, tabId: string): Promise<void>;
}

/** The ordinary launch and open paths a request another window sent is performed through. */
export interface RoutingLaunchPort {
	openSession(context: vscode.ExtensionContext, index: SessionIndex, tabId: string, verb: "opened" | "resumed", noRouting: boolean, keepLiveView: boolean): Promise<boolean>;
	openSessionInMode(context: vscode.ExtensionContext, index: SessionIndex, tabId: string, mode: SessionViewMode, verb: "open" | "show", noRouting: boolean, revealIfLive: boolean): Promise<void>;
	startNewSession(context: vscode.ExtensionContext, index: SessionIndex, folder: LauncherFolder): Promise<void>;
	resumeFromFolderHistory(context: vscode.ExtensionContext, index: SessionIndex, folders: LauncherFolders, folder: LauncherFolder, keepLiveView: boolean): Promise<void>;
	openTab(context: vscode.ExtensionContext, index: SessionIndex, tabId: string, verb: "opened", intent: "restored"): Promise<void>;
}

/** The log and the notifications. Notifications carry the extension's own prefix. */
export interface RoutingNotices {
	log(message: string): void;
	/** One line of the hand-over timeline between windows. */
	timing(event: string, detail?: string): void;
	info(message: string): void;
	warn(message: string): void;
	error(message: string): void;
}

export interface WindowRoutingDeps extends RoutingWindowFacts, RoutingLauncherPort, RoutingEditorPort, RoutingLaunchPort, RoutingNotices {}

/** Where a launch for a folder starts. */
type LaunchRoute =
	| { readonly kind: "here" }
	| { readonly kind: "cancelled" }
	| { readonly kind: "window"; readonly holderId: string; readonly workspace: LaunchWorkspace }
	| { readonly kind: "new-window"; readonly workspace: LaunchWorkspace };

/** How a hand-over to another window ended. */
type Delivery =
	| { readonly kind: "answer"; readonly answer: RequestAnswer; readonly manual: "no-uri" | "ambiguous" | null }
	/** The answer could not be read; the request was withdrawn. */
	| { readonly kind: "unreadable"; readonly detail: string }
	/** VS Code could not bring the window forward; the request was withdrawn, but it may have been served already. */
	| { readonly kind: "focus-failed"; readonly detail: string };

/** What the extension calls into the routing. */
export interface WindowRouting {
	/** Publish this window's folders, live sessions and row statuses in the registry; a change schedules one debounced write. */
	publishSnapshot(): void;
	/** Re-read the other windows' records and renew this window's own; repaint when what they show changed. */
	refresh(): void;
	/** The folders other windows have open changed: re-resolve their agent roots and repaint. */
	registryChanged(): void;
	/** The registry's 15 s heartbeat. */
	heartbeat(): void;
	/** Every folder open in a live window of the profile, for the agent-root probe. */
	allFolders(): string[];
	/** This window has just been brought to the front. */
	noteFocused(): void;
	/** The other live windows of the profile, from the registry as it is now. */
	peers(): readonly OpenWindow[];
	/** The window registry this window publishes in, for the liveness of a claim holder. */
	registry(): WindowRegistry | undefined;
	/** Whether a live claim of another window of this extension holds the session right now (one claim read). */
	heldByAnotherWindow(index: SessionIndex, tabId: string): Promise<boolean>;
	/**
	 * Bring the window that holds a session to the front and have it select the tab, with no confirmation
	 * (ADR-0056). However the switch ends, the Sessions selection goes back to this window's own session.
	 * `null` (a command invoked on nothing that names a tab) switches nowhere.
	 */
	switchToWindow(index: SessionIndex, tabId: string | null): Promise<void>;
	/**
	 * Start a launch in the window that has the folder open (ADR-0057). `false` when it starts in this
	 * window, `true` once it was handed over, successfully or not, or the user dismissed the Unity project
	 * question: the caller then starts nothing.
	 */
	routeLaunch(index: SessionIndex, folder: RoutedFolder, launch: LaunchAction, answerTimeoutMs?: number): Promise<boolean>;
	/** {@link routeLaunch} for opening an indexed session, in the view `mode` names. */
	routeOpen(index: SessionIndex, tabId: string, verb: "opened" | "resumed", mode: SessionViewMode | null): Promise<boolean>;
	/** Watch the request directories of this window and serve what other windows ask of it, until {@link dispose}. */
	serveRequests(context: vscode.ExtensionContext, index: SessionIndex, folders: LauncherFolders): void;
	/** Read the request directories again (the recovery for a watch event the platform dropped). */
	rescanRequests(): void;
	/** This window's folders changed: read the launches left for them again. */
	rescanPendingLaunches(): void;
	/** Serve a request to start a launch here (ADR-0057): another window's, or a pending one this window claimed. */
	serveLaunchRequest(context: vscode.ExtensionContext, index: SessionIndex, request: LaunchRequest, serveContext: ServeContext): Promise<ServeOutcome>;
	/**
	 * Reload All Windows: post a reload request to every other live window of the profile, wait briefly (bounded) for each
	 * to take it up, then reload this window whatever each answered. Resolves once this window's reload command returns
	 * (in practice the host is replaced first).
	 */
	reloadAllWindows(acceptTimeoutMs?: number): Promise<void>;
	/**
	 * Tell every other live window of the profile that a credential may have changed (ADR-0070), so each re-reads its model
	 * availability. Waits at most the answer timeout per window, all at once, and never rejects: a window that does not
	 * answer (an older build, a hung host) is logged and left, and reads the new credential at its next availability read.
	 */
	announceCredentialsChanged(): Promise<void>;
	/** Serve another window's Kill All request (ADR-0060). */
	serveStopRequest(index: SessionIndex, request: StopRequest, serveContext: ServeContext): Promise<ServeOutcome>;
	/** Serve another window's request to show a session's tab (ADR-0056): selection only. */
	selectHeldTab(index: SessionIndex, request: SwitchRequest, serveContext: ServeContext): Promise<ServeOutcome>;
	/** Open one restored editor's conversation when the activation pass does not cover it. */
	openRestoredTabIfUncovered(context: vscode.ExtensionContext, index: SessionIndex, tabId: string): Promise<void>;
	/** An explicit open supersedes another window's request to show this tab only: forget the mark. `true` when there was one. */
	consumeRequestedSelection(tabId: string): boolean;
	/** The view column files from the chat open in: the file window's group while that window is open, else VS Code's choice. */
	fileWindowColumn(): number | undefined;
	/** `ompDesk.moveFileToNewWindow`: a toggle that moves the files group into a window of its own, or back. */
	moveFileToNewWindow(): Promise<void>;
	/** Stop watching the request directories. */
	dispose(): void;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Saved workspaces retain all roots; unsaved multi-root windows have no reopenable identity. */
export function owningWindowUri(): vscode.Uri | null {
	const workspace = vscode.workspace.workspaceFile;
	if (workspace?.scheme === "file") return workspace;
	const folders = vscode.workspace.workspaceFolders ?? [];
	return workspace === undefined && folders.length === 1 && folders[0]?.uri.scheme === "file" ? folders[0].uri : null;
}

/** The local `file` folders VS Code has open in this window, in VS Code's order. */
function localWindowFolders(): string[] {
	return (vscode.workspace.workspaceFolders ?? [])
		.filter(folder => folder.uri.scheme === "file")
		.map(folder => folder.uri.fsPath);
}

/** Resolve `true` once this window has the focus, `false` when it does not within `timeoutMs`. */
function windowBecomesFocused(timeoutMs: number): Promise<boolean> {
	if (vscode.window.state.focused) return Promise.resolve(true);
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const subscription = vscode.window.onDidChangeWindowState(state => {
		if (!state.focused) return;
		clearTimeout(timer);
		subscription.dispose();
		resolve(true);
	});
	const timer = setTimeout(() => { subscription.dispose(); resolve(false); }, timeoutMs);
	return promise;
}

export function registerWindowRouting(deps: WindowRoutingDeps): WindowRouting {
	/** When this window last had the focus, as the registry orders windows by it; `null` until it did. */
	let windowFocusedAt: string | null = null;
	let windowRequestWatch: RequestWatch | undefined;
	let pendingLaunchWatch: RequestWatch | undefined;
	const unityProjects = new UnityProjectCache();
	/** Windows on an older build already announced, so that the user is told once per window. */
	const olderBuildNoticed = new Set<string>();
	const fileWindow = new FileWindowTracker<vscode.TabGroup>();

	/** Working directories of the sessions this window runs or is launching. */
	function localLiveSessionCwds(index: SessionIndex): string[] {
		return index.list()
			.filter(entry => {
				const facts = deps.facts(entry.tabId);
				return facts.running || facts.launching === true;
			})
			.map(entry => entry.cwd);
	}

	/**
	 * What this window publishes in the window registry (ADR-0056): its folders, the working
	 * directories of its live sessions and, for each session it runs, its status and the
	 * conversation activity it read, fenced to the run (the incarnation the shared catalog
	 * records) they were published for. A change schedules one debounced write.
	 */
	function publishWindowSnapshot(): void {
		const registry = deps.registry();
		const index = deps.index();
		if (registry === undefined || index === null) return;
		const rows: Record<string, PublishedRow> = {};
		for (const entry of index.list()) {
			const incarnation = sessionIncarnation(entry);
			if (incarnation === null) continue;
			const facts = deps.facts(entry.tabId);
			if (!facts.running && facts.launching !== true && facts.stopping !== true && facts.restoring !== true) continue;
			const state = sessionItemState(entry, facts);
			// "unread" is derived by every reader from the shared reply markers, so it is published as the idle status it sits on.
			const status = state === "unread" ? "waiting" : state;
			if (PUBLISHED_ROW_STATUSES.includes(status as PublishedRowStatus)) {
				const slot = deps.tab(entry.tabId)?.slotId;
				const binding = slot === undefined ? null : index.slotBinding(slot);
				rows[entry.tabId] = {
					status: status as PublishedRowStatus,
					incarnation,
					binding: binding !== null && slot !== undefined && binding.tabId === entry.tabId ? `${slot}.${binding.generation}` : "none",
					lastActivityAt: deps.launcherProvider()?.lastActivityOf(entry.tabId) ?? null,
				};
			}
		}
		registry.setSnapshot({
			windowUri: owningWindowUri()?.toString() ?? null,
			label: vscode.workspace.name ?? "",
			folders: localWindowFolders(),
			liveCwds: localLiveSessionCwds(index),
			rows,
			focusedAt: windowFocusedAt,
			stale: deps.packageStale(),
		});
	}

	/** Re-read the other windows' records and renew this window's own; repaint when what they show changed. */
	function refreshWindowRegistry(): void {
		const registry = deps.registry();
		if (registry === undefined) return;
		void registry.flush();
		void registry.refresh().then(changed => {
			if (changed) windowRegistryChanged();
		}, error => deps.log(`window registry: ${messageOf(error)}`));
	}

	/** The folders other windows have open changed: re-resolve their agent roots and repaint. */
	function windowRegistryChanged(): void {
		void deps.resolveAgentRoots();
		deps.refreshLauncher();
	}

	/** Every folder open in a live window of the profile, for the agent-root probe. */
	function allWindowFolders(): string[] {
		return (deps.registry()?.windows() ?? []).flatMap(window => [...window.folders]);
	}

	/**
	 * Registry heartbeat (every 15 s): agent roots are re-probed whatever the registry saw, and the
	 * request directory is read again (the recovery for a watch event the platform dropped). While
	 * the Sessions view is visible every row's ownership and conversation activity is observed
	 * again, so a claim change whose notification was missed, a failed observation and a file
	 * change are all repaired within one heartbeat plus one observation. A hidden view re-observes
	 * only the rows shown as held by another window or still Checking and is otherwise brought up
	 * to date when it is shown (nobody is looking at it before that).
	 */
	function windowRegistryHeartbeat(): void {
		void deps.resolveAgentRoots();
		windowRequestWatch?.rescan();
		pendingLaunchWatch?.rescan();
		const provider = deps.launcherProvider();
		if (deps.sessionsViewVisible()) {
			provider?.refresh({ ownership: true });
			return;
		}
		const stale = (provider?.listedSessions() ?? [])
			.filter(({ item }) => item.state === "otherWindow" || item.state === "checking")
			.map(({ item }) => item.tabId);
		if (stale.length > 0) provider?.refreshOwnership(new Set(stale));
	}

	/** Whether a live claim of another window of this extension holds the session right now (one claim read). */
	async function heldByAnotherWindow(index: SessionIndex, tabId: string): Promise<boolean> {
		const observed = await index.observeOwnership(tabId);
		const claim = observed.ok ? observed.claim : null;
		return claim !== null && claim.verifiable && claim.holderId !== null && claim.holderId !== index.claimHolder.id && await holderSeemsAlive(claim, deps.registry());
	}

	/**
	 * Bring the window that holds a session to the front and have it select the tab, with no
	 * confirmation (ADR-0056). The claim is read again first; the owner is asked, by a request
	 * addressed to its claim holder id and naming the run this window's catalog records, to select
	 * the tab it already has open, and VS Code is asked to open its saved workspace or
	 * single-folder URI, which focuses the window that has it. `forceNewWindow: true` is
	 * deliberate: it still focuses an existing window for that URI but never replaces this window
	 * when the owner has just closed. A message is shown only when the switch is impossible or
	 * did not complete, and says why. The click that asked for it selected the row this window does not run,
	 * so however the switch ends the selection goes back to this window's own session.
	 */
	async function switchToSessionWindow(index: SessionIndex, tabId: string | null): Promise<void> {
		try {
			await requestSessionWindowSwitch(index, tabId);
		} finally {
			deps.releaseSelection(index);
		}
	}

	async function requestSessionWindowSwitch(index: SessionIndex, tabId: string | null): Promise<void> {
		if (tabId === null) return;
		const startedAt = Date.now();
		deps.timing("requester: switch started", tabId.slice(0, 12));
		const entry = index.get(tabId);
		const observed = await index.observeOwnership(tabId);
		deps.timing("requester: claim re-read", `${Date.now() - startedAt} ms`);
		const claim = observed.ok ? observed.claim : null;
		const plan = planWindowSwitch({
			claim,
			incarnation: entry === null ? null : sessionIncarnation(entry),
			claimHolderAlive: claim !== null && await holderSeemsAlive(claim, deps.registry()),
			ownHolderId: index.claimHolder.id,
			windows: deps.registry()?.windows() ?? [],
		});
		if (plan.kind === "stale") {
			deps.info("The session is no longer open in another window.");
			deps.launcherProvider()?.refreshOwnership(new Set([tabId]));
			return;
		}
		// The wait is counted from the moment the request is posted, whatever the focus change costs.
		const postedAt = Date.now();
		let requestId: string;
		try {
			// The binding generation the holder published for this very run (the one the row on screen shows), if any.
			const published = (deps.registry()?.windows() ?? []).find(window => window.holderId === plan.holderId)?.rows[tabId];
			requestId = await postSwitchRequest(index.claimStorageDir, {
				to: plan.holderId, from: index.claimHolder.id, tabId, incarnation: plan.incarnation,
				binding: published !== undefined && published.incarnation === plan.incarnation ? published.binding : null,
			});
			deps.timing("requester: request posted", `${requestId.slice(0, 8)} ${Date.now() - startedAt} ms after the click`);
		} catch (error) {
			deps.warn(`The window holding this session could not be asked to show it: ${messageOf(error)}`);
			return;
		}
		const delivered = await deliverRequest({
			label: `select ${requestId.slice(0, 8)}`,
			postedAt,
			timeoutMs: REQUEST_ANSWER_TIMEOUT_MS,
			focus: plan.kind === "manual" ? { kind: "manual", reason: plan.reason } : { kind: "switch", uri: plan.uri },
			withdraw: () => withdrawRequest(index.claimStorageDir, plan.holderId, requestId),
			awaitAnswer: timeoutMs => awaitRequestAnswer(index.claimStorageDir, plan.holderId, requestId, { timeoutMs }),
		});
		if (delivered.kind === "unreadable") {
			deps.warn(`The answer of the window holding this session could not be read: ${delivered.detail}`);
			return;
		}
		if (delivered.kind === "focus-failed") {
			deps.warn(`VS Code could not bring the window holding this session forward: ${delivered.detail}`);
			return;
		}
		const answer = delivered.answer;
		if (delivered.manual !== null) {
			const where = delivered.manual === "ambiguous"
				? "Another window shows the same folder or workspace, so VS Code cannot tell which one to bring forward."
				: "This owning window has no saved workspace or single-folder identity, so it cannot be brought forward.";
			deps.info(`${where} Switch to it using VS Code's Window menu${answer === "served" || answer === "unfocused" ? "; the session's tab is selected there" : ""}.`);
			return;
		}
		if (answer === "timeout") {
			deps.warn("The window holding this session did not respond, so its tab was not selected. It may be busy or run an older OMP Desk.");
		} else if (answer === "refused") {
			deps.info("That window no longer has an editor open for this session.");
			deps.launcherProvider()?.refreshOwnership(new Set([tabId]));
		} else if (answer === "unfocused") {
			deps.info("The window holding this session selected its tab, but VS Code did not bring it to the front. Switch to it using the taskbar or VS Code's Window menu.");
		}
	}

	/**
	 * The shared half of every request to another window: bring that window forward the way
	 * `focus` plans (`vscode.openFolder` on its URI, or nothing when the plan is manual) and wait
	 * for its answer, both started at once. The wait ends at `postedAt + timeoutMs` however the
	 * focus command behaves (it may never settle), and the request is withdrawn when the wait ends
	 * without an answer, on a timer armed at the start and on every path that stops waiting, so the
	 * receiver never acts for a requester that has stopped waiting. A focus command that fails
	 * ends the wait at once and says so, because the receiver may already have acted on the request.
	 */
	async function deliverRequest(options: {
		/** Names the request in the timing lines. */
		readonly label: string;
		readonly postedAt: number;
		readonly timeoutMs: number;
		readonly focus: WindowFocusPlan;
		readonly withdraw: () => Promise<void>;
		readonly awaitAnswer: (timeoutMs: number) => Promise<RequestAnswer>;
	}): Promise<Delivery> {
		const deadline = options.postedAt + options.timeoutMs;
		const withdraw = () => options.withdraw().catch(() => undefined);
		const timer = setTimeout(() => { void withdraw(); }, Math.max(0, deadline - Date.now()));
		try {
			const answered = options.awaitAnswer(Math.max(250, deadline - Date.now())).then(
				(answer): Delivery => {
					deps.timing("requester: answer seen", `${options.label} ${answer} ${Date.now() - options.postedAt} ms after posting`);
					return { kind: "answer", answer, manual: options.focus.kind === "manual" ? options.focus.reason : null };
				},
				(error): Delivery => ({ kind: "unreadable", detail: messageOf(error) }),
			);
			const racers: Promise<Delivery>[] = [answered];
			if (options.focus.kind === "switch") {
				const uri = vscode.Uri.parse(options.focus.uri);
				const focusFailed = Promise.withResolvers<Delivery>();
				racers.push(focusFailed.promise);
				void (async () => {
					try {
						deps.timing("requester: openFolder called", `${options.label} ${Date.now() - options.postedAt} ms after posting`);
						await vscode.commands.executeCommand("vscode.openFolder", uri, { forceNewWindow: true });
						deps.timing("requester: openFolder resolved", `${options.label} ${Date.now() - options.postedAt} ms after posting`);
					} catch (error) {
						focusFailed.resolve({ kind: "focus-failed", detail: messageOf(error) });
					}
				})();
			}
			const outcome = await Promise.race(racers);
			if (outcome.kind !== "answer" || outcome.answer === "timeout") await withdraw();
			return outcome;
		} finally {
			clearTimeout(timer);
		}
	}

	/** The Unity project folders a launch in `folder` stands for: the folder itself, an opened folder it stands for, or projects below it. */
	async function unityCandidatesOf(folder: RoutedFolder): Promise<string[]> {
		const folders = deps.folders();
		if (folders === undefined) return [];
		const found = new Map<string, string>();
		for (const project of await unityProjects.projects(folder.path)) found.set(folders.identityKeyOf(project), project);
		for (const opened of folder.openedPaths ?? []) if (await isUnityProject(opened)) found.set(folders.identityKeyOf(opened), opened);
		return [...found.values()];
	}

	/**
	 * Whether `workspace`, which a request names, is one a launch in `folder` is allowed to run in:
	 * the folder itself, or one of the Unity projects it stands for. The receiver checks this
	 * itself rather than trusting that it merely has both the workspace and the folder.
	 */
	async function launchWorkspaceFits(folder: RoutedFolder, workspace: LaunchWorkspace): Promise<boolean> {
		const folders = deps.folders();
		if (folders === undefined) return false;
		const wanted = folders.identityKeyOf(workspace.path);
		if (workspace.match === "folder") return folders.identityKeyOf(folder.path) === wanted;
		return (await unityCandidatesOf(folder)).some(candidate => folders.identityKeyOf(candidate) === wanted);
	}

	/**
	 * The folder the window that starts a launch in `folder` must have open (ADR-0057): the
	 * Unity project folder the launch stands for, because the Unity extensions only work in a
	 * window whose workspace root it is, or the folder itself. The folder is the project itself,
	 * stands for an opened one (an agent root over an opened project folder), or holds projects
	 * down to two levels; one project is used, several are asked once and the answer is remembered
	 * for the folder, none means the folder itself. `null` when the user dismissed the question.
	 * The session's working directory stays the folder, so the repository's agent files load.
	 */
	async function launchWorkspaceOf(folder: RoutedFolder): Promise<LaunchWorkspace | null> {
		const folders = deps.folders();
		const ordinary: LaunchWorkspace = { path: folder.path, match: "folder" };
		if (folders === undefined) return ordinary;
		const candidates = await unityCandidatesOf(folder);
		if (candidates.length === 0) return ordinary;
		if (candidates.length === 1) return { path: candidates[0]!, match: "root" };
		const folderKey = folders.identityKeyOf(folder.path);
		const store = deps.unityChoices();
		const remembered = store?.get<Record<string, string>>(UNITY_CHOICE_KEY)?.[folderKey];
		const known = remembered === undefined ? undefined : candidates.find(candidate => folders.identityKeyOf(candidate) === folders.identityKeyOf(remembered));
		if (known !== undefined) return { path: known, match: "root" };
		const picked = await vscode.window.showQuickPick(
			candidates.map(candidate => ({ label: path.basename(candidate), description: candidate, candidate })),
			{ title: `Which Unity project should sessions in ${folderHeadline(folder.path)} run in?`, placeHolder: "The session runs in a window that has this project open; the choice is remembered for the folder" },
		);
		if (picked === undefined) return null;
		if (store !== undefined) {
			const all = { ...(store.get<Record<string, string>>(UNITY_CHOICE_KEY) ?? {}) };
			if (Object.keys(all).length >= 64) delete all[Object.keys(all)[0]!];
			all[folderKey] = picked.candidate;
			await store.update(UNITY_CHOICE_KEY, all);
		}
		return { path: picked.candidate, match: "root" };
	}

	/**
	 * A launch that would have gone to a window on an older OMP Desk starts here instead, because
	 * that window refuses to build a view after a reinstall (a reload fixes it). Said once per
	 * window, and always logged.
	 */
	function noteOlderBuildWindow(holderIds: readonly string[], folderPath: string): void {
		deps.log(`window request: the window(s) ${holderIds.join(", ")} with ${folderPath} run an older OMP Desk build; the launch starts here`);
		if (holderIds.every(id => olderBuildNoticed.has(id))) return;
		for (const id of holderIds) olderBuildNoticed.add(id);
		deps.info(`The VS Code window with ${folderHeadline(folderPath)} runs an older OMP Desk build; reload it (Developer: Reload Window). The session opened here.`);
	}

	/**
	 * The window a launch in `folder` starts in (ADR-0057): this one when it has the workspace
	 * the launch needs open (the folder, or the Unity project it stands for), when
	 * `ompDesk.launchInFolderWindow` is off, or, for an ordinary folder, when no live window has it
	 * (a pinned folder, or one only a session keeps visible); otherwise the most recently focused
	 * window that has it; and for a Unity project nobody has open, a new window on it. A window that
	 * runs an older OMP Desk than the installed one is never chosen: when it is the only kind of
	 * window that has the folder, the launch starts here and the user is told once.
	 */
	async function planLaunchRoute(folder: RoutedFolder): Promise<LaunchRoute> {
		if (!vscode.workspace.getConfiguration("ompDesk").get<boolean>("launchInFolderWindow", true)) return { kind: "here" };
		const folders = deps.folders();
		if (deps.registry() === undefined || folders === undefined) return { kind: "here" };
		const workspace = await launchWorkspaceOf(folder);
		if (workspace === null) return { kind: "cancelled" };
		const unity = workspace.match === "root";
		const plan = planFolderLaunch(folders.windowsWithFolder(workspace.path, { exact: unity }), unity ? "new-window" : "here");
		if (plan.kind === "here") {
			if (plan.staleHolders !== undefined) noteOlderBuildWindow(plan.staleHolders, workspace.path);
			return { kind: "here" };
		}
		return plan.kind === "window" ? { kind: "window", holderId: plan.holderId, workspace } : { kind: "new-window", workspace };
	}

	/**
	 * Start a launch in the window {@link planLaunchRoute} picks. Returns `false` when it starts
	 * in this window and `true` once it was handed over, successfully or not (or the user dismissed
	 * the Unity project question): the caller then starts nothing, because a window that did not
	 * answer may still start it, and two sessions are worse than none. The other window is asked,
	 * by a launch request addressed to its claim holder id, to perform the very same launch through
	 * its own ordinary path and admission, and VS Code brings it forward as for a switch; a new
	 * window is opened on the Unity project with the launch left for it to claim. A message is
	 * shown only when the hand-over did not complete, and says so; nothing is retried and nothing
	 * falls back to this window.
	 */
	async function routeLaunchToFolderWindow(
		index: SessionIndex,
		folder: RoutedFolder,
		launch: LaunchAction,
		answerTimeoutMs?: number,
	): Promise<boolean> {
		const route = await planLaunchRoute(folder);
		if (route.kind === "here") return false;
		if (route.kind === "cancelled") return true;
		return await followLaunchRoute(index, route, launch, answerTimeoutMs);
	}

	/**
	 * Hand a launch to the window or new window of `route`. `true` once it was handed over, whatever
	 * came of it; `false` only when the receiver refused it as definitely not started (it runs an
	 * older build and decided before beginning anything), so the caller starts it here: the refusal
	 * is written by that receiver for this very request and a request is served at most once, so
	 * exactly one of the two windows starts it.
	 */
	async function followLaunchRoute(
		index: SessionIndex,
		route: Exclude<LaunchRoute, { readonly kind: "here" } | { readonly kind: "cancelled" }>,
		launch: LaunchAction,
		answerTimeoutMs?: number,
	): Promise<boolean> {
		const registry = deps.registry();
		const folders = deps.folders();
		if (registry === undefined || folders === undefined) return true;
		const postedAt = Date.now();
		if (route.kind === "new-window") {
			return await launchInNewWindow(index, folders, route.workspace, launch, postedAt, answerTimeoutMs ?? PENDING_ANSWER_TIMEOUT_MS);
		}
		let requestId: string;
		try {
			requestId = await postLaunchRequest(index.claimStorageDir, { to: route.holderId, from: index.claimHolder.id, workspace: route.workspace, launch });
		} catch (error) {
			deps.warn(`The window that has this folder open could not be asked to start the session: ${messageOf(error)}. Nothing was started.`);
			return true;
		}
		const delivered = await deliverRequest({
			label: `launch ${requestId.slice(0, 8)}`,
			postedAt,
			timeoutMs: answerTimeoutMs ?? LAUNCH_ANSWER_TIMEOUT_MS,
			focus: planWindowFocus(route.holderId, null, registry.windows()),
			withdraw: () => withdrawRequest(index.claimStorageDir, route.holderId, requestId),
			awaitAnswer: timeoutMs => awaitRequestAnswer(index.claimStorageDir, route.holderId, requestId, { timeoutMs }),
		});
		if (delivered.kind === "answer" && delivered.answer === "stale-build") {
			noteOlderBuildWindow([route.holderId], route.workspace.path);
			return false;
		}
		reportLaunchDelivery(delivered, "the window that has this folder open");
		return true;
	}

	/**
	 * Say how handing a launch to another window ended, when it did not end silently. Nothing was
	 * started from here in any of these cases; where the receiver may have started it anyway (it
	 * answered late, or VS Code failed to focus it after it acted) the message says to look there
	 * before trying again.
	 */
	function reportLaunchDelivery(delivered: Delivery, subject: string): void {
		if (delivered.kind === "unreadable") {
			deps.warn(`The answer of ${subject} could not be read: ${delivered.detail}. Nothing was started from here; check that window before trying again.`);
		} else if (delivered.kind === "focus-failed") {
			deps.warn(`VS Code could not bring ${subject} forward: ${delivered.detail}. Nothing was started from here, but the session may have started there; check that window before trying again.`);
		} else if (delivered.answer === "timeout") {
			deps.warn(`${subject.charAt(0).toUpperCase()}${subject.slice(1)} did not respond in time. Nothing was started from here; check that window before trying again. It may be busy, still loading, or run an older OMP Desk.`);
		} else if (delivered.answer === "refused") {
			deps.warn(`${subject.charAt(0).toUpperCase()}${subject.slice(1)} could not start the session (it may have closed the folder just now). Nothing was started; try again.`);
			deps.refreshLauncher();
		} else if (delivered.manual !== null) {
			deps.info(`The session is starting in ${subject}, but VS Code cannot bring that window forward (${delivered.manual === "ambiguous" ? "another window shows the same folder or workspace" : "it has no saved workspace or single-folder identity"}). Switch to it using VS Code's Window menu.`);
		} else if (delivered.answer === "unfocused") {
			deps.info(`The session is starting in ${subject}, but VS Code did not bring it to the front. Switch to it using the taskbar or VS Code's Window menu.`);
		}
	}

	/**
	 * No live window has the Unity project open: leave the launch for the window that will, keyed by
	 * the project folder's identity, and open a new window on it (`vscode.openFolder`, which
	 * focuses an existing window of that folder instead when one is just starting). The new window
	 * claims the launch once it runs and answers on admission; a window that never does leaves
	 * the launch to be withdrawn at the deadline and is told so here. The deadline is absolute
	 * from posting: a window that claimed the launch but has not admitted it by then finds the
	 * file withdrawn and refuses.
	 */
	async function launchInNewWindow(
		index: SessionIndex,
		folders: LauncherFolders,
		workspace: LaunchWorkspace,
		launch: LaunchAction,
		postedAt: number,
		answerTimeoutMs: number,
	): Promise<boolean> {
		const key = pendingKeyOf(folders.identityKeyOf(workspace.path));
		let requestId: string;
		try {
			requestId = await postPendingLaunch(index.claimStorageDir, { from: index.claimHolder.id, key, workspace, launch });
		} catch (error) {
			deps.warn(`A window for the Unity project could not be asked to start the session: ${messageOf(error)}. Nothing was started.`);
			return true;
		}
		const delivered = await deliverRequest({
			label: `pending launch ${requestId.slice(0, 8)}`,
			postedAt,
			timeoutMs: answerTimeoutMs,
			focus: { kind: "switch", uri: vscode.Uri.file(workspace.path).toString() },
			withdraw: () => withdrawPendingLaunch(index.claimStorageDir, key, requestId),
			awaitAnswer: timeoutMs => awaitPendingLaunchAnswer(index.claimStorageDir, requestId, { timeoutMs }),
		});
		// A window that had the project open and was not in the registry yet claimed the launch and refused it as an older build.
		if (delivered.kind === "answer" && delivered.answer === "stale-build") {
			noteOlderBuildWindow(["pending"], workspace.path);
			return false;
		}
		reportLaunchDelivery(delivered, `the new window on ${workspace.path}`);
		return true;
	}

	/**
	 * {@link routeLaunchToFolderWindow} for opening an indexed session: the folder is the one the
	 * session's working directory belongs to. The caller has already dealt with a session another
	 * window holds (it is switched to, not launched). A session this window already has an editor
	 * for is left alone when it is only being looked at (`opened`), and a session whose folder is
	 * unknown starts here.
	 */
	async function routeSessionOpen(index: SessionIndex, tabId: string, verb: "opened" | "resumed", mode: SessionViewMode | null): Promise<boolean> {
		const entry = index.get(tabId);
		const folders = deps.folders();
		if (entry === null || folders === undefined) return false;
		if (verb === "opened" && deps.tab(tabId) !== undefined) return false;
		const folder = folders.folderForCwd(entry.cwd);
		if (folder === null) return false;
		const route = await planLaunchRoute(folder);
		if (route.kind === "here") return false;
		if (route.kind === "cancelled") return true;
		return await followLaunchRoute(index, route, { kind: "open-session", tabId, verb, mode });
	}

	/**
	 * Serve a request to start a launch here (ADR-0057), another window's or a pending one this
	 * window claimed. Admission is this window's own: the request only says what to start, and it
	 * is performed by the same function a click in this window runs, which reads the claims and
	 * refuses a session another writer holds. This window first waits for what a window that has
	 * just started lacks (the catalog, its own folders in the registry, its agent roots), then
	 * refuses unless (1) it itself has the workspace the request names open (a Unity project as
	 * one of its own roots), (2) the folder or session the request names is one it shows and *stands
	 * under that workspace* (the folder itself, or a Unity project the folder stands for), and (3)
	 * the requester still waits; after the last asynchronous step it checks (1) and the target again
	 * before beginning. A session that is already live here is only revealed, never launched or
	 * switched to another view. It is never routed again. The answer is given on admission, once
	 * the launch has begun, not when OMP is ready; whatever the launch then reports it reports
	 * here, as for a click here.
	 */
	async function serveLaunchRequest(
		context: vscode.ExtensionContext,
		index: SessionIndex,
		request: LaunchRequest,
		serveContext: ServeContext,
	): Promise<ServeOutcome> {
		const folders = deps.folders();
		const refuse = (reason: string, refusal?: RefusalReason): ServeOutcome => {
			deps.log(`window request: refused a launch (${request.launch.kind}) for ${request.workspace.path} (${request.workspace.match}): ${reason}`);
			return { ok: false, focused: false, ...(refusal === undefined ? {} : { refusal }) };
		};
		// Before anything else: after a reinstall this window cannot build the view a launch needs, and the requester
		// starts the launch itself on this definite refusal (nothing was begun here, and a request is served at most once).
		if (deps.packageChangedOnDisk()) return refuse("this window runs an older OMP Desk than the one installed", "stale-build");
		if (folders === undefined) return refuse("the launcher is not ready");
		await deps.ensureCatalogReady();
		deps.timing("receiver: catalog ready", request.id.slice(0, 8));
		publishWindowSnapshot();
		// A window that has just started has read no other window's record yet: the folder the request names may be open only in another window.
		try {
			if (await deps.registry()?.refresh()) deps.refreshLauncher();
		} catch (error) {
			deps.log(`window request: the other windows could not be read: ${messageOf(error)}`);
		}
		deps.timing("receiver: registry read", request.id.slice(0, 8));
		await deps.resolveAgentRoots();
		deps.timing("receiver: agent roots resolved", request.id.slice(0, 8));
		const hasWorkspace = () => folders.windowsWithFolder(request.workspace.path, { exact: request.workspace.match === "root" }).some(window => window.here);
		if (!hasWorkspace()) return refuse("this window does not have the workspace open");
		const action = request.launch;
		let targetExists: () => boolean;
		let start: () => Promise<unknown>;
		if (action.kind === "open-session") {
			const entry = index.get(action.tabId);
			const folder = entry === null ? null : folders.folderForCwd(entry.cwd);
			if (folder === null) return refuse("this window shows no folder for the session");
			if (!(await launchWorkspaceFits(folder, request.workspace))) return refuse("the session's folder does not stand under the workspace");
			// The target is the session as validated above: the same tab, still in the same working directory.
			const cwd = entry!.cwd;
			targetExists = () => index.get(action.tabId)?.cwd === cwd;
			// Chosen at the beginning, not before the waits: a session that is live here by then is revealed (the ordinary
			// open does that), never switched to another view, and one that goes live while the open waits is still only revealed.
			start = () => action.mode === null || deps.facts(action.tabId).running
				? deps.openSession(context, index, action.tabId, action.verb, true, true)
				: deps.openSessionInMode(context, index, action.tabId, action.mode!, "open", true, true);
		} else {
			const folder = folders.get(action.folderId);
			if (folder === null) return refuse("this window shows no such folder");
			if (!(await launchWorkspaceFits(folder, request.workspace))) return refuse("the folder does not stand under the workspace");
			const folderPath = folder.path;
			targetExists = () => folders.get(action.folderId)?.path === folderPath;
			start = action.kind === "new-session" ? () => deps.startNewSession(context, index, folder) : () => deps.resumeFromFolderHistory(context, index, folders, folder, true);
		}
		deps.timing("receiver: launch validated", request.id.slice(0, 8));
		if (!(await serveContext.stillWanted())) return refuse("the requester no longer waits");
		// Nothing is awaited between this last look at this window and the beginning of the launch.
		if (!hasWorkspace() || !targetExists()) return refuse("the workspace or the target changed while it waited");
		void start().catch(error => {
			deps.log(`window request: the launch asked for by another window failed: ${messageOf(error)}`);
			deps.error(`The session another window asked for could not be started: ${messageOf(error)}`);
		});
		return { ok: true, focused: await windowBecomesFocused(WINDOW_FOCUS_WAIT_MS) };
	}

	/** Reload this window through the workbench's own command (the one Developer: Reload Window runs). */
	async function reloadThisWindow(reason: string): Promise<void> {
		deps.log(`reload: reloading this window (${reason})`);
		try {
			await vscode.commands.executeCommand(RELOAD_WINDOW_COMMAND);
		} catch (error) {
			deps.error(`This window could not be reloaded: ${messageOf(error)}`);
		}
	}

	/**
	 * Serve another window's reload request (Reload All Windows): it was taken up before this runs, so it cannot be
	 * served twice. The window reloads only after the answer is written and the request is gone, so the host that
	 * starts afterwards finds nothing to act on.
	 */
	function serveReloadRequest(request: ReloadRequest): ServeOutcome {
		return { ok: true, focused: false, afterAnswer: () => { void reloadThisWindow(`asked by window ${request.from}`); } };
	}

	/** Serve another window's credential-change notice: re-read the models here, and say nothing to anyone else. */
	function serveModelsRequest(): ServeOutcome {
		deps.refreshProviderModels();
		return { ok: true, focused: false };
	}

	async function announceCredentialsChanged(): Promise<void> {
		const index = deps.index();
		if (index === null) return;
		try {
			await deps.registry()?.refresh();
		} catch (error) {
			deps.log(`credentials changed: the other windows could not be read afresh: ${messageOf(error)}`);
		}
		await Promise.all(otherWindows().map(async peer => {
			try {
				const id = await postModelsRequest(index.claimStorageDir, { to: peer.holderId, from: index.claimHolder.id });
				const answer = await awaitRequestAnswer(index.claimStorageDir, peer.holderId, id);
				if (answer === "timeout") deps.log(`credentials changed: ${peer.label} (${peer.holderId}) did not answer; it re-reads models at its next availability read`);
			} catch (error) {
				deps.log(`credentials changed: ${peer.label} (${peer.holderId}) could not be told: ${messageOf(error)}`);
			}
		}));
	}

	/** The other live windows of the profile, from the registry as it is now. */
	function otherWindows(): readonly OpenWindow[] {
		return (deps.registry()?.windows() ?? []).filter(window => !window.here);
	}

	/** The Reload All Windows run in flight: a second invocation joins it instead of posting requests again. */
	let reloadingAll: Promise<void> | undefined;

	/**
	 * Ask every other live window to reload, wait briefly (at most {@link RELOAD_ACCEPT_TIMEOUT_MS}, all windows at once)
	 * for each to take the request up, then reload this window whatever each answered. A window that never takes the
	 * request up (a build that predates it, a hung host) is logged and left; it never holds this window back.
	 */
	async function reloadEveryWindow(acceptTimeoutMs: number): Promise<void> {
		const index = deps.index();
		if (index === null) {
			deps.log("reload all windows: the session index is not ready, so only this window is reloaded");
		} else {
			try {
				await deps.registry()?.refresh();
			} catch (error) {
				deps.log(`reload all windows: the other windows could not be read afresh: ${messageOf(error)}`);
			}
			const peers = otherWindows();
			if (peers.length === 0) deps.log("reload all windows: no other window is open");
			await Promise.all(peers.map(async peer => {
				try {
					const id = await postReloadRequest(index.claimStorageDir, { to: peer.holderId, from: index.claimHolder.id });
					const answer = await awaitReloadTakenUp(index.claimStorageDir, peer.holderId, id, { timeoutMs: acceptTimeoutMs });
					deps.log(
						answer === "taken-up" ? `reload all windows: ${peer.label} (${peer.holderId}) is reloading`
							: answer === "unanswered" ? `reload all windows: ${peer.label} (${peer.holderId}) deleted the request without taking it up (an older build that does not know it); reload that window by hand`
								: `reload all windows: ${peer.label} (${peer.holderId}) did not take the request up within ${acceptTimeoutMs} ms; it was withdrawn and that window is not reloaded`,
					);
				} catch (error) {
					deps.log(`reload all windows: ${peer.label} (${peer.holderId}) could not be asked: ${messageOf(error)}`);
				}
			}));
		}
		await reloadThisWindow("after asking the other windows");
	}

	function reloadAllWindows(acceptTimeoutMs = RELOAD_ACCEPT_TIMEOUT_MS): Promise<void> {
		reloadingAll ??= reloadEveryWindow(acceptTimeoutMs).finally(() => { reloadingAll = undefined; });
		return reloadingAll;
	}

	/**
	 * Serve another window's Kill All request (ADR-0060): stop, through this window's own stop lifecycle, the rows
	 * the request names that this window provably runs, and answer per row.
	 *
	 * The request names rows by exact broker identity only. This window acts for a row only when it is a live
	 * window's request (the asking holder is another open window of this profile), the row still equals the
	 * identity named, and this window's own tier holds it (a runtime of this window under that exact slot, broker and
	 * generation, or a terminal editor of this window): see `stopRowsOnRequest`. It never forces, and a process it
	 * does not run is answered `refused`, so the requester decides what else may happen to it. A request
	 * file is writable by any local process of this user, which could stop a process of this window
	 * with the same ordinary Stop; the owner therefore also says in a notification what it stopped.
	 */
	async function serveStopRequest(index: SessionIndex, request: StopRequest, serveContext: ServeContext): Promise<ServeOutcome> {
		const answerAll = (state: "refused" | "unconfirmed", reason: string): ServeOutcome => ({
			ok: true,
			focused: false,
			rows: request.rows.map(() => ({ state, reason })),
		});
		const processes = deps.sessionProcesses();
		if (processes === null) return answerAll("unconfirmed", "this window is still starting and has not read its processes; nothing was stopped");
		try {
			await deps.registry()?.refresh();
		} catch (error) {
			deps.log(`stop request: the other windows could not be read: ${messageOf(error)}`);
		}
		const requester = deps.registry()?.windows().find(window => window.holderId === request.from && !window.here);
		if (requester === undefined || request.from === index.claimHolder.id) return answerAll("refused", "the asking window is not another open window of this profile");
		if (!(await serveContext.stillWanted())) return answerAll("unconfirmed", "this window is closing; nothing was stopped");
		deps.log(`stop request ${request.id.slice(0, 8)} from window ${request.from.slice(0, 8)}: ${request.rows.length} row(s)`);
		return { ok: true, focused: false, rows: await processes.serveStopRequest(request.rows, done => serveContext.progress(done)) };
	}

	/**
	 * Serve another window's request to show a session's tab (ADR-0056). Selection only: it makes
	 * the VS Code editor this window already has for the session the visible one, and nothing else.
	 *
	 * It acts only when, read together after a fresh claim read and the check that the requester
	 * still waits, all of these hold: the claim names this window as holder under the owner
	 * generation this window's catalog records; the catalog records the run the request names;
	 * this window has a live host for the session; the editor slot's binding is the session's and,
	 * when the request names the binding generation the requester saw published, is that
	 * generation (a native handover and back is another binding). It checks the same again after
	 * selecting and reports success only if nothing changed. An editor VS Code has not revived
	 * yet is shown with its tab's restore deferred ({@link WindowRoutingDeps.requestSelections}), so the serializer
	 * cannot start a session even if the host exits meanwhile. It never launches, stops, acquires
	 * a claim, changes a mode or forwards a request. The answer also says whether this window
	 * ended up focused.
	 */
	async function selectHeldSessionTab(index: SessionIndex, request: SwitchRequest, serveContext: ServeContext): Promise<ServeOutcome> {
		const refused: ServeOutcome = { ok: false, focused: false };
		const readClaim = async () => {
			const observed = await index.observeOwnership(request.tabId);
			return observed.ok ? observed.claim : null;
		};
		/** The editor slot and binding generation of the session while this window holds the run the request names; `null` otherwise. Synchronous. */
		const heldBinding = (claim: ObservedClaim | null): { readonly slot: string; readonly generation: number } | null => {
			const entry = index.get(request.tabId);
			const state = deps.tab(request.tabId);
			if (claim === null || entry === null || state === undefined) return null;
			if (claim.holderId !== index.claimHolder.id) return null;
			if (entry.ownership === null || claim.ownerGeneration !== entry.ownership.ownerGeneration) return null;
			if (sessionIncarnation(entry) !== request.incarnation || !index.hasLiveHost(request.tabId)) return null;
			const binding = index.slotBinding(state.slotId);
			if (binding === null || binding.tabId !== request.tabId) return null;
			if (request.binding !== null && `${state.slotId}.${binding.generation}` !== request.binding) return null;
			return { slot: state.slotId, generation: binding.generation };
		};
		// The claim read can be slow: whether the requester still waits is asked after it, and
		// everything the claim is compared with is read after that, with nothing awaited before the
		// first command is issued.
		const claim = await readClaim();
		deps.timing("receiver: claim read", request.id.slice(0, 8));
		if (!(await serveContext.stillWanted())) return refused;
		deps.timing("receiver: requester still waits", request.id.slice(0, 8));
		const held = heldBinding(claim);
		const state = deps.tab(request.tabId);
		if (held === null || state === undefined) return refused;
		if (state.panel !== null) await deps.revealExistingTab(index, request.tabId, state.panel);
		else {
			// No tab, no command: nothing can be revived. Once a selection command may have been issued
			// the mark stays, whatever the tab's state is afterwards (another selection can win).
			if (!deps.hasEditorTab(held.slot)) return refused;
			deps.requestSelections().add(request.tabId);
			if (!(await deps.selectEditorTab(held.slot))) return refused;
		}
		deps.timing("receiver: tab selected", request.id.slice(0, 8));
		const after = heldBinding(await readClaim());
		if (after === null || after.slot !== held.slot || after.generation !== held.generation) return refused;
		return { ok: true, focused: await windowBecomesFocused(WINDOW_FOCUS_WAIT_MS) };
	}

	/**
	 * Open one restored editor's conversation when the activation pass does not cover it.
	 *
	 * This is what makes the narrowed activation cohort safe: a row that is in the shared
	 * index but not among this window's restored editors and live hosts is restored by its
	 * own editor — exactly one open per tab, serialized with every other open of that tab
	 * by `openingTabs`.
	 */
	async function openRestoredTabIfUncovered(context: vscode.ExtensionContext, index: SessionIndex, tabId: string): Promise<void> {
		if (index.get(tabId) === null) return;
		// The revival a request triggered reaches this point once; it consumes the mark.
		const requested = consumeRequestedSelection(tabId);
		if (index.hasLiveHost(tabId)) {
			// Already connected here: only the election may still be missing for this editor.
			await deps.electLocalController(index, tabId);
			return;
		}
		// Another window's request is only showing this editor: it never starts a session (ADR-0056).
		if (requested) return;
		if (deps.startupRestoreCovers(tabId)) return;
		await deps.openTab(context, index, tabId, "opened", "restored");
	}

	function consumeRequestedSelection(tabId: string): boolean {
		return deps.requestSelections().delete(tabId);
	}

	/** The view column files from the chat open in: the file window's group while that window is open, else VS Code's choice. */
	function fileWindowColumn(): number | undefined {
		return fileWindow.column(vscode.window.tabGroups.all) ?? undefined;
	}

	/** VS Code's own always-on-top command, for the window that is focused: the file window VS Code has just opened. */
	async function keepFileWindowOnTop(): Promise<void> {
		try {
			await vscode.commands.executeCommand("workbench.action.enableWindowAlwaysOnTop");
		} catch (error) {
			deps.log(`file window: it could not be kept on top: ${messageOf(error)}`);
		}
	}

	/**
	 * Ctrl+Shift+M from anywhere, a toggle. Without a file window it moves every editor of the group next to the chat into
	 * a new one, kept on top of other windows; files opened from Chat links go into that window until it is closed. With a
	 * file window it brings all of its tabs back to the group next to the chat and closes the window.
	 */
	async function moveFileToNewWindow(): Promise<void> {
		const groups = vscode.window.tabGroups;
		const window = fileWindow.current(groups.all);
		if (window !== null) {
			await returnFilesFromWindow(window);
			return;
		}
		const column = filesGroupColumn(groups.all, groups.activeTabGroup.viewColumn, deps.isSessionTabInput);
		const source = groups.all.find(group => group.viewColumn === column);
		if (source === undefined) {
			deps.info("No file is open next to the chat.");
			return;
		}
		// The larger window needs every tab to be reopened by its file; any other tab moves the whole group as VS Code does.
		if (source.tabs.every(tab => tab.input instanceof vscode.TabInputText && tab.input.uri.scheme !== "untitled") &&
			await openGroupInSizedFileWindow(source)) return;
		await moveGroupToNewWindow(source);
	}

	/** Focus an editor group, because VS Code's group commands act on the active group. `false` past the eighth group, which has no focus command. */
	async function focusEditorGroup(group: vscode.TabGroup): Promise<boolean> {
		if (group.viewColumn === vscode.window.tabGroups.activeTabGroup.viewColumn) return true;
		const focusGroup = EDITOR_GROUP_FOCUS_COMMANDS[group.viewColumn - 1];
		if (focusGroup === undefined) return false;
		await vscode.commands.executeCommand(focusGroup);
		return true;
	}

	/**
	 * Move the whole group with VS Code's own Move Editor Group into New Window: every tab, its order and its state, in
	 * a window of VS Code's default size (the command takes no bounds).
	 */
	async function moveGroupToNewWindow(source: vscode.TabGroup): Promise<void> {
		if (!await focusEditorGroup(source)) {
			deps.info("The file group is beyond the eighth editor group; focus it and use View: Move Editor Group into New Window.");
			return;
		}
		const before = [...vscode.window.tabGroups.all];
		await vscode.commands.executeCommand("workbench.action.moveEditorGroupToNewWindow");
		fileWindow.adopt(appearedGroup(before, vscode.window.tabGroups.all));
		await keepFileWindowOnTop();
	}

	/**
	 * Reopen one tab's editor in `column` by its input, with its selection when it is a text file. `false` for an editor
	 * that cannot be reopened that way (unsaved files, webviews, terminals), which then stays where it was.
	 */
	async function reopenTabInColumn(tab: vscode.Tab, column: number): Promise<boolean> {
		const input = tab.input;
		const options = { viewColumn: column, preview: false };
		try {
			if (input instanceof vscode.TabInputText) {
				if (input.uri.scheme === "untitled") return false;
				const selection = vscode.window.visibleTextEditors.find(editor =>
					editor.viewColumn === tab.group.viewColumn && editor.document.uri.toString() === input.uri.toString())?.selection;
				await vscode.commands.executeCommand("vscode.open", input.uri, { ...options, selection });
			} else if (input instanceof vscode.TabInputTextDiff) {
				await vscode.commands.executeCommand("vscode.diff", input.original, input.modified, undefined, options);
			} else if (input instanceof vscode.TabInputCustom) {
				await vscode.commands.executeCommand("vscode.openWith", input.uri, input.viewType, options);
			} else if (input instanceof vscode.TabInputNotebook) {
				await vscode.commands.executeCommand("vscode.openWith", input.uri, input.notebookType, options);
			} else {
				return false;
			}
			return true;
		} catch (error) {
			deps.log(`file window: a tab could not be reopened there: ${messageOf(error)}`);
			return false;
		}
	}

	/** Whether two tabs show the same editor, for finding where a reopened tab landed. */
	function sameTabEditor(a: vscode.Tab, b: vscode.Tab): boolean {
		return a.label === b.label && a.input?.constructor === b.input?.constructor;
	}

	/**
	 * The main-window group a just-reopened `tab` landed in, excluding the file window and chat groups. VS Code reports the
	 * new tab to the extension host a moment after the open command resolves, so this looks a few times.
	 */
	async function groupHoldingReopened(tab: vscode.Tab, window: vscode.TabGroup): Promise<vscode.TabGroup | null> {
		for (let attempt = 0; attempt < 20; attempt++) {
			const found = vscode.window.tabGroups.all.find(group => group !== window && !group.tabs.some(other => deps.isSessionTabInput(other.input)) &&
				group.tabs.some(other => sameTabEditor(other, tab)));
			if (found !== undefined) return found;
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, 50);
			await promise;
		}
		return null;
	}

	/**
	 * Bring every tab of the file window back into the group next to the chat, in order, then close the originals; VS Code
	 * closes the emptied window. That group is the existing files group, else a new one to the right of the chat group:
	 * the first tab is opened into the chat group by its exact column, which activates the main window's group whichever
	 * window the key was pressed in, and moved into a new group on its right. A tab that cannot be reopened stays in the
	 * window, which is then still remembered, and the user is told.
	 */
	async function returnFilesFromWindow(window: vscode.TabGroup): Promise<void> {
		const groups = vscode.window.tabGroups;
		const candidates = groups.all.filter(group => group !== window);
		const tabs = [...window.tabs];
		const active = window.activeTab;
		const filesColumn = filesGroupColumn(candidates, groups.activeTabGroup.viewColumn, deps.isSessionTabInput);
		let target = candidates.find(group => group.viewColumn === filesColumn) ?? null;
		deps.log(`file window: return of ${tabs.length} tab(s) from column ${window.viewColumn}; active column ${groups.activeTabGroup.viewColumn}, files group ${target === null ? "missing" : `at column ${target.viewColumn}`}`);
		const moved: vscode.Tab[] = [];
		const kept: vscode.Tab[] = [];
		for (const tab of tabs) {
			if (target === null) {
				// The files group does not exist yet: open the first reopenable tab next to the chat group, then follow it.
				const chatColumn = chatGroupColumn(candidates, groups.activeTabGroup.viewColumn, deps.isSessionTabInput);
				const chat = candidates.find(group => group.viewColumn === chatColumn);
				// `ViewColumn.Beside` is relative to the focused window's active group, which is the file window's own when the key
				// was pressed there. An exact column is not: the first tab is opened into the chat group (VS Code accepts that for a
				// group that holds editors), which makes it the active group of the main window, and is then moved into a new group
				// on its right, so the chat group ends up with no file in it.
				if (!await reopenTabInColumn(tab, chat?.viewColumn ?? candidates[0]?.viewColumn ?? vscode.ViewColumn.One)) {
					kept.push(tab);
					continue;
				}
				if (chat !== undefined) {
					for (let attempt = 0; attempt < 40 && !chat.tabs.some(other => sameTabEditor(other, tab)); attempt++) {
						const { promise, resolve } = Promise.withResolvers<void>();
						setTimeout(resolve, 50);
						await promise;
					}
					await vscode.commands.executeCommand("workbench.action.moveEditorToRightGroup");
				}
				target = await groupHoldingReopened(tab, window);
				if (target === null) {
					deps.log("file window: the reopened file was not found in the main window; the tabs stay in the file window");
					deps.info("The files could not be moved back to the main window.");
					return;
				}
				moved.push(tab);
				continue;
			}
			(await reopenTabInColumn(tab, target.viewColumn) ? moved : kept).push(tab);
		}
		if (target !== null && active !== undefined && moved.includes(active) && active !== moved[moved.length - 1]) {
			await reopenTabInColumn(active, target.viewColumn);
		}
		if (moved.length > 0) await vscode.window.tabGroups.close(moved);
		if (kept.length === 0) {
			fileWindow.adopt(null);
			return;
		}
		deps.info(`${kept.length} editor${kept.length === 1 ? "" : "s"} could not be moved back to the main window (unsaved files and custom views stay in the file window).`);
	}

	/**
	 * Open the group's text files in a new window of `FILE_WINDOW_SIZE`. VS Code offers no command to size the window its
	 * own Move Editor Group into New Window opens, but opening an editor into `AUX_WINDOW_GROUP` takes the window's bounds,
	 * so the first file is opened this way and the rest follow into that window's group. `false` when VS Code refused the
	 * first file, so the caller can move the group instead.
	 */
	async function openGroupInSizedFileWindow(source: vscode.TabGroup): Promise<boolean> {
		const tabs = [...source.tabs];
		const first = tabs[0];
		if (first === undefined || !(first.input instanceof vscode.TabInputText)) return false;
		const uri = first.input.uri;
		const selection = vscode.window.visibleTextEditors.find(editor =>
			editor.viewColumn === source.viewColumn && editor.document.uri.toString() === uri.toString())?.selection;
		const range = selection === undefined ? undefined : {
			startLineNumber: selection.start.line + 1, startColumn: selection.start.character + 1,
			endLineNumber: selection.end.line + 1, endColumn: selection.end.character + 1,
		};
		const before = [...vscode.window.tabGroups.all];
		try {
			// The workbench's own open command; the public `vscode.open` drops the `auxiliary` option.
			await vscode.commands.executeCommand("_workbench.open", uri, [AUX_WINDOW_GROUP, { pinned: true, selection: range, auxiliary: { bounds: FILE_WINDOW_SIZE } }]);
		} catch (error) {
			deps.log(`file window: ${uri.fsPath} could not be opened there: ${messageOf(error)}`);
			return false;
		}
		const created = appearedGroup(before, vscode.window.tabGroups.all);
		if (created === null) {
			deps.log("file window: opening the file created no window; the files stay where they were");
			return true;
		}
		fileWindow.adopt(created);
		await keepFileWindowOnTop();
		// The first tab is already there, in order; the others follow it, then the tab that was active is shown again.
		const moved: vscode.Tab[] = [first];
		for (const tab of tabs.slice(1)) {
			if (await reopenTabInColumn(tab, created.viewColumn)) moved.push(tab);
		}
		const active = source.activeTab;
		if (active !== undefined && active !== moved[moved.length - 1]) await reopenTabInColumn(active, created.viewColumn);
		await vscode.window.tabGroups.close(moved);
		return true;
	}

	return {
		publishSnapshot: publishWindowSnapshot,
		refresh: refreshWindowRegistry,
		registryChanged: windowRegistryChanged,
		heartbeat: windowRegistryHeartbeat,
		allFolders: allWindowFolders,
		noteFocused() {
			windowFocusedAt = new Date().toISOString();
		},
		peers: otherWindows,
		registry: () => deps.registry(),
		heldByAnotherWindow,
		switchToWindow: switchToSessionWindow,
		routeLaunch: routeLaunchToFolderWindow,
		routeOpen: routeSessionOpen,
		serveRequests(context, index, folders) {
			const requestWatch = startRequestWatch(index.claimStorageDir, index.claimHolder.id, async (request, requestContext) => {
				deps.timing("receiver: request seen", `${request.kind} ${request.id.slice(0, 8)} posted ${Date.now() - Date.parse(request.createdAt)} ms ago`);
				const outcome = request.kind === "select"
					? await selectHeldSessionTab(index, request, requestContext)
					: request.kind === "stop"
						? await serveStopRequest(index, request, requestContext)
						: request.kind === "reload"
							? serveReloadRequest(request)
							: request.kind === "models"
								? serveModelsRequest()
								: await serveLaunchRequest(context, index, request, requestContext);
				deps.timing("receiver: answer ready", `${request.id.slice(0, 8)} ok=${outcome.ok} focused=${outcome.focused}`);
				return outcome;
			}, { onError: detail => deps.log(`window requests: ${detail}`), debounceMs: WINDOW_REQUEST_WATCH_DEBOUNCE_MS });
			windowRequestWatch = requestWatch;
			pendingLaunchWatch = startPendingLaunchWatch(
				index.claimStorageDir,
				index.claimHolder.id,
				() => localWindowFolders().map(folder => pendingKeyOf(folders.identityKeyOf(folder))),
				(request, requestContext) => serveLaunchRequest(context, index, request, requestContext),
				{ onError: detail => deps.log(`pending launches: ${detail}`) },
			);
		},
		rescanPendingLaunches() {
			pendingLaunchWatch?.rescan();
		},
		rescanRequests() {
			windowRequestWatch?.rescan();
			pendingLaunchWatch?.rescan();
		},
		serveLaunchRequest,
		reloadAllWindows,
		announceCredentialsChanged,
		serveStopRequest,
		selectHeldTab: selectHeldSessionTab,
		openRestoredTabIfUncovered,
		consumeRequestedSelection,
		fileWindowColumn,
		moveFileToNewWindow,
		dispose() {
			windowRequestWatch?.dispose();
			windowRequestWatch = undefined;
			pendingLaunchWatch?.dispose();
			pendingLaunchWatch = undefined;
		},
	};
}
