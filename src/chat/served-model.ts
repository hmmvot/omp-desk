/**
 * The served-model marker: a reply whose provider answered with a different model than the one requested, worded as the OMP
 * terminal UI words it (`served X · requested Y · via provider/upstream`, pi-tui `chat/served-model-marker.ts`).
 *
 * Whether two ids name the same model is OMP's own `classifyModel` decision, which Desk cannot run in the page (it does not
 * depend on OMP at compile time). The host runs it against the installed OMP (`host/served-model.ts`) and the page only asks
 * about the pairs that differ textually; this module holds the part that needs no OMP: which messages are candidates, and which
 * confirmed substitution is announced where.
 */
import type { AssistantMessage } from "./messages.ts";

export type ServedModelVerdict = "mismatch" | "same" | "unknown";

/** A request id, the id the provider reported serving, and the configured provider: what the host classifies. */
export interface ServedModelPair { provider: string; requested: string; served: string }

/** A message whose served model differs textually from the requested one, found in the transcript. */
export interface ServedModelCandidate {
	readonly entryId: string;
	readonly pair: ServedModelPair;
	/** The upstream host a router reported (OpenRouter's `provider`), when there was one. */
	readonly upstreamProvider?: string;
}

/** A confirmed substitution, ready to show. */
export interface ServedModelMismatch extends ServedModelPair { readonly upstreamProvider?: string }

const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/** The pair of a message that names a served model other than the requested one; `null` when it names none or the provider is unknown. */
export function servedModelPair(message: AssistantMessage): ServedModelPair | null {
	const served = message.upstreamModel;
	if (!text(served) || served === message.model || !text(message.provider) || !text(message.model)) return null;
	return { provider: message.provider, requested: message.model, served };
}

export function servedModelKey(pair: ServedModelPair): string {
	return `${pair.provider}\0${pair.requested}\0${pair.served}`;
}

/**
 * The substitutions to announce: like the TUI's tracker, each distinct (provider, requested, served) once, at the first message
 * of the transcript order whose verdict is a mismatch. A verdict that is not known yet, a `same` and an `unknown` show nothing.
 */
export function announcedMismatches(candidates: readonly ServedModelCandidate[], verdictOf: (pair: ServedModelPair) => ServedModelVerdict | undefined): ReadonlyMap<string, ServedModelMismatch> {
	const announced = new Set<string>();
	const result = new Map<string, ServedModelMismatch>();
	for (const candidate of candidates) {
		const key = servedModelKey(candidate.pair);
		if (announced.has(key) || verdictOf(candidate.pair) !== "mismatch") continue;
		announced.add(key);
		result.set(candidate.entryId, { ...candidate.pair, ...(candidate.upstreamProvider === undefined ? {} : { upstreamProvider: candidate.upstreamProvider }) });
	}
	return result;
}

/** The marker's words: `served X · requested Y · via provider/upstream`. */
export function servedModelLabel(mismatch: ServedModelMismatch): string {
	const via = mismatch.upstreamProvider === undefined ? mismatch.provider : `${mismatch.provider}/${mismatch.upstreamProvider}`;
	return `served ${mismatch.served} · requested ${mismatch.requested} · via ${via}`;
}
