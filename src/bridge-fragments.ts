import { BridgeProtocolError, createToken, isCanonicalToken } from "./bridge-protocol.ts";
import { decodeBase64, encodeBase64 } from "./webview/lib/bytes-base64.ts";

/** One bounded DTO, including the history reader's 64 MiB expanded image budget. */
export const BRIDGE_MAX_MESSAGE_BYTES = 128 * 1024 * 1024;
export const BRIDGE_FRAGMENT_BYTES = 128 * 1024;
export const BRIDGE_FRAGMENT_TIMEOUT_MS = 15_000;
const DIRECT_MESSAGE_BYTES = 48 * 1024;
const MAX_FRAGMENT_PARTS = BRIDGE_MAX_MESSAGE_BYTES / BRIDGE_FRAGMENT_BYTES;
const MAX_BASE64_CHARS = Math.ceil(BRIDGE_FRAGMENT_BYTES / 3) * 4;
const TYPE = "omp:bridge-fragment";

interface Fragment {
	readonly type: typeof TYPE;
	readonly messageId: string;
	readonly routeGeneration: string;
	readonly index: number;
	readonly parts: number;
	readonly totalBytes: number;
	readonly data: string;
}

/** Serialize in a separate scope so the generator does not retain JSON alongside bytes. */
function fragmentedBytes(payload: unknown): Uint8Array | null {
	const json = JSON.stringify(payload);
	if (typeof json !== "string") throw new BridgeProtocolError("malformed", "An outgoing bridge DTO is not JSON.");
	if (json.length > BRIDGE_MAX_MESSAGE_BYTES) throw new BridgeProtocolError("malformed", "A bridge DTO exceeded its byte bound.");
	let byteLength = 0;
	for (let index = 0; index < json.length; index++) {
		const unit = json.charCodeAt(index);
		if (unit <= 0x7f) byteLength += 1;
		else if (unit <= 0x7ff) byteLength += 2;
		else if (unit >= 0xd800 && unit <= 0xdbff && json.charCodeAt(index + 1) >= 0xdc00 && json.charCodeAt(index + 1) <= 0xdfff) {
			byteLength += 4;
			index += 1;
		} else byteLength += 3;
		if (byteLength > BRIDGE_MAX_MESSAGE_BYTES) throw new BridgeProtocolError("malformed", "A bridge DTO exceeded its byte bound.");
	}
	return byteLength <= DIRECT_MESSAGE_BYTES ? null : new TextEncoder().encode(json);
}

/** Produce only one part at a time; callers must await socket drain between parts. */
export function* fragmentBridgeMessage(payload: unknown, routeGeneration: string): Generator<unknown> {
	const bytes = fragmentedBytes(payload);
	if (bytes === null) { yield payload; return; }
	const messageId = createToken();
	const parts = Math.ceil(bytes.length / BRIDGE_FRAGMENT_BYTES);
	for (let index = 0; index < parts; index++) {
		yield { type: TYPE, messageId, routeGeneration, index, parts, totalBytes: bytes.length,
			data: encodeBase64(bytes.subarray(index * BRIDGE_FRAGMENT_BYTES, (index + 1) * BRIDGE_FRAGMENT_BYTES)) } satisfies Fragment;
	}
}

interface PartialMessage {
	readonly messageId: string;
	readonly routeGeneration: string;
	readonly parts: number;
	readonly totalBytes: number;
	readonly chunks: Uint8Array[];
	bytes: number;
}

/** Connection-local reassembly. A partial DTO never reaches the application boundary. */
export class BridgeMessageAssembler {
	#partial: PartialMessage | null = null;
	#timer: NodeJS.Timeout | undefined;
	readonly #onTimeout: () => void;

	constructor(onTimeout: () => void) { this.#onTimeout = onTimeout; }

	reset(): void {
		this.#partial = null;
		clearTimeout(this.#timer);
		this.#timer = undefined;
	}

	accept(payload: unknown, routeGeneration: string | null): unknown | null {
		try { return this.#accept(payload, routeGeneration); }
		catch (error) { this.reset(); throw error; }
	}

	#accept(payload: unknown, routeGeneration: string | null): unknown | null {
		if (payload === null || typeof payload !== "object" || (payload as { type?: unknown }).type !== TYPE) {
			if (this.#partial !== null) this.#refuse();
			return payload;
		}
		const part = payload as Partial<Fragment>;
		if (!isCanonicalToken(part.messageId) || !isCanonicalToken(part.routeGeneration) || part.routeGeneration !== routeGeneration ||
			!Number.isSafeInteger(part.index) || !Number.isSafeInteger(part.parts) || !Number.isSafeInteger(part.totalBytes) ||
			typeof part.index !== "number" || typeof part.parts !== "number" || typeof part.totalBytes !== "number" ||
			part.totalBytes <= 0 || part.totalBytes > BRIDGE_MAX_MESSAGE_BYTES || part.parts < 1 || part.parts > MAX_FRAGMENT_PARTS ||
			part.parts !== Math.ceil(part.totalBytes / BRIDGE_FRAGMENT_BYTES) || part.index < 0 || part.index >= part.parts ||
			typeof part.data !== "string" || part.data.length > MAX_BASE64_CHARS ||
			!/^[A-Za-z0-9+/]*={0,2}$/.test(part.data)) this.#refuse();
		const decoded = decodeBase64(part.data);
		const expectedBytes = Math.min(BRIDGE_FRAGMENT_BYTES, part.totalBytes - part.index * BRIDGE_FRAGMENT_BYTES);
		if (decoded === null || decoded.length !== expectedBytes || encodeBase64(decoded) !== part.data) this.#refuse();
		if (this.#partial === null) {
			if (part.index !== 0) this.#refuse();
			this.#partial = { messageId: part.messageId, routeGeneration: part.routeGeneration, parts: part.parts,
				totalBytes: part.totalBytes, chunks: [], bytes: 0 };
			this.#timer = setTimeout(() => { this.reset(); this.#onTimeout(); }, BRIDGE_FRAGMENT_TIMEOUT_MS);
		}
		const partial = this.#partial;
		if (part.messageId !== partial.messageId || part.routeGeneration !== partial.routeGeneration || part.parts !== partial.parts ||
			part.totalBytes !== partial.totalBytes || part.index !== partial.chunks.length || partial.bytes + decoded.length > partial.totalBytes) this.#refuse();
		partial.chunks.push(decoded);
		partial.bytes += decoded.length;
		if (partial.chunks.length !== partial.parts) return null;
		if (partial.bytes !== partial.totalBytes) this.#refuse();
		const complete = new Uint8Array(partial.totalBytes);
		let offset = 0;
		for (const chunk of partial.chunks) { complete.set(chunk, offset); offset += chunk.length; }
		this.reset();
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(complete)) as unknown;
	}

	#refuse(): never { throw new BridgeProtocolError("malformed", "A fragmented bridge DTO was refused."); }
}
