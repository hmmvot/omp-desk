/**
 * Stop one extension broker through its own authenticated connection, and nothing else.
 *
 * This is the stop path of the Processes view for a broker no Sessions row can stop for
 * it: a folder terminal, an orphan, a slot whose row has no recorded host, and any broker
 * whose child already exited (which `stopBrokerOwnedHost` refuses). It never signals a
 * process id (ADR-0029, ADR-0037, ADR-0039): the broker stops its own child through the
 * handles it holds, and then retires itself.
 *
 * ## Order
 *
 * 1. Read the record and require it still names the broker the caller captured (slot,
 *    `brokerId`, generation, PID); attach **without an owner hint**, which neither admits
 *    nor disarms a folder shell's owner cleanup (ADR-0030). `PtyBrokerClient` proves the
 *    broker's kernel identity and the handshake before any of this runs.
 * 2. Require the authenticated handshake to name the same slot, `brokerId`, generation and
 *    PID as the captured target.
 * 3. Child running: `stop` it in the requested mode and require `pidGone`. The tree is
 *    never claimed empty — the broker cannot prove it on Windows — so the result carries
 *    the broker's own words.
 * 4. Child gone (or never running): `shutdown({ requireStopped: true })`, then wait for the
 *    broker PID to disappear by creation-time reading. The broker removes its own record;
 *    this module never touches one.
 */

import type { ProbeHandle } from "./rpc-reconcile";
import type { PtyBrokerClient } from "./pty-client.ts";
import type { PtyKind } from "./pty-protocol.ts";

/** Bound for the child to stop; the broker answers within it. */
export const BROKER_PROCESS_STOP_TIMEOUT_MS = 15_000;
/** Bound for the broker PID to disappear after an accepted shutdown. */
export const BROKER_PROCESS_EXIT_TIMEOUT_MS = 10_000;

/** The broker one stop addresses, captured before its confirmation. */
export interface BrokerStopTarget {
	readonly slot: string;
	readonly kind: PtyKind;
	readonly brokerId: string;
	readonly generation: string;
	readonly brokerPid: number;
	readonly brokerCreationTime: string;
}

export type BrokerStopAttach =
	| { readonly ok: true; readonly handle: ProbeHandle }
	| { readonly ok: false; readonly reason: string };

export interface BrokerStopPorts {
	/** Attach to the recorded broker, read-only and without an owner hint. */
	attach(target: BrokerStopTarget): Promise<BrokerStopAttach>;
	/** Wait for the broker PID to disappear, by creation-time readings. */
	waitBrokerGone(target: BrokerStopTarget, timeoutMs: number): Promise<{ readonly gone: boolean; readonly detail: string }>;
	log(message: string): void;
	readonly stopTimeoutMs?: number;
	readonly exitTimeoutMs?: number;
}

export type BrokerStopMode = "graceful" | "force";

export type BrokerStopOutcome =
	/** The child is gone (or was) and the broker accepted shutdown. `brokerGone` says whether its PID disappeared in time. */
	| { readonly kind: "stopped"; readonly childWasRunning: boolean; readonly brokerGone: boolean; readonly detail: string }
	/** Nothing was sent: the target could not be proved. */
	| { readonly kind: "refused"; readonly reason: string }
	/** The request was sent and its effect is not confirmed. `canForce` is true after a failed graceful stop. */
	| { readonly kind: "unconfirmed"; readonly detail: string; readonly canForce: boolean };

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** One stop attempt in `mode`. Never throws. */
export async function stopBrokerThroughBroker(
	target: BrokerStopTarget,
	mode: BrokerStopMode,
	ports: BrokerStopPorts,
): Promise<BrokerStopOutcome> {
	const attached = await ports.attach(target);
	if (!attached.ok) return { kind: "refused", reason: attached.reason };
	const { handle } = attached;
	try {
		const record = handle.record;
		if (
			handle.slot !== target.slot ||
			record.slot !== target.slot ||
			record.brokerId !== target.brokerId ||
			record.generation !== target.generation ||
			handle.brokerPid !== target.brokerPid
		) {
			return { kind: "refused", reason: "the process changed since it was shown; refresh Processes and try again" };
		}
		if (handle.kind !== target.kind) {
			return { kind: "refused", reason: "the process type changed since it was shown; refresh Processes and try again" };
		}
		const childWasRunning = handle.state === "running";
		let childDetail = "Its OMP process had already exited.";
		if (childWasRunning) {
			let result;
			try {
				result = await handle.stop({ mode, timeoutMs: ports.stopTimeoutMs ?? BROKER_PROCESS_STOP_TIMEOUT_MS });
			} catch (error) {
				ports.log(`broker stop ${target.slot}: ${messageOf(error)}`);
				return {
					kind: "unconfirmed",
					detail: "The stop request could not be confirmed. Try Stop again; see OMP Desk output for details.",
					canForce: mode === "graceful",
				};
			}
			if (!result.pidGone) {
				ports.log(`broker stop ${target.slot}: ${result.detail}`);
				return {
					kind: "unconfirmed",
					detail: "It could not be confirmed stopped. Try Stop again; see OMP Desk output for details.",
					canForce: mode === "graceful",
				};
			}
			// The broker cannot prove the whole tree empty on Windows (ADR-0029), so the result never claims it; the
			// user-facing text stays short and the caveat is documented rather than shown.
			childDetail = "Its OMP process is gone.";
		}
		let shutdown;
		try {
			shutdown = await handle.shutdown({ requireStopped: true });
		} catch (error) {
			ports.log(`broker shutdown ${target.slot}: ${messageOf(error)}`);
			return {
				kind: "unconfirmed",
				detail: `${childDetail} Its background process did not close. Try Stop again.`,
				canForce: false,
			};
		}
		if (!shutdown.stopped) {
			ports.log(`broker shutdown ${target.slot}: ${JSON.stringify(shutdown)}`);
			return {
				kind: "unconfirmed",
				detail: `${childDetail} Its background process did not close. Try Stop again.`,
				canForce: false,
			};
		}
		const gone = await ports.waitBrokerGone(target, ports.exitTimeoutMs ?? BROKER_PROCESS_EXIT_TIMEOUT_MS);
		ports.log(`broker exit ${target.slot}: ${gone.detail}`);
		return {
			kind: "stopped",
			childWasRunning,
			brokerGone: gone.gone,
			detail: gone.gone ? childDetail : `${childDetail} Its background process is still closing.`,
		};
	} finally {
		handle.disconnect();
	}
}

/**
 * The real attach: the record's own kind picks the attach path, and the record must still
 * be the captured broker before the connection is trusted.
 */
export function brokerStopAttachFor(client: PtyBrokerClient, log: (message: string) => void): BrokerStopPorts["attach"] {
	return async target => {
		let lookup;
		try {
			lookup = await client.readRecord(target.slot);
		} catch (error) {
			log(`broker record ${target.slot}: ${messageOf(error)}`);
			return { ok: false, reason: "the saved connection could not be read; refresh Processes and try again" };
		}
		if (lookup.kind === "none") return { ok: false, reason: "that process is no longer listed; refresh Processes" };
		if (lookup.kind === "invalid") return { ok: false, reason: "the saved connection could not be read; refresh Processes and try again" };
		const record = lookup.record;
		if (
			record.slot !== target.slot ||
			record.brokerId !== target.brokerId ||
			record.generation !== target.generation ||
			record.brokerPid !== target.brokerPid ||
			record.brokerCreationTime !== target.brokerCreationTime
		) {
			return { ok: false, reason: "the process changed since it was shown; refresh Processes and try again" };
		}
		let outcome;
		try {
			outcome =
				record.kind === "managed-rpc"
					? await client.attachRpcRecord(record, { adopted: true })
					: await client.attachRecord(record, { adopted: true });
		} catch (error) {
			log(`broker attach ${target.slot}: ${messageOf(error)}`);
			return { ok: false, reason: "this window could not connect to that process safely; refresh Processes and try again" };
		}
		if (outcome.handle === null) {
			return { ok: false, reason: "this window could not connect to that process safely; refresh Processes and try again" };
		}
		return { ok: true, handle: outcome.handle as unknown as ProbeHandle };
	};
}
