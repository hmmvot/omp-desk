/**
 * Wire protocol v1 for the authenticated host bridge (ADR-0023, accepted design
 * `docs/designs/2026-09-25-reconnect-live-webviews-after-host-restart.md`).
 *
 * A surviving Webview page opens one WebSocket to `127.0.0.1:<recorded port>` on
 * the exact path below after the extension host is replaced. The page proves
 * knowledge of a per-document secret `K` (never persisted in Webview state, a
 * URL or a log) with an HMAC challenge/response over a transcript that
 * names every identity the connection is pinned to, and then exchanges
 * sequenced, encrypted frames.
 *
 * This module is deliberately environment-neutral and imports nothing: the
 * extension host and the guest bundle must run *the same* algorithm, and the
 * installed Webview's WebCrypto must produce byte-identical results (checked
 * against the deterministic vectors in the tests and against Node). All crypto
 * goes through `globalThis.crypto.subtle`, which both environments provide.
 *
 * Two rules the rest of the bridge relies on:
 *
 * - `A(x)` (`transcript`) is a *validated* encoding. Every field must be a
 *   fixed-length canonical ASCII string (or a safe non-negative integer), binary
 *   values must be canonical unpadded base64url that re-encodes to exactly the
 *   same text, and a parsed handshake must have exactly the expected field count.
 *   An extra field, a padded or non-canonical base64url value, or a non-ASCII
 *   string is a refusal, not a value to normalise.
 * - every direction has its own sequence, starting at zero, and a frame is
 *   accepted only when it is exactly the next one. A gap, a repeat, a reflected
 *   direction or a failed tag closes the connection; nothing is resynchronised.
 */

/** Wire version of every message in this protocol. */
export const BRIDGE_PROTOCOL_VERSION = 1;

/** The only path the bridge listener upgrades on its exact host. */
export const BRIDGE_PATH = "/omp-webview/v1/bridge";

/** First element of the handshake transcript; distinguishes it from any other HMAC use. */
export const BRIDGE_TRANSCRIPT_TAG = "omp-webview-bridge";

/** Direction markers inside the frame header. */
export const BRIDGE_DIRECTION_CLIENT_TO_SERVER = 0;
export const BRIDGE_DIRECTION_SERVER_TO_CLIENT = 1;

/** HKDF `info` strings: separate keys per direction, never one key both ways. */
export const BRIDGE_KEY_INFO_CLIENT_TO_SERVER = "omp-webview-bridge/v1/c2s";
export const BRIDGE_KEY_INFO_SERVER_TO_CLIENT = "omp-webview-bridge/v1/s2c";

/** Field counts; a handshake array with any other length is refused. */
export const BRIDGE_HELLO_FIELDS = 8;
export const BRIDGE_CHALLENGE_FIELDS = 6;
export const BRIDGE_PROOF_FIELDS = 3;
export const BRIDGE_READY_FIELDS = 4;
/** Fields in one host→guest terminal push: kind, host generation, document, payload. */
export const BRIDGE_TERMINAL_FIELDS = 4;

/** Byte and time limits the listener enforces before it trusts anything. */
export const BRIDGE_MAX_HTTP_HEADER_BYTES = 8 * 1024;
export const BRIDGE_MAX_HANDSHAKE_BYTES = 4 * 1024;
export const BRIDGE_HANDSHAKE_TIMEOUT_MS = 5000;
export const BRIDGE_MAX_FRAME_BYTES = 256 * 1024 + 22;
export const BRIDGE_MAX_PLAINTEXT_BYTES = 256 * 1024;
export const BRIDGE_MAX_QUEUED_OUTBOUND_BYTES = 1024 * 1024;
export const BRIDGE_MAX_MESSAGES_BEFORE_RECONNECT = 1 << 20;
export const BRIDGE_HEARTBEAT_MS = 15_000;
export const BRIDGE_IDLE_DISCONNECT_MS = 45_000;
export const BRIDGE_MAX_NESTING = 16;
export const BRIDGE_MAX_UNAUTHENTICATED_SOCKETS = 16;
export const BRIDGE_MAX_UNAUTHENTICATED_SOCKETS_PER_LISTENER = 2;
export const BRIDGE_MAX_OUTSTANDING_READS = 8;

/** Field widths. */
export const BRIDGE_SECRET_BYTES = 32;
export const BRIDGE_NONCE_BYTES = 32;
export const BRIDGE_GENERATION_BYTES = 16;
export const BRIDGE_CONNECTION_ID_BYTES = 16;
export const BRIDGE_EDITOR_ID_BYTES = 16;
export const BRIDGE_DOCUMENT_ID_BYTES = 16;
export const BRIDGE_KEY_BYTES = 32;
export const BRIDGE_HMAC_BYTES = 32;
export const BRIDGE_TAG_BYTES = 16;
export const BRIDGE_IV_BYTES = 12;
export const BRIDGE_FRAME_HEADER_BYTES = 6;

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const HEX_RE = /^[0-9a-f]+$/;
const TAB_ID_RE = /^tab:[0-9a-fA-F-]{36}$/;

/** A bounded refusal code. Diagnostics built from these never quote external text. */
export type BridgeErrorCode =
	| "malformed"
	| "noncanonical"
	| "wrong-version"
	| "wrong-direction"
	| "sequence"
	| "authentication"
	| "too-large"
	| "timeout"
	| "unsupported";

/** The protocol's only failure type; it carries a fixed code and a fixed sentence. */
export class BridgeProtocolError extends Error {
	readonly code: BridgeErrorCode;

	constructor(code: BridgeErrorCode, message: string) {
		super(message);
		this.name = "BridgeProtocolError";
		this.code = code;
	}
}

function fail(code: BridgeErrorCode, message: string): never {
	throw new BridgeProtocolError(code, message);
}

function subtle(): SubtleCrypto {
	const available: Crypto | undefined = globalThis.crypto;
	if (available === undefined || available.subtle === undefined) {
		fail("unsupported", "WebCrypto is unavailable in this environment.");
	}
	return available.subtle;
}

/** Fresh random bytes from the platform CSPRNG. */
export function randomBytes(count: number): Uint8Array {
	const available: Crypto | undefined = globalThis.crypto;
	if (available === undefined || typeof available.getRandomValues !== "function") {
		fail("unsupported", "A cryptographic random source is unavailable in this environment.");
	}
	const bytes = new Uint8Array(count);
	available.getRandomValues(bytes);
	return bytes;
}

/** Canonical unpadded base64url for a byte string. */
export function encodeBase64Url(bytes: Uint8Array): string {
	let out = "";
	for (let index = 0; index < bytes.length; index += 3) {
		const first = bytes[index] ?? 0;
		const second = bytes[index + 1];
		const third = bytes[index + 2];
		out += BASE64URL_ALPHABET[first >> 2];
		out += BASE64URL_ALPHABET[((first & 0x03) << 4) | ((second ?? 0) >> 4)];
		if (second === undefined) break;
		out += BASE64URL_ALPHABET[((second & 0x0f) << 2) | ((third ?? 0) >> 6)];
		if (third === undefined) break;
		out += BASE64URL_ALPHABET[third & 0x3f];
	}
	return out;
}

/**
 * Decode exactly `expectedBytes` canonical unpadded base64url bytes.
 *
 * Canonical means: no padding, the URL-safe alphabet only, and a re-encode that
 * reproduces the input — so `AQ` and `AR` never both decode to one byte.
 */
export function decodeBase64Url(text: string, expectedBytes: number): Uint8Array {
	const expectedLength = Math.ceil((expectedBytes * 4) / 3);
	if (typeof text !== "string" || text.length !== expectedLength) {
		fail("noncanonical", "A base64url field does not have the canonical length for its byte count.");
	}
	const bytes = new Uint8Array(expectedBytes);
	let accumulator = 0;
	let bits = 0;
	let written = 0;
	for (const character of text) {
		const value = BASE64URL_ALPHABET.indexOf(character);
		if (value < 0) fail("noncanonical", "A base64url field contains a character outside the canonical alphabet.");
		accumulator = (accumulator << 6) | value;
		bits += 6;
		if (bits >= 8) {
			bits -= 8;
			if (written >= expectedBytes) fail("noncanonical", "A base64url field encodes more bytes than its declared width.");
			bytes[written++] = (accumulator >> bits) & 0xff;
		}
	}
	if (written !== expectedBytes) fail("noncanonical", "A base64url field encodes fewer bytes than its declared width.");
	if ((accumulator & ((1 << bits) - 1)) !== 0) fail("noncanonical", "A base64url field has non-zero trailing bits.");
	if (encodeBase64Url(bytes) !== text) fail("noncanonical", "A base64url field is not in canonical form.");
	return bytes;
}

/** Lowercase hex for a byte string. */
export function encodeHex(bytes: Uint8Array): string {
	let out = "";
	for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
	return out;
}

/** Decode exactly `expectedBytes` lowercase hex bytes. */
export function decodeHex(text: string, expectedBytes: number): Uint8Array {
	if (typeof text !== "string" || text.length !== expectedBytes * 2 || !HEX_RE.test(text)) {
		fail("noncanonical", "A hex field is not the canonical lowercase form for its byte count.");
	}
	const bytes = new Uint8Array(expectedBytes);
	for (let index = 0; index < expectedBytes; index++) bytes[index] = Number.parseInt(text.slice(index * 2, index * 2 + 2), 16);
	return bytes;
}

/** One field of a validated transcript: an ASCII string or a safe non-negative integer. */
export type BridgeField = string | number;

/**
 * `A(x)`: the validated canonical encoding of one fixed-field array.
 *
 * Field counts are the caller's contract (each message has its own constant), so
 * this function only enforces that every field *is* canonical: ASCII printable
 * strings or safe non-negative integers. `JSON.stringify` over such fields is
 * already the canonical text — ASCII needs no escaping.
 */
export function transcript(fields: readonly BridgeField[]): string {
	const checked: BridgeField[] = [];
	for (const field of fields) {
		if (typeof field === "number") {
			if (!Number.isSafeInteger(field) || field < 0) fail("noncanonical", "A numeric transcript field is not a safe non-negative integer.");
			checked.push(field);
			continue;
		}
		if (typeof field !== "string") fail("malformed", "A transcript field is neither a string nor a number.");
		for (const character of field) {
			const code = character.codePointAt(0) ?? 0;
			if (code < 0x20 || code > 0x7e) fail("noncanonical", "A transcript field contains a character outside printable ASCII.");
		}
		if (field.length === 0) fail("noncanonical", "A transcript field is empty.");
		checked.push(field);
	}
	return JSON.stringify(checked);
}

/** HMAC-SHA256 over the validated encoding of `fields`. */
export async function hmac(key: Uint8Array, fields: readonly BridgeField[]): Promise<Uint8Array> {
	const imported = await subtle().importKey("raw", key as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const signature = await subtle().sign("HMAC", imported, new TextEncoder().encode(transcript(fields)));
	return new Uint8Array(signature);
}

/** Constant-time equality for two byte strings of any length. */
export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
	if (left.length !== right.length) return false;
	let difference = 0;
	for (let index = 0; index < left.length; index++) difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
	return difference === 0;
}

/** HKDF-SHA256 over `secret`, deriving one 32-byte frame key. */
export async function deriveFrameKey(secret: Uint8Array, salt: Uint8Array, info: string): Promise<Uint8Array> {
	const imported = await subtle().importKey("raw", secret as BufferSource, "HKDF", false, ["deriveBits"]);
	const derived = await subtle().deriveBits(
		{ name: "HKDF", hash: "SHA-256", salt: salt as BufferSource, info: new TextEncoder().encode(info) },
		imported,
		BRIDGE_KEY_BYTES * 8,
	);
	return new Uint8Array(derived);
}

/** SHA-256 of a byte string. */
export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
	return new Uint8Array(await subtle().digest("SHA-256", bytes as BufferSource));
}

/** The identities one connection is pinned to; every field is required. */
export interface BridgeHandshakeInput {
	/** Canonical workspace-storage hash, lowercase SHA-256 hex. */
	readonly workspace: string;
	/** Indexed tab id (`tab:<uuid>`). */
	readonly tabId: string;
	/** Actual editor id, 16 bytes, as the wire's canonical text form. */
	readonly editorId: string;
	/** HTML document incarnation, 16 bytes, canonical text form. */
	readonly documentId: string;
	/** Lowercase SHA-256 hex of the host-authored chat-host binding. */
	readonly bindingHash: string;
	/** Literal port the listener is bound to. */
	readonly port: number;
	/** The exact pinned Webview Origin, persisted from the panel route. */
	readonly origin: string;
	/** Fresh client nonce, 32 bytes, canonical text form. */
	readonly clientNonce: string;
	/** Fresh server nonce, 32 bytes, canonical text form. */
	readonly serverNonce: string;
	/** Activation-wide host generation, 16 bytes, canonical text form. */
	readonly hostGeneration: string;
	/** Per-connection id, 16 bytes, canonical text form. */
	readonly connectionId: string;
}

/** `X`: the text transcript both sides MAC. */
export function handshakeTranscript(input: BridgeHandshakeInput): string {
	return transcript([
		BRIDGE_TRANSCRIPT_TAG,
		BRIDGE_PROTOCOL_VERSION,
		input.workspace,
		input.tabId,
		input.editorId,
		input.documentId,
		input.bindingHash,
		`ws://127.0.0.1:${input.port}`,
		BRIDGE_PATH,
		input.origin,
		input.clientNonce,
		input.serverNonce,
		input.hostGeneration,
		input.connectionId,
	]);
}

/** Canonical text forms of one handshake's random material. */
export interface BridgeHandshakeMaterial {
	readonly clientNonce: Uint8Array;
	readonly serverNonce: Uint8Array;
	readonly hostGeneration: Uint8Array;
	readonly connectionId: Uint8Array;
}

function handshakeWithMaterial(input: BridgeHandshakeInput, material: BridgeHandshakeMaterial): BridgeHandshakeInput {
	return {
		...input,
		clientNonce: encodeBase64Url(material.clientNonce),
		serverNonce: encodeBase64Url(material.serverNonce),
		hostGeneration: encodeBase64Url(material.hostGeneration),
		connectionId: encodeBase64Url(material.connectionId),
	};
}

/** The `hello` frame's fields, exactly as the client sends them. */
export function helloFields(input: {
	readonly workspace: string;
	readonly tabId: string;
	readonly editorId: Uint8Array;
	readonly documentId: Uint8Array;
	readonly bindingHash: string;
	readonly clientNonce: Uint8Array;
}): string {
	return transcript([
		"hello",
		BRIDGE_PROTOCOL_VERSION,
		input.workspace,
		input.tabId,
		encodeBase64Url(input.editorId),
		encodeBase64Url(input.documentId),
		input.bindingHash,
		encodeBase64Url(input.clientNonce),
	]);
}

/** A parsed, fully validated `hello`. */
export interface BridgeHello {
	readonly workspace: string;
	readonly tabId: string;
	readonly editorId: Uint8Array;
	readonly documentId: Uint8Array;
	readonly bindingHash: string;
	readonly clientNonce: Uint8Array;
}

/** Parse a `hello` text frame; every field is validated, none is normalised. */
export function parseHello(text: string): BridgeHello {
	if (typeof text !== "string" || text.length > BRIDGE_MAX_HANDSHAKE_BYTES) {
		fail("too-large", "The handshake message exceeds the protocol's limit.");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		fail("malformed", "The handshake message is not valid JSON.");
	}
	if (!Array.isArray(parsed) || parsed.length !== BRIDGE_HELLO_FIELDS) {
		fail("malformed", "The handshake message does not have exactly the expected fields.");
	}
	const [kind, version, workspace, tabId, editorId, documentId, bindingHash, clientNonce] = parsed as unknown[];
	if (kind !== "hello") fail("malformed", "The handshake message is not a hello.");
	if (version !== BRIDGE_PROTOCOL_VERSION) fail("wrong-version", "The handshake message does not carry this protocol version.");
	if (typeof workspace !== "string" || workspace.length !== 64 || !HEX_RE.test(workspace)) {
		fail("noncanonical", "The handshake workspace hash is not canonical lowercase hex.");
	}
	if (typeof tabId !== "string" || !TAB_ID_RE.test(tabId)) fail("noncanonical", "The handshake tab id is not canonical.");
	if (typeof bindingHash !== "string" || bindingHash.length !== 64 || !HEX_RE.test(bindingHash)) {
		fail("noncanonical", "The handshake binding hash is not canonical lowercase hex.");
	}
	return {
		workspace,
		tabId,
		editorId: decodeBase64Url(String(editorId), BRIDGE_EDITOR_ID_BYTES),
		documentId: decodeBase64Url(String(documentId), BRIDGE_DOCUMENT_ID_BYTES),
		bindingHash,
		clientNonce: decodeBase64Url(String(clientNonce), BRIDGE_NONCE_BYTES),
	};
}

/** The server's `challenge` text frame. */
export async function challengeFrame(
	secret: Uint8Array,
	input: BridgeHandshakeInput,
	material: BridgeHandshakeMaterial,
): Promise<string> {
	const transcriptText = handshakeTranscript(handshakeWithMaterial(input, material));
	const mac = await hmac(secret, ["server", transcriptText]);
	return transcript(["challenge", BRIDGE_PROTOCOL_VERSION, encodeBase64Url(material.serverNonce), encodeBase64Url(material.hostGeneration), encodeBase64Url(material.connectionId), encodeBase64Url(mac)]);
}

/** A parsed, fully validated `challenge`. */
export interface BridgeChallenge {
	readonly serverNonce: Uint8Array;
	readonly hostGeneration: Uint8Array;
	readonly connectionId: Uint8Array;
	readonly mac: Uint8Array;
}

/** Parse a `challenge` and verify its MAC *before* any proof is produced. */
export async function parseAndVerifyChallenge(
	text: string,
	secret: Uint8Array,
	input: BridgeHandshakeInput,
): Promise<{ readonly challenge: BridgeChallenge; readonly transcriptText: string }> {
	if (typeof text !== "string" || text.length > BRIDGE_MAX_HANDSHAKE_BYTES) fail("too-large", "The challenge exceeds the protocol's limit.");
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		fail("malformed", "The challenge is not valid JSON.");
	}
	if (!Array.isArray(parsed) || parsed.length !== BRIDGE_CHALLENGE_FIELDS) fail("malformed", "The challenge does not have exactly the expected fields.");
	const [kind, version, serverNonce, hostGeneration, connectionId, mac] = parsed as unknown[];
	if (kind !== "challenge") fail("malformed", "The message is not a challenge.");
	if (version !== BRIDGE_PROTOCOL_VERSION) fail("wrong-version", "The challenge does not carry this protocol version.");
	const challenge: BridgeChallenge = {
		serverNonce: decodeBase64Url(String(serverNonce), BRIDGE_NONCE_BYTES),
		hostGeneration: decodeBase64Url(String(hostGeneration), BRIDGE_GENERATION_BYTES),
		connectionId: decodeBase64Url(String(connectionId), BRIDGE_CONNECTION_ID_BYTES),
		mac: decodeBase64Url(String(mac), BRIDGE_HMAC_BYTES),
	};
	const transcriptText = handshakeTranscript(
		handshakeWithMaterial(input, {
			clientNonce: input.clientNonce === undefined ? new Uint8Array() : decodeBase64Url(input.clientNonce, BRIDGE_NONCE_BYTES),
			serverNonce: challenge.serverNonce,
			hostGeneration: challenge.hostGeneration,
			connectionId: challenge.connectionId,
		}),
	);
	const expected = await hmac(secret, ["server", transcriptText]);
	if (!bytesEqual(expected, challenge.mac)) fail("authentication", "The challenge proof does not match this document's secret.");
	return { challenge, transcriptText };
}

/** The client's `proof` text frame, computed from the verified challenge. */
export async function proofFrame(secret: Uint8Array, transcriptText: string): Promise<string> {
	const mac = await hmac(secret, ["client", transcriptText]);
	return transcript(["proof", BRIDGE_PROTOCOL_VERSION, encodeBase64Url(mac)]);
}

/** Parse a `proof` and verify it against the transcript the challenge established. */
export async function verifyProof(text: string, secret: Uint8Array, transcriptText: string): Promise<void> {
	if (typeof text !== "string" || text.length > BRIDGE_MAX_HANDSHAKE_BYTES) fail("too-large", "The proof exceeds the protocol's limit.");
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		fail("malformed", "The proof is not valid JSON.");
	}
	if (!Array.isArray(parsed) || parsed.length !== BRIDGE_PROOF_FIELDS) fail("malformed", "The proof does not have exactly the expected fields.");
	const [kind, version, mac] = parsed as unknown[];
	if (kind !== "proof") fail("malformed", "The message is not a proof.");
	if (version !== BRIDGE_PROTOCOL_VERSION) fail("wrong-version", "The proof does not carry this protocol version.");
	const provided = decodeBase64Url(String(mac), BRIDGE_HMAC_BYTES);
	const expected = await hmac(secret, ["client", transcriptText]);
	if (!bytesEqual(expected, provided)) fail("authentication", "The client proof does not match.");
}

/** Both direction keys for one authenticated connection. */
export async function frameKeys(
	secret: Uint8Array,
	transcriptText: string,
): Promise<{ readonly clientToServer: Uint8Array; readonly serverToClient: Uint8Array }> {
	const salt = await sha256(new TextEncoder().encode(transcriptText));
	return {
		clientToServer: await deriveFrameKey(secret, salt, BRIDGE_KEY_INFO_CLIENT_TO_SERVER),
		serverToClient: await deriveFrameKey(secret, salt, BRIDGE_KEY_INFO_SERVER_TO_CLIENT),
	};
}

/** `A` over the frame header fields; the AAD every frame is bound to. */
export function frameAdditionalData(
	hostGeneration: Uint8Array,
	connectionId: Uint8Array,
	documentId: Uint8Array,
	direction: number,
	sequence: number,
): string {
	return transcript([
		BRIDGE_TRANSCRIPT_TAG,
		BRIDGE_PROTOCOL_VERSION,
		encodeBase64Url(hostGeneration),
		encodeBase64Url(connectionId),
		encodeBase64Url(documentId),
		direction,
		sequence,
	]);
}

/** Initialisation vector: eight zero bytes then the big-endian sequence. */
export function frameIv(sequence: number): Uint8Array {
	if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > 0xffffffff) fail("sequence", "A frame sequence is outside the protocol's range.");
	const iv = new Uint8Array(BRIDGE_IV_BYTES);
	new DataView(iv.buffer).setUint32(8, sequence, false);
	return iv;
}

/** `version || direction || sequence || ciphertext || tag`. */
export async function sealFrame(input: {
	readonly key: Uint8Array;
	readonly direction: number;
	readonly sequence: number;
	readonly plaintext: Uint8Array;
	readonly additionalData: string;
}): Promise<Uint8Array> {
	if (input.plaintext.length > BRIDGE_MAX_PLAINTEXT_BYTES) fail("too-large", "A frame plaintext exceeds the protocol's limit.");
	if (input.direction !== BRIDGE_DIRECTION_CLIENT_TO_SERVER && input.direction !== BRIDGE_DIRECTION_SERVER_TO_CLIENT) {
		fail("wrong-direction", "A frame direction is not one of the two the protocol defines.");
	}
	const imported = await subtle().importKey("raw", input.key as BufferSource, { name: "AES-GCM" }, false, ["encrypt"]);
	const sealed = new Uint8Array(
		await subtle().encrypt(
			{
				name: "AES-GCM",
				iv: frameIv(input.sequence) as BufferSource,
				additionalData: new TextEncoder().encode(input.additionalData) as BufferSource,
				tagLength: BRIDGE_TAG_BYTES * 8,
			},
			imported,
			input.plaintext as BufferSource,
		),
	);
	const frame = new Uint8Array(BRIDGE_FRAME_HEADER_BYTES + sealed.length);
	frame[0] = BRIDGE_PROTOCOL_VERSION;
	frame[1] = input.direction;
	new DataView(frame.buffer).setUint32(2, input.sequence, false);
	frame.set(sealed, BRIDGE_FRAME_HEADER_BYTES);
	return frame;
}

/**
 * Open one frame; every rejection is fail-closed and names no attacker data.
 *
 * The additional data is derived from the frame's *own* header sequence and the
 * pinned identities, so a caller cannot accidentally authenticate a frame
 * against the wrong sequence: the sequence is read from the wire, validated as
 * this direction's next value by the caller's {@link BridgeSequence}, and bound
 * into the tag.
 */
export async function openFrame(input: {
	readonly key: Uint8Array;
	readonly frame: Uint8Array;
	readonly expectedDirection: number;
	readonly hostGeneration: Uint8Array;
	readonly connectionId: Uint8Array;
	readonly documentId: Uint8Array;
}): Promise<{ readonly sequence: number; readonly plaintext: Uint8Array }> {
	const frame = input.frame;
	if (frame.length < BRIDGE_FRAME_HEADER_BYTES + BRIDGE_TAG_BYTES) fail("malformed", "A frame is shorter than the protocol's header and tag.");
	if (frame.length > BRIDGE_MAX_FRAME_BYTES) fail("too-large", "A frame exceeds the protocol's limit.");
	if (frame[0] !== BRIDGE_PROTOCOL_VERSION) fail("wrong-version", "A frame does not carry this protocol version.");
	const direction = frame[1];
	if (direction !== input.expectedDirection) fail("wrong-direction", "A frame arrived on the wrong direction.");
	const sequence = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(2, false);
	const additionalData = frameAdditionalData(input.hostGeneration, input.connectionId, input.documentId, direction, sequence);
	const imported = await subtle().importKey("raw", input.key as BufferSource, { name: "AES-GCM" }, false, ["decrypt"]);
	let plaintext: ArrayBuffer;
	try {
		plaintext = await subtle().decrypt(
			{
				name: "AES-GCM",
				iv: frameIv(sequence) as BufferSource,
				additionalData: new TextEncoder().encode(additionalData) as BufferSource,
				tagLength: BRIDGE_TAG_BYTES * 8,
			},
			imported,
			frame.subarray(BRIDGE_FRAME_HEADER_BYTES) as BufferSource,
		);
	} catch {
		fail("authentication", "A frame failed authentication.");
	}
	return { sequence, plaintext: new Uint8Array(plaintext) };
}

/**
 * The only sequence rule: each direction accepts exactly its next value.
 *
 * A repeat, a gap or a value the peer never sent closes the connection. The
 * counter is also capped so a long-lived socket reconnects before the 32-bit
 * sequence can wrap: the guest's own reconnect after a host-only restart is what
 * mints a fresh connection id and a fresh sequence space.
 */
export class BridgeSequence {
	#next = 0;

	get next(): number {
		return this.#next;
	}

	/** Accept `sequence` as this direction's next value, or refuse. */
	accept(sequence: number): void {
		if (!Number.isSafeInteger(sequence) || sequence !== this.#next) {
			fail("sequence", "A frame sequence is not the next one this direction accepts.");
		}
		this.#next += 1;
	}

	/** `true` when the direction is close to the reconnect threshold. */
	get shouldReconnect(): boolean {
		return this.#next >= BRIDGE_MAX_MESSAGES_BEFORE_RECONNECT;
	}
}

/** Text frame bodies for one connection, encoded and decoded with their own checks. */
export function textFrame(value: unknown, maxBytes: number = BRIDGE_MAX_PLAINTEXT_BYTES): Uint8Array {
	const json = JSON.stringify(value);
	if (typeof json !== "string") fail("malformed", "A protocol message is not encodable.");
	const bytes = new TextEncoder().encode(json);
	if (bytes.length > maxBytes) fail("too-large", "A protocol message exceeds the protocol's limit.");
	return bytes;
}

/** Decode one decrypted text frame body; the caller validates the fields. */
export function parseTextFrame(plaintext: Uint8Array, maxBytes: number = BRIDGE_MAX_PLAINTEXT_BYTES): unknown {
	if (plaintext.length > maxBytes) fail("too-large", "A protocol message exceeds the protocol's limit.");
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
	} catch {
		fail("malformed", "A protocol message is not valid UTF-8.");
	}
	try {
		return JSON.parse(text);
	} catch {
		fail("malformed", "A protocol message is not valid JSON.");
	}
}

/**
 * One DTO as a printable-ASCII JSON field.
 *
 * `A(x)` refuses anything outside printable ASCII, but an application payload may
 * legitimately carry a path, a title or a model id with non-ASCII characters.
 * Escaping every code unit above `~` as `\\uXXXX` keeps the field canonical and
 * reversible: `JSON.parse` of the field returns exactly the value that was
 * escaped, including a surrogate pair.
 */
export function asciiJsonText(value: unknown): string {
	const json = JSON.stringify(value ?? null);
	if (typeof json !== "string") fail("malformed", "A protocol payload is not encodable.");
	let out = "";
	for (const character of json) {
		const code = character.codePointAt(0) ?? 0;
		if (code >= 0x20 && code <= 0x7e) {
			out += character;
			continue;
		}
		if (character.length === 2) {
			out += `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
			out += `\\u${character.charCodeAt(1).toString(16).padStart(4, "0")}`;
			continue;
		}
		out += `\\u${code.toString(16).padStart(4, "0")}`;
	}
	return out;
}

/** Decode one payload field produced by {@link asciiJsonText}. */
export function parseAsciiJsonText(field: unknown): unknown {
	if (typeof field !== "string" || field.length === 0) fail("malformed", "A protocol payload field is not a string.");
	try {
		return JSON.parse(field) as unknown;
	} catch {
		fail("malformed", "A protocol payload field is not valid JSON.");
	}
}

/** The `ready` frame the host sends first on an authenticated connection. */
export function readyFrame(hostGeneration: Uint8Array, documentId: Uint8Array, status: string): string {
	return transcript(["ready", encodeBase64Url(hostGeneration), encodeBase64Url(documentId), status]);
}

/** Route negotiation and application messages are all validated fixed-field arrays. */
export function routeOfferFrame(hostGeneration: Uint8Array, documentId: Uint8Array, routeGeneration: string, status: string): string {
	return transcript(["route-offer", encodeBase64Url(hostGeneration), encodeBase64Url(documentId), routeGeneration, status]);
}

export function routeAckFrame(hostGeneration: Uint8Array, documentId: Uint8Array, routeGeneration: string): string {
	return transcript(["route-ack", encodeBase64Url(hostGeneration), encodeBase64Url(documentId), routeGeneration]);
}

export function invalidateFrame(hostGeneration: Uint8Array, documentId: Uint8Array, routeGeneration: string): string {
	return transcript(["invalidate", encodeBase64Url(hostGeneration), encodeBase64Url(documentId), routeGeneration]);
}

export function statusFrame(hostGeneration: Uint8Array, documentId: Uint8Array, routeGeneration: string, status: string): string {
	return transcript(["status", encodeBase64Url(hostGeneration), encodeBase64Url(documentId), routeGeneration, status]);
}

/**
 * One host→guest terminal push.
 *
 * A terminal push carries no route generation and no request id of its own: it is
 * not an answer to a request, and the terminal renderer owns sequence and route
 * validity through the broker generation inside the payload. The frame is still
 * sealed, sequenced and pinned to this host activation and this document
 * incarnation like every other post-authentication frame, and the payload is one
 * `omp:terminal-*` message object encoded as printable-ASCII JSON — exactly the
 * DTO the panel route would carry, so one parser serves both transports.
 */
export function terminalPushFrame(hostGeneration: Uint8Array, documentId: Uint8Array, payload: unknown): string {
	return transcript(["terminal", encodeBase64Url(hostGeneration), encodeBase64Url(documentId), asciiJsonText(payload)]);
}

/**
 * A terminal push's own fields, or `null` when the frame is not one.
 *
 * This validates only what the wire owns — the field count, the two canonical
 * identities and the printable-ASCII JSON payload. The payload's own shape is the
 * guest's `omp:terminal-*` message contract and is validated there, so a push can
 * never smuggle a partially trusted object into the renderer.
 */
export function parseTerminalPush(
	message: readonly unknown[],
): { readonly hostGeneration: string; readonly documentId: string; readonly payload: unknown } | null {
	if (message.length !== BRIDGE_TERMINAL_FIELDS) return null;
	const [, hostGeneration, documentId, payload] = message;
	if (typeof hostGeneration !== "string" || typeof documentId !== "string" || typeof payload !== "string") return null;
	let decoded: unknown;
	try {
		decoded = parseAsciiJsonText(payload);
	} catch {
		return null;
	}
	return { hostGeneration, documentId, payload: decoded };
}

export function requestFrame(
	hostGeneration: Uint8Array,
	documentId: Uint8Array,
	routeGeneration: string,
	requestId: string,
	actionSeq: string,
	operation: string,
	payload: unknown,
): string {
	return transcript([
		"request",
		encodeBase64Url(hostGeneration),
		encodeBase64Url(documentId),
		routeGeneration,
		requestId,
		actionSeq,
		operation,
		asciiJsonText(payload),
	]);
}

export function replyFrame(
	hostGeneration: Uint8Array,
	documentId: Uint8Array,
	routeGeneration: string,
	requestId: string,
	result: unknown,
): string {
	return transcript([
		"reply",
		encodeBase64Url(hostGeneration),
		encodeBase64Url(documentId),
		routeGeneration,
		requestId,
		asciiJsonText(result),
	]);
}

/** Liveness frames; `id` is a random correlation id, never a payload. */
export function pingFrame(id: string): string {
	return transcript(["ping", id]);
}

export function pongFrame(id: string): string {
	return transcript(["pong", id]);
}

/** The canonical form of every per-connection token: 128 bits as lowercase hex. */
const TOKEN_RE = /^[0-9a-f]{32}$/;

/**
 * A fresh 128-bit token in the protocol's canonical text form.
 *
 * The same grammar is used for a request id and for a route generation `R`, so
 * one validator accepts both and neither can be confused with a document or
 * editor id (which are base64url) or with a native identity.
 */
export function createToken(): string {
	return encodeHex(randomBytes(16));
}

/** `true` for a token this protocol mints. */
export function isCanonicalToken(value: unknown): value is string {
	return typeof value === "string" && TOKEN_RE.test(value);
}

/**
 * The bounded vocabulary of a route status.
 *
 * A status is a fact about the host's own endpoint, never peer text, so the
 * listener and the guest both accept exactly these three words.
 */
export type BridgeRouteStatus = "ready" | "waiting" | "disconnected";

/** `true` for a status this protocol defines. */
export function isRouteStatus(value: unknown): value is BridgeRouteStatus {
	return value === "ready" || value === "waiting" || value === "disconnected";
}

/** A fresh decimal action counter for one document; strictly increasing. */
export class BridgeActionSequence {
	#next = 1n;

	next(): string {
		const value = this.#next;
		this.#next += 1n;
		return value.toString(10);
	}
}
