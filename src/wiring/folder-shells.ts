/**
 * Folder terminals of a window (`OMP Desk: Open Folder Terminal`, `Reconnect Folder Terminal`): a project shell is a broker slot that belongs to a
 * folder, not to an indexed session, and gets an editor of its own (the shell page) with the same panel plumbing, serializer identity and
 * ownership rules as a session editor. This module launches, re-attaches, shows, observes and ends those shells and settles what a closed
 * shell editor leaves behind.
 */
import { createFileEvidence } from "./file-evidence";
import { createHash } from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";
import { ActivationTimer } from "../host/activation-timing";
import { createShellHtml, createUnavailableGuestHtml } from "../host/guest-webview";
import { createHtmlPageServer } from "../host/html-page-server";
import { installedNerdFonts } from "../host/terminal-fonts";
import { terminalFontFamily } from "../shared/terminal-theme";
import type { LoginFlowDeps } from "../host/provider-login-flow";
import { createHelperSlots } from "../host/helper-slots";
import { observeSessionBranch } from "../host/session-branch";
import type { FooterMetadataMessage } from "../shared/footer-metadata";
import { relativeAge } from "../shared/relative-age";
import type { SessionsGrouping } from "../views/session-order";
import { useSynchronousLocalFs } from "../wire/local-fs";
import { synchronousLocalPaths } from "../wire/private-storage";
import { startFsTurnaroundProbe } from "../host/fs-turnaround";
import { startChatRuntimeWarmup } from "../host/chat-runtime-warmup";
import { SessionIndex } from "../host/session-index";
import { isManagedHost } from "../host/session-model";
import { brokerLossProven } from "../runtime/local-launcher";
import type { LauncherWindow } from "../runtime/local-launcher";
import { LocalExitOperations } from "../runtime/local-exit";
import type { ExitWindow } from "../runtime/local-exit";
import { LocalIdentity } from "../runtime/local-identity";
import type { IdentityWindow } from "../runtime/local-identity";
import { LocalNativeWatch } from "../runtime/local-native-watch";
import { LocalKill } from "../runtime/local-kill";
import type { KillWindow } from "../runtime/local-kill";
import type { NativeWatchWindow } from "../runtime/local-native-watch";
import type { RuntimeRecord } from "../runtime/runtime-record";
import { createRuntimeStaging } from "../runtime/runtime-entries";
import { timedStep } from "../host/session-restore-trace";
import type { RestorePassPhases } from "../host/session-restore-trace";
import { runNativeStage } from "../runtime/native-stage-client";
import { LocalSessionRuntime } from "../runtime/local-runtime";
import type { LocalSessionRuntimeDeps } from "../runtime/local-runtime";
import { LocalWriterVerifier } from "../runtime/local-writer";
import { LocalTransitions } from "../runtime/local-transition";
import { RuntimeRecords } from "../runtime/runtime-record";
import type { ConversationRecord } from "../runtime/runtime-record";
import type { TransitionWindow } from "../runtime/local-transition";
import { type Logger, prefixedLogger } from "../shared/logger";
import { PendingDisplay } from "../host/pending-display";
import { observeLaunchSteps } from "../host/pending-steps";
import type { LaunchReadiness } from "../host/pending-operations";
import { pendingDisplayShell } from "./pending-shell";
import { PersistFailureReporter } from "../host/persist-report";
import { holderSeemsAlive } from "../host/holder-liveness";
import { PageHealthMonitor } from "../host/page-health";
import { WindowRegistry } from "../host/window-registry";
import { warmNativeAsset } from "../host/native-proof";
import { nativeTroubleshootingAnchor } from "../wire/native-module-failure";
import { canonicalFolderKey } from "../host/folder-history";
import { quoteHunkOf } from "./quote-hunk";
import { quoteSourceOf } from "./quote-source";
import { composePreviewQuote } from "./preview-quote";
import type { PreviewDocument } from "./preview-quote";
import type { ActivePreview } from "./preview-selection";
import { sendDesktopNotification } from "../host/desktop-notifications";
import { notificationLine } from "../shared/notification-text";
import { NativeActivityLedger } from "../wire/native-activity";
import { PackageDrift } from "../host/package-drift";
import { WorkspaceFolderTreeItem } from "../views/session-tree";
import { ProcessTreeItem } from "../views/process-rows";
import { registerInventoryViews } from "./inventory-wiring";
import { registerContextView } from "./context-wiring";
import { registerUsageStatus } from "./usage-status-wiring";
import { registerCodeTheme } from "./code-theme-wiring";
import { registerKeyHints } from "./key-hints-wiring";
import { createFileWindow } from "./file-window";
import { registerSessionActions } from "./session-actions";
import { adoptSessionTitle } from "./session-title";
import type { SessionActionsDeps } from "./session-actions";
import { registerRecentSessions } from "./recent-sessions";
import { registerArtifactDocuments } from "./artifact-documents";
import { registerSessionFileDocuments } from "./session-file-documents";
import { registerBridgeHost } from "./bridge-host";
import type { BridgeHostDeps } from "./bridge-host";
import { registerDeskSettingsView } from "./desk-settings-view";
import type { SessionToolsTarget } from "../host/session-tools";
import { folderArgument } from "../views/workspace-folders";
import { LauncherFolders } from "../views/launcher-folders";
import { SessionFolderResolver } from "../wire/session-folder";
import { displayFolderPath } from "../host/folder-display";
import type { LauncherFolder } from "../views/launcher-folders";
import { ChatRuntime } from "../host/chat-runtime";
import { activateAgentDebugger } from "../host/debug/index";
import { PendingForks } from "../host/pending-forks";
import { FORK_REFUSAL_SENTENCES } from "../chat/fork";
import { NAVIGATE_REFUSAL_SENTENCES } from "../chat/rewind";
import type { TurnActivityReport } from "../protocol/activity";
import { STATE_UNCONFIRMED_REASON } from "../protocol/rpc";
import { BridgeAdmissionError } from "../host/bridge-route";
import { EditorCoordinator } from "../host/editor-coordinator";
import { tabInputIdentity } from "../host/bridge-identity";
import { persistedShellSlotId } from "../shared/panel-identity";
import { parseGuestWebviewMessage } from "../protocol/messages";
import { EDITOR_GROUP_FOCUS_COMMANDS } from "../host/chat-layout";
import { selectEditorTab as selectEditorTabThrough } from "../host/editor-tab-selection";
import type { TabSelectionApi } from "../host/editor-tab-selection";
import { PtyBrokerClient } from "../host/pty-client";
import { ptyStateDirectory } from "../wire/pty-registry";
import { ptyRecordedTreeDigestFile } from "../host/pty-runtime";
import { createPtyReadinessGate } from "../host/pty-readiness";
import { createEditorSlotRegistry } from "../host/editor-slots";
import type { EditorSlotRole } from "../host/editor-slots";
import type { BrokerSlotProvenance } from "../host/broker-slots";
import type { PtyHandle } from "../host/pty-client";
import { TerminalPipeline } from "../host/terminal-pipeline";
import type { TerminalHostMessage } from "../host/terminal-pipeline";
import { searchSymbol } from "../host/symbol-search";
import { FileEventGate } from "../host/link-watch";
import { handleInternalLink } from "../host/internal-links";
import { handleCommitLink } from "../host/commit-links";
import { createCommitLinkResolver } from "./commit-links";
import { parseCommitLinkTarget } from "../shared/commit-links";
import { handleLinkRuleOpen } from "../host/link-rules";
import type { LinkRuleSource } from "../host/link-rules";
import { createWindowLinkRules } from "./link-rules";
import { showDeskCommands } from "./palette-commands";
import { parseInternalLink } from "../shared/internal-links";
import { createShellSlotId, shellClosePrompt, reconnectableShellSlots, shellLaunchOutcome, shellSlotsForFolder } from "../host/shell-slots";
import type { ShellLiveness, ShellSlotRecord } from "../host/shell-slots";
import { stopShellAndBroker, watchShellExit, type ShellExitWatchStop } from "../host/shell-exit";
import { watchBrokerLoss } from "../host/broker-loss";
import { setTimeout as delayMs } from "node:timers/promises";
import { openProfileCatalog } from "./catalog-recovery";
import type { OpenedCatalog } from "./catalog-recovery";
import { importPredecessorFolders } from "./predecessor-import";
import { registerCatalogAdoption } from "./catalog-adoption";
import { registerSessionFlows } from "./session-flows";
import { migrateLegacySettings } from "./legacy-settings";
import { migrateSessionFolderSettings } from "./session-folder-settings";
import { editorProjectFolder } from "../host/session-folder-setting";
import { fileClaim } from "./legacy-settings-claim";
import type { LegacySettingsPort } from "./legacy-settings";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { registerSettingsEditors } from "./settings-editors";
import type { SettingsEditorContext } from "../host/omp-settings-editor";
import { SETTINGS_APPLY_NOT_LIVE } from "../host/omp-settings-apply";
import { folderShellOwnerHint } from "../host/shell-owner";
import { shellEditorTitle, shellCleanupDescription, watchShellOwnerStop } from "../host/shell-title";
import type { PtyOwnerHint } from "../wire/pty-protocol";
import type { ControlModelRef } from "../protocol/control";
import type { ControlHostSnapshot } from "../wire/control-protocol";
import { OBSERVATION_DOCUMENT_SCHEME } from "../wire/file-evidence-reader";
import type { TabState, WindowState } from "./window-state";

// In-tab terminal: one managed writer, one frontend per editor (ADR-0024)

/** The folder-shell editor's own view type; a folder shell is never a session editor. */
export const SHELL_VIEW_TYPE = "omp.shellTerminal";
/** The parsed inbound terminal messages a folder-shell panel may send. */
export const TERMINAL_PANEL_TYPES: Record<string, true> = {
  "omp:terminal-attach": true,
  "omp:terminal-probe": true,
  "omp:terminal-input": true,
  "omp:terminal-resize": true,
  "omp:terminal-focus": true,
  "omp:terminal-visibility": true,
  "omp:terminal-link-validate": true,
  "omp:terminal-link-symbols": true,
  "omp:terminal-link-open": true,
};
/** What the folder terminals read of their window and call into. */
export interface FolderShellsDeps {
  readonly windowState: () => WindowState;
  readonly stateOf: (key: string | null) => TabState | undefined;
  readonly showInfo: (message: string) => void;
  readonly showError: (message: string) => void;
  readonly chooseFolder: (index: SessionIndex, folders: LauncherFolders, argument: unknown, options: { readonly title: string; readonly addWhenEmpty: boolean; readonly only?: "pinned" | "unpinned"; readonly openHereFirst?: boolean; readonly nothing?: string; }) => Promise<LauncherFolder | null>;
  readonly showWarning: (message: string) => void;
  readonly brokerClient: () => Promise<PtyBrokerClient | null>;
  readonly attachBrokerClient: () => Promise<PtyBrokerClient | null>;
  readonly tabState: (key: string) => TabState;
  readonly log: Logger;
  readonly handleTerminalGuestMessage: (tabId: string, parsed: { readonly type: string; }, payload: Record<string, unknown>) => Promise<void>;
  readonly refreshLauncher: (options?: { readonly ownership?: boolean; }) => void;
  readonly recordFor: (state: TabState) => ConversationRecord;
  readonly messageOf: (error: unknown) => string;
  readonly ensureTerminalPipeline: (index: SessionIndex, tabId: string, handle: PtyHandle, label?: string | null) => TerminalPipeline;
  readonly stopTerminalForTab: (tabId: string) => void;
}

/** The window's folder terminals: the project shells a folder row opens, their broker slots, editors, serializer and the way a closed editor settles. */
export function createFolderShells(deps: FolderShellsDeps) {
  const { windowState, stateOf, showInfo, showError, chooseFolder, showWarning, brokerClient, attachBrokerClient, tabState, log, handleTerminalGuestMessage, refreshLauncher, recordFor, messageOf, ensureTerminalPipeline, stopTerminalForTab } = deps;

  // Folder shells (ADR-0024): durable slot, own editor, no session identity

  /** The recoverable (detached) shells of one folder, newest first. */
  function recoverableShellsInFolder(folderPath: string): readonly ShellSlotRecord[] {
    const s = windowState();
    const key = canonicalFolderKey(folderPath);
    if (key === null || s.shellSlots === undefined) return [];
    const bound = (slot: string) => {
      const tabId = s.shellEditors.get(slot);
      return tabId !== undefined && stateOf(tabId)?.panel != null;
    };
    return reconnectableShellSlots(s.shellSlots.list(), key, bound);
  }

  /** The broker slot a new folder shell occupies; never a session slot. */
  function newShellSlot(): string {
    return createShellSlotId();
  }

  /**
   * Open Terminal: a **new** general-purpose shell in one folder.
   *
   * This is not the managed host and never becomes one. A user may run anything in
   * it, including a manual `omp`, and that process is theirs: it is not registered,
   * not attached to the full-control GUI, and not represented as a managed session.
   * The slot is recorded before the editor exists, so a close can never strand a
   * live shell tree.
   */
  async function openFolderTerminal(
    context: vscode.ExtensionContext,
    index: SessionIndex,
    argument: unknown,
  ): Promise<void> {
    const folder = await terminalFolder(index, argument, "Choose the folder to open a terminal in");
    if (folder === null) return;
    await launchFolderShell(context, index, folder.path, newShellSlot());
  }

  /**
   * Reconnect Terminal: attach to the exact detached shell a folder still owns.
   *
   * Attach-only: it never starts a second shell. With more than one recoverable slot
   * the user picks the one they mean, because each is a different live process.
   */
  async function reconnectFolderTerminal(
    context: vscode.ExtensionContext,
    index: SessionIndex,
    argument: unknown,
  ): Promise<void> {
    const s = windowState();
    const folder = await terminalFolder(index, argument, "Choose the folder whose terminal to reconnect");
    if (folder === null) return;
    // Explicit Reconnect can also rebind an editor this host can still reach.
    const key = canonicalFolderKey(folder.path);
    const candidates = key === null ? [] : shellSlotsForFolder(s.shellSlots?.list() ?? [], key);
    if (candidates.length === 0) {
      showInfo("This folder has no recorded terminal to reconnect. Open Terminal starts a new one.");
      return;
    }
    const chosen =
      candidates.length === 1
        ? candidates[0]!
        : (
            await vscode.window.showQuickPick(
              candidates.map(record => ({
                label: record.label,
                description: record.detachedAt === null ? "detached" : `detached ${record.detachedAt}`,
                detail: record.cwd,
                record,
              })),
              { title: "Reconnect which terminal?" },
            )
          )?.record ?? null;
    if (chosen === null || chosen === undefined) return;
    const outcome = await attachFolderShell(context, index, chosen);
    if (!outcome) {
      showError(
        `The terminal for ${path.basename(chosen.cwd)} could not be reconnected. It may still be starting or may have ended. ` +
          "Try Reconnect Terminal again, or choose Open Terminal to start a new one.",
      );
    }
  }

  /**
   * The folder a terminal command acts on: the one a row or caller named, or, run from the Command
   * Palette with no argument, the user's choice among the folders Sessions shows.
   */
  async function terminalFolder(index: SessionIndex, argument: unknown, title: string): Promise<LauncherFolder | null> {
    const s = windowState();
    if (argument === undefined) {
      const folders = s.launcherFolders;
      return folders === undefined ? null : await chooseFolder(index, folders, undefined, { title, addWhenEmpty: false });
    }
    const folder = resolveFolderArgument(argument);
    if (folder === null) showWarning("That folder is no longer in Sessions. Refresh Sessions and try again.");
    return folder;
  }

  /** The folder one folder-scoped command was invoked for. */
  function resolveFolderArgument(argument: unknown): LauncherFolder | null {
    const s = windowState();
    if (argument instanceof WorkspaceFolderTreeItem) return s.launcherFolders?.get(argument.folderId) ?? null;
    const resolved = folderArgument(argument, s.launcherFolders?.list() ?? []);
    if (resolved.kind === "folder") return resolved.folder;
    if (resolved.kind === "stale") return null;
    if (typeof argument === "string") return s.launcherFolders?.folderForCwd(argument) ?? null;
    return null;
  }

  /**
   * The owner hint this window offers the broker for a folder shell (ADR-0030).
   *
   * Three numbers are all the extension host can discover: its own pid, its direct
   * parent's pid and the candidate `VSCODE_PID` the installed VS Code sets in its primary
   * process. None of them is proof of anything — the broker's staged helper re-reads each
   * one from the kernel and only then admits the association — so a value this window
   * cannot read as a plain pid yields `null` (no association, and therefore a disabled
   * automatic stop) rather than a guess. Only folder shells ask for this; a managed OMP
   * writer never does, and a managed broker never auto-stops.
   */
  function folderShellOwner(): PtyOwnerHint | null {
    return folderShellOwnerHint({
      extensionHostPid: process.pid,
      parentPid: process.ppid,
      vscodePid: process.env.VSCODE_PID,
    });
  }

  /**
   * Start one folder shell under the broker, with its slot recorded first.
   *
   * The record exists before the editor so that every later outcome — a dismissed
   * close prompt, a failed stop, a failed recreation — retains a durable, recoverable
   * slot instead of stranding a live process behind a closed editor.
   */
  async function launchFolderShell(
    context: vscode.ExtensionContext,
    index: SessionIndex,
    cwd: string,
    slot: string,
  ): Promise<void> {
    const s = windowState();
    const client = await brokerClient();
    if (client === null) {
      showError("Terminal support is unavailable. Reload the window and try Open Terminal again.");
      return;
    }
    const folderKey = canonicalFolderKey(cwd) ?? cwd;
    const store = s.shellSlots;
    if (store === undefined) {
      showError("This window's terminal registry is not available, so no folder terminal could be started.");
      return;
    }
    // Recorded before anything can close: the slot is the recovery path. A registry
    // that cannot carry another slot refuses here, and then no shell is started — a
    // shell whose slot is unknown could be stranded by the very close this record
    // exists to survive.
    const recorded = await store.add({ slot, cwd, folderKey, label: path.basename(cwd) || cwd });
    if (!recorded.ok) {
      showError(recorded.reason);
      return;
    }
    const launched = await client.launchFolderShell({
      slot,
      cwd,
      title: `Terminal: ${path.basename(cwd)}`,
      owner: folderShellOwner(),
    });
    if (launched.handle === null) {
      // The record is the recovery route, so it survives every launch outcome that is not
      // proof that nothing was ever started: a broker that merely published late may be
      // running now, and an occupied slot names a record that is kept on purpose.
      const outcome = shellLaunchOutcome({ state: launched.state, brokerPid: launched.brokerPid });
      if (!outcome.retain) await store.remove(slot).catch(() => undefined);
      showError(
        `The folder terminal could not be started: ${launched.reason}` +
          (outcome.retain
            ? " Try Reconnect Terminal again once it is available."
            : ""),
      );
      return;
    }
    s.shellEditors.set(slot, slot);
    await store.update(slot, { lastGeneration: launched.handle.record.generation, detachedAt: null });
    openShellEditor(context, index, slot, launched.handle);
  }

  /** Attach to a recorded detached shell and show it, or report that it is gone. */
  async function attachFolderShell(
    context: vscode.ExtensionContext,
    index: SessionIndex,
    record: ShellSlotRecord,
  ): Promise<boolean> {
    const s = windowState();
    const client = await attachBrokerClient();
    if (client === null) return false;
    const attached = await client.attach(record.slot, { owner: folderShellOwner() });
    if (attached.handle === null) {
      // The broker could not be reached — it may still be starting, or it may be gone. The
      // slot is kept either way (the shell's own exit has not been proven),
      // and no promise is made that a retry will succeed.
      return false;
    }
    s.shellEditors.set(record.slot, record.slot);
    await s.shellSlots?.update(record.slot, { detachedAt: null, lastGeneration: attached.handle.record.generation });
    openShellEditor(context, index, record.slot, attached.handle);
    return true;
  }

  /**
   * Keep one shell's compact title and tooltip in step with its live cleanup verdict.
   * The exact handle subscription is replaced on reconnect or recreation and dropped
   * when the editor stops, so an old writer cannot change the current shell's metadata.
   */
  function watchShellPanelOwnerStop(slot: string, panel: vscode.WebviewPanel, handle: PtyHandle, label: string): void {
    const state = tabState(slot);
    state.ownerStopWatch?.();
    state.ownerStopWatch = null;
    state.ownerStopWatch = watchShellOwnerStop(handle, label, (title, status) => {
      if (stateOf(slot)?.panel !== panel) return;
      if (panel.title !== title) panel.title = title;
      state.pipeline?.noteDescription(shellCleanupDescription(status?.state));
      // The transition is the diagnostic: the verdict the editor opened on was logged once,
      // and a later disarm — a lost helper, an unattested topology — is what a support log
      // needs. The broker's own reason is recorded verbatim; this is not an error.
      if (status?.state === "disarmed") {
        log.warn(`shell ${slot}: automatic owner-exit cleanup is disarmed: ${status.detail}`);
      }
    });
  }

  /** Show the shell editor for one slot, creating it when this window has none. */
  function openShellEditor(
    context: vscode.ExtensionContext,
    index: SessionIndex,
    slot: string,
    handle: PtyHandle,
  ): void {
    const s = windowState();
    const state = tabState(slot);
    state.shellSlot = slot;
    const record = s.shellSlots?.get(slot) ?? null;
    const cwd = record?.cwd ?? handle.record.title ?? "";
    const label = path.basename(cwd) || cwd;
    if (state.panel !== null) {
      // The watcher writes the fresh verdict's title, so a reconnect through an existing
      // editor corrects the marker instead of leaving the one the previous handle produced.
      state.panel.reveal();
      watchShellPanelOwnerStop(slot, state.panel, handle, label);
      void startShellTerminal(index, slot, handle);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      SHELL_VIEW_TYPE,
      shellEditorTitle(label),
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
      },
    );
    bindShellPanel(context, index, slot, panel, "created");
    watchShellPanelOwnerStop(slot, panel, handle, label);
    void startShellTerminal(index, slot, handle);
  }

  /**
   * Bind one shell editor: its own document, its own message routing, its own close
   * outcome.
   *
   * A shell has no session identity, no claim and no bridge. Its page speaks the same
   * terminal vocabulary as a chat editor's pane, so the same pipeline serves it, and
   * closing a live shell asks for explicit stop confirmation. Confirmed child exit
   * and broker shutdown retire the slot without claiming escaped descendants ended.
   */
  function bindShellPanel(
    context: vscode.ExtensionContext,
    index: SessionIndex,
    slot: string,
    panel: vscode.WebviewPanel,
    origin: "created" | "restored",
  ): void {
    const state = tabState(slot);
    state.panel = panel;
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "terminal-icon.svg");
    state.origin = origin;
    state.shellSlot = slot;
    if (origin === "restored") {
      panel.webview.options = {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
      };
    }
    panel.webview.html = createShellHtml(panel.webview, context.extensionUri, slot);
    panel.webview.onDidReceiveMessage(message => {
      if (stateOf(slot)?.panel !== panel) return;
      const parsed = parseGuestWebviewMessage(message);
      if (parsed === null || TERMINAL_PANEL_TYPES[parsed.type] !== true) return;
      void handleTerminalGuestMessage(slot, parsed, parsed as unknown as Record<string, unknown>).catch(() => {
        log.warn(`shell ${slot}: a terminal message could not be processed`);
      });
    });
    panel.onDidDispose(() => {
      void handleShellEditorClosed(context, index, slot, panel);
    });
    panel.onDidChangeViewState(() => {
      if (stateOf(slot)?.panel !== panel) return;
      stateOf(slot)?.pipeline?.notePanelVisible(panel.visible);
    });
    refreshLauncher();
  }

  /** Attach the shell's writer and give its pane a frontend. */
  async function startShellTerminal(index: SessionIndex, slot: string, handle: PtyHandle): Promise<void> {
    const s = windowState();
    const state = tabState(slot);
    recordFor(state).runtime = null;
    recordFor(state).endedNotice = null;
    try {
      await handle.attach();
    } catch (error) {
      log.warn(`shell ${slot}: the broker could not be attached: ${messageOf(error)}`);
    }
    if (stateOf(slot)?.panel == null) return;
    ensureTerminalPipeline(index, slot, handle);
    const stopOwnerWatch = state.ownerStopWatch;
    const stopExitWatch = watchShellExit(handle, {
      async retireSlot() {
        await s.shellSlots?.remove(slot);
        await s.brokerSlots?.forget(slot);
        refreshLauncher();
      },
      log: prefixedLogger(log, `shell ${slot}: `),
      runRetirement: operation => index.lifecycle.run(slot, operation),
    });
    // The shell's broker may be ended from outside (Kill in Sessions, Task Manager, a crash) without a word over the
    // connection. Its absence is only a trigger: the slot is retired and the pane says its process ended only once the
    // broker's and the shell root's recorded creation times both name gone processes (see `watchRuntimeBroker`).
    // A shell root whose identity was never read keeps its recovery record. The retirement re-checks, inside the slot's
    // gate, that an ordinary Stop or a replacement pane has not taken over the watch.
    let watchingBroker = true;
    const shellRoot = { pid: handle.statusValue?.nativePid ?? 0, creationTime: handle.statusValue?.nativeCreationTime ?? null };
    const stopLossWatch = watchBrokerLoss({
      brokerPid: handle.brokerPid,
      isCurrent: () => watchingBroker,
      onLost: async () => {
        log.warn(`shell ${slot}: the broker process ${handle.brokerPid} no longer exists; checking that its shell (pid ${shellRoot.pid}) is gone too`);
        const proven = shellRoot.pid > 0 && await brokerLossProven(attachBrokerClient, () => watchingBroker, { pid: handle.brokerPid, creationTime: handle.record.brokerCreationTime }, shellRoot);
        if (!watchingBroker) return;
        if (!proven) {
          log.warn(`shell ${slot}: the broker process is gone but its shell could not be confirmed gone; the recovery record is kept`);
          showWarning("A terminal's background process ended, but its shell could not be confirmed ended. Check Task Manager or refresh Sessions.");
          return;
        }
        await index.lifecycle.run(slot, async () => {
          if (!watchingBroker || stateOf(slot)?.ownerStopWatch !== ownStop) return;
          log.info(`shell ${slot}: the broker process and the shell pid ${shellRoot.pid} are gone`);
          await s.shellSlots?.remove(slot);
          await s.brokerSlots?.forget(slot);
          const ended = stateOf(slot);
          if (ended !== undefined) {
            // The pane ends as for an exit the broker reported (exit banner, copyable screen), not as a lost connection.
            recordFor(ended).endedNotice = "This terminal's process has ended.";
            ended.pipeline?.noteProcessGone();
          }
          stopTerminalForTab(slot);
          refreshLauncher();
        });
      },
    });
    const ownStop: ShellExitWatchStop = options => {
      watchingBroker = false;
      stopLossWatch();
      stopOwnerWatch?.(options);
      stopExitWatch(options);
    };
    state.ownerStopWatch = ownStop;
  }

  /**
   * A shell editor closed.
   *
   * VS Code cannot veto a webview editor's close, so this is a post-close decision.
   * Its order is fixed: the durable slot is already recorded (it was written before
   * the editor existed), a dismissal never
   * authorizes termination, Keep Running recreates the editor and reattaches the same
   * broker, and a confirm that cannot be verified as a stop keeps the slot.
   */
  async function handleShellEditorClosed(
    context: vscode.ExtensionContext,
    index: SessionIndex,
    slot: string,
    panel: vscode.WebviewPanel,
  ): Promise<void> {
    const s = windowState();
    const state = stateOf(slot);
    if (state === undefined || state.panel !== panel) return;
    state.panel = null;
    state.origin = null;
    s.shellEditors.delete(slot);
    const record = s.shellSlots?.get(slot) ?? null;
    if (record === null) {
      stopTerminalForTab(slot);
      s.tabs.delete(slot);
      s.shellEditors.delete(slot);
      refreshLauncher();
      return;
    }
    // Detaching is recorded first: from here on, this slot is recoverable whether or
    // not the confirm below ever returns.
    await s.shellSlots?.update(slot, { detachedAt: new Date().toISOString() });
    const observation = await observeFolderShell(slot);
    stopTerminalForTab(slot);
    if (observation === "exited") {
      s.tabs.delete(slot);
      s.shellEditors.delete(slot);
      await s.shellSlots?.remove(slot);
      log.info(`shell ${slot}: closed after its process exited; no tree-stop claim made`);
      refreshLauncher();
      return;
    }
    // A live or unreachable shell is kept recoverable. Closing its editor never
    // promises that commands detached from it were stopped.
    const prompt = shellClosePrompt({
      label: record.label,
      liveness: observation,
    });
    const choice = await vscode.window.showWarningMessage(
      prompt.message,
      { modal: true, detail: prompt.detail },
      "Keep Running",
      prompt.confirmLabel,
    );
    if (choice !== "Terminate") {
      // Keep Running, or a dismissed prompt: both mean the shell keeps running. The
      // editor is recreated and reattached so a live tree is never left without a
      // visible editor.
      const reattached = await attachFolderShell(context, index, record);
      if (!reattached) {
        log.warn(`shell ${slot}: terminal for ${record.cwd} could not be reattached`);
        showWarning("This terminal could not be reconnected. Use Reconnect Terminal to try again.");
      }
      refreshLauncher();
      return;
    }
    await terminateFolderShell(slot, record);
    refreshLauncher();
    // A genuine failure retains its recovery slot, but no longer represents an open
    // editor. Re-read child status so Processes offers Stop with the current facts.
    void vscode.commands.executeCommand("ompDesk.refreshProcesses");
  }

  /** The broker handle for a shell slot, or `null` when it cannot be reached. */
  async function shellWriterFor(slot: string): Promise<PtyHandle | null> {
    const client = await brokerClient();
    if (client === null) return null;
    // Every folder-shell connection offers its owner hint: an attach that carried none
    // would be an unattested association, which the broker answers by disabling automatic
    // stopping — so a liveness check must not silently disarm a shell it is only reading.
    const attached = await client.attach(slot, { owner: folderShellOwner() });
    return attached.handle;
  }

  /**
   * What this window can honestly say about one recorded shell, from one attach.
   *
   * `running` means the broker reported the child alive; `exited` means that child
   * ended, not that every command it started ended. An exited shell can leave the
   * editor and its recovery record silently. An unreachable shell remains recoverable.
   */
  async function observeFolderShell(slot: string): Promise<ShellLiveness> {
    const handle = await shellWriterFor(slot);
    if (handle === null) return "unreachable";
    try {
      const status = await handle.refreshStatus();
      return status.state === "running" ? "running" : "exited";
    } catch {
      return "unreachable";
    }
  }

  /**
   * Terminate one shell and keep or forget its slot on the broker's own verdict.
   *
   * Confirmed shell-child absence followed by authenticated broker shutdown retires
   * its slot. Uncontained descendant uncertainty is logged, never claimed as an
   * empty tree, and is not a failure to stop the shell.
   */
  async function terminateFolderShell(slot: string, record: ShellSlotRecord): Promise<void> {
    const s = windowState();
    const handle = await shellWriterFor(slot);
    if (handle === null) {
      log.warn(`shell ${slot}: terminal for ${record.cwd} could not be reached for termination`);
      showWarning("This terminal could not be reached. Use Stop in Processes to try again.");
      return;
    }
    const outcome = await stopShellAndBroker(handle, {
      async retireSlot() {
        await s.shellSlots?.remove(slot);
        await s.brokerSlots?.forget(slot);
        s.tabs.delete(slot);
        s.shellEditors.delete(slot);
      },
      log: prefixedLogger(log, `shell ${slot}: `),
    });
    if (outcome.kind === "unconfirmed") {
      showWarning(outcome.stage === "retirement"
        ? "This terminal stopped, but its recovery record could not be updated. See OMP Desk output."
        : "This terminal could not be confirmed stopped. Use Stop in Processes to try again; see OMP Desk output.");
    }
  }

  /** The serializer VS Code revives folder-shell editors through. */
  function shellSerializerFor(context: vscode.ExtensionContext, index: SessionIndex) {
    const s = windowState();
    return {
      async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: unknown): Promise<void> {
        const slot = persistedShellSlotId(state);
        const record = slot === null ? null : s.shellSlots?.get(slot) ?? null;
        if (slot === null || record === null) {
          // A shell this workspace no longer has: the editor is kept and explained
          // rather than disposed, exactly as the chat serializers do.
          panel.webview.html = createUnavailableGuestHtml(
            "This terminal editor belongs to a folder shell this window no longer has a record for.",
          );
          return;
        }
        bindShellPanel(context, index, slot, panel, "restored");
        const attached = await attachFolderShell(context, index, record);
        if (!attached) {
          log.warn(`shell ${slot}: the restored editor could not reattach its broker`);
        }
      },
    };
  }
  return { shellSerializerFor, recoverableShellsInFolder, openFolderTerminal, reconnectFolderTerminal, attachFolderShell, handleShellEditorClosed };
}
