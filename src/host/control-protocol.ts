/**
 * Wire contract for the authenticated host-control channel of
 * [ADR-0003](../../docs/decisions/0003-native-host-control-pipe.md).
 *
 * One side of this module runs inside the native OMP process (the `-e`
 * extension in `src/omp/host-control.ts`, bundled standalone and loaded by OMP
 * under RPC or native interactive mode); the other side runs in the VS Code extension host
 * (`src/host/control-client.ts`). Both import this file, so every byte on the
 * wire has exactly one definition.
 *
 * **ADR-0038 limited this channel to read-only binding and tool discovery; ADR-0040
 * extends it narrowly.** Snapshot and tool discovery are unchanged. Native state and
 * target-guarded public-SDK shutdown and rename operate on the authenticated process.
 * Model/thinking and RPC session naming remain commands on the RPC session's own pipe.
 *
 * Invariants this module encodes — do not relax them in callers:
 *
 * - **The bootstrap key never travels in plaintext.** It is only ever an HMAC key.
 *   It is not a frame field and not part of any error message; the rendezvous
 *   carries it only as ciphertext sealed to the launch recipient (ADR-0006).
 * - **The server is authenticated before any reusable credential exists.** The
 *   client sends a fresh nonce and accepts nothing until the server proves
 *   possession of the key over a binding that includes the pipe name, process
 *   instance, session epoch and slot. A substituted endpoint (tampered
 *   rendezvous or false pipe) cannot produce that proof, so the client refuses
 *   visibly instead of trusting it.
 * - **Every request and response is individually authenticated** and bound to
 *   the connection's nonce pair, so a frame captured from one connection cannot
 *   be replayed on another.
 * - **The rendezvous is a tamperable hint.** Its fields are compared against the
 *   authenticated challenge, and the challenge is what the client pins.
 * - **Frames are bounded** before parsing, and payloads are strict: unknown keys
 *   are rejected rather than ignored.
 *
 * Nothing here writes a plaintext secret to disk: the rendezvous carries public
 * discovery metadata (pipe name, pid, session identity, generation) and the key
 * only as sealed ciphertext.
 */

import {
	constants,
	createHash,
	createHmac,
	createPublicKey,
	privateDecrypt,
	publicEncrypt,
	randomBytes,
	randomUUID,
	timingSafeEqual,
} from "node:crypto";
import { open, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { retryWindowsFileOperation } from "./file-operation-retry.ts";

/** Bumped when a frame shape changes incompatibly; both ends must match. */
export const CONTROL_PROTOCOL_VERSION = 3;

/** Names the rendezvous file's owner; a reader that sees another service refuses. */
export const CONTROL_SERVICE = "omp-vscode-host-control";

/** 256-bit key, 256-bit nonces, base64url without padding. */
export const CONTROL_KEY_BYTES = 32;
export const CONTROL_NONCE_BYTES = 32;

/** Hard ceiling for one newline-delimited frame, enforced before parsing. */
export const CONTROL_MAX_FRAME_BYTES = 256 * 1024;
/** Hard ceiling for the rendezvous ciphertext field, checked before decoding. */
export const CONTROL_MAX_CIPHERTEXT_CHARS = 2048;
/** Cap untrusted discovery bytes before allocation and JSON parsing. */
export const CONTROL_MAX_RENDEZVOUS_BYTES = 16 * 1024;
/** Names-only catalogue retained for the independent Copy Active Tool Names command. */
export const CONTROL_MAX_TOOLS = 1024;
export const CONTROL_MAX_TOOL_NAME_CHARS = 128;
/** Bounded public-event replay, including the worst-case existing state/host envelope. */
export const CONTROL_NATIVE_ACTIVITY_CAPACITY = 32;
export const CONTROL_NATIVE_ACTIVITY_ID_CHARS = 128;
export const CONTROL_NATIVE_ACTIVITY_QUESTION_POINTS = 200;

/**
 * Launch-scoped public rendezvous metadata. Neither value is a secret: they tell
 * the native extension where to publish and which slot it belongs to. The
 * control key itself never travels through the environment (ADR-0006).
 */
export const CONTROL_DIR_ENV = "OMP_VSCODE_CONTROL_DIR";
export const CONTROL_SLOT_ENV = "OMP_VSCODE_CONTROL_SLOT";
/** `0` when the `omp.linkReminder` setting is off for this launch; the Chat prompt module then adds no per-message reminder. */
export const LINK_REMINDER_ENV = "OMP_VSCODE_LINK_REMINDER";

/**
 * Identifier Bun's `--define` replaces with the run's public recipient key, as a
 * quoted JS string literal:
 * `--define '__OMP_VSCODE_RECIPIENT_PUBLIC_KEY:"<spki>"'`. The launcher pins it
 * through `--preload`, so the plugin reads the literal from its own module
 * instance instead of a mutable environment, and other extensions' environment
 * collections cannot substitute it.
 */
export const CONTROL_RECIPIENT_DEFINE = "__OMP_VSCODE_RECIPIENT_PUBLIC_KEY";

/** The literal the Bun transpiler substitutes; never read without a `typeof` guard. */
declare const __OMP_VSCODE_RECIPIENT_PUBLIC_KEY: string;

/** Slot ids are minted by the launcher and are not secret. */
export const CONTROL_SLOT_RE = /^[A-Za-z0-9_-]{8,64}$/;
/** Pipe names are minted by the native host and are not secret. */
export const CONTROL_PIPE_NAME_RE = /^[A-Za-z0-9_-]{8,120}$/;
export const CONTROL_PIPE_PREFIX = "omp-vscode-control-";
export const CONTROL_RENDEZVOUS_SUFFIX = ".json";
export const CONTROL_SOCKET_SUFFIX = ".sock";

const INSTANCE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{43}$/;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const MAC_RE = /^[A-Za-z0-9_-]{43}$/;
const TOOL_NAME_RE = new RegExp(`^[\\x21-\\x7e]{1,${CONTROL_MAX_TOOL_NAME_CHARS}}$`);
const MAX_TEXT = 4096;

/** Mint the 256-bit bootstrap key handed to one native process. */
export function createControlKey(): string {
	return randomBytes(CONTROL_KEY_BYTES).toString("base64url");
}

/** Mint a fresh connection nonce. Never reuse one across connections. */
export function createControlNonce(): string {
	return randomBytes(CONTROL_NONCE_BYTES).toString("base64url");
}

/** Mint a per-slot rendezvous id; not a secret. */
export function createControlSlotId(): string {
	return `slot-${randomUUID()}`;
}

/** Mint the identity of one native host process. */
export function createControlInstanceId(): string {
	return `inst-${randomUUID()}`;
}

/** Mint a session generation. Every native transition mints a new one. */
export function createControlEpoch(): string {
	return `epo-${randomUUID()}`;
}

/** Mint a fresh id for one request frame. */
export function createControlRequestId(): string {
	return `req-${randomUUID()}`;
}

export function isControlKey(value: unknown): value is string {
	return typeof value === "string" && NONCE_RE.test(value);
}

export function isControlNonce(value: unknown): value is string {
	return typeof value === "string" && NONCE_RE.test(value);
}

export function isControlSlotId(value: unknown): value is string {
	return typeof value === "string" && CONTROL_SLOT_RE.test(value);
}

export function isControlToolName(value: unknown): value is string {
	return typeof value === "string" && TOOL_NAME_RE.test(value);
}


/** Thrown for a malformed key, nonce or frame; never carries key material. */
export class ControlProtocolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ControlProtocolError";
	}
}

/** Decode a stored key. The result must never be logged or serialized. */
export function decodeControlKey(key: string): Buffer {
	if (!isControlKey(key)) {
		throw new ControlProtocolError(
			`control key must be ${CONTROL_KEY_BYTES} base64url-encoded bytes`,
		);
	}
	const buffer = Buffer.from(key, "base64url");
	if (buffer.length !== CONTROL_KEY_BYTES) {
		throw new ControlProtocolError(
			`control key must decode to ${CONTROL_KEY_BYTES} bytes`,
		);
	}
	return buffer;
}

function mac(key: string | Buffer, text: string): string {
	const secret = typeof key === "string" ? decodeControlKey(key) : key;
	return createHmac("sha256", secret).update(text, "utf8").digest("base64url");
}

function macEquals(expected: string, actual: unknown): boolean {
	if (typeof actual !== "string" || actual.length !== expected.length) return false;
	return timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(actual, "utf8"));
}

/** Field-delimited binding so no two field values can be concatenated ambiguously. */
function binding(parts: readonly (string | number | null)[]): string {
	return JSON.stringify([`${CONTROL_SERVICE}/v${CONTROL_PROTOCOL_VERSION}`, ...parts]);
}

/** DER SPKI for RSA-2048 is 294 bytes; the regex bounds the field before decoding. */
const SPKI_BASE64URL_RE = /^[A-Za-z0-9_-]{200,4096}$/;
const CIPHERTEXT_BASE64URL_RE = /^[A-Za-z0-9_-]{86,2048}$/;
const FINGERPRINT_RE = /^[A-Za-z0-9_-]{43}$/;

function decodeControlRecipientSpki(spkiBase64url: string): Buffer | null {
	if (!SPKI_BASE64URL_RE.test(spkiBase64url)) return null;
	try {
		const der = Buffer.from(spkiBase64url, "base64url");
		const key = createPublicKey({ key: der, format: "der", type: "spki" });
		if (key.asymmetricKeyType !== "rsa") return null;
		const modulus = key.asymmetricKeyDetails?.modulusLength;
		if (typeof modulus === "number" && modulus < 2048) return null;
		return der;
	} catch {
		return null;
	}
}

/** `true` when `value` is base64url DER SPKI of an RSA public key we can seal to. */
export function isControlRecipientSpki(value: unknown): value is string {
	return typeof value === "string" && decodeControlRecipientSpki(value) !== null;
}

/** Stable fingerprint of the recipient key: base64url SHA-256 of its DER SPKI. */
export function controlRecipientFingerprint(spkiBase64url: string): string {
	return createHash("sha256").update(Buffer.from(spkiBase64url, "base64url")).digest("base64url");
}

/** `true` when `value` is a well-formed rendezvous ciphertext field. */
export function isControlCiphertext(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length <= CONTROL_MAX_CIPHERTEXT_CHARS &&
		CIPHERTEXT_BASE64URL_RE.test(value)
	);
}

/** `true` when `value` is a well-formed recipient fingerprint. */
export function isControlRecipientFingerprint(value: unknown): value is string {
	return typeof value === "string" && FINGERPRINT_RE.test(value);
}

/**
 * Seal the host-generated control key to the launch-pinned recipient with
 * RSA-OAEP-SHA256. Only the ciphertext ever leaves the native process.
 */
export function encryptControlKeyToRecipient(key: string, spkiBase64url: string): string {
	if (!isControlKey(key)) {
		throw new ControlProtocolError(`control key must be ${CONTROL_KEY_BYTES} base64url bytes`);
	}
	const der = decodeControlRecipientSpki(spkiBase64url);
	if (!der) throw new ControlProtocolError("recipient public key is not a usable RSA SPKI");
	const sealed = publicEncrypt(
		{
			key: createPublicKey({ key: der, format: "der", type: "spki" }),
			padding: constants.RSA_PKCS1_OAEP_PADDING,
			oaepHash: "sha256",
		},
		Buffer.from(key, "base64url"),
	);
	return sealed.toString("base64url");
}

/**
 * Unseal a candidate control key from a rendezvous. `null` on any failure — a
 * ciphertext for another recipient, tampering, or a wrong key length — so a
 * failed unwrap can never be mistaken for a usable key.
 */
export function decryptControlKeyFromRecipient(
	ciphertextBase64url: string,
	privateKeyPkcs8Pem: string,
): string | null {
	if (!isControlCiphertext(ciphertextBase64url)) return null;
	try {
		const opened = privateDecrypt(
			{
				key: privateKeyPkcs8Pem,
				padding: constants.RSA_PKCS1_OAEP_PADDING,
				oaepHash: "sha256",
			},
			Buffer.from(ciphertextBase64url, "base64url"),
		);
		if (opened.length !== CONTROL_KEY_BYTES) return null;
		return opened.toString("base64url");
	} catch {
		return null;
	}
}

/**
 * The run's public recipient key, read from the Bun `--define` literal that the
 * launcher pinned through `--preload`. `null` when the launch pinned nothing
 * usable: host control then stays unavailable rather than falling back to an
 * unencrypted channel (ADR-0006). The `typeof` guard is what makes an
 * undefined identifier (a bundle built without the define) safe to read.
 */
export function readControlRecipientPublicKey(): string | null {
	const pinned =
		typeof __OMP_VSCODE_RECIPIENT_PUBLIC_KEY === "string"
			? __OMP_VSCODE_RECIPIENT_PUBLIC_KEY
			: null;
	return pinned !== null && isControlRecipientSpki(pinned) ? pinned : null;
}

/**
 * What one connection is authenticated against. The handshake MAC covers these
 * fields as read at handshake time, so a client that has pinned them cannot be
 * redirected to another process, slot, session generation or endpoint. Every
 * response carries the host's *current* binding: it may advance past the pinned
 * one (`sessionFile` appears once the session is materialised, and a native
 * session transition mints a new `epoch`), and a client compares the fields it
 * pinned.
 */
export interface ControlHostBinding {
	/** Launcher-allocated slot this host publishes into. */
	readonly slotId: string;
	/** Full endpoint the server listens on (Windows pipe path or POSIX socket). */
	readonly endpoint: string;
	/** Short pipe name; the Windows endpoint is derived from it. */
	readonly pipeName: string;
	/** Identity of the native process, minted at listener start. */
	readonly instanceId: string;
	/** Session generation; changes on switch/resume/branch/fork. */
	readonly epoch: string;
	readonly pid: number;
	/**
	 * Canonical session file as the host reports it, or null before one exists.
	 *
	 * Null is only an observation when the host actually read its session
	 * identity: a host that could not read it reports null here and names the
	 * condition in the snapshot's `readGaps`, so a client must treat null as
	 * unproven rather than as proof of an unsaved session.
	 */
	readonly sessionFile: string | null;
	readonly cwd: string;
	/** Installed OMP release, or null when the host could not report one. */
	readonly ompVersion: string | null;
}

/**
 * Deterministic JSON: object keys are sorted and object members whose value is
 * `undefined` are omitted, so both ends produce identical bytes for a digest.
 * Anything else that is not JSON (functions, non-finite numbers, top-level
 * `undefined`) is rejected rather than coerced.
 */
export function canonicalJson(value: unknown): string {
	if (value === null) return "null";
	switch (typeof value) {
		case "number":
			if (!Number.isFinite(value)) throw new ControlProtocolError("non-finite number");
			return JSON.stringify(value);
		case "boolean":
		case "string":
			return JSON.stringify(value);
		case "object": {
			if (Array.isArray(value)) {
				return `[${value.map(item => canonicalJson(item)).join(",")}]`;
			}
			const record = value as Record<string, unknown>;
			const keys = Object.keys(record).sort();
			const parts: string[] = [];
			for (const key of keys) {
				const item = record[key];
				if (item === undefined) continue;
				parts.push(`${JSON.stringify(key)}:${canonicalJson(item)}`);
			}
			return `{${parts.join(",")}}`;
		}
		default:
			throw new ControlProtocolError(`unsupported JSON value of type ${typeof value}`);
	}
}

export function controlDigest(value: unknown): string {
	return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

/**
 * Server-identity proof: HMAC(key, domain=`host`, C, S, and the full host
 * binding). The client verifies this before it sends a single request.
 */
export function controlHandshakeMac(
	key: string | Buffer,
	input: { readonly clientNonce: string; readonly serverNonce: string; readonly host: ControlHostBinding },
): string {
	const host = input.host;
	return mac(
		key,
		binding([
			"host",
			input.clientNonce,
			input.serverNonce,
			host.slotId,
			host.pipeName,
			host.instanceId,
			host.epoch,
			host.pid,
			host.sessionFile ?? "",
			host.cwd,
			host.ompVersion ?? "",
		]),
	);
}

export function verifyControlHandshakeMac(
	key: string | Buffer,
	input: { readonly clientNonce: string; readonly serverNonce: string; readonly host: ControlHostBinding },
	received: unknown,
): boolean {
	try {
		return macEquals(controlHandshakeMac(key, input), received);
	} catch {
		return false;
	}
}

/**
 * Per-request proof: HMAC(key, domain=`request`, C, S, request id, method and
 * payload digest) — exactly the fields ADR-0003 requires, never the plaintext
 * key. The nonce pair is unique to one connection and is verified against that
 * connection, so a frame captured elsewhere cannot be replayed here; the ledger
 * then handles a repeated request id on the same connection.
 */
export function controlRequestMac(
	key: string | Buffer,
	input: {
		readonly clientNonce: string;
		readonly serverNonce: string;
		readonly requestId: string;
		readonly method: ControlMethod;
		readonly digest: string;
	},
): string {
	return mac(
		key,
		binding([
			"request",
			input.clientNonce,
			input.serverNonce,
			input.requestId,
			input.method,
			input.digest,
		]),
	);
}

export function verifyControlRequestMac(
	key: string | Buffer,
	input: Parameters<typeof controlRequestMac>[1],
	received: unknown,
): boolean {
	try {
		return macEquals(controlRequestMac(key, input), received);
	} catch {
		return false;
	}
}

/**
 * Digest a response binds: the result *and* the host identity it was produced
 * under. A client that verified only the MAC over an opaque digest could be fed
 * a swapped result, so the digest is recomputed on both ends.
 */
export function controlResponseDigest(result: ControlResult, host: ControlHostBinding): string {
	return controlDigest({ result, host });
}

/** Per-response proof over the connection's nonces and the response digest. */
export function controlResponseMac(
	key: string | Buffer,
	input: {
		readonly clientNonce: string;
		readonly serverNonce: string;
		readonly requestId: string;
		readonly digest: string;
	},
): string {
	return mac(
		key,
		binding(["response", input.clientNonce, input.serverNonce, input.requestId, input.digest]),
	);
}

export function verifyControlResponseMac(
	key: string | Buffer,
	input: Parameters<typeof controlResponseMac>[1],
	received: unknown,
): boolean {
	try {
		return macEquals(controlResponseMac(key, input), received);
	} catch {
		return false;
	}
}

/**
 * Per-error proof. The human message is deliberately outside the MAC: it is
 * display-only and no caller may branch on it — branch on `code`.
 */
export function controlErrorMac(
	key: string | Buffer,
	input: {
		readonly clientNonce: string;
		readonly serverNonce: string;
		readonly requestId: string | null;
		readonly code: ControlErrorCode;
	},
): string {
	return mac(
		key,
		binding(["error", input.clientNonce, input.serverNonce, input.requestId ?? "", input.code]),
	);
}

export function verifyControlErrorMac(
	key: string | Buffer,
	input: Parameters<typeof controlErrorMac>[1],
	received: unknown,
): boolean {
	try {
		return macEquals(controlErrorMac(key, input), received);
	} catch {
		return false;
	}
}

/** Binding/tool observations plus guarded native-TUI lifecycle operations. */
export const CONTROL_METHODS = ["snapshot", "listTools", "nativeState", "nativeActivity", "nativeShutdown", "nativeRename", "subagentWork"] as const;
export type ControlMethod = (typeof CONTROL_METHODS)[number];

/**
 * A provider-qualified model reference as OMP reports it. Not carried by this
 * channel: it is the display shape the host controls panel receives from the
 * rpc-ui session's model list.
 */
export interface ControlModelRef {
	readonly provider: string;
	readonly id: string;
	readonly name?: string;
}

export interface ControlSnapshotPayload {
	readonly kind: "snapshot";
}

export interface ControlListToolsPayload {
	readonly kind: "listTools";
}

export interface ControlNativeTarget {
	readonly epoch: string;
	readonly sessionFile: string | null;
	readonly sessionId: string | null;
}

export interface ControlNativeState {
	readonly available: boolean;
	readonly sessionFile: string | null;
	readonly sessionId: string | null;
	readonly cwd: string | null;
	readonly name: string | null;
	/** Null means unknown, never idle. Includes queued messages and async deliveries. */
	readonly settled: boolean | null;
	/** Queried only when includeContent is true. */
	readonly hasContent: boolean | null;
	readonly unavailableReason: string | null;
}

export type ControlNativeActivityOutcome = "stop" | "length" | "toolUse" | "error" | "aborted";
export type ControlNativeActivityEntry =
	| { readonly seq: number; readonly sessionId: string; readonly kind: "agent_start" }
	| { readonly seq: number; readonly sessionId: string; readonly kind: "agent_end"; readonly outcome: ControlNativeActivityOutcome | null }
	| { readonly seq: number; readonly sessionId: string; readonly kind: "ask_start" | "approval_start"; readonly toolCallId: string; readonly question: string }
	| { readonly seq: number; readonly sessionId: string; readonly kind: "ask_end" | "approval_end"; readonly toolCallId: string };


/** Foreground agent work and async jobs/result delivery from the same synchronous SDK cut. */
export interface ControlNativeWork {
	readonly working: boolean;
	readonly backgroundWork: boolean;
}
/** Additive capability; `nativeState` keeps its original eight keys. */
export interface ControlNativeActivity {
	readonly epoch: string;
	readonly oldestSeq: number;
	readonly entries: readonly ControlNativeActivityEntry[];
	readonly state: ControlNativeState;
	/** Included only for an explicitly capability-gated work request. */
	readonly work?: ControlNativeWork | null;
}

export type ControlNativeShutdownStatus = "accepted" | "accepted-deferred" | "busy" | "target-changed" | "unsupported";
export type ControlNativeRenameStatus = "renamed" | "target-changed" | "unsupported";

export type ControlPayload =
	| ControlSnapshotPayload
	| ControlListToolsPayload
	| { readonly kind: "nativeState"; readonly includeContent: boolean }
	| { readonly kind: "nativeActivity"; readonly work?: true }
	| { readonly kind: "nativeShutdown"; readonly target: ControlNativeTarget; readonly consent: boolean }
	| { readonly kind: "nativeRename"; readonly target: ControlNativeTarget; readonly name: string }
	| { readonly kind: "subagentWork" };

export interface ControlHostSnapshot {
	readonly host: ControlHostBinding;
	/** Bounded notes naming any field this host could not read; never guesses. */
	readonly readGaps: readonly string[];
}

/** Names only; retained for the independent extension clipboard command. */
export interface ControlToolList {
	readonly available: boolean;
	readonly all: readonly string[];
	readonly active: readonly string[];
	readonly unavailableReason: string | null;
}

export type ControlResult =
	| { readonly kind: "snapshot"; readonly snapshot: ControlHostSnapshot }
	| { readonly kind: "listTools"; readonly list: ControlToolList }
	| { readonly kind: "nativeState"; readonly state: ControlNativeState }
	| { readonly kind: "nativeActivity"; readonly activity: ControlNativeActivity }
	| { readonly kind: "nativeShutdown"; readonly status: ControlNativeShutdownStatus }
	| { readonly kind: "nativeRename"; readonly status: ControlNativeRenameStatus }
	/** Whether any subagent of the host process is running or has messages queued (the agent registry, not async jobs). */
	| { readonly kind: "subagentWork"; readonly active: boolean };

/**
 * Protocol-level refusals. Each maps to one explicit GUI message; a caller
 * branches on the code and never on the display text.
 */
export const CONTROL_ERROR_CODES = [
	"bad-version",
	"bad-frame",
	"too-large",
	"unauthorized",
	"replayed-nonce",
	"unknown-method",
	"bad-payload",
	"timeout",
	"closed",
	"internal",
] as const;
export type ControlErrorCode = (typeof CONTROL_ERROR_CODES)[number];

/** Opens a connection; carries a fresh client nonce and nothing else. */
export interface ControlHelloFrame {
	readonly v: typeof CONTROL_PROTOCOL_VERSION;
	readonly kind: "hello";
	readonly clientNonce: string;
}

/** Server-identity proof and the binding the connection is pinned to. */
export interface ControlChallengeFrame {
	readonly v: typeof CONTROL_PROTOCOL_VERSION;
	readonly kind: "challenge";
	readonly serverNonce: string;
	readonly host: ControlHostBinding;
	readonly mac: string;
}

export interface ControlRequestFrame {
	readonly v: typeof CONTROL_PROTOCOL_VERSION;
	readonly kind: "request";
	readonly clientNonce: string;
	readonly serverNonce: string;
	readonly requestId: string;
	readonly method: ControlMethod;
	/** SHA-256 of `canonicalJson(payload)`. */
	readonly digest: string;
	readonly payload: ControlPayload;
	readonly mac: string;
}

export interface ControlResponseFrame {
	readonly v: typeof CONTROL_PROTOCOL_VERSION;
	readonly kind: "response";
	readonly requestId: string;
	readonly result: ControlResult;
	readonly digest: string;
	readonly host: ControlHostBinding;
	readonly mac: string;
}

export interface ControlErrorFrame {
	readonly v: typeof CONTROL_PROTOCOL_VERSION;
	readonly kind: "error";
	readonly code: ControlErrorCode;
	readonly requestId: string | null;
	/** Display-only, bounded, credential-free. Never branch on this text. */
	readonly message: string;
	/** Live identity when the handshake already succeeded; null before that. */
	readonly host: ControlHostBinding | null;
	/** Null on the frames sent before a connection is authenticated. */
	readonly mac: string | null;
}

export type ControlClientFrame = ControlHelloFrame | ControlRequestFrame;
export type ControlServerFrame = ControlChallengeFrame | ControlResponseFrame | ControlErrorFrame;

/** One newline-delimited frame, or `null` when the value is not a valid frame. */
export function encodeControlFrame(frame: ControlClientFrame | ControlServerFrame): string {
	const encoded = canonicalJson(frame);
	if (Buffer.byteLength(encoded, "utf8") > CONTROL_MAX_FRAME_BYTES) {
		throw new ControlProtocolError("frame exceeds the control channel limit");
	}
	return `${encoded}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(record);
	return actual.length === keys.length && keys.every(key => key in record);
}

function isBoundedText(value: unknown, max = MAX_TEXT): value is string {
	return typeof value === "string" && value.length <= max;
}

function parseToolNames(value: unknown): string[] | null {
	if (!Array.isArray(value) || value.length > CONTROL_MAX_TOOLS) return null;
	const names: string[] = [];
	const seen = new Set<string>();
	for (const entry of value) {
		if (!isControlToolName(entry) || seen.has(entry)) return null;
		seen.add(entry);
		names.push(entry);
	}
	return names;
}

function parseToolList(value: unknown): ControlToolList | null {
	if (!isRecord(value) || !hasExactKeys(value, ["available", "all", "active", "unavailableReason"])) return null;
	if (typeof value.available !== "boolean") return null;
	const all = parseToolNames(value.all);
	const active = parseToolNames(value.active);
	if (!all || !active || all.length + active.length > CONTROL_MAX_TOOLS) return null;
	if (value.unavailableReason !== null && !isBoundedText(value.unavailableReason, MAX_TEXT)) return null;
	return { available: value.available, all, active, unavailableReason: value.unavailableReason };
}

function parseNativeTarget(value: unknown): ControlNativeTarget | null {
	if (!isRecord(value) || !hasExactKeys(value, ["epoch", "sessionFile", "sessionId"])) return null;
	if (typeof value.epoch !== "string" || !INSTANCE_ID_RE.test(value.epoch)) return null;
	if (value.sessionFile !== null && !isBoundedText(value.sessionFile)) return null;
	if (value.sessionId !== null && !isBoundedText(value.sessionId)) return null;
	return { epoch: value.epoch, sessionFile: value.sessionFile, sessionId: value.sessionId };
}

function parseNativeState(value: unknown): ControlNativeState | null {
	if (!isRecord(value) || !hasExactKeys(value, ["available", "sessionFile", "sessionId", "cwd", "name", "settled", "hasContent", "unavailableReason"])) return null;
	if (typeof value.available !== "boolean") return null;
	for (const key of ["sessionFile", "sessionId", "cwd", "name", "unavailableReason"] as const) {
		if (value[key] !== null && !isBoundedText(value[key])) return null;
	}
	if (value.settled !== null && typeof value.settled !== "boolean") return null;
	if (value.hasContent !== null && typeof value.hasContent !== "boolean") return null;
	return {
		available: value.available, sessionFile: value.sessionFile as string | null,
		sessionId: value.sessionId as string | null, cwd: value.cwd as string | null,
		name: value.name as string | null, settled: value.settled, hasContent: value.hasContent,
		unavailableReason: value.unavailableReason as string | null,
	};
}

function parseNativeActivityEntry(value: unknown): ControlNativeActivityEntry | null {
	if (!isRecord(value) || !Number.isSafeInteger(value.seq) || (value.seq as number) < 1
		|| !isBoundedText(value.sessionId, CONTROL_NATIVE_ACTIVITY_ID_CHARS) || value.sessionId.length === 0) return null;
	const base = { seq: value.seq as number, sessionId: value.sessionId };
	if (value.kind === "agent_start") return hasExactKeys(value, ["seq", "sessionId", "kind"]) ? { ...base, kind: value.kind } : null;
	if (value.kind === "agent_end") {
		if (!hasExactKeys(value, ["seq", "sessionId", "kind", "outcome"])
			|| (value.outcome !== null && !["stop", "length", "toolUse", "error", "aborted"].includes(value.outcome as string))) return null;
		return { ...base, kind: value.kind, outcome: value.outcome as ControlNativeActivityOutcome | null };
	}
	if (!isBoundedText(value.toolCallId, CONTROL_NATIVE_ACTIVITY_ID_CHARS) || value.toolCallId.length === 0) return null;
	if (value.kind === "ask_end" || value.kind === "approval_end") {
		return hasExactKeys(value, ["seq", "sessionId", "kind", "toolCallId"]) ? { ...base, kind: value.kind, toolCallId: value.toolCallId } : null;
	}
	if (value.kind !== "ask_start" && value.kind !== "approval_start") return null;
	if (!hasExactKeys(value, ["seq", "sessionId", "kind", "toolCallId", "question"])
		|| !isBoundedText(value.question, CONTROL_NATIVE_ACTIVITY_QUESTION_POINTS * 2)) return null;
	let points = 0;
	for (let index = 0; index < value.question.length; points++) {
		if (points === CONTROL_NATIVE_ACTIVITY_QUESTION_POINTS) return null;
		index += (value.question.codePointAt(index) ?? 0) > 0xffff ? 2 : 1;
	}
	return { ...base, kind: value.kind, toolCallId: value.toolCallId, question: value.question };
}

function parseNativeActivity(value: unknown): ControlNativeActivity | null {
	const includeWork = isRecord(value) && Object.hasOwn(value, "work");
	if (!isRecord(value) || !hasExactKeys(value, includeWork ? ["epoch", "oldestSeq", "entries", "state", "work"] : ["epoch", "oldestSeq", "entries", "state"])
		|| typeof value.epoch !== "string" || !INSTANCE_ID_RE.test(value.epoch)
		|| !Number.isSafeInteger(value.oldestSeq) || (value.oldestSeq as number) < 1
		|| !Array.isArray(value.entries) || value.entries.length > CONTROL_NATIVE_ACTIVITY_CAPACITY) return null;
	const state = parseNativeState(value.state);
	if (state === null) return null;
	let work: ControlNativeWork | null = null;
	if (includeWork && value.work !== null) {
		if (!isRecord(value.work) || !hasExactKeys(value.work, ["working", "backgroundWork"]) ||
			typeof value.work.working !== "boolean" || typeof value.work.backgroundWork !== "boolean") return null;
		work = { working: value.work.working, backgroundWork: value.work.backgroundWork };
	}
	const entries: ControlNativeActivityEntry[] = [];
	for (const raw of value.entries) {
		const entry = parseNativeActivityEntry(raw);
		if (entry === null || entry.seq !== (value.oldestSeq as number) + entries.length) return null;
		entries.push(entry);
	}
	const activity = { epoch: value.epoch, oldestSeq: value.oldestSeq as number, entries, state };
	return includeWork ? { ...activity, work } : activity;
}


/** Strict payload validation: a wrong shape or extra key is a protocol error. */
export function parseControlPayload(
	method: ControlMethod,
	value: unknown,
): ControlPayload | null {
	if (!isRecord(value)) return null;
	switch (method) {
		case "snapshot":
			return hasExactKeys(value, ["kind"]) && value.kind === "snapshot"
				? { kind: "snapshot" }
				: null;
		case "listTools":
			return hasExactKeys(value, ["kind"]) && value.kind === "listTools" ? { kind: "listTools" } : null;
		case "nativeState":
			return hasExactKeys(value, ["kind", "includeContent"]) && value.kind === method && typeof value.includeContent === "boolean"
				? { kind: method, includeContent: value.includeContent } : null;
		case "nativeActivity":
			if (hasExactKeys(value, ["kind"]) && value.kind === method) return { kind: method };
			return hasExactKeys(value, ["kind", "work"]) && value.kind === method && value.work === true
				? { kind: method, work: true } : null;
		case "subagentWork":
			return hasExactKeys(value, ["kind"]) && value.kind === method ? { kind: method } : null;
		case "nativeShutdown": {
			if (!hasExactKeys(value, ["kind", "target", "consent"]) || value.kind !== method || typeof value.consent !== "boolean") return null;
			const target = parseNativeTarget(value.target);
			return target ? { kind: method, target, consent: value.consent } : null;
		}
		case "nativeRename": {
			if (!hasExactKeys(value, ["kind", "target", "name"]) || value.kind !== method || !isBoundedText(value.name, 512) || value.name.trim().length === 0) return null;
			const target = parseNativeTarget(value.target);
			return target ? { kind: method, target, name: value.name } : null;
		}
		default:
			return null;
	}
}

function parseHostBinding(value: unknown): ControlHostBinding | null {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, [
			"slotId",
			"endpoint",
			"pipeName",
			"instanceId",
			"epoch",
			"pid",
			"sessionFile",
			"cwd",
			"ompVersion",
		])
	) {
		return null;
	}
	if (!isControlSlotId(value.slotId)) return null;
	if (typeof value.endpoint !== "string" || !isBoundedText(value.endpoint, MAX_TEXT)) return null;
	if (typeof value.pipeName !== "string" || !CONTROL_PIPE_NAME_RE.test(value.pipeName)) return null;
	if (typeof value.instanceId !== "string" || !INSTANCE_ID_RE.test(value.instanceId)) return null;
	if (typeof value.epoch !== "string" || !INSTANCE_ID_RE.test(value.epoch)) return null;
	if (typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid <= 0) {
		return null;
	}
	if (value.sessionFile !== null && !isBoundedText(value.sessionFile, MAX_TEXT)) return null;
	if (!isBoundedText(value.cwd, MAX_TEXT)) return null;
	if (value.ompVersion !== null && !isBoundedText(value.ompVersion, 64)) return null;
	return {
		slotId: value.slotId,
		endpoint: value.endpoint,
		pipeName: value.pipeName,
		instanceId: value.instanceId,
		epoch: value.epoch,
		pid: value.pid,
		sessionFile: value.sessionFile,
		cwd: value.cwd,
		ompVersion: value.ompVersion,
	};
}

function parseErrorCode(value: unknown): ControlErrorCode | null {
	return typeof value === "string" && (CONTROL_ERROR_CODES as readonly string[]).includes(value)
		? (value as ControlErrorCode)
		: null;
}

function parseResult(value: unknown): ControlResult | null {
	if (!isRecord(value)) return null;
	switch (value.kind) {
		case "snapshot": {
			if (!hasExactKeys(value, ["kind", "snapshot"])) return null;
			const snapshot = parseSnapshot(value.snapshot);
			return snapshot ? { kind: "snapshot", snapshot } : null;
		}
		case "listTools": {
			if (!hasExactKeys(value, ["kind", "list"])) return null;
			const list = parseToolList(value.list);
			return list ? { kind: "listTools", list } : null;
		}
		case "nativeState": {
			if (!hasExactKeys(value, ["kind", "state"])) return null;
			const state = parseNativeState(value.state);
			return state ? { kind: "nativeState", state } : null;
		}
		case "nativeActivity": {
			if (!hasExactKeys(value, ["kind", "activity"])) return null;
			const activity = parseNativeActivity(value.activity);
			return activity ? { kind: "nativeActivity", activity } : null;
		}
		case "nativeShutdown":
			return hasExactKeys(value, ["kind", "status"]) && typeof value.status === "string" && ["accepted", "accepted-deferred", "busy", "target-changed", "unsupported"].includes(value.status)
				? { kind: "nativeShutdown", status: value.status as ControlNativeShutdownStatus } : null;
		case "subagentWork":
			return hasExactKeys(value, ["kind", "active"]) && typeof value.active === "boolean" ? { kind: "subagentWork", active: value.active } : null;
		case "nativeRename":
			return hasExactKeys(value, ["kind", "status"]) && typeof value.status === "string" && ["renamed", "target-changed", "unsupported"].includes(value.status)
				? { kind: "nativeRename", status: value.status as ControlNativeRenameStatus } : null;
		default:
			return null;
	}
}


function parseSnapshot(value: unknown): ControlHostSnapshot | null {
	if (!isRecord(value) || !hasExactKeys(value, ["host", "readGaps"])) return null;
	const host = parseHostBinding(value.host);
	if (!host) return null;
	if (!Array.isArray(value.readGaps) || value.readGaps.length > 32) return null;
	const readGaps = value.readGaps.filter(
		(gap): gap is string => typeof gap === "string" && gap.length <= MAX_TEXT,
	);
	if (readGaps.length !== value.readGaps.length) return null;
	return { host, readGaps };
}

/** Parse an inbound client frame; `null` when the value is not a valid frame. */
export function parseControlClientFrame(value: unknown): ControlClientFrame | null {
	if (!isRecord(value)) return null;
	if (value.v !== CONTROL_PROTOCOL_VERSION) return null;
	switch (value.kind) {
		case "hello":
			if (!hasExactKeys(value, ["v", "kind", "clientNonce"])) return null;
			return isControlNonce(value.clientNonce)
				? { v: CONTROL_PROTOCOL_VERSION, kind: "hello", clientNonce: value.clientNonce }
				: null;
		case "request": {
			if (
				!hasExactKeys(value, [
					"v",
					"kind",
					"clientNonce",
					"serverNonce",
					"requestId",
					"method",
					"digest",
					"payload",
					"mac",
				])
			) {
				return null;
			}
			if (!isControlNonce(value.clientNonce) || !isControlNonce(value.serverNonce)) return null;
			if (typeof value.requestId !== "string" || !INSTANCE_ID_RE.test(value.requestId)) return null;
			if (
				typeof value.method !== "string" ||
				!(CONTROL_METHODS as readonly string[]).includes(value.method)
			) {
				return null;
			}
			if (typeof value.digest !== "string" || !DIGEST_RE.test(value.digest)) return null;
			if (typeof value.mac !== "string" || !MAC_RE.test(value.mac)) return null;
			const payload = parseControlPayload(value.method as ControlMethod, value.payload);
			if (!payload) return null;
			return {
				v: CONTROL_PROTOCOL_VERSION,
				kind: "request",
				clientNonce: value.clientNonce,
				serverNonce: value.serverNonce,
				requestId: value.requestId,
				method: value.method as ControlMethod,
				digest: value.digest,
				payload,
				mac: value.mac,
			};
		}
		default:
			return null;
	}
}

/** Parse an inbound server frame; `null` when the value is not a valid frame. */
export function parseControlServerFrame(value: unknown): ControlServerFrame | null {
	if (!isRecord(value)) return null;
	if (value.v !== CONTROL_PROTOCOL_VERSION) return null;
	switch (value.kind) {
		case "challenge": {
			if (!hasExactKeys(value, ["v", "kind", "serverNonce", "host", "mac"])) return null;
			if (!isControlNonce(value.serverNonce)) return null;
			const host = parseHostBinding(value.host);
			if (!host) return null;
			if (typeof value.mac !== "string" || !MAC_RE.test(value.mac)) return null;
			return {
				v: CONTROL_PROTOCOL_VERSION,
				kind: "challenge",
				serverNonce: value.serverNonce,
				host,
				mac: value.mac,
			};
		}
		case "response": {
			if (!hasExactKeys(value, ["v", "kind", "requestId", "result", "digest", "host", "mac"])) {
				return null;
			}
			if (typeof value.requestId !== "string" || !INSTANCE_ID_RE.test(value.requestId)) return null;
			const result = parseResult(value.result);
			if (!result) return null;
			if (typeof value.digest !== "string" || !DIGEST_RE.test(value.digest)) return null;
			const host = parseHostBinding(value.host);
			if (!host) return null;
			if (typeof value.mac !== "string" || !MAC_RE.test(value.mac)) return null;
			return {
				v: CONTROL_PROTOCOL_VERSION,
				kind: "response",
				requestId: value.requestId,
				result,
				digest: value.digest,
				host,
				mac: value.mac,
			};
		}
		case "error": {
			if (!hasExactKeys(value, ["v", "kind", "code", "requestId", "message", "host", "mac"])) {
				return null;
			}
			const code = parseErrorCode(value.code);
			if (!code) return null;
			if (value.requestId !== null && typeof value.requestId !== "string") return null;
			if (!isBoundedText(value.message, MAX_TEXT)) return null;
			const host = value.host === null ? null : parseHostBinding(value.host);
			if (value.host !== null && !host) return null;
			if (value.mac !== null && (typeof value.mac !== "string" || !MAC_RE.test(value.mac))) {
				return null;
			}
			return {
				v: CONTROL_PROTOCOL_VERSION,
				kind: "error",
				code,
				requestId: value.requestId,
				message: value.message,
				host,
				mac: value.mac,
			};
		}
		default:
			return null;
	}
}

/** Full endpoint for a pipe name: Windows named pipe, POSIX socket in `dir`. */
export function controlEndpoint(pipeName: string, directory: string): string {
	return process.platform === "win32"
		? `\\\\.\\pipe\\${pipeName}`
		: join(directory, `${pipeName}${CONTROL_SOCKET_SUFFIX}`);
}

export function controlPipeName(slotId: string): string {
	const entropy = randomBytes(9).toString("base64url");
	return `${CONTROL_PIPE_PREFIX}${slotId}-${entropy}`;
}

/**
 * Pipe names that currently exist for one slot: every control server a process
 * serving the slot has started and not yet closed.
 *
 * A host publishes exactly one rendezvous record per slot, but more than one
 * server may exist for the slot (an older build starts one for every in-process
 * subagent session, and the last writer owns the record). The listing is only a
 * discovery hint: a name proves nothing, so each candidate is still dialled
 * through the peer proof and the handshake before anything trusts it.
 */
export async function listControlPipeNames(slotId: string, directory: string): Promise<string[]> {
	if (!isControlSlotId(slotId)) return [];
	const prefix = `${CONTROL_PIPE_PREFIX}${slotId}-`;
	const windows = process.platform === "win32";
	const names = await readdir(windows ? "\\\\.\\pipe\\" : directory).catch(() => [] as string[]);
	const found: string[] = [];
	for (const name of names) {
		const bare = windows || !name.endsWith(CONTROL_SOCKET_SUFFIX) ? name : name.slice(0, -CONTROL_SOCKET_SUFFIX.length);
		if (bare.startsWith(prefix) && CONTROL_PIPE_NAME_RE.test(bare)) found.push(bare);
	}
	return found;
}

/**
 * Rendezvous file for one slot. It carries the sealed control key and public
 * discovery metadata only: no plaintext key, no private key, no Collab link.
 */
export interface ControlRendezvous {
	readonly version: typeof CONTROL_PROTOCOL_VERSION;
	readonly service: typeof CONTROL_SERVICE;
	readonly slotId: string;
	readonly endpoint: string;
	readonly pipeName: string;
	readonly instanceId: string;
	readonly epoch: string;
	readonly pid: number;
	readonly sessionFile: string | null;
	readonly cwd: string;
	readonly ompVersion: string | null;
	/** RSA-OAEP-SHA256 ciphertext of the control key, never the key itself. */
	readonly ciphertext: string;
	/** Fingerprint of the public recipient key the ciphertext was sealed to. */
	readonly recipientFingerprint: string;
	readonly startedAt: number;
}

export function controlRendezvousPath(directory: string, slotId: string): string {
	return join(directory, `${slotId}${CONTROL_RENDEZVOUS_SUFFIX}`);
}

export function parseControlRendezvous(value: unknown): ControlRendezvous | null {
	const binding = parseHostBinding(
		isRecord(value)
			? {
					slotId: value.slotId,
					endpoint: value.endpoint,
					pipeName: value.pipeName,
					instanceId: value.instanceId,
					epoch: value.epoch,
					pid: value.pid,
					sessionFile: value.sessionFile,
					cwd: value.cwd,
					ompVersion: value.ompVersion,
				}
			: null,
	);
	if (!binding || !isRecord(value)) return null;
	if (value.version !== CONTROL_PROTOCOL_VERSION) return null;
	if (value.service !== CONTROL_SERVICE) return null;
	if (!isControlCiphertext(value.ciphertext)) return null;
	if (!isControlRecipientFingerprint(value.recipientFingerprint)) return null;
	if (typeof value.startedAt !== "number" || !Number.isFinite(value.startedAt)) return null;
	return {
		version: CONTROL_PROTOCOL_VERSION,
		service: CONTROL_SERVICE,
		...binding,
		ciphertext: value.ciphertext,
		recipientFingerprint: value.recipientFingerprint,
		startedAt: value.startedAt,
	};
}

async function readBoundedRendezvous(path: string): Promise<string | null> {
	const file = await open(path, "r").catch(() => null);
	if (file === null) return null;
	try {
		const bytes = Buffer.allocUnsafe(CONTROL_MAX_RENDEZVOUS_BYTES + 1);
		let count = 0;
		while (count < bytes.length) {
			const { bytesRead } = await file.read(bytes, count, bytes.length - count, null);
			if (bytesRead === 0) return bytes.subarray(0, count).toString("utf8");
			count += bytesRead;
		}
		return null;
	} catch {
		return null;
	} finally {
		await file.close();
	}
}

export async function readControlRendezvous(
	directory: string,
	slotId: string,
): Promise<ControlRendezvous | null> {
	if (!isControlSlotId(slotId)) return null;
	const raw = await readBoundedRendezvous(controlRendezvousPath(directory, slotId));
	if (raw === null) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	return parseControlRendezvous(parsed);
}

/**
 * Publish the rendezvous atomically (temp file + rename) so a reader never sees
 * a torn record. The record carries no credential material by construction.
 */
export async function writeControlRendezvous(
	directory: string,
	record: ControlRendezvous,
): Promise<void> {
	const path = controlRendezvousPath(directory, record.slotId);
	const temp = `${path}.${process.pid}.tmp`;
	await writeFile(temp, `${JSON.stringify(record, null, "\t")}\n`, { encoding: "utf8", mode: 0o600 });
	try {
		await retryWindowsFileOperation(() => rename(temp, path));
	} finally {
		await rm(temp, { force: true }).catch(() => undefined);
	}
}

/** Remove the rendezvous only while it still names `instanceId`. */
export async function removeOwnControlRendezvous(
	directory: string,
	slotId: string,
	instanceId: string,
): Promise<void> {
	const path = controlRendezvousPath(directory, slotId);
	if (!isControlSlotId(slotId)) return;
	const raw = await readBoundedRendezvous(path);
	if (raw === null) return;
	try {
		const parsed = JSON.parse(raw) as { instanceId?: unknown };
		if (parsed.instanceId !== instanceId) return;
	} catch {
		return;
	}
	await rm(path, { force: true }).catch(() => {});
}

/**
 * Comparison form for a path: absolute, forward slashes folded, and on Windows
 * case-folded with the `\\?\` long-path prefix and trailing separator removed.
 *
 * This is deliberately simpler than the claim module's folding, which also
 * resolves 8.3 names via `realpathSync.native`: here the comparison is only a
 * defence-in-depth check against a tampered rendezvous, while the authoritative
 * identity check is the handshake MAC over the host's own strings.
 */
export function controlPathComparisonForm(value: string): string {
	let normalized = resolve(value).replace(/\\/g, "/");
	if (normalized.startsWith("//?/")) normalized = normalized.slice(4);
	if (normalized.length > 1 && normalized.endsWith("/")) normalized = normalized.slice(0, -1);
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function controlPathEquals(left: string, right: string): boolean {
	return controlPathComparisonForm(left) === controlPathComparisonForm(right);
}
