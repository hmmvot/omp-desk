/**
 * The window's reconnecting bridge (ADR-0023): one listener per actual editor, one document per HTML
 * incarnation, one route per document and one admission ledger per document.
 *
 * The extension owns policy here — which editor may act and whose native checks pass right now — while
 * `src/host/bridge-*` owns the listener, the records, the route state machine and the admission rules. This
 * module provisions an editor's endpoint and its document, adopts the editors VS Code already holds, binds a
 * page's reported origin to the document the host serves and commits it against the verified chat host,
 * delivers the secret, offers and acknowledges routes, and retires the bridge of an editor that closed. It keeps
 * only what no other part of the extension reads (the workspace hash, the record store, the endpoints being
 * created, the serializer types registered and the host generation); everything else of the window arrives
 * through {@link BridgeHostDeps} as getters and callbacks.
 */

import * as path from "node:path";
import * as vscode from "vscode";
import type { BridgeBootstrapDelivery, BridgeEditorEndpoint, BridgeEditorEndpointOptions } from "../host/bridge-endpoint.ts";
import {
	bridgeViewType,
	tabInputIdentity,
	workspaceIdentityText,
} from "../host/bridge-identity.ts";
import { retireClosedEditorBridge } from "../host/bridge-lifecycle.ts";
import type { BridgeAdmittedRequest, BridgeSession } from "../host/bridge-listener.ts";
import { BridgeRecords, bindingMatches } from "../host/bridge-records.ts";
import type { BridgeNativeBinding, BridgeRecordScope } from "../host/bridge-records.ts";
import type { BridgeDocumentRoute } from "../host/bridge-route.ts";
import type { LocalSessionRuntime } from "../runtime/local-runtime.ts";
import { isOpenControlClient } from "../host/control-attempt.ts";
import { controlPathEquals } from "../host/control-protocol.ts";
import type { DiagnosticsRecorder } from "../host/diagnostics.ts";
import type { EditorCoordinator, EditorReservationResult } from "../host/editor-coordinator.ts";
import type { EditorSlotRegistry } from "../host/editor-slots.ts";
import type { SessionIndex } from "../host/session-index.ts";
import type { SessionViewMode } from "../host/session-model.ts";
import {
	BRIDGE_PATH,
	createToken,
	encodeBase64Url,
	encodeHex,
	randomBytes,
	sha256,
} from "../protocol/bridge-protocol.ts";
import type {
	GuestBridgeAckMessage,
	GuestBridgeBindMessage,
	GuestRouteAckMessage,
	GuestRouteOfferMessage,
} from "../protocol/messages.ts";
import type { Logger } from "../shared/logger.ts";
import { isPanelTabId } from "../shared/panel-identity.ts";

/** The bridge endpoint of an editor and the document its panel shows, as one editor record holds them. */
export interface BridgeBinding {
	/** The actual editor (`E`) — what VS Code restores and what the listener is bound for. */
	readonly editorId: string;
	readonly endpoint: BridgeEditorEndpoint;
	/** The document incarnation whose HTML this tab's panel currently shows. */
	documentId: string | null;
	/** Whether the page acknowledged the current secret delivery. */
	bound: boolean;
}

/** What the bridge reads and changes of one editor record of this window. */
export interface BridgeTab {
	/** The immutable key the record is filed under. */
	slotId: string;
	/** The conversation the editor shows, or `null` for a folder shell. */
	tabId: string | null;
	readonly panel: vscode.WebviewPanel | null;
	mode: SessionViewMode;
	/** The origin report of a page that announced itself while its editor could not act yet. */
	heldReadyReport: { readonly documentId: string; readonly bootstrapId: string; readonly origin: string } | null;
	bridge: BridgeBinding | null;
}

/** The bridge ticket facts one rendered document carries. */
export interface BridgeTicketFacts {
	readonly editorId: string;
	readonly documentId: string;
	readonly bootstrapId: string;
	readonly port: number;
}

/** What the page-announced document facts of one editor pin, as the guest sends them in `omp:ready`. */
export interface BridgeOriginReport {
	readonly documentId: string;
	readonly bootstrapId: string;
	readonly origin: string;
}

/** The window's own records the bridge reads and changes. */
export interface BridgeWindowFacts<Tab extends BridgeTab> {
	/** The editor records by their immutable slot. */
	tabs(): Map<string, Tab>;
	/** The record an editor slot or a conversation resolves to. */
	tab(key: string | null): Tab | undefined;
	/** The record of an editor slot, created empty when the window has none. */
	tabState(key: string): Tab;
	/** The session index this activation created, or `null` before activation. */
	index(): Pick<SessionIndex, "get"> | null;
	/** The live sessions of this window's conversations, for the verified chat host of one conversation. */
	sessions(): Pick<LocalSessionRuntime, "conversations" | "records">;
	/** The one-winner reservation table of this window's editors (ADR-0019/0023). */
	editors(): EditorCoordinator;
	editorSlots(): Pick<EditorSlotRegistry, "remove">;
	/** One endpoint per actual editor this window serves. */
	endpoints(): Map<string, BridgeEditorEndpoint>;
	/** Editor ids present in this window's actual editor membership right now. */
	liveEditors(): Set<string>;
	diagnostics(): Pick<DiagnosticsRecorder, "note">;
	/** Why a slot may not act (it does not control its session), or `null`. */
	passiveReasonForSlot(slot: string): string | null;
}

/** The editors and the conversation pages the bridge drives. */
export interface BridgeEditorPort {
	/** Reserve one editor for one conversation, letting a committed controller take a passive incumbent's place. */
	reserveSlot(
		index: SessionIndex,
		conversation: string,
		slot: string,
		provenance: "saved" | "transient",
	): EditorReservationResult;
	defaultSessionMode(context: vscode.ExtensionContext): SessionViewMode;
	/** Point one editor slot's conversation at the route that reaches its page now. */
	attachChatRoute(slot: string, force?: boolean): void;
	refreshLauncher(): void;
	/** Drop the host-control picker a conversation had open. */
	cancelControlPicker(tabId: string): void;
	/** The serializer VS Code revives one dynamic view type's editors through. */
	serializerFor(context: vscode.ExtensionContext, index: SessionIndex, viewType: string): vscode.WebviewPanelSerializer;
	/** Answer one admitted request that arrived over an editor's bridge. */
	handleRequest(editorId: string, documentId: string, session: BridgeSession, request: BridgeAdmittedRequest): void;
}

/** The log. */
export interface BridgeNotices {
	log: Logger;
}

/** The environmental port behind an editor's endpoint: the one place a listener object comes into being. */
export interface BridgeEndpointFactory {
	/** Build — without binding — the endpoint one editor's records and hooks describe. */
	createEndpoint(options: BridgeEditorEndpointOptions): BridgeEditorEndpoint;
}

export interface BridgeHostDeps<Tab extends BridgeTab = BridgeTab> extends BridgeWindowFacts<Tab>, BridgeEditorPort, BridgeNotices, BridgeEndpointFactory {}

/** What the extension calls into the bridge host. */
export interface BridgeHost<Tab extends BridgeTab = BridgeTab> {
	/** This activation's host generation `H`: one per extension-host activation, minted into every endpoint and offer. */
	readonly hostGeneration: Uint8Array;
	/** The editors this window's actual VS Code membership contains, from the tab inputs' view types. */
	editorMembership(): { readonly tabId: string; readonly editorId: string }[];
	/** The conversation one VS Code editor serves now: its reservation, else its committed slot binding, else its viewType's tab. */
	editorConversation(index: Pick<SessionIndex, "get" | "slotBinding">, entry: { readonly tabId: string; readonly editorId: string }): string;
	/** The endpoint of one editor, or `null` when this window does not serve it. */
	endpointOf(editorId: string): BridgeEditorEndpoint | null;
	/** Whether one document of one editor may still act, re-derived from live window state. */
	documentEligible(editorId: string, documentId: string): boolean;
	/** Register one dynamic type's serializer, once per activation. */
	registerSerializer(context: vscode.ExtensionContext, index: SessionIndex, viewType: string): void;
	/** Mint a fresh document for an editor and bind its exact port before the HTML exists. */
	prepareDocument(
		context: vscode.ExtensionContext,
		editorId: string,
	): Promise<{ readonly endpoint: BridgeEditorEndpoint; readonly documentId: string; readonly bootstrapId: string; readonly port: number } | null>;
	/** Adopt one actual editor into this window's live state. */
	adoptEditor(context: vscode.ExtensionContext, slot: string, panel: vscode.WebviewPanel | null): Promise<boolean>;
	/** Reconcile this window's editors with VS Code's own membership. */
	syncEditors(context: vscode.ExtensionContext, index: SessionIndex, options?: { readonly retireMissing?: boolean }): Promise<void>;
	/** The ticket of the document this tab's panel currently shows, or `null`. */
	ticketFacts(tabId: string): BridgeTicketFacts | null;
	/** Pin the Origin a page reported over the panel route. */
	pinOrigin(tabId: string, panel: vscode.WebviewPanel, report: BridgeOriginReport): void;
	/** Apply the origin report a page made while its editor was not yet controlling. */
	replayHeldReadyReport(state: Tab): boolean;
	/** The chat-host binding this window can verify for one tab right now, or `null`. */
	liveBinding(tabId: string): BridgeNativeBinding | null;
	/** Commit this tab's document against the chat-host binding, once. */
	commitDocument(tabId: string): Promise<void>;
	/** Re-send the current document's bridge secret, without rotating it. */
	redeliverBinding(tabId: string): Promise<void>;
	/** Re-check this tab's native readiness for its bridge route. */
	refreshReadiness(tabId: string): void;
	/** Retire the bridge of an editor this window observed closing. */
	retireClosedEditor(slot: string): void;
	/** The route of this tab's current document, or `null`. */
	routeOf(tabId: string): BridgeDocumentRoute | null;
	/** Offer this document's route over the transport that can carry it. */
	offerRoute(tabId: string): void;
	/** The page acknowledged the route generation it was offered over its panel. */
	acknowledgeRoute(tabId: string, panel: vscode.WebviewPanel, message: GuestRouteAckMessage): void;
	/** The page acknowledged the secret it was delivered. */
	acknowledgeSecret(tabId: string, panel: vscode.WebviewPanel, message: GuestBridgeAckMessage): void;
}

export function registerBridgeHost<Tab extends BridgeTab>(deps: BridgeHostDeps<Tab>): BridgeHost<Tab> {
	/**
	 * This activation's host generation `H`.
	 *
	 * One per extension-host activation, not per editor: it is what makes an
	 * acknowledgement, a reply or a mutation minted for a previous host unusable in
	 * this one, so a restarted host needs no coordination with the host it replaced.
	 */
	const hostGeneration = randomBytes(16);
	/** This window's canonical workspace hash `W`, resolved once per activation. */
	let bridgeWorkspace: string | null = null;
	/** Durable bridge records of this workspace, created on first use. */
	let bridgeStore: BridgeRecords | null = null;
	/** Endpoint creation must be single-flight: concurrent restore, tab and panel callbacks share its exact port. */
	const pendingBridgeEndpoints = new Map<string, Promise<BridgeEditorEndpoint | null>>();
	/** Dynamic bridge view types this activation registered a serializer for. */
	const bridgeSerializerTypes = new Set<string>();

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
		context.subscriptions.push(vscode.window.registerWebviewPanelSerializer(viewType, deps.serializerFor(context, index, viewType)));
	}

	/** The endpoint of one editor, or `null` when this window does not serve it. */
	function bridgeEndpointOf(editorId: string): BridgeEditorEndpoint | null {
		return deps.endpoints().get(editorId) ?? null;
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
		if (deps.passiveReasonForSlot(editorId) !== null) return false;
		const state = deps.tabs().get(editorId);
		if (state === undefined || state.tabId === null || state.bridge === null || state.bridge.editorId !== editorId) return false;
		if (state.bridge.documentId !== documentId) return false;
		const table = deps.index();
		if (table !== null && table.get(state.tabId) === null) return false;
		// A panel handle for this exact document is the strongest fact; without one the
		// editor must still be in real VS Code membership, which is what a surviving page
		// after a host-only restart has.
		return state.panel !== null || deps.liveEditors().has(editorId);
	}

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
			const endpoint = deps.createEndpoint({
				records: host.records,
				scope,
				hostGeneration: hostGeneration,
				eligible: documentId => bridgeDocumentEligible(editorId, documentId),
				onRequest: (session, documentId, request) => deps.handleRequest(editorId, documentId, session, request),
				onStateChanged: (documentId, state) => {
					deps.log.debug(`tab ${tabId}: bridge document ${documentId.slice(0, 8)} is ${state}`);
					deps.diagnostics().note(tabId, `bridge: document ${documentId.slice(0, 8)} is ${state}`);
					// A surviving page becomes reachable (or stops being) as its route state moves.
					deps.attachChatRoute(editorId);
					deps.refreshLauncher();
				},
				onDiagnostic: (code, detail) => {
					deps.log.warn(`tab ${tabId}: bridge ${code} — ${detail}`);
					deps.diagnostics().note(tabId, `bridge: ${code}`);
				},
			});
			const port = await endpoint.bind();
			if (port === null) {
				deps.log.warn(`tab ${tabId}: the bridge listener could not bind (${endpoint.failure ?? "unknown"})`);
				endpoint.close();
				return null;
			}
			deps.endpoints().set(editorId, endpoint);
			deps.log.debug(`tab ${tabId}: bridge listener bound on 127.0.0.1:${port} for editor ${editorId.slice(0, 8)}`);
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
		const state = deps.tabs().get(editorId);
		// The endpoint's own recorded namespace wins: an editor keeps the (T, E) namespace its
		// listener was bound under, so a slot whose reservation was released (a passive
		// newcomer whose destination belongs to another editor) is never given a second
		// endpoint under another conversation.
		const known = state?.bridge?.endpoint.scope.tabId ?? null;
		const namespaceTabId = known ?? deps.editors().tabOfEditor(editorId) ?? null;
		// A *passive* slot may still provision: it must be able to retire the document that
		// was authorized for the conversation it no longer serves, and it can act on nothing.
		const mayProvision =
			state !== undefined && namespaceTabId !== null && (deps.editors().holdsEditor(editorId) || deps.passiveReasonForSlot(editorId) !== null);
		if (!mayProvision) return null;
		const endpoint = await ensureBridgeEndpoint(context, namespaceTabId, editorId);
		if (endpoint === null) return null;
		const documentId = createToken();
		const bootstrapId = createToken();
		const document = await endpoint.beginDocument(documentId, bootstrapId);
		const port = endpoint.port;
		if (document === null || port === null) {
			deps.log.warn(`slot ${editorId}: this editor's bridge document could not be prepared`);
			return null;
		}
		if (deps.tabs().get(editorId) !== state || !deps.editors().holdsEditor(editorId)) {
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
		deps.editors().noteDocument(editorId, editorId, documentId);
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
		const state = deps.tabState(slot);
		const namespaceTabId = deps.editors().tabOfEditor(slot) ?? state.tabId ?? null;
		if (namespaceTabId === null || !deps.editors().holdsEditor(slot)) return false;
		const endpoint = await ensureBridgeEndpoint(context, namespaceTabId, slot);
		if (endpoint === null || !deps.editors().holdsEditor(slot)) return false;
		const existing = state.bridge;
		if (existing === null || existing.editorId !== slot || existing.endpoint !== endpoint) {
			state.bridge = { editorId: slot, endpoint, documentId: null, bound: false };
		}
		deps.liveEditors().add(slot);
		if (panel !== null) endpoint.panelBound();
		return true;
	}

	/**
	 * The conversation one VS Code editor serves now: its reservation; else the conversation
	 * its committed slot binding names; else the tab its viewType names. The binding rule is
	 * the serializer's (`editor-panels.ts`), so the activation pass and a revival reserve an
	 * editor for one and the same conversation.
	 */
	function editorConversation(
		index: Pick<SessionIndex, "get" | "slotBinding">,
		entry: { readonly tabId: string; readonly editorId: string },
	): string {
		const reserved = deps.editors().tabOfEditor(entry.editorId);
		if (reserved !== null) return reserved;
		const committed = index.slotBinding(entry.editorId);
		return committed === null || index.get(committed.tabId) === null ? entry.tabId : committed.tabId;
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
		for (const editorId of [...deps.liveEditors()]) {
			if (present.has(editorId)) continue;
			deps.liveEditors().delete(editorId);
			// Only a *change* in the tab set retires an editor: the activation pass runs
			// before this window has necessarily listed every editor it restored, and
			// forgetting a page that is still running would destroy the credential it needs.
			if (options.retireMissing !== true) continue;
			retireClosedBridgeEditor(editorId);
		}
		for (const entry of membership) {
			registerBridgeSerializer(context, index, bridgeViewType(entry.tabId, entry.editorId));
			deps.liveEditors().add(entry.editorId);
			// The viewType names the editor's *original* (T, E) namespace, which never
			// changes. Which conversation the editor serves now is the editor
			// coordinator's reservation for it: after a settled switch that is the new conversation, and
			// the original T no longer selects anything. An editor that holds no reservation
			// yet (the activation pass) is reserved for the conversation its committed slot
			// binding names, exactly as the serializer reserves it; the viewType's tab is
			// only the answer for an editor with no binding row.
			// Only the elected editor may own this conversation's endpoint; a duplicate
			// actual Webview input is still observed, but never gets a native route or secret.
			if (deps.editors().tabOfEditor(entry.editorId) === null) {
				const elected = deps.reserveSlot(index, editorConversation(index, entry), entry.editorId, "saved");
				if (elected.outcome === "lost") continue;
			}
			const conversation = editorConversation(index, entry);
			if (index.get(conversation) === null) continue;
			const state = deps.tabs().get(entry.editorId);
			if (state !== undefined && state.bridge?.editorId === entry.editorId && state.bridge.documentId !== null) continue;
			const endpoint = await ensureBridgeEndpoint(context, entry.tabId, entry.editorId);
			if (endpoint === null) continue;
			if (!deps.editors().holdsEditor(entry.editorId)) {
				await endpoint.forget();
				deps.endpoints().delete(entry.editorId);
				continue;
			}
			// A host re-adopted before this editor was adopted lives in the conversation's own
			// record (nothing named an editor for it yet). The editor that serves the conversation
			// takes that record — its runtime, control channel and counters — so the bridge's
			// native-readiness check finds the running host under the editor's key.
			const held = deps.tabs().get(entry.editorId) === undefined ? deps.tabs().get(conversation) : undefined;
			if (held !== undefined && held.slotId !== entry.editorId && held.panel === null) {
				deps.tabs().delete(held.slotId);
				deps.editorSlots().remove(held.slotId);
				held.slotId = entry.editorId;
				held.tabId = conversation;
				const record = deps.sessions().records.get(conversation);
				if (record !== undefined) record.slotId = entry.editorId;
				deps.tabs().set(entry.editorId, held);
			}
			const current = deps.tabState(entry.editorId);
			if (current.tabId === null) current.tabId = conversation;
			if (current.panel === null) current.mode = deps.sessions().records.get(current.tabId)?.runtime?.kind ?? index.slotBinding(entry.editorId)?.mode ?? deps.defaultSessionMode(context);
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
			if (!deps.editors().holdsEditor(entry.editorId) || current.bridge?.endpoint !== endpoint) continue;
			if (adopted === null) continue;
			deps.diagnostics().note(entry.editorId, `bridge: adopted surviving document ${adopted.documentId.slice(0, 8)} for editor ${entry.editorId.slice(0, 8)}`);
			current.bridge.documentId = adopted.documentId;
			deps.editors().noteDocument(entry.editorId, entry.editorId, adopted.documentId);
			endpoint.offerBridge();
			refreshBridgeReadiness(entry.editorId);
			deps.log.debug(`slot ${entry.editorId}: adopted surviving bridge document ${adopted.documentId.slice(0, 8)}`);
			deps.refreshLauncher();
		}
	}

	/** The ticket of the document this tab's panel currently shows, or `null`. */
	function bridgeTicketFacts(tabId: string): BridgeTicketFacts | null {
		const state = deps.tab(tabId);
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
	function pinBridgeOrigin(tabId: string, panel: vscode.WebviewPanel, report: BridgeOriginReport): void {
		const state = deps.tab(tabId);
		const bridge = state?.bridge ?? null;
		if (state === undefined || bridge === null || state.panel !== panel) return;
		if (bridge.documentId !== report.documentId) {
			deps.log.warn(`tab ${tabId}: an origin report named a document this host no longer serves`);
			return;
		}
		const document = bridge.endpoint.document;
		if (document === null || document.bootstrapId !== report.bootstrapId) {
			deps.log.warn(`tab ${tabId}: an origin report named a bootstrap this host did not mint`);
			return;
		}
		if (!bridge.endpoint.pinOrigin(report.documentId, report.origin)) return;
		deps.log.debug(`tab ${tabId}: bridge origin pinned for document ${report.documentId.slice(0, 8)}`);
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
	function replayHeldReadyReport(state: Tab): boolean {
		const held = state.heldReadyReport;
		if (held === null || state.panel === null || state.tabId === null) return false;
		if (deps.passiveReasonForSlot(state.slotId) !== null) return false;
		state.heldReadyReport = null;
		pinBridgeOrigin(state.tabId, state.panel, held);
		void redeliverBridgeBinding(state.tabId);
		return true;
	}

	/** The chat-host binding this window can verify for one tab right now, or `null`. */
	function liveBridgeBinding(tabId: string): BridgeNativeBinding | null {
		const state = deps.tab(tabId);
		const table = deps.index();
		if (state === undefined || state.tabId === null || table === null) return null;
		const record = deps.sessions().records.get(state.tabId);
		const runtime = record?.runtime ?? null;
		// The binding is the *current* conversation's: the endpoint's namespace T never
		// selects chat authority again after the editor serves another conversation.
		const entry = table.get(state.tabId);
		if (runtime === null || entry === null) return null;
		const live = deps.sessions().conversations.liveOf(state.tabId);
		if (runtime.kind === "chat" && (live === null || live.phase !== "live")) return null;
		if (runtime.kind === "terminal" && (!record?.control || !isOpenControlClient(record.control.client) || runtime.observed?.available !== true || runtime.observed.sessionId !== entry.sessionId || runtime.observed.sessionFile === null || entry.sessionFile === null || !controlPathEquals(runtime.observed.sessionFile, entry.sessionFile))) return null;
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
			sessionId: runtime.kind === "chat" ? live?.headerId ?? entry.sessionId : entry.sessionId,
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
		const state = deps.tab(tabId);
		const bridge = state?.bridge ?? null;
		if (state === undefined || bridge === null) return;
		if (replayHeldReadyReport(state)) return;
		if (bridge.documentId === null || bridge.bound) return;
		const binding = liveBridgeBinding(tabId);
		if (binding === null) return;
		const delivery = await bridge.endpoint.commit(binding);
		if (delivery === null) return;
		bridge.bound = false;
		deps.log.debug(`tab ${tabId}: bridge document ${delivery.documentId.slice(0, 8)} committed`);
		// The endpoint, the document and the binding are bounded facts; the secret and the
		// binding's own fields are not recorded.
		deps.diagnostics().note(
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
		const state = deps.tab(tabId);
		const bridge = state?.bridge ?? null;
		const panel = state?.panel ?? null;
		if (state === undefined || bridge === null || panel === null) return;
		if (bridge.documentId !== delivery.documentId) return;
		const message: GuestBridgeBindMessage = {
			type: "omp:bridge-bind",
			hostGeneration: encodeHex(hostGeneration),
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
		deps.log.debug(`tab ${tabId}: bridge secret delivered for document ${delivery.documentId.slice(0, 8)}`);
	}

	/** Re-send the current document's bridge secret, without rotating it. */
	async function redeliverBridgeBinding(tabId: string): Promise<void> {
		const bridge = deps.tab(tabId)?.bridge ?? null;
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
		const state = deps.tab(tabId);
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
		const state = deps.tabs().get(slot);
		const endpoint = state?.bridge?.editorId === slot ? state.bridge.endpoint : deps.endpoints().get(slot) ?? pendingBridgeEndpoints.get(slot) ?? null;
		if (state?.bridge?.editorId === slot) state.bridge = null;
		deps.liveEditors().delete(slot);
		// Only this editor's own reservation is released, and only its own endpoint and
		// records are forgotten: another editor showing the same conversation — a passive
		// one that still holds an unsent draft, or the incumbent of a live conflict —
		// keeps its own slot, its own credential and its own process.
		const namespaceTabId = deps.editors().tabOfEditor(slot);
		if (namespaceTabId === null) {
			void Promise.resolve(endpoint)
				.then(bound => bound?.forget())
				.catch(() => undefined);
		} else {
			// The helper releases the reservation before its first await. This closes the
			// window where a late bind could adopt an editor the user already closed.
			void retireClosedEditorBridge({ tabId: namespaceTabId, editorId: slot, endpoint, editors: deps.editors() })
				.then(result => {
					if (!result.retired) return;
					deps.log.debug(`slot ${slot}: the closed editor's bridge was retired`);
					deps.diagnostics().note(slot, `bridge: editor ${slot.slice(0, 8)} closed; endpoint and records retired`);
				})
				.catch(() => undefined);
		}
		if (endpoint instanceof Promise) {
			void endpoint.then(bound => {
				if (bound !== null && deps.endpoints().get(slot) === bound) deps.endpoints().delete(slot);
			}).catch(() => undefined);
		} else if (endpoint !== null && deps.endpoints().get(slot) === endpoint) {
			deps.endpoints().delete(slot);
		}
	}

	/** The route of this tab's current document, or `null`. */
	function bridgeRouteOf(tabId: string): BridgeDocumentRoute | null {
		const state = deps.tab(tabId);
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
		deps.cancelControlPicker(tabId);
		const state = deps.tab(tabId);
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
				hostGeneration: encodeHex(hostGeneration),
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
		const state = deps.tab(tabId);
		const bridge = state?.bridge ?? null;
		if (state === undefined || bridge === null || bridge.documentId === null) return;
		const route = bridgeRouteOf(tabId);
		const routeGeneration = route?.routeGeneration ?? null;
		if (route === null || routeGeneration === null) return;
		const status = route.status();
		deps.diagnostics().note(tabId, `bridge: route ${routeGeneration.slice(0, 8)} offered over ${state.panel === null ? "bridge" : "panel"} (${status})`);
		if (state.panel !== null) {
			void state.panel.webview.postMessage({
				type: "omp:route-offer",
				hostGeneration: encodeHex(hostGeneration),
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

	/** The page acknowledged the route generation it was offered over its panel (the dispatcher's `omp:route-ack`). */
	function acknowledgeBridgeRoute(tabId: string, panel: vscode.WebviewPanel, message: GuestRouteAckMessage): void {
		const state = deps.tab(tabId);
		const route = bridgeRouteOf(tabId);
		if (state === undefined || state.panel !== panel || route === null) return;
		if (encodeHex(hostGeneration) !== message.hostGeneration || state.bridge?.documentId !== message.documentId) {
			// Expected once per restored Chat after a reload: the panel still holds the previous host's document and answers its last offer; the new offer follows and is acknowledged normally.
			deps.log.debug(`tab ${tabId}: a route acknowledgement named another host generation or document`);
			return;
		}
		const alreadyAcknowledged = route.acknowledged;
		if (!route.acknowledge(message.routeGeneration, "panel")) {
			deps.log.warn(`tab ${tabId}: a route acknowledgement named a fenced generation`);
			return;
		}
		// Repeated delivery is valid, but an ACK of the ready-status offer must not
		// trigger another identical offer and an unbounded panel round trip.
		if (alreadyAcknowledged) return;
		deps.diagnostics().note(tabId, `bridge: route ${message.routeGeneration.slice(0, 8)} acknowledged over panel`);
		pushBridgeRouteOffer(tabId);
	}

	/** The page acknowledged the secret it was delivered (the dispatcher's `omp:bridge-ack`). */
	function acknowledgeBridgeSecret(tabId: string, panel: vscode.WebviewPanel, message: GuestBridgeAckMessage): void {
		const state = deps.tab(tabId);
		const bridge = state?.bridge ?? null;
		if (state === undefined || state.panel !== panel || bridge === null) return;
		if (encodeHex(hostGeneration) !== message.hostGeneration || bridge.documentId !== message.documentId) return;
		const recorded = bridge.endpoint.committedBindingHash();
		if (recorded === null || recorded !== message.bindingHash) {
			deps.log.warn(`tab ${tabId}: a bridge acknowledgement named a binding this host did not commit`);
			return;
		}
		bridge.bound = true;
		deps.log.debug(`tab ${tabId}: the panel acknowledged its bridge secret`);
		deps.diagnostics().note(tabId, `bridge: the panel acknowledged the secret for document ${bridge.documentId?.slice(0, 8) ?? "unknown"}`);
		refreshBridgeReadiness(tabId);
	}
	return {
		hostGeneration,
		editorMembership,
		editorConversation,
		endpointOf: bridgeEndpointOf,
		documentEligible: bridgeDocumentEligible,
		registerSerializer: registerBridgeSerializer,
		prepareDocument: prepareBridgeDocument,
		adoptEditor: adoptBridgeEditor,
		syncEditors: syncBridgeEditors,
		ticketFacts: bridgeTicketFacts,
		pinOrigin: pinBridgeOrigin,
		replayHeldReadyReport,
		liveBinding: liveBridgeBinding,
		commitDocument: commitBridgeDocument,
		redeliverBinding: redeliverBridgeBinding,
		refreshReadiness: refreshBridgeReadiness,
		retireClosedEditor: retireClosedBridgeEditor,
		routeOf: bridgeRouteOf,
		offerRoute: offerBridgeRoute,
		acknowledgeRoute: acknowledgeBridgeRoute,
		acknowledgeSecret: acknowledgeBridgeSecret,
	};
}
