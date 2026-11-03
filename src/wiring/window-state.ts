/**
 * The state of one OMP Desk window and of one editor in it: the record types `createWindow` (`src/wiring/window.ts`) builds and
 * the modules it hands the window to read and write. Types only: no module here has behaviour, so a region cut out of the window
 * can name them without importing the factory.
 */
import type { ControlHostSnapshot } from "../wire/control-protocol";
import type { HostControlClient } from "../host/control-client";
import type * as vscode from "vscode";
import type { HtmlPageServer } from "../host/html-page-server";
import type { ProviderUsageCache } from "../host/provider-usage";
import type { HelperScheduler } from "../host/helper-scheduler";
import type { BranchObservation } from "../host/session-branch";
import type { FooterMetadataMessage } from "../shared/footer-metadata";
import type { SessionsGrouping } from "../views/session-order";
import type { SessionIndex } from "../host/session-index";
import type { RuntimeStaging } from "../runtime/runtime-entries";
import type { LocalSessionRuntime } from "../runtime/local-runtime";
import type { RestoreOutcome } from "../host/session-index";
import type { OwnerReconciler } from "../host/session-availability";
import type { SessionViewMode } from "../host/session-model";
import type { LaunchTimeline } from "../host/launch-timeline";
import type { PendingOperations } from "../host/pending-operations";
import type { PendingDisplay } from "../host/pending-display";
import type { PersistFailureReporter } from "../host/persist-report";
import type { PageHealthMonitor } from "../host/page-health";
import type { WindowRegistry } from "../host/window-registry";
import type { EditorSlotPruner } from "../host/editor-slot-prune";
import type { ExternalLeaseObserver } from "../host/omp-session-lease";
import type { EditorRecency } from "./editor-context";
import type { TurnNotifier } from "../wire/notifications";
import type { TurnActivity } from "../wire/notifications";
import type { PackageDrift } from "../host/package-drift";
import type { DiagnosticsRecorder } from "../host/diagnostics";
import type { SessionTreeProvider } from "../views/session-tree";
import type { InventoryHandle } from "./inventory-wiring";
import type { ContextHandle } from "./context-wiring";
import type { UsageStatusHandle } from "./usage-status-wiring";
import type { KeyHintsHandle } from "./key-hints-wiring";
import type { WindowRouting } from "./window-routing";
import type { FileWindow } from "./file-window";
import type { SessionActions } from "./session-actions";
import type { CarriedDraft, GuestDispatcher } from "./guest-dispatcher";
import type { ArtifactDocuments } from "./artifact-documents";
import type { SessionFileDocuments } from "./session-file-documents";
import type { BridgeHost, BridgeHostDeps } from "./bridge-host";
import type { EditorPanels, PanelDocument } from "./editor-panels";
import type { LauncherTreeItem } from "../views/session-tree";
import type { LauncherFolders } from "../views/launcher-folders";
import type { PendingForks } from "../host/pending-forks";
import type { recordedRootGone } from "../host/native-session";
import type { SessionHostRuntime } from "../host/native-session";
import type { SlashRegistry } from "../host/slash-registry";
import type { ServedModelMemo } from "../host/served-model";
import type { ChatPhase } from "../chat/model";
import type { BridgeEditorEndpoint } from "../host/bridge-endpoint";
import type { EditorCoordinator } from "../host/editor-coordinator";
import type { DetailTabs } from "../host/detail-tabs";
import type { MermaidPreviews } from "../host/mermaid-previews";
import type { PtyBrokerClient } from "../host/pty-client";
import type { PtyReadinessGate } from "../host/pty-readiness";
import type { EditorSlotRegistry } from "../host/editor-slots";
import type { BrokerSlotStore } from "../host/broker-slots";
import type { TerminalPipeline } from "../host/terminal-pipeline";
import type { SymbolLinkResolver } from "../host/symbol-links";
import type { CommitLinkResolver } from "../host/commit-links";
import type { LinkRuleSource } from "../host/link-rules";
import type { ShellSlotStore } from "../host/shell-slots";
import type { ShellExitWatchStop } from "../host/shell-exit";
import type { CatalogStore } from "../host/profile-catalog";
import type { CatalogRecoveryHandle } from "./catalog-recovery";
import type { CatalogAdoption } from "./catalog-adoption";
import type { SessionFlows } from "./session-flows";
import type { SessionProcesses } from "./process-wiring";
import type { GuestSessionViewMessage } from "../protocol/messages";

/**
 * One editor's live resources and one conversation's native side, as this window
 * holds them.
 *
 * A record belongs to an **immutable editor slot** (ADR-0025): its key in
 * {@link WindowState.tabs} is the editor id `E` (32 hex) for a session editor, the shell slot
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
 * Whether a slot may *act* is not stored here: the {@link WindowState.editorSlots} registry owns
 * role, generation and the reason a slot is passive, and {@link passiveReasonOf} is
 * the one way to read it.
 */
export interface TabState {
  /** The immutable key this record is filed under in {@link WindowState.tabs}. */
  slotId: string;
  /** The conversation this editor shows, or `null` for a folder shell. */
  tabId: string | null;
  panel: vscode.WebviewPanel | null;
  mode: SessionViewMode;
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
   * request and the last close — both from {@link WindowState.editorEventSequence}, so their
   * order is known rather than guessed. `-1` means the event never happened in this
   * window. An open attempt that waited for the activation pass compares them
   * on resume so its continuation cannot reopen an editor closed meanwhile.
   */
  lastOpenRequest: number;
  lastEditorClose: number;
  /**
   * This tab's editor was created by the open attempt now in flight (not already open when it began): a Cancel of that attempt's
   * external-writer question closes it again unless the row's run intent is `stopped` (ADR-0046, editor first). Cleared when the attempt ends.
   */
  editorOfAttempt: boolean;
  /** The verb of the open attempt now in flight for this tab, or `null`: a `resumed` click joining a history view upgrades it to a launch. */
  openingVerb: "started" | "opened" | "resumed" | null;
  /** The last open attempt of this tab ended at a Cancel of its external-writer question (so `openSession` reports it as not opened). */
  openDeclined: boolean;
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
 * Everything one window mutates while it runs, in one object.
 *
 * `activate` builds it with {@link createWindowState} and installs it in the one module
 * binding, {@link window}; every function reads it through {@link windowState}. Grouped by concern.
 */
export interface WindowState {
  // Session index and claims
  /**
   * Ownership reconciliation for this window, built by activation.
   *
   * It is not a bare module function on purpose: reconciling a surviving writer needs
   * the durable broker-slot locator and the PTY broker client, and the transport it
   * proves must be the transport the later attach uses. Activation owns both, so it
   * builds the ports here — before any restore, open or draft pass runs.
   */
  reconciler: OwnerReconciler;
  /** This window's session runtime (ADR-0066): open, restore and reattach go through it, never to the index directly. */
  sessionRuntime: LocalSessionRuntime;
  /** The session index this activation created, for the bridge's own eligibility checks. */
  indexForBridge: SessionIndex | null;
  /** This window's view of the profile catalog, built once at activation (ADR-0034). */
  catalogStore: CatalogStore | undefined;
  /** The private backup and loss report of the catalog (ADR-0081); set with the catalog. */
  catalogRecovery: CatalogRecoveryHandle | undefined;
  /**
   * Reads the catalog at activation, adopts what the catalog's commits change (this window's and a peer's, by record key),
   * runs the startup restore pass over the rows this window is responsible for, and owns the state of that pass (the
   * pending flag, the pass and its kept broker connections, the deferral display-only reads wait on). See
   * `src/wiring/catalog-adoption.ts`.
   *
   * Editor restoration and commands consult `ready()`: VS Code may hand this window a restored editor (or a command may
   * arrive) before the catalog has been read, and resolving a row against a not-yet-read catalog would report a stored
   * session as gone.
   */
  readonly catalogAdoption: CatalogAdoption;
  /** The session-lease observer of this window (ADR-0046); `null` where there is no probe. */
  externalLeases: ExternalLeaseObserver | null;
  /** Claim file name per row target, resolved once: the name needs the filesystem, and a watch batch asks for every row. */
  readonly claimFileNames: Map<string, string | null>;

  // Window registry and routing
  /** The leased registry of this profile's windows (ADR-0056), once this window activated. */
  windowRegistry: WindowRegistry | undefined;
  /** Remembers the editor slots this window has held and drops the passive bindings of the ones that closed (ADR-0025 amendment 2026-10-19); set at activation. */
  editorSlotPruner: EditorSlotPruner | undefined;
  /** Re-probe the session folders (the checkout roots) of every live window's folders; set at activation. */
  resolveSessionFolders: () => Promise<void>;
  /**
   * Tabs whose editor a window request has made visible and whose serializer revival has not
   * happened yet. The revival consumes the mark ({@link WindowRouting.openRestoredTabIfUncovered}) and, for a
   * session with no live host, then opens nothing; an explicit Open of the tab clears it.
   * Nothing releases it on elapsed time: a request selects an editor, it never starts, restores
   * or claims a session, however late VS Code revives the editor.
   */
  readonly requestSelections: Set<string>;
  /** Hands sessions and launches to the other windows of the profile and serves their requests (ADR-0056, ADR-0057). */
  readonly routing: WindowRouting;
  /** The Ctrl+Shift+M file window: files from Chat links open in it while it lasts. */
  readonly fileWindow: FileWindow;

  // Editor panels and bridge
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
  readonly tabs: Map<string, TabState>;
  /**
   * The window's reconnecting bridge (ADR-0023): the endpoints and documents of its editors, their routes and the host
   * generation. It owns the workspace hash, the record store, the endpoints being created and the serializer types. The
   * lifecycle harness never replaces it: its host generation is the one every endpoint of the window is fenced to.
   */
  readonly bridgeHost: BridgeHost<TabState>;
  /** The loopback server of a reply's HTML page frame (ADR-0079): bound lazily, only while `ompDesk.chatHtmlPages` is on. */
  readonly htmlPageServer: HtmlPageServer;
  /**
   * The window's session editors as VS Code panels: where one opens, how a panel becomes a chat surface, the document it
   * shows and the serializers that revive it. Mutable only because the lifecycle harness replaces it with a handle built
   * from fake facts; no product code assigns it.
   */
  editorPanels: EditorPanels;
  /** One endpoint per actual editor (`E`) this window serves; the bridge host creates them and `dispose` closes them. */
  readonly bridgeEndpoints: Map<string, BridgeEditorEndpoint>;
  /**
   * Builds one editor's endpoint for the bridge host. Product code never assigns it; the lifecycle harness swaps in an
   * endpoint whose listener cannot bind, so its editors run on the panel route with the host's real creation path.
   */
  createBridgeEndpoint: BridgeHostDeps<TabState>["createEndpoint"];
  /**
   * Whether a runtime's recorded OMP root has already ended (`recordedRootGone` over this window's broker client). Product
   * code never assigns it; the lifecycle harness, whose runtimes carry process ids no real process has, answers for the
   * roots it models.
   */
  rootGone: (root: { readonly pid: number; readonly creationTime: string | null }) => Promise<boolean>;
  /** Editor ids present in this window's actual editor membership right now. */
  readonly bridgeLiveEditors: Set<string>;
  /** The one-winner reservation table of this window's editors (ADR-0019/0023). */
  readonly bridgeEditors: EditorCoordinator;
  /** Last restore outcome per tab: real refused/failed status the launcher shows. */
  readonly outcomes: Map<string, RestoreOutcome>;
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
  readonly openingTabs: Map<string, Promise<void>>;
  /** A Chat /new or /delete replaces its editor in that editor's own group. */
  readonly sessionPanelColumns: Map<string, vscode.ViewColumn>;
  /** Confirmed recorded-host stops still awaiting their broker verdict. */
  readonly stoppingTabs: Set<string>;
  /**
   * The document each editor's page has announced (`omp:ready`) it is listening in. A reference is
   * posted to a chat page only once its current document is in here: a page that has not announced
   * itself has no composer to receive it.
   */
  readonly readyDocuments: WeakMap<TabState, PanelDocument>;
  /** Callers waiting for one editor slot's panel handle, resolved by {@link bindPanel}. */
  readonly panelBindWaiters: Map<string, Set<() => void>>;
  /** Pending view requests disable title actions before initialization is ready to be fenced. */
  readonly pendingSessionViewChanges: Map<TabState, number>;
  /** One id per panel handle, so a route can be detached without keeping the panel alive. */
  readonly panelPageIds: WeakMap<vscode.WebviewPanel, string>;
  /** Source of the next {@link WindowState.panelPageIds} id. */
  panelPageSequence: number;
  /** The native-screen copy request in flight per terminal editor; it expires after a short deadline. */
  readonly terminalCopyRequests: WeakMap<TabState, TerminalCopyRequest>;
  /**
   * Elections in flight, by editor slot: the durable record of which editor controls a
   * session is being written, and a command that arrives before it settles waits for it
   * instead of being judged on the interim, passive answer.
   */
  readonly slotElections: Map<string, Set<Promise<void>>>;
  /** The footer metadata each chat tab last published, with the branch observer that keeps it current. */
  readonly footerBindings: Map<string, {
    cwd: string;
    message: FooterMetadataMessage;
    observer: BranchObservation | null;
    modelId: string | null;
    /** When the provider usage behind `message` was last read successfully (host-only; the status bar's tooltip). */
    usageReadAt?: number | null;
  }>;

  // Guest dispatch
  /** The page-message dispatcher; it owns the selection and draft-capture request tables. */
  readonly guestDispatcher: GuestDispatcher<TabState>;
  /** Tabs whose composer currently shows its `@`-completion popup (reported by the page). */
  readonly composerPopupTabs: Set<string>;
  /** Watches the liveness reports of this window's Chat pages and logs a page that stops answering (one timer, only while a page is watched). */
  readonly pageHealth: PageHealthMonitor;
  /** Drafts captured from a replaced document, waiting for its successor to be ready (by editor slot). */
  readonly draftRestores: Map<string, CarriedDraft<TabState>>;
  /**
   * The installed OMP's builtin slash registry, read once per install by `media/slash-registry.mjs` and re-checked at
   * most once a minute, so an OMP update changes which typed commands are terminal-only without a Desk release.
   * `null` while unknown: nothing is refused as terminal-only then.
   */
  slashRegistry: SlashRegistry | null;
  /** The install whose registry could not be read: its helper is not started again until the install changes. */
  slashRegistryFailedKey: string | null;
  /** When the slash registry was last read (epoch ms). */
  slashRegistryCheckedAt: number;
  /** The slash registry read in flight, if any. */
  slashRegistryLoading: Promise<void> | null;
  /** The served-model verdicts read from the installed OMP, per install: a page asks only about replies that name another served id. */
  servedModels: ServedModelMemo;
  /**
   * The window's code-symbol resolver (docs/designs/2026-10-10-code-symbol-links.md): created by the first Chat
   * request, asking VS Code's workspace symbol providers, and dropped whenever files or folders change. Only
   * `file` locations count; a provider's library or metadata location has no path inside any session folder.
   */
  symbolLinks: SymbolLinkResolver | undefined;
  /** The window's commit-hash link resolver (docs/designs/2026-10-17-commit-hash-links.md): created by the first Chat request that names a hash. */
  commitLinks: CommitLinkResolver | undefined;
  /** Slots whose pages asked about symbols, told when parked tokens may be asked again. */
  readonly symbolAskers: Set<string>;
  /** The installed Nerd Font families, once read. */
  installedTerminalFonts: readonly string[];
  /** The one read of the installed terminal fonts, started by the first terminal pane that asks. */
  installedTerminalFontsRead: Promise<void> | null;

  // PTY and broker
  /**
   * The extension-owned PTY broker client: the only way this window starts or
   * re-adopts a managed writer (ADR-0024).
   *
   * Created once per activation. Its presence is not evidence that a broker exists —
   * {@link ready} answers that — and nothing here starts a process by itself.
   */
  ptyClient: PtyBrokerClient | undefined;
  /**
   * This window's readiness gate over {@link WindowState.ptyClient}.
   *
   * `PtyBrokerClient.ready()` refuses to cache a failure on purpose — a half-finished
   * staging pass is the usual cause — so the window must not cache one either: a
   * transient self-check failure at startup would otherwise make every surviving
   * broker unadoptable for the rest of the activation. The gate latches a *proven*
   * runtime, shares one attempt between callers that arrive together, and retries a
   * failed check when a later row, click, recheck or attach asks again.
   */
  ptyGate: PtyReadinessGate | undefined;
  /**
   * Which broker slot each managed host occupies, keyed by the editor slot that
   * opened it and by the conversation it currently serves.
   *
   * The slot is the only way a broker record is found again, so it must survive both
   * a conversation switch and an extension-host restart — which is why it is neither
   * derived from the conversation id nor from anything the process reports.
   */
  brokerSlots: BrokerSlotStore | undefined;
  /**
   * This window's map from an immutable editor slot to the live resources it holds.
   *
   * Derived state, rebuilt as panels are bound: it tells a slot apart from the
   * conversation it currently shows, so two editors of one conversation (a stopped
   * editor and the editor a native switch moved onto that conversation) coexist with
   * exactly one controller and no key collisions.
   */
  readonly editorSlots: EditorSlotRegistry;
  /** The durable folder-shell slot registry; folder shells are never sessions. */
  shellSlots: ShellSlotStore | undefined;
  /**
   * Folder-shell editors this window carries: slot id to the tab id its editor uses.
   *
   * A shell is not an indexed tab, but it needs the same panel plumbing (one editor,
   * one serializer identity, one protocol for its page). The mapping is what lets a
   * close, a reconnect and a serializer revival find the same slot.
   */
  readonly shellEditors: Map<string, string>;
  /** Launch, recovery and the native watch share one connection attempt for the exact runtime. */
  readonly hostControlAttempts: WeakMap<SessionHostRuntime, Promise<void>>;

  // Views
  /** The inventory views' registration handle; `null` before they register and after they are disposed. */
  inventoryViews: InventoryHandle | null;
  /** The context view's registration handle; `null` before it registers. */
  contextView: ContextHandle | null;
  /** The provider-usage status bar item; `null` before it registers. */
  usageStatus: UsageStatusHandle | null;
  /** The effective keys of the empty state and what may take them; `null` before they register. */
  keyHints: KeyHintsHandle | null;
  /** The user's link rules (`ompDesk.chatLinkRules`, user settings only); created on first use. */
  linkRules: LinkRuleSource | null;
  /** The Sessions view's background processes: its reader, poll and stop commands. */
  sessionProcesses: SessionProcesses | null;
  /**
   * What the Sessions view's commands do to one session or process (click, open, forget, stop, kill, delete, refresh) and the
   * processes of its brokers. Created with the window. It is mutable only because the lifecycle harness replaces it with a handle
   * built from fake broker facts; no product code assigns it.
   */
  sessionActions: SessionActions;
  /**
   * The compound flows of one session's editor: open or focus a tab, open it in an explicit view, change an editor's view,
   * restart an unresponsive Chat and resume a stopped one. See `src/wiring/session-flows.ts`. Created with the window; the
   * tables its flows mark (`openingTabs`, `pendingSessionViewChanges`, `draftRestores`, `editorEventSequence`, `outcomes`) stay
   * here, because the launcher, the editors and the close handlers read them too.
   */
  readonly sessionFlows: SessionFlows<TabState>;
  /** The activity-bar launcher, when this window created it. */
  launcherProvider: SessionTreeProvider | undefined;
  /** The Sessions tree view of the launcher. */
  launcherView: vscode.TreeView<LauncherTreeItem> | undefined;
  /** The reveal loop of the launcher, while it runs: concurrent requests share it. */
  launcherRevealInFlight: Promise<void> | null;
  /** A reveal was asked for while the loop was running, so it runs once more. */
  launcherRevealRequested: boolean;
  /** The tree row the launcher last selected for the active session. */
  launcherSelectedPath: string | null;
  /** The tab whose folder the next reveal may expand because the user just activated it, or `null`. */
  launcherExpandFor: string | null;
  /**
   * The folders the launcher shows in this window: the folders VS Code has open, the
   * profile-wide pinned list and folders kept visible by a live session, deduplicated
   * by path identity. It owns no session identity and no history;
   * `src/views/launcher-folders.ts` owns the merge, `src/views/workspace-folders.ts`
   * owns the pinned list's schema, and `src/host/folder-history.ts` owns the on-demand
   * discovery a folder's Resume action asks for.
   */
  launcherFolders: LauncherFolders | undefined;
  /** The layout the user last used that serves session rows (flat until one is seen): where a reveal goes when Terminals has no row for the session. */
  lastSessionServingLayout: SessionsGrouping | null;
  /** The debounce that restores the pinned session's row after the user selects another. */
  pinnedSelectionTimer: NodeJS.Timeout | undefined;
  /**
   * Open observation documents, by opaque token. Only the binding is held: the
   * bytes are re-read from the store on every request, so a deleted or replaced
   * observation can never be served from a copy this window once made.
   */
  readonly observationDocuments: Map<string, ObservationDocumentEntry>;
  /** Fires when an observation the window may be showing has changed. */
  readonly observationDocumentChanges: vscode.EventEmitter<vscode.Uri>;
  /** Fires so an already-open report document re-reads its content. */
  readonly diagnosticsDocumentChanges: vscode.EventEmitter<vscode.Uri>;

  // Providers and models
  /** Whether the default profile lists any model; `null` while unknown. */
  defaultProviderModelsAvailable: boolean | null;
  /** The one default-profile model read in flight, if any. */
  defaultProviderModelsRead: Promise<void> | null;
  /** A read was asked for while one ran, so it repeats once. */
  defaultProviderModelsDirty: boolean;
  /** The model read in flight per session tab. */
  readonly sessionModelReads: Map<string, Promise<void>>;
  /** Session tabs whose model list must be read again once their turn ends. */
  readonly sessionModelRefreshOwed: Set<string>;
  /** The provider login terminal while it is open. */
  providerLoginTerminal: vscode.Terminal | null;
  /** The provider login or logout flow running in this window, if any: aborting it ends its OMP process. */
  providerAuthRun: AbortController | null;
  /** Provider usage per launch scope. */
  readonly usageCaches: Map<string, ProviderUsageCache>;
  /**
   * Every helper process this window starts for what a conversation shows (provider usage, model catalogue, settings reads, inventory,
   * served-model check): bounded, background work held back until the startup restore is over and spread across windows (ADR-0084).
   */
  helpers: HelperScheduler;

  // Lifecycle
  /**
   * The activation context, for the few callbacks this module wires without one.
   *
   * It is set once in `activate` and only ever read by callbacks the window owns
   * (the turn notifier's "show terminal" action), so nothing else has to thread it.
   */
  context: vscode.ExtensionContext | undefined;
  /** The "OMP Desk" output channel; `log` writes to it. */
  output: vscode.LogOutputChannel | undefined;
  /** The window's diagnostics recorder: the timeline the report document renders. */
  readonly diagnostics: DiagnosticsRecorder;
  /** Where a new session's launch spends its time: begun by New Session, reported by the launcher and the host-control step. */
  readonly launchTimeline: LaunchTimeline;
  /**
   * The actions the user asked for that are still being processed in this window: display only (`docs/designs/2026-10-15-immediate-click-feedback.md`).
   * The Sessions rows, the Sessions view's progress bar, the status bar and every Chat page of the tab read it; nothing decides from it.
   */
  readonly pending: PendingOperations;
  /** Carries `pending` to the Sessions tree, the view's progress bar and the status bar; disposed with the window. */
  readonly pendingDisplay: PendingDisplay;
  /** What a failed save of the session index tells the user: contention is only logged, a fault is shown once per cause. */
  readonly persistFailures: PersistFailureReporter;
  /** Settles when this window's move of the old `omp.*` settings ended (ADR-0068); never rejects. Awaited, bounded, by the first launch. */
  legacySettingsMoved: Promise<void>;
  legacySettingsLateLogged: boolean;
  /** Wall-clock time (`Date.now()`) the extension host activated; the startup timeline lines are relative to it. */
  activatedAt: number;
  /**
   * One window-wide counter numbering every editor event — an open/view request
   * and a panel close — so their order per tab is known (`TabState.lastOpenRequest`,
   * `TabState.lastEditorClose`). A counter rather than a timestamp: two events in
   * the same millisecond still have to be ordered, and nothing outside this window
   * reads it.
   */
  editorEventSequence: number;
  /** Source of the next {@link WindowState.launcherRuntimeIds} identity. */
  nextLauncherRuntimeId: number;
  /** The fingerprint of the package this host started from; `null` outside a packaged (production) install. */
  packageDrift: PackageDrift | null;
  /** The updated-on-disk warning was shown for the current drift. */
  packageDriftAnnounced: boolean;
  /** The last verdict of {@link packageChangedOnDisk}; published in this window's registry record (`stale`) so no other window hands it a launch. */
  packageStale: boolean;

  // Conversations
  /**
   * Read-only detail tabs (TODO, agent roster, one agent) of the conversations in this window. They
   * are presentation pages of a conversation, not editor slots: no binding, claim, bridge or restore.
   */
  detailTabs: DetailTabs;
  /** Diagram tabs: a mermaid source the chat page would not draw inline, drawn in a tab of its own (ADR-0069 amendment). */
  mermaidPreviews: MermaidPreviews;
  /** The read-only `omp-artifact:` documents (tool output design, slice 5); registered at the start of `activate`. */
  artifactDocuments: ArtifactDocuments;
  /** The read-only `omp-session-file:` documents (subagent outputs and `local://` files opened from a Chat link); registered at the start of `activate`. */
  sessionFileDocuments: SessionFileDocuments;
  /**
   * Last host-observed turn activity per tab, projected from the conversation's own model.
   *
   * This is the extension host's view of whether a turn is running: the `ompDesk.streaming`
   * context key, the Sessions rows and the completion notifications all derive from it, so a
   * hidden or closed tab is reported exactly like a visible one.
   */
  readonly turnActivities: Map<string, TurnActivity>;
  /** The OMP editors of this window in the order the user last focused them; orders the add-to-session picker. */
  readonly editorRecency: EditorRecency;
  /**
   * This window's turn notifier, created once per session index.
   *
   * Its ledger must outlive any single panel document: a Webview reload
   * re-reports the session's current activity, and the ledger is what keeps that
   * from becoming a second notice for an event the user was already told about.
   */
  turnNotifier: { readonly index: SessionIndex; readonly notifier: TurnNotifier } | undefined;
  /** Conversations whose Chat /new or /delete replacement is running; a second request is refused. */
  readonly replacingConversations: Set<string>;
  /**
   * Folders whose New Session started in this window and has not finished: the session being started (`null` until its draft exists).
   * A repeated New Session for the folder is ignored and reveals that session. A guard, not a display: it is not part of `pending`.
   */
  readonly newSessionsInFlight: Map<string, string | null>;
  /** Drafts that are forks: the original's session file their first launch passes to OMP's `--fork`. */
  readonly pendingForks: PendingForks;
  /** The last connection-relevant phase logged per tab, so a restoration is reported against the failure it ends. */
  readonly loggedChatPhases: Map<string, ChatPhase>;
  /**
   * Chat tabs whose OMP child reports a subagent that is running or has messages queued, which its
   * own settle state ignores (see {@link hasLiveSubagents}): a parked agent revived by an IRC
   * message is in the registry but is neither a job of the parent nor in the lifecycle-frame roster.
   */
  readonly subagentWork: Map<string, boolean>;
  /** The subagent-work poll per chat tab. */
  readonly subagentWatches: Map<string, ReturnType<typeof setInterval>>;

  // Caches
  /** The verified copies of the runtime entries and the lease helper, staged on first use (ADR-0066). */
  staging: RuntimeStaging;
  /** The identity the launcher gave each runtime, so a restarted host reads as a new one. */
  readonly launcherRuntimeIds: WeakMap<SessionHostRuntime, number>;
  /** The broker watch of each runtime this window drives; a runtime that starts again replaces its own. */
  readonly brokerWatches: WeakMap<SessionHostRuntime, () => void>;
}

export interface TerminalCopyRequest {
  readonly nonce: string;
  readonly panel: vscode.WebviewPanel;
  readonly document: PanelDocument;
  readonly bridgeDocumentId: string | null;
  readonly generation: string;
  readonly deadline: number;
  readonly timer: NodeJS.Timeout;
}

/** What one read-only observation document displays; never stored bytes. */
export interface ObservationDocumentBinding {
  readonly tabId: string;
  readonly recordId: string;
  /** `detail` is the provenance header plus the text; `side` is a diff side. */
  readonly kind: "detail" | "side";
}

export interface ObservationDocumentEntry {
  readonly uri: vscode.Uri;
  readonly binding: ObservationDocumentBinding;
}

// Host control: the native model/thinking channel
//
// The channel is established only after the host proves it is the exact process
// this window launched (same pid, same kernel process generation, same pipe
// server) and completes the HMAC handshake. Until then host control is reported
// as unavailable, and a launch never depends on it succeeding. The runtime owns it
// (`src/runtime/local-control.ts`); this is the window's read side.

/** A verified channel plus the tab it belongs to. */
export interface ControlChannel {
  readonly tabId: string;
  readonly client: HostControlClient;
  readonly snapshot: ControlHostSnapshot | null;
}