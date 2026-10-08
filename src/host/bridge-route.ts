/**
 * One document's route: which transport may dispatch, and what it may dispatch.
 *
 * A document `D` of one editor `E` has exactly one route with control authority
 * at a time, selected for the activation-wide host generation `H`:
 *
 * - **panel** while this host actually holds the `WebviewPanel` handle for `D`;
 * - **bridge** for a surviving page whose handle the restarted host no longer
 *   has, once that page has authenticated on its exact loopback listener.
 *
 * The route is named by a fresh 128-bit generation `R`. Offering a route mints a
 * new `R` and fences the previous one *synchronously*, before the offer is sent,
 * so a reply or a mutation that names the old `R` can never be applied to the new
 * selection. Dispatch authority is granted only when the guest acknowledged
 * *that* `R` within {@link BRIDGE_ROUTE_ACK_TIMEOUT_MS}; an unacknowledged route
 * still exists (the page keeps its chat) but nothing is dispatched over it.
 *
 * This module also owns the one admission path every irreversible mutation goes
 * through, whichever transport carried it: `(D, actionSeq)` is reserved once,
 * strictly increasingly, with a bounded identity of the payload, and exactly one
 * native request id is minted for that reservation. The reservation is what a
 * queued send re-checks immediately before its first byte is written, so a close,
 * a route change or a supersession that happens while a request waits in the
 * queue cancels it instead of letting it run against a state the user can no
 * longer see. A reservation that was sent and never answered settles as
 * `unknown`, and its sequence is never reusable: an uncertain mutation is not
 * resent.
 */

import { asciiJsonText, createToken, isCanonicalToken } from "../bridge-protocol.ts";
import type { BridgeRouteStatus } from "../bridge-protocol.ts";

/** The default deadline for the guest to acknowledge a route offer. */
export const BRIDGE_ROUTE_ACK_TIMEOUT_MS = 5_000;

/** How many settled mutation outcomes are remembered per document. */
const BRIDGE_ROUTE_RESULT_HISTORY = 16;

/**
 * The six states one document endpoint can be in.
 *
 * `PROVISIONING` — fresh HTML, chat may work independently, no verified
 * binding/ACK. `PANEL_BOUND` — the exact panel/document with an acknowledged
 * VS Code route. `DISCONNECTED` — no acknowledged route, chat still mounted.
 * `BRIDGE_AUTHENTICATED_WAITING` — original document and membership verified,
 * native attach or exact file not ready. `BRIDGE_READY` — the same endpoint and
 * every exact native check ready. `RETIRED` — observed close, supersession or a
 * native identity mismatch.
 */
export type BridgeEndpointState =
	| "PROVISIONING"
	| "PANEL_BOUND"
	| "DISCONNECTED"
	| "BRIDGE_AUTHENTICATED_WAITING"
	| "BRIDGE_READY"
	| "RETIRED";

/** Which transport the host selected for one document. */
export type BridgeRouteKind = "panel" | "bridge";

/** Why a mutation could not be admitted. Bounded codes only. */
export type BridgeAdmissionRefusal =
	| "retired"
	| "no-route"
	| "route-unacknowledged"
	| "stale-sequence"
	| "in-flight";

/** The route's only failure type. */
export class BridgeAdmissionError extends Error {
	readonly code: BridgeAdmissionRefusal;

	constructor(code: BridgeAdmissionRefusal, message: string) {
		super(message);
		this.name = "BridgeAdmissionError";
		this.code = code;
	}
}

/** The outcome of one reserved mutation, as far as this window can know it. */
export type BridgeMutationOutcome = "applied" | "refused" | "unknown";

/** One reserved mutation: exactly one native request id, one payload identity. */
export interface BridgeReservation {
	/** The route generation this reservation belongs to. */
	readonly routeGeneration: string;
	/** The strictly increasing per-document sequence the guest supplied. */
	readonly actionSeq: string;
	readonly operation: string;
	/** Bounded identity of the payload this reservation reserved. */
	readonly payloadIdentity: string;
	/** The single native request id minted for this reservation. */
	readonly nativeRequestId: string;
	/**
	 * Re-check the reservation at the last possible moment.
	 *
	 * Called immediately before the native handoff *and* inside the native
	 * client's queued send, where a failure means the request is cancelled before
	 * its first byte is written. It throws {@link BridgeAdmissionError}.
	 */
	verify(): void;
	/** Release the one-mutation slot. The sequence stays spent. */
	settle(outcome: BridgeMutationOutcome): void;
}

/** Notifications a route sends so the extension can log and re-project its state. */
export interface BridgeDocumentRouteHooks {
	/** Called on every state change, with the bounded state name. */
	onStateChanged?(state: BridgeEndpointState): void;
}

/** One document's route and admission ledger. */
export class BridgeDocumentRoute {
	readonly #hostGeneration: Uint8Array;
	readonly #documentId: Uint8Array;
	readonly #hooks: BridgeDocumentRouteHooks;
	readonly #ackTimeoutMs: number;
	/** Current route generation, or `null` before the first offer. */
	#routeGeneration: string | null = null;
	#offeredKind: BridgeRouteKind | null = null;
	#acknowledged = false;
	#ackTimer: NodeJS.Timeout | undefined;
	#retired = false;
	#published: BridgeEndpointState | null = null;
	#panelHandle = false;
	#bridgeAuthenticated = false;
	#nativeReady = false;
	/** Highest reserved `actionSeq`, as a canonical decimal string. */
	#highWater: bigint | null = null;
	#inFlight: { readonly actionSeq: string; readonly operation: string; readonly payload: string; readonly routeGeneration: string } | null = null;
	readonly #results = new Map<string, BridgeMutationOutcome>();

	constructor(options: {
		readonly hostGeneration: Uint8Array;
		readonly documentId: Uint8Array;
		readonly hooks?: BridgeDocumentRouteHooks;
		/** Overridable only so a test can reach the deadline without waiting. */
		readonly ackTimeoutMs?: number;
	}) {
		this.#hostGeneration = options.hostGeneration;
		this.#documentId = options.documentId;
		this.#hooks = options.hooks ?? {};
		this.#ackTimeoutMs = options.ackTimeoutMs ?? BRIDGE_ROUTE_ACK_TIMEOUT_MS;
	}

	get retired(): boolean {
		return this.#retired;
	}

	get documentId(): Uint8Array {
		return this.#documentId;
	}

	/** The route generation currently selected, or `null` before the first offer. */
	get routeGeneration(): string | null {
		return this.#routeGeneration;
	}

	/** Which transport the current route generation was offered over. */
	get offeredKind(): BridgeRouteKind | null {
		return this.#offeredKind;
	}

	/** `true` only when the guest acknowledged the *current* route generation. */
	get acknowledged(): boolean {
		return this.#acknowledged;
	}

	/**
	 * `true` when this document may dispatch a mutation over its route.
	 *
	 * The route generation has to be acknowledged, and the transport that carried
	 * it has to be one this document actually has: an exact panel handle, or an
	 * authenticated bridge *whose exact native checks have passed*. A bridge at
	 * `BRIDGE_AUTHENTICATED_WAITING` is authenticated standby — the page keeps its
	 * chat, but nothing is dispatched over it.
	 */
	get dispatchable(): boolean {
		if (this.#retired || !this.#acknowledged) return false;
		if (this.#panelHandle) return true;
		return this.#bridgeAuthenticated && this.#nativeReady;
	}

	/** The host holds the exact `WebviewPanel` handle for this document again. */
	panelBound(): void {
		if (this.#retired || this.#panelHandle) return;
		this.#panelHandle = true;
		this.#publish();
	}

	/** A page authenticated on this document's exact listener. */
	bridgeAuthenticated(): void {
		if (this.#retired || this.#bridgeAuthenticated) return;
		this.#bridgeAuthenticated = true;
		this.#publish();
	}

	/**
	 * That page's connection ended.
	 *
	 * The document and its mutation ledger survive a dropped socket, but a bridge
	 * route's acknowledgement belongs to that connection. Its replacement must
	 * acknowledge before readiness can attach and resend the chat snapshot.
	 * The panel handle and a panel route's acknowledgement are untouched.
	 */
	bridgeClosed(): void {
		if (this.#retired || !this.#bridgeAuthenticated) return;
		this.#bridgeAuthenticated = false;
		if (this.#offeredKind === "bridge") this.#acknowledged = false;
		this.#publish();
	}

	/** Every exact native check (owner, pid, epoch, exact session file) passed, or stopped passing. */
	nativeReady(ready: boolean): void {
		if (this.#retired || this.#nativeReady === ready) return;
		this.#nativeReady = ready;
		this.#publish();
	}

	/**
	 * The state this document's endpoint is in, derived from the facts above.
	 *
	 * `PROVISIONING` is a document no route has ever been offered for;
	 * `DISCONNECTED` is one whose route is not acknowledged (the page keeps its
	 * chat there); `PANEL_BOUND`, `BRIDGE_AUTHENTICATED_WAITING` and
	 * `BRIDGE_READY` all require the acknowledgement that makes dispatch legal.
	 */
	get state(): BridgeEndpointState {
		if (this.#retired) return "RETIRED";
		if (!this.#acknowledged) return this.#routeGeneration === null && !this.#panelHandle && !this.#bridgeAuthenticated ? "PROVISIONING" : "DISCONNECTED";
		if (this.#panelHandle) return "PANEL_BOUND";
		if (this.#bridgeAuthenticated) return this.#nativeReady ? "BRIDGE_READY" : "BRIDGE_AUTHENTICATED_WAITING";
		return "DISCONNECTED";
	}

	/**
	 * The bounded status word the guest renders for this document.
	 *
	 * `ready` means an acknowledged route that may dispatch and read; `waiting`
	 * means a route exists but an acknowledgement, the native binding or the exact
	 * session file is still missing; `disconnected` means there is no route at all.
	 */
	status(): BridgeRouteStatus {
		if (this.#retired || this.#routeGeneration === null) return "disconnected";
		return this.dispatchable ? "ready" : "waiting";
	}

	/**
	 * Accept the guest's acknowledgement of one route generation.
	 *
	 * Only the generation that is currently selected and the transport that
	 * carried its offer are accepted, so a stale or cross-document acknowledgement
	 * — one from another route, another document or another host activation —
	 * cannot enable dispatch.
	 */
	acknowledge(routeGeneration: unknown, kind: BridgeRouteKind): boolean {
		if (this.#retired || !isCanonicalToken(routeGeneration)) return false;
		if (this.#routeGeneration === null || routeGeneration !== this.#routeGeneration) return false;
		if (this.#offeredKind !== kind) return false;
		clearTimeout(this.#ackTimer);
		this.#ackTimer = undefined;
		this.#acknowledged = true;
		this.#publish();
		return true;
	}

	/** Whether a value names the route generation this document selected. */
	isCurrentRoute(routeGeneration: unknown): boolean {
		return !this.#retired && this.#routeGeneration !== null && routeGeneration === this.#routeGeneration;
	}

	/** The current route generation, for a frame that must name it. */
	requireRouteGeneration(): string {
		if (this.#retired || this.#routeGeneration === null) {
			throw new BridgeAdmissionError("no-route", "This document has no selected route.");
		}
		return this.#routeGeneration;
	}

	/**
	 * Select the route transport and mint the generation the guest must echo.
	 *
	 * The previous generation is fenced here, synchronously: from this call on, an
	 * acknowledgement, a reply or a reservation naming it is refused. The caller
	 * then sends `route-offer(H,D,R,status)` over the chosen transport and enables
	 * dispatch when the guest acknowledges it.
	 */
	offer(kind: BridgeRouteKind): string {
		if (this.#retired) throw new BridgeAdmissionError("retired", "This document's route has been retired.");
		clearTimeout(this.#ackTimer);
		this.#ackTimer = undefined;
		this.#routeGeneration = createToken();
		this.#offeredKind = kind;
		this.#acknowledged = false;
		this.#publish();
		const offered = this.#routeGeneration;
		this.#ackTimer = setTimeout(() => {
			this.#ackTimer = undefined;
			// No acknowledgement inside the deadline: the route is still the
			// selected one, but it cannot dispatch, and the caller is told so (by
			// the state) so it can re-offer.
			if (!this.#retired && this.#routeGeneration === offered && !this.#acknowledged) this.#publish();
		}, this.#ackTimeoutMs);
		return offered;
	}

	/**
	 * Reserve one irreversible mutation.
	 *
	 * The sequence must be a canonical decimal that is strictly greater than
	 * every sequence this document has already reserved, so a duplicate sent over
	 * another transport, or a replay after a lost reply, cannot reserve again —
	 * even though the high-water mark outlives the result cache. The payload is
	 * identified by a hash of the operation and its bounded ASCII encoding.
	 */
	admit(input: {
		readonly routeGeneration: unknown;
		readonly actionSeq: unknown;
		readonly operation: string;
		readonly payload: unknown;
	}): BridgeReservation {
		if (this.#retired) throw new BridgeAdmissionError("retired", "This document's route has been retired.");
		if (this.#routeGeneration === null) throw new BridgeAdmissionError("no-route", "This document has no selected route.");
		if (input.routeGeneration !== this.#routeGeneration) {
			throw new BridgeAdmissionError("no-route", "This mutation named a route generation that has been fenced.");
		}
		if (!this.#acknowledged) {
			throw new BridgeAdmissionError("route-unacknowledged", "This document's route has not been acknowledged by its page.");
		}
		if (!this.dispatchable) {
			throw new BridgeAdmissionError("no-route", "This document's route is not ready for a native mutation.");
		}
		if (this.#inFlight !== null) {
			throw new BridgeAdmissionError("in-flight", "This document already has a mutation in flight.");
		}
		const sequence = canonicalSequence(input.actionSeq);
		if (sequence === null) throw new BridgeAdmissionError("stale-sequence", "A mutation sequence was not a canonical decimal counter.");
		if (this.#highWater !== null && sequence <= this.#highWater) {
			throw new BridgeAdmissionError("stale-sequence", "That mutation sequence was already reserved for this document.");
		}
		const payload = mutationPayloadIdentity(input.operation, input.payload);
		const reservation: BridgeReservation = {
			routeGeneration: this.#routeGeneration,
			actionSeq: sequence.toString(10),
			operation: input.operation,
			payloadIdentity: payload,
			nativeRequestId: createToken(),
			verify: () => this.#verifyReservation(reservation),
			settle: outcome => this.#settle(reservation, outcome),
		};
		this.#highWater = sequence;
		this.#inFlight = {
			actionSeq: reservation.actionSeq,
			operation: input.operation,
			payload,
			routeGeneration: reservation.routeGeneration,
		};
		return reservation;
	}

	/** The last outcome known for one reserved sequence, or `null`. */
	outcomeFor(actionSeq: unknown): BridgeMutationOutcome | null {
		const sequence = canonicalSequence(actionSeq);
		return sequence === null ? null : this.#results.get(sequence.toString(10)) ?? null;
	}

	/** `true` while one reserved mutation has not settled. */
	get mutationInFlight(): boolean {
		return this.#inFlight !== null;
	}

	/** Retire this document. Its secret must be deleted by the caller. */
	retire(): void {
		if (this.#retired) return;
		this.#retired = true;
		clearTimeout(this.#ackTimer);
		this.#ackTimer = undefined;
		this.#acknowledged = false;
		this.#inFlight = null;
		this.#publish();
	}

	#publish(): void {
		const state = this.state;
		if (this.#published === state) return;
		this.#published = state;
		this.#hooks.onStateChanged?.(state);
	}

	#verifyReservation(reservation: BridgeReservation): void {
		if (this.#retired) throw new BridgeAdmissionError("retired", "This document was retired before its mutation was sent.");
		const inFlight = this.#inFlight;
		if (inFlight === null || inFlight.actionSeq !== reservation.actionSeq) {
			throw new BridgeAdmissionError("stale-sequence", "This reservation is no longer the one in flight.");
		}
		if (!this.#acknowledged || inFlight.routeGeneration !== this.#routeGeneration) {
			throw new BridgeAdmissionError("no-route", "This document's route changed before its mutation was sent.");
		}
		if (!this.dispatchable) {
			throw new BridgeAdmissionError("no-route", "This document's route is no longer ready for a native mutation.");
		}
		if (inFlight.payload !== reservation.payloadIdentity) {
			throw new BridgeAdmissionError("stale-sequence", "This reservation's payload is not the one that was reserved.");
		}
	}

	#settle(reservation: BridgeReservation, outcome: BridgeMutationOutcome): void {
		if (this.#inFlight !== null && this.#inFlight.actionSeq === reservation.actionSeq) this.#inFlight = null;
		this.#results.set(reservation.actionSeq, outcome);
		while (this.#results.size > BRIDGE_ROUTE_RESULT_HISTORY) {
			const oldest = this.#results.keys().next();
			if (oldest.done === true) break;
			this.#results.delete(oldest.value);
		}
	}

}

/** A canonical decimal sequence below 2^64, or `null`. */
function canonicalSequence(value: unknown): bigint | null {
	if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(value)) return null;
	const parsed = BigInt(value);
	return parsed > 0n && parsed < 1n << 64n ? parsed : null;
}

/**
 * Bounded identity of one mutation payload.
 *
 * The payload is escaped to printable ASCII (the same encoding the wire uses for
 * a payload field) and prefixed with its operation and length, so two different
 * payloads of one operation can never identify each other and the text stays
 * bounded and canonical.
 */
export function mutationPayloadIdentity(operation: string, payload: unknown): string {
	return `${operation.length}:${operation}:${asciiJsonText(payload)}`;
}
