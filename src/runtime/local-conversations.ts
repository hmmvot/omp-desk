/**
 * The in-process `ConversationPort` (ADR-0066): the window's view of its conversations, over the
 * `ChatRuntime` the runtime owns. The port's inputs and outputs are values; the chat model, the
 * reducer and the live `RpcSession` stay behind it. `sessionOf` is the one transitional member
 * that returns a live object, kept on `LocalSessionRuntime` and not on the port.
 */
import type { ChatStatePayload } from "../chat/model.ts";
import type { ChatWebviewMessage } from "../protocol/chat-messages.ts";
import type { ChatCommandOutcome, ChatPage, ChatRuntime, ConversationActivity, RewindRead } from "../host/chat-runtime.ts";
import type { NavigateOutcome, NavigateRequest } from "../host/rpc/session.ts";
import type { ConversationPort, LegacyViewRequest, ViewOnlyRequest } from "./session-runtime.ts";

export class LocalConversations implements ConversationPort {
	readonly #chat: ChatRuntime;

	constructor(chat: ChatRuntime) {
		this.#chat = chat;
	}

	has(conversation: string): boolean {
		return this.#chat.has(conversation);
	}

	kindOf(conversation: string): "live" | "view-only" | "legacy" | null {
		return this.#chat.kindOf(conversation);
	}

	stateOf(conversation: string): ChatStatePayload | null {
		return this.#chat.stateOf(conversation);
	}

	activityOf(conversation: string): ConversationActivity | null {
		return this.#chat.activityOf(conversation);
	}

	promptsOf(conversation: string): string[] {
		return this.#chat.promptsOf(conversation);
	}

	rewindOf(conversation: string): RewindRead {
		return this.#chat.rewindOf(conversation);
	}

	showViewOnly(conversation: string, request: ViewOnlyRequest): Promise<void> {
		return this.#chat.showViewOnly(conversation, request);
	}

	showLegacy(conversation: string, request: LegacyViewRequest): void {
		this.#chat.showLegacy(conversation, request);
	}

	release(conversation: string): void {
		this.#chat.release(conversation);
	}

	attachPage(conversation: string, page: ChatPage): () => void {
		return this.#chat.attachPage(conversation, page);
	}

	hasPage(conversation: string): boolean {
		return this.#chat.hasPage(conversation);
	}

	resend(conversation: string, pageId: string): void {
		this.#chat.resend(conversation, pageId);
	}

	command(conversation: string, message: ChatWebviewMessage, origin: ChatPage | null): Promise<ChatCommandOutcome> {
		return this.#chat.handleMessage(conversation, message, origin);
	}

	navigate(conversation: string, request: NavigateRequest, origin: ChatPage | null): Promise<NavigateOutcome> {
		return this.#chat.navigate(conversation, request, origin);
	}

	notify(conversation: string, text: string): boolean {
		return this.#chat.notify(conversation, text);
	}

	refreshDisplayPreferences(): void {
		this.#chat.refreshDisplayPreferences();
	}

	dispose(): void {
		this.#chat.dispose();
	}
}
