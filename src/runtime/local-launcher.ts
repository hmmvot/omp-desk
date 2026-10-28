/**
 * Launch and attach for the in-process runtime (ADR-0066): start one OMP host through the
 * extension-owned broker, or re-adopt one that outlived the extension host, and hand it to its
 * conversation.
 *
 * The window is reached only through the `LauncherWindow` hooks and the injected ports below (host
 * control, the native watch's early check and the exit operations are the runtime's own). The
 * order of one launch is part of the contract and is the order the window always had:
 *
 *   refusal (installed package changed) → precheck → stage entries → prepare host control → open diagnostics → broker client →
 *   `retireDocument` → reserve the broker slot → launch → `adopt` → watch the broker →
 *   `prepareView` → `startLive` / native `attach()` → `attached` → control connection →
 *   run-intent write
 *
 * `adopt` runs before the broker watch starts: `watchBrokerLoss` stops for good at its first look
 * when `isCurrent` is false, so a later write would silently disable loss detection when the attach
 * is slower than one poll.
 *
 * Every hook runs under the lifecycle gate the caller of `open`, `restore` or `reattach` holds: it
 * must not call a gated operation for the same conversation and must not wait for the user.
 */
import { setTimeout as delay } from "node:timers/promises";
import type { Logger } from "../shared/logger.ts";
import type { InputReclaim } from "../protocol/rpc.ts";
import { awaitWriterGone, watchBrokerLoss } from "../host/broker-loss.ts";
import { createHostSlotId } from "../host/broker-slots.ts";
import type { BrokerSlotStore } from "../host/broker-slots.ts";
import type { ChatRuntime } from "../host/chat-runtime.ts";
import { createControlRecipient } from "../host/control-client.ts";
import { CONTROL_RECIPIENT_DEFINE, createControlSlotId } from "../host/control-protocol.ts";
import type { DiagnosticsRecorder } from "../host/diagnostics.ts";
import type { LaunchTimeline } from "../host/launch-timeline.ts";
import { brokerAndRootGone } from "../host/native-session.ts";
import type { attachNativeHost, launchNativeHost, NativeAttachOutcome, SessionHostRuntime } from "../host/native-session.ts";
import { isPtyProcessAlive } from "../host/pty-identity.ts";
import type { PtyBrokerClient } from "../host/pty-client.ts";
import type { PendingForks } from "../host/pending-forks.ts";
import type { attachRpcHost, launchRpcHost, RpcAttachOutcome } from "../host/rpc-launch.ts";
import { readSessionFileHeader } from "../host/session-files.ts";
import type {
	OmpHostAttachRequest,
	OmpHostAttachResult,
	OmpHostLaunchRequest,
	OmpHostLaunchResult,
	OmpHostLauncher,
	SessionIndex,
} from "../host/session-index.ts";
import type { OmpHostHandle } from "../host/session-model.ts";
import type { StagedRuntimeEntries } from "./runtime-entries.ts";
import type { LocalHostControl } from "./local-control.ts";
import type { LocalExitOperations } from "./local-exit.ts";
import type { LocalNativeWatch } from "./local-native-watch.ts";
import type { PreparedHostControl } from "./local-control.ts";

/** What an adopting attach waits for a previous frontend's input claim to clear (a handover): about 10 tries over 2 s. */
export const ADOPTED_INPUT_RECLAIM: InputReclaim = { attempts: 10, intervalMs: 200 };

/** What the runtime asks of its window; contractual and in-process only (design §2.5). */
export interface LauncherWindow {
	/**
	 * A relaunch needs a fresh document capability: retire the old one and remount the same editor.
	 * Runs before the broker slot is reserved. Returns the editor the launch is recorded for.
	 */
	retireDocument(conversation: string): Promise<string | null>;
	/** Write the window's copy of the runtime, clear the ended notice and the control picker. Runs before the broker watch starts. */
	adopt(conversation: string, runtime: SessionHostRuntime): void;
	/** Whether the window's copy of the conversation's runtime is this very runtime. */
	isCurrent(conversation: string, runtime: SessionHostRuntime): boolean;
	/** Persist the editor mode and, for a native terminal, create the pipeline and release the chat. Runs before the stream is activated. */
	prepareView(conversation: string, runtime: SessionHostRuntime): Promise<void>;
	/** Attach routes (chat) or the native watch and the guest context (terminal). Idempotent. */
	attached(conversation: string, runtime: SessionHostRuntime): void;
	/** A notice for the user; never awaited, so an unanswered notification cannot hold the gate. */
	notice(level: "warning" | "error", text: string): void;
}

export interface LocalLauncherDeps {
	readonly index: SessionIndex;
	readonly window: LauncherWindow;
	/** The shared chat runtime: the live conversation of a chat host. */
	readonly chat: Pick<ChatRuntime, "startLive">;
	readonly diagnostics: DiagnosticsRecorder;
	readonly entries: () => Promise<StagedRuntimeEntries>;
	/**
	 * Why no host may be started now, or `null`: the installed package no longer holds the bytes this window loaded, so a broker
	 * or child started from it would not speak this window's protocol and its editor shows no Chat. Asked on every launch, not
	 * only when the runtime entries are staged (the staged copies are cached for the window's life, so that check alone never
	 * fires in a window that staged them before the reinstall). An attach starts nothing and is never refused by it.
	 */
	readonly launchRefusal: () => string | null;
	/** The processes themselves: spawn through the broker, or re-prove and re-adopt one that is already running. */
	readonly hosts: {
		readonly launchRpc: typeof launchRpcHost;
		readonly launchNative: typeof launchNativeHost;
		readonly attachRpc: typeof attachRpcHost;
		readonly attachNative: typeof attachNativeHost;
	};
	/** The durable broker slot table, `undefined` before activation created it. */
	readonly brokerSlots: BrokerSlotStore | undefined;
	/** The client a terminal starts its broker through: ready after the full runtime proof (the console-child proof a terminal needs). */
	readonly brokerClient: () => Promise<PtyBrokerClient | null>;
	/** The client a Chat starts its broker through: it does not wait for the full runtime proof, which the client gates itself on the path that needs it (see `PtyReadinessGate.chatLaunchClient`). */
	readonly chatBrokerClient: () => Promise<PtyBrokerClient | null>;
	readonly attachBrokerClient: () => Promise<PtyBrokerClient | null>;
	/** Why the broker is unavailable, when it is. */
	readonly brokerUnavailableReason: () => string | null | undefined;
	/** One watch per runtime; starting a new one replaces the old. */
	readonly brokerWatches: WeakMap<SessionHostRuntime, () => void>;
	readonly linkReminder: () => boolean;
	readonly toolIntent: () => boolean;
	readonly htmlPages: () => boolean;
	/** Which drafts are forks: the first launch of a fileless draft passes `--fork <source>`; a launch of a materialized row, or a native one, drops the source. */
	readonly forks: Pick<PendingForks, "peek" | "forget">;
	readonly control: Pick<LocalHostControl, "connect" | "reconnect" | "fail" | "storeRecipient" | "directory" | "withhold">;
	/** The early check of a launch: does an authenticated native process of this window already serve the file. */
	readonly native: Pick<LocalNativeWatch, "servesFile">;
	/** What follows a broker that was ended from outside. */
	readonly exit: Pick<LocalExitOperations, "brokerLost">;
	readonly diagnosticsLabel: (cwd: string) => string;
	/** Where an explicitly started launch spent its time (New Session, Resume, Open); absent for a window that reports none. A launch that began no run adds nothing. */
	readonly timeline?: LaunchTimeline;
	readonly log: Logger;
}

/**
 * Prove that a broker that no longer exists took its OMP (or shell) root with it, waiting a bounded
 * while for the root to follow (a Kill ends the broker's tree first and then the recorded root). Only
 * both recorded creation times naming gone processes is proof (`src/host/broker-loss.ts`); a broker's
 * absence alone says nothing about the writer (ADR-0029).
 */
export async function brokerLossProven(
	attachBrokerClient: () => Promise<PtyBrokerClient | null>,
	isCurrent: () => boolean,
	broker: { readonly pid: number; readonly creationTime: string | null },
	root: { readonly pid: number; readonly creationTime: string | null },
): Promise<boolean> {
	const client = await attachBrokerClient();
	if (client === null) return false;
	return awaitWriterGone({
		prove: () => brokerAndRootGone(client, broker, root),
		rootAlive: () => isPtyProcessAlive(root.pid),
		isCurrent,
		pause: ms => delay(ms),
	});
}

export function hostHandle(runtime: SessionHostRuntime, sessionId: string | null): OmpHostHandle {
	return { pid: runtime.pid, sessionId, rpc: runtime.identity, transport: runtime.kind === "terminal" ? "native" : "rpc" };
}

export class LocalLauncher implements OmpHostLauncher {
	readonly #deps: LocalLauncherDeps;

	constructor(deps: LocalLauncherDeps) {
		this.#deps = deps;
	}

	/**
	 * Notice that the broker of a runtime this window drives was ended from outside (Kill in Sessions,
	 * Task Manager, a crash). Nothing says so over the connection, so the window asks whether the broker
	 * process still exists (`src/host/broker-loss.ts`). Its absence is only a trigger: nothing is
	 * published until the broker's and the OMP root's recorded creation times both name gone processes.
	 * What follows (ending the session, or telling the user it could not be confirmed ended) is the
	 * exit operations', through `brokerLost`.
	 */
	#watchBroker(tabId: string, runtime: SessionHostRuntime): void {
		const { brokerWatches, window, log } = this.#deps;
		brokerWatches.get(runtime)?.();
		const isCurrent = (): boolean => window.isCurrent(tabId, runtime);
		brokerWatches.set(runtime, watchBrokerLoss({
			brokerPid: runtime.handle.brokerPid,
			isCurrent,
			onLost: async () => {
				log.warn(`tab ${tabId}: the broker process ${runtime.handle.brokerPid} no longer exists; checking that its OMP process (pid ${runtime.pid}) is gone too`);
				const proven = await brokerLossProven(
					this.#deps.attachBrokerClient,
					isCurrent,
					{ pid: runtime.handle.brokerPid, creationTime: runtime.handle.record.brokerCreationTime },
					{ pid: runtime.pid, creationTime: runtime.identity.childCreationTime },
				);
				if (!isCurrent()) return;
				await this.#deps.exit.brokerLost(tabId, runtime, proven);
			},
		}));
	}

	/**
	 * Hand one running host to its host-owned conversation.
	 *
	 * The conversation is the host's, not a panel's: it is attached whether or not an editor is
	 * open, reads the session file's tail from disk before the process is ready (the first
	 * paint), and folds the process's own frames afterwards. Every editor showing the tab is
	 * pointed at it, so a panel that opened first receives the conversation the moment it exists.
	 * `reclaimInput` is given only by the attach of a surviving host (a reload, an adopted or handed-over session): the
	 * conversation's first attach then repeats an input claim the broker refused, bounded and never as a takeover.
	 */
	async startConversation(
		tabId: string,
		runtime: SessionHostRuntime,
		sessionFile: string | null,
		replayFromStart: boolean,
		reclaimInput?: InputReclaim,
	): Promise<void> {
		const { window, index, chat, timeline } = this.#deps;
		window.adopt(tabId, runtime);
		this.#watchBroker(tabId, runtime);
		// The selected view can differ from a surviving writer we just reattached: the window
		// persists what actually runs, not the provisional selection stamped while its editor was
		// being created, so restoration does not turn every such tab into the profile default.
		await window.prepareView(tabId, runtime);
		if (runtime.kind === "terminal") {
			// Broker authentication is not its output subscription. Watch first, then
			// activate the native stream before publishing this frontend as available.
			await runtime.handle.attach();
			window.attached(tabId, runtime);
			return;
		}
		const entry = index.get(tabId);
		chat.startLive(tabId, {
			channel: runtime.handle,
			sessionFile,
			...(replayFromStart && entry?.host?.sessionId != null ? { expectedProviderSessionId: entry.host.sessionId } : {}),
			cwd: runtime.cwd,
			title: entry?.title ?? null,
			// A re-adopted child replays what its broker buffered since the beginning; a fresh one
			// has nothing to replay.
			...(replayFromStart ? { initialSeq: 0 } : {}),
			...(reclaimInput === undefined ? {} : { reclaimInput }),
			onReady: () => timeline?.mark(tabId, "omp ready"),
		});
		window.attached(tabId, runtime);
	}

	/**
	 * Re-adopt a host that outlived this extension host.
	 *
	 * The index calls this only after its own re-check of the recorded host, and the verdict it
	 * acted on already required the exact broker generation, child and creation time. This
	 * re-proves exactly that pinned target through its broker slot (and nothing else if that
	 * fails): nothing is spawned, no claim is touched, and a target that cannot be proven is
	 * never replaced by another transport.
	 */
	async attach(request: OmpHostAttachRequest): Promise<OmpHostAttachResult> {
		const { diagnostics, log } = this.#deps;
		const attachedAt = Date.now();
		diagnostics.beginSubject(request.tabId, {
			label: this.#deps.diagnosticsLabel(request.cwd),
			kind: "session",
			cwd: request.cwd,
			sessionFile: request.sessionFile,
			startedAt: attachedAt,
		});
		diagnostics.notObserved(request.tabId, "resolution", "this host was not launched by this window");
		diagnostics.begin(request.tabId, "broker-launch", {
			provenance:
				"extension host: this window's attachRpcHost() of an already-running host — the launch happened in an earlier extension-host generation, so it is not measured here",
		});
		diagnostics.begin(request.tabId, "first-paint");
		diagnostics.begin(request.tabId, "chat-live");
		diagnostics.begin(request.tabId, "host-control-verified", {
			provenance:
				"extension host: from this window's attach of an already-running host to connectVerified() completing with the stored key",
		});
		diagnostics.note(request.tabId, `attaching the host recorded as pid ${request.recordedHost.pid ?? "unknown"}`);
		const failAll = (reason: string): void => {
			diagnostics.fail(request.tabId, "broker-launch", reason);
			diagnostics.notObserved(request.tabId, "first-paint", "the attach produced no conversation");
			diagnostics.notObserved(request.tabId, "chat-live", "the attach produced no conversation");
			diagnostics.notObserved(request.tabId, "host-control-verified", "the attach produced no runtime");
		};
		// The sub-steps the index reports beside its own measurements of this call (diagnostic only).
		const timings: Record<string, number> = {};
		let lapAt = Date.now();
		const lap = (step: string): void => {
			const now = Date.now();
			timings[step] = now - lapAt;
			lapAt = now;
		};
		const client = await this.#deps.attachBrokerClient();
		lap("client");
		if (client === null) {
			failAll("the PTY broker is not available in this window");
			return { state: "unavailable", reason: "The PTY broker is not available in this window.", timings };
		}
		let outcome: RpcAttachOutcome | NativeAttachOutcome;
		try {
			outcome = await (request.recordedHost.transport === "native" ? this.#deps.hosts.attachNative : this.#deps.hosts.attachRpc)({
				pin: request.pin,
				cwd: request.cwd,
				sessionFile: request.sessionFile,
				client,
			});
		} catch (error) {
			lap("connect");
			failAll(messageOf(error));
			log.warn(`tab ${request.tabId}: attach failed — ${messageOf(error)}`);
			return { state: "unavailable", reason: `Re-adopting the running host failed: ${messageOf(error)}`, timings };
		}
		lap("connect");
		// The attach's own account of where its time went replaces the wall-clock total of the call, and says
		// how each identity was established ("trusted": the broker's statement was believed; "probe": a kernel reading).
		if (outcome.state === "attached" && outcome.timings !== undefined) {
			const t = outcome.timings;
			// `connect (kept)`: the attach took the connection the restore pass's reconcile kept, so no dial is in it.
			if (t.connection === "kept") delete timings.connect;
			timings[t.connection === "kept" ? "connect (kept)" : "connect"] = t.connectMs;
			for (const [name, ms] of Object.entries(t.parts ?? {})) timings[`link ${name}`] = ms;
			timings[`broker ${t.brokerIdentity}`] = t.brokerIdentityMs;
			timings[`child ${t.childIdentity}`] = t.childIdentityMs;
		}
		const runtime = outcome.runtime;
		if (runtime === null) {
			failAll(outcome.reason);
			log.warn(`tab ${request.tabId}: attach unavailable — ${outcome.reason}`);
			return { state: "unavailable", reason: outcome.reason, timings };
		}
		diagnostics.succeed(request.tabId, "broker-launch", { detail: `pid ${runtime.pid} · ${outcome.reason}` });
		await this.startConversation(request.tabId, runtime, request.sessionFile, true, ADOPTED_INPUT_RECLAIM);
		lap("conversation");
		// The run intent is not recorded here: the index records it with the host it adopts, in the one write that follows this return.
		log.info(`tab ${request.tabId}: attached — ${outcome.reason}`);
		void this.#deps.control.reconnect(request.tabId, request.ownerGeneration, runtime);
		// The host that is attached is a process that already runs under the provider id this index recorded for it, which is not
		// the row's file id once a Chat clear rotated it (ADR-0059). Handing the row's id back would overwrite the recorded one, and
		// the next reload would expect an id the process no longer reports.
		return { state: "attached", host: hostHandle(runtime, request.recordedHost.sessionId ?? request.sessionId), timings };
	}

	async launch(request: OmpHostLaunchRequest): Promise<OmpHostLaunchResult> {
		const { diagnostics, window, index, log, timeline } = this.#deps;
		// Before anything else, and before the run is measured: a window whose installed package changed under it starts nothing.
		const refusal = this.#deps.launchRefusal();
		if (refusal !== null) {
			timeline?.discard(request.tabId, "launch refused");
			return { state: "not-started", reason: refusal };
		}
		const launchKind = timeline?.reached(request.tabId) ?? null;
		if (launchKind !== null && timeline !== undefined) {
			timeline.lap(request.tabId, "admission");
			log.debug(`window timing: ${launchKind} ${request.tabId} launch started ${timeline.summary(request.tabId)?.totalMs ?? 0} ms after the command`);
		}
		// Fresh authenticated current-file readback protects against an own native
		// /resume hidden by a stale catalog row. Failure remains explicitly best effort.
		if (request.sessionFile !== null && await this.#deps.native.servesFile(request.sessionFile)) {
			return { state: "not-started", reason: "An authenticated native OMP process in this window currently serves this exact file. No second writer was launched." };
		}
		// The native host-control module and the pipe helper run from a verified copy staged
		// outside the installed extension folder, so a reinstall can rename that folder while the
		// session runs. Staged before the recipient is generated, so a failure here is reported
		// as such and no half-prepared launch leaves a key behind.
		let entries: StagedRuntimeEntries;
		try {
			entries = await this.#deps.entries();
		} catch (error) {
			return {
				state: "not-started",
				reason: `The extension's runtime entries could not be staged outside the installed folder: ${messageOf(error)}`,
			};
		}
		timeline?.lap(request.tabId, "stage");
		// The recipient is generated and its private half stored before the process exists, so a
		// launch can never outrun the key that decrypts its rendezvous.
		const slot = createHostSlotId();
		const credentialOwner = request.transport === "native" ? `native.${slot}` : request.ownerGeneration;
		const control = await this.#prepareHostControl(request.tabId, credentialOwner, entries.hostControl.path, entries.runtimeProbe.path);
		timeline?.lap(request.tabId, "host control keys");
		// One mark per launch: the stages below are all measured from it, so the report reads as
		// one startup timeline (launcher → broker → first paint → live → host control).
		diagnostics.beginSubject(request.tabId, {
			label: this.#deps.diagnosticsLabel(request.cwd),
			kind: "session",
			cwd: request.cwd,
			sessionFile: request.sessionFile,
		});
		diagnostics.begin(request.tabId, "broker-launch");
		diagnostics.begin(request.tabId, "first-paint");
		diagnostics.begin(request.tabId, "chat-live");
		diagnostics.begin(request.tabId, "host-control-verified");
		const notStarted = (reason: string): OmpHostLaunchResult => {
			timeline?.discard(request.tabId, "not started");
			diagnostics.fail(request.tabId, "broker-launch", reason);
			diagnostics.notObserved(request.tabId, "resolution", "this launch ended before the launcher reported a resolution measurement");
			diagnostics.notObserved(request.tabId, "first-paint", "no host was started");
			diagnostics.notObserved(request.tabId, "chat-live", "no host was started");
			diagnostics.notObserved(request.tabId, "host-control-verified", "no host was started");
			return { state: "not-started", reason };
		};
		// One writer, started by the extension-owned broker (ADR-0024/0038).
		// A terminal's launch waits for the full runtime proof here, and that wait shows in the next lap. A Chat does not: the
		// client gates every start by the proof of the runtime it starts on (a Chat on Bun by its own pipe-only proof, which is
		// the broker's `runtime check` phase), so this lap is a few milliseconds for it.
		const client = await (request.transport === "native" ? this.#deps.brokerClient() : this.#deps.chatBrokerClient());
		timeline?.lap(request.tabId, "runtime proof");
		if (client === null) {
			return notStarted(
				"The extension-owned PTY broker is not available in this build, so no OMP host was started. " +
					(this.#deps.brokerUnavailableReason() ?? "The staged broker runtime could not be verified."),
			);
		}
		// A document's native binding is immutable. Resume/Reload replaces the child, so
		// retire the old capability and remount this same editor with a fresh incarnation.
		const launchEditorId = await window.retireDocument(request.tabId);
		timeline?.lap(request.tabId, "editor document");
		// The broker slot is minted once per host and never derived from the conversation. A new
		// launch always mints a new slot: a recorded slot may still hold a retained record whose
		// process tree could not be proven empty, and reusing it would replay this launch into that
		// retained slot instead of giving the new writer its own identity.
		// Reserved before anything is started: a broker this window could not record is a process
		// no restart could find again, so a full table refuses *before* a launch.
		const reserved = await this.#deps.brokerSlots?.record({ slot, conversation: request.tabId, editor: launchEditorId });
		if (reserved !== undefined && !reserved.ok) return notStarted(reserved.reason);
		timeline?.lap(request.tabId, "broker slot");
		const spawnedAt = Date.now();
		// A fileless draft opened as a fork starts with OMP's own `--fork`, and keeps its source until the row has a file (a fork
		// process that dies first is retried from the same source). A resume names its exact file and a native launch has no `--fork`:
		// both end the fork.
		if (request.sessionFile !== null || request.transport === "native") this.#deps.forks.forget(request.tabId);
		const forkFrom = request.sessionFile === null && request.transport !== "native" ? this.#deps.forks.peek(request.tabId) : null;
		const base = {
			slot,
			cwd: request.cwd,
			sessionFile: request.sessionFile,
			profile: request.scope.profile,
			sessionDir: request.scope.sessionDir,
			control: control === null ? null : control.bootstrap,
			linkReminder: this.#deps.linkReminder(),
			toolIntent: this.#deps.toolIntent(),
			htmlPages: this.#deps.htmlPages(),
		};
		const outcome = request.transport === "native"
			? await this.#deps.hosts.launchNative(base, client)
			: await this.#deps.hosts.launchRpc({ ...base, forkFrom }, client);
		const timings: Record<string, number> = { spawn: Date.now() - spawnedAt };
		if ("timings" in outcome) for (const [phase, ms] of Object.entries(outcome.timings)) timeline?.add(request.tabId, phase, ms);
		const runtime = outcome.runtime;
		if (runtime === null) {
			timeline?.discard(request.tabId, `${outcome.state} at the broker launch`);
			// Nothing this window recorded can be a writer: release the reservation so the slot is
			// available again. An unconfirmed launch keeps it, because a broker may exist.
			if (outcome.state === "not-started") await this.#deps.brokerSlots?.forget(slot).catch(() => undefined);
			log.error(`tab ${request.tabId}: ${outcome.state} — ${outcome.reason}`);
			if (outcome.state === "not-started") return notStarted(outcome.reason);
			diagnostics.fail(request.tabId, "broker-launch", outcome.reason);
			diagnostics.notObserved(request.tabId, "resolution", "this launch ended before the launcher reported a resolution measurement");
			diagnostics.notObserved(request.tabId, "first-paint", "the launch produced no confirmed host");
			diagnostics.notObserved(request.tabId, "chat-live", "the launch produced no confirmed host");
			diagnostics.notObserved(request.tabId, "host-control-verified", "the launch produced no confirmed host");
			return { state: "unconfirmed", reason: outcome.reason };
		}
		timeline?.mark(request.tabId, "omp spawned");
		// The launcher's own measurement of its resolution, not a re-measurement here.
		if (runtime.resolutionMs === undefined || runtime.binary === null) {
			diagnostics.notObserved(request.tabId, "resolution", "the launcher reported no resolution measurement for this host");
		} else {
			diagnostics.observe(request.tabId, "resolution", {
				durationMs: runtime.resolutionMs,
				detail: `${runtime.binary.command} ${runtime.binary.prefixArgs.join(" ")}`.trim(),
			});
		}
		diagnostics.succeed(request.tabId, "broker-launch", { detail: `pid ${runtime.pid} · slot ${runtime.identity.slot}` });
		const conversationAt = Date.now();
		if (runtime.kind === "chat") timeline?.expectLive(request.tabId);
		await this.startConversation(request.tabId, runtime, request.sessionFile, false);
		timeline?.lap(request.tabId, "conversation");
		timings.conversation = Date.now() - conversationAt;
		log.info(`tab ${request.tabId}: ${outcome.state} — ${outcome.reason}`);
		if (runtime.notice !== null) window.notice("warning", runtime.notice);
		// The native extension receives session_start before rpc-ui handles get_state.
		// Its exact session identity is checked only after that positive startup barrier.
		if (control !== null && runtime.control !== null) {
			void this.#deps.control.connect(request.tabId, request.ownerGeneration, runtime, control);
		} else if (control !== null) {
			// The launcher cannot carry the recipient (ADR-0075): remember that, so nothing looks for a channel later.
			void this.#deps.control.withhold(request.tabId, request.ownerGeneration, runtime, control, "this OMP launcher did not carry the startup options host control needs (it does not accept them, or that could not be checked), so none were passed (see the launch notice)");
		} else {
			diagnostics.notObserved(
				request.tabId,
				"host-control-verified",
				"this launch had no host-control bootstrap: the recipient could not be prepared before the process started",
			);
		}
		// A verified launch is a durable "this should be running": the row is running again after
		// a reload instead of being read as a deliberate stop.
		const intentAt = Date.now();
		await index.setRunIntent(request.tabId, "running");
		timings.intent = Date.now() - intentAt;
		timeline?.lap(request.tabId, "run intent");
		// Without host control nothing verifies it, so the run ends here (a Chat's is reported once it is live) and cannot be taken by a later launch of the tab.
		if (runtime.control === null) timeline?.finishWithoutControl(request.tabId);
		const sessionId = runtime.kind === "chat" && request.sessionFile !== null
			? (await readSessionFileHeader(request.sessionFile))?.sessionId ?? request.sessionId : request.sessionId;
		return { state: "running", host: hostHandle(runtime, sessionId), timings };
	}

	/**
	 * Generate this launch's recipient and persist its private half *before* the
	 * process exists, so a launch can never outrun the key that decrypts its
	 * rendezvous. A failure here is recorded as a visible unavailability; the
	 * session still starts without the channel.
	 *
	 * `modulePath` is the verified copy staged outside the installed extension
	 * folder: the native process preloads that copy, so a reinstall never has to wait
	 * for this session to end.
	 */
	async #prepareHostControl(tabId: string, ownerGeneration: string, modulePath: string, probeModulePath: string): Promise<PreparedHostControl | null> {
		try {
			const recipient = await createControlRecipient();
			await this.#deps.control.storeRecipient(ownerGeneration, recipient.privateKeyPkcs8Pem);
			return {
				bootstrap: {
					defineName: CONTROL_RECIPIENT_DEFINE,
					publicRecipient: recipient.publicKeySpkiBase64url,
					modulePath,
					probeModulePath,
					directory: this.#deps.control.directory(),
					slotId: createControlSlotId(),
				},
				privateKeyPkcs8Pem: recipient.privateKeyPkcs8Pem,
			};
		} catch {
			this.#deps.control.fail(tabId, "the host-control recipient could not be prepared");
			return null;
		}
	}
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
