import type { ToolsMode } from "../../chat/tools-mode.ts";

/**
 * The transcript's two global display defaults: the thinking toggle (Desk's `Ctrl+Alt+T`, the TUI's `Ctrl+T`: show every thinking block) and the tool display
 * mode (`Ctrl+O` expands every tool call, `Ctrl+Shift+O` opens every group with its calls collapsed). The host owns
 * them — one remembered value per VS Code profile, changed by the `ompDesk.toggleThinking`,
 * `ompDesk.toggleToolOutput` and `ompDesk.toggleToolGroups` commands — and pushes them with the display preferences.
 *
 * Each is a default, not a lock: a change opens or closes every block of that kind once, and a block the user
 * opens or closes afterwards keeps its own state until the next change.
 */

export interface TranscriptToggles {
	/** Thinking blocks are open by default. */
	readonly thinking: boolean;
	/** `groups`: tool groups open, their calls collapsed. `all`: groups open and calls expanded. */
	readonly tools: ToolsMode;
	/** Bumped by every change, so mounted blocks re-apply the default once. */
	readonly generation: number;
}

let state: TranscriptToggles = { thinking: false, tools: "collapsed", generation: 0 };
const listeners = new Set<() => void>();

export function subscribeTranscriptToggles(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function getTranscriptToggles(): TranscriptToggles {
	return state;
}

/** Adopt the host's defaults; a change re-applies them to every mounted block of that kind. */
export function adoptTranscriptToggles(thinking: boolean, tools: ToolsMode): void {
	if (state.thinking === thinking && state.tools === tools) return;
	state = { thinking, tools, generation: state.generation + 1 };
	for (const listener of [...listeners]) listener();
}

/** Whether a disclosure key names a tool call (`call:`) or a tool run (`run:`), which follow the tools default. */
export function isToolDisclosureKey(key: string): boolean {
	return key.startsWith("call:") || key.startsWith("run:");
}

/**
 * The transcript's per-block disclosure map seen through the tool display mode: a tool block nobody opened or
 * closed since the last change reads as the mode says. `all` opens runs (groups) and calls; `groups` opens only
 * runs, so their calls stay one collapsed line each; every other key reads as stored. Only `get` is redirected.
 */
export function withToolDefault(map: ReadonlyMap<string, boolean>, tools: ToolsMode): ReadonlyMap<string, boolean> {
	if (tools === "collapsed") return map;
	const defaultFor = (key: string): boolean | undefined => key.startsWith("run:") || (tools === "all" && key.startsWith("call:")) ? true : undefined;
	return new Proxy(map, {
		get(target, property) {
			if (property === "get") return (key: string) => target.get(key) ?? defaultFor(key);
			const value = Reflect.get(target, property, target) as unknown;
			return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
		},
	});
}

/** Forget every tool block's own state, so the new default applies to all of them. */
export function clearToolDisclosures(map: Map<string, boolean>): void {
	for (const key of [...map.keys()]) if (isToolDisclosureKey(key)) map.delete(key);
}
