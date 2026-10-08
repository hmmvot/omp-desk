/**
 * Client-side rpc-ui framing: newline splitting on UTF-8 boundaries, per-line `JSON.parse`, and a reimplementation
 * of OMP's protocol v2 `rpc_chunk` reassembly (`rpc-frame.ts` `RpcFrameDecoder`; the installed package cannot be
 * imported). Errors are counted and bounded diagnostics, never fatal: the session resyncs instead.
 */
import { isRecord } from "../../guards.ts";

/** Maximum UTF-8 size of one physical frame line (OMP `MAX_RPC_FRAME_BYTES`). */
export const MAX_RPC_FRAME_BYTES = 1024 * 1024;
/** Maximum UTF-8 size of one logical frame reassembled from chunks (OMP `MAX_RPC_REASSEMBLED_BYTES`). */
export const MAX_RPC_REASSEMBLED_BYTES = 64 * 1024 * 1024;
/** Largest raw payload of one chunk (OMP `RPC_CHUNK_PAYLOAD_BYTES`). */
export const RPC_CHUNK_PAYLOAD_BYTES = 256 * 1024;

const NEWLINE = 0x0a;

/**
 * Splits a byte stream into UTF-8 lines. The split happens on the `0x0a` byte, before decoding, so a multi-byte
 * character straddling two chunks is never cut. A line longer than `maxLineBytes` is dropped whole (up to its
 * newline) and counted.
 */
export class Utf8LineSplitter {
	readonly #maxLineBytes: number;
	#parts: Buffer[] = [];
	#pendingBytes = 0;
	#discarding = false;
	#oversizeLines = 0;

	constructor(maxLineBytes: number = MAX_RPC_FRAME_BYTES * 2) {
		this.#maxLineBytes = maxLineBytes;
	}

	/** Lines dropped for exceeding the bound. */
	get oversizeLines(): number {
		return this.#oversizeLines;
	}

	/** Feed bytes; returns every line completed by them (no trailing `\n`/`\r`). */
	push(chunk: Uint8Array): string[] {
		const lines: string[] = [];
		let buffer = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
		while (buffer.length > 0) {
			const end = buffer.indexOf(NEWLINE);
			if (end < 0) {
				this.#hold(buffer);
				break;
			}
			const head = buffer.subarray(0, end);
			buffer = buffer.subarray(end + 1);
			if (this.#discarding) {
				this.#discarding = false;
				this.#parts = [];
				this.#pendingBytes = 0;
				continue;
			}
			if (this.#pendingBytes + head.length > this.#maxLineBytes) {
				this.#oversizeLines += 1;
				this.#parts = [];
				this.#pendingBytes = 0;
				continue;
			}
			const whole = this.#parts.length === 0 ? head : Buffer.concat([...this.#parts, head]);
			this.#parts = [];
			this.#pendingBytes = 0;
			const line = new TextDecoder("utf-8").decode(whole);
			lines.push(line.endsWith("\r") ? line.slice(0, -1) : line);
		}
		return lines;
	}

	/** Forget any partial line (a reattach starts on a line boundary). */
	reset(): void {
		this.#parts = [];
		this.#pendingBytes = 0;
		this.#discarding = false;
	}

	#hold(buffer: Buffer): void {
		if (this.#discarding) return;
		if (this.#pendingBytes + buffer.length > this.#maxLineBytes) {
			this.#oversizeLines += 1;
			this.#discarding = true;
			this.#parts = [];
			this.#pendingBytes = 0;
			return;
		}
		// Copy: the caller may reuse the chunk's memory.
		this.#parts.push(Buffer.from(buffer));
		this.#pendingBytes += buffer.length;
	}
}

interface PendingChunks {
	chunkId: string;
	count: number;
	byteLength: number;
	nextIndex: number;
	chunks: Buffer[];
	receivedBytes: number;
}

function decodeBase64(data: unknown): Buffer {
	if (
		typeof data !== "string" ||
		data.length === 0 ||
		!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)
	) {
		throw new Error("invalid rpc chunk data");
	}
	const bytes = Buffer.from(data, "base64");
	if (bytes.toString("base64") !== data) throw new Error("invalid rpc chunk data");
	return bytes;
}

/**
 * Reassembles v2 chunk trains. Throws on any violation of OMP's contract (interleaving, bad metadata, strict base64,
 * declared length, cap). After a throw the decoder holds no partial train.
 */
export class RpcFrameDecoder {
	#pending: PendingChunks | undefined;

	/** True while a chunk train is open. */
	get inTrain(): boolean {
		return this.#pending !== undefined;
	}

	/** Drop any partial train. */
	reset(): void {
		this.#pending = undefined;
	}

	/** Returns the frame, or `undefined` while a train is incomplete. */
	push(value: unknown): Record<string, unknown> | undefined {
		if (!isRecord(value) || value.type !== "rpc_chunk") {
			if (this.#pending !== undefined) {
				this.#pending = undefined;
				throw new Error("rpc chunk sequence interrupted");
			}
			if (!isRecord(value)) throw new Error("rpc frame must be an object");
			return value;
		}
		try {
			return this.#pushChunk(value);
		} catch (error) {
			this.#pending = undefined;
			throw error;
		}
	}

	#pushChunk(value: Record<string, unknown>): Record<string, unknown> | undefined {
		const { chunkId, index, count, byteLength } = value;
		if (
			typeof chunkId !== "string" ||
			chunkId.length === 0 ||
			chunkId.length > 128 ||
			typeof index !== "number" ||
			typeof count !== "number" ||
			typeof byteLength !== "number" ||
			!Number.isSafeInteger(index) ||
			!Number.isSafeInteger(count) ||
			!Number.isSafeInteger(byteLength) ||
			index < 0 ||
			count < 2 ||
			count > Math.ceil(MAX_RPC_REASSEMBLED_BYTES / RPC_CHUNK_PAYLOAD_BYTES) ||
			index >= count ||
			byteLength < MAX_RPC_FRAME_BYTES ||
			byteLength > MAX_RPC_REASSEMBLED_BYTES
		) {
			throw new Error("invalid rpc chunk metadata");
		}
		const bytes = decodeBase64(value.data);
		if (bytes.byteLength > RPC_CHUNK_PAYLOAD_BYTES) throw new Error("rpc chunk payload exceeds the transport limit");
		if (this.#pending === undefined) {
			if (index !== 0) throw new Error("rpc chunk sequence must start at index 0");
			this.#pending = { chunkId, count, byteLength, nextIndex: 0, chunks: [], receivedBytes: 0 };
		}
		const pending = this.#pending;
		if (
			pending.chunkId !== chunkId ||
			pending.count !== count ||
			pending.byteLength !== byteLength ||
			pending.nextIndex !== index
		) {
			throw new Error("rpc chunk sequence mismatch");
		}
		pending.chunks.push(bytes);
		pending.receivedBytes += bytes.byteLength;
		pending.nextIndex += 1;
		if (pending.receivedBytes > pending.byteLength) throw new Error("rpc chunk sequence exceeds declared length");
		if (pending.nextIndex < pending.count) return undefined;
		if (pending.receivedBytes !== pending.byteLength) throw new Error("rpc chunk sequence length mismatch");
		this.#pending = undefined;
		const decoded = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(pending.chunks));
		const frame: unknown = JSON.parse(decoded);
		if (!isRecord(frame)) throw new Error("rpc frame must be an object");
		return frame;
	}
}

export type RpcReadResult =
	| { kind: "frame"; frame: Record<string, unknown> }
	/** A chunk of an unfinished train, or a chunk dropped while waiting for a train start. */
	| { kind: "none" }
	/** A line that is not JSON at all (stray stdout from a third-party extension). */
	| { kind: "stray" }
	/** A JSON-looking line that failed to parse, or a chunk-contract violation: the caller resyncs. */
	| { kind: "error"; error: "parse" | "chunk" };

export interface RpcFrameCounters {
	frames: number;
	strayLines: number;
	parseErrors: number;
	chunkErrors: number;
	droppedChunks: number;
}

/**
 * Line → frame reader. `JSON.parse` per line, chunk reassembly, and the reattach rule: after {@link reset} chunk
 * lines are dropped until an index-0 chunk, because a reattach can begin mid-train (chunk lines are not retained
 * by the broker). Counters are bounded integers; no line text is retained.
 */
export class RpcFrameReader {
	readonly #decoder = new RpcFrameDecoder();
	#awaitingTrainStart = true;
	#counters: RpcFrameCounters = { frames: 0, strayLines: 0, parseErrors: 0, chunkErrors: 0, droppedChunks: 0 };

	get counters(): Readonly<RpcFrameCounters> {
		return this.#counters;
	}

	/** Start of an attach generation: no train is open and mid-train chunks are ignored until index 0. */
	reset(): void {
		this.#decoder.reset();
		this.#awaitingTrainStart = true;
	}

	pushLine(line: string): RpcReadResult {
		if (line.length === 0) return { kind: "stray" };
		if (line.charCodeAt(0) !== 0x7b /* { */) {
			this.#counters.strayLines += 1;
			return { kind: "stray" };
		}
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			this.#counters.parseErrors += 1;
			this.#decoder.reset();
			return { kind: "error", error: "parse" };
		}
		if (this.#awaitingTrainStart && isRecord(value) && value.type === "rpc_chunk") {
			if (value.index !== 0) {
				this.#counters.droppedChunks += 1;
				return { kind: "none" };
			}
			this.#awaitingTrainStart = false;
		} else if (isRecord(value) && value.type !== "rpc_chunk") {
			this.#awaitingTrainStart = false;
		}
		try {
			const frame = this.#decoder.push(value);
			if (frame === undefined) return { kind: "none" };
			this.#counters.frames += 1;
			return { kind: "frame", frame };
		} catch {
			this.#counters.chunkErrors += 1;
			this.#awaitingTrainStart = true;
			return { kind: "error", error: "chunk" };
		}
	}
}
