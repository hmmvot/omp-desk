import type { TurnActivityReport } from "../webview/lib/activity.ts";
import type { GuestTurnOutcome } from "../webview/messages.ts";

/** Host-owned projection; hidden editors keep receiving the same RPC observations. */
export type TurnActivity = TurnActivityReport;

/** Keep the Sessions question heuristic separate from notification trigger decisions. */
export function reportsTrailingQuestion(activity: TurnActivity): boolean {
	return activity.trailingQuestion === true && activity.outcome !== "error" && activity.outcome !== "aborted";
}

export type TurnNotice =
	| { kind: "turn-complete"; outcome: GuestTurnOutcome | null }
	| { kind: "request-pending"; requestId: string; requestKind: NonNullable<TurnActivity["pendingRequest"]>["kind"] | "approval"; question: string };

export type NotificationSuppression = "setting-disabled" | "active-visible-focused";
export type NotificationSuppressionObserver = (tabId: string, kind: TurnNotice["kind"], reason: NotificationSuppression | "aborted") => void;

interface ObservedTurn {
	activity: TurnActivity;
	/** Undefined suppression is a fresh completion still waiting for actual idle. */
	completion: { suppression: NotificationSuppression | null | undefined } | null;
	requests: Set<string>;
}

/** Suppress only a disabled setting or the exact active, visible editor in a focused window. */
export function desktopNotificationSuppression(enabled: boolean, focused: boolean, visible: boolean, active: boolean): NotificationSuppression | null {
	return !enabled ? "setting-disabled" : focused && visible && active ? "active-visible-focused" : null;
}

/** Every event is consumed even when suppressed, so looking away/enabling later cannot replay it. */
export class TurnActivityLedger {
	readonly #last = new Map<string, ObservedTurn>();

	readonly #onSuppressed: NotificationSuppressionObserver | undefined;

	constructor(onSuppressed?: NotificationSuppressionObserver) { this.#onSuppressed = onSuppressed; }

	observe(tabId: string, activity: TurnActivity, suppression: NotificationSuppression | null): TurnNotice[] {
		const previous = this.#last.get(tabId);
		const requests = previous === undefined || (previous.activity.settled && !activity.settled)
			? new Set<string>() : previous.requests;
		let completion = previous?.completion ?? null;
		const idle = activity.settled && !activity.streaming && !activity.backgroundWork;
		const previousIdle = previous !== undefined && previous.activity.settled && !previous.activity.streaming && !previous.activity.backgroundWork;
		const fresh = activity.promptStatus !== null || activity.completionOutcome !== null;
		const aborted = activity.promptStatus === "aborted" || activity.completionOutcome === "aborted";
		if (activity.streaming || aborted) completion = null;
		if (previous !== undefined && !activity.streaming) {
			const resultArrived = (activity.promptStatus !== null && previous.activity.promptStatus === null)
				|| (activity.completionOutcome !== null && previous.activity.completionOutcome === null);
			if (completion === null && ((idle && !previousIdle) || (!aborted && fresh && (previous.activity.streaming || resultArrived)))) {
				completion = { suppression: idle ? suppression : undefined };
			} else if (completion !== null && idle && completion.suppression === undefined) {
				completion = { suppression };
			}
		}

		const notices: TurnNotice[] = [];
		const request = activity.pendingRequest;
		if (request !== null && !requests.has(request.id)) {
			requests.add(request.id);
			if (suppression === null) notices.push({ kind: "request-pending", requestId: request.id, requestKind: request.kind, question: request.question });
			else this.#onSuppressed?.(tabId, "request-pending", suppression);
		}
		if (completion !== null && idle && request === null && fresh) {
			const outcome = activity.completionOutcome ?? activity.outcome;
			const reason = activity.promptStatus === "aborted" || outcome === "aborted" ? "aborted"
				: completion.suppression === undefined ? suppression : completion.suppression;
			if (reason === null) notices.push({ kind: "turn-complete", outcome });
			else this.#onSuppressed?.(tabId, "turn-complete", reason);
			completion = null;
		}
		this.#last.set(tabId, { activity, completion, requests });
		return notices;
	}

	/** Reconnect/snapshot history is state, not a newly earned event. */
	baseline(tabId: string, activity: TurnActivity): void {
		this.#last.set(tabId, { activity, completion: null, requests: new Set(activity.pendingRequest === null ? [] : [activity.pendingRequest.id]) });
	}

	forget(tabId: string): void {
		this.#last.delete(tabId);
	}
}

export interface TurnNotifierDeps {
	send(tabId: string, notice: TurnNotice): PromiseLike<unknown>;
	/** Delivery failures are logged with fixed wording by the caller. */
	onError(tabId: string, kind: TurnNotice["kind"]): void;
	onSuppressed: NotificationSuppressionObserver;
}

export class TurnNotifier {
	readonly #ledger: TurnActivityLedger;
	readonly #deps: TurnNotifierDeps;

	constructor(deps: TurnNotifierDeps) {
		this.#deps = deps;
		this.#ledger = new TurnActivityLedger(deps.onSuppressed);
	}

	observe(tabId: string, activity: TurnActivity, suppression: NotificationSuppression | null): void {
		for (const notice of this.#ledger.observe(tabId, activity, suppression)) this.notify(tabId, notice);
	}

	/** Direct delivery for callers whose own source (the native journal) already guarantees monotonic, deduplicated events. */
	notify(tabId: string, notice: TurnNotice): void {
		void Promise.resolve(this.#deps.send(tabId, notice)).catch(() => this.#deps.onError(tabId, notice.kind));
	}

	baseline(tabId: string, activity: TurnActivity): void { this.#ledger.baseline(tabId, activity); }
	forget(tabId: string): void { this.#ledger.forget(tabId); }
}
