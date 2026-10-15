/**
 * Runs the one-shot native module stager (`native-stage.ts`, ADR-0076 decision 4) and reads its verdict.
 *
 * The child runs under this process's own executable as Node. It is bounded (it is killed at the
 * deadline), its output is capped, and anything but one well-formed `staged` line is a refusal: the
 * host then runs with the native module unavailable, which reads every Windows check as unknown.
 */
import { spawn } from "node:child_process";
import { ptyRuntimeCommand } from "../host/pty-runtime.ts";
import { startToolSpawnTrace } from "../host/tool-spawn-trace.ts";
import type { NativeStageVerdict } from "./native-stage.ts";

/**
 * Longest the child may take. It stages one file and verifies a handful of paths in 0.15–0.3 s, but one run on the
 * development machine took about 15 s (cause not established; a scanner's first look at the unsigned `koffi.node` is the
 * likely one), and a timeout leaves every Windows check unknown for the life of the window, so the bound is generous.
 */
export const NATIVE_STAGE_DEADLINE_MS = 60_000;
const MAX_VERDICT_BYTES = 16 * 1024;

export async function runNativeStage(input: {
	/** The bundled child, `out/native-stage.js` (or the TypeScript source under a test runner). */
	readonly entry: string;
	readonly packaged: string;
	readonly storageDir: string;
	readonly deadlineMs?: number;
}): Promise<NativeStageVerdict> {
	const { command, env } = ptyRuntimeCommand();
	const end = startToolSpawnTrace("node", "native module staging");
	const { promise, resolve } = Promise.withResolvers<NativeStageVerdict>();
	const child = spawn(command, [input.entry, input.packaged, input.storageDir], {
		env,
		windowsHide: true,
		stdio: ["ignore", "pipe", "ignore"],
	});
	const chunks: Buffer[] = [];
	let length = 0;
	let settled = false;
	const finish = (verdict: NativeStageVerdict, outcome: Parameters<typeof end>[1]): void => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		end(child.pid, outcome);
		resolve(verdict);
	};
	const timer = setTimeout(() => {
		child.kill();
		finish({ kind: "refused", reason: `the native stage child did not answer in ${input.deadlineMs ?? NATIVE_STAGE_DEADLINE_MS} ms` }, "timeout");
	}, input.deadlineMs ?? NATIVE_STAGE_DEADLINE_MS);
	child.stdout.on("data", (chunk: Buffer) => {
		length += chunk.length;
		if (length > MAX_VERDICT_BYTES) {
			child.kill();
			finish({ kind: "refused", reason: "the native stage child's output exceeded the accepted size" }, "output-too-large");
			return;
		}
		chunks.push(chunk);
	});
	child.on("error", error => finish({ kind: "refused", reason: `the native stage child could not start: ${error.name}` }, "start-failed"));
	child.on("close", code => {
		const verdict = parseVerdict(Buffer.concat(chunks).toString("utf8"));
		if (code === 0 && verdict.kind === "staged") finish(verdict, "ok");
		else finish(verdict.kind === "refused" ? verdict : { kind: "refused", reason: `the native stage child exited with ${String(code)}` }, "failed");
	});
	return promise;
}

/** The child's last line as a verdict; anything that is not one is a refusal. */
export function parseVerdict(stdout: string): NativeStageVerdict {
	const line = stdout.trim().split(/\r?\n/).at(-1) ?? "";
	try {
		const value: unknown = JSON.parse(line);
		if (typeof value === "object" && value !== null) {
			const { kind, path, sha256, reason } = value as Record<string, unknown>;
			if (kind === "staged" && typeof path === "string" && typeof sha256 === "string" && /^[0-9a-f]{64}$/.test(sha256)) {
				return { kind, path, sha256 };
			}
			if (kind === "refused" && typeof reason === "string") return { kind, reason };
		}
	} catch {
		// Not JSON: handled below.
	}
	return { kind: "refused", reason: "the native stage child did not report a verdict" };
}
