/**
 * What the Sessions view's commands do to one session or process: click, open, go to, forget, stop, kill and
 * delete a session, set up the processes of this profile's brokers, and refresh the launcher.
 *
 * The policies are in the session index (`SessionIndex.remove`, `stopRecordedHost`, `reconcileKilledHost`), the
 * deletion transaction (`session-lifecycle.ts`), the kill transaction (`session-kill.ts`) and the ownership
 * verdicts (`session-availability.ts`); this module sequences them and asks the user. It reads and writes
 * nothing of the extension's own state except through {@link SessionActionsDeps}: the window's records, the
 * launcher, the editors and runtimes, the broker and the dialogs all arrive as getters and callbacks. What it
 * keeps itself is only what no other part of the extension reads: the click recognizer.
 */

import * as path from "node:path";
import * as vscode from "vscode";
import type { BrokerSlotProvenance, BrokerSlotStore } from "../host/broker-slots.ts";
import type { DetailTabs } from "../host/detail-tabs.ts";
import type { EditorCoordinator } from "../host/editor-coordinator.ts";
import type { EditorSlotRegistry } from "../host/editor-slots.ts";
import type { SessionHostRuntime, SessionTransitionFacts } from "../host/native-session.ts";
import type { PtyBrokerClient } from "../host/pty-client.ts";
import { stopBrokerOwnedHost } from "../host/rpc-reconcile.ts";
import type { NativeStopVerdict } from "../host/rpc-reconcile.ts";
import { holderSeemsAlive } from "../host/holder-liveness.ts";
import { claimHolderMayBeAlive } from "../host/session-claim.ts";
import { readSessionFileHeader } from "../host/session-files.ts";
import type { OmpHostAttachRequest, OmpHostAttachResult, RestoreOutcome, SessionIndex } from "../host/session-index.ts";
import { createSessionKiller } from "../host/session-kill-wiring.ts";
import type { CapturedHost, KillSelection, RecordedProcess } from "../host/session-kill.ts";
import { confirmedSessionDeletion, deleteManagedSession, inspectSessionDeletion } from "../host/session-lifecycle.ts";
import type { SessionDeletionOptions, SessionDeletionResult, SessionDeletionSubject } from "../host/session-lifecycle.ts";
import type { OwnerReconciler, RecordedHostStopPort } from "../host/session-availability.ts";
import { isManagedHost } from "../host/session-model.ts";
import type { SessionIndexEntry } from "../host/session-model.ts";
import type { ShellExitWatchStop } from "../host/shell-exit.ts";
import type { ShellSlotRecord, ShellSlotStore } from "../host/shell-slots.ts";
import type { WindowRegistry } from "../host/window-registry.ts";
import { askWindowToStop } from "../host/window-requests.ts";
import type { LauncherFolders } from "../views/launcher-folders.ts";
import { ProcessTreeItem } from "../views/process-rows.ts";
import { SessionClickRecognizer } from "../views/session-click.ts";
import type { SessionsGrouping } from "../views/session-order.ts";
import { SessionTreeItem, displaySessionTitle, sessionHeadline } from "../views/session-tree.ts";
import type { LauncherTreeItem, SessionLauncherFacts, SessionTreeProvider } from "../views/session-tree.ts";
import { predecessorStorageDir } from "./predecessor-import.ts";
import { registerSessionProcesses } from "./process-wiring.ts";
import type { SessionProcesses } from "./process-wiring.ts";
import { registerStatsDashboard } from "./stats-wiring.ts";

/** Button that deletes one OMP session's native transcript and artifacts. */
const DELETE_TRANSCRIPT_LABEL = "Delete";
/** The confirmation button for the explicit stop of a row's recorded OMP process. */
const STOP_RECORDED_HOST_LABEL = "Stop OMP Process";

/** What the actions read and change of one editor record of this window. */
export interface SessionTab {
	readonly slotId: string;
	/** The conversation the editor shows, or `null` for a folder shell. */
	readonly tabId: string | null;
	readonly panel: Pick<vscode.WebviewPanel, "reveal" | "dispose"> | null;
	runtime: SessionHostRuntime | null;
	/** Admission fence independent of the lifecycle gate and modal dialogs. */
	transitioning: boolean;
	nativeWatch: (() => void) | null;
	readonly ownerStopWatch: ShellExitWatchStop | null;
}

/** The window's own records the actions read and change. */
export interface SessionWindowFacts {
	/** The activation context, `undefined` before activation. */
	context(): vscode.ExtensionContext | undefined;
	reconciler(): OwnerReconciler;
	/** The durable broker slot table, `undefined` before activation created it. */
	brokerSlots(): BrokerSlotStore | undefined;
	shellSlots(): ShellSlotStore | undefined;
	launcherFolders(): LauncherFolders | undefined;
	/** The tab restore outcomes this window shows; a stop or a deletion clears the one it ends. */
	outcomes(): Map<string, RestoreOutcome>;
	/** The open that is still starting a tab, if any. */
	openingTab(tabId: string): Promise<void> | undefined;
	/** An editor of this window carries the folder shell. */
	hasShellEditor(slot: string): boolean;
	/** The tabs whose stop is in flight; the launcher shows them as stopping. */
	stoppingTabs(): Set<string>;
	/** The window routing, for the window registry that liveness of a claim holder and Kill All read. */
	routing(): { registry(): WindowRegistry | undefined };
	/** The processes of this window's Sessions view, `null` until {@link SessionActions.setupProcesses} registered them. */
	sessionProcesses(): SessionProcesses | null;
	setSessionProcesses(processes: SessionProcesses): void;
	/** The profile catalog has been read in this window. */
	catalogLoaded(): boolean;
}

/** This window's editors and what hangs on a conversation. */
export interface SessionEditorPort<Tab extends SessionTab> {
	/** The record an editor slot or a conversation resolves to. */
	tab(key: string | null): Tab | undefined;
	tabs(): Map<string, Tab>;
	detailTabs(): Pick<DetailTabs, "closeConversation">;
	editorSlots(): Pick<EditorSlotRegistry, "remove">;
	bridgeEditors(): Pick<EditorCoordinator, "releaseEditor">;
	/** The reason the editor slot is passive, or `null` when it controls. */
	passiveReasonForSlot(slot: string): string | null;
}

/** The Sessions view and the rows of its tree. */
export interface SessionLauncherPort {
	launcherProvider(): SessionTreeProvider | undefined;
	launcherView(): vscode.TreeView<LauncherTreeItem> | undefined;
	refreshLauncher(options?: { readonly ownership?: boolean }): void;
	/** What only this window knows about a tab: its panel, its host, its last outcome. */
	facts(tabId: string): SessionLauncherFacts;
	sessionsGrouping(): SessionsGrouping;
}

/** The ordinary open paths and the argument readers of the commands. */
export interface SessionOpenPort<Tab extends SessionTab> {
	openSession(context: vscode.ExtensionContext, index: SessionIndex, argument: unknown, verb: "opened" | "resumed"): Promise<boolean>;
	/** Attach to a recorded detached shell and show it, or report that it is gone. */
	attachFolderShell(context: vscode.ExtensionContext, index: SessionIndex, record: ShellSlotRecord): Promise<boolean>;
	/** The tab a command was invoked on: a launcher row, or an explicit tab id. */
	tabIdArgument(argument: unknown): string | null;
	/** Ask which indexed session a command is for. */
	pickIndexedTab(index: SessionIndex, title: string): Promise<string | null>;
	/** The indexed row one row command names, falling back to the editor in front. */
	sessionTarget(index: SessionIndex, argument: unknown): { readonly tabId: string; readonly entry: SessionIndexEntry } | null;
	/** The runtime of the tab is stopped through the user's own confirmation (or the capture the caller took). */
	confirmAndStopRuntime(
		context: vscode.ExtensionContext, index: SessionIndex, tabId: string,
		state: Tab, runtime: SessionHostRuntime, label: "Stop" | "Close",
		preconfirmed?: { readonly conflicting: boolean; readonly captured: SessionTransitionFacts | null; readonly idleOnly?: boolean; readonly gracefulOnly?: boolean },
	): Promise<boolean>;
}

/** The chat runtime and host control of one tab: what a stop, a reattach and a deletion run through. */
export interface SessionRuntimePort<Tab extends SessionTab> {
	readTransitionFacts(state: Tab, runtime: SessionHostRuntime): Promise<SessionTransitionFacts | null>;
	/** Bound readback and gate admission, not a destructive transaction or a user's dialog. */
	withSessionReadDeadline<T>(read: Promise<T>, timeoutMs?: number): Promise<T>;
	fenceSessionAdmission(index: SessionIndex, state: Tab, fenced: boolean): void;
	pushSessionView(index: SessionIndex | null, state: Tab): void;
	stopSessionRuntime(state: Tab, runtime: SessionHostRuntime, mode: "graceful" | "force", consent: boolean, expected?: SessionTransitionFacts | null): Promise<NativeStopVerdict>;
	/** Drop a tab's terminal frontend; the broker keeps running. */
	stopTerminalForTab(slot: string): void;
	disposeControlChannel(state: Tab): void;
	/** Retire the stopped RPC child's broker and forget its slot. */
	retireBroker(tabId: string, runtime: SessionHostRuntime): Promise<void>;
	releaseHostControl(context: vscode.ExtensionContext, tabId: string, ownerGeneration: string | null): Promise<void>;
	reconnectHostControl(context: vscode.ExtensionContext, index: SessionIndex, tabId: string, ownerGeneration: string, runtime: SessionHostRuntime): Promise<void>;
	attachHost(context: vscode.ExtensionContext, index: SessionIndex, request: OmpHostAttachRequest): Promise<OmpHostAttachResult>;
	/** The control owner a recorded host's credentials are filed under. */
	recordedControlOwner(entry: SessionIndexEntry): string | null;
	/** The control owner of a live runtime's credentials. */
	controlOwnerFor(runtime: SessionHostRuntime, ownerGeneration: string): string;
	/** Drop everything this window remembered about a conversation that is gone. */
	forgetTurnActivity(index: SessionIndex, tabId: string): void;
}

/** The broker this window talks to, and what the session rows record about it. */
export interface SessionBrokerPort {
	/** The broker client, or `null` when brokers are unavailable in this window. */
	brokerClient(): Promise<PtyBrokerClient | null>;
	/** The broker client for re-adopting an already-running broker. */
	attachBrokerClient(): Promise<PtyBrokerClient | null>;
	/** The broker provenance recorded for one row, without loss ({@link readBrokerProvenance}). */
	brokerProvenanceFor(tabId: string): BrokerSlotProvenance;
	/** The transport the index stops a recorded host this window does not run through ({@link createRecordedHostStopPort}). */
	recordedHostStopPort(
		expectedSlot: string,
		/** The broker the caller bound the stop to, when it was shown one: the row's recorded identity must still be it. */
		expectedBroker?: { readonly brokerId: string; readonly brokerGeneration: string } | null,
	): RecordedHostStopPort;
}

/** The profile catalog. */
export interface SessionCatalogPort {
	/** Wait until the catalog and the predecessor import have settled. */
	ensureCatalogReady(): Promise<void>;
	/** Adopt the newest committed catalog revision. */
	adoptCatalogChanges(index: SessionIndex, folders: LauncherFolders, options?: { readonly startup?: boolean }): Promise<void>;
}

/** The dialogs of `vscode.window` the actions ask the user through. */
export interface SessionDialogs {
	showWarningMessage(message: string, options: vscode.MessageOptions, ...items: string[]): Thenable<string | undefined>;
	showQuickPick<T extends vscode.QuickPickItem>(items: readonly T[], options: vscode.QuickPickOptions): Thenable<T | undefined>;
}

/** The log and the notifications. Notifications carry the extension's own prefix. */
export interface SessionNotices {
	log(message: string): void;
	info(message: string): void;
	warn(message: string): void;
	error(message: string): void;
}

export interface SessionActionsDeps<Tab extends SessionTab = SessionTab>
	extends SessionWindowFacts, SessionEditorPort<Tab>, SessionLauncherPort, SessionOpenPort<Tab>, SessionRuntimePort<Tab>,
		SessionBrokerPort, SessionCatalogPort, SessionDialogs, SessionNotices {}

/** What a recorded-process stop binds to: the exact attempt, slot and broker of the row's recorded host. */
export interface RecordedStopCapture {
	readonly slot: string;
	readonly brokerId: string;
	readonly brokerGeneration: string;
	readonly attemptStartedAt: string;
	readonly pid: number | null;
}

/** The runtime and transition facts captured under the confirmation of one deletion. */
interface CapturedSessionStop<Tab extends SessionTab> {
	readonly state: Tab;
	readonly runtime: SessionHostRuntime;
	readonly facts: SessionTransitionFacts | null;
}

/** What the extension calls into the session actions. */
export interface SessionActions {
	/** Tree clicks keep history immediate; only a stopped same-row second click requests a launch. */
	click(context: vscode.ExtensionContext, index: SessionIndex, argument: unknown): Promise<void>;
	/** Click a process row: open what it stands for. */
	openProcess(context: vscode.ExtensionContext, index: SessionIndex, argument: unknown): Promise<void>;
	/** `omp.goToSession`: a searchable list of every session the Sessions view shows. */
	goTo(context: vscode.ExtensionContext, index: SessionIndex): Promise<void>;
	/** Drop one launcher entry, without touching the OMP session file. */
	forget(index: SessionIndex, argument: unknown): Promise<void>;
	/**
	 * Stop this row's recorded OMP process through the broker that owns it. `preconfirmed` is set by the Sessions
	 * view's process stops, which ask nothing for a single stop: the stop must still bind to exactly the attempt,
	 * slot and broker the view read just before.
	 */
	stopHost(
		context: vscode.ExtensionContext,
		index: SessionIndex,
		argument: unknown,
		preconfirmed?: { readonly recorded: RecordedStopCapture; readonly gracefulOnly?: boolean },
	): Promise<boolean>;
	/** Kill (ADR-0060): end the process tree of a session row, or of a process row of the Terminals group, at once. */
	kill(context: vscode.ExtensionContext, index: SessionIndex, argument: unknown): Promise<void>;
	/** Delete one OMP session's native transcript, after an explicit confirmation. */
	delete(index: SessionIndex, argument: unknown): Promise<void>;
	/** Confirm and carry out one session deletion, whichever surface asked for it. `true` when the transcript was removed. */
	confirmAndDelete(index: SessionIndex, subject: SessionDeletionSubject): Promise<boolean>;
	/** Re-read the launcher from the folders it shows, the index and this window. */
	refresh(index: SessionIndex): void;
	/** Register the background processes of the Sessions view and the Stats dashboard. */
	setupProcesses(context: vscode.ExtensionContext, index: SessionIndex, folders: LauncherFolders): void;
	/** A current owned-writer witness, never a recorded pid by itself. */
	verifiedOwnedWriterPid(index: SessionIndex, tabId: string, options?: { readonly display?: boolean }): Promise<number | null>;
	/** Stop the positively verified target after its caller's one confirmation. */
	stopVerifiedOwnedWriter(context: vscode.ExtensionContext, index: SessionIndex, tabId: string, pid: number): Promise<boolean>;
	/** The broker provenance recorded for one row, without loss. */
	brokerProvenanceFor(tabId: string): BrokerSlotProvenance;
	/** Report a folder-list change that could not be saved. */
	reportFolderSaveFailure(folders: LauncherFolders): void;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** What {@link createRecordedHostStopPort} reads of the extension. */
export interface RecordedHostStopPorts {
	brokerProvenanceFor(tabId: string): BrokerSlotProvenance;
	attachBrokerClient(): Promise<PtyBrokerClient | null>;
	log(message: string): void;
}

/** What {@link readBrokerProvenance} reads of the window: the slot table and the editor slots a conversation is shown in. */
export interface BrokerProvenanceSources {
	brokerSlots: BrokerSlotStore | undefined;
	slotsForConversation(tabId: string): readonly { readonly role: string; readonly slotId: string }[];
}

export function registerSessionActions<Tab extends SessionTab>(deps: SessionActionsDeps<Tab>): SessionActions {
	/** Clicks on session rows, told apart by their interval. */
	const sessionClicks = new SessionClickRecognizer();

	/** Tree clicks keep history immediate; only a stopped same-row second click requests a launch. */
	async function clickSession(context: vscode.ExtensionContext, index: SessionIndex, argument: unknown): Promise<void> {
		if (!(argument instanceof SessionTreeItem)) return;
		const tabId = argument.tabId;
		const entry = index.get(tabId);
		if (entry === null) return;
		// Recognize the displayed row synchronously. Async ownership probes would distort
		// the click interval; openSession/openTab still revalidate ownership before launch.
		const stopped = argument.state === "stopped" && !deps.facts(tabId).running && entry.sessionFile !== null;
		const action = sessionClicks.click(`${tabId}\0${entry.sessionFile ?? ""}`, stopped);
		if (action === "launch") await deps.openingTab(tabId);
		await deps.openSession(context, index, argument, action === "launch" ? "resumed" : "opened");
	}

	/**
	 * Click a process row: open what it stands for. A session process opens its session's row as a
	 * click on it would; a terminal shows its editor here, or reconnects it when this window has none;
	 * the Stats dashboard opens its panel. A terminal another window shows is that window's to show.
	 */
	async function openProcess(context: vscode.ExtensionContext, index: SessionIndex, argument: unknown): Promise<void> {
		if (!(argument instanceof ProcessTreeItem) || argument.openTarget === null) return;
		const row = argument.row;
		if (argument.openTarget === "stats") {
			await vscode.commands.executeCommand("omp.openStats");
			return;
		}
		if (argument.openTarget === "session") {
			const tabId = row.host?.kind === "session" ? row.host.tabId : null;
			const item = tabId === null ? undefined : await deps.launcherProvider()?.itemFor(tabId);
			if (item === undefined) {
				deps.info("That session is not listed in Sessions any more. Refresh and try again.");
				return;
			}
			await clickSession(context, index, item);
			return;
		}
		const state = deps.tab(row.slot);
		if (state?.panel != null) {
			state.panel.reveal();
			return;
		}
		const record = deps.shellSlots()?.get(row.slot) ?? null;
		if (record === null) {
			deps.warn("This terminal has no record to reconnect it from. Stop it from Sessions if it is not needed.");
			return;
		}
		if (row.window === "other-window") {
			deps.info("This terminal is open in another VS Code window.");
			return;
		}
		if (!(await deps.attachFolderShell(context, index, record))) {
			deps.warn("This terminal could not be reconnected. It may have ended; refresh Sessions and try again.");
		}
	}

	/**
	 * `omp.goToSession` from anywhere: a searchable list of every session the Sessions view shows, in its
	 * flat order (live unread first, then by activity, stopped last), ended by New Session. Picking a row
	 * is a click on that row; picking New Session runs the row's command.
	 */
	async function goToSession(context: vscode.ExtensionContext, index: SessionIndex): Promise<void> {
		const provider = deps.launcherProvider();
		if (provider === undefined) return;
		interface SessionChoice extends vscode.QuickPickItem { readonly row?: SessionTreeItem }
		const choices: SessionChoice[] = provider.listedSessions().map(({ item, folder }) => {
			const icon = item.iconPath instanceof vscode.ThemeIcon ? `$(${item.iconPath.id}) ` : "";
			const status = typeof item.description === "string" ? item.description : "";
			return { label: `${icon}${item.headline}`, description: folder === "" ? status : `${folder} · ${status}`, row: item };
		});
		if (choices.length > 0) choices.push({ label: "", kind: vscode.QuickPickItemKind.Separator });
		choices.push({ label: "$(add) New Session…", alwaysShow: true });
		const picked = await deps.showQuickPick(choices, {
			title: "Go to OMP Session",
			placeHolder: "Type to filter by title, folder or status",
			matchOnDescription: true,
		});
		if (picked === undefined) return;
		if (picked.row === undefined) await vscode.commands.executeCommand("omp.newSession");
		else await clickSession(context, index, picked.row);
	}

	/**
	 * Drop one launcher entry, without touching the OMP session file.
	 *
	 * Forget removes only launcher metadata and refuses only a positive live
	 * extension-owned writer or verified rival window. Unreadable/stale claims do not
	 * veto it. The native transcript is never removed here.
	 */
	async function forgetSession(index: SessionIndex, argument: unknown): Promise<void> {
		const tabId = deps.tabIdArgument(argument) ?? (await deps.pickIndexedTab(index, "Forget a launcher entry"));
		if (tabId === null) return;
		const entry = index.get(tabId);
		if (entry === null) {
			deps.error("This session is no longer in Sessions. Refresh and try again.");
			return;
		}
		const result = await index.remove(tabId, deps.reconciler());
		if (!result.removed) {
			deps.warn(result.detail);
			deps.refreshLauncher();
			return;
		}
		// A panel without a running host is inactive, but it would outlive the entry
		// it belongs to: close it, then drop everything this window kept for the tab.
		forgetConversationState(tabId);
		deps.refreshLauncher();
	}

	/**
	 * Stop this row's recorded OMP process through the broker that owns it.
	 *
	 * This is the one recovery action that needs no chat runtime: after a chat runtime is lost
	 * in another window, or after a reload, the panel and its runtime are gone
	 * while the extension's own broker may still own the exact recorded child.
	 * Authentication and process generation are rechecked before stopping that child
	 * and shutting down its empty broker.
	 *
	 * The confirmation names what will be done, and the index owns everything that
	 * decides whether it may happen: exact lifecycle target and durable stopped intent
	 * written before dispatch. Unknown outcomes are truthful, not stale ownership;
	 * no numeric PID is ever signalled.
	 */
	async function stopSessionHost(
		context: vscode.ExtensionContext,
		index: SessionIndex,
		argument: unknown,
		/**
		 * Set by the Sessions view's process stops, which ask nothing for a single stop. The row's own
		 * prompt is skipped; the stop must still bind to exactly the attempt, slot and broker the view
		 * read just before (`recorded`), and anything else is refused, never stopped.
		 */
		preconfirmed?: { readonly recorded: RecordedStopCapture; readonly gracefulOnly?: boolean },
	): Promise<boolean> {
		const target = deps.sessionTarget(index, argument);
		if (target === null) {
			deps.warn("Select an OMP session to stop.");
			return false;
		}
		const { tabId, entry } = target;
		if (entry.host === null) {
			deps.warn(
				"This session has no running process that this window can stop. Refresh Sessions and try again.",
			);
			return false;
		}
		if (entry.host.transport === "native" && deps.tab(tabId)?.runtime == null) {
			await reattachNativeForLifecycle(context, index, tabId);
			if (deps.tab(tabId)?.runtime == null) {
				deps.warn("This window could not reconnect to the running session. Use /exit in its Terminal, or reopen its editor and try again.");
				return false;
			}
		}
		const liveState = deps.tab(tabId);
		if (liveState?.runtime != null) {
			const runtime = liveState.runtime;
			const recorded = preconfirmed?.recorded;
			if (recorded !== undefined && (
				runtime.identity.slot !== recorded.slot || runtime.identity.brokerId !== recorded.brokerId ||
				runtime.identity.brokerGeneration !== recorded.brokerGeneration
			)) {
				deps.warn("The session's process changed while the stop was being prepared, so nothing was stopped.");
				return false;
			}
			// The process stop asks nothing for a single stop: the runtime's passive flag and transition
			// facts are read here, immediately before the stop, exactly as the driven capture does.
			const captured = preconfirmed === undefined
				? undefined
				: {
					conflicting: deps.passiveReasonForSlot(liveState.slotId) !== null,
					captured: await index.lifecycle.run(tabId, async () => await deps.readTransitionFacts(liveState, runtime)),
					gracefulOnly: preconfirmed.gracefulOnly === true,
				};
			return await deps.confirmAndStopRuntime(context, index, tabId, liveState, runtime, "Stop", captured);
		}
		// The transport has to exist before anything is confirmed: this row's own recorded
		// broker slot is the only thing that can name the child, and a mapping that cannot
		// be read is uncertainty, never "nothing was launched".
		const provenance = deps.brokerProvenanceFor(tabId);
		if (provenance.kind !== "slot") {
			deps.warn(
				provenance.kind === "none"
					? "This session's connection details are missing. Reopen its editor and try again."
					: "This session's connection details could not be read. Refresh Sessions and try again.",
			);
			return false;
		}
		// The confirmation names one exact attempt and slot; the index re-reads the row under
		// the tab's gate and refuses if it now records another attempt, and the port refuses a
		// slot or broker that changed, so a stale dialog can never stop a process the user was not shown.
		const expect = { attemptStartedAt: entry.host.startedAt, pid: entry.host.pid };
		const risk = "Stops this session. Unsaved replies and work in progress may be lost. Commands started by OMP may continue running separately.";
		const rpc = entry.host.rpc ?? null;
		if (preconfirmed !== undefined) {
			const recorded = preconfirmed.recorded;
			if (
				recorded.slot !== provenance.slot || recorded.attemptStartedAt !== expect.attemptStartedAt || recorded.pid !== expect.pid ||
				rpc === null || rpc.brokerId !== recorded.brokerId || rpc.brokerGeneration !== recorded.brokerGeneration
			) {
				deps.warn("The session's recorded process changed while the stop was being prepared, so nothing was stopped.");
				return false;
			}
		} else {
			const picked = await deps.showWarningMessage(
				`Stop the session in ${path.basename(entry.cwd)}?`,
				{ modal: true, detail: risk },
				STOP_RECORDED_HOST_LABEL,
			);
			if (picked !== STOP_RECORDED_HOST_LABEL) {
				deps.info("Nothing was stopped.");
				return false;
			}
		}
		deps.stoppingTabs().add(tabId);
		deps.refreshLauncher();
		try {
			const result = await index.lifecycle.run(tabId, async lease => {
				const stopped = await index.stopRecordedHost(tabId, {
					stop: deps.recordedHostStopPort(provenance.slot, rpc === null ? null : { brokerId: rpc.brokerId, brokerGeneration: rpc.brokerGeneration }),
					expect,
				}, lease);
				// Retire the exact slot and credentials before a queued Resume can provision
				// a replacement; uncertainty never deletes the recorded proof.
				if (stopped.slot !== null && stopped.stopped) {
					await deps.brokerSlots()?.forget(stopped.slot).catch(() => undefined);
					deps.outcomes().delete(tabId);
					await deps.releaseHostControl(context, tabId, deps.recordedControlOwner(entry));
				}
				return stopped;
			});
			if (!result.stopped) {
				deps.warn(result.detail);
				return false;
			}
			return true;
		} finally {
			deps.stoppingTabs().delete(tabId);
			deps.refreshLauncher();
		}
	}

	/**
	 * Kill (ADR-0060, amended 2026-10-12): end the process tree of a session row, or of a process row
	 * of the Terminals group, at once. It asks OMP nothing and reads no state of the session; the one
	 * check kept is that the recorded process id still has the creation time Desk recorded for it
	 * (`src/host/session-kill.ts`). Only a tree item names its target: Kill never falls back to the
	 * active or the front session the way Stop does, because nothing here asks for confirmation.
	 */
	async function killSession(context: vscode.ExtensionContext, index: SessionIndex, argument: unknown): Promise<void> {
		let selection: KillSelection | null = null;
		if (argument instanceof ProcessTreeItem) {
			selection = { kind: "process", row: argument.row };
		} else {
			const tabId = argument instanceof SessionTreeItem ? argument.tabId : typeof argument === "string" && index.get(argument) !== null ? argument : null;
			const entry = tabId === null ? null : index.get(tabId);
			if (tabId !== null && entry !== null) selection = { kind: "session", tabId, title: deps.launcherProvider()?.headlineFor(tabId) ?? sessionHeadline(entry, null) };
		}
		if (selection === null) {
			deps.warn("Select a session or a process in Sessions to kill.");
			return;
		}
		await createSessionKiller({
			client: deps.attachBrokerClient,
			async readRows() {
				return (await deps.sessionProcesses()?.refresh())?.rows ?? [];
			},
			recordedProcess: tabId => recordedProcessOf(index, tabId),
			async forgetStoppedSlot(slot) {
				await index.lifecycle.run(slot, async () => {
					// Only the broker-slot mapping of a broker shown gone. A folder shell's recovery record stays until its own owner
					// watch proves the shell root gone too: a broker-only proof must not retire it (ADR-0060 amendment).
					await deps.brokerSlots()?.forget(slot);
				});
				deps.refreshLauncher();
			},
			reconcileSession: (tabId, captured) => reconcileKilledSession(context, index, tabId, captured),
			async refresh() {
				deps.refreshLauncher({ ownership: true });
				await deps.sessionProcesses()?.refresh();
			},
			requester: () => `the Sessions menu of window "${vscode.workspace.name ?? "no folder"}" (${index.claimHolder.id.slice(0, 8)})`,
			log: deps.log,
		})(selection);
	}

	/**
	 * The host a session's process is recorded as: this window's own runtime identity when it has one,
	 * else the index's record, together with the launch attempt the row's host record names, so that what
	 * Kill examined stays one exact incarnation.
	 */
	function recordedProcessOf(index: SessionIndex, tabId: string): RecordedProcess | null {
		const entry = index.get(tabId);
		const rpc = deps.tab(tabId)?.runtime?.identity ?? (entry?.host != null && isManagedHost(entry.host) ? entry.host.rpc ?? null : null);
		if (rpc === null) return null;
		return {
			slot: rpc.slot, brokerId: rpc.brokerId, brokerGeneration: rpc.brokerGeneration, brokerPid: rpc.brokerPid,
			brokerCreationTime: rpc.brokerCreationTime, childPid: rpc.childPid, childCreationTime: rpc.childCreationTime,
			attemptStartedAt: entry?.host?.startedAt ?? null, hostPid: entry?.host?.pid ?? null,
		};
	}

	/**
	 * After Kill proved a session's OMP child (and broker) gone: record the row as stopped through the index's
	 * own incarnation-bound transaction (`SessionIndex.reconcileKilledHost`: under the tab's gate, no live rival
	 * holder, the claim taken, and a shared write that is refused when the committed row no longer records the
	 * killed process), then forget the broker slot and the control material of that incarnation.
	 *
	 * A session this window drives, one a live rival window holds, and one that now records a newer launch are
	 * left alone (a benign skip, logged): the owner's broker watch ends the first two, and the third is not the
	 * killed process. Anything else that left the row unrecorded throws, so the command tells the user.
	 */
	async function reconcileKilledSession(context: vscode.ExtensionContext, index: SessionIndex, tabId: string, captured: CapturedHost): Promise<void> {
		const before = index.get(tabId);
		const result = await index.lifecycle.run(tabId, async lease => {
			const recorded = await index.reconcileKilledHost(tabId, captured, lease);
			if (recorded.kind === "recorded") {
				await deps.brokerSlots()?.forget(recorded.slot);
				deps.outcomes().delete(tabId);
				await deps.releaseHostControl(context, tabId, before === null ? null : deps.recordedControlOwner(before));
			}
			return recorded;
		});
		if (result.kind === "recorded") deps.log(`tab ${tabId}: after Kill: the row is recorded as stopped`);
		else if (result.kind === "skipped") deps.log(`tab ${tabId}: after Kill: ${result.detail}`);
		else {
			deps.log(`tab ${tabId}: after Kill: ${result.detail}`);
			throw new Error(result.detail);
		}
	}

	/**
	 * Register the background processes of the Sessions view: the extension's brokers, listed from the
	 * broker registry and stopped only through the broker (or a row's own stop flow). The row flows
	 * it reuses are handed in as captures taken just before the stop, so a stop never runs
	 * against a target that changed in between.
	 */
	function setupSessionProcesses(context: vscode.ExtensionContext, index: SessionIndex, folders: LauncherFolders): void {
		let catalogLoaded = false;
		void deps.ensureCatalogReady().then(() => { catalogLoaded = deps.catalogLoaded(); });
		registerStatsDashboard(context, { client: deps.brokerClient, log: deps.log });
		deps.setSessionProcesses(registerSessionProcesses(context, {
			storageDir: context.globalStorageUri.fsPath,
			predecessorStorageDir: predecessorStorageDir(context.globalStorageUri.fsPath),
			client: deps.attachBrokerClient,
			sessionRows: () => index.list().map(entry => {
				const facts = deps.facts(entry.tabId);
				const provenance = entry.host === null ? null : deps.brokerProvenanceFor(entry.tabId);
				const recorded = entry.host === null
					? null
					: (isManagedHost(entry.host) ? entry.host.rpc?.slot ?? null : null) ?? (provenance?.kind === "slot" ? provenance.slot : null);
				return {
					tabId: entry.tabId,
					title: deps.launcherProvider()?.headlineFor(entry.tabId) ?? sessionHeadline(entry, null),
					folder: entry.cwd,
					hostSlot: recorded,
					open: facts.open,
					running: facts.running,
					// The same fact the Sessions row shows as "Open in another window".
					heldElsewhere: deps.launcherProvider()?.displayedState(entry.tabId) === "otherWindow",
				};
			}),
			brokerSlots: () => deps.brokerSlots(),
			shellSlots: () => deps.shellSlots(),
			shellOpenHere: slot => deps.hasShellEditor(slot),
			// Every runtime this window holds, by exact broker identity: a runtime with no session row (an editor-only one) is still this window's.
			localRuntimes: () => [...deps.tabs().values()].flatMap(state => state.runtime === null
				? []
				: [{ slot: state.runtime.identity.slot, brokerId: state.runtime.identity.brokerId, generation: state.runtime.identity.brokerGeneration, tabId: state.tabId }]),
			indexLoadError: () => index.loadError,
			catalogLoaded: () => catalogLoaded,
			refreshCatalog: () => deps.adoptCatalogChanges(index, folders),
			refreshLauncher: () => deps.refreshLauncher({ ownership: true }),
			publish: snapshot => {
				deps.launcherProvider()?.setProcesses(snapshot);
				const view = deps.launcherView();
				if (view !== undefined) {
					view.message = snapshot.unreadable > 0
						? `${snapshot.unreadable} broker record ${snapshot.unreadable === 1 ? "file" : "files"} could not be read and ${snapshot.unreadable === 1 ? "is" : "are"} not listed.`
						: undefined;
				}
			},
			visible: () => deps.launcherView()?.visible === true,
			layout: deps.sessionsGrouping,
			async peers() {
				// An unreadable registry is not "no other window": a failure rejects, and Kill All then leaves the rows another window may run alone.
				const registry = deps.routing().registry();
				if (!registry) throw new Error("this window has no window registry");
				// The answer of the read this call awaited itself: another read (the watcher's, the heartbeat's) can neither add its records nor erase this one's failure.
				const snapshot = await registry.readOtherWindows();
				if (snapshot.unreadable > 0) throw new Error(`${snapshot.unreadable} window ${snapshot.unreadable === 1 ? "record" : "records"} could not be read`);
				return snapshot.windows.map(({ window, hostPid }) => ({
					holderId: window.holderId,
					label: window.label.length > 0 ? window.label : "another window",
					// The extension host that would serve a request to the window: its end is the only thing that lets a request that may still be served be given up on.
					hostPid,
				}));
			},
			askWindowToStop: (holderId, rows) => askWindowToStop(index.claimStorageDir, { to: holderId, from: index.claimHolder.id, rows }),
			async runBrokerStop(target, operation) {
				if (target.kind !== "folder-shell") return await operation();
				return await index.lifecycle.run(target.slot, async () => {
					// Capture this exact shell's watch; a later editor must not be cancelled.
					const stopWatch = deps.tab(target.slot)?.ownerStopWatch;
					const result = await operation();
					if (result.kind === "stopped") {
						deps.log(`shell ${target.slot}: Sessions Stop acknowledged broker shutdown; no tree-stop claim made`);
						stopWatch?.({ cancelQueuedRetirement: true });
					}
					return result;
				});
			},
			async captureDrivenStop(row, options) {
				// The runtime of this window under exactly this slot, broker and generation: the row's slot alone is not it.
				const state = [...deps.tabs().values()].find(candidate =>
					candidate.runtime !== null && candidate.runtime.identity.slot === row.slot &&
					candidate.runtime.identity.brokerId === row.brokerId && candidate.runtime.identity.brokerGeneration === row.generation);
				const runtime = state?.runtime ?? null;
				const tabId = state?.tabId ?? null;
				const hostTabId = row.host?.kind === "session" ? row.host.tabId : null;
				if (state === undefined || runtime === null || tabId === null || (hostTabId !== null && hostTabId !== tabId)) return null;
				const conflicting = deps.passiveReasonForSlot(state.slotId) !== null;
				const captured = await index.lifecycle.run(tabId, async () => await deps.readTransitionFacts(state, runtime));
				return { run: () => deps.confirmAndStopRuntime(context, index, tabId, state, runtime, "Stop", { conflicting, captured, gracefulOnly: !options.offerForce }) };
			},
			async captureRecordedStop(row, options) {
				const tabId = row.host?.kind === "session" ? row.host.tabId : null;
				const entry = tabId === null ? null : index.get(tabId);
				if (tabId === null || entry === null || entry.host === null) return null;
				const provenance = deps.brokerProvenanceFor(tabId);
				const rpc = isManagedHost(entry.host) ? entry.host.rpc ?? null : null;
				// The stop binds to the exact slot and broker the row was derived from; a native row is
				// reattached first by the row's own flow, which holds the same binding.
				if (
					provenance.kind !== "slot" || provenance.slot !== row.slot ||
					rpc === null || rpc.brokerId !== row.brokerId || rpc.brokerGeneration !== row.generation
				) return null;
				const recorded: RecordedStopCapture = {
					slot: provenance.slot,
					brokerId: rpc.brokerId,
					brokerGeneration: rpc.brokerGeneration,
					attemptStartedAt: entry.host.startedAt,
					pid: entry.host.pid,
				};
				return { run: () => stopSessionHost(context, index, { tabId }, { recorded, gracefulOnly: !options.offerForce }) };
			},
			log: deps.log,
		}));
	}

	/** Attach only; a lifecycle action must never launch a process to stop it. */
	async function reattachNativeForLifecycle(context: vscode.ExtensionContext, index: SessionIndex, tabId: string): Promise<void> {
		const entry = index.get(tabId);
		if (entry?.host?.transport !== "native") return;
		const observation = await index.observeOwnership(tabId);
		const verdict = await deps.reconciler().reconcile({
			entry, sessionFile: entry.sessionFile, draftIdentity: entry.ownership?.draftIdentity ?? null,
			ownerGeneration: entry.ownership?.ownerGeneration ?? "", claim: observation.ok ? observation.claim : null, host: entry.host,
		});
		if (verdict.kind !== "attachable") return;
		await index.restore(tabId, {
			reconciler: deps.reconciler(), allowStoppedResume: false, mode: "terminal",
			launcher: {
				launch: async () => ({ state: "not-started", reason: "A lifecycle action only reattaches an existing native writer." }),
				attach: request => deps.attachHost(context, index, request),
			},
		});
		const runtime = deps.tab(tabId)?.runtime;
		if (runtime?.kind === "terminal") await deps.reconnectHostControl(context, index, tabId, index.get(tabId)?.ownership?.ownerGeneration ?? "", runtime);
	}

	/** A current owned-writer witness, never a recorded pid by itself. */
	async function verifiedOwnedWriterPid(index: SessionIndex, tabId: string, options: { readonly display?: boolean } = {}): Promise<number | null> {
		const runtime = deps.tab(tabId)?.runtime ?? null;
		if (runtime !== null) return runtime.pid;
		const entry = index.get(tabId);
		if (entry === null) return null;
		const observed = await index.observeOwnership(tabId);
		if (observed.ok && observed.claim !== null && observed.claim.holderId !== index.claimHolder.id &&
			(options.display === true ? await holderSeemsAlive(observed.claim, deps.routing().registry()) : await claimHolderMayBeAlive(observed.claim))) return null;
		const verdict = await deps.reconciler().reconcile({
			entry, sessionFile: entry.sessionFile, draftIdentity: entry.ownership?.draftIdentity ?? null,
			ownerGeneration: entry.ownership?.ownerGeneration ?? "", claim: observed.ok ? observed.claim : null, host: entry.host,
		}).catch(() => ({ kind: "free" as const, evidence: [] }));
		return verdict.kind === "attachable" ? verdict.host.pid : verdict.kind === "live" ? verdict.pid ?? entry.host?.pid ?? null : null;
	}

	/** Stop the positively verified target after its caller's one confirmation. */
	async function stopVerifiedOwnedWriter(context: vscode.ExtensionContext, index: SessionIndex, tabId: string, pid: number, captured?: CapturedSessionStop<Tab>): Promise<boolean> {
		deps.stoppingTabs().add(tabId);
		deps.refreshLauncher();
		try {
			return await index.lifecycle.run(tabId, async lease => {
				const currentPid = await verifiedOwnedWriterPid(index, tabId);
				if (currentPid !== pid) {
					if (currentPid === null) return true;
					deps.warn("The running OMP target changed; nothing was stopped.");
					return false;
				}
				const entry = index.get(tabId);
				if (entry === null) return false;
				const state = deps.tab(tabId);
				const runtime = state?.runtime ?? null;
				if (captured !== undefined && (state !== captured.state || runtime !== captured.runtime)) {
					deps.warn("The running session changed while confirmation was pending; nothing was stopped. Try again.");
					return false;
				}
				if (runtime !== null && state !== undefined) {
					await index.setRunIntent(tabId, "stopped", "Stop requested before continuing the user's action.");
					const stopped = await deps.stopSessionRuntime(state, runtime, "graceful", true, captured?.facts);
					deps.log(`session stop ${tabId}: ${stopped.diagnosticDetail ?? stopped.detail}`);
					if (!stopped.writerGone) {
						deps.warn(stopped.detail);
						return false;
					}
					state.runtime = null;
					deps.stopTerminalForTab(state.slotId);
					state.nativeWatch?.();
					state.nativeWatch = null;
					deps.disposeControlChannel(state);
					await index.setRunIntent(tabId, "stopped", stopped.detail);
					await index.closeSession(tabId, { confirmedStopped: true, detail: stopped.detail }, lease);
					await deps.retireBroker(tabId, runtime);
				} else {
					const provenance = deps.brokerProvenanceFor(tabId);
					if (provenance.kind !== "slot" || entry.host === null) return false;
					const stopped = await index.stopRecordedHost(tabId, {
						stop: deps.recordedHostStopPort(provenance.slot),
						expect: { attemptStartedAt: entry.host.startedAt, pid: entry.host.pid },
					}, lease);
					if (!stopped.stopped) {
						deps.warn(stopped.detail);
						return await verifiedOwnedWriterPid(index, tabId) === null;
					}
					if (stopped.slot !== null) await deps.brokerSlots()?.forget(stopped.slot).catch(() => undefined);
				}
				await deps.releaseHostControl(context, tabId, runtime === null ? deps.recordedControlOwner(entry) : deps.controlOwnerFor(runtime, entry.ownership?.ownerGeneration ?? ""));
				deps.outcomes().delete(tabId);
				return true;
			});
		} finally {
			deps.stoppingTabs().delete(tabId);
			deps.refreshLauncher();
		}
	}

	/**
	 * Drop every record this window kept for one conversation.
	 *
	 * A conversation can have more than one editor (a controller and a passive one),
	 * so every record showing it is dropped, not just the one a lookup happens to
	 * resolve. Each editor's panel is closed first: with the row gone there is nothing
	 * left for it to show.
	 */
	function forgetConversationState(tabId: string): void {
		deps.detailTabs().closeConversation(tabId);
		for (const state of [...deps.tabs().values()]) {
			if (state.tabId !== tabId) continue;
			state.panel?.dispose();
			deps.tabs().delete(state.slotId);
			deps.editorSlots().remove(state.slotId);
			deps.bridgeEditors().releaseEditor(state.slotId);
		}
		deps.outcomes().delete(tabId);
	}

	/**
	 * Confirm and carry out one session deletion, whichever surface asked for it.
	 *
	 * One path serves the folder Resume picker's per-row trash and a stopped row's
	 * Delete, for an indexed row and a discovered file alike (ADR-0027): provenance
	 * decides only which identity the row is finalized through, never whether the file
	 * may be deleted. The confirmation lists the exact paths observed right now;
	 * everything is re-read after the dialog; the deletion itself runs
	 * with the file's own lifecycle held — and the tab's, when the subject is an index
	 * row — so no other window can adopt the identity in between; and a partial result
	 * is reported as partial, never as success.
	 *
	 * Only *this window's* own host for the exact row blocks. Another managed OMP
	 * process elsewhere is not this session's owner and does not veto the deletion.
	 */
	async function confirmAndDeleteSession(index: SessionIndex, subject: SessionDeletionSubject): Promise<boolean> {
		try {
			const tabId = typeof subject === "string" && index.get(subject) !== null ? subject : null;
			const activation = deps.context();
			if (tabId !== null && activation !== undefined && deps.tab(tabId)?.runtime == null && index.get(tabId)?.host?.transport === "native") {
				await reattachNativeForLifecycle(activation, index, tabId);
				if (deps.tab(tabId)?.runtime == null && await verifiedOwnedWriterPid(index, tabId) !== null) {
					deps.warn("The running session could not be reconnected; nothing was deleted.");
					return false;
				}
			}
			const state = tabId === null ? undefined : deps.tab(tabId);
			const runtime = state?.runtime ?? null;
			if (state === undefined || runtime === null || tabId === null) return await deleteSessionAfterFence(index, subject);
			if (state.transitioning) { deps.warn("The session is already changing or stopping; nothing was deleted."); return false; }
			try {
				deps.fenceSessionAdmission(index, state, true);
				const facts = await deps.withSessionReadDeadline(index.lifecycle.run(tabId, async () => await deps.readTransitionFacts(state, runtime)));
				return await deleteSessionAfterFence(index, subject, { state, runtime, facts });
			} finally {
				if (state.runtime !== runtime || runtime.kind !== "terminal" || !runtime.stopping) deps.fenceSessionAdmission(index, state, false);
				else deps.pushSessionView(index, state);
			}
		} catch (error) {
			deps.log(`session deletion preparation failed: ${messageOf(error)}`);
			deps.error("The session could not be checked for deletion. Nothing was deleted. Refresh Sessions and try again.");
			deps.refreshLauncher();
			return false;
		}
	}

	async function deleteSessionAfterFence(
		index: SessionIndex,
		subject: SessionDeletionSubject,
		captured?: CapturedSessionStop<Tab>,
	): Promise<boolean> {
		const options: SessionDeletionOptions = {
			index,
			reconciler: deps.reconciler(),
			windowHostRunning: (id: string) => deps.facts(id).running,
		};
		const tabId = typeof subject === "string" && index.get(subject) !== null ? subject : null;
		const writerPid = tabId === null ? null : await deps.withSessionReadDeadline(verifiedOwnedWriterPid(index, tabId), 5_000);
		let inspection = await deps.withSessionReadDeadline(inspectSessionDeletion(subject, writerPid === null ? options : {
			...options, windowHostRunning: () => false,
			reconciler: { reconcile: async () => ({ kind: "free", evidence: [] }) },
		}), 5_000);
		if (inspection === null) {
			deps.error("This session is no longer indexed, so nothing was deleted.");
			deps.refreshLauncher();
			return false;
		}
		const sessionFile = inspection.sessionFile;
		if (sessionFile === null) {
			deps.warn(`This session was not deleted: ${inspection.detail}`);
			deps.refreshLauncher();
			return false;
		}
		if (!inspection.allowed) {
			deps.warn(`This session was not deleted: ${inspection.detail}`);
			deps.refreshLauncher();
			return false;
		}
		deps.log(`Session deletion targets: ${JSON.stringify({ cwd: inspection.cwd, targets: inspection.targets, notes: inspection.notes })}`);
		const header = await readSessionFileHeader(sessionFile);
		const entry = tabId === null ? null : index.get(tabId);
		const name = entry === null ? displaySessionTitle(header?.title ?? "") || displaySessionTitle(header?.promptTitle ?? "") || "OMP session" : sessionHeadline(entry, header);
		const detail = "The session history file and its artifacts will be removed. This cannot be undone.";
		const deleteLabel = DELETE_TRANSCRIPT_LABEL;
		const picked = await deps.showWarningMessage(
			`Delete session “${name}”?`,
			{ modal: true, detail }, deleteLabel,
		);
		if (picked !== deleteLabel) {
			return false;
		}
		if (writerPid !== null && tabId !== null) {
			const context = deps.context();
			if (context === undefined || !(await stopVerifiedOwnedWriter(context, index, tabId, writerPid, captured))) return false;
			inspection = await inspectSessionDeletion(subject, options);
			if (inspection === null || inspection.sessionFile !== sessionFile || !inspection.allowed) {
				deps.warn("The deletion target or its live ownership changed; nothing was deleted.");
				return false;
			}
		}
		const confirmed = confirmedSessionDeletion(inspection);
		if (confirmed === null) {
			deps.warn("This session was not deleted: its file could not be frozen for the removal.");
			return false;
		}
		let result: SessionDeletionResult;
		try {
			// The transaction takes the file's own lifecycle itself; for an index row this
			// window also holds the tab's gate across the deletion and the state cleanup that
			// follows, so a restore or promotion queued behind it cannot republish a runtime
			// this cleanup would then erase.
			result =
				confirmed.tabId === undefined
					? await deleteManagedSession(confirmed, options)
					: await index.lifecycle.run(confirmed.tabId, async lease => {
							const held = await deleteManagedSession(confirmed, options, lease);
							if (held.deleted) {
								forgetConversationState(confirmed.tabId as string);
								deps.forgetTurnActivity(index, confirmed.tabId as string);
							}
							return held;
						});
		} catch (error) {
			deps.log(`session deletion failed: ${messageOf(error)}`);
			deps.error(`This session was not deleted: ${messageOf(error)}`);
			deps.refreshLauncher();
			return false;
		}
		if (!result.deleted) {
			deps.log(`session deletion refused or failed (${result.kind ?? "unknown"}): ${result.detail}`);
			deps.warn(`The OMP session was not deleted: ${result.detail}`);
			deps.refreshLauncher();
			return false;
		}
		deps.refreshLauncher();
		deps.log(`deleted session files ${result.removedPaths.join(", ")}`);
		const partial = result.partial || result.leftovers.length > 0;
		if (!partial) {
			deps.info(result.detail);
			return true;
		}
		const leftovers = result.leftovers.length === 0 ? "" : ` Leftovers that still need recovery: ${result.leftovers.join(", ")}.`;
		const failures = result.failures.length === 0 ? "" : ` ${result.failures.join(" ")}`;
		deps.warn(`${result.detail}${leftovers}${failures}`);
		return true;
	}

	/**
	 * Delete one OMP session's native transcript, after an explicit confirmation.
	 *
	 * The stopped row's Delete is the same transaction the folder Resume picker's trash
	 * uses: the row names the exact file, and the deletion re-reads this window's own host
	 * for it, the durable claim for that exact transcript and the reconciler's verdict at
	 * the moment it acts. Provenance is not permission and neither is the row: a file this
	 * extension did not import is deleted through the very same exact-file transaction,
	 * which takes the exclusive claim itself.
	 */
	async function deleteSession(index: SessionIndex, argument: unknown): Promise<void> {
		const tabId = deps.tabIdArgument(argument) ?? (await deps.pickIndexedTab(index, "Delete an OMP session"));
		if (tabId === null) return;
		await confirmAndDeleteSession(index, tabId);
	}

	/** Re-read the launcher from the folders it shows, the index and this window. */
	function refreshSessions(index: SessionIndex): void {
		// An explicit Refresh is the user's own answer to a launcher they believe is stale, so
		// it adopts the newest committed revision before re-reading anything.
		const folders = deps.launcherFolders();
		if (folders !== undefined) {
			void deps.adoptCatalogChanges(index, folders).catch(error => deps.log(`catalog: the newest revision could not be adopted: ${messageOf(error)}`));
		}
		deps.refreshLauncher({ ownership: true });
		// Refresh never discovers anything: a folder's other sessions are read only when
		// the user asks to resume one.
		deps.log("launcher: refreshed from the folder list, the session index and this window's editors");
	}

	/**
	 * Report a folder-list change that could not be saved.
	 *
	 * The list itself is already changed in this window, so a failed save leaves the
	 * launcher usable; what the user must be able to see is that the change will not
	 * survive this window.
	 */
	function reportFolderSaveFailure(folders: LauncherFolders): void {
		if (folders.persistError !== null) deps.warn(folders.persistError);
	}
	return {
		click: clickSession,
		openProcess,
		goTo: goToSession,
		forget: forgetSession,
		stopHost: stopSessionHost,
		kill: killSession,
		delete: deleteSession,
		confirmAndDelete: confirmAndDeleteSession,
		refresh: refreshSessions,
		setupProcesses: setupSessionProcesses,
		verifiedOwnedWriterPid,
		stopVerifiedOwnedWriter: (context, index, tabId, pid) => stopVerifiedOwnedWriter(context, index, tabId, pid),
		brokerProvenanceFor: tabId => deps.brokerProvenanceFor(tabId),
		reportFolderSaveFailure,
	};
}

/**
 * The transport the index uses to stop a recorded host this window does not run.
 *
 * The row's durable broker slot is resolved here, losslessly
 * ({@link readBrokerProvenance}), because the index owns the policy and never reads
 * the slot table itself. Every refusal is bounded text; nothing is signalled by pid.
 */
export function createRecordedHostStopPort(
	ports: RecordedHostStopPorts,
	expectedSlot: string,
	/** The broker the caller bound the stop to, when it was shown one: the row's recorded identity must still be it. */
	expectedBroker: { readonly brokerId: string; readonly brokerGeneration: string } | null = null,
): RecordedHostStopPort {
	return {
		async stopRecordedHost(entry) {
			const provenance = ports.brokerProvenanceFor(entry.tabId);
			const recordedRpc = entry.host !== null && isManagedHost(entry.host) ? entry.host.rpc ?? null : null;
			if (
				(provenance.kind === "slot" && provenance.slot !== expectedSlot) ||
				(expectedBroker !== null && (recordedRpc === null || recordedRpc.brokerId !== expectedBroker.brokerId || recordedRpc.brokerGeneration !== expectedBroker.brokerGeneration))
			) {
				return {
					kind: "unknown",
					detail:
						"This session changed while the confirmation was open. Nothing was stopped; try Stop again.",
				};
			}
			if (provenance.kind === "unreadable") {
				return {
					kind: "unknown",
					detail: "This session's connection details could not be read. Refresh Sessions and try again.",
				};
			}
			if (provenance.kind === "none") {
				return {
					kind: "unknown",
					detail:
						"This session's connection details are missing. Reopen its editor and try Stop again.",
				};
			}
			const client = await ports.attachBrokerClient();
			if (client === null) {
				return { kind: "unknown", detail: "This session is disconnected. Reopen its editor and try Stop again." };
			}
			if (entry.host?.transport === "native") {
				return { kind: "unknown", detail: "Stop this session from its Terminal editor, or use /exit there." };
			}
			const stopped = await stopBrokerOwnedHost({
				client,
				slot: provenance.slot,
				recordedPid: entry.host?.pid ?? null,
				expected: entry.host !== null && isManagedHost(entry.host) ? (entry.host.rpc ?? null) : null,
			});
			if (!stopped.ok) {
				ports.log(`recorded host stop ${entry.tabId}: ${stopped.reason}`);
				return {
					kind: "unknown",
					// A refusal that never dispatched proves nothing was stopped. One that did is
					// unconfirmed: the recorded process may have stopped or may still be running.
					detail: stopped.dispatched
						? "The session could not be confirmed stopped. Refresh Sessions before resuming; see OMP Desk output for details."
						: "This window could not reach the session safely. Nothing was stopped; refresh Sessions and try again.",
				};
			}
			ports.log(`recorded host stop ${entry.tabId}: ${stopped.verdict.diagnosticDetail ?? stopped.verdict.detail}`);
			return {
				kind: "stopped",
				writerGone: stopped.verdict.writerGone,
				treeEmpty: stopped.verdict.treeEmpty,
				detail: stopped.verdict.detail,
				slot: provenance.slot,
			};
		},
	};
}

/**
 * The broker provenance recorded for one row, without loss.
 *
 * {@link BrokerSlotStore.forConversation} cannot distinguish "this row recorded no
 * slot" from "the mapping could not be read", and both the reconciler's probe and the
 * explicit stop decide whether a writer may exist, so they ask this instead: an
 * unreadable table or entry is uncertainty, never "nothing was launched".
 */
export function readBrokerProvenance(sources: BrokerProvenanceSources, tabId: string): BrokerSlotProvenance {
	if (sources.brokerSlots === undefined) return { kind: "unreadable" };
	const byConversation = sources.brokerSlots.provenanceFor({ conversation: tabId });
	if (byConversation.kind !== "none") return byConversation;
	let unreadable = false;
	for (const binding of sources.slotsForConversation(tabId)) {
		if (binding.role !== "controlling") continue;
		const byEditor = sources.brokerSlots.provenanceFor({ editor: binding.slotId });
		if (byEditor.kind === "slot") return byEditor;
		if (byEditor.kind === "unreadable") unreadable = true;
	}
	return unreadable ? { kind: "unreadable" } : { kind: "none" };
}