/**
 * What Desk itself recorded about a session's processes, read from the profile catalog the extension writes
 * (`<data>/User/globalStorage/hmmvot.omp-desk/catalog/v1/catalog.json`), and the operating system calls a crash
 * scenario needs: the same pids Kill uses (the recorded broker and the recorded OMP child), a liveness look and
 * System32's `taskkill`, which is what an outside kill (Task Manager) amounts to.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunState } from "./state.ts";

const CATALOG = ["User", "globalStorage", "hmmvot.omp-desk", "catalog", "v1", "catalog.json"];
const SESSION_INDEX = "omp.sessionIndex.v1";

/** One session as Desk's index records it. `brokerPid` and `childPid` are `null` for a session with no recorded host. */
export interface RecordedSession {
	readonly tabId: string;
	readonly title: string | null;
	readonly runIntent: string;
	readonly brokerPid: number | null;
	readonly childPid: number | null;
	/** The session file and id the row names right now (`null` for a row that has none yet). */
	readonly sessionFile: string | null;
	readonly sessionId: string | null;
}

interface CatalogEntry {
	readonly tabId: string;
	readonly title: string | null;
	readonly runIntent: string;
	readonly host: { readonly pid?: number; readonly rpc?: { readonly brokerPid?: number; readonly childPid?: number | null } | null } | null;
	readonly sessionFile?: string | null;
	readonly sessionId?: string | null;
}

/** The index entries of the catalog right now; `[]` while the file is absent or mid-replacement. */
function readEntries(state: RunState): CatalogEntry[] {
	try {
		const catalog = JSON.parse(readFileSync(join(state.dataDir, ...CATALOG), "utf8"));
		return catalog.records?.[SESSION_INDEX]?.entries ?? [];
	} catch {
		return [];
	}
}

/** Every recorded session whose title contains `marker` (the first prompt becomes the title; a fork copies it, so a fork and its original both match). */
export function recordedSessions(state: RunState, marker: string): RecordedSession[] {
	return readEntries(state)
		.filter(candidate => candidate.title?.includes(marker))
		.map(entry => ({
			tabId: entry.tabId,
			title: entry.title,
			runIntent: entry.runIntent,
			brokerPid: entry.host?.rpc?.brokerPid ?? null,
			childPid: entry.host?.rpc?.childPid ?? entry.host?.pid ?? null,
			sessionFile: entry.sessionFile ?? null,
			sessionId: entry.sessionId ?? null,
		}));
}

/** The recorded session whose title contains `marker` (the first prompt becomes the title), or `undefined`. */
export function recordedSession(state: RunState, marker: string): RecordedSession | undefined {
	return recordedSessions(state, marker)[0];
}

/** Whether a process with this id exists (signal 0 is a liveness look, it signals nothing). */
export function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** What Task Manager's "End process tree" does: `taskkill /PID <pid> /T /F` from System32 (never a `PATH` copy). */
export function taskkillTree(pid: number, tree = true): Promise<void> {
	const exe = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	execFile(exe, ["/PID", String(pid), ...(tree ? ["/T"] : []), "/F"], { windowsHide: true, timeout: 20_000 }, error => error ? reject(error) : resolve());
	return promise;
}
