/**
 * The inventory tree must claim exactly what the view model says: a checkbox only where a switch
 * exists, the checkbox state equal to the model's, click opening the source, and tooltips staying
 * plain text (a skill description is untrusted and must never become Markdown or a command link).
 * It runs against the stand-in `vscode` module, so no editor is involved.
 */
import assert from "node:assert/strict";
import module from "node:module";
import { describe, it } from "node:test";
import type { ViewItem, ViewModel } from "../wire/inventory/inventory-model.ts";

if (typeof module.registerHooks === "function") {
	const stubUrl = new URL("./vscode-test-stub.ts", import.meta.url).href;
	const EXTENSIONLESS = /^\.(?!.*\.[cm]?[jt]sx?$)/;
	module.registerHooks({
		resolve(specifier, context, nextResolve) {
			if (specifier === "vscode") return { url: stubUrl, shortCircuit: true };
			if (EXTENSIONLESS.test(specifier) && (context.parentURL ?? "").includes("/src/")) {
				for (const candidate of [`${specifier}.ts`, `${specifier}.tsx`]) {
					try { return nextResolve(candidate, context); } catch { /* try the next extension */ }
				}
			}
			return nextResolve(specifier, context);
		},
	});
}

const { TreeItemCheckboxState, TreeItemCollapsibleState } = await import("./vscode-test-stub.ts");
const { InventoryTreeProvider, OPEN_SOURCE_COMMAND } = await import("./inventory-tree.ts");

const item = (overrides: Partial<ViewItem>): ViewItem => ({ key: "k", label: "item", description: "", tooltip: "plain", icon: "book", checked: null, openPath: null, row: null, ...overrides });
const model = (items: ViewItem[], extra: Partial<ViewModel> = {}): ViewModel => ({ message: null, notice: null, groups: [{ id: "global", label: "Global (1)", items }], scope: "global", description: "Global", ...extra });

describe("inventory tree provider", () => {
	it("starts with a reading row and replaces the whole tree with a message when the model has one", () => {
		const provider = new InventoryTreeProvider();
		assert.match(String(provider.getChildren()[0]!.label), /Reading/);
		provider.setModel(model([], { message: "No MCP servers configured.", groups: [] }));
		const roots = provider.getChildren();
		assert.equal(roots.length, 1);
		assert.equal(roots[0]!.label, "No MCP servers configured.");
	});
	it("nests rows under expanded origin groups", () => {
		const provider = new InventoryTreeProvider();
		provider.setModel(model([item({ label: "a" }), item({ key: "k2", label: "b" })]));
		const [group] = provider.getChildren();
		assert.equal(group!.collapsibleState, TreeItemCollapsibleState.Expanded);
		assert.deepEqual(provider.getChildren(group).map(child => child.label), ["a", "b"]);
		assert.deepEqual(provider.getChildren(provider.getChildren(group)[0]), [], "a row has no children");
	});
	it("shows the About group folded and last, without a checkbox", () => {
		const provider = new InventoryTreeProvider();
		provider.setModel({ ...model([item({ label: "a" })]), groups: [...model([item({ label: "a" })]).groups, { id: "about", label: "About this list", collapsed: true, items: [item({ key: "f", label: "fact", tooltip: "full text", icon: "info" })] }] });
		const groups = provider.getChildren();
		assert.equal(groups.at(-1)!.collapsibleState, TreeItemCollapsibleState.Collapsed);
		assert.equal(groups[0]!.collapsibleState, TreeItemCollapsibleState.Expanded);
		const [fact] = provider.getChildren(groups.at(-1));
		assert.equal(fact!.tooltip, "full text");
		assert.equal(fact!.checkboxState, undefined);
	});
	it("gives a checkbox only to switchable rows and mirrors the model's state", () => {
		const provider = new InventoryTreeProvider();
		provider.setModel(model([item({ key: "on", label: "on", checked: true }), item({ key: "off", label: "off", checked: false }), item({ key: "ro", label: "ro", checked: null })]));
		const [on, off, ro] = provider.getChildren(provider.getChildren()[0]);
		assert.equal(on!.checkboxState, TreeItemCheckboxState.Checked);
		assert.equal(off!.checkboxState, TreeItemCheckboxState.Unchecked);
		assert.equal(ro!.checkboxState, undefined);
		assert.equal(on!.contextValue, "inventory.switchable");
		assert.equal(ro!.contextValue, "inventory.readonly");
	});
	it("opens the source on click only when the row has one and keeps tooltips plain text", () => {
		const provider = new InventoryTreeProvider();
		provider.setModel(model([item({ key: "s", label: "s", openPath: "C:/skills/s/SKILL.md", tooltip: "[x](command:workbench.action.quit)" }), item({ key: "n", label: "n" })]));
		const [withSource, without] = provider.getChildren(provider.getChildren()[0]);
		assert.deepEqual(withSource!.command, { command: OPEN_SOURCE_COMMAND, title: "Open Source", arguments: ["C:/skills/s/SKILL.md"] });
		assert.equal(without!.command, undefined);
		assert.equal(typeof withSource!.tooltip, "string", "a string tooltip is rendered as text, never as Markdown");
	});
	it("fires one change for a new model", () => {
		const provider = new InventoryTreeProvider();
		let fired = 0;
		provider.onDidChangeTreeData(() => { fired += 1; });
		provider.setModel(model([item({})]));
		assert.equal(fired, 1);
	});
});
