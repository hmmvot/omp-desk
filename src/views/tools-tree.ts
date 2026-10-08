import * as vscode from "vscode";
import { emptyTools, type SessionToolsSnapshot } from "../host/session-tools.ts";

export class ToolsTreeItem extends vscode.TreeItem {
	readonly group: "skills" | "tools" | undefined;
	constructor(label: string, group?: "skills" | "tools") {
		super(label, group === undefined ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Expanded);
		this.group = group;
	}
}
export class ToolsTreeProvider implements vscode.TreeDataProvider<ToolsTreeItem>, vscode.Disposable {
	readonly #changed = new vscode.EventEmitter<ToolsTreeItem | undefined>();
	readonly onDidChangeTreeData = this.#changed.event;
	#snapshot = emptyTools("Focus an OMP session to see its skills and tools.");
	setSnapshot(snapshot: SessionToolsSnapshot): void { this.#snapshot = snapshot; this.#changed.fire(undefined); }
	getTreeItem(item: ToolsTreeItem): vscode.TreeItem { return item; }
	getChildren(parent?: ToolsTreeItem): ToolsTreeItem[] {
		const snapshot = this.#snapshot;
		if (parent === undefined) {
			if (snapshot.message !== null) return [new ToolsTreeItem(snapshot.message)];
			return [new ToolsTreeItem("Skills", "skills"), new ToolsTreeItem("Tools", "tools")];
		}
		if (parent.group === "skills") {
			if (snapshot.skillsMessage !== null) return [new ToolsTreeItem(snapshot.skillsMessage)];
			return snapshot.skills.map(skill => {
				const item = new ToolsTreeItem(skill.name);
				item.id = `skill:${skill.name}`;
				item.tooltip = skill.description;
				item.iconPath = new vscode.ThemeIcon("book");
				return item;
			});
		}
		if (parent.group === "tools") {
			if (snapshot.toolsMessage !== null) return [new ToolsTreeItem(snapshot.toolsMessage)];
			return snapshot.tools.map(tool => {
				const item = new ToolsTreeItem(tool.name);
				item.id = `tool:${tool.name}`;
				item.tooltip = tool.description;
				item.iconPath = new vscode.ThemeIcon(tool.active === false ? "circle-slash" : "tools");
				if (tool.active === false) item.description = "Inactive";
				if (tool.active === null) item.description = "Activation unknown";
				return item;
			});
		}
		return [];
	}
	dispose(): void { this.#changed.dispose(); }
}
