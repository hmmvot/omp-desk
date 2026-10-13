/**
 * The empty chat's recent sessions, as the page sees them.
 *
 * The page asks the host once when the empty state opens on a route that can answer, again when the
 * conversation's folder changes, and, while the answer holds fewer rows than the list can show, at two
 * fixed delays after the first request: the Sessions tree the host reads reads titles and activity
 * asynchronously, so a chat opened on a cold tree is first answered with fewer rows than exist. A late or
 * foreign answer is dropped by its request id. A bridge route sends nothing (the exchange is panel-only);
 * no answer, an empty one or a refusal leaves the hints alone, never an error.
 *
 * A row is opened by the id of the answer it came from and its ordinal: the page names no session.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { RECENT_SESSIONS_LIMIT, type GuestRecentSession } from "../../protocol/messages";
import { guestTransport } from "../bridge";

/** When a short answer is asked for again, measured from the first request. */
export const RECENT_RETRY_DELAYS_MS: readonly number[] = [1_500, 4_000];

/** Ids are the page's own, never reused, so an answer to an earlier mount cannot pass for a later one. */
let lastRequestId = 0;

export interface RecentSessionsView {
	readonly items: readonly GuestRecentSession[];
	/** Open the row at this ordinal of the answer shown. */
	open(index: number): void;
}

export function useRecentSessions(cwd: string | undefined): RecentSessionsView {
	const route = useSyncExternalStore(guestTransport.onRouteChange, guestTransport.routeKind);
	const [answer, setAnswer] = useState<{ requestId: number; items: readonly GuestRecentSession[] } | null>(null);
	const shown = useRef(answer);
	shown.current = answer;
	const asking = route !== "bridge" && cwd !== undefined;
	useEffect(() => {
		setAnswer(null);
		if (!asking) return;
		let pending: number | null = null;
		let count = -1;
		const ask = (): void => {
			pending = ++lastRequestId;
			guestTransport.post({ type: "omp:recent-sessions-request", requestId: pending });
		};
		const unsubscribe = guestTransport.subscribe(message => {
			if (message.type !== "omp:recent-sessions" || message.requestId !== pending) return;
			pending = null;
			count = message.items.length;
			setAnswer({ requestId: message.requestId, items: message.items });
		});
		ask();
		const timers = RECENT_RETRY_DELAYS_MS.map(delay => setTimeout(() => { if (count < RECENT_SESSIONS_LIMIT) ask(); }, delay));
		return () => {
			unsubscribe();
			for (const timer of timers) clearTimeout(timer);
		};
	}, [asking, cwd]);
	const open = useCallback((index: number): void => {
		const current = shown.current;
		if (current !== null && index >= 0 && index < current.items.length) guestTransport.post({ type: "omp:open-recent", requestId: current.requestId, index });
	}, []);
	return { items: answer?.items ?? [], open };
}
