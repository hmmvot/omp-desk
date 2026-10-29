/**
 * Notice that the broker a window drives is gone.
 *
 * A broker that exits on its own initiative says so over its connection; one that is ended from
 * outside (Kill in Sessions, Task Manager, a crash) says nothing: its connection just closes and a
 * chat reattaches for half a minute and then shows a failed connection, a native terminal keeps
 * showing a screen nobody serves, and the row keeps claiming a running process. A window that
 * drives a runtime therefore also asks, cheaply, whether that runtime's broker process still
 * exists, and runs the session's ordinary exit handling when it does not.
 *
 * The question is `process.kill(pid, 0)` (`isPtyProcessAlive`): a syscall, no process spawn, so a
 * second per runtime costs nothing. A *missing* process id is conclusive: no process holds that
 * id, so none of them is the broker. An id that exists proves nothing (it may have been reissued
 * to a stranger), so a loss behind a reissued id is not noticed here. What runs on a loss proves the
 * OMP child
 * gone by its own creation time before it releases anything, so a wrong trigger releases nothing.
 *
 * No `vscode` import; the timer and the liveness read are injectable.
 */

import { isPtyProcessAlive } from "../wire/pty-identity.ts";

/** How often a driven runtime's broker process is looked for. */
export const BROKER_LOSS_POLL_MS = 1_000;

export interface BrokerLossWatchOptions {
	readonly brokerPid: number;
	/** `false` once the runtime is no longer the one this window drives: the watch ends silently. */
	isCurrent(): boolean;
	/** Run once, when the broker process no longer exists. */
	onLost(): void | Promise<void>;
	readonly intervalMs?: number;
	readonly isAlive?: (pid: number) => boolean;
	readonly setTimer?: (callback: () => void, ms: number) => { unref?: () => void };
	readonly clearTimer?: (timer: unknown) => void;
}

/** Start watching; the returned function ends the watch. Never throws. */
export function watchBrokerLoss(options: BrokerLossWatchOptions): () => void {
	const isAlive = options.isAlive ?? isPtyProcessAlive;
	const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
	const clearTimer = options.clearTimer ?? ((timer: unknown) => clearTimeout(timer as NodeJS.Timeout));
	const intervalMs = options.intervalMs ?? BROKER_LOSS_POLL_MS;
	let stopped = false;
	let timer: { unref?: () => void } | undefined;
	const arm = (): void => {
		if (stopped) return;
		timer = setTimer(look, intervalMs);
		timer.unref?.();
	};
	const look = (): void => {
		timer = undefined;
		if (stopped) return;
		if (!options.isCurrent()) {
			stopped = true;
			return;
		}
		let alive = true;
		try {
			alive = isAlive(options.brokerPid);
		} catch {
			alive = true;
		}
		if (alive) {
			arm();
			return;
		}
		stopped = true;
		void Promise.resolve()
			.then(() => options.onLost())
			.catch(() => undefined);
	};
	arm();
	return () => {
		stopped = true;
		if (timer !== undefined) clearTimer(timer);
		timer = undefined;
	};
}

/** What waiting for the OMP root's absence needs from the window. */
export interface WriterGonePorts {
	/** One exact proof: the broker's and the OMP root's recorded creation times name processes that are gone. `false` for anything less, including a probe that could not run. */
	prove(): Promise<boolean>;
	/** Whether any process still has the OMP root's id (a syscall). `false` is conclusive; `true` proves nothing about identity. */
	rootAlive(): boolean;
	/** `false` once the runtime is no longer the one this window drives: the wait ends. */
	isCurrent(): boolean;
	pause(ms: number): Promise<void>;
}

/** Looks at the OMP root's liveness this often, for this many looks (30 s), before giving up. */
const WRITER_WAIT_PAUSE_MS = 500;
const WRITER_WAIT_LOOKS = 60;
/** Probes asked once the root's id is gone, in case the first could not run. */
const WRITER_PROOF_TRIES = 3;

/**
 * Wait until the writer of a runtime whose broker is gone is proven gone, or the wait is spent.
 *
 * A broker's absence is not the OMP process's: Kill ends the broker first and then the OMP child, a
 * crash can leave the child running, and a probe can fail once. So the exact-root proof is asked at once,
 * then again only when the root's id stops existing (cheap looks, no process spawn) and once more at the
 * end (an id reissued to a stranger never stops existing). `true` only on a proof.
 */
export async function awaitWriterGone(ports: WriterGonePorts): Promise<boolean> {
	const prove = (): Promise<boolean> => ports.prove().catch(() => false);
	if (await prove()) return true;
	for (let look = 0; look < WRITER_WAIT_LOOKS; look++) {
		if (!ports.isCurrent()) return false;
		await ports.pause(WRITER_WAIT_PAUSE_MS);
		if (ports.rootAlive()) continue;
		for (let attempt = 0; attempt < WRITER_PROOF_TRIES; attempt++) {
			if (!ports.isCurrent()) return false;
			if (await prove()) return true;
			await ports.pause(WRITER_WAIT_PAUSE_MS);
		}
		return false;
	}
	return ports.isCurrent() && await prove();
}
