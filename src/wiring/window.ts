/**
 * The OMP Desk window: everything one extension host mutates and does while it runs, built by `createWindow` from its dependencies.
 *
 * The factory owns the window's state (`WindowState`, one object) and every operation on it: activation, the editors' lifecycle,
 * the commands, the Sessions view's facts and the Chat and Terminal routes. `src/extension.ts` calls it once from `activate`; the
 * lifecycle test (`src/extension-harness.ts`) calls it once per case. Extension-host lifecycle contract in
 * [ADR-0065](../../docs/decisions/0065-enforce-one-import-direction-between-source-layers.md), amendment 2026-11-03.
 *
 * SessionIndex owns exact-file/catalog identity and per-tab serialization; VS Code owns editor membership. Closing an editor
 * detaches without stopping its child. ADR-0039 refuses only current positive extension ownership. Unknown ownership is usable
 * immediately; verified local/legacy writers offer one confirmed stop-and-Open/Delete path. External writers are the user's
 * responsibility.
 */
import { createProviderModels } from "./provider-models";
import { createFolderCommands } from "./folder-commands";
import { createSessionInsertions, INSERT_TARGET_TIMEOUT_MS, INSERT_POLL_MS } from "./session-insertions";
import { createFolderShells, SHELL_VIEW_TYPE, TERMINAL_PANEL_TYPES } from "./folder-shells";
import { createFileEvidence } from "./file-evidence";
import { createSessionDiagnostics, DIAGNOSTICS_DOCUMENT_SCHEME } from "./session-diagnostics";
import { createHash } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { MODULE_EVALUATION_STARTED_AT, MODULE_EVALUATION_STARTED_CPU_MS } from "../host/module-clock";
import { ActivationTimer } from "../host/activation-timing";
import { PAGE_START_FAILED_MESSAGE, PAGE_START_FAILURE_REASONS, UNAVAILABLE_RELOAD_MESSAGE, createDetailHtml, createMermaidPreviewHtml } from "../host/guest-webview";
import { createHtmlPageServer } from "../host/html-page-server";
import { chatExitText, type ChatExitReason } from "../chat/exit-reason";
import { installedNerdFonts } from "../host/terminal-fonts";
import { terminalFontFamily } from "../shared/terminal-theme";
import { DEFAULT_OMP_PROFILE, delay, renameStoppedSessionTitle, resolveBunRuntime, resolveOmpBinary, resolveOmpPackageRoot, setOmpBackgroundRunner, setOmpPathReader, setOmpResolutionLog, terminalWriterForHandle } from "../host/native-terminal";
import { configuredChatBrokerRuntime, configuredOmpPath, findTerminalForPid } from "../host/omp-vscode";
import { runOmpCli, type OmpCliResult } from "../host/native-terminal";
import { ProviderUsageCache, UsageFailureNotes } from "../host/provider-usage";
import { HelperScheduler, isHelperCancelled } from "../host/helper-scheduler";
import { createHelperSlots } from "../host/helper-slots";
import { readOmpSetting, readOmpSettings, TODO_CLEAR_DELAY_SETTING } from "../host/omp-setting-read";
import { enabledMagicKeywords, MAGIC_KEYWORD_SETTING_KEYS } from "../shared/magic-keywords";
import type { BranchObservation } from "../host/session-branch";
import type { FooterMetadataMessage } from "../shared/footer-metadata";
import { reduceFileBlocks, splitFileBlocks } from "../shared/file-blocks";
import { normalizeSessionsGrouping, planNotificationReveal, sessionsLayoutPickItems } from "../views/session-order";
import type { SessionsGrouping } from "../views/session-order";
import { pinnedSessionTabId, selectionLeaveOtherWindow, selectionRestore } from "../views/session-selection";
import { useSynchronousLocalFs } from "../wire/local-fs";
import { synchronousLocalPaths } from "../wire/private-storage";
import { acquireClaim, claimsDirectory, createClaimHolder, createOwnerGeneration, readProcessCreationTime } from "../host/session-claim";
import { startFsTurnaroundProbe } from "../host/fs-turnaround";
import { startLoopLagMonitor, trackOperation } from "../wire/loop-lag";
import type { OmpBinary, OmpCommand, OmpPackageRoot } from "../host/native-terminal";
import { startChatRuntimeWarmup } from "../host/chat-runtime-warmup";
import { SESSION_INDEX_STORAGE_KEY, mergeSessionIndexRecords, SessionIndex } from "../host/session-index";
import { isManagedHost } from "../host/session-model";
import { readSessionFileHeader } from "../host/session-files";
import { LocalLauncher } from "../runtime/local-launcher";
import type { LauncherWindow } from "../runtime/local-launcher";
import { LocalHostControl, controlDirectoryOf, describeControlError, recordedControlOwner } from "../runtime/local-control";
import type { ControlStore, ControlWindow } from "../runtime/local-control";
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
import { LocalRecordedStop, createRecordedHostStopPort, readBrokerProvenance } from "../runtime/local-recorded-stop";
import { LocalWriterVerifier } from "../runtime/local-writer";
import { LocalTransitions } from "../runtime/local-transition";
import { RuntimeRecords } from "../runtime/runtime-record";
import type { ConversationRecord } from "../runtime/runtime-record";
import type { TransitionWindow } from "../runtime/local-transition";
import type { LiveConversation, StopResult, TransitionToken } from "../runtime/session-runtime";
import { LocalStopOperations, withSessionReadDeadline } from "../runtime/local-stop";
import type { OmpHostLauncher, RestoreOutcome, RestoreReport, SessionConflictKind } from "../host/session-index";
import type { SessionIndexEntry, SessionViewMode } from "../host/session-model";
import { claimHolderMayBeAlive, setProcessProbeObserver } from "../host/session-claim";
import { formatToolSpawn, setToolSpawnObserver } from "../wire/tool-spawn-trace";
import { type Logger } from "../shared/logger";
import { LaunchTimeline, type LaunchKind } from "../host/launch-timeline";
import { PendingOperations, type PendingHandle } from "../host/pending-operations";
import { PendingDisplay } from "../host/pending-display";
import { observeLaunchSteps } from "../host/pending-steps";
import { launchReadiness, stepAfterChatPhase } from "../host/launch-readiness";
import type { LaunchReadiness } from "../host/pending-operations";
import type { PendingKind, PendingOrigin, PendingStep } from "../shared/pending-operation";
import { pendingDisplayShell } from "./pending-shell";
import { PersistFailureReporter } from "../host/persist-report";
import { holderSeemsAlive } from "../host/holder-liveness";
import { PageHealthMonitor } from "../host/page-health";
import { claimFileNameFor, startClaimWatch } from "../host/claim-watch";
import { WindowRegistry } from "../host/window-registry";
import { EditorSlotPruner, EditorSlotWatch } from "../host/editor-slot-prune";
import { ExternalLeaseObserver, nativeLeaseProbe, ompSessionOwnersDir } from "../host/omp-session-lease";
import { describeLoadSteps, startWin32Native, win32Native, win32NativeFailure, win32NativeLoadSteps, win32NativeStartedWarm } from "../wire/win32-native";
import { warmNativeAsset } from "../host/native-proof";
import { announceNativeFailure, nativeDiagnosticsFor, simulatedNativeDelayMs, simulatedNativeFailure } from "./native-module-notice";
import { nativeTroubleshootingAnchor } from "../wire/native-module-failure";
import { comparablePosix, findFileMentions } from "../host/file-mentions";
import { EditorRecency } from "./editor-context";
import { TurnNotifier, desktopNotificationSuppression, reportsTrailingQuestion } from "../wire/notifications";
import type { TurnActivity, TurnNotice, NotificationSuppression } from "../wire/notifications";
import { isLookedAt, markersAfterEvent, markersAfterViewing } from "../host/session-unread";
import { sendDesktopNotification } from "../host/desktop-notifications";
import { notificationLine } from "../shared/notification-text";
import { NativeActivityLedger } from "../wire/native-activity";
import { isOpenControlClient, mayRefreshControlSnapshot, mayReportControlFailure } from "../host/control-attempt";
import { stageRuntimeAssets, type StagedRuntimeAsset } from "../wire/runtime-assets";
import { PackageDrift } from "../host/package-drift";
import { DiagnosticsRecorder, WINDOW_DIAGNOSTIC_SUBJECT, redactCapabilities } from "../host/diagnostics";
import { sessionFileLabel, sessionHeadline, SessionTreeItem, SessionTreeProvider, WorkspaceFolderTreeItem } from "../views/session-tree";
import { ProcessTreeItem } from "../views/process-rows";
import { registerInventoryViews } from "./inventory-wiring";
import { registerContextView } from "./context-wiring";
import { registerUsageStatus } from "./usage-status-wiring";
import { registerCodeTheme } from "./code-theme-wiring";
import { registerKeyHints } from "./key-hints-wiring";
import type { ContextSession, ContextTarget } from "../host/context/context-controller";
import { owningWindowUri, registerWindowRouting } from "./window-routing";
import type { HandOverResult, WindowRoutingDeps } from "./window-routing";
import { createFileWindow } from "./file-window";
import { registerSessionActions } from "./session-actions";
import { adoptSessionTitle } from "./session-title";
import type { SessionActionsDeps } from "./session-actions";
import { CHAT_COMMAND_TYPES, registerGuestDispatcher } from "./guest-dispatcher";
import type { CarriedDraft, GuestDispatcherDeps } from "./guest-dispatcher";
import { registerRecentSessions } from "./recent-sessions";
import { registerArtifactDocuments } from "./artifact-documents";
import { registerSessionFileDocuments } from "./session-file-documents";
import { registerBridgeHost } from "./bridge-host";
import type { BridgeHostDeps } from "./bridge-host";
import { EDITOR_TAB_ICON, UPDATED_ON_DISK_DETAIL, registerEditorPanels } from "./editor-panels";
import type { EditorPanelsDeps, PanelDocument } from "./editor-panels";
import { registerDeskSettingsView } from "./desk-settings-view";
import type { SessionToolsTarget } from "../host/session-tools";
import type { LauncherTreeItem, SessionLauncherFacts, SessionOwnershipFacts } from "../views/session-tree";
import { WorkspaceFolderRegistry, mergeWorkspaceFolderRecords, WORKSPACE_FOLDERS_STORAGE_KEY } from "../views/workspace-folders";
import { LauncherFolders } from "../views/launcher-folders";
import { SessionFolderResolver } from "../wire/session-folder";
import type { LauncherFolder } from "../views/launcher-folders";
import type { FolderPathInspector, FolderPathVerdict } from "../views/workspace-folders";
import { ChatRuntime } from "../host/chat-runtime";
import { activateAgentDebugger } from "../host/debug/index";
import type { ChatPage, ChatRuntimeEvent } from "../host/chat-runtime";
import { attachRpcHost, launchRpcHost } from "../host/rpc-launch";
import { PendingForks } from "../host/pending-forks";
import { FORK_REFUSAL_SENTENCES } from "../chat/fork";
import { attachNativeHost, launchNativeHost, recordedRootGone, waitForManagedRootExit } from "../host/native-session";
import type { SessionHostRuntime, SessionTransitionFacts } from "../host/native-session";
import { createOwnerReconciler, kernelProcessIdentity, probeBrokerSlotForRunningChild, probeRpcHost } from "../host/rpc-reconcile";
import type { ChoiceOutcome, CommandResult, CompactMode, SendRefusal, ShakeMode } from "../host/rpc/session";
import { readSlashRegistry, type BuiltinSlashEntry, type DeskSlashAction } from "../host/slash-registry";
import { readServedModels, ServedModelMemo } from "../host/served-model";
import type { ServedModelPair, ServedModelVerdict } from "../chat/served-model";
import { NAVIGATE_REFUSAL_SENTENCES } from "../chat/rewind";
import { nextToolsMode, toolsModeFromStored, toolsModeToStored, type ToolsModeKey } from "../chat/tools-mode";
import type { ChatLiteState, ChatPhase } from "../chat/model";
import { cancelControlPicker, pickControlModel, pickControlThinking } from "../host/control-picker";
import { activitySignature, withRegistrySubagentWork } from "../protocol/activity";
import type { TurnActivityReport } from "../protocol/activity";
import { STATE_UNCONFIRMED_REASON } from "../protocol/rpc";
import type { ChatDisplayPreferences, ChatWebviewMessage } from "../protocol/chat-messages";
import { BridgeEditorEndpoint, BRIDGE_GUEST_RELOAD_REASON } from "../host/bridge-endpoint";
import { BridgeAdmissionError } from "../host/bridge-route";
import type { BridgeDocumentRoute, BridgeReservation } from "../host/bridge-route";
import { EditorCoordinator } from "../host/editor-coordinator";
import type { BridgeAdmittedRequest, BridgeSession } from "../host/bridge-listener";
import { tabInputIdentity } from "../host/bridge-identity";
import { BRIDGE_MAX_PLAINTEXT_BYTES, asciiJsonText, createToken, encodeHex, randomBytes } from "../protocol/bridge-protocol";
import { isPanelTabId } from "../shared/panel-identity";
import { isSafeBoundaryText, parseGuestWebviewMessage, type GuestChatCommand, type GuestRecallPromptMessage } from "../protocol/messages";
import { DETAIL_VIEW_TYPE, DetailTabs } from "../host/detail-tabs";
import { MERMAID_PREVIEW_VIEW_TYPE, MermaidPreviews } from "../host/mermaid-previews";
import { EDITOR_GROUP_FOCUS_COMMANDS } from "../host/chat-layout";
import { selectEditorTab as selectEditorTabThrough } from "../host/editor-tab-selection";
import type { TabSelectionApi } from "../host/editor-tab-selection";
import { PtyBrokerClient } from "../host/pty-client";
import { ptyStateDirectory } from "../wire/pty-registry";
import { ptyRecordedTreeDigestFile } from "../host/pty-runtime";
import { createPtyReadinessGate } from "../host/pty-readiness";
import { createBrokerSlotStore, mergeBrokerSlotRecords, BROKER_SLOTS_KEY } from "../host/broker-slots";
import { createEditorSlotRegistry } from "../host/editor-slots";
import type { EditorSlotRole } from "../host/editor-slots";
import type { BrokerSlotProvenance } from "../host/broker-slots";
import type { PtyHandle } from "../host/pty-client";
import { TerminalPipeline } from "../host/terminal-pipeline";
import type { TerminalHostMessage } from "../host/terminal-pipeline";
import { fileLinkMenuTarget, handleTerminalLink, openTerminalFile, openWebLink, revealPathInExplorer, revealPathInOs, webLinkMenuUrl } from "../host/terminal-links";
import type { FileLinkAction, TerminalLinkRequest, TerminalLinkValidation, WebLinkMode } from "../shared/terminal-links";
import { MAX_SYMBOL_ENTRIES, SymbolLinkResolver, handleSymbolLinks, hierarchyNode, isNameCandidate, symbolEntry, symbolRoots } from "../host/symbol-links";
import { searchSymbol } from "../host/symbol-search";
import { FileNameLinkResolver, excludePatterns, fileChoiceLabel, folderExcludeSettings, workspaceFileNameSource } from "../host/file-name-links";
import { FileEventGate } from "../host/link-watch";
import type { SymbolLinksRequest, SymbolLinksResolution, SymbolLinksRetry } from "../shared/code-symbols";
import { handleInternalLink } from "../host/internal-links";
import { handleCommitLink } from "../host/commit-links";
import { createCommitLinkResolver } from "./commit-links";
import { parseCommitLinkTarget } from "../shared/commit-links";
import { handleLinkRuleOpen } from "../host/link-rules";
import type { LinkRuleSource } from "../host/link-rules";
import { createWindowLinkRules } from "./link-rules";
import { showDeskCommands } from "./palette-commands";
import { parseInternalLink } from "../shared/internal-links";
import { createShellSlotStore, mergeShellSlotRecords, SHELL_SLOTS_KEY } from "../host/shell-slots";
import { setTimeout as delayMs } from "node:timers/promises";
import { catalogPaths, startCatalogWatch } from "../host/profile-catalog";
import { openProfileCatalog } from "./catalog-recovery";
import type { OpenedCatalog } from "./catalog-recovery";
import { importPredecessorFolders } from "./predecessor-import";
import { registerCatalogAdoption } from "./catalog-adoption";
import type { CatalogAdoption, CatalogAdoptionDeps } from "./catalog-adoption";
import { registerSessionFlows } from "./session-flows";
import type { SessionFlows, SessionFlowsDeps, TransitionChecks } from "./session-flows";
import { migrateLegacySettings } from "./legacy-settings";
import { migrateSessionFolderSettings } from "./session-folder-settings";
import { editorProjectFolder } from "../host/session-folder-setting";
import { fileClaim } from "./legacy-settings-claim";
import type { LegacySettingsPort } from "./legacy-settings";
import { announceRename, foreignOmpNames, legacyContextKey, registerLegacyAliases } from "./legacy-aliases";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { announceUpdaterTerminations, updaterNoticeFiles } from "./updater-notice";
import { registerSettingsEditors } from "./settings-editors";
import type { SettingsEditorContext } from "../host/omp-settings-editor";
import { SETTINGS_APPLY_NOT_LIVE } from "../host/omp-settings-apply";
import { shellCleanupDescription } from "../host/shell-title";
import type { GuestControlRequestMessage, GuestControlStateMessage, GuestPanelAction, GuestPanelActionMessage, GuestHostMessage, GuestSessionViewMessage, GuestTerminalFontMessage, GuestTerminalCopyReplyMessage, GuestTerminalCopyRequestMessage, GuestTerminalActivateMessage } from "../protocol/messages";
import { createControlRequestId, controlPathEquals } from "../wire/control-protocol";
import type { ControlModelRef } from "../protocol/control";
import type { ControlHostSnapshot } from "../wire/control-protocol";
import { HostControlClient, HostControlRefusedError } from "../host/control-client";
import { OBSERVATION_DOCUMENT_SCHEME } from "../wire/file-evidence-reader";
import type { ControlChannel, ObservationDocumentEntry, TabState, TerminalCopyRequest, WindowState } from "./window-state";

const PANEL_VIEW_TYPE = "omp.session";

// The three packaged entries a child process runs. Each is staged into extension
// global storage before use (`runtimeEntries`), so no long-lived process holds
// a file inside the installed extension folder: that folder is what
// `code --install-extension <vsix> --force` renames, and an open file there is what
// fails the rename with EPERM.
/** Packaged native host-control module, loaded by `--preload` and `-e`. */
const HOST_CONTROL_MODULE = "out/omp-host-control.mjs";

/** Packaged koffi addon the Windows checks run through, staged before it is loaded (ADR-0076). */
const NATIVE_ADDON = "out/native/koffi.node";

/** Packaged one-shot child that stages that addon and verifies the tree it lands in (ADR-0076). */
const NATIVE_STAGE_CHILD = "out/native-stage.js";

/** The user guide's troubleshooting page; the notice for a native module that cannot load opens the section for its cause (see `nativeTroubleshootingAnchor`). */
const NATIVE_TROUBLESHOOTING_PAGE = "https://github.com/hmmvot/omp-desk/blob/main/docs/guide/troubleshooting.md";

/**
 * The Bun helper that renames a *stopped* session's stored title through the
 * installed agent's own storage code. It is a plain packaged ESM file: it is not
 * bundled (it imports nothing from this repository) and it is staged like every
 * other child entry, so a reinstall of the extension cannot rename it away.
 */
const RENAME_HELPER_SCRIPT = "media/rename-session.mjs";

/** Packaged module a launcher capability probe preloads (`host/launch-capability.ts`). */
const RUNTIME_PROBE_MODULE = "media/runtime-probe.mjs";

/** Packaged Bun helper that lists the installed OMP's builtin slash commands (`host/slash-registry.ts`). */
const SLASH_REGISTRY_HELPER = "media/slash-registry.mjs";

/** Packaged Bun helper that decides whether a reply's served model differs from the requested one (`host/served-model.ts`). */
const SERVED_MODEL_HELPER = "media/served-model.mjs";

/** Chat publishes promptly; native startup can wait on a heavy workspace. */
const CONTROL_RENDEZVOUS_TIMEOUT_MS = 15_000;

const NATIVE_CONTROL_RENDEZVOUS_TIMEOUT_MS = 60_000;

/** A host this launch already proved published once; a missing record is not startup lag. */
const PROVEN_CONTROL_RENDEZVOUS_TIMEOUT_MS = 3_000;

const CONTROL_RENDEZVOUS_POLL_MS = 250;

/**
 * Contributed launcher view that owns the activity-bar session list.
 */
const SESSIONS_VIEW_ID = "ompDesk.sessions";

/**
 * Context key that keeps the launcher's welcome content off once it shows a folder:
 * a launcher with no folder (none open in this window, none pinned) has no group to
 * show, so its welcome content offers the Add Folder flow instead of an empty list.
 */
const HAS_WORKSPACE_FOLDERS_CONTEXT = "ompDesk.hasWorkspaceFolders";

/** Context key the Sessions title-bar layout button reads (it picks the button's icon): the layout the view shows (`flat`, `folders` or `terminals`). */
const SESSIONS_LAYOUT_CONTEXT = "ompDesk.sessionsLayout";

/**
 * Context key gating the Stop keybinding: true while the OMP chat panel the user
 * is looking at reports the host running a turn. It is set from the guest's own
 * activity reports and from no other source, so the key can never offer to stop
 * a turn nobody observed.
 */
const STREAMING_CONTEXT = "ompDesk.streaming";

/**
 * Context key that keeps the Stop keybinding from firing on a popup dismissal:
 * true while the `@`-completion popup of the panel on screen is open. The
 * composer reports that state, it travels in the same activity report, and
 * Escape means one thing at a time because of it.
 */
const COMPOSER_POPUP_CONTEXT = "ompDesk.composerPopupOpen";

/** What the user is told when a session cannot be opened safely. */
const CONFLICT_LABEL: Record<SessionConflictKind, string> = {
  live: "Another OMP process is already hosting this session",
  "claim-conflict": "Another OMP Desk window holds this session",
  duplicate: "This session is already open in another tab",
};

/** The longest the first launch of a process waits, counted from activation, for the move of the old settings. */
const LEGACY_SETTINGS_MOVE_WAIT_MS = 10_000;

/** The profile-wide marker that the rename notice was decided (shown, or not needed on a fresh install). */
const RENAME_NOTICE_KEY = "ompDesk.renameNotice.v1";

/** The profile-wide name of the VS Code updater log this extension already told the user about. */
const UPDATER_NOTICE_KEY = "ompDesk.updaterNotice.v1";

/** How long a revealed, not-yet-revived editor may take to hand this window its panel. */
const EDITOR_REVIVE_TIMEOUT_MS = 5_000;

const SESSION_DEFAULT_MODE_KEY = "omp.session.defaultMode";

/** How long after the startup restore the installed broker tree is hashed to check the build's record of its digest. */
const PACKAGED_TREE_CHECK_DELAY_MS = 10_000;

// The profile catalog

/** Context key telling the sidebar the catalog is still being read. */
const CATALOG_PENDING_CONTEXT = "ompDesk.catalogPending";

/** Shown by a restored panel for a draft that no explicit action has started yet. */
const DRAFT_NO_HOST_DETAIL =
  "This OMP session has not been started yet. Its tab was kept; click the session's row in the Sessions view to start it.";

/** The largest chat message the bridge carries in one encrypted frame, with headroom. */
const BRIDGE_CHAT_MESSAGE_LIMIT = BRIDGE_MAX_PLAINTEXT_BYTES - 4096;

/** Row grouping stays compatible with panel snapshots; large DTOs are fragmented by the bridge writer. */
const BRIDGE_CHAT_CHUNK_BYTES = 248 * 1024;

/** The only operations the bridge carries: the controls and the chat commands. */
const BRIDGE_OPERATIONS: Record<string, true> = {
  snapshot: true,
  "set-model": true,
  "set-thinking": true,
  tools: true,
  "provider-login": true,
  "chat-prompt": true,
  "chat-steer": true,
  "chat-follow-up": true,
  "chat-abort": true,
  "chat-ui-response": true,
  "chat-load-older": true,
  "chat-resume": true,
  "chat-reconnect": true,
  "chat-restart": true,
  "chat-queue-remove": true,
  "chat-btw-request": true,
  "chat-subagent-read": true,
  "chat-magic-keywords-read": true,
  "terminal-attach": true,
  "terminal-probe": true,
  "terminal-input": true,
  "terminal-resize": true,
  "terminal-focus": true,
  "terminal-visibility": true,
  "terminal-copy-reply": true,
  "terminal-link-validate": true,
  "terminal-link-symbols": true,
  "terminal-link-open": true,
};

/** The webview message type each bridge chat operation carries. */
const BRIDGE_CHAT_OPERATION_TYPE: Record<string, string> = {
  "chat-prompt": "omp:chat-prompt",
  "chat-steer": "omp:chat-steer",
  "chat-follow-up": "omp:chat-follow-up",
  "chat-abort": "omp:chat-abort",
  "chat-ui-response": "omp:chat-ui-response",
  "chat-load-older": "omp:chat-load-older",
  "chat-resume": "omp:chat-resume",
  "chat-reconnect": "omp:chat-reconnect",
  "chat-restart": "omp:chat-restart",
  "chat-queue-remove": "omp:chat-queue-remove",
  "chat-btw-request": "omp:chat-btw-request",
};

/** Prompts the user sent from any Chat, newest first; VS Code's global state, so one list per VS Code profile. */
const PROMPT_HISTORY_KEY = "omp.chat.promptHistory";

const MAX_PROMPT_HISTORY = 200;

/** A prompt longer than this is not remembered: history search is for prompts one retypes. */
const MAX_REMEMBERED_PROMPT = 20_000;

const SLASH_REGISTRY_RECHECK_MS = 60_000;

const SUBAGENT_WORK_POLL_MS = 3_000;

const SUBAGENT_WORK_MAX_FAILURES = 3;

/**
 * The thinking toggle (`Ctrl+Alt+T` in Desk; the TUI's `Ctrl+T`), `Ctrl+O` and Desk's `Ctrl+Shift+O`: one remembered default for every Chat in this VS Code profile.
 * The tool key keeps its name from when it held a boolean; its stored form is in `toolsModeFromStored`.
 */
const THINKING_EXPANDED_KEY = "omp.chat.thinkingExpanded";

const TOOLS_EXPANDED_KEY = "omp.chat.toolsExpanded";

/**
 * One admitted irreversible change, whichever route asked for it.
 *
 * `nativeRequestId` is the single id the change is dispatched under. `fence` and
 * `settle` are present exactly when a document ledger reserved the sequence: a
 * document served through the bridge has one, an older panel whose document this
 * window never bridged does not, and its absence is what tells the caller there is
 * nothing to re-check or release.
 */
interface MutationAdmission {
  readonly nativeRequestId: string;
  readonly fence?: () => void;
  readonly settle?: (outcome: "applied" | "refused" | "unknown") => void;
}

/**
 * Where one guest answer goes, and what may be dispatched for it.
 *
 * The control and tool handlers are written against this and nothing else: the
 * panel route answers through its `WebviewPanel`, the bridge route answers through
 * one authenticated session frame, and neither can tell the other's request apart
 * from its own. An answer is only ever sent while `live()` still holds, so a
 * superseded panel or a fenced document cannot be answered late.
 */
interface GuestResponder {
  /** True while the document that asked is still the one being served. */
  live(): boolean;
  /** Answer the request. */
  reply(message: GuestHostMessage): void;
  /** Reserve one irreversible change, or `null` when this route may not dispatch it. */
  admit(input: { readonly actionSeq: unknown; readonly operation: string; readonly payload: unknown }): MutationAdmission | null;
  /** Tell the page the facts it last read are stale. */
  invalidate(): void;
}

/** The default reason a passive slot is not allowed to act. */
const PASSIVE_REASON_DEFAULT = "This editor is not controlling its session.";

/** Shown while this window has not yet recorded this editor's control of its session. */
const ELECTING_REASON = "This editor is waiting for this window to record its control of the session.";

/** The longest a command waits for an election before it is refused with the reason. */
const ELECTION_WAIT_MS = 15_000;

/** The page messages that need the editor to control its session, and so wait for an election. */
const ELECTION_GATED_TYPES: Readonly<Record<string, true>> = {
  "omp:control-request": true,
  "omp:chat-prompt": true,
  "omp:chat-steer": true,
  "omp:chat-follow-up": true,
  "omp:chat-abort": true,
  "omp:chat-ui-response": true,
  "omp:chat-reconnect": true,
  "omp:chat-restart": true,
  "omp:chat-queue-remove": true,
  "omp:chat-btw-request": true,
  "omp:chat-command": true,
};

/** Why a slot bound to a conversation another writer owns may not act. */
const LIVE_INCUMBENT_REASON = "Another window or writer already holds this session, so this editor is not controlling it.";

const PINNED_SELECTION_RESTORE_MS = 250;

const SESSIONS_LAYOUT_WORDS: Record<SessionsGrouping, string> = {
  flat: "the flat list",
  folders: "folders",
  terminals: "terminals",
};

const OPEN_ANYWAY = "Open Anyway";

/** The action of the notice a window shows when a session it opened is held by another window (ADR-0080). */
const MOVE_TO_THIS_WINDOW_ACTION = "Move to This Window";

// Reinstall under a running window

/** `vscode.ExtensionMode.Production`; compared by value so the mocked `vscode` of the tests need not define the enum. */
const EXTENSION_MODE_PRODUCTION = 1;

const PACKAGE_DRIFT_POLL_MS = 10_000;

const RELOAD_WINDOW_LABEL = "Reload Window";

/** Why a launch is refused after a reinstall: a fixed sentence, no path or file name. */
const UPDATED_ON_DISK_ERROR = "OMP Desk was updated while this window was open. Reload the window to finish updating, then try again.";

const TERMINAL_FONT_CONFIGURATION_KEYS = [
  "terminal.integrated.fontFamily", "terminal.integrated.fontSize", "terminal.integrated.lineHeight",
  "terminal.integrated.letterSpacing", "editor.fontFamily",
] as const;

/** The longest session title the control channel, the tree and the slot all accept. */
const MAX_SESSION_TITLE_CHARS = 200;

/** What a window is built from. */
export interface WindowDeps {
  /** The extension host's activation context. The lifecycle fixture passes none (`undefined`) and assigns the pieces its cases read to `state`. */
  readonly context: vscode.ExtensionContext;
  /** The window's OMP Desk log channel, when its creator already has one; `activate` creates it otherwise. */
  readonly output?: vscode.LogOutputChannel;
  /** The scheduler of the window's helper processes (ADR-0084); `activate` builds the real one over the startup restore and the cross-window slots when absent. */
  readonly helpers?: HelperScheduler;
}

/** Builds one OMP Desk window from its dependencies. */
export function createWindow(deps: WindowDeps) {
  let state: WindowState | undefined;

  /** This window's state. Throws before the window's creation finished, which no caller of an operation can reach. */
  function windowState(): WindowState {
    if (state === undefined) throw new Error("The OMP Desk window state is not created yet.");
    return state;
  }

  async function activate(): Promise<void> {
    const { context } = deps;
    const activationEnteredAt = performance.now();
    const activationEnteredCpu = (process.cpuUsage().user + process.cpuUsage().system) / 1000;
    const activation = new ActivationTimer();
    const s = windowState();
    // The frame server of a reply's HTML page (ADR-0079): bound from here, awaited before any panel is restored (the chat document's
    // policy names its port); only while the setting is on, and closed with the window.
    context.subscriptions.push({ dispose: () => void s.htmlPageServer.close() });
    context.subscriptions.push({ dispose: () => s.pageHealth.dispose() });
    const htmlPageServerBound = chatHtmlPagesEnabled() ? s.htmlPageServer.ensure() : Promise.resolve(null);
    // The `omp-artifact:` and `omp-session-file:` schemes first, synchronously: an editor tab of either that Reload Window restores is served as soon as the window has the provider.
    s.artifactDocuments = registerArtifactDocuments(context.subscriptions);
    s.sessionFileDocuments = registerSessionFileDocuments(context.subscriptions);
    s.output ??= vscode.window.createOutputChannel("OMP Desk", { log: true });
    setOmpResolutionLog(log);
    context.subscriptions.push({ dispose: () => setOmpResolutionLog(null) });
    setOmpPathReader(configuredOmpPath);
    context.subscriptions.push({ dispose: () => setOmpPathReader(null) });
    // Every helper process that shows something next to a conversation goes through the window's helper scheduler (ADR-0084): background work
    // waits for the startup restore (the gate), runs one at a time and takes a cross-window slot; the window's disposal ends what it runs.
    s.helpers = deps.helpers ?? new HelperScheduler({
      log,
      backgroundGate: s.catalogAdoption.startupOver,
      slots: createHelperSlots({ storageDir: context.globalStorageUri.fsPath }),
    });
    setOmpBackgroundRunner((label, run) => s.helpers.run({ label, class: "background", run }));
    context.subscriptions.push({ dispose: () => { setOmpBackgroundRunner(null); s.helpers.dispose(); } });
    // The native module (ADR-0076) answers every Windows question below in process. Its one load starts here, before the
    // first reader asks, and every reader awaits it: a reader that ran ahead of an unfinished load would file this window's
    // claims without a creation time for good.
    if (process.platform === "win32") {
      const nativeStartedAt = performance.now();
      let nativeStagedAfter = 0;
      let warmRefusal = "";
      let warmAgeMs = 0;
      const nativeLoad = startWin32Native(async () => {
        const delayMs = simulatedNativeDelayMs(process.env.OMPDESK_TEST_NATIVE_DELAY_MS);
        if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
        const simulated = simulatedNativeFailure(process.env.OMPDESK_TEST_NATIVE_FAILURE);
        if (simulated !== null) throw new Error(simulated);
        const asset = await s.staging.native();
        nativeStagedAfter = performance.now() - nativeStartedAt;
        // The load records why it has nothing to load; staging's own words are the cause the notice classifies.
        if (asset === null) throw new Error(s.staging.nativeRefusal() ?? "the native module could not be staged");
        return asset;
      }, log, () => {
        // A warm start (ADR-0076, decision 11): the layout was verified by an earlier staging and nothing it covered changed, so the
        // staged copy loads in this very step, with no child process and no turn of the event loop. The test hooks ask for the slow
        // or the failing path, so they bypass it.
        if (simulatedNativeDelayMs(process.env.OMPDESK_TEST_NATIVE_DELAY_MS) > 0 || simulatedNativeFailure(process.env.OMPDESK_TEST_NATIVE_FAILURE) !== null) return null;
        const warm = warmNativeAsset({ storageDir: context.globalStorageUri.fsPath, packagedPath: context.asAbsolutePath(NATIVE_ADDON) });
        if (warm.kind === "none") {
          warmRefusal = warm.reason;
          return null;
        }
        warmAgeMs = warm.ageMs;
        return { asset: warm.asset, verify: warm.verify };
      });
      // Once per window: a load that settled as unavailable says so, with what to do (ADR-0076, decision 6).
      void nativeLoad.then(native => {
        const ready = Math.round(performance.now() - nativeStartedAt);
        const steps = describeLoadSteps(win32NativeLoadSteps());
        log.info(win32NativeStartedWarm()
          ? `window timing: native module ${native === null ? "unavailable" : "ready"} ${ready} ms after activation began (warm start from a verification ${Math.round(warmAgeMs / 60_000)} min old, no staging child; ${steps})`
          : `window timing: native module ${native === null ? "unavailable" : "ready"} ${ready} ms after activation began (staging child ${Math.round(nativeStagedAfter)} ms, load ${Math.round(ready - nativeStagedAfter)} ms${steps === "" ? "" : `: ${steps}`}; no warm start: ${warmRefusal === "" ? "not tried" : warmRefusal})`);
        return announceNativeFailure({
          failure: win32NativeFailure,
          showError: (message, buttons) => vscode.window.showErrorMessage(`OMP Desk: ${message}`, ...buttons),
          copy: text => vscode.env.clipboard.writeText(text),
          openTroubleshooting: failure => vscode.env.openExternal(vscode.Uri.parse(`${NATIVE_TROUBLESHOOTING_PAGE}#${nativeTroubleshootingAnchor(failure)}`)),
          reloadWindow: () => vscode.commands.executeCommand("workbench.action.reloadWindow"),
          diagnostics: failure => nativeDiagnosticsFor({
            failure,
            shippedPath: context.asAbsolutePath(NATIVE_ADDON),
            storageDir: context.globalStorageUri.fsPath,
            vscodeVersion: vscode.version,
            deskVersion: diagnosticsEnvironment(context).extensionVersion,
            arch: process.arch,
          }),
          log,
        });
      });
    }
    activation.mark("native load started");
    // The session claims and the profile catalog are read and written by many small file calls. Each asynchronous call is a job in
    // the host's pool of four file threads and then a turn of its event loop, behind whatever every extension queued at the same
    // moment: at a reload a call that takes a tenth of a millisecond came back after tens or hundreds, and a claim's fifteen calls
    // took seconds. Once the volume is proven local, fixed NTFS (the proof state access already uses), the same calls run as
    // synchronous steps; the locks still wait on timers (ADR-0076, decision 12). Without the native module they stay asynchronous.
    const catalogReadStartedAt = performance.now();
    const synchronousFileCalls = useSynchronousLocalFs(
      [claimsDirectory(context.globalStorageUri.fsPath), catalogPaths(context.globalStorageUri.fsPath).root, ptyStateDirectory(context.globalStorageUri.fsPath)],
      targets => synchronousLocalPaths(targets),
    );
    let catalogReadMs = 0;
    let fileCalls = "asynchronous";
    // The profile catalog's first read is file I/O whose completion waits for a turn of the host's one thread, which other
    // extensions share; it starts now so that wait overlaps the synchronous setup below instead of following it.
    const catalogRead = synchronousFileCalls.then(synchronous => {
      fileCalls = synchronous ? "synchronous" : "asynchronous";
      return createProfileCatalog(context);
    }).then(opened => {
      catalogReadMs = performance.now() - catalogReadStartedAt;
      return opened;
    });
    // Every command and serializer below can build a chat document, whose policy names the frame server's port.
    await htmlPageServerBound;
    // ADR-0068: the old command ids are registered first, as hidden aliases that forward to the commands registered below, so a
    // keybinding of the previous release works as early as any command does. Then the values the `omp.` namespace held move to
    // `ompDesk.` before anything reads a setting; a window with nothing to move does no I/O. A name another extension
    // contributes under `omp.` is not ours to alias, mirror or migrate.
    const foreign = foreignOmpNames(vscode.extensions?.all ?? [], context.extension?.id ?? "");
    legacyContextMirror = !foreign.any;
    const openKeybindingsFile = () => vscode.commands.executeCommand("workbench.action.openGlobalKeybindingsFile");
    context.subscriptions.push(...registerLegacyAliases({
      register: (id, handler) => vscode.commands.registerCommand(id, handler),
      execute: (id, ...args) => vscode.commands.executeCommand(id, ...args),
      warn: (message, action) => vscode.window.showWarningMessage(message, action),
      openKeybindingsFile,
      foreignCommands: foreign.commands,
      log,
    }));
    void announceRename({
      priorInstall: () => access(catalogPaths(context.globalStorageUri.fsPath).document).then(() => true, () => false),
      shown: () => context.globalState.get<boolean>(RENAME_NOTICE_KEY) === true,
      markShown: () => context.globalState.update(RENAME_NOTICE_KEY, true),
      info: (message, action) => vscode.window.showInformationMessage(message, action),
      openKeybindingsFile,
      log,
    });
    // ADR-0068 (amended 2026-10-13): the move starts here and activation does not wait for it. With nothing to move it is
    // synchronous reads and no I/O; with work, the User layer is moved by one window of the profile and the keys concurrently.
    // What must not read a half-moved setting is the first launch of a process (`executablePath`, `linkReminder`): it waits in
    // `brokerClient`, bounded. Everything else that shows a setting re-reads it on a configuration change.
    // The second move (ADR-0073) follows the first, which may have just written `ompDesk.useAgentRootFolder`.
    const settingsPort = legacySettingsPort(context, foreign.settings);
    s.legacySettingsMoved = migrateLegacySettings(settingsPort).then(
      () => undefined,
      error => log.warn(`settings: the move from omp.* to ompDesk.* failed and nothing more was moved: ${messageOf(error)}`),
    ).then(() => migrateSessionFolderSettings(settingsPort)).then(
      () => undefined,
      error => log.warn(`settings: the move to ompDesk.runSessionsAtRepositoryRoot failed and nothing more was moved: ${messageOf(error)}`),
    );
    // The host's one thread is shared with every extension; a stall of 500 ms or more is logged with the Desk operations that overlapped it.
    context.subscriptions.push({ dispose: startLoopLagMonitor(log) });
    context.subscriptions.push({ dispose: startFsTurnaroundProbe({ log, target: os.tmpdir() }) });
    activation.mark("commands, legacy aliases, settings move");
    // This host's start time is one native call once the module is loaded. It runs beside the rest of the setup; only the
    // claims the index writes wait for it (ADR-0035), so the Sessions view, the commands and the editors appear without it.
    // A synchronous read froze every extension in the host; an awaited one held them back.
    const claimHolderCreationTime = readProcessCreationTime(process.pid);
    // The broker client needs only the storage and extension locations, and the state directory's ACL verification (native
    // reads once the module is loaded) is what every attach or launch waits for first.
    // It starts before the catalog is read, the index is built or any registry exists, so it overlaps all of that; every
    // user of the client still awaits this same promise, so a refusal still refuses them. The client starts no broker,
    // host or session.
    s.ptyClient = new PtyBrokerClient({
      storageDir: context.globalStorageUri.fsPath,
      extensionRoot: context.extensionUri.fsPath,
      log,
      chatBrokerRuntime: { setting: configuredChatBrokerRuntime },
      useBuildRecord: context.extensionMode === EXTENSION_MODE_PRODUCTION,
    });
    const stateAccessStartedAt = Date.now();
    void s.ptyClient.stateAccess().then(
      access => windowTiming("broker state access", `${Date.now() - stateAccessStartedAt} ms ok=${access.ok} (${s.ptyClient?.stateAccessPhases() ?? ""})`, "info"),
      () => undefined,
    );
    // The digest of the packaged broker tree is the other thing every re-adoption needs first. It only decides "same build" for a
    // broker that attests its own identity (ADR-0024, ADR-0035). The build records it next to the tree, so this is one small read,
    // synchronous when the extension folder is proved local like the claims' (ADR-0076, decisions 14 and 15), which is why the read
    // starts after that verdict; the installed tree is hashed once, after the startup restore, to check that record, and a build
    // with no record (from source, a watch build) hashes the tree here as before. A refusal is not cached and the first attach asks again.
    const ptyClientForIdentity = s.ptyClient;
    const treeRecordFile = ptyRecordedTreeDigestFile(context.extensionUri.fsPath);
    void useSynchronousLocalFs([path.dirname(treeRecordFile)], () => synchronousLocalPaths([treeRecordFile]))
      .catch(() => false)
      .then(() => ptyClientForIdentity.attachIdentity());
    const ptyClientForTreeCheck = s.ptyClient;
    void s.catalogAdoption.startupOver.then(() => {
      const check = setTimeout(() => { void ptyClientForTreeCheck.verifyPackagedTree().catch(() => undefined); }, PACKAGED_TREE_CHECK_DELAY_MS);
      check.unref();
    });
    // VS Code's own updater stops every Code.exe of the install: the Terminal, folder-shell and Stats brokers (and any Chat broker that fell back to
    // Code.exe) are Code.exe, so say so when it did. A Chat broker on Bun is not.
    void announceUpdaterTerminations({
      ...updaterNoticeFiles({ tempDir: os.tmpdir(), ptyDir: path.join(context.globalStorageUri.fsPath, "pty") }),
      announced: () => context.globalState.get<string>(UPDATER_NOTICE_KEY) ?? null,
      markAnnounced: name => Promise.resolve(context.globalState.update(UPDATER_NOTICE_KEY, name)),
      log,
      notify: message => { void vscode.window.showInformationMessage(`OMP Desk: ${message}`); },
    });
    // The longest a display-only read waits for the startup restore (see `CatalogAdoption.startupRestoreOver`).
    context.subscriptions.push(s.catalogAdoption.armDeferralCap());
    // The report's window timeline starts here: every window-level measurement is relative to
    // the extension host's own activation.
    s.diagnostics.beginSubject(WINDOW_DIAGNOSTIC_SUBJECT, { label: "window", kind: "window" });
    s.diagnostics.note(WINDOW_DIAGNOSTIC_SUBJECT, "extension host activated");
    if (context.extensionMode === EXTENSION_MODE_PRODUCTION) {
      // What this host started from. A same-version reinstall replaces these files under the running
      // window without restarting it; `packageChangedOnDisk` is how that becomes visible.
      const drift = new PackageDrift(context.extensionUri.fsPath);
      s.packageDrift = drift;
      void drift.capture();
      const poll = setInterval(() => { packageChangedOnDisk(); }, PACKAGE_DRIFT_POLL_MS);
      context.subscriptions.push({ dispose: () => clearInterval(poll) });
    }
    activation.mark("broker client, updater notice, drift capture");
    const opened = await catalogRead;
    activation.mark("profile catalog (waited after the setup above)");
    const catalog = opened.store;
    s.catalogStore = catalog;
    s.catalogRecovery = opened.recovery;
    context.subscriptions.push({ dispose: () => opened.recovery.dispose() });
    // The launcher reports that it is still reading the profile's stored sessions until
    // the one-time import of the predecessor build's folder list has settled, so an empty
    // catalog never presents itself as "no folder is registered" while the folders the
    // user already had are still being imported.
    void vscode.commands.executeCommand("setContext", CATALOG_PENDING_CONTEXT, true);
    const claimHolder = { ...createClaimHolder(), windowUri: owningWindowUri()?.toString() ?? null };
    // The window's own URI is read when a row is written: it becomes the home of a session this window starts or attaches (ADR-0080).
    const index = new SessionIndex({
      store: catalog,
      windowUri: () => owningWindowUri()?.toString() ?? null,
      // This window's own observations — its availability reads, the reply its panels
      // displayed, the tab it selected — stay in this window's own store. They are not shared
      // facts: a rival window's failed attach must never publish a status over a session
      // another window is running (ADR-0034).
      localStore: context.workspaceState,
      claimStorageDir: context.globalStorageUri.fsPath,
      claimHolder,
      claimHolderCreationTime,
      log,
      // Contention between windows is saved again by the index itself; only a lock that never frees is shown.
      onPersistStuck: message => windowState().persistFailures.report({ persistError: message }),
    });
    // Protocol activation only reveals an existing handle; it never acquires or starts work.
    context.subscriptions.push(vscode.window.registerUriHandler({
      handleUri: uri => revealDesktopNotification(index, context.extension.id, uri),
    }));
    // The launcher shows the folders VS Code has open in this window plus the profile-wide
    // pinned list (ADR-0045). Only a pinned folder is durable and shared (ADR-0034); an open
    // folder is derived from this window every time and never persisted, and nothing is
    // registered from the index or from OMP's history, so a folder the user unpinned never
    // comes back on its own. Nothing here changes VS Code workspace roots.
    const registry = new WorkspaceFolderRegistry({
      store: catalog,
      inspector: folderPathInspector(),
    });
    const sessionFolders = new SessionFolderResolver();
    // The window registry (ADR-0056): this window's folders and live sessions are published in
    // shared storage and every window derives the same union from the leased records. Records
    // are never persisted as pinned folders.
    const windowsRegistry = new WindowRegistry({
      storageDir: context.globalStorageUri.fsPath,
      holderId: claimHolder.id,
      onError: detail => log.warn(`window registry: ${detail}`),
    });
    s.windowRegistry = windowsRegistry;
    s.editorSlotPruner = new EditorSlotPruner({
      watch: new EditorSlotWatch({ store: context.workspaceState }),
      membership: () => new Set(s.bridgeHost.editorMembership().map(entry => entry.editorId)),
      registry: () => s.windowRegistry,
      index: () => index,
    });
    // The editors VS Code has restored so far are the ones this window holds from the start; a tab it lists later is recorded when its change arrives.
    s.editorSlotPruner.observe();
    if (vscode.window.state.focused) s.routing.noteFocused();
    // The checkout root an opened folder's sessions run at is read from the disk off the tree's path, for the
    // folders of every live window: until the answer arrives the folder shows as itself, and the
    // tree repaints when an answer differs. Whether a folder uses it is its own window's setting, published in the registry.
    s.resolveSessionFolders = async () => {
      await sessionFolders.resolve(s.routing.allFolders())
        .then(changed => { if (changed) refreshLauncher(); })
        .catch(error => log.warn(`launcher: the session folder of an open folder could not be resolved: ${messageOf(error)}`));
    };
    const folders = new LauncherFolders({
      pinned: registry,
      local: context.workspaceState,
      // This window's entry is its own bounded snapshot, the very input every other window reads, so all windows derive the list from the same data.
      windows: () => windowsRegistry.windows().map(window => ({ holderId: window.holderId, here: window.here, startedAt: window.startedAt, focusedAt: window.focusedAt, stale: window.stale, paths: window.folders, ...(window.staysInFolder === undefined ? {} : { staysInFolder: window.staysInFolder }) })),
      sessionFolder: windowPath => sessionFolders.lookup(windowPath),
      showWindowFolders: () => vscode.workspace.getConfiguration("ompDesk").get<boolean>("showWorkspaceFolders", true),
      // A live row never vanishes with its folder: a session any window runs or is starting
      // keeps its folder visible although it is neither open nor pinned.
      liveSessionCwds: () => windowsRegistry.windows().flatMap(window => window.liveCwds),
    });
    s.launcherFolders = folders;
    if (folders.loadError !== null) showWarning(folders.loadError);
    // The in-tab terminal's own state: the broker client was created at the top of `activate`, and it starts no broker,
    // host or session. The staged runtime proof (`ready()`) is asked for lazily, so a window that never opens a managed
    // session never stages or spawns a broker. The surface map and the shell-slot registry are durable and per workspace
    // context, exactly like the folder list.
    // Readiness is asked for lazily and a *failed* check is not latched, so a transient
    // staging or self-check failure is retried by the next reconciliation, attach or
    // open instead of disabling the broker path for the whole activation.
    s.ptyGate = createPtyReadinessGate({
      client: s.ptyClient,
      onFailure: reason => log.warn(`the PTY broker runtime is not usable yet: ${reason}`),
    });
    s.shellSlots = createShellSlotStore(catalog);
    s.brokerSlots = createBrokerSlotStore(catalog);
    // VS Code owns editor existence and layout, and it restores an editor only
    // through the serializer registered for its view type. Registration is
    // synchronous and happens before the asynchronous work below, so an editor VS
    // Code is already reviving always finds one; the panel it hands back carries
    // the tab identity its own document persisted (`src/shared/panel-identity.ts`),
    // which the index then resolves. The index stays authoritative for what the
    // session is and who may write it — a restored editor is a view of a row, never
    // a second claim on it.
    s.indexForBridge = index;
    // Ownership reconciliation reads the facts this window owns, and it proves the
    // *transport* an attach will use: a durable broker slot is looked up here (never
    // from a panel, which a restored row may not have yet), a read-only probe decides
    // whether that broker still owns the recorded child, and a host with no broker
    // provenance keeps the legacy exact-PID terminal path.
    s.reconciler = createOwnerReconciler({
      // The one reading that tells a recycled pid apart from the child this window launched:
      // the kernel creation time, which the broker reads in process through the staged native
      // module. A platform or broker that cannot answer returns `unknown`, which keeps the
      // recorded claim rather than freeing it.
      readProcessIdentity: async pid => {
        const client = await attachBrokerClient();
        if (client === null) return { kind: "unknown", detail: "the PTY broker is not available in this window" };
        return await kernelProcessIdentity(client, pid);
      },
      isProcessAlive,
      brokerSlot: request => {
        // The conversation mapping is what a row, a launcher click or a restored editor has
        // after a restart; the committed controlling editor binding is the fallback. The
        // historical view type and a passive newcomer are never consulted.
        const byConversation = s.brokerSlots?.forConversation(request.entry.tabId) ?? null;
        if (byConversation !== null) return byConversation;
        for (const binding of s.indexForBridge?.slotsForConversation(request.entry.tabId) ?? []) {
          if (binding.role !== "controlling") continue;
          const byEditor = s.brokerSlots?.forEditor(binding.slotId) ?? null;
          if (byEditor !== null) return byEditor;
        }
        return null;
      },
      // The conversation's own mapping only (no editor fallback): what a launch of this conversation reserved.
      conversationBrokerSlot: request => s.brokerSlots?.forConversation(request.entry.tabId) ?? null,
      // Unreadable provenance proves no ownership; the user's actions remain available.
      brokerProvenance: request => windowState().sessionRuntime.brokerProvenance(request.entry.tabId),
      // Proves one rpc row's recorded child from a read-only broker attachment.
      probeRpc: async (slot, expected, kind, steps, keepConnection) => {
        const client = await timedStep(steps, "broker client", () => attachBrokerClient());
        if (client === null) return { kind: "unreachable", reason: "the PTY broker is not available in this window" };
        // The startup pass's rows keep the connection that proved their host for the attach that follows; every other caller closes it.
        const parking = keepConnection === true ? windowState().catalogAdoption.restoreParking() : null;
        return await probeRpcHost({ client, slot, expected, ...(kind === undefined ? {} : { kind }), ...(steps === undefined ? {} : { steps }), ...(parking === null ? {} : { parking }) });
      },
      // A slot's running child is the only writer an unidentified attempt can still be caught
      // by, because it recorded no process id to compare.
      probeBrokerSlot: async (slot, recordedPid) => {
        const client = await attachBrokerClient();
        if (client === null) return { kind: "failed", reason: "the PTY broker is not available in this window" };
        return await probeBrokerSlotForRunningChild({ client, slot, recordedPid });
      },
      // A legacy host's identical hidden VS Code terminal, held by this window.
      hasTerminal: async pid => (await findTerminalForPid(pid)) !== null,
    });
    const settingsBinding = async (tabId: string): Promise<SettingsEditorContext> => {
      const entry = index.get(tabId);
      if (entry === null) throw new Error("The launching OMP conversation is no longer registered.");
      const conversations = s.sessionRuntime.conversations;
      const live = conversations.liveOf(tabId);
      return {
        folder: entry.cwd,
        profile: entry.scope.profile ?? DEFAULT_OMP_PROFILE,
        executable: await executableFor(hostOf(stateOf(tabId)) ?? null),
        sessionLabel: entry.title ?? "launching Chat",
        sessionState: () => {
          const now = conversations.liveOf(tabId);
          if (now === null) return null;
          const model = now.state?.model;
          return { ...(model ? { model: `${model.provider}/${model.id}` } : {}), ...(now.state?.thinkingLevel ? { thinking: now.state.thinkingLevel } : {}), busy: now.working || now.asyncPaused || now.state?.isStreaming === true };
        },
        ...(live === null ? {} : {
          applyDefault: async model => {
            const applied = await conversations.applyModelDefault(tabId, live.incarnation, model, () => {
              const current = index.get(tabId);
              return stateOf(tabId)?.mode !== "terminal" && fencedOf(stateOf(tabId)) !== true
                && current !== null && current.cwd === entry.cwd && current.scope.profile === entry.scope.profile;
            });
            return typeof applied === "string" ? applied : SETTINGS_APPLY_NOT_LIVE;
          },
        }),
      };
    };
    /** `/settings` from a Chat shows that Chat's folder and profile, so its project layer is the one the session reads. */
    const ompConfigBinding = async (tabId: string) => {
      const { folder, profile, executable } = await settingsBinding(tabId);
      return { folder, profile, ...(executable ? { executable } : {}) };
    };
    // The Models, Agents and OMP Settings editors register their commands and panel serializers now and load their code with the
    // first use (ADR-0085). Models and Agents open in the global scope; the editor's scope control reaches a project folder. The full
    // OMP settings editor (ADR-0071): `/settings` in Chat, the palette command and the Sessions title menu. It opens on the
    // active session's folder (else the first workspace folder), so the project layer is one click away from the global one.
    const settingsEditors = registerSettingsEditors(context, {
      log,
      settings: {
        defaultProfile: () => {
          const active = index.activeTabId === null ? null : index.get(index.activeTabId);
          return active?.scope.profile ?? process.env.OMP_PROFILE ?? process.env.PI_PROFILE ?? DEFAULT_OMP_PROFILE;
        },
        folders: () => folders.list().map(folder => folder.path),
        signIn: request => signInProvider(index, request),
      },
      config: {
        defaultProfile: () => {
          const active = index.activeTabId === null ? null : index.get(index.activeTabId);
          return active?.scope.profile ?? process.env.OMP_PROFILE ?? process.env.PI_PROFILE ?? DEFAULT_OMP_PROFILE;
        },
        defaultFolder: async () => {
          // A session's own folder is the one it runs in; an opened workspace folder is resolved by the same rule as Sessions (ADR-0073).
          const active = index.activeTabId === null ? null : index.get(index.activeTabId)?.cwd ?? null;
          if (active !== null) return active;
          const opened = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
          return opened === null ? null : editorProjectFolder(opened);
        },
        folders: () => folders.list().map(folder => folder.path),
      },
    });
    // Desk's host tools (ADR-0055): the debugger tools are registered for every Chat session while ompDesk.agentDebugger.enabled is on.
    const agentDebugger = activateAgentDebugger(context, { log });
    // The candidate colour themes of Chat's fenced code; registered with the context, re-sent to pages when they change.
    const codeThemes = registerCodeTheme(context, { log, changed: () => s.sessionRuntime.conversations.refreshCodeThemes() });
    // The keys the empty Chat shows: the user's own keybindings and other extensions' conflicts, re-sent to pages when they change.
    const keyHints = registerKeyHints(context, { log, changed: () => s.sessionRuntime.conversations.refreshKeyHints() });
    s.keyHints = keyHints;
    context.subscriptions.push({ dispose: () => { s.keyHints = null; } });
    const chat = new ChatRuntime({
      hostNonce: createToken(),
      hostTools: agentDebugger,
      pending: s.pending,
      log,
      onEvent: (tabId, event) => handleChatEvent(context, index, tabId, event),
      readDisplayPreferences: readChatDisplayPreferences,
      readCodeThemes: () => codeThemes.current(),
      readKeyHints: () => keyHints.current(),
      readLinkRules: () => linkRules().current().entries,
      // Terminal-UI builtins typed into Chat are answered, not sent (ADR-0052); the list is the installed OMP's.
      slashRegistry: () => currentSlashRegistry(context),
      runDeskAction: async (action, tabId) => {
        switch (action) {
          case "new-session": return newSessionInPlace(context, index, tabId);
          case "delete-session": return deleteSessionInPlace(context, index, tabId);
          case "fork-session": return forkSession(context, index, tabId);
          case "omp-settings": await settingsEditors.openConfig(await ompConfigBinding(tabId)); return;
          default: return runDeskSlashAction(action);
        }
      },
      // Models from a Chat shows that Chat's folder so its default can be applied to the session;
      // agent settings are global, so Agents opens in the global scope for the Chat's profile.
      openSettings: async (kind, tabId) => {
        if (kind === "omp") { await settingsEditors.openConfig(await ompConfigBinding(tabId)); return; }
        const binding = await settingsBinding(tabId);
        await settingsEditors.openSettings(kind, kind === "agents" ? { folder: null, profile: binding.profile, ...(binding.executable ? { executable: binding.executable } : {}) } : binding);
      },
      // The terminal UI clears a fully closed TODO list after OMP's `tasks.todoClearDelay`; Chat reads the same setting, as OMP's CLI reports it for this tab's profile and folder.
      readTodoClearDelay: async (tabId, cwd) => {
        try {
          const executable = await executableFor(hostOf(stateOf(tabId)) ?? null);
          return await readOmpSetting({ run: visibleOmpCli, executable, cwd, env: ompCliScopeEnvironment(index.get(tabId)?.scope.profile ?? null), key: TODO_CLEAR_DELAY_SETTING });
        } catch (error) {
          if (!isHelperCancelled(error)) log.warn(`tab ${tabId}: ${TODO_CLEAR_DELAY_SETTING} could not be read (${messageOf(error)}); OMP's default applies`);
          return undefined;
        }
      },
      // The magic keywords OMP acts on: the master switch and the keyword's own switch of OMP's effective settings for this tab's profile and folder, in one `omp config list`.
      // A tab with no conversation has no folder of its own: its indexed folder, else the first workspace folder, else the home folder.
      // The profile is resolved once per query by `profileOf` and handed to the read, so the reuse and the sharing of an answer are keyed by the profile the read runs under.
      profileOf: tabId => index.get(tabId)?.scope.profile ?? null,
      readMagicKeywords: async (tabId, cwd, profile) => {
        try {
          const executable = await executableFor(hostOf(stateOf(tabId)) ?? null);
          const values = await readOmpSettings({
            run: visibleOmpCli, executable,
            cwd: cwd ?? index.get(tabId)?.cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir(),
            env: ompCliScopeEnvironment(profile),
            keys: MAGIC_KEYWORD_SETTING_KEYS,
          });
          return enabledMagicKeywords(values);
        } catch (error) {
          if (!isHelperCancelled(error)) log.warn(`tab ${tabId}: the magic keyword settings could not be read (${messageOf(error)}); the page keeps what it has`);
          return null;
        }
      },
    });
    s.sessionRuntime = createSessionRuntime(index, chat);
    s.mermaidPreviews = new MermaidPreviews({
      createPanel: title => {
        const panel = vscode.window.createWebviewPanel(MERMAID_PREVIEW_VIEW_TYPE, title, vscode.ViewColumn.Active, {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
        });
        panel.iconPath = vscode.Uri.joinPath(context.extensionUri, EDITOR_TAB_ICON);
        panel.webview.html = createMermaidPreviewHtml(panel.webview, context.extensionUri);
        return panel;
      },
      log,
    });
    s.detailTabs = new DetailTabs({
      createPanel: (conversation, target) => {
        const entry = index.get(conversation);
        const headline = s.launcherProvider?.headlineFor(conversation) ?? (entry === null ? "OMP session" : sessionHeadline(entry, null));
        const label = target.kind === "todo" ? "TODO" : target.kind === "agents" ? "Agents" : target.agentId;
        const panel = vscode.window.createWebviewPanel(DETAIL_VIEW_TYPE, `${label} · ${headline}`, vscode.ViewColumn.Active, {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
        });
        panel.iconPath = vscode.Uri.joinPath(context.extensionUri, EDITOR_TAB_ICON);
        panel.webview.html = createDetailHtml(panel.webview, context.extensionUri, target);
        return panel;
      },
      attachPage: (conversation, page) => s.sessionRuntime.conversations.attachPage(conversation, page),
      handleMessage: (conversation, message, origin) => s.sessionRuntime.conversations.command(conversation, message, origin),
      openMermaid: source => { log.debug(`diagram tab was ${s.mermaidPreviews.open(source)}`); },
      openArtifact: (conversation, request) => s.guestDispatcher.openArtifact(conversation, request),
      openUrl: async (url, mode) => {
        try { await openPageWebLink(url, mode); }
        catch (error) { log.warn(`detail link: cannot open ${url}: ${messageOf(error)}`); showWarning(`cannot open ${url}: ${messageOf(error)}`); }
      },
      log,
    });
    context.subscriptions.push({ dispose: () => {
      cancelControlPicker();
      s.detailTabs.dispose();
      s.mermaidPreviews.dispose();
      s.sessionRuntime.conversations.dispose();
      for (const binding of s.footerBindings.values()) binding.observer?.dispose();
      s.footerBindings.clear();
      s.usageCaches.clear();
      s.sessionModelRefreshOwed.clear();
    } });
    context.subscriptions.push(
      vscode.window.registerWebviewPanelSerializer(PANEL_VIEW_TYPE, windowState().editorPanels.legacySerializerFor(context, index)),
    );
    // The folder-shell editor is its own view type with its own serializer: VS Code
    // restores it by the identity its own document wrote (the durable shell slot), and
    // a shell never becomes a session row or a managed writer.
    context.subscriptions.push(
      vscode.window.registerWebviewPanelSerializer(SHELL_VIEW_TYPE, shellSerializerFor(context, index)),
    );
    // A detail tab shows live data from its session and persists nothing. No serializer exists for
    // it: one that survived a window restart or a host-only restart has nothing to show and no way
    // to learn the host is gone, so every leftover is closed at activation.
    void s.guestDispatcher.closeLeftoverDetailTabs().catch(error => log.warn(`detail tabs: leftovers could not be closed (${messageOf(error)})`));
    // A plain omp outside this extension writing one of these sessions is told from the sessions this
    // extension owns through the session lease OMP itself takes (ADR-0046). The probe only opens a
    // named mutex and closes it, and a failed probe leaves every row exactly as it was.
    s.externalLeases = process.platform !== "win32" ? null : new ExternalLeaseObserver({
      probe: nativeLeaseProbe({ native: win32Native, log }),
      ownersDir: () => ompSessionOwnersDir({ homeDir: os.homedir(), configDirName: process.env.PI_CONFIG_DIR }),
      readSessionId: async file => (await readSessionFileHeader(file))?.sessionId ?? null,
      knownFiles: () => index.list().flatMap(entry => entry.sessionFile === null ? [] : [entry.sessionFile]),
      log,
    });
    const provider = new SessionTreeProvider({
      folders: () => folders.list(),
      entries: () => index.list(),
      activeTabId: () => sessionsViewActiveTab(index),
      facts: launcherFacts,
      runtimeIdentity: launcherRuntimeIdentity,
      observeOwnership: tabId => launcherOwnershipFacts(index, tabId),
      // A folder offers Reconnect Terminal exactly when a detached shell of that
      // folder could still be attached to. Shell slots never become rows.
      hasRecoverableShell: folder => recoverableShellsInFolder(folder.path).length > 0,
      grouping: sessionsGrouping,
      // What another window publishes for a row its claim holds, applied only to the run it was
      // published for: the incarnation the shared catalog records for the session now (ADR-0056).
      peer: (tabId, holderId, incarnation) => {
        const windows = s.routing.peers();
        const holder = holderId === null ? undefined : windows.find(window => window.holderId === holderId);
        if (holder === undefined) return null;
        const published = holder.rows[tabId];
        const current = published !== undefined && incarnation !== null && published.incarnation === incarnation;
        return { status: current ? published.status : null, lastActivityAt: current ? published.lastActivityAt : null, window: holder.label };
      },
    }, { onObservationError: error => log.warn(`launcher: row observation failed: ${messageOf(error)}`) });
    s.launcherProvider = provider;
    const view = vscode.window.createTreeView(SESSIONS_VIEW_ID, { treeDataProvider: provider });
    s.launcherView = view;
    subscribeProviderLoginRefresh(context, index);
    s.inventoryViews = registerInventoryViews(context, { target: () => toolsTarget(index), pending: s.pending, log, helpers: s.helpers });
    context.subscriptions.push({ dispose: () => { s.inventoryViews = null; } });
    s.contextView = registerContextView(context, {
      target: () => contextTarget(index),
      log,
      runAction: (tabId, command) => void runChatAction(context, index, tabId, command),
    });
    context.subscriptions.push({ dispose: () => { s.contextView = null; } });
    s.usageStatus = registerUsageStatus(context, {
      source: () => {
        const binding = index.activeTabId === null ? undefined : s.footerBindings.get(index.activeTabId);
        return binding === undefined ? null : { provider: binding.message.provider, windows: binding.message.windows,
          accountSelection: binding.message.accountSelection, readAt: binding.usageReadAt ?? null };
      },
      refresh: () => { if (index.activeTabId !== null) refreshFooterMetadata(index, index.activeTabId, true, true); },
    });
    context.subscriptions.push({ dispose: () => { s.usageStatus = null; } });
    registerDeskSettingsView(context, { log });
    const chooseDefaultView = () => chooseDefaultSessionView(context);
    // Another window opening or releasing a session is only visible as a claim file appearing,
    // changing or going away. The watch is a hint that re-reads the ownership of the rows filed
    // under the changed claims; it starts, claims and stops nothing, and spawns no process of its own.
    const claimWatch = startClaimWatch(
      index.claimStorageDir,
      claimFiles => refreshRowsForClaims(index, claimFiles),
      { onError: detail => log.warn(`claims: ${detail}`) },
    );
    s.routing.serveRequests(context, index, folders);
    context.subscriptions.push(
      s.output,
      vscode.workspace.onDidChangeConfiguration(refreshChatDisplayPreferences),
      provider,
      view,
      // The unread dot is a decoration badge: a long row label truncates the description, a badge stays visible.
      vscode.window.registerFileDecorationProvider(provider.decorations),
      provider.onDidServeTree(() => { void revealActiveSession(index); }),
      // The owner's own reading of a conversation's activity is what other windows order its row by.
      provider.onDidObserveConversation(() => s.routing.publishSnapshot()),
      { dispose: claimWatch },
      { dispose: () => s.windowRegistry?.dispose() },
      { dispose: () => s.routing.dispose() },
      { dispose: () => { s.pendingDisplay.dispose(); s.pending.dispose(); } },
      // The window's own folders are shown in Sessions: a change of the open folders or of the
      // setting that hides them rebuilds the list. Resolved paths are remembered per path, so an
      // open-folder change forgets them; the only disk reads are the identity of each path and
      // the session-folder probe of each open folder, which runs off the tree's path.
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        folders.forgetIdentities();
        refreshLauncher();
        s.resolveSessionFolders();
        s.routing.rescanPendingLaunches();
      }),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration("ompDesk.runSessionsAtRepositoryRoot")) {
          // The setting is read per folder and published, so other windows show the same folder; the checkout roots are already resolved.
          s.routing.publishSnapshot();
          s.resolveSessionFolders();
        }
        if (event.affectsConfiguration("ompDesk.showWorkspaceFolders") || event.affectsConfiguration("ompDesk.runSessionsAtRepositoryRoot") ||
          event.affectsConfiguration("ompDesk.sessionsGrouping")) refreshLauncher();
        if (event.affectsConfiguration("ompDesk.sessionsGrouping")) s.sessionProcesses?.sync();
      }),
      // While a session has an open editor, its row cannot be deselected: a selection with no
      // session row in it is put back on the session viewed most recently.
      view.onDidChangeSelection(event => restorePinnedSelection(index, event.selection)),
      vscode.workspace.onDidChangeConfiguration(event => {
        for (const state of s.tabs.values()) {
          if (state.panel === null || (state.shellSlot === null && state.mode !== "terminal")) continue;
          const resource = terminalFontResource(state);
          if (TERMINAL_FONT_CONFIGURATION_KEYS.some(key => event.affectsConfiguration(key, resource))) pushTerminalFont(state, resource);
        }
      }),
      // The launcher re-reads on the events that can change a row — this window
      // regaining focus, the view being opened, and the terminal/panel/restore
      // lifecycle — after every index or folder mutation, and, while the view is
      // visible, on the registry's 15 s heartbeat for the rows whose end no event announces (an outside OMP, a writer under a
      // broker no window drives, a failed observation) and a sweep of every row every 3 minutes (a recovery for an event the
      // platform dropped, ADR-0056). Opening the view never discovers anything: a
      // folder's sessions are found only when the user asks to resume one.
      view.onDidChangeVisibility(event => {
        // A hidden view stops polling its processes; a shown one reads them at once.
        s.sessionProcesses?.sync();
        if (!event.visible) return;
        // A missed catalog notification is recovered here rather than leaving another
        // window's sessions or folders invisible until a restart.
        void s.catalogAdoption.adopt(index, folders).catch(error => log.warn(`catalog: the newest revision could not be adopted: ${messageOf(error)}`));
        refreshLauncher({ ownership: true });
        s.routing.refresh();
      }),
      vscode.window.onDidChangeWindowState(event => trackOperation("window focus change", () => {
        if (!event.focused) return;
        s.routing.noteFocused();
        const active = activePanelTab();
        if (active !== null) activateNativeEditor(active);
        // Focus is the recovery point for a notification this window missed.
        void s.catalogAdoption.adopt(index, folders).catch(error => log.warn(`catalog: the newest revision could not be adopted: ${messageOf(error)}`));
        refreshLauncher({ ownership: true });
        // A row another window runs may have been left selected by a click that switched there; this window selects only its own session.
        releaseSelectionFromOtherWindow(index);
        s.routing.refresh();
        // Being brought to the front is how a switch request reaches a window whose directory event was dropped.
        s.routing.rescanRequests();
        // A repository created or removed while the window was away changes which folder is shown.
        s.resolveSessionFolders();
      })),
      // Collapsing a folder is presentation only, and the saved value is what its node is built
      // from (durable for a pinned folder, per window otherwise); nothing here re-reads sessions or
      // touches an editor.
      view.onDidCollapseElement(event => {
        if (event.element instanceof WorkspaceFolderTreeItem) {
          void folders.setCollapsed(event.element.folder.id, true).then(() => s.sessionActions.reportFolderSaveFailure(folders));
        }
      }),
      view.onDidExpandElement(event => {
        if (event.element instanceof WorkspaceFolderTreeItem) {
          void folders.setCollapsed(event.element.folder.id, false).then(() => s.sessionActions.reportFolderSaveFailure(folders));
        }
      }),
      registerDeskCommand("ompDesk.newSession", (argument: unknown) => newSession(context, index, argument)),
      registerDeskCommand("ompDesk.openSessionInChat", (argument: unknown) => s.sessionFlows.openSessionInMode(context, index, argument, "chat")),
      registerDeskCommand("ompDesk.openSessionInTerminal", (argument: unknown) => s.sessionFlows.openSessionInMode(context, index, argument, "terminal")),
      registerDeskCommand("ompDesk.showSessionInChat", (argument: unknown) => s.sessionFlows.openSessionInMode(context, index, argument, "chat", "show")),
      registerDeskCommand("ompDesk.showSessionInTerminal", (argument: unknown) => s.sessionFlows.openSessionInMode(context, index, argument, "terminal", "show")),
      registerDeskCommand("ompDesk.switchSessionViewChat", () => switchActiveSessionView(context, index, "chat")),
      registerDeskCommand("ompDesk.switchSessionViewTerminal", () => switchActiveSessionView(context, index, "terminal")),
      registerDeskCommand("ompDesk.copyTerminalScreen", copyActiveTerminalScreen),
      registerDeskCommand("ompDesk.redrawTerminal", redrawActiveTerminal),
      registerDeskCommand("ompDesk.moveFileToNewWindow", s.fileWindow.toggle),
      registerDeskCommand("ompDesk.reloadAllWindows", () => pendingEntry("window", "reload-windows", { origin: "command", step: "working" }, () => s.routing.reloadAllWindows())),
      registerDeskCommand("ompDesk.fileLink.open", (argument: unknown) => openFileLinkFromMenu(argument, undefined)),
      registerDeskCommand("ompDesk.fileLink.reveal", (argument: unknown) => openFileLinkFromMenu(argument, "reveal")),
      registerDeskCommand("ompDesk.fileLink.revealInOs", (argument: unknown) => openFileLinkFromMenu(argument, "os")),
      registerDeskCommand("ompDesk.webLink.openInEditor", (argument: unknown) => openWebLinkFromMenu(argument, "editor")),
      registerDeskCommand("ompDesk.webLink.openInBrowser", (argument: unknown) => openWebLinkFromMenu(argument, "external")),
      registerDeskCommand("ompDesk.chooseDefaultSessionView", chooseDefaultView),
      registerDeskCommand("ompDesk.chooseDefaultSessionViewChat", chooseDefaultView),
      registerDeskCommand("ompDesk.chooseDefaultSessionViewTerminal", chooseDefaultView),
      // The in-tab terminal and the folder shell: a folder's terminal actions, the
      // explicit lifecycle actions of a session row, and the exact Reload.
      registerDeskCommand("ompDesk.openTerminal", (argument: unknown) => openFolderTerminal(context, index, argument)),
      registerDeskCommand("ompDesk.reconnectTerminal", (argument: unknown) =>
        reconnectFolderTerminal(context, index, argument),
      ),
      registerDeskCommand("ompDesk.renameSession", (argument: unknown) => renameSession(context, index, argument)),
      registerDeskCommand("ompDesk.closeSession", (argument: unknown) => closeSession(context, index, argument)),
      registerDeskCommand("ompDesk.reloadSession", (argument: unknown) => reloadSession(context, index, argument)),
      registerDeskCommand("ompDesk.forkSession", (argument: unknown) => forkSession(context, index, argument)),
      registerDeskCommand("ompDesk.branchSession", (argument: unknown) => branchSession(context, index, argument)),
      registerDeskCommand("ompDesk.clearSession", (argument: unknown) => clearSession(context, index, argument)),
      registerDeskCommand("ompDesk.addWorkspaceFolder", () => addWorkspaceFolder(index)),
      registerDeskCommand("ompDesk.chooseSessionsLayout", () => chooseSessionsLayout()),
      registerDeskCommand("ompDesk.chooseSessionsLayout.flat", () => chooseSessionsLayout()),
      registerDeskCommand("ompDesk.chooseSessionsLayout.folders", () => chooseSessionsLayout()),
      registerDeskCommand("ompDesk.chooseSessionsLayout.terminals", () => chooseSessionsLayout()),
      registerDeskCommand("ompDesk.pinWorkspaceFolder", (argument: unknown) => pinWorkspaceFolder(index, argument)),
      registerDeskCommand("ompDesk.unpinWorkspaceFolder", (argument: unknown) => unpinWorkspaceFolder(index, argument)),
      registerDeskCommand("ompDesk.resumeWorkspaceFolder", (argument: unknown) =>
        resumeWorkspaceFolder(context, index, argument),
      ),
      registerDeskCommand("ompDesk.openSession", (argument: unknown) => openSession(context, index, argument, "resumed", false, false, argument instanceof SessionTreeItem ? "row" : "command")),
      registerDeskCommand("ompDesk.clickSession", () => s.sessionActions.clickSelected(context, index)),
      registerDeskCommand("ompDesk.openProcess", () => s.sessionActions.openSelectedProcess(context, index)),
      registerDeskCommand("ompDesk.goToSession", () => s.sessionActions.goTo(context, index)),
      registerDeskCommand("ompDesk.showCommands", () => showDeskCommands()),
      registerDeskCommand("ompDesk.switchToSessionWindow", (argument: unknown) => s.routing.switchToWindow(index, tabIdArgument(argument))),
      registerDeskCommand("ompDesk.moveSessionHere", (argument: unknown) => moveSessionHere(context, index, argument)),
      registerDeskCommand("ompDesk.moveSessionHere.palette", (argument: unknown) => moveSessionHere(context, index, argument)),
      registerDeskCommand("ompDesk.forgetSession", (argument: unknown) => s.sessionActions.forget(index, argument)),
      registerDeskCommand("ompDesk.deleteSession", (argument: unknown) => s.sessionActions.delete(index, argument)),
      registerDeskCommand("ompDesk.stopSessionHost", (argument: unknown) =>
        s.sessionActions.stopHost(context, index, argument),
      ),
      registerDeskCommand("ompDesk.killSession", (argument: unknown) => s.sessionActions.kill(context, index, argument)),
      registerDeskCommand("ompDesk.refreshSessions", () => s.sessionActions.refresh(index)),
      registerDeskCommand("ompDesk.showHostControls", () => showHostControls(index)),
      registerDeskCommand("ompDesk.selectModel", () => selectHostModel(index)),
      registerDeskCommand("ompDesk.selectThinking", () => selectHostThinking(index)),
      registerDeskCommand("ompDesk.copyTools", () => copyHostTools(index)),
      registerDeskCommand("ompDesk.loginProvider", (argument?: unknown) => loginProviderFromPalette(index, argument)),
      registerDeskCommand("ompDesk.logoutProvider", () => logoutProviderFromPalette(index)),
      registerDeskCommand("ompDesk.enableFileEvidence", () => enableFileEvidence(context, index)),
      registerDeskCommand("ompDesk.disableFileEvidence", () => disableFileEvidence(context, index)),
      registerDeskCommand("ompDesk.showFileEvidence", () => showFileEvidence(context, index)),
      registerDeskCommand("ompDesk.deleteFileEvidence", () => deleteFileEvidence(context, index)),
      // Keyboard/command access to actions the panel already offers, so a
      // keybinding reaches the same composer handlers the buttons use. Each of
      // these targets the actual active editor, never a merely visible split panel,
      // reports when there is none, and never starts a host.
      registerDeskCommand("ompDesk.sendPrompt", () => postPanelAction("send-prompt")),
      registerDeskCommand("ompDesk.stopTurn", () => postPanelAction("stop-turn")),
      registerDeskCommand("ompDesk.focusComposer", () => windowState().editorPanels.focusChatComposer(index)),
      registerDeskCommand("ompDesk.retryTurn", () => postChatPanelAction("retry-turn")),
      registerDeskCommand("ompDesk.quoteChatSelection", () => postChatPanelAction("quote-selection")),
      registerDeskCommand("ompDesk.findInChat", () => findInChat()),
      registerDeskCommand("ompDesk.toggleThinking", () => toggleThinkingDefault()),
      registerDeskCommand("ompDesk.toggleToolOutput", () => toggleToolsMode("output")),
      registerDeskCommand("ompDesk.toggleToolGroups", () => toggleToolsMode("groups")),
      registerDeskCommand("ompDesk.searchPromptHistory", () => searchPromptHistory()),
      registerDeskCommand("ompDesk.searchSymbolFromChat", () => s.guestDispatcher.searchSymbolFromChat()),
      registerDeskCommand("ompDesk.compactConversation", () => runActiveChatAction(context, index, "compact")),
      registerDeskCommand("ompDesk.shakeConversation", () => runActiveChatAction(context, index, "shake")),
      registerDeskCommand("ompDesk.cycleModel", () => runActiveChatAction(context, index, "cycle-model")),
      registerDeskCommand("ompDesk.cycleThinkingLevel", () => runActiveChatAction(context, index, "cycle-thinking")),
      registerDeskCommand("ompDesk.exportConversationHtml", () => runActiveChatAction(context, index, "export-html")),
      registerDeskCommand("ompDesk.shareConversation", () => runActiveChatAction(context, index, "share")),
      registerDeskCommand("ompDesk.showChatKeyboardShortcuts", () => showChatKeyboardShortcuts()),
      registerDeskCommand("ompDesk.rewindConversation", () => rewindConversation()),
      registerDeskCommand("ompDesk.quoteEditorSelection", () => quoteEditorSelectionToSession(context, index)),
      registerDeskCommand("ompDesk.searchFileFromChat", () => s.guestDispatcher.searchFileFromChat()),
      registerDeskCommand("ompDesk.sendFile", (clicked: unknown, selected: unknown) => addFilesToSession(context, index, clicked, selected)),
      registerDeskCommand("ompDesk.showDiagnostics", () => showDiagnostics(context, index)),
      registerDeskCommand("ompDesk.copyRowDiagnostics", async (item: unknown) => {
        if (!(item instanceof SessionTreeItem || item instanceof WorkspaceFolderTreeItem || item instanceof ProcessTreeItem)) return;
        try {
          await vscode.env.clipboard.writeText(redactCapabilities(item.diagnostics));
        } catch (error) {
          log.error(`row diagnostics copy failed: ${messageOf(error)}`);
          showError("Diagnostics could not be copied. Try again, or use OMP Desk: Show Diagnostics.");
        }
      }),
      // The report is regenerated on every request from measurements this window
      // already made plus one read-only health probe, so an open document never
      // shows a stale number; only the fixed report path is answerable, and a
      // buffer under this scheme cannot be saved anywhere.
      vscode.workspace.registerTextDocumentContentProvider(DIAGNOSTICS_DOCUMENT_SCHEME, {
        onDidChange: s.diagnosticsDocumentChanges.event,
        provideTextDocumentContent: uri => diagnosticsDocumentContent(context, index, uri.path),
      }),
      // Observation bytes reach an editor through this provider and nothing else:
      // a Webview never receives stored content, an arbitrary path is never
      // resolvable, and every request re-reads and re-validates the store instead
      // of serving a cached copy.
      vscode.workspace.registerTextDocumentContentProvider(OBSERVATION_DOCUMENT_SCHEME, {
        onDidChange: s.observationDocumentChanges.event,
        provideTextDocumentContent: uri => observationDocumentContent(context, index, uri.path),
      }),
    );
    // VS Code's own editor membership is the authority for which editors exist, so the
    // tab set is subscribed before the first asynchronous native work: an editor opened
    // (or closed) while activation proceeds is reconciled by this, never guessed at.
    context.subscriptions.push(
      vscode.window.tabGroups.onDidChangeTabs(() => {
        settleViewedSession(index);
        // Which editors this window holds is what a closed editor's binding is judged by, here and in the other windows' registry reads.
        windowState().editorSlotPruner?.observe();
        windowState().routing.publishSnapshot();
        void windowState().bridgeHost.syncEditors(context, index, { retireMissing: true }).catch(error =>
          log.warn(`bridge: the editor membership could not be reconciled: ${messageOf(error)}`),
        );
      }),
    );
    if (index.loadError !== null) {
      showWarning(`The stored session index could not be read and was reset: ${index.loadError}`);
    }
    // Show the registered folders and the sessions whose editors VS Code restored
    // before any host is reconciled, so the sidebar never flickers through an empty
    // welcome state on a real workspace. Nothing is discovered here: no folder is
    // added, no session is imported and no history is scanned. The restore pass runs
    // as a handoff: the rows it covers are captured here, and a click on one of them
    // waits for the panels it publishes instead of opening a tab the pass is already
    // restoring.
    refreshLauncher();
    s.resolveSessionFolders();
    // The registry starts after the first snapshot exists, so the first record already says what
    // this window has open. From here the other windows' records, its own lease, and the session
    // folders of every live window's folders are kept current by watch, heartbeat and focus.
    windowsRegistry.start({
      onChange: s.routing.registryChanged,
      // Before each renewal, so a fresh `updatedAt` means the record says what the tab set holds now. The first heartbeat is also
      // when the tab set counts as complete, and from then on the record lists this window's editors.
      beforeRenew: () => {
        s.editorSlotPruner?.markComplete();
        s.routing.publishSnapshot();
      },
      onHeartbeat: () => {
        s.routing.heartbeat();
        // The passive bindings of editors that closed here and that no live window holds are dropped from the catalog.
        void s.editorSlotPruner?.run().then(
          report => { if (report.dropped.length > 0) log.info(`editor slots: dropped ${report.dropped.length} passive binding(s) of closed editors`); },
          error => log.warn(`editor slots: the bindings of closed editors could not be settled: ${messageOf(error)}`),
        );
      },
    });
    // The editors this window already has are reconciled before any asynchronous native
    // work: their serializers are registered, and a page that survived a previous
    // extension host is adopted with the document its records name, so its reconnect has
    // something to authenticate against as soon as it dials in.
    void windowState().bridgeHost.syncEditors(context, index).catch(error => log.warn(`bridge: the editor membership could not be reconciled: ${messageOf(error)}`));
    // The catalog is read, the predecessor build's folder list is imported into it, and
    // only then does the activation restore pass run — pinned to the rows this window is
    // responsible for. An editor VS Code restores for a row this pass does not cover is
    // opened by its own serializer path, so it is never left unconnected.
    s.catalogAdoption.activate(index, folders, catalog);
    s.sessionActions.setupProcesses(context, index, folders);
    // Stage the entries children run from outside the installed extension folder
    // before anything can need them, so no process starts from a file inside a
    // folder a reinstall may be renaming. The launch paths stage again themselves and
    // report their own failure; this one is just early, and silent.
    void s.staging.entries().catch(() => {});
    // The Bun plan's pipe-only check of the first Chat is run now, in the background and after this function has returned, so the first
    // Chat finds it done; several windows share one run (ADR-0074 amendment 2026-10-28).
    const warmingClient = s.ptyClient;
    if (warmingClient !== undefined) startChatRuntimeWarmup({ resolve: sharedOmpBinary, warm: binary => warmingClient.warmChatRuntime(binary), log });
    activation.mark("rest of setup");
    log.info(`window timing: activation ${activation.summary([["host up when the bundle began loading", MODULE_EVALUATION_STARTED_AT], ["bundle evaluation", activationEnteredAt - MODULE_EVALUATION_STARTED_AT, activationEnteredCpu - MODULE_EVALUATION_STARTED_CPU_MS], [`catalog read (${fileCalls} file calls, from the start of the setup)`, catalogReadMs]])}`);
    log.info("extension activated");
  }

  function deactivate(): void {
    const s = state;
    if (s === undefined) return;
    // The OMP children and their claims deliberately outlive this extension host: the broker
    // that owns each child is detached, and destroying either here would kill a live session
    // on every window reload. The host-owned conversations only drop their connections (the
    // disposal registered at activation); the index persists what a later activation must
    // reconcile.
    //
    // The bridge listeners are the one thing this host does release: each holds an exact
    // loopback port as its resource lease, and a later activation must be able to bind
    // those very ports again. A surviving page is unaffected — its socket dies with this
    // host either way, and its reconnect is what the next activation serves.
    for (const endpoint of s.bridgeEndpoints.values()) endpoint.close();
    s.bridgeEndpoints.clear();
    s.bridgeLiveEditors.clear();
    // The window's lease record goes with the window; a crash leaves it to expire.
    s.windowRegistry?.removeSync();
    // The window's state stays, disposed: subscriptions are disposed after this returns, and a late timer, watcher or
    // promise continuation must read the disposed window as it read the module bindings before, not throw.
  }

  /**
   * What the window routing reads of this window and calls into. The getters read the installed window when
   * they run, so the routing can be created with the window, before it is installed.
   */
  function windowRoutingDeps(): WindowRoutingDeps {
    return {
      registry: () => windowState().windowRegistry,
      folders: () => windowState().launcherFolders,
      index: () => windowState().indexForBridge,
      refreshProviderModels: () => {
        const index = windowState().indexForBridge;
        if (index !== null) refreshProviderModelsEverywhere(index);
      },
      requestSelections: () => windowState().requestSelections,
      packageStale: () => windowState().packageStale,
      unityChoices: () => windowState().context?.globalState,
      startupRestoreCovers: tabId => windowState().catalogAdoption.restoreCovers(tabId),
      resolveSessionFolders: () => windowState().resolveSessionFolders(),
      packageChangedOnDisk,
      ensureCatalogReady: () => windowState().catalogAdoption.ready(),
      refreshCatalog: async index => {
        const folders = windowState().launcherFolders;
        if (folders !== undefined) await windowState().catalogAdoption.adopt(index, folders);
      },
      sessionProcesses: () => windowState().sessionProcesses,
      launcherProvider: () => windowState().launcherProvider,
      sessionsViewVisible: () => windowState().launcherView?.visible === true,
      refreshLauncher: () => refreshLauncher(),
      facts: launcherFacts,
      releaseSelection: releaseSelectionFromOtherWindow,
      tab: stateOf,
      hasEditorTab: slot => editorTabOf(slot) !== null,
      liveEditorSlots: () => (windowState().editorSlotPruner?.complete === true ? windowState().bridgeHost.editorMembership().map(entry => entry.editorId) : null),
      selectEditorTab,
      revealExistingTab,
      electLocalController,
      handOverSession,
      showRestoredOutsideHome,
      openSession,
      openSessionInMode: (context, index, tabId, mode, verb, noRouting, revealIfLive) => windowState().sessionFlows.openSessionInMode(context, index, tabId, mode, verb, noRouting, revealIfLive),
      startNewSession,
      resumeFromFolderHistory,
      openTab: (context, index, tabId, verb, intent) => windowState().sessionFlows.openTab(context, index, tabId, verb, intent),
      log,
      timing: windowTiming,
      info: showInfo,
      warn: showWarning,
      error: showError,
    };
  }

  /**
   * What the session actions read of this window and call into. The getters read the installed window when they run,
   * so the actions can be created with the window, before it is installed.
   */
  function sessionActionsDeps(): SessionActionsDeps<TabState> {
    return {
      context: () => windowState().context,
      reconciler: () => windowState().reconciler,
      sessionRuntime: () => windowState().sessionRuntime,
      brokerSlots: () => windowState().brokerSlots,
      shellSlots: () => windowState().shellSlots,
      launcherFolders: () => windowState().launcherFolders,
      outcomes: () => windowState().outcomes,
      openingTab: tabId => windowState().openingTabs.get(tabId),
      hasShellEditor: slot => windowState().shellEditors.has(slot),
      stoppingTabs: () => windowState().stoppingTabs,
      routing: () => windowState().routing,
      sessionProcesses: () => windowState().sessionProcesses,
      pending: () => windowState().pending,
      setSessionProcesses: processes => { windowState().sessionProcesses = processes; },
      catalogLoaded: () => windowState().catalogStore !== undefined,
      startupRestoreOver: () => windowState().catalogAdoption.startupRestoreOver(),
      tab: stateOf,
      tabs: () => windowState().tabs,
      detailTabs: () => windowState().detailTabs,
      editorSlots: () => windowState().editorSlots,
      bridgeEditors: () => windowState().bridgeEditors,
      passiveReasonForSlot,
      launcherProvider: () => windowState().launcherProvider,
      launcherView: () => windowState().launcherView,
      refreshLauncher,
      facts: launcherFacts,
      sessionsGrouping,
      openSession,
      attachFolderShell,
      tabIdArgument,
      pickIndexedTab,
      sessionTarget: sessionTargetFromArgument,
      confirmAndStopRuntime,
      withSessionReadDeadline,
      releaseHostControl: (tabId, ownerGeneration) => windowState().sessionRuntime.control.release(tabId, ownerGeneration),
      releaseRuntimeRecord: tabId => windowState().sessionRuntime.records.drop(tabId),
      reconnectHostControl: async (tabId, ownerGeneration) => {
        const runtime = windowState().sessionRuntime.records.get(tabId)?.runtime;
        if (runtime?.kind === "terminal") await windowState().sessionRuntime.control.reconnect(tabId, ownerGeneration, runtime);
      },
      recordedControlOwner,
      forgetTurnActivity,
      brokerClient,
      attachBrokerClient,
      ensureCatalogReady: () => windowState().catalogAdoption.ready(),
      adoptCatalogChanges: (index, folders, options) => windowState().catalogAdoption.adopt(index, folders, options),
      showWarningMessage: (message, options, ...items) => vscode.window.showWarningMessage(message, options, ...items),
      showQuickPick: (items, options) => vscode.window.showQuickPick(items, options),
      log,
      info: showInfo,
      warn: showWarning,
      error: showError,
    };
  }

  /**
   * What the guest dispatcher reads of this window and calls into. The getters read the installed window when they
   * run, so the dispatcher can be created with the window, before it is installed.
   */
  function guestDispatcherDeps(): GuestDispatcherDeps<TabState> {
    return {
      context: () => windowState().context,
      tabs: () => windowState().tabs,
      tab: stateOf,
      activePanelTab,
      draftRestores: () => windowState().draftRestores,
      composerPopupTabs: () => windowState().composerPopupTabs,
      conversations: () => windowState().sessionRuntime.conversations,
      detailTabs: () => windowState().detailTabs,
      mermaidPreviews: () => windowState().mermaidPreviews,
      artifactDocuments: () => windowState().artifactDocuments,
      sessionFileOf: tabId => windowState().indexForBridge?.get(tabId)?.sessionFile ?? null,
      panelChatPage,
      attachChatRoute,
      attachChatRoutes,
      rememberPrompt,
      runChatAction,
      hostedCwd: tabId => windowState().sessionRuntime.records.get(tabId)?.runtime?.cwd ?? null,
      searchSymbol: searchSymbolFromSelection,
      completeFiles: (cwd, query) => findFileMentions(query, {
        cwd,
        findFiles: (include, exclude, maxResults) => vscode.workspace.findFiles(include, exclude, maxResults),
      }),
      pickFiles: async defaultFolder => {
        const picked = await vscode.window.showOpenDialog({
          canSelectMany: true,
          canSelectFiles: true,
          canSelectFolders: false,
          openLabel: "Attach",
          title: "Attach files",
          ...(defaultFolder === null ? {} : { defaultUri: vscode.Uri.file(defaultFolder) }),
        });
        return (picked ?? []).filter(uri => uri.scheme === "file").map(uri => uri.fsPath);
      },
      hasUnsavedChanges: fsPath => {
        const wanted = comparablePosix(fsPath);
        return vscode.workspace.textDocuments.some(document => document.isDirty && document.uri.scheme === "file" && comparablePosix(document.uri.fsPath) === wanted);
      },
      recents: registerRecentSessions({
        listed: () => windowState().launcherProvider?.listedSessions().map(({ item }) => item) ?? [],
        itemFor: async tabId => windowState().launcherProvider?.itemFor(tabId),
        click: async (index, item) => {
          const context = windowState().context;
          if (context !== undefined) await windowState().sessionActions.click(context, index, item, "command");
        },
        info: showInfo,
      }),
      openKeyConflict: async command => {
        const query = windowState().keyHints?.queryOf(command) ?? null;
        if (query !== null) await vscode.commands.executeCommand("workbench.action.openGlobalKeybindings", query);
      },
      servedModels: pairs => servedModelVerdicts(pairs),
      pushSessionView,
      noteReadyDocument,
      activateNativeEditor,
      switchSessionMode: (context, index, state, mode) => windowState().sessionFlows.switchSessionMode(context, index, state, mode),
      refreshGuestContext,
      bridgeRouteOf: tabId => windowState().bridgeHost.routeOf(tabId),
      pinBridgeOrigin: (tabId, panel, report) => windowState().bridgeHost.pinOrigin(tabId, panel, report),
      redeliverBridgeBinding: tabId => windowState().bridgeHost.redeliverBinding(tabId),
      acknowledgeBridgeRoute: (tabId, panel, message) => windowState().bridgeHost.acknowledgeRoute(tabId, panel, message),
      acknowledgeBridgeSecret: (tabId, panel, message) => windowState().bridgeHost.acknowledgeSecret(tabId, panel, message),
      isTerminalPanelType: type => TERMINAL_PANEL_TYPES[type] === true,
      handleTerminalMessage: handleTerminalGuestMessage,
      acceptTerminalCopy,
      controlRequest: (index, tabId, request, panel) =>
        handleGuestControlRequest(index, tabId, request, panelResponder(tabId, panel, request.actionSeq)),
      log,
      info: showInfo,
      warn: showWarning,
      error: showError,
    };
  }

  /**
   * What the editor panels read of this window and call into. The getters read the installed window when they run, so the
   * panels can be created with the window, before it is installed. The lifecycle harness builds its handle from these with a
   * panel factory of its own.
   */
  function editorPanelsDeps(): EditorPanelsDeps<TabState> {
    return {
      records: () => windowState().sessionRuntime.records,
      tabs: () => windowState().tabs,
      tab: stateOf,
      tabState,
      editors: () => windowState().bridgeEditors,
      liveEditors: () => windowState().bridgeLiveEditors,
      nextEditorEvent: () => ++windowState().editorEventSequence,
      sessionPanelColumns: () => windowState().sessionPanelColumns,
      panelBindWaiters: () => windowState().panelBindWaiters,
      draftRestores: () => windowState().draftRestores,
      startupRestoreSettled: () => windowState().catalogAdoption.startupRestoreSettled(),
      guest: () => windowState().guestDispatcher,
      routing: () => windowState().routing,
      bridge: () => windowState().bridgeHost,
      htmlPageFramePort: () => (chatHtmlPagesEnabled() ? windowState().htmlPageServer.port : null),
      slotReasons: { passive: PASSIVE_REASON_DEFAULT, electing: ELECTING_REASON },
      bindSlotToConversation,
      trackElection,
      applySlotAuthority,
      reserveSlot: reserveSlotForConversation,
      defaultSessionMode,
      isSessionTab,
      applyChatTabAppearance,
      registerPanelLifecycle,
      ensureTerminalPipeline,
      forgetTerminalCopy,
      refreshGuestContext,
      packageChangedOnDisk,
      replayPanelOutcome,
      createWebviewPanel: (viewType, title, showOptions, options) => vscode.window.createWebviewPanel(viewType, title, showOptions, options),
      fileWindowColumn: () => windowState().fileWindow.column(),
      editorTabOf,
      reviveEditorPanel,
      activePanelTab,
      refreshLauncher: () => refreshLauncher(),
      setActiveTab,
      requestSessionRowExpand,
      ensureCatalogReady: () => windowState().catalogAdoption.ready(),
      log,
      info: showInfo,
      warn: showWarning,
      restoredEditorLost: () => windowState().catalogRecovery?.addEvidence({ restoredEditors: 1 }),
    };
  }

  /**
   * What the bridge host reads of this window and calls into. The getters read the installed window when they run, so the
   * host can be created with the window, before it is installed; the endpoint factory is the window's `createBridgeEndpoint`,
   * which the lifecycle harness replaces.
   */
  function bridgeHostDeps(): BridgeHostDeps<TabState> {
    return {
      tabs: () => windowState().tabs,
      tab: stateOf,
      tabState,
      index: () => windowState().indexForBridge,
      sessions: () => windowState().sessionRuntime,
      editors: () => windowState().bridgeEditors,
      editorSlots: () => windowState().editorSlots,
      endpoints: () => windowState().bridgeEndpoints,
      liveEditors: () => windowState().bridgeLiveEditors,
      diagnostics: () => windowState().diagnostics,
      passiveReasonForSlot,
      reserveSlot: reserveSlotForConversation,
      defaultSessionMode,
      attachChatRoute,
      refreshLauncher: () => refreshLauncher(),
      cancelControlPicker,
      serializerFor: (context, index, viewType) => windowState().editorPanels.bridgeSerializerFor(context, index, viewType),
      handleRequest: handleBridgeRequest,
      createEndpoint: options => windowState().createBridgeEndpoint(options),
      log,
    };
  }

  /** What the catalog adoption and the startup restore read of this window and call into. */
  function catalogAdoptionDeps(activatedAt: number): CatalogAdoptionDeps {
    return {
      log,
      activatedAt,
      catalog: () => windowState().catalogStore,
      brokerSlots: () => windowState().brokerSlots,
      shellSlots: () => windowState().shellSlots,
      dropClaimFileNames: () => windowState().claimFileNames.clear(),
      reconcileLocalRoles,
      refreshLauncher: () => refreshLauncher(),
      importPredecessorFolders: async store => {
        const context = windowState().context;
        if (context !== undefined) await importPredecessorFolders({ store, storageDir: context.globalStorageUri.fsPath, log });
      },
      catalogRead: () => vscode.commands.executeCommand("setContext", CATALOG_PENDING_CONTEXT, false),
      watchCatalog: (paths, onSignal) => startCatalogWatch(paths, onSignal, { onError: detail => log.warn(detail) }),
      subscribe: disposable => { windowState().context?.subscriptions.push(disposable); },
      startBackup: () => windowState().catalogRecovery?.startBackup(),
      restoreTabs,
      hasLocalEditorFor,
      owningWindow: () => owningWindowUri()?.toString() ?? null,
      startRuntimeProof: () => { void windowState().ptyGate?.client(); },
      reconciler: () => windowState().reconciler,
      timing: windowTiming,
    };
  }

  /**
   * What the session flows read of this window and call into. The getters read the installed window when they run, so the
   * flows can be created with the window, before it is installed.
   */
  function sessionFlowsDeps(): SessionFlowsDeps<TabState> {
    return {
      tab: stateOf,
      tabState,
      openingTabs: () => windowState().openingTabs,
      liveEditors: () => windowState().bridgeLiveEditors,
      nextEditorEvent: () => ++windowState().editorEventSequence,
      pendingSessionViewChanges: () => windowState().pendingSessionViewChanges,
      draftRestores: () => windowState().draftRestores,
      outcomes: () => windowState().outcomes,
      ensureCatalogReady: () => windowState().catalogAdoption.ready(),
      startupRestore: () => windowState().catalogAdoption.startupRestore(),
      routing: () => windowState().routing,
      passiveReasonForSlot,
      defaultSessionMode,
      pending: () => windowState().pending,
      launchTimeline: () => windowState().launchTimeline,
      pendingEntry,
      timedLaunch,
      sessionRuntime: () => windowState().sessionRuntime,
      hostOf,
      recordOf,
      recordFor,
      controlOf,
      fencedOf,
      liveAt,
      beginTransition,
      withSessionReadDeadline,
      ensureTerminalPipeline,
      refreshLauncher: () => refreshLauncher(),
      launcherFacts,
      launcherOwnershipFacts,
      confirmOpenAnyway,
      launcherProvider: () => windowState().launcherProvider,
      sessionTarget: sessionTargetFromArgument,
      revealActiveSession,
      editorPanels: () => windowState().editorPanels,
      bridgeHost: () => windowState().bridgeHost,
      guestDispatcher: () => windowState().guestDispatcher,
      sessionActions: () => windowState().sessionActions,
      revealExistingTab,
      reviveEditorPanel,
      electLocalController,
      attachChatRoutes,
      pushSessionView,
      activateNativeEditor,
      refreshGuestContext,
      handleRestoreOutcome,
      showWarningMessage: (message, options, ...items) => vscode.window.showWarningMessage(message, options, ...items),
      showWarningActions: (message, ...items) => vscode.window.showWarningMessage(message, ...items),
      log,
      warn: showWarning,
      error: showError,
    };
  }

  /** The initial state of one window: every collection empty, every handle not yet created. */
  function createWindowState(context: vscode.ExtensionContext): WindowState {
    const pending = new PendingOperations({ log: line => log.debug(line), launchReady: launchReadinessOf });
    const launchTimeline = new LaunchTimeline(Date.now, line => log.info(line));
    launchTimeline.observe(observeLaunchSteps(pending));
    const activatedAt = Date.now();
    return {
      // Session index and claims
      reconciler: undefined as never, // assigned by `activate` before anything reads it
      sessionRuntime: undefined as never, // assigned by `activate` before anything reads it
      indexForBridge: null,
      catalogStore: undefined,
      catalogRecovery: undefined,
      catalogAdoption: registerCatalogAdoption(catalogAdoptionDeps(activatedAt)),
      externalLeases: null,
      claimFileNames: new Map<string, string | null>(),
      // Window registry and routing
      windowRegistry: undefined,
      editorSlotPruner: undefined,
      routing: registerWindowRouting(windowRoutingDeps()),
      fileWindow: createFileWindow({ log, info: showInfo, isSessionTabInput: input => windowState().editorPanels.isSessionTabInput(input) }),
      resolveSessionFolders: async () => {},
      requestSelections: new Set<string>(),
      // Editor panels and bridge
      tabs: new Map<string, TabState>(),
      bridgeHost: registerBridgeHost(bridgeHostDeps()),
      htmlPageServer: createHtmlPageServer(),
      editorPanels: registerEditorPanels(editorPanelsDeps()),
      bridgeEndpoints: new Map<string, BridgeEditorEndpoint>(),
      createBridgeEndpoint: options => new BridgeEditorEndpoint(options),
      rootGone: async root => await recordedRootGone(await withSessionReadDeadline(attachBrokerClient(), 2_000).catch(() => null), root),
      bridgeLiveEditors: new Set<string>(),
      bridgeEditors: new EditorCoordinator(),
      outcomes: new Map<string, RestoreOutcome>(),
      openingTabs: new Map<string, Promise<void>>(),
      sessionPanelColumns: new Map<string, vscode.ViewColumn>(),
      stoppingTabs: new Set<string>(),
      readyDocuments: new WeakMap<TabState, PanelDocument>(),
      panelBindWaiters: new Map<string, Set<() => void>>(),
      pendingSessionViewChanges: new Map<TabState, number>(),
      panelPageIds: new WeakMap<vscode.WebviewPanel, string>(),
      panelPageSequence: 0,
      terminalCopyRequests: new WeakMap<TabState, TerminalCopyRequest>(),
      slotElections: new Map<string, Set<Promise<void>>>(),
      footerBindings: new Map<string, {
        cwd: string;
        message: FooterMetadataMessage;
        observer: BranchObservation | null;
        modelId: string | null;
        usageReadAt?: number | null;
      }>(),
      // Guest dispatch
      guestDispatcher: registerGuestDispatcher(guestDispatcherDeps()),
      composerPopupTabs: new Set<string>(),
      pageHealth: new PageHealthMonitor({ log }),
      draftRestores: new Map<string, CarriedDraft<TabState>>(),
      slashRegistry: null,
      slashRegistryFailedKey: null,
      slashRegistryCheckedAt: 0,
      slashRegistryLoading: null,
      servedModels: new ServedModelMemo(),
      symbolLinks: undefined,
      commitLinks: undefined,
      symbolAskers: new Set<string>(),
      installedTerminalFonts: [],
      installedTerminalFontsRead: null,
      // PTY and broker
      ptyClient: undefined,
      ptyGate: undefined,
      brokerSlots: undefined,
      editorSlots: createEditorSlotRegistry(),
      shellSlots: undefined,
      shellEditors: new Map<string, string>(),
      hostControlAttempts: new WeakMap<SessionHostRuntime, Promise<void>>(),
      // Views
      inventoryViews: null,
      contextView: null,
      usageStatus: null,
      keyHints: null,
      linkRules: null,
      sessionProcesses: null,
      sessionActions: registerSessionActions(sessionActionsDeps()),
      sessionFlows: registerSessionFlows(sessionFlowsDeps()),
      launcherProvider: undefined,
      launcherView: undefined,
      launcherRevealInFlight: null,
      launcherRevealRequested: false,
      launcherSelectedPath: null,
      launcherExpandFor: null,
      launcherFolders: undefined,
      lastSessionServingLayout: null,
      pinnedSelectionTimer: undefined,
      observationDocuments: new Map<string, ObservationDocumentEntry>(),
      observationDocumentChanges: new vscode.EventEmitter<vscode.Uri>(),
      diagnosticsDocumentChanges: new vscode.EventEmitter<vscode.Uri>(),
      // Providers and models
      defaultProviderModelsAvailable: null,
      defaultProviderModelsRead: null,
      defaultProviderModelsDirty: false,
      sessionModelReads: new Map<string, Promise<void>>(),
      sessionModelRefreshOwed: new Set<string>(),
      providerLoginTerminal: null,
      providerAuthRun: null,
      usageCaches: new Map<string, ProviderUsageCache>(),
      helpers: undefined as never, // assigned by `activate` before anything reads it
      // Lifecycle
      context,
      output: undefined,
      diagnostics: new DiagnosticsRecorder(),
      launchTimeline,
      pending,
      pendingDisplay: new PendingDisplay(pending, pendingDisplayShell({ provider: () => windowState().launcherProvider, sessionsViewId: SESSIONS_VIEW_ID })),
      persistFailures: new PersistFailureReporter({ warn: message => log.warn(message) }, message => showWarning(message)),
      legacySettingsMoved: Promise.resolve(),
      legacySettingsLateLogged: false,
      activatedAt,
      editorEventSequence: 0,
      nextLauncherRuntimeId: 0,
      packageDrift: null,
      packageDriftAnnounced: false,
      packageStale: false,
      // Conversations
      detailTabs: undefined as never, // assigned by `activate` before anything reads it
      mermaidPreviews: undefined as never, // assigned by `activate` before anything reads it
      artifactDocuments: undefined as never, // assigned by `activate`, first thing
      sessionFileDocuments: undefined as never, // assigned by `activate`, first thing
      turnActivities: new Map<string, TurnActivity>(),
      editorRecency: new EditorRecency(),
      turnNotifier: undefined,
      replacingConversations: new Set<string>(),
      newSessionsInFlight: new Map<string, string | null>(),
      pendingForks: new PendingForks(),
      loggedChatPhases: new Map<string, ChatPhase>(),
      subagentWork: new Map<string, boolean>(),
      subagentWatches: new Map<string, ReturnType<typeof setInterval>>(),
      // Caches
      staging: createRuntimeStaging({
        storageDir: () => context.globalStorageUri.fsPath,
        packagedPaths: () => ({
          hostControl: context.asAbsolutePath(HOST_CONTROL_MODULE),
          renameHelper: context.asAbsolutePath(RENAME_HELPER_SCRIPT),
          runtimeProbe: context.asAbsolutePath(RUNTIME_PROBE_MODULE),
        }),
        stageNative: () => runNativeStage({
          entry: context.asAbsolutePath(NATIVE_STAGE_CHILD),
          packaged: context.asAbsolutePath(NATIVE_ADDON),
          storageDir: context.globalStorageUri.fsPath,
        }),
        refusal: () => (packageChangedOnDisk() ? UPDATED_ON_DISK_ERROR : null),
        log,
      }),
      launcherRuntimeIds: new WeakMap<SessionHostRuntime, number>(),
      brokerWatches: new WeakMap<SessionHostRuntime, () => void>(),
    };
  }

  /** ADR-0068: whether the three context keys default keybindings used are also set under their old names (not when another extension owns `omp.` names). */
  let legacyContextMirror = true;

  /** Records that the page of the editor's current document announced itself, so text can be sent to its composer. */
  function noteReadyDocument(state: TabState, announcedDocumentId: string | undefined): void {
    const s = windowState();
    const document = state.document;
    if (document === null || (announcedDocumentId ?? null) !== document.bridgeDocumentId) return;
    s.readyDocuments.set(state, document);
  }

  async function revealDesktopNotification(index: SessionIndex, extensionId: string, uri: vscode.Uri): Promise<void> {
    const s = windowState();
    if (uri.authority.toLowerCase() !== extensionId.toLowerCase() || uri.path !== "/reveal") return;
    const tabId = new URLSearchParams(uri.query).get("session");
    if (tabId === null || !/^tab:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tabId)) return;
    const panel = stateOf(tabId)?.panel;
    if (index.get(tabId) !== null) {
      if (panel !== null && panel !== undefined) {
        panel.reveal(panel.viewColumn, false);
        return;
      }
      const provider = s.launcherProvider;
      const view = s.launcherView;
      if (provider !== undefined && view !== undefined) {
        // The Terminals layout serves no session row: the session's process row is its place there. When that
        // process has ended there is no row at all, so the layout is changed to one that serves session rows
        // (nothing is launched) and the indexed session is revealed there.
        const plan = planNotificationReveal({
          sessionRowsShown: provider.sessionRowsShown(),
          hasProcessRow: provider.processItemFor(tabId) !== undefined,
          previousSessionLayout: s.lastSessionServingLayout,
        });
        if (plan.kind === "switch-layout") {
          await setSessionsGrouping(plan.to);
          refreshLauncher();
        }
        const item = plan.kind === "process-row" ? provider.processItemFor(tabId) : await provider.itemFor(tabId);
        if (item !== undefined && index.get(tabId) !== null) {
          try {
            await view.reveal(item, { select: true, focus: true });
            return;
          } catch {
            // Missing/stale tree membership is not permission to start the session.
          }
        }
      }
    }
    log.warn("The notified session has no retained editor or Sessions row in this window.");
  }

  // Commands

  /**
   * Reserve and open a new session in one of the launcher's folders.
   *
   * The folder comes from a folder row, or — invoked from the palette — from a
   * choice among the folders the launcher shows (this window's VS Code folders and the
   * pinned ones), with the Add flow when none is shown yet. A session is never started
   * in a folder the launcher does not show.
   *
   * The draft records the folder's exact path and no profile scope, which is what
   * makes the native launch pass OMP's explicit default-profile sentinel instead of
   * inheriting a profile from this extension host's environment.
   */
  async function newSession(
    context: vscode.ExtensionContext,
    index: SessionIndex,
    argument: unknown,
  ): Promise<void> {
    const s = windowState();
    const folders = s.launcherFolders;
    if (folders === undefined) return;
    const folder = await chooseFolder(index, folders, argument, {
      title: "Choose the folder for a new session",
      addWhenEmpty: true,
      openHereFirst: true,
    });
    if (folder === null) return;
    // The folder is resolved again after the dialog: a folder that left the launcher while the
    // picker was open must not be launched from the row that named it.
    const current = folders.get(folder.id);
    if (current === null) {
      showError("That folder is no longer in Sessions. Add it again to start a session there.");
      refreshLauncher();
      return;
    }
    // A second New Session for a folder whose first one is still starting is ignored; it brings forward the session that is starting,
    // so the click is answered and no second draft is reserved. The entry is taken before the launch can be routed or awaited, so a
    // double click cannot start two.
    const inFlight = s.newSessionsInFlight;
    if (inFlight.has(current.id)) {
      const starting = inFlight.get(current.id) ?? null;
      const panel = starting === null ? null : stateOf(starting)?.panel ?? null;
      if (starting !== null && panel !== null) await revealExistingTab(index, starting, panel);
      return;
    }
    inFlight.set(current.id, null);
    const origin: PendingOrigin = argument instanceof WorkspaceFolderTreeItem ? "row" : "command";
    const reserving = s.pending.begin(`folder:${current.id}`, "new-session", { origin, step: "reserving" });
    try {
      // A folder that only another window has open is started there (ADR-0057).
      if (await s.routing.routeLaunch(index, current, { kind: "new-session", folderId: current.id })) {
        reserving.end("handed-off");
        return;
      }
      await startNewSession(context, index, current, origin, tabId => {
        inFlight.set(current.id, tabId);
        reserving.end("running");
      });
    } finally {
      reserving.end("failed");
      inFlight.delete(current.id);
    }
  }

  /** Reserve a draft in the folder and open its editor: the launch itself, in this window. `onDraft` is told the draft's tab once it exists. */
  async function startNewSession(
    context: vscode.ExtensionContext,
    index: SessionIndex,
    current: LauncherFolder,
    origin: PendingOrigin = "row",
    onDraft?: (tabId: string) => void,
  ): Promise<void> {
    let entry: SessionIndexEntry;
    try {
      const commandAt = Date.now();
      entry = await index.createDraft({ cwd: current.path });
      windowState().launchTimeline.begin(entry.tabId, "new session", commandAt);
      windowState().launchTimeline.lap(entry.tabId, "draft");
    } catch (error) {
      showError(`A new OMP session could not be reserved: ${messageOf(error)}`);
      return;
    }
    // From here the new row carries the pending state; the folder's own "reserving" entry is over.
    const starting = windowState().pending.begin(entry.tabId, "new-session", { origin, step: "waiting" });
    onDraft?.(entry.tabId);
    try {
      refreshLauncher();
      // The editor comes first: a host that is slow to start, or fails, never delays the
      // chat surface the user just asked for. Until the conversation attaches the page shows
      // its phase, and the draft row and its claim are exactly what they would have been
      // otherwise.
      await windowState().sessionFlows.openTab(context, index, entry.tabId, "started");
      starting.end("running");
    } finally {
      starting.end("failed");
    }
  }

  /** Slash commands are local to the editor that received them, even for an unpinned folder. */
  async function createSessionInColumn(
    context: vscode.ExtensionContext, index: SessionIndex, cwd: string, column: vscode.ViewColumn,
  ): Promise<vscode.WebviewPanel | null> {
    const s = windowState();
    let entry: SessionIndexEntry;
    try {
      entry = await index.createDraft({ cwd });
    } catch (error) {
      showError(`A new OMP session could not be reserved: ${messageOf(error)}`);
      return null;
    }
    refreshLauncher();
    s.sessionPanelColumns.set(entry.tabId, column);
    try {
      await windowState().sessionFlows.openTab(context, index, entry.tabId, "started");
      const panel = stateOf(entry.tabId)?.panel ?? null;
      if (panel === null) showError("The new OMP session's editor could not be opened.");
      return panel;
    } catch (error) {
      showError(`The new OMP session's editor could not be opened: ${messageOf(error)}`);
      return null;
    } finally {
      s.sessionPanelColumns.delete(entry.tabId);
    }
  }

  async function newSessionInPlace(context: vscode.ExtensionContext, index: SessionIndex, tabId: string): Promise<void> {
    const s = windowState();
    const entry = index.get(tabId);
    const state = stateOf(tabId);
    const panel = state?.panel;
    if (entry === null || state === undefined || panel == null) {
      showError("This session's editor is no longer open, so nothing was replaced.");
      return;
    }
    if (s.replacingConversations.has(tabId)) { showWarning("This conversation is already being replaced."); return; }
    s.replacingConversations.add(tabId);
    const runtime = hostOf(state);
    const token = beginTransition(tabId, { check: () => true });
    let opened = false;
    try {
      const captured = runtime === null ? null : await s.sessionRuntime.readTransitionFacts({ conversation: tabId, target: s.sessionRuntime.snapshot(tabId)?.attachment ?? -1 });
      if (runtime !== null && captured?.settled !== true) { showWarning("The session is not idle; nothing was replaced."); return; }
      const column = windowState().editorPanels.sessionTabColumn(panel.viewType) ?? panel.viewColumn ?? vscode.ViewColumn.Active;
      if (await createSessionInColumn(context, index, entry.cwd, column) === null) return;
      opened = true;
      if (runtime !== null) {
        const preconfirmed = { target: s.sessionRuntime.snapshot(tabId)?.attachment ?? -1, conflicting: passiveReasonForSlot(state.slotId) !== null, captured, idleOnly: true };
        if (!(await confirmAndStopRuntime(context, index, tabId, "Stop", preconfirmed))) {
          showWarning("The new session opened, but the old session was not stopped. Its editor remains open.");
          return;
        }
      }
      if (state.tabId === tabId && state.panel === panel && hostOf(state) === null) panel.dispose();
    } catch (error) {
      showError(`${opened ? "The new session opened, but the old session could not be stopped" : "The session could not be replaced"}: ${messageOf(error)}`);
    } finally {
      s.replacingConversations.delete(tabId);
      s.sessionRuntime.endTransition(token, "none");
    }
  }

  async function deleteSessionInPlace(context: vscode.ExtensionContext, index: SessionIndex, tabId: string): Promise<void> {
    const entry = index.get(tabId);
    const panel = stateOf(tabId)?.panel;
    if (entry === null || panel == null) {
      showError("This session's editor is no longer open, so nothing was deleted.");
      return;
    }
    const column = windowState().editorPanels.sessionTabColumn(panel.viewType) ?? panel.viewColumn ?? vscode.ViewColumn.Active;
    if (!(await windowState().sessionActions.confirmAndDelete(index, tabId))) return;
    await createSessionInColumn(context, index, entry.cwd, column);
  }

  /**
   * The live Chat session one command names, or `null` after saying why there is none (docs/designs/2026-10-18-fork-branch-clear-session-actions.md).
   * A verified survivor this window has not attached is reattached first, as Rename does. Stopped rows, Terminal-mode sessions and an editor
   * this window may not drive are refused with a sentence; nothing is started, switched or stopped.
   */
  async function liveChatTarget(
    context: vscode.ExtensionContext, index: SessionIndex, argument: unknown, verb: string,
  ): Promise<{ readonly tabId: string; readonly entry: SessionIndexEntry } | null> {
    const s = windowState();
    const target = sessionTargetFromArgument(index, argument);
    if (target === null) { showWarning(`Select an OMP session to ${verb}.`); return null; }
    const { tabId, entry } = target;
    if (hostOf(stateOf(tabId)) == null && s.sessionRuntime.conversations.incarnationOf(tabId) === null && entry.sessionFile !== null && await s.sessionRuntime.verifiedWriterPid(tabId) !== null) {
      await windowState().sessionFlows.openTab(context, index, tabId, "opened", "restored");
    }
    const state = stateOf(tabId);
    const runtime = hostOf(state);
    if (state === undefined || runtime == null) { showWarning("That session is not running in this window. Resume it first."); return null; }
    if (runtime.kind !== "chat" || state.mode === "terminal") { showWarning(FORK_REFUSAL_SENTENCES.terminal); return null; }
    const refused = fencedOf(state) ? "The session view is changing or its process is stopping." : passiveReasonForSlot(state.slotId);
    if (refused !== null) { showWarning(refused); return null; }
    return target;
  }

  /**
   * Fork a live Chat session into a new Chat tab beside it (`ompDesk.forkSession`, typed `/fork`). The original's process, tab and file are
   * not touched: the fork is a new draft row whose first launch passes `--fork <the original's session file>` to OMP, which writes the new
   * file (history, parent link, title) itself. The checks (idle, saved, the file holds the live leaf) are the runtime's `forkSourceOf`.
   */
  async function forkSession(context: vscode.ExtensionContext, index: SessionIndex, argument: unknown): Promise<void> {
    const s = windowState();
    const target = await liveChatTarget(context, index, argument, "fork");
    if (target === null) return;
    const { tabId, entry } = target;
    const source = await s.sessionRuntime.conversations.forkSourceOf(tabId);
    if (source.status === "refused") { showWarning(FORK_REFUSAL_SENTENCES[source.reason]); return; }
    const panel = stateOf(tabId)?.panel ?? null;
    const column = panel === null ? vscode.ViewColumn.Active : s.editorPanels.sessionTabColumn(panel.viewType) ?? panel.viewColumn ?? vscode.ViewColumn.Active;
    let draft: SessionIndexEntry;
    try {
      draft = await index.createDraft({ cwd: source.cwd, scope: entry.scope });
    } catch (error) {
      showError(`The fork could not be reserved: ${messageOf(error)}`);
      return;
    }
    s.pendingForks.register(draft.tabId, source.file);
    refreshLauncher();
    s.sessionPanelColumns.set(draft.tabId, column);
    try {
      await pendingEntry(draft.tabId, "new-session", { origin: "row", step: "waiting" }, () => windowState().sessionFlows.openTab(context, index, draft.tabId, "started", "explicit", "chat"));
      if (stateOf(draft.tabId)?.panel == null) showError("The fork's editor could not be opened.");
    } catch (error) {
      showError(`The fork's editor could not be opened: ${messageOf(error)}`);
    } finally {
      s.sessionPanelColumns.delete(draft.tabId);
    }
  }

  /** Wait (bounded) for the Chat page of a tab to announce itself, then ask its composer to run one panel action. `false` when it never could. */
  async function deliverPanelAction(tabId: string, action: GuestPanelAction): Promise<boolean> {
    const s = windowState();
    const deadline = Date.now() + INSERT_TARGET_TIMEOUT_MS;
    for (;;) {
      const state = stateOf(tabId);
      const panel = state?.panel ?? null;
      if (state !== undefined && panel !== null && state.mode === "chat" && state.document?.kind === "guest" && !fencedOf(state) && s.readyDocuments.get(state) === state.document) {
        return panel.webview.postMessage({ type: "omp:webview-action", action } satisfies GuestPanelActionMessage);
      }
      if (Date.now() >= deadline) return false;
      await delay(INSERT_POLL_MS);
    }
  }

  /**
   * Branch: show the live Chat session and open its Rewind message picker, exactly as a typed `/branch` does (`ompDesk.branchSession`).
   * The editor is opened or revealed like Show in Chat; the page's own `onRewind` opens the picker once the page is ready.
   */
  async function branchSession(context: vscode.ExtensionContext, index: SessionIndex, argument: unknown): Promise<void> {
    const target = await liveChatTarget(context, index, argument, "branch");
    if (target === null) return;
    await windowState().sessionFlows.openSessionInMode(context, index, target.tabId, "chat", "show");
    if (!(await deliverPanelAction(target.tabId, "open-rewind"))) showWarning("The Chat page did not become ready, so its Rewind picker was not opened. Try Branch again.");
  }

  /**
   * Clear Context (`ompDesk.clearSession`): ask first with a modal dialog, then run the typed `/clear` flow of the live Chat session
   * (`ChatRuntime.clearConversation`: the same refusals and the same wait for OMP to be ready). Typed `/clear` stays unconfirmed.
   */
  async function clearSession(context: vscode.ExtensionContext, index: SessionIndex, argument: unknown): Promise<void> {
    const target = await liveChatTarget(context, index, argument, "clear");
    if (target === null) return;
    const { tabId, entry } = target;
    const confirm = "Clear Context";
    const choice = await vscode.window.showWarningMessage(
      `Clear the context of the OMP session “${windowState().launcherProvider?.headlineFor(entry.tabId) ?? sessionHeadline(entry, null)}”?`,
      { modal: true, detail: "OMP forgets the conversation so far: later replies no longer see it. The session, its file and its title stay, and the earlier messages stay in the transcript behind a “Context cleared” divider." },
      confirm,
    );
    if (choice !== confirm) return;
    await windowState().sessionRuntime.conversations.clearConversation(tabId, (text, outcome) => { if (outcome === "refused") showWarning(text); else showInfo(text); });
  }

  /**
   * Open or resume one session from its launcher row, its context menu or the palette.
   *
   * This is the admitted open path and nothing else. A row whose editor already shows
   * a running host is brought forward; every other row goes through {@link SessionFlows.openTab},
   * which reconciles ownership and attaches the verified writer before it may start
   * one. A row another window holds is never started from here (see the guard below); a
   * blocked row otherwise *rechecks*: it opens its editor, states why the session is not
   * attached, and never starts, replaces or stops a writer.
   *
   * Internal "opened" means immediate history/reveal without lifting stopped intent.
   * Menu/palette Open uses "resumed", the claim-and-exact-file launch path. Fileless
   * drafts retain immediate launch because they have no saved history to view.
   */
  async function openSession(
    context: vscode.ExtensionContext,
    index: SessionIndex,
    argument: unknown,
    verb: "opened" | "resumed",
    /** Never route this open to another window: it was asked for by another window (ADR-0057) or its caller needs the editor here. */
    noRouting = false,
    /** Reveal a writer that is live when the open resolves instead of changing its view (a launch another window asked for, ADR-0057). */
    keepLiveView = false,
    /** Who the user clicked: a row of the Sessions view shows its own state; a command (palette, Go to Session, keybinding) has no surface of its own. */
    origin: PendingOrigin = "command",
  ): Promise<boolean> {
    const commandAt = Date.now();
    const tabId =
      tabIdArgument(argument) ??
      (await pickIndexedTab(index, verb === "resumed" ? "Open an OMP session" : "View OMP session history"));
    if (tabId === null) return false;
    if (index.get(tabId) === null) {
      showError("That OMP session is no longer indexed in this window.");
      refreshLauncher();
      return false;
    }
    // The action is accepted from here: the row, the Chat page of the tab and (for a command) the status bar say so until it ends.
    return pendingEntry(tabId, verb === "resumed" ? "resume" : "open", { origin, step: "routing" }, handle =>
      openIndexedSession(context, index, tabId, verb, noRouting, keepLiveView, commandAt, handle));
  }

  /** The rest of {@link openSession} for a row the window indexes. `handle` is the pending operation the caller began for it. */
  async function openIndexedSession(
    context: vscode.ExtensionContext,
    index: SessionIndex,
    tabId: string,
    verb: "opened" | "resumed",
    noRouting: boolean,
    keepLiveView: boolean,
    commandAt: number,
    handle: PendingHandle,
  ): Promise<boolean> {
    const s = windowState();
    // A session another window holds switches to that window at once, with no confirmation:
    // nothing is launched from here. The claim is read afresh on every open of a row this window
    // does not run, not taken from the row's cached state, so a click while the row is still
    // Checking or stale switches too; a claim that was released meanwhile falls through to the
    // ordinary open below.
    if (!launcherFacts(tabId).running) {
      const openedAt = Date.now();
      const held = await s.routing.heldByAnotherWindow(index, tabId);
      windowTiming("requester: open of a row this window does not run", `${tabId.slice(0, 12)} held elsewhere=${held}, claim read ${Date.now() - openedAt} ms`);
      if (held) {
        await s.routing.switchToWindow(index, tabId);
        handle.end("handed-off");
        return false;
      }
      if (s.launcherProvider?.displayedState(tabId) === "otherWindow") s.launcherProvider.refreshOwnership(new Set([tabId]));
      // A session of a folder that only another window has open is opened there (ADR-0057).
      if (!noRouting && await s.routing.routeOpen(index, tabId, verb, null)) { handle.end("handed-off"); return false; }
    }
    // A row that shows a plain omp process outside this extension as the writer neither launches nor opens history on a
    // bare click: it asks first (ADR-0046), after a fresh probe, because the terminal may have exited since the row was last
    // checked. The question is asked by `openTabOnce`, with the editor already open (the ADR-0046 amendment); this only says
    // that the click was on such a row.
    const externalRowClicked = s.launcherProvider?.displayedState(tabId) === "externalOmp";
    // An explicit open is a request to recheck this session now: a background readiness
    // backoff (a startup pass over many rows) must never answer it.
    s.ptyGate?.invalidate();
    let state = stateOf(tabId);
    // A tab VS Code restored but has not shown yet has no panel handle here, and a page that
    // survived an extension-host restart never gets one. Either way the row's own tab is the
    // thing to bring forward: it is selected in the editor, and for a tab that still has to be
    // revived the panel it hands this window is awaited before anything else is decided.
    if (state !== undefined && state.panel === null) {
      const shown = await reviveEditorPanel(index, tabId);
      if (shown.selected && shown.panel === null) {
        refreshLauncher();
        return true;
      }
      state = stateOf(tabId);
    }
    const panel = state?.panel ?? null;
    if (panel !== null && hostOf(state) != null) {
      await revealExistingTab(index, tabId, panel);
      return true;
    }
    tabState(tabId).openDeclined = false;
    await timedLaunch(tabId, "open", commandAt, () => windowState().sessionFlows.openTab(context, index, tabId, verb, "explicit", undefined, false, keepLiveView, externalRowClicked));
    if (tabState(tabId).openDeclined) { handle.end("cancelled"); return false; }
    return true;
  }

  /** Whether a process with this id exists, by the null signal; `EPERM` still means it exists. */
  function isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  }

  // Folders

  /**
   * The one filesystem read Add needs.
   *
   * The folder dialog and this inspector both work through VS Code's own file
   * system, so a folder is accepted exactly once — under whatever spelling the
   * dialog returned — and a readable-but-not-a-directory path, a missing path and a
   * remote (non-`file`) location are each refused with their own reason instead of
   * being stored and failing later.
   */
  function folderPathInspector(): FolderPathInspector {
    return {
      async inspect(rawPath: string): Promise<FolderPathVerdict> {
        const uri = vscode.Uri.file(rawPath);
        let stat: vscode.FileStat;
        try {
          stat = await vscode.workspace.fs.stat(uri);
        } catch (error) {
          return {
            ok: false,
            reason: `"${rawPath}" could not be read as a folder: ${messageOf(error)}. Choose an existing local folder.`,
          };
        }
        if ((stat.type & vscode.FileType.Directory) === 0) {
          return { ok: false, reason: `"${rawPath}" is not a folder. Add a local folder, not a file.` };
        }
        return { ok: true, path: rawPath };
      },
    };
  }

  /** VS Code's own tab for one editor slot, in whichever group holds it, or `null`. */
  function editorTabOf(slot: string): vscode.Tab | null {
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const viewType = tab.input instanceof vscode.TabInputWebview ? tab.input.viewType : null;
        if (viewType !== null && tabInputIdentity(viewType)?.editorIdHex === slot) return tab;
      }
    }
    return null;
  }

  /** What {@link selectEditorTab} reads from VS Code and where it reports a refusal. */
  const tabSelectionApi: TabSelectionApi = {
    tabOf: editorTabOf,
    activeColumn: () => vscode.window.tabGroups.activeTabGroup.viewColumn,
    executeCommand: (command, ...args) => vscode.commands.executeCommand(command, ...args),
    nextTabChange: ms =>
      new Promise<void>(resolve => {
        const listeners: vscode.Disposable[] = [];
        const done = (): void => {
          clearTimeout(timer);
          for (const listener of listeners) listener.dispose();
          resolve();
        };
        const timer = setTimeout(done, ms);
        listeners.push(vscode.window.tabGroups.onDidChangeTabs(done), vscode.window.tabGroups.onDidChangeTabGroups(done));
      }),
    now: () => Date.now(),
    info: message => log.info(message),
  };

  /**
   * Make VS Code show this slot's tab. `WebviewPanel.reveal` needs the panel handle this window
   * may not have yet, so the tab itself is selected through its group and position; `openEditorAtIndex`
   * does not wait for the open, so the answer is VS Code's own report that the tab became active
   * (`src/host/editor-tab-selection.ts`).
   */
  function selectEditorTab(slot: string): Promise<boolean> {
    return selectEditorTabThrough(tabSelectionApi, slot, EDITOR_GROUP_FOCUS_COMMANDS);
  }

  /**
   * Show the editor of a tab this window has no panel handle for, and wait for the handle.
   *
   * VS Code revives a restored editor's webview only when the editor is first shown, so after a
   * reload every background tab is present in the tab strip but has no `WebviewPanel` here, and
   * none of the panel-based actions (reveal, view switch, reload) can reach it. Selecting the tab
   * is what makes VS Code hand the panel to this window's serializer. A page that survived an
   * extension-host restart is already running and is never revived again, so it is only selected
   * and no handle is awaited.
   *
   * `selected` says whether the user's editor now shows this tab; `panel` is the handle, when the
   * window holds one.
   */
  async function reviveEditorPanel(
    index: SessionIndex,
    tabId: string,
  ): Promise<{ readonly selected: boolean; readonly panel: vscode.WebviewPanel | null }> {
    const s = windowState();
    const state = stateOf(tabId);
    if (state === undefined) {
      log.info(`tab ${tabId}: no editor was selected, this window holds no record for it`);
      return { selected: false, panel: null };
    }
    if (state.panel !== null) return { selected: true, panel: state.panel };
    const slot = state.slotId;
    const pageIsRunning = s.bridgeLiveEditors.has(slot) && state.bridge?.documentId != null;
    let timer: NodeJS.Timeout | undefined;
    const bound = new Promise<void>(resolve => {
      const waiters = s.panelBindWaiters.get(slot) ?? new Set<() => void>();
      waiters.add(resolve);
      s.panelBindWaiters.set(slot, waiters);
      timer = setTimeout(resolve, EDITOR_REVIVE_TIMEOUT_MS);
    });
    try {
      // A panel this window was handed while the tab was being selected proves the tab was shown, whatever its tab reported.
      if (!(await selectEditorTab(slot)) && (s.tabs.get(slot)?.panel ?? null) === null) return { selected: false, panel: null };
      if (!pageIsRunning) await bound;
    } finally {
      clearTimeout(timer);
      s.panelBindWaiters.delete(slot);
    }
    const panel = s.tabs.get(slot)?.panel ?? null;
    if (panel === null) {
      requestSessionRowExpand(tabId);
      await setActiveTab(index, tabId);
    } else {
      await editorSettled(slot, tabId);
    }
    return { selected: true, panel };
  }

  /**
   * Wait (bounded) until a freshly revived editor has finished taking its seat:
   * controlling, not mid-open and not mid-transition. Its panel exists as soon as
   * the serializer hands it over, but binding the conversation and restoring the
   * host follow, and an action such as Reload that arrives in that gap is refused
   * as "passive, starting or stopping".
   */
  async function editorSettled(slot: string, tabId: string): Promise<void> {
    const s = windowState();
    const deadline = Date.now() + EDITOR_REVIVE_TIMEOUT_MS;
    for (;;) {
      const state = s.tabs.get(slot);
      if (state === undefined || state.panel === null) return;
      if (!fencedOf(state) && !s.openingTabs.has(tabId) && passiveReasonForSlot(slot) === null) return;
      if (Date.now() >= deadline) return;
      await new Promise<void>(resolve => setTimeout(resolve, 50));
    }
  }

  /**
   * Run one explicit launch command (`openTab` or the view change that ends in it) under a timeline run that began when the
   * command was entered (`commandAt`): the launcher then reports click-to-running and click-to-host-control for it
   * ({@link LaunchTimeline}). A run already open for the tab (a launch in flight) is kept; a run this command began is dropped
   * when the command ends without a launch having reached the launcher, so nothing later is reported as this command's.
   */
  async function timedLaunch<T>(tabId: string, kind: LaunchKind, commandAt: number, run: () => Promise<T>): Promise<T> {
    const timeline = windowState().launchTimeline;
    if (timeline.has(tabId)) return run();
    timeline.begin(tabId, kind, commandAt);
    try {
      return await run();
    } catch (error) {
      timeline.abandon(tabId, "an error before the launch (logged separately)");
      throw error;
    } finally {
      timeline.abandon(tabId, stateOf(tabId)?.openDeclined === true ? "the Cancel of the external-writer question" : undefined);
    }
  }

  /**
   * Run the entry of an action the user asked for as a pending operation (display only, `src/host/pending-operations.ts`): it begins
   * at once, once the target is known and before the first await, and ends when `run` settles. `run` may end it earlier with its
   * own status (a hand-over, a refusal, a cancel); `end` is idempotent, so the first status wins.
   */
  async function pendingEntry<T>(
    key: string,
    kind: PendingKind,
    options: { readonly origin?: PendingOrigin; readonly requestId?: string | null; readonly step?: PendingStep },
    run: (handle: PendingHandle) => Promise<T>,
  ): Promise<T> {
    const handle = windowState().pending.begin(key, kind, options);
    try {
      const result = await run(handle);
      handle.end("running");
      return result;
    } catch (error) {
      handle.end("failed");
      throw error;
    }
  }

  // Launch and reconciliation ports

  /** This window's session runtime: its index, chat runtime, reconciler, launcher, stop operations and process services behind the `SessionRuntime` port. */
  function createSessionRuntime(index: SessionIndex, chat: ChatRuntime): LocalSessionRuntime {
    return new LocalSessionRuntime(sessionRuntimeDeps(index, chat));
  }

  /** The ports of this window's session runtime; read at call time, so a replaced reconciler, launcher or root probe is used by the next call. */
  function sessionRuntimeDeps(index: SessionIndex, chat: ChatRuntime, launchers?: () => OmpHostLauncher, held?: RuntimeRecords): LocalSessionRuntimeDeps {
    const records = held ?? new RuntimeRecords(record => slotState(record.slotId)?.pipeline ?? null);
    const stop = new LocalStopOperations({
      chat: () => chat,
      attachBrokerClient,
      rootGone: root => windowState().rootGone(root),
      log,
    });
    const control = new LocalHostControl({
      index, records, window: controlWindow(index), store: controlStore(),
      chat: () => chat, diagnostics: () => windowState().diagnostics, log, attempts: windowState().hostControlAttempts, timeline: windowState().launchTimeline,
      stagedHelper: () => windowState().staging.entries().then(() => undefined, () => undefined),
    });
    const identity = new LocalIdentity({ index, records, window: identityWindow(index), log });
    const exit = new LocalExitOperations({
      index, records, window: exitWindow(index), control, stop, attachBrokerClient, proveExit: waitForManagedRootExit, brokerSlots: () => windowState().brokerSlots, log,
    });
    const nativeWatch = new LocalNativeWatch({
      index, records, window: nativeWatchWindow(index), control, exit, identity,
      reconciler: () => windowState().reconciler, brokerSlots: () => windowState().brokerSlots, log,
    });
    const brokerProvenance = (conversation: string): BrokerSlotProvenance => readBrokerProvenance({
      brokerSlots: windowState().brokerSlots,
      slotsForConversation: id => index.slotsForConversation(id),
    }, conversation);
    const writer = new LocalWriterVerifier({
      index, reconciler: () => windowState().reconciler,
      window: {
        runtimePid: conversation => records.get(conversation)?.runtime?.pid ?? null,
        holderMayBeAlive: (claim, display) => display ? holderSeemsAlive(claim, windowState().routing.registry()) : claimHolderMayBeAlive(claim),
      },
    });
    const recorded = new LocalRecordedStop({
      index, writer, control, brokerSlots: () => windowState().brokerSlots,
      window: { forgetOutcome: conversation => { windowState().outcomes.delete(conversation); } },
      stopPort: (slot, expectedBroker) => createRecordedHostStopPort({ brokerProvenanceFor: brokerProvenance, attachBrokerClient, log }, slot, expectedBroker),
    });
    const launcher = launchers ?? ((): OmpHostLauncher => {
      const context = windowState().context;
      if (context === undefined) throw new Error("The session runtime was used before activation.");
      return localLauncher(context, index, chat);
    });
    const transitions = new LocalTransitions({
      index, records, window: transitionWindow(index), chat, stop, control, exit, writer, attachBrokerClient, launcher, log,
      brokerWatches: windowState().brokerWatches,
    });
    return {
      index,
      records,
      reconciler: () => windowState().reconciler,
      launcher,
      chat, stop, control, identity, nativeWatch, exit, writer, recorded, brokerProvenance, transitions,
      kill: new LocalKill({
        index, control, window: killWindow(index), brokerSlots: () => windowState().brokerSlots, log,
        endDriven: async tabId => {
          const state = records.get(tabId);
          const runtime = state?.runtime ?? null;
          return state !== undefined && runtime !== null && await exit.endEnded(state, runtime);
        },
      }),
    };
  }

  const transitionChecks = new WeakMap<TransitionToken, TransitionChecks>();

  /** Raise the admission fence of a conversation for one flow, with the checks it makes under the gate. */
  function beginTransition(conversation: string, checks: TransitionChecks): TransitionToken {
    const sessionRuntime = windowState().sessionRuntime;
    const shown = stateOf(conversation);
    if (shown !== undefined && shown.tabId !== null) recordFor(shown);
    const token = sessionRuntime.beginTransition({ conversation, target: sessionRuntime.snapshot(conversation)?.attachment ?? null });
    transitionChecks.set(token, checks);
    return token;
  }

  /** The window's side of the gated transitions: the fence's projection onto the editors, the flow's own checks, the frontends and memories a stop ends. */
  function transitionWindow(index: SessionIndex): TransitionWindow {
    return {
      fenced(conversation) {
        const state = stateOf(conversation);
        if (state === undefined) refreshGuestContext();
        else projectFence(index, state);
      },
      check: (token, phase) => transitionChecks.get(token)?.check(phase) ?? true,
      prepare: token => transitionChecks.get(token)?.prepare?.() ?? Promise.resolve(),
      endTerminal: record => stopTerminalForTab(record.slotId),
      stopped(conversation, scope) {
        if (scope !== "session") return;
        windowState().outcomes.delete(conversation);
        forgetTurnActivity(index, conversation);
      },
    };
  }

  /** The window's side of Kill: what it reads of this window's runtime copy and the surfaces it reports through. */
  function killWindow(index: SessionIndex): KillWindow {
    return {
      runtimeIdentity: tabId => hostOf(stateOf(tabId))?.identity ?? null,
      forgetOutcome: tabId => { windowState().outcomes.delete(tabId); },
      readRows: async () => (await windowState().sessionProcesses?.refresh())?.rows ?? [],
      launcherChanged: () => refreshLauncher(),
      async refresh() {
        refreshLauncher({ ownership: true });
        await windowState().sessionProcesses?.refresh();
      },
      notice: (level, text) => { void (level === "info" ? vscode.window.showInformationMessage(`OMP Desk: ${text}`) : vscode.window.showWarningMessage(`OMP Desk: ${text}`)); },
      requester: () => `the Sessions menu of window "${vscode.workspace.name ?? "no folder"}" (${index.claimHolder.id.slice(0, 8)})`,
    };
  }

  /** The editor's tab record behind a runtime record: the one under the slot the record says serves its conversation. */
  function tabRecord(record: RuntimeRecord): TabState {
    return slotState(record.slotId) ?? tabState(record.slotId);
  }

  /** What the runtime holds for the conversation an editor shows; `undefined` for a folder shell and for an editor that never hosted one. */
  function recordOf(state: { readonly tabId: string | null } | null | undefined): ConversationRecord | undefined {
    return state === null || state === undefined ? undefined : windowState().sessionRuntime.records.get(state.tabId);
  }

  /** The runtime's record of the conversation an editor shows, created for the editor on first use. */
  function recordFor(state: TabState): ConversationRecord {
    if (state.tabId === null) throw new Error("A folder shell hosts no conversation.");
    return windowState().sessionRuntime.records.acquire(state.tabId, state.slotId);
  }

  /** The process this window runs for the editor's conversation. */
  function hostOf(state: { readonly tabId: string | null } | null | undefined): SessionHostRuntime | null {
    return recordOf(state)?.runtime ?? null;
  }

  /**
   * Whether the writer a launch started is ready for what the user opened it for (`src/host/launch-readiness.ts`): the Sessions row
   * and the Chat page say `Starting…` until it is, not until the broker has started the process.
   */
  function launchReadinessOf(tabId: string): LaunchReadiness {
    const s = windowState();
    const record = s.sessionRuntime.records.get(tabId);
    const runtime = record?.runtime ?? null;
    return launchReadiness({
      runtime: runtime === null ? null : { kind: runtime.kind, carriesControl: runtime.control !== null, stopping: runtime.kind === "terminal" && runtime.stopping },
      chatPhase: s.sessionRuntime.conversations.stateOf(tabId)?.phase ?? null,
      controlVerified: record?.control != null,
      controlFailed: record?.controlFailure != null,
    });
  }

  /** The verified host-control channel of the editor's conversation. */
  function controlOf(state: { readonly tabId: string | null } | null | undefined): ConversationRecord["control"] {
    return recordOf(state)?.control ?? null;
  }

  /** Whether the conversation's admission fence is up. */
  function fencedOf(state: { readonly tabId: string | null } | null | undefined): boolean {
    return recordOf(state)?.transitioning === true;
  }

  /** Where this window keeps host-control material: the profile's global state and secret storage, read at call time. */
  function controlStore(): ControlStore {
    const context = (): vscode.ExtensionContext => {
      const active = windowState().context;
      if (active === undefined) throw new Error("Host control was used before activation.");
      return active;
    };
    return {
      directory: () => controlDirectoryOf(context().globalStorageUri.fsPath),
      record: <T>(key: string) => context().globalState.get<T>(key),
      setRecord: (key, value) => Promise.resolve(context().globalState.update(key, value)),
      secret: name => Promise.resolve(context().secrets.get(name)),
      setSecret: (name, value) => Promise.resolve(context().secrets.store(name, value)),
      deleteSecret: name => Promise.resolve(context().secrets.delete(name)),
    };
  }

  /** The window's side of host control (design §2.5): what a published channel starts on this side. */
  function controlWindow(index: SessionIndex): ControlWindow {
    return {
      published(tabId, client, subagents) {
        const s = windowState();
        if (subagents) watchSubagentWork(index, tabId, client);
        s.guestDispatcher.invalidateControls(tabId);
        void s.bridgeHost.commitDocument(tabId);
        s.bridgeHost.refreshReadiness(tabId);
      },
    };
  }

  /** The window's side of identity binding: what a bound file changes in the tab and the document. */
  function identityWindow(index: SessionIndex): IdentityWindow {
    return {
      bound(tabId) {
        const s = windowState();
        void applyChatTabAppearance(s.context as vscode.ExtensionContext, index, tabId);
        // The document could not be committed while the session had no file: the binding a
        // surviving page authenticates against needs the exact file.
        void s.bridgeHost.commitDocument(tabId);
        s.bridgeHost.refreshReadiness(tabId);
      },
      conflict(_tabId, detail) { showError(detail); },
      refresh: () => refreshLauncher(),
    };
  }

  /** The window's side of the end of a process: its terminal pane, views, launcher and notifications. */
  function exitWindow(index: SessionIndex): ExitWindow {
    return {
      activated: () => windowState().context !== undefined,
      fence: (record, on) => fenceSessionAdmission(index, tabRecord(record), on),
      forgetOutcome: tabId => { windowState().outcomes.delete(tabId); },
      endTerminal: record => stopTerminalForTab(record.slotId),
      view: record => pushSessionView(index, tabRecord(record)),
      refresh: () => refreshLauncher(),
      nativeEnded(tabId) {
        const s = windowState();
        s.outcomes.delete(tabId);
        s.turnActivities.delete(tabId);
        refreshGuestContext();
        refreshLauncher();
      },
      notice: (level, text) => { if (level === "error") showError(text); else showWarning(text); },
    };
  }

  /** The window's side of the native watch: completion notices, turn activity and the editor that follows a handover. */
  function nativeWatchWindow(index: SessionIndex): NativeWatchWindow {
    return {
      activated: () => windowState().context !== undefined,
      view: record => pushSessionView(index, tabRecord(record)),
      observer(record, runtime) {
        const s = windowState();
        const state = tabRecord(record);
        const reportSuppressed = (kind: TurnNotice["kind"], reason: NotificationSuppression | "aborted"): void => {
          if (state.tabId === null) return;
          logNotificationSuppression(state.tabId, kind, reason);
          if (reason !== "aborted") recordSessionEvent(index, state.tabId);
        };
        let activityLedger = new NativeActivityLedger(reportSuppressed);
        // A reconnect builds a new ledger that recovers a still-pending dialog; its toast was already sent.
        const announcedRequests = new Set<string>();
        let activityClient: HostControlClient | undefined;
        return {
          observe(client, journal, facts) {
            if (state.tabId === null) return;
            if (activityClient !== client) { activityClient = client; activityLedger = new NativeActivityLedger(reportSuppressed); }
            const notices = journal === null ? [] : activityLedger.observe(journal,
              index.get(state.tabId)?.sessionId ?? null, notificationSuppression(index, state.tabId));
            const work = journal?.work ?? null;
            const activity: TurnActivity = {
              streaming: work?.working === true, backgroundWork: work?.backgroundWork === true,
              settled: facts.settled === true, promptStatus: null, completionOutcome: null,
              pendingRequest: journal === null ? null : activityLedger.pendingRequest,
              outcome: null, trailingQuestion: false,
            };
            const previous = s.turnActivities.get(state.tabId);
            s.turnActivities.set(state.tabId, activity);
            if (activity.pendingRequest === null) announcedRequests.clear();
            for (const notice of notices) {
              if (notice.kind === "request-pending") {
                if (announcedRequests.has(notice.requestId)) continue;
                announcedRequests.add(notice.requestId);
              }
              notifierFor(index).notify(state.tabId, notice);
            }
            if (previous === undefined || activitySignature(previous) !== activitySignature(activity)) {
              log.debug(`tab ${state.tabId}: native observation ${activity.pendingRequest !== null ? "needs your answer" : facts.settled === true ? "settled" : work?.working === true ? "working" : work?.backgroundWork === true ? "background work" : "unsettled/unknown"} (${journal === null ? "completion journal unavailable" : work === null ? "work detail unavailable" : "completion journal observed"})`);
              refreshLauncher();
            }
          },
        };
      },
      titled(tabId) {
        const context = windowState().context;
        if (context !== undefined) void applyChatTabAppearance(context, index, tabId);
      },
      async committed(tabId) {
        const s = windowState();
        await s.bridgeHost.commitDocument(tabId);
        s.bridgeHost.refreshReadiness(tabId);
      },
      passive: (record, tabId, detail) => bindSlotToConversation(record.slotId, tabId, "passive", detail),
      rebound(record, from, to, binding) {
        const s = windowState();
        stopTerminalForTab(record.slotId);
        s.draftRestores.delete(record.slotId);
        forgetTurnActivity(index, from);
        const previousWinner = s.bridgeEditors.winner(to);
        if (previousWinner !== null && previousWinner.editorId !== record.slotId) s.bridgeEditors.release(to, previousWinner.editorId);
        s.bridgeEditors.rekey(from, record.slotId, to);
        bindSlotToConversation(record.slotId, to, binding.role, binding.roleRefusal ?? null);
      },
      async presented(record, runtime, to) {
        const s = windowState();
        const state = tabRecord(record);
        const context = s.context;
        if (context !== undefined && state.panel !== null) {
          state.document = null;
          if (state.bridge !== null) await s.bridgeHost.prepareDocument(context, state.slotId);
          s.editorPanels.renderPanelDocument(context, state.slotId);
        }
        ensureTerminalPipeline(index, state.slotId, runtime.handle);
        await s.bridgeHost.commitDocument(to);
        s.bridgeHost.refreshReadiness(to);
      },
      settled(to) {
        const context = windowState().context;
        if (context !== undefined) void applyChatTabAppearance(context, index, to);
        refreshLauncher();
      },
    };
  }

  /**
   * The window's side of launch and attach (design §2.5): the hooks `LocalLauncher` calls while it
   * starts or re-adopts a host, in the order a launch runs them.
   */
  function launcherWindow(context: vscode.ExtensionContext, index: SessionIndex): LauncherWindow {
    return {
      // A document's native binding is immutable. Resume/Reload replaces the child, so
      // retire the old capability and remount this same editor with a fresh incarnation.
      async retireDocument(tabId) {
        const editor = stateOf(tabId);
        if (editor !== undefined && editor.panel !== null && editor.bridge !== null && editor.bridge.endpoint.committedBinding() !== null) {
          await windowState().bridgeHost.prepareDocument(context, editor.bridge.editorId);
          windowState().editorPanels.renderPanelDocument(context, editor.bridge.editorId);
        }
        return stateOf(tabId)?.bridge?.editorId ?? null;
      },
      adopt(tabId, runtime) {
        cancelControlPicker(tabId);
        const state = tabState(tabId);
        recordFor(state).runtime = runtime;
        recordFor(state).endedNotice = null;
        state.mode = runtime.kind;
      },
      isCurrent: (tabId, runtime) => hostOf(stateOf(tabId)) === runtime,
      async prepareView(tabId, runtime) {
        const s = windowState();
        const state = tabState(tabId);
        // The selected view can differ from a surviving writer we just reattached.
        // Persist what actually runs, not the provisional selection stamped while
        // its editor was being created; restoration must not turn every such tab
        // into the profile default on the next launch.
        const binding = index.slotBinding(state.slotId);
        if (binding?.tabId === tabId && binding.mode !== state.mode) await index.setEditorMode(state.slotId, state.mode);
        if (runtime.kind === "terminal") {
          s.sessionRuntime.conversations.release(tabId);
          s.detailTabs.closeConversation(tabId);
          state.chatDetach?.();
          state.chatDetach = null;
          ensureTerminalPipeline(index, tabId, runtime.handle);
        }
      },
      attached(tabId, runtime) {
        const s = windowState();
        const state = tabState(tabId);
        if (runtime.kind === "terminal") {
          s.sessionRuntime.nativeWatch.start(recordFor(state), runtime);
          refreshGuestContext();
          return;
        }
        if (fencedOf(state)) s.sessionRuntime.conversations.setFence(tabId, "Session lifecycle transition.");
        attachChatRoutes(tabId, true);
      },
      notice: (level, text) => { if (level === "error") showError(text); else showWarning(text); },
    };
  }

  /** The host launcher the runtime hands to the index: this window's launch and attach, over `launcherWindow`'s hooks. */
  function localLauncher(context: vscode.ExtensionContext, index: SessionIndex, chat: ChatRuntime): LocalLauncher {
    const s = windowState();
    return new LocalLauncher({
      index,
      window: launcherWindow(context, index),
      chat,
      diagnostics: s.diagnostics,
      entries: () => windowState().staging.entries(),
      launchRefusal: () => (packageChangedOnDisk() ? UPDATED_ON_DISK_ERROR : null),
      hosts: { launchRpc: launchRpcHost, launchNative: launchNativeHost, attachRpc: attachRpcWithRestoreParking, attachNative: attachNativeHost },
      brokerSlots: s.brokerSlots,
      brokerClient,
      chatBrokerClient,
      attachBrokerClient,
      brokerUnavailableReason: () => windowState().ptyGate?.reason(),
      brokerWatches: s.brokerWatches,
      linkReminder: () => vscode.workspace.getConfiguration("ompDesk").get<boolean>("linkReminder", false),
      toolIntent: () => vscode.workspace.getConfiguration("ompDesk").get<boolean>("toolIntentDescriptions", false),
      htmlPages: chatHtmlPagesEnabled,
      forks: s.pendingForks,
      control: s.sessionRuntime.control,
      native: s.sessionRuntime.nativeWatch,
      exit: s.sessionRuntime.exit,
      diagnosticsLabel,
      timeline: s.launchTimeline,
      log,
    });
  }

  function defaultSessionMode(context: vscode.ExtensionContext): SessionViewMode {
    return context.globalState.get<string>(SESSION_DEFAULT_MODE_KEY) === "terminal" ? "terminal" : "chat";
  }

  async function chooseDefaultSessionView(context: vscode.ExtensionContext): Promise<void> {
    const current = defaultSessionMode(context);
    const picked = await vscode.window.showQuickPick([
      { label: "$(comment-discussion) Chat", description: current === "chat" ? "Current profile default" : "", mode: "chat" as const },
      { label: "$(terminal) Terminal", description: current === "terminal" ? "Current profile default" : "", mode: "terminal" as const },
    ], { title: "Default view for newly opened OMP session editors" });
    if (picked === undefined) return;
    await context.globalState.update(SESSION_DEFAULT_MODE_KEY, picked.mode);
    refreshLauncher();
  }

  function sessionAdmissionReason(state: TabState): string | null {
    if (fencedOf(state)) return "The session view is changing or its process is stopping.";
    if (state.mode === "terminal") return "Chat commands are unavailable in Terminal; use the native TUI.";
    return passiveReasonForSlot(state.slotId);
  }

  function pushSessionView(index: SessionIndex | null, state: TabState, force = false): void {
    const s = windowState();
    if (state.tabId === null) return;
    const entry = index?.get(state.tabId) ?? null;
    const title = entry === null ? "OMP session" : sessionHeadline(entry, null);
    const hosted = hostOf(state);
    const running = hosted !== null;
    const starting = state.mode === "terminal" && (s.openingTabs.has(state.tabId) || (!running && s.pendingSessionViewChanges.has(state)));
    const stopping = fencedOf(state) || (hosted?.kind === "terminal" && hosted.stopping);
    const canSwitch = !stopping && !s.pendingSessionViewChanges.has(state) && state.panel !== null && passiveReasonForSlot(state.slotId) === null && !s.openingTabs.has(state.tabId);
    const reason = starting ? null : (recordOf(state)?.controlFailure ?? null) ?? (stopping ? "OMP is restarting or stopping this session. It can be used again once the old process has exited." : null);
    const previous = state.viewProjection;
    if (!force && previous !== null && previous.mode === state.mode && previous.title === title && previous.running === running && previous.starting === starting && previous.stopping === stopping && previous.canSwitch === canSwitch && previous.reason === reason) return;
    const message: GuestSessionViewMessage = { type: "omp:session-view", mode: state.mode, title, running, starting, stopping, canSwitch, reason };
    state.viewProjection = message;
    if (state.panel !== null) void state.panel.webview.postMessage(message);
    else if (state.bridge?.documentId != null) state.bridge.endpoint.pushTerminal(state.bridge.documentId, message);
  }

  /** Only explicit activation and fresh-document readiness issue keyboard intent. */
  function activateNativeEditor(state: TabState): void {
    if (state.mode !== "terminal" || state.document?.kind !== "guest" || activePanelTab() !== state || !vscode.window.state.focused) return;
    void state.panel?.webview.postMessage({ type: "omp:terminal-activate", token: encodeHex(randomBytes(16)) } satisfies GuestTerminalActivateMessage);
  }

  function fenceSessionAdmission(index: SessionIndex, state: TabState, fenced: boolean): void {
    recordFor(state).transitioning = fenced;
    if (state.tabId !== null) windowState().sessionRuntime.conversations.setFence(state.tabId, fenced ? "Session lifecycle transition." : null);
    projectFence(index, state);
  }

  /** What the editors show of a fence that changed: the guest context, the control picker, the slot's authority and the view. */
  function projectFence(index: SessionIndex, state: TabState): void {
    refreshGuestContext();
    if (state.tabId !== null) cancelControlPicker(state.tabId);
    applySlotAuthority(state.slotId);
    pushSessionView(index, state);
  }

  // Restore

  /**
   * Show the saved history of a restored editor of a session another window is home for, read-only, taking no claim and
   * starting nothing (ADR-0080, amendment of 2026-10-21).
   */
  async function showRestoredOutsideHome(index: SessionIndex, tabId: string): Promise<void> {
    const entry = index.get(tabId);
    if (entry === null) return;
    const s = windowState();
    await s.sessionRuntime.conversations.showViewOnly(tabId, {
      file: entry.sessionFile, cwd: entry.cwd, title: entry.title,
      reason: "This session belongs to another window. Use Sessions to switch to it, or Move to This Window.",
      phase: "blocked",
    });
    if (s.sessionRuntime.conversations.kindOf(tabId) === "view-only") attachChatRoutes(tabId, true);
  }

  /**
   * `attachRpcHost` with the startup pass's kept broker connections, while the pass runs: a row whose reconcile kept the connection
   * that proved its host attaches over it (after a new status and every proof); any other attach, and any attach after the pass,
   * dials its own.
   */
  function attachRpcWithRestoreParking(input: Parameters<typeof attachRpcHost>[0]) {
    const parking = windowState().catalogAdoption.restoreParking();
    return attachRpcHost(parking === null ? input : { ...input, parking });
  }

  /**
   * Whether this window currently has an editor showing that conversation.
   *
   * An editor this window holds a panel for counts, and so does one VS Code still lists whose
   * page outlived the previous extension host: it has no panel handle and no slot registration
   * yet, but it is exactly the editor a re-adopted conversation must reach, so the row is in
   * the restore cohort even though nothing in this activation has bound a panel to it.
   */
  function hasLocalEditorFor(tabId: string): boolean {
    const s = windowState();
    if ((s.tabs.get(tabId)?.panel ?? null) !== null) return true;
    if (
      s.editorSlots
        .entries()
        .some(entry => entry.tabId === tabId && s.bridgeLiveEditors.has(entry.slotId))
    ) {
      return true;
    }
    const index = s.indexForBridge;
    return s.bridgeHost
      .editorMembership()
      .some(entry => (index === null ? s.bridgeEditors.tabOfEditor(entry.editorId) ?? entry.tabId : s.bridgeHost.editorConversation(index, entry)) === tabId);
  }

  /**
   * Build this window's view of the profile catalog.
   *
   * Every record key this extension owns is registered with the merge rule of the
   * module that owns its schema, so a whole-snapshot write from a stale window becomes
   * a delta against the newest committed revision instead of overwriting another
   * window's work.
   */
  function createProfileCatalog(context: vscode.ExtensionContext): Promise<OpenedCatalog> {
    return openProfileCatalog({
      context,
      log,
      mergers: {
        [SESSION_INDEX_STORAGE_KEY]: mergeSessionIndexRecords,
        [WORKSPACE_FOLDERS_STORAGE_KEY]: mergeWorkspaceFolderRecords,
        [BROKER_SLOTS_KEY]: mergeBrokerSlotRecords,
        [SHELL_SLOTS_KEY]: mergeShellSlotRecords,
      },
      keys: { sessions: SESSION_INDEX_STORAGE_KEY, folders: WORKSPACE_FOLDERS_STORAGE_KEY },
      showLog: () => windowState().output?.show(),
      onUnavailable: reason => {
        log.warn(`the OMP profile catalog is unusable, so nothing will be saved this session: ${reason}`);
        showWarning(
          "The saved OMP sessions and folders could not be read, so this window is running without them and will not overwrite them. " +
            `See the OMP Desk output channel. (${reason})`,
        );
      },
    });
  }

  /**
   * Reconcile, launch and publish every row the activation cohort covers.
   *
   * The pass is pinned to `cohort` rather than to whatever the index holds when it
   * gets there: a row created while the pass was preparing (a new draft, a History
   * import) belongs to the click that created it, which opens it explicitly, and
   * sweeping it into the batch as well would put two restores on one row.
   */
  async function restoreTabs(
    index: SessionIndex,
    cohort: ReadonlySet<string>,
    /** Filled as the pass goes, for the timeline line that closes it; a caller that does not report it passes none. */
    phases: RestorePassPhases = {},
  ): Promise<void> {
    const s = windowState();
    const tabsStartedAt = Date.now();
    if (cohort.size === 0) {
      refreshLauncher();
      return;
    }
    // VS Code may have restored editors before this pass ran: each is shown the saved history
    // of its session from disk while its host is reconciled, launched or attached, so the
    // transcript is on screen at once and never waits for a process.
    for (const tabId of cohort) {
      const entry = index.get(tabId);
      if (entry === null || entry.sessionFile === null || s.sessionRuntime.conversations.kindOf(tabId) === "live") continue;
      if ((stateOf(tabId)?.panel ?? null) === null) continue;
      void s.sessionRuntime.conversations
        .showViewOnly(tabId, { file: entry.sessionFile, cwd: entry.cwd, title: entry.title, reason: "Restoring the session…", phase: "resyncing" })
        .then(() => {
          if (s.sessionRuntime.conversations.kindOf(tabId) === "view-only") attachChatRoutes(tabId, true);
        });
    }

    let report: RestoreReport;
    try {
      // Only the rows this window is responsible for: an automatic pass never re-derives a row
      // another workspace put in the shared index. Nothing waits on any other process or
      // service: each row is reconciled against its own broker slot.
      const passStartedAt = Date.now();
      phases.beforeMs = passStartedAt - tabsStartedAt;
      report = await s.sessionRuntime.restore({ cohort });
      // Every row has attached or been refused: a connection a reconcile kept and no attach claimed is closed now, not at the pass's end.
      const unclaimed = s.catalogAdoption.restoreParking()?.release() ?? 0;
      if (unclaimed > 0) windowTiming("restore pass", `closed ${unclaimed} kept broker connection(s) no attach claimed`);
      phases.restoreAllMs = Date.now() - passStartedAt;
      phases.rowsMs = report.rowsMs;
      windowTiming("restore pass", `restoreAll ${Date.now() - passStartedAt} ms for ${cohort.size} rows`);
    } catch (error) {
      showError(`Stored OMP sessions could not be restored: ${messageOf(error)}`);
      refreshLauncher();
      return;
    }
    recordOutcomes(report);

    // Editors are VS Code's: which editors are open, in which editor groups, and
    // which one is selected are all facts it restores through the serializer. So
    // this pass creates no editor, reveals none and takes no focus — it only
    // projects its own result into the editors that already exist, a restored one or
    // one an explicit click opened. A row whose editor the user closed therefore
    // stays closed, and a restart lands where the user left it rather than on the
    // last tab this extension happened to restore.
    // The batch pass connected this window's surviving hosts, and each editor it covers
    // becomes controlling *before* the report is projected: projecting a passive editor
    // would post no link into it, and the editor would stay connected-but-unserved. The
    // election is idempotent, so an editor that already holds the role costs one no-op
    // commit.
    const electionsAt = Date.now();
    for (const tabId of cohort) await electLocalController(index, tabId);
    windowTiming("restore pass", `controller elections ${Date.now() - electionsAt} ms for ${cohort.size} rows`);
    phases.electionsMs = Date.now() - electionsAt;
    const publishAt = Date.now();
    projectRestoreReport(index, report);
    refreshLauncher();
    void revealActiveSession(index);

    log.info(
      `restore: ${report.restored.length} running, ${report.attached.length} already open, ` +
        `${report.drafts.length} draft, ${report.stopped.length} stopped, ${report.conflicts.length} conflict, ` +
        `${report.failures.length} failed, ${report.skipped.length} skipped`,
    );
    for (const conflict of report.conflicts) {
      log.warn(`restore conflict (${conflict.kind}) on tab ${conflict.tabId}: ${conflict.detail}`);
    }
    for (const failure of report.failures) {
      log.error(`restore failure (${failure.kind}) on tab ${failure.tabId}: ${failure.detail}`);
    }
    windowState().persistFailures.report({ persistError: report.persistError, persistBusy: index.persistBusy }, "The OMP session index could not be saved: ");
    phases.publishMs = Date.now() - publishAt;
    phases.returnedAt = Date.now();
    // The saves the rows queued are not waited for (the pass's end must not wait for catalog transactions across windows); a failure
    // they end with is reported when they have run, unless the pass already reported that very failure.
    void report.saved.then(failure => {
      if (failure === null || failure === report.persistError) return;
      windowState().persistFailures.report({ persistError: failure, persistBusy: index.persistBusy }, "The OMP session index could not be saved: ");
    });
  }

  async function handleRestoreOutcome(
    context: vscode.ExtensionContext,
    index: SessionIndex,
    tabId: string,
    outcome: RestoreOutcome,
  ): Promise<void> {
    const s = windowState();
    // The launcher shows this outcome until the next attempt, so a refused or
    // failed open stays visible after the notification is gone.
    s.outcomes.set(tabId, outcome);
    refreshLauncher();
    switch (outcome.status) {
      case "restored":
        log.info(`tab ${tabId}: OMP host running`);
        // The election comes first: a page is only served the conversation when it is the
        // controlling editor here. The conversation itself was attached by the launch.
        await electLocalController(index, tabId);
        attachChatRoutes(tabId, true);
        return;
      case "attached":
        log.info(`tab ${tabId}: ${outcome.detail}`);
        await electLocalController(index, tabId);
        attachChatRoutes(tabId, true);
        return;
      case "skipped":
        log.info(`tab ${tabId}: skipped: ${outcome.detail}`);
        return;
      default:
        if (outcome.status === "draft" || outcome.status === "stopped" || outcome.status === "failed") await electLocalController(index, tabId);
        presentRestoreOutcome(index, tabId, outcome);
        return;
    }
  }

  /**
   * Tell a tab's page why it has no live conversation.
   *
   * A stopped row shows its saved history read-only; a row an earlier build's host still owns
   * is a legacy tab only while the writer is positively verified. Unowned drafts
   * and stopped editors remain controlling and usable without a release ceremony.
   */
  function presentRestoreOutcome(
    index: SessionIndex,
    tabId: string,
    outcome: Exclude<RestoreOutcome, { readonly status: "restored" | "attached" | "skipped" }>,
  ): void {
    switch (outcome.status) {
      case "draft":
        log.info(`tab ${tabId}: draft tab restored without a process`);
        windowState().guestDispatcher.presentUnavailable(index, tabId, DRAFT_NO_HOST_DETAIL);
        return;
      case "stopped":
        // The row stays exactly as the user left it. A restored editor for it shows its saved
        // history and why nothing was started.
        log.info(`tab ${tabId}: stopped by its durable run intent; nothing was started or attached`);
        windowState().guestDispatcher.presentUnavailable(index, tabId, outcome.detail);
        return;
      case "conflict": {
        log.error(`tab ${tabId}: conflict (${outcome.kind}): ${outcome.detail}`);
        presentConflict(index, tabId, outcome.detail);
        if (outcome.kind === "claim-conflict") showClaimConflict(tabId, `${CONFLICT_LABEL[outcome.kind]}. ${outcome.detail}`);
        else showError(`${CONFLICT_LABEL[outcome.kind]}. ${outcome.detail}`);
        return;
      }
      case "failed":
        log.error(`tab ${tabId}: failed (${outcome.kind}): ${outcome.detail}`);
        windowState().guestDispatcher.presentUnavailable(index, tabId, outcome.detail);
        showError(`The OMP session could not be started: ${outcome.detail}`);
        return;
    }
  }

  /** Present a positively verified writer; a legacy writer remains explicitly stoppable. */
  function presentConflict(index: SessionIndex, tabId: string, detail: string): void {
    const s = windowState();
    const entry = index.get(tabId);
    if (entry !== null && entry.host !== null && !isManagedHost(entry.host)) {
      s.sessionRuntime.conversations.showLegacy(tabId, { cwd: entry.cwd, title: entry.title, reason: detail });
      attachChatRoutes(tabId, true);
      return;
    }
    s.guestDispatcher.presentUnavailable(index, tabId, detail, "blocked");
  }

  /**
   * The window's part of giving a live session to another window (ADR-0080). The runtime's `detach` takes the tab's
   * gate, re-reads under it, drops this window's conversation and record of the session, releases the claim without
   * touching the process, and renders the read-only view with its note. What stays here: forget what this window
   * remembered of the run, repaint, and tell the user which window asked.
   */
  async function handOverSession(
    index: SessionIndex,
    request: { readonly tabId: string; readonly incarnation: string; readonly binding: string | null },
    asker: string,
  ): Promise<HandOverResult> {
    const s = windowState();
    const { tabId } = request;
    const title = index.get(tabId)?.title ?? null;
    const result = await s.sessionRuntime.detach({ conversation: tabId, incarnation: request.incarnation, binding: request.binding });
    if (result.status === "refused") {
      log.info(`tab ${tabId}: handover refused (${result.code})`);
      return { status: "refused", code: result.code };
    }
    if (result.status === "failed") {
      log.error(`tab ${tabId}: handover could not release the claim (still held here: ${result.stillHeld})`);
      refreshGuestContext();
      refreshLauncher({ ownership: true });
      return { status: "unfinished" };
    }
    log.info(`tab ${tabId}: handed over to window "${asker}"; the process was not stopped`);
    s.outcomes.delete(tabId);
    forgetTurnActivity(index, tabId);
    s.routing.publishSnapshot();
    refreshGuestContext();
    refreshLauncher({ ownership: true });
    showInfo(`The session${title === null ? "" : ` "${title}"`} was moved to ${asker.length === 0 ? "another window" : `the window "${asker}"`}, which asked for it. It keeps running there.`);
    return { status: "moved" };
  }

  // Panels and the guest link

  /**
   * Publish this window's editor as the conversation's controller, now that it holds it.
   *
   * A panel is bound before its native attempt (the editor has to exist first), so its
   * initial durable binding is refused as passive: nothing about this window proves it
   * owns the row yet. Once the attempt finished — a launch, an adoption, an attach — the
   * claim is this window's, and this is where the durable election happens. Re-publishing
   * the same role is a no-op in the shared record, and a window whose claim was refused
   * never gets here, which is what keeps an incumbent's binding intact.
   */
  async function electLocalController(index: SessionIndex, tabId: string): Promise<void> {
    const slot = localSlotFor(tabId);
    if (slot === null) return;
    await trackElection(slot, (async () => {
      try {
        const binding = await index.bindEditorSlot(slot, tabId, "controlling");
        if (binding.role === "controlling" && binding.tabId === tabId) {
          bindSlotToConversation(slot, tabId, "controlling", null);
          applySlotAuthority(slot);
        }
      } catch (error) {
        log.warn(`tab ${tabId}: its editor-slot role could not be published (${messageOf(error)})`);
      }
    })());
  }

  /**
   * Make this window's local editor roles match the durable bindings.
   *
   * The local registry decides who may act, and the durable binding is the shared answer to
   * the same question; a slot whose recorded role no longer matches is re-registered with
   * the recorded one (and a slot with no binding at all becomes passive), which is what
   * fences a demoted editor's bridge route and terminal input.
   */
  function reconcileLocalRoles(index: SessionIndex): void {
    const s = windowState();
    for (const entry of s.editorSlots.entries()) {
      const binding = index.slotBinding(entry.slotId);
      const durable: EditorSlotRole = binding?.role ?? "passive";
      if (entry.role === durable) continue;
      bindSlotToConversation(
        entry.slotId,
        entry.tabId,
        durable,
        durable === "passive" ? (binding?.roleRefusal ?? PASSIVE_REASON_DEFAULT) : null,
      );
    }
  }

  /** The editor slot this window currently shows a conversation in, or `null`. */
  function localSlotFor(tabId: string): string | null {
    const s = windowState();
    for (const entry of s.editorSlots.entries()) {
      if (entry.tabId !== tabId) continue;
      if ((s.tabs.get(entry.slotId)?.panel ?? null) !== null) return entry.slotId;
    }
    const state = s.tabs.get(tabId);
    return state !== undefined && state.panel !== null ? state.slotId : null;
  }

  /**
   * Reserve one editor for one conversation, letting a committed controller take a
   * passive incumbent's place.
   *
   * A restart lists editors in no promised order, so a stopped editor durably bound
   * *passive* to a conversation must not win it and lock out the editor the durable
   * binding names as its controller. Only the committed role decides; nothing here
   * guesses a role that was never recorded.
   */
  function reserveSlotForConversation(
    index: SessionIndex,
    conversation: string,
    slot: string,
    provenance: "saved" | "transient",
  ) {
    const s = windowState();
    const first = s.bridgeEditors.reserve({ tabId: conversation, editorId: slot, provenance, sequence: ++s.editorEventSequence });
    if (first.outcome !== "lost") return first;
    const incumbent = first.reservation.editorId;
    if (index.slotBinding(slot)?.role !== "controlling" || index.slotBinding(incumbent)?.role !== "passive") return first;
    s.bridgeEditors.releaseEditor(incumbent);
    return s.bridgeEditors.reserve({ tabId: conversation, editorId: slot, provenance, sequence: ++s.editorEventSequence });
  }

  /**
   * Make sure a ready panel's tab has a conversation to show.
   *
   * A panel VS Code restored can announce itself long after the pass that restored the row
   * finished. The conversation is the host's and outlives any panel, so a row this window runs
   * already has one; a row it does not run gets the bounded explanation of its last outcome, or
   * its saved history read-only, so a restored editor never waits on a process.
   */
  function replayPanelOutcome(index: SessionIndex, tabId: string): void {
    const s = windowState();
    if (s.sessionRuntime.conversations.has(tabId)) {
      attachChatRoutes(tabId);
      return;
    }
    const outcome = s.outcomes.get(tabId) ?? null;
    if (outcome !== null && outcome.status !== "restored" && outcome.status !== "attached" && outcome.status !== "skipped") {
      presentRestoreOutcome(index, tabId, outcome);
      return;
    }
    const entry = index.get(tabId);
    if (entry === null) return;
    if (entry.sessionFile !== null) {
      void s.sessionRuntime.conversations
        .showViewOnly(tabId, { file: entry.sessionFile, cwd: entry.cwd, title: entry.title, reason: "Restoring the session…", phase: "resyncing" })
        .then(() => {
          if (s.sessionRuntime.conversations.kindOf(tabId) === "view-only") attachChatRoutes(tabId, true);
        });
      return;
    }
    s.guestDispatcher.presentUnavailable(index, tabId, DRAFT_NO_HOST_DETAIL);
  }

  /**
   * Project one restore pass's own result into the conversations of the rows it considered.
   *
   * Nothing is created, revealed or focused here. A row this window now runs already has its
   * live conversation; a bounded refusal, failure, stopped row or draft shows its reason (with
   * saved history when the row has a file), and a row an earlier build's host may still own is
   * a legacy tab that explains itself.
   */
  function projectRestoreReport(index: SessionIndex, report: RestoreReport): void {
    for (const session of [...report.restored, ...report.attached]) attachChatRoutes(session.tabId, true);
    for (const blocked of report.conflicts) presentConflict(index, blocked.tabId, blocked.detail);
    for (const failure of report.failures) windowState().guestDispatcher.presentUnavailable(index, failure.tabId, failure.detail);
    for (const draft of report.drafts) windowState().guestDispatcher.presentUnavailable(index, draft.tabId, DRAFT_NO_HOST_DETAIL);
    for (const stopped of report.stopped) windowState().guestDispatcher.presentUnavailable(index, stopped.tabId, stopped.detail);
  }

  async function setActiveTab(index: SessionIndex, tabId: string): Promise<void> {
    try {
      await index.setActiveTab(tabId);
    } catch (error) {
      log.warn(`tab ${tabId}: could not record the active tab: ${messageOf(error)}`);
    }
    windowState().usageStatus?.update();
  }

  // Chat pages: the routes that show a host-owned conversation

  function panelPageId(panel: vscode.WebviewPanel): string {
    const s = windowState();
    let id = s.panelPageIds.get(panel);
    if (id === undefined) {
      s.panelPageSequence += 1;
      id = `panel-${s.panelPageSequence}`;
      s.panelPageIds.set(panel, id);
    }
    return id;
  }

  /** The Webview `postMessage` route of one panel. */
  function panelChatPage(state: TabState, panel: vscode.WebviewPanel): ChatPage {
    const s = windowState();
    return {
      id: panelPageId(panel),
      readOnlyReason: () => sessionAdmissionReason(state),
      post: message => {
        // A replaced or closed panel must not receive a conversation meant for the editor
        // that now holds the slot.
        if (s.tabs.get(state.slotId)?.panel !== panel) return "dropped";
        void panel.webview.postMessage(message);
        return "sent";
      },
    };
  }

  /** The bridge route of one surviving page: host pushes ride the bridge's own frames. */
  function bridgeChatPage(bridge: NonNullable<TabState["bridge"]>, documentId: string): ChatPage {
    const s = windowState();
    return {
      id: `bridge-${documentId}`,
      maxChunkBytes: BRIDGE_CHAT_CHUNK_BYTES,
      readOnlyReason: () => { const state = s.tabs.get(bridge.editorId); return state === undefined ? PASSIVE_REASON_DEFAULT : sessionAdmissionReason(state); },
      postSnapshot: messages => bridge.endpoint.pushSnapshot(documentId, messages) ? "sent" : "dropped",
      post: message => {
        // One frame carries at most the bridge's plaintext ceiling. A larger message is
        // refused, not truncated: the conversation then re-sends an authoritative snapshot
        // in chunks that fit.
        if (Buffer.byteLength(JSON.stringify(asciiJsonText(message)), "utf8") > BRIDGE_CHAT_MESSAGE_LIMIT) return "too-large";
        return bridge.endpoint.pushTerminal(documentId, message) ? "sent" : "dropped";
      },
    };
  }

  /**
   * Point one editor slot's conversation at the route that reaches its page now.
   *
   * The panel route wins whenever this host holds the panel handle; a surviving page whose
   * handle a restarted host no longer has is reached over its authenticated bridge session.
   * The conversation sends the state and an authoritative snapshot when a route attaches, so
   * a route that is already the current one is left alone unless `force` says the page asked
   * (`omp:ready`) — a reloaded document has an empty model and needs the snapshot again.
   */
  function attachChatRoute(slot: string, force = false): void {
    const s = windowState();
    const state = s.tabs.get(slot);
    if (state === undefined || state.tabId === null) return;
    let desired: { readonly id: string; readonly page: ChatPage } | null = null;
    const panel = state.panel;
    if (panel !== null) {
      desired = { id: panelPageId(panel), page: panelChatPage(state, panel) };
    } else if (state.bridge !== null && state.bridge.documentId !== null) {
      const bridge = state.bridge;
      const documentId = bridge.documentId as string;
      const route = bridge.endpoint.routeFor(documentId);
      // Authentication alone does not prove that a surviving older page can consume
      // snapshot fragments. Its connection and acknowledged route must announce v9.
      if (bridge.endpoint.guestVersionAccepted(documentId)
        && (route?.state === "BRIDGE_READY" || route?.state === "BRIDGE_AUTHENTICATED_WAITING")) {
        desired = { id: `bridge-${documentId}`, page: bridgeChatPage(bridge, documentId) };
      }
    }
    if (!force && state.chatPageId === (desired?.id ?? null)) return;
    state.chatDetach?.();
    state.chatDetach = null;
    state.chatPageId = null;
    if (desired === null) return;
    state.chatPageId = desired.id;
    state.chatDetach = s.sessionRuntime.conversations.attachPage(state.tabId, desired.page);
    publishFooterMetadata(state.tabId);
  }

  /** Point every editor showing one conversation at its route (after its host or view changed). */
  function attachChatRoutes(tabId: string, force = false): void {
    const s = windowState();
    for (const [slot, state] of s.tabs) {
      if (state.tabId === tabId) attachChatRoute(slot, force);
    }
  }

  /**
   * Answer one admitted request that arrived over the bridge.
   *
   * The listener already fenced the frame to this document and this host generation;
   * what is left here is policy: the action must be one the bridge is allowed to
   * carry, a mutation must reserve the document's own sequence, and the answer is the
   * same DTO the panel route would have received, so the page applies one contract
   * whichever route carried it.
   */
  function handleBridgeRequest(
    editorId: string,
    documentId: string,
    session: BridgeSession,
    request: BridgeAdmittedRequest,
  ): void {
    const s = windowState();
    // Resolved by the *editor*, never by the conversation the endpoint was created
    // for: a settled switch moves the conversation under this editor, and the request
    // must be answered for what the editor serves now — the endpoint's namespace T
    // never selects native authority again.
    const state = s.tabs.get(editorId);
    const bridge = state?.bridge ?? null;
    if (state === undefined || bridge === null || bridge.editorId !== editorId || bridge.documentId !== documentId) {
      session.reply(request.requestId, { type: "omp:error", message: "This document is no longer served.", code: "not-hosted" });
      return;
    }
    if (!bridge.endpoint.guestVersionAccepted(documentId)) {
      session.reply(request.requestId, { type: "omp:error", message: BRIDGE_GUEST_RELOAD_REASON, code: "guest-version" });
      return;
    }
    const tabId = state.tabId;
    if (tabId === null) {
      session.reply(request.requestId, { type: "omp:error", message: "This document is no longer served.", code: "not-hosted" });
      return;
    }
    const route = windowState().bridgeHost.routeOf(editorId);
    const payload = typeof request.payload === "object" && request.payload !== null ? request.payload : null;
    if (route === null || payload === null) {
      session.reply(request.requestId, { type: "omp:error", message: "This document has no route.", code: "not-hosted" });
      return;
    }
    const table = s.indexForBridge;
    if (table === null || BRIDGE_OPERATIONS[request.operation] !== true) {
      // Only the listed controls/chat/terminal exchanges are carried, and this
      // window needs its current index to answer them. Nothing else is admitted.
      refuseBridgeRequest(session, route.routeGeneration, request.requestId);
      return;
    }
    if (request.operation === "provider-login") {
      const parsed = parseGuestWebviewMessage({ ...payload, type: "omp:chat-command" });
      if (parsed?.type !== "omp:chat-command" || parsed.command !== "provider-login" ||
        s.context === undefined || (route.state !== "BRIDGE_READY" && route.state !== "BRIDGE_AUTHENTICATED_WAITING")) {
        refuseBridgeRequest(session, route.routeGeneration, request.requestId);
        return;
      }
      // Opening native login changes no session writer; the exact current authenticated
      // document may request it while Chat is stopped. Passive editors retain panel-only login.
      void runChatAction(s.context, table, tabId, parsed.command)
        .then(() => session.reply(request.requestId, null))
        .catch(() => refuseBridgeRequest(session, route.routeGeneration, request.requestId));
      return;
    }
    if (request.operation === "terminal-copy-reply") {
      const parsed = parseGuestWebviewMessage({ ...(payload as Record<string, unknown>), type: "omp:terminal-copy-reply" });
      if (parsed?.type !== "omp:terminal-copy-reply") {
        refuseBridgeRequest(session, route.routeGeneration, request.requestId);
        return;
      }
      // Current acknowledged document and host-issued nonce suffice. Reading a passive
      // or stopped screen needs neither live runtime authority nor MutationReservation.
      void acceptTerminalCopy(state, parsed).then(() => session.reply(request.requestId, null))
        .catch(() => refuseBridgeRequest(session, route.routeGeneration, request.requestId));
      return;
    }
    if (request.operation === "chat-subagent-read" || request.operation === "chat-magic-keywords-read" ||
        request.operation === "terminal-link-validate" || request.operation === "terminal-link-symbols" || request.operation === "terminal-link-open") {
      // Child history, the magic-keywords query and local file navigation are presentation,
      // not writer mutations. The authenticated current document still owns the
      // request; runtime epoch and post-I/O document checks remain authoritative.
      const parsed = parseGuestWebviewMessage({ ...(payload as Record<string, unknown>), type: `omp:${request.operation}` });
      const terminal = request.operation.startsWith("terminal-link-");
      if (parsed === null || (route.state !== "BRIDGE_READY" && route.state !== "BRIDGE_AUTHENTICATED_WAITING")) {
        refuseBridgeRequest(session, route.routeGeneration, request.requestId);
        return;
      }
      const handled = terminal
        ? handleTerminalGuestMessage(editorId, parsed, parsed as unknown as Record<string, unknown>)
        : s.guestDispatcher.runChatCommand(tabId, parsed as ChatWebviewMessage, bridgeChatPage(bridge, documentId));
      void handled.then(() => session.reply(request.requestId, null))
        .catch(() => refuseBridgeRequest(session, route.routeGeneration, request.requestId));
      return;
    }
    if (request.operation.startsWith("terminal-")) {
      const object = payload as Record<string, unknown>;
      const parsed = parseGuestWebviewMessage({ ...object, type: `omp:${request.operation}` });
      if (parsed === null || !route.dispatchable || hostOf(state)?.kind !== "terminal" || state.mode !== "terminal" || windowState().bridgeHost.liveBinding(tabId) === null) {
        refuseBridgeRequest(session, route.routeGeneration, request.requestId);
        return;
      }
      void handleTerminalGuestMessage(editorId, parsed, parsed as unknown as Record<string, unknown>)
        .then(() => session.reply(request.requestId, null))
        .catch(() => refuseBridgeRequest(session, route.routeGeneration, request.requestId));
      return;
    }
    const responder = bridgeResponder(tabId, documentId, route, session, request);
    if (responder === null) {
      refuseBridgeRequest(session, route.routeGeneration, request.requestId);
      return;
    }
    const chatType = BRIDGE_CHAT_OPERATION_TYPE[request.operation];
    if (chatType !== undefined) {
      // A chat command is not a control mutation: it takes no control sequence and is
      // deduplicated by its own request id inside the conversation, so a replay over either
      // route cannot run twice. Transport acknowledgement only correlates the frame; text
      // admission is reported separately by request id. The payload is validated by the same boundary
      // the panel route uses, so one contract serves both transports — and only a route that
      // may dispatch carries a command at all.
      const object = typeof request.payload === "object" && request.payload !== null ? request.payload : {};
      const parsed = parseGuestWebviewMessage({ ...(object as Record<string, unknown>), type: chatType });
      if (parsed === null || !route.dispatchable) {
        log.warn(
          `tab ${tabId}: a bridge ${chatType} was refused (${parsed === null ? "the payload was not a valid chat command" : "this route cannot dispatch: the native side is not verified for this document"})`,
        );
        if (parsed !== null) s.guestDispatcher.replyChatSendResult(tabId, parsed as ChatWebviewMessage, bridgeChatPage(bridge, documentId), "refused");
        refuseBridgeRequest(session, route.routeGeneration, request.requestId);
        return;
      }
      void s.guestDispatcher.runChatCommand(tabId, parsed as ChatWebviewMessage, bridgeChatPage(bridge, documentId))
        .then(() => session.reply(request.requestId, null))
        .catch(() => {
          log.warn(`tab ${tabId}: a bridge chat command could not be processed`);
          session.reply(request.requestId, null);
        });
      return;
    }
    void handleGuestMessageOverBridge(table, tabId, responder, payload).catch(() => {
      log.warn(`tab ${tabId}: a bridge request could not be processed`);
    });
  }

  /**
   * Refuse one bridge request without inventing an answer.
   *
   * The reservation is released, so the connection can carry the next request. The
   * payload is deliberately not a host message — the page drops what it cannot parse —
   * and the *invalidation* is what the user sees: the surface that asked reports its own
   * bounded "no answer" state and offers the ordinary Refresh, which is the truthful
   * outcome for a request this host would not run.
   */
  function refuseBridgeRequest(session: BridgeSession, routeGeneration: string | null, requestId: string): void {
    session.reply(requestId, null);
    if (routeGeneration !== null) session.send("invalidate", { routeGeneration });
  }

  /**
   * Answer one bridge request out of the ordinary guest vocabulary.
   *
   * The bridge deliberately carries a smaller set of exchanges than the panel, so the
   * payload is validated with the same boundary the panel route uses and then
   * restricted to the two exchanges the restarted host can serve without a panel
   * handle. Everything else is refused, which is what keeps a page from believing an
   * exchange arrived that never will.
   */
  async function handleGuestMessageOverBridge(
    index: SessionIndex,
    tabId: string,
    responder: GuestResponder,
    payload: unknown,
  ): Promise<void> {
    const parsed = parseGuestWebviewMessage(payload);
    if (parsed === null) {
      responder.invalidate();
      return;
    }
    switch (parsed.type) {
      case "omp:control-request":
        await handleGuestControlRequest(index, tabId, parsed, responder);
        return;
      default:
        // Every other exchange needs the editor's panel handle, which a restarted host
        // does not have: the page is told its controls are stale instead of receiving a
        // fabricated state.
        responder.invalidate();
        return;
    }
  }

  /** The responder that lets the ordinary control/tool handlers answer over the bridge. */
  function bridgeResponder(
    tabId: string,
    documentId: string,
    route: BridgeDocumentRoute,
    session: BridgeSession,
    request: BridgeAdmittedRequest,
  ): GuestResponder | null {
    if (!route.isCurrentRoute(request.routeGeneration) || !route.acknowledged) return null;
    return {
      live: () => {
        const state = stateOf(tabId);
        return state?.bridge?.documentId === documentId && route.isCurrentRoute(request.routeGeneration) && session.state === "authenticated";
      },
      reply: message => {
        session.reply(request.requestId, message);
      },
      admit: input => {
        // The reservation is taken synchronously with the request the page sent, so a
        // duplicate — from this route, the panel route or a replay — cannot reserve the
        // same sequence again.
        return admitBridgeMutation(tabId, route, request, input);
      },
      invalidate: () => {
        session.send("invalidate", { routeGeneration: request.routeGeneration });
      },
    };
  }

  /**
   * Reserve one bridge mutation and hand back the fence the native send re-checks.
   *
   * The sequence is the document's own, the request id is minted once per
   * reservation, and the reservation is what a queued send verifies immediately
   * before its first byte — so a route change, a close or a supersession that happens
   * while the request waits cancels it instead of running against a state the user can
   * no longer see.
   */
  function admitBridgeMutation(
    tabId: string,
    route: BridgeDocumentRoute,
    request: BridgeAdmittedRequest,
    mutation: { readonly operation: string; readonly payload: unknown },
  ): MutationAdmission | null {
    const state = stateOf(tabId);
    if (state === undefined || state.bridge === null) return null;
    let reservation: BridgeReservation;
    try {
      reservation = route.admit({
        routeGeneration: request.routeGeneration,
        actionSeq: request.actionSeq,
        operation: mutation.operation,
        payload: mutation.payload,
      });
    } catch (error) {
      log.warn(`tab ${tabId}: a bridge mutation was not admitted (${error instanceof BridgeAdmissionError ? error.code : "refused"})`);
      return null;
    }
    return {
      nativeRequestId: reservation.nativeRequestId,
      fence: () => reservation.verify(),
      settle: outcome => reservation.settle(outcome),
    };
  }

  // Guest activity: notifications, the stop binding, and usage readings

  /** The actual active OMP editor, not another visible editor in a split group. */
  function activePanelTab(): (TabState & { tabId: string; panel: vscode.WebviewPanel }) | null {
    const s = windowState();
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (!(input instanceof vscode.TabInputWebview)) return null;
    const identity = tabInputIdentity(input.viewType);
    if (identity === null) return null;
    const state = s.tabs.get(identity.editorIdHex);
    if (state?.tabId == null || state.panel?.active !== true || !isSessionTab(state.slotId)) return null;
    return state as TabState & { tabId: string; panel: vscode.WebviewPanel };
  }

  async function switchActiveSessionView(context: vscode.ExtensionContext, index: SessionIndex, mode: SessionViewMode): Promise<void> {
    const state = activePanelTab();
    if (state === null) {
      showWarning("No OMP session editor is active.");
      return;
    }
    state.panel.reveal(undefined, false);
    await windowState().sessionFlows.switchSessionMode(context, index, state, mode);
  }

  function forgetTerminalCopy(state: TabState): void {
    const s = windowState();
    const pending = s.terminalCopyRequests.get(state);
    if (pending !== undefined) clearTimeout(pending.timer);
    s.terminalCopyRequests.delete(state);
  }

  function copyActiveTerminalScreen(): void {
    const s = windowState();
    const state = activePanelTab();
    if (state === null || state.mode !== "terminal" || state.document?.kind !== "guest" || state.pipeline === null) {
      showWarning("No native OMP screen is available in the active editor.");
      return;
    }
    forgetTerminalCopy(state);
    const nonce = encodeHex(randomBytes(16));
    const timer = setTimeout(() => {
      if (s.terminalCopyRequests.get(state)?.nonce !== nonce) return;
      forgetTerminalCopy(state);
      showWarning("The native screen did not answer the copy request. Nothing was copied.");
    }, 3_000);
    s.terminalCopyRequests.set(state, {
      nonce, panel: state.panel, document: state.document, bridgeDocumentId: state.bridge?.documentId ?? null,
      generation: state.pipeline.generation, deadline: Date.now() + 3_000, timer,
    });
    void state.panel.webview.postMessage({ type: "omp:terminal-copy-request", requestId: nonce } satisfies GuestTerminalCopyRequestMessage);
  }

  /**
   * `OMP Desk: Redraw Terminal`: ask the native OMP program in the active editor to repaint its own
   * screen (the resize nudge a reattach performs), for the moments its renderer and the terminal
   * disagree about rows. Native OMP panes only; a folder shell is never nudged. Failure is said
   * plainly and nothing is rewritten or hidden.
   */
  function redrawActiveTerminal(): void {
    const state = activePanelTab();
    if (state === null || state.mode !== "terminal" || state.document?.kind !== "guest" || state.pipeline === null || state.shellSlot !== null) {
      showWarning("No native OMP terminal is available in the active editor.");
      return;
    }
    void state.pipeline.redrawNow().then(redrawn => {
      if (!redrawn) showWarning("OMP's terminal cannot be repainted now: it must be visible and own the session's input. Click into the terminal and try again.");
    });
  }

  async function acceptTerminalCopy(state: TabState, reply: GuestTerminalCopyReplyMessage): Promise<void> {
    const s = windowState();
    const pending = s.terminalCopyRequests.get(state);
    if (pending === undefined || pending.nonce !== reply.requestId) return;
    // Consume before the asynchronous clipboard operation: one user request, one write.
    forgetTerminalCopy(state);
    if (Date.now() > pending.deadline || state.panel !== pending.panel || state.document !== pending.document
      || (state.bridge?.documentId ?? null) !== pending.bridgeDocumentId || state.mode !== "terminal"
      || state.pipeline?.generation !== pending.generation || reply.generation !== pending.generation) {
      showWarning("The native screen changed before its copy reply. Nothing was copied.");
      return;
    }
    if (reply.text === null) {
      showWarning("The native screen and scrollback exceed the bounded copy reply. Nothing was copied.");
      return;
    }
    try {
      await vscode.env.clipboard.writeText(reply.text);
      vscode.window.setStatusBarMessage("OMP Desk: Native screen and scrollback copied.", 3_000);
    } catch {
      showWarning("The clipboard refused the native screen copy.");
    }
  }

  /** The panel a command should act on: the showing one, else the index's active tab. */
  function actionTargetTab(index: SessionIndex): { tabId: string; panel: vscode.WebviewPanel } | null {
    const active = activePanelTab();
    if (active !== null) return active;
    const tabId = index.activeTabId;
    if (tabId === null) return null;
    const panel = stateOf(tabId)?.panel ?? null;
    return panel === null ? null : { tabId, panel };
  }

  /**
   * Ask the showing panel's UI to run one of its own actions.
   *
   * The panel decides whether the action applies: it dispatches into the same
   * composer handlers its buttons use, so a keybinding cannot send a draft the
   * Send button would refuse, or stop a turn that has already ended. Nothing here
   * starts a host, opens a claim or writes to a session.
   */
  function postPanelAction(action: GuestPanelAction): void {
    const target = activePanelTab();
    // A non-controlling editor must not be able to send a prompt or stop a turn
    // through this extension either — including through its own keybinding.
    const refused = target === null ? null : passiveReasonForSlot(target.slotId);
    if (refused !== null) {
      showWarning(`${refused} The action was not sent.`);
      return;
    }
    if (target === null) {
      showWarning(
        "No OMP session editor is active, so there is nothing for this command to send, stop or focus.",
      );
      return;
    }
    const message: GuestPanelActionMessage = { type: "omp:webview-action", action };
    void target.panel.webview.postMessage(message);
    log.debug(`tab ${target.tabId}: ${action} asked from a VS Code command or keybinding`);
  }

  // Chat quick actions (ADR-0052): the TUI's retry, history search, compaction, cycling, export and share,
  // run for one Chat's live conversation with VS Code's own consent UI. None of them starts a host.

  /** The active Chat editor's tab, or `null` after saying why there is none (or why it may not act). */
  function activeChatTab(): string | null {
    const target = activePanelTab();
    const refused = target === null ? null : passiveReasonForSlot(target.slotId);
    if (refused !== null) {
      showWarning(`${refused} The action was not run.`);
      return null;
    }
    if (target === null || target.mode !== "chat") {
      showWarning("No Chat editor is active, so there is nothing for this command to act on.");
      return null;
    }
    return target.tabId;
  }

  /** Ask the active Chat editor's own composer to run one of its actions (retry, thinking or tools toggle). */
  function postChatPanelAction(action: GuestPanelAction): void {
    if (activeChatTab() !== null) postPanelAction(action);
  }

  /**
   * Open the find bar of the active Chat editor's transcript. Searching writes nothing, so a view-only editor may do it too
   * (the other panel actions refuse there). `Ctrl+F` reaches here through the contributed keybinding, and the page takes the same press itself
   * too; the page ignores the second arrival when its field already has the focus.
   */
  function findInChat(): void {
    const target = activePanelTab();
    if (target === null || target.mode !== "chat") {
      showWarning("No Chat editor is active, so there is nothing to search.");
      return;
    }
    const message: GuestPanelActionMessage = { type: "omp:webview-action", action: "find-in-chat" };
    void target.panel.webview.postMessage(message);
    log.debug(`tab ${target.tabId}: find-in-chat asked from a VS Code command`);
  }

  /** Run one {@link GuestChatCommand} for the active Chat editor, from the command palette or a keybinding. */
  function runActiveChatAction(context: vscode.ExtensionContext, index: SessionIndex, command: GuestChatCommand): void {
    const tabId = activeChatTab();
    if (tabId !== null) void runChatAction(context, index, tabId, command);
  }

  function chatRefusalText(reason: SendRefusal): string {
    return reason === "busy" ? "OMP is busy with another request; try again in a moment." : reason === "not-live" || reason === "not-owner" ? "This conversation is not accepting commands right now." : "OMP did not accept the command.";
  }

  /** A maintenance pass's outcome. Its report already shows in the conversation; only a refusal or silence needs a warning. */
  function reportMaintenance(result: CommandResult<string>, notDone: string): void {
    if (result.status === "refused") showWarning(`${notDone} ${chatRefusalText(result.reason)}`);
    else if (result.status === "unconfirmed") showWarning("OMP did not report the outcome of the command.");
  }

  /**
   * One Chat action for `tabId`'s live conversation. Every action that sends or uploads anything asks first in
   * VS Code's own UI (an InputBox, a save dialog, a modal confirmation); cycling is one explicit keypress, as in
   * the TUI. Outcomes are reported here; progress shows in the conversation itself.
   */
  async function runChatAction(context: vscode.ExtensionContext, index: SessionIndex, tabId: string, command: GuestChatCommand): Promise<void> {
    const s = windowState();
    if (command === "provider-login") {
      const entry = index.get(tabId);
      // The flow runs for minutes: the Chat request that asked for it is answered now, not when the sign-in ends.
      void openProviderLogin(index, hostOf(stateOf(tabId)) ?? null, entry?.scope.profile ?? null,
        entry?.cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir());
      return;
    }
    if (command === "provider-logout") {
      const entry = index.get(tabId);
      void openProviderLogout(index, hostOf(stateOf(tabId)) ?? null, entry?.scope.profile ?? null,
        entry?.cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir());
      return;
    }
    if (command === "keyboard-shortcuts" || command === "source-control" || command === "tools-view") {
      // Desk's own views for the terminal-only /hotkeys, /git and /skills; none of them needs a live conversation.
      await runDeskSlashAction(command);
      return;
    }
    const conversations = s.sessionRuntime.conversations;
    const live = conversations.liveOf(tabId);
    if (live === null || live.phase !== "live") {
      showWarning("This conversation is not live, so the action was not run.");
      return;
    }
    const { incarnation } = live;
    const current = (): boolean => liveAt(tabId, incarnation)?.phase === "live";
    switch (command) {
      case "compact": {
        const running = live.working;
        // OMP's `/compact` modes (session/compact-modes.ts); the first is preselected, so Enter runs the default.
        const modes: (vscode.QuickPickItem & { mode: CompactMode })[] = [
          { mode: "snapcompact", label: "snapcompact", description: "default", detail: "Archive the earlier conversation onto dense images the model reads back. No model call." },
          { mode: "soft", label: "soft", detail: "Summarize the earlier conversation locally with the active model." },
          { mode: "remote", label: "remote", detail: "Summarize through the provider's server compaction, then fall back to a local summary." },
        ];
        const picked = await vscode.window.showQuickPick(modes, {
          title: "Compact Conversation",
          placeHolder: `How OMP frees context${running ? "; the running turn is interrupted and continues afterwards" : ""}`,
          ignoreFocusOut: true,
        });
        if (picked === undefined || !current()) return;
        let instructions: string | undefined;
        if (picked.mode !== "snapcompact") {
          instructions = await vscode.window.showInputBox({
            title: `Compact Conversation (${picked.label})`,
            prompt: "Optionally say what the summary must keep.",
            placeHolder: "Optional instructions for the summary",
            ignoreFocusOut: true,
          });
          if (instructions === undefined || !current()) return;
        }
        const result = await conversations.maintain(tabId, incarnation, { kind: "compact", mode: picked.mode, ...(instructions === undefined ? {} : { instructions }) });
        if (result.status === "stale") return;
        reportMaintenance(result, "The conversation was not compacted.");
        return;
      }
      case "shake": {
        // OMP's `/shake` modes (slash-commands/builtin-lifecycle.ts); `elide` is OMP's default and preselected.
        const modes: (vscode.QuickPickItem & { mode: ShakeMode })[] = [
          { mode: "elide", label: "elide", description: "default", detail: "Strip tool results and large blocks from the context." },
          { mode: "images", label: "images", detail: "Strip image blocks from the context." },
          { mode: "thinking", label: "thinking", detail: "Drop all thinking blocks from the context." },
        ];
        const picked = await vscode.window.showQuickPick(modes, { title: "Shake Conversation", placeHolder: "What OMP drops from the context", ignoreFocusOut: true });
        if (picked === undefined || !current()) return;
        const result = await conversations.maintain(tabId, incarnation, { kind: "shake", mode: picked.mode });
        if (result.status === "stale") return;
        reportMaintenance(result, "The conversation was not shaken.");
        return;
      }
      case "cycle-model": {
        const result = await conversations.cycleModel(tabId, incarnation);
        if (result.status === "stale") return;
        if (result.status === "pending") vscode.window.setStatusBarMessage("OMP Desk: the model change applies as soon as OMP is ready", 4_000);
        else if (result.status === "refused") showWarning(`The model was not changed. ${chatRefusalText(result.reason)}`);
        else if (result.status === "unconfirmed") showWarning("OMP did not report whether the model changed.");
        else if (result.value === null) showInfo("OMP has no other model to cycle to. Configure model roles in OMP settings.");
        else vscode.window.setStatusBarMessage(`OMP Desk: model ${result.value.model.name ?? result.value.model.id}${result.value.thinkingLevel ? ` · ${result.value.thinkingLevel}` : ""}`, 4_000);
        return;
      }
      case "cycle-thinking": {
        const result = await conversations.cycleThinkingLevel(tabId, incarnation);
        if (result.status === "stale") return;
        if (result.status === "pending") vscode.window.setStatusBarMessage("OMP Desk: the thinking level change applies as soon as OMP is ready", 4_000);
        else if (result.status === "refused") showWarning(`The thinking level was not changed. ${chatRefusalText(result.reason)}`);
        else if (result.status === "unconfirmed") showWarning("OMP did not report whether the thinking level changed.");
        else if (result.value === null) showInfo("The current model has no thinking levels to cycle through.");
        else vscode.window.setStatusBarMessage(`OMP Desk: thinking level ${result.value}`, 4_000);
        return;
      }
      case "export-html": {
        const entry = index.get(tabId);
        const base = (entry?.title ?? "omp-session").replace(/[<>:"/\\|?*\u0000-\u001f]+/g, " ").trim().slice(0, 80) || "omp-session";
        const folder = entry?.cwd ?? context.globalStorageUri.fsPath;
        const target = await vscode.window.showSaveDialog({
          title: "Export Conversation as HTML",
          defaultUri: vscode.Uri.file(path.join(folder, `${base}.html`)),
          filters: { HTML: ["html"] },
        });
        if (target === undefined || !current()) return;
        const result = await pendingEntry("window", "export", { origin: "command", step: "working" }, () => conversations.exportHtml(tabId, incarnation, target.fsPath));
        if (result.status === "stale") return;
        if (result.status !== "ok") {
          showError(result.status === "refused" ? `The conversation was not exported. ${chatRefusalText(result.reason)}` : "OMP did not report whether the export was written.");
          return;
        }
        const written = vscode.Uri.file(result.value);
        const picked = await vscode.window.showInformationMessage(`OMP Desk: Exported the conversation to ${result.value}.`, "Open", "Reveal in File Explorer");
        if (picked === "Open") await vscode.env.openExternal(written);
        else if (picked === "Reveal in File Explorer") await vscode.commands.executeCommand("revealFileInOS", written);
        return;
      }
      case "share": {
        const picked = await vscode.window.showWarningMessage(
          "Share this conversation?",
          { modal: true, detail: "OMP uploads the whole transcript of this conversation — your messages, the agent's replies, tool calls and their output — as an encrypted share and posts the link in the conversation. Anyone with the link can read it." },
          "Upload and Share",
        );
        if (picked !== "Upload and Share" || !current()) return;
        const outcome = await conversations.prompt(tabId, incarnation, { requestId: createControlRequestId(), text: "/share" });
        if (outcome.status === "stale") return;
        if (outcome.status === "refused") showWarning(`Nothing was shared. ${chatRefusalText(outcome.reason)}`);
        else if (outcome.status === "unconfirmed") showWarning("OMP did not confirm the share command. It was not sent again.");
        return;
      }
    }
  }

  /** The Desk stand-in for a terminal-UI slash command typed into Chat (`host/slash-registry.ts`). */
  async function runDeskSlashAction(action: Exclude<DeskSlashAction, "omp-settings" | "new-session" | "delete-session" | "fork-session">): Promise<void> {
    switch (action) {
      case "keyboard-shortcuts":
        await showChatKeyboardShortcuts();
        return;
      case "source-control":
        await vscode.commands.executeCommand("workbench.view.scm");
        return;
      case "tools-view":
        await vscode.commands.executeCommand("ompDesk.tools.focus");
        return;
      case "provider-login":
        // The sign-in runs for minutes; the Chat request that typed /login is answered now.
        void Promise.resolve(vscode.commands.executeCommand("ompDesk.loginProvider")).catch(() => undefined);
        return;
      case "provider-logout":
        // Same route as /login: the palette command, which uses the active session's profile and directory.
        void Promise.resolve(vscode.commands.executeCommand("ompDesk.logoutProvider")).catch(() => undefined);
        return;
    }
    const exhaustive: never = action;
    throw new Error(`Unsupported Desk slash action: ${exhaustive}`);
  }

  async function showChatKeyboardShortcuts(): Promise<void> {
    await vscode.commands.executeCommand("workbench.action.openGlobalKeybindings", "ompDesk.");
  }

  function rememberedPrompts(): string[] {
    const s = windowState();
    const stored = s.context?.globalState.get<unknown>(PROMPT_HISTORY_KEY);
    return Array.isArray(stored) ? stored.filter((item): item is string => typeof item === "string") : [];
  }

  /** A file block's path text made absolute against the sending tab's folder (forward slashes, as the labels are), or left as it is. */
  function absoluteFileLabel(label: string, cwd: string | null): string {
    if (/^(?:[A-Za-z]:[\\/]|[\\/])/.test(label) || cwd === null) return label;
    return `${cwd.replaceAll("\\", "/").replace(/\/+$/, "")}/${label}`;
  }

  /**
   * Remembers an accepted prompt of `tabId` for the history search. A message that carried files is stored with each file block
   * reduced to its reference (the absolute path, or the bare name for a file that had none) and no text, so a message with large
   * files is still remembered within the bound.
   */
  function rememberPrompt(text: string, tabId: string): void {
    const s = windowState();
    const context = s.context;
    if (context === undefined || text.trim().length === 0 || text.trimStart().startsWith("/")) return;
    const cwd = s.sessionRuntime.records.get(tabId)?.runtime?.cwd ?? null;
    const stored = reduceFileBlocks(text, label => absoluteFileLabel(label, cwd));
    if (stored.length > MAX_REMEMBERED_PROMPT) return;
    const next = [stored, ...rememberedPrompts().filter(item => item !== stored)].slice(0, MAX_PROMPT_HISTORY);
    void context.globalState.update(PROMPT_HISTORY_KEY, next);
  }

  /**
   * The history search (`Ctrl+Alt+Y`; the TUI's `Ctrl+R`): a QuickPick of past prompts, this conversation's first (newest first), then the ones sent
   * from other Chats. The pick is added to the draft, never sent.
   */
  async function searchPromptHistory(): Promise<void> {
    const s = windowState();
    const tabId = activeChatTab();
    if (tabId === null) return;
    const proseOf = (text: string): string => splitFileBlocks(text).prose;
    const own = s.sessionRuntime.conversations.promptsOf(tabId).reverse();
    const seen = new Set(own.map(proseOf));
    const others = rememberedPrompts().filter(text => !seen.has(proseOf(text)));
    // A row shows the prose: a file's text is not what one searches for, and its lines are not the prompt's.
    const item = (text: string): vscode.QuickPickItem & { text: string } => {
      const prose = proseOf(text);
      const line = prose.split(/\r?\n/).find(part => part.trim().length > 0)?.trim() ?? prose.trim();
      const lines = prose.split(/\r?\n/).length;
      return { label: line.length > 120 ? `${line.slice(0, 119)}…` : line, ...(lines > 1 ? { description: `${lines} lines` } : {}), text };
    };
    const items: (vscode.QuickPickItem & { text?: string })[] = [
      ...(own.length > 0 ? [{ label: "This conversation", kind: vscode.QuickPickItemKind.Separator }, ...own.map(item)] : []),
      ...(others.length > 0 ? [{ label: "Other conversations", kind: vscode.QuickPickItemKind.Separator }, ...others.map(item)] : []),
    ];
    if (items.length === 0) {
      showInfo("No past prompts yet.");
      return;
    }
    const picked = await vscode.window.showQuickPick(items, { title: "Search Prompt History", placeHolder: "Type to filter; Enter adds the prompt to the draft without sending it", matchOnDescription: true });
    if (picked?.text === undefined) return;
    const recall = await s.guestDispatcher.recalledPrompt(tabId, picked.text);
    const panel = stateOf(tabId)?.panel;
    if (panel === undefined || panel === null) return;
    void panel.webview.postMessage(recall satisfies GuestRecallPromptMessage);
  }

  /**
   * "OMP Desk: Rewind Conversation…" (ADR-0051), the keyboard-only route to Chat's in-place Rewind: the loaded prompts of the
   * active Chat, newest first, with what leaves the branch, then Rewind or Rewind & summarize. The request is pinned to
   * the leaf the list was built from; the answer and the prompt go to the tab's writable editor routes, whose composer
   * takes the prompt to edit and send again. Files changed afterwards are named and never restored.
   */
  async function rewindConversation(): Promise<void> {
    const s = windowState();
    const tabId = activeChatTab();
    if (tabId === null) return;
    const read = s.sessionRuntime.conversations.rewindOf(tabId);
    if (read.status === "blocked") {
      showWarning(read.reason);
      return;
    }
    const leafId = read.leafId;
    if (read.choices.length === 0) {
      showInfo("There is no earlier message in this conversation to rewind to.");
      return;
    }
    const leaving = (choice: (typeof read.choices)[number]): string => {
      const preview = choice.leaving;
      if (preview === null) return "";
      const files = preview.files.length === 0 ? "" : ` · files changed after it stay as they are: ${preview.files.slice(0, 5).join(", ")}${preview.files.length > 5 ? `, +${preview.files.length - 5}` : ""}`;
      return `${preview.messages} message${preview.messages === 1 ? "" : "s"} leave this branch${files}`;
    };
    const picked = await vscode.window.showQuickPick(
      read.choices.map(choice => ({ label: choice.preview, description: new Date(choice.timestamp).toLocaleString(), detail: leaving(choice), id: choice.id })),
      { title: "Rewind Conversation", placeHolder: "Pick the message to rewind to; it returns to the composer to edit and send again", matchOnDescription: true },
    );
    if (picked === undefined) return;
    const how = await vscode.window.showQuickPick(
      [
        { label: "Rewind", detail: picked.detail, summarize: false },
        { label: "Rewind & summarize", detail: "Also keep a model-written summary of the abandoned messages", summarize: true },
      ],
      { title: `Rewind to: ${picked.label}`, placeHolder: "Nothing on disk is undone" },
    );
    if (how === undefined) return;
    const outcome = await s.sessionRuntime.conversations.navigate(tabId, { requestId: encodeHex(randomBytes(16)), kind: "rewind", targetId: picked.id, expectedLeafId: leafId, summarize: how.summarize }, null);
    if (outcome.status === "done") {
      if (outcome.raced) showInfo("Rewound, but OMP also changed the conversation meanwhile. Check the transcript.");
      return;
    }
    showWarning(NAVIGATE_REFUSAL_SENTENCES[outcome.status === "unconfirmed" ? "unconfirmed" : outcome.reason]);
  }

  function currentSlashRegistry(context: vscode.ExtensionContext): readonly BuiltinSlashEntry[] | null {
    const s = windowState();
    if (s.slashRegistryLoading === null && Date.now() - s.slashRegistryCheckedAt > SLASH_REGISTRY_RECHECK_MS) {
      s.slashRegistryLoading = loadSlashRegistry(context).finally(() => {
        s.slashRegistryCheckedAt = Date.now();
        s.slashRegistryLoading = null;
      });
    }
    return s.slashRegistry?.commands ?? null;
  }

  async function loadSlashRegistry(context: vscode.ExtensionContext): Promise<void> {
    const s = windowState();
    try {
      const bun = await resolveBunRuntime();
      const pkg = bun === null ? null : await resolveOmpPackageRoot(await resolveOmpBinary());
      if (bun === null || pkg === null) {
        s.slashRegistry = null;
        return;
      }
      const key = `${pkg.root}@${pkg.version ?? "unknown"}`;
      if (s.slashRegistry?.key === key || s.slashRegistryFailedKey === key) return;
      // Another install's commands must never classify this one, even when this one cannot be read.
      s.slashRegistry = null;
      s.slashRegistryFailedKey = key;
      const [helper] = await stageRuntimeAssets({ storageDir: context.globalStorageUri.fsPath, sourcePaths: [context.asAbsolutePath(SLASH_REGISTRY_HELPER)] });
      if (helper === undefined) return;
      const commands = await readSlashRegistry({ bunPath: bun, helperPath: helper.path, packageRoot: pkg.root, cwd: path.dirname(helper.path) });
      if (commands === null) {
        log.warn(`the slash-command registry of ${key} could not be read; terminal-only commands are not refused`);
        return;
      }
      s.slashRegistry = { key, commands };
      s.slashRegistryFailedKey = null;
      log.debug(`read ${commands.length} builtin slash commands from ${key}`);
    } catch (error) {
      log.warn(`the slash-command registry could not be read: ${messageOf(error)}`);
    }
  }

  /**
   * Whether the provider served another model than requested, for each pair, by the installed OMP's own classifier
   * (`media/served-model.mjs`). Nothing is read until a page asks; a failed read answers "unknown" and is read again next
   * time, while a successful one is remembered for the install (`host/served-model.ts`).
   */
  async function servedModelVerdicts(pairs: readonly ServedModelPair[]): Promise<ServedModelVerdict[]> {
    const s = windowState();
    const unknown = (): ServedModelVerdict[] => pairs.map(() => "unknown");
    const { context } = s;
    if (context === undefined) return unknown();
    try {
      const bun = await resolveBunRuntime();
      const pkg = bun === null ? null : await resolveOmpPackageRoot(await resolveOmpBinary());
      if (bun === null || pkg === null) return unknown();
      const key = `${pkg.root}@${pkg.version ?? "unknown"}`;
      return await s.servedModels.resolve(key, pairs, async missing => {
        const [helper] = await stageRuntimeAssets({ storageDir: context.globalStorageUri.fsPath, sourcePaths: [context.asAbsolutePath(SERVED_MODEL_HELPER)] });
        if (helper === undefined) return null;
        // A page asked for these verdicts: on-screen work, bounded with the window's other helpers (the reader has no cancel, so a closing window only stops waiting for it).
        const verdicts = await s.helpers.run({ label: "served-model check", class: "visible", run: () => readServedModels({ bunPath: bun, helperPath: helper.path, packageRoot: pkg.root, cwd: path.dirname(helper.path), pairs: missing }) });
        if (verdicts === null) log.warn(`the served-model verdicts of ${key} could not be read`);
        return verdicts;
      });
    } catch (error) {
      if (!isHelperCancelled(error)) log.warn(`the served-model verdicts could not be read: ${messageOf(error)}`);
      return unknown();
    }
  }

  /**
   * This window's turn notifier.
   *
   * Created once per index: its ledger is what makes "one notice per event" hold
   * across a Webview reload, another panel reporting at the same time, or the same
   * state being reported twice.
   */
  function notifierFor(index: SessionIndex): TurnNotifier {
    const s = windowState();
    if (s.turnNotifier === undefined || s.turnNotifier.index !== index) {
      s.turnNotifier = {
        index,
        notifier: new TurnNotifier({
          send: async (tabId, notice) => {
            if (vscode.env.uriScheme !== "vscode") {
              log.debug(`tab ${tabId}: desktop notification ${notice.kind} suppressed (unsupported-product).`);
              return;
            }
            const entry = index.get(tabId);
            if (entry === null || s.context === undefined) {
              log.warn(`tab ${tabId}: desktop notification ${notice.kind} failed (${entry === null ? "session-unavailable" : "host-unavailable"}).`);
              return;
            }
            const uri = vscode.Uri.from({
              scheme: vscode.env.uriScheme,
              authority: s.context.extension.id,
              path: "/reveal",
              query: new URLSearchParams({ session: tabId }).toString(),
            });
            const launchUri = await vscode.env.asExternalUri(uri);
            const reason = notice.kind === "turn-complete"
              ? "Finished — waiting for your input"
              : `Asks: ${notificationLine(notice.question) || "Your input is needed"}`;
            const submitted = await sendDesktopNotification({
              title: stateOf(tabId)?.panel?.title ?? sessionHeadline(entry, null),
              body: `${notificationLine(path.basename(entry.cwd), 60) || "Workspace"} — ${reason}`,
              launchUri: launchUri.toString(true),
            }, log);
            log.debug(`tab ${tabId}: desktop notification ${notice.kind} ${submitted === null ? "suppressed (unsupported-platform)" : "sent"}.`);
          },
          onError: (tabId, kind) => log.warn(`tab ${tabId}: desktop notification ${kind} failed (submission-failed).`),
          onSuppressed: logNotificationSuppression,
          onEarned: tabId => recordSessionEvent(index, tabId),
        }),
      };
    }
    return s.turnNotifier.notifier;
  }

  function logNotificationSuppression(tabId: string, kind: TurnNotice["kind"], reason: NotificationSuppression | "aborted"): void {
    log.debug(`tab ${tabId}: desktop notification ${kind} suppressed (${reason}).`);
  }

  function notificationSuppression(index: SessionIndex, tabId: string): NotificationSuppression | null {
    const active = editorInFrontConversation(index) === tabId;
    const visible = stateOf(tabId)?.panel?.visible ?? active;
    return desktopNotificationSuppression(
      vscode.workspace.getConfiguration("ompDesk").get<boolean>("desktopNotifications", true),
      vscode.window.state.focused,
      visible,
      active,
    );
  }

  /** Whether the user is looking at this session now. The desktop-notification setting does not matter here. */
  function sessionLookedAt(index: SessionIndex, tabId: string): boolean {
    const active = editorInFrontConversation(index) === tabId;
    return isLookedAt(vscode.window.state.focused, stateOf(tabId)?.panel?.visible ?? active, active);
  }

  /**
   * The agent finished a reply or asked a question. The session is unread from now on unless
   * the user is in front of its editor; the marker is persisted with the session index, so it
   * survives a window reload.
   */
  function recordSessionEvent(index: SessionIndex, tabId: string): void {
    const s = windowState();
    const entry = index.get(tabId);
    if (entry === null) return;
    const markers = markersAfterEvent(entry, sessionLookedAt(index, tabId), Date.now());
    void index.recordConversationState(tabId, markers).then(
      () => s.launcherProvider?.refresh(),
      error => log.warn(`tab ${tabId}: the unread marker could not be saved: ${messageOf(error)}`),
    );
  }

  /** The user is in front of a session's editor: what it said so far counts as read. */
  function settleViewedSession(index: SessionIndex): void {
    const s = windowState();
    const tabId = editorInFrontConversation(index);
    const entry = tabId === null ? null : index.get(tabId);
    if (tabId === null || entry === null || !sessionLookedAt(index, tabId)) return;
    const read = markersAfterViewing(entry);
    if (read === null) return;
    void index.recordConversationState(tabId, { lastSeenReplyId: read.lastSeenReplyId }).then(
      () => s.launcherProvider?.refresh(),
      error => log.warn(`tab ${tabId}: the unread marker could not be cleared: ${messageOf(error)}`),
    );
  }

  /**
   * Keep the context keys in step with the panel on screen, so the Stop keybinding is live
   * only where a stop has a subject it can name, and never where Escape has a nearer
   * meaning (an open `@`-completion popup).
   */
  function refreshGuestContext(): void {
    const s = windowState();
    const visible = activePanelTab();
    const activity = visible === null ? undefined : s.turnActivities.get(visible.tabId);
    const mode = visible?.mode ?? "";
    setDeskContext("ompDesk.sessionMode", mode);
    void vscode.commands.executeCommand("setContext", "ompDesk.sessionTransitionPending", visible !== null && (fencedOf(visible) || s.pendingSessionViewChanges.has(visible)));
    setDeskContext(STREAMING_CONTEXT, mode === "chat" && activity?.streaming === true);
    setDeskContext(COMPOSER_POPUP_CONTEXT, visible !== null && s.composerPopupTabs.has(visible.tabId));
  }

  function setSubagentWork(index: SessionIndex, tabId: string, active: boolean): void {
    const s = windowState();
    if ((s.subagentWork.get(tabId) ?? false) === active) return;
    if (active) s.subagentWork.set(tabId, true); else s.subagentWork.delete(tabId);
    const current = s.sessionRuntime.conversations.activityOf(tabId);
    if (current !== null) applyTurnActivity(index, tabId, current.observed, false);
  }

  function stopSubagentWatch(index: SessionIndex | null, tabId: string): void {
    const s = windowState();
    const timer = s.subagentWatches.get(tabId);
    if (timer !== undefined) clearInterval(timer);
    s.subagentWatches.delete(tabId);
    if (index !== null) setSubagentWork(index, tabId, false); else s.subagentWork.delete(tabId);
  }

  /** Ask a verified chat child for its registry subagents until the channel it was started on changes. */
  function watchSubagentWork(index: SessionIndex, tabId: string, client: HostControlClient): void {
    const s = windowState();
    stopSubagentWatch(null, tabId);
    let failures = 0;
    let inFlight = false;
    const timer = setInterval(() => {
      if (inFlight) return;
      if (controlOf(stateOf(tabId))?.client !== client || !isOpenControlClient(client)) { stopSubagentWatch(index, tabId); return; }
      inFlight = true;
      void client.subagentWork().then(active => {
        failures = 0;
        if (controlOf(stateOf(tabId))?.client === client) setSubagentWork(index, tabId, active);
      }, error => {
        if (++failures < SUBAGENT_WORK_MAX_FAILURES) return;
        log.warn(`tab ${tabId}: subagent work observation stopped (${describeControlError(error)})`);
        stopSubagentWatch(index, tabId);
      }).finally(() => { inFlight = false; });
    }, SUBAGENT_WORK_POLL_MS);
    timer.unref?.();
    s.subagentWatches.set(tabId, timer);
  }

  /**
   * Apply the host-observed turn state of one conversation.
   *
   * One source, two consumers: the notifier decides whether the user must be told about a
   * transition they could not see, and the context key decides whether the Stop keybinding
   * applies. The activity is projected by this window from the frames its own session reads,
   * so a hidden or closed tab notifies exactly like a visible one; `visible` is recomputed
   * here from the panel and the window state. `baseline` marks the first model after a
   * snapshot: it is remembered without raising a notice, so a snapshot replayed into a fresh
   * host is never read as a transition.
   */
  function applyTurnActivity(index: SessionIndex, tabId: string, observed: TurnActivityReport | null, baseline: boolean): void {
    const s = windowState();
    const previous = s.turnActivities.get(tabId) ?? null;
    const activity = observed !== null && s.subagentWork.get(tabId) === true ? withRegistrySubagentWork(observed) : observed;
    if (activity === null) {
      // A conversation that is not live has no turn to report; what it last said is dropped
      // so the next live report is a fresh baseline rather than a transition.
      s.turnActivities.delete(tabId);
      notifierFor(index).forget(tabId);
      refreshGuestContext();
      if (previous !== null) refreshLauncher();
      return;
    }
    s.turnActivities.set(tabId, activity);
    if (baseline || previous === null || previous.settled !== activity.settled) {
      log.debug(`tab ${tabId}: desktop notification Chat observation (${baseline ? "baseline" : "live"}; settled=${activity.settled}; prompt=${activity.promptStatus ?? "none"}; completion=${activity.completionOutcome ?? "none"}; pending=${activity.pendingRequest !== null}).`);
    }
    if (baseline) {
      notifierFor(index).baseline(tabId, activity);
    } else {
      notifierFor(index).observe(tabId, activity, notificationSuppression(index, tabId));
    }
    refreshGuestContext();
    if (previous === null || activitySignature(previous) !== activitySignature(activity)) refreshLauncher();
  }

  /** Drop everything this window remembered about a conversation that is gone. */
  function forgetTurnActivity(index: SessionIndex, tabId: string): void {
    const s = windowState();
    stopSubagentWatch(null, tabId);
    s.turnActivities.delete(tabId);
    s.composerPopupTabs.delete(tabId);
    s.footerBindings.get(tabId)?.observer?.dispose();
    cancelControlPicker(tabId);
    s.footerBindings.delete(tabId);
    s.usageStatus?.update();
    notifierFor(index).forget(tabId);
    refreshGuestContext();
  }

  // Chat host lifecycle events

  /** Phases in which a conversation's process is starting, attaching or serving. */
  function rpcPhaseIsRunning(phase: ChatPhase): boolean {
    return phase === "starting" || phase === "attaching" || phase === "resyncing" || phase === "live";
  }

  /** `ompDesk.chatHtmlPages`: whether a closed `html` fence of a reply is shown as a sandboxed page, and whether the model is told it may write one. The default is this one fallback and the manifest's. */
  function chatHtmlPagesEnabled(): boolean {
    return vscode.workspace.getConfiguration("ompDesk").get<boolean>("chatHtmlPages", true);
  }

  /** `ompDesk.chatLinkRules`: this window's link rules, read from the user's own settings only (`wiring/link-rules.ts`); a value with refused rules is logged and shown once. */
  function linkRules(): LinkRuleSource {
    const s = windowState();
    return s.linkRules ??= createWindowLinkRules(log, showWarning);
  }

  /** These are editor presentation preferences, never OMP commands. */
  function readChatDisplayPreferences(): ChatDisplayPreferences {
    const s = windowState();
    return {
      toolCallDetail: vscode.workspace.getConfiguration("ompDesk").get<string>("toolCallDetail", "overview") === "detailed" ? "detailed" : "overview",
      accessibilitySupport: vscode.workspace.getConfiguration("editor").get<string>("accessibilitySupport", "auto") === "on",
      thinkingExpanded: s.context?.globalState.get<unknown>(THINKING_EXPANDED_KEY) === true,
      toolsMode: toolsModeFromStored(s.context?.globalState.get<unknown>(TOOLS_EXPANDED_KEY)),
      toolIntent: vscode.workspace.getConfiguration("ompDesk").get<boolean>("toolIntentDescriptions", false),
      htmlPages: chatHtmlPagesEnabled(),
      sendWith: vscode.workspace.getConfiguration("ompDesk").get<string>("chatSendWith", "enter") === "shiftEnter" ? "shiftEnter" : "enter",
    };
  }

  async function toggleThinkingDefault(): Promise<void> {
    const s = windowState();
    if (activeChatTab() === null || s.context === undefined) return;
    const expanded = s.context.globalState.get<unknown>(THINKING_EXPANDED_KEY) !== true;
    await s.context.globalState.update(THINKING_EXPANDED_KEY, expanded);
    log.info(`thinking blocks: ${expanded ? "shown" : "hidden"} by default`);
    s.sessionRuntime.conversations.refreshDisplayPreferences();
  }

  /** `Ctrl+O` (`output`) expands or collapses everything; `Ctrl+Shift+O` (`groups`) opens or closes the groups with their calls collapsed. */
  async function toggleToolsMode(key: ToolsModeKey): Promise<void> {
    const s = windowState();
    if (activeChatTab() === null || s.context === undefined) return;
    const next = nextToolsMode(toolsModeFromStored(s.context.globalState.get<unknown>(TOOLS_EXPANDED_KEY)), key);
    await s.context.globalState.update(TOOLS_EXPANDED_KEY, toolsModeToStored(next));
    s.sessionRuntime.conversations.refreshDisplayPreferences();
  }

  function refreshChatDisplayPreferences(event: vscode.ConfigurationChangeEvent): void {
    const s = windowState();
    if (event.affectsConfiguration("ompDesk.chatHtmlPages")) {
      // On binds the frame server (a document built earlier names no port, so its pages say so until the window is reloaded); off closes it.
      if (chatHtmlPagesEnabled()) void s.htmlPageServer.ensure();
      else void s.htmlPageServer.close();
    }
    if (event.affectsConfiguration("ompDesk.chatLinkRules")) s.sessionRuntime.conversations.refreshLinkRules();
    if (event.affectsConfiguration("ompDesk.toolCallDetail") || event.affectsConfiguration("ompDesk.toolIntentDescriptions") || event.affectsConfiguration("ompDesk.chatHtmlPages") || event.affectsConfiguration("ompDesk.chatSendWith") || event.affectsConfiguration("editor.accessibilitySupport")) {
      s.sessionRuntime.conversations.refreshDisplayPreferences();
    }
  }

  /** A web link's context-menu command: the same open a click or Ctrl+Click sends, from a Chat or a detail tab. */
  async function openWebLinkFromMenu(argument: unknown, mode: WebLinkMode): Promise<void> {
    const url = webLinkMenuUrl(argument);
    if (url === null) return;
    try { await openPageWebLink(url, mode); }
    catch (error) { log.warn(`web link: cannot open ${url}: ${messageOf(error)}`); showWarning(`cannot open ${url}: ${messageOf(error)}`); }
  }

  /**
   * A web link the user clicked in a page, already re-validated as `http(s)` by the caller: an editor
   * tab (Simple Browser) or the external browser. Only the origin is logged, never the path or query.
   */
  async function openPageWebLink(url: string, mode: WebLinkMode): Promise<void> {
    log.debug(`web link: opening ${new URL(url).origin} in ${mode === "external" ? "the external browser" : "an editor tab"}`);
    await openWebLink(vscode, url, mode, error => log.warn(`web link: the editor browser failed for ${new URL(url).origin} (${messageOf(error)}); opening it in the external browser`));
  }

  /** Confirmation the extension owns before an `open_url` request opens a browser. */
  async function confirmOpenUrl(event: { url: string; launchUrl?: string; instructions?: string }): Promise<void> {
    const detail = [event.url, event.instructions ?? ""].filter(line => line.length > 0).join("\n\n");
    const picked = await vscode.window.showWarningMessage(
      "OMP asks to open this address in your browser.",
      { modal: true, detail },
      "Open",
    );
    if (picked !== "Open") return;
    await vscode.env.openExternal(vscode.Uri.parse(event.launchUrl ?? event.url));
  }

  /** What taking a session's name into its row and editors needs: the index, the launcher repaint and the tab appearance. */
  function sessionTitleDeps(context: vscode.ExtensionContext, index: SessionIndex): Parameters<typeof adoptSessionTitle>[0] {
    return { index, refreshLauncher: () => refreshLauncher(), applyAppearance: tabId => applyChatTabAppearance(context, index, tabId), log };
  }

  /**
   * One conversation event from the chat runtime, routed to the extension's own concerns:
   * activity and diagnostics for a model change, the redraw and readiness for a phase, the
   * lifecycle for an exit, and the identity binding for a learned session file.
   */
  function handleChatEvent(context: vscode.ExtensionContext, index: SessionIndex, tabId: string, event: ChatRuntimeEvent): void | Promise<void> {
    const s = windowState();
    switch (event.type) {
      case "catalogue": {
        const subject = toolsTarget(index);
        if (subject?.tabId === tabId && subject.mode === "chat" && s.sessionRuntime.conversations.incarnationOf(tabId) !== null) { s.inventoryViews?.refresh(); s.contextView?.refresh(); }
        return;
      }
      case "activity":
        applyTurnActivity(index, tabId, event.activity.observed, event.baseline);
        if (event.baseline) { s.inventoryViews?.sync(); s.contextView?.sync(); }
        const pickerModel = s.footerBindings.get(tabId);
        const chosen = event.activity.model;
        if (pickerModel?.modelId && (pickerModel.modelId !== chosen?.id || pickerModel.message.provider !== chosen?.provider)) cancelControlPicker(tabId);
        if (event.baseline || pickerModel?.modelId !== chosen?.id ||
          pickerModel?.message.provider !== chosen?.provider) void refreshSessionModels(index, tabId);
        refreshFooterMetadata(index, tabId, event.baseline);
        void s.sessionRuntime.identity.retry(tabId);
        if (event.baseline && !diagnosticsStageMeasured(tabId, "first-paint")) {
          s.diagnostics.succeed(tabId, "first-paint", { detail: "the first authoritative snapshot of the conversation" });
        }
        return;
      case "title":
        void adoptSessionTitle(sessionTitleDeps(context, index), tabId, event.sessionId, event.title);
        return;
      case "state": {
        const phase = event.payload.phase;
        logChatConnectionPhase(tabId, phase, event.payload.code, event.payload.exitReason, event.payload.readOnlyReason);
        if (phase !== "live") cancelControlPicker(tabId);
        if (phase === "live") {
          s.launchTimeline.mark(tabId, "chat live");
          void adoptSessionTitle(sessionTitleDeps(context, index), tabId, event.payload.sessionId, event.payload.title ?? "");
          if (!diagnosticsStageMeasured(tabId, "chat-live")) {
            s.diagnostics.succeed(tabId, "chat-live", { detail: "the conversation reached its live phase" });
          }
          void windowState().bridgeHost.commitDocument(tabId);
          windowState().bridgeHost.refreshReadiness(tabId);
          s.guestDispatcher.invalidateControls(tabId);
          refreshFooterMetadata(index, tabId, true);
          refreshSessionCost(index, tabId);
          void refreshSessionModels(index, tabId);
        }
        if (phase === "failed" || (phase === "stopped" && event.payload.code === "child-exited")) s.launchTimeline.discard(tabId, `chat ${phase}${event.payload.code ? ` (${event.payload.code})` : ""}`);
        if (phase === "stopped" && event.payload.code === "child-exited") {
          const runtime = hostOf(stateOf(tabId)) ?? null;
          if (runtime?.kind === "chat") void s.sessionRuntime.exit.rpcExited(tabId, runtime);
        }
        // The conversation's own phases are the launch's steps once the process runs: waiting for OMP's `ready`, then the first
        // state read; `live` or an end of the connection ends the launch the row and the page show as starting.
        const bootStep = stepAfterChatPhase(phase);
        if (bootStep !== null) s.pending.step(tabId, bootStep);
        s.pending.settle(tabId);
        refreshLauncher();
        return;
      }
      case "identity": {
        const runtime = hostOf(stateOf(tabId)) ?? null;
        if (runtime === null) return;
        // A proven continuation moves the row to the file the process went on in; the chat session waits for this answer and
        // ends the tab as diverged when the catalog did not take it.
        if (event.continuation !== undefined) {
          return s.sessionRuntime.identity.bindContinuation(tabId, runtime, event.continuation).then(accepted => {
            if (!accepted) throw new Error("The catalog did not record the continuation.");
          });
        }
        return s.sessionRuntime.identity.bind(tabId, runtime, event.sessionFile, event.sessionId, event.previousSessionId);
      }
      case "open-url":
        void confirmOpenUrl(event);
        return;
      case "resume-requested":
        void s.sessionFlows.resumeFromChat(context, index, tabId, event.requestId);
        return;
      case "restart-requested":
        void s.sessionFlows.restartChat(context, index, tabId, event.nativeNonce, event.requestId);
        return;
      case "turn-ended":
        if (s.sessionModelRefreshOwed.has(tabId)) void refreshSessionModels(index, tabId);
        refreshFooterMetadata(index, tabId, true);
        refreshSessionCost(index, tabId);
        s.footerBindings.get(tabId)?.observer?.refresh();
        return;
      case "recovery":
        log.warn(`tab ${tabId}: chat connection recovery (${event.reason}).`);
        return;
      case "extension-error":
        showError(`An OMP extension reported an error: ${event.message}`);
        return;
    }
  }

  /**
   * Record a lost connection and its end in the output channel, including the bounded plain-text
   * diagnostic for an autonomous managed-RPC child exit. A live phase shown before OMP confirmed a reattached session
   * (its read-only reason is `STATE_UNCONFIRMED_REASON`) is not yet a restoration: the line waits for the state that lifts that reason.
   */
  function logChatConnectionPhase(tabId: string, phase: ChatPhase, code: string | null, exitReason?: ChatExitReason, readOnlyReason: string | null = null): void {
    const s = windowState();
    const previous = s.loggedChatPhases.get(tabId);
    if (phase === "failed" || phase === "stopped") {
      s.loggedChatPhases.set(tabId, phase);
      log[phase === "failed" ? "warn" : "info"](`tab ${tabId}: chat connection ${phase}${code === null ? "" : ` (${code})`}.`);
      if (phase === "stopped" && exitReason !== undefined) log.warn(`tab ${tabId}: ${chatExitText(exitReason)}`);
    } else if (phase === "live" && readOnlyReason !== STATE_UNCONFIRMED_REASON) {
      s.loggedChatPhases.delete(tabId);
      if (previous === "failed") log.info(`tab ${tabId}: chat connection restored; the same session is live again.`);
    }
  }

  /** The responder of one bound panel. */
  function panelResponder(tabId: string, panel: vscode.WebviewPanel, actionSeq: unknown): GuestResponder {
    const state = stateOf(tabId);
    const runtime = hostOf(state) ?? null;
    const live = (): boolean => {
      const current = stateOf(tabId);
      return current !== undefined && current === state && current.panel === panel;
    };
    return {
      live,
      reply: message => {
        if (live()) void panel.webview.postMessage(message);
      },
      admit: input => {
        const route = windowState().bridgeHost.routeOf(tabId);
        // A document this window never bridged has only the panel route, and the
        // host mints the request id at dispatch. A bridged document uses its own
        // document ledger, so both routes reserve the same sequence exactly once.
        if (route === null || state?.bridge?.documentId === null) {
          return { nativeRequestId: createControlRequestId() };
        }
        const routeGeneration = route.routeGeneration;
        if (routeGeneration === null) return null;
        try {
          const reservation = route.admit({ routeGeneration, actionSeq: input.actionSeq, operation: input.operation, payload: input.payload });
          return {
            nativeRequestId: reservation.nativeRequestId,
            fence: () => {
              if (!live() || windowState().bridgeHost.routeOf(tabId) !== route) {
                throw new HostControlRefusedError("closed", "This document was closed before native dispatch.", null);
              }
              reservation.verify();
            },
            settle: outcome => reservation.settle(outcome),
          };
        } catch (error) {
          log.warn(`tab ${tabId}: a panel mutation was not admitted (${error instanceof BridgeAdmissionError ? error.code : "refused"})`);
          return null;
        }
      },
      invalidate: () => windowState().guestDispatcher.invalidateControls(tabId),
    };
  }

  /**
   * Answer a guest control request for its own indexed tab only. Correlation fields supplied
   * by the Webview never select the session or a mutation ledger id.
   *
   * Model and thinking changes are the conversation's own rpc commands (`set_model`,
   * `set_thinking_level`), answered by the process that serves it; what the page is shown
   * afterwards is read back from the host-owned chat model.
   */
  async function handleGuestControlRequest(
    index: SessionIndex,
    tabId: string,
    request: GuestControlRequestMessage,
    responder: GuestResponder,
  ): Promise<void> {
    const s = windowState();
    const state = stateOf(tabId);
    if (!state || !responder.live()) return;
    const conversations = s.sessionRuntime.conversations;
    const live = conversations.liveOf(tabId);
    ensureFooterBinding(index, tabId);
    publishFooterMetadata(tabId);
    const reply = (message: GuestControlStateMessage): void => {
      if (stateOf(tabId) === state && conversations.incarnationOf(tabId) === (live?.incarnation ?? null)) responder.reply(message);
    };
    const unavailable = (reason: string, notice?: string): GuestControlStateMessage => ({
      type: "omp:control-state",
      scope: request.scope,
      requestId: request.requestId,
      available: false,
      model: null,
      thinkingLevel: null,
      mutationMode: "unavailable",
      reason,
      ...(notice ? { notice } : {}),
    });
    if (fencedOf(state) || state.mode === "terminal") {
      reply(unavailable(fencedOf(state) ? "The session view is changing or its process is stopping." : "Chat model/thinking controls are unavailable in Terminal; use native TUI controls."));
      return;
    }
    if (live === null || live.phase !== "live") {
      reply(unavailable("This session is not live, so its model and thinking controls are not available."));
      return;
    }
    const entry = index.get(tabId);
    if (entry === null || entry.availability !== "live" || entry.ownership === null || entry.ownership.releasedAt !== null) {
      reply(unavailable("The session's held ownership is not verified yet."));
      return;
    }
    if (request.action === "snapshot" && request.picker !== undefined) cancelControlPicker();
    const nowLive = (): LiveConversation | null => liveAt(tabId, live.incarnation);
    const stillCurrent = (): boolean =>
      responder.live() && stateOf(tabId) === state && !fencedOf(state) && state.mode === "chat" && nowLive()?.phase === "live";
    let notice: string | undefined;
    try {
      if (request.action !== "snapshot") {
        // One admission path for both routes: reserve the document's sequence once, then
        // recheck the route at the write.
        const mutation =
          request.action === "set-model"
            ? { operation: "set-model", payload: { model: request.model } }
            : { operation: "set-thinking", payload: { level: request.level } };
        if (request.action === "set-model" && !request.model) {
          notice = "No model was named; nothing was changed.";
        } else if (request.action === "set-thinking" && !request.level) {
          notice = "No thinking level was named; nothing was changed.";
        } else {
          const admission = responder.admit({ actionSeq: request.actionSeq, operation: mutation.operation, payload: mutation.payload });
          if (admission === null) {
            reply(unavailable("This document's route cannot dispatch a change right now.", "No change was sent."));
            return;
          }
          try {
            admission.fence?.();
            if (!stillCurrent()) throw new HostControlRefusedError("closed", "The editor or session changed before dispatch.", null);
            const outcome =
              request.action === "set-model"
                ? await conversations.chooseModel(tabId, live.incarnation, request.model!.provider, request.model!.id, request.model!.name)
                : await conversations.chooseThinkingLevel(tabId, live.incarnation, request.level!);
            if (outcome.status === "stale") throw new HostControlRefusedError("closed", "The editor or session changed before dispatch.", null);
            admission.settle?.(
              outcome.status === "accepted" || outcome.status === "pending" ? "applied" : outcome.status === "refused" ? "refused" : "unknown",
            );
            // A held choice shows in the footer from the chat state; only a refusal or an unconfirmed change is a notice.
            notice = outcome.status === "accepted" || outcome.status === "pending" ? undefined : controlOutcomeNotice(outcome);
          } catch (error) {
            admission.settle?.("unknown");
            if (error instanceof HostControlRefusedError) {
              notice = "The session changed before dispatch; nothing was changed by this request.";
            } else {
              reply(unavailable("The session's command channel failed.", "The outcome is uncertain; no retry was sent."));
              return;
            }
          }
        }
      }
      if (!stillCurrent()) {
        reply(unavailable("The session changed during this request.", notice ?? "The outcome is uncertain; no retry was sent."));
        return;
      }
      // Picker catalogues remain host-local; only the selection crosses to the page.
      let selectedModel: ControlModelRef | undefined;
      let selectedThinking: string | undefined;
      if (request.action === "snapshot" && request.picker !== undefined) {
        const beforeModel = nowLive()?.state?.model ?? null;
        if (request.picker === "model") {
          const listed = await conversations.readAvailableModels(tabId, live.incarnation);
          if (listed.status !== "ok") {
            notice = listed.status === "refused" && listed.reason === "busy" ? "OMP is busy with another request; open the picker again in a moment." : "OMP could not list models. Nothing was changed.";
          } else {
            const models = listed.models.filter(model => model.provider.length > 0 && model.provider.length <= 200 &&
              model.id.length > 0 && model.id.length <= 200 && isSafeBoundaryText(model.provider) && isSafeBoundaryText(model.id))
              .map(model => ({ provider: model.provider, id: model.id,
                ...(model.name && model.name.length <= 200 && isSafeBoundaryText(model.name) ? { name: model.name } : {}) }));
            if (stillCurrent()) {
              recordSessionModels(index, tabId, models.length > 0);
              if (models.length === 0) void openProviderLogin(index, hostOf(state), entry.scope.profile, entry.cwd);
              else {
                const picked = await pickControlModel(models, nowLive()?.pendingControl?.model ?? beforeModel, stillCurrent, tabId);
                if (picked === "provider-login") void openProviderLogin(index, hostOf(state), entry.scope.profile, entry.cwd);
                else selectedModel = picked;
              }
            }
          }
        } else {
          const thinking = await conversations.readAvailableThinkingLevels(tabId, live.incarnation);
          const sameModel = (): boolean => {
            const current = nowLive()?.state?.model;
            return stillCurrent() && beforeModel?.provider === current?.provider && beforeModel?.id === current?.id;
          };
          if (thinking.status !== "ok") notice = thinking.status === "refused" && thinking.reason === "busy" ?
            "OMP is busy with another request; open the picker again in a moment." : "OMP could not list thinking levels. Nothing was changed.";
          else if (sameModel() && thinking.levels.length > 0) selectedThinking = await pickControlThinking(
            thinking.levels.filter(level => level.length > 0 && level.length <= 64 && isSafeBoundaryText(level)),
            nowLive()?.pendingControl?.thinking ?? nowLive()?.state?.thinkingLevel ?? null, sameModel, tabId);
          if (!sameModel() && stillCurrent()) notice = "The model changed while choosing a thinking level. Nothing was changed.";
        }
      }
      if (!stillCurrent()) {
        reply(unavailable("The session changed during this request.", notice ?? "The outcome is uncertain; no retry was sent."));
        return;
      }
      const liveState = nowLive()?.state ?? null;
      if (liveState === null) {
        reply(unavailable("The session has not reported its model yet."));
        return;
      }
      reply({ ...controlGuestState(request, liveState, notice),
        ...(selectedModel ? { selectedModel } : {}), ...(selectedThinking ? { selectedThinking } : {}) });
    } catch {
      reply(unavailable("The session is unavailable.", request.action === "snapshot" ?
        request.picker === undefined ? undefined : "The picker could not be opened. Nothing was changed." :
        "The outcome is uncertain; no retry was sent."));
    }
  }

  /** Only fixed, credential-free display text crosses the Webview boundary. */
  function controlGuestState(
    request: GuestControlRequestMessage,
    live: ChatLiteState,
    notice?: string,
  ): GuestControlStateMessage {
    const liveModel = live.model;
    const model =
      liveModel !== null && liveModel.provider.length > 0 && liveModel.provider.length <= 200 &&
      liveModel.id.length > 0 && liveModel.id.length <= 200 &&
      isSafeBoundaryText(liveModel.provider) && isSafeBoundaryText(liveModel.id)
        ? { provider: liveModel.provider, id: liveModel.id, ...(liveModel.name ? { name: liveModel.name } : {}) }
        : null;
    const thinkingLevel =
      live.thinkingLevel !== null && live.thinkingLevel.length > 0 && live.thinkingLevel.length <= 64 &&
      isSafeBoundaryText(live.thinkingLevel)
        ? live.thinkingLevel
        : null;
    return {
      type: "omp:control-state",
      scope: request.scope,
      requestId: request.requestId,
      available: true,
      model,
      thinkingLevel,
      // A change is one rpc command answered by the process; a session transition may still
      // overtake it, so the mode is honest about being best-effort.
      mutationMode: "best-effort",
      ...(notice ? { notice } : {}),
    };
  }

  function controlOutcomeNotice(outcome: ChoiceOutcome): string {
    switch (outcome.status) {
      case "accepted":
        return "OMP applied the change; the state shown was read back from the session.";
      case "pending":
        return "OMP applies the change as soon as it is ready.";
      case "refused":
        return outcome.reason === "busy"
          ? "OMP is busy with another request; nothing was changed."
          : "OMP did not accept that change; nothing was changed.";
      case "unconfirmed":
        return "The change may not have held. It was not retried.";
    }
  }

  /**
   * Environment for the native login terminal: use the session's explicit profile,
   * or OMP's default sentinel, rather than an inherited extension-host profile.
   */
  function ompCliScopeEnvironment(profile: string | null): Record<string, string> {
    return { OMP_PROFILE: profile !== null && profile.length > 0 ? profile : DEFAULT_OMP_PROFILE };
  }

  /**
   * The installed OMP a launch would run, resolved now. One resolution at a time: every concurrent caller (the footer of each tab after a
   * restore, the first of them under load; the Bun pre-check at activation) used to run its own `omp --version` probe, which only made a
   * busy machine busier and every probe slower.
   */
  function sharedOmpBinary(): Promise<OmpBinary> {
    resolvingExecutable ??= resolveOmpBinary().finally(() => { resolvingExecutable = null; });
    return resolvingExecutable;
  }

  let resolvingExecutable: Promise<OmpBinary> | null = null;

  /**
   * The installed OMP a CLI call runs: the exact one a host this window launched started from,
   * or — for a re-adopted host that did not record it — the one a launch would resolve now.
   */
  async function executableFor(runtime: SessionHostRuntime | null): Promise<OmpCommand> {
    if (runtime?.binary != null) return runtime.binary;
    return await sharedOmpBinary();
  }

  /**
   * `runOmpCli` for what a page shows now (a settings question a Chat page asks): one of the window's bounded helper runs, ahead of background
   * work and never held back by the startup restore (ADR-0084).
   */
  const visibleOmpCli = (
    executable: OmpCommand, args: readonly string[], timeoutMs: number, options: { readonly cwd?: string; readonly env?: Readonly<Record<string, string>> },
  ): Promise<OmpCliResult> => windowState().helpers.run({
    label: `omp ${args[0] ?? ""}`, class: "visible", run: signal => runOmpCli(executable, args, timeoutMs, { ...options, signal }),
  });

  const usageFailureNotes = new UsageFailureNotes();

  /** A provider-usage failure goes to the log with its cause, once per distinct cause for each tab. */
  function noteUsageFailure(binding: object, stage: string, error: unknown): void {
    const line = usageFailureNotes.note(binding, stage, error);
    if (line !== null) log.warn(line);
  }

  async function copyHostTools(index: SessionIndex): Promise<void> {
    const channel = activeControl(index);
    if (channel === null) {
      showInfo(controlUnavailableMessage(index));
      return;
    }
    try {
      const list = await channel.client.listTools();
      if (activeControl(index)?.client !== channel.client) {
        showWarning("The selected session changed; its tools were not copied.");
        return;
      }
      if (!list.available) {
        showWarning("The native host could not enumerate this session's tools.");
        return;
      }
      await vscode.env.clipboard.writeText(list.active.join("\n"));
      showInfo(`Copied ${list.active.length} active tool name(s) to the clipboard for reference; no session was changed.`);
    } catch (error) {
      showWarning(`The host's tools could not be copied: ${describeControlError(error)}.`);
    }
  }

  /** Editor recency, not Sessions row selection, determines the capabilities shown here. */
  function toolsTarget(index: SessionIndex): SessionToolsTarget | null {
    const s = windowState();
    const focused = activePanelTab();
    const state = focused ?? s.editorRecency.order().map(slot => s.tabs.get(slot)).find(tab => tab?.panel !== null && tab?.tabId != null && tab.shellSlot === null);
    if (!state || state.tabId === null || state.shellSlot !== null) return null;
    const tabId = state.tabId;
    const runtime = hostOf(state);
    const conversations = s.sessionRuntime.conversations;
    const live = state.mode === "chat" ? conversations.liveOf(tabId) : null;
    const channel = activeControl(index, tabId);
    const binding = channel?.client.latestHost;
    const entry = index.get(tabId);
    return {
      key: runtime ?? state,
      tabId,
      generation: JSON.stringify([state.slotId, tabId, state.mode, live?.incarnation, live?.epoch, live?.sessionFile, live?.sessionId,
        binding?.instanceId, binding?.epoch, binding?.sessionFile]),
      mode: state.mode,
      title: entry === null ? "OMP session" : s.launcherProvider?.headlineFor(tabId) ?? sessionHeadline(entry, null),
      cwd: runtime?.cwd ?? entry?.cwd ?? null,
      profile: entry?.scope.profile ?? null,
      running: passiveReasonForSlot(state.slotId) === null && !fencedOf(state) &&
        (state.mode === "chat" ? live?.phase === "live" : launcherFacts(tabId).running),
      commands: live?.commands ?? [],
      readDescriptors: live === null ? null : () => conversations.readToolDescriptors(tabId, live.incarnation),
      readTools: channel === null ? null : async () => {
        const list = await channel.client.listTools();
        const current = activeControl(index, tabId);
        const host = channel.client.latestHost;
        const now = live === null ? null : liveAt(tabId, live.incarnation);
        return hostOf(stateOf(tabId)) === runtime && current?.client === channel.client &&
          host?.instanceId === binding?.instanceId && host?.epoch === binding?.epoch &&
          (live === null || (host?.sessionFile !== null && host?.sessionFile !== undefined &&
            now?.sessionFile != null && controlPathEquals(host.sessionFile, now.sessionFile))) ? list : null;
      },
    };
  }

  /** The Context view's subject: the inventory views' selection (editor recency) plus the tab and its Chat session. */
  function contextTarget(index: SessionIndex): ContextTarget | null {
    const target = toolsTarget(index);
    if (target === null) return null;
    return {
      key: target.key,
      generation: target.generation,
      mode: target.mode === "chat" ? "chat" : "terminal",
      running: target.running,
      title: target.title,
      tabId: target.tabId,
      session: target.mode === "chat" ? contextSessionOf(target.tabId) : null,
    };
  }

  /**
   * The Context view's handle on one incarnation of a Chat conversation: every read and request goes through the port
   * under that incarnation, so a replaced session answers nothing. The facts are the last ones read while it was current.
   */
  function contextSessionOf(tabId: string): ContextSession | null {
    const conversations = windowState().sessionRuntime.conversations;
    const first = conversations.liveOf(tabId);
    if (first === null) return null;
    const { incarnation } = first;
    let last = first;
    return {
      get model() {
        last = liveAt(tabId, incarnation) ?? last;
        return last;
      },
      subscribe: listener => conversations.observe(tabId, incarnation, listener) ?? (() => undefined),
      readContext: () => conversations.readContext(tabId, incarnation),
      requestContextReport: async () => {
        const result = await conversations.requestContextReport(tabId, incarnation);
        return result.status === "stale" ? { status: "refused", reason: "not-live" } : result;
      },
    };
  }

  /** Command-palette controls never fall back to another tab's host. */
  function activeControl(index: SessionIndex, tabId: string | null = index.activeTabId): ControlChannel | null {
    if (tabId === null) return null;
    const state = stateOf(tabId);
    const entry = index.get(tabId);
    const runtime = hostOf(state);
    const control = controlOf(state);
    const identity = control?.client.latestHost;
    if (!runtime || !control || !identity || entry?.availability !== "live" ||
        !entry.sessionFile || entry.ownership?.releasedAt !== null ||
        entry.host?.pid !== runtime.pid || identity.pid !== runtime.pid ||
        identity.sessionFile === null || !controlPathEquals(identity.sessionFile, entry.sessionFile)) {
      return null;
    }
    return { tabId, client: control.client, snapshot: control.snapshot };
  }

  function controlUnavailableMessage(index: SessionIndex): string {
    const failure = index.activeTabId === null ? null : (recordOf(stateOf(index.activeTabId))?.controlFailure ?? null) ?? null;
    return failure === null
      ? "Host control is not established for the selected session. Open it and run this command again."
      : `Host control is unavailable for the selected session: ${failure}`;
  }

  function describeModel(model: { readonly provider: string; readonly id: string } | null | undefined): string {
    return model === null || model === undefined ? "unknown model" : `${model.provider}/${model.id}`;
  }

  /** The conversation's live Chat session as values, when it is still the incarnation the caller named. */
  function liveAt(tabId: string, incarnation: number): LiveConversation | null {
    const live = windowState().sessionRuntime.conversations.liveOf(tabId);
    return live !== null && live.incarnation === incarnation ? live : null;
  }

  /** The live Chat session of the active tab as values, or `null` (with the reason shown) when there is none. */
  function activeLiveSession(index: SessionIndex): { readonly tabId: string; readonly live: LiveConversation } | null {
    const s = windowState();
    const tabId = index.activeTabId;
    const state = tabId === null ? undefined : stateOf(tabId);
    if (state?.mode === "terminal" || fencedOf(state)) {
      showWarning(fencedOf(state) ? "The session is changing view or stopping." : "Chat model/thinking controls are unavailable in Terminal; use the native TUI.");
      return null;
    }
    const live = tabId === null ? null : s.sessionRuntime.conversations.liveOf(tabId);
    if (tabId === null || live === null || live.phase !== "live") {
      showInfo("Open a running OMP session first: the model and thinking level belong to a live session.");
      return null;
    }
    return { tabId, live };
  }

  async function showHostControls(index: SessionIndex): Promise<void> {
    const active = activeLiveSession(index);
    if (active === null) return;
    const channel = activeControl(index);
    const snapshot = channel === null ? controlOf(stateOf(active.tabId))?.snapshot ?? null : await refreshControlSnapshot(channel);
    const live = liveAt(active.tabId, active.live.incarnation)?.state ?? null;
    if (live === null) {
      showInfo("The session has not reported its model yet.");
      return;
    }
    log.info(`control[${active.tabId}]: model: ${describeModel(live.model)}, thinking: ${live.thinkingLevel ?? "unknown"}`);
    if (snapshot !== null) {
      log.info(`control[${active.tabId}]: host: instance ${snapshot.host.instanceId}, epoch ${snapshot.host.epoch}`);
      log.info(`control[${active.tabId}]: session file: ${snapshot.host.sessionFile ?? "not materialized"}`);
    }
    showInfo(`The session runs ${describeModel(live.model)} with thinking ${live.thinkingLevel ?? "unknown"}. See the OMP Desk output channel for details.`);
  }

  async function selectHostModel(index: SessionIndex): Promise<void> {
    const conversations = windowState().sessionRuntime.conversations;
    const active = activeLiveSession(index);
    if (active === null) return;
    const { tabId } = active;
    const { incarnation } = active.live;
    const listed = await conversations.readAvailableModels(tabId, incarnation);
    if (listed.status === "stale") return;
    if (listed.status === "refused") {
      showInfo(listed.reason === "busy" ? "OMP is busy with another request; select a model again in a moment." : "The session is not accepting commands right now.");
      return;
    }
    if (listed.status === "failed") {
      showInfo("OMP listed no selectable models.");
      return;
    }
    const current = (): boolean => conversations.incarnationOf(tabId) === incarnation;
    if (!current()) return;
    recordSessionModels(index, tabId, listed.models.length > 0);
    const now = liveAt(tabId, incarnation);
    const picked = await pickControlModel(listed.models, now?.pendingControl?.model ?? now?.state?.model ?? null, current, tabId);
    if (!picked) return;
    if (!current()) {
      showWarning("The selected session changed while choosing; nothing was changed.");
      return;
    }
    if (picked === "provider-login") {
      const entry = index.get(tabId);
      if (entry !== null) void openProviderLogin(index, hostOf(stateOf(tabId)) ?? null, entry.scope.profile, entry.cwd);
      return;
    }
    const outcome = await conversations.chooseModel(tabId, incarnation, picked.provider, picked.id, picked.name);
    if (outcome.status === "stale") return;
    showInfo(controlOutcomeNotice(outcome));
  }

  async function selectHostThinking(index: SessionIndex): Promise<void> {
    const conversations = windowState().sessionRuntime.conversations;
    const active = activeLiveSession(index);
    if (active === null) return;
    const { tabId, live } = active;
    const current = live.pendingControl?.thinking ?? live.state?.thinkingLevel;
    const listed = await conversations.readAvailableThinkingLevels(tabId, live.incarnation);
    if (listed.status === "stale") return;
    if (listed.status !== "ok" || listed.levels.length === 0) {
      showInfo("OMP listed no selectable thinking levels.");
      return;
    }
    const sameSession = (): boolean => conversations.incarnationOf(tabId) === live.incarnation;
    const picked = await pickControlThinking(listed.levels, current ?? null, sameSession, tabId);
    if (!picked) return;
    if (!sameSession()) {
      showWarning("The selected session changed while choosing; nothing was changed.");
      return;
    }
    const outcome = await conversations.chooseThinkingLevel(tabId, live.incarnation, picked);
    if (outcome.status === "stale") return;
    showInfo(controlOutcomeNotice(outcome));
  }

  async function refreshControlSnapshot(channel: ControlChannel): Promise<ControlHostSnapshot | null> {
    try {
      const snapshot = await channel.client.snapshot();
      const state = stateOf(channel.tabId);
      // A read that finished after the channel was replaced describes a process this window no
      // longer speaks for, so it is not recorded on the tab.
      if (
        state !== undefined &&
        mayRefreshControlSnapshot(
          { runtime: hostOf(state) ?? null, runtimePid: hostOf(state)?.pid ?? null, controlClient: controlOf(state)?.client ?? null },
          channel.client,
        )
      ) {
        const control = controlOf(state);
        if (control) control.snapshot = snapshot;
      }
      return snapshot;
    } catch (error) {
      const state = stateOf(channel.tabId);
      const target =
        state === undefined
          ? null
          : { runtime: hostOf(state) ?? null, runtimePid: hostOf(state)?.pid ?? null, controlClient: controlOf(state)?.client ?? null };
      if (mayReportControlFailure(target, { runtime: null, pid: null, client: channel.client })) {
        windowState().sessionRuntime.control.reportFailure(channel.tabId, error);
      } else {
        log.debug(`tab ${channel.tabId}: a failed control read back was ignored: this tab holds a different channel now`);
      }
      return null;
    }
  }

  // Editor slots: the one map of live resources (ADR-0025)

  /**
   * One editor's live resources, by either key kind.
   *
   * A direct hit is an editor's own record (or a conversation's pre-editor launch
   * record). A miss on a conversation resolves to the slot the registry says controls
   * it, which is how a command that only knows a conversation reaches its editor.
   * Nothing here ever guesses a slot that the registry does not name as the
   * controller.
   */
  function stateOf(key: string | null): TabState | undefined {
    const s = windowState();
    if (key === null) return undefined;
    const direct = s.tabs.get(key);
    if (direct !== undefined) return direct;
    if (!isPanelTabId(key)) return undefined;
    const controller = s.editorSlots.controllerOf(key)?.slotId ?? null;
    if (controller !== null) {
      const controlled = s.tabs.get(controller);
      if (controlled !== undefined) return controlled;
    }
    // A conversation whose only editor is non-controlling — a newcomer bound passive to
    // a row another writer owns — still has exactly one record in this window: its
    // launch, its counters and its claim. Resolving that record here is what keeps a
    // lookup by conversation from forking a second, empty authority for the same
    // conversation.
    for (const state of s.tabs.values()) if (state.tabId === key) return state;
    return undefined;
  }

  /** One slot's own record, or `null`. Never resolves through a conversation. */
  function slotState(slot: string): TabState | null {
    const s = windowState();
    return s.tabs.get(slot) ?? null;
  }

  /**
   * Make the chat editors a key names say what they show: the session's own
   * user-visible name, and the OMP icon.
   *
   * A tab title is a second, always-visible copy of a launcher row, so it is derived
   * from the same rule the row uses ({@link sessionHeadline}: OMP's stored title,
   * then the last one this window observed, then the stable ordinal label) — never
   * from the working folder, so two untitled conversations in one folder stay
   * distinguishable in the tab strip exactly as they are in the launcher, and a
   * rename through OMP itself reaches the tab. The stored title is read from the
   * session file the row reads, so a title OMP changed since this window indexed the
   * row does not leave the tab contradicting the row.
   *
   * `key` is an editor slot id or the conversation a panel shows, so one call covers
   * a panel that was just bound (created, restored or migrated), a panel a settled
   * native switch moved to another conversation, and every editor of a conversation
   * whose stored name changed. A record with no panel, or a key naming none, is
   * simply skipped: nothing here creates, focuses or closes an editor.
   *
   * The title is written only when it actually differs and the icon only when this
   * exact panel has none, because assigning either re-renders the tab; the icon is a
   * constant of this build, so a panel that carries it never needs it again — while
   * a panel VS Code restored carries no icon until it is bound here.
   */
  async function applyChatTabAppearance(context: vscode.ExtensionContext, index: SessionIndex, key: string): Promise<void> {
    const s = windowState();
    for (const state of [...s.tabs.values()]) {
      if (state.panel === null || state.tabId === null) continue;
      if (state.slotId !== key && state.tabId !== key) continue;
      const panel = state.panel;
      const conversation = state.tabId;
      const entry = index.get(conversation);
      if (entry !== null) {
        const header = entry.sessionFile === null ? null : await readSessionFileHeader(entry.sessionFile);
        // The read is asynchronous, so the panel this record held — and the
        // conversation it showed — are re-checked before the title is written: a
        // panel replaced or moved while the file was read must never receive the
        // previous subject's name.
        if (state.panel !== panel || state.tabId !== conversation) continue;
        const title = sessionHeadline(entry, header);
        if (panel.title !== title) panel.title = title;
        s.detailTabs.renameConversation(conversation, title);
      }
      if (panel.iconPath === undefined) panel.iconPath = vscode.Uri.joinPath(context.extensionUri, EDITOR_TAB_ICON);
    }
  }

  /** Build the empty record of one slot. */
  function newTabState(slotId: string): TabState {
    return {
      slotId,
      tabId: isPanelTabId(slotId) ? slotId : null,
      panel: null,
      mode: "chat",
      viewProjection: null,
      document: null,
      chatDetach: null,
      chatPageId: null,
      heldReadyReport: null,
      origin: null,
      lastOpenRequest: -1,
      lastEditorClose: -1,
      editorOfAttempt: false,
      openingVerb: null,
      openDeclined: false,
      pipeline: null,
      shellSlot: null,
      ownerStopWatch: null,
      bridge: null,
    };
  }

  /**
   * Get or create the record one key names.
   *
   * An existing controller's record is returned rather than a second one created, so
   * a `tabState(conversation)` call can never fork a conversation into two
   * authorities. Only a key no editor owns yet creates a record — and for a
   * conversation that record is moved under its editor's key as soon as one binds.
   */
  function tabState(key: string): TabState {
    const s = windowState();
    const existing = stateOf(key);
    if (existing !== undefined) return existing;
    const created = newTabState(key);
    s.tabs.set(key, created);
    return created;
  }

  /** Register one election of `slot`; it is forgotten when it settles, however it ends. */
  function trackElection(slot: string, work: Promise<void>): Promise<void> {
    const s = windowState();
    let pending = s.slotElections.get(slot);
    if (pending === undefined) {
      pending = new Set();
      s.slotElections.set(slot, pending);
    }
    const set = pending;
    const tracked: Promise<void> = work
      .catch(() => undefined)
      .finally(() => {
        set.delete(tracked);
        if (set.size === 0 && s.slotElections.get(slot) === set) s.slotElections.delete(slot);
      });
    set.add(tracked);
    return tracked;
  }

  /** Resolve once every election of `slot` that is in flight now has settled, or after the bound. */
  async function awaitElection(slot: string): Promise<void> {
    const s = windowState();
    const pending = s.slotElections.get(slot);
    if (pending === undefined) return;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.allSettled([...pending]),
        new Promise<void>(resolve => {
          timer = setTimeout(resolve, ELECTION_WAIT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Why the editor that holds this key may not act, or `null` when it may. */
  function passiveReasonOf(key: string): string | null {
    const state = stateOf(key);
    return state === null || state === undefined ? null : passiveReasonForSlot(state.slotId);
  }

  /**
   * Why one exact slot may not act, or `null` when it may.
   *
   * The answer is deliberately **two-sided**. This window's own registry says what this
   * editor was told here; the *durable* binding says what every window agrees it controls.
   * An editor may act only when both agree that it controls the conversation it currently
   * serves:
   *
   * - a demotion recorded anywhere — by this window's own election or by another window's
   *   commit — takes effect immediately, because the durable binding is consulted on every
   *   check rather than copied once into the local registry;
   * - an editor whose recorded role and served conversation disagree (a slot re-pointed by
   *   a callback that lost its race, or a binding that moved under it) is treated as
   *   non-controlling instead of being trusted because its local marker happens to be
   *   empty.
   *
   * This is the check every credential path takes: the bridge route's eligibility, the
   * terminal pane's input authority and the chat delivery all resolve through here.
   */
  function passiveReasonForSlot(slot: string): string | null {
    const s = windowState();
    const entry = s.editorSlots.get(slot);
    const local = entry === null || entry.role === "controlling" ? null : (entry.passiveReason ?? PASSIVE_REASON_DEFAULT);
    const state = s.tabs.get(slot);
    const conversation = state?.tabId ?? null;
    const binding = s.indexForBridge?.slotBinding(slot) ?? null;
    if (conversation !== null && (binding === null || binding.role !== "controlling" || binding.tabId !== conversation)) {
      return local ?? LIVE_INCUMBENT_REASON;
    }
    return local;
  }

  /**
   * Point one editor slot at the conversation it now shows, and apply the role.
   *
   * This is the one place a slot's binding and authority change, and it is where the
   * pre-editor launch record is moved under the editor's immutable key: the record
   * already holds this conversation's runtime, control channel and editor counters,
   * so it is *moved*, never copied — one editor's resources are never reachable under
   * two keys.
   *
   * Registering a controller demotes every other controlling slot of the same
   * conversation (the registry does that), and every role change is applied to the
   * live page here: a demoted editor is told it is passive and its terminal pane loses
   * input, a promoted one is told it may act again. Its panel, its document and its
   * unsent draft are untouched either way.
   */
  function bindSlotToConversation(
    slot: string,
    conversation: string,
    role: EditorSlotRole,
    reason: string | null,
  ): TabState {
    const s = windowState();
    if (s.tabs.get(slot) === undefined) {
      // The record this conversation already has — a pre-editor launch record, or the
      // record a closed editor left behind while its native host kept running — belongs
      // to the editor that serves the conversation. It is *moved* under this editor's
      // immutable key, preserving its runtime, its control channel and its editor
      // counters, so reopening a row reattaches the host this window already runs
      // instead of starting a second one. A record a live editor holds is never taken.
      const stale =
        s.tabs.get(conversation) ??
        [...s.tabs.values()].find(
          candidate =>
            candidate.slotId !== slot &&
            candidate.tabId === conversation &&
            candidate.panel === null &&
            !s.bridgeLiveEditors.has(candidate.slotId),
        );
      if (stale !== undefined && stale.slotId !== slot) {
        // Frontend registrations belong to the immutable editor slot, not this
        // movable conversation record. Retire only its old presentation; binding
        // the replacement panel creates a fresh frontend on the same live handle.
        stopTerminalForTab(stale.slotId);
        s.tabs.delete(stale.slotId);
        s.editorSlots.remove(stale.slotId);
        stale.slotId = slot;
        stale.tabId = conversation;
        s.tabs.set(slot, stale);
        const held = s.sessionRuntime.records.get(conversation);
        if (held !== undefined) held.slotId = slot;
      }
    }
    const state = tabState(slot);
    // A native handover renames the conversation this editor shows: the runtime's record follows it.
    if (state.tabId !== null && state.tabId !== conversation) s.sessionRuntime.records.move(state.tabId, conversation, state.slotId);
    state.slotId = slot;
    state.tabId = conversation;
    const before = new Map(s.editorSlots.entries().map(entry => [entry.slotId, entry]));
    s.editorSlots.register({ slotId: slot, tabId: conversation, role, passiveReason: reason });
    for (const entry of s.editorSlots.entries()) {
      const was = before.get(entry.slotId);
      if (was === undefined || (was.role === entry.role && was.generation === entry.generation)) continue;
      applySlotAuthority(entry.slotId);
    }
    return s.tabs.get(slot) ?? state;
  }

  /** Tell one slot's page and pane what its current authority is. */
  function applySlotAuthority(slot: string): void {
    const s = windowState();
    const state = slotState(slot);
    if (state === null || state.tabId === null) return;
    const reason = fencedOf(state) ? "The session view is changing or its process is stopping." : passiveReasonForSlot(slot);
    state.pipeline?.noteReadOnly(reason);
    // The page shows the role: its route reports the reason as `readOnlyReason` (composer
    // disabled, banner shown) and the runtime refuses its commands; re-send so it applies now.
    attachChatRoute(slot, true);
    if (reason === null) {
      windowState().bridgeHost.replayHeldReadyReport(state);
      // A control request answered while this editor could not act left its footer without
      // controls; now that it may act, the page asks again.
      s.guestDispatcher.invalidateControls(state.tabId);
    }
    refreshLauncher();
    pushSessionView(s.indexForBridge, state);
  }

  // Launcher

  /**
   * Re-read the launcher from the registered folders, the index and this window.
   *
   * Every index mutation, folder change and lifecycle event that can change a row
   * calls this; the only timer is the registry heartbeat's re-observation of a visible view
   * (ADR-0056), and nothing here scans OMP's
   * session files. The welcome content follows the folder list, because a launcher
   * with no folder has nothing to group and must say how to add one.
   */
  function refreshLauncher(options: { readonly ownership?: boolean } = {}): void {
    const s = windowState();
    if (s.indexForBridge !== null) settleViewedSession(s.indexForBridge);
    void vscode.commands.executeCommand("setContext", SESSIONS_LAYOUT_CONTEXT, sessionsGrouping());
    // Published first: this window's own entry in the registry is what the list is derived from.
    trackOperation("window snapshot", () => s.routing.publishSnapshot());
    trackOperation("Sessions view refresh", () => s.launcherProvider?.refresh(options));
    s.sessionProcesses?.touch();
    s.inventoryViews?.sync();
    s.contextView?.sync();
    if (s.context !== undefined) void vscode.commands.executeCommand("setContext", "ompDesk.defaultSessionMode", defaultSessionMode(s.context));
    void vscode.commands.executeCommand(
      "setContext",
      HAS_WORKSPACE_FOLDERS_CONTEXT,
      (s.launcherFolders?.list().length ?? 0) > 0,
    );
    // Publication notifications rearm selection after roots and folder children
    // have actually been served; ordinary row activity never rebuilds those parents.
    const index = s.indexForBridge;
    if (index !== null) void revealActiveSession(index);
  }

  /**
   * Ask the next launcher reveal to expand this session's folder if the user collapsed it.
   *
   * Set when the user brings a session's editor forward (a tab switch, a row click, a palette
   * Open) and consumed by the reveal that answers it, so a collapse the user makes while
   * staying on the same tab is left alone.
   */
  function requestSessionRowExpand(tabId: string): void {
    const s = windowState();
    s.launcherExpandFor = tabId;
  }

  /**
   * Select the row of the tab that currently has the user's editor focus.
   *
   * Only a visible launcher is touched, so activating an editor panel never pulls focus into
   * the sidebar; a launcher that is hidden keeps the pending expansion until it is shown. A
   * row inside a folder the user collapsed is selected — expanding the folder — only for the
   * reveal that answers the user activating that session ({@link requestSessionRowExpand});
   * any other refresh leaves the collapse the registry recorded as it is.
   */
  function revealActiveSession(index: SessionIndex): Promise<void> {
    const s = windowState();
    s.launcherRevealRequested = true;
    if (s.launcherRevealInFlight !== null) return s.launcherRevealInFlight;
    const reveal = async () => {
      while (s.launcherRevealRequested) {
        s.launcherRevealRequested = false;
        const provider = s.launcherProvider;
        const view = s.launcherView;
        if (!provider || !view || !view.visible || !provider.sessionRowsShown()) return;
        const tabId = pinnedSessionTab(index) ?? sessionsViewActiveTab(index);
        if (tabId === null) { s.launcherSelectedPath = null; return; }
        const expand = s.launcherExpandFor === tabId;
        const reserved = provider.beginReveal(tabId, { expand });
        if (reserved === undefined) return;
        try {
          // A selection that rests on a row another window runs is never "already there": that row is not this window's session.
          if (!expand && s.launcherSelectedPath === reserved.pathKey && !selectionRestsOnOtherWindow(tabId)) continue;
          await view.reveal(reserved.item, { select: true, focus: false, expand: true });
          if ((pinnedSessionTab(index) ?? sessionsViewActiveTab(index)) === tabId) {
            s.launcherSelectedPath = reserved.pathKey;
            if (expand) s.launcherExpandFor = null;
          }
        } catch (error) {
          log.warn(`launcher: could not select tab ${tabId}: ${messageOf(error)}`);
        } finally {
          reserved.release();
        }
      }
    };
    s.launcherRevealInFlight = reveal().finally(() => { s.launcherRevealInFlight = null; });
    return s.launcherRevealInFlight;
  }

  /**
   * Whether the Sessions selection holds only rows another window runs, with `target` as the session this window
   * selects. A click on such a row selects it while it switches to that window, and the selection then stays there
   * after the user comes back; nothing else about this window's own editors would ever move it.
   */
  function selectionRestsOnOtherWindow(target: string): boolean {
    const s = windowState();
    const provider = s.launcherProvider;
    const view = s.launcherView;
    if (provider === undefined || view === undefined) return false;
    const selected = (view.selection ?? []).map(item => item instanceof SessionTreeItem ? item.tabId : null);
    return selectionLeaveOtherWindow(target, selected, tabId => provider.displayedState(tabId) === "otherWindow") !== null;
  }

  /** Put the selection back on this window's own session when it rests on a row another window runs. */
  function releaseSelectionFromOtherWindow(index: SessionIndex): void {
    const s = windowState();
    const target = pinnedSessionTab(index) ?? sessionsViewActiveTab(index);
    if (target === null || s.launcherProvider?.sessionRowsShown() !== true || !selectionRestsOnOtherWindow(target)) return;
    s.launcherSelectedPath = null;
    void revealActiveSession(index);
  }

  /**
   * The session the Sessions view keeps selected: the one whose editor the user viewed most
   * recently among this window's open ones, or `null` while no open editor serves a shown row.
   */
  function pinnedSessionTab(index: SessionIndex): string | null {
    const s = windowState();
    return pinnedSessionTabId(
      s.editorRecency.order().map(slot => {
        const state = s.tabs.get(slot);
        return { tabId: state?.panel != null ? state.tabId : null, shell: state?.shellSlot != null };
      }),
      tabId => index.get(tabId) !== null && s.launcherProvider?.displayedState(tabId) !== undefined,
    );
  }

  /**
   * The row this window's Sessions view selects when it has no open editor to pin: the index's
   * recovered active tab, except a session another window holds, which this window has no
   * editor for and so does not select (the list shows every window's sessions).
   */
  function sessionsViewActiveTab(index: SessionIndex): string | null {
    const s = windowState();
    const tabId = index.activeTabId;
    return tabId !== null && s.launcherProvider?.displayedState(tabId) === "otherWindow" ? null : tabId;
  }

  /**
   * Put the pinned row back when the user cleared the selection or selected a non-session row.
   *
   * The check runs again after a short delay: clicking a folder row selects it and collapses it, and
   * the collapse (recorded asynchronously) must be able to land first, because the restore never
   * expands a folder the user just collapsed; the selection is then read from the view itself.
   */
  function restorePinnedSelection(index: SessionIndex, selection: readonly LauncherTreeItem[]): void {
    const s = windowState();
    const tabIds = (items: readonly LauncherTreeItem[]) => items.map(item => item instanceof SessionTreeItem ? item.tabId : null);
    // The Terminals layout has no session row to pin: a selection there is the user's.
    if (s.launcherProvider?.sessionRowsShown() === false) return;
    if (selectionRestore(pinnedSessionTab(index), tabIds(selection)) === null) return;
    clearTimeout(s.pinnedSelectionTimer);
    s.pinnedSelectionTimer = setTimeout(() => {
      s.pinnedSelectionTimer = undefined;
      if (s.launcherProvider?.sessionRowsShown() === false || selectionRestore(pinnedSessionTab(index), tabIds(s.launcherView?.selection ?? [])) === null) return;
      s.launcherSelectedPath = null;
      void revealActiveSession(index);
    }, PINNED_SELECTION_RESTORE_MS);
    s.pinnedSelectionTimer.unref?.();
  }

  /** How Sessions arranges its rows: the setting, flat by default. */
  function sessionsGrouping(): SessionsGrouping {
    const s = windowState();
    const grouping = normalizeSessionsGrouping(vscode.workspace.getConfiguration("ompDesk").get("sessionsGrouping"));
    if (grouping !== "terminals") s.lastSessionServingLayout = grouping;
    return grouping;
  }

  /** Store the chosen layout; the configuration listener redraws the view. */
  async function setSessionsGrouping(grouping: SessionsGrouping): Promise<void> {
    try {
      await vscode.workspace.getConfiguration("ompDesk").update("sessionsGrouping", grouping, vscode.ConfigurationTarget.Global);
      // The picker writes the user layer; a workspace value of the same setting wins in this window, so say why the layout did not change.
      const inEffect = normalizeSessionsGrouping(vscode.workspace.getConfiguration("ompDesk").get("sessionsGrouping"));
      if (inEffect !== grouping) {
        const overridden = vscode.workspace.getConfiguration("ompDesk").inspect("sessionsGrouping")?.workspaceValue !== undefined;
        void vscode.window.showWarningMessage(
          overridden
            ? `This workspace sets its own Sessions layout, which overrides your choice here. Your choice is saved in your user settings.`
            : `Sessions shows ${SESSIONS_LAYOUT_WORDS[inEffect]}, not the layout you chose: another setting changed it meanwhile.`,
          "Open Settings",
        ).then(action => { if (action === "Open Settings") void vscode.commands.executeCommand("workbench.action.openSettings", "@id:ompDesk.sessionsGrouping"); });
      }
    } catch (error) {
      showError(`Sessions could not switch to ${SESSIONS_LAYOUT_WORDS[grouping]}: ${messageOf(error)}`);
    }
  }

  /**
   * The title-bar layout button: a picker of the three layouts with the current one marked. Every
   * button variant (one icon per layout, so the icon shows what is current) and the palette command
   * open this same picker.
   */
  async function chooseSessionsLayout(): Promise<void> {
    const current = sessionsGrouping();
    const items = sessionsLayoutPickItems(current);
    const picked = await vscode.window.showQuickPick(items, {
      title: "Sessions Layout",
      placeHolder: "Choose how Sessions arranges its rows",
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (picked !== undefined && picked.id !== current) await setSessionsGrouping(picked.id);
  }

  /** Runtime object identity is local; activity and snapshot contents are not. */
  function launcherRuntimeIdentity(tabId: string): string | null {
    const s = windowState();
    const state = stateOf(tabId);
    const runtime = hostOf(state);
    let id: number | null = null;
    if (runtime !== null && runtime !== undefined) {
      id = s.launcherRuntimeIds.get(runtime) ?? ++s.nextLauncherRuntimeId;
      s.launcherRuntimeIds.set(runtime, id);
    }
    const epoch = s.sessionRuntime.conversations.stateOf(tabId)?.epoch ?? null;
    return state === undefined && epoch === null ? null : JSON.stringify([state?.slotId, id, epoch]);
  }

  /** What only this window knows about a tab: its panel, its host, its last outcome. */
  function launcherFacts(tabId: string): SessionLauncherFacts {
    const s = windowState();
    const state = stateOf(tabId) ?? null;
    // A row is open when this window is actually serving its editor: through a panel
    // handle, or — after a host-only restart — through a bridge document whose page is
    // still in VS Code's own membership. An index row or a stored secret alone is not
    // an open editor.
    const bridge = state?.bridge ?? null;
    const orphan =
      bridge !== null &&
      bridge.documentId !== null &&
      bridge.endpoint.serving &&
      s.bridgeLiveEditors.has(bridge.editorId);
    const entry = s.indexForBridge?.get(tabId) ?? null;
    // The host owns the conversation whether or not a page shows it, so the activity is the
    // turn state of its own session: a closed tab reports exactly what an open one does.
    const activity = s.turnActivities.get(tabId) ?? null;
    const phase = s.sessionRuntime.conversations.stateOf(tabId)?.phase ?? null;
    const hosted = hostOf(state);
    return {
      open: state !== null && (state.panel !== null || orphan),
      viewMode: state !== null && state.panel !== null && hosted !== null ? hosted.kind : null,
      // Native owns a PTY, not an RPC conversation. Use the actual writer's state.
      running: hosted !== null && (hosted.kind === "terminal"
        ? hosted.handle.state === "running"
        : phase !== null && rpcPhaseIsRunning(phase)),
      launching: s.indexForBridge?.isLaunching(tabId) ?? false,
      stopping: s.stoppingTabs.has(tabId),
      outcome: s.outcomes.get(tabId) ?? null,
      restoring: s.catalogAdoption.startupCovers(s.indexForBridge, tabId),
      activity:
        activity === null
          ? null
          : {
              pendingQuestion: activity.pendingRequest !== null,
              working: activity.streaming,
              backgroundWork: activity.backgroundWork,
              settled: activity.settled,
              // The trailing-question heuristic is derived from the host's own model and
              // projected through {@link reportsTrailingQuestion}, which refuses to present it
              // for a turn that ended in an error or was aborted.
              trailingQuestion: reportsTrailingQuestion(activity),
              lastCompletedReplyId: entry?.lastCompletedReplyId ?? null,
              lastSeenReplyId: entry?.lastSeenReplyId ?? null,
            },
    };
  }

  /**
   * Read the claim's live holder before offering actions on a row this window does not run.
   *
   * `externalOmp` adds one more fact (ADR-0046): a plain `omp` process outside this extension
   * holds the session's OMP lease. It is asked only when nothing this extension owns can be the
   * holder: another window's live claim (that row is "Open in another window"), this window's
   * own live claim and a verified writer under one of this extension's brokers all win, because
   * their children hold leases too. `fresh` skips the short cache, for an open that must not
   * act on a verdict older than the click.
   *
   * A read that only paints a row (not `fresh`) waits for the startup restore before it proves a writer or asks the lease:
   * both start PowerShell processes that compete with the restore (`startupRestoreOver`). Until then the row reads
   * "Restoring" or "Checking". A row another live window holds needs neither, so its claim read is not deferred.
   */
  async function launcherOwnershipFacts(index: SessionIndex, tabId: string, options: { readonly fresh?: boolean } = {}): Promise<SessionOwnershipFacts> {
    const s = windowState();
    const observed = await index.observeOwnership(tabId);
    const claim = observed.ok ? observed.claim : null;
    // What the rows and the click's choice of window show: the holder's liveness is read without blocking the extension host and
    // is never what admits or refuses a launch, a stop or a deletion (those ask claimHolderMayBeAlive themselves).
    const heldElsewhere = claim !== null && claim.verifiable && claim.holderId !== null &&
      claim.holderId !== index.claimHolder.id && await holderSeemsAlive(claim, s.routing.registry());
    const heldHere = claim !== null && claim.holderId === index.claimHolder.id && await claimHolderMayBeAlive(claim);
    if (options.fresh !== true && !heldElsewhere) await s.catalogAdoption.startupRestoreOver();
    const pid = await s.sessionRuntime.verifiedWriterPid(tabId, { display: true });
    const sessionFile = index.get(tabId)?.sessionFile ?? null;
    const externalOmp = !heldElsewhere && !heldHere && pid === null && sessionFile !== null && s.externalLeases !== null &&
      await s.externalLeases.holds(sessionFile, options) === true;
    return { heldElsewhere, heldBy: heldElsewhere ? claim?.holderId ?? null : null,
      heldGeneration: heldElsewhere ? claim?.ownerGeneration ?? null : null,
      switchableWindow: heldElsewhere && claim?.windowUri?.startsWith("file:") === true,
      externalOmp, ownershipChecked: observed.ok, ownedWriterPid: pid,
      legacyWriter: pid !== null && index.get(tabId)?.host?.transport !== "rpc" };
  }

  /**
   * Ask before a session another OMP process writes is opened here (ADR-0046). Nothing is
   * launched by asking; "Open Anyway" is the only answer that lets the launch proceed, and
   * OMP then moves this window's writes to a sibling file instead of mixing them in.
   */
  async function confirmOpenAnyway(): Promise<boolean> {
    const choice = await vscode.window.showWarningMessage(
      "This session is open in another OMP process.",
      {
        modal: true,
        detail:
          "Another OMP process that this window does not run, most likely a terminal, is writing this session. If you open it here, " +
          "OMP will notice and save this window's turns to a new sibling file instead of mixing them into the one that process " +
          "writes. The conversation continues in that new file; nothing is deleted or merged.",
      },
      OPEN_ANYWAY,
    );
    return choice === OPEN_ANYWAY;
  }

  /**
   * Re-read the ownership of the rows filed under claims that changed on disk.
   *
   * Another window taking or releasing a session is only visible as its claim file appearing,
   * being replaced or going away. Only the affected rows are re-observed, through the same
   * observation the view always uses, so a burst of claim writes costs the rows it names and
   * nothing else. An empty set means the watcher could not say which claims changed.
   */
  function refreshRowsForClaims(index: SessionIndex, claimFiles: ReadonlySet<string>): void {
    const s = windowState();
    const provider = s.launcherProvider;
    if (provider === undefined) return;
    if (claimFiles.size === 0) {
      provider.refresh({ ownership: true });
      return;
    }
    const tabIds = new Set<string>();
    for (const entry of index.list()) {
      const target = entry.sessionFile ?? entry.ownership?.draftIdentity ?? null;
      if (target === null) continue;
      let name = s.claimFileNames.get(target);
      if (name === undefined) {
        try {
          name = claimFileNameFor(index.claimStorageDir, target);
        } catch {
          // An identity that cannot be filed under a claim has no claim file to watch.
          name = null;
        }
        s.claimFileNames.set(target, name);
      }
      if (name !== null && claimFiles.has(name)) tabIds.add(entry.tabId);
    }
    provider.refreshOwnership(tabIds);
  }

  /**
   * Replace the launcher's view of the last restore attempt with one pass's
   * results. Drafts and skipped tabs carry no outcome: their status is exactly
   * what the index recorded for them, and a row the pass did not consider keeps
   * whatever an explicit open reported for it.
   */
  function recordOutcomes(report: RestoreReport): void {
    const s = windowState();
    // Only the rows this pass considered lose their previous outcome: a pass pinned
    // to the activation cohort must not erase what an explicit open reported for a
    // row it did not touch. (A pass over every row resets all of them, since every
    // row is in `order`.)
    for (const tabId of report.order) s.outcomes.delete(tabId);
    for (const session of report.restored) {
      s.outcomes.set(session.tabId, {
        status: "restored",
        tabId: session.tabId,
        sessionFile: session.sessionFile,
        host: session.host,
      });
    }
    for (const session of report.attached) {
      s.outcomes.set(session.tabId, {
        status: "attached",
        tabId: session.tabId,
        sessionFile: session.sessionFile,
        detail: session.detail,
      });
    }
    for (const conflict of report.conflicts) {
      s.outcomes.set(conflict.tabId, {
        status: "conflict",
        tabId: conflict.tabId,
        kind: conflict.kind,
        detail: conflict.detail,
      });
    }
    for (const failure of report.failures) {
      s.outcomes.set(failure.tabId, {
        status: "failed",
        tabId: failure.tabId,
        kind: failure.kind,
        detail: failure.detail,
      });
    }
  }

  /**
   * Pick one indexed launcher entry by name.
   *
   * Used by the commands whose argument is optional: Open/Resume, Forget from
   * Launcher and Delete Session. Only the open commands act on ownership — through
   * the ordinary admitted open path — while Forget and Delete are management paths
   * that never open, restore or claim anything here.
   *
   * Rows use the launcher's own labels — OMP's session title when the session file
   * carries one — so the quick pick and the sidebar never disagree about which
   * session is which.
   */
  async function pickIndexedTab(index: SessionIndex, title: string): Promise<string | null> {
    const entries = index.list();
    if (entries.length === 0) {
      showError('No OMP session is indexed for this workspace yet. Start one with "New Session".');
      return null;
    }
    const picked = await vscode.window.showQuickPick(
      await Promise.all(
        entries.map(async entry => {
          const header = entry.sessionFile === null ? null : await readSessionFileHeader(entry.sessionFile);
          return {
            label: sessionHeadline(entry, header),
            description: `${entry.availability} · ${sessionFileLabel(entry)}`,
            detail: entry.detail ?? entry.cwd,
            tabId: entry.tabId,
          };
        }),
      ),
      { title },
    );
    return picked ? picked.tabId : null;
  }

  /** The tab a command was invoked on: a launcher row, or an explicit tab id. */
  function tabIdArgument(argument: unknown): string | null {
    if (typeof argument === "string" && argument.length > 0) return argument;
    if (typeof argument !== "object" || argument === null || !("tabId" in argument)) return null;
    const tabId = argument.tabId;
    return typeof tabId === "string" && tabId.length > 0 ? tabId : null;
  }

  function showError(message: string): void {
    void vscode.window.showErrorMessage(`OMP Desk: ${message}`);
  }

  function showWarning(message: string): void {
    void vscode.window.showWarningMessage(`OMP Desk: ${message}`);
  }

  function showInfo(message: string): void {
    void vscode.window.showInformationMessage(`OMP Desk: ${message}`);
  }

  /** Tell the user another window holds the session, and offer to move it here (`ompDesk.moveSessionHere`). */
  function showClaimConflict(tabId: string, message: string): void {
    void vscode.window.showErrorMessage(`OMP Desk: ${message}`, MOVE_TO_THIS_WINDOW_ACTION).then(choice => {
      if (choice === MOVE_TO_THIS_WINDOW_ACTION) void vscode.commands.executeCommand("ompDesk.moveSessionHere", tabId);
    });
  }

  /** `ompDesk.moveSessionHere`: the row's session, else the editor in front, else the active session, as Close and Rename resolve it. */
  async function moveSessionHere(context: vscode.ExtensionContext, index: SessionIndex, argument: unknown): Promise<void> {
    const target = sessionTargetFromArgument(index, argument);
    if (target === null) {
      showWarning("Select an OMP session to move.");
      return;
    }
    await windowState().routing.moveSessionHere(context, index, target.tabId);
  }

  function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  setProcessProbeObserver(probe => windowTiming("process start time read", `pid ${probe.pid} ${probe.purpose} ${probe.ms} ms found=${probe.found}`));

  setToolSpawnObserver(spawn => log[spawn.outcome === "ok" ? "debug" : "warn"](formatToolSpawn(spawn)));

  /** One line of the hand-over timeline between windows (ADR-0056/0057); the log stamps each line itself. Per-step lines are `debug`; a summary is passed `info`. */
  function windowTiming(event: string, detail = "", level: "debug" | "info" = "debug"): void {
    log[level](`window timing: ${event}${detail === "" ? "" : ` ${detail}`}`);
  }

  /**
   * `vscode.commands.registerCommand` with the handler marked as a named operation of the event-loop monitor, so a stall of the
   * extension host names the command that was running (and how long its synchronous part held the thread).
   */
  function registerDeskCommand(id: string, handler: (...args: never[]) => unknown): vscode.Disposable {
    return vscode.commands.registerCommand(id, (...args: never[]) => trackOperation(`command ${id}`, () => handler(...args)));
  }

  /**
   * The settings the migration of ADR-0068 reads and writes. `inspect` reports a key no extension contributes, `update` can remove one,
   * and a new key must be contributed to be written (measured in VS Code 1.141.0; see the design).
   */
  function legacySettingsPort(context: vscode.ExtensionContext, foreignSettings: ReadonlySet<string>): LegacySettingsPort {
    const contributed = (context.extension?.packageJSON as { contributes?: { configuration?: { properties?: Record<string, { scope?: string }> } } } | undefined)
      ?.contributes?.configuration?.properties ?? {};
    const workspaceSettingsFile = (): string | null => {
      const file = vscode.workspace.workspaceFile;
      if (file !== undefined) return file.scheme === "file" ? file.fsPath : null;
      const folder = vscode.workspace.workspaceFolders?.[0];
      return folder !== undefined && folder.uri.scheme === "file" ? path.join(folder.uri.fsPath, ".vscode", "settings.json") : null;
    };
    return {
      inspect: key => vscode.workspace.getConfiguration().inspect(key),
      update: (key, value, layer) => Promise.resolve(
        vscode.workspace.getConfiguration().update(key, value, layer === "user" ? vscode.ConfigurationTarget.Global : vscode.ConfigurationTarget.Workspace),
      ),
      workspaceAllowed: key => {
        const scope = contributed[key]?.scope;
        return scope !== "application" && scope !== "machine" && scope !== "machine-overridable";
      },
      workspaceSettingsFile,
      // Only a refusal of the file system counts: a missing file is created by VS Code.
      isWritable: async file => {
        try {
          await access(file, fsConstants.W_OK);
          return true;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          return code !== "EPERM" && code !== "EACCES";
        }
      },
      foreignSettings,
      ...fileClaim(path.join(context.globalStorageUri.fsPath, "settings-move.claim")),
      delay: ms => delayMs(ms),
      log,
    };
  }

  /** `setContext` for a key of this extension; the keys default keybindings used are also set under their old names (`legacy-aliases.ts`). */
  function setDeskContext(key: string, value: unknown): void {
    void vscode.commands.executeCommand("setContext", key, value);
    if (legacyContextMirror) {
      const old = legacyContextKey(key);
      if (old !== null) void vscode.commands.executeCommand("setContext", old, value);
    }
  }

  /** The OMP Desk log: silent before activation (there is no window yet), the window's `LogOutputChannel` after. */
  const log: Logger = {
    error: message => state?.output?.error(message),
    warn: message => state?.output?.warn(message),
    info: message => state?.output?.info(message),
    debug: message => state?.output?.debug(message),
    trace: message => state?.output?.trace(message),
  };

  /**
   * Whether the installed package no longer holds the bytes this host started from. The first
   * detection of an episode is logged and offered as a Reload Window notification; every later
   * document build asks again, because a user may have dismissed it.
   */
  function packageChangedOnDisk(): boolean {
    const s = windowState();
    const verdict = s.packageDrift?.check() ?? { kind: "same" as const };
    const stale = verdict.kind !== "same";
    if (stale !== s.packageStale) {
      s.packageStale = stale;
      // At once, not at the next heartbeat: another window may be about to choose this one for a launch.
      s.routing.publishSnapshot();
      void s.windowRegistry?.flush();
    }
    if (verdict.kind === "same") {
      s.packageDriftAnnounced = false;
      return false;
    }
    if (!s.packageDriftAnnounced) {
      s.packageDriftAnnounced = true;
      log.warn(`the installed extension changed on disk under this window (${verdict.files.join(", ")}); a reload finishes the update.`);
      void vscode.window.showWarningMessage(UPDATED_ON_DISK_DETAIL, RELOAD_WINDOW_LABEL).then(choice => {
        if (choice === RELOAD_WINDOW_LABEL) void vscode.commands.executeCommand("workbench.action.reloadWindow");
      });
    }
    return true;
  }

  /**
   * Register one panel's own listeners for one editor slot (ADR-0025).
   *
   * The registration captures the **immutable editor slot** and the exact panel, not
   * the conversation: a listener always answers for the editor it was registered for,
   * and what that editor shows is resolved from live state at dispatch time. A superseded
   * panel's listeners are inert because they compare the panel they were given against
   * the one the slot holds now.
   *
   * A non-controlling slot is answered separately: it may still render (and copy) and
   * page back through the conversation, but no message of its own can reach the session.
   */
  function registerPanelLifecycle(
    index: SessionIndex,
    slot: string,
    panel: vscode.WebviewPanel,
  ): void {
    const s = windowState();
    let wasActive = panel.active;
    if (panel.active) s.editorRecency.touch(slot);
    panel.webview.onDidReceiveMessage(message => {
      // A disposed panel must not send a late request into a replacement editor.
      const state = s.tabs.get(slot);
      if (state?.panel !== panel || state.tabId === null) return;
      // A page whose bundle did not load or mount says so once; the log is where that is visible afterwards.
      if (typeof message === "object" && message !== null && "type" in message && message.type === PAGE_START_FAILED_MESSAGE && state.document?.kind === "guest") {
        const reason = "reason" in message ? PAGE_START_FAILURE_REASONS.find(known => known === message.reason) : undefined;
        log.warn(`slot ${slot}: the chat page did not start (${reason ?? "unknown reason"}); the installed package ${packageChangedOnDisk() ? "changed" : "did not change"} on disk since this window started`);
        return;
      }
      // A page's liveness report is the host monitor's alone: the editor's own handlers never see it, whichever editor the page belongs to.
      if (typeof message === "object" && message !== null && "type" in message && message.type === "omp:page-health") {
        const report = parseGuestWebviewMessage(message);
        const reported = state.document;
        if (report?.type === "omp:page-health" && reported?.kind === "guest") {
          // Watched only while this very document is the visible one of the panel: a document the host replaced meanwhile (a mode switch,
          // an explanation page that loads no bundle) is not a silent page.
          const showing = (): boolean => {
            try {
              const current = s.tabs.get(slot);
              return current?.panel === panel && current.document === reported && panel.visible;
            } catch {
              return false;
            }
          };
          // The user is here when the window has the focus and this tab is the active editor of its group.
          const userHere = (): boolean => {
            try {
              return vscode.window.state.focused && panel.active;
            } catch {
              return false;
            }
          };
          s.pageHealth.note(slot, { panel, document: reported, label: `tab ${state.tabId}`, visible: showing, windowFocused: userHere }, report);
        }
        return;
      }
      // The Reload Window button of the updated-on-disk page (honoured only while the installed package really changed under
      // this host) and of a chat page that could not start (the page shows it only after a failed start, drift or not).
      if (typeof message === "object" && message !== null && "type" in message && message.type === UNAVAILABLE_RELOAD_MESSAGE && (state.document?.kind === "guest" || (state.document?.kind === "unavailable" && packageChangedOnDisk()))) {
        void vscode.commands.executeCommand("workbench.action.reloadWindow");
        return;
      }
      const handling = dispatchSlotMessage(index, slot, panel, message);
      void handling.catch(() => {
        log.warn(`slot ${slot}: a guest message could not be processed`);
      });
    });
    panel.onDidDispose(() => {
      s.pageHealth.forget(slot, panel);
      const current = s.tabs.get(slot);
      if (current === undefined || current.panel !== panel) {
        // A superseded panel. This slot is bound to the panel that replaced it, and
        // this close must not clear the replacement's page.
        log.debug(`slot ${slot}: a superseded webview closed`);
        return;
      }
      if (current.tabId !== null) cancelControlPicker(current.tabId);
      s.draftRestores.delete(slot);
      void s.guestDispatcher.forgetDraft(slot).catch(() => log.warn(`slot ${slot}: the saved draft could not be deleted`));
      forgetTerminalCopy(current);
      current.panel = null;
      s.editorRecency.forget(slot);
      current.origin = null;
      current.heldReadyReport = null;
      // The page is gone, so nothing is delivered to it; the conversation itself is the
      // host's and keeps running, notifying and reconciling without an editor.
      current.chatDetach?.();
      current.chatDetach = null;
      current.document = null;
      // The user's close is an intent of its own, numbered against the open requests
      // for this editor: an attempt that is still waiting must not undo it.
      s.editorEventSequence += 1;
      current.lastEditorClose = s.editorEventSequence;
      refreshGuestContext();
      // The editor this window watched close is retired here, not at shutdown: its tab
      // reservation is released so the row can be opened again, and its endpoint, exact
      // port and secret are forgotten because nothing may be served from a closed
      // editor's records. A host-only restart disposes no editor, and its records must
      // survive for the page that is still running.
      windowState().bridgeHost.retireClosedEditor(slot);
      log.debug(`slot ${slot}: webview closed; the OMP process keeps running`);
      refreshLauncher();
    });
    panel.onDidChangeViewState(event => {
      const state = s.tabs.get(slot);
      if (state?.panel !== panel) return;
      const activated = event.webviewPanel.active && !wasActive;
      wasActive = event.webviewPanel.active;
      // Input ownership follows what the user can see: a hidden editor's pane must not
      // keep the broker's input slot.
      state.pipeline?.notePanelVisible(event.webviewPanel.visible);
      // Deactivation must clear editor-title and Stop contexts as well as activation.
      refreshGuestContext();
      if (event.webviewPanel.active && state.tabId !== null) s.editorRecency.touch(slot);
      if (activated) { s.inventoryViews?.refresh(); s.contextView?.refresh(); }
      if (!event.webviewPanel.active || state.tabId === null) return;
      if (activated) {
        activateNativeEditor(state);
        requestSessionRowExpand(state.tabId);
      }
      void setActiveTab(index, state.tabId);
      refreshLauncher();
      void revealActiveSession(index);
    });
  }

  /**
   * Route one page message to the controlling or the non-controlling handler.
   *
   * A fresh editor is published as a passive surface until this window has recorded its
   * control of the session, and the page may already be talking by then: its footer asks
   * for the host's controls the moment it mounts, and a prompt can follow within seconds.
   * Such a command must neither be dropped nor sent by an editor that does not control
   * the session, so it waits — bounded — for the election that is already in flight and is
   * then routed on the *outcome*: delivered exactly once when the editor became the
   * controller, refused visibly (with the reason) when it did not. A message that needs no
   * authority (presentation, paging, `omp:ready`) never waits.
   */
  function dispatchSlotMessage(index: SessionIndex, slot: string, panel: vscode.WebviewPanel, message: unknown): Promise<void> {
    const s = windowState();
    const route = (): Promise<void> =>
      passiveReasonForSlot(slot) === null ? s.guestDispatcher.handleMessage(index, slot, panel, message) : handlePassiveSlotMessage(slot, panel, message);
    if (passiveReasonForSlot(slot) === null || !s.slotElections.has(slot)) return route();
    const type = parseGuestWebviewMessage(message)?.type;
    if (type === undefined || ELECTION_GATED_TYPES[type] !== true) return route();
    return awaitElection(slot).then(() => {
      // The wait is where an editor is closed or replaced: only the panel still serving the
      // slot may be answered.
      const state = s.tabs.get(slot);
      if (state?.panel !== panel || state.tabId === null) return;
      return route();
    });
  }

  /**
   * Answer one message from a non-controlling editor.
   *
   * Presentation and a view-only page's explicit Resume admission request are allowed.
   * Resume must still pass the index's claim-and-launch checks; it grants no authority
   * over a running writer. Prompts, aborts, approvals and control reads are refused here
   * and by the fences the host applies when the slot is demoted.
   */
  async function handlePassiveSlotMessage(slot: string, panel: vscode.WebviewPanel, message: unknown): Promise<void> {
    const s = windowState();
    const state = s.tabs.get(slot);
    if (state?.panel !== panel || state.tabId === null) return;
    const parsed = parseGuestWebviewMessage(message);
    if (parsed === null) return;
    if (parsed.type === "omp:focus-trace") {
      log.debug(`tab ${state.tabId}: focus (non-controlling editor): ${parsed.detail}`);
      return;
    }
    if (parsed.type === "omp:selection-reply") {
      s.guestDispatcher.acceptSelectionReply(slot, panel, parsed);
      return;
    }
    if (parsed.type === "omp:terminal-copy-reply") {
      await acceptTerminalCopy(state, parsed);
      return;
    }
    if (parsed.type === "omp:open-detail") {
      s.guestDispatcher.openDetailTab(state.tabId, state.mode, parsed);
      return;
    }
    if (parsed.type === "omp:open-mermaid") {
      s.guestDispatcher.openMermaidTab(parsed.source);
      return;
    }
    if (parsed.type === "omp:open-artifact") {
      await s.guestDispatcher.openArtifact(state.tabId, parsed);
      return;
    }
    if (parsed.type === "omp:ready") {
      // The document proves it can receive: it is sent the conversation again. Its origin
      // report is kept for the moment this editor may act — a page announces itself once, and
      // dropping the report here would leave the document uncommitted for good.
      if (parsed.documentId !== undefined && parsed.bootstrapId !== undefined && parsed.origin !== undefined) {
        state.heldReadyReport = { documentId: parsed.documentId, bootstrapId: parsed.bootstrapId, origin: parsed.origin };
      }
      noteReadyDocument(state, parsed.documentId);
      pushSessionView(s.indexForBridge, state, true);
      activateNativeEditor(state);
      s.sessionRuntime.conversations.resend(state.tabId, panelPageId(panel));
      return;
    }
    if (parsed.type === "omp:chat-load-older" || parsed.type === "omp:chat-resume" ||
        parsed.type === "omp:chat-subagent-read" || parsed.type === "omp:chat-magic-keywords-read") {
      await s.guestDispatcher.runChatCommand(state.tabId, parsed, panelChatPage(state, panel));
      return;
    }
    if (TERMINAL_PANEL_TYPES[parsed.type] === true) {
      // Presentation only: focus, visibility, and the pane's own input and resize, which the
      // read-only pipeline refuses for this frontend.
      await handleTerminalGuestMessage(slot, parsed, parsed as unknown as Record<string, unknown>);
      return;
    }
    if (parsed.type === "omp:control-request") {
      // A page that asked is waiting for exactly this answer; dropping it would leave its
      // footer waiting for an outcome that never comes. Nothing was dispatched.
      const reason = passiveReasonForSlot(slot) ?? PASSIVE_REASON_DEFAULT;
      const refusal: GuestControlStateMessage = {
        type: "omp:control-state",
        scope: parsed.scope,
        requestId: parsed.requestId,
        available: false,
        model: null,
        thinkingLevel: null,
        mutationMode: "unavailable",
        reason,
        ...(parsed.action === "snapshot" ? {} : { notice: "No change was sent." }),
      };
      void panel.webview.postMessage(refusal);
      log.debug(`slot ${slot}: a non-controlling editor's ${parsed.type} was answered as unavailable`);
      return;
    }
    if (CHAT_COMMAND_TYPES.has(parsed.type)) {
      // The conversation refuses a write from a route that may not write, and tells this page
      // why, so the refusal is visible instead of a prompt vanishing.
      await s.guestDispatcher.runChatCommand(state.tabId, parsed as ChatWebviewMessage, panelChatPage(state, panel));
      return;
    }
    if (parsed.type === "omp:chat-command") {
      if (parsed.command === "provider-login" && s.context !== undefined && s.indexForBridge !== null) {
        await runChatAction(s.context, s.indexForBridge, state.tabId, parsed.command);
        return;
      }
      showWarning(`${passiveReasonForSlot(slot) ?? PASSIVE_REASON_DEFAULT} The action was not run.`);
      return;
    }
    log.debug(`slot ${slot}: a non-controlling editor's ${parsed.type} was refused`);
  }

  /**
   * The broker frontend one editor owns.
   *
   * It is the immutable editor slot, never the conversation: the process is the same
   * one across a settled switch, so its input owner must not change identity when the
   * conversation it serves does.
   */
  function terminalFrontendId(key: string): string {
    return stateOf(key)?.slotId ?? key;
  }

  /** `true` for a map key that serves an indexed conversation (never a shell). */
  function isSessionTab(key: string): boolean {
    const s = windowState();
    const conversation = stateOf(key)?.tabId ?? null;
    return conversation !== null && s.indexForBridge?.get(conversation) != null;
  }

  /** A synthetic generation for "this editor has no writer", so a pane has something to reset on. */
  function absentTerminalGeneration(tabId: string): string {
    return createHash("sha256").update(`omp-pty-absent\0${tabId}`, "utf8").digest("hex").slice(0, 32);
  }

  /**
   * Push one terminal message to whichever transport this editor currently has.
   *
   * The panel route wins whenever this host holds the panel handle: it is the
   * page's own channel and needs no route acknowledgement. A surviving page whose
   * panel this host does not have is reached over its authenticated bridge instead.
   */
  function pushTerminalTo(tabId: string, message: TerminalHostMessage | TerminalLinkValidation | SymbolLinksResolution | SymbolLinksRetry): void {
    const state = stateOf(tabId);
    if (state === undefined) return;
    if (state.panel !== null) {
      void state.panel.webview.postMessage(message);
      return;
    }
    const bridge = state.bridge;
    if (bridge === null || bridge.documentId === null) return;
    bridge.endpoint.pushTerminal(bridge.documentId, message);
  }

  /** Answer an attach when there is no writer this host can reach. */
  function pushTerminalUnavailable(tabId: string, reason: string): void {
    pushTerminalTo(tabId, {
      type: "omp:terminal-state",
      generation: absentTerminalGeneration(tabId),
      seq: 1,
      phase: "unavailable",
      input: false,
      cols: 80,
      rows: 24,
      snapshot: "none",
      reason,
    });
  }

  /**
   * The host side of one tab's terminal, created once per writer.
   *
   * The pipeline owns ownership, framing and the seen rule; this function only binds
   * it to a live broker writer and to the page that will render it. A tab whose
   * writer is an adopted legacy VS Code terminal has no pipeline at all: that PTY
   * cannot be handed to the renderer, and ADR-0024 forbids restarting it invisibly.
   */
  function ensureTerminalPipeline(
    index: SessionIndex,
    tabId: string,
    handle: PtyHandle,
    label?: string | null,
  ): TerminalPipeline {
    const s = windowState();
    const state = tabState(tabId);
    if (state.pipeline !== null) return state.pipeline;
    const cwd =
      label ??
      (state.shellSlot !== null
        ? s.shellSlots?.get(state.shellSlot)?.cwd ?? null
        : state.tabId === null
          ? null
          : index.get(state.tabId)?.cwd ?? null);
    const pipeline = new TerminalPipeline({
      writer: terminalWriterForHandle(handle),
      label: cwd === null ? null : path.basename(cwd),
      description: state.shellSlot === null ? null : shellCleanupDescription(handle.statusValue?.ownerStop?.state),
      // This slot's own authority, seeded at construction: a pipeline created *after* the
      // role was already applied — a restored non-controlling editor, or one rebuilt by a
      // settled switch — must start fenced rather than learn it later, or it could take the
      // broker's input slot before anything told it not to. A folder shell has no registry
      // entry, so it is never fenced here.
      authority: fencedOf(state) ? "The session view is changing or its process is stopping." : passiveReasonForSlot(state.slotId),
      // Only the managed native OMP TUI repaints its whole screen on a size change; a folder shell's
      // prompt would just be redrawn on top of its own history.
      redrawAfterRestore: state.shellSlot === null,
    });
    state.pipeline = pipeline;
    pipeline.register(terminalFrontendId(tabId), message => pushTerminalTo(tabId, message));
    pipeline.notePanelVisible(state.panel?.visible === true);
    void pipeline.start();
    return pipeline;
  }

  /** Drop a tab's terminal frontend; the broker keeps running. */
  function stopTerminalForTab(tabId: string): void {
    const state = stateOf(tabId);
    if (state === undefined) return;
    // The shell title watcher belongs to the editor that showed the verdict, so it ends with
    // it: a subscription left alive would keep a disposed panel (or a replaced handle) in
    // memory and could write to a title nothing reads.
    state.ownerStopWatch?.();
    state.ownerStopWatch = null;
    if (state.pipeline === null) return;
    state.pipeline.dispose();
    state.pipeline = null;
  }

  function terminalCwd(state: TabState): string | undefined {
    const s = windowState();
    return hostOf(state)?.cwd ??
      (state.tabId === null ? undefined : s.indexForBridge?.get(state.tabId)?.cwd) ??
      (state.shellSlot === null ? undefined : s.shellSlots?.get(state.shellSlot)?.cwd);
  }

  function terminalFontResource(state: TabState): vscode.Uri | undefined {
    const cwd = terminalCwd(state);
    return cwd === undefined ? undefined : vscode.Uri.file(cwd);
  }

  function terminalFontMessage(resource?: vscode.Uri): GuestTerminalFontMessage {
    const s = windowState();
    const terminal = vscode.workspace.getConfiguration("terminal.integrated", resource);
    const editor = vscode.workspace.getConfiguration("editor", resource);
    return {
      type: "omp:terminal-font",
      fontFamily: terminalFontFamily(terminal.get<string>("fontFamily")?.trim() || editor.get<string>("fontFamily", "monospace"), s.installedTerminalFonts),
      fontSize: terminal.get<number>("fontSize", 14),
      lineHeight: terminal.get<number>("lineHeight", 1),
      letterSpacing: terminal.get<number>("letterSpacing", 0),
    };
  }

  function pushTerminalFont(state: TabState, resource = terminalFontResource(state)): void {
    readInstalledTerminalFonts();
    void state.panel?.webview.postMessage(terminalFontMessage(resource));
  }

  /**
   * Read the installed Nerd Font families once, when the first terminal pane asks for its font, and push the
   * answer to every terminal pane then open. The read is a PowerShell command that loads System.Drawing,
   * a second or more of CPU; at activation it competed with the start-time read and with VS Code's own
   * startup in every window, for panes that most windows never open.
   */
  function readInstalledTerminalFonts(): void {
    const s = windowState();
    s.installedTerminalFontsRead ??= installedNerdFonts().then(families => {
      if (families.length === 0) return;
      s.installedTerminalFonts = families;
      for (const state of s.tabs.values()) if (state.mode === "terminal" || state.shellSlot !== null) pushTerminalFont(state);
    });
  }

  function symbolLinkResolver(): SymbolLinkResolver {
    const s = windowState();
    if (s.symbolLinks !== undefined) return s.symbolLinks;
    const resolver: SymbolLinkResolver = new SymbolLinkResolver({
      async query(text, last) {
        const found = await vscode.commands.executeCommand<vscode.SymbolInformation[] | undefined>("vscode.executeWorkspaceSymbolProvider", text);
        if (!Array.isArray(found)) return null;
        // Providers return fuzzy, ranked lists. Only entries that could be a declaration named `last` are converted,
        // so unrelated neighbours (`DeskManager` for `Desk`) never crowd the exact ones out of the bound; one past
        // the bound tells the resolver the answer was cut.
        const candidates: vscode.SymbolInformation[] = [];
        for (const symbol of found) {
          if (isNameCandidate(String(symbol.name), last)) candidates.push(symbol);
          if (candidates.length > MAX_SYMBOL_ENTRIES) break;
        }
        return Object.assign(candidates.map(symbolEntry), { total: found.length });
      },
      // The type hierarchy of the same provider (the C# language server serves it): a member the qualifier's type inherits is declared in a base class.
      hierarchy: {
        async prepare(entry) {
          const items = await vscode.commands.executeCommand<vscode.TypeHierarchyItem[] | undefined>("vscode.prepareTypeHierarchy", vscode.Uri.file(entry.path), new vscode.Position(entry.line - 1, Math.max(entry.column, 1) - 1));
          return Array.isArray(items) ? items.map(hierarchyNode) : [];
        },
        async supertypes(node) {
          const items = await vscode.commands.executeCommand<vscode.TypeHierarchyItem[] | undefined>("vscode.provideSupertypes", node.token);
          return Array.isArray(items) ? items.map(hierarchyNode) : [];
        },
      },
    }, {
      log,
      files: new FileNameLinkResolver(workspaceFileNameSource(vscode), { log, onDrained: () => resolver.filesDrained() }),
      // Parked tokens (provider not ready, queue full) are asked again by every page that has asked.
      onRetry: () => {
        for (const slotId of [...s.symbolAskers]) {
          if (stateOf(slotId) === undefined) s.symbolAskers.delete(slotId);
          else pushTerminalTo(slotId, { type: "omp:terminal-link-symbols-retry" });
        }
      },
    });
    // Which files exist and what they contain are separate questions: a created, deleted or renamed file can change a file-name
    // answer, a change or a save cannot, and a busy repository changes contents constantly. Events for files no lookup can
    // return (below `.git`, hidden by their folder's own excludes: a Unity project's `Temp/` and `Library/`) are dropped, and a
    // burst of the rest is one invalidation (docs/designs/2026-10-10-code-symbol-links.md, "Fencing").
    const dropFiles = (why: string) => resolver.invalidate(why);
    const dropContent = (why: string) => resolver.invalidateContent(why);
    const gate = new FileEventGate({
      folders: () => (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath),
      excludes: folder => excludePatterns(...folderExcludeSettings(vscode, folder)),
      dropFiles,
      dropContent,
      log,
    });
    const watcher = vscode.workspace.createFileSystemWatcher("**/*");
    s.context?.subscriptions.push(
      watcher,
      watcher.onDidCreate(uri => gate.event("created", uri.fsPath)), watcher.onDidChange(uri => gate.event("changed", uri.fsPath)), watcher.onDidDelete(uri => gate.event("deleted", uri.fsPath)),
      vscode.workspace.onDidSaveTextDocument(document => dropContent(`saved ${document.uri.fsPath}`)),
      vscode.workspace.onDidRenameFiles(() => gate.renamed()),
      vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration("files.exclude") || event.affectsConfiguration("search.exclude")) gate.resetExcludes(); }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => { resolver.resetReadiness(); gate.resetExcludes(); dropFiles("workspace folders changed"); }),
      { dispose: () => { gate.dispose(); if (s.symbolLinks === resolver) s.symbolLinks = undefined; } },
    );
    s.symbolLinks = resolver;
    return resolver;
  }

  /** `ompDesk.searchSymbolFromChat` for a non-empty selection: the link resolver's lookup in the folders of the conversation `tabId` shows (see {@link searchSymbol}). */
  async function searchSymbolFromSelection(query: string, tabId: string): Promise<void> {
    const s = windowState();
    const cwd = s.sessionRuntime.records.get(tabId)?.runtime?.cwd ?? s.indexForBridge?.get(tabId)?.cwd ?? "";
    const resolver = symbolLinkResolver();
    await searchSymbol(query, { cwd, roots: symbolRoots(cwd, (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath)) }, {
      find: (symbol, scope) => resolver.find(symbol, scope),
      open: location => openTerminalFile(vscode, location, s.fileWindow.column()),
      pick: async choices => {
        const picked = await vscode.window.showQuickPick(choices.map(choice => ({ label: choice.label, description: choice.description, detail: choice.detail, entry: choice.entry })), { placeHolder: "Choose a definition", matchOnDescription: true, matchOnDetail: true });
        return picked?.entry;
      },
      quickOpen: async value => { await vscode.commands.executeCommand("workbench.action.quickOpen", value); },
    });
  }

  /**
   * A Chat file link's context-menu command: the same open a click, Ctrl+Click or Ctrl+Shift+Click sends,
   * routed to the editor whose panel showed the menu, so the target resolves against that session's cwd.
   */
  async function openFileLinkFromMenu(argument: unknown, action: FileLinkAction | undefined): Promise<void> {
    const s = windowState();
    const menu = fileLinkMenuTarget(argument);
    if (menu === null) return;
    for (const [slot, state] of s.tabs) {
      if (state.panel?.viewType !== menu.webview) continue;
      const request = { type: "omp:terminal-link-open", requestId: 0, target: menu.target, folders: true, ...(action === undefined ? {} : { action }) } as const;
      await handleTerminalGuestMessage(slot, request, request);
      return;
    }
  }

  /**
   * Answer one terminal message from the page that shows this tab.
   *
   * Every message is validated by the shared boundary before it arrives here, and
   * every action is re-gated against this tab's own identity: an attach is answered
   * with the generation this host really has, input and resize are dropped unless the
   * pipeline says this page owns input for the current generation, and the seen
   * report is only accepted from the visible, focused owner.
   */
  async function handleTerminalGuestMessage(
    tabId: string,
    parsed: { readonly type: string },
    payload: Record<string, unknown>,
  ): Promise<void> {
    const s = windowState();
    const state = stateOf(tabId);
    if (state === undefined) return;
    // The host boundary refuses input and resize for a non-controlling slot *independently*
    // of the pane's own fence: a stale generation, a rebuilt pipeline or a forged message
    // must never turn into keystrokes for a session another writer owns. Display, focus and
    // visibility keep flowing, so the screen stays readable and copyable.
    if (
      (fencedOf(state) || passiveReasonForSlot(state.slotId) !== null) &&
      (parsed.type === "omp:terminal-input" || parsed.type === "omp:terminal-resize")
    ) {
      log.debug(`slot ${state.slotId}: a non-controlling editor's ${parsed.type} was refused`);
      return;
    }
    const pipeline = () => stateOf(tabId)?.pipeline ?? null;
    const frontendId = terminalFrontendId(tabId);
    switch (parsed.type) {
      case "omp:terminal-link-validate":
      case "omp:terminal-link-symbols":
      case "omp:terminal-link-open": {
        const cwd = terminalCwd(state) ?? "";
        const panel = state.panel;
        const document = state.document;
        const bridge = state.bridge;
        const documentId = bridge?.documentId;
        const runtime = hostOf(state);
        const conversation = state.tabId;
        const shell = state.shellSlot;
        const isCurrent = () => stateOf(tabId) === state && state.panel === panel &&
          state.document === document && state.bridge === bridge && bridge?.documentId === documentId &&
          hostOf(state) === runtime && state.tabId === conversation && state.shellSlot === shell &&
          (terminalCwd(state) ?? "") === cwd;
        if (parsed.type === "omp:terminal-link-symbols") {
          s.symbolAskers.add(state.slotId);
          const asked = payload as unknown as SymbolLinksRequest;
          log.debug(`slot ${state.slotId}: link batch ${asked.requestId} asks ${asked.tokens.length} token(s)`);
          await handleSymbolLinks(asked, {
            cwd,
            roots: () => symbolRoots(cwd, (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath)),
            enabled: () => vscode.workspace.getConfiguration("ompDesk").get<boolean>("linkCodeSymbols", true),
            isCurrent,
            reply: message => {
              log.debug(`slot ${state.slotId}: link batch ${message.requestId} answered ${message.results.map(result => result.status).join(",")}`);
              pushTerminalTo(state.slotId, message);
            },
          }, symbolLinkResolver());
          return;
        }
        // A rule link (`link-rule://<rule>/<matched text>`): the rule is found and run again here and the URL is built here; the page names no URL.
        if (typeof payload.target === "string" && await handleLinkRuleOpen(payload as unknown as TerminalLinkRequest, linkRules(), {
          isCurrent,
          openUrl: async (url, mode) => {
            try { await openPageWebLink(url, mode); }
            catch (error) { log.warn(`link rule: cannot open ${new URL(url).origin}: ${messageOf(error)}`); showWarning(`cannot open ${url}: ${messageOf(error)}`); }
          },
          warn: message => { log.warn(`link rule: ${message}`); showWarning(message); },
        })) return;
        // A commit hash (`commit://<hex>`) is proved and shown against the repositories of this session's folder, never as a file of the cwd.
        if (typeof payload.target === "string" && parseCommitLinkTarget(payload.target) !== null) {
          await handleCommitLink(payload as unknown as TerminalLinkRequest, s.commitLinks ??= createCommitLinkResolver(), {
            cwd,
            isCurrent,
            reply: message => pushTerminalTo(state.slotId, message),
            log: line => log.info(line),
            warn: message => { log.warn(`terminal link: ${message}`); showWarning(message); },
          });
          return;
        }
        // An internal OMP URL (`agent://Name`) is proved and opened against the conversation's own session, never as a file of the cwd.
        const internal = typeof payload.target === "string" && conversation !== null ? parseInternalLink(payload.target) : null;
        if (internal !== null && conversation !== null) {
          const conversations = s.sessionRuntime.conversations;
          await handleInternalLink(payload as unknown as TerminalLinkRequest, internal, {
            isCurrent,
            reply: message => pushTerminalTo(state.slotId, message),
            sessionFile: () => conversations.liveOf(conversation)?.sessionFile ?? s.indexForBridge?.get(conversation)?.sessionFile ?? null,
            tabs: state.mode !== "terminal" && conversations.kindOf(conversation) !== "legacy",
            knownSubagent: id => conversations.subagentKnownOf(conversation, id),
            openAgentTab: id => { log.debug(`tab ${conversation}: detail tab agent was ${s.detailTabs.open(conversation, { kind: "agent", agentId: id })}`); },
            openSessionFile: (sessionFile, ref) => s.sessionFileDocuments.open(sessionFile, ref),
            openArtifact: (sessionFile, artifactId) => s.artifactDocuments.open(sessionFile, artifactId),
            revealInOs: file => revealPathInOs(file),
            warn: message => { log.warn(`terminal link: ${message}`); showWarning(message); },
          });
          return;
        }
        await handleTerminalLink(payload as unknown as TerminalLinkRequest, {
          cwd,
          isCurrent,
          reply: message => pushTerminalTo(state.slotId, message),
          openFile: location => openTerminalFile(vscode, location, s.fileWindow.column()),
          revealInExplorer: target => revealPathInExplorer(vscode, target),
          revealInOs: target => revealPathInOs(target),
          warn: message => { log.warn(`terminal link: ${message}`); showWarning(message); },
          openUrl: openPageWebLink,
          searchSymbols: async query => { await vscode.commands.executeCommand("workbench.action.quickOpen", `#${query}`); },
          lookupFileName: name => symbolLinkResolver().lookupFileName(name, { cwd, roots: symbolRoots(cwd, (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath)) }),
          pickFile: async paths => {
            const roots = symbolRoots(cwd, (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath));
            const picked = await vscode.window.showQuickPick(paths.map(file => ({ ...fileChoiceLabel(file, cwd, roots), file })), { placeHolder: "Choose a file", matchOnDescription: true });
            return picked?.file;
          },
        });
        return;
      }
      case "omp:terminal-attach": {
        // Appearance is available even while the native broker is still starting.
        // Every mounted pane asks here, so late mounts cannot miss configuration.
        pushTerminalFont(state);
        const attached = pipeline();
        if (attached === null) {
          if (state.mode === "terminal" && state.viewProjection?.starting) {
            pushSessionView(s.indexForBridge ?? null, state, true);
            return;
          }
          pushTerminalUnavailable(
            tabId,
            (recordOf(state)?.endedNotice ?? null) ?? (state.mode === "terminal" ? "This native OMP session is not attached to its broker in this window." : "This folder terminal is not attached to its broker in this window."),
          );
          return;
        }
        await attached.attach(frontendId, {
          generation: typeof payload.generation === "string" ? payload.generation : null,
          cols: Number(payload.cols),
          rows: Number(payload.rows),
        });
        return;
      }
      case "omp:terminal-probe": {
        const attached = pipeline();
        if (attached === null) {
          if (state.mode === "terminal" && state.viewProjection?.starting) {
            pushSessionView(s.indexForBridge ?? null, state, true);
            return;
          }
          pushTerminalUnavailable(tabId, (recordOf(state)?.endedNotice ?? null) ?? "This terminal is not attached to its broker in this window.");
          return;
        }
        await attached.probe(frontendId, {
          generation: typeof payload.generation === "string" ? payload.generation : null,
          seq: Number(payload.seq),
        });
        return;
      }
      case "omp:terminal-input": {
        const attached = pipeline();
        if (attached === null) return;
        await attached.input(frontendId, { generation: String(payload.generation), data: String(payload.data) });
        return;
      }
      case "omp:terminal-resize": {
        const attached = pipeline();
        if (attached === null) return;
        await attached.resize(frontendId, {
          generation: String(payload.generation),
          cols: Number(payload.cols),
          rows: Number(payload.rows),
        });
        return;
      }
      case "omp:terminal-focus":
        pipeline()?.noteFocus(frontendId, payload.focused === true, payload.intent === true);
        return;
      case "omp:terminal-visibility":
        pipeline()?.noteVisibility(frontendId, payload.visible === true);
        return;
      default:
        return;
    }
  }

  /**
   * The broker client, with its staged runtime proven ready to *start* a child.
   *
   * Used by the paths that start a child on the full runtime proof: a terminal, a folder shell and Stats (a Chat starts through
   * {@link chatBrokerClient}). A proven runtime is kept for the activation; a *failed* readiness check is not, because the client
   * retries a staging or self-check failure that a later attempt would not hit — latching it
   * for the window's lifetime would make a surviving broker look unavailable to every
   * ownership recheck after a full VS Code restart. The proof is started in the background
   * once the startup restore pass settles (see {@link CatalogAdoption.startRestore}), so a launch
   * seldom waits for it.
   */
  async function brokerClient(): Promise<PtyBrokerClient | null> {
    const s = windowState();
    await legacySettingsSettled(s);
    const gate = s.ptyGate;
    if (gate === undefined) return null;
    return await gate.client();
  }

  /**
   * The broker client of a Chat launch: it does not wait for the full runtime proof, which is the console-child proof a terminal
   * needs. Every broker start is gated inside the client by the proof of the runtime it starts on (a Chat on Bun by its own
   * pipe-only proof, a Chat that falls back to `Code.exe` by the full proof, awaited there), so the launcher's wait for the full
   * proof only delayed a Chat that never uses it (the first self-check after an update outlives its 15 s deadline). The
   * ADR-0068 settings barrier applies as for every launch.
   */
  async function chatBrokerClient(): Promise<PtyBrokerClient | null> {
    const s = windowState();
    await legacySettingsSettled(s);
    const gate = s.ptyGate;
    if (gate === undefined) return null;
    return await gate.chatLaunchClient();
  }

  /**
   * Hold the first launch of a process until the move of the old settings ended, so `executablePath` and the other launch-time
   * settings are not read half-moved (ADR-0068). Counted from activation and capped: a hung settings write must not keep a
   * session from starting. Free once the move settled, which is the normal case.
   */
  async function legacySettingsSettled(s: WindowState): Promise<void> {
    const left = s.activatedAt + LEGACY_SETTINGS_MOVE_WAIT_MS - Date.now();
    const outcome = await Promise.race([s.legacySettingsMoved.then(() => "moved" as const), delayMs(Math.max(0, left)).then(() => "late" as const)]);
    if (outcome === "late" && !s.legacySettingsLateLogged) {
      s.legacySettingsLateLogged = true;
      log.warn(`settings: the move from omp.* to ompDesk.* is still running ${LEGACY_SETTINGS_MOVE_WAIT_MS} ms after activation; the launch goes on`);
    }
  }

  /**
   * The broker client for re-adopting an already-running broker. Re-adoption uses the durable
   * record, the token handshake (whose MAC covers the broker's pid and creation time), the
   * broker's authenticated attestation of its own and its pipe child's identity (ADR-0035
   * amendment 2026-10-13), and a kernel creation-time reading only for what is not attested
   * (older brokers, pseudo-console children). It needs only an attach-ready client, never the
   * staged tree's staging or self-check, and none of it executes the staged tree, so restore
   * does not wait for the runtime proof. A Chat launch also starts from an attach-ready client
   * ({@link chatBrokerClient}), because the client gates every start itself.
   */
  async function attachBrokerClient(): Promise<PtyBrokerClient | null> {
    const s = windowState();
    const gate = s.ptyGate;
    if (gate === undefined) return null;
    return await gate.attachClient();
  }

  // Session actions: Rename, Close, Reload

  /**
   * The conversation of the OMP chat editor that is in front in the focused editor group, or
   * `null` when the focused editor is not one of ours.
   *
   * Read from VS Code's own tab model, not from a panel handle: after a host-only restart the
   * editor the user is looking at can be a surviving page this window has no panel handle for yet,
   * and the handle-based answer would then name whichever other editor did get one. The editor's
   * view type names its original namespace; the durable slot binding says what it serves now.
   */
  function editorInFrontConversation(index: SessionIndex): string | null {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (!(input instanceof vscode.TabInputWebview)) return null;
    const identity = tabInputIdentity(input.viewType);
    if (identity === null) return null;
    const committed = index.slotBinding(identity.editorIdHex);
    const conversation = committed === null || index.get(committed.tabId) === null ? identity.tabId : committed.tabId;
    return index.get(conversation) === null ? null : conversation;
  }

  /**
   * The indexed row one row command names: the tree item, an explicit tab id, or — from the
   * command palette — the chat editor the user is looking at, then a showing panel, then the
   * index's last active tab. The index's active tab follows the tree selection and can name
   * another session than the editor in front, and a command that stops or renames a session must
   * act on the one shown.
   */
  function sessionTargetFromArgument(
    index: SessionIndex,
    argument: unknown,
  ): { readonly tabId: string; readonly entry: SessionIndexEntry } | null {
    const tabId =
      argument instanceof SessionTreeItem
        ? argument.tabId
        : typeof argument === "string" && index.get(argument) !== null
          ? argument
          : (editorInFrontConversation(index) ?? activePanelTab()?.tabId ?? index.activeTabId);
    if (tabId === null) return null;
    const entry = index.get(tabId);
    return entry === null ? null : { tabId, entry };
  }

  /**
   * Ask for a session's stored name, validated by the same rules every writer uses.
   *
   * The box ignores focus loss: Windows' Alt+Shift (and Alt alone) layout switch, the menu bar's Alt focus, a toast or a page
   * that focuses itself all move the keyboard out of an input box, and VS Code then dismisses a box that does not ignore it
   * (the rename input "opened and immediately disappeared" for a user who switched the keyboard layout to correct a name typed
   * in the wrong one). A title is typed text the user may have to switch layouts or look elsewhere to compose, so only Enter
   * and Escape end it, as for the other prompts of this extension that take typed text.
   */
  async function promptSessionTitle(entry: SessionIndexEntry): Promise<string | undefined> {
    windowState().pending.step(entry.tabId, "confirm", "rename");
    const proposed = await vscode.window.showInputBox({
      title: `Rename ${path.basename(entry.cwd)}`,
      prompt: "The name OMP stores for this session, shown in its own TUI and in OMP's history.",
      value: entry.title ?? "",
      ignoreFocusOut: true,
      validateInput: value => {
        const trimmed = value.trim();
        if (trimmed.length === 0) return "A session name cannot be empty.";
        if (trimmed.length > MAX_SESSION_TITLE_CHARS) return `A session name is at most ${MAX_SESSION_TITLE_CHARS} characters.`;
        return /[\u0000-\u001f\u007f-\u009f]/.test(trimmed) ? "A session name cannot contain control characters." : null;
      },
    });
    return proposed;
  }

  /**
   * Rename a *stopped* session's stored title through the installed agent's own
   * storage code, under this extension's exclusive claim.
   *
   * The extension host is Node and that storage code is TypeScript, so the write
   * happens in a bounded Bun helper ({@link renameStoppedSessionTitle}) that
   * revalidates the exact file and session id itself. What this function owns is the
   * exclusion and the truthfulness of the result: the exact-file claim is taken
   * before the helper runs and released after, a session whose process is still
   * running in this window is refused (the running path is the authenticated channel
   * instead), a compiled-only install that exposes no importable package source is
   * refused with a capability message rather than editing the file, and the outcome
   * distinguishes a verified rename from a partial one where OMP's recent-session
   * index could not be updated.
   */
  async function renameStoppedSession(
    context: vscode.ExtensionContext,
    index: SessionIndex,
    tabId: string,
    entry: SessionIndexEntry,
  ): Promise<void> {
    const file = entry.sessionFile;
    if (file === null) {
      const proposed = await promptSessionTitle(entry);
      if (proposed === undefined) return;
      await index.lifecycle.run(tabId, async () => {
        const observed = await index.observeOwnership(tabId);
        if ((observed.ok && observed.claim !== null && observed.claim.holderId !== index.claimHolder.id && await claimHolderMayBeAlive(observed.claim)) || await windowState().sessionRuntime.verifiedWriterPid(tabId) !== null) {
          showWarning("This session is running in another editor. Rename it there.");
          return;
        }
        await index.recordConversationState(tabId, { title: proposed.trim() });
        void applyChatTabAppearance(context, index, tabId);
      });
      refreshLauncher();
      return;
    }
    if (hostOf(stateOf(tabId)) != null) {
      showError("This session's native process is still running in this window; a running session is renamed through it instead.");
      return;
    }
    const proposed = await promptSessionTitle(entry);
    if (proposed === undefined) return;
    const title = proposed.trim();
    if (title === (entry.title ?? "")) return;

    let helper: StagedRuntimeAsset;
    try {
      helper = (await windowState().staging.entries()).renameHelper;
    } catch (error) {
      log.error(`rename helper staging failed: ${messageOf(error)}`);
      showError("Session rename support could not be prepared. Resume the session and rename it there; see OMP Desk output for details.");
      return;
    }
    const bun = await resolveBunRuntime();
    if (bun === null) {
      showError(
        "No Bun runtime was found on this machine, so a stopped session's stored title cannot be changed here. " +
          "Open the session and rename it while it runs.",
      );
      return;
    }
    // The package source must come from the *selected* executable's own install tree,
    // never from a similarly named package somewhere else on the machine.
    let pkg: OmpPackageRoot | null;
    try {
      pkg = await resolveOmpPackageRoot(await resolveOmpBinary());
    } catch (error) {
      log.error(`the installed OMP could not be resolved for a rename: ${messageOf(error)}`);
      showError(
        `The installed OMP could not be resolved, so a stopped session's stored title cannot be changed here: ${messageOf(error).split(/\r?\n/)[0]}`,
      );
      return;
    }
    if (pkg === null) {
      showError(
        "The installed OMP this window resolved exposes no importable package source (a compiled-only install), so a " +
          "stopped session's stored title cannot be changed through its storage manager. Open the session and rename " +
          "it while it runs.",
      );
      return;
    }

    // The claim is the exclusion: while it is held, no other extension writer may
    // adopt this exact file, and the helper only ever touches this path.
    const ownerGeneration = entry.ownership?.ownerGeneration ?? createOwnerGeneration();
    let claim;
    try {
      claim = await acquireClaim(context.globalStorageUri.fsPath, file, ownerGeneration, await index.claimHolderReady());
    } catch (error) {
      log.error(`rename claim failed: ${messageOf(error)}`);
      showError("This session could not be opened for renaming. Refresh Sessions and try again; see OMP Desk output for details.");
      return;
    }
    try {
      const observed = await index.observeOwnership(tabId);
      if ((observed.ok && observed.claim !== null && observed.claim.holderId !== index.claimHolder.id && await claimHolderMayBeAlive(observed.claim)) || await windowState().sessionRuntime.verifiedWriterPid(tabId) !== null) {
        showError("This session is running in another editor. Stop it before renaming its saved conversation.");
        return;
      }
      const outcome = await renameStoppedSessionTitle({
        bunPath: bun,
        packageRoot: pkg.root,
        helperPath: helper.path,
        file,
        title,
        sessionId: entry.sessionId,
      });
      if (!outcome.verified) {
        showError(`The stored title was not changed: ${outcome.detail ?? "the native write did not verify"}.`);
        return;
      }
      // The file now holds the requested title, so the row shows what OMP will show.
      await index.recordConversationState(tabId, { title: outcome.title ?? title });
      refreshLauncher();
      // A tab showing this conversation is a second copy of the row and is renamed
      // with it, rather than keeping the name the session had before.
      void applyChatTabAppearance(context, index, tabId);
      if (outcome.index === "synced") {
        showInfo(`Renamed the stored session title to "${outcome.title ?? title}".`);
      } else {
        showWarning(
          `The stored title is now "${outcome.title ?? title}", but OMP's recent-session index could not be updated. ` +
            "OMP's history and resume read the title from the session file itself.",
        );
      }
    } finally {
      await claim.release().catch(() => undefined);
    }
  }

  /**
   * Rename a session's *own* stored title.
   *
   * For a session this window is running, this is rpc `set_session_name` on the one process
   * that serves the conversation: the reply is the process's own acknowledgement, and the
   * row title changes only after it. For a stopped session the installed native storage
   * manager runs under this extension's own claim ({@link renameStoppedSession}); a direct
   * title-slot rewrite is forbidden, so nothing else edits the file.
   */
  async function renameSession(context: vscode.ExtensionContext, index: SessionIndex, argument: unknown): Promise<void> {
    const target = sessionTargetFromArgument(index, argument);
    if (target === null) {
      showWarning("Select an OMP session to rename.");
      return;
    }
    // The live-row checks before the title prompt can take seconds: the row says it is renaming from the click.
    await pendingEntry(target.tabId, "rename", { origin: "row", step: "checking" }, () => renameSessionChecked(context, index, target));
  }

  async function renameSessionChecked(context: vscode.ExtensionContext, index: SessionIndex, target: NonNullable<ReturnType<typeof sessionTargetFromArgument>>): Promise<void> {
    const s = windowState();
    const { tabId, entry } = target;
    const nativeState = stateOf(tabId);
    const native = hostOf(nativeState);
    if (nativeState !== undefined && native?.kind === "terminal") {
      const control = controlOf(nativeState);
      if (fencedOf(nativeState) || passiveReasonOf(tabId) !== null || control === null) {
        showWarning("Rename is unavailable while this editor is read-only, stopping, or disconnected. Reopen its running editor and try again.");
        return;
      }
      const client = control.client;
      try {
        const snapshot = await client.snapshot();
        const facts = await client.nativeState();
        if (!facts.available) { showWarning(facts.unavailableReason ?? "Native Rename is unsupported."); return; }
        const captured = { epoch: snapshot.host.epoch, sessionFile: facts.sessionFile, sessionId: facts.sessionId };
        const proposed = await promptSessionTitle(entry);
        if (proposed === undefined) return;
        await index.lifecycle.run(tabId, async () => {
          if (hostOf(nativeState) !== native || nativeState.tabId !== tabId || fencedOf(nativeState) || controlOf(nativeState)?.client !== client || passiveReasonOf(tabId) !== null) return;
          const result = await client.nativeRename(captured, proposed.trim());
          if (result !== "renamed") { showWarning(`Native Rename was refused (${result}).`); return; }
          const readback = await client.nativeState();
          if (readback.sessionId === captured.sessionId && readback.sessionFile === captured.sessionFile) await index.recordConversationState(tabId, { title: readback.name });
          void applyChatTabAppearance(context, index, tabId);
          pushSessionView(index, nativeState);
        });
      } catch (error) {
        showWarning(`Native Rename's outcome is unconfirmed (${messageOf(error)}); it was not retried.`);
      }
      refreshLauncher();
      return;
    }
    // A live row this window does not drive yet (a verified survivor) is renamed through its own
    // process, exactly as Reload reattaches it first; the stopped-title path refuses a live writer.
    const conversations = s.sessionRuntime.conversations;
    if (hostOf(nativeState) == null && conversations.incarnationOf(tabId) === null && entry.sessionFile !== null && await s.sessionRuntime.verifiedWriterPid(tabId) !== null) {
      await windowState().sessionFlows.openTab(context, index, tabId, "opened", "restored");
      if (hostOf(stateOf(tabId)) == null) {
        showWarning("The exact live editor could not be reattached. Nothing was renamed; no replacement was started.");
        return;
      }
      await renameSession(context, index, tabId);
      return;
    }
    const live = conversations.liveOf(tabId);
    if (live === null || !rpcPhaseIsRunning(live.phase)) {
      await renameStoppedSession(context, index, tabId, entry);
      return;
    }
    const conflict = passiveReasonOf(tabId);
    if (conflict !== null) {
      showError(`${conflict} Rename is refused for this tab.`);
      return;
    }
    const proposed = await promptSessionTitle(entry);
    if (proposed === undefined) return;
    const title = proposed.trim();
    if (title === (entry.title ?? "")) return;
    const outcome = await conversations.setSessionName(tabId, live.incarnation, title);
    if (outcome.status === "accepted") {
      await index.recordConversationState(tabId, { title });
      // The running session's own name changed, so every editor showing it says so.
      void applyChatTabAppearance(context, index, tabId);
      showInfo(`Renamed the session to "${title}".`);
    } else if (outcome.status === "unconfirmed") {
      showWarning(
        "The rename's outcome is unknown, so it was not retried. Check the session's title before renaming again.",
      );
    } else {
      showError("The session is not accepting a rename right now. Wait until it is live and try again.");
    }
    refreshLauncher();
  }

  /**
   * Close: confirm, stop the exact process, prove it gone, keep the row.
   *
   * The row is retained as a stopped session with its history and file untouched, and
   * the claim is released only on a confirmed stop — the index owns that rule, so an
   * uncertain stop keeps both the claim and the conflict. The stop is graceful — the
   * broker closes the child's stdin, OMP aborts the turn, persists it and exits — and only
   * when that does not finish in time may the user explicitly force it.
   */
  async function closeSession(context: vscode.ExtensionContext, index: SessionIndex, argument: unknown): Promise<void> {
    const target = sessionTargetFromArgument(index, argument);
    if (target === null) {
      showWarning("Select an OMP session to close.");
      return;
    }
    const { tabId, entry } = target;
    log.debug(
      `close: target ${tabId} (argument ${argument === undefined ? "none" : typeof argument}); ` +
        `editor in front ${editorInFrontConversation(index) ?? "none"}; index active ${index.activeTabId ?? "none"}`,
    );
    const running = entry.runIntent === "running" || entry.availability === "live";
    if (!running) {
      showInfo("That session is already stopped.");
      return;
    }
    const state = stateOf(tabId);
    const runtime = hostOf(state) ?? null;
    // A confirmation asks the user to approve stopping one exact transport, so there has
    // to be one. A row whose child this window does not drive but which recorded its own
    // broker slot (a survivor of an earlier extension host) is stopped through that slot by
    // the recorded-host path, which asks its own exact confirmation; a row with no reachable
    // transport is told that, with the row's own reason, and nothing is stopped.
    if (runtime === null) {
      if (entry.host !== null) {
        await pendingEntry(tabId, "close", { origin: "row", step: "checking" }, () => windowState().sessionActions.stopHost(context, index, argument, undefined, "close"));
        return;
      }
      showWarning(
        "This window is not running an OMP host for that session, so nothing was stopped." +
          (entry.detail === null ? "" : ` ${entry.detail}`),
      );
      return;
    }
    if (state !== undefined) await pendingEntry(tabId, "close", { origin: "row", step: "checking" }, () => confirmAndStopRuntime(context, index, tabId, "Close"));
  }

  /** Dialogs never hold the gate; admission remains fenced through both stop attempts. */
  async function confirmAndStopRuntime(
    context: vscode.ExtensionContext, index: SessionIndex, tabId: string, label: "Stop" | "Close",
    /**
     * What the caller (the Processes view, which asks nothing for a single stop) captured just
     * before: whether this window's runtime was passive, and the transition facts read under the
     * gate. Its own prompt is skipped, the same checks bind to this capture, and a runtime that
     * is no longer the captured one (`target`, its incarnation) is refused visibly.
     */
    preconfirmed?: { readonly target: number; readonly conflicting: boolean; readonly captured: SessionTransitionFacts | null; readonly idleOnly?: boolean; readonly gracefulOnly?: boolean },
  ): Promise<boolean> {
    const s = windowState();
    const entry = index.get(tabId);
    const state = stateOf(tabId);
    const target = s.sessionRuntime.snapshot(tabId)?.attachment ?? null;
    if (entry === null || state === undefined || target === null || state.tabId !== tabId || (preconfirmed !== undefined && preconfirmed.target !== target)) {
      if (preconfirmed !== undefined) showWarning("The session changed while the stop was being prepared, so nothing was stopped.");
      return false;
    }
    const conflicting = preconfirmed?.conflicting ?? passiveReasonForSlot(state.slotId) !== null;
    const token = beginTransition(tabId, { check: () => (passiveReasonForSlot(state.slotId) !== null) === conflicting });
    try {
      const captured = preconfirmed !== undefined ? preconfirmed.captured : await s.sessionRuntime.readTransitionFacts({ conversation: tabId, target });
      if (preconfirmed === undefined) {
        s.pending.step(tabId, "confirm", "close");
        const choice = await vscode.window.showWarningMessage(
          `${label} the OMP session “${s.launcherProvider?.headlineFor(entry.tabId) ?? sessionHeadline(entry, null)}”?`,
          { modal: true, detail: conflicting
            ? "Only this window's copy of the session is stopped; the window that owns it keeps it."
            : "The OMP process ends and a turn in progress is aborted. The conversation stays in OMP's session files and can be resumed." },
          label,
        );
        if (choice !== label) return false;
      }
      s.pending.step(tabId, "working", "close");
      s.stoppingTabs.add(tabId);
      refreshLauncher();
      const attempt = async (mode: "graceful" | "force"): Promise<StopResult> => {
        const result = await s.sessionRuntime.stop({
          conversation: tabId, token, target, mode, consent: true, expected: captured,
          ...(preconfirmed?.idleOnly === true ? { idleOnly: true } : {}),
          scope: conflicting ? "local-copy" : "session",
        });
        if (result.status === "unconfirmed") s.sessionRuntime.setControlFailure(tabId, result.detail);
        return result;
      };
      let stopped = await attempt("graceful");
      if (stopped.status === "refused") {
        showWarning(stopped.code === "not-idle"
          ? "The old session is no longer idle or its identity changed; nothing was stopped."
          : "The captured process/editor changed; nothing was stopped.");
        return false;
      }
      // A stop another window asked for is graceful only: it never opens a Force Stop or any other modal here.
      if (stopped.status === "unconfirmed" && preconfirmed?.gracefulOnly !== true) {
        s.pending.step(tabId, "confirm", "close");
        const force = await vscode.window.showWarningMessage(
          `This session could not be confirmed stopped. ${stopped.detail}`,
          { modal: true, detail: "Force Stop may lose unsaved replies and work in progress. Commands started by OMP may continue running separately. Nothing is restarted automatically; check Sessions before resuming." },
          "Force Stop",
        );
        if (force === "Force Stop") s.pending.step(tabId, "working", "close");
        if (force === "Force Stop") {
          stopped = await attempt("force");
          if (stopped.status === "refused" && stopped.code === "facts-changed") showWarning("The session target changed while Force Stop was pending; nothing was stopped.");
          if (stopped.status === "refused" && stopped.code === "not-idle") showWarning("The old session is no longer idle or its identity changed; nothing was stopped.");
        }
      }
      if (stopped.status === "unconfirmed") showWarning(stopped.detail);
      return stopped.status === "stopped";
    } finally {
      s.stoppingTabs.delete(tabId);
      s.sessionRuntime.endTransition(token, "native-stopping");
      refreshLauncher();
    }
  }

  /**
   * Reload: replace this session's process with a fresh one on the same exact file.
   *
   * Always confirmed, because in-flight text, requests and tool effects may not be
   * persisted and are never resent. A draft with no file has nothing to resume, so it
   * is refused rather than being turned into an implicit Resume.
   */
  async function reloadSession(context: vscode.ExtensionContext, index: SessionIndex, argument: unknown): Promise<void> {
    const target = sessionTargetFromArgument(index, argument);
    if (target === null) { showWarning("Select an OMP session to reload."); return; }
      if (target.entry.sessionFile === null) { showWarning("This session has not been saved yet. Choose Chat or Terminal to change its view."); return; }
    // A tab VS Code has not shown since the window loaded has no panel handle yet; showing it is what creates one.
    if (stateOf(target.tabId)?.panel === null) await reviveEditorPanel(index, target.tabId);
    let state = stateOf(target.tabId);
    if (hostOf(state) == null) {
      const pid = await windowState().sessionRuntime.verifiedWriterPid(target.tabId);
      if (pid === null) { showInfo("That session is stopped. Use Resume to start it again."); return; }
      await windowState().sessionFlows.openTab(context, index, target.tabId, "opened", "restored");
      state = stateOf(target.tabId);
    }
    const hosted = hostOf(state);
    if (state === undefined || hosted === null || state.panel === null) {
      showWarning("OMP could not reconnect this tab to its running session, so nothing was reloaded. Run “Developer: Reload Window”, then try again; no process was started or stopped.");
      return;
    }
    await windowState().sessionFlows.switchSessionMode(context, index, state, hosted.kind, true);
  }

  const { diagnosticsEnvironment, showDiagnostics, diagnosticsDocumentContent, diagnosticsLabel, diagnosticsStageMeasured } = createSessionDiagnostics({ windowState, hostOf, controlOf, recordOf, log, showError, messageOf });

  const { enableFileEvidence, disableFileEvidence, showFileEvidence, deleteFileEvidence, observationDocumentContent } = createFileEvidence({ controlOf, stateOf, messageOf, showInfo, isProcessAlive, windowState, log, activeControl, showWarning, showError });

  const { addWorkspaceFolder, pinWorkspaceFolder, unpinWorkspaceFolder, resumeWorkspaceFolder, revealExistingTab, resumeFromFolderHistory, chooseFolder } = createFolderCommands({ windowState, showError, refreshLauncher, showWarning, showInfo, log, hostOf, messageOf, stateOf, pendingEntry, timedLaunch, requestSessionRowExpand, setActiveTab, revealActiveSession });

  const { shellSerializerFor, recoverableShellsInFolder, openFolderTerminal, reconnectFolderTerminal, attachFolderShell, handleShellEditorClosed } = createFolderShells({ windowState, stateOf, showInfo, showError, chooseFolder, showWarning, brokerClient, attachBrokerClient, tabState, log, handleTerminalGuestMessage, refreshLauncher, recordFor, messageOf, ensureTerminalPipeline, stopTerminalForTab });

  const { quoteEditorSelectionToSession, addFilesToSession } = createSessionInsertions({ showWarning, windowState, launcherFacts, stateOf, passiveReasonForSlot, hostOf, defaultSessionMode, log, showInfo, showError, refreshLauncher, messageOf, openSession, fencedOf, activateNativeEditor });

  const { signInProvider, subscribeProviderLoginRefresh, refreshFooterMetadata, loginProviderFromPalette, logoutProviderFromPalette, refreshProviderModelsEverywhere, publishFooterMetadata, openProviderLogin, openProviderLogout, refreshSessionModels, refreshSessionCost, ensureFooterBinding, recordSessionModels, refreshDefaultProviderModels } = createProviderModels({ windowState, log, executableFor, ompCliScopeEnvironment, liveAt, hostOf, stateOf, noteUsageFailure, showInfo, showError, messageOf });

  state = createWindowState(deps.context);
  if (deps.output !== undefined) state.output = deps.output;
  if (deps.helpers !== undefined) state.helpers = deps.helpers;
  const created = state;
  return {
    /** The window's state; fixtures replace the pieces a real window builds once. */
    state: created,
    activate,
    deactivate,
    /** Ends the clocks and handles of a window that did not activate (a fixture's), as deactivation and the context's subscriptions end a real one's. */
    dispose(): void {
      created.pendingDisplay.dispose();
      created.pending.dispose();
      created.helpers?.dispose();
      // The singleton the module used to hold made everything a replaced window left in flight end on its own: its timers read the
      // new window and found their entry gone, and a continuation that waited for a process to leave the runtime's records found
      // none. A window that is its own closure must end both itself.
      for (const timer of created.subagentWatches.values()) clearInterval(timer);
      created.subagentWatches.clear();
      clearTimeout(created.pinnedSelectionTimer);
      const records = created.sessionRuntime?.records;
      if (records !== undefined) for (const record of [...records.all()]) records.drop(record.tabId);
    },
    /** The operations the editors' commands and the tests drive, with the same arguments the commands pass. */
    ops: {
      sessionActionsDeps,
      editorPanelsDeps,
      revealDesktopNotification,
      newSession,
      startNewSession,
      newSessionInPlace,
      deleteSessionInPlace,
      openSession,
      resumeWorkspaceFolder,
      reviveEditorPanel,
      createSessionRuntime,
      sessionRuntimeDeps,
      recordFor,
      localLauncher,
      defaultSessionMode,
      chooseDefaultSessionView,
      pushSessionView,
      activateNativeEditor,
      restoreTabs,
      handleRestoreOutcome,
      presentRestoreOutcome,
      handOverSession,
      attachChatRoute,
      handleBridgeRequest,
      copyActiveTerminalScreen,
      postPanelAction,
      runChatAction,
      quoteEditorSelectionToSession,
      notifierFor,
      forgetTurnActivity,
      readChatDisplayPreferences,
      refreshChatDisplayPreferences,
      handleChatEvent,
      panelResponder,
      handleGuestControlRequest,
      refreshDefaultProviderModels,
      subscribeProviderLoginRefresh,
      recordSessionModels,
      refreshSessionModels,
      openProviderLogin,
      loginProviderFromPalette,
      signInProvider,
      logoutProviderFromPalette,
      newTabState,
      tabState,
      passiveReasonForSlot,
      refreshLauncher,
      requestSessionRowExpand,
      revealActiveSession,
      releaseSelectionFromOtherWindow,
      launcherFacts,
      launcherOwnershipFacts,
      refreshRowsForClaims,
      handlePassiveSlotMessage,
      terminalFontMessage,
      handleTerminalGuestMessage,
      handleShellEditorClosed,
      renameSession,
      closeSession,
      reloadSession,
    },
  };
}

/** One window, as `createWindow` returns it. */
export type DeskWindow = ReturnType<typeof createWindow>;