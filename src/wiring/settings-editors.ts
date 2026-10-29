/**
 * The Models, Agents and OMP Settings editors as the window sees them: three commands, two panel serializers (VS Code revives a
 * restored panel through the serializer of its view type) and the two calls Chat makes to open one.
 *
 * The editors themselves (`../host/omp-settings-editor.ts`, `../host/omp-config-editor.ts`: about 40 KB of the extension bundle with
 * what only they use) are read from `out/rare-subsystems.js` by the first command, call or revived panel and not at activation (ADR-0085). What activation
 * registers is this shell, which has to be there before anyone asks.
 */
import * as vscode from "vscode";
import type { Logger } from "../shared/logger.ts";
import type { SettingsKind } from "../chat/settings-command.ts";
import { lazy } from "../host/lazy-module.ts";
import { SettingsRefusal } from "../wire/omp-settings-core.ts";
import { ompRuntimeServices } from "../host/omp-runtime-services.ts";
import { rareSubsystems } from "./rare-subsystems-loader.ts";

/** What the user is told when the file of the editors cannot be read. */
const LOAD_FAILED = "OMP Desk could not load the settings editor. Reload the window";
import { OMP_CONFIG_EDITOR_VIEW_TYPE, SETTINGS_EDITOR_VIEW_TYPE } from "../host/settings-editor-ids.ts";
import type { OmpConfigBinding, OmpConfigEditorHost, OmpConfigEditors } from "../host/omp-config-editor.ts";
import type { SettingsEditorContext, SettingsEditorHost, SettingsEditors } from "../host/omp-settings-editor.ts";

export interface SettingsEditorsDeps {
	readonly log: Logger;
	readonly settings: SettingsEditorHost;
	readonly config: OmpConfigEditorHost;
}

/** What `extension.ts` calls to open an editor from Chat. */
export interface SettingsEditorsHandle {
	/** The Models or Agents editor for `binding`. */
	openSettings(kind: SettingsKind, binding: SettingsEditorContext): Promise<void>;
	/** The full OMP settings editor for `binding`. */
	openConfig(binding: OmpConfigBinding): Promise<void>;
}

export function registerSettingsEditors(context: vscode.ExtensionContext, deps: SettingsEditorsDeps): SettingsEditorsHandle {
	/** Every editor set this window created: closed with the extension, as the classes did when they were built at activation. */
	const created: vscode.Disposable[] = [];
	/** The second bundle, or a message the user sees when it cannot be read (the loader tries again at the next use). */
	const loadRare = async () => {
		try {
			return await rareSubsystems();
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			deps.log.error(`settings editors: ${reason}`);
			void vscode.window.showErrorMessage(`${LOAD_FAILED} (${reason}).`);
			throw error;
		}
	};
	/** An error the rare bundle raises as its own `SettingsRefusal` becomes the extension bundle's, which is what `instanceof` in the Chat host tests. */
	const asExtensionRefusal = async <T>(run: () => Promise<T>): Promise<T> => {
		try {
			return await run();
		} catch (error) {
			const { SettingsRefusal: RareRefusal } = await loadRare();
			throw error instanceof RareRefusal ? new SettingsRefusal(error.message) : error;
		}
	};
	const settingsEditors = lazy<SettingsEditors>(async () => {
		const { SettingsEditors: Editors } = await loadRare();
		const editors = new Editors(context, deps.settings, ompRuntimeServices);
		created.push(editors);
		return editors;
	});
	const configEditors = lazy<OmpConfigEditors>(async () => {
		const { OmpConfigEditors: Editors } = await loadRare();
		const editors = new Editors(context, deps.config, ompRuntimeServices);
		created.push(editors);
		return editors;
	});
	/** A restored panel whose editor cannot be loaded is closed (the user has been told why) rather than left blank. */
	const revive = async (panel: vscode.WebviewPanel, run: () => Promise<void>): Promise<void> => {
		try {
			await run();
		} catch {
			panel.dispose();
		}
	};
	context.subscriptions.push(
		vscode.commands.registerCommand("ompDesk.openModels", async () => (await settingsEditors()).openFromCommand("models")),
		vscode.commands.registerCommand("ompDesk.openAgents", async () => (await settingsEditors()).openFromCommand("agents")),
		vscode.commands.registerCommand("ompDesk.openOmpSettings", async () => (await configEditors()).openFromCommand()),
		vscode.window.registerWebviewPanelSerializer(SETTINGS_EDITOR_VIEW_TYPE, {
			deserializeWebviewPanel: async (panel, state: unknown) => revive(panel, async () => (await settingsEditors()).deserialize(panel, state)),
		}),
		vscode.window.registerWebviewPanelSerializer(OMP_CONFIG_EDITOR_VIEW_TYPE, {
			deserializeWebviewPanel: async (panel, state: unknown) => revive(panel, async () => (await configEditors()).deserialize(panel, state)),
		}),
		{ dispose: () => { for (const editors of created.splice(0)) editors.dispose(); } },
	);
	return {
		openSettings: (kind, binding) => asExtensionRefusal(async () => (await settingsEditors()).open(kind, binding)),
		openConfig: binding => asExtensionRefusal(async () => (await configEditors()).open(binding)),
	};
}
