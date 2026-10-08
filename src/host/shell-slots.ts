/**
 * The durable record of folder shell terminals (ADR-0024).
 *
 * A folder shell is a plain shell PTY the extension started for one folder. It is
 * deliberately not a managed OMP session: it never enters SessionIndex, it has no
 * claim, and an `omp` the user types inside it is not adopted as a managed writer.
 * What it does need is a durable, recoverable identity, because VS Code cannot veto
 * a webview editor's close: the shell slot is written before any close is confirmed,
 * and every uncertain outcome (dismissed prompt, failed or unverified stop, failed
 * editor recreation) keeps it, so a live shell tree is never stranded and never
 * silently terminated.
 *
 * The record holds no secret and no capability: the broker owns the PTY, and the
 * slot id is what a Reconnect action names to attach to the same broker generation.
 * Nothing here can start a process.
 */
import { randomUUID } from "node:crypto";

import { mergeKeyedArray } from "./catalog-merge.ts";
import type { RecordConflictDraft } from "./catalog-merge.ts";

/** The key this registry owns in the profile catalog. */
export const SHELL_SLOTS_KEY = "omp.shellSlots.v1";

/**
 * How many shell slots are retained.
 *
 * The bound is a refusal threshold, never an eviction rule: a running shell or an
 * uncertain process remains recoverable. Confirmed child exit permits retirement,
 * without claiming that commands detached from that child have ended.
 */
export const SHELL_SLOT_LIMIT = 32;

/** The exact id shape a shell slot has: `shell:<uuid>`. */
const SHELL_SLOT_RE = /^shell:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isShellSlotId(value: unknown): value is string {
	return typeof value === "string" && SHELL_SLOT_RE.test(value);
}

/** Mint a fresh shell slot id. */
export function createShellSlotId(): string {
	return `shell:${randomUUID()}`;
}

/**
 * What this window can honestly say about one recorded shell's own process.
 *
 * `running` means the broker reported the child alive; `exited` means it reported the
 * child ended, which is not proof that the tree is empty; `unreachable` means the
 * broker could not be asked at all.
 */
export type ShellLiveness = "running" | "exited" | "unreachable";

/** Plain confirmation for a terminal whose process has not been confirmed gone. */
export function shellClosePrompt(input: {
	readonly label: string;
	readonly liveness: Exclude<ShellLiveness, "exited">;
}): { readonly message: string; readonly detail: string; readonly confirmLabel: string } {
	return {
		message: `Close terminal “${input.label}”?`,
		detail: input.liveness === "running"
			? "The terminal is still running. Terminate tries to stop it; commands it started may keep running."
			: "OMP cannot reach this terminal. Keep it open to reconnect, or try Terminate.",
		confirmLabel: "Terminate",
	};
}

/**
 * What one folder-shell launch verdict means for the pre-recorded recovery slot.
 *
 * The slot record is written before the launch, so it is the only thing that keeps a
 * folder's Reconnect Terminal route alive when a launch does not hand back a handle.
 * The record is removed only when the verdict proves nothing was ever started:
 * `not-started` with no broker pid (an unready runtime, a pre-spawn failure, or the
 * spawn call itself throwing). Every other shape retains the slot: `unconfirmed` (a
 * broker may still be starting), `slot-occupied` (the record is retained on purpose),
 * and any `not-started` that carries a pid. An uncertain launch is not evidence that
 * no process exists.
 *
 * The condition is "retain unless positively nothing started" so that a future verdict
 * returning a null pid after a spawn is retained by default rather than stranding a
 * live tree.
 */
export function shellLaunchOutcome(verdict: {
	readonly state: "running" | "slot-occupied" | "not-started" | "unconfirmed";
	readonly brokerPid: number | null;
}): { readonly retain: boolean; readonly detail: string } {
	if (verdict.state === "not-started" && verdict.brokerPid === null) {
		return {
			retain: false,
			detail: "the broker was never started, so no process of this terminal can exist",
		};
	}
	const detail =
		verdict.state === "unconfirmed"
			? "the broker did not publish its record in time and may still be starting"
			: verdict.state === "slot-occupied"
				? "the broker slot already holds a record that is kept on purpose"
				: "the broker was started but did not report a usable terminal";
	return { retain: true, detail };
}

/** One durable folder shell. */
export interface ShellSlotRecord {
	/** Stable identity of this shell: what a Reconnect attaches to. */
	readonly slot: string;
	/** The folder the shell runs in, exactly as it was validated. */
	readonly cwd: string;
	/** Canonical key of {@link cwd}, for matching a folder row. */
	readonly folderKey: string;
	/** Display label (the folder's basename, or the resolved shell name). */
	readonly label: string;
	readonly createdAt: string;
	/**
	 * When this shell stopped being shown by an editor, or `null` while an editor
	 * carries it.
	 *
	 * A detached shell is not a dead one: it is the state a Reconnect attaches to,
	 * and the state that survives a failed editor recreation.
	 */
	readonly detachedAt: string | null;
	/** Last broker generation this window attached to, for diagnostics only. */
	readonly lastGeneration: string | null;
}

export interface ShellMemento {
	get(key: string, fallback: unknown): unknown;
	update(key: string, value: unknown, base?: unknown): PromiseLike<void>;
}

function parseRecord(value: unknown): ShellSlotRecord | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (!isShellSlotId(record.slot)) return null;
	if (typeof record.cwd !== "string" || record.cwd.length === 0 || record.cwd.length > 4096) return null;
	if (typeof record.folderKey !== "string" || record.folderKey.length === 0) return null;
	if (typeof record.label !== "string" || record.label.length === 0 || record.label.length > 256) return null;
	if (typeof record.createdAt !== "string" || record.createdAt.length === 0) return null;
	if (record.detachedAt !== null && typeof record.detachedAt !== "string") return null;
	if (record.lastGeneration !== null && typeof record.lastGeneration !== "string") return null;
	return {
		slot: record.slot,
		cwd: record.cwd,
		folderKey: record.folderKey,
		label: record.label,
		createdAt: record.createdAt,
		detachedAt: record.detachedAt ?? null,
		lastGeneration: record.lastGeneration ?? null,
	};
}

function parseRecords(value: unknown): ShellSlotRecord[] {
	if (!Array.isArray(value)) return [];
	const records: ShellSlotRecord[] = [];
	for (const entry of value) {
		const record = parseRecord(entry);
		if (record === null) continue;
		if (records.some(existing => existing.slot === record.slot)) continue;
		records.push(record);
	}
	return records;
}

/**
 * What recording a new shell produced.
 *
 * A refusal is not a failure: the registry cannot carry another recoverable slot, and
 * the caller must not start a shell it could not record, because a shell whose slot is
 * unknown can be stranded by the very close this record exists to survive.
 */
export type ShellSlotAddResult =
	| { readonly ok: true; readonly record: ShellSlotRecord }
	| { readonly ok: false; readonly reason: string };

export interface ShellSlotStore {
	list(): readonly ShellSlotRecord[];
	get(slot: string): ShellSlotRecord | null;
	/**
	 * Record a new shell before its editor is created, so a close can never strand it.
	 *
	 * Refused, with an actionable reason and no side effect, when the registry is full.
	 * Nothing is evicted to make room. A caller retires a slot only after confirmed
	 * child exit or a launch verdict proving no process was started.
	 */
	add(input: {
		readonly slot: string;
		readonly cwd: string;
		readonly folderKey: string;
		readonly label: string;
	}): Promise<ShellSlotAddResult>;
	/** Apply a bounded patch; `null` clears `detachedAt` or `lastGeneration`, `undefined` leaves a field unchanged. */
	update(
		slot: string,
		patch: { readonly detachedAt?: string | null; readonly lastGeneration?: string | null; readonly label?: string },
	): Promise<ShellSlotRecord | null>;
	/** Retire a record after confirmed child exit, or a launch that started nothing. */
	remove(slot: string): Promise<boolean>;
	/**
	 * Forget this window's cached copy of the list, so the next read is the newest
	 * committed revision. Called when the shared catalog changed under this window.
	 */
	reload(): void;
	/**
	 * Every recorded slot and whether the stored value was read in full. `complete` is
	 * `false` when the value was not a list or an element did not parse (it is dropped, and
	 * stays reported until the next reload), because a slot named only by such an element
	 * is unknown rather than unreferenced.
	 */
	references(): { readonly records: readonly ShellSlotRecord[]; readonly complete: boolean };
}

export function createShellSlotStore(memento: ShellMemento, now: () => number = Date.now): ShellSlotStore {
	let cache: ShellSlotRecord[] | null = null;
	/** The committed value this window's list was derived from; passed as the merge base on write. */
	let loadedBase: unknown = undefined;
	/** Whether the loaded value parsed without dropping anything; sticky until reload. */
	let loadedComplete = true;
	const load = (): ShellSlotRecord[] => {
		if (cache === null) {
			loadedBase = memento.get(SHELL_SLOTS_KEY, null);
			cache = parseRecords(loadedBase);
			loadedComplete =
				loadedBase === null ||
				loadedBase === undefined ||
				(Array.isArray(loadedBase) && loadedBase.every(entry => parseRecord(entry) !== null));
		}
		return cache;
	};
	// The cache follows only a durable write: a rejected update must not leave a slot
	// looking recorded when the next window would not find it.
	const write = async (next: readonly ShellSlotRecord[]): Promise<void> => {
		await memento.update(SHELL_SLOTS_KEY, next, loadedBase);
		loadedBase = next;
		cache = [...next];
	};
	return {
		list(): readonly ShellSlotRecord[] {
			return [...load()];
		},
		references() {
			const records = [...load()];
			return { records, complete: loadedComplete };
		},
		get(slot: string): ShellSlotRecord | null {
			return load().find(record => record.slot === slot) ?? null;
		},
		async add(input): Promise<ShellSlotAddResult> {
			const record: ShellSlotRecord = {
				slot: input.slot,
				cwd: input.cwd,
				folderKey: input.folderKey,
				label: input.label,
				createdAt: new Date(now()).toISOString(),
				detachedAt: null,
				lastGeneration: null,
			};
			// Replacing an existing record for the same slot is not growth, so it is always
			// allowed; only a genuinely new slot can hit the bound.
			const existing = load().find(entry => entry.slot === record.slot) ?? null;
			if (existing === null && load().length >= SHELL_SLOT_LIMIT) {
				return {
					ok: false,
					reason:
						`This window already keeps ${SHELL_SLOT_LIMIT} terminal records. Reconnect or terminate one of them, ` +
						"or let its process exit, before starting another.",
				};
			}
			const current = load().filter(entry => entry.slot !== record.slot);
			current.push(record);
			await write(current);
			return { ok: true, record };
		},
		async update(slot, patch): Promise<ShellSlotRecord | null> {
			const current = load();
			const index = current.findIndex(record => record.slot === slot);
			if (index < 0) return null;
			const existing = current[index]!;
			const next: ShellSlotRecord = {
				...existing,
				detachedAt: patch.detachedAt === undefined ? existing.detachedAt : patch.detachedAt,
				lastGeneration: patch.lastGeneration === undefined ? existing.lastGeneration : patch.lastGeneration,
				label: patch.label ?? existing.label,
			};
			const updated = [...current];
			updated[index] = next;
			await write(updated);
			return next;
		},
		async remove(slot): Promise<boolean> {
			const current = load();
			const next = current.filter(record => record.slot !== slot);
			if (next.length === current.length) return false;
			await write(next);
			return true;
		},
		reload(): void {
			cache = null;
			loadedBase = undefined;
		},
	};
}

/**
 * Merge this window's shell records into the newest committed list.
 *
 * Records merge per slot, so two windows starting two folder shells both keep theirs.
 * A slot is a recoverable process identity: losing its record can strand a shell, and
 * a slot that looks free can be taken twice. The merge therefore never drops a record
 * the committed list holds and never replaces one another window changed.
 */
export function mergeShellSlotRecords(input: {
	readonly base: unknown;
	readonly desired: unknown;
	readonly latest: unknown;
}): { readonly value: unknown; readonly conflicts: readonly RecordConflictDraft[] } {
	const conflicts: RecordConflictDraft[] = [];
	return {
		value: mergeKeyedArray({
			base: parseRecords(input.base),
			desired: parseRecords(input.desired),
			latest: parseRecords(input.latest),
			key: record => record.slot,
			label: "terminal record",
			conflicts,
		}),
		conflicts,
	};
}

/**
 * Shell slots belonging to one folder, in stored order.
 *
 * `folderKey` is the canonical folder identity the workspace registry already computes,
 * so this never re-derives a path comparison of its own.
 */
export function shellSlotsForFolder(
	records: readonly ShellSlotRecord[],
	folderKey: string,
): readonly ShellSlotRecord[] {
	return records.filter(record => record.folderKey === folderKey);
}

/**
 * The slots a Reconnect action could attach to for one folder.
 *
 * `isBoundLive` is the extension host's own answer to "a live editor currently shows
 * this exact slot". A slot already on screen is not something to reconnect to; a
 * detached one always is, because its process may still be running and only the user
 * may end it.
 */
export function reconnectableShellSlots(
	records: readonly ShellSlotRecord[],
	folderKey: string,
	isBoundLive: (slot: string) => boolean,
): readonly ShellSlotRecord[] {
	return shellSlotsForFolder(records, folderKey).filter(record => !isBoundLive(record.slot));
}
