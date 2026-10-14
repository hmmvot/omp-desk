/**
 * Host control for the in-process runtime (ADR-0066, cut 5): the verified, authenticated channel
 * from a window to the exact OMP process it launched or re-adopted, and the credentials that
 * belong to that launch.
 *
 * The channel is established only after the host proves it is the exact process this window
 * launched (same pid, same kernel process generation, same pipe server) and completes the HMAC
 * handshake. Until then host control is reported as unavailable, and a launch never depends on
 * it succeeding. The window's record of the conversation (`RuntimeRecord`) holds the published
 * client; what the window does once a channel is published (a subagent watch, the document
 * capability, the guest's controls) is its `published` hook.
 */
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Logger } from "../shared/logger.ts";
import type { ChatRuntime } from "../host/chat-runtime.ts";
import { isOpenControlClient, mayPublishControlChannel, mayReportControlFailure } from "../host/control-attempt.ts";
import type { ControlAttemptPlan } from "../host/control-attempt.ts";
import {
	HostControlClient,
	HostControlConfigurationError,
	HostControlIdentityError,
	HostControlRefusedError,
	HostControlUnavailableError,
	queryControlProcessGeneration,
} from "../host/control-client.ts";
import type { HostControlExpectation, HostControlVerifiedConnection } from "../host/control-client.ts";
import { readControlRendezvous } from "../host/control-protocol.ts";
import type { ControlRendezvous } from "../host/control-protocol.ts";
import type { DiagnosticsRecorder } from "../host/diagnostics.ts";
import type { LaunchTimeline } from "../host/launch-timeline.ts";
import type { SessionHostRuntime } from "../host/native-session.ts";
import type { SessionIndex } from "../host/session-index.ts";
import type { SessionIndexEntry } from "../host/session-model.ts";
import type { NativeControlBootstrap } from "../host/native-terminal.ts";
import type { RuntimeRecord, RuntimeRecords } from "./runtime-record.ts";

const CONTROL_RENDEZVOUS_TIMEOUT_MS = 15_000;
const NATIVE_CONTROL_RENDEZVOUS_TIMEOUT_MS = 60_000;
/** A host this launch already proved published once; a missing record is not startup lag. */
const PROVEN_CONTROL_RENDEZVOUS_TIMEOUT_MS = 3_000;
const CONTROL_RENDEZVOUS_POLL_MS = 250;

/** Releases remembered per claim; a slot id is never reused, so this is bounded history. */
const CONTROL_RELEASE_HISTORY = 16;

/** The credentials of one launch: the public bootstrap the process is given and the private half stored for the window. */
export interface PreparedHostControl {
	readonly bootstrap: NativeControlBootstrap;
	readonly privateKeyPkcs8Pem: string;
}

/** Non-secret control facts persisted per ownership so a reload can reattach. */
export interface RecordedControlProcess {
	readonly pid: number;
	/** Kernel creation time of that pid; the process-generation identity. */
	readonly processCreation: string;
	readonly slotId: string;
	readonly directory: string;
	readonly activity?: true;
	readonly work?: true;
	/** The child answers the registry `subagentWork` request; absent for a process an older build launched. */
	readonly subagents?: true;
	/** Why this launch carried no host-control recipient (its launcher cannot take the startup options); the process runs without a channel. */
	readonly withheld?: string;
}

/**
 * One launch this window confirmed stopped, remembered under its claim.
 *
 * A release is the launcher's own evidence that a specific slot's process exited
 * (the stop is only confirmed after the pid is gone). It names the slot, so it can
 * only ever speak for the launch it released.
 */
export interface RecordedControlRelease {
	readonly slotId: string;
	readonly releasedAt: string;
}

export interface EstablishControlInput {
	readonly directory: string;
	readonly slotId: string;
	readonly pid: number;
	readonly processCreation: string;
	readonly privateKeyPkcs8Pem: string;
	readonly expectation: HostControlExpectation;
	readonly activity: boolean;
	readonly work?: boolean;
	readonly subagents?: boolean;
	/** Only set when reattaching a process believed to be the same one. */
	readonly provenKey?: string | undefined;
}

/** Where a window keeps host-control material: its profile's global state and secret storage. */
export interface ControlStore {
	directory(): string;
	record<T>(key: string): T | undefined;
	setRecord(key: string, value: unknown): Promise<void>;
	secret(name: string): Promise<string | undefined>;
	setSecret(name: string, value: string): Promise<void>;
	deleteSecret(name: string): Promise<void>;
}

/** What host control asks of its window; in-process only (design §2.5). */
export interface ControlWindow {
	/** A verified channel was published for this conversation; `subagents` asks for the registry subagent watch. Runs under the gate. */
	published(conversation: string, client: HostControlClient, subagents: boolean): void;
}

export interface LocalHostControlDeps {
	readonly index: SessionIndex;
	readonly window: ControlWindow;
	readonly records: RuntimeRecords;
	readonly store: ControlStore;
	readonly chat: () => Pick<ChatRuntime, "sessionOf">;
	readonly diagnostics: () => DiagnosticsRecorder;
	readonly log: Logger;
	/** The new-session timeline: the verified channel ends it with its second report. */
	readonly timeline?: LaunchTimeline;
	/** Launch, recovery and the native watch share one attempt for the exact runtime; the window owns the table, as it owns the broker watches. */
	readonly attempts: WeakMap<SessionHostRuntime, Promise<void>>;
	/**
	 * Settles once the window's staged pipe helper is configured, or once staging failed (the proof then refuses
	 * visibly with `helper-unavailable`, as it always has). The control client has no helper until staging has run,
	 * so every step that spawns it — the process-generation read and the peer-verified connection — waits here
	 * first, and nothing that does not spawn it waits for staging.
	 */
	readonly stagedHelper: () => Promise<void>;
}

/** Secrets are scoped to the claim's owner generation, so windows never share one. */
export function recipientSecretName(ownerGeneration: string): string {
	return `omp.hostControl.recipient.${ownerGeneration}`;
}

export function provenKeySecretName(ownerGeneration: string): string {
	return `omp.hostControl.key.${ownerGeneration}`;
}

export function controlProcessRecordKey(ownerGeneration: string): string {
	return `omp.hostControl.process.${ownerGeneration}`;
}

export function controlReleaseRecordKey(ownerGeneration: string): string {
	return `omp.hostControl.releasedSlots.${ownerGeneration}`;
}

/** The directory the native host's control records live in, under the extension's global storage. */
export function controlDirectoryOf(globalStoragePath: string): string {
	return path.join(globalStoragePath, "host-control");
}

/** Native credentials follow the exact launch, never the mutable conversation row. */
export function controlOwnerFor(runtime: SessionHostRuntime, ownerGeneration: string): string {
	return runtime.kind === "terminal" ? `native.${runtime.identity.slot}` : ownerGeneration;
}

export function recordedControlOwner(entry: SessionIndexEntry): string | null {
	return entry.host?.transport === "native" && entry.host.rpc != null ? `native.${entry.host.rpc.slot}` : entry.ownership?.ownerGeneration ?? null;
}

export function describeControlError(error: unknown): string {
	if (error instanceof HostControlRefusedError) return `request refused (${error.code})`;
	if (error instanceof HostControlIdentityError) {
		return error.reason === "key-changed"
			? "Host control refused: the control record belongs to a different process than this session's. Reload the session to restore statuses and notifications."
			: `host identity check failed (${error.reason})`;
	}
	if (error instanceof HostControlUnavailableError) return error.timedOut ? "OMP did not answer in time (it may be busy)" : "native host connection unavailable";
	if (error instanceof HostControlConfigurationError) return "host-control configuration invalid";
	return "unexpected host-control failure";
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class LocalHostControl {
	readonly #deps: LocalHostControlDeps;
	constructor(deps: LocalHostControlDeps) {
		this.#deps = deps;
	}

	/** The attempt to connect exactly this runtime that is in flight, if any. */
	attempt(runtime: SessionHostRuntime): Promise<void> | undefined {
		return this.#deps.attempts.get(runtime);
	}

	async #singleFlight(runtime: SessionHostRuntime, connect: () => Promise<void>): Promise<void> {
		const pending = this.#deps.attempts.get(runtime);
		if (pending !== undefined) return pending;
		const attempt = connect();
		this.#deps.attempts.set(runtime, attempt);
		try { await attempt; }
		finally { if (this.#deps.attempts.get(runtime) === attempt) this.#deps.attempts.delete(runtime); }
	}

	/**
	 * Generate this launch's recipient and persist its private half *before* the process exists,
	 * so a launch can never outrun the key that decrypts its rendezvous. The caller reports a
	 * failure here as a visible unavailability; the session still starts without the channel.
	 */
	async storeRecipient(ownerGeneration: string, privateKeyPkcs8Pem: string): Promise<void> {
		await this.#deps.store.setSecret(recipientSecretName(ownerGeneration), privateKeyPkcs8Pem);
	}

	/** Where the native host publishes its control records. */
	directory(): string {
		return this.#deps.store.directory();
	}

	/**
	 * Establish the channel for a host this window just launched.
	 *
	 * The process generation is probed first and persisted with the ownership, so a
	 * later reload can prove it is talking to the same kernel process rather than a
	 * recycled pid.
	 */
	connect(conversation: string, ownerGeneration: string, runtime: SessionHostRuntime, prepared: PreparedHostControl): Promise<void> {
		return this.#singleFlight(runtime, () => this.#connectAttempt(conversation, ownerGeneration, runtime, prepared));
	}

	/**
	 * Record that host control was deliberately not started for a host this window just launched, and why: its
	 * launcher cannot carry the recipient (ADR-0075). The marker lives where a started channel's record would, so a
	 * reload, the native watch and a reattach all find it and stay quiet instead of looking for a channel that was
	 * never offered; the recipient's private half is dropped because nothing can ever use it.
	 */
	withhold(conversation: string, ownerGeneration: string, runtime: SessionHostRuntime, prepared: PreparedHostControl, reason: string): Promise<void> {
		return this.#singleFlight(runtime, async () => {
			const { index, store, log } = this.#deps;
			const owner = controlOwnerFor(runtime, ownerGeneration);
			let processCreation: string;
			try {
				await this.#deps.stagedHelper();
				processCreation = await queryControlProcessGeneration(runtime.pid);
			} catch (error) {
				log.warn(`tab ${conversation}: host control was withheld (${reason}) and its marker could not be recorded: ${messageOf(error)}`);
				return;
			}
			const record: RecordedControlProcess = {
				pid: runtime.pid,
				processCreation,
				slotId: prepared.bootstrap.slotId,
				directory: prepared.bootstrap.directory,
				withheld: reason,
			};
			await index.lifecycle.run(conversation, async () => {
				if (this.#deps.records.get(conversation)?.runtime !== runtime) return;
				await store.setRecord(controlProcessRecordKey(owner), record);
				await store.deleteSecret(recipientSecretName(owner));
			});
			this.#deps.diagnostics().notObserved(conversation, "host-control-verified", reason);
			log.warn(`tab ${conversation}: host control withheld — ${reason}`);
		});
	}

	async #connectAttempt(
		tabId: string,
		ownerGeneration: string,
		runtime: SessionHostRuntime,
		prepared: PreparedHostControl,
	): Promise<void> {
		const { index, window, store } = this.#deps;
		const pid = runtime.pid;
		const attempt: ControlAttemptPlan = { runtime, pid };
		ownerGeneration = controlOwnerFor(runtime, ownerGeneration);
		if (runtime.kind === "chat") {
			const session = this.#deps.chat().sessionOf(tabId);
			if (session === null) return;
			await session.start();
			if (this.#deps.chat().sessionOf(tabId) !== session || session.phase !== "live" || this.#deps.records.get(tabId)?.runtime !== runtime) return;
		}
		// The pinned generation is read with the same helper the control client later compares it
		// with, so the two readings are the same kind of value.
		let processCreation: string;
		try {
			await this.#deps.stagedHelper();
			processCreation = await queryControlProcessGeneration(pid);
		} catch (error) {
			if (mayReportControlFailure(this.#attemptTarget(tabId), { runtime, pid, client: null })) {
				this.fail(tabId, `the process generation could not be read (${messageOf(error)})`);
			}
			return;
		}
		const record: RecordedControlProcess = {
			pid,
			processCreation,
			slotId: prepared.bootstrap.slotId,
			directory: prepared.bootstrap.directory,
			activity: true,
			work: true,
			subagents: true,
		};
		const recorded = await index.lifecycle.run(tabId, async () => {
			if (this.#deps.records.get(tabId)?.runtime !== runtime) return false;
			await store.setRecord(controlProcessRecordKey(ownerGeneration), record);
			return true;
		});
		if (!recorded) return;
		await this.establish(tabId, ownerGeneration, attempt, {
			directory: record.directory,
			slotId: record.slotId,
			pid,
			processCreation,
			privateKeyPkcs8Pem: prepared.privateKeyPkcs8Pem,
			activity: true,
			work: true,
			subagents: true,
			expectation: { sessionFile: runtime.kind === "terminal" ? null : runtime.sessionFile, cwd: runtime.cwd },
		});
	}

	/**
	 * Re-establish the channel for a host that outlived this extension host.
	 *
	 * Only the previously persisted recipient is used, and the proven key is
	 * supplied only when the recorded process is the one still running: with a
	 * proven key a different candidate is refused by the client as host
	 * replacement, which is exactly the check that keeps a recycled pid out.
	 */
	reconnect(conversation: string, ownerGeneration: string, runtime: SessionHostRuntime): Promise<void> {
		return this.#singleFlight(runtime, () => this.#reconnectAttempt(conversation, ownerGeneration, runtime));
	}

	async #reconnectAttempt(tabId: string, ownerGeneration: string, runtime: SessionHostRuntime): Promise<void> {
		const { store, log } = this.#deps;
		const pid = runtime.pid;
		ownerGeneration = controlOwnerFor(runtime, ownerGeneration);
		// Captured before the secret reads below await, for the same reason as above.
		const attempt: ControlAttemptPlan = { runtime, pid };
		const record = store.record<RecordedControlProcess>(controlProcessRecordKey(ownerGeneration));
		const privateKey = await store.secret(recipientSecretName(ownerGeneration));
		if (record !== undefined && record.pid === pid && record.withheld !== undefined) {
			// This launch never carried the recipient (its launcher cannot take the startup options): there is no
			// channel to find, and saying "never recorded" would misname the cause on every retry.
			this.#deps.diagnostics().notObserved(tabId, "host-control-verified", record.withheld);
			return;
		}
		if (record === undefined || record.pid !== pid || privateKey === undefined) {
			this.#deps.diagnostics().notObserved(
				tabId,
				"host-control-verified",
				"no control recipient was recorded for this host, so the channel was never attempted",
			);
			if (mayReportControlFailure(this.#attemptTarget(tabId), { runtime: attempt.runtime, pid: attempt.pid, client: null })) {
				this.fail(
					tabId,
					"no control recipient was recorded for this host, so host control stays unavailable for it",
				);
			} else {
				log.debug(`tab ${tabId}: a reattach attempt no longer owns this tab; its result was ignored`);
			}
			return;
		}
		// The first use of the helper: a re-adopted host after a reload onto a new build is attached before staging is
		// done, and a proof made without the helper refuses, which a Chat's attempt never retries.
		await this.#deps.stagedHelper();
		await this.establish(tabId, ownerGeneration, attempt, {
			directory: record.directory,
			slotId: record.slotId,
			pid,
			processCreation: record.processCreation,
			privateKeyPkcs8Pem: privateKey,
			activity: record.activity === true,
			work: record.work === true,
			subagents: record.subagents === true,
			expectation: { sessionFile: runtime.kind === "terminal" ? null : runtime.sessionFile, cwd: runtime.cwd },
			provenKey: await store.secret(provenKeySecretName(ownerGeneration)),
		});
	}

	/** The tab facts a fence decision reads, or null when the tab no longer exists. */
	#attemptTarget(tabId: string): { runtime: unknown | null; runtimePid: number | null; controlClient: unknown | null } | null {
		// Read, never create: evaluating a stale completion must not bring a tab back. A
		// held channel that has closed proves nothing, so it counts as no channel: the tab's
		// next attempt must not be blocked by a dead one.
		const state = this.#deps.records.get(tabId);
		if (state === undefined) return null;
		const held = state.control?.client ?? null;
		return {
			runtime: state.runtime ?? null,
			runtimePid: state.runtime?.pid ?? null,
			controlClient: isOpenControlClient(held) ? held : null,
		};
	}

	async establish(
		tabId: string,
		ownerGeneration: string,
		attempt: ControlAttemptPlan,
		input: EstablishControlInput,
	): Promise<void> {
		const { index, window, store, log } = this.#deps;
		const diagnostics = this.#deps.diagnostics();
		const runtime = this.#deps.records.get(tabId)?.runtime;
		const stillCurrent = (): boolean =>
			mayReportControlFailure(this.#attemptTarget(tabId), { runtime: attempt.runtime, pid: attempt.pid, client: null }) &&
			(runtime?.kind !== "terminal" || !runtime.stopping);
		let connected: HostControlVerifiedConnection | null = null;
		try {
			const provenKey = input.provenKey;
			if (provenKey !== undefined) {
				// A key this launch already proved identifies the host without the rendezvous
				// record, which is last-writer-wins per slot and no longer names the original
				// server once a subagent's server (older host builds) overwrote or removed it.
				const published = await readControlRendezvous(input.directory, input.slotId).catch(() => null);
				connected = await HostControlClient.connectWithProvenKey({
					slotId: input.slotId,
					directory: input.directory,
					provenKey,
					expectedPid: input.pid,
					expectedProcessCreationTime: input.processCreation,
					expectation: input.expectation,
					...(published === null ? {} : { preferredPipeName: published.pipeName }),
				});
			}
			if (connected === null) {
				// With a proven key the host already published once, so a missing record is not
				// startup lag: the bounded wait only covers a launch that never connected.
				const rendezvous = await waitForControlRendezvous(input.directory, input.slotId, stillCurrent,
					provenKey !== undefined ? PROVEN_CONTROL_RENDEZVOUS_TIMEOUT_MS
						: runtime?.kind === "terminal" ? NATIVE_CONTROL_RENDEZVOUS_TIMEOUT_MS : CONTROL_RENDEZVOUS_TIMEOUT_MS);
				if (rendezvous === null) {
					// The wait above is an await: the tab may run another process now, or hold a
					// channel a newer attempt established, which this failure must not clear — nor
					// may it leave a verification failure on a tab this attempt no longer owns.
					if (stillCurrent()) {
						const reason = runtime?.kind !== "terminal"
							? "The native host has no compatible control record. Use Reload to refresh a child from an older build."
							: provenKey !== undefined
								? "Host control lost: the running OMP no longer serves a control endpoint this session can verify, so statuses and notifications are off. Reload the session to restore them."
								: "Waiting for the native host to publish its control record; statuses and notifications start when it connects.";
						diagnostics.fail(tabId, "host-control-verified", reason);
						this.fail(tabId, reason);
					} else {
						log.debug(`tab ${tabId}: a control attempt that found no rendezvous no longer owns this tab; nothing was changed`);
					}
					return;
				}
				if (!stillCurrent()) return;
				connected = await HostControlClient.connectVerified({
					rendezvous,
					rendezvousDirectory: input.directory,
					recipientPrivateKeyPkcs8Pem: input.privateKeyPkcs8Pem,
					expectedPid: input.pid,
					expectedProcessCreationTime: input.processCreation,
					expectation: input.expectation,
					...(provenKey === undefined ? {} : { provenKey }),
				});
			}
			if (!stillCurrent()) {
				connected.client.close();
				connected = null;
				return;
			}
			const verified = connected;
			if (verified.rotated) log.info(`tab ${tabId}: the host process (pid ${input.pid}) proved a rotated control key; the new key is pinned`);
			const snapshot = await verified.client.snapshot();
			// The connection awaited above: the tab's runtime may have been replaced (a
			// relaunch) or closed while it was in flight, and a client proved for the *old*
			// process must never be published into its successor's tab — nor over a channel a
			// newer attempt already established.
			await index.lifecycle.run(tabId, async () => {
				const state = this.#deps.records.get(tabId);
				if (
					state === undefined ||
					!mayPublishControlChannel(this.#attemptTarget(tabId), { runtime: attempt.runtime, pid: attempt.pid, client: verified.client })
				) {
					log.warn(`tab ${tabId}: a verified host-control channel was not published: this tab runs a different process now`);
					verified.client.close();
					connected = null;
					return;
				}
				// Persistence shares the stop/relaunch gate: an old completion can neither
				// resurrect a deleted key nor overwrite its successor's proven key.
				await store.setSecret(provenKeySecretName(ownerGeneration), verified.key);
				state.control = { client: verified.client, snapshot, activity: input.activity, work: input.work === true, subagents: input.subagents === true };
				state.controlFailure = null;
				log.info(`tab ${tabId}: host control verified (pid ${input.pid}, instance ${snapshot.host.instanceId})`);
				const sinceCommandMs = this.#deps.timeline?.finish(tabId) ?? null;
				if (sinceCommandMs !== null) log.info(`window timing: new session ${tabId} host control verified ${sinceCommandMs} ms after the command`);
				diagnostics.succeed(tabId, "host-control-verified", {
					detail: `pid ${input.pid} · instance ${snapshot.host.instanceId}`,
				});
				window.published(tabId, verified.client, input.subagents === true && state.runtime?.kind === "chat");
			});
		} catch (error) {
			// A failure is only reported for the attempt that still owns the tab: reporting a
			// late failure would close the channel a newer attempt established, and would
			// leave a verification failure on a tab this attempt no longer owns. A client this
			// attempt connected but never published is closed here instead.
			const outcome = { runtime: attempt.runtime, pid: attempt.pid, client: connected?.client ?? null };
			if (mayReportControlFailure(this.#attemptTarget(tabId), outcome)) {
				diagnostics.fail(tabId, "host-control-verified", describeControlError(error));
				this.reportFailure(tabId, error);
			} else {
				log.debug(`tab ${tabId}: a failed host-control attempt no longer owns this tab; its result was ignored`);
				connected?.client.close();
			}
		}
	}

	/**
	 * Drop every control secret only after a stop this window could prove; the
	 * caller passes a null generation when ownership is unknown, which closes the
	 * channel but leaves the stored material for a later reconciliation.
	 */
	async release(conversation: string, ownerGeneration: string | null): Promise<void> {
		const { store, window, log } = this.#deps;
		const state = this.#deps.records.get(conversation);
		if (state) {
			state.control?.client.close();
			state.control = null;
			state.controlFailure = null;
		}
		if (ownerGeneration !== null) {
			// The released slot is remembered *before* the launch record is dropped: the
			// deletion proof of that launch's store depends on it afterwards.
			const record = store.record<RecordedControlProcess>(controlProcessRecordKey(ownerGeneration));
			if (record !== undefined) await this.#rememberRelease(ownerGeneration, record.slotId);
			await store.deleteSecret(recipientSecretName(ownerGeneration));
			await store.deleteSecret(provenKeySecretName(ownerGeneration));
			await store.setRecord(controlProcessRecordKey(ownerGeneration), undefined);
			log.info(`tab ${conversation}: host-control material released after a confirmed stop`);
		}
	}

	/**
	 * Remember that this window confirmed one launch's process stopped.
	 *
	 * Only a confirmed stop reaches here (the child exited and its broker reported it),
	 * and the entry is keyed by the released slot so a later deletion proof
	 * can never attribute it to another launch's store.
	 */
	async #rememberRelease(ownerGeneration: string, slotId: string): Promise<void> {
		const { store } = this.#deps;
		const key = controlReleaseRecordKey(ownerGeneration);
		const known = store.record<readonly RecordedControlRelease[]>(key) ?? [];
		const next = [
			...known.filter(entry => entry.slotId !== slotId),
			{ slotId, releasedAt: new Date().toISOString() },
		];
		await store.setRecord(key, next.slice(-CONTROL_RELEASE_HISTORY));
	}

	/** Close the conversation's channel and record why host control is unavailable. */
	fail(conversation: string, detail: string): void {
		const state = this.#deps.records.get(conversation);
		if (state) {
			state.control?.client.close();
			state.control = null;
			state.controlFailure = detail;
		}
		this.#deps.log.warn(`tab ${conversation}: host control unavailable — ${detail}`);
	}

	/**
	 * Report why a control attempt or read failed. A host that was reached but did not answer in
	 * time is busy (OMP working through a large input), not gone: its channel is dropped so the next
	 * attempt starts clean, and the log says so, but no failure is recorded, because that text is
	 * shown as a warning above the terminal and calls a busy session unavailable. Every other
	 * failure is recorded as before.
	 */
	reportFailure(conversation: string, error: unknown): void {
		if (!(error instanceof HostControlUnavailableError && error.timedOut)) {
			this.#deps.log.warn(`tab ${conversation}: host control failure detail: ${messageOf(error).slice(0, 300)}`);
			this.fail(conversation, describeControlError(error));
			return;
		}
		const state = this.#deps.records.get(conversation);
		if (state) {
			state.control?.client.close();
			state.control = null;
		}
		this.#deps.log.warn(`tab ${conversation}: host control paused — ${describeControlError(error)}; it is retried`);
	}

	/** Close and forget one record's verified control channel; the failure text is cleared with it. */
	dispose(state: RuntimeRecord): void {
		state.control?.client.close();
		state.control = null;
		state.controlFailure = null;
	}
}

/** Bounded wait for the native side to publish its (non-secret) rendezvous. */
async function waitForControlRendezvous(
	directory: string,
	slotId: string,
	stillCurrent: () => boolean,
	timeoutMs: number,
): Promise<ControlRendezvous | null> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (!stillCurrent()) return null;
		const record = await readControlRendezvous(directory, slotId).catch(() => null);
		if (record !== null) return record;
		if (Date.now() >= deadline) return null;
		await delay(CONTROL_RENDEZVOUS_POLL_MS);
	}
}
