import * as vscode from "vscode";
import { createKeyHintsSource, profileFolderOf } from "../host/key-hints-source.ts";
import type { KeyHintsSource } from "../host/key-hints-source.ts";
import type { Logger } from "../shared/logger.ts";
import * as path from "node:path";

/** What the extension supplies: the reaction to a changed answer and a diagnostic log. */
export interface KeyHintsDeps {
	/** The hints differ from the ones `current()` returned before: push them to the pages. */
	changed(): void;
	log: Logger;
}

export interface KeyHintsHandle extends vscode.Disposable, Pick<KeyHintsSource, "current" | "queryOf"> {}

/**
 * Keeps the effective keys of the empty state current (docs/designs/2026-10-18-chat-keys-and-empty-state.md, section 6): read in
 * the background at registration, again when the installed extensions change, and again when the active profile's
 * `keybindings.json` changes. The profile's folder is two levels above this extension's `globalStorageUri`
 * (`<profile folder>/globalStorage/<publisher.name>`); see the design for when that is not the file VS Code reads.
 */
export function registerKeyHints(context: vscode.ExtensionContext, deps: KeyHintsDeps): KeyHintsHandle {
	const source = createKeyHintsSource({
		ownId: context.extension.id,
		ownManifest: context.extension.packageJSON,
		extensions: () => vscode.extensions.all.map(extension => ({ id: extension.id, packageJSON: extension.packageJSON as unknown })),
		keybindingsPath: path.join(profileFolderOf(context.globalStorageUri.fsPath), "keybindings.json"),
		changed: deps.changed,
		log: deps.log,
	});
	const subscription = vscode.extensions.onDidChange(() => source.extensionsChanged());
	const handle: KeyHintsHandle = {
		current: () => source.current(),
		queryOf: command => source.queryOf(command),
		dispose() {
			subscription.dispose();
			source.dispose();
		},
	};
	context.subscriptions.push(handle);
	return handle;
}
