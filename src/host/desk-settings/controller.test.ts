import assert from "node:assert/strict";
import { test } from "node:test";
import { DeskSettingsController } from "./controller.ts";
import { projectConfiguration } from "./model.ts";
import type { DeskSettingsPort } from "./controller.ts";
import type { ConfigLayers, JsonValue, Target } from "./model.ts";

const DESCRIPTORS = projectConfiguration({
	title: "T",
	properties: {
		"t.flag": { type: "boolean", default: true },
		"t.limit": { type: "integer", minimum: 1, maximum: 9, default: 3 },
		"t.mode": { type: "string", enum: ["a", "b"], default: "a", scope: "application" },
		"t.list": { type: "array", default: [] },
	},
});

interface Fake {
	readonly port: DeskSettingsPort;
	readonly layers: Record<string, { default?: JsonValue; user?: JsonValue; workspace?: JsonValue }>;
	readonly writes: { key: string; value: JsonValue | undefined; target: Target }[];
	readonly opened: string[];
	workspace: { available: boolean; name: string | null };
	failNext: Error | null;
}

function fake(): Fake {
	const defaults: Record<string, JsonValue> = { "t.flag": true, "t.limit": 3, "t.mode": "a", "t.list": [] };
	const state: Fake = {
		layers: Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, { default: value }])),
		writes: [],
		opened: [],
		workspace: { available: true, name: "proj" },
		failNext: null,
		port: undefined as unknown as DeskSettingsPort,
	};
	const effective = (key: string): JsonValue | undefined => {
		const layer = state.layers[key]!;
		return layer.workspace ?? layer.user ?? layer.default;
	};
	(state as { port: DeskSettingsPort }).port = {
		inspect(key): ConfigLayers {
			const layer = state.layers[key]!;
			return {
				...(layer.default === undefined ? {} : { defaultValue: layer.default }),
				...(layer.user === undefined ? {} : { globalValue: layer.user }),
				...(layer.workspace === undefined ? {} : { workspaceValue: layer.workspace }),
			};
		},
		effective,
		folderValues: () => [],
		async update(key, value, target) {
			if (state.failNext) { const error = state.failNext; state.failNext = null; throw error; }
			state.writes.push({ key, value, target });
			state.layers[key]![target === "user" ? "user" : "workspace"] = value;
		},
		workspace: () => state.workspace,
		async openSettingsEditor(key) { state.opened.push(`editor:${key}`); },
		async openSettingsJson(key, target, edit) { state.opened.push(`json:${key}:${target}:${edit}`); },
		async testOmp() { return { ok: false, message: "this fake has no OMP" }; },
	};
	return state;
}

const logs: string[] = [];
const controller = (state: Fake) => new DeskSettingsController(DESCRIPTORS, state.port, message => logs.push(message));
let request = 0;
const act = (c: DeskSettingsController, body: Record<string, unknown>) => c.handle({ requestId: `r${++request}`, ...body });

test("the state lists every contributed setting with its effective value and source", async () => {
	const state = fake();
	state.layers["t.flag"]!.user = false;
	const snapshot = controller(state).state();
	const rows = snapshot.groups.flatMap(group => group.settings);
	assert.deepEqual(rows.map(row => row.key), ["t.flag", "t.limit", "t.mode", "t.list"]);
	assert.deepEqual(rows.map(row => [row.source, row.modified, row.value]), [["user", true, false], ["default", false, 3], ["default", false, "a"], ["default", false, []]]);
	assert.deepEqual(snapshot.workspace, { available: true, name: "proj" });
});

test("a valid change is written to the user layer and reported; an invalid one is refused before any write", async () => {
	const state = fake();
	const c = controller(state);
	const ok = await act(c, { action: "set", key: "t.limit", value: 5 });
	assert.deepEqual(ok, { type: "settings:result", requestId: ok!.requestId, key: "t.limit", ok: true, message: "Saved to User settings." });
	assert.deepEqual(state.writes, [{ key: "t.limit", value: 5, target: "user" }]);
	for (const value of [10, 0, 2.5, "5", null]) {
		const refused = await act(c, { action: "set", key: "t.limit", value });
		assert.equal(refused!.ok, false, String(value));
	}
	assert.equal((await act(c, { action: "set", key: "t.mode", value: "c" }))!.ok, false, "a value outside the enumeration");
	assert.equal((await act(c, { action: "set", key: "t.list", value: [1] }))!.ok, false, "arrays are not written by the view");
	assert.equal(state.writes.length, 1, "nothing refused reached the configuration");
});

test("the layer written follows the setting's scope, the open workspace and the user's choice", async () => {
	const state = fake();
	const c = controller(state);
	await act(c, { action: "set", key: "t.flag", value: false, target: "workspace" });
	assert.deepEqual(state.writes.at(-1), { key: "t.flag", value: false, target: "workspace" });
	// The workspace value now overrides, so an unchosen change goes there; choosing User warns that it will not show.
	await act(c, { action: "set", key: "t.flag", value: true });
	assert.equal(state.writes.at(-1)!.target, "workspace");
	const shadowed = await act(c, { action: "set", key: "t.flag", value: false, target: "user" });
	assert.equal(state.writes.at(-1)!.target, "user");
	assert.equal(shadowed!.ok, true);
	assert.match(shadowed!.message, /workspace's own value overrides it/);
	const appWrite = await act(c, { action: "set", key: "t.mode", value: "b", target: "workspace" });
	assert.equal(appWrite!.ok, false, "an application setting never goes to the workspace");
	assert.equal((await act(c, { action: "set", key: "t.mode", value: "b" }))!.ok, true);
	assert.equal(state.writes.at(-1)!.target, "user");
	state.workspace = { available: false, name: null };
	assert.equal((await act(c, { action: "set", key: "t.limit", value: 4, target: "workspace" }))!.ok, false, "no workspace is open");
});

test("reset removes the user and workspace values and leaves the default in effect", async () => {
	const state = fake();
	const c = controller(state);
	state.layers["t.flag"]!.user = false;
	state.layers["t.flag"]!.workspace = false;
	const result = await act(c, { action: "reset", key: "t.flag" });
	assert.equal(result!.ok, true);
	assert.deepEqual(state.writes, [{ key: "t.flag", value: undefined, target: "workspace" }, { key: "t.flag", value: undefined, target: "user" }]);
	assert.equal(state.layers["t.flag"]!.user, undefined);
	assert.deepEqual(c.state().groups[0]!.settings[0]!.source, "default");
	const again = await act(c, { action: "reset", key: "t.flag" });
	assert.equal(again!.message, "Already the default.");
	assert.equal(state.writes.length, 2, "an unmodified setting is not written");
	state.layers["t.mode"]!.user = "b";
	await act(c, { action: "reset", key: "t.mode" });
	assert.deepEqual(state.writes.at(-1), { key: "t.mode", value: undefined, target: "user" });
});

test("a reset that fails on the second layer says what was already cleared, and a reset another window undoes is not called a reset", async () => {
	const state = fake();
	const c = controller(state);
	state.layers["t.flag"]!.user = false;
	state.layers["t.flag"]!.workspace = false;
	const original = state.port.update;
	(state.port as { update: DeskSettingsPort["update"] }).update = async (key, value, target) => {
		if (target === "user") throw new Error("locked");
		await original(key, value, target);
	};
	const partial = await act(c, { action: "reset", key: "t.flag" });
	assert.equal(partial!.ok, false);
	assert.match(partial!.message, /Could not reset in User settings: locked \(Workspace settings were cleared\.\)/);
	assert.equal(state.layers["t.flag"]!.workspace, undefined);
	// A reset whose read-back is not the default (a concurrent write) is reported as such.
	(state.port as { update: DeskSettingsPort["update"] }).update = async (key, value, target) => {
		await original(key, value, target);
		state.layers[key]!.user = false;
	};
	state.layers["t.flag"]!.user = true;
	const raced = await act(c, { action: "reset", key: "t.flag" });
	assert.equal(raced!.ok, true);
	assert.match(raced!.message, /different value in effect/);
});

test("a failed write reports the reason and a later write still runs", async () => {
	const state = fake();
	const c = controller(state);
	state.failNext = new Error("Unable to write into user settings.");
	const failed = await act(c, { action: "set", key: "t.limit", value: 4 });
	assert.deepEqual([failed!.ok, failed!.message], [false, "Could not save to User settings: Unable to write into user settings."]);
	assert.equal((await act(c, { action: "set", key: "t.limit", value: 4 }))!.ok, true);
	assert.match(logs.join("\n"), /writing t\.limit to User settings failed/);
});

test("requests from the page are distrusted: unknown keys, missing ids and unknown actions do nothing", async () => {
	const state = fake();
	const c = controller(state);
	assert.equal((await act(c, { action: "set", key: "editor.fontSize", value: 40 }))!.ok, false, "only this extension's settings are writable");
	assert.equal((await act(c, { action: "set", key: "__proto__", value: 1 }))!.ok, false);
	assert.equal((await act(c, { action: "explode", key: "t.flag" }))!.ok, false);
	assert.equal(await c.handle({ action: "set", key: "t.flag", value: false }), null, "no request id");
	assert.equal(await c.handle({ requestId: "bad id!", action: "set", key: "t.flag", value: false }), null);
	assert.equal(await c.handle("nonsense"), null);
	assert.equal(await act(c, { action: "ready" }), null);
	assert.deepEqual(state.writes, []);
});

test("Open in Settings editor and Edit in settings.json address the right layer and setting", async () => {
	const state = fake();
	const c = controller(state);
	await act(c, { action: "open-editor", key: "t.limit" });
	await act(c, { action: "open-json", key: "t.list" });
	state.layers["t.flag"]!.workspace = true;
	await act(c, { action: "open-json", key: "t.flag" });
	await act(c, { action: "open-json", key: "t.mode" });
	assert.deepEqual(state.opened, ["editor:t.limit", "json:t.list:user:true", "json:t.flag:workspace:false", "json:t.mode:user:false"]);
});

test("concurrent writes run in order", async () => {
	const state = fake();
	const c = controller(state);
	const order: number[] = [];
	const gate = Promise.withResolvers<void>();
	const port = state.port.update.bind(state.port);
	(state.port as { update: DeskSettingsPort["update"] }).update = async (key, value, target) => {
		// The first write is held until both are requested; unserialised, the second would finish first.
		if (value === 1) await gate.promise;
		order.push(Number(value));
		await port(key, value, target);
	};
	const first = act(c, { action: "set", key: "t.limit", value: 1 });
	const second = act(c, { action: "set", key: "t.limit", value: 2 });
	gate.resolve();
	await Promise.all([first, second]);
	assert.deepEqual(order, [1, 2]);
	assert.equal(state.layers["t.limit"]!.user, 2);
});

const OMP_DESCRIPTORS = projectConfiguration({
	properties: {
		"omp.executablePath": { type: "string", default: "", scope: "machine", description: "The OMP to run." },
		"omp.other": { type: "string", default: "", description: "Another text setting." },
	},
});

function ompHarness(outcome: (path: string) => Promise<{ ok: boolean; message: string }>) {
	const writes: string[] = [];
	const tested: string[] = [];
	const port: DeskSettingsPort = {
		inspect: (): ConfigLayers => ({ defaultValue: "" }),
		effective: () => "",
		folderValues: () => [],
		async update(key) { writes.push(key); },
		workspace: () => ({ available: false, name: null }),
		async openSettingsEditor() {},
		async openSettingsJson() {},
		async testOmp(path) { tested.push(path); return outcome(path); },
	};
	return { writes, tested, controller: new DeskSettingsController(OMP_DESCRIPTORS, port, message => logs.push(message)) };
}

test("only the explicit OMP path row offers Test, and the row says so", () => {
	const rows = ompHarness(async () => ({ ok: true, message: "" })).controller.state().groups.flatMap(group => group.settings);
	assert.deepEqual(rows.map(row => [row.key, row.test === true]), [["omp.executablePath", true], ["omp.other", false]]);
});

test("Test hands the typed value to the host's resolution and reports its outcome, saving nothing", async () => {
	const h = ompHarness(async path => (path === "" ? { ok: true, message: "from PATH" } : { ok: false, message: `${path} is refused` }));
	const refused = await act(h.controller, { action: "test", key: "omp.executablePath", value: "C:\\bad\\omp.exe" });
	assert.deepEqual(refused, { type: "settings:test", requestId: refused!.requestId, key: "omp.executablePath", ok: false, message: "C:\\bad\\omp.exe is refused" });
	const onPath = await act(h.controller, { action: "test", key: "omp.executablePath", value: "" });
	assert.deepEqual(onPath, { type: "settings:test", requestId: onPath!.requestId, key: "omp.executablePath", ok: true, message: "from PATH" });
	assert.deepEqual(h.tested, ["C:\\bad\\omp.exe", ""]);
	assert.deepEqual(h.writes, [], "a Test never writes the setting");
});

test("Test refuses a setting that has none and a value that is not text, before resolving anything", async () => {
	const h = ompHarness(async () => ({ ok: true, message: "" }));
	const other = await act(h.controller, { action: "test", key: "omp.other", value: "x" });
	assert.equal(other?.type === "settings:test" && other.ok, false);
	const notText = await act(h.controller, { action: "test", key: "omp.executablePath", value: 5 });
	assert.equal(notText?.type === "settings:test" && notText.ok, false);
	assert.deepEqual(h.tested, []);
});

test("a Test whose resolution throws is reported on the row, not lost", async () => {
	const h = ompHarness(async () => { throw new Error("spawn exploded"); });
	const failed = await act(h.controller, { action: "test", key: "omp.executablePath", value: "C:\\x\\omp.exe" });
	assert.deepEqual(failed, { type: "settings:test", requestId: failed!.requestId, key: "omp.executablePath", ok: false, message: "spawn exploded" });
});
