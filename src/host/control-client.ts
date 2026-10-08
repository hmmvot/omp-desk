/**
 * VS Code-side client for the authenticated host-control channel of
 * [ADR-0003](../../docs/decisions/0003-native-host-control-pipe.md), with the
 * host-generated, peer-verified key delivery of
 * [ADR-0006](../../docs/decisions/0006-host-generated-key-peer-verified-pipe.md).
 *
 * Security and native lifecycle contract (ADR-0040):
 *
 * - **No unchecked socket connect.** The production path is
 *   {@link HostControlClient.connectVerified}: a bounded Windows PowerShell
 *   helper opens the named pipe once, proves the server's kernel identity
 *   (`GetNamedPipeServerProcessId` on that same handle, plus the process creation
 *   time from a retained process handle) and only then relays bounded frames
 *   over its private stdio. There is no fallback to a direct socket, and a
 *   blocked helper refuses visibly. The helper is started from a
 *   content-addressed copy outside the installed extension folder (see
 *   {@link setControlHelperScript}), re-hashed immediately before every spawn, so
 *   a reinstall can rename that folder while a host is being verified and a copy
 *   that changed under us is refused rather than executed.
 * - **The key is generated in OMP and sealed to a launch-pinned recipient.** The
 *   rendezvous carries RSA-OAEP-SHA256 ciphertext, never the plaintext; this side
 *   unwraps a *candidate* and trusts it only after the peer proof and the HMAC
 *   handshake succeed on the same connection. With a `provenKey`, a changed
 *   ciphertext is a rotation only when the record names the pinned pid and the
 *   pinned process (pid and creation time) proves possession of the new key;
 *   {@link HostControlClient.connectWithProvenKey} finds the original server by
 *   the key it already proved, without the record.
 * - The rendezvous remains attacker-controlled: it is re-read and compared before
 *   connecting, and every identity field is checked against the authenticated
 *   challenge.
 * - `snapshot` carries the host binding; `listTools` remains read-only discovery:
 *   no tool invocation, schema, arguments or selection crosses this channel (ADR-0009).
 *   Native state is bounded public-SDK readback; shutdown and rename bind the exact
 *   current epoch/file/id and recheck synchronously before committing. They do not
 *   replace RPC model/thinking/session-name commands or establish native identity settlement.
 *
 * The key is never logged, never sent, and never written anywhere: it is finally
 * handed to the caller only after the genuine host has proved it.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createHash, createPublicKey, generateKeyPair } from "node:crypto";
import { readFile } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { clearTimeout as clearNodeTimeout, setTimeout as setNodeTimeout } from "node:timers";
import {
	CONTROL_MAX_FRAME_BYTES,
	CONTROL_PROTOCOL_VERSION,
	CONTROL_SERVICE,
	type ControlChallengeFrame,
	type ControlErrorCode,
	type ControlErrorFrame,
	type ControlHostBinding,
	type ControlHostSnapshot,
	type ControlMethod,
	type ControlPayload,
	type ControlNativeState,
	type ControlNativeActivity,
	type ControlNativeTarget,
	type ControlNativeShutdownStatus,
	type ControlNativeRenameStatus,
	type ControlRendezvous,
	type ControlResponseFrame,
	type ControlResult,
	type ControlToolList,
	controlDigest,
	controlEndpoint,
	controlPathEquals,
	controlRecipientFingerprint,
	controlRequestMac,
	controlResponseDigest,
	createControlNonce,
	createControlRequestId,
	decodeControlKey,
	decryptControlKeyFromRecipient,
	encodeControlFrame,
	isControlSlotId,
	listControlPipeNames,
	parseControlServerFrame,
	readControlRendezvous,
	verifyControlErrorMac,
	verifyControlHandshakeMac,
	verifyControlResponseMac,
} from "./control-protocol.ts";
import { windowsPowerShellEnvironment, windowsPowerShellExecutable } from "./windows-powershell.ts";

export {
	controlRecipientFingerprint,
	controlRendezvousPath,
	createControlRequestId,
	createControlSlotId,
	readControlRendezvous,
} from "./control-protocol.ts";
export type {
	ControlErrorCode,
	ControlHostBinding,
	ControlHostSnapshot,
	ControlRendezvous,
	ControlToolList,
} from "./control-protocol.ts";

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const PROCESS_PROBE_TIMEOUT_MS = 5_000;
const MAX_MESSAGE_LENGTH = 512;
const MAX_SEEN_SERVER_NONCES = 256;
/** One bridged line carries at most this much base64; frames stay far below it. */
const MAX_BRIDGE_LINE_CHARS = 512 * 1024;
/** PowerShell's decoder refuses a decoded input line above this bound. */
const MAX_BRIDGE_CHUNK_BYTES = 64 * 1024;
const CONTROL_HELPER_BASENAME = "verified-pipe.ps1";

/** Local misconfiguration: malformed rendezvous, recipient key or options. */
export class HostControlConfigurationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "HostControlConfigurationError";
	}
}

/** The endpoint could not be reached, or the host is gone. */
export class HostControlUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "HostControlUnavailableError";
	}
}

/** Why the peer could not be verified; every one is a visible refusal. */
export type ControlPeerFailure =
	| "helper-unavailable"
	| "pipe-unreachable"
	| "pid-mismatch"
	| "generation-mismatch"
	| "helper-failed"
	| "timeout";

/** The OS-level peer proof failed, so no frame was sent. */
export class HostControlPeerError extends Error {
	readonly reason: ControlPeerFailure;

	constructor(reason: ControlPeerFailure, message: string) {
		super(message);
		this.name = "HostControlPeerError";
		this.reason = reason;
	}
}

/** Why an endpoint or key was refused before a single request was sent. */
export type HostControlIdentityFailure =
	| "key-mismatch"
	| "key-changed"
	| "ciphertext-invalid"
	| "recipient-mismatch"
	| "rendezvous-mismatch"
	| "session-mismatch"
	| "cwd-mismatch";

/** The endpoint could not prove it is the host this caller launched. */
export class HostControlIdentityError extends Error {
	readonly reason: HostControlIdentityFailure;

	constructor(reason: HostControlIdentityFailure, message: string) {
		super(message);
		this.name = "HostControlIdentityError";
		this.reason = reason;
	}
}

/** The host refused the request; `code` is the authoritative classifier. */
export class HostControlRefusedError extends Error {
	readonly code: ControlErrorCode;
	/** Host binding attached to the refusal, when the frame carried one. */
	readonly host: ControlHostBinding | null;

	constructor(code: ControlErrorCode, message: string, host: ControlHostBinding | null) {
		super(message);
		this.name = "HostControlRefusedError";
		this.code = code;
		this.host = host;
	}
}

/** The peer violated the protocol; the channel is closed. */
export class HostControlProtocolViolationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "HostControlProtocolViolationError";
	}
}

/** The call order is wrong, e.g. reading the binding before the handshake or after close. */
export class HostControlUsageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "HostControlUsageError";
	}
}

/** The per-run recipient: public half into argv, private half into SecretStorage. */
export interface ControlRecipient {
	/** base64url DER SPKI; this is what Bun's `--define` literal must carry. */
	readonly publicKeySpkiBase64url: string;
	/** PKCS#8 PEM of the private half; hand straight back to `connectVerified`. */
	readonly privateKeyPkcs8Pem: string;
}

/**
 * Generate the launch recipient. The public half is baked into the native launch
 * through Bun's `--define`; the private half stays in VS Code SecretStorage
 * scoped to the atomic session claim, and is deleted only once native
 * termination is confirmed.
 */
export async function createControlRecipient(): Promise<ControlRecipient> {
	const pair = await new Promise<{ publicKeyDer: Buffer; privateKeyPem: string }>(
		(resolve, reject) => {
			generateKeyPair(
				"rsa",
				{
					modulusLength: 2048,
					publicExponent: 0x10001,
					publicKeyEncoding: { type: "spki", format: "der" },
					privateKeyEncoding: { type: "pkcs8", format: "pem" },
				},
				(error, publicKey, privateKey) => {
					if (error) reject(error);
					else resolve({ publicKeyDer: publicKey, privateKeyPem: privateKey });
				},
			);
		},
	);
	return {
		publicKeySpkiBase64url: pair.publicKeyDer.toString("base64url"),
		privateKeyPkcs8Pem: pair.privateKeyPem,
	};
}

/** The public SPKI (base64url) derived from a recipient private key. */
function recipientPublicKeyOf(privateKeyPkcs8Pem: string): string | null {
	try {
		const der = createPublicKey(privateKeyPkcs8Pem).export({ type: "spki", format: "der" });
		return Buffer.from(der).toString("base64url");
	} catch {
		return null;
	}
}

/** Facts the peer proof produced for the connection a channel carries. */
export interface ControlPeerProof {
	/** PID the OS says owns the server end of that very pipe handle. */
	readonly serverPid: number;
	/** Kernel creation time of that process, FILETIME decimal string. */
	readonly serverCreationTime: string;
}

/** A duplex byte channel whose peer identity was proven on the same handle. */
export interface ControlPeerChannel {
	readonly proof: ControlPeerProof;
	write(bytes: Uint8Array): void;
	onData(listener: (bytes: Buffer) => void): void;
	readonly closed: Promise<string | null>;
	close(): void;
}

/** The verifier is pluggable so tests can supply the same facts in-process. */
export interface ControlPeerBridge {
	open(request: {
		readonly pipeName: string;
		readonly expectedPid: number;
		readonly expectedCreationTime: string;
		readonly timeoutMs: number;
	}): Promise<ControlPeerChannel>;
}

/** The verified helper copy this window runs: its path, and the digest of its bytes. */
let controlHelper: { readonly path: string; readonly sha256: string } | null = null;

/**
 * Point the peer bridge at the verified `verified-pipe.ps1` copy to run.
 *
 * The packaged helper lives inside the installed extension folder, which
 * `code --install-extension <vsix> --force` renames, so nothing here starts
 * PowerShell from that folder: activation stages a content-addressed copy
 * (`src/runtime-assets.ts`) and configures it once, before any peer proof. Until
 * then there is no helper at all, and every proof refuses visibly with
 * `helper-unavailable` — there is still no unchecked fallback.
 *
 * The digest is kept with the path because the helper is re-read and re-hashed
 * immediately before every spawn: a copy that no longer holds those bytes is
 * refused rather than executed under an identity it no longer has.
 */
export function setControlHelperScript(scriptPath: string, sha256: string): void {
	controlHelper = scriptPath.length === 0 ? null : { path: scriptPath, sha256 };
}

interface HelperProcess {
	readonly child: ChildProcess;
	readonly exited: Promise<string | null>;
	/** Typed failure when the helper could not start or exited non-zero. */
	readonly failure: () => ControlPeerFailure | null;
	onLine(listener: (line: string) => void): void;
	writeLine(line: string): void;
	close(): void;
}

/** Spawn the helper with private stdio and line-oriented, bounded output. */
async function spawnControlHelper(args: readonly string[], label: string): Promise<HelperProcess> {
	const helper = controlHelper;
	if (helper === null) {
		throw new HostControlPeerError(
			"helper-unavailable",
			`no verified ${CONTROL_HELPER_BASENAME} copy was staged for this window, so the pipe server's identity cannot be proven`,
		);
	}
	// Re-read immediately before the spawn: a path is not a memory of the bytes that
	// were written to it, and PowerShell is about to run whatever is there now.
	const bytes = await readFile(helper.path).catch(() => null);
	const digest = bytes === null ? null : createHash("sha256").update(bytes).digest("hex");
	if (digest !== helper.sha256) {
		throw new HostControlPeerError(
			"helper-unavailable",
			`the staged ${CONTROL_HELPER_BASENAME} no longer holds the bytes it was staged with, so the pipe server's identity cannot be proven`,
		);
	}
	// The operating system's own interpreter, never a `PATH` look-alike, with a module path it can load.
	const child = spawn(
		windowsPowerShellExecutable(),
		["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helper.path, ...args],
		{ windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: windowsPowerShellEnvironment() },
	);
	const listeners: Array<(line: string) => void> = [];
	const decoder = new StringDecoder("utf8");
	let buffered = "";
	let stderr = "";
	let settled = false;
	let failure: ControlPeerFailure | null = null;
	const exited = Promise.withResolvers<string | null>();

	const finish = (reason: string | null): void => {
		if (settled) return;
		settled = true;
		exited.resolve(reason);
	};
	child.on("error", error => {
		failure = "helper-unavailable";
		finish(`${label} could not start: ${error.message}`);
	});
	child.on("close", code => {
		if (code !== 0) failure ??= "helper-failed";
		finish(code === 0 ? null : `${label} exited with code ${code}`);
	});
	child.stdout?.on("data", (chunk: Buffer) => {
		buffered += decoder.write(chunk);
		for (;;) {
			const newline = buffered.indexOf("\n");
			if (newline < 0) break;
			const line = buffered.slice(0, newline).replace(/\r$/, "");
			buffered = buffered.slice(newline + 1);
			if (line.length === 0) continue;
			if (line.length > MAX_BRIDGE_LINE_CHARS) {
				// A peer that floods the bridge is refused, not buffered.
				failure = "helper-failed";
				for (const listener of listeners) listener("!ERROR line-too-long");
				child.kill();
				return;
			}
			for (const listener of listeners) listener(line);
		}
		if (buffered.length > MAX_BRIDGE_LINE_CHARS) {
			failure = "helper-failed";
			for (const listener of listeners) listener("!ERROR line-too-long");
			child.kill();
		}
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		if (stderr.length < MAX_MESSAGE_LENGTH) stderr += decoder.write(chunk);
	});
	return {
		child,
		exited: exited.promise,
		failure: () => failure,
		onLine(listener) {
			listeners.push(listener);
		},
		writeLine(line) {
			child.stdin?.write(`${line}\n`);
		},
		close() {
			child.stdin?.end();
			child.kill();
			finish("closed by caller");
		},
	};
}

/** `!GENERATION <filetime>` / `!ERROR <code>` from a generation probe. */
const HELPER_FIELD_SEPARATOR = /\s+/;

function parseHelperControlLine(line: string): { kind: string; fields: string[] } | null {
	if (!line.startsWith("!")) return null;
	const fields = line.slice(1).split(HELPER_FIELD_SEPARATOR);
	const kind = fields.shift();
	return kind === undefined ? null : { kind, fields };
}

/**
 * Kernel creation time of `pid`, as the FILETIME decimal string both the probe
 * and the bridge report. Call it promptly after the terminal's process id
 * resolves and record the result with the host ownership: it is the generation
 * the verified connection must still match later.
 */
export async function queryControlProcessGeneration(pid: number): Promise<string> {
	if (process.platform !== "win32") {
		throw new HostControlPeerError(
			"helper-unavailable",
			"process-generation proof is implemented for Windows only",
		);
	}
	if (!Number.isSafeInteger(pid) || pid <= 0) {
		throw new HostControlPeerError("helper-failed", "process id to probe is invalid");
	}
	const helper = await spawnControlHelper(
		["-Mode", "generation", "-TargetPid", String(pid)],
		"process generation probe",
	);
	const answered = Promise.withResolvers<string>();
	helper.onLine(line => {
		const control = parseHelperControlLine(line);
		if (!control) return;
		if (control.kind === "GENERATION" && control.fields[0] !== undefined) {
			answered.resolve(control.fields[0]);
			return;
		}
		if (control.kind === "ERROR") {
			answered.reject(
				new HostControlPeerError("helper-failed", `generation probe failed: ${control.fields[0] ?? "unknown"}`),
			);
		}
	});
	void helper.exited.then(reason => {
		if (reason !== null) {
			answered.reject(new HostControlPeerError(helper.failure() ?? "helper-failed", reason));
		}
	});
	const timer = setNodeTimeout(() => {
		answered.reject(new HostControlPeerError("timeout", "generation probe did not answer in time"));
		helper.close();
	}, PROCESS_PROBE_TIMEOUT_MS);
	timer.unref();
	try {
		return await answered.promise;
	} finally {
		clearNodeTimeout(timer);
		helper.close();
	}
}

/**
 * Default peer verifier: the staged PowerShell helper opens the pipe once,
 * checks the server PID on that handle and the retained process creation time,
 * and relays frames over its private stdio. Any failure is a visible refusal.
 */
export const powershellControlPeerBridge: ControlPeerBridge = {
	async open(request) {
		if (process.platform !== "win32") {
			throw new HostControlPeerError(
				"helper-unavailable",
				"peer-verified pipes are implemented for Windows only",
			);
		}
		const helper = await spawnControlHelper(
			[
				"-Mode",
				"bridge",
				"-PipeName",
				request.pipeName,
				"-ExpectPid",
				String(request.expectedPid),
				"-ExpectCreation",
				request.expectedCreationTime,
				"-TimeoutSeconds",
				String(Math.ceil(request.timeoutMs / 1000)),
			],
			"peer bridge",
		);
		const verified = Promise.withResolvers<ControlPeerProof>();
		const dataListeners: Array<(bytes: Buffer) => void> = [];
		// The native server sends its challenge immediately after connect. The
		// helper can forward it before `open()` returns and the client subscribes.
		const pendingData: Buffer[] = [];
		let pendingBytes = 0;
		let stderrHint = "";
		helper.onLine(line => {
			const control = parseHelperControlLine(line);
			if (control) {
				if (control.kind === "PEER_VERIFIED") {
					const pid = Number(control.fields[0]);
					const creation = control.fields[1] ?? "";
					if (!Number.isSafeInteger(pid) || pid <= 0 || creation.length === 0) {
						verified.reject(
							new HostControlPeerError("helper-failed", "peer bridge verified claim was malformed"),
						);
						return;
					}
					verified.resolve({ serverPid: pid, serverCreationTime: creation });
					return;
				}
				if (control.kind === "ERROR") {
					const code = control.fields[0] ?? "unknown";
					verified.reject(
						new HostControlPeerError(
							code === "PIPE_PID_MISMATCH"
								? "pid-mismatch"
								: code === "PIPE_GENERATION_MISMATCH"
									? "generation-mismatch"
									: "helper-failed",
							`peer verification failed: ${code}`,
						),
					);
					return;
				}
				if (control.kind === "STDERR") {
					stderrHint = control.fields.join(" ").slice(0, MAX_MESSAGE_LENGTH);
					return;
				}
				return;
			}
			// Anything else is a base64 data chunk from the pipe.
			let bytes: Buffer;
			try {
				bytes = Buffer.from(line, "base64");
			} catch {
				return;
			}
			if (dataListeners.length === 0) {
				pendingBytes += bytes.length;
				if (pendingBytes > CONTROL_MAX_FRAME_BYTES) {
					helper.close();
					return;
				}
				pendingData.push(bytes);
			} else {
				for (const listener of dataListeners) listener(bytes);
			}
		});

		void helper.exited.then(reason => {
			if (reason !== null) {
				verified.reject(new HostControlPeerError(helper.failure() ?? "helper-failed", reason));
			}
		});
		const timer = setNodeTimeout(() => {
			verified.reject(new HostControlPeerError("timeout", "peer bridge did not verify the pipe in time"));
			helper.close();
		}, request.timeoutMs);
		timer.unref();

		let proof: ControlPeerProof;
		try {
			proof = await verified.promise;
		} catch (error) {
			clearNodeTimeout(timer);
			const reason = error instanceof HostControlPeerError ? error.reason : "helper-failed";
			helper.close();
			const hint = stderrHint.length > 0 ? ` (${stderrHint})` : "";
			throw new HostControlPeerError(
				reason,
				`${error instanceof Error ? error.message : String(error)}${hint}`,
			);
		}
		clearNodeTimeout(timer);

		// Re-check the proof here as well: the comparison belongs to this side, and
		// the helper's own refusal is not taken on trust.
		if (proof.serverPid !== request.expectedPid) {
			helper.close();
			throw new HostControlPeerError(
				"pid-mismatch",
				`pipe server pid ${proof.serverPid} is not the launched pid ${request.expectedPid}`,
			);
		}
		if (proof.serverCreationTime !== request.expectedCreationTime) {
			helper.close();
			throw new HostControlPeerError(
				"generation-mismatch",
				"pipe server process generation does not match the recorded one",
			);
		}

		const closed = Promise.withResolvers<string | null>();
		void helper.exited.then(reason => closed.resolve(reason ?? "peer bridge exited"));
		return {
			proof,
			write(bytes) {
				for (let offset = 0; offset < bytes.byteLength; offset += MAX_BRIDGE_CHUNK_BYTES) {
					const chunk = bytes.subarray(offset, offset + MAX_BRIDGE_CHUNK_BYTES);
					helper.writeLine(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString("base64"));
				}
			},
			onData(listener) {
				dataListeners.push(listener);
				for (const bytes of pendingData) listener(bytes);
				pendingData.length = 0;
				pendingBytes = 0;
			},
			closed: closed.promise,
			close() {
				helper.close();
			},
		};
	},
};

/** What the caller launched, used to reject a substituted endpoint. */
export interface HostControlExpectation {
	/** Canonical session file the caller asked OMP to open; null when unknown. */
	readonly sessionFile: string | null;
	/** Native process directory the caller launched; null disables this check. */
	readonly cwd: string | null;
}

export interface HostControlConnectVerifiedOptions {
	/** Parsed rendezvous record, read immediately before connecting. */
	readonly rendezvous: ControlRendezvous;
	/** Directory the record was read from; the file is re-read and compared. */
	readonly rendezvousDirectory: string;
	/** PKCS#8 PEM of the run's recipient private key, from SecretStorage. */
	readonly recipientPrivateKeyPkcs8Pem: string;
	/** PID the launcher recorded for the native terminal process. */
	readonly expectedPid: number;
	/** Kernel creation time recorded for that PID by `queryControlProcessGeneration`. */
	readonly expectedProcessCreationTime: string;
	readonly expectation: HostControlExpectation;
	/**
	 * Key already proven for this owner. A different key in the record is accepted
	 * only as a rotation by the same process: the record must name the pinned pid,
	 * the peer proof must show that pid and creation time, and the host must prove
	 * possession of the new key. Anything else is refused as `key-changed`.
	 */
	readonly provenKey?: string;
	readonly connectTimeoutMs?: number;
	readonly requestTimeoutMs?: number;
}

/** Inputs for {@link HostControlClient.connectWithProvenKey}. */
export interface HostControlProvenKeyOptions {
	readonly slotId: string;
	/** Directory of the slot's rendezvous (POSIX sockets live there too). */
	readonly directory: string;
	/** The key an earlier verified connection pinned for this launch. */
	readonly provenKey: string;
	/** PID the launcher recorded for the native terminal process. */
	readonly expectedPid: number;
	/** Kernel creation time recorded for that PID by `queryControlProcessGeneration`. */
	readonly expectedProcessCreationTime: string;
	readonly expectation: HostControlExpectation;
	/** Pipe the current record names; dialled first, never trusted for its key. */
	readonly preferredPipeName?: string;
	readonly connectTimeoutMs?: number;
	readonly requestTimeoutMs?: number;
	/** Test seam for the pipe listing. */
	readonly listPipes?: (slotId: string, directory: string) => Promise<string[]>;
}

/** At most this many pipes of one slot are dialled per attempt; older hosts leak one server per subagent, so the original may be one of many. */
const MAX_PROVEN_KEY_CANDIDATES = 32;
/** Discovery dials several candidates in turn, so one dead pipe must not hold the attempt for the full connect timeout. */
const DISCOVERY_CONNECT_TIMEOUT_MS = 5_000;

/** A verified connection plus the key the caller may now persist. */
export interface HostControlVerifiedConnection {
	readonly client: HostControlClient;
	readonly key: string;
	/** True when the host proved a key other than the one the caller had pinned. */
	readonly rotated: boolean;
}

/** What an authenticated channel must match: the endpoint that was dialled. */
interface ControlDialContext {
	readonly target: {
		readonly slotId: string;
		readonly endpoint: string;
		readonly pipeName: string;
		/** Null when no record named the instance; the handshake then reports it. */
		readonly instanceId: string | null;
		readonly pid: number;
	};
	readonly expectation: HostControlExpectation;
	readonly connectTimeoutMs: number | undefined;
	readonly requestTimeoutMs: number | undefined;
}

interface PendingRequest {
	readonly requestId: string;
	readonly settle: (frame: ControlResponseFrame | ControlErrorFrame) => void;
	readonly timer: NodeJS.Timeout;
}

/** Server nonces seen by this process; a repeat on a new connection is a violation. */
const seenServerNonces = new Set<string>();

function textOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Fields that must be identical between the read and the re-read rendezvous. */
function sameRendezvous(left: ControlRendezvous, right: ControlRendezvous): boolean {
	return (
		left.slotId === right.slotId &&
		left.pipeName === right.pipeName &&
		left.endpoint === right.endpoint &&
		left.instanceId === right.instanceId &&
		left.epoch === right.epoch &&
		left.pid === right.pid &&
		left.ciphertext === right.ciphertext &&
		left.recipientFingerprint === right.recipientFingerprint
	);
}

/**
 * An authenticated connection to one native OMP host, carried over a pipe whose
 * server identity the OS proved on the same handle. Construct it with
 * {@link HostControlClient.connectVerified}; the class itself is exported for
 * typing only.
 */
export class HostControlClient {
	/**
	 * Open a peer-verified connection: re-read the rendezvous, unwrap the sealed
	 * key to this recipient, prove the pipe server's kernel identity and
	 * generation, then complete the nonce/HMAC handshake on that verified
	 * connection. The returned key is safe to persist because the genuine host
	 * proved it; nothing here falls back to an unchecked socket.
	 */
	static async connectVerified(
		options: HostControlConnectVerifiedOptions,
		bridge: ControlPeerBridge = powershellControlPeerBridge,
	): Promise<HostControlVerifiedConnection> {
		const { rendezvous } = options;
		if (rendezvous.service !== CONTROL_SERVICE) {
			throw new HostControlConfigurationError("rendezvous record does not belong to host control");
		}
		if (options.rendezvousDirectory.length === 0) {
			throw new HostControlConfigurationError("rendezvous directory is required");
		}
		if (!Number.isSafeInteger(options.expectedPid) || options.expectedPid <= 0) {
			throw new HostControlConfigurationError("expected native process id is required");
		}
		if (options.expectedProcessCreationTime.length === 0) {
			throw new HostControlConfigurationError("expected process generation is required");
		}

		// The record is attacker-controlled: re-read it and require the same
		// identity, so a swap between reading and connecting is refused.
		const current = await readControlRendezvous(options.rendezvousDirectory, rendezvous.slotId);
		if (current === null || !sameRendezvous(current, rendezvous)) {
			throw new HostControlIdentityError(
				"rendezvous-mismatch",
				"rendezvous record changed since it was read; refusing the endpoint",
			);
		}

		const publicKey = recipientPublicKeyOf(options.recipientPrivateKeyPkcs8Pem);
		if (publicKey === null) {
			throw new HostControlConfigurationError("recipient private key is not a usable PKCS#8 PEM");
		}
		if (controlRecipientFingerprint(publicKey) !== rendezvous.recipientFingerprint) {
			throw new HostControlIdentityError(
				"recipient-mismatch",
				"rendezvous was sealed to a different recipient key than this launch's",
			);
		}
		const candidate = decryptControlKeyFromRecipient(
			rendezvous.ciphertext,
			options.recipientPrivateKeyPkcs8Pem,
		);
		if (candidate === null) {
			throw new HostControlIdentityError(
				"ciphertext-invalid",
				"rendezvous ciphertext could not be opened with this recipient key",
			);
		}
		const rotated = options.provenKey !== undefined && candidate !== options.provenKey;
		if (rotated && rendezvous.pid !== options.expectedPid) {
			// A new key is only ever considered for the process this launch pinned. A
			// record that names another process is a different host or a substituted
			// record, and no proof below could make it ours.
			throw new HostControlIdentityError(
				"key-changed",
				"rendezvous offers a different key for a host process other than the proven one",
			);
		}

		const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
		const channel = await bridge.open({
			pipeName: rendezvous.pipeName,
			expectedPid: options.expectedPid,
			expectedCreationTime: options.expectedProcessCreationTime,
			timeoutMs: connectTimeoutMs,
		});
		const client = await HostControlClient.#authenticate(
			{
				target: {
					slotId: rendezvous.slotId,
					endpoint: rendezvous.endpoint,
					pipeName: rendezvous.pipeName,
					instanceId: rendezvous.instanceId,
					pid: rendezvous.pid,
				},
				expectation: options.expectation,
				connectTimeoutMs: options.connectTimeoutMs,
				requestTimeoutMs: options.requestTimeoutMs,
			},
			channel,
			candidate,
			options,
		);
		// A rotated key reaches this point only after the OS proved the same process
		// (pid and creation time) on the very handle that then proved possession of
		// the key sealed to this launch's recipient. The caller persists the new key.
		return { client, key: candidate, rotated };
	}

	/**
	 * Re-attach to a host whose key this launch already proved, without trusting
	 * the rendezvous record at all.
	 *
	 * The record is last-writer-wins per slot. An older host build starts one
	 * control server for every in-process subagent session, so the record can name
	 * a subagent's server (a different key) or be gone while the original server
	 * still runs on a pipe whose random name only the record carried. Every pipe
	 * that exists for the slot is therefore dialled through the same peer proof
	 * (pid and creation time of the pinned process) and the handshake, and a pipe
	 * is accepted only when its server proves possession of the key this launch
	 * pinned earlier. `null` means every pipe answered conclusively (another
	 * process, or a server holding another key) and none proved the key; a pipe that
	 * could not be examined (unreachable, timed out, refused, or beyond the
	 * candidate cap) rejects instead, because the pinned server may still be it.
	 * Only that conclusive `null` lets a caller consider a key rotation.
	 */
	static async connectWithProvenKey(
		options: HostControlProvenKeyOptions,
		bridge: ControlPeerBridge = powershellControlPeerBridge,
	): Promise<HostControlVerifiedConnection | null> {
		if (!isControlSlotId(options.slotId)) {
			throw new HostControlConfigurationError("control slot id is malformed");
		}
		if (options.directory.length === 0) {
			throw new HostControlConfigurationError("rendezvous directory is required");
		}
		if (!Number.isSafeInteger(options.expectedPid) || options.expectedPid <= 0) {
			throw new HostControlConfigurationError("expected native process id is required");
		}
		if (options.expectedProcessCreationTime.length === 0) {
			throw new HostControlConfigurationError("expected process generation is required");
		}
		decodeControlKey(options.provenKey); // Throws on a malformed or truncated key.

		const listed = await (options.listPipes ?? listControlPipeNames)(options.slotId, options.directory);
		// The record's pipe goes first, but only when it still exists: a name the listing does not show is gone.
		const ordered = options.preferredPipeName !== undefined && listed.includes(options.preferredPipeName)
			? [options.preferredPipeName, ...listed.filter(name => name !== options.preferredPipeName)]
			: listed;
		const connectTimeoutMs = options.connectTimeoutMs ?? DISCOVERY_CONNECT_TIMEOUT_MS;
		// A pipe counts as "not the pinned server" only when it answered conclusively: another
		// process's pipe, or a server that proved a different key. A pipe that could not be
		// reached or examined may still be the pinned server, so absence is not concluded.
		let inconclusive = ordered.length > MAX_PROVEN_KEY_CANDIDATES;
		for (const pipeName of ordered.slice(0, MAX_PROVEN_KEY_CANDIDATES)) {
			let channel: ControlPeerChannel;
			try {
				channel = await bridge.open({
					pipeName,
					expectedPid: options.expectedPid,
					expectedCreationTime: options.expectedProcessCreationTime,
					timeoutMs: connectTimeoutMs,
				});
			} catch (error) {
				// The helper itself failing is not a property of this candidate.
				if (error instanceof HostControlPeerError && (error.reason === "helper-unavailable" || error.reason === "helper-failed")) {
					throw error;
				}
				if (!(error instanceof HostControlPeerError && (error.reason === "pid-mismatch" || error.reason === "generation-mismatch"))) {
					inconclusive = true;
				}
				continue;
			}
			try {
				const client = await HostControlClient.#authenticate(
					{
						target: {
							slotId: options.slotId,
							endpoint: controlEndpoint(pipeName, options.directory),
							pipeName,
							instanceId: null,
							pid: options.expectedPid,
						},
						expectation: options.expectation,
						connectTimeoutMs: options.connectTimeoutMs,
						requestTimeoutMs: options.requestTimeoutMs,
					},
					channel,
					options.provenKey,
					options,
				);
				return { client, key: options.provenKey, rotated: false };
			} catch (error) {
				// Another server of the same process (a subagent's) answers with its own
				// key: that is the expected way to skip it. Anything that proved the key
				// but then contradicts the launch is a real refusal.
				if (error instanceof HostControlPeerError) continue;
				if (error instanceof HostControlIdentityError && error.reason === "key-mismatch") continue;
				if (error instanceof HostControlUnavailableError || error instanceof HostControlRefusedError) {
					inconclusive = true;
					continue;
				}
				throw error;
			}
		}
		if (inconclusive) {
			throw new HostControlUnavailableError(
				"the slot's control servers could not all be examined, so the host is not treated as replaced",
			);
		}
		return null;
	}

	/** The peer proof's pid and generation, then the handshake, on one opened channel. */
	static async #authenticate(
		context: ControlDialContext,
		channel: ControlPeerChannel,
		key: string,
		pinned: { readonly expectedPid: number; readonly expectedProcessCreationTime: string },
	): Promise<HostControlClient> {
		if (channel.proof.serverPid !== pinned.expectedPid) {
			channel.close();
			throw new HostControlPeerError(
				"pid-mismatch",
				`pipe server pid ${channel.proof.serverPid} is not the launched pid ${pinned.expectedPid}`,
			);
		}
		if (channel.proof.serverCreationTime !== pinned.expectedProcessCreationTime) {
			channel.close();
			throw new HostControlPeerError(
				"generation-mismatch",
				"pipe server process generation does not match the recorded one",
			);
		}
		const client = new HostControlClient(context, channel, key);
		try {
			await client.#open();
		} catch (error) {
			client.close();
			throw error;
		}
		return client;
	}

	readonly #context: ControlDialContext;
	readonly #key: string;
	readonly #requestTimeoutMs: number;
	readonly #closed = Promise.withResolvers<string | null>();

	#channel: ControlPeerChannel | null = null;
	#binding: ControlHostBinding | null = null;
	#latest: ControlHostBinding | null = null;
	#clientNonce = "";
	#serverNonce = "";
	#buffer = Buffer.alloc(0);
	#handshake: PromiseWithResolvers<ControlChallengeFrame> | null = null;
	#pending: PendingRequest | null = null;
	#lastFailure: HostControlRefusedError | null = null;
	#queue: Promise<unknown> = Promise.resolve();
	#closedReason: string | null = null;

	/**
	 * Private on purpose: a client can only come from {@link connectVerified} or
	 * {@link connectWithProvenKey}, so no caller and no test can skip the peer proof
	 * or the HMAC handshake. Tests exercise the same paths through the bridge seam.
	 */
	private constructor(context: ControlDialContext, channel: ControlPeerChannel, key: string) {
		decodeControlKey(key); // Throws on a malformed or truncated key.
		this.#context = context;
		this.#key = key;
		this.#channel = channel;
		this.#requestTimeoutMs = context.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
	}

	/** Facts the OS proved for the pipe this channel carries. */
	get peerProof(): ControlPeerProof {
		const channel = this.#channel;
		if (!channel) throw new HostControlUsageError("client is closed");
		return channel.proof;
	}

	/** Resolves with the reason the channel ended; `null` after an explicit close. */
	get closed(): Promise<string | null> {
		return this.#closed.promise;
	}

	/** The authenticated identity of the native process behind this channel. */
	get binding(): ControlHostBinding {
		if (!this.#binding) throw new HostControlUsageError("client is not authenticated yet");
		return this.#binding;
	}

	/** The most recent binding the host reported; null until the first response. */
	get latestHost(): ControlHostBinding | null {
		return this.#latest;
	}

	/** The last refusal the host sent, for a caller that wants to explain it. */
	get lastRefusal(): HostControlRefusedError | null {
		return this.#lastFailure;
	}

	/** Close the channel and stop the bridge. Idempotent. */
	close(): void {
		this.#end(null);
	}

	/** The authenticated host binding and identity read gaps. */
	async snapshot(): Promise<ControlHostSnapshot> {
		const result = await this.#enqueue(() => this.#request("snapshot", { kind: "snapshot" }));
		if (result.kind !== "snapshot") {
			throw new HostControlProtocolViolationError("host answered a snapshot request with another result");
		}
		return result.snapshot;
	}

	/**
	 * Every tool the host offers and the selection it reports as active, by name.
	 *
	 * This is a read: it changes nothing, and it is the only tool method this
	 * channel has. No method here replaces the active set ([ADR-0009](../../docs/decisions/0009-read-only-native-tools-until-atomic-selection.md)):
	 * OMP's setter cannot atomically compare the session a caller pinned to the
	 * mutable current session at the moment of application, so a live selection
	 * change could reach the wrong session. `available: false` with a reason is the
	 * host saying it cannot describe its catalogue — never a partial list, because a
	 * caller acting on one would lose tools it never saw.
	 *
	 * What comes back is a dated observation: OMP's Plan/Goal Mode and later tool
	 * mounts can change the enabled set afterwards, so re-query before displaying
	 * or copying a selection, and never treat a reading as an exclusive lease over
	 * OMP's future tool state.
	 */
	async listTools(): Promise<ControlToolList> {
		const result = await this.#enqueue(() => this.#request("listTools", { kind: "listTools" }));
		if (result.kind !== "listTools") {
			throw new HostControlProtocolViolationError("host answered a listTools request with another result");
		}
		return result.list;
	}

	async nativeState(includeContent = false): Promise<ControlNativeState> {
		const result = await this.#enqueue(() => this.#request("nativeState", { kind: "nativeState", includeContent }));
		if (result.kind !== "nativeState") throw new HostControlProtocolViolationError("host answered nativeState with another result");
		return result.state;
	}

	/** Call only under a positive locally recorded activity capability; never probe old servers. */
	async nativeActivity(options: { readonly work?: true } = {}): Promise<ControlNativeActivity> {
		const payload = options.work === true ? { kind: "nativeActivity" as const, work: true as const } : { kind: "nativeActivity" as const };
		const result = await this.#enqueue(() => this.#request("nativeActivity", payload));
		if (result.kind !== "nativeActivity") throw new HostControlProtocolViolationError("host answered nativeActivity with another result");
		return result.activity;
	}

	/** Call only under a positive locally recorded capability; an older host would refuse the method. */
	async subagentWork(): Promise<boolean> {
		const result = await this.#enqueue(() => this.#request("subagentWork", { kind: "subagentWork" }));
		if (result.kind !== "subagentWork") throw new HostControlProtocolViolationError("host answered subagentWork with another result");
		return result.active;
	}

	async nativeShutdown(target: ControlNativeTarget, consent: boolean): Promise<ControlNativeShutdownStatus> {
		const result = await this.#enqueue(() => this.#request("nativeShutdown", { kind: "nativeShutdown", target, consent }));
		if (result.kind !== "nativeShutdown") throw new HostControlProtocolViolationError("host answered nativeShutdown with another result");
		return result.status;
	}

	async nativeRename(target: ControlNativeTarget, name: string): Promise<ControlNativeRenameStatus> {
		const result = await this.#enqueue(() => this.#request("nativeRename", { kind: "nativeRename", target, name }));
		if (result.kind !== "nativeRename") throw new HostControlProtocolViolationError("host answered nativeRename with another result");
		return result.status;
	}

	/** One outstanding request per channel, in call order. */
	#enqueue<T>(work: () => Promise<T>): Promise<T> {
		const next = this.#queue.then(work, work);
		this.#queue = next.catch(() => undefined);
		return next;
	}

	async #open(): Promise<void> {
		const channel = this.#channel;
		if (!channel) throw new HostControlUnavailableError("channel is not open");
		const handshake = Promise.withResolvers<ControlChallengeFrame>();
		this.#handshake = handshake;
		channel.onData(bytes => this.#onData(bytes));
		void channel.closed.then(reason => this.#endIfOpen(reason ?? "peer bridge closed"));
		this.#clientNonce = createControlNonce();
		channel.write(
			Buffer.from(
				encodeControlFrame({
					v: CONTROL_PROTOCOL_VERSION,
					kind: "hello",
					clientNonce: this.#clientNonce,
				}),
				"utf8",
			),
		);

		try {
			const challenge = await this.#withTimeout(
				handshake.promise,
				this.#context.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
				"handshake",
			);
			this.#verifyChallenge(challenge);
			this.#binding = challenge.host;
		} catch (error) {
			// A refused or timed-out handshake must not leave the bridge running (or
			// a never-settling `closed` promise) behind.
			this.#end(textOf(error));
			throw error;
		}
	}

	/** Verify that the peer holds the key *and* matches this caller's launch. */
	#verifyChallenge(challenge: ControlChallengeFrame): void {
		const { target, expectation } = this.#context;
		const host = challenge.host;

		const proven = verifyControlHandshakeMac(
			this.#key,
			{
				clientNonce: this.#clientNonce,
				serverNonce: challenge.serverNonce,
				host,
			},
			challenge.mac,
		);
		if (!proven) {
			throw new HostControlIdentityError(
				"key-mismatch",
				"endpoint could not prove possession of the host-control key; refusing to trust it",
			);
		}
		if (
			host.slotId !== target.slotId ||
			host.endpoint !== target.endpoint ||
			host.pipeName !== target.pipeName ||
			(target.instanceId !== null && host.instanceId !== target.instanceId) ||
			host.pid !== target.pid
		) {
			throw new HostControlIdentityError(
				"rendezvous-mismatch",
				"authenticated host does not match the endpoint that was dialled; the record may have been replaced",
			);
		}
		if (
			expectation.sessionFile !== null &&
			(host.sessionFile === null || !controlPathEquals(expectation.sessionFile, host.sessionFile))
		) {
			throw new HostControlIdentityError(
				"session-mismatch",
				"authenticated host is serving a different session than the one this caller launched",
			);
		}
		if (expectation.cwd !== null && !controlPathEquals(expectation.cwd, host.cwd)) {
			throw new HostControlIdentityError(
				"cwd-mismatch",
				"authenticated host runs in a different directory than this caller launched it in",
			);
		}
		if (seenServerNonces.has(challenge.serverNonce)) {
			throw new HostControlProtocolViolationError("host reused a server nonce across connections");
		}
		seenServerNonces.add(challenge.serverNonce);
		while (seenServerNonces.size > MAX_SEEN_SERVER_NONCES) {
			const oldest = seenServerNonces.values().next();
			if (oldest.done) break;
			seenServerNonces.delete(oldest.value);
		}
		this.#serverNonce = challenge.serverNonce;
	}

	#onData(chunk: Buffer): void {
		if (chunk.length === 0) return;
		if (this.#buffer.length + chunk.length > CONTROL_MAX_FRAME_BYTES) {
			this.#fail(new HostControlProtocolViolationError("host frame above the channel limit"));
			return;
		}
		this.#buffer = Buffer.concat([this.#buffer, chunk]);
		for (;;) {
			const newline = this.#buffer.indexOf(0x0a);
			if (newline < 0) return;
			const line = this.#buffer.subarray(0, newline).toString("utf8");
			this.#buffer = this.#buffer.subarray(newline + 1);
			if (line.length === 0) continue;
			this.#consumeLine(line);
		}
	}

	#consumeLine(line: string): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			this.#fail(new HostControlProtocolViolationError("host frame is not valid JSON"));
			return;
		}
		const frame = parseControlServerFrame(parsed);
		if (!frame) {
			this.#fail(new HostControlProtocolViolationError("host frame did not match the protocol"));
			return;
		}
		if (frame.kind === "challenge") {
			const handshake = this.#handshake;
			if (!handshake) {
				this.#fail(new HostControlProtocolViolationError("host sent a second challenge"));
				return;
			}
			this.#handshake = null;
			handshake.resolve(frame);
			return;
		}
		if (frame.kind === "error" && this.#handshake) {
			// A refusal during the handshake (a replayed nonce, a version
			// mismatch) is reported as the refusal it is, not as a violation.
			const handshake = this.#handshake;
			this.#handshake = null;
			const refusal = new HostControlRefusedError(
				frame.code,
				frame.message.slice(0, MAX_MESSAGE_LENGTH),
				frame.host,
			);
			handshake.reject(refusal);
			this.#fail(refusal);
			return;
		}
		const pending = this.#pending;
		if (!pending || pending.requestId !== frame.requestId) {
			this.#fail(new HostControlProtocolViolationError("host answered a request that was not outstanding"));
			return;
		}
		clearNodeTimeout(pending.timer);
		this.#pending = null;
		pending.settle(frame);
	}

	async #request(method: ControlMethod, payload: ControlPayload): Promise<ControlResult> {
		const channel = this.#channel;
		if (!channel || !this.#binding) {
			throw new HostControlUnavailableError(this.#closedReason ?? "control channel is not open");
		}
		const id = createControlRequestId();
		const digest = controlDigest(payload);
		const mac = controlRequestMac(this.#key, {
			clientNonce: this.#clientNonce,
			serverNonce: this.#serverNonce,
			requestId: id,
			method,
			digest,
		});
		const answered = Promise.withResolvers<ControlResponseFrame | ControlErrorFrame>();
		const timer = setNodeTimeout(() => {
			if (this.#pending?.requestId === id) this.#pending = null;
			answered.reject(new HostControlUnavailableError(`host did not answer ${method} in time`));
		}, this.#requestTimeoutMs);
		timer.unref();
		this.#pending = { requestId: id, settle: answered.resolve, timer };

		try {
			channel.write(
				Buffer.from(
					encodeControlFrame({
						v: CONTROL_PROTOCOL_VERSION,
						kind: "request",
						clientNonce: this.#clientNonce,
						serverNonce: this.#serverNonce,
						requestId: id,
						method,
						digest,
						payload,
						mac,
					}),
					"utf8",
				),
			);
		} catch (error) {
			clearNodeTimeout(timer);
			this.#pending = null;
			this.#fail(new HostControlUnavailableError(`peer bridge write failed (${textOf(error)})`));
			throw new HostControlUnavailableError(`peer bridge write failed (${textOf(error)})`);
		}

		const frame = await answered.promise;
		if (frame.kind === "error") return this.#refuse(frame);
		this.#verifyResponse(frame);
		return frame.result;
	}

	#verifyResponse(frame: ControlResponseFrame): void {
		const bound = this.#binding;
		if (!bound || frame.host.instanceId !== bound.instanceId) {
			this.#fail(
				new HostControlProtocolViolationError("host changed process instance on an authenticated channel"),
			);
			throw new HostControlProtocolViolationError("host changed process instance mid-channel");
		}
		const digest = controlResponseDigest(frame.result, frame.host);
		if (digest !== frame.digest) {
			this.#fail(new HostControlProtocolViolationError("host response digest does not match its payload"));
			throw new HostControlProtocolViolationError("host response digest does not match its payload");
		}
		const macOk = verifyControlResponseMac(
			this.#key,
			{
				clientNonce: this.#clientNonce,
				serverNonce: this.#serverNonce,
				requestId: frame.requestId,
				digest,
			},
			frame.mac,
		);
		if (!macOk) {
			this.#fail(new HostControlProtocolViolationError("host response signature did not verify"));
			throw new HostControlProtocolViolationError("host response signature did not verify");
		}
		this.#latest = frame.host;
	}

	#refuse(frame: ControlErrorFrame): never {
		if (frame.mac !== null) {
			const macOk = verifyControlErrorMac(
				this.#key,
				{
					clientNonce: this.#clientNonce,
					serverNonce: this.#serverNonce,
					requestId: frame.requestId,
					code: frame.code,
				},
				frame.mac,
			);
			if (!macOk) {
				this.#fail(new HostControlProtocolViolationError("host error signature did not verify"));
				throw new HostControlProtocolViolationError("host error signature did not verify");
			}
		}
		if (frame.host) this.#latest = frame.host;
		const refusal = new HostControlRefusedError(
			frame.code,
			frame.message.slice(0, MAX_MESSAGE_LENGTH),
			frame.host,
		);
		this.#lastFailure = refusal;
		throw refusal;
	}

	async #withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
		const raced = Promise.withResolvers<T>();
		const timer = setNodeTimeout(() => {
			raced.reject(new HostControlUnavailableError(`${label} did not complete within ${ms}ms`));
		}, ms);
		timer.unref();
		work.then(
			value => {
				clearNodeTimeout(timer);
				raced.resolve(value);
			},
			error => {
				clearNodeTimeout(timer);
				raced.reject(error);
			},
		);
		return raced.promise;
	}

	#fail(error: Error): void {
		this.#end(textOf(error));
	}

	#endIfOpen(reason: string): void {
		if (this.#closedReason === null) this.#end(reason);
	}

	#end(reason: string | null): void {
		if (this.#closedReason !== null) return;
		this.#closedReason = reason ?? "closed by caller";
		const pending = this.#pending;
		this.#pending = null;
		if (pending) {
			clearNodeTimeout(pending.timer);
			pending.settle({
				v: CONTROL_PROTOCOL_VERSION,
				kind: "error",
				code: "closed",
				requestId: pending.requestId,
				message: this.#closedReason,
				host: null,
				mac: null,
			});
		}
		const handshake = this.#handshake;
		this.#handshake = null;
		handshake?.reject(new HostControlUnavailableError(this.#closedReason));
		const channel = this.#channel;
		this.#channel = null;
		channel?.close();
		this.#closed.resolve(reason);
	}
}
