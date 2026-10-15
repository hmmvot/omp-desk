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

/** Live descendants of one process, from a single process-table snapshot. */
export async function queryPtyProcessTree(pid: number): Promise<PtyTreeReading> {
	if (process.platform !== "win32") {
		return { kind: "unknown", detail: "process tree reading is implemented for Windows only" };
	}
	if (!Number.isSafeInteger(pid) || pid <= 0) return { kind: "unknown", detail: "no process id to read" };
	const native = await win32Native();
	if (native === null) return { kind: "unknown", detail: NATIVE_UNAVAILABLE };
	return native.processDescendants(pid);
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
