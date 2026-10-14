/**
 * OMP Desk — the two settings `ompDesk.runSessionsAtRepositoryRoot` replaced, carried over once (ADR-0073, in ADR-0068's style).
 *
 * - `ompDesk.useAgentRootFolder` chose whether Sessions climbed to an ancestor with agent files. An explicit `false` means "run in the
 *   folder I opened", which is `ompDesk.runSessionsAtRepositoryRoot = false`: it moves to the new key. An explicit `true` is what
 *   the new default does and is removed.
 * - `ompDesk.ompSettings.useNearestAncestorOmpFolder` chose where the Settings, Models and Agents editors write project settings. The
 *   editors now follow the folder sessions run in, so the value has no successor: it is removed.
 *
 * Both old keys stay contributed, hidden and deprecated, until 1.0.0 (`package.json`), like the rename keys of ADR-0068. Rules shared with
 * that migration (`legacy-settings.ts`): the old value is read at the layer it sits in; an existing new value wins and the old one is logged
 * with its value; the User layer is written by one window at a time; a Workspace settings file with the read-only attribute is not written;
 * a failed key is logged and the others still run; one line per key and layer; a window with nothing to move answers from synchronous
 * reads and does no I/O. `ompDesk.useAgentRootFolder` is application-scoped, so only its User value ever applied; a Workspace value
 * is left alone and unlogged. A value of `useNearestAncestorOmpFolder` in a folder of a multi-root workspace is left too (the port
 * reads two layers, as ADR-0068's does); the deprecated key is harmless there.
 *
 * It runs after the `omp.` → `ompDesk.` move, which may have just written `ompDesk.useAgentRootFolder`.
 */
import { LAYER_WORDS, describe, underUserClaim, valueAt } from "./legacy-settings.ts";
import type { LegacySettingsPort, MigrationOutcome, SettingsLayer } from "./legacy-settings.ts";

export const OLD_AGENT_ROOT_KEY = "ompDesk.useAgentRootFolder";
export const OLD_ANCESTOR_KEY = "ompDesk.ompSettings.useNearestAncestorOmpFolder";
export const RUN_AT_ROOT_KEY = "ompDesk.runSessionsAtRepositoryRoot";

/** Whether this window holds old values at the User layer: synchronous reads only. A read that throws counts as "yes": the key's own step logs it. */
function userPending(port: LegacySettingsPort): boolean {
	return [OLD_AGENT_ROOT_KEY, OLD_ANCESTOR_KEY].some(key => {
		try {
			return valueAt(port.inspect(key), "user") !== undefined;
		} catch {
			return true;
		}
	});
}

function workspacePending(port: LegacySettingsPort): boolean {
	try {
		return valueAt(port.inspect(OLD_ANCESTOR_KEY), "workspace") !== undefined;
	} catch {
		return true;
	}
}

/** Carry the old settings over. Never throws; the outcomes, in the order of the keys. */
export async function migrateSessionFolderSettings(port: LegacySettingsPort): Promise<readonly MigrationOutcome[]> {
	const userWork = userPending(port);
	const workspaceWork = workspacePending(port);
	if (!userWork && !workspaceWork) return [];
	const [user, workspace] = await Promise.all([
		userWork ? underUserClaim(port, () => userPending(port), claim => moveUser(port, claim)) : Promise.resolve([] as MigrationOutcome[]),
		workspaceWork ? dropAncestorKey(port, "workspace").then(outcome => (outcome === null ? [] : [outcome])) : Promise.resolve([] as MigrationOutcome[]),
	]);
	return [...user, ...workspace];
}

async function moveUser(port: LegacySettingsPort, claim: { release(): Promise<void> }): Promise<MigrationOutcome[]> {
	try {
		const outcomes: MigrationOutcome[] = [];
		const agentRoot = await carryAgentRootKey(port);
		if (agentRoot !== null) outcomes.push(agentRoot);
		const ancestor = await dropAncestorKey(port, "user");
		if (ancestor !== null) outcomes.push(ancestor);
		return outcomes;
	} finally {
		await claim.release().catch(() => undefined);
	}
}

async function carryAgentRootKey(port: LegacySettingsPort): Promise<MigrationOutcome | null> {
	const where = `${OLD_AGENT_ROOT_KEY} → ${RUN_AT_ROOT_KEY} (${LAYER_WORDS.user})`;
	try {
		const old = valueAt(port.inspect(OLD_AGENT_ROOT_KEY), "user");
		if (old === undefined) return null;
		let outcome: MigrationOutcome["outcome"];
		if (old === false) {
			// Read again right before the write: another window may have moved the value since the first look.
			const current = valueAt(port.inspect(RUN_AT_ROOT_KEY), "user");
			if (current === undefined) {
				await port.update(RUN_AT_ROOT_KEY, false, "user");
				port.log.info(`settings: ${where}: moved`);
				outcome = "moved";
			} else if (current === false) {
				port.log.info(`settings: ${where}: the new key already holds this value; the old key removed`);
				outcome = "already-set";
			} else {
				port.log.info(`settings: ${where}: the new key already holds ${JSON.stringify(current)}; the old value false was dropped`);
				outcome = "conflict-dropped";
			}
		} else {
			port.log.info(`settings: ${where}: dropped; ${JSON.stringify(old)} is what sessions do by default now (they run at the repository root)`);
			outcome = "dropped";
		}
		await port.update(OLD_AGENT_ROOT_KEY, undefined, "user");
		return { key: OLD_AGENT_ROOT_KEY, layer: "user", outcome };
	} catch (error) {
		port.log.warn(`settings: ${where}: left, the step failed: ${describe(error)}`);
		return { key: OLD_AGENT_ROOT_KEY, layer: "user", outcome: "left" };
	}
}

async function dropAncestorKey(port: LegacySettingsPort, layer: SettingsLayer): Promise<MigrationOutcome | null> {
	const where = `${OLD_ANCESTOR_KEY} (${LAYER_WORDS[layer]})`;
	try {
		const old = valueAt(port.inspect(OLD_ANCESTOR_KEY), layer);
		if (old === undefined) return null;
		if (layer === "workspace") {
			const file = port.workspaceSettingsFile();
			if (file !== null && !(await port.isWritable(file))) {
				port.log.warn(`settings: ${where}: left; the file is read-only`);
				return { key: OLD_ANCESTOR_KEY, layer, outcome: "left" };
			}
		}
		await port.update(OLD_ANCESTOR_KEY, undefined, layer);
		port.log.info(`settings: ${where}: dropped (it held ${JSON.stringify(old)}); the Settings, Models and Agents editors now use the folder sessions run in`);
		return { key: OLD_ANCESTOR_KEY, layer, outcome: "dropped" };
	} catch (error) {
		port.log.warn(`settings: ${where}: left, the step failed: ${describe(error)}`);
		return { key: OLD_ANCESTOR_KEY, layer, outcome: "left" };
	}
}
