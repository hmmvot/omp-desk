/**
 * Wire contract and durable record contract of the extension-owned PTY broker
 * ([ADR-0024](../../docs/decisions/0024-own-omp-pty-for-in-tab-terminal.md)).
 *
 * The broker is one detached process that owns a PTY (and therefore the native
 * OMP TUI or a folder shell) across editor closure and extension-host reload.
 * It uses no VS Code API: it talks to the extension host over a loopback socket
 * and is discovered through one record file. Both ends share the definitions in
 * this module and nothing else.
 *
 * The exit of the owning VS Code instance is not observed through that socket
 * either. For a **folder shell** whose owning VS Code main-process generations
 * were positively attested through the broker's private helper, the signaling of
 * those retained handles starts a finite grace period and then one shell-only stop
 * attempt ([ADR-0030](../../docs/decisions/0030-watch-the-verified-owning-vscode-process-for-shell-grace.md)).
 * A managed OMP host is never stopped this way, a hint that cannot be attested
 * disarms the attempt instead of guessing, and every stop answer still reports an
 * unproven process tree truthfully ([ADR-0029](../../docs/decisions/0029-report-uncontained-pty-tree-stop-as-unknown.md)).
 *
 * Three identities are kept apart on purpose, because conflating any two of them
 * is how a stale owner gets mistaken for a live writer:
 *
 * - the **broker** (`brokerPid` + its kernel creation time): the process that
 *   holds the PTY and answers this protocol;
 * - the **native** child (`nativePid` + its kernel creation time): the real
 *   process behind the slot — the rpc-ui OMP process, the native OMP TUI, or the
 *   folder shell in a pseudo console — which is the one whose id the host-control
 *   channel reports;
 * - the **generation** (`generation`): minted once per broker start, so a token
 *   and a session key from a previous broker can never authenticate a successor.
 *
 * Authentication follows [ADR-0006](../../docs/decisions/0006-host-generated-key-peer-verified-pipe.md)
 * and is owned by the *serving* process: the broker mints a 256-bit token, writes
 * it into its record inside verified owner-only private storage, and delivers it
 * to nobody else. A client proves the *process* it is talking to by comparing the
 * creation time the broker claims for its own pid with a reading it takes itself
 * from the kernel (`queryPtyProcessIdentity`), and proves the *connection* by an
 * HMAC handshake keyed by the token, then a MAC on every frame keyed by the derived
 * session key. A record written by another account, or a socket opened by another
 * process, therefore cannot reach terminal input or output.
 *
 * Limits, stated rather than implied: the token is not a per-user secret boundary
 * (a process running as this user can read the record), so this authenticates the
 * *process* and the *generation*, not the account. That is the boundary ADR-0006
 * chose; the record's owner-only access is what carries the account boundary.
 *
 * A **managed-rpc** broker (`omp --mode rpc-ui`, the chat transport) is the third
 * kind. Its child is an ordinary pipe child, not a pseudo console, because JSONL
 * cannot cross ConPTY. The frames that serve it (`rpc-*`) are *additive* and gated
 * by the record's `kind`. {@link PTY_PROTOCOL_VERSION} is deliberately not bumped for
 * them: the version is bound into the handshake MAC, so a bump would strand every
 * surviving `managed-omp` and `folder-shell` broker of the previous build. A client
 * sends an `rpc-*` frame only to a `managed-rpc` record, so a previous-build broker
 * never receives one.
 */

import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { canonicalJson } from "./control-protocol.ts";
import { CHAT_EXIT_STDERR_BYTES, parseChatExitReason } from "../chat/exit-reason.ts";

/**
 * Version of the frame protocol. Bumped when a frame's meaning changes.
 *
 * Version 2 adds the `admit-owner` request, the `owner-stop` event and the
 * `ownerStop` field of every status (ADR-0030). The `admit-owner` request carries a
 * hint to attest or `null` for an authenticated frontend that cannot attest one, which
 * disarms automatic stopping rather than leaving a possible live owner unwatched. A
 * version 1 broker is retained and reported, never driven as if it were this one.
 */
export const PTY_PROTOCOL_VERSION = 2;

/**
 * Version of the staged runtime tree layout. Independent of the frame protocol.
 *
 * Version 2 adds the staged owner-watch helper (`pty-owner-watch.ps1`) to the tree.
 */
export const PTY_RUNTIME_VERSION = 2;

/** Value identifying this service in the record and in handshake refusals. */
export const PTY_SERVICE = "omp-vscode-pty";

/** Bytes in a broker token and in a connection nonce. */
export const PTY_KEY_BYTES = 32;
export const PTY_NONCE_BYTES = 32;

/**
 * Largest frame either side accepts, counting the whole JSON line. Output is
 * chunked below this bound, so a peer that sends more is refused rather than
 * buffered.
 */
export const PTY_MAX_FRAME_BYTES = 256 * 1024;

/**
 * Chars in one output frame. JSON string escaping can inflate a char to six
 * bytes, so the chunk is far enough below {@link PTY_MAX_FRAME_BYTES} that a
 * frame of control characters still fits.
 */
export const PTY_MAX_OUTPUT_CHUNK_CHARS = 32 * 1024;

/** Chars of terminal output kept for an exact replay, newest retained. */
export const PTY_DEFAULT_BACKLOG_CHARS = 2 * 1024 * 1024;

/** Lines of terminal scrollback the broker keeps in its screen model. */
export const PTY_DEFAULT_SCROLLBACK_LINES = 2000;

/**
 * Characters one serialized snapshot may carry, and the bound every peer enforces.
 *
 * The screen decides how much scrollback it can afford by measuring the serialized
 * result, not by estimating lines; a snapshot still above this bound is cut at a line
 * boundary and reports itself as truncated.
 */
export const PTY_MAX_SNAPSHOT_CHARS = 1024 * 1024;

/**
 * Characters of a terminal title carried in a state or snapshot frame.
 *
 * The title comes from the child's own OSC output, which is not this extension's
 * text: an unbounded one would make every state frame too large for the peer's line
 * reader and disconnect a caller that has done nothing wrong.
 */
export const PTY_MAX_TITLE_CHARS = 256;

/** Connections one broker accepts at a time; the frontends of one editor plus a reload. */
export const PTY_MAX_CLIENTS = 8;

/** Terminal size bounds both ends accept, in character cells. */
export const PTY_COLUMN_RANGE = { min: 2, max: 1000 } as const;
export const PTY_ROW_RANGE = { min: 1, max: 500 } as const;

/**
 * Raw bytes of one stdin/stdout line carried by one `rpc-line` / `rpc-write` frame.
 * The fragment travels as base64 (4/3 the size), so a frame stays near 128 KiB — well
 * below {@link PTY_MAX_FRAME_BYTES} whatever the line holds. Fragments are budgeted by
 * encoded size, not by characters, because JSON string escaping of raw text could
 * multiply its size unpredictably.
 */
export const PTY_RPC_FRAGMENT_RAW_BYTES = 96 * 1024;

/** Longest stdout line the broker keeps; a longer one is dropped and reported as a notice. */
export const PTY_RPC_MAX_LINE_BYTES = 16 * 1024 * 1024;

/** Longest stdin line one `rpc-write` may assemble; a longer one is refused `line-too-long`. */
export const PTY_RPC_MAX_WRITE_BYTES = 16 * 1024 * 1024;

/** Bound on the retained `ready` line a broker returns on every attach. */
export const PTY_RPC_MAX_READY_CHARS = 16 * 1024;

/** Chars of stderr carried by one `rpc-stderr` frame. */
export const PTY_RPC_MAX_STDERR_CHARS = 16 * 1024;

/** Bytes of the child's stderr the broker keeps for diagnostics. */
export const PTY_RPC_STDERR_TAIL_BYTES = CHAT_EXIT_STDERR_BYTES;

const NONCE_RE = /^[A-Za-z0-9_-]{43}$/;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAC_RE = /^[A-Za-z0-9_-]{43}$/;
/** A creation time is a FILETIME decimal string, exactly as the probe prints it. */
const CREATION_RE = /^[1-9][0-9]{9,19}$/;
const MAX_TEXT = 4096;
const MAX_SLOT_CHARS = 256;
const MAX_TITLE_CHARS = 256;

/** Thrown for a malformed frame, record or key; never carries key material. */
export class PtyProtocolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PtyProtocolError";
	}
}

/** A reassembled line passed its bound; a writer is refused `line-too-long` rather than disconnected. */
export class PtyRpcLineTooLongError extends PtyProtocolError {
	constructor() {
		super("a line exceeds its bound");
		this.name = "PtyRpcLineTooLongError";
	}
}

/** Mint the token one broker generation authenticates with. Never logged. */
export function createPtyToken(): string {
	return randomBytes(PTY_KEY_BYTES).toString("base64url");
}

/** Mint a fresh connection nonce. Never reused across connections. */
export function createPtyNonce(): string {
	return randomBytes(PTY_NONCE_BYTES).toString("base64url");
}

/** Mint the identity of one broker process. */
export function createPtyBrokerId(): string {
	return `pty-${randomUUID()}`;
}

/** Mint the generation of one broker start. */
export function createPtyGeneration(): string {
	return `gen-${randomUUID()}`;
}

/** Decode a stored token. The result must never be logged or serialized. */
export function decodePtyToken(token: string): Buffer {
	if (!isPtyToken(token)) {
		throw new PtyProtocolError(`a broker token must be ${PTY_KEY_BYTES} base64url-encoded bytes`);
	}
	const buffer = Buffer.from(token, "base64url");
	if (buffer.length !== PTY_KEY_BYTES) {
		throw new PtyProtocolError(`a broker token must decode to ${PTY_KEY_BYTES} bytes`);
	}
	return buffer;
}

export function isPtyToken(value: unknown): value is string {
	return typeof value === "string" && NONCE_RE.test(value);
}

export function isPtyNonce(value: unknown): value is string {
	return typeof value === "string" && NONCE_RE.test(value);
}

export function isPtyDigest(value: unknown): value is string {
	return typeof value === "string" && DIGEST_RE.test(value);
}

export function isPtyCreationTime(value: unknown): value is string {
	return typeof value === "string" && CREATION_RE.test(value);
}

/** Windows FILETIME ticks (100 ns each) between 1601-01-01 and the Unix epoch. */
const FILETIME_UNIX_EPOCH_TICKS = 116444736000000000n;

/** FILETIME ticks in one millisecond. */
const FILETIME_TICKS_PER_MILLISECOND = 10000n;

/**
 * One creation time of this FILETIME dialect as Unix epoch milliseconds, or `null`.
 *
 * The reading is a wall-clock instant, and this is the only place its 100 ns ticks
 * are converted: the value is truncated to whole milliseconds. `null` is answered for
 * anything that is not a creation time of this dialect, for an instant before the Unix
 * epoch, and for one that would not survive `Number` exactly. A caller compares the
 * result against a millisecond timestamp it stored itself, so `null` always means
 * "not comparable", never "zero".
 */
export function filetimeToEpochMs(value: unknown): number | null {
	if (!isPtyCreationTime(value)) return null;
	const ticks = BigInt(value);
	if (ticks < FILETIME_UNIX_EPOCH_TICKS) return null;
	const milliseconds = (ticks - FILETIME_UNIX_EPOCH_TICKS) / FILETIME_TICKS_PER_MILLISECOND;
	return milliseconds <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(milliseconds) : null;
}

/** A broker-issued identity that looks like `pty-<uuid>` or `gen-<uuid>`. */
function isMintedId(value: unknown, prefix: string): value is string {
	return typeof value === "string" && value.startsWith(prefix) && UUID_RE.test(value.slice(prefix.length));
}

export function isPtyBrokerId(value: unknown): value is string {
	return isMintedId(value, "pty-");
}

export function isPtyGeneration(value: unknown): value is string {
	return isMintedId(value, "gen-");
}

/**
 * A slot names the writer this broker owns. It is not a capability: the record's
 * token is what authenticates, and the slot only has to be stable across an
 * extension-host reload so a reconnecting window finds the same broker instead of
 * starting a second writer.
 */
export function isPtySlot(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= MAX_SLOT_CHARS &&
		/^[A-Za-z0-9:._/\\-]+$/.test(value)
	);
}

/** What a broker's child is: a managed session, a folder shell, or a standalone Stats dashboard. */
export function isPtyKind(value: unknown): value is PtyKind {
	return value === "managed-rpc" || value === "managed-omp" || value === "folder-shell" || value === "stats-dashboard";
}

/**
 * `managed-omp` hosts the native OMP TUI on a pseudo console. Records of earlier
 * chat-embedded TUI slots use the same kind and stay parseable so they can still be
 * probed and stopped.
 */
export type PtyKind = "managed-rpc" | "managed-omp" | "folder-shell" | "stats-dashboard";
export type PtyChildState = "running" | "exited";

// Owner watch (ADR-0030)

/**
 * What the extension host reports about *itself* when it asks the broker to watch
 * for the exit of the VS Code instance that owns it.
 *
 * These three numbers are **hints, never authority**: every one of them is read
 * again from the kernel by the broker's private helper, which requires the live
 * extension host's actual parent, its kernel creation time, its executable image
 * and its role to agree with the candidate main process. A hint that cannot be
 * confirmed disarms automatic stopping rather than being trusted.
 */
export interface PtyOwnerHint {
	/** The extension host's own `process.pid`. */
	readonly extensionHostPid: number;
	/** The extension host's own `process.ppid`; for a utility-process fork this is the VS Code main process. */
	readonly parentPid: number;
	/** The candidate owning main process: `VSCODE_PID` when the host could validate it. */
	readonly mainPid: number;
}

export function isPtyOwnerHint(value: unknown): value is PtyOwnerHint {
	if (typeof value !== "object" || value === null) return false;
	const hint = value as Record<string, unknown>;
	for (const field of ["extensionHostPid", "parentPid", "mainPid"] as const) {
		const candidate = hint[field];
		if (!Number.isSafeInteger(candidate) || (candidate as number) < 1) return false;
	}
	// A candidate main process that is this very process cannot be the owner of this process.
	return hint.extensionHostPid !== hint.mainPid;
}

/**
 * Where this broker's automatic folder-shell stop stands: what it will do when the
 * admitted owning VS Code instance exits, and what it will refuse to do.
 *
 * `not-applicable` is a managed OMP host, which no automatic rule ever stops.
 * `disarmed` means nothing automatic is in effect: no owning main has been positively
 * attested *yet*, the association could not be attested, or the helper failed. In every
 * case the shell is left alive for an explicit Close, and `detail` says which. `armed`,
 * `grace`, `stopping` and `stopped` describe a positively attested owner set moving
 * through its finite grace to the one stop attempt this design performs.
 */
export type PtyOwnerStopState = "not-applicable" | "disarmed" | "armed" | "grace" | "stopping" | "stopped";

/** One admitted owning-main generation and whether its retained handle signaled. */
export interface PtyOwnerMainRecord {
	/** The attested main process id. */
	readonly pid: number;
	/** Its kernel creation time, as the helper read it through its own handle. */
	readonly creationTime: string;
	/** `true` once the retained handle signaled, which is an exit, not a guess. */
	readonly signaled: boolean;
	/** When this broker admitted the generation, on its own start-relative clock. */
	readonly admittedAtMs: number;
}

export interface PtyOwnerStopStatus {
	readonly state: PtyOwnerStopState;
	/** Why the state is what it is. Never a promise about a process that was not attested. */
	readonly detail: string;
	/** Every admitted generation, in admission order. Empty unless one was attested. */
	readonly owners: readonly PtyOwnerMainRecord[];
	/** Milliseconds left in the running grace window, or `null` when none is running. */
	readonly graceRemainingMs: number | null;
}

/** Generations one broker admits: an instance has windows, not an unbounded set. */
export const PTY_MAX_OWNER_GENERATIONS = 8;

/** Finite grace between "every admitted main signaled" and the stop attempt. */
export const PTY_DEFAULT_OWNER_GRACE_MS = 60_000;

/** Bounds a caller may set the grace to, so it stays finite and observable. */
export const PTY_OWNER_GRACE_RANGE = { min: 1_000, max: 24 * 3600_000 } as const;

/** Largest detail string a status may carry. */
export const PTY_MAX_OWNER_DETAIL_CHARS = 512;

export function isPtyOwnerMainRecord(value: unknown): value is PtyOwnerMainRecord {
	if (typeof value !== "object" || value === null) return false;
	const owner = value as Record<string, unknown>;
	if (!Number.isSafeInteger(owner.pid) || (owner.pid as number) < 1) return false;
	if (!isPtyCreationTime(owner.creationTime)) return false;
	if (typeof owner.signaled !== "boolean") return false;
	return Number.isSafeInteger(owner.admittedAtMs) && (owner.admittedAtMs as number) >= 0;
}

export function isPtyOwnerStopStatus(value: unknown): value is PtyOwnerStopStatus {
	if (typeof value !== "object" || value === null) return false;
	const status = value as Record<string, unknown>;
	if (
		status.state !== "not-applicable" &&
		status.state !== "disarmed" &&
		status.state !== "armed" &&
		status.state !== "grace" &&
		status.state !== "stopping" &&
		status.state !== "stopped"
	) {
		return false;
	}
	if (!isBoundedPtyText(status.detail, PTY_MAX_OWNER_DETAIL_CHARS)) return false;
	if (!Array.isArray(status.owners) || status.owners.length > PTY_MAX_OWNER_GENERATIONS) return false;
	if (status.owners.some(owner => !isPtyOwnerMainRecord(owner))) return false;
	return status.graceRemainingMs === null || (Number.isSafeInteger(status.graceRemainingMs) && (status.graceRemainingMs as number) >= 0);
}

// Durable record

/**
 * The record a broker claims its slot with, inside verified private storage.
 *
 * It carries the endpoint, the token and the static identities only. Everything
 * that changes while the broker runs — the child's identity, its size, whether it
 * exited, who owns input — is answered live over an authenticated connection, so
 * this file is written exactly once and never rewritten under a reader.
 */
export interface PtyBrokerRecord {
	readonly version: typeof PTY_RECORD_VERSION;
	readonly service: typeof PTY_SERVICE;
	readonly protocolVersion: number;
	readonly runtimeVersion: number;
	/** Digest of the staged runtime tree this broker runs from; a build identity. */
	readonly treeDigest: string;
	readonly brokerId: string;
	readonly generation: string;
	readonly slot: string;
	readonly kind: PtyKind;
	/** Loopback port the broker listens on; the address is always 127.0.0.1. */
	readonly port: number;
	/** Bearer token for this generation. Owner-only storage is what protects it. */
	readonly token: string;
	readonly brokerPid: number;
	/** Kernel creation time of `brokerPid`, or `null` when it could not be read. */
	readonly brokerCreationTime: string | null;
	readonly startedAt: string;
	readonly cols: number;
	readonly rows: number;
	readonly title: string | null;
}

export const PTY_RECORD_VERSION = 1;
export const PTY_RECORD_SUFFIX = ".json";

/** Parse and validate a record read from disk. Anything malformed is refused. */
export function parsePtyBrokerRecord(value: unknown): PtyBrokerRecord {
	if (typeof value !== "object" || value === null) throw new PtyProtocolError("a broker record must be an object");
	const record = value as Record<string, unknown>;
	if (record.version !== PTY_RECORD_VERSION) {
		throw new PtyProtocolError(`a broker record must have version ${PTY_RECORD_VERSION}`);
	}
	if (record.service !== PTY_SERVICE) throw new PtyProtocolError(`a broker record must name the service ${PTY_SERVICE}`);
	const protocolVersion = intOf(record.protocolVersion, "protocolVersion");
	const runtimeVersion = intOf(record.runtimeVersion, "runtimeVersion");
	if (!isPtyDigest(record.treeDigest)) throw new PtyProtocolError("a broker record must carry the runtime tree digest");
	if (!isPtyBrokerId(record.brokerId)) throw new PtyProtocolError("a broker record must carry a broker id");
	if (!isPtyGeneration(record.generation)) throw new PtyProtocolError("a broker record must carry a generation");
	if (!isPtySlot(record.slot)) throw new PtyProtocolError("a broker record must carry a slot");
	if (!isPtyKind(record.kind)) throw new PtyProtocolError("a broker record must carry a kind");
	const port = intOf(record.port, "port");
	if (port < 1 || port > 65535) throw new PtyProtocolError("a broker record's port must be a loopback port");
	if (!isPtyToken(record.token)) throw new PtyProtocolError("a broker record must carry a token");
	const brokerPid = intOf(record.brokerPid, "brokerPid");
	if (brokerPid < 1) throw new PtyProtocolError("a broker record must carry its own process id");
	const brokerCreationTime = record.brokerCreationTime === null ? null : record.brokerCreationTime;
	if (brokerCreationTime !== null && !isPtyCreationTime(brokerCreationTime)) {
		throw new PtyProtocolError("a broker record's creation time must be a FILETIME decimal string");
	}
	if (typeof record.startedAt !== "string" || record.startedAt.length === 0) {
		throw new PtyProtocolError("a broker record must carry a start time");
	}
	const cols = intOf(record.cols, "cols");
	const rows = intOf(record.rows, "rows");
	if (cols < PTY_COLUMN_RANGE.min || cols > PTY_COLUMN_RANGE.max) {
		throw new PtyProtocolError("a broker record's columns are out of range");
	}
	if (rows < PTY_ROW_RANGE.min || rows > PTY_ROW_RANGE.max) {
		throw new PtyProtocolError("a broker record's rows are out of range");
	}
	const title = record.title === null ? null : text(record.title, MAX_TITLE_CHARS, "title");
	return {
		version: PTY_RECORD_VERSION,
		service: PTY_SERVICE,
		protocolVersion,
		runtimeVersion,
		treeDigest: record.treeDigest,
		brokerId: record.brokerId,
		generation: record.generation,
		slot: record.slot,
		kind: record.kind,
		port,
		token: record.token,
		brokerPid,
		brokerCreationTime,
		startedAt: record.startedAt,
		cols,
		rows,
		title,
	};
}

// Handshake

export interface PtyHello {
	readonly v: number;
	readonly t: "hello";
	readonly brokerId: string;
	readonly generation: string;
	readonly clientNonce: string;
	/** HMAC over the fields above, keyed by the token. See {@link ptyHelloMac}. */
	readonly mac: string;
}

export interface PtyHelloOk {
	readonly v: number;
	readonly t: "hello-ok";
	readonly brokerId: string;
	readonly generation: string;
	readonly serverNonce: string;
	readonly slot: string;
	readonly kind: PtyKind;
	readonly protocolVersion: number;
	readonly runtimeVersion: number;
	readonly treeDigest: string;
	readonly brokerPid: number;
	readonly brokerCreationTime: string | null;
	/** HMAC proving the token, and pinning the broker's own claimed identity. */
	readonly mac: string;
}

function mac(key: string | Buffer, text: string): string {
	const secret = typeof key === "string" ? decodePtyToken(key) : key;
	return createHmac("sha256", secret).update(text, "utf8").digest("base64url");
}

function macEquals(expected: string, actual: unknown): boolean {
	if (typeof actual !== "string" || actual.length !== expected.length) return false;
	return timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(actual, "utf8"));
}

/** Field-delimited binding so no two field values can be concatenated ambiguously. */
function binding(parts: readonly (string | number | null)[]): string {
	return JSON.stringify([`${PTY_SERVICE}/v${PTY_PROTOCOL_VERSION}`, ...parts]);
}

/** Client proof that it holds the token and means this broker generation. */
export function ptyHelloMac(
	token: string | Buffer,
	input: { readonly brokerId: string; readonly generation: string; readonly clientNonce: string },
): string {
	return mac(token, binding(["hello", PTY_PROTOCOL_VERSION, input.brokerId, input.generation, input.clientNonce]));
}

export function verifyPtyHelloMac(
	token: string | Buffer,
	input: { readonly brokerId: string; readonly generation: string; readonly clientNonce: string },
	received: unknown,
): boolean {
	try {
		return macEquals(ptyHelloMac(token, input), received);
	} catch {
		return false;
	}
}

/**
 * Broker proof that it holds the token, plus the identity it claims for itself.
 *
 * The creation time is inside the MAC, so a client that has already taken its own
 * kernel reading for that pid can require the two to be equal: a different process
 * cannot produce this MAC, and cannot change the number without the token.
 */
export function ptyHelloOkMac(
	token: string | Buffer,
	input: {
		readonly brokerId: string;
		readonly generation: string;
		readonly slot: string;
		readonly clientNonce: string;
		readonly serverNonce: string;
		readonly brokerPid: number;
		readonly brokerCreationTime: string | null;
	},
): string {
	return mac(
		token,
		binding([
			"host",
			PTY_PROTOCOL_VERSION,
			input.brokerId,
			input.generation,
			input.slot,
			input.clientNonce,
			input.serverNonce,
			input.brokerPid,
			input.brokerCreationTime ?? "",
		]),
	);
}

export function verifyPtyHelloOkMac(
	token: string | Buffer,
	input: Parameters<typeof ptyHelloOkMac>[1],
	received: unknown,
): boolean {
	try {
		return macEquals(ptyHelloOkMac(token, input), received);
	} catch {
		return false;
	}
}

/** The key every frame of one connection is authenticated with. */
export function derivePtySessionKey(token: string | Buffer, clientNonce: string, serverNonce: string): Buffer {
	const secret = typeof token === "string" ? decodePtyToken(token) : token;
	return createHmac("sha256", secret).update(`pty.session\0${clientNonce}\0${serverNonce}`, "utf8").digest();
}

/** Non-secret label naming one connection, used to separate its MAC domain. */
export function derivePtySessionId(sessionKey: Buffer): string {
	return createHash("sha256").update(sessionKey).digest("base64url");
}

// Frames

export type PtyStopMode = "graceful" | "force";
/** Descendant verification is an answer, not an assumption: `unknown` is never rounded to `empty`. */
export type PtyTreeVerdict = "empty" | "remaining" | "unknown";

export interface PtyStatusPayload {
	readonly state: PtyChildState;
	readonly exitCode: number | null;
	readonly signal: number | null;
	/** Plain-text managed-RPC stderr tail on exit; absent for native Terminal children. */
	readonly stderrTail?: string;
	readonly cols: number;
	readonly rows: number;
	readonly alt: boolean;
	readonly title: string | null;
	readonly nativePid: number;
	readonly nativeCreationTime: string | null;
	readonly brokerPid: number;
	readonly brokerCreationTime: string | null;
	readonly clients: number;
	readonly inputOwner: string | null;
	readonly uptimeMs: number;
	/**
	 * How long this broker has had no authenticated client, or `null` while one is
	 * attached. It is the broker's own clock, so a host that restarts can still tell
	 * how long a surviving writer — or an orphaned folder shell — has been alone.
	 */
	readonly noClientForMs: number | null;
	/** When the child exited, on this broker's monotonic start-relative clock. */
	readonly childExitedAtMs: number | null;
	/** Position of the next output character; a replay asks for this position or earlier. */
	readonly outputPosition: number;
	/** Oldest position still retained for an exact replay. */
	readonly oldestPosition: number;
	/** Broker-side warnings that affect what a caller may claim (never a guess). */
	readonly notices: readonly string[];
	/**
	 * What this broker will do about the exit of its owning VS Code instance
	 * (ADR-0030). Always present, so a caller can never present an automatic
	 * cleanup as a promise the broker did not make: `not-applicable` for a managed
	 * host, `disarmed` with the reason when the association was not attested.
	 */
	readonly ownerStop: PtyOwnerStopStatus;
}

/**
 * What one serialized screen is: the fields a renderer needs to present it, and the
 * output position the serialization is consistent with.
 */
export interface PtySnapshotMeta {
	/** Output position whose bytes are exactly what this serialization shows. */
	readonly position: number;
	readonly cols: number;
	readonly rows: number;
	readonly alt: boolean;
	readonly title: string | null;
	readonly cursorX: number;
	readonly cursorY: number;
	readonly cursorVisible: boolean;
	readonly chunks: number;
	readonly chars: number;
	/** Set when older scrollback was left out of this serialization. */
	readonly truncated: boolean;
	/** How the chunk data must be interpreted by the renderer. */
	readonly encoding: "ansi";
}

export interface PtyStopResult {
	readonly verified: boolean;
	readonly mode: PtyStopMode;
	readonly nativePid: number;
	/** The child process is gone, proven by a fresh kernel creation-time reading. */
	readonly pidGone: boolean;
	/**
	 * What the descendant evidence says. `empty` means no live process names the stopped
	 * pid — or any descendant observed before the stop — as its parent, and every
	 * observed descendant was read as gone. It is not a kernel-enforced group: see
	 * {@link treeEvidence}.
	 */
	readonly tree: PtyTreeVerdict;
	/** Which method produced `tree`, so a caller knows exactly what was proved. */
	readonly treeEvidence: PtyTreeEvidence;
	readonly remainingPids: readonly number[];
	/** Descendants seen alive before the stop, each re-read after it. */
	readonly checkedPids: readonly number[];
	readonly exitCode: number | null;
	readonly detail: string;
}

/**
 * How a stop's descendant verdict was reached.
 *
 * `descendants-observed` is the strongest evidence this provider can produce on
 * Windows without a kernel-enforced group: the descendant closure was read from the
 * live process table *before* the stop, and every process in it was re-read afterwards.
 * A process whose only link to the child was through an intermediary that had already
 * exited before that reading cannot appear in any parent-link walk, so this is not a
 * universal exclusion — that requires a Job Object (or equivalent grouping), which
 * node-pty does not expose here. `parent-links-only` means even the pre-stop reading
 * was unavailable, and `unavailable` means neither could be read.
 */
export type PtyTreeEvidence = "descendants-observed" | "parent-links-only" | "unavailable";

/**
 * What a client asks the broker for.
 *
 * Requests and events are separate types even where they share a `t`: a `status`
 * *request* carries no status, and a `status` *event* carries no request meaning, so
 * the compiler — not a convention — is what keeps the two directions apart. The
 * transport fields (`seq`, `mac`) are added by {@link encodePtyFrame} and verified by
 * {@link parsePtyFrame}, so a caller constructs a body and never invents a proof.
 */
export type PtyRequestFrame =
	| {
			readonly v: number;
			readonly t: "attach";
			readonly id: number;
			/** Replay everything from this output position onward, exactly. */
			readonly sincePosition: number;
	  }
	| {
			readonly v: number;
			readonly t: "snapshot";
			readonly id: number;
	  }
	| {
			readonly v: number;
			readonly t: "status";
			readonly id: number;
	  }
	| {
			readonly v: number;
			readonly t: "input";
			readonly id: number;
			readonly frontendId: string;
			readonly data: string;
	  }
	| {
			readonly v: number;
			readonly t: "resize";
			readonly id: number;
			readonly frontendId: string;
			readonly cols: number;
			readonly rows: number;
	  }
	| {
			readonly v: number;
			readonly t: "claim-input";
			readonly id: number;
			readonly frontendId: string;
			/** `true` only when the caller means to take input from a live frontend. */
			readonly takeover: boolean;
	  }
	| {
			readonly v: number;
			readonly t: "release-input";
			readonly id: number;
			readonly frontendId: string;
	  }
	| {
			readonly v: number;
			readonly t: "stop";
			readonly id: number;
			readonly mode: PtyStopMode;
			readonly timeoutMs: number;
	  }
	| {
			readonly v: number;
			readonly t: "shutdown";
			readonly id: number;
			/**
			 * Refuse instead of exiting while the child is not proven gone. Proven means its
			 * exit event arrived, or a stop read the exact process generation as absent from
			 * the kernel — never a numeric-pid liveness guess.
			 */
			readonly requireStopped: boolean;
	  }
	| {
			readonly v: number;
			readonly t: "admit-owner";
			readonly id: number;
			/**
			 * The attaching frontend's own view of its process topology.
			 *
			 * A hint here means "attest this candidate as an owning main". `null` means
			 * "this authenticated frontend exists and cannot attest any owning main" —
			 * which disarms automatic stopping for the shell (ADR-0030), because a live
			 * owner may exist that this shell cannot see. The field is always present, so
			 * "no opinion" is expressed by not sending this request at all.
			 */
			readonly owner: PtyOwnerHint | null;
	  }
	| {
			readonly v: number;
			readonly t: "rpc-attach";
			readonly id: number;
			/** Replay the retained lines with `lineSeq` above this, then stream live. `0` replays everything retained. */
			readonly sinceSeq: number;
	  }
	| {
			readonly v: number;
			readonly t: "rpc-write";
			readonly id: number;
			readonly frontendId: string;
			/** Names one stdin line; its fragments arrive contiguously and in order. */
			readonly writeId: string;
			readonly index: number;
			readonly count: number;
			/** Base64 of at most {@link PTY_RPC_FRAGMENT_RAW_BYTES} raw bytes of the line. */
			readonly data: string;
	  };

/** What the broker answers or pushes. */
export type PtyEventFrame =
	| {
			readonly v: number;
			readonly t: "error";
			readonly code: PtyRefusalCode;
			readonly detail: string;
	  }
	| {
			readonly v: number;
			readonly t: "ack";
			readonly id: number;
			readonly ok: boolean;
			/** Present when `ok` is false. */
			readonly code?: PtyRefusalCode;
			readonly detail?: string;
	  }
	| {
			readonly v: number;
			readonly t: "attached";
			readonly id: number;
			/** The position the replay started at; equal to the requested position. */
			readonly fromPosition: number;
			/** Oldest position the broker still holds; a request below it is truncated. */
			readonly oldestPosition: number;
			readonly truncated: boolean;
			readonly status: PtyStatusPayload;
	  }
	| {
			readonly v: number;
			readonly t: "output";
			/** Output position of the first character in `data`. */
			readonly fromPosition: number;
			readonly data: string;
	  }
	| {
			readonly v: number;
			readonly t: "snapshot";
			readonly id: number;
			readonly meta: PtySnapshotMeta;
	  }
	| {
			readonly v: number;
			readonly t: "snapshot-data";
			readonly id: number;
			readonly index: number;
			readonly data: string;
	  }
	| {
			readonly v: number;
			readonly t: "status";
			readonly id: number;
			readonly status: PtyStatusPayload;
	  }
	| {
			readonly v: number;
			readonly t: "state";
			readonly status: PtyStatusPayload;
	  }
	| {
			readonly v: number;
			readonly t: "stopped";
			readonly id: number;
			readonly result: PtyStopResult;
	  }
	| {
			readonly v: number;
			readonly t: "input-owner";
			readonly id: number;
			readonly frontendId: string | null;
			readonly previous: string | null;
	  }
	| {
			readonly v: number;
			readonly t: "shutdown-ok";
			readonly id: number;
			/** Whether the child was already gone when the broker left: an exit event, or a stop's proof of its absence. */
			readonly stopped: boolean;
	  }
	| {
			readonly v: number;
			readonly t: "owner-stop";
			/** The `admit-owner` this answers, or `0` for a push after a change. */
			readonly id: number;
			readonly status: PtyOwnerStopStatus;
	  }
	| {
			readonly v: number;
			readonly t: "rpc-attached";
			readonly id: number;
			readonly fromSeq: number;
			/** Oldest `seq` a replay can still deliver; `latestSeq + 1` when none. */
			readonly oldestSeq: number;
			readonly latestSeq: number;
			/** Lines this attach asked for were evicted (or the requested `sinceSeq` is not this child's). */
			readonly truncated: boolean;
			/** An unanswered `extension_ui_request` exceeded its reserved budget (none was evicted). */
			readonly pinnedOverflow: boolean;
			/** Protocol the broker negotiated with the child; `null` until `ready` was seen and negotiation settled. */
			readonly rpcProtocol: 1 | 2 | null;
			/** The child's `ready` line verbatim, or `null` before it was seen. */
			readonly ready: string | null;
			readonly child: PtyStatusPayload;
	  }
	| {
			readonly v: number;
			readonly t: "rpc-line";
			/**
			 * Per-child line number; gaps (superseded or unretained lines) carry no meaning. Named
			 * `lineSeq` because `seq` is the transport's own per-connection frame number.
			 */
			readonly lineSeq: number;
			readonly index: number;
			readonly count: number;
			readonly data: string;
	  }
	| {
			readonly v: number;
			readonly t: "rpc-ready";
			readonly rpcProtocol: 1 | 2;
			readonly ready: string;
	  }
	| {
			readonly v: number;
			readonly t: "rpc-stderr";
			readonly data: string;
	  };

/** Any frame body either direction carries, for the one codec both ends share. */
export type PtyFrameBody = PtyRequestFrame | PtyEventFrame;

/** Handshake frames, which carry no sequence number: they precede the session key. */
export type PtyHandshakeFrame = PtyHello | PtyHelloOk;
export type PtyOpeningFrame = PtyHello | PtyHelloOk | Extract<PtyEventFrame, { readonly t: "error" }>;

export type PtyFrameType = PtyFrame["t"];

/**
 * Why a frame, a handshake or a request was refused. Codes are stable, carry no
 * peer-controlled text, and are safe to surface.
 */
export type PtyRefusalCode =
	| "unauthorized"
	| "generation-mismatch"
	| "protocol-mismatch"
	| "malformed"
	| "frame-too-large"
	| "unknown-request"
	| "not-attached"
	| "input-not-owner"
	| "no-input-owner"
	| "invalid-size"
	| "child-exited"
	| "child-alive"
	| "stop-uncertain"
	| "busy"
	| "wrong-kind"
	| "line-too-long"
	| "internal";

/**
 * Serialize one frame with its MAC.
 *
 * The MAC covers the frame's canonical JSON with `mac` removed, plus the session
 * label and the sequence number, so a frame cannot be replayed onto another
 * connection, reordered, or edited in any field.
 */
export function encodePtyFrame(sessionKey: Buffer, sessionId: string, seq: number, frame: PtyFrameBody): string {
	const payload = canonicalJson({ ...frame, seq });
	const digest = createHmac("sha256", sessionKey)
		.update(`pty.frame\0${sessionId}\0${seq}\0${payload}`, "utf8")
		.digest("base64url");
	return `${JSON.stringify({ ...frame, seq, mac: digest })}\n`;
}

/**
 * A frame either direction carries, once its version, sequence number and proof have
 * been verified.
 *
 * The body is not trusted on sight: `direction` decides which set of types the frame
 * may be, and the fields of that type are checked, so a peer cannot send an event type
 * where a request was expected, a request type where an event was expected, or a frame
 * whose `t` is right and whose fields are not. The MAC covers every field, including
 * `v`, `seq` and `t`, so the type and its fields are authenticated as well as checked.
 */
export type PtyFrame = PtyClientFrame | PtyBrokerFrame;
export type PtyClientFrame = PtyRequestFrame & { readonly seq: number; readonly mac: string };
export type PtyBrokerFrame = PtyEventFrame & { readonly seq: number; readonly mac: string };

export type PtyDirection = "client-to-broker" | "broker-to-client";

const REQUEST_TYPES: Record<string, true> = {
	attach: true,
	snapshot: true,
	status: true,
	input: true,
	resize: true,
	"claim-input": true,
	"release-input": true,
	stop: true,
	shutdown: true,
	"admit-owner": true,
	"rpc-attach": true,
	"rpc-write": true,
};

const EVENT_TYPES: Record<string, true> = {
	error: true,
	ack: true,
	attached: true,
	output: true,
	state: true,
	"snapshot-data": true,
	"input-owner": true,
	"shutdown-ok": true,
	stopped: true,
	"owner-stop": true,
	"rpc-attached": true,
	"rpc-line": true,
	"rpc-ready": true,
	"rpc-stderr": true,
};

/** Types that exist in both directions with the same `t`; the presence of the payload field tells the directions apart. */
const SHARED_TYPES: Record<string, true> = { status: true, snapshot: true };

/**
 * Pushes a broker sends without being asked. They carry no request id at all, because
 * no request is behind them (an `error` may even refuse a connection that has made
 * none yet).
 */
const IDLESS_TYPES: Record<string, true> = { output: true, state: true, error: true, "rpc-line": true, "rpc-ready": true, "rpc-stderr": true };

/**
 * Pushes that also answer a request: the id of that request, or `0` when the broker
 * pushed them because a state changed rather than because it was asked.
 */
const PUSH_ID_TYPES: Record<string, true> = { "input-owner": true, "owner-stop": true };

/** A non-negative safe integer: an output position or a chunk index. */
function isPtyCounter(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

/** Text a frame can carry: a string within the bound its field allows. */
function isBoundedPtyText(value: unknown, limit: number): value is string {
	return typeof value === "string" && value.length <= limit;
}

export function isPtySnapshotMeta(value: unknown): value is PtySnapshotMeta {
	if (typeof value !== "object" || value === null) return false;
	const meta = value as Record<string, unknown>;
	if (!isPtyCounter(meta.position)) return false;
	if (!Number.isInteger(meta.cols) || !Number.isInteger(meta.rows)) return false;
	if (typeof meta.alt !== "boolean" || typeof meta.cursorVisible !== "boolean") return false;
	if (!isPtyCounter(meta.cursorX) || !isPtyCounter(meta.cursorY)) return false;
	if (meta.title !== null && !isBoundedPtyText(meta.title, PTY_MAX_TITLE_CHARS)) return false;
	if (!isPtyCounter(meta.chunks)) return false;
	if (!isPtyCounter(meta.chars) || (meta.chars as number) > PTY_MAX_SNAPSHOT_CHARS) return false;
	if (typeof meta.truncated !== "boolean") return false;
	return meta.encoding === "ansi";
}

function isPtyRefusalCode(value: unknown): value is PtyRefusalCode {
	return typeof value === "string" && /^[a-z][a-z-]{0,31}$/.test(value);
}

/**
 * The body a line carries for one direction, or `null` when it is not one this
 * direction may send.
 *
 * `null` is a refusal the caller turns into a closed connection: an unknown type, a
 * type belonging to the other direction, or a known type whose fields are missing or
 * of the wrong shape.
 */
function narrowPtyFrame(record: Record<string, unknown>, direction: PtyDirection): PtyFrameBody | null {
	const type = record.t;
	if (typeof type !== "string") return null;
	const allowed = direction === "client-to-broker" ? REQUEST_TYPES : EVENT_TYPES;
	if (allowed[type] !== true && SHARED_TYPES[type] !== true) return null;
	// Requests and the events answering them carry a positive request id. A push carries
	// none, or (`PUSH_ID_TYPES`) the id of the request it answers, or `0` when nothing asked.
	if (IDLESS_TYPES[type] === true) {
		if (record.id !== undefined) return null;
	} else if (PUSH_ID_TYPES[type] === true) {
		if (!isPtyCounter(record.id)) return null;
	} else if (!isPtyRequestId(record.id)) {
		return null;
	}
	if (SHARED_TYPES[type] === true) {
		// `status` and `snapshot` exist in both directions with the same `t`: the event
		// carries the payload and the request does not, and a frame may not blur the two.
		const carriesPayload = type === "status" ? "status" in record : "meta" in record;
		if (carriesPayload !== (direction === "broker-to-client")) return null;
	}
	switch (type) {
		case "attach":
			return isPtyCounter(record.sincePosition) ? { v: PTY_PROTOCOL_VERSION, t: "attach", id: record.id as number, sincePosition: record.sincePosition } : null;
		case "snapshot":
			return "meta" in record
				? isPtySnapshotMeta(record.meta)
					? { v: PTY_PROTOCOL_VERSION, t: "snapshot", id: record.id as number, meta: record.meta }
					: null
				: { v: PTY_PROTOCOL_VERSION, t: "snapshot", id: record.id as number };
		case "snapshot-data":
			return isPtyCounter(record.index) && typeof record.data === "string"
				? { v: PTY_PROTOCOL_VERSION, t: "snapshot-data", id: record.id as number, index: record.index, data: record.data }
				: null;
		case "status":
			return "status" in record
				? isPtyStatusPayload(record.status)
					? { v: PTY_PROTOCOL_VERSION, t: "status", id: record.id as number, status: record.status }
					: null
				: { v: PTY_PROTOCOL_VERSION, t: "status", id: record.id as number };
		case "state":
			return isPtyStatusPayload(record.status) ? { v: PTY_PROTOCOL_VERSION, t: "state", status: record.status } : null;
		case "attached":
			return isPtyCounter(record.fromPosition) &&
				isPtyCounter(record.oldestPosition) &&
				typeof record.truncated === "boolean" &&
				isPtyStatusPayload(record.status)
				? {
						v: PTY_PROTOCOL_VERSION,
						t: "attached",
						id: record.id as number,
						fromPosition: record.fromPosition,
						oldestPosition: record.oldestPosition,
						truncated: record.truncated,
						status: record.status,
					}
				: null;
		case "output":
			return isPtyCounter(record.fromPosition) && typeof record.data === "string"
				? { v: PTY_PROTOCOL_VERSION, t: "output", fromPosition: record.fromPosition, data: record.data }
				: null;
		case "input":
			return isPtyFrontendId(record.frontendId) && typeof record.data === "string"
				? { v: PTY_PROTOCOL_VERSION, t: "input", id: record.id as number, frontendId: record.frontendId, data: record.data }
				: null;
		case "resize":
			return isPtyFrontendId(record.frontendId) && Number.isSafeInteger(record.cols) && Number.isSafeInteger(record.rows)
				? {
						v: PTY_PROTOCOL_VERSION,
						t: "resize",
						id: record.id as number,
						frontendId: record.frontendId,
						cols: record.cols as number,
						rows: record.rows as number,
					}
				: null;
		case "claim-input":
			return isPtyFrontendId(record.frontendId) && typeof record.takeover === "boolean"
				? { v: PTY_PROTOCOL_VERSION, t: "claim-input", id: record.id as number, frontendId: record.frontendId, takeover: record.takeover }
				: null;
		case "release-input":
			return isPtyFrontendId(record.frontendId)
				? { v: PTY_PROTOCOL_VERSION, t: "release-input", id: record.id as number, frontendId: record.frontendId }
				: null;
		case "input-owner":
			return (record.frontendId === null || isPtyFrontendId(record.frontendId)) && (record.previous === null || isPtyFrontendId(record.previous))
				? {
						v: PTY_PROTOCOL_VERSION,
						t: "input-owner",
						id: record.id as number,
						frontendId: record.frontendId as string | null,
						previous: record.previous as string | null,
					}
				: null;
		case "stop":
			return (record.mode === "graceful" || record.mode === "force") && Number.isSafeInteger(record.timeoutMs)
				? { v: PTY_PROTOCOL_VERSION, t: "stop", id: record.id as number, mode: record.mode, timeoutMs: record.timeoutMs as number }
				: null;
		case "stopped":
			return isPtyStopResult(record.result) ? { v: PTY_PROTOCOL_VERSION, t: "stopped", id: record.id as number, result: record.result } : null;
		case "shutdown":
			return typeof record.requireStopped === "boolean"
				? { v: PTY_PROTOCOL_VERSION, t: "shutdown", id: record.id as number, requireStopped: record.requireStopped }
				: null;
		case "admit-owner":
			return record.owner === null || isPtyOwnerHint(record.owner)
				? { v: PTY_PROTOCOL_VERSION, t: "admit-owner", id: record.id as number, owner: record.owner }
				: null;
		case "owner-stop":
			return isPtyOwnerStopStatus(record.status)
				? { v: PTY_PROTOCOL_VERSION, t: "owner-stop", id: record.id as number, status: record.status }
				: null;
		case "shutdown-ok":
			return typeof record.stopped === "boolean"
				? { v: PTY_PROTOCOL_VERSION, t: "shutdown-ok", id: record.id as number, stopped: record.stopped }
				: null;
		case "ack":
			return typeof record.ok === "boolean" &&
				(record.code === undefined || isPtyRefusalCode(record.code)) &&
				(record.detail === undefined || typeof record.detail === "string")
				? {
						v: PTY_PROTOCOL_VERSION,
						t: "ack",
						id: record.id as number,
						ok: record.ok,
						...(record.code === undefined ? {} : { code: record.code }),
						...(record.detail === undefined ? {} : { detail: record.detail }),
					}
				: null;
		case "error":
			return isPtyRefusalCode(record.code) && typeof record.detail === "string"
				? { v: PTY_PROTOCOL_VERSION, t: "error", code: record.code, detail: record.detail }
				: null;
		case "rpc-attach":
			return isPtyCounter(record.sinceSeq)
				? { v: PTY_PROTOCOL_VERSION, t: "rpc-attach", id: record.id as number, sinceSeq: record.sinceSeq }
				: null;
		case "rpc-write":
			return isPtyFrontendId(record.frontendId) &&
				isPtyFrontendId(record.writeId) &&
				isPtyRpcFragmentPosition(record.index, record.count) &&
				isPtyRpcBase64(record.data)
				? {
						v: PTY_PROTOCOL_VERSION,
						t: "rpc-write",
						id: record.id as number,
						frontendId: record.frontendId,
						writeId: record.writeId,
						index: record.index as number,
						count: record.count as number,
						data: record.data,
					}
				: null;
		case "rpc-attached":
			return isPtyCounter(record.fromSeq) &&
				isPtyCounter(record.oldestSeq) &&
				isPtyCounter(record.latestSeq) &&
				typeof record.truncated === "boolean" &&
				typeof record.pinnedOverflow === "boolean" &&
				(record.rpcProtocol === null || record.rpcProtocol === 1 || record.rpcProtocol === 2) &&
				(record.ready === null || isBoundedPtyText(record.ready, PTY_RPC_MAX_READY_CHARS)) &&
				isPtyStatusPayload(record.child)
				? {
						v: PTY_PROTOCOL_VERSION,
						t: "rpc-attached",
						id: record.id as number,
						fromSeq: record.fromSeq,
						oldestSeq: record.oldestSeq,
						latestSeq: record.latestSeq,
						truncated: record.truncated,
						pinnedOverflow: record.pinnedOverflow,
						rpcProtocol: record.rpcProtocol as 1 | 2 | null,
						ready: record.ready as string | null,
						child: record.child,
					}
				: null;
		case "rpc-line":
			return isPtyCounter(record.lineSeq) &&
				isPtyRpcFragmentPosition(record.index, record.count) &&
				isPtyRpcBase64(record.data)
				? {
						v: PTY_PROTOCOL_VERSION,
						t: "rpc-line",
						lineSeq: record.lineSeq,
						index: record.index as number,
						count: record.count as number,
						data: record.data,
					}
				: null;
		case "rpc-ready":
			return (record.rpcProtocol === 1 || record.rpcProtocol === 2) &&
				typeof record.ready === "string" &&
				isBoundedPtyText(record.ready, PTY_RPC_MAX_READY_CHARS)
				? { v: PTY_PROTOCOL_VERSION, t: "rpc-ready", rpcProtocol: record.rpcProtocol, ready: record.ready }
				: null;
		case "rpc-stderr":
			return typeof record.data === "string" && record.data.length <= PTY_RPC_MAX_STDERR_CHARS
				? { v: PTY_PROTOCOL_VERSION, t: "rpc-stderr", data: record.data }
				: null;
		default:
			return null;
	}
}

/**
 * The frame a peer's line carries, or a refusal; never partially trusted.
 *
 * The proof is verified first — the fields below are authenticated, not merely
 * parsed — and then the body is narrowed to what `direction` may send.
 */
export function parsePtyFrame(
	sessionKey: Buffer,
	sessionId: string,
	expectedSeq: number,
	line: string,
	direction: PtyDirection,
): PtyFrame {
	if (Buffer.byteLength(line, "utf8") > PTY_MAX_FRAME_BYTES) {
		throw new PtyProtocolError(`frame above ${PTY_MAX_FRAME_BYTES} bytes`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		throw new PtyProtocolError("frame is not JSON");
	}
	if (typeof parsed !== "object" || parsed === null) throw new PtyProtocolError("frame must be an object");
	const record = parsed as Record<string, unknown>;
	if (record.v !== PTY_PROTOCOL_VERSION) throw new PtyProtocolError("frame names another protocol version");
	if (typeof record.t !== "string") throw new PtyProtocolError("frame has no type");
	const seq = record.seq;
	if (!Number.isSafeInteger(seq) || (seq as number) !== expectedSeq) {
		throw new PtyProtocolError(`frame sequence must be ${expectedSeq}`);
	}
	const received = record.mac;
	const payload = canonicalJson({ ...record, mac: undefined });
	const expected = createHmac("sha256", sessionKey)
		.update(`pty.frame\0${sessionId}\0${expectedSeq}\0${payload}`, "utf8")
		.digest("base64url");
	if (typeof received !== "string" || received.length !== expected.length) {
		throw new PtyProtocolError("frame carries no valid proof");
	}
	if (!timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(received, "utf8"))) {
		throw new PtyProtocolError("frame proof does not match this connection");
	}
	const body = narrowPtyFrame(record, direction);
	if (body === null) {
		throw new PtyProtocolError(`a ${direction} peer sent a ${JSON.stringify(record.t)} frame that is not one it may send`);
	}
	return { ...body, seq: expectedSeq, mac: received };
}

/** Split terminal output into frame-sized chunks without splitting a surrogate pair. */
export function chunkPtyOutput(data: string, limit = PTY_MAX_OUTPUT_CHUNK_CHARS): string[] {
	if (data.length === 0) return [];
	if (data.length <= limit) return [data];
	const chunks: string[] = [];
	let start = 0;
	while (start < data.length) {
		let end = Math.min(start + limit, data.length);
		if (end < data.length) {
			const code = data.charCodeAt(end - 1);
			// Never cut a surrogate pair: the renderer would receive half a character.
			if (code >= 0xd800 && code <= 0xdbff) end -= 1;
			if (end === start) end = start + limit;
		}
		chunks.push(data.slice(start, end));
		start = end;
	}
	return chunks;
}

/** Requests only a pseudo-console child serves; a `managed-rpc` broker refuses them with `wrong-kind`. */
const TERMINAL_ONLY_REQUESTS: Record<string, true> = { attach: true, snapshot: true, input: true, resize: true };

/** Requests only a pipe child serves; every other kind refuses them with `wrong-kind`. */
const RPC_ONLY_REQUESTS: Record<string, true> = { "rpc-attach": true, "rpc-write": true };

export function isPtyTerminalOnlyRequest(type: string): boolean {
	return TERMINAL_ONLY_REQUESTS[type] === true;
}

export function isPtyRpcOnlyRequest(type: string): boolean {
	return RPC_ONLY_REQUESTS[type] === true;
}

/** `count` fragments, `index` among them. A line has at least one fragment. */
function isPtyRpcFragmentPosition(index: unknown, count: unknown): boolean {
	return (
		Number.isSafeInteger(index) &&
		Number.isSafeInteger(count) &&
		(count as number) >= 1 &&
		(count as number) <= Math.ceil(PTY_RPC_MAX_LINE_BYTES / PTY_RPC_FRAGMENT_RAW_BYTES) &&
		(index as number) >= 0 &&
		(index as number) < (count as number)
	);
}

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** Strict standard base64 of at most one fragment: `Buffer.from` alone would accept garbage. */
export function isPtyRpcBase64(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length <= Math.ceil(PTY_RPC_FRAGMENT_RAW_BYTES / 3) * 4 &&
		value.length % 4 === 0 &&
		BASE64_RE.test(value)
	);
}

/** How many fragments carry `byteLength` raw bytes (at least one, so an empty line is still a frame). */
export function ptyRpcFragmentCount(byteLength: number): number {
	return Math.max(1, Math.ceil(byteLength / PTY_RPC_FRAGMENT_RAW_BYTES));
}

/** The base64 of fragment `index` of `bytes`. */
export function ptyRpcFragment(bytes: Buffer, index: number): string {
	const start = index * PTY_RPC_FRAGMENT_RAW_BYTES;
	return bytes.subarray(start, Math.min(bytes.length, start + PTY_RPC_FRAGMENT_RAW_BYTES)).toString("base64");
}

/**
 * Reassemble one line from its fragments.
 *
 * Fragments of a line are contiguous and in order on one connection (other frame types
 * may interleave, other lines' fragments may not), starting at index 0. Anything else is
 * a protocol error: the caller closes the connection rather than guessing where a line
 * began. Bytes are joined before they are decoded, so a fragment boundary may fall inside
 * a UTF-8 sequence.
 */
export class PtyRpcFragmentAssembler {
	private readonly maxBytes: number;
	private key: string | number | null = null;
	private count = 0;
	private next = 0;
	private parts: Buffer[] = [];
	private bytes = 0;

	constructor(maxBytes: number) {
		this.maxBytes = maxBytes;
	}

	/** `true` while a line is partly assembled. */
	get open(): boolean {
		return this.key !== null;
	}

	/** The completed line's bytes when this fragment finished one, else `null`. */
	push(key: string | number, index: number, count: number, data: string): Buffer | null {
		if (this.key === null) {
			if (index !== 0) throw new PtyProtocolError("a line's first fragment must have index 0");
			this.key = key;
			this.count = count;
			this.next = 0;
			this.parts = [];
			this.bytes = 0;
		} else if (this.key !== key || this.count !== count || this.next !== index) {
			this.reset();
			throw new PtyProtocolError("a line's fragments must be contiguous and in order");
		}
		const raw = Buffer.from(data, "base64");
		if (raw.length > PTY_RPC_FRAGMENT_RAW_BYTES) {
			this.reset();
			throw new PtyProtocolError("a fragment carries more than its bound");
		}
		this.bytes += raw.length;
		if (this.bytes > this.maxBytes) {
			this.reset();
			throw new PtyRpcLineTooLongError();
		}
		this.parts.push(raw);
		this.next += 1;
		if (this.next < this.count) return null;
		const line = Buffer.concat(this.parts, this.bytes);
		this.reset();
		return line;
	}

	/** Forget a partly assembled line. */
	reset(): void {
		this.key = null;
		this.count = 0;
		this.next = 0;
		this.parts = [];
		this.bytes = 0;
	}
}

/** `true` when `value` is a usable request id: a positive safe integer. */
export function isPtyRequestId(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) > 0;
}

/** A frontend id is chosen by the caller; it names one input owner at a time. */
export function isPtyFrontendId(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 128 && /^[A-Za-z0-9._:/-]+$/.test(value);
}

export function isPtyStatusPayload(value: unknown): value is PtyStatusPayload {
	if (typeof value !== "object" || value === null) return false;
	const status = value as Record<string, unknown>;
	if (status.state !== "running" && status.state !== "exited") return false;
	if (status.exitCode !== null && !Number.isInteger(status.exitCode)) return false;
	if (status.signal !== null && !Number.isInteger(status.signal)) return false;
	if (status.stderrTail !== undefined && parseChatExitReason({ exitCode: status.exitCode, stderr: status.stderrTail }) === null) return false;
	if (!Number.isInteger(status.cols) || !Number.isInteger(status.rows)) return false;
	if (typeof status.alt !== "boolean") return false;
	if (status.title !== null && !isBoundedPtyText(status.title, PTY_MAX_TITLE_CHARS)) return false;
	if (!Number.isInteger(status.nativePid) || (status.nativePid as number) < 1) return false;
	if (status.nativeCreationTime !== null && !isPtyCreationTime(status.nativeCreationTime)) return false;
	if (!Number.isInteger(status.brokerPid) || (status.brokerPid as number) < 1) return false;
	if (status.brokerCreationTime !== null && !isPtyCreationTime(status.brokerCreationTime)) return false;
	if (!Number.isInteger(status.clients) || !Number.isInteger(status.uptimeMs)) return false;
	if (status.noClientForMs !== null && !Number.isInteger(status.noClientForMs)) return false;
	if (status.childExitedAtMs !== null && !Number.isInteger(status.childExitedAtMs)) return false;
	if (status.inputOwner !== null && !isPtyFrontendId(status.inputOwner)) return false;
	if (!Number.isInteger(status.outputPosition) || !Number.isInteger(status.oldestPosition)) return false;
	if (!Array.isArray(status.notices) || status.notices.some(item => typeof item !== "string")) return false;
	return isPtyOwnerStopStatus(status.ownerStop);
}

export function isPtyStopResult(value: unknown): value is PtyStopResult {
	if (typeof value !== "object" || value === null) return false;
	const result = value as Record<string, unknown>;
	if (typeof result.verified !== "boolean") return false;
	if (result.mode !== "graceful" && result.mode !== "force") return false;
	if (!Number.isInteger(result.nativePid)) return false;
	if (typeof result.pidGone !== "boolean") return false;
	if (result.tree !== "empty" && result.tree !== "remaining" && result.tree !== "unknown") return false;
	if (result.treeEvidence !== "descendants-observed" && result.treeEvidence !== "parent-links-only" && result.treeEvidence !== "unavailable") {
		return false;
	}
	if (!Array.isArray(result.remainingPids) || result.remainingPids.some(pid => !Number.isInteger(pid))) return false;
	if (!Array.isArray(result.checkedPids) || result.checkedPids.some(pid => !Number.isInteger(pid))) return false;
	if (result.exitCode !== null && !Number.isInteger(result.exitCode)) return false;
	return typeof result.detail === "string";
}

function intOf(value: unknown, field: string): number {
	if (!Number.isSafeInteger(value)) throw new PtyProtocolError(`${field} must be a safe integer`);
	return value as number;
}

function text(value: unknown, limit: number, field: string): string {
	if (typeof value !== "string" || value.length === 0 || value.length > limit) {
		throw new PtyProtocolError(`${field} must be a non-empty string of at most ${limit} characters`);
	}
	return value;
}

/** Exported for the broker's argument parsing: bound a caller-supplied title. */
export function parsePtyTitle(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	if (typeof value !== "string") throw new PtyProtocolError("a title must be a string");
	const trimmed = value.trim();
	if (trimmed.length === 0) return null;
	return trimmed.length > MAX_TITLE_CHARS ? trimmed.slice(0, MAX_TITLE_CHARS) : trimmed;
}

/** Clamp a requested terminal size into the range both ends accept. */
export function clampPtySize(
	cols: unknown,
	rows: unknown,
	fallback: { readonly cols: number; readonly rows: number },
): { readonly cols: number; readonly rows: number } {
	const c = Number.isSafeInteger(cols) ? (cols as number) : fallback.cols;
	const r = Number.isSafeInteger(rows) ? (rows as number) : fallback.rows;
	return {
		cols: Math.min(Math.max(c, PTY_COLUMN_RANGE.min), PTY_COLUMN_RANGE.max),
		rows: Math.min(Math.max(r, PTY_ROW_RANGE.min), PTY_ROW_RANGE.max),
	};
}

/** `null` for an unreadable field, so a caller never has to guess a value. */
export function optionalInt(value: unknown): number | null {
	return Number.isSafeInteger(value) ? (value as number) : null;
}
