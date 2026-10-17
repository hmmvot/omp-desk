/**
 * The in-process `ConversationPort` (ADR-0066): the window's view of its conversations, over the
 * `ChatRuntime` the runtime owns. The port's inputs and outputs are values; the chat model, the
 * reducer and the live `RpcSession` stay behind it. A live session is named by an incarnation
 * number (assigned the first time the session is asked about, never reused) and every operation
 * on it checks that number before sending anything.
 */
import type { ChatStatePayload } from "../chat/model.ts";
import type { RpcToolDescriptor } from "../protocol/rpc.ts";
import type { ChatWebviewMessage } from "../protocol/chat-messages.ts";
import type { ChatCommandOutcome, ChatPage, ChatRuntime, ConversationActivity, RewindRead } from "../host/chat-runtime.ts";
import type { ContextRead, ContextReportRead } from "../host/context/context-parse.ts";
import type {
	ChoiceOutcome, CommandResult, CycleModelResult, CycleThinkingResult, MaintenanceRequest, ModelsResult, NavigateOutcome, NavigateRequest, PromptRequest,
	RpcSession, RpcSessionOutput, SendOutcome, ThinkingLevelsResult,
} from "../host/rpc/session.ts";
import type { ConversationPort, JoinResult, LegacyViewRequest, LiveConversation, ModelDefault, StaleIncarnation, ViewOnlyRequest } from "./session-runtime.ts";
import { settingsSessionApply } from "../host/omp-settings-apply.ts";

const STALE: StaleIncarnation = Object.freeze({ status: "stale" });
const JOINED: JoinResult = Object.freeze({ status: "joined" });

export class LocalConversations implements ConversationPort {
	readonly #chat: ChatRuntime;
	readonly #incarnations = new WeakMap<RpcSession, number>();
	#serial = 0;

	constructor(chat: ChatRuntime) {
		this.#chat = chat;
	}

	/** The incarnation number of a session: assigned the first time it is asked, increasing, never reused. */
	#numberOf(session: RpcSession): number {
		let incarnation = this.#incarnations.get(session);
		if (incarnation === undefined) {
			incarnation = ++this.#serial;
			this.#incarnations.set(session, incarnation);
		}
		return incarnation;
	}

	/** The conversation's session when it is still the one `incarnation` names. */
	#session(conversation: string, incarnation: number): RpcSession | null {
		const session = this.#chat.sessionOf(conversation);
		return session !== null && this.#incarnations.get(session) === incarnation ? session : null;
	}

	/** Run `operation` on the named session, or answer `stale` without touching the live one. */
	#on<T>(conversation: string, incarnation: number, operation: (session: RpcSession) => Promise<T>): Promise<T | StaleIncarnation> {
		const session = this.#session(conversation, incarnation);
		return session === null ? Promise.resolve(STALE) : operation(session);
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

	subagentKnownOf(conversation: string, subagentId: string): "roster" | "reference" | null {
		return this.#chat.sessionOf(conversation)?.subagentKnown(subagentId) ?? null;
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

	refreshCodeThemes(): void {
		this.#chat.refreshCodeThemes();
	}

	dispose(): void {
		this.#chat.dispose();
	}

	incarnationOf(conversation: string): number | null {
		const session = this.#chat.sessionOf(conversation);
		return session === null ? null : this.#numberOf(session);
	}

	liveOf(conversation: string): LiveConversation | null {
		const session = this.#chat.sessionOf(conversation);
		if (session === null) return null;
		const model = session.model;
		return {
			incarnation: this.#numberOf(session),
			phase: session.phase,
			epoch: session.epoch,
			state: model.state,
			working: model.working,
			asyncPaused: model.asyncPaused,
			maintenance: model.maintenance,
			pendingControl: model.pendingControl,
			commands: model.commands,
			sessionFile: session.sessionFile,
			sessionId: session.sessionId,
			headerId: model.header?.id ?? null,
			restartOffered: session.restartOffered,
			nativeStateUnanswered: session.nativeStateUnanswered,
		};
	}

	async join(conversation: string, incarnation: number): Promise<JoinResult> {
		const session = this.#session(conversation, incarnation);
		if (session === null) return STALE;
		await session.start();
		return JOINED;
	}

	observe(conversation: string, incarnation: number, listener: (output: RpcSessionOutput) => void): (() => void) | null {
		return this.#session(conversation, incarnation)?.subscribe(listener) ?? null;
	}

	readAvailableModels(conversation: string, incarnation: number): Promise<ModelsResult | StaleIncarnation> {
		return this.#on(conversation, incarnation, session => session.getAvailableModels());
	}

	readAvailableThinkingLevels(conversation: string, incarnation: number): Promise<ThinkingLevelsResult | StaleIncarnation> {
		return this.#on(conversation, incarnation, session => session.getAvailableThinkingLevels());
	}

	readSessionCost(conversation: string, incarnation: number): Promise<number | null> {
		return this.#session(conversation, incarnation)?.readSessionCost() ?? Promise.resolve(null);
	}

	readToolDescriptors(conversation: string, incarnation: number): Promise<readonly RpcToolDescriptor[] | null> {
		return this.#session(conversation, incarnation)?.readToolDescriptors() ?? Promise.resolve(null);
	}

	readContext(conversation: string, incarnation: number): Promise<ContextRead | null> {
		return this.#session(conversation, incarnation)?.readContext() ?? Promise.resolve(null);
	}

	requestContextReport(conversation: string, incarnation: number): Promise<CommandResult<ContextReportRead> | StaleIncarnation> {
		return this.#on(conversation, incarnation, session => session.requestContextReport());
	}

	chooseModel(conversation: string, incarnation: number, provider: string, modelId: string, name?: string): Promise<ChoiceOutcome | StaleIncarnation> {
		return this.#on(conversation, incarnation, session => session.chooseModel(provider, modelId, name));
	}

	chooseThinkingLevel(conversation: string, incarnation: number, level: string): Promise<ChoiceOutcome | StaleIncarnation> {
		return this.#on(conversation, incarnation, session => session.chooseThinkingLevel(level));
	}

	cycleModel(conversation: string, incarnation: number): Promise<CycleModelResult | StaleIncarnation> {
		return this.#on(conversation, incarnation, session => session.cycleModel());
	}

	cycleThinkingLevel(conversation: string, incarnation: number): Promise<CycleThinkingResult | StaleIncarnation> {
		return this.#on(conversation, incarnation, session => session.cycleThinkingLevel());
	}

	maintain(conversation: string, incarnation: number, request: MaintenanceRequest): Promise<CommandResult<string> | StaleIncarnation> {
		return this.#on(conversation, incarnation, session => session.maintain(request));
	}

	exportHtml(conversation: string, incarnation: number, outputPath: string): Promise<CommandResult<string> | StaleIncarnation> {
		return this.#on(conversation, incarnation, session => session.exportHtml(outputPath));
	}

	prompt(conversation: string, incarnation: number, request: PromptRequest): Promise<SendOutcome | StaleIncarnation> {
		return this.#on(conversation, incarnation, session => session.prompt(request));
	}

	setSessionName(conversation: string, incarnation: number, name: string): Promise<SendOutcome | StaleIncarnation> {
		return this.#on(conversation, incarnation, session => session.setSessionName(name));
	}

	setFence(conversation: string, reason: string | null): void {
		this.#chat.sessionOf(conversation)?.setMutationFence(reason);
	}

	applyModelDefault(conversation: string, incarnation: number, model: ModelDefault, stillCurrent: () => boolean): Promise<string | StaleIncarnation> {
		const session = this.#session(conversation, incarnation);
		if (session === null) return Promise.resolve(STALE);
		return settingsSessionApply(session, () => this.#session(conversation, incarnation) === session && stillCurrent())(model);
	}
}
