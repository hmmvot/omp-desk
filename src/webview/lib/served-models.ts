/**
 * What the host knows of which served models are another model: the page asks for each pair that differs textually (see
 * `chat/served-model.ts`) once, and keeps the answer for the life of the document. The host classifies against the installed
 * OMP; until it answers, and wherever it cannot (a bridge route carries no such exchange), there is no verdict and no marker.
 */
import { useEffect, useSyncExternalStore } from "react";
import { servedModelKey, type ServedModelPair, type ServedModelVerdict } from "../../chat/served-model";
import { SERVED_MODEL_PAIR_LIMIT } from "../../protocol/messages";
import { guestTransport } from "../bridge";

const verdicts = new Map<string, ServedModelVerdict>();
/** Pairs already sent: a question is asked once, whether or not it was answered. */
const asked = new Set<string>();
/** The pairs of each request in flight, by its id: an answer is read against them and against nothing else. */
const inFlight = new Map<number, readonly ServedModelPair[]>();
const listeners = new Set<() => void>();
let nextRequestId = 0;
let version = 0;
let listening = false;

function listen(): void {
	if (listening) return;
	listening = true;
	guestTransport.subscribe(message => {
		if (message.type !== "omp:served-models") return;
		const pairs = inFlight.get(message.requestId);
		if (pairs === undefined || pairs.length !== message.verdicts.length) return;
		inFlight.delete(message.requestId);
		pairs.forEach((pair, index) => verdicts.set(servedModelKey(pair), message.verdicts[index]!));
		version += 1;
		for (const listener of listeners) listener();
	});
}

/** Ask the host about every pair not yet asked, at most {@link SERVED_MODEL_PAIR_LIMIT} to a request. */
export function askServedModels(pairs: readonly ServedModelPair[]): void {
	if (guestTransport.routeKind() === "bridge") return;
	const fresh: ServedModelPair[] = [];
	const seen = new Set<string>();
	for (const pair of pairs) {
		const key = servedModelKey(pair);
		if (asked.has(key) || seen.has(key)) continue;
		seen.add(key);
		fresh.push(pair);
	}
	if (fresh.length === 0) return;
	listen();
	for (let start = 0; start < fresh.length; start += SERVED_MODEL_PAIR_LIMIT) {
		const batch = fresh.slice(start, start + SERVED_MODEL_PAIR_LIMIT);
		const requestId = ++nextRequestId;
		inFlight.set(requestId, batch);
		if (!guestTransport.post({ type: "omp:served-models-request", requestId, pairs: batch })) { inFlight.delete(requestId); continue; }
		for (const pair of batch) asked.add(servedModelKey(pair));
	}
}

const subscribe = (listener: () => void): (() => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

/** The verdict of a pair, once the host has answered; `revision` changes whenever an answer arrives, so a memo over the verdicts can depend on it. */
export function useServedVerdicts(pairs: readonly ServedModelPair[]): { verdictOf(pair: ServedModelPair): ServedModelVerdict | undefined; revision: number } {
	const revision = useSyncExternalStore(subscribe, () => version);
	useEffect(() => askServedModels(pairs), [pairs]);
	return { verdictOf: pair => verdicts.get(servedModelKey(pair)), revision };
}
