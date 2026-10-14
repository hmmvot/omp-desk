/**
 * The extension host's client for the PTY broker
 * ([ADR-0024](../../docs/decisions/0024-own-omp-pty-for-in-tab-terminal.md)).
 *
 * This is the only module that makes the *decisions* about a broker: adopt or start,
 * attach or report, stop or leave alone. The broker's rules are about a terminal; the
 * caller's are about a session, an editor and a claim. Keeping the decisions in one
 * place prevents the mix-up that would start a second writer.
 *
 * It drives both kinds of slot. A terminal slot (`managed-omp` parse-only, `folder-shell`)
 * is attached through {@link PtyHandle}; a `managed-rpc` slot
 * ([ADR-0038](../../docs/decisions/0038-host-chat-over-rpc-ui-on-a-broker-pipe-child.md))
 * is launched and attached through `launchRpc`/`attachRpc` and yields an `RpcHandle`. Both
 * follow every rule below; the kind decides only which frames flow.
 *
 * Four rules shape everything here:
 *
 * - **Never start a second writer.** A slot is a writer slot. `launch` adopts the live
 *   broker that owns it, and otherwise starts one only for a slot with *no* record at
 *   all. A slot that already has a record is never replaced, however its broker looks:
 *   the record is the only recovery metadata for a child or an escaped descendant that
 *   may still exist, so a broker that is gone, unparseable or of another build is
 *   reported and left completely alone (ADR-0029).
 * - **No identity, no session.** The record names the broker's pid and its kernel
 *   creation time. The authenticated handshake must name the same slot, pid and creation
 *   time, and the status must agree. A broker that attests its own identity (this build's
 *   brokers do) is believed on its token-authenticated word; one that does not is read
 *   through the staged probe, which is staged only then (ADR-0035, amendment 2026-10-13,
 *   proposed). A record left by a crashed process, a reused pid, or another account's
 *   directory cannot be talked to by accident.
 * - **A stop is believed only when it is proven.** `stop` returns the broker's verdict
 *   unchanged. `verified` needs a kernel-enforced process group, which this PTY provider
 *   does not offer, so it is `false` with a reported `pidGone` and an unproven tree
 *   (ADR-0029). Nothing here promotes a partial reading into a clean one. A caller
 *   releases a session claim from the recorded child identity and the broker's exit
 *   report, never from `verified`.
 * - **An owner watch is reported, never promised.** A folder shell may be launched or
 *   attached with an `owner` hint. The broker's own attested owner set decides whether
 *   anything automatic happens (ADR-0030), and `status.ownerStop` is the only thing a
 *   caller may present to a user.
 *
 * Everything a caller can observe is on {@link PtyHandle}: the record, both process
 * identities, status, the screen, replayed output, input ownership, stop and
 * shutdown. A handle is cheap to keep and safe to drop: closing its socket detaches
 * this window without stopping anything, which is what closing an editor has to mean.
 */

import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	PTY_DEFAULT_OWNER_GRACE_MS,
	PTY_PROTOCOL_VERSION,
	type PtyBrokerRecord,
	type PtyLaunchSpec,
	type PtyBrokerFrame,
	type PtyKind,
	type PtyOwnerHint,
	type PtyOwnerStopStatus,
	type PtySnapshotMeta,
	type PtyStatusPayload,
} from "./pty-protocol.ts";
import { BrokerHandle, type BrokerHandleEvent, type SnapshotCollector } from "./broker-handle.ts";
import {
	PtyIdentityReadings,
	isPtyProcessAlive,
	queryPtyProcessIdentity,
	type PtyIdentityReading,
	type PtyProbeHelper,
} from "./pty-identity.ts";
import { connectPtyBroker, type PtyClientSideConnection } from "./pty-ipc.ts";
import {
	acquirePtySlotLock,
	ensurePtyStateAccess,
	listPtyRecords,
	ptyRecordPath,
	ptyStateDirectory,
	readPtyRecord,
	releasePtySlotLock,
	type PtyRecordListing,
	type PtyRecordLookup,
} from "./pty-registry.ts";
import {
	discardReusedPtyProof,
	ensurePtyProbeHelper,
	ensurePtyRuntime,
	ptyPackagedTreeDigest,
	type PtyProbeReadiness,
	spawnPtyBroker,
	verifyPtyRuntime,
	type PtyRuntime,
	type PtyRuntimeReadiness,
} from "./pty-runtime.ts";
import { PTY_RUNTIME_VERSION, attestationOf } from "./pty-protocol.ts";
import type { PrivateStorageProbe } from "./private-storage.ts";
import type { Logger } from "../shared/logger.ts";
import { PtyRuntimeProof } from "./pty-runtime-proof.ts";
import { folderShellLaunchSpec, type PtyFolderShellRequest } from "./pty-shell.ts";
import { RpcHandle } from "./rpc-handle.ts";

/** How long a spawned broker gets to publish its record before it is reported unconfirmed. */
const DEFAULT_START_TIMEOUT_MS = 30_000;

/** How long an rpc attach waits for the broker to report the child's kernel creation time. */
const CHILD_IDENTITY_WAIT_MS = 5_000;

/** Bounded retries while a just-started broker finishes reading its own child's identity. */
const ATTACH_ATTEMPTS = 12;
const ATTACH_RETRY_MS = 250;

export interface PtyBrokerClientOptions {
	/** Extension global storage: staged trees and broker records live below it. */
	readonly storageDir: string;
	/** Extension root, so the packaged `out/pty` tree can be found. */
	readonly extensionRoot: string;
	/** Node binary for the broker; defaults to the extension host's own executable. */
	readonly nodePath?: string;
	/** Extra environment for the broker process. */
	readonly env?: Readonly<Record<string, string>>;
	/** Runtime-proof state changes worth a log line (a provisional admission, its resolution), at their own levels. */
	readonly log?: Logger;
	/** Test seam: the access probe for the state directory and the staged trees; defaults to this machine's own. */
	readonly access?: PrivateStorageProbe;
	/** Test seam: the kernel creation-time reading; defaults to the staged probe helper. */
	readonly queryIdentity?: (helper: PtyProbeHelper, pid: number) => Promise<PtyIdentityReading>;
	/** Test seam; defaults to `Date.now`. */
	readonly now?: () => number;
}

export interface BrokerLaunchOutcome<Handle> {
	/**
	 * - `running`: a broker owns the slot and this client is attached to it;
	 * - `slot-occupied`: something owns the slot and could not be driven — nothing was
	 *   started, and the reason says what was established;
	 * - `not-started`: nothing owns the slot and nothing was started;
	 * - `unconfirmed`: a broker process was started but could not be reached; a writer
	 *   may exist, so a caller must not release a claim on this answer.
	 */
	readonly state: "running" | "slot-occupied" | "not-started" | "unconfirmed";
	readonly reason: string;
	readonly handle: Handle | null;
	/** `true` when the handle is a broker that was already running. */
	readonly adopted: boolean;
	/** Broker pid, when a process was started or found. */
	readonly brokerPid: number | null;
	/** Milliseconds of the phases of a broker this call started (runtime check, verify, broker spawn, handshake); diagnostic only. */
	readonly timings?: Readonly<Record<string, number>>;
}

export interface BrokerAttachOutcome<Handle> {
	readonly state: "attached" | "unavailable";
	readonly reason: string;
	readonly handle: Handle | null;
	/** How an attach established the broker's identity and how long that took; absent when no attach was reached. */
	readonly identity?: BrokerIdentityProof;
}

/**
 * How an attach established that the process behind a record is the broker the record describes.
 * `trusted`: the broker's own token-authenticated statement of its pid and kernel creation time,
 * which a broker of this generation attests, with no kernel reading of this window's own.
 * `probe`: this window read the pid's creation time through the staged helper (a broker that
 * attests nothing, such as one started by an older build).
 */
export interface BrokerIdentityProof {
	readonly mode: "trusted" | "probe";
	readonly ms: number;
}

/** What an attach needs to know about this build's runtime, without staging anything. */
export interface PtyAttachIdentity {
	readonly ready: boolean;
	readonly reason: string | null;
	readonly runtimeVersion: number;
	/** The digest of this build's packaged broker tree. */
	readonly treeDigest: string | null;
}

/** The outcomes of a terminal broker (`managed-omp`, `folder-shell`). */
export type PtyLaunchOutcome = BrokerLaunchOutcome<PtyHandle>;
export type PtyAttachOutcome = BrokerAttachOutcome<PtyHandle>;
/** The outcomes of a `managed-rpc` broker. */
export type RpcLaunchOutcome = BrokerLaunchOutcome<RpcHandle>;
export type RpcAttachOutcome = BrokerAttachOutcome<RpcHandle>;

/**
 * Work an attach lets its caller start once the broker's status is known, concurrently with the
 * confirmation of the broker's own identity (a kernel reading for a broker that does not attest it).
 * The two readings of one proof are independent: neither is an input to the other, and each is taken
 * inside this proof, so neither is older than it (ADR-0035). The hook runs synchronously, starts the
 * work and returns; the caller keeps the work's own promise and must not let it reject unobserved.
 */
export interface AttachConcurrency<Handle> {
	readonly whileConfirming?: (handle: Handle) => void;
}

export interface PtyAttachResult {
	readonly fromPosition: number;
	/** `true` when the broker no longer holds everything after `fromPosition`. */
	readonly truncated: boolean;
	readonly oldestPosition: number;
	readonly status: PtyStatusPayload;
}

export interface PtySnapshotResult {
	readonly meta: PtySnapshotMeta;
	/** The serialized screen: ANSI text a renderer accepts as its starting state. */
	readonly data: string;
}

/** Anything a terminal handle pushes without being asked. */
export type PtyHandleEvent = BrokerHandleEvent | { readonly type: "output"; readonly fromPosition: number; readonly data: string };

/**
 * One attached terminal broker (`managed-omp` or `folder-shell`).
 *
 * Everything kind-independent — status, input ownership, stop, shutdown, detaching — is on
 * {@link BrokerHandle}; this adds the screen, replayed output and typed input. A
 * `managed-rpc` broker is attached with an `RpcHandle` instead and refuses these frames.
 */
export class PtyHandle extends BrokerHandle<PtyHandleEvent> {
	/** The exact current screen, as a serialized ANSI stream with its output position. */
	async snapshot(): Promise<PtySnapshotResult> {
		const collector: SnapshotCollector = { opened: null, parts: [], received: 0 };
		const answer = await this.request({ v: PTY_PROTOCOL_VERSION, t: "snapshot", id: 0 }, this.requestTimeoutMs, collector);
		if (answer.t !== "snapshot") throw new Error("the broker did not answer with a snapshot");
		return { meta: answer.meta, data: collector.parts.join("") };
	}

	/**
	 * Start receiving output.
	 *
	 * With `since`, the broker replays what it still holds from that position and says
	 * whether it held all of it. Without `since`, only output produced after this call
	 * is delivered, starting from the status's current position.
	 */
	async attach(options: { readonly since?: number } = {}): Promise<PtyAttachResult> {
		const status = this.lastStatus ?? (await this.refreshStatus());
		const since = options.since ?? status.outputPosition;
		const frame = await this.request({ v: PTY_PROTOCOL_VERSION, t: "attach", id: 0, sincePosition: since });
		if (frame.t !== "attached") throw new Error("the broker did not answer with an attach result");
		this.lastStatus = frame.status;
		return {
			fromPosition: frame.fromPosition,
			truncated: frame.truncated,
			oldestPosition: frame.oldestPosition,
			status: frame.status,
		};
	}

	/**
	 * Report this authenticated frontend's owner knowledge to the broker (ADR-0030).
	 *
	 * `owner` is the extension host's own view of its process topology, or `null` when it
	 * cannot attest one: a live VS Code instance may exist that this shell cannot see, so
	 * the broker disarms automatic stopping for the shell instead of leaving a grace
	 * armed. The broker answers with the resulting owner-stop state, which is folded into
	 * `statusValue` before this resolves — so a caller reads `statusValue?.ownerStop`
	 * synchronously afterwards and never presents a promise the broker did not make. An
	 * unattestable hint is a state (disarmed), not an error.
	 */
	async admitOwner(owner: PtyOwnerHint | null): Promise<PtyOwnerStopStatus> {
		const frame = await this.request({ v: PTY_PROTOCOL_VERSION, t: "admit-owner", id: 0, owner });
		if (frame.t !== "owner-stop") throw new Error("the broker did not answer the owner admission");
		this.foldOwnerStatus(frame.status);
		return frame.status;
	}

	async write(data: string, frontendId: string): Promise<void> {
		this.requireAck(await this.request({ v: PTY_PROTOCOL_VERSION, t: "input", id: 0, frontendId, data }));
	}

	async resize(cols: number, rows: number, frontendId: string): Promise<void> {
		this.requireAck(await this.request({ v: PTY_PROTOCOL_VERSION, t: "resize", id: 0, frontendId, cols, rows }));
	}

	protected handleFrame(frame: PtyBrokerFrame): void {
		switch (frame.t) {
			case "output":
				this.emit({ type: "output", fromPosition: frame.fromPosition, data: frame.data });
				return;
			case "snapshot": {
				const pending = this.pending.get(frame.id);
				if (pending?.snapshot === null || pending?.snapshot === undefined) return;
				pending.snapshot.opened = frame;
				if (frame.meta.chunks === 0) this.settle(frame.id, frame);
				return;
			}
			case "snapshot-data": {
				const collecting = this.pending.get(frame.id)?.snapshot;
				if (collecting === null || collecting === undefined) return;
				collecting.parts[frame.index] = frame.data;
				collecting.received += 1;
				// Settle with the frame that opened the snapshot, not with whichever chunk
				// completed it, so the caller always receives the snapshot metadata.
				if (collecting.opened !== null && collecting.received >= collecting.opened.meta.chunks) {
					this.settle(frame.id, collecting.opened);
				}
				return;
			}
			case "attached":
				this.lastStatus = frame.status;
				this.settle(frame.id, frame);
				return;
			default:
				super.handleFrame(frame);
		}
	}
}

/**
 * The extension host's broker client.
 *
 * One instance per window is enough: it holds no per-broker state, and every call
 * re-reads the record and re-proves the process it is about to talk to.
 */
export class PtyBrokerClient {
	private readonly options: PtyBrokerClientOptions;
	private readonly proof: PtyRuntimeProof;
	private probePromise: Promise<PtyProbeReadiness> | null = null;
	private identityPromise: Promise<PtyAttachIdentity> | null = null;
	private accessPromise: Promise<{ readonly ok: boolean; readonly reason: string | null }> | null = null;
	private readonly readings: PtyIdentityReadings;

	constructor(options: PtyBrokerClientOptions) {
		this.options = options;
		this.readings = new PtyIdentityReadings({ query: options.queryIdentity ?? queryPtyProcessIdentity });
		this.proof = new PtyRuntimeProof({
			probe: deadlineMs =>
				ensurePtyRuntime({
					storageDir: options.storageDir,
					extensionRoot: options.extensionRoot,
					...(options.nodePath === undefined ? {} : { nodePath: options.nodePath }),
					...(options.env === undefined ? {} : { env: options.env }),
					...(options.access === undefined ? {} : { access: options.access }),
					...(deadlineMs === undefined ? {} : { selfCheckDeadlineMs: deadlineMs }),
				}),
			...(options.log === undefined ? {} : { log: options.log }),
		});
	}

	/**
	 * Stage and prove the broker runtime.
	 *
	 * A proven answer is cached per process for the staged tree digest; a *refusal* is
	 * not, because the usual cause is a half-finished build or install that the next call
	 * should see the fix for. A probe that ran out of time with nothing observed to be
	 * wrong answers `ready` but not `proven` (a slow machine says nothing about the
	 * runtime): the launch proceeds and a repeated check settles it in the background
	 * ({@link PtyRuntimeProof}).
	 */
	async ready(): Promise<PtyRuntimeReadiness> {
		return await this.proof.ready();
	}

	/**
	 * What re-adopting an already-running broker needs: the verified identity probe.
	 *
	 * An attach reads a durable record, takes the recorded pid's kernel creation time
	 * through the probe, and authenticates with the record's token; it never executes the
	 * staged broker tree, so it does not wait for the tree's staging or self-check
	 * ({@link ready}, required before anything is *started*). A runtime already proven by
	 * {@link ready} answers from that proof. Only success is cached.
	 */
	async attachReady(): Promise<PtyProbeReadiness> {
		const proven = this.proof.provenAnswer();
		if (proven !== null && proven.runtime !== null) {
			return {
				ready: true,
				reason: null,
				runtimeVersion: proven.runtimeVersion,
				treeDigest: proven.treeDigest,
				helper: proven.runtime.helper,
			};
		}
		const cached = this.probePromise;
		if (cached !== null) {
			const readiness = await cached;
			if (readiness.ready) return readiness;
			this.probePromise = null;
		}
		const attempt = ensurePtyProbeHelper({
			storageDir: this.options.storageDir,
			extensionRoot: this.options.extensionRoot,
			...(this.options.access === undefined ? {} : { access: this.options.access }),
		});
		this.probePromise = attempt.catch(error => {
			this.probePromise = null;
			throw error;
		});
		return await this.probePromise;
	}

	/**
	 * What an attach needs from this build's runtime when the broker can vouch for itself: the
	 * runtime version and the digest of the packaged tree, hashed in place. Nothing is staged
	 * and no PowerShell runs, so a restore's first attach does not wait on the probe helper's
	 * staging and access verification; {@link attachReady} stages the helper only when a
	 * kernel reading is actually needed ({@link identityReading}). Only success is cached.
	 */
	async attachIdentity(): Promise<PtyAttachIdentity> {
		const proven = this.proof.provenAnswer();
		if (proven !== null && proven.treeDigest !== null) {
			return { ready: true, reason: null, runtimeVersion: proven.runtimeVersion, treeDigest: proven.treeDigest };
		}
		if (process.platform !== "win32") {
			return {
				ready: false,
				reason: `the PTY broker is implemented and measured for win32 only; this host is ${process.platform}`,
				runtimeVersion: PTY_RUNTIME_VERSION,
				treeDigest: null,
			};
		}
		const cached = this.identityPromise;
		if (cached !== null) {
			const known = await cached;
			if (known.ready) return known;
			this.identityPromise = null;
		}
		this.identityPromise = ptyPackagedTreeDigest(this.options.extensionRoot).then(
			(treeDigest): PtyAttachIdentity => ({ ready: true, reason: null, runtimeVersion: PTY_RUNTIME_VERSION, treeDigest }),
			(error: unknown): PtyAttachIdentity => ({
				ready: false,
				reason: `the packaged broker tree could not be read: ${messageOf(error)}`,
				runtimeVersion: PTY_RUNTIME_VERSION,
				treeDigest: null,
			}),
		);
		return await this.identityPromise;
	}

	/**
	 * This window's own kernel creation-time reading of one pid, for proving an attachment, an
	 * ownership verdict or a stop's pin: it stages the probe helper on first use and shares one
	 * probe among concurrent proofs of the same pid ({@link PtyIdentityReadings}); nothing is kept
	 * once a probe has answered. Absence and kill decisions take their own readings instead.
	 */
	async identityReading(pid: number): Promise<PtyIdentityReading> {
		const ready = await this.attachReady();
		if (!ready.ready || ready.helper === null) {
			return { kind: "unknown", detail: ready.reason ?? "the broker identity probe is not ready" };
		}
		return await this.readings.read(ready.helper, pid);
	}

	/** Every record this window can read, plus the ones it cannot. */
	async list(): Promise<PtyRecordListing> {
		return await listPtyRecords(this.options.storageDir);
	}

	async readRecord(slot: string): Promise<PtyRecordLookup> {
		return await readPtyRecord(this.options.storageDir, slot);
	}

	/** The record path for a slot, for diagnostics that must not read the token. */
	recordPath(slot: string): string {
		return ptyRecordPath(this.options.storageDir, slot);
	}

	stateDirectory(): string {
		return ptyStateDirectory(this.options.storageDir);
	}

	/**
	 * Reattach to the broker that owns a slot, without ever starting one.
	 *
	 * Reports `unavailable` with a reason for everything that is not a proven live
	 * broker of this protocol: a missing record, a record this build cannot read, a
	 * broker pid that is gone or was reused, a connection the broker refused.
	 */
	async attach(slot: string, options: { readonly owner?: PtyOwnerHint | null } & AttachConcurrency<PtyHandle> = {}): Promise<PtyAttachOutcome> {
		const lookup = await readPtyRecord(this.options.storageDir, slot);
		if (lookup.kind === "none") return { state: "unavailable", reason: "no broker is recorded for this slot", handle: null };
		if (lookup.kind === "invalid") {
			return { state: "unavailable", reason: `the broker record could not be read: ${lookup.detail}`, handle: null };
		}
		// Pass the owner field through exactly as given: omitting it makes no ownership
		// claim, while an explicit `null` says this authenticated frontend cannot attest an
		// owner and must disarm the watch.
		return await this.attachRecord(lookup.record, { adopted: true, owner: options.owner, whileConfirming: options.whileConfirming });
	}

	/**
	 * Reattach to the `managed-rpc` broker that owns a slot, without ever starting one.
	 *
	 * The same proofs as {@link attach} (record, protocol, runtime version, the broker's own
	 * kernel identity, the handshake), then an {@link RpcHandle}. A record of another kind is
	 * `unavailable`: its frames are not the ones an rpc child is spoken to with.
	 */
	async attachRpc(slot: string, options: AttachConcurrency<RpcHandle> = {}): Promise<RpcAttachOutcome> {
		const lookup = await readPtyRecord(this.options.storageDir, slot);
		if (lookup.kind === "none") return { state: "unavailable", reason: "no broker is recorded for this slot", handle: null };
		if (lookup.kind === "invalid") {
			return { state: "unavailable", reason: `the broker record could not be read: ${lookup.detail}`, handle: null };
		}
		return await this.attachRpcRecord(lookup.record, { adopted: true, whileConfirming: options.whileConfirming });
	}

	/** Attach to one known terminal record. See {@link attach} for the rules. */
	async attachRecord(
		record: PtyBrokerRecord,
		options: { readonly adopted?: boolean; readonly owner?: PtyOwnerHint | null } & AttachConcurrency<PtyHandle> = {},
	): Promise<PtyAttachOutcome> {
		if (record.kind === "managed-rpc") {
			return { state: "unavailable", reason: "the record is a managed-rpc slot; it is attached with attachRpcRecord", handle: null };
		}
		const opened = await this.connectRecord(record);
		if (!opened.ok) return { state: "unavailable", reason: opened.reason, handle: null };
		const handle = new PtyHandle(opened.connection, record, options.adopted === true, opened.buildMatches);
		let identity: BrokerIdentityProof;
		try {
			await handle.refreshStatus();
			options.whileConfirming?.(handle);
			const confirmed = await this.confirmBrokerIdentity(record, handle.statusValue);
			if (!confirmed.ok) {
				handle.disconnect();
				return { state: "unavailable", reason: confirmed.reason, handle: null };
			}
			identity = confirmed.proof;
		} catch (error) {
			handle.disconnect();
			return { state: "unavailable", reason: `the broker did not report its state: ${messageOf(error)}`, handle: null };
		}
		// An authenticated folder-shell attachment reports what it knows: a hint to attest,
		// or `null` when this frontend cannot attest an owner, which disarms automatic
		// stopping before `attach` resolves (ADR-0030). A caller that omits the field makes
		// no ownership claim (read-only observation, diagnostics), so it neither admits nor
		// disarms anything.
		if (handle.kind === "folder-shell" && options.owner !== undefined) {
			try {
				await handle.admitOwner(options.owner);
			} catch (error) {
				return {
					state: "attached",
					reason: `attached, but the owner state was not reported: ${messageOf(error)}`,
					handle,
					identity,
				};
			}
		}
		return {
			state: "attached",
			reason: opened.buildMatches ? "attached" : "attached to a broker running another build's runtime",
			handle,
			identity,
		};
	}

	/** Attach to one known `managed-rpc` record. See {@link attachRpc}. */
	async attachRpcRecord(record: PtyBrokerRecord, options: { readonly adopted?: boolean } & AttachConcurrency<RpcHandle> = {}): Promise<RpcAttachOutcome> {
		if (record.kind !== "managed-rpc") {
			return { state: "unavailable", reason: "the record is not a managed-rpc slot", handle: null };
		}
		const opened = await this.connectRecord(record);
		if (!opened.ok) return { state: "unavailable", reason: opened.reason, handle: null };
		const reconnect = async (): Promise<PtyClientSideConnection> => {
			const again = await this.connectRecord(record);
			if (!again.ok) throw new Error(again.reason);
			// A broker that attested its identity on the first attach is the same authenticated broker; one that did not is
			// read through the kernel again, as every attach to it is.
			if (handle.statusValue === null || attestationOf(handle.statusValue) === null) {
				const confirmed = await this.confirmBrokerIdentity(record, handle.statusValue);
				if (!confirmed.ok) {
					again.connection.close("the broker's identity could not be confirmed");
					throw new Error(confirmed.reason);
				}
			}
			return again.connection;
		};
		const handle = new RpcHandle(opened.connection, record, options.adopted === true, opened.buildMatches, reconnect);
		let identity: BrokerIdentityProof;
		try {
			await handle.refreshStatus();
			await handle.awaitChildIdentity(CHILD_IDENTITY_WAIT_MS);
			options.whileConfirming?.(handle);
			const confirmed = await this.confirmBrokerIdentity(record, handle.statusValue);
			if (!confirmed.ok) {
				handle.disconnect();
				return { state: "unavailable", reason: confirmed.reason, handle: null };
			}
			identity = confirmed.proof;
		} catch (error) {
			handle.disconnect();
			return { state: "unavailable", reason: `the broker did not report its state: ${messageOf(error)}`, handle: null };
		}
		return {
			state: "attached",
			reason: opened.buildMatches ? "attached" : "attached to a broker running another build's runtime",
			handle,
			identity,
		};
	}

	/**
	 * Everything an attach proves before it sends a frame beyond the handshake: protocol,
	 * runtime version, state access, then the authenticated handshake naming the same slot,
	 * process and kernel creation time as the record.
	 *
	 * No PowerShell runs here. The handshake is a mutual proof of the record's token, which
	 * only the broker that minted it and an owner-only reader of the record hold, and the
	 * broker's own pid and creation time are inside its MAC; a stranger on a reused pid or port
	 * cannot answer it, and the proof the client sends reveals nothing of the token. Whether the
	 * broker's *claims* may replace this window's kernel reading of them is decided from its
	 * status by {@link confirmBrokerIdentity} (ADR-0035, amendment 2026-10-13).
	 */
	private async connectRecord(
		record: PtyBrokerRecord,
	): Promise<
		| { readonly ok: true; readonly connection: PtyClientSideConnection; readonly buildMatches: boolean }
		| { readonly ok: false; readonly reason: string }
	> {
		if (record.protocolVersion !== PTY_PROTOCOL_VERSION) {
			return {
				ok: false,
				reason: `the recorded broker speaks protocol version ${record.protocolVersion}; this build speaks ${PTY_PROTOCOL_VERSION}`,
			};
		}
		const ready = await this.attachIdentity();
		if (!ready.ready || ready.treeDigest === null) {
			return { ok: false, reason: ready.reason ?? "this build's broker runtime could not be identified" };
		}
		if (record.runtimeVersion !== ready.runtimeVersion) {
			// A surviving broker of another runtime version is retained and reported, never
			// driven as if it were this build's (ADR-0024).
			return {
				ok: false,
				reason: `the recorded broker runs runtime version ${record.runtimeVersion}; this build runs ${ready.runtimeVersion}`,
			};
		}
		const access = await this.stateAccess();
		if (!access.ok) {
			return { ok: false, reason: `the broker state directory is not usable: ${access.reason ?? "unknown"}` };
		}
		if (record.brokerCreationTime === null) {
			return {
				ok: false,
				reason: `process ${record.brokerPid} is not the broker this record describes: the record carries no creation time`,
			};
		}
		// A coarse in-process liveness check only: a pid nobody holds is refused at once, before a socket is opened.
		if (!isPtyProcessAlive(record.brokerPid)) {
			return { ok: false, reason: `the recorded broker process ${record.brokerPid} is gone` };
		}
		let connection: PtyClientSideConnection;
		try {
			connection = await connectPtyBroker({
				token: record.token,
				brokerId: record.brokerId,
				generation: record.generation,
				port: record.port,
			});
		} catch (error) {
			return { ok: false, reason: messageOf(error) };
		}
		if (
			connection.hello.slot !== record.slot ||
			connection.hello.brokerPid !== record.brokerPid ||
			connection.hello.brokerCreationTime !== record.brokerCreationTime
		) {
			connection.close("the broker proved a different slot or process");
			return { ok: false, reason: "the broker proved a different slot or process than its record names" };
		}
		// Compare against the runtime *this* build proved, not against the record: a record
		// and a hello from the same older broker always agree, so comparing them would
		// report an outdated build as current.
		return { ok: true, connection, buildMatches: connection.hello.treeDigest === ready.treeDigest };
	}

	/**
	 * Decide, from the authenticated status, whether the broker's pid and creation time stand on
	 * the broker's own word or need this window's kernel reading.
	 *
	 * The status must agree with the record and the handshake, or the attach is refused. A broker
	 * that attests its identity (`brokerSelfRead`: it read its own creation time before publishing
	 * the record) is believed: it proved the token, so it is the process that minted it, and no
	 * reading is taken. A broker that does not (one started by an older build) is read through the
	 * staged probe, exactly as every attach used to read it.
	 */
	private async confirmBrokerIdentity(
		record: PtyBrokerRecord,
		status: PtyStatusPayload | null,
	): Promise<{ readonly ok: true; readonly proof: BrokerIdentityProof } | { readonly ok: false; readonly reason: string }> {
		const started = (this.options.now ?? Date.now)();
		const elapsed = (): number => (this.options.now ?? Date.now)() - started;
		if (status === null) return { ok: false, reason: "the broker did not report its state" };
		if (status.brokerPid !== record.brokerPid || status.brokerCreationTime !== record.brokerCreationTime) {
			return { ok: false, reason: "the broker reports another process identity than its record names" };
		}
		if (attestationOf(status) !== null) return { ok: true, proof: { mode: "trusted", ms: elapsed() } };
		const identity = await this.identityReading(record.brokerPid);
		if (identity.kind !== "found") {
			return {
				ok: false,
				reason:
					identity.kind === "gone"
						? `the recorded broker process ${record.brokerPid} is gone`
						: `the recorded broker process could not be identified: ${identity.detail}`,
			};
		}
		if (identity.creationTime !== record.brokerCreationTime) {
			return {
				ok: false,
				reason: `process ${record.brokerPid} is not the broker this record describes: its creation time does not match`,
			};
		}
		return { ok: true, proof: { mode: "probe", ms: elapsed() } };
	}

	/**
	 * Own a slot: adopt its live broker, or start one only when no record exists.
	 *
	 * A retained record is never replaced merely because its broker is gone: its
	 * child or an escaped descendant may still exist. Keep that recovery metadata
	 * and report the slot occupied until tree absence can actually be established.
	 */
	async launch(spec: PtyLaunchSpec): Promise<PtyLaunchOutcome> {
		if (spec.kind === "managed-rpc") {
			return { state: "not-started", reason: "a managed-rpc slot is started with launchRpc", handle: null, adopted: false, brokerPid: null };
		}
		return await this.launchSlot(spec, (record, adopted) => this.attachRecord(record, { adopted, owner: spec.owner }));
	}

	/** Own a `managed-rpc` slot under the same rules as {@link launch}: adopt, or start only when no record exists. */
	async launchRpc(spec: PtyLaunchSpec): Promise<RpcLaunchOutcome> {
		if (spec.kind !== "managed-rpc") {
			return { state: "not-started", reason: "launchRpc starts a managed-rpc slot only", handle: null, adopted: false, brokerPid: null };
		}
		return await this.launchSlot(spec, (record, adopted) => this.attachRpcRecord(record, { adopted }));
	}

	private async launchSlot<Handle extends { readonly buildMatches: boolean }>(
		spec: PtyLaunchSpec,
		attach: (record: PtyBrokerRecord, adopted: boolean) => Promise<BrokerAttachOutcome<Handle>>,
	): Promise<BrokerLaunchOutcome<Handle>> {
		const launcherId = `launch-${randomBytes(12).toString("hex")}`;
		// Decide under the slot's interprocess lock. Another window may claim a
		// recordless slot concurrently; a recorded slot stays occupied even when
		// its broker is no longer reachable.
		const acquired = await acquirePtySlotLock(this.options.storageDir, spec.slot, {
			holderId: launcherId,
			isHolderAlive: (pid: number) => isPtyProcessAlive(pid),
		});
		if (!acquired.acquired) {
			return { state: "slot-occupied", reason: acquired.detail, handle: null, adopted: false, brokerPid: null };
		}
		try {
			const lookup = await readPtyRecord(this.options.storageDir, spec.slot);
			if (lookup.kind === "invalid") {
				return {
					state: "slot-occupied",
					reason: `the slot holds a record this build cannot read: ${lookup.detail}`,
					handle: null,
					adopted: false,
					brokerPid: null,
				};
			}
			if (lookup.kind === "ok") {
				const attached = await attach(lookup.record, true);
				if (attached.state === "attached" && attached.handle !== null) {
					if (!attached.handle.buildMatches) {
						// A live broker of another build keeps its slot and its writer: it is
						// reported, never replaced and never adopted as this build's.
						return {
							state: "slot-occupied",
							reason: "a broker of another build owns the slot; it was not replaced",
							handle: attached.handle,
							adopted: false,
							brokerPid: lookup.record.brokerPid,
						};
					}
					return {
						state: "running",
						reason: "adopted the running broker",
						handle: attached.handle,
						adopted: true,
						brokerPid: lookup.record.brokerPid,
					};
				}
				const ready = await this.ready();
				if (!ready.ready || ready.runtime === null) {
					return { state: "not-started", reason: ready.reason ?? "the broker runtime is not ready", handle: null, adopted: false, brokerPid: null };
				}
				const identity = await queryPtyProcessIdentity(ready.runtime.helper, lookup.record.brokerPid);
				// A gone broker does NOT mean its child's process tree is gone: an escaped
				// descendant may still be running, so retiring this record would drop the
				// only recovery metadata for the slot and let a second writer start in it.
				// The record is kept and the slot reported occupied either way. Only a
				// provably never-spawned child (which retires its own record) frees a slot,
				// and replacing an uncertain one needs an explicit abandon, which this
				// build does not offer.
				return {
					state: "slot-occupied",
					reason:
						identity.kind === "gone"
							? `the recorded broker ${lookup.record.brokerPid} is gone, but its child's process tree was never proven gone, so the record is kept as recovery metadata (${attached.reason})`
							: `${attached.reason}; the recorded process ${lookup.record.brokerPid} ${
									identity.kind === "found" ? "is still present" : "could not be identified"
								}`,
					handle: null,
					adopted: false,
					brokerPid: lookup.record.brokerPid,
				};
			}
			return await this.startBroker(spec, launcherId, attach);
		} finally {
			await releasePtySlotLock(this.options.storageDir, spec.slot, launcherId);
		}
	}

	/** Start a folder shell in one step: a resolved shell, its own slot, no OMP involved. */
	async launchFolderShell(request: PtyFolderShellRequest): Promise<PtyLaunchOutcome> {
		return await this.launch(await folderShellLaunchSpec(request));
	}

	/** The spec a folder shell would use, without starting anything. */
	async shellSpec(request: PtyFolderShellRequest): Promise<PtyLaunchSpec> {
		return await folderShellLaunchSpec(request);
	}

	/** Start a broker and wait for its record and handshake: one writer, or an honest report. */
	private async startBroker<Handle extends { readonly buildMatches: boolean }>(
		spec: PtyLaunchSpec,
		launcherId: string,
		attach: (record: PtyBrokerRecord, adopted: boolean) => Promise<BrokerAttachOutcome<Handle>>,
	): Promise<BrokerLaunchOutcome<Handle>> {
		const proofStartedAt = Date.now();
		const ready = await this.ready();
		if (!ready.ready || ready.runtime === null) {
			return { state: "not-started", reason: ready.reason ?? "the broker runtime is not ready", handle: null, adopted: false, brokerPid: null };
		}
		const runtime: PtyRuntime = ready.runtime;
		const proofMs = Date.now() - proofStartedAt;
		// Re-read every staged file immediately before starting: a path says nothing
		// about the bytes that are there now.
		if (!(await verifyPtyRuntime(runtime))) {
			return {
				state: "not-started",
				reason: "the staged broker runtime no longer holds the bytes it was staged with, so it was not started",
				handle: null,
				adopted: false,
				brokerPid: null,
			};
		}
		const access = await this.stateAccess();
		if (!access.ok) {
			return {
				state: "not-started",
				reason: `the broker state directory is not usable: ${access.reason ?? "unknown"}`,
				handle: null,
				adopted: false,
				brokerPid: null,
			};
		}
		const verifiedMs = Date.now() - proofStartedAt - proofMs;
		const spawnStartedAt = Date.now();
		const logPath = this.logPathFor(spec.slot);
		const args = buildBrokerArguments(spec, runtime, this.options.storageDir, logPath, launcherId);
		let child: { readonly pid?: number; readonly exitCode: number | null };
		try {
			child = spawnPtyBroker(runtime, args, {
				storageDir: this.options.storageDir,
				extensionRoot: this.options.extensionRoot,
				...(this.options.nodePath === undefined ? {} : { nodePath: this.options.nodePath }),
				...(this.options.env === undefined ? {} : { env: this.options.env }),
			});
		} catch (error) {
			return { state: "not-started", reason: `the broker could not be started: ${messageOf(error)}${await this.withdrawReusedProof()}`, handle: null, adopted: false, brokerPid: null };
		}
		const spawned = child.pid ?? null;
		const record = await this.waitForRecord(spec.slot, child);
		if (record === null) {
			const exitCode = child.exitCode;
			if (exitCode === null) {
				return {
					state: "unconfirmed",
					reason: "the broker did not publish a record in time; it may still be starting",
					handle: null,
					adopted: false,
					brokerPid: spawned,
				};
			}
			const log = await this.readLogTail(spec.slot);
			return {
				state: "not-started",
				reason: `the broker exited with code ${exitCode}${log.length > 0 ? `: ${log}` : ""}${await this.withdrawReusedProof()}`,
				handle: null,
				adopted: false,
				brokerPid: spawned,
			};
		}
		const spawnMs = Date.now() - spawnStartedAt;
		const handshakeStartedAt = Date.now();
		// The record exists, so a broker owns the slot. Attach, retrying while the broker
		// reads its own child's identity.
		let lastReason = "the broker did not answer the handshake";
		for (let attempt = 0; attempt < ATTACH_ATTEMPTS; attempt += 1) {
			const attached = await attach(record, false);
			if (attached.state === "attached") {
				const timings = { "runtime check": proofMs, verify: verifiedMs, "broker spawn": spawnMs, handshake: Date.now() - handshakeStartedAt };
				return { state: "running", reason: "started", handle: attached.handle, adopted: false, brokerPid: record.brokerPid, timings };
			}
			lastReason = attached.reason;
			await delay(ATTACH_RETRY_MS);
		}
		// A broker that published its record and then ended without ever being attached failed the way a broken
		// runtime does; one still running only answered slowly, and the proof it started on stands.
		const withdrawn = child.exitCode === null ? "" : await this.withdrawReusedProof();
		return {
			state: "unconfirmed",
			reason: `a broker owns the slot but could not be attached: ${lastReason}${withdrawn}`,
			handle: null,
			adopted: false,
			brokerPid: record.brokerPid,
		};
	}

	/**
	 * A launch failed before any broker existed. When it ran on a proof an earlier window stored, that proof
	 * is the one thing this window did not check itself, so it is withdrawn (file and in-process copies) and
	 * the next launch re-runs the self-check and reports a diagnosed refusal. Returns the sentence that says
	 * so for the failure's own reason, or an empty string when the proof was computed here.
	 */
	private async withdrawReusedProof(): Promise<string> {
		const reused = this.proof.discardReusedProof();
		if (reused === null) return "";
		await discardReusedPtyProof(reused);
		return "; the runtime proof stored by an earlier window was discarded, so the next launch checks the runtime again";
	}

	/** Wait for the slot's record to appear, or for the started process to end. */
	private async waitForRecord(slot: string, child: { readonly exitCode: number | null }): Promise<PtyBrokerRecord | null> {
		const deadline = Date.now() + DEFAULT_START_TIMEOUT_MS;
		for (;;) {
			const lookup = await readPtyRecord(this.options.storageDir, slot);
			if (lookup.kind === "ok") return lookup.record;
			if (lookup.kind === "invalid") return null;
			if (child.exitCode !== null) return null;
			if (Date.now() >= deadline) return null;
			await delay(150);
		}
	}

	/** The last lifecycle lines a broker wrote for this slot, for a failed start. */
	private async readLogTail(slot: string): Promise<string> {
		try {
			const text = await readFile(this.logPathFor(slot), "utf8");
			return text.trim().split(/\r?\n/).slice(-3).join("; ");
		} catch {
			return "";
		}
	}

	private logPathFor(slot: string): string {
		const name = ptyRecordPath(this.options.storageDir, slot).replace(/\.json$/, "");
		return join(ptyStateDirectory(this.options.storageDir), "logs", `${name.split(/[\\/]/).pop() ?? "broker"}.log`);
	}

	/**
	 * Verify the record directory's access once per client, and remember the outcome.
	 *
	 * Every attach and launch waits for this verdict before it trusts anything under the
	 * directory. It is PowerShell work of about a second (several seconds under load), so
	 * a window that starts it as soon as the client exists lets it run while the rest of
	 * activation proceeds instead of in front of the first re-adoption. Starting it early
	 * changes when the check runs, never what it checks or who has to pass it.
	 */
	async stateAccess(): Promise<{ readonly ok: boolean; readonly reason: string | null }> {
		const cached = this.accessPromise;
		if (cached !== null) return await cached;
		this.accessPromise = ensurePtyStateAccess(this.options.storageDir, this.options.access).catch(error => ({
			ok: false,
			reason: messageOf(error),
		}));
		return await this.accessPromise;
	}
}

/**
 * The complete argument line for one broker, excluding the entry script itself.
 *
 * Nothing secret is on this line: the token lives in the record.
 */
export function buildBrokerArguments(
	spec: PtyLaunchSpec,
	runtime: PtyRuntime,
	storageDir: string,
	logPath: string | null,
	launcherId?: string,
): string[] {
	const args = [
		"--slot",
		spec.slot,
		"--kind",
		spec.kind,
		"--storage-dir",
		storageDir,
		"--tree-digest",
		runtime.tree.digest,
		"--file",
		spec.file,
		"--cwd",
		spec.cwd,
		"--cols",
		String(spec.cols ?? 80),
		"--rows",
		String(spec.rows ?? 24),
		"--helper",
		runtime.helper.path,
		"--helper-sha256",
		runtime.helper.sha256,
		"--owner-helper",
		runtime.ownerHelper.path,
		"--owner-helper-sha256",
		runtime.ownerHelper.sha256,
		"--owner-grace-ms",
		String(spec.ownerGraceMs ?? PTY_DEFAULT_OWNER_GRACE_MS),
	];
	// The hint is passed to the broker as well as sent on the attach that follows, so a
	// shell stays watched even when no client ever manages to attach, which is exactly
	// the situation the watch exists for (ADR-0030). The broker attests it either way.
	if (spec.owner !== undefined && spec.owner !== null) {
		args.push(
			"--owner-host-pid",
			String(spec.owner.extensionHostPid),
			"--owner-parent-pid",
			String(spec.owner.parentPid),
			"--owner-main-pid",
			String(spec.owner.mainPid),
		);
	}
	if (launcherId !== undefined) args.push("--launch-id", launcherId);
	if (spec.title !== null && spec.title !== undefined) args.push("--title", spec.title);
	if (spec.scrollbackLines !== undefined) args.push("--scrollback", String(spec.scrollbackLines));
	if (spec.backlogChars !== undefined) args.push("--backlog", String(spec.backlogChars));
	if (spec.exitRetentionMs !== undefined) args.push("--exit-retention-ms", String(spec.exitRetentionMs));
	if (logPath !== null) args.push("--log", logPath);
	for (const [name, value] of Object.entries(spec.env ?? {})) args.push("--env", `${name}=${value ?? ""}`);
	for (const argument of spec.args) args.push("--arg", argument);
	return args;
}

function delay(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	const timer = setTimeout(resolve, ms);
	timer.unref();
	return promise;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
