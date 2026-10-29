/**
 * The entry `src/extension-lifecycle.test.ts` bundles in place of `extension.ts`. Nothing ships it: `esbuild.mjs` never names it
 * and `extension.ts` never imports it.
 *
 * The lifecycle cases drive private functions of the entry module (`closeSession`, `restoreTabs`, `openTab` through the window's
 * session flows, ...) against the test's stand-ins for `vscode` and the native transports. `extension.ts` exports those
 * functions for this module (see the comment above its first test-only export); this module builds the `harness` object over
 * them, with the fixture state that used to be source text appended to `extension.ts`.
 *
 * The test's esbuild plugin substitutes the modules `vscode`, `./host/session-claim`, `./host/desktop-notifications`,
 * `./host/native-terminal`, `./host/omp-vscode`, `./host/provider-login-rpc`, `./host/rpc-launch`, `./host/control-client`,
 * `./wire/control-protocol` and `./host/rpc-reconcile` by their import specifiers, so this module imports them with the same
 * specifiers `extension.ts` does and gets the same substituted instances. The fixture members those substitutes add to their
 * modules are read through a cast (they are not exports of the real modules).
 */
import type * as vscode from "vscode";
import * as fixtureVscodeModule from "vscode";
import { sessionItemState as fixtureRowState, SessionTreeProvider } from "./views/session-tree";
import * as claimModule from "./host/session-claim";
import * as desktopModule from "./host/desktop-notifications";
import * as nativeTerminalModule from "./host/native-terminal";
import * as providerLoginRpcModule from "./host/provider-login-rpc";
import { bridgeViewType } from "./host/bridge-identity";
import { startClaimWatch } from "./host/claim-watch";
import { HostControlClient } from "./host/control-client";
import { DetailTabs } from "./host/detail-tabs";
import type { ChatRuntime } from "./host/chat-runtime";
import { createOwnerReconciler } from "./host/rpc-reconcile";
import { SessionIndex, type OmpHostLauncher } from "./host/session-index";
import { createShellSlotId, createShellSlotStore } from "./host/shell-slots";
import type { LocalLauncher } from "./runtime/local-launcher";
import { LocalRecordedStop } from "./runtime/local-recorded-stop";
import { LocalSessionRuntime } from "./runtime/local-runtime";
import { registerEditorPanels, type EditorPanelsDeps } from "./wiring/editor-panels";
import { registerSessionActions } from "./wiring/session-actions";
import {
  activateNativeEditor, attachChatRoute, chooseDefaultSessionView, closeSession, copyActiveTerminalScreen, createSessionRuntime,
  createWindowState, defaultSessionMode, deleteSessionInPlace, editorPanelsDeps, forgetTurnActivity, handOverSession,
  handleBridgeRequest, handleChatEvent, handleGuestControlRequest, handlePassiveSlotMessage, handleRestoreOutcome,
  handleShellEditorClosed, handleTerminalGuestMessage, installWindowForTest, launcherFacts, launcherOwnershipFacts,
  localLauncher, loginProviderFromPalette, logoutProviderFromPalette, newSession, newSessionInPlace, newTabState,
  notifierFor, openProviderLogin, openSession, panelResponder, passiveReasonForSlot, postPanelAction, presentRestoreOutcome,
  pushSessionView, quoteEditorSelectionToSession, readChatDisplayPreferences, recordFor, recordSessionModels, refreshChatDisplayPreferences,
  refreshDefaultProviderModels, refreshLauncher, refreshRowsForClaims, refreshSessionModels, releaseSelectionFromOtherWindow,
  reloadSession, renameSession, requestSessionRowExpand, restoreTabs, resumeWorkspaceFolder, revealActiveSession,
  revealDesktopNotification, reviveEditorPanel, runChatAction, sessionActionsDeps, sessionRuntimeDeps, signInProvider,
  startNewSession, subscribeProviderLoginRefresh, tabState, terminalFontMessage, windowState,
} from "./extension";
import type { TabState, WindowState } from "./extension";

// The ids the lifecycle test's fixtures use for its one editor: the same values as `EDITOR`, `TAB` and `DOCUMENT` there.
const EDITOR = "b".repeat(32);
const TAB = "tab:11111111-2222-4333-8444-555555555555";
const DOCUMENT = "c".repeat(32);

/** A function a case installs where the real module has a method: never called with arguments from here. */
type Hook = (...args: never[]) => unknown;
interface FakeTabInput { viewType?: string; uri?: unknown }
interface FakeGroup { viewColumn: number; tabs: unknown[]; activeTab: unknown }
/** The surface of the test's `vscode` stand-in that the harness reads and sets, beyond what the real typings declare. */
interface FakeVscode {
  window: {
    closedTerminals: { fire(value: unknown): void };
    openedDocuments: unknown[];
    quickPicks: unknown[];
    infos: unknown[];
    errors: unknown[];
    errorActions: unknown[];
    errorChoice: unknown;
    tabGroups: { all: FakeGroup[]; activeTabGroup: { activeTab: unknown; viewColumn?: number; tabs?: unknown[] }; changes: { fire(): void } };
    showQuickPick: Hook;
    showInputBox: Hook;
    showWarningMessage: Hook;
    showInformationMessage: Hook;
    createWebviewPanel(): unknown;
  };
  env: { clipboard: { text: string; writes: string[] }; uriScheme?: string; asExternalUri?: Hook };
  workspace: { configurationValues: Record<string, unknown>; configurationWrites: unknown[] };
  commands: { calls: unknown[][]; handler: Hook | null };
  TabInputWebview: new () => FakeTabInput;
  TabInputText: new () => FakeTabInput;
  TabInputCustom: new () => FakeTabInput;
}
const fixtureVscode = fixtureVscodeModule as unknown as FakeVscode;

/** The window's state with its `readonly` fields assignable: the fixture replaces pieces a real window builds once. */
type MutableWindow = { -readonly [K in keyof WindowState]: WindowState[K] };
const mutableWindow = (): MutableWindow => windowState();

// The members the test's substitutes add beside the real exports of the modules they replace.
const claimFixture = claimModule as unknown as { setClaimFailures(codes: string[]): void };
const desktopFixture = desktopModule as unknown as { capturedDesktopXml(): string | undefined; capturedDesktopXmls(): readonly string[]; resetDesktopXmls(): void };
const { providerLoginFixture, storedRenameFixture } = nativeTerminalModule as unknown as { providerLoginFixture: unknown; storedRenameFixture: unknown };
const { providerAuthFixture } = providerLoginRpcModule as unknown as { providerAuthFixture: unknown };

// The harness runs windows without an activation context: the cases that need one set it on the window.
const fixtureContext = undefined as never;
// The chat runtime the case built; the runtime and its launcher are constructed from it.
let fixtureChat = undefined as never as ChatRuntime;
const fixtureWindow = (): WindowState => windowState();
type Flows = WindowState["sessionFlows"];
type Control = WindowState["sessionRuntime"]["control"];

export const harness = {
  closeSession, presentRestoreOutcome, handOverSession, handleChatEvent, restoreTabs,
  // The session flows live in the window's sessionFlows handle (wiring/session-flows.ts); these adapters keep the cases' argument shapes.
  openTab: (...args: Parameters<Flows["openTab"]>) => fixtureWindow().sessionFlows.openTab(...args),
  switchSessionMode: (...args: Parameters<Flows["switchSessionMode"]>) => fixtureWindow().sessionFlows.switchSessionMode(...args),
  restartChat: (...args: Parameters<Flows["restartChat"]>) => fixtureWindow().sessionFlows.restartChat(...args),
  openSessionInMode: (...args: Parameters<Flows["openSessionInMode"]>) => fixtureWindow().sessionFlows.openSessionInMode(...args),
  // The process services live in the runtime (cut 5); these adapters keep the cases' argument shapes.
  connectHostControl: (context: vscode.ExtensionContext, _index: unknown, ...args: Parameters<Control["connect"]>) => { fixtureWindow().context = context; return fixtureWindow().sessionRuntime.control.connect(...args); },
  reconnectHostControl: (context: vscode.ExtensionContext, _index: unknown, ...args: Parameters<Control["reconnect"]>) => { fixtureWindow().context = context; return fixtureWindow().sessionRuntime.control.reconnect(...args); },
  establishControl: (context: vscode.ExtensionContext, _index: unknown, ...args: Parameters<Control["establish"]>) => { fixtureWindow().context = context; return fixtureWindow().sessionRuntime.control.establish(...args); },
  startNativeWatch: (_index: unknown, state: TabState, native: Parameters<WindowState["sessionRuntime"]["nativeWatch"]["start"]>[1]) => fixtureWindow().sessionRuntime.nativeWatch.start(recordFor(state), native),
  handleNativeHostExited: (_index: unknown, state: TabState, native: Parameters<WindowState["sessionRuntime"]["exit"]["nativeExited"]>[1]) => fixtureWindow().sessionRuntime.exit.nativeExited(recordFor(state), native),
  bindConversationIdentity: (_index: unknown, ...args: Parameters<WindowState["sessionRuntime"]["identity"]["bind"]>) => fixtureWindow().sessionRuntime.identity.bind(...args),
  retryPendingIdentity: (_index: unknown, tabId: string) => fixtureWindow().sessionRuntime.identity.retry(tabId),
  /** The runtime's record of the conversation an editor shows: its process, control channel, fence and failure. */
  record: recordFor,
  handleRestoreOutcome, renameSession, reloadSession, handleGuestControlRequest, panelResponder,
  defaultSessionMode, chooseDefaultSessionView, newSession, startNewSession,
  resumeWorkspaceFolder, newSessionInPlace, deleteSessionInPlace,
  panelFactory(handler: EditorPanelsDeps<TabState>["createWebviewPanel"]) {
    const w = fixtureWindow(), previous = w.editorPanels;
    w.editorPanels = registerEditorPanels({ ...editorPanelsDeps(), createWebviewPanel: handler });
    return () => { w.editorPanels = previous; };
  },
  // The helper scheduler of a window the fixture installs has no restore to wait for and no cross-window slots: see `installWindowForTest`.
  installWindow: installWindowForTest,
  window: (): WindowState => windowState(),
  holdStartupRestore() {
    const w = mutableWindow(), over = Promise.withResolvers<void>();
    let pending = true;
    w.catalogAdoption = { ...w.catalogAdoption, startupRestoreOver: () => pending ? over.promise : null };
    return { end() { pending = false; over.resolve(); } };
  },
  createWindowState,
  localLauncher: (context: vscode.ExtensionContext, index: SessionIndex) => localLauncher(context, index, fixtureChat), handleTerminalGuestMessage,
  startConversation: (index: SessionIndex, ...args: Parameters<LocalLauncher["startConversation"]>) => localLauncher(fixtureWindow().context as vscode.ExtensionContext, index, fixtureChat).startConversation(...args),
  pushSessionView, handleShellEditorClosed,
  SessionTreeProvider,
  terminalFontMessage, revealDesktopNotification, revealActiveSession, releaseSelectionFromOtherWindow, refreshLauncher, launcherFacts, notifierFor, forgetTurnActivity,
  copyActiveTerminalScreen, activateNativeEditor, postPanelAction,
  handleBridgeRequest,
  subscribeProviderLoginRefresh, refreshDefaultProviderModels, refreshSessionModels, recordSessionModels, runChatAction, openProviderLogin, loginProviderFromPalette, signInProvider, logoutProviderFromPalette,
  providerLoginFixture, providerAuthFixture,
  storedRenameFixture,
  providerModelsIdle: () => fixtureWindow().defaultProviderModelsRead ?? Promise.resolve(),
  closeLoginTerminal: (name: string) => fixtureVscode.window.closedTerminals.fire(name === "omp login" && fixtureWindow().providerLoginTerminal !== null ? fixtureWindow().providerLoginTerminal : { name }),
  closeOtherTerminal: (name: string) => fixtureVscode.window.closedTerminals.fire({ name }),
  profilePicker(handler: Hook) {
    const previous = fixtureVscode.window.showQuickPick;
    fixtureVscode.window.showQuickPick = handler;
    return () => { fixtureVscode.window.showQuickPick = previous; };
  },
  inputBox(handler: Hook) {
    const previous = fixtureVscode.window.showInputBox;
    fixtureVscode.window.showInputBox = handler;
    return () => { fixtureVscode.window.showInputBox = previous; };
  },
  sessionModelAvailability: (tabId: string) => fixtureWindow().footerBindings.get(tabId)?.message.hasAvailableModels,
  handlePassiveSlotMessage, passiveReasonForSlot,
  footerIdle: () => Promise.all([...fixtureWindow().footerBindings.values()].map(binding => binding.observer?.idle())).then(() => undefined),
  restoredDraft: (slot: string) => fixtureWindow().draftRestores.get(slot)?.reply ?? null,
  readChatDisplayPreferences, refreshChatDisplayPreferences,
  configurationWrites: () => fixtureVscode.workspace.configurationWrites,
  openedDocuments: () => fixtureVscode.window.openedDocuments,
  quickPicks: () => fixtureVscode.window.quickPicks,
  shellContext(cwd: string, panel: vscode.WebviewPanel) {
    const slot = createShellSlotId(), state = newTabState(slot);
    state.shellSlot = slot; state.panel = panel; fixtureWindow().tabs.set(slot, state);
    fixtureWindow().shellSlots = { get: (key: string) => key === slot ? { cwd } : null } as never;
    return { slot, state };
  },
  async shellFixture(cwd: string, panel: vscode.WebviewPanel, liveness: string) {
    const slot = createShellSlotId(), state = newTabState(slot), values = new Map<string, unknown>(), w = fixtureWindow();
    state.shellSlot = slot; state.panel = panel; w.tabs.set(slot, state);
    w.shellSlots = createShellSlotStore({ get: (key: string) => values.get(key), update: async (key: string, value: unknown) => { values.set(key, value); } } as never);
    await w.shellSlots.add({ slot, cwd, folderKey: cwd, label: "Project terminal" } as never);
    w.ptyGate!.client = (async () => ({ attach: async () => ({ handle: liveness === "unreachable" ? null : { refreshStatus: async () => ({ state: liveness }) } }) })) as never;
    return { slot, state, record: () => w.shellSlots!.get(slot), remove: () => w.shellSlots!.remove(slot) };
  },
  hostGeneration: () => fixtureWindow().bridgeHost.hostGeneration,
  clipboardWrites: () => fixtureVscode.env.clipboard.writes,
  quotePreviewSelection: (index: SessionIndex) => quoteEditorSelectionToSession(fixtureContext, index),
  setActiveTab: (tab: unknown) => { fixtureVscode.window.tabGroups.activeTabGroup.activeTab = tab; },
  customTabInput: (viewType: string, fsPath: string) => { const input = new fixtureVscode.TabInputCustom(); input.viewType = viewType; input.uri = { scheme: "file", fsPath }; return input; },
  webviewTabInput: (viewType: string) => { const input = new fixtureVscode.TabInputWebview(); input.viewType = viewType; return input; },
  clipboardText: (value?: string) => { if (value !== undefined) fixtureVscode.env.clipboard.text = value; return fixtureVscode.env.clipboard.text; },
  lastQuickPick: () => fixtureVscode.window.quickPicks.at(-1),
  quickPickCount: () => fixtureVscode.window.quickPicks.length,
  infos: () => fixtureVscode.window.infos,
  desktopPayload: desktopFixture.capturedDesktopXml,
  desktopPayloads: desktopFixture.capturedDesktopXmls,
  focusSession(active: boolean, editorId = EDITOR, tabId = TAB) {
    const input = active ? new fixtureVscode.TabInputWebview() : new fixtureVscode.TabInputText();
    if (active) input.viewType = bridgeViewType(tabId, editorId);
    fixtureVscode.window.tabGroups.activeTabGroup.activeTab = { input };
  },
  desktopEnvironment(context: vscode.ExtensionContext) {
    const previousContext = fixtureWindow().context;
    fixtureWindow().context = context;
    fixtureVscode.env.uriScheme = "vscode";
    fixtureVscode.env.asExternalUri = (async (uri: vscode.Uri) => uri.with({ query: uri.query + "&windowId=9471" })) as Hook;
    return () => {
      fixtureWindow().context = previousContext;
      delete fixtureVscode.env.uriScheme;
      delete fixtureVscode.env.asExternalUri;
    };
  },
  configuration(values: Record<string, unknown>) { fixtureVscode.workspace.configurationValues = values; },
  editorLifecycle() {
    const w = fixtureWindow(), previous = w.editorPanels;
    w.editorPanels = registerEditorPanels(editorPanelsDeps());
    // Bridge bootstrap is covered by real sockets separately; these cases drive editor identity, disposal and runtime
    // delivery through the ordinary panel route. The window's own bridge host (and so its host generation) stays
    // installed and runs its real endpoint creation; only the listener is faked, and it never binds. The factory is not
    // put back on restore: a provisioning still in flight when a case ends resolves it late, and a real listener bound
    // then would outlive the window and keep the process alive. A reset gives the next case a window with the real one.
    w.createBridgeEndpoint = (() => ({ bind: async () => null, failure: "fixture listener", close() {} })) as never;
    return () => { w.editorPanels = previous; };
  },
  createPanel: () => fixtureVscode.window.createWebviewPanel(),
  warning(handler: Hook) { fixtureVscode.window.showWarningMessage = handler; },
  information(handler: Hook) { fixtureVscode.window.showInformationMessage = handler; },
  picker(mode: string | undefined) { fixtureVscode.window.showQuickPick = async (rows: { mode?: string }[]) => rows.find(row => row.mode === mode); },
  folders(folders: { id: string; path: string }[], openingWindows: unknown = [], pickerOrder = folders) {
    fixtureWindow().launcherFolders = {
      list: () => folders, listForPicker: () => pickerOrder, get: (id: string) => folders.find(folder => folder.id === id) ?? null, folderForCwd: (cwd: string) => folders.find(folder => folder.path === cwd) ?? null,
      windowsWithFolder: (folderPath: string, options: unknown) => typeof openingWindows === "function" ? openingWindows(folderPath, options) : openingWindows,
      identityKeyOf: (value: unknown) => value,
    } as never;
  },
  errors() { return fixtureVscode.window.errors; },
  errorActions() { return fixtureVscode.window.errorActions; },
  chooseOnError(choice: unknown) { fixtureVscode.window.errorChoice = choice; },
  rowState: fixtureRowState,
  policy(context: vscode.ExtensionContext, ports: Parameters<typeof createOwnerReconciler>[0], hostLauncher: OmpHostLauncher, stopPort: unknown) {
    const w = fixtureWindow();
    w.context = context;
    w.reconciler = createOwnerReconciler(ports);
    const runtimeDeps = sessionRuntimeDeps(w.indexForBridge as SessionIndex, fixtureChat, () => hostLauncher, w.sessionRuntime.records);
    // The broker facts of the fixture's rows come in through the runtime's deps, not by reassigning a function of the module.
    w.sessionRuntime = new LocalSessionRuntime({
      ...runtimeDeps,
      launcher: () => hostLauncher as never,
      brokerProvenance: () => ({ kind: "slot", slot: "host:legacy-fixture" }),
      recorded: new LocalRecordedStop({
        index: w.indexForBridge as SessionIndex, writer: runtimeDeps.writer, control: runtimeDeps.control, brokerSlots: () => fixtureWindow().brokerSlots,
        window: { forgetOutcome: (conversation: string) => { fixtureWindow().outcomes.delete(conversation); } },
        stopPort: () => stopPort as never,
      }),
    });
    w.editorPanels = { ...w.editorPanels, openPanel: () => undefined };
    w.sessionActions = registerSessionActions(sessionActionsDeps());
    const dialogs: { message: unknown; detail: unknown; action: unknown }[] = [];
    fixtureVscode.window.showWarningMessage = async (message: unknown, options: { detail?: string } | undefined, action: unknown) => { dialogs.push({ message, detail: options?.detail, action }); return action; };
    fixtureVscode.window.showInputBox = async () => "Recovered draft title";
    return dialogs;
  },
  attachChatRoute, state: tabState,
  reviveEditorPanel, openSession, requestSessionRowExpand, viewTypeOf: bridgeViewType,
  tabStrip(columns: string[][], activeColumn = 0) {
    // One group per column; each entry is the view type of one webview editor tab.
    const groups = columns.map((viewTypes, at) => {
      const group: FakeGroup = { viewColumn: at + 1, tabs: [], activeTab: null };
      group.tabs = viewTypes.map(viewType => { const input = new fixtureVscode.TabInputWebview(); input.viewType = viewType; return { input, group, isActive: false }; });
      return group;
    });
    fixtureVscode.window.tabGroups.all = groups;
    fixtureVscode.window.tabGroups.activeTabGroup = groups[activeColumn] ?? { activeTab: null, viewColumn: 1, tabs: [] };
    return groups;
  },
  commandHandler(handler: Hook | null) { fixtureVscode.commands.calls.length = 0; fixtureVscode.commands.handler = handler; return fixtureVscode.commands.calls; },
  tabsChanged() { fixtureVscode.window.tabGroups.changes.fire(); },
  bindRevived(slot: string, panel: vscode.WebviewPanel) { const w = fixtureWindow(); w.tabs.get(slot)!.panel = panel; for (const resolve of w.panelBindWaiters.get(slot) ?? []) resolve(); },
  markPageRunning(slot: string) { fixtureWindow().bridgeLiveEditors.add(slot); },
  controlClient: HostControlClient,
  SessionIndex, acquireClaim: claimModule.acquireClaim, createClaimHolder: claimModule.createClaimHolder, launcherOwnershipFacts, refreshRowsForClaims, startClaimWatch,
  setClaimFailures: claimFixture.setClaimFailures,
  reset(index: SessionIndex, conversation: ChatRuntime) {
    installWindowForTest(createWindowState(fixtureContext));
    const w = mutableWindow();
    fixtureChat = conversation;
    w.indexForBridge = index; w.sessionRuntime = createSessionRuntime(index, conversation);
    // The fixture's window has no startup restore to wait for: the pass is over and covers no row.
    w.catalogAdoption = { ...w.catalogAdoption, startupRestoreSettled: () => true, startupRestoreOver: () => null, startupRestore: () => null, restoreCovers: () => false, startupCovers: () => false };
    w.detailTabs = new DetailTabs({ createPanel() { throw new Error("the fixture opens no detail tab"); }, attachPage: () => () => {}, handleMessage: async () => ({ status: "refused" }), openUrl: async () => {}, openMermaid() {}, log() {} } as never);
    fixtureVscode.window.errors.length = 0;
    fixtureVscode.env.clipboard.writes.length = 0;
    fixtureVscode.workspace.configurationValues = {};
    delete fixtureVscode.env.uriScheme;
    delete fixtureVscode.env.asExternalUri;
    desktopFixture.resetDesktopXmls();
    fixtureVscode.window.tabGroups.activeTabGroup.activeTab = null;
    w.reconciler = { reconcile: async () => ({ kind: "free", evidence: [] }) } as never;
    w.staging = { entries: async () => ({ hostControl: { path: "fixture-host-control.mjs" }, renameHelper: { path: "fixture-rename-session.mjs" }, runtimeProbe: { path: "fixture-runtime-probe.mjs" } }), native: async () => null } as never;
    w.ptyGate = {
      client: async () => ({}),
      attachClient: async () => ({ fixture: true }),
      chatLaunchClient: async () => await w.ptyGate!.client(),
      invalidate: () => {},
    } as never;
    // The fixture's runtimes carry process ids no real process has: a root is running unless a case says it ended.
    w.rootGone = async () => false;
  },
  editor(index: unknown, endpoint: unknown, panel: unknown, editorId = EDITOR, tabId = TAB) {
    const state = newTabState(editorId); state.tabId = tabId; state.panel = panel as vscode.WebviewPanel;
    state.bridge = { editorId, endpoint, documentId: DOCUMENT, bound: true } as never;
    state.document = { kind: "guest", bridgeDocumentId: DOCUMENT } as never;
    const w = fixtureWindow();
    w.tabs.set(editorId, state);
    w.bridgeEditors.reserve({ tabId, editorId, provenance: "saved", sequence: 1 });
    w.bridgeEndpoints.set(editorId, endpoint as never);
    return state;
  },
};
// A window is installed from the start, so a case that reaches an internal before its first reset still has one.
installWindowForTest(createWindowState(fixtureContext));
