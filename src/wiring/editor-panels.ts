/**
 * The window's session editors as VS Code panels: where a new editor opens, how a panel becomes a chat surface,
 * which document it shows, and how VS Code revives an editor it restored.
 *
 * `openPanel` is the explicit-intent path (a row the user just asked to open); the two serializers are the
 * restore paths (the versioned view type of one editor, and the one-time migration of the legacy generic
 * panel); `bindPanel` is the one place a panel becomes a chat surface, and `renderPanelDocument` points a bound
 * panel at the document its tab's state calls for. The chat column keeps session editors in their own locked
 * group on the left (`ompDesk.chatColumn`). What a document connects to — the bridge endpoint, its ticket and its
 * routes — belongs to the bridge host; the window's records, the editor-slot elections, the launcher and the
 * conversation pages all arrive through {@link EditorPanelsDeps} as getters and callbacks.
 */

import * as vscode from "vscode";
import { decodeBridgeViewType, persistedBridgeState, recoveredBridgePanelState, tabInputIdentity, bridgeViewType } from "../host/bridge-identity.ts";
import { arrangeChatGroup, chatGroupColumn, chatPlacement, strayEmptyGroups } from "../host/chat-layout.ts";
import type { ChatPlacement } from "../host/chat-layout.ts";
import type { EditorCoordinator, EditorReservationResult } from "../host/editor-coordinator.ts";
import type { EditorSlotRole } from "../host/editor-slots.ts";
import { createGuestHtml, createUnavailableGuestHtml } from "../host/guest-webview.ts";
import type { PtyHandle } from "../host/pty-client.ts";
import type { SessionIndex } from "../host/session-index.ts";
import type { SessionViewMode } from "../host/session-model.ts";
import { createToken } from "../protocol/bridge-protocol.ts";
import type { GuestPanelActionMessage } from "../protocol/messages.ts";
import { persistedTabId } from "../shared/panel-identity.ts";
import type { Logger } from "../shared/logger.ts";
import { sessionHeadline } from "../views/session-tree.ts";
import type { RuntimeRecords } from "../runtime/runtime-record.ts";
import type { BridgeHost, BridgeTab } from "./bridge-host.ts";
import type { CarriedDraft, GuestDispatcher } from "./guest-dispatcher.ts";
import type { WindowRouting } from "./window-routing.ts";

/**
 * The icon every OMP chat editor's tab carries, from this extension's own media.
 *
 * A tab is recognized as an OMP session by this icon rather than by a title
 * prefix, so the title itself is free to be exactly the session's own name.
 */
export const EDITOR_TAB_ICON = "media/omp-icon.png";

/** Shown by a document that was not built because the installed package changed under this host. */
export const UPDATED_ON_DISK_DETAIL = "OMP Desk was updated. Reload the window to continue.";

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** A document can be prepared while this editor's link to the extension is still being set up. */
const BRIDGE_PENDING_DETAIL =
	"This tab is still connecting to OMP Desk. It will fill in on its own in a moment.";
const GUEST_UNAVAILABLE_DETAIL =
	"OMP Desk could not connect this tab to its session. Details are in the OMP Desk output channel.";
/** Shown by a restored editor whose persisted identity is not one this window wrote. */
const UNIDENTIFIED_PANEL_DETAIL =
	"VS Code restored this tab, but OMP Desk does not recognize which session it belonged to, so nothing was opened. " +
	"Close this tab and open the session you want from the Sessions view.";
/** Shown by a legacy editor that lost this tab to an editor already serving it. */
const LEGACY_DUPLICATE_DETAIL =
	"Another tab for this OMP session is already open in this window, so this old tab was left as a note instead of " +
	"starting a second copy. Close this tab and use the one already open.";

/** Shown by a restored editor whose identity names a row this workspace no longer has. */
const STALE_PANEL_DETAIL =
	"VS Code restored this tab for a session that is no longer in the Sessions view, so nothing was opened. " +
	"Close this tab and start the session from the Sessions view.";


/** One bound panel's document: the guest bundle, or a bounded explanation. */
export interface PanelDocument {
	readonly kind: "guest" | "unavailable";
	/** The one bridge document embedded in this HTML, if any. */
	readonly bridgeDocumentId: string | null;
}

/** What the panels read and change of one editor record of this window. */
export interface EditorPanelsTab extends BridgeTab {
	panel: vscode.WebviewPanel | null;
	/** Which document the bound panel shows, or `null` while it has none. */
	document: PanelDocument | null;
	/** How the bound panel came to exist: VS Code's own restored editor wins over a transient panel an explicit open created. */
	origin: "created" | "restored" | null;
}

/** The window's own records the panels read and change. */
export interface EditorWindowFacts<Tab extends EditorPanelsTab> {
	/** The editor records by their immutable slot. */
	tabs(): Map<string, Tab>;
	/** The record an editor slot or a conversation resolves to. */
	tab(key: string | null): Tab | undefined;
	/** The record of an editor slot, created empty when the window has none. */
	tabState(key: string): Tab;
	/** The runtime's record of each conversation, for the process an editor is shown. */
	records(): RuntimeRecords;
	/** The one-winner reservation table of this window's editors. */
	editors(): EditorCoordinator;
	/** Editor ids present in this window's actual editor membership right now. */
	liveEditors(): ReadonlySet<string>;
	/** The next number of the window-wide counter that orders every editor event. */
	nextEditorEvent(): number;
	/** A Chat /new or /delete replaces its editor in that editor's own group. */
	sessionPanelColumns(): Map<string, vscode.ViewColumn>;
	/** Callers waiting for one editor slot's panel handle, resolved by a bound panel. */
	panelBindWaiters(): Map<string, Set<() => void>>;
	/** Drafts captured from a replaced document, waiting for its successor to be ready (by editor slot). */
	draftRestores(): Map<string, CarriedDraft<Tab>>;
	/** Whether the activation restore pass is over (its cohort is published and no pass is pending). */
	startupRestoreSettled(): boolean;
	/** The window's other modules the panels call. */
	guest(): Pick<GuestDispatcher<Tab>, "carryDraftFrom" | "releaseCarriedDraft">;
	routing(): Pick<WindowRouting, "openRestoredTabIfUncovered">;
	/** The bridge host: what a document connects to, and the serializer registry of the dynamic view types. */
	bridge(): Pick<BridgeHost<Tab>, "prepareDocument" | "adoptEditor" | "ticketFacts" | "registerSerializer" | "offerRoute" | "endpointOf">;
	/** The port of this window's HTML page frame server (ADR-0079), or `null` while the setting is off or the listener is not bound: a document built then names no frame. */
	htmlPageFramePort(): number | null;
}

/** The editor-slot elections, the session and the window facts a panel is bound to. */
export interface EditorSlotPort<Tab extends EditorPanelsTab> {
	/** The reasons a slot is shown as passive while its role is not yet recorded or was refused. */
	readonly slotReasons: { readonly passive: string; readonly electing: string };
	/** Move the record an editor's conversation already has under the editor's key, and set the role this window publishes for it. */
	bindSlotToConversation(slot: string, conversation: string, role: EditorSlotRole, reason: string | null): Tab;
	/** Register one election of a slot; it is forgotten when it settles. */
	trackElection(slot: string, work: Promise<void>): Promise<void>;
	/** Publish what the slot's recorded role allows it to do. */
	applySlotAuthority(slot: string): void;
	/** Reserve one editor for one conversation, letting a committed controller take a passive incumbent's place. */
	reserveSlot(
		index: SessionIndex,
		conversation: string,
		slot: string,
		provenance: "saved" | "transient",
	): EditorReservationResult;
	defaultSessionMode(context: vscode.ExtensionContext): SessionViewMode;
	/** Whether a key names a session editor of this window rather than a folder shell. */
	isSessionTab(key: string): boolean;
}

/** What a bound panel hands over to the rest of the window: its title and icon, its lifecycle, its terminal and its conversation. */
export interface EditorSurfacePort<Tab extends EditorPanelsTab> {
	applyChatTabAppearance(context: vscode.ExtensionContext, index: SessionIndex, key: string): Promise<void>;
	/** Listen to a bound panel: its disposal, its view state and its messages. */
	registerPanelLifecycle(index: SessionIndex, slot: string, panel: vscode.WebviewPanel): void;
	ensureTerminalPipeline(index: SessionIndex, slot: string, handle: PtyHandle): unknown;
	/** Forget the native-screen copy a replaced document had asked for. */
	forgetTerminalCopy(state: Tab): void;
	/** Publish the editor-in-front facts the keybinding contexts read. */
	refreshGuestContext(): void;
	/** Whether the installed package no longer holds the bytes this host started from. */
	packageChangedOnDisk(): boolean;
	/** Show a restored editor's last restore outcome, or its saved history, when its page announces itself late. */
	replayPanelOutcome(index: SessionIndex, tabId: string): void;
}

/** The editors VS Code shows, and how the window finds and reveals one. */
export interface EditorWorkbenchPort<Tab extends EditorPanelsTab> {
	/** Create a webview panel (`vscode.window.createWebviewPanel`). */
	createWebviewPanel(
		viewType: string,
		title: string,
		showOptions: vscode.ViewColumn | { readonly viewColumn: vscode.ViewColumn; readonly preserveFocus?: boolean },
		options?: vscode.WebviewPanelOptions & vscode.WebviewOptions,
	): vscode.WebviewPanel;
	/** The tab VS Code shows for an editor slot, or `null`. */
	editorTabOf(slot: string): vscode.Tab | null;
	/** Select an editor VS Code restored but never showed, and wait for it to hand over its panel. */
	reviveEditorPanel(index: SessionIndex, tabId: string): Promise<{ readonly selected: boolean; readonly panel: vscode.WebviewPanel | null }>;
	/** The actual active OMP editor, not another visible editor in a split group. */
	activePanelTab(): (Tab & { tabId: string; panel: vscode.WebviewPanel }) | null;
	refreshLauncher(): void;
	/** Record the active tab in the index. */
	setActiveTab(index: SessionIndex, tabId: string): Promise<void>;
	/** Ask the Sessions view to expand the row of a conversation. */
	requestSessionRowExpand(tabId: string): void;
	/** Resolves once the profile catalog has been read. */
	ensureCatalogReady(): Promise<void>;
}

/** The log and the notifications. Notifications carry the extension's own prefix. */
export interface EditorNotices {
	log: Logger;
	info(message: string): void;
	warn(message: string): void;
}

export interface EditorPanelsDeps<Tab extends EditorPanelsTab = EditorPanelsTab>
	extends EditorWindowFacts<Tab>, EditorSlotPort<Tab>, EditorSurfacePort<Tab>, EditorWorkbenchPort<Tab>, EditorNotices {}

/** What the extension calls into the editor panels. */
export interface EditorPanels {
	/** Create this tab's editor, or bring the one it already has to the front. */
	openPanel(context: vscode.ExtensionContext, index: SessionIndex, tabId: string): void;
	/** Bind one editor panel to one indexed conversation, and give it a document it can render. */
	bindPanel(
		context: vscode.ExtensionContext,
		index: SessionIndex,
		slot: string,
		conversation: string,
		panel: vscode.WebviewPanel,
		origin: "created" | "restored",
		role?: EditorSlotRole,
	): void;
	/** Point one bound panel at the document its tab's state calls for. */
	renderPanelDocument(context: vscode.ExtensionContext, key: string): void;
	/** The serializer VS Code revives one dynamic view type's editors through. */
	bridgeSerializerFor(context: vscode.ExtensionContext, index: SessionIndex, viewType: string): vscode.WebviewPanelSerializer;
	/** The legacy serializer: the one-time migration of a generic panel. */
	legacySerializerFor(context: vscode.ExtensionContext, index: SessionIndex): vscode.WebviewPanelSerializer;
	/** Whether a tab shows a session editor of this extension. */
	isSessionTabInput(input: unknown): boolean;
	/** The column VS Code really shows a session editor in, from the tab it reports. */
	sessionTabColumn(viewType: string): number | undefined;
	/** `ompDesk.focusComposer`: put the keyboard in a session's composer. */
	focusChatComposer(index: SessionIndex): Promise<void>;
}

export function registerEditorPanels<Tab extends EditorPanelsTab>(deps: EditorPanelsDeps<Tab>): EditorPanels {
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
		const state = deps.tabState(tabId);
		if (state.panel !== null) {
			// An explicit Open joins the editor this tab already has — including one that is
			// waiting on a legacy migration — instead of starting a second one.
			state.panel.reveal();
			return;
		}
		// A surviving bridged page is already this editor, even without a panel handle.
		// Resume must serve its existing route, not create a second editor.
		if (state.bridge?.documentId != null && deps.liveEditors().has(state.bridge.editorId)) return;
		// The winner of this tab's editors is decided synchronously, before any await: a
		// restored editor's callback that arrives later must lose against this transient
		// panel only if the saved editor is the one the user's layout names, which is the
		// rule `EditorCoordinator` owns.
		const editorId = createToken();
		const reservation = deps.editors().reserve({ tabId, editorId, provenance: "transient", sequence: deps.nextEditorEvent() });
		if (reservation.outcome === "lost") {
			// VS Code restored this tab's editor but has not revived it, because it was never shown.
			// That editor is the one to show: opening a rival would be the duplicate chat this
			// reservation exists to prevent.
			if (deps.editorTabOf(reservation.reservation.editorId) !== null) {
				void deps.reviveEditorPanel(index, tabId).then(({ selected }) => {
					if (selected) return;
					deps.log.info(`tab ${tabId}: its restored editor ${reservation.reservation.editorId.slice(0, 8)} could not be brought to the front; the user was told to select its tab`);
					deps.warn("That OMP session is open in a tab VS Code could not bring to the front. Select its tab in the editor.");
				});
				return;
			}
			deps.warn("That OMP session is already open in this window.");
			deps.refreshLauncher();
			return;
		}
		const ownEditorId = reservation.reservation.editorId;
		const viewType = bridgeViewType(tabId, ownEditorId);
		deps.bridge().registerSerializer(context, index, viewType);
		// The tab is named for the session it shows, from the same rule its launcher row
		// uses, so it is never a second copy of the working folder's name. The row is
		// already known here — this path is a row's own Open — and its cached title is
		// what a first frame can use without waiting; binding below then applies the
		// exact stored name and the icon.
		const entry = index.get(tabId);
		const column = deps.sessionPanelColumns().get(tabId);
		deps.sessionPanelColumns().delete(tabId);
		const placement = column === undefined && chatColumnEnabled() ? chatPlacementNow() : null;
		const panel = deps.createWebviewPanel(
			viewType,
			entry === null ? "OMP Desk session" : sessionHeadline(entry, null),
			column ?? placement?.column ?? vscode.ViewColumn.Active,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
			},
		);
		if (placement !== null) {
			deps.log.debug(`chat column: session editor placed at column ${placement.column} (${placement.arrange})`);
			void arrangeSessionPanelGroup(placement, panel, viewType)
				.catch(error => deps.log.warn(`chat column: the chat group could not be arranged: ${messageOf(error)}`));
		}
		bindPanel(context, index, ownEditorId, tabId, panel, "created");
		void deps.setActiveTab(index, tabId);
		// The endpoint, the document and its exact port are provisioned *after* the panel
		// exists but before a guest document is installed: the panel first shows a bounded
		// explanation, then the guest document whose `connect-src` names the port this
		// editor actually holds.
		void (async () => {
			const prepared = await deps.bridge().prepareDocument(context, ownEditorId);
			if (deps.tabs().get(ownEditorId)?.panel !== panel) return;
			if (prepared === null) {
				// No bridge endpoint means this editor cannot be reconnected to after a
				// host-only restart — and nothing more. The chat, the composer and every
				// panel-served control keep working, so the panel is rendered without a bridge
				// rather than being left on an explanation.
				deps.log.warn(`slot ${ownEditorId}: this editor has no bridge endpoint (${deps.bridge().endpointOf(ownEditorId)?.failure ?? "unknown"})`);
				const current = deps.tabs().get(ownEditorId);
				if (current !== undefined) current.bridge = null;
				renderPanelDocument(context, ownEditorId);
				return;
			}
			renderPanelDocument(context, ownEditorId);
		})();
	}

	/** Whether session editors keep their own locked editor group on the left (`ompDesk.chatColumn`). */
	function chatColumnEnabled(): boolean {
		return vscode.workspace.getConfiguration("ompDesk").get<boolean>("chatColumn", true);
	}

	/** Whether a tab shows a session editor of this extension. */
	function isSessionTabInput(input: unknown): boolean {
		return input instanceof vscode.TabInputWebview && tabInputIdentity(input.viewType) !== null;
	}

	/** Where a session editor opens now, from the tabs VS Code reports. */
	function chatPlacementNow(): ChatPlacement {
		const groups = vscode.window.tabGroups;
		return chatPlacement(groups.all, groups.activeTabGroup.viewColumn, isSessionTabInput, vscode.ViewColumn.Beside);
	}

	/** The column VS Code really shows a session editor in, from the tab it reports; `panel.viewColumn` keeps the requested column until a view-state event. */
	function sessionTabColumn(viewType: string): number | undefined {
		return vscode.window.tabGroups.all.find(group => group.tabs.some(tab => tab.input instanceof vscode.TabInputWebview && tab.input.viewType === viewType))?.viewColumn;
	}

	/**
	 * Arrange a new session editor's group (`arrangeChatGroup`) from the column its tab is really in. VS Code does not put
	 * an editor into an empty locked group, even by exact column, so after the chat group's last editor was closed the
	 * editor lands in a new group on the right while `panel.viewColumn` still says the requested column. The group is then
	 * moved from where it is, and the emptied locked remnant, now to its right, is closed so no stray group stays beside the chat.
	 */
	async function arrangeSessionPanelGroup(placement: ChatPlacement, panel: vscode.WebviewPanel, viewType: string): Promise<void> {
		for (let attempt = 0; attempt < 40 && sessionTabColumn(viewType) === undefined; attempt++) {
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, 50);
			await promise;
		}
		const live = { get active() { return panel.active; }, get viewColumn() { return sessionTabColumn(viewType) ?? panel.viewColumn; }, onDidChangeViewState: (listener: () => void) => panel.onDidChangeViewState(listener) };
		const landed = live.viewColumn;
		deps.log.debug(`chat column: the session editor is at column ${landed} (asked for ${placement.column})`);
		await arrangeChatGroup({ executeCommand: command => vscode.commands.executeCommand(command) }, placement, live);
		// The editor missed the requested group, so that group is still there, emptied. VS Code reports the move a moment later.
		if (placement.arrange !== "move-left-and-lock" || landed === placement.column) return;
		for (let attempt = 0; attempt < 40; attempt++) {
			const groups = vscode.window.tabGroups;
			const strays = strayEmptyGroups(groups.all, isSessionTabInput);
			if (strays.length > 0) {
				deps.log.debug(`chat column: closing ${strays.length} empty group(s) beside the chat group`);
				await groups.close(strays);
				return;
			}
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, 50);
			await promise;
		}
		deps.log.debug(`chat column: no empty group to close found; groups: ${vscode.window.tabGroups.all.map(group => `${group.viewColumn}:${group.tabs.length}`).join(" ")}`);
	}

	/**
	 * `ompDesk.focusComposer` from anywhere (Ctrl+Shift+L): put the keyboard in a session's composer. The session is the
	 * active session editor, else the one showing in the chat group, else the last active one; a Terminal-mode session
	 * gets the focus on its terminal. With no session editor open, the OMP Desk side bar opens instead.
	 */
	async function focusChatComposer(index: SessionIndex): Promise<void> {
		let tabId = deps.activePanelTab()?.tabId ?? null;
		if (tabId === null) {
			const groups = vscode.window.tabGroups;
			const column = chatGroupColumn(groups.all, groups.activeTabGroup.viewColumn, isSessionTabInput);
			const input = groups.all.find(group => group.viewColumn === column)?.activeTab?.input;
			// The viewType's tab is the editor's original namespace; the conversation it serves
			// now is its reservation, else its committed binding.
			const identity = input instanceof vscode.TabInputWebview ? tabInputIdentity(input.viewType) : null;
			tabId = (identity === null ? null : deps.editors().tabOfEditor(identity.editorIdHex) ?? index.slotBinding(identity.editorIdHex)?.tabId ?? identity.tabId) ?? index.activeTabId;
		}
		// A tab VS Code restored but never showed has no panel yet; selecting it makes VS Code hand one over.
		const panel = tabId === null ? null : (await deps.reviveEditorPanel(index, tabId)).panel;
		const state = tabId === null ? undefined : deps.tab(tabId);
		if (panel === null || state === undefined) {
			await vscode.commands.executeCommand("workbench.view.extension.ompDesk");
			return;
		}
		panel.reveal(panel.viewColumn, false);
		if (state.mode !== "chat") return;
		const delivered = await panel.webview.postMessage({ type: "omp:webview-action", action: "focus-composer" } satisfies GuestPanelActionMessage);
		deps.log.debug(`tab ${tabId}: focus-composer asked from a VS Code command or keybinding (delivered=${delivered}, panel visible=${panel.visible}, active=${panel.active}, column ${panel.viewColumn})`);
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
		const state = deps.bindSlotToConversation(
			slot,
			conversation,
			"passive",
			role === "passive" ? deps.slotReasons.passive : deps.slotReasons.electing,
		);
		if (origin === "restored") state.mode = deps.records().get(state.tabId)?.runtime?.kind ?? index.slotBinding(slot)?.mode ?? deps.defaultSessionMode(context);
		// The durable binding is what a later restore resolves its conversation *and* its
		// role from, so it is written as soon as the editor becomes a chat surface. A
		// controlling binding demotes its rivals durably; a passive one only records this
		// editor's own non-controlling role.
		// This election is tracked: a command the page sends before it settles waits for it
		// (`dispatchSlotMessage`) instead of being judged on the interim passive answer.
		void deps.trackElection(
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
						deps.bindSlotToConversation(slot, conversation, "controlling", null);
						deps.applySlotAuthority(slot);
					} else {
						deps.bindSlotToConversation(slot, conversation, "passive", binding.roleRefusal ?? deps.slotReasons.passive);
						deps.applySlotAuthority(slot);
						deps.log.info(`slot ${slot}: this editor is not controlling ${conversation} (${binding.roleRefusal ?? "no reason reported"})`);
					}
					// The view mode is only bookkeeping for a later restore. It is recorded *after* the role
					// is published: it costs another durable write, and the editor must not stay
					// passive for the length of it.
					await index.setEditorMode(slot, state.mode);
				})
				.catch(error => deps.log.warn(`slot ${slot}: its editor-slot binding could not be persisted (${messageOf(error)})`)),
		);
		state.panel = panel;
		const hosted = deps.records().get(state.tabId)?.runtime;
		if (hosted?.kind === "terminal") deps.ensureTerminalPipeline(index, slot, hosted.handle);
		state.origin = origin;
		// The tab now says what this editor shows. This is the one place a chat panel
		// becomes a surface, and a restored editor carries no icon and may carry a name
		// from before the last rename, so the appearance is applied to every panel bound
		// here — created, restored or migrated.
		void deps.applyChatTabAppearance(context, index, slot);
		const boundEditorId = state.bridge?.editorId ?? null;
		if (boundEditorId !== null) void deps.bridge().adoptEditor(context, slot, panel);
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
		deps.registerPanelLifecycle(index, slot, panel);
		// The document is chosen and set synchronously, so an editor VS Code restored
		// renders at once and a panel whose bridge endpoint is not ready says so instead of
		// waiting blank while the endpoint is bound.
		renderPanelDocument(context, slot);
		deps.refreshLauncher();
		for (const resolve of deps.panelBindWaiters().get(slot) ?? []) resolve();
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
		const state = deps.tab(key);
		if (state === undefined || state.tabId === null || !deps.isSessionTab(state.slotId)) return;
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
		const ticket = deps.bridge().ticketFacts(state.slotId);
		// A bridged editor is only rendered once its endpoint and exact port exist, because
		// the document's `connect-src` must name the listener this host actually holds. An
		// editor with no bridge at all still gets its chat: the bridge is what makes the page
		// *survive* a restart, not what makes the chat work.
		const awaitingBridge = state.bridge !== null && ticket === null;
		let html: string | null = null;
		if (!awaitingBridge) {
			try {
				html = createGuestHtml(panel.webview, context.extensionUri, identityTabId, ticket, state.mode, state.mode === "chat" ? deps.htmlPageFramePort() : null);
			} catch (error) {
				// The document is built from this extension's own inputs, so a failure is a defect
				// rather than an input: it is logged and the panel keeps an honest document instead
				// of a broken one with a weaker CSP.
				deps.log.error(`slot ${state.slotId}: the panel document could not be built: ${messageOf(error)}`);
			}
		}
		let updatedOnDisk = false;
		if (html !== null && deps.packageChangedOnDisk()) {
			// A page that is already loaded came from the build this host runs, and it stays valid. Only a
			// document that would be built now reads the replaced bundle, so only that one is withheld.
			if (state.document !== null && state.document.kind === "guest" && state.document.bridgeDocumentId === (ticket?.documentId ?? null)) return;
			html = null;
			updatedOnDisk = true;
		}
		const kind: PanelDocument["kind"] = html === null ? "unavailable" : "guest";
		const bridgeDocumentId = ticket?.documentId ?? null;
		if (state.document !== null && state.document.kind === kind && state.document.bridgeDocumentId === bridgeDocumentId) return;
		deps.forgetTerminalCopy(state);
		state.document = { kind, bridgeDocumentId };
		// A fallback page must persist the identity its own view type names — the tab (T)
		// *and* the actual editor id (E) — so a document left by a pending bridge cannot make
		// this editor unidentifiable at its next restart. Both documents of an editor therefore
		// save the same state.
		panel.webview.html = html ?? createUnavailableGuestHtml(
			awaitingBridge ? BRIDGE_PENDING_DETAIL : updatedOnDisk ? UPDATED_ON_DISK_DETAIL : GUEST_UNAVAILABLE_DETAIL,
			{ tabId: identityTabId, editorId: panelIdentity?.editorIdHex ?? state.slotId },
			{ reloadButton: updatedOnDisk },
		);
		deps.refreshGuestContext();
		if (kind === "guest") {
			// A freshly installed guest document is a new incarnation: the host offers this
			// document's route over the panel handle it holds, and dispatch waits for the
			// page's acknowledgement.
			deps.bridge().offerRoute(state.slotId);
		}
	}

	/**
	 * The serializer VS Code revives this window's OMP editors through.
	 *
	 * The state it is handed was written by that editor's own previous document (see
	 * `src/shared/panel-identity.ts`) and is treated as untrusted: it is narrowed to
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
				await deps.ensureCatalogReady();
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
						deps.log.warn(
							"a restored OMP editor carried a legacy version-1 identity that its view type and durable controlling binding do not prove; it was left as an explanation",
						);
					} else {
						deps.log.warn("a restored OMP editor carried no usable bridge identity; it was left as an explanation");
					}
					return;
				}
				if (stored === null) {
					deps.log.info(
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
					deps.log.warn("a restored OMP editor named a tab this workspace no longer has; it was left as an explanation");
					return;
				}
				const reservation = deps.reserveSlot(index, conversation, slot, "saved");
				if (reservation.outcome === "lost") {
					// Another editor of this conversation holds it: this one is a duplicate of a
					// session that is already open, and a second chat for one session is what the
					// one-winner rule exists to prevent.
					deps.log.info(`slot ${slot}: a second restored webview for this conversation was closed`);
					panel.dispose();
					deps.info("An OMP Desk editor restored for this window was closed: it was a duplicate of one already open for the same session.");
					return;
				}
				const superseded = reservation.outcome === "replaced" ? deps.tabs().get(conversation)?.panel ?? null : null;
				const carriedDraft = await deps.guest().carryDraftFrom(superseded);
				try {
					bindPanel(context, index, slot, conversation, panel, "restored", committed?.role ?? "controlling");
					if (carriedDraft !== null) deps.draftRestores().set(slot, carriedDraft);
					superseded?.dispose();
				} finally {
					deps.guest().releaseCarriedDraft(carriedDraft);
				}
				// A reload recreates the editor and a fresh HTML document. Reuse its
				// native attempt while replacing only the prior document incarnation.
				const adopted = await deps.bridge().adoptEditor(context, slot, panel);
				const prepared = adopted ? await deps.bridge().prepareDocument(context, slot) : null;
				if (deps.tabs().get(slot)?.panel === panel && deps.editors().holdsEditor(slot)) {
					if (prepared === null) {
						// A bridge failure must not strand a restored chat on the placeholder.
						// It cannot survive a host-only restart without a ticket, but the
						// ordinary panel route still carries its conversation.
						const current = deps.tabs().get(slot);
						if (current?.bridge?.editorId === slot) current.bridge = null;
						deps.log.warn(`slot ${slot}: restored editor has no reconnect bridge; serving its chat through the panel`);
					}
					renderPanelDocument(context, slot);
				}
				// Only a panel VS Code actually made active describes the user's selection, so
				// the index follows that and nothing here reveals, moves or focuses a restored
				// editor: its saved position and group are already its own.
				if (panel.active) {
					if (deps.startupRestoreSettled()) deps.requestSessionRowExpand(conversation);
					await deps.setActiveTab(index, conversation);
				}
				deps.replayPanelOutcome(index, conversation);
				// The activation pass restores only the rows this window is responsible for. A
				// restored editor for any *other* row in the profile-wide index is this window's
				// own editor for a conversation nobody has opened here yet, so it takes the same
				// path an explicit click takes: one native attempt for that tab, re-derived from
				// current ownership rather than from the pass's cohort. A tab the pass does cover
				// is left to it, and a tab that already has a runtime is already connected.
				await deps.routing().openRestoredTabIfUncovered(context, index, conversation);
			},
		};
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
				await deps.ensureCatalogReady();
				if (tabId === null) {
					panel.webview.html = createUnavailableGuestHtml(UNIDENTIFIED_PANEL_DETAIL);
					deps.log.warn("a restored OMP editor carried no usable panel identity; it was left as an explanation");
					return;
				}
				const entry = index.get(tabId);
				if (entry === null) {
					panel.webview.html = createUnavailableGuestHtml(STALE_PANEL_DETAIL);
					deps.log.warn("a restored OMP editor named a tab this workspace no longer has; it was left as an explanation");
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
				const reservation = deps.reserveSlot(index, tabId, editorId, "saved");
				if (reservation.outcome === "lost") {
					// Another editor of this conversation already serves it. This legacy panel
					// keeps its editor and shows the bounded explanation: creating a successor
					// would be a second chat for one session.
					// This legacy panel keeps the version-1 identity the static type persists, so a
					// later restart still restores it (and the legacy serializer accepts that state).
					panel.webview.html = createUnavailableGuestHtml(LEGACY_DUPLICATE_DETAIL, { tabId, editorId: null });
					deps.log.warn(`tab ${tabId}: a legacy panel was left as an explanation because another editor already owns this conversation`);
					return;
				}
				const ownEditorId = reservation.reservation.editorId;
				const ticket = deps.editors().claimTransition(tabId, ownEditorId);
				if (ticket === null) {
					panel.webview.html = createUnavailableGuestHtml(LEGACY_DUPLICATE_DETAIL, { tabId, editorId: null });
					deps.log.warn(`tab ${tabId}: a legacy migration is already running for this tab`);
					return;
				}
				const previousPanel = deps.tabs().get(tabId)?.panel ?? null;
				if (previousPanel !== null && previousPanel !== panel) {
					// A transient panel an explicit open created is standing for this tab. The
					// editor VS Code restored wins — it is the one the user's own layout names —
					// and the transient panel is retired without releasing anything native: the
					// tab keeps its runtime, its claim and its in-flight restore.
					deps.log.info(`tab ${tabId}: a restored webview replaced the panel an explicit open had created`);
				}
				const viewType = bridgeViewType(tabId, ownEditorId);
				deps.bridge().registerSerializer(context, index, viewType);
				// The successor is created in the source panel's own view column, and a source
				// that is not focused keeps the focus: the migration must not move the user.
				const successor = deps.createWebviewPanel(
					viewType,
					tabTitle,
					{ viewColumn: panel.viewColumn ?? vscode.ViewColumn.Active, preserveFocus: !panel.active },
					{
						enableScripts: true,
						retainContextWhenHidden: true,
						localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
					},
				);
				const carriedDraft = previousPanel !== null && previousPanel !== panel ? await deps.guest().carryDraftFrom(previousPanel) : null;
				try {
					bindPanel(context, index, ownEditorId, tabId, successor, "restored");
					if (carriedDraft !== null) deps.draftRestores().set(ownEditorId, carriedDraft);
					// Only the exact supplied panel is disposed, and only after its successor is
					// bound: the predecessor's close must not be read as this tab's editor closing.
					panel.dispose();
					if (previousPanel !== null && previousPanel !== panel && previousPanel !== successor) previousPanel.dispose();
				} finally {
					deps.guest().releaseCarriedDraft(carriedDraft);
				}
				deps.editors().settleTransition(tabId, ownEditorId, ticket);
				const prepared = await deps.bridge().prepareDocument(context, ownEditorId);
				if (deps.tabs().get(ownEditorId)?.panel === successor && deps.editors().holdsEditor(ownEditorId)) {
					if (prepared === null) {
						const current = deps.tabs().get(ownEditorId);
						if (current?.bridge?.editorId === ownEditorId) current.bridge = null;
						deps.log.warn(`slot ${ownEditorId}: migrated editor has no reconnect bridge; serving its chat through the panel`);
					}
					renderPanelDocument(context, ownEditorId);
				}
				deps.log.info(`tab ${tabId}: a legacy editor was migrated onto a versioned successor`);
				// Only a panel VS Code actually made active describes the user's selection,
				// so the index follows that and nothing here reveals, moves or focuses a
				// restored editor: its saved position and group are already its own.
				if (panel.active) await deps.setActiveTab(index, tabId);
				// Deserialization is lazy, so this callback can arrive long after the native
				// side settled: the last outcome is replayed rather than assumed delivered.
				deps.replayPanelOutcome(index, tabId);
			},
		};
	}
	return {
		openPanel,
		bindPanel,
		renderPanelDocument,
		bridgeSerializerFor,
		legacySerializerFor,
		isSessionTabInput,
		sessionTabColumn,
		focusChatComposer,
	};
}
