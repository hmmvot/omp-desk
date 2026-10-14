import * as fs from "node:fs/promises";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CONTROL_DIR_ENV, CONTROL_SLOT_ENV } from "./control-protocol";
import type { ControlNativeState, ControlNativeTarget } from "./control-protocol";
import { planControlLaunch } from "./launch-capability";
import { DEFAULT_OMP_PROFILE, resolveOmpBinary } from "./native-terminal";
import type { OmpCommand } from "./native-terminal";
import type { RuntimeFlagPlan } from "./runtime-flags";
import type { PtyBrokerClient, PtyHandle } from "./pty-client";
import { isPtyProcessAlive } from "./pty-identity";
import { recordedRpcIdentityOf, resumeWorkingDirectory } from "./rpc-launch";
import type { AttachTimings, RpcHostRuntime, RpcLaunchRequest, RpcOmpLaunchSpec } from "./rpc-launch";
import { brokerNativeGenerationReader, concurrentPinProof, lazyNativeGenerationReader } from "./rpc-reconcile";
import type { BrokerPin, NativeGenerationReader, NativeStopVerdict } from "./rpc-reconcile";
import { readSessionFileHeader } from "./session-files";

export interface NativeHostRuntime extends Omit<RpcHostRuntime, "kind" | "handle"> {
	readonly kind: "terminal";
	readonly handle: PtyHandle;
	/** Readback may change during autonomous native /resume, /new or rollback. */
	observed: ControlNativeState | null;
	/** An accepted native shutdown cannot be withdrawn. */
	stopping: boolean;
	/** Positive broker observations after explicit force; never inferred from tree-unknown. */
	observedSurvivors: readonly number[];
}

export type SessionHostRuntime = RpcHostRuntime | NativeHostRuntime;

/** What one runtime reports about the session it runs, read under the tab's gate before a stop, a switch or a deletion acts on it. */
export interface SessionTransitionFacts {
	readonly file: string | null;
	readonly sessionId: string | null;
	readonly epoch: string;
	readonly settled: boolean;
	readonly hasContent: boolean | null;
	readonly nativeTarget: ControlNativeTarget | null;
}

export type NativeLaunchOutcome =
	| { readonly state: "running"; readonly reason: string; readonly runtime: NativeHostRuntime }
	| { readonly state: "not-started" | "unconfirmed"; readonly reason: string; readonly runtime: null };
export type NativeAttachOutcome =
	| { readonly state: "attached"; readonly reason: string; readonly runtime: NativeHostRuntime; readonly timings?: AttachTimings }
	| { readonly state: "unavailable"; readonly reason: string; readonly runtime: null };

/**
 * The command line of one native `omp` terminal. Without host control (`control` null, or a launcher that cannot
 * take Bun's startup flags: `runtime` empty) the host-control module is not loaded at all.
 */
export function nativeOmpLaunchSpec(input: Omit<RpcLaunchRequest, "slot"> & { readonly binary: OmpCommand; readonly runtime: RuntimeFlagPlan }): RpcOmpLaunchSpec {
	const control = input.runtime.carrier === "none" ? null : input.control;
	const env: Record<string, string | null> = { ...input.runtime.env };
	if (control !== null) {
		env[CONTROL_DIR_ENV] = control.directory;
		env[CONTROL_SLOT_ENV] = control.slotId;
	}
	const args = [...input.runtime.args, ...input.binary.prefixArgs, "--cwd", input.cwd, "--profile", input.profile ?? DEFAULT_OMP_PROFILE];
	if (input.sessionFile !== null) args.push("--resume", input.sessionFile);
	else if (input.sessionDir !== null) args.push("--session-dir", input.sessionDir);
	if (control !== null) args.push("-e", control.modulePath);
	return { file: input.binary.command, args, cwd: input.cwd, env };
}

export async function launchNativeHost(request: RpcLaunchRequest, client: PtyBrokerClient): Promise<NativeLaunchOutcome> {
	const startedAt = Date.now();
	let possiblyStarted = false;
	try {
		const binary = await resolveOmpBinary();
		const resolutionMs = Date.now() - startedAt;
		let chosen = { cwd: request.cwd, notice: null as string | null };
		if (request.sessionFile !== null) {
			await fs.access(request.sessionFile);
			const header = await readSessionFileHeader(request.sessionFile);
			if (header === null) return { state: "not-started", reason: "The exact native session file has no readable header.", runtime: null };
			chosen = await resumeWorkingDirectory(header.cwd, request.cwd);
		} else if (request.sessionDir !== null) await fs.mkdir(request.sessionDir, { recursive: true });
		if (request.control !== null) await fs.mkdir(request.control.directory, { recursive: true });
		const controlPlan = await planControlLaunch(binary, request.control);
		const spec = nativeOmpLaunchSpec({ ...request, ...chosen, binary, runtime: controlPlan.runtime });
		possiblyStarted = true;
		const launched = await client.launch({ ...spec, slot: request.slot, kind: "managed-omp", title: `OMP: ${path.basename(chosen.cwd)}` });
		if (launched.handle === null) return { state: launched.state === "not-started" ? "not-started" : "unconfirmed", reason: launched.reason, runtime: null };
		const handle = launched.handle;
		const identityDeadline = Date.now() + 5_000;
		while (handle.nativeCreationTime === null && handle.state !== "exited" && Date.now() < identityDeadline) {
			await delay(50);
			await handle.refreshStatus();
		}
		const identity = recordedRpcIdentityOf(handle);
		if (identity.childPid === null || identity.childCreationTime === null) {
			handle.disconnect();
			return { state: "unconfirmed", reason: "The native broker did not prove its exact child identity.", runtime: null };
		}
		return {
			state: "running", reason: `Native OMP launched from ${binary.origin} under the PTY broker${controlPlan.log === null ? "" : `; ${controlPlan.log}`}.`,
			runtime: { kind: "terminal", handle, identity, cwd: chosen.cwd, sessionFile: request.sessionFile, control: controlPlan.delivered ? request.control : null, binary, notice: [chosen.notice, controlPlan.notice].filter(part => part !== null).join(" ") || null, pid: identity.childPid, resolutionMs, observed: null, stopping: false, observedSurvivors: [] },
		};
	} catch (error) {
		return { state: possiblyStarted ? "unconfirmed" : "not-started", reason: error instanceof Error ? error.message : String(error), runtime: null };
	}
}

export async function attachNativeHost(input: { readonly pin: BrokerPin; readonly cwd: string; readonly sessionFile: string | null; readonly client: PtyBrokerClient; readonly readNativeGeneration?: NativeGenerationReader }): Promise<NativeAttachOutcome> {
	const proof = concurrentPinProof({
		pin: input.pin,
		// A pseudo-console child is not held by handle (its exit is reported when its output closes, which can follow its end),
		// so the broker does not attest it and its kernel creation time is read here, freshly for this proof.
		readNativeGeneration: input.readNativeGeneration ?? lazyNativeGenerationReader(input.client),
		kind: "managed-omp",
	});
	const connectStarted = Date.now();
	const attached = await input.client.attach(input.pin.slot, { whileConfirming: proof.start });
	const connectMs = Date.now() - connectStarted;
	if (attached.handle === null) return { state: "unavailable", reason: attached.reason, runtime: null };
	const handle = attached.handle;
	const child = await proof.settle(handle);
	if (!child.proof.ok) {
		handle.disconnect();
		return { state: "unavailable", reason: child.proof.reason, runtime: null };
	}
	// A surviving broker is never restarted to pick up new code (that would end the OMP process it owns);
	// its older screen mirror is covered by the repaint a restored screen is followed by, and the log says so.
	const another = handle.buildMatches ? "" : " Its PTY broker was started by another build of this extension; the screen is repainted after it is restored.";
	return {
		state: "attached", reason: `Reattached the exact managed native OMP process.${another}`,
		runtime: { kind: "terminal", handle, identity: recordedRpcIdentityOf(handle), cwd: input.cwd, sessionFile: input.sessionFile, control: null, binary: null, notice: null, pid: input.pin.nativePid, observed: null, stopping: false, observedSurvivors: [] },
		timings: { connectMs, brokerIdentity: attached.identity?.mode ?? "probe", brokerIdentityMs: attached.identity?.ms ?? 0, childIdentity: child.childReads === 0 ? "trusted" : "probe", childIdentityMs: child.ms },
	};
}

/** Read-only settlement proof. Never closes ConPTY or signals a process. */
export async function waitForManagedRootExit(runtime: SessionHostRuntime, client: PtyBrokerClient, timeoutMs = 30_000): Promise<NativeStopVerdict> {
	const reader = await brokerNativeGenerationReader(client);
	if (reader === null || runtime.identity.childCreationTime === null) return { writerGone: false, treeEmpty: false, detail: "This session could not be checked safely. Reopen its editor and try Stop again.", diagnosticDetail: "The exact OMP root exit cannot be proven without its creation-time probe." };
	const deadline = Date.now() + timeoutMs;
	do {
		try {
			const status = await runtime.handle.refreshStatus();
			if (status.state === "exited" && status.nativePid === runtime.pid && status.nativeCreationTime === runtime.identity.childCreationTime) {
				const reading = await reader(runtime.pid);
				if (reading.kind === "gone" || (reading.kind === "found" && reading.creationTime !== runtime.identity.childCreationTime)) {
					return { writerGone: true, treeEmpty: false, detail: "The session is stopped. Commands it started may continue running separately.", diagnosticDetail: `The exact OMP root pid ${runtime.pid} exited. Its uncontained process tree remains unknown.` };
				}
			}
		} catch (error) {
			// A broker that no longer exists (killed, or crashed) cannot answer. The writer is then proven gone the way a
			// recovered row's is: the broker's and the OMP root's own creation times name processes that are no longer there.
			if (await processGone(reader, runtime.handle.brokerPid, runtime.handle.record.brokerCreationTime) && await processGone(reader, runtime.pid, runtime.identity.childCreationTime)) {
				return { writerGone: true, treeEmpty: false, detail: "The session is stopped. Commands it started may continue running separately.", diagnosticDetail: `The broker ${runtime.handle.brokerPid} and the exact OMP root pid ${runtime.pid} are gone. Its uncontained process tree remains unknown.` };
			}
			return { writerGone: false, treeEmpty: false, detail: "The session is disconnected. Reopen its editor and try Stop again.", diagnosticDetail: `Native child-exit read failed: ${error instanceof Error ? error.message : String(error)}` };
		}
		if (Date.now() >= deadline) break;
		await delay(100);
	} while (true);
	return { writerGone: false, treeEmpty: false, detail: "OMP is still finishing queued or background work, or could not be confirmed stopped. Nothing was restarted; try Stop again.", diagnosticDetail: `Exact OMP root pid ${runtime.pid} exit was not confirmed before the deadline.` };
}

/** Whether a creation-time reading proves the process recorded under `creationTime` is gone: the id is unused, or now belongs to a process created at another time. `null` (never recorded) and an unreadable id prove nothing. */
async function processGone(reader: NativeGenerationReader, pid: number, creationTime: string | null): Promise<boolean> {
	if (creationTime === null) return false;
	try {
		const reading = await reader(pid);
		return reading.kind === "gone" || (reading.kind === "found" && reading.creationTime !== creationTime);
	} catch {
		return false;
	}
}

/**
 * Whether a broker and the OMP (or shell) root it hosted are both proven gone by their recorded creation times.
 * `false` for anything less: a process still there, an id without a recorded creation time, or a probe that could not run.
 */
export async function brokerAndRootGone(
	client: PtyBrokerClient,
	broker: { readonly pid: number; readonly creationTime: string | null },
	root: { readonly pid: number; readonly creationTime: string | null },
): Promise<boolean> {
	const reader = await brokerNativeGenerationReader(client).catch(() => null);
	if (reader === null) return false;
	return await processGone(reader, broker.pid, broker.creationTime) && await processGone(reader, root.pid, root.creationTime);
}

/**
 * Whether the OMP (or shell) root a runtime recorded has already ended, proven without that runtime's own broker:
 * an id no process uses any more is conclusive at once; an id still in use is gone only when its creation time,
 * read through `client`'s probe (any broker of this build), differs from the recorded one. `false` for anything less.
 * A stop that could not be confirmed (its broker gone, the process unreachable) asks this before reporting a failure,
 * because a writer that is already gone is stopped.
 */
export async function recordedRootGone(
	client: PtyBrokerClient | null,
	root: { readonly pid: number; readonly creationTime: string | null },
	isAlive: (pid: number) => boolean = isPtyProcessAlive,
): Promise<boolean> {
	if (!Number.isSafeInteger(root.pid) || root.pid <= 0) return false;
	if (!isAlive(root.pid)) return true;
	if (client === null) return false;
	const reader = await brokerNativeGenerationReader(client).catch(() => null);
	if (reader === null) return false;
	return await processGone(reader, root.pid, root.creationTime);
}
