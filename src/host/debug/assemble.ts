import type { HostToolDefinition, HostToolProvider } from "../tools/host-tool.ts";
import { DebugCoordinator } from "./coordinator.ts";
import type { BreakpointOwnershipStore, DebugApi } from "./debug-api.ts";
import type { DebugPolicy, DebugPreset } from "./policy.ts";
import { createDebugTools } from "./tools.ts";

export interface AgentDebuggerParts {
	readonly provider: HostToolProvider;
	readonly coordinator: DebugCoordinator;
	/** Tells every `provider.changed` listener that the tool set may differ now. */
	fireChanged(): void;
	dispose(): void;
}

export interface AssembleOptions {
	log?: (line: string) => void;
	/** How long adding a breakpoint waits for adapters to verify it. */
	breakpointSettleMs?: number;
	/** Progress cadence of `vscode_debug_wait`. */
	waitTickMs?: number;
	/** Keeps breakpoint ownership across extension-host restarts; without it ownership lives in memory only. */
	ownershipStore?: BreakpointOwnershipStore;
}

/** The wiring behind `activateAgentDebugger`, over any `DebugApi` and policy, so it runs under `node --test`. */
export function assembleAgentDebugger(api: DebugApi, policy: DebugPolicy, presets: () => readonly DebugPreset[], options: AssembleOptions = {}): AgentDebuggerParts {
	const coordinator = new DebugCoordinator(api, { log: options.log, ownershipStore: options.ownershipStore });
	const tools = createDebugTools({ api, coordinator, policy, presets, breakpointSettleMs: options.breakpointSettleMs ?? 1000, waitTickMs: options.waitTickMs ?? 30_000 });
	const listeners = new Set<() => void>();
	const provider: HostToolProvider = {
		tools: (): readonly HostToolDefinition[] => (policy.enabled() ? tools : []),
		changed: listener => {
			listeners.add(listener);
			return { dispose: () => { listeners.delete(listener); } };
		},
	};
	return {
		provider,
		coordinator,
		fireChanged: () => {
			for (const listener of [...listeners]) listener();
		},
		dispose: () => {
			coordinator.dispose();
			listeners.clear();
		},
	};
}
