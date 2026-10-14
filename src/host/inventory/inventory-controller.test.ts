import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FRESH_MS, InventoryController } from "./inventory-controller.ts";
import type { InventoryControllerDeps } from "./inventory-controller.ts";
import type { InventoryResult, InventoryRow, InventoryScope, InventorySnapshot, ViewKind, ViewModel } from "./inventory-model.ts";
import type { InventoryRuntime, InventoryReadRequest, ToggleRequest, ToggleResult } from "./inventory-runtime.ts";
import { recordingLogger, type LoggedLine } from "../../shared/logger.ts";
import type { SessionToolsTarget } from "../session-tools.ts";

const skill: InventoryRow = { kind: "skill", name: "review", description: null, path: "C:/s/SKILL.md", provider: "native", providerName: "OMP", level: "user", state: "active", shadowed: false, shadowedBy: null,
	disabledReason: null, detail: null, toolPrefix: null, runtimeName: "review", sources: [], toggle: { mechanism: "disabledExtensions", refusal: null } };
const snapshot = (cwd: string, profile = "default"): InventorySnapshot => ({ rows: [{ ...skill }], cwd, profile, projectOverridesDisabledExtensions: false, incomplete: [], incompleteReasons: [], disabledProviders: [] });

function target(overrides: Partial<SessionToolsTarget> = {}): SessionToolsTarget {
	return { key: {}, generation: "g1", tabId: "tab-1", mode: "chat", running: true, title: "Work", cwd: "D:/proj", profile: null, commands: [], readDescriptors: null, readTools: null, ...overrides };
}

function harness(initial: SessionToolsTarget | null) {
	const state = { clock: 1_000_000, target: initial, reads: [] as InventoryReadRequest[], toggles: [] as ToggleRequest[], published: [] as Array<[ViewKind, ViewModel]>, scopes: [] as Array<[ViewKind, InventoryScope]>,
		toggleGate: null as Promise<void> | null,
		notices: [] as Array<[string, string]>, undos: [] as Array<() => void>, logs: [] as LoggedLine[], delays: [] as number[], gate: null as Promise<void> | null, toggleResult: { ok: true, changed: true, writes: [] } as ToggleResult, readResult: null as ((request: InventoryReadRequest) => InventoryResult) | null };
	const runtime: InventoryRuntime = {
		async read(request) { state.reads.push(request); if (state.gate) await state.gate; return state.readResult?.(request) ?? snapshot(request.cwd, request.profile); },
		async toggle(request) { state.toggles.push(request); if (state.toggleGate) await state.toggleGate; return state.toggleResult; },
	};
	const deps: InventoryControllerDeps = { target: () => state.target, runtime, neutralCwd: "C:/", publish: (view, model) => { state.published.push([view, model]); },
		scopeChanged: (view, scope) => { state.scopes.push([view, scope]); }, notify: (message, level, undo) => { state.notices.push([level, message]); if (undo !== undefined) state.undos.push(undo); }, log: recordingLogger(state.logs), delay: async ms => { state.delays.push(ms); }, now: () => state.clock };
	const controller = new InventoryController(deps);
	const settle = async () => { for (let turn = 0; turn < 20; turn++) await new Promise(resolve => setImmediate(resolve)); };
	/** Switch lines only: timing lines are informational and differ per run. */
	const switchLogs = (): LoggedLine[] => state.logs.filter(line => /inventory: switch/.test(line.message));
	const last = (view: ViewKind) => state.published.filter(([kind]) => kind === view).at(-1)![1];
	const shown = (view: ViewKind): InventoryRow => last(view).groups[0]!.items[0]!.row!;
	return { state, controller, settle, last, shown, switchLogs };
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
		assert.deepEqual(h.state.reads, [{ cwd: "D:/proj", profile: "work", scope: "session" }], "three views opened in a row: one worker run");
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
		assert.equal(h.state.reads.length, 1, "the same folder and profile is read once; the new generation only re-reads the session");
	});
	it("does not read OMP again for a changed generation of the same folder and profile", async () => {
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
		assert.equal(h.state.reads.length, before, "a new generation of the same folder and profile reuses the fresh read");
	});
	it("reports an unreadable inventory as a message in the view", async () => {
		const h = harness(null);
		h.state.readResult = () => ({ unavailable: "No Bun." });
		h.controller.setVisible("mcp", true);
		await h.settle();
		assert.equal(h.last("mcp").message, "No Bun.");
	});
});

describe("inventory controller cache", () => {
	it("opening views one after another while the first read runs starts one worker run, and every view gets its rows", async () => {
		const h = harness(null);
		let release!: () => void;
		h.state.gate = new Promise<void>(resolve => { release = resolve; });
		for (const view of ["skills", "tools", "mcp"] as const) { h.controller.setVisible(view, true); await h.settle(); }
		assert.equal(h.state.reads.length, 1, "later cycles join the read that is already running");
		release();
		await h.settle();
		assert.equal(h.state.reads.length, 1);
		for (const view of ["skills", "tools", "mcp"] as const) assert.notEqual(h.last(view).message, "Reading OMP's inventory…", view);
	});
	it("paints a cached read at once, marked while a newer one runs, and replaces it with the fresh one", async () => {
		const h = harness(null);
		h.controller.setVisible("skills", true);
		await h.settle();
		h.state.clock += 60_000;
		let release!: () => void;
		h.state.gate = new Promise<void>(resolve => { release = resolve; });
		h.controller.refresh();
		await h.settle();
		assert.equal(h.last("skills").message, null, "rows stay on screen");
		assert.match(h.last("skills").description, /refreshing…$/);
		release();
		await h.settle();
		assert.doesNotMatch(h.last("skills").description, /refreshing/);
		assert.equal(h.state.reads.length, 2);
	});
	it("uses a read younger than the freshness window without asking OMP again, and not an older one", async () => {
		const h = harness(null);
		h.controller.setVisible("skills", true);
		await h.settle();
		h.state.clock += FRESH_MS - 1;
		h.controller.refresh();
		await h.settle();
		assert.equal(h.state.reads.length, 1);
		assert.doesNotMatch(h.last("skills").description, /refreshing/);
		h.state.clock += 2;
		h.controller.refresh();
		await h.settle();
		assert.equal(h.state.reads.length, 2);
	});
	it("an explicit Refresh and a written switch drop the cache and read again", async () => {
		const h = harness(target({ running: false }));
		h.controller.setVisible("skills", true);
		await h.settle();
		h.controller.refresh({ force: true });
		await h.settle();
		assert.equal(h.state.reads.length, 2);
		await h.controller.toggle("skills", h.shown("skills"), false);
		await h.settle();
		assert.equal(h.state.reads.length, 3);
	});
	it("a forced refresh while no view is visible is remembered, so showing a view later does not paint the cached read", async () => {
		const h = harness(null);
		h.controller.setVisible("skills", true);
		await h.settle();
		h.controller.setVisible("skills", false);
		h.controller.refresh({ force: true });
		await h.settle();
		assert.equal(h.state.reads.length, 1, "nothing is read while hidden");
		h.controller.setVisible("skills", true);
		await h.settle();
		assert.equal(h.state.reads.length, 2, "the cached read was dropped and the OMP is read again");
	});
	it("a read that was running before a switch is not cached as current afterwards", async () => {
		const h = harness(null);
		let release!: () => void;
		h.state.gate = new Promise<void>(resolve => { release = resolve; });
		h.controller.setVisible("skills", true);
		await h.settle();
		const stale = snapshot("C:/");
		h.state.readResult = () => ({ ...stale, rows: [{ ...skill, name: "old" }] });
		await h.controller.toggle("skills", skill, false).catch(() => {});
		h.state.readResult = () => ({ ...stale, rows: [{ ...skill, name: "new" }] });
		h.state.gate = null;
		release();
		await h.settle();
		h.controller.refresh();
		await h.settle();
		assert.equal(h.last("skills").groups[0]!.items[0]!.label, "new");
	});
	it("keeps showing the earlier read, marked, when a refresh fails, and never caches the failure", async () => {
		const h = harness(null);
		h.controller.setVisible("skills", true);
		await h.settle();
		h.state.clock += 60_000;
		h.state.readResult = () => ({ unavailable: "No Bun." });
		h.controller.refresh();
		await h.settle();
		assert.equal(h.last("skills").message, null);
		assert.match(h.last("skills").description, /could not refresh; showing an earlier read/);
		h.state.readResult = null;
		h.controller.refresh();
		await h.settle();
		assert.doesNotMatch(h.last("skills").description, /could not refresh/);
		assert.equal(h.state.reads.length, 3);
	});
	it("a session tab switch back to a folder read moments ago paints its cached list without another worker run", async () => {
		const h = harness(target({ cwd: "D:/a" }));
		h.controller.setVisible("skills", true);
		await h.settle();
		h.state.target = target({ cwd: "D:/b", generation: "g2", key: {} });
		h.controller.sync();
		await h.settle();
		h.state.target = target({ cwd: "D:/a", generation: "g3", key: {} });
		h.controller.sync();
		await h.settle();
		assert.deepEqual(h.state.reads.map(read => read.cwd), ["D:/a", "D:/b"]);
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
	it("logs each switch request with its view, item, transition and list, and its outcome with what was written, and nothing for a refresh", async () => {
		const h = harness(target());
		h.controller.setVisible("skills", true);
		await h.settle();
		assert.deepEqual(h.switchLogs(), []);
		h.state.toggleResult = { ok: true, changed: true, writes: [{ file: "C:/u/config.yml", what: "disabledExtensions + skill:review" }] };
		await h.controller.toggle("skills", h.shown("skills"), false);
		h.state.toggleResult = { ok: true, changed: false, writes: [] };
		await h.controller.toggle("skills", h.shown("skills"), true);
		h.state.toggleResult = { ok: false, message: "OMP no longer lists this item." };
		await h.controller.toggle("skills", h.shown("skills"), false);
		assert.deepEqual(h.switchLogs(), [
			{ level: "info", message: "inventory: switch requested in the skills view: skill:review enabled→disabled (global configuration of profile default; list shown: session, folder D:/proj)" },
			{ level: "info", message: "inventory: switch skill:review enabled→disabled: written: disabledExtensions + skill:review (C:/u/config.yml)" },
			{ level: "info", message: "inventory: switch requested in the skills view: skill:review disabled→enabled (global configuration of profile default; list shown: session, folder D:/proj)" },
			{ level: "info", message: "inventory: switch skill:review disabled→enabled: already as requested; nothing written" },
			{ level: "info", message: "inventory: switch requested in the skills view: skill:review enabled→disabled (global configuration of profile default; list shown: session, folder D:/proj)" },
			{ level: "warn", message: "inventory: switch skill:review enabled→disabled: refused: OMP no longer lists this item." },
		]);
	});
	it("logs a failed read with its list, profile and folder", async () => {
		const h = harness(target());
		h.state.readResult = () => ({ unavailable: "No Bun." });
		h.controller.setVisible("skills", true);
		await h.settle();
		assert.deepEqual(h.state.logs.filter(line => /read failed/.test(line.message)).map(line => ({ level: line.level, message: line.message.replace(/ after \d+ ms/, "") })), [{ level: "warn", message: "inventory: read failed (session list, profile default, folder D:/proj): No Bun." }]);
	});
	it("offers Undo only on a successful disable, and Undo enables the same row again", async () => {
		const h = harness(target());
		h.controller.setVisible("skills", true);
		await h.settle();
		const row = h.shown("skills");
		await h.controller.toggle("skills", row, false);
		assert.equal(h.state.undos.length, 1);
		assert.match(h.state.notices[0]![1], /Disabled skill review/);
		h.state.undos[0]!();
		await h.settle();
		assert.deepEqual(h.state.toggles.map(toggle => toggle.enabled), [false, true]);
		assert.equal(h.state.undos.length, 1, "enabling offers no Undo");
		h.state.toggleResult = { ok: true, changed: false, writes: [] };
		await h.controller.toggle("skills", row, false);
		assert.equal(h.state.undos.length, 1, "nothing written, nothing to undo");
		h.state.toggleResult = { ok: false, message: "No." };
		await h.controller.toggle("skills", row, false);
		assert.equal(h.state.undos.length, 1, "a refusal offers no Undo");
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
		h.state.toggleResult = { ok: true, changed: false, writes: [] };
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
