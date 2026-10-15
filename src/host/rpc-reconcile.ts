/**
 * What this window can prove about the writer of a session row, from the broker.
 *
 * A row recorded by this build is a `managed-rpc` child of a detached broker (ADR-0038):
 * its identity is the broker (pid + creation time + generation) and the OMP child
 * (pid + creation time) the launch read, and every verdict below is a statement about
 * that recorded pair. A row recorded by an earlier build (`transport !== "rpc"`) named
 * a Collab room this version can no longer read; it is only ever *observed* (a broker
 * slot of kind `managed-omp`, or a hidden terminal) and never attached or driven.
 *
 * Probes never launch, stop, signal or adopt. Their read-only broker attachment carries
 * no owner hint, and every connection is closed on every path. Explicit recorded-host
 * Stop is the separate, user-authorized stop-and-empty-broker-shutdown path below.
 * Every failure text is authored here: a broker's or helper's own text reaches a
 * persisted row detail, a panel and a notification, so it is never forwarded (ADR-0017).
 *
 * Nothing in this module imports `vscode`: the terminal question is a port.
 */
import type { BrokerSlotProvenance } from "./broker-slots";
import type { PtyShutdownResult } from "./broker-handle";
import type { PtyIdentityReading } from "./pty-identity";
import type { PtyBrokerClient } from "./pty-client";
import { attestationOf } from "./pty-protocol";
import type { PtyBrokerRecord, PtyKind, PtyStatusPayload, PtyStopResult } from "./pty-protocol";
import { isManagedHost } from "./session-model";
import type { RecordedRpcIdentity } from "./session-model";
import type {
	AttachPin,
	OwnerAbsenceEvidence,
	OwnerReconcileRequest,
	OwnerReconciler,
	OwnerVerdict,
} from "./session-availability";

/** Bounded wait for the process to disappear after a stop. */
export const HOST_STOP_TIMEOUT_MS = 15_000;

/** The broker half of {@link AttachPin}: what one read-only probe proved. */
export type BrokerPin = AttachPin;

/** What a read-only probe of one recorded broker slot established. */
export type BrokerProbeResult =
	| { readonly ok: true; readonly pin: BrokerPin }
	| { readonly ok: false; readonly reason: string };

/** Kernel creation-time reading of one process id. */
export type NativeGenerationReader = (pid: number) => Promise<PtyIdentityReading>;

/**
 * The live facts an attached broker handle answers for a probe.
 *
 * Deliberately structural: a probe reads only these, so a test can drive it without a
 * broker, and production passes the real `RpcHandle`/`PtyHandle`.
 */
export interface AttachedBrokerHandle {
	readonly slot: string;
	readonly kind: PtyKind;
	readonly brokerPid: number;
	readonly record: PtyBrokerRecord;
	readonly nativePid: number | null;
	readonly nativeCreationTime: string | null;
	readonly state: "running" | "exited" | null;
	/** The last status the broker reported; its attestation decides whether a kernel reading of the child is needed. Absent from a test handle. */
	readonly statusValue?: PtyStatusPayload | null;
}

/** An attached handle a probe or a stop must be able to close. */
export interface ProbeHandle extends AttachedBrokerHandle {
	disconnect(): void;
	stop(options: { readonly mode?: "graceful" | "force"; readonly timeoutMs?: number }): Promise<PtyStopResult>;
	shutdown(options?: { readonly requireStopped?: boolean }): Promise<PtyShutdownResult>;
}

/**
 * Current positive child ownership. `missing` and `failed` mean "not owned", not evidence of
 * absence; only `idle` can support automatic relaunch evidence.
 */
export type BrokerSlotProbeResult =
	| { readonly kind: "idle" }
	| { readonly kind: "live"; readonly pid: number }
	| { readonly kind: "missing" }
	| { readonly kind: "failed"; readonly reason: string };

/** What a probe of one `managed-rpc` slot established about the row's recorded child. */
export type RpcProbeResult =
	/** The recorded child runs under the recorded broker generation, proven by both readings. */
	| { readonly kind: "attachable"; readonly pin: BrokerPin }
	/** The authenticated broker reports the recorded child exited. */
	| { readonly kind: "child-exited"; readonly childPid: number; readonly brokerGeneration: string }
	/** The slot now names another launch, or a child that is not the recorded one. */
	| { readonly kind: "mismatch"; readonly reason: string }
	/** No broker record is retained for the slot. */
	| { readonly kind: "no-record" }
	/** A record exists but the broker could not be authenticated or read. */
	| { readonly kind: "unreachable"; readonly reason: string };

interface RpcProbeFlight {
	readonly expected: RecordedRpcIdentity;
	readonly reader: NativeGenerationReader | undefined;
	readonly promise: Promise<RpcProbeResult>;
}

const rpcProbeFlights = new WeakMap<PtyBrokerClient, Map<string, RpcProbeFlight[]>>();

/**
 * What the reconciler reads besides the durable rows.
 *
 * Injected so the ownership policy is decided by named facts instead of by whatever
 * global happens to be assigned: a test supplies its own slot table, probes and process
 * readings, and production supplies the durable broker-slot table, the PTY broker
 * client, the staged kernel probe and this window's terminals.
 */
export interface OwnerReconcilePorts {
	/**
	 * The kernel creation time of whatever process now occupies one pid.
	 *
	 * A numeric pid is not an identity: the operating system reuses it. `unknown` is never
	 * "gone".
	 */
	readProcessIdentity(pid: number): Promise<PtyIdentityReading>;
	/** Whether a process with this pid exists at all (a coarse liveness check). */
	isProcessAlive(pid: number): boolean;
	/** The durable broker slot this row's host was started under, or `null`. */
	brokerSlot(request: OwnerReconcileRequest): string | null;
	/**
	 * The row's recorded broker provenance, without loss: an unreadable provenance is
	 * uncertainty, never absence.
	 */
	brokerProvenance(request: OwnerReconcileRequest): BrokerSlotProvenance;
	/** Prove one `managed-rpc` row's recorded child from a read-only broker attachment. */
	probeRpc(slot: string, expected: RecordedRpcIdentity, kind?: "managed-rpc" | "managed-omp"): Promise<RpcProbeResult>;
	/**
	 * Whether one slot's broker record still owns a *running* child, read-only.
	 *
	 * Asks about no particular process, because an unidentified attempt never recorded
	 * one: the slot itself is the row's identity. `recordedPid` narrows the answer when the
	 * row recorded one.
	 */
	probeBrokerSlot(slot: string, recordedPid: number | null): Promise<BrokerSlotProbeResult>;
	/** Whether this window holds the identical hidden VS Code terminal of one pid (legacy hosts). */
	hasTerminal(pid: number): Promise<boolean>;
}

/** Build the reconciler this window reconciles ownership with. */
export function createOwnerReconciler(ports: OwnerReconcilePorts): OwnerReconciler {
	return { reconcile: request => reconcileOwner(request, ports) };
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * The exact managed host one attachment proves, or why it proves nothing.
 *
 * Every clause is a live fact the broker answered about *its own* child, plus one fact about
 * the child's kernel creation time: it must equal the value the broker captured when it spawned
 * that child. A broker that still holds the child's process handle attests that in its
 * authenticated status, which reserves the pid, so its own report is that fact (ADR-0035,
 * amendment 2026-10-13); every other child is read by this window through `readNativeGeneration`.
 * Without one or the other a process id alone cannot be told from a reused one.
 */
export async function provedBrokerPin(
	handle: AttachedBrokerHandle,
	readNativeGeneration: NativeGenerationReader,
	kind: PtyKind = "managed-rpc",
): Promise<BrokerProbeResult> {
	if (handle.slot !== handle.record.slot) {
		return { ok: false, reason: "the broker proved a different slot than its record names" };
	}
	if (handle.kind !== kind) {
		// A folder shell is never a session host: its slot must not be adopted through a
		// conversation's slot mapping, and a legacy slot is never adopted as an rpc child.
		return { ok: false, reason: "the record for that slot is not the kind of session host this row recorded" };
	}
	if (handle.state !== "running") {
		return { ok: false, reason: "the broker's child process has already exited" };
	}
	const pid = handle.nativePid;
	if (pid === null || !Number.isInteger(pid) || pid < 1) {
		return { ok: false, reason: "the broker reported no child process id" };
	}
	const captured = handle.nativeCreationTime;
	if (captured === null) {
		return {
			ok: false,
			reason:
				"the broker captured no kernel creation time for its child, so that process id cannot be told apart from a reused one",
		};
	}
	// A broker that still holds its child's process handle says so in its authenticated status: the pid is
	// reserved for that child, so its own report of the pid and creation time replaces this window's reading
	// (ADR-0035, amendment 2026-10-13). Anything less — an older broker, a pseudo-console child, a child whose exit was
	// already seen — is read through the kernel as before.
	const status = handle.statusValue ?? null;
	const attestation = status === null ? null : attestationOf(status);
	const attested =
		status !== null &&
		attestation !== null &&
		status.state === "running" &&
		attestation.childHandleLive &&
		status.nativePid === pid &&
		status.nativeCreationTime === captured;
	if (!attested) {
		const reading = await readNativeGeneration(pid);
		if (reading.kind !== "found") {
			// The helper's own detail is deliberately not forwarded (ADR-0017).
			return {
				ok: false,
				reason:
					reading.kind === "gone"
						? `the broker's child process ${pid} is gone`
						: `the broker's child process ${pid} could not be identified`,
			};
		}
		if (reading.creationTime !== captured) {
			return {
				ok: false,
				reason: `process ${pid} is not the child this broker started: its creation time does not match`,
			};
		}
	}
	return {
		ok: true,
		pin: {
			kind: "broker",
			slot: handle.slot,
			brokerId: handle.record.brokerId,
			brokerGeneration: handle.record.generation,
			brokerPid: handle.brokerPid,
			brokerCreationTime: handle.record.brokerCreationTime,
			nativePid: pid,
			nativeCreationTime: captured,
		},
	};
}

/**
 * Whether a fresh attachment still proves the exact target a verdict pinned.
 *
 * The attach re-proves the pin instead of resolving a transport again: a slot whose
 * broker, generation or child changed between the verdict and the attach is refused
 * rather than adopted as this row's writer.
 */
export async function verifyPinnedBrokerAttachment(input: {
	readonly handle: AttachedBrokerHandle;
	readonly pin: BrokerPin;
	readonly readNativeGeneration: NativeGenerationReader;
	readonly kind?: "managed-rpc" | "managed-omp";
}): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
	const proved = await provedBrokerPin(input.handle, input.readNativeGeneration, input.kind ?? "managed-rpc");
	if (!proved.ok) return proved;
	const { pin } = proved;
	const expected = input.pin;
	const same =
		pin.slot === expected.slot &&
		pin.brokerId === expected.brokerId &&
		pin.brokerGeneration === expected.brokerGeneration &&
		pin.brokerPid === expected.brokerPid &&
		pin.brokerCreationTime === expected.brokerCreationTime &&
		pin.nativePid === expected.nativePid &&
		pin.nativeCreationTime === expected.nativeCreationTime;
	if (!same) return { ok: false, reason: "the broker target changed since ownership was verified" };
	return { ok: true };
}

/** What {@link concurrentPinProof} settled on: the verdict, how many kernel readings it took and how long it ran. */
export interface ConcurrentPinProofResult {
	readonly proof: { readonly ok: true } | { readonly ok: false; readonly reason: string };
	readonly childReads: number;
	readonly ms: number;
}

/**
 * The exact-pin proof of one attachment, started as soon as the broker's status is known and awaited
 * after the broker's own identity is confirmed.
 *
 * An attachment proves two independent things: the broker is the process its record names
 * (`confirmBrokerIdentity`, one kernel reading when the broker does not attest itself) and the
 * broker's child is the exact pinned one ({@link verifyPinnedBrokerAttachment}, one more reading when
 * the broker does not attest the child). Neither is an input to the other, so with PowerShell starts
 * costing seconds on a loaded machine they run together instead of one after the other. Each reading
 * is still taken inside this proof and compared with the recorded creation time, so no evidence is
 * older than the proof (ADR-0035); either failing refuses the attachment, the broker's reason first.
 *
 * `start` is what the attach hands to its `whileConfirming` hook. `settle` returns the proof, and
 * starts it then if the attach never called the hook (a client that attaches without one), so the
 * proof never goes missing.
 */
export function concurrentPinProof(input: {
	readonly pin: BrokerPin;
	readonly readNativeGeneration: NativeGenerationReader;
	readonly kind?: "managed-rpc" | "managed-omp";
}): {
	readonly start: (handle: AttachedBrokerHandle) => void;
	readonly settle: (handle: AttachedBrokerHandle) => Promise<ConcurrentPinProofResult>;
} {
	let started: Promise<ConcurrentPinProofResult> | null = null;
	const start = (handle: AttachedBrokerHandle): Promise<ConcurrentPinProofResult> => {
		if (started !== null) return started;
		const startedAt = Date.now();
		let childReads = 0;
		started = (async (): Promise<ConcurrentPinProofResult> => {
			try {
				const proof = await verifyPinnedBrokerAttachment({
					handle,
					pin: input.pin,
					...(input.kind === undefined ? {} : { kind: input.kind }),
					readNativeGeneration: async pid => {
						childReads += 1;
						return await input.readNativeGeneration(pid);
					},
				});
				return { proof, childReads, ms: Date.now() - startedAt };
			} catch {
				// No error text is forwarded (ADR-0017).
				return {
					proof: { ok: false, reason: "The pinned broker target could not be re-proven, so no host was adopted." },
					childReads,
					ms: Date.now() - startedAt,
				};
			}
		})();
		return started;
	};
	return { start: handle => void start(handle), settle: handle => start(handle) };
}

/**
 * The kernel reader of the root-absence checks: the process's native module through
 * {@link PtyBrokerClient.identityReading}, which asks the kernel on every call. No runtime is staged
 * or proved for it, and a module that is not loaded answers `unknown`, which proves nothing.
 */
export async function brokerNativeGenerationReader(client: PtyBrokerClient): Promise<NativeGenerationReader> {
	return lazyNativeGenerationReader(client);
}

/**
 * The kernel reader an attachment proof uses. A proof of a child its broker attests never calls it.
 * Every reading asks the kernel again, so evidence is never older than the proof that uses it.
 */
export function lazyNativeGenerationReader(client: PtyBrokerClient): NativeGenerationReader {
	return async pid => {
		try {
			return await client.identityReading(pid);
		} catch (error) {
			return { kind: "unknown", detail: messageOf(error) };
		}
	};
}

/** The reading this window takes of a process when no broker can be asked. */
export async function kernelProcessIdentity(client: PtyBrokerClient, pid: number): Promise<PtyIdentityReading> {
	return await (await brokerNativeGenerationReader(client))(pid);
}

type LookedUp =
	| { readonly kind: "none" }
	| { readonly kind: "failed"; readonly reason: string }
	| { readonly kind: "attached"; readonly handle: ProbeHandle };

/**
 * Attach read-only to one slot's record by its own kind.
 *
 * The record decides the attach path (`managed-rpc` attaches through `attachRpc`, a
 * legacy `managed-omp` slot through the terminal attach): the record itself, not the
 * caller, names what the slot is. `readRecord` and the attach are the only broker
 * operations used: nothing is launched, no owner hint is sent, no runtime is published.
 */
async function attachRecorded(
	client: PtyBrokerClient,
	slot: string,
	whileConfirming?: (handle: AttachedBrokerHandle) => void,
): Promise<LookedUp> {
	let lookup;
	try {
		lookup = await client.readRecord(slot);
	} catch {
		return { kind: "failed", reason: "the broker record for that slot could not be read" };
	}
	if (lookup.kind === "none") return { kind: "none" };
	if (lookup.kind === "invalid") return { kind: "failed", reason: "the broker record for that slot could not be read" };
	// The record this window read must name the slot it asked about. Authentication of *a*
	// record is not proof that it is this row's: a record copied to another slot's path
	// would otherwise be read as this row's own broker.
	if (lookup.record.slot !== slot) {
		return { kind: "failed", reason: "the broker record for that slot names a different slot" };
	}
	let outcome;
	try {
		const options = whileConfirming === undefined ? { adopted: true } : { adopted: true, whileConfirming };
		outcome =
			lookup.record.kind === "managed-rpc"
				? await client.attachRpcRecord(lookup.record, options)
				: await client.attachRecord(lookup.record, options);
	} catch {
		return { kind: "failed", reason: "the recorded broker could not be authenticated for that slot" };
	}
	// An unavailable attachment has no handle to inspect; the reason is deliberately not
	// forwarded (ADR-0017).
	if (outcome.handle === null) {
		return { kind: "failed", reason: "the recorded broker could not be authenticated for that slot" };
	}
	const handle = outcome.handle as ProbeHandle;
	// `attach` re-reads the slot itself, so the authenticated handle is the proof that has
	// to name the requested slot: a record that changed between the read above and the
	// attach would otherwise answer for a broker this row never recorded.
	if (handle.slot !== slot || handle.record.slot !== slot) {
		handle.disconnect();
		return { kind: "failed", reason: "the broker proved a different slot than the one this row recorded" };
	}
	return { kind: "attached", handle };
}

/**
 * Prove one `managed-rpc` row's recorded child.
 *
 * The verdict is a statement about the recorded pair only: the slot must still be the
 * broker generation the row recorded, and the child either runs with the recorded pid and
 * creation time (the broker's capture, confirmed by its authenticated attestation that it
 * still holds the child's process handle, or else by this window's own kernel reading taken
 * for this proof) or the broker reports that exact child exited. A slot that names another
 * generation or child is a `mismatch`, never this row's writer and never its absence.
 */
export async function probeRpcHost(input: {
	readonly client: PtyBrokerClient;
	readonly slot: string;
	readonly expected: RecordedRpcIdentity;
	readonly kind?: "managed-rpc" | "managed-omp";
	/** Test seam: the kernel reader; defaults to the client's own readings. */
	readonly readNativeGeneration?: NativeGenerationReader;
}): Promise<RpcProbeResult> {
	// Concurrent equivalent reads share one in-flight RPC proof so they cannot exhaust the
	// broker's bounded client slots while each waits for the kernel identity.
	if (input.kind === "managed-omp") return await probeRpcHostOnce(input);
	let bySlot = rpcProbeFlights.get(input.client);
	if (bySlot === undefined) {
		bySlot = new Map();
		rpcProbeFlights.set(input.client, bySlot);
	}
	let flights = bySlot.get(input.slot);
	if (flights === undefined) {
		flights = [];
		bySlot.set(input.slot, flights);
	}
	const expected = input.expected;
	for (const flight of flights) {
		const recorded = flight.expected;
		if (
			flight.reader === input.readNativeGeneration &&
			recorded.slot === expected.slot &&
			recorded.brokerId === expected.brokerId &&
			recorded.brokerGeneration === expected.brokerGeneration &&
			recorded.brokerPid === expected.brokerPid &&
			recorded.brokerCreationTime === expected.brokerCreationTime &&
			recorded.childPid === expected.childPid &&
			recorded.childCreationTime === expected.childCreationTime
		) return await flight.promise;
	}
	const promise = probeRpcHostOnce(input);
	const flight: RpcProbeFlight = { expected, reader: input.readNativeGeneration, promise };
	flights.push(flight);
	try {
		return await promise;
	} finally {
		flights.splice(flights.indexOf(flight), 1);
		if (flights.length === 0) bySlot.delete(input.slot);
		if (bySlot.size === 0) rpcProbeFlights.delete(input.client);
	}
}

/** One pin proof that has settled: its verdict, or what the reader threw (rethrown where the proof is consumed). */
type SettledPinProof = { readonly proved: BrokerProbeResult } | { readonly threw: unknown };

async function probeRpcHostOnce(input: Parameters<typeof probeRpcHost>[0]): Promise<RpcProbeResult> {
	// The child's proof starts when the broker's status is known, together with the broker's own identity
	// confirmation inside the attach: two independent readings of one proof, one spawn latency (ADR-0035). It
	// starts only for a handle that can still be this row's: the verdicts below that refuse without a reading
	// (another kind, another launch, an exited child) stay free of one.
	const kind = input.kind ?? "managed-rpc";
	const reader = input.readNativeGeneration ?? lazyNativeGenerationReader(input.client);
	const prove = (target: AttachedBrokerHandle): Promise<SettledPinProof> =>
		provedBrokerPin(target, reader, kind).then(proved => ({ proved }), (threw: unknown) => ({ threw }));
	const early: { proof: Promise<SettledPinProof> | null } = { proof: null };
	const attached = await attachRecorded(input.client, input.slot, candidate => {
		if (
			candidate.kind === kind &&
			candidate.record.brokerId === input.expected.brokerId &&
			candidate.record.generation === input.expected.brokerGeneration &&
			candidate.state === "running"
		) early.proof = prove(candidate);
	});
	if (attached.kind === "none") return { kind: "no-record" };
	if (attached.kind === "failed") return { kind: "unreachable", reason: attached.reason };
	const handle = attached.handle;
	try {
		const expected = input.expected;
		if (handle.kind !== (input.kind ?? "managed-rpc")) {
			return { kind: "mismatch", reason: "the record for that slot is not the managed transport this row recorded" };
		}
		if (handle.record.brokerId !== expected.brokerId || handle.record.generation !== expected.brokerGeneration) {
			return { kind: "mismatch", reason: "that slot now belongs to another launch than the one this row recorded" };
		}
		if (handle.state === "exited") {
			if (handle.nativePid === null || handle.nativePid !== expected.childPid) {
				return { kind: "mismatch", reason: "the broker's child is not the process this session recorded" };
			}
			return { kind: "child-exited", childPid: handle.nativePid, brokerGeneration: expected.brokerGeneration };
		}
		// A kernel reading is taken only if the proof needs one.
		const settled = await (early.proof ?? prove(handle));
		if ("threw" in settled) throw settled.threw;
		const proved = settled.proved;
		if (!proved.ok) return { kind: "unreachable", reason: proved.reason };
		if (proved.pin.nativePid !== expected.childPid || proved.pin.nativeCreationTime !== expected.childCreationTime) {
			return {
				kind: "mismatch",
				reason: `the broker's child (pid ${proved.pin.nativePid}) is not the process this session recorded (pid ${expected.childPid})`,
			};
		}
		return { kind: "attachable", pin: proved.pin };
	} finally {
		handle.disconnect();
	}
}

/**
 * Whether one recorded slot's broker still owns a running managed child.
 *
 * This is the question an *unidentified* attempt can be asked, because it recorded no
 * process id to compare: the slot itself is the launch's own identity — the extension
 * mints one per launch and records it before the launcher runs — so a running
 * `managed-rpc` (or legacy `managed-omp`) child under it is positive evidence of a writer.
 * Any other record kind is reported as a failure, not as missing metadata.
 */
export async function probeBrokerSlotForRunningChild(input: {
	readonly client: PtyBrokerClient;
	readonly slot: string;
	/** The process the row recorded, when it recorded one; a pid-less attempt is bound by its slot alone. */
	readonly recordedPid?: number | null;
	readonly readNativeGeneration?: NativeGenerationReader;
}): Promise<BrokerSlotProbeResult> {
	const attached = await attachRecorded(input.client, input.slot);
	if (attached.kind === "none") return { kind: "missing" };
	if (attached.kind === "failed") return { kind: "failed", reason: attached.reason };
	const handle = attached.handle;
	try {
		if (handle.kind !== "managed-rpc" && handle.kind !== "managed-omp") {
			return { kind: "failed", reason: "the record for that slot is not an OMP session host" };
		}
		if (handle.state === "exited") {
			const recorded = input.recordedPid ?? null;
			if (recorded !== null && handle.nativePid !== null && handle.nativePid !== recorded) {
				return { kind: "failed", reason: "the broker's child is not the process this session recorded" };
			}
			return { kind: "idle" };
		}
		if (handle.state !== "running") {
			return { kind: "failed", reason: "the broker did not report the state of its child" };
		}
		const pid = handle.nativePid;
		if (pid === null || !Number.isInteger(pid) || pid < 1) {
			return { kind: "failed", reason: "the broker reported a running child without a process id" };
		}
		if ((input.recordedPid ?? null) !== null && pid !== input.recordedPid) {
			return { kind: "failed", reason: "the broker's child is not the process this session recorded" };
		}
		const reader = input.readNativeGeneration ?? lazyNativeGenerationReader(input.client);
		const proved = await provedBrokerPin(handle, reader, handle.kind);
		if (!proved.ok) return { kind: "failed", reason: proved.reason };
		return { kind: "live", pid };
	} finally {
		handle.disconnect();
	}
}

/** What one stop of a managed writer established. */
export interface NativeStopVerdict {
	/** `true` only when the exact proven child is gone. */
	readonly writerGone: boolean;
	/** The broker's own whole-tree proof; `false` when this platform could not produce it. */
	readonly treeEmpty: boolean;
	readonly detail: string;
	/** Low-level stop facts for Output only, never a notification. */
	readonly diagnosticDetail?: string;
}

/** Facts one broker stop reported. */
export interface StopFacts {
	readonly pidGone: boolean;
	/** The broker's own proof that the whole process *tree* is gone. */
	readonly treeEmpty: boolean;
	readonly nativePid: number;
	/** Processes the broker still sees, for the report only. */
	readonly remaining: readonly number[];
	readonly brokerDetail: string;
}

/**
 * Decide what one broker stop establishes for a managed session.
 *
 * The invariant is narrow on purpose: the claim is released — or a successor started on
 * the same file — only when the child this window *proved* to be the recorded one is gone.
 * The process *tree* is a separate fact that this platform may be unable to prove at all,
 * and it is never inferred from the root's exit.
 */
export function decideStop(facts: StopFacts): NativeStopVerdict {
	const remaining = facts.remaining.length === 0 ? "" : ` (processes still present: ${facts.remaining.join(", ")})`;
	if (!facts.pidGone) {
		return {
			writerGone: false,
			treeEmpty: false,
			detail: "The session could not be confirmed stopped. Try Stop again; commands it started may still be running.",
			diagnosticDetail: `The OMP process (pid ${facts.nativePid}) could not be confirmed stopped${remaining}: ${facts.brokerDetail}`,
		};
	}
	return {
		writerGone: true,
		treeEmpty: facts.treeEmpty,
		detail: facts.treeEmpty ? "The session is stopped." : "The session is stopped. Commands it started may continue running separately.",
		diagnosticDetail: facts.treeEmpty
			? facts.brokerDetail
			: `The OMP process (pid ${facts.nativePid}) is gone; the process tree remains unknown${remaining}. ${facts.brokerDetail}`,
	};
}

/** The outcome of one stop through a recorded slot. */
export type StopBrokerOwnedResult =
	| { readonly ok: true; readonly verdict: NativeStopVerdict }
	| {
			readonly ok: false;
			/**
			 * Whether the stop request may already have left this window when this failed.
			 *
			 * A refusal that never dispatched proves nothing was stopped. A request whose
			 * delivery or answer could not be confirmed proves nothing either — the child
			 * may have stopped — so a caller must never report it as "nothing was stopped".
			 */
			readonly dispatched: boolean;
			readonly reason: string;
	  };

/**
 * Stop the exact managed child one recorded broker slot owns, from a window that holds no
 * chat runtime for it.
 *
 * A surviving broker and its OMP child outlive a reloaded window, and the row they belong
 * to is then blocked with no panel to close: the only transport that can name the child is
 * the durable broker slot the launch recorded. This uses exactly that transport, and only
 * for its own child:
 *
 * - the attachment is read-only and carries **no owner hint**;
 * - {@link provedBrokerPin} proves the attached record is a running managed child of *that*
 *   slot with the broker's own id and generation and the child's kernel creation time; the
 *   recorded pid (and, for an rpc row, generation and creation time) must match when the
 *   row recorded them;
 * - `handle.stop` is the broker's own request to stop its child. Once that writer is
 *   proven gone, `shutdown` retires the now-empty broker, retaining its recovery record;
 * - the handle is disconnected in `finally` on every path.
 */
export async function stopBrokerOwnedHost(input: {
	readonly client: PtyBrokerClient;
	readonly slot: string;
	/** The process this row recorded, or `null` for an attempt that learned none. */
	readonly recordedPid: number | null;
	/** The rpc identity this row recorded, or `null` (legacy row, or an attempt that learned none). */
	readonly expected?: RecordedRpcIdentity | null;
	/** Test seam: the kernel reader; defaults to the client's own readings. */
	readonly readNativeGeneration?: NativeGenerationReader;
	readonly stopTimeoutMs?: number;
}): Promise<StopBrokerOwnedResult> {
	const attached = await attachRecorded(input.client, input.slot);
	if (attached.kind === "none") {
		return {
			ok: false,
			dispatched: false,
			reason: "no broker is recorded for this row's slot, so this window cannot reach the OMP process it started",
		};
	}
	if (attached.kind === "failed") return { ok: false, dispatched: false, reason: attached.reason };
	const handle = attached.handle;
	// Set the instant the stop request is attempted; a failure after it is uncertainty.
	let dispatched = false;
	try {
		// Lazy, like every attach: an attested child is proved from the broker's own status and needs no
		// kernel reading, so the stop takes one only when it must; a reading that cannot be taken
		// (the native module is not loaded) answers `unknown` and refuses the stop before anything is dispatched.
		const reader: NativeGenerationReader = input.readNativeGeneration ?? lazyNativeGenerationReader(input.client);
		const kind: PtyKind = handle.kind === "managed-omp" ? "managed-omp" : "managed-rpc";
		const proved = await provedBrokerPin(handle, reader, kind);
		if (!proved.ok) return { ok: false, dispatched: false, reason: proved.reason };
		if (input.recordedPid !== null && proved.pin.nativePid !== input.recordedPid) {
			return {
				ok: false,
				dispatched: false,
				reason: `the broker's child (pid ${proved.pin.nativePid}) is not the process this session recorded (pid ${input.recordedPid})`,
			};
		}
		const expected = input.expected ?? null;
		if (
			expected !== null &&
			(proved.pin.brokerId !== expected.brokerId ||
				proved.pin.brokerGeneration !== expected.brokerGeneration ||
				(expected.childCreationTime !== null && proved.pin.nativeCreationTime !== expected.childCreationTime))
		) {
			return {
				ok: false,
				dispatched: false,
				reason: "that slot now belongs to another launch than the one this row recorded",
			};
		}
		dispatched = true;
		const result = await handle.stop({ mode: "graceful", timeoutMs: input.stopTimeoutMs ?? HOST_STOP_TIMEOUT_MS });
		const verdict = decideStop({
			pidGone: result.pidGone,
			treeEmpty: result.verified && result.pidGone && result.tree === "empty",
			nativePid: result.nativePid,
			remaining: result.remainingPids,
			brokerDetail: result.detail,
		});
		if (verdict.writerGone) {
			try {
				await handle.shutdown();
			} catch {
				// Broker retirement failure cannot undo the observed writer exit.
				return {
					ok: true,
					verdict: { ...verdict, detail: `${verdict.detail} Its background process did not close. Try Stop again.`, diagnosticDetail: `${verdict.diagnosticDetail ?? verdict.detail} The now-empty broker did not acknowledge shutdown; its recovery record is retained.` },
				};
			}
		}
		return { ok: true, verdict };
	} catch (error) {
		// A failure before the request was handed over proves nothing was stopped; a failure
		// after it — a lost answer — proves nothing either way.
		return dispatched
			? { ok: false, dispatched: true, reason: `the stop request could not be confirmed: ${messageOf(error)}` }
			: {
					ok: false,
					dispatched: false,
					reason: `the broker-owned child could not be prepared for a stop: ${messageOf(error)}`,
				};
	} finally {
		handle.disconnect();
	}
}

/**
 * Refuse only a positively verified live writer under this extension's authenticated
 * broker. Missing or ambiguous ownership belongs to the user, not this extension.
 */
async function reconcileOwner(request: OwnerReconcileRequest, ports: OwnerReconcilePorts): Promise<OwnerVerdict> {
	const recorded = request.host;
	if (recorded === null) return { kind: "free", evidence: [{ kind: "no-recorded-host" }] };
	const rpc = isManagedHost(recorded) ? recorded.rpc ?? null : null;
	if (rpc !== null && rpc.childPid !== null && rpc.childCreationTime !== null) {
		const probe = await ports.probeRpc(rpc.slot, rpc, recorded.transport === "native" ? "managed-omp" : "managed-rpc");
		if (probe.kind === "attachable") {
			return {
				kind: "attachable",
				host: { pid: rpc.childPid, sessionId: recorded.sessionId, rpc, transport: recorded.transport ?? "rpc" },
				pin: probe.pin,
				detail: "This session is running. Resume to reconnect to it.",
			};
		}
		if (probe.kind === "child-exited") {
			return { kind: "free", evidence: [{ kind: "broker-child-exited", slot: rpc.slot, childPid: probe.childPid, brokerGeneration: probe.brokerGeneration }] };
		}
		if (probe.kind === "no-record" || probe.kind === "unreachable") {
			// The two readings are independent and each is taken inside this proof: one spawn latency, not two.
			const [child, broker] = await Promise.all([
				ports.readProcessIdentity(rpc.childPid),
				ports.readProcessIdentity(rpc.brokerPid),
			]);
			const childGone = child.kind === "gone" || (child.kind === "found" && child.creationTime !== rpc.childCreationTime);
			const brokerGone = broker.kind === "gone" || (broker.kind === "found" && rpc.brokerCreationTime !== null && broker.creationTime !== rpc.brokerCreationTime);
			if (childGone && brokerGone && rpc.brokerCreationTime !== null) {
				return { kind: "free", evidence: [{ kind: "recorded-broker-and-child-gone", slot: rpc.slot, brokerGeneration: rpc.brokerGeneration, childPid: rpc.childPid, childCreationTime: rpc.childCreationTime }] };
			}
		}
		return { kind: "free", evidence: [] };
	}
	const provenance = ports.brokerProvenance(request);
	const slot = rpc?.slot ?? (provenance.kind === "slot" ? provenance.slot : ports.brokerSlot(request));
	if (slot !== null) {
		const probe = await ports.probeBrokerSlot(slot, recorded.pid);
		if (probe.kind === "live") {
			return {
				kind: "live",
				pid: probe.pid,
				detail: "This session is already running. Stop it before opening a new editor.",
			};
		}
		if (probe.kind === "idle" && recorded.pid !== null) {
			return { kind: "free", evidence: [{ kind: "broker-child-exited", slot, childPid: recorded.pid, brokerGeneration: null }] };
		}
	}
	return { kind: "free", evidence: [] };
}
