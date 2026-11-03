/**
 * The extension host's entry: VS Code calls `activate` once per window and `deactivate` once when the window ends.
 *
 * The window itself — its state and everything it does — is `createWindow` (`src/wiring/window.ts`). This module holds the one
 * instance `activate` created, because VS Code's two entry points are module-level functions that share nothing else.
 */
import "./host/module-clock";
import type * as vscode from "vscode";
import { createWindow, type DeskWindow } from "./wiring/window";

/** The window `activate` created in this extension host; `deactivate` ends it. Nothing else reads it. */
let current: DeskWindow | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  current = createWindow({ context });
  await current.activate();
}

export function deactivate(): void {
  current?.deactivate();
}
