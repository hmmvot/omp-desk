/**
 * One window's proof that the staged PTY broker runtime is usable.
 *
 * `PtyBrokerClient.ready()` deliberately refuses to cache a *failure*: the usual cause
 * is a staging or self-check pass that has not finished, and the next call should see
 * the fix. A window that latched the first failure for the lifetime of the extension
 * host would defeat that. After a full VS Code restart, a surviving broker whose runtime
 * self-check failed once (a transient staging collision, say) would stay unadoptable for
 * every later reconciliation, attach and open, and every row would report the PTY broker
 * as unavailable while its writer was still running and recoverable.
 *
 * So this gate latches only success:
 *
 * - one attempt at a time per window, shared by every caller that arrives while it runs;
 * - a proven runtime is kept for the activation, so nothing is staged twice;
 * - a failed check is kept for {@link PTY_READINESS_RETRY_MS}, so a startup pass that
 *   reconciles many rows cannot run one staging attempt per row; after that window the
 *   next row, click, ownership recheck or attach retries it;
 * - a retry is only a readiness check: it starts no broker, OMP host or session, so no
 *   launch becomes less admitted than it was.
 */
import type { PtyBrokerClient } from "./pty-client";

/** How long a failed readiness check is kept before the next caller retries it. */
export const PTY_READINESS_RETRY_MS = 2_000;

export interface PtyReadinessGate {
	/** The client when the runtime is proven ready now, or `null` when it is not (yet). */
	client(): Promise<PtyBrokerClient | null>;
	/**
	 * The client when it can re-adopt an already-running broker, or `null` when it cannot (yet).
	 *
	 * Weaker than {@link client} on purpose: an attach needs only the verified identity probe,
	 * so it does not wait for the broker tree's staging and self-check, which guard *starting*
	 * a child (ADR-0032). A fully proven runtime answers here too.
	 */
	attachClient(): Promise<PtyBrokerClient | null>;
	/** Why the last check did not prove the runtime, or `null` when it did. */
	reason(): string | null;
	/**
	 * Forget a failed check, so the next caller retries it immediately.
	 *
	 * A user who explicitly opens or resumes a row is asking this window to recheck it
	 * now, and must never be answered from a backoff meant for a background pass over
	 * many rows.
	 */
	invalidate(): void;
}

export function createPtyReadinessGate(input: {
	readonly client: PtyBrokerClient;
	/** Notified once per failed check, so the window can log the staging failure. */
	readonly onFailure?: (reason: string) => void;
	/** Test seam; defaults to {@link PTY_READINESS_RETRY_MS}. */
	readonly retryMs?: number;
	/** Test seam; defaults to `Date.now`. */
	readonly now?: () => number;
}): PtyReadinessGate {
	const retryMs = input.retryMs ?? PTY_READINESS_RETRY_MS;
	const now = input.now ?? Date.now;
	let reason: string | null = null;
	let proven = false;
	/** Epoch ms before which a failed check is not repeated; `0` once proven. */
	let retryAt = 0;
	/** The check in flight, so callers that arrive together share one attempt. */
	let attempt: Promise<boolean> | null = null;
	let attachProven = false;
	let attachRetryAt = 0;
	let attachAttempt: Promise<boolean> | null = null;

	const checkAttach = async (): Promise<boolean> => {
		try {
			const ready = await input.client.attachReady();
			attachProven = ready.ready;
			attachRetryAt = ready.ready ? 0 : now() + retryMs;
			if (!ready.ready) {
				reason = ready.reason;
				input.onFailure?.(ready.reason ?? "the identity probe did not prove itself");
			}
			return ready.ready;
		} catch (error) {
			reason = error instanceof Error ? error.message : String(error);
			attachRetryAt = now() + retryMs;
			input.onFailure?.(reason);
			return false;
		} finally {
			attachAttempt = null;
		}
	};

	const check = async (): Promise<boolean> => {
		try {
			const ready = await input.client.ready();
			reason = ready.reason;
			proven = ready.ready;
			retryAt = ready.ready ? 0 : now() + retryMs;
			if (!ready.ready) input.onFailure?.(reason ?? "the staged runtime did not prove itself");
			return ready.ready;
		} catch (error) {
			reason = error instanceof Error ? error.message : String(error);
			retryAt = now() + retryMs;
			input.onFailure?.(reason);
			return false;
		} finally {
			attempt = null;
		}
	};

	return {
		async client(): Promise<PtyBrokerClient | null> {
			if (proven) return input.client;
			// A failure this window just saw is not retried per caller: a pass over many
			// rows must not run one staging attempt per row.
			if (attempt === null && now() < retryAt) return null;
			const pending = attempt ?? (attempt = check());
			return (await pending) ? input.client : null;
		},
		async attachClient(): Promise<PtyBrokerClient | null> {
			if (proven || attachProven) return input.client;
			if (attachAttempt === null && now() < attachRetryAt) return null;
			const pending = attachAttempt ?? (attachAttempt = checkAttach());
			return (await pending) ? input.client : null;
		},
		reason: () => reason,
		invalidate: () => {
			if (!proven) retryAt = 0;
			if (!attachProven) attachRetryAt = 0;
		},
	};
}
