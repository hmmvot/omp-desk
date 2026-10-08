/**
 * What a detail tab shows, as the host stamps it into the document and the page reads it back.
 *
 * The target is immutable for one document: `<meta name="omp-detail">` carries `todo`, `agents`
 * or `agent:<encodeURIComponent(id)>`. The id is percent-encoded so no registry id can close the
 * attribute, and decoding is bounded by the same limit the request parser applies.
 */
import { MAX_DETAIL_AGENT_ID_LENGTH, isSafeBoundaryText, type DetailKind } from "./messages.ts";

export const DETAIL_META = "omp-detail";

export type DetailTarget =
	| { readonly kind: "todo" }
	| { readonly kind: "agents" }
	| { readonly kind: "agent"; readonly agentId: string };

export function detailMetaValue(target: DetailTarget): string {
	return target.kind === "agent" ? `agent:${encodeURIComponent(target.agentId)}` : target.kind;
}

/** The target a meta value names, or `null` for anything this contract does not mint. */
export function parseDetailMeta(value: string | null): DetailTarget | null {
	if (value === "todo") return { kind: "todo" };
	if (value === "agents") return { kind: "agents" };
	if (value === null || !value.startsWith("agent:")) return null;
	let agentId: string;
	try {
		agentId = decodeURIComponent(value.slice("agent:".length));
	} catch {
		return null;
	}
	return agentId.length > 0 && agentId.length <= MAX_DETAIL_AGENT_ID_LENGTH && isSafeBoundaryText(agentId) ? { kind: "agent", agentId } : null;
}

/** One detail tab per conversation, kind and agent: the host's registry key (a tuple, so no id can collide). */
export function detailKey(conversation: string, kind: DetailKind, agentId: string | undefined): string {
	return JSON.stringify([conversation, kind, agentId ?? null]);
}
