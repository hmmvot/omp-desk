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
 *   (`package.json`), with the scope they had before the rename. That keeps VS Code reading, routing and
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
 * - **Several windows.** The User layer is moved by one window at a time: a window that finds
 *   the profile's claim held waits for its release and then finds the values moved (its own
 *   configuration follows the file a moment later), and takes over only when the values are
 *   still there after that or the claim went stale. Windows derive the same new value from the
 *   same old one, so a second write of an equal value changes nothing; a write that loses a
 *   file race fails inside VS Code, is logged and is retried by the next activation. A window
 *   that still runs the previous release reads the defaults for a moved key until it reloads.
 * - **Cost.** A window with nothing to move answers from synchronous reads and does no I/O; the
 *   keys of a layer move concurrently, and activation does not wait for the move (see
 *   `extension.ts`: the first launch of a process does).
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
	/**
	 * The profile-wide right to write the User layer, or `null` while another window holds it. A claim that cannot be
	 * coordinated at all (the storage refuses) is a claim, not a refusal: the move then runs as it did without one.
	 */
	claimUserLayer(): Promise<UserLayerClaim | null>;
	/** Resolves `true` once the claim another window holds is released or has gone stale, `false` after `maxMs`. */
	waitForRelease(maxMs: number): Promise<boolean>;
	delay(ms: number): Promise<void>;
	/** Test seam for the waits in {@link DEFAULT_WAITS}. */
	waits?: Partial<{ releaseMs: number; graceMs: number; graceStepMs: number }>;
}

/** The right to write the User layer; released when the move ends, whatever its outcome. */
export interface UserLayerClaim {
	release(): Promise<void>;
}

/** What happened to one key at one layer. */
export interface MigrationOutcome {
	readonly key: string;
	readonly layer: SettingsLayer;
	readonly outcome: "moved" | "already-set" | "conflict-dropped" | "left" | "listed" | "dropped";
}

export const LAYER_WORDS: Record<SettingsLayer, string> = { user: "user settings", workspace: "workspace settings" };

export function describe(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim();
}

/**
 * Move every old setting that holds a value. Never throws: a failure of one key is logged and
 * the other keys still run.
 *
 * A window with nothing to move answers from synchronous `inspect` reads alone, so the normal
 * activation pays no I/O and no wait. When there is work, the keys of one layer move
 * concurrently (VS Code queues the writes of one file itself; what overlaps is the reload each
 * write waits for), and the User layer, which every window of the profile shares, is moved by
 * one window at a time: the others wait for it and find the values moved.
 */
export async function migrateLegacySettings(port: LegacySettingsPort): Promise<readonly MigrationOutcome[]> {
	const userWork = userLayerPending(port);
	const workspaceWork = layerHoldsOldValue(port, "workspace");
	if (!userWork && !workspaceWork) return [];
	const [user, workspace] = await Promise.all([
		userWork ? moveUserLayer(port) : Promise.resolve([] as MigrationOutcome[]),
		workspaceWork ? moveKeys(port, "workspace") : Promise.resolve([] as MigrationOutcome[]),
	]);
	return [...user, ...workspace];
}

/** How long a window waits for another window's move of the User layer, and for its result to reach this window's own reads. */
const DEFAULT_WAITS = { releaseMs: 15_000, graceMs: 3_000, graceStepMs: 100 } as const;

async function moveUserLayer(port: LegacySettingsPort): Promise<MigrationOutcome[]> {
	return underUserClaim(port, () => userLayerPending(port), claim => moveClaimedUserLayer(port, claim));
}

/**
 * Run `work` as the one window that writes the User layer: with the profile's claim, or after the window that held it released
 * it and `pending` still says there is work. `pending` reads synchronously, so a window that finds nothing left does no I/O.
 */
export async function underUserClaim(
	port: LegacySettingsPort,
	pending: () => boolean,
	work: (claim: UserLayerClaim) => Promise<MigrationOutcome[]>,
): Promise<MigrationOutcome[]> {
	const claim = await port.claimUserLayer();
	if (claim !== null) return work(claim);
	const waits = { ...DEFAULT_WAITS, ...port.waits };
	port.log("settings: another window is moving the user settings; this window waits for it");
	if (!(await port.waitForRelease(waits.releaseMs))) {
		port.log(`settings: the other window's move of the user settings is still running after ${waits.releaseMs} ms; it is not waited for`);
		return [];
	}
	// The release is seen as soon as it happens; this window's own configuration follows the file a moment later.
	for (let waited = 0; waited < waits.graceMs && pending(); waited += waits.graceStepMs) await port.delay(waits.graceStepMs);
	if (!pending()) return [];
	const retry = await port.claimUserLayer();
	return retry === null ? [] : work(retry);
}

async function moveClaimedUserLayer(port: LegacySettingsPort, claim: UserLayerClaim): Promise<MigrationOutcome[]> {
	try {
		// The two lists first: a value is never exposed to Settings Sync or another profile under a name that is not listed.
		const listed = await Promise.all(SETTING_NAME_LISTS.map(async list => {
			try {
				return await extendNameList(port, list);
			} catch (error) {
				port.log(`settings: ${list}: the new names were not added, the step failed: ${describe(error)}`);
				return [];
			}
		}));
		return [...listed.flat(), ...(await moveKeys(port, "user"))];
	} finally {
		await claim.release().catch(() => undefined);
	}
}

/** Every old key at one layer, concurrently; outcomes in the table's order. */
async function moveKeys(port: LegacySettingsPort, layer: SettingsLayer): Promise<MigrationOutcome[]> {
	const outcomes = await Promise.all(LEGACY_SETTING_NAMES.map(async (name): Promise<MigrationOutcome | null> => {
		const oldKey = `omp.${name}`;
		const newKey = `ompDesk.${name}`;
		try {
			if (port.foreignSettings.has(oldKey)) {
				if (valueAt(port.inspect(oldKey), layer) !== undefined) port.log(`settings: ${oldKey} → ${newKey} (${LAYER_WORDS[layer]}): left; another extension contributes ${oldKey}`);
				return null;
			}
			const outcome = await migrateKey(port, oldKey, newKey, layer);
			return outcome === null ? null : { key: oldKey, layer, outcome };
		} catch (error) {
			port.log(`settings: ${oldKey} → ${newKey} (${LAYER_WORDS[layer]}): left, the step failed: ${describe(error)}`);
			return { key: oldKey, layer, outcome: "left" };
		}
	}));
	return outcomes.filter((outcome): outcome is MigrationOutcome => outcome !== null);
}

export function valueAt(values: LayerValues | undefined, layer: SettingsLayer): unknown {
	return layer === "user" ? values?.globalValue : values?.workspaceValue;
}

/** The new names a list of setting names lacks: `ompDesk.<name>` for every `omp.<name>` it holds (User layer). */
function missingListedNames(port: LegacySettingsPort, list: string): { readonly current: readonly unknown[]; readonly missing: readonly string[] } | null {
	const current = valueAt(port.inspect(list), "user");
	if (!Array.isArray(current)) return null;
	const missing: string[] = [];
	for (const name of LEGACY_SETTING_NAMES) {
		if (current.includes(`omp.${name}`) && !current.includes(`ompDesk.${name}`) && !port.foreignSettings.has(`omp.${name}`)) missing.push(`ompDesk.${name}`);
	}
	return missing.length === 0 ? null : { current, missing };
}

/** Add `ompDesk.<name>` next to every `omp.<name>` a list of setting names holds (User layer; the old entries stay). */
async function extendNameList(port: LegacySettingsPort, list: string): Promise<MigrationOutcome[]> {
	const found = missingListedNames(port, list);
	if (found === null) return [];
	await port.update(list, [...found.current, ...found.missing], "user");
	port.log(`settings: ${list}: added ${found.missing.join(", ")} next to the old names it holds`);
	return [{ key: list, layer: "user", outcome: "listed" }];
}

/**
 * Whether any old key holds a value at a layer (a key another extension contributes counts: it is logged, never moved). A read
 * that throws counts as "yes": the key's own step then logs the failure.
 */
function layerHoldsOldValue(port: LegacySettingsPort, layer: SettingsLayer): boolean {
	return LEGACY_SETTING_NAMES.some(name => {
		try {
			return valueAt(port.inspect(`omp.${name}`), layer) !== undefined;
		} catch {
			return true;
		}
	});
}

/** Whether the User layer has anything to move or list: synchronous reads only, no I/O. */
function userLayerPending(port: LegacySettingsPort): boolean {
	return layerHoldsOldValue(port, "user") || SETTING_NAME_LISTS.some(list => {
		try {
			return missingListedNames(port, list) !== null;
		} catch {
			return true;
		}
	});
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
