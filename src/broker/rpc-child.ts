/**
 * The pipe child of a `managed-rpc` broker
 * ([ADR-0038](../../docs/decisions/0038-host-chat-over-rpc-ui-on-a-broker-pipe-child.md)).
 *
 * `omp --mode rpc-ui` speaks JSONL on stdin/stdout, which a pseudo console cannot carry
 * (ConPTY merges stderr, rewrites newlines and echoes), so this kind of slot replaces
 * node-pty with a plain pipe child: `spawn(file, args, { stdio: ["pipe","pipe","pipe"] })`.
 * The broker never loads `node-pty` or the screen model for it.
 *
 * What this module owns:
 *
 * - **draining stdout** into complete lines for the {@link RpcLineRing}, so the child never
 *   blocks on an absent client;
 * - **negotiation.** The broker is the only party that sees `ready` for every attach
 *   generation, so it negotiates protocol 2 itself: it identifies `ready` as the first line
 *   whose `type` is `ready`, writes `negotiate_protocol` when `supportedProtocolVersions`
 *   lists 2, swallows that response, and records the result. It only ever writes whole
 *   lines to stdin, and holds every client write until its own negotiate line is out;
 * - **stdin**: whole lines, serialized, with `extension_ui_response` recognized so the
 *   ring stops replaying an answered dialog;
 * - **stderr**: a bounded tail for diagnostics;
 * - **stop**: graceful is closing stdin (OMP aborts a running turn, persists it, appends
 *   `session_exit` and exits); force terminates the exact process through the handle
 *   Node holds for it, never a numeric pid.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { constants as osConstants } from "node:os";
import {
	PTY_RPC_MAX_LINE_BYTES,
	PTY_RPC_MAX_READY_CHARS,
	PTY_RPC_STDERR_TAIL_BYTES,
} from "../host/pty-protocol.ts";
import { peekRpcLine, RpcLineRing } from "./rpc-ring.ts";

/** The id of the negotiate command the broker itself writes; its response is swallowed. */
export const RPC_NEGOTIATE_ID = "broker:negotiate";

const NEGOTIATE_LINE = `${JSON.stringify({ id: RPC_NEGOTIATE_ID, type: "negotiate_protocol", protocolVersion: 2 })}\n`;

/** How long the broker waits for the negotiate response before it settles on protocol 1. */
export const RPC_NEGOTIATE_TIMEOUT_MS = 10_000;

/** After the process exits, how long its stdout gets to deliver the last lines before the exit is final. */
const EXIT_DRAIN_MS = 250;

/** Why a stdin write was not made. */
export type RpcChildWriteFailure = "child-exited";

export class RpcChildWriteError extends Error {
	readonly code: RpcChildWriteFailure;

	constructor(code: RpcChildWriteFailure, message: string) {
		super(message);
		this.name = "RpcChildWriteError";
		this.code = code;
	}
}

export interface RpcChildSpec {
	readonly file: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly env: Readonly<Record<string, string>>;
}

export interface RpcChildHooks {
	/** The ring gained a line a consumer may be shown (called after the append). */
	readonly onLine: () => void;
	/** `ready` was seen and negotiation settled. */
	readonly onReady: (ready: string, rpcProtocol: 1 | 2) => void;
	/** Fresh stderr text, in bounded pieces. */
	readonly onStderr: (text: string) => void;
	/** The child ended and its stdout is drained. */
	readonly onExit: (exit: { readonly code: number; readonly signal: number }) => void;
	readonly log: (line: string) => void;
}

/** Spawn one rpc-ui child; rejects when the process could not be started. */
export async function startRpcChild(spec: RpcChildSpec, hooks: RpcChildHooks, ring: RpcLineRing): Promise<RpcChild> {
	const proc = spawn(spec.file, [...spec.args], {
		cwd: spec.cwd,
		env: { ...spec.env },
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
	});
	const started = Promise.withResolvers<void>();
	proc.once("spawn", () => started.resolve());
	proc.once("error", error => started.reject(error));
	await started.promise;
	return new RpcChild(proc, hooks, ring);
}

export class RpcChild {
	private readonly proc: ChildProcess;
	private readonly hooks: RpcChildHooks;
	private readonly ring: RpcLineRing;
	private pendingParts: string[] = [];
	private pendingChars = 0;
	private discarding = false;
	private droppedLines = 0;
	private stderrText = "";
	private ready: string | null = null;
	private protocol: 1 | 2 | null = null;
	private negotiateTimer: NodeJS.Timeout | null = null;
	private readonly gate = Promise.withResolvers<void>();
	private stdinChain: Promise<void> = Promise.resolve();
	private stdinClosed = false;
	private finished = false;
	private exitTimer: NodeJS.Timeout | undefined;
	private stdoutEnded = false;
	private exitInfo: { readonly code: number | null; readonly signal: NodeJS.Signals | null } | null = null;

	constructor(proc: ChildProcess, hooks: RpcChildHooks, ring: RpcLineRing) {
		this.proc = proc;
		this.hooks = hooks;
		this.ring = ring;
		// A gate nobody awaits (the child died before `ready`) must not be an unhandled rejection.
		this.gate.promise.catch(() => undefined);
		proc.stdout?.setEncoding("utf8");
		proc.stdout?.on("data", (chunk: string) => this.feed(chunk));
		proc.stdout?.on("end", () => {
			this.stdoutEnded = true;
			this.maybeFinish();
		});
		proc.stderr?.setEncoding("utf8");
		proc.stderr?.on("data", (chunk: string) => this.takeStderr(chunk));
		// A dead stdin pipe surfaces as an error on the stream; the write callback reports it.
		proc.stdin?.on("error", () => undefined);
		proc.once("exit", (code, signal) => {
			this.exitInfo = { code, signal };
			this.settleNegotiation(1);
			this.gate.reject(new RpcChildWriteError("child-exited", "the child exited before it was ready"));
			// A grandchild that inherited stdout would keep the pipe open past the child's exit.
			this.exitTimer = setTimeout(() => this.finish(), EXIT_DRAIN_MS);
			this.exitTimer.unref();
			this.maybeFinish();
		});
	}

	get pid(): number {
		return this.proc.pid ?? 0;
	}

	get readyLine(): string | null {
		return this.ready;
	}

	/** The protocol negotiated with the child; `null` until `ready` was seen and settled. */
	get rpcProtocol(): 1 | 2 | null {
		return this.protocol;
	}

	get exited(): boolean {
		return this.finished;
	}

	/** Stdout lines dropped for exceeding the bound. */
	get droppedLineCount(): number {
		return this.droppedLines;
	}

	/** The most recent stderr text, bounded. */
	stderrTail(): string {
		return this.stderrText;
	}

	/**
	 * Write one whole stdin line. Held until the broker's own negotiate line is out; lines
	 * are written strictly one after another. Resolves once the pipe has accepted the bytes.
	 */
	async writeLine(bytes: Buffer): Promise<void> {
		await this.gate.promise;
		const written = this.stdinChain.then(() => this.write(Buffer.concat([bytes, Buffer.from("\n")])));
		this.stdinChain = written.catch(() => undefined);
		await written;
		this.releaseAnsweredDialog(bytes);
	}

	/** Graceful stop: end stdin. OMP disposes the session and exits. */
	closeStdin(): void {
		if (this.stdinClosed) return;
		this.stdinClosed = true;
		this.proc.stdin?.end();
	}

	/** Terminate the exact process through the retained handle. Descendants are not reached. */
	kill(): boolean {
		return this.proc.kill();
	}

	private write(bytes: Buffer): Promise<void> {
		const stdin = this.proc.stdin;
		if (stdin === null || this.stdinClosed || stdin.destroyed || this.exitInfo !== null) {
			return Promise.reject(new RpcChildWriteError("child-exited", "the child's stdin is closed"));
		}
		const done = Promise.withResolvers<void>();
		stdin.write(bytes, error => {
			if (error) done.reject(new RpcChildWriteError("child-exited", "the child's stdin is not writable"));
			else done.resolve();
		});
		return done.promise;
	}

	private releaseAnsweredDialog(bytes: Buffer): void {
		const head = bytes.subarray(0, 256).toString("utf8");
		if (peekRpcLine(head).type !== "extension_ui_response") return;
		try {
			const parsed: unknown = JSON.parse(bytes.toString("utf8"));
			if (typeof parsed === "object" && parsed !== null && "id" in parsed && typeof parsed.id === "string") {
				this.ring.releaseDialog(parsed.id);
			}
		} catch {
			// Not a response the broker can read: the dialog stays pinned, which is the safe side.
		}
	}

	private feed(chunk: string): void {
		let start = 0;
		for (;;) {
			const newline = chunk.indexOf("\n", start);
			if (newline < 0) break;
			const piece = chunk.slice(start, newline);
			start = newline + 1;
			if (this.discarding) {
				this.discarding = false;
				continue;
			}
			const text = this.pendingParts.length === 0 ? piece : this.pendingParts.join("") + piece;
			this.pendingParts = [];
			this.pendingChars = 0;
			this.line(text);
		}
		const rest = start === 0 ? chunk : chunk.slice(start);
		if (rest.length === 0 || this.discarding) return;
		this.pendingParts.push(rest);
		this.pendingChars += rest.length;
		if (this.pendingChars > PTY_RPC_MAX_LINE_BYTES) {
			this.pendingParts = [];
			this.pendingChars = 0;
			this.discarding = true;
			this.droppedLines += 1;
			this.hooks.log("a stdout line above the bound is being dropped");
		}
	}

	private line(raw: string): void {
		const text = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
		if (text.length === 0) return;
		if (Buffer.byteLength(text, "utf8") > PTY_RPC_MAX_LINE_BYTES) {
			this.droppedLines += 1;
			this.hooks.log("a stdout line above the bound was dropped");
			return;
		}
		const { type, id } = peekRpcLine(text);
		if (type === "ready" && this.ready === null && text.length <= PTY_RPC_MAX_READY_CHARS) {
			this.ready = text;
			this.negotiate(text);
			return;
		}
		if (type === "response" && id === RPC_NEGOTIATE_ID) {
			this.settleNegotiation(negotiationSucceeded(text) ? 2 : 1);
			return;
		}
		if (this.ring.append(text) !== null) this.hooks.onLine();
	}

	private negotiate(ready: string): void {
		if (!offersProtocol2(ready)) {
			this.settleNegotiation(1);
			return;
		}
		this.negotiateTimer = setTimeout(() => {
			this.hooks.log("the child did not answer the protocol negotiation in time; staying on protocol 1");
			this.settleNegotiation(1);
		}, RPC_NEGOTIATE_TIMEOUT_MS);
		this.negotiateTimer.unref();
		const stdin = this.proc.stdin;
		if (stdin === null || stdin.destroyed) {
			this.settleNegotiation(1);
			return;
		}
		stdin.write(NEGOTIATE_LINE, error => {
			if (error) this.settleNegotiation(1);
		});
	}

	private settleNegotiation(protocol: 1 | 2): void {
		if (this.protocol !== null) return;
		if (this.ready === null) return;
		if (this.negotiateTimer !== null) {
			clearTimeout(this.negotiateTimer);
			this.negotiateTimer = null;
		}
		this.protocol = protocol;
		this.gate.resolve();
		this.hooks.onReady(this.ready, protocol);
	}

	private takeStderr(chunk: string): void {
		const combined = this.stderrText + chunk;
		this.stderrText =
			combined.length > PTY_RPC_STDERR_TAIL_BYTES ? combined.slice(combined.length - PTY_RPC_STDERR_TAIL_BYTES) : combined;
		this.hooks.onStderr(chunk);
	}

	private maybeFinish(): void {
		if (this.exitInfo !== null && this.stdoutEnded) this.finish();
	}

	private finish(): void {
		if (this.finished || this.exitInfo === null) return;
		this.finished = true;
		clearTimeout(this.exitTimer);
		if (this.pendingParts.length > 0 && !this.discarding) {
			// The child ended mid-line: what it wrote is a line, not nothing.
			const text = this.pendingParts.join("");
			this.pendingParts = [];
			this.line(text);
		}
		const signal = this.exitInfo.signal === null ? 0 : (osConstants.signals[this.exitInfo.signal] ?? 0);
		this.hooks.onExit({ code: this.exitInfo.code ?? -1, signal });
	}
}

/** `true` when a `ready` line lists protocol 2 among `supportedProtocolVersions`. */
export function offersProtocol2(ready: string): boolean {
	try {
		const parsed: unknown = JSON.parse(ready);
		if (typeof parsed !== "object" || parsed === null || !("supportedProtocolVersions" in parsed)) return false;
		const versions = parsed.supportedProtocolVersions;
		return Array.isArray(versions) && versions.includes(2);
	} catch {
		return false;
	}
}

function negotiationSucceeded(response: string): boolean {
	try {
		const parsed: unknown = JSON.parse(response);
		return typeof parsed === "object" && parsed !== null && "success" in parsed && parsed.success === true;
	} catch {
		return false;
	}
}
