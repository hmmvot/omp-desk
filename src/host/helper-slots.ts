/**
 * The cross-window slots of the helper scheduler (`helper-scheduler.ts`): a few named interprocess locks that background helper
 * runs of every window of the profile take, so the windows of one reload do not all start their helper processes together.
 *
 * It reuses the PTY slot lock (`acquirePtySlotLock`), the lock Stats' launch already takes: a file created exclusively under the
 * PTY state directory, owned by a process id, taken over when that process is gone. Each lock name is `<name>:<index>`; a taker tries
 * the slots in a random order, so windows do not all queue on the first one.
 *
 * It is a throttle, not mutual exclusion that anything depends on: the PTY lock replaces a lock file it cannot read (a file that
 * another window created a moment ago and has not yet written), so two windows may very rarely hold one slot at once, and that only
 * means one more helper runs. When no slot is free within `maxWaitMs`, or the slot files cannot be created, `acquire` answers
 * `null` and the caller runs anyway.
 */
import { randomUUID } from "node:crypto";
import { acquirePtySlotLock, releasePtySlotLock } from "../wire/pty-registry.ts";
import { helperSleep, type HelperSlotLease, type HelperSlots } from "./helper-scheduler.ts";

export const HELPER_SLOT_NAME = "omp-helper";
export const HELPER_SLOT_COUNT = 2;
export const HELPER_SLOT_POLL_MS = 400;

/** The text `acquirePtySlotLock` gives when the slot is held by another live process; every other refusal is a fault of the slot files. */
const HELD_BY_ANOTHER = /another window holds/;

export interface HelperSlotsOptions {
	/** The extension's global storage directory (the PTY state directory is under it). */
	readonly storageDir: string;
	readonly count?: number;
	readonly name?: string;
	readonly pollMs?: number;
	/** Whether a lock holder process is still alive; defaults to the PTY lock's own check. */
	readonly isHolderAlive?: (pid: number, creationTime: string | null) => boolean;
	/** Resolves after `ms`, or at once when `signal` aborts; defaults to {@link helperSleep}. */
	readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
	readonly now?: () => number;
	readonly random?: () => number;
}

export function createHelperSlots(options: HelperSlotsOptions): HelperSlots {
	const count = Math.max(1, options.count ?? HELPER_SLOT_COUNT);
	const name = options.name ?? HELPER_SLOT_NAME;
	const pollMs = options.pollMs ?? HELPER_SLOT_POLL_MS;
	const now = options.now ?? Date.now;
	const random = options.random ?? Math.random;
	const sleep = options.sleep ?? helperSleep;
	const slotName = (index: number): string => `${name}:${index}`;

	return {
		async acquire(signal: AbortSignal, maxWaitMs: number): Promise<HelperSlotLease | null> {
			const holderId = `helper-${randomUUID()}`;
			const deadline = now() + maxWaitMs;
			try {
				for (;;) {
					if (signal.aborted) return null;
					const first = Math.floor(random() * count);
					for (let offset = 0; offset < count; offset += 1) {
						const slot = slotName((first + offset) % count);
						const result = await acquirePtySlotLock(options.storageDir, slot, {
							holderId, waitMs: 0, ...(options.isHolderAlive === undefined ? {} : { isHolderAlive: options.isHolderAlive }),
						});
						if (result.acquired) {
							return { release: () => releasePtySlotLock(options.storageDir, slot, holderId) };
						}
						if (!HELD_BY_ANOTHER.test(result.detail)) return null;
					}
					if (now() >= deadline) return null;
					await sleep(pollMs + Math.floor(random() * pollMs), signal);
				}
			} catch {
				return null;
			}
		},
	};
}
