/**
 * The move of the `omp.*` settings to `ompDesk.*` (ADR-0068): per layer, idempotence, an existing new value, a refused
 * write and several windows at once, against a fake that applies VS Code's own rules (measured in 1.141.0): a new key must be
 * contributed to be written, `application` and `machine` settings cannot be written at the Workspace layer, and a key that
 * is not contributed can still be inspected and removed. Runner: `node --test src/wiring/legacy-settings.test.ts`.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { LEGACY_SETTING_NAMES, SETTING_NAME_LISTS, migrateLegacySettings } from "./legacy-settings.ts";
import type { LayerValues, LegacySettingsPort, SettingsLayer } from "./legacy-settings.ts";

const manifest = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as {
	contributes: { configuration: { properties: Record<string, { scope?: string; included?: boolean; deprecationMessage?: string }> } };
};
const contributed = manifest.contributes.configuration.properties;

interface FakeOptions {
	readonly user?: Record<string, unknown>;
	readonly workspace?: Record<string, unknown>;
	/** Keys whose write (not removal) is refused with this message. */
	readonly refuse?: Record<string, string>;
	readonly readOnlyFile?: boolean;
	readonly file?: string | null;
	/** Old keys another extension contributes. */
	readonly foreign?: readonly string[];
}

/** One VS Code profile's settings layers, shared by every window that opens it. */
interface Store {
	readonly user: Map<string, unknown>;
	readonly workspace: Map<string, unknown>;
	readonly refuse: Record<string, string>;
	readonly readOnlyFile: boolean;
	readonly file: string | null;
	readonly foreign: Set<string>;
	readonly writes: { key: string; value: unknown; layer: SettingsLayer }[];
	/** The profile-wide claim on the User layer. */
	claimed: boolean;
	/** The holder of the claim never releases it. */
	stuck: boolean;
}

function store(options: FakeOptions = {}): Store {
	return {
		user: new Map(Object.entries(options.user ?? {})),
		workspace: new Map(Object.entries(options.workspace ?? {})),
		refuse: options.refuse ?? {},
		readOnlyFile: options.readOnlyFile ?? false,
		file: options.file === undefined ? "C:\\work\\.vscode\\settings.json" : options.file,
		foreign: new Set(options.foreign ?? []),
		writes: [] as { key: string; value: unknown; layer: SettingsLayer }[],
		claimed: false,
		stuck: false,
	};
}

function window(shared: Store): { port: LegacySettingsPort; lines: string[]; checkedFiles: string[] } {
	const lines: string[] = [];
	const checkedFiles: string[] = [];
	const layer = (name: SettingsLayer) => (name === "user" ? shared.user : shared.workspace);
	const port: LegacySettingsPort = {
		inspect: (key): LayerValues => ({ globalValue: shared.user.get(key), workspaceValue: shared.workspace.get(key) }),
		update: async (key, value, name) => {
			await Promise.resolve();
			if (value !== undefined) {
				if (contributed[key] === undefined && !SETTING_NAME_LISTS.includes(key)) throw new Error(`Unable to write to User Settings because ${key} is not a registered configuration.`);
				const scope = contributed[key]?.scope;
				if (name === "workspace" && (scope === "application" || scope === "machine")) throw new Error(`Unable to write ${key} to Workspace Settings. This setting can be written only into User settings.`);
				const refused = shared.refuse[key];
				if (refused !== undefined) throw new Error(refused);
			}
			shared.writes.push({ key, value, layer: name });
			if (value === undefined) layer(name).delete(key);
			else layer(name).set(key, value);
		},
		workspaceAllowed: key => {
			const scope = contributed[key]?.scope;
			return scope !== "application" && scope !== "machine" && scope !== "machine-overridable";
		},
		workspaceSettingsFile: () => shared.file,
		isWritable: async file => { checkedFiles.push(file); return !shared.readOnlyFile; },
		foreignSettings: shared.foreign,
		claimUserLayer: async () => {
			if (shared.claimed) return null;
			shared.claimed = true;
			return { release: async () => { shared.claimed = false; } };
		},
		// A holder that never lets go is `stuck`; otherwise the wait ends the moment the holder released.
		waitForRelease: async () => {
			if (shared.stuck) return false;
			while (shared.claimed) await Promise.resolve();
			return true;
		},
		delay: () => Promise.resolve(),
		waits: { releaseMs: 500, graceMs: 50, graceStepMs: 5 },
		log: line => lines.push(line),
	};
	return { port, lines, checkedFiles };
}

const PROFILE_VALUES: Record<string, unknown> = {
	"omp.toolCallDetail": "detailed", "omp.desktopNotifications": false, "omp.showWorkspaceFolders": false, "omp.useAgentRootFolder": false,
	"omp.launchInFolderWindow": false, "omp.sessionsGrouping": "folders", "omp.chatColumn": false, "omp.linkCodeSymbols": false,
	"omp.linkReminder": true, "omp.executablePath": "C:\\bin\\omp.exe", "omp.agentDebugger.enabled": false, "omp.agentDebugger.start": "allow",
	"omp.agentDebugger.expressions": "off",
};

describe("the table", () => {
	it("holds the thirteen settings of 0.3.x, each contributed under ompDesk. and kept as a hidden, deprecated key of the same scope under omp.", () => {
		assert.equal(LEGACY_SETTING_NAMES.length, 13);
		assert.deepEqual(LEGACY_SETTING_NAMES.filter(name => contributed[`ompDesk.${name}`] === undefined), [], "a successor that is not contributed cannot be written");
		const notDeprecated = LEGACY_SETTING_NAMES.filter(name => {
			const old = contributed[`omp.${name}`];
			return old === undefined || old.included !== false || !(old.deprecationMessage ?? "").includes(`ompDesk.${name}`) || old.scope !== contributed[`ompDesk.${name}`]?.scope;
		});
		assert.deepEqual(notDeprecated, [], "an old key that is missing, shown, not pointing at its successor or of another scope: VS Code would stop routing and syncing it as before");
		assert.deepEqual(Object.keys(PROFILE_VALUES).map(key => key.slice(4)).sort(), [...LEGACY_SETTING_NAMES].sort());
	});
});

describe("the User layer", () => {
	it("moves every old value to its successor, removes the old key and says so once per key", async () => {
		const shared = store({ user: { ...PROFILE_VALUES, "editor.fontSize": 14 } });
		const { port, lines } = window(shared);
		const outcomes = await migrateLegacySettings(port);
		for (const [key, value] of Object.entries(PROFILE_VALUES)) {
			assert.equal(shared.user.get(`ompDesk.${key.slice(4)}`), value, key);
			assert.equal(shared.user.has(key), false, `${key} removed`);
		}
		assert.equal(shared.user.get("editor.fontSize"), 14, "another setting is not touched");
		assert.equal(outcomes.length, 13);
		assert.ok(outcomes.every(outcome => outcome.outcome === "moved" && outcome.layer === "user"));
		assert.equal(lines.length, 13);
		assert.ok(lines.includes("settings: omp.sessionsGrouping → ompDesk.sessionsGrouping (user settings): moved"), "the Sessions layout setting is mapped, not dropped");
		assert.ok(lines.every(line => !line.includes("folders") && !line.includes("C:\\bin")), "a moved value is not logged");
	});

	it("writes the new key before it removes the old one", async () => {
		const shared = store({ user: { "omp.chatColumn": false } });
		await migrateLegacySettings(window(shared).port);
		assert.deepEqual(shared.writes, [
			{ key: "ompDesk.chatColumn", value: false, layer: "user" },
			{ key: "omp.chatColumn", value: undefined, layer: "user" },
		]);
	});

	it("is idempotent: a second pass finds nothing, writes nothing and logs nothing", async () => {
		const shared = store({ user: { ...PROFILE_VALUES } });
		await migrateLegacySettings(window(shared).port);
		const writes = shared.writes.length;
		const again = window(shared);
		assert.deepEqual(await migrateLegacySettings(again.port), []);
		assert.equal(shared.writes.length, writes);
		assert.deepEqual(again.lines, []);
		assert.deepEqual(again.checkedFiles, []);
	});

	it("moves a value that shows up later, such as one synced from a machine on an earlier release", async () => {
		const shared = store();
		await migrateLegacySettings(window(shared).port);
		shared.user.set("omp.linkReminder", true);
		await migrateLegacySettings(window(shared).port);
		assert.equal(shared.user.get("ompDesk.linkReminder"), true);
		assert.equal(shared.user.has("omp.linkReminder"), false);
	});

	it("keeps a value the user already set on the new key, removes the old one and names the dropped value", async () => {
		const shared = store({ user: { "omp.toolCallDetail": "detailed", "ompDesk.toolCallDetail": "overview" } });
		const { port, lines } = window(shared);
		const outcomes = await migrateLegacySettings(port);
		assert.equal(shared.user.get("ompDesk.toolCallDetail"), "overview");
		assert.equal(shared.user.has("omp.toolCallDetail"), false);
		assert.deepEqual(outcomes, [{ key: "omp.toolCallDetail", layer: "user", outcome: "conflict-dropped" }]);
		assert.deepEqual(lines, ['settings: omp.toolCallDetail → ompDesk.toolCallDetail (user settings): the new key already holds "overview"; the old value "detailed" was dropped']);
	});

	it("only removes the old key when the new one already holds the same value (an interrupted earlier pass)", async () => {
		const shared = store({ user: { "omp.chatColumn": false, "ompDesk.chatColumn": false } });
		const outcomes = await migrateLegacySettings(window(shared).port);
		assert.deepEqual(outcomes.map(outcome => outcome.outcome), ["already-set"]);
		assert.deepEqual(shared.writes, [{ key: "omp.chatColumn", value: undefined, layer: "user" }]);
	});

	it("leaves the old value and logs the reason when the new key cannot be written, and goes on with the next key", async () => {
		const shared = store({
			user: { "omp.chatColumn": false, "omp.linkReminder": true },
			refuse: { "ompDesk.chatColumn": "Error while writing to User Settings. Unable to write file 'settings.json' (EntryWriteLocked)" },
		});
		const { port, lines } = window(shared);
		await migrateLegacySettings(port);
		assert.equal(shared.user.get("omp.chatColumn"), false, "the old value stays");
		assert.equal(shared.user.has("ompDesk.chatColumn"), false);
		assert.equal(shared.user.get("ompDesk.linkReminder"), true, "the next key still moves");
		assert.equal(lines.length, 2);
		assert.ok(lines.some(line => /^settings: omp\.chatColumn → ompDesk\.chatColumn \(user settings\): left, the step failed: Error while writing to User Settings/.test(line)), lines.join("\n"));
	});

	it("does not remove the old value when only the removal fails, and finishes it on the next pass", async () => {
		const shared = store({ user: { "omp.chatColumn": false } });
		const { port } = window(shared);
		let failRemoval = true;
		const update = port.update.bind(port);
		port.update = async (key, value, layer) => {
			if (failRemoval && value === undefined) throw new Error("locked");
			await update(key, value, layer);
		};
		const first = await migrateLegacySettings(port);
		assert.deepEqual(first.map(outcome => outcome.outcome), ["left"]);
		assert.equal(shared.user.get("ompDesk.chatColumn"), false);
		assert.equal(shared.user.get("omp.chatColumn"), false);
		failRemoval = false;
		const second = await migrateLegacySettings(port);
		assert.deepEqual(second.map(outcome => outcome.outcome), ["already-set"]);
		assert.equal(shared.user.has("omp.chatColumn"), false);
	});

	it("survives an inspect that throws for one key", async () => {
		const shared = store({ user: { "omp.linkReminder": true } });
		const { port, lines } = window(shared);
		const inspect = port.inspect.bind(port);
		port.inspect = key => { if (key === "omp.chatColumn") throw new Error("boom"); return inspect(key); };
		await migrateLegacySettings(port);
		assert.equal(shared.user.get("ompDesk.linkReminder"), true);
		assert.ok(lines.some(line => line.includes("omp.chatColumn") && line.includes("boom")));
	});
});

describe("the Workspace layer", () => {
	it("moves a window-scoped value that sits in the workspace settings and leaves the User layer's own", async () => {
		const shared = store({ user: { "omp.chatColumn": true }, workspace: { "omp.chatColumn": false, "omp.linkReminder": true } });
		const { port, lines, checkedFiles } = window(shared);
		const outcomes = await migrateLegacySettings(port);
		assert.equal(shared.workspace.get("ompDesk.chatColumn"), false);
		assert.equal(shared.user.get("ompDesk.chatColumn"), true);
		assert.equal(shared.workspace.get("ompDesk.linkReminder"), true);
		assert.equal(shared.workspace.size, 2);
		assert.equal(shared.user.size, 1);
		assert.deepEqual(outcomes.map(outcome => `${outcome.key}:${outcome.layer}:${outcome.outcome}`).sort(), [
			"omp.chatColumn:user:moved", "omp.chatColumn:workspace:moved", "omp.linkReminder:workspace:moved",
		]);
		assert.ok(lines.includes("settings: omp.linkReminder → ompDesk.linkReminder (workspace settings): moved"));
		assert.deepEqual(checkedFiles, ["C:\\work\\.vscode\\settings.json", "C:\\work\\.vscode\\settings.json"]);
	});

	it("leaves an application- or machine-scoped old value where VS Code never applied it, and says so every pass", async () => {
		const shared = store({ workspace: { "omp.toolCallDetail": "detailed", "omp.executablePath": "C:\\x\\omp.exe" } });
		const { port, lines } = window(shared);
		const outcomes = await migrateLegacySettings(port);
		assert.deepEqual(outcomes.map(outcome => outcome.outcome), ["left", "left"]);
		assert.deepEqual(shared.writes, []);
		assert.equal(shared.workspace.get("omp.toolCallDetail"), "detailed");
		assert.equal(lines.length, 2);
		assert.match(lines[0] ?? "", /omp\.toolCallDetail → ompDesk\.toolCallDetail \(workspace settings\): left; this setting is read from user settings only/);
	});

	it("does not write a read-only workspace settings file and keeps the old value", async () => {
		const shared = store({ user: { "omp.linkReminder": true }, workspace: { "omp.chatColumn": false }, readOnlyFile: true });
		const { port, lines } = window(shared);
		const outcomes = await migrateLegacySettings(port);
		assert.deepEqual(shared.writes.map(write => write.layer), ["user", "user"], "only the User layer was written");
		assert.equal(shared.workspace.get("omp.chatColumn"), false);
		assert.equal(shared.workspace.has("ompDesk.chatColumn"), false);
		assert.deepEqual(outcomes.filter(outcome => outcome.layer === "workspace"), [{ key: "omp.chatColumn", layer: "workspace", outcome: "left" }]);
		assert.ok(lines.includes("settings: omp.chatColumn → ompDesk.chatColumn (workspace settings): left; the file is read-only"));
	});

	it("logs and keeps the old value when VS Code refuses the write (a lock, a permission the attribute does not show)", async () => {
		const shared = store({ workspace: { "omp.chatColumn": false }, refuse: { "ompDesk.chatColumn": "Unable to write file (EPERM)" } });
		const { port, lines } = window(shared);
		await migrateLegacySettings(port);
		assert.equal(shared.workspace.get("omp.chatColumn"), false);
		assert.equal(shared.workspace.has("ompDesk.chatColumn"), false);
		assert.match(lines[0] ?? "", /\(workspace settings\): left, the step failed: Unable to write file \(EPERM\)/);
	});

	it("asks no file when the workspace has no settings file on disk, and still moves the value", async () => {
		const shared = store({ workspace: { "omp.chatColumn": false }, file: null });
		const { port, checkedFiles } = window(shared);
		await migrateLegacySettings(port);
		assert.deepEqual(checkedFiles, []);
		assert.equal(shared.workspace.get("ompDesk.chatColumn"), false);
	});
});

describe("several windows of one profile activating together", () => {
	it("converge on the same final settings, whatever the interleaving", async () => {
		const shared = store({ user: { ...PROFILE_VALUES }, workspace: { "omp.chatColumn": false } });
		await Promise.all([1, 2, 3].map(() => migrateLegacySettings(window(shared).port)));
		for (const [key, value] of Object.entries(PROFILE_VALUES)) {
			assert.equal(shared.user.get(`ompDesk.${key.slice(4)}`), value, key);
			assert.equal(shared.user.has(key), false, key);
		}
		assert.equal(shared.workspace.get("ompDesk.chatColumn"), false);
		assert.equal(shared.workspace.has("omp.chatColumn"), false);
		const after = window(shared);
		assert.deepEqual(await migrateLegacySettings(after.port), []);
	});

	it("move the User layer once between them: 26 writes for 13 keys, not 78, and the others log that they waited", async () => {
		const shared = store({ user: { ...PROFILE_VALUES } });
		const windows = [1, 2, 3].map(() => window(shared));
		await Promise.all(windows.map(({ port }) => migrateLegacySettings(port)));
		assert.equal(shared.writes.filter(write => write.layer === "user").length, 26);
		const waited = windows.filter(({ lines }) => lines.some(line => line.includes("another window is moving the user settings")));
		assert.equal(waited.length, 2);
		assert.equal(shared.claimed, false, "the claim is released");
		for (const [key, value] of Object.entries(PROFILE_VALUES)) assert.equal(shared.user.get(`ompDesk.${key.slice(4)}`), value, key);
	});

	it("take over when the window that held the claim let go without moving anything", async () => {
		const shared = store({ user: { "omp.chatColumn": false } });
		shared.claimed = true;
		const { port } = window(shared);
		port.waitForRelease = async () => { shared.claimed = false; return true; };
		await migrateLegacySettings(port);
		assert.equal(shared.user.get("ompDesk.chatColumn"), false);
		assert.equal(shared.user.has("omp.chatColumn"), false);
	});

	it("leave the User layer alone, and say so, while the other window's claim never ends", async () => {
		const shared = store({ user: { "omp.chatColumn": false }, workspace: { "omp.linkReminder": true } });
		shared.claimed = true;
		shared.stuck = true;
		const { port, lines } = window(shared);
		await migrateLegacySettings(port);
		assert.equal(shared.user.get("omp.chatColumn"), false);
		assert.ok(lines.some(line => line.includes("still running after")), lines.join("\n"));
		assert.equal(shared.workspace.get("ompDesk.linkReminder"), true, "the window's own workspace layer does not wait for another window");
	});
});

describe("the cost of a window", () => {
	it("with nothing to move is synchronous reads: no claim, no write, no wait", async () => {
		const shared = store({ user: { "editor.fontSize": 14, "ompDesk.chatColumn": false } });
		const { port, lines } = window(shared);
		let claims = 0;
		const claim = port.claimUserLayer.bind(port);
		port.claimUserLayer = () => { claims += 1; return claim(); };
		assert.deepEqual(await migrateLegacySettings(port), []);
		assert.equal(claims, 0);
		assert.deepEqual(shared.writes, []);
		assert.deepEqual(lines, []);
	});

	it("moves the keys of a layer concurrently, so the reloads VS Code runs after each write overlap", async () => {
		const shared = store({ user: { ...PROFILE_VALUES } });
		const { port } = window(shared);
		const update = port.update.bind(port);
		let inFlight = 0;
		let peak = 0;
		port.update = async (key, value, layer) => {
			inFlight += 1;
			peak = Math.max(peak, inFlight);
			try { await update(key, value, layer); } finally { inFlight -= 1; }
		};
		await migrateLegacySettings(port);
		assert.ok(peak >= 13, `at most ${peak} writes were in flight`);
		for (const key of Object.keys(PROFILE_VALUES)) assert.equal(shared.user.has(key), false, key);
	});
});

describe("the lists of setting names", () => {
	it("add the new name next to every old one before any value moves, and keep the old entries", async () => {
		const shared = store({
			user: {
				"omp.executablePath": "C:\\bin\\omp.exe",
				"settingsSync.ignoredSettings": ["editor.fontSize", "omp.executablePath", "omp.chatColumn", "ompDesk.chatColumn"],
				"workbench.settings.applyToAllProfiles": ["omp.toolCallDetail"],
			},
		});
		const { port, lines } = window(shared);
		const outcomes = await migrateLegacySettings(port);
		assert.deepEqual(shared.user.get("settingsSync.ignoredSettings"), ["editor.fontSize", "omp.executablePath", "omp.chatColumn", "ompDesk.chatColumn", "ompDesk.executablePath"]);
		assert.deepEqual(shared.user.get("workbench.settings.applyToAllProfiles"), ["omp.toolCallDetail", "ompDesk.toolCallDetail"]);
		assert.deepEqual(outcomes.filter(outcome => outcome.outcome === "listed").map(outcome => outcome.key), ["settingsSync.ignoredSettings", "workbench.settings.applyToAllProfiles"]);
		const listWrites = shared.writes.map(write => write.key);
		assert.ok(listWrites.indexOf("workbench.settings.applyToAllProfiles") < listWrites.indexOf("ompDesk.executablePath"), "the lists are written before the first value moves");
		assert.ok(lines.some(line => line.startsWith("settings: settingsSync.ignoredSettings: added ompDesk.executablePath")));
		assert.equal(shared.user.get("ompDesk.executablePath"), "C:\\bin\\omp.exe");
	});

	it("write nothing when a list holds no old name or already holds the new one", async () => {
		const shared = store({ user: { "settingsSync.ignoredSettings": ["editor.fontSize", "omp.other"], "workbench.settings.applyToAllProfiles": ["omp.chatColumn", "ompDesk.chatColumn"] } });
		assert.deepEqual(await migrateLegacySettings(window(shared).port), []);
		assert.deepEqual(shared.writes, []);
	});
});

describe("a key another extension contributes under omp.", () => {
	it("is neither read nor removed, and a list entry naming it is not mirrored", async () => {
		const shared = store({
			user: { "omp.executablePath": "theirs", "omp.chatColumn": false, "settingsSync.ignoredSettings": ["omp.executablePath", "omp.chatColumn"] },
			foreign: ["omp.executablePath"],
		});
		const { port, lines } = window(shared);
		await migrateLegacySettings(port);
		assert.equal(shared.user.get("omp.executablePath"), "theirs", "the other extension's value stays");
		assert.equal(shared.user.has("ompDesk.executablePath"), false);
		assert.equal(shared.user.get("ompDesk.chatColumn"), false, "our own key still moves");
		assert.deepEqual(shared.user.get("settingsSync.ignoredSettings"), ["omp.executablePath", "omp.chatColumn", "ompDesk.chatColumn"]);
		assert.ok(lines.includes("settings: omp.executablePath → ompDesk.executablePath (user settings): left; another extension contributes omp.executablePath"));
	});
});
