/**
 * The disk half of a fork's preconditions.
 *
 * `omp --fork <file>` reads the original's session file, while the original's own writer may still be appending. OMP's
 * own pane fork flushes its session first; Desk cannot ask the process to flush, so it reads the file the way the
 * resync does and proceeds only when the file holds the entry the live conversation is at (`HistoryReader.snapshot`
 * reports the leaf it could use, which differs from the one asked for when the disk trails the process).
 */
import { setTimeout as delay } from "node:timers/promises";
import { HistoryReadError, HistoryReader } from "./rpc/history-reader.ts";

/** How long the writer is given to catch up before the fork is refused. */
export const FORK_DISK_WAIT_MS = 2_000;
const FORK_DISK_STEP_MS = 250;

export type ForkDisk = "holds" | "trails" | "missing";

/** One reading of `file` against the live leaf; a null or unknown-format leaf cannot be compared, so any readable file with a header holds it. */
export async function readForkDisk(file: string, liveLeafId: string | null): Promise<ForkDisk> {
	try {
		const snapshot = await (await HistoryReader.open(file)).snapshot(1, liveLeafId);
		if (liveLeafId === null || snapshot.legacyIds || snapshot.lastId === null) return snapshot.lastId === null ? "trails" : "holds";
		return snapshot.leafId === liveLeafId ? "holds" : "trails";
	} catch (error) {
		if (error instanceof HistoryReadError && error.code === "missing") return "missing";
		return "trails";
	}
}

/** Read until the disk holds the live leaf or {@link FORK_DISK_WAIT_MS} has passed. */
export async function awaitForkDisk(file: string, liveLeafId: string | null, wait: { readonly timeoutMs?: number; readonly stepMs?: number } = {}): Promise<ForkDisk> {
	const deadline = Date.now() + (wait.timeoutMs ?? FORK_DISK_WAIT_MS);
	for (;;) {
		const reading = await readForkDisk(file, liveLeafId);
		if (reading === "holds" || reading === "missing" || Date.now() >= deadline) return reading;
		await delay(wait.stepMs ?? FORK_DISK_STEP_MS);
	}
}
