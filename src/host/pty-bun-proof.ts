/**
 * The Bun plan's pipe-only self-check of a Chat broker (ADR-0074), run so that an overlap with the window's first full runtime
 * proof cannot by itself move a Chat off Bun.
 *
 * A Chat start no longer waits for the full proof (`PtyReadinessGate.chatLaunchClient`), so on a build seen for the first time, or
 * after the stored proofs went stale, the two self-checks run at once on a machine that is already slow: the full one runs a pipe
 * child and so does this one, each under the same 15 s deadline. An inconclusive answer of this check that came while the full probe
 * was running says little about the Bun runtime, and acting on it (the Code.exe fallback and the ten-minute hold) would trade the
 * runtime ADR-0074 exists to give for a saved wait. So that answer, and only that one, is not acted on: the check waits for the
 * full probe to answer (the fallback would wait for it anyway) and runs once more on a quieter machine. The second answer is judged
 * by the ordinary rules, except that a second inconclusive answer, which may itself have been contended, falls back for this launch
 * without the ten-minute hold. A refusal (a fault was observed) and a proof are never retried, and an inconclusive answer with no
 * full probe running at the start or at the end of it is judged at once.
 */
import type { PtyRuntimeReadiness } from "./pty-runtime.ts";

export interface BunProofInput {
	/** One pipe-only check of the executable; every call is a fresh check. */
	readonly prove: () => Promise<PtyRuntimeReadiness>;
	/** Whether this window's first full probe is running now. */
	readonly fullProbeRunning: () => boolean;
	/** Settles when the full probe that is running now has answered; at once when none is. */
	readonly fullProbeSettled: () => Promise<void>;
}

export interface BunProofResult {
	readonly readiness: PtyRuntimeReadiness;
	/** The check ran a second time because the first was inconclusive while the full probe was running. */
	readonly retried: boolean;
}

export async function proveBunRuntime(input: BunProofInput): Promise<BunProofResult> {
	const overlappedAtStart = input.fullProbeRunning();
	const first = await input.prove();
	const inconclusive = first.ready && !first.proven;
	if (!inconclusive || !(overlappedAtStart || input.fullProbeRunning())) return { readiness: first, retried: false };
	await input.fullProbeSettled();
	return { readiness: await input.prove(), retried: true };
}
