/**
 * What the Chat page itself knows about an action it asked for, before and beside the host's word: the click is acknowledged in the
 * same frame (the button says `Starting…`), the host's `omp:chat-operation` messages then name the step, and a host that says
 * nothing for {@link CHAT_STALL_MS} is reported in one fixed sentence instead of leaving the button spinning for ever.
 *
 * It is a store of its own, not part of the chat model: a `showViewOnly` epoch swap replaces the model and must not erase the
 * acknowledgement. It decides nothing — the host re-checks every request — and it never sends anything twice. DOM-free, so the
 * node:test runner can load it.
 *
 * See `docs/designs/2026-10-15-immediate-click-feedback.md`, "Chat page".
 */
// Explicit `.ts` specifiers: this module is imported by the node:test runner.
import type { ChatModel } from "../../chat/model.ts";
import type { ChatOperationMessage } from "../../protocol/chat-messages.ts";
import { isLaunchFamily, pendingBannerText, PENDING_SECONDS_AFTER_MS, type PendingKind, type PendingStep } from "../../shared/pending-operation.ts";

/** Without any word from the host for this long, the page stops waiting and says so. */
export const CHAT_STALL_MS = 15_000;
export const CHAT_STALLED_SENTENCE = "OMP Desk has not answered yet. It was not sent again.";

/** The actions only the page itself can begin; the rest arrive from the host as {@link PendingKind}. */
export type ChatLocalKind = "resume" | "restart" | "reconnect" | "stop";
export type ChatOperationKind = PendingKind | ChatLocalKind;

/** One operation as the page shows it. `step` is `null` until the host has named one. */
export interface ChatOperationView {
	readonly kind: ChatOperationKind;
	readonly step: PendingStep | null;
	readonly elapsedMs: number;
	readonly still: boolean;
	readonly requestId: string | null;
}

/** What the page shows: the operation now pending (or none) and the sentence of the last one that stalled. */
export interface ChatOperationState {
	readonly operation: ChatOperationView | null;
	readonly notice: string | null;
}

interface Timers {
	setTimeout(callback: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
	setInterval(callback: () => void, ms: number): unknown;
	clearInterval(handle: unknown): void;
}

export interface ChatOperationStoreOptions {
	readonly now?: () => number;
	readonly stallMs?: number;
	readonly tickMs?: number;
	readonly timers?: Timers;
}

interface Local {
	readonly kind: ChatLocalKind;
	readonly requestId: string;
	readonly since: number;
	/** The phase the page was in; the conversation moving to one of the host-owned phases ends the acknowledgement. */
	readonly phase: ChatModel["phase"];
	stall: unknown;
}

interface Hosted {
	readonly kind: PendingKind;
	readonly step: PendingStep;
	readonly requestId: string | null;
	readonly still: boolean;
	/** The host's elapsed clock at `receivedAt`; the page adds its own delta, so the two clocks never meet. */
	readonly elapsedMs: number;
	readonly receivedAt: number;
}

const GLOBAL_TIMERS: Timers = {
	setTimeout: (callback, ms) => setTimeout(callback, ms),
	clearTimeout: handle => clearTimeout(handle as number),
	setInterval: (callback, ms) => setInterval(callback, ms),
	clearInterval: handle => clearInterval(handle as number),
};

/** The phases in which the host has taken over with banners and states of its own. */
function hostOwnsPhase(phase: ChatModel["phase"]): boolean {
	return phase === "live" || phase === "attaching" || phase === "failed";
}

const NO_OPERATION: ChatOperationState = { operation: null, notice: null };

export class ChatOperationStore {
	readonly #now: () => number;
	readonly #stallMs: number;
	readonly #tickMs: number;
	readonly #timers: Timers;
	readonly #listeners = new Set<() => void>();
	#local: Local | null = null;
	#host: Hosted | null = null;
	#notice: string | null = null;
	#ticker: unknown;
	#state: ChatOperationState = NO_OPERATION;

	constructor(options: ChatOperationStoreOptions = {}) {
		this.#now = options.now ?? Date.now;
		this.#stallMs = options.stallMs ?? CHAT_STALL_MS;
		this.#tickMs = options.tickMs ?? 1_000;
		this.#timers = options.timers ?? GLOBAL_TIMERS;
	}

	getState = (): ChatOperationState => this.#state;

	subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener);
		return () => { this.#listeners.delete(listener); };
	};

	/**
	 * The click was accepted by the page. `false` when this page is already waiting for the same kind of action (a second click is a
	 * no-op), in which case nothing should be posted.
	 */
	begin(kind: ChatLocalKind, requestId: string, phase: ChatModel["phase"]): boolean {
		if (this.#local !== null && this.#local.kind === kind) return false;
		if (this.#host !== null && kind !== "stop" && kind !== "reconnect" && isLaunchFamily(this.#host.kind)) return false;
		this.#cancelLocal();
		this.#notice = null;
		const local: Local = { kind, requestId, since: this.#now(), phase, stall: undefined };
		local.stall = this.#timers.setTimeout(() => this.#stalled(local), this.#stallMs);
		this.#local = local;
		this.#publish();
		return true;
	}

	/** The request `requestId` was provably not delivered, or its action was refused where the page could see it: nothing is pending for it. */
	abandon(requestId: string): void {
		if (this.#local?.requestId !== requestId) return;
		this.#cancelLocal();
		this.#publish();
	}

	/** The host's word. Any such message is contact: the page-local acknowledgement has done its job and the host's operation (or its absence) is what shows. */
	host(message: ChatOperationMessage): void {
		const local = this.#local;
		// A Stop is answered by its own abort result, not by an operation of another kind.
		if (local !== null && local.kind !== "stop") this.#cancelLocal();
		const operation = message.operation;
		this.#host = operation === null ? null : {
			kind: operation.kind, step: operation.step, requestId: operation.requestId, still: operation.still,
			elapsedMs: operation.elapsedMs, receivedAt: this.#now(),
		};
		if (operation !== null) this.#notice = null;
		this.#publish();
	}

	/** The host answered a Stop: it is no longer pending. */
	stopAnswered(requestId: string): void {
		if (this.#local?.kind !== "stop" || this.#local.requestId !== requestId) return;
		this.#cancelLocal();
		this.#publish();
	}

	/** The conversation changed: a phase the host owns ends the page's acknowledgement, and a turn that stopped ends a pending Stop. */
	model(model: Pick<ChatModel, "phase" | "working">): void {
		const local = this.#local;
		if (local === null) return;
		const ended = local.kind === "stop" ? !model.working : model.phase !== local.phase && hostOwnsPhase(model.phase);
		if (!ended) return;
		this.#cancelLocal();
		this.#publish();
	}

	/** The route changed or the host link was lost: whatever was awaited will not be answered here. Silent: the page already says the link is lost. */
	reset(): void {
		if (this.#local === null && this.#host === null && this.#notice === null) return;
		this.#cancelLocal();
		this.#host = null;
		this.#notice = null;
		this.#publish();
	}

	#cancelLocal(): void {
		if (this.#local === null) return;
		this.#timers.clearTimeout(this.#local.stall);
		this.#local = null;
	}

	#stalled(local: Local): void {
		if (this.#local !== local) return;
		this.#local = null;
		this.#notice = CHAT_STALLED_SENTENCE;
		this.#publish();
	}

	#view(): ChatOperationView | null {
		const now = this.#now();
		if (this.#host !== null) {
			const host = this.#host;
			return { kind: host.kind, step: host.step, elapsedMs: host.elapsedMs + Math.max(0, now - host.receivedAt), still: host.still, requestId: host.requestId };
		}
		if (this.#local !== null) return { kind: this.#local.kind, step: null, elapsedMs: Math.max(0, now - this.#local.since), still: false, requestId: this.#local.requestId };
		return null;
	}

	/** A pending Stop and a hosted operation can coexist; the Stop is shown only while no hosted operation is. */
	#publish(): void {
		const operation = this.#view();
		const next: ChatOperationState = operation === null && this.#notice === null ? NO_OPERATION : { operation, notice: this.#notice };
		const changed = next !== this.#state;
		this.#state = next;
		if (operation !== null && this.#ticker === undefined) this.#ticker = this.#timers.setInterval(() => this.#publish(), this.#tickMs);
		else if (operation === null && this.#ticker !== undefined) {
			this.#timers.clearInterval(this.#ticker);
			this.#ticker = undefined;
		}
		if (changed) for (const listener of [...this.#listeners]) listener();
	}
}

/** The banner sentence of an operation the page shows: the host's step when it has named one, a plain acknowledgement before that. */
export function operationBannerText(operation: ChatOperationView): string | null {
	switch (operation.kind) {
		case "stop":
		case "rename":
		case "export":
		case "reload-windows":
		case "inventory-toggle":
		case "kill":
		case "delete":
		case "forget":
			return null;
		case "reconnect":
			return `Reconnecting to the session…${secondsSuffix(operation.elapsedMs)}`;
		case "resume":
		case "restart":
		case "open":
		case "new-session":
		case "close":
		case "view-switch":
			return operation.step === null
				? `${operation.kind === "close" ? "Closing" : "Starting"} the session…${secondsSuffix(operation.elapsedMs)}`
				: pendingBannerText(operation.kind, operation.step, operation.elapsedMs, operation.still);
	}
}

function secondsSuffix(elapsedMs: number): string {
	return elapsedMs < PENDING_SECONDS_AFTER_MS ? "" : ` · ${Math.floor(elapsedMs / 1000)} s`;
}

/** Whether the operation is one that starts the session: the Resume button reads `Starting…` for it, whoever began it. */
export function startsSession(operation: ChatOperationView | null): boolean {
	return operation !== null && operation.kind !== "stop" && operation.kind !== "reconnect" && isLaunchFamily(operation.kind);
}
