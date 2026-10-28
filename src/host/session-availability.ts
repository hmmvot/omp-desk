/**
 * Ownership-verdict contracts and the availability policy of the session index.
 *
 * ADR-0039: ownership is positive evidence, not the inability to prove absence.
 * Everything here is pure: the reconciler, the stop port and the launcher are
 * implemented elsewhere, and the policy decides from the facts they hand over.
 * It names the row and host shapes of `session-model.ts` and nothing of the
 * `SessionIndex` class.
 */

import type { ObservedClaim } from "./session-claim.ts";
import { isManagedHost, isUnreadLaunchAttempt } from "./session-model.ts";
import type { StepSink } from "./session-restore-trace.ts";
import type {
	OmpHostHandle,
	RecordedHost,
	RecordedOwnership,
	SessionAvailability,
	SessionIndexEntry,
} from "./session-model.ts";

// Ownership reconciliation

/**
 * Positive proof that no writer of this extension can still be alive for an
 * entry. Every item is validated against the entry's own record; the index
 * accepts none of them on the caller's word alone.
 *
 * These items are statements about **this extension's own writer**, and about
 * nothing else. Extension claims coordinate only participants that honour them;
 * an OMP process this launcher did not start publishes no room to match, and
 * installed OMP holds no lifetime lease on a session file (the locks in its
 * session storage are per operation and released when the operation finishes),
 * so an external writer of the same file can never be excluded by any of this.
 * That is why `no-recorded-host` may unlock a launch for an imported row while
 * promising nothing about an external writer, and why it must not be read as
 * "nobody is writing this file".
 */
export type OwnerAbsenceEvidence =
	/**
	 * This index never recorded a launched host for the entry, so no writer of
	 * ours exists. It says nothing about any other process writing the same
	 * file: none is observable from here.
	 */
	| { readonly kind: "no-recorded-host" }
	/**
	 * The authenticated broker that owns the recorded child reports that child exited.
	 *
	 * For an rpc row the report must name the row's own slot, broker generation and child pid.
	 * A legacy broker-owned row records no child creation time: the reconciler proves the
	 * reporting slot equals the row's broker provenance, and the index checks the pid. Either way
	 * this is a positive writer-gone fact from the process that owned the writer.
	 */
	| {
			readonly kind: "broker-child-exited";
			readonly slot: string;
			readonly childPid: number;
			readonly brokerGeneration: string | null;
	  }
	/**
	 * The recorded broker (pid and creation time) is gone **and** the recorded child (pid and
	 * creation time) is absent by an independent kernel reading. Rpc rows only.
	 */
	| {
			readonly kind: "recorded-broker-and-child-gone";
			readonly slot: string;
			readonly brokerGeneration: string;
			readonly childPid: number;
			readonly childCreationTime: string;
	  }
	/** The claim this index held was released after a confirmed host stop. */
	| { readonly kind: "claim-released" };

/**
 * The transport a reconciler proved for its `attachable` verdict.
 *
 * It is deliberately opaque to this index: the index neither reads, persists nor
 * stores it in a row, and passes it to {@link OmpHostLauncher.attach} unchanged so
 * the attach re-proves the exact transport the verdict was established on instead
 * of resolving another one — most importantly when no editor exists yet, which is
 * the ordinary state right after a restart. It carries no secret: the broker's own
 * bearer token stays in the broker's private record.
 */
export interface AttachPin {
	readonly kind: "broker";
	/** Durable slot the verified managed host occupies. */
	readonly slot: string;
	readonly brokerId: string;
	readonly brokerGeneration: string;
	readonly brokerPid: number;
	readonly brokerCreationTime: string | null;
	/** The child process the broker owns: the OMP process this row recorded. */
	readonly nativePid: number;
	/** The child's kernel creation time, as the broker captured it. */
	readonly nativeCreationTime: string;
}

/** Whether two pins name the same broker generation and the same child, field by field. */
export function sameAttachPin(a: AttachPin, b: AttachPin): boolean {
	return (
		a.slot === b.slot &&
		a.brokerId === b.brokerId &&
		a.brokerGeneration === b.brokerGeneration &&
		a.brokerPid === b.brokerPid &&
		a.brokerCreationTime === b.brokerCreationTime &&
		a.nativePid === b.nativePid &&
		a.nativeCreationTime === b.nativeCreationTime
	);
}

/** Caller's verdict on who owns a session right now. */
export type OwnerVerdict =
	/**
	 * No writer is alive; `evidence` must carry at least one verifiable item.
	 *
	 * `detail` carries what the verdict could *not* inspect — a broker record that is
	 * gone, so the child it started could not be looked at — when the release the user
	 * authorized is being completed. It is disclosure, never evidence.
	 */
	| { readonly kind: "free"; readonly evidence: readonly OwnerAbsenceEvidence[]; readonly detail?: string }
	/** A writer is alive (or this extension must not be the one to take it). */
	| { readonly kind: "live"; readonly detail: string; readonly pid?: number }
	/**
	 * A writer is alive *and* it is the host this index recorded, verified by the
	 * reconciler against the exact recorded process id, broker and child identity,
	 * OMP session id, working directory, and a usable transport.
	 *
	 * This is the only verdict that permits {@link OmpHostLauncher.attach}: the
	 * index never starts a second process for it, and it re-checks the host
	 * against its own record before asking the launcher to reattach. `pin` names
	 * the transport that was proven, and the launcher re-proves it rather than
	 * substituting another.
	 */
	| { readonly kind: "attachable"; readonly host: OmpHostHandle; readonly pin: AttachPin; readonly detail: string }
	/** Ownership could not be established; it does not veto a user action. */
	| { readonly kind: "unknown"; readonly detail: string };

/** Everything a reconciler is given; it owns registry access, not policy. */
export interface OwnerReconcileRequest {
	readonly entry: SessionIndexEntry;
	/** Exact session file when materialized. */
	readonly sessionFile: string | null;
	/** Reserved draft identity before materialization. */
	readonly draftIdentity: string | null;
	/** Claim owner generation this extension uses for the entry. */
	readonly ownerGeneration: string;
	/** Durable claim observation for the entry's identity, or `null` when free. */
	readonly claim: ObservedClaim | null;
	/** Last host this extension launched for the entry, when one was launched. */
	readonly host: RecordedHost | null;
	/** Where the restore pass wants the pieces of this reconcile timed; diagnostic only, never read by a verdict. */
	readonly steps?: StepSink;
	/**
	 * The caller will attach to the host this reconcile proves, in the same pass, and wants the proof's connection to the broker
	 * kept for that attach instead of closed (the startup restore pass only; Open, Resume and Delete admission never set it).
	 * Advisory: a reconciler without a place to keep a connection ignores it, and the attach then opens its own.
	 */
	readonly keepConnection?: boolean;
}

/** Read-only positive ownership witnesses. Absence evidence gates automatic relaunch only. */
export interface OwnerReconciler {
	reconcile(request: OwnerReconcileRequest): Promise<OwnerVerdict>;
}

/**
 * The facts of a deletion/absence subject that evidence is validated against.
 *
 * Structural on purpose: an indexed row satisfies it, and so does the minimal
 * subject a discovered file supplies (no recorded host, no claim record).
 */
export interface OwnerAbsenceSubject {
	/** Host this extension recorded for the file, or `null` when none was recorded. */
	readonly host: RecordedHost | null;
	/** Claim record this extension holds for the file, or `null`. */
	readonly ownership: RecordedOwnership | null;
}

/** Validate recorded absence evidence for automatic relaunch, never user permission. */
export function acceptOwnerAbsenceEvidence(
	subject: OwnerAbsenceSubject,
	evidence: OwnerAbsenceEvidence,
): boolean {
	const host = subject.host;
	const release = subject.ownership?.releasedAt ?? null;
	switch (evidence.kind) {
		case "no-recorded-host":
			// Only a row that recorded no attempt at all. A launch attempt is
			// recorded before the launcher runs, so a row carrying one — even an
			// identity-less one a crashed window left behind — is a row a writer may
			// already exist for, and this evidence is refused for it.
			return host === null;
		case "broker-child-exited": {
			if (host === null) return false;
			if (isManagedHost(host)) {
				const rpc = host.rpc ?? null;
				return (
					rpc !== null &&
					rpc.slot === evidence.slot &&
					rpc.childPid !== null &&
					rpc.childPid === evidence.childPid &&
					rpc.brokerGeneration === evidence.brokerGeneration
				);
			}
			// A legacy record has no child creation time; the reconciler proved the slot.
			return host.pid !== null && host.pid === evidence.childPid;
		}
		case "recorded-broker-and-child-gone": {
			if (!isManagedHost(host)) return false;
			const rpc = host.rpc ?? null;
			return (
				rpc !== null &&
				rpc.slot === evidence.slot &&
				rpc.brokerGeneration === evidence.brokerGeneration &&
				rpc.childPid !== null &&
				rpc.childPid === evidence.childPid &&
				rpc.childCreationTime !== null &&
				rpc.childCreationTime === evidence.childCreationTime
			);
		}
		case "claim-released":
			// A release only clears a host that started before it, so a host
			// launched after the recorded release keeps the entry blocked.
			return release !== null && (host === null || release >= host.startedAt);
	}
}

// Classification

export interface SessionClassificationInput {
	readonly entry: SessionIndexEntry;
	/** The exact session file exists on disk (always `false` for a draft). */
	readonly fileExists: boolean;
	/** Durable claim observation for the entry's identity. */
	readonly claim: ObservedClaim | null;
	/** This extension host currently holds a running host for this tab. */
	readonly localLive: boolean;
	/** External ownership reconciliation for this entry. */
	readonly verdict: OwnerVerdict;
}

export interface SessionClassification {
	readonly availability: SessionAvailability;
	/** Evidence items the reconciler supplied that this entry supports. */
	readonly evidence: readonly OwnerAbsenceEvidence[];
	readonly detail: string;
	/** `true` only for `saved`: the exact file may be resumed right now. */
	readonly restorable: boolean;
	/** `true` only for `draft`: a fresh native host may be started safely. */
	readonly startable: boolean;
	/**
	 * The live host this pass may attach to, or `null` when no attach is allowed.
	 * Non-null only when the reconciler named the exact host this index recorded
	 * and this pass still holds the claim for it; a live owner that fails any of
	 * those checks stays a fail-closed conflict.
	 */
	readonly attachableHost: OmpHostHandle | null;
	/**
	 * The transport the reconciler proved for {@link attachableHost}.
	 *
	 * Non-null exactly when `attachableHost` is: the two are published together, so
	 * an attach can never be driven through a transport nobody verified. The index
	 * carries it unchanged; it does not read or store it.
	 */
	readonly attachPin: AttachPin | null;
}

/**
 * Why the verdict's live host must not be attached, or `null` when it is exactly
 * the host this index recorded.
 *
 * Every clause is a fact the index owns: a recorded launch, the exact process id,
 * the broker and child identity, and the OMP session id that were recorded. A launch
 * its window left mid-way (an unread attempt) recorded no process and no identity, so
 * there is nothing to compare: the slot the launch reserved and the broker's own pin
 * proof, which the attach re-proves, are its identity, and only the transport is
 * checked here.
 */
function describeAttachMismatch(
	entry: SessionIndexEntry,
	claim: ObservedClaim | null,
	host: OmpHostHandle,
): string | null {
	const recorded = entry.host;
	if (recorded === null) return "this tab never recorded a launched host";
	if (isUnreadLaunchAttempt(recorded)) {
		if (host.pid === null || host.rpc === null || (host.transport ?? "rpc") !== recorded.transport) {
			return "the recorded managed transport does not match the attached host";
		}
		// Nothing else can differ: the reconciler names the adopted host by the id this very record carries. The id is
		// fenced where a process can report it: the attach hands it to the Chat as the expected id, and the session's own
		// identity check refuses a different one (a row's file is checked the same way).
		return null;
	}
	if (host.pid === null || recorded.pid === null || host.pid !== recorded.pid) {
		return "the reported process id does not match the recorded one";
	}
	if (!isManagedHost(recorded) || recorded.rpc == null || host.rpc === null || (host.transport ?? "rpc") !== recorded.transport) {
		return "the recorded managed transport does not match the attached host";
	}
	const identity = recorded.rpc;
	const reported = host.rpc;
	if (
		identity.slot !== reported.slot ||
		identity.brokerId !== reported.brokerId ||
		identity.brokerGeneration !== reported.brokerGeneration ||
		identity.childPid === null ||
		identity.childPid !== reported.childPid ||
		identity.childCreationTime === null ||
		identity.childCreationTime !== reported.childCreationTime
	) {
		return "the reported broker and child identity do not match the recorded one";
	}
	// Native identity is best-effort readback, not attachment authority.
	if (recorded.transport === "native") return null;
	// Only two ids that were both recorded and differ prove a session switch. A row that never learned its id (a reload
	// right after New Session, before the first `get_state` answered) has nothing to differ from: the attach carries no
	// expected id, so the session learns it from the process — and a row with a file is checked against that file by the
	// session itself (`identity-mismatch`), so a different session is still refused there, never silently attached.
	const expectedSessionId = recorded.sessionId ?? entry.sessionId;
	if (expectedSessionId !== null && host.sessionId !== null && host.sessionId !== expectedSessionId) {
		return "the reported OMP session id does not match the recorded one";
	}
	return null;
}

/**
 * Decide an entry's availability. Pure, so the safety policy is testable
 * without a filesystem, a registry, or a launcher.
 *
 * The origin of the row is not consulted: an imported file this extension
 * registered is decided by exactly the rules a created one is.
 */
export function classifySessionAvailability(input: SessionClassificationInput): SessionClassification {
	const { entry, fileExists, claim, localLive, verdict } = input;
	const decide = (
		availability: SessionAvailability,
		detail: string,
		evidence: readonly OwnerAbsenceEvidence[] = [],
		attachableHost: OmpHostHandle | null = null,
		attachPin: AttachPin | null = null,
	): SessionClassification => ({
		availability,
		evidence,
		detail,
		restorable: availability === "saved",
		startable: availability === "draft",
		attachableHost,
		attachPin,
	});

	if (localLive) {
		return decide("live", "This session is running in this window.");
	}
	if (entry.kind === "session" && !fileExists) {
		return decide("failed", `The recorded session file is missing: ${entry.sessionFile ?? ""}`);
	}
	if (verdict.kind === "live") {
		return decide("live", verdict.detail);
	}
	if (verdict.kind === "attachable") {
		const mismatch = describeAttachMismatch(entry, claim, verdict.host);
		if (mismatch === null) {
			return decide("live", verdict.detail, [], verdict.host, verdict.pin);
		}
		return decide(
			"live",
			`This session's OMP process is still running, but this window cannot prove it is the one it started (${mismatch}), so Resume cannot reconnect to it. ` +
				"Use Stop or Kill on this session in Sessions to end that process, then Resume to start it again.",
		);
	}
	const evidence = verdict.kind === "free" ? verdict.evidence : [];
	if (entry.kind === "session") {
		return decide("saved", "The saved conversation is available. Resume to continue.", evidence);
	}
	return decide("draft", "This is a new session. Resume to start chatting.", evidence);
}

/** Everything a deferred (start-nothing) reconciliation pass needs. */
export interface DeferredReconcileOptions {
	readonly reconciler: OwnerReconciler;
	/**
	 * Re-derive only these tabs. Activation passes the local recovery cohort, so an
	 * automatic pass never touches a row another workspace put in the shared index; an
	 * explicit open passes the one tab it is about.
	 */
	readonly tabIds?: ReadonlySet<string>;
	/**
	 * Re-derive only this tab. A caller reacting to one row must not reconcile
	 * every draft in the workspace; omitting it re-derives every draft.
	 */
	readonly tabId?: string;
}

/** One draft tab re-examined without a claim being taken and nothing started. */
export interface DeferredReconciliation {
	readonly tabId: string;
	readonly availability: SessionAvailability;
	readonly detail: string;
	/** Evidence the reconciler supplied that this entry itself supports. */
	readonly evidence: readonly OwnerAbsenceEvidence[];
	/** `true` only for `draft`: a fresh native host may be started for this tab now. */
	readonly startable: boolean;
	/** Exact host this pass could attach to; never a reason to start one. */
	readonly attachableHost: OmpHostHandle | null;
	/**
	 * Signature of the row this reconciliation was computed for, produced under the
	 * same tab lifecycle as the classification itself.
	 *
	 * A deferred pass may only adopt a file for the row this absence was accepted
	 * for. The pass carries this signature to {@link SessionIndex.promoteDeferredDraft},
	 * which re-derives it inside the adoption's own lifecycle: a mismatch means a
	 * launch, a close, a promotion or an unconfirmed restore changed the row in
	 * between, and a row nobody verified may not be adopted.
	 */
	readonly authorization: string;
}

/** Per-tab results of one deferred reconciliation pass. */
export interface DeferredReconcileReport {
	/** Draft tab ids this pass considered, in index order. */
	readonly order: readonly string[];
	readonly reconciled: readonly DeferredReconciliation[];
	/** Draft tabs this window is running a host for; nothing was re-derived. */
	readonly running: readonly string[];
	/** Set when the index could not persist its state during this pass. */
	readonly persistError: string | null;
}

/**
 * The one transport that can stop a row's recorded host from a window that drives no
 * runtime for it: the durable broker slot that same launch recorded.
 *
 * It is a port for the same reason {@link OwnerReconciler} is one — the policy of
 * *whether* a stop may happen belongs to the index, and the authenticated attach and
 * stop belong to the module that speaks the broker protocol. The port resolves the
 * row's provenance itself and proves the exact child before it acts; it never signals
 * a numeric pid.
 */
export interface RecordedHostStopPort {
	/**
	 * Stop the exact managed child this row's recorded broker owns.
	 *
	 * Every refusal — no slot recorded, an unreadable provenance or record, a broker
	 * that does not authenticate, a child that is not the recorded process — is
	 * `unknown` with bounded text: nothing was stopped, and the row is left exactly as
	 * it was.
	 */
	stopRecordedHost(entry: SessionIndexEntry): Promise<RecordedHostStopResult>;
}

/** What one attempt to stop a row's recorded host established. */
export type RecordedHostStopResult =
	| {
			readonly kind: "stopped";
			/** `true` only when the exact recorded child process is proven gone. */
			readonly writerGone: boolean;
			/** The broker's own whole-tree proof, when the provider could produce it. */
			readonly treeEmpty: boolean;
			readonly detail: string;
			/** The durable broker slot the stop was attempted through, or `null`. */
			readonly slot: string | null;
	  }
	| { readonly kind: "unknown"; readonly detail: string };

/** What the explicit stop of one row's recorded host is given. */
export interface StopRecordedHostOptions {
	/** The transport that can reach this row's recorded broker-owned child. */
	readonly stop: RecordedHostStopPort;
	/**
	 * The exact attempt the user's confirmation named.
	 *
	 * A confirmation is a statement about one process, and a row can record a new
	 * attempt while a dialog is open (a relaunch that won the tab's gate, a promotion).
	 * The action re-reads the row under the lifecycle gate and refuses if it no longer
	 * records that attempt, so a stale confirmation can never stop a process the user
	 * did not see named.
	 */
	readonly expect: { readonly attemptStartedAt: string; readonly pid: number | null };
}

/** The incarnation of a session's recorded process that Kill examined. */
export interface KilledHostCapture {
	readonly slot: string;
	readonly brokerId: string;
	readonly brokerGeneration: string;
	readonly attemptStartedAt: string;
	readonly hostPid: number | null;
}

/** What recording a killed row as stopped did. `skipped` is benign: the row's owner or a newer launch is not this call's to settle. */
export type KilledHostReconcileResult =
	| { readonly kind: "recorded"; readonly slot: string; readonly detail: string }
	| { readonly kind: "skipped"; readonly why: "driven" | "changed" | "rival"; readonly detail: string }
	| { readonly kind: "failed"; readonly detail: string };

/** What an explicit stop of one row's recorded host did, in words the launcher can show. */
export interface StopRecordedHostResult {
	/** `true` only when the exact recorded writer was stopped and its claim released. */
	readonly stopped: boolean;
	readonly detail: string;
	/** The broker slot the caller may forget once the child is gone. */
	readonly slot: string | null;
}
