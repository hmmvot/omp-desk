/**
 * The per-document route's fencing and its one mutation admission path.
 *
 * What is defended here is exactly what the design pins: a route generation that
 * is fenced the moment another one is offered, an acknowledgement that must name
 * the current generation and the transport that carried its offer, dispatch that
 * requires that acknowledgement and a ready state, and an admission ledger where a
 * sequence is spent once — across transports, across a lost reply and across a
 * route change — while a queued send re-checks its reservation before its first
 * write.
 *
 * Runner: `node --test src/host/bridge-route.test.ts`
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BridgeAdmissionError } from "./bridge-route.ts";
import type { BridgeEndpointState } from "./bridge-route.ts";
import { BridgeDocumentRoute } from "./bridge-route.ts";

function documentId(fill: number): Uint8Array {
	return new Uint8Array(16).fill(fill);
}

function route(options: { readonly ackTimeoutMs?: number } = {}): BridgeDocumentRoute {
	return new BridgeDocumentRoute({
		hostGeneration: new Uint8Array(16).fill(0x11),
		documentId: documentId(0x22),
		...(options.ackTimeoutMs === undefined ? {} : { ackTimeoutMs: options.ackTimeoutMs }),
	});
}

/** A route that has been offered over the panel and acknowledged. */
function boundRoute(): BridgeDocumentRoute {
	const document = route();
	document.panelBound();
	document.offer("panel");
	document.acknowledge(document.routeGeneration, "panel");
	return document;
}

async function refusal(run: () => unknown): Promise<string> {
	try {
		await run();
	} catch (error) {
		assert.ok(error instanceof BridgeAdmissionError, `expected an admission error, got ${String(error)}`);
		return error.code;
	}
	assert.fail("expected the call to be refused");
}

describe("document route generations", () => {
	it("fences the previous generation the moment another is offered", () => {
		const document = boundRoute();
		const first = document.routeGeneration;
		assert.equal(document.acknowledged, true);
		const second = document.offer("panel");
		assert.notEqual(second, first);
		assert.equal(document.acknowledged, false, "a fresh offer is not acknowledged yet");
		assert.equal(document.acknowledge(first, "panel"), false, "the fenced generation cannot be acknowledged");
		assert.equal(document.acknowledge(second, "panel"), true);
	});

	it("refuses an acknowledgement from another transport or another document's shape", () => {
		const document = route();
		document.bridgeAuthenticated();
		const offered = document.offer("bridge");
		assert.equal(document.acknowledge(offered, "panel"), false, "a bridge offer is not acknowledged over the panel");
		assert.equal(document.acknowledge(offered, "bridge"), true);
		assert.equal(document.acknowledge("not-a-token", "bridge"), false);
		assert.equal(document.acknowledge(`${offered}00`, "bridge"), false);
		assert.equal(document.isCurrentRoute(offered), true);
		assert.equal(document.isCurrentRoute("f".repeat(32)), false);
	});

	it("re-offers from disconnected and follows native readiness", () => {
		const document = route();
		document.bridgeAuthenticated();
		const offered = document.offer("bridge");
		assert.equal(document.state, "DISCONNECTED", "an unacknowledged offer is not a route");
		assert.equal(document.acknowledge(offered, "bridge"), true);
		assert.equal(document.state, "BRIDGE_AUTHENTICATED_WAITING", "a bridge route waits for the exact native checks");
		document.nativeReady(true);
		assert.equal(document.state, "BRIDGE_READY");
		document.nativeReady(false);
		assert.equal(document.state, "BRIDGE_AUTHENTICATED_WAITING");
		const again = document.offer("bridge");
		assert.equal(document.state, "DISCONNECTED", "fencing the acknowledged route drops the state with it");
		assert.equal(document.acknowledge(again, "bridge"), true);
		assert.equal(document.state, "BRIDGE_AUTHENTICATED_WAITING");
	});

	it("does not dispatch while the route is unacknowledged, waiting or retired", async () => {
		const document = route();
		document.panelBound();
		const offered = document.offer("panel");
		assert.equal(document.dispatchable, false, "an unacknowledged route cannot dispatch");
		document.acknowledge(offered, "panel");
		assert.equal(document.dispatchable, true);
		const reservation = document.admit({
			routeGeneration: document.routeGeneration,
			actionSeq: "1",
			operation: "set-model",
			payload: { model: "a" },
		});
		reservation.settle("applied");
		document.retire();
		assert.equal(document.dispatchable, false);
		assert.equal(document.state, "RETIRED");
		assert.equal(await refusal(async () => document.admit({
			routeGeneration: document.routeGeneration,
			actionSeq: "2",
			operation: "set-model",
			payload: null,
		})), "retired");
		assert.equal(document.outcomeFor("1"), "applied", "a settled outcome outlives the retirement");
	});

	it("treats an authenticated bridge as standby beside a bound panel, and as a route of its own otherwise", async () => {
		const document = route();
		document.panelBound();
		document.bridgeAuthenticated();
		document.offer("panel");
		document.acknowledge(document.routeGeneration, "panel");
		assert.equal(document.state, "PANEL_BOUND", "a bound panel keeps the panel route while a bridge stands by");
		assert.equal(document.dispatchable, true);
		document.bridgeClosed();
		assert.equal(document.dispatchable, true, "losing a standby socket must not revoke the acknowledged panel");

		// The same page with no panel handle: only a fully verified native side
		// makes the bridge a dispatching route.
		const orphan = route();
		orphan.bridgeAuthenticated();
		orphan.nativeReady(true);
		orphan.offer("bridge");
		assert.equal(orphan.state, "DISCONNECTED", "an unacknowledged bridge route is not a route");
		orphan.acknowledge(orphan.routeGeneration, "bridge");
		assert.equal(orphan.state, "BRIDGE_READY");
		assert.equal(orphan.dispatchable, true);
		orphan.nativeReady(false);
		assert.equal(orphan.state, "BRIDGE_AUTHENTICATED_WAITING", "authenticated standby cannot dispatch");
		assert.equal(orphan.dispatchable, false);
		assert.equal(await refusal(() => orphan.admit({ routeGeneration: orphan.routeGeneration, actionSeq: "1", operation: "set-model", payload: null })), "no-route");
		orphan.bridgeClosed();
		assert.equal(orphan.state, "DISCONNECTED", "a dropped socket leaves the page its chat but no route");
		assert.equal(orphan.dispatchable, false);
	});

	it("requires a replacement socket's acknowledgement before dispatch without resetting the document ledger", async () => {
		const document = route();
		document.bridgeAuthenticated();
		document.nativeReady(true);
		const generation = document.offer("bridge");
		document.acknowledge(generation, "bridge");
		document.admit({ routeGeneration: generation, actionSeq: "1", operation: "chat-prompt", payload: { text: "ALPHA" } }).settle("applied");
		document.bridgeClosed();
		document.bridgeAuthenticated();
		assert.equal(await refusal(() => document.admit({ routeGeneration: generation, actionSeq: "2", operation: "chat-prompt", payload: { text: "GAMMA" } })), "route-unacknowledged");
		document.acknowledge(generation, "bridge");
		assert.equal(await refusal(() => document.admit({ routeGeneration: generation, actionSeq: "1", operation: "chat-prompt", payload: { text: "ALPHA" } })), "stale-sequence");
		document.admit({ routeGeneration: generation, actionSeq: "2", operation: "chat-prompt", payload: { text: "GAMMA" } }).settle("applied");
		assert.equal(document.outcomeFor("1"), "applied");
		assert.equal(document.outcomeFor("2"), "applied");
	});

	it("reports every state change once, in order", () => {
		const seen: BridgeEndpointState[] = [];
		const document = new BridgeDocumentRoute({
			hostGeneration: new Uint8Array(16).fill(1),
			documentId: documentId(2),
			hooks: { onStateChanged: state => seen.push(state) },
		});
		document.offer("panel");
		document.acknowledge(document.routeGeneration, "panel");
		document.panelBound();
		document.panelBound();
		assert.deepEqual(seen, ["DISCONNECTED", "PANEL_BOUND"], "one change per real transition, and none for a repeat");
		// A bridge standing by beside a bound panel changes nothing: the panel route
		// is still the one this document uses.
		document.bridgeAuthenticated();
		document.nativeReady(true);
		document.nativeReady(false);
		document.retire();
		document.retire();
		assert.deepEqual(seen, ["DISCONNECTED", "PANEL_BOUND", "RETIRED"]);
	});

	it("reports an unacknowledged offer as disconnected until its deadline passes", t => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const document = route({ ackTimeoutMs: 5 });
		document.panelBound();
		const offered = document.offer("panel");
		assert.equal(document.state, "DISCONNECTED", "an offer nobody acknowledged is not a route");
		t.mock.timers.tick(4);
		assert.equal(document.acknowledge(offered, "panel"), true, "an acknowledgement inside the deadline still counts");
		assert.equal(document.state, "PANEL_BOUND");
	});
});

describe("mutation admission", () => {
	it("reserves one strictly increasing sequence and mints one native request id", async () => {
		const document = boundRoute();
		const first = document.admit({ routeGeneration: document.routeGeneration, actionSeq: "1", operation: "set-thinking", payload: { level: "high" } });
		assert.match(first.nativeRequestId, /^[0-9a-f]{32}$/);
		assert.equal(first.actionSeq, "1");
		assert.equal(document.mutationInFlight, true);
		assert.equal(await refusal(async () => document.admit({ routeGeneration: document.routeGeneration, actionSeq: "2", operation: "set-thinking", payload: null })), "in-flight");
		first.verify();
		first.settle("unknown");
		assert.equal(document.mutationInFlight, false);
		const second = document.admit({ routeGeneration: document.routeGeneration, actionSeq: "2", operation: "set-thinking", payload: { level: "low" } });
		assert.notEqual(second.nativeRequestId, first.nativeRequestId);
		second.settle("applied");
	});

	it("refuses a replayed sequence even after the result cache is evicted", async () => {
		const document = boundRoute();
		for (let sequence = 1; sequence <= 20; sequence++) {
			const reservation = document.admit({
				routeGeneration: document.routeGeneration,
				actionSeq: String(sequence),
				operation: "set-model",
				payload: { sequence },
			});
			reservation.settle("applied");
		}
		assert.equal(document.outcomeFor("1"), null, "the first outcome has been evicted from the bounded cache");
		assert.equal(await refusal(async () => document.admit({ routeGeneration: document.routeGeneration, actionSeq: "5", operation: "set-model", payload: { sequence: 5 } })), "stale-sequence");
		assert.equal(await refusal(async () => document.admit({ routeGeneration: document.routeGeneration, actionSeq: "1", operation: "set-model", payload: { sequence: 999 } })), "stale-sequence", "a changed payload cannot re-reserve a spent sequence");
		assert.equal(await refusal(async () => document.admit({ routeGeneration: document.routeGeneration, actionSeq: "01", operation: "set-model", payload: null })), "stale-sequence");
		assert.equal(await refusal(async () => document.admit({ routeGeneration: document.routeGeneration, actionSeq: "0", operation: "set-model", payload: null })), "stale-sequence");
		assert.equal(await refusal(async () => document.admit({ routeGeneration: document.routeGeneration, actionSeq: "1e3", operation: "set-model", payload: null })), "stale-sequence");
	});

	it("refuses a reservation that names a fenced route generation", async () => {
		const document = boundRoute();
		const generation = document.routeGeneration;
		document.offer("panel");
		assert.equal(await refusal(async () => document.admit({ routeGeneration: generation, actionSeq: "1", operation: "set-model", payload: null })), "no-route");
		assert.equal(await refusal(async () => document.admit({ routeGeneration: document.routeGeneration, actionSeq: "1", operation: "set-model", payload: null })), "route-unacknowledged");
		document.acknowledge(document.routeGeneration, "panel");
		const reservation = document.admit({ routeGeneration: document.routeGeneration, actionSeq: "1", operation: "set-model", payload: null });
		// A route change while the request waits in the native queue must cancel it
		// before its first byte is written.
		document.offer("panel");
		assert.equal(await refusal(async () => reservation.verify()), "no-route");
		reservation.settle("unknown");
		assert.equal(document.outcomeFor("1"), "unknown");
	});

	it("cancels a queued reservation when the document is retired or loses its route", async () => {
		const first = boundRoute();
		const cancelled = first.admit({ routeGeneration: first.routeGeneration, actionSeq: "3", operation: "set-model", payload: { a: 1 } });
		first.retire();
		assert.equal(await refusal(async () => cancelled.verify()), "retired");

		// A surviving page whose native checks stop passing while its request waits
		// in the queue: the queued send must cancel before its first write.
		const orphan = route();
		orphan.bridgeAuthenticated();
		orphan.nativeReady(true);
		orphan.offer("bridge");
		orphan.acknowledge(orphan.routeGeneration, "bridge");
		const waiting = orphan.admit({ routeGeneration: orphan.routeGeneration, actionSeq: "4", operation: "set-model", payload: { a: 1 } });
		orphan.nativeReady(false);
		assert.equal(orphan.dispatchable, false);
		assert.equal(await refusal(async () => waiting.verify()), "no-route");
		waiting.settle("refused");
		assert.equal(orphan.outcomeFor("4"), "refused");
	});

	it("identifies a payload by its operation and its ASCII encoding", async () => {
		const document = boundRoute();
		const reservation = document.admit({
			routeGeneration: document.routeGeneration,
			actionSeq: "1",
			operation: "set-model",
			payload: { model: "café ☕" },
		});
		assert.equal(reservation.payloadIdentity.includes("café"), false, "the identity is printable ASCII only");
		assert.match(reservation.payloadIdentity, /^9:set-model:/);
		reservation.settle("applied");
	});

	it("reports a status word the guest can render for each state", () => {
		const document = route();
		assert.equal(document.status(), "disconnected", "a document with no route is disconnected");
		document.bridgeAuthenticated();
		document.offer("bridge");
		assert.equal(document.status(), "waiting", "an offered route nobody acknowledged is not ready");
		document.acknowledge(document.routeGeneration, "bridge");
		assert.equal(document.status(), "waiting", "authenticated standby is waiting for the native checks");
		document.nativeReady(true);
		assert.equal(document.status(), "ready");
		document.retire();
		assert.equal(document.status(), "disconnected");
	});
});
