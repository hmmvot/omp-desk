/**
 * The transcript's two global display defaults, the TUI's `Ctrl+T` (show every thinking block) and `Ctrl+O`
 * (expand every tool call). The host owns them — one remembered value per VS Code profile, flipped by the
 * `omp.toggleThinking` / `omp.toggleToolOutput` commands — and pushes them with the display preferences.
 *
 * Each is a default, not a lock: a change opens or closes every block of that kind once, and a block the user
 * opens or closes afterwards keeps its own state until the next change.
 */

export interface TranscriptToggles {
	/** Thinking blocks are open by default. */
	readonly thinking: boolean;
	/** Tool calls and tool runs are expanded by default. */
	readonly tools: boolean;
	/** Bumped by every change, so mounted blocks re-apply the default once. */
	readonly generation: number;
}

let state: TranscriptToggles = { thinking: false, tools: false, generation: 0 };
const listeners = new Set<() => void>();

export function subscribeTranscriptToggles(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function getTranscriptToggles(): TranscriptToggles {
	return state;
}

/** Adopt the host's defaults; a change re-applies them to every mounted block of that kind. */
export function adoptTranscriptToggles(thinking: boolean, tools: boolean): void {
	if (state.thinking === thinking && state.tools === tools) return;
	state = { thinking, tools, generation: state.generation + 1 };
	for (const listener of [...listeners]) listener();
}

/** Whether a disclosure key names a tool call (`call:`) or a tool run (`run:`), which follow the tools default. */
export function isToolDisclosureKey(key: string): boolean {
	return key.startsWith("call:") || key.startsWith("run:");
}

/**
 * The transcript's per-block disclosure map seen through the tools default: a tool block nobody opened or
 * closed since the last change reads as expanded; every other key reads as stored. Only `get` is redirected.
 */
export function withToolDefault(map: ReadonlyMap<string, boolean>, tools: boolean): ReadonlyMap<string, boolean> {
	if (!tools) return map;
	return new Proxy(map, {
		get(target, property) {
			if (property === "get") return (key: string) => target.get(key) ?? (isToolDisclosureKey(key) ? true : undefined);
			const value = Reflect.get(target, property, target) as unknown;
			return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
		},
	});
}

/** Forget every tool block's own state, so the new default applies to all of them. */
export function clearToolDisclosures(map: Map<string, boolean>): void {
	for (const key of [...map.keys()]) if (isToolDisclosureKey(key)) map.delete(key);
}
