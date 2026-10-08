/**
 * The broker's client of its private owner-watch helper
 * ([ADR-0030](../../docs/decisions/0030-watch-the-verified-owning-vscode-process-for-shell-grace.md)).
 *
 * The decision this module serves is a *process-lifetime* one: a folder shell may be
 * stopped only after the VS Code instance that owns it has really exited, and "the
 * extension host disconnected" is not that. The extension host's own `pid`, `ppid`
 * and `VSCODE_PID` are hints a confused caller can get wrong, so nothing here trusts
 * them: the staged helper opens the processes themselves, reads their kernel creation
 * times, their executable images and the live extension host's *actual* parent, and
 * requires all of them to agree before it retains a synchronize handle on the
 * candidate main process.
 * Host role is read independently too: exact legacy argv, or modern NodeService
 * utility argv plus its own extensionHost role/entrypoint environment pair. Generic
 * utilities and unreadable or conflicting markers never authorize owner cleanup.
 *
 * The helper is a long-lived staged process rather than a one-shot probe, because
 * keeping a handle open is the whole point: a handle a live process holds signals
 * when that process ends, whereas a numeric process id read later cannot distinguish
 * an exit from a reused id. Its lifecycle is deliberately narrow:
 *
 * - it is re-hashed from the staged tree immediately before every spawn, so a helper
 *   whose bytes changed is refused rather than executed;
 * - every line it prints is bounded and parsed; an unexpected line, a flood, a closed
 *   pipe or its exit is *loss of the watch* — never an exit of a watched process. The
 *   same holds for the helper's own `!FAILED`: a wait that did not answer
 *   `WAIT_OBJECT_0` says the helper cannot tell whether that process is alive, which is
 *   the one answer that must never authorize a stop;
 * - when it is lost, the caller must disarm automatic stopping (fail closed), because
 *   "we can no longer see the owner" is not "the owner is gone";
 * - it exits by itself when its stdin closes, which is what happens when the broker
 *   that owns it dies, so a crashed broker cannot leave a helper behind holding handles.
 *
 * The wire form is one ASCII line per message in both directions, matching the staged
 * probe's `!`-prefixed style:
 *
 * ```
 * -> admit <requestId> <mainPid> <hostPid> <expectedParentPid>
 * -> quit
 * <- !READY <helperPid>
 * <- !ADMITTED <requestId> <mainPid> <creationTime>
 * <- !UNSUPPORTED <requestId> <CODE>
 * <- !SIGNAL <mainPid> <creationTime>
 * <- !FAILED <CODE> <mainPid>
 * <- !BYE
 * <- !ERROR <CODE>
 * ```
 *
 * `!SIGNAL` is the only line that says a watched process ended, and the helper emits it
 * only for a `WAIT_OBJECT_0` answer from the kernel. `!FAILED` is the opposite: the
 * helper could no longer tell whether that generation is alive, which is loss of the
 * watch — never a signal, because a signal is what authorizes a stop.
 *
 * Nothing here signals, stops or opens for termination any process: the retained
 * handle is opened with `SYNCHRONIZE` and query rights only, and the only termination
 * this design performs is the folder-shell stop the broker already owns.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { isPtyCreationTime, type PtyOwnerHint } from "./pty-protocol.ts";
import { windowsPowerShellEnvironment, windowsPowerShellExecutable } from "./windows-powershell.ts";

/** Default bound for one helper answer: its own start plus two process readings. */
export const PTY_OWNER_ADMIT_TIMEOUT_MS = 20_000;

/** Largest line the helper may print before it is treated as lost. */
const MAX_HELPER_LINE_CHARS = 8 * 1024;

/** How long a stopped helper gets to exit on its own before it is killed. */
const HELPER_STOP_GRACE_MS = 2_000;

/** The staged helper copy this process runs: its path and its digest. */
export interface PtyOwnerWatchHelper {
	readonly path: string;
	readonly sha256: string;
}

/**
 * What one attestation found.
 *
 * `unsupported` is not an error to retry: it means this topology cannot be verified,
 * which is exactly the case that must leave a shell alone.
 */
export type PtyOwnerAdmission =
	| { readonly kind: "admitted"; readonly pid: number; readonly creationTime: string }
	| { readonly kind: "unsupported"; readonly code: string; readonly detail: string };

export interface PtyOwnerWatchEvents {
	/** A retained main handle signaled: that generation ended, read from the kernel. */
	readonly onSignaledMain: (pid: number, creationTime: string) => void;
	/**
	 * The watch is gone — the helper exited, failed or printed something unusable.
	 * This is *not* an exit of any watched process, and the caller must not read it
	 * as one.
	 */
	readonly onWatchLost: (detail: string) => void;
}

export interface PtyOwnerWatcher {
	/** `true` while the helper process is alive and has announced itself. */
	readonly alive: boolean;
	/** Ask the helper to attest one candidate owning main and retain its handle. */
	admit(hint: PtyOwnerHint): Promise<PtyOwnerAdmission>;
	/** Close the helper. Never waits indefinitely. */
	stop(): Promise<void>;
}

export interface PtyOwnerWatcherLaunch {
	readonly watcher: PtyOwnerWatcher | null;
	/** Why no helper could be started; the caller disarms when this is not null. */
	readonly detail: string | null;
}

export interface PtyOwnerWatcherOptions {
	readonly helper: PtyOwnerWatchHelper;
	/** This broker's own pid, which a helper refuses to attest as a main process. */
	readonly brokerPid: number;
	readonly admitTimeoutMs?: number;
	/**
	 * How the helper process is created. Production leaves this out; a test that must
	 * exercise this module's answer handling without PowerShell supplies its own.
	 */
	readonly launch?: (helper: PtyOwnerWatchHelper, args: readonly string[]) => ChildProcess;
}

/** The helper's command line, without the executable. */
export function ptyOwnerHelperArguments(helper: PtyOwnerWatchHelper, brokerPid: number): string[] {
	return [
		"-NoProfile",
		"-NonInteractive",
		"-ExecutionPolicy",
		"Bypass",
		"-File",
		helper.path,
		"-BrokerPid",
		String(brokerPid),
	];
}

/**
 * Start the staged owner-watch helper.
 *
 * The returned `detail` is why no watch exists; a caller that gets one must disarm
 * automatic stopping for the shell rather than guess that some other process is the
 * owner.
 */
export async function startPtyOwnerWatcher(
	events: PtyOwnerWatchEvents,
	options: PtyOwnerWatcherOptions,
): Promise<PtyOwnerWatcherLaunch> {
	// Re-read immediately before the spawn: a changed helper is refused rather than run.
	const bytes = await readFile(options.helper.path).catch(() => null);
	if (bytes === null || createHash("sha256").update(bytes).digest("hex") !== options.helper.sha256) {
		return { watcher: null, detail: "the staged owner-watch helper no longer holds the bytes it was staged with" };
	}
	const args = ptyOwnerHelperArguments(options.helper, options.brokerPid);
	let child: ChildProcess;
	try {
		child =
			options.launch?.(options.helper, args) ??
			spawn(windowsPowerShellExecutable(), args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: windowsPowerShellEnvironment() });
	} catch (error) {
		return { watcher: null, detail: `the owner-watch helper could not be started: ${messageOf(error)}` };
	}
	return { watcher: new OwnerWatcher(child, options, events), detail: null };
}

interface PendingCommand {
	readonly resolve: (answer: string | null) => void;
}

class OwnerWatcher implements PtyOwnerWatcher {
	private readonly child: ChildProcess;
	private readonly events: PtyOwnerWatchEvents;
	private readonly admitTimeoutMs: number;
	private readonly pending = new Map<number, PendingCommand>();
	private readonly announced = Promise.withResolvers<void>();
	private lostDetail: string | null = null;
	private ready = false;
	private stopping = false;
	private nextRequestId = 1;

	constructor(child: ChildProcess, options: PtyOwnerWatcherOptions, events: PtyOwnerWatchEvents) {
		this.child = child;
		this.events = events;
		this.admitTimeoutMs = options.admitTimeoutMs ?? PTY_OWNER_ADMIT_TIMEOUT_MS;
		const decoder = new StringDecoder("utf8");
		let buffered = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			buffered += decoder.write(chunk);
			for (;;) {
				const newline = buffered.indexOf("\n");
				if (newline < 0) break;
				const line = buffered.slice(0, newline).replace(/\r$/, "");
				buffered = buffered.slice(newline + 1);
				this.readLine(line);
			}
			if (buffered.length > MAX_HELPER_LINE_CHARS) {
				buffered = "";
				this.lose("the owner-watch helper flooded its answer stream");
			}
		});
		child.on("error", error => this.lose(`the owner-watch helper failed: ${messageOf(error)}`));
		child.on("close", code => this.lose(`the owner-watch helper exited with code ${code ?? "unknown"}`));
	}

	get alive(): boolean {
		return this.lostDetail === null && this.ready;
	}

	async admit(hint: PtyOwnerHint): Promise<PtyOwnerAdmission> {
		if (!(await this.waitReady())) {
			return { kind: "unsupported", code: "WATCH_LOST", detail: this.lostDetail ?? "the owner-watch helper is not available" };
		}
		const answer = await this.command("admit", `${String(hint.mainPid)} ${String(hint.extensionHostPid)} ${String(hint.parentPid)}`);
		if (answer === null) {
			return { kind: "unsupported", code: "WATCH_LOST", detail: this.lostDetail ?? "the owner-watch helper did not answer" };
		}
		if (answer.startsWith("!ADMITTED ")) {
			const fields = answer.slice("!ADMITTED ".length).split(" ");
			const pid = Number(fields[1]);
			const creationTime = fields[2];
			if (!Number.isSafeInteger(pid) || pid < 1 || !isPtyCreationTime(creationTime)) {
				this.lose("the owner-watch helper reported an unusable admission");
				return { kind: "unsupported", code: "UNUSABLE_ANSWER", detail: "the helper's admission answer was not usable" };
			}
			return { kind: "admitted", pid, creationTime };
		}
		if (answer.startsWith("!UNSUPPORTED ")) {
			// `!UNSUPPORTED <requestId> <CODE>`: the code is the field after the id.
			const code = answer.slice("!UNSUPPORTED ".length).split(" ")[1] ?? "";
			return {
				kind: "unsupported",
				code: code.length > 0 ? code : "UNSUPPORTED",
				detail: `the owning VS Code process could not be attested (${code.length > 0 ? code : "no reason given"})`,
			};
		}
		return { kind: "unsupported", code: "UNUSABLE_ANSWER", detail: `the helper answered ${JSON.stringify(answer.slice(0, 64))}` };
	}

	async stop(): Promise<void> {
		if (this.stopping) return;
		this.stopping = true;
		try {
			this.child.stdin?.end("quit\n");
		} catch {
			// A helper whose stdin is already gone needs no quit.
		}
		const timer = setTimeout(() => {
			try {
				this.child.kill();
			} catch {
				// It exited between the timer and the kill.
			}
		}, HELPER_STOP_GRACE_MS);
		timer.unref();
	}

	private async waitReady(): Promise<boolean> {
		if (this.lostDetail !== null) return false;
		if (this.ready) return true;
		const expired = Promise.withResolvers<void>();
		const timeout = setTimeout(() => expired.resolve(), this.admitTimeoutMs);
		timeout.unref();
		try {
			await Promise.race([this.announced.promise, expired.promise]);
		} finally {
			clearTimeout(timeout);
		}
		return this.ready && this.lostDetail === null;
	}

	/**
	 * Send one command and wait for the answer line that correlates with it.
	 *
	 * A helper that does not answer within the bound is loss of the watch: a caller
	 * cannot distinguish a stuck helper from a dead one, and both mean the owner set is
	 * no longer observable.
	 */
	private async command(name: string, args: string): Promise<string | null> {
		const stdin = this.child.stdin;
		if (this.lostDetail !== null || stdin === null) return null;
		const id = this.nextRequestId;
		this.nextRequestId += 1;
		const { promise, resolve } = Promise.withResolvers<string | null>();
		this.pending.set(id, { resolve });
		const timer = setTimeout(() => {
			this.pending.delete(id);
			resolve(null);
		}, this.admitTimeoutMs);
		timer.unref();
		try {
			stdin.write(`${name} ${String(id)} ${args}\n`);
		} catch (error) {
			clearTimeout(timer);
			this.pending.delete(id);
			this.lose(`the owner-watch helper could not be asked: ${messageOf(error)}`);
			return null;
		}
		const answer = await promise;
		clearTimeout(timer);
		return answer;
	}

	private readLine(line: string): void {
		if (line.length === 0) return;
		if (line.length > MAX_HELPER_LINE_CHARS) {
			// A helper that writes a huge line is not one whose answers can be trusted, and
			// nothing here buffers a line it cannot bound.
			this.lose("the owner-watch helper flooded its answer stream");
			return;
		}
		if (line === "!READY" || line.startsWith("!READY ")) {
			this.ready = true;
			this.announced.resolve();
			return;
		}
		if (line.startsWith("!SIGNAL ")) {
			const fields = line.slice("!SIGNAL ".length).split(" ");
			const pid = Number(fields[0]);
			const creationTime = fields[1];
			if (Number.isSafeInteger(pid) && pid > 0 && isPtyCreationTime(creationTime)) {
				this.events.onSignaledMain(pid, creationTime);
			} else {
				this.lose("the owner-watch helper reported an unusable signal");
			}
			return;
		}
		if (line.startsWith("!FAILED ")) {
			// The helper could no longer tell whether a watched generation is alive. That is
			// loss of the watch, not an exit: nothing here may be read as a signal.
			const code = line.slice("!FAILED ".length).split(" ")[0] ?? "";
			this.lose(`the owner-watch helper could not wait on a watched process (${code.length > 0 ? code : "no reason given"})`);
			return;
		}
		if (!line.startsWith("!")) return;
		const id = Number(line.split(" ")[1]);
		const pending = Number.isSafeInteger(id) ? this.pending.get(id) : undefined;
		if (pending !== undefined) {
			this.pending.delete(id);
			pending.resolve(line);
			return;
		}
		// An answer nothing asked for, or the helper's own end, is a helper this build
		// cannot keep reading: nothing about a watched owner is known after this.
		this.lose(`the owner-watch helper sent ${line === "!BYE" ? "its end" : `an unusable line (${line.slice(0, 64)})`}`);
	}

	/** Record the single loss of this watch and settle everything waiting on it. */
	private lose(detail: string): void {
		if (this.lostDetail !== null) return;
		this.lostDetail = detail;
		this.announced.resolve();
		for (const [id, pending] of this.pending) {
			this.pending.delete(id);
			pending.resolve(null);
		}
		// A helper that ends because this broker asked it to is an ordinary end, not a
		// loss the caller has to disarm for.
		if (this.stopping) return;
		this.events.onWatchLost(detail);
		// A helper that failed is not left running: its handles on other processes are
		// released, and no answer from it can be read as anything afterwards.
		void this.stop();
	}
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
