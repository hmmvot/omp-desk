/**
 * The extension host's handle on a `managed-rpc` broker (ADR-0038).
 *
 * It sits beside `PtyHandle` and shares its authentication, framing and MACs through
 * {@link BrokerHandle}; what differs is what flows through the child. The child speaks
 * `omp --mode rpc-ui` JSONL, so this handle turns the broker's `rpc-line` fragments back
 * into whole stdout lines and a caller's line into `rpc-write` fragments, and implements the
 * `RpcChannel` port `RpcSession` is written against.
 *
 * - **Lines.** Fragments of one line are contiguous and reassembled here, bytes before
 *   decoding. The broker sends every attach from index 0 of a line, so the assembler is
 *   reset on each attach answer; a protocol error closes the connection (the session
 *   reattaches with its last `seq`) rather than guessing where a line began.
 * - **Writes.** One line at a time (fragments of two lines must not interleave), paced on the
 *   connection's send queue so a multi-MiB image line can never trip the queue bound. The
 *   broker acknowledges only the last fragment, or the first refusal.
 * - **Negotiation** is the broker's job: it negotiates protocol 2 once, on `ready`, and this
 *   handle never sends `negotiate_protocol`. `ready` and the protocol come back on every
 *   attach, and a `ready` that arrives later is delivered as a `line` event.
 * - **Input.** The handle claims input on attach without takeover. Only the input owner may
 *   write; a window that lost the claim reads, and its writes are refused `input-not-owner`.
 */

import { randomBytes } from "node:crypto";
import { BrokerHandle, PtyRequestError, type BrokerHandleEvent } from "./broker-handle.ts";
import { PTY_PROTOCOL_VERSION, PTY_RPC_MAX_WRITE_BYTES, PtyProtocolError, PtyRpcFragmentAssembler, ptyRpcFragment, ptyRpcFragmentCount } from "./pty-protocol.ts";
import type { PtyBrokerFrame, PtyBrokerRecord, PtyStatusPayload, PtyStopMode, PtyStopResult } from "./pty-protocol.ts";
import type { PtyClientSideConnection } from "./pty-ipc.ts";
import type { RpcAttachResult, RpcChannel, RpcChannelEvent, RpcChildStatus } from "./rpc/protocol.ts";

/** How long one line write waits for the broker's acknowledgement. */
const WRITE_TIMEOUT_MS = 60_000;

/** Stop queueing fragments once this many bytes are unflushed; resume on drain. */
const WRITE_PACE_BYTES = 2 * 1024 * 1024;

/** How long to wait between reads of the child's identity. */
const IDENTITY_POLL_MS = 250;

/** Opens a fresh, verified connection to the same broker; supplied by the client that made this handle. */
export type RpcReconnect = () => Promise<PtyClientSideConnection>;

/** A stdin line that could not be written, with the stable `code` `RpcSession` branches on. */
export class RpcWriteError extends Error {
	readonly code: "input-not-owner" | "child-exited" | "line-too-long" | "closed";

	constructor(code: RpcWriteError["code"], message: string) {
		super(message);
		this.name = "RpcWriteError";
		this.code = code;
	}
}

/** The port's view of the broker's status payload. */
export function childStatusOf(status: PtyStatusPayload): RpcChildStatus {
	return {
		state: status.state,
		pid: status.nativePid > 0 ? status.nativePid : null,
		exitCode: status.exitCode,
	};
}

export class RpcHandle extends BrokerHandle<BrokerHandleEvent> implements RpcChannel {
	/** Names this frontend as the input owner; unique per handle. */
	readonly frontendId = `rpc:${randomBytes(9).toString("base64url")}`;
	private readonly reconnectConnection: RpcReconnect;
	private readonly channelListeners: Array<(event: RpcChannelEvent) => void> = [];
	private readonly assembler = new PtyRpcFragmentAssembler(16 * 1024 * 1024);
	private readonly drainWaiters: Array<() => void> = [];
	private writeChain: Promise<void> = Promise.resolve();
	private writeCounter = 0;
	private reconnecting: Promise<void> | null = null;
	private lastLineSeq = 0;
	private ownsInput = false;
	private stopRequested = false;
	private channelClosed = false;
	private readyLine: string | null = null;
	private protocol: 1 | 2 | null = null;

	constructor(
		connection: PtyClientSideConnection,
		record: PtyBrokerRecord,
		adopted: boolean,
		buildMatches: boolean,
		reconnect: RpcReconnect,
	) {
		super(connection, record, adopted, buildMatches);
		this.reconnectConnection = reconnect;
	}

	/** Whether this handle held input the last time it claimed it. */
	get inputOwned(): boolean {
		return this.ownsInput;
	}

	/** The protocol the broker negotiated with the child, once known. */
	get rpcProtocol(): 1 | 2 | null {
		return this.protocol;
	}

	onEvent(listener: (event: RpcChannelEvent) => void): () => void {
		this.channelListeners.push(listener);
		return () => {
			const index = this.channelListeners.indexOf(listener);
			if (index >= 0) this.channelListeners.splice(index, 1);
		};
	}

	async attach(request: { readonly sinceSeq: number }): Promise<RpcAttachResult> {
		if (this.closedReason !== null) await this.reconnect();
		this.channelClosed = false;
		await this.claim();
		const frame = await this.request({ v: PTY_PROTOCOL_VERSION, t: "rpc-attach", id: 0, sinceSeq: request.sinceSeq });
		if (frame.t !== "rpc-attached") throw new Error("the broker did not answer with an rpc attach result");
		return {
			fromSeq: frame.fromSeq,
			oldestSeq: frame.oldestSeq,
			latestSeq: frame.latestSeq,
			truncated: frame.truncated,
			pinnedOverflow: frame.pinnedOverflow,
			rpcProtocol: frame.rpcProtocol,
			ready: frame.ready,
			child: childStatusOf(frame.child),
		};
	}

	/**
	 * Write one whole stdin line. Writes are serialized and their fragments paced; the
	 * promise settles when the broker has handed the line to the child's pipe, and rejects
	 * with an {@link RpcWriteError} otherwise.
	 */
	writeLine(line: string): Promise<void> {
		const bytes = Buffer.from(line, "utf8");
		if (bytes.length > PTY_RPC_MAX_WRITE_BYTES) {
			return Promise.reject(new RpcWriteError("line-too-long", "the line is longer than the broker accepts"));
		}
		const written = this.writeChain.then(() => this.sendLine(bytes));
		this.writeChain = written.catch(() => undefined);
		return written;
	}

	/**
	 * Stop the child. Graceful closes its stdin, so OMP aborts a running turn, persists it and
	 * exits; `force` terminates the exact process. The channel reports `stopped` once the
	 * broker proved the process gone.
	 */
	async stop(options: { readonly mode?: PtyStopMode; readonly timeoutMs?: number } = {}): Promise<PtyStopResult> {
		this.stopRequested = true;
		try {
			const result = await super.stop(options);
			if (!result.pidGone) this.stopRequested = false;
			return result;
		} catch (error) {
			this.stopRequested = false;
			throw error;
		}
	}

	/**
	 * Wait, bounded, until the broker reports the child's kernel creation time (it reads it
	 * from the process table just after the spawn) or the child is gone. Never throws for a
	 * missing identity: a caller that needs one checks {@link nativeCreationTime}.
	 */
	async awaitChildIdentity(timeoutMs: number): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (this.nativeCreationTime === null && this.state !== "exited" && Date.now() < deadline) {
			await new Promise<void>(resolve => {
				const timer = setTimeout(resolve, IDENTITY_POLL_MS);
				timer.unref();
			});
			await this.refreshStatus();
		}
	}

	protected listen(connection: PtyClientSideConnection): void {
		connection.onDrain(() => {
			for (const waiter of this.drainWaiters.splice(0)) waiter();
		});
		super.listen(connection);
	}

	protected connectionClosed(reason: string): void {
		super.connectionClosed(reason);
		for (const waiter of this.drainWaiters.splice(0)) waiter();
		this.assembler.reset();
		this.closeChannel("disconnected");
	}

	protected handleFrame(frame: PtyBrokerFrame): void {
		switch (frame.t) {
			case "rpc-attached":
				// Every attach starts a fresh line, so a half-assembled one belongs to the old cursor.
				this.assembler.reset();
				this.lastStatus = frame.child;
				this.readyLine = frame.ready;
				this.protocol = frame.rpcProtocol;
				this.settle(frame.id, frame);
				return;
			case "rpc-line":
				this.takeFragment(frame.lineSeq, frame.index, frame.count, frame.data);
				return;
			case "rpc-ready":
				// `ready` is not a ring line: the broker returns it on attach, and pushes it once when
				// it arrives later. It has no seq, so it travels as its own event.
				this.readyLine = frame.ready;
				this.protocol = frame.rpcProtocol;
				this.emitChannel({ type: "ready", line: frame.ready, rpcProtocol: frame.rpcProtocol });
				return;
			case "rpc-stderr":
				this.emitChannel({ type: "stderr", text: frame.data });
				return;
			case "state": {
				super.handleFrame(frame);
				this.emitChannel({ type: "child", status: childStatusOf(frame.status) });
				if (frame.status.state === "exited") this.closeChannel(this.stopRequested ? "stopped" : "child-exited");
				return;
			}
			default:
				super.handleFrame(frame);
		}
	}

	private takeFragment(seq: number, index: number, count: number, data: string): void {
		let bytes: Buffer | null;
		try {
			bytes = this.assembler.push(seq, index, count, data);
		} catch (error) {
			if (error instanceof PtyProtocolError) {
				// The stream lost its framing; the session reattaches with its last seq.
				this.connection.close("the broker's line fragments were not contiguous");
				return;
			}
			throw error;
		}
		if (bytes === null) return;
		if (seq > this.lastLineSeq) this.lastLineSeq = seq;
		this.emitChannel({ type: "line", seq, line: bytes.toString("utf8") });
	}

	private emitChannel(event: RpcChannelEvent): void {
		for (const listener of [...this.channelListeners]) listener(event);
	}

	private closeChannel(reason: "child-exited" | "disconnected" | "stopped"): void {
		if (this.channelClosed) return;
		this.channelClosed = true;
		this.emitChannel({ type: "closed", reason });
	}

	/** Claim input without takeover; losing the claim is a state (reads work, writes are refused). */
	private async claim(): Promise<void> {
		try {
			await this.claimInput(this.frontendId);
			this.ownsInput = true;
		} catch (error) {
			if (error instanceof PtyRequestError && error.code === "input-not-owner") {
				this.ownsInput = false;
				return;
			}
			throw error;
		}
	}

	private reconnect(): Promise<void> {
		this.reconnecting ??= (async () => {
			try {
				const connection = await this.reconnectConnection();
				this.connection = connection;
				this.closedReason = null;
				this.assembler.reset();
				this.listen(connection);
				await this.refreshStatus();
			} finally {
				this.reconnecting = null;
			}
		})();
		return this.reconnecting;
	}

	private async sendLine(bytes: Buffer): Promise<void> {
		if (this.closedReason !== null) throw new RpcWriteError("closed", "the broker connection is closed");
		this.writeCounter += 1;
		const writeId = `w${this.writeCounter}-${randomBytes(4).toString("hex")}`;
		const count = ptyRpcFragmentCount(bytes.length);
		const ids: number[] = [];
		for (let index = 0; index < count; index += 1) {
			ids.push(this.nextRequestId);
			this.nextRequestId += 1;
		}
		const { promise, resolve, reject } = Promise.withResolvers<PtyBrokerFrame>();
		const cleanup = (): void => {
			for (const id of ids) this.pending.delete(id);
		};
		const timer = setTimeout(() => {
			cleanup();
			reject(new RpcWriteError("closed", `the broker did not acknowledge a line within ${WRITE_TIMEOUT_MS}ms`));
		}, WRITE_TIMEOUT_MS);
		timer.unref();
		// One entry answers for every fragment: the broker acknowledges the last one, or the
		// first it refuses, and either settles the whole line.
		const entry = {
			resolve: (frame: PtyBrokerFrame) => {
				cleanup();
				resolve(frame);
			},
			reject: (error: Error) => {
				cleanup();
				reject(error);
			},
			timer,
			snapshot: null,
		};
		for (const id of ids) this.pending.set(id, entry);
		// The answer is awaited below; a rejection that lands while fragments are still being
		// queued must not surface as unhandled.
		promise.catch(() => undefined);
		try {
			for (let index = 0; index < count; index += 1) {
				await this.paced();
				const id = ids[index];
				if (id === undefined || !this.pending.has(id)) break;
				this.connection.send({
					v: PTY_PROTOCOL_VERSION,
					t: "rpc-write",
					id,
					frontendId: this.frontendId,
					writeId,
					index,
					count,
					data: ptyRpcFragment(bytes, index),
				});
			}
		} catch (error) {
			clearTimeout(timer);
			cleanup();
			throw error;
		}
		let answer: PtyBrokerFrame;
		try {
			answer = await promise;
		} catch (error) {
			throw new RpcWriteError("closed", error instanceof Error ? error.message : "the broker connection closed");
		}
		if (answer.t === "ack" && answer.ok) return;
		if (answer.t === "ack" && answer.code !== undefined) {
			throw new RpcWriteError(writeCodeOf(answer.code), answer.detail ?? "the broker refused the line");
		}
		throw new RpcWriteError("closed", "the broker did not acknowledge the line");
	}

	/** Wait, if the connection's queue is over the pacing bound, for it to drain (or the connection to close). */
	private async paced(): Promise<void> {
		while (this.closedReason === null && this.connection.pendingBytes >= WRITE_PACE_BYTES) {
			await new Promise<void>(resolve => this.drainWaiters.push(resolve));
		}
		if (this.closedReason !== null) throw new RpcWriteError("closed", "the broker connection is closed");
	}
}

function writeCodeOf(code: string): RpcWriteError["code"] {
	switch (code) {
		case "input-not-owner":
		case "no-input-owner":
			return "input-not-owner";
		case "child-exited":
			return "child-exited";
		case "line-too-long":
		case "frame-too-large":
			return "line-too-long";
		default:
			return "closed";
	}
}
