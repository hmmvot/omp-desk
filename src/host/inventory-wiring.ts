import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import * as vscode from "vscode";
import { InventoryController } from "./inventory/inventory-controller.ts";
import { createInventoryRuntime } from "./inventory/inventory-runtime.ts";
import { OPEN_SOURCE_COMMAND, InventoryTreeProvider } from "../views/inventory-tree.ts";
import { runSettingsWorker } from "./omp-settings-worker";
import { resolveBunRuntime, resolveOmpBinary, resolveOmpPackageRoot } from "./native-terminal";
import { stageRuntimeAssets, verifyStagedRuntimeAsset } from "../runtime-assets";
import type { InventoryTreeItem } from "../views/inventory-tree.ts";
import type { InventoryScope, ViewKind } from "./inventory/inventory-model.ts";
import type { WorkerEnvironment } from "./inventory/inventory-runtime.ts";
import type { SessionToolsTarget } from "./session-tools.ts";

/** What the extension supplies: the editor the views describe (editor recency, not row selection) and a log. */
export interface InventoryViewsDeps {
	target(): SessionToolsTarget | null;
	log(message: string): void;
}
/** The calls `extension.ts` makes when the active editor or its session changes. */
export interface InventoryHandle extends vscode.Disposable {
	/** The target, its generation or its running state may have changed. */
	sync(): void;
	/** Re-read now (catalogue update, tab activation, command). */
	refresh(): void;
}

interface ViewSpec { readonly kind: ViewKind; readonly id: string; readonly refresh: string; readonly noun: string }
const VIEWS: readonly ViewSpec[] = [
	{ kind: "skills", id: "omp.skills", refresh: "omp.refreshSkills", noun: "skills" },
	{ kind: "tools", id: "omp.tools", refresh: "omp.refreshTools", noun: "tools" },
	{ kind: "mcp", id: "omp.mcp", refresh: "omp.refreshMcp", noun: "MCP servers" },
	{ kind: "extensions", id: "omp.extensions", refresh: "omp.refreshExtensions", noun: "extensions" },
];
const UNDO = "Undo";
const UNAVAILABLE_BUN = "OMP's inventory needs Bun and the installed OMP's importable sources; a compiled-only OMP install cannot supply it.";

export function registerInventoryViews(context: vscode.ExtensionContext, deps: InventoryViewsDeps): InventoryHandle {
	const storage = context.globalStorageUri.fsPath;
	const runtime = createInventoryRuntime({
		async environment(): Promise<WorkerEnvironment | { unavailable: string }> {
			try {
				const executable = await resolveOmpBinary();
				const [bun, root] = await Promise.all([resolveBunRuntime(), resolveOmpPackageRoot(executable)]);
				if (bun === null || root === null) return { unavailable: UNAVAILABLE_BUN };
				const [asset] = await stageRuntimeAssets({ storageDir: storage, sourcePaths: [vscode.Uri.joinPath(context.extensionUri, "out", "inventory-worker.mjs").fsPath] });
				if (asset === undefined || !(await verifyStagedRuntimeAsset(asset))) return { unavailable: "The inventory worker is missing from this extension build or its staged copy changed." };
				return { bun, packageRoot: root.root, helperPath: asset.path };
			} catch (error) {
				deps.log(`inventory: environment unavailable: ${error instanceof Error ? error.message : String(error)}`);
				return { unavailable: "The installed OMP could not be resolved." };
			}
		},
		run: input => runSettingsWorker({ bunPath: input.environment.bun, helperPath: input.environment.helperPath, packageRoot: input.environment.packageRoot,
			cwd: input.cwd, profile: input.profile, request: input.request }),
	});
	const providers = new Map<ViewKind, InventoryTreeProvider>();
	const trees = new Map<ViewKind, vscode.TreeView<InventoryTreeItem>>();
	const controller = new InventoryController({
		target: deps.target,
		runtime,
		// The drive root has no user-profile ancestors; the worker still refuses a polluted one.
		neutralCwd: path.parse(storage).root,
		publish(view, model) {
			providers.get(view)?.setModel(model);
			const tree = trees.get(view);
			if (tree !== undefined) { tree.description = model.description; tree.message = model.notice ?? undefined; }
		},
		scopeChanged(view, scope: InventoryScope) { void vscode.commands.executeCommand("setContext", `omp.${view}.scope`, scope); },
		notify(message, level, undo) {
			if (undo !== undefined) { void vscode.window.showInformationMessage(message, UNDO).then(choice => { if (choice === UNDO) undo(); }); return; }
			void (level === "warning" ? vscode.window.showWarningMessage(message) : vscode.window.showInformationMessage(message));
		},
		log: message => deps.log(message),
		delay: ms => sleep(ms),
	});
	const subscriptions: vscode.Disposable[] = [];
	for (const spec of VIEWS) {
		const provider = new InventoryTreeProvider();
		providers.set(spec.kind, provider);
		const tree = vscode.window.createTreeView(spec.id, { treeDataProvider: provider });
		trees.set(spec.kind, tree);
		subscriptions.push(
			provider, tree,
			tree.onDidChangeVisibility(event => controller.setVisible(spec.kind, event.visible)),
			tree.onDidChangeCheckboxState(event => {
				for (const [item, state] of event.items) {
					const row = item.viewItem?.row;
					if (row !== undefined && row !== null) void controller.toggle(spec.kind, row, state === vscode.TreeItemCheckboxState.Checked);
				}
			}),
			vscode.commands.registerCommand(spec.refresh, () => controller.refresh()),
			vscode.commands.registerCommand(`omp.${spec.kind}.showGlobal`, () => controller.setScope(spec.kind, "global")),
			vscode.commands.registerCommand(`omp.${spec.kind}.showSession`, () => controller.setScope(spec.kind, "session")),
		);
		void vscode.commands.executeCommand("setContext", `omp.${spec.kind}.scope`, "global");
		controller.setVisible(spec.kind, tree.visible);
	}
	subscriptions.push(
		vscode.commands.registerCommand(OPEN_SOURCE_COMMAND, async (file: unknown) => {
			if (typeof file !== "string" || !path.isAbsolute(file)) return;
			try { await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: true }); }
			catch { void vscode.window.showWarningMessage("That source file could not be opened; it may have been moved. Refresh the view."); }
		}),
		vscode.window.tabGroups.onDidChangeTabs(() => controller.sync()),
		controller,
	);
	context.subscriptions.push(...subscriptions);
	return { sync: () => controller.sync(), refresh: () => controller.refresh(), dispose: () => { for (const item of subscriptions) item.dispose(); } };
}
