/**
 * One window's proof state for the staged PTY runtime, over a probe that can come back
 * inconclusive
 * ([ADR-0032](../../docs/decisions/0032-prove-the-pty-runtime-with-a-console-child.md),
 * 2026-10-12 amendment).
 *
 * A probe answers one of three ways (`src/host/pty-runtime.ts`): proven, refused because
 * it *observed* a fault, or admitted provisionally because it ran out of time with
 * nothing observed to be wrong. A slow machine produces the third answer, and a session
 * start must not fail because a health probe was slow. So:
 *
 * - a proven answer is kept for the activation;
 * - a provisional answer lets the launch proceed — the real spawn reports its own
 *   failure — and is **not** kept as a proof: one background re-run with the extended
 *   deadline starts {@link PTY_REPROBE_DELAY_MS} later, after the launch that triggered it
 *   has had the CPU. That run either proves the tree (kept), or refuses it;
 * - a refusal from that re-run is held for {@link PTY_FAULT_HOLD_MS}, so launches in that
 *   minute get the fault instead of another provisional admission on the same broken tree
 *   (a tree that really delivers nothing would otherwise be admitted again by every fresh
 *   short probe). The hold is short because the refusal can also be a probe that was
 *   starved past even the extended window, and the load may be gone a minute later;
 * - a refusal from the first probe is not held, as before: its usual cause is a
 *   staging pass the next call may see fixed.
 */
import { SELF_CHECK_EXTENDED_DEADLINE_MS } from "../broker/pty-self-check.ts";
import type { Logger } from "../shared/logger.ts";
import type { PtyRuntimeReadiness, ReusedPtyProof } from "./pty-runtime.ts";

/** How long after a provisional admission the extended re-run starts. */
export const PTY_REPROBE_DELAY_MS = 20_000;

/** How long a refusal found by the extended re-run is held before a fresh probe may run. */
export const PTY_FAULT_HOLD_MS = 60_000;

/** How many times the re-run is attempted when it throws instead of answering. */
const PTY_REPROBE_ATTEMPTS = 3;

export interface PtyRuntimeProofInput {
	/** One probe; `undefined` is the entry's default deadline. */
	probe(deadlineMs: number | undefined): Promise<PtyRuntimeReadiness>;
	/** Where state changes worth a log line go. */
	readonly log?: Logger;
	/** Test seam; defaults to `Date.now`. */
	readonly now?: () => number;
	/** Test seam: runs `run` after `delayMs` and returns its cancel. Defaults to an unreferenced timer. */
	readonly schedule?: (run: () => void, delayMs: number) => () => void;
}

function defaultSchedule(run: () => void, delayMs: number): () => void {
	const timer = setTimeout(run, delayMs);
	timer.unref();
	return () => clearTimeout(timer);
}

/**
 * How long the proof took, for the Output log: the self-check's own run as the entry
 * measured it, and the whole probe (listing, staging and hashing the tree, then the check)
 * as this host saw it. The numbers decide whether proving once per window is worth
 * sharing across windows.
 */
function probeTiming(readiness: PtyRuntimeReadiness, elapsedMs: number): string {
	const check = readiness.runtime?.selfCheck?.durationMs ?? -1;
	return check < 0 ? `ready in ${elapsedMs} ms` : `self-check ${check} ms, ready in ${elapsedMs} ms`;
}

export class PtyRuntimeProof {
	private readonly input: PtyRuntimeProofInput;
	private readonly now: () => number;
	private readonly schedule: (run: () => void, delayMs: number) => () => void;
	private proven: PtyRuntimeReadiness | null = null;
	private provisional: PtyRuntimeReadiness | null = null;
	private fault: { readonly readiness: PtyRuntimeReadiness; readonly until: number } | null = null;
	/** The first probe in flight, shared by every caller that arrives while it runs. */
	private first: Promise<PtyRuntimeReadiness> | null = null;
	private reprobes = 0;

	constructor(input: PtyRuntimeProofInput) {
		this.input = input;
		this.now = input.now ?? Date.now;
		this.schedule = input.schedule ?? defaultSchedule;
	}

	/** The proven answer, or `null` while the runtime is unproven, provisional or refused. */
	provenAnswer(): PtyRuntimeReadiness | null {
		return this.proven;
	}

	/**
	 * Stop believing a proof that was read from an earlier window's store, because a launch that
	 * relied on it failed before a broker existed. Returns what was withdrawn (so the caller can
	 * delete the stored file) or `null` when the proof was computed here and stays. The next
	 * {@link ready} runs the whole probe again.
	 */
	discardReusedProof(): ReusedPtyProof | null {
		const reused = this.proven?.reusedProof ?? null;
		if (reused === null) return null;
		this.proven = null;
		this.input.log?.warn(`PTY runtime proof reused from ${reused.provedAt} withdrawn after a launch failed; the next launch runs the self-check`);
		return reused;
	}

	/**
	 * Whether a broker may be started now: proven, provisional, or refused with the reason.
	 * Never waits for the re-run of a provisional answer.
	 */
	async ready(): Promise<PtyRuntimeReadiness> {
		if (this.proven !== null) return this.proven;
		if (this.fault !== null) {
			if (this.now() < this.fault.until) return this.fault.readiness;
			this.fault = null;
		}
		if (this.provisional !== null) return this.provisional;
		this.first ??= this.probeFirst();
		return await this.first;
	}

	private async probeFirst(): Promise<PtyRuntimeReadiness> {
		const started = this.now();
		try {
			const readiness = await this.input.probe(undefined);
			if (readiness.ready && readiness.proven) {
				this.proven = readiness;
				this.input.log?.info(
					readiness.reusedProof === undefined
						? `PTY runtime proved itself: ${probeTiming(readiness, this.now() - started)}`
						: `PTY runtime proof reused from ${readiness.reusedProof.provedAt}: ready in ${this.now() - started} ms`,
				);
			} else if (readiness.ready) {
				this.provisional = readiness;
				this.input.log?.warn(`PTY runtime admitted unproven after ${this.now() - started} ms: ${readiness.reason ?? "the self-check was inconclusive"}`);
				this.reprobes = 0;
				this.scheduleReprobe();
			}
			return readiness;
		} finally {
			this.first = null;
		}
	}

	private scheduleReprobe(): void {
		this.schedule(() => void this.reprobe(), PTY_REPROBE_DELAY_MS);
	}

	private async reprobe(): Promise<void> {
		this.reprobes += 1;
		const started = this.now();
		let readiness: PtyRuntimeReadiness;
		try {
			readiness = await this.input.probe(SELF_CHECK_EXTENDED_DEADLINE_MS);
		} catch (error) {
			this.input.log?.warn(`PTY runtime re-check could not run: ${error instanceof Error ? error.message : String(error)}`);
			if (this.reprobes < PTY_REPROBE_ATTEMPTS) {
				this.scheduleReprobe();
			} else {
				// Never left admitted on a check that could not run: the next launch probes afresh.
				this.provisional = null;
			}
			return;
		}
		if (readiness.ready && readiness.proven) {
			this.proven = readiness;
			this.provisional = null;
			this.input.log?.info(
				readiness.reusedProof === undefined
					? `PTY runtime proved itself on the repeated self-check: ${probeTiming(readiness, this.now() - started)}`
					: `PTY runtime proof reused from ${readiness.reusedProof.provedAt}: ready in ${this.now() - started} ms`,
			);
		} else if (readiness.ready) {
			// Cannot happen with the extended deadline (the host refuses a late answer to it),
			// but a probe that did not decide is not kept: the next launch probes afresh.
			this.provisional = null;
			this.input.log?.warn(`PTY runtime still unproven after the repeated self-check: ${readiness.reason ?? "inconclusive"}`);
		} else {
			const refused: PtyRuntimeReadiness = {
				...readiness,
				reason: `the repeated self-check refused the runtime that was admitted unproven: ${readiness.reason ?? "no reason given"}`,
			};
			this.provisional = null;
			this.fault = { readiness: refused, until: this.now() + PTY_FAULT_HOLD_MS };
			this.input.log?.error(`PTY runtime refused: ${refused.reason}`);
		}
	}
}
