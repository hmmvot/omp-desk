import * as vscode from "vscode";
import type { ContextGroup, ContextItem, ContextViewModel, ItemTone } from "../host/context/context-model.ts";
import { OPEN_SOURCE_COMMAND } from "./inventory-tree.ts";

/** The command a Read breakdown row runs; registered by the Context view's registration. */
export const READ_BREAKDOWN_COMMAND = "ompDesk.context.readBreakdown";

/** `contextValue` of the Used row: it carries the inline Compact and Shake actions. */
export const USED_ROW_CONTEXT = "ompContext.used";
const USED_ROW_KEY = "window.used";

export class ContextTreeItem extends vscode.TreeItem {
	readonly group: ContextGroup | undefined;
	constructor(label: string, collapsible: vscode.TreeItemCollapsibleState, group?: ContextGroup) {
		super(label, collapsible);
		this.group = group;
	}
}

const TONE_COLORS: Readonly<Record<ItemTone, string | null>> = {
	normal: null,
	warning: "list.warningForeground",
	critical: "list.errorForeground",
	muted: "disabledForeground",
};

function iconOf(item: ContextItem): vscode.ThemeIcon {
	const color = TONE_COLORS[item.tone];
	return new vscode.ThemeIcon(item.icon, color === null ? undefined : new vscode.ThemeColor(color));
}

/** One provider for the Context view: groups of plain-text rows; a row with a file opens it. */
export class ContextTreeProvider implements vscode.TreeDataProvider<ContextTreeItem>, vscode.Disposable {
	readonly #changed = new vscode.EventEmitter<ContextTreeItem | undefined>();
	readonly onDidChangeTreeData = this.#changed.event;
	#model: ContextViewModel = { description: null, message: null, groups: [], canMaintain: false };
	get model(): ContextViewModel { return this.#model; }
	setModel(model: ContextViewModel): void { this.#model = model; this.#changed.fire(undefined); }
	getTreeItem(item: ContextTreeItem): vscode.TreeItem { return item; }
	getChildren(parent?: ContextTreeItem): ContextTreeItem[] {
		if (parent === undefined) return this.#model.message !== null ? [] : this.#model.groups.map(group => this.#group(group));
		return parent.group === undefined ? [] : parent.group.items.map(item => this.#item(item));
	}
	#group(group: ContextGroup): ContextTreeItem {
		const item = new ContextTreeItem(group.label, vscode.TreeItemCollapsibleState.Expanded, group);
		item.id = `group:${group.id}`;
		item.description = group.description ?? undefined;
		item.tooltip = group.tooltip ?? undefined;
		// A group row carries an icon, as the inventory views' groups do: VS Code indents a level's
		// children by whether their parent has an icon, so an icon-less group shifts its rows left.
		item.iconPath = new vscode.ThemeIcon("folder");
		return item;
	}
	#item(row: ContextItem): ContextTreeItem {
		const item = new ContextTreeItem(row.label, vscode.TreeItemCollapsibleState.None);
		item.id = row.key;
		item.description = row.description ?? undefined;
		item.tooltip = row.tooltip;
		item.iconPath = iconOf(row);
		if (row.key === USED_ROW_KEY) item.contextValue = USED_ROW_CONTEXT;
		if (row.action === "readBreakdown") item.command = { command: READ_BREAKDOWN_COMMAND, title: "Read Breakdown" };
		else if (row.openPath !== null) item.command = { command: OPEN_SOURCE_COMMAND, title: "Open File", arguments: [row.openPath] };
		return item;
	}
	dispose(): void { this.#changed.dispose(); }
}
