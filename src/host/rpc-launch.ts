/**
 * Start and re-adopt `omp --mode rpc-ui` as a `managed-rpc` child of the detached broker
 * (ADR-0038).
 *
 * {@link rpcOmpLaunchSpec} is the single builder of the command line, so the broker path
 * and the tests cannot drift apart. The claim is already held by the session index and is
 * never touched here. Nothing here reads a chat frame: the returned {@link RpcHandle} is
 * handed to a host-owned `RpcSession`.
 *
 * The answers keep the question the index asks — *can a writer of ours still be alive?* —
 * separate from "did it work": `not-started` means the broker refused before spawning
 * anything; `unconfirmed` means a broker process may exist and could not be reached, or
 * the child's identity could not be read; `running` means a verified handle exists.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { CONTROL_DIR_ENV, CONTROL_SLOT_ENV, LINK_REMINDER_ENV } from "./control-protocol";
import {
	DEFAULT_OMP_PROFILE,
	controlRuntimeFlags,
	resolveOmpBinary,
} from "./native-terminal";
import type { NativeControlBootstrap, OmpBinary, OmpCommand } from "./native-terminal";
import type { PtyBrokerClient } from "./pty-client";
import type { PtyHandle } from "./pty-client";
import type { RpcHandle } from "./rpc-handle";
import { HOST_STOP_TIMEOUT_MS, brokerNativeGenerationReader, decideStop, verifyPinnedBrokerAttachment } from "./rpc-reconcile";
import type { BrokerPin, NativeStopVerdict } from "./rpc-reconcile";
import { readSessionFileHeader } from "./session-index";
import type { RecordedRpcIdentity } from "./session-index";

/** How long a fresh child may take to report its own pid and creation time. */
const CHILD_IDENTITY_TIMEOUT_MS = 5_000;
/** How long a graceful close waits for OMP to finish shutting down. */
const GRACEFUL_STOP_TIMEOUT_MS = 30_000;

/** The exact command line and environment deltas one chat process runs under. */
export interface RpcOmpLaunchSpec {
	readonly file: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly env: Readonly<Record<string, string | null>>;
}

/**
 * The command line of one `omp --mode rpc-ui` process.
 *
 * Order: bun's own flags first (`--define`, `--preload`), then the launcher's prefix
 * arguments (a bun shim's prefix names the entry script, and a flag after it would reach
 * OMP instead of bun), then OMP's arguments, then the host-control module. `--session` pins
 * the exact file of a resume; a new conversation passes no session flag and learns its exact
 * path from `get_state`. `@file` arguments, `--fork`, `--continue` and bare `--resume` are
 * never used.
 *
 * The profile is always explicit: a session whose index scope recorded no named profile
 * gets OMP's verified `--profile default` sentinel, so an `OMP_PROFILE` inherited from this
 * extension host cannot decide the profile of a session that was never scoped to it.
 */
export function rpcOmpLaunchSpec(input: {
	readonly binary: OmpCommand;
	readonly control: NativeControlBootstrap | null;
	readonly cwd: string;
	/** The exact existing file to resume, or `null` for a new conversation. */
	readonly sessionFile: string | null;
	/** Explicit session directory from the index scope, used for a new conversation only. */
	readonly sessionDir: string | null;
	readonly profile: string | null;
	/** The `omp.linkReminder` setting; the Chat prompt module reads it from the environment. */
	readonly linkReminder: boolean;
}): RpcOmpLaunchSpec {
	const env: Record<string, string | null> = { [LINK_REMINDER_ENV]: input.linkReminder ? "1" : "0" };
	if (input.control !== null) {
		env[CONTROL_DIR_ENV] = input.control.directory;
		env[CONTROL_SLOT_ENV] = input.control.slotId;
	}
	const args = [
		...controlRuntimeFlags(input.control),
		...input.binary.prefixArgs,
		"--mode",
		"rpc-ui",
		"--cwd",
		input.cwd,
		"--profile",
		input.profile ?? DEFAULT_OMP_PROFILE,
	];
	if (input.sessionFile !== null) args.push("--session", input.sessionFile);
	else if (input.sessionDir !== null) args.push("--session-dir", input.sessionDir);
	if (input.control !== null) args.push("-e", input.control.modulePath);
	return { file: input.binary.command, args, cwd: input.cwd, env };
}

/** The broker/child identity one handle has observed, in the shape a row records. */
export function recordedRpcIdentityOf(handle: RpcHandle | PtyHandle): RecordedRpcIdentity {
	return {
		slot: handle.slot,
		brokerId: handle.record.brokerId,
		brokerGeneration: handle.record.generation,
		brokerPid: handle.brokerPid,
		brokerCreationTime: handle.record.brokerCreationTime,
		childPid: handle.nativePid,
		childCreationTime: handle.nativeCreationTime,
	};
}

/** Everything the extension keeps for one running rpc host. */
export interface RpcHostRuntime {
	readonly kind: "chat";
	readonly handle: RpcHandle;
	readonly identity: RecordedRpcIdentity;
	/** The working directory the process was started in. */
	readonly cwd: string;
	/** The exact file resumed, or `null` for a new conversation. */
	readonly sessionFile: string | null;
	/** Host-control bootstrap the process was launched with; `null` when disabled or re-adopted. */
	readonly control: NativeControlBootstrap | null;
	/** The resolved installed OMP the process was started from; absent for a re-adopted host. */
	readonly binary: OmpBinary | null;
	/** Something the user should be told about this launch (a working-directory fallback). */
	readonly notice: string | null;
	/** The process id of the chat child. */
	readonly pid: number;
	/** Wall-clock cost of resolving the installed OMP, in ms; absent for a re-adopted host. */
	readonly resolutionMs?: number;
}

export interface RpcLaunchRequest {
	/** Broker slot minted and recorded for this launch before it runs. */
	readonly slot: string;
	/** The row's working directory (a new session runs here; a resume prefers the header's). */
	readonly cwd: string;
	/** Exact existing session file to resume, or `null` for a new conversation. */
	readonly sessionFile: string | null;
	/** OMP profile, or `null` for the default profile. */
	readonly profile: string | null;
	/** Explicit session directory from the index scope; used for a new conversation only. */
	readonly sessionDir: string | null;
	/** Host-control bootstrap, or `null` to launch without the channel. */
	readonly control: NativeControlBootstrap | null;
	/** The `omp.linkReminder` setting when this launch starts; applies to this process for its whole life. */
	readonly linkReminder: boolean;
}

export type RpcLaunchOutcome =
	| { readonly state: "running"; readonly reason: string; readonly runtime: RpcHostRuntime }
	| { readonly state: "not-started" | "unconfirmed"; readonly reason: string; readonly runtime: null };

async function isEnterableDirectory(directory: string): Promise<boolean> {
	try {
		return (await fs.stat(directory)).isDirectory();
	} catch {
		return false;
	}
}

/**
 * The directory a resume runs in.
 *
 * OMP cancels an rpc `switch_session` to another cwd, so the directory cannot be fixed after
 * start: it is the session header's cwd when that directory can be entered, else the row's own
 * folder, and OMP applies its own runtime-only fallback for the mismatch. The second element is
 * the sentence the row shows when the fallback was taken.
 */
export async function resumeWorkingDirectory(
	headerCwd: string | null,
	fallback: string,
): Promise<{ readonly cwd: string; readonly notice: string | null }> {
	if (headerCwd !== null && path.isAbsolute(headerCwd) && (await isEnterableDirectory(headerCwd))) {
		return { cwd: headerCwd, notice: null };
	}
	if (headerCwd === null) return { cwd: fallback, notice: null };
	return {
		cwd: fallback,
		notice: `The session's own working directory (${headerCwd}) cannot be entered; it runs in ${fallback} instead.`,
	};
}

/**
 * Launch one chat process under the extension-owned PTY broker.
 *
 * A resume is refused unless the file exists (`--session <missing path>` silently creates a
 * fresh session at that path). The process's own identity must be readable before the launch
 * is called `running`: without the child's pid and kernel creation time nothing can be
 * compared later, so the launch stays unconfirmed and the claim is kept.
 */
export async function launchRpcHost(request: RpcLaunchRequest, client: PtyBrokerClient): Promise<RpcLaunchOutcome> {
	const resolutionStartedAt = Date.now();
	let binary: OmpBinary;
	try {
		binary = await resolveOmpBinary();
	} catch (error) {
		return { state: "not-started", reason: error instanceof Error ? error.message : String(error), runtime: null };
	}
	const resolutionMs = Date.now() - resolutionStartedAt;

	let cwd = request.cwd;
	let notice: string | null = null;
	if (request.sessionFile !== null) {
		try {
			await fs.access(request.sessionFile);
		} catch {
			return {
				state: "not-started",
				reason: `The session file ${request.sessionFile} does not exist, so it cannot be resumed.`,
				runtime: null,
			};
		}
		const header = await readSessionFileHeader(request.sessionFile);
		const chosen = await resumeWorkingDirectory(header?.cwd ?? null, request.cwd);
		cwd = chosen.cwd;
		notice = chosen.notice;
	} else if (request.sessionDir !== null) {
		try {
			await fs.mkdir(request.sessionDir, { recursive: true });
		} catch (error) {
			return {
				state: "not-started",
				reason: `Could not prepare ${request.sessionDir}: ${error instanceof Error ? error.message : String(error)}`,
				runtime: null,
			};
		}
	}
	if (request.control !== null) {
		try {
			await fs.mkdir(request.control.directory, { recursive: true });
		} catch (error) {
			return {
				state: "not-started",
				reason: `Could not prepare the host-control directory ${request.control.directory}: ${error instanceof Error ? error.message : String(error)}`,
				runtime: null,
			};
		}
	}

	const spec = rpcOmpLaunchSpec({
		binary,
		control: request.control,
		cwd,
		sessionFile: request.sessionFile,
		sessionDir: request.sessionDir,
		profile: request.profile,
		linkReminder: request.linkReminder,
	});
	const launched = await client.launchRpc({
		slot: request.slot,
		kind: "managed-rpc",
		file: spec.file,
		args: spec.args,
		cwd: spec.cwd,
		env: spec.env,
		title: `OMP: ${path.basename(cwd)}`,
	});
	if (launched.handle === null) {
		// Nothing was spawned (`not-started`), or a broker exists and could not be driven: a
		// writer may exist, so only the former lets a claim go.
		return {
			state: launched.state === "not-started" ? "not-started" : "unconfirmed",
			reason: launched.reason,
			runtime: null,
		};
	}
	const handle = launched.handle;
	await handle.awaitChildIdentity(CHILD_IDENTITY_TIMEOUT_MS);
	const identity = recordedRpcIdentityOf(handle);
	if (identity.childPid === null || !Number.isInteger(identity.childPid) || identity.childPid < 1) {
		return {
			state: "unconfirmed",
			reason: `The PTY broker started the host but reported no child process id: ${launched.reason}`,
			runtime: null,
		};
	}
	return {
		state: "running",
		reason: `Chat host launched from ${binary.origin} under the PTY broker.`,
		runtime: {
			kind: "chat",
			handle,
			identity,
			cwd,
			sessionFile: request.sessionFile,
			control: request.control,
			binary,
			notice,
			resolutionMs,
			pid: identity.childPid,
		},
	};
}

export type RpcAttachOutcome =
	| { readonly state: "attached"; readonly reason: string; readonly runtime: RpcHostRuntime }
	| { readonly state: "unavailable"; readonly reason: string; readonly runtime: null };

/**
 * Re-adopt a chat process that outlived this extension host, through its broker.
 *
 * Nothing is spawned and no claim is touched: the pinned slot's record names the exact broker
 * generation and child, the child's kernel creation time must still be the one the broker
 * captured, and the pin the reconciler proved must match field by field. A broker that cannot
 * be reached or a target that changed is `unavailable` — never a reason to start a second
 * writer, and never a reason to fall back to another transport. Every refusal closes the
 * connection it opened.
 */
export async function attachRpcHost(input: {
	readonly pin: BrokerPin;
	readonly cwd: string;
	readonly sessionFile: string | null;
	readonly client: PtyBrokerClient;
}): Promise<RpcAttachOutcome> {
	const attached = await input.client.attachRpc(input.pin.slot);
	if (attached.handle === null) return { state: "unavailable", reason: attached.reason, runtime: null };
	const handle = attached.handle;
	const refuse = (reason: string): RpcAttachOutcome => {
		handle.disconnect();
		return { state: "unavailable", reason, runtime: null };
	};
	try {
		let reader;
		try {
			reader = await brokerNativeGenerationReader(input.client);
		} catch {
			return refuse("The PTY broker runtime could not be verified, so the pinned child's identity cannot be re-proven.");
		}
		if (reader === null) {
			return refuse("The PTY broker runtime has no process probe, so the pinned child's identity cannot be re-proven.");
		}
		const proved = await verifyPinnedBrokerAttachment({ handle, pin: input.pin, readNativeGeneration: reader });
		if (!proved.ok) return refuse(proved.reason);
	} catch {
		return refuse("The pinned broker target could not be re-proven, so no host was adopted.");
	}
	return {
		state: "attached",
		reason: `Re-adopted the PTY broker generation ${handle.record.generation} for pid ${handle.nativePid}${
			handle.buildMatches ? "" : " (started by another build of this extension)"
		}.`,
		runtime: {
			kind: "chat",
			handle,
			identity: recordedRpcIdentityOf(handle),
			cwd: input.cwd,
			sessionFile: input.sessionFile,
			control: null,
			binary: null,
			notice: null,
			pid: input.pin.nativePid,
		},
	};
}

/**
 * Stop the chat process one runtime owns through the broker that owns it.
 *
 * `graceful` asks OMP to finish and waits (the close path: a turn in flight is interrupted by
 * the child's own shutdown); `force` is the explicit Stop of a stuck host. The verdict says
 * only whether the exact proven child is gone — never a claim about anything else.
 */
export async function stopRpcHost(runtime: RpcHostRuntime, mode: "graceful" | "force"): Promise<NativeStopVerdict> {
	try {
		const result = await runtime.handle.stop({
			mode,
			timeoutMs: mode === "graceful" ? GRACEFUL_STOP_TIMEOUT_MS : HOST_STOP_TIMEOUT_MS,
		});
		return decideStop({
			pidGone: result.pidGone,
			treeEmpty: result.verified && result.pidGone && result.tree === "empty",
			nativePid: result.nativePid,
			remaining: result.remainingPids,
			brokerDetail: result.detail,
		});
	} catch (error) {
		return {
			writerGone: false,
			treeEmpty: false,
			detail: "The session could not be confirmed stopped. Try Stop again; see OMP Desk output for details.",
			diagnosticDetail: `The stop request for pid ${runtime.pid} could not be confirmed: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

/**
 * Let a broker go once the child it hosted is confirmed gone.
 *
 * A stopped child leaves its broker alive with nobody to serve: this window is still connected
 * to it, which keeps the broker's retention timer from ever starting, and a process tree that
 * could not be proven empty exempts the broker from retention altogether — so without this
 * every closed session would leave one broker process behind for good. The broker itself
 * refuses unless it proved this exact child gone (`requireStopped`), so a running writer can
 * never be made unfindable by it. Its own record is kept as recovery metadata, and this
 * window's connection is dropped whatever the answer.
 *
 * Returns whether the broker acknowledged the shutdown; `detail` is bounded text for the log.
 */
export async function retireStoppedRpcBroker(runtime: { readonly handle: RpcHandle | PtyHandle; readonly identity: RecordedRpcIdentity }): Promise<{ readonly retired: boolean; readonly detail: string }> {
	try {
		await runtime.handle.shutdown();
		return { retired: true, detail: `the broker of slot ${runtime.identity.slot} acknowledged its shutdown` };
	} catch (error) {
		return {
			retired: false,
			detail: `the broker of slot ${runtime.identity.slot} was not shut down: ${error instanceof Error ? error.message : String(error)}`,
		};
	} finally {
		runtime.handle.disconnect();
	}
}
