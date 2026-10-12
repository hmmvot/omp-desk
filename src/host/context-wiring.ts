import * as vscode from "vscode";
import { ContextController } from "./context/context-controller.ts";
import { ContextTreeProvider, READ_BREAKDOWN_COMMAND } from "../views/context-tree.ts";
import type { ContextTarget } from "./context/context-controller.ts";

/** The view id, as `package.json` contributes it. */
export const CONTEXT_VIEW_ID = "omp.context";

/** What the extension supplies: the editor the view describes (the inventory views' rule), a log, and the Chat's own Compact/Shake flow. */
export interface ContextViewDeps {
	target(): ContextTarget | null;
	log(message: string): void;
	/** Run the Chat footer's Compact or Shake for `tabId` (its pickers, prompts and refusal texts). */
	runAction(tabId: string, command: "compact" | "shake"): void;
}
/** The calls `extension.ts` makes when the active editor or its session changes. */
export interface ContextHandle extends vscode.Disposable {
	/** The target, its generation or its running state may have changed. */
	sync(): void;
	/** Read again now (tab activation, catalogue update). */
	refresh(): void;
}

/** Registers the Context view (ADR-0063): one tree, four commands, one context key. */
export function registerContextView(context: vscode.ExtensionContext, deps: ContextViewDeps): ContextHandle {
	const provider = new ContextTreeProvider();
	const tree = vscode.window.createTreeView(CONTEXT_VIEW_ID, { treeDataProvider: provider });
	let shown: ContextTarget | null = null;
	let canMaintain: boolean | null = null;
	const controller = new ContextController({
		target: deps.target,
		publish(model, target) {
			shown = target;
			provider.setModel(model);
			tree.description = model.description ?? undefined;
			tree.message = model.message ?? undefined;
			if (canMaintain !== model.canMaintain) {
				canMaintain = model.canMaintain;
				void vscode.commands.executeCommand("setContext", "omp.context.canMaintain", canMaintain);
			}
		},
		notify: message => { void vscode.window.showWarningMessage(message); },
		schedule: (handler, ms) => setTimeout(handler, ms),
		cancel: handle => clearTimeout(handle as NodeJS.Timeout),
		now: () => Date.now(),
		log: message => deps.log(message),
	});
	// The action acts on the session the tree shows, not on the focused editor: a click in the side bar must not redirect it.
	const maintain = (command: "compact" | "shake") => { if (shown !== null && shown.mode === "chat" && shown.running) deps.runAction(shown.tabId, command); };
	const subscriptions: vscode.Disposable[] = [
		provider, tree, controller,
		tree.onDidChangeVisibility(event => controller.setVisible(event.visible)),
		vscode.commands.registerCommand("omp.refreshContext", () => controller.refresh()),
		vscode.commands.registerCommand("omp.context.compact", () => maintain("compact")),
		vscode.commands.registerCommand("omp.context.shake", () => maintain("shake")),
		vscode.commands.registerCommand(READ_BREAKDOWN_COMMAND, () => controller.readBreakdown()),
		vscode.window.tabGroups.onDidChangeTabs(() => controller.sync()),
	];
	void vscode.commands.executeCommand("setContext", "omp.context.canMaintain", false);
	controller.setVisible(tree.visible);
	context.subscriptions.push(...subscriptions);
	return { sync: () => controller.sync(), refresh: () => controller.refresh(), dispose: () => { for (const item of subscriptions) item.dispose(); } };
}
