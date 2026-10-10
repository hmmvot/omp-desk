/** Native replacement and control credential lifecycle through the extension's real actions.
 * Bundled with the existing esbuild test convention; VS Code and native transports are
 * stand-ins, while lifecycle gates, document records and bridge sockets are real.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setImmediate as nextTurn } from "node:timers/promises";
import { after, before, describe, it } from "node:test";
import { build } from "esbuild";
import { TabLifecycle } from "./host/tab-lifecycle.ts";
import { BridgeEditorEndpoint } from "./host/bridge-endpoint.ts";
import type { BridgeBootstrapDelivery } from "./host/bridge-endpoint.ts";
import { BridgeRecords, bindingMatches } from "./host/bridge-records.ts";
import { BridgeClient } from "./webview/lib/bridge-client.ts";
import type { BridgeNativeBinding } from "./host/bridge-records.ts";
import type { SessionIndex } from "./host/session-index.ts";
import type { acquireClaim, createClaimHolder, SessionClaim } from "./host/session-claim.ts";
import type { startClaimWatch } from "./host/claim-watch.ts";
import type { SessionLauncherFacts, SessionOwnershipFacts } from "./views/session-tree.ts";
import { ChatRuntime, type ChatPage } from "./host/chat-runtime.ts";
import { ChatClient } from "./webview/lib/chat-client.ts";
import { FakeRpcChannel } from "./host/rpc/fake-channel.ts";
import { RpcSession } from "./host/rpc/session.ts";
import { ManualTimers, assistantMessage, messageEntry, sessionFileText, userMessage } from "./host/rpc/test-support.ts";
import { GUEST_PROTOCOL_VERSION, parseGuestHostMessage } from "./webview/messages.ts";
import type { GuestTerminalFontMessage } from "./webview/messages.ts";
import { URI } from "vscode-uri";
import type { TurnNotice } from "./host/notifications.ts";
import { createOmpHostControlAdapter, type OmpExtensionContext } from "./omp/host-control.ts";
import { parseChatWebviewMessage, type ChatDisplayPreferences, type ChatWebviewMessage } from "./webview/chat-messages.ts";

interface NativeFixture {
  readonly pid: number;
  readonly sessionFile: string;
  readonly identity: {
    readonly slot: string;
    readonly brokerId: string;
    readonly brokerGeneration: string;
    readonly childCreationTime: string;
  };
}

const TAB = "tab:11111111-2222-4333-8444-555555555555";
const EDITOR = "b".repeat(32);
const DOCUMENT = "c".repeat(32);
const ORIGIN = "vscode-webview://0r42vg5knjjkub1td6sq2sg4ggjt4ovjpvcnij5lj62f9k001mi3";
const OWNER = "owner-test";
const KEY = `omp.hostControl.key.${OWNER}`;
const RECIPIENT = `omp.hostControl.recipient.${OWNER}`;
const RECORD = `omp.hostControl.process.${OWNER}`;

const VSCODE = `
import { URI } from 'vscode-uri';
export class ThemeIcon { constructor(id) { this.id = id; } }
export const QuickPickItemKind = { Separator: -1 };
export class ThemeColor { constructor(id) { this.id = id; } }
export class TreeItem { constructor(label) { this.label = label; } }
export class EventEmitter {
  listeners = new Set();
  event = listener => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
  fire(value) { for (const listener of this.listeners) listener(value); }
  dispose() { this.listeners.clear(); }
}
export class MarkdownString { constructor(value = '') { this.value = value; } appendMarkdown(value) { this.value += value; return this; } }
export class TabInputWebview {}
export class TabInputText {}
export class TabInputTextDiff {}
export class Range {
  constructor(startLine, startCharacter, endLine, endCharacter) {
    this.start = { line: startLine, character: startCharacter };
    this.end = { line: endLine, character: endCharacter };
  }
}
export const ConfigurationTarget = { Global: 1 };
export const workspace = {
  configurationValues: {},
  configurationWrites: [],
  getConfiguration(section) { return {
    get(key, fallback) { return workspace.configurationValues[section + '.' + key] ?? fallback; },
    async update(key, value, target) {
      workspace.configurationValues[section + '.' + key] = value;
      workspace.configurationWrites.push({ key: section + '.' + key, value, target });
    }
  }; },
};
export const env = { clipboard: { writes: [], writeText: async text => { env.clipboard.writes.push(text); } } };
export const version = 'test';
export const StatusBarAlignment = { Left: 1, Right: 2 };
export const FileType = { Directory: 2 };
export const ProgressLocation = { Notification: 15 };
export const ViewColumn = { Active: -1 };
export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };
export const Uri = { from: URI.from, parse: URI.parse, file: fsPath => ({ fsPath, toString: () => fsPath }), joinPath: (root, ...parts) => Uri.file([root.fsPath, ...parts].join('/')) };
export const window = { state: { focused: true }, errors: [], tabGroups: { all: [], activeTabGroup: { activeTab: null, viewColumn: 1 } },
  openedDocuments: [],
  closedTerminals: new EventEmitter(),
  onDidCloseTerminal(listener) { return window.closedTerminals.event(listener); },
  async showTextDocument(uri, options) { window.openedDocuments.push({ uri, options }); },
  showWarningMessage: async (_message, _options, action) => action,
  showInformationMessage: async () => undefined, showErrorMessage: async message => { window.errors.push(message); }, setStatusBarMessage() {},
  registerWebviewPanelSerializer() { return { dispose() {} }; },
  quickPicks: [],
  createQuickPick() {
    let accept, hide;
    const picker = { title: '', items: [], activeItems: [], selectedItems: [], disposed: false,
      onDidAccept(listener) { accept = listener; return { dispose() { accept = undefined; } }; },
      onDidHide(listener) { hide = listener; return { dispose() { hide = undefined; } }; },
      show() {}, dispose() { picker.disposed = true; },
      choose(index) { picker.selectedItems = [picker.items[index]]; accept?.(); },
      dismiss() { hide?.(); } };
    window.quickPicks.push(picker);
    return picker;
  },
  createWebviewPanel(viewType = 'omp.session', title = 'Fixture session') {
    const received = new Set(), disposed = new Set();
    const panel = { viewType, title, active: true, visible: true, messages: [], onMessage: null,
      reveal() {}, onDidChangeViewState() { return { dispose() {} }; },
      onDidDispose(listener) { disposed.add(listener); return { dispose() { disposed.delete(listener); } }; },
      dispose() { panel.visible = false; for (const listener of disposed) listener(); },
      receive(message) { for (const listener of received) listener(message); },
      webview: { html: '', cspSource: 'vscode-webview://fixture', asWebviewUri: uri => uri,
        onDidReceiveMessage(listener) { received.add(listener); return { dispose() { received.delete(listener); } }; },
        async postMessage(message) { panel.messages.push(message); panel.onMessage?.(message); return true; } } };
    return panel;
  } };
export const commands = { calls: [], handler: null, async executeCommand(...args) {
  // Terminal file links open through the workbench's default editor resolution.
  if (args[0] === 'vscode.open') { window.openedDocuments.push({ uri: args[1], options: args[2] }); return undefined; }
  commands.calls.push(args); return commands.handler?.(...args);
} };
`;

// Export private entrypoints only in the test bundle, never in the shipped extension.
const ACCESS = `
import { sessionItemState as fixtureRowState } from './views/session-tree';
import * as fixtureVscode from 'vscode';
import { acquireClaim as fixtureClaim, createClaimHolder as fixtureHolder, setClaimFailures } from './host/session-claim';
import { capturedDesktopXml, capturedDesktopXmls, resetDesktopXmls } from './host/desktop-notifications';
import { providerLoginFixture } from './host/native-terminal';
const fixtureOpenPanel = openPanel;
export const harness = {
  connectHostControl, reconnectHostControl, establishControl, closeSession, launchHost, presentRestoreOutcome, openTab, handleChatEvent, bindPanel, restoreTabs, bridgeSerializerFor,
  confirmAndDeleteSession, deleteSession, handleRestoreOutcome, forgetSession, renameSession, reloadSession, handleGuestControlRequest, panelResponder,
  switchSessionMode, restartChat, openSessionInMode, defaultSessionMode, chooseDefaultSessionView, newSession, owningWindowUri, switchToSessionWindow,
  startConversation, handleTerminalGuestMessage, startNativeWatch, handleNativeHostExited, hostControlAttempts,
  pushSessionView, handleShellEditorClosed,
  bindConversationIdentity, retryPendingIdentity, SessionTreeProvider,
  terminalFontMessage, revealDesktopNotification, revealActiveSession, refreshLauncher, launcherFacts, notifierFor, forgetTurnActivity,
  copyActiveTerminalScreen, handleGuestMessage, activateNativeEditor, postPanelAction,
  handleBridgeRequest, bridgeDocumentEligible,
  runChatCommand,
  subscribeProviderLoginRefresh, refreshDefaultProviderModels, refreshSessionModels, recordSessionModels, runChatAction, openProviderLogin, loginProviderFromPalette,
  providerLoginFixture,
  providerModelsIdle: () => defaultProviderModelsRead ?? Promise.resolve(),
  closeLoginTerminal: name => fixtureVscode.window.closedTerminals.fire(name === "omp login" && providerLoginTerminal !== null ? providerLoginTerminal : { name }),
  closeOtherTerminal: name => fixtureVscode.window.closedTerminals.fire({ name }),
  profilePicker(handler) {
    const previous = fixtureVscode.window.showQuickPick;
    fixtureVscode.window.showQuickPick = handler;
    return () => { fixtureVscode.window.showQuickPick = previous; };
  },
  sessionModelAvailability: tabId => footerBindings.get(tabId)?.message.hasAvailableModels,
  handlePassiveSlotMessage, passiveReasonForSlot,
  footerIdle: () => Promise.all([...footerBindings.values()].map(binding => binding.observer?.idle())).then(() => undefined),
  restoredDraft: slot => draftRestores.get(slot)?.reply ?? null,
  readChatDisplayPreferences, writeChatToolDetail, refreshChatDisplayPreferences,
  configurationWrites: () => fixtureVscode.workspace.configurationWrites,
  setWindowWorkspace(file, folders) { fixtureVscode.workspace.workspaceFile = file; fixtureVscode.workspace.workspaceFolders = folders; },
  openedDocuments: () => fixtureVscode.window.openedDocuments,
  quickPicks: () => fixtureVscode.window.quickPicks,
  pickToolCallDetail,
  shellContext(cwd, panel) {
    const slot = createShellSlotId(), state = newTabState(slot);
    state.shellSlot = slot; state.panel = panel; tabs.set(slot, state);
    shellSlots = { get: key => key === slot ? { cwd } : null };
    return { slot, state };
  },
  async shellFixture(cwd, panel, liveness) {
    const slot = createShellSlotId(), state = newTabState(slot), values = new Map();
    state.shellSlot = slot; state.panel = panel; tabs.set(slot, state);
    shellSlots = createShellSlotStore({ get: key => values.get(key), update: async (key, value) => { values.set(key, value); } });
    await shellSlots.add({ slot, cwd, folderKey: cwd, label: 'Project terminal' });
    ptyGate.client = async () => ({ attach: async () => ({ handle: liveness === 'unreachable' ? null : { refreshStatus: async () => ({ state: liveness }) } }) });
    return { slot, state, record: () => shellSlots.get(slot), remove: () => shellSlots.remove(slot) };
  },
  hostGeneration: () => bridgeHostGeneration,
  clipboardWrites: () => fixtureVscode.env.clipboard.writes,
  desktopPayload: capturedDesktopXml,
  desktopPayloads: capturedDesktopXmls,
  focusSession(active, editorId = '${EDITOR}', tabId = '${TAB}') {
    const input = active ? new fixtureVscode.TabInputWebview() : new fixtureVscode.TabInputText();
    if (active) input.viewType = bridgeViewType(tabId, editorId);
    fixtureVscode.window.tabGroups.activeTabGroup.activeTab = { input };
  },
  desktopEnvironment(context) {
    const previousContext = activationContext;
    activationContext = context;
    fixtureVscode.env.uriScheme = 'vscode';
    fixtureVscode.env.asExternalUri = async uri => uri.with({ query: uri.query + '&windowId=9471' });
    return () => {
      activationContext = previousContext;
      delete fixtureVscode.env.uriScheme;
      delete fixtureVscode.env.asExternalUri;
    };
  },
  configuration(values) { fixtureVscode.workspace.configurationValues = values; },
  editorLifecycle() {
    const previous = openPanel, previousBridge = ensureBridgeEndpoint;
    openPanel = fixtureOpenPanel;
    // Bridge bootstrap is covered by real sockets separately; these cases drive editor
    // identity, disposal and runtime delivery through the ordinary panel route.
    ensureBridgeEndpoint = async () => null;
    return () => { openPanel = previous; ensureBridgeEndpoint = previousBridge; };
  },
  createPanel: () => fixtureVscode.window.createWebviewPanel(),
  notificationTree(provider, view) { launcherProvider = provider; launcherView = view; launcherSelectedPath = null; launcherExpandFor = null; },
  warning(handler) { fixtureVscode.window.showWarningMessage = handler; },
  information(handler) { fixtureVscode.window.showInformationMessage = handler; },
  picker(mode) { fixtureVscode.window.showQuickPick = async rows => rows.find(row => row.mode === mode); },
  folders(folders) { launcherFolders = { list: () => folders, get: id => folders.find(folder => folder.id === id) ?? null, folderForCwd: cwd => folders.find(folder => folder.path === cwd) ?? null }; },
  errors() { return fixtureVscode.window.errors; },
  rowState: fixtureRowState,
  policy(context, ports, hostLauncher, stopPort) {
    activationContext = context;
    reconciler = createOwnerReconciler(ports);
    launcher = () => hostLauncher;
    openPanel = () => undefined;
    brokerProvenanceFor = () => ({ kind: 'slot', slot: 'host:legacy-fixture' });
    recordedHostStopPort = () => stopPort;
    const dialogs = [];
    fixtureVscode.window.showWarningMessage = async (message, options, action) => { dialogs.push({ message, detail: options?.detail, action }); return action; };
    fixtureVscode.window.showInputBox = async () => "Recovered draft title";
    return dialogs;
  },
  commitBridgeDocument, refreshBridgeReadiness, attachChatRoute, state: tabState,
  reviveEditorPanel, openSession, openPanel: fixtureOpenPanel, requestSessionRowExpand, viewTypeOf: bridgeViewType,
  tabStrip(columns, activeColumn = 0) {
    // One group per column; each entry is the view type of one webview editor tab.
    const groups = columns.map((viewTypes, at) => {
      const group = { viewColumn: at + 1, tabs: [], activeTab: null };
      group.tabs = viewTypes.map(viewType => { const input = new fixtureVscode.TabInputWebview(); input.viewType = viewType; return { input, group, isActive: false }; });
      return group;
    });
    fixtureVscode.window.tabGroups.all = groups;
    fixtureVscode.window.tabGroups.activeTabGroup = groups[activeColumn] ?? { activeTab: null, viewColumn: 1, tabs: [] };
    return groups;
  },
  commandHandler(handler) { fixtureVscode.commands.calls.length = 0; fixtureVscode.commands.handler = handler; return fixtureVscode.commands.calls; },
  bindRevived(slot, panel) { tabs.get(slot).panel = panel; for (const resolve of panelBindWaiters.get(slot) ?? []) resolve(); },
  markPageRunning(slot) { bridgeLiveEditors.add(slot); },
  controlClient: HostControlClient,
  SessionIndex, acquireClaim: fixtureClaim, createClaimHolder: fixtureHolder, launcherOwnershipFacts, refreshRowsForClaims, startClaimWatch,
  setExternalLeases(observer) { externalLeases = observer; },
  setClaimFailures,
  reset(index, conversation) {
    tabs.clear(); chat = conversation; indexForBridge = index; startupRestorePending = false;
    detailTabs = new DetailTabs({ createPanel() { throw new Error('the fixture opens no detail tab'); }, attachPage: () => () => {}, handleMessage: async () => ({ status: 'refused' }), openUrl: async () => {}, log() {} });
    fixtureVscode.window.errors.length = 0;
    fixtureVscode.env.clipboard.writes.length = 0;
    fixtureVscode.workspace.configurationValues = {};
    delete fixtureVscode.env.uriScheme;
    delete fixtureVscode.env.asExternalUri;
    resetDesktopXmls();
    fixtureVscode.window.tabGroups.activeTabGroup.activeTab = null;
    reconciler = { reconcile: async () => ({ kind: 'free', evidence: [] }) };
    runtimeEntries = async () => ({ hostControl: { path: 'fixture-host-control.mjs' } });
    ptyGate = { client: async () => ({}) };
    ptyGate.attachClient = async () => ({ fixture: true });
    ptyGate.invalidate = () => {};
  },
  editor(index, endpoint, panel, editorId = '${EDITOR}', tabId = '${TAB}') {
    const state = newTabState(editorId); state.tabId = tabId; state.panel = panel;
    state.bridge = { editorId, endpoint, documentId: '${DOCUMENT}', bound: true };
    state.document = { kind: 'guest', bridgeDocumentId: '${DOCUMENT}' };
    tabs.set(editorId, state);
    bridgeEditors.reserve({ tabId, editorId, provenance: 'saved', sequence: 1 });
    bridgeEndpoints.set(editorId, endpoint);
    return state;
  }
};`;

interface State {
  mode: "chat" | "terminal";
  transitioning: boolean;
  tabId: string | null;
  slotId: string;
  runtime: unknown;
  pipeline: { dispose(): void; readonly generation?: string } | null;
  nativeWatch: (() => void) | null;
  control: { client: unknown; snapshot: unknown; activity?: boolean; work?: boolean } | null;
  controlFailure: string | null;
  bridge: { documentId: string; bound: boolean } | null;
  panel?: unknown;
  document?: unknown;
}
interface ProviderModelIndexFixture {
  get(): { tabId: string; cwd: string; scope: { profile: string | null } };
  list(): { tabId: string }[];
}

interface Harness {
  reset(index: unknown, chat: unknown): void;
  state(tabId: string): State;
  editor(index: unknown, endpoint: unknown, panel: unknown, editorId?: string, tabId?: string): State;
  bridgeDocumentEligible(editorId: string, documentId: string): boolean;
  connectHostControl(...args: unknown[]): Promise<void>;
  reconnectHostControl(...args: unknown[]): Promise<void>;
  startNativeWatch(...args: unknown[]): void;
  handleNativeHostExited(...args: unknown[]): Promise<void>;
  establishControl(...args: unknown[]): Promise<void>;
  closeSession(...args: unknown[]): Promise<void>;
  launchHost(...args: unknown[]): Promise<{ state: string }>;
  presentRestoreOutcome(index: SessionIndex, tabId: string, outcome: unknown): void;
  openTab(...args: unknown[]): Promise<void>;
  hostControlAttempts: WeakMap<object, Promise<void>>;
  restoredDraft(slot: string): { requestId: number; text: string; attachments: number; recoverable: readonly { text: string; attachments: number; unconfirmed: boolean }[] } | null;
  switchSessionMode(...args: unknown[]): Promise<void>;
  restartChat(...args: unknown[]): Promise<void>;
  runChatCommand(...args: unknown[]): Promise<"accepted" | "refused" | "unconfirmed" | "ignored">;
  subscribeProviderLoginRefresh(context: { subscriptions: { dispose(): void }[] }, index: SessionIndex | ProviderModelIndexFixture): void;
  refreshDefaultProviderModels(): Promise<void>;
  refreshSessionModels(index: SessionIndex | ProviderModelIndexFixture, tabId: string): Promise<void>;
  recordSessionModels(index: SessionIndex | ProviderModelIndexFixture, tabId: string, available: boolean): void;
  runChatAction(...args: unknown[]): Promise<void>;
  openProviderLogin(...args: unknown[]): Promise<void>;
  loginProviderFromPalette(...args: unknown[]): Promise<void>;
  profilePicker(handler: (profiles: readonly string[]) => Promise<string | undefined>): () => void;
  providerModelsIdle(): Promise<void>;
  closeLoginTerminal(name: string): void;
  closeOtherTerminal(name: string): void;
  sessionModelAvailability(tabId: string): boolean | undefined;
  providerLoginFixture: { enabled: boolean; unresolved: boolean; models: unknown[]; calls: { args: string[]; options: { env: Record<string, string> } }[]; logins: { env: Record<string, string>; cwd: string }[]; read: (() => Promise<{ stdout: string; stderr: string; exitCode: number }>) | null; resolve: (() => Promise<{ command: string; prefixArgs: string[]; version: string }>) | null };
  owningWindowUri(): URI | null;
  switchToSessionWindow(...args: unknown[]): Promise<void>;
  setWindowWorkspace(file: URI | undefined, folders: readonly { uri: URI }[]): void;
  bindPanel(...args: unknown[]): void;
  restoreTabs(...args: unknown[]): Promise<void>;
  bridgeSerializerFor(...args: unknown[]): { deserializeWebviewPanel(panel: unknown, state: unknown): Promise<void> };
  editorLifecycle(): () => void;
  createPanel(): LifecyclePanel;
  startConversation(...args: unknown[]): Promise<void>;
  handleTerminalGuestMessage(...args: unknown[]): Promise<void>;
  pushSessionView(index: unknown, state: State, force?: boolean): void;
  handleShellEditorClosed(...args: unknown[]): Promise<void>;
  shellFixture(cwd: string, panel: unknown, liveness: "running" | "exited" | "unreachable"): Promise<{ slot: string; state: State; record(): unknown; remove(): Promise<boolean> }>;
  copyActiveTerminalScreen(): void;
  handleGuestMessage(...args: unknown[]): Promise<void>;
  handleBridgeRequest(...args: unknown[]): void;
  handlePassiveSlotMessage(...args: unknown[]): Promise<void>;
  passiveReasonForSlot(slot: string): string | null;
  footerIdle(): Promise<void>;
  activateNativeEditor(state: State): void;
  hostGeneration(): Uint8Array;
  postPanelAction(action: "send-prompt" | "stop-turn" | "focus-composer"): void;
  clipboardWrites(): readonly string[];
  revealDesktopNotification(...args: unknown[]): Promise<void>;
  revealActiveSession(index: SessionIndex): Promise<void>;
  refreshLauncher(options?: { ownership?: boolean }): void;
  launcherFacts(tabId: string): SessionLauncherFacts;
  notifierFor(index: unknown): { notify(tabId: string, notice: TurnNotice): void };
  forgetTurnActivity(index: unknown, tabId: string): void;
  desktopEnvironment(context: unknown): () => void;
  desktopPayload(): string | undefined;
  desktopPayloads(): readonly string[];
  focusSession(active: boolean, editorId?: string, tabId?: string): void;
  terminalFontMessage(): GuestTerminalFontMessage;
  configuration(values: Record<string, unknown>): void;
  readChatDisplayPreferences(): ChatDisplayPreferences;
  writeChatToolDetail(value: ChatDisplayPreferences["toolCallDetail"]): Promise<void>;
  refreshChatDisplayPreferences(event: { affectsConfiguration(key: string): boolean }): void;
  configurationWrites(): readonly { key: string; value: unknown; target: number }[];
  openedDocuments(): readonly { uri: { fsPath: string }; options: { preview: boolean; selection: { start: { line: number; character: number }; end: { line: number; character: number } } } }[];
  quickPicks(): readonly { title: string; items: readonly { label: string; description?: string; detail?: string }[]; disposed: boolean; choose(index: number): void; dismiss(): void }[];
  pickToolCallDetail: NonNullable<ConstructorParameters<typeof ChatRuntime>[0]["pickToolCallDetail"]>;
  shellContext(cwd: string, panel: unknown): { slot: string; state: State };
  notificationTree(provider: unknown, view: unknown): void;
  openSessionInMode(...args: unknown[]): Promise<void>;
  defaultSessionMode(context: unknown): "chat" | "terminal";
  chooseDefaultSessionView(context: unknown): Promise<void>;
  newSession(...args: unknown[]): Promise<void>;
  warning(handler: (...args: unknown[]) => unknown): void;
  information(handler: (...args: unknown[]) => unknown): void;
  openSession(context: unknown, index: SessionIndex, argument: unknown, verb: "opened" | "resumed"): Promise<void>;
  picker(mode: "chat" | "terminal" | undefined): void;
  folders(folders: readonly { id: string; path: string; collapsed: boolean; pinned: boolean; open: boolean }[]): void;
  errors(): readonly string[];
  handleChatEvent(...args: unknown[]): void;
  confirmAndDeleteSession(...args: unknown[]): Promise<boolean>;
  deleteSession(...args: unknown[]): Promise<void>;
  handleRestoreOutcome(...args: unknown[]): Promise<void>;
  forgetSession(...args: unknown[]): Promise<void>;
  renameSession(...args: unknown[]): Promise<void>;
  reloadSession(...args: unknown[]): Promise<void>;
  handleGuestControlRequest(...args: unknown[]): Promise<void>;
  panelResponder(...args: unknown[]): unknown;
  rowState(entry: unknown, facts: unknown): string;
  policy(...args: unknown[]): { message: string; detail?: string; action: string }[];
  commitBridgeDocument(tabId: string): Promise<void>;
  reviveEditorPanel(index: unknown, tabId: string): Promise<{ selected: boolean; panel: unknown }>;
  openPanel(...args: unknown[]): void;
  requestSessionRowExpand(tabId: string): void;
  viewTypeOf(tabId: string, editorId: string): string;
  tabStrip(columns: readonly (readonly string[])[], activeColumn?: number): { viewColumn: number; tabs: { isActive: boolean; group: unknown }[] }[];
  commandHandler(handler: ((command: string, ...args: unknown[]) => void) | null): unknown[][];
  bindRevived(slot: string, panel: unknown): void;
  markPageRunning(slot: string): void;
  refreshBridgeReadiness(tabId: string): void;
  attachChatRoute(slot: string): void;
  SessionIndex: typeof SessionIndex;
  SessionTreeProvider: typeof import("./views/session-tree.ts").SessionTreeProvider;
  bindConversationIdentity(...args: unknown[]): Promise<void>;
  retryPendingIdentity(...args: unknown[]): Promise<void>;
  acquireClaim: typeof acquireClaim;
  createClaimHolder: typeof createClaimHolder;
  launcherOwnershipFacts(index: SessionIndex, tabId: string, options?: { fresh?: boolean }): Promise<SessionOwnershipFacts>;
  setExternalLeases(observer: { holds(file: string, options?: { fresh?: boolean }): Promise<boolean | null> } | null): void;
  refreshRowsForClaims(index: SessionIndex, claimFiles: ReadonlySet<string>): void;
  startClaimWatch: typeof startClaimWatch;
  setClaimFailures(codes: string[]): void;
  controlClient: {
    connectVerified: (input: { provenKey?: string; expectation: { sessionFile: string | null } }) => Promise<unknown>;
    connectWithProvenKey: (input: { provenKey: string; preferredPipeName?: string }) => Promise<unknown>;
  };
}
interface LifecyclePanel {
  readonly messages: unknown[];
  readonly viewType: string;
  readonly webview: { html: string };
  visible: boolean;
  onMessage: ((message: unknown) => void) | null;
  dispose(): void;
  receive(message: unknown): void;
}

let harness: Harness;
let root: string;
const resources: { close(): void }[] = [];
const pages: BridgeClient[] = [];

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), "omp-extension-lifecycle-"));
  const entry = fileURLToPath(new URL("./extension.ts", import.meta.url));
  const outfile = path.join(root, "extension.mjs");
  await build({ entryPoints: [entry], outfile, bundle: true, platform: "node", format: "esm", target: "node22", plugins: [{
    name: "lifecycle-fixtures",
    setup(builder) {
      builder.onResolve({ filter: /^vscode$/ }, () => ({ path: "vscode", namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: VSCODE, loader: "js", resolveDir: path.dirname(entry) }));
      builder.onLoad({ filter: /[/\\]extension\.ts$/ }, async () => ({ contents: (await readFile(entry, "utf8")) + ACCESS, loader: "ts" }));
      builder.onResolve({ filter: /^\.\/(?:host\/)?session-claim(?:\.ts)?$/ }, () => ({ path: "claims", namespace: "claim-fixture" }));
      builder.onLoad({ filter: /^claims$/, namespace: "claim-fixture" }, () => ({
        contents: `import { acquireClaim as actual } from ${JSON.stringify(path.join(path.dirname(entry), "host", "session-claim.ts"))};
          export * from ${JSON.stringify(path.join(path.dirname(entry), "host", "session-claim.ts"))};
          let failures = [];
          export function setClaimFailures(codes) { failures = [...codes]; }
          export async function acquireClaim(...args) {
            if (failures.length) { const code = failures.shift(); throw Object.assign(new Error('transient claim admission'), { code }); }
            return actual(...args);
          }`,
        loader: "js", resolveDir: path.dirname(entry),
      }));
      builder.onResolve({ filter: /^\.\/host\/desktop-notifications$/ }, () => ({ path: "desktop", namespace: "desktop-fixture" }));
      builder.onLoad({ filter: /^desktop$/, namespace: "desktop-fixture" }, () => ({
        contents: `import { desktopToastXml } from ${JSON.stringify(path.join(path.dirname(entry), "host", "desktop-notifications.ts"))};
          const xmls = [];
          export function capturedDesktopXml() { return xmls.at(-1); }
          export function capturedDesktopXmls() { return xmls; }
          export function resetDesktopXmls() { xmls.length = 0; }
          export async function sendDesktopNotification(notice) {
            xmls.push(desktopToastXml(notice));
            return { appId: 'Microsoft.VisualStudioCode', group: 'omp-vscode', tag: String(xmls.length) };
          }`,
        loader: "js", resolveDir: path.dirname(entry),
      }));
      for (const [name, extra] of [
        ["native-terminal", `
          import { resolveOmpBinary as realResolveOmpBinary, runOmpCli as realRunOmpCli } from ${JSON.stringify(path.join(path.dirname(entry), "host", "native-terminal.ts"))};
          export const providerLoginFixture = { enabled: false, unresolved: false, models: [], calls: [], logins: [], read: null, resolve: null };
          let resolved;
          export async function resolveOmpBinary() {
            if (providerLoginFixture.unresolved) throw new Error('fixture unresolved');
            if (providerLoginFixture.resolve) return providerLoginFixture.resolve();
            if (providerLoginFixture.enabled) return { command: process.execPath, prefixArgs: [], version: 'fixture' };
            return resolved ??= realResolveOmpBinary();
          }
          export async function runOmpCli(executable, args, timeout, options) {
            if (args[0] !== 'models') return realRunOmpCli(executable, args, timeout, options);
            providerLoginFixture.calls.push({ args, options });
            return providerLoginFixture.read ? providerLoginFixture.read() : { stdout: JSON.stringify({ models: providerLoginFixture.models }), stderr: '', exitCode: 0 };
          }
          export function openProviderLoginTerminal(request) { providerLoginFixture.logins.push(request); return { name: request.name }; }
        `],
        ["rpc-launch", "export async function launchRpcHost() { return globalThis.__nativeLaunch; }"],
        ["control-client", "export async function queryControlProcessGeneration() { return 'creation-fixture'; }"],
        ["control-protocol", "export async function readControlRendezvous() { return globalThis.__controlReadiness ? globalThis.__controlReadiness() : {}; }"],
        ["rpc-reconcile", "export async function brokerNativeGenerationReader() { return async () => ({ kind: 'gone' }); }"],
        // The root-absence reader is shared by the native and RPC runtime modules.
      ]) {
        builder.onResolve({ filter: new RegExp(`^\\./host/${name}$`) }, () => ({ path: name!, namespace: "native-fixture" }));
        if (name === "rpc-reconcile") builder.onResolve({ filter: /^\.\/rpc-reconcile$/ }, () => ({ path: name, namespace: "native-fixture" }));
        builder.onLoad({ filter: new RegExp(`^${name}$`), namespace: "native-fixture" }, () => ({
          contents: `export * from ${JSON.stringify(path.join(path.dirname(entry), "host", `${name}.ts`))}; ${extra}`,
          loader: "js", resolveDir: path.dirname(entry),
        }));
      }
    },
  }] });
  // This bundle's temporary runtime path has no static import specifier.
  harness = (await import(pathToFileURL(outfile).href)).harness as Harness;
});
after(async () => {
  for (const page of pages) page.stop();
  for (const resource of resources) resource.close();
  await rm(root, { recursive: true, force: true });
});

function storage() {
  const secrets = new Map<string, string>();
  const records = new Map<string, unknown>();
  return {
    secrets, records,
    context: {
      extensionUri: { fsPath: root }, globalStorageUri: { fsPath: root },
      subscriptions: [] as { dispose(): void }[],
      globalState: { get: (key: string) => records.get(key), update: async (key: string, value: unknown) => { records.set(key, value); } },
      secrets: { get: async (key: string) => secrets.get(key), store: async (key: string, value: string) => { secrets.set(key, value); }, delete: async (key: string) => { secrets.delete(key); } },
    },
  };
}
function runtime(pid: number) {
  let exited = false;
  return {
    kind: "chat" as const, pid, cwd: root, sessionFile: path.join(root, "session.jsonl"), binary: null, notice: null,
    identity: { slot: `slot-${pid}`, brokerId: `broker-${pid}`, brokerGeneration: `generation-${pid}`, childCreationTime: `creation-${pid}` },
    exit() { exited = true; },
    handle: {
      get state() { return exited ? "exited" as const : "running" as const; },
      stop: async () => { exited = true; return { pidGone: true, verified: false, tree: "unknown", nativePid: pid, remainingPids: [] as number[], detail: "fixture writer gone" }; },
      refreshStatus: async () => ({ state: exited ? "exited" : "running", nativePid: pid, nativeCreationTime: `creation-${pid}` }),
      shutdown: async () => undefined, disconnect() {},
    },
  };
}
function indexFixture(native: NativeFixture) {
  const row = {
    tabId: TAB, cwd: root, kind: "session", sessionFile: native.sessionFile, sessionId: "session-1", scope: { profile: null, sessionDir: null },
    ownership: { ownerGeneration: OWNER, releasedAt: null }, runIntent: "running", availability: "live", host: { pid: native.pid }, title: null,
  };
  const binding: { tabId: string; role: string; mode?: "chat" | "terminal" } = { tabId: TAB, role: "controlling", mode: "chat" };
  return {
    isLaunching: () => false, setActiveTab: async () => undefined,
    observeOwnership: async () => ({ ok: true, claim: null }),
    claimHolder: { id: "fixture-window" },
    row, lifecycle: new TabLifecycle(), activeTabId: TAB, get: () => row,
    list: () => [row],
    slotBinding: () => binding,
    setEditorMode: async (_slotId: string, mode: "chat" | "terminal") => { binding.mode = mode; },
    setRunIntent: async (_tabId: string, intent: string) => { row.runIntent = intent; },
    // Only the unread markers are modelled; a title update is refused, as the fixture always did.
    recordConversationState: async (_tabId: string, update: { title?: string | null; lastCompletedReplyId?: string | null; lastSeenReplyId?: string | null }) => {
      if (update.title !== undefined) throw new Error("the fixture index stores no titles");
      if (update.lastCompletedReplyId !== undefined) Object.assign(row, { lastCompletedReplyId: update.lastCompletedReplyId });
      if (update.lastSeenReplyId !== undefined) Object.assign(row, { lastSeenReplyId: update.lastSeenReplyId });
      return row;
    },
    closeSession: async () => { row.availability = "saved"; return { released: true, detail: "fixture claim released" }; },
  };
}
function conversation(session: { phase: string; start(): Promise<void> }) {
  Object.assign(session, {
    epoch: { nonce: "fixture", counter: 1 }, setMutationFence() {},
    readSettlement: async () => session.phase === "live" ? ({ sessionFile: path.join(root, "session.jsonl"), sessionId: "session-1", settled: true, hasContent: false }) : null,
  });
  return { sessionOf: () => session, modelOf: () => null, stateOf: () => ({ phase: session.phase }), startLive() {}, attachPage: () => () => undefined, release() { session.phase = "view-only"; } };
}
function client(snapshot: Promise<unknown>) {
  let closed = false;
  return {
    get peerProof() { if (closed) throw new Error("closed"); return {}; },
    snapshot: () => snapshot, close: () => { closed = true; }, get closed() { return closed; },
  };
}
const snapshot = { host: { instanceId: "native-fixture" } };

function nativeBinding(native: NativeFixture): BridgeNativeBinding {
  return { ownerGeneration: OWNER, pid: native.pid, processCreation: native.identity.childCreationTime,
    slot: native.identity.slot, brokerId: native.identity.brokerId, brokerGeneration: native.identity.brokerGeneration,
    sessionId: "session-1", sessionFile: native.sessionFile };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  // A deadline for real sockets, not a sleep or a guessed readiness delay.
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("lifecycle observation timed out")), 8000); })]);
  } finally { clearTimeout(timer); }
}

describe("desktop protocol activation", () => {
  it("routes the actual toast URI through external query routing and the URI handler without starting a session", async () => {
    const native = runtime(827); const index = indexFixture(native);
    harness.reset(index, null);
    const restore = harness.desktopEnvironment({ extension: { id: "hmmvot.omp-desk" } });
    try {
      const state = harness.state(TAB);
      state.runtime = native;
      const revealed: unknown[][] = [];
      state.panel = { viewColumn: 2, reveal: (...args: unknown[]) => revealed.push(args) };
      harness.notifierFor(index).notify(TAB, { kind: "turn-complete", outcome: null });
      await nextTurn();
      const xml = harness.desktopPayload();
      assert.ok(xml !== undefined);
      const launch = /\blaunch="([^"]+)"/u.exec(xml)?.[1];
      assert.ok(launch !== undefined);
      // External protocol routing consumes ordinary query syntax before the
      // extension's URI handler receives the decoded VS Code URI components.
      const routed = new URL(launch.replaceAll("&amp;", "&"));
      assert.equal(routed.searchParams.get("session"), TAB);
      assert.equal(routed.searchParams.get("windowId"), "9471");
      await harness.revealDesktopNotification(index, "hmmvot.omp-desk", URI.parse(routed.href));
      assert.deepEqual(revealed, [[2, false]]);
      assert.equal(state.runtime, native);
      assert.equal(index.row.runIntent, "running");
    } finally { restore(); }
  });
  it("reveals only the indexed exact panel without changing its runtime or run intent", async () => {
    const native = runtime(825); const index = indexFixture(native);
    harness.reset(index, null);
    const state = harness.state(TAB);
    state.runtime = native;
    const revealed: unknown[][] = [];
    const panel = { viewColumn: 2, reveal: (...args: unknown[]) => revealed.push(args) };
    state.panel = panel;
    const uri = { authority: "hmmvot.omp-desk", path: "/reveal", query: `session=${encodeURIComponent(TAB)}&windowId=ignored` };
    await harness.revealDesktopNotification(index, "hmmvot.omp-desk", uri);
    assert.deepEqual(revealed, [[2, false]]);
    assert.equal(state.runtime, native);
    assert.equal(index.row.runIntent, "running");
    for (const invalid of [
      { ...uri, authority: "other.extension" },
      { ...uri, path: "/resume" },
      { ...uri, query: "session=not-a-session" },
      { ...uri, query: "unrelated=value" },
      { ...uri, query: `session=${encodeURIComponent("tab:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee")}` },
    ]) await harness.revealDesktopNotification({ ...index, get: (id: string) => id === TAB ? index.row : null }, "hmmvot.omp-desk", invalid);
    await harness.revealDesktopNotification({ ...index, get: () => null }, "hmmvot.omp-desk", uri);
    assert.deepEqual(revealed, [[2, false]]);
    assert.equal(state.runtime, native);
    assert.equal(index.row.runIntent, "running");
  });

  it("selects an indexed row without opening or starting a handle-less session, and ignores a removed row", async () => {
    const native = runtime(826); const index = indexFixture(native);
    harness.reset(index, null);
    const state = harness.state(TAB);
    const initialPanel = state.panel;
    state.runtime = native;
    const item = { tabId: TAB };
    let selected: unknown = null;
    let focused = false;
    let present = true;
    const rowIndex = { ...index, get: () => present ? index.row : null };
    harness.notificationTree({ itemFor: async () => item }, {
      reveal: async (row: unknown, options: { select: boolean; focus: boolean }) => {
        if (options.select) selected = row;
        focused = options.focus;
      },
    });
    const uri = { authority: "hmmvot.omp-desk", path: "/reveal", query: `session=${encodeURIComponent(TAB)}` };
    try {
      await harness.revealDesktopNotification(rowIndex, "hmmvot.omp-desk", uri);
      assert.equal(selected, item);
      assert.equal(focused, true);
      assert.equal(state.panel, initialPanel);
      assert.equal(state.runtime, native);
      assert.equal(index.row.runIntent, "running");
      selected = null;
      harness.notificationTree({ itemFor: async () => { present = false; return item; } }, {
        reveal: async (row: unknown) => { selected = row; },
      });
      await harness.revealDesktopNotification(rowIndex, "hmmvot.omp-desk", uri);
      assert.equal(selected, null);
      assert.equal(state.runtime, native);
      assert.equal(index.row.runIntent, "running");
    } finally { harness.notificationTree(undefined, undefined); }
  });
});


describe("focused-window hidden Chat notifications", () => {
  it("notifies a fresh completed turn after hiding a reused Chat editor and reattaching its conversation", async () => {
    const saved = storage(); const native = runtime(828); const index = indexFixture(native);
    await writeFile(native.sessionFile, sessionFileText({ id: "session-1", cwd: root, entries: [] }));
    const context = { ...saved.context, extension: { id: "hmmvot.omp-desk" } };
    const modelErrors: unknown[] = [];
    const host = new ChatRuntime({ hostNonce: "hidden-reopened-chat",
      onEvent: (tabId, event) => {
        try { harness.handleChatEvent(context, index, tabId, event); }
        catch (error) { if (event.type === "model") modelErrors.push(error); }
      },
      createSession: options => new RpcSession({ ...options, timers: new ManualTimers() }),
    });
    harness.reset(index, host);
    const restore = harness.desktopEnvironment(context);
    const state = harness.state(TAB);
    state.runtime = native;
    const panel = { title: "Hidden Chat", visible: true, webview: { postMessage: async () => true } };
    state.panel = panel;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const channel = new FakeRpcChannel({ sessionFile: native.sessionFile, sessionId: "session-1", model: null });
        const session = host.startLive(TAB, { channel, sessionFile: native.sessionFile, cwd: root, title: null });
        await session.start();
        panel.visible = true; harness.focusSession(true);
        channel.emit({ type: "agent_start" });
        panel.visible = false; harness.focusSession(false);
        channel.emitMessage("message_end", `hidden-answer-${attempt}`, assistantMessage("HIDDEN ANSWER", 3000 + attempt) as never);
        channel.emit({ type: "agent_end", isTerminal: true, messages: [] });
        channel.emit({ type: "prompt_result", id: `prompt-${attempt}`, status: "completed", agentInvoked: true, sessionSettled: true });
        channel.emit({ type: "session_settled" });
        await nextTurn();
        assert.deepEqual(modelErrors, [], "the host notification projection must not fail inside the RPC listener");
        assert.equal(harness.desktopPayloads().length, attempt + 1, "each hidden fresh turn earns exactly one toast, including after reattach");
        assert.match(harness.desktopPayloads()[attempt]!, /Hidden Chat/);
        assert.match(harness.desktopPayloads()[attempt]!, /Finished — waiting for your input/);
        assert.equal(state.panel, panel, "reattach keeps the existing editor");
      }
    } finally { host.dispose(); harness.forgetTurnActivity(index, TAB); restore(); harness.focusSession(false); }
  });
});

describe("footer host readback", () => {
  it("follows footer model/thinking readback rather than pending or requested values", async () => {
    const saved = storage(); const native = runtime(820); const index = indexFixture(native);
    await writeFile(native.sessionFile, sessionFileText({ id: "session-1", cwd: root, entries: [] }));
    const channel = new FakeRpcChannel({ sessionFile: native.sessionFile, sessionId: "session-1",
      model: { provider: "anthropic", id: "old", name: "Original", contextWindow: 1000 }, thinkingLevel: "medium" });
    const host = new ChatRuntime({ hostNonce: "status-readback",
      onEvent: (tabId, event) => harness.handleChatEvent(saved.context, index, tabId, event),
      createSession: options => new RpcSession({ ...options, timers: new ManualTimers() }),
    });
    const rendered = new ChatClient({ post: () => true });
    harness.reset(index, host);
    const state = harness.state(TAB);
    state.runtime = native;
    const panel = { webview: { postMessage: async () => true } };
    state.panel = panel;
    host.attachPage(TAB, { id: "status-footer", post: message => { rendered.handle(message); return "sent"; } });
    try {
      const session = host.startLive(TAB, { channel, sessionFile: native.sessionFile, cwd: root, title: null });
      await session.start();
      assert.equal(rendered.getSnapshot().state?.model?.name, "Original");
      channel.autoRespond = false;
      const scope = "11111111-2222-4333-8444-555555555555";
      const modelRequest = { type: "omp:control-request", scope, requestId: 1, actionSeq: "1",
        action: "set-model", model: { provider: "anthropic", id: "requested" } };
      const changingModel = harness.handleGuestControlRequest(index, TAB, modelRequest, harness.panelResponder(TAB, panel, "1"));
      await nextTurn();
      const modelCommand = channel.commandsOfType("set_model").at(-1)!;
      assert.equal(rendered.getSnapshot().state?.model?.id, "old", "dispatch alone must not change readback");
      channel.emit({ type: "response", command: "set_model", id: modelCommand.id, success: true,
        data: { provider: "anthropic", id: "effective", name: "Effective", contextWindow: 2000 } });
      await changingModel;
      assert.equal(rendered.getSnapshot().state?.model?.id, "effective");

      const thinkingRequest = { type: "omp:control-request", scope, requestId: 2, actionSeq: "2",
        action: "set-thinking", level: "xhigh" };
      const changingThinking = harness.handleGuestControlRequest(index, TAB, thinkingRequest, harness.panelResponder(TAB, panel, "2"));
      await nextTurn();
      const thinkingCommand = channel.commandsOfType("set_thinking_level").at(-1)!;
      assert.equal(rendered.getSnapshot().state?.thinkingLevel, "medium");
      channel.emit({ type: "thinking_level_changed", thinkingLevel: "high" });
      assert.equal(rendered.getSnapshot().state?.thinkingLevel, "high");
      channel.emit({ type: "response", command: "set_thinking_level", id: thinkingCommand.id, success: true });
      await changingThinking;
      assert.equal(rendered.getSnapshot().state?.thinkingLevel, "high", "acknowledgement cannot replace effective readback with xhigh");
    } finally { host.dispose(); }
  });
  it("refreshes default-model availability on activation, login terminal close and changed session models", async () => {
    await harness.providerModelsIdle();
    const native = runtime(821), index = indexFixture(native);
    harness.reset(index, new ChatRuntime({ hostNonce: "provider-refresh", onEvent: () => {} }));
    const fixture = harness.providerLoginFixture;
    fixture.enabled = true; fixture.models = []; fixture.calls.length = 0;
    const subscriptions: { dispose(): void }[] = [];
    try {
      harness.subscribeProviderLoginRefresh({ subscriptions }, index);
      await harness.providerModelsIdle();
      assert.equal(fixture.calls.length, 1);
      assert.deepEqual(fixture.calls[0]!.args, ["models", "--json"]);
      assert.deepEqual(fixture.calls[0]!.options.env, { OMP_PROFILE: "default" });
      harness.closeLoginTerminal("ordinary shell");
      await harness.providerModelsIdle();
      assert.equal(fixture.calls.length, 1);
      fixture.models = [{ id: "available" }];
      harness.closeLoginTerminal("omp login");
      await harness.providerModelsIdle();
      assert.equal(fixture.calls.length, 2);
      harness.recordSessionModels(index, TAB, false);
      await harness.providerModelsIdle();
      assert.equal(fixture.calls.length, 3);
      assert.equal(harness.sessionModelAvailability(TAB), false);
      harness.recordSessionModels(index, TAB, false);
      await harness.providerModelsIdle();
      assert.equal(fixture.calls.length, 3, "unchanged session models reuse the cached flag");
      harness.recordSessionModels(index, TAB, true);
      await harness.providerModelsIdle();
      assert.equal(fixture.calls.length, 4);
      assert.equal(harness.sessionModelAvailability(TAB), true);
      fixture.unresolved = true;
      await harness.refreshDefaultProviderModels();
      assert.equal(fixture.calls.length, 4, "missing OMP is not treated as an empty catalogue");
    } finally {
      for (const subscription of subscriptions) subscription.dispose();
      fixture.enabled = false; fixture.unresolved = false;
    }
  });

  it("keeps a terminal-close refresh that arrives during an outstanding default catalogue read", async () => {
    await harness.providerModelsIdle();
    const fixture = harness.providerLoginFixture;
    const deferred = Promise.withResolvers<{ stdout: string; stderr: string; exitCode: number }>();
    fixture.enabled = true; fixture.calls.length = 0; fixture.read = () => deferred.promise;
    try {
      const first = harness.refreshDefaultProviderModels();
      await nextTurn();
      assert.equal(fixture.calls.length, 1);
      const second = harness.refreshDefaultProviderModels();
      fixture.read = null; fixture.models = [{ id: "after-login" }];
      deferred.resolve({ stdout: '{"models":[]}', stderr: "", exitCode: 0 });
      await Promise.all([first, second]);
      assert.equal(fixture.calls.length, 2, "one coalesced follow-up reads the new credentials");
    } finally { fixture.enabled = false; fixture.read = null; }
  });

  it("uses the chat's RPC models and keeps login in the model picker without selecting a fake model", async () => {
    const saved = storage(), native = runtime(822), index = indexFixture(native);
    await writeFile(native.sessionFile, sessionFileText({ id: "session-1", cwd: root, entries: [] }));
    const channel = new FakeRpcChannel({ sessionFile: native.sessionFile, sessionId: "session-1" });
    let available: unknown[] = [];
    channel.handlers.set("get_available_models", () => ({ data: { models: available } }));
    const host = new ChatRuntime({ hostNonce: "provider-models", onEvent: () => {},
      createSession: options => new RpcSession({ ...options, timers: new ManualTimers() }) });
    harness.reset(index, host);
    const state = harness.state(TAB); state.runtime = native;
    const messages: unknown[] = [];
    const panel = { webview: { postMessage: async (message: unknown) => { messages.push(message); return true; } } };
    state.panel = panel;
    const fixture = harness.providerLoginFixture;
    fixture.enabled = true; fixture.logins.length = 0;
    const subscriptions: { dispose(): void }[] = [];
    harness.subscribeProviderLoginRefresh({ subscriptions }, index);
    try {
      const session = host.startLive(TAB, { channel, sessionFile: native.sessionFile, cwd: root, title: null });
      await session.start();
      await harness.refreshSessionModels(index, TAB);
      assert.equal(harness.sessionModelAvailability(TAB), false);
      assert.ok(channel.commandsOfType("get_available_models").length > 0);
      const metadata = messages.at(-1);
      assert.ok(metadata && typeof metadata === "object" && "hasAvailableModels" in metadata);
      assert.equal(metadata.hasAvailableModels, false);
      await harness.runChatAction(saved.context, index, TAB, "provider-login");
      assert.deepEqual(fixture.logins.at(-1)?.env, { OMP_PROFILE: "default" });
      available = [{ provider: "p", id: "m", name: "Model", contextWindow: 1000 }];
      harness.closeLoginTerminal("omp login");
      await harness.refreshSessionModels(index, TAB);
      assert.equal(harness.sessionModelAvailability(TAB), true);
      const request = { type: "omp:control-request", scope: "11111111-2222-4333-8444-555555555555", requestId: 1, action: "snapshot", picker: "model" };
      const pending = harness.handleGuestControlRequest(index, TAB, request, harness.panelResponder(TAB, panel));
      await nextTurn();
      const picker = harness.quickPicks().at(-1)!;
      assert.equal(picker.items.at(-1)?.label, "$(account) Log In to Provider…");
      picker.choose(picker.items.length - 1);
      await pending;
      assert.equal(fixture.logins.length, 2);
      assert.equal(channel.commandsOfType("set_model").length, 0);
      const reply = messages.at(-1);
      assert.ok(reply && typeof reply === "object" && "type" in reply);
      assert.equal(reply.type, "omp:control-state");
      assert.equal("selectedModel" in reply, false);
    } finally {
      harness.closeLoginTerminal("omp login"); host.dispose(); await harness.providerModelsIdle();
      for (const subscription of subscriptions) subscription.dispose();
      fixture.enabled = false;
    }
  });

  it("allows scoped passive panel login while keeping the real passive bridge eligibility fence", async () => {
    const saved = storage(), native = runtime(823), index = indexFixture(native);
    index.slotBinding = () => ({ tabId: TAB, role: "passive" });
    const host = new ChatRuntime({ hostNonce: "passive-provider-login", onEvent: () => {} });
    harness.reset(index, host);
    const fixture = harness.providerLoginFixture;
    fixture.enabled = true; fixture.logins.length = 0;
    const restore = harness.desktopEnvironment(saved.context);
    const panel = harness.createPanel();
    const endpoint = new BridgeEditorEndpoint({
      records: new BridgeRecords({ root: path.join(root, "passive-provider-login"), secrets: saved.context.secrets }),
      scope: { workspace: "a".repeat(64), tabId: TAB, editorId: EDITOR },
      hostGeneration: harness.hostGeneration(),
      eligible: documentId => harness.bridgeDocumentEligible(EDITOR, documentId),
      onRequest: () => assert.fail("a passive page has no bridge request authority"),
    });
    resources.push(endpoint);
    assert.ok(await endpoint.beginDocument(DOCUMENT, "d".repeat(32)));
    const state = harness.editor(index, endpoint, panel);
    state.runtime = native;
    const subscriptions: { dispose(): void }[] = [];
    harness.subscribeProviderLoginRefresh({ subscriptions }, index);
    const command = { type: "omp:chat-command", command: "provider-login" };
    try {
      assert.equal(harness.bridgeDocumentEligible(EDITOR, DOCUMENT), false, "the real authentication/ACK eligibility rejects a passive editor");
      await harness.handlePassiveSlotMessage(EDITOR, panel, command);
      assert.equal(fixture.logins.length, 1);
      assert.deepEqual(fixture.logins[0]!.env, { OMP_PROFILE: "default" });
      assert.equal(harness.bridgeDocumentEligible(EDITOR, DOCUMENT), false, "login grants no passive bridge authority");
      harness.closeLoginTerminal("omp login");
      await harness.handlePassiveSlotMessage(EDITOR, harness.createPanel(), command);
      await harness.handlePassiveSlotMessage(EDITOR, panel, { ...command, profile: "other" });
      await harness.handlePassiveSlotMessage(EDITOR, panel, { ...command, command: "cycle-model" });
      assert.equal(fixture.logins.length, 1, "a stale panel, injected scope or model command cannot launch login even with the guard released");
      assert.equal(index.row.runIntent, "running");
      assert.equal(state.runtime, native);
      assert.equal(host.sessionOf(TAB), null);
    } finally {
      harness.closeLoginTerminal("omp login"); host.dispose(); endpoint.close(); await harness.providerModelsIdle();
      for (const subscription of subscriptions) subscription.dispose();
      fixture.enabled = false; restore();
    }
  });

  it("ignores concurrent provider-login requests through the real bridge while executable preflight is pending", async () => {
    await harness.providerModelsIdle();
    const saved = storage(), native = runtime(826), index = indexFixture(native);
    const host = new ChatRuntime({ hostNonce: "bridge-provider-login", onEvent: () => {} });
    harness.reset(index, host);
    const fixture = harness.providerLoginFixture;
    fixture.enabled = true; fixture.logins.length = 0;
    const restore = harness.desktopEnvironment(saved.context);
    const scope = { workspace: "a".repeat(64), tabId: TAB, editorId: EDITOR };
    const endpoint = new BridgeEditorEndpoint({
      records: new BridgeRecords({ root: path.join(root, "bridge-provider-login"), secrets: saved.context.secrets }),
      scope, hostGeneration: harness.hostGeneration(),
      eligible: documentId => harness.bridgeDocumentEligible(EDITOR, documentId),
      onRequest: (peer, documentId, request) => harness.handleBridgeRequest(EDITOR, documentId, peer, request),
    });
    resources.push(endpoint);
    const port = await endpoint.bind(); assert.notEqual(port, null);
    assert.ok(await endpoint.beginDocument(DOCUMENT, "d".repeat(32)));
    assert.equal(endpoint.pinOrigin(DOCUMENT, ORIGIN), true);
    const delivery = await endpoint.commit(nativeBinding(native)); assert.ok(delivery);
    const state = harness.editor(index, endpoint, harness.createPanel());
    state.runtime = native;
    endpoint.nativeReady(true); assert.ok(endpoint.offerBridge());
    const subscriptions: { dispose(): void }[] = [];
    harness.subscribeProviderLoginRefresh({ subscriptions }, index);
    await harness.providerModelsIdle();
    const offered = Promise.withResolvers<string>();
    const unprovenReply = Promise.withResolvers<unknown>();
    const versionReply = Promise.withResolvers<unknown>();
    const invalidReply = Promise.withResolvers<unknown>();
    const invalidation = Promise.withResolvers<string>();
    const firstReply = Promise.withResolvers<unknown>();
    const repeatReply = Promise.withResolvers<unknown>();
    const connections: boolean[] = [];
    const invalidations: string[] = [];
    const NodeSocket = WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => WebSocket;
    const page = new BridgeClient({
      ...scope, documentId: DOCUMENT, port: port!, origin: ORIGIN, bindingHash: delivery.bindingHash, secret: delivery.secret,
      connect: url => new NodeSocket(url, { headers: { origin: ORIGIN } }),
    }, {
      onRouteOffer: generation => offered.resolve(generation),
      onReply: (requestId, payload) => {
        const answer = requestId === "1".repeat(32) ? unprovenReply : requestId === "2".repeat(32) ? versionReply
          : requestId === "3".repeat(32) ? invalidReply : requestId === "4".repeat(32) ? firstReply : requestId === "5".repeat(32) ? repeatReply : null;
        assert.ok(answer, "every reply retains its request correlation"); answer.resolve(payload);
      },
      onInvalidate: generation => { invalidations.push(generation); invalidation.resolve(generation); },
      onConnection: connected => connections.push(connected),
    });
    pages.push(page);
    const gate = Promise.withResolvers<{ command: string; prefixArgs: string[]; version: string }>();
    const preflightStarted = Promise.withResolvers<void>();
    let resolves = 0;
    try {
      page.start();
      const generation = await bounded(offered.promise);
      assert.equal(page.acknowledgeRoute(generation), true);
      const payload = { type: "omp:chat-command", command: "provider-login" };
      assert.equal(page.request({ requestId: "1".repeat(32), routeGeneration: generation, actionSeq: "1", operation: "provider-login", payload }), true);
      assert.equal((await bounded(unprovenReply.promise) as { code: string }).code, "guest-version");
      assert.equal(fixture.logins.length, 0, "an authenticated route alone is not the required guest proof");
      assert.equal(page.request({ requestId: "2".repeat(32), routeGeneration: generation, actionSeq: "2", operation: "guest-version",
        payload: { protocolVersion: GUEST_PROTOCOL_VERSION, fragments: true } }), true);
      assert.deepEqual(await bounded(versionReply.promise), { accepted: true });
      assert.equal(endpoint.guestVersionAccepted(DOCUMENT), true);
      assert.equal(endpoint.routeFor(DOCUMENT)?.state, "BRIDGE_READY");
      assert.equal(page.request({ requestId: "3".repeat(32), routeGeneration: generation, actionSeq: "3", operation: "provider-login", payload: { ...payload, profile: "other" } }), true);
      assert.equal(await bounded(invalidReply.promise), null);
      assert.equal(await bounded(invalidation.promise), generation);
      assert.equal(fixture.logins.length, 0, "the host rejects page-supplied profile authority before any login guard is held");
      const priorConnections = [...connections], priorInvalidations = [...invalidations];
      fixture.resolve = () => { resolves++; preflightStarted.resolve(); return gate.promise; };
      assert.equal(page.request({ requestId: "4".repeat(32), routeGeneration: generation, actionSeq: "4", operation: "provider-login", payload }), true);
      await bounded(preflightStarted.promise);
      assert.equal(page.request({ requestId: "5".repeat(32), routeGeneration: generation, actionSeq: "5", operation: "provider-login", payload }), true);
      assert.equal(await bounded(repeatReply.promise), null, "the repeat is answered while the original executable preflight remains pending");
      assert.equal(resolves, 1);
      assert.equal(fixture.logins.length, 0);
      gate.resolve({ command: process.execPath, prefixArgs: [], version: "fixture" });
      assert.equal(await bounded(firstReply.promise), null);
      assert.equal(fixture.logins.length, 1);
      assert.deepEqual(fixture.logins[0]!.env, { OMP_PROFILE: "default" });
      assert.equal(page.connected, true);
      assert.deepEqual(connections, priorConnections, "no disconnect or reconnect");
      assert.deepEqual(invalidations, priorInvalidations, "valid repeated login does not invalidate the native route");
      assert.equal(endpoint.routeFor(DOCUMENT)?.state, "BRIDGE_READY");
      assert.equal(bindingMatches(endpoint.committedBinding()!, nativeBinding(native)), true);
      assert.equal(index.row.runIntent, "running");
      assert.equal(index.row.ownership.ownerGeneration, OWNER);
      assert.equal(state.runtime, native);
      assert.equal(native.handle.state, "running");
      assert.equal(host.sessionOf(TAB), null, "login neither creates a conversation nor dispatches a prompt");
    } finally {
      fixture.resolve = null; gate.resolve({ command: process.execPath, prefixArgs: [], version: "fixture" });
      page.stop(); endpoint.close(); harness.closeLoginTerminal("omp login"); host.dispose(); await harness.providerModelsIdle();
      for (const subscription of subscriptions) subscription.dispose();
      fixture.enabled = false; restore();
    }
  });

  it("coalesces concurrent login opens and releases the window guard only on its terminal close or preflight failure", async () => {
    await harness.providerModelsIdle();
    const index = indexFixture(runtime(824));
    const host = new ChatRuntime({ hostNonce: "provider-login-guard", onEvent: () => {} });
    harness.reset(index, host);
    const fixture = harness.providerLoginFixture;
    fixture.enabled = true; fixture.logins.length = 0;
    const subscriptions: { dispose(): void }[] = [];
    harness.subscribeProviderLoginRefresh({ subscriptions }, index);
    await harness.providerModelsIdle();
    const gate = Promise.withResolvers<{ command: string; prefixArgs: string[]; version: string }>();
    let resolves = 0;
    fixture.resolve = () => { resolves++; return gate.promise; };
    try {
      const first = harness.openProviderLogin(null, null, root);
      const duplicate = harness.openProviderLogin(null, null, root);
      assert.equal(resolves, 1, "the in-flight guard is reserved before resolving the executable");
      gate.resolve({ command: process.execPath, prefixArgs: [], version: "fixture" });
      await Promise.all([first, duplicate]);
      fixture.resolve = null;
      assert.equal(fixture.logins.length, 1);
      await harness.openProviderLogin(null, null, root);
      harness.closeOtherTerminal("omp login");
      await harness.openProviderLogin(null, null, root);
      assert.equal(fixture.logins.length, 1, "another terminal with the same name cannot release the owned guard");
      harness.closeLoginTerminal("omp login");
      await harness.openProviderLogin(null, null, root);
      assert.equal(fixture.logins.length, 2, "the owned terminal close releases the guard");
      harness.closeLoginTerminal("omp login");
      fixture.unresolved = true;
      await harness.openProviderLogin(null, null, root);
      assert.equal(fixture.logins.length, 2);
      fixture.unresolved = false;
      await harness.openProviderLogin(null, null, root);
      assert.equal(fixture.logins.length, 3, "a failed executable preflight does not hold the guard forever");
    } finally {
      fixture.resolve = null; fixture.unresolved = false;
      gate.resolve({ command: process.execPath, prefixArgs: [], version: "fixture" });
      harness.closeLoginTerminal("omp login"); host.dispose(); await harness.providerModelsIdle();
      for (const subscription of subscriptions) subscription.dispose();
      fixture.enabled = false;
    }
  });

  it("holds the shared login guard during palette profile choice and releases it on cancellation", async () => {
    await harness.providerModelsIdle();
    const base = indexFixture(runtime(825));
    const index = { ...base, activeTabId: null, list: () => [{ ...base.row, scope: { profile: "existing-test-profile" } }] };
    const host = new ChatRuntime({ hostNonce: "provider-profile-guard", onEvent: () => {} });
    harness.reset(index, host);
    const fixture = harness.providerLoginFixture;
    fixture.enabled = true; fixture.logins.length = 0;
    const subscriptions: { dispose(): void }[] = [];
    harness.subscribeProviderLoginRefresh({ subscriptions }, index);
    await harness.providerModelsIdle();
    const answer = Promise.withResolvers<string | undefined>();
    let choices = 0;
    const restorePicker = harness.profilePicker(async profiles => {
      choices++;
      assert.deepEqual(profiles, ["default", "existing-test-profile"]);
      return answer.promise;
    });
    try {
      const first = harness.loginProviderFromPalette(index);
      const duplicate = harness.loginProviderFromPalette(index);
      await harness.openProviderLogin(null, null, root);
      assert.equal(choices, 1);
      assert.equal(fixture.logins.length, 0);
      answer.resolve(undefined);
      await Promise.all([first, duplicate]);
      restorePicker();
      const restoreSelectedPicker = harness.profilePicker(async () => "default");
      try { await harness.loginProviderFromPalette(index); }
      finally { restoreSelectedPicker(); }
      assert.equal(fixture.logins.length, 1, "cancelling the profile picker does not hold the shared guard");
      assert.deepEqual(fixture.logins[0]!.env, { OMP_PROFILE: "default" });
    } finally {
      answer.resolve(undefined); restorePicker();
      harness.closeLoginTerminal("omp login"); host.dispose(); await harness.providerModelsIdle();
      for (const subscription of subscriptions) subscription.dispose();
      fixture.enabled = false;
    }
  });
});

describe("native replacement lifecycle", () => {
  it("recovers transient Windows claim admission before launch without replaying a writer", { skip: process.platform !== "win32" }, async () => {
    const values = new Map<string, unknown>();
    const index = new harness.SessionIndex({ claimStorageDir: path.join(root, "retry-claims"), store: {
      get<T>(key: string) { return values.get(key) as T | undefined; },
      async update(key: string, value: unknown) { values.set(key, value); },
    } });
    const draft = await index.createDraft({ cwd: root });
    let launches = 0;
    harness.setClaimFailures(["EPERM", "EBUSY"]);
    try {
      const outcome = await index.restore(draft.tabId, {
        reconciler: { reconcile: async () => ({ kind: "free", evidence: [{ kind: "no-recorded-host" }] }) },
        launcher: {
          launch: async () => { launches++; return { state: "running", host: { pid: 4411, sessionId: "retry-session", rpc: null } }; },
          attach: async () => { throw new Error("must not attach"); },
        },
      });
      assert.equal(outcome.status, "restored", JSON.stringify(outcome));
      assert.equal(launches, 1);
      assert.equal(index.get(draft.tabId)?.host?.pid, 4411);
    } finally { harness.setClaimFailures([]); }
  });
  it("reads a real other-window claim before offering Resume, then removes the block only after release", async () => {
    const values = new Map<string, unknown>();
    const index = new harness.SessionIndex({ claimStorageDir: path.join(root, "claims"), store: {
      get<T>(key: string) { return values.get(key) as T | undefined; },
      async update(key: string, value: unknown) { values.set(key, value); },
    } });
    const file = path.join(root, "remote-session.jsonl");
    await writeFile(file, JSON.stringify({ type: "session", version: 3, id: "remote-session", timestamp: "2026-09-30T10:00:00Z", cwd: root }) + "\n");
    const row = await index.trackSession({ sessionFile: file, cwd: root });
    const rival = await harness.acquireClaim(path.join(root, "claims"), file, "remote-window-owner", harness.createClaimHolder());
    harness.reset(index, { stateOf: () => null });
    try {
      assert.equal((await harness.launcherOwnershipFacts(index, row.tabId)).heldElsewhere, true);
      await rival.release();
      assert.notEqual((await harness.launcherOwnershipFacts(index, row.tabId)).heldElsewhere, true);
    } finally { await rival.release(); }
  });

  it("shows a session another window holds as 'otherWindow' as soon as its claim appears, and clears it on release, with no manual refresh", async () => {
    const claimDir = path.join(root, "watched-claims");
    const values = new Map<string, unknown>();
    const index = new harness.SessionIndex({ claimStorageDir: claimDir, store: {
      get<T>(key: string) { return values.get(key) as T | undefined; },
      async update(key: string, value: unknown) { values.set(key, value); },
    } });
    const file = path.join(root, "watched-session.jsonl");
    await writeFile(file, sessionFileText({ id: "watched-session", cwd: root, entries: [] }));
    const row = await index.trackSession({ sessionFile: file, cwd: root });
    harness.reset(index, { stateOf: () => null });
    const provider = new harness.SessionTreeProvider({
      folders: () => [{ id: "folder:watched", path: root, collapsed: false, pinned: true, open: false }],
      entries: () => index.list(),
      activeTabId: () => null,
      facts: () => ({ open: false, running: false, outcome: null, activity: null }),
      runtimeIdentity: () => null,
      observeOwnership: tabId => harness.launcherOwnershipFacts(index, tabId),
    });
    harness.notificationTree(provider, undefined);
    const watch = harness.startClaimWatch(claimDir, files => harness.refreshRowsForClaims(index, files), { debounceMs: 20 });
    // Waits on the view's own repaint signal, never on a guessed delay.
    const shown = async (expected: string): Promise<void> => {
      for (;;) {
        const repainted = Promise.withResolvers<void>();
        const subscription = provider.onDidChangeTreeData(() => repainted.resolve());
        try {
          await provider.getChildren(provider.getChildren()[0]);
          if (provider.displayedState(row.tabId) === expected) return;
          await bounded(repainted.promise);
        } finally { subscription.dispose(); }
      }
    };
    let rival: SessionClaim | null = null;
    try {
      await shown("stopped");
      rival = await harness.acquireClaim(claimDir, file, "remote-window-owner", harness.createClaimHolder());
      await shown("otherWindow");
      // Open and a click explain instead of launching: no writer is started or recorded.
      const informed: unknown[] = [];
      harness.information(async message => { informed.push(message); });
      await harness.openSession(undefined, index, { tabId: row.tabId }, "resumed");
      assert.equal(informed.length, 1, "a rival without window metadata is explained, never launched");
      assert.equal(index.get(row.tabId)?.host ?? null, null);
      await rival.release(); rival = null;
      await shown("stopped");
    } finally {
      await rival?.release();
      watch(); provider.dispose(); harness.notificationTree(undefined, undefined);
    }
  });

  it("opens rival-held history without Resume, then offers Resume after a genuine stopped verdict", async () => {
    const values = new Map<string, unknown>();
    const index = new harness.SessionIndex({ claimStorageDir: path.join(root, "page-claims"), store: {
      get<T>(key: string) { return values.get(key) as T | undefined; },
      async update(key: string, value: unknown) { values.set(key, value); },
    } });
    const file = path.join(root, "held-page.jsonl");
    await writeFile(file, JSON.stringify({ type: "session", version: 3, id: "held-page", timestamp: "2026-09-30T10:00:00Z", cwd: root }) + "\n");
    const row = await index.trackSession({ sessionFile: file, cwd: root });
    const rival = await harness.acquireClaim(path.join(root, "page-claims"), file, "rival-page-owner", harness.createClaimHolder());
    const events: string[] = [];
    let painted = Promise.withResolvers<void>();
    const runtime = new ChatRuntime({ hostNonce: "page-test", onEvent: (_tab, event) => {
      events.push(event.type);
      if (event.type === "state") painted.resolve();
    } });
    const client = new ChatClient({ post: () => true });
    runtime.attachPage(row.tabId, { id: "held-page", post: message => { client.handle(message); return "sent"; } });
    harness.reset(index, runtime);
    const launcher = { launch: async () => { throw new Error("must not launch"); }, attach: async () => { throw new Error("must not attach"); } };
    const reconciler = { reconcile: async () => ({ kind: "free" as const, evidence: [{ kind: "no-recorded-host" as const }] }) };
    try {
      const refused = await index.restore(row.tabId, { launcher, reconciler, allowStoppedResume: false });
      assert.equal(refused.status, "conflict");
      harness.presentRestoreOutcome(index, row.tabId, refused);
      await bounded(painted.promise);
      assert.equal(client.getSnapshot().phase, "blocked");
      assert.match(client.getSnapshot().readOnlyReason!, /holds|claimed/);
      assert.equal(client.resume(), false);
      assert.equal(await runtime.handleMessage(row.tabId, { type: "omp:chat-resume", requestId: "held-resume" }, null), "refused");
      assert.equal(events.includes("resume-requested"), false);
      await rival.release();
      await index.setRunIntent(row.tabId, "stopped");
      const stopped = await index.restore(row.tabId, { launcher, reconciler, allowStoppedResume: false });
      painted = Promise.withResolvers<void>();
      assert.equal(stopped.status, "stopped", JSON.stringify(stopped));
      harness.presentRestoreOutcome(index, row.tabId, stopped);
      await bounded(painted.promise);
      assert.equal(client.getSnapshot().phase, "view-only");
      assert.equal(client.resume(), true);
    } finally { runtime.dispose(); await rival.release(); }
  });

  it("keeps credentials and the running intent when Close cannot prove the writer gone", async () => {
    const saved = storage(); const native = runtime(707); const index = indexFixture(native);
    native.handle.stop = async () => ({ pidGone: false, verified: false, tree: "unknown", nativePid: native.pid, remainingPids: [], detail: "writer remains uncertain" });
    harness.reset(index, conversation({ phase: "live", start: async () => undefined }));
    harness.state(TAB).runtime = native;
    saved.secrets.set(KEY, "still-held-key"); saved.secrets.set(RECIPIENT, "still-held-recipient");
    await harness.closeSession(saved.context, index, TAB);
    assert.equal(saved.secrets.get(KEY), "still-held-key");
    assert.equal(saved.secrets.get(RECIPIENT), "still-held-recipient");
    assert.equal(index.row.runIntent, "running");
    assert.equal(harness.state(TAB).runtime, native);
  });

  it("releases a verified Close's old credentials, waits for resumed identity, then reconnects with the new key", async () => {
    const saved = storage();
    const old = runtime(101);
    const index = indexFixture(old);
    const initialized = Promise.withResolvers<void>();
    const session = { phase: "attaching", start: () => initialized.promise };
    harness.reset(index, conversation(session));
    harness.state(TAB).runtime = old;
    saved.secrets.set(KEY, "old-native-key"); saved.secrets.set(RECIPIENT, "old-recipient");
    saved.records.set(RECORD, { pid: old.pid, slotId: "old-control-slot" });
    await harness.closeSession(saved.context, index, TAB);
    assert.equal(saved.secrets.has(KEY), false, "the replacement must never inherit the old proven native key");
    assert.equal(saved.secrets.has(RECIPIENT), false);
    assert.equal(saved.records.get(RECORD), undefined);
    assert.equal(index.row.runIntent, "stopped");

    const resumed = runtime(202);
    harness.state(TAB).runtime = resumed;
    saved.secrets.set(RECIPIENT, "new-recipient");
    let attempts = 0;
    harness.controlClient.connectWithProvenKey = async () => null;
    harness.controlClient.connectVerified = async input => {
      attempts++;
      assert.equal(session.phase, "live", "native identity is not readable before session_start/get_state");
      assert.equal(input.expectation.sessionFile, resumed.sessionFile);
      assert.ok(input.provenKey === undefined || input.provenKey === "new-native-key", "key-changed must not be bypassed");
      return { client: client(Promise.resolve(snapshot)), key: "new-native-key" };
    };
    const pending = harness.connectHostControl(saved.context, index, TAB, OWNER, resumed, {
      bootstrap: { slotId: "new-control-slot", directory: root }, privateKeyPkcs8Pem: "new-recipient",
    });
    await nextTurn();
    assert.equal(attempts, 0, "Resume cannot verify an uninitialized native session");
    session.phase = "live"; initialized.resolve(); await pending;
    assert.equal(saved.secrets.get(KEY), "new-native-key");
    harness.reset(index, conversation(session)); // extension-host restart; same surviving native process
    harness.state(TAB).runtime = resumed;
    await harness.reconnectHostControl(saved.context, index, TAB, OWNER, resumed);
    assert.equal(attempts, 2);
    assert.notEqual(harness.state(TAB).control, null);
  });

  it("connects a slow-starting native once and reconnects after the verified channel closes", async t => {
    const saved = storage();
    const native = { ...runtime(909), kind: "terminal" as const, stopping: false };
    const index = indexFixture(native);
    harness.reset(index, conversation({ phase: "live", start: async () => undefined }));
    harness.state(TAB).runtime = native;
    const owner = `native.${native.identity.slot}`;
    saved.secrets.set(`omp.hostControl.recipient.${owner}`, "native-recipient");
    t.mock.timers.enable({ apis: ["Date"], now: 0 });
    const globals = globalThis as typeof globalThis & { __controlReadiness?: () => unknown };
    let ready = false;
    globals.__controlReadiness = () => {
      if (ready) return {};
      ready = true;
      t.mock.timers.tick(20_000);
      return null;
    };
    const initial = client(Promise.resolve(snapshot));
    const recovered = client(Promise.resolve(snapshot));
    let connections = 0;
    harness.controlClient.connectWithProvenKey = async () => null;
    harness.controlClient.connectVerified = async () => ({ client: ++connections === 1 ? initial : recovered, key: "native-key" });
    try {
      const launch = harness.connectHostControl(saved.context, index, TAB, OWNER, native, {
        bootstrap: { slotId: "native-readiness", directory: root }, privateKeyPkcs8Pem: "native-recipient",
      });
      await nextTurn();
      const simultaneousRecovery = harness.reconnectHostControl(saved.context, index, TAB, OWNER, native);
      await Promise.all([launch, simultaneousRecovery]);
      assert.equal(harness.state(TAB).control?.client, initial, "late readiness must publish a verified channel");
      assert.equal(harness.state(TAB).controlFailure, null);
      assert.equal(connections, 1, "a recovery request must join startup instead of opening a competing channel");
      initial.close();
      await harness.reconnectHostControl(saved.context, index, TAB, OWNER, native);
      assert.equal(harness.state(TAB).control?.client, recovered, "a closed channel must not block recovery");
      assert.equal(harness.state(TAB).controlFailure, null);
      assert.equal(saved.secrets.get(`omp.hostControl.key.${owner}`), "native-key");
    } finally {
      delete globals.__controlReadiness;
      initial.close(); recovered.close();
    }
  });

  it("native watch recovers absent and closed channels while retaining its exact runtime", async t => {
    const saved = storage();
    const base = runtime(910);
    const facts = { available: false, settled: null, sessionFile: null, sessionId: null };
    const native = { ...base, kind: "terminal" as const, stopping: false, observed: null as unknown,
      handle: { ...base.handle, subscribe: () => () => undefined } };
    const index = indexFixture(native);
    harness.reset(index, conversation({ phase: "live", start: async () => undefined }));
    const state = harness.state(TAB);
    state.runtime = native;
    const restore = harness.desktopEnvironment(saved.context);
    const owner = `native.${native.identity.slot}`;
    saved.secrets.set(`omp.hostControl.recipient.${owner}`, "watch-recipient");
    saved.records.set(`omp.hostControl.process.${owner}`, {
      pid: native.pid, processCreation: native.identity.childCreationTime, slotId: "watch-slot", directory: root,
    });
    const makeClient = () => Object.assign(client(Promise.resolve(snapshot)), {
      nativeState: async () => facts,
      nativeActivity: async () => { throw new Error("older native hosts must not be probed for a completion journal"); },
    });
    const initial = makeClient(), recovered = makeClient();
    let connected = false;
    harness.controlClient.connectWithProvenKey = async () => null;
    harness.controlClient.connectVerified = async () => {
      const current = connected ? recovered : initial;
      connected = true;
      return { client: current, key: "watch-key" };
    };
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
    try {
      harness.startNativeWatch(index, state, native);
      await nextTurn();
      t.mock.timers.tick(5_000); await nextTurn();
      assert.equal(state.control?.client, initial, "the native watch must connect when startup had no channel");
      initial.close();
      t.mock.timers.tick(5_000); await nextTurn();
      assert.equal(state.control?.client, recovered, "a dropped channel must reconnect without an explicit user action");
      t.mock.timers.tick(750); await nextTurn();
      assert.equal(native.observed, facts, "an older host remains observable without unsupported completion-journal requests");
      assert.equal(state.runtime, native);
      assert.equal(index.row.runIntent, "running");
      assert.deepEqual(harness.desktopPayloads(), [], "legacy state observations are not completion signals");
    } finally {
      state.nativeWatch?.(); initial.close(); recovered.close(); restore();
      harness.forgetTurnActivity(index, TAB);
    }
  });

  it("reattaches a surviving native host by its proven key although the record names another server or none", async t => {
    const saved = storage();
    const native = { ...runtime(911), kind: "terminal" as const, stopping: false };
    const index = indexFixture(native);
    harness.reset(index, conversation({ phase: "live", start: async () => undefined }));
    const state = harness.state(TAB);
    state.runtime = native;
    const owner = `native.${native.identity.slot}`;
    saved.secrets.set(`omp.hostControl.recipient.${owner}`, "reload-recipient");
    saved.secrets.set(`omp.hostControl.key.${owner}`, "proven-native-key");
    saved.records.set(`omp.hostControl.process.${owner}`, {
      pid: native.pid, processCreation: native.identity.childCreationTime, slotId: "reload-slot", directory: root, activity: true, work: true,
    });
    const globals = globalThis as typeof globalThis & { __controlReadiness?: () => unknown };
    let record: unknown = { pipeName: "subagent-pipe" };
    globals.__controlReadiness = () => record;
    const seen: Array<{ provenKey: string; preferredPipeName?: string }> = [];
    const clients = [client(Promise.resolve(snapshot)), client(Promise.resolve(snapshot))];
    harness.controlClient.connectWithProvenKey = async input => {
      seen.push({ provenKey: input.provenKey, ...(input.preferredPipeName === undefined ? {} : { preferredPipeName: input.preferredPipeName }) });
      return { client: clients[seen.length - 1], key: input.provenKey, rotated: false };
    };
    harness.controlClient.connectVerified = async () => assert.fail("a proven key must not depend on the rendezvous record");
    try {
      // Reload Window: the record was overwritten by an older host's subagent server.
      await harness.reconnectHostControl(saved.context, index, TAB, OWNER, native);
      assert.equal(state.control?.client, clients[0]);
      assert.equal(state.controlFailure, null);
      assert.deepEqual(seen[0], { provenKey: "proven-native-key", preferredPipeName: "subagent-pipe" });
      assert.equal(saved.secrets.get(`omp.hostControl.key.${owner}`), "proven-native-key", "the pinned key is unchanged");

      // In-place update plus reload: the channel dropped and no record exists any more.
      clients[0]!.close();
      record = null;
      await harness.reconnectHostControl(saved.context, index, TAB, OWNER, native);
      assert.equal(state.control?.client, clients[1], "a missing record must not strand a host that is alive");
      assert.equal(state.controlFailure, null);
      assert.equal(seen[1]?.preferredPipeName, undefined);
    } finally {
      delete globals.__controlReadiness;
      for (const each of clients) each?.close();
    }
  });

  it("pins a proven same-process key rotation and never leaves a pending state behind once the host answers", async t => {
    const saved = storage();
    const native = { ...runtime(912), kind: "terminal" as const, stopping: false };
    const index = indexFixture(native);
    harness.reset(index, conversation({ phase: "live", start: async () => undefined }));
    const state = harness.state(TAB);
    state.runtime = native;
    const owner = `native.${native.identity.slot}`;
    saved.secrets.set(`omp.hostControl.recipient.${owner}`, "rotation-recipient");
    saved.secrets.set(`omp.hostControl.key.${owner}`, "proven-native-key");
    saved.records.set(`omp.hostControl.process.${owner}`, {
      pid: native.pid, processCreation: native.identity.childCreationTime, slotId: "rotation-slot", directory: root, activity: true, work: true,
    });
    t.mock.timers.enable({ apis: ["Date"], now: 0 });
    const globals = globalThis as typeof globalThis & { __controlReadiness?: () => unknown };
    const rotatedClient = client(Promise.resolve(snapshot));
    const recoveredClient = client(Promise.resolve(snapshot));
    let probe: "inconclusive" | "absent" | "attached" = "inconclusive";
    harness.controlClient.connectWithProvenKey = async input => {
      if (probe === "inconclusive") throw new Error("the slot's servers could not all be examined");
      if (probe === "absent") return null;
      return { client: recoveredClient, key: input.provenKey, rotated: false };
    };
    const provenKeys: Array<string | undefined> = [];
    harness.controlClient.connectVerified = async input => {
      provenKeys.push(input.provenKey);
      return { client: rotatedClient, key: "rotated-key", rotated: true };
    };
    try {
      // An examination that could not be completed never falls through to a rotation.
      globals.__controlReadiness = () => ({ pipeName: "rotated-pipe" });
      await harness.reconnectHostControl(saved.context, index, TAB, OWNER, native);
      assert.deepEqual(provenKeys, [], "a rotation is not offered while the pinned server may still exist");
      assert.notEqual(state.controlFailure, null);

      probe = "absent";
      await harness.reconnectHostControl(saved.context, index, TAB, OWNER, native);
      assert.deepEqual(provenKeys, ["proven-native-key"], "a rotation is only offered against the key pinned for this launch");
      assert.equal(state.control?.client, rotatedClient);
      assert.equal(saved.secrets.get(`omp.hostControl.key.${owner}`), "rotated-key", "the proven rotation is pinned");

      // The host stops answering and publishes nothing: one clear line, with a way out.
      rotatedClient.close();
      globals.__controlReadiness = () => { t.mock.timers.tick(20_000); return null; };
      await harness.reconnectHostControl(saved.context, index, TAB, OWNER, native);
      assert.equal(state.control, null);
      assert.match(state.controlFailure ?? "", /^Host control lost: .* Reload the session to restore them\.$/);
      assert.doesNotMatch(state.controlFailure ?? "", /\n|has not published/);

      // Not sticky: as soon as the host's server answers the proven key, the state clears.
      probe = "attached";
      await harness.reconnectHostControl(saved.context, index, TAB, OWNER, native);
      assert.equal(harness.state(TAB).control?.client, recoveredClient);
      assert.equal(harness.state(TAB).controlFailure, null);
    } finally {
      delete globals.__controlReadiness;
      rotatedClient.close(); recoveredClient.close();
    }
  });

  it("never resurrects a stopped process's key when its snapshot finishes after a successor took the tab", async () => {
    const saved = storage(); const old = runtime(303); const successor = runtime(404); const index = indexFixture(old);
    harness.reset(index, conversation({ phase: "live", start: async () => undefined }));
    harness.state(TAB).runtime = old;
    const pendingSnapshot = Promise.withResolvers<unknown>();
    const readStarted = Promise.withResolvers<void>();
    const oldClient = client(pendingSnapshot.promise);
    harness.controlClient.connectVerified = async () => {
      readStarted.resolve(); return { client: oldClient, key: "retired-key" };
    };
    const pending = harness.establishControl(saved.context, index, TAB, OWNER, { runtime: old, pid: old.pid }, { directory: root, slotId: "old-slot" });
    await readStarted.promise;
    await index.lifecycle.run(TAB, async () => {
      harness.state(TAB).runtime = successor;
      saved.secrets.set(KEY, "successor-key");
    });
    pendingSnapshot.resolve(snapshot); await pending;
    assert.equal(saved.secrets.get(KEY), "successor-key");
    assert.equal(oldClient.closed, true);
    assert.equal(harness.state(TAB).control, null);
  });

  it("panel route handshakes quiesce and replacement still fences the old writer", async () => {
    const saved = storage(); const native = runtime(828); const index = indexFixture(native);
    const endpoint = new BridgeEditorEndpoint({
      records: new BridgeRecords({ root: path.join(root, "route-loop"), secrets: saved.context.secrets }),
      scope: { workspace: "a".repeat(64), tabId: TAB, editorId: EDITOR },
      hostGeneration: harness.hostGeneration(), eligible: () => true,
      onRequest: () => assert.fail("this panel handshake must not dispatch on the standby bridge"),
    });
    resources.push(endpoint);
    assert.ok(await endpoint.beginDocument(DOCUMENT, "d".repeat(32)));
    const toHost: unknown[] = []; const toGuest: unknown[] = [];
    const panel = { webview: { postMessage: async (message: unknown) => { toGuest.push(message); return true; } } };
    harness.reset(index, null);
    harness.editor(index, endpoint, panel);
    const window = new EventTarget();
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    const previousApi = Object.getOwnPropertyDescriptor(globalThis, "acquireVsCodeApi");
    Object.defineProperty(globalThis, "window", { configurable: true, value: window });
    Object.defineProperty(globalThis, "acquireVsCodeApi", { configurable: true, value: () => ({
      postMessage: (message: unknown) => toHost.push(message),
    }) });
    try {
      // Exercise the actual guest receiver and host dispatcher, not an ACK echo fixture.
      // This loading boundary must see the injected window/API; a static import
      // would initialize the browser transport before those capabilities exist.
      const guest = (await import(`${pathToFileURL(fileURLToPath(new URL("./webview/bridge.ts", import.meta.url))).href}?route-loop`)).guestTransport;
      const route = endpoint.routeFor(DOCUMENT)!;
      const offer = () => ({
        type: "omp:route-offer", hostGeneration: Buffer.from(harness.hostGeneration()).toString("hex"),
        documentId: DOCUMENT, routeGeneration: endpoint.offerPanel(), status: route.status(),
      });
      const drain = async (): Promise<void> => {
        let rounds = 0;
        while (toGuest.length !== 0 || toHost.length !== 0) {
          assert.ok(rounds++ < 12, "a completed panel handshake must not spin in offer/ACK round trips");
          for (const message of toGuest.splice(0)) window.dispatchEvent(new MessageEvent("message", { data: message }));
          for (const message of toHost.splice(0)) await harness.handleGuestMessage(index, EDITOR, panel, message);
        }
      };
      const first = offer();
      assert.equal(route.dispatchable, false);
      window.dispatchEvent(new MessageEvent("message", { data: first }));
      toHost.length = 0; // The transport loses the first ACK; the host may re-deliver.
      assert.equal(route.dispatchable, false);
      toGuest.push(first); await drain();
      assert.equal(guest.routeKind(), "panel");
      assert.equal(route.dispatchable, true);
      const writer = route.admit({ routeGeneration: first.routeGeneration, actionSeq: "1", operation: "set-model", payload: {} });
      // A ready-status refresh must not restart the completed handshake.
      toGuest.push({ ...first, status: "ready" }); await drain();
      writer.verify();
      const replacement = offer();
      assert.notEqual(replacement.routeGeneration, first.routeGeneration);
      assert.equal(route.dispatchable, false);
      assert.throws(() => writer.verify(), { code: "no-route" });
      writer.settle("refused");
      toHost.push({ ...first, type: "omp:route-ack" });
      await drain();
      assert.equal(route.dispatchable, false, "a fenced ACK cannot enable the replacement");
      toGuest.push(replacement); await drain();
      assert.equal(route.dispatchable, true);
      const nextWriter = route.admit({ routeGeneration: replacement.routeGeneration, actionSeq: "2", operation: "set-model", payload: {} });
      nextWriter.verify(); nextWriter.settle("applied");
    } finally {
      if (previousWindow === undefined) Reflect.deleteProperty(globalThis, "window");
      else Object.defineProperty(globalThis, "window", previousWindow);
      if (previousApi === undefined) Reflect.deleteProperty(globalThis, "acquireVsCodeApi");
      else Object.defineProperty(globalThis, "acquireVsCodeApi", previousApi);
      endpoint.close();
    }
  });

  it("Resume renews the existing editor's native capability and that page dispatches after host-only restart", async () => {
    const saved = storage(); const old = runtime(505); const resumed = runtime(606); const index = indexFixture(resumed);
    const scope = { workspace: "a".repeat(64), tabId: TAB, editorId: EDITOR };
    const records = new BridgeRecords({ root: path.join(root, "bridge"), secrets: saved.context.secrets });
    let admitted = 0;
    const createEndpoint = (generation: number) => {
      const endpoint = new BridgeEditorEndpoint({ records, scope, hostGeneration: new Uint8Array(16).fill(generation),
        eligible: () => true, onRequest: (peer, _documentId, request) => { admitted++; peer.reply(request.requestId, { accepted: true }); } });
      resources.push(endpoint); return endpoint;
    };
    const first = createEndpoint(1);
    const port = await first.bind(); assert.notEqual(port, null);
    await first.beginDocument(DOCUMENT, "d".repeat(32)); first.pinOrigin(DOCUMENT, ORIGIN);
    assert.notEqual(await first.commit(nativeBinding(old)), null);
    harness.reset(index, conversation({ phase: "live", start: async () => undefined }));
    const panel = { viewType: "omp.session", webview: { html: "old document", cspSource: "vscode-webview://test", asWebviewUri: (uri: unknown) => uri, postMessage: async () => true } };
    const state = harness.editor(index, first, panel);
    (globalThis as typeof globalThis & { __nativeLaunch: unknown }).__nativeLaunch = { state: "running", runtime: resumed, reason: "fixture launched" };
    harness.controlClient.connectVerified = async () => ({ client: client(Promise.resolve(snapshot)), key: "resumed-key" });
    assert.equal((await harness.launchHost(saved.context, index, { tabId: TAB, sessionFile: resumed.sessionFile, sessionId: "session-1", cwd: root, scope: index.row.scope, ownerGeneration: OWNER, claimPath: "" })).state, "running");
    const documentId = state.bridge!.documentId;
    assert.notEqual(documentId, DOCUMENT, "a new native process requires a fresh document capability");
    assert.equal(await records.readSecret(scope, DOCUMENT), null, "the old child's document credential is retired");
    first.pinOrigin(documentId, ORIGIN);
    await harness.commitBridgeDocument(TAB);
    const delivery = await first.delivery(); assert.ok(delivery);
    assert.equal(bindingMatches(first.committedBinding()!, nativeBinding(resumed)), true);
    assert.equal(first.committedBinding()?.sessionFile, old.sessionFile, "Resume preserves the exact transcript");

    first.close();
    const restarted = createEndpoint(2);
    assert.equal(await restarted.bind(), port);
    assert.ok(await restarted.adoptDocument(documentId));
    restarted.nativeReady(bindingMatches(restarted.committedBinding()!, nativeBinding(resumed)));
    restarted.offerBridge();
    const route = Promise.withResolvers<string>(); const reply = Promise.withResolvers<unknown>();
    const NodeSocket = WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => WebSocket;
    const page = new BridgeClient({ workspace: scope.workspace, tabId: TAB, editorId: EDITOR, documentId, port: port!, origin: ORIGIN,
      bindingHash: delivery.bindingHash, secret: delivery.secret, connect: url => new NodeSocket(url, { headers: { origin: ORIGIN } }) },
      { onRouteOffer: generation => route.resolve(generation), onReply: (_id, payload) => reply.resolve(payload),
        onInvalidate: () => undefined, onConnection: () => undefined });
    pages.push(page); page.start(); const generation = await bounded(route.promise); page.acknowledgeRoute(generation);
    assert.equal(page.request({ routeGeneration: generation, requestId: "7".repeat(32), actionSeq: "1", operation: "chat-prompt", payload: { text: "GAMMA" } }), true);
    assert.deepEqual(await bounded(reply.promise), { accepted: true });
    assert.equal(admitted, 1, "the successor native binding dispatches exactly once after restart");
  });

  for (const acknowledgement of ["before", "after", "replacement"] as const) {
    it(`Close → view-only → page Resume → first host restart delivers GAMMA with ${acknowledgement} bridge acknowledgement`, async () => {
      const saved = storage(); const native = runtime(707); const baseIndex = indexFixture(native);
      const launched = Promise.withResolvers<void>();
      const index = { ...baseIndex, restore: async (_tabId: string, options: {
        allowStoppedResume: boolean;
        launcher: { launch(request: unknown): Promise<{ state: string; host?: { pid: number } }> };
      }) => {
        if (!options.allowStoppedResume) return { status: "stopped", detail: "This session is stopped." };
        const outcome = await options.launcher.launch({ tabId: TAB, sessionFile: native.sessionFile, sessionId: "session-1",
          cwd: root, scope: baseIndex.row.scope, ownerGeneration: OWNER, claimPath: "" });
        assert.equal(outcome.state, "running");
        baseIndex.row.runIntent = "running";
        baseIndex.row.availability = "live";
        baseIndex.row.host = { pid: outcome.host!.pid };
        launched.resolve();
        return { status: "restored" };
      } };
      const history = [
        messageEntry("u1", null, userMessage("ALPHA", 1000)),
        messageEntry("a1", "u1", assistantMessage("ALPHA answer", 1100)),
        messageEntry("u2", "a1", userMessage("RESUMED-A", 2000)),
        messageEntry("a2", "u2", assistantMessage("RESUMED-A answer", 2100)),
      ];
      await writeFile(native.sessionFile, sessionFileText({ id: "session-1", cwd: root, entries: history }));
      const makeRuntime = (hostNonce: string) => new ChatRuntime({
        hostNonce, onEvent: () => undefined, createSession: options => new RpcSession({ ...options, timers: new ManualTimers() }),
      });
      let bridge: BridgeClient | null = null;
      let generation = "";
      const rendered = new ChatClient({ post: message => {
        if (message.type === "omp:chat-resume") {
          void oldHost.handleMessage(TAB, message, null);
          return true;
        }
        if (message.type !== "omp:chat-prompt") return false;
        if (bridge === null) {
          void harness.runChatCommand(TAB, message, admissionPage);
          return true;
        }
        return bridge.request({ routeGeneration: generation, requestId: message.requestId, actionSeq: "1",
          operation: "chat-prompt", payload: { text: message.text } });
      } });
      const admissionPage: ChatPage = { id: "admission-origin", post: message => { rendered.handle(message); return "sent"; } };
      const oldHost = new ChatRuntime({ hostNonce: "old-host",
        onEvent: (tabId, event) => { if (event.type === "resume-requested") harness.handleChatEvent(saved.context, index, tabId, event); },
        createSession: options => new RpcSession({ ...options, timers: new ManualTimers() }),
      });
      oldHost.attachPage(TAB, { id: "previous-panel", post: message => { rendered.handle(message); return "sent"; } });
      const scope = { workspace: "a".repeat(64), tabId: TAB, editorId: EDITOR };
      const records = new BridgeRecords({ root: path.join(root, `epoch-${acknowledgement}`), secrets: saved.context.secrets });
      const first = new BridgeEditorEndpoint({ records, scope, hostGeneration: new Uint8Array(16).fill(1), eligible: () => true, onRequest: () => undefined });
      resources.push(first);
      const port = await first.bind(); assert.notEqual(port, null);
      await first.beginDocument(DOCUMENT, "d".repeat(32)); first.pinOrigin(DOCUMENT, ORIGIN);
      assert.ok(await first.commit(nativeBinding(native)));
      harness.reset(index, oldHost);
      const panel = { reveal() {}, viewType: "omp.session", webview: { html: "", cspSource: "vscode-webview://test",
        asWebviewUri: (uri: unknown) => uri, postMessage: async () => true } };
      const priorEditor = harness.editor(index, first, panel); priorEditor.runtime = native;
      let documentId: string;
      let delivery: BridgeBootstrapDelivery;
      let survivor: NativeFixture = native;
      try {
        const alphaHistory = history.slice(0, 2);
        await writeFile(native.sessionFile, sessionFileText({ id: "session-1", cwd: root, entries: alphaHistory }));
        const alphaChannel = new FakeRpcChannel({ sessionFile: native.sessionFile, sessionId: "session-1", entries: alphaHistory as never, leafId: "a1" });
        await bounded(oldHost.startLive(TAB, { channel: alphaChannel, sessionFile: native.sessionFile, cwd: root, title: null }).start());
        await harness.closeSession(saved.context, index, TAB);
        assert.equal(index.row.runIntent, "stopped");
        await harness.openTab(saved.context, index, TAB, "opened");
        // The production stopped-row Open reads JSONL asynchronously.
        if (rendered.getSnapshot().phase !== "view-only") {
          const painted = Promise.withResolvers<void>();
          const unsubscribe = rendered.subscribe(() => { if (rendered.getSnapshot().phase === "view-only") painted.resolve(); });
          try { await bounded(painted.promise); } finally { unsubscribe(); }
        }
        assert.equal(rendered.getSnapshot().phase, "view-only");
        const resumedChannel = new FakeRpcChannel({ sessionFile: native.sessionFile, sessionId: "session-1", entries: alphaHistory as never, leafId: "a1" });
        const resumed = { ...runtime(808), handle: Object.assign(resumedChannel, runtime(808).handle) };
        (globalThis as typeof globalThis & { __nativeLaunch: unknown }).__nativeLaunch = { state: "running", runtime: resumed, reason: "fixture resumed" };
        harness.controlClient.connectVerified = async () => ({ client: client(Promise.resolve(snapshot)), key: "resume-key" });
        assert.equal(rendered.resume(), true, "the actual page command must enter the extension's Resume admission");
        await bounded(launched.promise);
        await bounded(oldHost.sessionOf(TAB)!.start());
        assert.equal(rendered.getSnapshot().phase, "live");
        assert.deepEqual(await rendered.sendPrompt("RESUMED-A"), { ok: true });
        await nextTurn();
        assert.equal(resumedChannel.commandsOfType("prompt").at(-1)?.message, "RESUMED-A");
        resumedChannel.child.entries = history as never; resumedChannel.child.leafId = "a2";
        await writeFile(native.sessionFile, sessionFileText({ id: "session-1", cwd: root, entries: history }));
        resumedChannel.emitMessage("message_end", "resumed-user", userMessage("RESUMED-A", 2000) as never);
        resumedChannel.emitMessage("message_end", "resumed-answer", assistantMessage("RESUMED-A answer", 2100) as never);
        documentId = priorEditor.bridge!.documentId;
        assert.notEqual(documentId, DOCUMENT);
        first.pinOrigin(documentId, ORIGIN);
        await harness.commitBridgeDocument(TAB);
        const committed = await first.delivery(); assert.ok(committed); delivery = committed;
        assert.equal(bindingMatches(first.committedBinding()!, nativeBinding(resumed)), true);
        survivor = resumed;
        priorEditor.runtime = resumed;
      } finally { oldHost.dispose(); first.close(); }
      const oldEpoch = rendered.getSnapshot().epoch;
      const newHost = makeRuntime("new-host");
      const acknowledged = Promise.withResolvers<void>();
      const reply = Promise.withResolvers<unknown>();
      const receivedAnswer = Promise.withResolvers<void>();
      const freshLive = Promise.withResolvers<void>();
      const droppedSnapshot = Promise.withResolvers<void>();
      let disconnected = Promise.withResolvers<void>();
      let dropFirstLiveSnapshot = acknowledgement === "replacement";
      const restarted = new BridgeEditorEndpoint({ records, scope, hostGeneration: new Uint8Array(16).fill(2), eligible: () => true,
        onStateChanged: (_documentId, state) => {
          harness.attachChatRoute(EDITOR);
          if (state === "BRIDGE_READY" || state === "BRIDGE_AUTHENTICATED_WAITING") acknowledged.resolve();
          if (state === "DISCONNECTED") disconnected.resolve();
        },
        onRequest: (peer, _documentId, request) => {
          const payload = request.payload;
          assert.ok(payload !== null && typeof payload === "object" && "text" in payload);
          const message = parseChatWebviewMessage({ type: "omp:chat-prompt", requestId: request.requestId, text: payload.text });
          assert.ok(message?.type === "omp:chat-prompt");
          void harness.runChatCommand(TAB, message, receiptPage).then(outcome => peer.reply(request.requestId, { outcome }));
        },
      });
      const receiptPage: ChatPage = { id: "bridge-admission", post: message => restarted.pushTerminal(documentId, message) ? "sent" : "dropped" };
      resources.push(restarted);
      harness.reset(index, newHost);
      const state = harness.editor(index, restarted, null); state.runtime = survivor;
      state.bridge!.documentId = documentId;
      try {
        assert.equal(await restarted.bind(), port);
        assert.ok(await restarted.adoptDocument(documentId));
        const channel = new FakeRpcChannel({ sessionFile: native.sessionFile, sessionId: "session-1", entries: history as never, leafId: "a2" });
        const start = async () => {
          await bounded(newHost.startLive(TAB, { channel, sessionFile: native.sessionFile, cwd: root, title: null, initialSeq: 0 }).start());
          restarted.nativeReady(true);
        };
        if (acknowledgement === "after") await start();
        restarted.offerBridge();
        const NodeSocket = WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => WebSocket;
        const createBridge = () => new BridgeClient({ workspace: scope.workspace, tabId: TAB, editorId: EDITOR, documentId, port: port!, origin: ORIGIN,
          bindingHash: delivery.bindingHash, secret: delivery.secret, connect: url => new NodeSocket(url, { headers: { origin: ORIGIN } }) },
          { onRouteOffer: route => {
              generation = route; bridge!.acknowledgeRoute(route);
              bridge!.request({ routeGeneration: route, requestId: "9".repeat(32), actionSeq: "0", operation: "guest-version",
                payload: { protocolVersion: GUEST_PROTOCOL_VERSION, fragments: true } });
            },
            onReply: (id, result) => { if (id !== "9".repeat(32)) reply.resolve(result); }, onInvalidate: () => undefined, onConnection: () => undefined,
            onMessage: payload => {
              const message = parseGuestHostMessage(payload); assert.ok(message);
              // A real socket loss between disk paint and the authoritative live snapshot:
              // the surviving ChatClient stays mounted, while this connection is discarded.
              if (dropFirstLiveSnapshot && message.type === "omp:chat-snapshot" && message.head.phase === "live") {
                bridge!.stop(); droppedSnapshot.resolve(); return;
              }
              rendered.handle(message);
              if (rendered.getSnapshot().phase === "live" && rendered.getSnapshot().epoch?.nonce === newHost.modelOf(TAB)?.epoch?.nonce
                && rendered.getSnapshot().epoch?.counter === newHost.modelOf(TAB)?.epoch?.counter) freshLive.resolve();
              if (message.type === "omp:chat-event" && message.frame.type === "message_end" && message.frame.messageId === "gamma-answer") receivedAnswer.resolve();
            },
          });
        bridge = createBridge(); pages.push(bridge); bridge.start(); await bounded(acknowledged.promise);
        if (acknowledgement === "replacement") disconnected = Promise.withResolvers<void>();
        if (acknowledgement !== "after") await start();
        if (acknowledgement === "replacement") {
          await bounded(droppedSnapshot.promise);
          await bounded(disconnected.promise);
          assert.equal(rendered.getSnapshot().epoch?.nonce, newHost.modelOf(TAB)?.epoch?.nonce, "disk paint arrived on the first connection");
          assert.notDeepEqual(rendered.getSnapshot().epoch, newHost.modelOf(TAB)?.epoch, "the complete live snapshot was interrupted");
          dropFirstLiveSnapshot = false;
          bridge = createBridge(); pages.push(bridge); bridge.start();
        }
        await bounded(freshLive.promise);

        assert.deepEqual(await rendered.sendPrompt("GAMMA-A"), { ok: true });
        assert.deepEqual(await bounded(reply.promise), { outcome: "accepted" });
        assert.equal(channel.commandsOfType("prompt").at(-1)?.message, "GAMMA-A");
        const answer = assistantMessage("GAMMA-A answer", 3100);
        const updatedHistory = [...history, messageEntry("u3", "a2", userMessage("GAMMA-A", 3000)), messageEntry("a3", "u3", answer)];
        channel.child.entries = updatedHistory as never; channel.child.leafId = "a3";
        await writeFile(native.sessionFile, sessionFileText({ id: "session-1", cwd: root, entries: updatedHistory }));
        channel.emitMessage("message_end", "gamma-user", userMessage("GAMMA-A", 3000) as never);
        channel.emitMessage("message_end", "gamma-answer", answer as never);
        await bounded(receivedAnswer.promise);
        assert.deepEqual(rendered.getSnapshot().epoch, newHost.modelOf(TAB)?.epoch, "the authoritative snapshot must replace the surviving page's old epoch");
        assert.notDeepEqual(rendered.getSnapshot().epoch, oldEpoch);
        const messages = rendered.getSnapshot().entries.flatMap(entry => entry.type === "message" ? [entry.message] : []);
        assert.deepEqual(messages.map(message => "content" in message ? message.content : null), updatedHistory.map(entry => entry.type === "message" && "content" in entry.message ? entry.message.content : null));
      } finally { bridge?.stop(); restarted.close(); newHost.dispose(); }
    });
  }
});

describe("verified-owned-writer policy fixtures", () => {
  async function legacyFixture(name: string, live: boolean, materialized: boolean) {
    const fixtureRoot = await mkdtemp(path.join(root, `${name}-`));
    const claimDir = path.join(fixtureRoot, "claims");
    const file = materialized ? path.join(fixtureRoot, "session.jsonl") : null;
    if (file !== null) await writeFile(file, JSON.stringify({ type: "session", version: 3, id: name, cwd: fixtureRoot, timestamp: "2026-09-29T10:25:25Z" }) + "\n");
    const identity = file ?? `draft:${name}`;
    const values = new Map<string, unknown>();
    values.set("omp.sessionIndex.v1", {
      version: 1, activeTabId: TAB, nextOrdinal: 3,
      entries: [{
        tabId: TAB, origin: "extension", sessionFile: file, sessionId: name, cwd: fixtureRoot,
        scope: { profile: null, sessionDir: null }, sessionDir: null,
        ownership: { ownerGeneration: OWNER, draftIdentity: file === null ? identity : null, releasedAt: null },
        host: { pid: live ? 51704 : 31000, instanceId: null, generation: null, sessionId: name, startedAt: "2026-09-29T10:25:25Z" },
        createdAt: "2026-09-29T10:25:25Z", lastActiveAt: "2026-09-29T10:25:25Z",
        ordinal: live ? 1 : 2, availability: "owner-unknown", runIntent: live ? "running" : "stopped",
      }],
    });
    await harness.acquireClaim(claimDir, identity, OWNER, harness.createClaimHolder(4194303));
    const index = new harness.SessionIndex({ claimStorageDir: claimDir, store: {
      get<T>(key: string) { return values.get(key) as T | undefined; },
      async update(key: string, value: unknown) { values.set(key, value); },
    } });
    let writerAlive = live;
    const operations: string[] = [];
    const ports = {
      readProcessIdentity: async () => ({ kind: "gone" }), isProcessAlive: () => false,
      brokerSlot: () => "host:legacy-fixture", brokerProvenance: () => ({ kind: "slot", slot: "host:legacy-fixture" }),
      probeRpc: async () => ({ kind: "unreachable", reason: "dead fixture broker" }),
      probeBrokerSlot: async () => writerAlive ? { kind: "live", pid: 51704 } : { kind: "failed", reason: "dead broker, gone pid" },
      hasTerminal: async () => false,
    };
    const stopPort = { stopRecordedHost: async () => {
      assert.equal(index.get(TAB)?.runIntent, "stopped", "stopped intent precedes broker dispatch");
      operations.push("stop legacy child and shutdown broker");
      writerAlive = false;
      return { kind: "stopped", writerGone: true, treeEmpty: true, detail: "verified fixture writer exited; empty broker shut down", slot: "host:legacy-fixture" };
    } };
    const hostLauncher = {
      launch: async (request: { sessionFile: string | null }) => {
        assert.equal(writerAlive, false, "never launch over the verified legacy child");
        assert.equal(request.sessionFile, file);
        operations.push("launch rpc");
        return { state: "running", host: { pid: 60001, sessionId: name, rpc: null } };
      },
      attach: async () => { throw new Error("legacy fixture must not attach"); },
    };
    const runtime = new ChatRuntime({ hostNonce: name, onEvent() {} });
    harness.reset(index, runtime);
    const dialogs = harness.policy(storage().context, ports, hostLauncher, stopPort);
    return { index, file, dialogs, operations, runtime };
  }

  it("dead broker + gone pid + stale claim is an ordinary usable draft, and Resume launches without a recovery ceremony", async () => {
    const f = await legacyFixture("dead-draft", false, false);
    try {
      const facts = await harness.launcherOwnershipFacts(f.index, TAB);
      assert.equal(harness.rowState(f.index.get(TAB), facts), "draft");
      const binding = await f.index.bindEditorSlot(EDITOR, TAB, "controlling");
      assert.equal(binding.role, "controlling", "draft editor is usable, not permanently passive");
      const client = new ChatClient({ post: () => true });
      f.runtime.attachPage(TAB, { id: "unowned-draft-page", post: message => { client.handle(message); return "sent"; } });
      await harness.handleRestoreOutcome(storage().context, f.index, TAB, { status: "draft", tabId: TAB, detail: "No live writer is verified." });
      assert.equal(client.getSnapshot().phase, "view-only", "unowned draft is not a legacy dead-end page");
      assert.equal(client.resume(), true, "the restored page offers ordinary Resume");
      await harness.renameSession(storage().context, f.index, TAB);
      assert.equal(f.index.get(TAB)?.title, "Recovered draft title");
      await harness.openTab(storage().context, f.index, TAB, "resumed");
      assert.deepEqual(f.operations, ["launch rpc"]);
      assert.deepEqual(f.dialogs, [], "no release or uncertainty confirmation");
    } finally { f.runtime.dispose(); await f.index.closeSession(TAB, { confirmedStopped: true }); }
  });

  /** A stand-in for the lease observer: reports exactly what a terminal omp would make the real probe see. */
  function leaseObserver(state: { held: boolean | null; fresh: number }) {
    return { holds: async (_file: string, options?: { fresh?: boolean }) => { if (options?.fresh === true) state.fresh++; return state.held; } };
  }

  it("asks before launching a session a plain terminal omp writes: Cancel starts nothing, Open Anyway launches it, and a restore never asks", async () => {
    const f = await legacyFixture("terminal-writer", false, true);
    const lease = { held: true as boolean | null, fresh: 0 };
    harness.setExternalLeases(leaseObserver(lease));
    try {
      const facts = await harness.launcherOwnershipFacts(f.index, TAB);
      assert.equal(facts.externalOmp, true);
      assert.equal(harness.rowState(f.index.get(TAB), facts), "externalOmp");
      const asked: { message: string; detail: string | undefined }[] = [];
      harness.warning(async (message, options) => { asked.push({ message: String(message), detail: (options as { detail?: string } | undefined)?.detail }); return undefined; });
      await harness.openTab(storage().context, f.index, TAB, "resumed");
      assert.deepEqual(f.operations, [], "Cancel launches nothing");
      assert.equal(asked.length, 1);
      assert.equal(asked[0]!.message, "This session is open in another OMP process.");
      assert.match(asked[0]!.detail ?? "", /new sibling file/);
      assert.equal(lease.fresh, 1, "the open asked for a verdict newer than the click");
      harness.warning(async (_message, _options, action) => action);
      await harness.openTab(storage().context, f.index, TAB, "resumed");
      assert.deepEqual(f.operations, ["launch rpc"], "Open Anyway is the user's launch");
    } finally { harness.setExternalLeases(null); f.runtime.dispose(); await f.index.closeSession(TAB, { confirmedStopped: true }); }
  });

  it("never asks for a restored editor, a history view or when the probe cannot tell", async () => {
    const f = await legacyFixture("quiet-restore", false, true);
    const lease = { held: true as boolean | null, fresh: 0 };
    harness.setExternalLeases(leaseObserver(lease));
    try {
      const asked: unknown[] = [];
      harness.warning(async message => { asked.push(message); return undefined; });
      await harness.openTab(storage().context, f.index, TAB, "opened", "restored");
      await harness.openTab(storage().context, f.index, TAB, "opened");
      assert.deepEqual(asked, [], "no writer is started by either, so nothing to ask");
      lease.held = null;
      harness.warning(async (_message, _options, action) => action);
      await harness.openTab(storage().context, f.index, TAB, "resumed");
      assert.deepEqual(f.operations, ["launch rpc"], "an unknown lease is today's behavior: no dialog, launch");
    } finally { harness.setExternalLeases(null); f.runtime.dispose(); await f.index.closeSession(TAB, { confirmedStopped: true }); }
  });

  it("asks for a plain Open too when the row's run intent is not stopped, and not when it is", async () => {
    const f = await legacyFixture("open-running-intent", false, true);
    harness.setExternalLeases(leaseObserver({ held: true, fresh: 0 }));
    try {
      await f.index.setRunIntent(TAB, "running");
      const asked: unknown[] = [];
      harness.warning(async message => { asked.push(message); return undefined; });
      await harness.openTab(storage().context, f.index, TAB, "opened");
      assert.equal(asked.length, 1, "an Open that may launch a writer asks first");
      assert.deepEqual(f.operations, [], "Cancel starts nothing");
    } finally { harness.setExternalLeases(null); f.runtime.dispose(); await f.index.closeSession(TAB, { confirmedStopped: true }); }
  });

  it("lets another window's live claim win over the lease: that row is Open in another window, never an external process", async () => {
    const claimDir = path.join(root, "claims-rival-terminal");
    const values = new Map<string, unknown>();
    const index = new harness.SessionIndex({ claimStorageDir: claimDir, store: {
      get<T>(key: string) { return values.get(key) as T | undefined; },
      async update(key: string, value: unknown) { values.set(key, value); },
    } });
    const file = path.join(root, "rival-and-terminal.jsonl");
    await writeFile(file, JSON.stringify({ type: "session", version: 3, id: "rival-and-terminal", timestamp: "2026-09-30T10:00:00Z", cwd: root }) + "\n");
    const row = await index.trackSession({ sessionFile: file, cwd: root });
    const rival = await harness.acquireClaim(claimDir, file, "remote-window-owner", harness.createClaimHolder());
    harness.reset(index, { stateOf: () => null });
    harness.setExternalLeases(leaseObserver({ held: true, fresh: 0 }));
    try {
      const facts = await harness.launcherOwnershipFacts(index, row.tabId);
      assert.equal(facts.heldElsewhere, true);
      assert.equal(facts.externalOmp, false, "the other window's children hold leases too, so the claim names the holder");
      assert.equal(harness.rowState(index.get(row.tabId), facts), "otherWindow");
    } finally { await rival.release(); harness.setExternalLeases(null); }
  });

  it("asks on a click of an 'externalOmp' row, rechecks first, and explains nothing when the terminal has exited", async () => {
    const f = await legacyFixture("click-terminal", false, true);
    const lease = { held: true as boolean | null, fresh: 0 };
    harness.setExternalLeases(leaseObserver(lease));
    const provider = new harness.SessionTreeProvider({
      folders: () => [{ id: "folder:click", path: f.index.get(TAB)!.cwd, collapsed: false, pinned: true, open: false }],
      entries: () => f.index.list(),
      activeTabId: () => null,
      facts: () => ({ open: false, running: false, outcome: null, activity: null }),
      runtimeIdentity: () => null,
      observeOwnership: tabId => harness.launcherOwnershipFacts(f.index, tabId),
    });
    harness.notificationTree(provider, undefined);
    try {
      for (;;) {
        const repainted = Promise.withResolvers<void>();
        const subscription = provider.onDidChangeTreeData(() => repainted.resolve());
        try {
          provider.getChildren(provider.getChildren()[0]);
          if (provider.displayedState(TAB) === "externalOmp") break;
          await bounded(repainted.promise);
        } finally { subscription.dispose(); }
      }
      const asked: string[] = [];
      harness.warning(async message => { asked.push(String(message)); return undefined; });
      await harness.openSession(storage().context, f.index, { tabId: TAB }, "opened");
      assert.deepEqual(asked, ["This session is open in another OMP process."]);
      assert.deepEqual(f.operations, [], "a click on a row another process writes launches nothing without the answer");
      harness.warning(async (_message, _options, action) => action);
      await harness.openSession(storage().context, f.index, { tabId: TAB }, "opened");
      assert.deepEqual(f.operations, ["launch rpc"], "Open Anyway after a click is an explicit launch");
    } finally { provider.dispose(); harness.notificationTree(undefined, undefined); harness.setExternalLeases(null); f.runtime.dispose(); }
  });

  it("an unowned legacy draft can be Forgotten immediately, and an unowned materialized row can be Deleted with only exact-path confirmation", async () => {
    const draft = await legacyFixture("forget-dead", false, false);
    const notifications: unknown[] = [];
    harness.information(async (...args) => { notifications.push(args); });
    try {
      await harness.forgetSession(draft.index, TAB);
      assert.equal(draft.index.get(TAB), null);
      assert.deepEqual(notifications, [], "Forget is visible in the tree and does not emit a completion toast");
    }
    finally { draft.runtime.dispose(); }
    const saved = await legacyFixture("delete-dead", false, true);
    try {
      saved.index.observeOwnershipOfFile = async () => ({ ok: false, detail: "Fixture claim storage is unreadable." });
      assert.equal(await harness.confirmAndDeleteSession(saved.index, TAB), true);
      assert.equal(saved.index.get(TAB), null);
      await assert.rejects(readFile(saved.file!), { code: "ENOENT" });
      assert.equal(saved.dialogs.length, 1);
      assert.equal(saved.dialogs[0]!.detail!.includes(saved.file!), false, "filesystem paths stay out of the modal");
      assert.equal(saved.dialogs[0]!.detail!.split(/[.!?]\s+/).length <= 2, true);
      assert.deepEqual(saved.operations, []);
    } finally { saved.runtime.dispose(); }
  });

  it("cancelling Delete leaves history and index unchanged without a redundant notification", async () => {
    const f = await legacyFixture("cancel-delete", false, true);
    const before = await readFile(f.file!, "utf8");
    const notifications: unknown[] = [];
    harness.warning(async () => undefined);
    harness.information(async message => { notifications.push(message); });
    try {
      assert.equal(await harness.confirmAndDeleteSession(f.index, TAB), false);
      assert.ok(f.index.get(TAB));
      assert.equal(await readFile(f.file!, "utf8"), before);
      assert.deepEqual(f.operations, []);
      assert.deepEqual(notifications, []);
    } finally { f.runtime.dispose(); }
  });

  it("Open of a verified legacy writer after restart confirms its stop before launching on the same file", async () => {
    const f = await legacyFixture("live-open-after-restart", true, true);
    try {
      const facts = await harness.launcherOwnershipFacts(f.index, TAB);
      assert.equal(harness.rowState(f.index.get(TAB), facts), "running");
      await harness.openTab(storage().context, f.index, TAB, "opened");
      assert.deepEqual(f.operations, ["stop legacy child and shutdown broker", "launch rpc"]);
      assert.equal(f.dialogs.length, 1);
    } finally { f.runtime.dispose(); await f.index.closeSession(TAB, { confirmedStopped: true }); }
  });

  it("Reload without a verified live editor refuses replacement and preserves the existing recorded writer", async () => {
    const f = await legacyFixture("live-legacy-reload", true, true);
    try {
      await harness.reloadSession(storage().context, f.index, TAB);
      assert.deepEqual(f.operations, []);
      assert.equal(f.index.get(TAB)?.runIntent, "running");
      assert.equal(f.index.get(TAB)?.host?.pid, 51704);
    } finally { f.runtime.dispose(); await f.index.closeSession(TAB, { confirmedStopped: true }); }
  });

  it("the verified live legacy child is Running and launcher Open confirms its exact pid once before replacement", async () => {
    const f = await legacyFixture("live-resume", true, true);
    try {
      const facts = await harness.launcherOwnershipFacts(f.index, TAB);
      assert.equal(facts.legacyWriter, true);
      assert.equal(harness.rowState(f.index.get(TAB), facts), "running");
      await harness.openTab(storage().context, f.index, TAB, "resumed");
      assert.deepEqual(f.operations, ["stop legacy child and shutdown broker", "launch rpc"]);
      assert.equal(f.dialogs.length, 1);
    } finally { f.runtime.dispose(); await f.index.closeSession(TAB, { confirmedStopped: true }); }
  });

  it("the verified live legacy child offers one stop-and-delete confirmation, preserving exact-path scope", async () => {
    const f = await legacyFixture("live-delete", true, true);
    try {
      assert.equal(await harness.confirmAndDeleteSession(f.index, TAB), true);
      assert.deepEqual(f.operations, ["stop legacy child and shutdown broker"]);
      assert.equal(f.dialogs.length, 1);
      assert.equal(f.dialogs[0]!.action, "Delete");
      assert.equal(f.index.get(TAB), null);
      await assert.rejects(readFile(f.file!), { code: "ENOENT" });
    } finally { f.runtime.dispose(); }
  });
});

describe("same-editor Chat and native Terminal actions", () => {
	function terminalRuntime(pid: number, file: string | null, cwd: string) {
		const native = runtime(pid);
		let owner: string | null = null;
		let streamAttached = false;
		let cols = 80, rows = 24, position = 0;
		let screen = "Native successor ready\r\n";
		const writes: string[] = [];
		const listeners = new Set<(event: { type: "output"; fromPosition: number; data: string }) => void>();
		return {
			...native, kind: "terminal" as const, sessionFile: file, cwd, observed: null, stopping: false, observedSurvivors: [],
			writes,
			output(data: string) {
				const fromPosition = position; position += Buffer.byteLength(data); screen += data;
				if (streamAttached) for (const listener of listeners) listener({ type: "output", fromPosition, data });
			},
			handle: {
				...native.handle,
				get state() { return native.handle.state; },
				nativePid: pid, record: { brokerId: native.identity.brokerId, generation: native.identity.brokerGeneration },
				async refreshStatus() {
					return { ...await native.handle.refreshStatus(), exitCode: null, signal: null, cols, rows, alt: false,
						title: "Native fixture", outputPosition: position, oldestPosition: 0, notices: [], inputOwner: owner };
				},
				async snapshot() { return { meta: { position, cols, rows, alt: false, truncated: false, cursorX: 0, cursorY: 0, cursorVisible: true }, data: screen }; },
				async attach() { streamAttached = true; },
				subscribe(listener: (event: { type: "output"; fromPosition: number; data: string }) => void) {
					listeners.add(listener); return () => { listeners.delete(listener); };
				},
				async claimInput(frontendId: string) { const previous = owner; owner = frontendId; return { type: "input-owner" as const, frontendId: owner, previous }; },
				async releaseInput(frontendId: string) { if (owner === frontendId) owner = null; },
				async write(data: string, frontendId: string) { assert.equal(frontendId, owner); writes.push(data); },
				async resize(nextCols: number, nextRows: number, frontendId: string) { assert.equal(frontendId, owner); cols = nextCols; rows = nextRows; },
			},
		};
	}

	async function fixture(fileless = false, mode: "chat" | "terminal" = "chat", publishNative = false, recoveryTimers?: ManualTimers) {
		const saved = storage();
		const directory = await mkdtemp(path.join(root, "mode-"));
		const file = fileless ? null : path.join(directory, "session.jsonl");
		if (file !== null) await writeFile(file, sessionFileText({ id: "mode-session", cwd: directory, entries: [] }));
		const values = new Map<string, unknown>();
		const index = new harness.SessionIndex({ claimStorageDir: path.join(directory, "claims"), store: {
			get<T>(key: string) { return values.get(key) as T | undefined; },
			async update(key: string, value: unknown) { values.set(key, value); },
		} });
		const row = file === null ? await index.createDraft({ cwd: directory }) : await index.trackSession({ sessionFile: file, cwd: directory });
		const native = { ...runtime(41001), kind: mode, sessionFile: file, cwd: directory, observed: null, stopping: false, observedSurvivors: [] as readonly number[] };
		const host = { pid: native.pid, sessionId: "mode-session", transport: mode === "terminal" ? "native" as const : "rpc" as const,
			rpc: { ...native.identity, brokerPid: 40000, brokerCreationTime: "broker-creation", childPid: native.pid } };
		await index.restore(row.tabId, { reconciler: { reconcile: async () => ({ kind: "free", evidence: [{ kind: "no-recorded-host" }] }) },
			launcher: { launch: async () => ({ state: "running", host }), attach: async () => ({ state: "unavailable", reason: "not needed" }) } });
		await index.bindEditorSlot(recoveryTimers === undefined ? row.tabId : EDITOR, row.tabId, "controlling");
		const channel = new FakeRpcChannel({ sessionFile: file, sessionId: "mode-session" });
		const chat = new ChatRuntime({ hostNonce: path.basename(directory), onEvent() {},
			...(recoveryTimers === undefined ? {} : { createSession: (options: ConstructorParameters<typeof RpcSession>[0]) => new RpcSession({ ...options, timers: recoveryTimers, commandTimeoutMs: 10, autoRecoveryDelaysMs: [] }) }),
		});
		await chat.startLive(row.tabId, { channel, sessionFile: file, cwd: directory, title: null }).start();
		if (mode === "terminal") chat.release(row.tabId);
		harness.reset(index, chat);
		let launches = 0;
		let successor: ReturnType<typeof terminalRuntime> | null = null;
		const panels = { visible: true, reveals: 0, disposed: false, messages: [] as unknown[], reveal() { this.reveals++; }, dispose() { this.disposed = true; },
			viewType: "omp.session", webview: { html: "", cspSource: "vscode-webview://test", asWebviewUri: (uri: unknown) => uri,
				postMessage: async (message: unknown) => { panels.messages.push(message); return true; } } };
		let endpoint: BridgeEditorEndpoint | null = null;
		if (recoveryTimers !== undefined && file !== null) {
			endpoint = new BridgeEditorEndpoint({
				records: new BridgeRecords({ root: path.join(directory, "bridge"), secrets: saved.context.secrets }),
				scope: { workspace: "a".repeat(64), tabId: row.tabId, editorId: EDITOR },
				hostGeneration: harness.hostGeneration(), eligible: () => true, onRequest() {},
			});
			resources.push(endpoint);
			assert.ok(await endpoint.bind());
			assert.ok(await endpoint.beginDocument(DOCUMENT, "d".repeat(32)));
			endpoint.pinOrigin(DOCUMENT, ORIGIN);
			assert.ok(await endpoint.commit({ ...nativeBinding({ ...native, sessionFile: file }), ownerGeneration: index.get(row.tabId)!.ownership!.ownerGeneration, sessionId: "mode-session" }));
		}
		const state = endpoint === null ? harness.state(row.tabId) : harness.editor(index, endpoint, panels, EDITOR, row.tabId);
		state.panel = panels; state.runtime = native; state.mode = mode;
		const dialogs = harness.policy(saved.context, {
			readProcessIdentity: async () => ({ kind: "gone" }), isProcessAlive: () => false,
			probeRpc: async () => ({ kind: "unreachable", reason: "gone" }), brokerProvenance: () => ({ kind: "none" }),
		}, { launch: async (request: { transport: string; sessionFile: string | null; sessionId: string | null }) => {
			launches++;
			assert.equal((await native.handle.refreshStatus()).state, "exited", "successor cannot overlap the old root");
			assert.equal(request.sessionFile, file);
			const next = publishNative && request.transport === "native"
				? successor = terminalRuntime(41001 + launches, file, directory)
				: { ...runtime(41001 + launches), sessionFile: file, cwd: directory, kind: request.transport === "native" ? "terminal" : "chat" };
			if (publishNative) {
				await harness.handleTerminalGuestMessage(row.tabId, { type: "omp:terminal-attach" }, { generation: null, cols: 80, rows: 24 });
				await harness.startConversation(index, row.tabId, next, file, false);
			} else state.runtime = next;
			return { state: "running", host: { ...host, pid: next.pid, rpc: { ...next.identity, brokerPid: 40000, brokerCreationTime: "broker-creation", childPid: next.pid },
				transport: request.transport, sessionId: request.sessionId ?? "fresh-mode-session" } };
		}, attach: async () => ({ state: "unavailable", reason: "not needed" }) }, {});
		return { saved, directory, file, row, index, values, native, channel, chat, state, panels, dialogs, launches: () => launches, successor: () => successor };
	}

	interface NativeControlFixture {
		file: string | null;
		directory: string;
		native: { exit(): void };
		state: State;
	}

	function nativeControl(f: NativeControlFixture, native: { exit(): void } = f.native) {
		const facts = { available: true, sessionFile: f.file, sessionId: "mode-session", cwd: f.directory, name: null as string | null, settled: true, hasContent: false, unavailableReason: null };
		const shutdowns: { target: unknown; consent: boolean }[] = [];
		const control = {
			...client(Promise.resolve({ host: { epoch: "native-fixture-epoch" } })),
			nativeState: async () => facts,
			nativeShutdown: async (target: unknown, consent: boolean) => { shutdowns.push({ target, consent }); native.exit(); return "accepted"; },
			nativeRename: async (_target: unknown, name: string) => { facts.name = name; return "renamed"; },
		};
		f.state.control = { client: control, snapshot: null };
		return { facts, shutdowns, control };
	}

	async function wedgedChat(captureComplete = true) {
		const timers = new ManualTimers();
		const f = await fixture(false, "chat", false, timers);
		f.saved.context.extensionUri = URI.file(root);
		const session = f.chat.sessionOf(f.row.tabId)!;
		f.channel.handlers.set("get_state", () => "drop");
		assert.equal(session.reconnect(), "started");
		await nextTurn(); await nextTurn();
		timers.advance(10); await nextTurn(); await nextTurn();
		assert.equal(session.phase, "failed");
		assert.equal(session.nativeStateUnanswered, true);
		const sourceDocument = f.state.document;
		const content = { text: "edited current draft", attachments: 1, recoverable: [
			{ text: "pending original", attachments: 2, unconfirmed: true },
			{ text: "refused original", attachments: 0, unconfirmed: false },
		] };
		const post = f.panels.webview.postMessage;
		f.panels.webview.postMessage = async message => {
			await post(message);
			const request = message as { type?: string; requestId?: number };
			if (request.type === "omp:draft-request" && typeof request.requestId === "number") {
				await harness.handleGuestMessage(f.index, f.state.slotId, f.panels, {
					type: "omp:draft-reply", requestId: request.requestId, captured: captureComplete,
					...(captureComplete ? content : { text: "", attachments: 0, recoverable: [] }),
				});
			}
			return true;
		};
		return { ...f, timers, session, content, sourceDocument };
	}

	it("cancels Restart without stopping or replacing its writer and releases the complete input capture", async () => {
		const f = await wedgedChat();
		try {
			harness.warning(async () => undefined);
			await harness.restartChat(f.saved.context, f.index, f.row.tabId, f.session.epoch.nonce);
			assert.equal((await f.native.handle.refreshStatus()).state, "running");
			assert.equal(f.state.document, f.sourceDocument);
			assert.equal(f.state.transitioning, false);
			assert.equal(f.launches(), 0);
			assert.equal(harness.restoredDraft(f.state.slotId), null);
			const requests = f.panels.messages as { type: string; requestId?: number }[];
			assert.equal(requests.find(item => item.type === "omp:draft-release")?.requestId, requests.find(item => item.type === "omp:draft-request")?.requestId);
		} finally { f.chat.dispose(); await f.index.closeSession(f.row.tabId, { confirmedStopped: true }); }
	});

	it("refuses Restart before destructive effects when complete input capture fails", async () => {
		const f = await wedgedChat(false);
		try {
			await harness.restartChat(f.saved.context, f.index, f.row.tabId, f.session.epoch.nonce);
			assert.equal((await f.native.handle.refreshStatus()).state, "running");
			assert.equal(f.state.document, f.sourceDocument);
			assert.equal(f.launches(), 0);
			assert.equal(f.dialogs.filter(dialog => dialog.action === "Restart").length, 0);
			assert.equal(f.state.transitioning, false);
		} finally { f.chat.dispose(); await f.index.closeSession(f.row.tabId, { confirmedStopped: true }); }
	});

	it("explicitly stops the exact owned writer without native settlement and restores all input once in the same saved conversation", async () => {
		const f = await wedgedChat();
		try {
			const before = await readFile(f.file!, "utf8");
			const commands = f.channel.written.length;
			const stop = f.native.handle.stop;
			let forced = false;
			f.native.handle.stop = async (...args: unknown[]) => {
				const options = args[0];
				assert.ok(options !== null && typeof options === "object" && "mode" in options);
				assert.equal(options.mode, "force");
				assert.equal(f.state.document, f.sourceDocument, "source content stays bound through destruction");
				forced = true;
				return stop();
			};
			await harness.restartChat(f.saved.context, f.index, f.row.tabId, f.session.epoch.nonce);
			assert.equal(forced, true);
			assert.equal(f.launches(), 1);
			assert.equal(f.state.panel, f.panels);
			assert.equal(f.state.mode, "chat");
			assert.notEqual(f.state.document, f.sourceDocument);
			assert.equal(f.index.get(f.row.tabId)?.sessionFile, f.file);
			assert.equal(f.index.get(f.row.tabId)?.sessionId, "mode-session");
			assert.equal(await readFile(f.file!, "utf8"), before);
			assert.equal(f.channel.written.length, commands, "Restart cannot depend on another blocked get_state or abort");
			const preserved = harness.restoredDraft(f.state.slotId)!;
			assert.deepEqual({ text: preserved.text, attachments: preserved.attachments, recoverable: preserved.recoverable }, f.content);
			await harness.handleGuestMessage(f.index, f.state.slotId, f.panels, { type: "omp:ready", protocolVersion: GUEST_PROTOCOL_VERSION });
			const restored = (f.panels.messages as { type: string; requestId?: number }[]).find(item => item.type === "omp:draft-restore");
			assert.equal(restored?.requestId, preserved.requestId);
			await harness.handleGuestMessage(f.index, f.state.slotId, f.panels, { type: "omp:draft-restored", requestId: preserved.requestId + 1 });
			assert.ok(harness.restoredDraft(f.state.slotId), "a foreign acknowledgement cannot consume input");
			await harness.handleGuestMessage(f.index, f.state.slotId, f.panels, { type: "omp:draft-restored", requestId: preserved.requestId });
			assert.equal(harness.restoredDraft(f.state.slotId), null);
		} finally { f.chat.dispose(); await f.index.closeSession(f.row.tabId, { confirmedStopped: true }); }
	});

	it("rechecks ownership and native responsiveness after consent instead of stopping a changed or recovered writer", async () => {
		for (const change of ["role", "responsive"] as const) {
			const f = await wedgedChat();
			try {
				harness.warning(async (_message, _options, action) => {
					if (action !== "Restart") return undefined;
					if (change === "role") await f.index.bindEditorSlot("e".repeat(32), f.row.tabId, "controlling");
					else {
						f.channel.handlers.delete("get_state");
						assert.equal(f.session.reconnect(), "started");
						await nextTurn(); await nextTurn();
						assert.equal(f.session.nativeStateUnanswered, false);
					}
					return action;
				});
				await harness.restartChat(f.saved.context, f.index, f.row.tabId, f.session.epoch.nonce);
				assert.equal((await f.native.handle.refreshStatus()).state, "running");
				assert.equal(f.launches(), 0);
				assert.equal(f.state.document, f.sourceDocument);
			} finally { f.chat.dispose(); await f.index.closeSession(f.row.tabId, { confirmedStopped: true }); }
		}
	});

	it("never starts a successor when the captured writer's root exit remains unproved", async () => {
		const f = await wedgedChat();
		try {
			f.native.handle.stop = async () => ({ pidGone: false, verified: false, tree: "unknown", nativePid: f.native.pid, remainingPids: [], detail: "still running" });
			await harness.restartChat(f.saved.context, f.index, f.row.tabId, f.session.epoch.nonce);
			assert.equal(f.launches(), 0);
			assert.equal(f.state.runtime, f.native);
			assert.equal(f.state.document, f.sourceDocument);
			assert.equal(f.state.transitioning, true);
			assert.ok(f.state.controlFailure);
			assert.ok((f.panels.messages as { type: string }[]).some(item => item.type === "omp:draft-release"));
		} finally { f.chat.dispose(); await f.index.closeSession(f.row.tabId, { confirmedStopped: true }); }
	});

	it("publishes native start admission before a delayed restore and clears it after failure", async () => {
		const f = await fixture();
		const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
		f.state.runtime = null;
		f.native.exit();
		f.index.restore = async () => {
			entered.resolve();
			await release.promise;
			return { tabId: f.row.tabId, status: "stopped", detail: "Fixture launch refused" };
		};
		try {
			const opening = harness.openSessionInMode(f.saved.context, f.index, f.row.tabId, "terminal");
			await entered.promise;
			const frames = f.panels.messages as { type: string; starting?: boolean; running?: boolean; reason?: string | null; phase?: string }[];
			assert.ok(frames.some(frame => frame.type === "omp:session-view" && frame.starting && !frame.running && frame.reason === null));
			await harness.handleTerminalGuestMessage(f.row.tabId, { type: "omp:terminal-attach" }, { generation: null, cols: 80, rows: 24 });
			assert.equal(frames.some(frame => frame.type === "omp:terminal-state" && frame.phase === "unavailable"), false);
			release.resolve();
			await opening;
			assert.equal(frames.findLast(frame => frame.type === "omp:session-view")?.starting, false);
		} finally {
			release.resolve();
			f.chat.dispose(); await f.index.closeSession(f.row.tabId, { confirmedStopped: true });
		}
	});

	it("reattaches an already-native editor on repeated Terminal opens and reports an unreachable broker", async () => {
		const f = await fixture(false, "terminal");
		const native = terminalRuntime(f.native.pid, f.file, f.directory);
		f.state.runtime = native;
		let attached = 0;
		native.handle.attach = async () => { attached++; };
		const notices: unknown[] = [];
		harness.warning(async (...args) => { notices.push(args); });
		try {
			for (let attempt = 0; attempt < 3; attempt++) await harness.openSessionInMode(f.saved.context, f.index, f.row.tabId, "terminal");
			assert.equal(attached, 3, "same-mode explicit Open refreshes the existing frontend instead of silently returning");
			assert.equal(f.launches(), 0, "reattachment never starts another writer");
			assert.deepEqual(notices, []);
			native.handle.refreshStatus = async () => { throw new Error("Fixture broker unreachable"); };
			await harness.openSessionInMode(f.saved.context, f.index, f.row.tabId, "terminal");
			assert.equal(notices.length, 1, "a failed explicit reopen has visible feedback");
			assert.equal(f.launches(), 0);
		} finally {
			f.state.pipeline?.dispose(); f.chat.dispose();
			await f.index.closeSession(f.row.tabId, { confirmedStopped: true });
		}
	});

	it("closes an exited or already-retired folder shell silently and removes its recovery record", async () => {
		const f = await fixture();
		const notices: unknown[] = [];
		harness.warning(async (...args) => { notices.push(args); });
		try {
			for (const retired of [false, true]) {
				const panel = harness.createPanel();
				const shell = await harness.shellFixture(f.directory, panel, "exited");
				if (retired) await shell.remove();
				await harness.handleShellEditorClosed(f.saved.context, f.index, shell.slot, panel);
				assert.equal(shell.record(), null);
				assert.deepEqual(notices, []);
			}
		} finally { f.chat.dispose(); await f.index.closeSession(f.row.tabId, { confirmedStopped: true }); }
	});

	it("switches an idle durable conversation in the same panel and row without a modal", async () => {
		const f = await fixture();
		try {
			await harness.switchSessionMode(f.saved.context, f.index, f.state, "terminal");
			assert.equal(f.launches(), 1);
			assert.equal(f.state.panel, f.panels);
			assert.equal(f.state.tabId, f.row.tabId);
			assert.equal(f.state.slotId, f.row.tabId);
			assert.equal(f.state.mode, "terminal");
			assert.equal(f.index.get(f.row.tabId)?.sessionFile, f.file);
			assert.equal(f.index.get(f.row.tabId)?.sessionId, "mode-session");
			assert.deepEqual(f.dialogs, []);
			assert.equal(f.state.transitioning, false);
		} finally { f.chat.dispose(); await f.index.closeSession(f.row.tabId, { confirmedStopped: true }); }
	});

	it("publishes an actual native pipeline after an early attach, with live row/status and owned input", async () => {
		const f = await fixture(false, "chat", true);
		try {
			await harness.switchSessionMode(f.saved.context, f.index, f.state, "terminal");
			const frames = () => f.panels.messages as { type: string; phase?: string; input?: boolean; generation?: string; bytes?: string; running?: boolean; mode?: string }[];
			assert.equal(frames().some(frame => frame.type === "omp:terminal-state" && frame.phase === "unavailable"), false, "a native successor in flight is not reported as stopped or unattached");
			assert.ok(frames().some(frame => frame.type === "omp:session-view" && frame.mode === "terminal" && frame.running));
			assert.equal(f.chat.sessionOf(f.row.tabId), null, "native liveness cannot rely on an RPC session");
			assert.equal(harness.rowState(f.index.get(f.row.tabId), await harness.launcherOwnershipFacts(f.index, f.row.tabId)), "running");
			await harness.handleTerminalGuestMessage(f.row.tabId, { type: "omp:terminal-attach" }, { generation: "0".repeat(32), cols: 80, rows: 24 });
			const attached = frames().findLast(frame => frame.type === "omp:terminal-state");
			assert.equal(attached?.phase, "attached");
			const generation = attached?.generation;
			assert.ok(generation && generation !== "0".repeat(32));
			assert.equal(Buffer.from(frames().findLast(frame => frame.type === "omp:terminal-snapshot")!.bytes!, "base64").toString(), "Native successor ready\r\n\u001b[1;1H");
			await harness.handleTerminalGuestMessage(f.row.tabId, { type: "omp:terminal-visibility" }, { visible: true });
			await harness.handleTerminalGuestMessage(f.row.tabId, { type: "omp:terminal-focus" }, { focused: true, intent: true });
			await nextTurn();
			assert.equal(frames().findLast(frame => frame.type === "omp:terminal-state")?.input, true);
			const data = Buffer.from("\u001b[B").toString("base64");
			await harness.handleTerminalGuestMessage(f.row.tabId, { type: "omp:terminal-input" }, { generation: "0".repeat(32), data });
			assert.deepEqual(f.successor()!.writes, []);
			await harness.handleTerminalGuestMessage(f.row.tabId, { type: "omp:terminal-input" }, { generation, data });
			assert.deepEqual(f.successor()!.writes, ["\u001b[B"]);
			f.successor()!.output("Native continuation\r\n");
			assert.equal(Buffer.from(frames().findLast(frame => frame.type === "omp:terminal-data")!.bytes!, "base64").toString(), "Native continuation\r\n");
		} finally {
			f.state.nativeWatch?.(); f.state.pipeline?.dispose();
			f.chat.dispose(); await f.index.closeSession(f.row.tabId, { confirmedStopped: true });
		}
	});

	it("binds a fresh native pipeline through three Close and stopped-row Terminal reopen cycles", async () => {
		const f = await fixture(false, "chat", true);
		try {
			await harness.switchSessionMode(f.saved.context, f.index, f.state, "terminal");
			let generation: string | undefined;
			for (let cycle = 0; cycle < 3; cycle++) {
				const previous = f.successor()!;
				const previousPipeline = f.state.pipeline;
				nativeControl(f, previous);
				await harness.closeSession(f.saved.context, f.index, f.row.tabId);
				assert.equal(f.state.pipeline, null, "a proved stopped writer cannot keep its frontend pipeline");
				assert.equal(f.state.runtime, null);
				assert.equal(f.index.get(f.row.tabId)?.runIntent, "stopped");
				f.panels.messages.length = 0;
				await harness.openSessionInMode(f.saved.context, f.index, f.row.tabId, "terminal");
				assert.notEqual(f.state.pipeline, previousPipeline);
				assert.notEqual(f.successor()!.pid, previous.pid);
				const frames = f.panels.messages as { type: string; phase?: string; input?: boolean; generation?: string; bytes?: string; running?: boolean; starting?: boolean }[];
				assert.ok(frames.some(frame => frame.type === "omp:session-view" && frame.running && frame.starting), "known native admission stays Starting through runtime publication");
				await harness.handleTerminalGuestMessage(f.state.slotId, { type: "omp:terminal-attach" }, { generation: generation ?? null, cols: 80, rows: 24 });
				const attached = frames.findLast(frame => frame.type === "omp:terminal-state");
				assert.equal(attached?.phase, "attached");
				assert.ok(attached.generation && attached.generation !== generation);
				generation = attached.generation;
				assert.match(Buffer.from(frames.findLast(frame => frame.type === "omp:terminal-snapshot")!.bytes!, "base64").toString(), /Native successor ready/);
				await harness.handleTerminalGuestMessage(f.state.slotId, { type: "omp:terminal-visibility" }, { visible: true });
				await harness.handleTerminalGuestMessage(f.state.slotId, { type: "omp:terminal-focus" }, { focused: true, intent: true });
				await nextTurn();
				assert.equal(frames.findLast(frame => frame.type === "omp:terminal-state")?.input, true);
				await harness.handleTerminalGuestMessage(f.state.slotId, { type: "omp:terminal-input" }, { generation, data: Buffer.from("next").toString("base64") });
				assert.deepEqual(f.successor()!.writes, ["next"]);
				f.successor()!.output(`Live cycle ${cycle}\r\n`);
				assert.equal(Buffer.from(frames.findLast(frame => frame.type === "omp:terminal-data")!.bytes!, "base64").toString(), `Live cycle ${cycle}\r\n`);
			}
			assert.equal(f.launches(), 4, "one initial native writer and one non-overlapping writer per restart");
		} finally {
			f.state.nativeWatch?.(); f.state.pipeline?.dispose();
			f.chat.dispose(); await f.index.closeSession(f.row.tabId, { confirmedStopped: true });
		}
	});

	it("retires the native pipeline when a naturally exited writer is proved gone", async () => {
		const f = await fixture(false, "chat", true);
		try {
			await harness.switchSessionMode(f.saved.context, f.index, f.state, "terminal");
			assert.ok(f.state.pipeline);
			const native = f.successor()!;
			native.exit();
			await harness.handleNativeHostExited(f.index, f.state, native);
			assert.equal(f.state.runtime, null);
			assert.equal(f.state.pipeline, null);
			assert.equal(f.index.get(f.row.tabId)?.runIntent, "stopped");
		} finally {
			f.state.nativeWatch?.(); f.state.pipeline?.dispose();
			f.chat.dispose(); await f.index.closeSession(f.row.tabId, { confirmedStopped: true });
		}
	});

	it("explicit Terminal recovery reattaches a managed native survivor in the same panel without legacy Stop", async () => {
		const f = await fixture(false, "terminal");
		await f.index.closeSession(f.row.tabId, { confirmedStopped: false });
		const index = new harness.SessionIndex({ claimStorageDir: path.join(f.directory, "claims"), store: {
			get<T>(key: string) { return f.values.get(key) as T | undefined; },
			async update(key: string, value: unknown) { f.values.set(key, value); },
		} });
		harness.reset(index, f.chat);
		await index.bindEditorSlot(f.row.tabId, f.row.tabId, "controlling");
		const state = harness.state(f.row.tabId);
		state.panel = f.panels; state.mode = "terminal";
		const native = terminalRuntime(f.native.pid, f.file, f.directory);
		const recorded = index.get(f.row.tabId)!.host!;
		const identity = recorded.rpc!;
		const pin = { kind: "broker", slot: identity.slot, brokerId: identity.brokerId, brokerGeneration: identity.brokerGeneration,
			brokerPid: identity.brokerPid, brokerCreationTime: identity.brokerCreationTime, nativePid: identity.childPid, nativeCreationTime: identity.childCreationTime };
		let attached = 0, launched = 0;
		const dialogs = harness.policy(f.saved.context, {
			readProcessIdentity: async () => ({ kind: "found", creationTime: identity.childCreationTime }), isProcessAlive: () => true,
			probeRpc: async () => ({ kind: "attachable", pin }), brokerProvenance: () => ({ kind: "none" }),
		}, {
			attach: async () => {
				attached++; await harness.startConversation(index, f.row.tabId, native, f.file, true);
				return { state: "attached", host: { pid: native.pid, sessionId: f.row.sessionId, rpc: identity, transport: "native" } };
			},
			launch: async () => { launched++; throw new Error("Recovery must not spawn another writer"); },
		}, { stopRecordedHost: async () => { throw new Error("Managed native recovery must not use legacy Stop"); } });
		try {
			await harness.openSessionInMode(f.saved.context, index, f.row.tabId, "terminal");
			assert.deepEqual(dialogs, []);
			assert.equal(attached, 1); assert.equal(launched, 0);
			assert.equal(state.runtime, native); assert.equal(state.panel, f.panels);
			assert.equal(native.handle.state, "running");
			assert.equal(index.get(f.row.tabId)?.host?.pid, f.native.pid);
			await harness.handleTerminalGuestMessage(f.row.tabId, { type: "omp:terminal-attach" }, { generation: null, cols: 80, rows: 24 });
			const screen = (f.panels.messages as { type: string; bytes?: string }[]).findLast(frame => frame.type === "omp:terminal-snapshot");
			assert.equal(Buffer.from(screen!.bytes!, "base64").toString(), "Native successor ready\r\n\u001b[1;1H", "the restored screen ends with the cursor placed absolutely");
			native.output("Recovered native continuation\r\n");
			const output = (f.panels.messages as { type: string; bytes?: string }[]).findLast(frame => frame.type === "omp:terminal-data");
			assert.equal(Buffer.from(output!.bytes!, "base64").toString(), "Recovered native continuation\r\n");
		} finally {
			state.nativeWatch?.(); state.pipeline?.dispose();
			f.chat.dispose(); await index.closeSession(f.row.tabId, { confirmedStopped: true });
		}
	});
	for (const mode of ["terminal", "chat"] as const) for (const order of ["immediately", "after reload"] as const) {
		it(`closed editor reopens ${mode} ${order} through the real lifecycle without replacing its writer`, async () => {
			const f = await fixture(false, mode);
			let index = f.index;
			let chat = f.chat;
			let channel = f.channel;
			const native = terminalRuntime(f.native.pid, f.file, f.directory);
			let activeRuntime = mode === "terminal" ? native : { ...f.native, handle: channel };
			const restores = [harness.editorLifecycle()];
			const oldPanel = harness.createPanel();
			const history = [messageEntry("cached-answer", null, assistantMessage("Retained answer before closing", 1000))];
			await writeFile(f.file!, sessionFileText({ id: "mode-session", cwd: f.directory, entries: history }));
			if (mode === "chat") {
				channel.child.entries = history as never;
				channel.child.leafId = "cached-answer";
				channel.emitMessage("message_end", "cached-answer", assistantMessage("Retained answer before closing", 1000) as never);
				await nextTurn();
			}
			f.state.panel = null;
			f.state.runtime = activeRuntime;
			harness.bindPanel(f.saved.context, index, "d".repeat(32), f.row.tabId, oldPanel, "created");
			await harness.openTab(f.saved.context, index, f.row.tabId, "opened");
			if (mode === "terminal") await harness.startConversation(index, f.row.tabId, native, f.file, false);
			try {
				const originalSession = chat.sessionOf(f.row.tabId);
				oldPanel.dispose();
				assert.equal(index.get(f.row.tabId)?.runIntent, "running", "closing the editor must not stop the conversation");
				assert.equal((await (mode === "terminal" ? native.handle : f.native.handle).refreshStatus()).state, "running");
				if (mode === "terminal") native.output("Output while the editor was closed\r\n");
				if (order === "after reload") {
					harness.state(f.row.tabId).nativeWatch?.();
					harness.state(f.row.tabId).pipeline?.dispose();
					chat.dispose();
					// The test process stays alive: preserve its holder while reconstructing
					// the index, rather than performing a user Close that stops run intent.
					index = new harness.SessionIndex({ claimStorageDir: path.join(f.directory, "claims"), claimHolder: index.claimHolder, store: {
						get<T>(key: string) { return f.values.get(key) as T | undefined; },
						async update(key: string, value: unknown) { f.values.set(key, value); },
					} });
					chat = new ChatRuntime({ hostNonce: `${path.basename(f.directory)}-reloaded`, onEvent() {} });
					channel = new FakeRpcChannel({ sessionFile: f.file, sessionId: "mode-session", entries: history as never, leafId: "cached-answer" });
					activeRuntime = mode === "terminal" ? native : { ...f.native, handle: channel };
					harness.reset(index, chat);
					const identity = index.get(f.row.tabId)!.host!.rpc!;
					const pin = { kind: "broker", slot: identity.slot, brokerId: identity.brokerId, brokerGeneration: identity.brokerGeneration,
						brokerPid: identity.brokerPid, brokerCreationTime: identity.brokerCreationTime, nativePid: identity.childPid, nativeCreationTime: identity.childCreationTime };
					harness.policy(f.saved.context, {
						readProcessIdentity: async () => ({ kind: "found", creationTime: identity.childCreationTime }), isProcessAlive: () => true,
						probeRpc: async () => ({ kind: "attachable", pin }), brokerProvenance: () => ({ kind: "none" }),
					}, {
						attach: async () => {
							await harness.startConversation(index, f.row.tabId, activeRuntime, f.file, true);
							return { state: "attached", host: index.get(f.row.tabId)!.host! };
						},
						launch: async () => { throw new Error("Reopening must not replace the surviving writer"); },
					}, {});
					restores.push(harness.editorLifecycle());
					await harness.restoreTabs(f.saved.context, index, new Set([f.row.tabId]));
					if (mode === "chat") await chat.sessionOf(f.row.tabId)!.start();
					assert.equal(harness.state(f.row.tabId).panel, null, "reload must leave a closed editor closed");
				}
				await harness.openTab(f.saved.context, index, f.row.tabId, "opened");
				const current = harness.state(f.row.tabId);
				const reopened = current.panel as LifecyclePanel;
				assert.notEqual(reopened, oldPanel);
				assert.notEqual(current.slotId, "d".repeat(32));
				assert.equal(current.runtime, activeRuntime);
				assert.equal(index.get(f.row.tabId)?.host?.pid, f.native.pid);
				assert.equal(index.get(f.row.tabId)?.runIntent, "running");
				if (mode === "terminal") {
					await harness.handleTerminalGuestMessage(current.slotId, { type: "omp:terminal-attach" }, { generation: null, cols: 80, rows: 24 });
					const frames = reopened.messages as { type: string; phase?: string; bytes?: string; generation?: string }[];
					assert.equal(frames.findLast(frame => frame.type === "omp:terminal-state")?.phase, "attached", "the replacement editor must receive its own PTY state");
					assert.match(Buffer.from(frames.findLast(frame => frame.type === "omp:terminal-snapshot")!.bytes!, "base64").toString(), /Output while the editor was closed/);
					native.output("Live output after reopening\r\n");
					assert.equal(Buffer.from(frames.findLast(frame => frame.type === "omp:terminal-data")!.bytes!, "base64").toString(), "Live output after reopening\r\n");
					const generation = frames.findLast(frame => frame.type === "omp:terminal-state")!.generation;
					assert.ok(generation);
					await harness.handleTerminalGuestMessage(current.slotId, { type: "omp:terminal-visibility" }, { visible: true });
					await harness.handleTerminalGuestMessage(current.slotId, { type: "omp:terminal-focus" }, { focused: true, intent: true });
					await nextTurn();
					await harness.handleTerminalGuestMessage(current.slotId, { type: "omp:terminal-input" }, { generation, data: Buffer.from("fresh input").toString("base64") });
					assert.deepEqual(native.writes, ["fresh input"]);
					oldPanel.receive({ type: "omp:terminal-input", generation, data: Buffer.from("stale input").toString("base64") });
					await nextTurn();
					assert.deepEqual(native.writes, ["fresh input"], "a disposed editor must remain unable to type into the surviving process");
				} else {
					const rendered = new ChatClient({ post: () => true });
					reopened.onMessage = message => { const parsed = parseGuestHostMessage(message); if (parsed !== null) rendered.handle(parsed); };
					for (const message of reopened.messages) reopened.onMessage(message);
					assert.equal(rendered.getSnapshot().phase, "live");
					assert.match(JSON.stringify(rendered.getSnapshot().entries), /Retained answer before closing/, "the replacement page must receive the retained conversation");
					if (order === "immediately") assert.equal(chat.sessionOf(f.row.tabId), originalSession, "reopening must not restart the live RPC conversation");
					const answer = assistantMessage("Live answer after reopening", 2000);
					const updated = [...history, messageEntry("after-reopen-answer", "cached-answer", answer)];
					channel.child.entries = updated as never;
					channel.child.leafId = "after-reopen-answer";
					await writeFile(f.file!, sessionFileText({ id: "mode-session", cwd: f.directory, entries: updated }));
					channel.emitMessage("message_end", "after-reopen-answer", answer as never);
					await nextTurn();
					assert.match(JSON.stringify(rendered.getSnapshot().entries), /Live answer after reopening/);
				}
			} finally {
				harness.state(f.row.tabId).nativeWatch?.();
				harness.state(f.row.tabId).pipeline?.dispose();
				chat.dispose();
				for (const restore of restores.reverse()) restore();
				await index.closeSession(f.row.tabId, { confirmedStopped: true });
			}
		});
	}
	it("publishes native draft rows while ownership is pending, then binds only the materialized file", async t => {
		const f = await fixture(true, "terminal");
		const allocatedFile = path.join(f.directory, "allocated.jsonl");
		const secondary = await f.index.createDraft({ cwd: f.directory });
		const facts = { open: false, running: false, outcome: null, activity: null };
		const first = Promise.withResolvers<{ ownershipChecked: boolean }>();
		const provider = new harness.SessionTreeProvider({
			folders: () => [{ id: "folder:owned", path: f.directory, collapsed: false, pinned: true, open: false }],
			entries: () => f.index.list(),
			activeTabId: () => f.row.tabId,
			facts: tabId => tabId === f.row.tabId ? { ...facts, running: true } : facts,
			runtimeIdentity: () => null,
			observeOwnership: () => first.promise,
		});
		t.mock.timers.enable({ apis: ["Date"], now: 0 });
		harness.notificationTree(undefined, undefined);
		let roots: ReturnType<typeof provider.getChildren> | undefined;
		let foreign: Awaited<ReturnType<typeof acquireClaim>> | null = null;
		try {
			await harness.bindConversationIdentity(f.index, f.row.tabId, f.native, allocatedFile, "mode-session");
			harness.notificationTree(provider, undefined);
			roots = provider.getChildren();
			assert.deepEqual(roots.map(root => root.id), ["folder:owned"]);
			const initialRows = provider.getChildren(roots[0]);
			assert.deepEqual(initialRows.map(row => [row.id, "state" in row ? row.state : null]), [
				[f.row.tabId, "running"], [secondary.tabId, "checking"],
			], "the catalog is visible while the unrelated ownership observation is pending");
			await harness.bindConversationIdentity(f.index, f.row.tabId, f.native, allocatedFile, "mode-session");
			first.resolve({ ownershipChecked: true });
			await nextTurn();
			assert.deepEqual((await provider.getChildren(roots![0])).map(row => row.id), [f.row.tabId, secondary.tabId]);
			assert.equal(f.index.get(f.row.tabId)?.sessionFile, null, "allocated identity must not force a zero-turn transcript onto disk");
			await assert.rejects(readFile(allocatedFile), { code: "ENOENT" });
			await writeFile(allocatedFile, sessionFileText({ id: "mode-session", cwd: f.directory, entries: [] }));
			foreign = await harness.acquireClaim(path.join(f.directory, "claims"), allocatedFile, "foreign-generation", harness.createClaimHolder(process.pid));
			t.mock.timers.setTime(750);
			await harness.retryPendingIdentity(f.index, f.row.tabId);
			assert.equal(f.index.get(f.row.tabId)?.sessionFile, null, "a pending retry must retain draft authority when the written file has another claim");
			await foreign.release(); foreign = null;
			t.mock.timers.setTime(1500);
			await harness.retryPendingIdentity(f.index, f.row.tabId);
			assert.equal(f.index.get(f.row.tabId)?.sessionFile, allocatedFile, "the retained retry still promotes the real materialized file once claimable");
			assert.equal(f.index.get(f.row.tabId)?.host?.pid, f.native.pid);
		} finally {
			await foreign?.release();
			first.resolve({ ownershipChecked: true });
			harness.notificationTree(undefined, undefined);
			f.state.runtime = null;
			t.mock.timers.setTime(2250);
			await harness.retryPendingIdentity(f.index, f.row.tabId);
			provider.dispose(); f.chat.dispose();
			await f.index.closeSession(f.row.tabId, { confirmedStopped: true });
		}
	});

	it("native watch projects pending asks and background work, then sends one finish after jobs and delivery drain", async t => {
		const f = await fixture(true, "terminal");
		const watched = terminalRuntime(f.native.pid, null, f.directory);
		f.state.runtime = watched;
		const native = { idle: true, jobs: 0, queuedDelivery: 0 };
		const sdk: OmpExtensionContext = {
			mode: "tui", agent: { kind: "main" },
			sessionManager: { getSessionFile: () => null, getSessionId: () => "mode-session", getCwd: () => f.directory },
			isIdle: () => native.idle, hasPendingMessages: () => false,
			getAsyncJobSnapshot: () => ({ running: Array(native.jobs).fill({}),
				delivery: { queued: native.queuedDelivery, delivering: false, pendingJobIds: [] } }),
		};
		const adapter = createOmpHostControlAdapter({ on() {}, getActiveTools: () => [], getAllTools: () => [] });
		adapter.observeContext(sdk);
		const epoch = "e".repeat(32);
		const control = Object.assign(client(Promise.resolve({ host: { epoch } })), {
			nativeState: async () => adapter.nativeState!(false),
			nativeActivity: async (options: { work?: true } = {}) => adapter.nativeActivity!(epoch, options.work === true),
		});
		f.state.control = { client: control, snapshot: null, activity: true, work: true };
		const restore = harness.desktopEnvironment({ ...f.saved.context, extension: { id: "hmmvot.omp-desk" } });
		harness.configuration({ "omp.desktopNotifications": true });
		harness.focusSession(false);
		harness.notificationTree(undefined, undefined);
		t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
		const rowState = () => harness.rowState(f.index.get(f.row.tabId), harness.launcherFacts(f.row.tabId));
		try {
			harness.startNativeWatch(f.index, f.state, watched);
			await nextTurn();
			assert.equal(rowState(), "waiting");
			native.idle = false;
			adapter.observeActivity("agent_start", {}, sdk);
			adapter.observeActivity("tool_execution_start", { toolName: "ask", toolCallId: "wait",
				args: { questions: [{ question: "Choose the next action" }] } }, sdk);
			t.mock.timers.tick(750); await nextTurn();
			assert.equal(rowState(), "question");
			assert.equal(harness.desktopPayloads().length, 1);
			t.mock.timers.tick(750); await nextTurn();
			assert.equal(rowState(), "question", "consuming the ask notice must not answer the dialog");
			assert.equal(harness.desktopPayloads().length, 1);
			adapter.observeActivity("tool_execution_end", { toolName: "ask", toolCallId: "wait" }, sdk);
			adapter.observeActivity("message_end", { message: { role: "assistant", stopReason: "stop" } }, sdk);
			adapter.observeActivity("agent_end", { willContinue: true, messages: [{ role: "assistant", stopReason: "stop" }] }, sdk);
			native.idle = true; native.jobs = 1;
			t.mock.timers.tick(750); await nextTurn();
			assert.equal(rowState(), "background");
			assert.equal(harness.desktopPayloads().length, 1, "no finish while background work remains");
			native.jobs = 0; native.queuedDelivery = 1;
			t.mock.timers.tick(750); await nextTurn();
			assert.equal(rowState(), "background");
			assert.equal(harness.desktopPayloads().length, 1, "delivery is still background work");
			native.queuedDelivery = 0;
			t.mock.timers.tick(750); await nextTurn();
			assert.equal(rowState(), "unread", "the finish happened while nobody looked, so the idle row is unread until its editor is viewed");
			assert.equal(harness.desktopPayloads().length, 2);
			t.mock.timers.tick(750); await nextTurn();
			assert.equal(harness.desktopPayloads().length, 2, "one final notice without a wake or duplicate poll replay");
		} finally {
			f.state.nativeWatch?.();
			harness.forgetTurnActivity(f.index, f.row.tabId);
			restore(); f.chat.dispose();
			await f.index.closeSession(f.row.tabId, { confirmedStopped: true });
		}
	});

	it("native watch shows Needs your answer for an ask that opened before it attached, with one notice across a reconnect", async t => {
		const f = await fixture(true, "terminal");
		const watched = terminalRuntime(f.native.pid, null, f.directory);
		f.state.runtime = watched;
		const native = { idle: false };
		const sdk: OmpExtensionContext = {
			mode: "tui", agent: { kind: "main" },
			sessionManager: { getSessionFile: () => null, getSessionId: () => "mode-session", getCwd: () => f.directory },
			isIdle: () => native.idle, hasPendingMessages: () => false,
			getAsyncJobSnapshot: () => ({ running: [], delivery: { queued: 0, delivering: false, pendingJobIds: [] } }),
		};
		const adapter = createOmpHostControlAdapter({ on() {}, getActiveTools: () => [], getAllTools: () => [] });
		adapter.observeContext(sdk);
		const epoch = "e".repeat(32);
		const connect = () => Object.assign(client(Promise.resolve({ host: { epoch } })), {
			nativeState: async () => adapter.nativeState!(false),
			nativeActivity: async (options: { work?: true } = {}) => adapter.nativeActivity!(epoch, options.work === true),
		});
		f.state.control = { client: connect(), snapshot: null, activity: true, work: true };
		const restore = harness.desktopEnvironment({ ...f.saved.context, extension: { id: "hmmvot.omp-desk" } });
		harness.configuration({ "omp.desktopNotifications": true });
		harness.focusSession(false);
		harness.notificationTree(undefined, undefined);
		t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
		const rowState = () => harness.rowState(f.index.get(f.row.tabId), harness.launcherFacts(f.row.tabId));
		try {
			// The window reloaded while the TUI was already waiting: the journal holds the ask, the watcher never saw it start.
			adapter.observeActivity("agent_start", {}, sdk);
			adapter.observeActivity("tool_execution_start", { toolName: "ask", toolCallId: "early",
				args: { questions: [{ question: "Choose the next action" }] } }, sdk);
			harness.startNativeWatch(f.index, f.state, watched);
			await nextTurn();
			assert.equal(rowState(), "question", "a pending ask outranks the working turn");
			assert.equal(harness.desktopPayloads().length, 1);
			f.state.control = { client: connect(), snapshot: null, activity: true, work: true };
			t.mock.timers.tick(750); await nextTurn();
			assert.equal(rowState(), "question");
			assert.equal(harness.desktopPayloads().length, 1, "a recovered ask is announced once across a reconnect");
			adapter.observeActivity("tool_execution_end", { toolName: "ask", toolCallId: "early" }, sdk);
			t.mock.timers.tick(750); await nextTurn();
			assert.equal(rowState(), "working", "answering returns the row to Working");
			adapter.observeActivity("tool_execution_start", { toolName: "ask", toolCallId: "cancelled",
				args: { questions: [{ question: "Another?" }] } }, sdk);
			t.mock.timers.tick(750); await nextTurn();
			assert.equal(rowState(), "question");
			assert.equal(harness.desktopPayloads().length, 2);
			adapter.observeActivity("tool_execution_end", { toolName: "ask", toolCallId: "cancelled" }, sdk);
			adapter.observeActivity("message_end", { message: { role: "assistant", stopReason: "aborted" } }, sdk);
			adapter.observeActivity("agent_end", { messages: [{ role: "assistant", stopReason: "aborted" }] }, sdk);
			native.idle = true;
			t.mock.timers.tick(750); await nextTurn();
			assert.equal(rowState(), "unread", "the asks were never looked at, so the idle row stays unread");
			assert.equal(harness.desktopPayloads().length, 2, "a cancelled ask earns no further notice");
		} finally {
			f.state.nativeWatch?.();
			harness.forgetTurnActivity(f.index, f.row.tabId);
			restore(); f.chat.dispose();
			await f.index.closeSession(f.row.tabId, { confirmedStopped: true });
		}
	});

	it("terminal links use the native or shell cwd, open persistent positioned editors and fence a replaced document", async () => {
		const f = await fixture(true, "terminal");
		const file = path.join(f.directory, "navigation.ts");
		await writeFile(file, "first\nsecond\nthird\n");
		const initial = harness.openedDocuments().length;
		const target = "./navigation.ts:2:4";
		const validate = { type: "omp:terminal-link-validate", requestId: 10, target };
		const open = { type: "omp:terminal-link-open", requestId: 11, target };
		try {
			await harness.handleGuestMessage(f.index, f.state.slotId, f.panels, validate);
			assert.deepEqual(f.panels.messages.at(-1), { type: "omp:terminal-link-validation", requestId: 10, valid: true });
			await harness.handleGuestMessage(f.index, f.state.slotId, f.panels, open);
			const opened = harness.openedDocuments()[initial]!;
			assert.equal(opened.uri.fsPath, file);
			assert.equal(opened.options.preview, false, "navigation creates a retained editor, not a disposable preview");
			assert.deepEqual([opened.options.selection.start.line, opened.options.selection.start.character,
				opened.options.selection.end.line, opened.options.selection.end.character], [1, 3, 1, 3]);
			await harness.handleGuestMessage(f.index, f.state.slotId, f.panels, { ...validate, requestId: 12, target: "./missing.ts" });
			assert.deepEqual(f.panels.messages.at(-1), { type: "omp:terminal-link-validation", requestId: 12, valid: false });
			await harness.handleGuestMessage(f.index, f.state.slotId, f.panels, { ...open, requestId: 13, target: "command:workbench.action.reloadWindow" });
			assert.equal(harness.openedDocuments().length, initial + 1);
			const pending = harness.handleGuestMessage(f.index, f.state.slotId, f.panels, { ...open, requestId: 14 });
			f.state.panel = harness.createPanel();
			await pending;
			assert.equal(harness.openedDocuments().length, initial + 1, "disk validation cannot open a file for a replaced document");
			f.state.panel = f.panels;
			const shellDirectory = path.join(f.directory, "shell-cwd");
			await mkdir(shellDirectory);
			const shellFile = path.join(shellDirectory, "navigation.ts");
			await writeFile(shellFile, "shell\n");
			const shellPanel = harness.createPanel();
			const shell = harness.shellContext(shellDirectory, shellPanel);
			await harness.handleTerminalGuestMessage(shell.slot, validate, validate);
			await harness.handleTerminalGuestMessage(shell.slot, open, open);
			assert.equal(harness.openedDocuments()[initial + 1]!.uri.fsPath, shellFile, "a folder shell resolves against its own durable cwd, not a session or extension directory");
			// A native-separator absolute path to a binary opens through the same retained-tab command.
			const image = path.join(f.directory, "subagent-icon-options.png");
			await writeFile(image, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
			await harness.handleGuestMessage(f.index, f.state.slotId, f.panels, { ...open, requestId: 15, target: image });
			assert.equal(harness.openedDocuments()[initial + 2]!.uri.fsPath, image);
			assert.equal(harness.openedDocuments()[initial + 2]!.options.preview, false);
		} finally {
			f.chat.dispose();
			await f.index.closeSession(f.row.tabId, { confirmedStopped: true });
		}
	});

	it("a Chat page's file links resolve against the session cwd, open at their position, and refuse a missing file or any non-file target", async () => {
		const f = await fixture(true);
		const file = path.join(f.directory, "chat-navigation.ts");
		await writeFile(file, "first\nsecond\nthird\n");
		const initial = harness.openedDocuments().length;
		const request = (type: "omp:terminal-link-validate" | "omp:terminal-link-open", requestId: number, target: string) => ({ type, requestId, target });
		try {
			assert.equal(f.state.mode, "chat");
			await harness.handleGuestMessage(f.index, f.state.slotId, f.panels, request("omp:terminal-link-validate", 20, "chat-navigation.ts:2:4"));
			assert.deepEqual(f.panels.messages.at(-1), { type: "omp:terminal-link-validation", requestId: 20, valid: true }, "a relative path validates against the session cwd");
			await harness.handleGuestMessage(f.index, f.state.slotId, f.panels, request("omp:terminal-link-validate", 21, "chat-missing.ts"));
			assert.deepEqual(f.panels.messages.at(-1), { type: "omp:terminal-link-validation", requestId: 21, valid: false }, "a file that does not exist is never a link");
			await harness.handleGuestMessage(f.index, f.state.slotId, f.panels, request("omp:terminal-link-open", 22, "chat-navigation.ts#L3-9"));
			const opened = harness.openedDocuments()[initial]!;
			assert.equal(opened.uri.fsPath, file);
			assert.equal(opened.options.preview, false);
			assert.deepEqual([opened.options.selection.start.line, opened.options.selection.start.character], [2, 0], "the start of a #L range is revealed");
			for (const [index, target] of ["command:workbench.action.reloadWindow", "vscode://command/x", "javascript:alert(1)", "chat-missing.ts", "file://remote/share/chat-navigation.ts"].entries()) {
				await harness.handleGuestMessage(f.index, f.state.slotId, f.panels, request("omp:terminal-link-open", 30 + index, target));
			}
			assert.equal(harness.openedDocuments().length, initial + 1, "nothing but the one existing file was opened");
		} finally {
			f.chat.dispose();
			await f.index.closeSession(f.row.tabId, { confirmedStopped: true });
		}
	});

	it("editor preferences update both real Chat consumers from a fenced page without OMP writes, and reject a stale epoch", async () => {
		const f = await fixture(true);
		f.chat.dispose();
		const host = new ChatRuntime({
			hostNonce: "display-preference-integration", onEvent() {},
			readDisplayPreferences: harness.readChatDisplayPreferences,
			writeToolCallDetail: harness.writeChatToolDetail,
			pickToolCallDetail: harness.pickToolCallDetail,
		});
		harness.reset(f.index, host);
		const state = harness.state(f.row.tabId);
		state.panel = f.panels; state.mode = "chat"; state.transitioning = true;
		const channel = new FakeRpcChannel({ sessionFile: null, sessionId: "mode-session" });
		await host.startLive(f.row.tabId, { channel, sessionFile: null, cwd: f.directory, title: null }).start();
		let posted: unknown;
		const clients = [new ChatClient({ post: message => { posted = message; return true; } }), new ChatClient({ post: () => true })];
		const detached = clients.map((client, position) => host.attachPage(f.row.tabId, {
			id: `presentation-${position}`, readOnlyReason: () => "Read-only observer",
			post: message => { const parsed = parseGuestHostMessage(message); if (parsed !== null) client.handle(parsed); return "sent"; },
		}));
		const writes = channel.written.length;
		const settingsWrites = harness.configurationWrites().length;
		try {
			assert.deepEqual(clients.map(client => client.getDisplayPreferences()), [
				{ toolCallDetail: "overview", accessibilitySupport: false, thinkingExpanded: false, toolsExpanded: false },
				{ toolCallDetail: "overview", accessibilitySupport: false, thinkingExpanded: false, toolsExpanded: false },
			]);
			// The page only asks: the host opens its native picker, marks the setting in force, and writes nothing until a row is chosen.
			assert.equal(clients[0]!.chooseToolCallDetail(), true);
			assert.deepEqual(Object.keys(posted as Record<string, unknown>).sort(), ["epoch", "requestId", "type"], "the request carries no value");
			const pickers = harness.quickPicks().length;
			const choosing = harness.handleGuestMessage(f.index, state.slotId, f.panels, posted);
			for (let round = 0; round < 20 && harness.quickPicks().length === pickers; round++) await nextTurn();
			const picker = harness.quickPicks().at(-1)!;
			assert.equal(harness.quickPicks().length, pickers + 1);
			assert.equal(picker.title, "Tools output");
			assert.deepEqual(picker.items.map(item => [item.label, item.description, item.detail]), [
				["Overview", "Group routine tool calls into one-line summaries", "$(check) Current tools output"],
				["Detailed", "Show every tool call as its own row", undefined],
			]);
			assert.equal(harness.configurationWrites().length, settingsWrites, "opening the picker changes nothing");
			picker.choose(1);
			await choosing;
			assert.equal(picker.disposed, true);
			assert.deepEqual(clients.map(client => client.getDisplayPreferences()), [
				{ toolCallDetail: "detailed", accessibilitySupport: false, thinkingExpanded: false, toolsExpanded: false },
				{ toolCallDetail: "detailed", accessibilitySupport: false, thinkingExpanded: false, toolsExpanded: false },
			]);
			assert.deepEqual(harness.configurationWrites()[settingsWrites], { key: "omp.toolCallDetail", value: "detailed", target: 1 });
			// Dismissing the picker writes nothing, and a stale epoch never reaches it.
			const dismissed = harness.handleGuestMessage(f.index, state.slotId, f.panels, posted);
			for (let round = 0; round < 20 && harness.quickPicks().length === pickers + 1; round++) await nextTurn();
			const second = harness.quickPicks().at(-1)!;
			assert.equal(second.items[1]!.detail, "$(check) Current tools output", "the picker marks the setting now in force");
			second.dismiss();
			await dismissed;
			assert.equal(harness.configurationWrites().length, settingsWrites + 1);
			await harness.handleGuestMessage(f.index, state.slotId, f.panels, {
				...(posted as Record<string, unknown>),
				epoch: { ...clients[0]!.getSnapshot().epoch!, nonce: "stale-host" },
			});
			assert.equal(harness.quickPicks().length, pickers + 2, "a stale request opens no picker");
			assert.equal(harness.configurationWrites().length, settingsWrites + 1);
			harness.configuration({ "omp.toolCallDetail": "overview", "editor.accessibilitySupport": "on" });
			harness.refreshChatDisplayPreferences({ affectsConfiguration: key => key === "editor.accessibilitySupport" });
			assert.deepEqual(clients.map(client => client.getDisplayPreferences()), [
				{ toolCallDetail: "overview", accessibilitySupport: true, thinkingExpanded: false, toolsExpanded: false },
				{ toolCallDetail: "overview", accessibilitySupport: true, thinkingExpanded: false, toolsExpanded: false },
			]);
			assert.equal(channel.written.length, writes, "presentation updates never write OMP commands even when writer admission is fenced");
		} finally {
			for (const detach of detached) detach();
			host.dispose();
			await f.index.closeSession(f.row.tabId, { confirmedStopped: true });
		}
	});

	it("automatic reveal waits for served parents, coalesces to the latest tab and never expands a saved collapse", async () => {
		const f = await fixture(true);
		const secondary = await f.index.createDraft({ cwd: f.directory });
		await f.index.setActiveTab(f.row.tabId);
		const folders = [{ id: "folder:owned", path: f.directory, collapsed: false, pinned: true, open: false }];
		const revealGate = Promise.withResolvers<void>();
		const revealed: string[] = [];
		const provider = new harness.SessionTreeProvider({
			folders: () => folders, entries: () => f.index.list(), activeTabId: () => f.index.activeTabId,
			facts: () => ({ open: true, running: true, outcome: null, activity: null }),
			runtimeIdentity: () => null, observeOwnership: async () => ({ ownershipChecked: true }),
		});
		const revealOptions: unknown[] = [];
		const view = { visible: true, reveal: async (item: { tabId: string }, options: unknown) => {
			revealed.push(item.tabId);
			revealOptions.push(options);
			await revealGate.promise;
		} };
		harness.notificationTree(provider, view);
		const served = provider.onDidServeTree(() => { void harness.revealActiveSession(f.index); });
		try {
			await harness.revealActiveSession(f.index);
			assert.deepEqual(revealed, []);
			const roots = provider.getChildren();
			await nextTurn();
			assert.deepEqual(revealed, [], "served roots alone are not a revealable row");
			provider.getChildren(roots[0]);
			await nextTurn();
			assert.deepEqual(revealed, [f.row.tabId]);
			await f.index.setActiveTab(secondary.tabId);
			const latest = harness.revealActiveSession(f.index);
			folders.push({ id: "folder:later", path: path.join(f.directory, "later"), collapsed: false, pinned: true, open: false });
			provider.refresh();
			assert.deepEqual(provider.getChildren().map(row => row.id), ["folder:owned"], "structural publication cannot cancel an active reveal");
			revealGate.resolve();
			await latest;
			assert.deepEqual(revealed, [f.row.tabId], "the new active tab waits for the replacement parent publication");
			const currentRoots = provider.getChildren();
			provider.getChildren(currentRoots[0]);
			await nextTurn();
			await harness.revealActiveSession(f.index);
			assert.deepEqual(revealed, [f.row.tabId, secondary.tabId]);
			provider.refresh();
			await harness.revealActiveSession(f.index);
			assert.deepEqual(revealed, [f.row.tabId, secondary.tabId], "ordinary activity does not reselect a served path");
			folders[0] = { ...folders[0]!, collapsed: true };
			provider.refresh();
			provider.getChildren(currentRoots[0]);
			await nextTurn();
			await f.index.setActiveTab(f.row.tabId);
			await harness.revealActiveSession(f.index);
			assert.deepEqual(revealed, [f.row.tabId, secondary.tabId]);
			// Activating the session (a tab switch, a row click) is the one reveal allowed to expand the folder.
			const activeRoots = provider.getChildren();
			provider.getChildren(activeRoots[0]);
			await nextTurn();
			harness.requestSessionRowExpand(f.row.tabId);
			await harness.revealActiveSession(f.index);
			assert.deepEqual(revealed, [f.row.tabId, secondary.tabId, f.row.tabId], "activating the session reveals its row in the collapsed folder");
			assert.deepEqual(revealOptions.at(-1), { select: true, focus: false, expand: true });
			// The user collapses the folder again and stays on the same tab: nothing fights that.
			provider.refresh();
			await harness.revealActiveSession(f.index);
			await harness.revealActiveSession(f.index);
			assert.equal(revealed.length, 3, "the expansion was a one-shot answer to the activation");
		} finally {
			revealGate.resolve();
			served.dispose();
			provider.dispose();
			harness.notificationTree(undefined, undefined);
			f.chat.dispose();
			await f.index.closeSession(f.row.tabId, { confirmedStopped: true });
		}
	});



	it("keeps the same row and panel for a no-turn fileless replacement", async () => {
		const f = await fixture(true);
		try {
			await harness.switchSessionMode(f.saved.context, f.index, f.state, "terminal");
			assert.equal(f.launches(), 1);
			assert.equal(f.state.panel, f.panels);
			assert.equal(f.index.get(f.row.tabId)?.ordinal, f.row.ordinal);
			assert.equal(f.index.get(f.row.tabId)?.sessionFile, null);
			assert.equal(f.index.get(f.row.tabId)?.sessionId, "fresh-mode-session");
		} finally { f.chat.dispose(); await f.index.closeSession(f.row.tabId, { confirmedStopped: true }); }
	});

	it("Delete from either stopped-row command argument confirms before removing the file and row", async () => {
		for (const treeArgument of [true, false]) {
			const f = await fixture();
			f.state.runtime = null;
			await f.index.closeSession(f.row.tabId, { confirmedStopped: true });
			let dialogs = 0;
			harness.warning(async (_message, options, action) => {
				dialogs++;
				assert.equal(f.index.get(f.row.tabId)?.runIntent, "stopped");
				assert.ok(await readFile(f.file!, "utf8"), "the confirmation precedes file removal");
				assert.ok(options !== null && typeof options === "object" && "modal" in options && options.modal === true);
				return action;
			});
			try {
				await harness.deleteSession(f.index, treeArgument ? { tabId: f.row.tabId } : f.row.tabId);
				assert.equal(dialogs, 1);
				assert.equal(f.index.get(f.row.tabId), null);
				await assert.rejects(readFile(f.file!), { code: "ENOENT" });
				assert.equal(f.launches(), 0, "Delete does not start a stopped session");
			} finally { f.chat.dispose(); }
		}
	});

	it("a stalled stopped-row Delete preflight reports failure and never deletes after a late read", async t => {
		const f = await fixture();
		f.state.runtime = null;
		await f.index.closeSession(f.row.tabId, { confirmedStopped: true });
		const observation = Promise.withResolvers<{ ok: true; claim: null }>();
		f.index.observeOwnership = async () => await observation.promise;
		t.mock.timers.enable({ apis: ["setTimeout"] });
		try {
			const deleting = harness.deleteSession(f.index, { tabId: f.row.tabId });
			await nextTurn(); t.mock.timers.tick(5_000); await deleting;
			assert.equal(harness.errors().length, 1, "preflight failure is visible, not a silent rejected command");
			assert.equal(f.dialogs.length, 0);
			observation.resolve({ ok: true, claim: null }); await nextTurn();
			assert.ok(await readFile(f.file!, "utf8"));
			assert.notEqual(f.index.get(f.row.tabId), null);
		} finally {
			observation.resolve({ ok: true, claim: null }); t.mock.timers.reset(); f.chat.dispose();
		}
	});

	it("disables the active editor's view actions while busy confirmation is pending", async () => {
		const f = await fixture();
		await f.index.bindEditorSlot(EDITOR, f.row.tabId, "controlling");
		const state = harness.editor(f.index, {}, Object.assign(f.panels, { active: true }), EDITOR, f.row.tabId);
		state.runtime = f.native; state.bridge = null;
		harness.focusSession(true, EDITOR, f.row.tabId);
		const calls = harness.commandHandler(null);
		const requested = Promise.withResolvers<void>();
		const answer = Promise.withResolvers<unknown>();
		f.channel.child.isStreaming = true;
		harness.warning(() => { requested.resolve(); return answer.promise; });
		try {
			const switching = harness.switchSessionMode(f.saved.context, f.index, state, "terminal");
			await requested.promise;
			assert.ok(calls.some(call => call[0] === "setContext" && call[1] === "omp.sessionTransitionPending" && call[2] === true));
			assert.ok(f.panels.messages.some(message => message !== null && typeof message === "object" && "type" in message && message.type === "omp:session-view" && "canSwitch" in message && message.canSwitch === false));
			answer.resolve(undefined); await switching;
			assert.equal(calls.findLast(call => call[0] === "setContext" && call[1] === "omp.sessionTransitionPending")?.[2], false);
		} finally {
			answer.resolve(undefined); harness.commandHandler(null);
			f.chat.dispose(); await f.index.closeSession(f.row.tabId, { confirmedStopped: true });
		}
	});

	it("restores Chat admission if publishing the transition fence throws before state readback", async () => {
		const f = await fixture();
		const post = f.panels.webview.postMessage;
		let fail = true;
		// postMessage normally returns a thenable, but a disposed route can throw at dispatch.
		f.panels.webview.postMessage = message => {
			if (fail) { fail = false; throw new Error("fixture page publication failed"); }
			return post(message);
		};
		try {
			await harness.switchSessionMode(f.saved.context, f.index, f.state, "terminal");
			assert.equal(f.state.transitioning, false);
			assert.equal(f.state.runtime, f.native);
			assert.equal(f.launches(), 0);
			assert.equal((await f.chat.sessionOf(f.row.tabId)!.prompt({ requestId: "after-fence-error", text: "Continue" })).status, "accepted");
			await harness.switchSessionMode(f.saved.context, f.index, f.state, "terminal");
			assert.equal(f.launches(), 1, "a later explicit switch is still admitted");
		} finally { f.panels.webview.postMessage = post; f.chat.dispose(); await f.index.closeSession(f.row.tabId, { confirmedStopped: true }); }
	});

	it("times out a queued switch, restores Chat and never performs the expired switch later", async t => {
		const f = await fixture();
		const blocked = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		const held = f.index.lifecycle.run(f.row.tabId, async () => { entered.resolve(); await blocked.promise; });
		await entered.promise;
		t.mock.timers.enable({ apis: ["setTimeout"] });
		try {
			const switching = harness.switchSessionMode(f.saved.context, f.index, f.state, "terminal");
			await nextTurn();
			assert.equal(f.state.transitioning, true);
			t.mock.timers.tick(10_000);
			await switching;
			assert.equal(f.state.transitioning, false);
			assert.equal((await f.chat.sessionOf(f.row.tabId)!.prompt({ requestId: "after-switch-timeout", text: "Continue" })).status, "accepted");
			blocked.resolve(); await held;
			await f.index.lifecycle.run(f.row.tabId, async () => undefined);
			assert.equal(f.launches(), 0, "late gate acquisition must not start a successor");
			assert.equal(f.dialogs.length, 1, "the timeout has visible feedback, not a delayed busy dialog");
		} finally {
			blocked.resolve(); await held; t.mock.timers.reset();
			f.chat.dispose(); await f.index.closeSession(f.row.tabId, { confirmedStopped: true });
		}
	});

	it("fences busy input while consent is outside the gate, and cancellation keeps the old view usable", async () => {
		const f = await fixture();
		try {
			f.channel.child.isStreaming = true;
			const requested = Promise.withResolvers<void>(); const answer = Promise.withResolvers<unknown>();
			harness.warning(() => { requested.resolve(); return answer.promise; });
			const switching = harness.switchSessionMode(f.saved.context, f.index, f.state, "terminal");
			await bounded(requested.promise);
			await bounded(f.index.lifecycle.run(f.row.tabId, async () => undefined));
			assert.equal((await f.chat.sessionOf(f.row.tabId)!.prompt({ requestId: "during-dialog", text: "Do not send" })).status, "refused");
			answer.resolve(undefined); await switching;
			assert.equal(f.state.runtime, f.native);
			assert.equal(f.state.mode, "chat");
			assert.equal(f.state.transitioning, false);
			assert.equal(f.launches(), 0);
			assert.equal((await f.chat.sessionOf(f.row.tabId)!.prompt({ requestId: "after-dialog", text: "Continue" })).status, "accepted");
		} finally { f.chat.dispose(); await f.index.closeSession(f.row.tabId, { confirmedStopped: true }); }
	});

	it("refuses a changed target and content without a durable file before any stop", async () => {
		const f = await fixture(true);
		try {
			f.channel.child.entries = [messageEntry("unsaved", null, userMessage("Unsaved turn", 1))] as never;
			await harness.switchSessionMode(f.saved.context, f.index, f.state, "terminal");
			assert.equal(f.state.runtime, f.native);
			assert.equal((await f.native.handle.refreshStatus()).state, "running");
			assert.equal(f.launches(), 0);
			f.channel.child.entries = []; f.channel.child.isStreaming = true;
			harness.warning(async () => {
				f.channel.handlers.set("get_state", () => ({ data: { sessionId: "another-target", isStreaming: false, isSettled: true, messageCount: 0 } }));
				return "Switch to Terminal";
			});
			await harness.switchSessionMode(f.saved.context, f.index, f.state, "terminal");
			assert.equal(f.state.runtime, f.native);
			assert.equal((await f.native.handle.refreshStatus()).state, "running");
			assert.equal(f.launches(), 0);
		} finally { f.chat.dispose(); await f.index.closeSession(f.row.tabId, { confirmedStopped: true }); }
	});

	it("refuses a successor on an uncertain root and keeps admission fenced", async () => {
		const f = await fixture();
		try {
			f.native.handle.stop = async () => ({ pidGone: false, verified: false, tree: "unknown", nativePid: f.native.pid, remainingPids: [], detail: "root still alive" });
			await harness.switchSessionMode(f.saved.context, f.index, f.state, "terminal");
			assert.equal(f.launches(), 0);
			assert.equal(f.state.mode, "chat");
			assert.equal(f.state.runtime, f.native);
			assert.equal(f.state.transitioning, true);
			assert.equal((await f.chat.sessionOf(f.row.tabId)!.prompt({ requestId: "uncertain-root", text: "No second input" })).status, "refused");
			assert.equal(f.index.get(f.row.tabId)?.runIntent, "running");
		} finally { f.chat.dispose(); await f.index.closeSession(f.row.tabId, { confirmedStopped: true }); }
	});

	it("profile preference changes only new editors; ordinary Open reveals an existing actual mode", async () => {
		const f = await fixture();
		try {
			harness.picker("terminal");
			await harness.chooseDefaultSessionView(f.saved.context);
			assert.equal(harness.defaultSessionMode(storage().context), "chat", "another profile has its own default");
			assert.equal(harness.defaultSessionMode(f.saved.context), "terminal");
			await harness.openTab(f.saved.context, f.index, f.row.tabId, "resumed");
			assert.equal(f.state.mode, "chat");
			assert.equal(f.state.runtime, f.native);
			assert.equal(f.launches(), 0, "ordinary Open does not replace an already-open view");
			await harness.openSessionInMode(f.saved.context, f.index, f.row.tabId, "terminal");
			assert.equal(f.state.mode, "terminal");
			assert.equal(f.state.panel, f.panels);
			assert.equal(f.launches(), 1, "explicit mode action replaces in place");
		} finally { f.chat.dispose(); await f.index.closeSession(f.row.tabId, { confirmedStopped: true }); }
	});

	it("ordinary Open waits for the surviving Chat writer's pending initialization before applying the Terminal default", async () => {
		const f = await fixture();
		harness.picker("terminal"); await harness.chooseDefaultSessionView(f.saved.context);
		f.state.panel = null;
		const ready = Promise.withResolvers<void>();
		const attach = f.channel.attach.bind(f.channel);
		f.channel.attach = async request => { await ready.promise; return attach(request); };
		f.chat.startLive(f.row.tabId, { channel: f.channel, sessionFile: f.file, cwd: f.directory, title: null });
		let opening: Promise<void> | null = null;
		const restorePanels = harness.editorLifecycle();
		try {
			let completed = false;
			opening = harness.openTab(f.saved.context, f.index, f.row.tabId, "resumed").finally(() => { completed = true; });
			await nextTurn();
			assert.equal(completed, false, "an already-started RPC initialization must finish before refusing or switching");
			assert.equal(f.launches(), 0, "the RPC writer remains the only writer while its initial state attaches");
			ready.resolve();
			await opening;
			assert.equal(f.state.mode, "terminal");
			assert.equal(f.launches(), 1, "a closed editor's previous writer does not override the current default");
			assert.equal(f.index.slotBinding(f.state.slotId)?.mode, "terminal");
		} finally {
			ready.resolve(); await opening?.catch(() => undefined);
			restorePanels(); f.chat.dispose(); await f.index.closeSession(f.row.tabId, { confirmedStopped: true });
		}
	});

	it("failed pending RPC initialization refuses the mode change without stopping its writer", async () => {
		const f = await fixture();
		const ready = Promise.withResolvers<void>();
		const attach = f.channel.attach.bind(f.channel);
		f.channel.attach = async request => { await ready.promise; return attach(request); };
		f.channel.attachError = true;
		f.chat.startLive(f.row.tabId, { channel: f.channel, sessionFile: f.file, cwd: f.directory, title: null });
		let switching: Promise<void> | null = null;
		try {
			let completed = false;
			switching = harness.switchSessionMode(f.saved.context, f.index, f.state, "terminal").finally(() => { completed = true; });
			await nextTurn();
			assert.equal(completed, false);
			ready.resolve();
			await switching;
			assert.equal(f.state.mode, "chat");
			assert.equal(f.state.runtime, f.native);
			assert.equal(f.launches(), 0);
			assert.equal((await f.native.handle.refreshStatus()).state, "running", "a failed initialization cannot authorize a stop or successor");
		} finally {
			ready.resolve(); await switching?.catch(() => undefined);
			f.chat.dispose(); await f.index.closeSession(f.row.tabId, { confirmedStopped: true });
		}
	});

	it("a later explicit Chat action cancels a pending default Terminal Open", async () => {
		const f = await fixture();
		harness.picker("terminal"); await harness.chooseDefaultSessionView(f.saved.context);
		f.state.panel = null;
		const ready = Promise.withResolvers<void>();
		const attach = f.channel.attach.bind(f.channel);
		f.channel.attach = async request => { await ready.promise; return attach(request); };
		f.chat.startLive(f.row.tabId, { channel: f.channel, sessionFile: f.file, cwd: f.directory, title: null });
		const restorePanels = harness.editorLifecycle();
		let opening: Promise<void> | null = null;
		try {
			opening = harness.openTab(f.saved.context, f.index, f.row.tabId, "resumed");
			await nextTurn();
			await harness.openSessionInMode(f.saved.context, f.index, f.row.tabId, "chat");
			ready.resolve();
			await opening;
			assert.equal(f.state.mode, "chat");
			assert.equal(f.launches(), 0, "the superseded default request cannot replace the explicitly selected writer");
			assert.equal((await f.native.handle.refreshStatus()).state, "running");
		} finally {
			ready.resolve(); await opening?.catch(() => undefined);
			restorePanels(); f.chat.dispose(); await f.index.closeSession(f.row.tabId, { confirmedStopped: true });
		}
	});

	it("ordinary Open waits for the surviving native writer's pending control before applying the Chat default", async () => {
		const f = await fixture(false, "terminal");
		const native = terminalRuntime(f.native.pid, f.file, f.directory);
		f.state.runtime = native; f.state.panel = null;
		const connected = Promise.withResolvers<void>();
		harness.hostControlAttempts.set(native, connected.promise);
		const restorePanels = harness.editorLifecycle();
		try {
			let completed = false;
			const opening = harness.openTab(f.saved.context, f.index, f.row.tabId, "resumed").finally(() => { completed = true; });
			await nextTurn();
			assert.equal(completed, false, "an already-started authentication attempt must finish before refusing or switching");
			assert.equal(f.launches(), 0, "the native writer remains the only writer while control is connecting");
			const control = nativeControl(f);
			control.control.nativeShutdown = async () => { native.exit(); f.native.exit(); return "accepted"; };
			connected.resolve();
			await opening;
			assert.equal(f.state.mode, "chat");
			assert.equal(f.launches(), 1);
			assert.equal(f.index.slotBinding(f.state.slotId)?.mode, "chat");
			assert.equal((await native.handle.refreshStatus()).state, "exited", "the old native writer exits before Chat starts");
		} finally {
			connected.resolve(); harness.hostControlAttempts.delete(native);
			restorePanels(); f.state.nativeWatch?.(); f.state.pipeline?.dispose();
			f.chat.dispose(); await f.index.closeSession(f.row.tabId, { confirmedStopped: true });
		}
	});

	it("closing the editor cancels a native mode change waiting for authentication", async () => {
		const f = await fixture(false, "terminal");
		const native = terminalRuntime(f.native.pid, f.file, f.directory);
		f.state.runtime = native;
		const connected = Promise.withResolvers<void>();
		harness.hostControlAttempts.set(native, connected.promise);
		const restorePanels = harness.editorLifecycle();
		const panel = harness.createPanel();
		try {
			harness.bindPanel(f.saved.context, f.index, f.state.slotId, f.row.tabId, panel, "created");
			await nextTurn();
			const switching = harness.switchSessionMode(f.saved.context, f.index, f.state, "chat");
			await nextTurn();
			panel.dispose();
			connected.resolve();
			await switching;
			assert.equal(f.state.panel, null);
			assert.equal(f.state.mode, "terminal", "a closed editor must not retain the cancelled mode request");
			assert.equal(f.launches(), 0);
			assert.equal((await native.handle.refreshStatus()).state, "running", "closing while authentication waits does not stop the old writer");
		} finally {
			connected.resolve(); harness.hostControlAttempts.delete(native);
			restorePanels(); f.state.nativeWatch?.(); f.state.pipeline?.dispose();
			f.chat.dispose(); await f.index.closeSession(f.row.tabId, { confirmedStopped: true });
		}
	});

	for (const mode of ["chat", "terminal"] as const) {
		it(`explicit Open in ${mode} overrides the opposite default for a new editor`, async () => {
			const f = await fixture(false, mode);
			if (mode === "terminal") f.state.runtime = terminalRuntime(f.native.pid, f.file, f.directory);
			f.state.panel = null;
			harness.picker(mode === "chat" ? "terminal" : "chat"); await harness.chooseDefaultSessionView(f.saved.context);
			const restorePanels = harness.editorLifecycle();
			try {
				await harness.openSessionInMode(f.saved.context, f.index, f.row.tabId, mode);
				await nextTurn();
				assert.equal(f.state.mode, mode);
				assert.equal(f.index.slotBinding(f.state.slotId)?.mode, mode);
				assert.equal(f.launches(), 0, "matching the explicit view reuses its surviving writer");
			} finally {
				restorePanels(); f.state.nativeWatch?.(); f.state.pipeline?.dispose();
				f.chat.dispose(); await f.index.closeSession(f.row.tabId, { confirmedStopped: true });
			}
		});
	}

	it("folder New Session uses the persisted default; stopped single-click never starts native", async () => {
		const f = await fixture();
		try {
			harness.picker("terminal"); await harness.chooseDefaultSessionView(f.saved.context);
			harness.folders([{ id: "folder-mode", path: f.directory, collapsed: false, pinned: true, open: false }]);
			const requests: { transport?: string; sessionFile: string | null }[] = [];
			harness.policy(f.saved.context, {
				readProcessIdentity: async () => ({ kind: "gone" }), isProcessAlive: () => false,
				probeRpc: async () => ({ kind: "unreachable", reason: "gone" }), brokerProvenance: () => ({ kind: "none" }),
			}, { launch: async (request: { transport?: string; sessionFile: string | null }) => {
				requests.push(request); return { state: "not-started", reason: "fixture prevents native spawn" };
			}, attach: async () => ({ state: "unavailable", reason: "not needed" }) }, {});
			const restorePanels = harness.editorLifecycle();
			try {
				await harness.newSession(f.saved.context, f.index, undefined);
				assert.deepEqual(requests.map(request => [request.transport, request.sessionFile]), [["native", null]]);
				const draft = f.index.list().find(entry => entry.tabId !== f.row.tabId)!;
				await nextTurn();
				const opened = harness.state(draft.tabId);
				assert.equal(opened.mode, "terminal");
				assert.equal(f.index.slotBinding(opened.slotId)?.mode, "terminal");
				await harness.openTab(f.saved.context, f.index, draft.tabId, "opened");
				assert.equal(requests.length, 1, "a stopped single click only paints its placeholder");
				assert.equal(harness.state(draft.tabId).mode, "terminal");
				assert.equal(f.index.get(draft.tabId)?.runIntent, "stopped");
			} finally { restorePanels(); }
		} finally { f.chat.dispose(); await f.index.closeSession(f.row.tabId, { confirmedStopped: true }); }
	});

	it("busy consent aborts RPC before settling and launches only after the root exits", async () => {
		const f = await fixture();
		try {
			f.channel.child.isStreaming = true;
			f.channel.handlers.set("abort", () => { f.channel.child.isStreaming = false; return { data: {} }; });
			await harness.switchSessionMode(f.saved.context, f.index, f.state, "terminal");
			assert.equal(f.channel.commandsOfType("abort").length, 1);
			assert.equal(f.launches(), 1);
			assert.equal(f.dialogs.length, 1);
			assert.equal(f.state.panel, f.panels);
		} finally { f.chat.dispose(); await f.index.closeSession(f.row.tabId, { confirmedStopped: true }); }
	});

	it("native to Chat uses guarded SDK shutdown, not broker force, on the same exact file", async () => {
		const f = await fixture(false, "terminal");
		const control = nativeControl(f);
		try {
			f.native.handle.stop = async () => { throw new Error("PTY close is not graceful SDK disposal"); };
			await harness.switchSessionMode(f.saved.context, f.index, f.state, "chat");
			assert.deepEqual(control.shutdowns, [{ target: { epoch: "native-fixture-epoch", sessionFile: f.file, sessionId: "mode-session" }, consent: false }]);
			assert.equal(f.launches(), 1);
			assert.equal(f.state.mode, "chat");
			assert.equal(f.state.panel, f.panels);
			assert.equal(f.index.get(f.row.tabId)?.sessionFile, f.file);
			assert.equal(f.index.get(f.row.tabId)?.sessionId, "mode-session");
			assert.deepEqual(f.dialogs, []);
		} finally { f.chat.dispose(); await f.index.closeSession(f.row.tabId, { confirmedStopped: true }); }
	});

	it("bounds an unanswered shutdown and its Stop action recovers without launching a late successor", { timeout: 8_000 }, async t => {
		const f = await fixture(false, "terminal");
		const control = nativeControl(f);
		const shutdown = Promise.withResolvers<string>();
		const requested = Promise.withResolvers<void>();
		const recovery = Promise.withResolvers<string>();
		const stopped = Promise.withResolvers<void>();
		const stop = f.native.handle.stop;
		f.native.handle.stop = async () => { const result = await stop(); stopped.resolve(); return result; };
		control.control.nativeShutdown = async () => { requested.resolve(); return await shutdown.promise; };
		let offered = false;
		harness.warning(async (_message, options, action) => {
			if (options === "Stop Session") { offered = true; return await recovery.promise; }
			return action;
		});
		t.mock.timers.enable({ apis: ["setTimeout"] });
		try {
			const switching = harness.switchSessionMode(f.saved.context, f.index, f.state, "chat");
			await requested.promise;
			t.mock.timers.tick(10_000);
			await switching;
			assert.equal(offered, true);
			assert.equal(f.state.transitioning, true, "an irreversible shutdown must not reopen input");
			assert.equal(f.launches(), 0);
			shutdown.resolve("accepted"); await nextTurn();
			assert.equal(f.launches(), 0, "late acknowledgement never launches a successor");
			recovery.resolve("Stop Session");
			await stopped.promise;
			await f.index.lifecycle.run(f.row.tabId, async () => undefined);
			await nextTurn();
			assert.equal(f.state.runtime, null);
			assert.equal(f.state.transitioning, false);
			assert.equal(f.index.get(f.row.tabId)?.runIntent, "stopped");
			assert.equal(f.launches(), 0, "recovery stops only; a later explicit Open owns any successor");
		} finally {
			recovery.resolve("Stop Session");
			shutdown.resolve("accepted"); t.mock.timers.reset();
			f.chat.dispose(); await f.index.closeSession(f.row.tabId, { confirmedStopped: true });
		}
	});

	it("an unanswered native shutdown keeps its irreversible stopping fence and never replaces", async () => {
		const f = await fixture(false, "terminal");
		const control = nativeControl(f);
		try {
			control.control.nativeShutdown = async () => { throw new Error("acknowledgement lost after request"); };
			await harness.switchSessionMode(f.saved.context, f.index, f.state, "chat");
			assert.equal(f.launches(), 0);
			assert.equal(f.native.stopping, true);
			assert.equal(f.state.transitioning, true);
			assert.equal(f.state.runtime, f.native);
			assert.equal(f.state.mode, "terminal");
			await harness.openSessionInMode(f.saved.context, f.index, f.row.tabId, "chat");
			assert.equal(f.launches(), 0, "an explicit retry cannot overlap the possibly stopping root");
		} finally { f.chat.dispose(); await f.index.closeSession(f.row.tabId, { confirmedStopped: true }); }
	});

	it("native Rename and Reload use SDK readback and keep the actual mode and panel", async () => {
		const f = await fixture(false, "terminal");
		const control = nativeControl(f);
		try {
			await harness.renameSession(f.saved.context, f.index, f.row.tabId);
			assert.equal(f.index.get(f.row.tabId)?.title, "Recovered draft title");
			assert.equal(control.facts.name, "Recovered draft title");
			await harness.reloadSession(f.saved.context, f.index, f.row.tabId);
			assert.equal(f.state.mode, "terminal");
			assert.equal(f.state.panel, f.panels);
			assert.equal(f.launches(), 1);
			assert.equal(control.shutdowns.length, 1);
			assert.equal(f.dialogs.length, 1, "Reload retains its explicit confirmation");
		} finally { f.chat.dispose(); await f.index.closeSession(f.row.tabId, { confirmedStopped: true }); }
	});

	it("native Close gracefully shuts down its SDK and an observed forced survivor refuses a successor", async () => {
		const f = await fixture(false, "terminal");
		const control = nativeControl(f);
		try {
			f.native.handle.stop = async () => { throw new Error("ordinary Close must not force a native PTY"); };
			await harness.closeSession(f.saved.context, f.index, f.row.tabId);
			assert.equal(control.shutdowns.length, 1);
			assert.equal(f.index.get(f.row.tabId)?.runIntent, "stopped");
			assert.equal(f.state.runtime, null);
			assert.equal(f.launches(), 0);
		} finally { f.chat.dispose(); await f.index.closeSession(f.row.tabId, { confirmedStopped: true }); }
		const survivor = await fixture(false, "terminal");
		try {
			survivor.native.handle.stop = async () => {
				survivor.native.exit();
				return { pidGone: true, verified: false, tree: "unknown", nativePid: survivor.native.pid, remainingPids: [42002], detail: "root exited but child remains" };
			};
			await harness.closeSession(survivor.saved.context, survivor.index, survivor.row.tabId);
			assert.deepEqual(survivor.native.observedSurvivors, [42002]);
			assert.equal(survivor.state.runtime, survivor.native);
			assert.equal(survivor.state.transitioning, true);
			await harness.openSessionInMode(survivor.saved.context, survivor.index, survivor.row.tabId, "chat");
			assert.equal(survivor.launches(), 0);
		} finally { survivor.chat.dispose(); await survivor.index.closeSession(survivor.row.tabId, { confirmedStopped: true }); }
	});

	it("native Delete fences first, disposes through the SDK and deletes only the captured exact file", async () => {
		const f = await fixture(false, "terminal");
		const control = nativeControl(f);
		try {
			f.native.handle.stop = async () => { throw new Error("Delete must gracefully dispose the native SDK before removal"); };
			assert.equal(await harness.confirmAndDeleteSession(f.index, f.row.tabId), true, JSON.stringify({ dialogs: f.dialogs, errors: harness.errors() }));
			assert.equal(control.shutdowns.length, 1);
			assert.equal(f.index.get(f.row.tabId), null);
			assert.equal(f.panels.disposed, true);
			await assert.rejects(readFile(f.file!), { code: "ENOENT" });
			assert.equal(f.launches(), 0);
		} finally { f.chat.dispose(); if (f.index.get(f.row.tabId) !== null) await f.index.closeSession(f.row.tabId, { confirmedStopped: true }); }
	});

	it("records a reattached writer's actual mode instead of its provisional selected mode", async () => {
		const f = await fixture();
		try {
			await f.index.setEditorMode(f.state.slotId, "terminal");
			f.state.mode = "terminal";
			await harness.startConversation(f.index, f.row.tabId, { ...f.native, kind: "chat", handle: f.channel }, f.file, false);
			const reloaded = new harness.SessionIndex({ claimStorageDir: path.join(f.directory, "claims"), store: {
				get<T>(key: string) { return f.values.get(key) as T | undefined; },
				async update(key: string, value: unknown) { f.values.set(key, value); },
			} });
			assert.equal(reloaded.slotBinding(f.state.slotId)?.mode, "chat", "restart must restore the actual Chat writer, not the earlier Terminal selection");
			await harness.startConversation(f.index, f.row.tabId, terminalRuntime(f.native.pid, f.file, f.directory), f.file, false);
			assert.equal(f.index.slotBinding(f.state.slotId)?.mode, "terminal", "native reattachment records the actual mode too");
		} finally {
			f.state.nativeWatch?.(); f.state.pipeline?.dispose();
			f.chat.dispose(); await f.index.closeSession(f.row.tabId, { confirmedStopped: true });
		}
	});

	it("deserializes mixed saved editor modes independently of the current Terminal default", async () => {
		const f = await fixture(true);
		const restorePanels = harness.editorLifecycle();
		try {
			await f.index.closeSession(f.row.tabId, { confirmedStopped: true });
			f.chat.release(f.row.tabId); f.state.runtime = null; f.state.panel = null;
			await harness.openTab(f.saved.context, f.index, f.row.tabId, "opened");
			const chatEditor = harness.state(f.row.tabId);
			const second = await f.index.createDraft({ cwd: f.directory });
			await f.index.closeSession(second.tabId, { confirmedStopped: true });
			harness.picker("terminal"); await harness.chooseDefaultSessionView(f.saved.context);
			await harness.openTab(f.saved.context, f.index, second.tabId, "opened");
			await nextTurn();
			const terminalEditor = harness.state(second.tabId);
			const saved = [chatEditor, terminalEditor].map(editor => ({
				tabId: editor.tabId!, editorId: editor.slotId, mode: editor.mode,
				viewType: (editor.panel as LifecyclePanel).viewType,
			}));
			assert.deepEqual(saved.map(editor => editor.mode), ["chat", "terminal"]);
			for (const editor of [chatEditor, terminalEditor]) (editor.panel as LifecyclePanel).dispose();
			const reloaded = new harness.SessionIndex({ claimStorageDir: path.join(f.directory, "claims"), store: {
				get<T>(key: string) { return f.values.get(key) as T | undefined; },
				async update(key: string, value: unknown) { f.values.set(key, value); },
			} });
			harness.reset(reloaded, f.chat);
			for (const editor of saved) {
				const panel = harness.createPanel();
				await harness.bridgeSerializerFor(f.saved.context, reloaded, editor.viewType).deserializeWebviewPanel(panel, {
					version: 2, tabId: editor.tabId, editorId: editor.editorId,
				});
				assert.equal(harness.state(editor.editorId).mode, editor.mode);
				assert.equal(reloaded.slotBinding(editor.editorId)?.mode, editor.mode);
				panel.dispose();
			}
			assert.equal(f.launches(), 0, "restoring stopped editors must not start either writer");
		} finally {
			restorePanels(); f.chat.dispose(); await f.index.closeSession(f.row.tabId, { confirmedStopped: true });
		}
	});

	it("restores the saved stopped Terminal mode ahead of the profile's Chat default without launching", async () => {
		const f = await fixture(true);
		try {
			await f.index.closeSession(f.row.tabId, { confirmedStopped: true });
			f.chat.release(f.row.tabId); f.state.runtime = null; f.state.panel = null;
			await f.index.setEditorMode(f.row.tabId, "terminal");
			assert.equal(harness.defaultSessionMode(f.saved.context), "chat");
			await harness.openTab(f.saved.context, f.index, f.row.tabId, "opened", "restored");
			assert.equal(f.state.mode, "terminal");
			assert.equal(f.launches(), 0);
			assert.equal(f.index.get(f.row.tabId)?.runIntent, "stopped");
		} finally { f.chat.dispose(); await f.index.closeSession(f.row.tabId, { confirmedStopped: true }); }
	});
});

describe("active native editor clipboard", () => {
  it("copies only the latest user-requested current document, including a stopped passive screen", async () => {
    const index = indexFixture(runtime(892));
    index.slotBinding = () => ({ tabId: TAB, role: "passive" });
    harness.reset(index, null);
    const otherEditor = "d".repeat(32);
    const messages: { type: string; requestId?: string }[] = [];
    const inactiveMessages: unknown[] = [];
    const inactive = { active: false, visible: true, webview: { postMessage: async (message: unknown) => { inactiveMessages.push(message); return true; } } };
    const active = { active: true, visible: true, webview: { postMessage: async (message: { type: string; requestId?: string }) => { messages.push(message); return true; } } };
    harness.editor(index, {}, inactive);
    const state = harness.editor(index, {}, active, otherEditor);
    state.mode = "terminal";
    state.runtime = null;
    const generation = "a".repeat(32);
    state.pipeline = { generation, dispose() {} };
    harness.focusSession(true, otherEditor);
    const warnings: string[] = [];
    harness.warning(message => { warnings.push(String(message)); });
    const answer = (requestId: string, text = "screen α🙂\r\n\tend") => harness.handlePassiveSlotMessage(otherEditor, active, {
      type: "omp:terminal-copy-reply", requestId, generation, text,
    });
    await answer("f".repeat(32));
    assert.deepEqual(harness.clipboardWrites(), []);
    harness.copyActiveTerminalScreen();
    const superseded = messages.at(-1)!.requestId!;
    harness.copyActiveTerminalScreen();
    const current = messages.at(-1)!.requestId!;
    await answer(superseded);
    assert.deepEqual(harness.clipboardWrites(), []);
    await answer(current);
    assert.deepEqual(harness.clipboardWrites(), ["screen α🙂\r\n\tend"], warnings.join("\n"));
    await answer(current, "replayed hostile output");
    assert.deepEqual(harness.clipboardWrites(), ["screen α🙂\r\n\tend"]);
    assert.deepEqual(inactiveMessages, [], "another visible split editor must not be copied");
    harness.copyActiveTerminalScreen();
    const oldGeneration = messages.at(-1)!.requestId!;
    state.pipeline = { generation: "b".repeat(32), dispose() {} };
    await answer(oldGeneration);
    assert.deepEqual(harness.clipboardWrites(), ["screen α🙂\r\n\tend"]);
    state.pipeline = { generation, dispose() {} };
    harness.copyActiveTerminalScreen();
    const oldDocument = messages.at(-1)!.requestId!;
    state.document = { kind: "guest", bridgeDocumentId: DOCUMENT };
    await answer(oldDocument);
    assert.deepEqual(harness.clipboardWrites(), ["screen α🙂\r\n\tend"]);
    harness.focusSession(false);
    harness.copyActiveTerminalScreen();
    assert.equal(messages.at(-1)!.requestId, oldDocument, "a text editor cannot copy another visible OMP editor");
  });
});

describe("editors VS Code restored but has not shown yet", () => {
  /** A tab id per test: the editor reservations of this window outlive one test. */
  const tabFor = (n: number) => `tab:99999999-2222-4333-8444-55555555555${n}`;
  const revived = () => ({ active: true, visible: true, reveal() {}, webview: { postMessage: async () => true } });

  it("selects the tab through its group and position and waits for the panel VS Code then hands over", async () => {
    const slot = "e".repeat(32);
    const TAB_B = tabFor(1);
    const index = indexFixture(runtime(901));
    harness.reset(index, null);
    harness.editor(index, {}, null, slot, TAB_B);
    index.slotBinding().tabId = TAB_B;
    const groups = harness.tabStrip([[harness.viewTypeOf(TAB_B, "f".repeat(32))], [harness.viewTypeOf(TAB, "a".repeat(32)), harness.viewTypeOf(TAB_B, slot)]], 0);
    const panel = revived();
    const calls = harness.commandHandler((command, argument) => {
      if (command !== "workbench.action.openEditorAtIndex") return;
      groups[1]!.tabs[argument as number]!.isActive = true;
      harness.bindRevived(slot, panel);
    });
    // The second group is not the active one, so it is focused first.
    const shown = await harness.reviveEditorPanel(index, TAB_B);
    assert.deepEqual(calls, [["workbench.action.focusSecondEditorGroup"], ["workbench.action.openEditorAtIndex", 1]]);
    assert.equal(shown.selected, true);
    assert.equal(shown.panel, panel, "the panel the serializer was handed is the one returned");
    harness.commandHandler(null);
    harness.tabStrip([]);
  });

  it("selects a page that survived an extension-host restart without waiting for a handle it will never get", async () => {
    const slot = "d".repeat(32);
    const TAB_B = tabFor(2);
    const index = indexFixture(runtime(902));
    harness.reset(index, null);
    harness.editor(index, {}, null, slot, TAB_B);
    harness.markPageRunning(slot);
    const groups = harness.tabStrip([[harness.viewTypeOf(TAB_B, slot)]], 0);
    const calls = harness.commandHandler((command, argument) => {
      if (command === "workbench.action.openEditorAtIndex") groups[0]!.tabs[argument as number]!.isActive = true;
    });
    const started = Date.now();
    const shown = await harness.reviveEditorPanel(index, TAB_B);
    assert.ok(Date.now() - started < 1_000, "no five-second wait for a panel that cannot arrive");
    assert.deepEqual(calls, [["workbench.action.openEditorAtIndex", 0]]);
    assert.deepEqual({ selected: shown.selected, panel: shown.panel }, { selected: true, panel: null });
    harness.commandHandler(null);
    harness.tabStrip([]);
  });

  it("reports that nothing was selected when VS Code has no tab for the editor", async () => {
    const slot = "c".repeat(32);
    const TAB_B = tabFor(3);
    const index = indexFixture(runtime(903));
    harness.reset(index, null);
    harness.editor(index, {}, null, slot, TAB_B);
    harness.tabStrip([]);
    const calls = harness.commandHandler(null);
    const shown = await harness.reviveEditorPanel(index, TAB_B);
    assert.deepEqual({ selected: shown.selected, panel: shown.panel }, { selected: false, panel: null });
    assert.deepEqual(calls, []);
  });

  it("opening a row whose editor VS Code restored shows that editor instead of warning that it is already open", async () => {
    const slot = "b".repeat(32);
    const TAB_B = tabFor(4);
    const index = indexFixture(runtime(904));
    harness.reset(index, null);
    harness.editor(index, {}, null, slot, TAB_B);
    index.slotBinding().tabId = TAB_B;
    const groups = harness.tabStrip([[harness.viewTypeOf(TAB_B, slot)]], 0);
    const panel = revived();
    const calls = harness.commandHandler((command, argument) => {
      if (command !== "workbench.action.openEditorAtIndex") return;
      groups[0]!.tabs[argument as number]!.isActive = true;
      harness.bindRevived(slot, panel);
    });
    const warnings: string[] = [];
    harness.warning(message => { warnings.push(String(message)); });
    harness.openPanel({ extensionUri: { fsPath: root } }, index, TAB_B);
    for (let turn = 0; turn < 20 && calls.length === 0; turn++) await nextTurn();
    assert.deepEqual(calls, [["workbench.action.openEditorAtIndex", 0]]);
    assert.deepEqual(warnings, [], "no \"already open\" warning without showing the tab");
    harness.commandHandler(null);
    harness.tabStrip([]);
  });

  it("lets a revived editor finish taking its seat before Reload or a mode switch acts on it", async () => {
    const slot = "a".repeat(32);
    const TAB_B = tabFor(5);
    const index = indexFixture(runtime(905));
    harness.reset(index, null);
    harness.editor(index, {}, null, slot, TAB_B);
    const binding = index.slotBinding();
    binding.tabId = TAB_B;
    // VS Code hands the panel over first; this window records the editor's control a moment later.
    binding.role = "passive";
    const groups = harness.tabStrip([[harness.viewTypeOf(TAB_B, slot)]], 0);
    const panel = revived();
    harness.commandHandler((command, argument) => {
      if (command !== "workbench.action.openEditorAtIndex") return;
      groups[0]!.tabs[argument as number]!.isActive = true;
      harness.bindRevived(slot, panel);
      void nextTurn().then(() => { binding.role = "controlling"; });
    });
    const shown = await harness.reviveEditorPanel(index, TAB_B);
    assert.equal(shown.panel, panel);
    assert.equal(binding.role, "controlling", "revive returns only once the editor controls its session, so Reload is not refused as passive");
    harness.commandHandler(null);
    harness.tabStrip([]);
  });
});

describe("owning-window navigation", () => {
  it("uses a saved workspace identity for multiple roots and limits unsaved multi-root windows", () => {
    const one = URI.file("C:/sample/one");
    const two = URI.file("C:/sample/two");
    const saved = URI.file("C:/sample/sample.code-workspace");
    harness.setWindowWorkspace(undefined, [{ uri: one }]);
    assert.equal(harness.owningWindowUri()?.toString(), one.toString());
    harness.setWindowWorkspace(undefined, [{ uri: one }, { uri: two }]);
    assert.equal(harness.owningWindowUri(), null);
    harness.setWindowWorkspace(saved, [{ uri: one }, { uri: two }]);
    assert.equal(harness.owningWindowUri()?.toString(), saved.toString());
    harness.setWindowWorkspace(URI.parse("untitled:workspace"), [{ uri: one }]);
    assert.equal(harness.owningWindowUri(), null);
    harness.setWindowWorkspace(undefined, []);
  });

  it("routes to the verified holder's workspace rather than the session cwd and never launches", async () => {
    const owner = harness.createClaimHolder();
    const target = URI.file("C:/sample/sample.code-workspace");
    const index = {
      claimHolder: { id: "this-window" },
      observeOwnership: async () => ({ ok: true, claim: { verifiable: true, holderId: owner.id, pid: owner.pid, windowUri: target.toString() } }),
    };
    const calls = harness.commandHandler(null);
    await harness.switchToSessionWindow(index, TAB);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.[0], "vscode.openFolder");
    assert.equal((calls[0]?.[1] as URI).toString(), target.toString());
    assert.deepEqual(calls[0]?.[2], { forceNewWindow: false });
    harness.commandHandler(null);
  });
});

describe("a command sent while its editor is still being elected", () => {
  const SCOPE = "11111111-2222-4333-8444-555555555555";
  const PROMPT = { type: "omp:chat-prompt", requestId: "0123456789abcdef0123456789abcdef", text: "hello during startup" };
  const SNAPSHOT = { type: "omp:control-request", scope: SCOPE, requestId: 1, action: "snapshot" };

  async function until(condition: () => boolean): Promise<void> {
    for (let turn = 0; turn < 400 && !condition(); turn++) await new Promise(resolve => setTimeout(resolve, 5));
  }

  /** One session row, a live conversation on a fake child, and a durable store whose writes the test can hold. */
  async function setup(rival: boolean) {
    const saved = storage();
    const directory = await mkdtemp(path.join(root, "elect-"));
    const file = path.join(directory, "session.jsonl");
    await writeFile(file, sessionFileText({ id: "elect-session", cwd: directory, entries: [] }));
    const values = new Map<string, unknown>();
    const store = { hold: null as Promise<void> | null };
    const claimStorageDir = path.join(directory, "claims");
    const index = new harness.SessionIndex({ claimStorageDir, store: {
      get<T>(key: string) { return values.get(key) as T | undefined; },
      async update(key: string, value: unknown) { if (store.hold !== null) await store.hold; values.set(key, value); },
    } });
    const row = await index.trackSession({ sessionFile: file, cwd: directory });
    const claim = rival ? await harness.acquireClaim(claimStorageDir, file, "remote-window-owner", harness.createClaimHolder()) : null;
    const channel = new FakeRpcChannel({ sessionFile: file, sessionId: "elect-session" });
    const chat = new ChatRuntime({ hostNonce: path.basename(directory), onEvent() {} });
    await chat.startLive(row.tabId, { channel, sessionFile: file, cwd: directory, title: null }).start();
    harness.reset(index, chat);
    const restore = harness.editorLifecycle();
    const panel = harness.createPanel();
    const slot = "e".repeat(32);
    const release = Promise.withResolvers<void>();
    store.hold = release.promise;
    harness.bindPanel(saved.context, index, slot, row.tabId, panel, "created");
    const posted = () => panel.messages as { type: string; requestId?: number; available?: boolean; reason?: string; frame?: { type: string; message?: string } }[];
    // The control request created this conversation's footer binding, whose Git-branch observer may
    // still have a `git` child running in the session's working directory. Disposing it kills the
    // child; waiting for it is what lets the directory be removed afterwards.
    const cleanup = async () => {
      release.resolve(); await claim?.release();
      const exited = harness.footerIdle();
      harness.forgetTurnActivity(index, row.tabId);
      await exited;
      restore(); chat.dispose();
    };
    return { slot, panel, channel, release, posted, cleanup, store };
  }

  it("is held until the editor controls its session, then delivered once and answered", async () => {
    const f = await setup(false);
    try {
      assert.notEqual(harness.passiveReasonForSlot(f.slot), null, "the election has not been recorded yet, so the editor cannot act");
      f.panel.receive(SNAPSHOT);
      f.panel.receive(PROMPT);
      await until(() => f.channel.commandsOfType("prompt").length > 0);
      assert.equal(f.channel.commandsOfType("prompt").length, 0, "a non-controlling editor must never send");
      f.release.resolve();
      await until(() => f.channel.commandsOfType("prompt").length > 0 && f.posted().some(message => message.type === "omp:control-state"));
      assert.equal(harness.passiveReasonForSlot(f.slot), null);
      assert.equal(f.channel.commandsOfType("prompt").length, 1, "delivered once, neither lost nor repeated");
      assert.equal(f.channel.commandsOfType("prompt")[0]!.message, PROMPT.text);
      const answers = f.posted().filter(message => message.type === "omp:control-state");
      assert.deepEqual(answers.map(message => message.requestId), [1], "the footer's request is answered, not left waiting");
    } finally { await f.cleanup(); }
  });

  it("is refused visibly, and never sent, when the election is lost", async () => {
    const f = await setup(true);
    try {
      f.panel.receive(SNAPSHOT);
      f.panel.receive(PROMPT);
      f.release.resolve();
      await until(() => f.posted().some(message => message.type === "omp:control-state") && f.posted().some(message => message.frame?.type === "command_feedback"));
      assert.notEqual(harness.passiveReasonForSlot(f.slot), null, "another window holds the session");
      assert.equal(f.channel.commandsOfType("prompt").length, 0, "a non-controlling editor must never send");
      const answer = f.posted().find(message => message.type === "omp:control-state");
      assert.equal(answer?.available, false);
      assert.ok((answer?.reason ?? "").length > 0, "the unavailable control answer explains why");
      const feedback = f.posted().find(message => message.frame?.type === "command_feedback");
      assert.equal(feedback?.frame?.message, answer?.reason, "prompt feedback carries the same visible refusal");
    } finally { await f.cleanup(); }
  });
});

describe("Resume from a stopped Chat", () => {
  async function settle<T>(read: () => T | null | false | undefined): Promise<T> {
    for (let turn = 0; turn < 600; turn++) {
      const value = read();
      if (value !== null && value !== false && value !== undefined) return value;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error("the page never showed the expected state");
  }

  /** A stopped session: its process exited, so its row has no runtime, and the page still shows the Resume button. */
  async function stoppedChat(release: boolean, restore: (options: { allowStoppedResume: boolean }, index: Record<string, unknown>, native: ReturnType<typeof runtime>) => Promise<unknown>) {
    const saved = storage(); const native = runtime(871);
    await writeFile(native.sessionFile, sessionFileText({ id: "session-1", cwd: root, entries: [] }));
    const base = indexFixture(native);
    (base.row as { host: unknown }).host = null;
    const restores: { allowStoppedResume: boolean }[] = [];
    const index: Record<string, unknown> = { ...base, restore: async (_tabId: string, options: { allowStoppedResume: boolean }) => {
      restores.push(options);
      return await restore(options, index, native);
    } };
    const host = new ChatRuntime({ hostNonce: "stopped-host",
      onEvent: (tabId, event) => { if (event.type === "resume-requested") harness.handleChatEvent(saved.context, index, tabId, event); },
      createSession: options => new RpcSession({ ...options, timers: new ManualTimers() }),
    });
    const rendered = new ChatClient({ post: message => { void host.handleMessage(TAB, message as ChatWebviewMessage, null); return true; } });
    host.attachPage(TAB, { id: "page", post: message => { rendered.handle(message); return "sent"; } });
    harness.reset(index, host);
    const panel = { reveal() {}, viewType: "omp.session", webview: { html: "", cspSource: "vscode-webview://test",
      asWebviewUri: (uri: unknown) => uri, postMessage: async () => true } };
    harness.editor(index, {}, panel);
    const channel = new FakeRpcChannel({ sessionFile: native.sessionFile, sessionId: "session-1" });
    await bounded(host.startLive(TAB, { channel, sessionFile: native.sessionFile, cwd: root, title: null }).start());
    assert.equal(rendered.getSnapshot().phase, "live");
    channel.closeLink("child-exited");
    await settle(() => rendered.getSnapshot().phase === "stopped");
    if (release) host.release(TAB);
    return { saved, native, index, host, rendered, restores };
  }

  for (const release of [false, true]) {
    it(`starts the session again through the row's Open admission and becomes writable (${release ? "conversation released" : "stopped conversation kept"})`, async () => {
      const f = await stoppedChat(release, async (_options, index, native) => {
        const resumed = new FakeRpcChannel({ sessionFile: native.sessionFile, sessionId: "session-1" });
        const next = { ...runtime(872), handle: Object.assign(resumed, runtime(872).handle) };
        await harness.startConversation(index, TAB, next, native.sessionFile, false);
        return { status: "restored", tabId: TAB, sessionFile: native.sessionFile, host: { pid: next.pid } };
      });
      try {
        assert.equal(f.rendered.getSnapshot().phase, "stopped");
        assert.equal(f.rendered.resume(), true, "the Resume button's request");
        await settle(() => f.restores.length > 0);
        assert.equal(f.restores.length, 1, "exactly one admission, so no second writer");
        assert.equal(f.restores[0]!.allowStoppedResume, true, "Resume is the explicit action that may lift a stopped intent, like the row's Open");
        await bounded(f.host.sessionOf(TAB)!.start());
        await settle(() => f.rendered.getSnapshot().phase === "live");
        assert.equal(f.rendered.writable, true, "the composer becomes writable");
      } finally { f.host.dispose(); harness.forgetTurnActivity(f.index, TAB); }
    });
  }

  it("shows the admission's reason when the session cannot be resumed, instead of ignoring the request", async () => {
    const reason = "Another live VS Code window holds this session, so it was not started.";
    const f = await stoppedChat(false, async () => ({ status: "conflict", tabId: TAB, kind: "claim-conflict", detail: reason }));
    try {
      assert.equal(f.rendered.resume(), true);
      await settle(() => f.restores.length > 0);
      const shown = await settle(() => { const snapshot = f.rendered.getSnapshot(); return snapshot.phase === "blocked" ? snapshot : null; });
      assert.equal(shown.readOnlyReason, reason, "the page names why Resume did not start the session");
      assert.equal(f.rendered.writable, false);
    } finally { f.host.dispose(); harness.forgetTurnActivity(f.index, TAB); }
  });
});
