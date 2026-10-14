/** The tool display mode's transitions and stored form. Runner: `node --test src/chat/tools-mode.test.ts`. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isToolsMode, nextToolsMode, toolsModeFromStored, toolsModeToStored, type ToolsMode } from "./tools-mode.ts";

describe("tools mode", () => {
	it("moves between collapsed, groups and all the way the table says", () => {
		const table: Record<ToolsMode, { output: ToolsMode; groups: ToolsMode }> = {
			collapsed: { output: "all", groups: "groups" },
			groups: { output: "all", groups: "collapsed" },
			all: { output: "collapsed", groups: "groups" },
		};
		for (const [from, next] of Object.entries(table) as [ToolsMode, { output: ToolsMode; groups: ToolsMode }][]) {
			assert.equal(nextToolsMode(from, "output"), next.output, `Ctrl+O from ${from}`);
			assert.equal(nextToolsMode(from, "groups"), next.groups, `Ctrl+Shift+O from ${from}`);
		}
	});

	it("keeps what earlier builds stored and round-trips every mode", () => {
		assert.equal(toolsModeFromStored(true), "all", "an earlier build's expanded default");
		assert.equal(toolsModeFromStored(false), "collapsed");
		assert.equal(toolsModeFromStored(undefined), "collapsed");
		assert.equal(toolsModeFromStored("yes"), "collapsed");
		for (const mode of ["collapsed", "groups", "all"] as const) assert.equal(toolsModeFromStored(toolsModeToStored(mode)), mode);
		assert.equal(toolsModeToStored("all"), true, "an older build still reads the expanded default");
		assert.equal(isToolsMode("groups"), true);
		assert.equal(isToolsMode(true), false);
	});
});
