import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setImmediate as settle } from "node:timers/promises";
import { SessionToolsController, projectSessionTools, type SessionToolsSnapshot, type SessionToolsTarget } from "./session-tools.ts";

function target(overrides: Partial<SessionToolsTarget> = {}): SessionToolsTarget {
	return { key: {}, generation: "one", mode: "chat", running: true, commands: [], readDescriptors: null, readTools: null, ...overrides };
}

describe("session tools projection", () => {
	it("lists only reported skill commands and preserves plain descriptions", () => {
		const result = projectSessionTools(target({ commands: [{ name: "skill:review", source: "skill", description: "[plain](command:bad)" }, { name: "compact", source: "builtin" }] }), [], null);
		assert.deepEqual(result.skills, [{ name: "skill:review", description: "[plain](command:bad)" }]);
		assert.equal(result.skillsMessage, null);
	});
	it("merges exact names and marks inactive only with positive registry evidence", () => {
		const result = projectSessionTools(target(), [{ name: "read", description: "Read files" }, { name: "provider_only", description: "Provider tool" }], { available: true, all: ["read", "write"], active: ["read", "mounted"], unavailableReason: null });
		assert.deepEqual(result.tools.map(tool => [tool.name, tool.active]), [["mounted", true], ["provider_only", null], ["read", true], ["write", false]]);
		assert.equal(result.tools.find(tool => tool.name === "read")?.description, "Read files");
	});
	it("does not infer activation when host control is unavailable", () => {
		assert.equal(projectSessionTools(target(), [{ name: "read", description: "Read" }], null).tools[0]?.active, null);
	});
	it("Terminal can show names but never claims to have a skill catalogue", () => {
		const result = projectSessionTools(target({ mode: "terminal" }), null, { available: true, all: ["read"], active: [], unavailableReason: null });
		assert.equal(result.tools[0]?.active, false);
		assert.ok(result.skillsMessage);
	});
});
describe("session tools controller", () => {
	it("does not read while hidden and refreshes when revealed", async () => {
		let reads = 0;
		const selected = target({ readDescriptors: async () => { reads++; return []; } });
		const snapshots: SessionToolsSnapshot[] = [];
		const controller = new SessionToolsController(() => selected, snapshot => snapshots.push(snapshot));
		controller.sync(); controller.refresh();
		assert.equal(reads, 0);
		controller.setVisible(true); await settle();
		assert.equal(reads, 1);
		controller.sync(); await settle();
		assert.equal(reads, 1, "unchanged lifecycle does not read on every model update");
		controller.dispose();
	});
	it("clears stopped/no-editor state and never shows the late prior session", async () => {
		const pending = Promise.withResolvers<readonly { name: string; description: string }[]>();
		const finish = pending.resolve;
		let selected: SessionToolsTarget | null = target({ readDescriptors: () => pending.promise });
		const snapshots: SessionToolsSnapshot[] = [];
		const controller = new SessionToolsController(() => selected, snapshot => snapshots.push(snapshot));
		controller.setVisible(true);
		selected = null; controller.sync();
		finish([{ name: "old", description: "old" }]); await settle();
		assert.ok(snapshots.at(-1)?.message);
		assert.deepEqual(snapshots.at(-1)?.tools, []);
		selected = target({ running: false }); controller.sync();
		assert.ok(snapshots.at(-1)?.message);
		controller.dispose();
	});
	it("coalesces refreshes and discards an older epoch of the same runtime", async () => {
		let finish!: (tools: readonly { name: string; description: string }[]) => void;
		let reads = 0;
		let selected = target({ readDescriptors: () => {
			reads++;
			const pending = Promise.withResolvers<readonly { name: string; description: string }[]>();
			finish = pending.resolve;
			return pending.promise;
		} });
		const snapshots: SessionToolsSnapshot[] = [];
		const controller = new SessionToolsController(() => selected, snapshot => snapshots.push(snapshot));
		controller.setVisible(true);
		selected = { ...selected, generation: "two" };
		controller.sync(); controller.refresh(); controller.refresh();
		assert.equal(reads, 1);
		finish([{ name: "old", description: "old" }]); await settle();
		assert.equal(reads, 2);
		assert.equal(snapshots.some(snapshot => snapshot.tools.some(tool => tool.name === "old")), false);
		finish([{ name: "current", description: "current" }]); await settle();
		assert.equal(snapshots.at(-1)?.tools[0]?.name, "current");
		controller.dispose();
	});
	it("a failed source keeps the independently available catalogue", async () => {
		const selected = target({ readDescriptors: async () => { throw new Error("read unavailable"); }, commands: [{ name: "skill:test", source: "skill" }] });
		let snapshot!: SessionToolsSnapshot;
		const controller = new SessionToolsController(() => selected, result => { snapshot = result; });
		controller.setVisible(true); await settle();
		assert.equal(snapshot.skills[0]?.name, "skill:test");
		assert.ok(snapshot.toolsMessage);
		controller.dispose();
	});
});
