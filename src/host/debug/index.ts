import * as vscode from "vscode";
import type { HostToolProvider } from "../tools/host-tool.ts";
import { assembleAgentDebugger } from "./assemble.ts";
import type { DebugPolicy, ExpressionMode, StartMode } from "./policy.ts";
import { UNITY_EXTENSION_ID, unityAttachPreset } from "./unity-preset.ts";
import { VscodeDebugApi } from "./vscode-debug-api.ts";

const SECTION = "omp.agentDebugger";

/** Settings are `application` scoped: only the user's settings apply, a repository's cannot change them. */
export function vscodePolicy(): DebugPolicy {
	const read = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
		const value = vscode.workspace.getConfiguration(SECTION).get<string>(key);
		return (allowed as readonly string[]).includes(value ?? "") ? value as T : fallback;
	};
	return {
		enabled: () => vscode.workspace.getConfiguration(SECTION).get<boolean>("enabled", false) === true,
		startMode: () => read<StartMode>("start", ["ask", "allow"], "ask"),
		expressionsMode: () => read<ExpressionMode>("expressions", ["off", "ask", "allow"], "ask"),
		async confirm(request) {
			const allow = "Allow";
			const choice = await vscode.window.showWarningMessage(request.title, { modal: true, detail: request.lines.join("\n") }, allow);
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
	const presets = [unityAttachPreset({ isInstalled: () => vscode.extensions.getExtension(UNITY_EXTENSION_ID) !== undefined, isFile: path => api.isFile(path) })];
	const parts = assembleAgentDebugger(api, vscodePolicy(), () => presets, options);
	context.subscriptions.push(
		{ dispose: () => parts.dispose() },
		vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(`${SECTION}.enabled`)) parts.fireChanged();
		}),
		vscode.extensions.onDidChange(() => parts.fireChanged()),
	);
	return parts.provider;
}
