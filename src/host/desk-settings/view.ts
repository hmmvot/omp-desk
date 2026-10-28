import { isRecord } from "../../shared/guards.ts";
import { randomBytes } from "node:crypto";
import type { Logger } from "../../shared/logger.ts";
import * as vscode from "vscode";
import type { OmpRuntimeServices } from "../omp-runtime-services";
import { DeskSettingsController } from "./controller.ts";
import { projectConfiguration } from "../../protocol/desk-settings.ts";
import type { DeskSettingsPort } from "./controller.ts";
import type { ConfigLayers, JsonValue, Target, WorkspaceFacts } from "../../protocol/desk-settings.ts";

function bind(resolveOmpBinary: OmpRuntimeServices["resolveOmpBinary"]): DeskSettingsPort {
	const root = () => vscode.workspace.getConfiguration();
	return {
		inspect(key): ConfigLayers {
			const inspected = root().inspect<JsonValue>(key);
			return {
				...(inspected?.defaultValue === undefined ? {} : { defaultValue: inspected.defaultValue }),
				...(inspected?.globalValue === undefined ? {} : { globalValue: inspected.globalValue }),
				...(inspected?.workspaceValue === undefined ? {} : { workspaceValue: inspected.workspaceValue }),
			};
		},
		effective: key => root().get<JsonValue>(key),
		folderValues: key => (vscode.workspace.workspaceFolders ?? [])
			.filter(folder => vscode.workspace.getConfiguration(undefined, folder.uri).inspect(key)?.workspaceFolderValue !== undefined)
			.map(folder => folder.name),
		update: (key, value, target: Target) =>
			Promise.resolve(root().update(key, value, target === "user" ? vscode.ConfigurationTarget.Global : vscode.ConfigurationTarget.Workspace)),
		workspace: (): WorkspaceFacts => ({
			available: (vscode.workspace.workspaceFolders?.length ?? 0) > 0 || vscode.workspace.workspaceFile !== undefined,
			name: vscode.workspace.name ?? null,
		}),
		async openSettingsEditor(key) {
			await vscode.commands.executeCommand("workbench.action.openSettings", `@id:${key}`);
		},
		async openSettingsJson(key, target, edit) {
			await vscode.commands.executeCommand(
				target === "workspace" ? "workbench.action.openWorkspaceSettingsFile" : "workbench.action.openSettingsJson",
				{ revealSetting: { key, edit } },
			);
		},
		async testOmp(path) {
			const typed = path.trim();
			try {
				const binary = await resolveOmpBinary({ explicitPath: typed });
				const release = binary.version === null ? "release not reported" : `release ${binary.version}`;
				return { ok: true, message: `Resolves to OMP (${release}) from ${binary.origin}. Desk would run: ${[binary.command, ...binary.prefixArgs].join(" ")}` };
			} catch (error) {
				const text = error instanceof Error ? error.message : String(error);
				return { ok: false, message: text.length > 1500 ? `${text.slice(0, 1500)}…` : text };
			}
		},
	};
}

/** A message-only page: no network, no bridge; script only by this document's nonce, styles by the nonce or the Webview resource origin (the codicon stylesheet). */
function html(webview: vscode.Webview, extensionUri: vscode.Uri): string {
	const nonce = randomBytes(16).toString("base64url");
	const root = extensionUri.path.replace(/\/$/, "");
	const script = webview.asWebviewUri(extensionUri.with({ path: `${root}/media/desk-settings.js` }));
	const icons = webview.asWebviewUri(extensionUri.with({ path: `${root}/media/codicons/codicon.css` }));
	const csp = [
		"default-src 'none'",
		"base-uri 'none'",
		"form-action 'none'",
		`font-src ${webview.cspSource}`,
		`style-src 'nonce-${nonce}' ${webview.cspSource}`,
		`script-src 'nonce-${nonce}'`,
		"connect-src 'none'",
	].join("; ");
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="csp-nonce" content="${nonce}"><title>OMP Desk Settings</title><link rel="stylesheet" href="${icons}"></head>
<body><div id="root"></div><script nonce="${nonce}" src="${script}"></script></body></html>`;
}

class DeskSettingsViewProvider implements vscode.WebviewViewProvider {
	#view: vscode.WebviewView | undefined;

	constructor(readonly extensionUri: vscode.Uri, readonly controller: DeskSettingsController) {}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.#view = view;
		view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")] };
		view.webview.html = html(view.webview, this.extensionUri);
		view.webview.onDidReceiveMessage((raw: unknown) => void this.#receive(view, raw));
		// A hidden view is not read; becoming visible shows the current values at once.
		view.onDidChangeVisibility(() => this.push());
		view.onDidDispose(() => { if (this.#view === view) this.#view = undefined; });
	}

	/** Send the current state to the view when it is showing; a hidden or absent view is not read. */
	push(): void {
		const view = this.#view;
		if (view === undefined || !view.visible) return;
		void view.webview.postMessage(this.controller.state());
	}

	async #receive(view: vscode.WebviewView, raw: unknown): Promise<void> {
		try {
			const result = await this.controller.handle(raw);
			if (result === null) { this.push(); return; }
			void view.webview.postMessage(result);
			this.push();
		} catch (error) {
			this.controller.log.error(`settings view: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}

/**
 * Build the Settings view's provider and the listeners that keep it current. The list of settings is `contributes.configuration` of
 * this extension's own manifest, read at runtime, so a setting added to package.json appears with no other change. Values are read
 * live from VS Code's configuration while the view shows.
 *
 * The caller registers the provider for the view (`../../wiring/desk-settings-view.ts`, which loads this module when VS Code first
 * resolves the view): nothing here is needed before then, because a view that was never shown reads nothing.
 */
export function createDeskSettingsView(context: vscode.ExtensionContext, deps: { readonly log: Logger; readonly resolveOmpBinary: OmpRuntimeServices["resolveOmpBinary"] }): vscode.WebviewViewProvider {
	const manifest: unknown = context.extension.packageJSON;
	const contributes = isRecord(manifest) ? manifest.contributes : undefined;
	const descriptors = projectConfiguration(isRecord(contributes) ? contributes.configuration : undefined);
	const controller = new DeskSettingsController(descriptors, bind(deps.resolveOmpBinary), deps.log);
	const provider = new DeskSettingsViewProvider(context.extensionUri, controller);
	context.subscriptions.push(
		// An edit of settings.json, the Settings editor, another window's write and this view's own writes all arrive here.
		vscode.workspace.onDidChangeConfiguration(event => {
			if (descriptors.some(descriptor => event.affectsConfiguration(descriptor.key))) provider.push();
		}),
		// Whether a workspace layer exists, and which folders hold values, depend on the open folders.
		vscode.workspace.onDidChangeWorkspaceFolders(() => provider.push()),
	);
	return provider;
}
