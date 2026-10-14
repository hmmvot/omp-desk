/**
 * Opening an artifact (`artifact://N`, the full output of a truncated tool result) from the page: the conversation epoch the
 * page was rendered for, the message to the host, and why the page cannot ask. The host resolves the id against the session
 * file of the conversation this editor shows and drops a request of any other epoch, so the page names no path.
 */
import { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from "react";
import type { ChatEpoch } from "../../chat/model";
import { guestTransport } from "../bridge";

/**
 * The epoch of the conversation whose transcript the components below show; `null` where there is none (a static render).
 * Provided by the session and detail views. A sub-agent's transcript is the conversation's own: its artifacts sit in the same
 * directory, so its cards ask under the same epoch.
 */
export const ArtifactEpochContext = createContext<ChatEpoch | null>(null);

export const ARTIFACT_ID = /^\d{1,9}$/;
export const ARTIFACT_BRIDGE_REASON = "Reload the window to open the full output";
export const ARTIFACT_SCOPE_REASON = "There is no conversation to open the full output of";

export interface ArtifactOpener {
	/** Ask the host to open artifact `id`; `undefined` where the page cannot ask (see `reason`). */
	readonly open: ((id: string) => void) | undefined;
	/** Why `open` is absent, for a disabled control. */
	readonly reason: string | null;
}

/** Only a page on the host's own panel route can ask: a surviving bridge page keeps its fixed allow-list, which does not carry `omp:open-artifact`. */
export function useArtifactOpener(): ArtifactOpener {
	const epoch = useContext(ArtifactEpochContext);
	const route = useSyncExternalStore(guestTransport.onRouteChange, guestTransport.routeKind, () => "none" as const);
	const post = useCallback((id: string): void => {
		if (epoch !== null && ARTIFACT_ID.test(id)) guestTransport.post({ type: "omp:open-artifact", artifactId: id, epoch });
	}, [epoch]);
	return useMemo((): ArtifactOpener => route === "bridge" ? { open: undefined, reason: ARTIFACT_BRIDGE_REASON }
		: epoch === null ? { open: undefined, reason: ARTIFACT_SCOPE_REASON }
		: { open: post, reason: null }, [route, epoch, post]);
}
