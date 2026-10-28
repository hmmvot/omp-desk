/**
 * The Settings view in the OMP Desk side bar, as activation registers it: the provider VS Code asks to resolve the view, and
 * nothing else. The view's code (`../host/desk-settings/view.ts`, the controller and the settings projection, about 15 KB of the
 * extension bundle) is read from `out/rare-subsystems.js` when VS Code first resolves the view, so a window whose Settings view is never shown does not
 * evaluate it (ADR-0085).
 */
import * as vscode from "vscode";
import { lazy } from "../host/lazy-module.ts";
import { ompRuntimeServices } from "../host/omp-runtime-services.ts";
import { rareSubsystems } from "./rare-subsystems-loader.ts";
import type { Logger } from "../shared/logger.ts";

/** The side-bar view that lists this extension's settings. Declared in package.json `contributes.views`. */
export const DESK_SETTINGS_VIEW_ID = "ompDesk.deskSettings";

export function registerDeskSettingsView(context: vscode.ExtensionContext, deps: { readonly log: Logger }): vscode.Disposable {
	const provider = lazy<vscode.WebviewViewProvider>(async () => {
		const { createDeskSettingsView } = await rareSubsystems();
		return createDeskSettingsView(context, { ...deps, resolveOmpBinary: ompRuntimeServices.resolveOmpBinary });
	});
	const registration = vscode.window.registerWebviewViewProvider(DESK_SETTINGS_VIEW_ID, {
		resolveWebviewView: async (view, resolveContext, token) => {
			await (await provider()).resolveWebviewView(view, resolveContext, token);
		},
	});
	context.subscriptions.push(registration);
	return registration;
}
