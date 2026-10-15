/**
 * The process that executes a stop request of Kill All, and the only evidence that it ended.
 *
 * A request addressed to another window is served by that window's extension host. A host that stopped renewing its
 * registry lease, whose record was swept, or whose registry could not be read may still be running and may still
 * resume a request it already took up, so none of those lets the requester act on the same processes. Only the
 * process identity does: the requester records the host's process id and kernel creation time when it asks, and a
 * request that may still be served is given up on only when that exact process is proven gone (the kernel no longer
 * has it, or its id belongs to a process created later). A probe that cannot decide is not evidence.
 *
 * VS Code-free: the probe is injected.
 */

import type { PeerExecutor, KillAllPeer } from "./broker-process-controller.ts";
import type { PtyGoneReading, PtyIdentityReading } from "./pty-identity.ts";

/** How long a requester waits for a silent window's host to be proven gone before leaving its rows alone. */
export const PEER_EXECUTOR_PROBE_MS = 3_000;

/** The kernel readings the proof needs. */
export interface PeerExecutorProbe {
	read(pid: number): Promise<PtyIdentityReading>;
	waitGone(pid: number, creationTime: string, timeoutMs: number): Promise<PtyGoneReading>;
}

/** The host process behind `hostPid` as the kernel reports it now, or `null` when it cannot be identified (it is then never provably gone). */
export async function identifyPeerExecutor(hostPid: number | null, probe: PeerExecutorProbe): Promise<PeerExecutor | null> {
	if (hostPid === null) return null;
	try {
		const reading = await probe.read(hostPid);
		return reading.kind === "found" ? { pid: hostPid, creationTime: reading.creationTime } : null;
	} catch {
		return null;
	}
}

/** Whether the executor `peer` was identified as is positively gone. Never throws; anything undecided is `gone: false`. */
export async function proveExecutorGone(
	peer: Pick<KillAllPeer, "executor">,
	probe: PeerExecutorProbe,
	timeoutMs: number = PEER_EXECUTOR_PROBE_MS,
): Promise<{ readonly gone: boolean; readonly detail: string }> {
	if (peer.executor === null) return { gone: false, detail: "the window's process could not be identified when it was asked" };
	try {
		return await probe.waitGone(peer.executor.pid, peer.executor.creationTime, timeoutMs);
	} catch (error) {
		return { gone: false, detail: `the process probe failed: ${error instanceof Error ? error.message : String(error)}` };
	}
}
