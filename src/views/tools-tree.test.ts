import assert from "node:assert/strict";
import module from "node:module";
import { describe, it } from "node:test";
import { emptyTools } from "../host/session-tools.ts";

if (typeof module.registerHooks === "function") {
	const stubUrl = new URL("./vscode-test-stub.ts", import.meta.url).href;
	module.registerHooks({ resolve(specifier, context, nextResolve) {
		if (specifier === "vscode") return { url: stubUrl, shortCircuit: true };
		return nextResolve(specifier, context);
	} });
}
// Load after the test hook: a static import would resolve the unavailable VS Code runtime first.
const { ToolsTreeProvider } = await import("./tools-tree.ts");
describe("Tools tree", () => {
	it("shows an empty-state row rather than stale capability groups", () => {
		const provider = new ToolsTreeProvider();
		assert.equal(provider.getChildren().length, 1);
		provider.setSnapshot(emptyTools("stopped"));
		assert.equal(provider.getChildren()[0]?.label, "stopped");
		provider.dispose();
	});
	it("groups skill commands and tools with plain tooltips, inactive marks and no invocation", () => {
		const provider = new ToolsTreeProvider();
		provider.setSnapshot({ message: null, skillsMessage: null, toolsMessage: null,
			skills: [{ name: "skill:review", description: "[plain](command:bad)" }],
			tools: [{ name: "read", description: "Read files", active: true }, { name: "write", description: "Write files", active: false }, { name: "other", description: "Other tool", active: null }] });
		const groups = provider.getChildren();
		assert.deepEqual(groups.map(group => group.label), ["Skills", "Tools"]);
		const skills = provider.getChildren(groups[0]);
		assert.equal(skills[0]?.tooltip, "[plain](command:bad)");
		const tools = provider.getChildren(groups[1]);
		assert.equal(tools[1]?.description, "Inactive");
		assert.equal(tools[2]?.description, "Activation unknown");
		for (const row of [...skills, ...tools]) {
			assert.equal(typeof row.tooltip, "string");
			assert.equal(row.command, undefined);
			assert.equal(row.resourceUri, undefined);
			assert.deepEqual(provider.getChildren(row), []);
		}
		provider.dispose();
	});
});
