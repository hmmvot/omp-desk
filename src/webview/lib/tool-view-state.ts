/**
 * What an open tool card remembers beyond being open: whether it shows everything (`full`), and, as later
 * parts of the card need them, its output format, filter, wrap switch and folds.
 *
 * The state is kept by call, outside the card, so a card the transcript unmounts (virtualisation) and mounts
 * again keeps it while it stays open. It is forgotten when the card closes and when the tool display mode
 * changes (`Ctrl+O`, `Ctrl+Shift+O`: a new default for every card), and the store is bounded.
 */
import { useCallback, useState, useSyncExternalStore } from "react";

/** How far one tree of rows is folded: its containers at this depth and deeper are closed (`null`: the tree's own default), except the rows in `toggled`, which are the other way round. */
export interface FoldState {
	readonly depth: number | null;
	readonly toggled: ReadonlySet<number>;
}

export interface ToolViewState {
	/** The card shows all its rows (the windowed full view) instead of the 12-row preview. */
	readonly full: boolean;
	/** A detected output (JSON, newline-delimited JSON) is shown formatted, or as the text it came as. */
	readonly format: "formatted" | "text";
	/** The folds of each tree of rows the card shows, by the tree's id. */
	readonly folds: ReadonlyMap<string, FoldState>;
	/** Only the lines that contain this (any case) are shown in the full view; empty shows them all. */
	readonly filter: string;
	/** Long lines wrap (`true`), or run on and scroll sideways (`false`); `null` is the card's default for the size of its output. */
	readonly wrap: boolean | null;
	/** How many lines the output had when the card went full: the transcript estimates the height of a card it has not measured from it. */
	readonly rows: number;
}

const INITIAL: ToolViewState = { full: false, format: "formatted", folds: new Map(), filter: "", wrap: null, rows: 0 };
/** What a card forgets when it closes. */
export const FRESH_VIEW: Partial<ToolViewState> = { full: false, format: "formatted", folds: new Map(), filter: "", wrap: null, rows: 0 };
const MAX_ENTRIES = 256;
const states = new Map<string, ToolViewState>();
const listeners = new Set<() => void>();

let version = 0;
function emit(): void {
	version++;
	for (const listener of [...listeners]) listener();
}

/** The state of card `key` now, for code that is not a card (the transcript's layout estimates). */
export function peekToolView(key: string): ToolViewState | undefined {
	return states.get(key);
}

/** Changes whenever the state of any card does. */
export function useToolViewVersion(): number {
	return useSyncExternalStore(subscribe, () => version, () => 0);
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

/** The state of the card `key` and a way to change it. Without a key the card keeps its state for as long as it is mounted. */
export function useToolViewState(key: string | undefined): readonly [ToolViewState, (patch: Partial<ToolViewState>) => void] {
	const stored = useSyncExternalStore(subscribe, () => key === undefined ? INITIAL : states.get(key) ?? INITIAL, () => INITIAL);
	const [local, setLocal] = useState(INITIAL);
	const update = useCallback((patch: Partial<ToolViewState>) => {
		if (key === undefined) { setLocal(current => ({ ...current, ...patch })); return; }
		const next = { ...(states.get(key) ?? INITIAL), ...patch };
		states.delete(key);
		states.set(key, next);
		while (states.size > MAX_ENTRIES) states.delete(states.keys().next().value!);
		emit();
	}, [key]);
	return [key === undefined ? local : stored, update];
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
