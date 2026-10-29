/**
 * Kernel identity readings for the PTY broker's processes
 * ([ADR-0024](../../docs/decisions/0024-own-omp-pty-for-in-tab-terminal.md),
 * [ADR-0035](../../docs/decisions/0035-distinguish-a-recorded-process-from-a-later-occupant-of-its-pid.md)).
 *
 * A process id alone is not an identity: Windows reuses ids as soon as every
 * handle to the process is closed, so "pid 4711 is our native OMP" is a guess
 * unless the id is paired with the process's kernel creation time, the same
 * FILETIME reading the host-control channel records for a host it launched. This
 * module produces those readings, plus the descendant list a stop needs before it
 * may claim a tree is gone, through the process's native module
 * ([ADR-0076](../../docs/decisions/0076-call-win32-in-process-through-a-staged-koffi-module-instead-of-starting-powershell.md)).
 *
 * Invariants:
 * - Every reading is tri-state. `unknown` is a real answer (a native module that is not
 *   loaded, a call the kernel refused) and callers must not promote it to `gone` or to
 *   `found`. Nothing here reports a value it did not read.
 * - Only `ESRCH` or the kernel's "no such process" is `gone`; a process this account may
 *   not open is `unknown`.
 */

import { win32Native } from "./win32-native.ts";
import { isPtyCreationTime } from "./pty-protocol.ts";

const NATIVE_UNAVAILABLE = "the native module is not available, so the process cannot be read";

/** What a creation-time reading found. */
export type PtyIdentityReading =
	| { readonly kind: "found"; readonly creationTime: string }
	| { readonly kind: "gone" }
	| { readonly kind: "unknown"; readonly detail: string };

/** What a descendant reading found. */
export type PtyTreeReading =
	| { readonly kind: "found"; readonly pids: readonly number[] }
	| { readonly kind: "unknown"; readonly detail: string };

/**
 * Whether a process id is alive *right now*.
 *
 * `process.kill(pid, 0)` asks the kernel without sending a signal. A process this
 * account may not open answers `EPERM`, which still means it exists, so only
 * `ESRCH` is read as "gone".
 */
export function isPtyProcessAlive(pid: number): boolean {
	if (!Number.isSafeInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException | null)?.code !== "ESRCH";
	}
}

/**
 * Kernel creation time of one process.
 *
 * `gone` is reported when no process runs under the id now: `process.kill(pid, 0)` answers
 * `ESRCH` (asked first, so a dead pid costs no native call), or the kernel cannot find the
 * process. An id that answers alive or `EPERM` is never judged from the id alone: the
 * kernel's creation time decides, which also tells a reused id apart.
 */
export async function queryPtyProcessIdentity(pid: number): Promise<PtyIdentityReading> {
	if (process.platform !== "win32") {
		return { kind: "unknown", detail: "process identity reading is implemented for Windows only" };
	}
	if (!Number.isSafeInteger(pid) || pid <= 0) return { kind: "unknown", detail: "no process id to read" };
	if (!isPtyProcessAlive(pid)) return { kind: "gone" };
	const native = await win32Native();
	if (native === null) return { kind: "unknown", detail: NATIVE_UNAVAILABLE };
	const reading = native.processCreation(pid);
	if (reading.kind === "found") {
		if (!isPtyCreationTime(reading.filetime)) {
			return { kind: "unknown", detail: "the native module returned a creation time that is not a FILETIME" };
		}
		return { kind: "found", creationTime: reading.filetime };
	}
	return reading;
}

/**
 * Live descendants of one process, from a single process-table snapshot.
 *
 * A parent link in the table is a number, and Windows keeps it after the parent exits: a long-lived process whose creator
 * had id X still names X as its parent when a later, unrelated process is given X. A walk by id alone would report that old
 * process as a descendant of the newcomer. A child cannot be older than the process that started it (as long as the clock
 * did not step back between the two starts), so with the root's kernel creation time (`rootCreationTime`) every row is read
 * once more and one created before the parent it claims is dropped, together with everything below it. A row whose creation
 * time cannot be read stays (it cannot be ruled out); a row that has exited since the snapshot is not reported, and what
 * names it is still walked. Without a root creation time nothing can be ruled out and the walk is by id alone.
 *
 * What this cannot exclude: a process started by a new holder of the root's id after the root ended, which is newer than the
 * root. The window opens when the root ends, and the caller may read the tree long after that.
 */
export async function queryPtyProcessTree(pid: number, rootCreationTime: string | null = null): Promise<PtyTreeReading> {
	if (process.platform !== "win32") {
		return { kind: "unknown", detail: "process tree reading is implemented for Windows only" };
	}
	if (!Number.isSafeInteger(pid) || pid <= 0) return { kind: "unknown", detail: "no process id to read" };
	const native = await win32Native();
	if (native === null) return { kind: "unknown", detail: NATIVE_UNAVAILABLE };
	if (!isPtyCreationTime(rootCreationTime)) return native.processDescendants(pid);
	const table = native.processTable();
	if (table.kind !== "found") return table;
	const children = new Map<number, number[]>();
	for (const row of table.entries) {
		const siblings = children.get(row.parentPid);
		if (siblings === undefined) children.set(row.parentPid, [row.pid]);
		else siblings.push(row.pid);
	}
	// Breadth first inside this one snapshot, with a visited set: a reused parent id can make the table cyclic. Each entry of
	// a level carries the oldest creation time a child of it may have: its own, or its nearest ancestor's when it cannot be read.
	const visited = new Set<number>([pid]);
	const found: number[] = [];
	for (let level = [{ pid, notBefore: BigInt(rootCreationTime) }], next: typeof level = []; level.length > 0; level = next, next = []) {
		for (const parent of level) {
			for (const child of children.get(parent.pid) ?? []) {
				if (visited.has(child)) continue;
				visited.add(child);
				const created = native.processCreation(child);
				let notBefore = parent.notBefore;
				if (created.kind === "gone") {
					// Exited since the snapshot, so no survivor itself; what it left running still names it, under the bound that was read.
					next.push({ pid: child, notBefore });
					continue;
				}
				if (created.kind === "found" && isPtyCreationTime(created.filetime)) {
					const startedAt = BigInt(created.filetime);
					if (startedAt < parent.notBefore) continue;
					notBefore = startedAt;
				}
				found.push(child);
				next.push({ pid: child, notBefore });
			}
		}
	}
	return { kind: "found", pids: found };
}

/** A process that is gone, or why that could not be established in the bound. */
export interface PtyGoneReading {
	readonly gone: boolean;
	readonly detail: string;
}

/**
 * Wait for one process id to disappear, by creation-time readings rather than by
 * liveness alone: a process that exited during the wait and whose id was reused
 * inside it reads as a *different* process, and a `found` reading whose creation
 * time changed is not the process this call is waiting for.
 */
export async function waitForPtyProcessGone(
	pid: number,
	expectedCreationTime: string | null,
	timeoutMs: number,
): Promise<PtyGoneReading> {
	const deadline = Date.now() + timeoutMs;
	let lastDetail = "no reading was taken";
	for (;;) {
		const reading = await queryPtyProcessIdentity(pid);
		if (reading.kind === "gone") return { gone: true, detail: "no process is running under this id" };
		if (reading.kind === "found") {
			if (expectedCreationTime !== null && reading.creationTime !== expectedCreationTime) {
				// The id now belongs to a different process: the one we waited for is gone.
				return { gone: true, detail: "the process id was reused by a different process" };
			}
			lastDetail = "the process is still alive";
		} else {
			lastDetail = reading.detail;
		}
		if (Date.now() >= deadline) return { gone: false, detail: `${lastDetail} after ${timeoutMs}ms` };
		await new Promise<void>(resolve => {
			const timer = setTimeout(resolve, 250);
			timer.unref();
		});
	}
}
