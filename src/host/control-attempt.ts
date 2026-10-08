/**
 * Which control attempt may still write into a tab.
 *
 * Establishing a host-control channel awaits: a rendezvous record has to appear, the
 * pipe server has to prove itself, and the handshake has to complete. The tab's
 * runtime can be replaced — or its channel replaced by a newer attempt — while any of
 * that is in flight, so an attempt's outcome must be published only into the tab it
 * started for, and only while no other channel has since taken that tab.
 *
 * Without this, a slow attempt for runtime A that finishes after runtime B has
 * established control would overwrite B's snapshot, or close B's perfectly good
 * channel on A's failure: an availability and state-corruption race, not an
 * admission hole, but one that makes the tab's control state depend on which attempt
 * happened to finish last.
 *
 * The predicates are deliberately structural (`unknown` clients compared by identity)
 * so the policy is unit-testable without a VS Code host, and so the extension host's
 * call sites read as one decision each.
 */

/**
 * The marker one attempt carries, created at its entry point **before the first
 * await**.
 *
 * Establishing a channel is not the only thing that awaits: the callers persist a
 * launch record and read the stored recipient first. The tab's runtime can be
 * replaced during any of those awaits — including by a process the OS gave the same
 * PID — so the attempt must carry the runtime it started for from the moment the
 * caller is entered, not from wherever the connection work happens to begin.
 */
export interface ControlAttemptPlan {
	/** The runtime object this attempt speaks for, captured before the first await. */
	readonly runtime: unknown | null;
	/** PID that runtime reported, captured at the same moment. */
	readonly pid: number;
}

/**
 * Whether a client still proves the channel it was opened on.
 *
 * A closed client keeps its binding readable but refuses `peerProof`, and a held
 * channel that proves nothing must not block the tab's next attempt: it is treated as
 * no channel at all. A non-client value is never an open channel.
 */
export function isOpenControlClient(client: unknown): boolean {
	if (client === null || typeof client !== "object" || !("peerProof" in client)) return false;
	try {
		void (client as { peerProof: unknown }).peerProof;
		return true;
	} catch {
		return false;
	}
}

/** The tab facts a publication decision depends on. */
export interface ControlTabTarget {
	/**
	 * The runtime object this tab runs right now, or null when it runs none.
	 *
	 * Compared by *identity*, not by PID: an OS can reuse a PID, and a runtime is a
	 * fresh object for every launch or attach, so object identity is what says "this is
	 * still the runtime the attempt started for" — including a restored runtime whose
	 * own `processCreation` is deliberately null.
	 */
	readonly runtime: unknown | null;
	/** PID of that runtime, or null when the tab runs none. A consistency check only. */
	readonly runtimePid: number | null;
	/** The control channel this tab holds right now, or null when it holds none. */
	readonly controlClient: unknown | null;
}

/** The attempt whose outcome is about to be published. */
export interface ControlAttempt {
	/** The runtime object the attempt started for, or null when it never resolved one. */
	readonly runtime: unknown | null;
	/** PID the attempt verified its channel against, or null when it never got that far. */
	readonly pid: number | null;
	/** The channel the attempt produced; null for an attempt that failed before one existed. */
	readonly client: unknown | null;
}

/**
 * Whether a *successful* attempt may publish its channel into the tab.
 *
 * It may not when the tab runs no runtime, when the tab's runtime is no longer the
 * *exact runtime* the attempt started for, or when another channel has already taken
 * the tab — the newer channel is the one this window proved for the current runtime.
 *
 * The runtime comparison is by identity because a PID is not a generation: an OS can
 * hand the same PID to a later process, so a PID-only check could let an attempt that
 * verified a process which has since exited publish into its successor's tab.
 */
export function mayPublishControlChannel(target: ControlTabTarget | null, attempt: ControlAttempt): boolean {
	if (attempt.client === null) return false;
	if (target === null || target.runtime === null || attempt.runtime === null) return false;
	if (target.runtime !== attempt.runtime) return false;
	// The PIDs must still agree, so a mismatched pair cannot pass by identity alone.
	if (target.runtimePid === null || attempt.pid === null || target.runtimePid !== attempt.pid) return false;
	return target.controlClient === null;
}

/**
 * Whether a *failed* attempt may report its failure on the tab.
 *
 * A failure may only be reported for the attempt that still owns the tab: reporting
 * it later would close the channel a newer attempt established (the failure path
 * clears whatever channel the tab holds). So an attempt that produced a channel
 * speaks for exactly that channel, and an attempt that never got that far — a
 * rendezvous timeout, a handshake failure — may only report on a tab that holds no
 * channel at all: the tab running the same process again is not the same thing as
 * this attempt still owning it.
 */
export function mayReportControlFailure(target: ControlTabTarget | null, attempt: ControlAttempt): boolean {
	if (target === null) return false;
	if (attempt.client !== null) return target.controlClient === attempt.client;
	if (target.runtime === null || attempt.runtime === null) return false;
	if (target.runtime !== attempt.runtime) return false;
	if (attempt.pid !== null && target.runtimePid !== attempt.pid) return false;
	return target.controlClient === null;
}

/**
 * Whether a read back from one channel may be recorded on the tab.
 *
 * A snapshot is only ever written for the channel the tab currently holds: a read
 * that finished after the channel was replaced describes a process this window no
 * longer speaks for.
 */
export function mayRefreshControlSnapshot(target: ControlTabTarget | null, client: unknown): boolean {
	return target !== null && target.controlClient === client;
}
