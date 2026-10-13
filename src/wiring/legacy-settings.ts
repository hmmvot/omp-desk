/**
 * OMP Desk — the settings the `omp.` namespace used to hold, moved to `ompDesk.` (ADR-0068).
 *
 * Every activation inspects the thirteen old keys. A key that holds a value is moved to its
 * `ompDesk.` successor at the same layer and then removed; a window with nothing to move does
 * no I/O. No marker is kept, so a value that appears later (a Settings Sync pull from a
 * machine on an earlier release, a hand edit) is moved by the next activation.
 *
 * ## Rules
 *
 * - **The old keys stay contributed.** Marked deprecated and hidden from the Settings editor
 *   (`package.json`), with the scope they had in 0.3.2. That keeps VS Code reading, routing and
 *   syncing them as before: an application-scoped value lives in the default profile's file and
 *   is only visible to a window of another profile while its key is registered, and a machine
 *   setting stays out of Settings Sync.
 * - **Layers.** User and Workspace. The Workspace-folder layer cannot hold any of these
 *   settings (none is resource-scoped) and a `[language]` override of one never applied,
 *   because Desk reads its settings without a language and VS Code cannot write such an
 *   override to a key that is not language-overridable; both are left alone. In a
 *   single-folder window the folder layer is the Workspace layer's own file.
 * - **A layer that cannot hold the new key.** An `application` or `machine` setting cannot
 *   be written at the Workspace layer, so an old value there was already ignored. It is left
 *   in place and one line says so.
 * - **Order.** First the two lists that name settings (`settingsSync.ignoredSettings` and
 *   `workbench.settings.applyToAllProfiles`) gain the new name of every old name they hold, so
 *   a value is never exposed to Settings Sync or another profile under a name that is not
 *   listed; the old entries stay. Then, per key, write the new key, then remove the old one. A
 *   crash between the two leaves both, and the next activation finds the new value set and only
 *   removes the old one.
 * - **An existing new value wins.** The old value is removed and its removal is logged with
 *   the value, so a hand merge is possible.
 * - **Another extension's name.** A key another installed extension contributes under `omp.`
 *   is not ours to read or remove: it is skipped, with one line.
 * - **Unwritable.** A Workspace settings file with the read-only attribute is not written at
 *   all (a failed VS Code write leaves a dirty editor model of that file); any other failed
 *   write is caught per key. The old value stays, and one line names the key, the layer and
 *   the reason.
 * - **Several windows.** Windows derive the same new value from the same old one and a second
 *   write of an equal value changes nothing; a write that loses a file race fails inside VS
 *   Code, is logged and is retried by the next activation. A window that still runs the
 *   previous release reads the defaults for a moved key until it reloads.
 */
import { isDeepStrictEqual } from "node:util";

/** The thirteen settings of 0.3.x, without prefix: `omp.<name>` became `ompDesk.<name>`. */
export const LEGACY_SETTING_NAMES: readonly string[] = [
	"toolCallDetail", "desktopNotifications", "showWorkspaceFolders", "useAgentRootFolder", "launchInFolderWindow",
	"sessionsGrouping", "chatColumn", "linkCodeSymbols", "linkReminder", "executablePath",
	"agentDebugger.enabled", "agentDebugger.start", "agentDebugger.expressions",
];

/** The settings that hold names of other settings; an old name in one is joined by its new name. */
export const SETTING_NAME_LISTS: readonly string[] = ["settingsSync.ignoredSettings", "workbench.settings.applyToAllProfiles"];

export type SettingsLayer = "user" | "workspace";

export interface LayerValues {
	readonly globalValue?: unknown;
	readonly workspaceValue?: unknown;
}

export interface LegacySettingsPort {
	/** `getConfiguration().inspect(key)`; works for keys no extension contributes. */
	inspect(key: string): LayerValues | undefined;
	/** Write `value` to `key` in one layer, or remove the key when `value` is `undefined`. Rejects when VS Code refuses. */
	update(key: string, value: unknown, layer: SettingsLayer): PromiseLike<void>;
	/** Whether the contributed setting can hold a value in a workspace (its scope is not `application` or `machine`). */
	workspaceAllowed(key: string): boolean;
	/** The file behind the Workspace layer when it is a file on disk, or `null`. */
	workspaceSettingsFile(): string | null;
	/** `false` only when the file is known to refuse writes (the read-only attribute); a missing file is writable. */
	isWritable(file: string): PromiseLike<boolean>;
	/** Setting ids another installed extension contributes under `omp.`. */
	foreignSettings: ReadonlySet<string>;
	log(line: string): void;
}

/** What happened to one key at one layer. */
export interface MigrationOutcome {
	readonly key: string;
	readonly layer: SettingsLayer;
	readonly outcome: "moved" | "already-set" | "conflict-dropped" | "left" | "listed";
}

const LAYER_WORDS: Record<SettingsLayer, string> = { user: "user settings", workspace: "workspace settings" };

function describe(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim();
}

/**
 * Move every old setting that holds a value. Never throws: a failure of one key is logged and
 * the next key still runs.
 */
export async function migrateLegacySettings(port: LegacySettingsPort): Promise<readonly MigrationOutcome[]> {
	const outcomes: MigrationOutcome[] = [];
	for (const list of SETTING_NAME_LISTS) {
		try {
			outcomes.push(...(await extendNameList(port, list)));
		} catch (error) {
			port.log(`settings: ${list}: the new names were not added, the step failed: ${describe(error)}`);
		}
	}
	for (const name of LEGACY_SETTING_NAMES) {
		const oldKey = `omp.${name}`;
		const newKey = `ompDesk.${name}`;
		for (const layer of ["user", "workspace"] as const) {
			try {
				if (port.foreignSettings.has(oldKey)) {
					if (valueAt(port.inspect(oldKey), layer) !== undefined) port.log(`settings: ${oldKey} → ${newKey} (${LAYER_WORDS[layer]}): left; another extension contributes ${oldKey}`);
					continue;
				}
				const outcome = await migrateKey(port, oldKey, newKey, layer);
				if (outcome !== null) outcomes.push({ key: oldKey, layer, outcome });
			} catch (error) {
				port.log(`settings: ${oldKey} → ${newKey} (${LAYER_WORDS[layer]}): left, the step failed: ${describe(error)}`);
				outcomes.push({ key: oldKey, layer, outcome: "left" });
			}
		}
	}
	return outcomes;
}

function valueAt(values: LayerValues | undefined, layer: SettingsLayer): unknown {
	return layer === "user" ? values?.globalValue : values?.workspaceValue;
}

/** Add `ompDesk.<name>` next to every `omp.<name>` a list of setting names holds (User layer; the old entries stay). */
async function extendNameList(port: LegacySettingsPort, list: string): Promise<MigrationOutcome[]> {
	const current = valueAt(port.inspect(list), "user");
	if (!Array.isArray(current)) return [];
	const missing: string[] = [];
	for (const name of LEGACY_SETTING_NAMES) {
		if (current.includes(`omp.${name}`) && !current.includes(`ompDesk.${name}`) && !port.foreignSettings.has(`omp.${name}`)) missing.push(`ompDesk.${name}`);
	}
	if (missing.length === 0) return [];
	await port.update(list, [...current, ...missing], "user");
	port.log(`settings: ${list}: added ${missing.join(", ")} next to the old names it holds`);
	return [{ key: list, layer: "user", outcome: "listed" }];
}

async function migrateKey(port: LegacySettingsPort, oldKey: string, newKey: string, layer: SettingsLayer): Promise<MigrationOutcome["outcome"] | null> {
	const old = valueAt(port.inspect(oldKey), layer);
	if (old === undefined) return null;
	const where = `${oldKey} → ${newKey} (${LAYER_WORDS[layer]})`;
	if (layer === "workspace") {
		if (!port.workspaceAllowed(newKey)) {
			port.log(`settings: ${where}: left; this setting is read from user settings only, so the value was already ignored here`);
			return "left";
		}
		const file = port.workspaceSettingsFile();
		if (file !== null && !(await port.isWritable(file))) {
			port.log(`settings: ${where}: left; the file is read-only`);
			return "left";
		}
	}
	// Read again right before the write: another window may have moved the value since the first look.
	const current = valueAt(port.inspect(newKey), layer);
	let outcome: MigrationOutcome["outcome"];
	if (current === undefined) {
		await port.update(newKey, old, layer);
		port.log(`settings: ${where}: moved`);
		outcome = "moved";
	} else if (isDeepStrictEqual(current, old)) {
		port.log(`settings: ${where}: the new key already holds this value; the old key removed`);
		outcome = "already-set";
	} else {
		port.log(`settings: ${where}: the new key already holds ${JSON.stringify(current)}; the old value ${JSON.stringify(old)} was dropped`);
		outcome = "conflict-dropped";
	}
	await port.update(oldKey, undefined, layer);
	return outcome;
}
