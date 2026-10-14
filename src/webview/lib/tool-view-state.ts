/**
 * What an open tool card remembers beyond being open: whether it shows everything (`full`), and, as later
 * parts of the card need them, its output format, filter, wrap switch and folds.
 *
 * The state is kept by call, outside the card, so a card the transcript unmounts (virtualisation) and mounts
 * again keeps it while it stays open. It is forgotten when the card closes and when the tool display mode
 * changes (`Ctrl+O`, `Ctrl+Shift+O`: a new default for every card), and the store is bounded.
 */
import { useCallback, useSyncExternalStore } from "react";

export interface ToolViewState {
	/** The card shows all its rows (the windowed full view) instead of the 12-row preview. */
	readonly full: boolean;
}

const INITIAL: ToolViewState = { full: false };
const MAX_ENTRIES = 256;
const states = new Map<string, ToolViewState>();
const listeners = new Set<() => void>();

function emit(): void {
	for (const listener of [...listeners]) listener();
}
function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** Forget one card's state (it closed). */
export function resetToolView(key: string): void {
	if (states.delete(key)) emit();
}

/** Forget every card's state (a new tool display mode applies to all of them). */
export function resetAllToolViews(): void {
	if (states.size === 0) return;
	states.clear();
	emit();
}

/** The state of the card `key` and a way to change it. Without a key the state is the initial one and a change is dropped. */
export function useToolViewState(key: string | undefined): readonly [ToolViewState, (patch: Partial<ToolViewState>) => void] {
	const state = useSyncExternalStore(subscribe, () => key === undefined ? INITIAL : states.get(key) ?? INITIAL, () => INITIAL);
	const update = useCallback((patch: Partial<ToolViewState>) => {
		if (key === undefined) return;
		const next = { ...(states.get(key) ?? INITIAL), ...patch };
		states.delete(key);
		states.set(key, next);
		while (states.size > MAX_ENTRIES) states.delete(states.keys().next().value!);
		emit();
	}, [key]);
	return [state, update];
}

const MAX_OBSERVED = 500;
const observed = new Map<string, number>();

/** A page that watched call `callId` run says how long it took: exact, where a result's timestamps only give an approximation. */
export function recordObservedToolMs(callId: string, ms: number): void {
	if (!Number.isFinite(ms) || ms < 0) return;
	observed.delete(callId);
	observed.set(callId, Math.round(ms));
	while (observed.size > MAX_OBSERVED) observed.delete(observed.keys().next().value!);
	emit();
}

/** How long call `callId` took, if this page watched it run. */
export function useObservedToolMs(callId: string | undefined): number | undefined {
	return useSyncExternalStore(subscribe, () => callId === undefined ? undefined : observed.get(callId), () => undefined);
}
