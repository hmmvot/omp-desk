/**
 * The carry-over of `ompDesk.useAgentRootFolder` and `ompDesk.ompSettings.useNearestAncestorOmpFolder` (ADR-0073), against a fake that
 * applies VS Code's own rules as `legacy-settings.test.ts` does: a new key must be contributed to be written, `application` settings
 * cannot be written at the Workspace layer, and a key can be removed. Runner: `node --test src/wiring/session-folder-settings.test.ts`.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { migrateLegacySettings } from "./legacy-settings.ts";
import type { LayerValues, LegacySettingsPort, SettingsLayer } from "./legacy-settings.ts";
import { OLD_AGENT_ROOT_KEY, OLD_ANCESTOR_KEY, RUN_AT_ROOT_KEY, migrateSessionFolderSettings } from "./session-folder-settings.ts";

const manifest = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as {
	contributes: { configuration: { properties: Record<string, { scope?: string; default?: unknown; included?: boolean; deprecationMessage?: string }> } };
};
const contributed = manifest.contributes.configuration.properties;

interface Shared {
	readonly user: Map<string, unknown>;
	readonly workspace: Map<string, unknown>;
	readonly writes: { key: string; value: unknown; layer: SettingsLayer }[];
	readOnlyFile: boolean;
	claimed: boolean;
	refuse: Record<string, string>;
}

function shared(user: Record<string, unknown> = {}, workspace: Record<string, unknown> = {}): Shared {
	return { user: new Map(Object.entries(user)), workspace: new Map(Object.entries(workspace)), writes: [], readOnlyFile: false, claimed: false, refuse: {} };
}

function window(state: Shared): { port: LegacySettingsPort; lines: string[]; checkedFiles: string[] } {
	const lines: string[] = [];
	const checkedFiles: string[] = [];
	const layer = (name: SettingsLayer) => (name === "user" ? state.user : state.workspace);
	const port: LegacySettingsPort = {
		inspect: (key): LayerValues => ({ globalValue: state.user.get(key), workspaceValue: state.workspace.get(key) }),
		update: async (key, value, name) => {
			await Promise.resolve();
			if (value !== undefined) {
				if (contributed[key] === undefined) throw new Error(`Unable to write to User Settings because ${key} is not a registered configuration.`);
				if (name === "workspace" && contributed[key]?.scope === "application") throw new Error(`Unable to write ${key} to Workspace Settings. This setting can be written only into User settings.`);
				const refused = state.refuse[key];
				if (refused !== undefined) throw new Error(refused);
			}
			state.writes.push({ key, value, layer: name });
			if (value === undefined) layer(name).delete(key);
			else layer(name).set(key, value);
		},
		workspaceAllowed: key => contributed[key]?.scope !== "application",
		workspaceSettingsFile: () => "C:\\work\\.vscode\\settings.json",
		isWritable: async file => { checkedFiles.push(file); return !state.readOnlyFile; },
		foreignSettings: new Set(),
		claimUserLayer: async () => {
			if (state.claimed) return null;
			state.claimed = true;
			return { release: async () => { state.claimed = false; } };
		},
		waitForRelease: async () => { while (state.claimed) await Promise.resolve(); return true; },
		delay: () => Promise.resolve(),
		waits: { releaseMs: 500, graceMs: 50, graceStepMs: 5 },
		log: line => lines.push(line),
	};
	return { port, lines, checkedFiles };
}

describe("the manifest", () => {
	it("contributes the new setting as a resource setting that is on by default, and keeps both old keys hidden and deprecated with their scopes", () => {
		assert.deepEqual([contributed[RUN_AT_ROOT_KEY]?.scope, contributed[RUN_AT_ROOT_KEY]?.default, contributed[RUN_AT_ROOT_KEY]?.included], ["resource", true, undefined]);
		assert.deepEqual([contributed[OLD_AGENT_ROOT_KEY]?.scope, contributed[OLD_AGENT_ROOT_KEY]?.included], ["application", false]);
		assert.deepEqual([contributed[OLD_ANCESTOR_KEY]?.scope, contributed[OLD_ANCESTOR_KEY]?.included], ["resource", false]);
		assert.ok((contributed[OLD_AGENT_ROOT_KEY]?.deprecationMessage ?? "").includes(RUN_AT_ROOT_KEY));
		assert.ok((contributed[OLD_ANCESTOR_KEY]?.deprecationMessage ?? "").includes(RUN_AT_ROOT_KEY));
	});
});

describe("the move to ompDesk.runSessionsAtRepositoryRoot", () => {
	it("carries an explicit useAgentRootFolder=false over to the new key, removes the old one and says so in one line", async () => {
		const state = shared({ [OLD_AGENT_ROOT_KEY]: false });
		const { port, lines } = window(state);
		const outcomes = await migrateSessionFolderSettings(port);
		assert.equal(state.user.get(RUN_AT_ROOT_KEY), false);
		assert.equal(state.user.has(OLD_AGENT_ROOT_KEY), false);
		assert.deepEqual(outcomes, [{ key: OLD_AGENT_ROOT_KEY, layer: "user", outcome: "moved" }]);
		assert.deepEqual(state.writes, [{ key: RUN_AT_ROOT_KEY, value: false, layer: "user" }, { key: OLD_AGENT_ROOT_KEY, value: undefined, layer: "user" }]);
		assert.deepEqual(lines, ["settings: ompDesk.useAgentRootFolder → ompDesk.runSessionsAtRepositoryRoot (user settings): moved"]);
	});

	it("removes an explicit useAgentRootFolder=true without a successor: it is what the new default does", async () => {
		const state = shared({ [OLD_AGENT_ROOT_KEY]: true });
		const { port, lines } = window(state);
		assert.deepEqual(await migrateSessionFolderSettings(port), [{ key: OLD_AGENT_ROOT_KEY, layer: "user", outcome: "dropped" }]);
		assert.equal(state.user.has(RUN_AT_ROOT_KEY), false);
		assert.equal(state.user.has(OLD_AGENT_ROOT_KEY), false);
		assert.equal(lines.length, 1);
		assert.match(lines[0]!, /dropped; true is what sessions do by default now/);
	});

	it("drops an explicit useNearestAncestorOmpFolder at the user and workspace layers, because the editors now follow sessions", async () => {
		const state = shared({ [OLD_ANCESTOR_KEY]: true }, { [OLD_ANCESTOR_KEY]: false });
		const { port, lines, checkedFiles } = window(state);
		const outcomes = await migrateSessionFolderSettings(port);
		assert.deepEqual(outcomes.map(outcome => [outcome.key, outcome.layer, outcome.outcome]), [[OLD_ANCESTOR_KEY, "user", "dropped"], [OLD_ANCESTOR_KEY, "workspace", "dropped"]]);
		assert.equal(state.user.size + state.workspace.size, 0);
		assert.equal(state.user.has(RUN_AT_ROOT_KEY), false, "no successor");
		assert.equal(lines.length, 2);
		assert.ok(lines.some(line => /\(user settings\): dropped \(it held true\); the Settings, Models and Agents editors now use the folder sessions run in/.test(line)), lines.join("\n"));
		assert.deepEqual(checkedFiles, ["C:\\work\\.vscode\\settings.json"], "the workspace file is checked before it is written");
	});

	it("keeps an existing new value and logs the old one it dropped", async () => {
		const state = shared({ [OLD_AGENT_ROOT_KEY]: false, [RUN_AT_ROOT_KEY]: true });
		const { port, lines } = window(state);
		assert.deepEqual((await migrateSessionFolderSettings(port)).map(outcome => outcome.outcome), ["conflict-dropped"]);
		assert.equal(state.user.get(RUN_AT_ROOT_KEY), true);
		assert.equal(state.user.has(OLD_AGENT_ROOT_KEY), false);
		assert.match(lines[0]!, /the new key already holds true; the old value false was dropped/);
		const same = shared({ [OLD_AGENT_ROOT_KEY]: false, [RUN_AT_ROOT_KEY]: false });
		assert.deepEqual((await migrateSessionFolderSettings(window(same).port)).map(outcome => outcome.outcome), ["already-set"]);
		assert.deepEqual(same.writes, [{ key: OLD_AGENT_ROOT_KEY, value: undefined, layer: "user" }]);
	});

	it("does nothing, writes nothing, logs nothing and touches no file when there is nothing to move", async () => {
		const state = shared({ "editor.fontSize": 14, [RUN_AT_ROOT_KEY]: false });
		const { port, lines, checkedFiles } = window(state);
		assert.deepEqual(await migrateSessionFolderSettings(port), []);
		assert.deepEqual([state.writes, lines, checkedFiles], [[], [], []]);
		assert.equal(state.user.get(RUN_AT_ROOT_KEY), false, "a new value is never touched");
	});

	it("moves once: a second activation finds nothing", async () => {
		const state = shared({ [OLD_AGENT_ROOT_KEY]: false, [OLD_ANCESTOR_KEY]: true });
		await migrateSessionFolderSettings(window(state).port);
		const writes = state.writes.length;
		const again = window(state);
		assert.deepEqual(await migrateSessionFolderSettings(again.port), []);
		assert.equal(state.writes.length, writes);
		assert.deepEqual(again.lines, []);
	});

	it("leaves an application-scoped old value at the workspace layer alone and unlogged: it was never read there", async () => {
		const state = shared({}, { [OLD_AGENT_ROOT_KEY]: false });
		const { port, lines } = window(state);
		assert.deepEqual(await migrateSessionFolderSettings(port), []);
		assert.deepEqual([state.writes, lines], [[], []]);
	});

	it("does not write a read-only workspace settings file", async () => {
		const state = shared({}, { [OLD_ANCESTOR_KEY]: true });
		state.readOnlyFile = true;
		const { port, lines } = window(state);
		assert.deepEqual((await migrateSessionFolderSettings(port)).map(outcome => outcome.outcome), ["left"]);
		assert.equal(state.workspace.get(OLD_ANCESTOR_KEY), true);
		assert.deepEqual(state.writes, []);
		assert.match(lines[0]!, /\(workspace settings\): left; the file is read-only/);
	});

	it("logs a refused write and still runs the other key", async () => {
		const state = shared({ [OLD_AGENT_ROOT_KEY]: false, [OLD_ANCESTOR_KEY]: true });
		state.refuse[RUN_AT_ROOT_KEY] = "Unable to write file (EPERM)";
		const { port, lines } = window(state);
		const outcomes = await migrateSessionFolderSettings(port);
		assert.deepEqual(outcomes.map(outcome => [outcome.key, outcome.outcome]), [[OLD_AGENT_ROOT_KEY, "left"], [OLD_ANCESTOR_KEY, "dropped"]]);
		assert.equal(state.user.get(OLD_AGENT_ROOT_KEY), false, "the old value stays for the next activation");
		assert.equal(state.user.has(OLD_ANCESTOR_KEY), false);
		assert.ok(lines.some(line => line.includes("left, the step failed: Unable to write file (EPERM)")));
	});

	it("is moved by one window of the profile at a time", async () => {
		const state = shared({ [OLD_AGENT_ROOT_KEY]: false });
		const first = window(state);
		const second = window(state);
		await Promise.all([migrateSessionFolderSettings(first.port), migrateSessionFolderSettings(second.port)]);
		assert.equal(state.user.get(RUN_AT_ROOT_KEY), false);
		assert.equal(state.user.has(OLD_AGENT_ROOT_KEY), false);
		assert.equal(state.writes.filter(write => write.key === RUN_AT_ROOT_KEY).length, 1, "the window that waited found the value moved");
	});

	it("follows the omp.* → ompDesk.* move: an old omp.useAgentRootFolder=false reaches the new key in one activation", async () => {
		const state = shared({ "omp.useAgentRootFolder": false });
		const { port } = window(state);
		await migrateLegacySettings(port);
		assert.equal(state.user.get(OLD_AGENT_ROOT_KEY), false);
		await migrateSessionFolderSettings(port);
		assert.equal(state.user.get(RUN_AT_ROOT_KEY), false);
		assert.equal(state.user.has(OLD_AGENT_ROOT_KEY), false);
		assert.equal(state.user.has("omp.useAgentRootFolder"), false);
	});
});
