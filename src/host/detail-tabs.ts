/**
 * Detail tabs of one conversation: the whole TODO, the agent roster, or one agent.
 *
 * A detail tab is a read-only presentation page of an existing conversation, not an editor slot:
 * it has no binding, claim, bridge endpoint or restore identity, and the writer cannot be reached
 * through it. The host attaches it to the conversation as a {@link ChatPage} once the
 * document announces itself, so it receives the same epoch-bound state, snapshot and event stream
 * as a chat page; this registry is the gate: it forwards to the conversation only the one read-only
 * child exchange (`omp:chat-subagent-read`) and the announcement, and drops every other message
 * before the runtime sees it. It answers two other messages itself, as presentation that never
 * reaches the runtime: `omp:open-detail` opens or reveals a sibling tab of the same conversation
 * (the roster's rows open that agent's own tab), and `omp:terminal-link-open` with an `http(s)`
 * target opens a web link the user clicked, re-validated here. File links are not rendered in a
 * detail tab (it has no session folder to resolve them against), so any other link request is refused.
 *
 * One tab per (conversation, kind, agent id): a second request reveals the existing editor. The
 * registry has no vscode import so its rules are testable with fake panels.
 */
import { GUEST_PROTOCOL_VERSION, parseGuestWebviewMessage } from "../webview/messages.ts";
import { detailKey, type DetailTarget } from "../webview/detail-target.ts";
import { webLinkUrl, type WebLinkMode } from "../webview/terminal-links.ts";
import type { ChatCommandOutcome, ChatPage } from "./chat-runtime.ts";
import type { ChatWebviewMessage } from "../webview/chat-messages.ts";

/** The slice of a VS Code WebviewPanel this registry uses. */
export interface DetailPanel {
	title?: string;
	readonly webview: {
		postMessage(message: unknown): PromiseLike<boolean>;
		onDidReceiveMessage(listener: (message: unknown) => void): { dispose(): void };
	};
	reveal(): void;
	dispose(): void;
	onDidDispose(listener: () => void): { dispose(): void };
}

/**
 * The detail panels' view type. It deliberately avoids the `omp.session` prefix: package.json's
 * editor-title, Escape and Ctrl+Enter when-clauses match `^omp[.]session`, and a detail tab is not
 * a session editor (no mode actions, no stop or send keybindings).
 */
export const DETAIL_VIEW_TYPE = "omp.detail";

export interface DetailTabsHost {
	/** Create the editor tab with its document installed, named for what it shows. */
	createPanel(conversation: string, target: DetailTarget): DetailPanel;
	attachPage(conversation: string, page: ChatPage): () => void;
	handleMessage(conversation: string, message: ChatWebviewMessage, origin: ChatPage): Promise<ChatCommandOutcome>;
	/** Open a re-validated `http(s)` URL the user clicked; reports its own failure to the user. */
	openUrl(url: string, mode: WebLinkMode): Promise<void>;
	log(message: string): void;
}

/** Shown by the runtime for any command a detail tab should never send. */
export const DETAIL_READ_ONLY_REASON = "This is a read-only detail view.";

interface DetailTab {
	readonly conversation: string;
	readonly panel: DetailPanel;
	readonly label: string;
	readonly page: ChatPage;
	detach: (() => void) | null;
	disposed: boolean;
}

export class DetailTabs {
	readonly #host: DetailTabsHost;
	readonly #tabs = new Map<string, DetailTab>();
	#sequence = 0;

	constructor(host: DetailTabsHost) {
		this.#host = host;
	}

	/** Open the tab for `target`, or reveal the one that already exists. */
	open(conversation: string, target: DetailTarget): "created" | "revealed" {
		const key = detailKey(conversation, target.kind, target.kind === "agent" ? target.agentId : undefined);
		const existing = this.#tabs.get(key);
		if (existing !== undefined) {
			existing.panel.reveal();
			return "revealed";
		}
		const panel = this.#host.createPanel(conversation, target);
		const tab: DetailTab = {
			conversation,
			panel,
			label: target.kind === "todo" ? "TODO" : target.kind === "agents" ? "Agents" : target.agentId,
			page: {
				id: `detail-${++this.#sequence}`,
				readOnlyReason: () => DETAIL_READ_ONLY_REASON,
				post: message => {
					if (tab.disposed) return "dropped";
					if (message.type === "omp:chat-state" && message.title) panel.title = `${tab.label} · ${message.title}`;
					void panel.webview.postMessage(message);
					return "sent";
				},
			},
			detach: null,
			disposed: false,
		};
		this.#tabs.set(key, tab);
		panel.webview.onDidReceiveMessage(message => {
			void this.#receive(tab, message).catch(() => this.#host.log(`detail ${tab.page.id}: a message could not be processed`));
		});
		panel.onDidDispose(() => {
			tab.disposed = true;
			tab.detach?.();
			tab.detach = null;
			if (this.#tabs.get(key) === tab) this.#tabs.delete(key);
		});
		return "created";
	}

	/** Keep detail editor names aligned with the session row and editor. */
	renameConversation(conversation: string, headline: string): void {
		for (const tab of this.#tabs.values()) {
			if (tab.conversation === conversation) tab.panel.title = `${tab.label} · ${headline}`;
		}
	}

	/** Close every detail tab of a conversation that no longer exists or no longer shows chat. */
	closeConversation(conversation: string): void {
		for (const tab of [...this.#tabs.values()]) {
			if (tab.conversation === conversation) tab.panel.dispose();
		}
	}

	dispose(): void {
		for (const tab of [...this.#tabs.values()]) tab.panel.dispose();
	}

	/** Open tabs, for tests and diagnostics. */
	get size(): number {
		return this.#tabs.size;
	}

	async #receive(tab: DetailTab, raw: unknown): Promise<void> {
		if (tab.disposed) return;
		const message = parseGuestWebviewMessage(raw);
		if (message === null) {
			this.#host.log(`detail ${tab.page.id}: ignored an unrecognized message`);
			return;
		}
		if (message.type === "omp:ready") {
			if (message.protocolVersion !== GUEST_PROTOCOL_VERSION) {
				this.#host.log(`detail ${tab.page.id}: guest protocol ${message.protocolVersion} != ${GUEST_PROTOCOL_VERSION}; the conversation was not sent`);
				return;
			}
			// A document that announces itself again (reload, shown again) is sent the conversation fresh.
			tab.detach?.();
			tab.detach = this.#host.attachPage(tab.conversation, tab.page);
			return;
		}
		if (message.type === "omp:open-detail") {
			const target: DetailTarget = message.kind === "agent" ? { kind: "agent", agentId: message.agentId } : { kind: message.kind };
			this.#host.log(`detail ${tab.page.id}: detail tab ${target.kind} was ${this.open(tab.conversation, target)}`);
			return;
		}
		if (message.type === "omp:terminal-link-open") {
			const url = webLinkUrl(message.target);
			if (url !== null) {
				await this.#host.openUrl(url, message.mode ?? "editor");
				return;
			}
		}
		if (message.type === "omp:chat-subagent-read") {
			const outcome = await this.#host.handleMessage(tab.conversation, message, tab.page);
			if (outcome !== "accepted") this.#host.log(`detail ${tab.page.id}: ${message.type} was ${outcome}`);
			return;
		}
		this.#host.log(`detail ${tab.page.id}: a ${message.type} request was refused`);
	}
}
