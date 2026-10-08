/**
 * Kernel identity readings for the PTY broker's processes
 * ([ADR-0024](../../docs/decisions/0024-own-omp-pty-for-in-tab-terminal.md),
 * [ADR-0035](../../docs/decisions/0035-distinguish-a-recorded-process-from-a-later-occupant-of-its-pid.md)).
 *
 * A process id alone is not an identity: Windows reuses ids as soon as every
 * handle to the process is closed, so "pid 4711 is our native OMP" is a guess
 * unless the id is paired with the process's kernel creation time — the same
 * FILETIME reading the host-control channel records through
 * `verified-pipe.ps1 -Mode generation`. This module produces those readings, plus
 * the descendant list a stop needs before it may claim a tree is gone, by running
 * the packaged probe helper from its content-addressed staged copy.
 *
 * Invariants:
 * - The helper is re-read and re-hashed immediately before every spawn, exactly
 *   like the host-control bridge: a path that was correct when it was staged says
 *   nothing about the bytes there now, and PowerShell would run whatever it finds.
 * - Every reading is tri-state. `unknown` is a real answer — a probe that could
 *   not run, a helper that changed under us — and callers must not promote it to
 *   `gone` or to `found`. Nothing here reports a value it did not read.
 * - The helper's own output is bounded and parsed by contract (`!GENERATION`,
 *   `!TREE`, `!ERROR`), so no unparsed peer text ever reaches a caller.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { isPtyCreationTime } from "./pty-protocol.ts";
import { windowsPowerShellEnvironment, windowsPowerShellExecutable } from "./windows-powershell.ts";

/** Default bound for one probe: PowerShell start plus one process-table read. */
export const PTY_PROBE_TIMEOUT_MS = 15_000;

/** Bound for a descendant read, which snapshots the whole process table. */
export const PTY_TREE_TIMEOUT_MS = 30_000;

/** Largest line one probe may print before it is refused as a flood. */
const MAX_PROBE_LINE_CHARS = 8 * 1024;

/** The verified probe helper copy this process runs: its path and its digest. */
export interface PtyProbeHelper {
	readonly path: string;
	readonly sha256: string;
}

/** What a creation-time reading found. */
export type PtyIdentityReading =
	| { readonly kind: "found"; readonly creationTime: string }
	| { readonly kind: "gone" }
	| { readonly kind: "unknown"; readonly detail: string };

/** What a descendant reading found. */
export type PtyTreeReading =
	| { readonly kind: "found"; readonly pids: readonly number[] }
	| { readonly kind: "unknown"; readonly detail: string };

/**
 * Whether a process id is alive *right now*.
 *
 * `process.kill(pid, 0)` asks the kernel without sending a signal. A process this
 * account may not open answers `EPERM`, which still means it exists, so only
 * `ESRCH` is read as "gone".
 */
export function isPtyProcessAlive(pid: number): boolean {
	if (!Number.isSafeInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException | null)?.code !== "ESRCH";
	}
}

/** One bounded run of the probe helper: its control lines, or why it failed. */
interface ProbeRun {
	readonly lines: readonly string[];
	readonly exitCode: number | null;
	readonly stderr: string;
	readonly timedOut: boolean;
	readonly started: boolean;
}

async function runProbeHelper(
	helper: PtyProbeHelper,
	args: readonly string[],
	timeoutMs: number,
): Promise<ProbeRun> {
	// Re-read immediately before the spawn: a changed helper is refused rather
	// than executed, and that refusal is the caller's to report.
	const bytes = await readFile(helper.path).catch(() => null);
	const digest = bytes === null ? null : createHash("sha256").update(bytes).digest("hex");
	if (digest !== helper.sha256) {
		return {
			lines: [],
			exitCode: null,
			stderr: "",
			timedOut: false,
			started: false,
		};
	}
	const child = spawn(
		windowsPowerShellExecutable(),
		["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helper.path, ...args],
		{ windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: windowsPowerShellEnvironment() },
	);
	const decoder = new StringDecoder("utf8");
	const lines: string[] = [];
	let buffered = "";
	let stderr = "";
	let timedOut = false;
	let settled = false;
	const { promise, resolve } = Promise.withResolvers<{ code: number | null; started: boolean }>();
	const finish = (code: number | null, started: boolean): void => {
		if (settled) return;
		settled = true;
		resolve({ code, started });
	};
	child.stdout?.on("data", (chunk: Buffer) => {
		buffered += decoder.write(chunk);
		for (;;) {
			const newline = buffered.indexOf("\n");
			if (newline < 0) break;
			const line = buffered.slice(0, newline).replace(/\r$/, "");
			buffered = buffered.slice(newline + 1);
			if (line.length > 0 && lines.length < 64) lines.push(line);
		}
		// A probe that floods is refused: nothing here buffers an unbounded answer.
		if (buffered.length > MAX_PROBE_LINE_CHARS) {
			buffered = "";
			lines.push("!ERROR LINE_TOO_LONG");
			child.kill();
		}
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		if (stderr.length < MAX_PROBE_LINE_CHARS) stderr += decoder.write(chunk);
	});
	child.on("error", () => finish(null, false));
	child.on("close", code => finish(code, true));
	const timer = setTimeout(() => {
		timedOut = true;
		child.kill();
	}, timeoutMs);
	timer.unref();
	let outcome: { code: number | null; started: boolean };
	try {
		outcome = await promise;
	} finally {
		clearTimeout(timer);
	}
	if (buffered.length > 0) lines.push(buffered.replace(/\r$/, ""));
	return { lines, exitCode: outcome.code, stderr, timedOut, started: outcome.started };
}

/** The `!KIND fields` a probe printed, or `null` for anything else. */
function parseProbeLine(line: string): { readonly kind: string; readonly fields: readonly string[] } | null {
	if (!line.startsWith("!")) return null;
	const fields = line.slice(1).split(/\s+/);
	const kind = fields.shift();
	return kind === undefined || kind.length === 0 ? null : { kind, fields };
}

function describeProbeFailure(run: ProbeRun): string {
	if (!run.started) return "the process probe could not be started, or its staged copy no longer holds its own bytes";
	if (run.timedOut) return "the process probe did not answer in time";
	const code = run.lines.find(line => line.startsWith("!ERROR "));
	if (code !== undefined) return `the process probe refused: ${code.slice("!ERROR ".length)}`;
	const detail = run.stderr.trim().split(/\r?\n/)[0] ?? "";
	return `the process probe answered nothing usable (exit ${run.exitCode ?? "unknown"}${detail.length > 0 ? `: ${detail}` : ""})`;
}

/**
 * Kernel creation time of one process.
 *
 * `gone` is reported only when the helper says it could not open the process — the
 * same reading `verified-pipe.ps1 -Mode generation` gives — and never derived from
 * a process id alone.
 */
export async function queryPtyProcessIdentity(
	helper: PtyProbeHelper,
	pid: number,
	timeoutMs = PTY_PROBE_TIMEOUT_MS,
): Promise<PtyIdentityReading> {
	if (process.platform !== "win32") {
		return { kind: "unknown", detail: "process identity reading is implemented for Windows only" };
	}
	if (!Number.isSafeInteger(pid) || pid <= 0) return { kind: "unknown", detail: "no process id to read" };
	const run = await runProbeHelper(helper, ["-Mode", "generation", "-TargetPid", String(pid)], timeoutMs);
	for (const line of run.lines) {
		const parsed = parseProbeLine(line);
		if (parsed === null) continue;
		if (parsed.kind === "GENERATION") {
			const value = parsed.fields[0];
			if (value === undefined || !isPtyCreationTime(value)) {
				return { kind: "unknown", detail: "the process probe printed a creation time that is not a FILETIME" };
			}
			return { kind: "found", creationTime: value };
		}
		if (parsed.kind === "ERROR") {
			// The helper could not open the process: it is gone, or it is not ours to read.
			return parsed.fields[0] === "PROCESS_QUERY_FAILED"
				? { kind: "gone" }
				: { kind: "unknown", detail: `the process probe refused: ${parsed.fields[0] ?? "unknown"}` };
		}
	}
	return { kind: "unknown", detail: describeProbeFailure(run) };
}

/** Live descendants of one process, from a single process-table snapshot. */
export async function queryPtyProcessTree(
	helper: PtyProbeHelper,
	pid: number,
	timeoutMs = PTY_TREE_TIMEOUT_MS,
): Promise<PtyTreeReading> {
	if (process.platform !== "win32") {
		return { kind: "unknown", detail: "process tree reading is implemented for Windows only" };
	}
	if (!Number.isSafeInteger(pid) || pid <= 0) return { kind: "unknown", detail: "no process id to read" };
	const run = await runProbeHelper(helper, ["-Mode", "tree", "-TargetPid", String(pid)], timeoutMs);
	for (const line of run.lines) {
		const parsed = parseProbeLine(line);
		if (parsed === null) continue;
		if (parsed.kind === "TREE") {
			const value = parsed.fields[0] ?? "-";
			if (value === "-") return { kind: "found", pids: [] };
			const pids: number[] = [];
			for (const field of value.split(",")) {
				const id = Number.parseInt(field, 10);
				if (!Number.isSafeInteger(id) || id <= 0) {
					return { kind: "unknown", detail: "the process probe printed a descendant list that could not be read" };
				}
				pids.push(id);
			}
			return { kind: "found", pids };
		}
		if (parsed.kind === "ERROR") {
			return { kind: "unknown", detail: `the process probe refused: ${parsed.fields[0] ?? "unknown"}` };
		}
	}
	return { kind: "unknown", detail: describeProbeFailure(run) };
}

/** A process that is gone, or why that could not be established in the bound. */
export interface PtyGoneReading {
	readonly gone: boolean;
	readonly detail: string;
}

/**
 * Wait for one process id to disappear, by creation-time readings rather than by
 * liveness alone: a process that exited during the wait and whose id was reused
 * inside it reads as a *different* process, and a `found` reading whose creation
 * time changed is not the process this call is waiting for.
 */
export async function waitForPtyProcessGone(
	helper: PtyProbeHelper,
	pid: number,
	expectedCreationTime: string | null,
	timeoutMs: number,
): Promise<PtyGoneReading> {
	const deadline = Date.now() + timeoutMs;
	let lastDetail = "no reading was taken";
	for (;;) {
		const reading = await queryPtyProcessIdentity(helper, pid);
		if (reading.kind === "gone") return { gone: true, detail: "the process id is no longer openable by the kernel" };
		if (reading.kind === "found") {
			if (expectedCreationTime !== null && reading.creationTime !== expectedCreationTime) {
				// The id now belongs to a different process: the one we waited for is gone.
				return { gone: true, detail: "the process id was reused by a different process" };
			}
			lastDetail = "the process is still alive";
		} else {
			lastDetail = reading.detail;
		}
		if (Date.now() >= deadline) return { gone: false, detail: `${lastDetail} after ${timeoutMs}ms` };
		await new Promise<void>(resolve => {
			const timer = setTimeout(resolve, 250);
			timer.unref();
		});
	}
}
