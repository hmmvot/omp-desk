import * as vscode from "vscode";
import type { HostToolProvider } from "../tools/host-tool.ts";
import { assembleAgentDebugger } from "./assemble.ts";
import type { BreakpointOwnershipStore } from "./debug-api.ts";
import type { DebugPolicy, ExpressionMode, StartMode } from "./policy.ts";
import { UNITY_EXTENSION_ID, unityAttachPreset } from "./unity-preset.ts";
import { VscodeDebugApi } from "./vscode-debug-api.ts";

const SECTION = "omp.agentDebugger";
const OWNERS_KEY = "omp.agentDebugger.breakpointOwners";

/** Settings are `application` scoped: only the user's settings apply, a repository's cannot change them. */
export function vscodePolicy(): DebugPolicy {
	const read = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
		const value = vscode.workspace.getConfiguration(SECTION).get<string>(key);
		return (allowed as readonly string[]).includes(value ?? "") ? value as T : fallback;
	};
	return {
		enabled: () => vscode.workspace.getConfiguration(SECTION).get<boolean>("enabled", true) === true,
		startMode: () => read<StartMode>("start", ["ask", "allow"], "ask"),
		expressionsMode: () => read<ExpressionMode>("expressions", ["off", "ask", "allow"], "ask"),
		async confirm(request) {
			const allow = "Allow";
			const always = "Always Allow";
			const choice = await vscode.window.showWarningMessage(
				request.title,
				{ modal: true, detail: [...request.lines, "", `Always Allow sets omp.agentDebugger.${request.setting} to "allow" in your user settings; later requests of this kind are not asked.`].join("\n") },
				allow,
				always,
			);
			if (choice === always) {
				// User settings only: the setting has application scope, and a workspace value would not apply anyway.
				// This request is allowed either way; a failed write only means the next one asks again.
				await vscode.workspace.getConfiguration(SECTION).update(request.setting, "allow", vscode.ConfigurationTarget.Global).then(undefined, (error: unknown) => {
					void vscode.window.showErrorMessage(`OMP Desk could not save omp.agentDebugger.${request.setting}: ${error instanceof Error ? error.message : String(error)}`);
				});
				return true;
			}
			return choice === allow;
		},
	};
}

/**
 * Registers the debug coordinator for this window (trackers for every debug type) and returns the provider of the
 * `vscode_debug_*` tools. It offers them only while `omp.agentDebugger.enabled` is on and fires `changed` when
 * that, or the availability of a preset's extension, changes.
 */
export function activateAgentDebugger(context: vscode.ExtensionContext, options: { log?: (line: string) => void } = {}): HostToolProvider {
	const api = new VscodeDebugApi();
	// Workspace scope, like VS Code's own breakpoint storage, which restores breakpoint ids after Reload Window.
	const ownershipStore: BreakpointOwnershipStore = {
		load: () => context.workspaceState.get(OWNERS_KEY),
		save: owners => { void context.workspaceState.update(OWNERS_KEY, owners).then(undefined, (error: unknown) => options.log?.(`debug breakpoints: could not save owner records: ${String(error)}`)); },
	};
	const presets = [unityAttachPreset({ isInstalled: () => vscode.extensions.getExtension(UNITY_EXTENSION_ID) !== undefined, isFile: path => api.isFile(path) })];
	const parts = assembleAgentDebugger(api, vscodePolicy(), () => presets, { ...options, ownershipStore });
	context.subscriptions.push(
		{ dispose: () => parts.dispose() },
		vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(`${SECTION}.enabled`)) parts.fireChanged();
		}),
		vscode.extensions.onDidChange(() => parts.fireChanged()),
	);
	return parts.provider;
}
