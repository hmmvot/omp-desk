/**
 * Whether the window that filed a session claim is alive, for what the Sessions view shows and where a click goes.
 *
 * A window is proven alive by its own record in the window registry (a fresh lease and an
 * extension-host process that still exists, ADR-0056), which costs no process spawn. Only a holder the
 * registry does not know falls back to {@link claimHolderSeemsAlive}, whose start-time reading is a
 * PowerShell command: seconds on a busy machine, and a reading that times out says "not alive", which
 * turned every row another window runs into a plain "Running" row with no mark, and made a click wait
 * for the command before it chose between switching and launching.
 *
 * Display and navigation only. A launch, a stop or a deletion keeps asking {@link claimHolderMayBeAlive}.
 */

import { claimHolderSeemsAlive } from "./session-claim.ts";
import type { ObservedClaim } from "./session-claim.ts";

/** The registry's answer about a holder: the extension-host pid of its live window, or `null`. */
export interface LiveHolderSource {
	liveHolderPid(holderId: string): number | null;
}

export async function holderSeemsAlive(
	claim: ObservedClaim,
	registry: LiveHolderSource | undefined,
	fallback: (claim: ObservedClaim) => Promise<boolean> = claimHolderSeemsAlive,
): Promise<boolean> {
	if (!claim.verifiable || claim.pid === null || claim.holderId === null) return false;
	const registered = registry?.liveHolderPid(claim.holderId) ?? null;
	// The claim names the process that filed it; a window of that holder id in another process is not it.
	if (registered !== null && registered === claim.pid) return true;
	return await fallback(claim);
}
