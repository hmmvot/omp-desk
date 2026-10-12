/**
 * Wait for a runtime's exit cleanup before a request that needs the tab.
 *
 * A chat that lost its process shows the ended state at once (the channel closes the moment the exit is
 * known), while the exit transaction that proves the writer gone, clears the runtime, records the stopped intent,
 * releases the host control and the claim runs under the tab's lifecycle gate for another second or so. The page offers
 * Resume as soon as it shows the ended state, so a click can arrive while the tab still holds the dead runtime; the
 * ordinary open then finds a runtime in place, treats the session as already running here and starts nothing.
 *
 * The click is not refused and not lost: it waits until the tab no longer holds that runtime, then until the
 * lifecycle operations queued on the tab have drained, and then runs. A cleanup that never completes ends the wait at the
 * deadline and the request continues, so it is answered with the reason the tab records instead of hanging.
 *
 * No `vscode` import; every effect is a port.
 */

/** How long a request waits for an ended runtime's cleanup. */
export const RUNTIME_SETTLE_TIMEOUT_MS = 40_000;
const POLL_MS = 25;

export interface RuntimeSettlePorts {
	/** Whether the tab still holds the runtime that ended. */
	holdsEndedRuntime(): boolean;
	/** Resolves once the lifecycle operations already queued on the tab have finished. */
	drainLifecycle(): Promise<void>;
	pause(ms: number): Promise<void>;
	now(): number;
}

/** `true` when the ended runtime was released (the request may proceed on a settled tab); `false` when the wait ran out. */
export async function awaitEndedRuntimeCleanup(ports: RuntimeSettlePorts, timeoutMs = RUNTIME_SETTLE_TIMEOUT_MS): Promise<boolean> {
	const deadline = ports.now() + timeoutMs;
	while (ports.holdsEndedRuntime()) {
		if (ports.now() >= deadline) return false;
		await ports.pause(POLL_MS);
	}
	// The runtime is cleared early in the transaction; what follows it (intent, control material, claim) is still in flight.
	// The drain is bounded by what is left of the deadline: a caller that itself holds the tab's gate would otherwise wait on itself.
	const remaining = Math.max(0, deadline - ports.now());
	return await Promise.race([ports.drainLifecycle().then(() => true), ports.pause(remaining).then(() => false)]);
}
