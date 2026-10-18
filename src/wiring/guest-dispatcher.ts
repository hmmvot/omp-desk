/**
 * What the extension does with one message from a page: the dispatch of every `omp:*` page message to its owner,
 * the chat commands and their send results, the bounded handoffs that ask a page for something and wait for its
 * reply (the composer draft of a document about to be replaced, the text selected for a symbol search), the
 * detail tabs a page asks for, the empty chat's recent sessions, and the presentation of a tab that has no live conversation.
 *
 * Guest messages are untrusted UI input. This module parses nothing itself (`parseGuestWebviewMessage` is the
 * boundary), keeps nothing of the extension's own state except the two request tables no other part of the
 * extension reads, and reaches everything else through {@link GuestDispatcherDeps}: the window's tab records, the
 * conversation runtime, the editor and bridge lifecycle, the terminal and the host-control exchanges all arrive
 * as getters and callbacks.
 */

import * as vscode from "vscode";
import { pathToFileURL } from "node:url";
import { AttachedFileRegistry, readAttachedFiles, readAttachedForSend } from "../host/attached-files.ts";
import { TAB_INPUT_VIEW_TYPE_PREFIX } from "../host/bridge-identity.ts";
import type { ChatCommandOutcome, ChatPage } from "../host/chat-runtime.ts";
import type { ConversationPort } from "../runtime/session-runtime.ts";
import { DETAIL_VIEW_TYPE, LEGACY_DETAIL_VIEW_TYPE } from "../host/detail-tabs.ts";
import type { DetailTabs } from "../host/detail-tabs.ts";
import { MERMAID_PREVIEW_VIEW_TYPE, type MermaidPreviews } from "../host/mermaid-previews.ts";
import type { SessionIndex } from "../host/session-index.ts";
import { sameEpoch } from "../chat/model.ts";
import type { ArtifactDocuments } from "./artifact-documents.ts";
import type { ChatWebviewMessage } from "../protocol/chat-messages.ts";
import type { DetailTarget } from "../protocol/detail-target.ts";
import {
	GUEST_PROTOCOL_VERSION,
	parseGuestWebviewMessage,
} from "../protocol/messages.ts";
import type {
	GuestBridgeAckMessage,
	GuestChatCommand,
	GuestControlInvalidateMessage,
	GuestControlRequestMessage,
	GuestDraftReplyMessage,
	GuestDraftRequestMessage,
	GuestDraftRestoreMessage,
	GuestAttachedFilesMessage,
	GuestFileCompletionsMessage,
	GuestFilesReadMessage,
	GuestHostMessage,
	GuestOpenArtifactMessage,
	GuestOpenDetailMessage,
	GuestRecallDocument,
	GuestRecallPromptMessage,
	GuestRouteAckMessage,
	GuestSelectionReplyMessage,
	GuestSelectionRequestMessage,
	GuestTerminalCopyReplyMessage,
	SessionViewMode,
} from "../protocol/messages.ts";
import { MAX_ATTACH_ITEMS } from "../shared/attach-limits.ts";
import { splitFileBlocks } from "../shared/file-blocks.ts";
import type { EmptyStateKeyCommand } from "../shared/key-hints.ts";
import type { Logger } from "../shared/logger.ts";
import { fileSearchValue, normalizeSymbolQuery } from "../shared/selection-query.ts";
import type { RecentSessions } from "./recent-sessions.ts";

/** The chat commands a page sends; each is deduplicated by its own request id in the conversation. */
export const CHAT_COMMAND_TYPES: ReadonlySet<string> = new Set([
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
	"omp:chat-btw-request",
	"omp:chat-subagent-read",
	"omp:chat-navigate",
]);

/** How long a page is given to report its selection before the symbol search opens empty. */
const SELECTION_REQUEST_TIMEOUT_MS = 500;
/** The tab types a sweep closes at activation: the detail tab (current and before ADR-0068) and the diagram tab, none of which a restart revives. */
const DETAIL_VIEW_TYPES: readonly string[] = [DETAIL_VIEW_TYPE, LEGACY_DETAIL_VIEW_TYPE, MERMAID_PREVIEW_VIEW_TYPE];

/** How long one document is given to hand its unsent draft over before it is replaced. */
const DRAFT_CAPTURE_TIMEOUT_MS = 1_500;

/** The bridge endpoint of an editor, as far as an invalidation reads it. */
export interface GuestBridgeBinding {
	/** The document incarnation whose HTML the editor's panel currently shows. */
	readonly documentId: string | null;
	readonly endpoint: { invalidateRoute(documentId: string, routeGeneration: string | null): void };
}

/** What the dispatcher reads and changes of one editor record of this window. */
export interface GuestTab {
	/** The immutable key the record is filed under. */
	readonly slotId: string;
	/** The conversation the editor shows, or `null` for a folder shell. */
	readonly tabId: string | null;
	readonly mode: SessionViewMode;
	readonly panel: vscode.WebviewPanel | null;
	/** The document the panel shows now; only a `"guest"` document has a composer to ask. */
	readonly document: { readonly kind: string } | null;
	/** The origin report of a page that announced itself while its editor could not act yet. */
	heldReadyReport: object | null;
	readonly bridge: GuestBridgeBinding | null;
}

/**
 * Drafts captured from a replaced document, waiting for its successor to be ready.
 *
 * The draft is transient by construction: it lives in memory only, is never written to
 * Webview state, is never logged and remains held until the replacement acknowledges it.
 */
export interface CarriedDraft<Tab extends GuestTab = GuestTab> {
	reply: GuestDraftReplyMessage;
	source: Tab;
	panel: vscode.WebviewPanel;
	document: Tab["document"];
	restoredDocument: Tab["document"];
}

/** The window's own records the dispatcher reads and changes. */
export interface GuestWindowFacts<Tab extends GuestTab> {
	/** The activation context, `undefined` before activation. */
	context(): vscode.ExtensionContext | undefined;
	/** The editor records by their immutable slot. */
	tabs(): Map<string, Tab>;
	/** The record an editor slot or a conversation resolves to. */
	tab(key: string | null): Tab | undefined;
	/** The OMP editor in front of the workbench, with its conversation and panel. */
	activePanelTab(): (Tab & { tabId: string; panel: vscode.WebviewPanel }) | null;
	/** Drafts waiting for the editor that replaced their document, by editor slot. */
	draftRestores(): Map<string, CarriedDraft<Tab>>;
	/** Tabs whose composer currently shows its `@`-completion popup (reported by the page). */
	composerPopupTabs(): Set<string>;
}

/** The conversation runtime, what hangs on a conversation, and the actions a page runs through it. */
export interface GuestChatPort<Tab extends GuestTab> {
	conversations(): Pick<ConversationPort, "command" | "stateOf" | "kindOf" | "showViewOnly">;
	detailTabs(): Pick<DetailTabs, "open">;
	/** The diagram tabs ("Open diagram in a tab"). */
	mermaidPreviews(): Pick<MermaidPreviews, "open">;
	/** The read-only `omp-artifact:` documents ("Open full output" of a truncated tool result). */
	artifactDocuments(): Pick<ArtifactDocuments, "open">;
	/** The session transcript file of a conversation, or `null` when it has none (a conversation that was never saved). */
	sessionFileOf(tabId: string): string | null;
	/** The page object the conversation answers one panel through. */
	panelChatPage(state: Tab, panel: vscode.WebviewPanel): ChatPage;
	/** Send the conversation to the editor slot's page (or, with `force`, send it again). */
	attachChatRoute(slot: string, force?: boolean): void;
	/** Send the conversation to every page that shows it. */
	attachChatRoutes(tabId: string, force?: boolean): void;
	/** Remember an accepted prompt of one conversation for the history search; the sending tab's folder makes a file's path absolute. */
	rememberPrompt(text: string, tabId: string): void;
	/** A named chat action of the page: compact, shake, cycle model, export, share, provider login. */
	runChatAction(context: vscode.ExtensionContext, index: SessionIndex, tabId: string, command: GuestChatCommand): Promise<void>;
	/** The folder of the process this window runs for a conversation, or `null` when it runs none. */
	hostedCwd(tabId: string): string | null;
	/** The symbol search of a selection a Chat page has (see `searchSymbol`), in the folder of the conversation `tabId` shows. */
	searchSymbol(query: string, tabId: string): Promise<void>;
	/** The workspace paths a composer's `@`-mention query matches below a folder. */
	completeFiles(cwd: string, query: string): Promise<GuestFileCompletionsMessage["paths"]>;
	/** The host's own file dialog for the attach button: the paths the user chose, none on cancel. Never rejects a cancel; a failure rejects. */
	pickFiles(defaultFolder: string | null): Promise<readonly string[]>;
	/** True when an open editor holds unsaved changes to this file. */
	hasUnsavedChanges(fsPath: string): boolean;
	/** The recent sessions of the page's own folder an empty chat lists, and the open of one of them. */
	recents: RecentSessions;
	/** Open Keyboard Shortcuts filtered to the current key of one empty-state command; does nothing for a command with no key or none known yet. */
	openKeyConflict(command: EmptyStateKeyCommand): Promise<void>;
}

/** The editor's document and session view: what a page's announcement and a mode request drive. */
export interface GuestEditorPort<Tab extends GuestTab> {
	pushSessionView(index: SessionIndex | null, state: Tab, force?: boolean): void;
	/** Record that the page of the editor's current document announced itself. */
	noteReadyDocument(state: Tab, announcedDocumentId: string | undefined): void;
	activateNativeEditor(state: Tab): void;
	switchSessionMode(context: vscode.ExtensionContext, index: SessionIndex, state: Tab, mode: SessionViewMode): Promise<void>;
	/** Publish the editor-in-front facts the keybinding contexts read. */
	refreshGuestContext(): void;
}

/** The reconnecting bridge: the route and the binding of the document a page announced or acknowledged. */
export interface GuestBridgePort {
	/** The route the conversation's document is served over, or `null` when it has none. */
	bridgeRouteOf(tabId: string): { readonly routeGeneration: string | null } | null;
	/** The page proved its origin: pin it to the document the bridge expects. */
	pinBridgeOrigin(tabId: string, panel: vscode.WebviewPanel, report: { readonly documentId: string; readonly bootstrapId: string; readonly origin: string }): void;
	/** Send the already committed secret again to a page that announced itself again. */
	redeliverBridgeBinding(tabId: string): Promise<void>;
	/** The page acknowledged the route generation it was offered. */
	acknowledgeBridgeRoute(tabId: string, panel: vscode.WebviewPanel, message: GuestRouteAckMessage): void;
	/** The page acknowledged the secret it was delivered. */
	acknowledgeBridgeSecret(tabId: string, panel: vscode.WebviewPanel, message: GuestBridgeAckMessage): void;
}

/** The terminal vocabulary: what a page's terminal messages and a terminal copy reply are answered by. */
export interface GuestTerminalPort<Tab extends GuestTab> {
	/** `true` for a message type of the terminal vocabulary. */
	isTerminalPanelType(type: string): boolean;
	/** Answer one terminal message from the page that shows an editor slot. */
	handleTerminalMessage(slot: string, parsed: { readonly type: string }, payload: Record<string, unknown>): Promise<void>;
	/** A page's reply to a screen-copy request. */
	acceptTerminalCopy(state: Tab, reply: GuestTerminalCopyReplyMessage): Promise<void>;
}

/** The bounded host-control exchanges of the footer: model, thinking level and the pickers. */
export interface GuestControlPort {
	/** Answer one control request over the panel route, correlated by the page's action sequence. */
	controlRequest(index: SessionIndex, tabId: string, request: GuestControlRequestMessage, panel: vscode.WebviewPanel): Promise<void>;
}

/** The log and the notifications. Notifications carry the extension's own prefix. */
export interface GuestNotices {
	log: Logger;
	info(message: string): void;
	warn(message: string): void;
	error(message: string): void;
}

export interface GuestDispatcherDeps<Tab extends GuestTab = GuestTab>
	extends GuestWindowFacts<Tab>, GuestChatPort<Tab>, GuestEditorPort<Tab>, GuestBridgePort, GuestTerminalPort<Tab>,
		GuestControlPort, GuestNotices {}

/** What the extension calls into the guest dispatcher. */
export interface GuestDispatcher<Tab extends GuestTab = GuestTab> {
	/**
	 * Dispatch one message from the page of an editor slot. Addressed by the immutable slot: what the editor
	 * shows is resolved here, at dispatch, so a listener registered earlier still answers for the conversation
	 * the editor serves now.
	 */
	handleMessage(index: SessionIndex, slot: string, panel: vscode.WebviewPanel, message: unknown): Promise<void>;
	/** Run one chat command through the conversation and record what became of it. */
	runChatCommand(tabId: string, message: ChatWebviewMessage, page: ChatPage): Promise<ChatCommandOutcome>;
	/** Tell a page its send was accepted, explained, unconfirmed or refused. */
	replyChatSendResult(tabId: string, message: ChatWebviewMessage, page: ChatPage, outcome: ChatCommandOutcome): void;
	/** The page's own answer to the selection request; a reply from another editor or panel is not the request's. */
	acceptSelectionReply(slot: string, panel: vscode.WebviewPanel, reply: GuestSelectionReplyMessage): void;
	/**
	 * What the history search's pick means for the tab that receives it: the prompt's prose and, for each file the remembered
	 * message carried by reference, a document the host re-validated (the drop rule and the text rule) and minted a reference for in
	 * this tab's registry, or a sentence for why it could not come back.
	 */
	recalledPrompt(tabId: string, text: string): Promise<GuestRecallPromptMessage>;
	/** `ompDesk.searchSymbolFromChat` (Ctrl+N over a Chat page). */
	searchSymbolFromChat(): Promise<void>;
	/** `ompDesk.searchFileFromChat` (Ctrl+Shift+N over a Chat page). */
	searchFileFromChat(): Promise<void>;
	/** Ask one editor's page for its unsent composer draft (ADR-0025's bounded handoff). */
	captureDraft(source: Tab): Promise<CarriedDraft<Tab> | null>;
	/** The unsent draft of a panel that is about to be replaced by another editor of the same conversation. */
	carryDraftFrom(previous: vscode.WebviewPanel | null): Promise<CarriedDraft<Tab> | null>;
	/** Cancel only the source capture; an already-replaced document has nothing to unlock. */
	releaseCarriedDraft(carried: CarriedDraft<Tab> | null): void;
	/** Open, or reveal, one detail tab of the conversation an editor shows. */
	openDetailTab(tabId: string, mode: SessionViewMode, request: GuestOpenDetailMessage): void;
	/** Open, or reveal, the diagram tab of a mermaid source. Presentation only: any editor, active or passive, may ask. */
	openMermaidTab(source: string): void;
	/**
	 * Open one artifact of the conversation an editor or detail tab shows, in a read-only editor tab. Presentation only, so any
	 * editor may ask; the page names the artifact and the epoch it was rendered for, never a path.
	 */
	openArtifact(tabId: string, request: GuestOpenArtifactMessage): Promise<void>;
	/** Close the detail tabs a previous host lifetime left behind. */
	closeLeftoverDetailTabs(): Promise<void>;
	/** Show why a tab has no live conversation. */
	presentUnavailable(index: SessionIndex, tabId: string, reason: string, phase?: "view-only" | "blocked"): void;
	/** Tell one panel that the host-control facts it last read are stale. */
	invalidateControls(tabId: string): void;
}

export function registerGuestDispatcher<Tab extends GuestTab>(deps: GuestDispatcherDeps<Tab>): GuestDispatcher<Tab> {
	/** Selection requests asked of a page and not yet answered, by request id. */
	const selectionRequests = new Map<number, { slot: string; panel: vscode.WebviewPanel; settle(text: string): void }>();
	/** Source of the next selection request id. */
	let selectionRequestSeq = 0;
	/** A reply must belong to the exact source editor and document, not just its id. */
	const draftCaptures = new Map<number, { source: Tab; panel: vscode.WebviewPanel; document: Tab["document"]; settle(reply: GuestDraftReplyMessage | null): void }>();
	/** The files each conversation attached, by the reference the page holds: the host's side of an attachment, dropped with its conversation's last editor. */
	const attachedFiles = new Map<string, AttachedFileRegistry>();
	const attachedFilesOf = (tabId: string): AttachedFileRegistry => {
		let registry = attachedFiles.get(tabId);
		if (registry === undefined) {
			const open = new Set<string>();
			for (const state of deps.tabs().values()) if (state.tabId !== null) open.add(state.tabId);
			for (const known of attachedFiles.keys()) if (!open.has(known)) attachedFiles.delete(known);
			registry = new AttachedFileRegistry();
			attachedFiles.set(tabId, registry);
		}
		return registry;
	};

	async function recalledPrompt(tabId: string, text: string): Promise<GuestRecallPromptMessage> {
		const split = splitFileBlocks(text);
		const omitted = split.blocks.filter(block => block.omitted);
		// Only the reduced form the history stores is turned into references; a full text is restored whole by the page.
		if (omitted.length === 0 || omitted.length !== split.blocks.length) return { type: "omp:recall-prompt", text, documents: [], notes: [] };
		const documents: GuestRecallDocument[] = [];
		const notes: string[] = [];
		for (const block of omitted) {
			if (block.label === null) {
				notes.push(`${block.name} was not remembered (it had no path, so its text was not saved); attach it again.`);
				continue;
			}
			// The remembered path is read like a dropped one: a network path is not opened by the host on its own account.
			const read = await readAttachedFiles([{ uri: pathToFileURL(block.label).href }], attachedFilesOf(tabId));
			const item = read.items.find(candidate => candidate.kind === "document");
			if (item === undefined) notes.push(read.refusals[0] ?? `${block.name} could not be read.`);
			else documents.push({ number: block.number, name: block.name, ref: item.ref, bytes: item.bytes, chars: item.chars });
		}
		return { type: "omp:recall-prompt", text: split.prose, documents, notes };
	}
	/** Source of the next draft-capture request id. */
	let draftCaptureSeq = 0;

	/** The page's own answer to {@link askPageSelection}; a reply from another editor or panel is not this request's. */
	function acceptSelectionReply(slot: string, panel: vscode.WebviewPanel, reply: GuestSelectionReplyMessage): void {
		const pending = selectionRequests.get(reply.requestId);
		if (pending?.slot === slot && pending.panel === panel) pending.settle(reply.text);
	}

	/** The text selected in one editor's page (a webview's selection is invisible to VS Code), or `""` when it does not answer in time. */
	async function askPageSelection(slot: string, panel: vscode.WebviewPanel): Promise<string> {
		const requestId = ++selectionRequestSeq;
		const { promise, resolve } = Promise.withResolvers<string>();
		selectionRequests.set(requestId, { slot, panel, settle: resolve });
		const timer = setTimeout(() => resolve(""), SELECTION_REQUEST_TIMEOUT_MS);
		try {
			if (!await panel.webview.postMessage({ type: "omp:selection-request", requestId } satisfies GuestSelectionRequestMessage)) return "";
			return await promise;
		} finally {
			clearTimeout(timer);
			selectionRequests.delete(requestId);
		}
	}

	/** What the front Chat page has selected, or `""` when no Chat is in front or it does not answer in time. */
	async function frontChatSelection(): Promise<string> {
		const target = deps.activePanelTab();
		return target !== null && target.mode === "chat" ? await askPageSelection(target.slotId, target.panel) : "";
	}

	/**
	 * `ompDesk.searchSymbolFromChat` (Ctrl+N over a Chat page): VS Code's symbol search seeded with what the page has selected,
	 * as it is seeded from an editor's selection; with nothing selected it opens empty. A qualified name is looked up the way a
	 * chat link is (the window's dependency), because VS Code's own search cannot take `Type.Member`.
	 */
	async function searchSymbolFromChat(): Promise<void> {
		const target = deps.activePanelTab();
		const query = target !== null && target.mode === "chat" ? normalizeSymbolQuery(await askPageSelection(target.slotId, target.panel)) : "";
		if (target === null || query === "") await vscode.commands.executeCommand("workbench.action.showAllSymbols");
		else await deps.searchSymbol(query, target.tabId);
	}

	/**
	 * `ompDesk.searchFileFromChat` (Ctrl+Shift+N over a Chat page): VS Code's Go to File seeded with what the page has selected;
	 * with nothing selected it opens empty.
	 */
	async function searchFileFromChat(): Promise<void> {
		const value = fileSearchValue(await frontChatSelection());
		if (value === null) await vscode.commands.executeCommand("workbench.action.quickOpen");
		else await vscode.commands.executeCommand("workbench.action.quickOpen", value);
	}

	/**
	 * Ask one editor's page for its unsent composer draft (ADR-0025's bounded handoff): the old
	 * document is the only thing that holds the text, so it is asked and its answer is what makes
	 * replacing it honest. Silence within the bound is "not captured" — the host never claims to
	 * have preserved text it never received.
	 */
	async function captureDraft(source: Tab): Promise<CarriedDraft<Tab> | null> {
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
	function releaseCarriedDraft(carried: CarriedDraft<Tab> | null): void {
		if (carried === null || carried.source.panel !== carried.panel || carried.source.document !== carried.document) return;
		void carried.panel.webview.postMessage({ type: "omp:draft-release", requestId: carried.reply.requestId } satisfies GuestHostMessage);
	}

	/**
	 * The unsent draft of a panel that is about to be replaced by another editor of the same
	 * conversation, or `null` when there is none. A panel that shows no live chat document has no
	 * composer to ask; a page that does not answer is reported rather than silently emptied.
	 */
	async function carryDraftFrom(previous: vscode.WebviewPanel | null): Promise<CarriedDraft<Tab> | null> {
		if (previous === null) return null;
		let owner: Tab | undefined;
		for (const state of deps.tabs().values()) if (state.panel === previous) { owner = state; break; }
		if (owner === undefined || owner.mode !== "chat" || owner.document?.kind !== "guest") return null;
		const carried = await captureDraft(owner);
		if (carried === null) {
			deps.warn("This editor's complete unsent input could not be captured before the editor was replaced (a read or an edit was still pending, or the input is longer than 2 000 000 characters), so it was not preserved.");
			return null;
		}
		const attachments = carried.reply.attachments + carried.reply.recoverable.reduce((sum, entry) => sum + entry.attachments, 0);
		if (attachments > 0) deps.info(`${attachments} image${attachments === 1 ? "" : "s"} could not be carried to the replacement document. Their text is preserved; reattach them before sending.`);
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
		if (deps.tab(tabId)?.mode !== "chat" || entry === null || entry.sessionFile === null || deps.conversations().kindOf(tabId) !== null) return;
		void deps.conversations()
			.showViewOnly(tabId, { file: entry.sessionFile, cwd: entry.cwd, title: entry.title, reason: "Restoring the session…", phase: "resyncing" })
			.then(() => {
				if (deps.conversations().kindOf(tabId) === "view-only") deps.attachChatRoutes(tabId, true);
			});
	}

	/**
	 * A prompt OMP ran as a command of its own (`handled`) is reported as `explained`: the page starts no turn
	 * state for it, because no turn follows and OMP sends no result for it.
	 */
	function replyChatSendResult(tabId: string, message: ChatWebviewMessage, page: ChatPage, outcome: ChatCommandOutcome): void {
		if (message.type !== "omp:chat-prompt" && message.type !== "omp:chat-steer" && message.type !== "omp:chat-follow-up") return;
		const epoch = deps.conversations().stateOf(tabId)?.epoch;
		if (epoch === undefined) return;
		page.post({
			type: "omp:chat-send-result",
			epoch,
			requestId: message.requestId,
			status: outcome === "accepted" ? "accepted" : outcome === "explained" || outcome === "handled" ? "explained" : outcome === "unconfirmed" ? "unconfirmed" : "refused",
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
			outcome = await deps.conversations().command(tabId, message, page);
		} catch (error) {
			if (message.type !== "omp:chat-prompt" && message.type !== "omp:chat-steer" && message.type !== "omp:chat-follow-up") throw error;
			outcome = "unconfirmed";
		}
		replyChatSendResult(tabId, message, page, outcome);
		const delivered = outcome === "accepted" || outcome === "handled";
		if (delivered && (message.type === "omp:chat-prompt" || message.type === "omp:chat-steer" || message.type === "omp:chat-follow-up")) {
			deps.rememberPrompt(message.text, tabId);
		}
		if (outcome !== "accepted" || message.type === "omp:chat-abort") {
			const line = `tab ${tabId}: ${message.type} ${message.requestId.slice(0, 8)} was ${outcome}`;
			if (delivered) deps.log.info(line);
			else deps.log.warn(line);
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
				if (viewType !== null && DETAIL_VIEW_TYPES.some(type => viewType === type || viewType === `${TAB_INPUT_VIEW_TYPE_PREFIX}${type}`)) leftovers.push(tab);
			}
		}
		if (leftovers.length > 0) await vscode.window.tabGroups.close(leftovers, true);
	}

	/**
	 * Open, or reveal, one detail tab of the conversation an editor shows. Presentation only, so a
	 * passive editor may ask too; the conversation comes from the sending editor, never the message.
	 */
	function openDetailTab(tabId: string, mode: SessionViewMode, request: GuestOpenDetailMessage): void {
		// A terminal editor and a legacy tab have no conversation page to show: nothing would arrive.
		if (mode === "terminal" || deps.conversations().kindOf(tabId) === "legacy") return;
		const target: DetailTarget = request.kind === "agent" ? { kind: "agent", agentId: request.agentId } : { kind: request.kind };
		const outcome = deps.detailTabs().open(tabId, target);
		deps.log.debug(`tab ${tabId}: detail tab ${target.kind} was ${outcome}`);
	}

	function openMermaidTab(source: string): void {
		deps.log.debug(`diagram tab was ${deps.mermaidPreviews().open(source)}`);
	}

	async function openArtifact(tabId: string, request: GuestOpenArtifactMessage): Promise<void> {
		// A page that outlived its conversation (another epoch is live now) opens nothing: the id would name another transcript's file.
		if (!sameEpoch(deps.conversations().stateOf(tabId)?.epoch ?? null, request.epoch)) {
			deps.log.warn(`tab ${tabId}: artifact ${request.artifactId} request was dropped: the page shows another conversation`);
			return;
		}
		const sessionFile = deps.sessionFileOf(tabId);
		if (sessionFile === null) {
			deps.warn("This conversation has no saved session file yet, so its artifacts cannot be opened.");
			return;
		}
		const outcome = await deps.artifactDocuments().open(sessionFile, request.artifactId);
		if (!outcome.opened) {
			deps.log.warn(`tab ${tabId}: artifact ${request.artifactId} was refused: ${outcome.reason}`);
			deps.warn(outcome.reason);
		}
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
		const own = deps.tabs().get(slot);
		if (own === undefined || own.panel !== panel || own.tabId === null) return;
		const tabId = own.tabId;
		const parsed = parseGuestWebviewMessage(message);
		if (!parsed) {
			deps.log.debug(`slot ${slot}: ignored an unrecognized guest message`);
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
			const carried = deps.draftRestores().get(slot);
			if (carried?.reply.requestId === parsed.requestId && carried.restoredDocument === own.document) deps.draftRestores().delete(slot);
			return;
		}
		if (parsed.type === "omp:selection-reply") {
			acceptSelectionReply(slot, panel, parsed);
			return;
		}
		if (parsed.type === "omp:terminal-copy-reply") {
			await deps.acceptTerminalCopy(own, parsed);
			return;
		}
		if (parsed.type === "omp:session-mode") {
			const context = deps.context();
			if (context !== undefined) await deps.switchSessionMode(context, index, own, parsed.mode);
			return;
		}
		if (parsed.type === "omp:open-detail") {
			openDetailTab(tabId, own.mode, parsed);
			return;
		}
		if (parsed.type === "omp:open-mermaid") {
			openMermaidTab(parsed.source);
			return;
		}
		if (parsed.type === "omp:open-artifact") {
			await openArtifact(tabId, parsed);
			return;
		}
		// File links are presentation in either mode: the Chat validates and opens the same file references as the Terminal.
		if (deps.isTerminalPanelType(parsed.type) && (own.mode === "terminal" || parsed.type === "omp:terminal-link-validate" || parsed.type === "omp:terminal-link-symbols" || parsed.type === "omp:terminal-link-open")) {
			await deps.handleTerminalMessage(slot, parsed, parsed as unknown as Record<string, unknown>);
			return;
		}
		if (CHAT_COMMAND_TYPES.has(parsed.type)) {
			await runChatCommand(tabId, parsed as ChatWebviewMessage, deps.panelChatPage(own, panel));
			return;
		}
		switch (parsed.type) {
			case "omp:route-ack":
				deps.acknowledgeBridgeRoute(tabId, panel, parsed);
				return;
			case "omp:bridge-ack":
				deps.acknowledgeBridgeSecret(tabId, panel, parsed);
				return;
			case "omp:ready": {
				if (parsed.protocolVersion !== GUEST_PROTOCOL_VERSION) {
					deps.log.error(`tab ${tabId}: guest protocol ${parsed.protocolVersion} != ${GUEST_PROTOCOL_VERSION}; the conversation was not sent`);
					deps.error(
						"The chat panel and extension are using different versions. Run Developer: Reload Window, then try again.",
					);
					return;
				}
				if (parsed.documentId !== undefined && parsed.editorId !== undefined && parsed.bootstrapId !== undefined && parsed.origin !== undefined) {
					own.heldReadyReport = null;
					deps.pinBridgeOrigin(tabId, panel, { documentId: parsed.documentId, bootstrapId: parsed.bootstrapId, origin: parsed.origin });
					// A page that announces itself again is re-sent the *same* secret when its
					// document is already committed: the delivery is the one step that can be lost in
					// transit, and rotating the secret would break a connection the page already holds.
					void deps.redeliverBridgeBinding(tabId);
				}
				deps.pushSessionView(index, own, true);
				deps.noteReadyDocument(own, parsed.documentId);
				deps.activateNativeEditor(own);
				// The document proves it can receive: it is sent the conversation, always fresh.
				deps.attachChatRoute(slot, true);
				paintSavedHistory(index, tabId);
				// A document that replaced another one receives the draft this host captured from its
				// predecessor. It is put back, never sent, and only once.
				const carried = deps.draftRestores().get(slot);
				if (own.mode === "chat" && own.document?.kind === "guest" && carried !== undefined &&
					(own.document !== carried.document || panel !== carried.panel)) {
					carried.restoredDocument = own.document;
					const { requestId, text, attachments, recoverable, documents } = carried.reply;
					void panel.webview.postMessage({ type: "omp:draft-restore", requestId, text, attachments, recoverable, documents } satisfies GuestDraftRestoreMessage);
				}
				return;
			}
			case "omp:focus-trace":
				deps.log.debug(`tab ${tabId}: focus: ${parsed.detail}`);
				return;
			case "omp:composer-popup":
				if (parsed.open) deps.composerPopupTabs().add(tabId);
				else deps.composerPopupTabs().delete(tabId);
				deps.refreshGuestContext();
				return;
			case "omp:complete-files": {
				const state = deps.tab(tabId);
				const cwd = deps.hostedCwd(tabId) ?? index.get(tabId)?.cwd ?? null;
				if (state?.panel !== panel || cwd === null) return;
				const paths = await deps.completeFiles(cwd, parsed.query);
				if (deps.tab(tabId)?.panel !== panel) return;
				const reply: GuestFileCompletionsMessage = {
					type: "omp:file-completions",
					requestId: parsed.requestId,
					paths,
				};
				void panel.webview.postMessage(reply);
				return;
			}
			case "omp:attach-uris": {
				// The page's own panel only: a request is answered to the panel that asked, and never after it was replaced.
				if (deps.tab(tabId)?.panel !== panel) return;
				const read = await readAttachedFiles(parsed.uris.map(uri => ({ uri })), attachedFilesOf(tabId));
				if (deps.tab(tabId)?.panel !== panel) return;
				const reply: GuestAttachedFilesMessage = { type: "omp:attached-files", requestId: parsed.requestId, items: read.items, refusals: read.refusals };
				void panel.webview.postMessage(reply);
				return;
			}
			case "omp:pick-files": {
				// The dialog is not shown to a replaced panel, and every request that was shown one is answered, an empty answer when the dialog
				// was cancelled or failed, so the page's request always settles.
				if (deps.tab(tabId)?.panel !== panel) return;
				let reply: GuestAttachedFilesMessage = { type: "omp:attached-files", requestId: parsed.requestId, items: [], refusals: [] };
				try {
					const picked = await deps.pickFiles(deps.hostedCwd(tabId) ?? index.get(tabId)?.cwd ?? null);
					if (picked.length > MAX_ATTACH_ITEMS) {
						reply = { ...reply, refusals: [`At most ${MAX_ATTACH_ITEMS} files can be attached at once.`] };
					} else if (picked.length > 0) {
						const read = await readAttachedFiles(picked.map(file => ({ path: file })), attachedFilesOf(tabId));
						reply = { ...reply, items: read.items, refusals: read.refusals };
					}
				} catch (error) {
					deps.log.warn(`tab ${tabId}: the file dialog failed: ${error instanceof Error ? error.message : String(error)}`);
				} finally {
					if (deps.tab(tabId)?.panel === panel) void panel.webview.postMessage(reply);
				}
				return;
			}
			case "omp:read-files": {
				if (deps.tab(tabId)?.panel !== panel) return;
				const cwd = deps.hostedCwd(tabId) ?? index.get(tabId)?.cwd ?? null;
				const read = await readAttachedForSend(parsed.files, parsed.budget, attachedFilesOf(tabId), { cwd, isDirty: deps.hasUnsavedChanges });
				if (deps.tab(tabId)?.panel !== panel) return;
				const reply: GuestFilesReadMessage = { type: "omp:files-read", requestId: parsed.requestId, files: read.files, failures: read.failures };
				void panel.webview.postMessage(reply);
				return;
			}
			case "omp:recent-sessions-request": {
				const state = deps.tab(tabId);
				const cwd = deps.hostedCwd(tabId) ?? index.get(tabId)?.cwd ?? null;
				if (state?.panel !== panel || cwd === null) return;
				void panel.webview.postMessage(deps.recents.answer({ slot, panel, document: state.document }, cwd, tabId, parsed.requestId));
				return;
			}
			case "omp:open-recent": {
				const state = deps.tab(tabId);
				if (state?.panel !== panel) return;
				await deps.recents.open(index, { slot, panel, document: state.document }, parsed);
				return;
			}
			case "omp:open-key-conflict": {
				if (deps.tab(tabId)?.panel !== panel) return;
				await deps.openKeyConflict(parsed.command);
				return;
			}
			case "omp:control-request":
				await deps.controlRequest(index, tabId, parsed, panel);
				return;
			case "omp:chat-command": {
				const context = deps.context();
				if (context !== undefined) await deps.runChatAction(context, index, tabId, parsed.command);
				return;
			}
			default:
				// The terminal vocabulary belongs to the folder shell, never to a chat editor.
				deps.log.debug(`slot ${slot}: ignored a ${parsed.type} message from a chat editor`);
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
		void deps.conversations()
			.showViewOnly(tabId, { file: entry.sessionFile, cwd: entry.cwd, title: entry.title, reason, phase })
			.then(() => deps.attachChatRoutes(tabId, true));
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
		const state = deps.tab(tabId);
		const panel = state?.panel ?? null;
		const message: GuestControlInvalidateMessage = { type: "omp:control-invalidate" };
		if (panel !== null) void panel.webview.postMessage(message);
		// An orphan has no panel handle: its invalidation travels the route it does have.
		const route = deps.bridgeRouteOf(tabId);
		const bridge = state?.bridge ?? null;
		if (panel === null && route !== null && bridge !== null && bridge.documentId !== null) {
			bridge.endpoint.invalidateRoute(bridge.documentId, route.routeGeneration);
		}
	}

	return {
		handleMessage: handleGuestMessage,
		runChatCommand,
		replyChatSendResult,
		acceptSelectionReply,
		searchSymbolFromChat,
		recalledPrompt,
		searchFileFromChat,
		captureDraft,
		carryDraftFrom,
		releaseCarriedDraft,
		openDetailTab,
		openMermaidTab,
		openArtifact,
		closeLeftoverDetailTabs,
		presentUnavailable,
		invalidateControls: invalidateGuestControls,
	};
}
