import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InventoryController } from "./inventory-controller.ts";
import type { InventoryControllerDeps } from "./inventory-controller.ts";
import type { InventoryResult, InventoryRow, InventoryScope, InventorySnapshot, ViewKind, ViewModel } from "./inventory-model.ts";
import type { InventoryRuntime, InventoryReadRequest, ToggleRequest, ToggleResult } from "./inventory-runtime.ts";
import type { SessionToolsTarget } from "../session-tools.ts";

const skill: InventoryRow = { kind: "skill", name: "review", description: null, path: "C:/s/SKILL.md", provider: "native", providerName: "OMP", level: "user", state: "active", shadowed: false,
	disabledReason: null, detail: null, toolPrefix: null, runtimeName: "review", toggle: { mechanism: "disabledExtensions", refusal: null } };
const snapshot = (cwd: string, profile = "default"): InventorySnapshot => ({ rows: [{ ...skill }], cwd, profile, projectOverridesDisabledExtensions: false, incomplete: [], disabledProviders: [] });

function target(overrides: Partial<SessionToolsTarget> = {}): SessionToolsTarget {
	return { key: {}, generation: "g1", mode: "chat", running: true, title: "Work", cwd: "D:/proj", profile: null, commands: [], readDescriptors: null, readTools: null, ...overrides };
}

function harness(initial: SessionToolsTarget | null) {
	const state = { target: initial, reads: [] as InventoryReadRequest[], toggles: [] as ToggleRequest[], published: [] as Array<[ViewKind, ViewModel]>, scopes: [] as Array<[ViewKind, InventoryScope]>,
		toggleGate: null as Promise<void> | null,
		notices: [] as Array<[string, string]>, delays: [] as number[], gate: null as Promise<void> | null, toggleResult: { ok: true, changed: true } as ToggleResult, readResult: null as ((request: InventoryReadRequest) => InventoryResult) | null };
	const runtime: InventoryRuntime = {
		async read(request) { state.reads.push(request); if (state.gate) await state.gate; return state.readResult?.(request) ?? snapshot(request.cwd, request.profile); },
		async toggle(request) { state.toggles.push(request); if (state.toggleGate) await state.toggleGate; return state.toggleResult; },
	};
	const deps: InventoryControllerDeps = { target: () => state.target, runtime, neutralCwd: "C:/", publish: (view, model) => { state.published.push([view, model]); },
		scopeChanged: (view, scope) => { state.scopes.push([view, scope]); }, notify: (message, level) => { state.notices.push([level, message]); }, delay: async ms => { state.delays.push(ms); } };
	const controller = new InventoryController(deps);
	const settle = async () => { for (let turn = 0; turn < 20; turn++) await new Promise(resolve => setImmediate(resolve)); };
	const last = (view: ViewKind) => state.published.filter(([kind]) => kind === view).at(-1)![1];
	const shown = (view: ViewKind): InventoryRow => last(view).groups[0]!.items[0]!.row!;
	return { state, controller, settle, last, shown };
}

describe("inventory controller scope and reads", () => {
	it("reads nothing until a view is visible, then only for visible views", async () => {
		const h = harness(target());
		h.controller.refresh();
		await h.settle();
		assert.equal(h.state.reads.length, 0);
		h.controller.setVisible("skills", true);
		await h.settle();
		assert.deepEqual(h.state.reads, [{ cwd: "D:/proj", profile: "default", scope: "session" }]);
		assert.equal(h.last("skills").scope, "session");
		assert.equal(h.state.published.some(([view]) => view === "mcp"), false);
	});
	it("shares one worker read between views that need the same folder and profile", async () => {
		const h = harness(target({ profile: "work" }));
		for (const view of ["skills", "tools", "mcp"] as const) h.controller.setVisible(view, true);
		await h.settle();
		const before = h.state.reads.length;
		h.controller.refresh();
		await h.settle();
		assert.deepEqual(h.state.reads.slice(before), [{ cwd: "D:/proj", profile: "work", scope: "session" }], "three views, one worker run");
		for (const view of ["skills", "tools", "mcp"] as const) assert.equal(h.last(view).scope, "session");
	});
	it("shows Global at the neutral folder with no active session", async () => {
		const h = harness(null);
		h.controller.setVisible("skills", true);
		await h.settle();
		assert.deepEqual(h.state.reads, [{ cwd: "C:/", profile: "default", scope: "global" }]);
		assert.equal(h.last("skills").description, "Global");
		assert.deepEqual(h.state.scopes.at(-1), ["skills", "global"]);
	});
	it("says why Global is shown when the user chose Session but no session is active", async () => {
		const h = harness(null);
		h.controller.setVisible("skills", true);
		h.controller.setScope("skills", "session");
		await h.settle();
		assert.equal(h.last("skills").description, "Global (no active session)");
	});
	it("keeps an explicit Global choice per view while another view stays on the session", async () => {
		const h = harness(target());
		h.controller.setVisible("skills", true);
		h.controller.setVisible("mcp", true);
		await h.settle();
		h.controller.setScope("skills", "global");
		await h.settle();
		assert.equal(h.last("skills").scope, "global");
		assert.equal(h.last("skills").description, "Global");
		assert.equal(h.last("mcp").scope, "session");
		assert.equal(h.state.reads.at(-1)?.cwd === "C:/" || h.state.reads.some(read => read.scope === "global" && read.cwd === "C:/"), true);
		h.controller.setScope("skills", "session");
		await h.settle();
		assert.equal(h.last("skills").scope, "session");
	});
	it("discards a read that finishes after the session changed", async () => {
		const h = harness(target());
		let release!: () => void;
		h.state.gate = new Promise<void>(resolve => { release = resolve; });
		h.controller.setVisible("skills", true);
		await h.settle();
		h.state.target = target({ generation: "g2" });
		release();
		h.state.gate = null;
		await h.settle();
		h.controller.sync();
		await h.settle();
		const results = h.state.published.filter(([, model]) => model.message === null);
		assert.equal(results.length >= 1, true);
		assert.equal(results.every(([, model]) => model.description === "Session: Work"), true);
		assert.equal(h.state.reads.length >= 2, true, "the new generation was read again");
	});
	it("reads again for a changed generation but not for an identical target", async () => {
		const h = harness(target());
		h.controller.setVisible("skills", true);
		await h.settle();
		const before = h.state.reads.length;
		h.controller.sync();
		await h.settle();
		assert.equal(h.state.reads.length, before);
		h.state.target = target({ generation: "g2" });
		h.controller.sync();
		await h.settle();
		assert.equal(h.state.reads.length, before + 1);
	});
	it("reports an unreadable inventory as a message in the view", async () => {
		const h = harness(null);
		h.state.readResult = () => ({ unavailable: "No Bun." });
		h.controller.setVisible("mcp", true);
		await h.settle();
		assert.equal(h.last("mcp").message, "No Bun.");
	});
});

describe("inventory controller switches", () => {
	it("switches against the scope and folder of the view that owns the row and reports what OMP may apply live", async () => {
		const h = harness(target());
		h.controller.setVisible("skills", true);
		await h.settle();
		await h.controller.toggle("skills", h.shown("skills"), false);
		assert.deepEqual(h.state.toggles, [{ cwd: "D:/proj", profile: "default", scope: "session", kind: "skill", name: "review", enabled: false }]);
		assert.equal(h.state.notices[0]![0], "info");
		assert.match(h.state.notices[0]![1], /may apply it live/);
		assert.deepEqual(h.state.delays, [1500], "a running session gets time for OMP's config watcher before the refresh");
	});
	it("does not wait for the watcher when the session is not running or the kind applies next session", async () => {
		const h = harness(target({ running: false }));
		h.controller.setVisible("skills", true);
		await h.settle();
		await h.controller.toggle("skills", h.shown("skills"), false);
		assert.deepEqual(h.state.delays, []);
		const mcp = harness(target());
		mcp.state.readResult = request => ({ ...snapshot(request.cwd, request.profile), rows: [{ ...skill, kind: "mcp", name: "srv", toggle: { mechanism: "mcp", refusal: null } }] });
		mcp.controller.setVisible("mcp", true);
		await mcp.settle();
		await mcp.controller.toggle("mcp", mcp.shown("mcp"), false);
		assert.deepEqual(mcp.state.delays, []);
		assert.match(mcp.state.notices[0]![1], /Restart a running session/);
	});
	it("warns and refreshes when the write is refused, and never claims success", async () => {
		const h = harness(target());
		h.controller.setVisible("skills", true);
		await h.settle();
		h.state.toggleResult = { ok: false, message: "OMP no longer lists this item." };
		const reads = h.state.reads.length;
		await h.controller.toggle("skills", h.shown("skills"), false);
		await h.settle();
		assert.deepEqual(h.state.notices, [["warning", "OMP no longer lists this item."]]);
		assert.equal(h.state.reads.length > reads, true);
	});
	it("says nothing changed when OMP already had that state", async () => {
		const h = harness(target());
		h.controller.setVisible("skills", true);
		await h.settle();
		h.state.toggleResult = { ok: true, changed: false };
		await h.controller.toggle("skills", h.shown("skills"), false);
		assert.match(h.state.notices[0]![1], /already disabled/);
		assert.deepEqual(h.state.delays, []);
	});
	it("serializes switches so two writes never interleave", async () => {
		const h = harness(target());
		h.controller.setVisible("skills", true);
		await h.settle();
		let release!: () => void;
		h.state.toggleGate = new Promise<void>(resolve => { release = resolve; });
		const row = h.shown("skills");
		const first = h.controller.toggle("skills", row, false);
		const second = h.controller.toggle("skills", row, true);
		await h.settle();
		assert.deepEqual(h.state.toggles.map(toggle => toggle.enabled), [false], "the second write waits for the first");
		release();
		await Promise.all([first, second]);
		assert.deepEqual(h.state.toggles.map(toggle => toggle.enabled), [false, true]);
	});
	it("writes the profile of the list the row came from even when the selected session changes while a switch waits", async () => {
		const h = harness(target({ profile: "alpha" }));
		h.controller.setVisible("skills", true);
		await h.settle();
		let release!: () => void;
		h.state.toggleGate = new Promise<void>(resolve => { release = resolve; });
		const first = h.controller.toggle("skills", h.shown("skills"), false);
		h.state.target = target({ profile: "beta", cwd: "D:/other", generation: "g9", key: {} });
		h.controller.sync();
		await h.settle();
		const second = h.controller.toggle("skills", h.shown("skills"), false);
		release();
		await Promise.all([first, second]);
		assert.equal(h.state.toggles[0]!.profile, "alpha");
		assert.equal(h.state.toggles[1]!.profile, "beta", "a row published for the new list uses the new list's context");
		const stale = h.state.toggles.filter(toggle => toggle.profile === "alpha").length;
		assert.equal(stale, 1);
	});
	it("keeps a clicked row's own context after a newer list replaced it, and refuses a row it never published", async () => {
		const h = harness(target({ profile: "alpha" }));
		h.controller.setVisible("skills", true);
		await h.settle();
		const published = h.last("skills").groups[0]!.items[0]!.row!;
		h.state.target = target({ profile: "beta", cwd: "D:/other", generation: "g9", key: {} });
		h.controller.sync();
		await h.settle();
		await h.controller.toggle("skills", published, false);
		assert.equal(h.state.toggles[0]!.profile, "alpha", "the old row writes the profile it was shown for");
		await h.controller.toggle("skills", { ...skill, name: "invented" }, false);
		assert.equal(h.state.toggles.length, 1);
		assert.equal(h.state.notices.at(-1)![0], "warning");
	});
	it("refuses to switch before the view has ever been read", async () => {
		const h = harness(target());
		await h.controller.toggle("skills", skill, false);
		assert.deepEqual(h.state.toggles, []);
		assert.equal(h.state.notices[0]![0], "warning");
	});
});
