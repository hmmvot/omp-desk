/**
 * What every attached broker handle shares, whatever its child is.
 *
 * A broker of any kind is authenticated the same way, answers the same `status`, `stop`,
 * `shutdown` and input-ownership requests, and is detached by closing the same socket. Only
 * what flows through the child differs: a terminal handle ({@link PtyHandle} in
 * `pty-client.ts`) reads and writes a screen, an rpc handle (`rpc-handle.ts`) reads and
 * writes JSONL lines. Both extend this class and add their own frames, and a broker refuses
 * the other family's frames with `wrong-kind`, so a handle never has to guess.
 *
 * Requests are correlated by id and answered by frame; events are pushed to subscribers.
 * Nothing here retries a request: a caller that needs to know whether a write reached the
 * child gets the answer, and a refusal is never silently turned into a success.
 */

import { PTY_PROTOCOL_VERSION, isPtyStopResult } from "./pty-protocol.ts";
import type {
	PtyBrokerFrame,
	PtyBrokerRecord,
	PtyKind,
	PtyOwnerStopStatus,
	PtyRefusalCode,
	PtyRequestFrame,
	PtyStatusPayload,
	PtyStopMode,
	PtyStopResult,
} from "./pty-protocol.ts";
import type { PtyClientSideConnection } from "./pty-ipc.ts";

/** Default time to wait for one request's answer. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

/** A refusal the broker gave with a stable code, kept out of the message text. */
export class PtyRequestError extends Error {
	/** The stable code a caller branches on; the message is the broker's detail. */
	readonly code: PtyRefusalCode;

	constructor(code: PtyRefusalCode, detail: string) {
		super(detail);
		this.name = "PtyRequestError";
		this.code = code;
	}
}

export interface PtyInputOwnerResult {
	readonly frontendId: string | null;
	readonly previous: string | null;
}

export interface PtyShutdownResult {
	readonly stopped: boolean;
}

/** Events every handle pushes without being asked. */
export type BrokerHandleEvent =
	| { readonly type: "state"; readonly status: PtyStatusPayload }
	| { readonly type: "input-owner"; readonly frontendId: string | null; readonly previous: string | null }
	| { readonly type: "owner-stop"; readonly status: PtyOwnerStopStatus }
	| { readonly type: "closed"; readonly reason: string };

/** Where a snapshot's chunked answer is assembled while it arrives (terminal handles only). */
export interface SnapshotCollector {
	/** The `snapshot` frame that opened this answer, which is what settles it. */
	opened: Extract<PtyBrokerFrame, { readonly t: "snapshot" }> | null;
	readonly parts: string[];
	received: number;
}

interface PendingRequest {
	readonly resolve: (frame: PtyBrokerFrame) => void;
	readonly reject: (error: Error) => void;
	readonly timer: NodeJS.Timeout;
	readonly snapshot: SnapshotCollector | null;
}

export class BrokerHandle<Event = BrokerHandleEvent> {
	protected readonly pending = new Map<number, PendingRequest>();
	protected readonly listeners: Array<(event: Event) => void> = [];
	protected nextRequestId = 1;
	protected closedReason: string | null = null;
	protected lastStatus: PtyStatusPayload | null = null;
	protected connection: PtyClientSideConnection;
	protected readonly requestTimeoutMs: number;
	/** The record this handle was opened from. */
	readonly record: PtyBrokerRecord;
	/** `true` when the broker was already running when this client found it. */
	readonly adopted: boolean;
	/** `true` when the broker runs this build's staged runtime tree. */
	readonly buildMatches: boolean;

	constructor(
		connection: PtyClientSideConnection,
		record: PtyBrokerRecord,
		adopted: boolean,
		buildMatches: boolean,
		requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
	) {
		this.connection = connection;
		this.record = record;
		this.adopted = adopted;
		this.buildMatches = buildMatches;
		this.requestTimeoutMs = requestTimeoutMs;
		this.listen(connection);
	}

	get slot(): string {
		return this.record.slot;
	}

	get kind(): PtyKind {
		return this.record.kind;
	}

	get brokerPid(): number {
		return this.record.brokerPid;
	}

	/** The child's pid — the process OMP's own registry reports, never the broker's. */
	get nativePid(): number | null {
		return this.lastStatus?.nativePid ?? null;
	}

	get nativeCreationTime(): string | null {
		return this.lastStatus?.nativeCreationTime ?? null;
	}

	get state(): "running" | "exited" | null {
		return this.lastStatus?.state ?? null;
	}

	get closed(): boolean {
		return this.closedReason !== null;
	}

	/** The last status the broker reported, or `null` before the first one arrives. */
	get statusValue(): PtyStatusPayload | null {
		return this.lastStatus;
	}

	/** Ask the broker for its current state and remember it. */
	async refreshStatus(): Promise<PtyStatusPayload> {
		const frame = await this.request({ v: PTY_PROTOCOL_VERSION, t: "status", id: 0 });
		if (frame.t !== "status") throw new Error("the broker did not answer with a status");
		this.lastStatus = frame.status;
		return frame.status;
	}

	subscribe(listener: (event: Event) => void): () => void {
		this.listeners.push(listener);
		return () => {
			const index = this.listeners.indexOf(listener);
			if (index >= 0) this.listeners.splice(index, 1);
		};
	}

	/**
	 * Take input ownership.
	 *
	 * Refused when another frontend holds it unless `takeover` is set; the previous
	 * owner and every other attached frontend are told either way, so a stale renderer
	 * stops being able to type.
	 */
	async claimInput(frontendId: string, options: { readonly takeover?: boolean } = {}): Promise<PtyInputOwnerResult> {
		const frame = await this.request({
			v: PTY_PROTOCOL_VERSION,
			t: "claim-input",
			id: 0,
			frontendId,
			takeover: options.takeover === true,
		});
		if (frame.t === "ack") this.requireAck(frame);
		if (frame.t !== "input-owner") throw new Error("the broker did not answer the input claim");
		return { frontendId: frame.frontendId, previous: frame.previous };
	}

	async releaseInput(frontendId: string): Promise<void> {
		const frame = await this.request({ v: PTY_PROTOCOL_VERSION, t: "release-input", id: 0, frontendId });
		if (frame.t === "ack") this.requireAck(frame);
		if (frame.t === "input-owner" && frame.frontendId !== null) {
			throw new Error("the broker did not release input ownership");
		}
	}

	/**
	 * Attempt to stop the child and return the broker's observed verdict unchanged.
	 *
	 * A pseudo-console child is stopped by closing the console; an rpc child gracefully by
	 * closing its stdin, and by termination of the exact process on `force`. Neither proves
	 * that escaped descendants are gone.
	 */
	async stop(options: { readonly mode?: PtyStopMode; readonly timeoutMs?: number } = {}): Promise<PtyStopResult> {
		const mode: PtyStopMode = options.mode ?? "graceful";
		const timeoutMs = options.timeoutMs ?? 20_000;
		const frame = await this.request(
			{ v: PTY_PROTOCOL_VERSION, t: "stop", id: 0, mode, timeoutMs },
			timeoutMs + DEFAULT_REQUEST_TIMEOUT_MS,
		);
		if (frame.t !== "stopped" || !isPtyStopResult(frame.result)) {
			throw new Error("the broker did not answer with a stop result");
		}
		await this.refreshStatus().catch(() => undefined);
		return frame.result;
	}

	/**
	 * Ask the broker to go away.
	 *
	 * Refused while the child is not proven gone unless `requireStopped` is false, so a
	 * caller cannot make a running writer unfindable by accident. Proven gone means the
	 * child's exit event arrived, or a stop proved this exact process generation absent
	 * from the kernel.
	 */
	async shutdown(options: { readonly requireStopped?: boolean } = {}): Promise<PtyShutdownResult> {
		const frame = await this.request({
			v: PTY_PROTOCOL_VERSION,
			t: "shutdown",
			id: 0,
			requireStopped: options.requireStopped !== false,
		});
		if (frame.t === "ack") this.requireAck(frame);
		if (frame.t !== "shutdown-ok") throw new Error("the broker did not answer the shutdown request");
		return { stopped: frame.stopped };
	}

	/** Detach this window. The broker and its child keep running. */
	disconnect(): void {
		this.connection.close("detached by the client");
	}

	/** Route one connection's frames and closure to this handle; a replaced connection is ignored. */
	protected listen(connection: PtyClientSideConnection): void {
		connection.onFrame(frame => {
			if (connection === this.connection) this.handleFrame(frame);
		});
		connection.onClosed(reason => {
			if (connection !== this.connection) return;
			this.closedReason = reason;
			for (const pending of this.pending.values()) {
				clearTimeout(pending.timer);
				pending.reject(new Error(`the broker connection closed: ${reason}`));
			}
			this.pending.clear();
			this.connectionClosed(reason);
		});
	}

	/** The connection ended: tell subscribers. A subclass adds its own consequences. */
	protected connectionClosed(reason: string): void {
		this.emit({ type: "closed", reason } as Event);
	}

	protected emit(event: Event): void {
		for (const listener of this.listeners) listener(event);
	}

	protected foldOwnerStatus(status: PtyOwnerStopStatus): void {
		if (this.lastStatus !== null) this.lastStatus = { ...this.lastStatus, ownerStop: status };
		this.emit({ type: "owner-stop", status } as Event);
	}

	protected requireAck(frame: PtyBrokerFrame): void {
		if (frame.t !== "ack") throw new Error("the broker did not answer with an acknowledgement");
		if (!frame.ok) {
			throw new PtyRequestError(frame.code ?? "internal", frame.detail ?? "the broker refused the request");
		}
	}

	protected request(
		body: PtyRequestFrame,
		timeoutMs = this.requestTimeoutMs,
		snapshot: SnapshotCollector | null = null,
	): Promise<PtyBrokerFrame> {
		if (this.closedReason !== null) {
			return Promise.reject(new Error(`the broker connection is closed: ${this.closedReason}`));
		}
		const id = this.nextRequestId;
		this.nextRequestId += 1;
		const { promise, resolve, reject } = Promise.withResolvers<PtyBrokerFrame>();
		const timer = setTimeout(() => {
			this.pending.delete(id);
			reject(new Error(`the broker did not answer a ${body.t} request within ${timeoutMs}ms`));
		}, timeoutMs);
		timer.unref();
		this.pending.set(id, { resolve, reject, timer, snapshot });
		this.connection.send({ ...body, id });
		return promise;
	}

	protected settle(id: number, frame: PtyBrokerFrame): void {
		const pending = this.pending.get(id);
		if (pending === undefined) return;
		this.pending.delete(id);
		clearTimeout(pending.timer);
		pending.resolve(frame);
	}

	/**
	 * The frames every kind of broker answers or pushes. A subclass handles its own frames
	 * and passes the rest here.
	 */
	protected handleFrame(frame: PtyBrokerFrame): void {
		switch (frame.t) {
			case "state":
				this.lastStatus = frame.status;
				this.emit({ type: "state", status: frame.status } as Event);
				return;
			case "input-owner":
				this.lastStatus = this.lastStatus === null ? null : { ...this.lastStatus, inputOwner: frame.frontendId };
				this.emit({ type: "input-owner", frontendId: frame.frontendId, previous: frame.previous } as Event);
				// An input claim answers the request that asked for it; a broadcast has no
				// pending request and is only an event.
				this.settle(frame.id, frame);
				return;
			case "status":
				this.lastStatus = frame.status;
				this.settle(frame.id, frame);
				return;
			case "owner-stop":
				// The answer to an `admit-owner` and the push after a transition are the
				// same shape: fold it either way, so no attached client keeps a stale state.
				this.foldOwnerStatus(frame.status);
				this.settle(frame.id, frame);
				return;
			case "ack":
			case "stopped":
			case "shutdown-ok":
				this.settle(frame.id, frame);
				return;
			default:
				// The broker never sends a request frame to a client, and a frame of another
				// family is not this handle's to act on; ignore both.
				return;
		}
	}
}
