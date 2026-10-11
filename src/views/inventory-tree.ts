import * as vscode from "vscode";
import { emptyView } from "../host/inventory/inventory-model.ts";
import type { ViewGroup, ViewItem, ViewModel } from "../host/inventory/inventory-model.ts";

/** The command a row's click runs: open its source file. Registered by the inventory registration. */
export const OPEN_SOURCE_COMMAND = "omp.inventory.open";

export class InventoryTreeItem extends vscode.TreeItem {
	readonly viewItem: ViewItem | undefined;
	readonly group: ViewGroup | undefined;
	constructor(label: string, collapsible: vscode.TreeItemCollapsibleState, content?: { viewItem?: ViewItem; group?: ViewGroup }) {
		super(label, collapsible);
		this.viewItem = content?.viewItem;
		this.group = content?.group;
	}
}

/** One provider for all four views: groups of rows, checkboxes only where a global switch exists. */
export class InventoryTreeProvider implements vscode.TreeDataProvider<InventoryTreeItem>, vscode.Disposable {
	readonly #changed = new vscode.EventEmitter<InventoryTreeItem | undefined>();
	readonly onDidChangeTreeData = this.#changed.event;
	#model: ViewModel = emptyView("Reading OMP's inventory…");
	get model(): ViewModel { return this.#model; }
	setModel(model: ViewModel): void { this.#model = model; this.#changed.fire(undefined); }
	getTreeItem(item: InventoryTreeItem): vscode.TreeItem { return item; }
	getChildren(parent?: InventoryTreeItem): InventoryTreeItem[] {
		const model = this.#model;
		if (parent === undefined) {
			if (model.message !== null) return [new InventoryTreeItem(model.message, vscode.TreeItemCollapsibleState.None)];
			return model.groups.map(group => this.#group(group));
		}
		const group = parent.group;
		return group === undefined ? [] : group.items.map(item => this.#item(item));
	}
	#group(group: ViewGroup): InventoryTreeItem {
		const item = new InventoryTreeItem(group.label, group.collapsed === true ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded, { group });
		item.id = `group:${group.id}`;
		item.iconPath = new vscode.ThemeIcon(group.collapsed === true ? "info" : "folder");
		return item;
	}
	#item(row: ViewItem): InventoryTreeItem {
		const item = new InventoryTreeItem(row.label, vscode.TreeItemCollapsibleState.None, { viewItem: row });
		item.id = row.key;
		item.description = row.description;
		item.tooltip = row.tooltip;
		item.iconPath = new vscode.ThemeIcon(row.icon);
		item.contextValue = row.checked === null ? "inventory.readonly" : "inventory.switchable";
		if (row.checked !== null) item.checkboxState = row.checked ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
		if (row.openPath !== null) item.command = { command: OPEN_SOURCE_COMMAND, title: "Open Source", arguments: [row.openPath] };
		return item;
	}
	dispose(): void { this.#changed.dispose(); }
}
