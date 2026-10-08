import * as fs from "node:fs/promises";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CONTROL_DIR_ENV, CONTROL_SLOT_ENV } from "./control-protocol";
import type { ControlNativeState } from "./control-protocol";
import { controlRuntimeFlags, DEFAULT_OMP_PROFILE, resolveOmpBinary } from "./native-terminal";
import type { OmpCommand } from "./native-terminal";
import type { PtyBrokerClient, PtyHandle } from "./pty-client";
import { recordedRpcIdentityOf, resumeWorkingDirectory } from "./rpc-launch";
import type { RpcHostRuntime, RpcLaunchRequest, RpcOmpLaunchSpec } from "./rpc-launch";
import { brokerNativeGenerationReader, verifyPinnedBrokerAttachment } from "./rpc-reconcile";
import type { BrokerPin, NativeStopVerdict } from "./rpc-reconcile";
import { readSessionFileHeader } from "./session-index";

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
export type NativeLaunchOutcome =
	| { readonly state: "running"; readonly reason: string; readonly runtime: NativeHostRuntime }
	| { readonly state: "not-started" | "unconfirmed"; readonly reason: string; readonly runtime: null };
export type NativeAttachOutcome =
	| { readonly state: "attached"; readonly reason: string; readonly runtime: NativeHostRuntime }
	| { readonly state: "unavailable"; readonly reason: string; readonly runtime: null };

export function nativeOmpLaunchSpec(input: Omit<RpcLaunchRequest, "slot"> & { readonly binary: OmpCommand }): RpcOmpLaunchSpec {
	const env: Record<string, string | null> = {};
	if (input.control !== null) {
		env[CONTROL_DIR_ENV] = input.control.directory;
		env[CONTROL_SLOT_ENV] = input.control.slotId;
	}
	const args = [...controlRuntimeFlags(input.control), ...input.binary.prefixArgs, "--cwd", input.cwd, "--profile", input.profile ?? DEFAULT_OMP_PROFILE];
	if (input.sessionFile !== null) args.push("--resume", input.sessionFile);
	else if (input.sessionDir !== null) args.push("--session-dir", input.sessionDir);
	if (input.control !== null) args.push("-e", input.control.modulePath);
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
		const spec = nativeOmpLaunchSpec({ ...request, ...chosen, binary });
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
			state: "running", reason: `Native OMP launched from ${binary.origin} under the PTY broker.`,
			runtime: { kind: "terminal", handle, identity, cwd: chosen.cwd, sessionFile: request.sessionFile, control: request.control, binary, notice: chosen.notice, pid: identity.childPid, resolutionMs, observed: null, stopping: false, observedSurvivors: [] },
		};
	} catch (error) {
		return { state: possiblyStarted ? "unconfirmed" : "not-started", reason: error instanceof Error ? error.message : String(error), runtime: null };
	}
}

export async function attachNativeHost(input: { readonly pin: BrokerPin; readonly cwd: string; readonly sessionFile: string | null; readonly client: PtyBrokerClient }): Promise<NativeAttachOutcome> {
	const attached = await input.client.attach(input.pin.slot);
	if (attached.handle === null) return { state: "unavailable", reason: attached.reason, runtime: null };
	const handle = attached.handle;
	try {
		const reader = await brokerNativeGenerationReader(input.client);
		if (reader === null) throw new Error("The native broker has no verified process-identity probe.");
		const proof = await verifyPinnedBrokerAttachment({ handle, pin: input.pin, readNativeGeneration: reader, kind: "managed-omp" });
		if (!proof.ok) throw new Error(proof.reason);
		// A surviving broker is never restarted to pick up new code (that would end the OMP process it owns);
		// its older screen mirror is covered by the repaint a restored screen is followed by, and the log says so.
		const another = handle.buildMatches ? "" : " Its PTY broker was started by another build of this extension; the screen is repainted after it is restored.";
		return { state: "attached", reason: `Reattached the exact managed native OMP process.${another}`, runtime: { kind: "terminal", handle, identity: recordedRpcIdentityOf(handle), cwd: input.cwd, sessionFile: input.sessionFile, control: null, binary: null, notice: null, pid: input.pin.nativePid, observed: null, stopping: false, observedSurvivors: [] } };
	} catch (error) {
		handle.disconnect();
		return { state: "unavailable", reason: error instanceof Error ? error.message : String(error), runtime: null };
	}
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
			return { writerGone: false, treeEmpty: false, detail: "The session is disconnected. Reopen its editor and try Stop again.", diagnosticDetail: `Native child-exit read failed: ${error instanceof Error ? error.message : String(error)}` };
		}
		if (Date.now() >= deadline) break;
		await delay(100);
	} while (true);
	return { writerGone: false, treeEmpty: false, detail: "OMP is still finishing queued or background work, or could not be confirmed stopped. Nothing was restarted; try Stop again.", diagnosticDetail: `Exact OMP root pid ${runtime.pid} exit was not confirmed before the deadline.` };
}
