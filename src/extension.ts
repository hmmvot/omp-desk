/**
 * Extension-owned RPC chat, VS Code editors and Sessions lifecycle orchestration.
 * SessionIndex owns exact-file/catalog identity and per-tab serialization; VS Code
 * owns editor membership. Closing an editor detaches without stopping its child.
 * ADR-0039 refuses only current positive extension ownership. Unknown ownership is
 * usable immediately; verified local/legacy writers offer one confirmed
 * stop-and-Open/Delete path. External writers are the user's responsibility.
 */
import { createHash } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { createDetailHtml, createGuestHtml, createShellHtml, createUnavailableGuestHtml } from "./host/guest-webview";
import { chatExitText, type ChatExitReason } from "./chat/exit-reason";
import { persistedTabId } from "./webview/panel-identity";
import { installedNerdFonts } from "./host/terminal-fonts";
import { terminalFontFamily } from "./webview/lib/terminal-theme";
import {
  DEFAULT_OMP_PROFILE,
  delay,
  findTerminalForPid,
  openProviderLoginTerminal,
  renameStoppedSessionTitle,
  resolveBunRuntime,
  resolveOmpBinary,
  resolveOmpPackageRoot,
  terminalWriterForHandle,
} from "./host/native-terminal";
import { runOmpCli } from "./host/native-terminal";
import { ProviderUsageCache, PROVIDER_USAGE_ARGS, PROVIDER_USAGE_TIMEOUT_MS } from "./host/provider-usage";
import { observeSessionBranch } from "./host/session-branch";
import type { GitApi, BranchObservation } from "./host/session-branch";
import type { FooterMetadataMessage } from "./webview/footer-metadata";
import { SessionClickRecognizer } from "./views/session-click";
import { acquireClaim, createClaimHolder, createOwnerGeneration } from "./host/session-claim";
import type { NativeControlBootstrap, OmpCommand } from "./host/native-terminal";
import {
  SESSION_INDEX_LOCAL_KEY,
  SESSION_INDEX_STORAGE_KEY,
  isManagedHost,
  mergeSessionIndexRecords,
  normalizeSessionIdentityKey,
  readSessionFileHeader,
  SessionIndex,
} from "./host/session-index";
import { confirmedSessionDeletion, deleteManagedSession, inspectSessionDeletion } from "./host/session-lifecycle";
import type { SessionDeletionOptions, SessionDeletionResult, SessionDeletionSubject } from "./host/session-lifecycle";
import type {
  AttachPin,
  DeferredReconcileReport,
  DeferredReconciliation,
  OmpHostAttachRequest,
  OmpHostAttachResult,
  OmpHostHandle,
  OmpHostLaunchRequest,
  OmpHostLaunchResult,
  OmpHostLauncher,
  OwnerReconciler,
  RecordedHostStopPort,
  RestoreOutcome,
  RestoreReport,
  SessionConflictKind,
  SessionFileHeader,
  SessionIndexEntry,
} from "./host/session-index";
import type { SessionViewMode } from "./host/session-index";
import { claimHolderMayBeAlive } from "./host/session-claim";
import { claimFileNameFor, startClaimWatch } from "./host/claim-watch";
import { ExternalLeaseObserver, ompSessionOwnersDir, powershellLeaseProbe } from "./host/omp-session-lease";
import { canonicalFolderKey, folderHistoryDeletionSubject, inspectSessionFile, scanFolderHistory } from "./host/folder-history";
import type { FolderHistoryCandidate, FolderHistoryIndexedEntry, FolderHistoryScan } from "./host/folder-history";
import { findFileMentions } from "./host/file-mentions";
import {
  EditorRecency,
  candidateDescription as sendCandidateDescription,
  composeInsertion,
  folderName as sessionFolderName,
  insertAvailability,
  newSessionFolder,
  pickerEntries,
  selectionLines,
} from "./host/editor-context";
import type { ReferenceSource, SendCandidate } from "./host/editor-context";
import { TurnNotifier, desktopNotificationSuppression, reportsTrailingQuestion } from "./host/notifications";
import type { TurnActivity, TurnNotice, NotificationSuppression } from "./host/notifications";
import { sendDesktopNotification } from "./host/desktop-notifications";
import { notificationLine } from "./host/notification-text";
import { NativeActivityLedger } from "./host/native-activity";
import {
  isOpenControlClient,
  mayPublishControlChannel,
  mayRefreshControlSnapshot,
  mayReportControlFailure,
  type ControlAttemptPlan,
} from "./host/control-attempt";
import { stageRuntimeAssets, verifyStagedRuntimeAsset, type StagedRuntimeAsset } from "./runtime-assets";
import { PackageDrift } from "./host/package-drift";
import {
  DIAGNOSTICS_DOCUMENT_PATH,
  DiagnosticsRecorder,
  WINDOW_DIAGNOSTIC_SUBJECT,
  redactCapabilities,
} from "./host/diagnostics";
import type { DiagnosticEnvironment, DiagnosticStageId } from "./host/diagnostics";
import {
  folderHeadline,
  relativeAge,
  sessionFileLabel,
  sessionItemState,
  sessionStateLabel,
  sessionHeadline,
  displaySessionTitle,
  SessionTreeItem,
  SessionTreeProvider,
  sizeText,
  WorkspaceFolderTreeItem,
} from "./views/session-tree";
import { ProcessTreeItem } from "./views/process-tree";
import { ToolsTreeProvider } from "./views/tools-tree";
import { SessionToolsController, type SessionToolsTarget } from "./host/session-tools";
import type { LauncherTreeItem, SessionLauncherFacts, SessionOwnershipFacts } from "./views/session-tree";
import { WorkspaceFolderRegistry, folderArgument, folderMatchesCwd, mergeWorkspaceFolderRecords, WORKSPACE_FOLDERS_STORAGE_KEY } from "./views/workspace-folders";
import { LauncherFolders } from "./views/launcher-folders";
import type { LauncherFolder } from "./views/launcher-folders";
import type { FolderPathInspector, FolderPathVerdict, WorkspaceFolder } from "./views/workspace-folders";
// The chat over rpc-ui (ADR-0038): a host-owned conversation per tab, served to any page.
import { ChatRuntime } from "./host/chat-runtime";
import type { ChatCommandOutcome, ChatPage, ChatRuntimeEvent } from "./host/chat-runtime";
import { attachRpcHost, launchRpcHost, retireStoppedRpcBroker, stopRpcHost } from "./host/rpc-launch";
import type { RpcAttachOutcome, RpcHostRuntime } from "./host/rpc-launch";
import { attachNativeHost, launchNativeHost, waitForManagedRootExit } from "./host/native-session";
import type { NativeAttachOutcome, NativeHostRuntime, SessionHostRuntime } from "./host/native-session";
import {
  createOwnerReconciler,
  kernelProcessIdentity,
  probeBrokerSlotForRunningChild,
  probeRpcHost,
  stopBrokerOwnedHost,
} from "./host/rpc-reconcile";
import type { NativeStopVerdict } from "./host/rpc-reconcile";
import type { RpcSession, SendOutcome, SendRefusal } from "./host/rpc/session";
import { readSlashRegistry, type BuiltinSlashEntry, type DeskSlashAction, type SlashRegistry } from "./host/slash-registry";
import { sessionPrompts } from "./webview/lib/prompt-history";
import { NAVIGATE_REFUSAL_SENTENCES, rewindPreview, rewindTargets } from "./chat/rewind";
import { rewindBlockedReason } from "./webview/lib/rewind-mode";
import type { ChatLiteState, ChatModel, ChatPhase } from "./chat/model";
import { cancelControlPicker, pickControlModel, pickControlThinking, pickToolCallDetail } from "./host/control-picker";
import { activitySignature, turnActivity, withRegistrySubagentWork } from "./webview/lib/activity";
import type { ChatDisplayPreferences, ChatWebviewMessage } from "./webview/chat-messages";
// The reconnecting bridge (ADR-0023): one exact listener per actual editor, durable
// records, one route per document, and one admission path for irreversible changes.
import { BridgeEditorEndpoint, BRIDGE_GUEST_RELOAD_REASON } from "./host/bridge-endpoint";
import type { BridgeBootstrapDelivery } from "./host/bridge-endpoint";
import { BridgeRecords, bindingMatches } from "./host/bridge-records";
import type { BridgeNativeBinding, BridgeRecordScope } from "./host/bridge-records";
import { BridgeAdmissionError } from "./host/bridge-route";
import type { BridgeDocumentRoute, BridgeEndpointState, BridgeReservation } from "./host/bridge-route";
import { EditorCoordinator } from "./host/editor-coordinator";
import { retireClosedEditorBridge } from "./host/bridge-lifecycle";
import type { BridgeAdmittedRequest, BridgeSession } from "./host/bridge-listener";
import {
  bridgeViewType,
  decodeBridgeViewType,
  persistedBridgeState,
  recoveredBridgePanelState,
  tabInputIdentity,
  TAB_INPUT_VIEW_TYPE_PREFIX,
  workspaceIdentityText,
} from "./bridge-identity";
import {
  BRIDGE_MAX_PLAINTEXT_BYTES,
  BRIDGE_PATH,
  asciiJsonText,
  createToken,
  decodeBase64Url,
  encodeBase64Url,
  encodeHex,
  randomBytes,
  sha256,
} from "./bridge-protocol";
import { isPanelTabId, persistedShellSlotId, shellIdentityBootstrapSource } from "./webview/panel-identity";
import { GUEST_PROTOCOL_VERSION, isSafeBoundaryText, parseGuestWebviewMessage, type GuestChatCommand, type GuestOpenDetailMessage, type GuestRecallPromptMessage } from "./webview/messages";
import { DETAIL_VIEW_TYPE, DetailTabs } from "./host/detail-tabs";
import type { DetailTarget } from "./webview/detail-target";
// The folder shell's terminal (ADR-0024): the extension-owned PTY broker is the writer, the
// panel is only a frontend, and this module owns the glue between them.
import { PtyBrokerClient } from "./host/pty-client";
import { createPtyReadinessGate } from "./host/pty-readiness";
import type { PtyReadinessGate } from "./host/pty-readiness";
import { createBrokerSlotStore, createHostSlotId, mergeBrokerSlotRecords, BROKER_SLOTS_KEY } from "./host/broker-slots";
import { createEditorSlotRegistry } from "./host/editor-slots";
import type { EditorSlotRegistry, EditorSlotRole } from "./host/editor-slots";
import type { BrokerSlotProvenance, BrokerSlotStore } from "./host/broker-slots";
import type { PtyHandle } from "./host/pty-client";
import { TerminalPipeline } from "./host/terminal-pipeline";
import type { TerminalHostMessage } from "./host/terminal-pipeline";
import { fileLinkMenuTarget, handleTerminalLink, openTerminalFile, openWebLink, revealPathInExplorer, revealPathInOs } from "./host/terminal-links";
import type { FileLinkAction, TerminalLinkRequest, TerminalLinkValidation, WebLinkMode } from "./webview/terminal-links";
import {
  createShellSlotId,
  createShellSlotStore,
  mergeShellSlotRecords,
  shellClosePrompt,
  reconnectableShellSlots,
  shellLaunchOutcome,
  shellSlotsForFolder,
  SHELL_SLOTS_KEY,
} from "./host/shell-slots";
import type { ShellLiveness, ShellSlotRecord, ShellSlotStore } from "./host/shell-slots";
import { stopShellAndBroker, watchShellExit, type ShellExitWatchStop } from "./host/shell-exit";
// The profile catalog (ADR-0034) is the one authority for this extension's durable
// state; it is profile-wide, so opening another VS Code folder neither hides the
// user's sessions and folders nor forks them.
import { catalogPaths, createCatalogStore, startCatalogWatch } from "./host/profile-catalog";
import type { CatalogStore } from "./host/profile-catalog";
import { importPredecessorFolders, predecessorStorageDir } from "./host/predecessor-import";
import { registerProcessesView } from "./host/process-wiring";
import { registerStatsDashboard } from "./host/stats-wiring";
import { SettingsEditors } from "./host/omp-settings-editor";
import type { SettingsEditorContext } from "./host/omp-settings-editor";
import { settingsSessionApply } from "./host/omp-settings-apply";
// The folder-shell owner hint and the broker's own answer about it (ADR-0030): the
// extension can only *discover* the candidate owning instance, and it may only report
// what the broker actually admitted.
import { folderShellOwnerHint } from "./host/shell-owner";
import { shellEditorTitle, shellCleanupDescription, watchShellOwnerStop } from "./host/shell-title";
import type { PtyOwnerHint, PtyOwnerStopState } from "./host/pty-protocol";
import { filetimeToEpochMs } from "./host/pty-protocol";
import type {
  GuestControlRequestMessage,
  GuestControlStateMessage,
  GuestPanelAction,
  GuestPanelActionMessage,
  GuestInsertTextMessage,
  GuestControlInvalidateMessage,
  GuestFileCompletionsMessage,
  GuestRouteOfferMessage,
  GuestBridgeBindMessage,
  GuestHostMessage,
  GuestDraftReplyMessage,
  GuestDraftRequestMessage,
  GuestDraftRestoreMessage,
  GuestSessionViewMessage,
  GuestTerminalFontMessage,
  GuestTerminalCopyReplyMessage,
  GuestTerminalCopyRequestMessage,
  GuestTerminalActivateMessage,
} from "./webview/messages";
// Host control — every symbol from the `src/host/control-*` modules is imported in
// this one block, so a rename there is a change here and nowhere else. The channel
// is optional: a failure to establish it never blocks a session.
import {
  CONTROL_RECIPIENT_DEFINE,
  createControlRequestId,
  controlPathEquals,
  createControlSlotId,
  readControlRendezvous,
} from "./host/control-protocol";
import type {
  ControlHostSnapshot,
  ControlModelRef,
  ControlRendezvous,
  ControlNativeState,
  ControlNativeTarget,
} from "./host/control-protocol";
import {
  HostControlClient,
  HostControlConfigurationError,
  HostControlIdentityError,
  HostControlRefusedError,
  HostControlUnavailableError,
  createControlRecipient,
  queryControlProcessGeneration,
  setControlHelperScript,
} from "./host/control-client";
import type { HostControlExpectation, HostControlVerifiedConnection } from "./host/control-client";
// Native file observation — read-only evidence. The producer lives in the native
// host (`src/omp/file-evidence.ts`, wired in `src/omp/host-control.ts`); these are
// the extension-side policy, reader and display helpers it is bound to.
import {
  fileEvidenceStoreRoot,
  observationCallKey,
  observationCallViews,
  observationComparisonNotice,
  observationComparisonTitle,
  observationDetailLines,
  observationDocumentPath,
  observationPathLabel,
  observationPairs,
  observationShortStage,
  observationSummaryLine,
  observationTextState,
  observationTokenFromPath,
  OBSERVATION_DOCUMENT_SCHEME,
} from "./host/file-evidence-reader";
import type { ObservationPair, ObservationTextState } from "./host/file-evidence-reader";
import {
  NATIVE_FILE_OBSERVATION_DISCLOSURE,
  NATIVE_FILE_OBSERVATION_DISCLOSURE_ID,
  deleteNativeFileObservationHistory,
  disableNativeFileObservationCapture,
  grantNativeFileObservationConsent,
  openNativeFileObservationJournal,
  readNativeFileObservationConsent,
  readNativeFileObservationDisable,
  resolveNativeFileObservationStorePaths,
  restrictNativeFileObservationStorage,
  revokeNativeFileObservationConsent,
} from "./host/native-file-observation-storage";
import type {
  NativeFileObservationJournal,
  NativeFileObservationStorePaths,
} from "./host/native-file-observation-storage";
import type {
  NativeFileObservationCallView,
  NativeFileObservationRecord,
} from "./host/native-file-observation";

const PANEL_VIEW_TYPE = "omp.session";
// The three packaged entries a child process runs. Each is staged into extension
// global storage before use (`runtimeEntries`), so no long-lived process holds
// a file inside the installed extension folder: that folder is what
// `code --install-extension <vsix> --force` renames, and an open file there is what
// fails the rename with EPERM.
/** Packaged native host-control module, loaded by `--preload` and `-e`. */
const HOST_CONTROL_MODULE = "out/omp-host-control.mjs";
/** Packaged peer-verified pipe helper, run per control connection. */
const CONTROL_HELPER = "out/verified-pipe.ps1";
/** Packaged helper that opens OMP's session-lease mutex without taking it (ADR-0046). */
const LEASE_HELPER = "out/session-lease-probe.ps1";
/**
 * The Bun helper that renames a *stopped* session's stored title through the
 * installed agent's own storage code. It is a plain packaged ESM file: it is not
 * bundled (it imports nothing from this repository) and it is staged like every
 * other child entry, so a reinstall of the extension cannot rename it away.
 */
const RENAME_HELPER_SCRIPT = "media/rename-session.mjs";
/** Packaged Bun helper that lists the installed OMP's builtin slash commands (`host/slash-registry.ts`). */
const SLASH_REGISTRY_HELPER = "media/slash-registry.mjs";
/**
 * The icon every OMP chat editor's tab carries, from this extension's own media.
 *
 * A tab is recognized as an OMP session by this icon rather than by a title
 * prefix, so the title itself is free to be exactly the session's own name.
 */
const EDITOR_TAB_ICON = "media/omp-icon.png";
/** Chat publishes promptly; native startup can wait on a heavy workspace. */
const CONTROL_RENDEZVOUS_TIMEOUT_MS = 15_000;
const NATIVE_CONTROL_RENDEZVOUS_TIMEOUT_MS = 60_000;
/** A host this launch already proved published once; a missing record is not startup lag. */
const PROVEN_CONTROL_RENDEZVOUS_TIMEOUT_MS = 3_000;
const CONTROL_RENDEZVOUS_POLL_MS = 250;
/**
 * Contributed launcher view that owns the activity-bar session list.
 */
const SESSIONS_VIEW_ID = "omp.sessions";
/**
 * Context key that keeps the launcher's welcome content off once it shows a folder:
 * a launcher with no folder (none open in this window, none pinned) has no group to
 * show, so its welcome content offers the Add Folder flow instead of an empty list.
 */
const HAS_WORKSPACE_FOLDERS_CONTEXT = "omp.hasWorkspaceFolders";
/**
 * Context key gating the Stop keybinding: true while the OMP chat panel the user
 * is looking at reports the host running a turn. It is set from the guest's own
 * activity reports and from no other source, so the key can never offer to stop
 * a turn nobody observed.
 */
const STREAMING_CONTEXT = "omp.streaming";
/**
 * Context key that keeps the Stop keybinding from firing on a popup dismissal:
 * true while the `@`-completion popup of the panel on screen is open. The
 * composer reports that state, it travels in the same activity report, and
 * Escape means one thing at a time because of it.
 */
const COMPOSER_POPUP_CONTEXT = "omp.composerPopupOpen";

/** What the user is told when a session cannot be opened safely. */
const CONFLICT_LABEL: Record<SessionConflictKind, string> = {
  live: "Another OMP process is already hosting this session",
  "claim-conflict": "Another OMP window holds this session",
  duplicate: "This session is already open in another tab",
};

/**
 * One editor's live resources and one conversation's native side, as this window
 * holds them.
 *
 * A record belongs to an **immutable editor slot** (ADR-0025): its key in
 * {@link tabs} is the editor id `E` (32 hex) for a session editor, the shell slot
 * id for a folder shell, or — only while a conversation has been launched or
 * navigated but no editor exists for it yet — the conversation's own `tab:<uuid>`
 * id. {@link bindSlotToConversation} moves that pre-editor record under the
 * editor's immutable key, so one editor's resources are never reachable under two
 * keys.
 *
 * `tabId` is therefore *mutable*: a settled native switch changes which
 * conversation this editor shows and moves nothing else. Two editors of one
 * conversation (its controller and a passive one that keeps an unsent draft) are
 * two records, each under its own editor id, and can never collide.
 *
 * Whether a slot may *act* is not stored here: the {@link editorSlots} registry owns
 * role, generation and the reason a slot is passive, and {@link passiveReasonOf} is
 * the one way to read it.
 */
interface TabState {
  /** The immutable key this record is filed under in {@link tabs}. */
  slotId: string;
  /** The conversation this editor shows, or `null` for a folder shell. */
  tabId: string | null;
  panel: vscode.WebviewPanel | null;
  runtime: SessionHostRuntime | null;
  mode: SessionViewMode;
  /** Admission fence independent of the lifecycle gate and modal dialogs. */
  transitioning: boolean;
  nativeWatch: (() => void) | null;
  viewProjection: GuestSessionViewMessage | null;
  /**
   * Which document the bound panel shows: the guest bundle, a bounded explanation while
   * the bridge endpoint it needs does not exist yet, or `null` while it has none. A panel
   * can be bound before that endpoint exists (VS Code may restore an editor during
   * activation), so it starts on the explanation document and is pointed at the guest
   * bundle once one is known. Ordinary updates never reload a live document;
   * replacing its native child explicitly starts a fresh document incarnation.
   */
  document: PanelDocument | null;
  /**
   * The detach function of the route currently carrying this editor's conversation (panel or
   * bridge), and that route's id. The conversation is the host's; this is only how one editor
   * is pointed at it.
   */
  chatDetach: (() => void) | null;
  chatPageId: string | null;
  /**
   * The document facts a page reported with `omp:ready` while this editor was not yet
   * controlling. That report is the only chance the host gets to pin the document's Origin
   * (a page announces itself once), so it is held here and applied the moment the editor
   * may act; without it the document is never committed and a page that outlives a
   * host-only restart has no bridge secret to reconnect with.
   */
  heldReadyReport: { readonly documentId: string; readonly bootstrapId: string; readonly origin: string } | null;
  /**
   * How the bound panel came to exist. VS Code's own restored editor wins over a
   * transient panel an explicit open created, and the first restored editor wins
   * over a second one for the same tab; the origin is what tells them apart.
   */
  origin: "created" | "restored" | null;
  /**
   * Sequence numbers of this tab's two editor events — the last open/view
   * request and the last close — both from {@link editorEventSequence}, so their
   * order is known rather than guessed. `-1` means the event never happened in this
   * window. An open attempt that waited for the activation pass compares them
   * on resume so its continuation cannot reopen an editor closed meanwhile.
   */
  lastOpenRequest: number;
  lastEditorClose: number;
  /** Verified host-control channel for this tab, when one is established. */
  control: {
    readonly client: HostControlClient;
    /** Last snapshot read back from the host. */
    snapshot: ControlHostSnapshot | null;
    /** Positive local launch capability; absence never permits probing an older server. */
    readonly activity: boolean;
    /** Positive local staged-host capability for the additive work response. */
    readonly work?: boolean;
    /** Positive local staged-host capability for the registry `subagentWork` request. */
    readonly subagents?: boolean;
  } | null;
  /** Why host control is currently unavailable, shown rather than hidden. */
  controlFailure: string | null;
  /** Frontend for a folder shell or the managed native session. */
  pipeline: TerminalPipeline | null;
  /** The folder-shell slot this editor carries, when this tab *is* a folder shell. */
  shellSlot: string | null;
  /**
   * The live subscription keeping this shell editor's title in step with the broker's own
   * owner-stop verdict, or `null` when this tab has none (every non-shell tab, and a shell
   * whose editor is gone). A verdict can change while the editor is open — a lost helper
   * disarms an armed shell — so the title is refreshed on each transition rather than
   * decided once, and the subscription dies with the editor it belongs to.
   */
  ownerStopWatch: ShellExitWatchStop | null;
  /**
   * The bridge endpoint this tab's editor owns, once one exists.
   *
   * `editorId` is the actual editor (`E`) — what VS Code itself restores, what the
   * endpoint's listener is bound for, and what its durable records are filed under.
   * A tab with no entry has not been given a bridge editor yet (a legacy panel
   * before its one-time migration, or a window that never created one).
   */
  bridge: {
    readonly editorId: string;
    readonly endpoint: BridgeEditorEndpoint;
    /** The document incarnation whose HTML this tab's panel currently shows. */
    documentId: string | null;
    /** Whether the page acknowledged the current secret delivery. */
    bound: boolean;
  } | null;
}

/**
 * The activation context, for the few callbacks this module wires without one.
 *
 * It is set once in `activate` and only ever read by callbacks the window owns
 * (the turn notifier's "show terminal" action), so nothing else has to thread it.
 */
let activationContext: vscode.ExtensionContext | undefined;

/** One bound panel's document: the guest bundle, or a bounded explanation. */
interface PanelDocument {
  readonly kind: "guest" | "unavailable";
  /** The one bridge document embedded in this HTML, if any. */
  readonly bridgeDocumentId: string | null;
}

/**
 * One window-wide counter numbering every editor event — an open/view request
 * and a panel close — so their order per tab is known (`TabState.lastOpenRequest`,
 * `TabState.lastEditorClose`). A counter rather than a timestamp: two events in
 * the same millisecond still have to be ordered, and nothing outside this window
 * reads it.
 */
let editorEventSequence = 0;

/** Non-secret control facts persisted per ownership so a reload can reattach. */
interface RecordedControlProcess {
  readonly pid: number;
  /** Kernel creation time of that pid; the process-generation identity. */
  readonly processCreation: string;
  readonly slotId: string;
  readonly directory: string;
  readonly activity?: true;
  readonly work?: true;
  /** The child answers the registry `subagentWork` request; absent for a process an older build launched. */
  readonly subagents?: true;
}

/**
 * One launch this window confirmed stopped, remembered under its claim.
 *
 * A release is the launcher's own evidence that a specific slot's process exited
 * (the stop is only confirmed after the pid is gone). It names the slot, so it can
 * only ever speak for the launch it released.
 */
interface RecordedControlRelease {
  readonly slotId: string;
  readonly releasedAt: string;
}

/** Releases remembered per claim; a slot id is never reused, so this is bounded history. */
const CONTROL_RELEASE_HISTORY = 16;

/**
 * The one authoritative map of every editor's live resources (ADR-0025).
 *
 * The key is the immutable editor slot (see {@link TabState}), never the
 * conversation: a settled native switch changes what its editor shows and moves
 * nothing, and two editors of one conversation each keep their own record. A key
 * that names a conversation exists only while that conversation has no editor yet
 * (its launch or navigation record); binding an editor moves it under the editor's
 * key. Read it through {@link stateOf}, which resolves both key kinds, and never by
 * taking whichever entry happens to show a conversation.
 */
const tabs = new Map<string, TabState>();
const sessionClicks = new SessionClickRecognizer();
const footerBindings = new Map<string, {
  cwd: string;
  message: FooterMetadataMessage;
  observer: BranchObservation | null;
  modelId: string | null;
}>();
const usageCaches = new Map<string, ProviderUsageCache>();
let defaultProviderModelsAvailable: boolean | null = null;
let defaultProviderModelsRead: Promise<void> | null = null;
let defaultProviderModelsDirty = false;
const sessionModelReads = new Map<string, Promise<void>>();
const sessionModelRefreshOwed = new Set<string>();
let providerLoginTerminal: vscode.Terminal | null = null;
let providerLoginOpening = false;
/**
 * This activation's host generation `H`.
 *
 * One per extension-host activation, not per editor: it is what makes an
 * acknowledgement, a reply or a mutation minted for a previous host unusable in
 * this one, so a restarted host needs no coordination with the host it replaced.
 */
const bridgeHostGeneration: Uint8Array = randomBytes(16);
/** This window's canonical workspace hash `W`, resolved once per activation. */
let bridgeWorkspace: string | null = null;
/** Durable bridge records of this workspace, created on first use. */
let bridgeStore: BridgeRecords | null = null;
/** One endpoint per actual editor (`E`) this window serves. */
const bridgeEndpoints = new Map<string, BridgeEditorEndpoint>();
/** Endpoint creation must be single-flight: concurrent restore, tab and panel callbacks share its exact port. */
const pendingBridgeEndpoints = new Map<string, Promise<BridgeEditorEndpoint | null>>();
/** Dynamic bridge view types this activation registered a serializer for. */
const bridgeSerializerTypes = new Set<string>();
/** Editor ids present in this window's actual editor membership right now. */
const bridgeLiveEditors = new Set<string>();
/** The one-winner reservation table of this window's editors (ADR-0019/0023). */
const bridgeEditors = new EditorCoordinator();
/** Last restore outcome per tab: real refused/failed status the launcher shows. */
const outcomes = new Map<string, RestoreOutcome>();
/**
 * Explicit opens in flight, one promise per tab.
 *
 * Two clicks on one row must converge on one attempt: without this, the second
 * reaches `SessionIndex.restore` for a tab the first is already restoring, the
 * index refuses it as a duplicate, and the panel that click had just created is
 * left disconnected. The entry is removed when the attempt settles, so a later
 * click is a fresh attempt — which is what keeps a refused or failed open
 * retryable.
 */
const openingTabs = new Map<string, Promise<void>>();
/** Confirmed recorded-host stops still awaiting their broker verdict. */
const stoppingTabs = new Set<string>();
/**
 * The activation restore pass, while it is still running.
 *
 * Activation reconciles and launches every indexed row before it publishes any
 * panel, so a click on one of those rows that arrives during that window would
 * otherwise open a tab the pass is already restoring: the index refuses it as a
 * duplicate and the session the user asked for never appears.
 *
 * `cohort` is captured before the pass starts: the rows activation is responsible
 * for. `settled` resolves only after the pass has restored them *and* published
 * every panel and the final focus, so a click can wait for what the pass is about
 * to publish instead of racing it. `null` once the pass is over — after which a
 * click only has to read the panels it left behind.
 */
let startupRestore: { readonly settled: Promise<void>; readonly cohort: ReadonlySet<string> } | null = null;
/**
 * `true` from activation until the startup pass has captured its cohort. The catalog is adopted
 * (and the launcher first built) before the pass starts, and a row this window is going to
 * re-adopt must not read "Blocked" for that stretch: it is derived from the same membership
 * the cohort will use.
 */
let startupRestorePending = true;
/**
 * The host-owned chat conversations of this window, one per tab (ADR-0038), created by
 * activation. A conversation exists whether or not an editor shows it: it is attached to the
 * running child, reads history from disk, folds the child's frames and serves any page.
 */
let chat!: ChatRuntime;
/**
 * Read-only detail tabs (TODO, agent roster, one agent) of the conversations in this window. They
 * are presentation pages of a conversation, not editor slots: no binding, claim, bridge or restore.
 */
let detailTabs!: DetailTabs;
/**
 * Last host-observed turn activity per tab, projected from the conversation's own model.
 *
 * This is the extension host's view of whether a turn is running: the `omp.streaming`
 * context key, the Sessions rows and the completion notifications all derive from it, so a
 * hidden or closed tab is reported exactly like a visible one.
 */
const turnActivities = new Map<string, TurnActivity>();
/** Tabs whose composer currently shows its `@`-completion popup (reported by the page). */
const composerPopupTabs = new Set<string>();
/** The OMP editors of this window in the order the user last focused them; orders the add-to-session picker. */
const editorRecency = new EditorRecency();
let toolsController: SessionToolsController | null = null;
/**
 * The document each editor's page has announced (`omp:ready`) it is listening in. A reference is
 * posted to a chat page only once its current document is in here: a page that has not announced
 * itself has no composer to receive it.
 */
const readyDocuments = new WeakMap<TabState, PanelDocument>();

/** Records that the page of the editor's current document announced itself, so text can be sent to its composer. */
function noteReadyDocument(state: TabState, announcedDocumentId: string | undefined): void {
  const document = state.document;
  if (document === null || (announcedDocumentId ?? null) !== document.bridgeDocumentId) return;
  readyDocuments.set(state, document);
}

/**
 * Ownership reconciliation for this window, built by activation.
 *
 * It is not a bare module function on purpose: reconciling a surviving writer needs
 * the durable broker-slot locator and the PTY broker client, and the transport it
 * proves must be the transport the later attach uses. Activation owns both, so it
 * builds the ports here — before any restore, open or draft pass runs.
 */
let reconciler!: OwnerReconciler;

let output: vscode.OutputChannel | undefined;
/** The activity-bar launcher, when this window created it. */
let launcherProvider: SessionTreeProvider | undefined;
/** The session-lease observer of this window (ADR-0046); `null` where there is no probe. */
let externalLeases: ExternalLeaseObserver | null = null;
let launcherView: vscode.TreeView<LauncherTreeItem> | undefined;
let launcherRevealInFlight: Promise<void> | null = null;
let launcherRevealRequested = false;
let launcherSelectedPath: string | null = null;
/** The tab whose folder the next reveal may expand because the user just activated it, or `null`. */
let launcherExpandFor: string | null = null;
const launcherRuntimeIds = new WeakMap<SessionHostRuntime, number>();
let nextLauncherRuntimeId = 0;
/**
 * The folders the launcher shows in this window: the folders VS Code has open, the
 * profile-wide pinned list and folders kept visible by a live session, deduplicated
 * by path identity. It owns no session identity and no history;
 * `src/views/launcher-folders.ts` owns the merge, `src/views/workspace-folders.ts`
 * owns the pinned list's schema, and `src/host/folder-history.ts` owns the on-demand
 * discovery a folder's Resume action asks for.
 */
let launcherFolders: LauncherFolders | undefined;
/**
 * This window's turn notifier, created once per session index.
 *
 * Its ledger must outlive any single panel document: a Webview reload
 * re-reports the session's current activity, and the ledger is what keeps that
 * from becoming a second notice for an event the user was already told about.
 */
let turnNotifier: { readonly index: SessionIndex; readonly notifier: TurnNotifier } | undefined;

/**
 * The extension-owned PTY broker client: the only way this window starts or
 * re-adopts a managed writer (ADR-0024).
 *
 * Created once per activation. Its presence is not evidence that a broker exists —
 * {@link ready} answers that — and nothing here starts a process by itself.
 */
let ptyClient: PtyBrokerClient | undefined;
/**
 * This window's readiness gate over {@link ptyClient}.
 *
 * `PtyBrokerClient.ready()` refuses to cache a failure on purpose — a half-finished
 * staging pass is the usual cause — so the window must not cache one either: a
 * transient self-check failure at startup would otherwise make every surviving
 * broker unadoptable for the rest of the activation. The gate latches a *proven*
 * runtime, shares one attempt between callers that arrive together, and retries a
 * failed check when a later row, click, recheck or attach asks again.
 */
let ptyGate: PtyReadinessGate | undefined;
/**
 * Which broker slot each managed host occupies, keyed by the editor slot that
 * opened it and by the conversation it currently serves.
 *
 * The slot is the only way a broker record is found again, so it must survive both
 * a conversation switch and an extension-host restart — which is why it is neither
 * derived from the conversation id nor from anything the process reports.
 */
let brokerSlots: BrokerSlotStore | undefined;
/**
 * This window's map from an immutable editor slot to the live resources it holds.
 *
 * Derived state, rebuilt as panels are bound: it tells a slot apart from the
 * conversation it currently shows, so two editors of one conversation (a stopped
 * editor and the editor a native switch moved onto that conversation) coexist with
 * exactly one controller and no key collisions.
 */
const editorSlots: EditorSlotRegistry = createEditorSlotRegistry();
/** The durable folder-shell slot registry; folder shells are never sessions. */
let shellSlots: ShellSlotStore | undefined;
/**
 * Folder-shell editors this window carries: slot id to the tab id its editor uses.
 *
 * A shell is not an indexed tab, but it needs the same panel plumbing (one editor,
 * one serializer identity, one protocol for its page). The mapping is what lets a
 * close, a reconnect and a serializer revival find the same slot.
 */
const shellEditors = new Map<string, string>();


/** Staged copies every child process of this window runs. */
interface StagedRuntimeEntries {
  /** The host-control module the native OMP process preloads and `-e`-loads. */
  readonly hostControl: StagedRuntimeAsset;
  /** The peer-verified pipe helper the control client runs per connection. */
  readonly controlHelper: StagedRuntimeAsset;
  /** The Bun helper a stopped-session rename runs (never an OMP session). */
  readonly renameHelper: StagedRuntimeAsset;
}

let stagedEntries: Promise<StagedRuntimeEntries> | null = null;

/** Do the copies still hold the bytes their digests name? */
async function stagedEntriesIntact(entries: StagedRuntimeEntries): Promise<boolean> {
  for (const asset of [entries.hostControl, entries.controlHelper]) {
    if (!(await verifyStagedRuntimeAsset(asset))) return false;
  }
  return true;
}

/**
 * The staged copy of the session-lease probe helper (ADR-0046), verified before it is handed out.
 *
 * Staged on its own, not with {@link runtimeEntries}: the probe is optional, so a missing or
 * changed helper only turns the probe off and must never stop a host from launching.
 */
async function stageLeaseHelper(context: vscode.ExtensionContext): Promise<StagedRuntimeAsset | null> {
  if (stagedLeaseHelper !== null) {
    const cached = await stagedLeaseHelper;
    if (cached !== null && await verifyStagedRuntimeAsset(cached)) return cached;
  }
  stagedLeaseHelper = stageRuntimeAssets({
    storageDir: context.globalStorageUri.fsPath,
    sourcePaths: [context.asAbsolutePath(LEASE_HELPER)],
  }).then(([helper]) => helper ?? null).catch((error: unknown) => {
    log(`session lease helper could not be staged: ${messageOf(error)}`);
    return null;
  });
  return await stagedLeaseHelper;
}

let stagedLeaseHelper: Promise<StagedRuntimeAsset | null> | null = null;

/**
 * The verified copies of this window's runtime entries.
 *
 * Every entry is copied to `<globalStorage>/runtime/<sha256>/<name>`, and the copy
 * is re-read and re-hashed on *every* call — immediately before its caller hands
 * the path to a child process. A path that was correct when it was staged is not a
 * promise about now, so a copy that changed under us is staged again from the
 * packaged file instead of being executed. The staged tree must be writable only by
 * this account, which `stageRuntimeAssets` establishes and verifies before it
 * returns any copy.
 *
 * Running from those copies is what keeps a reinstall from waiting for a session:
 * the installed extension folder is what `code --install-extension <vsix> --force`
 * renames, and a process still reading a file inside it is what fails that rename.
 * A staged file's digest also names its directory, so this build's copies are told apart
 * from another build's.
 *
 * A failure is not cached: the next caller stages again, because the file a failed
 * attempt could not read is usually the one a half-finished install replaced.
 * Staging also points the control client at the helper copy, so `activate` calls
 * this once and every later use — including the process-generation probe for an
 * already running host — finds it configured.
 */
async function runtimeEntries(context: vscode.ExtensionContext): Promise<StagedRuntimeEntries> {
  const cached = stagedEntries;
  if (cached !== null) {
    const entries = await cached;
    if (await stagedEntriesIntact(entries)) return entries;
    log("a staged runtime copy no longer matches its digest; staging the packaged entries again");
    stagedEntries = null;
  }
  const staging = (async () => {
    // Staging copies the packaged entries. After a reinstall those are the new build's, and a child
    // started from them would speak to this (old) host with the new build's protocol.
    if (packageChangedOnDisk()) throw new Error(UPDATED_ON_DISK_ERROR);
    const [hostControl, controlHelper, renameHelper] = await stageRuntimeAssets({
      storageDir: context.globalStorageUri.fsPath,
      sourcePaths: [
        context.asAbsolutePath(HOST_CONTROL_MODULE),
        context.asAbsolutePath(CONTROL_HELPER),
        context.asAbsolutePath(RENAME_HELPER_SCRIPT),
      ],
    });
    setControlHelperScript(controlHelper.path, controlHelper.sha256);
    return { hostControl, controlHelper, renameHelper };
  })();
  stagedEntries = staging.catch((error: unknown) => {
    stagedEntries = null;
    throw error;
  });
  return stagedEntries;
}

async function revealDesktopNotification(index: SessionIndex, extensionId: string, uri: vscode.Uri): Promise<void> {
  if (uri.authority.toLowerCase() !== extensionId.toLowerCase() || uri.path !== "/reveal") return;
  const tabId = new URLSearchParams(uri.query).get("session");
  if (tabId === null || !/^tab:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tabId)) return;
  const panel = stateOf(tabId)?.panel;
  if (index.get(tabId) !== null) {
    if (panel !== null && panel !== undefined) {
      panel.reveal(panel.viewColumn, false);
      return;
    }
    const provider = launcherProvider;
    const view = launcherView;
    if (provider !== undefined && view !== undefined) {
      const item = await provider.itemFor(tabId);
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
  log("The notified session has no retained editor or Sessions row in this window.");
}

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel("OMP Desk");
  activationContext = context;
  void installedNerdFonts().then(families => {
    installedTerminalFonts = families;
    for (const state of tabs.values()) if (state.mode === "terminal" || state.shellSlot !== null) pushTerminalFont(state);
  });
  // The report's window timeline starts here: every window-level measurement is relative to
  // the extension host's own activation.
  diagnostics.beginSubject(WINDOW_DIAGNOSTIC_SUBJECT, { label: "window", kind: "window" });
  diagnostics.note(WINDOW_DIAGNOSTIC_SUBJECT, "extension host activated");
  if (context.extensionMode === EXTENSION_MODE_PRODUCTION) {
    // What this host started from. A same-version reinstall replaces these files under the running
    // window without restarting it; `packageChangedOnDisk` is how that becomes visible.
    const drift = new PackageDrift(context.extensionUri.fsPath);
    packageDrift = drift;
    void drift.capture();
    const poll = setInterval(() => { packageChangedOnDisk(); }, PACKAGE_DRIFT_POLL_MS);
    context.subscriptions.push({ dispose: () => clearInterval(poll) });
  }
  const catalog = createProfileCatalog(context);
  catalogStore = catalog;
  // The launcher reports that it is still reading the profile's stored sessions until
  // the one-time import of the predecessor build's folder list has settled, so an empty
  // catalog never presents itself as "no folder is registered" while the folders the
  // user already had are still being imported.
  void vscode.commands.executeCommand("setContext", CATALOG_PENDING_CONTEXT, true);
  const index = new SessionIndex({
    store: catalog,
    // This window's own observations — its availability reads, the reply its panels
    // displayed, the tab it selected — stay in this window's own store. They are not
    // shared facts: a rival window's failed attach must never publish a status over a
    // session another window is running (ADR-0034).
    localStore: context.workspaceState,
    claimStorageDir: context.globalStorageUri.fsPath,
    claimHolder: { ...createClaimHolder(), windowUri: owningWindowUri()?.toString() ?? null },
    log: message => log(message),
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
  const folders = new LauncherFolders({
    pinned: registry,
    local: context.workspaceState,
    windowPaths: () => (vscode.workspace.workspaceFolders ?? [])
      .filter(folder => folder.uri.scheme === "file")
      .map(folder => folder.uri.fsPath),
    showWindowFolders: () => vscode.workspace.getConfiguration("omp").get<boolean>("showWorkspaceFolders", true),
    // A live row never vanishes with its folder: a session this window runs or is starting
    // keeps its folder visible although it is neither open nor pinned.
    liveSessionCwds: () => index.list()
      .filter(entry => {
        const facts = launcherFacts(entry.tabId);
        return facts.running || facts.launching === true;
      })
      .map(entry => entry.cwd),
  });
  launcherFolders = folders;
  if (folders.loadError !== null) showWarning(folders.loadError);
  // The in-tab terminal's own state. The broker client is created here but starts
  // nothing: `ready()` is asked for lazily, so a window that never opens a managed
  // session never stages or spawns a broker. The surface map and the shell-slot
  // registry are durable and per workspace context, exactly like the folder list.
  ptyClient = new PtyBrokerClient({
    storageDir: context.globalStorageUri.fsPath,
    extensionRoot: context.extensionUri.fsPath,
  });
  // Readiness is asked for lazily and a *failed* check is not latched, so a transient
  // staging or self-check failure is retried by the next reconciliation, attach or
  // open instead of disabling the broker path for the whole activation.
  ptyGate = createPtyReadinessGate({
    client: ptyClient,
    onFailure: reason => log(`the PTY broker runtime is not usable yet: ${reason}`),
  });
  shellSlots = createShellSlotStore(catalog);
  brokerSlots = createBrokerSlotStore(catalog);
  // VS Code owns editor existence and layout, and it restores an editor only
  // through the serializer registered for its view type. Registration is
  // synchronous and happens before the asynchronous work below, so an editor VS
  // Code is already reviving always finds one; the panel it hands back carries
  // the tab identity its own document persisted (`src/webview/panel-identity.ts`),
  // which the index then resolves. The index stays authoritative for what the
  // session is and who may write it — a restored editor is a view of a row, never
  // a second claim on it.
  indexForBridge = index;
  // Ownership reconciliation reads the facts this window owns, and it proves the
  // *transport* an attach will use: a durable broker slot is looked up here (never
  // from a panel, which a restored row may not have yet), a read-only probe decides
  // whether that broker still owns the recorded child, and a host with no broker
  // provenance keeps the legacy exact-PID terminal path.
  reconciler = createOwnerReconciler({
    // The one reading that tells a recycled pid apart from the child this window launched:
    // the kernel creation time, read through the broker's own staged probe helper. A
    // platform or helper that cannot answer returns `unknown`, which keeps the recorded
    // claim rather than freeing it.
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
      const byConversation = brokerSlots?.forConversation(request.entry.tabId) ?? null;
      if (byConversation !== null) return byConversation;
      for (const binding of indexForBridge?.slotsForConversation(request.entry.tabId) ?? []) {
        if (binding.role !== "controlling") continue;
        const byEditor = brokerSlots?.forEditor(binding.slotId) ?? null;
        if (byEditor !== null) return byEditor;
      }
      return null;
    },
    // Unreadable provenance proves no ownership; the user's actions remain available.
    brokerProvenance: request => brokerProvenanceFor(request.entry.tabId),
    // Proves one rpc row's recorded child from a read-only broker attachment.
    probeRpc: async (slot, expected, kind) => {
      const client = await attachBrokerClient();
      if (client === null) return { kind: "unreachable", reason: "the PTY broker is not available in this window" };
      return await probeRpcHost({ client, slot, expected, ...(kind === undefined ? {} : { kind }) });
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
    const session = chat.sessionOf(tabId);
    return {
      folder: entry.cwd,
      profile: entry.scope.profile ?? DEFAULT_OMP_PROFILE,
      executable: await executableFor(stateOf(tabId)?.runtime ?? null),
      sessionLabel: entry.title ?? "launching Chat",
      ...(session === null ? {} : {
        applyDefault: settingsSessionApply(session, () => {
          const current = index.get(tabId);
          return chat.sessionOf(tabId) === session && stateOf(tabId)?.mode !== "terminal" && stateOf(tabId)?.transitioning !== true
            && current !== null && current.cwd === entry.cwd && current.scope.profile === entry.scope.profile;
        }),
      }),
    };
  };
  // Settings open in the global scope; the editor's scope control reaches a project folder.
  const settingsEditors = new SettingsEditors(context, {
    defaultProfile: () => {
      const active = index.activeTabId === null ? null : index.get(index.activeTabId);
      return active?.scope.profile ?? process.env.OMP_PROFILE ?? process.env.PI_PROFILE ?? DEFAULT_OMP_PROFILE;
    },
    folders: () => folders.list().map(folder => folder.path),
  });
  context.subscriptions.push(settingsEditors);
  chat = new ChatRuntime({
    hostNonce: createToken(),
    onEvent: (tabId, event) => handleChatEvent(context, index, tabId, event),
    readDisplayPreferences: readChatDisplayPreferences,
    writeToolCallDetail: writeChatToolDetail,
    pickToolCallDetail,
    // Terminal-UI builtins typed into Chat are answered, not sent (ADR-0052); the list is the installed OMP's.
    slashRegistry: () => currentSlashRegistry(context),
    runDeskAction: async (action, tabId) => {
      if (action !== "models-settings") return runDeskSlashAction(action);
      await settingsEditors.open("models", await settingsBinding(tabId));
    },
    // Models from a Chat shows that Chat's folder so its default can be applied to the session;
    // agent settings are global, so Agents opens in the global scope for the Chat's profile.
    openSettings: async (kind, tabId) => {
      const binding = await settingsBinding(tabId);
      await settingsEditors.open(kind, kind === "agents" ? { folder: null, profile: binding.profile, ...(binding.executable ? { executable: binding.executable } : {}) } : binding);
    },
  });
  detailTabs = new DetailTabs({
    createPanel: (conversation, target) => {
      const entry = index.get(conversation);
      const headline = launcherProvider?.headlineFor(conversation) ?? (entry === null ? "OMP session" : sessionHeadline(entry, null));
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
    attachPage: (conversation, page) => chat.attachPage(conversation, page),
    handleMessage: (conversation, message, origin) => chat.handleMessage(conversation, message, origin),
    openUrl: async (url, mode) => {
      try { await openPageWebLink(url, mode); }
      catch (error) { log(`detail link: cannot open ${url}: ${messageOf(error)}`); showWarning(`cannot open ${url}: ${messageOf(error)}`); }
    },
    log,
  });
  context.subscriptions.push({ dispose: () => {
    cancelControlPicker();
    detailTabs.dispose();
    chat.dispose();
    for (const binding of footerBindings.values()) binding.observer?.dispose();
    footerBindings.clear();
    usageCaches.clear();
    sessionModelRefreshOwed.clear();
  } });
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer(PANEL_VIEW_TYPE, legacySerializerFor(context, index)),
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
  void closeLeftoverDetailTabs().catch(error => log(`detail tabs: leftovers could not be closed (${messageOf(error)})`));
  // A plain omp outside this extension writing one of these sessions is told from the sessions this
  // extension owns through the session lease OMP itself takes (ADR-0046). The probe only opens a
  // named mutex and closes it, and a failed probe leaves every row exactly as it was.
  externalLeases = process.platform !== "win32" ? null : new ExternalLeaseObserver({
    probe: powershellLeaseProbe({ helper: () => stageLeaseHelper(context), log }),
    ownersDir: () => ompSessionOwnersDir({ homeDir: os.homedir(), configDirName: process.env.PI_CONFIG_DIR }),
    readSessionId: async file => (await readSessionFileHeader(file))?.sessionId ?? null,
    knownFiles: () => index.list().flatMap(entry => entry.sessionFile === null ? [] : [entry.sessionFile]),
    log,
  });
  const provider = new SessionTreeProvider({
    folders: () => folders.list(),
    entries: () => index.list(),
    activeTabId: () => index.activeTabId,
    facts: launcherFacts,
    runtimeIdentity: launcherRuntimeIdentity,
    observeOwnership: tabId => launcherOwnershipFacts(index, tabId),
    // A folder offers Reconnect Terminal exactly when a detached shell of that
    // folder could still be attached to. Shell slots never become rows.
    hasRecoverableShell: folder => recoverableShellsInFolder(folder.path).length > 0,
  }, { onObservationError: error => log(`launcher: row observation failed: ${messageOf(error)}`) });
  launcherProvider = provider;
  const view = vscode.window.createTreeView(SESSIONS_VIEW_ID, { treeDataProvider: provider });
  launcherView = view;
  subscribeProviderLoginRefresh(context, index);
  const toolsProvider = new ToolsTreeProvider();
  const toolsView = vscode.window.createTreeView("omp.tools", { treeDataProvider: toolsProvider });
  const tools = new SessionToolsController(() => toolsTarget(index), snapshot => toolsProvider.setSnapshot(snapshot));
  toolsController = tools;
  context.subscriptions.push(
    toolsProvider, toolsView, tools,
    { dispose: () => { if (toolsController === tools) toolsController = null; } },
    toolsView.onDidChangeVisibility(event => tools.setVisible(event.visible)),
    vscode.window.tabGroups.onDidChangeTabs(() => tools.sync()),
    vscode.commands.registerCommand("omp.refreshTools", () => tools.refresh()),
  );
  tools.setVisible(toolsView.visible);
  const chooseDefaultView = () => chooseDefaultSessionView(context);
  // Another window opening or releasing a session is only visible as a claim file appearing,
  // changing or going away. The watch is a hint that re-reads the ownership of the rows filed
  // under the changed claims; it starts, claims and stops nothing, and spawns no process of its own.
  const claimWatch = startClaimWatch(
    index.claimStorageDir,
    claimFiles => refreshRowsForClaims(index, claimFiles),
    { onError: detail => log(`claims: ${detail}`) },
  );
  context.subscriptions.push(
    output,
    vscode.workspace.onDidChangeConfiguration(refreshChatDisplayPreferences),
    provider,
    view,
    provider.onDidServeTree(() => { void revealActiveSession(index); }),
    { dispose: claimWatch },
    // The window's own folders are shown in Sessions: a change of the open folders or of the
    // setting that hides them rebuilds the list. Resolved paths are remembered per path, so an
    // open-folder change forgets them; nothing else is read from disk for it.
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      folders.forgetIdentities();
      refreshLauncher();
    }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration("omp.showWorkspaceFolders")) refreshLauncher();
    }),
    vscode.workspace.onDidChangeConfiguration(event => {
      for (const state of tabs.values()) {
        if (state.panel === null || (state.shellSlot === null && state.mode !== "terminal")) continue;
        const resource = terminalFontResource(state);
        if (TERMINAL_FONT_CONFIGURATION_KEYS.some(key => event.affectsConfiguration(key, resource))) pushTerminalFont(state, resource);
      }
    }),
    // Nothing here polls: the launcher re-reads on the events that can change a
    // row — this window regaining focus, the view being opened, and the
    // terminal/panel/restore lifecycle — and after every index or folder
    // mutation. Opening the view never discovers anything: a folder's sessions
    // are found only when the user asks to resume one.
    view.onDidChangeVisibility(event => {
      if (!event.visible) return;
      // A missed catalog notification is recovered here rather than leaving another
      // window's sessions or folders invisible until a restart.
      void adoptCatalogChanges(index, folders).catch(error => log(`catalog: the newest revision could not be adopted: ${messageOf(error)}`));
      refreshLauncher({ ownership: true });
    }),
    vscode.window.onDidChangeWindowState(event => {
      if (!event.focused) return;
      const active = activePanelTab();
      if (active !== null) activateNativeEditor(active);
      // Focus is the recovery point for a notification this window missed.
      void adoptCatalogChanges(index, folders).catch(error => log(`catalog: the newest revision could not be adopted: ${messageOf(error)}`));
      refreshLauncher({ ownership: true });
    }),
    // Collapsing a folder is presentation only, and the saved value is what its node is built
    // from (durable for a pinned folder, per window otherwise); nothing here re-reads sessions or
    // touches an editor.
    view.onDidCollapseElement(event => {
      if (event.element instanceof WorkspaceFolderTreeItem) {
        void folders.setCollapsed(event.element.folder.id, true).then(() => reportFolderSaveFailure(folders));
      }
    }),
    view.onDidExpandElement(event => {
      if (event.element instanceof WorkspaceFolderTreeItem) {
        void folders.setCollapsed(event.element.folder.id, false).then(() => reportFolderSaveFailure(folders));
      }
    }),
    vscode.commands.registerCommand("omp.newSession", (argument: unknown) => newSession(context, index, argument)),
    vscode.commands.registerCommand("omp.openSessionInChat", (argument: unknown) => openSessionInMode(context, index, argument, "chat")),
    vscode.commands.registerCommand("omp.openSessionInTerminal", (argument: unknown) => openSessionInMode(context, index, argument, "terminal")),
    vscode.commands.registerCommand("omp.showSessionInChat", (argument: unknown) => openSessionInMode(context, index, argument, "chat", "show")),
    vscode.commands.registerCommand("omp.showSessionInTerminal", (argument: unknown) => openSessionInMode(context, index, argument, "terminal", "show")),
    vscode.commands.registerCommand("omp.switchSessionViewChat", () => switchActiveSessionView(context, index, "chat")),
    vscode.commands.registerCommand("omp.switchSessionViewTerminal", () => switchActiveSessionView(context, index, "terminal")),
    vscode.commands.registerCommand("omp.copyTerminalScreen", copyActiveTerminalScreen),
    vscode.commands.registerCommand("omp.redrawTerminal", redrawActiveTerminal),
    vscode.commands.registerCommand("omp.fileLink.open", (argument: unknown) => openFileLinkFromMenu(argument, undefined)),
    vscode.commands.registerCommand("omp.fileLink.reveal", (argument: unknown) => openFileLinkFromMenu(argument, "reveal")),
    vscode.commands.registerCommand("omp.fileLink.revealInOs", (argument: unknown) => openFileLinkFromMenu(argument, "os")),
    vscode.commands.registerCommand("omp.chooseDefaultSessionView", chooseDefaultView),
    vscode.commands.registerCommand("omp.chooseDefaultSessionViewChat", chooseDefaultView),
    vscode.commands.registerCommand("omp.chooseDefaultSessionViewTerminal", chooseDefaultView),
    // The in-tab terminal and the folder shell: a folder's terminal actions, the
    // explicit lifecycle actions of a session row, and the exact Reload.
    vscode.commands.registerCommand("omp.openTerminal", (argument: unknown) => openFolderTerminal(context, index, argument)),
    vscode.commands.registerCommand("omp.reconnectTerminal", (argument: unknown) =>
      reconnectFolderTerminal(context, index, argument),
    ),
    vscode.commands.registerCommand("omp.renameSession", (argument: unknown) => renameSession(context, index, argument)),
    vscode.commands.registerCommand("omp.closeSession", (argument: unknown) => closeSession(context, index, argument)),
    vscode.commands.registerCommand("omp.reloadSession", (argument: unknown) => reloadSession(context, index, argument)),
    vscode.commands.registerCommand("omp.addWorkspaceFolder", () => addWorkspaceFolder(index)),
    vscode.commands.registerCommand("omp.pinWorkspaceFolder", (argument: unknown) => pinWorkspaceFolder(index, argument)),
    vscode.commands.registerCommand("omp.unpinWorkspaceFolder", (argument: unknown) => unpinWorkspaceFolder(index, argument)),
    vscode.commands.registerCommand("omp.resumeWorkspaceFolder", (argument: unknown) =>
      resumeWorkspaceFolder(context, index, argument),
    ),
    vscode.commands.registerCommand("omp.openSession", (argument: unknown) => openSession(context, index, argument, "resumed")),
    vscode.commands.registerCommand("omp.clickSession", (argument: unknown) => clickSession(context, index, argument)),
    vscode.commands.registerCommand("omp.switchToSessionWindow", (argument: unknown) => switchToSessionWindow(index, argument)),
    vscode.commands.registerCommand("omp.forgetSession", (argument: unknown) => forgetSession(index, argument)),
    vscode.commands.registerCommand("omp.deleteSession", (argument: unknown) => deleteSession(index, argument)),
    vscode.commands.registerCommand("omp.stopSessionHost", (argument: unknown) =>
      stopSessionHost(context, index, argument),
    ),
    vscode.commands.registerCommand("omp.refreshSessions", () => refreshSessions(index)),
    vscode.commands.registerCommand("omp.showHostControls", () => showHostControls(index)),
    vscode.commands.registerCommand("omp.selectModel", () => selectHostModel(index)),
    vscode.commands.registerCommand("omp.selectThinking", () => selectHostThinking(index)),
    vscode.commands.registerCommand("omp.copyTools", () => copyHostTools(index)),
    vscode.commands.registerCommand("omp.loginProvider", () => loginProviderFromPalette(index)),
    vscode.commands.registerCommand("omp.enableFileEvidence", () => enableFileEvidence(context, index)),
    vscode.commands.registerCommand("omp.disableFileEvidence", () => disableFileEvidence(context, index)),
    vscode.commands.registerCommand("omp.showFileEvidence", () => showFileEvidence(context, index)),
    vscode.commands.registerCommand("omp.deleteFileEvidence", () => deleteFileEvidence(context, index)),
    // Keyboard/command access to actions the panel already offers, so a
    // keybinding reaches the same composer handlers the buttons use. Each of
    // these targets the actual active editor, never a merely visible split panel,
    // reports when there is none, and never starts a host.
    vscode.commands.registerCommand("omp.sendPrompt", () => postPanelAction("send-prompt")),
    vscode.commands.registerCommand("omp.stopTurn", () => postPanelAction("stop-turn")),
    vscode.commands.registerCommand("omp.focusComposer", () => postPanelAction("focus-composer")),
    vscode.commands.registerCommand("omp.retryTurn", () => postChatPanelAction("retry-turn")),
    vscode.commands.registerCommand("omp.toggleThinking", () => toggleTranscriptDefault(THINKING_EXPANDED_KEY)),
    vscode.commands.registerCommand("omp.toggleToolOutput", () => toggleTranscriptDefault(TOOLS_EXPANDED_KEY)),
    vscode.commands.registerCommand("omp.searchPromptHistory", () => searchPromptHistory()),
    vscode.commands.registerCommand("omp.compactConversation", () => runActiveChatAction(context, index, "compact")),
    vscode.commands.registerCommand("omp.cycleModel", () => runActiveChatAction(context, index, "cycle-model")),
    vscode.commands.registerCommand("omp.cycleThinkingLevel", () => runActiveChatAction(context, index, "cycle-thinking")),
    vscode.commands.registerCommand("omp.exportConversationHtml", () => runActiveChatAction(context, index, "export-html")),
    vscode.commands.registerCommand("omp.shareConversation", () => runActiveChatAction(context, index, "share")),
    vscode.commands.registerCommand("omp.showChatKeyboardShortcuts", () => showChatKeyboardShortcuts()),
    vscode.commands.registerCommand("omp.rewindConversation", () => rewindConversation()),
    vscode.commands.registerCommand("omp.sendSelection", () => addSelectionToSession(context, index)),
    vscode.commands.registerCommand("omp.sendFile", (clicked: unknown, selected: unknown) => addFilesToSession(context, index, clicked, selected)),
    vscode.commands.registerCommand("omp.showDiagnostics", () => showDiagnostics(context, index)),
    vscode.commands.registerCommand("omp.copyRowDiagnostics", async (item: unknown) => {
      if (!(item instanceof SessionTreeItem || item instanceof WorkspaceFolderTreeItem || item instanceof ProcessTreeItem)) return;
      try {
        await vscode.env.clipboard.writeText(redactCapabilities(item.diagnostics));
      } catch (error) {
        log(`row diagnostics copy failed: ${messageOf(error)}`);
        showError("Diagnostics could not be copied. Try again, or use OMP: Show Diagnostics.");
      }
    }),
    // The report is regenerated on every request from measurements this window
    // already made plus one read-only health probe, so an open document never
    // shows a stale number; only the fixed report path is answerable, and a
    // buffer under this scheme cannot be saved anywhere.
    vscode.workspace.registerTextDocumentContentProvider(DIAGNOSTICS_DOCUMENT_SCHEME, {
      onDidChange: diagnosticsDocumentChanges.event,
      provideTextDocumentContent: uri => diagnosticsDocumentContent(context, index, uri.path),
    }),
    // Observation bytes reach an editor through this provider and nothing else:
    // a Webview never receives stored content, an arbitrary path is never
    // resolvable, and every request re-reads and re-validates the store instead
    // of serving a cached copy.
    vscode.workspace.registerTextDocumentContentProvider(OBSERVATION_DOCUMENT_SCHEME, {
      onDidChange: observationDocumentChanges.event,
      provideTextDocumentContent: uri => observationDocumentContent(context, index, uri.path),
    }),
  );
  // VS Code's own editor membership is the authority for which editors exist, so the
  // tab set is subscribed before the first asynchronous native work: an editor opened
  // (or closed) while activation proceeds is reconciled by this, never guessed at.
  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs(() => {
      void syncBridgeEditors(context, index, { retireMissing: true }).catch(error =>
        log(`bridge: the editor membership could not be reconciled: ${messageOf(error)}`),
      );
    }),
  );
  if (index.loadError !== null) {
    showWarning(`The stored OMP session index could not be read and was reset: ${index.loadError}`);
  }
  // Show the registered folders and the sessions whose editors VS Code restored
  // before any host is reconciled, so the sidebar never flickers through an empty
  // welcome state on a real workspace. Nothing is discovered here: no folder is
  // added, no session is imported and no history is scanned. The restore pass runs
  // as a handoff: the rows it covers are captured here, and a click on one of them
  // waits for the panels it publishes instead of opening a tab the pass is already
  // restoring.
  refreshLauncher();
  // The editors this window already has are reconciled before any asynchronous native
  // work: their serializers are registered, and a page that survived a previous
  // extension host is adopted with the document its records name, so its reconnect has
  // something to authenticate against as soon as it dials in.
  void syncBridgeEditors(context, index).catch(error => log(`bridge: the editor membership could not be reconciled: ${messageOf(error)}`));
  // The catalog is read, the predecessor build's folder list is imported into it, and
  // only then does the activation restore pass run — pinned to the rows this window is
  // responsible for. An editor VS Code restores for a row this pass does not cover is
  // opened by its own serializer path, so it is never left unconnected.
  startCatalogActivation(context, index, folders, catalog);
  setupProcessesView(context, index, folders);
  // Stage the entries children run from outside the installed extension folder
  // before anything can need them, so no process starts from a file inside a
  // folder a reinstall may be renaming. The launch paths stage again themselves and
  // report their own failure; this one is just early, and silent.
  void runtimeEntries(context).catch(() => {});
  log("extension activated");
}

export function deactivate(): void {
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
  for (const endpoint of bridgeEndpoints.values()) endpoint.close();
  bridgeEndpoints.clear();
  bridgeLiveEditors.clear();
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
  const folders = launcherFolders;
  if (folders === undefined) return;
  const folder = await chooseFolder(index, folders, argument, {
    title: "Choose the OMP folder for a new session",
    addWhenEmpty: true,
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

  let entry: SessionIndexEntry;
  try {
    entry = await index.createDraft({ cwd: current.path });
  } catch (error) {
    showError(`A new OMP session could not be reserved: ${messageOf(error)}`);
    return;
  }
  refreshLauncher();
  // The editor comes first: a host that is slow to start, or fails, never delays the
  // chat surface the user just asked for. Until the conversation attaches the page shows
  // its phase, and the draft row and its claim are exactly what they would have been
  // otherwise.
  await openTab(context, index, entry.tabId, "started");
}

/**
 * Open or resume one session from its launcher row, its context menu or the palette.
 *
 * This is the admitted open path and nothing else. A row whose editor already shows
 * a running host is brought forward; every other row goes through {@link openTab},
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
): Promise<boolean> {
  const tabId =
    tabIdArgument(argument) ??
    (await pickIndexedTab(index, verb === "resumed" ? "Open an OMP session" : "View OMP session history"));
  if (tabId === null) return false;
  if (index.get(tabId) === null) {
    showError("That OMP session is no longer indexed in this window.");
    refreshLauncher();
    return false;
  }
  // A row that shows another window's live claim is not launched from here: Open and a click say
  // so instead of starting anything. This is a shortcut for the message, not the safety rule —
  // every other launch path (the mode-specific Open, a folder's Resume, Add to Session) still goes
  // through openTab and claim admission, which refuse a verified rival. The claim is read again
  // first: the row may be older than the other window's release, and then the ordinary open below
  // is the right answer.
  if (launcherProvider?.displayedState(tabId) === "otherWindow") {
    const fresh = await launcherOwnershipFacts(index, tabId);
    if (fresh.heldElsewhere === true) {
      if (fresh.switchableWindow) {
        const picked = await vscode.window.showInformationMessage("OMP: This session is open in another VS Code window.", "Switch to Window");
        if (picked === "Switch to Window") await switchToSessionWindow(index, tabId);
      } else {
        showInfo("This session is open in another window. Select its unsaved workspace through VS Code's Window menu.");
      }
      return false;
    }
    launcherProvider.refreshOwnership(new Set([tabId]));
  }
  // A row that shows a plain omp process outside this extension as the writer neither launches
  // nor opens history on a bare click: it asks first (ADR-0046), after a fresh probe, because the
  // terminal may have exited since the row was last checked. "Open Anyway" is the user's explicit
  // launch, so it resumes; OMP then saves to a sibling file instead of mixing writes.
  let externalConfirmed = false;
  if (launcherProvider?.displayedState(tabId) === "externalOmp") {
    const fresh = await launcherOwnershipFacts(index, tabId, { fresh: true });
    if (fresh.externalOmp === true) {
      if (!(await confirmOpenAnyway())) return false;
      externalConfirmed = true;
    } else {
      launcherProvider.refreshOwnership(new Set([tabId]));
    }
  }
  // An explicit open is a request to recheck this session now: a background readiness
  // backoff (a startup pass over many rows) must never answer it.
  ptyGate?.invalidate();
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
  if (panel !== null && state?.runtime != null) {
    await revealExistingTab(index, tabId, panel);
    return true;
  }
  await openTab(context, index, tabId, externalConfirmed ? "resumed" : verb, "explicit", undefined, externalConfirmed);
  return true;
}

/** Saved workspaces retain all roots; unsaved multi-root windows have no reopenable identity. */
function owningWindowUri(): vscode.Uri | null {
  const workspace = vscode.workspace.workspaceFile;
  if (workspace?.scheme === "file") return workspace;
  const folders = vscode.workspace.workspaceFolders ?? [];
  return workspace === undefined && folders.length === 1 && folders[0]?.uri.scheme === "file" ? folders[0].uri : null;
}

async function switchToSessionWindow(index: SessionIndex, argument: unknown): Promise<void> {
  const tabId = tabIdArgument(argument);
  if (tabId === null) return;
  const observed = await index.observeOwnership(tabId);
  const claim = observed.ok ? observed.claim : null;
  if (claim === null || claim.holderId === index.claimHolder.id || !claimHolderMayBeAlive(claim)) {
    showInfo("The session is no longer held by another window.");
    refreshLauncher();
    return;
  }
  if (!claim.windowUri) {
    showInfo("This owning window has no saved workspace or single-folder identity. Switch to it using VS Code's Window menu.");
    return;
  }
  const uri = vscode.Uri.parse(claim.windowUri);
  if (uri.scheme !== "file") return;
  await vscode.commands.executeCommand("vscode.openFolder", uri, { forceNewWindow: false });
}

/** Tree clicks keep history immediate; only a stopped same-row second click requests a launch. */
async function clickSession(context: vscode.ExtensionContext, index: SessionIndex, argument: unknown): Promise<void> {
  if (!(argument instanceof SessionTreeItem)) return;
  const tabId = argument.tabId;
  const entry = index.get(tabId);
  if (entry === null) return;
  // Recognize the displayed row synchronously. Async ownership probes would distort
  // the click interval; openSession/openTab still revalidate ownership before launch.
  const stopped = argument.state === "stopped" && !launcherFacts(tabId).running && entry.sessionFile !== null;
  const action = sessionClicks.click(`${tabId}\0${entry.sessionFile ?? ""}`, stopped);
  if (action === "launch") await openingTabs.get(tabId);
  await openSession(context, index, argument, action === "launch" ? "resumed" : "opened");
}

/**
 * Drop one launcher entry, without touching the OMP session file.
 *
 * Forget removes only launcher metadata and refuses only a positive live
 * extension-owned writer or verified rival window. Unreadable/stale claims do not
 * veto it. The native transcript is never removed here.
 */
async function forgetSession(index: SessionIndex, argument: unknown): Promise<void> {
  const tabId = tabIdArgument(argument) ?? (await pickIndexedTab(index, "Forget a launcher entry"));
  if (tabId === null) return;
  const entry = index.get(tabId);
  if (entry === null) {
    showError("This session is no longer in Sessions. Refresh and try again.");
    return;
  }
  const result = await index.remove(tabId, reconciler);
  if (!result.removed) {
    showWarning(result.detail);
    refreshLauncher();
    return;
  }
  // A panel without a running host is inactive, but it would outlive the entry
  // it belongs to: close it, then drop everything this window kept for the tab.
  forgetConversationState(tabId);
  refreshLauncher();
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
   * Set by the Processes view, which asks nothing for a single stop. The row's own prompt is
   * skipped; a row that records an rpc process must still record exactly the attempt and slot
   * the view read just before (`recorded`), and anything else is refused, never stopped.
   */
  preconfirmed?: { readonly recorded: { readonly slot: string; readonly attemptStartedAt: string; readonly pid: number | null } | null },
): Promise<void> {
  const target = sessionTargetFromArgument(index, argument);
  if (target === null) {
    showWarning("Select an OMP session to stop.");
    return;
  }
  const { tabId, entry } = target;
  if (entry.host === null) {
    showWarning(
      "This session has no running process that this window can stop. Refresh Sessions and try again.",
    );
    return;
  }
  if (entry.host.transport === "native" && stateOf(tabId)?.runtime == null) {
    await reattachNativeForLifecycle(context, index, tabId);
    if (stateOf(tabId)?.runtime == null) {
      showWarning("This window could not reconnect to the running session. Use /exit in its Terminal, or reopen its editor and try again.");
      return;
    }
  }
  const liveState = stateOf(tabId);
  if (liveState?.runtime != null) {
    const runtime = liveState.runtime;
    // The Processes view asks nothing for a single stop: the runtime's passive flag and transition
    // facts are read here, immediately before the stop, exactly as that view's driven capture does.
    const captured = preconfirmed === undefined
      ? undefined
      : {
        conflicting: passiveReasonForSlot(liveState.slotId) !== null,
        captured: await index.lifecycle.run(tabId, async () => await readTransitionFacts(liveState, runtime)),
      };
    await confirmAndStopRuntime(context, index, tabId, liveState, runtime, "Stop", captured);
    return;
  }
  // The transport has to exist before anything is confirmed: this row's own recorded
  // broker slot is the only thing that can name the child, and a mapping that cannot
  // be read is uncertainty, never "nothing was launched".
  const provenance = brokerProvenanceFor(tabId);
  if (provenance.kind !== "slot") {
    showWarning(
      provenance.kind === "none"
        ? "This session's connection details are missing. Reopen its editor and try again."
        : "This session's connection details could not be read. Refresh Sessions and try again.",
    );
    return;
  }
  // The confirmation names one exact attempt and slot; the index re-reads the row under
  // the tab's gate and refuses if it now records another attempt, and the port refuses a
  // slot that changed, so a stale dialog can never stop a process the user was not shown.
  const expect = { attemptStartedAt: entry.host.startedAt, pid: entry.host.pid };
  const risk = "Stops this session. Unsaved replies and work in progress may be lost. Commands started by OMP may continue running separately.";
  if (preconfirmed !== undefined) {
    const recorded = preconfirmed.recorded;
    if (recorded === null || recorded.slot !== provenance.slot || recorded.attemptStartedAt !== expect.attemptStartedAt || recorded.pid !== expect.pid) {
      showWarning("The session's recorded process changed while the stop was being prepared, so nothing was stopped.");
      return;
    }
  } else {
    const picked = await vscode.window.showWarningMessage(
      `Stop the session in ${path.basename(entry.cwd)}?`,
      { modal: true, detail: risk },
      STOP_RECORDED_HOST_LABEL,
    );
    if (picked !== STOP_RECORDED_HOST_LABEL) {
      showInfo("Nothing was stopped.");
      return;
    }
  }
  stoppingTabs.add(tabId);
  refreshLauncher();
  try {
    const result = await index.lifecycle.run(tabId, async lease => {
      const stopped = await index.stopRecordedHost(tabId, {
        stop: recordedHostStopPort(provenance.slot),
        expect,
      }, lease);
      // Retire the exact slot and credentials before a queued Resume can provision
      // a replacement; uncertainty never deletes the recorded proof.
      if (stopped.slot !== null && stopped.stopped) {
        await brokerSlots?.forget(stopped.slot).catch(() => undefined);
        outcomes.delete(tabId);
        await releaseHostControl(context, tabId, recordedControlOwner(entry));
      }
      return stopped;
    });
    if (!result.stopped) {
      showWarning(result.detail);
      return;
    }
  } finally {
    stoppingTabs.delete(tabId);
    refreshLauncher();
  }
}

/**
 * Create the Processes view: the extension's background brokers, listed from the broker
 * registry and stopped only through the broker (or a row's own stop flow). The row flows
 * it reuses are handed in as captures taken just before the stop, so a stop never runs
 * against a target that changed in between.
 */
function setupProcessesView(context: vscode.ExtensionContext, index: SessionIndex, folders: LauncherFolders): void {
  let catalogLoaded = false;
  void ensureCatalogReady().then(() => { catalogLoaded = catalogStore !== undefined; });
  registerStatsDashboard(context, { client: brokerClient, log });
  registerProcessesView(context, {
    storageDir: context.globalStorageUri.fsPath,
    predecessorStorageDir: predecessorStorageDir(context.globalStorageUri.fsPath),
    client: attachBrokerClient,
    sessionRows: () => index.list().map(entry => {
      const facts = launcherFacts(entry.tabId);
      const provenance = entry.host === null ? null : brokerProvenanceFor(entry.tabId);
      const recorded = entry.host === null
        ? null
        : (isManagedHost(entry.host) ? entry.host.rpc?.slot ?? null : null) ?? (provenance?.kind === "slot" ? provenance.slot : null);
      return {
        tabId: entry.tabId,
        title: launcherProvider?.headlineFor(entry.tabId) ?? sessionHeadline(entry, null),
        folder: entry.cwd,
        hostSlot: recorded,
        open: facts.open,
        running: facts.running,
        // The same fact the Sessions row shows as "Open in another window".
        heldElsewhere: launcherProvider?.displayedState(entry.tabId) === "otherWindow",
        drivenSlot: stateOf(entry.tabId)?.runtime?.identity.slot ?? null,
      };
    }),
    brokerSlots: () => brokerSlots,
    shellSlots: () => shellSlots,
    shellOpenHere: slot => shellEditors.has(slot),
    indexLoadError: () => index.loadError,
    catalogLoaded: () => catalogLoaded,
    refreshCatalog: () => adoptCatalogChanges(index, folders),
    refreshLauncher: () => refreshLauncher({ ownership: true }),
    async runBrokerStop(target, operation) {
      if (target.kind !== "folder-shell") return await operation();
      return await index.lifecycle.run(target.slot, async () => {
        // Capture this exact shell's watch; a later editor must not be cancelled.
        const stopWatch = stateOf(target.slot)?.ownerStopWatch;
        const result = await operation();
        if (result.kind === "stopped") {
          log(`shell ${target.slot}: Processes Stop acknowledged broker shutdown; no tree-stop claim made`);
          stopWatch?.({ cancelQueuedRetirement: true });
        }
        return result;
      });
    },
    async captureDrivenStop(row) {
      const tabId = row.host?.kind === "session" ? row.host.tabId : null;
      if (tabId === null) return null;
      const state = stateOf(tabId);
      const runtime = state?.runtime ?? null;
      if (
        state === undefined || runtime === null || state.tabId !== tabId ||
        runtime.identity.slot !== row.slot || runtime.identity.brokerId !== row.brokerId ||
        runtime.identity.brokerGeneration !== row.generation
      ) return null;
      const conflicting = passiveReasonForSlot(state.slotId) !== null;
      const captured = await index.lifecycle.run(tabId, async () => await readTransitionFacts(state, runtime));
      return { run: () => confirmAndStopRuntime(context, index, tabId, state, runtime, "Stop", { conflicting, captured }) };
    },
    async captureRecordedStop(row) {
      const tabId = row.host?.kind === "session" ? row.host.tabId : null;
      const entry = tabId === null ? null : index.get(tabId);
      if (tabId === null || entry === null || entry.host === null) return null;
      const provenance = brokerProvenanceFor(tabId);
      if (provenance.kind !== "slot" || provenance.slot !== row.slot) return null;
      // A native row is reattached first by the row's own flow; its runtime is read after that.
      if (entry.host.transport === "native") {
        return { run: () => stopSessionHost(context, index, { tabId }, { recorded: null }) };
      }
      const recorded = { slot: provenance.slot, attemptStartedAt: entry.host.startedAt, pid: entry.host.pid };
      return { run: () => stopSessionHost(context, index, { tabId }, { recorded }) };
    },
    log,
  });
}

/** Attach only; a lifecycle action must never launch a process to stop it. */
async function reattachNativeForLifecycle(context: vscode.ExtensionContext, index: SessionIndex, tabId: string): Promise<void> {
  const entry = index.get(tabId);
  if (entry?.host?.transport !== "native") return;
  const observation = await index.observeOwnership(tabId);
  const verdict = await reconciler.reconcile({
    entry, sessionFile: entry.sessionFile, draftIdentity: entry.ownership?.draftIdentity ?? null,
    ownerGeneration: entry.ownership?.ownerGeneration ?? "", claim: observation.ok ? observation.claim : null, host: entry.host,
  });
  if (verdict.kind !== "attachable") return;
  await index.restore(tabId, {
    reconciler, allowStoppedResume: false, mode: "terminal",
    launcher: {
      launch: async () => ({ state: "not-started", reason: "A lifecycle action only reattaches an existing native writer." }),
      attach: request => attachHost(context, index, request),
    },
  });
  const runtime = stateOf(tabId)?.runtime;
  if (runtime?.kind === "terminal") await reconnectHostControl(context, index, tabId, index.get(tabId)?.ownership?.ownerGeneration ?? "", runtime);
}

/**
 * The transport the index uses to stop a recorded host this window does not run.
 *
 * The row's durable broker slot is resolved here, losslessly
 * ({@link brokerProvenanceFor}), because the index owns the policy and never reads
 * the slot table itself. Every refusal is bounded text; nothing is signalled by pid.
 */
function recordedHostStopPort(expectedSlot: string): RecordedHostStopPort {
  return {
    async stopRecordedHost(entry) {
      const provenance = brokerProvenanceFor(entry.tabId);
      if (provenance.kind === "slot" && provenance.slot !== expectedSlot) {
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
      const client = await attachBrokerClient();
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
        log(`recorded host stop ${entry.tabId}: ${stopped.reason}`);
        return {
          kind: "unknown",
          // A refusal that never dispatched proves nothing was stopped. One that did is
          // unconfirmed: the recorded process may have stopped or may still be running.
          detail: stopped.dispatched
            ? "The session could not be confirmed stopped. Refresh Sessions before resuming; see OMP Desk output for details."
            : "This window could not reach the session safely. Nothing was stopped; refresh Sessions and try again.",
        };
      }
      log(`recorded host stop ${entry.tabId}: ${stopped.verdict.diagnosticDetail ?? stopped.verdict.detail}`);
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

/** A current owned-writer witness, never a recorded pid by itself. */
async function verifiedOwnedWriterPid(index: SessionIndex, tabId: string): Promise<number | null> {
  const runtime = stateOf(tabId)?.runtime ?? null;
  if (runtime !== null) return runtime.pid;
  const entry = index.get(tabId);
  if (entry === null) return null;
  const observed = await index.observeOwnership(tabId);
  if (observed.ok && observed.claim !== null && observed.claim.holderId !== index.claimHolder.id && claimHolderMayBeAlive(observed.claim)) return null;
  const verdict = await reconciler.reconcile({
    entry, sessionFile: entry.sessionFile, draftIdentity: entry.ownership?.draftIdentity ?? null,
    ownerGeneration: entry.ownership?.ownerGeneration ?? "", claim: observed.ok ? observed.claim : null, host: entry.host,
  }).catch(() => ({ kind: "free" as const, evidence: [] }));
  return verdict.kind === "attachable" ? verdict.host.pid : verdict.kind === "live" ? verdict.pid ?? entry.host?.pid ?? null : null;
}

/** Stop the positively verified target after its caller's one confirmation. */
async function stopVerifiedOwnedWriter(context: vscode.ExtensionContext, index: SessionIndex, tabId: string, pid: number, captured?: CapturedSessionStop): Promise<boolean> {
  stoppingTabs.add(tabId);
  refreshLauncher();
  try {
    return await index.lifecycle.run(tabId, async lease => {
      const currentPid = await verifiedOwnedWriterPid(index, tabId);
      if (currentPid !== pid) {
        if (currentPid === null) return true;
        showWarning("The running OMP target changed; nothing was stopped.");
        return false;
      }
      const entry = index.get(tabId);
      if (entry === null) return false;
      const state = stateOf(tabId);
      const runtime = state?.runtime ?? null;
      if (captured !== undefined && (state !== captured.state || runtime !== captured.runtime)) {
        showWarning("The running session changed while confirmation was pending; nothing was stopped. Try again.");
        return false;
      }
      if (runtime !== null && state !== undefined) {
        await index.setRunIntent(tabId, "stopped", "Stop requested before continuing the user's action.");
        const stopped = await stopSessionRuntime(state, runtime, "graceful", true, captured?.facts);
        log(`session stop ${tabId}: ${stopped.diagnosticDetail ?? stopped.detail}`);
        if (!stopped.writerGone) {
          showWarning(stopped.detail);
          return false;
        }
        state.runtime = null;
        stopTerminalForTab(state.slotId);
        state.nativeWatch?.();
        state.nativeWatch = null;
        disposeControlChannel(state);
        await index.setRunIntent(tabId, "stopped", stopped.detail);
        await index.closeSession(tabId, { confirmedStopped: true, detail: stopped.detail }, lease);
        await retireBroker(tabId, runtime);
      } else {
        const provenance = brokerProvenanceFor(tabId);
        if (provenance.kind !== "slot" || entry.host === null) return false;
        const stopped = await index.stopRecordedHost(tabId, {
          stop: recordedHostStopPort(provenance.slot),
          expect: { attemptStartedAt: entry.host.startedAt, pid: entry.host.pid },
        }, lease);
        if (!stopped.stopped) {
          showWarning(stopped.detail);
          return await verifiedOwnedWriterPid(index, tabId) === null;
        }
        if (stopped.slot !== null) await brokerSlots?.forget(stopped.slot).catch(() => undefined);
      }
      await releaseHostControl(context, tabId, runtime === null ? recordedControlOwner(entry) : controlOwnerFor(runtime, entry.ownership?.ownerGeneration ?? ""));
      outcomes.delete(tabId);
      return true;
    });
  } finally {
    stoppingTabs.delete(tabId);
    refreshLauncher();
  }
}

/**
 * The broker provenance recorded for one row, without loss.
 *
 * {@link BrokerSlotStore.forConversation} cannot distinguish "this row recorded no
 * slot" from "the mapping could not be read", and both the reconciler's probe and the
 * explicit stop decide whether a writer may exist, so they ask this instead: an
 * unreadable table or entry is uncertainty, never "nothing was launched".
 */
function brokerProvenanceFor(tabId: string): BrokerSlotProvenance {
  if (brokerSlots === undefined) return { kind: "unreadable" };
  const byConversation = brokerSlots.provenanceFor({ conversation: tabId });
  if (byConversation.kind !== "none") return byConversation;
  let unreadable = false;
  for (const binding of indexForBridge?.slotsForConversation(tabId) ?? []) {
    if (binding.role !== "controlling") continue;
    const byEditor = brokerSlots.provenanceFor({ editor: binding.slotId });
    if (byEditor.kind === "slot") return byEditor;
    if (byEditor.kind === "unreadable") unreadable = true;
  }
  return unreadable ? { kind: "unreadable" } : { kind: "none" };
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

/**
 * Drop every record this window kept for one conversation.
 *
 * A conversation can have more than one editor (a controller and a passive one),
 * so every record showing it is dropped, not just the one a lookup happens to
 * resolve. Each editor's panel is closed first: with the row gone there is nothing
 * left for it to show.
 */
function forgetConversationState(tabId: string): void {
  detailTabs.closeConversation(tabId);
  for (const state of [...tabs.values()]) {
    if (state.tabId !== tabId) continue;
    state.panel?.dispose();
    tabs.delete(state.slotId);
    editorSlots.remove(state.slotId);
    bridgeEditors.releaseEditor(state.slotId);
  }
  outcomes.delete(tabId);
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
interface CapturedSessionStop {
  readonly state: TabState;
  readonly runtime: SessionHostRuntime;
  readonly facts: SessionTransitionFacts | null;
}

async function confirmAndDeleteSession(index: SessionIndex, subject: SessionDeletionSubject): Promise<boolean> {
  try {
    const tabId = typeof subject === "string" && index.get(subject) !== null ? subject : null;
    if (tabId !== null && activationContext !== undefined && stateOf(tabId)?.runtime == null && index.get(tabId)?.host?.transport === "native") {
      await reattachNativeForLifecycle(activationContext, index, tabId);
      if (stateOf(tabId)?.runtime == null && await verifiedOwnedWriterPid(index, tabId) !== null) {
        showWarning("The running session could not be reconnected; nothing was deleted.");
        return false;
      }
    }
    const state = tabId === null ? undefined : stateOf(tabId);
    const runtime = state?.runtime ?? null;
    if (state === undefined || runtime === null || tabId === null) return await deleteSessionAfterFence(index, subject);
    if (state.transitioning) { showWarning("The session is already changing or stopping; nothing was deleted."); return false; }
    try {
      fenceSessionAdmission(index, state, true);
      const facts = await withSessionReadDeadline(index.lifecycle.run(tabId, async () => await readTransitionFacts(state, runtime)));
      return await deleteSessionAfterFence(index, subject, { state, runtime, facts });
    } finally {
      if (state.runtime !== runtime || runtime.kind !== "terminal" || !runtime.stopping) fenceSessionAdmission(index, state, false);
      else pushSessionView(index, state);
    }
  } catch (error) {
    log(`session deletion preparation failed: ${messageOf(error)}`);
    showError("The session could not be checked for deletion. Nothing was deleted. Refresh Sessions and try again.");
    refreshLauncher();
    return false;
  }
}

async function deleteSessionAfterFence(
  index: SessionIndex,
  subject: SessionDeletionSubject,
  captured?: CapturedSessionStop,
): Promise<boolean> {
  const options: SessionDeletionOptions = {
    index,
    reconciler,
    windowHostRunning: (id: string) => launcherFacts(id).running,
  };
  const tabId = typeof subject === "string" && index.get(subject) !== null ? subject : null;
  const writerPid = tabId === null ? null : await withSessionReadDeadline(verifiedOwnedWriterPid(index, tabId), 5_000);
  let inspection = await withSessionReadDeadline(inspectSessionDeletion(subject, writerPid === null ? options : {
    ...options, windowHostRunning: () => false,
    reconciler: { reconcile: async () => ({ kind: "free", evidence: [] }) },
  }), 5_000);
  if (inspection === null) {
    showError("This session is no longer indexed, so nothing was deleted.");
    refreshLauncher();
    return false;
  }
  const sessionFile = inspection.sessionFile;
  if (sessionFile === null) {
    showWarning(`This session was not deleted: ${inspection.detail}`);
    refreshLauncher();
    return false;
  }
  if (!inspection.allowed) {
    showWarning(`This session was not deleted: ${inspection.detail}`);
    refreshLauncher();
    return false;
  }
  log(`Session deletion targets: ${JSON.stringify({ cwd: inspection.cwd, targets: inspection.targets, notes: inspection.notes })}`);
  const header = await readSessionFileHeader(sessionFile);
  const entry = tabId === null ? null : index.get(tabId);
  const name = entry === null ? displaySessionTitle(header?.title ?? "") || displaySessionTitle(header?.promptTitle ?? "") || "OMP session" : sessionHeadline(entry, header);
  const detail = "The session history file and its artifacts will be removed. This cannot be undone.";
  const deleteLabel = DELETE_TRANSCRIPT_LABEL;
  const picked = await vscode.window.showWarningMessage(
    `Delete session “${name}”?`,
    { modal: true, detail }, deleteLabel,
  );
  if (picked !== deleteLabel) {
    return false;
  }
  if (writerPid !== null && tabId !== null) {
    const context = activationContext;
    if (context === undefined || !(await stopVerifiedOwnedWriter(context, index, tabId, writerPid, captured))) return false;
    inspection = await inspectSessionDeletion(subject, options);
    if (inspection === null || inspection.sessionFile !== sessionFile || !inspection.allowed) {
      showWarning("The deletion target or its live ownership changed; nothing was deleted.");
      return false;
    }
  }
  const confirmed = confirmedSessionDeletion(inspection);
  if (confirmed === null) {
    showWarning("This session was not deleted: its file could not be frozen for the removal.");
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
              forgetTurnActivity(index, confirmed.tabId as string);
            }
            return held;
          });
  } catch (error) {
    log(`session deletion failed: ${messageOf(error)}`);
    showError(`This session was not deleted: ${messageOf(error)}`);
    refreshLauncher();
    return false;
  }
  if (!result.deleted) {
    log(`session deletion refused or failed (${result.kind ?? "unknown"}): ${result.detail}`);
    showWarning(`The OMP session was not deleted: ${result.detail}`);
    refreshLauncher();
    return false;
  }
  refreshLauncher();
  log(`deleted session files ${result.removedPaths.join(", ")}`);
  const partial = result.partial || result.leftovers.length > 0;
  if (!partial) {
    showInfo(result.detail);
    return true;
  }
  const leftovers = result.leftovers.length === 0 ? "" : ` Leftovers that still need recovery: ${result.leftovers.join(", ")}.`;
  const failures = result.failures.length === 0 ? "" : ` ${result.failures.join(" ")}`;
  showWarning(`${result.detail}${leftovers}${failures}`);
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
  const tabId = tabIdArgument(argument) ?? (await pickIndexedTab(index, "Delete an OMP session"));
  if (tabId === null) return;
  await confirmAndDeleteSession(index, tabId);
}


/** Re-read the launcher from the folders it shows, the index and this window. */
function refreshSessions(index: SessionIndex): void {
  // An explicit Refresh is the user's own answer to a launcher they believe is stale, so
  // it adopts the newest committed revision before re-reading anything.
  if (launcherFolders !== undefined) {
    void adoptCatalogChanges(index, launcherFolders).catch(error => log(`catalog: the newest revision could not be adopted: ${messageOf(error)}`));
  }
  refreshLauncher({ ownership: true });
  // Refresh never discovers anything: a folder's other sessions are read only when
  // the user asks to resume one.
  log("launcher: refreshed from the folder list, the session index and this window's editors");
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

/**
 * Report a folder-list change that could not be saved.
 *
 * The list itself is already changed in this window, so a failed save leaves the
 * launcher usable; what the user must be able to see is that the change will not
 * survive this window.
 */
function reportFolderSaveFailure(folders: LauncherFolders): void {
  if (folders.persistError !== null) showWarning(folders.persistError);
}

/**
 * Ask which folder to pin, then pin it.
 *
 * The folders VS Code has open that are not pinned yet are offered first: they are what
 * the user is already looking at (and already shown in Sessions), and a short list beats
 * a filesystem dialog. Nothing is pinned without an explicit choice — "Browse…" opens
 * the native folder dialog for any other absolute local directory. When there is nothing
 * to suggest, the dialog is used directly.
 */
async function addWorkspaceFolder(index: SessionIndex): Promise<LauncherFolder | null> {
  const folders = launcherFolders;
  if (folders === undefined) return null;
  const chosenPath = await pickFolderToAdd(folders);
  if (chosenPath === null) return null;
  const added = await folders.add(chosenPath);
  if (!added.ok) {
    showError(`The OMP folder was not added: ${added.reason}`);
    return null;
  }
  refreshLauncher();
  reportFolderSaveFailure(folders);
  return added.folder;
}

/** The "choose another folder" entry of the Add picker. */
const BROWSE_FOR_FOLDER_LABEL = "Browse…";

/**
 * One folder path the user picked to pin, or `null` when they dismissed the
 * question. The open VS Code folders that are not pinned are suggestions; the dialog is
 * the way to reach anything else, and only a local (`file`) location is ever returned.
 */
async function pickFolderToAdd(folders: LauncherFolders): Promise<string | null> {
  const suggestions = folders.list().filter(folder => folder.open && !folder.pinned);
  if (suggestions.length === 0) return await browseForFolder();
  const picked = await vscode.window.showQuickPick(
    [
      ...suggestions.map(folder => ({
        label: folderHeadline(folder.path),
        description: folder.path,
        detail: "Open in this window",
        addPath: folder.path as string | null,
      })),
      {
        label: BROWSE_FOR_FOLDER_LABEL,
        description: "Choose another local folder",
        detail: "Opens the folder dialog",
        addPath: null,
      },
    ],
    {
      title: "Pin a folder to the OMP launcher",
      placeHolder: "Pick the folder to pin, or browse for another one",
    },
  );
  if (picked === undefined) return null;
  return picked.addPath ?? (await browseForFolder());
}

/** The native folder dialog, which is how a directory outside the workspace is added. */
async function browseForFolder(): Promise<string | null> {
  const chosen = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: "Add OMP Folder",
    title: "Add a folder to the OMP launcher",
  });
  const uri = chosen?.[0];
  if (uri === undefined) return null;
  if (uri.scheme !== "file") {
    showError(`Only local folders can be added to Sessions, and "${uri.toString()}" is not local.`);
    return null;
  }
  return uri.fsPath;
}

/**
 * Pin one folder the launcher shows, so it stays after VS Code closes it and appears in
 * every window.
 *
 * This is metadata only. The folder's id is the one it will keep once pinned, and it is
 * resolved again here, so a stale row cannot pin a different folder.
 */
async function pinWorkspaceFolder(index: SessionIndex, argument: unknown): Promise<void> {
  const folders = launcherFolders;
  if (folders === undefined) return;
  const folder = await chooseFolder(index, folders, argument, {
    title: "Pin a folder to the OMP launcher",
    addWhenEmpty: false,
    only: "unpinned",
    nothing: "Every folder shown in the OMP launcher is already pinned.",
  });
  if (folder === null) return;
  const result = await folders.pin(folder.id);
  if (!result.ok) {
    showWarning(result.reason);
    refreshLauncher();
    return;
  }
  refreshLauncher();
  reportFolderSaveFailure(folders);
}

/**
 * Unpin one folder: it leaves the pinned list of every window.
 *
 * This is the only way a folder is dropped from the launcher, and it is metadata only: no
 * editor is closed, no native host is stopped, no session is forgotten and no session file
 * is deleted. A folder VS Code has open here stays visible in this window; refused while a
 * managed OMP session in the folder runs. The folder's id is resolved again here, so a
 * stale row cannot unpin a different folder.
 */
async function unpinWorkspaceFolder(index: SessionIndex, argument: unknown): Promise<void> {
  const folders = launcherFolders;
  if (folders === undefined) return;
  const folder = await chooseFolder(index, folders, argument, {
    title: "Unpin a folder from Sessions",
    addWhenEmpty: false,
    only: "pinned",
    nothing: "No folder is pinned in Sessions.",
  });
  if (folder === null) return;
  const result = await folders.unpin(folder.id, { managedLiveSession: managedLiveSessionInFolder });
  if (!result.unpinned) {
    showWarning(result.reason);
    refreshLauncher();
    return;
  }
  refreshLauncher();
  reportFolderSaveFailure(folders);
}

/**
 * Whether a managed OMP session of this folder runs, or is starting, in this window: the guard
 * Unpin asks before it drops the folder from the pinned list. Only this window's own runtime
 * counts; it is the one authority on what this window runs, and the same condition that keeps
 * the folder visible while a session lives in it.
 */
function managedLiveSessionInFolder(folder: WorkspaceFolder): string | null {
  const index = indexForBridge;
  if (index === null) return null;
  const live = index.list().some(entry => {
    if (!folderMatchesCwd(folder.path, entry.cwd)) return false;
    const facts = launcherFacts(entry.tabId);
    return facts.running || facts.launching === true;
  });
  return live ? `A managed OMP session in "${folderHeadline(folder.path)}" is running in this window.` : null;
}

/**
 * The folder a folder-scoped command acts on.
 *
 * A folder row supplies its stable id, which is resolved again here against the folders
 * the launcher shows now: an id that went stale — the folder was unpinned and closed, or
 * the row belongs to another window — reports and stops instead of falling back to a
 * different folder. An absent argument asks the user (among the pinned or unpinned folders
 * when `only` says so); with no folder shown at all there is nothing to choose from, so a
 * command that can create its subject (New Session, Resume) offers the Add flow and one
 * that cannot says so.
 */
async function chooseFolder(
  index: SessionIndex,
  folders: LauncherFolders,
  argument: unknown,
  options: {
    readonly title: string;
    readonly addWhenEmpty: boolean;
    readonly only?: "pinned" | "unpinned";
    /** What to say when `only` leaves nothing to choose from. */
    readonly nothing?: string;
  },
): Promise<LauncherFolder | null> {
  const shown = folders.list();
  const supplied = folderArgument(argument, shown);
  if (supplied.kind === "stale") {
    showError("That folder is no longer in Sessions. Refresh Sessions and try again.");
    return null;
  }
  if (supplied.kind === "folder") return supplied.folder;
  const candidates = options.only === undefined ? shown : shown.filter(folder => folder.pinned === (options.only === "pinned"));
  if (candidates.length === 0) {
    if (options.only !== undefined) {
      showInfo(options.nothing ?? "No OMP folder matches.");
      return null;
    }
    if (!options.addWhenEmpty) {
      showInfo("No folder is shown in Sessions yet. Open a folder or add one first.");
      return null;
    }
    return await addWorkspaceFolder(index);
  }
  if (candidates.length === 1) return candidates[0];
  const picked = await vscode.window.showQuickPick(
    candidates.map(folder => {
      const source = folder.pinned
        ? (folder.open ? "pinned, open in this window" : "pinned")
        : (folder.open ? "open in this window" : "kept because a session runs in it here");
      return {
        label: folderHeadline(folder.path),
        description: folder.path,
        detail: `${source}, ${folder.collapsed ? "collapsed" : "expanded"} in Sessions`,
        folder,
      };
    }),
    { title: options.title },
  );
  return picked?.folder ?? null;
}

/**
 * Every materialized index row, narrowed to what the folder query needs.
 *
 * All of them are passed, not only the ones that look like they match: the query
 * owns the folder comparison, needs the index's own session directories because a
 * custom `--session-dir` can sit outside every profile root, and is the one place
 * that decides whether a row appears as an indexed candidate or a discovered one.
 */
function indexedRowsForHistory(index: SessionIndex): FolderHistoryIndexedEntry[] {
  return index.list().map(entry => ({
    tabId: entry.tabId,
    sessionFile: entry.sessionFile,
    cwd: entry.cwd,
    sessionId: entry.sessionId,
    profile: entry.scope.profile,
    sessionDirs: [entry.sessionDir, entry.scope.sessionDir].filter((dir): dir is string => dir !== null),
  }));
}

/**
 * Record one folder-scoped discovery pass in the output channel.
 *
 * Every issue's own text goes here and nowhere else: the pass's exception detail
 * and uncontrolled file paths are local evidence for the user reading the OMP
 * channel, while what a notification says stays a bounded statement about how
 * complete the pass was. A root or file that is simply absent is logged too — it
 * is a fact about the pass, not a hidden session.
 */
function logFolderScan(folder: WorkspaceFolder, scan: FolderHistoryScan): void {
  log(
    `folder history: ${scan.candidates.length} candidate(s) for ${folder.path} over ${scan.roots.length} root(s), ` +
      `${scan.issues.length} issue(s), ${scan.skippedFiles} skipped, incomplete=${scan.incomplete}, cancelled=${scan.cancelled}`,
  );
  for (const issue of scan.issues) {
    log(`folder history (${issue.kind})${issue.path === null ? "" : ` ${issue.path}`}: ${issue.detail}`);
  }
}

/** What a discovered session file is called: its own title, or its file name. */
function candidateLabel(candidate: FolderHistoryCandidate): string {
  const title = candidate.title?.trim() ?? "";
  if (title.length > 0) return title;
  const name = path.basename(candidate.file, ".jsonl");
  return name.length > 0 ? name : candidate.file;
}

/** What the picker row says about one candidate: this window's state, profile, age, size. */
function candidateDescription(
  candidate: FolderHistoryCandidate,
  state: { readonly open: boolean; readonly running: boolean },
): string {
  // Where the row was found is deliberately absent: an indexed row and a discovered
  // one are one row per canonical file with the same actions (ADR-0027). What the
  // user is told is this window's own state for it, which is the thing that changes.
  const parts: string[] = [];
  if (state.open) parts.push("Open");
  else if (state.running) parts.push("Running in this window");
  if (!candidate.available) parts.push("Unavailable");
  parts.push(candidate.profile === null ? "default profile" : `profile ${candidate.profile}`);
  if (candidate.modifiedAt !== null) parts.push(relativeAge(candidate.modifiedAt, Date.now()));
  if (candidate.sizeBytes !== null) parts.push(sizeText(candidate.sizeBytes));
  return parts.join(" · ");
}

/** The one per-row action a Resume row carries: delete this session. */
const HISTORY_ROW_TRASH: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon("trash"),
  tooltip: "Delete this session and its transcript…",
};

/** One row of the folder Resume picker. */
interface FolderHistoryPickItem extends vscode.QuickPickItem {
  readonly candidate: FolderHistoryCandidate;
}

/**
 * Offer one folder's sessions, newest first, one row per exact file.
 *
 * The list merges the index's own rows with what the scan discovered and the query
 * has already collapsed both onto one row per canonical exact file, so a session that
 * is open is offered once and says so. Choosing an open session focuses its editor;
 * choosing any other indexed row uses the row the index already owns; only a
 * discovered file needs importing. A file whose indexed row has vanished from disk
 * stays visible as unavailable instead of disappearing between passes, and nothing is
 * resumed until one row is chosen.
 *
 * Every row carries its own trash button, and deleting one goes through exactly the
 * same confirmed transaction as a stopped row's Delete — the file, its artifacts, its
 * rewrite backups and its retained raw recordings. A row that was deleted disappears
 * from the list the user is still looking at, in place; a refusal is reported by name
 * and leaves the row exactly where it is.
 *
 * The picker never claims to be exhaustive when the scan could not read everything:
 * its own wording follows the pass's `incomplete` flag, and the reasons stay in the OMP
 * output channel rather than in this prompt.
 */
async function pickFolderHistoryCandidate(
  index: SessionIndex,
  folder: WorkspaceFolder,
  scan: FolderHistoryScan,
): Promise<FolderHistoryCandidate | null> {
  const open = new Set<string>();
  const running = new Set<string>();
  for (const state of tabs.values()) {
    if (state.tabId === null) continue;
    if (state.panel !== null) open.add(state.tabId);
    if (state.runtime !== null) running.add(state.tabId);
  }
  let remaining = [...scan.candidates];
  const rows = (): FolderHistoryPickItem[] =>
    remaining.map(candidate => ({
      label: candidateLabel(candidate),
      description: candidateDescription(candidate, {
        open: candidate.tabId !== null && open.has(candidate.tabId),
        running: candidate.tabId !== null && running.has(candidate.tabId),
      }),
      // An unavailable row names its file too, and says that choosing it cannot open
      // anything: the file is re-read at selection time, so a file that came back or
      // changed in the meantime is decided there rather than here.
      detail: candidate.available
        ? candidate.file
        : `${candidate.file}\nThis session file is not readable on disk, so it cannot be resumed.`,
      buttons: [HISTORY_ROW_TRASH],
      candidate,
    }));
  const picker = vscode.window.createQuickPick<FolderHistoryPickItem>();
  picker.title = scan.incomplete
    ? `Resume an OMP session in ${folderHeadline(folder.path)} (this list may be incomplete)`
    : `Resume an OMP session in ${folderHeadline(folder.path)}`;
  picker.placeholder = scan.incomplete
    ? "Some session locations could not be read, so sessions may be missing from this list"
    : "Every readable OMP session whose own header records this folder";
  picker.canSelectMany = false;
  picker.items = rows();
  picker.onDidTriggerItemButton(event => {
    const candidate = event.item.candidate;
    void (async () => {
      const deleted = await confirmAndDeleteSession(index, folderHistoryDeletionSubject(candidate));
      if (!deleted) return;
      // In place: the row the user just deleted leaves the list they are looking at,
      // and every other row keeps its position.
      remaining = remaining.filter(other => other.file !== candidate.file);
      picker.items = rows();
    })();
  });
  return await new Promise<FolderHistoryCandidate | null>(resolve => {
    picker.onDidAccept(() => {
      resolve(picker.selectedItems[0]?.candidate ?? null);
      picker.hide();
    });
    picker.onDidHide(() => {
      resolve(null);
      picker.dispose();
    });
    picker.show();
  });
}

/**
 * Resume one of a folder's sessions, discovered on demand.
 *
 * The folder comes from a folder row or from a choice among the registered
 * folders. The scan is read-only, shows progress and can be cancelled, and it is
 * the only thing that ever enumerates OMP's session files: the launcher itself
 * never scans. The folder is resolved again after the scan and again after the
 * picker, so a folder removed while a dialog was open is never resumed from.
 */
async function resumeWorkspaceFolder(
  context: vscode.ExtensionContext,
  index: SessionIndex,
  argument: unknown,
): Promise<void> {
  const folders = launcherFolders;
  if (folders === undefined) return;
  const folder = await chooseFolder(index, folders, argument, {
    title: "Choose the OMP folder to resume a session from",
    addWhenEmpty: true,
  });
  if (folder === null) return;

  const scan = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Looking for OMP sessions in ${folderHeadline(folder.path)}…`,
      cancellable: true,
    },
    async (_progress, token) => {
      const controller = new AbortController();
      const registration = token.onCancellationRequested(() => controller.abort());
      try {
        return await scanFolderHistory({
          cwd: folder.path,
          indexed: indexedRowsForHistory(index),
          signal: controller.signal,
          isCancelled: () => token.isCancellationRequested,
        });
      } finally {
        registration.dispose();
      }
    },
  );
  logFolderScan(folder, scan);
  if (scan.cancelled) {
    // Cancelling means "stop waiting", so no picker is forced on the user
    // afterwards — but the partial result is reported rather than dropped: what
    // was already found is named here and every issue stays in the output channel.
    showInfo(
      scan.candidates.length === 0
        ? "Looking for OMP sessions was cancelled before any session was read, so nothing was resumed."
        : `Looking for OMP sessions was cancelled after ${scan.candidates.length} session(s) had been read, so nothing was resumed. ` +
            `Run Resume Session again to see the list.`,
    );
    return;
  }
  if (folders.get(folder.id) === null) {
    showWarning("That folder was removed from Sessions while its sessions were being read, so nothing was resumed.");
    refreshLauncher();
    return;
  }
  if (scan.candidates.length === 0) {
    // An empty answer is never presented as a complete one: a pass that could not
    // read everything says so instead, and the exact paths and errors are in the
    // OMP output channel rather than in this notification.
    if (scan.incomplete) {
      showWarning(
        `No OMP session could be read for "${folderHeadline(folder.path)}", and some session locations could not be read either, ` +
          `so this is not a complete answer. The OMP output channel names every path and error.`,
      );
    } else {
      showInfo(`No readable OMP session records "${folderHeadline(folder.path)}" as its working directory.`);
    }
    return;
  }
  if (scan.incomplete) {
    showWarning(
      `Some OMP session locations of "${folderHeadline(folder.path)}" could not be read, so this list may be incomplete. ` +
        `The OMP output channel names every path and error.`,
    );
  }
  const picked = await pickFolderHistoryCandidate(index, folder, scan);
  if (picked === null) return;
  const current = folders.get(folder.id);
  if (current === null) {
    showWarning("That folder was removed from Sessions, so nothing was resumed.");
    refreshLauncher();
    return;
  }
  await openFolderHistoryCandidate(context, index, current, picked);
}

/**
 * Open one chosen folder-scoped session, after re-checking what it is.
 *
 * Everything is re-read at selection time, because between the scan and the click
 * a folder can be removed, a session file can change or disappear, another window
 * can import the same file, and a file's own header — the only authority on which
 * folder it belongs to — can record a different working directory than the row was
 * offered under. Any of those refuses or refreshes instead of launching an
 * unrelated session, and this is a selection-time check, not a filesystem snapshot:
 * a foreign OMP writer can still change the file a moment later.
 */
async function openFolderHistoryCandidate(
  context: vscode.ExtensionContext,
  index: SessionIndex,
  folder: WorkspaceFolder,
  candidate: FolderHistoryCandidate,
): Promise<void> {
  const inspection = await inspectSessionFile(candidate.file);
  if (inspection.kind === "missing") {
    showError(`That OMP session file is no longer there: ${inspection.detail}`);
    refreshLauncher();
    return;
  }
  if (inspection.kind === "unreadable") {
    showError(`That OMP session file could not be read: ${inspection.detail}`);
    refreshLauncher();
    return;
  }
  if (inspection.kind === "invalid") {
    showError(`That file is no longer a readable OMP session: ${inspection.detail}`);
    refreshLauncher();
    return;
  }
  const folderKey = canonicalFolderKey(folder.path);
  const headerKey = canonicalFolderKey(inspection.header.cwd);
  if (folderKey === null || headerKey === null || folderKey !== headerKey) {
    showWarning(
      `That OMP session no longer records "${folder.path}" as its working directory, so it was not resumed here. ` +
        `Refresh Sessions, or resume it from the folder it now records.`,
    );
    refreshLauncher();
    return;
  }

  const existing = candidate.tabId === null ? null : index.get(candidate.tabId);
  if (candidate.tabId !== null && existing === null) {
    showWarning("That session is no longer in Sessions. Refresh Sessions and try again.");
    refreshLauncher();
    return;
  }
  // A row the index already holds is never re-registered: it is opened with its own
  // recorded scope, so a session launched with an explicit `--session-dir` keeps
  // writing where it always did. Registration below is therefore always for a file
  // the scan discovered, and there `candidate.sessionDir` is the root OMP was
  // pointed at — a profile root or a custom directory — which is exactly the
  // `--session-dir` that resumes it in place. (An indexed candidate carries `null`
  // for the same field, and `trackSession` re-uses an existing row for a file it
  // already owns without reading this input at all.)
  let entry = existing;
  if (entry === null) {
    try {
      entry = await index.trackSession({
        sessionFile: candidate.file,
        cwd: folder.path,
        scope: { profile: candidate.profile, sessionDir: candidate.sessionDir },
      });
    } catch (error) {
      showError(`The OMP session could not be registered: ${messageOf(error)}`);
      refreshLauncher();
      return;
    }
  }

  // One file, one row: whatever row is about to be opened must still stand for the
  // exact file the user chose. A competing import can have registered that file
  // while the picker was open, and `trackSession` returns the row it found — so the
  // check is made on the row itself rather than on the click that produced it.
  //
  // The folder question was answered by the file's own header above and is not
  // asked of the row: an indexed row's recorded working directory can be stale,
  // and the header is the authority on which folder a session belongs to. The
  // index repairs that recorded value from the same header evidence when the row
  // opens, so the launch that follows runs in the folder the user selected rather
  // than in whatever the row remembered.
  if (entry.sessionFile === null || normalizeSessionIdentityKey(entry.sessionFile) !== normalizeSessionIdentityKey(candidate.file)) {
    showWarning(
      "That session file now belongs to a different row in Sessions, so it was not resumed. Refresh Sessions and try again.",
    );
    refreshLauncher();
    return;
  }

  // An already-open session is focused, never re-opened: a second restore of one
  // row is what the index refuses as a duplicate, and a second panel would be a
  // second guest for one seat.
  const openPanel = stateOf(entry.tabId)?.panel ?? null;
  if (openPanel !== null && stateOf(entry.tabId)?.runtime != null) {
    showInfo(`"${candidateLabel(candidate)}" is already open in this window.`);
    await revealExistingTab(index, entry.tabId, openPanel);
    return;
  }
  log(`tab ${entry.tabId}: resumed folder session ${candidate.file} (${candidate.source}) from ${folder.path}`);
  await openTab(context, index, entry.tabId, "resumed");
}

/**
 * Bring this window's panel for a tab to the front and record it as active.
 *
 * The user asked for a tab this window already has an editor for, so nothing is
 * created, restored or claimed here: the panel is revealed, the tab is recorded
 * as the active one and the launcher is refreshed.
 */
async function revealExistingTab(index: SessionIndex, tabId: string, panel: vscode.WebviewPanel): Promise<void> {
  panel.reveal();
  requestSessionRowExpand(tabId);
  await setActiveTab(index, tabId);
  refreshLauncher();
  void revealActiveSession(index);
}

/** Callers waiting for one editor slot's panel handle, resolved by {@link bindPanel}. */
const panelBindWaiters = new Map<string, Set<() => void>>();
/** How long a revealed, not-yet-revived editor may take to hand this window its panel. */
const EDITOR_REVIVE_TIMEOUT_MS = 5_000;
/** Focuses the editor group of one `ViewColumn` (1-based). VS Code offers no command past the eighth. */
const EDITOR_GROUP_FOCUS_COMMANDS = [
  "workbench.action.focusFirstEditorGroup",
  "workbench.action.focusSecondEditorGroup",
  "workbench.action.focusThirdEditorGroup",
  "workbench.action.focusFourthEditorGroup",
  "workbench.action.focusFifthEditorGroup",
  "workbench.action.focusSixthEditorGroup",
  "workbench.action.focusSeventhEditorGroup",
  "workbench.action.focusEighthEditorGroup",
];

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

/**
 * Make VS Code show this slot's tab. `WebviewPanel.reveal` needs the panel handle this window
 * may not have yet, so the tab itself is selected through its group and position.
 */
async function selectEditorTab(slot: string): Promise<boolean> {
  const tab = editorTabOf(slot);
  if (tab === null) return false;
  const column = tab.group.viewColumn;
  if (!(tab.isActive && column === vscode.window.tabGroups.activeTabGroup.viewColumn)) {
    if (column !== vscode.window.tabGroups.activeTabGroup.viewColumn) {
      const focusGroup = EDITOR_GROUP_FOCUS_COMMANDS[column - 1];
      if (focusGroup === undefined) return false;
      await vscode.commands.executeCommand(focusGroup);
    }
    await vscode.commands.executeCommand("workbench.action.openEditorAtIndex", tab.group.tabs.indexOf(tab));
  }
  return editorTabOf(slot)?.isActive === true;
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
  const state = stateOf(tabId);
  if (state === undefined) return { selected: false, panel: null };
  if (state.panel !== null) return { selected: true, panel: state.panel };
  const slot = state.slotId;
  const pageIsRunning = bridgeLiveEditors.has(slot) && state.bridge?.documentId != null;
  let timer: NodeJS.Timeout | undefined;
  const bound = new Promise<void>(resolve => {
    const waiters = panelBindWaiters.get(slot) ?? new Set<() => void>();
    waiters.add(resolve);
    panelBindWaiters.set(slot, waiters);
    timer = setTimeout(resolve, EDITOR_REVIVE_TIMEOUT_MS);
  });
  try {
    if (!(await selectEditorTab(slot))) return { selected: false, panel: null };
    if (!pageIsRunning) await bound;
  } finally {
    clearTimeout(timer);
    panelBindWaiters.delete(slot);
  }
  const panel = tabs.get(slot)?.panel ?? null;
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
  const deadline = Date.now() + EDITOR_REVIVE_TIMEOUT_MS;
  for (;;) {
    const state = tabs.get(slot);
    if (state === undefined || state.panel === null) return;
    if (!state.transitioning && !openingTabs.has(tabId) && passiveReasonForSlot(slot) === null) return;
    if (Date.now() >= deadline) return;
    await new Promise<void>(resolve => setTimeout(resolve, 50));
  }
}

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
 * into the panel the user is looking at.
 */
async function openTab(
  context: vscode.ExtensionContext,
  index: SessionIndex,
  tabId: string,
  verb: "started" | "opened" | "resumed",
  openIntent: "explicit" | "restored" = "explicit",
  requestedMode?: SessionViewMode,
  externalConfirmed = false,
): Promise<void> {
  // Explicit mode actions use switchSessionMode; ordinary Open never changes a live editor.
  // The folder list may still be receiving the predecessor build's folders, so every
  // explicit open waits for that one pass to settle before it resolves anything.
  await ensureCatalogReady();
  // Number this request before it can wait: a close during the wait overrides
  // it, while a subsequent explicit click is a new request to open the editor.
  const intent = tabState(tabId);
  editorEventSequence += 1;
  intent.lastOpenRequest = editorEventSequence;
  // A new editor uses today's preference even when its conversation still has a
  // writer. Reattachment first discovers that writer's actual mode; the guarded
  // switch below then applies the requested view without overlapping writers.
  const existing = stateOf(tabId);
  const mode = requestedMode ?? (openIntent === "explicit" && existing?.panel == null &&
    !(existing !== undefined && bridgeLiveEditors.has(existing.slotId))
    ? defaultSessionMode(context) : undefined);
  const inFlight = openingTabs.get(tabId);
  if (inFlight !== undefined) {
    // A later click is its own editor request even while the first native
    // attempt is pending. Show a missing editor now; the shared attempt will
    // still perform exactly one restore, and a subsequent close cancels focus.
    const row = index.get(tabId);
    if (row !== null && (stateOf(tabId)?.panel ?? null) === null) {
      openPanel(context, index, tabId);
      refreshLauncher();
    }
    await inFlight;
    if (intent.lastOpenRequest > intent.lastEditorClose) {
      const published = stateOf(tabId)?.panel ?? null;
      if (published !== null) await revealExistingTab(index, tabId, published);
    }
    const published = stateOf(tabId);
    if (mode !== undefined && published?.runtime != null && published.mode !== mode) await switchSessionMode(context, index, published, mode);
    return;
  }
  const state = stateOf(tabId) ?? null;
  if (state !== null && state.panel !== null && state.runtime !== null) {
    // This window already runs this session, so nothing native is attempted — but the
    // editor showing it must still end up controlling it, in case its election was
    // refused earlier (before this window held the writer) and never retried.
    await electLocalController(index, tabId);
    await revealExistingTab(index, tabId, state.panel);
    if (mode !== undefined && mode !== state.mode) await switchSessionMode(context, index, state, mode);
    return;
  }
  const attempt = openTabOnce(context, index, tabId, verb, openIntent, mode, externalConfirmed);
  openingTabs.set(tabId, attempt);
  try {
    await attempt;
  } finally {
    if (openingTabs.get(tabId) === attempt) openingTabs.delete(tabId);
  }
  const published = stateOf(tabId);
  if (published !== undefined) {
    pushSessionView(index, published);
    if (mode !== undefined && published.runtime !== null && published.mode !== mode) await switchSessionMode(context, index, published, mode);
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
): Promise<void> {
  // Wait for the activation pass before touching this tab: it may be restoring
  // the very row this click is for, and a second restore of one row is what the
  // index refuses as a duplicate. No tab lifecycle is held while waiting — this
  // is only the pass's own completion — and ownership is still decided by the
  // index afterwards, exactly as for any other open.
  const startup = startupRestore;
  if (startup !== null && startup.cohort.has(tabId)) {
    await startup.settled;
    // The pass is this row's one authoritative native attempt. When it connected
    // a host — and this tab's editor was restored meanwhile, which is the ordinary
    // case for a row that was open when the app closed — this click only brings
    // that editor forward. When it refused or failed, the click is an ordinary
    // open of the row as it now is: the index re-derives its verdict from current
    // facts rather than from the pass's own failure, which says nothing about who
    // owns the session.
    const connected = stateOf(tabId)?.panel ?? null;
    const runtime = stateOf(tabId)?.runtime ?? null;
    if (verb !== "resumed" && connected !== null && runtime !== null) {
      await revealExistingTab(index, tabId, connected);
      return;
    }
  }
  let stoppedForOpen = false;
  const recorded = index.get(tabId);
  if (intent === "explicit" && stateOf(tabId)?.runtime == null && recorded?.host != null && !isManagedHost(recorded.host) && (verb === "resumed" || verb === "opened")) {
    const pid = await verifiedOwnedWriterPid(index, tabId);
    if (pid !== null) {
      const label = "Stop and Open";
      const choice = await vscode.window.showWarningMessage(
        "Stop the running session and open it here?",
        { modal: true, detail: "Unsaved replies and work in progress may be lost." },
        label,
      );
      if (choice !== label || !(await stopVerifiedOwnedWriter(context, index, tabId, pid))) return;
      stoppedForOpen = verb === "opened";
    }
  }
  // A plain omp outside this extension that writes this session is not replaced or joined silently:
  // an explicit attempt that can launch a writer asks first (a Resume, or an Open of a row whose
  // run intent is not stopped), and OMP then saves to a sibling file (ADR-0046). A stopped row's
  // plain Open and history views start no writer here, so they never ask.
  if (intent === "explicit" && (verb === "resumed" || recorded?.runIntent !== "stopped") && !externalConfirmed && stateOf(tabId)?.runtime == null) {
    const fresh = await launcherOwnershipFacts(index, tabId, { fresh: true });
    if (fresh.externalOmp === true && !(await confirmOpenAnyway())) {
      launcherProvider?.refreshOwnership(new Set([tabId]));
      return;
    }
  }
  const row = index.get(tabId);
  if (row === null) {
    showError("This session is no longer in Sessions. Refresh and try again.");
    return;
  }
  const opening = tabState(tabId);
  if (opening.runtime !== null) opening.mode = opening.runtime.kind;
  else if (requestedMode !== undefined) opening.mode = requestedMode;
  else if (opening.panel === null) opening.mode = intent === "restored" || bridgeLiveEditors.has(opening.slotId)
    ? index.slotBinding(opening.slotId)?.mode ?? defaultSessionMode(context)
    : defaultSessionMode(context);
  // The wait above is where a resume can undo what the user did: the editor VS
  // Code restored may have been closed while this attempt waited. An editor the
  // user closed is not reopened by the attempt's continuation — but a click that
  // arrived after that close is an ordinary open of a row without an editor, and
  // it does open one. The rest of the attempt runs either way, so the row is
  // reconciled exactly once and a refused or failed restore is still retried.
  if (tabState(tabId).lastOpenRequest <= tabState(tabId).lastEditorClose) {
    log(`tab ${tabId}: its editor was closed while this open was waiting; no editor is opened for it`);
  } else {
    // The editor is created (or revealed) before anything native happens: it is where the
    // user sees whatever comes next, and a launch that is slow or cannot start must not
    // delay the chat surface or hide the reason it is unavailable.
    openPanel(context, index, tabId);
    refreshLauncher();
  }
  const openedState = stateOf(tabId);
  if (openedState?.runtime != null) {
    await electLocalController(index, tabId);
    pushSessionView(index, openedState);
    return;
  }
  if (index.get(tabId) === null) {
    showError("This session is no longer in Sessions. Refresh and try again.");
    return;
  }
  // History is painted from the session file on disk while the process starts: the page
  // shows the saved transcript at once, read-only, and the live conversation replaces it
  // when the process is ready. Nothing here claims, launches or writes.
  if (opening.mode === "chat" && row.sessionFile !== null && chat.kindOf(tabId) !== "live") {
    void chat
      .showViewOnly(tabId, {
        file: row.sessionFile, cwd: row.cwd, title: row.title,
        reason: row.runIntent === "stopped" && verb === "opened" ? "This session is stopped." : "Starting the session…",
        phase: "resyncing",
      })
      .then(() => {
        // The live conversation may already have replaced this placeholder.
        if (chat.kindOf(tabId) === "view-only") attachChatRoutes(tabId, true);
      });
  }
  let outcome: RestoreOutcome;
  try {
    // Restoring the editor or opening stopped history never lifts its stopped intent.
    // Only Resume (or explicitly starting a draft with no history) may do that.
    outcome = await index.restore(tabId, {
      reconciler,
      launcher: launcher(context, index),
      mode: opening.mode,
      editorSlotId: stateOf(tabId)?.slotId,
      allowStoppedResume: intent === "explicit" && (verb !== "opened" || stoppedForOpen),
    });
  } catch (error) {
    presentUnavailable(index, tabId, messageOf(error));
    showError(`The OMP session could not be ${verb}: ${messageOf(error)}`);
    return;
  }
  await handleRestoreOutcome(context, index, tabId, outcome);
  const publishedState = stateOf(tabId);
  if (publishedState !== undefined) pushSessionView(index, publishedState);
  void revealActiveSession(index);
}

// Launch and reconciliation ports

function launcher(context: vscode.ExtensionContext, index: SessionIndex): OmpHostLauncher {
  return {
    launch: request => launchHost(context, index, request),
    attach: request => attachHost(context, index, request),
  };
}

/**
 * Hand one running host to its host-owned conversation.
 *
 * The conversation is the host's, not a panel's: it is attached whether or not an editor is
 * open, reads the session file's tail from disk before the process is ready (the first
 * paint), and folds the process's own frames afterwards. Every editor showing the tab is
 * pointed at it, so a panel that opened first receives the conversation the moment it exists.
 */
async function startConversation(
  index: SessionIndex,
  tabId: string,
  runtime: SessionHostRuntime,
  sessionFile: string | null,
  replayFromStart: boolean,
): Promise<void> {
  cancelControlPicker(tabId);
  tabState(tabId).runtime = runtime;
  const state = tabState(tabId);
  state.mode = runtime.kind;
  // The selected view can differ from a surviving writer we just reattached.
  // Persist what actually runs, not the provisional selection stamped while
  // its editor was being created; restoration must not turn every such tab
  // into the profile default on the next launch.
  const binding = index.slotBinding(state.slotId);
  if (binding?.tabId === tabId && binding.mode !== state.mode) await index.setEditorMode(state.slotId, state.mode);
  if (runtime.kind === "terminal") {
    chat.release(tabId);
    detailTabs.closeConversation(tabId);
    state.chatDetach?.();
    state.chatDetach = null;
    ensureTerminalPipeline(index, tabId, runtime.handle);
    // Broker authentication is not its output subscription. Watch first, then
    // activate the native stream before publishing this frontend as available.
    await runtime.handle.attach();
    startNativeWatch(index, state, runtime);
    refreshGuestContext();
    return;
  }
  const entry = index.get(tabId);
  chat.startLive(tabId, {
    channel: runtime.handle,
    sessionFile,
    cwd: runtime.cwd,
    title: entry?.title ?? null,
    // A re-adopted child replays what its broker buffered since the beginning; a fresh one
    // has nothing to replay.
    ...(replayFromStart ? { initialSeq: 0 } : {}),
  });
  if (state.transitioning) chat.sessionOf(tabId)?.setMutationFence("Session lifecycle transition.");
  attachChatRoutes(tabId, true);
}

/**
 * Re-adopt a host that outlived this extension host.
 *
 * The index calls this only after its own re-check of the recorded host, and the verdict it
 * acted on already required the exact broker generation, child and creation time. This
 * re-proves exactly that pinned target through its broker slot (and nothing else if that
 * fails): nothing is spawned, no claim is touched, and a target that cannot be proven is
 * never replaced by another transport.
 */
async function attachHost(
  context: vscode.ExtensionContext,
  index: SessionIndex,
  request: OmpHostAttachRequest,
): Promise<OmpHostAttachResult> {
  const attachedAt = Date.now();
  diagnostics.beginSubject(request.tabId, {
    label: diagnosticsLabel(request.cwd),
    kind: "session",
    cwd: request.cwd,
    sessionFile: request.sessionFile,
    startedAt: attachedAt,
  });
  diagnostics.notObserved(request.tabId, "resolution", "this host was not launched by this window");
  diagnostics.begin(request.tabId, "broker-launch", {
    provenance:
      "extension host: this window's attachRpcHost() of an already-running host — the launch happened in an earlier extension-host generation, so it is not measured here",
  });
  diagnostics.begin(request.tabId, "first-paint");
  diagnostics.begin(request.tabId, "chat-live");
  diagnostics.begin(request.tabId, "host-control-verified", {
    provenance:
      "extension host: from this window's attach of an already-running host to connectVerified() completing with the stored key",
  });
  diagnostics.note(request.tabId, `attaching the host recorded as pid ${request.recordedHost.pid ?? "unknown"}`);
  const failAll = (reason: string): void => {
    diagnostics.fail(request.tabId, "broker-launch", reason);
    diagnostics.notObserved(request.tabId, "first-paint", "the attach produced no conversation");
    diagnostics.notObserved(request.tabId, "chat-live", "the attach produced no conversation");
    diagnostics.notObserved(request.tabId, "host-control-verified", "the attach produced no runtime");
  };
  const client = await attachBrokerClient();
  if (client === null) {
    failAll("the PTY broker is not available in this window");
    return { state: "unavailable", reason: "The PTY broker is not available in this window." };
  }
  let outcome: RpcAttachOutcome | NativeAttachOutcome;
  try {
    outcome = await (request.recordedHost.transport === "native" ? attachNativeHost : attachRpcHost)({
      pin: request.pin,
      cwd: request.cwd,
      sessionFile: request.sessionFile,
      client,
    });
  } catch (error) {
    failAll(messageOf(error));
    log(`tab ${request.tabId}: attach failed — ${messageOf(error)}`);
    return { state: "unavailable", reason: `Re-adopting the running host failed: ${messageOf(error)}` };
  }
  const runtime = outcome.runtime;
  if (runtime === null) {
    failAll(outcome.reason);
    log(`tab ${request.tabId}: attach unavailable — ${outcome.reason}`);
    return { state: "unavailable", reason: outcome.reason };
  }
  diagnostics.succeed(request.tabId, "broker-launch", { detail: `pid ${runtime.pid} · ${outcome.reason}` });
  await startConversation(index, request.tabId, runtime, request.sessionFile, true);
  await index.setRunIntent(request.tabId, "running", `attached ${outcome.reason}`);
  log(`tab ${request.tabId}: attached — ${outcome.reason}`);
  void reconnectHostControl(context, index, request.tabId, request.ownerGeneration, runtime);
  return { state: "attached", host: hostHandle(runtime, request.sessionId) };
}

async function launchHost(
  context: vscode.ExtensionContext,
  index: SessionIndex,
  request: OmpHostLaunchRequest,
): Promise<OmpHostLaunchResult> {
  // Fresh authenticated current-file readback protects against an own native
  // /resume hidden by a stale catalog row. Failure remains explicitly best effort.
  if (request.sessionFile !== null) {
    for (const state of tabs.values()) {
      const native = state.runtime;
      const control = state.control?.client;
      if (native?.kind !== "terminal" || control === undefined || !isOpenControlClient(control)) continue;
      try {
        const facts = await control.nativeState();
        if (state.runtime !== native || !facts.available) continue;
        native.observed = facts;
        if (facts.sessionFile !== null && controlPathEquals(facts.sessionFile, request.sessionFile)) return { state: "not-started", reason: "An authenticated native OMP process in this window currently serves this exact file. No second writer was launched." };
      } catch { /* SDK readback is best effort, never a global writer ledger. */ }
    }
  }
  // The native host-control module and the pipe helper run from a verified copy staged
  // outside the installed extension folder, so a reinstall can rename that folder while the
  // session runs. Staged before the recipient is generated, so a failure here is reported
  // as such and no half-prepared launch leaves a key behind.
  let entries: StagedRuntimeEntries;
  try {
    entries = await runtimeEntries(context);
  } catch (error) {
    return {
      state: "not-started",
      reason: `The extension's runtime entries could not be staged outside the installed folder: ${messageOf(error)}`,
    };
  }
  // The recipient is generated and its private half stored before the process exists, so a
  // launch can never outrun the key that decrypts its rendezvous.
  const slot = createHostSlotId();
  const credentialOwner = request.transport === "native" ? `native.${slot}` : request.ownerGeneration;
  const control = await prepareHostControl(context, request.tabId, credentialOwner, entries.hostControl.path);
  // One mark per launch: the stages below are all measured from it, so the report reads as
  // one startup timeline (launcher → broker → first paint → live → host control).
  diagnostics.beginSubject(request.tabId, {
    label: diagnosticsLabel(request.cwd),
    kind: "session",
    cwd: request.cwd,
    sessionFile: request.sessionFile,
  });
  diagnostics.begin(request.tabId, "broker-launch");
  diagnostics.begin(request.tabId, "first-paint");
  diagnostics.begin(request.tabId, "chat-live");
  diagnostics.begin(request.tabId, "host-control-verified");
  const notStarted = (reason: string): OmpHostLaunchResult => {
    diagnostics.fail(request.tabId, "broker-launch", reason);
    diagnostics.notObserved(request.tabId, "resolution", "this launch ended before the launcher reported a resolution measurement");
    diagnostics.notObserved(request.tabId, "first-paint", "no host was started");
    diagnostics.notObserved(request.tabId, "chat-live", "no host was started");
    diagnostics.notObserved(request.tabId, "host-control-verified", "no host was started");
    return { state: "not-started", reason };
  };
  // One writer, started by the extension-owned broker (ADR-0024/0038).
  const client = await brokerClient();
  if (client === null) {
    return notStarted(
      "The extension-owned PTY broker is not available in this build, so no OMP host was started. " +
        (ptyGate?.reason() ?? "The staged broker runtime could not be verified."),
    );
  }
  // A document's native binding is immutable. Resume/Reload replaces the child, so
  // retire the old capability and remount this same editor with a fresh incarnation.
  const editor = stateOf(request.tabId);
  if (editor !== undefined && editor.panel !== null && editor.bridge !== null && editor.bridge.endpoint.committedBinding() !== null) {
    await prepareBridgeDocument(context, editor.bridge.editorId);
    renderPanelDocument(context, editor.bridge.editorId);
  }
  // The broker slot is minted once per host and never derived from the conversation. A new
  // launch always mints a new slot: a recorded slot may still hold a retained record whose
  // process tree could not be proven empty, and reusing it would replay this launch into that
  // retained slot instead of giving the new writer its own identity.
  const launchEditorId = stateOf(request.tabId)?.bridge?.editorId ?? null;
  // Reserved before anything is started: a broker this window could not record is a process
  // no restart could find again, so a full table refuses *before* a launch.
  const reserved = await brokerSlots?.record({ slot, conversation: request.tabId, editor: launchEditorId });
  if (reserved !== undefined && !reserved.ok) return notStarted(reserved.reason);
  const outcome = await (request.transport === "native" ? launchNativeHost : launchRpcHost)(
    {
      slot,
      cwd: request.cwd,
      sessionFile: request.sessionFile,
      profile: request.scope.profile,
      sessionDir: request.scope.sessionDir,
      control: control === null ? null : control.bootstrap,
    },
    client,
  );
  const runtime = outcome.runtime;
  if (runtime === null) {
    // Nothing this window recorded can be a writer: release the reservation so the slot is
    // available again. An unconfirmed launch keeps it, because a broker may exist.
    if (outcome.state === "not-started") await brokerSlots?.forget(slot).catch(() => undefined);
    log(`tab ${request.tabId}: ${outcome.state} — ${outcome.reason}`);
    if (outcome.state === "not-started") return notStarted(outcome.reason);
    diagnostics.fail(request.tabId, "broker-launch", outcome.reason);
    diagnostics.notObserved(request.tabId, "resolution", "this launch ended before the launcher reported a resolution measurement");
    diagnostics.notObserved(request.tabId, "first-paint", "the launch produced no confirmed host");
    diagnostics.notObserved(request.tabId, "chat-live", "the launch produced no confirmed host");
    diagnostics.notObserved(request.tabId, "host-control-verified", "the launch produced no confirmed host");
    return { state: "unconfirmed", reason: outcome.reason };
  }
  // The launcher's own measurement of its resolution, not a re-measurement here.
  if (runtime.resolutionMs === undefined || runtime.binary === null) {
    diagnostics.notObserved(request.tabId, "resolution", "the launcher reported no resolution measurement for this host");
  } else {
    diagnostics.observe(request.tabId, "resolution", {
      durationMs: runtime.resolutionMs,
      detail: `${runtime.binary.command} ${runtime.binary.prefixArgs.join(" ")}`.trim(),
    });
  }
  diagnostics.succeed(request.tabId, "broker-launch", { detail: `pid ${runtime.pid} · slot ${runtime.identity.slot}` });
  await startConversation(index, request.tabId, runtime, request.sessionFile, false);
  log(`tab ${request.tabId}: ${outcome.state} — ${outcome.reason}`);
  if (runtime.notice !== null) showWarning(runtime.notice);
  // The native extension receives session_start before rpc-ui handles get_state.
  // Its exact session identity is checked only after that positive startup barrier.
  if (control !== null) {
    void connectHostControl(context, index, request.tabId, request.ownerGeneration, runtime, control);
  } else {
    diagnostics.notObserved(
      request.tabId,
      "host-control-verified",
      "this launch had no host-control bootstrap: the recipient could not be prepared before the process started",
    );
  }
  // A verified launch is a durable "this should be running": the row is running again after
  // a reload instead of being read as a deliberate stop.
  await index.setRunIntent(request.tabId, "running");
  return { state: "running", host: hostHandle(runtime, request.sessionId) };
}

function hostHandle(runtime: SessionHostRuntime, sessionId: string | null): OmpHostHandle {
  return { pid: runtime.pid, sessionId, rpc: runtime.identity, transport: runtime.kind === "terminal" ? "native" : "rpc" };
}

/** Native credentials follow the exact launch, never the mutable conversation row. */
function controlOwnerFor(runtime: SessionHostRuntime, ownerGeneration: string): string {
  return runtime.kind === "terminal" ? `native.${runtime.identity.slot}` : ownerGeneration;
}

function recordedControlOwner(entry: SessionIndexEntry): string | null {
  return entry.host?.transport === "native" && entry.host.rpc != null ? `native.${entry.host.rpc.slot}` : entry.ownership?.ownerGeneration ?? null;
}

function startNativeWatch(index: SessionIndex, state: TabState, runtime: NativeHostRuntime): void {
  state.nativeWatch?.();
  let cancelled = false;
  let timer: NodeJS.Timeout | null = null;
  const onSuppressed = logNotificationSuppression;
  const reportSuppressed = (kind: TurnNotice["kind"], reason: NotificationSuppression | "aborted"): void => {
    if (state.tabId !== null) onSuppressed(state.tabId, kind, reason);
  };
  let activityLedger = new NativeActivityLedger(reportSuppressed);
  // A reconnect builds a new ledger that recovers a still-pending dialog; its toast was already sent.
  const announcedRequests = new Set<string>();
  let activityClient: HostControlClient | undefined;
  let nextConnectionAttemptAt = Date.now() + 5_000;
  let consecutiveControlFailures = 0;
  let signalState: "available" | "control-unavailable" | "native-not-ready" | "older-host" | null = null;
  const reportSignals = (next: typeof signalState): void => {
    if (signalState === next || state.tabId === null) return;
    signalState = next;
    log(`tab ${state.tabId}: native completion signals ${next === "available" ? "available — sealed activity journal" : next === "older-host" ? "unavailable — this native host predates the completion journal; state observation continues" : next === "native-not-ready" ? "unavailable — verified host has not reported native session readiness yet" : "unavailable — waiting for verified host control; connection will retry"}`);
  };
  const unsubscribe = runtime.handle.subscribe(event => {
    if (event.type === "state" && event.status.state === "exited" && state.tabId !== null) {
      void handleNativeHostExited(index, state, runtime);
    }
  });
  const tick = async (): Promise<void> => {
    if (cancelled || state.runtime !== runtime || state.tabId === null) return;
    let polledClient: HostControlClient | undefined;
    try {
      await runtime.handle.refreshStatus();
      if (runtime.handle.state === "exited") {
        await handleNativeHostExited(index, state, runtime);
        return;
      }
      const client = state.control?.client;
      if (!isOpenControlClient(client)) {
        reportSignals("control-unavailable");
        if (!state.transitioning && !runtime.stopping && activationContext !== undefined &&
            Date.now() >= nextConnectionAttemptAt && !hostControlAttempts.has(runtime)) {
          nextConnectionAttemptAt = Date.now() + 5_000;
          void reconnectHostControl(activationContext, index, state.tabId, index.get(state.tabId)?.ownership?.ownerGeneration ?? "", runtime)
            .catch(error => {
              if (!cancelled && state.runtime === runtime && !state.transitioning && !runtime.stopping &&
                  !isOpenControlClient(state.control?.client)) setControlFailure(state.tabId!, describeControlError(error));
            })
            .finally(() => {
              // Every attempt dials the slot's pipes through a PowerShell peer proof, so a host
              // that cannot be verified is retried less and less often: 5 s, doubling to 60 s.
              consecutiveControlFailures = isOpenControlClient(state.control?.client) ? 0 : consecutiveControlFailures + 1;
              nextConnectionAttemptAt = Date.now() + Math.min(60_000, 5_000 * 2 ** Math.min(consecutiveControlFailures, 4));
            });
        }
      }
      if (client !== undefined && isOpenControlClient(client) && !state.transitioning) {
        polledClient = client;
        if (activityClient !== client) { activityClient = client; activityLedger = new NativeActivityLedger(reportSuppressed); }
        const journal = state.control?.activity === true
          ? await client.nativeActivity(state.control.work === true ? { work: true } : {}) : null;
        const facts = journal === null ? await client.nativeState() : journal.state;
        if (state.runtime !== runtime || state.transitioning) return;
        if (state.control?.client !== client) return;
        reportSignals(journal === null ? "older-host" : facts.available ? "available" : "native-not-ready");
        runtime.observed = facts;
        if (facts.available) await observeNativeConversation(index, state, runtime, facts);
        if (state.tabId !== null) {
          const notices = journal === null ? [] : activityLedger.observe(journal,
            index.get(state.tabId)?.sessionId ?? null, notificationSuppression(index, state.tabId));
          const work = journal?.work ?? null;
          const activity: TurnActivity = {
            streaming: work?.working === true, backgroundWork: work?.backgroundWork === true,
            settled: facts.settled === true, promptStatus: null, completionOutcome: null,
            pendingRequest: journal === null ? null : activityLedger.pendingRequest,
            outcome: null, trailingQuestion: false,
          };
          const previous = turnActivities.get(state.tabId);
          turnActivities.set(state.tabId, activity);
          if (activity.pendingRequest === null) announcedRequests.clear();
          for (const notice of notices) {
            if (notice.kind === "request-pending") {
              if (announcedRequests.has(notice.requestId)) continue;
              announcedRequests.add(notice.requestId);
            }
            notifierFor(index).notify(state.tabId, notice);
          }
          if (previous === undefined || activitySignature(previous) !== activitySignature(activity)) {
            log(`tab ${state.tabId}: native observation ${activity.pendingRequest !== null ? "needs your answer" : facts.settled === true ? "settled" : work?.working === true ? "working" : work?.backgroundWork === true ? "background work" : "unsettled/unknown"} (${journal === null ? "completion journal unavailable" : work === null ? "work detail unavailable" : "completion journal observed"})`);
            refreshLauncher();
          }
        }
      }
      pushSessionView(index, state);
    } catch (error) {
      if (state.runtime === runtime && !state.transitioning && !runtime.stopping) {
        if (polledClient !== undefined && state.control?.client === polledClient) {
          setControlFailure(state.tabId!, describeControlError(error));
          reportSignals("control-unavailable");
        } else {
          state.controlFailure = `Native control is unavailable (${messageOf(error)}). After /restart, use native /exit or explicit force Stop; no automatic replacement is safe.`;
        }
      }
      pushSessionView(index, state);
    } finally {
      if (!cancelled && state.runtime === runtime) {
        timer = setTimeout(() => void tick(), 750);
        timer.unref?.();
      }
    }
  };
  state.nativeWatch = () => { cancelled = true; clearTimeout(timer ?? undefined); unsubscribe(); };
  void tick();
}

const nativeObservations = new WeakMap<NativeHostRuntime, Promise<void>>();

async function observeNativeConversation(index: SessionIndex, state: TabState, runtime: NativeHostRuntime, facts: ControlNativeState): Promise<void> {
  const previous = nativeObservations.get(runtime) ?? Promise.resolve();
  const next = previous.then(async () => {
    if (state.runtime !== runtime) return;
    runtime.observed = facts;
    await applyNativeConversationObservation(index, state, runtime, facts);
  });
  nativeObservations.set(runtime, next.catch(() => undefined));
  await next;
}

async function applyNativeConversationObservation(index: SessionIndex, state: TabState, runtime: NativeHostRuntime, facts: ControlNativeState): Promise<void> {
  const fromId = state.tabId;
  if (fromId === null || facts.sessionId === null || state.runtime !== runtime || state.transitioning) return;
  const from = index.get(fromId);
  if (from === null) return;
  const sameId = from.sessionId === null || from.sessionId === facts.sessionId;
  const sameFile = from.sessionFile === null || (facts.sessionFile !== null && controlPathEquals(from.sessionFile, facts.sessionFile));
  if (sameId && sameFile) {
    await index.recordHostSessionId(fromId, facts.sessionId);
    if (facts.sessionFile !== null && from.sessionFile === null) await bindConversationIdentity(index, fromId, runtime, facts.sessionFile, facts.sessionId);
    if (facts.name !== from.title) {
      await index.recordConversationState(fromId, { title: facts.name });
      if (activationContext !== undefined) void applyChatTabAppearance(activationContext, index, fromId);
    }
    await commitBridgeDocument(fromId);
    refreshBridgeReadiness(fromId);
    return;
  }
  // SDK allocated paths may not exist yet. Never import or materialize one.
  let destination: SessionIndexEntry | null = null;
  const observedFile = facts.sessionFile;
  if (observedFile !== null && await readSessionFileHeader(observedFile) !== null) {
    destination = index.list().find(entry => entry.sessionFile !== null && controlPathEquals(entry.sessionFile, observedFile)) ?? await index.trackSession({ sessionFile: observedFile, cwd: facts.cwd ?? runtime.cwd, scope: from.scope });
  } else if (observedFile === null || !sameId) {
    destination = index.list().find(entry => entry.sessionFile === null && entry.sessionId === facts.sessionId) ?? await index.createDraft({ cwd: facts.cwd ?? runtime.cwd, scope: from.scope });
  }
  if (destination === null || state.runtime !== runtime || state.transitioning || state.tabId !== fromId || runtime.identity.childCreationTime === null) return;
  const mapping = brokerSlots;
  if (mapping === undefined) return;
  const priorDestinationSlot = mapping.forConversation(destination.tabId) ?? undefined;
  const result = await index.transferNativeHost({
    fromTabId: fromId, toTabId: destination.tabId, slotId: state.slotId, expectedPid: runtime.pid,
    expectedCreationTime: runtime.identity.childCreationTime, sessionId: facts.sessionId, name: facts.name, reconciler,
    brokerMapping: { key: BROKER_SLOTS_KEY, decide: latest => {
      const plan = mapping.planRepointAgainst(latest, fromId, destination.tabId, priorDestinationSlot);
      return plan.ok ? { desired: plan.value } : { refused: plan.reason };
    } },
  });
  if (result.status === "refused") {
    state.controlFailure = result.detail;
    if (result.kind === "conflict") {
      await index.bindEditorSlot(state.slotId, fromId, "passive");
      bindSlotToConversation(state.slotId, fromId, "passive", result.detail);
    }
    return;
  }
  mapping.reload();
  stopTerminalForTab(state.slotId);
  draftRestores.delete(state.slotId);
  pendingIdentityFiles.delete(fromId);
  forgetTurnActivity(index, fromId);
  const previousWinner = bridgeEditors.winner(destination.tabId);
  if (previousWinner !== null && previousWinner.editorId !== state.slotId) bridgeEditors.release(destination.tabId, previousWinner.editorId);
  bridgeEditors.rekey(fromId, state.slotId, destination.tabId);
  bindSlotToConversation(state.slotId, destination.tabId, result.binding.role, result.binding.roleRefusal ?? null);
  if (facts.sessionFile !== null && destination.sessionFile === null) await bindConversationIdentity(index, destination.tabId, runtime, facts.sessionFile, facts.sessionId);
  const context = activationContext;
  if (context !== undefined && state.panel !== null) {
    state.document = null;
    if (state.bridge !== null) await prepareBridgeDocument(context, state.slotId);
    renderPanelDocument(context, state.slotId);
  }
  ensureTerminalPipeline(index, state.slotId, runtime.handle);
  await commitBridgeDocument(destination.tabId);
  refreshBridgeReadiness(destination.tabId);
  await index.setActiveTab(destination.tabId);
  if (activationContext !== undefined) void applyChatTabAppearance(activationContext, index, destination.tabId);
  refreshLauncher();
}

async function handleNativeHostExited(index: SessionIndex, state: TabState, runtime: NativeHostRuntime): Promise<void> {
  const tabId = state.tabId;
  const context = activationContext;
  if (tabId === null || context === undefined) return;
  await index.lifecycle.run(tabId, async lease => {
    if (state.runtime !== runtime || state.tabId !== tabId) return;
    if (runtime.observedSurvivors.length > 0) {
      state.controlFailure = `The root exited, but the broker observed surviving processes (${runtime.observedSurvivors.join(", ")}). A successor is refused; use explicit Stop to recheck.`;
      pushSessionView(index, state);
      return;
    }
    const client = await attachBrokerClient();
    if (client === null) return;
    const stop = await waitForManagedRootExit(runtime, client, 1_000);
    log(`native exit ${runtime.pid}: ${stop.diagnosticDetail ?? stop.detail}`);
    if (!stop.writerGone) { state.controlFailure = stop.detail; return; }
    const owner = controlOwnerFor(runtime, index.get(tabId)?.ownership?.ownerGeneration ?? "");
    state.runtime = null;
    stopTerminalForTab(state.slotId);
    state.nativeWatch?.();
    state.nativeWatch = null;
    state.transitioning = false;
    await releaseHostControl(context, tabId, owner);
    await index.setRunIntent(tabId, "stopped", stop.detail);
    await index.closeSession(tabId, { confirmedStopped: true, detail: stop.detail }, lease);
    outcomes.delete(tabId);
    turnActivities.delete(tabId);
    refreshGuestContext();
    refreshLauncher();
  });
}

/** Native graceful shutdown is an SDK request, never a ConPTY close. */
async function stopSessionRuntime(state: TabState, runtime: SessionHostRuntime, mode: "graceful" | "force", consent: boolean, expected?: SessionTransitionFacts | null): Promise<NativeStopVerdict> {
  if (runtime.kind === "chat") {
    const broker = await attachBrokerClient();
    if (broker === null) return { writerGone: false, treeEmpty: false, detail: "This session is disconnected. Reopen its editor and try Stop again." };
    if (mode === "graceful") {
      const captured = expected ?? await readTransitionFacts(state, runtime);
      if (captured === null) return { writerGone: false, treeEmpty: false, detail: "The running session could not be checked. Reopen its editor and try Stop again." };
      if (!captured.settled && !consent) return { writerGone: false, treeEmpty: false, detail: "OMP is busy. Confirm that you want to abort the current turn before stopping." };
      if (!captured.settled) {
        const abort = await chat.sessionOf(state.tabId ?? "")?.abortForShutdown();
        if (abort?.status !== "accepted") return { writerGone: false, treeEmpty: false, detail: "OMP did not confirm aborting the turn. Try Stop again." };
      }
      if (await waitForRpcSettlement(state, runtime, captured) === null) return { writerGone: false, treeEmpty: false, detail: "OMP is still finishing work, or the session changed. Nothing was replaced; try again when it is idle." };
    }
    const stopped = await stopRpcHost(runtime, mode);
    return stopped.writerGone ? await waitForManagedRootExit(runtime, broker, 5_000) : stopped;
  }
  const broker = await attachBrokerClient();
  if (broker === null) return { writerGone: false, treeEmpty: false, detail: "This session is disconnected. Reopen its editor and try Stop again." };
  try {
    if (mode === "force") {
      runtime.stopping = true;
      state.transitioning = true;
      const forced = await runtime.handle.stop({ mode: "force", timeoutMs: 5_000 });
      runtime.observedSurvivors = forced.remainingPids;
      if (forced.remainingPids.length > 0) {
        log(`native force stop: remaining pids ${forced.remainingPids.join(", ")}`);
        return { writerGone: false, treeEmpty: false, detail: "Some commands are still running. Nothing was restarted; try Stop again." };
      }
      return await waitForManagedRootExit(runtime, broker, 5_000);
    }
    const control = state.control?.client;
    if (control === undefined || !isOpenControlClient(control)) return { writerGone: false, treeEmpty: false, detail: "This Terminal is disconnected. Use /exit there, or choose Force Stop. Commands it started may continue running separately; no replacement is started." };
    const snapshot = await control.snapshot();
    const facts = await control.nativeState();
    if (!facts.available) return { writerGone: false, treeEmpty: false, detail: facts.unavailableReason ?? "Native shutdown is unsupported by this host." };
    if (expected !== undefined && (expected === null || expected.epoch !== snapshot.host.epoch || expected.file !== facts.sessionFile || expected.sessionId !== facts.sessionId)) {
      return { writerGone: false, treeEmpty: false, detail: "The native target changed after confirmation; nothing was stopped." };
    }
    runtime.stopping = true; // A lost acknowledgement may already have committed shutdown.
    state.transitioning = true;
    state.pipeline?.noteReadOnly("Native OMP is stopping; queued or background work may still be finishing.");
    const status = await control.nativeShutdown({ epoch: snapshot.host.epoch, sessionFile: facts.sessionFile, sessionId: facts.sessionId }, consent);
    if (status !== "accepted" && status !== "accepted-deferred") {
      runtime.stopping = false;
      log(`native shutdown refused: ${status}`);
      return { writerGone: false, treeEmpty: false, detail: "OMP did not accept the stop request. Try Stop again; nothing was restarted." };
    }
    return await waitForManagedRootExit(runtime, broker);
  } catch (error) {
    log(`native shutdown unconfirmed: ${messageOf(error)}`);
    return { writerGone: false, treeEmpty: false, detail: "The session could not be confirmed stopped. Check its Terminal before trying Stop again; see OMP Desk output for details." };
  }
}

const SESSION_DEFAULT_MODE_KEY = "omp.session.defaultMode";
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

/**
 * Open (a stopped row launches) or show (a live row reveals its editor, reopening it when only the tab
 * was closed) one session in an explicit view. Both verbs are the same admitted path; only the wording differs.
 */
async function openSessionInMode(context: vscode.ExtensionContext, index: SessionIndex, argument: unknown, mode: SessionViewMode, verb: "open" | "show" = "open"): Promise<void> {
  const target = sessionTargetFromArgument(index, argument);
  if (target === null) { showWarning(`Select an OMP session to ${verb}.`); return; }
  let state = stateOf(target.tabId);
  // A tab VS Code has not shown since the window loaded has no panel handle yet; showing it is what creates one.
  if (state !== undefined && state.panel === null) {
    await reviveEditorPanel(index, target.tabId);
    state = stateOf(target.tabId);
  }
  if (state?.panel != null) {
    await revealExistingTab(index, target.tabId, state.panel);
    await switchSessionMode(context, index, state, mode);
    return;
  }
  if (state?.bridge != null && bridgeLiveEditors.has(state.bridge.editorId)) {
    showWarning("This tab was kept running while OMP restarted in the background, so its view cannot be changed from here. Run “Developer: Reload Window”, then try again.");
    return;
  }
  await openTab(context, index, target.tabId, "resumed", "explicit", mode);
}

/** Pending view requests disable title actions before initialization is ready to be fenced. */
const pendingSessionViewChanges = new Map<TabState, number>();

function sessionAdmissionReason(state: TabState): string | null {
  if (state.transitioning) return "The session view is changing or its process is stopping.";
  if (state.mode === "terminal") return "Chat commands are unavailable in Terminal; use the native TUI.";
  return passiveReasonForSlot(state.slotId);
}

function pushSessionView(index: SessionIndex | null, state: TabState, force = false): void {
  if (state.tabId === null) return;
  const entry = index?.get(state.tabId) ?? null;
  const title = entry === null ? "OMP session" : sessionHeadline(entry, null);
  const running = state.runtime !== null;
  const starting = state.mode === "terminal" && (openingTabs.has(state.tabId) || (!running && pendingSessionViewChanges.has(state)));
  const stopping = state.transitioning || (state.runtime?.kind === "terminal" && state.runtime.stopping);
  const canSwitch = !stopping && !pendingSessionViewChanges.has(state) && state.panel !== null && passiveReasonForSlot(state.slotId) === null && !openingTabs.has(state.tabId);
  const reason = starting ? null : state.controlFailure ?? (stopping ? "OMP is restarting or stopping this session. It can be used again once the old process has exited." : null);
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
  state.transitioning = fenced;
  refreshGuestContext();
  if (state.tabId !== null) {
    cancelControlPicker(state.tabId);
    chat.sessionOf(state.tabId)?.setMutationFence(fenced ? "Session lifecycle transition." : null);
  }
  applySlotAuthority(state.slotId);
  pushSessionView(index, state);
}

interface SessionTransitionFacts {
  readonly file: string | null;
  readonly sessionId: string | null;
  readonly epoch: string;
  readonly settled: boolean;
  readonly hasContent: boolean | null;
  readonly nativeTarget: ControlNativeTarget | null;
}

const SESSION_TRANSITION_READ_TIMEOUT_MS = 10_000;

/** Bound readback and gate admission, not a destructive transaction or a user's dialog. */
async function withSessionReadDeadline<T>(read: Promise<T>, timeoutMs = SESSION_TRANSITION_READ_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      read,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Session state read timed out.")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitForRpcSettlement(state: TabState, runtime: SessionHostRuntime, expected: SessionTransitionFacts): Promise<SessionTransitionFacts | null> {
  const deadline = Date.now() + 5_000;
  do {
    const last = await readTransitionFacts(state, runtime);
    if (last === null || last.epoch !== expected.epoch || last.file !== expected.file || last.sessionId !== expected.sessionId) return null;
    if (last.settled) return last;
    await new Promise<void>(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  return null;
}

async function readTransitionFacts(state: TabState, runtime: SessionHostRuntime): Promise<SessionTransitionFacts | null> {
  if (state.tabId === null || state.runtime !== runtime) return null;
  if (runtime.kind === "chat") {
    const session = chat.sessionOf(state.tabId);
    if (session === null) return null;
    const facts = await withSessionReadDeadline(session.readSettlement());
    return facts === null ? null : { file: facts.sessionFile, sessionId: facts.sessionId, epoch: `${session.epoch.nonce}:${session.epoch.counter}`, settled: facts.settled, hasContent: facts.hasContent, nativeTarget: null };
  }
  const client = state.control?.client;
  if (client === undefined || !isOpenControlClient(client)) return null;
  const snapshot = await withSessionReadDeadline(client.snapshot());
  const facts = await withSessionReadDeadline(client.nativeState(true));
  if (!facts.available) return null;
  runtime.observed = facts;
  const target = { epoch: snapshot.host.epoch, sessionFile: facts.sessionFile, sessionId: facts.sessionId };
  return { file: facts.sessionFile, sessionId: facts.sessionId, epoch: target.epoch, settled: facts.settled === true, hasContent: facts.hasContent, nativeTarget: target };
}

/** One editor, one held claim, positively non-overlapping exact root generations. */
async function switchSessionMode(context: vscode.ExtensionContext, index: SessionIndex, state: TabState, mode: SessionViewMode, reload = false): Promise<void> {
  if (state.tabId === null || state.panel === null || state.transitioning || passiveReasonForSlot(state.slotId) !== null || openingTabs.has(state.tabId)) {
    showWarning("This editor cannot change views while the session is starting or stopping, or another editor controls it.");
    return;
  }
  editorEventSequence += 1;
  const modeRequest = state.lastOpenRequest = editorEventSequence;
  const runtime = state.runtime;
  if (runtime === null) {
    pendingSessionViewChanges.set(state, modeRequest);
    state.mode = mode;
    state.controlFailure = null;
    pushSessionView(index, state);
    try {
      await index.setEditorMode(state.slotId, mode);
      refreshGuestContext();
      state.document = null;
      if (state.bridge !== null) await prepareBridgeDocument(context, state.bridge.editorId);
      renderPanelDocument(context, state.slotId);
      await openTab(context, index, state.tabId, "resumed");
    } finally {
      if (pendingSessionViewChanges.get(state) === modeRequest) pendingSessionViewChanges.delete(state);
      pushSessionView(index, state);
    }
    return;
  }
  if (runtime.kind === mode && !reload) {
    if (runtime.kind === "terminal") {
      try {
        await runtime.handle.refreshStatus();
        if (state.runtime !== runtime || state.panel === null) return;
        if (runtime.handle.state === "exited") {
          await handleNativeHostExited(index, state, runtime);
          if (state.runtime === null) await switchSessionMode(context, index, state, mode);
          else showWarning("This Terminal has stopped but could not be reopened safely. Use Stop in Processes, then open the session again.");
          return;
        }
        ensureTerminalPipeline(index, state.slotId, runtime.handle);
        await runtime.handle.attach();
        pushSessionView(index, state, true);
        activateNativeEditor(state);
      } catch (error) {
        log(`tab ${state.tabId}: Terminal reopen failed: ${messageOf(error)}`);
        showWarning("This Terminal could not be reconnected. Use Stop in Processes, then open the session again.");
      }
    }
    return;
  }
  const tabId = state.tabId;
  pendingSessionViewChanges.set(state, modeRequest);
  refreshGuestContext();
  let acceptedStop = false;
  let admissionFenced = false;
  let replacement: RestoreOutcome | null = null;
  let carried: CarriedDraft | null = null;
  try {
    const session = runtime.kind === "chat" ? chat.sessionOf(tabId) : null;
    const pending = runtime.kind === "terminal" ? hostControlAttempts.get(runtime)
      : session !== null && (session.phase === "starting" || session.phase === "attaching" || session.phase === "resyncing")
        ? session.start() : undefined;
    if (pending !== undefined) {
      // Control publication needs the gate: join initialization outside it.
      const panel = state.panel;
      await withSessionReadDeadline(pending);
      if (state.lastOpenRequest !== modeRequest || state.runtime !== runtime || state.tabId !== tabId || state.panel !== panel ||
          passiveReasonForSlot(state.slotId) !== null || openingTabs.has(tabId) ||
          (runtime.kind === "chat" && chat.sessionOf(tabId) !== session)) return;
    }
    if (runtime.kind === "terminal" && state.control !== null) {
      try {
        const observed = await withSessionReadDeadline(state.control.client.nativeState());
        runtime.observed = observed;
        if (observed.available) await observeNativeConversation(index, state, runtime, observed);
      } catch { /* Unavailable control is refused at the fenced boundary below. */ }
    }
    if (state.tabId !== tabId || state.lastOpenRequest !== modeRequest || state.runtime !== runtime || passiveReasonForSlot(state.slotId) !== null) return;
    const binding = index.slotBinding(state.slotId);
    if (binding === null || binding.tabId !== tabId) return;
    admissionFenced = true;
    fenceSessionAdmission(index, state, true);
    const captured = await withSessionReadDeadline(index.lifecycle.run(tabId, async () => {
      if (state.lastOpenRequest !== modeRequest || state.runtime !== runtime || state.tabId !== tabId) return null;
      return await readTransitionFacts(state, runtime);
    }));
    if (captured === null) {
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
      consent = await vscode.window.showWarningMessage(
        reload ? "Reload this OMP process in the same view?" : `OMP is busy. Abort the current turn and switch to ${mode === "chat" ? "Chat" : "Terminal"}?`,
        { modal: true, detail: "The current process must stop before the new view opens. Queued or background work may delay shutdown, and an accepted shutdown cannot be cancelled. In-flight tool effects may not be fully saved." },
        label,
      ) === label;
      if (!consent) return;
    }
    carried = state.mode === "chat" ? await carryDraftFrom(state.panel) : null;
    if (carried !== null) draftRestores.set(state.slotId, carried);
    const admitted = Promise.withResolvers<void>();
    const changing = index.lifecycle.run(tabId, async lease => {
      admitted.resolve();
      const currentBinding = index.slotBinding(state.slotId);
      if (state.lastOpenRequest !== modeRequest || state.runtime !== runtime || state.tabId !== tabId || currentBinding?.generation !== binding.generation || passiveReasonForSlot(state.slotId) !== null) return;
      const fresh = await readTransitionFacts(state, runtime);
      if (fresh === null || fresh.epoch !== captured.epoch || fresh.sessionId !== captured.sessionId || fresh.file !== captured.file || (!fresh.settled && !consent)) {
        showWarning("The OMP target or busy state changed while the action was pending; nothing was stopped.");
        return;
      }
      if (fresh.file !== null && await readSessionFileHeader(fresh.file) === null && fresh.hasContent !== false) {
        showError("The conversation is not durable yet; nothing was stopped.");
        return;
      }
      const broker = await attachBrokerClient();
      if (broker === null || runtime.identity.childCreationTime === null) { showWarning("The exact writer's broker/root identity cannot be proven; nothing was stopped."); return; }
      let stopped: NativeStopVerdict;
      if (runtime.kind === "terminal") {
        if (state.control === null || fresh.nativeTarget === null) return;
        runtime.stopping = true;
        acceptedStop = true; // An unanswered authenticated request may already have committed.
        const status = await withSessionReadDeadline(state.control.client.nativeShutdown(fresh.nativeTarget, consent));
        if (status !== "accepted" && status !== "accepted-deferred") {
          runtime.stopping = false;
          acceptedStop = false;
          showWarning(`Native shutdown was refused (${status}); nothing was replaced.`);
          return;
        }
        stopped = await waitForManagedRootExit(runtime, broker);
      } else {
        if (consent) {
          const abort = await withSessionReadDeadline(chat.sessionOf(tabId)?.abortForShutdown() ?? Promise.resolve(undefined));
          if (abort?.status !== "accepted") { showWarning("Abort was not confirmed; no replacement was started."); return; }
        }
        const last = await waitForRpcSettlement(state, runtime, fresh);
        if (last === null) { showWarning("RPC did not settle on the captured session; nothing was replaced."); return; }
        acceptedStop = true;
        const requested = await withSessionReadDeadline(stopRpcHost(runtime, "graceful"), 35_000);
        stopped = requested.writerGone ? await waitForManagedRootExit(runtime, broker, 5_000) : requested;
      }
      log(`tab ${tabId}: view switch stop: ${stopped.diagnosticDetail ?? stopped.detail}`);
      if (!stopped.writerGone) { state.controlFailure = stopped.detail; showWarning(stopped.detail); return; }
      const credentialOwner = controlOwnerFor(runtime, row.ownership?.ownerGeneration ?? "");
      state.nativeWatch?.();
      state.nativeWatch = null;
      state.runtime = null;
      stopTerminalForTab(state.slotId);
      await releaseHostControl(context, tabId, credentialOwner);
      await retireBroker(tabId, runtime);
      chat.release(tabId);
      const fileAfterExit = fresh.file === null ? null : await readSessionFileHeader(fresh.file);
      if (fileAfterExit !== null && index.get(tabId)?.sessionFile === null) await index.promoteDraft(tabId, fresh.file as string, lease);
      if (row.sessionFile !== null && fileAfterExit === null) {
        await index.closeSession(tabId, { confirmedStopped: true, detail: "The durable file is missing after disposal; no successor was launched." }, lease);
        showError("The durable session file disappeared after disposal; no replacement was started.");
        return;
      }
      state.mode = mode;
      state.controlFailure = null;
      pushSessionView(index, state);
      state.document = null;
      if (state.bridge !== null) await prepareBridgeDocument(context, state.bridge.editorId);
      renderPanelDocument(context, state.slotId);
      replacement = await index.replaceHost(tabId, { confirmedStopped: true, expectedPid: runtime.pid, expectedCreationTime: runtime.identity.childCreationTime, mode, slotId: state.slotId, emptyFile: fresh.file, launcher: launcher(context, index) }, lease);
      if (replacement.status === "failed" && state.runtime === null) await index.closeSession(tabId, { confirmedStopped: true, detail: replacement.detail }, lease);
    });
    await withSessionReadDeadline(admitted.promise);
    await changing;
    if (replacement !== null) await handleRestoreOutcome(context, index, tabId, replacement);
  } catch (error) {
    if (state.lastOpenRequest === modeRequest) state.lastOpenRequest = ++editorEventSequence;
    log(`tab ${tabId}: view switch failed: ${messageOf(error)}`);
    state.controlFailure = acceptedStop
      ? "The view switch could not finish because the session has not been confirmed stopped. Use Stop Session to recover."
      : "The view switch could not finish. The current view is still available; try switching again.";
    showWarning(state.controlFailure);
  } finally {
    if (carried !== null && state.document === carried.document) {
      releaseCarriedDraft(carried);
      if (draftRestores.get(state.slotId) === carried) draftRestores.delete(state.slotId);
    }
    if (pendingSessionViewChanges.get(state) === modeRequest) pendingSessionViewChanges.delete(state);
    if (admissionFenced && (state.runtime !== runtime || !acceptedStop)) fenceSessionAdmission(index, state, false);
    else pushSessionView(index, state);
    refreshGuestContext();
    refreshLauncher();
    if (acceptedStop && state.runtime === runtime) {
      void vscode.window.showWarningMessage(
        "The session is still stopping. Stop it before trying the view switch again.",
        "Stop Session",
      ).then(action => {
        if (action === "Stop Session" && state.runtime === runtime) return stopSessionHost(context, index, tabId);
      }).then(undefined, error => {
        log(`tab ${tabId}: view switch recovery failed: ${messageOf(error)}`);
        showWarning("The session could not be stopped from this editor. Use Stop in Processes, then reopen the session.");
      });
    }
  }
}

/** Explicit owned-Chat recovery; never asks the unresponsive native dispatcher to settle. */
async function restartChat(context: vscode.ExtensionContext, index: SessionIndex, tabId: string, nativeNonce: string): Promise<void> {
  const state = stateOf(tabId);
  const runtime = state?.runtime;
  const session = chat.sessionOf(tabId);
  const row = index.get(tabId);
  const binding = state === undefined ? null : index.slotBinding(state.slotId);
  const committed = state?.bridge?.endpoint.committedBinding() ?? null;
  const document = state?.document;
  const panel = state?.panel;
  const refuse = (text: string): void => { chat.notify(tabId, text); showWarning(text); };
  if (state === undefined || runtime?.kind !== "chat" || session === null || !session.nativeStateUnanswered ||
      session.epoch.nonce !== nativeNonce || state.mode !== "chat" || document?.kind !== "guest" || panel == null ||
      row?.sessionFile == null || row.sessionId === null || binding === null || committed === null ||
      runtime.identity.childCreationTime === null || passiveReasonForSlot(state.slotId) !== null ||
      state.transitioning || pendingSessionViewChanges.has(state) || openingTabs.has(tabId)) {
    refuse("Restart requires this controlling Chat editor, an unanswered native state request, and its exact saved conversation. Nothing was stopped.");
    return;
  }
  const file = row.sessionFile;
  const sessionId = row.sessionId;
  const creationTime = runtime.identity.childCreationTime;
  const modeRequest = ++editorEventSequence;
  state.lastOpenRequest = modeRequest;
  pendingSessionViewChanges.set(state, modeRequest);
  let carried: CarriedDraft | null = null;
  let stopRequested = false;
  let writerGone = false;
  let replacement: RestoreOutcome | null = null;
  const sameTarget = (requireUnanswered: boolean): boolean => {
    const current = index.get(tabId);
    const currentBinding = index.slotBinding(state.slotId);
    const currentCommitted = state.bridge?.endpoint.committedBinding() ?? null;
    return stateOf(tabId) === state && state.runtime === runtime && state.tabId === tabId &&
      state.lastOpenRequest === modeRequest && state.panel === panel && state.document === document &&
      state.mode === "chat" && passiveReasonForSlot(state.slotId) === null &&
      currentBinding?.generation === binding.generation && currentBinding.role === "controlling" &&
      currentBinding.tabId === tabId && current?.sessionFile === file && current.sessionId === sessionId &&
      current.availability === "live" && current.host?.pid === runtime.pid &&
      current.host.rpc?.childCreationTime === creationTime && current.ownership !== null &&
      current.ownership.releasedAt === null && current.ownership.ownerGeneration === committed.ownerGeneration &&
      currentCommitted !== null && bindingMatches(committed, currentCommitted) &&
      committed.pid === runtime.pid && committed.processCreation === creationTime &&
      committed.slot === runtime.identity.slot && committed.brokerId === runtime.identity.brokerId &&
      committed.brokerGeneration === runtime.identity.brokerGeneration && committed.sessionFile === file &&
      committed.sessionId === sessionId && chat.sessionOf(tabId) === session &&
      session.epoch.nonce === nativeNonce && session.sessionFile !== null && controlPathEquals(session.sessionFile, file) &&
      session.sessionId === sessionId && (!requireUnanswered || session.nativeStateUnanswered);
  };
  fenceSessionAdmission(index, state, true);
  try {
    const eligible = await index.lifecycle.run(tabId, async () => {
      const header = await readSessionFileHeader(file);
      return header?.sessionId === sessionId && sameTarget(true);
    });
    if (!eligible) { refuse("The saved conversation or controlling writer changed. Nothing was stopped."); return; }
    carried = await captureDraft(state);
    if (carried === null || !sameTarget(true)) {
      refuse("Restart could not capture this editor's complete input. Wait for pending image reads or edits to finish and try again; nothing was stopped.");
      return;
    }
    const captured = carried;
    const attachments = carried.reply.attachments + carried.reply.recoverable.reduce((count, original) => count + original.attachments, 0);
    const imageWarning = attachments === 0 ? "" : ` ${attachments} attachment reference${attachments === 1 ? "" : "s"} cannot be transferred; reattach the images to the preserved text after Restart.`;
    const consent = await vscode.window.showWarningMessage(
      "Stop this unresponsive OMP process and restart its saved conversation?",
      { modal: true, detail: "Unconfirmed input may already have been admitted; it will be preserved, not resent. Unsaved replies and in-flight tool effects may be lost. Commands or tools started by OMP may continue running separately and still modify files. The exact old process must be confirmed stopped before the same saved conversation is reopened." + imageWarning },
      "Restart",
    );
    if (consent !== "Restart") return;
    await index.lifecycle.run(tabId, async lease => {
      const header = await readSessionFileHeader(file);
      if (header?.sessionId !== sessionId || !sameTarget(true)) {
        refuse("The writer recovered or the editor or saved conversation changed while confirmation was open. Nothing was stopped.");
        return;
      }
      const broker = await attachBrokerClient();
      if (broker === null || !sameTarget(true)) { refuse("The captured writer's broker is unavailable. Nothing was stopped."); return; }
      stopRequested = true;
      const requested = await withSessionReadDeadline(stopRpcHost(runtime, "force"), 35_000);
      const stopped = await waitForManagedRootExit(runtime, broker, 5_000);
      log(`tab ${tabId}: explicit Restart stop: ${stopped.diagnosticDetail ?? stopped.detail}; request: ${requested.diagnosticDetail ?? requested.detail}`);
      if (!stopped.writerGone) {
        state.controlFailure = "The exact OMP process could not be confirmed stopped. No successor was started; your original input remains here. Use Stop Session before retrying.";
        refuse(state.controlFailure);
        return;
      }
      writerGone = true;
      if (!sameTarget(false)) { refuse("The captured process stopped, but this editor or saved binding changed. No successor was started."); return; }
      const owner = controlOwnerFor(runtime, committed.ownerGeneration);
      state.nativeWatch?.();
      state.nativeWatch = null;
      state.runtime = null;
      stopTerminalForTab(state.slotId);
      await releaseHostControl(context, tabId, owner);
      await retireBroker(tabId, runtime);
      chat.release(tabId);
      const saved = await readSessionFileHeader(file);
      if (saved?.sessionId !== sessionId) {
        await index.closeSession(tabId, { confirmedStopped: true, detail: "The exact saved conversation is unavailable after disposal; no successor was launched." }, lease);
        refuse("The exact saved conversation is unavailable after the process stopped. No successor was started; your input remains in this editor.");
        return;
      }
      draftRestores.set(state.slotId, captured);
      state.controlFailure = null;
      state.document = null;
      if (state.bridge !== null) await prepareBridgeDocument(context, state.bridge.editorId);
      renderPanelDocument(context, state.slotId);
      replacement = await index.replaceHost(tabId, { confirmedStopped: true, expectedPid: runtime.pid, expectedCreationTime: creationTime, mode: "chat", slotId: state.slotId, emptyFile: file, launcher: launcher(context, index) }, lease);
      if (replacement.status === "failed" && state.runtime === null) await index.closeSession(tabId, { confirmedStopped: true, detail: replacement.detail }, lease);
    });
    if (replacement !== null) await handleRestoreOutcome(context, index, tabId, replacement);
  } catch (error) {
    log(`tab ${tabId}: explicit Restart failed: ${messageOf(error)}`);
    state.controlFailure = writerGone
      ? "The old process stopped, but Restart could not finish. The saved conversation and captured input are kept; reopen this session to recover."
      : stopRequested
        ? "Restart could not confirm that the old process stopped. No successor was started; your input is kept. Use Stop Session to recover."
        : "Restart could not finish. Nothing was stopped; your input is kept.";
    refuse(state.controlFailure);
  } finally {
    if (carried !== null && state.document === document) {
      releaseCarriedDraft(carried);
      if (draftRestores.get(state.slotId) === carried) draftRestores.delete(state.slotId);
    }
    if (pendingSessionViewChanges.get(state) === modeRequest) pendingSessionViewChanges.delete(state);
    if (!stopRequested || writerGone || state.runtime !== runtime) fenceSessionAdmission(index, state, false);
    else pushSessionView(index, state);
    refreshGuestContext();
    refreshLauncher();
  }
}

// Restore

/**
 * Run the activation restore pass as a handoff the launcher's clicks wait on.
 *
 * The rows activation is responsible for are captured before the pass starts, and
 * its completion is retained over the whole pass — every reconcile, launch and
 * attach, plus the result it projects into the editors VS Code restored. A pass
 * that threw would otherwise leave a promise nobody could settle and an unhandled
 * rejection behind, so an escaped failure is logged and settles the handoff:
 * clicks then re-read the rows and panels the pass left and open normally, and a
 * startup failure is never read as evidence about ownership.
 *
 * ## The local recovery cohort
 *
 * The index is profile-wide now, so a row in it may belong to another workspace this
 * window has nothing to do with. Activation therefore restores only the rows *this*
 * window is responsible for: the conversations whose editor VS Code restored here,
 * and the rows this window already runs. Every other row stays visible in the
 * launcher and inert — the user opens it explicitly, which is the one action that
 * starts or adopts it. A stopped or explicitly released row keeps its own refusal
 * either way: the cohort decides *whose* row may be restored, never whether a
 * stopped row may start.
 *
 * A restored editor whose tab was not in the cohort when the pass started is not
 * abandoned: its own serializer path opens that tab, so it is re-derived from
 * current facts exactly as an explicit click is.
 */
function startStartupRestore(context: vscode.ExtensionContext, index: SessionIndex): void {
  const cohort = localRecoveryCohort(index);
  startupRestorePending = false;
  const settled = (async () => {
    try {
      await restoreTabs(context, index, cohort);
    } catch (error) {
      log(`restore: the startup pass failed: ${messageOf(error)}`);
    }
  })();
  startupRestore = { settled, cohort };
  // Rows the catalog adoption just published were derived before this pass existed, so a live
  // row of this window's cohort would keep saying "Blocked" until some later event: re-derive
  // them now, as "Restoring" for the length of the pass.
  refreshLauncher();
  void settled.then(() => {
    // The pass can no longer publish anything, so a later click only has to read
    // the panels it left behind.
    if (startupRestore?.settled === settled) startupRestore = null;
    // Rows that said "Restoring" for the length of the pass are re-derived now.
    refreshLauncher();
    // Start the full runtime proof now that the attach work is done, so the first launch
    // finds it ready. It is a readiness check only: no broker, host or session starts.
    void ptyGate?.client();
  });
}

/**
 * The rows this window is responsible for restoring at activation.
 *
 * Two things qualify a row: VS Code handed this window an editor for its
 * conversation (`editorMembership`/the serializer path bound a panel for it), or this
 * window already runs a host for it. Everything else in the profile-wide index is
 * another workspace's row: visible, and deliberately inert until the user opens it.
 */
function localRecoveryCohort(index: SessionIndex): ReadonlySet<string> {
  const cohort = new Set<string>();
  for (const entry of index.list()) {
    if (inLocalRecoveryCohort(index, entry.tabId)) cohort.add(entry.tabId);
  }
  return cohort;
}

/** Whether one row is this window's responsibility at activation (see {@link localRecoveryCohort}). */
function inLocalRecoveryCohort(index: SessionIndex, tabId: string): boolean {
  return index.hasLiveHost(tabId) || hasLocalEditorFor(tabId);
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
  if ((tabs.get(tabId)?.panel ?? null) !== null) return true;
  if (
    editorSlots
      .entries()
      .some(entry => entry.tabId === tabId && bridgeLiveEditors.has(entry.slotId))
  ) {
    return true;
  }
  return editorMembership().some(entry => (bridgeEditors.tabOfEditor(entry.editorId) ?? entry.tabId) === tabId);
}

// The profile catalog

/** This window's view of the profile catalog, built once at activation (ADR-0034). */
let catalogStore: CatalogStore | undefined;

/**
 * Resolves once the catalog has been read and the one-time import of the predecessor
 * build's folder list has settled.
 *
 * Editor restoration and commands consult it: VS Code may hand this window a restored
 * editor (or a command may arrive) before the catalog has been read, and resolving a
 * row against a not-yet-read catalog would report a stored session as gone. It
 * resolves even when the import failed, so nothing waits forever.
 */
let catalogReady: Promise<void> = Promise.resolve();

/** Context key telling the sidebar the catalog is still being read. */
const CATALOG_PENDING_CONTEXT = "omp.catalogPending";

/**
 * Build this window's view of the profile catalog.
 *
 * Every record key this extension owns is registered with the merge rule of the
 * module that owns its schema, so a whole-snapshot write from a stale window becomes
 * a delta against the newest committed revision instead of overwriting another
 * window's work.
 */
function createProfileCatalog(context: vscode.ExtensionContext): CatalogStore {
  return createCatalogStore({
    paths: catalogPaths(context.globalStorageUri.fsPath),
    mergers: {
      [SESSION_INDEX_STORAGE_KEY]: mergeSessionIndexRecords,
      [WORKSPACE_FOLDERS_STORAGE_KEY]: mergeWorkspaceFolderRecords,
      [BROKER_SLOTS_KEY]: mergeBrokerSlotRecords,
      [SHELL_SLOTS_KEY]: mergeShellSlotRecords,
    },
    onUnavailable: reason => {
      log(`the OMP profile catalog is unusable, so nothing will be saved this session: ${reason}`);
      showWarning(
        "The saved OMP sessions and folders could not be read, so this window is running without them and will not overwrite them. " +
          `See the OMP output channel. (${reason})`,
      );
    },
  });
}

/**
 * Import the predecessor build's folder list once, then let the shared catalog drive this window.
 *
 * The import runs before any startup restoration and before commands resolve their rows.
 * It reads the predecessor's catalog without touching it and commits only the registered
 * folder list together with a ledger entry ({@link importPredecessorFolders}).
 */
function startCatalogActivation(context: vscode.ExtensionContext, index: SessionIndex, folders: LauncherFolders, catalog: CatalogStore): void {
  const settled = (async () => {
    try {
      await importPredecessorFolders({
        store: catalog,
        storageDir: context.globalStorageUri.fsPath,
        log,
      });
    } catch (error) {
      log(`predecessor import: the pass failed and nothing was changed by it: ${messageOf(error)}`);
    }
    try {
      await adoptCatalogChanges(index, folders, { startup: true });
    } catch (error) {
      log(`catalog: the recovered records could not be adopted: ${messageOf(error)}`);
    }
    await vscode.commands.executeCommand("setContext", CATALOG_PENDING_CONTEXT, false);
    // Only now is the index complete: the pass restores exactly the rows this window
    // is responsible for, and a click on any other row is an explicit open.
    startStartupRestore(context, index);
    watchCatalogForWindow(index, folders);
  })();
  catalogReady = settled.then(
    () => undefined,
    () => undefined,
  );
}

/**
 * Wait until the catalog has been read, so a row resolved during activation is
 * resolved against everything this window can recover.
 */
async function ensureCatalogReady(): Promise<void> {
  await catalogReady;
}

/**
 * Adopt whichever records another window committed since this window last read.
 *
 * The catalog's revision — not this window's cached projection — decides what
 * changed, so a missed watcher event costs a refresh rather than correctness. This
 * restores nothing and launches nothing: adopting another window's rows only makes
 * them visible here, and their ownership is proven exactly as before when the user
 * opens one.
 */
async function adoptCatalogChanges(
  index: SessionIndex,
  folders: LauncherFolders,
  options: { readonly startup?: boolean } = {},
): Promise<void> {
  const catalog = catalogStore;
  if (catalog === undefined) return;
  // A foreign revision is read from disk; this window's *own* commit already advanced the
  // projection, and its consumers may still hold the snapshot their change was derived
  // from. Adopting either way is what keeps a derived delta honest: a merged-in record
  // must reach the consumer before that consumer's next write, or its next delta would
  // read as a deliberate removal of the other window's row.
  await catalog.refresh();
  claimFileNames.clear();
  // The small stores cache their own projection, so a foreign revision must drop it
  // before the next read: a stale broker table would send an attach to a transport
  // another window has already moved.
  brokerSlots?.reload();
  shellSlots?.reload();
  const adopted = await index.refreshFromStore();
  // A durable role is what authorizes this window's editor, so a demotion another window
  // committed (or this window recorded for another slot) must reach the local registry
  // and therefore the bridge/pipeline eligibility of the affected editor.
  reconcileLocalRoles(index);
  const foldersChanged = await folders.reload();
  if (adopted.adopted.length > 0 || adopted.removed.length > 0 || foldersChanged || options.startup === true) {
    log(
      `catalog: adopted ${adopted.adopted.length} new row(s), dropped ${adopted.removed.length}, ` +
        `kept ${adopted.kept.length} in use${foldersChanged ? ", and the folder list changed" : ""}`,
    );
  }
  refreshLauncher();
}

/**
 * Watch the catalog so another window's write is visible here without a restart.
 *
 * The watcher is a hint: it never restores, launches, claims or stops anything, and a
 * failure to watch only costs a refresh on the next focus or explicit refresh.
 */
function watchCatalogForWindow(index: SessionIndex, folders: LauncherFolders): void {
  const catalog = catalogStore;
  if (catalog === undefined) return;
  const notify = (): void => {
    void adoptCatalogChanges(index, folders).catch(error => log(`catalog: another window's change could not be adopted: ${messageOf(error)}`));
  };
  // The watcher reports *other* windows' commits; this window's own commits publish the
  // same signal through the store, so a record another window's change was merged into
  // reaches the consumer that owns it before that consumer writes again.
  const unsubscribe = catalog.onChange(notify);
  activationContext?.subscriptions.push({ dispose: unsubscribe });
  const dispose = startCatalogWatch(catalog.paths, notify, { onError: detail => log(detail) });
  activationContext?.subscriptions.push({ dispose });
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
  context: vscode.ExtensionContext,
  index: SessionIndex,
  cohort: ReadonlySet<string>,
): Promise<void> {
  if (cohort.size === 0) {
    refreshLauncher();
    return;
  }
  // VS Code may have restored editors before this pass ran: each is shown the saved history
  // of its session from disk while its host is reconciled, launched or attached, so the
  // transcript is on screen at once and never waits for a process.
  for (const tabId of cohort) {
    const entry = index.get(tabId);
    if (entry === null || entry.sessionFile === null || chat.kindOf(tabId) === "live") continue;
    if ((stateOf(tabId)?.panel ?? null) === null) continue;
    void chat
      .showViewOnly(tabId, { file: entry.sessionFile, cwd: entry.cwd, title: entry.title, reason: "Restoring the session…", phase: "resyncing" })
      .then(() => {
        if (chat.kindOf(tabId) === "view-only") attachChatRoutes(tabId, true);
      });
  }

  let report: RestoreReport;
  try {
    // Only the rows this window is responsible for: an automatic pass never re-derives a row
    // another workspace put in the shared index. Nothing waits on any other process or
    // service: each row is reconciled against its own broker slot.
    report = await index.restoreAll({ reconciler, launcher: launcher(context, index), only: cohort });
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
  for (const tabId of cohort) await electLocalController(index, tabId);
  projectRestoreReport(index, report);
  refreshLauncher();
  void revealActiveSession(index);

  log(
    `restore: ${report.restored.length} running, ${report.attached.length} already open, ` +
      `${report.drafts.length} draft, ${report.stopped.length} stopped, ${report.conflicts.length} conflict, ` +
      `${report.failures.length} failed, ${report.skipped.length} skipped`,
  );
  for (const conflict of report.conflicts) {
    log(`restore conflict (${conflict.kind}) on tab ${conflict.tabId}: ${conflict.detail}`);
  }
  for (const failure of report.failures) {
    log(`restore failure (${failure.kind}) on tab ${failure.tabId}: ${failure.detail}`);
  }
  if (report.persistError !== null) {
    showWarning(`The OMP session index could not be saved: ${report.persistError}`);
  }
}

async function handleRestoreOutcome(
  context: vscode.ExtensionContext,
  index: SessionIndex,
  tabId: string,
  outcome: RestoreOutcome,
): Promise<void> {
  // The launcher shows this outcome until the next attempt, so a refused or
  // failed open stays visible after the notification is gone.
  outcomes.set(tabId, outcome);
  refreshLauncher();
  switch (outcome.status) {
    case "restored":
      log(`tab ${tabId}: OMP host running`);
      // The election comes first: a page is only served the conversation when it is the
      // controlling editor here. The conversation itself was attached by the launch.
      await electLocalController(index, tabId);
      attachChatRoutes(tabId, true);
      return;
    case "attached":
      log(`tab ${tabId}: ${outcome.detail}`);
      await electLocalController(index, tabId);
      attachChatRoutes(tabId, true);
      return;
    case "skipped":
      log(`tab ${tabId}: skipped: ${outcome.detail}`);
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
      log(`tab ${tabId}: draft tab restored without a process`);
      presentUnavailable(index, tabId, DRAFT_NO_HOST_DETAIL);
      return;
    case "stopped":
      // The row stays exactly as the user left it. A restored editor for it shows its saved
      // history and why nothing was started.
      log(`tab ${tabId}: stopped by its durable run intent; nothing was started or attached`);
      presentUnavailable(index, tabId, outcome.detail);
      return;
    case "conflict": {
      log(`tab ${tabId}: conflict (${outcome.kind}): ${outcome.detail}`);
      presentConflict(index, tabId, outcome.detail);
      showError(`${CONFLICT_LABEL[outcome.kind]}. ${outcome.detail}`);
      return;
    }
    case "failed":
      log(`tab ${tabId}: failed (${outcome.kind}): ${outcome.detail}`);
      presentUnavailable(index, tabId, outcome.detail);
      showError(`The OMP session could not be started: ${outcome.detail}`);
      return;
  }
}

/** Present a positively verified writer; a legacy writer remains explicitly stoppable. */
function presentConflict(index: SessionIndex, tabId: string, detail: string): void {
  const entry = index.get(tabId);
  if (entry !== null && entry.host !== null && !isManagedHost(entry.host)) {
    chat.showLegacy(tabId, { cwd: entry.cwd, title: entry.title, reason: detail });
    attachChatRoutes(tabId, true);
    return;
  }
  presentUnavailable(index, tabId, detail, "blocked");
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
      log(`tab ${tabId}: its editor-slot role could not be published (${messageOf(error)})`);
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
  for (const entry of editorSlots.entries()) {
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
  for (const entry of editorSlots.entries()) {
    if (entry.tabId !== tabId) continue;
    if ((tabs.get(entry.slotId)?.panel ?? null) !== null) return entry.slotId;
  }
  const state = tabs.get(tabId);
  return state !== undefined && state.panel !== null ? state.slotId : null;
}

/** A document can be prepared while this editor's link to the extension is still being set up. */
const BRIDGE_PENDING_DETAIL =
  "This tab is still connecting to OMP. It will fill in on its own in a moment.";
const GUEST_UNAVAILABLE_DETAIL =
  "OMP could not connect this tab to its session. Details are in the OMP output channel.";
/** Shown by a restored panel for a draft that no explicit action has started yet. */
const DRAFT_NO_HOST_DETAIL =
  "This OMP session has not been started yet. Its tab was kept; click the session's row in the OMP Sessions view to start it.";
/** Shown by a restored editor whose persisted identity is not one this window wrote. */
const UNIDENTIFIED_PANEL_DETAIL =
  "VS Code restored this tab, but OMP does not recognize which session it belonged to, so nothing was opened. " +
  "Close this tab and open the session you want from the OMP Sessions view.";
/** Shown by a legacy editor that lost this tab to an editor already serving it. */
const LEGACY_DUPLICATE_DETAIL =
  "Another tab for this OMP session is already open in this window, so this old tab was left as a note instead of " +
  "starting a second copy. Close this tab and use the one already open.";

/** Shown by a restored editor whose identity names a row this workspace no longer has. */
const STALE_PANEL_DETAIL =
  "VS Code restored this tab for a session that is no longer in the OMP Sessions view, so nothing was opened. " +
  "Close this tab and start the session from the OMP Sessions view.";

/**
 * Create this tab's editor, or bring the one it already has to the front.
 *
 * Creation is the explicit-intent path. VS Code revives the editors the user
 * actually had open through {@link serializerFor}, which adopts the panel it
 * supplies; this function is for a row the user just asked to open, and it is
 * called *before* any native work so the chat surface appears
 * immediately and has somewhere to report whatever happens next.
 */
function openPanel(
  context: vscode.ExtensionContext,
  index: SessionIndex,
  tabId: string,
): void {
  const state = tabState(tabId);
  if (state.panel !== null) {
    // An explicit Open joins the editor this tab already has — including one that is
    // waiting on a legacy migration — instead of starting a second one.
    state.panel.reveal();
    return;
  }
  // A surviving bridged page is already this editor, even without a panel handle.
  // Resume must serve its existing route, not create a second editor.
  if (state.bridge?.documentId != null && bridgeLiveEditors.has(state.bridge.editorId)) return;
  // The winner of this tab's editors is decided synchronously, before any await: a
  // restored editor's callback that arrives later must lose against this transient
  // panel only if the saved editor is the one the user's layout names, which is the
  // rule `EditorCoordinator` owns.
  const editorId = createToken();
  const reservation = bridgeEditors.reserve({ tabId, editorId, provenance: "transient", sequence: ++editorEventSequence });
  if (reservation.outcome === "lost") {
    // VS Code restored this tab's editor but has not revived it, because it was never shown.
    // That editor is the one to show: opening a rival would be the duplicate chat this
    // reservation exists to prevent.
    if (editorTabOf(reservation.reservation.editorId) !== null) {
      void reviveEditorPanel(index, tabId).then(({ selected }) => {
        if (!selected) showWarning("That OMP session is open in a tab VS Code could not bring to the front. Select its tab in the editor.");
      });
      return;
    }
    showWarning("That OMP session is already open in this window.");
    refreshLauncher();
    return;
  }
  const ownEditorId = reservation.reservation.editorId;
  const viewType = bridgeViewType(tabId, ownEditorId);
  registerBridgeSerializer(context, index, viewType);
  // The tab is named for the session it shows, from the same rule its launcher row
  // uses, so it is never a second copy of the working folder's name. The row is
  // already known here — this path is a row's own Open — and its cached title is
  // what a first frame can use without waiting; binding below then applies the
  // exact stored name and the icon.
  const entry = index.get(tabId);
  const panel = vscode.window.createWebviewPanel(
    viewType,
    entry === null ? "OMP session" : sessionHeadline(entry, null),
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
    },
  );
  bindPanel(context, index, ownEditorId, tabId, panel, "created");
  void setActiveTab(index, tabId);
  // The endpoint, the document and its exact port are provisioned *after* the panel
  // exists but before a guest document is installed: the panel first shows a bounded
  // explanation, then the guest document whose `connect-src` names the port this
  // editor actually holds.
  void (async () => {
    const prepared = await prepareBridgeDocument(context, ownEditorId);
    if (tabs.get(ownEditorId)?.panel !== panel) return;
    if (prepared === null) {
      // No bridge endpoint means this editor cannot be reconnected to after a
      // host-only restart — and nothing more. The chat, the composer and every
      // panel-served control keep working, so the panel is rendered without a bridge
      // rather than being left on an explanation.
      log(`slot ${ownEditorId}: this editor has no bridge endpoint (${bridgeEndpoints.get(ownEditorId)?.failure ?? "unknown"})`);
      const current = tabs.get(ownEditorId);
      if (current !== undefined) current.bridge = null;
      renderPanelDocument(context, ownEditorId);
      return;
    }
    renderPanelDocument(context, ownEditorId);
  })();
}

/**
 * Bind one editor panel to one indexed conversation, and give it a document it can
 * render.
 *
 * This is the single place a panel becomes a chat surface, so an editor VS Code
 * restored and one this window created get the same listeners, the same disposal
 * rules and the same document for the state the editor is actually in. The editor
 * slot is the identity; the conversation is only what that slot shows right now.
 *
 * Every listener is guarded by the exact panel it was registered for: a panel
 * that a restored editor replaced must never clear its successor's readiness,
 * activity or recording, or answer a message meant for it.
 */
function bindPanel(
  context: vscode.ExtensionContext,
  index: SessionIndex,
  slot: string,
  conversation: string,
  panel: vscode.WebviewPanel,
  origin: "created" | "restored",
  role: EditorSlotRole = "controlling",
): void {
  // The editor's own record. A conversation that was launched or restored before its
  // editor existed has its record moved under this editor's immutable key here, so
  // from now on nothing in this window reaches this editor by conversation alone.
  // A panel publishes itself as a passive surface first: the local election follows the
  // durable one, so an editor can never act as a controller on a role this window has not
  // recorded. A controlling role is promoted below, once the index has recorded it.
  const state = bindSlotToConversation(
    slot,
    conversation,
    "passive",
    role === "passive" ? PASSIVE_REASON_DEFAULT : ELECTING_REASON,
  );
  if (origin === "restored") state.mode = state.runtime?.kind ?? index.slotBinding(slot)?.mode ?? defaultSessionMode(context);
  // The durable binding is what a later restore resolves its conversation *and* its
  // role from, so it is written as soon as the editor becomes a chat surface. A
  // controlling binding demotes its rivals durably; a passive one only records this
  // editor's own non-controlling role.
  // This election is tracked: a command the page sends before it settles waits for it
  // (`dispatchSlotMessage`) instead of being judged on the interim passive answer.
  void trackElection(
    slot,
    index
      .bindEditorSlot(slot, conversation, role)
      .then(async binding => {
        if (state.tabId !== conversation || index.slotBinding(slot)?.tabId !== conversation) return;
        // The index decides the role: `controlling` requires proof that this window holds
        // the conversation's writer, so a refusal is published locally as the passive
        // surface it really is, and nothing here demotes another window's controller.
        // The answer is only this editor's if it names this editor's conversation: a failed
        // election can report the binding of another conversation, and granting control on
        // that would publish an authority the shared record does not hold.
        if (binding.role === "controlling" && binding.tabId === conversation) {
          bindSlotToConversation(slot, conversation, "controlling", null);
          applySlotAuthority(slot);
        } else {
          bindSlotToConversation(slot, conversation, "passive", binding.roleRefusal ?? PASSIVE_REASON_DEFAULT);
          applySlotAuthority(slot);
          log(`slot ${slot}: this editor is not controlling ${conversation} (${binding.roleRefusal ?? "no reason reported"})`);
        }
        // The view mode is only bookkeeping for a later restore. It is recorded *after* the role
        // is published: it costs another durable write, and the editor must not stay
        // passive for the length of it.
        await index.setEditorMode(slot, state.mode);
      })
      .catch(error => log(`slot ${slot}: its editor-slot binding could not be persisted (${messageOf(error)})`)),
  );
  state.panel = panel;
  if (state.runtime?.kind === "terminal") ensureTerminalPipeline(index, slot, state.runtime.handle);
  state.origin = origin;
  // The tab now says what this editor shows. This is the one place a chat panel
  // becomes a surface, and a restored editor carries no icon and may carry a name
  // from before the last rename, so the appearance is applied to every panel bound
  // here — created, restored or migrated.
  void applyChatTabAppearance(context, index, slot);
  const boundEditorId = state.bridge?.editorId ?? null;
  if (boundEditorId !== null) void adoptBridgeEditor(context, slot, panel);
  state.document = null;
  if (origin === "restored") {
    // VS Code hands back a panel, not this extension's creation options, and no
    // extension API exposes them afterwards. A restored editor is therefore told
    // here that it may run scripts and load this extension's own media, before its
    // document is set: without `enableScripts` the guest bundle would never run,
    // and a document assigned before the options would be reloaded.
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
    };
  }
  registerPanelLifecycle(index, slot, panel);
  // The document is chosen and set synchronously, so an editor VS Code restored
  // renders at once and a panel whose bridge endpoint is not ready says so instead of
  // waiting blank while the endpoint is bound.
  renderPanelDocument(context, slot);
  refreshLauncher();
  for (const resolve of panelBindWaiters.get(slot) ?? []) resolve();
}

/**
 * Point one bound panel at the document its tab's state calls for: the guest
 * bundle with the bridge endpoint this tab holds, else a bounded,
 * non-connecting explanation of what is missing.
 *
 * The document is rebuilt only when what it shows actually changes (usually from the
 * explanation to the guest once its bridge endpoint exists), because assigning
 * `webview.html` reloads the panel: a live guest is never reloaded for nothing, and a
 * panel that already shows the explanation is not re-rendered with the same text. A new
 * document must announce itself (`omp:ready`) before the conversation is posted into
 * it, so readiness is tracked per document rather than per tab.
 */
function renderPanelDocument(context: vscode.ExtensionContext, key: string): void {
  // A folder shell has its own document and its own serializer; it is not a chat.
  const state = stateOf(key);
  if (state === undefined || state.tabId === null || !isSessionTab(state.slotId)) return;
  const conversation = state.tabId;
  if (state.panel === null) return;
  const panel = state.panel;
  panel.iconPath = vscode.Uri.joinPath(context.extensionUri, state.mode === "terminal" ? "media/terminal-icon.svg" : EDITOR_TAB_ICON);
  // The document's persisted identity is the editor's *original* (T, E) namespace,
  // which never changes: the viewType encodes it, and a restored editor resolves the
  // conversation it serves now from the durable slot binding. What the page is *shown*
  // comes from the link the host delivers, not from this identity. This panel's own
  // view type is that namespace, so the identity a document persists is exactly the pair
  // VS Code will hand back to this editor's serializer — the recorded endpoint, the
  // current conversation and the slot key are only fallbacks for a type that cannot be
  // read.
  const panelIdentity = tabInputIdentity(panel.viewType);
  const identityTabId = panelIdentity?.tabId ?? state.bridge?.endpoint.scope.tabId ?? conversation;
  // The bridge ticket is what makes this document reachable again after a host-only
  // restart, so a guest document is only rendered once its endpoint and exact port
  // exist: a document without them would come back as an orphan with no route.
  const ticket = bridgeTicketFacts(state.slotId);
  // A bridged editor is only rendered once its endpoint and exact port exist, because
  // the document's `connect-src` must name the listener this host actually holds. An
  // editor with no bridge at all still gets its chat: the bridge is what makes the page
  // *survive* a restart, not what makes the chat work.
  const awaitingBridge = state.bridge !== null && ticket === null;
  let html: string | null = null;
  if (!awaitingBridge) {
    try {
      html = createGuestHtml(panel.webview, context.extensionUri, identityTabId, ticket, state.mode);
    } catch (error) {
      // The document is built from this extension's own inputs, so a failure is a defect
      // rather than an input: it is logged and the panel keeps an honest document instead
      // of a broken one with a weaker CSP.
      log(`slot ${state.slotId}: the panel document could not be built: ${messageOf(error)}`);
    }
  }
  let updatedOnDisk = false;
  if (html !== null && packageChangedOnDisk()) {
    // A page that is already loaded came from the build this host runs, and it stays valid. Only a
    // document that would be built now reads the replaced bundle, so only that one is withheld.
    if (state.document !== null && state.document.kind === "guest" && state.document.bridgeDocumentId === (ticket?.documentId ?? null)) return;
    html = null;
    updatedOnDisk = true;
  }
  const kind: PanelDocument["kind"] = html === null ? "unavailable" : "guest";
  const bridgeDocumentId = ticket?.documentId ?? null;
  if (state.document !== null && state.document.kind === kind && state.document.bridgeDocumentId === bridgeDocumentId) return;
  forgetTerminalCopy(state);
  state.document = { kind, bridgeDocumentId };
  // A fallback page must persist the identity its own view type names — the tab (T)
  // *and* the actual editor id (E) — so a document left by a pending bridge cannot make
  // this editor unidentifiable at its next restart. Both documents of an editor therefore
  // save the same state.
  panel.webview.html = html ?? createUnavailableGuestHtml(
    awaitingBridge ? BRIDGE_PENDING_DETAIL : updatedOnDisk ? UPDATED_ON_DISK_DETAIL : GUEST_UNAVAILABLE_DETAIL,
    { tabId: identityTabId, editorId: panelIdentity?.editorIdHex ?? state.slotId },
  );
  refreshGuestContext();
  if (kind === "guest") {
    // A freshly installed guest document is a new incarnation: the host offers this
    // document's route over the panel handle it holds, and dispatch waits for the
    // page's acknowledgement.
    offerBridgeRoute(state.slotId);
  }
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
  const first = bridgeEditors.reserve({ tabId: conversation, editorId: slot, provenance, sequence: ++editorEventSequence });
  if (first.outcome !== "lost") return first;
  const incumbent = first.reservation.editorId;
  if (index.slotBinding(slot)?.role !== "controlling" || index.slotBinding(incumbent)?.role !== "passive") return first;
  bridgeEditors.releaseEditor(incumbent);
  return bridgeEditors.reserve({ tabId: conversation, editorId: slot, provenance, sequence: ++editorEventSequence });
}

/**
 * The serializer VS Code revives this window's OMP editors through.
 *
 * The state it is handed was written by that editor's own previous document (see
 * `src/webview/panel-identity.ts`) and is treated as untrusted: it is narrowed to
 * the exact identity shape and then resolved against the current index, so a
 * malformed, stale or foreign value can never attach an editor to another
 * session's row — and a row this workspace no longer has leaves an explanatory
 * editor rather than a new index entry, a guessed session or a host.
 *
 * Nothing native starts here, and nothing here waits for a bridge endpoint: the supplied
 * panel is adopted first, with a document it can render. The activation pass owns
 * the one restore attempt per row, and this editor either projects that attempt's
 * result or waits for the ordinary open path — which is why an explicit Open
 * still starts an eligible draft's host even though its editor is already back.
 */
/**
 * The serializer of one dynamic versioned view type.
 *
 * The registered type, the saved state and the actual editor must agree before
 * anything is adopted: the type names `(T, E)`, the saved state is
 * `{version:2, tabId, editorId}`, and only a matching pair is this editor's own
 * revival. A mismatch leaves an explanatory editor rather than guessing an identity —
 * deserialized state is untrusted input, and a wrong guess would attach an editor to
 * another session's row. The single exception is the legacy version-1 state an
 * earlier build's document left on this type, which is accepted only when this
 * editor's own view type *and* its durable controlling binding prove the same pair
 * (`recoveredBridgePanelState`).
 *
 * Adoption re-uses whatever this window already knows about the tab: the endpoint,
 * the document and the native attempt all belong to the tab, so a reloaded editor
 * takes over a *new* document incarnation rather than starting a second attempt.
 */
function bridgeSerializerFor(
  context: vscode.ExtensionContext,
  index: SessionIndex,
  viewType: string,
): vscode.WebviewPanelSerializer {
  return {
    async deserializeWebviewPanel(panel, state): Promise<void> {
      const identity = decodeBridgeViewType(viewType);
      // VS Code hands back an editor's title but no icon, and an editor it restores
      // may end below as a bounded explanation rather than a chat. The icon is what
      // makes such a tab recognizable as an OMP editor, so it is applied before any
      // decision; a chat panel's binding re-affirms it with its own document.
      panel.iconPath ??= vscode.Uri.joinPath(context.extensionUri, EDITOR_TAB_ICON);
      // VS Code may hand this window a restored editor before the profile catalog has
      // been read. Resolving the row now would report a stored session as gone and leave
      // the editor as an explanation, so the restoration waits for that one pass to
      // settle. The wait is the catalog's own promise, so it can only be short and it
      // always settles.
      await ensureCatalogReady();
      // A dynamic editor's own document saves `{version:2, tabId, editorId}`. An
      // *earlier* build's fallback document — the explanation a panel shows while it
      // has no bridge endpoint — saved the version-1 chat identity on this same type, so that
      // editor's state named a tab but no longer said which editor it is and every
      // later restart refused it. Such a state is recovered only when the editor's own
      // viewType and its durable binding both prove the same (T, E) pair; nothing is
      // guessed for a foreign, passive or mismatched editor.
      const stored = persistedBridgeState(state);
      const saved = stored ?? recoveredBridgePanelState(viewType, state, editorId => index.slotBinding(editorId));
      if (
        identity === null ||
        saved === null ||
        saved.tabId.toLowerCase() !== identity.tabId.toLowerCase() ||
        saved.editorId !== identity.editorIdHex
      ) {
        panel.webview.html = createUnavailableGuestHtml(UNIDENTIFIED_PANEL_DETAIL);
        if (stored === null && persistedTabId(state) !== null) {
          log(
            "a restored OMP editor carried a legacy version-1 identity that its view type and durable controlling binding do not prove; it was left as an explanation",
          );
        } else {
          log("a restored OMP editor carried no usable bridge identity; it was left as an explanation");
        }
        return;
      }
      if (stored === null) {
        log(
          `slot ${saved.editorId.slice(0, 8)}: a legacy version-1 identity was adopted because this editor's view type and durable controlling binding proved it`,
        );
      }
      const namespaceTabId = identity.tabId;
      const slot = identity.editorIdHex;
      // The viewType names the editor's original (T, E) namespace. Which conversation
      // it serves *now* is the durable binding's answer, not the namespace's: after a
      // settled switch the same editor serves another conversation, and the original
      // T must not select anything.
      const committed = index.slotBinding(slot);
      const conversation = committed === null || index.get(committed.tabId) === null ? namespaceTabId : committed.tabId;
      if (index.get(conversation) === null) {
        panel.webview.html = createUnavailableGuestHtml(STALE_PANEL_DETAIL);
        log("a restored OMP editor named a tab this workspace no longer has; it was left as an explanation");
        return;
      }
      const reservation = reserveSlotForConversation(index, conversation, slot, "saved");
      if (reservation.outcome === "lost") {
        // Another editor of this conversation holds it: this one is a duplicate of a
        // session that is already open, and a second chat for one session is what the
        // one-winner rule exists to prevent.
        log(`slot ${slot}: a second restored webview for this conversation was closed`);
        panel.dispose();
        showInfo("An OMP editor restored for this window was closed: it was a duplicate of one already open for the same session.");
        return;
      }
      const superseded = reservation.outcome === "replaced" ? tabs.get(conversation)?.panel ?? null : null;
      const carriedDraft = await carryDraftFrom(superseded);
      try {
        bindPanel(context, index, slot, conversation, panel, "restored", committed?.role ?? "controlling");
        if (carriedDraft !== null) draftRestores.set(slot, carriedDraft);
        superseded?.dispose();
      } finally {
        releaseCarriedDraft(carriedDraft);
      }
      // A reload recreates the editor and a fresh HTML document. Reuse its
      // native attempt while replacing only the prior document incarnation.
      const adopted = await adoptBridgeEditor(context, slot, panel);
      const prepared = adopted ? await prepareBridgeDocument(context, slot) : null;
      if (tabs.get(slot)?.panel === panel && bridgeEditors.holdsEditor(slot)) {
        if (prepared === null) {
          // A bridge failure must not strand a restored chat on the placeholder.
          // It cannot survive a host-only restart without a ticket, but the
          // ordinary panel route still carries its conversation.
          const current = tabs.get(slot);
          if (current?.bridge?.editorId === slot) current.bridge = null;
          log(`slot ${slot}: restored editor has no reconnect bridge; serving its chat through the panel`);
        }
        renderPanelDocument(context, slot);
      }
      // Only a panel VS Code actually made active describes the user's selection, so
      // the index follows that and nothing here reveals, moves or focuses a restored
      // editor: its saved position and group are already its own.
      if (panel.active) {
        if (startupRestore === null && !startupRestorePending) requestSessionRowExpand(conversation);
        await setActiveTab(index, conversation);
      }
      replayPanelOutcome(index, conversation);
      // The activation pass restores only the rows this window is responsible for. A
      // restored editor for any *other* row in the profile-wide index is this window's
      // own editor for a conversation nobody has opened here yet, so it takes the same
      // path an explicit click takes: one native attempt for that tab, re-derived from
      // current ownership rather than from the pass's cohort. A tab the pass does cover
      // is left to it, and a tab that already has a runtime is already connected.
      await openRestoredTabIfUncovered(context, index, conversation);
    },
  };
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
  if (index.hasLiveHost(tabId)) {
    // Already connected here: only the election may still be missing for this editor.
    await electLocalController(index, tabId);
    return;
  }
  const startup = startupRestore;
  if (startup !== null && startup.cohort.has(tabId)) return;
  await openTab(context, index, tabId, "opened", "restored");
}

/**
 * The legacy serializer: the one-time migration of a generic panel.
 *
 * A version-1 panel cannot change its view type in place, so its first resolution
 * creates one versioned successor in the source's own view column, binds that
 * successor *before* intentionally disposing only the exact supplied panel, and
 * re-uses the tab's existing native attempt. The winner is reserved synchronously,
 * so a second saved callback for the same tab loses rather than producing a second
 * editor, and the migration itself is claimed once per tab.
 */
function legacySerializerFor(
  context: vscode.ExtensionContext,
  index: SessionIndex,
): vscode.WebviewPanelSerializer {
  return {
    async deserializeWebviewPanel(panel, state): Promise<void> {
      const tabId = persistedTabId(state);
      // As in the versioned serializer: a restored editor arrives with a title but no
      // icon, and one that ends as an explanation here is still an OMP editor tab.
      panel.iconPath ??= vscode.Uri.joinPath(context.extensionUri, EDITOR_TAB_ICON);
      // This serializer resolves the same index the versioned one does, so it waits for
      // the same barrier: a legacy panel must not be declared stale before the catalog
      // has been read.
      await ensureCatalogReady();
      if (tabId === null) {
        panel.webview.html = createUnavailableGuestHtml(UNIDENTIFIED_PANEL_DETAIL);
        log("a restored OMP editor carried no usable panel identity; it was left as an explanation");
        return;
      }
      const entry = index.get(tabId);
      if (entry === null) {
        panel.webview.html = createUnavailableGuestHtml(STALE_PANEL_DETAIL);
        log("a restored OMP editor named a tab this workspace no longer has; it was left as an explanation");
        return;
      }
      // This panel is this tab's editor until its successor replaces it — and it stays
      // as the bounded explanation when the tab is already served elsewhere — so its own
      // restored title is corrected here too: an older build titled it with the working
      // folder, and the successor is given the same name below.
      const tabTitle = sessionHeadline(entry, null);
      panel.title = tabTitle;
      // A legacy panel is a *different* editor from a versioned one, so it is
      // reserved as such: the reservation decides synchronously whether this panel
      // may create the one successor or whether another editor already owns the tab.
      const editorId = createToken();
      const reservation = reserveSlotForConversation(index, tabId, editorId, "saved");
      if (reservation.outcome === "lost") {
        // Another editor of this conversation already serves it. This legacy panel
        // keeps its editor and shows the bounded explanation: creating a successor
        // would be a second chat for one session.
        // This legacy panel keeps the version-1 identity the static type persists, so a
        // later restart still restores it (and the legacy serializer accepts that state).
        panel.webview.html = createUnavailableGuestHtml(LEGACY_DUPLICATE_DETAIL, { tabId, editorId: null });
        log(`tab ${tabId}: a legacy panel was left as an explanation because another editor already owns this conversation`);
        return;
      }
      const ownEditorId = reservation.reservation.editorId;
      const ticket = bridgeEditors.claimTransition(tabId, ownEditorId);
      if (ticket === null) {
        panel.webview.html = createUnavailableGuestHtml(LEGACY_DUPLICATE_DETAIL, { tabId, editorId: null });
        log(`tab ${tabId}: a legacy migration is already running for this tab`);
        return;
      }
      const previousPanel = tabs.get(tabId)?.panel ?? null;
      if (previousPanel !== null && previousPanel !== panel) {
        // A transient panel an explicit open created is standing for this tab. The
        // editor VS Code restored wins — it is the one the user's own layout names —
        // and the transient panel is retired without releasing anything native: the
        // tab keeps its runtime, its claim and its in-flight restore.
        log(`tab ${tabId}: a restored webview replaced the panel an explicit open had created`);
      }
      const viewType = bridgeViewType(tabId, ownEditorId);
      registerBridgeSerializer(context, index, viewType);
      // The successor is created in the source panel's own view column, and a source
      // that is not focused keeps the focus: the migration must not move the user.
      const successor = vscode.window.createWebviewPanel(
        viewType,
        tabTitle,
        { viewColumn: panel.viewColumn ?? vscode.ViewColumn.Active, preserveFocus: !panel.active },
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
        },
      );
      const carriedDraft = previousPanel !== null && previousPanel !== panel ? await carryDraftFrom(previousPanel) : null;
      try {
        bindPanel(context, index, ownEditorId, tabId, successor, "restored");
        if (carriedDraft !== null) draftRestores.set(ownEditorId, carriedDraft);
        // Only the exact supplied panel is disposed, and only after its successor is
        // bound: the predecessor's close must not be read as this tab's editor closing.
        panel.dispose();
        if (previousPanel !== null && previousPanel !== panel && previousPanel !== successor) previousPanel.dispose();
      } finally {
        releaseCarriedDraft(carriedDraft);
      }
      bridgeEditors.settleTransition(tabId, ownEditorId, ticket);
      const prepared = await prepareBridgeDocument(context, ownEditorId);
      if (tabs.get(ownEditorId)?.panel === successor && bridgeEditors.holdsEditor(ownEditorId)) {
        if (prepared === null) {
          const current = tabs.get(ownEditorId);
          if (current?.bridge?.editorId === ownEditorId) current.bridge = null;
          log(`slot ${ownEditorId}: migrated editor has no reconnect bridge; serving its chat through the panel`);
        }
        renderPanelDocument(context, ownEditorId);
      }
      log(`tab ${tabId}: a legacy editor was migrated onto a versioned successor`);
      // Only a panel VS Code actually made active describes the user's selection,
      // so the index follows that and nothing here reveals, moves or focuses a
      // restored editor: its saved position and group are already its own.
      if (panel.active) await setActiveTab(index, tabId);
      // Deserialization is lazy, so this callback can arrive long after the native
      // side settled: the last outcome is replayed rather than assumed delivered.
      replayPanelOutcome(index, tabId);
    },
  };
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
  if (chat.has(tabId)) {
    attachChatRoutes(tabId);
    return;
  }
  const outcome = outcomes.get(tabId) ?? null;
  if (outcome !== null && outcome.status !== "restored" && outcome.status !== "attached" && outcome.status !== "skipped") {
    presentRestoreOutcome(index, tabId, outcome);
    return;
  }
  const entry = index.get(tabId);
  if (entry === null) return;
  if (entry.sessionFile !== null) {
    void chat
      .showViewOnly(tabId, { file: entry.sessionFile, cwd: entry.cwd, title: entry.title, reason: "Restoring the session…", phase: "resyncing" })
      .then(() => {
        if (chat.kindOf(tabId) === "view-only") attachChatRoutes(tabId, true);
      });
    return;
  }
  presentUnavailable(index, tabId, DRAFT_NO_HOST_DETAIL);
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
  for (const failure of report.failures) presentUnavailable(index, failure.tabId, failure.detail);
  for (const draft of report.drafts) presentUnavailable(index, draft.tabId, DRAFT_NO_HOST_DETAIL);
  for (const stopped of report.stopped) presentUnavailable(index, stopped.tabId, stopped.detail);
}

async function setActiveTab(index: SessionIndex, tabId: string): Promise<void> {
  try {
    await index.setActiveTab(tabId);
  } catch (error) {
    log(`tab ${tabId}: could not record the active tab: ${messageOf(error)}`);
  }
}

/** The chat commands a page sends; each is deduplicated by its own request id in the conversation. */
const CHAT_COMMAND_TYPES: ReadonlySet<string> = new Set([
  "omp:chat-prompt",
  "omp:chat-steer",
  "omp:chat-follow-up",
  "omp:chat-abort",
  "omp:chat-ui-response",
  "omp:chat-load-older",
  "omp:chat-resume",
  "omp:chat-reconnect",
  "omp:chat-restart",
  "omp:chat-queue-remove",
  "omp:chat-tool-detail",
  "omp:chat-subagent-read",
  "omp:chat-navigate",
]);

/** How long one document is given to hand its unsent draft over before it is replaced. */
const DRAFT_CAPTURE_TIMEOUT_MS = 1_500;

/** A reply must belong to the exact source editor and document, not just its id. */
const draftCaptures = new Map<number, { source: TabState; panel: vscode.WebviewPanel; document: TabState["document"]; settle(reply: GuestDraftReplyMessage | null): void }>();
let draftCaptureSeq = 0;

/**
 * Drafts captured from a replaced document, waiting for its successor to be ready.
 *
 * The draft is transient by construction: it lives in memory only, is never written to
 * Webview state, is never logged and remains held until the replacement acknowledges it.
 */
interface CarriedDraft {
  reply: GuestDraftReplyMessage;
  source: TabState;
  panel: vscode.WebviewPanel;
  document: TabState["document"];
  restoredDocument: TabState["document"];
}
const draftRestores = new Map<string, CarriedDraft>();

/**
 * Ask one editor's page for its unsent composer draft (ADR-0025's bounded handoff): the old
 * document is the only thing that holds the text, so it is asked and its answer is what makes
 * replacing it honest. Silence within the bound is "not captured" — the host never claims to
 * have preserved text it never received.
 */
async function captureDraft(source: TabState): Promise<CarriedDraft | null> {
  const panel = source.panel;
  if (panel === null || source.document?.kind !== "guest") return null;
  const document = source.document;
  const requestId = ++draftCaptureSeq;
  const { promise, resolve } = Promise.withResolvers<GuestDraftReplyMessage | null>();
  draftCaptures.set(requestId, { source, panel, document, settle: resolve });
  const timer = setTimeout(() => {
    if (draftCaptures.delete(requestId)) resolve(null);
  }, DRAFT_CAPTURE_TIMEOUT_MS);
  let captured = false;
  try {
    if (!await panel.webview.postMessage({ type: "omp:draft-request", requestId } satisfies GuestDraftRequestMessage)) resolve(null);
    const reply = await promise;
    if (reply === null || !reply.captured || source.document !== document || source.panel !== panel) return null;
    captured = true;
    return { reply, source, panel, document, restoredDocument: null };
  } finally {
    clearTimeout(timer);
    draftCaptures.delete(requestId);
    if (!captured) void panel.webview.postMessage({ type: "omp:draft-release", requestId } satisfies GuestHostMessage);
  }
}

/** Cancel only the source capture; an already-replaced document has nothing to unlock. */
function releaseCarriedDraft(carried: CarriedDraft | null): void {
  if (carried === null || carried.source.panel !== carried.panel || carried.source.document !== carried.document) return;
  void carried.panel.webview.postMessage({ type: "omp:draft-release", requestId: carried.reply.requestId } satisfies GuestHostMessage);
}

/**
 * The unsent draft of a panel that is about to be replaced by another editor of the same
 * conversation, or `null` when there is none. A panel that shows no live chat document has no
 * composer to ask; a page that does not answer is reported rather than silently emptied.
 */
async function carryDraftFrom(previous: vscode.WebviewPanel | null): Promise<CarriedDraft | null> {
  if (previous === null) return null;
  let owner: TabState | undefined;
  for (const state of tabs.values()) if (state.panel === previous) { owner = state; break; }
  if (owner === undefined || owner.mode !== "chat" || owner.document?.kind !== "guest") return null;
  const carried = await captureDraft(owner);
  if (carried === null) {
    showWarning("This editor's complete unsent input could not be captured before the editor was replaced, so it was not preserved.");
    return null;
  }
  const attachments = carried.reply.attachments + carried.reply.recoverable.reduce((sum, entry) => sum + entry.attachments, 0);
  if (attachments > 0) showInfo(`${attachments} image${attachments === 1 ? "" : "s"} could not be carried to the replacement document. Their text is preserved; reattach them before sending.`);
  return carried;
}

/**
 * Show a page the saved history of its session while nothing serves it yet.
 *
 * A restored page can announce itself before its host is re-adopted — re-adoption first
 * proves the broker runtime, which takes seconds — and disk history needs no process. When
 * no conversation exists for the tab and the row has a session file, the page is given the
 * read-only history at once; the live conversation replaces it when the host attaches.
 */
function paintSavedHistory(index: SessionIndex, tabId: string): void {
  const entry = index.get(tabId);
  if (stateOf(tabId)?.mode !== "chat" || entry === null || entry.sessionFile === null || chat.kindOf(tabId) !== null) return;
  void chat
    .showViewOnly(tabId, { file: entry.sessionFile, cwd: entry.cwd, title: entry.title, reason: "Restoring the session…", phase: "resyncing" })
    .then(() => {
      if (chat.kindOf(tabId) === "view-only") attachChatRoutes(tabId, true);
    });
}

function replyChatSendResult(tabId: string, message: ChatWebviewMessage, page: ChatPage, outcome: ChatCommandOutcome): void {
  if (message.type !== "omp:chat-prompt" && message.type !== "omp:chat-steer" && message.type !== "omp:chat-follow-up") return;
  const epoch = chat.stateOf(tabId)?.epoch;
  if (epoch === undefined) return;
  page.post({
    type: "omp:chat-send-result",
    epoch,
    requestId: message.requestId,
    status: outcome === "accepted" ? "accepted" : outcome === "explained" ? "explained" : outcome === "unconfirmed" ? "unconfirmed" : "refused",
  });
}

/**
 * Run one chat command through the conversation and record what became of it.
 *
 * A stop, or any command the conversation did not accept, is written to the output channel:
 * the page's own notice is what the user sees, but the log is what proves whether the
 * command ever reached the session.
 */
async function runChatCommand(tabId: string, message: ChatWebviewMessage, page: ChatPage): Promise<ChatCommandOutcome> {
  let outcome: ChatCommandOutcome;
  try {
    outcome = await chat.handleMessage(tabId, message, page);
  } catch (error) {
    if (message.type !== "omp:chat-prompt" && message.type !== "omp:chat-steer" && message.type !== "omp:chat-follow-up") throw error;
    outcome = "unconfirmed";
  }
  replyChatSendResult(tabId, message, page, outcome);
  if (outcome === "accepted" && (message.type === "omp:chat-prompt" || message.type === "omp:chat-steer" || message.type === "omp:chat-follow-up")) {
    rememberPrompt(message.text);
  }
  if (outcome !== "accepted" || message.type === "omp:chat-abort") {
    log(`tab ${tabId}: ${message.type} ${message.requestId.slice(0, 8)} was ${outcome}`);
  }
  return outcome;
}

/**
 * Close the detail tabs a previous host lifetime left behind. A webview of an unregistered view
 * type is never revived, so without this sweep it would remain as a dead tab.
 */
async function closeLeftoverDetailTabs(): Promise<void> {
  const leftovers: vscode.Tab[] = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const viewType = tab.input instanceof vscode.TabInputWebview ? tab.input.viewType : null;
      if (viewType === DETAIL_VIEW_TYPE || viewType === `${TAB_INPUT_VIEW_TYPE_PREFIX}${DETAIL_VIEW_TYPE}`) leftovers.push(tab);
    }
  }
  if (leftovers.length > 0) await vscode.window.tabGroups.close(leftovers, true);
}

/**
 * Open, or reveal, one detail tab of the conversation an editor shows. Presentation only, so a
 * passive editor may ask too; the conversation comes from the sending editor, never the message.
 */
function openDetailTab(tabId: string, mode: "chat" | "terminal", request: GuestOpenDetailMessage): void {
  // A terminal editor and a legacy tab have no conversation page to show: nothing would arrive.
  if (mode === "terminal" || chat.kindOf(tabId) === "legacy") return;
  const target: DetailTarget = request.kind === "agent" ? { kind: "agent", agentId: request.agentId } : { kind: request.kind };
  const outcome = detailTabs.open(tabId, target);
  log(`tab ${tabId}: detail tab ${target.kind} was ${outcome}`);
}

/**
 * Guest messages are untrusted UI input. The panel may send chat commands and request one
 * of the explicitly bounded host-control actions, but it cannot supply a pipe identity, a
 * ledger id or a target session: every command is answered for the conversation this
 * editor slot serves now, against the host-owned session.
 *
 * `omp:ready` is the page's "I am listening" signal — sent by a fresh document after its
 * client is attached — and is what makes the host (re)send the conversation's state and an
 * authoritative snapshot, so a reloaded document never has to guess what it missed.
 */
async function handleGuestMessage(
  index: SessionIndex,
  slot: string,
  panel: vscode.WebviewPanel,
  message: unknown,
): Promise<void> {
  // Addressed by the immutable editor slot: what the editor shows is resolved here, at
  // dispatch, so a listener registered earlier still answers for the conversation the
  // editor serves now.
  const own = tabs.get(slot);
  if (own === undefined || own.panel !== panel || own.tabId === null) return;
  const tabId = own.tabId;
  const parsed = parseGuestWebviewMessage(message);
  if (!parsed) {
    log(`slot ${slot}: ignored an unrecognized guest message`);
    return;
  }
  // The bounded draft handoff's own answer. It authorizes nothing and is answered before
  // every other gate, because the request is made to this very document precisely when it is
  // about to be replaced.
  if (parsed.type === "omp:draft-reply") {
    const pending = draftCaptures.get(parsed.requestId);
    if (pending?.source === own && pending.panel === panel && pending.document === own.document) pending.settle(parsed);
    return;
  }
  if (parsed.type === "omp:draft-restored") {
    const carried = draftRestores.get(slot);
    if (carried?.reply.requestId === parsed.requestId && carried.restoredDocument === own.document) draftRestores.delete(slot);
    return;
  }
  if (parsed.type === "omp:terminal-copy-reply") {
    await acceptTerminalCopy(own, parsed);
    return;
  }
  if (parsed.type === "omp:session-mode") {
    if (activationContext !== undefined) await switchSessionMode(activationContext, index, own, parsed.mode);
    return;
  }
  if (parsed.type === "omp:open-detail") {
    openDetailTab(tabId, own.mode, parsed);
    return;
  }
  // File links are presentation in either mode: the Chat validates and opens the same file references as the Terminal.
  if (TERMINAL_PANEL_TYPES[parsed.type] === true && (own.mode === "terminal" || parsed.type === "omp:terminal-link-validate" || parsed.type === "omp:terminal-link-open")) {
    await handleTerminalGuestMessage(slot, parsed, parsed as unknown as Record<string, unknown>);
    return;
  }
  if (CHAT_COMMAND_TYPES.has(parsed.type)) {
    await runChatCommand(tabId, parsed as ChatWebviewMessage, panelChatPage(own, panel));
    return;
  }
  switch (parsed.type) {
    case "omp:route-ack": {
      const state = stateOf(tabId);
      const route = bridgeRouteOf(tabId);
      if (state === undefined || state.panel !== panel || route === null) return;
      if (encodeHex(bridgeHostGeneration) !== parsed.hostGeneration || state.bridge?.documentId !== parsed.documentId) {
        log(`tab ${tabId}: a route acknowledgement named another host generation or document`);
        return;
      }
      const alreadyAcknowledged = route.acknowledged;
      if (!route.acknowledge(parsed.routeGeneration, "panel")) {
        log(`tab ${tabId}: a route acknowledgement named a fenced generation`);
        return;
      }
      // Repeated delivery is valid, but an ACK of the ready-status offer must not
      // trigger another identical offer and an unbounded panel round trip.
      if (alreadyAcknowledged) return;
      diagnostics.note(tabId, `bridge: route ${parsed.routeGeneration.slice(0, 8)} acknowledged over panel`);
      pushBridgeRouteOffer(tabId);
      return;
    }
    case "omp:bridge-ack": {
      const state = stateOf(tabId);
      const bridge = state?.bridge ?? null;
      if (state === undefined || state.panel !== panel || bridge === null) return;
      if (encodeHex(bridgeHostGeneration) !== parsed.hostGeneration || bridge.documentId !== parsed.documentId) return;
      const recorded = bridge.endpoint.committedBindingHash();
      if (recorded === null || recorded !== parsed.bindingHash) {
        log(`tab ${tabId}: a bridge acknowledgement named a binding this host did not commit`);
        return;
      }
      bridge.bound = true;
      log(`tab ${tabId}: the panel acknowledged its bridge secret`);
      diagnostics.note(tabId, `bridge: the panel acknowledged the secret for document ${bridge.documentId?.slice(0, 8) ?? "unknown"}`);
      refreshBridgeReadiness(tabId);
      return;
    }
    case "omp:ready": {
      if (parsed.protocolVersion !== GUEST_PROTOCOL_VERSION) {
        log(`tab ${tabId}: guest protocol ${parsed.protocolVersion} != ${GUEST_PROTOCOL_VERSION}; the conversation was not sent`);
        showError(
          "The chat panel and extension are using different versions. Run Developer: Reload Window, then try again.",
        );
        return;
      }
      if (parsed.documentId !== undefined && parsed.editorId !== undefined && parsed.bootstrapId !== undefined && parsed.origin !== undefined) {
        own.heldReadyReport = null;
        pinBridgeOrigin(tabId, panel, { documentId: parsed.documentId, bootstrapId: parsed.bootstrapId, origin: parsed.origin });
        // A page that announces itself again is re-sent the *same* secret when its
        // document is already committed: the delivery is the one step that can be lost in
        // transit, and rotating the secret would break a connection the page already holds.
        void redeliverBridgeBinding(tabId);
      }
      pushSessionView(index, own, true);
      noteReadyDocument(own, parsed.documentId);
      activateNativeEditor(own);
      // The document proves it can receive: it is sent the conversation, always fresh.
      attachChatRoute(slot, true);
      paintSavedHistory(index, tabId);
      // A document that replaced another one receives the draft this host captured from its
      // predecessor. It is put back, never sent, and only once.
      const carried = draftRestores.get(slot);
      if (own.mode === "chat" && own.document?.kind === "guest" && carried !== undefined &&
          (own.document !== carried.document || panel !== carried.panel)) {
        carried.restoredDocument = own.document;
        const { requestId, text, attachments, recoverable } = carried.reply;
        void panel.webview.postMessage({ type: "omp:draft-restore", requestId, text, attachments, recoverable } satisfies GuestDraftRestoreMessage);
      }
      return;
    }
    case "omp:composer-popup":
      if (parsed.open) composerPopupTabs.add(tabId);
      else composerPopupTabs.delete(tabId);
      refreshGuestContext();
      return;
    case "omp:complete-files": {
      const state = stateOf(tabId);
      const cwd = state?.runtime?.cwd ?? index.get(tabId)?.cwd ?? null;
      if (state?.panel !== panel || cwd === null) return;
      const paths = await findFileMentions(parsed.query, {
        cwd,
        findFiles: (include, exclude, maxResults) => vscode.workspace.findFiles(include, exclude, maxResults),
      });
      if (stateOf(tabId)?.panel !== panel) return;
      const reply: GuestFileCompletionsMessage = {
        type: "omp:file-completions",
        requestId: parsed.requestId,
        paths,
      };
      void panel.webview.postMessage(reply);
      return;
    }
    case "omp:control-request":
      await handleGuestControlRequest(index, tabId, parsed, panelResponder(tabId, panel, parsed.actionSeq));
      return;
    case "omp:chat-command":
      if (activationContext !== undefined) await runChatAction(activationContext, index, tabId, parsed.command);
      return;
    default:
      // The terminal vocabulary belongs to the folder shell, never to a chat editor.
      log(`slot ${slot}: ignored a ${parsed.type} message from a chat editor`);
      return;
  }
}

/**
 * Show why a tab has no live conversation: a session with a file shows its saved history
 * read-only with the reason; a draft that never got a file shows the reason alone.
 */
function presentUnavailable(index: SessionIndex, tabId: string, reason: string, phase: "view-only" | "blocked" = "view-only"): void {
  const entry = index.get(tabId);
  if (entry === null) return;
  void chat
    .showViewOnly(tabId, { file: entry.sessionFile, cwd: entry.cwd, title: entry.title, reason, phase })
    .then(() => attachChatRoutes(tabId, true));
}

/**
 * Tell one panel that the host-control facts it last read are stale.
 *
 * A panel asks for its model/thinking and tool state when it mounts and when the user hits
 * Refresh — none of which change when the authenticated channel or the exact session file
 * becomes available a moment later. Nothing is pushed here but the invalidation: the panel
 * answers with its own correlated snapshot request, and only a request this window can
 * attribute to that panel is answered.
 */
function invalidateGuestControls(tabId: string): void {
  const state = stateOf(tabId);
  const panel = state?.panel ?? null;
  const message: GuestControlInvalidateMessage = { type: "omp:control-invalidate" };
  if (panel !== null) void panel.webview.postMessage(message);
  // An orphan has no panel handle: its invalidation travels the route it does have.
  const route = bridgeRouteOf(tabId);
  const bridge = state?.bridge ?? null;
  if (panel === null && route !== null && bridge !== null && bridge.documentId !== null) {
    bridge.endpoint.invalidateRoute(bridge.documentId, route.routeGeneration);
  }
}

// The reconnecting bridge (ADR-0023)
//
// One listener per actual editor, one document per HTML incarnation, one route per
// document, and one admission ledger per document. The extension owns policy — who
// may act, and whose native checks pass right now — while `src/host/bridge-*` owns
// the listener, the records, the route state machine and the admission rules.

/** Resolve this window's workspace hash and its durable bridge records. */
async function bridgeHost(context: vscode.ExtensionContext): Promise<{ readonly workspace: string; readonly records: BridgeRecords }> {
  if (bridgeWorkspace !== null && bridgeStore !== null) return { workspace: bridgeWorkspace, records: bridgeStore };
  const folders = (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath);
  const workspaceFile = vscode.workspace.workspaceFile?.fsPath ?? null;
  const workspace = encodeHex(await sha256(new TextEncoder().encode(workspaceIdentityText(folders, workspaceFile))));
  bridgeWorkspace = workspace;
  bridgeStore = new BridgeRecords({
    root: path.join(context.globalStorageUri.fsPath, "bridge", "v1"),
    secrets: context.secrets,
  });
  return { workspace, records: bridgeStore };
}

/** The identity of one editor under the workspace hash its own records are filed under, or `null` when it is not one this bridge minted. */
function bridgeScope(workspace: string, tabId: string, editorId: string): BridgeRecordScope | null {
  if (!isPanelTabId(tabId) || !/^[0-9a-f]{32}$/.test(editorId)) return null;
  return { workspace, tabId, editorId };
}

/**
 * The editors this window's *actual* VS Code membership contains.
 *
 * The tab input's view type is the authority: a stored secret, an index row or a
 * saved state can be stale, but a tab input that exists right now means the editor
 * exists right now. The installed workbench prefixes webview inputs, which
 * `tabInputIdentity` unwraps; a type outside this namespace is not ours.
 */
function editorMembership(): { readonly tabId: string; readonly editorId: string }[] {
  const found: { tabId: string; editorId: string }[] = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input;
      const viewType = input instanceof vscode.TabInputWebview ? input.viewType : null;
      const identity = viewType === null ? null : tabInputIdentity(viewType);
      if (identity !== null) found.push({ tabId: identity.tabId, editorId: identity.editorIdHex });
    }
  }
  return found;
}

/** Register one dynamic type's serializer, once per activation. */
function registerBridgeSerializer(context: vscode.ExtensionContext, index: SessionIndex, viewType: string): void {
  if (bridgeSerializerTypes.has(viewType)) return;
  bridgeSerializerTypes.add(viewType);
  context.subscriptions.push(vscode.window.registerWebviewPanelSerializer(viewType, bridgeSerializerFor(context, index, viewType)));
}

/** The endpoint of one editor, or `null` when this window does not serve it. */
function bridgeEndpointOf(editorId: string): BridgeEditorEndpoint | null {
  return bridgeEndpoints.get(editorId) ?? null;
}

/**
 * Whether one document of one editor may still act.
 *
 * Every answer is re-derived from live window state — the winning editor of the
 * tab, actual editor membership, and the document this host currently serves — so a
 * record, a secret or a socket can never authorize anything by itself.
 */
function bridgeDocumentEligible(editorId: string, documentId: string): boolean {
  // A non-controlling editor is never eligible for a bridge route: it must not be
  // able to reconnect and act after another editor took the conversation.
  if (passiveReasonForSlot(editorId) !== null) return false;
  const state = tabs.get(editorId);
  if (state === undefined || state.tabId === null || state.bridge === null || state.bridge.editorId !== editorId) return false;
  if (state.bridge.documentId !== documentId) return false;
  if (indexForBridge !== null && indexForBridge.get(state.tabId) === null) return false;
  // A panel handle for this exact document is the strongest fact; without one the
  // editor must still be in real VS Code membership, which is what a surviving page
  // after a host-only restart has.
  return state.panel !== null || bridgeLiveEditors.has(editorId);
}

/** The session index this activation created, for the bridge's own eligibility checks. */
let indexForBridge: SessionIndex | null = null;

/**
 * Create — or adopt — the endpoint of one actual editor.
 *
 * Binds its exact recorded port (an ephemeral one only for an editor this window
 * has never recorded), then hands back the endpoint. A port that cannot be bound is
 * reported as a bounded failure and no route is offered for that editor.
 */
async function ensureBridgeEndpoint(
  context: vscode.ExtensionContext,
  tabId: string,
  editorId: string,
): Promise<BridgeEditorEndpoint | null> {
  const existing = bridgeEndpointOf(editorId);
  if (existing !== null) return existing;
  const pending = pendingBridgeEndpoints.get(editorId);
  if (pending !== undefined) return pending;
  const creation = (async (): Promise<BridgeEditorEndpoint | null> => {
    const host = await bridgeHost(context);
    // An editor keeps the workspace hash its records were minted under even when the
    // window's own hash has since changed (a folder was opened or closed): that hash is
    // what its surviving page presents, so recomputing it would orphan the page.
    if (bridgeScope(host.workspace, tabId, editorId) === null) return null;
    const scope = bridgeScope(await host.records.homeWorkspace(tabId, editorId, host.workspace), tabId, editorId);
    if (scope === null) return null;
    const endpoint = new BridgeEditorEndpoint({
      records: host.records,
      scope,
      hostGeneration: bridgeHostGeneration,
      eligible: documentId => bridgeDocumentEligible(editorId, documentId),
      onRequest: (session, documentId, request) => handleBridgeRequest(editorId, documentId, session, request),
      onStateChanged: (documentId, state) => {
        log(`tab ${tabId}: bridge document ${documentId.slice(0, 8)} is ${state}`);
        diagnostics.note(tabId, `bridge: document ${documentId.slice(0, 8)} is ${state}`);
        // A surviving page becomes reachable (or stops being) as its route state moves.
        attachChatRoute(editorId);
        refreshLauncher();
      },
      onDiagnostic: (code, detail) => {
        log(`tab ${tabId}: bridge ${code} — ${detail}`);
        diagnostics.note(tabId, `bridge: ${code}`);
      },
    });
    const port = await endpoint.bind();
    if (port === null) {
      log(`tab ${tabId}: the bridge listener could not bind (${endpoint.failure ?? "unknown"})`);
      endpoint.close();
      return null;
    }
    bridgeEndpoints.set(editorId, endpoint);
    log(`tab ${tabId}: bridge listener bound on 127.0.0.1:${port} for editor ${editorId.slice(0, 8)}`);
    return endpoint;
  })();
  pendingBridgeEndpoints.set(editorId, creation);
  try {
    return await creation;
  } finally {
    if (pendingBridgeEndpoints.get(editorId) === creation) pendingBridgeEndpoints.delete(editorId);
  }
}

/**
 * Prepare the document this tab's panel is about to render.
 *
 * Mints a fresh document incarnation `D` and its bootstrap id, retires the previous
 * document's credential and binds the editor's exact port — all *before* the HTML
 * exists, so a panel is never rendered for a listener that does not exist and a
 * page's `connect-src` never names a port nobody is holding.
 */
async function prepareBridgeDocument(
  context: vscode.ExtensionContext,
  editorId: string,
): Promise<{ readonly endpoint: BridgeEditorEndpoint; readonly documentId: string; readonly bootstrapId: string; readonly port: number } | null> {
  const state = tabs.get(editorId);
  // The endpoint's own recorded namespace wins: an editor keeps the (T, E) namespace its
  // listener was bound under, so a slot whose reservation was released (a passive
  // newcomer whose destination belongs to another editor) is never given a second
  // endpoint under another conversation.
  const known = state?.bridge?.endpoint.scope.tabId ?? null;
  const namespaceTabId = known ?? bridgeEditors.tabOfEditor(editorId) ?? null;
  // A *passive* slot may still provision: it must be able to retire the document that
  // was authorized for the conversation it no longer serves, and it can act on nothing.
  const mayProvision =
    state !== undefined && namespaceTabId !== null && (bridgeEditors.holdsEditor(editorId) || passiveReasonForSlot(editorId) !== null);
  if (!mayProvision) return null;
  const endpoint = await ensureBridgeEndpoint(context, namespaceTabId, editorId);
  if (endpoint === null) return null;
  const documentId = createToken();
  const bootstrapId = createToken();
  const document = await endpoint.beginDocument(documentId, bootstrapId);
  const port = endpoint.port;
  if (document === null || port === null) {
    log(`slot ${editorId}: this editor's bridge document could not be prepared`);
    return null;
  }
  if (tabs.get(editorId) !== state || !bridgeEditors.holdsEditor(editorId)) {
    await endpoint.retireDocument(documentId);
    return null;
  }
  // Preparation and panel adoption share the endpoint but can finish in either
  // order. The document itself must publish its ticket even if adoption is
  // still returning from the same single-flight bind.
  if (state.bridge === null || state.bridge.editorId !== editorId || state.bridge.endpoint !== endpoint) {
    state.bridge = { editorId, endpoint, documentId, bound: false };
  } else {
    state.bridge.documentId = documentId;
    state.bridge.bound = false;
  }
  bridgeEditors.noteDocument(editorId, editorId, documentId);
  return { endpoint, documentId, bootstrapId, port };
}

/**
 * Adopt one actual editor into this window's live state.
 *
 * The endpoint is created — and its exact port bound — if this activation does not
 * already have one, the tab's bridge entry is pointed at it, and the editor is
 * registered as present in this window's real membership: that membership is what
 * authorizes a surviving page's handshake when this host holds no panel handle for it.
 */
async function adoptBridgeEditor(
  context: vscode.ExtensionContext,
  slot: string,
  panel: vscode.WebviewPanel | null,
): Promise<boolean> {
  const state = tabState(slot);
  const namespaceTabId = bridgeEditors.tabOfEditor(slot) ?? state.tabId ?? null;
  if (namespaceTabId === null || !bridgeEditors.holdsEditor(slot)) return false;
  const endpoint = await ensureBridgeEndpoint(context, namespaceTabId, slot);
  if (endpoint === null || !bridgeEditors.holdsEditor(slot)) return false;
  const existing = state.bridge;
  if (existing === null || existing.editorId !== slot || existing.endpoint !== endpoint) {
    state.bridge = { editorId: slot, endpoint, documentId: null, bound: false };
  }
  bridgeLiveEditors.add(slot);
  if (panel !== null) endpoint.panelBound();
  return true;
}

/**
 * Reconcile this window's editors with VS Code's own membership.
 *
 * Called at activation — before any asynchronous native work — and again whenever the
 * tab set changes. Two things come out of it: every *recognized* dynamic type gets a
 * serializer (so a later reload can restore that editor), and every editor whose page
 * may still be running is adopted with its recorded document and origin, so a
 * surviving page's reconnect has something to authenticate against. A stale type (an
 * indexed id this workspace no longer has) gets its serializer too, and its resolver
 * explains itself without starting any native work.
 */
async function syncBridgeEditors(
  context: vscode.ExtensionContext,
  index: SessionIndex,
  options: { readonly retireMissing?: boolean } = {},
): Promise<void> {
  const membership = editorMembership();
  const present = new Set(membership.map(entry => entry.editorId));
  for (const editorId of [...bridgeLiveEditors]) {
    if (present.has(editorId)) continue;
    bridgeLiveEditors.delete(editorId);
    // Only a *change* in the tab set retires an editor: the activation pass runs
    // before this window has necessarily listed every editor it restored, and
    // forgetting a page that is still running would destroy the credential it needs.
    if (options.retireMissing !== true) continue;
    retireClosedBridgeEditor(editorId);
  }
  for (const entry of membership) {
    registerBridgeSerializer(context, index, bridgeViewType(entry.tabId, entry.editorId));
    bridgeLiveEditors.add(entry.editorId);
    // The viewType names the editor's *original* (T, E) namespace, which never
    // changes. Which conversation the editor serves now is the editor
    // coordinator's reservation for it: after a settled switch that is the new conversation, and
    // the original T no longer selects anything.
    const served = bridgeEditors.tabOfEditor(entry.editorId);
    // Only the elected editor may own this conversation's endpoint; a duplicate
    // actual Webview input is still observed, but never gets a native route or secret.
    if (served === null) {
      const elected = reserveSlotForConversation(index, entry.tabId, entry.editorId, "saved");
      if (elected.outcome === "lost") continue;
    }
    const conversation = bridgeEditors.tabOfEditor(entry.editorId) ?? entry.tabId;
    if (index.get(conversation) === null) continue;
    const state = tabs.get(entry.editorId);
    if (state !== undefined && state.bridge?.editorId === entry.editorId && state.bridge.documentId !== null) continue;
    const endpoint = await ensureBridgeEndpoint(context, entry.tabId, entry.editorId);
    if (endpoint === null) continue;
    if (!bridgeEditors.holdsEditor(entry.editorId)) {
      await endpoint.forget();
      bridgeEndpoints.delete(entry.editorId);
      continue;
    }
    // A host re-adopted before this editor was adopted lives in the conversation's own
    // record (nothing named an editor for it yet). The editor that serves the conversation
    // takes that record — its runtime, control channel and counters — so the bridge's
    // native-readiness check finds the running host under the editor's key.
    const held = tabs.get(entry.editorId) === undefined ? tabs.get(conversation) : undefined;
    if (held !== undefined && held.slotId !== entry.editorId && held.panel === null) {
      tabs.delete(held.slotId);
      editorSlots.remove(held.slotId);
      held.slotId = entry.editorId;
      held.tabId = conversation;
      tabs.set(entry.editorId, held);
    }
    const current = tabState(entry.editorId);
    if (current.tabId === null) current.tabId = conversation;
    if (current.panel === null) current.mode = current.runtime?.kind ?? index.slotBinding(entry.editorId)?.mode ?? defaultSessionMode(context);
    if (current.bridge === null || current.bridge.editorId !== entry.editorId) {
      current.bridge = { editorId: entry.editorId, endpoint, documentId: null, bound: false };
    }
    if (current.panel !== null) {
      // This window holds the panel handle, so the panel is this document's route and
      // its document is provisioned when it renders.
      endpoint.panelBound();
      continue;
    }
    const adopted = await endpoint.adoptRecordedDocument();
    if (!bridgeEditors.holdsEditor(entry.editorId) || current.bridge?.endpoint !== endpoint) continue;
    if (adopted === null) continue;
    diagnostics.note(entry.editorId, `bridge: adopted surviving document ${adopted.documentId.slice(0, 8)} for editor ${entry.editorId.slice(0, 8)}`);
    current.bridge.documentId = adopted.documentId;
    bridgeEditors.noteDocument(entry.editorId, entry.editorId, adopted.documentId);
    endpoint.offerBridge();
    refreshBridgeReadiness(entry.editorId);
    log(`slot ${entry.editorId}: adopted surviving bridge document ${adopted.documentId.slice(0, 8)}`);
    refreshLauncher();
  }
}

/** The bridge ticket facts one rendered document carries. */
interface BridgeTicketFacts {
  readonly editorId: string;
  readonly documentId: string;
  readonly bootstrapId: string;
  readonly port: number;
}

/** The ticket of the document this tab's panel currently shows, or `null`. */
function bridgeTicketFacts(tabId: string): BridgeTicketFacts | null {
  const state = stateOf(tabId);
  const bridge = state?.bridge ?? null;
  if (bridge === null || bridge.documentId === null) return null;
  const endpoint = bridge.endpoint;
  const document = endpoint.document;
  const port = endpoint.port;
  if (document === null || document.documentId !== bridge.documentId || port === null) return null;
  return { editorId: bridge.editorId, documentId: bridge.documentId, bootstrapId: document.bootstrapId, port };
}

/**
 * Pin the Origin a page reported over the panel route.
 *
 * The report is only honored when it names the exact document this host currently
 * serves, which is what keeps a late message from an older document from pinning
 * an origin for a newer one. The origin itself is validated as a canonical
 * non-opaque Webview origin by the endpoint; a report for another document, or an
 * origin this bridge does not accept, is refused rather than normalised.
 */
function pinBridgeOrigin(tabId: string, panel: vscode.WebviewPanel, report: { readonly documentId: string; readonly bootstrapId: string; readonly origin: string }): void {
  const state = stateOf(tabId);
  const bridge = state?.bridge ?? null;
  if (state === undefined || bridge === null || state.panel !== panel) return;
  if (bridge.documentId !== report.documentId) {
    log(`tab ${tabId}: an origin report named a document this host no longer serves`);
    return;
  }
  const document = bridge.endpoint.document;
  if (document === null || document.bootstrapId !== report.bootstrapId) {
    log(`tab ${tabId}: an origin report named a bootstrap this host did not mint`);
    return;
  }
  if (!bridge.endpoint.pinOrigin(report.documentId, report.origin)) return;
  log(`tab ${tabId}: bridge origin pinned for document ${report.documentId.slice(0, 8)}`);
  void commitBridgeDocument(tabId);
}

/**
 * Apply the origin report a page made while its editor was not yet controlling.
 *
 * Returns `true` when a held report was consumed (the pin, and with it the commit, ran); the
 * caller then has nothing left to commit itself. Nothing is applied while the editor is still
 * passive or has no panel, so the passive gate keeps its meaning: it only decides *when* the
 * report the page already made is honored.
 */
function replayHeldReadyReport(state: TabState): boolean {
  const held = state.heldReadyReport;
  if (held === null || state.panel === null || state.tabId === null) return false;
  if (passiveReasonForSlot(state.slotId) !== null) return false;
  state.heldReadyReport = null;
  pinBridgeOrigin(state.tabId, state.panel, held);
  void redeliverBridgeBinding(state.tabId);
  return true;
}

/** The chat-host binding this window can verify for one tab right now, or `null`. */
function liveBridgeBinding(tabId: string): BridgeNativeBinding | null {
  const state = stateOf(tabId);
  const table = indexForBridge;
  if (state === undefined || state.tabId === null || table === null) return null;
  const runtime = state.runtime;
  // The binding is the *current* conversation's: the endpoint's namespace T never
  // selects chat authority again after the editor serves another conversation.
  const entry = table.get(state.tabId);
  if (runtime === null || entry === null) return null;
  const session = chat.sessionOf(state.tabId);
  if (runtime.kind === "chat" && (session === null || session.phase !== "live")) return null;
  if (runtime.kind === "terminal" && (!state.control || !isOpenControlClient(state.control.client) || runtime.observed?.available !== true || runtime.observed.sessionId !== entry.sessionId || runtime.observed.sessionFile === null || entry.sessionFile === null || !controlPathEquals(runtime.observed.sessionFile, entry.sessionFile))) return null;
  if (entry.availability !== "live" || entry.ownership === null || entry.ownership.releasedAt !== null) return null;
  if (entry.host?.pid !== runtime.pid) return null;
  // Only an exactly identified conversation is bound: a new session's file is learned
  // from the process itself, and binding before that would fix an identity that changes.
  if (entry.sessionFile === null || runtime.identity.childCreationTime === null) return null;
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

/**
 * Commit this tab's document against the chat-host binding, once.
 *
 * The commit is what makes the document able to authenticate at all, so it happens
 * only when the Origin is pinned *and* the chat host is verified: a live conversation
 * whose owner, broker slot, child identity and session file all agree. No
 * secret is delivered before that, and the descriptor written here is what a
 * surviving page's handshake is checked against after a restart.
 */
async function commitBridgeDocument(tabId: string): Promise<void> {
  const state = stateOf(tabId);
  const bridge = state?.bridge ?? null;
  if (state === undefined || bridge === null) return;
  if (replayHeldReadyReport(state)) return;
  if (bridge.documentId === null || bridge.bound) return;
  const binding = liveBridgeBinding(tabId);
  if (binding === null) return;
  const delivery = await bridge.endpoint.commit(binding);
  if (delivery === null) return;
  bridge.bound = false;
  log(`tab ${tabId}: bridge document ${delivery.documentId.slice(0, 8)} committed`);
  // The endpoint, the document and the binding are bounded facts; the secret and the
  // binding's own fields are not recorded.
  diagnostics.note(
    tabId,
    `bridge: document ${delivery.documentId.slice(0, 8)} committed for editor ${bridge.editorId.slice(0, 8)} on 127.0.0.1:${delivery.port}`,
  );
  deliverBridgeBinding(tabId, delivery);
}

/**
 * Deliver one document's bridge secret over the panel route.
 *
 * The secret only ever travels to the exact panel of the document it belongs to, so
 * a superseded panel cannot receive it; the page answers with an acknowledgement
 * naming this delivery, which is what proves the page that holds the secret is the
 * one whose link the binding was pinned to.
 */
function deliverBridgeBinding(tabId: string, delivery: BridgeBootstrapDelivery): void {
  const state = stateOf(tabId);
  const bridge = state?.bridge ?? null;
  const panel = state?.panel ?? null;
  if (state === undefined || bridge === null || panel === null) return;
  if (bridge.documentId !== delivery.documentId) return;
  const message: GuestBridgeBindMessage = {
    type: "omp:bridge-bind",
    hostGeneration: encodeHex(bridgeHostGeneration),
    documentId: delivery.documentId,
    bootstrapId: delivery.bootstrapId,
    workspace: bridge.endpoint.scope.workspace,
    // The page identifies itself to the listener by its document's own identity, which
    // is the editor's original namespace — not the conversation it serves now.
    tabId: bridge.endpoint.scope.tabId,
    editorId: bridge.editorId,
    port: delivery.port,
    origin: delivery.origin,
    path: BRIDGE_PATH,
    bindingHash: delivery.bindingHash,
    secret: encodeBase64Url(delivery.secret),
  };
  void panel.webview.postMessage(message);
  log(`tab ${tabId}: bridge secret delivered for document ${delivery.documentId.slice(0, 8)}`);
}

/** Re-send the current document's bridge secret, without rotating it. */
async function redeliverBridgeBinding(tabId: string): Promise<void> {
  const bridge = stateOf(tabId)?.bridge ?? null;
  if (bridge === null || bridge.bound) return;
  const delivery = await bridge.endpoint.delivery();
  if (delivery !== null) deliverBridgeBinding(tabId, delivery);
}

/**
 * Re-check this tab's native readiness for its bridge route.
 *
 * A recovered orphan may dispatch only while the *same* chat-host identity is verified:
 * a reattached process with a new epoch, a different broker generation
 * or a released claim is a different native side, and the bridge becomes
 * authenticated standby again instead of dispatching against it.
 */
function refreshBridgeReadiness(tabId: string): void {
  const state = stateOf(tabId);
  const bridge = state?.bridge ?? null;
  if (state === undefined || bridge === null || bridge.documentId === null) return;
  const recorded = bridge.endpoint.committedBinding();
  const live = liveBridgeBinding(tabId);
  bridge.endpoint.nativeReady(recorded !== null && live !== null && bindingMatches(recorded, live));
  pushBridgeRouteOffer(tabId);
}

/**
 * Retire the bridge of an editor this window observed closing.
 *
 * The reservation is released, the editor leaves the live membership, the endpoint
 * is dropped from this activation and its records — including the port lease record
 * and the document secret — are forgotten. That is what makes a reopen possible
 * (a fresh editor id must be able to win its tab) and what keeps a closed editor's
 * credential from outliving the editor.
 */
function retireClosedBridgeEditor(slot: string): void {
  const state = tabs.get(slot);
  const endpoint = state?.bridge?.editorId === slot ? state.bridge.endpoint : bridgeEndpoints.get(slot) ?? pendingBridgeEndpoints.get(slot) ?? null;
  if (state?.bridge?.editorId === slot) state.bridge = null;
  bridgeLiveEditors.delete(slot);
  // Only this editor's own reservation is released, and only its own endpoint and
  // records are forgotten: another editor showing the same conversation — a passive
  // one that still holds an unsent draft, or the incumbent of a live conflict —
  // keeps its own slot, its own credential and its own process.
  const namespaceTabId = bridgeEditors.tabOfEditor(slot);
  if (namespaceTabId === null) {
    void Promise.resolve(endpoint)
      .then(bound => bound?.forget())
      .catch(() => undefined);
  } else {
    // The helper releases the reservation before its first await. This closes the
    // window where a late bind could adopt an editor the user already closed.
    void retireClosedEditorBridge({ tabId: namespaceTabId, editorId: slot, endpoint, editors: bridgeEditors })
      .then(result => {
        if (!result.retired) return;
        log(`slot ${slot}: the closed editor's bridge was retired`);
        diagnostics.note(slot, `bridge: editor ${slot.slice(0, 8)} closed; endpoint and records retired`);
      })
      .catch(() => undefined);
  }
  if (endpoint instanceof Promise) {
    void endpoint.then(bound => {
      if (bound !== null && bridgeEndpoints.get(slot) === bound) bridgeEndpoints.delete(slot);
    }).catch(() => undefined);
  } else if (endpoint !== null && bridgeEndpoints.get(slot) === endpoint) {
    bridgeEndpoints.delete(slot);
  }
}

/** The route of this tab's current document, or `null`. */
function bridgeRouteOf(tabId: string): BridgeDocumentRoute | null {
  const state = stateOf(tabId);
  const bridge = state?.bridge ?? null;
  if (bridge === null || bridge.documentId === null) return null;
  return bridge.endpoint.routeFor(bridge.documentId);
}

/**
 * Offer this document's route over the transport that can carry it.
 *
 * The panel route wins whenever this host actually holds the panel handle for this
 * document; the bridge is for a surviving page whose handle the restarted host no
 * longer has. The offer mints a fresh generation whenever the transport changes, and
 * dispatch waits for the page's acknowledgement either way.
 */
function offerBridgeRoute(tabId: string): void {
  cancelControlPicker(tabId);
  const state = stateOf(tabId);
  const bridge = state?.bridge ?? null;
  if (state === undefined || bridge === null || bridge.documentId === null) return;
  const ticket = bridgeTicketFacts(tabId);
  if (ticket === null) return;
  const route = bridgeRouteOf(tabId);
  if (route === null) return;
  if (state.panel !== null) {
    const routeGeneration = bridge.endpoint.offerPanel();
    if (routeGeneration === null) return;
    void state.panel.webview.postMessage({
      type: "omp:route-offer",
      hostGeneration: encodeHex(bridgeHostGeneration),
      documentId: bridge.documentId,
      routeGeneration,
      status: route.status(),
    } satisfies GuestRouteOfferMessage);
    return;
  }
  bridge.endpoint.offerBridge();
}

/**
 * Re-send the *current* offer so a status change reaches the page.
 *
 * The generation is not re-minted here: an already acknowledged route stays
 * acknowledged, and only the status word it carries moves.
 */
function pushBridgeRouteOffer(tabId: string): void {
  const state = stateOf(tabId);
  const bridge = state?.bridge ?? null;
  if (state === undefined || bridge === null || bridge.documentId === null) return;
  const route = bridgeRouteOf(tabId);
  const routeGeneration = route?.routeGeneration ?? null;
  if (route === null || routeGeneration === null) return;
  const status = route.status();
  diagnostics.note(tabId, `bridge: route ${routeGeneration.slice(0, 8)} offered over ${state.panel === null ? "bridge" : "panel"} (${status})`);
  if (state.panel !== null) {
    void state.panel.webview.postMessage({
      type: "omp:route-offer",
      hostGeneration: encodeHex(bridgeHostGeneration),
      documentId: bridge.documentId,
      routeGeneration,
      status,
    } satisfies GuestRouteOfferMessage);
    return;
  }
  // An orphan has no panel handle: the endpoint re-sends the *current* generation
  // over whatever session is authenticated, and its own `noteSession` covers the case
  // where the page has not reconnected yet.
  bridge.endpoint.refreshBridgeOffer();
}

// Chat pages: the routes that show a host-owned conversation

/** One id per panel handle, so a route can be detached without keeping the panel alive. */
const panelPageIds = new WeakMap<vscode.WebviewPanel, string>();
let panelPageSequence = 0;

function panelPageId(panel: vscode.WebviewPanel): string {
  let id = panelPageIds.get(panel);
  if (id === undefined) {
    panelPageSequence += 1;
    id = `panel-${panelPageSequence}`;
    panelPageIds.set(panel, id);
  }
  return id;
}

/** The Webview `postMessage` route of one panel. */
function panelChatPage(state: TabState, panel: vscode.WebviewPanel): ChatPage {
  return {
    id: panelPageId(panel),
    readOnlyReason: () => sessionAdmissionReason(state),
    post: message => {
      // A replaced or closed panel must not receive a conversation meant for the editor
      // that now holds the slot.
      if (tabs.get(state.slotId)?.panel !== panel) return "dropped";
      void panel.webview.postMessage(message);
      return "sent";
    },
  };
}

/** The largest chat message the bridge carries in one encrypted frame, with headroom. */
const BRIDGE_CHAT_MESSAGE_LIMIT = BRIDGE_MAX_PLAINTEXT_BYTES - 4096;
/** Row grouping stays compatible with panel snapshots; large DTOs are fragmented by the bridge writer. */
const BRIDGE_CHAT_CHUNK_BYTES = 248 * 1024;

/** The bridge route of one surviving page: host pushes ride the bridge's own frames. */
function bridgeChatPage(bridge: NonNullable<TabState["bridge"]>, documentId: string): ChatPage {
  return {
    id: `bridge-${documentId}`,
    maxChunkBytes: BRIDGE_CHAT_CHUNK_BYTES,
    readOnlyReason: () => { const state = tabs.get(bridge.editorId); return state === undefined ? PASSIVE_REASON_DEFAULT : sessionAdmissionReason(state); },
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
  const state = tabs.get(slot);
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
  state.chatDetach = chat.attachPage(state.tabId, desired.page);
  publishFooterMetadata(state.tabId);
}

/** Point every editor showing one conversation at its route (after its host or view changed). */
function attachChatRoutes(tabId: string, force = false): void {
  for (const [slot, state] of tabs) {
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
  // Resolved by the *editor*, never by the conversation the endpoint was created
  // for: a settled switch moves the conversation under this editor, and the request
  // must be answered for what the editor serves now — the endpoint's namespace T
  // never selects native authority again.
  const state = tabs.get(editorId);
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
  const route = bridgeRouteOf(editorId);
  const payload = typeof request.payload === "object" && request.payload !== null ? request.payload : null;
  if (route === null || payload === null) {
    session.reply(request.requestId, { type: "omp:error", message: "This document has no route.", code: "not-hosted" });
    return;
  }
  const table = indexForBridge;
  if (table === null || BRIDGE_OPERATIONS[request.operation] !== true) {
    // Only the listed controls/chat/terminal exchanges are carried, and this
    // window needs its current index to answer them. Nothing else is admitted.
    refuseBridgeRequest(session, route.routeGeneration, request.requestId);
    return;
  }
  if (request.operation === "provider-login") {
    const parsed = parseGuestWebviewMessage({ ...payload, type: "omp:chat-command" });
    if (parsed?.type !== "omp:chat-command" || parsed.command !== "provider-login" ||
      activationContext === undefined || (route.state !== "BRIDGE_READY" && route.state !== "BRIDGE_AUTHENTICATED_WAITING")) {
      refuseBridgeRequest(session, route.routeGeneration, request.requestId);
      return;
    }
    // Opening native login changes no session writer; the exact current authenticated
    // document may request it while Chat is stopped. Passive editors retain panel-only login.
    void runChatAction(activationContext, table, tabId, parsed.command)
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
  if (request.operation === "chat-tool-detail" || request.operation === "chat-subagent-read" ||
      request.operation === "terminal-link-validate" || request.operation === "terminal-link-open") {
    // Preferences, child history and local file navigation are presentation,
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
      : runChatCommand(tabId, parsed as ChatWebviewMessage, bridgeChatPage(bridge, documentId));
    void handled.then(() => session.reply(request.requestId, null))
      .catch(() => refuseBridgeRequest(session, route.routeGeneration, request.requestId));
    return;
  }
  if (request.operation.startsWith("terminal-")) {
    const object = payload as Record<string, unknown>;
    const parsed = parseGuestWebviewMessage({ ...object, type: `omp:${request.operation}` });
    if (parsed === null || !route.dispatchable || state.runtime?.kind !== "terminal" || state.mode !== "terminal" || liveBridgeBinding(tabId) === null) {
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
      log(
        `tab ${tabId}: a bridge ${chatType} was refused (${parsed === null ? "the payload was not a valid chat command" : "this route cannot dispatch: the native side is not verified for this document"})`,
      );
      if (parsed !== null) replyChatSendResult(tabId, parsed as ChatWebviewMessage, bridgeChatPage(bridge, documentId), "refused");
      refuseBridgeRequest(session, route.routeGeneration, request.requestId);
      return;
    }
    void runChatCommand(tabId, parsed as ChatWebviewMessage, bridgeChatPage(bridge, documentId))
      .then(() => session.reply(request.requestId, null))
      .catch(() => {
        log(`tab ${tabId}: a bridge chat command could not be processed`);
        session.reply(request.requestId, null);
      });
    return;
  }
  void handleGuestMessageOverBridge(table, tabId, responder, payload).catch(() => {
    log(`tab ${tabId}: a bridge request could not be processed`);
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
  "chat-tool-detail": true,
  "chat-subagent-read": true,
  "terminal-attach": true,
  "terminal-probe": true,
  "terminal-input": true,
  "terminal-resize": true,
  "terminal-focus": true,
  "terminal-visibility": true,
  "terminal-copy-reply": true,
  "terminal-link-validate": true,
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
};

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
    log(`tab ${tabId}: a bridge mutation was not admitted (${error instanceof BridgeAdmissionError ? error.code : "refused"})`);
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
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (!(input instanceof vscode.TabInputWebview)) return null;
  const identity = tabInputIdentity(input.viewType);
  if (identity === null) return null;
  const state = tabs.get(identity.editorIdHex);
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
  await switchSessionMode(context, index, state, mode);
}

interface TerminalCopyRequest {
  readonly nonce: string;
  readonly panel: vscode.WebviewPanel;
  readonly document: PanelDocument;
  readonly bridgeDocumentId: string | null;
  readonly generation: string;
  readonly deadline: number;
  readonly timer: NodeJS.Timeout;
}
const terminalCopyRequests = new WeakMap<TabState, TerminalCopyRequest>();

function forgetTerminalCopy(state: TabState): void {
  const pending = terminalCopyRequests.get(state);
  if (pending !== undefined) clearTimeout(pending.timer);
  terminalCopyRequests.delete(state);
}

function copyActiveTerminalScreen(): void {
  const state = activePanelTab();
  if (state === null || state.mode !== "terminal" || state.document?.kind !== "guest" || state.pipeline === null) {
    showWarning("No native OMP screen is available in the active editor.");
    return;
  }
  forgetTerminalCopy(state);
  const nonce = encodeHex(randomBytes(16));
  const timer = setTimeout(() => {
    if (terminalCopyRequests.get(state)?.nonce !== nonce) return;
    forgetTerminalCopy(state);
    showWarning("The native screen did not answer the copy request. Nothing was copied.");
  }, 3_000);
  terminalCopyRequests.set(state, {
    nonce, panel: state.panel, document: state.document, bridgeDocumentId: state.bridge?.documentId ?? null,
    generation: state.pipeline.generation, deadline: Date.now() + 3_000, timer,
  });
  void state.panel.webview.postMessage({ type: "omp:terminal-copy-request", requestId: nonce } satisfies GuestTerminalCopyRequestMessage);
}

/**
 * `OMP: Redraw Terminal`: ask the native OMP program in the active editor to repaint its own
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
  const pending = terminalCopyRequests.get(state);
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
    vscode.window.setStatusBarMessage("OMP: Native screen and scrollback copied.", 3_000);
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
  log(`tab ${target.tabId}: ${action} asked from a VS Code command or keybinding`);
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
    showWarning("No OMP Chat editor is active, so there is nothing for this command to act on.");
    return null;
  }
  return target.tabId;
}

/** Ask the active Chat editor's own composer to run one of its actions (retry, thinking or tools toggle). */
function postChatPanelAction(action: GuestPanelAction): void {
  if (activeChatTab() !== null) postPanelAction(action);
}

/** Run one {@link GuestChatCommand} for the active Chat editor, from the command palette or a keybinding. */
function runActiveChatAction(context: vscode.ExtensionContext, index: SessionIndex, command: GuestChatCommand): void {
  const tabId = activeChatTab();
  if (tabId !== null) void runChatAction(context, index, tabId, command);
}

function chatRefusalText(reason: SendRefusal): string {
  return reason === "busy" ? "OMP is busy with the running turn; try again after it ends." : reason === "not-live" || reason === "not-owner" ? "This conversation is not accepting commands right now." : "OMP did not accept the command.";
}

/**
 * One Chat action for `tabId`'s live conversation. Every action that sends or uploads anything asks first in
 * VS Code's own UI (an InputBox, a save dialog, a modal confirmation); cycling is one explicit keypress, as in
 * the TUI. Outcomes are reported here; progress shows in the conversation itself.
 */
async function runChatAction(context: vscode.ExtensionContext, index: SessionIndex, tabId: string, command: GuestChatCommand): Promise<void> {
  if (command === "provider-login") {
    const entry = index.get(tabId);
    await openProviderLogin(stateOf(tabId)?.runtime ?? null, entry?.scope.profile ?? null,
      entry?.cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir());
    return;
  }
  const session = chat.sessionOf(tabId);
  if (session === null || session.phase !== "live") {
    showWarning("This conversation is not live, so the action was not run.");
    return;
  }
  const current = (): boolean => chat.sessionOf(tabId) === session && session.phase === "live";
  switch (command) {
    case "compact": {
      const running = session.model.working;
      const instructions = await vscode.window.showInputBox({
        title: "Compact Conversation",
        prompt: `OMP replaces the earlier conversation with a summary to free context.${running ? " The running turn is interrupted and continues after the summary." : ""} Optionally say what the summary must keep.`,
        placeHolder: "Optional instructions for the summary",
        ignoreFocusOut: true,
      });
      if (instructions === undefined || !current()) return;
      const result = await session.compact(instructions.trim().length > 0 ? instructions.trim() : undefined);
      if (result.status === "refused") showWarning(`The conversation was not compacted. ${chatRefusalText(result.reason)}`);
      else if (result.status === "unconfirmed") showWarning("OMP did not report whether the conversation was compacted.");
      return;
    }
    case "cycle-model": {
      const result = await session.cycleModel();
      if (result.status === "refused") showWarning(`The model was not changed. ${chatRefusalText(result.reason)}`);
      else if (result.status === "unconfirmed") showWarning("OMP did not report whether the model changed.");
      else if (result.value === null) showInfo("OMP has no other model to cycle to. Configure model roles in OMP settings.");
      else vscode.window.setStatusBarMessage(`OMP model: ${result.value.model.name ?? result.value.model.id}${result.value.thinkingLevel ? ` · ${result.value.thinkingLevel}` : ""}`, 4_000);
      return;
    }
    case "cycle-thinking": {
      const result = await session.cycleThinkingLevel();
      if (result.status === "refused") showWarning(`The thinking level was not changed. ${chatRefusalText(result.reason)}`);
      else if (result.status === "unconfirmed") showWarning("OMP did not report whether the thinking level changed.");
      else if (result.value === null) showInfo("The current model has no thinking levels to cycle through.");
      else vscode.window.setStatusBarMessage(`OMP thinking level: ${result.value}`, 4_000);
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
      const result = await session.exportHtml(target.fsPath);
      if (result.status !== "ok") {
        showError(result.status === "refused" ? `The conversation was not exported. ${chatRefusalText(result.reason)}` : "OMP did not report whether the export was written.");
        return;
      }
      const written = vscode.Uri.file(result.value);
      const picked = await vscode.window.showInformationMessage(`OMP: Exported the conversation to ${result.value}.`, "Open", "Reveal in File Explorer");
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
      const outcome = await session.prompt({ requestId: createControlRequestId(), text: "/share" });
      if (outcome.status === "refused") showWarning(`Nothing was shared. ${chatRefusalText(outcome.reason)}`);
      else if (outcome.status === "unconfirmed") showWarning("OMP did not confirm the share command. It was not sent again.");
      return;
    }
  }
}

/** The Desk stand-in for a terminal-UI slash command typed into Chat (`host/slash-registry.ts`). */
async function runDeskSlashAction(action: Exclude<DeskSlashAction, "models-settings">): Promise<void> {
  switch (action) {
    case "keyboard-shortcuts":
      await showChatKeyboardShortcuts();
      return;
    case "source-control":
      await vscode.commands.executeCommand("workbench.view.scm");
      return;
    case "tools-view":
      await vscode.commands.executeCommand("omp.tools.focus");
      return;
    case "provider-login":
      await vscode.commands.executeCommand("omp.loginProvider");
      return;
  }
}

async function showChatKeyboardShortcuts(): Promise<void> {
  await vscode.commands.executeCommand("workbench.action.openGlobalKeybindings", "omp.");
}

/** Prompts the user sent from any Chat, newest first; VS Code's global state, so one list per VS Code profile. */
const PROMPT_HISTORY_KEY = "omp.chat.promptHistory";
const MAX_PROMPT_HISTORY = 200;
/** A prompt longer than this is not remembered: history search is for prompts one retypes. */
const MAX_REMEMBERED_PROMPT = 20_000;

function rememberedPrompts(): string[] {
  const stored = activationContext?.globalState.get<unknown>(PROMPT_HISTORY_KEY);
  return Array.isArray(stored) ? stored.filter((item): item is string => typeof item === "string") : [];
}

function rememberPrompt(text: string): void {
  const context = activationContext;
  if (context === undefined || text.trim().length === 0 || text.length > MAX_REMEMBERED_PROMPT || text.trimStart().startsWith("/")) return;
  const next = [text, ...rememberedPrompts().filter(item => item !== text)].slice(0, MAX_PROMPT_HISTORY);
  void context.globalState.update(PROMPT_HISTORY_KEY, next);
}

/**
 * The TUI's `Ctrl+R`: a QuickPick of past prompts, this conversation's first (newest first), then the ones sent
 * from other Chats. The pick is added to the draft, never sent.
 */
async function searchPromptHistory(): Promise<void> {
  const tabId = activeChatTab();
  if (tabId === null) return;
  const own = sessionPrompts(chat.modelOf(tabId)?.entries ?? []).reverse();
  const seen = new Set(own);
  const others = rememberedPrompts().filter(text => !seen.has(text));
  const item = (text: string): vscode.QuickPickItem & { text: string } => {
    const line = text.split(/\r?\n/).find(part => part.trim().length > 0)?.trim() ?? text.trim();
    const lines = text.split(/\r?\n/).length;
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
  const panel = stateOf(tabId)?.panel;
  if (panel === undefined || panel === null) return;
  void panel.webview.postMessage({ type: "omp:recall-prompt", text: picked.text } satisfies GuestRecallPromptMessage);
}

/**
 * "OMP: Rewind Conversation…" (ADR-0051), the keyboard-only route to Chat's in-place Rewind: the loaded prompts of the
 * active Chat, newest first, with what leaves the branch, then Rewind or Rewind & summarize. The request is pinned to
 * the leaf the list was built from; the answer and the prompt go to the tab's writable editor routes, whose composer
 * takes the prompt to edit and send again. Files changed afterwards are named and never restored.
 */
async function rewindConversation(): Promise<void> {
  const tabId = activeChatTab();
  if (tabId === null) return;
  const model = chat.modelOf(tabId);
  const blocked = model === null || model === undefined ? NAVIGATE_REFUSAL_SENTENCES["not-live"] : rewindBlockedReason(model);
  if (model === null || model === undefined || blocked !== null) {
    showWarning(blocked ?? NAVIGATE_REFUSAL_SENTENCES["not-live"]);
    return;
  }
  const durable = model.entries.slice(0, model.durableCount);
  const leafId = model.leafId;
  const cwd = model.header?.cwd;
  const targets = rewindTargets(durable).reverse();
  if (targets.length === 0) {
    showInfo("There is no earlier message in this conversation to rewind to.");
    return;
  }
  const leaving = (id: string): string => {
    const preview = rewindPreview(durable, id, cwd);
    if (preview === null) return "";
    const files = preview.files.length === 0 ? "" : ` · files changed after it stay as they are: ${preview.files.slice(0, 5).join(", ")}${preview.files.length > 5 ? `, +${preview.files.length - 5}` : ""}`;
    return `${preview.messages} message${preview.messages === 1 ? "" : "s"} leave this branch${files}`;
  };
  const picked = await vscode.window.showQuickPick(
    targets.map(target => ({ label: target.preview, description: new Date(target.timestamp).toLocaleString(), detail: leaving(target.id), id: target.id })),
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
  const outcome = await chat.navigate(tabId, { requestId: encodeHex(randomBytes(16)), kind: "rewind", targetId: picked.id, expectedLeafId: leafId, summarize: how.summarize }, null);
  if (outcome.status === "done") {
    if (outcome.raced) showInfo("Rewound, but OMP also changed the conversation meanwhile. Check the transcript.");
    return;
  }
  showWarning(NAVIGATE_REFUSAL_SENTENCES[outcome.status === "unconfirmed" ? "unconfirmed" : outcome.reason]);
}

/**
 * The installed OMP's builtin slash registry, read once per install by `media/slash-registry.mjs` and re-checked at
 * most once a minute, so an OMP update changes which typed commands are terminal-only without a Desk release.
 * `null` while unknown: nothing is refused as terminal-only then.
 */
let slashRegistry: SlashRegistry | null = null;
/** The install whose registry could not be read: its helper is not started again until the install changes. */
let slashRegistryFailedKey: string | null = null;
let slashRegistryCheckedAt = 0;
let slashRegistryLoading: Promise<void> | null = null;
const SLASH_REGISTRY_RECHECK_MS = 60_000;

function currentSlashRegistry(context: vscode.ExtensionContext): readonly BuiltinSlashEntry[] | null {
  if (slashRegistryLoading === null && Date.now() - slashRegistryCheckedAt > SLASH_REGISTRY_RECHECK_MS) {
    slashRegistryLoading = loadSlashRegistry(context).finally(() => {
      slashRegistryCheckedAt = Date.now();
      slashRegistryLoading = null;
    });
  }
  return slashRegistry?.commands ?? null;
}

async function loadSlashRegistry(context: vscode.ExtensionContext): Promise<void> {
  try {
    const bun = await resolveBunRuntime();
    const pkg = bun === null ? null : await resolveOmpPackageRoot(await resolveOmpBinary());
    if (bun === null || pkg === null) {
      slashRegistry = null;
      return;
    }
    const key = `${pkg.root}@${pkg.version ?? "unknown"}`;
    if (slashRegistry?.key === key || slashRegistryFailedKey === key) return;
    // Another install's commands must never classify this one, even when this one cannot be read.
    slashRegistry = null;
    slashRegistryFailedKey = key;
    const [helper] = await stageRuntimeAssets({ storageDir: context.globalStorageUri.fsPath, sourcePaths: [context.asAbsolutePath(SLASH_REGISTRY_HELPER)] });
    if (helper === undefined) return;
    const commands = await readSlashRegistry({ bunPath: bun, helperPath: helper.path, packageRoot: pkg.root, cwd: path.dirname(helper.path) });
    if (commands === null) {
      log(`the slash-command registry of ${key} could not be read; terminal-only commands are not refused`);
      return;
    }
    slashRegistry = { key, commands };
    slashRegistryFailedKey = null;
    log(`read ${commands.length} builtin slash commands from ${key}`);
  } catch (error) {
    log(`the slash-command registry could not be read: ${messageOf(error)}`);
  }
}

// "OMP: Add Selection to Session" and "OMP: Add File to Session"
// What is added is a reference (`@src/a.ts [lines 12-30]`), composed by `host/editor-context` for the
// chosen session's cwd. The target is always the user's choice from a picker, most recently focused
// editor first; nothing is ever submitted, and the destination is revealed and focused.

/** How long a session being opened may take to be able to receive the text. */
const INSERT_TARGET_TIMEOUT_MS = 30_000;
const INSERT_POLL_MS = 100;

type SendTarget =
  | { readonly kind: "session"; readonly candidate: SendCandidate }
  | { readonly kind: "new"; readonly folder: string };

async function addSelectionToSession(context: vscode.ExtensionContext, index: SessionIndex): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined || editor.document.uri.scheme !== "file") {
    showWarning("Open a file on disk and select the text to add.");
    return;
  }
  const ranges = editor.selections.filter(selection => !selection.isEmpty).map(selection => selectionLines(selection.start, selection.end));
  if (ranges.length === 0) {
    showWarning("Select some text first, or use “OMP: Add File to Session”.");
    return;
  }
  await addToSession(context, index, [{ fsPath: editor.document.uri.fsPath, ranges }], editor.document.isDirty);
}

/** An Explorer click (with its multi-selection), an editor or tab menu, or — from the palette — the active editor's file. */
async function addFilesToSession(context: vscode.ExtensionContext, index: SessionIndex, clicked: unknown, selected: unknown): Promise<void> {
  const chosen = Array.isArray(selected) ? selected.filter((value): value is vscode.Uri => value instanceof vscode.Uri) : [];
  const uris = chosen.length > 0 ? chosen : clicked instanceof vscode.Uri ? [clicked] : vscode.window.activeTextEditor === undefined ? [] : [vscode.window.activeTextEditor.document.uri];
  const files = uris.filter(uri => uri.scheme === "file");
  if (files.length === 0) {
    showWarning("Select a file or folder on disk to add.");
    return;
  }
  const dirty = new Set(vscode.workspace.textDocuments.filter(document => document.isDirty).map(document => document.uri.toString()));
  await addToSession(context, index, files.map(uri => ({ fsPath: uri.fsPath })), files.some(uri => dirty.has(uri.toString())));
}

/** This window's sessions that can take text now, or by being opened first. */
function sendCandidates(context: vscode.ExtensionContext, index: SessionIndex): SendCandidate[] {
  const found: SendCandidate[] = [];
  for (const entry of index.list()) {
    const facts = launcherFacts(entry.tabId);
    // A row another window holds is never an Add-to-Session target: window-local facts cannot see
    // that claim, so the Sessions row's own observation decides.
    const state = launcherProvider?.displayedState(entry.tabId) === "otherWindow" ? "otherWindow" : sessionItemState(entry, facts);
    const availability = insertAvailability(state, { running: facts.running, open: facts.open });
    if (availability === null) continue;
    const tab = stateOf(entry.tabId);
    const editorOpen = tab?.panel != null;
    // An editor that does not control its session shows one another writer holds.
    if (tab !== undefined && editorOpen && passiveReasonForSlot(tab.slotId) !== null) continue;
    // A page that outlived a host restart has no panel handle to reveal or write to.
    if (facts.open && !editorOpen) continue;
    found.push({
      tabId: entry.tabId,
      slotId: tab !== undefined && editorOpen ? tab.slotId : null,
      title: tab?.panel?.title ?? sessionHeadline(entry, null),
      cwd: tab?.runtime?.cwd ?? entry.cwd,
      mode: tab?.runtime?.kind ?? tab?.mode ?? defaultSessionMode(context),
      stateLabel: sessionStateLabel(state),
      availability,
    });
  }
  return found;
}

/** The QuickPick: eligible sessions, most recently focused first and preselected, then a new session next to the file. */
async function pickSendTarget(context: vscode.ExtensionContext, index: SessionIndex, firstFsPath: string, unsaved: boolean): Promise<SendTarget | null> {
  const workspace = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(firstFsPath));
  const folder = newSessionFolder(firstFsPath, workspace?.uri.fsPath ?? null);
  const folderListed = launcherFolders?.folderForCwd(folder) != null;
  const entries = pickerEntries(sendCandidates(context, index), editorRecency.order(), folder, defaultSessionMode(context), folderListed);
  const items: (vscode.QuickPickItem & { target?: SendTarget })[] = [];
  for (const entry of entries) {
    if (entry.kind === "new") {
      if (items.length > 0) items.push({ label: "", kind: vscode.QuickPickItemKind.Separator });
      items.push({ label: `$(add) ${entry.label}`, description: entry.description, target: { kind: "new", folder: entry.folder } });
      continue;
    }
    const { candidate } = entry;
    items.push({
      label: `$(${candidate.mode === "chat" ? "comment-discussion" : "terminal"}) ${candidate.title}`,
      description: sendCandidateDescription(candidate),
      detail: candidate.availability === "resume" ? `${candidate.cwd} — stopped: choosing it starts the session first` : candidate.cwd,
      target: { kind: "session", candidate },
    });
  }
  const picker = vscode.window.createQuickPick<(typeof items)[number]>();
  picker.title = "Add to OMP session";
  picker.placeholder = unsaved ? "Choose the session to add it to — unsaved changes are not included" : "Choose the session to add it to";
  picker.matchOnDescription = true;
  picker.matchOnDetail = true;
  picker.items = items;
  const first = items[0];
  if (first !== undefined) picker.activeItems = [first];
  const { promise, resolve } = Promise.withResolvers<SendTarget | null>();
  picker.onDidAccept(() => {
    resolve(picker.selectedItems[0]?.target ?? null);
    picker.hide();
  });
  picker.onDidHide(() => {
    resolve(null);
    picker.dispose();
  });
  picker.show();
  return await promise;
}

async function addToSession(context: vscode.ExtensionContext, index: SessionIndex, sources: readonly ReferenceSource[], unsaved: boolean): Promise<void> {
  const first = sources[0];
  if (first === undefined) return;
  const target = await pickSendTarget(context, index, first.fsPath, unsaved);
  if (target === null) return;
  let tabId: string;
  let cwd: string;
  let folderAdded = false;
  if (target.kind === "new") {
    const folders = launcherFolders;
    if (folders === undefined) return;
    // Refuse what cannot be written before anything is added or started.
    const probe = composeInsertion(sources, target.folder);
    if (!probe.ok) { showWarning(`${probe.reason} Nothing was added.`); return; }
    // Choosing "New session in <folder>" for a folder the launcher already shows (open in this
    // window or pinned) just starts there; for any other folder it is the explicit act of pinning
    // it (a session is never started in a folder the launcher does not show); the picker row says so.
    const shown = folders.folderForCwd(target.folder);
    folderAdded = shown === null;
    const added = shown === null ? await folders.add(target.folder) : { ok: true as const, folder: shown, created: false };
    if (!added.ok) {
      showError(`The folder for a new session was not pinned: ${added.reason}`);
      return;
    }
    cwd = added.folder.path;
    refreshLauncher();
    let entry: SessionIndexEntry;
    try {
      entry = await index.createDraft({ cwd });
    } catch (error) {
      showError(`A new OMP session could not be reserved: ${messageOf(error)}`);
      return;
    }
    tabId = entry.tabId;
    refreshLauncher();
    await openTab(context, index, tabId, "started");
  } else {
    tabId = target.candidate.tabId;
    cwd = target.candidate.cwd;
    const probe = composeInsertion(sources, cwd);
    if (!probe.ok) { showWarning(`${probe.reason} Nothing was added.`); return; }
    // Reveals a running session's editor, reopens a closed one and starts a stopped one, all through the
    // path the Sessions view's Open uses (ownership is rechecked there).
    if (!(await openSession(context, index, tabId, "resumed"))) return;
  }
  const delivered = await deliverInsertion(tabId, sources, cwd);
  if (!delivered.ok) {
    log(`tab ${tabId}: editor references were not added (${delivered.reason})`);
    void vscode.window.showWarningMessage(`OMP: ${delivered.reason} Nothing was added.`, "Copy reference").then(choice => {
      if (choice === "Copy reference") {
        const composed = composeInsertion(sources, cwd);
        if (composed.ok) void vscode.env.clipboard.writeText(composed.text);
      }
    });
    return;
  }
  log(`tab ${tabId}: ${stateOf(tabId)?.mode ?? "chat"} received ${sources.length} editor reference(s)`);
  const notes: string[] = [];
  if (unsaved) notes.push("unsaved changes are not included");
  if (folderAdded) notes.push(`${sessionFolderName(cwd)} was pinned to the OMP launcher`);
  // OMP expands @mentions only in a prompt sent while it is idle, not in a steering or queued follow-up message.
  if (turnActivities.get(tabId)?.streaming === true) notes.push("the session is busy: send it once the turn ends so the files are read");
  vscode.window.setStatusBarMessage(`Added ${delivered.summary} to «${delivered.title}»${notes.length > 0 ? ` — ${notes.join("; ")}` : ""}`, notes.length > 0 ? 10_000 : 6_000);
}

/**
 * Hand the references to the session's input once that input exists: the composer of a chat page that
 * has announced itself, or the native TUI once it has enabled bracketed paste. The target is revealed
 * and focused once; a session still starting is waited for, bounded. The text is composed against the
 * session's working directory as it is when written, which a starting session may still be settling.
 */
async function deliverInsertion(
  tabId: string,
  sources: readonly ReferenceSource[],
  entryCwd: string,
): Promise<{ readonly ok: true; readonly title: string; readonly summary: string } | { readonly ok: false; readonly reason: string }> {
  const deadline = Date.now() + INSERT_TARGET_TIMEOUT_MS;
  let waiting = "the session did not become ready";
  let revealed = false;
  for (;;) {
    const state = stateOf(tabId);
    const panel = state?.panel ?? null;
    if (state !== undefined && panel !== null && state.document?.kind === "guest" && !state.transitioning
      && passiveReasonForSlot(state.slotId) === null && launcherFacts(tabId).running) {
      if (turnActivities.get(tabId)?.pendingRequest != null) return { ok: false, reason: "The session is waiting for your answer, which covers its input." };
      if (!revealed) {
        revealed = true;
        if (!panel.active) panel.reveal(undefined, false);
      }
      const composed = composeInsertion(sources, state.runtime?.cwd ?? entryCwd);
      if (!composed.ok) return { ok: false, reason: composed.reason };
      const { text, summary } = composed;
      if (state.mode === "chat") {
        if (readyDocuments.get(state) === state.document) {
          const posted = await panel.webview.postMessage({ type: "omp:insert-text", text } satisfies GuestInsertTextMessage);
          return posted ? { ok: true, title: panel.title, summary } : { ok: false, reason: "The chat page did not accept the text." };
        }
        waiting = "the chat page did not become ready";
      } else if (state.pipeline !== null && state.shellSlot === null) {
        const outcome = await state.pipeline.pasteText(text);
        if (outcome === "pasted") {
          const settleBy = Date.now() + 2_000;
          while (state.panel?.active !== true && Date.now() < settleBy) await delay(50);
          activateNativeEditor(state);
          return { ok: true, title: panel.title, summary };
        }
        if (outcome === "refused" || outcome === "unavailable") return { ok: false, reason: "The terminal could not take the text." };
        waiting = outcome === "not-owner" ? "the terminal did not take input ownership" : "OMP's prompt is not reading input yet";
      }
    }
    if (Date.now() >= deadline) return { ok: false, reason: `Timed out: ${waiting}.` };
    await delay(INSERT_POLL_MS);
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
  if (turnNotifier === undefined || turnNotifier.index !== index) {
    turnNotifier = {
      index,
      notifier: new TurnNotifier({
        send: async (tabId, notice) => {
          if (vscode.env.uriScheme !== "vscode") {
            log(`tab ${tabId}: desktop notification ${notice.kind} suppressed (unsupported-product).`);
            return;
          }
          const entry = index.get(tabId);
          if (entry === null || activationContext === undefined) {
            log(`tab ${tabId}: desktop notification ${notice.kind} failed (${entry === null ? "session-unavailable" : "host-unavailable"}).`);
            return;
          }
          const uri = vscode.Uri.from({
            scheme: vscode.env.uriScheme,
            authority: activationContext.extension.id,
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
          log(`tab ${tabId}: desktop notification ${notice.kind} ${submitted === null ? "suppressed (unsupported-platform)" : "sent"}.`);
        },
        onError: (tabId, kind) => log(`tab ${tabId}: desktop notification ${kind} failed (submission-failed).`),
        onSuppressed: logNotificationSuppression,
      }),
    };
  }
  return turnNotifier.notifier;
}

function logNotificationSuppression(tabId: string, kind: TurnNotice["kind"], reason: NotificationSuppression | "aborted"): void {
  log(`tab ${tabId}: desktop notification ${kind} suppressed (${reason}).`);
}

function notificationSuppression(index: SessionIndex, tabId: string): NotificationSuppression | null {
  const active = editorInFrontConversation(index) === tabId;
  const visible = stateOf(tabId)?.panel?.visible ?? active;
  return desktopNotificationSuppression(
    vscode.workspace.getConfiguration("omp").get<boolean>("desktopNotifications", true),
    vscode.window.state.focused,
    visible,
    active,
  );
}

/**
 * Keep the context keys in step with the panel on screen, so the Stop keybinding is live
 * only where a stop has a subject it can name, and never where Escape has a nearer
 * meaning (an open `@`-completion popup).
 */
function refreshGuestContext(): void {
  const visible = activePanelTab();
  const activity = visible === null ? undefined : turnActivities.get(visible.tabId);
  const mode = visible?.mode ?? "";
  void vscode.commands.executeCommand("setContext", "omp.sessionMode", mode);
  void vscode.commands.executeCommand("setContext", "omp.sessionTransitionPending", visible !== null && (visible.transitioning || pendingSessionViewChanges.has(visible)));
  void vscode.commands.executeCommand("setContext", STREAMING_CONTEXT, mode === "chat" && activity?.streaming === true);
  void vscode.commands.executeCommand(
    "setContext",
    COMPOSER_POPUP_CONTEXT,
    visible !== null && composerPopupTabs.has(visible.tabId),
  );
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
/**
 * Chat tabs whose OMP child reports a subagent that is running or has messages queued, which its
 * own settle state ignores (see {@link hasLiveSubagents}): a parked agent revived by an IRC
 * message is in the registry but is neither a job of the parent nor in the lifecycle-frame roster.
 */
const subagentWork = new Map<string, boolean>();
const subagentWatches = new Map<string, ReturnType<typeof setInterval>>();
const SUBAGENT_WORK_POLL_MS = 3_000;
const SUBAGENT_WORK_MAX_FAILURES = 3;

function setSubagentWork(index: SessionIndex, tabId: string, active: boolean): void {
  if ((subagentWork.get(tabId) ?? false) === active) return;
  if (active) subagentWork.set(tabId, true); else subagentWork.delete(tabId);
  const model = chat.sessionOf(tabId)?.model;
  if (model !== undefined) applyTurnActivity(index, tabId, model, false);
}

function stopSubagentWatch(index: SessionIndex | null, tabId: string): void {
  const timer = subagentWatches.get(tabId);
  if (timer !== undefined) clearInterval(timer);
  subagentWatches.delete(tabId);
  if (index !== null) setSubagentWork(index, tabId, false); else subagentWork.delete(tabId);
}

/** Ask a verified chat child for its registry subagents until the channel it was started on changes. */
function watchSubagentWork(index: SessionIndex, tabId: string, client: HostControlClient): void {
  stopSubagentWatch(null, tabId);
  let failures = 0;
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return;
    if (stateOf(tabId)?.control?.client !== client || !isOpenControlClient(client)) { stopSubagentWatch(index, tabId); return; }
    inFlight = true;
    void client.subagentWork().then(active => {
      failures = 0;
      if (stateOf(tabId)?.control?.client === client) setSubagentWork(index, tabId, active);
    }, error => {
      if (++failures < SUBAGENT_WORK_MAX_FAILURES) return;
      log(`tab ${tabId}: subagent work observation stopped (${describeControlError(error)})`);
      stopSubagentWatch(index, tabId);
    }).finally(() => { inFlight = false; });
  }, SUBAGENT_WORK_POLL_MS);
  timer.unref?.();
  subagentWatches.set(tabId, timer);
}

function applyTurnActivity(index: SessionIndex, tabId: string, model: ChatModel, baseline: boolean): void {
  const previous = turnActivities.get(tabId) ?? null;
  const observed = turnActivity(model);
  const activity = observed !== null && subagentWork.get(tabId) === true ? withRegistrySubagentWork(observed) : observed;
  if (activity === null) {
    // A conversation that is not live has no turn to report; what it last said is dropped
    // so the next live report is a fresh baseline rather than a transition.
    turnActivities.delete(tabId);
    notifierFor(index).forget(tabId);
    refreshGuestContext();
    if (previous !== null) refreshLauncher();
    return;
  }
  turnActivities.set(tabId, activity);
  if (baseline || previous === null || previous.settled !== activity.settled) {
    log(`tab ${tabId}: desktop notification Chat observation (${baseline ? "baseline" : "live"}; settled=${activity.settled}; prompt=${activity.promptStatus ?? "none"}; completion=${activity.completionOutcome ?? "none"}; pending=${activity.pendingRequest !== null}).`);
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
  stopSubagentWatch(null, tabId);
  turnActivities.delete(tabId);
  composerPopupTabs.delete(tabId);
  footerBindings.get(tabId)?.observer?.dispose();
  cancelControlPicker(tabId);
  footerBindings.delete(tabId);
  notifierFor(index).forget(tabId);
  refreshGuestContext();
}

// Chat host lifecycle events

/** Phases in which a conversation's process is starting, attaching or serving. */
function rpcPhaseIsRunning(phase: ChatPhase): boolean {
  return phase === "starting" || phase === "attaching" || phase === "resyncing" || phase === "live";
}

/**
 * Shut down the broker of a host this window just proved stopped, and forget its slot.
 *
 * See {@link retireStoppedRpcBroker}: without this the broker outlives its child for as long as
 * the machine runs. A refusal (the child not proven gone) leaves the broker and its slot exactly
 * as they were, and is only logged.
 */
async function retireBroker(tabId: string, runtime: SessionHostRuntime): Promise<void> {
  const result = await retireStoppedRpcBroker(runtime);
  log(`tab ${tabId}: ${result.detail}`);
  if (result.retired) await brokerSlots?.forget(runtime.identity.slot).catch(() => undefined);
}

/**
 * The chat process of a tab ended without this window asking for it.
 *
 * One lifecycle operation: clearing the runtime, proving the exit through the broker,
 * releasing control material and the claim, and recording the stopped intent. A close,
 * reload or relaunch that reached the tab's gate first replaced or cleared the runtime, and
 * this notification then describes a process this window no longer drives, so it does
 * nothing.
 */
async function handleRpcHostExited(
  context: vscode.ExtensionContext,
  index: SessionIndex,
  tabId: string,
  runtime: RpcHostRuntime,
): Promise<void> {
  await index.lifecycle.run(tabId, async lease => {
    const current = stateOf(tabId);
    if (current === undefined || current.runtime !== runtime) return;
    // The tab's last restore outcome described a host that is no longer running; what
    // the index records from here on is the launcher's status.
    outcomes.delete(tabId);
    const ownerGeneration = index.get(tabId)?.ownership?.ownerGeneration ?? null;
    log(`tab ${tabId}: the OMP process exited`);
    const broker = await attachBrokerClient();
    if (broker === null) { fenceSessionAdmission(index, current, true); return; }
    const stop = await waitForManagedRootExit(runtime, broker, 1_000);
    log(`native exit ${runtime.pid}: ${stop.diagnosticDetail ?? stop.detail}`);
    if (!stop.writerGone) {
      current.controlFailure = stop.detail;
      fenceSessionAdmission(index, current, true);
      return;
    }
    current.runtime = null;
    stopTerminalForTab(current.slotId);
    current.transitioning = false;
    disposeControlChannel(current);
    await retireBroker(tabId, runtime);
    // A writer that exited is a stopped session: the durable intent is what keeps its
    // row stopped across a reload instead of being re-launched.
    await index.setRunIntent(tabId, "stopped", stop.detail);
    // Control material is dropped only for a stop this window can prove.
    if (stop.writerGone) await releaseHostControl(context, tabId, ownerGeneration);
    else current.controlFailure = stop.detail;
    try {
      const result = await index.closeSession(tabId, { confirmedStopped: stop.writerGone, detail: stop.detail }, lease);
      log(`tab ${tabId}: closeSession released=${result.released} (${result.detail})`);
      if (!result.released) {
        showError(
          "This session could not finish closing. Refresh Sessions before resuming it; see OMP Desk output for details.",
        );
      }
    } catch (error) {
      log(`tab ${tabId}: closeSession failed: ${messageOf(error)}`);
      showError(`Session ownership could not be reconciled after the OMP process exited: ${messageOf(error)}`);
    }
    pushSessionView(index, current);
    refreshLauncher();
  });
}

/**
 * Bind a new conversation to the exact file its process reported.
 *
 * The process learned the path from `get_state.sessionFile`: it is the identity of the
 * conversation, so the draft row is promoted to it (keeping the tab) under the tab's
 * lifecycle, and a resumed session whose reported file differs was already refused by the
 * chat session itself.
 */
async function bindConversationIdentity(
  index: SessionIndex,
  tabId: string,
  runtime: SessionHostRuntime,
  sessionFile: string,
  sessionId: string,
): Promise<void> {
  await index.lifecycle.run(tabId, async lease => {
    const current = stateOf(tabId);
    if (current === undefined || current.runtime !== runtime) return;
    // The id is recorded the moment it is known — a new session's file does not exist until its
    // first message, but a re-adopt after any restart needs the id to tell this session from a switch.
    const recorded = await index.recordHostSessionId(tabId, sessionId, lease);
    if (!recorded) log(`tab ${tabId}: the session id ${sessionId} conflicts with the one this row recorded and was not recorded`);
    const entry = index.get(tabId);
    if (entry === null || entry.sessionFile !== null) return;
    const pending = pendingIdentityFiles.get(tabId);
    // Repeated native snapshots report the same allocated path before OMP writes it.
    // Keep its retry chain: restarting binding would also invalidate every in-flight
    // Sessions projection even though no conversation state changed.
    if (pending?.runtime === runtime && pending.sessionId === sessionId &&
        (pending.sessionFile === sessionFile || controlPathEquals(pending.sessionFile, sessionFile))) return;
    clearTimeout(pending?.timer ?? undefined);
    const promotion = await index.promoteDraft(tabId, sessionFile, lease);
    if (promotion.status === "promoted") {
      pendingIdentityFiles.delete(tabId);
      log(`tab ${tabId}: bound to the session file ${sessionFile}`);
      void applyChatTabAppearance(activationContext as vscode.ExtensionContext, index, tabId);
      // The document could not be committed while the session had no file: the binding a
      // surviving page authenticates against needs the exact file, so it is committed now.
      void commitBridgeDocument(tabId);
      refreshBridgeReadiness(tabId);
    } else {
      // OMP creates the file lazily (first message), so the exact path is remembered and bound as
      // soon as the file exists.
      pendingIdentityFiles.set(tabId, { runtime, sessionFile, sessionId, lastTry: Date.now(), timer: null, lastFailureDetail: promotion.detail });
      scheduleIdentityRetry(index, tabId);
      log(`tab ${tabId}: the session file ${sessionFile} is not bound yet: ${promotion.detail}`);
    }
    refreshLauncher();
  });
}

/** New sessions whose exact file is known but not written yet, by tab. */
interface PendingIdentity {
  readonly runtime: SessionHostRuntime;
  readonly sessionFile: string;
  readonly sessionId: string;
  lastFailureDetail: string;
  lastTry: number;
  timer: ReturnType<typeof setTimeout> | null;
}
const pendingIdentityFiles = new Map<string, PendingIdentity>();
const IDENTITY_RETRY_MS = 750;

/**
 * Keep trying to bind a pending new session until OMP has written its file.
 *
 * OMP writes the file lazily, a moment *after* the turn's events have gone by, so retrying
 * only when an event arrives can miss the write entirely: the last event of a turn lands
 * before the file exists and nothing else follows. A row left unbound has no session file,
 * which a later restart cannot re-adopt. The chain stops the moment the row is bound, the
 * conversation's process changes, or the pending entry is replaced.
 */
function scheduleIdentityRetry(index: SessionIndex, tabId: string): void {
  const pending = pendingIdentityFiles.get(tabId);
  if (pending === undefined || pending.timer !== null) return;
  const timer = setTimeout(() => {
    pending.timer = null;
    void retryPendingIdentity(index, tabId).finally(() => {
      if (pendingIdentityFiles.get(tabId) === pending) scheduleIdentityRetry(index, tabId);
    });
  }, IDENTITY_RETRY_MS);
  timer.unref?.();
  pending.timer = timer;
}

/** Bind a pending new session to its file once OMP has written it; also called on conversation activity. */
function retryPendingIdentity(index: SessionIndex, tabId: string): Promise<void> {
  const pending = pendingIdentityFiles.get(tabId);
  if (pending === undefined || Date.now() - pending.lastTry < IDENTITY_RETRY_MS) return Promise.resolve();
  if (stateOf(tabId)?.runtime !== pending.runtime || index.get(tabId)?.sessionFile !== null) {
    clearTimeout(pending.timer ?? undefined);
    pendingIdentityFiles.delete(tabId);
    return Promise.resolve();
  }
  pending.lastTry = Date.now();
  return index.lifecycle
    .run(tabId, async lease => {
      if (stateOf(tabId)?.runtime !== pending.runtime || pendingIdentityFiles.get(tabId) !== pending) return;
      const promotion = await index.promoteDraft(tabId, pending.sessionFile, lease);
      if (promotion.status !== "promoted") {
        if (promotion.detail !== pending.lastFailureDetail) {
          pending.lastFailureDetail = promotion.detail;
          log(`tab ${tabId}: the session file ${pending.sessionFile} is not bound yet: ${promotion.detail}`);
        }
        return;
      }
      clearTimeout(pending.timer ?? undefined);
      pendingIdentityFiles.delete(tabId);
      log(`tab ${tabId}: bound to the session file ${pending.sessionFile}`);
      void applyChatTabAppearance(activationContext as vscode.ExtensionContext, index, tabId);
      void commitBridgeDocument(tabId);
      refreshBridgeReadiness(tabId);
      refreshLauncher();
    })
    .catch(error => log(`tab ${tabId}: binding the session file failed: ${messageOf(error)}`));
}


/** These are editor presentation preferences, never OMP commands. */
function readChatDisplayPreferences(): ChatDisplayPreferences {
  return {
    toolCallDetail: vscode.workspace.getConfiguration("omp").get<string>("toolCallDetail", "overview") === "detailed" ? "detailed" : "overview",
    accessibilitySupport: vscode.workspace.getConfiguration("editor").get<string>("accessibilitySupport", "auto") === "on",
    thinkingExpanded: activationContext?.globalState.get<unknown>(THINKING_EXPANDED_KEY) === true,
    toolsExpanded: activationContext?.globalState.get<unknown>(TOOLS_EXPANDED_KEY) === true,
  };
}

/** The TUI's `Ctrl+T` / `Ctrl+O`: one remembered default for every Chat in this VS Code profile. */
const THINKING_EXPANDED_KEY = "omp.chat.thinkingExpanded";
const TOOLS_EXPANDED_KEY = "omp.chat.toolsExpanded";

async function toggleTranscriptDefault(key: typeof THINKING_EXPANDED_KEY | typeof TOOLS_EXPANDED_KEY): Promise<void> {
  if (activeChatTab() === null || activationContext === undefined) return;
  await activationContext.globalState.update(key, activationContext.globalState.get<unknown>(key) !== true);
  chat.refreshDisplayPreferences();
}

async function writeChatToolDetail(value: ChatDisplayPreferences["toolCallDetail"]): Promise<void> {
  await vscode.workspace.getConfiguration("omp").update("toolCallDetail", value, vscode.ConfigurationTarget.Global);
}

function refreshChatDisplayPreferences(event: vscode.ConfigurationChangeEvent): void {
  if (event.affectsConfiguration("omp.toolCallDetail") || event.affectsConfiguration("editor.accessibilitySupport")) {
    chat.refreshDisplayPreferences();
  }
}
/**
 * A web link the user clicked in a page, already re-validated as `http(s)` by the caller: an editor
 * tab (Simple Browser) or the external browser. Only the origin is logged, never the path or query.
 */
async function openPageWebLink(url: string, mode: WebLinkMode): Promise<void> {
  log(`web link: opening ${new URL(url).origin} in ${mode === "external" ? "the external browser" : "an editor tab"}`);
  await openWebLink(vscode, url, mode);
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

/**
 * One conversation event from the chat runtime, routed to the extension's own concerns:
 * activity and diagnostics for a model change, the redraw and readiness for a phase, the
 * lifecycle for an exit, and the identity binding for a learned session file.
 */
function handleChatEvent(context: vscode.ExtensionContext, index: SessionIndex, tabId: string, event: ChatRuntimeEvent): void {
  switch (event.type) {
    case "catalogue":
      if (toolsTarget(index)?.key === chat.sessionOf(tabId)) toolsController?.refresh();
      return;
    case "model":
      applyTurnActivity(index, tabId, event.model, event.baseline);
      if (event.baseline) toolsController?.sync();
      const pickerModel = footerBindings.get(tabId);
      if (pickerModel?.modelId && (pickerModel.modelId !== event.model.state?.model?.id || pickerModel.message.provider !== event.model.state?.model?.provider)) cancelControlPicker(tabId);
      if (event.baseline || pickerModel?.modelId !== event.model.state?.model?.id ||
        pickerModel?.message.provider !== event.model.state?.model?.provider) void refreshSessionModels(index, tabId);
      refreshFooterMetadata(index, tabId, event.baseline);
      void retryPendingIdentity(index, tabId);
      if (event.baseline && !diagnosticsStageMeasured(tabId, "first-paint")) {
        diagnostics.succeed(tabId, "first-paint", { detail: "the first authoritative snapshot of the conversation" });
      }
      return;
    case "state": {
      const phase = event.payload.phase;
      logChatConnectionPhase(tabId, phase, event.payload.code, event.payload.exitReason);
      if (phase !== "live") cancelControlPicker(tabId);
      if (phase === "live") {
        const entry = index.get(tabId);
        const name = event.payload.title?.trim();
        if (entry !== null && name && event.payload.sessionId === entry.sessionId && entry.title !== name) {
          void index.recordConversationState(tabId, { title: name }).then(() => {
            refreshLauncher();
            return applyChatTabAppearance(context, index, tabId);
          }).catch(error => log(`Session title could not be refreshed: ${messageOf(error)}`));
        }
        if (!diagnosticsStageMeasured(tabId, "chat-live")) {
          diagnostics.succeed(tabId, "chat-live", { detail: "the conversation reached its live phase" });
        }
        void commitBridgeDocument(tabId);
        refreshBridgeReadiness(tabId);
        invalidateGuestControls(tabId);
        refreshFooterMetadata(index, tabId, true);
        refreshSessionCost(index, tabId);
        void refreshSessionModels(index, tabId);
      }
      if (phase === "stopped" && event.payload.code === "child-exited") {
        const runtime = stateOf(tabId)?.runtime ?? null;
        if (runtime?.kind === "chat") void handleRpcHostExited(context, index, tabId, runtime);
      }
      refreshLauncher();
      return;
    }
    case "identity": {
      const runtime = stateOf(tabId)?.runtime ?? null;
      if (runtime !== null) void bindConversationIdentity(index, tabId, runtime, event.sessionFile, event.sessionId);
      return;
    }
    case "open-url":
      void confirmOpenUrl(event);
      return;
    case "resume-requested":
      void resumeFromChat(context, index, tabId);
      return;
    case "restart-requested":
      void restartChat(context, index, tabId, event.nativeNonce);
      return;
    case "turn-ended":
      if (sessionModelRefreshOwed.has(tabId)) void refreshSessionModels(index, tabId);
      refreshFooterMetadata(index, tabId, true);
      refreshSessionCost(index, tabId);
      footerBindings.get(tabId)?.observer?.refresh();
      return;
    case "recovery":
      log(`tab ${tabId}: chat connection recovery (${event.reason}).`);
      return;
    case "extension-error":
      void vscode.window.showErrorMessage(`OMP extension: ${event.message}`);
      return;
  }
}

/**
 * The Resume button of a stopped or view-only Chat: start the session again through the same
 * admission as the Sessions row's Open (`openTab` → `index.restore`: ownership, claim and
 * one-writer checks), then report the outcome.
 *
 * A successful start shows itself — the conversation is attached again and the composer
 * becomes writable. Anything else is told to the page in its footer, with the reason the
 * admission gave, so the button is never answered with silence.
 */
async function resumeFromChat(context: vscode.ExtensionContext, index: SessionIndex, tabId: string): Promise<void> {
  const before = outcomes.get(tabId);
  try {
    await openTab(context, index, tabId, "resumed");
  } catch (error) {
    log(`tab ${tabId}: Resume from Chat failed: ${messageOf(error)}`);
    const reason = `The session could not be resumed: ${messageOf(error)}`;
    if (!chat.notify(tabId, reason) && !chat.has(tabId)) presentUnavailable(index, tabId, reason);
    return;
  }
  const phase = chat.stateOf(tabId)?.phase ?? null;
  if (phase === "live" || phase === "starting" || phase === "attaching" || phase === "resyncing") return;
  const outcome = outcomes.get(tabId);
  log(`tab ${tabId}: Resume from Chat did not start the session (${outcome?.status ?? "no outcome"})`);
  // A refused, failed or conflicting admission already put its reason on the page (banner and, for a
  // conflict, an error): `handleRestoreOutcome` presents every outcome that is not a running host.
  if (outcome !== undefined && outcome !== before && outcome.status !== "restored" && outcome.status !== "attached") return;
  // The admission was never reached (the editor or row changed, or this window still holds a process it could not
  // prove gone): say so in the footer, or on the page itself when no conversation is shown.
  const reason = stateOf(tabId)?.controlFailure ?? "The session could not be resumed. The OMP output channel has details.";
  if (!chat.notify(tabId, reason) && !chat.has(tabId)) presentUnavailable(index, tabId, reason);
}

/** The last connection-relevant phase logged per tab, so a restoration is reported against the failure it ends. */
const loggedChatPhases = new Map<string, ChatPhase>();

/**
 * Record a lost connection and its end in the output channel, including the bounded plain-text
 * diagnostic for an autonomous managed-RPC child exit.
 */
function logChatConnectionPhase(tabId: string, phase: ChatPhase, code: string | null, exitReason?: ChatExitReason): void {
  const previous = loggedChatPhases.get(tabId);
  if (phase === "failed" || phase === "stopped") {
    loggedChatPhases.set(tabId, phase);
    log(`tab ${tabId}: chat connection ${phase}${code === null ? "" : ` (${code})`}.`);
    if (phase === "stopped" && exitReason !== undefined) log(`tab ${tabId}: ${chatExitText(exitReason)}`);
  } else if (phase === "live") {
    loggedChatPhases.delete(tabId);
    if (previous === "failed") log(`tab ${tabId}: chat connection restored; the same session is live again.`);
  }
}

// Host control: the native model/thinking channel
//
// The channel is established only after the host proves it is the exact process
// this window launched (same pid, same kernel process generation, same pipe
// server) and completes the HMAC handshake. Until then host control is reported
// as unavailable, and a launch never depends on it succeeding.

/** A verified channel plus the tab it belongs to. */
interface ControlChannel {
  readonly tabId: string;
  readonly client: HostControlClient;
  readonly snapshot: ControlHostSnapshot | null;
}

/** What a launch needs to bootstrap the control channel. */
interface PreparedHostControl {
  readonly bootstrap: NativeControlBootstrap;
  readonly privateKeyPkcs8Pem: string;
}

interface EstablishControlInput {
  readonly directory: string;
  readonly slotId: string;
  readonly pid: number;
  readonly processCreation: string;
  readonly privateKeyPkcs8Pem: string;
  readonly expectation: HostControlExpectation;
  readonly activity: boolean;
  readonly work?: boolean;
  readonly subagents?: boolean;
  /** Only set when reattaching a process believed to be the same one. */
  readonly provenKey?: string | undefined;
}

function controlDirectory(context: vscode.ExtensionContext): string {
  return path.join(context.globalStorageUri.fsPath, "host-control");
}

/** Secrets are scoped to the claim's owner generation, so windows never share one. */
function recipientSecretName(ownerGeneration: string): string {
  return `omp.hostControl.recipient.${ownerGeneration}`;
}

function provenKeySecretName(ownerGeneration: string): string {
  return `omp.hostControl.key.${ownerGeneration}`;
}

function controlProcessRecordKey(ownerGeneration: string): string {
  return `omp.hostControl.process.${ownerGeneration}`;
}

function controlReleaseRecordKey(ownerGeneration: string): string {
  return `omp.hostControl.releasedSlots.${ownerGeneration}`;
}

/**
 * Remember that this window confirmed one launch's process stopped.
 *
 * Only a confirmed stop reaches here (the child exited and its broker reported it),
 * and the entry is keyed by the released slot so a later deletion proof
 * can never attribute it to another launch's store.
 */
async function rememberControlRelease(
  context: vscode.ExtensionContext,
  ownerGeneration: string,
  slotId: string,
): Promise<void> {
  const key = controlReleaseRecordKey(ownerGeneration);
  const known = context.globalState.get<readonly RecordedControlRelease[]>(key) ?? [];
  const next = [
    ...known.filter(entry => entry.slotId !== slotId),
    { slotId, releasedAt: new Date().toISOString() },
  ];
  await context.globalState.update(key, next.slice(-CONTROL_RELEASE_HISTORY));
}

/**
 * Generate this launch's recipient and persist its private half *before* the
 * process exists, so a launch can never outrun the key that decrypts its
 * rendezvous. A failure here is recorded as a visible unavailability; the
 * session still starts without the channel.
 *
 * `modulePath` is the verified copy staged outside the installed extension
 * folder: the native process preloads that copy, so a reinstall never has to wait
 * for this session to end.
 */
async function prepareHostControl(
  context: vscode.ExtensionContext,
  tabId: string,
  ownerGeneration: string,
  modulePath: string,
): Promise<PreparedHostControl | null> {
  try {
    const recipient = await createControlRecipient();
    await context.secrets.store(recipientSecretName(ownerGeneration), recipient.privateKeyPkcs8Pem);
    return {
      bootstrap: {
        defineName: CONTROL_RECIPIENT_DEFINE,
        publicRecipient: recipient.publicKeySpkiBase64url,
        modulePath,
        directory: controlDirectory(context),
        slotId: createControlSlotId(),
      },
      privateKeyPkcs8Pem: recipient.privateKeyPkcs8Pem,
    };
  } catch {
    setControlFailure(tabId, "the host-control recipient could not be prepared");
    return null;
  }
}

/** Launch, recovery and the native watch share one attempt for the exact runtime. */
const hostControlAttempts = new WeakMap<SessionHostRuntime, Promise<void>>();

async function singleFlightHostControl(runtime: SessionHostRuntime, connect: () => Promise<void>): Promise<void> {
  const pending = hostControlAttempts.get(runtime);
  if (pending !== undefined) return pending;
  const attempt = connect();
  hostControlAttempts.set(runtime, attempt);
  try { await attempt; }
  finally { if (hostControlAttempts.get(runtime) === attempt) hostControlAttempts.delete(runtime); }
}

/**
 * Establish the channel for a host this window just launched.
 *
 * The process generation is probed first and persisted with the ownership, so a
 * later reload can prove it is talking to the same kernel process rather than a
 * recycled pid.
 */
async function connectHostControl(
  context: vscode.ExtensionContext,
  index: SessionIndex,
  tabId: string,
  ownerGeneration: string,
  runtime: SessionHostRuntime,
  prepared: PreparedHostControl,
): Promise<void> {
  return singleFlightHostControl(runtime, () => connectHostControlAttempt(context, index, tabId, ownerGeneration, runtime, prepared));
}

async function connectHostControlAttempt(
  context: vscode.ExtensionContext,
  index: SessionIndex,
  tabId: string,
  ownerGeneration: string,
  runtime: SessionHostRuntime,
  prepared: PreparedHostControl,
): Promise<void> {
  const pid = runtime.pid;
  const attempt: ControlAttemptPlan = { runtime, pid };
  ownerGeneration = controlOwnerFor(runtime, ownerGeneration);
  if (runtime.kind === "chat") {
    const session = chat.sessionOf(tabId);
    if (session === null) return;
    await session.start();
    if (chat.sessionOf(tabId) !== session || session.phase !== "live" || stateOf(tabId)?.runtime !== runtime) return;
  }
  // The pinned generation is read with the same helper the control client later compares it
  // with, so the two readings are the same kind of value.
  let processCreation: string;
  try {
    processCreation = await queryControlProcessGeneration(pid);
  } catch (error) {
    if (mayReportControlFailure(attemptTargetFor(tabId), { runtime, pid, client: null })) {
      setControlFailure(tabId, `the process generation could not be read (${messageOf(error)})`);
    }
    return;
  }
  const record: RecordedControlProcess = {
    pid,
    processCreation,
    slotId: prepared.bootstrap.slotId,
    directory: prepared.bootstrap.directory,
    activity: true,
    work: true,
    subagents: true,
  };
  const recorded = await index.lifecycle.run(tabId, async () => {
    if (stateOf(tabId)?.runtime !== runtime) return false;
    await context.globalState.update(controlProcessRecordKey(ownerGeneration), record);
    return true;
  });
  if (!recorded) return;
  await establishControl(context, index, tabId, ownerGeneration, attempt, {
    directory: record.directory,
    slotId: record.slotId,
    pid,
    processCreation,
    privateKeyPkcs8Pem: prepared.privateKeyPkcs8Pem,
    activity: true,
    work: true,
    subagents: true,
    expectation: { sessionFile: runtime.kind === "terminal" ? null : runtime.sessionFile, cwd: runtime.cwd },
  });
}

/**
 * Re-establish the channel for a host that outlived this extension host.
 *
 * Only the previously persisted recipient is used, and the proven key is
 * supplied only when the recorded process is the one still running: with a
 * proven key a different candidate is refused by the client as host
 * replacement, which is exactly the check that keeps a recycled pid out.
 */
async function reconnectHostControl(
  context: vscode.ExtensionContext,
  index: SessionIndex,
  tabId: string,
  ownerGeneration: string,
  runtime: SessionHostRuntime,
): Promise<void> {
  return singleFlightHostControl(runtime, () => reconnectHostControlAttempt(context, index, tabId, ownerGeneration, runtime));
}

async function reconnectHostControlAttempt(
  context: vscode.ExtensionContext,
  index: SessionIndex,
  tabId: string,
  ownerGeneration: string,
  runtime: SessionHostRuntime,
): Promise<void> {
  const pid = runtime.pid;
  ownerGeneration = controlOwnerFor(runtime, ownerGeneration);
  // Captured before the secret reads below await, for the same reason as above.
  const attempt: ControlAttemptPlan = { runtime, pid };
  const record = context.globalState.get<RecordedControlProcess>(controlProcessRecordKey(ownerGeneration));
  const privateKey = await context.secrets.get(recipientSecretName(ownerGeneration));
  if (record === undefined || record.pid !== pid || privateKey === undefined) {
    diagnostics.notObserved(
      tabId,
      "host-control-verified",
      "no control recipient was recorded for this host, so the channel was never attempted",
    );
    if (mayReportControlFailure(attemptTargetFor(tabId), { runtime: attempt.runtime, pid: attempt.pid, client: null })) {
      setControlFailure(
        tabId,
        "no control recipient was recorded for this host, so host control stays unavailable for it",
      );
    } else {
      log(`tab ${tabId}: a reattach attempt no longer owns this tab; its result was ignored`);
    }
    return;
  }
  await establishControl(context, index, tabId, ownerGeneration, attempt, {
    directory: record.directory,
    slotId: record.slotId,
    pid,
    processCreation: record.processCreation,
    privateKeyPkcs8Pem: privateKey,
    activity: record.activity === true,
    work: record.work === true,
    subagents: record.subagents === true,
    expectation: { sessionFile: runtime.kind === "terminal" ? null : runtime.sessionFile, cwd: runtime.cwd },
    provenKey: await context.secrets.get(provenKeySecretName(ownerGeneration)),
  });
}

/** The tab facts a fence decision reads, or null when the tab no longer exists. */
function attemptTargetFor(tabId: string): { runtime: unknown | null; runtimePid: number | null; controlClient: unknown | null } | null {
  // Read, never create: evaluating a stale completion must not bring a tab back. A
  // held channel that has closed proves nothing, so it counts as no channel: the tab's
  // next attempt must not be blocked by a dead one.
  const state = stateOf(tabId);
  if (state === undefined) return null;
  const held = state.control?.client ?? null;
  return {
    runtime: state.runtime ?? null,
    runtimePid: state.runtime?.pid ?? null,
    controlClient: isOpenControlClient(held) ? held : null,
  };
}

async function establishControl(
  context: vscode.ExtensionContext,
  index: SessionIndex,
  tabId: string,
  ownerGeneration: string,
  attempt: ControlAttemptPlan,
  input: EstablishControlInput,
): Promise<void> {
  const runtime = stateOf(tabId)?.runtime;
  const stillCurrent = (): boolean =>
    mayReportControlFailure(attemptTargetFor(tabId), { runtime: attempt.runtime, pid: attempt.pid, client: null }) &&
    (runtime?.kind !== "terminal" || !runtime.stopping);
  let connected: HostControlVerifiedConnection | null = null;
  try {
    const provenKey = input.provenKey;
    if (provenKey !== undefined) {
      // A key this launch already proved identifies the host without the rendezvous
      // record, which is last-writer-wins per slot and no longer names the original
      // server once a subagent's server (older host builds) overwrote or removed it.
      const published = await readControlRendezvous(input.directory, input.slotId).catch(() => null);
      connected = await HostControlClient.connectWithProvenKey({
        slotId: input.slotId,
        directory: input.directory,
        provenKey,
        expectedPid: input.pid,
        expectedProcessCreationTime: input.processCreation,
        expectation: input.expectation,
        ...(published === null ? {} : { preferredPipeName: published.pipeName }),
      });
    }
    if (connected === null) {
      // With a proven key the host already published once, so a missing record is not
      // startup lag: the bounded wait only covers a launch that never connected.
      const rendezvous = await waitForControlRendezvous(input.directory, input.slotId, stillCurrent,
        provenKey !== undefined ? PROVEN_CONTROL_RENDEZVOUS_TIMEOUT_MS
          : runtime?.kind === "terminal" ? NATIVE_CONTROL_RENDEZVOUS_TIMEOUT_MS : CONTROL_RENDEZVOUS_TIMEOUT_MS);
      if (rendezvous === null) {
        // The wait above is an await: the tab may run another process now, or hold a
        // channel a newer attempt established, which this failure must not clear — nor
        // may it leave a verification failure on a tab this attempt no longer owns.
        if (stillCurrent()) {
          const reason = runtime?.kind !== "terminal"
            ? "The native host has no compatible control record. Use Reload to refresh a child from an older build."
            : provenKey !== undefined
              ? "Host control lost: the running OMP no longer serves a control endpoint this session can verify, so statuses and notifications are off. Reload the session to restore them."
              : "Waiting for the native host to publish its control record; statuses and notifications start when it connects.";
          diagnostics.fail(tabId, "host-control-verified", reason);
          setControlFailure(tabId, reason);
        } else {
          log(`tab ${tabId}: a control attempt that found no rendezvous no longer owns this tab; nothing was changed`);
        }
        return;
      }
      if (!stillCurrent()) return;
      connected = await HostControlClient.connectVerified({
        rendezvous,
        rendezvousDirectory: input.directory,
        recipientPrivateKeyPkcs8Pem: input.privateKeyPkcs8Pem,
        expectedPid: input.pid,
        expectedProcessCreationTime: input.processCreation,
        expectation: input.expectation,
        ...(provenKey === undefined ? {} : { provenKey }),
      });
    }
    if (!stillCurrent()) {
      connected.client.close();
      connected = null;
      return;
    }
    const verified = connected;
    if (verified.rotated) log(`tab ${tabId}: the host process (pid ${input.pid}) proved a rotated control key; the new key is pinned`);
    const snapshot = await verified.client.snapshot();
    // The connection awaited above: the tab's runtime may have been replaced (a
    // relaunch) or closed while it was in flight, and a client proved for the *old*
    // process must never be published into its successor's tab — nor over a channel a
    // newer attempt already established.
    await index.lifecycle.run(tabId, async () => {
      const state = stateOf(tabId);
      if (
        state === undefined ||
        !mayPublishControlChannel(attemptTargetFor(tabId), { runtime: attempt.runtime, pid: attempt.pid, client: verified.client })
      ) {
        log(`tab ${tabId}: a verified host-control channel was not published: this tab runs a different process now`);
        verified.client.close();
        connected = null;
        return;
      }
      // Persistence shares the stop/relaunch gate: an old completion can neither
      // resurrect a deleted key nor overwrite its successor's proven key.
      await context.secrets.store(provenKeySecretName(ownerGeneration), verified.key);
      state.control = { client: verified.client, snapshot, activity: input.activity, work: input.work === true, subagents: input.subagents === true };
      if (input.subagents === true && state.runtime?.kind === "chat") watchSubagentWork(index, tabId, verified.client);
      state.controlFailure = null;
      log(`tab ${tabId}: host control verified (pid ${input.pid}, instance ${snapshot.host.instanceId})`);
      diagnostics.succeed(tabId, "host-control-verified", {
        detail: `pid ${input.pid} · instance ${snapshot.host.instanceId}`,
      });
      invalidateGuestControls(tabId);
      void commitBridgeDocument(tabId);
      refreshBridgeReadiness(tabId);
    });
  } catch (error) {
    // A failure is only reported for the attempt that still owns the tab: reporting a
    // late failure would close the channel a newer attempt established, and would
    // leave a verification failure on a tab this attempt no longer owns. A client this
    // attempt connected but never published is closed here instead.
    const outcome = { runtime: attempt.runtime, pid: attempt.pid, client: connected?.client ?? null };
    if (mayReportControlFailure(attemptTargetFor(tabId), outcome)) {
      diagnostics.fail(tabId, "host-control-verified", describeControlError(error));
      setControlFailure(tabId, describeControlError(error));
    } else {
      log(`tab ${tabId}: a failed host-control attempt no longer owns this tab; its result was ignored`);
      connected?.client.close();
    }
  }
}

/** Bounded wait for the native side to publish its (non-secret) rendezvous. */
async function waitForControlRendezvous(
  directory: string,
  slotId: string,
  stillCurrent: () => boolean,
  timeoutMs: number,
): Promise<ControlRendezvous | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!stillCurrent()) return null;
    const record = await readControlRendezvous(directory, slotId).catch(() => null);
    if (record !== null) return record;
    if (Date.now() >= deadline) return null;
    await delay(CONTROL_RENDEZVOUS_POLL_MS);
  }
}

/**
 * Drop every control secret only after a stop this window could prove; the
 * caller passes a null generation when ownership is unknown, which closes the
 * channel but leaves the stored material for a later reconciliation.
 */
async function releaseHostControl(
  context: vscode.ExtensionContext,
  tabId: string,
  ownerGeneration: string | null,
): Promise<void> {
  const state = stateOf(tabId);
  if (state) {
    state.control?.client.close();
    state.control = null;
    state.controlFailure = null;
  }
  if (ownerGeneration !== null) {
    // The released slot is remembered *before* the launch record is dropped: the
    // deletion proof of that launch's store depends on it afterwards.
    const record = context.globalState.get<RecordedControlProcess>(controlProcessRecordKey(ownerGeneration));
    if (record !== undefined) await rememberControlRelease(context, ownerGeneration, record.slotId);
    await context.secrets.delete(recipientSecretName(ownerGeneration));
    await context.secrets.delete(provenKeySecretName(ownerGeneration));
    await context.globalState.update(controlProcessRecordKey(ownerGeneration), undefined);
    log(`tab ${tabId}: host-control material released after a confirmed stop`);
  }
}

function setControlFailure(tabId: string, detail: string): void {
  const state = stateOf(tabId);
  if (state) {
    state.control?.client.close();
    state.control = null;
    state.controlFailure = detail;
  }
  log(`tab ${tabId}: host control unavailable — ${detail}`);
}

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

/** The responder of one bound panel. */
function panelResponder(tabId: string, panel: vscode.WebviewPanel, actionSeq: unknown): GuestResponder {
  const state = stateOf(tabId);
  const runtime = state?.runtime ?? null;
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
      const route = bridgeRouteOf(tabId);
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
            if (!live() || bridgeRouteOf(tabId) !== route) {
              throw new HostControlRefusedError("closed", "This document was closed before native dispatch.", null);
            }
            reservation.verify();
          },
          settle: outcome => reservation.settle(outcome),
        };
      } catch (error) {
        log(`tab ${tabId}: a panel mutation was not admitted (${error instanceof BridgeAdmissionError ? error.code : "refused"})`);
        return null;
      }
    },
    invalidate: () => invalidateGuestControls(tabId),
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
  const state = stateOf(tabId);
  if (!state || !responder.live()) return;
  const session = chat.sessionOf(tabId);
  ensureFooterBinding(index, tabId);
  publishFooterMetadata(tabId);
  const reply = (message: GuestControlStateMessage): void => {
    if (stateOf(tabId) === state && chat.sessionOf(tabId) === session) responder.reply(message);
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
  if (state.transitioning || state.mode === "terminal") {
    reply(unavailable(state.transitioning ? "The session view is changing or its process is stopping." : "Chat model/thinking controls are unavailable in Terminal; use native TUI controls."));
    return;
  }
  if (session === null || session.phase !== "live") {
    reply(unavailable("This session is not live, so its model and thinking controls are not available."));
    return;
  }
  const entry = index.get(tabId);
  if (entry === null || entry.availability !== "live" || entry.ownership === null || entry.ownership.releasedAt !== null) {
    reply(unavailable("The session's held ownership is not verified yet."));
    return;
  }
  if (request.action === "snapshot" && request.picker !== undefined) cancelControlPicker();
  const stillCurrent = (): boolean =>
    responder.live() && stateOf(tabId) === state && !state.transitioning && state.mode === "chat" && chat.sessionOf(tabId) === session && session.phase === "live";
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
              ? await session.setModel(request.model!.provider, request.model!.id)
              : await session.setThinkingLevel(request.level!);
          admission.settle?.(
            outcome.status === "accepted" ? "applied" : outcome.status === "refused" ? "refused" : "unknown",
          );
          notice = outcome.status === "accepted" ? undefined : controlOutcomeNotice(outcome);
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
      const beforeModel = session.model.state?.model ?? null;
      if (request.picker === "model") {
        const listed = await session.getAvailableModels();
        if (listed.status !== "ok") {
          notice = listed.status === "refused" && listed.reason === "busy" ? "OMP is busy; choose a model after the turn ends." : "OMP could not list models. Nothing was changed.";
        } else {
          const models = listed.models.filter(model => model.provider.length > 0 && model.provider.length <= 200 &&
            model.id.length > 0 && model.id.length <= 200 && isSafeBoundaryText(model.provider) && isSafeBoundaryText(model.id))
            .map(model => ({ provider: model.provider, id: model.id,
              ...(model.name && model.name.length <= 200 && isSafeBoundaryText(model.name) ? { name: model.name } : {}) }));
          if (stillCurrent()) {
            recordSessionModels(index, tabId, models.length > 0);
            if (models.length === 0) await openProviderLogin(state.runtime, entry.scope.profile, entry.cwd);
            else {
              const picked = await pickControlModel(models, beforeModel, stillCurrent, tabId);
              if (picked === "provider-login") await openProviderLogin(state.runtime, entry.scope.profile, entry.cwd);
              else selectedModel = picked;
            }
          }
        }
      } else {
        const thinking = await session.getAvailableThinkingLevels();
        const sameModel = (): boolean => {
          const current = session.model.state?.model;
          return stillCurrent() && beforeModel?.provider === current?.provider && beforeModel?.id === current?.id;
        };
        if (thinking.status !== "ok") notice = thinking.status === "refused" && thinking.reason === "busy" ?
          "OMP is busy; choose a thinking level after the turn ends." : "OMP could not list thinking levels. Nothing was changed.";
        else if (sameModel() && thinking.levels.length > 0) selectedThinking = await pickControlThinking(
          thinking.levels.filter(level => level.length > 0 && level.length <= 64 && isSafeBoundaryText(level)),
          session.model.state?.thinkingLevel ?? null, sameModel, tabId);
        if (!sameModel() && stillCurrent()) notice = "The model changed while choosing a thinking level. Nothing was changed.";
      }
    }
    if (!stillCurrent()) {
      reply(unavailable("The session changed during this request.", notice ?? "The outcome is uncertain; no retry was sent."));
      return;
    }
    const liveState = session.model.state;
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

function controlOutcomeNotice(outcome: SendOutcome): string {
  switch (outcome.status) {
    case "accepted":
      return "OMP applied the change; the state shown was read back from the session.";
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
 * The installed OMP a CLI call runs: the exact one a host this window launched started from,
 * or — for a re-adopted host that did not record it — the one a launch would resolve now.
 */
async function executableFor(runtime: SessionHostRuntime | null): Promise<OmpCommand> {
  return runtime?.binary ?? (await resolveOmpBinary());
}

/** Cache only a successful default-profile catalogue; unresolved OMP adds no onboarding UI. */
function refreshDefaultProviderModels(): Promise<void> {
  defaultProviderModelsDirty = true;
  if (defaultProviderModelsRead !== null) return defaultProviderModelsRead;
  defaultProviderModelsRead = (async () => {
    do {
      defaultProviderModelsDirty = false;
      let executable: OmpCommand;
      try { executable = await executableFor(null); }
      catch {
        defaultProviderModelsAvailable = null;
        launcherProvider?.setProviderLoginRequired(false);
        continue;
      }
      try {
        const result = await runOmpCli(executable, ["models", "--json"], 15_000, {
          cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir(),
          env: ompCliScopeEnvironment(DEFAULT_OMP_PROFILE),
        });
        if (result.exitCode !== 0) continue;
        const parsed: unknown = JSON.parse(result.stdout);
        if (typeof parsed !== "object" || parsed === null || !("models" in parsed) || !Array.isArray(parsed.models)) continue;
        defaultProviderModelsAvailable = parsed.models.length > 0;
        launcherProvider?.setProviderLoginRequired(!defaultProviderModelsAvailable);
      } catch { log("Default-profile models could not be read; retaining the last availability."); }
    } while (defaultProviderModelsDirty);
  })().finally(() => { defaultProviderModelsRead = null; });
  return defaultProviderModelsRead;
}

/** Activation and the native login terminal are the only window-wide discovery triggers. */
function subscribeProviderLoginRefresh(context: vscode.ExtensionContext, index: SessionIndex): void {
  context.subscriptions.push(vscode.window.onDidCloseTerminal(terminal => {
    const ownedLoginClosed = terminal === providerLoginTerminal;
    if (ownedLoginClosed) providerLoginTerminal = null;
    if (!ownedLoginClosed && terminal.name !== "omp login") return;
    void refreshDefaultProviderModels();
    for (const entry of index.list()) void refreshSessionModels(index, entry.tabId);
  }));
  void refreshDefaultProviderModels();
}

function recordSessionModels(index: SessionIndex, tabId: string, available: boolean): void {
  ensureFooterBinding(index, tabId);
  const binding = footerBindings.get(tabId);
  if (!binding || binding.message.hasAvailableModels === available) return;
  binding.message = { ...binding.message, hasAvailableModels: available };
  publishFooterMetadata(tabId);
  void refreshDefaultProviderModels();
}

/** Read this conversation's own profile through RPC, never a per-session CLI. */
function refreshSessionModels(index: SessionIndex, tabId: string): Promise<void> {
  const pending = sessionModelReads.get(tabId);
  if (pending) return pending;
  const session = chat.sessionOf(tabId);
  if (session === null || session.phase !== "live") return Promise.resolve();
  const epoch = session.epoch;
  const read = session.getAvailableModels().then(listed => {
    if (chat.sessionOf(tabId) !== session || session.phase !== "live" ||
      epoch.nonce !== session.epoch.nonce || epoch.counter !== session.epoch.counter) return;
    if (listed.status === "ok") {
      sessionModelRefreshOwed.delete(tabId);
      recordSessionModels(index, tabId, listed.models.length > 0);
    } else if (listed.status === "refused" && listed.reason === "busy") sessionModelRefreshOwed.add(tabId);
  }).finally(() => { if (sessionModelReads.get(tabId) === read) sessionModelReads.delete(tabId); });
  sessionModelReads.set(tabId, read);
  return read;
}
/** Host-owned optional footer facts, sent to every editor showing this exact conversation. */
function publishFooterMetadata(tabId: string): void {
  const binding = footerBindings.get(tabId);
  if (!binding) return;
  for (const state of tabs.values()) {
    if (state.tabId !== tabId) continue;
    if (state.panel !== null) void state.panel.webview.postMessage(binding.message);
    else if (state.bridge?.documentId) state.bridge.endpoint.pushTerminal(state.bridge.documentId, binding.message);
  }
}

function ensureFooterBinding(index: SessionIndex, tabId: string): void {
  const entry = index.get(tabId);
  if (!entry) return;
  const cwd = stateOf(tabId)?.runtime?.cwd ?? entry.cwd;
  const existing = footerBindings.get(tabId);
  if (existing?.cwd === cwd) return;
  existing?.observer?.dispose();
  const binding = { cwd, modelId: null as string | null,
    message: { type: "omp:footer-metadata" as const, provider: null, windows: [], accounts: [], accountSelection: null, branch: null } as FooterMetadataMessage,
    observer: null as BranchObservation | null };
  footerBindings.set(tabId, binding);
  const current = (): boolean => footerBindings.get(tabId) === binding && (stateOf(tabId)?.runtime?.cwd ?? index.get(tabId)?.cwd) === cwd;
  const publish = (branch: string | null): void => {
    if (!current()) return;
    binding.message = { ...binding.message, branch };
    publishFooterMetadata(tabId);
  };
  binding.observer = observeSessionBranch(cwd, undefined, publish);
  const extension = vscode.extensions?.getExtension<{ getAPI(version: 1): GitApi }>("vscode.git");
  if (extension) void Promise.resolve(extension.isActive ? extension.exports : extension.activate()).then(exports => {
    if (!current()) return;
    const api = exports.getAPI(1); // Keep the CLI observer if Git is disabled/unavailable.
    binding.observer?.dispose();
    binding.observer = observeSessionBranch(cwd, api, publish);
  }).catch(() => log("Git footer observation could not activate the built-in Git extension."));
}

/** Session cost has its own attach/end readback; it must not inherit the quota cache's five-minute throttle. */
function refreshSessionCost(index: SessionIndex, tabId: string): void {
  ensureFooterBinding(index, tabId);
  const binding = footerBindings.get(tabId);
  const session = chat.sessionOf(tabId);
  const runtime = stateOf(tabId)?.runtime;
  if (!binding) return;
  binding.message = { ...binding.message, sessionCost: undefined };
  publishFooterMetadata(tabId);
  if (!session || session.phase !== "live" || !runtime) return;
  const epoch = session.epoch;
  void session.readSessionCost().then(cost => {
    if (footerBindings.get(tabId) !== binding || chat.sessionOf(tabId) !== session || stateOf(tabId)?.runtime !== runtime ||
      epoch.nonce !== session.epoch.nonce || epoch.counter !== session.epoch.counter) return;
    binding.message = { ...binding.message, sessionCost: cost ?? undefined };
    publishFooterMetadata(tabId);
  });
}

function refreshFooterMetadata(index: SessionIndex, tabId: string, refreshUsage: boolean): void {
  ensureFooterBinding(index, tabId);
  const binding = footerBindings.get(tabId);
  const session = chat.sessionOf(tabId);
  const entry = index.get(tabId);
  const runtime = stateOf(tabId)?.runtime;
  if (!binding || !entry) return;
  const model = session?.model.state?.model ?? null;
  const changed = binding.message.provider !== model?.provider || binding.modelId !== model?.id;
  if (!refreshUsage && !changed) return;
  binding.modelId = model?.id ?? null;
  if (!model || !runtime) {
    binding.message = { ...binding.message, provider: null, windows: [], accounts: [], accountSelection: null };
    publishFooterMetadata(tabId);
    return;
  }
  // Resolve the exact installation before selecting the scope cache; never join different cwd/profile installs.
  void executableFor(runtime).then(async executable => {
    if (footerBindings.get(tabId) !== binding || chat.sessionOf(tabId) !== session || stateOf(tabId)?.runtime !== runtime) return;
    const scope = JSON.stringify([executable.command, executable.prefixArgs, entry.scope.profile ?? DEFAULT_OMP_PROFILE, runtime.cwd]);
    let cache = usageCaches.get(scope);
    if (!cache) { cache = new ProviderUsageCache(Date.now, log); usageCaches.set(scope, cache); }
    binding.message = { ...binding.message, provider: model.provider, ...cache.get(model.provider, model.id) };
    publishFooterMetadata(tabId);
    const usage = await cache.refresh(model.provider, model.id, () => runOmpCli(executable,
      [...PROVIDER_USAGE_ARGS, "--provider", model.provider], PROVIDER_USAGE_TIMEOUT_MS,
      { cwd: runtime.cwd, env: ompCliScopeEnvironment(entry.scope.profile) }));
    if (footerBindings.get(tabId) !== binding || chat.sessionOf(tabId) !== session || stateOf(tabId)?.runtime !== runtime ||
      session?.model.state?.model?.provider !== model.provider || session?.model.state?.model?.id !== model.id) return;
    binding.message = { ...binding.message, provider: model.provider, ...usage };
    publishFooterMetadata(tabId);
  }).catch(() => log("Provider usage executable resolution failed; retaining the last value."));
}


/**
 * Start the native interactive provider login in a visible terminal.
 *
 * `omp login` prompts, opens a browser and reads a pasted redirect URL back; this extension
 * starts it and captures nothing — no output is read, no credential is stored or seen, and
 * the terminal is the user's to drive. The command runs in the session's profile scope, so
 * the credential lands where the session will read it.
 */
async function openProviderLogin(runtime: SessionHostRuntime | null, profile: string | null, cwd: string): Promise<void> {
  if (providerLoginOpening || providerLoginTerminal !== null) return;
  providerLoginOpening = true;
  try { await launchProviderLogin(runtime, profile, cwd); }
  finally { providerLoginOpening = false; }
}

/** Both callers hold the window's login-open guard, including their asynchronous preflight. */
async function launchProviderLogin(runtime: SessionHostRuntime | null, profile: string | null, cwd: string): Promise<void> {
  let executable: OmpCommand;
  try {
    executable = await executableFor(runtime);
  } catch (error) {
    showError(`The installed OMP could not be resolved, so no provider login was started: ${messageOf(error)}`);
    return;
  }
  providerLoginTerminal = openProviderLoginTerminal({
    args: ["login"],
    executable,
    cwd,
    env: ompCliScopeEnvironment(profile),
    name: "omp login",
  });
}


/**
 * Command-palette entry for the native provider login; never another tab's host. From a session's tab it logs in
 * within that session's profile. Without one it still works: a new user must log in before any session can start,
 * so it uses the default profile, or asks when the indexed sessions use more than one profile.
 */
async function loginProviderFromPalette(index: SessionIndex): Promise<void> {
  if (providerLoginOpening || providerLoginTerminal !== null) return;
  providerLoginOpening = true;
  try {
    const tabId = index.activeTabId;
    const runtime = tabId === null ? null : stateOf(tabId)?.runtime ?? null;
    if (tabId !== null && runtime !== null) {
      await launchProviderLogin(runtime, index.get(tabId)?.scope.profile ?? null, runtime.cwd);
      return;
    }
    const profiles = [...new Set(index.list().map(entry => entry.scope.profile ?? DEFAULT_OMP_PROFILE))].sort();
    let profile: string = DEFAULT_OMP_PROFILE;
    if (profiles.length > 1 || (profiles.length === 1 && profiles[0] !== DEFAULT_OMP_PROFILE)) {
      const choices = profiles.includes(DEFAULT_OMP_PROFILE) ? profiles : [DEFAULT_OMP_PROFILE, ...profiles];
      const picked = await vscode.window.showQuickPick(choices, { title: "Log In to Provider", placeHolder: "OMP profile to log in with" });
      if (picked === undefined) return;
      profile = picked;
    }
    await launchProviderLogin(null, profile, vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir());
  } finally { providerLoginOpening = false; }
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
  const focused = activePanelTab();
  const state = focused ?? editorRecency.order().map(slot => tabs.get(slot)).find(tab => tab?.panel !== null && tab?.tabId != null && tab.shellSlot === null);
  if (!state || state.tabId === null || state.shellSlot !== null) return null;
  const tabId = state.tabId;
  const runtime = state.runtime;
  const session = state.mode === "chat" ? chat.sessionOf(tabId) : null;
  const channel = activeControl(index, tabId);
  const binding = channel?.client.latestHost;
  return {
    key: session ?? runtime ?? state,
    generation: JSON.stringify([state.slotId, tabId, state.mode, session?.epoch, session?.sessionFile, session?.sessionId,
      binding?.instanceId, binding?.epoch, binding?.sessionFile]),
    mode: state.mode,
    running: passiveReasonForSlot(state.slotId) === null && !state.transitioning &&
      (state.mode === "chat" ? session?.phase === "live" : launcherFacts(tabId).running),
    commands: session?.model.commands ?? [],
    readDescriptors: session === null ? null : () => session.readToolDescriptors(),
    readTools: channel === null ? null : async () => {
      const list = await channel.client.listTools();
      const current = activeControl(index, tabId);
      const host = channel.client.latestHost;
      return stateOf(tabId)?.runtime === runtime && current?.client === channel.client &&
        host?.instanceId === binding?.instanceId && host?.epoch === binding?.epoch &&
        (session === null || (host?.sessionFile !== null && host?.sessionFile !== undefined &&
          session.sessionFile !== null && controlPathEquals(host.sessionFile, session.sessionFile))) ? list : null;
    },
  };
}

/** Command-palette controls never fall back to another tab's host. */
function activeControl(index: SessionIndex, tabId: string | null = index.activeTabId): ControlChannel | null {
  if (tabId === null) return null;
  const state = stateOf(tabId);
  const entry = index.get(tabId);
  const runtime = state?.runtime;
  const control = state?.control;
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
  const failure = index.activeTabId === null ? null : stateOf(index.activeTabId)?.controlFailure ?? null;
  return failure === null
    ? "Host control is not established for the selected session. Open it and run this command again."
    : `Host control is unavailable for the selected session: ${failure}`;
}

function describeControlError(error: unknown): string {
  if (error instanceof HostControlRefusedError) return `request refused (${error.code})`;
  if (error instanceof HostControlIdentityError) {
    return error.reason === "key-changed"
      ? "Host control refused: the control record belongs to a different process than this session's. Reload the session to restore statuses and notifications."
      : `host identity check failed (${error.reason})`;
  }
  if (error instanceof HostControlUnavailableError) return "native host connection unavailable";
  if (error instanceof HostControlConfigurationError) return "host-control configuration invalid";
  return "unexpected host-control failure";
}

/** Close and forget one tab's verified control channel; the failure text is cleared with it. */
function disposeControlChannel(state: TabState): void {
  state.control?.client.close();
  state.control = null;
  state.controlFailure = null;
}

function describeModel(model: { readonly provider: string; readonly id: string } | null | undefined): string {
  return model === null || model === undefined ? "unknown model" : `${model.provider}/${model.id}`;
}


/** The live rpc session of the active tab, or `null` (with the reason shown) when there is none. */
function activeLiveSession(index: SessionIndex): { readonly tabId: string; readonly session: RpcSession } | null {
  const tabId = index.activeTabId;
  const state = tabId === null ? undefined : stateOf(tabId);
  if (state?.mode === "terminal" || state?.transitioning) {
    showWarning(state.transitioning ? "The session is changing view or stopping." : "Chat model/thinking controls are unavailable in Terminal; use the native TUI.");
    return null;
  }
  const session = tabId === null ? null : chat.sessionOf(tabId);
  if (tabId === null || session === null || session.phase !== "live") {
    showInfo("Open a running OMP session first: the model and thinking level belong to a live session.");
    return null;
  }
  return { tabId, session };
}

async function showHostControls(index: SessionIndex): Promise<void> {
  const active = activeLiveSession(index);
  if (active === null) return;
  const channel = activeControl(index);
  const snapshot = channel === null ? stateOf(active.tabId)?.control?.snapshot ?? null : await refreshControlSnapshot(channel);
  const live = active.session.model.state;
  if (live === null) {
    showInfo("The session has not reported its model yet.");
    return;
  }
  log(`control[${active.tabId}]: model: ${describeModel(live.model)}, thinking: ${live.thinkingLevel ?? "unknown"}`);
  if (snapshot !== null) {
    log(`control[${active.tabId}]: host: instance ${snapshot.host.instanceId}, epoch ${snapshot.host.epoch}`);
    log(`control[${active.tabId}]: session file: ${snapshot.host.sessionFile ?? "not materialized"}`);
  }
  showInfo(`The session runs ${describeModel(live.model)} with thinking ${live.thinkingLevel ?? "unknown"}. See the OMP output channel for details.`);
}


async function selectHostModel(index: SessionIndex): Promise<void> {
  const active = activeLiveSession(index);
  if (active === null) return;
  const listed = await active.session.getAvailableModels();
  if (listed.status === "refused") {
    showInfo(listed.reason === "busy" ? "OMP is busy with a turn; select a model when it finishes." : "The session is not accepting commands right now.");
    return;
  }
  if (listed.status === "failed") {
    showInfo("OMP listed no selectable models.");
    return;
  }
  if (chat.sessionOf(active.tabId) !== active.session) return;
  recordSessionModels(index, active.tabId, listed.models.length > 0);
  const picked = await pickControlModel(listed.models, active.session.model.state?.model ?? null,
    () => chat.sessionOf(active.tabId) === active.session, active.tabId);
  if (!picked) return;
  if (chat.sessionOf(active.tabId) !== active.session) {
    showWarning("The selected session changed while choosing; nothing was changed.");
    return;
  }
  if (picked === "provider-login") {
    const entry = index.get(active.tabId);
    if (entry !== null) await openProviderLogin(stateOf(active.tabId)?.runtime ?? null, entry.scope.profile, entry.cwd);
    return;
  }
  const outcome = await active.session.setModel(picked.provider, picked.id);
  showInfo(controlOutcomeNotice(outcome));
}

async function selectHostThinking(index: SessionIndex): Promise<void> {
  const active = activeLiveSession(index);
  if (active === null) return;
  const current = active.session.model.state?.thinkingLevel;
  const listed = await active.session.getAvailableThinkingLevels();
  if (listed.status !== "ok" || listed.levels.length === 0) {
    showInfo("OMP listed no selectable thinking levels.");
    return;
  }
  const picked = await pickControlThinking(listed.levels, current ?? null,
    () => chat.sessionOf(active.tabId) === active.session, active.tabId);
  if (!picked) return;
  if (chat.sessionOf(active.tabId) !== active.session) {
    showWarning("The selected session changed while choosing; nothing was changed.");
    return;
  }
  const outcome = await active.session.setThinkingLevel(picked);
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
        { runtime: state.runtime ?? null, runtimePid: state.runtime?.pid ?? null, controlClient: state.control?.client ?? null },
        channel.client,
      )
    ) {
      if (state.control) state.control.snapshot = snapshot;
    }
    return snapshot;
  } catch (error) {
    const state = stateOf(channel.tabId);
    const target =
      state === undefined
        ? null
        : { runtime: state.runtime ?? null, runtimePid: state.runtime?.pid ?? null, controlClient: state.control?.client ?? null };
    if (mayReportControlFailure(target, { runtime: null, pid: null, client: channel.client })) {
      setControlFailure(channel.tabId, describeControlError(error));
    } else {
      log(`tab ${channel.tabId}: a failed control read back was ignored: this tab holds a different channel now`);
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
  if (key === null) return undefined;
  const direct = tabs.get(key);
  if (direct !== undefined) return direct;
  if (!isPanelTabId(key)) return undefined;
  const controller = editorSlots.controllerOf(key)?.slotId ?? null;
  if (controller !== null) {
    const controlled = tabs.get(controller);
    if (controlled !== undefined) return controlled;
  }
  // A conversation whose only editor is non-controlling — a newcomer bound passive to
  // a row another writer owns — still has exactly one record in this window: its
  // launch, its counters and its claim. Resolving that record here is what keeps a
  // lookup by conversation from forking a second, empty authority for the same
  // conversation.
  for (const state of tabs.values()) if (state.tabId === key) return state;
  return undefined;
}

/** One slot's own record, or `null`. Never resolves through a conversation. */
function slotState(slot: string): TabState | null {
  return tabs.get(slot) ?? null;
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
  for (const state of [...tabs.values()]) {
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
      detailTabs.renameConversation(conversation, title);
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
    runtime: null,
    mode: "chat",
    transitioning: false,
    nativeWatch: null,
    viewProjection: null,
    document: null,
    chatDetach: null,
    chatPageId: null,
    heldReadyReport: null,
    origin: null,
    lastOpenRequest: -1,
    lastEditorClose: -1,
    control: null,
    controlFailure: null,
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
  const existing = stateOf(key);
  if (existing !== undefined) return existing;
  const created = newTabState(key);
  tabs.set(key, created);
  return created;
}

/** The default reason a passive slot is not allowed to act. */
const PASSIVE_REASON_DEFAULT = "This editor is not controlling its session.";
/** Shown while this window has not yet recorded this editor's control of its session. */
const ELECTING_REASON = "This editor is waiting for this window to record its control of the session.";

/**
 * Elections in flight, by editor slot: the durable record of which editor controls a
 * session is being written, and a command that arrives before it settles waits for it
 * instead of being judged on the interim, passive answer.
 */
const slotElections = new Map<string, Set<Promise<void>>>();

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
  "omp:chat-command": true,
};

/** Register one election of `slot`; it is forgotten when it settles, however it ends. */
function trackElection(slot: string, work: Promise<void>): Promise<void> {
  let pending = slotElections.get(slot);
  if (pending === undefined) {
    pending = new Set();
    slotElections.set(slot, pending);
  }
  const set = pending;
  const tracked: Promise<void> = work
    .catch(() => undefined)
    .finally(() => {
      set.delete(tracked);
      if (set.size === 0 && slotElections.get(slot) === set) slotElections.delete(slot);
    });
  set.add(tracked);
  return tracked;
}

/** Resolve once every election of `slot` that is in flight now has settled, or after the bound. */
async function awaitElection(slot: string): Promise<void> {
  const pending = slotElections.get(slot);
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

/** Why a slot bound to a conversation another writer owns may not act. */
const LIVE_INCUMBENT_REASON = "Another window or writer already holds this session, so this editor is not controlling it.";

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
  const entry = editorSlots.get(slot);
  const local = entry === null || entry.role === "controlling" ? null : (entry.passiveReason ?? PASSIVE_REASON_DEFAULT);
  const state = tabs.get(slot);
  const conversation = state?.tabId ?? null;
  const binding = indexForBridge?.slotBinding(slot) ?? null;
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
  if (tabs.get(slot) === undefined) {
    // The record this conversation already has — a pre-editor launch record, or the
    // record a closed editor left behind while its native host kept running — belongs
    // to the editor that serves the conversation. It is *moved* under this editor's
    // immutable key, preserving its runtime, its control channel and its editor
    // counters, so reopening a row reattaches the host this window already runs
    // instead of starting a second one. A record a live editor holds is never taken.
    const stale =
      tabs.get(conversation) ??
      [...tabs.values()].find(
        candidate =>
          candidate.slotId !== slot &&
          candidate.tabId === conversation &&
          candidate.panel === null &&
          !bridgeLiveEditors.has(candidate.slotId),
      );
    if (stale !== undefined && stale.slotId !== slot) {
      // Frontend registrations belong to the immutable editor slot, not this
      // movable conversation record. Retire only its old presentation; binding
      // the replacement panel creates a fresh frontend on the same live handle.
      stopTerminalForTab(stale.slotId);
      tabs.delete(stale.slotId);
      editorSlots.remove(stale.slotId);
      stale.slotId = slot;
      stale.tabId = conversation;
      tabs.set(slot, stale);
    }
  }
  const state = tabState(slot);
  state.slotId = slot;
  state.tabId = conversation;
  const before = new Map(editorSlots.entries().map(entry => [entry.slotId, entry]));
  editorSlots.register({ slotId: slot, tabId: conversation, role, passiveReason: reason });
  for (const entry of editorSlots.entries()) {
    const was = before.get(entry.slotId);
    if (was === undefined || (was.role === entry.role && was.generation === entry.generation)) continue;
    applySlotAuthority(entry.slotId);
  }
  return tabs.get(slot) ?? state;
}

/** Tell one slot's page and pane what its current authority is. */
function applySlotAuthority(slot: string): void {
  const state = slotState(slot);
  if (state === null || state.tabId === null) return;
  const reason = state.transitioning ? "The session view is changing or its process is stopping." : passiveReasonForSlot(slot);
  state.pipeline?.noteReadOnly(reason);
  // The page shows the role: its route reports the reason as `readOnlyReason` (composer
  // disabled, banner shown) and the runtime refuses its commands; re-send so it applies now.
  attachChatRoute(slot, true);
  if (reason === null) {
    replayHeldReadyReport(state);
    // A control request answered while this editor could not act left its footer without
    // controls; now that it may act, the page asks again.
    invalidateGuestControls(state.tabId);
  }
  refreshLauncher();
  pushSessionView(indexForBridge, state);
}

// Launcher

/**
 * Re-read the launcher from the registered folders, the index and this window.
 *
 * Every index mutation, folder change and lifecycle event that can change a row
 * calls this; nothing in the launcher runs on a timer and nothing here scans OMP's
 * session files. The welcome content follows the folder list, because a launcher
 * with no folder has nothing to group and must say how to add one.
 */
function refreshLauncher(options: { readonly ownership?: boolean } = {}): void {
  launcherProvider?.refresh(options);
  toolsController?.sync();
  if (activationContext !== undefined) void vscode.commands.executeCommand("setContext", "omp.defaultSessionMode", defaultSessionMode(activationContext));
  void vscode.commands.executeCommand(
    "setContext",
    HAS_WORKSPACE_FOLDERS_CONTEXT,
    (launcherFolders?.list().length ?? 0) > 0,
  );
  // Publication notifications rearm selection after roots and folder children
  // have actually been served; ordinary row activity never rebuilds those parents.
  const index = indexForBridge;
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
  launcherExpandFor = tabId;
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
  launcherRevealRequested = true;
  if (launcherRevealInFlight !== null) return launcherRevealInFlight;
  const reveal = async () => {
    while (launcherRevealRequested) {
      launcherRevealRequested = false;
      const provider = launcherProvider;
      const view = launcherView;
      if (!provider || !view || !view.visible) return;
      const tabId = index.activeTabId;
      if (tabId === null) { launcherSelectedPath = null; return; }
      const expand = launcherExpandFor === tabId;
      const reserved = provider.beginReveal(tabId, { expand });
      if (reserved === undefined) return;
      try {
        if (!expand && launcherSelectedPath === reserved.pathKey) continue;
        await view.reveal(reserved.item, { select: true, focus: false, expand: true });
        if (index.activeTabId === tabId) {
          launcherSelectedPath = reserved.pathKey;
          if (expand) launcherExpandFor = null;
        }
      } catch (error) {
        log(`launcher: could not select tab ${tabId}: ${messageOf(error)}`);
      } finally {
        reserved.release();
      }
    }
  };
  launcherRevealInFlight = reveal().finally(() => { launcherRevealInFlight = null; });
  return launcherRevealInFlight;
}

/** Runtime object identity is local; activity and snapshot contents are not. */
function launcherRuntimeIdentity(tabId: string): string | null {
  const state = stateOf(tabId);
  const runtime = state?.runtime;
  let id: number | null = null;
  if (runtime !== null && runtime !== undefined) {
    id = launcherRuntimeIds.get(runtime) ?? ++nextLauncherRuntimeId;
    launcherRuntimeIds.set(runtime, id);
  }
  const epoch = chat.stateOf(tabId)?.epoch ?? null;
  return state === undefined && epoch === null ? null : JSON.stringify([state?.slotId, id, epoch]);
}

/** What only this window knows about a tab: its panel, its host, its last outcome. */
function launcherFacts(tabId: string): SessionLauncherFacts {
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
    bridgeLiveEditors.has(bridge.editorId);
  const entry = indexForBridge?.get(tabId) ?? null;
  // The host owns the conversation whether or not a page shows it, so the activity is the
  // turn state of its own session: a closed tab reports exactly what an open one does.
  const activity = turnActivities.get(tabId) ?? null;
  const phase = chat.stateOf(tabId)?.phase ?? null;
  return {
    open: state !== null && (state.panel !== null || orphan),
    viewMode: state !== null && state.panel !== null && state.runtime !== null ? state.runtime.kind : null,
    // Native owns a PTY, not an RPC conversation. Use the actual writer's state.
    running: state !== null && state.runtime !== null && (state.runtime.kind === "terminal"
      ? state.runtime.handle.state === "running"
      : phase !== null && rpcPhaseIsRunning(phase)),
    launching: indexForBridge?.isLaunching(tabId) ?? false,
    stopping: stoppingTabs.has(tabId),
    outcome: outcomes.get(tabId) ?? null,
    restoring:
      startupRestore !== null
        ? startupRestore.cohort.has(tabId)
        : startupRestorePending && indexForBridge !== null && inLocalRecoveryCohort(indexForBridge, tabId),
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
 */
async function launcherOwnershipFacts(index: SessionIndex, tabId: string, options: { readonly fresh?: boolean } = {}): Promise<SessionOwnershipFacts> {
  const observed = await index.observeOwnership(tabId);
  const claim = observed.ok ? observed.claim : null;
  const heldElsewhere = claim !== null && claim.verifiable && claim.holderId !== null &&
    claim.holderId !== index.claimHolder.id && claimHolderMayBeAlive(claim);
  const heldHere = claim !== null && claim.holderId === index.claimHolder.id && claimHolderMayBeAlive(claim);
  const pid = await verifiedOwnedWriterPid(index, tabId);
  const sessionFile = index.get(tabId)?.sessionFile ?? null;
  const externalOmp = !heldElsewhere && !heldHere && pid === null && sessionFile !== null && externalLeases !== null &&
    await externalLeases.holds(sessionFile, options) === true;
  return { heldElsewhere, switchableWindow: heldElsewhere && claim?.windowUri?.startsWith("file:") === true,
    externalOmp, ownershipChecked: observed.ok, ownedWriterPid: pid,
    legacyWriter: pid !== null && index.get(tabId)?.host?.transport !== "rpc" };
}

const OPEN_ANYWAY = "Open Anyway";

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

/** Claim file name per row target, resolved once: the name needs the filesystem, and a watch batch asks for every row. */
const claimFileNames = new Map<string, string | null>();

/**
 * Re-read the ownership of the rows filed under claims that changed on disk.
 *
 * Another window taking or releasing a session is only visible as its claim file appearing,
 * being replaced or going away. Only the affected rows are re-observed, through the same
 * observation the view always uses, so a burst of claim writes costs the rows it names and
 * nothing else. An empty set means the watcher could not say which claims changed.
 */
function refreshRowsForClaims(index: SessionIndex, claimFiles: ReadonlySet<string>): void {
  const provider = launcherProvider;
  if (provider === undefined) return;
  if (claimFiles.size === 0) {
    provider.refresh({ ownership: true });
    return;
  }
  const tabIds = new Set<string>();
  for (const entry of index.list()) {
    const target = entry.sessionFile ?? entry.ownership?.draftIdentity ?? null;
    if (target === null) continue;
    let name = claimFileNames.get(target);
    if (name === undefined) {
      try {
        name = claimFileNameFor(index.claimStorageDir, target);
      } catch {
        // An identity that cannot be filed under a claim has no claim file to watch.
        name = null;
      }
      claimFileNames.set(target, name);
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
  // Only the rows this pass considered lose their previous outcome: a pass pinned
  // to the activation cohort must not erase what an explicit open reported for a
  // row it did not touch. (A pass over every row resets all of them, since every
  // row is in `order`.)
  for (const tabId of report.order) outcomes.delete(tabId);
  for (const session of report.restored) {
    outcomes.set(session.tabId, {
      status: "restored",
      tabId: session.tabId,
      sessionFile: session.sessionFile,
      host: session.host,
    });
  }
  for (const session of report.attached) {
    outcomes.set(session.tabId, {
      status: "attached",
      tabId: session.tabId,
      sessionFile: session.sessionFile,
      detail: session.detail,
    });
  }
  for (const conflict of report.conflicts) {
    outcomes.set(conflict.tabId, {
      status: "conflict",
      tabId: conflict.tabId,
      kind: conflict.kind,
      detail: conflict.detail,
    });
  }
  for (const failure of report.failures) {
    outcomes.set(failure.tabId, {
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

// Native file observation — read-only evidence
//
// The native producer (`src/omp/file-evidence.ts`, wired into the OMP `-e`
// extension by `src/omp/host-control.ts`) writes content-addressed bytes and a
// bounded journal under this extension's own host-control directory, and only
// after the user records an explicit consent for one workspace and session.
//
// Everything in this section is read-only: it lists committed records, renders
// bounded stored text, and offers a native diff between two observations of one
// path inside exactly one producer binding. It never writes a file inside the
// workspace, never restores anything and never sends stored bytes to a Webview
// (ADR-0007; docs/designs/2026-09-24-native-file-observation-and-reversibility.md).

/** Observations one picker lists; the journal enforces its own tighter bound. */
const OBSERVATION_LIST_LIMIT = 200;
/** How many read-only observation document bindings stay resolvable per window. */
const OBSERVATION_DOCUMENT_LIMIT = 32;
/** Button that grants capture; dismissing the dialog any other way leaves it off. */
const ENABLE_EVIDENCE_LABEL = "Enable observation";
/** Button that deletes one session's stored history. */
const DELETE_SESSION_LABEL = "Delete this session's history";
/** Button that deletes one OMP session's native transcript and artifacts. */
const DELETE_TRANSCRIPT_LABEL = "Delete";
/** The confirmation button for the explicit stop of a row's recorded OMP process. */
const STOP_RECORDED_HOST_LABEL = "Stop OMP Process";
/** Button that deletes every session namespace this launch recorded. */
const DELETE_LAUNCH_LABEL = "Delete every session of this launch";
const SHOW_OBSERVATION_LABEL = "Show this observation (read-only)";
const COMPARE_OBSERVATION_LABEL = "Compare with the previous observation of this path";

/**
 * Shown when a document no longer has a binding, or its observation is gone.
 *
 * It says what it is not — an empty observation — because a document that simply
 * rendered nothing would be indistinguishable from a file that was empty when it
 * was observed, which the store reports separately.
 */
const OBSERVATION_DOCUMENT_UNAVAILABLE =
  "This observation document cannot be shown: it is no longer resolvable or the stored observation is gone. It is not an empty observation — reopen the list from OMP's file-observation command.";

/** What one read-only observation document displays; never stored bytes. */
interface ObservationDocumentBinding {
  readonly tabId: string;
  readonly recordId: string;
  /** `detail` is the provenance header plus the text; `side` is a diff side. */
  readonly kind: "detail" | "side";
}

interface ObservationDocumentEntry {
  readonly uri: vscode.Uri;
  readonly binding: ObservationDocumentBinding;
}

/**
 * Open observation documents, by opaque token. Only the binding is held: the
 * bytes are re-read from the store on every request, so a deleted or replaced
 * observation can never be served from a copy this window once made.
 */
const observationDocuments = new Map<string, ObservationDocumentEntry>();

/** Fires when an observation the window may be showing has changed. */
const observationDocumentChanges = new vscode.EventEmitter<vscode.Uri>();

/** Verified facts of one tab's live control channel; null when it has none yet. */
interface EvidenceLiveChannel {
  readonly slotId: string;
  /** The host-control subsystem's own instance id; not the broker child's identity. */
  readonly instanceId: string;
  /** PID the authenticated channel's binding names. */
  readonly pid: number;
  readonly cwd: string;
  /**
   * PID the OS proved for the server end of the pipe this channel carries, and that
   * process's kernel creation time. Both come from `ControlPeerProof`, which refuses
   * after the channel closes — so this accessor's proof is a *live* one.
   */
  readonly serverPid: number;
  readonly serverCreationTime: string;
}

/** One launch's evidence namespace for one workspace and session. */
interface EvidenceNamespace {
  readonly slotId: string;
  readonly paths: NativeFileObservationStorePaths;
  /** Host-control directory this launch published into. */
  readonly directory: string;
  /** Kernel instance of the launch; null when no verified channel names this slot. */
  readonly processInstanceId: string | null;
  readonly pid: number | null;
  /** Kernel creation time recorded for that pid at launch, when one was recorded. */
  readonly processCreation: string | null;
  /**
   * Set only when *this exact slot* was released by this claim after a confirmed
   * stop. A claim's release speaks for the launch it released and for no other,
   * so it is looked up per slot rather than threaded in from the current tab.
   */
  readonly releaseProof: string | null;
}

interface EvidenceSession {
  readonly tabId: string;
  readonly directory: string;
  readonly sessionId: string;
  /** The launch this window owns first, then older namespaces of the same session. */
  readonly namespaces: readonly EvidenceNamespace[];
}

type EvidenceSessionResult =
  | { readonly ok: true; readonly session: EvidenceSession }
  | { readonly ok: false; readonly reason: string };

/**
 * The verified facts of one tab's control channel, or `null`.
 *
 * A channel that has not finished its handshake proves no process identity: its
 * accessor throws, and a thrown proof is no proof.
 */
function liveControlFacts(state: TabState | undefined): EvidenceLiveChannel | null {
  try {
    const client = state?.control?.client ?? null;
    if (client === null) return null;
    const live = client.binding;
    // `peerProof` is read on the same channel: it refuses once the channel has
    // closed, so a retained binding alone can never authorize a fact that claims to
    // be proved by this window.
    const proof = client.peerProof;
    return {
      slotId: live.slotId,
      instanceId: live.instanceId,
      pid: live.pid,
      cwd: live.cwd,
      serverPid: proof.serverPid,
      serverCreationTime: proof.serverCreationTime,
    };
  } catch {
    return null;
  }
}

/** Names of the sub-directories of one directory; empty when it cannot be read. */
async function subdirectories(directory: string): Promise<string[]> {
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(directory));
  } catch {
    return [];
  }
  return entries.filter(([, type]) => type === vscode.FileType.Directory).map(([name]) => name);
}

/**
 * Every evidence namespace one indexed session can have.
 *
 * The store path is
 * `<control dir>/file-evidence/<owner>/<slot>/<workspace digest>/<session digest>`,
 * so the workspace and session identity constrain the namespace and the launch
 * slot names the producer. The launch this window owns comes first; a namespace
 * written by an earlier launch of the same session, or by a launch this window
 * never recorded (another window, an extension-host reload, a confirmed stop that
 * released its control material), is found by re-deriving each candidate path
 * from exactly the same workspace and session identity and accepting it only when
 * that derivation reproduces the directory that exists. Nothing here reads or
 * writes an observation.
 */
async function evidenceSession(
  context: vscode.ExtensionContext,
  index: SessionIndex,
  tabId: string,
): Promise<EvidenceSessionResult> {
  const entry = index.get(tabId);
  if (entry === null) return { ok: false, reason: "that session is no longer indexed" };
  const ownership = entry.ownership;
  if (ownership === null) return { ok: false, reason: "that session has no claim this window owns" };
  const sessionId = entry.sessionId;
  if (sessionId === null || sessionId.length === 0) {
    return {
      ok: false,
      reason: "the OMP session id for this tab is not known yet, and evidence is bound to that exact id",
    };
  }
  const directory = controlDirectory(context);
  const live = liveControlFacts(stateOf(tabId));
  // The producer hashed the native process directory into its namespace; the
  // indexed cwd is the directory this window launched that process in.
  const workspaceRoot = live?.cwd ?? entry.cwd;
  const record = context.globalState.get<RecordedControlProcess>(
    controlProcessRecordKey(ownership.ownerGeneration),
  );
  const releases = context.globalState.get<readonly RecordedControlRelease[]>(
    controlReleaseRecordKey(ownership.ownerGeneration),
  ) ?? [];
  const slotIds: string[] = [];
  if (live !== null) slotIds.push(live.slotId);
  if (record !== undefined && !slotIds.includes(record.slotId)) slotIds.push(record.slotId);
  for (const slotId of await discoverEvidenceSlots(directory, workspaceRoot, sessionId)) {
    if (!slotIds.includes(slotId)) slotIds.push(slotId);
  }
  const namespaces: EvidenceNamespace[] = [];
  for (const slotId of slotIds) {
    let paths: NativeFileObservationStorePaths;
    try {
      paths = resolveNativeFileObservationStorePaths({
        storageRoot: fileEvidenceStoreRoot(directory),
        ownerId: slotId,
        slotId,
        workspaceRoot,
        sessionId,
      });
    } catch (error) {
      return { ok: false, reason: `the evidence namespace could not be derived (${messageOf(error)})` };
    }
    const own = live !== null && live.slotId === slotId;
    const recorded = record?.slotId === slotId ? record : null;
    namespaces.push({
      slotId,
      paths,
      directory,
      processInstanceId: own ? live.instanceId : null,
      pid: own ? live.pid : (recorded?.pid ?? null),
      processCreation: own ? live.serverCreationTime : (recorded?.processCreation ?? null),
      releaseProof: releases.find(entry => entry.slotId === slotId)?.releasedAt ?? null,
    });
  }
  if (namespaces.length === 0) {
    return {
      ok: false,
      reason: "no evidence store exists for this workspace and session, so there is nothing to read or delete",
    };
  }
  return { ok: true, session: { tabId, directory, sessionId, namespaces } };
}

/**
 * Launch slots with a store directory for exactly this workspace and session.
 *
 * Only names that re-derive to a real namespace are returned, so an unrelated
 * directory in the evidence root can never be read as this session's store.
 */
async function discoverEvidenceSlots(
  directory: string,
  workspaceRoot: string,
  sessionId: string,
): Promise<string[]> {
  const storageRoot = fileEvidenceStoreRoot(directory);
  const slots: string[] = [];
  for (const ownerId of await subdirectories(storageRoot)) {
    for (const slotId of await subdirectories(path.join(storageRoot, ownerId))) {
      let candidate: NativeFileObservationStorePaths;
      try {
        candidate = resolveNativeFileObservationStorePaths({
          storageRoot,
          ownerId,
          slotId,
          workspaceRoot,
          sessionId,
        });
      } catch {
        continue;
      }
      let found: vscode.FileStat | null = null;
      try {
        found = await vscode.workspace.fs.stat(vscode.Uri.file(candidate.sessionDirectory));
      } catch {
        found = null;
      }
      if (found !== null && found.type === vscode.FileType.Directory) slots.push(slotId);
    }
  }
  return slots;
}

/** The tab these commands act on: the active one, never another tab's store. */
function evidenceTabId(index: SessionIndex): string | null {
  const tabId = index.activeTabId;
  if (tabId === null) {
    showInfo("No OMP session is active in this window. Focus the session you mean and run this command again.");
    return null;
  }
  return tabId;
}

/**
 * Whether one stored record belongs to this exact namespace.
 *
 * The journal already refuses a record whose workspace/session digests do not
 * match the namespace it was opened with; this adds the producer identity, so a
 * record written by another launch, another window or another session is never
 * presented as this session's evidence.
 */
function recordMatchesNamespace(record: NativeFileObservationRecord, namespace: EvidenceNamespace): boolean {
  if (record.origin.ownerId !== namespace.paths.ownerId || record.origin.slotId !== namespace.paths.slotId) {
    return false;
  }
  if (namespace.processInstanceId !== null && record.origin.processInstanceId !== namespace.processInstanceId) {
    return false;
  }
  return (
    record.session.sessionId === namespace.paths.sessionId &&
    record.session.workspaceDigest === namespace.paths.workspaceDigest
  );
}

/** Positive evidence that one namespace's producer stopped, or why it cannot be shown. */
type ProducerStopProof =
  | { readonly stopped: true; readonly detail: string }
  | { readonly stopped: false; readonly detail: string };

/**
 * Whether one namespace's producer is provably gone.
 *
 * Absence of a control record is *not* proof that a producer stopped: control
 * material can be released by a confirmed stop, dropped on an extension-host
 * reload or lost with a crash, while the native process keeps its open journal
 * and can still commit an observation. Only positive evidence is accepted here:
 *
 * - a live verified channel, or a rendezvous record whose process exists, proves
 *   it is running and refuses;
 * - a rendezvous whose process no longer exists, or a recorded process whose pid
 *   no longer exists, or a recorded pid now held by a *different* kernel process
 *   (creation time differs, so the pid was reused), proves the stop;
 * - when no process identity survives at all, only the release this launcher
 *   recorded for *this exact slot* after a confirmed stop proves it — a release
 *   belongs to the launch it released, so another launch's or another window's
 *   namespace is never deleted on this claim's word.
 *
 * Everything else refuses with the exact missing fact, and the bytes stay.
 */
async function producerStopProof(namespace: EvidenceNamespace): Promise<ProducerStopProof> {
  if (namespace.processInstanceId !== null) {
    return {
      stopped: false,
      detail: `this window still holds a verified control channel to launch slot ${namespace.slotId}`,
    };
  }
  const rendezvous = await readControlRendezvous(namespace.directory, namespace.slotId);
  if (rendezvous !== null) {
    return isProcessAlive(rendezvous.pid)
      ? {
          stopped: false,
          detail: `launch slot ${namespace.slotId} still publishes a live control record for pid ${rendezvous.pid}`,
        }
      : {
          stopped: true,
          detail: `the process that published launch slot ${namespace.slotId} (pid ${rendezvous.pid}) no longer exists`,
        };
  }
  const pid = namespace.pid;
  if (pid === null) {
    return namespace.releaseProof === null
      ? {
          stopped: false,
          detail: `launch slot ${namespace.slotId} has no process identity, no live control record and no release this window recorded, so its producer cannot be proven stopped`,
        }
      : {
          stopped: true,
          detail: `this window released launch slot ${namespace.slotId} after a confirmed stop (${namespace.releaseProof})`,
        };
  }
  if (!isProcessAlive(pid)) {
    return { stopped: true, detail: `the recorded process of launch slot ${namespace.slotId} (pid ${pid}) no longer exists` };
  }
  if (namespace.processCreation === null) {
    return {
      stopped: false,
      detail: `pid ${pid} of launch slot ${namespace.slotId} still exists and no recorded process generation can tell it from a reused pid`,
    };
  }
  let current: string;
  try {
    current = await queryControlProcessGeneration(pid);
  } catch {
    return {
      stopped: false,
      detail: `the process generation of pid ${pid} for launch slot ${namespace.slotId} could not be read, so a reused pid cannot be ruled out`,
    };
  }
  return current === namespace.processCreation
    ? {
        stopped: false,
        detail: `the recorded process of launch slot ${namespace.slotId} (pid ${pid}, generation ${current}) is still running`,
      }
    : {
        stopped: true,
        detail: `pid ${pid} of launch slot ${namespace.slotId} now hosts another process (generation ${current}), so the recorded producer is gone`,
      };
}

/**
 * Why deleting this session's stored observations would be unsafe right now, or
 * `null` when every namespace is proven stopped.
 *
 * The proof is re-taken from the current launch and store on every call, so a
 * dialog that stayed open across a launch or a release cannot make a stale answer
 * stand. It shows no UI and deletes nothing; the delete command calls it before
 * the confirmation dialog and again afterwards.
 */
export async function fileEvidenceDeletionRefusal(
  context: vscode.ExtensionContext,
  index: SessionIndex,
  tabId: string,
): Promise<string | null> {
  const resolved = await evidenceSession(context, index, tabId);
  if (!resolved.ok) return resolved.reason;
  // The proof of a still-running producer reads its kernel generation with the
  // staged PowerShell helper: stage it first, so a delete right after activation
  // answers from a real probe instead of refusing because no helper is configured
  // yet. A staging failure is left to that refusal, which reports it.
  await runtimeEntries(context).catch(() => {});
  for (const namespace of resolved.session.namespaces) {
    const proof = await producerStopProof(namespace);
    if (!proof.stopped) {
      log(`file observation delete refused: ${proof.detail}`);
      return "A session may still be recording file changes. Stop it before deleting its observations.";
    }
  }
  return null;
}

/** Whether capture is on for this session, as the store itself reports it. */
async function observationCaptureState(session: EvidenceSession): Promise<string> {
  const first = session.namespaces[0];
  if (first === undefined) return "no evidence store exists for this workspace and session";
  const disabled = await readNativeFileObservationDisable({ paths: first.paths });
  if (disabled.disabled) {
    return `capture is disabled for this workspace (${disabled.reason ?? "no reason recorded"})`;
  }
  const consent = await readNativeFileObservationConsent({ paths: first.paths });
  return consent.state === "granted" ? "capture is enabled for this session" : `capture is off (${consent.reason})`;
}

/** Register one opaque document binding and return the editor URI for it. */
function observationDocumentUri(
  stage: NativeFileObservationRecord["stage"],
  binding: ObservationDocumentBinding,
): vscode.Uri {
  const token = createControlRequestId();
  const uri = vscode.Uri.from({
    scheme: OBSERVATION_DOCUMENT_SCHEME,
    path: observationDocumentPath(token, stage),
  });
  observationDocuments.set(token, { uri, binding });
  while (observationDocuments.size > OBSERVATION_DOCUMENT_LIMIT) {
    const oldest = observationDocuments.keys().next();
    if (oldest.done) break;
    observationDocuments.delete(oldest.value);
  }
  return uri;
}

/** Ask every open observation document to re-read the store. */
function refreshObservationDocuments(): void {
  for (const entry of observationDocuments.values()) observationDocumentChanges.fire(entry.uri);
}

function tabShowsObservationDocument(tab: vscode.Tab): boolean {
  const input = tab.input;
  if (input instanceof vscode.TabInputText) return input.uri.scheme === OBSERVATION_DOCUMENT_SCHEME;
  if (input instanceof vscode.TabInputTextDiff) {
    return (
      input.original.scheme === OBSERVATION_DOCUMENT_SCHEME ||
      input.modified.scheme === OBSERVATION_DOCUMENT_SCHEME
    );
  }
  return false;
}

/**
 * Close the observation documents this window opened.
 *
 * An editor tab holds its own copy of whatever the provider last returned, so a
 * deletion that left tabs open would leave readable copies of deleted bytes on
 * screen. They are read-only, so closing one never discards user work.
 */
async function closeObservationDocuments(): Promise<void> {
  const ours: vscode.Tab[] = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) if (tabShowsObservationDocument(tab)) ours.push(tab);
  }
  if (ours.length > 0) await vscode.window.tabGroups.close(ours, true);
}

/** The read-only body of one observation document, resolved from the store. */
async function renderObservationDocument(
  context: vscode.ExtensionContext,
  index: SessionIndex,
  binding: ObservationDocumentBinding,
): Promise<string> {
  const resolved = await evidenceSession(context, index, binding.tabId);
  if (!resolved.ok) return OBSERVATION_DOCUMENT_UNAVAILABLE;
  for (const namespace of resolved.session.namespaces) {
    const reader = await openNativeFileObservationJournal({ paths: namespace.paths, mode: "reader" });
    try {
      const read = await reader.read(binding.recordId);
      if (!read.available || !recordMatchesNamespace(read.record, namespace)) continue;
      const text = observationTextState(read.record, read);
      if (binding.kind === "side") {
        // A diff side is the stored text only: an observation with no validated
        // text is never rendered as an empty file.
        return text.text ?? OBSERVATION_DOCUMENT_UNAVAILABLE;
      }
      const listed = await reader.list({ limit: OBSERVATION_LIST_LIMIT });
      const view = observationCallViews(listed.records).get(observationCallKey(read.record)) ?? null;
      return renderObservationDetail(read.record, view, text);
    } finally {
      await reader.close().catch(() => {});
    }
  }
  return OBSERVATION_DOCUMENT_UNAVAILABLE;
}

/**
 * Body of one observation document, re-validated on every request.
 *
 * The token is only a binding: the namespace is re-derived from the current
 * launch, the store is re-opened read-only, and the record and its bytes are
 * re-read and re-validated. A document whose observation was deleted, replaced or
 * corrupted therefore reports that, instead of serving the copy a cache kept.
 */
async function observationDocumentContent(
  context: vscode.ExtensionContext,
  index: SessionIndex,
  uriPath: string,
): Promise<string> {
  const token = observationTokenFromPath(uriPath);
  const entry = token === null ? undefined : observationDocuments.get(token);
  if (entry === undefined) return OBSERVATION_DOCUMENT_UNAVAILABLE;
  try {
    return await renderObservationDocument(context, index, entry.binding);
  } catch {
    // A store that cannot be read is reported as unavailable, never as empty.
    return OBSERVATION_DOCUMENT_UNAVAILABLE;
  }
}

/**
 * What a reader sees before any byte: provenance, the journal's verdict on the
 * call and the fixed limits of the evidence, then the stored text unchanged.
 */
function renderObservationDetail(
  record: NativeFileObservationRecord,
  view: NativeFileObservationCallView | null,
  text: ObservationTextState,
): string {
  return [
    `File observation — ${observationPathLabel(record)}`,
    ...observationDetailLines(record, view === null ? null : view.resolution, text),
    "",
    text.text === null ? "(no stored text is shown for this observation)" : text.text,
  ].join("\n");
}

async function openObservationDocument(
  stage: NativeFileObservationRecord["stage"],
  binding: ObservationDocumentBinding,
): Promise<void> {
  const document = await vscode.workspace.openTextDocument(observationDocumentUri(stage, binding));
  await vscode.window.showTextDocument(document, { preview: true });
}

/** A native diff of two validated observations of one path inside one binding. */
async function compareObservationPair(
  tabId: string,
  journal: NativeFileObservationJournal,
  pair: ObservationPair,
): Promise<void> {
  const [previousRead, currentRead] = await Promise.all([
    journal.read(pair.previous.recordId),
    journal.read(pair.current.recordId),
  ]);
  const previous = observationTextState(pair.previous, previousRead);
  const current = observationTextState(pair.current, currentRead);
  const notice = observationComparisonNotice(previous, current);
  if (notice !== null || previous.text === null || current.text === null) {
    // An absent, binary, oversize or unreadable side is never diffed as if it
    // were empty: the notice says which side has no validated stored text.
    showInfo(notice ?? OBSERVATION_DOCUMENT_UNAVAILABLE);
    return;
  }
  await vscode.commands.executeCommand(
    "vscode.diff",
    observationDocumentUri(pair.previous.stage, { tabId, recordId: pair.previous.recordId, kind: "side" }),
    observationDocumentUri(pair.current.stage, { tabId, recordId: pair.current.recordId, kind: "side" }),
    observationComparisonTitle(pair),
  );
}

/** The exact launch and session identity one consent grant is bound to. */
interface ConsentBinding {
  readonly namespace: EvidenceNamespace;
  /** Everything that must still agree when the grant is written, and again after. */
  readonly key: string;
}

type ConsentBindingResult =
  | { readonly ok: true; readonly binding: ConsentBinding }
  | { readonly ok: false; readonly reason: string };

/**
 * The live binding a consent record may be written for, re-derived on demand.
 *
 * A consent record is per workspace and session, and capture is owned by the
 * native process hosting that session, so the grant must name exactly the tab,
 * claim, verified control channel and store that exist *now*: the active tab, its
 * claim generation, the indexed session id and cwd, and the authenticated
 * binding's slot, instance, pid and session file. Nothing about this can be made
 * atomic against a native session switch — the observer binds capture to the
 * session id it sees per stage — so the caller re-derives this identity before
 * the disclosure and again before the grant, and refuses on any difference.
 */
async function consentBinding(
  context: vscode.ExtensionContext,
  index: SessionIndex,
  tabId: string,
): Promise<ConsentBindingResult> {
  if (index.activeTabId !== tabId) {
    return { ok: false, reason: "the active session changed while this command was running" };
  }
  const channel = activeControl(index);
  if (channel === null || channel.tabId !== tabId) {
    return { ok: false, reason: "the verified host-control channel for this session is no longer available" };
  }
  const entry = index.get(tabId);
  const ownership = entry?.ownership ?? null;
  if (entry === null || ownership === null) {
    return { ok: false, reason: "that session no longer holds the claim this window would record consent under" };
  }
  const resolved = await evidenceSession(context, index, tabId);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  const namespace = resolved.session.namespaces.find(candidate => candidate.processInstanceId !== null);
  if (namespace === undefined) {
    return { ok: false, reason: "no verified native host is identified for this session right now" };
  }
  let live: EvidenceLiveChannel;
  let sessionFile: string | null;
  try {
    const binding = channel.client.binding;
    // `peerProof` refuses once the channel is closed, so this branch proves a live
    // channel rather than a retained one.
    const proof = channel.client.peerProof;
    live = {
      slotId: binding.slotId,
      instanceId: binding.instanceId,
      pid: binding.pid,
      cwd: binding.cwd,
      serverPid: proof.serverPid,
      serverCreationTime: proof.serverCreationTime,
    };
    sessionFile = binding.sessionFile;
  } catch {
    return { ok: false, reason: "the host-control channel has not completed its handshake" };
  }
  if (namespace.slotId !== live.slotId) {
    return { ok: false, reason: "the store does not belong to the native process this window authenticated" };
  }
  return {
    ok: true,
    binding: {
      namespace,
      key: [
        tabId,
        ownership.ownerGeneration,
        entry.sessionId ?? "",
        namespace.paths.sessionDirectory,
        live.slotId,
        live.instanceId,
        String(live.pid),
        sessionFile ?? "",
      ].join("\u0000"),
    },
  };
}

/**
 * Record explicit consent for this workspace and this session.
 *
 * The restricted store access rules are established and independently verified
 * before the consent record exists (ADR-0007), the full disclosure — including
 * that a snapshot taken before a tool runs can preserve bytes of an operation
 * the user later denies — is shown before any approval, and only the explicit
 * button grants capture. The tab, claim and authenticated host are re-checked
 * after the access rewrite and again after the dialog, so a session the user
 * switched to in the meantime never receives a consent record.
 */
async function enableFileEvidence(context: vscode.ExtensionContext, index: SessionIndex): Promise<void> {
  const tabId = evidenceTabId(index);
  if (tabId === null) return;
  const start = await consentBinding(context, index, tabId);
  if (!start.ok) {
    showWarning(`File observation cannot be enabled: ${start.reason}.`);
    return;
  }
  const restricted = await restrictNativeFileObservationStorage({ paths: start.binding.namespace.paths });
  const readiness = restricted.readiness;
  if (!restricted.restricted || readiness === null || !readiness.ready) {
    showError(
      `File observation stayed off: ${
        restricted.reason ?? readiness?.reason ?? "the observation store could not be verified"
      }.`,
    );
    return;
  }
  // The access rewrite read and rewrote the store's own directories; the session may have moved on since.
  const before = await consentBinding(context, index, tabId);
  if (!before.ok) {
    showWarning(`File observation stayed off: ${before.reason}.`);
    return;
  }
  if (before.binding.key !== start.binding.key) {
    showWarning(
      "File observation stayed off: the session or its native host changed while the store was being prepared, so no consent was recorded. Run the command again.",
    );
    return;
  }
  const namespace = before.binding.namespace;
  const disabled = await readNativeFileObservationDisable({ paths: namespace.paths });
  log(`file observation consent: session ${namespace.paths.sessionId}, pid ${namespace.pid ?? "unknown"}, access ${readiness.evidence.join("; ")}`);
  const detail = [
    ...NATIVE_FILE_OBSERVATION_DISCLOSURE,
    "",
    `Workspace: ${namespace.paths.workspaceRoot}`,
    `Store: ${namespace.paths.storageRoot}`,
    ...(disabled.disabled
      ? [
          "",
          `Capture was disabled for this workspace${
            disabled.atMs === null ? "" : ` on ${new Date(disabled.atMs).toISOString()}`
          }${disabled.reason === null ? "" : ` (${disabled.reason})`}. Enabling here lifts that disable marker.`,
        ]
      : []),
  ].join("\n");
  const picked = await vscode.window.showWarningMessage(
    "OMP: Store file observations for this workspace and session?",
    { modal: true, detail },
    ENABLE_EVIDENCE_LABEL,
  );
  if (picked !== ENABLE_EVIDENCE_LABEL) {
    showInfo("File observation stays off; no consent was recorded and no byte was stored.");
    return;
  }
  // The dialog can stay open across a session switch or a relaunch in the native
  // TUI, so the grant is written only for the identity that still holds.
  const grantedFor = await consentBinding(context, index, tabId);
  if (!grantedFor.ok) {
    showWarning(`File observation stayed off: ${grantedFor.reason}.`);
    return;
  }
  if (grantedFor.binding.key !== start.binding.key) {
    showWarning(
      "File observation stayed off: the session or its native host changed while the confirmation was open, so no consent was recorded for it. Run the command again on the session you mean.",
    );
    return;
  }
  const granted = await grantNativeFileObservationConsent({
    paths: grantedFor.binding.namespace.paths,
    disclosureId: NATIVE_FILE_OBSERVATION_DISCLOSURE_ID,
    preApprovalCaptureAcknowledged: true,
    ...(disabled.disabled ? { allowReEnable: true } : {}),
  });
  if (!granted.granted) {
    showError(`File observation stayed off: ${granted.reason ?? "the consent record was not stored"}.`);
    return;
  }
  log(`file observation enabled for session namespace ${grantedFor.binding.namespace.paths.sessionDigest}`);
  showInfo(
    "File observation is enabled for this session. Recorded observations are read-only evidence: no undo, redo, rollback or checkpoint restore is offered from them.",
  );
}

/**
 * Stop capture for this workspace, durably.
 *
 * The disable marker sits above the session namespace of each launch, so new
 * stages on a running native host refuse capture and the stop survives an
 * extension-host reload. A publication already underway may still finish:
 * deletion therefore requires a confirmed stopped producer. The launcher's own
 * consent records are removed too, so later enablement is deliberate.
 * Stored history is untouched until separately deleted.
 */
async function disableFileEvidence(context: vscode.ExtensionContext, index: SessionIndex): Promise<void> {
  const tabId = evidenceTabId(index);
  if (tabId === null) return;
  const resolved = await evidenceSession(context, index, tabId);
  if (!resolved.ok) {
    showWarning(`File observation cannot be disabled: ${resolved.reason}.`);
    return;
  }
  const session = resolved.session;
  let failed: string | null = null;
  for (const namespace of session.namespaces) {
    const disabled = await disableNativeFileObservationCapture({
      paths: namespace.paths,
      reason: "disabled from the OMP launcher",
    });
    if (!disabled.disabled) failed = disabled.detail ?? "the disable marker was not written";
  }
  if (failed !== null) {
    showError(`File observation could not be disabled: ${failed}.`);
    return;
  }
  let revoked = 0;
  for (const entry of index.list()) {
    if (entry.sessionId === null || !controlPathEquals(entry.cwd, session.namespaces[0]?.paths.workspaceRoot ?? "")) {
      continue;
    }
    const other = await evidenceSession(context, index, entry.tabId);
    if (!other.ok) continue;
    for (const namespace of other.session.namespaces) {
      const result = await revokeNativeFileObservationConsent({ paths: namespace.paths });
      if (result.revoked) revoked += 1;
    }
  }
  log(
    `file observation disabled for ${session.namespaces.length} namespace(s); ${revoked} consent record(s) revoked`,
  );
  // Open documents re-read the store: disabling keeps retained history, so they
  // must show the retained evidence rather than a stale rendering.
  refreshObservationDocuments();
  showInfo(
    `File observation is disabled for new capture stages, and a future launch of this session starts with no consent (${revoked} consent record(s) removed). An already-started publication may still finish; stop the native host before deleting retained history. Open observation documents were refreshed.`,
  );
}

/** Show the session's stored observations as read-only text and native diffs. */
async function showFileEvidence(context: vscode.ExtensionContext, index: SessionIndex): Promise<void> {
  const tabId = evidenceTabId(index);
  if (tabId === null) return;
  const resolved = await evidenceSession(context, index, tabId);
  if (!resolved.ok) {
    showWarning(`File observations are unavailable: ${resolved.reason}.`);
    return;
  }
  const session = resolved.session;
  const readers = new Map<string, NativeFileObservationJournal>();
  try {
    const records: NativeFileObservationRecord[] = [];
    let rejected = 0;
    let truncated = false;
    for (const namespace of session.namespaces) {
      const reader = await openNativeFileObservationJournal({ paths: namespace.paths, mode: "reader" });
      readers.set(namespace.slotId, reader);
      const listed = await reader.list({ limit: OBSERVATION_LIST_LIMIT });
      rejected += listed.rejected;
      truncated = truncated || listed.truncated;
      for (const record of listed.records) {
        if (recordMatchesNamespace(record, namespace)) records.push(record);
      }
    }
    if (records.length === 0) {
      const unvalidated = rejected === 0 ? "" : ` ${rejected} stored record(s) did not validate and are not shown.`;
      showInfo(
        `No file observation is recorded for this session: ${await observationCaptureState(session)}.${unvalidated}`,
      );
      return;
    }
    records.sort((left, right) => right.sequence - left.sequence || right.observedAtMs - left.observedAtMs);
    const pairByCurrent = new Map<string, ObservationPair>();
    for (const pair of observationPairs(records)) pairByCurrent.set(pair.current.recordId, pair);
    const picked = await vscode.window.showQuickPick(
      records.map(record => ({
        label: `${observationPathLabel(record)} — ${observationShortStage(record.stage)}`,
        description: observationSummaryLine(record),
        detail: `tool ${record.toolCall.toolName}, call ${record.toolCall.toolCallId}, reported outcome ${record.toolOutcome}`,
        record,
      })),
      {
        title: `File observations recorded for this session (${records.length})`,
        placeHolder: `Read-only evidence${
          truncated ? `, newest ${OBSERVATION_LIST_LIMIT} shown` : ""
        }; no restore is offered`,
      },
    );
    if (picked === undefined) return;
    const record = picked.record;
    const reader = readers.get(record.origin.slotId);
    if (reader === undefined) return;
    const pair = pairByCurrent.get(record.recordId) ?? null;
    const actions = pair === null ? [SHOW_OBSERVATION_LABEL] : [SHOW_OBSERVATION_LABEL, COMPARE_OBSERVATION_LABEL];
    const action = await vscode.window.showQuickPick(actions, { title: observationPathLabel(record) });
    if (action === undefined) return;
    if (action === COMPARE_OBSERVATION_LABEL && pair !== null) {
      await compareObservationPair(session.tabId, reader, pair);
      return;
    }
    await openObservationDocument(record.stage, {
      tabId: session.tabId,
      recordId: record.recordId,
      kind: "detail",
    });
  } catch (error) {
    showWarning(`File observations could not be read: ${messageOf(error)}.`);
  } finally {
    for (const reader of readers.values()) await reader.close().catch(() => {});
  }
}

/**
 * Delete retained history for this session, or for every session of the launches
 * that recorded it.
 *
 * Every namespace must be proven stopped before anything is removed: the store
 * cannot be locked against its own producer and a stage already past its gate can
 * still commit one observation, so promising erasure while a process might still
 * publish would be a false statement. The proofs are re-taken after the
 * confirmation dialog, because the answer can change while it is open; a
 * namespace whose producer cannot be proven stopped keeps its bytes and is named
 * in the refusal.
 */
async function deleteFileEvidence(context: vscode.ExtensionContext, index: SessionIndex): Promise<void> {
  const tabId = evidenceTabId(index);
  if (tabId === null) return;
  const refused = await fileEvidenceDeletionRefusal(context, index, tabId);
  if (refused !== null) {
    showWarning(
      `Refusing to delete stored observations: ${refused}. One more observation could still be stored, so nothing was removed. Stop that native host (close its terminal, or end that exact process) and run this again.`,
    );
    return;
  }
  const resolved = await evidenceSession(context, index, tabId);
  if (!resolved.ok) {
    showWarning(`File observations cannot be deleted: ${resolved.reason}.`);
    return;
  }
  const session = resolved.session;
  const detail = [
    `Session store(s): ${session.namespaces.map(namespace => namespace.paths.sessionDirectory).join(", ")}`,
    `All observations for these folders: ${session.namespaces
      .map(namespace => namespace.paths.workspaceDirectory)
      .join(", ")}`,
    "The sessions that recorded these observations have stopped.",
    "Their recording permissions are removed with the stored content, so recording does not resume automatically.",
    "Open observation documents are closed with the deletion, because an editor tab holds its own copy of what it displayed.",
    "Removal is an ordinary file-system delete, not a secure erase of the underlying storage.",
  ].join("\n");
  const picked = await vscode.window.showWarningMessage(
    "OMP: Delete stored file observations?",
    { modal: true, detail },
    DELETE_SESSION_LABEL,
    DELETE_LAUNCH_LABEL,
  );
  if (picked !== DELETE_SESSION_LABEL && picked !== DELETE_LAUNCH_LABEL) {
    showInfo("Nothing was deleted.");
    return;
  }
  // The dialog can stay open while a host is launched, a claim is released or the
  // window's active session changes, so the target and the proofs are re-taken
  // rather than trusted from before it.
  if (index.activeTabId !== tabId) {
    showWarning(
      "Refusing to delete stored observations: the active session changed while the confirmation was open. Nothing was removed.",
    );
    return;
  }
  const changed = await fileEvidenceDeletionRefusal(context, index, tabId);
  if (changed !== null) {
    showWarning(`Refusing to delete stored observations: ${changed}. Nothing was removed.`);
    return;
  }
  const confirmed = await evidenceSession(context, index, tabId);
  if (!confirmed.ok) {
    showWarning(`Refusing to delete stored observations: ${confirmed.reason}.`);
    return;
  }
  const scope = picked === DELETE_LAUNCH_LABEL ? "workspace" : "session";
  let records = 0;
  let blobs = 0;
  let namespaces = 0;
  let revoked = false;
  let failure: string | null = null;
  for (const namespace of confirmed.session.namespaces) {
    const result = await deleteNativeFileObservationHistory({
      paths: namespace.paths,
      scope,
      revokeConsent: true,
      keepDisableMarker: true,
    });
    records += result.removedRecords;
    blobs += result.removedBlobs;
    namespaces += result.removedNamespaces;
    revoked = revoked || result.revokedConsent;
    if (result.detail !== null) failure = result.detail;
  }
  // An open editor holds its own copy of what the provider last returned, so the
  // documents this window opened are closed and refreshed instead of left showing
  // bytes that no longer exist.
  await closeObservationDocuments();
  refreshObservationDocuments();
  const removed = `removed ${records} record(s) and ${blobs} stored blob(s) across ${namespaces} namespace(s)`;
  if (failure !== null) {
    showWarning(`File observations were ${removed}, but the store reported: ${failure}.`);
    return;
  }
  log(`file observations deleted (${scope}): ${removed}`);
  showInfo(
    `File observations deleted: ${removed}.${
      revoked ? " Their consent records were removed as well." : ""
    } Open observation documents were closed.`,
  );
}

// Startup and performance diagnostics
//
// `OMP: Show Diagnostics` renders one extension-owned, read-only document from
// measurements this window already took while launching and attaching sessions.
// Nothing in this section starts a process, probes OMP, changes a setting or
// warms anything to produce a number: it records what happened, marks every
// stage it did not observe as such, and never carries a secret or a bearer
// capability — no host-control key and no bridge secret.
// `src/host/diagnostics.ts` owns the recording rules and the redaction; this
// section only supplies the observations and the environment.

/** Diagnostics document scheme; the provider answers only the fixed report path. */
const DIAGNOSTICS_DOCUMENT_SCHEME = "omp-diagnostics";
/** Fires so an already-open report document re-reads its content. */
const diagnosticsDocumentChanges = new vscode.EventEmitter<vscode.Uri>();
const diagnostics = new DiagnosticsRecorder();

function diagnosticsUri(): vscode.Uri {
  return vscode.Uri.from({ scheme: DIAGNOSTICS_DOCUMENT_SCHEME, path: DIAGNOSTICS_DOCUMENT_PATH });
}

/** The one-line description of a session tab this report uses. */
function diagnosticsLabel(cwd: string): string {
  return `OMP: ${path.basename(cwd)}`;
}

/**
 * Whether one stage already holds a measurement — a duration this window
 * actually observed. A stage that is still running, or that was recorded as
 * unobserved, is not measured yet.
 */
function diagnosticsStageMeasured(tabId: string, stageId: DiagnosticStageId): boolean {
  const stage = diagnostics.snapshot(tabId)?.stages.find(current => current.id === stageId);
  return stage !== undefined && stage.durationMs !== null;
}

/** The verifiable environment facts of this extension host. */
function diagnosticsEnvironment(context: vscode.ExtensionContext): DiagnosticEnvironment {
  const pkg: unknown = context.extension.packageJSON;
  const version = typeof pkg === "object" && pkg !== null ? Reflect.get(pkg, "version") : undefined;
  return {
    extensionVersion: typeof version === "string" && version.length > 0 ? version : "unknown",
    vscodeVersion: vscode.version,
    platform: `${process.platform} ${process.arch}`,
    hostPid: process.pid,
    storagePath: context.globalStorageUri.fsPath,
  };
}

/**
 * Refresh the facts that change while a host lives: the exact command it was
 * launched from, the conversation's phase and whether host control is verified.
 * Every value is a non-secret identity.
 */
function refreshSessionDiagnostics(index: SessionIndex): void {
  const recorded = new Set(diagnostics.subjects().map(subject => subject.key));
  let resolvedTarget = false;
  for (const [tabId, state] of tabs) {
    if (!recorded.has(tabId)) continue;
    const runtime = state.runtime;
    if (runtime === null) continue;
    const target = runtime.binary;
    if (target !== null) {
      resolvedTarget = true;
      diagnostics.fact(tabId, "omp target", `${target.command} ${target.prefixArgs.join(" ")}`.trim());
      diagnostics.fact(tabId, "omp target origin", target.origin);
      if (typeof target.version === "string") diagnostics.fact(tabId, "omp reported version", target.version);
    }
    diagnostics.fact(tabId, "host pid", String(runtime.pid));
    diagnostics.fact(
      tabId,
      "broker",
      `slot ${runtime.identity.slot} · generation ${runtime.identity.brokerGeneration} · pid ${runtime.identity.brokerPid}`,
    );
    diagnostics.fact(tabId, "chat phase", chat.stateOf(tabId)?.phase ?? "no conversation");
    diagnostics.fact(
      tabId,
      "host control",
      state.control !== null
        ? "verified"
        : `unavailable${state.controlFailure === null ? "" : ` — ${state.controlFailure}`}`,
    );
    const entry = index.get(tabId);
    if (entry !== null) {
      const released = entry.ownership !== null && entry.ownership.releasedAt !== null;
      diagnostics.fact(tabId, "session state", `${entry.availability}${released ? " · claim released" : ""}`);
    }
  }
  if (!resolvedTarget) {
    // The resolved launcher is captured at a host's own launch; a window that
    // never launched one has nothing to report here, and this report does not
    // resolve (or run) a launcher of its own to fill the gap.
    diagnostics.fact(
      WINDOW_DIAGNOSTIC_SUBJECT,
      "OMP target",
      "not resolved in this window — no OMP host was launched here",
    );
  }
}

/** The report body; the provider calls this on every request, so it re-probes. */
async function diagnosticsDocumentContent(
  context: vscode.ExtensionContext,
  index: SessionIndex,
  uriPath: string,
): Promise<string> {
  if (uriPath !== DIAGNOSTICS_DOCUMENT_PATH) {
    return `${redactCapabilities(uriPath)}\n\nThis diagnostics document has no report bound to this path. Run "OMP: Show Diagnostics" to open the window's report.\n`;
  }
  refreshSessionDiagnostics(index);
  return diagnostics.render(diagnosticsEnvironment(context));
}

/** Show this window's read-only diagnostics report. */
async function showDiagnostics(context: vscode.ExtensionContext, index: SessionIndex): Promise<void> {
  try {
    const document = await vscode.workspace.openTextDocument(diagnosticsUri());
    await vscode.window.showTextDocument(document, { preview: false });
    // An already-open report holds the previous content; ask it to re-read.
    diagnosticsDocumentChanges.fire(diagnosticsUri());
    log("diagnostics report shown");
  } catch (error) {
    showError(`The diagnostics report could not be shown: ${messageOf(error)}`);
  }
}

function showError(message: string): void {
  void vscode.window.showErrorMessage(`OMP: ${message}`);
}

function showWarning(message: string): void {
  void vscode.window.showWarningMessage(`OMP: ${message}`);
}

function showInfo(message: string): void {
  void vscode.window.showInformationMessage(`OMP: ${message}`);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function log(message: string): void {
  output?.appendLine(`[${new Date().toISOString()}] ${message}`);
}

// Reinstall under a running window

/** `vscode.ExtensionMode.Production`; compared by value so the mocked `vscode` of the tests need not define the enum. */
const EXTENSION_MODE_PRODUCTION = 1;
const PACKAGE_DRIFT_POLL_MS = 10_000;
const UPDATED_ON_DISK_MESSAGE =
  "OMP was updated while this window was open. Reload the window to finish updating; " +
  "until then, a chat or terminal opened or switched now shows a notice instead of mixing old and new versions.";
/** Shown by a document that was not built because the installed package changed under this host. */
const UPDATED_ON_DISK_DETAIL =
  "OMP was updated while this window was open, so this view was not loaded: it would mix the new version with the " +
  "one still running. Run “Developer: Reload Window” from the Command Palette to finish updating. " +
  "Sessions and terminals that are already running are not affected.";

/** The fingerprint of the package this host started from; `null` outside a packaged (production) install. */
let packageDrift: PackageDrift | null = null;
let packageDriftAnnounced = false;

/**
 * Whether the installed package no longer holds the bytes this host started from. The first
 * detection of an episode is logged and offered as a Reload Window notification; every later
 * document build asks again, because a user may have dismissed it.
 */
function packageChangedOnDisk(): boolean {
  const verdict = packageDrift?.check() ?? { kind: "same" as const };
  if (verdict.kind === "same") {
    packageDriftAnnounced = false;
    return false;
  }
  if (!packageDriftAnnounced) {
    packageDriftAnnounced = true;
    log(`the installed extension changed on disk under this window (${verdict.files.join(", ")}); a reload finishes the update.`);
    void vscode.window.showWarningMessage(UPDATED_ON_DISK_MESSAGE, RELOAD_WINDOW_LABEL).then(choice => {
      if (choice === RELOAD_WINDOW_LABEL) void vscode.commands.executeCommand("workbench.action.reloadWindow");
    });
  }
  return true;
}

const RELOAD_WINDOW_LABEL = "Reload Window";
/** Why a launch is refused after a reinstall: a fixed sentence, no path or file name. */
const UPDATED_ON_DISK_ERROR = "OMP was updated while this window was open. Reload the window to finish updating, then try again.";

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
  let wasActive = panel.active;
  if (panel.active) editorRecency.touch(slot);
  panel.webview.onDidReceiveMessage(message => {
    // A disposed panel must not send a late request into a replacement editor.
    const state = tabs.get(slot);
    if (state?.panel !== panel || state.tabId === null) return;
    const handling = dispatchSlotMessage(index, slot, panel, message);
    void handling.catch(() => {
      log(`slot ${slot}: a guest message could not be processed`);
    });
  });
  panel.onDidDispose(() => {
    const current = tabs.get(slot);
    if (current === undefined || current.panel !== panel) {
      // A superseded panel. This slot is bound to the panel that replaced it, and
      // this close must not clear the replacement's page.
      log(`slot ${slot}: a superseded webview closed`);
      return;
    }
    if (current.tabId !== null) cancelControlPicker(current.tabId);
    draftRestores.delete(slot);
    forgetTerminalCopy(current);
    current.panel = null;
    editorRecency.forget(slot);
    current.origin = null;
    current.heldReadyReport = null;
    // The page is gone, so nothing is delivered to it; the conversation itself is the
    // host's and keeps running, notifying and reconciling without an editor.
    current.chatDetach?.();
    current.chatDetach = null;
    current.document = null;
    // The user's close is an intent of its own, numbered against the open requests
    // for this editor: an attempt that is still waiting must not undo it.
    editorEventSequence += 1;
    current.lastEditorClose = editorEventSequence;
    refreshGuestContext();
    // The editor this window watched close is retired here, not at shutdown: its tab
    // reservation is released so the row can be opened again, and its endpoint, exact
    // port and secret are forgotten because nothing may be served from a closed
    // editor's records. A host-only restart disposes no editor, and its records must
    // survive for the page that is still running.
    retireClosedBridgeEditor(slot);
    log(`slot ${slot}: webview closed; the OMP process keeps running`);
    refreshLauncher();
  });
  panel.onDidChangeViewState(event => {
    const state = tabs.get(slot);
    if (state?.panel !== panel) return;
    const activated = event.webviewPanel.active && !wasActive;
    wasActive = event.webviewPanel.active;
    // Input ownership follows what the user can see: a hidden editor's pane must not
    // keep the broker's input slot.
    state.pipeline?.notePanelVisible(event.webviewPanel.visible);
    // Deactivation must clear editor-title and Stop contexts as well as activation.
    refreshGuestContext();
    if (event.webviewPanel.active && state.tabId !== null) editorRecency.touch(slot);
    if (activated) toolsController?.refresh();
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
  const route = (): Promise<void> =>
    passiveReasonForSlot(slot) === null ? handleGuestMessage(index, slot, panel, message) : handlePassiveSlotMessage(slot, panel, message);
  if (passiveReasonForSlot(slot) === null || !slotElections.has(slot)) return route();
  const type = parseGuestWebviewMessage(message)?.type;
  if (type === undefined || ELECTION_GATED_TYPES[type] !== true) return route();
  return awaitElection(slot).then(() => {
    // The wait is where an editor is closed or replaced: only the panel still serving the
    // slot may be answered.
    const state = tabs.get(slot);
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
  const state = tabs.get(slot);
  if (state?.panel !== panel || state.tabId === null) return;
  const parsed = parseGuestWebviewMessage(message);
  if (parsed === null) return;
  if (parsed.type === "omp:terminal-copy-reply") {
    await acceptTerminalCopy(state, parsed);
    return;
  }
  if (parsed.type === "omp:open-detail") {
    openDetailTab(state.tabId, state.mode, parsed);
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
    pushSessionView(indexForBridge, state, true);
    activateNativeEditor(state);
    chat.resend(state.tabId, panelPageId(panel));
    return;
  }
  if (parsed.type === "omp:chat-load-older" || parsed.type === "omp:chat-resume" ||
      parsed.type === "omp:chat-tool-detail" || parsed.type === "omp:chat-subagent-read") {
    await runChatCommand(state.tabId, parsed, panelChatPage(state, panel));
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
    log(`slot ${slot}: a non-controlling editor's ${parsed.type} was answered as unavailable`);
    return;
  }
  if (CHAT_COMMAND_TYPES.has(parsed.type)) {
    // The conversation refuses a write from a route that may not write, and tells this page
    // why, so the refusal is visible instead of a prompt vanishing.
    await runChatCommand(state.tabId, parsed as ChatWebviewMessage, panelChatPage(state, panel));
    return;
  }
  if (parsed.type === "omp:chat-command") {
    if (parsed.command === "provider-login" && activationContext !== undefined && indexForBridge !== null) {
      await runChatAction(activationContext, indexForBridge, state.tabId, parsed.command);
      return;
    }
    showWarning(`${passiveReasonForSlot(slot) ?? PASSIVE_REASON_DEFAULT} The action was not run.`);
    return;
  }
  log(`slot ${slot}: a non-controlling editor's ${parsed.type} was refused`);
}

// In-tab terminal: one managed writer, one frontend per editor (ADR-0024)

/** The folder-shell editor's own view type; a folder shell is never a session editor. */
const SHELL_VIEW_TYPE = "omp.shellTerminal";

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
  const conversation = stateOf(key)?.tabId ?? null;
  return conversation !== null && indexForBridge?.get(conversation) != null;
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
function pushTerminalTo(tabId: string, message: TerminalHostMessage | TerminalLinkValidation): void {
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
  const state = tabState(tabId);
  if (state.pipeline !== null) return state.pipeline;
  const cwd =
    label ??
    (state.shellSlot !== null
      ? shellSlots?.get(state.shellSlot)?.cwd ?? null
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
    authority: state.transitioning ? "The session view is changing or its process is stopping." : passiveReasonForSlot(state.slotId),
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

let installedTerminalFonts: readonly string[] = [];

const TERMINAL_FONT_CONFIGURATION_KEYS = [
  "terminal.integrated.fontFamily", "terminal.integrated.fontSize", "terminal.integrated.lineHeight",
  "terminal.integrated.letterSpacing", "editor.fontFamily",
] as const;

function terminalCwd(state: TabState): string | undefined {
  return state.runtime?.cwd ??
    (state.tabId === null ? undefined : indexForBridge?.get(state.tabId)?.cwd) ??
    (state.shellSlot === null ? undefined : shellSlots?.get(state.shellSlot)?.cwd);
}

function terminalFontResource(state: TabState): vscode.Uri | undefined {
  const cwd = terminalCwd(state);
  return cwd === undefined ? undefined : vscode.Uri.file(cwd);
}

function terminalFontMessage(resource?: vscode.Uri): GuestTerminalFontMessage {
  const terminal = vscode.workspace.getConfiguration("terminal.integrated", resource);
  const editor = vscode.workspace.getConfiguration("editor", resource);
  return {
    type: "omp:terminal-font",
    fontFamily: terminalFontFamily(terminal.get<string>("fontFamily")?.trim() || editor.get<string>("fontFamily", "monospace"), installedTerminalFonts),
    fontSize: terminal.get<number>("fontSize", 14),
    lineHeight: terminal.get<number>("lineHeight", 1),
    letterSpacing: terminal.get<number>("letterSpacing", 0),
  };
}

function pushTerminalFont(state: TabState, resource = terminalFontResource(state)): void {
  void state.panel?.webview.postMessage(terminalFontMessage(resource));
}

/** The parsed inbound terminal messages a folder-shell panel may send. */
const TERMINAL_PANEL_TYPES: Record<string, true> = {
  "omp:terminal-attach": true,
  "omp:terminal-probe": true,
  "omp:terminal-input": true,
  "omp:terminal-resize": true,
  "omp:terminal-focus": true,
  "omp:terminal-visibility": true,
  "omp:terminal-link-validate": true,
  "omp:terminal-link-open": true,
};

/**
 * A Chat file link's context-menu command: the same open a click, Ctrl+Click or Ctrl+Shift+Click sends,
 * routed to the editor whose panel showed the menu, so the target resolves against that session's cwd.
 */
async function openFileLinkFromMenu(argument: unknown, action: FileLinkAction | undefined): Promise<void> {
  const menu = fileLinkMenuTarget(argument);
  if (menu === null) return;
  for (const [slot, state] of tabs) {
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
  const state = stateOf(tabId);
  if (state === undefined) return;
  // The host boundary refuses input and resize for a non-controlling slot *independently*
  // of the pane's own fence: a stale generation, a rebuilt pipeline or a forged message
  // must never turn into keystrokes for a session another writer owns. Display, focus and
  // visibility keep flowing, so the screen stays readable and copyable.
  if (
    (state.transitioning || passiveReasonForSlot(state.slotId) !== null) &&
    (parsed.type === "omp:terminal-input" || parsed.type === "omp:terminal-resize")
  ) {
    log(`slot ${state.slotId}: a non-controlling editor's ${parsed.type} was refused`);
    return;
  }
  const pipeline = () => stateOf(tabId)?.pipeline ?? null;
  const frontendId = terminalFrontendId(tabId);
  switch (parsed.type) {
    case "omp:terminal-link-validate":
    case "omp:terminal-link-open": {
      const cwd = terminalCwd(state) ?? "";
      const panel = state.panel;
      const document = state.document;
      const bridge = state.bridge;
      const documentId = bridge?.documentId;
      const runtime = state.runtime;
      const conversation = state.tabId;
      const shell = state.shellSlot;
      await handleTerminalLink(payload as unknown as TerminalLinkRequest, {
        cwd,
        isCurrent: () => stateOf(tabId) === state && state.panel === panel &&
          state.document === document && state.bridge === bridge && bridge?.documentId === documentId &&
          state.runtime === runtime && state.tabId === conversation && state.shellSlot === shell &&
          (terminalCwd(state) ?? "") === cwd,
        reply: message => pushTerminalTo(state.slotId, message),
        openFile: location => openTerminalFile(vscode, location),
        revealInExplorer: target => revealPathInExplorer(vscode, target),
        revealInOs: target => revealPathInOs(target),
        warn: message => { log(`terminal link: ${message}`); showWarning(message); },
        openUrl: openPageWebLink,
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
          pushSessionView(indexForBridge ?? null, state, true);
          return;
        }
        pushTerminalUnavailable(
          tabId,
          state.mode === "terminal" ? "This native OMP session is not attached to its broker in this window." : "This folder terminal is not attached to its broker in this window.",
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
          pushSessionView(indexForBridge ?? null, state, true);
          return;
        }
        pushTerminalUnavailable(tabId, "This terminal is not attached to its broker in this window.");
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

// Folder shells (ADR-0024): durable slot, own editor, no session identity

/** The recoverable (detached) shells of one folder, newest first. */
function recoverableShellsInFolder(folderPath: string): readonly ShellSlotRecord[] {
  const key = canonicalFolderKey(folderPath);
  if (key === null || shellSlots === undefined) return [];
  const bound = (slot: string) => {
    const tabId = shellEditors.get(slot);
    return tabId !== undefined && stateOf(tabId)?.panel != null;
  };
  return reconnectableShellSlots(shellSlots.list(), key, bound);
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
  const folder = resolveFolderArgument(argument);
  if (folder === null) {
    showWarning("Choose a registered OMP folder to open a terminal in.");
    return;
  }
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
  const folder = resolveFolderArgument(argument);
  if (folder === null) {
    showWarning("Choose a registered OMP folder to reconnect its terminal in.");
    return;
  }
  // Explicit Reconnect can also rebind an editor this host can still reach.
  const key = canonicalFolderKey(folder.path);
  const candidates = key === null ? [] : shellSlotsForFolder(shellSlots?.list() ?? [], key);
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

/** The folder one folder-scoped command was invoked for. */
function resolveFolderArgument(argument: unknown): LauncherFolder | null {
  if (argument instanceof WorkspaceFolderTreeItem) return launcherFolders?.get(argument.folderId) ?? null;
  const resolved = folderArgument(argument, launcherFolders?.list() ?? []);
  if (resolved.kind === "folder") return resolved.folder;
  if (resolved.kind === "stale") return null;
  if (typeof argument === "string") return launcherFolders?.folderForCwd(argument) ?? null;
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
  const client = await brokerClient();
  if (client === null) {
    showError("Terminal support is unavailable. Reload the window and try Open Terminal again.");
    return;
  }
  const folderKey = canonicalFolderKey(cwd) ?? cwd;
  const store = shellSlots;
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
  shellEditors.set(slot, slot);
  await store.update(slot, { lastGeneration: launched.handle.record.generation, detachedAt: null });
  openShellEditor(context, index, slot, launched.handle);
}

/** Attach to a recorded detached shell and show it, or report that it is gone. */
async function attachFolderShell(
  context: vscode.ExtensionContext,
  index: SessionIndex,
  record: ShellSlotRecord,
): Promise<boolean> {
  const client = await attachBrokerClient();
  if (client === null) return false;
  const attached = await client.attach(record.slot, { owner: folderShellOwner() });
  if (attached.handle === null) {
    // The broker could not be reached — it may still be starting, or it may be gone. The
    // slot is kept either way (the shell's own exit has not been proven),
    // and no promise is made that a retry will succeed.
    return false;
  }
  shellEditors.set(record.slot, record.slot);
  await shellSlots?.update(record.slot, { detachedAt: null, lastGeneration: attached.handle.record.generation });
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
      log(`shell ${slot}: automatic owner-exit cleanup is disarmed: ${status.detail}`);
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
  const state = tabState(slot);
  state.shellSlot = slot;
  const record = shellSlots?.get(slot) ?? null;
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
      log(`shell ${slot}: a terminal message could not be processed`);
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
  const state = tabState(slot);
  state.runtime = null;
  try {
    await handle.attach();
  } catch (error) {
    log(`shell ${slot}: the broker could not be attached: ${messageOf(error)}`);
  }
  if (stateOf(slot)?.panel == null) return;
  ensureTerminalPipeline(index, slot, handle);
  const stopOwnerWatch = state.ownerStopWatch;
  const stopExitWatch = watchShellExit(handle, {
    async retireSlot() {
      await shellSlots?.remove(slot);
      await brokerSlots?.forget(slot);
      refreshLauncher();
    },
    log: message => log(`shell ${slot}: ${message}`),
    runRetirement: operation => index.lifecycle.run(slot, operation),
  });
  state.ownerStopWatch = options => {
    stopOwnerWatch?.(options);
    stopExitWatch(options);
  };
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
  const state = stateOf(slot);
  if (state === undefined || state.panel !== panel) return;
  state.panel = null;
  state.origin = null;
  shellEditors.delete(slot);
  const record = shellSlots?.get(slot) ?? null;
  if (record === null) {
    stopTerminalForTab(slot);
    tabs.delete(slot);
    shellEditors.delete(slot);
    refreshLauncher();
    return;
  }
  // Detaching is recorded first: from here on, this slot is recoverable whether or
  // not the confirm below ever returns.
  await shellSlots?.update(slot, { detachedAt: new Date().toISOString() });
  const observation = await observeFolderShell(slot);
  stopTerminalForTab(slot);
  if (observation === "exited") {
    tabs.delete(slot);
    shellEditors.delete(slot);
    await shellSlots?.remove(slot);
    log(`shell ${slot}: closed after its process exited; no tree-stop claim made`);
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
      log(`shell ${slot}: terminal for ${record.cwd} could not be reattached`);
      showWarning("This terminal could not be reconnected. Use Reconnect Terminal to try again.");
    }
    refreshLauncher();
    return;
  }
  await terminateFolderShell(slot, record);
  refreshLauncher();
  // A genuine failure retains its recovery slot, but no longer represents an open
  // editor. Re-read child status so Processes offers Stop with the current facts.
  void vscode.commands.executeCommand("omp.refreshProcesses");
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
  const handle = await shellWriterFor(slot);
  if (handle === null) {
    log(`shell ${slot}: terminal for ${record.cwd} could not be reached for termination`);
    showWarning("This terminal could not be reached. Use Stop in Processes to try again.");
    return;
  }
  const outcome = await stopShellAndBroker(handle, {
    async retireSlot() {
      await shellSlots?.remove(slot);
      await brokerSlots?.forget(slot);
      tabs.delete(slot);
      shellEditors.delete(slot);
    },
    log: message => log(`shell ${slot}: ${message}`),
  });
  if (outcome.kind === "unconfirmed") {
    showWarning(outcome.stage === "retirement"
      ? "This terminal stopped, but its recovery record could not be updated. See OMP Desk output."
      : "This terminal could not be confirmed stopped. Use Stop in Processes to try again; see OMP Desk output.");
  }
}

/** The serializer VS Code revives folder-shell editors through. */
function shellSerializerFor(context: vscode.ExtensionContext, index: SessionIndex) {
  return {
    async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: unknown): Promise<void> {
      const slot = persistedShellSlotId(state);
      const record = slot === null ? null : shellSlots?.get(slot) ?? null;
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
        log(`shell ${slot}: the restored editor could not reattach its broker`);
      }
    },
  };
}

/**
 * The broker client, with its staged runtime proven ready to *start* a child.
 *
 * Used by every path that launches (a new session, a relaunch, a folder shell). A proven
 * runtime is kept for the activation; a *failed* readiness check is not, because the client
 * retries a staging or self-check failure that a later attempt would not hit — latching it
 * for the window's lifetime would make a surviving broker look unavailable to every
 * ownership recheck after a full VS Code restart. The proof is started in the background
 * once the startup restore pass settles (see {@link startStartupRestore}), so a launch
 * seldom waits for it.
 */
async function brokerClient(): Promise<PtyBrokerClient | null> {
  const gate = ptyGate;
  if (gate === undefined) return null;
  return await gate.client();
}

/**
 * The broker client for re-adopting an already-running broker: only the verified identity
 * probe is required, never the staged tree's staging and self-check. Attach and reconcile
 * use the durable record, the kernel creation-time check and the token handshake, none of
 * which executes the staged tree, so restore does not wait for the runtime proof.
 */
async function attachBrokerClient(): Promise<PtyBrokerClient | null> {
  const gate = ptyGate;
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

/** The longest session title the control channel, the tree and the slot all accept. */
const MAX_SESSION_TITLE_CHARS = 200;

/** Ask for a session's stored name, validated by the same rules every writer uses. */
async function promptSessionTitle(entry: SessionIndexEntry): Promise<string | undefined> {
  const proposed = await vscode.window.showInputBox({
    title: `Rename ${path.basename(entry.cwd)}`,
    prompt: "The name OMP stores for this session, shown in its own TUI and in OMP's history.",
    value: entry.title ?? "",
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
      if ((observed.ok && observed.claim !== null && observed.claim.holderId !== index.claimHolder.id && claimHolderMayBeAlive(observed.claim)) || await verifiedOwnedWriterPid(index, tabId) !== null) {
        showWarning("This session is running in another editor. Rename it there.");
        return;
      }
      await index.recordConversationState(tabId, { title: proposed.trim() });
      void applyChatTabAppearance(context, index, tabId);
    });
    refreshLauncher();
    return;
  }
  if (stateOf(tabId)?.runtime != null) {
    showError("This session's native process is still running in this window; a running session is renamed through it instead.");
    return;
  }
  const proposed = await promptSessionTitle(entry);
  if (proposed === undefined) return;
  const title = proposed.trim();
  if (title === (entry.title ?? "")) return;

  let helper: StagedRuntimeAsset;
  try {
    helper = (await runtimeEntries(context)).renameHelper;
  } catch (error) {
    log(`rename helper staging failed: ${messageOf(error)}`);
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
  let binary: Awaited<ReturnType<typeof resolveOmpBinary>> | null = null;
  try {
    binary = await resolveOmpBinary();
  } catch (error) {
    log(`the installed OMP could not be resolved for a rename: ${messageOf(error)}`);
  }
  // The package source must come from the *selected* executable's own install tree,
  // never from a similarly named package somewhere else on the machine.
  const pkg = binary === null ? null : await resolveOmpPackageRoot(binary);
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
    claim = await acquireClaim(context.globalStorageUri.fsPath, file, ownerGeneration, index.claimHolder);
  } catch (error) {
    log(`rename claim failed: ${messageOf(error)}`);
    showError("This session could not be opened for renaming. Refresh Sessions and try again; see OMP Desk output for details.");
    return;
  }
  try {
    const observed = await index.observeOwnership(tabId);
    if ((observed.ok && observed.claim !== null && observed.claim.holderId !== index.claimHolder.id && claimHolderMayBeAlive(observed.claim)) || await verifiedOwnedWriterPid(index, tabId) !== null) {
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
  const { tabId, entry } = target;
  const nativeState = stateOf(tabId);
  const native = nativeState?.runtime;
  if (nativeState !== undefined && native?.kind === "terminal") {
    if (nativeState.transitioning || passiveReasonOf(tabId) !== null || nativeState.control === null) {
      showWarning("Rename is unavailable while this editor is read-only, stopping, or disconnected. Reopen its running editor and try again.");
      return;
    }
    const client = nativeState.control.client;
    try {
      const snapshot = await client.snapshot();
      const facts = await client.nativeState();
      if (!facts.available) { showWarning(facts.unavailableReason ?? "Native Rename is unsupported."); return; }
      const captured = { epoch: snapshot.host.epoch, sessionFile: facts.sessionFile, sessionId: facts.sessionId };
      const proposed = await promptSessionTitle(entry);
      if (proposed === undefined) return;
      await index.lifecycle.run(tabId, async () => {
        if (nativeState.runtime !== native || nativeState.tabId !== tabId || nativeState.transitioning || nativeState.control?.client !== client || passiveReasonOf(tabId) !== null) return;
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
  if (nativeState?.runtime == null && chat.sessionOf(tabId) === null && entry.sessionFile !== null && await verifiedOwnedWriterPid(index, tabId) !== null) {
    await openTab(context, index, tabId, "opened", "restored");
    if (stateOf(tabId)?.runtime == null) {
      showWarning("The exact live editor could not be reattached. Nothing was renamed; no replacement was started.");
      return;
    }
    await renameSession(context, index, tabId);
    return;
  }
  const session = chat.sessionOf(tabId);
  const running = session !== null && rpcPhaseIsRunning(session.phase);
  if (!running) {
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
  const outcome = await session.setSessionName(title);
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
  log(
    `close: target ${tabId} (argument ${argument === undefined ? "none" : typeof argument}); ` +
      `editor in front ${editorInFrontConversation(index) ?? "none"}; index active ${index.activeTabId ?? "none"}`,
  );
  const running = entry.runIntent === "running" || entry.availability === "live";
  if (!running) {
    showInfo("That session is already stopped.");
    return;
  }
  const state = stateOf(tabId);
  const runtime = state?.runtime ?? null;
  // A confirmation asks the user to approve stopping one exact transport, so there has
  // to be one. A row whose child this window does not drive but which recorded its own
  // broker slot (a survivor of an earlier extension host) is stopped through that slot by
  // the recorded-host path, which asks its own exact confirmation; a row with no reachable
  // transport is told that, with the row's own reason, and nothing is stopped.
  if (runtime === null) {
    if (entry.host !== null) {
      await stopSessionHost(context, index, argument);
      return;
    }
    showWarning(
      "This window is not running an OMP host for that session, so nothing was stopped." +
        (entry.detail === null ? "" : ` ${entry.detail}`),
    );
    return;
  }
  if (state !== undefined) await confirmAndStopRuntime(context, index, tabId, state, runtime, "Close");
}

/** Dialogs never hold the gate; admission remains fenced through both stop attempts. */
async function confirmAndStopRuntime(
  context: vscode.ExtensionContext, index: SessionIndex, tabId: string,
  state: TabState, runtime: SessionHostRuntime, label: "Stop" | "Close",
  /**
   * What the caller (the Processes view, which asks nothing for a single stop) captured just
   * before: whether this window's runtime was passive, and the transition facts read under the
   * gate. Its own prompt is skipped, the same checks bind to this capture, and a runtime that
   * is no longer the captured one is refused visibly.
   */
  preconfirmed?: { readonly conflicting: boolean; readonly captured: SessionTransitionFacts | null },
): Promise<void> {
  const entry = index.get(tabId);
  if (entry === null || state.runtime !== runtime || state.tabId !== tabId) {
    if (preconfirmed !== undefined) showWarning("The session changed while the stop was being prepared, so nothing was stopped.");
    return;
  }
  const conflicting = preconfirmed?.conflicting ?? passiveReasonForSlot(state.slotId) !== null;
  const previouslyStopping = runtime.kind === "terminal" && runtime.stopping;
  fenceSessionAdmission(index, state, true);
  try {
    const captured = preconfirmed !== undefined ? preconfirmed.captured : await index.lifecycle.run(tabId, async () => await readTransitionFacts(state, runtime));
    if (preconfirmed === undefined) {
      const choice = await vscode.window.showWarningMessage(
        `${label} the OMP session “${launcherProvider?.headlineFor(entry.tabId) ?? sessionHeadline(entry, null)}”?`,
        { modal: true, detail: conflicting
          ? "Only this window's copy of the session is stopped; the window that owns it keeps it."
          : "The OMP process ends and a turn in progress is aborted. The conversation stays in OMP's session files and can be resumed." },
        label,
      );
      if (choice !== label) return;
    }
    stoppingTabs.add(tabId);
    refreshLauncher();
    const attempt = async (mode: "graceful" | "force"): Promise<NativeStopVerdict | null> =>
      await index.lifecycle.run(tabId, async lease => {
        if (state.runtime !== runtime || state.tabId !== tabId || (passiveReasonForSlot(state.slotId) !== null) !== conflicting) return null;
        if (mode === "force" && captured !== null) {
          const fresh = await readTransitionFacts(state, runtime);
          if (fresh !== null && (fresh.epoch !== captured.epoch || fresh.file !== captured.file || fresh.sessionId !== captured.sessionId)) {
            showWarning("The session target changed while Force Stop was pending; nothing was stopped.");
            return null;
          }
        }
        const stopped = previouslyStopping && mode === "graceful"
          ? { writerGone: false, treeEmpty: false, detail: "Native shutdown is already pending; no new shutdown is sent." }
          : await stopSessionRuntime(state, runtime, mode, true, captured);
        log(`session stop ${tabId}: ${"diagnosticDetail" in stopped ? stopped.diagnosticDetail ?? stopped.detail : stopped.detail}`);
        if (!stopped.writerGone) {
          state.controlFailure = stopped.detail;
          return stopped;
        }
        state.runtime = null;
        stopTerminalForTab(state.slotId);
        state.nativeWatch?.();
        state.nativeWatch = null;
        disposeControlChannel(state);
        await releaseHostControl(context, tabId, controlOwnerFor(runtime, entry.ownership?.ownerGeneration ?? ""));
        await retireBroker(tabId, runtime);
        if (!conflicting) {
          await index.setRunIntent(tabId, "stopped", stopped.detail);
          await index.closeSession(tabId, { confirmedStopped: true, detail: stopped.detail }, lease);
          chat.release(tabId);
          forgetTurnActivity(index, tabId);
        }
        state.controlFailure = null;
        return stopped;
      });
    let stopped = await attempt("graceful");
    if (stopped === null) { showWarning("The captured process/editor changed; nothing was stopped."); return; }
    if (!stopped.writerGone) {
      const force = await vscode.window.showWarningMessage(
        `This session could not be confirmed stopped. ${stopped.detail}`,
        { modal: true, detail: "Force Stop may lose unsaved replies and work in progress. Commands started by OMP may continue running separately. Nothing is restarted automatically; check Sessions before resuming." },
        "Force Stop",
      );
      if (force === "Force Stop") stopped = await attempt("force");
    }
    if (stopped !== null && !stopped.writerGone) showWarning(stopped.detail);
  } finally {
    stoppingTabs.delete(tabId);
    if (state.runtime !== runtime || runtime.kind !== "terminal" || !runtime.stopping) fenceSessionAdmission(index, state, false);
    else pushSessionView(index, state);
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
  if (state?.runtime == null) {
    const pid = await verifiedOwnedWriterPid(index, target.tabId);
    if (pid === null) { showInfo("That session is stopped. Use Resume to start it again."); return; }
    await openTab(context, index, target.tabId, "opened", "restored");
    state = stateOf(target.tabId);
  }
  if (state?.runtime == null || state.panel === null) {
    showWarning("OMP could not reconnect this tab to its running session, so nothing was reloaded. Run “Developer: Reload Window”, then try again; no process was started or stopped.");
    return;
  }
  await switchSessionMode(context, index, state, state.runtime.kind, true);
}
