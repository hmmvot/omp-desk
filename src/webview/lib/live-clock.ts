import { useEffect, useRef, useState } from "react";
import type { RunningAgent } from "../../chat/agents";
import { agentElapsedMs } from "../../chat/hud-summary";
import { SecondTicker } from "./second-tick";

/** The page's single shared tick; see {@link SecondTicker}. */
export const pageSecondTicker = new SecondTicker({
	setInterval: (callback, ms) => window.setInterval(callback, ms),
	clearInterval: handle => window.clearInterval(handle as number),
	shown: () => document.visibilityState !== "hidden",
	onShownChange: listener => { document.addEventListener("visibilitychange", listener); return () => document.removeEventListener("visibilitychange", listener); },
});

/** Re-renders the caller once a second while `active`, from the page's single shared interval. */
export function useSecondTick(active: boolean): void {
	const [, redraw] = useState(0);
	useEffect(() => active ? pageSecondTicker.subscribe(() => redraw(count => count + 1)) : undefined, [active]);
}

export interface LiveDurationEntry {
	id: string;
	/** The last authoritative duration; absent when the source reports none, which shows no clock. */
	reportedMs: number | null | undefined;
	/** Whether the duration is still growing. A settled entry shows its reported value unchanged. */
	running: boolean;
}

interface Base { reported: number; at: number; floor: number }

/**
 * Display clock for live rows (jobs, agents): the last authoritative duration plus the time elapsed since it arrived, advanced once a second
 * between progress events. It never runs backwards, and an authoritative value ahead of the local estimate always wins. `live` is false
 * where the session is not live: nothing then grows and every entry shows its reported value. `visible` is false while the clock is not on
 * screen: the estimate keeps its anchors but nothing ticks. The returned lookup is by entry id.
 */
export function useLiveDurations(entries: readonly LiveDurationEntry[], live: boolean, visible = true): (id: string) => number | undefined {
	const bases = useRef(new Map<string, Base>());
	useSecondTick(live && visible && entries.some(entry => entry.running && typeof entry.reportedMs === "number"));
	const now = Date.now();
	const durations = new Map<string, number>();
	const seen = new Set<string>();
	for (const { id, reportedMs, running } of entries) {
		seen.add(id);
		if (typeof reportedMs !== "number") { bases.current.delete(id); continue; }
		if (!live || !running) { bases.current.delete(id); durations.set(id, reportedMs); continue; }
		let base = bases.current.get(id);
		if (base === undefined || base.reported !== reportedMs) {
			base = { reported: reportedMs, at: now, floor: base === undefined ? reportedMs : Math.max(base.floor, base.reported + now - base.at) };
			bases.current.set(id, base);
		}
		durations.set(id, Math.max(base.floor, base.reported + Math.max(0, now - base.at)));
	}
	for (const id of bases.current.keys()) if (!seen.has(id)) bases.current.delete(id);
	return id => durations.get(id);
}

/**
 * The elapsed time of each roster agent: native `progress.durationMs` while it is terminal or the session is not live, and that value plus the
 * local clock while it runs, so the time moves between progress events. An agent whose progress carries no duration has none (null).
 */
export function useAgentElapsed(agents: Iterable<RunningAgent>, live: boolean, visible = true): (id: string) => number | null {
	const durationOf = useLiveDurations([...agents].map(agent => ({ id: agent.id, reportedMs: agentElapsedMs(agent), running: agent.status === "running" })), live, visible);
	return id => durationOf(id) ?? null;
}
